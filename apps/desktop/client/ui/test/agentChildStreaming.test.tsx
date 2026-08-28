/**
 * dogfood T1 Stage 5（design §6.4/§7.3/§7.4，D5）：子 agent 可见性。
 *
 * 覆盖（implement.md Stage 5 测试清单）：
 * - 组内流式：child delta 占位创建（带分组前缀被既有 groupChildTags 识别 → 进组）→ 250ms
 *   flush 组内 content 增长（前缀不丢）→ child 终帧 assistant 同 id 替换（reasoning 透传）。
 * - child 占位废弃规则：同 childSessionId 新 messageId 废弃旧占位（S2 打回坑 child 侧）；
 *   并行不同 child 互不废弃；done/error 兜底清残余；后台会话不建占位。
 * - 自动展开/收起：活跃（组内有 streaming 占位）自动展开；完成自动收起；用户手动展开过的
 *   组完成后不自动收（所有权保留）；收起态活跃显示活动点。
 * - 当前动作标签：N = 组内 tool 消息计数、工具名 = 最新 tool 消息最新 toolResult 名（原文
 *   不翻译）；完成后隐藏。
 * - 徽标聚合：面板头部活跃 child 徽标（progress_activity + 角色 chip + 「第 N 步」）；
 *   空闲不占位；多角色并列。
 * - 既有 child 渲染回归：单条 child 消息平铺 ChildBadge（[subagent:role] 前缀剥离不漏正文）；
 *   非流式组默认折叠。
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentChildStreamEvent, AgentStreamEvent, AgentMessage } from '../src/shared/api/agent';

const apiMocks = vi.hoisted(() => ({
  fetchAgentSession: vi.fn(async () => ({ id: 'sess-a', status: 'idle', messages: [] })),
}));

vi.mock('../src/shared/api/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/shared/api/agent')>();
  return { ...original, ...apiMocks };
});

import { handleAgentStreamEvent, __clearAgentEventTracks, type AgentStreamWireEvent } from '../src/shared/store/agentEvents';
import {
  __clearAgentStreamBuffers,
  setStreamFlushIntervalMs,
} from '../src/shared/store/agentStreamBuffer';
import { ChildExecutionGroup } from '../src/features/agent-panel/ChildExecutionGroup';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { deriveChildActivity, groupChildTags } from '../src/features/agent-panel/messageGrouping';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';

// ── 测试基建 ──────────────────────────────────────────────────────────────────

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

const TAG = '[subagent:researcher]';

function toolMsg(id: string, toolName: string): AgentMessage {
  return msg({
    id,
    role: 'tool',
    content: TAG,
    toolResults: [{ toolCallId: `c-${id}`, toolName, output: 'ok' }],
  });
}

function childEvent(
  inner: AgentChildStreamEvent['event'],
  opts: { role?: string; childSessionId?: string; depth?: number; source?: 'subagent' | 'skill' } = {},
): AgentStreamEvent {
  return {
    type: 'child',
    data: {
      source: opts.source ?? 'subagent',
      role: opts.role ?? 'researcher',
      sessionId: opts.childSessionId ?? 'child-1',
      depth: opts.depth ?? 1,
      event: inner,
    },
  };
}

function childDelta(messageId: string, delta: string, channel: 'text' | 'reasoning' = 'text'): AgentChildStreamEvent['event'] {
  return { type: 'delta', data: { messageId, channel, delta } };
}

/** dogfood 第二轮 findings #3：child runLoop 启动前的起点信号（agent 侧 emitChildStarted）。 */
function childStarted(): AgentChildStreamEvent['event'] {
  return { type: 'started', data: {} };
}

// 最小 store（mirror agentStreamingBuffer.test.ts——分发器只依赖结构面）。
type TestState = {
  agentSessionId: string | null;
  agentMessages: AgentMessage[];
  activeSessionRunning: boolean;
  agentError: string | null;
  currentProject: { path?: string } | null;
  agentRunStates: Record<string, { sessionId: string; phase: string; projectPath?: string; activity?: string; updatedAt: number }>;
  chainRunBySession: Record<string, never>;
  setAgentRunState: (sessionId: string, patch: { phase?: string; projectPath?: string; activity?: string }) => void;
  setPendingToolConfirm: () => void;
  pushPendingDiff: () => void;
  setPausedReview: () => void;
  setPendingPatch: () => void;
  fieldMetadata: Record<string, unknown>;
};

const useTestStore = create<TestState>()((set) => ({
  agentSessionId: 'sess-a',
  agentMessages: [],
  activeSessionRunning: false,
  agentError: null,
  currentProject: { path: '/proj-a' },
  agentRunStates: {},
  chainRunBySession: {},
  setAgentRunState: (sessionId, patch) => set((s) => ({
    agentRunStates: {
      ...s.agentRunStates,
      [sessionId]: { sessionId, phase: patch.phase ?? 'idle', projectPath: patch.projectPath, activity: patch.activity, updatedAt: Date.now() },
    },
  })),
  setPendingToolConfirm: () => {},
  pushPendingDiff: () => {},
  setPausedReview: () => {},
  setPendingPatch: () => {},
  fieldMetadata: {},
}));

function ev(event: AgentStreamEvent, sessionId = 'sess-a'): AgentStreamWireEvent {
  return { ...event, sessionId, projectPath: '/proj-a' };
}

beforeEach(() => {
  __clearAgentStreamBuffers();
  // CR-T1-036：组级活性 Map（agentEvents 模块级）跨测试隔离 + 组件读的 appStore
  // activeSessionRunning 复位（迟滞判定只在 leader 在途时生效，别让上个测试泄漏开启）。
  __clearAgentEventTracks();
  useAppStore.setState({ activeSessionRunning: false } as any);
  setStreamFlushIntervalMs(250);
  useTestStore.setState({
    agentSessionId: 'sess-a',
    agentMessages: [],
    activeSessionRunning: false,
    agentError: null,
    agentRunStates: {},
    chainRunBySession: {},
  });
  useToastStore.setState({ toasts: [] });
  useAppStore.setState({ resolvedLocale: 'zh-CN' } as any);
});

afterEach(() => {
  __clearAgentStreamBuffers();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 缓冲与分发（store 面，fake-timer） ────────────────────────────────────────

describe('组内流式：child 占位创建 → flush → 终帧替换', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('child delta 首条建带分组前缀的占位（groupChildTags 识别）；250ms flush 前缀不丢', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm1', '检索到'))));
    const first = useTestStore.getState().agentMessages;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 'cm1', role: 'assistant', streaming: true, content: TAG });

    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().agentMessages[0].content).toBe(`${TAG} 检索到`);
    // 分组归属：与既有 child tool 消息同前缀 → groupChildTags 归同组（进 ChildExecutionGroup）。
    handleAgentStreamEvent(useTestStore, ev(childEvent({ type: 'tool', data: { id: 'ct1', results: [{ toolName: 'search', output: 'ok' }] } })));
    const grouped = groupChildTags(useTestStore.getState().agentMessages);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].type).toBe('child-group');
    expect((grouped[0] as { messages: AgentMessage[] }).messages.map((m) => m.id)).toEqual(['cm1', 'ct1']);
  });

  it('reasoning delta 进 reasoning 字段（child 折叠块数据源）', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm1', '思考', 'reasoning'))));
    vi.advanceTimersByTime(250);
    const m = useTestStore.getState().agentMessages[0];
    expect(m.reasoning).toBe('思考');
    expect(m.content).toBe(TAG);
  });

  it('child 终帧 assistant 同 id 整条替换占位（content 带前缀 + reasoning 透传 + streaming:false）', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm1', '半段'))));
    vi.advanceTimersByTime(250);
    handleAgentStreamEvent(useTestStore, ev(childEvent({
      type: 'assistant',
      data: { id: 'cm1', content: '完整检索报告', toolCalls: [], reasoning: '思考全文' },
    })));
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1); // 替换非追加
    expect(messages[0]).toMatchObject({
      id: 'cm1',
      role: 'assistant',
      content: `${TAG} 完整检索报告`,
      streaming: false,
      reasoning: '思考全文',
    });
  });

  it('非流式 child 零回归：无占位时 child assistant 事件照旧 append', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent({ type: 'assistant', data: { id: 'cm9', content: '直接结果' } })));
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'cm9', content: `${TAG} 直接结果`, streaming: false });
  });
});

describe('child 占位废弃规则（S2 打回坑 child 侧）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('同 childSessionId 新 messageId 首条 delta 废弃旧占位', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm1', '废稿'))));
    expect(useTestStore.getState().agentMessages).toHaveLength(1);

    // child loop 下一 turn 新 assistantId——旧占位等不到终帧，废弃 + 建新。
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm2', '重写'))));
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('cm2');
    expect(messages[0].streaming).toBe(true);
  });

  it('并行不同 child 互不废弃（childSessionId 维度跟踪）', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm1', 'A 流'), { childSessionId: 'child-1' })));
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm2', 'B 流'), { childSessionId: 'child-2' })));
    const ids = useTestStore.getState().agentMessages.map((m) => m.id).sort();
    expect(ids).toEqual(['cm1', 'cm2']);
  });

  it('done 兜底：等不到终帧的 child 残余占位清除（打回后 run 直接结束）', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm1', '废稿'))));
    expect(useTestStore.getState().agentMessages.some((m) => m.streaming)).toBe(true);
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
  });

  it('后台会话（视图已切走）child delta 不建占位——切回 fetch 对账', () => {
    useTestStore.setState({ agentSessionId: 'sess-b' });
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm1', '后台流'))));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
    // 后台 child 事件照旧驱动 run 态活动摘要（徽标「谁在跑」）。
    expect(useTestStore.getState().agentRunStates['sess-a']?.activity).toBe('subagent:researcher');
  });
});

// ── dogfood 第二轮 findings #3：started 起点占位（派发 → 首批输出间的空窗信号） ──

describe('started 起点占位（dogfood 第二轮 findings #3）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('child started → 建 live 占位（`child-start:` 前缀合成 id + streaming:true + 分组前缀 content），幂等', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childStarted())));
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'child-start:child-1', role: 'assistant', streaming: true, content: TAG });
    // 幂等：重复 started 不重复插入（createChildPlaceholder 内部判重）。
    handleAgentStreamEvent(useTestStore, ev(childEvent(childStarted())));
    expect(useTestStore.getState().agentMessages).toHaveLength(1);
  });

  it('首批真 delta 到达 → started 占位被既有废弃规则替换（无缝接真占位，组不闪断）', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childStarted())));
    handleAgentStreamEvent(useTestStore, ev(childEvent(childDelta('cm1', '首批输出'))));
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1); // 替换非并存
    expect(messages[0]).toMatchObject({ id: 'cm1', streaming: true, content: TAG });
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().agentMessages[0].content).toBe(`${TAG} 首批输出`);
  });

  it('首批终帧 assistant（非流式车道无 delta）→ started 占位显式废弃，终帧照旧 append', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childStarted())));
    handleAgentStreamEvent(useTestStore, ev(childEvent({ type: 'assistant', data: { id: 'cm9', content: '直接结果' } })));
    const messages = useTestStore.getState().agentMessages;
    expect(messages.map((m) => m.id)).toEqual(['cm9']); // started 占位不滞留（防永转 caret 假活）
    expect(messages[0]).toMatchObject({ content: `${TAG} 直接结果`, streaming: false });
  });

  it('done 兜底清 started 残余占位（run 直接结束等不到任何输出）', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childStarted())));
    expect(useTestStore.getState().agentMessages).toHaveLength(1);
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
  });

  // findings #3 原场景的 abort 收口：用户在空窗期点停 → leader done(aborted) → purge
  // 清 started 占位（不滞留成永转假活——正是原 finding 要消灭的形态）。
  it('abort（done status:aborted）同款兜底清 started 占位', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childStarted())));
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'aborted' } }));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
  });

  it('error 兜底清 started 残余占位（error 终态后不再有终帧）', () => {
    handleAgentStreamEvent(useTestStore, ev(childEvent(childStarted())));
    handleAgentStreamEvent(useTestStore, ev({ type: 'error', data: { message: 'endpoint 500' } }));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
  });

  it('后台会话 started 不建占位（run 态 activity 摘要照写）', () => {
    useTestStore.setState({ agentSessionId: 'sess-b' });
    handleAgentStreamEvent(useTestStore, ev(childEvent(childStarted())));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
    expect(useTestStore.getState().agentRunStates['sess-a']?.activity).toBe('subagent:researcher');
  });
});

// ── ChildExecutionGroup 组件面 ────────────────────────────────────────────────

function renderGroup(messages: AgentMessage[]) {
  return render(
    <ChildExecutionGroup source="subagent" role="researcher" depth={1} messages={messages} />,
  );
}

describe('自动展开 / 收起时机', () => {
  it('活跃（组内 streaming 占位）→ 自动展开', async () => {
    const { container } = renderGroup([toolMsg('ct1', 'search'), msg({ id: 'cm1', role: 'assistant', content: `${TAG} 正在写`, streaming: true })]);
    await act(async () => {});
    expect(container.querySelector('.agent-child-group--active')).not.toBeNull();
    expect(container.querySelector('.agent-child-group-body')).not.toBeNull();
  });

  it('完成（占位终帧替换，无 streaming）→ 自动收起 + success 状态点一闪', async () => {
    const active = [toolMsg('ct1', 'search'), msg({ id: 'cm1', role: 'assistant', content: `${TAG} 正在写`, streaming: true })];
    const { container, rerender } = renderGroup(active);
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).not.toBeNull();

    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[toolMsg('ct1', 'search'), msg({ id: 'cm1', role: 'assistant', content: `${TAG} 完稿` })]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).toBeNull();
    expect(container.querySelector('.agent-child-group-dot--done')).not.toBeNull();
  });

  it('用户手动展开的组：完成后不自动收（所有权保留）', async () => {
    const inactive = [toolMsg('ct1', 'search'), msg({ id: 'cm1', role: 'assistant', content: `${TAG} 完稿` })];
    const { container, rerender } = renderGroup(inactive);
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).toBeNull(); // 非流式默认折叠（零回归）

    // 用户手动展开。
    fireEvent.click(container.querySelector('.agent-child-group-header') as HTMLElement);
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).not.toBeNull();

    // 转活跃（组内出现 streaming 占位）——已展开不重复动作。
    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[...inactive, msg({ id: 'cm2', role: 'assistant', content: `${TAG} 新一轮`, streaming: true })]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).not.toBeNull();

    // 完成——用户持有所有权，不自动收。
    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[...inactive, msg({ id: 'cm2', role: 'assistant', content: `${TAG} 新一轮完` })]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).not.toBeNull();
  });

  it('收起态活跃：活动点留头部右侧，「当前动作」chip 隐藏', async () => {
    const { container } = renderGroup([toolMsg('ct1', 'search'), msg({ id: 'cm1', role: 'assistant', content: `${TAG} 正在写`, streaming: true })]);
    await act(async () => {});
    // 自动展开后用户手动收起。
    fireEvent.click(container.querySelector('.agent-child-group-header') as HTMLElement);
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).toBeNull();
    expect(container.querySelector('.agent-child-group-dot:not(.agent-child-group-dot--done)')).not.toBeNull();
    expect(container.querySelector('.agent-child-group-action')).toBeNull();
  });
});

describe('「当前动作」标签派生（第 N 步 · 工具名）', () => {
  it('N = 组内 tool 消息计数；工具名 = 最新 tool 消息的最新 toolResult 名（经 toolMeta 映射翻译——dogfood #38）', async () => {
    const { container } = renderGroup([
      toolMsg('ct1', 'search'),
      msg({ id: 'ca1', role: 'assistant', content: `${TAG} 中间结论` }),
      toolMsg('ct2', 'read_file'),
      msg({ id: 'cm1', role: 'assistant', content: `${TAG} 正在写`, streaming: true }),
    ]);
    await act(async () => {});
    const label = container.querySelector('.agent-child-group-action') as HTMLElement;
    expect(label).not.toBeNull();
    expect(label.textContent).toBe('第 2 步 · 读取文件');
  });

  it('首个生成期（尚无 tool 消息）回落「启动中…」chip（dogfood 第二轮 findings #3）；完成后隐藏', async () => {
    const { container, rerender } = renderGroup([msg({ id: 'cm1', role: 'assistant', content: `${TAG} 第一段`, streaming: true })]);
    await act(async () => {});
    const chip = container.querySelector('.agent-child-group-action') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe('启动中…');

    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[toolMsg('ct1', 'search'), msg({ id: 'cm1', role: 'assistant', content: `${TAG} 第一段完` })]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-action')).toBeNull(); // 完成隐藏
  });
});

describe('组内流式与既有 child 渲染（AgentMessages 集成）', () => {
  beforeEach(() => {
    useAppStore.setState({
      resolvedLocale: 'zh-CN',
      activeSessionRunning: false,
      agentRunStates: {},
      agentSessionId: 'session-1',
      sendAgentMessage: vi.fn(),
      truncateAgentMessages: vi.fn(),
    } as any);
  });

  it('child 占位 + tool 卡归同组：活跃自动展开，占位走流式轨（caret class）', async () => {
    const messages = [
      toolMsg('ct1', 'search'),
      msg({ id: 'cm1', role: 'assistant', content: `${TAG} 正在写正文`, streaming: true }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={true} error={null} />);
    await act(async () => {});
    // 分组归属：两组件形态都在 .agent-child-group 内。
    const group = container.querySelector('.agent-child-group') as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.classList.contains('agent-child-group--active')).toBe(true); // 活跃修饰类
    expect(group.querySelector('.agent-child-group-body')).not.toBeNull(); // 自动展开
    // 工具卡实时进组 + 占位流式轨（250ms MD 快照 + caret class，前缀剥离）。
    expect(group.querySelector('.agent-child-group-body .agent-msg-tool')).not.toBeNull();
    const md = group.querySelector('.agent-msg-md--streaming') as HTMLElement;
    expect(md).not.toBeNull();
    expect(md.textContent).toContain('正在写正文');
    expect(md.textContent).not.toContain('[subagent:researcher]');
  });

  it('单条 child 消息平铺（R2 #29 后身份并入标签行）；非流式组默认折叠', async () => {
    const single = [msg({ id: 'ca1', role: 'assistant', content: `${TAG} 检索完成` })];
    const { container } = render(<AgentMessages messages={single} loading={false} error={null} />);
    await act(async () => {});
    // R2 #29：说话者标签行承载身份（子代理 · 角色名，词表外角色回落原文）；assistant
    // 消息不再叠 ChildBadge（去重）。
    expect(container.querySelector('.agent-msg-label--child')?.textContent).toContain('子代理 · researcher');
    expect(container.querySelector('.agent-child-badge')).toBeNull();
    // isLatest + 500ms 窗内 → 打字机回放（既有行为零回归）——等终态 MD 落位再断言正文。
    await vi.waitFor(() => {
      expect(container.querySelector('.agent-msg-md')?.textContent).toContain('检索完成');
    });
    expect(container.querySelector('.agent-msg-md')?.textContent).not.toContain('[subagent:researcher]');

    const settled = [
      msg({ id: 'ca1', role: 'assistant', content: `${TAG} 检索完成` }),
      toolMsg('ct1', 'search'),
    ];
    const { container: c2 } = render(<AgentMessages messages={settled} loading={false} error={null} />);
    await act(async () => {});
    expect(c2.querySelector('.agent-child-group')).not.toBeNull();
    expect(c2.querySelector('.agent-child-group-body')).toBeNull(); // 默认折叠（零回归）
  });

  // dogfood 第二轮 findings #3：派发 → 首批输出间的空窗期（started 占位是组内唯一消息）——
  // 单条带前缀消息平铺 ChildBadge + 三点 loading（agentMsgItem 空正文流式态），面板非全空白。
  it('started 空窗期（单条 started 占位）：身份标签行 + 三点 loading 承载「已派发、正在跑」', async () => {
    const messages = [msg({ id: 'child-start:child-1', role: 'assistant', content: TAG, streaming: true })];
    const { container } = render(<AgentMessages messages={messages} loading={true} error={null} />);
    await act(async () => {});
    expect(container.querySelector('.agent-msg-label--child')?.textContent).toContain('子代理 · researcher');
    expect(container.querySelector('.agent-message-loading')).not.toBeNull(); // 空正文流式态三点
  });
});

// ── 面板头部聚合徽标（design §7.4） ───────────────────────────────────────────

describe('deriveChildActivity 纯派生', () => {
  it('无 streaming 占位 → null（空闲不占位）', () => {
    expect(deriveChildActivity([toolMsg('ct1', 'search'), msg({ id: 'ca1', role: 'assistant', content: `${TAG} 完` })])).toBeNull();
    expect(deriveChildActivity([])).toBeNull();
  });

  it('多活跃组并列：roles 去重并列，「第 N 步」取最近活跃组', () => {
    const messages = [
      toolMsg('ct1', 'search'),
      msg({ id: 'cm1', role: 'assistant', content: `${TAG} A 流`, streaming: true }),
      msg({ id: 'leader', role: 'assistant', content: 'leader 中间话' }), // 断开连续段
      msg({ id: 'ct2', role: 'tool', content: '[subagent:writer]', toolResults: [{ toolCallId: 'c2', toolName: 'chapter_read', output: 'ok' }] }),
      msg({ id: 'cm2', role: 'assistant', content: '[subagent:writer] B 流', streaming: true }),
    ];
    const summary = deriveChildActivity(messages);
    expect(summary).not.toBeNull();
    expect(summary?.roles).toEqual([
      { source: 'subagent', role: 'researcher' },
      { source: 'subagent', role: 'writer' },
    ]);
    expect(summary?.step).toBe(1);
    expect(summary?.toolName).toBe('chapter_read');
  });
});

describe('AgentPanel 头部活跃 child 徽标', () => {
  beforeEach(() => {
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
      resolvedLocale: 'zh-CN',
      agentMessages: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      agentSessionId: 'session-1',
      agentSkills: [],
      agentSkillError: null,
      loadAgentSkills: vi.fn(),
      sendAgentMessage: vi.fn(),
      truncateAgentMessages: vi.fn(),
      agentSessions: [],
    } as any);
  });

  it('活跃 child 组：progress_activity 图标 + 角色 chip + 「第 N 步」；空闲不占位', async () => {
    const { container, rerender } = render(<AgentPanel />);
    await act(async () => {});
    expect(container.querySelector('.agent-panel-child-activity')).toBeNull(); // 空闲不占位

    useAppStore.setState({
      agentMessages: [
        toolMsg('ct1', 'search'),
        toolMsg('ct2', 'read_file'),
        msg({ id: 'cm1', role: 'assistant', content: `${TAG} 正在写`, streaming: true }),
      ],
    } as any);
    rerender(<AgentPanel />);
    await act(async () => {});
    const badge = container.querySelector('.agent-panel-child-activity') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.querySelector('.material-symbols-outlined')?.textContent).toBe('progress_activity');
    // CR-T1-046：chip 补 source 维度（sourceLabel · role，与 ChildBadge/组头同款）。
    expect(badge.querySelector('.agent-child-activity-chip')?.textContent).toBe('子代理 · researcher');
    expect(badge.textContent).toContain('第 2 步');
  });
});
// ── dogfood T1 CR-T1-036/039/046：组级活跃（整次派发级）+ 展开所有权 + 旋转收敛 ──

function liveChildMsg(id: string): AgentMessage {
  return msg({ id, role: 'assistant', content: `${TAG} 正在写`, streaming: true });
}
function settledChildMsg(id: string): AgentMessage {
  return msg({ id, role: 'assistant', content: `${TAG} 完稿` });
}
/** 组级活性源：分发一个 child 事件（活跃视图分支写 agentEvents 的组活性迟滞 Map）。 */
function touchGroupActivity(): void {
  handleAgentStreamEvent(useTestStore, ev(childEvent({
    type: 'tool',
    data: { id: `ct-${Math.random().toString(36).slice(2, 8)}`, results: [{ toolName: 'search', output: 'ok' }] },
  })));
}

describe('CR-T1-036 组级活跃（整次派发级——turn 间隙不误判完成）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('child turn 间隙（终帧替换占位、无 streaming）+ leader 在途 → 保持活跃展开，不误发完成点', async () => {
    useAppStore.setState({ activeSessionRunning: true } as any);
    touchGroupActivity();

    const { container, rerender } = renderGroup([toolMsg('ct1', 'search'), liveChildMsg('cm1')]);
    await act(async () => {});
    expect(container.querySelector('.agent-child-group--active')).not.toBeNull();
    expect(container.querySelector('.agent-child-group-body')).not.toBeNull();

    // turn 间隙：占位被终帧替换（组内无 streaming）——旧 live-only 判定此刻翻转（收起 +
    // doneFlash 假完成），迟滞窗内保持「仍在跑」。
    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[toolMsg('ct1', 'search'), settledChildMsg('cm1')]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group--active')).not.toBeNull();
    expect(container.querySelector('.agent-child-group-body')).not.toBeNull(); // 不自动收起
    expect(container.querySelector('.agent-child-group-dot--done')).toBeNull(); // 无假完成绿闪
  });

  it('leader run 终态（activeSessionRunning false）→ 迟滞即失效，立即收起 + 完成点一闪', async () => {
    useAppStore.setState({ activeSessionRunning: true } as any);
    touchGroupActivity();

    const { container, rerender } = renderGroup([toolMsg('ct1', 'search'), liveChildMsg('cm1')]);
    await act(async () => {});

    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[toolMsg('ct1', 'search'), settledChildMsg('cm1')]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group--active')).not.toBeNull(); // 迟滞窗内仍活跃

    // leader run 结束（done/error → activeSessionRunning:false）——真完成，无延迟感。
    useAppStore.setState({ activeSessionRunning: false } as any);
    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[toolMsg('ct1', 'search'), settledChildMsg('cm1')]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group--active')).toBeNull();
    expect(container.querySelector('.agent-child-group-body')).toBeNull();
    expect(container.querySelector('.agent-child-group-dot--done')).not.toBeNull();
  });

  it('迟滞窗耗尽（leader 在途但组 10s 无事件）→ 收起（静默真完成兜底）', async () => {
    useAppStore.setState({ activeSessionRunning: true } as any);
    touchGroupActivity();

    const { container, rerender } = renderGroup([toolMsg('ct1', 'search'), liveChildMsg('cm1')]);
    await act(async () => {});
    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[toolMsg('ct1', 'search'), settledChildMsg('cm1')]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group--active')).not.toBeNull();

    // 越窗（CHILD_DISPATCH_GRACE_MS = 10s）：到期复核定时器强制重渲 → 迟滞失效。
    await act(async () => { vi.advanceTimersByTime(10_500); });
    expect(container.querySelector('.agent-child-group--active')).toBeNull();
    expect(container.querySelector('.agent-child-group-body')).toBeNull();
  });
});

describe('CR-T1-039 展开方向所有权（手动收起后不强制展开）', () => {
  it('用户手动收起 → 组完成 → 同组新一轮转活跃：自动展开不抢（body 保持收起）', async () => {
    const { container, rerender } = renderGroup([toolMsg('ct1', 'search'), liveChildMsg('cm1')]);
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).not.toBeNull(); // 自动展开

    // 用户手动收起（所有权翻转归用户）。
    fireEvent.click(container.querySelector('.agent-child-group-header') as HTMLElement);
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).toBeNull();

    // 组完成（leader 终态）→ 完成过渡。
    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[toolMsg('ct1', 'search'), settledChildMsg('cm1')]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).toBeNull();

    // 新一轮 dispatch（新占位）→ 转活跃——旧实现每次激活都强制展开（所有权只防收起方向）。
    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[toolMsg('ct1', 'search'), settledChildMsg('cm1'), liveChildMsg('cm2')]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group--active')).not.toBeNull(); // 活跃（样式/状态点在）
    expect(container.querySelector('.agent-child-group-body')).toBeNull(); // 但不抢展开
  });

  it('从未手动操作过的组：新一轮转活跃照旧自动展开（automation 所有权不回退）', async () => {
    const { container, rerender } = renderGroup([toolMsg('ct1', 'search'), settledChildMsg('cm1')]);
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).toBeNull(); // 历史组默认折叠

    rerender(
      <ChildExecutionGroup
        source="subagent"
        role="researcher"
        depth={1}
        messages={[toolMsg('ct1', 'search'), settledChildMsg('cm1'), liveChildMsg('cm2')]}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-child-group-body')).not.toBeNull(); // 自动展开照旧
  });
});

describe('CR-T1-046 同类旋转动画至多一处（§7.7 收敛）', () => {
  beforeEach(() => {
    useAppStore.setState({
      resolvedLocale: 'zh-CN',
      activeSessionRunning: true,
      agentRunStates: {},
      agentSessionId: 'session-1',
      sendAgentMessage: vi.fn(),
      truncateAgentMessages: vi.fn(),
    } as any);
  });

  it('多 live child 组并流：只有首个组的图标旋转；其余活跃组静态 progress 图标', async () => {
    const messages: AgentMessage[] = [
      toolMsg('ct1', 'search'),
      msg({ id: 'cm1', role: 'assistant', content: `${TAG} A 流`, streaming: true }),
      msg({ id: 'leader', role: 'assistant', content: 'leader 中间话' }), // 断开连续段
      msg({ id: 'ct2', role: 'tool', content: '[subagent:writer]', toolResults: [{ toolCallId: 'c2', toolName: 'chapter_read', output: 'ok' }] }),
      msg({ id: 'cm2', role: 'assistant', content: '[subagent:writer] B 流', streaming: true }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={true} error={null} />);
    await act(async () => {});

    const groups = container.querySelectorAll('.agent-child-group');
    expect(groups.length).toBe(2);
    // 两个组都活跃（live 占位在）。
    expect(groups[0].classList.contains('agent-child-group--active')).toBe(true);
    expect(groups[1].classList.contains('agent-child-group--active')).toBe(true);
    // 但旋转图标只有首个组一处。
    expect(container.querySelectorAll('.agent-child-group-icon--spin')).toHaveLength(1);
    expect(groups[0].querySelector('.agent-child-group-icon--spin')).not.toBeNull();
    expect(groups[1].querySelector('.agent-child-group-icon--spin')).toBeNull();
    // 非 foremost 活跃组仍以静态 progress_activity 图标承载活跃语义。
    expect(groups[1].querySelector('.agent-child-group-icon')?.textContent).toBe('progress_activity');
  });
});

describe('CR-T1-036 deriveChildActivity 组级活跃（面板徽标数据源）', () => {
  it('turn 间隙（无 streaming）+ leader 在途 + 迟滞窗内有事件 → 徽标不打 null', () => {
    touchGroupActivity(); // 刷新组活性（活跃视图分支）
    const settled = [toolMsg('ct1', 'search'), settledChildMsg('ca1')];
    expect(deriveChildActivity(settled, true)).not.toBeNull();
  });

  it('leader 终态（leaderRunning=false）→ null（真完成徽标退场）', () => {
    touchGroupActivity();
    const settled = [toolMsg('ct1', 'search'), settledChildMsg('ca1')];
    expect(deriveChildActivity(settled, false)).toBeNull();
  });

  it('无事件记录的历史组（另一 tag）即使 leader 在途也不活跃', () => {
    const writerSettled = [
      msg({ id: 'wt1', role: 'tool', content: '[subagent:writer]', toolResults: [{ toolCallId: 'c1', toolName: 'chapter_read', output: 'ok' }] }),
      msg({ id: 'wa1', role: 'assistant', content: '[subagent:writer] 历史完稿' }),
    ];
    expect(deriveChildActivity(writerSettled, true)).toBeNull();
  });
});
