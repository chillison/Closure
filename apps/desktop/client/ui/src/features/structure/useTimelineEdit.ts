/**
 * Story 1.5 Phase E3-drag: the author's direct-gesture edit layer for the
 * timeline. Links + validation re-derive reactively on drop — no extra plumbing
 * (the memos in NarrativeTimelinePanel / ValidationOverlay are the seam).
 *
 * ── 08-26 结构页重构 批 7（design §11 定案 1：因果骨架换轴章轴）──
 * 因果列头/格的 drop 目标语义从 storyTime 改为**章 index**
 * （presentationOrder.chapter 直写——与工作台 ± 章手势同一条 presentation 数据面；
 * 章写通道既有，双通道铁律不破）。storyTime 拖拽写入随等距桶退役删除。
 * `applyChapterDrop` 是纯算术；hook 是唯一 I/O 缝（读 store，`updateField` 写）。
 *
 * ── CR 组5/组3c 批 A（拖拽写通道族）──
 * - 编解码与落图纯函数单源迁 `sceneGraphEditModel`（SCENE_DRAG_MIME /
 *   encodeDragPayload / decodeDragPayload / applyChapterDrop / applyPendingDrop）；
 *   本文件 re-export 维持旧 import 路径，hook 只剩 store 读写 I/O。
 * - no-op 判据升级为**解析口径**（resolveSceneChapterRange 的 colStart，缺解析回退
 *   裸章号）：带 spans/episodeId 遮蔽字段的场景按视觉章位判等——落回自己视觉列零
 *   写入；applyChapterDrop 返回原引用时整次 updateField 跳过（版本/undo/落盘零发生）。
 * - **gap 轨道拒收**：真实 episode 缺席的稠密空轨不再绑定 drop 目标（写 gap 章 =
 *   被解析序静默改判 pending——承诺的是归入章）；调用方以
 *   `isDroppableChapter` 门控绑定（NTP 传 episodeIndexSet）。
 * - 拖拽写通道 vs 投影器（文档化例外，裁决落案见 sceneGraphEditModel 头注同段）：
 *   drop 直构下一张图走 updateField，不经 applySceneGraphActions——单字段机械变异
 *   与 ± 章按钮同构；op 类型化（chapter_assign/pending_unassign）需动
 *   shared-contracts 投影器，落在批次文件面之外，例外在此声明待后续收口。
 *
 * Write timing: ONE `updateField` per drop (never per dragover) — design §2.2.
 *
 * Multi-line node: dragging edits the NODE (one presentationOrder per node) — all
 * its cards (one per lineTag) follow automatically on re-render. No per-cell state.
 */
import { useCallback } from 'react';
import type { DragEvent } from 'react';
import type { z } from 'zod';
import type { SceneGraph } from '@orison/shared-contracts';
import { episodeOutlineSchema } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { isSceneGraphLike } from './layout';
import {
  SCENE_DRAG_MIME,
  SceneDragPayload,
  applyChapterDrop,
  applyPendingDrop,
  decodeDragPayload,
  encodeDragPayload,
} from './sceneGraphEditModel';
import { resolveSceneChapterRange } from './workbenchLayout';

type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

// ── drag payload codec（单源在 sceneGraphEditModel；此处 re-export 保旧路径）──

export { SCENE_DRAG_MIME, encodeDragPayload, decodeDragPayload, applyChapterDrop, applyPendingDrop };
export type { SceneDragPayload };

export function isSceneDragDataTransfer(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return Array.isArray(types) ? types.includes(SCENE_DRAG_MIME) : false;
}

/** 形状守卫后的可编辑图读取缝（三个 drop 处理器同款守卫套件）。 */
function readEditableGraph(): SceneGraph | null {
  const raw = useAppStore.getState().creativeFields.scene_graph as SceneGraph | undefined;
  return isSceneGraphLike(raw) ? raw : null;
}

/** 当前的 episode_outlines（非数组防御性归 null）。 */
function readEpisodes(): EpisodeOutline[] | null {
  const eps: unknown = useAppStore.getState().creativeFields.episode_outlines;
  return Array.isArray(eps) ? (eps as EpisodeOutline[]) : null;
}

// ── the hook ──

/**
 * Wire drag-onto-SceneCard + drop-targets for the causal skeleton. Returns
 * bound handlers:
 *   - `onDragStart(nodeId)` — attach to a SceneCard (draggable when bound).
 *   - `onDragOver`          — attach to each drop target; admits only scene drags
 *                             (MIME in dataTransfer.types → move cursor), foreign
 *                         DnD gets the blocked cursor and never reaches onDrop.
 *   - `onDrop(chapter)`     — attach to each chapter-shaped drop target of a REAL
 *                             episode column; writes the dragged scene's chapter once.
 *
 * The hook reads the latest scene_graph from the store at drop-time via
 * `useAppStore.getState()` so callbacks stay stable across re-renders (no stale
 * closure).
 */
export function useTimelineEdit() {
  const updateField = useAppStore((s) => s.updateField);

  const onDragStart = useCallback(
    (nodeId: string) => (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(SCENE_DRAG_MIME, encodeDragPayload({ nodeId }));
    },
    []
  );

  // HTML5: payload is hidden until drop, but `types` IS readable during
  // dragover — gate on our MIME so foreign DnD shows the blocked cursor
  // (no preventDefault → no drop fires) instead of a lying "move" affordance.
  // 死方向光标反馈修正（CR 组 3c 裁决 2B 附款）。
  const onDragOver = useCallback((e: DragEvent) => {
    if (!isSceneDragDataTransfer(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  /**
   * 拒收面的 dragover（gap 章轨——真实 episode 缺席的稠密空轨）：阻断光标 +
   * 不 preventDefault（HTML5 下 drop 永不触发）。写 gap 章会被解析序静默改判
   * pending——承诺的「归入章」不能兑现，干脆不收。
   */
  const onBlockedDragOver = useCallback((e: DragEvent) => {
    e.dataTransfer.dropEffect = 'none';
  }, []);

  const onDrop = useCallback(
    (targetChapter: number) => (e: DragEvent) => {
      e.preventDefault();
      const payload = decodeDragPayload(e.dataTransfer.getData(SCENE_DRAG_MIME));
      if (!payload) return; // not a scene drag (foreign DnD, empty, or malformed)
      const graph = readEditableGraph();
      if (!graph) return;
      // CR-001/CR-001 形状套件：节点在场且带章数据才可判 no-op、才可写——缺章形态
      // 编辑路径与渲染路径同样守卫（不得更脆）。
      const dragged = graph.nodes.find((n) => n.id === payload.nodeId);
      if (!dragged || !dragged.presentationOrder) return;
      // No-op 判据 = 解析口径的视觉章位（非裸 chapter——遮蔽字段下两者可分叉）。
      const episodes = readEpisodes();
      let currentChapter = dragged.presentationOrder.chapter;
      let draggedRange: ReturnType<typeof resolveSceneChapterRange> = null;
      if (episodes) {
        const byId = new Map(episodes.map((e0) => [e0.id, e0] as const));
        const byIndex = new Map(episodes.map((e0) => [e0.index, e0] as const));
        draggedRange = resolveSceneChapterRange(dragged, byId, byIndex);
        if (draggedRange) currentChapter = draggedRange.colStart;
      }
      // D-1 统一取消式（08-27 拍板，对齐工作台 applyWorkbenchSlotDrop 的取消语义——
      // 两区同语义）：被拖宽卡投回**自身覆盖区间内**任意列 = 取消式投放零写。旧路径
      // 只比区间起点，落中段（target ∈ (colStart, colEnd]）会走 applyChapterDrop 剥
      // spans 塌缩成单章——「拖起又放回」产生真实破坏写。真实移动意图的落点必在
      // 区间之外（单章场景的 containment 等价于下方 colStart 等值短路，行为不变）。
      if (
        draggedRange
        && targetChapter >= draggedRange.colStart
        && targetChapter <= draggedRange.colEnd
      ) {
        return;
      }
      if (currentChapter === targetChapter) return;
      const next = applyChapterDrop(graph, payload.nodeId, targetChapter);
      if (next === graph) return; // 引用级 no-op——内容相等，零写入
      updateField('scene_graph', next);
    },
    [updateField]
  );

  /**
   * #63：待编排镜像列的落点（拖回待编排 = 撤章归属）。镜像列在批 7 曾刻意
   * 「无 drop 目标」（无合法章语义可写）——用户实测判该决定为错：撤归属本身
   * 就是合法语义（哨兵章写入）。no-op（已在待编排且无遮蔽字段）→ applyPendingDrop
   * 原引用返回 → 这里跳过写入。onDragStart/onDragOver 与主缝复用同链。
   */
  const onPendingDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const payload = decodeDragPayload(e.dataTransfer.getData(SCENE_DRAG_MIME));
      if (!payload) return;
      const graph = readEditableGraph();
      if (!graph) return;
      const next = applyPendingDrop(graph, payload.nodeId);
      if (next === graph) return; // 已是哨兵态——防「拖回仍全量写」（CR 组 3c 双缝守卫）
      updateField('scene_graph', next);
    },
    [updateField]
  );

  return { onDragStart, onDragOver, onBlockedDragOver, onDrop, onPendingDrop };
}
