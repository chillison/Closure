import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { z } from 'zod';
import type { SceneGraph, SceneGraphIssue, SceneLine } from '@orison/shared-contracts';
import type { EmotionPoint } from '@orison/shared-contracts';
import { outlineV2Schema, validateSceneGraph } from '@orison/shared-contracts';
import { applyEpisodeActions, episodeOutlineSchema } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { isSceneGraphLike } from './layout';
import {
  TIMELINE_GEOMETRY,
  colIndexAtX,
  collectStackBands,
  computeColOffsets,
  computeRowOffsets,
  nominalChapterWidths,
  resolveEndpointPixel,
  stackBandsEqual,
  type PixelPoint,
  type StackBandTable,
} from './timelineGeometry';
import { deriveWorkbenchLayout, PENDING_COLUMN_SENTINEL, WORKBENCH_GEOMETRY, type CausalCardData, type WorkbenchLayout } from './workbenchLayout';
import { useGridGeometry, useGridColumnWidths } from './useGridGeometry';
import { lineHueIndex } from './linePalette';
import { SceneCard } from './SceneCard';
import { EdgeLayer, type ResolvedEdge } from './EdgeLayer';
import {
  indexIssuesByTarget,
  ValidationBadges,
  type StructureOverlayKey,
} from './ValidationOverlay';
import { resolveEmotionCurve } from './EmotionOverlay';
import { PacingOverlay, resolvePacingCurve } from './PacingOverlay';
import { volumeBandsFromEpisodes, type OutlinePhase } from './volumeBands';
import { VolumeBandStrip, VolumeBandTint } from './VolumeBand';
import { useTimelineEdit } from './useTimelineEdit';
import { useSceneGraphEdit } from './useSceneGraphEdit';
import {
  buildAddLineAction,
  buildInsertChapterActions,
  buildNewSceneAtChapterAction,
  buildRemoveLineActions,
  buildRemoveSceneActions,
  countScenesOnLine,
  edgesTouchingNode,
} from './sceneGraphEditModel';
import { TimelineContextMenu, type ContextMenuItem } from './TimelineContextMenu';
import { DeleteConfirmDialog } from '../model-settings/DeleteConfirmDialog';

type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

const OVERLAY_KEYS: ReadonlyArray<StructureOverlayKey> = ['validation', 'displacement', 'visibility'];
/** dogfood R2 批次 B（SP-4）：工具栏第二组——情绪/节奏叠层开关（默认 slice 态；
 * 批 8.4 起数据缺失时渲染禁用态）。as const 字面量收窄（curveDataAvailable 的键域
 * 随之只有 emotion/pacing 两键）。 */
const CURVE_OVERLAY_KEYS = ['emotion', 'pacing'] as const;

/** 线级 topology_role / displacement 菜单五值（closed enum——机械，纯代码 dispatch 用）。 */
const LINE_TOPOLOGY_ROLES = ['converging', 'parallel-worldview', 'offline', 'if-branch', 'side'] as const;
const LINE_DISPLACEMENTS = ['none', 'prologue', 'epilogue', 'flashback', 'distant'] as const;

/** role 值 → i18n 键（structure.role.*，与抽屉 role select 同源标签）。 */
const ROLE_LABEL_KEYS: Record<'normal' | 'core-anchor' | 'secondary-anchor' | 'fork-point', string> = {
  'normal': 'structure.role.normal',
  'core-anchor': 'structure.role.coreAnchor',
  'secondary-anchor': 'structure.role.secondaryAnchor',
  'fork-point': 'structure.role.forkPoint',
};

/**
 * Null-layout fallback (no graph → nothing to derive). Module-level so the
 * `useMemo` fallback returns a stable reference (no per-render allocation).
 */
const EMPTY_LAYOUT: WorkbenchLayout = {
  rows: [],
  cols: [],
  chapterTrackCount: 0,
  slots: new Map(),
  pendingByLine: new Map(),
  causalSlots: new Map(),
  causalPending: new Map(),
  primaryCellByNode: new Map(),
  edges: [],
};

/**
 * dogfood R2 批次 A（SP-1/SP-3）：右键菜单态（格上/线标签/列头·空白/线可见度目标输入）。
 * 「column」的 colValue 在批 7 后是**章 index**（章轴换轴——待编排列不产生 column 菜单）。
 */
type CtxMenuState =
  | { kind: 'scene'; nodeId: string; x: number; y: number }
  | { kind: 'line'; lineId: string; x: number; y: number }
  | { kind: 'column'; colValue: number; x: number; y: number }
  | { kind: 'line-visibility'; lineId: string; x: number; y: number };

/** SP-1/SP-3 删除确认目标（场景带边数文案 / 线带场景数文案——数据实，非预告）。 */
type DeleteTarget =
  | { kind: 'scene'; nodeId: string }
  | { kind: 'line'; lineId: string };

/**
 * Story 1.5 Phase D (design §1.1 / §2.1 / §3): the scene_graph's first real UI
 * consumer — the **causal skeleton**, now on the chapter axis.
 *
 * ── 08-26 结构页重构 批 7（design §11「同构锁步」定案 1-3）──
 * 因果骨架横轴从 storyTime 等距桶换为 **presentationOrder.chapter（章轴）**：
 *   - 列集合与工作台同一 episode 序（含 gap 章：诚实空轨——轨道存在、无列头）；
 *   - 派生单源 = `deriveWorkbenchLayout`（两区共用行序/章归属/pending 镜像/边锚定
 *     ——subgrid 锁步的前提就是数据面单源）；storyTime 分桶推导链退役删除；
 *   - 跨章 span 场景卡**只落起始章一格**——不复刻 chip 的 span 渲染（左直角右圆 +
 *     续到 marker），两区密度差即视图价值差（design §11 定案 1，注释钉住）；
 *   - dangling 场景镜像进末位**待编排虚拟列**（灰态卡，哨兵 colValue → 列 index =
 *     chapterTrackCount）；「倒叙」不再由位置跳跃表达，由既有钢蓝类 + 时序位移高亮
 *     承接；gap 章无数据即空，事件为诚实留白；
 *   - 新建/拖拽手势的列语义同步换轴：＋/右键建场景写 presentationOrder.chapter，
 *     drop 写章归属（useTimelineEdit.applyChapterDrop）；空白右键按实测列宽查表反
 *     推列（colIndexAtX——自适应列宽下的等距除法替身）；
 *   - 卷带：dogfood R2 #80 起章轴消费方走集映射（volumeBandsFromEpisodes——
 *     episode.phase_ref 直接定卷，与工作台/minimap 同一映射）；场景投币
 *     （deriveVolumeBands）退役至无集概念的 storyTime 轴消费方（现无——批 3/7
 *     换轴后本面板列轴即章轴）。
 *
 * Render scope:
 *   - Cells + edges + lane/axis labels + displacement / visibility visual encoding。
 *   - Validation badges via `indexIssuesByTarget`（validation toggle 总闸）。
 *   - Overlay toolbar / band strip / band tint 同批 2/3 架构（strip/tint 均与网格
 *     共享宿主轨道，x 定位走 colOffsets 查表；minimap 批 8.7 起升页级 chrome，
 *     自本组件摘出）。
 *
 * Placement strategy:
 *   - Cells: CSS Grid via subgrid tracks（`.narrative-timeline-grid` 类声明
 *     grid-template-columns: subgrid + grid-column: 1/-1——模板由 StructurePage 的
 *     宿主 inline style 单源产出，本组件不再自算列宽字符串）。碰撞堆 = 同格多卡
 *     纵向平铺（cell-stack flex-column），行高随最高卡 auto。
 *   - Edges: SVG overlay sized to the grid; endpoints resolved via 双查表
 *     （rowOffsets + colOffsets——jsdom 回退名义表，确定性可测）。
 *
 * Defensive: nodes-without-lines renders rulers above an empty body；
 * layout===null（graph 缺失的独立挂载测试形态）→ EMPTY_LAYOUT 兜底零渲染面。
 *
 * ── dogfood R2 批次 A/B 遗产（保留的手势/叠层/导航语义）──
 * 场景建/删/右键菜单/线管理/D2 高亮/focusIssueTargets scrollIntoView、情绪卡内条/
 * 节奏细条叠层、卷带 strip+tint —— 逐一原样保留；仅列值语义换轴（minimap seek
 * 批 8.7 起随组件升页级 chrome 移出）。
 */
export function NarrativeTimelinePanel() {
  const selected = useAppStore(
    useShallow((s) => ({
      // CR-001: shape-guard the store cast — partial/malformed scene_graph coerces
      // to undefined here so the derivation never receives a graph it can't map over.
      sceneGraph: isSceneGraphLike(s.creativeFields.scene_graph) ? s.creativeFields.scene_graph as SceneGraph : undefined,
      // 卷带 + 两区单源派生的 episode 数据源（unknown 原样取引用，derive 内防御）。
      rawEpisodes: s.creativeFields.episode_outlines as EpisodeOutline[] | undefined,
      overlayToggles: s.overlayToggles,
      toggleOverlay: s.toggleOverlay,
      setOverlayToggles: s.setOverlayToggles,
      resolvedLocale: s.resolvedLocale,
      selectedNodeId: s.selectedNodeId,
      setSelectedNodeId: s.setSelectedNodeId,
      focusedLineId: s.focusedLineId,
      setFocusedLineId: s.setFocusedLineId,
      // Story 3.3 线 A：从 chat「在时间线修复」跳转传入的 issue targets（聚焦定位）。
      focusIssueTargets: s.focusIssueTargets,
      setFocusIssueTargets: s.setFocusIssueTargets,
      // dogfood R2 批次 D2：agent 落盘新增节点高亮集（✦ 角标脉冲）。
      highlightNodeIds: s.highlightNodeIds,
      // dogfood R2 批次 A（SP-3）：线改名 inline 态。
      editingLineId: s.editingLineId,
      setEditingLineId: s.setEditingLineId,
      // dogfood R2 批次 A（SP-1）：建场景/右键改名 → 抽屉聚焦标题的一次性旗标。
      setDrawerTitleFocus: s.setDrawerTitleFocus,
      // dogfood R2 批次 B（SP-4/SP-5）：曲线叠层 + 卷带数据源（unknown 原样取引用，
      // memo 内 safeParse 归一——useShallow 只比引用，patch 落盘换引用才重算）。
      rawEmotionCurve: s.creativeFields.emotion_curve,
      rawPacingCurve: s.creativeFields.pacing_curve,
      rawOutline: s.creativeFields.outline,
      // CR 组 5：空白右键的屏坐标 → 自然量纲归一因子（colIndexAtX 查表是自然 px）。
      canvasZoom: s.canvasZoom,
    }))
  );
  const sceneGraph = selected.sceneGraph;
  const { overlayToggles, toggleOverlay, setOverlayToggles, resolvedLocale, selectedNodeId, setSelectedNodeId, focusedLineId, setFocusedLineId, focusIssueTargets, setFocusIssueTargets, highlightNodeIds, editingLineId, setEditingLineId, setDrawerTitleFocus, canvasZoom } = selected;
  const { t } = useI18n(resolvedLocale);

  // Phase E3-drag: 因果 drags 写章归属（08-26 批 7 换轴——applyChapterDrop）。
  const drag = useTimelineEdit();

  // ── SP-1/SP-3 场景/线生命周期（写通道：useSceneGraphEdit → 同一投影器）──
  const { applyActions } = useSceneGraphEdit();
  const [menu, setMenu] = useState<CtxMenuState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [visibilityTarget, setVisibilityTarget] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const layout = useMemo<WorkbenchLayout>(
    () => (sceneGraph ? deriveWorkbenchLayout(sceneGraph, selected.rawEpisodes) : EMPTY_LAYOUT),
    [sceneGraph, selected.rawEpisodes]
  );
  const { rows, cols, chapterTrackCount, causalSlots, causalPending, edges } = layout;

  // 真实存在的章 index 集（CR 组 2a gap 守卫）：gap 章轨不接 drop、空白菜单不在
  // gap 列开——写 gap 章 =「归入此章」承诺被解析序静默改判成 pending，不可兑现。
  const episodeIndexSet = useMemo(() => new Set(cols.map((c) => c.index)), [cols]);

  // ── SP-1 新建场景：add_scene（id 自动 / 章归属=列 / pos 追加到章尾 /
  //    storyTime=全图 max+1 中性默认 / 默认线=聚焦线∥主线）→ 建后开浮层聚焦标题。
  //    R11：action 构造收口到 buildNewSceneAtChapterAction 单源——与工作台槽位新建
  //    钮完全同源（R8/R11 的「两区同语义」由构造层保证）。──
  const addSceneAtColumn = (chapterIdx: number) => {
    if (!sceneGraph) return;
    const action = buildNewSceneAtChapterAction(sceneGraph, chapterIdx, {
      episodes: selected.rawEpisodes,
      focusedLineId,
    });
    applyActions([action]);
    // 落选前置校验（CR3 edge ghost drawer）：投影器拒收（图缺/形状坏/写通道 no-op）时
    // 节点未落图——不选 ghost、不开抽屉（与 ChapterWorkbench.addSceneInChapter 同款）。
    const raw = useAppStore.getState().creativeFields.scene_graph;
    if (!isSceneGraphLike(raw) || !raw.nodes.some((n) => n.id === action.scene.id)) return;
    setSelectedNodeId(action.scene.id);
    setDrawerTitleFocus(true);
  };

  // ── R11 批3：在 index k 左侧插入新章（两区列头同口径；episode 章表 + 场景裸章号
  //    双字段投影——spans 按 episodeId 引用天然安全漂移，构造单源见
  //    buildInsertChapterActions）。章表先行（结构）、场景裸章号随后（同章号空间的
  //    依赖面）；sceneActions 空 = 无位移场景 → 跳过 scene_graph 写（引用级 no-op：
  //    无变更字段不 bump 版本/不进 undo 栈）。──
  const insertChapterAt = (chapterIdx: number) => {
    const { creativeFields: raw, updateField } = useAppStore.getState();
    if (!isSceneGraphLike(raw.scene_graph) || !Array.isArray(raw.episode_outlines)) return;
    const plan = buildInsertChapterActions(
      raw.scene_graph,
      raw.episode_outlines as EpisodeOutline[],
      chapterIdx,
      t('structure.ctx.insertChapterTitle')
    );
    if (!plan) return;
    updateField(
      'episode_outlines',
      applyEpisodeActions(raw.episode_outlines as EpisodeOutline[], plan.episodeActions)
    );
    if (plan.sceneActions.length > 0) applyActions(plan.sceneActions);
  };

  // ── SP-3 新增线：add_line（默认名 → 立即 inline 改名态）。causal 侧入口。──
  const addLine = () => {
    if (!sceneGraph) return;
    const action = buildAddLineAction(sceneGraph, t('structure.line.defaultName'));
    applyActions([action]);
    if (action.op === 'add_line') setEditingLineId(action.line.id);
  };

  const commitLineRename = (lineId: string, name: string) => {
    setEditingLineId(null);
    const trimmed = name.trim();
    if (!trimmed) return; // schema name.min(1)——空名按取消处理
    // CR-11 no-op 写守卫：同值提交先比值再写——免版本 bump + undo 入栈 + source 翻转。
    if (trimmed === sceneGraph?.lines.find((l) => l.id === lineId)?.name) return;
    applyActions([{ op: 'update_line', line: { id: lineId, name: trimmed } }]);
  };

  const copyNodeId = (nodeId: string) => {
    // jsdom / 无剪贴板权限环境无 navigator.clipboard——optional chain 静默降级。
    void navigator.clipboard?.writeText(nodeId);
  };

  // ── 右键入口（SP-1/SP-3）：stopPropagation 防冒泡到 grid 空白菜单 + 防浏览器默认。──
  const openSceneMenu = (nodeId: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: 'scene', nodeId, x: e.clientX, y: e.clientY });
  };
  const openLineMenu = (lineId: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: 'line', lineId, x: e.clientX, y: e.clientY });
  };
  /** 列头/格上的右键菜单。colValue = 章 index（待编排列无菜单入口——不可建场景）。 */
  const openColumnMenu = (colValue: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: 'column', colValue, x: e.clientX, y: e.clientY });
  };
  // 空白右键（E2 取证整改「canvas 内任意空白 contextmenu 必有菜单」）：光标 x 经
  // 实测列宽查表反推章 index（colIndexAtX 二分）。getBoundingClientRect 已含滚动位
  // 移与 zoom——屏 px ÷ canvasZoom 归一到自然量纲再进查表（CR 组 5 惯例）。
  //
  // R8/R11 失效根因修复：旧版两道静默 return（e.target 守卫把**每个格栈内部**都挡成
  // 死区——栈包裹层恒渲染，真实光标几乎永远踩不到裸网格面；gap/pending 又直接拒绝）
  // 叠出「右键偶发零响应」。现改为：内层语义件（卡/线标签/列头）自带 stopPropagation
  // 不会被穿透；其余一切空白（含格栈间隙、gap 轨、待编排带）一律弹菜单——gap/pending
  // 的「在此章新建」项**置灰**而非消失（E2 整改方向：「非法目标项置灰而非消失」，
  // 写通道不承诺不可兑现的归章）。
  const openBlankMenu = (e: MouseEvent<HTMLElement>) => {
    if (chapterTrackCount === 0 || e.defaultPrevented) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const zoomSafe = canvasZoom > 0 ? canvasZoom : 1;
    const local =
      (e.clientX - rect.left) / zoomSafe - TIMELINE_GEOMETRY.laneLabelWidth;
    // 首列左侧（local<0：泳道标签带/角格——CR3 edge）不锚菜单：colIndexAtX 的二分
    // 会钳回章 0，在标签带右键弹出「在第 1 章新建」是错位承诺。早退交还浏览器默认
    // （preventDefault 移到判定后——无菜单时不吞原生菜单）。
    if (local < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = colIndexAtX(effectiveColOffsets, local);
    setMenu({ kind: 'column', colValue: idx, x: e.clientX, y: e.clientY });
  };

  // ── 菜单 items 构造（i18n 标签；动作 = ops 写通道）──
  const buildMenuItems = (m: CtxMenuState): ContextMenuItem[] => {
    if (m.kind === 'scene') {
      const node = sceneGraph?.nodes.find((n) => n.id === m.nodeId);
      if (!node) return [];
      const edgeCount = sceneGraph ? edgesTouchingNode(sceneGraph, node.id).length : 0;
      return [
        {
          kind: 'action', key: 'rename',
          label: t('structure.ctx.rename'),
          onPick: () => {
            setSelectedNodeId(node.id);
            setDrawerTitleFocus(true);
          },
        },
        { kind: 'separator', key: 'sep-role' },
        ...(['normal', 'core-anchor', 'secondary-anchor', 'fork-point'] as const).map((role) => ({
          kind: 'action' as const,
          key: `role-${role}`,
          label: t('structure.ctx.setRole', { role: t(ROLE_LABEL_KEYS[role]) }),
          // CR-11 no-op 写守卫：同值直选不写（免版本 bump + undo 入栈 + source 翻转）。
          onPick: () => {
            if (node.role !== role) applyActions([{ op: 'update_scene', scene: { id: node.id, role } }]);
          },
        })),
        { kind: 'separator', key: 'sep-utils' },
        { kind: 'action', key: 'copy-id', label: t('structure.ctx.copyId'), onPick: () => copyNodeId(node.id) },
        {
          kind: 'action', key: 'delete', danger: true,
          label: t('structure.ctx.deleteScene'),
          hint: edgeCount > 0 ? t('structure.ctx.deleteSceneHint', { n: edgeCount }) : undefined,
          onPick: () => setDeleteTarget({ kind: 'scene', nodeId: node.id }),
        },
      ];
    }
    if (m.kind === 'line') {
      const line = sceneGraph?.lines.find((l) => l.id === m.lineId);
      if (!line) return [];
      const sceneCount = sceneGraph ? countScenesOnLine(sceneGraph, line.id) : 0;
      return [
        { kind: 'action', key: 'rename', label: t('structure.ctx.renameLine'), onPick: () => setEditingLineId(line.id) },
        { kind: 'separator', key: 'sep-topo' },
        ...LINE_TOPOLOGY_ROLES.map((role) => ({
          kind: 'action' as const,
          key: `topology-${role}`,
          label: t('structure.ctx.setTopology', { role: t(`structure.lineTopology.${role}`) }),
          // CR-11 no-op 写守卫：同值直选不写。
          onPick: () => {
            if (line.topology_role !== role) {
              applyActions([{ op: 'update_line', line: { id: line.id, topology_role: role } }]);
            }
          },
        })),
        { kind: 'separator', key: 'sep-disp' },
        ...LINE_DISPLACEMENTS.map((d) => ({
          kind: 'action' as const,
          key: `disp-${d}`,
          label: t('structure.ctx.setDisplacement', { d: t(`structure.lineDisplacement.${d}`) }),
          // CR-11 no-op 写守卫：同值直选不写。
          onPick: () => {
            if ((line.displacement ?? 'none') !== d) {
              applyActions([{ op: 'update_line', line: { id: line.id, displacement: d } }]);
            }
          },
        })),
        { kind: 'separator', key: 'sep-vis' },
        {
          kind: 'action', key: 'vis-open',
          label: t('structure.ctx.setVisibilityOpen'),
          onPick: () => applyActions([{ op: 'update_line', line: { id: line.id, visibility: { status: 'open' } } }]),
        },
        {
          kind: 'action', key: 'vis-hidden',
          label: t('structure.ctx.setVisibilityHidden'),
          onPick: () => {
            setVisibilityTarget('');
            setMenu({ kind: 'line-visibility', lineId: line.id, x: m.x, y: m.y });
          },
        },
        { kind: 'separator', key: 'sep-del' },
        {
          kind: 'action', key: 'delete', danger: true,
          label: t('structure.ctx.deleteLine'),
          hint: sceneCount > 0 ? t('structure.ctx.deleteLineHint', { m: sceneCount }) : undefined,
          onPick: () => setDeleteTarget({ kind: 'line', lineId: line.id }),
        },
      ];
    }
    // column：在此章新建场景 + 在左侧插入新章（R11 批3；章轴语义——章号人读 =
    // index+1）。gap 章 / 待编排带命中时两项**置灰**（R8：非法目标项置灰而非菜单
    // 消失；写通道不写不可兑现的归章——插入锚定真实列头，gap/pending 无「左侧」语义）。
    if (m.kind === 'column') {
      const droppableCol = episodeIndexSet.has(m.colValue);
      return [
        {
          kind: 'action', key: 'add-scene',
          label: droppableCol
            ? t('structure.ctx.addSceneAt', { col: m.colValue + 1 })
            : t('structure.ctx.addSceneBlocked'),
          disabled: !droppableCol,
          onPick: () => {
            if (droppableCol) addSceneAtColumn(m.colValue);
          },
        },
        {
          kind: 'action', key: 'insert-chapter',
          label: droppableCol
            ? t('structure.ctx.insertChapterLeft', { n: m.colValue + 1 })
            : t('structure.ctx.insertChapterBlocked'),
          disabled: !droppableCol,
          onPick: () => {
            if (droppableCol) insertChapterAt(m.colValue);
          },
        },
      ];
    }
    return [];
  };

  // ── 删除确认文案（数据实：投影器不级联 → action 数组补齐——「断开/移除归属」即最终行为）──
  const deleteDesc = (() => {
    if (!deleteTarget || !sceneGraph) return '';
    if (deleteTarget.kind === 'scene') {
      const n = edgesTouchingNode(sceneGraph, deleteTarget.nodeId).length;
      return n > 0
        ? t('structure.ctx.deleteSceneConfirm', { n })
        : t('structure.ctx.deleteSceneConfirmPlain');
    }
    const m = countScenesOnLine(sceneGraph, deleteTarget.lineId);
    return m > 0
      ? t('structure.ctx.deleteLineConfirm', { m })
      : t('structure.ctx.deleteLineConfirmPlain');
  })();

  const confirmDelete = () => {
    if (!deleteTarget || !sceneGraph) {
      setDeleteTarget(null);
      return;
    }
    if (deleteTarget.kind === 'scene') {
      applyActions(buildRemoveSceneActions(sceneGraph, deleteTarget.nodeId));
      if (selectedNodeId === deleteTarget.nodeId) setSelectedNodeId(null);
    } else {
      applyActions(buildRemoveLineActions(sceneGraph, deleteTarget.lineId));
      if (focusedLineId === deleteTarget.lineId) setFocusedLineId(null);
      if (editingLineId === deleteTarget.lineId) setEditingLineId(null);
    }
    setDeleteTarget(null);
  };

  // ── validation issues → per-target lookup (Phase D-overlay D4) ──
  // Toggle off → memo 返回空查表，每张卡/每条边零徽标。整体开关的单闸。
  const issueLookup = useMemo(() => {
    if (!sceneGraph || !overlayToggles.validation) {
      return { node: new Map(), edge: new Map(), line: new Map() };
    }
    return indexIssuesByTarget(validateSceneGraph(sceneGraph));
  }, [sceneGraph, overlayToggles.validation]);

  // ── dogfood R2 批次 B（SP-4/SP-5）：曲线叠层 + 卷带数据归一 ──
  // safeParse 静默降级（残缺数据 → undefined → 对应叠层不渲染），同 issueLookup
  // 的「toggle 即总闸」模式。
  const emotionCurve = useMemo(
    () => resolveEmotionCurve(selected.rawEmotionCurve),
    [selected.rawEmotionCurve]
  );
  const pacingCurve = useMemo(
    () => resolvePacingCurve(selected.rawPacingCurve),
    [selected.rawPacingCurve]
  );
  // ── 批 8（implement 8.4）：叠层开关禁用态（诚实零反馈胜过假开关）──
  // 数据缺失 = 解析失败（undefined）**或** points 为空（schema default [] 合法但
  // 视觉恒空）。此时开关渲染为 disabled + title 提示；数据存在则照常可点。草稿
  // 项目勾选无反应的「假坏死」（批 8 目检定谳：接线完好、数据缺层）就此消除。
  const curveDataAvailable: Record<(typeof CURVE_OVERLAY_KEYS)[number], boolean> = {
    emotion: !!emotionCurve && emotionCurve.points.length > 0,
    pacing: !!pacingCurve && pacingCurve.points.length > 0,
  };
  // outline（store key 'outline' → 文档键 outline_v2）：只取 phases（卷带需要
  // 卷名 + tie-break 序）。无 outline / 无 phases → 不渲染卷带（整条灰带是噪音）。
  const outlinePhases = useMemo<OutlinePhase[]>(() => {
    const parsed = outlineV2Schema.safeParse(selected.rawOutline);
    return parsed.success ? parsed.data.phases : [];
  }, [selected.rawOutline]);

  // ── dogfood R2 #80：卷带切集映射——章轴权威源 = episode.phase_ref（批 3/7 换轴
  // 后本面板列轴即章轴，与工作台/minimap 同一映射，subgrid 锁步下两区卷带不再有
  // 第二种口径）。旧伪 cell 投币推导随之退役（deriveVolumeBands 保留给 storyTime
  // 轴）。无 phases → 不渲染卷带（整条灰带是噪音——口径不变）。
  const volumeBands = useMemo(
    () => (outlinePhases.length === 0 ? [] : volumeBandsFromEpisodes(selected.rawEpisodes ?? [], outlinePhases)),
    [selected.rawEpisodes, outlinePhases]
  );

  const emotionByNode = useMemo(() => {
    // 08-26 批 2：情绪底条迁入 SceneCard（卡内渲染）——本 map 是数据面（toggle
    // 即总闸：关 → undefined → 卡不渲染底条）。
    if (!overlayToggles.emotion || !emotionCurve) return undefined;
    const m = new Map<string, EmotionPoint>();
    for (const p of emotionCurve.points) m.set(p.refId, p);
    return m;
  }, [overlayToggles.emotion, emotionCurve]);

  const intensityByNode = useMemo(() => {
    if (!overlayToggles.pacing || !pacingCurve) return undefined;
    const m = new Map<string, number>();
    for (const p of pacingCurve.points) m.set(p.refId, p.intensity);
    return m;
  }, [overlayToggles.pacing, pacingCurve]);

  // Story 3.3 线 A：从 chat「在时间线修复」跳转定位——focusIssueTargets 非空时，聚焦首个 target
  // （node→selectedNodeId / line→focusedLineId，复用既有高亮机制）+ 确保 validation overlay 开启（让
  // issue badge 可见）。定位后清空 focusIssueTargets（一次性，非持续聚焦）。
  // dogfood R2 批次 D2：命中 node/line 时 scrollIntoView(nearest)。jsdom 下 setup.ts
  // stub 为 no-op（测试以 spy 断言）。
  useEffect(() => {
    if (!focusIssueTargets || focusIssueTargets.length === 0) return;
    if (!overlayToggles.validation) {
      setOverlayToggles({ validation: true });
    }
    const firstNode = focusIssueTargets.find((tgt) => tgt.kind === 'node');
    const firstLine = focusIssueTargets.find((tgt) => tgt.kind === 'line');
    if (firstNode) {
      setSelectedNodeId(firstNode.id);
      rootRef.current
        ?.querySelector(`[data-node-id="${firstNode.id}"]`)
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } else if (firstLine) {
      setFocusedLineId(firstLine.id);
      rootRef.current
        ?.querySelector(`[data-lane-id="${firstLine.id}"]`)
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    // edge target：无独立聚焦态，仅靠 overlay badge 可见（已上方确保开）。
    setFocusIssueTargets(null);
  }, [focusIssueTargets, overlayToggles.validation, setOverlayToggles, setSelectedNodeId, setFocusedLineId, setFocusIssueTargets]);

  // ── index maps: row/col positions + line attrs ──
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.lineId, i));
    return m;
  }, [rows]);

  // 章轴 colIndex（批 7）：稠密轨道 identity（含 gap——chapterTrackCount 覆盖）+
  // 待编排哨兵 → 末位轨道 index。
  const colIndex = useMemo(() => {
    const m = new Map<number, number>();
    for (let c = 0; c < chapterTrackCount; c++) m.set(c, c);
    m.set(PENDING_COLUMN_SENTINEL, chapterTrackCount);
    return m;
  }, [chapterTrackCount]);

  const lineById = useMemo(() => {
    const m = new Map<string, SceneLine>();
    sceneGraph?.lines.forEach((l) => m.set(l.id, l));
    return m;
  }, [sceneGraph?.lines]);

  // ── group cards by grid position (lineId, colValue) for the stack render ──
  // （derived buckets 已按故事时序排序 + 顺序 subIndex——渲染直接平铺数组即可。）
  const cellStacks = causalSlots;
  /** 待编排哨兵桶键（与派生单源同形：`${lineId}|${PENDING_COLUMN_SENTINEL}`）。 */
  const pendingBucketKey = (lineId: string) => `${lineId}|${PENDING_COLUMN_SENTINEL}`;

  // 节奏叠层的卡盒集合（已编排 + 待编排镜像；CR 组 3a：大数组 memo 化，不再每次
  // 渲染重展开。CR 组 2a parity：待编排卡此前缺席热度条——情绪条却显示的不对称）。
  const pacingCells = useMemo<CausalCardData[]>(
    () => [...cellStacks.values(), ...causalPending.values()].flat(),
    [cellStacks, causalPending]
  );

  const stackSizeAt = (lineId: string, colValue: number): number =>
    cellStacks.get(`${lineId}|${colValue}`)?.length
    ?? causalPending.get(pendingBucketKey(lineId))?.length
    ?? 1;

  // ── 泳道场景数（已编排 + 待编排——与工作台泳道同口径，P3 一致性对拍锚）。──
  const sceneCountByLine = useMemo(() => {
    const m = new Map<string, number>();
    for (const arr of cellStacks.values()) for (const c of arr) m.set(c.lineId, (m.get(c.lineId) ?? 0) + 1);
    for (const arr of causalPending.values()) for (const c of arr) m.set(c.lineId, (m.get(c.lineId) ?? 0) + 1);
    return m;
  }, [cellStacks, causalPending]);

  // ── 行高实测（批 2 方案沿用）：gridTemplateRows auto + 查表回退 rowHeight。 ──
  const gridRef = useRef<HTMLDivElement>(null);
  const { rowHeights } = useGridGeometry(gridRef, rows.length);
  const effectiveRowHeights = useMemo(
    () => rowHeights.map((h) => (h > 0 ? h : TIMELINE_GEOMETRY.rowHeight)),
    [rowHeights]
  );
  const rowOffsets = useMemo(
    () => computeRowOffsets(effectiveRowHeights),
    [effectiveRowHeights]
  );

  // ── 列宽实测（批 7）：章轴自适应 → 按 data-grid-col 标记索引回填；jsdom 全 0
  //    → 名义表兜底（nominalChapterWidths——真实模板逐列镜像）。 ├──
  const gridColumnCount = chapterTrackCount + 1; // + 待编排虚拟列
  const { colWidths } = useGridColumnWidths(gridRef, gridColumnCount);
  // every（CR 组 2a）：部分列实测为 0 时不能拿「有值」当真——零宽列会折叠错位，
  // 全列就绪才采实测，否则整表回退名义。
  const effectiveColWidths = useMemo(
    () =>
      (colWidths.length > 0 && colWidths.every((w) => w > 0)
        ? colWidths
        : nominalChapterWidths(chapterTrackCount)),
    [colWidths, chapterTrackCount]
  );
  const effectiveColOffsets = useMemo(() => computeColOffsets(effectiveColWidths), [effectiveColWidths]);

  // ── CR 组1 #119（裁决 1A）：cell-stack 实测纵带（边锚点 y 分位 / 节奏细条贴真
  //    实卡缘的数据源）。布局期同步量测（getBoundingClientRect÷zoom——批 C 同款
  //    归一）；重测触发键覆盖内容/行高/列宽/缩放四类几何变化，jsdom 全零矩形 →
  //    空表 → 消费函数回退查表公式（既有锁测试口径不变）。 ──
  const [stackBands, setStackBands] = useState<StackBandTable>(() => new Map());
  const bandMeasureKey = useMemo(
    () =>
      [
        rows.length,
        chapterTrackCount,
        canvasZoom,
        pacingCells.map((c) => `${c.nodeId}@${c.lineId}@${c.colValue}@${c.subIndex}`).join(','),
        effectiveRowHeights.join(','),
        effectiveColWidths.join(','),
      ].join('|'),
    [rows.length, chapterTrackCount, canvasZoom, pacingCells, effectiveRowHeights, effectiveColWidths]
  );
  useLayoutEffect(() => {
    const next = collectStackBands(gridRef.current, canvasZoom);
    // 恒等表保持引用稳定（换新 Map 会白白多一轮渲染）。
    setStackBands((prev) => (stackBandsEqual(prev, next) ? prev : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 触发键为几何签名，处理体内现读最新 refs
  }, [bandMeasureKey]);

  // ── resolve edges to pixel coords (skip any endpoint whose line/col vanished) ──
  // 批 7：x 查表（colOffsets——章列自适应）、y 查表（rowOffsets）；线色 = from 端线相。
  // CR 组1 #123：查表越界（右缘缺项）返回 null——与悬空边同策略整边跳过，不再
  // 合成 0 尺寸假出点。CR 组1 #119：stackBands 有效时 y 取真实卡带垂直中心。
  const resolvedEdges = useMemo<ResolvedEdge[]>(() => {
    const resolve = (ep: { lineId: string; colValue: number; subIndex: number }): PixelPoint | null => {
      const rIdx = rowIndex.get(ep.lineId);
      const cIdx = colIndex.get(ep.colValue);
      if (rIdx === undefined || cIdx === undefined) return null;
      return resolveEndpointPixel(
        ep,
        {
          rowIndex: rIdx,
          colIndex: cIdx,
          stackSize: stackSizeAt(ep.lineId, ep.colValue),
          rowOffsets,
          colOffsets: effectiveColOffsets,
        },
        stackBands
      );
    };
    const out: ResolvedEdge[] = [];
    for (const edge of edges) {
      // T7（发现批4·深夜二轮视觉终审）：任一端点为待编排场景（哨兵列）的因果边
      // **零渲染**——T4「指向待编排列的线无论如何都不显示」的用户拍板对锚弧族的
      // 延伸（真机坐标换算证实 T4 后残留线＝汇入待编排列的弧族；关联线族已滤零，
      // 剩余汇入者即因果边）。无选中豁免——选中态救不出 pending 方向的线。数据面
      // （layout.edges）不动：渲染滤除不影响派生/校验（dangling-edge-endpoint 只旗
      // 「端点节点不存在」，pending 场景节点在场，无角标随边消失）。
      if (
        edge.from.colValue === PENDING_COLUMN_SENTINEL
        || edge.to.colValue === PENDING_COLUMN_SENTINEL
      ) {
        continue;
      }
      const from = resolve(edge.from);
      const to = resolve(edge.to);
      if (!from || !to) continue; // dangling endpoint → skip (validateSceneGraph flags it)
      out.push({
        edgeId: edge.edgeId,
        type: edge.type,
        from,
        to,
        lineId: edge.from.lineId,
        hueIndex: lineHueIndex(edge.from.lineId),
        // #75/W3 收口：目标线色相——异线因果边（红卡↔绿卡）喂给 EdgeLayer 的
        // resolveAssocPaint 渐变轴；同线时与 hueIndex 相等→纯色零开销退化。
        toHueIndex: lineHueIndex(edge.to.lineId),
      });
    }
    return out;
  }, [edges, rowIndex, colIndex, cellStacks, causalPending, rowOffsets, effectiveColOffsets, stackBands]);

  const { headerHeight } = TIMELINE_GEOMETRY;
  // 行高自适应：体高 = 表头 + 实测行高累计（回退态 = 等高常量公式）。
  const gridHeight =
    headerHeight
    + (rowOffsets[rows.length] ?? rows.length * TIMELINE_GEOMETRY.rowHeight);
  // SVG 坐标空间总宽 = laneLabel 基准 + 列偏移终点（与端点 x 数学同一基准——svg
  // viewBox 与坐标 1:1，EdgeLayer 定位不漂）。
  const gridWidth =
    TIMELINE_GEOMETRY.laneLabelWidth + (effectiveColOffsets[gridColumnCount] ?? 0);

  // 行模板：表头 + 泳道 auto（卡高自适应）。零行守卫（CR 组 2a）：repeat(0, auto)
  // 是非法模板构造、整条静默失效——无 rows 时只落表头行。**列模板不自算**——subgrid
  // 接轨宿主（design §11 定案 2），本组件零 template 字符串。
  const laneRowsTemplate = rows.length > 0 ? ` repeat(${rows.length}, auto)` : '';
  const gridTemplateRows = `${headerHeight}px${laneRowsTemplate}`;
  // 待编排虚拟列的 grid column 号（1-based；章轨道之后）。
  const pendingColumn = chapterTrackCount + 2;

  const showDisplacement = overlayToggles.displacement;
  const showVisibility = overlayToggles.visibility;

  return (
    <div
      ref={rootRef}
      className="narrative-timeline narrative-timeline--causal"
      aria-label={t('structure.skeleton.causal')}
    >
      {/* Overlay toggle toolbar (Phase D-overlay D5 + dogfood R2 SP-4 重组)：
          第一组 = 1.5 期三开关（校验/位移/可见度）；分隔线后第二组 = 情绪/节奏；
          尾随「伏笔」禁用占位。 */}
      <div className="narrative-timeline-toolbar" role="group" aria-label={t('structure.overlay.title')}>
        {OVERLAY_KEYS.map((key) => (
          <label key={key} className="narrative-timeline-toolbar-toggle">
            <input
              type="checkbox"
              checked={overlayToggles[key]}
              onChange={() => toggleOverlay(key)}
              data-overlay-key={key}
            />
            <span>{t(`structure.overlay.${key}`)}</span>
          </label>
        ))}
        <span className="narrative-timeline-toolbar-sep" aria-hidden="true" />
        {CURVE_OVERLAY_KEYS.map((key) => (
          // 批 8（implement 8.4）：数据缺失 → disabled + title（structure.overlay.*Missing，
          // 双 locale）；数据存在 → 照常可点。checked 保留 slice 态——数据后续补上时
          // 开关以用户上次的偏好直接生效。
          curveDataAvailable[key] ? (
            <label key={key} className="narrative-timeline-toolbar-toggle">
              <input
                type="checkbox"
                checked={overlayToggles[key]}
                onChange={() => toggleOverlay(key)}
                data-overlay-key={key}
              />
              <span>{t(`structure.overlay.${key}`)}</span>
            </label>
          ) : (
            <label
              key={key}
              className="narrative-timeline-toolbar-toggle narrative-timeline-toolbar-toggle--disabled"
              title={t(`structure.overlay.${key}Missing`)}
            >
              <input
                type="checkbox"
                checked={overlayToggles[key]}
                disabled
                data-overlay-key={key}
              />
              <span>{t(`structure.overlay.${key}`)}</span>
            </label>
          )
        ))}
        <label
          className="narrative-timeline-toolbar-toggle narrative-timeline-toolbar-toggle--disabled"
          title={t('structure.overlay.foreshadowHint')}
        >
          <input type="checkbox" checked={false} disabled data-overlay-key="foreshadow" />
          <span>{t('structure.overlay.foreshadow')}</span>
        </label>
      </div>

      {/* 批 8（implement 8.7）：minimap 升格页级恒驻（StructurePage chrome 带位，
          sticky top+left 双轴）——原面板内占位行随之回收。本组件不再挂 minimap；
          其数据面在 StructurePage 走同一派生单源（deriveWorkbenchLayout）。 */}

      <div className="narrative-timeline-scroll">
        {/* SP-5 卷背景带第二表头行：批 7 起 subgrid 接轨宿主（CSS 类声明），组件
            只管 band 格跨列——与两区内网格同解一次轨道宽度。高度恒占最小 22px。 */}
        <VolumeBandStrip
          bands={volumeBands}
          phases={outlinePhases}
          unassignedText={t('structure.volumeBand.unassigned')}
          cornerLabel={t('structure.volumeBand.label')}
        />
        <div
          ref={gridRef}
          className={`narrative-timeline-grid${focusedLineId !== null ? ' narrative-timeline-grid--has-focus' : ''}`}
          style={{ gridTemplateColumns: 'subgrid', gridColumn: '1 / -1', gridTemplateRows }}
          onContextMenu={openBlankMenu}
        >
          {/* Header row: corner + chapter rulers（实际存在的 episode——gapped index
              不造头，空轨诚实留白）。批 7：drop/menu/＋ 的列语义 = 章归属；
              data-grid-col 供列宽实测（按索引回填，gap 孔洞安全）。 */}
          <div className="narrative-timeline-corner" style={{ gridColumn: 1, gridRow: 1 }} />
          {cols.map((col) => (
            <div
              key={`col-${col.index}`}
              className="narrative-timeline-col-header narrative-timeline-drop-target"
              style={{ gridColumn: col.index + 2, gridRow: 1 }}
              data-col-value={col.index}
              data-grid-col={col.index}
              data-drop-col={col.index}
              title={col.title || undefined}
              onDragOver={drag.onDragOver}
              onDrop={drag.onDrop(col.index)}
              onContextMenu={(e) => openColumnMenu(col.index, e)}
            >
              <span className="narrative-timeline-col-value">{t('structure.workbench.chapterColumn', { n: col.index + 1 })}</span>
              <button
                type="button"
                className="narrative-timeline-col-add"
                data-action="add-scene"
                onClick={() => addSceneAtColumn(col.index)}
                aria-label={t('structure.ctx.addSceneAt', { col: col.index + 1 })}
                title={t('structure.ctx.addSceneAt', { col: col.index + 1 })}
              >
                ＋
              </button>
            </div>
          ))}
          {/* 待编排虚拟列头（dangling 镜像收纳——灰态；非 episode，纯渲染聚合）。
              无菜单/无 ＋（没有「在此新建场景」的章语义）。批 8（8.2）：挂
              structure-pin-right——页级横滚时恒驻视口右缘。 */}
          <div
            className="narrative-timeline-col-header narrative-timeline-col-header--pending structure-pin-right"
            style={{ gridColumn: pendingColumn, gridRow: 1 }}
            data-col-value="pending"
            data-grid-col={chapterTrackCount}
            title={t('structure.workbench.pendingHint')}
          >
            <span className="narrative-timeline-col-value">{t('structure.workbench.pendingColumn')}</span>
          </div>

          {/* Lane rows: label + card stacks（每轨恒渲染 stack 包裹——drag 目标/列
              视觉节奏/列宽标记三用；空轨无卡）+ 待编排镜像列。 */}
          {rows.map((row, rIdx) => (
            <LaneRow
              key={row.lineId}
              lineId={row.lineId}
              name={row.name}
              rowIndex={rIdx}
              trackCount={chapterTrackCount}
              pendingColumn={pendingColumn}
              cells={cellStacks}
              pendingCards={causalPending.get(pendingBucketKey(row.lineId)) ?? []}
              sceneCount={sceneCountByLine.get(row.lineId) ?? 0}
              sceneCountText={t('structure.lane.scenes', { n: sceneCountByLine.get(row.lineId) ?? 0 })}
              episodeIndexes={episodeIndexSet}
              line={lineById.get(row.lineId)}
              showDisplacement={showDisplacement}
              showVisibility={showVisibility}
              nodeIssuesByLine={issueLookup.node}
              lineIssues={issueLookup.line.get(row.lineId)}
              emotionByNode={emotionByNode}
              onSceneDragStart={drag.onDragStart}
              onCellStackDragOver={drag.onDragOver}
              onBlockedDragOver={drag.onBlockedDragOver}
              onCellStackDrop={drag.onDrop}
              onPendingStackDrop={drag.onPendingDrop}
              onSceneClick={setSelectedNodeId}
              focusedLineId={focusedLineId}
              onLaneClick={setFocusedLineId}
              selectedNodeId={selectedNodeId}
              onSceneContextMenu={openSceneMenu}
              onLaneContextMenu={openLineMenu}
              editingLineId={editingLineId}
              onCommitLineRename={commitLineRename}
              onCancelLineRename={() => setEditingLineId(null)}
              highlightNodeIds={highlightNodeIds}
              pendingCounterLabel={(n) => t('structure.lane.pendingCount', { n })}
            />
          ))}

          {/* SP-3 线管理入口：泳道列表底部「＋ 新增线」。 */}
          <div
            className="narrative-timeline-add-line"
            style={{ gridColumn: `1 / ${gridColumnCount + 2}`, gridRow: rows.length + 2 }}
          >
              <button
                type="button"
                className="narrative-timeline-add-line-btn"
                data-action="add-line"
                onClick={addLine}
              >
                ＋ {t('structure.line.add')}
              </button>
              <span className="narrative-timeline-add-line-hint">{t('structure.line.menuHint')}</span>
          </div>

          {/* Edges overlay (absolute, pointer-events:none) — 批 2 沉底 z 序；批 7
              端点 x/y 双查表（colOffsets 实测/名义回退）。 */}
          <EdgeLayer
            edges={resolvedEdges}
            width={gridWidth}
            height={gridHeight}
            edgeIssues={issueLookup.edge}
          />

          {/* SP-5 卷背景带体色：绝对定位分段 overlay（x 改 colOffsets 查表，批 7）。 */}
          <VolumeBandTint bands={volumeBands} phases={outlinePhases} colOffsets={effectiveColOffsets} />

          {/* SP-4 节奏叠层：格顶细条热度。cells 含待编排镜像桶（CR 组 2a parity：
              情绪条已出、热度条缺席的不对称由此补齐）；哨兵列经 colIndex 哨兵映射
              定位末位轨道。数组进 memo；#119 实测纵带下传——有效时贴真实卡缘，
              jsdom 回退双查表公式。 */}
          <PacingOverlay
            cells={pacingCells}
            rowIndex={rowIndex}
            colIndex={colIndex}
            stackSizeAt={stackSizeAt}
            rowOffsets={rowOffsets}
            colOffsets={effectiveColOffsets}
            intensityByNode={intensityByNode}
            measuredBands={stackBands}
          />

          {/* Defensive: episodes exist (→ tracks) but no lines resolved (→ no rows) */}
          {rows.length === 0 && cols.length > 0 && (
            <div
              className="narrative-timeline-empty-body"
              style={{ gridColumn: `1 / ${gridColumnCount + 2}`, gridRow: 2 }}
            >
              {t('structure.noLines')}
            </div>
          )}
        </div>
      </div>

      {/* SP-1/SP-3 右键菜单（格上/线/列头）。items 在 render 期构造——菜单是短命
          浮层，菜单开着时图若变了（并发 patch）下一帧重建 items，无 stale 问题。 */}
      {menu && menu.kind !== 'line-visibility' && (
        <TimelineContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu)}
          onClose={() => setMenu(null)}
          ariaLabel={t('structure.ctx.menuLabel')}
        />
      )}

      {/* 线可见度「隐藏直到」目标输入（SP-3 visibility：open/hidden-until target）。 */}
      {menu && menu.kind === 'line-visibility' && (
        <>
          <div
            className="timeline-ctx-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
            data-testid="timeline-ctx-backdrop"
          />
          <div
            className="timeline-ctx-menu timeline-ctx-visibility"
            style={{ left: menu.x, top: menu.y }}
            data-testid="timeline-visibility-input"
          >
            <span className="timeline-ctx-visibility-label">{t('structure.ctx.visibilityTargetLabel')}</span>
            <input
              type="text"
              autoFocus
              value={visibilityTarget}
              onChange={(e) => setVisibilityTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const target = visibilityTarget.trim();
                  if (target && menu.kind === 'line-visibility') {
                    applyActions([{
                      op: 'update_line',
                      line: { id: menu.lineId, visibility: { status: 'hidden-until', target } },
                    }]);
                  }
                  setMenu(null);
                }
                if (e.key === 'Escape') setMenu(null);
              }}
              placeholder={t('structure.ctx.visibilityTargetPlaceholder')}
              data-field="visibility-target"
            />
          </div>
        </>
      )}

      {/* SP-1/SP-3 删除确认（复用 model-settings DeleteConfirmDialog）。文案数据实
          （边/场景计数来自当前图；级联在 action 数组层补齐——见 sceneGraphEditModel）。 */}
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        title={
          deleteTarget?.kind === 'line'
            ? t('structure.ctx.deleteLineTitle')
            : t('structure.ctx.deleteSceneTitle')
        }
        description={deleteDesc}
        confirmLabel={t('structure.ctx.deleteConfirm')}
        cancelLabel={t('structure.ctx.deleteCancel')}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/**
 * One lane row: the label cell + one cell-stack wrapper PER DENSE TRACK + the
 * 待编排 mirror column. Split into its own component so the parent map stays
 * readable and React can key rows by lineId cleanly.
 *
 * 批 7（章轴）：栈包裹层**每轨恒渲染**（旧版空桶 return null）——① 空轨的 drag
 * 目标、② 列宽实测标记（data-grid-col 三处锚之一）、③ 行分隔退役后的列视觉节奏。
 * `cells` 桶键与派生单源一致：`${lineId}|${chapterIdx}`；待编排列哨兵列在
 * `pendingColumn`。跨章 span 场景只落起始章一格（组件注钉：不复刻 chip 的 span
 * 渲染——两区密度差即视图价值差，design §11 定案 1）。
 *
 * dogfood R2 批次 A 手势全保留：右键菜单入口 / inline 改名态 / D2 高亮下传。
 */
type LaneRowProps = {
  lineId: string;
  name: string;
  rowIndex: number;
  /** 该泳道场景数（data-lane-count 数值口径 attr——locale 文案不再是断言锚）。 */
  sceneCount: number;
  /** 泳道场景数文案（面板以 t('structure.lane.scenes') 格式化传入）。 */
  sceneCountText: string;
  line: SceneLine | undefined;
  /** 稠密章轨道数（含 gap——每轨一个栈包裹层）。 */
  trackCount: number;
  /** 待编排虚拟列的 grid column 号（1-based）。 */
  pendingColumn: number;
  /** 真实存在的章 index 集（gap 轨道拒收 drop 的守卫源——CR 组 2a）。 */
  episodeIndexes: Set<number>;
  /** `${lineId}|${chapterIdx}` → 该格场景卡（故事时序升序，subIndex 平铺序）。 */
  cells: Map<string, CausalCardData[]>;
  /** 本线待编排镜像卡（哨兵列，灰态）。 */
  pendingCards: CausalCardData[];
  showDisplacement: boolean;
  showVisibility: boolean;
  /** all node issues — cards look up their own nodeId (multi-line nodes share badges) */
  nodeIssuesByLine: Map<string, SceneGraphIssue[]>;
  /** issues targeting this lane's line — for the lane-label badge */
  lineIssues?: SceneGraphIssue[];
  /** 08-26 批 2：nodeId → emotion point（情绪叠层开时下传，卡内渲染底条）。 */
  emotionByNode?: Map<string, EmotionPoint>;
  /** Phase E3-drag: bound dragstart factory (useTimelineEdit). Card → draggable. */
  onSceneDragStart?: (nodeId: string) => (e: DragEvent) => void;
  /** Phase E3-drag: dragover handler shared by every cell-stack drop target. */
  onCellStackDragOver?: (e: DragEvent) => void;
  /** 拒收面（gap 轨）的 dragover：阻断光标、不放行 drop。 */
  onBlockedDragOver?: (e: DragEvent) => void;
  /** Phase E3-drag: drop-handler factory; takes the chapter index the stack sits at. */
  onCellStackDrop?: (chapterIdx: number) => (e: DragEvent) => void;
  /** #63：待编排镜像列落点（拖回待编排 = 撤章归属）。 */
  onPendingStackDrop?: (e: DragEvent) => void;
  /**
   * Phase E3-interact: card-click → select (opens SceneEditPopover). Bound to
   * `setSelectedNodeId`. HTML5 DnD keeps click vs drag distinct (no-movement
   * click never fires dragstart), so this coexists with `onSceneDragStart`.
   */
  onSceneClick?: (nodeId: string) => void;
  focusedLineId: string | null;
  /** Phase E3-interact: lane-label click → toggle focus (set or clear). */
  onLaneClick?: (lineId: string | null) => void;
  selectedNodeId: string | null;
  /** dogfood R2 批次 A（SP-1）：格上右键菜单入口（面板层绑定）。 */
  onSceneContextMenu?: (nodeId: string, e: MouseEvent) => void;
  /** dogfood R2 批次 A（SP-3）：线标签右键菜单入口。 */
  onLaneContextMenu?: (lineId: string, e: MouseEvent) => void;
  /** dogfood R2 批次 A（SP-3）：inline 改名中的线 id（null = 无）。 */
  editingLineId: string | null;
  onCommitLineRename: (lineId: string, name: string) => void;
  onCancelLineRename: () => void;
  /** dogfood R2 批次 D2：agent 落盘新增节点高亮集。 */
  highlightNodeIds: string[];
  /**
   * 每线待编排计数器的文案格式化（R7 计数器化；i18n 在面板层闭包——
   * LaneRow 保持 dumb，入参 total = 该线未编排场景总数）。
   */
  pendingCounterLabel?: (total: number) => string;
};

const NEUTRAL_DISPLACEMENT: SceneLine['displacement'] = 'none';
const NEUTRAL_VISIBILITY: SceneLine['visibility'] = { status: 'open' };

function LaneRow({
  lineId,
  name,
  rowIndex,
  sceneCount,
  sceneCountText,
  line,
  trackCount,
  pendingColumn,
  episodeIndexes,
  cells,
  pendingCards,
  showDisplacement,
  showVisibility,
  nodeIssuesByLine,
  lineIssues,
  emotionByNode,
  onSceneDragStart,
  onCellStackDragOver,
  onBlockedDragOver,
  onCellStackDrop,
  onPendingStackDrop,
  onSceneClick,
  focusedLineId,
  onLaneClick,
  selectedNodeId,
  onSceneContextMenu,
  onLaneContextMenu,
  editingLineId,
  onCommitLineRename,
  onCancelLineRename,
  highlightNodeIds,
  pendingCounterLabel,
}: LaneRowProps) {
  const displacement = line?.displacement ?? NEUTRAL_DISPLACEMENT;
  const visibility = line?.visibility ?? NEUTRAL_VISIBILITY;

  // Phase E3-interact line-focus: dim rows outside the focused line (visual only).
  const dimmed = focusedLineId !== null && focusedLineId !== lineId;
  const handleLaneClick = onLaneClick
    ? () => onLaneClick(focusedLineId === lineId ? null : lineId)
    : undefined;

  const editing = editingLineId === lineId;

  // CR-14 commit-once 守卫：Enter/Esc 同步卸载输入框（editingLineId → null），个别
  // 引擎对被移除的聚焦元素补派 blur → 取消后仍写值 / 提交写两次。
  const renameLockRef = useRef(false);
  useEffect(() => {
    if (editing) renameLockRef.current = false;
  }, [editing]);
  const commitRename = (value: string) => {
    if (renameLockRef.current) return;
    renameLockRef.current = true;
    onCommitLineRename(lineId, value);
  };
  const cancelRename = () => {
    if (renameLockRef.current) return;
    renameLockRef.current = true;
    onCancelLineRename();
  };

  // R7（计数器化；#65 封顶语义保留）：待编排堆**全量渲染**，`.pending-overflow`
  // 封顶变体类按「总数 > 初见枚数」挂在**内层 .narrative-timeline-pending-stack**
  // （T8 滚动栈内化——外层宿主非滚动，计数器 absolute 钉宿主右上零漂移）；
  // CSS max-height + 常驻滚轮；「+N」堆内徽标退役——计数器报**总数**。
  // 旧「实测驱动折叠数」度量随徽标消费面一并撤销。
  const pendingOverflow =
    pendingCards.length > WORKBENCH_GEOMETRY.pendingStackVisibleCount;

  return (
    <>
      {/* 泳道标签：线色左条 + 线名（着线色）+ 场景数两行；lane-hue--c{n} 单源挂线
          色。data-grid-row 供 useGridGeometry 实测行高（grid item stretch 到行高）。 */}
      <div
        className={`narrative-timeline-lane-label lane-hue--c${lineHueIndex(lineId)}${dimmed ? ' narrative-timeline-lane-label--dimmed' : ''}${focusedLineId === lineId ? ' narrative-timeline-lane-label--focused' : ''}`}
        style={{ gridColumn: 1, gridRow: rowIndex + 2 }}
        data-lane-id={lineId}
        data-lane-focused={focusedLineId === lineId ? 'true' : 'false'}
        data-grid-row={rowIndex}
        onClick={editing ? undefined : handleLaneClick}
        onContextMenu={onLaneContextMenu ? (e) => onLaneContextMenu(lineId, e) : undefined}
        title={name}
      >
        <span className="narrative-timeline-lane-bar" aria-hidden="true" />
        <div className="narrative-timeline-lane-text">
          {editing ? (
            <input
              type="text"
              className="narrative-timeline-lane-edit"
              data-lane-edit={lineId}
              defaultValue={name}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.stopPropagation()}
              onBlur={(e) => commitRename(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(e.currentTarget.value);
                if (e.key === 'Escape') cancelRename();
              }}
            />
          ) : (
            <span className="narrative-timeline-lane-name">{name}</span>
          )}
          <span className="narrative-timeline-lane-count" data-lane-count={sceneCount}>
            {sceneCountText}
          </span>
        </div>
        <ValidationBadges issues={lineIssues} />
      </div>

      {/* 章轨道栈：恒渲染包裹层（含 gap/空轨——空轨承载列视觉节奏 + 列宽标记
          data-grid-col）。drop 目标只挂**真实 episode** 的章（CR 组 2a：写 gap 章 =
          被解析序静默改判 pending；gap 轨 dragover 显示阻断光标、不接 drop）。 */}
      {Array.from({ length: trackCount }, (_, c) => {
        const stack = cells.get(`${lineId}|${c}`);
        const droppable = episodeIndexes.has(c);
        return (
          <div
            key={`stack-${lineId}-${c}`}
            className={`narrative-timeline-cell-stack${droppable ? ' narrative-timeline-drop-target' : ''}${dimmed ? ' narrative-timeline-cell-stack--dimmed' : ''}`}
            style={{ gridColumn: c + 2, gridRow: rowIndex + 2 }}
            data-grid-col={c}
            data-chapter={c}
            data-drop-col={droppable ? c : undefined}
            onDragOver={droppable ? onCellStackDragOver : onBlockedDragOver}
            onDrop={droppable ? onCellStackDrop?.(c) : undefined}
          >
            {(stack ?? []).map((cell) => (
              <SceneCard
                key={`${cell.nodeId}|${cell.lineId}|${cell.subIndex}`}
                cell={cell}
                displacement={displacement}
                visibility={visibility}
                showDisplacement={showDisplacement}
                showVisibility={showVisibility}
                nodeIssues={nodeIssuesByLine.get(cell.nodeId)}
                emotionPoint={emotionByNode?.get(cell.nodeId)}
                onSceneDragStart={onSceneDragStart?.(cell.nodeId)}
                onSceneClick={onSceneClick}
                selectedNodeId={selectedNodeId}
                onSceneContextMenu={onSceneContextMenu}
                highlighted={highlightNodeIds.includes(cell.nodeId)}
              />
            ))}
          </div>
        );
      })}

      {/* 待编排镜像列：dangling 场景灰态卡（design §11 定案 1——纯渲染聚合，无
          episode 写入信号）。批 8（8.2）：structure-pin-right 恒驻右缘。
          R7：全量渲染 + 高度封顶 + 每线待编排计数器（报总数）。
          T8（发现批4·深夜二轮）：外层降为**非滚动宿主**（定位锚 + drop 面 + pin-right
          + 不透明底），封顶/滚轮/渐隐随卡搬进内层 .narrative-timeline-pending-stack
          （pending-overflow 变体类内迁）；计数器挂宿主直下 absolute 恒钉右上角——
          **不在滚动容器内**＝零漂移的结构性保证（T6 负 margin 方案退役）。
          #63：本列是合法落点——拖入即撤章归属（applyPendingDrop 哨兵章写入）。 */}
      <div
        className={`narrative-timeline-cell-stack narrative-timeline-cell-stack--pending narrative-timeline-drop-target structure-pin-right${dimmed ? ' narrative-timeline-cell-stack--dimmed' : ''}`}
        style={{ gridColumn: pendingColumn, gridRow: rowIndex + 2 }}
        data-chapter="pending"
        onDragOver={onCellStackDragOver}
        onDrop={onPendingStackDrop}
      >
        {pendingCards.length > 0 && (
          <span
            className="lane-pending-counter"
            data-pending-total={pendingCards.length}
            aria-label={pendingCounterLabel ? pendingCounterLabel(pendingCards.length) : undefined}
            title={pendingCounterLabel ? pendingCounterLabel(pendingCards.length) : undefined}
          >
            {pendingCards.length}
          </span>
        )}
        <div className={`narrative-timeline-pending-stack${pendingOverflow ? ' pending-overflow' : ''}`}>
          {pendingCards.map((cell) => (
            <SceneCard
              key={`${cell.nodeId}|${cell.lineId}|${cell.subIndex}`}
              cell={cell}
              displacement={displacement}
              visibility={visibility}
              showDisplacement={showDisplacement}
              showVisibility={showVisibility}
              nodeIssues={nodeIssuesByLine.get(cell.nodeId)}
              emotionPoint={emotionByNode?.get(cell.nodeId)}
              onSceneDragStart={onSceneDragStart?.(cell.nodeId)}
              onSceneClick={onSceneClick}
              selectedNodeId={selectedNodeId}
              onSceneContextMenu={onSceneContextMenu}
              highlighted={highlightNodeIds.includes(cell.nodeId)}
              pending
            />
          ))}
        </div>
      </div>
    </>
  );
}
