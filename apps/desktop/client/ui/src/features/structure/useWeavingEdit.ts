/**
 * Story 1.10 W3 (design §6)：章节工作台的场景内编辑层（08-26 批 3 随 WeavingCell
 * → WorkbenchChip 全量迁移——写通道不变）。Gesture families:
 *
 *   1. Scene drop onto a `.workbench-slot`（CR 组 3c 裁决 2B「跨区拖=挪章」+ R6 §6.3
 *      槽位路由升级）：**落点的章归属由视图层解析、写分派在本 hook 单缝**——
 *      - 宽卡（colEnd>colStart）→ 整区间平移保持宽度（applyResizeSpanRange）：
 *        有抓起列（T16b 位移式）= 位移 = 落列 − 抓起列（位移 0 = 拖起放回取消；
 *        自身覆盖列内的其余落点**不再**整区间静默取消——「8→7 能拖、7→8 拖不回」
 *        真机红的根因）；缺省 originCol = T 锚定平移 + 投回自身覆盖列取消式投放
 *        零写入（CR3 G-F2）双语义原样保留；钳制域与渲染侧同口径、落点撞 gap 降
 *        列到最近全建区间（CR3 G-F4/edge）；
 *      - 落点表面恰为同格兄弟 chip 且解析列一致 → 章内 pos 重排（双方均单章——
 *        宽卡成员的 po.pos 是 spans[0].pos 锚，不入重排面，CR3 G-edge）；
 *      - 其余 → 挪章（applyChapterDrop，span/legacy 遮蔽字段随写剥除）——含
 *        pending/dangling 灰片拖入章格的**补挂章节**（CR3 auditor：旧静默封锁偏离
 *        §6.3 且与因果区 useTimelineEdit 失同步）。
 *      目标列 null = 拒收（gap 章 / 待编排带 / 列缝）零写入。
 *   2. Drop onto the pending surface = 撤章归属（#63，哨兵章写入）。
 *   3. 边缘直拖（R6 方案 D）：pointer 手势在 WorkbenchChip 内完成预览，
 *      pointerup 时经 {@link useWeavingEdit.onResizeSpanRange} 一次 dispatch
 *      applyResizeSpanRange——一次手势一次写的铁律不变。
 *
 *   （历史注记：«± 新增/减少章节»按钮手势已整体退役（R6 方案 D——低频高破坏面的
 *    span 编辑退居边缘直拖），applyAddChapter/applyRemoveChapter 随其唯一消费者删除。）
 *
 * Paradigm guard (prd §6 / 范式判据): these mutate only DETERMINISTIC fields
 * (`presentationSpans` / `presentationOrder`) via the author's direct gesture.
 * No semantic judgement — which chapters a scene SHOULD span, anchor role, etc.
 * stay the LLM agent's job. The apply* helpers are pure arithmetic and live in
 * sceneGraphEditModel; the hook is the only I/O seam (reads store, writes via
 * `updateField`).
 *
 * Write timing: ONE `updateField` per gesture — never per dragover — same as
 * `useTimelineEdit` (design §2.2). No-op guards short-circuit same-state gestures;
 * pure helpers return the ORIGINAL graph reference on true no-ops so handlers skip
 * the write entirely（引用级守卫——版本 bump / undo 入栈 / sync IPC 落盘零发生）。
 *
 * 写通道例外声明（与 useTimelineEdit 头注同款，理由全文见 sceneGraphEditModel）：
 * drop 手势直构下一张图走 updateField，未经投影器；待 op 类型化后收口。
 */
import { useCallback, useRef } from 'react';
import type { DragEvent } from 'react';
import type { z } from 'zod';
import type { SceneGraph } from '@orison/shared-contracts';
import { episodeOutlineSchema } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { isSceneGraphLike } from './layout';
import {
  episodeTrackCountOf,
  resolveSceneChapterRange,
  PENDING_CHAPTER_SENTINEL,
} from './workbenchLayout';
import {
  SCENE_DRAG_MIME,
  applyChapterDrop,
  applyPendingDrop,
  applyResizeSpanRange,
  decodeDragPayload,
  encodeDragPayload,
} from './sceneGraphEditModel';

type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

// ── drag payload（编解码单源 sceneGraphEditModel；mode 判别退役——来源不再是行为
//    分叉轴，「跨区拖=挪章」语义对所有场景拖拽一致）──

/** `[start..start+len]` 全部已建章判定（宽卡平移落点的稠密段检查）。 */
function intervalAllBuilt(
  byIndex: Map<number, EpisodeOutline>,
  start: number,
  len: number
): boolean {
  for (let c = start; c <= start + len; c++) {
    if (!byIndex.get(c)) return false;
  }
  return true;
}

/**
 * Slot 落点路由的单次图手术（§6.3 写分派；抽出为模块级纯编排供单测——hook 的
 * onSlotDrop 只是 store 读 + 本函数 + updateField 的 I/O 三明治）。
 *
 * @param e        原生 drop 事件（目标链用于「同格兄弟 chip」命中；jsdom 直投与
 *                 真实浏览器顶面元素同语义）
 * @param targetChapter 视图层解析出的目标列（null = 拒收，零写入）
 * @param originCol T16b（发现批8）：抓起列（dragstart 时解析的 colStart）。有值且
 *                 有限时宽卡分支改**位移式平移**：shift = target − originCol
 *                 （位移 0 = 拖起放回 → 原引用零写；否则 newStart = colStart +
 *                 shift 走既有钳制 + gap 降列）。缺省 = 旧行为原样（投回自身覆盖
 *                 列取消、否则 T 锚定平移）——既有直接调用向后兼容。单章分支不
 *                 消费（drop 列即目标章）。
 */
export function applyWorkbenchSlotDrop(
  graph: SceneGraph,
  opts: {
    nodeId: string;
    targetChapter: number | null;
    episodes: EpisodeOutline[];
    /** 事件目标的最近非 pending chip 的 nodeId（兄弟重排候选）。 */
    hitSiblingId?: string | null;
    originCol?: number;
  }
): SceneGraph {
  const { nodeId, targetChapter, episodes, hitSiblingId, originCol } = opts;
  if (!Array.isArray(episodes)) return graph; // CR-001 parity（CR3 G-edge）：导出纯函数 never-throws
  if (targetChapter === null || !Number.isFinite(targetChapter)) return graph;
  const target = Math.floor(targetChapter);
  if (!episodes.map((e0) => e0.index).includes(target)) return graph; // gap / 未建章 → 拒收

  const byId = new Map(episodes.map((e0) => [e0.id, e0] as const));
  const byIndex = new Map(episodes.map((e0) => [e0.index, e0] as const));
  const dragged = graph.nodes.find((n) => n.id === nodeId);
  if (!dragged) return graph;
  const draggedRange = resolveSceneChapterRange(dragged, byId, byIndex);
  if (!draggedRange) {
    // pending/dangling 灰片 → 章格 = **补挂章节**（CR3 auditor 高危：旧 `return graph`
    // 把该通道静默封锁——偏离 §6.3「其余=挪章」且与因果区 useTimelineEdit.onDrop 失
    // 同步）。applyChapterDrop 剥遮蔽残锚 + 写目标章；灰片互拖的落点在 pending 堆
    // （onPendingCellDrop 哨兵缝），不经本函数。
    return applyChapterDrop(graph, nodeId, target);
  }

  // ① 同格兄弟 chip 表面 + 落点列即被拖场景**当前解析列** → 章内 pos 重排。
  //    （第三个等号不可省：投掷到「异章兄弟 chip 表面」是挪章契约（裁决 2B）——
  //    章内重排按共享格分组，跨章时找不到成员只会静默 no-op 吞掉整次手势。）
  //    宽卡无此语义——宽度优先保真（AC10 操作半）；**兄弟亦须单章**（CR3 G-edge）：
  //    宽 sibling 的 po.pos 是其 spans[0].pos 的锚，重编号会写飞锚点。
  const singleChapter = draggedRange.colEnd === draggedRange.colStart;
  if (
    hitSiblingId
    && hitSiblingId !== nodeId
    && singleChapter
    && draggedRange.colStart === target
  ) {
    const sibling = graph.nodes.find((n) => n.id === hitSiblingId);
    const siblingRange = sibling ? resolveSceneChapterRange(sibling, byId, byIndex) : null;
    if (
      siblingRange
      && siblingRange.colStart === siblingRange.colEnd // 宽 sibling 不入重排面
      && siblingRange.colStart === target
    ) {
      return applyWithinChapterDrop(graph, nodeId, hitSiblingId, episodes);
    }
  }

  // ② 归属写入：宽卡=整区间平移保持宽度（超已建域向下钳）；单章=挪章。
  if (draggedRange.colEnd > draggedRange.colStart) {
    const len = draggedRange.colEnd - draggedRange.colStart;
    // 钳制域与渲染侧同口径（CR3 G-F4）：episodeTrackCountOf 只数 MAX_CHAPTER_TRACKS
    // 封顶域内的章——raw 全集 max 会含界外离群 index，把「渲染可见列上的合法落点」
    // 夹进端点校验必拒的区间、整手势被静默吞。
    const maxBuilt = episodeTrackCountOf(episodes) - 1;
    // T16b 位移式平移（有抓起列）：锚点 = 现起点 + 位移量（手势中无并发写时恒等于
    // 落列——位移式与 T 锚定的分野只在取消判据与并发写语义上）。
    const originRaw = typeof originCol === 'number' ? originCol : Number.NaN;
    const origin = Number.isFinite(originRaw) ? Math.floor(originRaw) : null;
    const anchor = origin !== null ? draggedRange.colStart + (target - origin) : target;
    if (origin !== null && anchor === draggedRange.colStart) {
      // 位移 0 = 拖起放回——取消式投放（G-F2 语义收窄到「放回抓起列」原样保留）：
      // 无意图手势零位移写（版本 bump / undo 入栈 / 落盘零发生）。
      return graph;
    }
    if (origin === null) {
      // 宽卡投回自身覆盖列 = 取消式投放（拖起又放回）→ 原引用零写入（CR3 G-F2）：
      // 旧实现以 T 锚定平移会让无意图手势产生真实位移写；真实平移意图的落点必然
      // 在自身区间之外。拖回起点章的既有短路路径（内容相等原引用）由此一并保留。
      // （originCol 缺省路径原样——既有直接调用/旧测试行为零变化。）
      if (target >= draggedRange.colStart && target <= draggedRange.colEnd) return graph;
    }
    // 钳制落点撞 gap（缺号章）→ 降列到最近「整区间全建」的可落位（CR3 G-edge）：
    // 直投 applyResizeSpanRange 会被整区间守卫原引用拒收、整次手势吞掉零反馈。
    // 无可落位（宽度大于任意稠密段）由该守卫兜底拒收（原引用）。
    let start = Math.min(Math.max(0, anchor), Math.max(0, maxBuilt - len));
    while (start > 0 && !intervalAllBuilt(byIndex, start, len)) start--;
    return applyResizeSpanRange(graph, nodeId, start, start + len, episodes);
  }
  return applyChapterDrop(graph, nodeId, target);
}

/**
 * Single-scene positional drag: move `draggedId` to just before `targetNodeId`
 * inside their shared **visual** chapter, renumbering pos 0..n there. 视觉章 =
 * 解析口径起点（episode 数据传入时）∥ 裸 presentationOrder.chapter 回退——同视觉格
 * 异 raw 章号的 legacy 兄弟由此纳入同一重排面（CR 组 5「silent no-op」洞消解）。
 *
 * No-op（返回原引用）：双方同 id、缺席、缺 presentationOrder、跨章、**pending 哨兵
 * 章**（灰片互拖不产生隐形 pos 重编号写）、被拖节点不在共享章成员里、**任一相关
 * 方为多章宽卡**（CR3 G-edge：宽成员的 po.pos 是 spans[0].pos 锚，不入重排面），或
 * 整体顺序本就未变。Pure — input never mutated。
 */
export function applyWithinChapterDrop(
  graph: SceneGraph,
  draggedId: string,
  targetNodeId: string,
  episodes?: EpisodeOutline[]
): SceneGraph {
  if (draggedId === targetNodeId) return graph;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const dragged = nodeById.get(draggedId);
  const target = nodeById.get(targetNodeId);
  if (!dragged || !target) return graph;
  // F4 (CR-001 parity): guard missing presentationOrder under partial hydration —
  // the render path defends; the edit path must too or `.chapter` throws.
  if (!dragged.presentationOrder || !target.presentationOrder) return graph;

  let byId: Map<string, EpisodeOutline> | undefined;
  let byIndex: Map<number, EpisodeOutline> | undefined;
  if (Array.isArray(episodes)) {
    byId = new Map(episodes.map((e) => [e.id, e] as const));
    byIndex = new Map(episodes.map((e) => [e.index, e] as const));
  }
  /** 成员的视觉章：解析口径优先（有数据时），否则裸章号；解析失败 → null。 */
  const visualChapterOf = (node: SceneGraph['nodes'][number]): number | null => {
    if (byId && byIndex) {
      const range = resolveSceneChapterRange(node, byId, byIndex);
      return range ? range.colStart : null;
    }
    return node.presentationOrder?.chapter ?? null;
  };

  const chapter = visualChapterOf(dragged);
  if (chapter === null) return graph; // dangling/pending —— 无真实章语义可重排
  if (chapter === PENDING_CHAPTER_SENTINEL) return graph; // pending 堆内互拖 → no-op
  if (visualChapterOf(target) !== chapter) return graph; // cross-chapter → no-op

  // **多章（宽卡）成员不入重排面**（CR3 G-edge）：其 po.pos 是 spans[0].pos 的锚
  // （首段阅读位），章内重编号会写飞锚点（po 与 spans[0] desync）——宽卡宽度优先
  // 保真，无章内序语义。无 episodes 数据时宽度不可判：裸口径下 span 成员本就解析
  // miss 被 visualChapterOf 排除，该过滤仅在解析面生效。
  const wideMember = (node: SceneGraph['nodes'][number]): boolean => {
    if (!(byId && byIndex)) return false;
    const range = resolveSceneChapterRange(node, byId, byIndex);
    return range !== null && range.colEnd > range.colStart;
  };

  // Siblings in the shared VISUAL chapter, stable-sorted by (pos, original index).
  // `?.` 化（CR 组 5 三洞之一）：legacy 第三方缺 presentationOrder 不再 TypeError，
  // 其 pos 按 0 参与排序（渲染路径对缺章形态的容忍口径一致）。
  const siblings = graph.nodes
    .map((node, idx) => ({ node, idx }))
    .filter(({ node }) => visualChapterOf(node) === chapter && !wideMember(node))
    .sort(
      (a, b) =>
        (a.node.presentationOrder?.pos ?? 0) - (b.node.presentationOrder?.pos ?? 0)
        || a.idx - b.idx
    );
  const draggedEntry = siblings.find((s) => s.node.id === draggedId);
  if (!draggedEntry) return graph; // 被拖者自身是宽卡（直调路径）——重排仅限单章成员
  // Remove dragged, insert just before target.
  const without = siblings.filter((s) => s.node.id !== draggedId);
  const targetPos = without.findIndex((s) => s.node.id === targetNodeId);
  if (targetPos < 0) return graph; // defensive（含宽卡 target 被过滤的组合）
  without.splice(targetPos, 0, draggedEntry);

  // Renumber pos 0..n in the new order. 全序未变 → 返回原引用（引用级 no-op）。
  const newPos = new Map<string, number>();
  let changed = false;
  without.forEach((s, i) => {
    newPos.set(s.node.id, i);
    if ((s.node.presentationOrder?.pos ?? i) !== i) changed = true;
  });
  if (!changed) return graph;

  const nodes = graph.nodes.map((node) => {
    const pos = newPos.get(node.id);
    return pos !== undefined && node.presentationOrder
      ? { ...node, presentationOrder: { ...node.presentationOrder, pos } }
      : node;
  });
  return { ...graph, nodes };
}

// ── the hook ──

/**
 * Wire chip drops for the workbench (slot-surface routing, §6.3) + edge-resize
 * commit. Reads the latest scene_graph + episode_outlines from the store at
 * gesture time via `useAppStore.getState()` (stable callbacks, no stale closure).
 * Writes ONE updateField per gesture; no-op guards skip same-state gestures.
 */
export function useWeavingEdit() {
  const updateField = useAppStore((s) => s.updateField);

  /**
   * T16b（发现批8）：dragstart 时记录的抓起列（store 实时解析的 colStart）——宽卡
   * 投放由此获得「位移式平移」语义（位移 = 落列 − 抓起列）：自身覆盖列内的落点
   * 不再整区间静默取消（真机红「8→7 能拖、7→8 拖不回」——G-F2 的取消区把宽卡自己
   * 的第二覆盖列也圈了进去），仅「位移 0 = 拖起放回」保留取消式零写。
   *
   * 生命周期（T14 中断面纪律同族）：drop 两条缝消费即清 + dragend 兜底清（HTML5
   * 拖拽对 drop 与取消路径恒发 dragend——blur/他位落指不参与）；卸载随 hook 实例
   * 消亡（ref 组件级，无全局残留面）；nodeId 配对防陈旧记录被后续异手势误读。
   */
  const dragOriginRef = useRef<{ nodeId: string; col: number } | null>(null);

  /**
   * R6 方案 D：边缘直拖的提交缝（预览在 WorkbenchChip 内、此处一次 dispatch）。
   * 列合法性由 applyResizeSpanRange 自校验（越界/非法 → 原引用 → 整写跳过）。
   */
  const onResizeSpanRange = useCallback(
    (nodeId: string, newStartCol: number, newEndCol: number) => {
      const { graph, episodes } = readGraphAndEpisodes();
      if (!graph || !episodes) return;
      const next = applyResizeSpanRange(graph, nodeId, newStartCol, newEndCol, episodes);
      if (next === graph) return; // 引用级 no-op——非法区间/内容相等零写入
      updateField('scene_graph', next);
    },
    [updateField]
  );

  const onSceneDragStart = useCallback(
    (nodeId: string) => (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(SCENE_DRAG_MIME, encodeDragPayload({ nodeId }));
      // T16b：抓起列随起手记录（store 实时解析——chip props 可能滞后一帧）。解析
      // miss（pending/dangling 灰片）不记录，drop 按无 originCol 旧语义走；失败路
      // 显式清空（陈旧手势记录不跨手势存活）。
      const { graph, episodes } = readGraphAndEpisodes();
      const node = graph?.nodes.find((n) => n.id === nodeId);
      if (!graph || !episodes || !node) {
        dragOriginRef.current = null;
        return;
      }
      const byId = new Map(episodes.map((e0) => [e0.id, e0] as const));
      const byIndex = new Map(episodes.map((e0) => [e0.index, e0] as const));
      const range = resolveSceneChapterRange(node, byId, byIndex);
      dragOriginRef.current = range ? { nodeId, col: range.colStart } : null;
    },
    []
  );

  /** T16b：拖拽收尾清场（dragend 兜底——drop 之外的取消路径也经此到达）。 */
  const endSceneDrag = useCallback(() => {
    dragOriginRef.current = null;
  }, []);

  // HTML5: dragover admits only scene drags（types 可读期间判 MIME——外来 DnD 得到
  // 阻断光标且永不到 drop）；槽位容器面是唯一准入路由（§6.3——chip 不再挂 drop 面，
  // 冒泡双写根除），chip 上方的光标放行由冒泡到本 handler 承接。
  const onCellDragOver = useCallback((e: DragEvent) => {
    const types = e.dataTransfer?.types;
    if (!(Array.isArray(types) && types.includes(SCENE_DRAG_MIME))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  /**
   * 槽位落点路由（§6.3）：目标章 T 由视图层解析传入（null=拒收）；被拖节点、
   * 宽卡平移/兄弟重排/挪章的分派见 {@link applyWorkbenchSlotDrop}。
   */
  const onSlotDrop = useCallback(
    (targetChapter: number | null) =>
      (e: DragEvent) => {
        e.preventDefault();
        const payload = decodeDragPayload(e.dataTransfer.getData(SCENE_DRAG_MIME));
        if (!payload) return; // not a scene drag
        const { graph, episodes } = readGraphAndEpisodes();
        if (!graph || !episodes) return;
        // 兄弟 chip 命中：事件目标的最近非 pending 工作台 chip（真实浏览器=指针顶面
        // 元素，jsdom 合成事件=直投目标——同语义）。
        const hitEl =
          e.target instanceof Element
            ? e.target.closest('.workbench-chip[data-node-id]:not(.workbench-chip--pending)')
            : null;
        // T16b：同手势起手记录的抓起列（nodeId 配对——外来/陈旧载荷走缺省旧语义）。
        const origin = dragOriginRef.current;
        const originCol =
          origin && origin.nodeId === payload.nodeId ? origin.col : undefined;
        const next = applyWorkbenchSlotDrop(graph, {
          nodeId: payload.nodeId,
          targetChapter,
          episodes,
          hitSiblingId: hitEl?.getAttribute('data-node-id') ?? null,
          originCol,
        });
        dragOriginRef.current = null; // 消费即清（防异常路径悬空被后续手势误读）
        if (next === graph) return; // 引用级 no-op（拒收/内容相等）
        updateField('scene_graph', next);
      },
    [updateField]
  );

  /**
   * #63：待编排面落点（拖回待编排 = 撤章归属，哨兵章写入 + 遮蔽剥离）。已在
   * 待编排态的重复落点由 applyPendingDrop 原引用返回 → 此处零写入。
   */
  const onPendingCellDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const payload = decodeDragPayload(e.dataTransfer.getData(SCENE_DRAG_MIME));
      if (!payload) return;
      dragOriginRef.current = null; // T16b：drop 缝消费即清（手势在此收束）
      const { graph } = readGraphAndEpisodes();
      if (!graph) return;
      const next = applyPendingDrop(graph, payload.nodeId);
      if (next === graph) return; // 已是哨兵态——防全量重写
      updateField('scene_graph', next);
    },
    [updateField]
  );

  return {
    onResizeSpanRange,
    onSceneDragStart,
    endSceneDrag,
    onCellDragOver,
    onSlotDrop,
    onPendingCellDrop,
  };
}

/** Read the latest scene_graph + episode_outlines from the store at gesture time. */
function readGraphAndEpisodes(): {
  graph: SceneGraph | null;
  episodes: EpisodeOutline[] | null;
} {
  const rawGraph = useAppStore.getState().creativeFields.scene_graph as SceneGraph | undefined;
  const graph = isSceneGraphLike(rawGraph) ? rawGraph : null;
  const episodes = useAppStore.getState().creativeFields.episode_outlines;
  return {
    graph,
    episodes: Array.isArray(episodes) ? (episodes as EpisodeOutline[]) : null,
  };
}
