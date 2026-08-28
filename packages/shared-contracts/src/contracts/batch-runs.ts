import { z } from 'zod';
import { promiseBeatKindSchema, vadTripleSchema } from './creative-fields';

// ── Story 3.5 chat-fatigue 防护与渐进披露：参与档位 + 批量运行状态 + 场权重信号契约 ──
//
// design §2.1（档位模型）/ §3.1（L1 信号汇编）/ §6（批量状态持久化）。全 additive optional /
// 新文件——零 migration，旧会话 / 旧 project.yaml 不破。
//
// 范式判据（ADR-3 / creative-vs-mechanical，R7 红线）：
// - 本文件只定义 **结构容器**（schema 存查）：档位枚举 / 圈类别枚举 / 批量状态 / 每场信号卡。
// - 判轻重 / 问什么 / 走向单 / L0 全景文本 = LLM（leader）；信号汇编 / 场列表 / 进度记账 / 状态读写 = 纯代码。
// - SceneWeightSignal 只承载**机械事实**（存在性 / 计数 / 结构字段投影），无重要性分值、无 pass/fail——
//   「这场重不重要」归 leader LLM 按题材承诺 + 上下文判（禁硬编码重要性规则 = 假信心门）。
//
// 与 permissionMode（工具执行权）/ behaviorMode（单 turn 风格）正交的第三值组（design §2.1）：
// gear 管「问什么 / 何时问」；permissionMode 管工具执行权；behaviorMode 管单 turn 风格。三者组合合法。

/**
 * 参与档位（Story 3.5 R1，旋钮 B 从二元扩谱系）。
 *
 * - smart（默认主力）：模型自主判轻重——重点场停问 2-3 创作选择，非重点直写。
 * - steer（掌舵）：每场写前都问（重点细问，普通快问一句）。
 * - balanced（平衡）：走向单等作者确认 + 圈定类别命中才问，其余自控。
 * - hands_off（放手）：零问跑完 + 末尾验收清单；灰区按 trustAdjudication 处置。
 */
export const participationGearSchema = z.enum(['smart', 'steer', 'balanced', 'hands_off']);
export type ParticipationGear = z.infer<typeof participationGearSchema>;

/** 缺省档位（旧会话无字段 → 此值）。 */
export const PARTICIPATION_GEAR_DEFAULT: ParticipationGear = 'smart';

/**
 * balanced 档圈定的「必问类别」（design §2.1，默认三项全）。
 *
 * - protagonist_safety：主角生死安危。
 * - information_gap：信息差关键抉择（透露 / 隐瞒 / 反转的走向）。
 * - direction_turn：方向转弯（线 / 弧 / 大纲层面的路线改变）。
 *
 * 类别是**机械匹配标签**——「某事是否属该类别」是语义判断归 leader LLM（本枚举只划定问的
 * 触发域，不做内容判定）。
 */
export const balancedAskCategorySchema = z.enum(['protagonist_safety', 'information_gap', 'direction_turn']);
export type BalancedAskCategory = z.infer<typeof balancedAskCategorySchema>;

/** balanced 档缺省圈类别（全三项；session 未设时消费端用此默认）。 */
export const BALANCED_ASK_CATEGORIES_DEFAULT: BalancedAskCategory[] = [
  'protagonist_safety',
  'information_gap',
  'direction_turn',
];

/** hands_off 档灰区处置缺省（false = 仍停下问，安全默认；design §2.1）。 */
export const TRUST_ADJUDICATION_DEFAULT = false;

// ── 批量消息分组标记（design §5.1 渐进披露契约，AgentMessage/SessionMessage additive 字段）──

/**
 * 批量消息种类：progress = 批量进行中的过程消息（BatchGroup 折叠组）；report = 锚点收尾全景
 * （BatchReportCard 渲染源）。运行时纯代码盖章（活跃批量存在时），不靠 LLM 自觉（范式：盖章=记账=纯代码）。
 */
export const batchKindSchema = z.enum(['progress', 'report']);
export type BatchKind = z.infer<typeof batchKindSchema>;

// ── 批量运行状态（design §6，`{projectPath}/.orison/batches.json` 单文件数组）──

/**
 * 批量生命周期状态。
 *
 * - running：活跃批量（消息盖 batchId='progress'；prompt 注入批量协议段）。
 * - paused：中断（崩溃 / abort 后磁盘残留；batch_status 对账后续跑回 running）。
 * - done / aborted：终态（end_batch 收口）。
 */
export const batchStatusSchema = z.enum(['running', 'paused', 'done', 'aborted']);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

/**
 * 单次批量运行状态（导航态，非真相源——进度真相源 = project state 已落盘章节 + doneSceneIds 交叉校验）。
 *
 * 存 `{projectPath}/.orison/batches.json`（cap 10 LRU）；读写经 atomicWrite + BOM-strip /
 * malformed → graceful（mirror loadStructureIssuesForLeader 防御）。
 */
export const batchRunStateSchema = z.object({
  batchId: z.string().min(1),
  /** epoch ms（LRU 排序键）。 */
  createdAt: z.number().int().nonnegative(),
  /** 最近一次状态变更时间（epoch ms，optional additive）。 */
  updatedAt: z.number().int().nonnegative().optional(),
  /** 批量沿哪条线（Line.id）；显式 sceneIds 选择器时可缺。 */
  lineTag: z.string().min(1).optional(),
  /** 批量目标锚点场（SceneNode.id）；线选择器解析出的边界。 */
  targetAnchorSceneId: z.string().min(1).optional(),
  /** 拓扑序场列表（解析产物，≥1）。 */
  orderedSceneIds: z.array(z.string().min(1)).min(1),
  /** 已完成场（leader 汇报 / batch_status 对账时累加）。 */
  doneSceneIds: z.array(z.string().min(1)).default([]),
  /**
   * Story 8.4 Step 4（A8 批量挂起继续他章）：出发核查挂起（矛盾/超限）被跳过的场——批量继续他章，
   * 决断后重写该章（write_chapter 重调 → 落盘 → batch_status 对账转 done）。additive optional
   * （旧记录缺省 → 视为无挂起；done 优先——已落盘的场不再算挂起）。
   */
  suspendedSceneIds: z.array(z.string().min(1)).optional(),
  /** 启动时档位快照（随时调档生效于下一场——live gear 读 session，此字段是起始记录）。 */
  gear: participationGearSchema,
  status: batchStatusSchema,
  /** 场→章映射（presentationSpans 分组产物；一章只写一次）。 */
  chapterMap: z.record(z.string(), z.string()),
  /**
   * 启动批量的 leader 会话（消息盖章只盖本会话，防同项目他 会话 误标；additive optional——
   * 旧记录 / 测试数据可缺，缺 = 项目内任意会话可盖章）。
   */
  sessionId: z.string().min(1).optional(),
});
export type BatchRunState = z.infer<typeof batchRunStateSchema>;

// ── SceneWeightSignal（design §3.1 L1 信号汇编，纯代码机械事实）──

/** 本场挂的 Promise 节拍（plant/advance/setback/payoff 的机械列举，语义归 LLM）。 */
export const scenePromiseBeatSchema = z.object({
  promiseId: z.string().min(1),
  kind: promiseBeatKindSchema,
  promiseTitle: z.string().optional(),
});
export type ScenePromiseBeat = z.infer<typeof scenePromiseBeatSchema>;

/** 本场情绪目标信号（emotion_curve point 投影：语义词 + 可选 VAD + per-character 目标）。 */
export const sceneEmotionSignalSchema = z.object({
  sceneMood: z.string().optional(),
  sceneVad: vadTripleSchema.nullish(),
  characters: z.array(z.object({
    characterId: z.string().min(1),
    emotion: z.string().min(1),
    emotionEnd: z.string().optional(),
  })).default([]),
});
export type SceneEmotionSignal = z.infer<typeof sceneEmotionSignalSchema>;

/** 本场信息释放信号（InfoReleaseMap entry 计数 + 模式列举）。 */
export const sceneInfoReleaseSignalSchema = z.object({
  entryCount: z.number().int().nonnegative(),
  /** 在场的 directive.mode 集合（reveal_first / sustain_unknown / method_foreseen / subjective_mislead）。 */
  modes: z.array(z.string()).default([]),
  revealCount: z.number().int().nonnegative(),
  withholdCount: z.number().int().nonnegative(),
});
export type SceneInfoReleaseSignal = z.infer<typeof sceneInfoReleaseSignalSchema>;

/** 世界状态在场主体（scene.assetRefs ∩ 有 world-state patches 的主体；纯 id 匹配）。 */
export const sceneWorldStateSubjectSchema = z.object({
  subjectId: z.string().min(1),
  patchCount: z.number().int().nonnegative(),
});
export type SceneWorldStateSubject = z.infer<typeof sceneWorldStateSubjectSchema>;

/**
 * 单场权重信号卡（L1 纯代码汇编 → leader L2 语义判轻重）。
 *
 * 🔑 范式红线：字段全是**存在性 / 计数 / 结构投影**——无重要性分值、无「该不该问」判定。
 * 「同信号在这个题材里算多重」归 leader LLM 对照 GenreContract commitments 判（R3 题材感知）。
 */
export const sceneWeightSignalSchema = z.object({
  sceneId: z.string().min(1),
  /** 场→章映射产物（缺 = 未指派章）。 */
  chapterId: z.string().min(1).optional(),
  storyTime: z.number().int().nonnegative(),
  storyTimeLabel: z.string().optional(),
  /** SceneNode.role 原值（normal / core-anchor / secondary-anchor / fork-point）。 */
  role: z.string(),
  /** typed 锚点类型（role 为 normal 时缺省——「是否锚点」是结构事实）。 */
  anchorType: z.enum(['core-anchor', 'secondary-anchor', 'fork-point']).optional(),
  lineTags: z.array(z.string()).default([]),
  outcomeType: z.string().optional(),
  pacingRole: z.string().optional(),
  /** 前向边（CAUSAL/SUSPENSE）触及本场的计数（入+出，因果密度结构事实）。 */
  causalEdgeCount: z.number().int().nonnegative(),
  /** 本场挂的 Promise 节拍。 */
  promiseBeats: z.array(scenePromiseBeatSchema).default([]),
  /** 截至本场 episode 已逾期的 open Promise 标题（deadlineEpisodeId 机械匹配）。 */
  promiseDueTitles: z.array(z.string()).default([]),
  emotion: sceneEmotionSignalSchema.optional(),
  infoRelease: sceneInfoReleaseSignalSchema.optional(),
  /** 本场 assetRefs 中有 world-state 历史的主体（安危信号的结构底料，风险判定归 LLM）。 */
  worldStateSubjects: z.array(sceneWorldStateSubjectSchema).default([]),
  /**
   * 大纲丰富度（机械完整度计数：episode outline 字段信号数 + 场细节字段信号数 → 三档）。
   * rich → leader 以大纲为主判；sparse/none → 降级靠题材承诺 + 已写正文 + world state 判（R3 鲁棒）。
   */
  outlineRichness: z.enum(['rich', 'sparse', 'none']),
});
export type SceneWeightSignal = z.infer<typeof sceneWeightSignalSchema>;
