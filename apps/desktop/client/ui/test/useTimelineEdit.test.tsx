/**
 * Story 1.5 Phase E3-drag (design §3b / §2.2): useTimelineEdit — the author's
 * direct-gesture edit layer for the timeline.
 *
 * ── 08-26 批 7（design §11 定案 1：因果骨架换轴章轴）──
 * 因果列语义从 storyTime 改为**章归属**（presentationOrder.chapter 直写）。storyTime
 * 拖拽写入族（applyCausalDrop 及其断言）随等距桶退役删除；`applyChapterDrop` 承接
 * 同一批纯函数契约（钳制 / 不变异 / 未知名防御）。章内微调（pos 排序）仍走工作台
 * 的 useWeavingEdit 缝，不在本层。
 *
 * Two test tiers:
 *  1. Pure-function unit tests for `applyChapterDrop`.
 *  2. Integration through NarrativeTimelinePanel — HTML5 DnD simulated with a mock
 *     DataTransfer。夹具带 episode_outlines（章列头/轨道的来源——无 episode 时两区
 *     退化「仅待编排列」，无可落列头）。
 *
 * Run: `cd apps/desktop/client/ui && pnpm test useTimelineEdit`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { episodeOutlinesSchema, sceneGraphSchema, type SceneGraph } from '@orison/shared-contracts';
import { NarrativeTimelinePanel } from '../src/features/structure/NarrativeTimelinePanel';
import { StructurePage } from '../src/features/structure/StructurePage';
import {
  SCENE_DRAG_MIME,
  applyChapterDrop,
  applyPendingDrop,
  encodeDragPayload,
} from '../src/features/structure/useTimelineEdit';
import { PENDING_CHAPTER_SENTINEL } from '../src/features/structure/workbenchLayout';
import { useAppStore } from '../src/shared/store/appStore';

// ── 文件级单 spy（vitest 4 `vi.spyOn` 对已挂 mock 直接复用 × zustand 快照血缘传播
// ——task 08-29-vitest4-ui-migration design §3.1 范式）：updateField 恒挂一次
// （passthrough——写入须真实落库供读回断言），计数由 beforeEach mockClear 按测清；
// 测试体内不再 spyOn / mockRestore。──
const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');

beforeEach(() => {
  updateSpy.mockClear();
});

// ── fixtures ──
function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

const EPISODES = () =>
  episodeOutlinesSchema.parse([
    { id: 'e0', index: 0, title: '第一章' },
    { id: 'e1', index: 1, title: '第二章' },
    { id: 'e2', index: 2, title: '第三章' },
  ]);

const ALL_OVERLAYS_ON = { validation: true, displacement: true, visibility: true };

/**
 * Faithful DataTransfer mock: stores setData/getData in a Map. Our hook only
 * uses setData / getData / effectAllowed / dropEffect / (read of) types, so
 * this covers the full surface without depending on jsdom's MIME handling.
 */
function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData: vi.fn((mime: string, data: string) => {
      store.set(mime, data);
    }),
    getData: vi.fn((mime: string) => store.get(mime) ?? ''),
    clearData: vi.fn((mime?: string) => {
      if (mime !== undefined) store.delete(mime);
      else store.clear();
    }),
    get types() {
      return [...store.keys()];
    },
  } as unknown as DataTransfer;
}

/**
 * Drive a full HTML5 drag-over a panel: dragStart on the source cell, drop on target.
 */
function dragAndDrop(container: HTMLElement, sourceNodeId: string, targetSelector: string): void {
  const cell = container.querySelector(`[data-node-id="${sourceNodeId}"]`) as HTMLElement;
  expect(cell).toBeTruthy();
  const target = container.querySelector(targetSelector) as HTMLElement;
  expect(target).toBeTruthy();
  const dt = makeDataTransfer();
  fireEvent.dragStart(cell, { dataTransfer: dt });
  fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) applyChapterDrop — pure（批 7 章轴语义）
// ─────────────────────────────────────────────────────────────────────────────
describe('applyChapterDrop (pure)', () => {
  it("sets the dragged node's presentationOrder.chapter to the target; other nodes untouched", () => {
    const g = parseGraph({
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } },
        { id: 's2', lineTags: ['l1'], storyTime: 2, presentationOrder: { chapter: 1, pos: 1 } },
        { id: 's3', lineTags: ['l1'], storyTime: 3, presentationOrder: { chapter: 2, pos: 2 } },
      ],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    });
    const next = applyChapterDrop(g, 's1', 2);
    const byId = Object.fromEntries(next.nodes.map((n) => [n.id, n.presentationOrder.chapter]));
    expect(byId).toEqual({ s1: 2, s2: 1, s3: 2 });
    // pos 保持不变（换章不动同章内排序键——微调走工作台缝）。
    expect(next.nodes[0].presentationOrder.pos).toBe(0);
  });

  it('does not mutate the input graph (returns a new object)', () => {
    const g = parseGraph({
      nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } }],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    });
    const snapshot = JSON.parse(JSON.stringify(g));
    applyChapterDrop(g, 's1', 9);
    expect(g).toEqual(snapshot);
  });

  it('clamps a negative target chapter to 0 and a fractional one to its floor', () => {
    const g = parseGraph({
      nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 5, presentationOrder: { chapter: 3, pos: 0 } }],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    });
    expect(applyChapterDrop(g, 's1', -3).nodes[0].presentationOrder.chapter).toBe(0);
    expect(applyChapterDrop(g, 's1', 4.9).nodes[0].presentationOrder.chapter).toBe(4);
  });

  it('returns the graph unchanged when the nodeId is unknown (defensive)', () => {
    const g = parseGraph({
      nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } }],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    });
    const next = applyChapterDrop(g, 'ghost', 9);
    expect(next.nodes).toEqual(g.nodes);
  });

  it('defensive: node without presentationOrder stays untouched (edit path guards like render path)', () => {
    // 绕过 schema 默认值——手工构造缺 presentationOrder 的节点形态。
    const g = {
      ...parseGraph({
        nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } }],
        lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      }),
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal' },
      ],
    } as unknown as SceneGraph;
    const next = applyChapterDrop(g, 's1', 4);
    expect((next.nodes[0] as SceneGraph['nodes'][number]).presentationOrder).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Integration via NarrativeTimelinePanel — HTML5 DnD simulated
// ─────────────────────────────────────────────────────────────────────────────

/** 三场景单线；chapter == 列位（e0..e2 三章轨道——gap 章诚实空轨不进本夹具）。 */
function causalDragFixture(): SceneGraph {
  return parseGraph({
    lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    nodes: [
      { id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's2', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 0 } },
      { id: 's3', lineTags: ['l1'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 2, pos: 0 } },
    ],
    edges: [],
  });
}

function setStateWith(graph: SceneGraph) {
  useAppStore.setState({
    creativeFields: { scene_graph: graph, episode_outlines: EPISODES() },
    overlayToggles: { ...ALL_OVERLAYS_ON },
    resolvedLocale: 'en-US',
    currentProject: null,
  } as any);
}

describe('useTimelineEdit via NarrativeTimelinePanel (integration, chapter axis)', () => {
  beforeEach(() => {
    setStateWith(causalDragFixture());
  });

  afterEach(() => {
    cleanup();
  });

  it('causal drag: drop s1 on the third-chapter column → s1 lands in chapter 2; other nodes unchanged', () => {

    const { container } = render(<NarrativeTimelinePanel />);
    // 章轨道 [0,1,2]。data-drop-col=2 即第三章列头/轨道。
    dragAndDrop(container, 's1', '[data-drop-col="2"]');

    const next = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const byId = Object.fromEntries(next.nodes.map((n) => [n.id, n.presentationOrder.chapter]));
    expect(byId).toEqual({ s1: 2, s2: 1, s3: 2 });
    // Write happened exactly once on drop (not per dragover).
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('scene_graph');
  });

  it('causal drag: drop on the scene’s own chapter column → no write (no-op)', () => {

    const { container } = render(<NarrativeTimelinePanel />);
    // s1 在章 0 → 轨道 0。drop 回自身列 = no-op。
    dragAndDrop(container, 's1', '[data-drop-col="0"]');

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('drop on a cell-stack wrapper (not just column header) resolves to that chapter', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const s3CellStack = container.querySelector('[data-node-id="s3"]')!.closest('[data-drop-col]') as HTMLElement;
    expect(s3CellStack).toBeTruthy();
    const cell = container.querySelector('[data-node-id="s1"]') as HTMLElement;
    const dt = makeDataTransfer();
    fireEvent.dragStart(cell, { dataTransfer: dt });
    fireEvent.dragOver(s3CellStack, { dataTransfer: dt });
    fireEvent.drop(s3CellStack, { dataTransfer: dt });

    const next = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const s1 = next.nodes.find((n) => n.id === 's1')!;
    // s3 在章 2 → s1 落那里 → 归属章 2。
    expect(s1.presentationOrder.chapter).toBe(2);
  });

  it('multi-line node drag: the node’s single field updates; all its cards move on re-render', () => {
    const multi = parseGraph({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '副线', topology_role: 'side' },
      ],
      nodes: [
        { id: 's1', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
        { id: 's2', lineTags: ['l_main', 'l_side'], storyTime: 2, role: 'core-anchor', presentationOrder: { chapter: 0, pos: 1 } },
        { id: 's3', lineTags: ['l_side'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 2, pos: 0 } },
      ],
      edges: [],
    });
    setStateWith(multi);

    const { container } = render(<NarrativeTimelinePanel />);
    const s2CardsBefore = container.querySelectorAll('[data-node-id="s2"]');
    expect(s2CardsBefore).toHaveLength(2);

    dragAndDrop(container, 's2', '[data-drop-col="2"]');

    const next = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const s2 = next.nodes.find((n) => n.id === 's2')!;
    expect(s2.presentationOrder.chapter).toBe(2);
  });

  it('renders the scene card as draggable (HTML5 draggable attr)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const cell = container.querySelector('[data-node-id="s1"]') as HTMLElement;
    expect(cell.draggable).toBe(true);
  });

  it('foreign drop (no scene payload on dataTransfer) is ignored — no write', () => {

    const { container } = render(<NarrativeTimelinePanel />);
    const target = container.querySelector('[data-drop-col="2"]') as HTMLElement;
    const dt = makeDataTransfer(); // empty — no SCENE_DRAG_MIME key set
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('+ button on a causal chapter header creates a scene assigned to that chapter (column semantics axis swap)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const addBtn = container.querySelector('.narrative-timeline-col-header[data-grid-col="1"] [data-action="add-scene"]') as HTMLButtonElement;
    addBtn.click();
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    const created = written.nodes.find((n) => n.id !== 's1' && n.id !== 's2' && n.id !== 's3')!;
    // 新场景归属点击列对应章、pos 追加到该章尾、storyTime 中性默认 max+1。
    expect(created.presentationOrder.chapter).toBe(1);
    expect(created.storyTime).toBe(4);
  });

  it('add-scene contract (channel/once/pos/readback): sparse chapter appends past maxPos（旧成员计数会撞位）', () => {
    // 章0 既有 pos {0, 2}（中段被删的稀疏形态）——countScenesInChapter 的 maxPos+1
    // 算术给新场景 pos 3；旧「成员计数」会产出 2 与既有 b 撞位。
    const sparse = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        { id: 'a', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
        { id: 'b', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 2 } },
      ],
      edges: [],
    });
    setStateWith(sparse);
    const { container } = render(<NarrativeTimelinePanel />);
    const addBtn = container.querySelector('.narrative-timeline-col-header[data-grid-col="0"] [data-action="add-scene"]') as HTMLButtonElement;
    addBtn.click();
    // 契约四点：scene_graph 通道、恰好一次、pos 位次、投影读回一致。
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('scene_graph');
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    const created = written.nodes.find((n) => n.id !== 'a' && n.id !== 'b')!;
    expect(created.presentationOrder).toEqual({ chapter: 0, pos: 3 });
    const current = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(
      current.nodes.find((n) => n.id === created.id)?.presentationOrder
    ).toEqual({ chapter: 0, pos: 3 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) applyPendingDrop — pure（#63 拖回待编排：哨兵章写入）
// ─────────────────────────────────────────────────────────────────────────────
describe('applyPendingDrop (pure, #63)', () => {
  const base = () =>
    parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 2 } },
        { id: 's2', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 0 } },
      ],
      edges: [],
    });

  it('writes the sentinel chapter, keeps pos, leaves other nodes untouched', () => {
    const next = applyPendingDrop(base(), 's1');
    const s1 = next.nodes.find((n) => n.id === 's1')!;
    expect(s1.presentationOrder.chapter).toBe(PENDING_CHAPTER_SENTINEL);
    expect(s1.presentationOrder.pos).toBe(2);
    expect(next.nodes.find((n) => n.id === 's2')!.presentationOrder.chapter).toBe(1);
  });

  it('no-op when the node already sits at the sentinel chapter', () => {
    const g = base();
    const once = applyPendingDrop(g, 's1');
    const twice = applyPendingDrop(once, 's1');
    expect(twice).toEqual(once);
  });

  it('does not mutate the input graph (returns a new object)', () => {
    const g = base();
    const snapshot = JSON.parse(JSON.stringify(g));
    applyPendingDrop(g, 's1');
    expect(g).toEqual(snapshot);
  });

  it('defensive: unknown node / missing presentationOrder stay untouched', () => {
    const g = base();
    expect(applyPendingDrop(g, 'ghost').nodes).toEqual(g.nodes);
    const broken = {
      ...base(),
      nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal' }],
    } as unknown as SceneGraph;
    const next = applyPendingDrop(broken, 's1');
    expect((next.nodes[0] as SceneGraph['nodes'][number]).presentationOrder).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) Integration — drop a placed card onto the causal pending mirror (#63)
// ─────────────────────────────────────────────────────────────────────────────
describe('pending mirror drop (integration, #63)', () => {
  beforeEach(() => {
    setStateWith(causalDragFixture());
  });

  afterEach(() => {
    cleanup();
  });

  it('dropping a placed card on the pending column writes the sentinel chapter', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    dragAndDrop(container, 's1', '.narrative-timeline-cell-stack--pending');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    expect(written.nodes.find((n) => n.id === 's1')!.presentationOrder.chapter).toBe(
      PENDING_CHAPTER_SENTINEL
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) CR 批 A：跨区拖拽契约矩阵（StructurePage 双区挂载，因果↔工作台）
//     契约（裁决 2B）：「跨区拖=挪章」对所有场景拖拽一致——来源不再是行为分叉轴；
//     同视觉章 chip→chip = 章内 pos 重排；pending 面 = 撤章；gap 轨拒收。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 矩阵夹具（单线七章景）：
 *   sa/sd  章0 两条（同章重排对）；sb 章1；sc 章2
 *   sl     裸章号 0 + legacy episodeId=e2（视觉格章2——ghost-write 回归专用）
 *   ss     spans e0..e2（视觉格章0 起始跨章）
 *   dang   章42 无对应 episode（工作台待编排列 + 因果镜像）
 */
function matrixGraph(): SceneGraph {
  return parseGraph({
    lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }],
    nodes: [
      { id: 'sa', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 'sd', lineTags: ['l_main'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 1 } },
      { id: 'sl', lineTags: ['l_main'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 0, pos: 2 }, episodeId: 'e2' },
      {
        id: 'ss', lineTags: ['l_main'], storyTime: 4, role: 'normal',
        presentationOrder: { chapter: 0, pos: 3 },
        presentationSpans: [{ episodeId: 'e0', pos: 0 }, { episodeId: 'e2', pos: 1 }],
      },
      { id: 'sb', lineTags: ['l_main'], storyTime: 5, role: 'normal', presentationOrder: { chapter: 1, pos: 0 } },
      { id: 'sc', lineTags: ['l_main'], storyTime: 6, role: 'normal', presentationOrder: { chapter: 2, pos: 0 } },
      { id: 'dang', lineTags: ['l_main'], storyTime: 9, role: 'normal', presentationOrder: { chapter: 42, pos: 0 } },
    ],
    edges: [],
  });
}

type MatrixSource = HTMLElement;

const CAUSAL_CARD = (id: string) =>
  `[data-skeleton="causal"] .scene-card[data-node-id="${id}"]`;
const CHIP = (id: string) => `.workbench-chip[data-node-id="${id}"]:not(.workbench-chip--pending)`;
const CAUSAL_HEADER = (n: number) =>
  `[data-skeleton="causal"] .narrative-timeline-col-header[data-drop-col="${n}"]`;
const CAUSAL_STACK = (n: number) =>
  `[data-skeleton="causal"] .narrative-timeline-cell-stack[data-drop-col="${n}"]`;

describe('CR 批 A：拖拽写通道契约矩阵（StructurePage）', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: matrixGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  /** 真实 dragstart 起手（payload 来自源元素的真处理器），再落在目标元素。 */
  function dragFrom(source: MatrixSource | null, targetSel: string, container: HTMLElement): void {
    const target = container.querySelector(targetSel) as HTMLElement | null;
    expect(target, `target ${targetSel}`).toBeTruthy();
    const dt = makeDataTransfer();
    fireEvent.dragStart(source!, { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
  }

  const chapterOf = (id: string): number => {
    const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    return g.nodes.find((n) => n.id === id)!.presentationOrder.chapter;
  };
  const writtenCount = (): number => updateSpy.mock.calls.length;

  describe('P0 ghost-write 回归：spans/episodeId 遮蔽下写=真改、回=不写', () => {
    it('legacy episodeId 场景落回自己视觉列 → 解析口径 no-op，零写入（旧码裸章号比对会 ghost write）', () => {
      const { container } = render(<StructurePage />);
      // sl 视觉格 = 章2（episodeId e2 遮蔽裸章号 0）。旧判据 raw 0≠2 会写入被遮蔽。
      dragFrom(container.querySelector(CAUSAL_CARD('sl')), CAUSAL_HEADER(2), container);
      expect(writtenCount()).toBe(0);
      expect(chapterOf('sl')).toBe(0); // 裸值未被扰动
    });

    it('drag 它移才写真改：剥 episodeId 后视觉位随写走（真改真显）', () => {
      const { container } = render(<StructurePage />);
      dragFrom(container.querySelector(CAUSAL_CARD('sl')), CAUSAL_HEADER(1), container);
      expect(writtenCount()).toBe(1);
      const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
      const sl = g.nodes.find((n) => n.id === 'sl')!;
      expect(sl.presentationOrder.chapter).toBe(1);
      expect(sl.episodeId).toBeUndefined(); // 遮蔽字段随写剥离
    });

    it('span 宽卡拖到自身覆盖列 chip = 取消式投放零写入（CR3 G-F2；旧断言「挪章收敛」是 pre-R6 契约）', () => {
      const { container } = render(<StructurePage />);
      // ss spans e0..e2 → 视觉区间 [0..2]；sc 所在章 2 落在自身覆盖列内 → 整手势视为
      // 取消（拖起又放回），零写入、数据原样（宽卡的区间改写只有边缘直拖与
      // 区间外平移两条路，§6.3 后不再有「拖到 chip 上收敛 span」通道）。
      dragFrom(container.querySelector(CAUSAL_CARD('ss')), CHIP('sc'), container);
      expect(writtenCount()).toBe(0);
      const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
      const ss = g.nodes.find((n) => n.id === 'ss')!;
      expect(ss.presentationOrder.chapter).toBe(0);
      expect(ss.presentationSpans).toEqual([{ episodeId: 'e0', pos: 0 }, { episodeId: 'e2', pos: 1 }]);
    });
  });

  describe('全组合矩阵：2 源（因果卡 / 工作台 chip）× 5 类目标', () => {
    const sources: Array<{ kind: string; pick: (c: HTMLElement) => HTMLElement | null }> = [
      { kind: 'causal 卡', pick: (c) => c.querySelector(CAUSAL_CARD('sa')) },
      { kind: 'workbench chip', pick: (c) => c.querySelector(CHIP('sa')) },
    ];

    for (const src of sources) {
      it(`[${src.kind}] → 因果列头（真实章 col2）= 写章归属一次`, () => {
        const { container } = render(<StructurePage />);
        dragFrom(src.pick(container), CAUSAL_HEADER(2), container);
        expect(writtenCount()).toBe(1);
        expect(chapterOf('sa')).toBe(2);
      });

      it(`[${src.kind}] → 因果格（cell-stack col1）= 写章归属一次`, () => {
        const { container } = render(<StructurePage />);
        dragFrom(src.pick(container), CAUSAL_STACK(1), container);
        expect(writtenCount()).toBe(1);
        expect(chapterOf('sa')).toBe(1);
      });

      it(`[${src.kind}] → 因果 pending 镜像列 = 撤章哨兵`, () => {
        const { container } = render(<StructurePage />);
        dragFrom(src.pick(container), '[data-skeleton="causal"] .narrative-timeline-cell-stack--pending', container);
        expect(writtenCount()).toBe(1);
        expect(chapterOf('sa')).toBe(PENDING_CHAPTER_SENTINEL);
      });

      it(`[${src.kind}] → 工作台异章 chip（sb@章1）= 挪章（不重排 pos 语义混跑）`, () => {
        const { container } = render(<StructurePage />);
        dragFrom(src.pick(container), CHIP('sb'), container);
        expect(writtenCount()).toBe(1);
        expect(chapterOf('sa')).toBe(1);
      });

      it(`[${src.kind}] → 工作台同章 chip = 章内 pos 重排、章号不动（宽成员不入重排面——CR3 G-edge）`, () => {
        const { container } = render(<StructurePage />);
        // 被拖者 sd(pos1) 落在 sa(pos0) 表面 → 重排为 sd 在前。旧用例拖 sa 落 sd：
        // 同序下旧实现的「1 写」其实全来自宽卡 ss 的 po.pos 被连带重编号（spans[0].pos
        // 锚写飞——CR3 G-edge 已修，宽成员不入重排面）→ 翻转被拖者为 sd 保留真重排覆盖。
        const sourceSel = src.kind === 'causal 卡' ? CAUSAL_CARD('sd') : CHIP('sd');
        dragFrom(container.querySelector(sourceSel), CHIP('sa'), container);
        expect(writtenCount()).toBe(1);
        expect(chapterOf('sd')).toBe(0);
        const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
        const byId = new Map(g.nodes.map((n) => [n.id, n.presentationOrder.pos]));
        expect(byId.get('sd')).toBe(0); // dragged moved before target
        expect(byId.get('sa')).toBe(1);
        expect(byId.get('ss')).toBe(3); // 宽卡 po.pos 锚不被连带重编号
      });

      it(`[${src.kind}] → 工作台待编排槽 = 撤章哨兵一次`, () => {
        const { container } = render(<StructurePage />);
        dragFrom(src.pick(container), '.workbench-slot--pending', container);
        expect(writtenCount()).toBe(1);
        expect(chapterOf('sa')).toBe(PENDING_CHAPTER_SENTINEL);
      });

      it(`[${src.kind}] → 待编排格内的 chip（dang 在槽内）= 撤章且只写一次（stopPropagation 单缝）`, () => {
        const { container } = render(<StructurePage />);
        dragFrom(src.pick(container), '.workbench-slot--pending .workbench-chip[data-node-id="dang"]', container);
        expect(writtenCount()).toBe(1);
        expect(chapterOf('sa')).toBe(PENDING_CHAPTER_SENTINEL);
      });
    }

    it('[双源] gap 章轨（无 episode）拒收——阻断光标类、零写入（gapped fixture）', () => {
      const gapped = episodeOutlinesSchema.parse([
        { id: 'e0', index: 0, title: '第一章' },
        { id: 'e2', index: 2, title: '第三章' },
      ]);
      useAppStore.setState({ creativeFields: { scene_graph: matrixGraph(), episode_outlines: gapped } } as any);
      const { container } = render(<StructurePage />);
      for (const sel of [CAUSAL_CARD('sa'), CHIP('sa')]) {
        const source = container.querySelector(sel) as HTMLElement;
        const gapStack = container.querySelector(
          '[data-skeleton="causal"] .narrative-timeline-cell-stack[data-grid-col="1"]'
        ) as HTMLElement;
        expect(gapStack).toBeTruthy();
        // gap 轨不再声明 drop 目标。
        expect(gapStack.classList.contains('narrative-timeline-drop-target')).toBe(false);
        expect(gapStack.getAttribute('data-drop-col')).toBeNull();
        const dt = makeDataTransfer();
        fireEvent.dragStart(source, { dataTransfer: dt });
        fireEvent.dragOver(gapStack, { dataTransfer: dt });
        fireEvent.drop(gapStack, { dataTransfer: dt });
        expect(writtenCount()).toBe(0);
      }
      // 章确无变化。
      expect(chapterOf('sa')).toBe(0);
    });

    it('[weaving] 自身落点（chip drop onto itself）= 引用级 no-op 零写入', () => {
      const { container } = render(<StructurePage />);
      const self = container.querySelector(CHIP('sc')) as HTMLElement;
      dragFrom(self, CHIP('sc'), container);
      expect(writtenCount()).toBe(0);
    });

    it('[causal] 列头落点对 legacy mode 随行载荷照收（解码宽容度钉住）', () => {
      const { container } = render(<StructurePage />);
      const target = container.querySelector(CAUSAL_HEADER(2)) as HTMLElement;
      // 手工注入带 mode 的 legacy 载荷（裁决 2B：mode 只作信息随行，不再拒收）。
      const dt = makeDataTransfer();
      dt.setData(
        'application/x-orison-scene-drag',
        JSON.stringify({ nodeId: 'sa', mode: 'weaving' })
      );
      fireEvent.dragOver(target, { dataTransfer: dt });
      fireEvent.drop(target, { dataTransfer: dt });
      expect(writtenCount()).toBe(1);
      expect(chapterOf('sa')).toBe(2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (6) R10 因果侧手势矩阵补缺（research/gesture-matrix-r10.md §5 清单落码）。
//     矩阵审计的因果侧缺口：空章格落点 / pending 源放行（A1 批割 useWeavingEdit
//     补挂修补的镜像锚）/ 待编排重复落点引用级 no-op / spans 源落回起始列 no-op /
//     畸形载荷拒收 / 同章格落点 no-op（因果无章内重排——有意分化锚）/ gap 阻断
//     光标语义 / 空章列头新建 pos=0 / 空白右键 gap·pending 置灰。
// ─────────────────────────────────────────────────────────────────────────────

/** 四章 episodes（第 4 章为空章轨道——「卡对空列」「空章新建」两格夹具）。 */
const EPISODES4 = () =>
  episodeOutlinesSchema.parse([
    { id: 'e0', index: 0, title: '第一章' },
    { id: 'e1', index: 1, title: '第二章' },
    { id: 'e2', index: 2, title: '第三章' },
    { id: 'e3', index: 3, title: '第四章' },
  ]);

/** gap 夹具：章 index [0, 2]，index 1 为 gap 轨。 */
const EPISODES_GAPPED = () =>
  episodeOutlinesSchema.parse([
    { id: 'e0', index: 0, title: '第一章' },
    { id: 'e2', index: 2, title: '第三章' },
  ]);

describe('R10 因果侧手势矩阵补缺（gesture-matrix-r10）', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: matrixGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      canvasZoom: 1,
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  /** 真实 dragstart 起手 → dragover → drop（与 CR 批 A describe 的 dragFrom 同款）。 */
  function dragFromTo(sourceSel: string, targetSel: string, container: HTMLElement): void {
    const source = container.querySelector(sourceSel) as HTMLElement | null;
    const target = container.querySelector(targetSel) as HTMLElement | null;
    expect(source, `source ${sourceSel}`).toBeTruthy();
    expect(target, `target ${targetSel}`).toBeTruthy();
    const dt = makeDataTransfer();
    fireEvent.dragStart(source!, { dataTransfer: dt });
    fireEvent.dragOver(target!, { dataTransfer: dt });
    fireEvent.drop(target!, { dataTransfer: dt });
  }

  const chapterOf = (id: string): number => {
    const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    return g.nodes.find((n) => n.id === id)!.presentationOrder.chapter;
  };

  it('[G-A 拖换章·卡对空列] 空章 cell-stack 是合法落点（空轨恒渲染包裹层 + drop 绑定——R1 空槽语义的因果镜像）', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: matrixGraph(), episode_outlines: EPISODES4() },
    } as any);
    const { container } = render(<StructurePage />);
    // 第 4 章（index 3）轨道空、episode 真实存在 → droppable 空格。
    dragFromTo(CAUSAL_CARD('sa'), CAUSAL_STACK(3), container);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(chapterOf('sa')).toBe(3);
  });

  it('[G-C pending 源放行] dangling 卡拖入章列 = 补挂章节一次写（A1 批割 useWeavingEdit 同款修补的因果镜像——两区不得失同步）', () => {
    const { container } = render(<StructurePage />);
    // dang 裸章号 42（无对应 episode）→ 渲染在因果待编排镜像列；拖入第 2 章列头
    // = 解析 miss → currentChapter 取裸章号 → 与目标不等 → applyChapterDrop 写 1。
    dragFromTo(CAUSAL_CARD('dang'), CAUSAL_HEADER(1), container);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(chapterOf('dang')).toBe(1);
  });

  it('[G-G 拖回待编排·两段式] 裸章号 dangling 落 pending = 首次写哨兵规范化；哨兵态重复落 = 引用级 no-op 零写入', () => {
    const { container } = render(<StructurePage />);
    const pendingSel = '[data-skeleton="causal"] .narrative-timeline-cell-stack--pending';
    dragFromTo(CAUSAL_CARD('dang'), pendingSel, container);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(chapterOf('dang')).toBe(PENDING_CHAPTER_SENTINEL);
    // 已是哨兵态 → applyPendingDrop 原引用返回 → 整次手势零写入（CR 组 3c 双缝守卫）。
    dragFromTo(CAUSAL_CARD('dang'), pendingSel, container);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('[G-D 拖换章·spans 源落回起始列] 宽卡拖回自身起始章列头 = 解析口径 no-op 零写入（sl 的 legacy 回归补 spans 形态）', () => {
    const { container } = render(<StructurePage />);
    // ss spans e0..e2 → 视觉起始章 0；落回列 0 = colStart 等值 → 零写。
    dragFromTo(CAUSAL_CARD('ss'), CAUSAL_HEADER(0), container);
    expect(updateSpy).toHaveBeenCalledTimes(0);
    const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const ss = g.nodes.find((n) => n.id === 'ss')!;
    expect(ss.presentationSpans).toEqual([{ episodeId: 'e0', pos: 0 }, { episodeId: 'e2', pos: 1 }]);
  });

  it('[G-F 载荷防御] MIME 在场但 JSON 畸形 → decodeDragPayload null → 零写入', () => {
    const { container } = render(<StructurePage />);
    const target = container.querySelector(CAUSAL_HEADER(2)) as HTMLElement;
    const dt = makeDataTransfer();
    dt.setData(SCENE_DRAG_MIME, '{not-json');
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    expect(updateSpy).toHaveBeenCalledTimes(0);
  });

  it('[G-E 同章格落点] 拖到自身章的 cell-stack（非列头面）= no-op——因果面无章内重排（有意分化锚：重排走工作台缝）', () => {
    const { container } = render(<StructurePage />);
    dragFromTo(CAUSAL_CARD('sd'), CAUSAL_STACK(0), container);
    expect(updateSpy).toHaveBeenCalledTimes(0);
  });

  it('[G-B gap 拒收·阻断光标] gap 轨 dragover 把 dropEffect 压回 none；真实章轨 dragover 放行 move', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: matrixGraph(), episode_outlines: EPISODES_GAPPED() },
    } as any);
    const { container } = render(<StructurePage />);
    const gapStack = container.querySelector(
      '[data-skeleton="causal"] .narrative-timeline-cell-stack[data-grid-col="1"]'
    ) as HTMLElement;
    // gap 轨结构性拒收：不声明 drop 目标（写侧已有 gapped fixture 测，此处钉光标语义）。
    expect(gapStack.getAttribute('data-drop-col')).toBeNull();
    const dt = makeDataTransfer();
    fireEvent.dragStart(container.querySelector(CAUSAL_CARD('sa'))!, { dataTransfer: dt });
    dt.dropEffect = 'move';
    fireEvent.dragOver(gapStack, { dataTransfer: dt });
    expect(dt.dropEffect).toBe('none'); // onBlockedDragOver 覆写阻断（无 preventDefault → 真浏览器 drop 不触发）
    // 对照：真实章轨 dragover 放行 move。
    const dt2 = makeDataTransfer();
    fireEvent.dragStart(container.querySelector(CAUSAL_CARD('sa'))!, { dataTransfer: dt2 });
    dt2.dropEffect = 'none';
    const okStack = container.querySelector(CAUSAL_STACK(0)) as HTMLElement;
    fireEvent.dragOver(okStack, { dataTransfer: dt2 });
    expect(dt2.dropEffect).toBe('move');
  });

  it('[E-A 边缘新增·空章] 空章列头＋新建 pos=0（countScenesInChapter 空章 maxPos+1=0）', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: matrixGraph(), episode_outlines: EPISODES4() },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    const addBtn = container.querySelector(
      '.narrative-timeline-col-header[data-grid-col="3"] [data-action="add-scene"]'
    ) as HTMLButtonElement;
    addBtn.click();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    const existing = new Set(['sa', 'sd', 'sl', 'ss', 'sb', 'sc', 'dang']);
    const created = written.nodes.find((n) => !existing.has(n.id))!;
    expect(created.presentationOrder).toEqual({ chapter: 3, pos: 0 });
  });

  it('[R-A 右键·空白→gap 轨] 空白右键命中 gap 列 → 菜单弹出且「在此章新建」置灰（置灰而非消失），点击零写入', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: matrixGraph(), episode_outlines: EPISODES_GAPPED() },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    const grid = container.querySelector('.narrative-timeline-grid') as HTMLElement;
    // jsdom 零矩形 + zoom=1：local = clientX − laneLabelWidth(160)。名义偏移表
    // [0,108,216,324,544]（三章×108 + 待编排 220）——clientX=318 → local=158 → gap 轨 1。
    fireEvent.contextMenu(grid, { clientX: 318, clientY: 10 });
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]');
    expect(menu).not.toBeNull();
    const item = menu!.querySelector('[data-menu-key="add-scene"]') as HTMLButtonElement;
    expect(item.disabled).toBe(true); // 置灰而非消失（R8 契约）
    fireEvent.click(item);
    expect(updateSpy).toHaveBeenCalledTimes(0);
  });

  it('[R-B 右键·pending 带] 空白右键命中待编排带 → 同款置灰（colIndexAtX 名义表覆盖哨兵轨——colValue=trackCount 不在 episodeIndexSet）', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: matrixGraph(), episode_outlines: EPISODES_GAPPED() },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    const grid = container.querySelector('.narrative-timeline-grid') as HTMLElement;
    // clientX=534 → local=374 ∈ [324,544) → 轨 3（= trackCount 3，待编排带）。
    fireEvent.contextMenu(grid, { clientX: 534, clientY: 10 });
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]');
    expect(menu).not.toBeNull();
    const item = menu!.querySelector('[data-menu-key="add-scene"]') as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    fireEvent.click(item);
    expect(updateSpy).toHaveBeenCalledTimes(0);
  });
});
