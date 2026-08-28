import { randomUUID } from 'node:crypto';
import {
  applyPatches,
  assembleWorldSnapshot,
  parseSubjectRef,
  reduceSubject,
  worldSubjectId,
  worldSubjectMatchKey,
  worldSubjectSlugKey,
  type AppearancePatchFact,
  type BuildWorldStateSnapshotOptions,
  type ChapterStateSummary,
  type EpisodeStoryTimeWindow,
  type ReducedState,
  type SubjectCheckpoint,
  type WorldIssue,
  type WorldKindResolver,
  type WorldPatch,
  type WorldPatchAxis,
  type WorldPatchInput,
  type WorldPatchOp,
  type WorldPatchSource,
  type WorldSlice,
  type WorldStateSnapshot,
  type WorldSubject,
  type WorldSubjectReduceEntry,
} from '@orison/shared-contracts';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import { rewriteSubjectRefsInValue } from './worldSubjectIdMigration';

// ── Story 6.6 Phase B：closure_world_state repository（design §4/§5 / db-repository.md）──
//
// 纯函数 repository（mirror assetRepository/projectRepository 模式）：每个函数内 `const db =
// getDb()` → `db.prepare(sql).run/.get/.all(...)` → 返类型化 record。同步保持同步（better-sqlite3
// 同步事务安全性依赖于此，db-repository.md 反模式）。snake_case 列 ↔ camelCase Record 映射靠集中
// 的 rowToRecord 转换器 + 列名常量。
//
// reduce 逻辑不在此重写——调用 shared-contracts `reduceSubject` 纯函数（ADR-3 纯代码 utility，DRY
// 跨包：shell 查询 + agent 提取器测试共用）。本 repository 只做 db 读写 + JOIN slice 填充 patch.storyTime
// 反范式字段（Phase A WorldPatch.storyTime 注释）+ 调 reduceSubject。
//
// project_id = registry `getProject(path).projectId` 5 位 id（mirror 2.7/2.3，非 meta.id UUID）——
// handler 层解析后传入；repository 信任类型化输入（db-repository.md：Zod 校验在 IPC 层一次）。
//
// 全 DERIVED（可 drop 重建，prose 是唯一文件真相源 ADR-1/ADR-14）。value TEXT(JSON) 列：写时
// JSON.stringify、读时 JSON.parse（mirror 既有 JSON 列惯例 closureCraftIndexer tagsJson）。

// ── 写入时 patch 输入（提取器/修补 Agent 语义输出，无 infra 字段）──
// 复用 shared-contracts `WorldPatchInput`（world-state.ts，handler 入参 + repository 写入共用单源）。
// id/sliceId/storyTime/source 由 insertWorldSlice 注入（infra）：id = randomUUID、sliceId = 所属
// slice.id、storyTime = 反范式自 slice.storyTime（Phase A WorldPatch.storyTime 注释）、source = 调用
// 方指定（write_world_events='derived' / amend_world_state='amendment'，handler 强制，防误标）。
// （WorldPatchInput type 自 shared-contracts 导入，不再本地重定义——DRY。）

// ── 列名常量（SELECT 用，避免 SELECT * 漂移）──
const SUBJECT_COLS =
  'id, project_id, type, name, source_card_id, first_seen_story_time';
const SLICE_COLS = 'id, project_id, story_time, kind, title, summary, episode_id';
// patch 反范式读：JOIN slice 取 story_time（patch 表无 story_time 列，design §4 归一化）。
const PATCH_WITH_TIME_COLS =
  'p.id AS id, p.slice_id AS slice_id, p.project_id AS project_id, p.subject_id AS subject_id, ' +
  'p.path AS path, p.op AS op, p.value AS value, p.axis AS axis, p.source AS source, p.summary AS summary, ' +
  'p.evidence_scene_id AS evidence_scene_id, s.story_time AS story_time';
// Story 8.1 checkpoint 窗口读：额外取 p.rowid（水印 patch_rowid_high 计算用；patchRowToRecord 忽略此键）。
const PATCH_WINDOW_COLS = PATCH_WITH_TIME_COLS + ', p.rowid AS _rowid';

// ── LIKE 模式工具（CR-7，8.1 修复批）──
// episode/subject id 约定 [\w-]+ 含 `_`——未转义的 LIKE 模式里 `_` 是单字符通配符：`ep_1:%` 会误匹配
// `epX1:...`。凡把 id 拼进 LIKE 模式的查询（episode LIKE fallback / findWorldRefs needle）须经此转义并
// 配 `ESCAPE '\'` 子句（反斜杠自身一并转义——先替换 `\\` 再 `%`/`_`，顺序保证前缀不重复转义）。
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ── snake_case row ↔ camelCase Record 映射 ──

type AnyRow = Record<string, unknown>;

function subjectRowToRecord(row: AnyRow): WorldSubject {
  return {
    id: row.id as string,
    type: row.type as string,
    name: (row.name as string | null) ?? undefined,
    sourceCardId: (row.source_card_id as string | null) ?? undefined,
    firstSeenStoryTime: row.first_seen_story_time as number,
  };
}

function sliceRowToRecord(row: AnyRow): WorldSlice {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    storyTime: row.story_time as number,
    kind: (row.kind as string | null) ?? undefined,
    title: row.title as string,
    summary: (row.summary as string | null) ?? undefined,
    // Story 8.1：episode 归属列（调用方未提供 / 存量行 → NULL → undefined；查询侧 legacy LIKE fallback）。
    episodeId: (row.episode_id as string | null) ?? undefined,
  };
}

function patchRowToRecord(row: AnyRow): WorldPatch {
  const rawValue = row.value as string | null;
  // CR-E6：JSON 列容错——NULL（remove 无 value）→ undefined；坏 JSON（非 JSON 文本，理论不应出现但
  // 手动改库 / 老化数据可能）→ try/catch 返 undefined（不崩整 list，mirror findWorldRefs JSON.parse 容错）。
  let value: unknown;
  if (rawValue != null) {
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = undefined;
    }
  } else {
    value = undefined;
  }
  return {
    id: row.id as string,
    sliceId: row.slice_id as string,
    subjectId: row.subject_id as string,
    path: row.path as string,
    op: row.op as WorldPatchOp,
    value,
    axis: row.axis as WorldPatchAxis,
    source: row.source as WorldPatchSource,
    summary: (row.summary as string | null) ?? undefined,
    evidenceSceneId: (row.evidence_scene_id as string | null) ?? undefined,
    storyTime: row.story_time as number,
  };
}

// ── subject CRUD ──

/**
 * Upsert 一个 subject（composite PK (project_id, id)，跨项目隔离）。首次插入记 firstSeenStoryTime；
 * 已存在则刷新 type/name，source_card_id 取 COALESCE（首次写入的非空卡引用不丢，避 clobber）。
 *
 * CR-E2：type/name 也走 COALESCE（非空不覆盖）——避 slice 写入时传 null name（patch-only slice 无 subject
 * name）clobber 已有真实 name，及 entity stub（linkReferencedSubjects 兜底 type='entity'）覆盖真实 type。
 * 首次写入的非空 type/name 不被后续空值覆盖；caller 想显式改 type/name 时传非空值即可（COALESCE 取 excluded）。
 */
export function upsertWorldSubject(projectId: string, subject: WorldSubject): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, id) DO UPDATE SET
       type = COALESCE(excluded.type, closure_world_subject.type),
       name = COALESCE(excluded.name, closure_world_subject.name),
       source_card_id = COALESCE(excluded.source_card_id, closure_world_subject.source_card_id)`,
  ).run(
    subject.id,
    projectId,
    subject.type,
    subject.name ?? null,
    subject.sourceCardId ?? null,
    subject.firstSeenStoryTime,
  );
}

/** 查单个 subject（按 composite PK）。未注册返 undefined。 */
export function getWorldSubject(projectId: string, subjectId: string): WorldSubject | undefined {
  const db = getDb();
  const row = db
    .prepare(`SELECT ${SUBJECT_COLS} FROM closure_world_subject WHERE project_id = ? AND id = ?`)
    .get(projectId, subjectId) as AnyRow | undefined;
  return row ? subjectRowToRecord(row) : undefined;
}

/** 列出项目内全部 subject（可选 type 过滤），按 id 稳定排序。 */
export function listWorldSubjects(projectId: string, type?: string): WorldSubject[] {
  const db = getDb();
  if (type) {
    const rows = db
      .prepare(
        `SELECT ${SUBJECT_COLS} FROM closure_world_subject WHERE project_id = ? AND type = ? ORDER BY id`,
      )
      .all(projectId, type) as AnyRow[];
    return rows.map(subjectRowToRecord);
  }
  const rows = db
    .prepare(`SELECT ${SUBJECT_COLS} FROM closure_world_subject WHERE project_id = ? ORDER BY id`)
    .all(projectId) as AnyRow[];
  return rows.map(subjectRowToRecord);
}

// ── dogfood R2 #91：提取器写入面 subject 身份解析（查重复用，防新分身）──
//
// 写入门（write_world_events / amend_world_state handler 落 insertWorldSlice 前调用）：把提取器产的
// subjects + patches 的 subject id 收敛到「canonical 形态或既有主体 id」——LLM 连字符习惯逐章漂移
// （`shenyan` vs `shen-yan`）+ 前缀有无，精确 id 查不到时按归一匹配键兜住，**存在即复用不新建**。
// 与 agent 侧 parseAxisExtraction 形态规范化（单源 worldSubjectId）双保险：agent 层保 artifact 规范，
// 本门保库内身份唯一（跨章变体在此归并）。

/** 身份解析结果（handler 消费 + 观测）。 */
export interface WorldSubjectIdentityResolution {
  /** 解析后 subjects（id 已收敛 canonical/既有；同 id 登记已 COALESCE 合并）。 */
  subjects: WorldSubject[];
  /** 解析后 patches（subjectId 与 value 内 subject:// ref 已同步改写）。 */
  patches: WorldPatchInput[];
  /** id 改写明细（from → to；空 = 请求已全规范且无变体）。 */
  remaps: Array<{ from: string; to: string }>;
  /** 复用既有主体数（= 挂到既有 subject；其余为新登记）。 */
  reusedCount: number;
}

/**
 * 解析一批写入请求的 subject 身份：规范化形态 + 查重复用。
 *
 * 规则（mirror 迁移 migrateWorldSubjectIds 的 canonical 判定）：
 * 1. 有 sourceCardId 的 subject → id = 卡 id（对齐目标轨契约）；库内已有同卡锚主体 → 复用其 id。
 * 2. 无卡 → canonical = worldSubjectId(type, id)；库内精确命中 → 复用；未命中按 worldSubjectMatchKey
 *    兜底（连字符/前缀/大小写变体归并，**卡锚主体也在索引内**——LLM 用了卡 id 当 subjectId 但漏带
 *    sourceCardId 时兜回卡主体）；仍无 → 同 slug 遗留 entity 哨兵认领（见 5）；最后才新登记 canonical。
 * 3. **type='entity' 哨兵**（world-state-merge linkReferencedSubjects 对批内裸 ref 补的 stub——type
 *    未知非类型声明）不参与 type 键身份：slug-only 桶唯一命中即认领（批内具体主体优先），防
 *    `entity:sword-01` 与 `item:sword-01` 分身并存——提取器 prompt 的 ref 示例是裸形态
 *    （`subject://erina`），subjects 已 canonical 化而 ref 未改，stub 是常态路径非边角。
 * 4. patch.subjectId：请求内 subject 映射优先；表外 id 按库内精确 + slug-only 唯一命中归一；都不中
 *    保留原值（不臆测）。
 * 5. patch.value 内 `subject://` ref 同 4 归一（精确匹配 ref 整串，经 rewriteSubjectRefsInValue 单源）。
 *    slug-only 桶规则：恰一个具体 type（非 entity）主体 → 可解（entity 在场不构成歧义，具体者胜）；
 *    仅 entity → 可解；≥2 具体 → 多义不解析（character:phoenix vs faction:phoenix 不臆测）。桶输入 =
 *    既有库主体 + 本批已解析主体（批内 canonical 登记后裸 ref 即可对上）。
 *
 * 范式判据（ADR-3）：纯机械身份归并（形态/键匹配），不判「两个名字是否同一实体」（语义归提取器 LLM
 * + 修补 Agent）。同步函数（db-repository.md 惯例）。
 */
export function resolveWorldSubjectIdentity(
  projectId: string,
  subjects: WorldSubject[],
  patches: WorldPatchInput[],
): WorldSubjectIdentityResolution {
  const existing = listWorldSubjects(projectId);
  const byExactId = new Set(existing.map((s) => s.id));
  const byCardId = new Map<string, WorldSubject>();
  const byMatchKey = new Map<string, WorldSubject>();
  for (const s of existing) {
    if (s.sourceCardId !== undefined && !byCardId.has(s.sourceCardId)) {
      byCardId.set(s.sourceCardId, s);
    }
    // matchKey 索引含卡锚主体（mirror 迁移分组「卡锚成员也按自身 id 的 matchKey 入组」）。
    const mk = worldSubjectMatchKey(s.type, s.id);
    const prev = byMatchKey.get(mk);
    if (prev === undefined || (prev.sourceCardId === undefined && s.sourceCardId !== undefined)) {
      byMatchKey.set(mk, s); // 同键既有卡锚又有裸主体时卡锚优先（确定性）
    }
  }

  // ── slug-only 桶（entity 哨兵解析 + ref 解析共用——ref 串不携带 type）──
  // 桶输入 = 既有库主体 + 本批已解析主体（addSlugOnce 防批内合并重复计数）。
  interface SlugBucket {
    concrete: WorldSubject | undefined;
    concreteCount: number;
    entity: WorldSubject | undefined;
  }
  const slugBuckets = new Map<string, SlugBucket>();
  const slugAddedIds = new Set<string>();
  const addSlugOnce = (subject: WorldSubject): void => {
    if (slugAddedIds.has(subject.id)) return;
    slugAddedIds.add(subject.id);
    const key = worldSubjectSlugKey(subject.id);
    let bucket = slugBuckets.get(key);
    if (bucket === undefined) {
      bucket = { concrete: undefined, concreteCount: 0, entity: undefined };
      slugBuckets.set(key, bucket);
    }
    if (subject.type === 'entity') {
      if (bucket.entity === undefined) bucket.entity = subject;
    } else {
      bucket.concreteCount += 1;
      if (bucket.concrete === undefined) bucket.concrete = subject;
    }
  };
  const resolveSlug = (key: string): WorldSubject | undefined => {
    const bucket = slugBuckets.get(key);
    if (bucket === undefined) return undefined;
    if (bucket.concreteCount === 1) return bucket.concrete;
    return bucket.concreteCount === 0 && bucket.entity !== undefined ? bucket.entity : undefined;
  };
  for (const s of existing) addSlugOnce(s);

  // ── subjects 解析（id 收敛 + 同 id 登记 COALESCE 合并；两趟：具体 type 先、entity 哨兵后）──
  const remaps = new Map<string, string>();
  const outSubjects = new Map<string, WorldSubject>();
  let reusedCount = 0;

  const registerSubject = (s: WorldSubject, finalId: string): void => {
    if (finalId !== s.id) remaps.set(s.id, finalId);
    if (byExactId.has(finalId)) reusedCount += 1;
    const resolved: WorldSubject = { ...s, id: finalId };
    addSlugOnce(resolved);
    const merged = outSubjects.get(finalId);
    if (merged) {
      if (merged.name === undefined && s.name !== undefined) merged.name = s.name;
      if (merged.sourceCardId === undefined && s.sourceCardId !== undefined) {
        merged.sourceCardId = s.sourceCardId;
      }
    } else {
      outSubjects.set(finalId, resolved);
    }
  };

  const resolveConcrete = (s: WorldSubject): string => {
    if (s.sourceCardId !== undefined && s.sourceCardId.length > 0) {
      return byCardId.get(s.sourceCardId)?.id ?? s.sourceCardId;
    }
    const canonical = worldSubjectId(s.type, s.id);
    if (byExactId.has(canonical)) return canonical;
    const mkHit = byMatchKey.get(worldSubjectMatchKey(s.type, s.id));
    if (mkHit !== undefined) return mkHit.id;
    // 遗留 entity 哨兵认领：同 slug 桶内仅有 entity（无具体）→ 沿用其 id（唯一行不裂分身；type 由
    // insertWorldSlice upsert 的 COALESCE(excluded.type) 细化为本次具体 type）。桶内有具体但 matchKey
    // 未中（异 type 声明冲突）→ 不认领，走 canonical 新登记（不臆测）。
    const slugHit = resolveSlug(worldSubjectSlugKey(s.id));
    if (slugHit !== undefined && slugHit.type === 'entity') return slugHit.id;
    return canonical;
  };

  const entityQueue: WorldSubject[] = [];
  for (const s of subjects) {
    if (s.type === 'entity') {
      entityQueue.push(s);
      continue;
    }
    registerSubject(s, resolveConcrete(s));
  }
  for (const s of entityQueue) {
    // type 未知哨兵：slug-only 唯一命中（具体优先，次 entity）→ 认领；多义/无 → canonical 新登记。
    const hit = resolveSlug(worldSubjectSlugKey(s.id));
    registerSubject(s, hit !== undefined ? hit.id : worldSubjectId(s.type, s.id));
  }

  // ── patches 归一（subjectId 映射 + value ref 改写）──
  const resolveRefId = (refId: string): string | undefined => {
    const direct = remaps.get(refId);
    if (direct !== undefined) return direct;
    if (byExactId.has(refId)) return refId;
    return resolveSlug(worldSubjectSlugKey(refId))?.id;
  };
  const outPatches = patches.map((p) => {
    let subjectId = remaps.get(p.subjectId);
    if (subjectId === undefined) subjectId = resolveRefId(p.subjectId) ?? p.subjectId;
    let value = p.value;
    if (value !== undefined && typeof value === 'string' && value.includes('subject://')) {
      // 快路径：scalar ref 串（最常见形态）；结构化 value 走递归（含 ref 但非整串的情况稀有，统一
      // 交给 rewriteSubjectRefsInValue 递归判定，changed=false 原样返回零成本）。
      const rewritten = rewriteSubjectRefsInValue(value, resolveRefId);
      if (rewritten.changed) value = rewritten.value;
    } else if (value !== undefined && value !== null && typeof value === 'object') {
      const raw = JSON.stringify(value);
      if (raw.includes('subject://')) {
        const rewritten = rewriteSubjectRefsInValue(value, resolveRefId);
        if (rewritten.changed) value = rewritten.value;
      }
    }
    if (subjectId === p.subjectId && value === p.value) return p;
    return { ...p, subjectId, value };
  });

  return {
    subjects: [...outSubjects.values()],
    patches: outPatches,
    remaps: [...remaps.entries()].map(([from, to]) => ({ from, to })),
    reusedCount,
  };
}

// ── slice + patch 写入（事务包裹，crash-consistency）──

/**
 * 写入一个 slice + 其 patches + 涉及的 subjects（单 WAL 事务，mirror closureIndexer 事务模式）。
 * source 由调用方强制传入（write_world_events='derived' / amend_world_state='amendment'）——patches
 * 输入不带 source，本函数注入，防误标。patch id = randomUUID；sliceId = slice.id；storyTime 反范式
 * 自 slice.storyTime；project_id 冗余填（reduce 查询主路径避 JOIN slice）。
 *
 * slice ON CONFLICT(id) DO UPDATE（idempotent 重写同 slice）；同 slice 的旧 patches 先删再插（per-slice
 * idempotency：重提取同 slice.id 时替换其 patches，不重复累积——调用方用稳定 slice.id 启用干净重提取）。
 * episode_id COALESCE（Story 8.1，mirror subject COALESCE CR-E2）：调用方未携带（amendment 锚 slice /
 * 旧 caller）→ 保留既有列不回写 NULL——slice.id 前缀已固定归属，episode 不会真变。
 * subjects 先于 patches upsert（首次提取自动建 subject，firstSeenStoryTime 缺省取 slice.storyTime）。
 */
export function insertWorldSlice(
  projectId: string,
  slice: Omit<WorldSlice, 'projectId'>,
  patches: WorldPatchInput[],
  subjects: WorldSubject[],
  source: WorldPatchSource,
): void {
  const db = getDb();
  db.transaction(() => {
    // Story 8.1：改写前捕获旧 slice 状态（storyTime + episode 归属 + 旧 patches 的 subjects）——checkpoint
    // 与 chapter summary 显式失效的判定输入。重写可能改 storyTime（往前挪/往后挪）、挪 episode 归属、或
    // 移除某 subject 的 patches（重提取产出零 patch），三者的失效都依赖「改写前」快照，故必须在下方
    // DELETE/UPSERT 之前读。
    const oldSliceRow = db
      .prepare('SELECT story_time, episode_id FROM closure_world_slice WHERE id = ?')
      .get(slice.id) as AnyRow | undefined;
    const oldPatchSubjects = (
      db
        .prepare('SELECT DISTINCT subject_id FROM closure_world_patch WHERE slice_id = ?')
        .all(slice.id) as AnyRow[]
    ).map((r) => r.subject_id as string);

    db.prepare(
      `INSERT INTO closure_world_slice (id, project_id, story_time, kind, title, summary, episode_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         story_time = excluded.story_time,
         kind = excluded.kind,
         title = excluded.title,
         summary = excluded.summary,
         episode_id = COALESCE(excluded.episode_id, closure_world_slice.episode_id)`,
    ).run(
      slice.id,
      projectId,
      slice.storyTime,
      slice.kind ?? null,
      slice.title,
      slice.summary ?? null,
      slice.episodeId ?? null,
    );

    // CR-1：删同 slice 旧 patches 按 source 分支——
    // - source='derived'：删全 source（重建 derived + amendment 同步清零，design §2 重跑语义——amendment 是
    //   临时覆盖层，依附当时派生快照，重提取 derived 从 prose 重建时 amendment 失去依附须清零）。
    // - source='amendment'：只删该 slice 的 amendment（保 derived；re-amend 替换覆盖层不碰派生层，amendment
    //   覆盖层叠加语义正确——同 slice.id 多次修补只留最新 amendment patches）。
    // 稳定 slice.id 是 per-slice idempotency 前提（重提取/重修补同 slice.id 时替换不累积）。
    if (source === 'amendment') {
      db.prepare(
        "DELETE FROM closure_world_patch WHERE slice_id = ? AND source = 'amendment'",
      ).run(slice.id);
    } else {
      db.prepare('DELETE FROM closure_world_patch WHERE slice_id = ?').run(slice.id);
    }

    for (const subject of subjects) {
      db.prepare(
        `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, id) DO UPDATE SET
           type = COALESCE(excluded.type, closure_world_subject.type),
           name = COALESCE(excluded.name, closure_world_subject.name),
           source_card_id = COALESCE(excluded.source_card_id, closure_world_subject.source_card_id)`,
      ).run(
        subject.id,
        projectId,
        subject.type,
        subject.name ?? null,
        subject.sourceCardId ?? null,
        // 首次出现的故事时间；调用方未提供则取 slice.storyTime（主体登记是稳定登记，subject-lifecycle §6）。
        subject.firstSeenStoryTime ?? slice.storyTime,
      );
    }

    const insertPatch = db.prepare(
      `INSERT INTO closure_world_patch (id, slice_id, project_id, subject_id, path, op, value, axis, source, summary, evidence_scene_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const patch of patches) {
      insertPatch.run(
        randomUUID(),
        slice.id,
        projectId,
        patch.subjectId,
        patch.path,
        patch.op,
        // remove 无 value → NULL；其余 JSON.stringify（合法 JSON 值；NaN/Infinity 等非 JSON 由调用方自律）。
        patch.value !== undefined ? JSON.stringify(patch.value) : null,
        patch.axis,
        source,
        patch.summary ?? null,
        // Story 6.4 D1：认知 patch transmit 场（evidenceSceneId）；其他轴 NULL。
        patch.evidenceSceneId ?? null,
      );
    }

    // ── Story 8.1：checkpoint 显式失效（design §2/§7，正确性核心之一）──
    //
    // 本 slice 改写（重提取/重修补）后，触及 subjects 在 storyTime >= 失效起点的 checkpoint 不再可信：
    // - 失效起点 = min(旧 slice storyTime, 新 slice storyTime)——重写可能挪动 storyTime，两侧都盖到。
    // - 触及 subjects = 旧 patches 的 subjects ∪ 新 patches 的 subjects。**含旧 patches** 是关键：重写产出
    //   零 patch（如重提取后某 subject 无变化）会「删掉该 subject 在此 slice 的 patches 而不留新行」——
    //   水印（rowid 单调性）在这类**删除路径**上漏判（design §7：删除不留 rowid 痕迹），显式失效是唯一防线
    //   （水印是 belt，本 DELETE 是主保险）。
    // - `>=`（非 `>`）：checkpoint at = fold **含**该 storyTime 的全部 patches（story_time <= at），同
    //   storyTime 的 patch 替换即污染该 checkpoint。
    // 与 CR-1 source 分支 DELETE（上）互不干扰——各删各的表，同事务零成本。
    const touchedSubjects = new Set<string>(oldPatchSubjects);
    for (const patch of patches) touchedSubjects.add(patch.subjectId);
    // 失效起点（checkpoint 与 summary 的 storyTime 镜像档共用）：min(旧/新 storyTime)——重写可能挪
    // storyTime，两侧都盖到。新 slice（无旧行）= 新 storyTime。
    const invalidFrom =
      oldSliceRow !== undefined
        ? Math.min(oldSliceRow.story_time as number, slice.storyTime)
        : slice.storyTime;
    if (touchedSubjects.size > 0) {
      const placeholders = [...touchedSubjects].map(() => '?').join(',');
      db.prepare(
        `DELETE FROM closure_world_checkpoint
         WHERE project_id = ? AND subject_id IN (${placeholders}) AND at_story_time >= ?`,
      ).run(projectId, ...touchedSubjects, invalidFrom);
    }

    // ── Story 8.1 CR-5：chapter summary 级联失效（checkpoint 失效的 summary 对应物）──
    //
    // 本 slice 改写（重提取/重修补）后，affected episode 及之后章节的已物化 summary 不再可信：后章
    // summary 的 cast/dormancy fold 窗含本 slice 的 patches、其视角也被前章 patch 改动污染，故 `>=`。
    // affected episodes = 旧 slice 归属 ∪ 新 slice 归属（episode_id 列优先，NULL → 硬化前缀解析
    // parseEpisodeIdFromSliceId 单源）。三档失效：
    // 1. 全部 affected episodes 都有已物化 summary 行且 index 非 NULL → `episode_index >= min(index)`
    //    精确删（index 解析自 closure_chapter_summary 自身的 episode_index 列——repository 层无
    //    episode_outlines 访问，已物化行是该 episode index 的库内唯一载体）。
    // 2. 任一 affected episode 尚未物化（无 summary 行 / index NULL）→ 无 index 可解——按 storyTime
    //    镜像删（story_time_end >= invalidFrom 的行 = fold 窗含本 slice 改动的章）。**不做保守全删**：
    //    前向写作（逐章 write→materialize interleave）常态是「写本章 slices 时本章 summary 未建」，
    //    全删会每章销毁全部历史 summary（worldStateScale B3 的 400 行即被此路径清空）；storyTime 镜像
    //    与 checkpoint 失效同界，前向（新 storyTime 最大）零误删。
    // 3. episode 归属完全不可解析（无 episode_id 且 slice.id 不合 `${episodeId}:${数字}` 契约）→ 保守
    //    删全项目行（无从定位损伤范围；DERIVED 可重建）。
    const affectedEpisodeIds = new Set<string>();
    const oldEpisodeId = (oldSliceRow?.episode_id as string | null | undefined) ?? null;
    if (oldEpisodeId !== null) affectedEpisodeIds.add(oldEpisodeId);
    else if (oldSliceRow !== undefined) {
      const parsed = parseEpisodeIdFromSliceId(slice.id);
      if (parsed !== undefined) affectedEpisodeIds.add(parsed);
    }
    if (slice.episodeId !== undefined) affectedEpisodeIds.add(slice.episodeId);
    else {
      const parsed = parseEpisodeIdFromSliceId(slice.id);
      if (parsed !== undefined) affectedEpisodeIds.add(parsed);
    }

    if (affectedEpisodeIds.size === 0) {
      deleteChapterSummaryRetrievalRows(projectId, 'project_id = ?', [projectId]);
      db.prepare('DELETE FROM closure_chapter_summary WHERE project_id = ?').run(projectId);
    } else {
      let minIndex: number | null = null;
      let allResolved = true;
      for (const epId of affectedEpisodeIds) {
        const row = db
          .prepare('SELECT episode_index FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?')
          .get(projectId, epId) as { episode_index: number | null } | undefined;
        if (row === undefined || row.episode_index === null) {
          allResolved = false;
          break;
        }
        if (minIndex === null || row.episode_index < minIndex) minIndex = row.episode_index;
      }
      if (allResolved && minIndex !== null) {
        // E4A7：检索行先于 summary 行删（从 summary 行反查 episode_id 构 entry_id）。
        deleteChapterSummaryRetrievalRows(
          projectId,
          'project_id = ? AND episode_index >= ?',
          [projectId, minIndex],
        );
        db.prepare(
          'DELETE FROM closure_chapter_summary WHERE project_id = ? AND episode_index >= ?',
        ).run(projectId, minIndex);
      } else {
        deleteChapterSummaryRetrievalRows(
          projectId,
          'project_id = ? AND story_time_end IS NOT NULL AND story_time_end >= ?',
          [projectId, invalidFrom],
        );
        db.prepare(
          'DELETE FROM closure_chapter_summary WHERE project_id = ? AND story_time_end IS NOT NULL AND story_time_end >= ?',
        ).run(projectId, invalidFrom);
      }
    }
  })();
}

// ── patch 读取（reduce 查询用）──

/**
 * 列出项目内 patches（JOIN slice 取 story_time），可选 subjectId 过滤、可选 at 截断（story_time <= at）。
 * 按 story_time 升序、同 story_time 时 derived 先于 amendment（CR-4：CASE 显式定序，与 reduceSubject
 * SOURCE_ORDER 一致——reduce 内再稳定排序一次，幂等）。返 WorldPatch[]（含 storyTime 反范式字段）。
 *
 * `axis` 可传单轴或多轴（Story 8.3 S5 / 6.4 E4）：多轴走 `IN`（一次扫描）——presence 投影需
 * cognitive+physical 双轴同取（buildPresenceSignal 两轴都消费），单轴调用面（6.4 D4 起）零变化。
 */
export function listWorldPatches(
  projectId: string,
  subjectId?: string,
  at?: number,
  axis?: string | readonly string[],
): WorldPatch[] {
  const db = getDb();
  const conditions = ['p.project_id = ?'];
  const params: unknown[] = [projectId];
  if (subjectId) {
    conditions.push('p.subject_id = ?');
    params.push(subjectId);
  }
  if (axis !== undefined) {
    // Story 6.4 D4（6.1 DW）：axis filter——cognitive 轴查询不扫全轴（规模耐受，memory 6.1 DW 延 6.4）。
    if (typeof axis === 'string') {
      if (axis.length > 0) {
        conditions.push('p.axis = ?');
        params.push(axis);
      }
    } else if (axis.length > 0) {
      // 空数组 = 无过滤（与 undefined 同义；空 IN 是 SQL 语法错误）。
      conditions.push(`p.axis IN (${axis.map(() => '?').join(',')})`);
      params.push(...axis);
    }
  }
  if (at !== undefined) {
    conditions.push('s.story_time <= ?');
    params.push(at);
  }
  const sql =
    `SELECT ${PATCH_WITH_TIME_COLS} FROM closure_world_patch p ` +
    'JOIN closure_world_slice s ON s.id = p.slice_id ' +
    `WHERE ${conditions.join(' AND ')} ` +
    // CR-4：同 storyTime 时 derived 先于 amendment（与 reduceSubject SOURCE_ORDER 一致——derived(0) 先于
    // amendment(1)，amendment 是覆盖层应用于 derived 之上）。p.source ASC 字母序误使 amendment<'derived' 反序，
    // 用 CASE 显式定序。reduce 内再稳定排序一次（storyTime + source），幂等。
    "ORDER BY s.story_time ASC, CASE WHEN p.source = 'derived' THEN 0 ELSE 1 END, p.rowid ASC";
  const rows = db.prepare(sql).all(...params) as AnyRow[];
  return rows.map(patchRowToRecord);
}

/**
 * 列出项目内 slices，可选过滤：subjectIds（slices 其 patches 触及任一这些 subject）/ type（slices 触及
 * 该 type subject）/ at（story_time <= at）/ episodeId（Story 8.1：episode 归属过滤——episode_id 列命中
 * OR 存量行 NULL 时 slice_id LIKE '<episodeId>:%' legacy fallback，design §4）。withPatches=true 时每
 * slice 附 patches[]（同 listWorldPatches 映射）。按 story_time 升序。Mirror NeuroBook world.slice.list 收窄契约。
 */
export function listWorldSlices(
  projectId: string,
  opts: {
    subjectIds?: string[];
    type?: string;
    withPatches?: boolean;
    at?: number;
    axis?: string;
    episodeId?: string;
  } = {},
): Array<WorldSlice & { patches?: WorldPatch[] }> {
  const db = getDb();
  const conditions = ['s.project_id = ?'];
  const params: unknown[] = [projectId];
  if (opts.at !== undefined) {
    conditions.push('s.story_time <= ?');
    params.push(opts.at);
  }
  if (opts.episodeId) {
    // Story 8.1：episode_id 列优先（新写入显式落列）；存量行 NULL → slice_id LIKE '<episodeId>:%' 解析
    // fallback（slice.id = `${episodeId}:${storyTime}`，冒号定界防前缀误匹配 ep-1 vs ep-12）。CR-7：
    // episodeId 含 `_` 时模式须转义（`ep_1:%` 的 `_` 是单字符通配符会误匹配 `epX1:...`）——escapeLike +
    // ESCAPE '\' 子句。
    conditions.push("(s.episode_id = ? OR (s.episode_id IS NULL AND s.id LIKE ? ESCAPE '\\'))");
    params.push(opts.episodeId, `${escapeLike(opts.episodeId)}:%`);
  }
  if (opts.subjectIds && opts.subjectIds.length > 0) {
    const placeholders = opts.subjectIds.map(() => '?').join(',');
    conditions.push(
      `s.id IN (SELECT DISTINCT slice_id FROM closure_world_patch WHERE project_id = ? AND subject_id IN (${placeholders}))`,
    );
    params.push(projectId, ...opts.subjectIds);
  }
  if (opts.type) {
    conditions.push(
      `s.id IN (SELECT DISTINCT p.slice_id FROM closure_world_patch p ` +
        'JOIN closure_world_subject sub ON sub.id = p.subject_id AND sub.project_id = p.project_id ' +
        'WHERE p.project_id = ? AND sub.type = ?)',
    );
    params.push(projectId, opts.type);
  }
  // 外层 FROM 仅 closure_world_slice s（subjectIds/type 过滤是标量子查询 IN，不引入歧义）——非限定列名
  // 直取 SLICE_COLS 常量（防 SELECT 列漂移，mirror SUBJECT_COLS 用法；Step 2 曾内联致常量悬空 lint warning）。
  const sliceSql =
    `SELECT ${SLICE_COLS} FROM closure_world_slice s WHERE ${conditions.join(' AND ')} ` +
    'ORDER BY s.story_time ASC, s.id ASC';
  const sliceRows = db.prepare(sliceSql).all(...params) as AnyRow[];
  const slices = sliceRows.map((row) => ({ ...sliceRowToRecord(row), patches: undefined })) as Array<
    WorldSlice & { patches?: WorldPatch[] }
  >;

  if (opts.withPatches && slices.length > 0) {
    const sliceIds = slices.map((s) => s.id);
    const placeholders = sliceIds.map(() => '?').join(',');
    const patchConditions = ['p.project_id = ?', `p.slice_id IN (${placeholders})`];
    const patchParams: unknown[] = [projectId, ...sliceIds];
    if (opts.axis) {
      // Story 6.4 D4（6.1 DW）：axis filter——withPatches 时只取该轴 patches（规模耐受）。
      patchConditions.push('p.axis = ?');
      patchParams.push(opts.axis);
    }
    const patchRows = db
      .prepare(
        `SELECT ${PATCH_WITH_TIME_COLS} FROM closure_world_patch p ` +
          'JOIN closure_world_slice s ON s.id = p.slice_id ' +
          `WHERE ${patchConditions.join(' AND ')} ` +
          // CR-4：同 storyTime 时 derived 先于 amendment（mirror listWorldPatches 排序 + reduceSubject SOURCE_ORDER）。
          "ORDER BY s.story_time ASC, CASE WHEN p.source = 'derived' THEN 0 ELSE 1 END, p.rowid ASC",
      )
      .all(...patchParams) as AnyRow[];
    const patchesBySlice = new Map<string, WorldPatch[]>();
    for (const row of patchRows) {
      const patch = patchRowToRecord(row);
      const list = patchesBySlice.get(patch.sliceId) ?? [];
      list.push(patch);
      patchesBySlice.set(patch.sliceId, list);
    }
    for (const slice of slices) {
      slice.patches = patchesBySlice.get(slice.id) ?? [];
    }
  }
  return slices;
}

/**
 * slice.id → episode id 硬化前缀解析（CR-13，8.1 修复批）：要求**最后一个 `:` 的后缀为纯数字**
 * （storyTime 整数契约）才归属，否则返 undefined（列保持 NULL / 调用方跳过——显式 episode_id 列归属
 * 优先）。挡结构性噪声：无 ':' / episode 段为空 / 后缀非数字（'dz'、'a:b:c'、'foo:bar'）。
 *
 * ⚠️ 'am-fix:200' 这类形态上合法的 id 仍会解析出 'am-fix'——前缀是否**真实 episode**（vs 修补标签等
 * 幻影前缀）不是字符串形态可判的，过滤归 rebuildChapterSummaries 的 episode_outlines 存在性 gate
 * （worldStateMaterialize.ts）。本函数只做「形态上可信的归属」。
 *
 * 最后一个 ':'（非首个）：`${episodeId}:${storyTime}` 契约里 storyTime 是数字后缀；episodeId 本身
 * 约定无 ':'（[\w-]+），但硬化解析按结构判（末段数字）而非假设调用方守约。
 */
export function parseEpisodeIdFromSliceId(sliceId: string): string | undefined {
  const sep = sliceId.lastIndexOf(':');
  if (sep <= 0) return undefined; // 无 ':' 或 episode 段为空
  const suffix = sliceId.slice(sep + 1);
  if (!/^-?\d+$/.test(suffix)) return undefined; // 后缀须为整数（storyTime 契约；容负序数）
  return sliceId.slice(0, sep);
}

/**
 * 存量 slice 行的 episode_id 懒补（Story 8.1 design §4「一次性 backfill UPDATE 在 materialize handler
 * 首跑时懒补」）：对 episode_id IS NULL 且 id 含 ':' 的行，以硬化前缀解析（parseEpisodeIdFromSliceId
 * 单源——与查询侧 worldSliceEpisodeId / insertWorldSlice 失效归类同一分类器，防 SQL/JS 两套解析漂移）
 * 回填列。幂等（只触 NULL 行）；解析不过的行不动（列保持 NULL，显式归属优先，CR-13）。
 *
 * CR-12（8.1 修复批）：入口 EXISTS 守卫——无 NULL 行直接跳过（每章物化都调本函数，旧实现每次白跑
 * 全表 UPDATE 扫描；常态〔首跑补齐后〕零 UPDATE 开销）。
 *
 * @returns 回填行数（0 = 无需补——首跑后常态）。
 */
export function backfillWorldSliceEpisodeIds(projectId: string): number {
  const db = getDb();
  const pending = db
    .prepare(
      'SELECT EXISTS(SELECT 1 FROM closure_world_slice WHERE project_id = ? AND episode_id IS NULL) AS has',
    )
    .get(projectId) as { has: number } | undefined;
  if (pending?.has !== 1) return 0;

  const rows = db
    .prepare(
      "SELECT id FROM closure_world_slice WHERE project_id = ? AND episode_id IS NULL AND instr(id, ':') > 1",
    )
    .all(projectId) as Array<{ id: string }>;
  const updates = rows.flatMap((r) => {
    const episodeId = parseEpisodeIdFromSliceId(r.id);
    return episodeId !== undefined ? [{ id: r.id, episodeId }] : [];
  });
  if (updates.length === 0) return 0;
  const stmt = db.prepare('UPDATE closure_world_slice SET episode_id = ? WHERE id = ?');
  db.transaction(() => {
    for (const u of updates) stmt.run(u.episodeId, u.id);
  })();
  return updates.length;
}

// ── reduce（调 shared-contracts 纯函数 + attrs 投影）──

/**
 * reduce 一个 subject 在给定虚构时刻的状态。读 patches（JOIN slice 取 storyTime）→ 调 shared-contracts
 * `reduceSubject` 纯函数 → 可选 attrs 投影（只留顶层属性 + issues 跟随收窄，NeuroBook §8）。
 * 返 { state, issues }。at 缺省取最新（全叠加）。
 */
export function reduceWorldSubject(
  projectId: string,
  subjectId: string,
  at?: number,
  options?: { attrs?: string[]; kindResolver?: WorldKindResolver },
): { state: ReducedState; issues: WorldIssue[] } {
  const patches = listWorldPatches(projectId, subjectId, at);
  const result = reduceSubject(patches, subjectId, at, {
    kindResolver: options?.kindResolver,
  });

  if (options?.attrs && options.attrs.length > 0) {
    const attrSet = new Set(options.attrs);
    const projected: ReducedState = {};
    for (const key of Object.keys(result.state)) {
      if (attrSet.has(key)) projected[key] = result.state[key];
    }
    // issues 跟随投影收窄：只留 path 顶层段在 attrs 内的（查 hp 不带回 location 的 dangling 噪音）。
    const narrowedIssues = result.issues.filter((issue) => {
      const firstSeg = issue.path.replace(/^\//, '').split('/')[0];
      return firstSeg !== '' && attrSet.has(firstSeg);
    });
    return { state: projected, issues: narrowedIssues };
  }
  return result;
}

// ── ref 反查 ──

export type WorldRefHit = {
  /** 引用方 subject id（谁的属性指向目标）。 */
  subjectId: string;
  /** 引用发生的 JSON Pointer path（如 /equipment/weapon）。 */
  path: string;
  sliceId: string;
  storyTime: number;
  /** 引用值本身（通常 `subject://<id>` 字符串，但调用方可见完整结构）。 */
  value: unknown;
};

/**
 * 反查所有指向 `subjectId` 的引用（NeuroBook §5：关系只存一边，反查找谁引用我）。LIKE 预筛
 * `subject://<id>` + JSON.parse 精确匹配（避前缀误匹配，如 subject://erina vs subject://erina2）。
 * 返 WorldRefHit[]（引用方 subjectId/path/sliceId/storyTime/value）。跨轴全 source（derived + amendment）。
 */
export function findWorldRefs(projectId: string, subjectId: string): WorldRefHit[] {
  const db = getDb();
  // LIKE 预筛：value 文本含 subject://<id>。id 是 [\w-]+（无引号/反斜杠）；CR-7：`_` 须转义（未转义的
  // needle 会以单字符通配误预筛 `subject://epX1` 这类值——精确匹配虽兜底排除，预筛过宽既是 perf 损
  // 也违背构造即正确），配 ESCAPE '\' 子句。JSON.parse 精确匹配（避前缀误匹配，如 subject://erina vs
  // subject://erina2）。
  const needle = `%${escapeLike(`subject://${subjectId}`)}%`;
  const rows = db
    .prepare(
      `SELECT ${PATCH_WITH_TIME_COLS} FROM closure_world_patch p ` +
        'JOIN closure_world_slice s ON s.id = p.slice_id ' +
        "WHERE p.project_id = ? AND p.value LIKE ? ESCAPE '\\'",
    )
    .all(projectId, needle) as AnyRow[];
  const targetRef = `subject://${subjectId}`;
  const hits: WorldRefHit[] = [];
  for (const row of rows) {
    const rawValue = row.value as string | null;
    if (rawValue == null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      continue;
    }
    if (containsSubjectRef(parsed, targetRef)) {
      hits.push({
        // row 键是 snake_case（PATCH_WITH_TIME_COLS `p.subject_id AS subject_id`）——8.1 fixture 漂移修
        // 暴露的 6.6 拼写 bug：原 `row.subjectId` 恒 undefined，find_world_refs 输出的引用方 id 一直丢失。
        subjectId: row.subject_id as string,
        path: row.path as string,
        sliceId: row.slice_id as string,
        storyTime: row.story_time as number,
        value: parsed,
      });
    }
  }
  return hits;
}

/** 递归检测 value 内是否含目标 ref 串（string 直接比；array/object 递归扫元素/值）。 */
function containsSubjectRef(value: unknown, targetRef: string): boolean {
  if (typeof value === 'string') return value === targetRef;
  if (Array.isArray(value)) return value.some((el) => containsSubjectRef(el, targetRef));
  if (value && typeof value === 'object') {
    return Object.values(value).some((v) => containsSubjectRef(v, targetRef));
  }
  return false;
}

// ── 重跑提取清理 ──

/**
 * 删 chapter_summary 检索行（closure_entry + entry_vec），范围为「即将被级联删除的
 * closure_chapter_summary 行」（`summaryWhere` 与后随的 summary DELETE 同条件）。
 *
 * E4A7（CR 2026-08-20）：级联失效三档 / resetWorldState 删 closure_chapter_summary 行时，对应
 * 检索行（source_kind='chapter_summary'）若不同步清，链中止（pause/reject）后的旧 synopsis 会跨
 * 会话被 query_story 搜到。**必须在 summary 行删除之前调用**（episode_id 反查自 summary 行）。
 * entry_id = `${projectId}:${episodeId}#summary`——构串 mirror chapterSummaryIndexer.
 * chapterSummaryEntryId（⚠️ 两处同步纪律；本模块不 import indexer——反向 import 成环，indexer
 * 依赖本模块的 listChapterSummaries，故删除 SQL 内联于此）。entry_vec 点删按 entry_id 等值（vec0
 * DELETE 支持面），gated 扩展可用（扩展缺失时 entry_vec 表不存在）。
 */
function deleteChapterSummaryRetrievalRows(
  projectId: string,
  summaryWhere: string,
  summaryParams: unknown[],
): void {
  const db = getDb();
  const rows = db
    .prepare(`SELECT episode_id FROM closure_chapter_summary WHERE ${summaryWhere}`)
    .all(...summaryParams) as Array<{ episode_id: string }>;
  if (rows.length === 0) return;
  const delEntry = db.prepare(
    "DELETE FROM closure_entry WHERE project_id=? AND source_kind='chapter_summary' AND entry_id=?",
  );
  const delVec = db.prepare('DELETE FROM entry_vec WHERE entry_id=?');
  const vecAvailable = isSqliteVecAvailable();
  for (const { episode_id } of rows) {
    // source_kind guard：病理态下同 entry_id 被非 chapter_summary 行占据时不误删（mirror F9）。
    delEntry.run(projectId, `${projectId}:${episode_id}#summary`);
    if (vecAvailable) delVec.run(`${projectId}:${episode_id}#summary`);
  }
}

/**
 * 删项目的全部 patches（derived + amendment）+ cascade slices，**保留 subject 身份**（subject-lifecycle
 * §6 稳定登记——删切面不删 subject，同 id 后续继续写入复用原 type/name）。design §2 重跑流：重提取前
 * resetWorldState → write_world_events 重建 derived（amendment 随 reset 清零，修补临时性依附当时派生快照）。
 * 事务包裹（patch + slice 一致删除）。
 */
export function resetWorldState(projectId: string): void {
  const db = getDb();
  db.transaction(() => {
    // 显式删 patches（按冗余 project_id，belt-and-suspenders——即便 slice cascade 链断也不留 orphan）。
    db.prepare('DELETE FROM closure_world_patch WHERE project_id = ?').run(projectId);
    // 删 slices（patch 已清空，cascade 无操作，但保留以清 slice 行本身）。
    db.prepare('DELETE FROM closure_world_slice WHERE project_id = ?').run(projectId);
    // subject 身份保留（不删 closure_world_subject）。
    //
    // ── Story 8.1：二级派生缓存同步清零（design §2「失效」）──
    // patches/slices 全删后，checkpoint（fold 结果）与 chapter_summary（章末摘要）全部失去依据——
    // 留着即 stale。重跑提取后由物化路径（lazy checkpoint / backfill summary 重建 pass）重建。
    db.prepare('DELETE FROM closure_world_checkpoint WHERE project_id = ?').run(projectId);
    // E4A7：summary 检索行先于 summary 行删（mirror 上方级联三档同点位——reset 清库后旧 synopsis
    // 检索行跨会话存活同样违 DERIVED 契约）。
    deleteChapterSummaryRetrievalRows(projectId, 'project_id = ?', [projectId]);
    db.prepare('DELETE FROM closure_chapter_summary WHERE project_id = ?').run(projectId);
    // ── Story 8.2：弧摘要级联清理（mirror 8.1 summary 级联点位，design §4）──
    // 正文重写（reset = 全量重提取）则弧审读的正文失真 → 摘要/findings 全失依据，保守清弧摘要行
    // （DERIVED 可重跑大审重建）。beats 本体住 project.yaml arc_registry——归用户/写手管理，不自动清。
    db.prepare('DELETE FROM closure_arc_summary WHERE project_id = ?').run(projectId);
    // ── Story 8.7：mention 账级联清理（mirror 8.1 summary / 8.2 弧摘要同点位）──
    // patches/slices 全删 → 在场升格/状态对拍两通道依据清零（申报通道本就章级，重提取后下次写章重收）
    // → 留着即 stale。保守清全账（DERIVED：record_episode_mentions 保守重扫 / 下次写章重收重建）。
    db.prepare('DELETE FROM closure_mention WHERE project_id = ?').run(projectId);
    // S9：信号行同点位级联清（信号对照系 = 申报 × 旧正文，重提取后全部失效）。
    db.prepare('DELETE FROM closure_mention_signals WHERE project_id = ?').run(projectId);
  })();
}

// ── Story 8.1：checkpoint 缓存 + ChapterStateSummary（design §3.1/§3.2/§4，百万字长程有界化）──
//
// checkpoint = per-subject 折叠态缓存（reduce 从最近 checkpoint 起算免全量重放，conclusions §3.1）。等价性
// （design §3.2）：reduce 是纯折叠——applyPatches(ckpt.state, (ckpt.at, at] 窗) ≡ 全量 fold（排序键不变：
// storyTime 升序 + derived 先 amendment + rowid 稳定序；checkpoint at 点是 storyTime 边界——窗 (at, at']
// 与 checkpoint fold [−∞, at] 不重不漏）。seeded reduce 原语 = shared-contracts `applyPatches`（Step 1 已落，
// 内部深拷 seed/state，db JSON.parse 出的 state 直接传无污染风险）。
//
// 有效性双保险（design §7）：
// 1. 显式失效（主保险）：insertWorldSlice / resetWorldState 事务内 DELETE（上方已接）——覆盖删除路径
//   （重写 slice 产零 patch / 清 amendment），删除不留 rowid 痕迹，水印判不了。
// 2. 水印 belt：getLatestWorldCheckpoint 校验「不存在 patch: rowid > patchRowidHigh 且 story_time <=
//   ckpt.at_story_time」——覆盖显式失效漏网的路径（手动改库等）。校验失败 → 弃该 checkpoint（试更早的），
//   全部失败 → miss 全 fold。正确性优先，性能次之。

/** checkpoint 写入输入（insertWorldCheckpoints 用；projectId 由函数参数注入）。 */
export interface WorldCheckpointInsert {
  subjectId: string;
  /** 截断点（某章末 storyTime）。 */
  atStoryTime: number;
  /** 该点折叠态（含 amendment 叠加）。 */
  state: ReducedState;
  /** reduce 至该点累计 issue 数（checkpoint 不存 issue 明细——issueCount 合并语义见 reduceWorldSubjectCheckpointed）。 */
  issueCount: number;
  /** 水印：已折叠的最大 patch rowid。 */
  patchRowidHigh: number;
  /** 观测：折叠的 patch 数。 */
  patchCountFolded: number;
}

/** checkpoint row → SubjectCheckpoint（state JSON 列容错：坏 JSON / 非 object 返 null = 该行不可用）。 */
function checkpointRowToRecord(row: AnyRow): SubjectCheckpoint | null {
  let state: unknown;
  try {
    state = JSON.parse(row.state as string);
  } catch {
    return null; // CR-E6 模式：坏 JSON 不崩，弃该 checkpoint（DERIVED 可重建）
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  return {
    projectId: row.project_id as string,
    subjectId: row.subject_id as string,
    atStoryTime: row.at_story_time as number,
    state: state as ReducedState,
    issueCount: row.issue_count as number,
    patchRowidHigh: row.patch_rowid_high as number,
    patchCountFolded: row.patch_count_folded as number,
  };
}

/**
 * 取 subject 在 at 截断点前（at_story_time <= at；at undefined = 任意）**最新且有效**的 checkpoint。
 *
 * 有效性（双 belt，design §3.1）：
 * 1. rowid 回卷 belt（CR-11，8.1 修复批）：候选的 patchRowidHigh > 该 subject **现存全部** patches 的
 *    MAX(rowid) → 证伪——checkpoint 声称折叠过的行已不存在（SQLite 删最高 rowid 行后新插入会复用更低
 *    rowid；手动清库 / 直接 DELETE 后重插即此形态，此时 state 是虚历史）。覆盖纯删除路径（水印「rowid >
 *    high 的新行」检查对删除无感知）。
 * 2. 水印 belt：对每个候选（at_story_time 降序）校验「不存在 patch: rowid > patchRowidHigh 且
 *    story_time <= 候选自身 at_story_time 且 subject 匹配」——checkpoint 声称是「fold 至 at_story_time
 *    的完整结果」，其后出现（rowid 更大）却落在该点之前的 patch 即证伪。注意校验上限是候选**自身的**
 *    at_story_time 而非查询 at：查询窗 (ckpt.at, at] 内的新 patch 本就该经窗叠加，不是证伪信号。
 * 候选无效则试更早的（checkpoint 行数 = O(总 patches / 25)，迭代有界）；state JSON 坏 → 同样弃。
 *
 * @returns 最新有效 SubjectCheckpoint；无候选 / 全部无效 → undefined（caller 走 miss 全 fold）。
 */
export function getLatestWorldCheckpoint(
  projectId: string,
  subjectId: string,
  at?: number,
): SubjectCheckpoint | undefined {
  const db = getDb();
  const conditions = ['project_id = ?', 'subject_id = ?'];
  const params: unknown[] = [projectId, subjectId];
  if (at !== undefined) {
    conditions.push('at_story_time <= ?');
    params.push(at);
  }
  const rows = db
    .prepare(
      `SELECT project_id, subject_id, at_story_time, state, issue_count, patch_rowid_high, patch_count_folded
       FROM closure_world_checkpoint
       WHERE ${conditions.join(' AND ')}
       ORDER BY at_story_time DESC`,
    )
    .all(...params) as AnyRow[];

  // CR-11 回卷 belt 输入（循环外一次算——subject 全集 MAX 不随候选变）。无 patch → 0（任何
  // patchRowidHigh > 0 的候选即证伪：其折叠过的行已全部不存在）。
  const maxRowidRow = db
    .prepare('SELECT MAX(rowid) AS max FROM closure_world_patch WHERE project_id = ? AND subject_id = ?')
    .get(projectId, subjectId) as { max: number | null } | undefined;
  const subjectMaxRowid = maxRowidRow?.max ?? 0;

  for (const row of rows) {
    const ckpt = checkpointRowToRecord(row);
    if (ckpt === null) continue;
    // 回卷 belt：声称折叠过的 rowid 已不存在（高于现存最大 rowid）→ 证伪，试更早候选。
    if (ckpt.patchRowidHigh > subjectMaxRowid) continue;
    // 水印 belt：该 checkpoint fold 完成后又有 rowid 更大的 patch 落在它声称的截断点内 → 证伪。
    const violating = db
      .prepare(
        `SELECT 1 FROM closure_world_patch p
         JOIN closure_world_slice s ON s.id = p.slice_id
         WHERE p.project_id = ? AND p.subject_id = ? AND p.rowid > ? AND s.story_time <= ?
         LIMIT 1`,
      )
      .get(projectId, subjectId, ckpt.patchRowidHigh, ckpt.atStoryTime);
    if (violating === undefined) return ckpt;
  }
  return undefined;
}

/**
 * 写入一批 checkpoint（单 WAL 事务；composite PK (project_id, subject_id, at_story_time) upsert——同点
 * 重写 last-wins，幂等）。行级字段见 WorldCheckpointInsert。空数组 no-op。
 */
export function insertWorldCheckpoints(projectId: string, rows: WorldCheckpointInsert[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO closure_world_checkpoint
       (project_id, subject_id, at_story_time, state, issue_count, patch_rowid_high, patch_count_folded)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, subject_id, at_story_time) DO UPDATE SET
       state = excluded.state,
       issue_count = excluded.issue_count,
       patch_rowid_high = excluded.patch_rowid_high,
       patch_count_folded = excluded.patch_count_folded`,
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run(
        projectId,
        r.subjectId,
        r.atStoryTime,
        JSON.stringify(r.state),
        r.issueCount,
        r.patchRowidHigh,
        r.patchCountFolded,
      );
    }
  })();
}

/**
 * checkpoint 窗口 patch 读取（私有）：单 subject，storyTime ∈ (afterExclusive, at]（边界皆可缺省），
 * 同 listWorldPatches 排序（CR-4 CASE：story_time 升序 + derived 先 amendment + rowid 稳定序）。
 * 额外返回窗内最大 patch rowid（miss 路径建 checkpoint 的水印）与最大 storyTime（miss 且 at undefined
 * 时的 checkpoint 截断点）；窗空时两者无意义（caller 已保证非空才用）。
 */
function listWorldPatchWindow(
  projectId: string,
  subjectId: string,
  afterExclusive: number | undefined,
  at: number | undefined,
): { patches: WorldPatch[]; maxRowid: number; maxStoryTime: number } {
  const db = getDb();
  const conditions = ['p.project_id = ?', 'p.subject_id = ?'];
  const params: unknown[] = [projectId, subjectId];
  if (afterExclusive !== undefined) {
    conditions.push('s.story_time > ?');
    params.push(afterExclusive);
  }
  if (at !== undefined) {
    conditions.push('s.story_time <= ?');
    params.push(at);
  }
  const rows = db
    .prepare(
      `SELECT ${PATCH_WINDOW_COLS} FROM closure_world_patch p ` +
        'JOIN closure_world_slice s ON s.id = p.slice_id ' +
        `WHERE ${conditions.join(' AND ')} ` +
        // CR-4：mirror listWorldPatches 排序（reduce 内 applyPatches 会再稳定排序一次，幂等）。
        "ORDER BY s.story_time ASC, CASE WHEN p.source = 'derived' THEN 0 ELSE 1 END, p.rowid ASC",
    )
    .all(...params) as AnyRow[];
  let maxRowid = 0;
  let maxStoryTime = Number.NEGATIVE_INFINITY;
  const patches: WorldPatch[] = [];
  for (const row of rows) {
    const rowid = (row._rowid as number) ?? 0;
    if (rowid > maxRowid) maxRowid = rowid;
    const storyTime = row.story_time as number;
    if (storyTime > maxStoryTime) maxStoryTime = storyTime;
    patches.push(patchRowToRecord(row));
  }
  return { patches, maxRowid, maxStoryTime };
}

/** reduceWorldSubjectCheckpointed 返回（含观测字段——Step 7 合成压测的成本曲线断言数据源）。 */
export interface CheckpointedReduceResult {
  /** at 截断点折叠态（≡ 全量 fold，design §3.2 等价性）。 */
  state: ReducedState;
  /**
   * checkpoint 之后窗内产生的 issue **明细**（miss 全 fold 时 = 全部明细）。seed 前的明细 checkpoint 只存
   * 计数（SubjectCheckpoint.issueCount 注释），全明细不可复原——语义上与 reduceWorldSubject.issues 的差别
   * 是本函数契约的一部分。
   */
  issues: WorldIssue[];
  /** 全史累计 issue 数（hit = ckpt.issueCount + 窗 issues.length ≡ 全量 fold issues.length；miss = issues.length）。 */
  issueCount: number;
  /** 本次实际 fold 的 patch 数（观测：checkpoint 命中时 = 窗口数，与总史规模解耦；miss = 全史数）。 */
  patchesFolded: number;
  /** 是否命中 checkpoint（观测）。 */
  checkpointHit: boolean;
  /**
   * 命中 checkpoint 的截断点（CR-10，8.1 修复批；仅 checkpointHit=true 时存在）。
   * checkpoint **推进**侧（materialize 机会式）的 patchCountFolded 须自**命中点**累计——命中后重查
   * latest 取基数会在「latest ≠ 命中点」时双计窗内数。
   */
  hitAtStoryTime?: number;
  /** 命中 checkpoint 的累计折叠数（推进侧基数，语义同上；仅 checkpointHit=true 时存在）。 */
  hitPatchCountFolded?: number;
}

/** checkpointed reduce 选项。 */
export interface CheckpointedReduceOptions {
  /** 可选 kind 解析器（透传 applyPatches，同 reduceSubject）。 */
  kindResolver?: WorldKindResolver;
  /**
   * miss 全 fold 后是否顺手写 checkpoint（lazy 初始化，design §3.1 Q2 定案：首次无 checkpoint = 全 fold
   * 一次并建首个，无需专门 backfill pass）。默认 true。**写路径只剩 materialize 机会式一处**（lazy 首建 +
   * 阈值推进）——读工具（buildWorldSnapshotCheckpointed，CR-6）固定 false：readonly/suggest 档下「读」
   * 不写库（checkpoint 写是 mode 语义的一部分，非纯 perf 优化）。
   */
  writeCheckpoint?: boolean;
}

/**
 * checkpoint-seeded reduce 一个 subject 在给定虚构时刻的状态（Story 8.1 消费主路径）。
 *
 * - 命中（getLatestWorldCheckpoint 有效返回）：applyPatches(ckpt.state, (ckpt.at, at] 窗) —— fold 量 =
 *   单 subject 增量窗（design §0 有界化），issueCount = ckpt.issueCount + 窗 issues.length。
 * - miss（无 checkpoint / 水印证伪全弃）：applyPatches({}, 全史窗) 全 fold，并按 writeCheckpoint 顺手在
 *   at（undefined 时取 patch 最大 storyTime；无 patch 不建——空 subject 建 checkpoint 无意义）写 checkpoint。
 *
 * 输出等价（design §3.2，AC 等价性测试锚）：state 与全量 fold deep-equal；issueCount ≡ fold issues.length。
 * kindResolver 一致时与 reduceWorldSubject(patches, subjectId, at) 语义相同（后者保留：全量路径 + 测试基准）。
 */
export function reduceWorldSubjectCheckpointed(
  projectId: string,
  subjectId: string,
  at?: number,
  options?: CheckpointedReduceOptions,
): CheckpointedReduceResult {
  const ckpt = getLatestWorldCheckpoint(projectId, subjectId, at);

  if (ckpt !== undefined) {
    const window = listWorldPatchWindow(projectId, subjectId, ckpt.atStoryTime, at);
    const result = applyPatches(ckpt.state, window.patches, {
      kindResolver: options?.kindResolver,
    });
    return {
      state: result.state,
      issues: result.issues,
      issueCount: ckpt.issueCount + result.issues.length,
      patchesFolded: window.patches.length,
      checkpointHit: true,
      // CR-10：暴露命中点信息——推进侧 patchCountFolded 自命中点累计（防 latest 重查双计）。
      hitAtStoryTime: ckpt.atStoryTime,
      hitPatchCountFolded: ckpt.patchCountFolded,
    };
  }

  // miss：全 fold（窗 = story_time <= at 全集）。
  const all = listWorldPatchWindow(projectId, subjectId, undefined, at);
  const result = applyPatches({}, all.patches, { kindResolver: options?.kindResolver });

  if (options?.writeCheckpoint !== false && all.patches.length > 0) {
    // at undefined → 取 patch 最大 storyTime 作截断点（fold 覆盖的就是到该点为止的全部）。
    const ckptAt = at ?? all.maxStoryTime;
    insertWorldCheckpoints(projectId, [
      {
        subjectId,
        atStoryTime: ckptAt,
        state: result.state,
        issueCount: result.issues.length,
        patchRowidHigh: all.maxRowid,
        patchCountFolded: all.patches.length,
      },
    ]);
  }

  return {
    state: result.state,
    issues: result.issues,
    issueCount: result.issues.length,
    patchesFolded: all.patches.length,
    checkpointHit: false,
  };
}

/**
 * 构造章节级 world-state snapshot（checkpoint-backed；design §3.2）。与 shared-contracts 纯函数
 * buildWorldStateSnapshot 输出语义等价（AC deep-equal 测试锚），差异只在取数路径：
 * - subject 收集改 SQL：`first_seen_story_time <= at ORDER BY first_seen_story_time, id LIMIT subjectCap`
 *   （与纯函数 first-patch first-seen 序语义一致——subject 登记时 firstSeenStoryTime 即首个 patch 的
 *   storyTime，merge 节点赋值；design §3.2 sanctioned）。
 * - 每 subject 走 reduceWorldSubjectCheckpointed（checkpoint-seeded，fold 量有界；**read-only**——
 *   writeCheckpoint:false，读工具不写库，CR-6）。
 * - drop-empty + attrs 投影经 assembleWorldSnapshot 单源（Step 1 抽出，防两处漂移）。
 */
export function buildWorldSnapshotCheckpointed(
  projectId: string,
  at: number | undefined,
  options?: BuildWorldStateSnapshotOptions,
): WorldStateSnapshot {
  const db = getDb();
  const subjectCap = options?.subjectCap ?? 12;
  const conditions = ['project_id = ?'];
  const params: unknown[] = [projectId];
  if (at !== undefined) {
    conditions.push('first_seen_story_time <= ?');
    params.push(at);
  }
  const rows = db
    .prepare(
      `SELECT id FROM closure_world_subject
       WHERE ${conditions.join(' AND ')}
       ORDER BY first_seen_story_time ASC, id ASC
       LIMIT ?`,
    )
    .all(...params, subjectCap) as AnyRow[];

  const entries: WorldSubjectReduceEntry[] = [];
  for (const row of rows) {
    const subjectId = row.id as string;
    const reduced = reduceWorldSubjectCheckpointed(projectId, subjectId, at, {
      kindResolver: options?.kindResolver,
      // CR-6（8.1 修复批）：读工具纯读——build_world_snapshot 是 read 工具（readonly/suggest 档可用），
      // 不写库；checkpoint 只由 materialize 机会式路径建（lazy 首建 + 阈值推进，物化 interleave 覆盖）。
      writeCheckpoint: false,
    });
    entries.push({ subjectId, state: reduced.state, issueCount: reduced.issueCount });
  }
  return { at, subjects: assembleWorldSnapshot(entries, options?.attrs) };
}

// ── Story 8.1：closure_chapter_summary 读写（per-episode 六字段摘要，design §4）──

/** upsert 入参（projectId 由函数参数注入；summary 为结构化对象，落表 JSON.stringify）。 */
export interface ChapterSummaryUpsertInput {
  episodeId: string;
  /** 冗余快照（排序/下一章解析）；源 episode_outlines 缺 index 则 null（查询侧 graceful，design §4）。 */
  episodeIndex: number | null;
  /** 本章 slices storyTime 窗终点；本章无已提取 events 则 null。 */
  storyTimeEnd: number | null;
  summary: ChapterStateSummary;
  tokenEstimate: number;
  truncated: boolean;
  /** 观测（summary 覆盖的水印；**不用于有效性**——checkpoint 有效性归显式失效 + 水印，design §4）。 */
  patchRowidHigh: number;
}

/** 读出 record（upsert 入参全字段 + db updated_at）。 */
export interface ChapterSummaryRecord extends ChapterSummaryUpsertInput {
  updatedAt: string;
}

/**
 * upsert 一章的 ChapterStateSummary（composite PK (project_id, episode_id)，last-wins——同 episode 重物化
 * 覆盖不累积，幂等；7.4 redo 每轮重物化 = 终轮摘要即终态，design §2）。
 */
export function upsertChapterSummary(projectId: string, row: ChapterSummaryUpsertInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO closure_chapter_summary
       (project_id, episode_id, episode_index, story_time_end, summary, token_estimate, truncated, patch_rowid_high)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, episode_id) DO UPDATE SET
       episode_index = excluded.episode_index,
       story_time_end = excluded.story_time_end,
       summary = excluded.summary,
       token_estimate = excluded.token_estimate,
       truncated = excluded.truncated,
       patch_rowid_high = excluded.patch_rowid_high,
       updated_at = datetime('now')`,
  ).run(
    projectId,
    row.episodeId,
    row.episodeIndex,
    row.storyTimeEnd,
    JSON.stringify(row.summary),
    row.tokenEstimate,
    row.truncated ? 1 : 0,
    row.patchRowidHigh,
  );
}

/**
 * 列出章节摘要，三选一收窄（mirror slice.list 收窄哲学；单次调用 episode 数 cap 50 在 handler 层强制，
 * repository 忠实执行入参范围）。排序：episode_index 升序（NULL 行排最后）→ episode_id 升序（确定性）。
 *
 * - episodeIds：精确 id 集（IN）；range 过滤对 NULL index 行天然不命中（SQL NULL 比较语义）——episodeIds
 *   路径仍可取到（无 index 的历史章按 id 查）。
 * - fromIndex/toIndex：episode_index 闭区间范围。
 *
 * summary JSON 列容错（CR-E6 模式）：坏 JSON / 非 object 行**跳过不崩整 list**（summary 是 DERIVED 可
 * drop 重建的缓存，单行损坏只丢该行，mirror patchRowToRecord 哲学）。
 */
export function listChapterSummaries(
  projectId: string,
  filter: { episodeIds?: string[]; fromIndex?: number; toIndex?: number } = {},
): ChapterSummaryRecord[] {
  const db = getDb();
  const conditions = ['project_id = ?'];
  const params: unknown[] = [projectId];
  if (filter.episodeIds && filter.episodeIds.length > 0) {
    conditions.push(`episode_id IN (${filter.episodeIds.map(() => '?').join(',')})`);
    params.push(...filter.episodeIds);
  }
  if (filter.fromIndex !== undefined) {
    conditions.push('episode_index >= ?');
    params.push(filter.fromIndex);
  }
  if (filter.toIndex !== undefined) {
    conditions.push('episode_index <= ?');
    params.push(filter.toIndex);
  }
  const rows = db
    .prepare(
      `SELECT episode_id, episode_index, story_time_end, summary, token_estimate, truncated, patch_rowid_high, updated_at
       FROM closure_chapter_summary
       WHERE ${conditions.join(' AND ')}
       ORDER BY (episode_index IS NULL), episode_index ASC, episode_id ASC`,
    )
    .all(...params) as AnyRow[];

  const records: ChapterSummaryRecord[] = [];
  for (const row of rows) {
    let summary: unknown;
    try {
      summary = JSON.parse(row.summary as string);
    } catch {
      continue; // 坏 JSON：丢该行保其余（DERIVED 可重建）
    }
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
    records.push({
      episodeId: row.episode_id as string,
      episodeIndex: (row.episode_index as number | null) ?? null,
      storyTimeEnd: (row.story_time_end as number | null) ?? null,
      summary: summary as ChapterStateSummary,
      tokenEstimate: row.token_estimate as number,
      truncated: (row.truncated as number) === 1,
      patchRowidHigh: row.patch_rowid_high as number,
      updatedAt: row.updated_at as string,
    });
  }
  return records;
}

// ── Story 8.3 S5：gap_stats 取数下推的轻量投影查询（8.7 CR-014）──
//
// gap_stats 视图（catalogHandlers）旧取数 = listWorldPatches 全量（含 value JSON 明细）+ listChapterSummaries
// 全量（含 synopsis 等六字段 JSON 全文）→ JS 喂 buildAppearanceGapStats 纯函数。纯函数对两源的**实际消费面**：
// patches 只读 {subjectId, storyTime, sliceId} 且只取 per-subject 最大 storyTime 行（lastEpisodeId 派生）；
// 章摘要只读窗三元组 + episodeIndex。本组查询按消费面最小投影，输出同形状轻量行喂纯函数（签名不动）。
// 等价性与行数量级断言见 test/gapStatsFetchParity.test.ts（Electron 真跑对拍）。

/**
 * per-subject 最后状态变化聚合投影：每 subject 一行 = storyTime 最大的那条 patch 的
 * `{subjectId, storyTime, sliceId}`（AppearancePatchFact 形状——buildAppearanceGapStats patches 臂输入）。
 *
 * **行选取与 JS 全量分组逐位等价**（对拍锚）：纯函数按 listWorldPatches 行序（story_time ASC、derived 先
 * amendment、rowid ASC）迭代，`prev.storyTime >= p.storyTime` 跳过——即 max storyTime 并列时取**迭代序首位**
 * （source 序 + rowid 序）。SQL 侧 ROW_NUMBER 同序镜像：`story_time DESC` 取 max，并列按
 * `derived 先 amendment（CASE）、rowid ASC`——与 JS 首位胜出同解。story_time 列 NOT NULL（schema），无 NULL 歧义。
 *
 * 行数 = subject 数（vs listWorldPatches 的 patch 全量行——CR-014 的数量级下降点）。
 */
export function listLastPatchFacts(
  projectId: string,
  subjectId?: string,
): AppearancePatchFact[] {
  const db = getDb();
  const conditions = ['p.project_id = ?'];
  const params: unknown[] = [projectId];
  if (subjectId !== undefined) {
    conditions.push('p.subject_id = ?');
    params.push(subjectId);
  }
  const rows = db
    .prepare(
      `SELECT subject_id, story_time, slice_id FROM (
         SELECT p.subject_id AS subject_id,
                s.story_time AS story_time,
                p.slice_id AS slice_id,
                ROW_NUMBER() OVER (
                  PARTITION BY p.subject_id
                  ORDER BY s.story_time DESC, CASE WHEN p.source = 'derived' THEN 0 ELSE 1 END, p.rowid ASC
                ) AS rn
         FROM closure_world_patch p
         JOIN closure_world_slice s ON s.id = p.slice_id
         WHERE ${conditions.join(' AND ')}
       ) WHERE rn = 1
       ORDER BY subject_id ASC`,
    )
    .all(...params) as AnyRow[];
  return rows.map((row) => ({
    subjectId: row.subject_id as string,
    storyTime: row.story_time as number,
    sliceId: row.slice_id as string,
  }));
}

/** `listEpisodeStoryTimeWindows` 单行：EpisodeStoryTimeWindow 窗三元组 + 冗余章序（账行章序标注用）。 */
export interface EpisodeStoryTimeWindowRow extends EpisodeStoryTimeWindow {
  /** 章序快照（源 episode_outlines 缺 index → null；ledger 视图排序用，mirror ChapterSummaryRecord）。 */
  episodeIndex: number | null;
}

/**
 * 章摘要轻列窗投影：`{episodeId, storyTimeStart, storyTimeEnd, episodeIndex}`——**不物化 summary JSON 全文**
 * （synopsis 等六字段不进 JS；storyTimeStart 经 `json_type` 数值型守卫从 JSON 列单点抽取）。
 *
 * **行集与 listChapterSummaries 同门**（对拍锚）：坏 JSON / 非 object 根（手改库 / 版本 skew）的行**整体跳过**
 * （mirror listChapterSummaries 的 skip-不崩语义）——本函数产窗，跳过 = 该章无窗（下游按窗缺降级）。json 访问
 * 全部经 CASE 守卫（json_valid 先行）+ 外层 root_type 门——json_type/json_extract 永不见非法 JSON（SQL 引擎
 * 对 malformed JSON 是抛错非返 NULL）。storyTimeStart 非 numeric（手改库写入字符串/布尔）→ NULL——与旧路径
 * 「字符串 start 进窗后被 Number.isFinite 判不可解析」的消费结果一致。
 *
 * 排序 mirror listChapterSummaries（index 升序、NULL 最后、episode_id 决胜）。
 */
export function listEpisodeStoryTimeWindows(projectId: string): EpisodeStoryTimeWindowRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `WITH valid AS (
         SELECT episode_id, episode_index, story_time_end, summary,
                CASE WHEN json_valid(summary) = 1 THEN json_type(summary) ELSE 'x-invalid' END AS root_type
         FROM closure_chapter_summary
         WHERE project_id = ?
       )
       SELECT episode_id, episode_index, story_time_end,
              CASE
                WHEN json_type(summary, '$.storyTimeStart') IN ('integer', 'real')
                THEN json_extract(summary, '$.storyTimeStart')
                ELSE NULL
              END AS story_time_start
       FROM valid
       WHERE root_type = 'object'
       ORDER BY (episode_index IS NULL), episode_index ASC, episode_id ASC`,
    )
    .all(projectId) as AnyRow[];
  return rows.map((row) => ({
    episodeId: row.episode_id as string,
    episodeIndex: (row.episode_index as number | null) ?? null,
    storyTimeStart: (row.story_time_start as number | null) ?? null,
    storyTimeEnd: (row.story_time_end as number | null) ?? null,
  }));
}

/**
 * 取 patches 的最大 rowid（水印观测），可选 subject 收窄 + at 截断（story_time <= at）。无匹配 → 0。
 *
 * Story 8.1 Step 3 handler 需求：materialize 的机会式 checkpoint 推进需精确 `patch_rowid_high`（水印
 * belt 的正确性要求精确值——过低会误证伪好 checkpoint（perf 损），过高会漏判违规 patch（正确性损））；
 * summary 行的 `patch_rowid_high` 观测列同源。私有 listWorldPatchWindow 已算 maxRowid 但不外露窗参数
 * 组合，此处独立小函数（纯读，无重写既有路径）。
 */
export function getWorldPatchRowidHigh(
  projectId: string,
  subjectId?: string,
  at?: number,
): number {
  const db = getDb();
  const conditions = ['p.project_id = ?'];
  const params: unknown[] = [projectId];
  if (subjectId) {
    conditions.push('p.subject_id = ?');
    params.push(subjectId);
  }
  if (at !== undefined) {
    conditions.push('s.story_time <= ?');
    params.push(at);
  }
  const row = db
    .prepare(
      `SELECT MAX(p.rowid) AS high FROM closure_world_patch p ` +
        'JOIN closure_world_slice s ON s.id = p.slice_id ' +
        `WHERE ${conditions.join(' AND ')}`,
    )
    .get(...params) as { high: number | null } | undefined;
  return row?.high ?? 0;
}

/**
 * 单 WAL 事务：upsert 一章 summary + 写一批机会式 checkpoint（Story 8.1 Step 3 materialize handler
 * 落盘路径，design §2「单 WAL 事务」）。checkpoint 是机会式缓存（丢了可 lazy 重建），原子性与 summary
 * 同事务是 belt（crash 不留「summary 已写而 checkpoint 半写」的中间态——后者本身无害，顺手同事务零成本）。
 *
 * 内部嵌套调用 upsertChapterSummary / insertWorldCheckpoints——better-sqlite3 嵌套 transaction 自动
 * 降级 savepoint（官方语义），无重复 SQL。
 */
export function upsertChapterSummaryWithCheckpoints(
  projectId: string,
  row: ChapterSummaryUpsertInput,
  checkpoints: WorldCheckpointInsert[],
): void {
  const db = getDb();
  db.transaction(() => {
    upsertChapterSummary(projectId, row);
    insertWorldCheckpoints(projectId, checkpoints);
  })();
}

// 重新导出 parseSubjectRef 便利（shell 内 ref 解析单源；handler 可直接用）。
export { parseSubjectRef };
