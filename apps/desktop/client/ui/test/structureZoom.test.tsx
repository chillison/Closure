/**
 * 08-26 结构页重构 批 1（implement 1.3 / design §3.4 / prd R4）：画布缩放 + 横向导航 测试。
 *
 * 两层：
 *   1. 纯函数（structureSlice 导出的 zoom 数学）：clampCanvasZoom / stepCanvasZoom /
 *      zoomFromWheel / fitCanvasZoom——0.4-1.5 钳制、fp 尘消除、指数滚轮、fit 自洽。
 *   2. StructurePage 集成：zoom 工具组在 canvas 外、canvas 承载 inline zoom；ctrl+滚轮
 *      缩放（打满钳 1.5）；无修饰滚轮不拦截；shift+滚轮驱动页横向滚动；工具组按钮
 *      （＋/％复位/适宽-jsdom no-op）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run structureZoom`
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sceneGraphSchema, type SceneGraph } from '@orison/shared-contracts';
import { StructurePage } from '../src/features/structure/StructurePage';
import { useAppStore } from '../src/shared/store/appStore';
import {
  CANVAS_ZOOM_DEFAULT,
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  clampCanvasZoom,
  fitCanvasZoom,
  stepCanvasZoom,
  zoomFromWheel,
} from '../src/shared/store/structureSlice';

/** 1 线 2 场景最小图（hasGraph 门槛过即可——zoom 不依赖图形态）。 */
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

describe('zoom 纯函数（structureSlice 导出）', () => {
  it('clampCanvasZoom：钳 [MIN, MAX]（#78 后 MIN=0.05）；非有限值回落 1', () => {
    expect(clampCanvasZoom(0.01)).toBe(CANVAS_ZOOM_MIN);
    expect(clampCanvasZoom(3)).toBe(CANVAS_ZOOM_MAX);
    expect(clampCanvasZoom(1)).toBe(1);
    expect(clampCanvasZoom(Number.NaN)).toBe(CANVAS_ZOOM_DEFAULT);
    expect(clampCanvasZoom(Number.POSITIVE_INFINITY)).toBe(CANVAS_ZOOM_DEFAULT);
  });

  it('stepCanvasZoom：±0.1 步进、两端钳制、无 fp 尘（1.1+0.1=1.2 非 1.2000…2）', () => {
    expect(stepCanvasZoom(1, 1)).toBe(1.1);
    expect(stepCanvasZoom(1.1, 1)).toBe(1.2);
    expect(stepCanvasZoom(1.45, 1)).toBe(CANVAS_ZOOM_MAX); // 上界钳
    expect(stepCanvasZoom(0.08, -1)).toBe(CANVAS_ZOOM_MIN); // 下界钳（#78 后 0.05；0.08-0.1 负值落底）
  });

  it('zoomFromWheel：deltaY<0 放大、>0 缩小、巨量两端钳死', () => {
    expect(zoomFromWheel(1, -500)).toBeGreaterThan(1);
    expect(zoomFromWheel(1, 500)).toBeLessThan(1);
    expect(zoomFromWheel(1, -1e9)).toBe(CANVAS_ZOOM_MAX);
    expect(zoomFromWheel(1, 1e9)).toBe(CANVAS_ZOOM_MIN);
    // 已在上/下界的值不再越界。
    expect(zoomFromWheel(CANVAS_ZOOM_MAX, -1)).toBe(CANVAS_ZOOM_MAX);
    expect(zoomFromWheel(CANVAS_ZOOM_MIN, 1)).toBe(CANVAS_ZOOM_MIN);
  });

  it('CR 组1 edge-1：非有限 deltaY 视作无滚动（保持当前值）——NaN 曾穿透 exp 跳上界', () => {
    // exp(NaN)=NaN 曾落进「非有限即 CANVAS_ZOOM_MAX」的爆量程分支：zoom 直接跳
    // 150% 上界。畸形增量现在归化为「当前值钳制」。
    expect(zoomFromWheel(1, Number.NaN)).toBe(1);
    expect(zoomFromWheel(0.8, Number.NaN)).toBe(0.8);
    expect(zoomFromWheel(7, Number.NaN)).toBe(CANVAS_ZOOM_MAX);   // 当前值越界的仍被钳
    expect(zoomFromWheel(Number.NaN, Number.NaN)).toBe(CANVAS_ZOOM_DEFAULT); // 双坏入参 → 默认
    // 非有限增量统一「无滚动」语义：±Infinity 同样保持当前值（有向爆量程的旧
    // 分支随 NaN 守卫一并收编——极端滚轮事件不再瞬移到边界）。
    expect(zoomFromWheel(1, Number.POSITIVE_INFINITY)).toBe(1);
    expect(zoomFromWheel(1, Number.NEGATIVE_INFINITY)).toBe(1);
    expect(zoomFromWheel(0.8, Number.POSITIVE_INFINITY)).toBe(0.8);
  });

  it('fitCanvasZoom：viewport/content（屏坐标）×current，与当前 zoom 无关；量不到（jsdom 双 0）→ no-op', () => {
    // 自然宽 2000 的内容：zoom=1 屏宽 2000、视口 1000 → 0.5。
    expect(fitCanvasZoom(1, 1000, 2000)).toBeCloseTo(0.5, 5);
    // 同一内容已在 0.5：屏宽 = 2000×0.5 = 1000 = 视口 → 已适宽，保持 0.5
    // （换算自洽，不二次缩放）。
    expect(fitCanvasZoom(0.5, 1000, 1000)).toBeCloseTo(0.5, 5);
    // 适宽后仍低于下限 → 钳 MIN（#78 后 0.05；1000/30000≈0.033 落底）。
    expect(fitCanvasZoom(1, 1000, 30000)).toBe(CANVAS_ZOOM_MIN);
    // jsdom clientWidth / bounding rect 全 0 → 保持当前。
    expect(fitCanvasZoom(0.8, 0, 0)).toBe(0.8);
    expect(fitCanvasZoom(0.8, -5, 0)).toBe(0.8);
  });
});

describe('StructurePage 画布缩放 + shift 横滚（集成）', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: graph() },
      resolvedLocale: 'en-US',
      canvasZoom: 1,
    } as any);
  });

  afterEach(cleanup);

  function els(container: HTMLElement) {
    const page = container.querySelector('.structure-page') as HTMLElement | null;
    const canvas = container.querySelector('[data-structure-canvas]') as HTMLElement | null;
    expect(page).not.toBeNull();
    expect(canvas).not.toBeNull();
    return { page: page!, canvas: canvas! };
  }

  it('缩放组渲染在 canvas 外（不受缩放）；canvas 承载 inline zoom = 当前倍率', () => {
    const { container } = render(<StructurePage />);
    const { canvas } = els(container);
    const bar = container.querySelector('.structure-zoombar') as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(canvas.contains(bar)).toBe(false); // design §3.4：工具栏不进 zoom 容器
    // zoom=1 时 style.zoom 序列化为 '1'（jsdom 支持该属性存储）。
    expect(canvas.style.zoom).toBe('1');
  });

  it('ctrl+滚轮：放大 canvas 并写回 store；连续打满钳 1.5（AC5 范围钳制）', () => {
    const { container } = render(<StructurePage />);
    const { page, canvas } = els(container);
    fireEvent.wheel(page, { ctrlKey: true, deltaY: -400 });
    const z1 = useAppStore.getState().canvasZoom;
    expect(z1).toBeGreaterThan(1);
    expect(canvas.style.zoom).toBe(String(z1)); // 同步施加（同容器同比）
    for (let i = 0; i < 40; i++) {
      fireEvent.wheel(page, { ctrlKey: true, deltaY: -1000 });
    }
    expect(useAppStore.getState().canvasZoom).toBe(CANVAS_ZOOM_MAX);
    expect(canvas.style.zoom).toBe(String(CANVAS_ZOOM_MAX));
  });

  it('ctrl+滚轮下滚缩小，钳 0.4 下限', () => {
    const { container } = render(<StructurePage />);
    const { page } = els(container);
    for (let i = 0; i < 40; i++) {
      fireEvent.wheel(page, { ctrlKey: true, deltaY: 1000 });
    }
    expect(useAppStore.getState().canvasZoom).toBe(CANVAS_ZOOM_MIN);
  });

  it('无修饰滚轮不拦截（zoom 不动——纵滚/内层滚动区行为保持）', () => {
    const { container } = render(<StructurePage />);
    const { page } = els(container);
    fireEvent.wheel(page, { deltaY: -400 });
    fireEvent.wheel(page, { deltaY: 400 });
    expect(useAppStore.getState().canvasZoom).toBe(1);
  });

  it('shift+滚轮 → 页横向滚动（deltaY 转 scrollLeft，AC6）', () => {
    const { container } = render(<StructurePage />);
    const { page } = els(container);
    fireEvent.wheel(page, { shiftKey: true, deltaY: 120 });
    expect(page.scrollLeft).toBe(120);
    fireEvent.wheel(page, { shiftKey: true, deltaY: 60 });
    expect(page.scrollLeft).toBe(180);
  });

  it('deltaMode=1（行模式）横滚与缩放同款 ×16 归一（BMad CR 组3a 双标归一）', () => {
    const { container } = render(<StructurePage />);
    const { page } = els(container);
    // 行模式 3 行 → 48px（旧行为 3px/tick 几乎不可感——ctrl 分支早已归一，此为同轴收敛锁）。
    fireEvent.wheel(page, { shiftKey: true, deltaMode: 1, deltaY: 3 });
    expect(page.scrollLeft).toBe(48);
  });

  it('绑定死区修复：无图首挂载（EmptyState）→ 图后到，wheel/hover 委托条件重绑生效', () => {
    useAppStore.setState({ creativeFields: {} } as any); // 无 scene_graph → EmptyState 分支
    const { container } = render(<StructurePage />);
    expect(container.querySelector('.structure-page')).toBeNull(); // 初始无页容器
    act(() => {
      useAppStore.setState({ creativeFields: { scene_graph: graph() } } as any);
    });
    // 图后到：页容器出现，wheel 委托已随 hasGraph 翻转补绑（旧 [] deps 永哑）。
    const page = container.querySelector('.structure-page') as HTMLElement;
    expect(page).not.toBeNull();
    fireEvent.wheel(page, { ctrlKey: true, deltaY: -400 });
    expect(useAppStore.getState().canvasZoom).toBeGreaterThan(1);
  });

  it('工具组：＋步进 1.1 且％文本跟随；％钮点击复位 100%；适宽在 jsdom 下 no-op', () => {
    const { container } = render(<StructurePage />);
    els(container);
    const inBtn = container.querySelector('[data-zoom-action="in"]') as HTMLButtonElement;
    const pctBtn = container.querySelector('[data-zoom-action="reset"]') as HTMLButtonElement;
    const fitBtn = container.querySelector('[data-zoom-action="fit"]') as HTMLButtonElement;
    expect(inBtn).not.toBeNull();
    expect(pctBtn).not.toBeNull();
    expect(fitBtn).not.toBeNull();

    fireEvent.click(inBtn);
    expect(useAppStore.getState().canvasZoom).toBe(1.1);
    expect(pctBtn.textContent).toBe('110%');

    // 适宽：jsdom clientWidth/rect 全 0 → 量不到 → 保持当前（no-op 契约）。
    fireEvent.click(fitBtn);
    expect(useAppStore.getState().canvasZoom).toBe(1.1);

    fireEvent.click(pctBtn);
    expect(useAppStore.getState().canvasZoom).toBe(1);
    expect(pctBtn.textContent).toBe('100%');
  });

});

