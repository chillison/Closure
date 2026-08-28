/**
 * Story 8.7 S6 catalog + mention tool handlers（ADR-3 / design §4.1）。
 *
 * 3 read-only handlers mirroring `worldStateHandlers.ts` / `closureHandlers.ts`:
 * - `catalog_entries`：实体目录薄行分页（先过滤后翻页 + 显式 total 绝不静默截断 + mention 聚合拼行）。
 * - `get_entry`：单条目下钻全文（三级变焦的全文级）。
 * - `query_mentions`：出场账双向查询（ledger 逐行 / gap_stats 间隔统计视图——buildAppearanceGapStats
 *   单源纯函数，handler 只做取数组装：mention 行 + world patches + 章摘要 storyTime 窗 + 锚点）。
 *
 * Each agent tool (agent/src/tool/builtin.ts) crosses processes via the UNIFIED
 * `toolExecution` channel (remoteToolProxy -> handleToolExecute -> these
 * handlers). NO dedicated IPC channel / preload method / OrisonDesktopApi entry
 * — same unified-channel pattern as `query_story` / `query_world_state`.
 *
 * projectId is derived from projectDir via `getProject(path.resolve(projectDir))`
 * (5-digit registry id，mirror closureHandlers). Handlers NEVER throw on bad
 * input（mirror queryStoryHandler「never throws」契约——malformed param / missing
 * project / repo failure 降级为友好 miss，agent runLoop turn 永不见 rejection）。
 *
 * 🔴 读路径零持久化副作用（agent-tools.md Convention，Story 8.1）：三 handler 纯读，
 * 不写任何缓存/表（mention 聚合是即席查询非物化）。
 *
 * 范式判据（ADR-3）：目录/翻页/计数/账行汇编/间隔统计 = 纯代码查询汇编；条目该不该用、
 * 角色是否该出场归消费端 LLM（output 文字只报机械事实）。
 */
import path from 'node:path';
import {
  buildAppearanceGapStats,
  catalogEntriesRequestSchema,
  describeMentionSignal,
  getEntryRequestSchema,
  queryMentionsRequestSchema,
  type AppearanceGapStat,
  type AppearancePatchFact,
  type CatalogEntriesRequest,
  type CatalogEntriesResult,
  type CatalogRow,
  type ClosureMentionRow,
  type EpisodeStoryTimeWindow,
  type GetEntryRequest,
  type GetEntryResult,
  type MentionPresence,
  type QueryMentionsRequest,
} from '@orison/shared-contracts';
import { getProject } from '../../db/projectRepository';
import { getCatalogEntry, listCatalogEntries } from '../../db/catalogRepository';
import {
  aggregateMentionAppearance,
  getMentionAggregates,
  listRecentEpisodeMentionSignals,
  queryMentionLedger,
  type MentionAppearanceAggregate,
} from '../../db/mentionLedgerRepository';
import {
  listEpisodeStoryTimeWindows,
  listLastPatchFacts,
} from '../../db/worldStateRepository';
import { getLogger } from '../../logger';
import type { ToolHandler } from './types';

// ── projectId 解析（mirror queryStoryHandler / worldStateHandlers）──
function resolveProjectId(projectDir: string): string | null {
  // local_fingerprint == path.resolve(projectDir)（ensureProject 约定，closureHandlers 注释）。
  return getProject(path.resolve(projectDir))?.projectId ?? null;
}

function notRegistered(toolId: string) {
  return {
    title: toolId,
    output: '当前项目未注册到数据库，无法查询。',
    metadata: { ok: false, reason: 'project_not_registered' },
  };
}

function invalidParams(toolId: string, message: string) {
  getLogger().warn({ err: message }, `${toolId}: invalid params`);
  return {
    title: toolId,
    output: `参数无效: ${message}`,
    metadata: { ok: false, reason: 'invalid_params' },
  };
}

// ── catalog_entries：薄行拼装（summaryLine 截断 + mention 聚合）──

/** 简述单行截断上限（catalog.ts catalogRowSchema.summaryLine JSDoc 契约：≤60 字）。 */
const SUMMARY_LINE_CAP = 60;

function truncateLine(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** mention 聚合 map（单查询 → per-entry 查找；无账条目自然缺席）。 */
function buildAggregateMap(projectId: string): Map<string, { chapterCount: number; lastEpisodeId: string }> {
  const map = new Map<string, { chapterCount: number; lastEpisodeId: string }>();
  for (const agg of getMentionAggregates(projectId)) {
    map.set(agg.entryId, { chapterCount: agg.chapterCount, lastEpisodeId: agg.lastEpisodeId });
  }
  return map;
}

/** 目录行渲染（一行一实体；出场统计缺省 = 暂无出场账，省略字段）。 */
function renderCatalogRow(row: CatalogRow): string {
  const mention =
    row.mentionChapterCount !== undefined
      ? ` · 出场 ${row.mentionChapterCount} 章${row.lastMentionEpisode ? `，最后 ${row.lastMentionEpisode}` : ''}`
      : '';
  const summary = row.summaryLine ? ` —— ${row.summaryLine}` : '';
  return `- ${row.entryId} · ${row.name}（${row.entryType}）${mention}${summary}`;
}

/** 组装 schema-conform result（二态字段纪律：无值不出现字段，非空数组占位）。 */
function composeCatalogResult(
  rows: Array<{ entryId: string; entryType: string; name: string; summaryText: string | null }>,
  aggregates: Map<string, { chapterCount: number; lastEpisodeId: string }>,
): CatalogRow[] {
  return rows.map((row) => {
    const agg = aggregates.get(row.entryId);
    const summaryLine = row.summaryText ? truncateLine(row.summaryText, SUMMARY_LINE_CAP) : undefined;
    return {
      entryId: row.entryId,
      entryType: row.entryType,
      name: row.name,
      ...(summaryLine !== undefined ? { summaryLine } : {}),
      ...(agg ? { mentionChapterCount: agg.chapterCount, lastMentionEpisode: agg.lastEpisodeId } : {}),
    };
  });
}

/**
 * catalog_entries：实体目录薄行分页。显式 total（独立 COUNT）+ 翻页指引——绝不静默截断
 * （catalog.ts 红线：本页短绝不意味「只有这些」）。
 */
export const catalogEntriesHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: CatalogEntriesRequest;
  try {
    parsed = catalogEntriesRequestSchema.parse(params ?? {});
  } catch (err) {
    return invalidParams('catalog_entries', err instanceof Error ? err.message : String(err));
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('catalog_entries');

  try {
    const { total, rows } = listCatalogEntries(projectId, {
      entryType: parsed.entry_type,
      status: parsed.status,
      visibility: parsed.visibility,
      offset: parsed.offset ?? 0,
      limit: parsed.limit,
    });
    const offset = parsed.offset ?? 0;
    if (total === 0) {
      return {
        title: `catalog_entries (${total})`,
        output: '没有匹配的条目。可放宽过滤条件（entry_type/status），或先确认项目已建立设定卡/设定文档。',
        metadata: { ok: true, total, count: 0, offset, limit: parsed.limit, rows: [] },
      };
    }

    const aggregates = buildAggregateMap(projectId);
    const result: CatalogEntriesResult = {
      total,
      rows: composeCatalogResult(rows, aggregates),
    };
    const hasMore = total > offset + result.rows.length;
    const nextOffset = offset + parsed.limit;
    if (result.rows.length === 0 && offset > 0) {
      // offset 越界（LLM 翻过头）：total 仍然显式——指引回退而非空页假象。
      return {
        title: `catalog_entries (${total})`,
        output: `offset=${offset} 已超出范围——过滤后共 ${total} 条（末条在第 ${total} 页位）。请回退 offset（≤ ${Math.max(0, total - 1)}）重查。`,
        metadata: { ok: true, total, count: 0, offset, limit: parsed.limit, rows: [] },
      };
    }
    const footer = hasMore
      ? `_共 ${total} 条，本页第 ${offset + 1}-${offset + result.rows.length} 条——还有更多，翻下一页传 offset=${nextOffset}。_`
      : `_共 ${total} 条，本页第 ${offset + 1}-${offset + result.rows.length} 条（已到末页）。_`;
    const filterLabel = [
      parsed.entry_type,
      parsed.status,
      parsed.visibility,
    ]
      .filter((v): v is string => v !== undefined)
      .join(' / ');
    const header = `## 实体目录${filterLabel ? `（${filterLabel}）` : ''}`;
    return {
      title: `catalog_entries (${total})`,
      output: `${header}\n${result.rows.map(renderCatalogRow).join('\n')}\n${footer}\n_看某条的完整内容用 get_entry（传 entry_id）。_`,
      metadata: { ok: true, total, count: result.rows.length, offset, limit: parsed.limit, rows: result.rows },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId }, 'catalog_entries failed');
    return {
      title: 'catalog_entries',
      output: `目录查询失败: ${msg}`,
      metadata: { ok: false, reason: 'query_failed', error: msg },
    };
  }
};

// ── get_entry：单条目下钻全文 ──

/** get_entry 详情渲染（name/type/status/visibility + 出场统计 + 简述 + 全文）。 */
export function formatEntryDetail(detail: {
  entryId: string;
  entryType: string;
  name: string;
  summaryText: string | null;
  bodyText: string;
  status: string | null;
  visibility: string;
}, mentionStats: { mentionChapterCount?: number; lastMentionEpisode?: string }): string {
  const lines: string[] = [`## ${detail.name}（${detail.entryType}）`];
  lines.push(`状态: ${detail.status ?? '（无状态概念——设定散文/参考文档）'} · 可见性: ${detail.visibility}`);
  lines.push(
    mentionStats.mentionChapterCount !== undefined
      ? `出场: ${mentionStats.mentionChapterCount} 章${
          mentionStats.lastMentionEpisode ? `，最后 ${mentionStats.lastMentionEpisode}` : ''
        }`
      : '出场: 出场账未建立（该实体暂无登场/提及记录，或账目未随写作建立）',
  );
  lines.push(`简述: ${detail.summaryText ?? '（未生成）'}`);
  lines.push('');
  lines.push(detail.bodyText);
  return lines.join('\n');
}

/**
 * get_entry：目录行下钻——简述 + 全文 + 状态 + 出场统计。不存在的条目友好 miss（never-throw）。
 */
export const getEntryHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: GetEntryRequest;
  try {
    parsed = getEntryRequestSchema.parse(params ?? {});
  } catch (err) {
    return invalidParams('get_entry', err instanceof Error ? err.message : String(err));
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('get_entry');

  try {
    const detail = getCatalogEntry(projectId, parsed.entry_id);
    if (detail === undefined) {
      return {
        title: `get_entry: ${parsed.entry_id}`,
        output: `条目 ${parsed.entry_id} 不存在（或不在本项目知识库中）。可先用 catalog_entries 翻目录确认 id。`,
        metadata: { ok: false, reason: 'entry_not_found', entryId: parsed.entry_id },
      };
    }
    const agg = buildAggregateMap(projectId).get(parsed.entry_id);
    const mentionStats: GetEntryResult['mentionStats'] = agg
      ? { mentionChapterCount: agg.chapterCount, lastMentionEpisode: agg.lastEpisodeId }
      : {};
    return {
      title: `get_entry: ${detail.entryId}`,
      output: formatEntryDetail(detail, mentionStats),
      metadata: { ok: true, entryId: detail.entryId, detail, mentionStats },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId, entryId: parsed.entry_id }, 'get_entry failed');
    return {
      title: 'get_entry',
      output: `条目查询失败: ${msg}`,
      metadata: { ok: false, reason: 'query_failed', error: msg },
    };
  }
};

// ── query_mentions：出场账双向查询 + gap_stats 间隔统计视图 + signals 对拍信号视图 ──

/** signals 视图读章数（近期写作事件——写手自查失误/新面孔是近期章的产物，非全史）。 */
const MENTION_SIGNALS_RECENT_EPISODES = 3;

/** presence 档位人话（closure-mention.ts mentionPresenceSchema JSDoc 单源措辞）。 */
function presenceLabel(presence: 'present' | 'mentioned'): string {
  return presence === 'present' ? '登场' : '被提及';
}

/** 账目来源档位人话（full=含写手申报 / conservative=仅机械通道）。 */
function sourceLabel(source: 'full' | 'conservative'): string {
  return source === 'full' ? '含写手申报' : '保守账（无申报）';
}

/** 命中通道紧凑列表（申报/在场记录/计划登场/状态变化 + 明写名次数）。 */
function channelSummary(row: ClosureMentionRow): string {
  const parts: string[] = [];
  if (row.declared > 0) parts.push('申报');
  if (row.presenceShot > 0) parts.push('在场记录');
  if (row.planLinked > 0) parts.push('计划登场');
  if (row.stateChanged > 0) parts.push('状态变化');
  if (row.coarseCount > 0) parts.push(`明写名 ${row.coarseCount} 次`);
  return parts.length > 0 ? `（${parts.join('、')}）` : '';
}

/** 章序排序（repository 注释「章序视图归调用方」落点）：episode_index 升序，无 index 行排后。 */
function sortRowsByEpisodeIndex(
  rows: ClosureMentionRow[],
  indexByEpisode: Map<string, number>,
): ClosureMentionRow[] {
  return rows.slice().sort((a, b) => {
    const ia = indexByEpisode.get(a.episodeId);
    const ib = indexByEpisode.get(b.episodeId);
    if (ia === undefined && ib === undefined) return a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0;
    if (ia === undefined) return 1;
    if (ib === undefined) return -1;
    return ia - ib || (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0);
  });
}

/** gap_stats 锚点：故事当前进度 storyTime = 全数据源最大值（章摘要窗 + world patches）。 */
export function resolveAnchorStoryTime(
  windows: readonly EpisodeStoryTimeWindow[],
  patchStoryTimes: readonly number[],
): number | undefined {
  let anchor: number | undefined;
  const consider = (v: number | null | undefined): void => {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    if (anchor === undefined || v > anchor) anchor = v;
  };
  for (const w of windows) {
    consider(w.storyTimeStart);
    consider(w.storyTimeEnd);
  }
  for (const t of patchStoryTimes) consider(t);
  return anchor;
}

// ── Story 8.3 S5：gap_stats 取数组装（8.7 CR-014 下推后；export 供对拍测试单源复用）──
//
// 旧取数 = queryMentionLedger 全行 + listWorldPatches 全量（含 value JSON）+ listChapterSummaries 全量
// （含 synopsis 六字段 JSON）。下推后（纯函数签名不动，喂同形状轻量行）：
// - patches → listLastPatchFacts（per-subject argmax 聚合，1 行/subject，entry 收窄推入 SQL WHERE）；
// - 章摘要窗 → listEpisodeStoryTimeWindows（轻列，不物化 summary JSON）；
// - mention 臂：**已收窄**（entry/episode/presence 任一过滤）→ 原全行路径（收窄后行集小）；**未收窄**
//   （全实体统计，leader 常态）→ aggregateMentionAppearance per-entry 聚合 + 合成最小账行。
// 等价性对拍锚：test/gapStatsFetchParity.test.ts（Electron 真跑，旧路径全量取数 vs 本组装 deep-equal）。

/** 合成账行里「窗不可解析」哨兵的 episodeId（空串非合法 episode id——schema min(1)，窗表永无 '' 键）。 */
const GAP_STATS_UNRESOLVED_EPISODE_MARKER = '';

/**
 * mention 臂未收窄路径：per-entry 聚合 → 合成最小 `ClosureMentionRow[]` 喂纯函数。
 *
 * 纯函数对 mention 行只消费 `entryId/episodeId` 两字段（分组键 + 窗查找），其余字段对它 inert——合成行
 * 携带最小合法占位即可。两个语义编码点：
 * - `best`：bestEpisodeId 行一条（该实体窗 storyTime 最大的章——聚合已按 queryMentionLedger 行序
 *   （episode_id ASC）首胜同解选取）；
 * - `allResolved=false`：聚合发现该实体有窗不可解析账行时**追加一条 marker 行**（episodeId='' 永不命中
 *   任何窗 → 纯函数置 allResolved=false → 退 patches 口径）——与全行路径「任一行窗缺即降档」逐位等价。
 *   best 行与 marker 行对分组各自独立（best 只被可解析行推进 / allResolved 只被不可解析行清除），组内
 *   先后无关。
 */
function buildGapStatsMentionRows(
  projectId: string,
  aggregates: readonly MentionAppearanceAggregate[],
): ClosureMentionRow[] {
  const rows: ClosureMentionRow[] = [];
  for (const agg of aggregates) {
    if (agg.bestEpisodeId !== null && agg.bestStoryTime !== null) {
      rows.push(minimalMentionRow(projectId, agg.entryId, agg.bestEpisodeId));
    }
    if (agg.hasUnresolvedWindow) {
      rows.push(minimalMentionRow(projectId, agg.entryId, GAP_STATS_UNRESOLVED_EPISODE_MARKER));
    }
  }
  return rows;
}

function minimalMentionRow(projectId: string, entryId: string, episodeId: string): ClosureMentionRow {
  // 占位字段（presence/declared/…）纯函数不读；source/updatedAt 取最保守值（合成行不冒充申报账）。
  return {
    projectId,
    episodeId,
    entryId,
    presence: 'present',
    declared: 0,
    presenceShot: 0,
    coarseHit: 0,
    planLinked: 0,
    coarseCount: 0,
    stateChanged: 0,
    source: 'conservative',
    updatedAt: '',
  };
}

/**
 * gap_stats 视图取数组装（S5 下推后）。**输出语义与旧全量组装逐位等价**（对拍测试锚）——差异只在取数：
 * SQL 聚合投影 + 轻列窗替代全行/全 JSON 拉取，行数从 patch/mention 全账量级降为 subject/entry 数量级。
 *
 * @param filter 与 query_mentions 请求同形（entry_id/episode_id/presence 收窄；presence/episode 收窄时
 *               mention 臂走原全行路径——收窄面是账行的真子集，聚合无数量级收益）。
 */
export function assembleGapStatsInput(
  projectId: string,
  filter: { entryId?: string; episodeId?: string; presence?: MentionPresence } = {},
): {
  mentions: ClosureMentionRow[];
  patches: AppearancePatchFact[];
  windows: EpisodeStoryTimeWindow[];
  anchorStoryTime: number | undefined;
} {
  const windowRows = listEpisodeStoryTimeWindows(projectId);
  const windows: EpisodeStoryTimeWindow[] = windowRows.map((s) => ({
    episodeId: s.episodeId,
    storyTimeStart: s.storyTimeStart,
    storyTimeEnd: s.storyTimeEnd,
  }));
  // patches 臂：per-subject 聚合 + entry 收窄下推 SQL（锚点只需各源最大 storyTime——聚合行已含，无需全量）。
  const patches = listLastPatchFacts(projectId, filter.entryId);
  const anchorStoryTime = resolveAnchorStoryTime(windows, patches.map((p) => p.storyTime));
  const mentions =
    filter.entryId !== undefined || filter.episodeId !== undefined || filter.presence !== undefined
      ? queryMentionLedger(projectId, filter)
      : buildGapStatsMentionRows(projectId, aggregateMentionAppearance(projectId));
  return { mentions, patches, windows, anchorStoryTime };
}

/** gap_stats 条目渲染（机械事实：最后露面 + 间隔 + 口径；「是否遗忘」判断归 LLM）。 */
function renderGapStat(stat: AppearanceGapStat): string {
  const last = stat.lastEpisodeId ? `最后露面 ${stat.lastEpisodeId}` : '最后露面章不详';
  const basis =
    stat.basis === 'mention' ? '出场账口径（登场与被提及都算）' : '世界状态口径（最后状态变化）';
  return `- ${stat.entryId} · ${last}（storyTime ${stat.lastStoryTime}），距今 ${stat.storyTimeGap} —— ${basis}`;
}

/**
 * query_mentions：出场账双向查询。ledger（默认）= 逐条账本行（给实体返出场史 / 给章返名册）；
 * gap_stats = buildAppearanceGapStats 单源纯函数的取数组装（mention 行 + patches + 章摘要窗 + 锚点）；
 * signals = 近期章申报对拍差异信号（closure_mention_signals 落表值——五类纯函数产物随汇账持久化，
 * S9；entry_id/episode_id/presence 过滤不适用于本视图——信号是近期章整体视图非逐行过滤面）。
 */
export const queryMentionsHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: QueryMentionsRequest;
  try {
    parsed = queryMentionsRequestSchema.parse(params ?? {});
  } catch (err) {
    return invalidParams('query_mentions', err instanceof Error ? err.message : String(err));
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('query_mentions');

  try {
    // signals 视图：近期章信号落表值直读（无逐行过滤面，见函数头注释）。
    if (parsed.view === 'signals') {
      const episodes = listRecentEpisodeMentionSignals(projectId, MENTION_SIGNALS_RECENT_EPISODES);
      const withSignals = episodes.filter((e) => e.signals.length > 0);
      const lines = withSignals.flatMap((e) => e.signals.map(describeMentionSignal));
      if (lines.length === 0) {
        return {
          title: 'query_mentions: signals (0)',
          output:
            '最近几章的写手人物表申报与实际落笔全部对得上（或近期章尚未记账——出场账随写作逐章建立）。',
          metadata: { ok: true, view: 'signals', episodes },
        };
      }
      return {
        title: `query_mentions: signals (${lines.length})`,
        output:
          `## 申报对拍信号（最近 ${withSignals.length} 章内有记录的章）\n${lines.join('\n')}\n` +
          '_以上为机械对拍事实；要不要处理（补报/补卡/补别名/修计划）由你结合剧情与作者意图判断。_',
        metadata: { ok: true, view: 'signals', episodes },
      };
    }

    // gap_stats 视图：S5 下推组装（per-subject patches 聚合 + 轻列窗 + 未收窄 per-entry mention 聚合）
    // → buildAppearanceGapStats 单源纯函数（签名不动）。
    if (parsed.view === 'gap_stats') {
      const { mentions, patches, windows, anchorStoryTime: anchor } = assembleGapStatsInput(projectId, {
        entryId: parsed.entry_id,
        episodeId: parsed.episode_id,
        presence: parsed.presence,
      });
      if (anchor === undefined) {
        return {
          title: 'query_mentions: gap_stats',
          output:
            '无法确定故事当前时间锚点（项目尚无已提取的世界状态/章摘要）。先写几章并跑完提取链，间隔统计才有参照系。',
          metadata: { ok: false, reason: 'no_anchor', view: 'gap_stats' },
        };
      }
      const stats = buildAppearanceGapStats(mentions, patches, windows, anchor);
      if (stats.length === 0) {
        return {
          title: 'query_mentions: gap_stats (0)',
          output: parsed.entry_id
            ? `实体 ${parsed.entry_id} 没有可统计的出场记录（出场账未建立或近期一直露面）。`
            : '没有可统计的出场记录（出场账未建立，或全部实体近期都有露面）。',
          metadata: { ok: true, view: 'gap_stats', anchorStoryTime: anchor, stats },
        };
      }
      const scopeLabel = parsed.entry_id ? `：${parsed.entry_id}` : '（全部实体）';
      return {
        title: `query_mentions: gap_stats (${stats.length})`,
        output:
          `## 出场间隔统计${scopeLabel}\n（锚点 = 故事当前进度 storyTime ${anchor}）\n` +
          `${stats.map(renderGapStat).join('\n')}\n` +
          `_以上为机械统计——提及也算露面；角色是否该出场、是否被读者遗忘，由你结合剧情判断。_`,
        metadata: { ok: true, view: 'gap_stats', anchorStoryTime: anchor, stats },
      };
    }

    // ledger 视图（默认）：全行账本（本视图就要逐行）+ 章序排序（episode_index 落点，repository JSDoc
    // 指归调用方）。章序取数走轻列窗查询（S5：ledger 只消费 episodeId/episodeIndex，不拉 summary JSON）。
    const rows = queryMentionLedger(projectId, {
      entryId: parsed.entry_id,
      episodeId: parsed.episode_id,
      presence: parsed.presence,
    });
    const indexByEpisode = new Map<string, number>();
    for (const s of listEpisodeStoryTimeWindows(projectId)) {
      if (s.episodeIndex !== null) indexByEpisode.set(s.episodeId, s.episodeIndex);
    }
    const ordered = sortRowsByEpisodeIndex(rows, indexByEpisode);
    if (ordered.length === 0) {
      const scope = [parsed.entry_id, parsed.episode_id].filter((v) => v !== undefined).join(' @ ');
      return {
        title: `query_mentions (${0})`,
        output: `出场账中没有匹配的记录${scope ? `（${scope}）` : ''}。账目随写作逐章建立——历史章节需补建，近期章节写作后自动入账。`,
        metadata: { ok: true, view: 'ledger', count: 0, rows: [] },
      };
    }
    const lines = ordered.map((row) => {
      const idx = indexByEpisode.get(row.episodeId);
      const chapterLabel = idx !== undefined ? `（第 ${idx + 1} 章）` : '';
      return `- ${row.episodeId}${idx !== undefined ? chapterLabel : ''} · ${row.entryId} · ${presenceLabel(
        row.presence,
      )}${channelSummary(row)} · ${sourceLabel(row.source)}`;
    });
    const scopeHeader =
      parsed.entry_id !== undefined && parsed.episode_id !== undefined
        ? `${parsed.entry_id} @ ${parsed.episode_id}`
        : parsed.entry_id !== undefined
          ? `${parsed.entry_id} 的出场史`
          : parsed.episode_id !== undefined
            ? `${parsed.episode_id} 的名册`
            : '全部账行';
    return {
      title: `query_mentions (${ordered.length})`,
      output: `## 出场账：${scopeHeader}（${ordered.length} 条）\n${lines.join('\n')}`,
      metadata: {
        ok: true,
        view: 'ledger',
        count: ordered.length,
        rows: ordered,
        ...(parsed.entry_id !== undefined ? { entryId: parsed.entry_id } : {}),
        ...(parsed.episode_id !== undefined ? { episodeId: parsed.episode_id } : {}),
        ...(parsed.presence !== undefined ? { presence: parsed.presence } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId }, 'query_mentions failed');
    return {
      title: 'query_mentions',
      output: `出场账查询失败: ${msg}`,
      metadata: { ok: false, reason: 'query_failed', error: msg },
    };
  }
};
