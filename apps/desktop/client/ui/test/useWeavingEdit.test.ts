/**
 * Story 1.10 W3 (design §6) + R6 §6.3：useWeavingEdit 纯函数测试。
 * «± 新增/减少章节»手势整体退役（R6 方案 D——span 编辑退居边缘直拖，
 * applyAddChapter/applyRemoveChapter 随唯一消费者删除），其测试一并撤销；
 * 区间写通道的覆盖迁移到 sceneGraphEditModel.test 的 applyResizeSpanRange 套件。
 *
 * 本文件现覆盖：
 *  - applyWithinChapterDrop（章内 pos 重排——语义不变；CR3 G-edge：多章宽卡成员
 *    不入重排面，po.pos=spans[0].pos 锚不被写飞）
 *  - applyWorkbenchSlotDrop（§6.3 槽位落点写分派：宽卡平移保持宽度（投回自身区间
 *    =取消式投放）/ 兄弟重排（双方单章）/ 挪章（含 pending·dangling 灰片补挂章节）
 *    / gap 拒收 / 非数组守卫）——hook 是其上的 I/O 三明治
 *
 * Run: `cd apps/desktop/client/ui && pnpm test useWeavingEdit`
 */
import { describe, expect, it } from 'vitest';
import { sceneGraphSchema, episodeOutlinesSchema } from '@orison/shared-contracts';
import {
  applyWorkbenchSlotDrop,
  applyWithinChapterDrop,
} from '../src/features/structure/useWeavingEdit';
import type { SceneGraph } from '@orison/shared-contracts';
import { PENDING_CHAPTER_SENTINEL } from '../src/features/structure/workbenchLayout';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}
function parseEpisodes(raw: unknown) {
  return episodeOutlinesSchema.parse(raw);
}

const EPS = () =>
  parseEpisodes([
    { id: 'e0', index: 0, title: 'C0' },
    { id: 'e1', index: 1, title: 'C1' },
    { id: 'e2', index: 2, title: 'C2' },
  ]);

const po = (chapter: number, pos = 0) => ({ chapter, pos });
const span = (episodeId: string, pos = 0) => ({ episodeId, pos });

/** one-line graph from a list of raw nodes (schema-parsed). */
function graph(nodes: unknown[]): SceneGraph {
  return parseGraph({
    lines: [{ id: 'main', name: 'Main', topology_role: 'converging', is_main_thread: true }],
    nodes,
    edges: [],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// applyWithinChapterDrop
// ─────────────────────────────────────────────────────────────────────────────
describe('applyWithinChapterDrop', () => {
  it('reorders dragged before target within the same chapter (renumber pos)', () => {
    // chapter 0: s1 pos0, s2 pos1, s3 pos2. Drop s3 before s1 → s3 pos0, s1 pos1, s2 pos2.
    const g = graph([
      { id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0, 0) },
      { id: 's2', lineTags: ['main'], storyTime: 1, role: 'normal', presentationOrder: po(0, 1) },
      { id: 's3', lineTags: ['main'], storyTime: 2, role: 'normal', presentationOrder: po(0, 2) },
    ]);
    const out = applyWithinChapterDrop(g, 's3', 's1');
    const byId = new Map(out.nodes.map((n) => [n.id, n.presentationOrder.pos]));
    expect(byId.get('s3')).toBe(0); // dragged now before target
    expect(byId.get('s1')).toBe(1);
    expect(byId.get('s2')).toBe(2);
  });

  it('cross-chapter drop → no-op (chapter reassignment is the drop/move channels job)', () => {
    const g = graph([
      { id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0, 0) },
      { id: 's2', lineTags: ['main'], storyTime: 1, role: 'normal', presentationOrder: po(1, 0) },
    ]);
    const out = applyWithinChapterDrop(g, 's2', 's1');
    expect(out).toBe(g); // unchanged reference
  });

  it('drop on itself → no-op', () => {
    const g = graph([
      { id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0, 0) },
    ]);
    expect(applyWithinChapterDrop(g, 's1', 's1')).toBe(g);
  });

  it('only the shared chapter renumbers; other chapters untouched', () => {
    // chapter 0: a1 pos0, a2 pos1. chapter 1: b1 pos0. Drop a2 before a1.
    const g = graph([
      { id: 'a1', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0, 0) },
      { id: 'a2', lineTags: ['main'], storyTime: 1, role: 'normal', presentationOrder: po(0, 1) },
      { id: 'b1', lineTags: ['main'], storyTime: 2, role: 'normal', presentationOrder: po(1, 0) },
    ]);
    const out = applyWithinChapterDrop(g, 'a2', 'a1');
    const byId = new Map(out.nodes.map((n) => [n.id, n.presentationOrder]));
    expect(byId.get('a2')?.pos).toBe(0);
    expect(byId.get('a1')?.pos).toBe(1);
    expect(byId.get('b1')).toEqual(po(1, 0)); // chapter 1 untouched
  });

  // ── CR 组 5 批 A：章内重排三洞修复的回归钉 ──

  it('CR-三洞①: a third-party member WITHOUT presentationOrder no longer TypeErrors（?. 化）', () => {
    // 手工构造缺 presentationOrder 的第三方成员——schema 会补默认，故不走 parse。
    const g = {
      nodes: [
        { id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0, 0) },
        { id: 'broken3rd', lineTags: ['main'], storyTime: 1, role: 'normal' }, // 无章形态
        { id: 's2', lineTags: ['main'], storyTime: 2, role: 'normal', presentationOrder: po(0, 2) },
      ],
      lines: [{ id: 'main', name: 'Main', topology_role: 'converging' }],
      edges: [],
    } as unknown as SceneGraph;
    expect(() => applyWithinChapterDrop(g, 's2', 's1')).not.toThrow();
    const out = applyWithinChapterDrop(g, 's2', 's1');
    const byId = new Map(
      (out.nodes as SceneGraph['nodes']).map((n) => [n.id, n.presentationOrder?.pos])
    );
    expect(byId.get('s2')).toBe(0);
    expect(byId.get('s1')).toBe(1);
    expect(byId.get('broken3rd')).toBeUndefined(); // 缺章形态不被写入
  });

  it('CR-三洞②: pending-stack grey chips dragging each other → ORIGINAL reference (隐形重编号写零发生)', () => {
    const sentinel = { chapter: PENDING_CHAPTER_SENTINEL, pos: 0 };
    const g = graph([
      { id: 'p1', lineTags: ['main'], storyTime: 1, role: 'normal', presentationOrder: sentinel },
      { id: 'p2', lineTags: ['main'], storyTime: 2, role: 'normal', presentationOrder: { ...sentinel } },
    ]);
    expect(applyWithinChapterDrop(g, 'p1', 'p2')).toBe(g);
  });

  it('CR-三洞③: same VISUAL cell with divergent raw chapters now reorders via the resolved lens (曾是 silent no-op)', () => {
    // s_legacy 裸章号 0 但 episodeId 指向 e1；s_direct 裸章号 1。两者解析视觉格同为章 1
    // ——旧实现按裸章号分组把 s_legacy 排除在共享章外（静默 no-op），现在统一按解析。
    const eps = EPS();
    const g = graph([
      { id: 's_legacy', lineTags: ['main'], storyTime: 1, role: 'normal', presentationOrder: po(0, 4), episodeId: 'e1' },
      { id: 's_direct', lineTags: ['main'], storyTime: 2, role: 'normal', presentationOrder: po(1, 0) },
    ]);
    const out = applyWithinChapterDrop(g, 's_direct', 's_legacy', eps);
    const byId = new Map(out.nodes.map((n) => [n.id, n.presentationOrder.pos]));
    expect(byId.get('s_direct')).toBe(0); // dragged moved before target
    expect(byId.get('s_legacy')).toBe(1);
  });

  it('unchanged order → SAME reference (引用级 no-op——handler 借此跳过整次 updateField)', () => {
    const g = graph([
      { id: 's1', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0, 0) },
      { id: 's2', lineTags: ['main'], storyTime: 1, role: 'normal', presentationOrder: po(0, 1) },
      { id: 's3', lineTags: ['main'], storyTime: 2, role: 'normal', presentationOrder: po(0, 2) },
    ]);
    // s2 已紧跟 s1 之后：拖 s1 到 s2（原序不变）→ 原图返回。
    expect(applyWithinChapterDrop(g, 's1', 's2')).toBe(g);
  });

  // ── CR3 G-edge：多章（宽卡）成员不入章内重排面——po.pos 是 spans[0].pos 的锚 ──

  it('宽成员的 po.pos（=spans[0].pos 锚）不被章内重编号写飞', () => {
    const eps = EPS();
    const g = graph([
      { id: 'a', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0, 0) },
      { id: 'b', lineTags: ['main'], storyTime: 1, role: 'normal', presentationOrder: po(0, 1) },
      {
        id: 'w', lineTags: ['main'], storyTime: 2, role: 'normal',
        presentationOrder: po(0, 5), presentationSpans: [span('e0', 5), span('e1', 0)],
      },
    ]);
    const out = applyWithinChapterDrop(g, 'b', 'a', eps);
    const w = out.nodes.find((n) => n.id === 'w')!;
    expect(w.presentationOrder.pos).toBe(5); // 锚不动
    expect(w.presentationSpans?.[0]?.pos).toBe(5); // 与 spans[0] 不 desync
    // 单章成员照常重编号。
    expect(out.nodes.find((n) => n.id === 'b')!.presentationOrder.pos).toBe(0);
    expect(out.nodes.find((n) => n.id === 'a')!.presentationOrder.pos).toBe(1);
  });

  it('被拖者自身为宽卡（直调路径）→ 原引用（重排仅限单章成员）', () => {
    const eps = EPS();
    const g = graph([
      { id: 'a', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0, 0) },
      {
        id: 'w', lineTags: ['main'], storyTime: 1, role: 'normal',
        presentationOrder: po(0, 5), presentationSpans: [span('e0', 5), span('e1', 0)],
      },
    ]);
    expect(applyWithinChapterDrop(g, 'w', 'a', eps)).toBe(g);
  });

  it('宽卡作为重排 target（直调路径）→ 原引用（target 不在重排面内，防御性 no-op）', () => {
    const eps = EPS();
    const g = graph([
      { id: 'a', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0, 0) },
      {
        id: 'w', lineTags: ['main'], storyTime: 1, role: 'normal',
        presentationOrder: po(0, 5), presentationSpans: [span('e0', 5), span('e1', 0)],
      },
    ]);
    expect(applyWithinChapterDrop(g, 'a', 'w', eps)).toBe(g);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyWorkbenchSlotDrop（§6.3 槽位落点写分派纯编排；R6/R1 新缝的机械层全覆盖）
// ─────────────────────────────────────────────────────────────────────────────

describe('applyWorkbenchSlotDrop (§6.3 槽位路由)', () => {
  /** 单线五场景夹具：sa/sd 同章（0），sb 章1，ss 宽卡 e0..e2，dang 悬空。 */
  const wideGraph = () =>
    graph([
      { id: 'sa', lineTags: ['main'], storyTime: 1, role: 'normal', presentationOrder: po(0, 0), title: '甲' },
      { id: 'sd', lineTags: ['main'], storyTime: 2, role: 'normal', presentationOrder: po(0, 1), title: '丁' },
      { id: 'sb', lineTags: ['main'], storyTime: 3, role: 'normal', presentationOrder: po(1, 0), title: '乙' },
      {
        id: 'ss', lineTags: ['main'], storyTime: 4, role: 'normal',
        presentationOrder: po(0, 2), title: '跨章场',
        presentationSpans: [span('e0'), span('e1'), span('e2')],
      },
      { id: 'dang', lineTags: ['main'], storyTime: 9, role: 'normal', presentationOrder: po(42, 0), title: '悬空' },
    ]);

  it('targetChapter null（gap 章/列缝/待编排带命中）→ 原引用拒收，零写入前提', () => {
    const g = wideGraph();
    expect(applyWorkbenchSlotDrop(g, { nodeId: 'sa', targetChapter: null, episodes: EPS() })).toBe(g);
  });

  it('gap 章 index 不在已建域 → 原引用（面锚回退可能给出未建章号——二次校验）', () => {
    const g = wideGraph();
    expect(applyWorkbenchSlotDrop(g, { nodeId: 'sa', targetChapter: 7, episodes: EPS() })).toBe(g);
  });

  it('单章场景投掷空槽 → 挪章一次成型（引用级变化，AC2 数据半）', () => {
    const out = applyWorkbenchSlotDrop(wideGraph(), {
      nodeId: 'sa',
      targetChapter: 1,
      episodes: EPS(),
    });
    const sa = out.nodes.find((n) => n.id === 'sa')!;
    expect(sa.presentationOrder.chapter).toBe(1);
  });

  it('落点表面是同格兄弟 chip 且解析列一致 → 章内重排（pos 重编号、章号不动）', () => {
    const out = applyWorkbenchSlotDrop(wideGraph(), {
      nodeId: 'sd',
      targetChapter: 0,
      episodes: EPS(),
      hitSiblingId: 'sa',
    });
    const byPos = new Map(out.nodes.filter((n) => n.id !== 'ss').map((n) => [n.id, n.presentationOrder.pos]));
    // sd 插到 sa 之前：sd 0 / sa 1。
    expect(byPos.get('sd')).toBe(0);
    expect(byPos.get('sa')).toBe(1);
    expect(out.nodes.find((n) => n.id === 'sb')!.presentationOrder.chapter).toBe(1);
  });

  it('宽卡投掷他列 → 整区间平移保持宽度（不塌缩成起点单章——AC10 操作半接线）', () => {
    // 目标 3：自身区间 [0..2] **之外**（CR3 G-F2 后投回自身覆盖列是取消式投放，
    // 见下一条用例）；EPS 五域下真实平移到 [2..4]。
    const eps5 = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e3', index: 3, title: 'C3' },
      { id: 'e4', index: 4, title: 'C4' },
    ]);
    const out = applyWorkbenchSlotDrop(wideGraph(), {
      nodeId: 'ss',
      targetChapter: 3,
      episodes: eps5,
    });
    const ss = out.nodes.find((n) => n.id === 'ss')!;
    expect(ss.presentationSpans?.map((s) => s.episodeId)).toEqual(['e2', 'e3', 'e4']); // 宽度保持
  });

  it('宽卡投回自身覆盖列 = 取消式投放 → 原引用（CR3 G-F2：拖起又放回零位移写）', () => {
    // 旧实现以 T 锚定平移：宽卡 [0..2] 放回自身中段列 1 → 写 [1..3]——无意图手势
    // 产生真实位移写（版本 bump / undo 入栈 / 落盘）。现为整区间取消式投放。
    const eps5 = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e3', index: 3, title: 'C3' },
      { id: 'e4', index: 4, title: 'C4' },
    ]);
    const g = wideGraph(); // ss 区间 [0..2]
    for (const t of [0, 1, 2]) {
      expect(applyWorkbenchSlotDrop(g, { nodeId: 'ss', targetChapter: t, episodes: eps5 })).toBe(g);
    }
  });

  it('宽卡平移钳制域与渲染侧同口径：界外离群 index 不撑大钳制域（CR3 G-F4）', () => {
    // index 600 界外（渲染侧 MAX_CHAPTER_TRACKS=512 截断）：旧 raw max=600 → 投末列 4
    // 被钳到 start=4 → [4..6] 端点 miss 整手势吞；新口径 maxBuilt=4 → start=min(4,2)=2
    // → [2..4] 真平移。
    const eps6 = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e3', index: 3, title: 'C3' },
      { id: 'e4', index: 4, title: 'C4' },
      { id: 'e600', index: 600, title: 'C600' },
    ]);
    const out = applyWorkbenchSlotDrop(wideGraph(), { nodeId: 'ss', targetChapter: 4, episodes: eps6 });
    expect(out.nodes.find((n) => n.id === 'ss')!.presentationSpans?.map((s) => s.episodeId)).toEqual(
      ['e2', 'e3', 'e4']
    );
  });

  it('钳制落点撞 gap → 降列到最近全建区间（不吞手势——CR3 G-edge）', () => {
    // index 3 缺号：宽卡 [0..1] 投列 2 → 理想区间 [2..3] 撞缺号 → 降到 [1..2]。
    const epsGap = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e4', index: 4, title: 'C4' },
      { id: 'e5', index: 5, title: 'C5' },
    ]);
    const g = graph([
      {
        id: 'w', lineTags: ['main'], storyTime: 0, role: 'normal',
        presentationOrder: po(0), presentationSpans: [span('e0'), span('e1')], // [0..1]
      },
    ]);
    const out = applyWorkbenchSlotDrop(g, { nodeId: 'w', targetChapter: 2, episodes: epsGap });
    expect(out.nodes[0]!.presentationSpans?.map((s) => s.episodeId)).toEqual(['e1', 'e2']);
  });

  it('宽卡平移无可落位（钳制+降列走完仍落回原区间）→ 引用级 no-op', () => {
    // index 3 缺号——[0..2] 之外无稠密三连段：投列 4 → 钳 start=2 → [2..4] 撞 gap →
    // 降列到 0 → 与现状内容相等 → 原引用（整手势零写入）。
    const epsGap = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e4', index: 4, title: 'C4' },
    ]);
    const g = wideGraph();
    expect(applyWorkbenchSlotDrop(g, { nodeId: 'ss', targetChapter: 4, episodes: epsGap })).toBe(g);
  });

  it('dangling 灰片拖入章格 = 补挂章节（CR3 auditor：§6.3「其余=挪章」——旧静默封锁已修）', () => {
    // dang 裸章 42 不在已建域 → 解析 miss。旧实现 `if (!draggedRange) return graph`
    // 把灰片→章格通道一并封锁（与因果区 useTimelineEdit.onDrop 失同步）；现走
    // applyChapterDrop 补挂目标章。
    const g = wideGraph();
    const out = applyWorkbenchSlotDrop(g, { nodeId: 'dang', targetChapter: 1, episodes: EPS() });
    const dang = out.nodes.find((n) => n.id === 'dang')!;
    expect(dang.presentationOrder.chapter).toBe(1);
    expect(out).not.toBe(g);
  });

  it('pending 哨兵灰片拖入章格 → 剥遮蔽残锚 + 章号改写（与因果区同语义）', () => {
    const g = graph([
      {
        id: 'p1', lineTags: ['main'], storyTime: 1, role: 'normal',
        presentationOrder: po(PENDING_CHAPTER_SENTINEL, 3), episodeId: 'ep-ghost', // 悬空残锚
      },
      { id: 'sa', lineTags: ['main'], storyTime: 0, role: 'normal', presentationOrder: po(0) },
    ]);
    const out = applyWorkbenchSlotDrop(g, { nodeId: 'p1', targetChapter: 2, episodes: EPS() });
    const p1 = out.nodes.find((n) => n.id === 'p1')!;
    expect(p1.presentationOrder.chapter).toBe(2);
    expect(p1.episodeId).toBeUndefined(); // dangling 残锚剥除——补挂后不被解析序复活
  });

  it('非数组 episodes → 原引用不 throw（CR-001 parity 守卫——CR3 G-edge）', () => {
    const g = wideGraph();
    expect(
      applyWorkbenchSlotDrop(g, { nodeId: 'sa', targetChapter: 1, episodes: {} as never })
    ).toBe(g);
    expect(
      applyWorkbenchSlotDrop(g, { nodeId: 'ss', targetChapter: 1, episodes: undefined as never })
    ).toBe(g);
  });

  it('落点表面是宽卡（同列 sibling）→ 不入重排面，退挪章分支零写入（CR3 G-edge）', () => {
    const g = wideGraph(); // ss 宽卡 @章 0 起 [0..2]；sa 单章 @0 无遮蔽
    // 旧实现会让宽 sibling 参与章内重编号（po.pos=spans[0].pos 锚被写飞）；
    // 现直接落 applyChapterDrop：内容相等（sa 已在章 0）→ 原引用。
    expect(
      applyWorkbenchSlotDrop(g, { nodeId: 'sa', targetChapter: 0, episodes: EPS(), hitSiblingId: 'ss' })
    ).toBe(g);
  });

  it('输入图不被变异', () => {
    const g = wideGraph();
    const snapshot = JSON.parse(JSON.stringify(g));
    applyWorkbenchSlotDrop(g, { nodeId: 'sa', targetChapter: 2, episodes: EPS() });
    expect(g).toEqual(snapshot);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T16b（发现批8·真机红「宽卡 8→7 能拖、7→8 拖不回」）：originCol 位移式平移矩阵。
// 真机形态：宽卡 spans [6..7]（第 7~8 章）从锚列拖到自身覆盖列——旧 G-F2 取消
// 判据把整个覆盖区判成静默取消（「反复拖没反应」）；位移语义 = 落列 − 抓起列，
// 仅位移 0（拖起放回）保留取消。缺省 originCol 的旧路径行为零变化（上方既有
// 用例组即其回归锚）。
// ─────────────────────────────────────────────────────────────────────────────

describe('applyWorkbenchSlotDrop T16b 位移式平移（originCol）', () => {
  /** 九章域（0..8）+ 宽卡 w spans [e6..e7]（len=1，锚列 6）。 */
  const EPS9 = () =>
    parseEpisodes(Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, index: i, title: `C${i}` })));
  const wide67 = () =>
    graph([
      {
        id: 'w', lineTags: ['main'], storyTime: 0, role: 'normal',
        presentationOrder: po(6), presentationSpans: [span('e6'), span('e7')], title: '宽',
      },
    ]);
  const spansOf = (out: SceneGraph) =>
    out.nodes[0]!.presentationSpans!.map((s) => s.episodeId);

  it('[6..7] 抓@6 投7 → 位移 +1 平移 [7..8]（自身覆盖列内落点不再静默取消）', () => {
    const out = applyWorkbenchSlotDrop(wide67(), {
      nodeId: 'w', targetChapter: 7, episodes: EPS9(), originCol: 6,
    });
    expect(spansOf(out)).toEqual(['e7', 'e8']);
  });

  it('抓@6 投6（位移 0 = 拖起放回）→ 原引用零写', () => {
    const g = wide67();
    expect(
      applyWorkbenchSlotDrop(g, { nodeId: 'w', targetChapter: 6, episodes: EPS9(), originCol: 6 })
    ).toBe(g);
  });

  it('抓@6 投4 → 位移 −2 平移 [4..5]', () => {
    const out = applyWorkbenchSlotDrop(wide67(), {
      nodeId: 'w', targetChapter: 4, episodes: EPS9(), originCol: 6,
    });
    expect(spansOf(out)).toEqual(['e4', 'e5']);
  });

  it('边界钳制：[6..7] 抓@6 投7 于八章域（右缘已是末章）→ 钳回等区间原引用', () => {
    // 八章（0..7）：位移 +1 的理想区间 [7..8] 越已建域 → 钳 maxBuilt−len=6 →
    // [6..7] 内容相等 → 原引用（边界处位移不可兑现即不兑现）。
    const eps8 = parseEpisodes(
      Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, index: i, title: `C${i}` }))
    );
    const g = wide67();
    expect(
      applyWorkbenchSlotDrop(g, { nodeId: 'w', targetChapter: 7, episodes: eps8, originCol: 6 })
    ).toBe(g);
  });

  it('位移落点撞 gap → 降列到最近全建区间（walk 复用既有逻辑）', () => {
    // 章 3 缺号：宽 [0..1] 抓@0 投2 → 理想 [2..3] 撞缺号 → 降 [1..2]。
    const epsGap = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e4', index: 4, title: 'C4' },
      { id: 'e5', index: 5, title: 'C5' },
    ]);
    const g = graph([
      {
        id: 'w', lineTags: ['main'], storyTime: 0, role: 'normal',
        presentationOrder: po(0), presentationSpans: [span('e0'), span('e1')],
      },
    ]);
    const out = applyWorkbenchSlotDrop(g, {
      nodeId: 'w', targetChapter: 2, episodes: epsGap, originCol: 0,
    });
    expect(spansOf(out)).toEqual(['e1', 'e2']);
  });

  it('目标章自身未建（gap 章）→ 顶部守卫原引用拒收（位移路径同守卫）', () => {
    const epsGap = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e4', index: 4, title: 'C4' },
      { id: 'e5', index: 5, title: 'C5' },
    ]);
    const g = graph([
      {
        id: 'w', lineTags: ['main'], storyTime: 0, role: 'normal',
        presentationOrder: po(0), presentationSpans: [span('e0'), span('e1')],
      },
    ]);
    expect(
      applyWorkbenchSlotDrop(g, { nodeId: 'w', targetChapter: 3, episodes: epsGap, originCol: 0 })
    ).toBe(g);
  });

  it('对照（同夹具 A/B）：originCol 缺省 + 覆盖列内落点 = 旧行为取消原引用（G-F2 缺省路径原样）', () => {
    const g = wide67();
    // 7 ∈ [6..7] 覆盖区且无 originCol → 旧取消判据（与首条位移用例的 A/B 分叉锚）。
    expect(
      applyWorkbenchSlotDrop(g, { nodeId: 'w', targetChapter: 7, episodes: EPS9() })
    ).toBe(g);
  });
});
