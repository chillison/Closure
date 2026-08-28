/**
 * dogfood R2 #30：工具参数流指示——「正文输出毕、tool-call 参数仍在流」的静默窗
 * （该窗流式标志压着全局三点 loading，旧态零信号，用户分不清卡死还是网络）。
 * 覆盖：leader/child 两路 tool delta 首块标 streamingToolName（参数 delta 不写 store、
 * 不污染 text/reasoning 缓冲）+ 终帧替换后标记消失 + 组件徽章渲染（工具名经 toolLabel
 * 词表翻译）。
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentStreamEvent, AgentMessage } from '../src/shared/api/agent';
import { handleAgentStreamEvent, __clearAgentEventTracks, type AgentStreamWireEvent } from '../src/shared/store/agentEvents';
import { __clearAgentStreamBuffers, setStreamFlushIntervalMs } from '../src/shared/store/agentStreamBuffer';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { useAppStore } from '../src/shared/store/appStore';

const apiMocks = vi.hoisted(() => ({
  fetchAgentSession: vi.fn(async () => ({ id: 'sess-a', status: 'idle', messages: [] })),
}));

vi.mock('../src/shared/api/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/shared/api/agent')>();
  return { ...original, ...apiMocks };
});

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
  __clearAgentEventTracks();
  setStreamFlushIntervalMs(250);
  useAppStore.setState({ resolvedLocale: 'zh-CN', activeSessionRunning: false, agentSessionId: 'session-1' } as never);
  useTestStore.setState({
    agentSessionId: 'sess-a',
    agentMessages: [],
    activeSessionRunning: false,
    agentError: null,
    agentRunStates: {},
    chainRunBySession: {},
  });
});

afterEach(() => {
  __clearAgentStreamBuffers();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('tool 通道缓冲（R2 #30）', () => {
  it('正文流后 tool 首块标 streamingToolName；参数 delta 不污染 text/reasoning、不重复写 store', async () => {
    vi.useFakeTimers();
    // 正文流 → 占位建立。
    handleAgentStreamEvent(useTestStore, ev({ type: 'delta', data: { messageId: 'm1', channel: 'text', delta: '汇报正文' } }));
    // tool 首块（带工具名）→ 标记立即写上（不等 flush 窗）。
    handleAgentStreamEvent(useTestStore, ev({ type: 'delta', data: { messageId: 'm1', channel: 'tool', delta: '', toolName: 'outline_update' } }));
    let m = useTestStore.getState().agentMessages[0];
    expect(m.streamingToolName).toBe('outline_update');
    // 参数 delta 逐块到达——content/reasoning 不受污染。
    handleAgentStreamEvent(useTestStore, ev({ type: 'delta', data: { messageId: 'm1', channel: 'tool', delta: '{"patches":' } }));
    vi.advanceTimersByTime(250);
    m = useTestStore.getState().agentMessages[0];
    expect(m.content).toBe('汇报正文');
    expect(m.reasoning).toBeUndefined();
    expect(m.streamingToolName).toBe('outline_update'); // flush 重建不丢标记
    // 终帧替换整条消息 → 标记消失。
    handleAgentStreamEvent(useTestStore, ev({
      type: 'assistant',
      data: { id: 'm1', content: '汇报正文', toolCalls: [{ id: 'c1', name: 'outline_update', arguments: '{}' }] },
    }));
    m = useTestStore.getState().agentMessages[0];
    expect(m.streamingToolName).toBeUndefined();
    expect(m.streaming).not.toBe(true);
  });

  it('child 路 tool delta 同样标记（组内子代理消息渲染同一指示）', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'child',
      data: {
        source: 'subagent',
        role: 'researcher-agent',
        sessionId: 'child-1',
        depth: 1,
        event: { type: 'delta', data: { messageId: 'cm1', channel: 'tool', delta: '', toolName: 'wiki_search' } },
      },
    }));
    const m = useTestStore.getState().agentMessages[0];
    expect(m?.streamingToolName).toBe('wiki_search');
  });
});

describe('徽章渲染（R2 #30）', () => {
  it('流式消息带 streamingToolName → 「正在准备工具调用：更新大纲」（toolLabel 词表翻译）；终帧后消失', () => {
    const streaming = { id: 'a1', role: 'assistant' as const, content: '汇报正文', streaming: true, streamingToolName: 'outline_update', createdAt: 1 };
    const { container, rerender } = render(<AgentMessages messages={[streaming]} loading={true} error={null} />);
    const badge = container.querySelector('.agent-tool-call-badge--live');
    expect(badge?.textContent).toContain('正在准备工具调用：更新大纲');
    // 终帧（无标记非流式）→ 徽章消失。
    rerender(<AgentMessages
      messages={[{ id: 'a1', role: 'assistant' as const, content: '汇报正文', createdAt: 1 }]}
      loading={false}
      error={null}
    />);
    expect(container.querySelector('.agent-tool-call-badge--live')).toBeNull();
  });

  it('词表外工具回落原文 id', () => {
    const streaming = { id: 'a1', role: 'assistant' as const, content: '', streaming: true, streamingToolName: 'some_unknown_tool', createdAt: 1 };
    const { container } = render(<AgentMessages messages={[streaming]} loading={true} error={null} />);
    expect(container.querySelector('.agent-tool-call-badge--live')?.textContent).toContain('some_unknown_tool');
  });
});
