import type Database from 'better-sqlite3';
import {
  createSubjectRef,
  parseSubjectRef,
  worldSubjectId,
  worldSubjectMatchKey,
} from '@orison/shared-contracts';
import { getLogger } from '../logger';

// ── dogfood R2 #91：存量 world subject 分身归一迁移（幂等数据迁移）──
//
// 背景：五提取器 ID 生成规则不一致致同一主体多分身并存（dogfood R2 #91 落库实证：project 00004 的
// `shen-yan` / `character:shen-yan` / `character:shenyan` 三形态、`lao-wei`/`miya` 双形态）。本迁移把
// 存量一次性归并到规范形态 `<type>:<slug>`（worldSubjectId 单源），并同步改写 patch / checkpoint 的
// subject_id 引用。配合写入面 resolveWorldSubjectIdentity（worldStateRepository，查重复用）从根上防
// 新分身。
//
// 合并规则（同 project 内分组）：**同 type + 同归一匹配键（worldSubjectMatchKey——前缀有无 / 连字符 /
// 大小写 / 空白全同键）→ 合并为一**。canonical 选取：
// 1. 组内恰一个 asset_cards 卡锚（distinct source_card_id ≤ 1）→ canonical = 卡 id（对齐目标轨契约，
//    组内 id ≠ 卡 id 的成员也并到卡 id）。
// 2. 无卡锚 → 取 patch 引用数最多的成员（数据最丰 = 主身份，改写面最小；并列按 id 字典序定序），
//    canonical = worldSubjectId(type, 该成员 id)。
// 3. 组内 ≥2 个不同卡锚 → 身份歧义（机械不可判），整组跳过 + warn（语义归 LLM 修补 Agent）。
//
// 改写面（**绝不丢 patch/checkpoint 事件数据，只改引用**）：
// - patch.subject_id 全表改写（外键式引用）。
// - patch.value 内 `subject://<id>` ref 改写（JSON-aware 递归精确匹配——ref 契约为 scalar 整串）。
// - checkpoint：**纯改名组**（单成员形态收敛）UPDATE subject_id；**真合并组**（≥2 分身）DELETE 全成员
//   checkpoint——折叠态按分身各自算，合流后必 stale（水印 belt 对「并入 rowid 更小的旧 patch」无感知，
//   留着即静默错态）。checkpoint 是 DERIVED 缓存（丢了 lazy 重建，world-state.ts 8.1 注释），删是保正确
//   性的唯一安全动作。
// - closure_chapter_summary.summary JSON 内 subjectId（characterEndStates/oracleDormant/
//   relationshipChanges/newEntities 四字段——恰好是全部携带 subjectId 的字段，其余三字段用 promiseId）
//   改写 + 塌缩去重（keep-first）。state 字段是按分身算的 stale 缓存——保留至下次 materialize 重物化
//   （DERIVED 契约；重建需 project.yaml 三源，启动期 db 层不具备，不在本迁移内重算），但 state 嵌套内
//   subject:// ref 同步改写（mirror 存活 checkpoint.state 的同面——不写则 ref 悬空指向已删分身 id）。
// - closure_world_slice 无 subject 引用（关系经 patch），不动。
//
// 幂等：归一后全部分组单成员且 id 自规范 → 零写入。启动期每次跑（getDb 后），重复跑零效果。
// 失败策略：**数据迁移失败 warn 不阻断启动**（与 schema 迁移「失败即崩」不同——分身未合并不影响既有
// 读写正确性，下次启动重试）；per-project 事务隔离，单项目失败不殃及其他项目。

/** 迁移观测量（日志/测试断言用；全 0 = 无需迁移——幂等常态）。 */
export interface WorldSubjectIdMigrationResult {
  projectsScanned: number;
  /** 纯改名（形态收敛，无分身合并）的 subject 行数。 */
  subjectsRenamed: number;
  /** 被合并删除的分身 subject 行数。 */
  subjectsMerged: number;
  /** subject_id 被改写的 patch 行数。 */
  patchesRewritten: number;
  /** value 内含被改写 subject:// ref 的 patch 行数。 */
  patchValuesRewritten: number;
  /** subject_id 被改名的 checkpoint 行数。 */
  checkpointsRenamed: number;
  /** 真合并组被删除的 checkpoint 行数（stale 折叠态，DERIVED lazy 重建）。 */
  checkpointsDropped: number;
  /** subjectId 被改写（含塌缩去重）的 chapter summary 行数。 */
  summariesRewritten: number;
}

const EMPTY_RESULT: WorldSubjectIdMigrationResult = {
  projectsScanned: 0,
  subjectsRenamed: 0,
  subjectsMerged: 0,
  patchesRewritten: 0,
  patchValuesRewritten: 0,
  checkpointsRenamed: 0,
  checkpointsDropped: 0,
  summariesRewritten: 0,
};

/** subject 行（raw snake_case 列 + camelCase 便利字段）。 */
interface SubjectRow {
  id: string;
  type: string;
  name: string | null;
  sourceCardId: string | null;
  firstSeenStoryTime: number;
  /** 该 id 被 patch 引用的次数（canonical 选取偏好——数据最丰者优先）。 */
  patchRefCount: number;
}

/**
 * 启动期迁移入口（getDb() 在 initSchema 后调用）。扫描全部 project 的 closure_world_subject，分组
 * 归并到规范 id。幂等：无分身 + 全规范 → 零写入。per-project try/catch——单项目失败 warn 继续。
 */
export function migrateWorldSubjectIds(db: Database.Database): WorldSubjectIdMigrationResult {
  const result: WorldSubjectIdMigrationResult = { ...EMPTY_RESULT };
  const projectIds = (
    db.prepare('SELECT DISTINCT project_id AS pid FROM closure_world_subject').all() as Array<{
      pid: string;
    }>
  ).map((r) => r.pid);
  result.projectsScanned = projectIds.length;
  for (const projectId of projectIds) {
    try {
      const delta = migrateProject(db, projectId);
      result.subjectsRenamed += delta.subjectsRenamed;
      result.subjectsMerged += delta.subjectsMerged;
      result.patchesRewritten += delta.patchesRewritten;
      result.patchValuesRewritten += delta.patchValuesRewritten;
      result.checkpointsRenamed += delta.checkpointsRenamed;
      result.checkpointsDropped += delta.checkpointsDropped;
      result.summariesRewritten += delta.summariesRewritten;
      if (
        delta.subjectsRenamed > 0 ||
        delta.subjectsMerged > 0 ||
        delta.patchesRewritten > 0 ||
        delta.patchValuesRewritten > 0 ||
        delta.checkpointsRenamed > 0 ||
        delta.checkpointsDropped > 0 ||
        delta.summariesRewritten > 0
      ) {
        getLogger().info(
          { projectId, ...delta },
          'closure_world_subject id migration: subjects canonicalized/merged (dogfood R2 #91)',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        { err: msg, projectId },
        'closure_world_subject id migration failed for project (skipped, retried next startup)',
      );
    }
  }
  return result;
}

/** 单 project 迁移（整体单 WAL 事务——分组计算只读，写入面原子）。 */
function migrateProject(db: Database.Database, projectId: string): WorldSubjectIdMigrationResult {
  const subjects = loadSubjects(db, projectId);
  if (subjects.length === 0) return { ...EMPTY_RESULT };

  // ── 分组：(type 归一, matchKey) → members（carded 成员也按其自身 id 的 matchKey 入组——卡锚规
  // 则在组内生效：恰一卡锚 → canonical = 卡 id）。──
  const groups = new Map<string, SubjectRow[]>();
  for (const row of subjects) {
    const key = worldSubjectMatchKey(row.type, row.id);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  // ── 组内 canonical 判定（纯计算，无写入）──
  interface GroupPlan {
    canonical: string;
    members: SubjectRow[];
    /** 需改写的旧 id 集（canonical 行自身不在内）。 */
    changedIds: string[];
    /** 真合并（≥2 成员收敛）——checkpoint 全删而非改名。 */
    isMerge: boolean;
    preferred: SubjectRow;
  }
  const plans: GroupPlan[] = [];
  const canonicalSeen = new Set<string>();
  for (const members of groups.values()) {
    const cardIds = new Set(
      members.filter((m) => m.sourceCardId !== null).map((m) => m.sourceCardId as string),
    );
    if (cardIds.size > 1) {
      // 3. 多卡锚歧义：跳过整组（机械不可判身份）。
      getLogger().warn(
        { projectId, ids: members.map((m) => m.id), cardIds: [...cardIds] },
        'world subject id migration: group with multiple distinct card anchors skipped (ambiguous identity)',
      );
      continue;
    }
    // 偏好序：patch 引用数降序 → id 字典序（确定性）。
    const sorted = [...members].sort(
      (a, b) => b.patchRefCount - a.patchRefCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const preferred = sorted[0];
    const canonical =
      cardIds.size === 1 ? (cardIds.values().next().value as string) : worldSubjectId(preferred.type, preferred.id);
    // 跨组 canonical 撞车防线（理论不可达——canonical 与成员同 matchKey 必同组；防御性跳过后写组）。
    if (canonicalSeen.has(canonical)) {
      getLogger().warn(
        { projectId, canonical, ids: members.map((m) => m.id) },
        'world subject id migration: canonical id collides across groups (skipped, defensive)',
      );
      continue;
    }
    canonicalSeen.add(canonical);
    const changedIds = members.filter((m) => m.id !== canonical).map((m) => m.id);
    if (changedIds.length === 0) continue; // 单成员自规范 → 幂等常态 no-op
    plans.push({
      canonical,
      members,
      changedIds,
      isMerge: members.length > 1,
      preferred,
    });
  }
  if (plans.length === 0) return { ...EMPTY_RESULT };

  const delta: WorldSubjectIdMigrationResult = { ...EMPTY_RESULT };
  const rewriteMap = new Map<string, string>(); // 旧 id → canonical（全组汇总，供 value/summary/checkpoint state 改写）

  db.transaction(() => {
    const renameSubject = db.prepare(
      'UPDATE closure_world_subject SET id = ? WHERE project_id = ? AND id = ?',
    );
    const deleteSubject = db.prepare('DELETE FROM closure_world_subject WHERE project_id = ? AND id = ?');
    const coalesceSubject = db.prepare(
      `UPDATE closure_world_subject SET name = ?, source_card_id = ?, first_seen_story_time = ?
       WHERE project_id = ? AND id = ?`,
    );
    const rewritePatchSubject = db.prepare(
      `UPDATE closure_world_patch SET subject_id = ? WHERE project_id = ? AND subject_id = ?`,
    );
    const updatePatchValue = db.prepare('UPDATE closure_world_patch SET value = ? WHERE id = ?');
    const renameCheckpoint = db.prepare(
      'UPDATE closure_world_checkpoint SET subject_id = ? WHERE project_id = ? AND subject_id = ?',
    );
    const deleteCheckpoint = db.prepare(
      'DELETE FROM closure_world_checkpoint WHERE project_id = ? AND subject_id = ?',
    );
    const updateSummary = db.prepare(
      'UPDATE closure_chapter_summary SET summary = ? WHERE project_id = ? AND episode_id = ?',
    );

    for (const plan of plans) {
      const { canonical, members, changedIds, isMerge, preferred } = plan;
      for (const oldId of changedIds) rewriteMap.set(oldId, canonical);

      const keeper = members.find((m) => m.id === canonical);
      if (keeper) {
        // canonical 行已在：字段 COALESCE 并入（canonical 值优先 / 首非空兜底、firstSeen 取最小），
        // 其余分身行删除。
        const name = keeper.name ?? members.find((m) => m.name !== null)?.name ?? null;
        const card =
          keeper.sourceCardId ?? members.find((m) => m.sourceCardId !== null)?.sourceCardId ?? null;
        const firstSeen = Math.min(...members.map((m) => m.firstSeenStoryTime));
        coalesceSubject.run(name, card, firstSeen, projectId, canonical);
        for (const oldId of changedIds) {
          deleteSubject.run(projectId, oldId);
          delta.subjectsMerged += 1;
        }
      } else {
        // canonical 行不在：preferred 行改名承接（字段 COALESCE 并入），其余分身行删除。
        const name = members.find((m) => m.name !== null)?.name ?? null;
        const card = members.find((m) => m.sourceCardId !== null)?.sourceCardId ?? null;
        const firstSeen = Math.min(...members.map((m) => m.firstSeenStoryTime));
        renameSubject.run(canonical, projectId, preferred.id);
        coalesceSubject.run(name, card, firstSeen, projectId, canonical);
        delta.subjectsRenamed += 1;
        for (const m of members) {
          if (m.id === preferred.id) continue;
          deleteSubject.run(projectId, m.id);
          delta.subjectsMerged += 1;
        }
      }

      // patch.subject_id 引用改写（全表外键式）。
      for (const oldId of changedIds) {
        const info = rewritePatchSubject.run(canonical, projectId, oldId);
        delta.patchesRewritten += info.changes;
      }

      // checkpoint：真合并组全成员删（stale 折叠态）；纯改名组改名。
      if (isMerge) {
        for (const member of members) {
          const info = deleteCheckpoint.run(projectId, member.id);
          delta.checkpointsDropped += info.changes;
        }
      } else {
        for (const oldId of changedIds) {
          const info = renameCheckpoint.run(canonical, projectId, oldId);
          delta.checkpointsRenamed += info.changes;
        }
      }
    }

    // patch.value 内 subject:// ref 改写（JSON-aware 递归精确匹配；仅扫含 subject:// 的行）。
    if (rewriteMap.size > 0) {
      const valueRows = db
        .prepare(
          `SELECT id, value FROM closure_world_patch
           WHERE project_id = ? AND value IS NOT NULL AND value LIKE '%subject://%'`,
        )
        .all(projectId) as Array<{ id: string; value: string }>;
      for (const row of valueRows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.value);
        } catch {
          continue; // 坏 JSON 不碰（CR-E6 容错哲学）
        }
        const rewritten = rewriteSubjectRefsInValue(parsed, (refId) => rewriteMap.get(refId));
        if (rewritten.changed) {
          updatePatchValue.run(JSON.stringify(rewritten.value), row.id);
          delta.patchValuesRewritten += 1;
        }
      }
    }

    // 存活 checkpoint.state 内 subject:// ref 改写（纯改名组的 state 引用了被改名的他主体）。
    if (rewriteMap.size > 0) {
      const ckptRows = db
        .prepare(
          `SELECT project_id, subject_id, at_story_time, state FROM closure_world_checkpoint
           WHERE project_id = ? AND state LIKE '%subject://%'`,
        )
        .all(projectId) as Array<{
        project_id: string;
        subject_id: string;
        at_story_time: number;
        state: string;
      }>;
      const updateCkptState = db.prepare(
        `UPDATE closure_world_checkpoint SET state = ?
         WHERE project_id = ? AND subject_id = ? AND at_story_time = ?`,
      );
      for (const row of ckptRows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.state);
        } catch {
          continue;
        }
        const rewritten = rewriteSubjectRefsInValue(parsed, (refId) => rewriteMap.get(refId));
        if (rewritten.changed) {
          updateCkptState.run(
            JSON.stringify(rewritten.value),
            row.project_id,
            row.subject_id,
            row.at_story_time,
          );
        }
      }
    }

    // chapter summary JSON 内 subjectId 改写 + 塌缩去重（四字段）。
    if (rewriteMap.size > 0) {
      const summaryRows = db
        .prepare('SELECT episode_id, summary FROM closure_chapter_summary WHERE project_id = ?')
        .all(projectId) as Array<{ episode_id: string; summary: string }>;
      for (const row of summaryRows) {
        let summary: unknown;
        try {
          summary = JSON.parse(row.summary);
        } catch {
          continue;
        }
        if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
        // state 嵌套内的 subject:// ref 先行改写（characterEndStates[].state 等折叠态可含关系 ref——
        // mirror 存活 checkpoint.state 的同面改写；不写则合并后 ref 悬空指向已删分身 id）。
        const refPass = rewriteSubjectRefsInValue(summary, (refId) => rewriteMap.get(refId));
        const s = (refPass.changed ? refPass.value : summary) as Record<string, unknown>;
        let touched = refPass.changed;
        // 四字段：条目对象含 subjectId 键的数组。改写 + 塌缩去重（keep-first）。
        for (const field of [
          'characterEndStates',
          'oracleDormant',
          'relationshipChanges',
          'newEntities',
        ]) {
          const arr = s[field];
          if (!Array.isArray(arr)) continue;
          const seen = new Set<string>();
          let fieldTouched = false;
          const next: unknown[] = [];
          for (const entry of arr) {
            if (!entry || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).subjectId !== 'string') {
              next.push(entry);
              continue;
            }
            const o = entry as Record<string, unknown>;
            if (rewriteMap.has(o.subjectId as string)) {
              o.subjectId = rewriteMap.get(o.subjectId as string) as string;
              fieldTouched = true;
            }
            // 塌缩去重（改写后同 subjectId 双条目并一，keep-first——stale 缓存，下次 materialize 重建）。
            if (seen.has(o.subjectId as string)) {
              fieldTouched = true;
              continue;
            }
            seen.add(o.subjectId as string);
            next.push(entry);
          }
          if (fieldTouched) {
            s[field] = next;
            touched = true;
          }
        }
        if (touched) {
          updateSummary.run(JSON.stringify(s), projectId, row.episode_id);
          delta.summariesRewritten += 1;
        }
      }
    }
  })();

  return delta;
}

/** 读 project 全部 subject 行 + patch 引用计数。 */
function loadSubjects(db: Database.Database, projectId: string): SubjectRow[] {
  const rows = db
    .prepare(
      `SELECT id, type, name, source_card_id, first_seen_story_time FROM closure_world_subject
       WHERE project_id = ?`,
    )
    .all(projectId) as Array<{
    id: string;
    type: string;
    name: string | null;
    source_card_id: string | null;
    first_seen_story_time: number;
  }>;
  const counts = new Map<string, number>();
  for (const r of db
    .prepare(
      'SELECT subject_id, COUNT(*) AS n FROM closure_world_patch WHERE project_id = ? GROUP BY subject_id',
    )
    .all(projectId) as Array<{ subject_id: string; n: number }>) {
    counts.set(r.subject_id, r.n);
  }
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    sourceCardId: r.source_card_id,
    firstSeenStoryTime: r.first_seen_story_time,
    patchRefCount: counts.get(r.id) ?? 0,
  }));
}

/**
 * patch/checkpoint JSON value 内 `subject://<id>` ref 改写（纯函数）。
 *
 * 递归走 string/array/object；**仅精确匹配 ref 整串**（subject://id 是 scalar 值契约，不匹配内嵌于
 * 长文本的子串——避免误伤 prose）。resolve 返回 undefined → 保留原值。changed=false 时 value 原对象
 * 返回（无谓深拷贝）。
 *
 * dogfood R2 #91：迁移（migrateWorldSubjectIds）与写入面（resolveWorldSubjectIdentity）共用本单源。
 */
export function rewriteSubjectRefsInValue(
  value: unknown,
  resolve: (refId: string) => string | undefined,
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const refId = parseSubjectRef(value);
    if (refId !== null) {
      const mapped = resolve(refId);
      if (mapped !== undefined && mapped !== refId) {
        return { value: createSubjectRef(mapped), changed: true };
      }
    }
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((el) => {
      const r = rewriteSubjectRefsInValue(el, resolve);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = rewriteSubjectRefsInValue(v, resolve);
      if (r.changed) changed = true;
      next[k] = r.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}
