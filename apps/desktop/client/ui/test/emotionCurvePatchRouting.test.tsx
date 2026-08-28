/**
 * Story 5.2（BMad CR Edge-1 fix，mirror 6.3 CR-6a infoReleasePatchRouting）：non-auto mode emotion_curve patch UI surfacing。
 *
 * write_chapter 在 non-auto mode 下 Director 产 emotion_curve 目标弧后不调写工具（D8），在 tool result metadata 挂
 * `emotionCurvePatch = {type:'field_patch', field:'emotion_curve', action:'set', data: mergedCurve}`。
 *
 * agentSessionSlice 的 tool-result 路由原本只读 `meta.infoReleasePatch`（6.3）不读 `meta.emotionCurvePatch`
 * → Director emotion plan 不进 PatchReview（non-auto 模式静默丢失）。本测验证新增 emotionCurvePatch 读取分支
 * （agentSessionSlice.ts:459-470）：surface 成 fieldPatchEntry（field='emotion_curve', action='set'）→ setPendingPatch
 * → PatchReviewPanel 可审阅。复用 creativeFieldsSlice.syncField('emotion_curve') 持久化路径。
 *
 * 照 infoReleasePatchRouting.test.tsx 模式（full appStore + stream event emit）。
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

describe('Story 5.2 - write_chapter emotionCurvePatch metadata 路由（non-auto）', () => {
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

  it('write_chapter tool result 带 emotionCurvePatch metadata -> pendingPatch 落 emotion_curve entry（field=set）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-em-1',
          results: [
            {
              toolCallId: 'call_em_1',
              toolName: 'write_chapter',
              output: '已生成情绪目标弧--等待你审阅后落盘。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                chapterId: 'ch_001',
                draftContent: '第一章草稿正文…',
                resumeOptions: ['continue', 'redo', 'abort'],
                emotionCurvePatch: {
                  type: 'field_patch',
                  field: 'emotion_curve',
                  action: 'set',
                  data: {
                    unit: 'scene',
                    points: [
                      {
                        refId: 'sc_1',
                        sceneMood: '压抑',
                        characters: [{ characterId: 'char_main', emotion: '恐惧', emotionEnd: '决心' }],
                      },
                    ],
                    emotional_promises: [],
                    catharsis_points: [],
                  },
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
    expect(pending!.patches).toHaveLength(1);
    const entry = pending!.patches[0];
    expect(entry.field).toBe('emotion_curve');
    expect(entry.action).toBe('set');
    expect(entry.generatedBy).toBe('write_chapter');
    // data 透传（Director mergedCurve）。
    expect((entry.data as { points: unknown[] }).points).toHaveLength(1);
    // fieldVersion = currentVersion(0) + 1（fieldMetadata 无既有 emotion_curve 版本）。
    expect(entry.fieldVersion).toBe(1);
  });

  it('无 emotionCurvePatch metadata -> 不 surface emotion_curve patch（非回归）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-em-2',
          results: [
            {
              toolCallId: 'call_em_2',
              toolName: 'write_chapter',
              output: '完成。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                chapterId: 'ch_001',
                draftContent: '草稿…',
                resumeOptions: ['continue', 'redo', 'abort'],
                // 无 emotionCurvePatch（auto mode Director 已持久化 / 无 Director emotion 产出）。
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    // 无 emotionCurvePatch -> pendingPatch 不落 emotion_curve（auto mode Director 已持久化 / 无产出）。
    const emotionEntry = pending?.patches.find((p) => p.field === 'emotion_curve');
    expect(emotionEntry).toBeUndefined();
  });
});
