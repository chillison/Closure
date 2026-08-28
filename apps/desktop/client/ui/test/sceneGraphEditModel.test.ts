/**
 * dogfood R2 批次 A：sceneGraphEditModel 纯函数（SP-1/SP-3 场景/线生命周期 action
 * 构造 + D2 新增节点 diff）。
 *
 * 覆盖（验收：新建投影/删除边级联/线管理 ops/agent 落盘 diff 纯函数）：
 *  - nextIdWithPrefix：`S-{max+1}` 起始 1 / 非该形态 id 不撞名
 *  - buildAddSceneAction：id 自动 + storyTime 钳制 + 默认线解析
 *  - buildRemoveSceneActions：**投影器 remove_scene 不级联边** → action 数组层补齐
 *    remove_edge（每触及边一枚）——UI 删除的最终语义，确认文案据实
 *  - buildRemoveLineActions：**投影器 remove_line 不摘 lineTags** → 数组层补齐
 *    update_scene 摘 tag（场景保留）
 *  - buildAddEdgeAction：自环/同向重复边返回 null（禁用钮的同款判定）
 *  - diffAddedNodeIds：agent 落盘新增集（D2 高亮数据源）；任一侧缺省返回空
 *
 * 投影语义回归（actions 喂 applySceneGraphActions 后的图形状）一并断言——UI 手势
 * 与 AI scene_graph_update 同一投影器，纯函数级测最稳。
 *
 * Run: `cd apps/desktop/client/ui && pnpm test sceneGraphEditModel`
 */
import { describe, expect, it } from 'vitest';
import {
  applyEpisodeActions,
  applySceneGraphActions,
  sceneGraphSchema,
  type SceneGraph,
} from '@orison/shared-contracts';
import {
  applyChapterDrop,
  applyPendingDrop,
  applyResizeSpanRange,
  buildAddEdgeAction,
  buildAddLineAction,
  buildAddSceneAction,
  buildInsertChapterActions,
  buildNewSceneAtChapterAction,
  buildRemoveLineActions,
  buildRemoveSceneActions,
  clampStoryTime,
  columnIndexFromRects,
  countScenesInChapter,
  countScenesOnLine,
  decodeDragPayload,
  diffAddedNodeIds,
  edgesTouchingNode,
  encodeDragPayload,
  nextIdWithPrefix,
  nextStoryTime,
  resolveDefaultLineId,
  SCENE_DRAG_MIME,
} from '../src/features/structure/sceneGraphEditModel';
import {
  PENDING_CHAPTER_SENTINEL,
  resolveSceneChapterRange,
} from '../src/features/structure/workbenchLayout';
import { episodeOutlinesSchema } from '@orison/shared-contracts';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

/**
 * 两线三场景图（l_main 主线 + l_side 副线，s2 双线归属）：
 *   s1 (l_main, t1) ──e1 CAUSAL──▶ s2 (l_main+l_side, t2) ──e2 SUSPENSE──▶ s3 (l_side, t3)
 */
function baseGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
      { id: 'l_side', name: '副线', topology_role: 'side' },
    ],
    nodes: [
      { id: 's1', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's2', lineTags: ['l_main', 'l_side'], storyTime: 2, role: 'core-anchor', presentationOrder: { chapter: 0, pos: 1 } },
      { id: 's3', lineTags: ['l_side'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 0, pos: 2 } },
    ],
    edges: [
      { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' },
      { id: 'e2', from: 's2', to: 's3', type: 'SUSPENSE' },
    ],
  });
}

describe('nextIdWithPrefix (`S-{max+1}` id 约定)', () => {
  it('starts at 1 when no id matches the prefix pattern', () => {
    expect(nextIdWithPrefix(['s1', 's2', 'l_main'], 'S')).toBe('S-1');
  });

  it('increments past the max numeric suffix among matching ids', () => {
    expect(nextIdWithPrefix(['S-1', 'S-3', 's1'], 'S')).toBe('S-4');
    expect(nextIdWithPrefix(['L-2', 'l_main'], 'L')).toBe('L-3');
  });

  it('ignores non-numeric suffixes under the same prefix (no NaN growth)', () => {
    expect(nextIdWithPrefix(['S-abc', 'S-2'], 'S')).toBe('S-3');
  });
});

describe('buildAddSceneAction (SP-1 新建投影)', () => {
  it('auto id S-1, role normal, storyTime = column value, lineTags passed through', () => {
    const g = baseGraph();
    const action = buildAddSceneAction(g, { storyTime: 2, lineTags: ['l_side'] });
    expect(action).toEqual({
      op: 'add_scene',
      scene: {
        id: 'S-1', storyTime: 2, role: 'normal', lineTags: ['l_side'],
        presentationOrder: { chapter: 0, pos: 0 },
      },
    });
    // 投影后 schema-valid：喂同一投影器（applySceneGraphActions）落图。
    const next = applySceneGraphActions(g, [action]);
    const added = next.nodes.find((n) => n.id === 'S-1')!;
    expect(added).toMatchObject({ storyTime: 2, role: 'normal', lineTags: ['l_side'], presentationOrder: { chapter: 0, pos: 0 } });
  });

  it('omitted presentationOrder now EMITS the concrete default {chapter:0,pos:0}（CR 组 3c：创建流程不再生产被 drop 处理器拒绝的形态）', () => {
    const action = buildAddSceneAction(baseGraph(), { storyTime: 1, lineTags: ['l_main'] });
    expect(
      action.op === 'add_scene' && action.scene.presentationOrder
    ).toEqual({ chapter: 0, pos: 0 });
  });

  it('explicit presentationOrder passes through with the same nonneg-int clamp（复用 clampStoryTime 单一钳制）', () => {
    const action = buildAddSceneAction(baseGraph(), {
      storyTime: -1.2,
      lineTags: ['l_main'],
      presentationOrder: { chapter: 2.9, pos: -3 },
    });
    expect(action.op === 'add_scene' && action.scene.presentationOrder).toEqual({
      chapter: 2,
      pos: 0,
    });
    expect(action.op === 'add_scene' && action.scene.storyTime).toBe(0);
  });

  it('clamps storyTime to a nonnegative integer (schema contract)', () => {
    const action = buildAddSceneAction(baseGraph(), { storyTime: -3.7, lineTags: ['l_main'] });
    expect(action.op === 'add_scene' && action.scene.storyTime).toBe(0);
  });

  it('keeps numbering past existing S-n ids (S-5 present → S-6)', () => {
    const g = parseGraph({
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        { id: 'S-5', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      ],
      edges: [],
    });
    const action = buildAddSceneAction(g, { storyTime: 2, lineTags: ['l_main'] });
    expect(action.op === 'add_scene' && action.scene.id).toBe('S-6');
  });
});

describe('resolveDefaultLineId (新建默认线：聚焦线 ∥ 主线)', () => {
  it('prefers the focused line when it still exists', () => {
    expect(resolveDefaultLineId(baseGraph(), 'l_side')).toBe('l_side');
  });

  it('falls back to the first main-thread line when focus is unset/dangling', () => {
    expect(resolveDefaultLineId(baseGraph(), null)).toBe('l_main');
    expect(resolveDefaultLineId(baseGraph(), 'ghost')).toBe('l_main');
  });

  it('returns undefined for a lineless graph (caller adds with empty lineTags)', () => {
    const g = parseGraph({ nodes: [], lines: [] });
    expect(resolveDefaultLineId(g, null)).toBeUndefined();
  });
});

describe('buildRemoveSceneActions (SP-1 删除：边级联在数组层补齐)', () => {
  it('includes one remove_edge per touching edge, then remove_scene', () => {
    const g = baseGraph();
    const actions = buildRemoveSceneActions(g, 's2');
    expect(actions).toEqual([
      { op: 'remove_edge', id: 'e1' },
      { op: 'remove_edge', id: 'e2' },
      { op: 'remove_scene', id: 's2' },
    ]);
    // 投影后：节点删除 + 触及边全清（无 dangling-edge-endpoint 残留——UI 删除的最终语义，
    // 确认文案「将断开 N 条因果边」据实）。
    const next = applySceneGraphActions(g, actions);
    expect(next.nodes.some((n) => n.id === 's2')).toBe(false);
    expect(next.edges).toHaveLength(0);
    // 其他节点不动。
    expect(next.nodes.map((n) => n.id)).toEqual(['s1', 's3']);
  });

  it('scene without edges projects to a plain remove (no cascade noise)', () => {
    const actions = buildRemoveSceneActions(baseGraph(), 's1');
    expect(actions).toEqual([{ op: 'remove_edge', id: 'e1' }, { op: 'remove_scene', id: 's1' }]);
  });

  it('returns [] for an unknown nodeId (caller no-op)', () => {
    expect(buildRemoveSceneActions(baseGraph(), 'ghost')).toEqual([]);
  });

  it('edgesTouchingNode counts in+out edges (confirm-copy N)', () => {
    expect(edgesTouchingNode(baseGraph(), 's2')).toHaveLength(2);
    expect(edgesTouchingNode(baseGraph(), 's1')).toHaveLength(1);
    expect(edgesTouchingNode(baseGraph(), 'ghost')).toHaveLength(0);
  });
});

describe('buildRemoveLineActions (SP-3 删线：lineTags 摘除在数组层补齐)', () => {
  it('strips the tag from every member scene (scenes kept), then removes the line', () => {
    const g = baseGraph();
    const actions = buildRemoveLineActions(g, 'l_side');
    expect(actions).toEqual([
      { op: 'update_scene', scene: { id: 's2', lineTags: ['l_main'] } },
      { op: 'update_scene', scene: { id: 's3', lineTags: [] } },
      { op: 'remove_line', id: 'l_side' },
    ]);
    // 投影后：线删除、场景保留、无 dangling lineTag。
    const next = applySceneGraphActions(g, actions);
    expect(next.lines.map((l) => l.id)).toEqual(['l_main']);
    expect(next.nodes.map((n) => n.id)).toEqual(['s1', 's2', 's3']);
    expect(next.nodes.find((n) => n.id === 's2')!.lineTags).toEqual(['l_main']);
    expect(next.nodes.find((n) => n.id === 's3')!.lineTags).toEqual([]);
  });

  it('returns [] for an unknown lineId', () => {
    expect(buildRemoveLineActions(baseGraph(), 'ghost')).toEqual([]);
  });

  it('countScenesOnLine counts membership (confirm-copy M)', () => {
    expect(countScenesOnLine(baseGraph(), 'l_side')).toBe(2);
    expect(countScenesOnLine(baseGraph(), 'l_main')).toBe(2);
    expect(countScenesOnLine(baseGraph(), 'ghost')).toBe(0);
  });
});

describe('buildAddLineAction (SP-3 新增线)', () => {
  it('auto id L-1 + topology_role converging default', () => {
    const action = buildAddLineAction(baseGraph(), '新线');
    expect(action).toEqual({
      op: 'add_line',
      line: { id: 'L-1', name: '新线', topology_role: 'converging' },
    });
    const next = applySceneGraphActions(baseGraph(), [action]);
    const added = next.lines.find((l) => l.id === 'L-1')!;
    expect(added).toMatchObject({ name: '新线', topology_role: 'converging', displacement: 'none' });
  });
});

describe('buildAddEdgeAction (SP-2 连边：自环/同向重复阻止)', () => {
  it('builds add_edge with auto id for a fresh ordered pair', () => {
    const action = buildAddEdgeAction(baseGraph(), { from: 's1', to: 's3', type: 'CAUSAL' });
    expect(action).toEqual({ op: 'add_edge', edge: { id: 'E-1', from: 's1', to: 's3', type: 'CAUSAL' } });
  });

  it('returns null on self-loop', () => {
    expect(buildAddEdgeAction(baseGraph(), { from: 's1', to: 's1', type: 'CAUSAL' })).toBeNull();
  });

  it('returns null on an existing ordered pair (any type — same-pair dual type is redundant)', () => {
    expect(buildAddEdgeAction(baseGraph(), { from: 's1', to: 's2', type: 'CAUSAL' })).toBeNull();
    expect(buildAddEdgeAction(baseGraph(), { from: 's1', to: 's2', type: 'SUSPENSE' })).toBeNull();
  });

  it('reverse direction is a fresh pair (A→B does not block B→A)', () => {
    expect(buildAddEdgeAction(baseGraph(), { from: 's2', to: 's1', type: 'CAUSAL' })).not.toBeNull();
  });
});

describe('clampStoryTime', () => {
  it('clamps negatives/fractions/NaN to a nonnegative integer', () => {
    expect(clampStoryTime(-2)).toBe(0);
    expect(clampStoryTime(3.9)).toBe(3);
    expect(clampStoryTime(Number.NaN)).toBe(0);
    expect(clampStoryTime(7)).toBe(7);
  });
});

describe('diffAddedNodeIds (D2 agent 落盘高亮数据源)', () => {
  it('returns ids present in next but absent from prev, in next order', () => {
    const before = baseGraph();
    const after = applySceneGraphActions(before, [buildAddSceneAction(before, { storyTime: 5, lineTags: ['l_main'] })]);
    expect(diffAddedNodeIds(before, after)).toEqual(['S-1']);
  });

  it('returns [] when nothing was added (update/remove-only patch)', () => {
    const before = baseGraph();
    const after = applySceneGraphActions(before, [{ op: 'remove_scene', id: 's3' }]);
    expect(diffAddedNodeIds(before, after)).toEqual([]);
  });

  it('returns [] when either side is missing (first hydration / cleared graph)', () => {
    expect(diffAddedNodeIds(undefined, baseGraph())).toEqual([]);
    expect(diffAddedNodeIds(baseGraph(), undefined)).toEqual([]);
    expect(diffAddedNodeIds(undefined, undefined)).toEqual([]);
  });

  it('never mutates its inputs', () => {
    const before = baseGraph();
    const after = applySceneGraphActions(before, [buildAddSceneAction(before, { storyTime: 5, lineTags: ['l_main'] })]);
    const snapBefore = JSON.parse(JSON.stringify(before));
    const snapAfter = JSON.parse(JSON.stringify(after));
    diffAddedNodeIds(before, after);
    expect(before).toEqual(snapBefore);
    expect(after).toEqual(snapAfter);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR 组5/组3c 批 A：拖拽写通道族（codec 单源 + 落章/撤章纯函数 + 章内位次算术）
// ─────────────────────────────────────────────────────────────────────────────

/** 带「遮蔽字段」的场景节点形态（presentationSpans / legacy episodeId）。 */
function shadowGraph(): SceneGraph {
  return parseGraph({
    lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    nodes: [
      {
        id: 's_span', lineTags: ['l1'], storyTime: 1, role: 'normal',
        presentationOrder: { chapter: 0, pos: 0 },
        presentationSpans: [{ episodeId: 'e0', pos: 0 }, { episodeId: 'e2', pos: 1 }],
      },
      {
        id: 's_legacy', lineTags: ['l1'], storyTime: 2, role: 'normal',
        presentationOrder: { chapter: 0, pos: 1 },
        episodeId: 'e1',
      },
      { id: 's_plain', lineTags: ['l1'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 2, pos: 0 } },
    ],
    edges: [],
  });
}

describe('SCENE_DRAG_MIME codec (single source)', () => {
  it('MIME constant is the shared string both hooks used to duplicate', () => {
    expect(SCENE_DRAG_MIME).toBe('application/x-orison-scene-drag');
  });

  it('decode accepts modeless payloads AND legacy mode-bearing ones（裁决 2B：来源不再是行为分叉轴）', () => {
    const roundtrip = decodeDragPayload(encodeDragPayload({ nodeId: 's1' }));
    expect(roundtrip).toEqual({ nodeId: 's1' });
    // mode 只是随行信息——解码取 nodeId，多余字段不拒收。
    expect(decodeDragPayload(JSON.stringify({ nodeId: 's1', mode: 'weaving' }))?.nodeId).toBe('s1');
    expect(decodeDragPayload(null)).toBeNull();
    expect(decodeDragPayload('')).toBeNull();
    expect(decodeDragPayload('not json')).toBeNull();
    expect(decodeDragPayload('{"nope":1}')).toBeNull();
  });
});

describe('applyChapterDrop (CR 组 5 P0 ghost-write 修复)', () => {
  it('strips presentationSpans/episodeId when writing the chapter — 写入不再被解析序遮蔽', () => {
    const g = shadowGraph();
    const next = applyChapterDrop(g, 's_span', 2);
    const moved = next.nodes.find((n) => n.id === 's_span')!;
    expect(moved.presentationOrder.chapter).toBe(2);
    expect(moved.presentationSpans).toBeUndefined();
    // 其他节点不动。
    expect(next.nodes.find((n) => n.id === 's_plain')!.presentationOrder.chapter).toBe(2);
    const legacyNext = applyChapterDrop(g, 's_legacy', 1);
    const legacyMoved = legacyNext.nodes.find((n) => n.id === 's_legacy')!;
    expect(legacyMoved.episodeId).toBeUndefined();
    expect(legacyMoved.presentationOrder.chapter).toBe(1);
  });

  it('keeps pos unchanged and never mutates the input graph', () => {
    const g = shadowGraph();
    const snapshot = JSON.parse(JSON.stringify(g));
    const next = applyChapterDrop(g, 's_span', 1);
    expect(next.nodes.find((n) => n.id === 's_span')!.presentationOrder.pos).toBe(0);
    expect(g).toEqual(snapshot);
  });

  it('non-finite target → SAME reference (NaN 不能被 floor 成合法章写进 int 域；CR 组 3c finite 洞)', () => {
    const g = shadowGraph();
    expect(applyChapterDrop(g, 's_plain', Number.NaN)).toBe(g);
    expect(applyChapterDrop(g, 's_plain', Number.POSITIVE_INFINITY)).toBe(g);
  });

  it('content-equal drop → SAME reference (引用级 no-op——handler 借此跳过整次 updateField)', () => {
    const g = shadowGraph(); // s_plain 已在章 2
    expect(applyChapterDrop(g, 's_plain', 2)).toBe(g);
  });

  it('unknown node / missing presentationOrder → original untouched', () => {
    const g = shadowGraph();
    expect(applyChapterDrop(g, 'ghost', 9)).toBe(g);
    const broken = {
      ...g,
      nodes: [{ id: 's_x', lineTags: ['l1'], storyTime: 1 }],
    } as unknown as SceneGraph;
    expect(applyChapterDrop(broken, 's_x', 4)).toBe(broken);
  });
});

describe('applyPendingDrop (#63 + 遮蔽剥离 + 引用级 no-op)', () => {
  it('writes the sentinel chapter AND strips shadow fields (拖回待编排对 spans/legacy 场景生效)', () => {
    const g = shadowGraph();
    for (const id of ['s_span', 's_legacy']) {
      const next = applyPendingDrop(g, id);
      const node = next.nodes.find((n) => n.id === id)!;
      expect(node.presentationOrder.chapter).toBe(PENDING_CHAPTER_SENTINEL);
      expect(node.presentationSpans).toBeUndefined();
      expect(node.episodeId).toBeUndefined();
    }
  });

  it('already-pending node → SAME reference; second drag back writes nothing', () => {
    const g = shadowGraph();
    const once = applyPendingDrop(g, 's_span');
    expect(applyPendingDrop(once, 's_span')).toBe(once);
  });

  it('keeps pos and never mutates the input', () => {
    const g = shadowGraph();
    const snapshot = JSON.parse(JSON.stringify(g));
    const next = applyPendingDrop(g, 's_legacy');
    expect(next.nodes.find((n) => n.id === 's_legacy')!.presentationOrder.pos).toBe(1);
    expect(g).toEqual(snapshot);
  });
});

describe('countScenesInChapter (CR 组 3c 重构：maxPos+1 算术 + 解析口径并入)', () => {
  const EPS = () =>
    episodeOutlinesSchema.parse([
      { id: 'e0', index: 0, title: '第一章' },
      { id: 'e1', index: 1, title: '第二章' },
      { id: 'e2', index: 2, title: '第三章' },
    ]);

  it('sparse positions append past the max（{0,2} → 3，成员计数会撞上已占用的 2）', () => {
    const g = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        { id: 'a', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
        { id: 'b', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 2 } },
      ],
      edges: [],
    });
    expect(countScenesInChapter(g, 0)).toBe(3);
    expect(countScenesInChapter(g, 0, EPS())).toBe(3); // 解析口径下同值
  });

  it('empty chapter → 0; non-finite/fractional input normalized', () => {
    const g = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [],
      edges: [],
    });
    expect(countScenesInChapter(g, 0)).toBe(0);
    expect(countScenesInChapter(g, Number.NaN)).toBe(0);
    expect(countScenesInChapter(shadowGraph(), 2.9)).toBeGreaterThan(0); // floor 归一命中章 2
  });

  it('with episodes: span-start scenes count toward their START chapter（range 起点计数并入）', () => {
    // s_only spans e1：无 episodes 参数只按裸章号 7 计（章 1 无关）；
    // 有参数时解析起点为章 1——其 po.pos 参与位次。
    // CR3 G-F11：b.pos 刻意小于 s_only.pos，使两口径断言值**分叉**（旧 fixture
    // b.pos=9 时解析 max(0,9)+1 与裸 max(9)+1 巧合同值 10，第二条断言零分辨力）。
    const eps = EPS();
    const g = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        {
          id: 's_only', lineTags: ['l1'], storyTime: 1, role: 'normal',
          presentationOrder: { chapter: 7, pos: 12 }, // 裸章号在别处
          presentationSpans: [{ episodeId: 'e1', pos: 0 }], // 解析起点 = 章 1
        },
        { id: 'b', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 3 } },
      ],
      edges: [],
    });
    // 解析口径：章 1 有 s_only(span 起点，po.pos=12) + b(pos 3) → 下一位 13。
    expect(countScenesInChapter(g, 1, eps)).toBe(13);
    // 无数据回退裸口径：章 1 只有 b(pos 3) → 4。分叉被钉住（回退分支改坏即红）。
    expect(countScenesInChapter(g, 1)).toBe(4);
  });

  it('dangling scenes resolve to no chapter under the parsed lens (不污染真实章的追加位次)', () => {
    const eps = EPS();
    const g = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        { id: 'dangling', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 42, pos: 8 } },
        { id: 'ok', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 1 } },
      ],
      edges: [],
    });
    expect(countScenesInChapter(g, 0, eps)).toBe(2);
  });
});

describe('nextStoryTime (直测补齐——CR 组 3c 三新纯函数族)', () => {
  it('returns max storyTime + 1 across the graph; empty graph → 0', () => {
    expect(nextStoryTime(shadowGraph())).toBe(4);
    expect(
      nextStoryTime(parseGraph({ lines: [], nodes: [], edges: [] }))
    ).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R6 方案 D：applyResizeSpanRange（按列号重写占用区间——边缘直拖与宽卡平移的单条 op）
// ─────────────────────────────────────────────────────────────────────────────

describe('applyResizeSpanRange (R6 方案 D 单源 op)', () => {
  const po6 = (chapter: number, pos = 0) => ({ chapter, pos });
  const span6 = (episodeId: string, pos = 0) => ({ episodeId, pos });
  const graph = (nodes: unknown[]): SceneGraph =>
    parseGraph({
      lines: [{ id: 'main', name: 'Main', topology_role: 'converging', is_main_thread: true }],
      nodes,
      edges: [],
    });
  const EPS = () =>
    episodeOutlinesSchema.parse([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e3', index: 3, title: 'C3' },
    ]);

  it('单章场景右扩一章：裸章形态 → 真实构建合法 spans（首段持原 pos）', () => {
    const g = graph([
      { id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po6(1, 4) },
    ]);
    const out = applyResizeSpanRange(g, 's1', 1, 2, EPS());
    const s1 = out.nodes[0]!;
    expect(s1.presentationSpans).toEqual([span6('e1', 4), span6('e2', 0)]);
    // 首章未变 → presentationOrder 原样保留（pos 4 不被清零）。
    expect(s1.presentationOrder).toEqual(po6(1, 4));
  });

  it('跨章卡整体平移保持宽度：spans 重写 + episodeId 反查 + 首段 pos 归 0（CR3 拍板——不搬运旧章 pos 撞新章位次）', () => {
    const g = graph([
      {
        id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal',
        presentationOrder: po6(0, 2),
        presentationSpans: [span6('e0', 2), span6('e1'), span6('e2')],
      },
    ]);
    const out = applyResizeSpanRange(g, 's1', 1, 3, EPS());
    expect(out.nodes[0]!.presentationSpans).toEqual([span6('e1', 0), span6('e2', 0), span6('e3', 0)]);
    // po 与 spans[0] 同持「阅读起始位」：首章变化双双归 0。
    expect(out.nodes[0]!.presentationOrder).toEqual(po6(1, 0));
  });

  it('首章变化 → presentationOrder 同步为 {chapter:newStart,pos:0}；单章结果删 spans 字段（规范形）', () => {
    const g = graph([
      {
        id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal',
        presentationOrder: po6(0, 7),
        presentationSpans: [span6('e0', 7), span6('e1')],
      },
    ]);
    const out = applyResizeSpanRange(g, 's1', 1, 1, EPS()); // 左缘收成单章 @1
    const s1 = out.nodes[0]!;
    expect(s1.presentationSpans).toBeUndefined();
    expect(s1.presentationOrder).toEqual(po6(1, 0));
  });

  it('legacy episodeId 形态 resize 后剥残锚（缩回单章时不会复活跳位）', () => {
    const g = graph([
      {
        id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal',
        presentationOrder: po6(0), episodeId: 'e1',
      },
    ]);
    const out = applyResizeSpanRange(g, 's1', 0, 2, EPS());
    const s1 = out.nodes[0] as SceneGraph['nodes'][number];
    expect(s1.episodeId).toBeUndefined();
    expect(s1.presentationSpans).toEqual([span6('e0', 0), span6('e1', 0), span6('e2', 0)]);
  });

  it('no-op 面板：结果区间等 / newEnd<newStart / 越界未建章 / 非数组 episodes / NaN / ghost → 全部原引用', () => {
    const make = () =>
      graph([
        {
          id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal',
          presentationOrder: po6(0),
          presentationSpans: [span6('e0'), span6('e2')],
        },
      ]);
    // 每例独立起图：toBe 断的是**输入实例本身**被原样返回（引用级 no-op 契约）。
    const cases: Array<(g: SceneGraph) => SceneGraph> = [
      (g) => applyResizeSpanRange(g, 's1', 0, 2, EPS()),
      (g) => applyResizeSpanRange(g, 's1', 2, 1, EPS()),
      (g) =>
        applyResizeSpanRange(g, 's1', 0, 3, [
          { id: 'e9', index: 9, title: 'x' } as never,
        ]),
      (g) => applyResizeSpanRange(g, 's1', 0, 2, {} as never),
      (g) => applyResizeSpanRange(g, 's1', Number.NaN, 2, EPS()),
      (g) => applyResizeSpanRange(g, 'ghost', 0, 1, EPS()),
    ];
    for (const run of cases) {
      const g = make();
      expect(run(g)).toBe(g);
    }
  });

  it('区间内部含 gap 章 → 整区间守卫原引用拒收（CR3 G-F1：不截断写窄区间/1 元素 spans）', () => {
    // eps 缺 index 1（内部 gap）；两端点 0/2 已建但 1 缺——旧实现只验端点，
    // 构建循环 break 截断，写出 [e0(pos)] 单元素 spans（违反单章规范形）。
    const gapped = episodeOutlinesSchema.parse([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e3', index: 3, title: 'C3' },
    ]);
    const make = () =>
      graph([
        { id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po6(3) },
      ]);
    const g = make();
    expect(applyResizeSpanRange(g, 's1', 0, 2, gapped)).toBe(g); // 请求 [0..2] 含缺号 → 拒收
    // 对照：两端点齐全且区间稠密的请求正常兑现（排除「端点拒收」混淆）。
    const out = applyResizeSpanRange(make(), 's1', 2, 3, gapped);
    expect(out.nodes[0]!.presentationSpans).toEqual([span6('e2', 0), span6('e3', 0)]);
  });

  it('dangling/sentinel 场景解析 miss → 原引用（灰片无章语义可重写）', () => {
    const sentinel = graph([
      { id: 'p1', lineTags: ['main'], storyTime: 1, role: 'normal', presentationOrder: po6(PENDING_CHAPTER_SENTINEL) },
    ]);
    expect(applyResizeSpanRange(sentinel, 'p1', 0, 1, EPS())).toBe(sentinel);
  });

  it('不改写输入图（输入不变异）', () => {
    const g = graph([
      { id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po6(0) },
    ]);
    const snapshot = JSON.parse(JSON.stringify(g));
    applyResizeSpanRange(g, 's1', 0, 2, EPS());
    expect(g).toEqual(snapshot);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 T1 实测列命中：columnIndexFromRects（纯反查；拒收=表外/列缝）
// ─────────────────────────────────────────────────────────────────────────────

describe('columnIndexFromRects (§6.3 实测列命中)', () => {
  /** 三连续列（gap 章 index 1 缺席——真实布局里其轨道仍占宽度，rect 相邻无缝）。 */
  const entries = [
    { index: 0, left: 100, width: 110 },
    { index: 2, left: 210, width: 120 },
    { index: 3, left: 330, width: 100 },
  ];

  it('列内命中 → 该列 index；右缘属于下一列（左闭右开）', () => {
    expect(columnIndexFromRects(entries, 150)).toBe(0);
    expect(columnIndexFromRects(entries, 250)).toBe(2);
    expect(columnIndexFromRects(entries, 400)).toBe(3);
    // 边界：x == 前一列右缘 == 后一列左缘 → 后一列。
    expect(columnIndexFromRects(entries, 210)).toBe(2);
    expect(columnIndexFromRects(entries, 330)).toBe(3);
  });

  it('表外（首列前/末列后）→ null 拒收（右侧紧邻待编排带，不可误送末章）', () => {
    expect(columnIndexFromRects(entries, 99)).toBeNull();
    expect(columnIndexFromRects(entries, 430)).toBeNull();
  });

  it('畸形表防御：空表/零宽/非整数 index/NaN 输入 → null，永不 throw', () => {
    expect(columnIndexFromRects([], 5)).toBeNull();
    expect(columnIndexFromRects([{ index: 0, left: 0, width: 0 }], 5)).toBeNull();
    expect(columnIndexFromRects([{ index: 0.5, left: 0, width: 10 }], 5)).toBeNull();
    expect(columnIndexFromRects(entries, Number.NaN)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R11：buildNewSceneAtChapterAction —— 因果列头 ＋ 与工作台槽位新建钮的构造单源
// ─────────────────────────────────────────────────────────────────────────────

describe('buildNewSceneAtChapterAction (R11 两区同源构造)', () => {
  it('chapter 钳为非负整数、pos 追加章尾、storyTime=max+1、默认线=聚焦线∥主线', () => {
    const eps = episodeOutlinesSchema.parse([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
    ]);
    // shadowGraph 单线 l1；聚焦线显式传入验证优先级。
    const action = buildNewSceneAtChapterAction(shadowGraph(), 1, {
      episodes: eps,
      focusedLineId: 'l1',
    });
    expect(action.op).toBe('add_scene');
    expect(action.scene.id).toBe('S-1'); // shadowGraph 无 S-n 形态 id → 从 1 起步
    expect(action.scene.storyTime).toBe(4);
    expect(action.scene.lineTags).toEqual(['l1']);
    expect(action.scene.presentationOrder.chapter).toBe(1);
  });

  it('未知聚焦线回退主线（resolveDefaultLineId 单源复用）', () => {
    const action = buildNewSceneAtChapterAction(shadowGraph(), 0, { focusedLineId: 'ghost' });
    expect(action.op).toBe('add_scene');
    expect(action.scene.lineTags).toEqual(['l1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R11 批3：buildInsertChapterActions —— 「在两章间插入新章」的双字段批次单源
// （episode 章表 k 位新章 + 既有 >= k 章 index+1；场景裸章号同步右移；
//   spans 按 episodeId 引用天然安全漂移；哨兵不动）
// ─────────────────────────────────────────────────────────────────────────────

describe('buildInsertChapterActions (R11 批3 插入新章)', () => {
  const EPS = () =>
    episodeOutlinesSchema.parse([
      { id: 'e0', index: 0, title: '第一章' },
      { id: 'e1', index: 1, title: '第二章' },
      { id: 'e2', index: 2, title: '第三章' },
    ]);

  /**
   * 混合形态图：s0@ch0（不动）/ s1@ch1·s2@ch2（右移）+ s_span(spans e0,e2, po ch0,
   * pos 5——遮蔽裸值不动) + s_sent(哨兵——不动)。
   */
  function insertGraph(): SceneGraph {
    return parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        { id: 's0', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
        { id: 's1', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 2 } },
        { id: 's2', lineTags: ['l1'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 2, pos: 7 } },
        {
          id: 's_span', lineTags: ['l1'], storyTime: 4, role: 'normal',
          presentationOrder: { chapter: 0, pos: 5 },
          presentationSpans: [{ episodeId: 'e0', pos: 5 }, { episodeId: 'e2', pos: 0 }],
        },
        { id: 's_sent', lineTags: ['l1'], storyTime: 9, role: 'normal', presentationOrder: { chapter: PENDING_CHAPTER_SENTINEL, pos: 0 } },
      ],
      edges: [],
    });
  }

  it('双字段批次：k 后章 index+1 + 新章落 k；裸章 >= k 场景 +1（哨兵/spans 字段零触碰）', () => {
    const g = insertGraph();
    const eps = EPS();
    const plan = buildInsertChapterActions(g, eps, 1, '新章');
    expect(plan).not.toBeNull();
    // ── episode 半：投影后 k=1 起新章、旧章右移（id 稳定）。──
    const nextEps = applyEpisodeActions(eps, plan!.episodeActions);
    expect(nextEps).toHaveLength(4);
    expect(nextEps.map((e) => `${e.id}@${e.index}`).sort()).toEqual(['e0@0', 'e1@2', 'e2@3', 'ep-1@1']);
    const added = nextEps.find((e) => e.id === plan!.episodeId)!;
    expect(added.title).toBe('新章');
    expect(added.status).toBe('planned'); // 机械默认显式补齐（schema-shaped 即刻成立）
    // ── scene 半：s1→2、s2→3；s0 不动；s_span 裸章号 < k 不动且 spans 原样；
    //    哨兵不动。──
    const nextGraph = applySceneGraphActions(g, plan!.sceneActions);
    const byId = new Map(nextGraph.nodes.map((n) => [n.id, n.presentationOrder]));
    expect(byId.get('s0')).toEqual({ chapter: 0, pos: 0 });
    expect(byId.get('s1')).toEqual({ chapter: 2, pos: 2 }); // pos 原样保留
    expect(byId.get('s2')).toEqual({ chapter: 3, pos: 7 });
    expect(byId.get('s_span')).toEqual({ chapter: 0, pos: 5 });
    expect(nextGraph.nodes.find((n) => n.id === 's_span')!.presentationSpans)
      .toEqual([{ episodeId: 'e0', pos: 5 }, { episodeId: 'e2', pos: 0 }]);
    expect(byId.get('s_sent')).toEqual({ chapter: PENDING_CHAPTER_SENTINEL, pos: 0 });
  });

  it('spans 漂移联证：投影后解析口径随章表右移（s_span e2 段落进新 index 3）', () => {
    const g = insertGraph();
    const eps = EPS();
    const plan = buildInsertChapterActions(g, eps, 1, '新章')!;
    const nextEps = applyEpisodeActions(eps, plan.episodeActions);
    const nextGraph = applySceneGraphActions(g, plan.sceneActions);
    const byId = new Map(nextEps.map((e) => [e.id, e] as const));
    const byIndex = new Map(nextEps.map((e) => [e.index, e] as const));
    const range = resolveSceneChapterRange(
      nextGraph.nodes.find((n) => n.id === 's_span')!,
      byId,
      byIndex
    );
    // e0→0、e2→3：spans 零触碰而解算区间漂移到 [0..3]（byId 引用的安全漂移性）。
    expect(range).toEqual({ colStart: 0, colEnd: 3 });
  });

  it('sceneActions 空集：图内无 >= k 裸章场景 → []（调用方跳过 scene_graph 写——引用级 no-op 纪律）', () => {
    const eps = EPS();
    const plan = buildInsertChapterActions(insertGraph(), eps, 3, '尾插前章');
    expect(plan!.sceneActions).toEqual([]); // 最大裸章 2（哨兵除外）→ 无位移面
    expect(plan!.episodeActions).toHaveLength(1); // 无既有章 >= 3 → 仅 add_episode
  });

  it('守卫：非数组 episodes / NaN·Infinity insertAt → null；负 insertAt 钳 0（全体右移）', () => {
    expect(buildInsertChapterActions(insertGraph(), undefined as never, 1, 'x')).toBeNull();
    expect(buildInsertChapterActions(insertGraph(), {} as never, 1, 'x')).toBeNull();
    const g = insertGraph();
    expect(buildInsertChapterActions(g, EPS(), Number.NaN, 'x')).toBeNull();
    const atZero = buildInsertChapterActions(g, EPS(), -3, 'x')!;
    // k=0：三章全右移 + s0/s_span 裸章 0 也右移（0 >= 0）。
    const nextGraph = applySceneGraphActions(g, atZero.sceneActions);
    expect(nextGraph.nodes.find((n) => n.id === 's0')!.presentationOrder.chapter).toBe(1);
    expect(nextGraph.nodes.find((n) => n.id === 's_sent')!.presentationOrder.chapter)
      .toBe(PENDING_CHAPTER_SENTINEL);
  });

  it('不改写输入（图与章表均不变异）', () => {
    const g = insertGraph();
    const eps = EPS();
    const gSnap = JSON.parse(JSON.stringify(g));
    const epsSnap = JSON.parse(JSON.stringify(eps));
    const plan = buildInsertChapterActions(g, eps, 1, '新章')!;
    applyEpisodeActions(eps, plan.episodeActions);
    applySceneGraphActions(g, plan.sceneActions);
    expect(g).toEqual(gSnap);
    expect(eps).toEqual(epsSnap);
  });
});
