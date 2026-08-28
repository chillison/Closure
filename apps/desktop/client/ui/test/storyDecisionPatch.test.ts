/**
 * Story 2.6：story_decisions patch 持久化路由（mirror chapterCandidatePatch.test.ts）。
 *
 * applySelectedPatches 必须把 story_decisions patches 路由到 applyAgentFieldPatch IPC
 * （→ applyFieldPatches story_decisions 分支 → applyDecisionActions 重放守卫 → 写
 * novel.story_decisions + meta bump），而非 syncField（field:sync 收窄 CreativeFieldKey 会
 * parse('story_decisions') 抛错）也不进 creativeFields mutation（novel 段非 creative field）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { createCreativeFieldsSlice, type CreativeFieldsSlice } from '../src/shared/store/creativeFieldsSlice';
import { createProjectSlice, type ProjectSlice } from '../src/shared/store/projectSlice';
import type { ProjectFieldPatch } from '@orison/shared-contracts';

declare global {
  interface Window {
    orisonDesktop: any;
  }
}

type TestState = CreativeFieldsSlice &
  ProjectSlice & {
    saveProject: () => Promise<void>;
    resolvedLocale: string;
  };

const SESS = 'sess-cf';

const useTestStore = create<TestState>()((...a) => ({
  ...createProjectSlice(...a),
  ...createCreativeFieldsSlice(...a),
  agentSessionId: SESS,
  resolvedLocale: 'en-US',
}));

// dogfood T1 Stage 3（r8 键控）：selections 在 per-session entry 内——测试直改 entry。
function selectPatches(selections: Record<string, boolean>) {
  const s = useTestStore.getState();
  const entry = s.pendingPatchBySession[SESS];
  if (!entry) throw new Error('no pending patch entry');
  useTestStore.setState({ pendingPatchBySession: { ...s.pendingPatchBySession, [SESS]: { ...entry, selections } } });
}


function makeStoryDecisionsPatch(): ProjectFieldPatch {
  return {
    runId: 'run-sd-1',
    createdAt: '2026-08-16T00:00:00Z',
    patches: [
      {
        field: 'story_decisions' as any,
        action: 'set',
        data: {
          actions: [
            {
              op: 'register',
              decision: { id: 'd1', summary: '女主真背叛', reason: '妹妹被挟持', risk: '铺垫不足弃书', status: 'open', source: 'user' },
            },
          ],
        },
        fieldVersion: 1,
        generatedBy: 'story_decisions_update',
      },
    ],
  };
}

beforeEach(() => {
  useTestStore.setState({
    pendingPatchBySession: {},
            creativeFields: {},
    fieldMetadata: {},
    currentProject: { path: '/proj', name: 'P' } as any,
    agentSessionId: SESS,
    resolvedLocale: 'en-US',
  });
  (globalThis as any).window = globalThis as any;
  (window as any).orisonDesktop = {
    syncField: vi.fn().mockResolvedValue(undefined),
    applyAgentFieldPatch: vi.fn().mockResolvedValue(undefined),
  };
});

describe('applySelectedPatches — story_decisions 路由（Story 2.6）', () => {
  it('story_decisions patch -> applyAgentFieldPatch 调用（actions 透传），syncField 不被调', () => {
    useTestStore.getState().setPendingPatch(SESS, makeStoryDecisionsPatch());
    selectPatches({ story_decisions: true });

    useTestStore.getState().applySelectedPatches();

    expect(window.orisonDesktop.applyAgentFieldPatch).toHaveBeenCalledTimes(1);
    const [path, patch] = (window.orisonDesktop.applyAgentFieldPatch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/proj');
    const first = patch.patches[0];
    expect((first.field as string)).toBe('story_decisions');
    expect((first.data as { actions: unknown[] }).actions).toHaveLength(1);
    // syncField 不被调（story_decisions 非 creative field，parse 会抛）。
    expect(window.orisonDesktop.syncField).not.toHaveBeenCalled();
    // creativeFields 状态不被污染。
    expect(useTestStore.getState().creativeFields).toEqual({});
    // pendingPatch 清空（审阅完成）。
    expect((useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null)).toBeNull();
  });

  it('story_decisions 未选中 -> 不路由（selection 门）', () => {
    useTestStore.getState().setPendingPatch(SESS, makeStoryDecisionsPatch());
    selectPatches({ story_decisions: false });

    useTestStore.getState().applySelectedPatches();

    expect(window.orisonDesktop.applyAgentFieldPatch).not.toHaveBeenCalled();
  });
});
