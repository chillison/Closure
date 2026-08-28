/**
 * Story 6.4 D2 relation 图遍历召回臂（ADR-3 / mirror closureRetrieval）。
 *
 * 应用层 BFS 从 seed entry 沿 closure_relation 图遍历 N-hop，召回「结构关联但语义不相似」条目
 * （补 searchClosure 语义盲区）。depth+budget caps 防 token 爆炸（kb-structure-design-research.md:375）。
 *
 * **BFS 重写（BMad CR E1/E2/Blind-1/Blind-2 修复）**：原递归 CTE（UNION ALL + path 累积 + 外层 LIMIT）
 * 在稠密/循环图中间 reach 指数物化爆炸（E1）+ seed 经循环边泄漏（E2）+ 只前向遍历（Blind-1，边只存一边
 * 时 seed=B 召回不到 A）+ LIMIT-before-dedupe（Blind-2，重复 entry 消耗 budget）。BFS 一次修四个：
 * - visited set 每节点只扩展一次 → 防爆（E1）+ 防循环 + 防重复
 * - visited pre-seed seed → seed 不作为命中返回（E2）
 * - 邻接表双向（edge A→B 同时入 A→B + B→A）→ 双向召回（Blind-1，边只存一边也能反向到）
 * - budget 在 visited 去重后取 → 唯一邻居数 = budget（Blind-2）
 *
 * 范式判据（ADR-3）：BFS = 纯代码图遍历（查询/汇编），无 LLM/无语义裁判。
 * 否决 graph DB / PPR / logic engine（单库 SQLite + 应用层 BFS 足够）。
 *
 * graceful（mirror searchClosure "never throws"）：无 closure_relation 数据 / seed 不存在 / 抛错 → 空数组。
 */
import type { RelationHit } from '@orison/shared-contracts';
import { getDb } from './index';
import { getLogger } from '../logger';

export interface SearchRelationsOpts {
  depth: number;
  budget: number;
  relationType?: string;
  visibility?: 'public' | 'secret' | 'one_sided';
}

type EdgeRow = { src: string; tgt: string; type: string };
type EntryRow = { entry_id: string; entry_type: string; name: string; body_text: string };

/**
 * 图遍历召回结构关联条目。seed → N-hop 邻居（双向 + visited 去重 + depth/budget caps）。
 *
 * @param projectId    项目 scope。
 * @param seedEntryId  起点 entry（assetCardId，对齐 closure_entry.entry_id）。
 * @param opts         depth（1-5）/ budget（1-100）/ relationType? / visibility? filter。
 * @returns            RelationHit[]（BFS 序=depth 升序；空 = 无关系数据 / seed 不存在 / 无邻居 / 查询失败）。
 */
export function searchRelations(
  projectId: string,
  seedEntryId: string,
  opts: SearchRelationsOpts,
): RelationHit[] {
  const db = getDb();
  try {
    // 1. 一次取所有边（filter type/vis），构建双向邻接表。
    //    双向（edge A→B 入 A→B + B→A）：relationship_graph 边只存一边（NeuroBook §5），召回须双向
    //    ——query_relations(seed=B) 也能召回 A，即使边是 A→B（Blind-1 修复）。
    const edgeSql =
      'SELECT src_entry_id AS src, tgt_entry_id AS tgt, relation_type AS type FROM closure_relation WHERE project_id = ?' +
      (opts.relationType ? ' AND relation_type = ?' : '') +
      (opts.visibility ? ' AND visibility = ?' : '');
    const edgeParams: unknown[] = [projectId];
    if (opts.relationType) edgeParams.push(opts.relationType);
    if (opts.visibility) edgeParams.push(opts.visibility);
    const edges = db.prepare(edgeSql).all(...edgeParams) as EdgeRow[];

    const adj = new Map<string, { tgt: string; type: string }[]>();
    for (const e of edges) {
      if (!adj.has(e.src)) adj.set(e.src, []);
      adj.get(e.src)!.push({ tgt: e.tgt, type: e.type });
      // 反向边（A→B 同时记 B→A）。
      if (!adj.has(e.tgt)) adj.set(e.tgt, []);
      adj.get(e.tgt)!.push({ tgt: e.src, type: e.type });
    }

    // 2. BFS（visited 防 E1 爆炸 + E2 seed 泄漏：pre-seed seed）。
    const visited = new Set<string>([seedEntryId]);
    const pathMap = new Map<string, string[]>([[seedEntryId, [seedEntryId]]]);
    const typeMap = new Map<string, string>();
    const depthMap = new Map<string, number>();
    let frontier = [seedEntryId];
    for (let depth = 1; depth <= opts.depth; depth++) {
      const next: string[] = [];
      for (const src of frontier) {
        for (const e of adj.get(src) ?? []) {
          if (visited.has(e.tgt)) continue; // 每节点只扩展一次（防爆 + 防循环 + 防重复）
          visited.add(e.tgt);
          pathMap.set(e.tgt, [...pathMap.get(src)!, e.tgt]);
          typeMap.set(e.tgt, e.type);
          depthMap.set(e.tgt, depth);
          next.push(e.tgt);
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }

    // 3. budget-after-dedupe（visited 已去重；BFS 序 = depth 升序，取首 budget 个）。
    const reached = [...visited].filter((id) => id !== seedEntryId).slice(0, opts.budget);
    if (reached.length === 0) return [];

    // 4. batch JOIN closure_entry 取 name/body/entryType（结构索引不存 body，design §3.1）。
    const placeholders = reached.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT entry_id, entry_type, name, body_text FROM closure_entry WHERE project_id = ? AND entry_id IN (${placeholders})`,
      )
      .all(projectId, ...reached) as EntryRow[];
    const entryMap = new Map(rows.map((r) => [r.entry_id, r]));

    // 5. 保留 BFS 序（depth 升序）；JOIN 落空的丢（孤儿关系——tgt entry 不在 closure_entry）。
    const hits: RelationHit[] = [];
    for (const id of reached) {
      const entry = entryMap.get(id);
      if (!entry) continue;
      hits.push({
        entryId: id,
        projectId,
        entryType: entry.entry_type,
        name: entry.name,
        bodyText: entry.body_text,
        relationType: typeMap.get(id) ?? '',
        depth: depthMap.get(id) ?? 0,
        viaPath: pathMap.get(id) ?? [],
      });
    }
    return hits;
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectId, seedEntryId },
      'relation retrieval: BFS traversal failed → empty',
    );
    return [];
  }
}
