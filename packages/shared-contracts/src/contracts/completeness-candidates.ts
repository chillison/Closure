import { z } from 'zod';
import {
  resolvePromiseFulfillment,
  type EmotionCurve,
  type GrowthCurve,
  type PromiseBeat,
  type PromiseEntry,
  type PromiseRegistry,
  type PromiseStatus,
  type SceneGraph,
  type SceneLine,
} from './creative-fields';
import { readGrowthCurves } from './arc-coverage';
import type { ReusableAgentNodeContract } from './agent-contract';
import type { EmotionVerifyResult } from './emotion-verify';

// ── Story 4.4：创作完整性候选汇编（L1 纯代码，design §1-§5 / ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）──
//
// cross-arc 完整性维的 L1 纯代码层（completeness-verify-node 的 L1）。从累积 creative field / scene-graph
// 汇编 5 类「该有的东西」候选 + 机械事实（枚举 / resolvePromiseFulfillment 派生 / 覆盖率统计 / flag 透传），
// 喂 L2 LLM 做语义挣得裁判。
//
// 🔑 范式判据（ADR-3 / creative-vs-mechanical.md §4.4 段）：本模块全是「不理解意义」的查询/汇编/计数/派生：
// - 枚举有 growth_curve 的角色 / 枚举所有 line / 枚举 Promise
// - resolvePromiseFulfillment 派生 Promise 兑现态（纯函数，5.3 已用）
// - linked_episode_ids 覆盖率统计（已写章节涉及该角色弧/Promise 的场数）
// - 5.3 emotion-verify flag 透传（数学指纹直传，不裁判）
//
// 假信心门红线（feedback-l1-entity-extraction-false-confidence-gate / AGENT-001）：纯代码**永不**做：
// - 角色弧「进度评分」/ 主题「挣得度」伪量化（词库命中→极性加权→pass/fail 是假信心）
// - 「该挣得的有没有挣得」语义判断（归 L2 LLM）
// - 「线是否真推进 / 暗藏线该不该浮出」语义判断（归 L2 LLM）
//
// L1 只产「候选清单 + 机械事实」，L2（completeness-verify-node 的 LLM）做语义挣得裁判。
//
// 与 5.x / 6.5 正交（design §11）：
// - 5.3 emotion-verify 数学指纹 + 5.4 场级落地 = 机械化层；4.4 = cross-arc 语义挣得层。
// - 6.5 per-chapter 节拍落地；4.4 cross-arc 兑现。
// - 4.2 Reader-Audit 5 维全 per-chapter scope；4.4 只 cross-arc。
//
// expected_downstream_consumers:
// - Story 4.4 R2：completeness-verify-node L1 step（compute → JSON.stringify → L2 prompt {{candidates}} var）。
// - 8.2 百万字增强：替换 fetch 实现为分弧/折叠快照 reader（design §9，L1 入参稳定，L2 prompt + artifact shape 不变）。

// ════════════════════════════════════════════════════════════════════════════
// 5 类候选 type（L1 候选形态，机械事实载体）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 角色弧候选（design §4 角色弧 under-developed 数据源）。
 *
 * L1 机械事实（非语义裁判）：character_id + 设计意图字段（wound_or_lack/desire/need）+ turning_points 进度
 * （设计数 + 已发生数 + linked_episode_ids 覆盖已写章节）+ regressions + end_state。L2 据此判「设计意图是否
 * 正文真体现 / turning_points 是否真转折 / end_state 是否挣得非跳跃 / 按设计节奏判（转折点设计在 N 章后的
 * 角色，单章不推进不报 under-developed）」。
 */
export interface ArcCandidate {
  character_id: string;
  start_state: string;
  wound_or_lack?: string;
  desire?: string;
  need?: string;
  /** 设计的转折点数（turning_points.length）。 */
  turningPointCount: number;
  /** 转折点 linked_episode_ids ∩ writtenEpisodeIds 的并集大小（已涉及已写章节的转折点数）。 */
  turningPointsTouchedWritten: number;
  /** 转折点 linked_episode_ids flat 后并集（供 L2 知道哪些 episode 已触及）。 */
  turningPointEpisodeIds: string[];
  /** 回归次数（regressions.length，角色弧倒退节点）。 */
  regressionCount: number;
  end_state?: string;
  /** 整条弧 linked_episode_ids ∩ writtenEpisodeIds（弧整体已涉及的已写章节）。 */
  linkedEpisodeIds: string[];
}

/**
 * 线候选（design §4 线推进 missing 数据源）。
 *
 * L1 机械事实：id + name + topology_role + outcomeType 标注状态 + themeRef/worldEventRef 锚定状态 + 已写章节
 * 涉及该线的场数。L2 据此判「线是否真推进（非原地踏步）/ 暗藏线该浮出未浮出 / 平行线该交汇未交汇 / 弃线」。
 */
export interface LineCandidate {
  id: string;
  name: string;
  topology_role: string;
  /** mice_type（线叙事单元，design §4，optional）。 */
  mice_type?: string;
  /** outcomeType 标注状态：'none' = 未设 / 其他 = 已设具体值（scene-graph-analytics 无此字段时 undefined）。 */
  outcomeTypeAnnotated: boolean;
  /** 已锚定主题（themeRef 非空）。 */
  hasThemeRef: boolean;
  /** 已锚定世界事件（worldEventRef 非空）。 */
  hasWorldEventRef: boolean;
  /** 已写章节涉及该线的场数（lineTags 含此 line.id 的场 ∩ 本章 episode 数；全项目范围按 writtenEpisodeIds 过滤）。 */
  sceneCountInWrittenEpisodes: number;
  /** 收束锚点（convergence_target，optional）。 */
  convergence_target?: string;
  /** visibility 状态（CR-003：L2 据「暗藏线该浮出未浮出」判线推进 missing）。line.visibility.status 缺/异形默认 'open'。 */
  visibilityStatus: 'open' | 'hidden-until';
  /** visibility target（仅 hidden-until 时有值，揭示锚点 ref；line.visibility.target 缺省时 undefined）。 */
  visibilityTarget?: string;
}

/**
 * 情绪弧候选（design §4 情绪弧挣得 missing 数据源，与 5.3 正交）。
 *
 * L1 机械事实：透传 5.3 emotion-verify flag（数学指纹已算，非语义）+ 跨弧 emotion_curve 目标 payoff 点。
 * L2 据此判「payoff 是否真释放（非廉价）/ 角色情绪转变是否铺垫到位 / 整条弧顶点是否挣来」。
 *
 * 与 5.4 Emotion.unlanded 正交：5.4 per-scene 场级落地；4.4 cross-arc 弧挣得。
 */
export interface EmotionArcCandidate {
  /** 5.3 emotion-verify 产的三类 flag（透传，非语义裁判）。 */
  emotionVerifyFlags: string[];
  /** 目标情绪弧 point 数（emotion_curve.points.length）。 */
  targetPointCount: number;
  /** 目标弧 payoff 点（sceneMood 含「释放/爆发/高潮/达成」类语义词或末点；纯代码扫语义词汇是软提示非裁判）。 */
  targetPayoffPointCount: number;
  /** 5.3 verify degraded 标记（透传，L2 知道目标弧偏离指纹是否可信）。 */
  emotionVerifyDegraded: boolean;
}

/**
 * Promise 兑现候选（design §4 Promise 兑现 missing-payoff 数据源）。
 *
 * L1 机械事实：id + title + summary + resolvePromiseFulfillment 派生兑现态 + deadline + plant 了 N 章后仍
 * missing-payoff / 兑现 deadline（linked_episode_ids）已过未兑现。L2 据此判「该 Promise 是否该兑现未兑现
 * （vs 故意留长线）/ 兑现是否真挣得非廉价」。
 */
export interface PromiseCandidate {
  id: string;
  title: string;
  summary?: string;
  /** resolvePromiseFulfillment 派生态（'open' | 'fulfilled' | 'abandoned'，纯代码派生）。 */
  derivedStatus: PromiseStatus;
  /** autoFulfill 标志。 */
  autoFulfill: boolean;
  /** deadlineEpisodeId（optional，过期判定用）。 */
  deadlineEpisodeId?: string;
  /** plant 的 episode ids（beats.kind='plant' 的 episodeId 集合，供 L2 知道埋了多久）。 */
  plantEpisodeIds: string[];
  /** payoff beat 数（beats.kind='payoff' count）。 */
  payoffBeatCount: number;
  /** advance/setback beat 数。 */
  echoedBeatCount: number;
  /** deadline 已过仍未兑现（纯代码 index 比对，mirror 5.3 isDeadlinePassed 哲学，非语义）。 */
  deadlinePassed: boolean;
}

/**
 * 主题候选（design §4 主题挣得 missing 数据源）。
 *
 * L1 机械事实：声明主题（meta.theme / creative_brief.theme）+ visual_motif themeMapping（表/中/深）
 * + themeRef 锚定的线 + 主题对应角色弧。L2 据此判「主题是否正文被挣得（通过事件/角色弧/情绪体现）非口号重复；
 * 深层主题是否触及」。
 */
export interface ThemeCandidate {
  /** 项目级声明主题（meta.theme / creative_brief.theme 合并去重）。 */
  declaredThemes: string[];
  /** visual_motif themeMapping（表/中/深，asset_cards type='visual_motif' 收集）。 */
  themeMappings: Array<{
    cardId: string;
    cardName: string;
    surface?: string;
    middle?: string;
    deep?: string;
  }>;
  /** themeRef 锚定的线（line.themeRef 非空 + 对应 line id/name）。 */
  linesAnchoringTheme: Array<{
    lineId: string;
    lineName: string;
    themeRef: string;
  }>;
}

/**
 * L1 候选汇编报告（completeness-verify-node 的 L1 产出，喂 L2 prompt {{candidates}} var）。
 *
 * 5 类候选 + degraded 标注（任一源缺失 → 该类空候选 + degradationNote 说明）。mirror emotion-verify
 * degraded 哲学（design §10 graceful，R6① 永不崩链）。L2 见 degradationNote → 该类跳过不报。
 */
export interface CompletenessCandidateReport {
  arc: ArcCandidate[];
  line: LineCandidate[];
  emotionArc: EmotionArcCandidate | null;
  promise: PromiseCandidate[];
  theme: ThemeCandidate | null;
  /** 当前章 episodeId（候选派生用；undefined = 无法按章过滤）。 */
  currentEpisodeId?: string;
  /** 已写章节 id 集合（候选覆盖率统计用）。 */
  writtenEpisodeIds: readonly string[];
  /** 降级标注（任一类缺源降级说明，L2 据此跳过该类不报）。 */
  degraded: boolean;
  /** 降级原因说明（逐类列出缺失源）。 */
  degradationNote: string;
}

// ════════════════════════════════════════════════════════════════════════════
// L1 候选汇编纯函数（5 类 + 聚合）
// ════════════════════════════════════════════════════════════════════════════

/**
 * growth_curve raw 三形态归一（单条 / array / Record）→ GrowthCurve[]。
 *
 * **已上提为导出单源**（Story 8.5 design §5.1 防两处归一漂移）：`readGrowthCurves`（arc-coverage.ts），
 * 本文件 import 消费，逻辑等价（宽容解析坏条目跳过不抛 + 优先 safeParse 应用 defaults + 0 有效条目 →
 * undefined source-missing 语义）。4.4 arc 候选 / 8.5 findArcCoverageGaps / leader 注入段共用同一归一。
 */

/**
 * 角色弧候选汇编（design §4 角色弧 under-developed）。
 *
 * 纯代码：枚举有 growth_curve 的角色 + turning_points 进度（linked_episode_ids ∩ writtenEpisodeIds 覆盖率）
 * + start→end 演进轨迹（透传 start_state/end_state 字符串）+ regressions 计数。
 *
 * **不判「挣得」**（语义归 L2）。L1 只产机械事实。
 *
 * @param growthCurves   growth_curve 数组（readGrowthCurves 单源归一产出，arc-coverage.ts）。
 * @param writtenEpisodeIds 已写章节 id 集合（用于覆盖率统计；空 = 单章/首章，所有进度降级 0）。
 */
export function collectArcCandidates(
  growthCurves: GrowthCurve[] | undefined,
  writtenEpisodeIds: readonly string[],
): ArcCandidate[] {
  if (!growthCurves || growthCurves.length === 0) return [];
  const writtenSet = new Set(writtenEpisodeIds);
  return growthCurves.map((curve) => {
    // 防御（CR-001）：caller 可能传 raw 未 parse 数据（绕过 readGrowthCurves / safeParse 失败的结构直传）。
    // ?? [] 只挡 null/undefined 不挡非数组（turning_points="foo" → flatMap 抛）；用 Array.isArray 守卫兜底非数组形态。
    const turningPoints = Array.isArray(curve.turning_points) ? curve.turning_points : [];
    const regressions = Array.isArray(curve.regressions) ? curve.regressions : [];
    const linkedIds = Array.isArray(curve.linked_episode_ids) ? curve.linked_episode_ids : [];
    const turningPointEpisodeIds = Array.from(
      new Set(
        turningPoints.flatMap((tp) => {
          // 元素形态守卫：tp 可能是非 object（坏数据），tp.linked_episode_ids 可能是非数组。
          if (!tp || typeof tp !== 'object') return [];
          const ids = (tp as { linked_episode_ids?: unknown }).linked_episode_ids;
          return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
        }),
      ),
    );
    const turningPointsTouchedWritten = turningPointEpisodeIds.filter((ep) => writtenSet.has(ep)).length;
    const linkedInWritten = linkedIds.filter((ep) => writtenSet.has(ep));
    return {
      character_id: curve.character_id,
      start_state: curve.start_state,
      ...(curve.wound_or_lack ? { wound_or_lack: curve.wound_or_lack } : {}),
      ...(curve.desire ? { desire: curve.desire } : {}),
      ...(curve.need ? { need: curve.need } : {}),
      turningPointCount: turningPoints.length,
      turningPointsTouchedWritten,
      turningPointEpisodeIds,
      regressionCount: regressions.length,
      ...(curve.end_state ? { end_state: curve.end_state } : {}),
      linkedEpisodeIds: linkedInWritten,
    };
  });
}

/**
 * 线候选汇编（design §4 线推进 missing）。
 *
 * 纯代码：枚举所有 line + outcomeType/themeRef/worldEventRef 标注状态（存在性检查）+ 已写章节涉及该线的场数
 * （lineTags 含此 line.id 的场 ∩ 已写章节数）。mirror scene-graph-analytics checkMeshMapping 存在性检查范式
 * （CR-006 边界：只查字段存在性，非引用完整性——引用实体校验归 L2 在拥有外部表时做）。
 *
 * **不判「真推进 / 该浮出」**（语义归 L2）。
 *
 * @param sceneGraph       scene_graph artifact（read 来源；undefined → 空候选）。
 * @param writtenEpisodeIds 已写章节 id 集合。
 */
export function collectLineCandidates(
  sceneGraph: SceneGraph | undefined,
  writtenEpisodeIds: readonly string[],
): LineCandidate[] {
  // 防御（CR-001）：sceneGraph 可能 partial（lines/nodes 字段非数组），用 Array.isArray 守卫（mirror collectArcCandidates）。
  const lines = sceneGraph && Array.isArray(sceneGraph.lines) ? sceneGraph.lines : [];
  const nodes = sceneGraph && Array.isArray(sceneGraph.nodes) ? sceneGraph.nodes : [];
  if (lines.length === 0) return [];
  const writtenSet = new Set(writtenEpisodeIds);
  return lines.map((line: SceneLine) => {
    // lineTags 元素形态守卫：n.lineTags 可能是非数组（CR-001），filter 前先校验。
    const sceneCountInWrittenEpisodes = nodes.filter((n) => {
      if (!n || typeof n !== 'object') return false;
      const tags = (n as { lineTags?: unknown }).lineTags;
      if (!Array.isArray(tags) || !tags.includes(line.id)) return false;
      const epId = (n as { episodeId?: unknown }).episodeId;
      return typeof epId === 'string' && writtenSet.has(epId);
    }).length;
    // visibility 抽取（CR-003）：lineVisibilitySchema discriminated union `{status:'open'}` 或
    // `{status:'hidden-until', target}`（creative-fields.ts:1552）；line.visibility 缺/异形默认 'open'。
    const rawVisibility = (line as { visibility?: unknown }).visibility;
    const visibilityStatus: 'open' | 'hidden-until' =
      rawVisibility && typeof rawVisibility === 'object' && (rawVisibility as { status?: unknown }).status === 'hidden-until'
        ? 'hidden-until'
        : 'open';
    const visibilityTarget =
      visibilityStatus === 'hidden-until'
        ? (rawVisibility as { target?: unknown }).target
        : undefined;
    return {
      id: line.id,
      name: line.name,
      topology_role: line.topology_role,
      ...(line.mice_type ? { mice_type: line.mice_type } : {}),
      // outcomeType 是 SceneNode 字段非 Line——线级 outcomeType 标注率统计改 L2 prompt 让 LLM 看场级 outcomeType。
      // 这里 line 级只标「线本身是否声明 mice_type」（线叙事单元）。
      outcomeTypeAnnotated: Boolean(line.mice_type),
      hasThemeRef: Boolean(line.themeRef),
      hasWorldEventRef: Boolean(line.worldEventRef),
      sceneCountInWrittenEpisodes,
      ...(line.convergence_target ? { convergence_target: line.convergence_target } : {}),
      visibilityStatus,
      ...(typeof visibilityTarget === 'string' && visibilityTarget.length > 0 ? { visibilityTarget } : {}),
    };
  });
}

// 目标弧 payoff 点 sceneMood 软词汇集（L1 扫语义词汇是软提示非裁判，mirror pacing-breath INTENSE_ROLES 范式）。
// 不做语义裁判——只数「目标 mood 字面值命中」机械计数，L2 综合判 payoff 是否真释放。
// CR-007：纯中文词（sceneMood 是中文，'catharsis' 永不匹配）；补 净化/宣泄 catharsis 中文化同义。
const PAYOFF_MOOD_KEYWORDS = ['释放', '爆发', '高潮', '达成', '兑现', '还债', '还愿', '净化', '宣泄'];

/**
 * 情绪弧候选汇编（design §4 情绪弧挣得 missing，与 5.3 正交）。
 *
 * 纯代码：透传 5.3 emotion-verify flag（数学指纹直传）+ 跨弧 emotion_curve 目标 payoff 点机械计数。
 *
 * **与 5.3 正交**：5.3 算 setpoint/topology/DTW 数学指纹产 flag（机械层）；4.4 消费 flag + 跨弧 emotion_curve
 * 做语义「挣得」裁判（语义层）。5.3 测不出的「payoff 是否真释放 / 转变是否铺垫」归 4.4 L2。
 *
 * **不判「挣得」**（语义归 L2）。L1 只透传 flag + 数 payoff 点机械命中。
 *
 * @param emotionCurve       emotion_curve artifact（Director 产目标轨）。
 * @param emotionVerifyResult 5.3 emotion_verify_result artifact（flag 透传源）。
 */
export function collectEmotionArcCandidates(
  emotionCurve: EmotionCurve | undefined,
  emotionVerifyResult: EmotionVerifyResult | undefined,
): EmotionArcCandidate | null {
  // 两源都缺 → 该类降级（L2 跳过情绪弧维）。
  if (!emotionCurve && !emotionVerifyResult) return null;

  // 防御（CR-001）：emotionCurve?.points 可能是非数组；元素可能非 object。Array.isArray + 元素形态守卫兜底。
  const rawPoints = emotionCurve && Array.isArray(emotionCurve.points) ? emotionCurve.points : [];
  const targetPointCount = rawPoints.length;
  // 目标 payoff 点机械计数：sceneMood 命中软词汇集（L1 软提示，非裁判）。
  const targetPayoffPointCount = rawPoints.filter((p) => {
    if (!p || typeof p !== 'object') return false;
    const mood = (p as { sceneMood?: unknown }).sceneMood;
    return typeof mood === 'string' && PAYOFF_MOOD_KEYWORDS.some((kw) => mood.includes(kw));
  }).length;

  // emotionVerifyResult.flags 防御（CR-001）：可能非数组，Array.isArray 守卫。
  const flags = emotionVerifyResult && Array.isArray(emotionVerifyResult.flags) ? emotionVerifyResult.flags : [];

  return {
    emotionVerifyFlags: flags,
    targetPointCount,
    targetPayoffPointCount,
    emotionVerifyDegraded: emotionVerifyResult?.degraded ?? false,
  };
}

/**
 * Promise 兑现候选汇编（design §4 Promise 兑现 missing-payoff，cross-arc）。
 *
 * 纯代码：resolvePromiseFulfillment 派生每 Promise 兑现态（纯函数，5.3 已用）+ plant/payoff/echoed beat 计数
 * + deadline 已过判定（episode index 严格小于比对，mirror 5.3 emotion-verify-node.ts:120-134 isDeadlinePassed）。
 *
 * **不判「该兑现未兑现 vs 故意留长线 / 真挣得非廉价」**（语义归 L2）。
 *
 * @param promiseRegistry    promise_registry artifact（assemble 注入）。
 * @param currentEpisodeId   本章 episode id（deadline 判定用；undefined → 仅兑现判定，不判过期）。
 * @param indexByEpisodeId   episode id → index map（caller 从 episode_outlines 派生，mirror 5.3 isDeadlinePassed
 *                           index 排序哲学）。CR-002：deadlinePassed 改纯 index 严格比较（`deadlineIdx < currentIdx`），
 *                           替代旧集合法（`writtenSet.has(deadline) && deadline !== currentEpisodeId`）。旧法在
 *                           「两 episode 共享 index」（平行线 / IF 分支）时产假 deadlinePassed：deadlineIdx === currentIdx
 *                           但 id 不同 → 旧法判 passed（错），新法判 not passed（对，mirror 5.3 严格 `<`）。
 *                           undefined → 无法判 index 前后 → graceful false（不造假「已过」）。
 */
export function collectPromiseCandidates(
  promiseRegistry: PromiseRegistry | undefined,
  currentEpisodeId: string | undefined,
  indexByEpisodeId?: ReadonlyMap<string, number>,
): PromiseCandidate[] {
  if (!promiseRegistry || promiseRegistry.promises.length === 0) return [];
  // Story 8.3 S5（4.4 CR-D4）：入口一次 groupBy(promiseId) 预索引（O(B)），per-promise 查 Map——替代
  // per-promise `beats.filter` 全量扫 + resolvePromiseFulfillment 内全量 some 的 O(P×B)。Map 内 push 保
  // 原数组序：ownBeats 顺序 / plantEpisodeIds 去重插入序 / some() 短路结果均与旧全扫逐字等价（filter/
  // some 对同集同序元素结果一致）；孤儿 beat（promiseId 不在 promises）不查即不入，同旧行为。
  const beatsByPromise = new Map<string, PromiseBeat[]>();
  for (const beat of promiseRegistry.beats) {
    const own = beatsByPromise.get(beat.promiseId);
    if (own !== undefined) own.push(beat);
    else beatsByPromise.set(beat.promiseId, [beat]);
  }
  const currentIdx = currentEpisodeId !== undefined ? indexByEpisodeId?.get(currentEpisodeId) : undefined;
  return promiseRegistry.promises.map((promise: PromiseEntry) => {
    const ownBeats = beatsByPromise.get(promise.id) ?? [];
    // 预索引传入：resolvePromiseFulfillment 内部按 promiseId 过滤对纯 own 集恒等，结果逐位一致
    // （同族 O(P×B) 一并消解；签名不变，其他调用方零改动）。
    const derivedStatus = resolvePromiseFulfillment(promise, ownBeats);
    const plantEpisodeIds = Array.from(
      new Set(
        ownBeats
          .filter((b) => b.kind === 'plant')
          .map((b) => b.episodeId)
          .filter((ep): ep is string => typeof ep === 'string' && ep.length > 0),
      ),
    );
    const payoffBeatCount = ownBeats.filter((b) => b.kind === 'payoff').length;
    const echoedBeatCount = ownBeats.filter((b) => b.kind === 'advance' || b.kind === 'setback').length;
    // deadline 已过判定（CR-002）：纯 index 严格小于比较，mirror 5.3 isDeadlinePassed。
    // - deadlineEpisodeId 缺 → false（无 deadline 概念）。
    // - currentEpisodeId 缺 / indexByEpisodeId 缺 → 无 index 排序 → graceful false。
    // - deadlineIdx >= currentIdx（含相等——本章 deadline 仍可能现 payoff；平行线同 index 不计）→ false。
    // - deadlineIdx < currentIdx（前章 deadline 仍 open）→ true（已过未兑现）。
    // L2 信任此机械事实——caller 必须正确派生 indexByEpisodeId（不可全量 episode_outlines id 集，否则未来
    // deadline 误报 passed → 假 Promise.missing-payoff finding）。
    const deadlineIdx =
      promise.deadlineEpisodeId !== undefined ? indexByEpisodeId?.get(promise.deadlineEpisodeId) : undefined;
    const deadlinePassed =
      derivedStatus === 'open' &&
      currentIdx !== undefined &&
      deadlineIdx !== undefined &&
      deadlineIdx < currentIdx;
    return {
      id: promise.id,
      title: promise.title,
      ...(promise.summary ? { summary: promise.summary } : {}),
      derivedStatus,
      autoFulfill: promise.autoFulfill,
      ...(promise.deadlineEpisodeId ? { deadlineEpisodeId: promise.deadlineEpisodeId } : {}),
      plantEpisodeIds,
      payoffBeatCount,
      echoedBeatCount,
      deadlinePassed,
    };
  });
}

/**
 * 主题候选汇编（design §4 主题挣得 missing）。
 *
 * 纯代码：声明主题（meta.theme / creative_brief.theme 合并去重）+ visual_motif themeMapping（表/中/深）
 * + themeRef 锚定的线（line.themeRef 非空）。
 *
 * **不判「挣得」**（语义归 L2，假信心门红线：词库命中→极性加权→pass/fail 是假信心）。
 *
 * @param projectTheme  project_theme artifact（caller fetch 注入，含 declaredThemes + themeMappings）。
 * @param sceneGraph    scene_graph artifact（read lines for themeRef anchor）。
 */
export function collectThemeCandidates(
  projectTheme: ProjectThemeInput | undefined,
  sceneGraph: SceneGraph | undefined,
): ThemeCandidate | null {
  // 防御：sceneGraph 可能 partial（lines 缺），用 ?? 兜底（mirror collectArcCandidates 防御哲学）。
  const lines = sceneGraph?.lines ?? [];
  if (!projectTheme && !lines.some((l) => l.themeRef)) return null;
  const declaredThemes = projectTheme?.declaredThemes ?? [];
  const themeMappings = projectTheme?.themeMappings ?? [];
  const linesAnchoringTheme = lines
    .filter((l) => l.themeRef)
    .map((l) => ({ lineId: l.id, lineName: l.name, themeRef: l.themeRef! }));
  if (declaredThemes.length === 0 && themeMappings.length === 0 && linesAnchoringTheme.length === 0) {
    return null;
  }
  return {
    declaredThemes,
    themeMappings,
    linesAnchoringTheme,
  };
}

/**
 * project_theme artifact shape（caller fetch 注入，mirror world_state_snapshot 模式）。
 *
 * write_chapter / closureChainIpc chain 启动前从 project.yaml 抽：meta.theme + creative_brief.theme 合并去重 +
 * asset_cards (type='visual_motif') 的 themeMapping 收集。纯代码查询/汇编（非语义判断）。
 */
export interface ProjectThemeInput {
  /** 声明主题（meta.theme + creative_brief.theme 合并去重，非空字符串）。 */
  declaredThemes: string[];
  /** visual_motif themeMapping（表/中/深，每张视觉母题卡一个条目）。 */
  themeMappings: Array<{
    cardId: string;
    cardName: string;
    surface?: string;
    middle?: string;
    deep?: string;
  }>;
}

/**
 * L1 候选汇编聚合（completeness-verify-node 的 L1 step 调用）。
 *
 * 把 5 类候选 + degraded 标注聚合为 CompletenessCandidateReport。
 *
 * **按类隔离降级**（CR-001，design §8 意图）：5 类 collect* 各自独立 try/catch，单类坏数据只降该类（该类空/null
 *  + degradationNote 记该类），不核爆五类全降级。mirror emotion-verify-node design §10 graceful 哲学（R6① 永不崩链）。
 *
 * **source-missing vs legitimate-empty**（CR-008）：degraded 只在「源 artifact 缺失」时记（input.<source> === undefined）；
 * 源在但 0 候选（如 promise_registry 在但 promises.length===0 / growth_curve 在但 0 角色弧）= legitimate-empty，
 * 不计 degraded（masking 真损坏），该类候选空数组 L2 自然跳过。
 *
 * @param input 各 creative field artifact raw（节点直传 run.artifacts 引用，函数内自行守卫）
 */
export function computeCompletenessCandidates(input: {
  growthCurveRaw?: unknown;
  sceneGraph?: SceneGraph | undefined;
  emotionCurve?: EmotionCurve | undefined;
  emotionVerifyResult?: EmotionVerifyResult | undefined;
  promiseRegistry?: PromiseRegistry | undefined;
  projectTheme?: ProjectThemeInput | undefined;
  currentEpisodeId?: string | undefined;
  writtenEpisodeIds?: readonly string[];
  /** episode id → index map（CR-002：collectPromiseCandidates deadlinePassed 严格 index 比对用）。 */
  indexByEpisodeId?: ReadonlyMap<string, number>;
}): CompletenessCandidateReport {
  const writtenEpisodeIds = input.writtenEpisodeIds ?? [];
  const degradationNotes: string[] = [];

  // 角色弧（独立 try/catch，CR-001 按类隔离降级）
  let arc: ArcCandidate[] = [];
  try {
    const growthCurves = readGrowthCurves(input.growthCurveRaw);
    arc = collectArcCandidates(growthCurves, writtenEpisodeIds);
  } catch (err) {
    degradationNotes.push(`arc: growth_curve 汇编异常（${err instanceof Error ? err.message : String(err)}）`);
    arc = [];
  }
  // CR-008：source-missing（input.growthCurveRaw undefined/null）才 degraded；present 但 0 候选 = legitimate-empty。
  if (input.growthCurveRaw === undefined || input.growthCurveRaw === null) {
    degradationNotes.push('arc: growth_curve 缺（source-missing，L2 跳过该类）');
  }

  // 线
  let line: LineCandidate[] = [];
  try {
    line = collectLineCandidates(input.sceneGraph, writtenEpisodeIds);
  } catch (err) {
    degradationNotes.push(`line: scene_graph 汇编异常（${err instanceof Error ? err.message : String(err)}）`);
    line = [];
  }
  if (!input.sceneGraph) {
    degradationNotes.push('line: scene_graph 缺（source-missing，L2 跳过该类）');
  }

  // 情绪弧（单条候选或 null）
  let emotionArc: EmotionArcCandidate | null = null;
  try {
    emotionArc = collectEmotionArcCandidates(input.emotionCurve, input.emotionVerifyResult);
  } catch (err) {
    degradationNotes.push(
      `emotion-arc: 汇编异常（${err instanceof Error ? err.message : String(err)}）`,
    );
    emotionArc = null;
  }
  if (emotionArc === null) {
    degradationNotes.push('emotion-arc: emotion_curve 与 emotion_verify_result 均缺（source-missing）');
  }

  // Promise
  let promise: PromiseCandidate[] = [];
  try {
    promise = collectPromiseCandidates(input.promiseRegistry, input.currentEpisodeId, input.indexByEpisodeId);
  } catch (err) {
    degradationNotes.push(`promise: 汇编异常（${err instanceof Error ? err.message : String(err)}）`);
    promise = [];
  }
  if (!input.promiseRegistry) {
    degradationNotes.push('promise: promise_registry 缺（source-missing，L2 跳过该类）');
  }

  // 主题（单条候选或 null）
  let theme: ThemeCandidate | null = null;
  try {
    theme = collectThemeCandidates(input.projectTheme, input.sceneGraph);
  } catch (err) {
    degradationNotes.push(`theme: 汇编异常（${err instanceof Error ? err.message : String(err)}）`);
    theme = null;
  }
  if (theme === null) {
    degradationNotes.push('theme: 无声明主题 + 无 themeMapping + 无 themeRef 线（source-missing）');
  }

  const degraded = degradationNotes.length > 0;
  const degradationNote = degraded ? degradationNotes.join('; ') : '';

  return {
    arc,
    line,
    emotionArc,
    promise,
    theme,
    ...(input.currentEpisodeId ? { currentEpisodeId: input.currentEpisodeId } : {}),
    writtenEpisodeIds,
    degraded,
    degradationNote,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// artifact shape：completeness_verify_result（L2 产出，mirror review.latest dimensions/findings + emotion_verify_result flag 混合）
// ════════════════════════════════════════════════════════════════════════════

/** 节点产出 artifact key（链段，mirror emotion_verify_result 形态，非 creative field，不进 project.yaml）。 */
export const COMPLETENESS_VERIFY_RESULT_KEY = 'completeness_verify_result';

/**
 * completeness-verify-node 链段 contract（design §2）。
 *
 * nodeId='completeness-verify-node'；requiredArtifactKeys=[]（graceful——mirror emotion-verify-node.ts:62，
 * 累积数据源缺失不阻断链，L1 降级空候选 + L2 跳过该类）。producedArtifactKeys=[COMPLETENESS_VERIFY_RESULT_KEY]。
 * sideEffects=['call_model']（L2 LLM generate）。
 */
export const COMPLETENESS_VERIFY_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'completeness-verify-node',
  displayName: 'Completeness Verify Node',
  inputSchemaName: 'completenessVerifyInput',
  outputSchemaName: 'completenessVerifyResult',
  requiredArtifactKeys: [],
  producedArtifactKeys: [COMPLETENESS_VERIFY_RESULT_KEY],
  sideEffects: ['call_model'],
};

/**
 * 5 类缺漏封闭 enum（机械控制信号，非语义——下游 8.2/dashboard/工作台 UI 消费）。
 *
 * 封闭 enum 是「类别路由信号」（route defense guard / 下游统计分类），非语义裁判（severity/verdict 归 L2 语义）。
 */
export const completenessCategorySchema = z.enum(['arc', 'line', 'emotion-arc', 'promise', 'theme']);

/**
 * 缺漏 verdict 封闭 enum（2 档机械控制信号，design §5）。
 *
 * - missing：完全缺失（如线被弃 / Promise 完全没兑现 / 主题完全没触及）
 * - under-developed：发展不足（如角色弧 turning_point 有但转折太弱 / 线推进缓慢）
 *
 * severity 不再单独标（区别于 Reader-Audit block/warn/info）——4.4 是创作辅助语气（R6），findings 全是
 * 「建议补缺」非「报错」，verdict 二档已足够。L2 据语义判 missing vs under-developed。
 */
export const completenessVerdictSchema = z.enum(['missing', 'under-developed']);

/**
 * completeness-verify-node L2 产出 shape（design §5）。
 *
 * findings[]：每条带 grounding（quote 正文原句 + location 段/句）+ 指向具体创作实体（entityId）+ 给 Director
 * 的补缺建议（suggestedFix，创作辅助语气，R6）。category/verdict 封闭 enum = 机械控制信号（下游分类）。
 *
 * degraded（mirror emotion-verify degraded）：L1 候选缺源降级标注，Director 见 degraded 知完整性数据不全。
 */
export const completenessVerifyResultSchema = z.object({
  findings: z
    .array(
      z.object({
        category: completenessCategorySchema,
        verdict: completenessVerdictSchema,
        /** 指向创作实体 id（角色弧 character_id / 线 line.id / Promise promise.id / 主题 string）。 */
        entityId: z.string().min(1),
        /** 人类可读标签（如「主角成长弧」「暗线：密信」）。CR-004：min(1) 防空串过关。 */
        entityLabel: z.string().min(1),
        /** 正文原句片段（grounding 硬要求，必填非空——mirror review.latest quote.min(1)）。 */
        quote: z.string().min(1),
        /** 章/段/句（grounding 硬要求，必填非空——mirror review.latest location.min(1)）。 */
        location: z.string().min(1),
        /** 为什么是缺漏（一句话）。CR-004：min(1) 防 AC4 落地公理 schema 层无保证。 */
        explanation: z.string().min(1),
        /** 给 Director 的补缺建议（创作辅助语气，R6 非报错）。CR-004：min(1) 防空串过关。 */
        suggestedFix: z.string().min(1),
      }),
    )
    .default([]),
  summary: z.string(),
  degraded: z.boolean().default(false),
  degradationNote: z.string().optional(),
});
export type CompletenessVerifyResult = z.infer<typeof completenessVerifyResultSchema>;

/** L1 候选报告内联 schema（用于 /test fixture 与潜在 IPC 校验，mirror emotionVerifyResultSchema export 惯例）。 */
export const completenessCandidateReportSchema = z.object({
  arc: z.array(
    z.object({
      character_id: z.string().min(1),
      start_state: z.string(),
      wound_or_lack: z.string().optional(),
      desire: z.string().optional(),
      need: z.string().optional(),
      turningPointCount: z.number().int().nonnegative(),
      turningPointsTouchedWritten: z.number().int().nonnegative(),
      turningPointEpisodeIds: z.array(z.string()),
      regressionCount: z.number().int().nonnegative(),
      end_state: z.string().optional(),
      linkedEpisodeIds: z.array(z.string()),
    }),
  ),
  line: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      topology_role: z.string(),
      mice_type: z.string().optional(),
      outcomeTypeAnnotated: z.boolean(),
      hasThemeRef: z.boolean(),
      hasWorldEventRef: z.boolean(),
      sceneCountInWrittenEpisodes: z.number().int().nonnegative(),
      convergence_target: z.string().optional(),
      visibilityStatus: z.enum(['open', 'hidden-until']),
      visibilityTarget: z.string().optional(),
    }),
  ),
  emotionArc: z
    .object({
      emotionVerifyFlags: z.array(z.string()),
      targetPointCount: z.number().int().nonnegative(),
      targetPayoffPointCount: z.number().int().nonnegative(),
      emotionVerifyDegraded: z.boolean(),
    })
    .nullable(),
  promise: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string(),
      summary: z.string().optional(),
      derivedStatus: z.enum(['open', 'fulfilled', 'abandoned']),
      autoFulfill: z.boolean(),
      deadlineEpisodeId: z.string().optional(),
      plantEpisodeIds: z.array(z.string()),
      payoffBeatCount: z.number().int().nonnegative(),
      echoedBeatCount: z.number().int().nonnegative(),
      deadlinePassed: z.boolean(),
    }),
  ),
  theme: z
    .object({
      declaredThemes: z.array(z.string()),
      themeMappings: z.array(
        z.object({
          cardId: z.string(),
          cardName: z.string(),
          surface: z.string().optional(),
          middle: z.string().optional(),
          deep: z.string().optional(),
        }),
      ),
      linesAnchoringTheme: z.array(
        z.object({
          lineId: z.string(),
          lineName: z.string(),
          themeRef: z.string(),
        }),
      ),
    })
    .nullable(),
  currentEpisodeId: z.string().optional(),
  writtenEpisodeIds: z.array(z.string()),
  degraded: z.boolean(),
  degradationNote: z.string(),
});
