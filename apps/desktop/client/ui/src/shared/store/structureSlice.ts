import type { StateCreator } from 'zustand';
import { registerProjectReset } from './resetRegistry';
import type { SceneGraphIssue } from '@orison/shared-contracts';

/**
 * Story 1.5 Phase B (design §1.3 / spec/ui/state-management.md "Closure UI 面板
 * = 新 slice"): UI-local state for the structure page (activePage 'structure').
 * Holds the timeline's interaction/overlay state — NOT the scene_graph data
 * itself (that lives in creativeFieldsSlice.scene_graph, the source of truth).
 *
 * Project-scoped: which node/line the author drilled into is meaningless across
 * projects, so the slice self-registers a project-switch reset (same pattern as
 * creativeFieldsSlice / panelsSlice — see resetRegistry).
 *
 * Downstream interface (CLAUDE.md "线性构建≠线性耦合"): `overlayToggles` is the
 * Epic 5 (emotion overlay, UX-DR8) / Epic 6 Story 6.5 (Promise lifecycle overlay)
 * mount point — they add a toggle + an Overlay component following the
 * ValidationOverlay precedent this slice already drives. dogfood R2 批次 B 已按
 * 此约落地 emotion/pacing 两键（EmotionOverlay / PacingOverlay）；foreshadow 仍
 * 是预留位（见 StructureOverlayToggles 注）。
 */
export type StructureDrillLevel = 'overview' | 'line' | 'scene';

export type StructureOverlayToggles = {
  validation: boolean;
  displacement: boolean;
  visibility: boolean;
  /**
   * dogfood R2 批次 B（SP-4）：emotion_curve 叠层（场景格底部情绪色条，EmotionOverlay）。
   * 08-26 结构页重构 批 1（R4 拍板）：默认 true——红条非异常是信息轨，默认可见
   * （pacing 维持默认关：整格铺色被判突兀，R5 改格顶细条后再议）。
   */
  emotion: boolean;
  /** dogfood R2 批次 B（SP-4）：pacing_curve 叠层（格子节奏热度底色，PacingOverlay）。 */
  pacing: boolean;
  // 「foreshadow」键刻意不加：伏笔叠层是预留位（promise_registry 无 UI 实体，独立
  // story 做）——工具栏渲染禁用态占位即可，slice 不存幽灵状态。
};

/**
 * CR-008 DRY: the canonical overlay-toggle default. Referenced by BOTH the
 * `registerProjectReset` callback AND the slice's initial state below so the
 * two can't drift (the previous literals `{validation:true,...}` were duplicated
 * and a future toggle added in one place but not the other would silently
 * desync the reset vs. initial view).
 *
 * dogfood R2: pacing default OFF (new overlays must not surprise the
 * author's established view); emotion flipped default ON by the 08-26
 * structure rebuild (see StructureOverlayToggles).
 */
const DEFAULT_OVERLAY_TOGGLES = {
  validation: true,
  displacement: true,
  visibility: true,
  emotion: true, // 08-26 结构页重构 批 1 拍板（见 StructureOverlayToggles 注）
  pacing: false,
} as const satisfies StructureOverlayToggles;

// ── 08-26 结构页重构 批 1（implement 1.3 / design §3.4 / prd R4）：画布缩放 ──
// CSS `zoom` 作用于 `.structure-canvas`（双骨架共同容器）——格/连线/叠层/minimap
// 同容器同比，几何不破（AC5）。纯函数落本 slice（layering：shared/store 不反向
// import features；StructurePage 自 features 向下取用）。zoom 属性下
// getBoundingClientRect 已是缩放后值——DOM 实测法天然兼容（design §3.4）。

/**
 * zoom 下限。原 prd R4 拍板 0.4（30 章规模下的可读性地板）；dogfood R2 #78（2026-08-28）
 * 下调至 0.05：真实工程重写后 160 章 × ~110px ≈ 17.6Kpx 画布，0.4 地板令「适宽」只到
 * ~40%（见 1/5 画布）名存实亡——「内容溢出即默认可见全貌」是用户拍板硬要求。5% 下
 * 每章 ≈ 5.5px 属天际线形态视图（色块可辨、文字不可读），细节经 ctrl+滚轮/minimap
 * 进入。单一地板三入口（步进/滚轮/适宽）共享，避免「适宽落到 8% 后按 − 跳回 40%」
 * 的断裂交互。批 9（规模适配）再议卷级折叠等精细尺度 UX。
 */
export const CANVAS_ZOOM_MIN = 0.05;
/** zoom 上限（prd R4：150%）。 */
export const CANVAS_ZOOM_MAX = 1.5;
/** 复位值（％钮点击 / 新会话）。 */
export const CANVAS_ZOOM_DEFAULT = 1;
/** 工具栏 −/＋ 步进。 */
export const CANVAS_ZOOM_STEP = 0.1;
/** ctrl+滚轮灵敏度：zoom × e^(−δ×s)（δ = 像素 deltaY，指数缩放正负对称）。 */
const WHEEL_ZOOM_SENSITIVITY = 0.002;

/** 钳进 [0.4, 1.5]；非有限值（NaN/Infinity——畸形事件/换算事故）回落默认 1。 */
export function clampCanvasZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return CANVAS_ZOOM_DEFAULT;
  return Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, zoom));
}

/** 工具栏步进（direction: 1 放大 / -1 缩小）。×100 取整消 fp 尘（1.1+0.1≠1.2）。 */
export function stepCanvasZoom(current: number, direction: 1 | -1): number {
  const stepped = Math.round((clampCanvasZoom(current) + direction * CANVAS_ZOOM_STEP) * 100) / 100;
  return clampCanvasZoom(stepped);
}

/** ctrl+滚轮：deltaY < 0（上滚）放大、> 0 缩小；两端钳制。 */
export function zoomFromWheel(current: number, deltaY: number): number {
  // CR 组1 edge-1：非有限 deltaY 统一「无滚动」——NaN 曾穿透到 exp（exp(NaN)=NaN）
  // 落进「非有限即爆上界」分支，zoom 直接跳 150% max；±Infinity 则沿旧分支瞬移
  // 到边界。畸形增量的正确语义是保持当前值。
  if (!Number.isFinite(deltaY)) return clampCanvasZoom(current);
  const next = clampCanvasZoom(current) * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);
  // 指数爆到 Infinity（极端 deltaY）按方向钳上界——不走 clampCanvasZoom 的
  // 「非有限回落 1」分支（那是给畸形入参的；current 已先归化，这里只剩爆量程）。
  return Number.isFinite(next) ? clampCanvasZoom(next) : CANVAS_ZOOM_MAX;
}

/**
 * 适宽（fit = viewportW / contentW）。入参用「屏坐标」宽（getBoundingClientRect——
 * zoom 后值）：contentScreen = natural × current → (viewport/contentScreen) × current
 * = viewport/natural，与当前 zoom 无关（换算自洽）。jsdom（双 0）量不到 → 保持
 * 当前值（no-op），不误动。
 */
export function fitCanvasZoom(
  currentZoom: number,
  viewportWidth: number,
  contentScreenWidth: number
): number {
  if (!(viewportWidth > 0) || !(contentScreenWidth > 0)) return clampCanvasZoom(currentZoom);
  return clampCanvasZoom((viewportWidth / contentScreenWidth) * clampCanvasZoom(currentZoom));
}

export type StructureSlice = {
  selectedNodeId: string | null;
  focusedLineId: string | null;
  drillLevel: StructureDrillLevel;
  overlayToggles: StructureOverlayToggles;
  /**
   * Story 3.3 线 A：从 chat PatchReviewPanel「在时间线修复」按钮跳转时，把 issue.targets
   * 传入让时间线聚焦/高亮对应场景格（复用 indexIssuesByTarget 既有映射）。null = 无聚焦。
   * project-scoped（聚焦态跨项目无意义），随 registerProjectReset 清空。
   */
  focusIssueTargets: SceneGraphIssue['targets'] | null;
  /**
   * dogfood R2 批次 D2（详设三节）：agent 落盘新增节点的高亮集（绿框脉冲 3s）。
   * StructurePage effect 监听 creativeFields.scene_graph + fieldMetadata.scene_graph——
   * source='agent' 时 diff 前后 node id 集写入；TTL 3s / 组件卸载清。source='user' 的
   * 手动新建不进此集（作者自己知道刚建了什么，脉冲是给「AI 悄悄落了新场景」指路的）。
   */
  highlightNodeIds: string[];
  /**
   * dogfood R2 批次 A（SP-3）：正在 inline 改名的线 id（泳道标签变输入框）。两副骨架的
   * 泳道标签共享该态——Enter 提交 / Esc 取消后置 null。null = 无改名态。
   */
  editingLineId: string | null;
  /**
   * dogfood R2 批次 A（SP-1）：建场景/右键改名后要求抽屉打开并聚焦标题输入框的一次性
   * 旗标（inline 编辑态语义）。SceneEditPopover 消费后自清。
   */
  drawerTitleFocus: boolean;
  /**
   * 08-26 结构页重构 批 1（R4）：画布缩放因子（0.4–1.5，钳制见 clampCanvasZoom），
   * 消费端 StructurePage 以 CSS `zoom` 施加于 `.structure-canvas`。会话级镜头偏好
   * （design §7）——刻意不入 registerProjectReset（切项目不重置，同窗口尺寸语义），
   * 也不入 localStorage persist。
   */
  canvasZoom: number;
  /**
   * 08-26 结构页重构 批 5（#43）：图例折叠态（true = 全展开；**默认折叠一行摘要**
   * ——9 记号常驻全展开被用户判「异常庞大」）。会话级 UI 偏好（同 canvasZoom 语义：
   * 切项目不重置、不入 localStorage persist——开合记忆限本会话）。
   */
  legendExpanded: boolean;

  setSelectedNodeId: (id: string | null) => void;
  setFocusedLineId: (id: string | null) => void;
  setDrillLevel: (level: StructureDrillLevel) => void;
  toggleOverlay: (key: keyof StructureOverlayToggles) => void;
  setOverlayToggles: (toggles: Partial<StructureOverlayToggles>) => void;
  setFocusIssueTargets: (targets: SceneGraphIssue['targets'] | null) => void;
  setHighlightNodeIds: (ids: string[]) => void;
  setEditingLineId: (id: string | null) => void;
  setDrawerTitleFocus: (focus: boolean) => void;
  /** 设画布缩放（内部经 clampCanvasZoom 钳制——任何调用路径都不会越界存储）。 */
  setCanvasZoom: (zoom: number) => void;
  /** 复位 100%（％钮）。 */
  resetCanvasZoom: () => void;
  /** 图例开合翻转（#43——组件不直写值，翻转是唯一手势）。 */
  toggleLegendExpanded: () => void;
};

export const createStructureSlice: StateCreator<StructureSlice, [], [], StructureSlice> = (set) => {
  // Drill/selection state is project-scoped — a selected scene from project A
  // must not persist into project B. Reset on switch (projectSubscription runs
  // every registered reset). Overlay toggles reset to defaults too so a new
  // project starts from the canonical view.
  registerProjectReset(() => {
    set({
      selectedNodeId: null,
      focusedLineId: null,
      drillLevel: 'overview',
      overlayToggles: { ...DEFAULT_OVERLAY_TOGGLES },
      focusIssueTargets: null,
      highlightNodeIds: [],
      editingLineId: null,
      drawerTitleFocus: false,
    });
  });

  return {
    selectedNodeId: null,
    focusedLineId: null,
    drillLevel: 'overview',
    overlayToggles: { ...DEFAULT_OVERLAY_TOGGLES },
    focusIssueTargets: null,
    highlightNodeIds: [],
    editingLineId: null,
    drawerTitleFocus: false,
    canvasZoom: CANVAS_ZOOM_DEFAULT,
    legendExpanded: false,

    setSelectedNodeId: (id) => set({ selectedNodeId: id }),
    setFocusedLineId: (id) => set({ focusedLineId: id }),
    setDrillLevel: (level) => set({ drillLevel: level }),
    toggleOverlay: (key) => set((s) => ({
      overlayToggles: { ...s.overlayToggles, [key]: !s.overlayToggles[key] },
    })),
    setOverlayToggles: (toggles) => set((s) => ({
      overlayToggles: { ...s.overlayToggles, ...toggles },
    })),
    setFocusIssueTargets: (targets) => set({ focusIssueTargets: targets }),
    setHighlightNodeIds: (ids) => set({ highlightNodeIds: ids }),
    setEditingLineId: (id) => set({ editingLineId: id }),
    setDrawerTitleFocus: (focus) => set({ drawerTitleFocus: focus }),
    setCanvasZoom: (zoom) => set({ canvasZoom: clampCanvasZoom(zoom) }),
    resetCanvasZoom: () => set({ canvasZoom: CANVAS_ZOOM_DEFAULT }),
    toggleLegendExpanded: () => set((s) => ({ legendExpanded: !s.legendExpanded })),
  };
};
