/**
 * Story 1.5 Phase C 承接（批 7 前的 deriveTimelineLayout 纯函数测试 → 章轴单源）。
 *
 * ── 08-26 结构页重构 批 7（design §11「同构锁步」定案 1/5）──
 * `deriveTimelineLayout`（storyTime 分桶 + readPosition 双轴）随因果骨架换轴退役；
 * 因果骨架与工作台由 **deriveWorkbenchLayout 单源派生**共用一份数据面。本文件改锁
 * 换轴后的因果镜像契约：causalSlots（章桶 + 故事时序 subIndex）/ primaryCellByNode /
 * edges 锚定 / dangling 容忍 / 行序 / CR-010 dedupe——全走真实管线（episode 池夹具，
 * 不手搓中间形态）。layout.ts 自身保留的三件套（isSceneGraphLike /
 * orderLinesByPriority / deriveReadIndexByNode）单测在本文件尾部。
 *
 * Run: `cd apps/desktop/client/ui && pnpm test sceneGraphLayout`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { describe, expect, it } from 'vitest';
import { sceneGraphSchema, type SceneGraph, type SceneNodeRole, type LineTopologyRole } from '@orison/shared-contracts';
import { deriveReadIndexByNode, isSceneGraphLike, orderLinesByPriority } from '../src/features/structure/layout';
import {
  deriveWorkbenchLayout,
  episodeTrackCountOf,
  PENDING_COLUMN_SENTINEL,
} from '../src/features/structure/workbenchLayout';
import { poolFor } from './helpers/episodePool';

// ── fixtures ──
function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

// episode 池夹具单源（曾与 volumeBands.test 逐字节复制——CR 组 1 测试卫生抽共享；
// 含 legacy episodeId 兼容）。

const causal = (id: string, from: string, to: string) => ({ id, from, to, type: 'CAUSAL' as const });
const suspense = (id: string, from: string, to: string) => ({ id, from, to, type: 'SUSPENSE' as const });

const line = (id: string, name: string, topology_role: LineTopologyRole = 'converging') => ({
  id,
  name,
  topology_role
});

/** 场景简写：归属章 = 列语义（storyTime 只参与桶内故事时序排序）。 */
const node = (
  id: string,
  lineTags: string[],
  chapter: number,
  opts: { pos?: number; storyTime?: number; role?: SceneNodeRole } = {}
) => ({
  id,
  lineTags,
  storyTime: opts.storyTime ?? chapter,
  role: opts.role ?? ('normal' as const),
  presentationOrder: { chapter, pos: opts.pos ?? 0 },
});

function derive(graph: SceneGraph) {
  return deriveWorkbenchLayout(graph, poolFor(graph));
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) empty graph → empty layout
// ─────────────────────────────────────────────────────────────────────────────
describe('causal mirror: empty graph', () => {
  it('returns all-empty structures for a defaulted graph', () => {
    const wb = derive(parseGraph({}));
    expect(wb.rows).toEqual([]);
    expect(wb.cols).toEqual([]);
    expect(wb.chapterTrackCount).toBe(0);
    expect([...wb.causalSlots.values()]).toHaveLength(0);
    expect([...wb.causalPending.values()]).toHaveLength(0);
    expect(wb.primaryCellByNode.size).toBe(0);
    expect(wb.edges).toEqual([]);
  });

  it('nodes without lines → rows/cards empty, tracks still derive from episode data', () => {
    const wb = derive(parseGraph({ nodes: [node('s1', ['l1'], 3)] }));
    expect(wb.rows).toEqual([]);
    expect([...wb.causalSlots.values()]).toHaveLength(0);
    // 列头只列真实 episode（章 3）；轨道稠密覆盖 gap（0..2 诚实空）。
    expect(wb.cols.map((c) => c.index)).toEqual([3]);
    expect(wb.chapterTrackCount).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b/c) 卡归属：每 (node × valid lineTag) 一枚卡；colValue = 起始章
// ─────────────────────────────────────────────────────────────────────────────
describe('causal mirror: card placement on the chapter axis', () => {
  it('single scene → one card carrying role, keyed by its chapter', () => {
    const wb = derive(parseGraph({
      nodes: [node('s1', ['l1'], 1, { role: 'core-anchor', storyTime: 4 })],
      lines: [line('l1', '主线')]
    }));
    expect(wb.rows).toEqual([{ lineId: 'l1', name: '主线' }]);
    expect(wb.causalSlots.get('l1|1')).toEqual([
      // multiline 单线恒 false（T26 ②：valid lineTags 数 >1 才真——运行时恒写入）。
      { nodeId: 's1', lineId: 'l1', colValue: 1, role: 'core-anchor', title: undefined, subIndex: 0, multiline: false },
    ]);
  });

  it('multi-line node emits one card per valid lineTag (all subIndex 0 in their own buckets)', () => {
    const wb = derive(parseGraph({
      nodes: [node('s1', ['l1', 'l2'], 1)],
      lines: [line('l1', '主线'), line('l2', '副线', 'parallel-worldview')]
    }));
    const l1 = wb.causalSlots.get('l1|1')!;
    const l2 = wb.causalSlots.get('l2|1')!;
    expect(l1).toHaveLength(1);
    expect(l2).toHaveLength(1);
    expect(l1[0].subIndex).toBe(0);
    expect(l2[0].subIndex).toBe(0);
  });

  it('跨章 span 场景只落起始章一格（不复刻 chip 的 span 渲染——密度差即视图价值差）', () => {
    const g = parseGraph({
      nodes: [
        // spans e0..e2 的跨章场景。
        {
          id: 's_span', lineTags: ['l1'], storyTime: 1, role: 'normal',
          presentationOrder: { chapter: 0, pos: 0 },
          presentationSpans: [{ episodeId: 'e0', pos: 0 }, { episodeId: 'e2', pos: 1 }],
        },
        { id: 's_next', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 3, pos: 0 } },
      ],
      lines: [line('l1', '主线')],
    });
    const wb = derive(g);
    // 仅一章 0 有卡；章 1/2 无卡片但轨道保留（cols 含全部真实 episode、trackCount=4）。
    expect(wb.causalSlots.get('l1|0')).toHaveLength(1);
    expect(wb.causalSlots.get('l1|1')).toBeUndefined();
    expect(wb.causalSlots.get('l1|2')).toBeUndefined();
    expect(wb.causalSlots.get('l1|3')).toHaveLength(1);
    expect(wb.chapterTrackCount).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) 同格碰撞：故事时序排序驱动 subIndex（cell-stack DOM 序与端点分位共此源）
// ─────────────────────────────────────────────────────────────────────────────
describe('causal mirror: bucket collision ordered by story chronology', () => {
  it('cards in one (line, chapter) bucket sort by storyTime then stable array order; subIndex renumbered', () => {
    // 插入序故意打乱：late 定义在前、early 在后——故事时序仍是 early 先。
    const g = parseGraph({
      nodes: [
        node('s_late', ['l1'], 1, { storyTime: 9 }),
        node('s_early', ['l1'], 1, { storyTime: 2 }),
        node('s_mid', ['l1'], 1, { storyTime: 5 }),
        node('s_other_ch', ['l1'], 2, { storyTime: 0 }),
      ],
      lines: [line('l1', '主线')]
    });
    const wb = derive(g);
    const bucket = wb.causalSlots.get('l1|1')!;
    expect(bucket.map((c) => c.nodeId)).toEqual(['s_early', 's_mid', 's_late']);
    expect(bucket.map((c) => c.subIndex)).toEqual([0, 1, 2]);
    // 别章独立计数。
    expect(wb.causalSlots.get('l1|2')![0].subIndex).toBe(0);
  });

  it('same storyTime tie falls back to original array order', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1'], 1), node('s2', ['l1'], 1)],
      lines: [line('l1', '主线')]
    });
    const wb = derive(g);
    expect(wb.causalSlots.get('l1|1')!.map((c) => c.nodeId)).toEqual(['s1', 's2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) 行序（两区同线同行——orderLinesByPriority 单源的直测 + 派生消费）
// ─────────────────────────────────────────────────────────────────────────────
describe('lane ordering (shared by both zones)', () => {
  it('main-thread first, then topology priority, stable within each priority group', () => {
    const parsed = parseGraph({
      lines: [
        line('l_side', '支线', 'side'),
        line('l_conv_b', '汇聚B', 'converging'),
        line('l_main', '主线', 'converging'),
        line('l_conv_a', '汇聚A', 'converging'),
        line('l_mesh', '网状', 'parallel-worldview')
      ]
    });
    const g2 = parseGraph({
      lines: (parsed.lines as { is_main_thread?: boolean }[]).map((l) =>
        l.id === 'l_main' ? { ...l, is_main_thread: true } : l
      )
    });
    const rows = deriveWorkbenchLayout(g2, undefined).rows.map((r) => r.lineId);
    expect(rows).toEqual(['l_main', 'l_conv_b', 'l_conv_a', 'l_mesh', 'l_side']);
  });

  it('topology priority when no main-thread set: converging → mesh → offline → if-branch → side', () => {
    const g = parseGraph({
      lines: [
        line('l_side', 's', 'side'),
        line('l_if', 'i', 'if-branch'),
        line('l_off', 'o', 'offline'),
        line('l_mesh', 'm', 'parallel-worldview'),
        line('l_conv', 'c', 'converging')
      ]
    });
    const rows = deriveWorkbenchLayout(g, undefined).rows.map((r) => r.lineId);
    expect(rows).toEqual(['l_conv', 'l_mesh', 'l_off', 'l_if', 'l_side']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (g/h) dangling 容忍：lineTag 悬空 → 卡跳过；边端点悬空 → 边跳过；零 throw
// ─────────────────────────────────────────────────────────────────────────────
describe('causal mirror: dangling tolerance', () => {
  it('drops cards whose lineTag resolves to no line, keeps resolvable ones', () => {
    const wb = derive(parseGraph({
      nodes: [node('s1', ['l1', 'ghost'], 1)],
      lines: [line('l1', '主线')]
    }));
    expect(wb.causalSlots.size).toBe(1);
    expect(wb.causalSlots.get('l1|1')).toHaveLength(1);
  });

  it('never throws when every lineTag is dangling; chapterless scenes only hit pending', () => {
    const g = parseGraph({
      nodes: [
        { id: 's1', lineTags: ['ghost1', 'ghost2'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 42, pos: 0 } },
      ],
      lines: [],
    });
    const wb = deriveWorkbenchLayout(g, poolFor(g));
    expect(() => wb).not.toThrow();
    expect([...wb.causalSlots.values()]).toHaveLength(0);
    expect([...wb.pendingByLine.values()]).toHaveLength(0); // 无合法线 → 待编排也无归属行
  });

  it('skips edges whose endpoint node is missing or has no resolvable card', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1'], 1), node('s_orphan', [], 2)],
      edges: [
        causal('e_dangling', 's1', 'ghost'),
        causal('e_orphan', 's1', 's_orphan'),
        causal('e_ok', 's1', 's1'),
      ],
      lines: [line('l1', '主线')]
    });
    const wb = derive(g);
    expect(wb.edges.map((e) => e.edgeId)).toEqual(['e_ok']);
  });

  it('preserves CAUSAL/SUSPENSE types on resolved edges', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1'], 1), node('s2', ['l1'], 2)],
      edges: [causal('e1', 's1', 's2'), suspense('e2', 's1', 's2')],
      lines: [line('l1', '主线')]
    });
    expect(derive(g).edges.map((e) => [e.edgeId, e.type])).toEqual([
      ['e1', 'CAUSAL'],
      ['e2', 'SUSPENSE'],
    ]);
  });

  it('self-edge resolves both endpoints to the same cell', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1'], 1)],
      edges: [causal('e_self', 's1', 's1')],
      lines: [line('l1', '主线')]
    });
    const wb = derive(g);
    expect(wb.edges).toHaveLength(1);
    expect(wb.edges[0].from).toEqual(wb.edges[0].to);
  });

  it('待编排场景的端点走哨兵列（关联线 anchoring 的 pending 镜像前提）', () => {
    const g = parseGraph({
      // 章 42 无对应 episode（池显式给空——裁剪池会把它解析成真章）→ pending。
      nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 42, pos: 0 } }],
      edges: [],
      lines: [line('l1', '主线')]
    });
    const wb = deriveWorkbenchLayout(g, []);
    expect(wb.primaryCellByNode.get('s1')).toMatchObject({
      lineId: 'l1',
      colValue: PENDING_COLUMN_SENTINEL,
      subIndex: 0,
    });
    expect(wb.causalPending.get('l1|-1')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-004：primaryCellByNode 查表（首 valid tag + 重排后位次回填）
// ─────────────────────────────────────────────────────────────────────────────
describe('primaryCellByNode lookup maps (CR-004 carry-over)', () => {
  it('maps each node to its first VALID lineTag cell', () => {
    const g = parseGraph({
      nodes: [node('s1', ['ghost', 'l_main'], 1)],
      lines: [line('l_main', '主线'), line('l_side', '副线', 'side')]
    });
    expect(derive(g).primaryCellByNode.get('s1')).toMatchObject({ lineId: 'l_main' });
  });

  it('carries the collision subIndex AFTER the story-chronology reorder', () => {
    // s_fast(storyTime 1) 排 s_slow(storyTime 9) 前——primary 位次随之回填。
    const g = parseGraph({
      nodes: [
        node('s_slow', ['l1'], 1, { storyTime: 9 }),
        node('s_fast', ['l1'], 1, { storyTime: 1 }),
      ],
      lines: [line('l1', '主线')]
    });
    const wb = derive(g);
    expect(wb.primaryCellByNode.get('s_slow')?.subIndex).toBe(1);
    expect(wb.primaryCellByNode.get('s_fast')?.subIndex).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-010：重复 lineTags 去重（一卡一线，桶不被虚增）
// ─────────────────────────────────────────────────────────────────────────────
describe('duplicate lineTags deduped (CR-010)', () => {
  it('emits ONE card per (node, unique lineTag)', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1', 'l1'], 1)],
      lines: [line('l1', '主线')]
    });
    const wb = derive(g);
    expect(wb.causalSlots.get('l1|1')).toHaveLength(1);
    expect(wb.slots.get('l1|1')).toHaveLength(1); // 工作台侧同净
  });

  it('dedupes per-tag across a multi-tag node', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l_main', 'l_main', 'l_side', 'l_side'], 1)],
      lines: [line('l_main', '主线'), line('l_side', '副线', 'side')]
    });
    const cards = [...derive(g).causalSlots.values()].flat();
    expect(cards).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数不变式 + 宿主基数单源
// ─────────────────────────────────────────────────────────────────────────────
describe('pure-function invariants + track-count single source', () => {
  it('same input → structurally equal output (deterministic)', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1', 'l2'], 1), node('s2', ['l1'], 1, { storyTime: 2 })],
      edges: [causal('e1', 's1', 's2')],
      lines: [line('l1', '主线'), line('l2', '副线', 'side')]
    });
    const snapshotA = JSON.stringify(mapSnap(derive(g)));
    const snapshotB = JSON.stringify(mapSnap(derive(g)));
    expect(snapshotA).toBe(snapshotB);
  });

  it('does not mutate the input graph', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1'], 1), node('s2', ['l1'], 2)],
      edges: [causal('e1', 's1', 's2')],
      lines: [line('l1', '主线')]
    });
    const snapshot = JSON.parse(JSON.stringify(g)) as typeof g;
    derive(g);
    expect(g).toEqual(snapshot);
  });

  it('episodeTrackCountOf: host template base mirrors the derivation count', () => {
    // 与 deriveWorkbenchLayout 的 maxChapterIndex+1 同一口径（宿主直调此函数）。
    const eps = [
      { id: 'e0', index: 0, title: '' },
      { id: 'e4', index: 4, title: '' },
    ];
    expect(episodeTrackCountOf(eps)).toBe(5);
    expect(episodeTrackCountOf(undefined)).toBe(0);
    expect(episodeTrackCountOf('nonsense')).toBe(0);
    expect(episodeTrackCountOf([{ index: 2.7 }])).toBe(3); // fractional floor defense
  });
});

/** Map 序敏感的结构快照（键序即插入序——确定性断言的一部分）。 */
function mapSnap(wb: ReturnType<typeof derive>) {
  return {
    rows: wb.rows,
    cols: wb.cols,
    chapterTrackCount: wb.chapterTrackCount,
    causalKeys: [...wb.causalSlots.keys()],
    causalCards: [...wb.causalSlots.values()].flat(),
    pendingKeys: [...wb.causalPending.keys()],
    primaryCells: Object.fromEntries(wb.primaryCellByNode),
    edges: wb.edges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// layout.ts 保留三件套的单测（isSceneGraphLike / orderLinesByPriority /
// deriveReadIndexByNode——阅读序号与倒叙判定的数据源）
// ─────────────────────────────────────────────────────────────────────────────
describe('layout.ts retained helpers', () => {
  it('isSceneGraphLike shape guard rejects partial hydration shapes', () => {
    expect(isSceneGraphLike({ nodes: [], lines: [], edges: [] })).toBe(true);
    expect(isSceneGraphLike(undefined)).toBe(false);
    expect(isSceneGraphLike({ nodes: [] })).toBe(false);
    expect(isSceneGraphLike(null)).toBe(false);
  });

  it('deriveReadIndexByNode: global ordinal by (chapter,pos) stable order', () => {
    const g = parseGraph({
      nodes: [
        { id: 'a', lineTags: ['l1'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 1, pos: 0 } },
        { id: 'b', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 1 } },
        { id: 'c', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      ],
      lines: [line('l1', '主线')]
    });
    const m = deriveReadIndexByNode(g.nodes);
    expect(m.get('c')).toBe(0); // ch0/pos0
    expect(m.get('b')).toBe(1); // ch0/pos1
    expect(m.get('a')).toBe(2); // ch1
  });
});
