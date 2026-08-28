/**
 * Story 6.4 D2 relation 图遍历召回臂物化（mirror assetCardsIndexer reindex 模式）。
 *
 * 物化 project.yaml relationship_graph.edges → closure_relation 派生索引。edge.from/to 是 node id
 * （非 assetCardId），经 graph.nodes[] 解析成 src/tgt_entry_id（对齐 closure_entry.entry_id）。
 *
 * 结构索引（不 embed/FTS，design §3.1）——全量替换（删旧+插新，幂等）+ WAL transaction。
 * 可 drop 重建（派生索引，source of truth = project.yaml relationship_graph）。
 *
 * 范式判据（ADR-3）：物化 = 纯代码汇编（yaml → 派生索引），无 LLM/无语义裁判。
 *
 * Story 8.7 §1.4（两写者共存）：closure_relation 现有两个写者——本索引器（source='graph'）与
 * settingMdIndexer（source='setting_link'，frontmatter linked_entities 物化）。本函数的全量替换
 * scope 收窄到 `source='graph'`（含空 graph 清空路径）——graph 替换绝不清 setting_link 行，反之
 * setting_md 的 per-doc 替换也不清 graph 行（scope 隔离错=互相清边，implement.md 风险注记）。
 * query_relations BFS 读全边零改动（seed 可为 setting entry，closure_entry JOIN 已覆盖）。
 */
import type { RelationshipGraph } from '@orison/shared-contracts';
import { getDb } from './index';
import { getLogger } from '../logger';

/**
 * 物化 relationship_graph → closure_relation（全量替换 per project：删旧 + 插新，幂等）。
 *
 * @param graph      relationship_graph creative field（nodes + edges）。undefined/空 → 清空该
 *                   项目的 graph 侧索引行（source='setting_link' 行不受影响）。
 * @param projectId  项目 scope。
 * @returns          写入的 edge 数（解析失败 / 空 graph → 0）。
 */
export function reindexRelationGraph(graph: RelationshipGraph | undefined, projectId: string): number {
  const db = getDb();
  // 无 graph / 无 edges → 清空该项目 graph 侧旧 relation（派生索引一致性：graph 删空时
  // graph 索引也空；setting_link 行归 settingMdIndexer 管，不动）。
  if (!graph || !Array.isArray(graph.edges) || graph.edges.length === 0) {
    db.prepare("DELETE FROM closure_relation WHERE project_id = ? AND source = 'graph'").run(projectId);
    return 0;
  }
  // node id → assetCardId 映射（edge.from/to 是 node id，非 assetCardId）。
  const nodeToCard = new Map<string, string>();
  for (const n of graph.nodes ?? []) {
    if (n?.id && n.assetCardId) nodeToCard.set(n.id, n.assetCardId);
  }

  let written = 0;
  // WAL transaction：删旧 + 插新（全量替换，幂等——mirror craft indexer rebuild 模式）。
  // 替换 scope 限定 source='graph'（Story 8.7 §1.4 两写者隔离）。
  db.transaction(() => {
    db.prepare("DELETE FROM closure_relation WHERE project_id = ? AND source = 'graph'").run(projectId);
    const stmt = db.prepare(`
      INSERT INTO closure_relation
        (relation_id, project_id, src_entry_id, tgt_entry_id, relation_type,
         polarity, visibility, strength, source_refs, source, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, 'graph', datetime('now'))
      ON CONFLICT(relation_id) DO UPDATE SET
        src_entry_id=excluded.src_entry_id, tgt_entry_id=excluded.tgt_entry_id,
        relation_type=excluded.relation_type, polarity=excluded.polarity,
        visibility=excluded.visibility, strength=excluded.strength,
        source_refs=excluded.source_refs, source=excluded.source, updated_at=datetime('now')
    `);
    for (const e of graph.edges) {
      const src = nodeToCard.get(e.from);
      const tgt = nodeToCard.get(e.to);
      // node 未解析（缺 assetCardId / 孤儿 node）→ 跳过（不入索引，不崩——mirror 零噪音）。
      if (!src || !tgt) continue;
      stmt.run(
        e.id,
        projectId,
        src,
        tgt,
        e.relationType,
        e.polarity ?? null,
        e.visibility ?? null,
        e.strength ?? null,
        JSON.stringify(e.sourceRefs ?? []),
      );
      written += 1;
    }
  })();

  if (written < graph.edges.length) {
    getLogger().warn(
      { projectId, total: graph.edges.length, written, skipped: graph.edges.length - written },
      'relation indexer: skipped edges with unresolved node→assetCardId (orphan nodes missing assetCardId)',
    );
  }
  return written;
}
