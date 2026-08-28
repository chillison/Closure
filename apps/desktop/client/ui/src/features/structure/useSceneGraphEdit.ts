/**
 * dogfood R2 批次 A：scene_graph 的 UI 侧写通道（唯一 I/O seam）。
 *
 * 双通道铁律：UI 手势产出的 SceneGraphAction[] 经 **同一投影器** `applySceneGraphActions`
 * （与 AI 工具 scene_graph_update 的 shell handler 完全同源）投影成完整 graph，再走既有
 * `updateField('scene_graph')`（undo/redo/持久化/版本元数据白拿——mirror OutlineEditor 的
 * `projectEpisodeUpdate` 先例）。本项目不改 creativeFieldsSlice / 不新造写缝。
 *
 * 写时序（同 useTimelineEdit 约定）：**一次手势一次 updateField**——手势回调内读
 * `useAppStore.getState()` 取最新图（稳定引用、无 stale 闭包），投影后整写。抽屉的自由
 * 文本字段（标题/摘要）按 OutlineEditor 先例 500ms debounce + 切场景/卸载立刻 flush
 * （flush 逻辑在 SceneEditPopover 内部，本 hook 只提供一次性写入口）。
 *
 * 范式判据：结构操作（建/删/改 role/线/边）是确定性变换 = 机械；语义字段（摘要文案）
 * 的**AI 产出**走 chat patch 审查，但**人手直写同样合法**（作者主权——加速器不是门卫）。
 */
import { useCallback } from 'react';
import { applySceneGraphActions, type SceneGraphAction } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { isSceneGraphLike } from './layout';

/**
 * 把一批 actions 投影到最新 scene_graph 并整写。图缺/形状不对（部分 hydration 窗口）
 * 静默 no-op——写通道永不因读态崩溃。
 */
export function useSceneGraphEdit() {
  const updateField = useAppStore((s) => s.updateField);

  const applyActions = useCallback(
    (actions: SceneGraphAction[]) => {
      if (actions.length === 0) return;
      const raw = useAppStore.getState().creativeFields.scene_graph;
      if (!isSceneGraphLike(raw)) return;
      updateField('scene_graph', applySceneGraphActions(raw, actions));
    },
    [updateField]
  );

  return { applyActions };
}
