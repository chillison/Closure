/**
 * dogfood R2 批次 B（SP-5）：全书迷你地图 测试。
 *
 * 两层：
 *   1. 纯换算函数（minimapTrackWidth / minimapViewportBox /
 *      scrollLeftForMinimapX——线色下标 lineHueIndex 的测试在 linePalette.test）
 *      ——jsdom 不做 layout，换算全常量可精确断言。
 *   2. StructurePage 集成：块渲染（每场景一枚、轨道内像素 = 列号×4）、卷刻度 +
 *      卷名、点击/拖动驱动 .structure-page.scrollLeft、scroll 事件联动视口框。
 *
 * Run: `cd apps/desktop/client/ui && pnpm test timelineMinimap`
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sceneGraphSchema, outlineV2Schema, type SceneGraph } from '@orison/shared-contracts';
import { StructurePage } from '../src/features/structure/StructurePage';
import { LINE_PALETTE_SIZE, lineHueIndex } from '../src/features/structure/linePalette';
import {
  MINIMAP_TRACK_HEIGHT,
  minimapLaneRow,
  minimapTrackWidth,
  minimapViewportBox,
  scrollLeftForMinimapX,
} from '../src/features/structure/TimelineMinimap';
import {
  nominalTimelineRegionWidth,
  TIMELINE_GEOMETRY,
} from '../src/features/structure/timelineGeometry';
import { useAppStore } from '../src/shared/store/appStore';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

// dogfood R2 #80：卷刻度权威源 = episode.phase_ref（章轴集映射——线上 phase_ref
// 不再参与卷带推导）。
const EPISODES = [
  { id: 'e0', index: 0, title: '第一章', phase_ref: 'p1' },
  { id: 'e1', index: 1, title: '第二章', phase_ref: 'p1' },
];

function outline() {
  return outlineV2Schema.parse({
    phases: [{ id: 'p1', title: '卷一·觉醒' }],
  });
}

/**
 * 2 线 × 2 章：l1（主线，phase p1）s1@章0、s2@章1；l2（副线，无锚）s3@章1。
 * 批 7 章轴：块位置 = 归属章轨道（uniform slot 示意——精度取舍注记见组件文件头）。
 */
function graph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' },
      { id: 'l2', name: '闲笔', topology_role: 'side' },
    ],
    nodes: [
      { id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's2', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 0 } },
      { id: 's3', lineTags: ['l2'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 1 } },
    ],
    edges: [],
  });
}

const OVERLAYS = { validation: true, displacement: true, visibility: true, emotion: false, pacing: false };
// 共享轨道基数 = 章轨道 2（e0/e1）+ 待编排 1 = 3 → 轨道宽 12px；
// 内容宽 = 名义表：nominalTimelineRegionWidth(2) = 12×2 + 160 + 108×2 + 220 = 620。
// （运行时实测在 jsdom 缺席——RO 未实现 → 名义表兜底，确定性断言成立。）
const SHARED_TRACKS = 3;
const TRACK_WIDTH = minimapTrackWidth(SHARED_TRACKS);
const CONTENT_WIDTH = nominalTimelineRegionWidth(SHARED_TRACKS - 1);

/**
 * jsdom 的 PointerEvent 不携带坐标 init（clientX 落 undefined → NaN 换算），
 * fireEvent.pointerDown 传不进去。构造带坐标的裸 Event 派发——React 的原生
 * pointerdown 监听照常收到（合成事件直接读 native event 的 clientX）。
 */
function pointerEventWithX(type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number): Event {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, 'clientX', { value: clientX });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  return ev;
}

/**
 * #79（2026-08-28 findings #79）：可捕获 ResizeObserver 替身——记录每个实例的观察
 * 目标、测试内手动触发回调（jsdom 无 RO → 组件走名义表兜底路径；实测路径需要替身
 * 才能走到）。页内还有 useDomMeasure 族的 RO（观察 canvas/网格根），按**观察目标**
 * 辨识 minimap 的实例，不按实例序。
 */
type CapturingRO = { callback: () => void; targets: Element[] };

function makeROFactory(instances: CapturingRO[]): new (callback: () => void) => ResizeObserver {
  const StubRO = class {
    callback: () => void;
    targets: Element[] = [];
    constructor(callback: () => void) {
      this.callback = callback;
      instances.push(this);
    }
    observe(target: Element): void {
      this.targets.push(target);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  return StubRO as unknown as new (callback: () => void) => ResizeObserver;
}

describe('minimap pure conversions', () => {
  it('track width = columnCount × slot width', () => {
    expect(minimapTrackWidth(3)).toBe(3 * TIMELINE_GEOMETRY.minimapColSlotWidth);
    expect(minimapTrackWidth(0)).toBe(0);
  });

  // ── 08-26 批 5（#41）：分线行几何——每线一行细带（6 线叠罗汉的解）──

  it('minimapLaneRow: 1 lane degrades to the legacy full strip (top 4 / height 18)', () => {
    // 单线 = 旧 .minimap-block CSS 默认形态（top 4 / 18px 居中满高）——退化不回退。
    expect(minimapLaneRow(0, 1)).toEqual({ top: 4, height: 18 });
  });

  it('minimapLaneRow: N lanes get distinct, non-overlapping rows inside the 26px track', () => {
    for (const lanes of [2, 3, 4, 6, 12]) {
      const rows = Array.from({ length: lanes }, (_, i) => minimapLaneRow(i, lanes));
      for (const r of rows) {
        expect(r.top).toBeGreaterThanOrEqual(0);
        expect(r.top + r.height).toBeLessThanOrEqual(MINIMAP_TRACK_HEIGHT);
        expect(r.height).toBeGreaterThanOrEqual(2);
      }
      // 行行互不重叠（top 单调且间距 ≥ 行高）。
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].top).toBeGreaterThanOrEqual(rows[i - 1].top + rows[i - 1].height - 1);
      }
    }
    // 6 线具体值：行高 floor(26/6)=4、块高 3、top = i×4。
    expect(minimapLaneRow(0, 6)).toEqual({ top: 0, height: 3 });
    expect(minimapLaneRow(5, 6)).toEqual({ top: 20, height: 3 });
  });

  it('minimapLaneRow: >13 lanes degrade gracefully (2px floor, rows compress but stay in track)', () => {
    const rows = Array.from({ length: 20 }, (_, i) => minimapLaneRow(i, 20));
    for (const r of rows) {
      expect(r.height).toBe(2);
      expect(r.top).toBeLessThanOrEqual(MINIMAP_TRACK_HEIGHT - 2);
    }
  });

  it('line colour index is stable per line id and bounded by the palette (08-26 批 1：12 hue)', () => {
    for (const id of ['l1', 'l2', '主线', 'x'.repeat(50)]) {
      const idx = lineHueIndex(id);
      expect(lineHueIndex(id)).toBe(idx); // 同 id 恒同色
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(LINE_PALETTE_SIZE);
    }
  });

  it('viewport box maps the visible window into the track, clamped to the timeline region', () => {
    // 可视窗 [100,150] ⊂ [0,1000] → 轨道 [10,15]。
    expect(minimapViewportBox(100, 50, 1000, 100)).toEqual({ left: 10, width: 5 });
    // 右缘越界裁剪：scrollLeft 990 + vw 50 → [99,100]（交集非空 → 精确映射不变）。
    expect(minimapViewportBox(990, 50, 1000, 100)).toEqual({ left: 99, width: 1 });
    // 左缘负值裁剪 + 视口为零（jsdom）→ width 0。
    expect(minimapViewportBox(-10, 0, 1000, 100)).toEqual({ left: 0, width: 0 });
    // 视口宽于区域 → 全轨框。
    expect(minimapViewportBox(0, 5000, 1000, 100)).toEqual({ left: 0, width: 100 });
  });

  it('viewport fully past the timeline region keeps a minimum-width box inside the track (CR-17)', () => {
    // 滚入右侧编织面板区（交集空）：旧行为 = 零宽细线钉死轨道右缘（读作「坏了」）；
    // 钳制兜底 = 保底一个列槽宽（4px）+ left 钳回轨道内 → 「已越过时间线右端」。
    expect(minimapViewportBox(2000, 500, 1000, 100)).toEqual({ left: 96, width: 4 });
    expect(minimapViewportBox(1005, 300, 1000, 100)).toEqual({ left: 96, width: 4 });
    // 轨道比保底还窄 → 退化全轨（不出界）。
    expect(minimapViewportBox(2000, 500, 1000, 2)).toEqual({ left: 0, width: 2 });
    // 无真实视口宽（jsdom clientWidth=0）→ 仍隐匿（不误显）。
    expect(minimapViewportBox(2000, 0, 1000, 100)).toEqual({ left: 100, width: 0 });
  });

  it('pointer x → scrollLeft centers that track position (fraction clamped, negative target floored at 0)', () => {
    expect(scrollLeftForMinimapX(TRACK_WIDTH / 2, TRACK_WIDTH, CONTENT_WIDTH, 0)).toBe(Math.round(CONTENT_WIDTH / 2));
    // 分数越界（点轨道外）→ 裁到 [0,1]。
    expect(scrollLeftForMinimapX(9999, TRACK_WIDTH, CONTENT_WIDTH, 0)).toBe(CONTENT_WIDTH);
    expect(scrollLeftForMinimapX(-5, TRACK_WIDTH, CONTENT_WIDTH, 0)).toBe(0);
    // 有视口宽时把目标位置呈现到中央：frac 0.5 → round(W×0.5 − vw/2)（W 单源推导）。
    expect(scrollLeftForMinimapX(TRACK_WIDTH / 2, TRACK_WIDTH, CONTENT_WIDTH, 200)).toBe(Math.round(CONTENT_WIDTH / 2 - 200 / 2));
    // 负目标（点最左 + 宽视口）→ 夹回 0。
    expect(scrollLeftForMinimapX(0, TRACK_WIDTH, CONTENT_WIDTH, 2000)).toBe(0);
  });
});

describe('TimelineMinimap via StructurePage (integration)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: graph(), episode_outlines: EPISODES, outline: outline() },
      overlayToggles: { ...OVERLAYS },
      resolvedLocale: 'en-US',
      // 08-26 批 1：zoom 换算参与 minimap IO 边界——隔离用例间的倍率残留。
      canvasZoom: 1,
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  function pageEl(container: HTMLElement): HTMLElement {
    const el = container.querySelector('.structure-page') as HTMLElement | null;
    expect(el).not.toBeNull();
    return el;
  }

  it('mounts exactly ONE minimap as a PAGE-LEVEL chrome child (batch 8.7 迁出因果区)', () => {
    const { container } = render(<StructurePage />);
    expect(container.querySelectorAll('.timeline-minimap')).toHaveLength(1);
    // 页级直子（chrome 带位）——sticky top+left 双轴钉驻的前提是挂在唯一的
    // 纵向滚动容器（.structure-page）下，因果骨架区内挂载随批 8.7 退役。
    const page = pageEl(container);
    const directChild = Array.from(page.children).find((el) =>
      el.classList.contains('timeline-minimap')
    );
    expect(directChild).not.toBeUndefined();
    // 因果区零残留（原占位行回收——面板内不再渲染 minimap）。
    expect(container.querySelector('[data-skeleton="causal"] .timeline-minimap')).toBeNull();
  });

  it('chrome band order: zoombar < minimap < legend < canvas (带位 = 导航件与缩放同层)', () => {
    const { container } = render(<StructurePage />);
    const page = pageEl(container);
    const zoombar = page.querySelector('.structure-zoombar') as HTMLElement;
    const minimap = page.querySelector('.timeline-minimap') as HTMLElement;
    const legend = page.querySelector('.structure-legend') as HTMLElement;
    const canvas = container.querySelector('[data-structure-canvas]') as HTMLElement;
    expect(
      zoombar.compareDocumentPosition(minimap) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      minimap.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(legend.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 在 zoom 容器外（chrome 不随画布缩放，design §3.4；换算在组件内部自洽）。
    expect(minimap.closest('[data-structure-canvas]')).toBeNull();
  });

  it('track exposes a click-to-seek hover hint (R4/AC6 discoverability)', () => {
    const { container } = render(<StructurePage />);
    const track = container.querySelector('[data-minimap-track]') as HTMLElement;
    // #37 复盘「可 seek 但不可发现」闭环：轨道 native title 携 i18n seek 提示。
    expect(track.getAttribute('title')).toBe('Click or drag to seek this position');
  });

  it('renders one block per causal cell at column-slot pixel positions', () => {
    const { container } = render(<StructurePage />);
    // 3 节点，s2/s3 各 1 cell（不同线）→ 3 块。
    const blocks = container.querySelectorAll('.minimap-block');
    expect(blocks).toHaveLength(3);
    // 批 7 章轴：s1 @ 章0 → left 0；s2(l1)/s3(l2) @ 章1 → left 4。
    const s1 = container.querySelector('[data-mm-node="s1"]') as HTMLElement;
    const s2 = container.querySelector('[data-mm-node="s2"]') as HTMLElement;
    const s3 = container.querySelector('[data-mm-node="s3"]') as HTMLElement;
    expect(s1.style.left).toBe('0px');
    expect(s2.style.left).toBe(`${TIMELINE_GEOMETRY.minimapColSlotWidth}px`);
    expect(s3.style.left).toBe(`${TIMELINE_GEOMETRY.minimapColSlotWidth}px`);
    // 块带线名 tooltip（线身份可读）。
    expect(s1.getAttribute('title')).toBe('主线 · s1');
    // 08-26 批 5（#41 分线行）：块 top/height = minimapLaneRow（laneOrder = 泳道序）。
    // 2 线 → l1 行 0（top 0/高 12）、l2 行 1（top 13/高 12）。
    expect(s1.style.top).toBe('0px');
    expect(s1.style.height).toBe('12px');
    expect(s3.style.top).toBe('13px');
    expect(s3.style.height).toBe('12px');
  });

  // ── 08-26 批 5（#41）：6 线 × 30 场景真实规模验排——分线行不糊成一坨 ──

  it('#41 six-line fixture: blocks in the SAME column land on DISTINCT lane rows (no pile-up)', () => {
    const lines = Array.from({ length: 6 }, (_, i) => ({
      id: `l${i}`, name: `线${i}`, topology_role: 'side' as const,
    }));
    // 每线 1 场景全落 storyTime 1（同列——旧实现 6 块叠同一纵向位的糊坨场景）。
    const nodes = lines.map((l, i) => ({
      id: `s${i}`, lineTags: [l.id], storyTime: 1, role: 'normal' as const,
      presentationOrder: { chapter: 0, pos: i },
    }));
    useAppStore.setState({
      creativeFields: { scene_graph: parseGraph({ lines, nodes, edges: [] }) },
    } as any);
    const { container } = render(<StructurePage />);
    const blocks = [...container.querySelectorAll('.minimap-block')] as HTMLElement[];
    expect(blocks).toHaveLength(6);
    // 6 条不同 top（分线行——每线一行细带）。
    const tops = new Set(blocks.map((b) => b.style.top));
    expect(tops.size).toBe(6);
    // 与 minimapLaneRow 单源一致（泳道序 = orderLinesByPriority）。
    for (let i = 0; i < 6; i++) {
      const row = minimapLaneRow(i, 6);
      const block = container.querySelector(`[data-mm-node="s${i}"]`) as HTMLElement;
      expect(block.style.top).toBe(`${row.top}px`);
      expect(block.style.height).toBe(`${row.height}px`);
    }
  });

  it('renders a volume tick per band — tick only, no text label (#51 糊叠退役)', () => {
    const { container } = render(<StructurePage />);
    // #80 集映射：两章集纲全挂 p1 → 单 band（线上锚不再参与）。
    const marks = container.querySelectorAll('.minimap-volume-mark');
    expect(marks).toHaveLength(1);
    // 卷名小字退役（轨道 ≈ 列数×4px，12px 标签必糊叠）——刻度线不携带任何文字。
    expect(marks[0]!.querySelector('i')).toBeNull();
    expect(marks[0]!.textContent).toBe('');
  });

  it('unassigned columns render a grey band with the i18n unassigned text', () => {
    // #80 集映射：换掉 episode 的 phase_ref（线的锚不再参与）→ 全列未分卷。
    const unassignedEps = [
      { id: 'e0', index: 0, title: '第一章' },
      { id: 'e1', index: 1, title: '第二章' },
    ];
    useAppStore.setState({
      creativeFields: {
        scene_graph: graph(),
        episode_outlines: unassignedEps,
        outline: outline(),
      },
    } as any);
    const { container } = render(<StructurePage />);
    const marks = container.querySelectorAll('.minimap-volume-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.querySelector('i')).toBeNull(); // #51：minimap 侧无文字（刻度线）
    // strip 侧照常落灰带 + i18n 文案（data-band-phase="unassigned"）。
    expect(container.querySelector('[data-band-phase="unassigned"]')).not.toBeNull();
  });

  it('clicking the track drives .structure-page scrollLeft (constant-based conversion)', () => {
    const { container } = render(<StructurePage />);
    const track = container.querySelector('[data-minimap-track]') as HTMLElement;
    const page = pageEl(container);
    // jsdom 下 track rect 全 0 → x = clientX。点轨道中央 → scrollLeft = W/2
    // （clientWidth 0 → 无居中偏移；W 经名义表单源推导）。
    fireEvent(track, pointerEventWithX('pointerdown', TRACK_WIDTH / 2));
    expect(page.scrollLeft).toBe(Math.round(CONTENT_WIDTH / 2));
  });

  it('dragging keeps seeking; pointer up ends the drag', () => {
    const { container } = render(<StructurePage />);
    const track = container.querySelector('[data-minimap-track]') as HTMLElement;
    const page = pageEl(container);
    fireEvent(track, pointerEventWithX('pointerdown', 0));
    fireEvent(track, pointerEventWithX('pointermove', TRACK_WIDTH));
    expect(page.scrollLeft).toBe(CONTENT_WIDTH);
    fireEvent(track, pointerEventWithX('pointerup', 0));
    fireEvent(track, pointerEventWithX('pointermove', 0));
    expect(page.scrollLeft).toBe(CONTENT_WIDTH); // 松手后 move 不再驱动
  });

  it('pointerup landing outside the track still ends the drag (CR-21 window fallback)', () => {
    const { container } = render(<StructurePage />);
    const track = container.querySelector('[data-minimap-track]') as HTMLElement;
    const page = pageEl(container);
    fireEvent(track, pointerEventWithX('pointerdown', 0));
    fireEvent(track, pointerEventWithX('pointermove', TRACK_WIDTH));
    expect(page.scrollLeft).toBe(CONTENT_WIDTH);
    // setPointerCapture 失败/未实现（jsdom 即如此）时轨道外的松手不会派发到轨道——
    // window 级兜底监听接收并清 draggingRef，后续纯 hover 的 move 不再劫持滚动。
    window.dispatchEvent(new Event('pointerup'));
    fireEvent(track, pointerEventWithX('pointermove', 0));
    expect(page.scrollLeft).toBe(CONTENT_WIDTH);
  });

  it('scroll events move the viewport box (left = scrollLeft fraction of the track)', () => {
    const { container } = render(<StructurePage />);
    const page = pageEl(container);
    const box = container.querySelector('[data-minimap-viewport]') as HTMLElement;
    expect(box).not.toBeNull();
    page.scrollLeft = 262;
    fireEvent.scroll(page);
    const expectedLeft = (262 / CONTENT_WIDTH) * TRACK_WIDTH;
    expect(parseFloat(box.style.left)).toBeCloseTo(expectedLeft, 2);
    // jsdom clientWidth = 0 → 框宽 0（隐匿不误导）。
    expect(parseFloat(box.style.width)).toBe(0);
  });

  it('minimap renders (empty track) even with no outline data — height stays reserved', () => {
    useAppStore.setState({ creativeFields: { scene_graph: graph() } } as any);
    const { container } = render(<StructurePage />);
    expect(container.querySelectorAll('.timeline-minimap')).toHaveLength(1);
    expect(container.querySelectorAll('.minimap-block')).toHaveLength(3);
    expect(container.querySelectorAll('.minimap-volume-mark')).toHaveLength(0);
  });

  // ── 08-26 批 1（AC5）：canvas zoom 下 minimap 的屏↔自然换算往返 ──

  it('zoom ≠ 1：视口框把屏 scrollLeft ÷zoom 归到自然量纲再映射轨道（AC5 同步不错位）', () => {
    useAppStore.setState({ canvasZoom: 0.5 } as any);
    const { container } = render(<StructurePage />);
    const page = pageEl(container);
    const box = container.querySelector('[data-minimap-viewport]') as HTMLElement;
    expect(box).not.toBeNull();
    // 屏 W/2 @zoom 0.5 → 自然 W = CONTENT_WIDTH（右端）→ left = 轨道全宽。
    page.scrollLeft = CONTENT_WIDTH / 2;
    fireEvent.scroll(page);
    expect(parseFloat(box.style.left)).toBeCloseTo(TRACK_WIDTH, 2);
    // 屏 W/4 @0.5 → 自然 W/2（正中）→ left = 轨道半宽（zoom=1 用例的同一映射）。
    page.scrollLeft = CONTENT_WIDTH / 4;
    fireEvent.scroll(page);
    expect(parseFloat(box.style.left)).toBeCloseTo(TRACK_WIDTH / 2, 2);
  });

  // 批 8 自检修正（check 08-27）：8.7 迁出 zoom 容器后轨道是页级 chrome，自身
  // 不在 .structure-canvas 的 zoom 树内——指针的轨道本地位移已是自然量纲，seek
  // 不再对它 ÷zoom（旧预期把 6÷0.5=12 当自然位移是迁出前的旧坐标系残留）。屏↔
  // 自然换算只剩滚动面两端：目标 scrollLeft ×zoom 写回 / scrollLeft ÷zoom 读入。

  it('zoom ≠ 1：seek 轨道本地位移不换算、目标 scrollLeft ×zoom 写回（8.7 迁出后的分帧）', () => {
    useAppStore.setState({ canvasZoom: 0.5 } as any);
    const { container } = render(<StructurePage />);
    const track = container.querySelector('[data-minimap-track]') as HTMLElement;
    const page = pageEl(container);
    // jsdom rect 全 0 → 屏 x = clientX = 自然位移。点 6（轨道半宽）→ frac 0.5 →
    // 目标自然 = CONTENT_WIDTH/2 → 写回 ×0.5。
    fireEvent(track, pointerEventWithX('pointerdown', TRACK_WIDTH / 2));
    expect(page.scrollLeft).toBe(Math.round((CONTENT_WIDTH / 2) * 0.5));
  });

  it('zoom ≠ 1 + nonzero track rect：只减 left 不做缩放（回归锁——防 ÷zoom 残留复潮）', () => {
    useAppStore.setState({ canvasZoom: 0.5 } as any);
    const { container } = render(<StructurePage />);
    const track = container.querySelector('[data-minimap-track]') as HTMLElement;
    const page = pageEl(container);
    // mock rect left=100：点击 clientX=103 → 自然位移 3 → frac 0.25 → 目标自然
    // CONTENT_WIDTH×0.25 → ×0.5。若旧 ÷zoom 复潮（3÷0.5=6）或漏减 left 都对不上。
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 100, width: TRACK_WIDTH,
    } as unknown as DOMRect);
    fireEvent(track, pointerEventWithX('pointerdown', 100 + TRACK_WIDTH / 4));
    expect(page.scrollLeft).toBe(Math.round(CONTENT_WIDTH * 0.25 * 0.5));
  });

  // ── #79（2026-08-28 findings #79）：测量元素换 .structure-skeleton ──
  // canvas 盒被 min-width:100% + 容器宽钳在视口宽（真机 160 章 rect 1,469），真
  // 内容宽由骨架盒溢出承载（rect 17,660）——旧实现量盒子 → seek/拖拽的分母错
  // 12 倍、只达首屏。回归锁两件：RO 观察目标必须是骨架盒 + 实测宽接管 seek 分母。

  describe('#79 measurement: skeleton, not the clamped canvas box', () => {
    let roInstances: CapturingRO[];

    beforeEach(() => {
      roInstances = [];
      vi.stubGlobal('ResizeObserver', makeROFactory(roInstances));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('RO 观察目标 = .structure-skeleton（DOM 序首个 = causal 骨架），非被钳的 canvas 盒', () => {
      const { container } = render(<StructurePage />);
      const skeleton = container.querySelector('.structure-skeleton') as HTMLElement;
      const canvas = container.querySelector('[data-structure-canvas]') as HTMLElement;
      // minimap 的 RO = 观察了骨架盒的那个实例（页内另有 useDomMeasure 族 RO
      // 观察 canvas/网格根——按目标辨识）。回归锁：量错元素（旧 canvas 盒）=
      // 拿视口宽当内容宽的 #79 根因。
      const mmRO = roInstances.find((ro) => ro.targets.includes(skeleton));
      expect(mmRO).toBeDefined();
      expect(mmRO!.targets).not.toContain(canvas);
    });

    it('skeleton 实测宽（rect÷zoom）接管 seek 分母——160 章形态全量可达', () => {
      const { container } = render(<StructurePage />);
      const skeleton = container.querySelector('.structure-skeleton') as HTMLElement;
      const mmRO = roInstances.find((ro) => ro.targets.includes(skeleton));
      expect(mmRO).toBeDefined();
      // 真机 160 章形态复刻：skeleton rect 17,660（zoom=1 → 屏宽即自然宽）。
      vi.spyOn(skeleton, 'getBoundingClientRect').mockReturnValue({
        width: 17660,
      } as unknown as DOMRect);
      act(() => mmRO!.callback());
      // seek 轨道中央 → 目标 = 实测宽/2 = 8830。名义表旧路径会得 310、量 canvas
      // 盒的 #79 病理路径得 367——分母错 12 倍正是「只达首屏」。
      const track = container.querySelector('[data-minimap-track]') as HTMLElement;
      const page = pageEl(container);
      fireEvent(track, pointerEventWithX('pointerdown', TRACK_WIDTH / 2));
      expect(page.scrollLeft).toBe(8830);
    });
  });
});
