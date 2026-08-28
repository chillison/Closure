/**
 * dogfood T1 Stage 4（design §6.1/§6.2/§6.3）：leader 流式 UI 的缓冲与占位生命周期。
 *
 * 覆盖（implement.md Stage 4 测试清单）：
 * - 缓冲 flush 节流（fake-timer）：delta 进模块级缓冲不即写 store，250ms flush 更新占位 content。
 * - 占位创建 → 终帧替换（reasoning/kind 透传，streaming:false）。
 * - 占位废弃规则：同 session 新 messageId 到达即废弃旧占位；user/tool 消息不动；
 *   done/error 兜底清残余（打回丢弃的废稿等不到终帧）。
 * - switch 重映射透传 reasoning（折叠块重载会话仍在——透传链三处的第三处）。
 * - 非流式路径零回归：无占位时 assistant 事件照旧 append。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentStreamEvent, AgentMessage } from '../src/shared/api/agent';

const apiMocks = vi.hoisted(() => ({
  fetchAgentSession: vi.fn(async () => ({ id: 'sess-a', status: 'idle', messages: [] })),
}));

vi.mock('../src/shared/api/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/shared/api/agent')>();
  return { ...original, ...apiMocks };
});

import { handleAgentStreamEvent, type AgentStreamWireEvent } from '../src/shared/store/agentEvents';
import {
  __clearAgentStreamBuffers,
  setStreamFlushIntervalMs,
} from '../src/shared/store/agentStreamBuffer';
import { createAgentSessionSlice, type AgentSessionSlice } from '../src/shared/store/agentSessionSlice';
import { useToastStore } from '../src/shared/store/toastStore';

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
      [sessionId]: {
        sessionId,
        phase: patch.phase ?? 'idle',
        projectPath: patch.projectPath,
        activity: patch.activity,
        updatedAt: Date.now(),
      },
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

function delta(messageId: string, text: string, channel: 'text' | 'reasoning' = 'text'): AgentStreamEvent {
  return { type: 'delta', data: { messageId, channel, delta: text } };
}

beforeEach(() => {
  vi.useFakeTimers();
  __clearAgentStreamBuffers();
  setStreamFlushIntervalMs(250);
  useTestStore.setState({
    agentSessionId: 'sess-a',
    agentMessages: [],
    activeSessionRunning: false,
    agentError: null,
    agentRunStates: {},
  });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  __clearAgentStreamBuffers();
  vi.useRealTimers();
});

describe('缓冲 flush 节流（250ms）', () => {
  it('delta 只建空占位——content 经 250ms flush 才更新（不进 zustand 的即时写）', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '第一')));
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '第二')));
    // 首条 delta 即建占位（streaming:true，content 空——首正文 delta 前显示三点 loading）。
    expect(useTestStore.getState().agentMessages).toHaveLength(1);
    expect(useTestStore.getState().agentMessages[0]).toMatchObject({ id: 'm1', streaming: true, content: '' });

    // 未到 flush 窗——content 仍空。
    vi.advanceTimersByTime(100);
    expect(useTestStore.getState().agentMessages[0].content).toBe('');

    // flush 窗到——累积正文一次落位（新消息对象）。
    vi.advanceTimersByTime(150);
    expect(useTestStore.getState().agentMessages[0].content).toBe('第一第二');
    expect(useTestStore.getState().agentMessages[0].streaming).toBe(true);
  });

  it('reasoning delta 同缓冲进 reasoning 字段（折叠块数据源）', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '思考A', 'reasoning')));
    vi.advanceTimersByTime(250);
    const msg = useTestStore.getState().agentMessages[0];
    expect(msg.reasoning).toBe('思考A');
    expect(msg.content).toBe('');
  });

  it('终帧清缓冲——flush 计时器停（后续 tick 不再写 store）', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '正文')));
    handleAgentStreamEvent(useTestStore, ev({
      type: 'assistant',
      data: { id: 'm1', content: '正文完整', reasoning: '思考' },
    }));
    const settled = useTestStore.getState().agentMessages[0];
    expect(settled.content).toBe('正文完整');
    // 终帧后无残余计时器写（fake-timer 快进无新对象）。
    vi.advanceTimersByTime(1000);
    expect(useTestStore.getState().agentMessages[0]).toBe(settled);
  });
});

describe('占位创建 → 终帧替换', () => {
  it('终帧 assistant 事件同 id 整条替换占位：streaming:false + reasoning/kind/toolCalls 透传', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '半篇')));
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().agentMessages[0].content).toBe('半篇');

    handleAgentStreamEvent(useTestStore, ev({
      type: 'assistant',
      data: { id: 'm1', content: '全篇正文', toolCalls: [{ id: 'tc1', name: 'present_result', arguments: '{"awaiting_intent_confirmation":true}' }], kind: 'intent_restate', reasoning: '深度思考全文' },
    }));
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1); // 替换非追加（同 id 不重复）
    expect(messages[0]).toMatchObject({
      id: 'm1',
      role: 'assistant',
      content: '全篇正文',
      kind: 'intent_restate',
      reasoning: '深度思考全文',
      streaming: false,
    });
    expect(messages[0].toolCalls).toHaveLength(1);
  });

  it('aborted_partial 终帧（abort 部分落盘）同 id 替换占位', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '已流出部分')));
    handleAgentStreamEvent(useTestStore, ev({
      type: 'assistant',
      data: { id: 'm1', content: '已流出部分', kind: 'aborted_partial', reasoning: '思考' },
    }));
    expect(useTestStore.getState().agentMessages[0]).toMatchObject({
      kind: 'aborted_partial',
      streaming: false,
      reasoning: '思考',
    });
  });

  it('非流式路径零回归：无占位时 assistant 事件照旧 append（含 kind/reasoning）', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'assistant',
      data: { id: 'plain-1', content: '非流式消息', reasoning: 'r' },
    }));
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'plain-1', content: '非流式消息', reasoning: 'r' });
    expect(messages[0].streaming).toBe(false);
  });
});

describe('占位废弃规则（S2 遗留坑：打回丢弃的 response 已流 delta）', () => {
  it('同 session 新 messageId 首条 delta 到达即废弃旧占位', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '被打回的废稿')));
    expect(useTestStore.getState().agentMessages).toHaveLength(1);

    // 打回后重新生成——新 assistantId 的首条 delta 废弃旧占位 + 建新占位。
    handleAgentStreamEvent(useTestStore, ev(delta('m2', '重写')));
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m2');
    expect(messages[0].streaming).toBe(true);
  });

  it('废弃只删 streaming 占位——user/tool 消息不动', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '废稿')));
    vi.advanceTimersByTime(250);
    // 其后穿插正常消息（终帧 + user 回复）。
    handleAgentStreamEvent(useTestStore, ev({ type: 'assistant', data: { id: 'm1', content: '完成' } }));
    handleAgentStreamEvent(useTestStore, ev({ type: 'tool', data: { id: 't1', results: [] } }));

    handleAgentStreamEvent(useTestStore, ev(delta('m9', '新流')));
    const ids = useTestStore.getState().agentMessages.map((m) => m.id);
    // 旧 m1 已被终帧 settle（非 streaming），tool 消息保留——只有 streaming 占位会被废弃规则删。
    expect(ids).toEqual(['m1', 't1', 'm9']);
  });

  it('done 兜底：等不到终帧的残余占位被移除（打回后 run 直接结束）', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '废稿')));
    expect(useTestStore.getState().agentMessages.some((m) => m.streaming)).toBe(true);

    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }));
    expect(useTestStore.getState().agentMessages.some((m) => m.streaming)).toBe(false);
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
  });

  // CR-T1-014：打回废稿占位逃逸补口——重试走非流式降级成功（shell 缝 stream:true 失败回退
  // generateText）→ 无新 delta id，S2「新 messageId delta 废弃旧占位」规则不触发。修后：同
  // session 下一条 assistant 终帧也废弃旧占位（不再滞留到 done/error purge）。
  it('CR-T1-014：打回后重试非流式降级成功（无新 delta）→ 下一条 assistant 终帧一并废弃旧占位', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '被打回的废稿')));
    vi.advanceTimersByTime(250); // 废稿正文已 flush 进占位（用户可见）
    expect(useTestStore.getState().agentMessages.some((m) => m.id === 'm1' && m.streaming)).toBe(true);

    // 重试非流式降级成功：无 m2 的任何 delta 事件，直接新 assistantId 的终帧。
    handleAgentStreamEvent(useTestStore, ev({ type: 'assistant', data: { id: 'm2', content: '重写后的完整回复' } }));

    const messages = useTestStore.getState().agentMessages;
    // 修前：m1 废稿占位滞留（streaming:true 残留到 done/error purge）；修后：随终帧一并废弃。
    expect(messages.map((m) => m.id)).toEqual(['m2']);
    expect(messages[0].streaming).toBe(false);
    expect(messages[0].content).toBe('重写后的完整回复');
  });

  it('error 兜底：残余占位同样清除（错误终态后无终帧）', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '半句')));
    handleAgentStreamEvent(useTestStore, ev({ type: 'error', data: { message: '网关掐了' } }));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
    expect(useTestStore.getState().agentError).toBe('网关掐了');
  });
});

describe('switch 重映射透传 reasoning（折叠块重载会话仍在——透传链第三处）', () => {
  type SliceState = AgentSessionSlice & {
    currentProject: { path?: string } | null;
    activeChapterId: string | null;
    resolvedLocale?: string;
    clearSessionPending: () => void;
    clearPausedReviewFor: () => void;
    clearPendingPatchFor: () => void;
  };

  const useSliceStore = create<SliceState>()((...args) => ({
    currentProject: { path: '/proj-a' },
    activeChapterId: null,
    resolvedLocale: 'zh-CN',
    clearSessionPending: vi.fn(),
    clearPausedReviewFor: vi.fn(),
    clearPendingPatchFor: vi.fn(),
    ...createAgentSessionSlice(...args),
  }));

  it('switchAgentSession 后历史 assistant 消息带 reasoning + kind（折叠块/直出标记不丢）', async () => {
    apiMocks.fetchAgentSession.mockResolvedValueOnce({
      id: 'sess-hist',
      status: 'idle',
      permissionMode: 'suggest',
      behaviorMode: 'normal',
      messages: [
        { id: 'u1', role: 'user', content: '写一段', createdAt: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: '正文',
          reasoning: '深度思考全文',
          kind: 'aborted_partial',
          createdAt: 2,
        },
      ],
    });
    await useSliceStore.getState().switchAgentSession('sess-hist');
    const messages = useSliceStore.getState().agentMessages;
    expect(messages).toHaveLength(2);
    expect(messages[1].reasoning).toBe('深度思考全文');
    expect(messages[1].kind).toBe('aborted_partial');
    // streaming 是内存态——重映射刻意不带（fetch 回的消息无此字段）。
    expect(messages[1].streaming).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood T1 CR 批4：flush 冻结修复（CR-T1-037）+ 流停滞看门狗（CR-T1-038a）
// ════════════════════════════════════════════════════════════════════════════

describe('CR-T1-037 缓冲非空但占位缺失 → flush 重建占位（切走切回/对账替换两形态）', () => {
  it('切回 fetch 整体替换掉占位后，同 messageId 后续 delta 重建占位续流（不再冻结到终帧倾倒）', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '第一段')));
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().agentMessages[0].content).toBe('第一段');

    // 切走再切回：switchAgentSession 的 fetch 用后端权威消息整体替换 agentMessages——
    // 流式占位（未落盘）不在替换结果里。
    useTestStore.setState({ agentMessages: [] });

    // 切回后同 messageId 的后续 delta 到达——旧实现 entry 存在跳过建占位 + flush index===-1
    // 永跳过 → 正文冻结。修复：flush 重建占位（累积全文一次落位）。
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '第二段')));
    vi.advanceTimersByTime(250);
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'm1', role: 'assistant', streaming: true, content: '第一段第二段' });
  });

  it('终帧已落地（同 id 非流式形态）→ 不重建（防重复消息）', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '正文')));
    handleAgentStreamEvent(useTestStore, ev({ type: 'assistant', data: { id: 'm1', content: '终帧' } }));
    expect(useTestStore.getState().agentMessages).toHaveLength(1);

    // 终帧已替换（streaming:false）——即便缓冲残留（理论不达，belt），flush 不重建重复占位。
    vi.advanceTimersByTime(500);
    expect(useTestStore.getState().agentMessages).toHaveLength(1);
    expect(useTestStore.getState().agentMessages[0].content).toBe('终帧');
  });

  it('child 条目（带分组前缀）占位缺失 → 重建时拼回前缀（分组识别不断流）', () => {
    handleAgentStreamEvent(useTestStore, {
      type: 'child',
      sessionId: 'sess-a',
      projectPath: '/proj-a',
      data: {
        source: 'subagent',
        role: 'researcher',
        sessionId: 'child-1',
        depth: 1,
        event: { type: 'delta', data: { messageId: 'mc1', channel: 'text', delta: '子代理正文' } },
      },
    } as never);
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().agentMessages[0].content).toBe('[subagent:researcher] 子代理正文');

    useTestStore.setState({ agentMessages: [] });
    handleAgentStreamEvent(useTestStore, {
      type: 'child',
      sessionId: 'sess-a',
      projectPath: '/proj-a',
      data: {
        source: 'subagent',
        role: 'researcher',
        sessionId: 'child-1',
        depth: 1,
        event: { type: 'delta', data: { messageId: 'mc1', channel: 'text', delta: '续' } },
      },
    } as never);
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().agentMessages[0].content).toBe('[subagent:researcher] 子代理正文续');
  });
});

describe('CR-T1-038a 流停滞看门狗（60s 无新 delta → 占位标 stalled）', () => {
  it('60s 无 delta → flush 置 stalled:true；新 delta 到达 → 下一窗摘标', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '正文开头')));
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().agentMessages[0].stalled).toBeUndefined();

    // 静默断流 60s+（fake-timer 同步推进 Date）——flush 窗标记停滞。
    vi.advanceTimersByTime(60_500);
    expect(useTestStore.getState().agentMessages[0].stalled).toBe(true);
    // 内容不因停滞丢（假活破除≠终态）。
    expect(useTestStore.getState().agentMessages[0].content).toBe('正文开头');

    // 流恢复——新 delta 刷新 lastDeltaAt，下一 flush 窗摘标。
    handleAgentStreamEvent(useTestStore, ev(delta('m1', '恢复续写')));
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().agentMessages[0].stalled).toBeUndefined();
    expect(useTestStore.getState().agentMessages[0].content).toBe('正文开头恢复续写');
  });

  it('持续有 delta（<60s 间隔）不误标停滞', () => {
    handleAgentStreamEvent(useTestStore, ev(delta('m1', 'a')));
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30_000);
      handleAgentStreamEvent(useTestStore, ev(delta('m1', 'b')));
    }
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().agentMessages[0].stalled).toBeUndefined();
  });
});
