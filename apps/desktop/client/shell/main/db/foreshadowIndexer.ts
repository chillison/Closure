/**
 * Story 6.4 D3 foreshadow lifecycle 派生索引（mirror relationIndexer 物化模式）。
 *
 * 物化 project.yaml promise_registry → closure_foreshadow。promise 的 plant/resolve 在 beats
 * （promiseBeat kind=plant/payoff + sceneRef），物化时派生成 plant_ref/resolve_ref。
 *
 * status 存储态（open/fulfilled/abandoned，mirror 6.5）；派生阶段（planted/echoed/paid_off）不存
 * （消费时算，mirror 6.5 derivePromiseStage 哲学）。可 drop 重建（派生索引）。
 *
 * 范式判据（ADR-3）：物化 = 纯代码汇编（yaml → 派生索引），无 LLM/无语义裁判。
 */
import type { PromiseRegistry } from '@orison/shared-contracts';
import { getDb } from './index';
import { getLogger } from '../logger';

export interface ForeshadowHit {
  foreshadowId: string;
  title: string;
  summary: string;
  status: string;
  category: string | null;
  importance: number;
  entryId: string | null;
  plantRef: string | null;
  resolveRef: string | null;
  deadlineEpisodeId: string | null;
}

type ForeshadowRow = {
  foreshadow_id: string;
  title: string;
  summary: string;
  status: string;
  category: string | null;
  importance: number;
  entry_id: string | null;
  plant_ref: string | null;
  resolve_ref: string | null;
  deadline_episode_id: string | null;
};

/**
 * 物化 promise_registry → closure_foreshadow（全量替换 per project：删旧+插新，幂等）。
 *
 * @param registry   promise_registry creative field（promises + beats）。undefined/空 → 清空索引。
 * @param projectId  项目 scope。
 * @returns          写入的 promise 数。
 */
export function reindexForeshadowRegistry(
  registry: PromiseRegistry | undefined,
  projectId: string,
): number {
  const db = getDb();
  if (!registry || !Array.isArray(registry.promises) || registry.promises.length === 0) {
    db.prepare('DELETE FROM closure_foreshadow WHERE project_id = ?').run(projectId);
    return 0;
  }
  const beats = registry.beats ?? [];
  let written = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM closure_foreshadow WHERE project_id = ?').run(projectId);
    const stmt = db.prepare(`
      INSERT INTO closure_foreshadow
        (foreshadow_id, project_id, title, summary, status, category, importance,
         entry_id, plant_ref, resolve_ref, deadline_episode_id, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    `);
    for (const p of registry.promises) {
      // plant/resolve_ref 从 beats 派生（找该 promise 的 plant/payoff beat sceneRef）。
      const plantRef =
        beats.find((b) => b.promiseId === p.id && b.kind === 'plant')?.sceneRef ?? null;
      const resolveRef =
        beats.find((b) => b.promiseId === p.id && b.kind === 'payoff')?.sceneRef ?? null;
      stmt.run(
        p.id,
        projectId,
        p.title,
        p.summary,
        p.status,
        p.category ?? null,
        p.importance,
        p.related_asset_ids[0] ?? null,
        plantRef,
        resolveRef,
        p.deadlineEpisodeId ?? null,
      );
      written += 1;
    }
  })();
  return written;
}

/**
 * 查 open（未回收）伏笔——供召回作种子/过滤（AC6）。
 *
 * @param projectId   项目 scope。
 * @param atEpisodeId 可选：只返该 episode 相关的 open 伏笔（deadline_episode_id IS NULL OR = atEpisodeId）。
 *                       episode id 无序模型，真正「逾期」语义（deadline < 当前）deferred。
 * @returns           ForeshadowHit[]（importance 降序；空 = 无 open 伏笔）。
 */
export function findOpenForeshadows(projectId: string, atEpisodeId?: string): ForeshadowHit[] {
  const db = getDb();
  try {
    const rows = atEpisodeId
      ? db
          .prepare(
            `SELECT * FROM closure_foreshadow WHERE project_id = ? AND status = 'open'
             AND (deadline_episode_id IS NULL OR deadline_episode_id = ?)
             ORDER BY importance DESC`,
          )
          .all(projectId, atEpisodeId) as ForeshadowRow[]
      : db
          .prepare(
            `SELECT * FROM closure_foreshadow WHERE project_id = ? AND status = 'open'
             ORDER BY importance DESC`,
          )
          .all(projectId) as ForeshadowRow[];
    return rows.map((r) => ({
      foreshadowId: r.foreshadow_id,
      title: r.title,
      summary: r.summary,
      status: r.status,
      category: r.category,
      importance: r.importance,
      entryId: r.entry_id,
      plantRef: r.plant_ref,
      resolveRef: r.resolve_ref,
      deadlineEpisodeId: r.deadline_episode_id,
    }));
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectId },
      'findOpenForeshadows failed → empty',
    );
    return [];
  }
}
