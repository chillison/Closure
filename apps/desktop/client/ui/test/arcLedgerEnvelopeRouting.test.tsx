/**
 * Story 8.2（B01 三处同步 checklist 测试断言点）：arc_ledger_update envelope 捕获层测试。
 *
 * mirror storyDecisionEnvelopeRouting.test.tsx（Story 2.6 CR-B01 盲区补齐形态）——suggest 档（缺省档）
 * leader 调 arc_ledger_update 的主路径依赖 agentSessionSlice results 循环的 WRITE_TOOLS toolId 门 →
 * 泛化 field_patch 路由 → setPendingPatch。WRITE_TOOLS 漏登该工具时整条 result 被静默丢弃，
 * PatchReview 卡永不出现（2.6 B01 CRITICAL 同一断链形态）。
 */
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(async () => ({ id: 'session-1', messages: [] })),
  fetchAgentSession: vi.fn(),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(async () => []),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import { useAppStore } from '../src/shared/store/appStore';
import { handleAgentStreamEvent, __clearAgentEventTracks } from '../src/shared/store/agentEvents';
import type { AgentStreamEvent } from '../src/shared/api/agent';

describe('Story 8.2 B01 - arc_ledger_update envelope 捕获（suggest 档主路径）', () => {
  const emitStreamEvent = (event: AgentStreamEvent): void => {
  // dogfood T1 Stage 3：路由测试直驱全局分发器（事件带 sessionId+projectPath 进活跃分支）。
  const s = useAppStore.getState();
  handleAgentStreamEvent(useAppStore, {
    ...event,
    sessionId: s.agentSessionId ?? '',
    projectPath: s.currentProject?.path,
  });
};

  beforeEach(() => {
    __clearAgentEventTracks();
    apiMocks.streamAgentMessage.mockReset();
    apiMocks.createAgentSession.mockReset();
    apiMocks.createAgentSession.mockResolvedValue({ id: 'session-1', messages: [] });
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
    (globalThis as any).window = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };

    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'P', path: '/proj', type: 'novel' },
      agentSessionId: null,
      agentMessages: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      agentMode: 'suggest',
      pendingPatchBySession: {},
                  fieldMetadata: {},
      pausedReviewBySession: {},
      reviewResuming: false,
      resolvedLocale: 'zh-CN',
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('leader 调 arc_ledger_update（suggest 档 field_patch envelope field=arc_registry）-> pendingPatch surface（WRITE_TOOLS 门放行）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('把第一卷弧登记为本章闭合');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-arc-1',
          results: [
            {
              toolCallId: 'call_arc_1',
              toolName: 'arc_ledger_update',
              output: 'Arc ledger update prepared (2 beat(s) after projection). Awaiting user review in the patch panel.',
              metadata: {
                type: 'field_patch',
                field: 'arc_registry',
                action: 'set',
                data: {
                  beats: [
                    { id: 'phase-1::ep2::close', episodeId: 'ep2', episodeIndex: 1, arcRef: 'phase-1', arcKind: 'volume', action: 'close', grounding: '城门在他身后轰然关闭。' },
                  ],
                  version: 0,
                  updatedBy: 'agent',
                },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    // WRITE_TOOLS 漏登时 toolId 门 continue 整条 result——pendingPatch 恒 null（CR-B01 断链形态）。
    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    expect(pending!.patches).toHaveLength(1);
    const entry = pending!.patches[0];
    expect(entry.field).toBe('arc_registry');
    expect(entry.action).toBe('set');
    expect(entry.generatedBy).toBe('arc_ledger_update');
    expect((entry.data as { beats: Array<{ arcRef: string; action: string }> }).beats).toHaveLength(1);
    expect((entry.data as { beats: Array<{ arcRef: string }> }).beats[0].arcRef).toBe('phase-1');
  });
});
