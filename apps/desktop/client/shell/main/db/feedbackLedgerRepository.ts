import {
  deserializeFeedbackPayload,
  serializeFeedbackPayload,
  type FeedbackArtifactKey,
  type FeedbackLedgerEntry,
} from '@orison/shared-contracts';
import { getDb } from './index';

// ── Story 7.4 cross-chapter feedback ledger repository（design §2.2 / ADR-3 / db-repository.md）──
//
// 纯函数 repository（mirror worldStateRepository / assetRepository / projectRepository 模式）：每个函数内
// `const db = getDb()` → `db.prepare(sql).run/.get/.all(...)` → 返类型化 record。同步保持同步（better-sqlite3
// 同步事务安全性依赖于此，db-repository.md 反模式「把 repository 同步函数改成 async」）。
// snake_case 列 ↔ camelCase Record 映射靠集中的 rowToRecord 转换器。
//
// project_id = registry `getProject(path).projectId` 5 位 id（mirror closure_world_* / closure_entry 命名空间
// 惯例，非 meta.id UUID）——handler 层解析后传入；repository 信任类型化输入（db-repository.md：Zod 校验在
// IPC 层一次，repository 不重复校验）。
//
// payload TEXT(JSON) 列：写时 serializeFeedbackPayload（JSON.stringify）、读时 deserializeFeedbackPayload
// （JSON.parse try/catch 容错，mirror patchRowToRecord CR-E6 坏 JSON 返 undefined 不崩）。
//
// 全 DERIVED（可 drop，非 source of truth——prose/结构住 project.yaml，ledger 只中转链段 artifact 跨章）。

type AnyRow = Record<string, unknown>;

// ── snake_case row ↔ camelCase Record 映射 ──

function rowToEntry(row: AnyRow): FeedbackLedgerEntry {
  const rawPayload = row.payload as string;
  const payload = deserializeFeedbackPayload(rawPayload);
  if (payload === undefined) {
    // BMad CR-011：坏 JSON → 标记 corruptPayload（不 ?? {} 折叠空对象掩盖）。caller 见 corrupt → warn + 当空处理
    // （不喂 Director 坏数据）。readFeedbackLedger 单条未命中返 undefined；命中但坏 JSON 返 corrupt 标记
    // （不丢 entry，caller 可区分两态：合法空 vs 坏 JSON）。
    return {
      episodeId: row.episode_id as string,
      artifactKey: row.artifact_key as FeedbackArtifactKey,
      corruptPayload: true,
      producedAt: row.produced_at as string,
    };
  }
  return {
    episodeId: row.episode_id as string,
    artifactKey: row.artifact_key as FeedbackArtifactKey,
    payload,
    producedAt: row.produced_at as string,
  };
}

// ── 写入 ──

/**
 * Upsert 一条 feedback ledger 记录（composite PK (project_id, episode_id, artifact_key)）。
 *
 * 同 episode 同 key 重跑覆盖（ON CONFLICT DO UPDATE payload + produced_at）——链段重跑（redo / auto_revise
 * loop）时 ledger 被新 artifact 覆盖，不累积旧版本（per-episode per-artifact 最新态，design §2.2）。
 *
 * @param projectId   5 位 registry id（handler 解析，mirror closure_world_* 命名空间）。
 * @param episodeId   哪一章产的 artifact。
 * @param artifactKey 'review.latest' / 'emotion_verify_result' / 'completeness_verify_result'。
 * @param payload     链段 artifact 对象（serialize 前）。
 */
export function upsertFeedbackLedger(
  projectId: string,
  episodeId: string,
  artifactKey: FeedbackArtifactKey,
  payload: Record<string, unknown>,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO closure_feedback_ledger (project_id, episode_id, artifact_key, payload, produced_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, episode_id, artifact_key) DO UPDATE SET
       payload = excluded.payload,
       produced_at = excluded.produced_at`,
  ).run(
    projectId,
    episodeId,
    artifactKey,
    serializeFeedbackPayload(payload),
    new Date().toISOString(),
  );
}

// ── 读取 ──

/**
 * 读单条 feedback ledger（按 composite PK）。未命中返 undefined（mirror getWorldSubject 契约）。
 */
export function readFeedbackLedger(
  projectId: string,
  episodeId: string,
  artifactKey: FeedbackArtifactKey,
): FeedbackLedgerEntry | undefined {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT episode_id, artifact_key, payload, produced_at FROM closure_feedback_ledger ' +
        'WHERE project_id = ? AND episode_id = ? AND artifact_key = ?',
    )
    .get(projectId, episodeId, artifactKey) as AnyRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * 读单 episode 的全部 feedback ledger 条目（三 key）。
 *
 * write_chapter chain-start 读上一章三 artifact 填 feedback var 时用（Step 2 接通）。返 FeedbackLedgerEntry[]——
 * 未命中的 key 不在数组里（caller 按需取，缺则降级空串，mirror Director graceful）。
 */
export function readEpisodeFeedback(
  projectId: string,
  episodeId: string,
): FeedbackLedgerEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT episode_id, artifact_key, payload, produced_at FROM closure_feedback_ledger ' +
        'WHERE project_id = ? AND episode_id = ?',
    )
    .all(projectId, episodeId) as AnyRow[];
  return rows.map(rowToEntry);
}
