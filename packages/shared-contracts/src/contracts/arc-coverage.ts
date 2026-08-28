// ── Story 8.5 R4: arc coverage gap detection（弧数据状态如实，design §5.1，mirror setting-coverage.ts）──
//
// Structural cross-check between growth_curve (which characters have a designed
// arc) and episode_outlines (which characters the episode plans say change).
// Mechanical facts only:
// - totalCurves + characterIds[]：现状清单（哪些角色已有弧）。
// - progressionsWithoutCurve[]：episode.character_progressions 引用了无 curve 的 characterId（dangling
//   同构真缺口——集纲设计了走向但弧没建）。
// - 零曲线信号：totalCurves === 0（引导段「主动提议建弧」时机判断用；derived 比较，非独立字段）。
//
// 范式红线（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：本模块只报结构事实（id 存在性比对），
// **永不**判「该不该有弧 / 弧好不好」——那是语义，归 leader LLM 引导对话（mirror setting-coverage
// findSettingCoverageGaps 判据 + 4.4 L1 候选汇编红线）。无词库匹配、无评分、无假信心门。
//
// readGrowthCurves 单源（design §5.1）：growth_curve raw 三形态归一逻辑从 completeness-candidates.ts
// readGrowthCurve **上提**为导出单源（逻辑等价搬家）——4.4 collectArcCandidates 与本处 findArcCoverageGaps
// / Step 7 leader 三态注入段共用同一归一，防两处归一漂移。区别于 growthCurveFieldSchema
// （creative-fields.ts，存储契约层：条目严格校验）；本函数是防御性宽容读（坏条目跳过不抛，4.4 哲学）。
//
// expected_downstream_consumers:
// - Story 8.5 R4：loadArcCoverageForLeader（workflow.ts，Step 7）→ buildInteractionModeSegment 弧覆盖
//   三态段（有缺口 / 无缺口 / 不可用，mirror 2.2 WP-C）。
// - Story 8.6 预留：「有曲线」阶段判定 = totalCurves > 0（epics 8.6 规划注记已标单源复用本函数）。

import { z } from 'zod';
import { growthCurveSchema, type EpisodeOutline, type GrowthCurve } from './creative-fields';

// ── 三形态归一（单源导出）──

/** readGrowthCurves 详细结果（CR-002：坏形态计数透出，「空」与「坏」两态可区分）。 */
export interface ReadGrowthCurvesDetail {
  /** 可读出的有效曲线（归一 array）。 */
  curves: GrowthCurve[];
  /** 被忽略的坏形态条目数（array 坏条目 / Record 坏值 / 整体非对象形态算 1 条坏数据）。 */
  skippedCount: number;
}

/**
 * growth_curve raw shape 宽容归一（含坏形态计数，CR-002 单源内核）。readGrowthCurves /
 * readGrowthCurveSkipCount 的共用实现：
 *
 * - null / undefined → 0 curves + 0 skipped（source-missing，消费端降级语义——缺字段不是坏数据）。
 * - 单条 GrowthCurve（含 character_id）→ 包成数组；Record<id, curve> → values（**值缺 character_id 时
 *   key 补缺，值内自带优先**——CR-Blind-F2：对齐 storage 侧 growthCurveFieldSchema Record 分支同语义，
 *   消两套真相）；array 直通。
 * - 宽容解析（mirror extractCharacterCards 哲学：坏条目跳过不抛）：每条只做结构判定
 *   （object + character_id[或 key 兜底] + start_state），不强制完整 schema parse——优先 safeParse 应用
 *   defaults，失败时结构直传（消费端 Array.isArray 守卫兜底，mirror collectArcCandidates CR-001）。
 *   坏条目计入 skippedCount（CR-002：读侧透出「N 条坏形态被忽略」，引导段如实显示数据坏而非零曲线）。
 * - 整体非对象非数组（string/number 等）→ 0 curves + skippedCount 1（字段存在但整体形态坏）。
 */
function readGrowthCurvesDetailed(raw: unknown): ReadGrowthCurvesDetail {
  if (raw === null || raw === undefined) return { curves: [], skippedCount: 0 };
  const result: GrowthCurve[] = [];
  let skipped = 0;
  if (Array.isArray(raw)) {
    // array 形态：project.yaml growth_curve: [...]（多角色，8.5 canonical）。
    for (const item of raw) {
      const curved = asGrowthCurve(item);
      if (curved) result.push(curved);
      else skipped++;
    }
  } else if (typeof raw === 'object') {
    // 单条 growthCurveSchema（含 character_id）→ 包成数组；Record<id, curve> → values（key 补缺 character_id，
    // 值内自带优先——与 readGrowthCurves 既有语义逐字一致，仅增坏值计数）。
    const single = asGrowthCurve(raw);
    if (single) {
      result.push(single);
    } else {
      for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
        const curved = asGrowthCurve(v, key);
        if (curved) result.push(curved);
        else skipped++;
      }
    }
  } else {
    skipped = 1;
  }
  return { curves: result, skippedCount: skipped };
}

/**
 * growth_curve raw 宽容归一（接口不变，CR-002 内核拆分后 wrapper）：返回有效曲线（0 条 → undefined，
 * 同 source-missing 语义）。坏形态计数走 {@link readGrowthCurveSkipCount}。
 */
export function readGrowthCurves(raw: unknown): GrowthCurve[] | undefined {
  const { curves } = readGrowthCurvesDetailed(raw);
  return curves.length > 0 ? curves : undefined;
}

/**
 * growth_curve raw 坏形态计数（CR-002 新导出，接口最小化：全消费者（4.4 completeness / 引导段 /
 * remove 引用扫描）继续用 readGrowthCurves 零改动；需区分「空 vs 坏」的消费者（loadArcCoverageForLeader）
 * 单独调本函数）。null/undefined → 0（缺字段 ≠ 坏数据）。
 */
export function readGrowthCurveSkipCount(raw: unknown): number {
  return readGrowthCurvesDetailed(raw).skippedCount;
}

/**
 * 结构判定 object 是否为 GrowthCurve（有 character_id[或 key 兜底] + start_state 字符串）；缺省字段由
 * caller ?? 兜底。keyFallback：Record 键补缺（值内 character_id 优先；key 兜底时注入 candidate 再 parse，
 * mirror growthCurveFieldSchema Record 分支 `{ ...value, character_id: value.character_id ?? key }`）。
 */
function asGrowthCurve(v: unknown, keyFallback?: string): GrowthCurve | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as { character_id?: unknown; start_state?: unknown };
  const inValueId = typeof c.character_id === 'string' && c.character_id.length > 0 ? c.character_id : undefined;
  const characterId = inValueId ?? (keyFallback !== undefined && keyFallback.length > 0 ? keyFallback : undefined);
  if (characterId === undefined) return null;
  if (typeof c.start_state !== 'string') return null;
  // key 兜底时注入 character_id 再 parse（值内自带则原样）；优先 schema safeParse（应用 defaults + 校验
  // 完整），失败时结构直传（注入后的 candidate，保 character_id 在场）。CR-001：collectArcCandidates 内
  // Array.isArray 守卫兜住 safeParse 失败的结构直传场景（turning_points 等数组字段非数组时降级 []）。
  const candidate = inValueId !== undefined ? v : { ...v, character_id: characterId };
  const parsed = growthCurveSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as GrowthCurve);
}

// ── coverage report schema ──

/**
 * 悬空 progression 缺口：一角色一条（aggregate per characterId），episodeIds 收全部引用集（去重保序，
 * mirror setting-coverage dangling_ref 按卡聚合的 report shape 理由——消费者 top-N 列表不被同 fix 的
 * per-episode 条目淹没，修法是角色中心「建一条弧」）。
 */
export const arcProgressionGapSchema = z.object({
  /** 引用了无 curve 角色的 characterId（episode.character_progressions[].characterId）。 */
  characterId: z.string().min(1),
  /** 引用该角色的 episode ids（episode_outlines 原序，场内去重）。 */
  episodeIds: z.array(z.string().min(1)).min(1),
  /** 叙事语言 message（mirror setting-coverage gap message 风格）；embeds characterId + episode ids。 */
  message: z.string().min(1),
});
export type ArcProgressionGap = z.infer<typeof arcProgressionGapSchema>;

export const arcCoverageReportSchema = z.object({
  /**
   * 有弧的角色数（= characterIds.length，CR-007 去重计数——与写侧 add_curve partial-merge 的
   * by-character_id 语义一致：同角色双条目归并为一角色一弧，非原始条目数；=== 0 即零曲线信号）。
   */
  totalCurves: z.number().int().nonnegative(),
  /** 有弧的角色 id 清单（去重保首现序——Record 归一后 key 与值内 character_id 可能重复指向同角色）。 */
  characterIds: z.array(z.string().min(1)),
  /** 悬空 progression 缺口（episode 引用了无 curve 的角色），按首现 characterId 序。 */
  progressionsWithoutCurve: z.array(arcProgressionGapSchema),
});
export type ArcCoverageReport = z.infer<typeof arcCoverageReportSchema>;

// ── pure function ──

/**
 * Detect structural arc-coverage gaps between growth_curve and episode_outlines.
 * Pure function — id set-existence checks only, zero semantic judgement.
 *
 * Graceful（mirror setting-coverage / collectArcCandidates 防御哲学）：growthCurveRaw null/undefined/坏
 * 形态 → 归一 [] （零曲线信号如实，非崩）；episodeOutlines undefined → 无 progression 可查（空缺口）；
 * 元素/字段坏形态跳过不抛（caller 可能传 raw 未 parse 数据）。真正「不可用」（project.yaml 读不了）由
 * 上游 caller 三态防御处理（mirror loadSettingCoverageForLeader）。
 *
 * @param growthCurveRaw  project.yaml growth_curve 原始值（三形态宽容归一，readGrowthCurves 单源）。
 * @param episodeOutlines parsed episode_outlines（character_progressions 引用源；undefined → 无可查）。
 */
export function findArcCoverageGaps(
  growthCurveRaw: unknown,
  episodeOutlines: readonly EpisodeOutline[] | undefined,
): ArcCoverageReport {
  const curves = readGrowthCurves(growthCurveRaw) ?? [];
  const characterIds = Array.from(new Set(curves.map((c) => c.character_id)));
  const withCurve = new Set(characterIds);

  // Pass：walk episodes in order；aggregate dangling progressions per characterId（Map insertion order =
  // 首现 characterId 序，消费端 top-N 截断结果稳定）。episodeIds 场内去重（同 episode 多次引用同角色 = 一条）。
  // CR-Edge-F6：非数组组稳值守卫（caller 可能传 raw 未 parse 数据；for-of 非数组会 throw，归一空数组）。
  const gapEpisodes = new Map<string, string[]>();
  for (const episode of Array.isArray(episodeOutlines) ? episodeOutlines : []) {
    // 防御（mirror collectArcCandidates CR-001）：元素/字段形态守卫，坏数据跳过不抛。
    if (!episode || typeof episode !== 'object') continue;
    const episodeId = (episode as { id?: unknown }).id;
    if (typeof episodeId !== 'string' || episodeId.length === 0) continue;
    const progressions = (episode as { character_progressions?: unknown }).character_progressions;
    if (!Array.isArray(progressions)) continue;
    for (const progression of progressions) {
      if (!progression || typeof progression !== 'object') continue;
      const characterId = (progression as { characterId?: unknown }).characterId;
      if (typeof characterId !== 'string' || characterId.length === 0) continue;
      if (withCurve.has(characterId)) continue;
      const ids = gapEpisodes.get(characterId);
      if (ids) {
        if (!ids.includes(episodeId)) ids.push(episodeId);
      } else {
        gapEpisodes.set(characterId, [episodeId]);
      }
    }
  }

  const progressionsWithoutCurve: ArcProgressionGap[] = Array.from(gapEpisodes.entries()).map(
    ([characterId, episodeIds]) => ({
      characterId,
      episodeIds,
      message: `集纲「${formatEpisodeIds(episodeIds)}」为角色「${characterId}」设计了成长走向（character_progressions），但该角色还没有成长曲线（growth_curve）。`,
    }),
  );

  return {
    // CR-007：totalCurves = 去重角色数（characterIds.length）——同角色双条目（手编 yaml / Record 归一
    // 残留）按「一角色一弧」计，与 add_curve partial-merge 写语义一致，防 leader 读「共 2 条成长弧
    // （角色：A）」误判结构异常。
    totalCurves: characterIds.length,
    characterIds,
    progressionsWithoutCurve,
  };
}

/** Max episode ids embedded in a gap message before folding to "等 N 集" (display only; episodeIds keeps all). */
const MESSAGE_EPISODE_CAP = 5;

/** Join episode ids for a message, folding beyond MESSAGE_EPISODE_CAP（mirror setting-coverage formatSceneIds）. */
function formatEpisodeIds(episodeIds: readonly string[]): string {
  if (episodeIds.length <= MESSAGE_EPISODE_CAP) return episodeIds.join('、');
  return `${episodeIds.slice(0, MESSAGE_EPISODE_CAP).join('、')} 等 ${episodeIds.length} 集`;
}
