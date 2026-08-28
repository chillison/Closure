import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCompileReport } from '@orison/shared-contracts';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// ── Story 8.4 R2-盲1（2026-08-19）：degraded 空数组自违 schema → L3 复杂场景文案永不渲染（核心回归锚）──
//
// 修复前的失败链：L1/L2 触发但零降级动作可做（设定侧爆炸 + brief 侧无可裁段）→ buildCompileReport 产
// degraded=[] → compileReportSchema .min(1) 拒收 → chainRunner summarize safeParse 丢 compileReport →
// summary.compileReport 缺省 → write_chapter `summary.compileReport?.overloaded` 恒 falsy → L3 人裁
// 文案（【复杂场景信号】建议拆章）永不渲染——「不静默」承诺在该场景失效。
//
// 本测试锚**全链后半**（报告 → summarize → write_chapter 文案）：报告产自真 buildCompileReport
// （生产单源）——「settings 侧膨胀 + brief 侧无可裁」fixture；对照侧（degraded=[] 的修复前形态）钉死
// schema 拒收是 load-bearing（那条链确实断，且现在被生产侧「无动作不写字段」堵死）。
// mirror write-chapter-feedback-ledger.test.ts harness 模式。

vi.mock('../src/agent/session', () => ({
  getSession: vi.fn(),
  loadSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  loadSessionMeta: vi.fn(),
}));

import { getSession } from '../src/agent/session';

const mockedGetSession = vi.mocked(getSession);

describe('write_chapter — compileReport L3 复杂场景文案（R2-盲1 回归锚）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-l3-'));
    runChapterChain = vi.fn();
    runAgentWithExplicitSystem = vi.fn().mockImplementation((_sid, role) => {
      if (role === 'director-agent') {
        return Promise.resolve({ content: JSON.stringify({ entries: [], emotionPoints: [] }) });
      }
      return Promise.resolve({ content: '{}' });
    });
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: {
        runChapterChain,
        runAgentWithExplicitSystem,
        runSubagent: vi.fn(),
        executeSkillByName: vi.fn(),
      },
    };
    mockedGetSession.mockReturnValue({ permissionMode: 'suggest' } as SessionState);
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeSingleEpisodeProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [],
      scene_graph: {
        nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' }],
        edges: [],
        lines: [],
      },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
    }), 'utf8');
  }

  /** 「settings 侧膨胀 + brief 侧无可裁」的真生产报告（buildCompileReport 单源）。 */
  function buildNoTrimOverloadedReport() {
    // brief 只剩铁律段（goal）——L2 移出梯全 miss；settings 150K ≥ TH_MOVE 且移空后仍 > TH_HARD(128K)
    // → L2 档零降级动作 + overloaded=true（本条靶场景）。
    return buildCompileReport(
      { goal: '主角进城' },
      [{ name: 'settings:设定目录', token_estimate: 150_000 }],
    ).report;
  }

  it('无可裁 + 膨胀报告（degraded 缺省 + overloaded=true）→ summarize 透出 → write_chapter 渲染【复杂场景信号】', async () => {
    writeSingleEpisodeProject();
    const report = buildNoTrimOverloadedReport();
    // 报告级前提：无降级动作不写字段 + schema 过 + overloaded（修复后生产侧恒满足）。
    expect(report.degraded).toBeUndefined();
    expect(report.overloaded).toBe(true);

    // summarize 级：compile_report artifact → summary.compileReport（safeParse 守形放行）。
    const { summarizeRunSnapshot } = await import('../src/runtime/chainRunner');
    const snapshot = {
      runId: 'run_l3',
      status: 'completed' as const,
      currentNodeId: null,
      projectPath,
      completedNodes: [],
      pendingNodes: [],
      artifacts: { compile_report: report },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    };
    const summary: RunSnapshotSummary = summarizeRunSnapshot(snapshot);
    expect(summary.compileReport).toBeDefined();
    expect(summary.compileReport?.overloaded).toBe(true);

    // write_chapter 级：summary.compileReport.overloaded → L3 人裁文案行出现（核心回归锚——修复前
    // summarize 丢报告致此行永不渲染）。
    runChapterChain.mockResolvedValue({
      ...summary,
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      reviewVerdict: 'pass',
      draftTitle: '第一章',
      draftWordCount: 2000,
      errors: [],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );
    expect(result.output).toContain('【复杂场景信号】');
    expect(result.output).toContain(`${report.total}`);
    expect(result.output).toContain('建议与作者商议拆章');
  });

  it('对照侧（修复前 degraded=[] 形态）→ summarize 拒收丢报告 → write_chapter 无 L3 行（schema .min(1) load-bearing 钉死）', async () => {
    writeSingleEpisodeProject();
    // 手构修复前生产者形态：degraded=[]（空数组）——schema 拒收（正是本条修的 bug 形态）。
    const brokenReport = { ...buildNoTrimOverloadedReport(), degraded: [] };

    const { summarizeRunSnapshot } = await import('../src/runtime/chainRunner');
    const snapshot = {
      runId: 'run_l3_broken',
      status: 'completed' as const,
      currentNodeId: null,
      projectPath,
      completedNodes: [],
      pendingNodes: [],
      artifacts: { compile_report: brokenReport },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    };
    const summary: RunSnapshotSummary = summarizeRunSnapshot(snapshot);
    expect(summary.compileReport).toBeUndefined(); // safeParse 拒收 → 防御性丢（坏形态消费侧现状）

    runChapterChain.mockResolvedValue({
      ...summary,
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      reviewVerdict: 'pass',
      draftTitle: '第一章',
      draftWordCount: 2000,
      errors: [],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );
    expect(result.output).not.toContain('【复杂场景信号】');
  });
});
