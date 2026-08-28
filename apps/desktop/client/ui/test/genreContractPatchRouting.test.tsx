/**
 * Story 2.5（mirror 5.2 emotionCurvePatchRouting / 6.3 infoReleasePatchRouting）：
 * genre_contract_update tool result 的 field_patch + worldConstitutionPatch 双 patch UI surfacing。
 *
 * genre_contract_update handler（genreContractHandlers.ts）在 leader 同时提议 creative_brief 字段
 * （genre_tags / commitments）+ world_constitution 时，在同一 metadata 上挂主 field_patch（creative_brief）
 * + 子 worldConstitutionPatch（world_setting）。agentSessionSlice 必须将两者都路由进 PatchReviewPanel。
 *
 * 关键不变式：field_patch 分支的 `continue`（agentSessionSlice.ts:462）不跳过 worldConstitutionPatch
 * 子字段路由——worldConstitutionPatch 路由必须内联于 field_patch 分支内（continue 前）。infoReleasePatch /
 * emotionCurvePatch 不受影响（write_chapter 的 metadata.type='chapter_review' 不进 field_patch 分支）；
 * worldConstitutionPatch 共占 metadata.type='field_patch' 故必须内联于此分支。
 *
 * 照 emotionCurvePatchRouting.test.tsx 模式（full appStore + stream event emit）。
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

describe('Story 2.5 - genre_contract_update field_patch + worldConstitutionPatch 双 patch 路由', () => {
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

  it('genre_contract_update 同时产 creative_brief field_patch + worldConstitutionPatch -> 两 patch 都 surface（不静默丢 world_setting）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('帮我定仙侠题材的规矩');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-gc-1',
          results: [
            {
              toolCallId: 'call_gc_1',
              toolName: 'genre_contract_update',
              output: 'GenreContract update prepared (genre_tags (1), commitments (1), world_constitution (1)).',
              metadata: {
                type: 'field_patch',
                field: 'creative_brief',
                action: 'set',
                data: {
                  rawRequirement: '写一部仙侠',
                  genre_tags: ['仙侠'],
                  commitments: [{ type: 'HE', content: '大团圆结局' }],
                },
                worldConstitutionPatch: {
                  type: 'field_patch',
                  field: 'world_setting',
                  action: 'set',
                  data: {
                    premise: '修真界',
                    world_constitution: ['无现代科技'],
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
    expect(pending!.patches).toHaveLength(2);

    const cbEntry = pending!.patches.find((p) => p.field === 'creative_brief');
    expect(cbEntry).toBeDefined();
    expect(cbEntry!.action).toBe('set');
    expect(cbEntry!.generatedBy).toBe('genre_contract_update');
    expect(cbEntry!.fieldVersion).toBe(1);
    expect((cbEntry!.data as { genre_tags: string[] }).genre_tags).toEqual(['仙侠']);

    // 关键断言：world_setting patch 不被 field_patch 分支的 continue 静默丢弃。
    const wsEntry = pending!.patches.find((p) => p.field === 'world_setting');
    expect(wsEntry).toBeDefined();
    expect(wsEntry!.action).toBe('set');
    expect(wsEntry!.generatedBy).toBe('genre_contract_update');
    expect(wsEntry!.fieldVersion).toBe(1);
    expect((wsEntry!.data as { world_constitution: string[] }).world_constitution).toEqual(['无现代科技']);
  });

  it('genre_contract_update 仅产 creative_brief field_patch（无 world_constitution）-> 只 surface creative_brief', async () => {
    const sending = useAppStore.getState().sendAgentMessage('帮我加题材标签');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-gc-2',
          results: [
            {
              toolCallId: 'call_gc_2',
              toolName: 'genre_contract_update',
              output: 'GenreContract update prepared (genre_tags (1)).',
              metadata: {
                type: 'field_patch',
                field: 'creative_brief',
                action: 'set',
                data: {
                  rawRequirement: '写一部仙侠',
                  genre_tags: ['仙侠'],
                },
                // 无 worldConstitutionPatch。
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
    expect(pending!.patches[0].field).toBe('creative_brief');
    // 无 world_setting patch。
    const wsEntry = pending!.patches.find((p) => p.field === 'world_setting');
    expect(wsEntry).toBeUndefined();
  });

  it('genre_contract_update 仅产 world_setting field_patch（无 creative_brief 字段）-> 只 surface world_setting', async () => {
    const sending = useAppStore.getState().sendAgentMessage('帮我定世界规则');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-gc-3',
          results: [
            {
              toolCallId: 'call_gc_3',
              toolName: 'genre_contract_update',
              output: 'GenreContract update prepared (world_constitution (1)).',
              metadata: {
                type: 'field_patch',
                field: 'world_setting',
                action: 'set',
                data: {
                  premise: '修真界',
                  world_constitution: ['无现代科技'],
                },
                // 无 worldConstitutionPatch 子字段（主 field_patch 就是 world_setting）。
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
    expect(pending!.patches[0].field).toBe('world_setting');
    // 无 creative_brief patch。
    const cbEntry = pending!.patches.find((p) => p.field === 'creative_brief');
    expect(cbEntry).toBeUndefined();
  });

  // BMad CR-007：write_chapter chapter_accept 路径产 metadata.type='field_patch'（field='chapter_candidate'）
  // + 无条件挂 infoReleasePatch / emotionCurvePatch（write-chapter.ts:985-1042）。agentSessionSlice field_patch
  // 分支的 continue 原会静默丢这两个 sub-patch（pre-existing bug，CR-007 顺带修——移进 field_patch 分支内）。
  // paused 路径（chapter_review）走独立块不受影响（既有 infoReleasePatchRouting.test 覆盖）。
  it('BMad CR-007：write_chapter chapter_accept（field_patch）+ infoReleasePatch + emotionCurvePatch -> 三 patch 都 surface（不静默丢）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('写第一章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-gc-4',
          results: [
            {
              toolCallId: 'call_wc_accept',
              toolName: 'write_chapter',
              output: '已生成章节候选（chapter 1），等待落盘。',
              metadata: {
                type: 'field_patch',
                field: 'chapter_candidate',
                action: 'set',
                data: { chapterId: 'ch1', runId: 'r1', candidate: { text: '...' } },
                infoReleasePatch: {
                  type: 'field_patch',
                  field: 'info_release_map',
                  action: 'set',
                  data: { entries: [{ id: 'e1' }] },
                },
                emotionCurvePatch: {
                  type: 'field_patch',
                  field: 'emotion_curve',
                  action: 'set',
                  data: { points: [{ refId: 's1' }] },
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
    // chapter_candidate + info_release_map + emotion_curve 三 patch 都在（CR-007：continue 不再丢 sub-patch）。
    const fields = pending!.patches.map((p) => p.field).sort();
    expect(fields).toEqual(['chapter_candidate', 'emotion_curve', 'info_release_map']);
  });
});
