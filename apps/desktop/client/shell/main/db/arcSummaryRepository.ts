import type { ArcAuditResult } from '@orison/shared-contracts';
import { getDb } from './index';

// ── Story 8.2 弧摘要 repository（design §4 / db-repository.md，mirror feedbackLedgerRepository 模式）──
//
// 纯函数 repository（mirror worldStateRepository / feedbackLedgerRepository）：每个函数内
// `const db = getDb()` → `db.prepare(sql).run/.get/.all(...)` → 返类型化 record。同步保持同步
// （better-sqlite3 同步事务安全性依赖于此，db-repository.md 反模式）。snake_case 列 ↔ camelCase
// Record 映射靠集中的 rowToRecord 转换器。
//
// project_id = registry `getProject(path).projectId` 5 位 id（mirror closure_world_* / closure_chapter_summary
// 命名空间惯例，非 meta.id UUID）——handler 层解析后传入；repository 信任类型化输入（Zod 校验在
// IPC 层一次，db-repository.md）。
//
// result TEXT(JSON) 列：写时 JSON.stringify（ArcAuditResult）、读时 JSON.parse try/catch 容错
// （mirror patchRowToRecord CR-E6——坏 JSON 标记 corruptPayload 不崩，不 ?? {} 折叠空对象掩盖）。
//
// 全 DERIVED（可 drop 重跑重建，design §4）：arc-audit-agent 大审/停滞专注审产物；beats 本体住
// project.yaml arc_registry creative field（LLM-authored 叙事状态，非本表职责）。
//
// PK (project_id, arc_ref, audit_kind, to_episode_index)：弧重写后重跑大审 → 新 to_episode_index 行
// （历史留档）+ 查询侧取最新（read/listLatest 的 MAX(to_episode_index) 语义，design §4）。

type AnyRow = Record<string, unknown>;

/** 弧种类（design §4 arc_kind 列；volume = 关口大审的卷弧 / line = 停滞专注审的线弧 / growth = 成长弧停滞审〔终审 F2 修：诚实标注，arcRef `growth:<characterId>`〕）。 */
export type ArcKind = 'volume' | 'line' | 'growth';

/** 审种类（design §4 audit_kind 列；closure = 卷弧闭合关口大审 / stagnation = 停滞专注审）。 */
export type ArcAuditKind = 'closure' | 'stagnation';

/** upsert 入参（projectId 由函数参数注入；result 为 ArcAuditResult 结构化对象，落表 JSON.stringify）。 */
export interface ArcSummaryUpsertInput {
  /** 弧引用（phase id / line id；与 ArcAuditResult.arcRef 一致）。 */
  arcRef: string;
  arcKind: ArcKind;
  auditKind: ArcAuditKind;
  /** 弧节拍区间（design §4 冗余列，排序/查询用；与 result.span 一致由 caller 保证）。 */
  fromEpisodeIndex: number;
  toEpisodeIndex: number;
  result: ArcAuditResult;
  /** 观测用 token 估算（mirror closure_chapter_summary.token_estimate；缺省 0）。 */
  tokenEstimate?: number;
}

/** 读出 record（upsert 全字段 + db produced_at；坏 JSON 行缺 result + corruptPayload=true）。 */
export interface ArcSummaryRecord {
  arcRef: string;
  arcKind: ArcKind;
  auditKind: ArcAuditKind;
  fromEpisodeIndex: number;
  toEpisodeIndex: number;
  /**
   * deserialize 后的 ArcAuditResult。corruptPayload=true 时缺省（坏 JSON 不造假对象，mirror
   * FeedbackLedgerEntry 契约）——caller 消费前须判 corruptPayload（true → warn + 当空处理）。
   */
  result?: ArcAuditResult;
  /** true = 行 result 是坏 JSON（deserialize 失败；CR-E6/CR-011 模式——两态可区分）。 */
  corruptPayload?: boolean;
  tokenEstimate: number;
  producedAt: string;
}

// ── snake_case row ↔ camelCase Record 映射 ──

const ARC_SUMMARY_COLS =
  'arc_ref, arc_kind, audit_kind, from_episode_index, to_episode_index, result, token_estimate, produced_at';

function rowToRecord(row: AnyRow): ArcSummaryRecord {
  const rawResult = row.result as string;
  let result: ArcAuditResult | undefined;
  let corruptPayload = false;
  try {
    const parsed: unknown = JSON.parse(rawResult);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      result = parsed as ArcAuditResult;
    } else {
      corruptPayload = true; // 非 object JSON（裸字符串/数字）——形态坏同 corrupt 不造假
    }
  } catch {
    // CR-E6：坏 JSON → corruptPayload 标记（不 ?? {} 折叠空对象掩盖）。caller 见 corrupt → warn + 当空处理。
    corruptPayload = true;
  }
  return {
    arcRef: row.arc_ref as string,
    arcKind: row.arc_kind as ArcKind,
    auditKind: row.audit_kind as ArcAuditKind,
    fromEpisodeIndex: row.from_episode_index as number,
    toEpisodeIndex: row.to_episode_index as number,
    ...(result !== undefined ? { result } : {}),
    ...(corruptPayload ? { corruptPayload: true } : {}),
    tokenEstimate: row.token_estimate as number,
    producedAt: row.produced_at as string,
  };
}

// ── 写入 ──

/**
 * Upsert 一条弧摘要行（composite PK (project_id, arc_ref, audit_kind, to_episode_index)）。
 *
 * 同 PK 重跑大审覆盖（ON CONFLICT DO UPDATE result + produced_at——upsertChapterSummary last-wins 同哲学）；
 * 弧重写后 to_episode_index 变化 → 新行（历史留档），查询侧 read/listLatest 取最新（design §4）。
 */
export function upsertArcSummary(projectId: string, row: ArcSummaryUpsertInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO closure_arc_summary
       (project_id, arc_ref, arc_kind, audit_kind, from_episode_index, to_episode_index, result, token_estimate, produced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, arc_ref, audit_kind, to_episode_index) DO UPDATE SET
       arc_kind = excluded.arc_kind,
       from_episode_index = excluded.from_episode_index,
       result = excluded.result,
       token_estimate = excluded.token_estimate,
       produced_at = excluded.produced_at`,
  ).run(
    projectId,
    row.arcRef,
    row.arcKind,
    row.auditKind,
    row.fromEpisodeIndex,
    row.toEpisodeIndex,
    JSON.stringify(row.result),
    row.tokenEstimate ?? 0,
    new Date().toISOString(),
  );
}

// ── 读取 ──

/**
 * 读单条弧摘要：(arc_ref, audit_kind) 最新行（MAX(to_episode_index)；toEpisodeIndex 给定则精确取该
 * 历史行）。未命中返 undefined（mirror getWorldSubject 契约）。坏 JSON 行返 corruptPayload 标记
 * （不丢行——caller 可区分两态，mirror readFeedbackLedger）。
 */
export function readArcSummary(
  projectId: string,
  arcRef: string,
  auditKind: ArcAuditKind,
  toEpisodeIndex?: number,
): ArcSummaryRecord | undefined {
  const db = getDb();
  const conditions = ['project_id = ?', 'arc_ref = ?', 'audit_kind = ?'];
  const params: unknown[] = [projectId, arcRef, auditKind];
  if (toEpisodeIndex !== undefined) {
    conditions.push('to_episode_index = ?');
    params.push(toEpisodeIndex);
  } else {
    // 最新行 = MAX(to_episode_index)；PK 前缀 (project_id, arc_ref, audit_kind) 命中 + 单行取回。
    conditions.push(
      'to_episode_index = (SELECT MAX(to_episode_index) FROM closure_arc_summary s2 ' +
        'WHERE s2.project_id = ? AND s2.arc_ref = ? AND s2.audit_kind = ?)',
    );
    params.push(projectId, arcRef, auditKind);
  }
  const row = db
    .prepare(
      `SELECT ${ARC_SUMMARY_COLS} FROM closure_arc_summary WHERE ${conditions.join(' AND ')}`,
    )
    .get(...params) as AnyRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

/**
 * 读项目内每 (arc_ref, audit_kind) 的最新行（design §4「查询侧取最新」——query_arc_summary 缺省档：
 * 每弧最新 + 停滞/关口两 kind 并列）。可选 arcRef 收窄单弧。按 arc_ref 升序（确定性）。
 */
export function listLatestArcSummaries(projectId: string, arcRef?: string): ArcSummaryRecord[] {
  const db = getDb();
  const conditions = [
    's.project_id = ?',
    's.to_episode_index = (SELECT MAX(s2.to_episode_index) FROM closure_arc_summary s2 ' +
      'WHERE s2.project_id = s.project_id AND s2.arc_ref = s.arc_ref AND s2.audit_kind = s.audit_kind)',
  ];
  const params: unknown[] = [projectId];
  if (arcRef !== undefined) {
    conditions.push('s.arc_ref = ?');
    params.push(arcRef);
  }
  const rows = db
    .prepare(
      `SELECT s.arc_ref, s.arc_kind, s.audit_kind, s.from_episode_index, s.to_episode_index, ` +
        `s.result, s.token_estimate, s.produced_at
       FROM closure_arc_summary s
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.arc_ref ASC, s.audit_kind ASC`,
    )
    .all(...params) as AnyRow[];
  return rows.map(rowToRecord);
}
