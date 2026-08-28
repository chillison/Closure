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
import { handleAgentStreamEvent, __clearAgentEventTracks, rememberSessionMode, rememberSessionProject } from '../src/shared/store/agentEvents';

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.2 WP-E（check 补）：write_chapter metadata.storySyncPatches 的双路由——
// 2.5 CR-007 同型防线（field_patch 分支内 continue 前路由 + 非 field_patch 独立块路由，
// metadata.type 互斥故两块互补无重复）。缺测时 continue 提前/块删任一回归 = story-sync
// 反哺 envelope 静默丢失（PatchReview 永不出现）。
// ─────────────────────────────────────────────────────────────────────────────

type TestState = AgentSessionSlice & {
  currentProject: { path?: string } | null;
  activeChapterId: string | null;
  fieldMetadata: Record<string, { version: number } | undefined>;
  // dogfood T1 Stage 3：路由迁 agentEvents dispatcher——mock 声面保持（断言 setPendingPatch 载荷）。
  setPendingToolConfirm: ReturnType<typeof vi.fn>;
  pushPendingDiff: ReturnType<typeof vi.fn>;
  setPausedReview: ReturnType<typeof vi.fn>;
  setPendingPatch: ReturnType<typeof vi.fn>;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  activeChapterId: null,
  pendingDiffsBySession: {},
  pendingToolConfirmBySession: {},
  pendingPassageResolveBySession: {},
  fieldMetadata: {
    world_setting: { version: 7 },
    asset_cards: { version: 2 },
  },
  setPendingPatch: vi.fn(),
  setPausedReview: vi.fn(),
  ...createAgentSessionSlice(...args),
}));

const ENVELOPES = [
  { type: 'field_patch', field: 'world_setting', action: 'set', data: { premise: '灵气复苏（修订）' }, fieldVersion: 8, note: '第 7 章 story-sync 提取' },
  { type: 'field_patch', field: 'asset_cards', action: 'set', data: [], fieldVersion: 3 },
];

describe('Story 2.2 WP-E — storySyncPatches 双路由（agentSessionSlice）', () => {

  beforeEach(() => {
    apiMocks.streamAgentMessage.mockClear();
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
    __clearAgentEventTracks();
    (globalThis.window as any) = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
    useTestStore.getState().setPendingPatch.mockClear();
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentMode: 'suggest',
      agentSessionId: 'sess-1',
      agentMessages: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      pendingDiffsBySession: {},
      pendingToolConfirmBySession: {},
      pendingAttachments: [],
    } as any);
  });

  async function emitToolEvent(results: unknown[], mode: 'suggest' | 'readonly' = 'suggest'): Promise<void> {
    // dispatcher 直驱（r7）：发送捕获 mode/project 归属（agentSessionSlice send 时记录）。
    await useTestStore.getState().sendAgentMessage('写一章');
    const sid = useTestStore.getState().agentSessionId;
    expect(sid).not.toBeNull();
    rememberSessionMode(sid!, mode);
    rememberSessionProject(sid!, useTestStore.getState().currentProject?.path);
    handleAgentStreamEvent(useTestStore, {
      type: 'tool',
      data: { id: 't1', results },
      sessionId: sid!,
      projectPath: useTestStore.getState().currentProject?.path,
    });
  }

  it('chapter_accept 路径（metadata.type=field_patch + storySyncPatches 共占）→ 主 patch 与 envelope 组都路由（continue 前，不静默丢）', async () => {
    await emitToolEvent([
      {
        toolCallId: 'c1',
        toolName: 'write_chapter',
        output: 'ok',
        metadata: {
          type: 'field_patch',
          field: 'chapter_candidate',
          action: 'set',
          data: { chapterId: 'ch_7', runId: 'run_1', candidate: { title: 't', content: 'c', wordCount: 2 } },
          storySyncPatches: ENVELOPES,
        },
      },
    ]);

    expect(useTestStore.getState().setPendingPatch).toHaveBeenCalledTimes(1);
    const payload = useTestStore.getState().setPendingPatch.mock.calls[0][1] as {
      patches: Array<{ field: string; action: string; generatedBy: string; fieldVersion: number }>;
    };
    // 主 chapter_candidate patch + 2 条 story-sync envelope 全部在场。
    expect(payload.patches.map((p) => p.field)).toEqual(['chapter_candidate', 'world_setting', 'asset_cards']);
    const [ws, cards] = [payload.patches[1], payload.patches[2]];
    expect(ws.generatedBy).toBe('story-sync-agent');
    expect(ws.action).toBe('set');
    // envelope 携带的有效版本号（diskVersion+1）优先于 store 当前版本+1（7+1=8 恰同——asset_cards 用 3 区分）。
    expect(cards.fieldVersion).toBe(3);
    expect(cards.generatedBy).toBe('story-sync-agent');
  });

  it('非 chapter_accept 路径（metadata 无 field_patch type，如超 cap 强制人审）→ 独立块路由 envelope 组', async () => {
    await emitToolEvent([
      {
        toolCallId: 'c2',
        toolName: 'write_chapter',
        output: '正文反哺：已生成 2 个字段补丁',
        metadata: { storySyncPatches: ENVELOPES },
      },
    ]);

    expect(useTestStore.getState().setPendingPatch).toHaveBeenCalledTimes(1);
    const payload = useTestStore.getState().setPendingPatch.mock.calls[0][1] as {
      patches: Array<{ field: string; generatedBy: string; fieldVersion?: number }>;
    };
    expect(payload.patches.map((p) => p.field)).toEqual(['world_setting', 'asset_cards']);
    expect(payload.patches.every((p) => p.generatedBy === 'story-sync-agent')).toBe(true);
    // envelope fieldVersion 有效则用之（world_setting 8），缺省回退 store 当前 +1。
    expect(payload.patches[0].fieldVersion).toBe(8);
  });

  it('envelope 缺 fieldVersion → 回退 store 当前版本 +1', async () => {
    await emitToolEvent([
      {
        toolCallId: 'c3',
        toolName: 'write_chapter',
        output: 'ok',
        metadata: {
          storySyncPatches: [{ type: 'field_patch', field: 'asset_cards', action: 'set', data: [] }],
        },
      },
    ]);
    const payload = useTestStore.getState().setPendingPatch.mock.calls[0][1] as {
      patches: Array<{ field: string; fieldVersion?: number }>;
    };
    // store asset_cards version 2 + 1 = 3。
    expect(payload.patches[0].fieldVersion).toBe(3);
  });

  it('畸形 envelope（field 非 string）→ 单条跳过不破组', async () => {
    await emitToolEvent([
      {
        toolCallId: 'c4',
        toolName: 'write_chapter',
        output: 'ok',
        metadata: {
          storySyncPatches: [
            { type: 'field_patch', field: 42, action: 'set', data: {} },
            { type: 'field_patch', field: 'world_setting', action: 'set', data: { premise: 'x' }, fieldVersion: 8 },
          ],
        },
      },
    ]);
    const payload = useTestStore.getState().setPendingPatch.mock.calls[0][1] as {
      patches: Array<{ field: string }>;
    };
    expect(payload.patches.map((p) => p.field)).toEqual(['world_setting']);
  });

  it('readonly 模式 → 不路由（write gate 整体跳过，leader 文字建议形态）', async () => {
    await emitToolEvent([
      {
        toolCallId: 'c5',
        toolName: 'write_chapter',
        output: '只读建议',
        metadata: { storySyncPatches: ENVELOPES },
      },
    ], 'readonly');
    expect(useTestStore.getState().setPendingPatch).not.toHaveBeenCalled();
  });
});
