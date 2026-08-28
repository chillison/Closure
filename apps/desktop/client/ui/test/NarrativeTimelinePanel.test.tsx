/**
 * Story 1.5 Phase D-render (design §1.1 / D6): NarrativeTimelinePanel render
 * behaviour. Covers the read+derive+render path — cells placed from the derived
 * layout, lane/axis labels present, EdgeLayer SVG paths drawn, and the
 * displacement/visibility overlays gated by structureSlice.overlayToggles.
 *
 * Layout semantics (sceneGraphLayout.test.ts) and validateSceneGraph
 * (creativeFieldsSceneGraph.test.ts) are covered elsewhere — not duplicated.
 * Store is driven via useAppStore.setState (same convention as
 * PatchReviewPanel.test.tsx); actions are irrelevant here (render-only).
 *
 * Run: `cd apps/desktop/client/ui && pnpm test NarrativeTimelinePanel`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { episodeOutlinesSchema, sceneGraphSchema } from '@orison/shared-contracts';
import { NarrativeTimelinePanel } from '../src/features/structure/NarrativeTimelinePanel';
import { StructurePage } from '../src/features/structure/StructurePage';
import { TIMELINE_GEOMETRY } from '../src/features/structure/timelineGeometry';
import { lineHueIndex } from '../src/features/structure/linePalette';
import { useAppStore } from '../src/shared/store/appStore';
import type { SceneGraph } from '@orison/shared-contracts';

const EPISODES = () =>
  episodeOutlinesSchema.parse([
    { id: 'e0', index: 0, title: '第一章' },
    { id: 'e1', index: 1, title: '第二章' },
    { id: 'e2', index: 2, title: '第三章' },
  ]);

// ── fixtures ──
// Schema-parse fills mechanical defaults; tests only spell load-bearing fields.
function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

/**
 * Multi-line fixture: main thread + a flashback/hidden-until side lane, with a
 * multi-line core-anchor scene and one edge of each type.
 *   rows: l_main (main-thread), l_mem (side)
 *   cols: 1, 2, 3
 *   cells: s1@l_main/1, s2@l_main/2, s2@l_mem/2, s3@l_mem/3  → 4 cells
 *   edges: e1 CAUSAL s1→s2, e2 SUSPENSE s2→s3               → 2 edges
 * l_mem carries displacement=flashback + visibility=hidden-until so its cells
 * (s2@l_mem, s3@l_mem) pick up the displacement frame + hidden dim classes.
 */
function multiLineGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
      {
        id: 'l_mem',
        name: '回忆线',
        topology_role: 'side',
        displacement: 'flashback',
        visibility: { status: 'hidden-until', target: 's1' },
      },
    ],
    nodes: [
      { id: 's1', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's2', lineTags: ['l_main', 'l_mem'], storyTime: 2, role: 'core-anchor', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's3', lineTags: ['l_mem'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
    ],
    edges: [
      { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' },
      { id: 'e2', from: 's2', to: 's3', type: 'SUSPENSE' },
    ],
  });
}

const ALL_OVERLAYS_ON = { validation: true, displacement: true, visibility: true };

describe('NarrativeTimelinePanel', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: multiLineGraph(), episode_outlines: EPISODES() },
      overlayToggles: { ...ALL_OVERLAYS_ON },
      resolvedLocale: 'en-US',
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders one SceneCard per derived cell (multi-line membership expands count)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // s2 belongs to two lines → 2 cells; 4 total across the graph.
    const cells = container.querySelectorAll('.scene-card');
    expect(cells).toHaveLength(4);
    // s2 appears in both lanes (multi-line membership) — keyed by nodeId|lineId|subIndex.
    const s2Cells = container.querySelectorAll('[data-node-id="s2"]');
    expect(s2Cells).toHaveLength(2);
  });

  it('renders a lane label per line (main-thread first)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const labels = container.querySelectorAll('[data-lane-id]');
    expect(labels).toHaveLength(2);
    // main-thread promoted to the first row.
    expect((labels[0] as HTMLElement).dataset.laneId).toBe('l_main');
    expect((labels[1] as HTMLElement).dataset.laneId).toBe('l_mem');
    // Name lives in a dedicated span so validation badges (Phase D-overlay) can
    // sit alongside it without changing the name text. Query the span, not the
    // whole label, so a flagged lane (e.g. l_main has no convergence_target →
    // missing-convergence-target warning) doesn't fold the badge count into the
    // asserted text.
    expect(labels[0]?.querySelector('.narrative-timeline-lane-name')?.textContent).toBe('主线');
    expect(labels[1]?.querySelector('.narrative-timeline-lane-name')?.textContent).toBe('回忆线');
    // 08-26 批 2（implement 2.4）：线色左条 + 线名着线色（lane-hue 单源挂法）+
    // 场景数第二行（l_main 2 卡：s1+s2；l_mem 2 卡：s2+s3——多线场景各线各计）。
    expect(labels[0]?.querySelector('.narrative-timeline-lane-bar')).not.toBeNull();
    expect((labels[0] as HTMLElement).classList.contains(`lane-hue--c${lineHueIndex('l_main')}`)).toBe(true);
    expect(labels[0]?.querySelector('.narrative-timeline-lane-count')?.textContent).toBe('2 scenes');
    expect(labels[1]?.querySelector('.narrative-timeline-lane-count')?.textContent).toBe('2 scenes');
    // 行高实测锚（implement 2.2）：泳道标签落 data-grid-row。
    expect((labels[0] as HTMLElement).getAttribute('data-grid-row')).toBe('0');
  });

  it('renders a chapter column header per existing episode (batch 7 chapter axis)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // 列头只对实际存在的 episode（gap 章不造头——空轨诚实）；章号人读 1-based。
    const headers = [...container.querySelectorAll('[data-col-value]')]
      .filter((el) => el.getAttribute('data-col-value') !== 'pending');
    expect(headers).toHaveLength(3);
    const values = headers.map(
      (h) => h.querySelector('.narrative-timeline-col-value')?.textContent ?? h.textContent
    );
    expect(values).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    // 待编排虚拟列头常驻（dangling 镜像收纳，哨兵值列）。
    expect(container.querySelector('[data-col-value="pending"]')).not.toBeNull();
    // drop 载荷按稠密轨道 index（data-drop-col = 章 index）。
    const drops = [...container.querySelectorAll('[data-drop-col]')].map((el) =>
      (el as HTMLElement).getAttribute('data-drop-col')
    );
    expect(drops).toEqual(expect.arrayContaining(['0', '1', '2']));
  });

  it('draws one SVG path per resolvable edge, typed CAUSAL vs SUSPENSE', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const paths = container.querySelectorAll('svg path[data-edge-id]');
    expect(paths).toHaveLength(2);
    expect(container.querySelectorAll('.narrative-edge--causal')).toHaveLength(1);
    expect(container.querySelectorAll('.narrative-edge--suspense')).toHaveLength(1);
    // edge id preserved on the path for downstream overlay (Phase D-validation).
    const ids = [...paths].map((p) => (p as HTMLElement).dataset.edgeId);
    expect(ids).toEqual(expect.arrayContaining(['e1', 'e2']));
  });

  it('tags the core-anchor scene with its role class', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const anchorCells = container.querySelectorAll('.scene-card--core-anchor');
    // s2 spans two lanes → two anchor cells.
    expect(anchorCells).toHaveLength(2);
  });

  it('applies the displacement frame + hidden dim to side-lane cells when both overlays are on', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // l_mem carries flashback + hidden-until; its two cells (s2@l_mem, s3@l_mem) get both classes.
    const flashback = container.querySelectorAll('.scene-card--disp-flashback');
    const hidden = container.querySelectorAll('.scene-card--hidden');
    expect(flashback).toHaveLength(2);
    expect(hidden).toHaveLength(2);
    // s2 is multi-line; its l_main cell is unaffected by either overlay class.
    const mainS2 = container.querySelectorAll('[data-node-id="s2"][data-line-id="l_main"]');
    expect(mainS2).toHaveLength(1);
    expect(mainS2[0].classList.contains('scene-card--disp-flashback')).toBe(false);
    expect(mainS2[0].classList.contains('scene-card--hidden')).toBe(false);
  });

  it('drops the displacement frame when overlayToggles.displacement is off', () => {
    useAppStore.setState({
      overlayToggles: { validation: true, displacement: false, visibility: true },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    expect(container.querySelectorAll('.scene-card--disp-flashback')).toHaveLength(0);
    // visibility overlay is independent — still applied.
    expect(container.querySelectorAll('.scene-card--hidden')).toHaveLength(2);
  });

  it('drops the hidden dim when overlayToggles.visibility is off', () => {
    useAppStore.setState({
      overlayToggles: { validation: true, displacement: true, visibility: false },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    expect(container.querySelectorAll('.scene-card--hidden')).toHaveLength(0);
    // displacement overlay is independent — still applied.
    expect(container.querySelectorAll('.scene-card--disp-flashback')).toHaveLength(2);
  });

  it('does not crash when nodes exist but no lines resolve (rulers, empty body)', () => {
    // nodes-but-no-lines: an episode pool keeps tracks/rulers alive while rows/cells
    // stay empty. Panel must render the rulers + defensive empty body without throwing.
    const graph = parseGraph({
      nodes: [{ id: 'orphan', lineTags: ['ghost'], storyTime: 5, presentationOrder: { chapter: 0, pos: 0 } }],
    });
    useAppStore.setState({
      creativeFields: { scene_graph: graph, episode_outlines: EPISODES() },
    } as any);

    const { container } = render(<NarrativeTimelinePanel />);
    // 章列头 ×3 + 待编排虚拟列头（哨兵值）。
    expect(container.querySelectorAll('[data-col-value]')).toHaveLength(4);
    expect(container.querySelector('[data-col-value="pending"]')).not.toBeNull();
    expect(container.querySelectorAll('.scene-card')).toHaveLength(0);
    expect(container.querySelector('.narrative-timeline-empty-body')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 08-26 批 3（implement 3.4）：StructurePage 单列堆叠——阅读骨架退役，因果骨架
// 单视图 + 章节工作台（融合网格）承接阅读顺序语义。原「双骨架 + 倒叙列位差」
// 断言随阅读骨架退役；倒叙判定（readIndex vs storyRank）由工作台 chip 承接
// （workbenchLayout.test / chapterWorkbench.test）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 倒叙 fixture: s_late happens late in the story (storyTime=3) but is read
 * FIRST (presentationOrder ch0/pos0). s_early happens first causally
 * (storyTime=1) but is read second (ch1/pos0——批 7 两侧分居不同章轨).
 */
function reverseChronologyGraph(): SceneGraph {
  return parseGraph({
    lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    nodes: [
      { id: 's_late', lineTags: ['l1'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's_early', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 1, pos: 0 } },
    ],
    edges: [],
  });
}

describe('StructurePage stacking (08-26 批 3 + 批 7 章轴)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: reverseChronologyGraph(),
        episode_outlines: episodeOutlinesSchema.parse([
          { id: 'e0', index: 0, title: '第一章' },
          { id: 'e1', index: 1, title: '第二章' },
        ]),
      },
      overlayToggles: { ...ALL_OVERLAYS_ON },
      resolvedLocale: 'en-US',
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the causal skeleton + the chapter workbench（reading skeleton retired）', () => {
    const { container } = render(<StructurePage />);
    expect(container.querySelector('[data-skeleton="causal"]')).not.toBeNull();
    expect(container.querySelector('[data-skeleton="workbench"]')).not.toBeNull();
    // 阅读骨架渲染分支退役——不再存在。
    expect(container.querySelector('[data-skeleton="reading"]')).toBeNull();
    expect(container.querySelector('[data-axis="readPosition"]')).toBeNull();
  });

  it('reserves the 46px band between causal and workbench（批 4 AssocLayer 居住区）', () => {
    const { container } = render(<StructurePage />);
    expect(container.querySelector('[data-skeleton-gap]')).not.toBeNull();
    // 高度由 CSS 类承载——TIMELINE_GEOMETRY.skeletonGapHeight 镜像锁定（design §1.1 定 46）。
    expect(TIMELINE_GEOMETRY.skeletonGapHeight).toBe(46);
  });

  it('both zones ride the SAME shared chapter track base（批 7 同构锁步的数据面前提）', () => {
    const { container } = render(<StructurePage />);
    // 两区**章列头**集合一致（真实 episode；gapped/虚轨道不造头）。fixture：两章。
    // 因果侧列头额外落 data-grid-col（列宽实测锚），待编排头挂末位 = trackCount。
    const causalCols = [...container.querySelectorAll('[data-skeleton="causal"] .narrative-timeline-col-header[data-col-value]')]
      .filter((el) => el.getAttribute('data-col-value') !== 'pending')
      .map((el) => el.getAttribute('data-grid-col'));
    const workbenchCols = [...container.querySelectorAll('.workbench [data-col-index]')]
      .filter((el) => el.getAttribute('data-col-index') !== 'pending')
      .map((el) => el.getAttribute('data-col-index'));
    expect(causalCols.sort()).toEqual(['0', '1']);
    expect(workbenchCols.sort()).toEqual(['0', '1']);
    // 待编排哨兵轨在因果侧的 slot index = 章轨道数（2）。
    expect(
      container.querySelector('[data-skeleton="causal"] [data-col-value="pending"]')?.getAttribute('data-grid-col')
    ).toBe('2');
  });

  it('falls back to empty state when scene_graph is absent', () => {
    useAppStore.setState({ creativeFields: { scene_graph: undefined } } as any);
    const { container } = render(<StructurePage />);
    expect(container.querySelector('[data-skeleton="causal"]')).toBeNull();
    expect(container.querySelector('[data-skeleton="workbench"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase E3-interact (design E3.4): line focus. Clicking a lane label sets
// `focusedLineId`; other lanes dim (visual only — no data change). Clicking the
// focused lane again clears focus. Uses the multi-line fixture (l_main + l_mem).
// ─────────────────────────────────────────────────────────────────────────────
describe('NarrativeTimelinePanel line focus (Phase E3.4)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: multiLineGraph() },
      overlayToggles: { ...ALL_OVERLAYS_ON },
      focusedLineId: null,
      selectedNodeId: null,
      resolvedLocale: 'en-US',
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('clicking a lane label sets focusedLineId', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const mainLabel = container.querySelector('[data-lane-id="l_main"]') as HTMLElement;
    fireEvent.click(mainLabel);
    expect(useAppStore.getState().focusedLineId).toBe('l_main');
  });

  it('grid gains --has-focus + non-focused lanes dim when a lane is focused', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const memLabel = container.querySelector('[data-lane-id="l_mem"]') as HTMLElement;
    fireEvent.click(memLabel);

    // grid carries the has-focus marker.
    const grid = container.querySelector('.narrative-timeline-grid') as HTMLElement;
    expect(grid.classList.contains('narrative-timeline-grid--has-focus')).toBe(true);

    // l_mem is focused → not dimmed; l_main is not focused → dimmed.
    const mainLabel = container.querySelector('[data-lane-id="l_main"]') as HTMLElement;
    const memLabelAfter = container.querySelector('[data-lane-id="l_mem"]') as HTMLElement;
    expect(mainLabel.classList.contains('narrative-timeline-lane-label--dimmed')).toBe(true);
    expect(memLabelAfter.classList.contains('narrative-timeline-lane-label--dimmed')).toBe(false);
    expect(memLabelAfter.classList.contains('narrative-timeline-lane-label--focused')).toBe(true);
    expect(memLabelAfter.getAttribute('data-lane-focused')).toBe('true');
  });

  it('cell-stacks in non-focused lanes dim too (whole row, not just the label)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.click(container.querySelector('[data-lane-id="l_mem"]') as HTMLElement);
    // l_main's cell-stack wrappers carry the dimmed class; l_mem's do not.
    const mainStacks = container.querySelectorAll('[data-lane-id="l_main"]');
    // lane label itself is one element; its cell-stacks are siblings queried via the row.
    // Easier: count dimmed cell-stacks across the grid.
    const dimmedStacks = container.querySelectorAll('.narrative-timeline-cell-stack--dimmed');
    expect(dimmedStacks.length).toBeGreaterThan(0);
  });

  it('clicking the focused lane again clears focus (toggle)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const mainLabel = container.querySelector('[data-lane-id="l_main"]') as HTMLElement;
    fireEvent.click(mainLabel);
    expect(useAppStore.getState().focusedLineId).toBe('l_main');
    // click the same (now-focused) label again → cleared.
    fireEvent.click(mainLabel);
    expect(useAppStore.getState().focusedLineId).toBeNull();
    // grid loses the has-focus marker.
    const grid = container.querySelector('.narrative-timeline-grid') as HTMLElement;
    expect(grid.classList.contains('narrative-timeline-grid--has-focus')).toBe(false);
  });

  it('focus is visual only — scene_graph data is unchanged', () => {
    const before = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.click(container.querySelector('[data-lane-id="l_mem"]') as HTMLElement);
    const after = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(after).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 08-27 结构页修复第三轮 B2 批：NTP 侧四项——
//   ① 首列左侧（local<0）右键守卫（CR3 edge：colIndexAtX 钳回章 0 的错位菜单根除）
//   ② R11 批3 插入新章（列头菜单 → 双字段投影）
//   ③ ghost drawer 落选前置校验（CR3 edge）
//   ④ D-1 统一取消式（因果侧宽卡投回自身覆盖区间 = 零写；对齐工作台 A1 语义）
// ─────────────────────────────────────────────────────────────────────────────

/** 忠实 DataTransfer mock（setData/getData Map 存储——hook 只消费该面）。 */
function makeDt(): DataTransfer {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData: vi.fn((mime: string, data: string) => {
      store.set(mime, data);
    }),
    getData: vi.fn((mime: string) => store.get(mime) ?? ''),
    clearData: vi.fn(),
    get types() {
      return [...store.keys()];
    },
  } as unknown as DataTransfer;
}

function dragTo(container: HTMLElement, sourceSel: string, targetSel: string): void {
  const source = container.querySelector(sourceSel) as HTMLElement;
  const target = container.querySelector(targetSel) as HTMLElement;
  expect(source, sourceSel).toBeTruthy();
  expect(target, targetSel).toBeTruthy();
  const dt = makeDt();
  fireEvent.dragStart(source, { dataTransfer: dt });
  fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
}

describe('R8/R11/D-1 (08-27 B2): NTP blank-menu guard + insert chapter + ghost guard + cancel-drop', () => {
  /** 插入章夹具：s0@ch0 / s1@ch1（右移面）+ sSent 哨兵（不动）+ 宽卡 ss spans e0..e2。 */
  function insertFixtureGraph(): SceneGraph {
    return parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        { id: 's0', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
        { id: 's1', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 3 } },
        { id: 'sSent', lineTags: ['l1'], storyTime: 9, role: 'normal', presentationOrder: { chapter: 999999, pos: 0 } },
        {
          id: 'ss', lineTags: ['l1'], storyTime: 4, role: 'normal',
          presentationOrder: { chapter: 0, pos: 2 },
          presentationSpans: [{ episodeId: 'e0', pos: 2 }, { episodeId: 'e2', pos: 0 }],
        },
      ],
      edges: [],
    });
  }

  const EPS4 = () =>
    episodeOutlinesSchema.parse([
      { id: 'e0', index: 0, title: '第一章' },
      { id: 'e1', index: 1, title: '第二章' },
      { id: 'e2', index: 2, title: '第三章' },
      { id: 'e3', index: 3, title: '第四章' },
    ]);

  function seed(graph: SceneGraph, episodes = EPS4()) {
    useAppStore.setState({
      creativeFields: { scene_graph: graph, episode_outlines: episodes },
      overlayToggles: { validation: false, displacement: false, visibility: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      focusedLineId: null,
      drawerTitleFocus: false,
      currentProject: null,
    } as any);
  }

  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    seed(insertFixtureGraph());
  });

  afterEach(() => {
    cleanup();
    updateSpy?.mockRestore();
  });

  it('首列左侧（local<0：角格/标签带坐标）右键 → 无菜单（不再钳回章 0 出错位承诺）', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // jsdom 零矩形 + zoom=1：clientX 默认 0 → local = −160（泳道标签带）→ 早退。
    fireEvent.contextMenu(container.querySelector('.narrative-timeline-corner') as HTMLElement);
    expect(container.querySelector('[data-testid="timeline-ctx-menu"]')).toBeNull();
    // 对照：进第 1 章轨（local=50 ∈ [0,108)）→ 菜单照常出（守卫只挡标签带，不挡章轨）。
    fireEvent.contextMenu(container.querySelector('.narrative-timeline-corner') as HTMLElement, {
      clientX: 210,
      clientY: 10,
    });
    expect(container.querySelector('[data-testid="timeline-ctx-menu"]')).not.toBeNull();
  });

  it('R11 批3 列头菜单 insert-chapter：双字段落盘（章表 k 位新章 + 裸章号右移 + 哨兵/spans 不动）', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-col-value="1"]') as HTMLElement);
    const item = container.querySelector('[data-menu-key="insert-chapter"]') as HTMLButtonElement;
    expect(item).not.toBeNull();
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[0][0]).toBe('episode_outlines');
    expect(updateSpy.mock.calls[1][0]).toBe('scene_graph');
    const eps = useAppStore.getState().creativeFields.episode_outlines as ReturnType<typeof EPS4>;
    expect(new Map(eps.map((e) => [e.index, e.id]))).toEqual(
      new Map([[0, 'e0'], [1, 'ep-1'], [2, 'e1'], [3, 'e2'], [4, 'e3']])
    );
    const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const ch = (id: string) => g.nodes.find((n) => n.id === id)!.presentationOrder!.chapter;
    expect(ch('s0')).toBe(0);
    expect(ch('s1')).toBe(2);
    expect(ch('sSent')).toBe(999999);
    // 宽卡裸章号 0（< k）不动 + spans 零触碰（byId 引用随章表安全漂移）。
    expect(ch('ss')).toBe(0);
    expect(g.nodes.find((n) => n.id === 'ss')!.presentationSpans)
      .toEqual([{ episodeId: 'e0', pos: 2 }, { episodeId: 'e2', pos: 0 }]);
  });

  it('ghost drawer 守卫：写通道未落图（updateField 失效注入）→ 列头 ＋ 建后不选 ghost 不开抽屉', () => {
    updateSpy = vi
      .spyOn(useAppStore.getState(), 'updateField')
      .mockImplementation(() => {});
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.click(container.querySelector('[data-col-value="1"] [data-action="add-scene"]') as HTMLElement);
    expect(useAppStore.getState().selectedNodeId).toBeNull();
    expect(useAppStore.getState().drawerTitleFocus).not.toBe(true);
  });

  it('D-1 统一取消式：宽卡（spans e0..e2 → 区间 [0..2]）投回自身覆盖区间内列（中段 ch1/尾段 ch2）= 零写、spans 完整', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<NarrativeTimelinePanel />);
    dragTo(container, '.scene-card[data-node-id="ss"]', '[data-col-value="1"]');
    dragTo(container, '.scene-card[data-node-id="ss"]', '[data-col-value="2"]');
    expect(updateSpy).not.toHaveBeenCalled();
    const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const ss = g.nodes.find((n) => n.id === 'ss')!;
    expect(ss.presentationOrder!.chapter).toBe(0);
    expect(ss.presentationSpans).toEqual([{ episodeId: 'e0', pos: 2 }, { episodeId: 'e2', pos: 0 }]);
  });

  it('D-1 对照：区间外落点（ch3）照常真移（applyChapterDrop 剥 spans 写章——守卫不过界）', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<NarrativeTimelinePanel />);
    dragTo(container, '.scene-card[data-node-id="ss"]', '[data-col-value="3"]');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const ss = g.nodes.find((n) => n.id === 'ss')!;
    expect(ss.presentationOrder!.chapter).toBe(3);
    expect(ss.presentationSpans).toBeUndefined(); // 因果侧无保宽 op——挪章即剥（既有语义）
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T7（发现批4·深夜二轮视觉终审）：任一端点为待编排场景（哨兵列）的因果边零渲染
// ——T4「指向待编排列的线无论如何都不显示」用户拍板对锚弧族的延伸（真机坐标
// 换算证实 T4 后残留线＝汇入待编排列的弧族；关联线族已滤零，剩余汇入者即因果边）。
// 无选中豁免；数据面不动（派生/校验不受渲染滤除影响）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mixed fixture: 2 placed scenes (ch0/ch1) + 2 dangling (章号 90/91 无对应
 * episode → 待编排列哨兵列)。三条边：placed→placed（应渲染）/ placed→pending /
 * pending→pending（后两条零渲染）。
 */
function pendingEdgeGraph(): SceneGraph {
  return parseGraph({
    lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }],
    nodes: [
      { id: 'ok1', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 'ok2', lineTags: ['l_main'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 0 } },
      { id: 'dang1', lineTags: ['l_main'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 90, pos: 0 } },
      { id: 'dang2', lineTags: ['l_main'], storyTime: 4, role: 'normal', presentationOrder: { chapter: 91, pos: 0 } },
    ],
    edges: [
      { id: 'e_ok', from: 'ok1', to: 'ok2', type: 'CAUSAL' },
      { id: 'e_to_pending', from: 'ok1', to: 'dang1', type: 'CAUSAL' },
      { id: 'e_p2p', from: 'dang1', to: 'dang2', type: 'SUSPENSE' },
    ],
  });
}

describe('T7: causal edges with a pending endpoint render ZERO (no selected exemption)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: pendingEdgeGraph(),
        episode_outlines: episodeOutlinesSchema.parse([
          { id: 'e0', index: 0, title: '第一章' },
          { id: 'e1', index: 1, title: '第二章' },
        ]),
      },
      overlayToggles: { validation: true, displacement: false, visibility: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('placed→pending and pending→pending edges draw no path; placed→placed still draws', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const paths = container.querySelectorAll('svg path[data-edge-id]');
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute('data-edge-id')).toBe('e_ok');
    expect(container.querySelector('path[data-edge-id="e_to_pending"]')).toBeNull();
    expect(container.querySelector('path[data-edge-id="e_p2p"]')).toBeNull();
  });

  it('selecting the pending scene does NOT resurrect its edges (no exemption path)', () => {
    useAppStore.setState({ selectedNodeId: 'dang1' } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    expect(container.querySelector('path[data-edge-id="e_to_pending"]')).toBeNull();
    expect(container.querySelector('path[data-edge-id="e_p2p"]')).toBeNull();
    expect(container.querySelectorAll('svg path[data-edge-id]')).toHaveLength(1);
  });

  it('render-only filter: pending cards still render in the mirror rail (data face untouched)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const rail = container.querySelector(
      '.narrative-timeline-cell-stack--pending'
    ) as HTMLElement;
    expect(rail.querySelector('.scene-card[data-node-id="dang1"]')).not.toBeNull();
    expect(rail.querySelector('.scene-card[data-node-id="dang2"]')).not.toBeNull();
  });
});
