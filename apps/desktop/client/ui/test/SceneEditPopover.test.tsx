/**
 * 08-26 结构页重构 批 4（implement 4.1 / design §6.2 / prd R3）：SceneEditPopover
 * ——SceneDetailDrawer 的指针旁浮层改造（migrated coverage + 新增定位/拖动/关闭面）。
 *
 * 覆盖：
 *  - placePopover 纯函数四缘坐标矩阵（右缘翻转 / 下缘翻转·底对齐公式 / 左上钳位 /
 *    视口小于浮层的退化钳位）+ R2 分支③垂帘钉顶 / 分支④高于可视域顶钉最大化。
 *  - clampDragPosition 拖动钳位（页界内 / 垂直至少留住标题栏 / 宽于页时钳左缘 /
 *    chrome 地板继承）。
 *  - resolvePopoverBounds 界语义（批 B CR：零尺寸页 rect 也是真实界——仅缺页元素
 *    退视口界；R2 升级 #72：顶部恒驻 chrome 带地板——实测优先、102px 兜底、防倒挂）。
 *  - R2 锚链三层回退（resolveClickAnchor）：L1 事件坐标 / L2 打开方 rect /
 *    L3 defaultAnchor——(0,0) 落点全路径不可达；键盘激活 (0,0) 启发式退役。
 *  - formatPresentationOrder / escapeSelector 纯函数（哨兵章译「待编排」、形态缺失
 *    「-」兜底、attr 选择器转义防注入）。
 *  - R12 纯函数：formatEpisodeMembership（ep id → 「第 N 章 · title」人读格式，
 *    缺失防级回退原文）/ edgeTypeLabel + EDGE_TYPE_LABEL_KEY（CAUSAL 字面中文化，
 *    存储值不动）。
 *  - 指针旁展开：点击卡/chip（clientX/Y）→ left/top = 点击点 +14；右缘放不下翻到
 *    点击点左侧。集成定位测试 mock 页 rect（零尺寸按真实界处理后，确定性断言需要
 *    非退化界——与真实浏览器页 rect 同形）。
 *  - AC4 矩阵：四入口（跨章chip / 普通chip / 因果卡 / pending灰片）× 三屏态
 *    （顶部近邻 / 右下挤压 / 超高压缩）——落点公式确定值 + 合法性（不出可视域、
 *    不越 chrome 地板、点击邻域 ≤ 半视口）。
 *  - 键盘激活点击：L2 层锚到打开方元素 rect 中心；rect 不可测退 L3 默认位。
 *  - 编辑中 Esc 只取消输入不关浮层（title/summary/storyTime 三面）。
 *  - 非整数 storyTime 字面（'1e9'/'2.7'）拒绝还原不写；负整数仍走既有钳 0。
 *  - resize 重钳现位；窗口失焦终止拖动（mouseup 出窗悬空修复）；程序化打开不吃
 *    过路（stale）锚。
 *  - 定位钮按打开来源区作用域查询 + 区内 miss 兜底「打开方元素自身」（异区错锚根修
 *    ——不回全图文档序首个同名子）。
 *  - 单例移位重开 / 关闭面 / 拖动钳位 / 两区表单投影（含 R12 分区说明与徽标
 *    tooltip 断言）。
 *  - 08-27 第三轮 CR（P 域 patch 批）：分支②下界钳位（portal 扫过点击不伸进页底，
 *    edge P-1）+ 顶钉 maxHeight 高度联动（blind P-F5）+ sourceOpener 三联（关闭清
 *    空/身份校验/命中才写，blind P-F1 + edge P-3/P-4）+ topChromeFloor either-zero
 *    （blind P-F2）+ 实测 chrome 带组件级接线守卫（blind P-F3 + auditor P-F4）+
 *    横滚坐标系用例（auditor P-F1 · E1 移交义务二）+ 徽标 tabIndex（edge P-6）+
 *    AC4 紧阈值/底缘断言/stub 收窄（blind P-F8 + auditor P-F2）+ SectionHint 九区
 *    个体断言（auditor P-F8）。
 *  - 08-27 C1 真机遍历 T1（首开锚丢失——AC4 红四入口 x=页左+14）：挂起锚「配对
 *    存活」——卡片锚（带 nodeId）豁免关闭态清扫、消费侧身份校验；以**不冒泡原生
 *    click** 解耦「锚记录（document capture）」与「选中提交」两半（RTL act 合并
 *    提交会掩盖该交错——真机正是分属两次 commit 才落 L3 默认位），因果卡/工作台
 *    chip 两入口 + 他场配对失败守卫 + 分属提交的移位重载四面锁定。
 *
 * Store is driven via `useAppStore.setState` (same convention as
 * NarrativeTimelinePanel.test.tsx). `currentProject: null` keeps updateField's
 * syncField branch inert.
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run SceneEditPopover`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sceneGraphSchema, type SceneGraph } from '@orison/shared-contracts';
import {
  SceneEditPopover,
  resolveSceneActs,
  resolveSceneEpisode,
  resolveClickAnchor,
  formatEpisodeMembership,
  edgeTypeLabel,
  EDGE_TYPE_LABEL_KEY,
  placePopover,
  clampDragPosition,
  resolvePopoverBounds,
  formatPresentationOrder,
  escapeSelector,
  POPOVER_POINTER_OFFSET,
  POPOVER_EDGE_MARGIN,
  POPOVER_DRAG_MARGIN,
  POPOVER_DRAG_HEADER_KEEP,
  POPOVER_TOP_CHROME_BAND_FALLBACK,
} from '../src/features/structure/SceneEditPopover';
import { PENDING_CHAPTER_SENTINEL } from '../src/features/structure/workbenchLayout';
import { StructurePage } from '../src/features/structure/StructurePage';
import { useAppStore } from '../src/shared/store/appStore';

// ── fixtures ──
function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

/** DOMRect 手写 fixture（jsdom 无真布局；结构页 rect 的确定性假体）。 */
function makeRect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 给结构页盒打上确定性 rect（调用方须在触发打开手势**之前**安装）。 */
function mockPageRect(page: HTMLElement, l: number, t: number, r: number, b: number) {
  return vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(makeRect(l, t, r, b));
}

const ALL_OVERLAYS_ON = { validation: true, displacement: true, visibility: true };

/**
 * Base fixture: two-line graph (main + side) with a multi-line core-anchor scene
 * (s2), one incoming edge (s1→s2) and one outgoing edge (s2→s3). s2 is the
 * drill-down target throughout.
 *   s1 (l_main, storyTime 1) ──CAUSAL──▶ s2 (l_main+l_side, storyTime 2) ──SUSPENSE──▶ s3 (l_side, storyTime 3)
 */
function baseGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
      { id: 'l_side', name: '副线', topology_role: 'side' },
    ],
    nodes: [
      { id: 's1', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's2', lineTags: ['l_main', 'l_side'], storyTime: 2, storyTimeLabel: '第二天黄昏', role: 'core-anchor', presentationOrder: { chapter: 1, pos: 0 }, episodeId: 'ep1', actRef: 'act-2' },
      { id: 's3', lineTags: ['l_side'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 1, pos: 1 } },
    ],
    edges: [
      { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' },
      { id: 'e2', from: 's2', to: 's3', type: 'SUSPENSE' },
    ],
  });
}

/** Graph with a CAUSAL cycle s1→s2→s1 → both nodes flagged `causal-cycle` error. */
function cyclicGraph(): SceneGraph {
  return parseGraph({
    lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
    nodes: [
      { id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's2', lineTags: ['l1'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 1 } },
    ],
    edges: [
      { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' },
      { id: 'e2', from: 's2', to: 's1', type: 'CAUSAL' },
    ],
  });
}

/**
 * AC4 矩阵 fixture（R2 / #70 后置）：四类浮层入口各一枚——
 *   s_causal_only = 因果卡（仅因果骨架可点）；
 *   s_plain       = 普通 chip（工作台单章）；
 *   s_span        = 跨章宽 chip（presentationSpans 覆盖 eA..eC，colEnd>colStart →
 *                   `.workbench-chip--span`，resolveSceneChapterRange 第一级解析）；
 *   s_pend        = pending 灰片（episodeId 悬空 + presentationOrder.chapter 指向
 *                   不存在的章 index 9 → 三级解析全 miss → 待编排虚拟列）。
 */
function spanMatrixGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
      { id: 'l_side', name: '副线', topology_role: 'side' },
    ],
    nodes: [
      { id: 's_causal_only', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 }, title: '因果独占场' },
      { id: 's_plain', lineTags: ['l_side'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 0 }, title: '普通一章' },
      { id: 's_span', lineTags: ['l_main'], storyTime: 3, role: 'core-anchor', presentationOrder: { chapter: 0, pos: 1 }, presentationSpans: [{ episodeId: 'eA', pos: 0 }, { episodeId: 'eB', pos: 0 }, { episodeId: 'eC', pos: 1 }], title: '跨章长场' },
      { id: 's_pend', lineTags: ['l_side'], storyTime: 4, role: 'normal', presentationOrder: { chapter: 9, pos: 1 }, episodeId: 'ep-ghost', title: '悬空归属场' },
    ],
    edges: [],
  });
}

/** AC4 矩阵配套章表（eA/eB/eC 连续三章——供跨章宽卡解析与普通格落位）。 */
function matrixEpisodes(): Array<Record<string, unknown>> {
  return [
    { id: 'eA', index: 0, title: '启航' },
    { id: 'eB', index: 1, title: '暗流' },
    { id: 'eC', index: 2, title: '决堤' },
  ];
}

/** jsdom offsetWidth/Height 恒 0——AC4 矩阵需要非退化浮层尺寸才能驱动翻转/溢出
 *  分支。CR3（blind P-F8）收窄作用域：stub 只对浮层盒（[data-popover="scene-edit"]）
 *  生效，其余元素回原 getter（jsdom 恒 0）——原原型级全局替换波及整棵
 *  StructurePage 树（lane/pending 折叠阈值、workbench 尺寸读取等全读到假尺寸）。 */
function stubPopoverSize(width: number, height: number) {
  const isPopoverEl = (el: HTMLElement) =>
    typeof el.getAttribute === 'function' && el.getAttribute('data-popover') === 'scene-edit';
  const origWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')?.get;
  const origHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')?.get;
  const wSpy = vi
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function mockW(this: HTMLElement) {
      return isPopoverEl(this) ? width : (origWidth?.call(this) ?? 0);
    });
  const hSpy = vi
    .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockImplementation(function mockH(this: HTMLElement) {
      return isPopoverEl(this) ? height : (origHeight?.call(this) ?? 0);
    });
  return [wSpy, hSpy];
}

/** 点到矩形的最近距离（AC4「点击邻域 ≤ 半视口」的度量基元；点击在矩形内 = 0）。 */
function distanceToRect(
  px: number,
  py: number,
  rect: { left: number; top: number; width: number; height: number }
): number {
  const dx = Math.max(rect.left - px, 0, px - (rect.left + rect.width));
  const dy = Math.max(rect.top - py, 0, py - (rect.top + rect.height));
  return Math.hypot(dx, dy);
}

/**
 * 捕获 scrollIntoView 调用者身份（jsdom 无布局——以真实 DOM 元素引用回传，
 * setup.ts 已把真实现 stub 为 no-op，本 spy 只补「谁被调用」）。捕获走对象属性
 * （`captured.current = this`）——不落 this-alias 规则红线。
 */
function stubScrollIntoViewCapture() {
  const captured: { current: HTMLElement | null } = { current: null };
  const spy = vi
    .spyOn(HTMLElement.prototype, 'scrollIntoView')
    .mockImplementation(function mock(this: HTMLElement) {
      captured.current = this;
    });
  return {
    get(): HTMLElement | null {
      return captured.current;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

// ── placePopover：四缘坐标矩阵（纯函数全覆盖；08-26 批 5 #48 起 bounds = 页 rect
//    而非整窗视口——浮层顶部不钻应用顶栏/状态栏）──

describe('placePopover (pure, four-edge matrix over page bounds)', () => {
  const SIZE = { width: 320, height: 400 };
  /** 页界（fixed 坐标系）：满窗页（left/top 0——旧视口语义的等价形）。 */
  const BOUNDS = { left: 0, top: 0, right: 1280, bottom: 800 };

  it('interior click: opens at click point +14 (base case)', () => {
    const r = placePopover(200, 200, SIZE, BOUNDS);
    expect(r.left).toBe(200 + POPOVER_POINTER_OFFSET);
    expect(r.top).toBe(200 + POPOVER_POINTER_OFFSET);
    // CR3 blind P-F5 高度联动：正常分支 maxHeight ≥ size.height——高度钳制零影响
    // （不收缩、不松 CSS 帽以外的约束）。
    expect(r.maxHeight).toBeGreaterThanOrEqual(SIZE.height);
    expect(r.maxHeight).toBe(BOUNDS.bottom - POPOVER_EDGE_MARGIN - r.top);
  });

  it('RIGHT edge: flips to the LEFT of the click point when it would overflow', () => {
    // 1260 + 14 + 320 > 1280 - 12 → flip: left = 1260 - 320 - 14 = 926。
    const { left } = placePopover(1260, 200, SIZE, BOUNDS);
    expect(left).toBe(1260 - SIZE.width - POPOVER_POINTER_OFFSET);
    expect(left + SIZE.width).toBeLessThanOrEqual(1260); // 浮层整体在点击点左侧
  });

  it('BOTTOM edge: flips ABOVE the click point when it would overflow', () => {
    // 760 + 14 + 400 > 800 - 12 → flip: top = 760 - 400 - 14 = 346。
    const { top } = placePopover(200, 760, SIZE, BOUNDS);
    expect(top).toBe(760 - SIZE.height - POPOVER_POINTER_OFFSET);
    expect(top + SIZE.height).toBeLessThanOrEqual(760);
  });

  it('LEFT clamp: an off-bounds-left coordinate never places the popover off-bounds left', () => {
    // 点击点本身不可能越界（真实指针在页内），钳位是防御——坐标 -30 → 基位 -16 → 钳 12。
    const { left } = placePopover(-30, 200, SIZE, BOUNDS);
    expect(left).toBe(POPOVER_EDGE_MARGIN);
    // 近缘点击（2+14=16 ≥ 12）原样通过——钳位只在越界时介入。
    expect(placePopover(2, 200, SIZE, BOUNDS).left).toBe(2 + POPOVER_POINTER_OFFSET);
  });

  it('TOP clamp: an off-bounds-top coordinate never places the popover off-bounds top', () => {
    const { top } = placePopover(200, -30, SIZE, BOUNDS);
    expect(top).toBe(POPOVER_EDGE_MARGIN);
    expect(placePopover(200, 2, SIZE, BOUNDS).top).toBe(2 + POPOVER_POINTER_OFFSET);
  });

  it('degenerate: bounds smaller than the popover clamps inside (no negative maxima)', () => {
    const tiny = { left: 0, top: 0, right: 200, bottom: 150 };
    const { left, top } = placePopover(100, 100, SIZE, tiny);
    expect(left).toBe(POPOVER_EDGE_MARGIN);
    expect(top).toBe(POPOVER_EDGE_MARGIN);
  });

  it('corner case: right-bottom click flips on BOTH axes', () => {
    const { left, top } = placePopover(1270, 790, SIZE, BOUNDS);
    expect(left).toBe(1270 - SIZE.width - POPOVER_POINTER_OFFSET);
    expect(top).toBe(790 - SIZE.height - POPOVER_POINTER_OFFSET);
  });

  it('#48 top-bar occlusion: bounds.top > 0 (page sits below app chrome) clamps/keeps the popover below it', () => {
    // 页 rect 从 y=40 起（应用顶栏占上方 40px）。中低位点击 + 高 400 浮层：
    // py=400 → 400+14+400 > 800-12 翻转到上方 → 400-400-14=-14 < 40 → 钳 52。
    const chromeBounds = { left: 0, top: 40, right: 1280, bottom: 800 };
    const flipped = placePopover(200, 400, SIZE, chromeBounds);
    expect(flipped.top).toBe(chromeBounds.top + POPOVER_EDGE_MARGIN);
    // 防御路径：越界坐标同样钳在 bounds.top 之上。
    const defensive = placePopover(200, -30, SIZE, chromeBounds);
    expect(defensive.top).toBe(chromeBounds.top + POPOVER_EDGE_MARGIN);
    // 正常中位点击（放得下）不受 top 偏移影响。
    expect(placePopover(200, 200, SIZE, chromeBounds).top).toBe(200 + POPOVER_POINTER_OFFSET);
  });

  it('R2 branch② bottom-align formula: the bottom edge sits exactly OFFSET above the click point (E1 口径固化)', () => {
    const { top } = placePopover(200, 700, SIZE, BOUNDS);
    expect(top).toBe(700 - POPOVER_POINTER_OFFSET - SIZE.height);
    expect(top + SIZE.height).toBe(700 - POPOVER_POINTER_OFFSET);
  });

  it('R2/CR3 edge P-1: an anchor BELOW bounds.bottom (portal sweep click) clamps the flip-up bottom edge inside the box', () => {
    // py=900 > bottom=800：旧实现②支 top=486 无下界 → 底缘 886 伸进页底（状态栏
    // 遮挡回归形态）；修复后钳到 maxTop = bottom − h − MARGIN = 388，底缘齐下界内侧。
    const r = placePopover(200, 900, SIZE, BOUNDS);
    expect(r.top).toBe(BOUNDS.bottom - SIZE.height - POPOVER_EDGE_MARGIN);
    expect(r.top + SIZE.height).toBeLessThanOrEqual(BOUNDS.bottom - POPOVER_EDGE_MARGIN);
  });

  it('R2 branch③ near-top click: nothing fits either way vertically but the box can contain the popover → curtain pinned at the floor', () => {
    // 箱高 448 ≥ h+2M=424（装得下）；py=200 让下展溢出（614>548）、上翻穿地板
    // （-214<124）→ 钉顶界垂帘展开。地板值来自 resolvePopoverBounds 的 chrome 抬升
    // （此处直接以「已抬升」的 bounds 表达——集成面负责喂这种界）。
    const floored = { left: 0, top: 112, right: 1200, bottom: 560 };
    const { left, top } = placePopover(100, 200, SIZE, floored);
    expect(left).toBe(114);
    expect(top).toBe(floored.top + POPOVER_EDGE_MARGIN);
  });

  it('R2 branch④ taller than the visible box pins its TOP edge at the floor (max-visible-height policy; handle stays reachable)', () => {
    // 箱高 220 < h+2M=444 → 真溢出：顶钉最大化。底钉候选经钳位数学坍缩同解
    // （bottom-M-h < minTop ⇒ max(minTop,·)=minTop），头注证明的行为锁定。
    const tinyTall = { left: 0, top: 110, right: 900, bottom: 330 };
    const { left, top, maxHeight } = placePopover(300, 250, { width: 320, height: 420 }, tinyTall);
    expect(left).toBe(314);
    expect(top).toBe(tinyTall.top + POPOVER_EDGE_MARGIN);
    // CR3 blind P-F5 高度联动：顶钉形态产可用高钳制（minTop → bounds.bottom−M），
    // 「顶钉=最大化高度」承谛成立——内联值覆盖 CSS max-height 的视口语义，尾部经
    // .scene-edit-popover-body overflow-y:auto 可达（不再悬挂页底）。
    expect(maxHeight).toBe(tinyTall.bottom - POPOVER_EDGE_MARGIN - top);
    expect(maxHeight).toBeLessThan(420); // 真实收缩
  });

  it('R2 universal guard: every branch stays on/below the chrome floor AND inside the bottom edge (incl. defensive off-bounds coords)', () => {
    const floored = { left: 40, top: 150, right: 1200, bottom: 900 };
    // py=1000：锚低于可视域（portal 扫过点击形态）——edge P-1 下界钳位的守卫面。
    for (const py of [-30, 60, 160, 300, 500, 880, 1000]) {
      const r = placePopover(200, py, SIZE, floored);
      expect(r.top, `py=${py}`).toBeGreaterThanOrEqual(floored.top);
      // CR3（edge P-1）：底缘断言——原实现只守上界，②支底对齐在深锚下伸进页底。
      expect(r.top + SIZE.height, `py=${py} bottom edge`).toBeLessThanOrEqual(
        floored.bottom - POPOVER_EDGE_MARGIN
      );
      expect(r.left).toBeGreaterThanOrEqual(floored.left);
    }
  });
});

// ── clampDragPosition：拖动钳位（纯函数）──

describe('clampDragPosition (pure)', () => {
  const SIZE = { width: 320, height: 400 };
  const BOUNDS = { left: 0, top: 0, right: 1000, bottom: 700 };

  it('an interior position passes through unchanged', () => {
    expect(clampDragPosition(300, 200, SIZE, BOUNDS)).toEqual({ left: 300, top: 200 });
  });

  it('clamps inside the page bounds (cannot be dragged outside the page)', () => {
    expect(clampDragPosition(-50, -50, SIZE, BOUNDS)).toEqual({
      left: BOUNDS.left + POPOVER_DRAG_MARGIN,
      top: BOUNDS.top + POPOVER_DRAG_MARGIN,
    });
    expect(clampDragPosition(2000, 2000, SIZE, BOUNDS)).toEqual({
      left: BOUNDS.right - SIZE.width - POPOVER_DRAG_MARGIN,
      top: BOUNDS.bottom - POPOVER_DRAG_HEADER_KEEP,
    });
  });

  it('vertical floor keeps at least the header height reachable (drag handle not lost)', () => {
    const { top } = clampDragPosition(300, 5000, SIZE, BOUNDS);
    expect(top).toBe(BOUNDS.bottom - POPOVER_DRAG_HEADER_KEEP);
  });

  it('popover wider than the page clamps to the left edge (max guard, no inversion)', () => {
    const narrow = { left: 0, top: 0, right: 200, bottom: 700 };
    const { left } = clampDragPosition(150, 100, SIZE, narrow);
    expect(left).toBe(narrow.left + POPOVER_DRAG_MARGIN);
  });

  it('R2 drag floor inherits the chrome band via resolvePopoverBounds-fed bounds (title never slides under zoombar/minimap)', () => {
    const floored = { left: 0, top: 102, right: 1000, bottom: 700 };
    const clamped = clampDragPosition(-50, -50, SIZE, floored);
    expect(clamped).toEqual({
      left: floored.left + POPOVER_DRAG_MARGIN,
      top: floored.top + POPOVER_DRAG_MARGIN,
    });
  });
});

// ── R2 锚链三层回退（resolveClickAnchor）──

describe('resolveClickAnchor (R2 three-layer closed chain)', () => {
  it('L1 pointer coordinates pass through verbatim (synthetic == isTrusted path — single code path)', () => {
    expect(resolveClickAnchor(320, 240, null)).toEqual({ x: 320, y: 240 });
  });

  it('L2 keyboard/no-coordinate activation anchors to the OPENED ELEMENT rect centre', () => {
    const opener = {
      getBoundingClientRect: () => makeRect(500, 300, 620, 360),
    } as unknown as Element;
    // 与 L1 的等价性对照：合成 (0,0) 字面 + 可测 rect → 元素中心，而非原点。
    expect(resolveClickAnchor(0, 0, opener)).toEqual({ x: 560, y: 330 });
  });

  it('L3 a zero (unlaid-out) opener rect and no pointer coords yield null → defaultAnchor takes over', () => {
    const zeroRectOpener = {
      getBoundingClientRect: () => makeRect(0, 0, 0, 0),
    } as unknown as Element;
    expect(resolveClickAnchor(0, 0, zeroRectOpener)).toBeNull();
    expect(resolveClickAnchor(0, 0, null)).toBeNull();
  });

  it('an invalid anchor shape can never reach placement — no (0,0) landing exists in any branch', () => {
    // 全 miss 形态（L3 恒 null）时组件落 defaultAnchor = chrome 地板下角落；
    // placePopover 的 minTop 守卫保证落点 ≥ 地板 + margin，原点永不可达。
    const bounds = { left: 0, top: POPOVER_TOP_CHROME_BAND_FALLBACK, right: 1280, bottom: 900 };
    const placed = placePopover(bounds.left, bounds.top, { width: 0, height: 0 }, bounds);
    expect(placed.top).toBeGreaterThanOrEqual(
      POPOVER_TOP_CHROME_BAND_FALLBACK + POPOVER_EDGE_MARGIN
    );
    expect(placed.top).not.toBe(0);
  });
});

// ── R12 纯函数：所属集人读格式 / 边类型显示层中文化 ──

describe('formatEpisodeMembership (R12 / #73)', () => {
  const zhT = vi.fn((key: string, vars?: Record<string, string | number>) =>
    key === 'structure.drawer.episodeValue'
      ? `第 ${vars?.n} 章 · ${vars?.title}`
      : `第 ${vars?.n} 章（标题未填）`
  );

  it('composes 「第 N 章 · title」 with N = index+1 (workbench column-header convention)', () => {
    const ep = { id: 'ep5', index: 4, title: '雪夜行动' };
    expect(formatEpisodeMembership(ep as any, 'ep5', zhT)).toBe('第 5 章 · 雪夜行动');
  });

  it('falls back to the raw id when the lookup misses (anti-degradation: raw data never disappears)', () => {
    expect(formatEpisodeMembership(null, 'ep-missing', zhT)).toBe('ep-missing');
    expect(formatEpisodeMembership(undefined, 's22-ghost', zhT)).toBe('s22-ghost');
  });

  it('a malformed index degrades to the raw id instead of producing garbage labels', () => {
    const ep = { id: 'eX', index: Number.NaN, title: '坏索引' };
    expect(formatEpisodeMembership(ep as any, 'eX', zhT)).toBe('eX');
  });

  it('negative and non-integer indexes also degrade to the raw id (CR3 edge P-5 + auditor P-F7 guard extension)', () => {
    // schema int().nonnegative() 之外的 loose-cast / 手改 yaml 形态：旧实现只拒非
    // 有限值——index=-1 产「第 0 章」、index=1.5 产「第 2 章」伪标签。
    expect(formatEpisodeMembership({ id: 'eNeg', index: -1, title: '负' } as any, 'eNeg', zhT)).toBe('eNeg');
    expect(formatEpisodeMembership({ id: 'eFrac', index: 1.5, title: '小数' } as any, 'eFrac', zhT)).toBe('eFrac');
  });

  it('a numbered-but-untitled episode uses the dedicated no-title key', () => {
    const ep = { id: 'ep7', index: 6, title: '' };
    expect(formatEpisodeMembership(ep as any, 'ep7', zhT)).toBe('第 7 章（标题未填）');
  });

  it('whitespace-only titles are treated as untitled', () => {
    const ep = { id: 'ep8', index: 7, title: '   ' };
    expect(formatEpisodeMembership(ep as any, 'ep8', zhT)).toBe('第 8 章（标题未填）');
  });
});

describe('edgeTypeLabel / EDGE_TYPE_LABEL_KEY (R12 / #73 display-layer localization)', () => {
  it('maps every schema edge type to its localized key', () => {
    expect(EDGE_TYPE_LABEL_KEY.CAUSAL).toBe('structure.drawer.edgeTypeCausal');
    expect(EDGE_TYPE_LABEL_KEY.SUSPENSE).toBe('structure.drawer.edgeTypeSuspense');
  });

  it('translates through the injected translator (storage values stay raw)', () => {
    expect(edgeTypeLabel('CAUSAL', () => '因果')).toBe('因果');
    expect(edgeTypeLabel('SUSPENSE', () => '悬念')).toBe('悬念');
  });

  it('an unknown value falls back to the original literal (free data never vanishes)', () => {
    expect(edgeTypeLabel('MYSTERY' as any, () => 'x')).toBe('MYSTERY');
  });
});

// ── resolvePopoverBounds：界语义（批 B CR——零尺寸 rect 也是真实界）──

describe('resolvePopoverBounds (pure)', () => {
  it('missing page element falls back to the viewport bounds (isolated render)', () => {
    const b = resolvePopoverBounds(null);
    expect(b.left).toBe(0);
    expect(b.top).toBe(0);
    expect(b.right).toBe(window.innerWidth);
    expect(b.bottom).toStrictEqual(window.innerHeight);
  });

  it('a ZERO-size page rect is honored as real bounds (collapse/transition must NOT bypass #48)', () => {
    const el = {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
    } as unknown as HTMLElement;
    // 旧实现把全 0 当 jsdom 退化退回视口界——真折叠态因此绕过页钳。新语义：页在
    // 场即以页为界（哪怕 0×0，浮层贴角可辨而非钻 chrome 下）。
    expect(resolvePopoverBounds(el)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('normal rects pass through verbatim (#48 page-below-chrome semantics)', () => {
    const el = {
      getBoundingClientRect: () => ({ left: 0, top: 40, right: 1280, bottom: 800 }),
    } as unknown as HTMLElement;
    expect(resolvePopoverBounds(el)).toEqual({ left: 0, top: 40, right: 1280, bottom: 800 });
  });

  it('R2 chrome floor fallback lifts top by the single-source band constant when no chrome rect is measurable (jsdom zero rects skipped)', () => {
    // 页元素在场（含恒驻 chrome 子节点，但矩形全零——jsdom 未布局形态）：
    // 全零不采信（collectStackBands 同款口径）→ 102px 页相对兜底接管。
    const zoombarLike = { getBoundingClientRect: () => makeRect(0, 0, 0, 0) };
    const minimapLike = { getBoundingClientRect: () => makeRect(0, 0, 0, 0) };
    const page = {
      getBoundingClientRect: () => makeRect(0, 0, 1280, 800),
      querySelectorAll: (sel: string) =>
        sel === '.structure-zoombar' ? [zoombarLike] : sel === '.timeline-minimap' ? [minimapLike] : [],
    } as unknown as HTMLElement;
    const b = resolvePopoverBounds(page);
    expect(b.top).toBe(POPOVER_TOP_CHROME_BAND_FALLBACK);
    expect(b.left).toBe(0);
    expect(b.right).toBe(1280);
    expect(b.bottom).toBe(800);
  });

  it('R2/CR3 either-zero: a HALF-collapsed member rect (width>0, height=0) is NOT trusted → fallback constant', () => {
    // blind P-F2 + auditor P-F3：旧实现 both-zero 才拒——半塌缩成员（height 塌 0、
    // 宽仍在的过渡帧）被采信且地板落其 top 边；对齐 collectStackBands / L2 的
    // 「任一维零即拒」真同款口径。
    const page = {
      getBoundingClientRect: () => makeRect(0, 0, 1400, 900),
      querySelectorAll: () => [{ getBoundingClientRect: () => makeRect(0, 0, 1400, 0) }],
    } as unknown as HTMLElement;
    expect(resolvePopoverBounds(page).top).toBe(POPOVER_TOP_CHROME_BAND_FALLBACK);
  });

  it('R2 live chrome measurement wins over the fallback (E1 真机路径：zoombar/minimap 底边实测)', () => {
    const page = {
      getBoundingClientRect: () => makeRect(0, 0, 1400, 900),
      querySelectorAll: (sel: string) => {
        if (sel === '.structure-zoombar') return [{ getBoundingClientRect: () => makeRect(0, 0, 1400, 32) }];
        if (sel === '.timeline-minimap') return [{ getBoundingClientRect: () => makeRect(0, 32, 1400, 88) }];
        return [];
      },
    } as unknown as HTMLElement;
    expect(resolvePopoverBounds(page)).toMatchObject({ left: 0, top: 88, right: 1400, bottom: 900 });
  });

  it('R2 a stale member rect above the page top cannot LOWER the floor', () => {
    // 陈旧/异常成员矩形（底边高于页顶）不得把地板拉低到页顶之上。
    const page = {
      getBoundingClientRect: () => makeRect(0, 40, 1280, 800),
      querySelectorAll: () => [{ getBoundingClientRect: () => makeRect(0, 0, 100, 20) }],
    } as unknown as HTMLElement;
    expect(resolvePopoverBounds(page).top).toBe(40);
  });

  it('R2 collapse guard: the chrome floor never exceeds the page bottom (zero-size semantics preserved)', () => {
    const page = {
      getBoundingClientRect: () => makeRect(0, 0, 0, 0),
      querySelectorAll: () => [],
    } as unknown as HTMLElement;
    expect(resolvePopoverBounds(page)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});

// ── formatPresentationOrder / escapeSelector 纯函数 ──

describe('formatPresentationOrder (pure)', () => {
  it('normal form renders "chapter / pos"', () => {
    expect(formatPresentationOrder({ chapter: 1, pos: 0 }, '待编排')).toBe('1 / 0');
  });

  it('sentinel chapter translates to the pending label (internal sentinel never leaks to UI)', () => {
    expect(formatPresentationOrder({ chapter: PENDING_CHAPTER_SENTINEL, pos: 3 }, '待编排')).toBe('待编排');
  });

  it('missing shape falls back to "-" (render path no longer dereferences an optional form)', () => {
    expect(formatPresentationOrder(undefined, '待编排')).toBe('-');
    expect(formatPresentationOrder(null, '待编排')).toBe('-');
  });

  it('non-numeric fields fall back to "-" (as-cast partial graphs)', () => {
    expect(formatPresentationOrder({ chapter: Number.NaN, pos: 2 }, '-')).toBe('-');
  });
});

describe('escapeSelector (pure)', () => {
  it('escapes quotes and backslashes so attr selectors stay parseable', () => {
    const hostile = 's"1\\x';
    const escaped = escapeSelector(hostile);
    // 转义值喂进选择器不再抛 SyntaxError（未转义会整层 querySelector 崩掉）。
    expect(() => document.querySelector(`[data-node-id="${escaped}"]`)).not.toThrow();
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      expect(escaped).toBe(CSS.escape(hostile));
    }
  });

  it('plain ids pass through unchanged', () => {
    expect(escapeSelector('s2')).toBe('s2');
  });
});

// ── 既有 pure helpers（自 SceneDetailDrawer.test 原样迁移）──

describe('SceneEditPopover pure helpers', () => {
  it('resolveSceneActs returns [] when outline is absent (hide act section)', () => {
    const g = baseGraph();
    expect(resolveSceneActs(g, undefined, 's2')).toEqual([]);
  });

  it('resolveSceneActs returns [] when the scene\'s lines have no phase_ref', () => {
    const g = baseGraph(); // lines have no phase_ref
    const outline = { phases: [{ id: 'p1', title: '起' }] };
    expect(resolveSceneActs(g, outline as any, 's2')).toEqual([]);
  });

  it('resolveSceneActs resolves phase titles from line.phase_ref → outline.phases', () => {
    const g = parseGraph({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' },
        { id: 'l_side', name: '副线', topology_role: 'side', phase_ref: 'p2' },
      ],
      nodes: [
        // s2 belongs to both lines → two resolvable phases.
        { id: 's2', lineTags: ['l_main', 'l_side'], storyTime: 2, role: 'core-anchor', presentationOrder: { chapter: 0, pos: 0 } },
      ],
      edges: [],
    });
    const outline = { phases: [
      { id: 'p1', title: '起' },
      { id: 'p2', title: '承' },
    ] };
    const acts = resolveSceneActs(g, outline as any, 's2');
    expect(acts).toEqual([
      { phaseId: 'p1', title: '起' },
      { phaseId: 'p2', title: '承' },
    ]);
  });

  it('resolveSceneActs dedupes when two lines ref the same phase', () => {
    const g = parseGraph({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' },
        { id: 'l_side', name: '副线', topology_role: 'side', phase_ref: 'p1' },
      ],
      nodes: [
        { id: 's2', lineTags: ['l_main', 'l_side'], storyTime: 2, role: 'core-anchor', presentationOrder: { chapter: 0, pos: 0 } },
      ],
      edges: [],
    });
    const outline = { phases: [{ id: 'p1', title: '起' }] };
    expect(resolveSceneActs(g, outline as any, 's2')).toEqual([{ phaseId: 'p1', title: '起' }]);
  });

  it('resolveSceneActs skips a dangling phase_ref (ref misses outline.phases)', () => {
    const g = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true, phase_ref: 'p-ghost' }],
      nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } }],
      edges: [],
    });
    const outline = { phases: [{ id: 'p1', title: '起' }] };
    expect(resolveSceneActs(g, outline as any, 's1')).toEqual([]);
  });

  it('resolveSceneEpisode returns null when episodeId is absent', () => {
    const g = baseGraph();
    // s1 has no episodeId.
    expect(resolveSceneEpisode([{ id: 'ep1', index: 0, title: 'EP1' }], 's1', g)).toBeNull();
  });

  it('resolveSceneEpisode returns null when episodeId does not resolve', () => {
    const g = baseGraph(); // s2.episodeId = 'ep1'
    expect(resolveSceneEpisode([{ id: 'other', index: 0, title: 'Other' }], 's2', g)).toBeNull();
  });

  it('resolveSceneEpisode resolves the matching episode', () => {
    const g = baseGraph(); // s2.episodeId = 'ep1'
    const eps = [{ id: 'ep1', index: 0, title: 'EP1', emotional_beats: ['紧张'], pacing_beats: ['快'] }];
    expect(resolveSceneEpisode(eps as any, 's2', g)).toMatchObject({ id: 'ep1', title: 'EP1' });
  });
});

// ── 组件渲染（内容断言自 SceneDetailDrawer.test 迁移 + 浮层行为新增）──

describe('SceneEditPopover render', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: baseGraph(),
        outline: { phases: [{ id: 'p1', title: '起' }] },
        episode_outlines: [
          { id: 'ep1', index: 0, title: 'EP1', emotional_beats: ['期待', '震惊'], pacing_beats: ['缓'] },
        ],
      },
      overlayToggles: { ...ALL_OVERLAYS_ON },
      selectedNodeId: 's2',
      focusedLineId: null,
      drillLevel: 'overview',
      resolvedLocale: 'en-US',
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when selectedNodeId is null', () => {
    useAppStore.setState({ selectedNodeId: null } as any);
    const { container } = render(<SceneEditPopover />);
    expect(container.querySelector('[data-popover="scene-edit"]')).toBeNull();
  });

  it('renders the popover with the selected scene id when selectedNodeId is set', () => {
    const { container } = render(<SceneEditPopover />);
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.dataset.sceneId).toBe('s2');
    // 程序化打开（无点击锚）→ 默认锚位（#48：bounds 左上角 + placePopover +14 偏移
    // ——隔离渲染无 .structure-page 祖先 → 视口界；落点 ≥ margin）。
    expect(Number(popover.style.left.replace('px', ''))).toBeGreaterThanOrEqual(POPOVER_EDGE_MARGIN);
    expect(Number(popover.style.top.replace('px', ''))).toBeGreaterThanOrEqual(POPOVER_EDGE_MARGIN);
  });

  it('shows the two-zone form state (role select value / storyTime input / lineTags chips / retention meta)', () => {
    const { container } = render(<SceneEditPopover />);
    // role select reflects the node's role (dogfood R2 SP-2: select replaces the cycle button).
    const roleSelect = container.querySelector('[data-field="role"]') as HTMLSelectElement;
    expect(roleSelect).not.toBeNull();
    expect(roleSelect.value).toBe('core-anchor');
    // storyTime number input carries the current value.
    const storyInput = container.querySelector('[data-field="storyTime"]') as HTMLInputElement;
    expect(storyInput.value).toBe('2');
    // lineTags render as chips (one per membership; s2 = l_main + l_side).
    const chips = container.querySelectorAll('[data-line-tag]');
    expect(chips).toHaveLength(2);
    // retention zone keeps the read-only coordinate display.
    expect(container.querySelector('[data-meta="presentationOrder"]')?.textContent).toContain('1 / 0');
    expect(container.querySelector('[data-meta="storyTimeLabel"]')?.textContent).toBe('第二天黄昏');
    // R12 / #73：所属集人读格式（en-US locale 模板；N = index+1）。
    expect(container.querySelector('[data-meta="episodeId"]')?.textContent).toBe('Ch. 1 · EP1');
    expect(container.querySelector('[data-meta="actRef"]')?.textContent).toBe('act-2');
  });

  it('falls back to the RAW episode id when the membership lookup misses (R12 anti-degradation)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: baseGraph(),
        outline: undefined,
        episode_outlines: [], // s2.episodeId='ep1' 无法解析 → 原文回退
      },
      selectedNodeId: 's2',
    } as any);
    const { container } = render(<SceneEditPopover />);
    expect(container.querySelector('[data-meta="episodeId"]')?.textContent).toBe('ep1');
  });

  it('renders one-line section preambles beneath every standing section header (R12 education copy)', () => {
    const { container } = render(<SceneEditPopover />);
    // 常驻区七处 + 条件区 beat（本 fixture ep1 可解析）= 8；act 无 phase_ref 隐藏。
    // CR3 auditor P-F8：条件区 hint 改个体断言（beat 在此、act 在专属用例）——
    // 九区全量闭合，删任一区的 SectionHint 测试即红（原「≥7」对条件区零分辨力）。
    expect(container.querySelectorAll('.scene-detail-section-hint')).toHaveLength(8);
    for (const section of ['state', 'lines', 'enums', 'edges', 'semantic', 'issues', 'beat', 'retention']) {
      const hint = container.querySelector(`[data-section="${section}"] .scene-detail-section-hint`);
      expect(hint, `hint in ${section}`).not.toBeNull();
      expect(hint!.textContent!.length).toBeGreaterThan(0);
    }
  });

  it('attaches beginner tooltips to the three zone badges — keyboard/touch reachable via tabIndex (CR3 edge P-6)', () => {
    const { container } = render(<SceneEditPopover />);
    for (const section of ['state', 'lines', 'enums', 'edges']) {
      const badge = container.querySelector(
        `[data-section="${section}"] .scene-detail-zone-badge`
      ) as HTMLElement;
      expect(badge?.getAttribute('title'), `mech tooltip in ${section}`).toContain('Mechanical');
      // title-only 对键盘/触屏不可达——tabIndex=0 使焦点悬停/长按可揭示同一文案。
      expect(badge?.tabIndex, `mech badge focusable in ${section}`).toBe(0);
    }
    const semanticSection = container.querySelector('[data-section="semantic"]');
    const authorTip = semanticSection?.querySelector('.scene-detail-zone-badge--author') as HTMLElement;
    const aiTip = semanticSection?.querySelector('.scene-detail-zone-badge--ai') as HTMLElement;
    expect(authorTip?.getAttribute('title')).toContain('Author-sovereignty');
    expect(aiTip?.getAttribute('title')).toContain('ONE summary request');
    expect(authorTip?.tabIndex).toBe(0);
    expect(aiTip?.tabIndex).toBe(0);
  });

  it('lists incoming + outgoing edges with the other endpoint + type', () => {
    const { container } = render(<SceneEditPopover />);
    const incoming = container.querySelectorAll('[data-edge-dir="in"]');
    const outgoing = container.querySelectorAll('[data-edge-dir="out"]');
    // s2 has one incoming (s1→s2 CAUSAL) + one outgoing (s2→s3 SUSPENSE).
    expect(incoming).toHaveLength(1);
    expect(outgoing).toHaveLength(1);
    expect(incoming[0].querySelector('[data-edge-endpoint]')?.textContent).toBe('s1');
    expect(incoming[0].getAttribute('data-edge-type')).toBe('CAUSAL');
    expect(outgoing[0].querySelector('[data-edge-endpoint]')?.textContent).toBe('s3');
    expect(outgoing[0].getAttribute('data-edge-type')).toBe('SUSPENSE');
  });

  it('localizes the edge-type literals while storage values stay raw (#73, zh-CN)', () => {
    useAppStore.setState({ resolvedLocale: 'zh-CN' } as any);
    const { container } = render(<SceneEditPopover />);
    const inLabel = container.querySelector('[data-edge-dir="in"] [data-edge-type-label]');
    const outLabel = container.querySelector('[data-edge-dir="out"] [data-edge-type-label]');
    expect(inLabel?.textContent).toBe('因果');
    expect(outLabel?.textContent).toBe('悬念');
    // data-edge-type 属性仍为存储字面（显示层映射不动数据）。
    expect(container.querySelector('[data-edge-dir="in"]')?.getAttribute('data-edge-type')).toBe('CAUSAL');
    // 连边下拉同样中文化。
    const typeOptions = [...container.querySelectorAll<HTMLSelectElement>('[data-field="edge-type"] option')];
    expect(typeOptions.map((o) => o.textContent)).toEqual(['因果', '悬念']);
    expect(typeOptions.map((o) => o.value)).toEqual(['CAUSAL', 'SUSPENSE']);
  });

  it('shows "no issues" when the selected node has no validation flags', () => {
    const { container } = render(<SceneEditPopover />);
    // base graph is acyclic + reachable → no issues on s2.
    expect(container.querySelector('[data-section="issues"] [data-issue-code]')).toBeNull();
    expect(container.querySelector('[data-section="issues"] .scene-detail-empty')?.textContent).toBeTruthy();
  });

  it('shows validation issues targeting the selected node (causal cycle, verbatim message)', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: cyclicGraph() },
    } as any);
    const { container } = render(<SceneEditPopover />);
    // selectedNodeId still 's2' → on the cycle → causal-cycle error targets both nodes.
    const issue = container.querySelector('[data-section="issues"] [data-issue-code]') as HTMLElement;
    expect(issue).not.toBeNull();
    expect(issue.getAttribute('data-issue-severity')).toBe('error');
    expect(issue.getAttribute('data-issue-code')).toBe('causal-cycle');
    // message rendered verbatim (叙事语言 — don't rephrase).
    expect(issue.querySelector('.scene-detail-issue-message')?.textContent).toContain('因果链');
  });

  it('hides the act section when no line.phase_ref resolves', () => {
    // base graph lines have no phase_ref → act section hidden even though outline has phases.
    const { container } = render(<SceneEditPopover />);
    expect(container.querySelector('[data-section="act"]')).toBeNull();
  });

  it('shows the act section with the phase title when line.phase_ref resolves', () => {
    const g = parseGraph({
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' }],
      nodes: [
        { id: 's2', lineTags: ['l_main'], storyTime: 2, role: 'core-anchor', presentationOrder: { chapter: 0, pos: 0 } },
      ],
      edges: [],
    });
    useAppStore.setState({
      creativeFields: {
        scene_graph: g,
        outline: { phases: [{ id: 'p1', title: '起' }] },
        episode_outlines: [],
      },
      selectedNodeId: 's2',
    } as any);
    const { container } = render(<SceneEditPopover />);
    const actItem = container.querySelector('[data-section="act"] [data-phase-id="p1"]');
    expect(actItem?.textContent).toBe('起');
    // CR3 auditor P-F8：条件区 act 的 hint 个体断言（7 常驻 + act = 8；beat 无所属
    // 集隐藏）——与默认 fixture 的 beat 断言合成九区闭合。
    const actHint = container.querySelector('[data-section="act"] .scene-detail-section-hint');
    expect(actHint?.textContent?.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.scene-detail-section-hint')).toHaveLength(8);
  });

  it('hides the beat section when episodeId is absent', () => {
    // s1 has no episodeId.
    useAppStore.setState({ selectedNodeId: 's1' } as any);
    const { container } = render(<SceneEditPopover />);
    expect(container.querySelector('[data-section="beat"]')).toBeNull();
  });

  it('shows emotional + pacing beats when episodeId resolves', () => {
    const { container } = render(<SceneEditPopover />);
    // s2.episodeId = 'ep1' → resolves to EP1 with 2 emotional + 1 pacing beat.
    const emotional = container.querySelectorAll('[data-beat-kind="emotional"] .scene-detail-beat');
    const pacing = container.querySelectorAll('[data-beat-kind="pacing"] .scene-detail-beat');
    expect(emotional).toHaveLength(2);
    expect(pacing).toHaveLength(1);
    expect([...emotional].map((li) => li.textContent)).toEqual(['期待', '震惊']);
  });

  it('hides the beat section when episodeId is set but does not resolve', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: baseGraph(),
        // ep1 NOT in the list → dangling episodeId → beat section hidden.
        episode_outlines: [{ id: 'other', index: 0, title: 'Other' }],
      },
      selectedNodeId: 's2',
    } as any);
    const { container } = render(<SceneEditPopover />);
    expect(container.querySelector('[data-section="beat"]')).toBeNull();
  });

  it('close button clears selectedNodeId', () => {
    const { container } = render(<SceneEditPopover />);
    const closeBtn = container.querySelector('[data-action="close"]') as HTMLElement;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn);
    expect(useAppStore.getState().selectedNodeId).toBeNull();
  });

  it('Escape closes the popover (window keydown — backdrop-less close path)', () => {
    render(<SceneEditPopover />);
    expect(useAppStore.getState().selectedNodeId).toBe('s2');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useAppStore.getState().selectedNodeId).toBeNull();
  });

  it('Escape inside an editing input only cancels the input, never closes the popover', () => {
    const { container } = render(<SceneEditPopover />);
    for (const sel of ['[data-field="title"]', '[data-field="summary"]', '[data-field="storyTime"]']) {
      fireEvent.keyDown(container.querySelector(sel)!, { key: 'Escape' });
      expect(useAppStore.getState().selectedNodeId, `Esc in ${sel} keeps the popover open`).toBe('s2');
    }
    // 对照面：window 级 Esc（上一个用例）仍走关闭——输入面的 stopPropagation 只拦
    // 「从输入冒泡上来的那一次」。
  });

  it('storyTime rejects non-integer literals without writing (strict integer validation)', () => {
    // 严格面新增：'1e9'（旧 parseInt 会静默截成 1）与 '2.7' 一律还原现值不写。
    // '-4'→钳 0 与清空/'abc' 还原的既有语义由 timelineLifecycle 锁定，此处不重复。
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<SceneEditPopover />);
    const input = container.querySelector('[data-field="storyTime"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1e9' } });
    fireEvent.blur(input);
    expect(updateSpy).not.toHaveBeenCalled();
    expect((container.querySelector('[data-field="storyTime"]') as HTMLInputElement).value).toBe('2');
    fireEvent.change(input, { target: { value: '2.7' } });
    fireEvent.blur(input);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(
      (useAppStore.getState().creativeFields.scene_graph as SceneGraph).nodes.find((n) => n.id === 's2')!.storyTime
    ).toBe(2);
    updateSpy.mockRestore();
  });

  it('outside click (document, not a card/chip, not inside the popover) closes it', () => {
    const { container } = render(<SceneEditPopover />);
    expect(container.querySelector('[data-popover="scene-edit"]')).not.toBeNull();
    // 点击浮层外空白（body 直下 div——非 [data-node-id]、非浮层内）。
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    fireEvent.click(outside);
    expect(useAppStore.getState().selectedNodeId).toBeNull();
    outside.remove();
  });

  it('role select writes the picked role via update_scene projection (once)', () => {
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<SceneEditPopover />);
    const roleSelect = container.querySelector('[data-field="role"]') as HTMLSelectElement;
    expect(roleSelect).not.toBeNull();
    expect(roleSelect.value).toBe('core-anchor');

    fireEvent.change(roleSelect, { target: { value: 'secondary-anchor' } });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('scene_graph');
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    const s2 = written.nodes.find((n) => n.id === 's2')!;
    expect(s2.role).toBe('secondary-anchor');
    updateSpy.mockRestore();
  });

  it('auto-clears selectedNodeId when the selected node disappears from the graph', () => {
    // s2 is currently selected. Replace the graph with one that has no s2.
    const g = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [{ id: 'sX', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } }],
      edges: [],
    });
    useAppStore.setState({
      creativeFields: { scene_graph: g },
    } as any);
    render(<SceneEditPopover />);
    // useEffect on mount detects s2 is gone → clears selection.
    expect(useAppStore.getState().selectedNodeId).toBeNull();
  });
});

// ── 浮层行为（R3）：指针旁展开 + 单例移位 + 拖动钳位（经 StructurePage 集成）──

describe('SceneEditPopover interaction via StructurePage (pointer + singleton + drag)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: baseGraph() },
      overlayToggles: { ...ALL_OVERLAYS_ON },
      selectedNodeId: null,
      focusedLineId: null,
      drillLevel: 'overview',
      resolvedLocale: 'en-US',
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('opens at the click point +14px (card click carries clientX/Y)', () => {
    const { container } = render(<StructurePage />);
    const page = container.querySelector('.structure-page') as HTMLElement;
    // 批 B 界语义：零尺寸 rect 是真实界（不再当 jsdom 退化）——确定性断言按真实
    // 浏览器页形 mock 非退化 rect。
    mockPageRect(page, 0, 0, 1024, 768);
    const card = container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]') as HTMLElement;
    expect(card).not.toBeNull();
    fireEvent.click(card, { clientX: 200, clientY: 150 });
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover).not.toBeNull();
    // 页界内放得下 → 纯 +14 偏移（无翻转/钳位触发）。
    expect(popover.style.left).toBe(`${200 + POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(`${150 + POPOVER_POINTER_OFFSET}px`);
  });

  it('R2 L2 layer: keyboard-style activation anchors to the OPENED ELEMENT rect centre', () => {
    const { container } = render(<StructurePage />);
    const page = container.querySelector('.structure-page') as HTMLElement;
    mockPageRect(page, 0, 0, 1024, 768);
    const card = container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]') as HTMLElement;
    // 打开方元素可测（真实浏览器键盘激活路径）→ 锚 = 卡片中心，浮层落邻域。
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(makeRect(500, 300, 620, 360));
    fireEvent.click(card); // 无 clientX/Y —— 键盘激活/无坐标合成点击形态
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover.dataset.sceneId).toBe('s2');
    // 中心 (560,330) → +14 展开；jsdom 偏移尺寸 0 → 分支①直落。
    expect(popover.style.left).toBe(`${560 + POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(`${330 + POPOVER_POINTER_OFFSET}px`);
  });

  it('keyboard-style click with an unmeasurable opener rect falls through to the L3 default corner (chrome floor honoured)', () => {
    const { container } = render(<StructurePage />);
    const page = container.querySelector('.structure-page') as HTMLElement;
    // 有偏移的页界：L3 默认锚 = 页左上角 (40, chrome 地板)；jsdom 卡片矩形全零
    // （不可采信）→ L2 miss → L3。原点若被误当指针锚会被钳到别处——两态可分辨。
    mockPageRect(page, 40, 80, 1064, 848);
    const card = container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]') as HTMLElement;
    fireEvent.click(card); // 无 clientX/Y 且 rect 全零
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    // 地板 = raw.top + 兜底常量（页内恒驻 chrome 矩形全零不采信）→ 默认位下移到
    // 地板内侧：left = 40+14；top = (80+102)+14——永不低于 chrome 带。
    expect(popover.style.left).toBe(`${40 + POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(
      `${80 + POPOVER_TOP_CHROME_BAND_FALLBACK + POPOVER_POINTER_OFFSET}px`
    );
  });

  it('singleton: clicking another card MOVES the popover and reloads its content', () => {
    const { container } = render(<StructurePage />);
    mockPageRect(container.querySelector('.structure-page') as HTMLElement, 0, 0, 1024, 768);
    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]')!,
      { clientX: 100, clientY: 100 }
    );
    let popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover.dataset.sceneId).toBe('s2');
    // 同一浮层实例（单例——DOM 节点复用，非新增第二枚）。
    const firstNode = popover;

    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] [data-node-id="s1"]')!,
      { clientX: 400, clientY: 300 }
    );
    popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(container.querySelectorAll('[data-popover="scene-edit"]')).toHaveLength(1);
    expect(popover).toBe(firstNode); // 移位重载，不是重开
    expect(popover.dataset.sceneId).toBe('s1');
    expect(popover.style.left).toBe(`${400 + POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(`${300 + POPOVER_POINTER_OFFSET}px`);
  });

  it('right-edge click flips the popover to the left of the click point', () => {
    const { container } = render(<StructurePage />);
    mockPageRect(container.querySelector('.structure-page') as HTMLElement, 0, 0, 1024, 768);
    // 点击 x=1010 → 1010+14 放不下（宽 0 也不行：1010+14 > 1024-12）→ 翻转到点击点左侧。
    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]')!,
      { clientX: 1010, clientY: 100 }
    );
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(Number(popover.style.left.replace('px', ''))).toBeLessThanOrEqual(1010);
  });

  it('title-bar drag clamps inside the structure page bounds (mocked page rect)', () => {
    const { container } = render(<StructurePage />);
    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]')!,
      { clientX: 200, clientY: 200 }
    );
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    const page = container.querySelector('.structure-page') as HTMLElement;
    expect(page).not.toBeNull();
    // jsdom 无真 rect——mock 结构页盒（dispatch 许可：jsdom 测不了真实 rect）。
    const rectSpy = vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    const header = popover.querySelector('[data-popover-drag]') as HTMLElement;
    fireEvent.mouseDown(header, { clientX: 214, clientY: 214 }); // 按住标题栏
    // 拖到页外右下（越界）→ 钳位回页内。
    fireEvent.mouseMove(document, { clientX: 5000, clientY: 5000 });
    fireEvent.mouseUp(document);
    // jsdom offsetWidth 0 → maxLeft = 1024-0-4；top ≤ 768-40。
    const left = Number(popover.style.left.replace('px', ''));
    const top = Number(popover.style.top.replace('px', ''));
    expect(left).toBe(1024 - POPOVER_DRAG_MARGIN);
    expect(top).toBe(768 - POPOVER_DRAG_HEADER_KEEP);
    rectSpy.mockRestore();
  });

  it('title input area does NOT start a drag (input is an edit surface, not a handle)', () => {
    const { container } = render(<StructurePage />);
    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]')!,
      { clientX: 200, clientY: 200 }
    );
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    const before = popover.style.left;
    const input = popover.querySelector('[data-field="title"]') as HTMLInputElement;
    fireEvent.mouseDown(input, { clientX: 210, clientY: 210 });
    fireEvent.mouseMove(document, { clientX: 600, clientY: 600 });
    fireEvent.mouseUp(document);
    expect(popover.style.left).toBe(before); // 未拖动
  });

  it('clicking the SceneCard opens the popover with that scene selected (E3 wiring intact)', () => {
    const { container } = render(<StructurePage />);
    expect(container.querySelector('[data-popover="scene-edit"]')).toBeNull();
    // click the s2 card in the causal skeleton.
    const s2Card = container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]') as HTMLElement;
    expect(s2Card).not.toBeNull();
    fireEvent.click(s2Card);
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.dataset.sceneId).toBe('s2');
    // the clicked card (and its multi-line sibling) reflect the selected state.
    const selectedCards = container.querySelectorAll('[data-skeleton="causal"] .scene-card--selected');
    expect(selectedCards.length).toBeGreaterThanOrEqual(1);
  });

  it('programmatic open ignores a stale outside-click anchor (stale-anchor leak fix)', () => {
    const { container } = render(<StructurePage />);
    const page = container.querySelector('.structure-page') as HTMLElement;
    mockPageRect(page, 0, 0, 1024, 768);
    // 指针打开 s1 @ (60,60)。
    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] [data-node-id="s1"]')!,
      { clientX: 60, clientY: 60 }
    );
    let popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover.style.left).toBe('74px');
    // 关闭浮层。
    fireEvent.click(popover.querySelector('[data-action="close"]') as HTMLElement);
    // 无关外点 @ (900,900)：旧实现把它存进挂起锚后不清——下一次程序化打开会消费
    // 这枚过路锚、凭空开在最后无关点击处（stale-anchor 泄漏）。
    fireEvent.click(document.body, { clientX: 900, clientY: 900 });
    act(() => {
      useAppStore.setState({ selectedNodeId: 's2' } as any);
    });
    popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover.dataset.sceneId).toBe('s2');
    // 程序化打开 = 无锚 → 默认锚（页左上角 + chrome 地板内侧 +14），不吃 (900,900)
    // 过路锚。R2：地板抬升使默认 top = 兜底带 + 偏移（left 不受竖向地板影响）。
    expect(popover.style.left).toBe(`${POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(
      `${POPOVER_TOP_CHROME_BAND_FALLBACK + POPOVER_POINTER_OFFSET}px`
    );
  });

  it('window resize re-clamps a placed popover into the shrunken page bounds', () => {
    const { container } = render(<StructurePage />);
    const page = container.querySelector('.structure-page') as HTMLElement;
    mockPageRect(page, 0, 0, 1024, 768);
    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] [data-node-id="s1"]')!,
      { clientX: 900, clientY: 600 }
    );
    let popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover.style.left).toBe('914px'); // 放得下：+14 原样
    expect(popover.style.top).toBe('614px');

    // 窗口收窄 → 页界随之变小；resize 把已放置的浮层钳回新界（不跳回原锚、不出界）。
    mockPageRect(page, 0, 0, 400, 300);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    // clampDragPosition(914, 614, 界 400×300)：left 钳右缘-4=396，top 钳底缘-40=260。
    expect(popover.style.left).toBe(`${400 - POPOVER_DRAG_MARGIN}px`);
    expect(popover.style.top).toBe(`${300 - POPOVER_DRAG_HEADER_KEEP}px`);
  });

  it('drag ends when the window loses focus (out-of-window mouseup hang fix)', () => {
    const { container } = render(<StructurePage />);
    mockPageRect(container.querySelector('.structure-page') as HTMLElement, 0, 0, 1024, 768);
    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]')!,
      { clientX: 200, clientY: 200 }
    );
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    const header = popover.querySelector('[data-popover-drag]') as HTMLElement;
    fireEvent.mouseDown(header, { clientX: 214, clientY: 214 }); // dx/dy = 0
    fireEvent.mouseMove(document, { clientX: 500, clientY: 500 });
    expect(popover.style.left).toBe('500px'); // 拖动生效
    // 松手发生在窗外（浏览器外 mouseup）→ 无 mouseup 可派发；blur 终止拖动。
    window.dispatchEvent(new Event('blur'));
    fireEvent.mouseMove(document, { clientX: 900, clientY: 900 });
    expect(popover.style.left).toBe('500px'); // 不再跟随——拖动已终止
    expect(popover.style.top).toBe('500px');
  });

  it('locate scrolls the WORKBENCH chip when opened from a workbench chip (source-region scope)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: baseGraph(),
        episode_outlines: [
          { id: 'e0', index: 0, title: 'Ch0' },
          { id: 'e1', index: 1, title: 'Ch1' },
        ],
      },
    } as any);
    let scrolledTarget: HTMLElement | null = null;
    const scrollSpy = stubScrollIntoViewCapture();
    const { container } = render(<StructurePage />);
    const chip = container.querySelector(
      '[data-skeleton="workbench"] .workbench-chip[data-node-id="s2"]'
    ) as HTMLElement;
    expect(chip).not.toBeNull();
    fireEvent.click(chip, { clientX: 320, clientY: 400 }); // 来源区 = workbench
    const locateBtn = container.querySelector(
      '[data-popover="scene-edit"] [data-action="locate"]'
    ) as HTMLElement;
    fireEvent.click(locateBtn);
    scrolledTarget = scrollSpy.get();
    expect(scrolledTarget).not.toBeNull();
    const target = scrolledTarget as HTMLElement;
    expect(target.getAttribute('data-node-id')).toBe('s2');
    // 同名元素因果侧也有一枚（文档序在前）——作用域查询没有误滚去因果卡。
    expect(target.closest('[data-skeleton="workbench"]')).not.toBeNull();
    expect(target.tagName).toBe('SPAN'); // chip 是 span，卡是 button/role 元素——来源区生效的旁证
    scrollSpy.restore();
  });

  it('locate on scoped miss falls back to the OPENER element itself — never the doc-order twin (R2 异区错锚根修)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: baseGraph(),
        episode_outlines: [
          { id: 'e0', index: 0, title: 'Ch0' },
          { id: 'e1', index: 1, title: 'Ch1' },
        ],
      },
    } as any);
    const scroll = stubScrollIntoViewCapture();
    const { container } = render(<StructurePage />);
    const chip = container.querySelector(
      '[data-skeleton="workbench"] .workbench-chip[data-node-id="s2"]'
    ) as HTMLElement;
    fireEvent.click(chip, { clientX: 320, clientY: 400 }); // opener 记录 = 工作台 chip
    // 区内实例消失（多线节点在工作台双行各一枚 chip + 用户删除等形态）→ 旧实现回
    // 全图文档序首个同名子（因果卡的 BUTTON 副本——滚去作者没看的另一区）；新实现
    // 兜底到「打开方元素自身」。移除**全部**工作台实例制造 scoped miss。
    const causalTwin = container.querySelector(
      '[data-skeleton="causal"] [data-node-id="s2"]'
    ) as HTMLElement;
    expect(causalTwin).not.toBeNull();
    container
      .querySelectorAll('[data-skeleton="workbench"] .workbench-chip[data-node-id="s2"]')
      .forEach((el) => el.remove());
    const locateBtn = container.querySelector(
      '[data-popover="scene-edit"] [data-action="locate"]'
    ) as HTMLElement;
    fireEvent.click(locateBtn);
    const scrolled = scroll.get() as unknown as HTMLElement | null;
    expect(scrolled).not.toBeNull();
    // 身份断言：滚的是打开方那枚（已游离），不是因果区文档序第一枚。
    expect(scrolled).toBe(chip);
    expect(scrolled).not.toBe(causalTwin);
    scroll.restore();
  });

  it('locate: a stale opener cannot hijack after the popover CLOSES — the ref is cleared on close (CR3 blind P-F1 tier②)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: baseGraph(),
        episode_outlines: [
          { id: 'e0', index: 0, title: 'Ch0' },
          { id: 'e1', index: 1, title: 'Ch1' },
        ],
      },
    } as any);
    const scroll = stubScrollIntoViewCapture();
    const { container } = render(<StructurePage />);
    // ①点 s1 卡（opener=s1 卡，region=causal）→ ②✕ 关闭（按钮在浮层内——捕获
    // 点击早退，无 document click 刷新 ref；旧实现不清）→ ③程序化选中 s2（agent
    // patch / 右键改名路径，无点击）。
    const s1Card = container.querySelector('[data-skeleton="causal"] [data-node-id="s1"]') as HTMLElement;
    fireEvent.click(s1Card, { clientX: 100, clientY: 100 });
    fireEvent.click(
      container.querySelector('[data-popover="scene-edit"] [data-action="close"]') as HTMLElement
    );
    act(() => {
      useAppStore.setState({ selectedNodeId: 's2' } as any);
    });
    // ④区内 scoped miss：移除因果侧 s2 实例 → 强制走兜底链。tier② 若被陈旧
    // opener（s1 卡仍存活且 attached）劫持则滚去 s1；修复后 ref 已在关闭时清空 →
    // tier③ 全图第一枚 = s2 自己的工作台 chip（当前节点自己的实例，绝不会错场）。
    container
      .querySelectorAll('[data-skeleton="causal"] [data-node-id="s2"]')
      .forEach((el) => el.remove());
    fireEvent.click(
      container.querySelector('[data-popover="scene-edit"] [data-action="locate"]') as HTMLElement
    );
    const scrolled = scroll.get();
    expect(scrolled).not.toBe(s1Card);
    expect(scrolled?.getAttribute('data-node-id')).toBe('s2');
    expect(scrolled?.closest('[data-skeleton="workbench"]')).not.toBeNull();
    scroll.restore();
  });

  it('locate: an alive opener belonging to ANOTHER node is skipped (identity check, CR3 blind P-F1 + edge P-3)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: baseGraph(),
        episode_outlines: [
          { id: 'e0', index: 0, title: 'Ch0' },
          { id: 'e1', index: 1, title: 'Ch1' },
        ],
      },
    } as any);
    const scroll = stubScrollIntoViewCapture();
    const { container } = render(<StructurePage />);
    // 打开 A（opener=A 卡）后 agent 直写换选中 B（无点击、无关闭——opener 存活、
    // attached 且属于他场）：tier② 必须身份校验拒用（data-node-id ≠ 当前节点），
    // 降 tier③ 滚 B 自己的实例。
    const s1Card = container.querySelector('[data-skeleton="causal"] [data-node-id="s1"]') as HTMLElement;
    fireEvent.click(s1Card, { clientX: 100, clientY: 100 });
    act(() => {
      useAppStore.setState({ selectedNodeId: 's2' } as any);
    });
    container
      .querySelectorAll('[data-skeleton="causal"] [data-node-id="s2"]')
      .forEach((el) => el.remove());
    fireEvent.click(
      container.querySelector('[data-popover="scene-edit"] [data-action="locate"]') as HTMLElement
    );
    const scrolled = scroll.get();
    expect(scrolled).not.toBe(s1Card);
    expect(scrolled?.getAttribute('data-node-id')).toBe('s2');
    expect(scrolled?.closest('[data-skeleton="workbench"]')).not.toBeNull();
    scroll.restore();
  });

  it('R2/CR3 measured chrome band drives the floor in-component (wiring guard for TOP_CHROME_SELECTORS)', () => {
    const { container } = render(<StructurePage />);
    const page = container.querySelector('.structure-page') as HTMLElement;
    mockPageRect(page, 0, 0, 1400, 900);
    // 源码锁式接线守卫（blind P-F3 + auditor P-F4）：选择器族在真实页面 DOM 中存在
    // 且「实测分支」端到端可达（fake rect 注入走真值路径）——CSS/DOM 改名或成员迁
    // 出 .structure-page 时此处红，「静默退 102 兜底」的双源失步不可观测问题根除。
    const zoombar = container.querySelector('.structure-zoombar') as HTMLElement;
    const minimap = container.querySelector('.timeline-minimap') as HTMLElement;
    expect(zoombar, 'zoombar selector lives in the page DOM').not.toBeNull();
    expect(minimap, 'minimap selector lives in the page DOM').not.toBeNull();
    // 实测带：zoombar 底 32 / minimap 底 96 → 地板 96（≠ 兜底 102——两值可分辨，
    // 断言真正锁住「实测优先」路径）。
    const zSpy = vi
      .spyOn(zoombar, 'getBoundingClientRect')
      .mockReturnValue(makeRect(0, 0, 1400, 32));
    const mSpy = vi
      .spyOn(minimap, 'getBoundingClientRect')
      .mockReturnValue(makeRect(0, 32, 1400, 96));
    const card = container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]') as HTMLElement;
    // 近顶点击（y=40，jsdom 浮层尺寸 0 → 分支① 落 54）：钳到实测地板+MARGIN=108；
    // 若选择器失步退 102 兜底则落 114——108 把实测分支钉死。
    fireEvent.click(card, { clientX: 200, clientY: 40 });
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover.style.top).toBe(`${96 + POPOVER_EDGE_MARGIN}px`);
    zSpy.mockRestore();
    mSpy.mockRestore();
  });

  it('E1 handover #2 / CR3 auditor P-F1: a horizontally scrolled workbench does NOT shift the landing point (clientX/Y and rects share the viewport system)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: baseGraph(),
        episode_outlines: [
          { id: 'e0', index: 0, title: 'Ch0' },
          { id: 'e1', index: 1, title: 'Ch1' },
        ],
      },
    } as any);
    const { container } = render(<StructurePage />);
    const page = container.querySelector('.structure-page') as HTMLElement;
    mockPageRect(page, 0, 0, 1024, 768);
    const scrollEl = container.querySelector('.workbench-scroll') as HTMLElement;
    expect(scrollEl).not.toBeNull();
    // 确定性横滚态（jsdom 无布局：own data property 钉住读值——任何后续「补偿
    // scrollLeft」的实现都会读到这个 300）。
    Object.defineProperty(scrollEl, 'scrollLeft', { configurable: true, value: 300 });
    expect(scrollEl.scrollLeft).toBe(300);
    const chip = container.querySelector(
      '[data-skeleton="workbench"] .workbench-chip[data-node-id="s2"]'
    ) as HTMLElement;
    fireEvent.click(chip, { clientX: 320, clientY: 400 });
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    // 落点 = 点击点 +14 原样（clientX/Y 与 getBoundingClientRect 同视口系自洽）——
    // 若实现混入 scrollLeft 补偿/画布系换算会平移 300px。E1 假说「workbench-scroll
    // 内嵌坐标系差」(#66 形态二) 的回归面就此锁死。
    expect(popover.style.left).toBe(`${320 + POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(`${400 + POPOVER_POINTER_OFFSET}px`);
  });
});

// ── T1 首开锚（C1 真机遍历发现批 2：关闭态点击 → 首开走 L1 点击锚）──
//
// 真机根因（prd T1）：锚记录（document capture 原生监听 → setAnchorTick 独立调度）
// 与选中提交（React 冒泡 onClick → 外部 store）在真实 React 调度下可分属两次
// commit——锚记录的 tick 提交先落时，定位 effect 的 !node 清扫把即将被消费的锚
// 提前毁掉，首开恒落 L3 defaultAnchor（四入口 x=页左+14 全复现）。jsdom 里
// fireEvent + act 恒把两半合并进同一提交，矩阵全绿是假象——本组用例以**不冒泡
// 原生 click**（capture 链路照达 document 监听器、React 根的冒泡分派永不触发）
// 把「锚记录」与「选中提交」解耦成两次独立提交，锁死该交错下的 L1 锚路径。

describe('T1 first-open anchor (capture-recorded anchor survives to its selection commit)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: baseGraph() },
      overlayToggles: { ...ALL_OVERLAYS_ON },
      selectedNodeId: null,
      focusedLineId: null,
      drillLevel: 'overview',
      resolvedLocale: 'en-US',
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('causal card entry: closed-state click anchor (split commits) opens at click point +14, not the L3 default corner', () => {
    const { container } = render(<StructurePage />);
    mockPageRect(container.querySelector('.structure-page') as HTMLElement, 0, 0, 1024, 768);
    const card = container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]') as HTMLElement;
    expect(card).not.toBeNull();
    // 半一：锚记录（真机 = document capture，无选中跟随——React 冒泡分派在另一次
    // 提交）。旧实现在此提交的 !node 清扫里把锚毁掉（组件渲染 null 但监听器活着，
    // jsdom 全绿掩盖的就是这一步）。
    act(() => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: false, clientX: 320, clientY: 240 }));
    });
    // 半二：选中提交独立到达（卡片 onClick 的另一半）。
    act(() => {
      useAppStore.setState({ selectedNodeId: 's2' } as any);
    });
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover).not.toBeNull();
    // L1 点击锚生效（+14 无翻转/钳位——页界内放得下）；若锚被清扫吞掉则落 L3
    // 默认角（left=14 / top=102+14），两态可分辨。
    expect(popover.style.left).toBe(`${320 + POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(`${240 + POPOVER_POINTER_OFFSET}px`);
  });

  it('workbench chip entry: same split-commit survival for the chip opener (四入口之二)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: baseGraph(),
        episode_outlines: [
          { id: 'e0', index: 0, title: 'Ch0' },
          { id: 'e1', index: 1, title: 'Ch1' },
        ],
      },
    } as any);
    const { container } = render(<StructurePage />);
    mockPageRect(container.querySelector('.structure-page') as HTMLElement, 0, 0, 1024, 768);
    const chip = container.querySelector(
      '[data-skeleton="workbench"] .workbench-chip[data-node-id="s2"]'
    ) as HTMLElement;
    expect(chip).not.toBeNull();
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: false, clientX: 480, clientY: 520 }));
    });
    act(() => {
      useAppStore.setState({ selectedNodeId: 's2' } as any);
    });
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.dataset.sceneId).toBe('s2');
    expect(popover.style.left).toBe(`${480 + POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(`${520 + POPOVER_POINTER_OFFSET}px`);
  });

  it('identity check: a card anchor whose selection never arrives cannot hijack a programmatic open of ANOTHER scene (swallowed-click shape)', () => {
    const { container } = render(<StructurePage />);
    mockPageRect(container.querySelector('.structure-page') as HTMLElement, 0, 0, 1024, 768);
    const s1Card = container.querySelector('[data-skeleton="causal"] [data-node-id="s1"]') as HTMLElement;
    // 吞点击形态（WorkbenchChip resize 尾随 click 被 swallow——选中不跟随）：卡片
    // 锚残留但无人消费；随后程序化打开 s2（右键改名路径）不得落在这枚他场锚上。
    act(() => {
      s1Card.dispatchEvent(new MouseEvent('click', { bubbles: false, clientX: 700, clientY: 700 }));
    });
    act(() => {
      useAppStore.setState({ selectedNodeId: 's2' } as any);
    });
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    // 配对失败（nodeId=s1 ≠ 选中 s2）→ 锚不生效 → L3 默认位（页左上角 + chrome
    // 地板内侧 +14——与既有程序化打开用例同口径），不吃 (700,700)。
    expect(popover.style.left).toBe(`${POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(
      `${POPOVER_TOP_CHROME_BAND_FALLBACK + POPOVER_POINTER_OFFSET}px`
    );
  });

  it('split-commit move-reload: an anchor recorded while the OLD node is still selected stays pending and is consumed when its selection commit lands', () => {
    const { container } = render(<StructurePage />);
    mockPageRect(container.querySelector('.structure-page') as HTMLElement, 0, 0, 1024, 768);
    // 打开 s2 @ (200,200)（常规合并提交路径）。
    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] [data-node-id="s2"]')!,
      { clientX: 200, clientY: 200 }
    );
    let popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover.style.left).toBe(`${200 + POPOVER_POINTER_OFFSET}px`);
    // 点 s1 @ (500,300)——锚记录与选中分属两次提交：tick 提交先落时旧选中（s2）
    // 仍在场。配对失败的锚不弃置（本提交不移位、不吞锚），选中提交侧再消费。
    act(() => {
      (
        container.querySelector('[data-skeleton="causal"] [data-node-id="s1"]') as HTMLElement
      ).dispatchEvent(new MouseEvent('click', { bubbles: false, clientX: 500, clientY: 300 }));
    });
    // tick 提交后：仍开在旧位（不跳去 (514,314)——选中未到，锚未配对生效）。
    popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover.dataset.sceneId).toBe('s2');
    expect(popover.style.left).toBe(`${200 + POPOVER_POINTER_OFFSET}px`);
    // 选中提交到达 → 锚配对生效 → 移位重载到 s1 的点击点。
    act(() => {
      useAppStore.setState({ selectedNodeId: 's1' } as any);
    });
    popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover.dataset.sceneId).toBe('s1');
    expect(popover.style.left).toBe(`${500 + POPOVER_POINTER_OFFSET}px`);
    expect(popover.style.top).toBe(`${300 + POPOVER_POINTER_OFFSET}px`);
  });
});

// ── AC4 矩阵：四入口 × 三屏态（R2 / #72 —— jsdom 化的验收矩阵）──

describe('AC4 placement matrix: four openers × three screen states', () => {
  /** 浮层名义尺寸（stub 后与真实浏览器同量纲）——三屏态按此驱动翻转/溢出分支。 */
  const W = 320;
  const H = 420;
  /**
   * 点击邻域紧阈值（CR3 blind P-F8 + auditor P-F2）：E1 公式保证浮层在两轴各距
   * 点击 ≤ OFFSET（+14 展开 / 翻转侧距 14 / 垂帘态点击落矩形带内）→ 最近距离
   * ≤ √2·OFFSET ≈ 19.8。原「≤ 半视口」阈值（240~450px）对任何合理公式产出恒真
   * 不可证伪；收紧后 placement 漂移（如退默认角落，距离数百 px）即红。
   */
  const NEIGHBOURHOOD_TIGHT = Math.ceil(Math.SQRT2 * POPOVER_POINTER_OFFSET); // 20
  let sizeSpies: ReturnType<typeof stubPopoverSize>;

  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: spanMatrixGraph(), episode_outlines: matrixEpisodes() },
      overlayToggles: { validation: true, displacement: true, visibility: true },
      selectedNodeId: null,
      focusedLineId: null,
      drillLevel: 'overview',
      resolvedLocale: 'en-US',
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    sizeSpies.forEach((s) => s.mockRestore());
    cleanup();
  });

  /** 三屏态：raw 页 rect / 点击位（各态不同）/ E1 公式的确定性期望落点。 */
  const STATES = [
    {
      label: 'near-top click (chrome band proximity)',
      rect: [0, 0, 1400, 900] as const,
      click: { x: 700, y: 120 },
      expected: { left: 714, top: 134 },
      minTop: POPOVER_TOP_CHROME_BAND_FALLBACK,
    },
    {
      label: 'right-bottom squeeze (both-edge flip)',
      rect: [0, 0, 900, 600] as const,
      click: { x: 860, y: 585 },
      expected: { left: 860 - W - POPOVER_POINTER_OFFSET, top: 585 - POPOVER_POINTER_OFFSET - H },
      minTop: POPOVER_TOP_CHROME_BAND_FALLBACK,
    },
    {
      label: 'over-tall viewport (branch④ floor pin + maxHeight shrink)',
      rect: [0, 0, 760, 480] as const,
      click: { x: 380, y: 240 },
      expected: { left: 394, top: POPOVER_TOP_CHROME_BAND_FALLBACK + POPOVER_EDGE_MARGIN },
      minTop: POPOVER_TOP_CHROME_BAND_FALLBACK,
    },
  ];

  const ENTRIES = [
    {
      label: 'cross-chapter span chip',
      selector:
        '[data-skeleton="workbench"] .workbench-chip--span[data-node-id="s_span"]',
    },
    {
      label: 'ordinary chapter chip',
      selector:
        '[data-skeleton="workbench"] [data-chapter="1"] .workbench-chip[data-node-id="s_plain"]',
    },
    {
      label: 'causal SceneCard',
      selector: '[data-skeleton="causal"] [data-node-id="s_causal_only"]',
    },
    {
      label: 'pending grey slice',
      selector:
        '[data-skeleton="workbench"] [data-chapter="pending"] .workbench-chip[data-node-id="s_pend"]',
    },
  ];

  for (const entry of ENTRIES) {
    for (const state of STATES) {
      it(`${entry.label} × ${state.label}: lands at the formula point, inside the visible box, never above the chrome floor`, () => {
        sizeSpies = stubPopoverSize(W, H);
        const { container } = render(<StructurePage />);
        const page = container.querySelector('.structure-page') as HTMLElement;
        mockPageRect(page, state.rect[0], state.rect[1], state.rect[2], state.rect[3]);
        const openerEl = container.querySelector(entry.selector) as HTMLElement;
        expect(openerEl, `${entry.label} renders`).not.toBeNull();
        fireEvent.click(openerEl, { clientX: state.click.x, clientY: state.click.y });
        const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
        expect(popover, `${entry.label} opens`).not.toBeNull();

        const left = Number(popover.style.left.replace('px', ''));
        const top = Number(popover.style.top.replace('px', ''));

        // E1 固化公式的确定性落点。
        expect(left).toBe(state.expected.left);
        expect(top).toBe(state.expected.top);

        // 合法性①：不越 chrome 地板、不出可视域左右缘。
        expect(top).toBeGreaterThanOrEqual(state.minTop);
        expect(left).toBeGreaterThanOrEqual(state.rect[0]);
        expect(left + W).toBeLessThanOrEqual(state.rect[2]);
        expect(popover.dataset.sceneId?.length ?? 0).toBeGreaterThan(0);

        // 合法性②（CR3 edge P-1 / blind P-F8）：底缘断言——原矩阵只断三缘。顶钉
        // 形态由 maxHeight 钳制（blind P-F5 高度联动）保证**有效高**底缘不出下界，
        // 「四缘合法」断言首次全量成立。
        const maxHeightRaw = popover.style.maxHeight;
        const effectiveH = maxHeightRaw === ''
          ? H
          : Math.min(H, Number(maxHeightRaw.replace('px', '')));
        expect(top + effectiveH).toBeLessThanOrEqual(state.rect[3] - POPOVER_EDGE_MARGIN);

        // 合法性③（CR3 紧阈值）：点击邻域 ≤ √2·OFFSET（公式推导实数，可证伪——
        // 原「≤ 半视口」在矩阵屏态下恒真）。
        const dist = distanceToRect(state.click.x, state.click.y, {
          left,
          top,
          width: W,
          height: effectiveH,
        });
        expect(dist).toBeLessThanOrEqual(NEIGHBOURHOOD_TIGHT);
      });
    }
  }
});
