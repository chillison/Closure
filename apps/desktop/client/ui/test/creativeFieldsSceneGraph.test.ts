/**
 * Story 1.3 scene_graph patch-review data channel (design §4 / §5).
 *
 * Verifies the key trigger path: scene_graph_update → field_patch → setPendingPatch
 * runs validateSceneGraph (data channel) → applySelectedPatches persists with
 * art_overrides on accept-with-error. Pure store behaviour; no UI rendered.
 *
 * Paradigm (creative-vs-mechanical): the slice only routes data through pure-code
 * validateSceneGraph + buildArtOverridesForErrors — no semantic judgement here.
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
  };

const SESS = 'sess-cf';

const useTestStore = create<TestState>()((...a) => ({
  ...createProjectSlice(...a),
  ...createCreativeFieldsSlice(...a),
}));

// dogfood T1 Stage 3（r8 键控）：selections 在 per-session entry 内——测试直改 entry。
function selectPatches(selections: Record<string, boolean>) {
  const s = useTestStore.getState();
  const entry = s.pendingPatchBySession[SESS];
  if (!entry) throw new Error('no pending patch entry');
  useTestStore.setState({ pendingPatchBySession: { ...s.pendingPatchBySession, [SESS]: { ...entry, selections } } });
}


const BASE_GRAPH = {
  nodes: [
    { id: 's1', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } },
    { id: 's2', lineTags: ['l1'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 } },
  ],
  edges: [
    { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' },
    { id: 'e2', from: 's2', to: 's1', type: 'CAUSAL' }, // cycle
  ],
  lines: [{ id: 'l1', name: '主线', topology_role: 'converging', convergence_target: 's2' }],
};

function makePatch(field: string, data: unknown): ProjectFieldPatch {
  return {
    runId: 'run-1',
    createdAt: '2026-07-26T00:00:00Z',
    patches: [{ field: field as any, action: 'set', data, fieldVersion: 1, generatedBy: 'story-planner-agent' }],
  };
}

beforeEach(() => {
  useTestStore.setState({
    pendingPatchBySession: {},
            creativeFields: {},
    fieldMetadata: {},
    currentProject: { path: '/proj', name: 'P' } as any,
    agentSessionId: SESS,
  });
  (globalThis as any).window = globalThis as any;
  (window as any).orisonDesktop = { syncField: vi.fn().mockResolvedValue(undefined) };
});

describe('scene_graph patch-review 数据通道（Story 1.3 §4）', () => {
  it('setPendingPatch: scene_graph 含因果环 → pendingPatchIssues 记 causal-cycle error', () => {
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', BASE_GRAPH));
    const issues = useTestStore.getState().pendingPatchBySession[SESS]?.issues ?? [];
    expect(issues.some((i) => i.code === 'causal-cycle' && i.severity === 'error')).toBe(true);
  });

  it('setPendingPatch: 无环 scene_graph → pendingPatchIssues 为空', () => {
    const clean = { ...BASE_GRAPH, edges: [{ id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' }] };
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', clean));
    expect(useTestStore.getState().pendingPatchBySession[SESS]?.issues ?? []).toEqual([]);
  });

  it('setPendingPatch: 非 scene_graph patch（outline）不触发校验（issues 为空）', () => {
    useTestStore.getState().setPendingPatch(SESS, makePatch('outline', { central_conflict: 'x' }));
    expect(useTestStore.getState().pendingPatchBySession[SESS]?.issues ?? []).toEqual([]);
  });

  it('setPendingPatch(SESS, null): 清空 issues', () => {
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', BASE_GRAPH));
    expect((useTestStore.getState().pendingPatchBySession[SESS]?.issues ?? []).length).toBeGreaterThan(0);
    useTestStore.getState().setPendingPatch(SESS, null);
    expect(useTestStore.getState().pendingPatchBySession[SESS]?.issues ?? []).toEqual([]);
    expect((useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null)).toBeNull();
  });

  it('applySelectedPatches: 带 error accept → scene_graph 落 art_overrides（design §5 override）', () => {
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', BASE_GRAPH));
    useTestStore.getState().applySelectedPatches();

    const persisted = useTestStore.getState().creativeFields.scene_graph as any;
    expect(persisted.art_overrides).toEqual([
      expect.objectContaining({ check: 'causal-cycle', reason: 'accept-with-error override' }),
    ]);
    // syncField 收到带 override 的 graph
    const synced = (window.orisonDesktop.syncField as any).mock.calls[0];
    expect(synced[1]).toBe('scene_graph');
    expect(synced[2].art_overrides[0].check).toBe('causal-cycle');
    // issues cleared after apply
    expect(useTestStore.getState().pendingPatchBySession[SESS]?.issues ?? []).toEqual([]);
  });

  it('applySelectedPatches: 无 error accept → 不加 art_overrides', () => {
    const clean = { ...BASE_GRAPH, edges: [{ id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' }] };
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', clean));
    useTestStore.getState().applySelectedPatches();

    const persisted = useTestStore.getState().creativeFields.scene_graph as any;
    expect(persisted.art_overrides ?? []).toEqual([]);
  });

  it('applySelectedPatches: 重复 accept 同一 error 不重复堆 art_overrides（dedupe）', () => {
    // 第一次 accept 落 override
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', BASE_GRAPH));
    useTestStore.getState().applySelectedPatches();
    expect((useTestStore.getState().creativeFields.scene_graph as any).art_overrides).toHaveLength(1);

    // 第二次：带已有 override 的同图再过一遍校验 → 该 issue 已降级 info，不再产生 error override
    const withOverride = useTestStore.getState().creativeFields.scene_graph;
    useTestStore.setState({ currentProject: { path: '/proj', name: 'P' } as any });
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', withOverride));
    // 校验已读 art_overrides，环被降级 info → 无 error
    const issues = useTestStore.getState().pendingPatchBySession[SESS]?.issues ?? [];
    expect(issues.every((i) => i.severity !== 'error')).toBe(true);
  });
  it('setPendingPatch: 同 run 多 batch 按 field merge（CR-013，不丢前批 patch）', () => {
    // 第一批：outline patch
    useTestStore.getState().setPendingPatch(SESS, makePatch('outline', { central_conflict: '冲突' }));
    expect((useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null)?.patches).toHaveLength(1);
    expect((useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null)?.patches[0].field).toBe('outline');

    // 第二批：scene_graph patch（同 runId 'run-1'）-> 应 merge，不覆盖 outline
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', BASE_GRAPH));
    const pending = (useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null);
    expect(pending?.patches).toHaveLength(2);
    const fields = pending?.patches.map((p) => p.field);
    expect(fields).toContain('outline');
    expect(fields).toContain('scene_graph');
    // scene_graph 校验 issue 也已计算（merge 后重跑校验）
    expect((useTestStore.getState().pendingPatchBySession[SESS]?.issues ?? []).some((i) => i.code === 'causal-cycle')).toBe(true);
  });

  it('setPendingPatch: 同 field 同 run -> 新 entry 取代旧（CR-013，最新 LLM 意图胜）', () => {
    useTestStore.getState().setPendingPatch(SESS, makePatch('outline', { central_conflict: '旧' }));
    useTestStore.getState().setPendingPatch(SESS, makePatch('outline', { central_conflict: '新' }));
    const pending = (useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null);
    expect(pending?.patches).toHaveLength(1);
    expect((pending?.patches[0].data as any).central_conflict).toBe('新');
  });

  it('setPendingPatch: 不同 run -> 新 run 取代（CR-013，不跨 run merge）', () => {
    useTestStore.getState().setPendingPatch(SESS, makePatch('outline', { central_conflict: 'runA' }));
    // 不同 runId
    const runBPatch: ProjectFieldPatch = {
      runId: 'run-2',
      createdAt: '2026-07-26T00:00:00Z',
      patches: [{ field: 'scene_graph' as any, action: 'set', data: BASE_GRAPH, fieldVersion: 1, generatedBy: 'story-planner-agent' }],
    };
    useTestStore.getState().setPendingPatch(SESS, runBPatch);
    const pending = (useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null);
    expect(pending?.runId).toBe('run-2');
    expect(pending?.patches.map((p) => p.field)).toEqual(['scene_graph']);
  });
});

// Story 3.1 WP5: toggleFieldLock persists via the field:toggle-lock IPC (no
// version bump, no stale) — distinct from updateField's syncField path.
describe('toggleFieldLock 持久化（Story 3.1 WP5）', () => {
  beforeEach(() => {
    useTestStore.setState({
      fieldMetadata: {},
      currentProject: { path: '/proj', name: 'P' } as any,
    });
    (globalThis as any).window = globalThis as any;
    (window as any).orisonDesktop = {
      syncField: vi.fn().mockResolvedValue(undefined),
      toggleFieldLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('flips the store flag AND persists through field:toggle-lock IPC', () => {
    useTestStore.getState().toggleFieldLock('outline');
    // Optimistic flip reflected immediately.
    expect(useTestStore.getState().fieldMetadata.outline?.locked).toBe(true);
    // Persistence routed through the dedicated lock IPC, NOT syncField (which
    // would bump version + mark dependents stale).
    expect((window as any).orisonDesktop.toggleFieldLock).toHaveBeenCalledWith('/proj', 'outline');
    expect((window as any).orisonDesktop.syncField).not.toHaveBeenCalled();
  });

  it('does not bump version when toggling the lock', () => {
    useTestStore.setState({ fieldMetadata: { outline: { version: 7, source: 'user', locked: false, dependsOn: [], stale: false } } });
    useTestStore.getState().toggleFieldLock('outline');
    // version stays 7 — lock toggle is metadata-only (no content revision).
    expect(useTestStore.getState().fieldMetadata.outline?.version).toBe(7);
    expect(useTestStore.getState().fieldMetadata.outline?.locked).toBe(true);
  });

  it('toggles back to unlocked on a second call', () => {
    useTestStore.getState().toggleFieldLock('scene_graph');
    useTestStore.getState().toggleFieldLock('scene_graph');
    expect(useTestStore.getState().fieldMetadata.scene_graph?.locked).toBe(false);
    expect((window as any).orisonDesktop.toggleFieldLock).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 批次0（地基缺口4）：AI 落盘 undo 对称——applySelectedPatches 为被改的
// creative field 压 fieldUndoStack（mirror updateField），chapter_candidate/
// story_decisions/overview 不压栈、不清 redo。纯 store 行为，无 UI 渲染。
// ─────────────────────────────────────────────────────────────────────────────

/** 无 error 的干净图（避免 accept-with-error 的 art_overrides 合并干扰 undo 断言）。 */
const CLEAN_GRAPH = {
  nodes: [
    { id: 's1', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } },
    { id: 's2', lineTags: ['l1'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 } },
  ],
  edges: [{ id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' }],
  lines: [{ id: 'l1', name: '主线', topology_role: 'converging', convergence_target: 's2' }],
};

const GROWN_GRAPH = {
  ...CLEAN_GRAPH,
  nodes: [
    ...CLEAN_GRAPH.nodes,
    { id: 's3', lineTags: ['l1'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 } },
  ],
  edges: [
    ...CLEAN_GRAPH.edges,
    { id: 'e2', from: 's2', to: 's3', type: 'CAUSAL' },
  ],
};

describe('applySelectedPatches undo 对称（dogfood R2 批次0 缺口4）', () => {
  beforeEach(() => {
    useTestStore.setState({ fieldUndoStack: [], fieldRedoStack: [] });
  });

  it('接受 scene_graph patch 后 canUndoField 为真，undoField 回到接受前的值', () => {
    useTestStore.setState({ creativeFields: { scene_graph: CLEAN_GRAPH } });
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', GROWN_GRAPH));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().creativeFields.scene_graph).toBe(GROWN_GRAPH);
    expect(useTestStore.getState().canUndoField()).toBe(true);

    useTestStore.getState().undoField();
    // 引用级回到接受前的对象（同一引用，无拷贝）
    expect(useTestStore.getState().creativeFields.scene_graph).toBe(CLEAN_GRAPH);
    expect(useTestStore.getState().canUndoField()).toBe(false);
  });

  it('chapter_candidate-only accept：不压 undo 栈、不清 redo 栈（与 updateField 收窄一致）', () => {
    // 造一个 redo entry：手改 outline 后 undo
    useTestStore.getState().updateField('outline', { central_conflict: '手改' });
    useTestStore.getState().undoField();
    expect(useTestStore.getState().canRedoField()).toBe(true);

    useTestStore.getState().setPendingPatch(SESS, makePatch('chapter_candidate', { chapterId: 'ch-0001', content: '正文' }));
    useTestStore.getState().applySelectedPatches();
    // chapter_candidate 非 creative field：undo 栈不进、redo 栈不动
    expect(useTestStore.getState().canUndoField()).toBe(false);
    expect(useTestStore.getState().canRedoField()).toBe(true);
  });

  it('creative patch accept：清 redo 栈（mirror updateField 新改动作废旧 redo 路径）', () => {
    useTestStore.getState().updateField('outline', { central_conflict: '手改' });
    useTestStore.getState().undoField();
    expect(useTestStore.getState().canRedoField()).toBe(true);

    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', GROWN_GRAPH));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().canRedoField()).toBe(false);
  });

  it('同 run 多 field 批量压栈：每 field 一 entry，逐次 undo 各自恢复', () => {
    const oldOutline = { central_conflict: '旧冲突' };
    useTestStore.setState({ creativeFields: { outline: oldOutline, scene_graph: CLEAN_GRAPH } });
    const multiPatch: ProjectFieldPatch = {
      runId: 'run-multi',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [
        { field: 'outline' as any, action: 'set', data: { central_conflict: '新冲突' }, fieldVersion: 2, generatedBy: 'story-planner-agent' },
        { field: 'scene_graph' as any, action: 'set', data: GROWN_GRAPH, fieldVersion: 2, generatedBy: 'story-planner-agent' },
      ],
    };
    useTestStore.getState().setPendingPatch(SESS, multiPatch);
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().fieldUndoStack).toHaveLength(2);

    // 栈顶 = selectedPatches 顺序的最后一个（scene_graph）→ 先 undo 恢复 scene_graph
    useTestStore.getState().undoField();
    expect(useTestStore.getState().creativeFields.scene_graph).toBe(CLEAN_GRAPH);
    expect((useTestStore.getState().creativeFields.outline as any).central_conflict).toBe('新冲突');

    useTestStore.getState().undoField();
    expect(useTestStore.getState().creativeFields.outline).toBe(oldOutline);
    expect(useTestStore.getState().canUndoField()).toBe(false);
  });

  it('overview-only accept：不压 undo 栈（合并进 currentProject，无字段级 undo 语义）', () => {
    useTestStore.getState().setPendingPatch(SESS, makePatch('overview', { name: '新名字' }));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().canUndoField()).toBe(false);
    expect(useTestStore.getState().currentProject?.name).toBe('新名字');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 批次 D2 / CR-25：applySelectedPatches 接受 scene_graph patch 时 diff
// 改前/改后 node id 集 → 存 pendingStructureHighlight 待消费高亮集（消费者 =
// StructurePage：consume → highlightNodeIds 绿框脉冲，TTL 3s 在彼处）。触发点在
// apply 而非结构页挂载域——他页接受后切回结构页时挂载域 diff 恒空，主流程原不可达。
// ─────────────────────────────────────────────────────────────────────────────
describe('applySelectedPatches → pendingStructureHighlight（dogfood R2 D2 / CR-25）', () => {
  beforeEach(() => {
    useTestStore.setState({
      pendingStructureHighlight: [],
      fieldUndoStack: [],
      fieldRedoStack: [],
    });
  });

  it('接受新增节点的 scene_graph patch → stash 新增 id 集（新增序）', () => {
    useTestStore.setState({ creativeFields: { scene_graph: CLEAN_GRAPH } });
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', GROWN_GRAPH));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().pendingStructureHighlight).toEqual(['s3']);
  });

  it('stash 原子消费：consume 取走并清空；二次 consume 拿空集（StrictMode 幂等）', () => {
    useTestStore.setState({ creativeFields: { scene_graph: CLEAN_GRAPH } });
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', GROWN_GRAPH));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().consumePendingStructureHighlight()).toEqual(['s3']);
    expect(useTestStore.getState().pendingStructureHighlight).toEqual([]);
    expect(useTestStore.getState().consumePendingStructureHighlight()).toEqual([]);
  });

  it('无新增（改边/删点/同图）→ 不动既有 stash', () => {
    useTestStore.setState({
      creativeFields: { scene_graph: CLEAN_GRAPH },
      pendingStructureHighlight: ['held'],
    });
    // 同图重发（无 node 差异）。
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', CLEAN_GRAPH));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().pendingStructureHighlight).toEqual(['held']);
  });

  it('非 scene_graph patch（outline）不动 stash；首图（改前无 scene_graph）不产高亮', () => {
    useTestStore.setState({
      creativeFields: { outline: { central_conflict: '旧' } },
      pendingStructureHighlight: ['held'],
    });
    useTestStore.getState().setPendingPatch(SESS, makePatch('outline', { central_conflict: '新' }));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().pendingStructureHighlight).toEqual(['held']);

    // 首图：改前无 scene_graph（无前态可比）→ diffAddedNodeIds 语义返空、不动 stash。
    useTestStore.setState({ creativeFields: {}, pendingStructureHighlight: [] });
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', GROWN_GRAPH));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().pendingStructureHighlight).toEqual([]);
  });

  it('多次接受未消费 → 并集去重（顺序稳定：先存留集后新增集）', () => {
    useTestStore.setState({ creativeFields: { scene_graph: CLEAN_GRAPH }, pendingStructureHighlight: ['held', 's3'] });
    // 第一轮：新增 s3 + s4。
    const grown2 = {
      ...CLEAN_GRAPH,
      nodes: [
        ...CLEAN_GRAPH.nodes,
        { id: 's3', lineTags: ['l1'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 } },
        { id: 's4', lineTags: ['l1'], storyTime: 4, presentationOrder: { chapter: 0, pos: 3 } },
      ],
    };
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', grown2));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().pendingStructureHighlight).toEqual(['held', 's3', 's4']);
    // 第二轮（对最新图再新增）：旧新增 s3 已在图内 → 只补 s5。
    const grown3 = {
      ...grown2,
      nodes: [
        ...grown2.nodes,
        { id: 's5', lineTags: ['l1'], storyTime: 5, presentationOrder: { chapter: 0, pos: 4 } },
      ],
    };
    useTestStore.getState().setPendingPatch(SESS, makePatch('scene_graph', grown3));
    useTestStore.getState().applySelectedPatches();
    expect(useTestStore.getState().pendingStructureHighlight).toEqual(['held', 's3', 's4', 's5']);
  });
});
