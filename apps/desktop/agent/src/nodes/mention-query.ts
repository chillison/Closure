import {
  QUERY_CHAPTER_SUMMARY_EPISODE_CAP,
  buildAppearanceGapStats,
  closureMentionRowSchema,
  type AppearanceGapStat,
  type ClosureMentionRow,
  type EpisodeStoryTimeWindow,
  type MentionSignal,
} from '@orison/shared-contracts';
import { registry } from '../tool/registry';
import { logger } from '../logger';
import { fetchWorldPatchesViaTool } from './world-state-query';

// ── Story 8.7 S9（design §2.4）：mention 出场间隔的 agent 侧取数面（单源多暴露面的取数腿）──
//
// buildAppearanceGapStats（shared-contracts S3 纯函数）是间隔统计的**单源核心**；本文件是它的 agent 侧
// 取数腿——弹药面（research-verifier fetchAmmoViaTools）与编译面（completeness-verify-node L1）两消费点
// 共用同一取数路径（mirror 2.6 collectRelevantDecisions 单源多消费先例），不各写一套取数（防两处漂移）。
//
// 取数通道 = registry 内部直调 builtin 工具（mirror fetchWorldPatchesViaTool / fetchExistingArcBeats 先例
// ——agent 层无 db 访问，经 remoteToolProxy → toolExecution IPC → shell handlers）：
// - mention 行：`query_mentions` view='ledger'（全账行）；
// - episode→storyTime 窗：`query_chapter_summary`（episodeIds 收窄，**只查有 mention 行的章**——窗只为
//   mention 行换算用，无行章的窗永不消费；超 50 章 cap 分批，mirror handler 防倾倒契约）；
// - world patches：复用 fetchWorldPatchesViaTool（既有单源，patches 回退口径 + 窗缺章回退依据）。
//
// 锚点归调用方（弹药面 = 本章开场 storyTime〔resolveAnchorStoryTime〕；编译面同）——本文件不猜锚点。
//
// graceful（mirror fetchWorldPatchesViaTool 契约）：工具未注册（测试环境 registry 空 / 旧 shell）/ 调用
// 失败 / metadata 坏形态 → 对应数据源 undefined/空 + degradedReasons 注记，**不造假不崩调用方**。出场账/
// 摘要窗缺 → buildAppearanceGapStats 内建回退（mention 行退 patches 口径）——缺源是降级非错误。
//
// expected_downstream_consumers:
// - Story 8.7 S9：research-verifier fetchAmmoViaTools（弹药双源）+ completeness-verify-node L1 出场间隔
//   计数信号（纯计数不判意义，红线见各自消费点注释）。
// - Story 8.7 S9：workflow.ts loadMentionSignalsForLeader（fetchRecentMentionSignalsViaTool——leader
//   议题注入段消费落表信号）。

/** tool.execute 共用 ctx（mirror fetchWorldPatchesViaTool：sessionId 空串 placeholder，handler 只读 projectDir）。 */
function makeToolContext(projectPath: string) {
  return {
    sessionId: '',
    projectPath,
    abort: new AbortController().signal,
  };
}

/**
 * 经 query_mentions（view='ledger'）取项目全部出场账行。
 *
 * @returns 账行（空数组 = 项目尚无记账；逐条 safeParse 丢坏行留好行）；undefined = 工具未注册/调用失败/
 *          metadata 坏形态（graceful，调用方记降级注记）。
 */
export async function fetchMentionLedgerRowsViaTool(
  projectPath: string,
): Promise<ClosureMentionRow[] | undefined> {
  const tool = registry.get('query_mentions');
  if (!tool) return undefined;
  try {
    const result = await tool.execute({ view: 'ledger' }, makeToolContext(projectPath));
    const meta = (result as { metadata?: unknown } | undefined)?.metadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
    if ((meta as { ok?: unknown }).ok !== true) return undefined;
    const rows = (meta as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) return undefined;
    // 逐条 safeParse（IPC 边界防御，mirror fetchExistingArcBeats arcBeatSchema 先例）。
    return rows.flatMap((r) => {
      const parsed = closureMentionRowSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  } catch (err) {
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'fetchMentionLedgerRowsViaTool: query_mentions failed → graceful undefined',
    );
    return undefined;
  }
}

/**
 * 经 query_chapter_summary（episodeIds 收窄）取 episode→storyTime 窗。
 *
 * 只查传入的 episodeIds（调用方给「有 mention 行的章」——窗只为 mention 行换算，无行章的窗不消费）；
 * 超 `QUERY_CHAPTER_SUMMARY_EPISODE_CAP`(50) 分批（等价语义——schema 单请求超限会整批 invalid_params，
 * 非等价，故须调用侧分批）。**部分失败容忍是设计内**：某批失败该批章无窗 → buildAppearanceGapStats 对
 * 相应实体走 patches 回退口径（allResolved 逐实体判定，shared 纯函数契约），非整面弃守。
 *
 * @returns 窗列表（空数组 = 无可解析窗）；坏条目逐个跳过（storyTimeStart/End 双 null 窗保留——
 *          「该章无已提取 events」是合法窗形态，纯函数按不可用处理）。
 */
export async function fetchEpisodeStoryTimeWindowsViaTool(
  projectPath: string,
  episodeIds: readonly string[],
): Promise<EpisodeStoryTimeWindow[]> {
  if (episodeIds.length === 0) return [];
  const tool = registry.get('query_chapter_summary');
  if (!tool) return [];
  const distinct = [...new Set(episodeIds)];
  const out: EpisodeStoryTimeWindow[] = [];
  for (let i = 0; i < distinct.length; i += QUERY_CHAPTER_SUMMARY_EPISODE_CAP) {
    const chunk = distinct.slice(i, i + QUERY_CHAPTER_SUMMARY_EPISODE_CAP);
    try {
      const result = await tool.execute({ episodeIds: chunk }, makeToolContext(projectPath));
      const meta = (result as { metadata?: unknown } | undefined)?.metadata;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
      if ((meta as { ok?: unknown }).ok !== true) continue;
      const summaries = (meta as { summaries?: unknown }).summaries;
      if (!Array.isArray(summaries)) continue;
      for (const s of summaries) {
        if (!s || typeof s !== 'object') continue;
        const rec = s as {
          episodeId?: unknown;
          storyTimeEnd?: unknown;
          summary?: { storyTimeStart?: unknown } | null;
        };
        if (typeof rec.episodeId !== 'string' || rec.episodeId.length === 0) continue;
        const start = rec.summary?.storyTimeStart;
        const end = rec.storyTimeEnd;
        out.push({
          episodeId: rec.episodeId,
          storyTimeStart: typeof start === 'number' && Number.isFinite(start) ? start : null,
          storyTimeEnd: typeof end === 'number' && Number.isFinite(end) ? end : null,
        });
      }
    } catch (err) {
      // 单批失败：该批章无窗（实体级 patches 回退接住），继续后续批（设计内容忍，见函数头）。
      logger.warn(
        { projectPath, chunk: chunk.length, err: err instanceof Error ? err.message : String(err) },
        'fetchEpisodeStoryTimeWindowsViaTool: chunk failed → those episodes resolve via patches basis',
      );
    }
  }
  return out;
}

/** 组合面产物：间隔统计（单源纯函数产出）+ 数据源降级注记（弹药/编译面记进各自 degraded 标注）。 */
export interface AppearanceGapFace {
  stats: AppearanceGapStat[];
  /** 数据源不可得注记（出场账/世界状态/摘要窗；空 = 全源可得或确无数据）。 */
  degradedReasons: string[];
}

/**
 * 出场间隔统计组合面（S9 双源取数 + 单源纯函数）：mention 行 + patches + 章摘要窗 →
 * buildAppearanceGapStats（mentions 优先——提及也算露面；无 mention 行/窗缺章的 subject 退 patches 口径）。
 *
 * **锚点归调用方**（本章开场 storyTime——resolveAnchorStoryTime；本函数不猜）。弹药面与编译面共用。
 *
 * graceful：出场账不可用 → 退纯 patches 口径（等价 8.4 前行为）+ 注记；世界状态不可用但有账 → 账口径
 * 照算（缺窗无回退的实体 best-effort）+ 注记；两者全缺 → 空统计 + 注记。
 *
 * @param cap    条目上限（缺省 12 = AMMO_INTERVAL_CAP 语义——常量留 shared 纯函数缺省，此处透传）。
 * @param minGap 只报 gap ≥ 此值（缺省 1）。
 */
export async function fetchAppearanceGapStatsViaTools(
  projectPath: string,
  anchorStoryTime: number,
  opts: { cap?: number; minGap?: number } = {},
): Promise<AppearanceGapFace> {
  const degradedReasons: string[] = [];

  const mentions = await fetchMentionLedgerRowsViaTool(projectPath);
  if (mentions === undefined) {
    degradedReasons.push('出场账查询不可用（退世界状态口径）');
  }
  // 窗只查有账行的章（无行章的窗永不消费——buildAppearanceGapStats 只按行 episodeId 查窗）。
  const episodeIds = mentions ? [...new Set(mentions.map((r) => r.episodeId))] : [];
  const windows = await fetchEpisodeStoryTimeWindowsViaTool(projectPath, episodeIds);

  const patches = await fetchWorldPatchesViaTool(projectPath);
  if (patches === undefined) {
    degradedReasons.push('世界状态查询不可用');
  }

  const stats = buildAppearanceGapStats(
    mentions ?? [],
    patches ?? [],
    windows,
    anchorStoryTime,
    opts.cap,
    opts.minGap,
  );
  return { stats, degradedReasons };
}

/** 落表信号读出行（fetchRecentMentionSignalsViaTool 产物；signals 已过逐条形态守卫）。 */
export interface MentionSignalsFace {
  episodeId: string;
  signals: MentionSignal[];
}

/** MentionSignal 最小形态守卫（IPC 边界——kind/episodeId 是消费端文案路由的字段，缺则整条丢）。 */
function isMentionSignalShape(v: unknown): v is MentionSignal {
  if (!v || typeof v !== 'object') return false;
  const s = v as { kind?: unknown; episodeId?: unknown };
  return typeof s.kind === 'string' && s.kind.length > 0 && typeof s.episodeId === 'string';
}

/** fetchRecentMentionSignals 三态（BMad CR-007 细分——「没项目」常态与「查询失败」降级分离）。 */
export type RecentMentionSignalsFetch =
  | { kind: 'ok'; episodes: MentionSignalsFace[] }
  /** 项目未注册到 db（handler metadata.reason='project_not_registered'）——常态静默，非降级。 */
  | { kind: 'no_project' }
  /** 工具未注册（测试环境 registry 空）/ 调用失败 / metadata 坏形态——真降级，调用方出降级行。 */
  | { kind: 'unavailable' };

/**
 * 经 query_mentions（view='signals'）取近期章的申报对拍差异信号（leader 议题注入段数据源，S9）。
 * 信号是**落表值**（closure_mention_signals——重算输入〔申报〕不持久，读表非重算是唯一完整面）。
 *
 * **三态（BMad CR-007）**：项目未注册（无项目的会话/项目未进 db——没有 mention 账是常态非故障）返
 * `{kind:'no_project'}`，与查询失败（`{kind:'unavailable'}`）分离——旧二态把「没项目」也当降级，leader
 * 段每 turn 注入「暂不可用」噪音行且混淆两种语义。
 *
 * @returns 三态结果（见 RecentMentionSignalsFetch）；'ok' 的 episodes 已滤零信号章与坏形态条目。
 */
export async function fetchRecentMentionSignalsViaTool(
  projectPath: string,
): Promise<RecentMentionSignalsFetch> {
  const tool = registry.get('query_mentions');
  if (!tool) return { kind: 'unavailable' };
  try {
    const result = await tool.execute({ view: 'signals' }, makeToolContext(projectPath));
    const meta = (result as { metadata?: unknown } | undefined)?.metadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { kind: 'unavailable' };
    // 项目未注册：handler notRegistered 形态（ok:false + reason='project_not_registered'）——常态非降级。
    if ((meta as { reason?: unknown }).reason === 'project_not_registered') return { kind: 'no_project' };
    if ((meta as { ok?: unknown }).ok !== true) return { kind: 'unavailable' };
    const episodes = (meta as { episodes?: unknown }).episodes;
    if (!Array.isArray(episodes)) return { kind: 'unavailable' };
    const out: MentionSignalsFace[] = [];
    for (const e of episodes) {
      if (!e || typeof e !== 'object') continue;
      const rec = e as { episodeId?: unknown; signals?: unknown };
      if (typeof rec.episodeId !== 'string' || rec.episodeId.length === 0) continue;
      if (!Array.isArray(rec.signals)) continue;
      const signals = rec.signals.filter(isMentionSignalShape);
      if (signals.length === 0) continue; // 零信号章不进 leader 面（no 态静默）
      out.push({ episodeId: rec.episodeId, signals });
    }
    return { kind: 'ok', episodes: out };
  } catch (err) {
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'fetchRecentMentionSignalsViaTool: query_mentions signals view failed → graceful unavailable',
    );
    return { kind: 'unavailable' };
  }
}
