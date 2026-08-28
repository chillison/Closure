import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BatchReportCard } from '../src/features/agent-panel/BatchReportCard';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';
import { truncateByCodePoints } from '../src/features/agent-panel/batchMeta';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 8：<BatchReportCard> L1（每工具一行，机械提取）→ L2（输出摘要，
// 码点安全截断）→ L3（全文）。无结构化 metadata → 降级为工具行（不编造）。
// ─────────────────────────────────────────────────────────────────────────────

function toolMessage(id: string, batchId: string, results: Array<{ toolName: string; output: string; metadata?: unknown }>): AgentMessage {
  return {
    id,
    role: 'tool',
    content: '',
    createdAt: 1,
    batchId,
    batchKind: 'progress',
    toolResults: results.map((r, i) => ({ toolCallId: `${id}-${i}`, toolName: r.toolName, output: r.output, metadata: r.metadata })),
  } as AgentMessage;
}

const messages: AgentMessage[] = [
  toolMessage('t1', 'b-1', [
    // CR-002：真 metadata 形态--write_chapter toolResult.metadata = { type:'field_patch', field:'chapter_candidate',
    // data:{chapterId,...}, summary:{status,routeDecision,reviewVerdict,draftWordCount,...,errors[]} }
    // （write-chapter.ts:1758 metadata:{ summary } + accept 路径 metadata.data.chapterId）。
    {
      toolName: 'write_chapter',
      output: 'chapter prose summary',
      metadata: {
        type: 'field_patch',
        field: 'chapter_candidate',
        action: 'set',
        data: { chapterId: 'ch-2' },
        summary: {
          status: 'completed',
          reviewVerdict: 'accept',
          routeDecision: { decision: 'accept_as_truth', reason: '通过' },
          draftTitle: '第二章',
          draftWordCount: 2800,
          errors: [],
        },
      },
    },
  ]),
  toolMessage('t2', 'b-1', [
    { toolName: 'batch_status', output: '2/3 scenes done' },
  ]),
  // 其他批量的消息——不得混入本卡。
  toolMessage('t3', 'b-2', [{ toolName: 'write_chapter', output: 'other batch' }]),
];

describe('Story 3.5 — BatchReportCard 渐进披露', () => {
  beforeEach(() => {
    useAppStore.setState({ resolvedLocale: 'en-US' } as any);
  });

  afterEach(() => cleanup());

  it('L1：本批量 tool 消息每条一行（label + toolSummary 机械摘要），其他批量不混入', () => {
    render(<BatchReportCard batchId="b-1" messages={messages} />);

    expect(screen.getAllByText('Write chapter')).toHaveLength(1);
    // CR-002：write_chapter 行消费 metadata.summary + metadata.data.chapterId --
    // 摘要形态「ch-2 · accept · 2800 字」（非旧 fixture 的顶层 chapterId）。
    expect(screen.getByText('ch-2 · accept · 2800 字')).toBeTruthy();
    expect(screen.getByText('Batch status')).toBeTruthy();
    expect(screen.queryByText('other batch')).toBeNull();
  });

  it('L1：通用 authored string summary（CR-08-16-202）——metadata.summary 字符串进摘要行（非仅工具名）', () => {
    const msgs: AgentMessage[] = [
      toolMessage('t1', 'b-str', [
        {
          toolName: 'asset_cards_update',
          output: 'applied',
          metadata: { ok: true, applied: true, actionCount: 3, summary: 'asset-cards 自动落盘 · 3 项' },
        },
      ]),
      toolMessage('t2', 'b-str', [
        {
          toolName: 'setting_md_update',
          output: 'applied',
          metadata: { ok: true, applied: true, settingId: 'magic-system', filePath: '/p/settings/magic-system.md', summary: 'settings/magic-system.md · edit · replace_span×1' },
        },
      ]),
    ];
    render(<BatchReportCard batchId="b-str" messages={msgs} />);

    // authored 单行中文摘要优先于 fileName/field 投影（此前这些工具的 L1 行只有工具名）。
    expect(screen.getByText('asset-cards 自动落盘 · 3 项')).toBeTruthy();
    expect(screen.getByText('settings/magic-system.md · edit · replace_span×1')).toBeTruthy();
    // 写得很长（>60 字符）会被有界截断——不刷行。
    const long: AgentMessage[] = [
      toolMessage('t3', 'b-long', [
        { toolName: 'asset_cards_update', output: 'x', metadata: { summary: `${'长'.repeat(80)}` } },
      ]),
    ];
    cleanup();
    render(<BatchReportCard batchId="b-long" messages={long} />);
    expect(screen.getByText(`${'长'.repeat(60)}…`)).toBeTruthy();
  });

  it('L2：展开行 → 该工具输出摘要可见', async () => {
    const { container } = render(<BatchReportCard batchId="b-1" messages={messages} />);
    const rows = container.querySelectorAll('.agent-batch-report-row-header');
    await userEvent.click(rows[0]);

    expect(screen.getByText('chapter prose summary')).toBeTruthy();
  });

  it('L3：超长输出 → 摘要截断 + 「展开全文」露出全文；码点安全（代理对不拆半）', async () => {
    // 含 emoji（代理对）+ 超过 600 码点的输出。
    const longText = `${'😀'.repeat(10)}${'章'.repeat(700)}`;
    const longMessages = [toolMessage('t1', 'b-1', [{ toolName: 'write_chapter', output: longText }])];
    const { container } = render(<BatchReportCard batchId="b-1" messages={longMessages} />);

    await userEvent.click(container.querySelector('.agent-batch-report-row-header')!);
    const pre = container.querySelector('.agent-batch-report-pre')!;
    // 截断 = 前 600 码点 + 省略号（非码元 slice 会把 😀 拆成两半）。
    expect(pre.textContent).toBe(`${truncateByCodePoints(longText, 600)}`);
    expect(pre.textContent!.endsWith('…')).toBe(true);

    await userEvent.click(screen.getByText('Show full output'));
    expect(container.querySelector('.agent-batch-report-pre')!.textContent).toBe(longText);
  });

  it('无工具消息 → 降级占位（不编造行）', () => {
    render(<BatchReportCard batchId="b-none" messages={messages} />);
    expect(screen.getByText('No structured tool records for this batch.')).toBeTruthy();
  });

  it('CR-019：中文错误 / 失败 / Error: 文案标红（isError 判定加中文）', () => {
    // 各中文错误文案各一条 + 一条英文小写 error。
    const cnMessages: AgentMessage[] = [
      toolMessage('tc1', 'b-err', [{ toolName: 'write_chapter', output: '章节生成失败：上下文不足' }]),
      toolMessage('tc2', 'b-err', [{ toolName: 'write_chapter', output: '错误：无法解析 brief' }]),
      toolMessage('tc3', 'b-err', [{ toolName: 'write_chapter', output: 'Error: chapter sync broken' }]),
      toolMessage('tc4', 'b-err', [{ toolName: 'batch_status', output: 'ok' }]),
    ];
    const { container } = render(<BatchReportCard batchId="b-err" messages={cnMessages} />);
    const errorRows = container.querySelectorAll('div.agent-batch-report-row--error');
    // CR-019：三条错误（中文「失败」/中文「错误」/英文「Error:」）均标红，一条 ok 不标。
    expect(errorRows).toHaveLength(3);
    const okRows = container.querySelectorAll('div.agent-batch-report-row:not(.agent-batch-report-row--error)');
    expect(okRows).toHaveLength(1);
  });

  it('truncateByCodePoints：码点计数（非码元）', () => {
    expect(truncateByCodePoints('😀😀😀', 2)).toBe('😀😀…');
    expect(truncateByCodePoints('abc', 3)).toBe('abc');
  });
});
