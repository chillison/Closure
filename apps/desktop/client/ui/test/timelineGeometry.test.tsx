/**
 * timelineGeometry 算术锁定。
 *
 * 08-26 批 7 注（design §11「同构锁步」）：等距列宽族（colWidth 96 / totalGridWidth /
 * structureLeftWidth / sceneCardBox 常量 x 数学）随因果骨架换轴**整族退役删除**
 * （grep 守门零引用）。保留/新增段：
 *   - 共享轨道单源：sharedColumnTracks / sharedTrackCount / nominalChapterWidths /
 *     nominalTimelineRegionWidth（宿主 inline 模板与两区内网格的同一口径）；
 *   - 双查表：computeRowOffsets / computeColOffsets（cumulativeOffsets 核心）+
 *     resolveEndpointPixel（y 行表 + x 列表）+ overlayCardBox + colIndexAtX 反查；
 *   - gap 46 保留带锁定（design §1.1 恒定）。
 *   - 渲染侧事实核对（NTP 集成）：add-line 行渲染在 rows+2；边 path y 回退表 +
 *     lane-hue 线色类。
 *
 * Run: `cd apps/desktop/client/ui && pnpm test timelineGeometry`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { episodeOutlinesSchema, sceneGraphSchema, type SceneGraph } from '@orison/shared-contracts';
import { NarrativeTimelinePanel } from '../src/features/structure/NarrativeTimelinePanel';
import { buildEdgePath } from '../src/features/structure/EdgeLayer';
import { MAX_CHAPTER_TRACKS, WORKBENCH_GEOMETRY } from '../src/features/structure/workbenchLayout';
import {
  colIndexAtX,
  collectStackBands,
  computeColOffsets,
  computeRowOffsets,
  nominalChapterWidths,
  nominalTimelineRegionWidth,
  overlayCardBox,
  resolveEndpointPixel,
  sharedColumnTracks,
  sharedTrackCount,
  stackBandsEqual,
  TIMELINE_GEOMETRY,
  type StackBandTable,
} from '../src/features/structure/timelineGeometry';
import { useAppStore } from '../src/shared/store/appStore';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

function oneRowGraph(): SceneGraph {
  return parseGraph({
    lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    nodes: [
      { id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
    ],
    edges: [],
  });
}

const EPISODES = () =>
  episodeOutlinesSchema.parse([
    { id: 'e0', index: 0, title: '第一章' },
    { id: 'e1', index: 1, title: '第二章' },
  ]);

// ─────────────────────────────────────────────────────────────────────────────
// 批 7 单源锁定：共享轨道模板 + 名义列宽表
// ─────────────────────────────────────────────────────────────────────────────
describe('shared track template single source (batch 7 locks)', () => {
  it('sharedColumnTracks mirrors the chapter template lane + repeat(minmax) + fixed pending', () => {
    expect(sharedColumnTracks(3)).toBe(
      `${TIMELINE_GEOMETRY.laneLabelWidth}px repeat(3, minmax(${WORKBENCH_GEOMETRY.chapterMinWidth}px, max-content)) ${WORKBENCH_GEOMETRY.pendingColumnWidth}px`
    );
    // 零章退化「仅待编排列」（§11 定案 5）——repeat(0,…) 非法构造被跳过。
    expect(sharedColumnTracks(0)).toBe(
      `${TIMELINE_GEOMETRY.laneLabelWidth}px ${WORKBENCH_GEOMETRY.pendingColumnWidth}px`
    );
    // 守门沿用批 3：minmax 内不得嵌 min()（整条模板失效坑——mockup 钉住）。
    const template = sharedColumnTracks(4);
    expect(template).not.toMatch(/minmax\(\s*min\(/);
    expect(template).not.toContain('min(');
  });

  it('sharedTrackCount = chapters + pending; nominal widths mirror the real tracks', () => {
    expect(sharedTrackCount(5)).toBe(6);
    expect(nominalChapterWidths(2)).toEqual([108, 108, WORKBENCH_GEOMETRY.pendingColumnWidth]);
    expect(WORKBENCH_GEOMETRY.pendingColumnWidth).toBe(220); // #46 定宽锁沿袭
  });

  it('nominalTimelineRegionWidth = pad×2 + lane + Σ nominal widths（minimap jsdom 回退单源）', () => {
    const lane = TIMELINE_GEOMETRY.laneLabelWidth;
    expect(nominalTimelineRegionWidth(2)).toBe(
      2 * TIMELINE_GEOMETRY.timelineScrollPadding + lane + 108 * 2 + 220
    );
  });

  it('批 1 保留带恒定：skeletonGapHeight 46（design §1.1）', () => {
    expect(TIMELINE_GEOMETRY.skeletonGapHeight).toBe(46);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 双查表算术：行高（批 2 方案沿袭）/ 列宽（批 7 新增）
// ─────────────────────────────────────────────────────────────────────────────
describe('cumulative offset tables', () => {
  it('row/col offsets share one cumulative core; negatives clamp to 0', () => {
    expect(computeRowOffsets([80, 50])).toEqual([0, 80, 130]);
    expect(computeColOffsets([100, 120, 90])).toEqual([0, 100, 220, 310]);
    expect(computeColOffsets([-5, 40])).toEqual([0, 0, 40]);
  });

  it('resolveEndpointPixel: y from the row table (stack 分位), x from the column table', () => {
    const ep = { lineId: 'l1', colValue: 1, subIndex: 0 };
    const rowOffsets = computeRowOffsets([80, 50]);
    const colOffsets = computeColOffsets([108, 212]);
    // row0 y = header(32)+40；x = lane(160) + 表[0]=0 + 列宽 108/2。
    expect(resolveEndpointPixel(ep, { rowIndex: 0, colIndex: 0, stackSize: 1, rowOffsets, colOffsets })).toEqual({
      x: 160 + 54,
      y: 32 + 40,
    });
    // row1 y = 32+80+25；col1 x = 160+108+106。
    expect(resolveEndpointPixel(ep, { rowIndex: 1, colIndex: 1, stackSize: 1, rowOffsets, colOffsets })).toEqual({
      x: 160 + 108 + 106,
      y: 32 + 80 + 25,
    });
  });

  it('collision stack distributes vertically: card i centre at (i+0.5)/S of the row height', () => {
    const ctx = {
      rowIndex: 0,
      colIndex: 0,
      stackSize: 2,
      rowOffsets: computeRowOffsets([100]),
      colOffsets: computeColOffsets([108]),
    };
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 0 }, ctx)!.y).toBe(32 + 25);
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 1 }, ctx)!.y).toBe(32 + 75);
    // 同列同 x（纵向平铺）。
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 0 }, ctx)!.x)
      .toBe(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 1 }, ctx)!.x);
  });

  it('CR 组1 #123: short/out-of-range tables return NULL (skip-draw) instead of a zero-size point', () => {
    // 语义变化记档（原「degrade to zero 不崩」锁已废）：越界端点现在返回 null，
    // 调用方（NTP resolvedEdges）与悬空边同一策略整条跳过——不再画 0 尺寸假线头。
    const p = { rowIndex: 5, colIndex: 3, stackSize: 1, rowOffsets: [0, 64], colOffsets: [0] };
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 9, subIndex: 0 }, p)).toBeNull();
    // 缺右缘的过渡帧（长度不足一列）同样 null——不按 0 宽合成出点。
    expect(
      resolveEndpointPixel(
        { lineId: 'l1', colValue: 0, subIndex: 0 },
        { rowIndex: 0, colIndex: 0, stackSize: 1, rowOffsets: [0], colOffsets: [0] }
      )
    ).toBeNull();
    // 完整表内恒非空。
    expect(
      resolveEndpointPixel(
        { lineId: 'l1', colValue: 0, subIndex: 0 },
        { rowIndex: 0, colIndex: 0, stackSize: 1, rowOffsets: [0, 64], colOffsets: [0, 108] }
      )
    ).not.toBeNull();
  });

  it('overlayCardBox approximates the card footprint from both tables (PacingOverlay 消费)', () => {
    const box = overlayCardBox(
      { rowIndex: 0, colIndex: 1, stackSize: 1, subIndex: 0 },
      computeRowOffsets([64]),
      computeColOffsets([108, 212])
    );
    const { laneLabelWidth, cellStackPadding } = TIMELINE_GEOMETRY;
    expect(box.left).toBe(laneLabelWidth + 108 + cellStackPadding);
    expect(box.top).toBe(TIMELINE_GEOMETRY.headerHeight + cellStackPadding);
    expect(box.width).toBe(212 - 2 * cellStackPadding);
    expect(box.height).toBe(TIMELINE_GEOMETRY.rowHeight - 2 * cellStackPadding);
  });

  it('colIndexAtX inverse lookup clamps into [0, count-1]', () => {
    const offsets = [0, 108, 216]; // 两章各 108 + 待编排起点（数组语义长度=轨道数+1）
    expect(colIndexAtX(offsets, 0)).toBe(0);
    expect(colIndexAtX(offsets, 107.9)).toBe(0);
    expect(colIndexAtX(offsets, 108)).toBe(1);
    expect(colIndexAtX(offsets, 9999)).toBe(1); // 越界钳末轨
    expect(colIndexAtX([0], 50)).toBe(0);
  });

  it('buildEdgePath carries the table-resolved points into the SVG path d', () => {
    const rowOffsets = computeRowOffsets([80, 50]);
    const colOffsets = computeColOffsets([108, 212]);
    const from = resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 0 }, { rowIndex: 0, colIndex: 0, stackSize: 1, rowOffsets, colOffsets })!;
    const to = resolveEndpointPixel({ lineId: 'l1', colValue: 1, subIndex: 0 }, { rowIndex: 1, colIndex: 1, stackSize: 1, rowOffsets, colOffsets })!;
    const d = buildEdgePath(from, to);
    expect(d).toContain(`M ${from.x} ${from.y}`);
    expect(d).toContain(`${to.x} ${to.y}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR 组1 数值边界族（#124b/c/d）+ #119 实测纵带 + #125 轨道封顶
// ─────────────────────────────────────────────────────────────────────────────
describe('cumulativeOffsets NaN/Infinity defense (CR 组1 #124b)', () => {
  it('non-finite entries are treated as 0 — one bad cell no longer poisons the tail', () => {
    // 原 Math.max(0, NaN) === NaN 直进累加链，坏项之后全部偏移被污染。
    expect(computeRowOffsets([80, Number.NaN, 50])).toEqual([0, 80, 80, 130]);
    expect(computeColOffsets([Number.NaN, -5, Number.POSITIVE_INFINITY, 40])).toEqual([0, 0, 0, 0, 40]);
    expect(computeRowOffsets([])).toEqual([0]);
  });

  it('finite values keep the legacy arithmetic byte-for-byte (good path unchanged)', () => {
    expect(computeColOffsets([-5, 40, 120])).toEqual([0, 0, 40, 160]);
  });
});

describe('resolveEndpointPixel subIndex clamp (CR 组1 #124c)', () => {
  const ctx = {
    rowIndex: 0,
    colIndex: 0,
    stackSize: 2,
    rowOffsets: computeRowOffsets([100]),
    colOffsets: computeColOffsets([108]),
  };
  it('negative / overflowing / non-finite subIndex clamp into [0, stack-1]（不漂邻泳道）', () => {
    // 基准：合法 subIndex 0/1 → 25/75。
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 0 }, ctx)!.y).toBe(32 + 25);
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 1 }, ctx)!.y).toBe(32 + 75);
    // 越界曾按原值进分位公式冲出行带；现在钳边界。
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: -3 }, ctx)!.y).toBe(32 + 25);
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 7 }, ctx)!.y).toBe(32 + 75);
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: Number.NaN }, ctx)!.y).toBe(32 + 25);
    // x 维不受 subIndex 影响。
    expect(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 7 }, ctx)!.x)
      .toBe(resolveEndpointPixel({ lineId: 'l1', colValue: 0, subIndex: 0 }, ctx)!.x);
  });
});

describe('overlayCardBox negative-size guards (CR 组1 #124d)', () => {
  it('column narrower than 2×padding clamps width to 0 instead of feeding a negative inline style', () => {
    const box = overlayCardBox(
      { rowIndex: 0, colIndex: 0, stackSize: 1, subIndex: 0 },
      computeRowOffsets([64]),
      computeColOffsets([6]) // 列宽 6 < 2×cellStackPadding(4)
    );
    expect(box.width).toBe(0);
    expect(box.height).toBeGreaterThanOrEqual(0);
  });

  it('stack overflow subIndex clamps; degenerate tables degrade to zero boxes without NaN', () => {
    const box = overlayCardBox(
      { rowIndex: 0, colIndex: 0, stackSize: 2, subIndex: 9 },
      computeRowOffsets([64]),
      computeColOffsets([108])
    );
    // subIndex 钳到 1 → 卡顶落在下半分位。
    expect(box.top).toBe(TIMELINE_GEOMETRY.headerHeight + 32 + TIMELINE_GEOMETRY.cellStackPadding);
    const empty = overlayCardBox(
      { rowIndex: 4, colIndex: 7, stackSize: 3, subIndex: 0 },
      [0], [0]
    );
    expect(empty.width).toBe(0);
    expect(empty.height).toBe(0);
    expect(Number.isFinite(empty.top)).toBe(true);
  });
});

describe('measured stack bands (CR 组1 #119 / 裁决 1A)', () => {
  const ep = { lineId: 'l1', colValue: 0, subIndex: 0 };
  const rowOffsets = computeRowOffsets([100]);
  const colOffsets = computeColOffsets([108]);
  const ctx = { rowIndex: 0, colIndex: 0, stackSize: 2, rowOffsets, colOffsets };
  const bands: StackBandTable = new Map([
    ['l1|0', [{ top: 200.5, height: 42 }, { top: 250, height: 38 }]],
  ]);

  it('endpoint y takes the REAL band vertical centre when measured bands are available', () => {
    const p = resolveEndpointPixel(ep, ctx, bands)!;
    expect(p.y).toBe(200.5 + 21); // 真卡缘中心，非 (subIndex+0.5)/S × 行高近似
    expect(p.x).toBe(160 + 54);   // x 无堆叠语义，仍走列查表
    const p1 = resolveEndpointPixel({ ...ep, subIndex: 1 }, ctx, bands)!;
    expect(p1.y).toBe(269);
  });

  it('invalid measured bands (NaN/negative height/missing bucket) fall back to the table formula', () => {
    const junk: StackBandTable = new Map([
      ['l1|0', [{ top: Number.NaN, height: 42 }, { top: 250, height: -1 }]],
    ]);
    expect(resolveEndpointPixel(ep, ctx, junk)!.y).toBe(32 + 25);        // band[0] 无效 → 回退
    expect(resolveEndpointPixel({ ...ep, subIndex: 1 }, ctx, junk)!.y).toBe(32 + 75); // band[1] 负高 → 回退
    expect(resolveEndpointPixel(ep, ctx, new Map())!.y).toBe(32 + 25);   // 空表 → 回退
  });

  it('overlay box uses the real card edge as its top (节奏细条贴真实卡缘)', () => {
    const { laneLabelWidth, cellStackPadding } = TIMELINE_GEOMETRY;
    const box = overlayCardBox(
      { rowIndex: 0, colIndex: 0, stackSize: 2, subIndex: 1, lineId: 'l1', colValue: 0 },
      rowOffsets,
      colOffsets,
      bands
    );
    expect(box.top).toBe(250);                    // 实测真顶缘（旧公式是 header+50+pad）
    expect(box.height).toBe(38);                  // 实测真高
    expect(box.left).toBe(laneLabelWidth + cellStackPadding); // 水平仍查表口径
  });

  it('overlay box keeps the legacy formula when lineId/colValue context is absent', () => {
    const box = overlayCardBox(
      { rowIndex: 0, colIndex: 0, stackSize: 1, subIndex: 0 },
      rowOffsets,
      colOffsets,
      bands
    );
    expect(box.top).toBe(TIMELINE_GEOMETRY.headerHeight + TIMELINE_GEOMETRY.cellStackPadding);
  });

  function stubRect(el: Element, top: number, height: number, left = 0, width = 10) {
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top, bottom: top + height, left, right: left + width, width, height }),
    });
  }

  it('collectStackBands groups cards by data-line-id × nearest data-chapter and normalizes by zoom', () => {
    document.body.innerHTML = '';
    const grid = document.createElement('div');
    stubRect(grid, 10, 400, 0, 300);
    const mkStack = (chapter: string) => {
      const stack = document.createElement('div');
      stack.setAttribute('data-chapter', chapter);
      grid.appendChild(stack);
      return stack;
    };
    const c0 = mkStack('0');
    const cp = mkStack('pending');
    const mkCard = (parent: Element, lineId: string) => {
      const card = document.createElement('div');
      card.className = 'scene-card';
      card.setAttribute('data-line-id', lineId);
      parent.appendChild(card);
      return card;
    };
    const a = mkCard(c0, 'l1');
    const b = mkCard(c0, 'l1');
    const g = mkCard(cp, 'l2');
    // 无 data-line-id 的裸卡 → 收集器跳过（归属键不全，宁可缺带不可错键）。
    const stray = document.createElement('div');
    stray.className = 'scene-card';
    c0.appendChild(stray);
    stubRect(a, 40, 30, 170, 100);
    stubRect(b, 74, 26, 170, 100);
    stubRect(g, 120, 28, 170, 100);

    const zoomFactor = 2;
    const table = collectStackBands(grid, zoomFactor);
    // ÷zoom 归一：(top-baseTop)/zoom、height/zoom。
    expect(table.get('l1|0')).toEqual([{ top: 15, height: 15 }, { top: 32, height: 13 }]);
    expect(table.get('l2|-1')).toEqual([{ top: 55, height: 14 }]); // pending → 哨兵 -1 键
    expect(table.size).toBe(2);
  });

  it('collectStackBands refuses unusable inputs (null/unlaid-out/jsdom zero rects) with an empty table', () => {
    expect(collectStackBands(null, 1).size).toBe(0);
    expect(collectStackBands(undefined, 1).size).toBe(0);
    expect(collectStackBands(document.createElement('div'), 1).size).toBe(0); // 未布局零 rect
    // 非法 zoom 视作 1 处理，不抛。
    expect(collectStackBands(null, Number.NaN).size).toBe(0);
  });

  it('stackBandsEqual is a deep-by-value comparison used as the re-measure debounce', () => {
    const t1: StackBandTable = new Map([['a|0', [{ top: 1, height: 2 }]]]);
    const t2: StackBandTable = new Map([['a|0', [{ top: 1, height: 2 }]]]);
    const t3: StackBandTable = new Map([['a|0', [{ top: 1.0001, height: 2 }]]]);
    const t4: StackBandTable = new Map([['a|0', [{ top: 1, height: 2 }, { top: 3, height: 4 }]]]);
    const t5: StackBandTable = new Map([['b|0', [{ top: 1, height: 2 }]]]);
    expect(stackBandsEqual(t1, t1)).toBe(true); // 同引用短路
    expect(stackBandsEqual(t1, t2)).toBe(true);
    expect(stackBandsEqual(t1, t3)).toBe(false);
    expect(stackBandsEqual(t1, t4)).toBe(false);
    expect(stackBandsEqual(t1, t5)).toBe(false);
    expect(stackBandsEqual(new Map(), new Map())).toBe(true);
  });
});

describe('dense track cap (CR 组1 #125 配套：模板生成侧同界钳)', () => {
  it('sharedColumnTracks / sharedTrackCount / nominalChapterWidths clamp to MAX_CHAPTER_TRACKS', () => {
    const huge = MAX_CHAPTER_TRACKS + 5000;
    // 封顶域内形态正确（重复 N 段 + 待编排尾轨）：
    expect(sharedColumnTracks(2)).toContain(`repeat(2, minmax(${WORKBENCH_GEOMETRY.chapterMinWidth}px, max-content))`);
    // 超界 → repeat 段数被钳到上限（解析 repeat(N,) 计数——'max-content' 字面在
    // 模板里只出现一次，不能当段数锚）。
    const repeated = Number(/repeat\((\d+),/.exec(sharedColumnTracks(huge))?.[1] ?? -1);
    expect(repeated).toBe(MAX_CHAPTER_TRACKS);
    expect(sharedTrackCount(huge)).toBe(MAX_CHAPTER_TRACKS + 1);
    expect(nominalChapterWidths(huge)).toHaveLength(MAX_CHAPTER_TRACKS + 1);
    expect(nominalChapterWidths(0)).toEqual([WORKBENCH_GEOMETRY.pendingColumnWidth]);
    // 合法大数（恰在界上/下）不误伤：
    expect(sharedTrackCount(MAX_CHAPTER_TRACKS)).toBe(MAX_CHAPTER_TRACKS + 1);
    expect(sharedTrackCount(0)).toBe(1);
  });
});

describe('EdgeLayer y through NarrativeTimelinePanel (jsdom fallback integration)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: oneRowGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
    } as any);
  });
  afterEach(() => cleanup());

  it('edge path d resolves y from the fallback table (= header + row centre) and rides the line hue class', async () => {
    // jsdom 实测全 0 → 行高回退 64/行；两场景同章碰撞堆 2 张——subIndex 分位
    // 0.25/0.75（批 7 章轴 fixture 形态）。
    const twoNodes = sceneGraphSchema.parse({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
        { id: 's2', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 1 } },
      ],
      edges: [{ id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' }],
    });
    useAppStore.setState({ creativeFields: { scene_graph: twoNodes, episode_outlines: EPISODES() } } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    const path = container.querySelector('path[data-edge-id="e1"]') as SVGPathElement;
    expect(path).not.toBeNull();
    const header = TIMELINE_GEOMETRY.headerHeight;
    const quarter = TIMELINE_GEOMETRY.rowHeight / 4;
    expect(path.getAttribute('d')).toContain(` ${header + quarter} `);   // subIndex 0 → .25
    expect(path.getAttribute('d')).toContain(` ${header + 3 * quarter}`); // subIndex 1 → .75
    // 线色挂法：path 带 from 线的 lane-hue 类（线内边上线色，批 2 先例沿袭）。
    const { lineHueIndex } = await import('../src/features/structure/linePalette');
    expect(path.classList.contains(`lane-hue--c${lineHueIndex('l1')}`)).toBe(true);
    // 行轨道 auto（卡高自适应）；列模板 = inline 'subgrid'（批 7 接轨宿主——
    // 自算等距 repeat(N,96px) 字符串零残留）。
    const grid = container.querySelector('.narrative-timeline-grid') as HTMLElement;
    expect(grid.style.gridTemplateRows).toContain('auto');
    expect(grid.style.gridTemplateColumns).toBe('subgrid');
  });
});

describe('add-line row renders (integration premise for the fixed height)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: oneRowGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
    } as any);
  });
  afterEach(() => cleanup());

  it('renders the add-line row at grid row rows+2', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const addLine = container.querySelector('.narrative-timeline-add-line') as HTMLElement;
    expect(addLine).not.toBeNull();
    expect(addLine.style.gridRow).toBe('3');
  });
});
