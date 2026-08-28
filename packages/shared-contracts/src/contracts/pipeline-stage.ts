// ── Story 8.6 R5: pipeline stage facts（创作旅程里程碑事实，design §3.2 / 决策 D8/D9，mirror arc-coverage.ts）──
//
// 冷启动引导「流程雷达」的数据单源：从 project.yaml 解析产物算各站里程碑事实（灵感有无 / 角色卡数·世界
// 条目数 / 世界设定有无 / 大纲阶段数 / 场结构数 / 成长弧数 / 集纲数 / 可写章预判 / 偏好已问否）。两消费端
// 单源：leader 雷达段（workflow.ts loadPipelineStageForLeader，Step 4）+ 未来 UI / e2e 断言（design D8）。
//
// 范式红线（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md，mirror arc-coverage.ts 头注释）：本模块
// 只报旅程叙事事实（存在性 / 计数），**永不**判「该不该有 / 够不够 / 完成度」——那是语义，归 leader LLM
// 引导对话（题材感知的缺什么先补什么、设定够不够写下一章，均非纯代码可判）。无评分、无百分比、无
// 「完成度 40%」式假信心门；非线性红线——缺什么是事实清单非第 N 步向导（prd R5）。
//
// 单源复用（防两处判定漂移）：
// - growthCurveCount ← findArcCoverageGaps(growthCurveRaw, episodeOutlines).totalCurves（arc-coverage.ts；
//   8.5 头注释预留的 8.6 消费在此兑现——「有曲线」= totalCurves>0，去重角色数一角色一弧语义一脉）。
// - settingsPresent 由调用方传入（compileSettingPrefix 产出非空信号，setting-prefix.ts）——本文件不
//   import setting-prefix（避免 creative-fields ←→ setting-prefix 依赖环），函数只收 boolean，同
//   computeReadiness 的 settingsPresent 入参惯例（chapter-brief.ts）。
// - writeReadyLikely 是 D9 **项目级预判**（sceneNodeCount>0 && settingsPresent && episodeCount>=1），
//   不含 brief.goal（那是 per-episode 写时真值）——readiness gate（computeReadiness）仍是权威，雷达
//   预判 + gate 真值双层不架空（注入段措辞「看起来可以开写（写时仍会做逐章检查）」）。
//
// 坏形态宽容（mirror findArcCoverageGaps walk 惯例）：输入字段坏形态跳过不抛（计数归 0 / 存在性归
// false——caller 可能传 raw 未 parse 数据）；「存在但坏」（如 asset_cards 非数组）与「缺省 = 合法空」
// 的区分上抛由 caller（loader 层，mirror loadArcCoverageForLeader 两态区分）处理——本函数只对传进来
// 的值做机械事实，不读文件不判数据可信度。
//
// expected_downstream_consumers:
// - Story 8.6 R5 Step 4：loadPipelineStageForLeader（workflow.ts 第七 loader，防御三态）→
//   buildInteractionModeSegment 雷达段（has 清单 / no 冷启动接第一问 / degraded 单行）。

import { z } from 'zod';
import { findArcCoverageGaps } from './arc-coverage';
import type { CreativePreferences, EpisodeOutline } from './creative-fields';

// ── facts schema ──

export const pipelineStageFactsSchema = z.object({
  /**
   * 冷启动（雷达 no 态，design §3.2）：灵感未记（rawRequirement 空 / 项目名兜底串）且全站空——新项目
   * 刚创建的标准形态，接第一问协议。任一站有内容或灵感已记 → 非冷启动（老项目直接 has 态）。
   */
  coldStart: z.boolean(),
  /**
   * 灵感已入档（启发式：rawRequirement 非空且 ≠ meta.name——创建期 seed 落的是项目名兜底串。作者真
   * 灵感恰与项目名同文会误判，**误判终审归 leader**（对话一问即知，非纯代码可判），design §3.2）。
   */
  hasInspirationRecorded: z.boolean(),
  /** 角色卡数（asset_cards type='character' 计数；坏形态元素跳过不计数）。 */
  characterCardCount: z.number().int().nonnegative(),
  /** 世界条目数（asset_cards 非角色卡的世界侧设定：地点/组织/规则/传说/物品/视觉母题/金手指等）。 */
  worldEntryCount: z.number().int().nonnegative(),
  /** 世界设定站有内容（world_setting 任意自有字段非空——纯结构存在性，非「世界够不够」）。 */
  hasWorldSetting: z.boolean(),
  /** 大纲阶段数（outline_v2.phases 计数——「大纲 4 卷」式里程碑事实）。 */
  outlinePhaseCount: z.number().int().nonnegative(),
  /** 场结构节点数（scene_graph.nodes 计数）。 */
  sceneNodeCount: z.number().int().nonnegative(),
  /** 成长弧数（findArcCoverageGaps.totalCurves 单源——去重角色数，一角色一弧，8.5 语义）。 */
  growthCurveCount: z.number().int().nonnegative(),
  /** 集纲数（episode_outlines 计数）。 */
  episodeCount: z.number().int().nonnegative(),
  /**
   * 可写章预判（D9 项目级近似：有场 + 有设定锚 + 有集纲）。写时 readiness gate 逐章真值权威不变
   * （computeReadiness per-episode），本预判不架空 gate——注入段措辞注明「写时仍会做逐章检查」。
   */
  writeReadyLikely: z.boolean(),
  /** 偏好已问（四轴至少一轴有值或 note 非空白——走查 GAP-5 修正：note 单独也能表达偏好；false = 未问 = 标准档）。 */
  preferencesSet: z.boolean(),
});
export type PipelineStageFacts = z.infer<typeof pipelineStageFactsSchema>;

// ── input ──

/**
 * computePipelineStage 输入：project.yaml 解析产物（loader 侧逐字段读取 + schema safeParse 的产物；
 * 坏形态字段由 loader 判 degraded，本函数对传进来的值再作宽容 walk——双层防御 mirror
 * loadArcCoverageForLeader 哲学）。全字段可 undefined（缺省 = 合法空，零站起步是真实形态非异常）。
 */
export interface PipelineStageInput {
  /** project.yaml meta.name——灵感启发式对照（rawRequirement 与项目名相同 → 创建期兜底串非真灵感）。 */
  metaName: string | undefined;
  /** creative_brief.rawRequirement（灵感原文落点，design D1——schema 唯一必填字段语义正是原始需求）。 */
  rawRequirement: string | undefined;
  /** asset_cards 原始数组（分类计数源）。缺省 / 非数组 → 0/0。 */
  assetCards: readonly unknown[] | undefined;
  /** world_setting 原始对象（hasWorldSetting 存在性信号）。 */
  worldSetting: unknown;
  /** outline_v2.phases 原始数组（outlinePhaseCount）。 */
  outlinePhases: readonly unknown[] | undefined;
  /** scene_graph.nodes 原始数组（sceneNodeCount）。 */
  sceneNodes: readonly unknown[] | undefined;
  /** project.yaml growth_curve 原始值（三形态宽容归一在 findArcCoverageGaps 单源内，不经手）。 */
  growthCurveRaw: unknown;
  /** parsed episode_outlines（findArcCoverageGaps 同参 + episodeCount）。缺省 = 无集纲（合法空）。 */
  episodeOutlines: readonly EpisodeOutline[] | undefined;
  /** parsed creative_preferences（loader 侧 creativePreferencesSchema.safeParse 产物）。缺省 = 未问。 */
  creativePreferences: CreativePreferences | undefined;
  /** 设定锚点存在信号（caller 调 compileSettingPrefix(...).length > 0 算，纯结构信号——D9）。 */
  settingsPresent: boolean;
}

// ── pure function ──

/**
 * 计算创作旅程各站里程碑事实。纯函数——存在性 / 计数 only，零语义判断（范式红线见文件头）。
 *
 * Graceful（mirror findArcCoverageGaps）：所有输入字段坏形态跳过不抛（计数归 0 / 存在性归 false）；
 * growth_curve 三形态归一 / 集纲坏元素 walk 均在 findArcCoverageGaps 单源内。冷启动判定 = 灵感启发式
 * && 全站空（见 pipelineStageFactsSchema.coldStart 注释）。
 */
export function computePipelineStage(input: PipelineStageInput): PipelineStageFacts {
  // 灵感启发式（design §3.2）：rawRequirement 空 → 无记录；=== meta.name → 创建期项目名兜底串
  // （NewProjectDialog seed 落 {rawRequirement: name.trim()}）→ 同样无记录。启发式终审归 leader。
  const raw = typeof input.rawRequirement === 'string' ? input.rawRequirement.trim() : '';
  const name = typeof input.metaName === 'string' ? input.metaName.trim() : '';
  const hasInspirationRecorded = raw.length > 0 && (name.length === 0 || raw !== name);

  const { character: characterCardCount, world: worldEntryCount } = countAssetCards(
    asArray(input.assetCards),
  );
  const hasWorldSetting = worldSettingHasContent(input.worldSetting);
  const outlinePhaseCount = asArray(input.outlinePhases).filter(isCountableObject).length;
  const sceneNodeCount = asArray(input.sceneNodes).filter(isCountableObject).length;

  // growthCurveCount 单源（8.5 arc-coverage 预留注释兑现）：totalCurves = 去重角色数（一角色一弧）。
  const episodes = Array.isArray(input.episodeOutlines) ? input.episodeOutlines : [];
  const growthCurveCount = findArcCoverageGaps(input.growthCurveRaw, episodes).totalCurves;
  const episodeCount = episodes.length;

  // D9 项目级预判——不含 brief.goal（per-episode 写时真值归 computeReadiness gate，不架空）。
  const writeReadyLikely = sceneNodeCount > 0 && input.settingsPresent && episodeCount >= 1;

  const preferencesSet = preferencesIndicateSet(input.creativePreferences);

  // 冷启动（雷达 no 态）：灵感未记 && 全站空（全部里程碑计数字段归零）。
  const coldStart =
    !hasInspirationRecorded &&
    characterCardCount === 0 &&
    worldEntryCount === 0 &&
    !hasWorldSetting &&
    outlinePhaseCount === 0 &&
    sceneNodeCount === 0 &&
    growthCurveCount === 0 &&
    episodeCount === 0;

  return {
    coldStart,
    hasInspirationRecorded,
    characterCardCount,
    worldEntryCount,
    hasWorldSetting,
    outlinePhaseCount,
    sceneNodeCount,
    growthCurveCount,
    episodeCount,
    writeReadyLikely,
    preferencesSet,
  };
}

// ── helpers（防御 walk，零语义）──

/** 数组守卫归一（caller 可能传 raw 未 parse 数据；非数组 → 空数组，mirror findArcCoverageGaps CR-Edge-F6）。 */
function asArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * 计数最小结构守卫：非 null 对象即计（phases / nodes 的里程碑计数不校验内容——内容质量归 LLM）。
 * CR-015（8.6 BMad CR）：排除数组——phases/nodes 坏形态为「数组的数组」（元素是数组非对象条目）
 * 时按元素计数会虚高（数组 typeof 'object' 但不是里程碑条目）。
 */
function isCountableObject(v: unknown): v is object {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 卡分类计数（纯机械 by type 字段）：type='character' → 角色卡；type 为其他非空字符串 → 世界条目
 * （世界侧设定统称——地点/组织/规则/传说/物品/视觉母题/金手指）；无 type / 坏形态元素跳过不计数
 * （mirror findArcCoverageGaps episode walk 惯例——「存在但坏」由 caller 区分）。
 */
function countAssetCards(cards: readonly unknown[]): { character: number; world: number } {
  let character = 0;
  let world = 0;
  for (const card of cards) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) continue;
    const type = (card as { type?: unknown }).type;
    if (typeof type !== 'string' || type.length === 0) continue;
    if (type === 'character') character++;
    else world++;
  }
  return { character, world };
}

/**
 * 世界设定站「有内容」：非空对象且至少一个自有字段值非空（string trim 后非空 / 数组非空）。浅扫——
 * worldSettingSchema 字段即 string/array 两型；纯结构存在性，不判「世界铺得够不够」（归 leader）。
 */
function worldSettingHasContent(worldSetting: unknown): boolean {
  if (!worldSetting || typeof worldSetting !== 'object' || Array.isArray(worldSetting)) return false;
  for (const value of Object.values(worldSetting as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim().length > 0) return true;
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

/**
 * preferencesSet（走查 GAP-5 修正）：四轴至少一轴有非空字符串值，或 note 非空白。轴值合法性
 * （enum 内）由 loader 侧 creativePreferencesSchema parse 把关——此处只做结构性存在事实（parsed
 * 输入契约下两态一致；宽容 raw 调用方时「轴有值」即为事实，值真伪非本函数职责）。
 */
function preferencesIndicateSet(prefs: unknown): boolean {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return false;
  const p = prefs as Record<string, unknown>;
  for (const axis of ['outline_depth', 'arc_timing', 'world_depth', 'character_depth'] as const) {
    const v = p[axis];
    if (typeof v === 'string' && v.length > 0) return true;
  }
  const note = p.note;
  return typeof note === 'string' && note.trim().length > 0;
}
