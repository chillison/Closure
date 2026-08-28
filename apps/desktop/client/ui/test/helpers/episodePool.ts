/**
 * Shared test fixture: deriveWorkbenchLayout 的 episode 池（CR 组 1 测试卫生——
 * poolFor 曾在 sceneGraphLayout.test / volumeBands.test 逐字节复制两份）。
 *
 * 裁剪语义：池只含**被图引用的章**（presentationOrder.chapter ∪ presentationSpans
 * / episodeId 的 `e{n}` id 约定）——宽裕池会在尾部注入幽灵空轨，破坏稠密轨道断言
 * 或让未分卷灰带混入卷带断言。legacy `episodeId` 字段一并计入（兼容仅走 legacy
 * 单章字段的节点，不再漏轨）。
 */
import type { SceneGraph } from '@orison/shared-contracts';

export function poolFor(graph: SceneGraph) {
  const indices = new Set<number>();
  for (const n of graph.nodes) {
    if (n.presentationOrder && typeof n.presentationOrder.chapter === 'number') {
      indices.add(Math.max(0, Math.floor(n.presentationOrder.chapter)));
    }
    if (Array.isArray(n.presentationSpans)) {
      for (const s of n.presentationSpans) {
        const m = /^e(\d+)$/.exec(s.episodeId);
        if (m) indices.add(Number(m[1]));
      }
    }
    if (typeof n.episodeId === 'string') {
      const m = /^e(\d+)$/.exec(n.episodeId);
      if (m) indices.add(Number(m[1]));
    }
  }
  return [...indices].sort((a, b) => a - b).map((index) => ({
    id: `e${index}`,
    index,
    title: `第${index + 1}章`,
  }));
}
