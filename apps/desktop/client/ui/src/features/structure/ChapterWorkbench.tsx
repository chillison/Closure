import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { DragEvent, MouseEvent } from 'react';
import type { z } from 'zod';
import type { SceneGraph, SceneGraphIssue } from '@orison/shared-contracts';
import { applyEpisodeActions, episodeOutlineSchema, outlineV2Schema, validateSceneGraph } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { isSceneGraphLike } from './layout';
import { TIMELINE_GEOMETRY } from './timelineGeometry';
import {
  deriveWorkbenchLayout,
  WORKBENCH_GEOMETRY,
  type PendingChipData,
} from './workbenchLayout';
import { WorkbenchChip } from './WorkbenchChip';
import {
  chipHeightFromContent,
  MAX_SETTLE_ROUNDS,
  packLaneChips,
  WORKBENCH_PACKING_GEO,
  type LanePacking,
  type PackChipInput,
} from './workbenchPacking';
import { indexIssuesByTarget } from './ValidationOverlay';
import { volumeBandsFromEpisodes, type OutlinePhase } from './volumeBands';
import { bandColorClass, bandTitle } from './VolumeBand';
import { useWeavingEdit } from './useWeavingEdit';
import { buildInsertChapterActions, buildNewSceneAtChapterAction, columnIndexFromRects, type ColumnRectEntry } from './sceneGraphEditModel';
import { useSceneGraphEdit } from './useSceneGraphEdit';
import { lineHueIndex } from './linePalette';
import { TimelineContextMenu, type ContextMenuItem } from './TimelineContextMenu';

type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

/**
 * data-chapter 属性串的整数解析守卫（CR3 edge：`Number('')===0` 恒过 isInteger——
 * 空白串会把槽别名成章 0）。非空 + 纯整数字面（含负号）才数值化，否则 null。
 * T1 rect 表采集与 T2 面锚回退两处共用同一守卫。
 */
function parseChapterAttr(value: string | null): number | null {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * T23 两遍法等值守卫（epsilon 版）：|Δ| ≤ 0.5px 视同相等（scrollHeight 整数
 * 圆整 / ÷zoom 小数噪声——严格全等会在两值间永久震荡绕过守卫）。同布局测量
 * 确定性输出，不等才值得触发重渲染，防 setState 回环。
 */
const HEIGHT_EPSILON = 0.5;
function chipHeightsEqual(
  a: ReadonlyMap<string, number> | null,
  b: ReadonlyMap<string, number>
): boolean {
  if (a === b) return true;
  if (!a || a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined || Math.abs(v - w) > HEIGHT_EPSILON) return false;
  }
  return true;
}

/**
 * 08-26 结构页重构 批 3（implement 3.1/3.2/3.3 / design §1.1 §2 §3.1 / prd R1）：
 * 章节规划工作台——融合网格（WeavingPanel 的重排承接：阅读顺序并入章节编织，
 * PackingLinkLayer 退役——「跨窗长斜线」问题连根消失 #39）。
 *
 *   行 = 线（orderLinesByPriority，与因果骨架泳道同序）
 *   列 = 章（episode；卷带行换轴复用 volumeBands 推导）
 *   格 =（线, 章）内该线场景片 chip，按 readIndex 升序（阅读序 = 格内排列序）
 *   末列 = 待编排（dangling 场景虚拟列——纯渲染聚合，零 episode 写入）
 *
 * 列宽（08-26 批 7 / design §11 定案 2）：**共享宿主轨道**——`.workbench-grid`
 * 声明 subgrid 接轨 .structure-canvas，章列 `minmax(108px, max-content)` 与待编排
 * 定宽列由宿主 inline 模板单源产出（上限由 chip max-width 212px 承担——**禁 min()
 * 嵌 minmax()**，整条模板会失效，mockup 踩坑注释在 timelineGeometry 钉住）。卷带
 * 行与章列头都在**主网格内**渲染（grid item 跨列/单格）。
 *
 * 编辑手势（08-27 R6 §6.3 冻结案）：
 *   - **槽位容器面是唯一 drop 缝**：空格即合法落点（AC2），常规章格 onDragOver 准入
 *     + onDrop 经 {@link resolveSlotDropColumn} 解析目标章后交 useWeavingEdit 单缝；
 *     gap 章拒收光标、不绑 drop。chip 自身零 drop handler——冒泡双写与宽卡截胡根除。
 *   - 宽卡投放在 T16b（发现批8）起为**位移式平移**（位移 = 落列 − 抓起列；0 = 拖起
 *     放回取消）——抓起列经 onSceneDragStart 记录、dragend/drop 清（useWeavingEdit）。
 *   - 缘部直拖（方案 D）：把手预览在 chip 内，pointerup 提交 applyResizeSpanRange。
 *     T23 起宽卡静止态 = **装填宽盒**（跨 N 章的卡即横跨覆盖列的横长方形——
 *     workbenchPacking 阅读序 first-fit 天际线：同线永不重叠、撞则下放、行高随
 *     轨道增长、文字完全显示=硬约束；估算帧→useLayoutEffect 实测重排一次落定）；
 *     解裁剪归 CSS 面 `:has()` 常驻豁免（装填宽卡要伸出槽外）。
 *   - 章列头「＋ 新建场景」（T24 迁位）：原每章格右上钮被 T23 装填宽卡**遮死**
 *     ——宽卡是别的槽的 DOM 子元素，被覆盖槽收不到 :hover，显形条件永不触发、
 *     点不到；用户拍板迁「和『第一章』同一个格子」= 列头行（grid 第 2 行，永远
 *     不被卡盖）。与因果列头 ＋ 同类（.narrative-timeline-col-add 单类两区共用，
 *     勿造平行类）同写通道（R11：buildNewSceneAtChapterAction 投影器）。
 *   - 待编排计数器钉每线行首（`.lane-pending-counter`，报总数——堆内 +N 徽标退役，
 *     #65 封顶+滚轮语义由 CSS 封顶变体保留）。
 *
 * 落地公理：无 episode_outlines 时不再整面空态——全部场景进待编排列（灰态），
 * 「哪些场景还没排进章」本身就是作者要看的真实状态。
 */
export function ChapterWorkbench() {
  const {
    sceneGraph,
    episodes,
    overlayValidation,
    resolvedLocale,
    selectedNodeId,
    setSelectedNodeId,
    rawOutline,
    focusedLineId,
    setDrawerTitleFocus,
    canvasZoom,
  } = useAppStore(
    useShallow((s) => ({
      // CR-001: shape-guard the store cast（同 NTP/OutlineEditor 防御缝）。
      sceneGraph: isSceneGraphLike(s.creativeFields.scene_graph)
        ? (s.creativeFields.scene_graph as SceneGraph)
        : undefined,
      episodes: s.creativeFields.episode_outlines as EpisodeOutline[] | undefined,
      overlayValidation: s.overlayToggles.validation,
      resolvedLocale: s.resolvedLocale,
      // SP-3 接线沿用：chip 点击 → 选中（selectedNodeId 单源，因果卡同显）。
      selectedNodeId: s.selectedNodeId,
      setSelectedNodeId: s.setSelectedNodeId,
      // 卷带数据源（unknown 原样取引用，memo 内 safeParse 归一——同 NTP）。
      rawOutline: s.creativeFields.outline,
      // R11 工作台新建入口：默认归属线解析（聚焦线∥主线）+ 建后抽屉聚焦标题旗标。
      focusedLineId: s.focusedLineId,
      setDrawerTitleFocus: s.setDrawerTitleFocus,
      // §6.3 列命中的几何签名（rect 表缓存键参与——见 useMemo 注）。
      canvasZoom: s.canvasZoom,
    }))
  );
  const { t } = useI18n(resolvedLocale);

  const layout = useMemo(
    () => (sceneGraph ? deriveWorkbenchLayout(sceneGraph, episodes) : null),
    [sceneGraph, episodes]
  );

  // 泳道场景数（该线 chip 数 = 已编排 + 待编排；与因果骨架泳道同口径——多线场景
  // 各线各计一枚）。大数组双展开收敛进 memo（CR 组 3a），且置于早退分支之前
  // （hooks 无条件调用）。data-lane-count 走数值口径（测试对拍锚不再咬死 locale 文案）。
  const chipCountByLine = useMemo(() => {
    const m = new Map<string, number>();
    if (!layout) return m;
    for (const chip of [...layout.slots.values()].flat()) {
      m.set(chip.lineId, (m.get(chip.lineId) ?? 0) + 1);
    }
    for (const chips of layout.pendingByLine.values()) {
      for (const chip of chips) {
        m.set(chip.lineId, (m.get(chip.lineId) ?? 0) + 1);
      }
    }
    return m;
  }, [layout]);

  // Validation issues → per-node lookup（共享 validation toggle 总闸）。
  const nodeIssues = useMemo(() => {
    if (!sceneGraph || !overlayValidation) return new Map<string, SceneGraphIssue[]>();
    return indexIssuesByTarget(validateSceneGraph(sceneGraph)).node;
  }, [sceneGraph, overlayValidation]);

  // outline → phases（卷名 + tie-break 序；safeParse 静默降级，同 NTP）。
  const outlinePhases = useMemo<OutlinePhase[]>(() => {
    const parsed = outlineV2Schema.safeParse(rawOutline);
    return parsed.success ? parsed.data.phases : [];
  }, [rawOutline]);

  // ── dogfood R2 #80：章轴卷带切集映射——权威源 = episode.phase_ref（LLM 写入、
  // 人对补丁卡审定；章→集→卷 1:1 就在数据里）。旧场景投币（chip.colStart 伪 cell
  // 喂 deriveVolumeBands）是集纲 phase 覆盖缺失时代的代理：38 场撒 160 章时 ~120
  // 无场景章零票全灰（#80）。无 phases → 不渲染卷带（整条灰带是噪音——口径不变）。
  const volumeBands = useMemo(
    () => (outlinePhases.length === 0 ? [] : volumeBandsFromEpisodes(episodes ?? [], outlinePhases)),
    [episodes, outlinePhases]
  );

  // W3 编辑手势（§6.3 槽位路由 + 方案 D 提交缝——单 updateField 不变）。
  const edit = useWeavingEdit();
  const { applyActions } = useSceneGraphEdit();
  // T11（发现批5）：把手边界态说明文案（「有的只能左拉」困惑消解——不可用态在
  // chip 侧置灰 + 此处三条 title）。T10：「续至第 N 章」label 随徽记退役删除。
  const handleHint = {
    rightAtEnd: t('structure.workbench.handleRightAtEnd'),
    leftSingle: t('structure.workbench.handleLeftSingle'),
    leftAtFirst: t('structure.workbench.handleLeftAtFirst'),
  };

  // ── R8/R11（用户拍板「工作台空白右键补实现」）：列头·空白右键菜单态。与因果区
  //    同一呈现件（TimelineContextMenu）+ 同一置灰纪律（gap/pending 命中项 disabled
  //    而非菜单消失）。colValue = 章 index；待编排带命中 = chapterTrackCount（不在
  //    episodeIndexSet → 两项置灰）。
  const [menu, setMenu] = useState<{ colValue: number; x: number; y: number } | null>(null);

  // ── §6.3 列命中（T1 实测梯）：指针 clientX → 章 index —— ──
  // 收**章格 rect 表**（screen px 自洽系——clientX 与 getBoundingClientRect 同量纲，
  // zoom 已含在 rect 里，不 ÷zoom），纯函数 columnIndexFromRects 反查。数据源选
  // `.workbench-slot[data-chapter]` 而非列头：gap 章没有列头但有槽位——其轨道区段
  // 由真实几何保留，命中 gap index 后再经 episodeIndexSet 门槛拒收（§6.3「命中值
  // 不在 episodeIndexSet → 拒收」的分工）。表不可用（jsdom 全零 rect / 未布局）→
  // null，调用方退化 T2 面锚（槽位自报章）。
  const gridRef = useRef<HTMLDivElement>(null);
  /** §6.3 T1 梯的章槽位 rect 表采集（列命中与 T15 列盒解析共用单源——勿复制）。 */
  const collectColumnRectEntries = useCallback((): ColumnRectEntry[] => {
    const grid = gridRef.current;
    if (!grid) return [];
    const seen = new Set<number>();
    const entries: ColumnRectEntry[] = [];
    grid.querySelectorAll<HTMLElement>('.workbench-slot[data-chapter]').forEach((el) => {
      const idx = parseChapterAttr(el.getAttribute('data-chapter'));
      if (idx === null || seen.has(idx)) return; // 空白串守卫（CR3 edge）/ 待编排 'pending' / 跨行去重
      const r = el.getBoundingClientRect();
      if (!(r.width > 0)) return; // 未布局 / jsdom 零矩形 → 该列不可信
      seen.add(idx);
      entries.push({ index: idx, left: r.left, width: r.width });
    });
    return entries;
  }, []);

  const resolveColumnAtClientX = useCallback(
    (clientX: number): number | null => {
      const entries = collectColumnRectEntries();
      if (entries.length === 0) return null;
      return columnIndexFromRects(entries, clientX);
    },
    // canvasZoom 参与依赖：缩放突变后 rect 在下一帧才会重解，签名入键提示消费方
    // 解析器闭包随 zoom 失效重建（无表时同样落到面锚梯，正确性不受影响）。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 签名位仅作失效信号
    [canvasZoom, collectColumnRectEntries]
  );

  /**
   * T15（发现批7·实时变宽）：列 index → 画布自然单位盒（屏系 rect ÷canvasZoom
   * 归一——chip 的 inline px 处于 zoom 树内自然坐标系；原点任意，chip 侧只消费
   * 列间差值）。不可用（jsdom 零 rect / 未布局 / 列不在表内）→ null，resize 预览
   * 退回纯虚线轮廓形态。T23 起装填宽盒（跨列宽）同源消费（几何单源纪律：本
   * seam 是装填盒宽度与预览盒的唯一列几何出口）。
   */
  const resolveColumnBoxAt = useCallback(
    (col: number): { left: number; right: number } | null => {
      const hit = collectColumnRectEntries().find((e) => e.index === col);
      if (!hit) return null;
      const z = canvasZoom > 0 ? canvasZoom : 1;
      return { left: hit.left / z, right: (hit.left + hit.width) / z };
    },
    [canvasZoom, collectColumnRectEntries]
  );

  // ── T23（发现批10·宽卡天际线装填）：两遍法实测校正的状态面 ──
  // 首遍（估算）：jsdom/未挂载零 rect → 装填全走名义常量（纯数据+常量，测试可
  // 断言位置；估算帧不钉 inline height——卡高随内容自然生长，「完全显示」托底）。
  // 挂载后本 effect 实测**标题盒高**（.workbench-chip-title 的 scrollHeight——
  // 布局量纲，CSS zoom 缩放布局值故 ÷zoom 归一到画布自然单位；整数圆整，epsilon
  // 守卫吞噪声），chipHeightFromContent 换算成卡高（border-box 口径与 inline
  // height 同源——无双计面），带 measuredHeight 重排一次（T18 首帧 bump 同款
  // 机制：useLayoutEffect 先于 paint，一次落定无闪烁）——实测低于估算→收缩、
  // 高于→下放后续卡。
  //
  // ── 不动点纪律（真机 max-depth 回炉修正）──
  // ① 结构隔离（根修）：实测面与写面分离——settle 只写 chip 的 inline height，
  //    实测只读 title；title 永不接收 inline height，其高度只由（卡宽=列盒 seam、
  //    字体、文本）决定，皆非 settle 写面 ⇒ f(applied) 与 applied 无关 ⇒ applied
  //    后重测必同值，1-2 轮收敛。旧形测 chip 自身 scrollHeight 自引用 inline
  //    height（max(clientHeight, content) 的 clientHeight 分量），任何口径偏差
  //    都成环——真机崩、jsdom 零布局不可达故全绿。
  // ② 次级反馈环核查：chip 高 → laneHeight → 槽 minHeight → 槽高——槽高不进
  //    title 高度（title 只随卡宽走；卡宽来自列盒，列宽由列头/因果卡 max-content
  //    驱动，abspos 卡不参与列宽解析）⇒ 无第二条环。
  // ③ 防线：epsilon 等值（chipHeightsEqual ±0.5px）+ 轮次熔断（连续
  //    MAX_SETTLE_ROUNDS 轮不等值即停 + warn 一次——敌意/非幂等测量下保持最后
  //    装填，永不触 React 嵌套更新上限）。
  const [measuredHeights, setMeasuredHeights] = useState<ReadonlyMap<string, number> | null>(
    null
  );
  const settleRoundsRef = useRef(0);
  const settleWarnedRef = useRef(false);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || !layout) return;
    const z = canvasZoom > 0 ? canvasZoom : 1;
    const next = new Map<string, number>();
    // 只测章槽直下 chip——待编排灰片是 in-flow 流态族（.workbench-pending-stack
    // 内），不参与装填；多线节点经 (nodeId, lineId) 配对键区分各线卡。
    grid
      .querySelectorAll<HTMLElement>(
        '.workbench-slot:not(.workbench-slot--pending) > .workbench-chip'
      )
      .forEach((el) => {
        const nodeId = el.getAttribute('data-node-id');
        const lineId = el.getAttribute('data-line-id');
        const titleEl = el.querySelector('.workbench-chip-title');
        if (!nodeId || !lineId || !titleEl) return;
        // 守卫针对原始值：jsdom 零布局 scrollHeight 恒 0（不采信——保持估算口径）。
        const raw = titleEl.scrollHeight / z;
        if (!Number.isFinite(raw) || raw <= 0) return;
        next.set(`${nodeId}|${lineId}`, chipHeightFromContent(raw, WORKBENCH_PACKING_GEO));
      });
    if (next.size === 0) return;
    if (chipHeightsEqual(measuredHeights, next)) {
      settleRoundsRef.current = 0; // 不动点到达——轮次重置（后续合法扰动重新计数）
      return;
    }
    if (settleRoundsRef.current >= MAX_SETTLE_ROUNDS) {
      if (!settleWarnedRef.current) {
        settleWarnedRef.current = true;
        console.warn(
          '[workbench] skyline settle 熔断：实测高连续不等值（敌意/非幂等测量形态）——停用本轮校正，保持最后装填'
        );
      }
      return;
    }
    settleRoundsRef.current += 1;
    setMeasuredHeights(next);
  }, [layout, canvasZoom, measuredHeights]);

  // gap 章轨的阻断光标（对齐 useTimelineEdit.onBlockedDragOver 同款语义——本区
  // 不绑 drop，dragover 只声明 none 效果；不 preventDefault → drop 永不触发）。
  const onBlockedDragOver = useCallback((e: DragEvent) => {
    e.dataTransfer.dropEffect = 'none';
  }, []);

  /** T1→T2 合成的槽位落点目标章解析（null = 拒收）。 */
  const resolveSlotDropColumn = (e: DragEvent<HTMLElement>, hostSlot: HTMLElement): number | null => {
    const measured = resolveColumnAtClientX(e.clientX);
    if (measured !== null) {
      return episodeIndexSet.has(measured) ? measured : null;
    }
    // T2 面锚回退（jsdom / 未布局）：事件目标所在的槽位自报章（空白串守卫同 T1
    // 采集处共用 parseChapterAttr——`Number('')===0` 不再把空白属性别名成章 0）。
    const raw = parseChapterAttr(hostSlot.getAttribute('data-chapter'));
    return raw !== null && episodeIndexSet.has(raw) ? raw : null;
  };

  // ── R11 工作台新建场景：同一 buildNewSceneAtChapterAction 投影器通道（因果列头 ＋ 同源）──
  const addSceneInChapter = (chapterIdx: number) => {
    if (!sceneGraph) return;
    const action = buildNewSceneAtChapterAction(sceneGraph, chapterIdx, {
      episodes,
      focusedLineId,
    });
    applyActions([action]);
    // 落选前置校验（CR3 edge ghost drawer）：投影器拒收（图缺/形状坏/写通道 no-op）时
    // 节点未落图——不选 ghost、不开抽屉（与 NTP.addSceneAtColumn 同款）。
    const raw = useAppStore.getState().creativeFields.scene_graph;
    if (!isSceneGraphLike(raw) || !raw.nodes.some((n) => n.id === action.scene.id)) return;
    setSelectedNodeId(action.scene.id);
    setDrawerTitleFocus(true);
  };

  // ── R11 批3：在 index k 左侧插入新章（两区列头同口径；构造单源
  //    buildInsertChapterActions——episode 章表 k 位新章 + 既有 >= k 章 index+1 +
  //    场景裸章号同步右移，spans 按 episodeId 引用天然安全漂移）。章表先行（结构）、
  //    场景裸章号随后（同章号空间的依赖面）；sceneActions 空 = 无位移场景 → 跳过
  //    scene_graph 写（引用级 no-op：无变更字段不 bump 版本/不进 undo 栈）。──
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

  // ── R8/R11 右键入口：列头自带菜单；空白（含空槽面/gap 轨/待编排带）一律弹菜单，
  //    gap/pending 命中项置灰（与因果区 openBlankMenu 同模式）。元素（chip/泳道
  //    标签）右键不劫持——交还浏览器默认；列头（含 T24 迁入的「＋」钮）由自身
  //    onContextMenu 的 stopPropagation 先达（NTP 现行模式）。
  const openColumnMenu = (colValue: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ colValue, x: e.clientX, y: e.clientY });
  };

  /** 空白右键的落列解析（T1 实测梯 → 待编排带几何 → T2 面锚；null = 不锚菜单）。 */
  const resolveBlankMenuColumn = (e: MouseEvent<HTMLElement>): number | null => {
    // T1：T1 实测列命中表（screen px 自洽——与 drop 路由同一解析器）。gap index
    // 原样返回（可写与否归菜单层 episodeIndexSet 门槛置灰）。
    const measured = resolveColumnAtClientX(e.clientX);
    if (measured !== null) return measured;
    // 待编排带：pending 槽 data-chapter 非整数不入 T1 表 → 指针在其几何内时按带命中
    // （chapterTrackCount 不在 episodeIndexSet → 置灰项）。零宽/未布局 → 落 T2。
    const pendingEl = gridRef.current?.querySelector('.workbench-slot--pending');
    if (pendingEl) {
      const r = pendingEl.getBoundingClientRect();
      if (r.width > 0 && e.clientX >= r.left && e.clientX < r.left + r.width) {
        return chapterTrackCount;
      }
    }
    // T2 面锚回退（jsdom / 未布局）：事件目标所在槽位自报章（含 'pending' → 待编排带）。
    const slot = (e.target as HTMLElement).closest('.workbench-slot');
    if (slot) {
      const raw = slot.getAttribute('data-chapter');
      if (raw === 'pending') return chapterTrackCount;
      const parsed = parseChapterAttr(raw);
      if (parsed !== null) return parsed;
    }
    return null;
  };

  const openBlankMenu = (e: MouseEvent<HTMLElement>) => {
    if (chapterTrackCount === 0 || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.closest('.workbench-chip, .workbench-lane-label')) return;
    const hit = resolveBlankMenuColumn(e);
    if (hit === null) return; // 首列左侧泳道标签带/表外 → 不锚菜单（NTP local<0 守卫同族）
    e.preventDefault();
    e.stopPropagation();
    setMenu({ colValue: hit, x: e.clientX, y: e.clientY });
  };

  /** 列菜单 items（与因果区列菜单同口径：新建场景 + 在左侧插入新章；gap/pending 置灰）。 */
  const buildColumnMenuItems = (colValue: number): ContextMenuItem[] => {
    const droppableCol = episodeIndexSet.has(colValue);
    return [
      {
        kind: 'action',
        key: 'add-scene',
        label: droppableCol
          ? t('structure.ctx.addSceneAt', { col: colValue + 1 })
          : t('structure.ctx.addSceneBlocked'),
        disabled: !droppableCol,
        onPick: () => {
          if (droppableCol) addSceneInChapter(colValue);
        },
      },
      {
        kind: 'action',
        key: 'insert-chapter',
        label: droppableCol
          ? t('structure.ctx.insertChapterLeft', { n: colValue + 1 })
          : t('structure.ctx.insertChapterBlocked'),
        disabled: !droppableCol,
        onPick: () => {
          if (droppableCol) insertChapterAt(colValue);
        },
      },
    ];
  };

  if (!layout) return null;

  const { volumeBandHeight, headerHeight } = TIMELINE_GEOMETRY;
  const { rows, cols, chapterTrackCount, slots, pendingByLine } = layout;

  // 列模板（08-26 批 7 / design §11 定案 2）：**不自算**——`.workbench-grid` 类声明
  // `grid-template-columns: subgrid; grid-column: 1/-1` 向宿主 .structure-canvas 接
  // 轨，逐列宽度与因果骨架在**同一组轨道**上解一次（宿主 inline 模板 = timelineGeometry
  // 的 sharedColumnTracks 单源：泳道标签列 + repeat(N, minmax(108px, max-content))
  // + 待编排定宽列）。「同 template 字符串喂两个独立 grid」不成立（max-content 按
  // 各自内容解析）——必须 subgrid。行模板仍本组件自理。
  const gridTemplateColumns = 'subgrid';
  // 行模板（批 5 #42）：卷带行 22px 恒高改 minmax(22px, auto)——卷名 2 行 wrap 时
  // band 随内容长高。批 6（#52）：章列头行 32px 恒高同样改 minmax——章名 2 行 wrap
  // 时不再被固定行高竖切。**零行守卫**（CR 组 2a）：repeat(0, auto) 是非法模板构造，
  // 会整条静默失效——无线时不产 repeat 段。
  const laneRowsTemplate = rows.length > 0 ? ` repeat(${rows.length}, auto)` : '';
  const gridTemplateRows = `minmax(${volumeBandHeight}px, auto) minmax(${headerHeight}px, auto)${laneRowsTemplate}`;
  // 待编排虚拟列的 grid column 号（章轨道之后；1-based）。
  const pendingColumn = chapterTrackCount + 2;

  // 可落点的真实章集（CR 组 2a gap 守卫）：gap 章轨不接 drop/不开新建钮/列表拒收
  // ——写 gap 章 = 被解析序静默改判 pending，承诺不能兑现就不承诺。
  const episodeIndexSet = new Set(cols.map((c) => c.index));
  // 把手预览钳制域（提交层 applyResizeSpanRange 仍自校验兜底）。
  const builtMinCol = cols.length > 0 ? Math.min(...cols.map((c) => c.index)) : 0;
  const builtMaxCol = cols.length > 0 ? Math.max(...cols.map((c) => c.index)) : -1;

  // ── T23 线行装填（阅读序 first-fit 天际线——workbenchPacking 单源）──
  // render 期直算零缓存（T18 零缓存纪律）：列盒表每次渲染重收，列宽随内容漂移
  // 零陈旧（本区 chip 已绝对定位、不再参与列 max-content 解析，列宽由列头/因果
  // 侧卡驱动，跨 commit 稳定）；首帧未挂载 / jsdom 零 rect → 空表 → 跨列宽走
  // 名义常量（纯数据+常量，jsdom 可断言装填位置）。
  const columnBoxByIndex = new Map(collectColumnRectEntries().map((e) => [e.index, e] as const));
  const zoomFactor = canvasZoom > 0 ? canvasZoom : 1;
  const spanWidthOf = (start: number, end: number): number | undefined => {
    const sb = columnBoxByIndex.get(start);
    const eb = columnBoxByIndex.get(end);
    if (!sb || !eb) return undefined;
    return ((eb.left + eb.width) - sb.left) / zoomFactor;
  };
  const lanePackingByLine = new Map<string, LanePacking>();
  for (const row of rows) {
    const laneChips: PackChipInput[] = [];
    for (let c = 0; c < chapterTrackCount; c++) {
      for (const ch of slots.get(`${row.lineId}|${c}`) ?? []) {
        laneChips.push({
          nodeId: ch.nodeId,
          colStart: ch.colStart,
          colEnd: ch.colEnd,
          title: ch.title ?? ch.nodeId,
          readIndex: ch.readIndex,
          measuredHeight: measuredHeights?.get(`${ch.nodeId}|${ch.lineId}`),
          measuredWidth: spanWidthOf(ch.colStart, ch.colEnd),
        });
      }
    }
    lanePackingByLine.set(row.lineId, packLaneChips(laneChips, WORKBENCH_PACKING_GEO));
  }

  return (
    <section className="workbench" data-workbench aria-label={t('structure.workbench.title')}>
      <h3 className="structure-skeleton-title workbench-title">{t('structure.workbench.title')}</h3>
      <div className="workbench-scroll">
        <div
          className="workbench-grid"
          ref={gridRef}
          style={{ gridTemplateColumns, gridTemplateRows }}
          onContextMenu={openBlankMenu}
        >
          {/* 卷带体色（grid 内跨行/列分段——自适应列宽下与章列天然对齐；先渲染，
              后续非定位 grid item 依 DOM 序盖其上；pointer-events:none 放行 chip）。 */}
          {rows.length > 0
            && volumeBands.map((band) => (
              <div
                key={`wtint-${band.phaseId ?? 'unassigned'}-${band.fromCol}`}
                className={`workbench-volume-tint ${bandColorClass(band, outlinePhases)}`}
                style={{
                  gridColumn: `${band.fromCol + 2} / ${band.toCol + 3}`,
                  gridRow: `3 / ${rows.length + 3}`,
                }}
                aria-hidden="true"
              />
            ))}

          {/* 卷带行（design §1.1：卷 = 章分组的天然对齐；#80 起集映射直出）。 */}
          <div className="workbench-corner" style={{ gridColumn: 1, gridRow: 1 }}>
            {t('structure.volumeBand.label')}
          </div>
          {volumeBands.map((band) => (
            <div
              key={`wband-${band.phaseId ?? 'unassigned'}-${band.fromCol}`}
              className={`volume-band workbench-band ${bandColorClass(band, outlinePhases)}`}
              style={{ gridColumn: `${band.fromCol + 2} / ${band.toCol + 3}`, gridRow: 1 }}
              data-band-phase={band.phaseId ?? 'unassigned'}
              title={bandTitle(band, t('structure.volumeBand.unassigned'))}
            >
              <span className="volume-band-title">
                {bandTitle(band, t('structure.volumeBand.unassigned'))}
              </span>
            </div>
          ))}
          {/* 批 8（8.2）：待编排列的卷带行角格——挂 structure-pin-right 与列头/格
              组成钉右组（页级横滚时恒驻视口右缘）。 */}
          <div className="workbench-corner structure-pin-right" style={{ gridColumn: pendingColumn, gridRow: 1 }} />

          {/* 章列头行：第 N 章（episode.title 副标；gapped index 不造头——空轨道诚实）。 */}
          <div className="workbench-corner" style={{ gridColumn: 1, gridRow: 2 }} />
          {cols.map((col) => (
            <div
              key={`wcol-${col.index}`}
              className="workbench-col-header"
              style={{ gridColumn: col.index + 2, gridRow: 2 }}
              data-col-index={col.index}
              title={col.title}
              onContextMenu={(e) => openColumnMenu(col.index, e)}
            >
              <span className="workbench-col-label">{t('structure.workbench.chapterColumn', { n: col.index + 1 })}</span>
              {col.title ? <span className="workbench-col-title">{col.title}</span> : null}
              {/* T24（发现批11·用户拍板）：＋ 从每章格右上迁列头——槽位钮被 T23 装填
                  宽卡遮死（宽卡是别的槽的 DOM 子元素，覆盖槽收不到 :hover → 显形
                  永不触发）；列头行永不被卡盖。类名/写通道/i18n 与因果列头 ＋ 全同源
                  （.narrative-timeline-col-add 单类两区共用，hover 显形归 CSS）。gap
                  章轨本就不造头 → 天然无钮（空轨诚实，与因果区同口径）。 */}
              <button
                type="button"
                className="narrative-timeline-col-add"
                data-action="add-scene"
                onClick={() => addSceneInChapter(col.index)}
                aria-label={t('structure.ctx.addSceneAt', { col: col.index + 1 })}
                title={t('structure.ctx.addSceneAt', { col: col.index + 1 })}
              >
                ＋
              </button>
            </div>
          ))}
          <div
            className="workbench-col-header workbench-col-header--pending structure-pin-right"
            style={{ gridColumn: pendingColumn, gridRow: 2 }}
            data-col-index="pending"
            title={t('structure.workbench.pendingHint')}
          >
            <span className="workbench-col-label">{t('structure.workbench.pendingColumn')}</span>
          </div>

          {/* 泳道行：标签 +（线, 章）格 + 待编排格——label/slot 均为 grid 直接子元素
              （Fragment 组行：grid 放置面不容许行容器包一层）。
              08-26 批 5（#45）：标签结构对齐因果骨架泳道——线色左条 + 两行堆叠
              （线名独占整列宽 + 场景数下行），同宽同折行策略。 */}
          {rows.map((row, rIdx) => {
            const laneChips = chipCountByLine.get(row.lineId) ?? 0;
            const laneCountText = t('structure.lane.scenes', { n: laneChips });
            // T23 装填结果（本线整行共享——跨槽天际线的线级单源）。
            const packing = lanePackingByLine.get(row.lineId);
            // 判读修（T23 终读）：被宽卡覆盖（colStart < c ≤ colEnd）的章槽不再出
            // 「本章暂无场景」占位字——场景正从该章路过，占位既语义失真（章非空）
            // 又与宽卡卡身叠字（盲态终读实罪：「被围观的第一天无场景」怪话）。
            const spanCovered = new Set<number>();
            for (let c0 = 0; c0 < chapterTrackCount; c0++) {
              for (const chip of slots.get(`${row.lineId}|${c0}`) ?? []) {
                for (let k = chip.colStart + 1; k <= chip.colEnd; k++) spanCovered.add(k);
              }
            }
            return (
              <Fragment key={`wlane-${row.lineId}`}>
                <div
                  className={`workbench-lane-label lane-hue--c${lineHueIndex(row.lineId)}`}
                  style={{ gridColumn: 1, gridRow: rIdx + 3 }}
                  data-lane-id={row.lineId}
                  data-grid-row={rIdx}
                  title={row.name}
                >
                  <span className="workbench-lane-bar" aria-hidden="true" />
                  <div className="workbench-lane-text">
                    <span className="workbench-lane-name">{row.name}</span>
                    {/* P3 口径：data-lane-count 供「两区场景计数一致」测试对拍
                        （数值口径 attr，locale 文案不再是断言锚）。 */}
                    <span className="workbench-lane-count" data-lane-count={laneChips}>
                      {laneCountText}
                    </span>
                  </div>
                </div>
                {Array.from({ length: chapterTrackCount }, (_, c) => {
                  const chips = slots.get(`${row.lineId}|${c}`);
                  const droppable = episodeIndexSet.has(c);
                  return (
                    <div
                      key={`wslot-${row.lineId}-${c}`}
                      className="workbench-slot"
                      style={{
                        gridColumn: c + 2,
                        gridRow: rIdx + 3,
                        /* T23 装填线行高：槽 inline minHeight = laneH——grid 行轨
                         * repeat(N, auto) 随 grid item 高度生长，同线全部章槽同值
                         * 下限即整行下限（泳道标签/待编排格 stretch 对齐同一行，
                         * 行高 = max(laneH, 标签高, 待编排堆高)）。「行高随轨道
                         * 自动增长」的驱动位；minLaneHeight 40 地板使浅线行不塌。 */
                        minHeight: packing?.laneHeight,
                      }}
                      data-slot-line={row.lineId}
                      data-chapter={c}
                      /* R1 空槽落点（#70 症状②）+ §6.3 槽位唯一路由缝：容器面准入 +
                          onDrop。gap 章轨仅阻断光标不接 drop。 */
                      onDragOver={droppable ? edit.onCellDragOver : onBlockedDragOver}
                      onDrop={
                        droppable
                          ? (e) => {
                              edit.onSlotDrop(resolveSlotDropColumn(e, e.currentTarget))(e);
                            }
                          : undefined
                      }
                    >
                      {(chips ?? []).map((chip) => {
                        /* T23 装填盒：线行内 chip 全部绝对定位消费装填输出（x=锚列
                         * 起算跨列宽、y=天际线值）；chip 仍渲染为归属槽 DOM 子节点
                         * （closest('.workbench-slot') 测试/探针契约不变）。height 仅
                         * 实测帧带上（measuredHeights 命中该卡）——估算帧内容自撑。 */
                        const packed = packing?.byNode.get(chip.nodeId);
                        return (
                          <WorkbenchChip
                            key={`${chip.nodeId}|${chip.lineId}`}
                            chip={chip}
                            box={
                              packed
                                ? {
                                    left: packed.xCols * WORKBENCH_PACKING_GEO.colWidth,
                                    top: packed.y,
                                    width: packed.width,
                                    ...(measuredHeights?.has(`${chip.nodeId}|${chip.lineId}`)
                                      ? { height: packed.height }
                                      : {}),
                                  }
                                : undefined
                            }
                            nodeIssues={nodeIssues.get(chip.nodeId)}
                            onSceneClick={setSelectedNodeId}
                            selectedNodeId={selectedNodeId}
                            onSceneDragStart={edit.onSceneDragStart}
                            /* T16b：dragend 兜底清场（hook 侧抓起列记录的收尾缝）。 */
                            onSceneDragEnd={edit.endSceneDrag}
                            onResizeSpanRange={edit.onResizeSpanRange}
                            resolveColumnAt={resolveColumnAtClientX}
                            /* T15 实时变宽：预览盒的列几何 seam（与列命中同一 rect 表
                               单源，÷zoom 归一——见 resolveColumnBoxAt 注）。 */
                            resolveColumnBox={resolveColumnBoxAt}
                            builtMinCol={builtMinCol}
                            builtMaxCol={builtMaxCol}
                            /* H1 移交接线（CR3 G-F3）：已建章集喂 resize 预览的 gap 门槛——
                               gap 轨与解析失败同处（保持上一预览），预览永不承诺未建章。 */
                            builtColumnSet={episodeIndexSet}
                            canExtendRight={episodeIndexSet.has(chip.colEnd + 1)}
                            handleHint={handleHint}
                          />
                        );
                      })}
                      {droppable && !(chips ?? []).length && !spanCovered.has(c) && (
                        /* R12 空章淡标注（追加批3「章消失了吗」观感消解）：空且可落
                            时一行淡字，hover 提亮（样式位 .workbench-slot-empty-note
                            归 V 片 css 尾段）。span 覆盖列不出（见 spanCovered 注）。
                            （顺手新建入口 T24 起在章列头「＋」，不在格内。） */
                        <span className="workbench-slot-empty-note">
                          {t('structure.workbench.emptyNote')}
                        </span>
                      )}
                    </div>
                  );
                })}
                {/* 待编排格：灰态收纳 + 钉右（批 8.2）+ 每线待编排计数器（R7）
                    + 落点（#63 拖回待编排 = 撤章归属）。 */}
                <WorkbenchPendingSlot
                  lineId={row.lineId}
                  rowIndex={rIdx}
                  gridColumn={pendingColumn}
                  chips={pendingByLine.get(row.lineId) ?? []}
                  nodeIssuesByNode={nodeIssues}
                  selectedNodeId={selectedNodeId}
                  onSelectScene={setSelectedNodeId}
                  onSceneDragStart={edit.onSceneDragStart}
                  onSceneDragEnd={edit.endSceneDrag}
                  onCellDragOver={edit.onCellDragOver}
                  onPendingCellDrop={edit.onPendingCellDrop}
                  counterLabel={(n) => t('structure.lane.pendingCount', { n })}
                />
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* R8/R11：列头·空白右键菜单（TimelineContextMenu 复用——与因果区同一呈现件；
          fixed 定位与挂载点解耦）。items 在 render 期构造——菜单是短命浮层，开着时
          数据变（并发 patch）下一帧重建，无 stale 问题。 */}
      {menu && (
        <TimelineContextMenu
          x={menu.x}
          y={menu.y}
          items={buildColumnMenuItems(menu.colValue)}
          onClose={() => setMenu(null)}
          ariaLabel={t('structure.ctx.menuLabel')}
        />
      )}
    </section>
  );
}

// ── 待编排格（批 8.2/8.3 承接 + R7 计数器化 + T8 滚动栈内化）──
//
// 「+N」溢出徽标退役（R7）：改为每线一枚待编排计数器报**总数**（slot 右上角
// absolute 钉驻——两区「宿主右上角小徽标」统一口径）；#65 封顶语义不变：全量渲染
// + `.pending-overflow` 变体类按「总数 > 初见枚数」挂在**内层 .workbench-pending-
// stack**（T8 起 scroll 容器内迁——外层 slot 是计数器的非滚动定位锚，计数器不进
// 滚动层＝零漂移的结构性保证），CSS 高度封顶 + 常驻滚轮可达，封顶阈值单源
// WORKBENCH_GEOMETRY.pendingStackVisibleCount。
//
// #63：本格是合法落点；chip 卸掉了全部 drop 面（§6.3 槽位唯一路由缝）——
// 落在 chip 上方的 drop 经内层 stack 冒泡到本槽位处理器，每次恰一次写入。

type WorkbenchPendingSlotProps = {
  lineId: string;
  rowIndex: number;
  /** 待编排虚拟列的 grid column 号（1-based，宿主共享轨道末位）。 */
  gridColumn: number;
  chips: PendingChipData[];
  nodeIssuesByNode: Map<string, SceneGraphIssue[]>;
  selectedNodeId?: string | null;
  onSelectScene?: (nodeId: string | null) => void;
  onSceneDragStart: (nodeId: string) => (e: DragEvent) => void;
  /** T16b：dragend 兜底清场（灰片拖入章格的手势同样经此收尾）。 */
  onSceneDragEnd: () => void;
  onCellDragOver: (e: DragEvent) => void;
  onPendingCellDrop: (e: DragEvent) => void;
  /** 计数器文案格式化（i18n structure.lane.pendingCount，{n}=该线未编排总数）。 */
  counterLabel: (total: number) => string;
};

function WorkbenchPendingSlot({
  lineId,
  rowIndex,
  gridColumn,
  chips,
  nodeIssuesByNode,
  selectedNodeId,
  onSelectScene,
  onSceneDragStart,
  onSceneDragEnd,
  onCellDragOver,
  onPendingCellDrop,
  counterLabel,
}: WorkbenchPendingSlotProps) {
  const overflow = chips.length > WORKBENCH_GEOMETRY.pendingStackVisibleCount;
  return (
    // T8（发现批4·深夜二轮目检）：外层 slot 降为**非滚动宿主**——position:relative
    // 锚 + drop 面 + pin-right + 不透明底全保留；封顶/常驻滚轮/渐隐随 chips 搬进
    // 内层 .workbench-pending-stack（pending-overflow 变体类随之内迁——cssLock/
    // 组件测试按新落位断言）。计数器挂 slot 直下（absolute 恒钉右上角），**不在
    // 滚动容器内**＝零漂移的结构性保证（V-F3「随滚漂移」根除，T6 负 margin 退役）。
    <div
      className="workbench-slot workbench-slot--pending structure-pin-right"
      style={{ gridColumn, gridRow: rowIndex + 3 }}
      data-slot-line={lineId}
      data-chapter="pending"
      onDragOver={onCellDragOver}
      onDrop={onPendingCellDrop}
    >
      {chips.length > 0 && (
        /* R7：每线待编排计数器（slot 右上角 absolute 钉驻位；数值锚 data-pending-total；
            aria/title 保留——title 因 pointer-events:none 不再悬浮触发，读屏走 aria-label）。 */
        <span
          className="lane-pending-counter"
          data-pending-total={chips.length}
          aria-label={counterLabel(chips.length)}
          title={counterLabel(chips.length)}
        >
          {chips.length}
        </span>
      )}
      <div className={`workbench-pending-stack${overflow ? ' pending-overflow' : ''}`}>
        {chips.map((chip) => (
          <WorkbenchChip
            key={`wpending-${chip.nodeId}|${chip.lineId}`}
            chip={chip}
            nodeIssues={nodeIssuesByNode.get(chip.nodeId)}
            onSceneClick={onSelectScene}
            selectedNodeId={selectedNodeId}
            onSceneDragStart={onSceneDragStart}
            onSceneDragEnd={onSceneDragEnd}
          />
        ))}
      </div>
    </div>
  );
}
