import { beforeEach, describe, expect, it } from 'vitest';
import { create } from 'zustand';
import {
  CANVAS_ZOOM_DEFAULT,
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  createStructureSlice,
  type StructureSlice,
} from '../src/shared/store/structureSlice';
import { runProjectResets } from '../src/shared/store/resetRegistry';

type TestState = StructureSlice;

const useTestStore = create<TestState>()((...args) => ({
  ...createStructureSlice(...args),
}));

describe('structureSlice', () => {
  beforeEach(() => {
    // Restore canonical defaults (also what project-switch reset must converge to).
    // 08-26 结构页重构 批 1：emotion 默认 true（R4 拍板——红条非异常是信息轨）；
    // canvasZoom 默认 1（会话级镜头，见下方专测）。
    useTestStore.setState({
      selectedNodeId: null,
      focusedLineId: null,
      drillLevel: 'overview',
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: true, pacing: false },
      // dogfood R2 批次 A/D2：新增 UI-local 态回默认。
      highlightNodeIds: [],
      editingLineId: null,
      drawerTitleFocus: false,
      canvasZoom: CANVAS_ZOOM_DEFAULT,
      // 08-26 批 5（#43）：图例折叠态回默认（折叠）。
      legendExpanded: false,
    });
  });

  it('exposes the documented defaults (legacy overlays on, emotion on (08-26 批 1), pacing off, drill overview, no selection)', () => {
    const s = useTestStore.getState();
    expect(s.selectedNodeId).toBeNull();
    expect(s.focusedLineId).toBeNull();
    expect(s.drillLevel).toBe('overview');
    expect(s.overlayToggles).toEqual({
      validation: true,
      displacement: true,
      visibility: true,
      emotion: true,
      pacing: false,
    });
    expect(s.canvasZoom).toBe(1);
  });

  it('setters update selection, focus, and drill level independently', () => {
    useTestStore.getState().setSelectedNodeId('scene-3');
    useTestStore.getState().setFocusedLineId('line-main');
    useTestStore.getState().setDrillLevel('scene');

    const s = useTestStore.getState();
    expect(s.selectedNodeId).toBe('scene-3');
    expect(s.focusedLineId).toBe('line-main');
    expect(s.drillLevel).toBe('scene');
  });

  // ── dogfood R2 批次 A/D2 新增态：高亮集 / 线改名 / 抽屉标题聚焦旗标 ──

  it('dogfood R2: highlightNodeIds / editingLineId / drawerTitleFocus default empty and set independently', () => {
    const s0 = useTestStore.getState();
    expect(s0.highlightNodeIds).toEqual([]);
    expect(s0.editingLineId).toBeNull();
    expect(s0.drawerTitleFocus).toBe(false);

    useTestStore.getState().setHighlightNodeIds(['S-1', 'S-2']);
    useTestStore.getState().setEditingLineId('L-1');
    useTestStore.getState().setDrawerTitleFocus(true);

    const s1 = useTestStore.getState();
    expect(s1.highlightNodeIds).toEqual(['S-1', 'S-2']);
    expect(s1.editingLineId).toBe('L-1');
    expect(s1.drawerTitleFocus).toBe(true);

    // 消费语义：清回（高亮 TTL 到点 / Enter 提交改名 / 抽屉聚焦完成后）。
    useTestStore.getState().setHighlightNodeIds([]);
    useTestStore.getState().setEditingLineId(null);
    useTestStore.getState().setDrawerTitleFocus(false);
    const s2 = useTestStore.getState();
    expect(s2.highlightNodeIds).toEqual([]);
    expect(s2.editingLineId).toBeNull();
    expect(s2.drawerTitleFocus).toBe(false);
  });

  it('toggleOverlay flips a single overlay without touching the others', () => {
    useTestStore.getState().toggleOverlay('validation');
    expect(useTestStore.getState().overlayToggles).toEqual({
      validation: false,
      displacement: true,
      visibility: true,
      emotion: true,
      pacing: false,
    });

    useTestStore.getState().toggleOverlay('visibility');
    expect(useTestStore.getState().overlayToggles).toEqual({
      validation: false,
      displacement: true,
      visibility: false,
      emotion: true,
      pacing: false,
    });
  });

  it('dogfood R2: emotion/pacing toggles flip independently of the legacy trio (emotion now defaults on)', () => {
    useTestStore.getState().toggleOverlay('emotion');
    expect(useTestStore.getState().overlayToggles).toEqual({
      validation: true,
      displacement: true,
      visibility: true,
      emotion: false,
      pacing: false,
    });
    useTestStore.getState().toggleOverlay('pacing');
    expect(useTestStore.getState().overlayToggles.emotion).toBe(false);
    expect(useTestStore.getState().overlayToggles.pacing).toBe(true);
    // 三老开关不动。
    expect(useTestStore.getState().overlayToggles.validation).toBe(true);
  });

  it('setOverlayToggles merges a partial without dropping untouched keys', () => {
    useTestStore.getState().setOverlayToggles({ displacement: false });
    expect(useTestStore.getState().overlayToggles).toEqual({
      validation: true,
      displacement: false,
      visibility: true,
      emotion: true,
      pacing: false,
    });
  });

  // ── 08-26 结构页重构 批 1（implement 1.3）：canvasZoom ──

  it('08-26 批 1: canvasZoom 默认 1；setCanvasZoom 钳进 [MIN, MAX]（#78 后 MIN=0.05；NaN 防御回落 1）；resetCanvasZoom 复位', () => {
    useTestStore.getState().setCanvasZoom(0.9);
    expect(useTestStore.getState().canvasZoom).toBe(0.9);
    useTestStore.getState().setCanvasZoom(99);
    expect(useTestStore.getState().canvasZoom).toBe(CANVAS_ZOOM_MAX);
    useTestStore.getState().setCanvasZoom(0.01);
    expect(useTestStore.getState().canvasZoom).toBe(CANVAS_ZOOM_MIN);
    useTestStore.getState().setCanvasZoom(Number.NaN);
    expect(useTestStore.getState().canvasZoom).toBe(CANVAS_ZOOM_DEFAULT);
    useTestStore.getState().resetCanvasZoom();
    expect(useTestStore.getState().canvasZoom).toBe(1);
  });

  it('08-26 批 1: canvasZoom 不随项目切换重置（会话级镜头偏好，design §7——同窗口尺寸语义）', () => {
    useTestStore.getState().setCanvasZoom(0.6);
    runProjectResets();
    expect(useTestStore.getState().canvasZoom).toBe(0.6);
  });

  // ── 08-26 批 5（#43）：图例折叠态（会话级——同 canvasZoom 语义，不随项目切换重置）──

  it('08-26 批 5: legendExpanded 默认 false（折叠一行摘要）；toggle 翻转', () => {
    expect(useTestStore.getState().legendExpanded).toBe(false);
    useTestStore.getState().toggleLegendExpanded();
    expect(useTestStore.getState().legendExpanded).toBe(true);
    useTestStore.getState().toggleLegendExpanded();
    expect(useTestStore.getState().legendExpanded).toBe(false);
  });

  it('08-26 批 5: legendExpanded 不随项目切换重置（会话内开合记忆）', () => {
    useTestStore.getState().toggleLegendExpanded();
    expect(useTestStore.getState().legendExpanded).toBe(true);
    runProjectResets();
    expect(useTestStore.getState().legendExpanded).toBe(true); // 会话级，非项目级
  });

  it('clears selection, focus, drill, and overlays on project-switch reset', () => {
    // Dirty the slice as if the author drilled into project A's structure.
    useTestStore.setState({
      selectedNodeId: 'scene-9',
      focusedLineId: 'line-side',
      drillLevel: 'scene',
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: true },
      highlightNodeIds: ['S-9'],
      editingLineId: 'L-2',
      drawerTitleFocus: true,
    });

    runProjectResets();

    const s = useTestStore.getState();
    expect(s.selectedNodeId).toBeNull();
    expect(s.focusedLineId).toBeNull();
    expect(s.drillLevel).toBe('overview');
    // 曲线叠层随项目切换回落默认（emotion 开 / pacing 关——08-26 批 1 起的标准态）。
    expect(s.overlayToggles).toEqual({
      validation: true,
      displacement: true,
      visibility: true,
      emotion: true,
      pacing: false,
    });
    // 批次 A/D2 新增态同样随项目切换清（脉冲/改名/聚焦旗标跨项目无意义）。
    expect(s.highlightNodeIds).toEqual([]);
    expect(s.editingLineId).toBeNull();
    expect(s.drawerTitleFocus).toBe(false);
  });
});
