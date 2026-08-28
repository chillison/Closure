/**
 * Story 2.6 CR-B01/A01（BMad CR）：story_decisions_update envelope 捕获层测试。
 *
 * 盲区补齐：storyDecisionPatch.test.ts 从「已含 story_decisions patch 的 pendingPatch」起测
 * creativeFieldsSlice 持久化路由，从未覆盖 envelope 捕获层（agentSessionSlice results 循环的
 * WRITE_TOOLS toolId 门 → 泛化 field_patch 路由 → setPendingPatch）。suggest 档（缺省档）leader
 * 调 story_decisions_update 的主路径依赖此层——WRITE_TOOLS 漏登该工具时整条 result 被静默丢弃，
 * PatchReview 卡永不出现。
 *
 * 照 genreContractPatchRouting.test.tsx 模式（full appStore + stream event emit）。
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

describe('Story 2.6 CR-B01 - story_decisions_update envelope 捕获（suggest 档主路径）', () => {
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

  it('leader 调 story_decisions_update（suggest 档 field_patch envelope）-> pendingPatch surface（WRITE_TOOLS 门放行）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('把女主背叛线登记为 open 决策');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-sd-1',
          results: [
            {
              toolCallId: 'call_sd_1',
              toolName: 'story_decisions_update',
              output: '创作决策登记已准备（register d1）。等待你在工作台 patch 面板审阅后落盘。',
              metadata: {
                type: 'field_patch',
                field: 'story_decisions',
                action: 'set',
                data: {
                  actions: [
                    {
                      op: 'register',
                      decision: { id: 'd1', summary: '女主真背叛', reason: '妹妹被挟持', risk: '铺垫不足弃书', status: 'open', source: 'user' },
                    },
                  ],
                },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    // WRITE_TOOLS 漏登时 :632 toolId 门 continue 整条 result——pendingPatch 恒 null（CR-B01 断链形态）。
    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    expect(pending!.patches).toHaveLength(1);
    const entry = pending!.patches[0];
    expect(entry.field).toBe('story_decisions');
    expect(entry.action).toBe('set');
    expect(entry.generatedBy).toBe('story_decisions_update');
    expect((entry.data as { actions: Array<{ op: string }> }).actions).toHaveLength(1);
  });
});
