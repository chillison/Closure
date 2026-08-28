import type {
  ClosureMentionRow,
  MentionPresence,
  MentionSignal,
  MentionSource,
} from '@orison/shared-contracts';
import { getLogger } from '../logger';
import { getDb } from './index';

// ── Story 8.7 S3：closure_mention repository（design §1.1/§2.2-§2.3，db-repository.md 惯例）──
//
// 纯函数 repository（mirror worldStateRepository 模式）：每函数内 `const db = getDb()` → prepare →
// run/get/all → 返类型化 record。同步保持同步（better-sqlite3 同步事务安全，db-repository.md 反模式）。
// snake_case 列 ↔ camelCase Record 映射靠集中的 mentionRowToRecord + 列名常量。
//
// 全 DERIVED（可 drop 重建，prose 是唯一文件真相源 ADR-1/14）。行粒度 PK (project_id, episode_id,
// entry_id)：章→实体走 PK 前缀、实体→章走 idx_mention_entry（双向查询同表两条索引路径）。幂等 =
// per-episode 全量替换（redo/重申报重收，mirror 章摘要 upsert 哲学）。
//
// project_id = registry `getProject(path).projectId` 5 位 id（mirror closure_entry / closure_world_*，
// 非 meta.id UUID）——handler 层解析后传入；repository 信任类型化输入（Zod 校验在 IPC 层一次）。
//
// 汇账纯函数（合并/信号/间隔统计）住 shared-contracts closure-mention.ts——本 repository 只做 db 读写，
// 不重写合并逻辑（ADR-3 DRY 跨包）。接线已随 S8 落地：写路径 = mention-ledger-node →
// record_episode_mentions handler → db/mentionLedgerMaterialize 组装核心；修订降档 =
// degrade_episode_mentions handler → degradeEpisodeMentions（本文件复合）；resetWorldState 级联 =
// worldStateRepository.resetWorldState 事务内全清（mirror 8.1 summary / 8.2 弧摘要点位）。

// ── 列名常量（SELECT 用，避免 SELECT * 漂移）──
const MENTION_COLS =
  'project_id, episode_id, entry_id, presence, declared, presence_shot, coarse_hit, ' +
  'plan_linked, coarse_count, state_changed, source, updated_at';

type AnyRow = Record<string, unknown>;

function mentionRowToRecord(row: AnyRow): ClosureMentionRow {
  return {
    projectId: row.project_id as string,
    episodeId: row.episode_id as string,
    entryId: row.entry_id as string,
    presence: row.presence as MentionPresence,
    declared: row.declared as number,
    presenceShot: row.presence_shot as number,
    coarseHit: row.coarse_hit as number,
    planLinked: row.plan_linked as number,
    coarseCount: row.coarse_count as number,
    stateChanged: row.state_changed as number,
    source: row.source as MentionSource,
    updatedAt: row.updated_at as string,
  };
}

/**
 * upsert 入参（行核心；projectId/episodeId 由函数参数注入、updatedAt 由 db 侧 datetime('now') 盖章
 * ——写入时刻即账目时刻，mirror 既有 repo infra 字段注入惯例）。`mergeMentionChannels` 输出结构满足。
 */
export interface MentionRowInsert {
  entryId: string;
  presence: MentionPresence;
  declared: number;
  presenceShot: number;
  coarseHit: number;
  planLinked: number;
  coarseCount: number;
  stateChanged: number;
  source: MentionSource;
}

/**
 * 写入一章的 mention 账（单 WAL 事务，**per-episode 全量替换**：先 DELETE 该 episode 全行再 INSERT
 * 新行——redo/重申报重收不累积，mirror insertWorldSlice per-slice idempotency 哲学）。替换范围 = 该
 * episode 的全部行（他章不动）。`rows` 空数组合法（重扫产出零行 = 清空该章账，诚实缺位）。
 *
 * Story 8.7 S9：可选 `signals`（computeMentionSignals 五类差异信号）在**同一事务**写
 * closure_mention_signals（episode 级一行，同替换语义——重收覆盖旧信号，空数组也写 = 清信号）。
 * `undefined` = 调用方不管理信号（旧调用面零改动）。信号持久化动机：五类信号是纯函数产物但重算输入
 * （写手申报 cast_declaration）只存链内 artifact 不持久——leader 注入段/查询面消费须读落表值非重算。
 */
export function upsertEpisodeMentions(
  projectId: string,
  episodeId: string,
  rows: readonly MentionRowInsert[],
  signals?: readonly MentionSignal[],
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO closure_mention
       (project_id, episode_id, entry_id, presence, declared, presence_shot, coarse_hit,
        plan_linked, coarse_count, state_changed, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  db.transaction(() => {
    db.prepare('DELETE FROM closure_mention WHERE project_id = ? AND episode_id = ?').run(
      projectId,
      episodeId,
    );
    for (const row of rows) {
      insert.run(
        projectId,
        episodeId,
        row.entryId,
        row.presence,
        row.declared,
        row.presenceShot,
        row.coarseHit,
        row.planLinked,
        row.coarseCount,
        row.stateChanged,
        row.source,
      );
    }
    if (signals !== undefined) {
      db.prepare(
        `INSERT INTO closure_mention_signals (project_id, episode_id, signals, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(project_id, episode_id) DO UPDATE SET
           signals = excluded.signals,
           updated_at = datetime('now')`,
      ).run(projectId, episodeId, JSON.stringify(signals));
    }
  })();
}

/**
 * 双向查询 mention 账（design §1.1 两条索引路径）：
 * - `entryId` → 该实体出场史（idx_mention_entry）；
 * - `episodeId` → 该章名册（PK 前缀）；
 * - 同传 = 交集（该实体在该章的行）；`presence` 可叠加过滤（present/mentioned 档）。
 *
 * 排序：本表无章序数列——按 episode_id 升序 + entry_id 升序（确定性）；**章序视图**（按卷内顺序排
 * 出场史）归调用方 JOIN closure_chapter_summary.episode_index（S6 评估），本函数忠实返回账行。
 */
export function queryMentionLedger(
  projectId: string,
  filter: { entryId?: string; episodeId?: string; presence?: MentionPresence } = {},
): ClosureMentionRow[] {
  const db = getDb();
  const conditions = ['project_id = ?'];
  const params: unknown[] = [projectId];
  if (filter.entryId !== undefined) {
    conditions.push('entry_id = ?');
    params.push(filter.entryId);
  }
  if (filter.episodeId !== undefined) {
    conditions.push('episode_id = ?');
    params.push(filter.episodeId);
  }
  if (filter.presence !== undefined) {
    conditions.push('presence = ?');
    params.push(filter.presence);
  }
  const rows = db
    .prepare(
      `SELECT ${MENTION_COLS} FROM closure_mention
       WHERE ${conditions.join(' AND ')}
       ORDER BY episode_id ASC, entry_id ASC`,
    )
    .all(...params) as AnyRow[];
  return rows.map(mentionRowToRecord);
}

/**
 * 修订/重写降档（design §2.3 保守策略）：该章全部行 declared 清位 + source 置 'conservative' +
 * updated_at 刷新。**降档不删行**——mention 纯代码通道可随时重扫（保守信息好过没有）；重提取
 * （world redo）后重跑汇账自然重建 full 账。申报不自动重收（创作决定归人，下次写手触达该章时重收）。
 *
 * @returns 受影响行数（该章无账行 = 0，no-op——降档幂等）。
 */
export function degradeEpisodeToConservative(projectId: string, episodeId: string): number {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE closure_mention
       SET declared = 0, source = 'conservative', updated_at = datetime('now')
       WHERE project_id = ? AND episode_id = ?`,
    )
    .run(projectId, episodeId);
  return result.changes;
}

/** getMentionAggregates 单实体聚合行。 */
export interface MentionAggregate {
  entryId: string;
  /** 出场+提及总章数（PK (章, 实体) 一行，COUNT(*) 即章数；提及也算——gap 统计同哲学）。 */
  chapterCount: number;
  /** 最后出场/被提及的章 id。 */
  lastEpisodeId: string;
}

/**
 * per-entry 出场聚合（目录行「记忆召回」用，design §4.1 catalogRow.mentionChapterCount/lastMentionEpisode）。
 * 单条窗口函数查询（COUNT OVER + ROW_NUMBER）。
 *
 * **last 的章序依据**：LEFT JOIN closure_chapter_summary 取 episode_index——已知 index 的章按 index
 * 降序取最新；**无 summary 行 / index NULL 的章排全部已知 index 章之后**（episode_index 缺失多见于
 * 8.1 之前的旧章，按旧章处理；同层内 episode_id 降序决胜）。窗口不完整时 last 是 best-effort 展示
 * 信号（DERIVED 非权威）——精确章序消费走 queryMentionLedger + summary JOIN。
 *
 * @returns 按 entryId 升序（确定性）；无账行项目返空数组。
 */
export function getMentionAggregates(projectId: string): MentionAggregate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT entry_id, chapter_count, episode_id AS last_episode_id FROM (
         SELECT m.entry_id AS entry_id,
                COUNT(*) OVER (PARTITION BY m.entry_id) AS chapter_count,
                m.episode_id AS episode_id,
                ROW_NUMBER() OVER (
                  PARTITION BY m.entry_id
                  ORDER BY (cs.episode_index IS NULL) ASC, cs.episode_index DESC, m.episode_id DESC
                ) AS rn
         FROM closure_mention m
         LEFT JOIN closure_chapter_summary cs
           ON cs.project_id = m.project_id AND cs.episode_id = m.episode_id
         WHERE m.project_id = ?
       ) WHERE rn = 1
       ORDER BY entry_id`,
    )
    .all(projectId) as AnyRow[];
  return rows.map((row) => ({
    entryId: row.entry_id as string,
    chapterCount: row.chapter_count as number,
    lastEpisodeId: row.last_episode_id as string,
  }));
}

// ── Story 8.3 S5：gap_stats mention 臂 per-entry 聚合投影（8.7 CR-014）──

/** `aggregateMentionAppearance` 单 entry 聚合行。 */
export interface MentionAppearanceAggregate {
  entryId: string;
  /**
   * 最后露面所在章 id（= 该实体全部账行中**窗 storyTime 最大**的行；窗 storyTime = 章摘要 storyTimeEnd 优先、
   * 缺 end 用 start）。并列取 episode_id 升序首位——与 queryMentionLedger 行序（episode_id ASC）下
   * buildAppearanceGapStats「首个更大者胜出」的分组同解。全部行窗不可解析 → null。
   */
  bestEpisodeId: string | null;
  /** best 行的窗 storyTime（bestEpisodeId 非空时必有）。 */
  bestStoryTime: number | null;
  /** 该实体是否存在**窗不可解析**的账行（episode 无摘要行 / 摘要 JSON 坏 / start+end 全缺）——对应纯函数
   *  mention 分组的 allResolved=false 降档语义（退 patches 口径）。 */
  hasUnresolvedWindow: boolean;
}

/**
 * per-entry 出场聚合投影（gap_stats 视图未收窄路径的取数下推）：每 entry 一行 {best, unresolved}，替代
 * queryMentionLedger 全行取回 + JS 分组。消费面核对结论：buildAppearanceGapStats 对 mention 行只读
 * `entryId/episodeId` 两字段，聚合语义 = per-entry {best storyTime + 是否有不可解析行}——本查询逐位镜像
 * （对拍锚：test/gapStatsFetchParity.test.ts）。
 *
 * 窗 storyTime 的 SQL 换算 mirror 纯函数 windowStoryTime：storyTimeEnd（列）优先，缺 end 用 summary JSON 内
 * storyTimeStart（json_type 数值型守卫——非数值 start 视同缺失，与 JS Number.isFinite 消费结果一致）。
 * 摘要行门 mirror listChapterSummaries / listEpisodeStoryTimeWindows：坏 JSON / 非 object 根的章**无窗**
 * （LEFT JOIN NULL → 该行计入 unresolved）。
 *
 * 行数 = entry 数（vs 全账行数——CR-014 的数量级下降点）。
 */
export function aggregateMentionAppearance(projectId: string): MentionAppearanceAggregate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `WITH valid AS (
         SELECT episode_id, story_time_end, summary,
                CASE WHEN json_valid(summary) = 1 THEN json_type(summary) ELSE 'x-invalid' END AS root_type
         FROM closure_chapter_summary
         WHERE project_id = ?
       ),
       window_st AS (
         SELECT episode_id,
                CASE
                  WHEN story_time_end IS NOT NULL THEN story_time_end
                  WHEN json_type(summary, '$.storyTimeStart') IN ('integer', 'real')
                  THEN json_extract(summary, '$.storyTimeStart')
                  ELSE NULL
                END AS st
         FROM valid
         WHERE root_type = 'object'
       )
       SELECT entry_id, st, episode_id, row_count, resolved_count FROM (
         SELECT m.entry_id AS entry_id,
                w.st AS st,
                m.episode_id AS episode_id,
                COUNT(*) OVER (PARTITION BY m.entry_id) AS row_count,
                COUNT(w.st) OVER (PARTITION BY m.entry_id) AS resolved_count,
                ROW_NUMBER() OVER (
                  PARTITION BY m.entry_id
                  ORDER BY w.st DESC, m.episode_id ASC
                ) AS rn
         FROM closure_mention m
         LEFT JOIN window_st w ON w.episode_id = m.episode_id
         WHERE m.project_id = ?
       ) WHERE rn = 1
       ORDER BY entry_id ASC`,
    )
    .all(projectId, projectId) as AnyRow[];
  return rows.map((row) => ({
    entryId: row.entry_id as string,
    bestStoryTime: (row.st as number | null) ?? null,
    bestEpisodeId: row.st === null ? null : (row.episode_id as string),
    hasUnresolvedWindow: (row.row_count as number) > (row.resolved_count as number),
  }));
}

/**
 * 删一章的 mention 账行（事务删除，scoped 到 project+episode）。resetWorldState 级联走的是同事务内
 * project 级直删（worldStateRepository.resetWorldState，S8 接线）；本函数供单章 scoped 清理场景。
 *
 * @returns 删除行数。
 */
export function deleteEpisodeMentions(projectId: string, episodeId: string): number {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM closure_mention WHERE project_id = ? AND episode_id = ?')
    .run(projectId, episodeId);
  return result.changes;
}

// ── Story 8.7 S8（design §2.3）：修订/重写失效复合降档（mention 行 + synopsis stale 标注）──

/** synopsis stale 标注文案（degradedNote 追记；重复降档幂等判据 = includes 此串）。 */
export const MENTION_SYNOPSIS_STALE_NOTE = '正文已修订：梗概与出场申报基于修订前版本';

/** degradeEpisodeMentions 结果。 */
export interface DegradeEpisodeMentionsResult {
  /** mention 行降档受影响行数（0 = 该章无账行，no-op 幂等）。 */
  changedRows: number;
  /** synopsis stale 标注是否落地（true = 本章 summary 有申报梗概且已带/已追记 stale 注）。 */
  synopsisMarked: boolean;
}

/**
 * 修订/重写失效（design §2.3 保守策略，链内 targeted-revision 落盘后经 degrade_episode_mentions 触发；
 * Story 8.7 BMad CR-001 起对话侧章落盘点〔chapter_write / write_file / 编辑器写盘〕同样 best-effort 触发）：
 * ①degradeEpisodeToConservative（mention 行 declared 清位 + source 翻 conservative）；②章摘要 synopsis
 * 标 stale——summary JSON 有申报梗概时 degradedNote 追记 `MENTION_SYNOPSIS_STALE_NOTE`（已有该注不重复
 * 追记，幂等；已有其他 degradedNote 以 '；' 连接保留）；③删该章 closure_mention_signals 行（S9）——
 * 信号对照系是「申报 × 修订前正文」，修订后两者皆失效（hard/soft 基于旧正文粗筛、new_face/alias 基于已
 * 作废申报、plan 对拍基于旧 draft），留着是主动误导；账行降档保留（保守信息好过没有）而信号删除（错误
 * 信息不如没有）——两生命周期不同故分表（db/index.ts 注释）。
 *
 * **BMad CR-006：三条写语句单 WAL 事务包裹**（mirror upsertEpisodeMentions 事务惯例）——复合降档是
 * 一个失效语义单元，崩溃窗口内「mention 行已降档但 signals 未删/synopsis 未标」是半降档状态（读侧
 * 看到自相矛盾的账）。坏 summary JSON → 跳过 stale 标注（mention 降档照常，事务正常提交）+ warn 不抛。
 *
 * **降档不删行**——mention 纯代码通道可随时重扫；重提取（world redo）后重跑汇账自然重建 full 账。
 */
export function degradeEpisodeMentions(projectId: string, episodeId: string): DegradeEpisodeMentionsResult {
  const db = getDb();
  let changedRows = 0;
  let synopsisMarked = false;
  db.transaction(() => {
    changedRows = degradeEpisodeToConservative(projectId, episodeId);
    deleteEpisodeMentionSignals(projectId, episodeId);

    const row = db
      .prepare('SELECT summary FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?')
      .get(projectId, episodeId) as { summary?: string | null } | undefined;
    if (row === undefined || row.summary == null) return; // 无行/NULL → 无梗概可标（幂等 no-op）

    let summary: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.summary);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('summary JSON is not an object');
      }
      summary = parsed as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        { projectId, episodeId, err: msg },
        'degradeEpisodeMentions: chapter summary JSON unreadable → skip synopsis stale note (mention degrade stands)',
      );
      return; // 坏 JSON：跳过标注，前两条写语句随事务正常提交（当前行为保持）
    }

    // 只对「有申报梗概」的章标 stale——无梗概章（降级直写/未回填）本就没有可失效的梗概。
    if (typeof summary.synopsis !== 'string' || summary.synopsis.length === 0) return;
    const existingNote = typeof summary.degradedNote === 'string' ? summary.degradedNote : '';
    if (existingNote.includes(MENTION_SYNOPSIS_STALE_NOTE)) {
      synopsisMarked = true; // 已标注（重复降档）——幂等 no-op
      return;
    }
    summary.degradedNote =
      existingNote.length > 0 ? `${existingNote}；${MENTION_SYNOPSIS_STALE_NOTE}` : MENTION_SYNOPSIS_STALE_NOTE;
    db.prepare('UPDATE closure_chapter_summary SET summary = ? WHERE project_id = ? AND episode_id = ?').run(
      JSON.stringify(summary),
      projectId,
      episodeId,
    );
    synopsisMarked = true;
  })();
  return { changedRows, synopsisMarked };
}

// ── Story 8.7 S9：closure_mention_signals 读写（leader 注入段 / query_mentions signals 视图消费）──

/** listRecentEpisodeMentionSignals 单章读出行。 */
export interface EpisodeMentionSignals {
  episodeId: string;
  signals: MentionSignal[];
}

/**
 * 读近期章的申报对拍差异信号（leader 议题注入段数据源，S9）。「近期」排序 mirror getMentionAggregates
 * 的章序依据：LEFT JOIN closure_chapter_summary 取 episode_index——已知 index 的章按 index 降序（最新章
 * 先）；无 summary 行 / index NULL 的章（8.1 前旧章等）排全部已知 index 章之后（同层内 updated_at 降序
 * + episode_id 降序决胜）。signal-consumer 只关心最近几章（写手自查失误/新面孔是近期写作事件），非全史。
 *
 * signals JSON 列容错（mirror patchRowToRecord CR-E6）：坏 JSON / 非数组行**跳过不崩整 list**。
 * **取数缓冲补位（BMad CR-008）**：SQL LIMIT `limit + MENTION_LIST_BUFFER`——坏 JSON 行在 SQL LIMIT
 * 之后才被 JS 丢弃，无缓冲时「limit 内含坏行 → 返回偏少而窗外有效行不可见」；缓冲多取几行，丢弃坏行后
 * 仍截满 `limit`。缓冲量 3 = 「近几章内最多坏几行仍可补满」的工程估值（坏行本身是手改库/版本 skew 的
 * 罕见态，不值得全量取回再排）。
 *
 * @returns 至多 `limit` 章（调用方定，catalogHandlers 缺省 3）；空数组 = 近期章全无信号或信号表空。
 */
/** 坏 JSON 行丢弃后的取数缓冲行数（BMad CR-008——见上注释）。 */
const MENTION_LIST_BUFFER = 3;

export function listRecentEpisodeMentionSignals(
  projectId: string,
  limit: number,
): EpisodeMentionSignals[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.episode_id AS episode_id, s.signals AS signals
       FROM closure_mention_signals s
       LEFT JOIN closure_chapter_summary cs
         ON cs.project_id = s.project_id AND cs.episode_id = s.episode_id
       WHERE s.project_id = ?
       ORDER BY (cs.episode_index IS NULL) ASC, cs.episode_index DESC, s.updated_at DESC, s.episode_id DESC
       LIMIT ?`,
    )
    .all(projectId, limit + MENTION_LIST_BUFFER) as AnyRow[];
  const out: EpisodeMentionSignals[] = [];
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.signals as string);
      if (!Array.isArray(parsed)) continue; // 坏形态行跳过（DERIVED 可重收重建）
      out.push({ episodeId: row.episode_id as string, signals: parsed as MentionSignal[] });
      if (out.length >= limit) break; // 补满 limit 即止（缓冲行不超发）
    } catch {
      getLogger().warn(
        { projectId, episodeId: row.episode_id as string },
        'listRecentEpisodeMentionSignals: signals JSON unreadable → skip row',
      );
    }
  }
  return out;
}

/**
 * 删一章的信号行（修订降档 cascade / 单章 scoped 清理）。幂等（该章无行 = no-op）。
 *
 * @returns 删除行数（0/1）。
 */
export function deleteEpisodeMentionSignals(projectId: string, episodeId: string): number {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM closure_mention_signals WHERE project_id = ? AND episode_id = ?')
    .run(projectId, episodeId);
  return result.changes;
}
