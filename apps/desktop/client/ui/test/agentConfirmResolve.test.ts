/**
 * dogfood T1 CR-T1-028：confirmPendingTool / rejectPendingTool 乐观态翻转后的
 * resolveAgentConfirmation 失败回滚。
 *
 * 现实触发：确认卡过期（run 已 abort/收尾，permission.resolvePending 对缺失 pending 抛
 * `pending confirmation "callId" not found`——agent 包 permission.ts:102-104）。旧实现
 * `void resolveAgentConfirmation(...)` 无 catch → run 态停在 running + 视图 spinner 永卡。
 *
 * 期望：.catch 回滚 run 态 running→idle + 视图 loading 翻 false + toast 提示（i18n）。
 * 测试照 ui/testing.md seam-mock 约定：真 agentDiffSlice + vi.mock shared/api/agent。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const apiMocks = vi.hoisted(() => ({
  resolveAgentConfirmation: vi.fn(async () => ({}) ),
}));
vi.mock('../src/shared/api/agent', () => apiMocks);

import { createAgentDiffSlice, type AgentDiffSlice } from '../src/shared/store/agentDiffSlice';
import { useToastStore } from '../src/shared/store/toastStore';

type RunState = { sessionId: string; phase: string; updatedAt: number };

type TestState = AgentDiffSlice & {
  agentSessionId: string | null;
  activeSessionRunning: boolean;
  resolvedLocale: string;
  agentRunStates: Record<string, RunState>;
  setAgentRunState: (sessionId: string, patch: { phase?: 'running' | 'idle' | 'error' }) => void;
};

const useTestStore = create<TestState>()((set, ...a) => ({
  ...createAgentDiffSlice(...([set, ...a] as unknown as Parameters<typeof createAgentDiffSlice>)),
  agentSessionId: 'sess-a',
  activeSessionRunning: false,
  resolvedLocale: 'zh-CN',
  agentRunStates: {},
  setAgentRunState: (sessionId, patch) => set((s) => ({
    agentRunStates: { ...s.agentRunStates, [sessionId]: { sessionId, phase: patch.phase ?? 'idle', updatedAt: Date.now() } },
  })),
}));

beforeEach(() => {
  apiMocks.resolveAgentConfirmation.mockReset();
  apiMocks.resolveAgentConfirmation.mockResolvedValue({});
  useToastStore.setState({ toasts: [] });
  useTestStore.setState({
    pendingToolConfirmBySession: {},
    agentSessionId: 'sess-a',
    activeSessionRunning: false,
    agentRunStates: {},
  });
});

describe('CR-T1-028 确认/拒绝 resolve 失败回滚', () => {
  it('resolve throw（确认过期）→ 回滚 run 态 idle + 视图 spinner false + toast 提示', async () => {
    useTestStore.getState().setPendingToolConfirm('sess-a', { callId: 'call-1', name: 'write_file', input: {} });
    apiMocks.resolveAgentConfirmation.mockRejectedValueOnce(
      new Error('pending confirmation "call-1" not found for session "sess-a"'),
    );
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    useTestStore.getState().confirmPendingTool('sess-a');

    // 乐观翻转先行（run 续跑 + spinner）。
    expect(useTestStore.getState().activeSessionRunning).toBe(true);
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('running');

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    // 回滚：run 态 idle + spinner false（双永卡防线）。
    expect(useTestStore.getState().activeSessionRunning).toBe(false);
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('idle');
    // 卡已清（不再渲染过期确认卡）。
    expect(useTestStore.getState().pendingToolConfirmBySession['sess-a']).toBeUndefined();
    showToast.mockRestore();
  });

  it('rejectPendingTool 同款回滚（拒绝路径也走 resolve IPC）', async () => {
    useTestStore.getState().setPendingToolConfirm('sess-a', { callId: 'call-2', name: 'write_file', input: {} });
    apiMocks.resolveAgentConfirmation.mockRejectedValueOnce(new Error('connection reset'));
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    useTestStore.getState().rejectPendingTool('sess-a');

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(useTestStore.getState().activeSessionRunning).toBe(false);
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('idle');
    showToast.mockRestore();
  });

  it('resolve 成功 → 不回滚（run 态保持 running 至事件面接管）', async () => {
    useTestStore.getState().setPendingToolConfirm('sess-a', { callId: 'call-3', name: 'write_file', input: {} });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    useTestStore.getState().confirmPendingTool('sess-a');
    await Promise.resolve();
    await Promise.resolve();

    expect(apiMocks.resolveAgentConfirmation).toHaveBeenCalledWith('sess-a', 'call-3', true);
    expect(showToast).not.toHaveBeenCalled();
    expect(useTestStore.getState().activeSessionRunning).toBe(true);
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('running');
    showToast.mockRestore();
  });
});
