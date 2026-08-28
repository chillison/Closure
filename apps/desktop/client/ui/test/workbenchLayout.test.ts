/**
 * 08-26 结构页重构 批 3（implement 3.1/3.3）：融合网格派生纯函数测试
 * （workbenchLayout.ts——WeavingPanel/weavingLayout 的承接）。
 *
 * 覆盖（implement 批 3 测试清单）：
 *  - resolveSceneChapterRange 三级解析（自 weavingLayout.test 迁移）；
 *  - chips 按 readIndex 升序（layout.ts readPosition 派生单源——勿重写）；
 *  - 倒叙判定（readIndex vs storyRank 错位）；
 *  - span chip（colStart/colEnd range）；
 *  - 待编排列收纳（dangling fixture——design §2 缺口补齐）；
 *  - 行序 orderLinesByPriority / gapped chapter tracks（F1 dense 轨道）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run workbenchLayout`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  sceneGraphSchema,
  episodeOutlineSchema,
  episodeOutlinesSchema,
  type SceneGraph,
  type SceneNodeRole,
  type LineTopologyRole,
} from '@orison/shared-contracts';
import {
  deriveReadIndexByNode,
  orderLinesByPriority,
} from '../src/features/structure/layout';
import {
  deriveWorkbenchLayout,
  episodeTrackCountOf,
  MAX_CHAPTER_TRACKS,
  PENDING_CHAPTER_SENTINEL,
  PENDING_COLUMN_SENTINEL,
  resolveSceneChapterRange,
  WORKBENCH_GEOMETRY,
} from '../src/features/structure/workbenchLayout';

// EpisodeOutline isn't exported from shared-contracts — infer locally
// (same pattern as SceneEditPopover.tsx / workbenchLayout.ts).
type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

// ── fixtures ──
function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}
function parseEpisodes(raw: unknown): EpisodeOutline[] {
  return episodeOutlinesSchema.parse(raw);
}

const po = (chapter: number, pos = 0) => ({ chapter, pos });
const span = (episodeId: string, pos = 0) => ({ episodeId, pos });

/** Build a scene node with optional presentationSpans / episodeId. */
const scene = (
  id: string,
  lineTags: string[],
  opts: {
    chapter?: number;
    pos?: number;
    spans?: { episodeId: string; pos: number }[];
    episodeId?: string;
    role?: SceneNodeRole;
    storyTime?: number;
    title?: string;
  } = {}
) => ({
  id,
  lineTags,
  storyTime: opts.storyTime ?? 0,
  role: opts.role ?? 'normal',
  presentationOrder: po(opts.chapter ?? 0, opts.pos ?? 0),
  ...(opts.title !== undefined ? { title: opts.title } : {}),
  ...(opts.spans ? { presentationSpans: opts.spans } : {}),
  ...(opts.episodeId ? { episodeId: opts.episodeId } : {}),
});

const line = (id: string, name: string, topology_role: LineTopologyRole = 'converging') => ({
  id,
  name,
  topology_role,
});

/** episode builder: id + index (+ optional title). */
const ep = (id: string, index: number, title = `Chapter ${index}`) => ({ id, index, title });

// ─────────────────────────────────────────────────────────────────────────────
// resolveSceneChapterRange（自 weavingLayout.test 原样迁移——签名/行为不变）
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveSceneChapterRange', () => {
  const eps = parseEpisodes([ep('e0', 0), ep('e1', 1), ep('e2', 2), ep('e3', 3)]);
  const byId = new Map(eps.map((e) => [e.id, e] as const));
  const byIndex = new Map(eps.map((e) => [e.index, e] as const));

  it('presentationSpans multi → min..max range (cross-chapter)', () => {
    const r = resolveSceneChapterRange(scene('s', [], { spans: [span('e0'), span('e2')] }), byId, byIndex);
    expect(r).toEqual({ colStart: 0, colEnd: 2 });
  });

  it('presentationSpans single → colStart === colEnd', () => {
    const r = resolveSceneChapterRange(scene('s', [], { spans: [span('e1')] }), byId, byIndex);
    expect(r).toEqual({ colStart: 1, colEnd: 1 });
  });

  it('episodeId legacy (no spans) → single column', () => {
    const r = resolveSceneChapterRange(scene('s', [], { episodeId: 'e2' }), byId, byIndex);
    expect(r).toEqual({ colStart: 2, colEnd: 2 });
  });

  it('presentationOrder.chapter fallback (no spans, no episodeId) → episode at that index', () => {
    const r = resolveSceneChapterRange(scene('s', [], { chapter: 3 }), byId, byIndex);
    expect(r).toEqual({ colStart: 3, colEnd: 3 });
  });

  it('all dangling (span ref missing + no episodeId + chapter no match) → null', () => {
    const r = resolveSceneChapterRange(
      scene('s', [], { chapter: 99, spans: [span('ghost')] }),
      byId,
      byIndex
    );
    expect(r).toBeNull();
  });

  it('partial dangling spans → uses the resolvable span', () => {
    const r = resolveSceneChapterRange(
      scene('s', [], { spans: [span('ghost'), span('e3')] }),
      byId,
      byIndex
    );
    expect(r).toEqual({ colStart: 3, colEnd: 3 });
  });

  it('element-level poison in spans (null / non-object) skipped, never throws (#126)', () => {
    // 全坏元素 → 无可解析 → 落 chapter fallback（这里 99 dangling）。
    const allBad = scene('s', [], { chapter: 99 }) as unknown as {
      presentationSpans: unknown[];
    };
    allBad.presentationSpans = [null, 42];
    expect(resolveSceneChapterRange(allBad as never, byId, byIndex)).toBeNull();

    // 混合：坏元素跳过，好元素照常解析。
    const mixed = scene('s', [], { chapter: 99 }) as unknown as {
      presentationSpans: unknown[];
    };
    mixed.presentationSpans = [null, span('e2')];
    expect(resolveSceneChapterRange(mixed as never, byId, byIndex)).toEqual({
      colStart: 2,
      colEnd: 2,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveReadIndexByNode（readPosition 派生单源——工作台 chip 序号的数据源）
// ─────────────────────────────────────────────────────────────────────────────
describe('deriveReadIndexByNode', () => {
  it('sorts by presentationOrder.{chapter,pos}, stable by array order on ties', () => {
    const nodes = parseGraph({
      nodes: [
        scene('s_c', [], { chapter: 0, pos: 2 }),
        scene('s_a', [], { chapter: 0, pos: 0 }),
        scene('s_b', [], { chapter: 0, pos: 1 }),
        scene('s_d', [], { chapter: 1, pos: 0 }),
      ],
    }).nodes;
    const idx = deriveReadIndexByNode(nodes);
    expect(idx.get('s_a')).toBe(0);
    expect(idx.get('s_b')).toBe(1);
    expect(idx.get('s_c')).toBe(2);
    expect(idx.get('s_d')).toBe(3);
  });

  it('identical (chapter,pos) tie-broken by original array order (stable)', () => {
    const nodes = parseGraph({
      nodes: [
        scene('s2', [], { chapter: 0, pos: 0 }),
        scene('s1', [], { chapter: 0, pos: 0 }),
      ],
    }).nodes;
    const idx = deriveReadIndexByNode(nodes);
    expect(idx.get('s2')).toBe(0);
    expect(idx.get('s1')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveWorkbenchLayout
// ─────────────────────────────────────────────────────────────────────────────
describe('deriveWorkbenchLayout: cols + tracks', () => {
  it('cols are episodes sorted by index; trackCount = maxIndex+1 (gapped F1)', () => {
    // Episodes at indices [0, 2] (gap at 1) → trackCount 3（空轨道诚实留白）.
    const eps = parseEpisodes([ep('e2', 2), ep('e0', 0)]);
    const layout = deriveWorkbenchLayout(parseGraph({}), eps);
    expect(layout.cols.map((c) => c.index)).toEqual([0, 2]);
    expect(layout.chapterTrackCount).toBe(3);
  });

  it('no episodes → 0 tracks, no cols（全部场景进待编排列）', () => {
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [scene('s1', ['main'], { chapter: 0 })],
    });
    const layout = deriveWorkbenchLayout(graph, []);
    expect(layout.cols).toEqual([]);
    expect(layout.chapterTrackCount).toBe(0);
    expect(layout.slots.size).toBe(0);
    expect(layout.pendingByLine.get('main')).toHaveLength(1);
  });

  it('undefined episode_outlines (partial hydration) → no crash, all pending', () => {
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [scene('s1', ['main'], { chapter: 0 })],
    });
    const layout = deriveWorkbenchLayout(graph, undefined);
    expect(layout.chapterTrackCount).toBe(0);
    expect(layout.pendingByLine.get('main')).toHaveLength(1);
  });
});

describe('deriveWorkbenchLayout: slot chips', () => {
  it('chips land in their (line, start-chapter) slot, sorted by readIndex ascending', () => {
    // s_late reads 3rd (pos 2) but sits in chapter 0; s_early reads 1st (pos 0).
    const eps = parseEpisodes([ep('e0', 0), ep('e1', 1)]);
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [
        scene('s_late', ['main'], { chapter: 0, pos: 2 }),
        scene('early', ['main'], { chapter: 0, pos: 0 }),
        scene('s_ch1', ['main'], { chapter: 1, pos: 1 }),
      ],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    const ch0 = layout.slots.get('main|0')!;
    expect(ch0.map((c) => c.nodeId)).toEqual(['early', 's_late']); // readIndex 升序
    expect(ch0.map((c) => c.readIndex)).toEqual([0, 1]);
    expect(layout.slots.get('main|1')!.map((c) => c.nodeId)).toEqual(['s_ch1']);
  });

  it('cross-chapter scene (presentationSpans) → chip carries the span range', () => {
    const eps = parseEpisodes([ep('e0', 0), ep('e1', 1), ep('e2', 2)]);
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [scene('s1', ['main'], { spans: [span('e0'), span('e2')] })],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    // chip renders in the START chapter slot（mockup #mergedGrid 拍板）.
    const chip = layout.slots.get('main|0')![0]!;
    expect(chip.colStart).toBe(0);
    expect(chip.colEnd).toBe(2);
    expect(layout.slots.get('main|1')).toBeUndefined();
    expect(layout.slots.get('main|2')).toBeUndefined();
  });

  it('multi-line node → one chip per valid lineTag, all sharing the range', () => {
    const eps = parseEpisodes([ep('e0', 0), ep('e1', 1)]);
    const graph = parseGraph({
      lines: [line('lA', 'A'), line('lB', 'B')],
      nodes: [scene('s1', ['lA', 'lB'], { spans: [span('e0'), span('e1')] })],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    expect(layout.slots.get('lA|0')).toHaveLength(1);
    expect(layout.slots.get('lB|0')).toHaveLength(1);
  });

  it('dangling lineTag (refs no line) → chip skipped for that tag only', () => {
    const eps = parseEpisodes([ep('e0', 0)]);
    const graph = parseGraph({
      lines: [line('lA', 'A')],
      nodes: [scene('s1', ['lA', 'ghost'], { chapter: 0 })],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    expect(layout.slots.get('lA|0')).toHaveLength(1);
    expect(layout.pendingByLine.size).toBe(0);
  });

  it('rows use orderLinesByPriority（与因果骨架泳道同序）', () => {
    const eps = parseEpisodes([ep('e0', 0)]);
    const graph = parseGraph({
      lines: [
        { ...line('side', 'Side', 'side') },
        { ...line('main', 'Main', 'converging'), is_main_thread: true },
      ],
      nodes: [],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    expect(layout.rows.map((r) => r.lineId)).toEqual(['main', 'side']);
    expect(layout.rows.map((r) => ({ lineId: r.lineId, name: r.name }))).toEqual(
      orderLinesByPriority(graph.lines)
    );
  });
});

describe('deriveWorkbenchLayout: 倒叙判定（readIndex vs storyRank）', () => {
  it('reading order diverging from story chronology → reordered true; aligned → false', () => {
    // s_late happens LAST causally (storyTime 3) but reads FIRST (ch0/pos0);
    // s_early happens FIRST (storyTime 1) but reads SECOND (ch0/pos1).
    const eps = parseEpisodes([ep('e0', 0)]);
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [
        scene('s_late', ['main'], { chapter: 0, pos: 0, storyTime: 3 }),
        scene('s_early', ['main'], { chapter: 0, pos: 1, storyTime: 1 }),
      ],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    const byNode = new Map([...layout.slots.values()].flat().map((c) => [c.nodeId, c]));
    expect(byNode.get('s_late')!.reordered).toBe(true); // storyRank 1 ≠ readIndex 0
    expect(byNode.get('s_early')!.reordered).toBe(true); // storyRank 0 ≠ readIndex 1
  });

  it('fully chronological graph → no reordered chips', () => {
    const eps = parseEpisodes([ep('e0', 0), ep('e1', 1)]);
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [
        scene('s1', ['main'], { chapter: 0, pos: 0, storyTime: 1 }),
        scene('s2', ['main'], { chapter: 1, pos: 0, storyTime: 2 }),
      ],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    for (const chip of [...layout.slots.values()].flat()) {
      expect(chip.reordered).toBe(false);
    }
  });

  it('parallel scenes sharing storyTime are NOT reordered by intra-tie reading order (#120)', () => {
    // A、B 同 storyTime=2 并行（故事里同时发生）；阅读序 B 先 A 后——并列内部
    // 的先后只是排序，不是时间位移，双双不该点钢蓝（组1-E 并列豁免）。
    const eps = parseEpisodes([ep('e0', 0)]);
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [
        scene('s_a', ['main'], { chapter: 0, pos: 1, storyTime: 2 }),
        scene('s_b', ['main'], { chapter: 0, pos: 0, storyTime: 2 }),
      ],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    const byNode = new Map([...layout.slots.values()].flat().map((c) => [c.nodeId, c]));
    expect(byNode.get('s_a')!.reordered).toBe(false);
    expect(byNode.get('s_b')!.reordered).toBe(false);
  });

  it('cross-layer displacement still flags both endpoints after the tie exemption', () => {
    // 对照组：经典倒叙（st3 读最前、st1 读其次、st2 读最后）两端照旧点亮。
    const eps = parseEpisodes([ep('e0', 0)]);
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [
        scene('s_late', ['main'], { chapter: 0, pos: 0, storyTime: 3 }),
        scene('s_early', ['main'], { chapter: 0, pos: 1, storyTime: 1 }),
        scene('s_mid', ['main'], { chapter: 0, pos: 2, storyTime: 2 }),
      ],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    const byNode = new Map([...layout.slots.values()].flat().map((c) => [c.nodeId, c]));
    expect(byNode.get('s_late')!.reordered).toBe(true);
    expect(byNode.get('s_early')!.reordered).toBe(true);
    expect(byNode.get('s_mid')!.reordered).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 待编排列（dangling 收纳——design §2 缺口补齐）
// ─────────────────────────────────────────────────────────────────────────────
describe('deriveWorkbenchLayout: pending column', () => {
  it('dangling scenes (chapter matches no episode) collect into pendingByLine, readIndex-sorted', () => {
    const eps = parseEpisodes([ep('e0', 0)]); // only index 0
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [
        scene('s_dang2', ['main'], { chapter: 99, pos: 1 }),
        scene('s_ok', ['main'], { chapter: 0, pos: 2 }),
        scene('s_dang1', ['main'], { chapter: 5, pos: 0 }),
      ],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    expect(layout.slots.get('main|0')!.map((c) => c.nodeId)).toEqual(['s_ok']);
    // readIndex：s_ok (ch0) 0 → s_dang1 (ch5) 1 → s_dang2 (ch99) 2 → 升序排列。
    const pending = layout.pendingByLine.get('main')!;
    expect(pending.map((c) => c.nodeId)).toEqual(['s_dang1', 's_dang2']);
    expect(pending.every((c) => c.readIndex >= 0)).toBe(true);
  });

  it('dangling chip keeps title/role for grey rendering', () => {
    const eps = parseEpisodes([ep('e0', 0)]);
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [scene('s_ghost', ['main'], { chapter: 42, role: 'core-anchor', title: '深夜的访客' })],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    const chip = layout.pendingByLine.get('main')![0]!;
    expect(chip.title).toBe('深夜的访客');
    expect(chip.role).toBe('core-anchor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 几何常量（design §3.1 分轴宽度策略）
// ─────────────────────────────────────────────────────────────────────────────
describe('WORKBENCH_GEOMETRY', () => {
  it('chapter min width 108 / chip max width ~212（design §3.1 拍板值）', () => {
    expect(WORKBENCH_GEOMETRY.chapterMinWidth).toBe(108);
    expect(WORKBENCH_GEOMETRY.chipMaxWidth).toBeGreaterThanOrEqual(200);
    expect(WORKBENCH_GEOMETRY.chipMaxWidth).toBeLessThanOrEqual(220);
  });
});

// ── R7 计数器化后的几何单源：封顶枚数常量 + pending 哨兵合法性 ──
// （「+N」溢出徽标已退役——pendingOverflowCount/measuredPendingOverflow 随唯一
//   消费面删除；每线待编排总数由 .lane-pending-counter 直接读派生数据，无需换算。）

describe('WORKBENCH_GEOMETRY: pending cap single source (R7)', () => {
  it('threshold is the geometry single source = 3（初见可见枚数）', () => {
    expect(WORKBENCH_GEOMETRY.pendingStackVisibleCount).toBe(3);
  });

  it('pending chapter sentinel is schema-valid (int, nonnegative) and far from real chapters', () => {
    // schema: chapter int().nonnegative()——哨兵必须落在合法域内（#63 撤章写入）。
    expect(Number.isInteger(PENDING_CHAPTER_SENTINEL)).toBe(true);
    expect(PENDING_CHAPTER_SENTINEL).toBeGreaterThanOrEqual(0);
    expect(PENDING_CHAPTER_SENTINEL).toBeGreaterThan(1000);
  });

  it('derive emits the explicit pending discriminant on both chip kinds (鸭子探测退役)', () => {
    const eps = parseEpisodes([ep('e0', 0)]);
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [
        scene('s_in', ['main'], { chapter: 0 }),
        scene('s_out', ['main'], { chapter: 42 }),
      ],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    const inChip = layout.slots.get('main|0')![0]!;
    expect(inChip.pending).toBe(false);
    expect(layout.slots.get('main|0')!.every((c) => c.pending === false)).toBe(true);
    const outChip = layout.pendingByLine.get('main')![0]!;
    expect(outChip.pending).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR 组1 #125：稠密轨道数封顶（离群 episode index 防线）——界外章按「无可归属
// 轨道」处理，引用它的场景走既有待编排列收纳（与 dangling 同语义、零写入）。
// CR 组1 #121：deriveReadIndexByNode 坏输入矩阵（缺/坏 presentationOrder → 稳定
// 末位，不 throw 不 NaN 污染）。
// ─────────────────────────────────────────────────────────────────────────────
describe('MAX_CHAPTER_TRACKS guard (CR 组1 #125)', () => {
  it('界外章的列头被截断，chapterTrackCount 封顶', () => {
    const eps = parseEpisodes([
      ep('e0', 0),
      ep('e2', 2),
      ep(`e${MAX_CHAPTER_TRACKS + 7}`, MAX_CHAPTER_TRACKS + 7), // 离群 index
    ]);
    const layout = deriveWorkbenchLayout(parseGraph({}), eps);
    expect(layout.cols.map((c) => c.index)).toEqual([0, 2]); // 界外列头不入网格
    expect(layout.chapterTrackCount).toBe(3);
  });

  it('场景解析落在封顶域之外 → 与 dangling 同语义进待编排列（零 episode 写入）', () => {
    const far = MAX_CHAPTER_TRACKS + 3;
    const eps = parseEpisodes([ep(`e${far}`, far)]);
    const graph = parseGraph({
      lines: [line('main', 'Main')],
      nodes: [scene('s_far', ['main'], { chapter: far })],
    });
    const layout = deriveWorkbenchLayout(graph, eps);
    expect(layout.chapterTrackCount).toBe(0);     // 列域内无任何真实章
    expect(layout.slots.size).toBe(0);
    expect(layout.pendingByLine.get('main')!.map((c) => c.nodeId)).toEqual(['s_far']);
    expect(layout.causalPending.get(`main|-1`)?.map((c) => c.nodeId)).toEqual(['s_far']);
    // 边锚端点随 pending 化（哨兵 colValue）。
    expect(layout.primaryCellByNode.get('s_far')).toEqual({
      lineId: 'main', colValue: PENDING_COLUMN_SENTINEL, subIndex: 0,
    });
  });

  it('episodeTrackCountOf 与派生同界（宿主模板口径不失同步）', () => {
    expect(episodeTrackCountOf([{ index: 0 }, { index: MAX_CHAPTER_TRACKS - 1 }]))
      .toBe(MAX_CHAPTER_TRACKS);
    expect(episodeTrackCountOf([{ index: MAX_CHAPTER_TRACKS + 900 }])).toBe(0);
    expect(episodeTrackCountOf([{ index: MAX_CHAPTER_TRACKS + 900 }, { index: 5 }])).toBe(6);
    expect(episodeTrackCountOf('nonsense')).toBe(0);
  });
});

describe('deriveReadIndexByNode malformed presentationOrder (CR 组1 #121)', () => {
  /** 绕过 schema 构造坏形态节点（store cast 的 unknown 注水面）。 */
  const rawNode = (id: string, po: unknown) =>
    ({
      id, lineTags: [], storyTime: 0, role: 'normal',
      ...(po === undefined ? {} : { presentationOrder: po }),
    }) as unknown as Parameters<typeof deriveReadIndexByNode>[0][number];

  const ordered = (id: string, chapter: number, pos: number) =>
    rawNode(id, { chapter, pos });

  it('缺字段 / 非对象 / 非有限数字 → 派生 total（全节点入 Map），无 throw 无 NaN', () => {
    const nodes = [
      ordered('a', 0, 0),
      rawNode('missing', undefined),
      rawNode('null-po', null),
      rawNode('str-po', 'oops'),
      rawNode('nan-pos', { chapter: 1, pos: Number.NaN }),
      rawNode('inf-chapter', { chapter: Number.POSITIVE_INFINITY, pos: 0 }),
      ordered('b', 5, 0),
    ];
    const m = deriveReadIndexByNode(nodes);
    expect(m.size).toBe(nodes.length); // total：坏输入也有序号
    for (const n of nodes) expect(m.has(n.id)).toBe(true);
  });

  it('有序者按 (chapter,pos) 在前（原序稳定）；坏键整体收敛在全部有秩序之后', () => {
    const nodes = [
      rawNode('bad1', undefined),
      ordered('first', 0, 0),
      rawNode('bad2', { chapter: 0, pos: Number.NaN }),
      ordered('last-ordered', 9, 9),
    ];
    const order = [...deriveReadIndexByNode(nodes).entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
    // 有序段：ch0 < ch9，相对序保持。
    expect(order.slice(0, 2)).toEqual(['first', 'last-ordered']);
    // 无效序整体垫底（稳定末位选型），且相互按原数组序稳定（bad1 先于 bad2）。
    expect(order.slice(-2)).toEqual(['bad1', 'bad2']);
  });
});
