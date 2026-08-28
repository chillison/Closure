/**
 * 08-27 结构页修复第三轮（Wave1 V 片 / R3 + #69）：页级顶部 chrome 恒驻——
 * 多屏态结构矩阵。
 *
 * 背景（findings #69 + research/cdp-evidence.md E1c/E3）：用户深纵滚后 zoombar 与
 * minimap 同时消失。取证定位主根因 = **`.structure-zoombar` 只声明了 left 轴、
 * top 轴缺省（auto）→ 纵向从不粘住**，深滚后随内容滚出视口顶；minimap 的
 * top:32px 双轴本就正确（8.7 结构无回归）。修复 = zoombar 补 top:0（CSS），本轮
 * 按 dispatch 要求补**多屏态矩阵**锁防回归。
 *
 * 矩阵形态（E3 视口漂移实证 + 08-27 三轮 CR blind V-F4 / auditor V-F2/F3 /
 * edge V-10 处方升级——纯 innerWidth 覆写在 jsdom 无任何生产代码消费，A/B 断言
 * 曾逐字符同义反复）：三态一律带 **fake-rect 假几何**（page.clientWidth/
 * clientHeight defineProperty + 轨道 getBoundingClientRect spy），使 seek 数学
 * （pointerdown → scrollLeft）与视口框映射**逐态产出不同期望值**——断言真正
 * 依赖状态几何，而非恒等不变式复读：
 *   - STATE A 宽窗（viewport 2560）
 *   - STATE B 窄窗+agent 面板挤压类比（viewport 1024——面板吃的是页容器宽非
 *     窗宽，fake 直接落在 page.clientWidth 上）
 *   - STATE C 窄窗+深纵滚（scrollTop/scrollLeft 巨值 + 滚动事件 churn——#69
 *     主诉现场；seek 断言用 **delta 形态**：监听器整个丢失时 scrollLeft 原地
 *     不动 → 红，旧 isFinite/≥0 断言测不出）
 *   - 页切换重挂载态：**真实 unmount→remount 循环**（同一次挂载内的引用恒等
 *     断言在 React 正常路径下恒真，测不出「重挂载丢链」）。
 *
 * jsdom 几何边界（诚实记档）：jsdom 不做布局，真 sticky 偏移无法断言；结构性
 * 前提（页面直子 + DOM 序）仍由 expectStickyOriginInvariants 锁定，双轴声明由
 * structureCssLock 锁定；最终几何验收归 AC5 真机回归清单（main session 执行）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run structureChromeSticky`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  episodeOutlinesSchema,
  sceneGraphSchema,
  type SceneGraph,
} from '@orison/shared-contracts';
import { StructurePage } from '../src/features/structure/StructurePage';
import { useAppStore } from '../src/shared/store/appStore';
import {
  minimapTrackWidth,
  minimapViewportBox,
  scrollLeftForMinimapX,
} from '../src/features/structure/TimelineMinimap';
import {
  nominalTimelineRegionWidth,
  sharedTrackCount,
} from '../src/features/structure/timelineGeometry';

/**
 * 章数取 19：名义内容宽 = 404 + 19×108 = 2456——宽窗 2560 与窄窗 1024 的轨道
 * 正中 seek 目标分道（0 vs 716），fake-rect 矩阵不空转的前提（见文件头注）。
 */
const CHAPTERS = 19;
/** 共享轨道基数（= 章 19 + 待编排 1）；TimelineMinimap 的 columnCount prop 同源。 */
const TRACK_TOTAL = sharedTrackCount(CHAPTERS);
/** 轨道像素宽（列 × 4px 槽）。 */
const TRACK_W = minimapTrackWidth(TRACK_TOTAL);
/** jsdom 无 RO → minimap 内容宽走名义表兜底（TimelineMinimap 文件头注的口径）。 */
const CONTENT_W = nominalTimelineRegionWidth(CHAPTERS);
/** 假轨道 rect.left = 100（钉左 chrome 偏移类比）→ 轨道正中的指针 clientX。 */
const TRACK_RECT_LEFT = 100;
const TRACK_MID_CLIENT_X = TRACK_RECT_LEFT + TRACK_W / 2;
/** 轨道正中 seek 的期望 scrollLeft（zoom=1；纯函数同源计算，无魔数漂移）。 */
const targetFor = (viewportW: number) =>
  scrollLeftForMinimapX(TRACK_W / 2, TRACK_W, CONTENT_W, viewportW);
const EXPECTED_A = targetFor(2560);
const EXPECTED_B = targetFor(1024);
/** 视口框映射期望（scroll 事件后 [data-minimap-viewport] 的 left/width）。 */
const boxFor = (scrollLeft: number, viewportW: number) =>
  minimapViewportBox(scrollLeft, viewportW, CONTENT_W, TRACK_W);

/** 1 线 2 场景最小图（hasGraph 门槛过即可——chrome 恒驻不依赖图形态）。 */
function graph(): SceneGraph {
  return sceneGraphSchema.parse({
    lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    nodes: [
      { id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's2', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 1 } },
    ],
    edges: [],
  });
}

/** 19 章大纲（章轨道数的驱动源——episodeTrackCountOf 读 maxIndex+1）。 */
function episodes() {
  return episodeOutlinesSchema.parse(
    Array.from({ length: CHAPTERS }, (_, i) => ({
      id: `e${i}`,
      index: i,
      title: `第${i + 1}章`,
    }))
  );
}

/** jsdom 视口 setter（innerWidth/Height 是 Window getter——defineProperty 覆写）。 */
function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  window.dispatchEvent(new Event('resize'));
}

/**
 * fake-rect 三件套（E3 处方）：页容器视口几何 + 轨道假 rect。
 * scrollLeft 初值取哨兵 77（非零非任一态期望值）——seek 写没写值一目了然
 * （STATE A 的期望恰为 0，零初值会掩盖「没写」与「写了 0」的差异）。
 */
function fakePageGeometry(page: HTMLElement, viewportW: number, viewportH: number) {
  Object.defineProperty(page, 'clientWidth', { value: viewportW, configurable: true });
  Object.defineProperty(page, 'clientHeight', { value: viewportH, configurable: true });
  Object.defineProperty(page, 'scrollHeight', { value: 12000, configurable: true });
  Object.defineProperty(page, 'scrollLeft', { value: 77, configurable: true, writable: true });
}

function fakeTrackRect(track: HTMLElement) {
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: TRACK_RECT_LEFT,
    top: 32,
    width: TRACK_W,
    height: 26,
    right: TRACK_RECT_LEFT + TRACK_W,
    bottom: 58,
    x: TRACK_RECT_LEFT,
    y: 32,
    toJSON: () => ({}),
  } as DOMRect);
}

/** 三态共用的「挂载 + 布好假几何 + chrome 结构前提」前置（带 container 供复检）。 */
function mountWithGeometry(viewportW: number, viewportH: number) {
  const { container } = render(<StructurePage />);
  const chrome = queryChrome(container);
  fakePageGeometry(chrome.pageEl, viewportW, viewportH);
  fakeTrackRect(chrome.minimap.querySelector('[data-minimap-track]') as HTMLElement);
  expectStickyOriginInvariants(chrome);
  return { container, chrome };
}

/** 页面直接子元素按类名取（不用 querySelector(':scope > …')——jsdom 选择器引擎版本差）。 */
function directChildByClass(pageEl: HTMLElement, cls: string): HTMLElement {
  const hit = Array.from(pageEl.children).find((el) => el.classList.contains(cls));
  expect(hit, `.structure-page direct child .${cls} present`).not.toBeUndefined();
  return hit as HTMLElement;
}

function queryChrome(container: HTMLElement) {
  const page = container.querySelector('.structure-page') as HTMLElement | null;
  expect(page, '.structure-page present').not.toBeNull();
  const pageEl = page!;
  const canvas = pageEl.querySelector('[data-structure-canvas]') as HTMLElement | null;
  // edge V-10：canvas 缺席时让断言给出可读失败，而非下游 compareDocumentPosition
  // 抛 TypeError（把结构问题伪装成测试基建崩溃）。
  expect(canvas, '[data-structure-canvas] present').not.toBeNull();
  return {
    pageEl,
    zoombar: directChildByClass(pageEl, 'structure-zoombar'),
    minimap: directChildByClass(pageEl, 'timeline-minimap'),
    legend: directChildByClass(pageEl, 'structure-legend'),
    canvas: canvas!,
  };
}

/** 恒驻前提不变式：四行 chrome 是页面直接子元素、按 zoombar→minimap→legend→canvas 排布。 */
function expectStickyOriginInvariants(c: ReturnType<typeof queryChrome>) {
  // 页面直子（scrollport 特权路径——spec/ui/layout-and-pages.md「盒子链三前提」）。
  expect(c.zoombar.parentElement).toBe(c.pageEl);
  expect(c.minimap.parentElement).toBe(c.pageEl);
  expect(c.legend.parentElement).toBe(c.pageEl);
  // DOM 序：钉顶带（zoombar=first child 供 top:0 基线，minimap=top:32 紧贴其下）
  // 全部先于 zoom 内容容器（sticky 原点高于全部滚动内容）。
  expect(c.pageEl.firstElementChild).toBe(c.zoombar);
  expect(c.zoombar.compareDocumentPosition(c.minimap)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(c.minimap.compareDocumentPosition(c.legend!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(c.legend!.compareDocumentPosition(c.canvas)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  // 缩放组/minimap 都不在 zoom 容器内（chrome 边界——缩放不改钉驻件的量纲）。
  expect(c.zoombar.closest('[data-structure-canvas]')).toBeNull();
  expect(c.minimap.closest('[data-structure-canvas]')).toBeNull();
}

/**
 * 轨道 pointerdown 携真 clientX 的派发（⚠️ 测试基建实测：本 jsdom 无
 * PointerEvent 构造器——RTL 的 fireEvent.pointerDown 落到裸 Event，clientX
 * 载荷静默丢失（e.clientX undefined → seek 防御按 0 处理）。MouseEvent
 * 构造器可携坐标；setPointerCapture 的 jsdom 未实现由组件侧 try/catch 兜底）。
 */
function pointerDownAt(el: HTMLElement, clientX: number) {
  fireEvent(el, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX }));
}

/** 轨道正中 pointerdown（seek 主路径）+ scroll 事件（视口框联动）双发。 */
function seekMidTrack(c: ReturnType<typeof queryChrome>) {
  const track = c.minimap.querySelector('[data-minimap-track]') as HTMLElement;
  expect(track, '[data-minimap-track] present').not.toBeNull();
  pointerDownAt(track, TRACK_MID_CLIENT_X);
  fireEvent.scroll(c.pageEl);
}

describe('R3 顶部 chrome 恒驻——fake-rect 多屏态矩阵（#69 回归根修锁）', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: graph(), episode_outlines: episodes() },
      resolvedLocale: 'en-US',
      canvasZoom: 1,
    } as any);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setViewport(1024, 768); // 复位默认视口（不向别的测试文件泄漏覆写）
  });

  it('matrix non-vacuity: STATE A/B geometry yields DISTINCT seek targets (fake-rect 起效前提)', () => {
    // blind V-F4 的核心批评：无几何消费的屏态断言是同义反复。此处先证三套
    // fake 几何真的分道（常量漂移使两态同值时，本断言先红——矩阵名存实亡）。
    expect(EXPECTED_A).not.toBe(EXPECTED_B);
    expect(boxFor(EXPECTED_A, 2560).width).not.toBeCloseTo(boxFor(EXPECTED_B, 1024).width, 4);
  });

  it('STATE A 宽窗（2560×1400）：chrome 带挂页面直子、轨道正中 seek 收敛视口内', () => {
    setViewport(2560, 1400);
    const { chrome } = mountWithGeometry(2560, 1400);
    seekMidTrack(chrome);
    // 期望值由同一纯函数族按本态几何计算（哨兵 77 → 0：seek 真写了）。
    expect(chrome.pageEl.scrollLeft).toBe(EXPECTED_A);
    // 视口框随 scroll 联动：宽窗下框宽 ≈ 全轨（与 B 态分道的几何证明）。
    const box = chrome.minimap.querySelector('[data-minimap-viewport]') as HTMLElement;
    const expected = boxFor(EXPECTED_A, 2560);
    expect(parseFloat(box.style.left)).toBeCloseTo(expected.left, 4);
    expect(parseFloat(box.style.width)).toBeCloseTo(expected.width, 4);
  });

  it('STATE B 窄窗+agent 面板挤压类比（1024×768）：同一结构前提 + seek 目标随几何换道', () => {
    setViewport(1024, 768);
    const { chrome } = mountWithGeometry(1024, 768);
    seekMidTrack(chrome);
    // 哨兵 77 → EXPECTED_B（716）：面板挤压后同一点击 seek 到更远的滚动位。
    expect(chrome.pageEl.scrollLeft).toBe(EXPECTED_B);
    const box = chrome.minimap.querySelector('[data-minimap-viewport]') as HTMLElement;
    const expected = boxFor(EXPECTED_B, 1024);
    expect(parseFloat(box.style.left)).toBeCloseTo(expected.left, 4);
    expect(parseFloat(box.style.width)).toBeCloseTo(expected.width, 4);
  });

  it('STATE C 窄窗+深纵滚 + 事件churn：chrome 零卸载重挂，seek 数学保持接线（delta 形态）', () => {
    setViewport(1024, 768);
    const { container, chrome: c1 } = mountWithGeometry(1024, 768);

    // 深滚模拟：覆盖布局量纲再灌巨值 scrollTop/scrollLeft + 连发滚动事件
    // （#69 现场 = 用户已滚出首屏后的状态；E3 取证的滚动钳位漂移类比）。
    Object.defineProperty(c1.pageEl, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(c1.pageEl, 'scrollTop', { value: 4000, configurable: true, writable: true });
    Object.defineProperty(c1.pageEl, 'scrollLeft', { value: 600, configurable: true, writable: true });
    for (let i = 0; i < 6; i++) fireEvent.scroll(c1.pageEl);

    // 无 unmount/remount：元素引用跨 churn 稳定（重挂载丢链类回归的直接反测）。
    const c2 = queryChrome(container);
    expect(c2.zoombar).toBe(c1.zoombar);
    expect(c2.minimap).toBe(c1.minimap);
    expect(c2.legend).toBe(c1.legend);
    expect(c2.canvas).toBe(c1.canvas);

    // minimap 仍接线：轨道 pointerdown 驱动页 scrollLeft。**delta 断言**
    // （auditor V-F3）：旧 isFinite/≥0 断言在监听器整个丢失时照样通过
    // （scrollLeft 原地 600）；此处要求 seek 真写了新值——丢失即红。
    const track = c2.minimap.querySelector('[data-minimap-track]') as HTMLElement;
    const before = c2.pageEl.scrollLeft; // 600（深滚现场）
    pointerDownAt(track, TRACK_MID_CLIENT_X);
    const after = c2.pageEl.scrollLeft;
    expect(after).not.toBe(before);
    expect(after).toBe(EXPECTED_B);
  });

  it('页切换重挂载态（AC5 第三态）：真实 unmount→remount 循环后结构前提与 seek 接线全部重建', () => {
    setViewport(1024, 768);
    // 第一段挂载（旧页）。
    const first = render(<StructurePage />);
    const c1 = queryChrome(first.container);
    fakePageGeometry(c1.pageEl, 1024, 768);
    fakeTrackRect(c1.minimap.querySelector('[data-minimap-track]') as HTMLElement);
    first.unmount();
    // 旧树整个离场——「页切换重挂载」是真卸载重建，非同一次挂载内的条件卸载
    // （auditor V-F2：原矩阵全程同一次挂载，该态零覆盖）。
    expect(c1.zoombar.isConnected).toBe(false);
    expect(c1.minimap.isConnected).toBe(false);

    // 第二段挂载（新页）：结构前提重建 + 节点全新（非陈旧引用复用）。
    const second = render(<StructurePage />);
    const c2 = queryChrome(second.container);
    expectStickyOriginInvariants(c2);
    expect(c2.zoombar).not.toBe(c1.zoombar);
    expect(c2.minimap).not.toBe(c1.minimap);
    // seek 监听器随重挂重建：哨兵 → 期望值（丢失监听即原地 77）。
    fakePageGeometry(c2.pageEl, 1024, 768);
    fakeTrackRect(c2.minimap.querySelector('[data-minimap-track]') as HTMLElement);
    seekMidTrack(c2);
    expect(c2.pageEl.scrollLeft).toBe(EXPECTED_B);
  });

  it('STATE A→B 切换（面板开合瞬窗口 resize）：结构前提跨切稳定，seek 目标随几何重算', () => {
    setViewport(2560, 1400);
    const { container, chrome } = mountWithGeometry(2560, 1400);
    seekMidTrack(chrome);
    expect(chrome.pageEl.scrollLeft).toBe(EXPECTED_A);
    // 面板开合的窗口 resize 时刻（RO/chrome 疑点场景）——同一次挂载内换几何，
    // chrome 成员零丢失 + 结构前提稳定。
    setViewport(1024, 768);
    fakePageGeometry(chrome.pageEl, 1024, 768);
    const after = queryChrome(container);
    expectStickyOriginInvariants(after);
    expect(after.zoombar).toBe(chrome.zoombar);
    expect(after.minimap).toBe(chrome.minimap);
    // 同一交互在新几何下 seek 到 B 态目标（几何换道跨 resize 存活）。
    seekMidTrack(after);
    expect(after.pageEl.scrollLeft).toBe(EXPECTED_B);
  });
});
