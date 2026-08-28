/**
 * Story 3.7 #2（WP4 / design D5/D5b）：ReviewFindingsCard——write_chapter tool result 的
 * reader-audit findings 结构化卡组 + AgentMessageItem findings 档挂载 + 同章新鲜度门。
 *
 * 覆盖：metadata 形态守卫与路由渲染 / 旧会话无 findings 字段零回归（DiffCard/AgentToolCard 兜底
 * 不变）/ per-finding 应用（对话直发）与忽略（会话内隐藏）/ 应用并补充预填 / D5b 同章旧卡降级
 * （含空 items 锚点降级 + 无 chapterId 不降级）/ agentLoading 门（D11）。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReviewFindingsCard,
  extractReaderAuditFindings,
  isLatestFindingsForChapter,
} from '../src/features/agent-panel/ReviewFindingsCard';
import { AgentMessageItem } from '../src/features/agent-panel/AgentMessageItem';
import { useAppStore } from '../src/shared/store/appStore';
import { insightDismissKey } from '../src/shared/store/insightInteractionSlice';
import type { AgentMessage } from '../src/shared/store/agentSlice';

const findingBlock = {
  severity: 'block',
  quote: '他推开门走了进去',
  location: '第 2 段',
  explanation: '未铺垫的动机突变',
  subClass: 'motivation',
};
const findingWarn = {
  severity: 'warn',
  quote: '夜色正浓',
  location: '第 5 段',
  explanation: '情绪未落地',
};

function findingsMetadata(over: Partial<{
  route: string; chapterId?: string; items: unknown[];
}> = {}) {
  return {
    summary: {},
    findings: {
      source: 'reader-audit',
      route: over.route ?? 'auto_revise',
      ...(over.chapterId !== undefined ? { chapterId: over.chapterId } : {}),
      items: over.items ?? [findingBlock, findingWarn],
    },
  };
}

function toolMessage(id: string, results: Array<Record<string, unknown>>): AgentMessage {
  return {
    id,
    role: 'tool',
    content: '',
    toolResults: results as AgentMessage['toolResults'],
    createdAt: Date.now(),
  };
}

describe('Story 3.7 #2 — extractReaderAuditFindings（unknown seam 形态守卫）', () => {
  it('合法 metadata → 解析 source/route/chapterId/items', () => {
    const meta = extractReaderAuditFindings(findingsMetadata({ chapterId: 'ch_001' }));
    expect(meta).not.toBeNull();
    expect(meta!.source).toBe('reader-audit');
    expect(meta!.route).toBe('auto_revise');
    expect(meta!.chapterId).toBe('ch_001');
    expect(meta!.items.length).toBe(2);
  });

  it('非 reader-audit / 无 findings 字段 / items 非数组 → null（旧会话零回归守卫）', () => {
    expect(extractReaderAuditFindings(undefined)).toBeNull();
    expect(extractReaderAuditFindings({ summary: {} })).toBeNull();
    expect(extractReaderAuditFindings({ findings: { source: 'other', items: [] } })).toBeNull();
    expect(extractReaderAuditFindings({ findings: { source: 'reader-audit', items: 'nope' } })).toBeNull();
  });

  it('explanation 非 string / 空串 的条目丢弃（title 必填——CR-005：空 title 卡 + dismiss 键碰撞）；quote/location 容缺省为空串', () => {
    const meta = extractReaderAuditFindings({
      findings: {
        source: 'reader-audit',
        items: [
          { explanation: 'ok', quote: 42 },
          { quote: '只有引用没有解释' },
          { explanation: '' },
          { explanation: '全' },
        ],
      },
    });
    expect(meta!.items.length).toBe(2);
    expect(meta!.items[0].quote).toBe('');
    expect(meta!.items[1].explanation).toBe('全');
  });

  it('items 空数组 → meta 仍返回（D5b 空「已审核」锚点；渲染层自判不出卡组）', () => {
    const meta = extractReaderAuditFindings(findingsMetadata({ items: [] }));
    expect(meta).not.toBeNull();
    expect(meta!.items.length).toBe(0);
  });
});

describe('Story 3.7 #2 — isLatestFindingsForChapter（D5b 纯函数）', () => {
  const mk = (id: string, chapterId?: string) =>
    toolMessage(id, [{ toolName: 'write_chapter', metadata: findingsMetadata({ chapterId }) }]);

  it('同章多卡 → 只有最新消息为锚点（空 items 同样计锚）', () => {
    const messages = [mk('m1', 'ch1'), mk('m2', 'ch1'), mk('m3', 'ch2')];
    expect(isLatestFindingsForChapter(messages, 'm1', 'ch1')).toBe(false);
    expect(isLatestFindingsForChapter(messages, 'm2', 'ch1')).toBe(true);
    expect(isLatestFindingsForChapter(messages, 'm3', 'ch2')).toBe(true);
  });

  it('后续空 items 审核结果同样让旧卡降级', () => {
    const empty = toolMessage('m2', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1', items: [] }) },
    ]);
    const messages = [mk('m1', 'ch1'), empty];
    expect(isLatestFindingsForChapter(messages, 'm1', 'ch1')).toBe(false);
    expect(isLatestFindingsForChapter(messages, 'm2', 'ch1')).toBe(true);
  });
});

describe('Story 3.7 #2 — ReviewFindingsCard 渲染 + 操作', () => {
  let sendAgentMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendAgentMessage = vi.fn();
    useAppStore.setState({
      resolvedLocale: 'en-US',
      activeSessionRunning: false,
      agentRunStates: {},
      agentMode: 'suggest',
      pendingDiffsBySession: {},
      agentMessages: [],
      dismissed: {},
      draftPreset: null,
      sendAgentMessage,
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('卡组头：工具名小字 + route badge；per-finding：severity 归一（block→error/warn→warning）+ subClass 维度 + 紧凑 grounding', () => {
    const msg = toolMessage('m1', [
      { toolId: 'write_chapter', toolName: 'write_chapter', output: 'status: completed', metadata: findingsMetadata({ chapterId: 'ch1' }) },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);

    const { container } = render(<ReviewFindingsCard messageId="m1" result={msg.toolResults![0] as any} />);

    // 卡组头：工具名（write_chapter en-US 标签）+ route badge（auto_revise → Auto-revise）。
    expect(screen.getByText('Write chapter')).toBeTruthy();
    expect(screen.getByText('Auto-revise')).toBeTruthy();
    // per-finding 两卡：severity 归一。
    const cards = container.querySelectorAll('.insight-card');
    expect(cards.length).toBe(2);
    expect(cards[0].className).toContain('insight-card--error');
    expect(cards[1].className).toContain('insight-card--warning');
    // dimension = subClass（词表外自由串显原文）。
    expect(screen.getByText('motivation')).toBeTruthy();
    // 折叠态紧凑 grounding（quote 在卡上）。
    expect(container.querySelector('.insight-card-grounding--compact')!.textContent).toContain('他推开门走了进去');
    expect(container.querySelector('.insight-card-grounding--compact')!.textContent).toContain('（第 2 段）');
    // CR-001：result.output（裁决依据/警示/指引的唯一定性呈现位）逐字保留在卡组尾。
    expect(container.querySelector('.review-findings-card-output')!.textContent).toContain('status: completed');
  });

  it('CR-006：route 空串 → 不渲染空胶囊 badge（工具名/卡正常渲染）', () => {
    const msg = toolMessage('m1', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ route: '', chapterId: 'ch1' }) },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);
    const { container } = render(<ReviewFindingsCard messageId="m1" result={msg.toolResults![0] as any} />);
    expect(container.querySelector('.review-findings-card-route')).toBeNull();
    expect(container.querySelectorAll('.insight-card').length).toBe(2);
  });

  it('route escalate_user → Escalated to user；未知 route → 显原文（不造标签）', () => {
    const msg = toolMessage('m1', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ route: 'escalate_user', chapterId: 'ch1' }) },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);
    const { rerender } = render(<ReviewFindingsCard messageId="m1" result={msg.toolResults![0] as any} />);
    expect(screen.getByText('Escalated to user')).toBeTruthy();

    const msg2 = toolMessage('m1', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ route: 'future_route', chapterId: 'ch1' }) },
    ]);
    rerender(<ReviewFindingsCard messageId="m1" result={msg2.toolResults![0] as any} />);
    expect(screen.getByText('future_route')).toBeTruthy();
  });

  it('应用 → sendAgentMessage 携 quote+explanation 全文（对话式改稿，递条子非传话）', async () => {
    const msg = toolMessage('m1', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);
    render(<ReviewFindingsCard messageId="m1" result={msg.toolResults![0] as any} />);

    await userEvent.click(screen.getAllByText('Apply')[0]);
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage).toHaveBeenCalledWith(
      'Please revise this chapter to address this Reader-Audit finding: "他推开门走了进去" — 未铺垫的动机突变',
    );
  });

  it('忽略 → 该卡消失；全部忽略 → 卡组整体 null', async () => {
    const msg = toolMessage('m1', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);
    const { container } = render(<ReviewFindingsCard messageId="m1" result={msg.toolResults![0] as any} />);
    expect(container.querySelectorAll('.insight-card').length).toBe(2);

    await userEvent.click(screen.getAllByText('Ignore')[0]);
    expect(container.querySelectorAll('.insight-card').length).toBe(1);
    expect(screen.queryByText('未铺垫的动机突变')).toBeNull();

    await userEvent.click(screen.getByText('Ignore'));
    expect(container.querySelector('.review-findings-card')).toBeNull();
  });

  it('展开态「应用并补充」→ presetDraft 预填（不直发）', async () => {
    const msg = toolMessage('m1', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);
    render(<ReviewFindingsCard messageId="m1" result={msg.toolResults![0] as any} />);

    await userEvent.click(screen.getAllByText('Expand')[0]);
    await userEvent.click(screen.getByText('Apply with notes'));
    expect(useAppStore.getState().draftPreset).toBe(
      'Please revise this chapter to address this Reader-Audit finding: "他推开门走了进去" — 未铺垫的动机突变\nAdditional notes: ',
    );
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it('项目 run 在途 → 应用禁用、忽略不受限（D11）', () => {
    const msg = toolMessage('m1', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) },
    ]);
    useAppStore.setState({ agentMessages: [msg], agentRunStates: { 'sess-run': { sessionId: 'sess-run', phase: 'running', updatedAt: 1 } } } as any);
    render(<ReviewFindingsCard messageId="m1" result={msg.toolResults![0] as any} />);

    expect((screen.getAllByText('Apply')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByText('Ignore')[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('items 空 → 不渲染卡组（leader 文字已传达；锚点作用在 extract 层已履行）', () => {
    const msg = toolMessage('m1', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1', items: [] }) },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);
    const { container } = render(<ReviewFindingsCard messageId="m1" result={msg.toolResults![0] as any} />);
    expect(container.querySelector('.review-findings-card')).toBeNull();
  });

  it('同章旧卡降级（D5b）：muted class + stale badge + 全组按钮禁用；最新卡可操作', () => {
    const m1 = toolMessage('m1', [{ toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) }]);
    const m2 = toolMessage('m2', [{ toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) }]);
    useAppStore.setState({ agentMessages: [m1, m2] } as any);

    // 旧卡：降级。
    const { container: oldContainer } = render(
      <ReviewFindingsCard messageId="m1" result={m1.toolResults![0] as any} />,
    );
    const oldGroup = oldContainer.querySelector('.review-findings-card')!;
    expect(oldGroup.className).toContain('review-findings-card--stale');
    expect(screen.getByText('Newer review exists')).toBeTruthy();
    expect((oldContainer.querySelector('.insight-card-btn--apply') as HTMLButtonElement).disabled).toBe(true);
    expect((oldContainer.querySelector('.insight-card-btn--ignore') as HTMLButtonElement).disabled).toBe(true);
    // D5b 禁用范围：apply/ignore 锁（操作）；展开不锁（查看非操作）；展开态内「应用并补充」预填同样锁。
    expect((oldContainer.querySelector('.insight-card-btn--expand') as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    // 最新卡：可操作（无 muted / 无 stale badge / 按钮可用）。
    const { container: newContainer } = render(
      <ReviewFindingsCard messageId="m2" result={m2.toolResults![0] as any} />,
    );
    const newGroup = newContainer.querySelector('.review-findings-card')!;
    expect(newGroup.className).not.toContain('review-findings-card--stale');
    expect((newContainer.querySelector('.insight-card-btn--apply') as HTMLButtonElement).disabled).toBe(false);
    expect((newContainer.querySelector('.insight-card-btn--ignore') as HTMLButtonElement).disabled).toBe(false);
  });

  it('无 chapterId 的卡不参与新鲜度判定（视作最新可操作）', () => {
    const m1 = toolMessage('m1', [{ toolName: 'write_chapter', metadata: findingsMetadata() }]);
    const m2 = toolMessage('m2', [{ toolName: 'write_chapter', metadata: findingsMetadata() }]);
    useAppStore.setState({ agentMessages: [m1, m2] } as any);

    const { container } = render(<ReviewFindingsCard messageId="m1" result={m1.toolResults![0] as any} />);
    const group = container.querySelector('.review-findings-card')!;
    expect(group.className).not.toContain('review-findings-card--stale');
    expect((container.querySelector('.insight-card-btn--apply') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Story 3.7 #2 — AgentMessageItem findings 档挂载（tool 分支路由）', () => {
  beforeEach(() => {
    useAppStore.setState({
      resolvedLocale: 'en-US',
      activeSessionRunning: false,
      agentRunStates: {},
      agentMode: 'suggest',
      pendingDiffsBySession: {},
      agentMessages: [],
      dismissed: {},
      draftPreset: null,
      sendAgentMessage: vi.fn(),
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('findings result → ReviewFindingsCard 平铺替换默认呈现位（不出 DiffCard/AgentToolCard）', () => {
    const msg = toolMessage('m1', [
      { toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);

    const { container } = render(<AgentMessageItem message={msg} />);
    expect(container.querySelector('.review-findings-card')).toBeTruthy();
    expect(container.querySelector('.agent-diff-card')).toBeNull();
    expect(container.querySelector('.agent-tool-card')).toBeNull();
  });

  it('旧会话 write_chapter 无 findings 字段 → DiffCard 兜底不变（#5 行为零回归）', () => {
    const msg = toolMessage('m1', [
      { toolName: 'write_chapter', output: 'status: completed', metadata: { summary: {} } },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);

    const { container } = render(<AgentMessageItem message={msg} />);
    expect(container.querySelector('.agent-diff-card')).toBeTruthy();
    expect(container.querySelector('.review-findings-card')).toBeNull();
  });

  it('非 WRITE_TOOLS 无 findings result → AgentToolCard 兜底不变；同批 findings 与 step 各归各位', () => {
    const msg = toolMessage('m1', [
      { toolName: 'search', output: 'ok' },
      { toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) },
    ]);
    useAppStore.setState({ agentMessages: [msg] } as any);

    const { container } = render(<AgentMessageItem message={msg} />);
    expect(container.querySelector('.agent-tool-card')).toBeTruthy();
    expect(container.querySelector('.review-findings-card')).toBeTruthy();
    expect(container.querySelector('.agent-diff-card')).toBeNull();
  });

  it('同章后续消息到达 → 旧消息卡组自动降级（agentMessages 订阅驱动，非仅挂载时判一次）', async () => {
    const m1 = toolMessage('m1', [{ toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) }]);
    useAppStore.setState({ agentMessages: [m1] } as any);

    const { container } = render(<AgentMessageItem message={m1} />);
    expect(container.querySelector('.review-findings-card')!.className).not.toContain('review-findings-card--stale');

    // 新一轮审核结果到达（同章）→ 旧卡降级（act 包 setState 冲刷 store 订阅驱动的重渲染）。
    const m2 = toolMessage('m2', [{ toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1', items: [] }) }]);
    await act(async () => {
      useAppStore.setState({ agentMessages: [m1, m2] } as any);
    });
    expect(container.querySelector('.review-findings-card')!.className).toContain('review-findings-card--stale');
  });

  it('已忽略 finding 在重同步（fetchAgentSession 重建消息列表）后不复活（dismissed 全局 store）', () => {
    const msg = toolMessage('m1', [{ toolName: 'write_chapter', metadata: findingsMetadata({ chapterId: 'ch1' }) }]);
    const key = insightDismissKey('agent.insight.sourceReaderAudit', findingWarn.explanation, findingWarn.quote);
    useAppStore.setState({ agentMessages: [msg], dismissed: { [key]: true } } as any);

    const { container } = render(<AgentMessageItem message={msg} />);
    // warn 卡被忽略 → 只剩 block 卡。
    expect(container.querySelectorAll('.insight-card').length).toBe(1);
    expect(screen.queryByText('情绪未落地')).toBeNull();
  });
});
