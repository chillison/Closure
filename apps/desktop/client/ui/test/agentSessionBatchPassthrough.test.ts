import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  fetchAgentSession: vi.fn(),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import { createAgentSessionSlice, type AgentSessionSlice } from '../src/shared/store/agentSessionSlice';
import { handleAgentStreamEvent, __clearAgentEventTracks } from '../src/shared/store/agentEvents';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 6（3.3 Blind-002 教训延伸）：batchId/batchKind 三条消息重同步路径透传——
// done/cancelAgent 直留 backend 消息（agent 侧已测）；**switchAgentSession 手动重映射最易漏**，
// 此处直测。另测流事件 assistant/tool 的 batchId passthrough（BatchGroup 契约字段数据源）。
// ─────────────────────────────────────────────────────────────────────────────

type TestState = AgentSessionSlice & {
  currentProject: { path?: string } | null;
  activeChapterId: string | null;
  fieldMetadata: Record<string, { version: number } | undefined>;
  // dogfood T1 Stage 3：路由迁 agentEvents dispatcher——测试 store 提供 dispatcher 结构面 stub。
  setPendingToolConfirm: ReturnType<typeof vi.fn>;
  pushPendingDiff: ReturnType<typeof vi.fn>;
  setPausedReview: ReturnType<typeof vi.fn>;
  setPendingPatch: ReturnType<typeof vi.fn>;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  activeChapterId: null,
  fieldMetadata: {},
  setPendingToolConfirm: vi.fn(),
  pushPendingDiff: vi.fn(),
  setPausedReview: vi.fn(),
  setPendingPatch: vi.fn(),
  ...createAgentSessionSlice(...args),
}));

describe('Story 3.5 — batch message fields passthrough（agent panel slice）', () => {
  beforeEach(() => {
    apiMocks.fetchAgentSession.mockReset();
    apiMocks.streamAgentMessage.mockClear();
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
    (globalThis.window as any) = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentSessionId: null,
      agentMessages: [],
      agentSessions: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      pendingAttachments: [],
    });
    __clearAgentEventTracks();
  });

  it('switchAgentSession 手动重映射保留 batchId/batchKind（历史批量消息分组存活）', async () => {
    apiMocks.fetchAgentSession.mockResolvedValue({
      id: 'sess-1',
      status: 'idle',
      permissionMode: 'auto',
      messages: [
        { id: 'm1', role: 'user', content: '批量推进', createdAt: 1 },
        {
          id: 'm2',
          role: 'assistant',
          content: '走向单通报',
          createdAt: 2,
          batchId: 'b-1',
          batchKind: 'progress',
        },
        {
          id: 'm3',
          role: 'tool',
          content: '',
          toolResults: [],
          createdAt: 3,
          batchId: 'b-1',
          batchKind: 'progress',
        },
        {
          id: 'm4',
          role: 'assistant',
          content: 'L0 全景',
          createdAt: 4,
          batchId: 'b-1',
          batchKind: 'report',
        },
      ],
    });

    await useTestStore.getState().switchAgentSession('sess-1');

    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(4);
    // user 消息无批量字段。
    expect(messages[0].batchId).toBeUndefined();
    // assistant progress 消息字段存活。
    expect(messages[1].batchId).toBe('b-1');
    expect(messages[1].batchKind).toBe('progress');
    // tool 消息字段存活。
    expect(messages[2].batchId).toBe('b-1');
    expect(messages[2].batchKind).toBe('progress');
    // report（L0 全景）字段存活。
    expect(messages[3].batchId).toBe('b-1');
    expect(messages[3].batchKind).toBe('report');
  });

  it('旧会话消息（无批量字段）→ 不破（undefined 保持，不分组）', async () => {
    apiMocks.fetchAgentSession.mockResolvedValue({
      id: 'sess-old',
      status: 'idle',
      messages: [{ id: 'm1', role: 'assistant', content: '旧消息', createdAt: 1 }],
    });
    await useTestStore.getState().switchAgentSession('sess-old');
    const messages = useTestStore.getState().agentMessages;
    expect(messages[0].batchId).toBeUndefined();
    expect(messages[0].batchKind).toBeUndefined();
  });

  it('流事件 assistant/tool 的 batchId passthrough 进 agentMessages（BatchGroup 数据源）', async () => {
    // dogfood T1 Stage 3：事件直驱全局分发器（r7——per-invocation 订阅已退役）。
    const emit = (event: any) => {
      handleAgentStreamEvent(useTestStore, {
        ...event,
        sessionId: useTestStore.getState().agentSessionId ?? '',
        projectPath: useTestStore.getState().currentProject?.path,
      });
    };

    // 已有 session（跳过 createAgentSession——本测聚焦事件透传）。
    useTestStore.setState({ agentSessionId: 'sess-1' });
    await useTestStore.getState().sendAgentMessage('批量推进');

    emit({
      type: 'assistant',
      data: { id: 'a1', content: '通报', batchId: 'b-9', batchKind: 'progress' },
    });
    emit({
      type: 'tool',
      data: { id: 't1', results: [], batchId: 'b-9', batchKind: 'progress' },
    });

    const messages = useTestStore.getState().agentMessages;
    const assistant = messages.find((m) => m.id === 'a1');
    const tool = messages.find((m) => m.id === 't1');
    expect(assistant?.batchId).toBe('b-9');
    expect(assistant?.batchKind).toBe('progress');
    expect(tool?.batchId).toBe('b-9');
    expect(tool?.batchKind).toBe('progress');
  });
});
