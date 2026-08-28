/**
 * Story 8.5（B01 三处同步 checklist 测试断言点）：arc-pipeline 写工具 envelope 捕获层测试。
 *
 * mirror arcLedgerEnvelopeRouting.test.tsx（Story 8.2 B01 形态，源 2.6 CR-B01 盲区补齐）——
 * suggest 档（缺省档）leader 调 growth_curve_update / pacing_curve_update / episode_outlines_update
 * 的主路径依赖 agentSessionSlice results 循环的 WRITE_TOOLS toolId 门 → 泛化 field_patch 路由 →
 * setPendingPatch。WRITE_TOOLS 漏登任一工具时该 tool result 被静默丢弃，PatchReview 卡永不出现。
 * 末例锚定 emotion_curve_update（5.2 B01 追补件：handler 已存在但注册面 8.5 才补齐——追补的
 * WRITE_TOOLS 门同样须有捕获层测试，正是 5.2 的盲区形态）。
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

describe('Story 8.5 B01 - arc-pipeline 三工具 envelope 捕获（suggest 档主路径）', () => {
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

  it('leader 调 growth_curve_update（field_patch field=growth_curve）-> pendingPatch surface', async () => {
    const sending = useAppStore.getState().sendAgentMessage('给林昭设计成长弧');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-gc-1',
          results: [
            {
              toolCallId: 'call_gc_1',
              toolName: 'growth_curve_update',
              output: 'Growth-curve update prepared (1 curve(s) after projection). Awaiting user review in the patch panel.',
              metadata: {
                type: 'field_patch',
                field: 'growth_curve',
                action: 'set',
                data: [
                  {
                    character_id: 'char-lin',
                    start_state: '封闭自保',
                    desire: '查清真相',
                    turning_points: [{ turning_point: '审判日作证', linked_episode_ids: ['ep-10'] }],
                    regressions: [],
                    linked_episode_ids: [],
                  },
                ],
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    expect(pending!.patches).toHaveLength(1);
    const entry = pending!.patches[0];
    expect(entry.field).toBe('growth_curve');
    expect(entry.action).toBe('set');
    expect(entry.generatedBy).toBe('growth_curve_update');
    expect((entry.data as Array<{ character_id: string }>)[0].character_id).toBe('char-lin');
  });

  it('leader 调 pacing_curve_update（field_patch field=pacing_curve）-> pendingPatch surface', async () => {
    const sending = useAppStore.getState().sendAgentMessage('给审判日一集标节奏强度');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-pc-1',
          results: [
            {
              toolCallId: 'call_pc_1',
              toolName: 'pacing_curve_update',
              output: 'Pacing-curve update prepared (2 point(s) after projection). Awaiting user review in the patch panel.',
              metadata: {
                type: 'field_patch',
                field: 'pacing_curve',
                action: 'set',
                data: {
                  unit: 'episode',
                  points: [
                    { refId: 'ep-3', intensity: 9 },
                    { refId: 'ep-4', intensity: 2 },
                  ],
                  risks: [],
                },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    const entry = pending!.patches[0];
    expect(entry.field).toBe('pacing_curve');
    expect(entry.generatedBy).toBe('pacing_curve_update');
    expect((entry.data as { points: unknown[] }).points).toHaveLength(2);
  });

  it('leader 调 episode_outlines_update（field_patch field=episode_outlines）-> pendingPatch surface', async () => {
    const sending = useAppStore.getState().sendAgentMessage('排第一卷的集纲');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-eo-1',
          results: [
            {
              toolCallId: 'call_eo_1',
              toolName: 'episode_outlines_update',
              output: 'Episode-outlines update prepared (1 episode(s) after projection). Awaiting user review in the patch panel.',
              metadata: {
                type: 'field_patch',
                field: 'episode_outlines',
                action: 'set',
                data: [
                  {
                    id: 'ep-10',
                    index: 10,
                    title: '审判日',
                    phase_ref: 'phase-1',
                    status: 'planned',
                  },
                ],
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    const entry = pending!.patches[0];
    expect(entry.field).toBe('episode_outlines');
    expect(entry.generatedBy).toBe('episode_outlines_update');
    expect((entry.data as Array<{ phase_ref: string }>)[0].phase_ref).toBe('phase-1');
  });

  it('leader 调 emotion_curve_update（field_patch field=emotion_curve）-> pendingPatch surface（5.2 B01 追补件）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('给第一场定目标情绪');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-ec-1',
          results: [
            {
              toolCallId: 'call_ec_1',
              toolName: 'emotion_curve_update',
              output: 'EmotionCurve update prepared (1 point(s) after projection). Awaiting user review in the patch panel.',
              metadata: {
                type: 'field_patch',
                field: 'emotion_curve',
                action: 'set',
                data: {
                  unit: 'scene',
                  points: [
                    { refId: 'scene-1', sceneMood: '压抑紧绷', characters: [] },
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

    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    const entry = pending!.patches[0];
    expect(entry.field).toBe('emotion_curve');
    expect(entry.generatedBy).toBe('emotion_curve_update');
    expect((entry.data as { points: unknown[] }).points).toHaveLength(1);
  });
});
