/**
 * dogfood T1 Stage 6（design §4/§6.2）：链运行态缓冲与状态机。
 *
 * 覆盖（implement.md Stage 6 测试清单）：
 * - (nodeId, seq) 拼接不混旧流：同流拼接 / 新 seq 重开段 / 同流换 messageId 轮另起。
 * - flush 节流（fake-timer）：delta 不即写 store，250ms flush；>20K 自适应 500ms。
 * - chain-node-done 状态机：节点步进 / error·blocked 标注 / 哨兵终态映射（completed /
 *   paused / aborted / error / auto_revise_pending→completed）。
 * - 终态后再收事件 = 新 run 重置；finalizeChainRun 兜底（done→aborted / error；paused 保持）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentStreamEvent } from '../src/shared/api/agent';

const apiMocks = vi.hoisted(() => ({
  fetchAgentSession: vi.fn(async () => null),
}));

vi.mock('../src/shared/api/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/shared/api/agent')>();
  return { ...original, ...apiMocks };
});

import { handleAgentStreamEvent, type AgentStreamWireEvent } from '../src/shared/store/agentEvents';
import {
  __clearChainStreamState,
  applyChainDelta,
  applyChainNodeDone,
  finalizeChainRun,
  CHAIN_RUN_SENTINEL_NODE_ID,
  type ChainBufferState,
  type ChainRunState,
} from '../src/shared/store/chainStreamBuffer';

type TestState = ChainBufferState & {
  agentSessionId: string | null;
  agentMessages: never[];
  activeSessionRunning: boolean;
  agentError: string | null;
  currentProject: { path?: string } | null;
  agentRunStates: Record<string, { sessionId: string; phase: string; updatedAt: number }>;
  setAgentRunState: (sessionId: string, patch: { phase?: string; projectPath?: string; activity?: string }) => void;
  setPendingToolConfirm: () => void;
  pushPendingDiff: () => void;
  setPausedReview: () => void;
  setPendingPatch: () => void;
  fieldMetadata: Record<string, unknown>;
  /** dogfood R2 #105 假中断守卫：resume 在途判据（chapterReviewSlice 面——dispatcher 结构读）。 */
  reviewResuming: boolean;
  pausedReviewBySession: Record<string, unknown>;
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
      [sessionId]: { sessionId, phase: patch.phase ?? 'idle', updatedAt: Date.now() },
    },
  })),
  setPendingToolConfirm: () => {},
  pushPendingDiff: () => {},
  setPausedReview: () => {},
  setPendingPatch: () => {},
  fieldMetadata: {},
  reviewResuming: false,
  pausedReviewBySession: {},
}));

function run(sid = 'sess-a'): ChainRunState | undefined {
  return useTestStore.getState().chainRunBySession[sid];
}

function chainDelta(over: Partial<{ nodeId: string; messageId: string; delta: string; seq: number }> = {}) {
  return {
    nodeId: over.nodeId ?? 'draft-writer-agent',
    role: 'draft-writer-agent',
    phase: 'writing',
    messageId: over.messageId ?? 'm1',
    delta: over.delta ?? '',
    seq: over.seq ?? 0,
  };
}

function chainNodeDone(nodeId: string, status: string) {
  return { nodeId, status };
}

beforeEach(() => {
  vi.useFakeTimers();
  __clearChainStreamState();
  useTestStore.setState({
    agentSessionId: 'sess-a',
    activeSessionRunning: false,
    agentError: null,
    agentRunStates: {},
    chainRunBySession: {},
    reviewResuming: false,
    pausedReviewBySession: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  __clearChainStreamState();
});

describe('applyChainDelta — (nodeId, seq) 拼接', () => {
  it('同流 delta 拼接 + 250ms flush 节流（不即写 store）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '黄昏' }));
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '的荒野' }));
    // 建档即时（status running + streaming），正文等 flush。
    expect(run()?.status).toBe('running');
    expect(run()?.streaming).toBe(true);
    expect(run()?.streamText).toBe('');
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('黄昏的荒野');
    // 再无新 delta → 下一 flush 窗不写（内容不变）。
    vi.advanceTimersByTime(500);
    expect(run()?.streamText).toBe('黄昏的荒野');
  });

  it('新 seq（redo 重跑）重开段：旧流不混入；同流换 messageId 轮另起', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm1', delta: '旧流文本', seq: 0 }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('旧流文本');
    // redo：同 nodeId 新 seq —— 新段，旧流整体替换。
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm2', delta: '新流', seq: 1 }));
    expect(run()?.streamText).toBe(''); // 新段开段即重置（meta 先行）
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm2', delta: '开头', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('新流开头');
    // 同流内换轮（阶段二查询轮后另起写作轮）——文本另起不拼接。
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm3', delta: '第二轮', seq: 1 }));
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm3', delta: '正文', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('第二轮正文');
  });

  it('>20K 字符自适应：flush 间隔拉长到 500ms（250ms 不写，500ms 写）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '长'.repeat(21000) }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe(''); // 基准窗不 flush
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('长'.repeat(21000));
  });
});

describe('applyChainNodeDone — 状态机', () => {
  it('普通节点步进：completedNodes 累积 + 当前锚点推进 + error/blocked 标注', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('draft-writer-agent', 'done'));
    expect(run()?.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
    expect(run()?.currentNodeId).toBe('draft-writer-agent');
    expect(run()?.errorNodeId).toBeNull();

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('multi-review-agent', 'error'));
    expect(run()?.errorNodeId).toBe('multi-review-agent');
    // run 级仍 running（终态等哨兵帧）。
    expect(run()?.status).toBe('running');
  });

  it('哨兵终态映射：completed / paused / aborted / error / auto_revise_pending→completed', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    expect(run()?.status).toBe('completed');
    expect(run()?.streaming).toBe(false);

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    expect(run()?.status).toBe('paused');

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'aborted'));
    expect(run()?.status).toBe('aborted');

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'error'));
    expect(run()?.status).toBe('error');

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'auto_revise_pending'));
    expect(run()?.status).toBe('completed');

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'blocked'));
    expect(run()?.status).toBe('error');
  });

  it('终态后再收普通节点事件 = 新 run：completedNodes 重置从头累积', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    expect(run()?.completedNodes).toEqual(['brief-compiler-node']);
    // 下一章 / redo：新 run。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    expect(run()?.status).toBe('running');
    expect(run()?.completedNodes).toEqual(['brief-compiler-node']);
    expect(run()?.errorNodeId).toBeNull();
  });

  it('paused 后 resume/redo 事件到达 → 回 running（精简态只属等审阅窗口；redo 重跑正文照流）', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    expect(run()?.status).toBe('paused');
    // resume 续跑的下一节点事件 → 回 running。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('revision-guard-agent', 'done'));
    expect(run()?.status).toBe('running');
    // 再 paused 后 redo delta 到达（draft-writer 重跑新流）→ 同样回 running + 开新段。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm-redo', delta: '改稿正文', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.status).toBe('running');
    expect(run()?.streamText).toBe('改稿正文');
  });
});

describe('finalizeChainRun — done/error 兜底', () => {
  it('链仍 running 时 done 兜底 → aborted（中断标数据源）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '已流出部分' }));
    vi.advanceTimersByTime(250);
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(run()?.status).toBe('aborted');
    // 已流出文本保留（中断态呈现）。
    expect(run()?.streamText).toBe('已流出部分');
    expect(run()?.streaming).toBe(false);
  });

  it('哨兵已定终态 / paused → 兜底不改写', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(run()?.status).toBe('completed');

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(run()?.status).toBe('paused');
  });
});

describe('handleAgentStreamEvent — chain 事件分发（dispatcher 集成）', () => {
  function ev(event: AgentStreamEvent, sessionId = 'sess-a'): AgentStreamWireEvent {
    return { ...event, sessionId, projectPath: '/proj-a' };
  }

  it('chain-delta / chain-node-done 事件驱动链态 + done 兜底中断', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-delta',
      data: chainDelta({ delta: '正文' }),
    }));
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-node-done',
      data: chainNodeDone('brief-compiler-node', 'done'),
    }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('正文');
    expect(run()?.completedNodes).toEqual(['brief-compiler-node']);
    // run 态徽标同款驱动（S3 既有行为不回归）。
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('running');

    // leader run 结束而链无终态帧 → 兜底中断。
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'aborted' } }));
    expect(run()?.status).toBe('aborted');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood R2 #105 假中断根治（2026-08-30）：resume 链跑在 leader turn 生命周期外——done 兜底
// 前置守卫（reviewResuming + 该会话 pausedReview = 在途 resume IPC）命中时不 finalize 不删缓冲。
// ════════════════════════════════════════════════════════════════════════════
describe('dogfood R2 #105 假中断根治（done 兜底守卫——缓冲不删）', () => {
  it('resume 在途 → leader turn done 不误标 aborted 不删缓冲：后续 flush 窗照写 streamText', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '正文' }));
    // resume IPC 在途（ChapterReviewPanel 三动作已发出、长跑 IPC 未返回）。
    useTestStore.setState({
      reviewResuming: true,
      pausedReviewBySession: { 'sess-a': { type: 'chapter_review', stage: 'draft' } },
    });

    // leader turn 结束（resume 跑在 turn 外——done 不构成链被掐证据）。
    handleAgentStreamEvent(useTestStore, { type: 'done', data: { status: 'completed' }, sessionId: 'sess-a', projectPath: '/proj-a' });

    // 链不被误终态化（finalize 会标 aborted + force flush + 删缓冲——三者都没发生）。
    expect(run()?.status).toBe('running');
    // 缓冲未删：flush 窗到 → streamText 照写（增量续流能力保留）。
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('正文');
    expect(run()?.streaming).toBe(true);
  });

  it('resume 不在途 → done 兜底照旧（force flush + 删缓冲 + 标 aborted——既有语义不回归）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '正文' }));

    handleAgentStreamEvent(useTestStore, { type: 'done', data: { status: 'completed' }, sessionId: 'sess-a', projectPath: '/proj-a' });

    expect(run()?.status).toBe('aborted');
    expect(run()?.streamText).toBe('正文'); // force flush 兜住尾巴
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood T1 CR 批4/批5：finalize 同步 run 态（CR-T1-049）/ node-done 收口 streaming
// （CR-T1-050）/ 终帧先 flush + per-session 降频（CR-T1-051）
// ════════════════════════════════════════════════════════════════════════════

describe('CR-T1-049 finalizeChainRun 同步 run 态（dogfood stub 幽灵 running 徽标）', () => {
  it('finalize aborted → run 态归 idle；error → 归 error（终态漏斗不再只动链态）', () => {
    useTestStore.getState().setAgentRunState('sess-a', { phase: 'running', projectPath: '/proj-a' });
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '正文' }));
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('idle');

    useTestStore.getState().setAgentRunState('sess-a', { phase: 'running' });
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: 'x', seq: 1 }));
    finalizeChainRun(useTestStore, 'sess-a', 'error');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('error');
  });

  it('paused 早退（链态保持）时 run 态同样归位——paused 的 run 本身已结束', () => {
    useTestStore.getState().setAgentRunState('sess-a', { phase: 'running', projectPath: '/proj-a' });
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    useTestStore.getState().setAgentRunState('sess-a', { phase: 'running' });
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('idle');
    expect(run()?.status).toBe('paused'); // 链态不被兜底改写（审阅面板在等）
  });
});

describe('CR-T1-050 普通 node-done 命中流节点 → streaming 收口', () => {
  it('draft-writer done → streaming:false（auto 档链尾 JSON 节点期不再假「正在写作」+ caret 残留）；streamText 保留', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '已流出的正文' }));
    expect(run()?.streaming).toBe(true);
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('draft-writer-agent', 'done'));
    expect(run()?.streaming).toBe(false);
    // 正文保留（终态/中断呈现「已流出部分」）——flush 照写（streaming 只控 caret/占位判定）。
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('已流出的正文');
  });

  it('非流节点的 node-done 不动 streaming（他节点步进不打断在途流）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '流中' }));
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    expect(run()?.streaming).toBe(true);
  });
});

describe('CR-T1-051 终帧先 flush 后删 + per-session 降频', () => {
  it('哨兵终态帧到达时同步 force flush——中断尾巴不丢（旧实现只兑现到上个 flush 点）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '已流出部分' }));
    // 未到任何 flush 窗（0ms）——哨兵终帧先 force flush 再删缓冲。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'aborted'));
    expect(run()?.status).toBe('aborted');
    expect(run()?.streamText).toBe('已流出部分');
  });

  it('finalizeChainRun（done/error 兜底）同款 force flush', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '尾巴' }));
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(run()?.streamText).toBe('尾巴');
  });

  it('per-session 降频：A 会话 >20K 长文不再拖慢 B 会话的 250ms flush（块5 附注跨会话耦合）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '长'.repeat(21000) }));
    applyChainDelta(useTestStore, 'sess-b', chainDelta({ delta: '短文本' }));

    vi.advanceTimersByTime(250);
    // B 会话基准窗照 flush（旧全局 nextFlushDelayMs 会因 A >20K 把 B 也拖到 500ms）。
    expect(useTestStore.getState().chainRunBySession['sess-b']?.streamText).toBe('短文本');
    expect(useTestStore.getState().chainRunBySession['sess-a']?.streamText).toBe('');

    // A 会话降频窗（500ms）到——写。
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().chainRunBySession['sess-a']?.streamText).toBe('长'.repeat(21000));
  });
});
