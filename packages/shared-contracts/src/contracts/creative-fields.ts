import { z } from 'zod';

// ── Creative Field Key ──

export const creativeFieldKeys = [
  'creative_brief',
  'world_setting',
  'outline',
  'episode_outlines',
  'growth_curve',
  'pacing_curve',
  'emotion_curve',
  'asset_cards',
  'relationship_graph',
  'promise_registry',
  'info_release_map',
  'scene_graph',
  // Story 8.2：写手声明的弧节拍（LLM-authored 叙事状态，mirror promise_registry 归属——非 closure_*
  // 派生表）。加 key 四处映射同步（interface-contracts Convention）：fieldSyncBridge / localProjectRepository
  // FIELD_TO_KEY 已同步；agent FIELD_ALIAS + story-sync prompt union 留 agent 消费轮（Step 3/4）。
  'arc_registry',
  // Story 8.6：创作深度偏好（分项目工作方式，四轴 + note，schema 见下方 Creative Preferences 段；absent =
  // 未问 = 标准档，不产假偏好）。加 key 四处映射同步（interface-contracts Convention）：fieldSyncBridge /
  // localProjectRepository FIELD_TO_KEY 已同步；agent FIELD_ALIAS / story-sync prompt union 不消费本字段
  // （偏好非链段创作素材、非正文反哺目标）不加。
  'creative_preferences'
] as const;

export type CreativeFieldKey = (typeof creativeFieldKeys)[number];

export const creativeFieldKeySchema = z.enum(creativeFieldKeys);

// ── Field Metadata ──

export const fieldMetadataSchema = z.object({
  version: z.number().int().nonnegative(),
  source: z.enum(['user', 'agent', 'imported', 'sync']),
  locked: z.boolean().default(false),
  dependsOn: z
    .array(
      z.object({
        field: creativeFieldKeySchema,
        version: z.number().int().nonnegative()
      })
    )
    .default([]),
  stale: z.boolean().default(false),
  lastSyncedAt: z.string().datetime().optional()
});

// ── Creative Brief ──

// Story 1.4 结构 pattern（6 预铸骨架 + 空白起步）。归设定层（epics.md:358-362
// Story 2.4「情节结构 pattern」是核心设定字段），1.4 提前落 creative_brief。
// pattern 是作者显式选择（NewProjectDialog），非 intake 自由文本推断--选 pattern
// 起步 -> story-planner 按 PATTERN_SEEDS 注入 prompt 产初始主线 / 增量按生长规则加线。
// 6 pattern 骨架数据 + instantiatePattern 纯函数见 pattern-seeds.ts（co-located 纯数据）。
export const structurePatternSchema = z.enum([
  'anchor-single',        // 锚点单线
  'lotus-converging',     // 总分总莲花
  'main-sub-dual',        // 主副双线
  'progressive-jigsaw',   // 递进阶梯拼图
  'parallel-weak',        // 并列弱主线
  'triple-interactive',   // 三线交互
  'blank'                 // 空白起步（seed 不强制）
]);

export type StructurePattern = z.infer<typeof structurePatternSchema>;

export const creativeBriefSchema = z.object({
  genre: z.string().optional(),
  theme: z.string().optional(),
  tone: z.string().optional(),
  audience: z.string().optional(),
  length: z.string().optional(),
  // Story 1.4：作者选的结构 pattern（6 选 1 + blank）。optional 零 migration；
  // 缺省视同 blank（story-planner 无 pattern 注入，自由产）。
  structure_pattern: structurePatternSchema.optional(),
  taboos: z.array(z.string()).default([]),
  userConstraints: z.array(z.string()).default([]),
  rawRequirement: z.string(),
  // ── Story 2.4：顶层设定字段（零 migration additive optional）──
  // 既有 loose genre/audience/length 保留 back-compat；下列为结构化路由/检索/承诺字段。
  // 范式判据：字段路由/查询 = 纯代码；设定值判断 = LLM（2.5 GenreContract / Reader-Audit）。
  // genre_tags：flat 自由填 + 多值（题材方向/世界观/玩法/风格基调(爽文⭐)/叙事套路/角色处境/受众/篇幅），
  //   词表仅参考组织（POWER/题材词表）非 schema 结构。消费：2.5 GenreContract 路由 + query_craft + 2.3 cache 前缀。
  // CR-006：元素 .min(1) 拒空串 + .default([]) 一致性（与 shuangdian_preferences/commitments 对齐）。
  genre_tags: z.array(z.string().min(1)).default([]),
  // commitments：题材/叙事承诺（HE/CP/爽点底线/题材核心承诺）。消费：2.5 GenreContract。
  //   世界规则单源在 world_setting.world_constitution；commitments 引用（design §5）。
  // CR-006：type/content .min(1) 拒空 + .default([]) 一致性（optional→default，缺省 [] 非 undefined）。
  commitments: z.array(z.object({
    type: z.string().min(1),     // 承诺类别（自由值：HE/BE/CP/爽点底线/题材核心承诺…）
    content: z.string().min(1)   // 承诺内容
  })).default([]),
  // emotion_arc_template：流派情绪弧模板选择（自由填+词表）。下游 Epic 5.1 建完整 EmotionArc 结构。
  emotion_arc_template: z.string().optional(),
  // shuangdian_preferences：爽点类型子集。下游 D1 知识蒸馏 / 金手指卡 / GenreContract / Director。
  // CR-006：元素 .min(1) 拒空串 + .default([]) 一致性。
  shuangdian_preferences: z.array(z.string().min(1)).default([]),
  // power_system_type：力量体系范式（修炼/系统/网游/超能/无，自由值+词表先验 POWER_SYSTEM_TYPE_VOCAB）。
  //   下游 D5 力量体系 / 规则卡 / 路由。
  power_system_type: z.string().optional()
});

// ── Creative Preferences 创作深度偏好（Story 8.6 R3，design D3/D4）──
//
// 分项目的作者工作方式偏好（对话问清落盘，非表单——prd R3）。四轴逐域独立不搞总档（世界深 + 大纲轻的
// 作者真实存在——世界设定型灵感）；absent = 未问 = 标准档（fresh 项目不产假偏好，引导按标准档走，D4）。
// 分项目保存不跨项目搬移（用户拍板 P3：创作风格逐项目变，上次答案是污染源；跨项目记忆归作者档案沟通层，
// R4 红线不反哺）。与既有档位正交：participationGear（写作问什么/何时问）、behaviorMode/permissionMode
// （单轮风格/工具权限）互不替代（KD1 不加旋钮——偏好只调引导深度与提议时机，不 block 任何 readiness gate）。
//
// 存储：project.yaml 顶层 creative_preferences（project.ts additive optional 零 migration），进 creative
// field 体系（creativeFieldKeys/FIELD_TO_KEY/field_metadata 版本）——复用 onFieldEdited 落盘 + PatchReview
// 人审全套，零新通道。写通道 creative_preferences_update（bounded partial set，Step 2/3）。
//
// expected_downstream_consumers:
// - Story 8.6 R5：computePipelineStage.preferencesSet（pipeline-stage.ts——四轴至少一轴或 note 非空）。
// - Story 8.6 R6：雷达段 / 8.5 弧段按 arc_timing 等轴分档措辞（workflow.ts Step 4；缺省回退标准档 =
//   8.5 原行为零回归，design §6 兼容性）。
// - Story 8.6 R2/R3：creative_preferences_update handler（Step 2/3，partial merge mirror genreContract）。

/** 大纲细度轴（动笔前大纲铺到多细）：skeleton=骨架（只定主线与阶段，细节写时再长）/ volume=分卷（定卷级目标，章不预定）/ chapter=逐章（写前把章排细）。 */
export const outlineDepthAxisSchema = z.enum(['skeleton', 'volume', 'chapter']);
export type OutlineDepthAxis = z.infer<typeof outlineDepthAxisSchema>;

/** 弧线时序轴（角色成长弧什么时候列）：upfront=写前列（动笔前把弧设计完）/ as_you_go=边写边列（写若干章人物立起来后再列）。 */
export const arcTimingAxisSchema = z.enum(['upfront', 'as_you_go']);
export type ArcTimingAxis = z.infer<typeof arcTimingAxisSchema>;

/** 世界深度轴（世界设定铺多厚）：shell=空壳后填（最小世界起步，用到再补）/ upfront=先铺（动笔前铺到能支撑故事）。 */
export const worldDepthAxisSchema = z.enum(['shell', 'upfront']);
export type WorldDepthAxis = z.infer<typeof worldDepthAxisSchema>;

/** 人物深度轴（人物卡填多全）：framework=框架（核心欲望 + 身份框架，细节随写随长）/ full=全填（动笔前把人物卡填全）。 */
export const characterDepthAxisSchema = z.enum(['framework', 'full']);
export type CharacterDepthAxis = z.infer<typeof characterDepthAxisSchema>;

/** 创作深度偏好（四轴全 optional——absent=未问=标准档）+ 自由备注。单对象非数组（无 projector 需求，写通道走字段级 partial set）。
 *  CR-018（8.6 BMad CR）：note 长度上限 4000——与 agent 工具参数 schema 同步（LLM 失控超长直进 project.yaml）。 */
export const creativePreferencesSchema = z.object({
  outline_depth: outlineDepthAxisSchema.optional(),
  arc_timing: arcTimingAxisSchema.optional(),
  world_depth: worldDepthAxisSchema.optional(),
  character_depth: characterDepthAxisSchema.optional(),
  note: z.string().max(4000).optional()
});
export type CreativePreferences = z.infer<typeof creativePreferencesSchema>;

// ── World Setting 世设 ──

export const worldSettingSchema = z.object({
  premise: z.string().optional(),
  era: z.string().optional(),
  // Story 2.4：世界 impossible list（硬承诺）。消费：Reader-Audit 世界一致性 + 2.5 GenreContract。
  // vs 规则卡 rule：world_constitution 是 project-level 承诺「绝不X」；规则卡是「Y 如何运作」（design §4.5）。
  world_constitution: z.array(z.string()).optional(),
  /**
   * @deprecated Story 2.4：实体归并到地点卡（asset_cards type=location，design §6 D5 统一实体）。
   * 旧字段保留 back-compat（additive）；用户数据迁移工具后续（非 2.4 阻塞）。
   */
  locations: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional()
  })).default([]),
  /**
   * @deprecated Story 2.4：归并到规则卡（asset_cards type=rule）；world_setting 留 world_constitution。
   * 旧字段保留 back-compat（additive）。
   */
  rules: z.array(z.string()).default([]),
  /**
   * @deprecated Story 2.4：归并到组织卡（asset_cards type=organization）。旧字段保留 back-compat（additive）。
   */
  power_structures: z.array(z.string()).default([]),
  /**
   * @deprecated Story 2.4：归并到规则卡（asset_cards type=rule）。旧字段保留 back-compat（additive）。
   */
  taboos: z.array(z.string()).default([]),
  /**
   * @deprecated Story 2.4：归并到视觉母题卡（asset_cards type=visual_motif）。旧字段保留 back-compat（additive）。
   */
  visual_language: z.array(z.string()).default([]),
  tone_rules: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([])
});

// ── Outline Phase ──

export const outlinePhaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().optional(),
  antagonist: z.string().optional(),
  climax: z.string().optional(),
  hook: z.string().optional(),
  estimated_chapters: z.number().int().nonnegative().optional(),
});

// ── Major Turning Points 锚点（Story 1.2: 升级 string[] → typed 锚点）──
// 大纲层声明（序列级"这些是我的大交汇点"）；场景层实现见 SceneNode.role（1.1 已落）。
// 两层是因果树两粒度，sceneRef 链接按落地公理推迟到消费者（1.3 可达性用
// Line.convergence_target；Epic 3 锚点选址）。type 不含 normal——转折点恒为锚点。
export const majorTurningPointTypeSchema = z.enum([
  'core-anchor',
  'secondary-anchor',
  'fork-point'
]);

export const majorTurningPointSchema = z.object({
  type: majorTurningPointTypeSchema,
  label: z.string().min(1),
  description: z.string().optional()
});

// ── Outline V2 总大纲 ──

export const outlineV2Schema = z.object({
  story_type: z.string().optional(),
  writing_style: z.string().optional(),
  main_goal: z.string().optional(),
  phases: z.array(outlinePhaseSchema).default([]),
  central_conflict: z.string().optional(),
  major_turning_points: z.array(majorTurningPointSchema).default([]),
  ending_direction: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  characters: z.string().optional(),
  // Story 8.5（design D3 假字段重命名）：原 growth_curve / pacing_curve_text 是 OrisonSpace 遗留自由文本
  // 草稿位，与顶层结构化 creative field growth_curve / pacing_curve 同名不同物（interface-contracts 跨层
  // 命名规则1），UI OutlineEditor 编辑的是这个草稿位。改名消歧 + 保留草稿语义（notes 明示非结构化曲线
  // 数据）。旧键 loadProject 就地迁移在 Step 2（mirror foreshadow-migration）；迁移前旧键由 zod strip 容忍。
  arc_design_notes: z.string().optional(),
  pacing_design_notes: z.string().optional(),
});

// ── Episode Outlines 集纲 ──

export const episodeOutlineStatusSchema = z.enum(['planned', 'drafted', 'revised', 'locked']);

export const episodeOutlineSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  title: z.string().min(1),
  purpose: z.string().optional(),
  summary: z.string().optional(),
  core_event: z.string().optional(),
  character_progressions: z.array(z.object({
    characterId: z.string().min(1),
    from: z.string(),
    to: z.string()
  })).default([]),
  emotional_beats: z.array(z.string()).default([]),
  pacing_beats: z.array(z.string()).default([]),
  foreshadowing: z.array(z.string()).default([]),
  payoffs: z.array(z.string()).default([]),
  hook: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  // Story 8.5（design §3.1）：集纲→卷/phase 锚（ref outline_v2.phases[].id），mirror Line.phase_ref 先例。
  // additive optional → 零 migration（缺锚 = 未挂钩卷结构，不拒收——LLM 可能先排章后补 phase）。
  // 8.2 卷弧 arcRef 的 phases↔episode 锚补齐：chapter→episode→phase_ref 链纯代码可判「本章属哪卷」。
  phase_ref: z.string().min(1).optional(),
  status: episodeOutlineStatusSchema.default('planned')
});

export const episodeOutlinesSchema = z.array(episodeOutlineSchema);
export type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

// ── Episode bounded action + projector（Story 8.5 R2，mirror assetCardActionSchema / applyAssetCardActions）──
//
// episode_outlines 原零生产工具（8.5 research §3：全仓无写入路径，数据只能来自 legacy intake / 手编 yaml）。
// 8.5 建单一写通道两驱动（episode-planner agent 主产 + leader 对话直改，mirror scene_graph_update）：LLM 经
// episode_outlines_update 工具发 bounded action，shell handler 调本纯函数投影出 full array → field_patch
// envelope / autoApply 双档。projector 纯代码机械 by-id（ADR-3 ✓——集纲切分与 phase 挂钩是语义归 LLM，
// identity/内容投影归纯代码）；trust-boundary 校验在 handler（parse → project → projected 全量 safeParse
// episodeOutlinesSchema，mirror assetCardsHandlers）。
//
// index 冲突不机械改写（design §3.2）：index 是 LLM 排序决策（外键 index 无连续性契约，mirror
// interface-contracts「外键 index 不保证连续」），projector 只管 identity/内容——不 renumber、不去重 index。
const episodeUpdatePatchSchema = episodeOutlineSchema
  .partial()
  .omit({ id: true })
  .extend({
    // CR-Blind-F1（8.5 CR）：patch 语境 phase_ref 三态——undefined（未提供）= 不改（partial merge 保留旧锚）/
    // string = 挂/换锚 / null = **显式清除**（脱离卷；存储态 episodeOutlineSchema.phase_ref 不收 null，
    // projector update 分支把 null 折叠为删键，null 永不落盘）。.nullish() 对齐仓内先例（CR-002 nested
    // object / emotionPointSchema.sceneVad）；空串仍拒（.min(1)，锚要么有值要么明确清除）。
    phase_ref: z.string().min(1).nullish(),
  });

export const episodeActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_episode'), episode: episodeOutlineSchema }),
  z.object({ op: z.literal('update_episode'), episodeId: z.string().min(1), patch: episodeUpdatePatchSchema }),
  z.object({ op: z.literal('remove_episode'), episodeId: z.string().min(1) }),
]);
export type EpisodeAction = z.infer<typeof episodeActionSchema>;

/**
 * 把 bounded actions 投影到当前 episode_outlines → 新 full array。纯函数（无副作用，mirror applyAssetCardActions）。
 *
 * - add_episode：id 不存在 → 追加（episode 已过 episodeOutlineSchema，defaults 已填；phase_ref 维持
 *   optional 不收 null——add 是整集写入，无锚 = 缺省，null 清除语义只存在于 update patch）；id 已存在 →
 *   **跳过不覆盖**（防御 backstop，mirror add_card——handler 对重复 id 先友好报错，projector 永不静默替换）。
 * - update_episode：episodeId 存在 → 浅合并 patch（patch 经 omit 剥除 identity 键 id——identity 不可改，改身份
 *   走 remove_episode + add_episode，mirror promise update_beat E8；patch 可含 index——LLM 显式排序决策
 *   projector 忠实应用，但 projector 自身永不主动改写任何 index；patch.phase_ref null = 显式清除卷锚
 *   （CR-Blind-F1，折叠为删键不落盘），undefined = 不改）；不存在 → 幂等跳过。
 * - remove_episode：episodeId 存在 → 删；不存在 → 幂等跳过。删后不 reindex（index 冲突不机械改写）。
 *
 * 不做 schema re-parse（handler 侧 trust-boundary safeParse 全量再校验，mirror assetCardsHandlers）。
 */
export function applyEpisodeActions(
  current: EpisodeOutline[],
  actions: EpisodeAction[],
): EpisodeOutline[] {
  let episodes = [...current];
  for (const action of actions) {
    switch (action.op) {
      case 'add_episode': {
        const idx = episodes.findIndex((e) => e.id === action.episode.id);
        // 重复 id 跳过（不覆盖）——handler 在投影前已对重复 add_episode 友好报错，此处是不可达防御。
        if (idx === -1) episodes.push(action.episode);
        break;
      }
      case 'update_episode': {
        const idx = episodes.findIndex((e) => e.id === action.episodeId);
        if (idx !== -1) {
          // patch 已过 episodeUpdatePatchSchema（identity 键 id 被 omit strip），保留旧 id。
          // phase_ref 三态（CR-Blind-F1）：null = 显式清除（存储态不收 null → 折叠为删键）；
          // undefined（未提供）= 不改（键不在 restPatch，旧锚保留）；string = 挂/换锚。
          const { phase_ref: patchPhaseRef, ...restPatch } = action.patch;
          const merged: EpisodeOutline = { ...episodes[idx], ...restPatch, id: episodes[idx].id };
          if (patchPhaseRef === null) delete merged.phase_ref;
          else if (patchPhaseRef !== undefined) merged.phase_ref = patchPhaseRef;
          episodes[idx] = merged;
        }
        // episodeId 不存在 → 幂等跳过（mirror promise update_beat / assetCard update_card）。
        break;
      }
      case 'remove_episode': {
        episodes = episodes.filter((e) => e.id !== action.episodeId);
        break;
      }
    }
  }
  return episodes;
}

// ── Promise Ledger（Story 6.5：泛化 foreshadow_registry，从 perspective gap 涌现的读者债生命周期）──
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md，继承 6.1）：
// - 归 LLM：Promise 涌现登记（读 gap + 正文判读者债）+ 叙事工具命名（伏笔/戏剧反讽/悬念/误导）+
//   跨轴 fact join（哪两轴 path 是同一 fact）+ Promise 落地裁判（登记的 plant 是否正文真写）。
// - 归纯代码：派生态计算（derivedStage/beat.state 从 beats/Scene.status 算）+ PromiseBeat 幂等归并 +
//   bounded-action projector（applyPromiseActions）+ 数据迁移 transform（foreshadow-migration.ts）。
//
// Promise 天然跨双轨（NeuroBook PromiseBeat 的 planned/factual 双态，system.md:202）：目标轨 = Promise
// debt 本身 + planned beats（作者/Director 规划）；实际轨 = factual beats（Scene written 后 prose 实际发生）。
// 故 promise_registry 是 creative field（project.yaml，mirror foreshadow_registry + InfoReleaseMap sibling），
// 非 closure_* 派生表（design §5 方案 C）。
//
// 存储态仅 open/fulfilled/abandoned（作者意图）；中间态（planted/echoed/paid_off）从 beats 派生（消费时算，
// 结构不漂移，mirror NeuroBook system.md:204-209）。foreshadow 退化成 setup_payoff 子类（迁移见
// foreshadow-migration.ts：loadProject 就地迁移 transform，零删数据）。
//
// expected_downstream_consumers:
// - Story 6.5：promise-emergence-node 登记（实际轨驱动）+ brief #7 compilePromiseTasks（本章节拍）+
//   Reader-Audit promise-landing 维（落地检查）。
// - Story 6.3：Director 读 InfoReleaseMap 产 ManipulationDirective（sibling 目标轨协调）。
// - Story 4.4：query_promise builtin 消费 Promise 兑现状态（cross-arc 完整性）。
// - Story 8.1：promise_registry snapshot（ChapterStateSummary 物化未决 Promise 清单）。

/** Promise 存储态（作者意图，mirror NeuroBook system.md:73 三态）。中间态不进存储（派生）。 */
export const promiseStatusSchema = z.enum(['open', 'fulfilled', 'abandoned']);
export type PromiseStatus = z.infer<typeof promiseStatusSchema>;

/**
 * Promise 派生阶段（从有效 beats 派生，**不存**——消费时 derivePromiseStage 算）。
 * mirror NeuroBook system.md:206：有 payoff=paid_off / 有 advance|setback=echoed / 有 plant=planted / 否则 unplanted。
 */
export const promiseDerivedStageSchema = z.enum(['unplanted', 'planted', 'echoed', 'paid_off']);
export type PromiseDerivedStage = z.infer<typeof promiseDerivedStageSchema>;

/**
 * Promise 分类词表（先验非门禁，开放 z.string，mirror narrative-enums / POWER_SYSTEM_TYPE_VOCAB 哲学）。
 * 注入 promise-emergence-agent prompt / UI 补全 chips（非下拉单选）。用户/LLM 可写词表外值（零 migration）。
 * foreshadow 迁移时 category='setup_payoff'（foreshadow 是 setup_payoff 子类，epics.md:599）。
 */
export const PROMISE_CATEGORY_VOCAB = [
  { value: 'setup_payoff', gloss: '契诃夫之枪。具体元素、因果回收、单点触发，公平性最严（必有 plant）' },
  { value: 'prophecy', gloss: '预言/悬念。明确断言，字面或反讽式兑现' },
  { value: 'motif', gloss: '象征/母题。意象重复、累积式兑现，不要求单点触发' },
  { value: 'mirror', gloss: '镜像/平行。两条以上线索互相映照' },
] as const;

/** PromiseBeat kind（mirror NeuroBook system.md:201：plant 建立 / advance 推进 / setback 反挫 / payoff 兑现）。 */
export const promiseBeatKindSchema = z.enum(['plant', 'advance', 'setback', 'payoff']);
export type PromiseBeatKind = z.infer<typeof promiseBeatKindSchema>;

/**
 * PromiseBeat 派生 state（从 Scene.status 派生，**不存**——消费时 deriveBeatState 算）。
 * mirror NeuroBook system.md:202：Scene draft/active=planned / written/revised=factual / archived=archived。
 */
export const promiseBeatStateSchema = z.enum(['planned', 'factual', 'archived']);
export type PromiseBeatState = z.infer<typeof promiseBeatStateSchema>;

/**
 * Promise 主体（mirror 既有 foreshadowEntrySchema 字段集 + NeuroBook Promise 字段，design §2）。
 * 挂 creative field（project.yaml promise_registry），跨双轨（debt 本身 + planned beats 目标轨 / factual beats 实际轨）。
 */
export const promiseEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  /** 向读者许了什么（NeuroBook 三层分工之一：账本列表/规划上下文展示）。 */
  summary: z.string().min(1),
  /** 兑现时预期的戏剧效果（只给兑现场的 writer，NeuroBook 三层之二）。 */
  payoffExpectation: z.string().optional(),
  /** 存储态（作者意图）。fulfilled/abandoned 是终态；派生阶段（planted/echoed/paid_off）不存。 */
  status: promiseStatusSchema.default('open'),
  importance: z.number().min(0).max(1).default(0.5),
  /** 分类（词表先验 PROMISE_CATEGORY_VOCAB，非封闭 enum——避假信心门，mirror narrative-enums 哲学）。 */
  category: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  /**
   * 跨轴 fact 归并锚（DW-6 design §4）：LLM 涌现登记跨轴 join 后赋的稳定锚（非全局 fact id 注册表）。
   * 同 factKey 的 Promise 视为同一读者债的跨轴表现。optional——单轴 Promise 无需。
   */
  factKey: z.string().min(1).optional(),
  /** 提示性参考节奏（非硬约束，mirror NeuroBook system.md:184 字段有无驱动形态）。 */
  cadenceChapters: z.number().int().positive().optional(),
  /** 逾期概念 episode（有此字段才有，mirror NeuroBook deadlineChapterId）。 */
  deadlineEpisodeId: z.string().min(1).optional(),
  source_type: z.enum(['emergent', 'manual', 'agent', 'imported', 'migrated_foreshadow']).default('emergent'),
  related_asset_ids: z.array(z.string().min(1)).default([]),
  related_promise_ids: z.array(z.string().min(1)).default([]),
  notes: z.string().optional(),
  /** payoff beat 时是否自动置 fulfilled（mirror NeuroBook autoFulfill system.md:207，里程碑式兑现后线仍延续可关）。 */
  autoFulfill: z.boolean().default(true),
  sourceRefs: z.array(z.string().min(1)).default([]),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});
export type PromiseEntry = z.infer<typeof promiseEntrySchema>;

/**
 * PromiseBeat（mirror NeuroBook system.md:197-209）：挂 Scene 不挂 Chapter（埋/呼/收发生在具体一场戏里）。
 * 幂等：同 Scene 对同 Promise 只一 beat（system.md:199），重复 set 覆盖 kind/note（applyPromiseActions 处理）。
 */
export const promiseBeatSchema = z.object({
  id: z.string().min(1),
  promiseId: z.string().min(1),
  /** → SceneNode.id（挂场景，mirror InfoRelease sceneRef + 既有 *_ref 约定）。 */
  sceneRef: z.string().min(1),
  episodeId: z.string().min(1).optional(),
  kind: promiseBeatKindSchema,
  /** 单次推进的具体指示（只给该场 writer，NeuroBook 三层之三）。 */
  note: z.string().optional(),
  /** 触发此 beat 的 PerspectiveGap 摘要（{factPath, divergences[]}，审计用）。 */
  emergedFromGap: z.record(z.string(), z.unknown()).optional(),
  /** 正文原文锚定（审计/Reader-Audit grounding 复用）。 */
  grounding: z.string().optional(),
  created_at: z.string().datetime().optional(),
});
export type PromiseBeat = z.infer<typeof promiseBeatSchema>;

/** Promise registry（mirror InfoReleaseMap registry：promises + beats flat + version + updatedBy）。 */
export const promiseRegistrySchema = z.object({
  promises: z.array(promiseEntrySchema).default([]),
  beats: z.array(promiseBeatSchema).default([]),
  version: z.number().int().nonnegative().default(0),
  updatedBy: z.enum(['user', 'agent', 'sync']).default('agent'),
});
export type PromiseRegistry = z.infer<typeof promiseRegistrySchema>;

// ── Promise 派生纯函数（消费时算，结构不漂移，mirror NeuroBook）──
//
// 范式判据：派生态计算 = 纯代码（结构查询 over beats/Scene.status），非语义。不判「这段 plant 好不好」（归 LLM）。

/**
 * 从 Promise 的有效 beats 派生阶段（unplanted/planted/echoed/paid_off）。纯函数，非语义。
 * mirror NeuroBook system.md:206：有 payoff=paid_off / 有 advance|setback=echoed / 有 plant=planted / 否则 unplanted。
 *
 * @param promise  目标 Promise（取 id 过滤 beats）。
 * @param beats    全量 beats（函数按 promise.id 过滤；archived 场过滤归调用方——先用 deriveBeatState 判）。
 */
export function derivePromiseStage(promise: PromiseEntry, beats: readonly PromiseBeat[]): PromiseDerivedStage {
  const own = beats.filter((b) => b.promiseId === promise.id);
  if (own.some((b) => b.kind === 'payoff')) return 'paid_off';
  if (own.some((b) => b.kind === 'advance' || b.kind === 'setback')) return 'echoed';
  if (own.some((b) => b.kind === 'plant')) return 'planted';
  return 'unplanted';
}

/**
 * 从 Scene.status 派生 beat state（planned/factual/archived）。纯函数，非语义。
 * mirror NeuroBook system.md:202：draft/active=planned / written/revised=factual / archived=archived。
 *
 * @param sceneStatus  beat 所在 Scene 的 status（NeuroBook scene status 字符串；undefined/未知 → planned）。
 */
export function deriveBeatState(sceneStatus: string | undefined): PromiseBeatState {
  if (sceneStatus === 'archived') return 'archived';
  if (sceneStatus === 'written' || sceneStatus === 'revised') return 'factual';
  return 'planned';
}

/**
 * 根据 beats 解析 Promise 存储态（autoFulfill 自动置 fulfilled / 删 payoff 回退 open）。纯函数。
 * mirror NeuroBook system.md:207-208。abandoned 是作者意图终态，永不自动改；autoFulfill=false 不自动改（手管）。
 *
 * @param promise  目标 Promise（取 autoFulfill + status + id）。
 * @param beats    全量 beats（函数按 promise.id 过滤有效 payoff）。传**已按 promiseId 预过滤的子集**亦等价
 *                 （内部过滤对纯 own 集恒等）——per-promise 循环消费方（如 collectPromiseCandidates，8.3 S5）
 *                 传 groupBy 预索引可免 O(P×B) 全扫；散调用传全量无妨。
 * @returns        解析后应有的 status（调用方据此 sync 存储态）。
 */
export function resolvePromiseFulfillment(
  promise: PromiseEntry,
  beats: readonly PromiseBeat[],
): PromiseStatus {
  if (promise.status === 'abandoned') return 'abandoned';
  if (!promise.autoFulfill) return promise.status;
  const hasEffectivePayoff = beats.some((b) => b.promiseId === promise.id && b.kind === 'payoff');
  if (hasEffectivePayoff) return 'fulfilled';
  // E10：迁移期 Promise（source_type==='migrated_foreshadow'）保留迁移时 status——foreshadow 可能只记
  // status 未记 resolve_ref（legacy 数据限制），迁移时无 payoff beat 是数据缺失而非运行时 payoff 被删，
  // 故不 auto-rollback（避免撤销迁移 status）。运行时 payoff 被删的回退仍对非迁移 Promise 生效。
  if (promise.source_type === 'migrated_foreshadow') return promise.status;
  if (promise.status === 'fulfilled') return 'open'; // payoff 被删 → 回退 open（system.md:208）
  return promise.status;
}

// ── Promise bounded action + projector（mirror infoReleaseActionSchema / applyInfoReleaseActions）──
//
// LLM 经 promise_ledger_update 工具发 bounded action，handler 调本纯函数投影出 full map → field_patch envelope
// （action:'set'）→ UI patch-review → fieldSyncBridge 落盘。projector 纯代码机械（ADR-3 ✓）；trust-boundary
// 校验在 handler（schema parse + projected safeParse）。
//
// add_promise 用 promiseEntryWriteSchema（id 必填，defaulted 字段 optional 不填 default）——mirror infoRelease
// add_entry（entry.id 必填）：Promise id 是语义决策（LLM 判定哪条 gap 构成新 Promise 并命名），非机械生成。
// projector 对新 Promise（idx<0）走 promiseEntrySchema.parse 填 defaults；对现已有 Promise（idx>=0）做 partial
// merge（raw action.promise 不填 defaults，B1/E2/A6）。beat id 可缺——projector 按 (promiseId, sceneRef) 自然键
// 生成（确定性，无需 crypto）。

/**
 * Promise 写入 shape（add_promise.promise 输入）。required id/title/summary + 既有 defaulted 字段全 optional
 * （不填 default——与 promiseEntrySchema 输出区分，后者 defaults 已填为 required）。
 *
 * B1/E2/A6：add_promise 对现已有 ID 用 partial merge——只合并 action.promise **显式提供**的字段，不填 defaults
 * 覆盖真实字段（避免 status:'fulfilled'/'abandoned' 回退 default 'open'、tags 被 [] 覆盖、importance 被 0.5
 * 覆盖、autoFulfill 被 true 覆盖等）。故 add_promise.promise 走此 schema（defaulted 字段 optional 不填 default），
 * projector idx>=0 分支据此做 partial merge；新 Promise（idx<0）仍走 promiseEntrySchema.parse 填 defaults。
 */
const promiseEntryWriteSchema = promiseEntrySchema
  .omit({
    status: true,
    importance: true,
    tags: true,
    source_type: true,
    related_asset_ids: true,
    related_promise_ids: true,
    autoFulfill: true,
    sourceRefs: true,
  })
  .extend({
    status: promiseStatusSchema.optional(),
    importance: z.number().min(0).max(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    source_type: z
      .enum(['emergent', 'manual', 'agent', 'imported', 'migrated_foreshadow'])
      .optional(),
    related_asset_ids: z.array(z.string().min(1)).optional(),
    related_promise_ids: z.array(z.string().min(1)).optional(),
    autoFulfill: z.boolean().optional(),
    sourceRefs: z.array(z.string().min(1)).optional(),
  });

/** PromiseBeat 写入 shape（add_beat 用：id 可缺，projector 按 (promiseId, sceneRef) 自然键生成；promiseId 必填）。 */
const promiseBeatWriteSchema = promiseBeatSchema.partial({ id: true });

/**
 * PromiseBeat firstBeat 写入 shape（add_promise.firstBeat 用）。
 * E7：firstBeat 在 add_promise 内，promiseId 冗余（projector 用外层 promise.id 覆盖），故 promiseId optional——
 * LLM 省略 promiseId 时不应因 firstBeat 拒整个 add_promise（含新 promise），否则静默丢整条 action。
 * normalizeBeat 接收时外层无条件注入 promise.id（见 applyPromiseActions add_promise 分支）。
 */
const promiseFirstBeatWriteSchema = promiseBeatSchema.partial({ id: true, promiseId: true });

/**
 * update_beat patch shape。E8：剥除 identity 字段（id/promiseId/sceneRef 不可变——beat 身份由自然键定义）。
 * 改 identity 应走 remove_beat + add_beat（自然键变更）。LLM 若在 patch 传 identity 字段，schema 经 omit strip
 * 忽略（projector 浅合并不会覆盖 identity），beat 的 promiseId/sceneRef/id 保持不变。
 */
const updateBeatPatchSchema = promiseBeatSchema
  .partial()
  .omit({ id: true, promiseId: true, sceneRef: true });

export const promiseActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_promise'),
    promise: promiseEntryWriteSchema,
    firstBeat: promiseFirstBeatWriteSchema.optional(),
  }),
  z.object({
    type: z.literal('add_beat'),
    beat: promiseBeatWriteSchema,
  }),
  z.object({
    type: z.literal('update_beat'),
    beatId: z.string().min(1),
    patch: updateBeatPatchSchema,
  }),
  z.object({
    type: z.literal('remove_promise'),
    promiseId: z.string().min(1),
  }),
  z.object({
    type: z.literal('remove_beat'),
    beatId: z.string().min(1),
  }),
]);
export type PromiseAction = z.infer<typeof promiseActionSchema>;
/**
 * PromiseAction 输入类型（defaulted 字段可缺——applyPromiseActions 接受此类型，内部 parse 归一应用 defaults）。
 * 调用方（handler / 测试）可传带缺省 defaulted 字段的 action；projector 是归一化 + 投影的单点。
 */
export type PromiseActionInput = z.input<typeof promiseActionSchema>;

/**
 * 把 bounded actions 投影到当前 PromiseRegistry → 新 full map。纯函数（无副作用，mirror applyInfoReleaseActions）。
 *
 * 接受 `PromiseActionInput`（defaulted 字段可缺）——projector 内部 parse 归一（应用 defaults + beat id 自然键生成），
 * 是归一化 + 投影的单点。调用方可传 raw action（handler 信任边界 parse 后，或直接 LLM output 形态）。
 *
 * - add_promise：id 不存在 → 追加（parse 填 defaults）；id 已存在 → **partial merge**（只合并显式提供字段，
 *   不填 defaults 覆盖真实字段，B1/E2/A6）。firstBeat 可选（同 add_beat 幂等语义；firstBeat.promiseId 冗余，
 *   外层用 promise.id 覆盖，E7）。
 * - add_beat：幂等——同 (promiseId, sceneRef) 一 beat（system.md:199），重复 set 覆盖 kind/note，保留既有 id。
 * - update_beat：beatId 存在 → 浅合并 patch（保留 id；patch 经 omit 剥除 identity 字段 id/promiseId/sceneRef，
 *   E8——identity 不可改，改 identity 走 remove_beat + add_beat）；不存在 → 幂等跳过。
 * - remove_promise：删 Promise + 其所有 beats（级联，beat 无 Promise 则悬空）。
 * - remove_beat：beatId 存在 → 删；不存在 → 幂等跳过。
 *
 * 应用全部 actions 后，对所有非 abandoned Promise 调 resolvePromiseFulfillment sync 存储态与 beats
 * （B2/E4/A3：wire autoFulfill——有 payoff → fulfilled / payoff 删 → 回退 open，mirror NeuroBook system.md:207-208）。
 *
 * version/updatedBy 由 fieldSyncBridge.onFieldEdited 落盘时 bump（非 projector 职责），projector 只管 promises/beats。
 */
export function applyPromiseActions(
  current: PromiseRegistry,
  actions: PromiseActionInput[],
): PromiseRegistry {
  let promises = [...current.promises];
  let beats = [...current.beats];

  for (const action of actions) {
    switch (action.type) {
      case 'add_promise': {
        const promiseId = action.promise.id;
        const idx = promises.findIndex((p) => p.id === promiseId);
        if (idx < 0) {
          // 新 Promise：promiseEntrySchema.parse 填 defaults（tags/importance/status/source_type 等）。
          promises.push(promiseEntrySchema.parse(action.promise));
        } else {
          // 现已有 Promise：partial merge——只合并 action.promise 显式提供的字段，不填 defaults 覆盖真实字段
          // （B1/E2/A6：避免 status:'fulfilled' 回退 'open'、tags 被 [] / importance 被 0.5 / autoFulfill 被
          // true 覆盖）。action.promise 经 promiseEntryWriteSchema（defaulted 字段 optional 不填 default），
          // 故仅含 LLM 显式提供的键；merged 以 promises[idx]（完整 PromiseEntry）为基底 + action.promise 覆盖，
          // 再过 promiseEntrySchema.parse 归一为 PromiseEntry（无缺字段 → parse 不填 defaults → 保留真实值）。
          promises[idx] = promiseEntrySchema.parse({ ...promises[idx], ...action.promise });
        }
        if (action.firstBeat) {
          // firstBeat.promiseId 冗余——外层无条件用 promise.id 覆盖（E7：promiseId optional in firstBeat schema）。
          const beat = normalizeBeat({ ...action.firstBeat, promiseId: promiseId });
          beats = upsertBeat(beats, beat);
        }
        break;
      }
      case 'add_beat': {
        const beat = normalizeBeat(action.beat);
        beats = upsertBeat(beats, beat);
        break;
      }
      case 'update_beat': {
        const idx = beats.findIndex((b) => b.id === action.beatId);
        if (idx >= 0) {
          // patch 已过 updateBeatPatchSchema（identity 字段 id/promiseId/sceneRef 被 omit strip，E8），保留旧 id。
          beats[idx] = { ...beats[idx], ...action.patch, id: beats[idx].id };
        }
        // beatId 不存在 → 幂等跳过（mirror applyInfoReleaseActions remove_entry idempotency）。
        break;
      }
      case 'remove_promise': {
        promises = promises.filter((p) => p.id !== action.promiseId);
        beats = beats.filter((b) => b.promiseId !== action.promiseId);
        break;
      }
      case 'remove_beat': {
        beats = beats.filter((b) => b.id !== action.beatId);
        break;
      }
    }
  }

  // B2/E4/A3：wire resolvePromiseFulfillment——应用 actions 后 sync Promise 存储态与 beats（autoFulfill 自动维护）。
  // mirror NeuroBook system.md:207-208：有有效 payoff beat + autoFulfill → fulfilled；payoff 被删 → 回退 open。
  // abandoned 永不自动改（作者意图终态，double guard 兜底）；迁移期 Promise 无 payoff 不 auto-rollback（E10）。
  // 纯函数状态机派生（creative-vs-mechanical ✓），非语义判断。
  const syncedPromises = promises.map((p) => {
    if (p.status === 'abandoned') return p;
    const ownBeats = beats.filter((b) => b.promiseId === p.id);
    const resolved = resolvePromiseFulfillment(p, ownBeats);
    return resolved === p.status ? p : { ...p, status: resolved };
  });

  return { ...current, promises: syncedPromises, beats };
}

/**
 * beat 写入归一：id 缺失时按自然键 `${promiseId}::${sceneRef}` 生成（确定性 + 稳定跨 kind 变更）。
 * promiseId/sceneRef 是 promiseBeatSchema 必填字段（.partial({id:true}) 仅松 id），故自然键恒可算。
 */
function normalizeBeat(input: z.input<typeof promiseBeatWriteSchema>): PromiseBeat {
  const id = input.id ?? `${input.promiseId}::${input.sceneRef}`;
  return promiseBeatSchema.parse({ ...input, id });
}

/**
 * beat upsert（幂等）：按 id OR (promiseId, sceneRef) 自然键找既有 beat；找到 → 覆盖 kind/note 等保留既有 id；
 * 未找到 → 追加。mirror NeuroBook system.md:199（同 Scene+Promise 一 beat）。
 */
function upsertBeat(beats: PromiseBeat[], beat: PromiseBeat): PromiseBeat[] {
  const idx = beats.findIndex(
    (b) => b.id === beat.id || (b.promiseId === beat.promiseId && b.sceneRef === beat.sceneRef),
  );
  if (idx >= 0) {
    return beats.map((b, i) => (i === idx ? { ...beat, id: b.id } : b));
  }
  return [...beats, beat];
}

// ── InfoReleaseMap（Story 6.1：信息释放计划，目标轨 creative field）──
//
// 作者意图侧前置计划（conclusions §3.1「前置计划：打算怎么写」）：per-scene reveal/withhold/dramaticIrony
// 计划，作 codify 状态挂场景（mirror promise_registry beat sceneRef 挂载先例——sibling 目标轨 creative field）。
// 落 project.yaml（source of truth，ADR-1），非 closure_* 派生表（6.6 双轨：目标轨原样不投影，world-state.ts:5-10）。
//
// LLM 写入并对它负责（AC「LLM 写入并对它负责」）：经 info_release_map_update bounded action 工具 → field_patch
// → fieldSyncBridge。Epic 3 工作台（done）即 authoring 面（direction-first → leader 调工具写），故 6.1 完成
// 时即可被人经工作台填，不依赖 Director（Director 自动 authoring 归 6.3，deferred-work DW-3/4）。
//
// 与 promise_registry beat 共享 sceneRef 挂载约定（sibling 目标轨 creative field）。
//
// 下游消费：6.3 Director 读 InfoReleaseMap → 产 ManipulationDirective → brief #3 信息控制（readerKnows/
// protagonistKnows/mustHide/hintOnly，chapter-brief.ts:142-145）。ManipulationDirective shape 见下方。

/** 信息操控模式（epics.md:585 mode：信息前置/悬疑未知/方法预期/主观误导）。 */
export const manipulationModeSchema = z.enum([
  'reveal_first', // 信息前置（读者先知 / 提前透露）
  'sustain_unknown', // 悬疑未知（维持未知）
  'method_foreseen', // 方法预期（读者知方法待结果）
  'subjective_mislead', // 主观误导（引导误判）
]);
export type ManipulationMode = z.infer<typeof manipulationModeSchema>;

/** 信息操控动作（epics.md:585 plant/withhold/release/dramaticIrony）。 */
export const manipulationActionSchema = z.enum(['plant', 'withhold', 'release', 'dramatic_irony']);
export type ManipulationAction = z.infer<typeof manipulationActionSchema>;

/**
 * ManipulationDirective（6.3 Director 产、喂 Writer pinned context 的 per-scene 信息操控指令 shape）。
 *
 * 6.1 只定义 shape（InfoReleaseMap.entry.directive 可选承载）；6.3 Director 接线生成 + 注入 brief #3。
 * forbiddenMoves 非空 → 6.3 触发 L2 真评判（epics.md:586）。
 */
export const manipulationDirectiveSchema = z.object({
  mode: manipulationModeSchema,
  actions: z.array(manipulationActionSchema).min(1),
  forbiddenMoves: z.array(z.string()).optional(),
  target: z.string().optional(), // 被操控的信息/事实标识（可 ref subject 或自由描述）
});
export type ManipulationDirective = z.infer<typeof manipulationDirectiveSchema>;

/**
 * InfoReleaseMap 条目（per-scene 作者意图计划）。sceneRef 挂场景（→ SceneNode.id，mirror sibling creative field *_ref 约定）。
 * reveal/withhold/dramaticIrony 是本场计划透露/隐瞒/戏剧反讽的内容（自由 string 数组，语义由作者/Director 定）。
 */
export const infoReleaseEntrySchema = z.object({
  id: z.string().min(1),
  sceneRef: z.string().min(1), // → SceneNode.id（挂场景，sibling promise beat sceneRef 先例）
  episodeId: z.string().optional(), // 可选 episode 归属（便利 filter）
  reveal: z.array(z.string()).optional(), // 本场计划透露什么
  withhold: z.array(z.string()).optional(), // 本场计划隐瞒什么
  dramaticIrony: z.array(z.string()).optional(), // 本场戏剧反讽安排
  directive: manipulationDirectiveSchema.optional(), // 6.3 Director 消费的指令 shape
  notes: z.string().optional(),
});
export type InfoReleaseEntry = z.infer<typeof infoReleaseEntrySchema>;

/** InfoReleaseMap registry（mirror promiseRegistrySchema：entries + version + updatedBy）。 */
export const infoReleaseMapSchema = z.object({
  entries: z.array(infoReleaseEntrySchema).default([]),
  version: z.number().int().nonnegative().default(0),
  updatedBy: z.enum(['user', 'agent', 'sync']).default('agent'),
});
export type InfoReleaseMap = z.infer<typeof infoReleaseMapSchema>;

// ── InfoReleaseMap bounded action + projector（mirror sceneGraphActionSchema / applySceneGraphActions）──
//
// LLM 经 info_release_map_update 工具发 bounded action（add/update/remove entry），handler 调本纯函数投影
// 出 full map → field_patch envelope（action:'set'）→ UI patch-review → fieldSyncBridge 落盘。projector 纯代码
// 机械 by-id（ADR-3 ✓，非语义裁判）；trust-boundary 校验在 handler（schema parse + safeParse projected）。

export const infoReleaseActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_entry'), entry: infoReleaseEntrySchema }),
  z.object({ op: z.literal('update_entry'), entry: infoReleaseEntrySchema }),
  z.object({ op: z.literal('remove_entry'), entryId: z.string().min(1) }),
]);
export type InfoReleaseAction = z.infer<typeof infoReleaseActionSchema>;

/**
 * 把 bounded actions 投影到当前 InfoReleaseMap → 新 full map。纯函数（无副作用，mirror applySceneGraphActions）。
 *
 * - add_entry：id 已存在 → 覆盖该 entry（幂等）；id 不存在 → 追加。
 * - update_entry：id 已存在 → 覆盖；不存在 → 追加（同 add，容错——LLM 可能误判存在性）。
 * - remove_entry：id 存在 → 删；不存在 → 幂等跳过。
 *
 * version/updatedBy 由 fieldSyncBridge.onFieldEdited 落盘时 bump（非 projector 职责），projector 只管 entries。
 */
export function applyInfoReleaseActions(
  current: InfoReleaseMap,
  actions: InfoReleaseAction[],
): InfoReleaseMap {
  const entries = [...current.entries];
  for (const action of actions) {
    if (action.op === 'remove_entry') {
      const idx = entries.findIndex((e) => e.id === action.entryId);
      if (idx >= 0) entries.splice(idx, 1);
      continue;
    }
    // add_entry / update_entry：按 id 覆盖或追加。
    const idx = entries.findIndex((e) => e.id === action.entry.id);
    if (idx >= 0) entries[idx] = action.entry;
    else entries.push(action.entry);
  }
  return { ...current, entries };
}

// ── Growth Curve 成长曲线（Story 8.5 角色弧生产线：array canonical + bounded action 写通道）──
//
// 卡/弧分工（design D4 / asset-card-model spec）：卡存静态身份（story-start 快照），弧演变归本 field。
// 生产入口 = leader 对话（弧内容是语义创作判断归 LLM——「角色的 wound 是什么」= 创作意图，ADR-3 范式
// 判据）；落盘 = 本处 bounded action + 纯代码 projector（mirror applyAssetCardActions / applyEmotionCurveActions
// 家族）。消费端：4.4 completeness arc 候选（readGrowthCurves 单源，arc-coverage.ts）/ 8.5 brief
// characterProgressions 编译 / 8.2 弧审 character-arc 维设计侧对照。
//
// expected_downstream_consumers:
// - Story 8.5 R1：growth_curve_update 工具（shell handler + agent builtin + ui WRITE_TOOLS 三处同步）。
// - Story 8.5 R4：findArcCoverageGaps（arc-coverage.ts）leader 三态注入段。
// - Story 4.4 / 8.2 既有读端（readGrowthCurves 归一，零破坏）。

export const growthCurvePointSchema = z.object({
  turning_point: z.string(),
  linked_episode_ids: z.array(z.string()).default([])
});

export const growthCurveSchema = z.object({
  character_id: z.string().min(1),
  start_state: z.string(),
  wound_or_lack: z.string().optional(),
  desire: z.string().optional(),
  need: z.string().optional(),
  turning_points: z.array(growthCurvePointSchema).default([]),
  regressions: z.array(z.string()).default([]),
  end_state: z.string().optional(),
  linked_episode_ids: z.array(z.string()).default([])
});
export type GrowthCurve = z.infer<typeof growthCurveSchema>;

// 顶层存储形态（design D2）：array canonical——多角色弧是本体论事实（一部小说 N 个 S 级人物 = N 条弧；
// episode_outlines / asset_cards 同族皆 array）。宽容读 union：旧 yaml 单条（fork 初始 schema 声明）与
// Record<character_id, curve>（历史宽容读容忍形态）不丢，parse 后恒归一为 array（canonical 写）。
// 注：本 schema 是存储契约（条目严格按 growthCurveSchema 校验）；防御性「坏条目跳过」的宽容读归
// readGrowthCurves（arc-coverage.ts，4.4/引导段消费），两层语义不同不混。
export const growthCurveFieldSchema = z.union([
  // canonical 写形态（8.5 起恒 array）。
  z.array(growthCurveSchema),
  // 旧 yaml 单条形态 → 包成数组。
  growthCurveSchema.transform((single) => [single]),
  // Record 形态：值缺 character_id 时用 key 补（值内自带 character_id 优先，key 只补缺）。
  z.record(z.string().min(1), growthCurveSchema.partial({ character_id: true })).transform((record) =>
    Object.entries(record).map(([key, value]) =>
      growthCurveSchema.parse({ ...value, character_id: value.character_id ?? key }),
    ),
  ),
]);

/**
 * GrowthCurve 写入 shape（add_curve.curve 输入）。required character_id + start_state + 既有 defaulted 字段
 * 全 optional 不填 default（与 growthCurveSchema 输出区分，后者 defaults 已填）。
 *
 * B1 教训（mirror promiseEntryWriteSchema）：add_curve 对已存在 character_id 走 partial merge——只合并
 * action.curve **显式提供**的字段，不填 defaults 覆盖真实字段（避免既有 turning_points/regressions/
 * linked_episode_ids 被空 default 覆盖）。故 curve 走此 schema（defaulted 字段 optional 不填 default），
 * projector 据此做 partial merge；新角色（idx<0）仍走 growthCurveSchema.parse 填 defaults。
 */
export const growthCurveWriteSchema = growthCurveSchema
  .omit({ turning_points: true, regressions: true, linked_episode_ids: true })
  .extend({
    turning_points: z.array(growthCurvePointSchema).optional(),
    regressions: z.array(z.string()).optional(),
    linked_episode_ids: z.array(z.string()).optional(),
  });
export type GrowthCurveWrite = z.infer<typeof growthCurveWriteSchema>;

/**
 * update_curve patch shape。identity 键 character_id 剥除（omit strip，不可改——弧身份由角色定义，改身份走
 * remove_curve + add_curve，mirror promise update_beat E8）；start_state 在 patch 语境降 optional（partial
 * merge——可能只改 desire 不动起点）。
 */
const growthCurveUpdatePatchSchema = growthCurveWriteSchema
  .omit({ character_id: true })
  .extend({ start_state: z.string().optional() });

export const growthCurveActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_curve'), curve: growthCurveWriteSchema }),
  z.object({ op: z.literal('update_curve'), character_id: z.string().min(1), patch: growthCurveUpdatePatchSchema }),
  z.object({ op: z.literal('remove_curve'), character_id: z.string().min(1) }),
]);
export type GrowthCurveAction = z.infer<typeof growthCurveActionSchema>;

/**
 * 把 bounded actions 投影到当前 growth_curve[] → 新 full array。纯函数（无副作用，mirror applyAssetCardActions）。
 *
 * - add_curve：character_id 不存在 → 追加（growthCurveSchema.parse 填 defaults）；已存在 → **partial merge**
 *   （只合并 action.curve 显式提供的字段，不填 defaults 覆盖真实字段，B1——curve 经 growthCurveWriteSchema
 *   仅含显式提供的键；merged 以既有完整 GrowthCurve 为基底再 parse 归一，无缺字段则不填 defaults）。
 * - update_curve：character_id 存在 → 浅合并 patch（patch 经 omit 剥除 identity 键 character_id，保留旧值）；
 *   不存在 → 幂等跳过（mirror promise update_beat / assetCard update_card）。
 * - remove_curve：character_id 存在 → 删；不存在 → 幂等跳过。
 *
 * 不做 schema re-parse 全量校验（handler 侧 trust-boundary safeParse，mirror assetCardsHandlers）；merged /
 * appended 单条过 growthCurveSchema.parse 是归一化单点（应用 defaults）。
 */
export function applyGrowthCurveActions(
  current: GrowthCurve[],
  actions: GrowthCurveAction[],
): GrowthCurve[] {
  let curves = [...current];
  for (const action of actions) {
    switch (action.op) {
      case 'add_curve': {
        const idx = curves.findIndex((c) => c.character_id === action.curve.character_id);
        if (idx < 0) {
          // 新角色弧：growthCurveSchema.parse 填 defaults（turning_points/regressions/linked_episode_ids）。
          curves.push(growthCurveSchema.parse(action.curve));
        } else {
          // 已有角色弧：partial merge——action.curve 经 growthCurveWriteSchema（defaulted 字段 optional
          // 不填 default）故仅含显式提供的键；merged 以既有完整 GrowthCurve 为基底 + 显式键覆盖，再 parse
          // 归一（无缺字段 → 不填 defaults → 保留真实值，B1）。
          curves[idx] = growthCurveSchema.parse({ ...curves[idx], ...action.curve });
        }
        break;
      }
      case 'update_curve': {
        const idx = curves.findIndex((c) => c.character_id === action.character_id);
        if (idx !== -1) {
          // patch 已过 growthCurveUpdatePatchSchema（identity 键 character_id 被 omit strip），浅合并保留旧值。
          curves[idx] = growthCurveSchema.parse({ ...curves[idx], ...action.patch });
        }
        // character_id 不存在 → 幂等跳过。
        break;
      }
      case 'remove_curve': {
        curves = curves.filter((c) => c.character_id !== action.character_id);
        break;
      }
    }
  }
  return curves;
}

// ── Pacing Curve 节奏曲线 ──

export const pacingPointSchema = z.object({
  refId: z.string().min(1),
  intensity: z.number().min(0).max(10),
  informationDensity: z.number().min(0).max(10).optional(),
  actionLevel: z.number().min(0).max(10).optional(),
  recoveryLevel: z.number().min(0).max(10).optional(),
  note: z.string().optional()
});

export const pacingCurveSchema = z.object({
  unit: z.enum(['act', 'episode', 'chapter', 'scene']),
  points: z.array(pacingPointSchema).default([]),
  target_shape: z.string().optional(),
  risks: z.array(z.string()).default([])
});
export type PacingCurve = z.infer<typeof pacingCurveSchema>;

// ── PacingCurve bounded action + projector（Story 8.5 R1，mirror emotionCurveActionSchema /
// applyEmotionCurveActions 逐字段同构——同为 refId+points 扁平曲线）──
//
// LLM（leader 对话）经 pacing_curve_update 工具发 bounded action（add/update/remove point），handler 调本
// 纯函数投影出 full curve → autoApply 双落盘（mirror emotion_curve_update）。pacing_curve 顶层维持单条不动
// （扁平曲线 points 引用任意 refId，无多实体问题，design §2.1）。projector 纯代码机械 by-refId（ADR-3 ✓，
// 非语义裁判）；trust-boundary 校验在 handler（schema parse + safeParse projected）。
export const pacingCurveActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_point'), point: pacingPointSchema }),
  z.object({ op: z.literal('update_point'), point: pacingPointSchema }),
  z.object({ op: z.literal('remove_point'), refId: z.string().min(1) }),
]);
export type PacingCurveAction = z.infer<typeof pacingCurveActionSchema>;

/**
 * 把 bounded actions 投影到当前 PacingCurve → 新 full curve。纯函数（无副作用，mirror applyEmotionCurveActions）。
 *
 * - add_point：refId 已存在 → 覆盖该 point（幂等）；refId 不存在 → 追加。
 * - update_point：refId 已存在 → 覆盖；不存在 → 追加（同 add，容错——LLM 可能误判存在性）。
 * - remove_point：refId 存在 → 删；不存在 → 幂等跳过。
 *
 * unit/target_shape/risks 透传不动（projector 只管 points）。
 */
export function applyPacingCurveActions(
  current: PacingCurve,
  actions: PacingCurveAction[],
): PacingCurve {
  const points = [...current.points];
  for (const action of actions) {
    if (action.op === 'remove_point') {
      const idx = points.findIndex((p) => p.refId === action.refId);
      if (idx >= 0) points.splice(idx, 1);
      continue;
    }
    // add_point / update_point：按 refId 覆盖或追加。
    const idx = points.findIndex((p) => p.refId === action.point.refId);
    if (idx >= 0) points[idx] = action.point;
    else points.push(action.point);
  }
  return { ...current, points };
}

// ── Emotion Curve 情感曲线（Story 5.1：语义情绪词为一等 + VAD 可选投影双轨）──
//
// 范式（ADR-3 / creative-vs-mechanical / 写作思维原理「情绪点 / 情绪动态」line 823-828）：
// - emotion 语义词（= 写作思维「情绪点」，欲望催动剂）/ emotionEnd 语义转变（= 写作思维「情绪动态」）
//   = 一等公民（LLM 5.2 产）。自由值 z.string + 词表先验 defer 5.2/craft 蒸馏（非封闭 enum，避假信心门）。
// - vad / vadEnd / sceneVad = 可选数值投影（Mehrabian PAD -1..1），供 5.3 verify-loop DTW/setpoint 数学用；
//   缺失则 5.3 降级语义趋势比对，不崩。VAD 非情绪表达真相（用户质疑 VAD 契合性 + 写作思维原理零 VAD）。
// - 纯代码只做 schema 容器 + vadTriple 范围校验；不做情绪语义判断、不做语义→VAD 查表投影。
//
// 双轨（world-state.ts:5-10 双轨哲学）：目标轨 emotion_curve creative field（原样不投影）vs
// 实际轨 6.6 emotional axis（closure_world_state 派生，/mood 语义态，本就语义为主天然对齐）。
//
// 兼容性（用户 2026-08-08 拍大改不兼容）：砍 point 级旧字段（primaryEmotion/secondaryEmotion/valence/
// arousal/transition，fork 初始 schema 遗物，Closure 未用）。zod strip 旧 optional → parse 通过非 fail，
// 不触发 loadProject 迁移 convention（详 design §5）。
//
// expected_downstream_consumers:
// - Story 5.2：Director 产 emotion 语义词 + 可选 VAD（director-agent.yaml:27 情绪段 placeholder）；
//   从正文抽实际情绪（/mood 语义词 + 可选 vad，6.6 emotional patch value 约定）。
// - Story 5.3：verify-loop 消费可选 VAD 投影（DTW 弧距离 + setpoint 衰减 emotion(t)=setpoint+(peak-setpoint)·e^{-t/τ}）；
//   缺失降级语义趋势比对。
// - Story 5.4：Reader-Audit 情绪维（dimensions[].name 开放 string，chapter-nodes.ts:215）。

// vadTripleSchema：VAD 数值投影，Mehrabian PAD 标准 -1..1 三轴（D4）。
// 供 emotion_curve point + brief #10 emotionTarget + 6.6 emotional patch value（doc 约定）复用（DRY 单源）。
// 本身是 object（非 optional），optional 在使用处加（灵活复用）。
export const vadTripleSchema = z.object({
  v: z.number().min(-1).max(1), // valence 效价 -1厌恶..+1愉悦
  a: z.number().min(-1).max(1), // arousal 唤醒 -1困倦..+1激动
  d: z.number().min(-1).max(1), // dominance 掌控 -1被控..+1掌控
});
export type VadTriple = z.infer<typeof vadTripleSchema>;

// emotionCharacterSchema：per-character 目标情绪（语义为一等 + VAD 可选）。
// - emotion：情绪点（语义情绪词，= 写作思维「情绪点」）。
// - emotionEnd：情绪动态（语义转变，= 写作思维「情绪动态」；有 emotionEnd = 场内情绪转变 pair）。
// - vad / vadEnd：可选数值投影（起点/单点 + 场内转变终点），供 5.3 数学。
export const emotionCharacterSchema = z.object({
  characterId: z.string().min(1),
  emotion: z.string().min(1),
  emotionEnd: z.string().min(1).optional(),
  vad: vadTripleSchema.nullish(),
  vadEnd: vadTripleSchema.nullish(),
  note: z.string().optional(),
});
export type EmotionCharacter = z.infer<typeof emotionCharacterSchema>;

// emotionPointSchema：一场的目标情绪（场景读者氛围 + per-character）。
// - sceneMood：场景读者氛围（语义，Director 给读者层目标，与角色情绪正交；区别于角色层 characters[]）。
// - sceneVad：可选数值投影（读者氛围的 VAD）。
// - characters[]：per-character 目标情绪（戏剧张力核心——角色情绪常对立）。空=合法（场景氛围-only point）。
export const emotionPointSchema = z.object({
  refId: z.string().min(1),
  sceneMood: z.string().min(1).optional(),
  sceneVad: vadTripleSchema.nullish(),
  characters: z.array(emotionCharacterSchema).default([]),
  note: z.string().optional(),
});
export type EmotionPoint = z.infer<typeof emotionPointSchema>;

export const emotionCurveSchema = z.object({
  unit: z.enum(['act', 'episode', 'chapter', 'scene']),
  points: z.array(emotionPointSchema).default([]),
  emotional_promises: z.array(z.string()).default([]),
  catharsis_points: z.array(z.string()).default([]),
});
export type EmotionCurve = z.infer<typeof emotionCurveSchema>;

// ── EmotionCurve bounded action + projector（Story 5.2，mirror infoReleaseActionSchema / applyInfoReleaseActions）──
//
// LLM（Director，5.2）经 emotion_curve_update 工具发 bounded action（add/update/remove point），handler 调本纯函数
// 投影出 full curve → autoApply 双落盘（auto=onFieldEdited source:'agent' / non-auto=field_patch PatchReview）。projector
// 纯代码机械 by-refId（ADR-3 ✓，非语义裁判）；trust-boundary 校验在 handler（schema parse + safeParse projected）。
// emotion_point 用 refId（→ SceneNode.id）非 id 作识别键（mirror emotionPointSchema.refId，与 infoRelease by-id 区别）。
//
// 范式判据（ADR-3 / creative-vs-mechanical）：projector = 纯代码机械投影（by-refId 覆盖/追加/删），非语义。不判
// 「这个情绪点该不该加」「情绪值合不合理」（归 Director LLM 产 + Reader-Audit 5.4 裁）。
export const emotionCurveActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_point'), point: emotionPointSchema }),
  z.object({ op: z.literal('update_point'), point: emotionPointSchema }),
  z.object({ op: z.literal('remove_point'), refId: z.string().min(1) }),
]);
export type EmotionCurveAction = z.infer<typeof emotionCurveActionSchema>;

/**
 * 把 bounded actions 投影到当前 EmotionCurve → 新 full curve。纯函数（无副作用，mirror applyInfoReleaseActions）。
 *
 * - add_point：refId 已存在 → 覆盖该 point（幂等）；refId 不存在 → 追加。
 * - update_point：refId 已存在 → 覆盖；不存在 → 追加（同 add，容错——LLM 可能误判存在性）。
 * - remove_point：refId 存在 → 删；不存在 → 幂等跳过。
 *
 * unit/emotional_promises/catharsis_points 透传不动（projector 只管 points）。version 无（emotionCurveSchema
 * 无 version 字段——field 级 sync version 在 field_metadata，非 in-data，mirror emotion_curve 简洁形态）。
 */
export function applyEmotionCurveActions(
  current: EmotionCurve,
  actions: EmotionCurveAction[],
): EmotionCurve {
  const points = [...current.points];
  for (const action of actions) {
    if (action.op === 'remove_point') {
      const idx = points.findIndex((p) => p.refId === action.refId);
      if (idx >= 0) points.splice(idx, 1);
      continue;
    }
    // add_point / update_point：按 refId 覆盖或追加。
    const idx = points.findIndex((p) => p.refId === action.point.refId);
    if (idx >= 0) points[idx] = action.point;
    else points.push(action.point);
  }
  return { ...current, points };
}

// ── Asset Cards 资产卡 ──
// Story 2.4（epics.md Story 2-4 / FR-348）：共基（assetCardBase）+ discriminated per-type
// （8 类 typed 引导字段）。8 类 = character/location/prop/organization/rule/visual_motif/
// lore/golden_finger（第 8 类新增）。全 additive optional → 零 migration（既有 {id,type,name,…}
// 仍 validate：每 variant 的 per-type 字段全 optional，backward-compat）。
//
// 范式判据 (ADR-3 / .trellis/spec/core/creative-vs-mechanical.md)：字段路由/查询 = 纯代码
// （schema 存查）；设定值判断（金手指代价合理性/承诺违背/OOC）= LLM（2.5 GenreContract /
// Reader-Audit）。开放分类（自由值 z.string + 词表先验非封闭 enum，mirror 1.9 narrative-enums
// / 2.1 craft-type-vocab 惯例，避假信心门 + 写作思维原理 :474 反过度解构）。
//
// 编辑自由度 (design D2)：customFields = details（first-class）。套不进 typed 模板的，agent/用户
// 经 details 自由扩展（既有字段 re-role，零 migration，字段名不改）。typed 引导 + 自由兜底共存。
//
// 静态/动态切分 (design D4)：卡存静态身份；弧 → growth_curve；关系 → relationship_graph；
// 状态变化 → 状态引擎（Epic 6/8）；叙事节奏 → methodology。
//
// expected_downstream_consumers:
// - Story 2.3 设定喂 LLM：核心字段 → 稳定前缀；卡片 typed 字段 + customFields → 动态后缀检索。
// - Story 2.5 GenreContract：读 creative_brief.genre_tags/commitments + world_constitution。
// - 知识蒸馏 track（D1-D9）：craft 内容填卡引导文案 + 词表先验。
// - 搜索索引 story（独立）：asset_cards → closure_* 索引，消费 typed 字段 + customFields。
// - Epic 5.1 / Epic 6：emotion_arc_template / 卡的信息差字段（真相层级/认知分布/公众vs隐藏）。

export const assetCardTypeSchema = z.enum([
  'character', 'location', 'prop', 'organization', 'rule', 'visual_motif', 'lore', 'golden_finger'
]);

export const assetCardStatusSchema = z.enum(['draft', 'active', 'deprecated', 'locked']);

// ── 分类词表（先验非门禁，开放 string）── mirror narrative-enums / craft-type-vocab。
// value = 推荐值；gloss = 中文注解。注入 asset-loader prompt / UI 补全 chips（非下拉单选）。
// 用户/LLM 可写词表外值（零 migration 自建新类）。确定性数据，零 LLM、零主观阈值。
// 逐卡字段清单详 design §4.1-§4.8。
export const POWER_SYSTEM_TYPE_VOCAB = [
  { value: '修炼', gloss: '境界突破式力量进阶（修真/玄幻常见）' },
  { value: '系统', gloss: '系统面板/任务/数值驱动（网游式金手指常见载体）' },
  { value: '网游', gloss: '游戏世界或游戏化现实（HP/等级/技能树）' },
  { value: '超能', gloss: '异能/超能力体系（觉醒型/变异型）' },
  { value: '无', gloss: '无显式力量体系（现实/纯文学/低魔）' },
] as const;

export const LOCATION_TYPE_VOCAB = [
  { value: '城市', gloss: '大型聚落' },
  { value: '村庄', gloss: '小型聚落' },
  { value: '要塞', gloss: '军事据点' },
  { value: '遗迹', gloss: '古代/前代遗留' },
  { value: '自然地貌', gloss: '山川/森林/荒野等天然环境' },
  { value: '建筑内部', gloss: '单栋建筑的内部空间' },
  { value: '秘境', gloss: '异空间/隐藏领域' },
] as const;

export const PROP_TYPE_VOCAB = [
  { value: '武器', gloss: '攻击/战斗器具' },
  { value: '防具', gloss: '防护装备' },
  { value: '消耗品', gloss: '一次性使用物品' },
  { value: '材料', gloss: '原料/资源' },
  { value: '机械', gloss: '机械装置' },
  { value: '文献', gloss: '书籍/卷轴/记录' },
  { value: '货币', gloss: '交易媒介' },
  { value: '遗物', gloss: '古代/神圣遗物' },
] as const;

export const ORGANIZATION_TYPE_VOCAB = [
  { value: '国家', gloss: '政权实体' },
  { value: '宗教', gloss: '信仰组织' },
  { value: '军事', gloss: '军队/骑士团' },
  { value: '商业', gloss: '商会/公司/公会' },
  { value: '学术', gloss: '学派/研究院' },
  { value: '秘密结社', gloss: '地下/隐秘组织' },
  { value: '家族', gloss: '血缘世族' },
  { value: '帮派', gloss: '江湖/黑道帮会' },
] as const;

export const RULE_TYPE_VOCAB = [
  { value: '自然法则', gloss: '世界底层物理/魔法规律' },
  { value: '神定律法', gloss: '神明/创世者设定的规则' },
  { value: '契约规则', gloss: '契约/誓约的约束机制' },
  { value: '诅咒机制', gloss: '诅咒的运作规则' },
  { value: '社会铁律', gloss: '社会运转的刚性规则' },
  { value: '规则怪谈规则', gloss: '规则怪谈型怪异规则（遵守/违反后果）' },
] as const;

export const VISUAL_MOTIF_TYPE_VOCAB = [
  { value: '视觉', gloss: '画面意象' },
  { value: '听觉', gloss: '声音意象' },
  { value: '触觉', gloss: '触感意象' },
  { value: '嗅觉', gloss: '气味意象' },
  { value: '动作', gloss: '反复出现的动作' },
  { value: '场景', gloss: '反复出现的场景类型' },
  { value: '数字', gloss: '反复出现的数字符号' },
] as const;

export const LORE_TYPE_VOCAB = [
  { value: '创世神话', gloss: '世界起源神话' },
  { value: '英雄传说', gloss: '英雄人物传说' },
  { value: '历史叙事', gloss: '历史事件叙述' },
  { value: '民间谣言', gloss: '坊间流传/都市传说' },
  { value: '未解之谜', gloss: '谜题型叙事' },
  { value: '预言', gloss: '预兆/预言类' },
  { value: '禁忌故事', gloss: '被禁止流传的故事' },
] as const;

export const GOLDEN_FINGER_TYPE_VOCAB = [
  { value: '系统型', gloss: '系统面板/任务驱动的外挂' },
  { value: '血脉型', gloss: '血统/血脉觉醒的能力' },
  { value: '器物型', gloss: '依附特定器物的外挂' },
  { value: '知识型', gloss: '前世记忆/超前知识' },
  { value: '规则型', gloss: '操纵/豁免世界规则' },
  { value: '契约型', gloss: '与超凡存在契约' },
  { value: '体质型', gloss: '特殊体质/身体改造' },
] as const;

export const GOLDEN_FINGER_ESSENCE_VOCAB = [
  { value: '信息', gloss: '信息不对称（先知/全知）' },
  { value: '时间', gloss: '时间不对称（回溯/暂停/加速）' },
  { value: '规则', gloss: '规则不对称（豁免/改写/优先）' },
  { value: '资源', gloss: '资源不对称（无限/快速获取）' },
] as const;

// ── 公共 sub-schemas（所有 8 类共享，全 optional）── design §3。
// CR-001a：narrative 仅保留 storyFunction + coreConflict；themeMapping 退场（与 visual_motif
// 顶层三层 themeMapping 同名冲突——per-type 专字段为准，base 公共字段对该类退场）。
// narrative：故事功能 / 核心冲突。
export const narrativeSchema = z.object({
  storyFunction: z.string().optional(),    // 故事功能（主角/对手/镜像/催化…）
  coreConflict: z.string().optional()       // 核心冲突
});
// writingCheatSheet：第一印象 / 反复意象 / 专属词汇（动词·形容词·比喻·禁用词）。
// CR-002：nested object 组用 .nullish()（防 LLM 产 null 致 parse 失败；接受 undefined+null）。
export const writingCheatSheetSchema = z.object({
  firstImpression: z.string().optional(),         // 第一印象
  recurringImagery: z.array(z.string()).optional(), // 反复意象
  vocabulary: z.object({
    verbs: z.array(z.string()).optional(),         // 专属动词
    adjectives: z.array(z.string()).optional(),    // 专属形容词
    metaphors: z.array(z.string()).optional(),     // 专属比喻
    forbidden: z.array(z.string()).optional()      // 禁用词（OOC 风险）
  }).nullish()
});
// secrets：表面 vs 真相（信息差）。
// CR-001b 边界：per-type 专字段（如 lore.truth 层级 object / character 未直接复用）在列为准时，
// 此处 truth 为 string 是「非专字段卡的通用 fallback」——lore 卡读自有更富的 truth 层级 object。
export const secretsSchema = z.object({
  surface: z.string().optional(),   // 表面（外人/读者初见）
  truth: z.string().optional()      // 真相（读者知/作者设定；lore 卡用自有 truth 层级 object 为准）
});
// worldAndCanon：本地世界规则 / 同人 canon 锚点。
// CR-001b 边界：per-type 专字段（如 character.fanficCanon）在列为准时，此处 canonAnchors 为
// 「非专字段卡的通用 fallback」——character 卡读自有 fanficCanon 同人锚点为准。
// CR-002：nested object 组用 .nullish()（localRules/canonAnchors 为数组保持 .optional 不动）。
export const worldAndCanonSchema = z.object({
  localRules: z.array(z.string()).optional(),     // 本地世界规则（本卡相关的局部规则）
  canonAnchors: z.array(z.string()).optional()     // 同人 canon 锚点（原作引用；character 卡用 fanficCanon 为准）
});

// ── per-type 字段 schemas（discriminated by `type`，全 optional）── 严格对照 design §4。
// 字段分组为 nested optional object，提供 typed 引导同时保持 backward-compat（缺失即未设）。
// 各分类字段（类型/层级…）= 自由值 z.string + 上方词表先验（非 z.enum）。

// §4.1 角色卡 character：弧 → growth_curve（核心欲望 static 在卡，演变在 growth_curve）。
// CR-002：nested object 组用 .nullish()（防 LLM 产 null 致整卡 parse 失败；接受 undefined+null）。
export const characterFieldsSchema = z.object({
  basics: z.object({
    aliases: z.array(z.string()).optional(),
    gender: z.string().optional(),
    orientation: z.string().optional(),    // 性取向（百合/BL/言情 按需浮现，自由值）
    age: z.string().optional(),
    race: z.string().optional(),
    occupation: z.string().optional(),
    faction: z.string().optional()         // 势力归属
  }).nullish(),
  personality: z.object({                   // 性格 ⭐
    coreTraits: z.array(z.string()).optional(),   // 核心词（自由，无数量限制）
    surface: z.string().optional(),                // 表层（外人见）
    innerTruth: z.string().optional(),             // 内在真相（读者知）
    strengths: z.array(z.string()).optional(),
    weaknesses: z.array(z.string()).optional(),
    // Story 5.3：角色情绪弹性系数（brainstorming #22，0=冻结创伤后情绪不衰减/1=极弹性来得快走得快）。
    // 供 5.3 verify-loop setpoint τ 映射（computeSetpoint：τ=TAU_MAX·(1-elasticity) clamp [TAU_MIN,TAU_MAX]）。
    // additive optional → 零 migration（:856 asset_cards 全 additive；既有角色卡 personality 无此字段仍 validate）。
    // 范式判据（ADR-3 / creative-vs-mechanical）：弹性值判断（这个角色情绪弹性如何）= LLM（asset-loader 产角色卡
    // 时填，语义创作判断）；τ 映射数学 + setpoint 衰减 = 纯代码消费（5.3 确定性计算，AGENCY-005 setpoint 公式）。
    emotionElasticity: z.number().min(0).max(1).optional()
  }).nullish(),
  desireAndBottomline: z.object({           // 欲望底线 ⭐（OOC 锚点核心）
    coreDesire: z.string().optional(),             // 核心欲望（+维度标签）
    coreFear: z.string().optional(),               // 核心恐惧
    oocAnchors: z.array(z.string()).optional()     // OOC 锚点·禁止的行为
  }).nullish(),
  abilities: z.object({                     // 能力（反玛丽苏：能力+代价）
    core: z.array(z.string()).optional(),          // 核心能力
    cost: z.string().optional()                    // 代价/弱点
  }).nullish(),
  voice: z.object({                         // 声线行为（OOC 判定基底）
    speechStyle: z.string().optional(),            // 说话风格
    behaviorStyle: z.string().optional()           // 行为风格
  }).nullish(),
  background: z.object({                    // 背景（原始创伤归此 static；演变→growth_curve）
    keyPastEvents: z.array(z.string()).optional()
  }).nullish(),
  fanficCanon: z.object({                   // 同人（选填）
    canonRef: z.string().optional(),
    consistency: z.string().optional(),            // 不矛盾依据
    deviation: z.string().optional()               // 偏离说明
  }).nullish()
});

// §4.2 地点卡 location：统一 locations[]；嵌套→located_in（relationship_graph）。
// CR-002：nested object 组用 .nullish()（landmarks 为数组保持 .optional 不动）。
export const locationFieldsSchema = z.object({
  basics: z.object({
    aliases: z.array(z.string()).optional(),
    type: z.string().optional(),            // 城市/村庄/要塞/…（LOCATION_TYPE_VOCAB）
    scale: z.string().optional(),           // 面积·人口·量级感
    region: z.string().optional()           // 所属区域
  }).nullish(),
  environment: z.object({                   // 环境 ⭐写作核心
    terrain: z.string().optional(),
    climate: z.string().optional(),
    palette: z.string().optional(),                // 色调
    lighting: z.string().optional(),
    sound: z.string().optional(),
    smell: z.string().optional(),
    moodKeywords: z.array(z.string()).optional()   // 氛围关键词（自由，无上限）
  }).nullish(),
  ecology: z.object({                       // 生态（聚落类才有）
    economy: z.string().optional(),
    society: z.string().optional(),
    culture: z.string().optional()
  }).nullish(),
  history: z.object({                       // 历史 static
    origin: z.string().optional(),
    keyPastEvents: z.array(z.string()).optional(),
    currentSituation: z.string().optional()        // 当前局势（story-start 快照）
  }).nullish(),
  landmarks: z.array(z.string()).optional() // 地标（标志地点）
});

// §4.3 物品卡 prop：金手指非物品卡（金手指独立卡）。
// CR-002：nested object 组用 .nullish()（防 LLM 产 null 致 parse 失败）。
export const propFieldsSchema = z.object({
  basics: z.object({
    aliases: z.array(z.string()).optional(),
    type: z.string().optional(),            // 武器/防具/消耗品/…（PROP_TYPE_VOCAB）
    rarity: z.string().optional(),
    system: z.string().optional()           // 所属体系
  }).nullish(),
  appearance: z.object({                    // 外观感官 ⭐
    dimensions: z.string().optional(),                 // 尺寸/重量/材质/结构
    visual: z.string().optional(),
    sound: z.string().optional(),
    touch: z.string().optional(),
    smell: z.string().optional(),
    moodKeywords: z.array(z.string()).optional()
  }).nullish(),
  mechanics: z.object({                     // 功能机制 ⭐
    coreFunction: z.string().optional(),
    workingPrinciple: z.string().optional(),
    useConditions: z.string().optional(),           // 使用条件（使用者要求/消耗/充能/环境限制）
    limitations: z.string().optional()              // 限制与代价（硬性限制/副作用/禁忌）
  }).nullish(),
  origin: z.object({
    creation: z.string().optional(),                 // 制造（者/时间/地点/目的/工艺/原材料）
    keyPastEvents: z.array(z.string()).optional(),
    currentState: z.string().optional()
  }).nullish(),
  value: z.object({                         // 价值生态（贵重/争夺物）
    economic: z.string().optional(),
    scarcity: z.string().optional(),
    demanders: z.array(z.string()).optional()
  }).nullish(),
  socioCulture: z.object({                  // 社会文化（文化重物）
    symbolism: z.string().optional(),
    perception: z.string().optional(),              // 社会认知（信息差）
    culturalLinks: z.array(z.string()).optional()
  }).nullish()
});

// §4.4 组织卡 organization：统一 power_structures[]；领袖/核心成员→角色卡引用。
// CR-002：nested object 组用 .nullish()（memberProfile 为 string 保持 .optional 不动）。
export const organizationFieldsSchema = z.object({
  basics: z.object({
    aliases: z.array(z.string()).optional(),
    shortName: z.string().optional(),
    type: z.string().optional(),            // 国家/宗教/军事/…（ORGANIZATION_TYPE_VOCAB）
    scale: z.string().optional(),           // 规模等级
    domain: z.string().optional(),          // 领域
    headquarters: z.string().optional()     // 总部地点（引用地点卡）
  }).nullish(),
  ideology: z.object({                      // 理念 ⭐（公众vs隐藏=信息差核心）
    coreBelief: z.string().optional(),
    goalHierarchy: z.string().optional(),
    publicImage: z.string().optional(),             // 对外叙事：公众形象（官方）
    hiddenFace: z.string().optional(),              // 隐藏面目（真实）
    bottomLine: z.array(z.string()).optional(),     // 绝对底线·禁忌（组织级 OOC）
    internalDisputes: z.array(z.string()).optional()
  }).nullish(),
  structure: z.object({
    powerStructure: z.string().optional(),
    decisionMechanism: z.string().optional(),
    factions: z.array(z.string()).optional()        // 内部派系
  }).nullish(),
  resources: z.object({
    manpower: z.string().optional(),
    economy: z.string().optional(),                 // 含弱点
    military: z.string().optional(),                // 含王牌·弱点
    technology: z.string().optional(),
    intelligence: z.string().optional()             // 含盲区=信息差
  }).nullish(),
  history: z.object({
    origin: z.string().optional(),
    keyPastEvents: z.array(z.string()).optional()
  }).nullish(),
  culture: z.object({                       // 文化 ⭐一致性
    symbols: z.array(z.string()).optional(),        // 符号系统
    internalCulture: z.string().optional(),
    taboos: z.array(z.string()).optional()
  }).nullish(),
  memberProfile: z.string().optional()      // 成员画像（典型基层成员；具体人物→引用角色卡）
});

// §4.5 规则卡 rule：边界例外·漏洞=爽点矿；vs WorldConstitution=project-level 承诺。
// CR-002：nested object 组用 .nullish()（ecologicalImpact 为 string 保持 .optional 不动）。
// CR-005：basics 删 name（与 base 顶层必填 name 重复，双 name 漂移）。
export const ruleFieldsSchema = z.object({
  basics: z.object({
    type: z.string().optional(),            // 自然法则/神定律法/…（RULE_TYPE_VOCAB）
    scope: z.string().optional(),           // 适用范围
    level: z.string().optional()            // 层级（底层公理/派生规则/表层现象）
  }).nullish(),
  definition: z.object({                    // 定义 ⭐
    description: z.string().optional(),
    formalExpression: z.string().optional(),        // 形式化表述（选填）
    nature: z.string().optional()                   // 规则性质（绝对性·可感知·可理解·可操控）
  }).nullish(),
  mechanism: z.object({
    trigger: z.string().optional(),                 // 触发条件
    process: z.string().optional(),                 // 运作过程
    result: z.string().optional(),
    executor: z.string().optional()                 // 执行者
  }).nullish(),
  boundaries: z.object({                    // 边界例外 ⭐爽点矿
    applicableBoundary: z.string().optional(),
    knownExceptions: z.array(z.string()).optional(),
    loopholes: z.array(z.string()).optional(),      // 漏洞·灰色地带
    paradoxes: z.array(z.string()).optional()
  }).nullish(),
  costs: z.object({                         // 代价后果 ⭐
    violationConsequence: z.string().optional(),
    exploitationCost: z.string().optional(),        // 利用代价
    abuseConsequence: z.string().optional()         // 滥用后果
  }).nullish(),
  ecologicalImpact: z.string().optional(),  // 生态影响（规则如何塑造世界）
  cognition: z.object({                     // 认知分布 ⭐信息差
    levels: z.string().optional(),                 // 认知层级（不知→知其然→所以然→知边界→可改写）
    misconceptions: z.array(z.string()).optional(),
    infoControl: z.string().optional()             // 信息管控
  }).nullish(),
  origin: z.object({
    origin: z.string().optional(),
    keyPastEvents: z.array(z.string()).optional()
  }).nullish()
});

// §4.6 视觉母题卡 visual_motif：统一 visual_language[]；出现记录→状态引擎。
// CR-002：nested object 组用 .nullish()（narrativeFunction 为数组保持 .optional 不动）。
// CR-005：basics 删 name（与 base 顶层必填 name 重复，双 name 漂移）。
// CR-001a：顶层 themeMapping（三层 object）保留为该类专字段（base narrative.themeMapping 已退场）。
export const visualMotifFieldsSchema = z.object({
  basics: z.object({
    type: z.string().optional(),            // 视觉/听觉/触觉/…（VISUAL_MOTIF_TYPE_VOCAB）
    senseChannel: z.string().optional(),    // 感官通道
    level: z.string().optional(),           // 层级（全书核心/章节弧线/角色专属/地点专属）
    frequency: z.string().optional()        // 出现频率
  }).nullish(),
  definition: z.object({                    // 定义 ⭐
    coreImagery: z.string().optional(),
    abstractMeaning: z.string().optional(),         // 抽象含义（主/次/反）
    rationale: z.string().optional()                // 为什么是这个意象
  }).nullish(),
  sensoryDetails: z.object({                // 感官细节 ⭐
    visual: z.string().optional(),
    sound: z.string().optional(),
    touch: z.string().optional(),
    smell: z.string().optional(),
    synesthesia: z.string().optional()              // 通感
  }).nullish(),
  variants: z.object({                      // 变体系统 ⭐
    list: z.array(z.string()).optional(),           // 变体列表（语境/感官差异/含义偏移/情绪色彩）
    evolutionLogic: z.string().optional()           // 变体演化逻辑
  }).nullish(),
  narrativeFunction: z.array(z.string()).optional(), // 叙事功能（预示/呼应/强化/转折/揭示/收束）
  themeMapping: z.object({                  // 主题映射 ⭐（表层·中层·深层）
    surface: z.string().optional(),
    middle: z.string().optional(),
    deep: z.string().optional()
  }).nullish(),
  designConstraints: z.object({             // 设计约束
    antiAbuse: z.string().optional(),               // 防滥用
    taboos: z.array(z.string()).optional(),
    degradationWarning: z.string().optional()       // 退化预警
  }).nullish()
});

// §4.7 传说卡 lore：信息差最富（≈Epic 6）；关联网络→relationship_graph。
// CR-002：nested object 组用 .nullish()（impact/unsolvedMysteries/emotionalAtmosphere 为 string/array 保持 .optional 不动）。
export const loreFieldsSchema = z.object({
  basics: z.object({
    type: z.string().optional(),            // 创世神话/英雄传说/…（LORE_TYPE_VOCAB）
    genre: z.string().optional(),           // 体裁
    spread: z.string().optional(),          // 流传范围
    credibility: z.string().optional(),     // 可信度标签（公认史实→纯虚构→未知）
    period: z.string().optional()           // 时段
  }).nullish(),
  storyBody: z.object({                     // 故事本体 ⭐
    fullVersion: z.string().optional(),             // 完整版本（prose）
    coreElements: z.array(z.string()).optional(),   // 核心元素（不可缺少）
    storyType: z.string().optional()
  }).nullish(),
  versionSystem: z.object({                 // 版本系统 ⭐信息差
    versions: z.array(z.string()).optional(),       // 版本列表（讲述者/差异/差异原因/可信度）
    relations: z.string().optional()                // 版本间关系（最古老/最接近真相/最广流传/最危险）
  }).nullish(),
  transmission: z.object({                  // 传播生态
    tellingMethod: z.string().optional(),
    distortionPattern: z.string().optional(),       // 传播变形规律
    infoControl: z.string().optional()              // 信息管控（地下版本）
  }).nullish(),
  truth: z.object({                         // 真相 ⭐信息差核心（per-type 专字段，为准）
    levels: z.string().optional(),                 // 真相层级（表面大众/中层知情者/深层作者设定/最深层留白）
    gap: z.string().optional(),                    // 真相与传说差距
    evidence: z.array(z.string()).optional()
  }).nullish(),
  impact: z.string().optional(),            // 影响（"相信即力量"）
  unsolvedMysteries: z.array(z.string()).optional(), // 未解之谜（谜题型）
  emotionalAtmosphere: z.string().optional() // 情感氛围
});

// §4.8 金手指卡 golden_finger（第 8 类，最厚）：核心公式=不对称优势+明确边界+叙事代价（反玛丽苏）。
// 金手指成长（外挂变强）vs growth_curve（角色弧）distinct。持有者 sentient→考虑角色卡。
// CR-002：nested object 组用 .nullish()（防 LLM 产 null 致整卡 parse 失败）。
export const goldenFingerFieldsSchema = z.object({
  basics: z.object({
    aliases: z.array(z.string()).optional(),
    type: z.string().optional(),            // 系统型/血脉型/器物型/…（GOLDEN_FINGER_TYPE_VOCAB）
    unique: z.boolean().optional(),         // 是否唯一
    awakeningTime: z.string().optional(),   // 觉醒时间
    essence: z.string().optional(),         // 本质（不对称类型：信息/时间/规则/资源，GOLDEN_FINGER_ESSENCE_VOCAB）
    packaging: z.string().optional()        // 包装形式
  }).nullish(),
  abilitySystem: z.object({                 // 能力体系 ⭐
    coreAbility: z.string().optional(),             // 核心能力（1 个）
    derivedAbilities: z.array(z.string()).optional(), // 衍生（派生：解锁/消耗/冷却/上限）
    ultimateAbility: z.string().optional(),         // 终极能力（选填）
    boundaries: z.string().optional()               // 能力边界（不能做什么）
  }).nullish(),
  growthSystem: z.object({                  // 成长系统 ⭐
    mode: z.string().optional(),                    // 成长模式
    resources: z.string().optional(),               // 成长资源
    stages: z.string().optional(),                  // 阶段划分（初始→完全体）
    pacing: z.string().optional()                   // 成长节奏
  }).nullish(),
  limitations: z.object({                   // 限制与代价 ⭐⭐最重要（反玛丽苏核心）
    hardLimits: z.string().optional(),              // 硬性限制（天花板）
    usageCost: z.string().optional(),               // 使用代价（即时·延迟·累积·极端）
    conditionLimits: z.string().optional(),         // 条件限制
    cognitiveLimits: z.string().optional(),         // 认知限制（持有者误解=信息差）
    emotionalMoralLimits: z.string().optional()     // 情感道德限制
  }).nullish(),
  origin: z.object({
    origin: z.string().optional(),
    keyPastEvents: z.array(z.string()).optional()
  }).nullish(),
  worldRelation: z.object({                 // 与世界关系
    legality: z.string().optional(),                // 合法/非法
    powerSystemPosition: z.string().optional(),     // 力量体系定位
    uniqueness: z.string().optional()               // 独特性
  }).nullish(),
  holderRelation: z.object({                // 持有者关系 ⭐
    attitudeEvolution: z.string().optional(),       // 态度演变
    dependency: z.string().optional(),              // 依赖独立
    identity: z.string().optional(),                // 身份认同
    sentience: z.string().optional()                // 金手指意志若 sentient→考虑角色卡
  }).nullish(),
  balance: z.object({                       // 平衡性设计 ⭐爽点
    coreLogic: z.string().optional(),               // 核心平衡逻辑（一句话）
    mechanism: z.string().optional(),               // 平衡机制
    unsolvableDilemma: z.string().optional(),       // 不能解决的核心困境
    shuangdianAndNuedian: z.string().optional()     // 爽点与虐点（+节奏）
  }).nullish()
});

// ── assetCard base（公共骨架）── 既有字段 + 4 公共 sub-schema + details(customFields)。
// `type` 不在 base（discriminatedUnion 各 variant 自带 literal）。
const assetCardBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().optional(),
  // customFields = details（first-class 编辑自由度：套不进模板的 agent/用户自由扩展）。
  // 字段名保留 `details`（零 migration，既有 project.yaml 不动）；语义 = customFields 自由补充。
  details: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).default([]),
  relationships: z.array(z.object({
    targetId: z.string().min(1),
    relationType: z.string(),
    label: z.string().optional()
  })).default([]),
  firstAppearance: z.string().optional(),
  sourceRefs: z.array(z.string()).default([]),
  status: assetCardStatusSchema.default('draft'),
  // Story 2.3（设定喂 LLM 工程，design §2.2）：核/微 tier 标注。additive optional -> 零 migration
  // （不破坏 2.4 discriminatedUnion backward-compat：既有 {id,type,name,…} 卡仍 validate）。
  // 范式判据（ADR-3 / creative-vs-mechanical）：tier 标注指令是「让 LLM 写设定时标」（这张卡
  // cross-scene 相关 + 罕变否 = 语义判断归 LLM）；编译器读 tier 决定进稳定前缀 vs 仅目录（结构
  // 提取 = 纯代码）。别把 tier 判定写成纯代码 pass/fail（假信心门）。tier 未标 -> 编译器结构默认
  // （character/golden_finger/rule 默认 core；location/organization/prop/visual_motif/lore 默认 micro）。
  // expected_downstream_consumers: Story 2.3 compileSettingPrefix（core 卡 lean 核心字段进 pinned
  // 稳定前缀，micro 卡仅入目录；详 setting-prefix.ts）。
  tier: z.enum(['core', 'micro']).optional(),
  // 4 公共 sub-schema（所有卡共享；CR-002 用 .nullish() 防 LLM 产 null 致 parse 失败）
  narrative: narrativeSchema.nullish(),
  writingCheatSheet: writingCheatSheetSchema.nullish(),
  secrets: secretsSchema.nullish(),
  worldAndCanon: worldAndCanonSchema.nullish()
});

// ── 8 variants（每 variant = base + type literal + per-type 字段，全 optional → backward-compat）──
const characterCardSchema = assetCardBaseSchema
  .merge(characterFieldsSchema)
  .extend({ type: z.literal('character') });
const locationCardSchema = assetCardBaseSchema
  .merge(locationFieldsSchema)
  .extend({ type: z.literal('location') });
const propCardSchema = assetCardBaseSchema
  .merge(propFieldsSchema)
  .extend({ type: z.literal('prop') });
const organizationCardSchema = assetCardBaseSchema
  .merge(organizationFieldsSchema)
  .extend({ type: z.literal('organization') });
const ruleCardSchema = assetCardBaseSchema
  .merge(ruleFieldsSchema)
  .extend({ type: z.literal('rule') });
const visualMotifCardSchema = assetCardBaseSchema
  .merge(visualMotifFieldsSchema)
  .extend({ type: z.literal('visual_motif') });
const loreCardSchema = assetCardBaseSchema
  .merge(loreFieldsSchema)
  .extend({ type: z.literal('lore') });
const goldenFingerCardSchema = assetCardBaseSchema
  .merge(goldenFingerFieldsSchema)
  .extend({ type: z.literal('golden_finger') });

// discriminatedUnion('type')：每 variant 的 per-type 字段全 optional → 既有最小 card（id+type+name）仍 validate。
export const assetCardSchema = z.discriminatedUnion('type', [
  characterCardSchema,
  locationCardSchema,
  propCardSchema,
  organizationCardSchema,
  ruleCardSchema,
  visualMotifCardSchema,
  loreCardSchema,
  goldenFingerCardSchema
]);

export const assetCardsSchema = z.array(assetCardSchema);
export type AssetCard = z.infer<typeof assetCardSchema>;

// ── AssetCard bounded action + projector（Story 3.6 WP9 / R5 策展，mirror sceneGraphActionSchema /
// applySceneGraphActions + emotionCurveActionSchema / applyEmotionCurveActions）──
//
// LLM（leader/researcher 研究后策展）经 asset_cards_update 工具发 bounded action（add/update/remove
// card），shell handler 调本纯函数投影出 full cards → field_patch envelope（field:'asset_cards'，
// action:'set'）→ PatchReviewPanel 人审 → fieldSyncBridge 落盘 + assetCardsWatcher reindex（落地公理：
// query_story 检回）。projector 纯代码机械 by-id（ADR-3 ✓，非语义裁判——「这张卡该建什么内容」归 LLM）。
//
// update_card patch 用宽松 record（浅合并语义，mirror promise update_beat 的 partial patch）：
// assetCardSchema 是 8-variant discriminatedUnion（type 为 discriminator），整体 .partial() 不可行；
// patch 内 id/type 身份键在 projector 剥除忽略（mirror promise update_beat E8 identity-strip——
// 改身份走 remove_card + add_card）。合并结果由 handler 经 assetCardsSchema.safeParse 再校验
// （trust-boundary：非法 patch 在投影后拒，非静默丢字段）。
export const assetCardActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_card'), card: assetCardSchema }),
  z.object({
    op: z.literal('update_card'),
    cardId: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({ op: z.literal('remove_card'), cardId: z.string().min(1) }),
]);
export type AssetCardAction = z.infer<typeof assetCardActionSchema>;

/**
 * 把 bounded actions 投影到当前 asset_cards → 新 full cards。纯函数（无副作用，mirror
 * applySceneGraphActions / applyPromiseActions）。
 *
 * - add_card：id 不存在 → 追加；id 已存在 → **跳过不覆盖**（防御 backstop——handler 对重复 id
 *   先友好报错；projector 永不静默替换既有卡，重复 id 落盘 = 同 id 双卡数据污染）。
 * - update_card：cardId 存在 → 浅合并 patch（未提供字段保留，customFields/details 不动；patch 内
 *   id/type 身份键剥除忽略，E8 mirror）；不存在 → 幂等跳过（mirror promise update_beat）。
 * - remove_card：cardId 存在 → 删；不存在 → 幂等跳过（mirror promise remove_beat）。
 *
 * 不做 schema re-parse（handler 侧 trust-boundary safeParse 全量再校验，mirror sceneGraphHandlers）。
 */
export function applyAssetCardActions(
  current: AssetCard[],
  actions: AssetCardAction[],
): AssetCard[] {
  let cards = [...current];
  for (const action of actions) {
    switch (action.op) {
      case 'add_card': {
        const idx = cards.findIndex((c) => c.id === action.card.id);
        // 重复 id 跳过（不覆盖）——handler 在投影前已对重复 add_card 友好报错，此处是不可达防御。
        if (idx === -1) cards.push(action.card);
        break;
      }
      case 'update_card': {
        const idx = cards.findIndex((c) => c.id === action.cardId);
        if (idx !== -1) {
          // 剥除身份键（id/type 不可改——改身份走 remove_card + add_card），其余浅合并。
          const { id: _id, type: _type, ...patch } = action.patch;
          cards[idx] = { ...cards[idx], ...patch } as AssetCard;
        }
        break;
      }
      case 'remove_card': {
        cards = cards.filter((c) => c.id !== action.cardId);
        break;
      }
    }
  }
  return cards;
}

// ── Relationship Graph 人物关系网 ──

export const relationTypeSchema = z.enum([
  'family', 'alliance', 'romance', 'rivalry', 'mentor',
  'secret', 'debt', 'organization', 'custom'
]);

export const relationshipNodeSchema = z.object({
  id: z.string().min(1),
  assetCardId: z.string().min(1),
  label: z.string(),
  type: assetCardTypeSchema,
  locked: z.boolean().default(false)
});

export const relationshipEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  relationType: relationTypeSchema,
  label: z.string().optional(),
  strength: z.number().min(0).max(10).optional(),
  polarity: z.enum(['positive', 'negative', 'neutral', 'ambivalent']).optional(),
  visibility: z.enum(['public', 'secret', 'one_sided']).optional(),
  sourceRefs: z.array(z.string()).default([]),
  locked: z.boolean().default(false)
});

export const relationshipGraphSchema = z.object({
  nodes: z.array(relationshipNodeSchema).default([]),
  edges: z.array(relationshipEdgeSchema).default([]),
  layout: z.record(z.string(), z.unknown()).optional(),
  version: z.number().int().nonnegative().default(0),
  updatedBy: z.enum(['user', 'agent', 'sync']).default('agent')
});

// Story 6.4 D2：relation 物化（relationIndexer）需 graph type（nodes + edges 结构）。
export type RelationshipGraph = z.infer<typeof relationshipGraphSchema>;

// ── Scene Graph 多线叙事结构 ──
// Story 1.1 (Epic 1 foundation): unified scene-graph skeleton (scenes + edges
// + lines + dual time coordinates) that all downstream narrative state
// (cognition / emotion / info-gap) anchors to. Schema only (codify, LLM
// writable) - no validation logic here; DAG/reachability/topology routing land
// in Story 1.2/1.3. See child3 design §1.1-§1.13 (referenced, not copied).

// Scene node role (child3 §1.4; anchor placement = LLM, high-indegree calc =
// pure code, reserved for 1.2)
export const sceneNodeRoleSchema = z.enum([
  'normal',
  'core-anchor',      // multi-line convergence, max fan-in
  'secondary-anchor', // 2-3 line junction
  'fork-point'        // IF branch fan-out (Story 1.7)
]).default('normal');

// Presentation order (dual coordinate之一: chapter + position)
export const presentationOrderSchema = z.object({
  chapter: z.number().int().nonnegative(),
  pos: z.number().int().nonnegative()
});

// 场↔章 M:N 交汇（Story 1.8，§3.8）。span 引用 episode（承载树原子 episode_outlines[].id）；
// 章号从 episode.index 派生（非存储键，charter #1「写作单位=情节弧非章」+ 1.5 flag）。
// pos = 该 span 在该 episode 内的阅读序位（与 presentationOrder.pos 同语义）。多项 = 跨章场。
export const presentationSpanSchema = z.object({
  episodeId: z.string().min(1),   // refs episode_outlines[].id
  pos: z.number().int().nonnegative()
});

export const sceneNodeSchema = z.object({
  id: z.string().min(1),
  lineTags: z.array(z.string().min(1)).default([]),  // refs Line.id; one scene may belong to multiple lines
  episodeId: z.string().min(1).optional(),            // D1: refs episode_outlines[].id (episode->scene hierarchy)
  storyTime: z.number().int().nonnegative(),          // D2: story chronology ordinal (1.3 DAG ordering)
  storyTimeLabel: z.string().optional(),              // D2: semantic label (e.g. "day 3 dusk")
  presentationOrder: presentationOrderSchema,         // dual coordinate之二: presentation (flashback = misaligned with storyTime, causal graph unchanged)
  // Story 1.8（§3.8 M:N）：跨哪些 episode 发布。缺失 = 单章场 = 1.1 行为（向后兼容，零 migration）。
  // 与 presentationOrder 解耦：presentationOrder = 阅读起始位（排序键，单值，layout readPosition 轴）；
  // presentationSpans = 发布交汇（场跨哪些 episode，M:N，承载树↔因果树）。projector 不自动派生两者
  // 关系（守 applySceneGraphActions 机械 by-id 哲学）；一致性靠 story-planner 约定 + 未来 validation warning。
  // .min(1)（CR-001/007/008）：契约穷尽二态——undefined=单章场 OR ≥1 span=跨章场；空 [] 不属于任何
  // episode（无意义）故拒收，免 LLM/手改产 [] 落第三态 + shallowNodeEqual ?? [] 把 []≡undefined 混淆。
  presentationSpans: z.array(presentationSpanSchema).min(1).optional(),
  role: sceneNodeRoleSchema,
  // Story 1.9（叙事枚举，§3.9/§3.10）：场级语义结构角色。自由值（z.string，非 closed z.enum）+
  // co-located 词表（OUTCOME_TYPE_VOCAB / PACING_ROLE_VOCAB）作先验注入 story-planner，不锁死。
  // 范式判据（ADR-3 / creative-vs-mechanical）：语义型枚举值穷举归 LLM；封闭枚举让纯代码判叙事分类
  // = 假信心门（词库命中→pass/fail）。词表是先验非门禁，可超出（§3.10）。camelCase 跟 SceneNode 约定
  // （多数字段 camelCase；origin_ref 是 1.7 偏差）。optional additive → 零 migration。
  // 下游消费者：brief §4 节奏/§6 剧情点（Epic 4）/ retrieval（Epic 4-10）/ 工作台 UI 补全（Epic 3）。
  outcomeType: z.string().optional(),    // 本场结果（达成/惨胜/受挫/反转/无冲突/被动…）
  pacingRole: z.string().optional(),     // 张弛角色（铺垫/推进/高潮/喘息/收束…）
  actRef: z.string().min(1).optional(),               // D3: reserved A-dimension line/act ref, semantics deferred to 1.2/1.4
  // Story 1.7 (IF branch): branch 拷贝节点指向 canon 源节点 id（CoW origin）。
  // canon 节点缺省 undefined；branch 新增节点（无 canon 对应）亦缺省 → canonDiff 分类 added。
  // additive optional，零 migration（旧 graph 无此字段仍 valid）。
  origin_ref: z.string().min(1).optional(),
  // dogfood R2 批次0（阅读缺失1）：场景人类标题与内容摘要。additive optional 零迁移（同
  // outcomeType/pacingRole/assetRefs 先例）。title = 时间线格/抽屉的人类名（缺省显示 id）；
  // summary = 场景摘要（「由 AI 补全」的落点）。填充语义归 LLM/作者，手编直写（作者主权）。
  // .min(1) 同 id 约定——空串无意义拒收；缺省 undefined = 未命名回退 id / 未写摘要。
  // expected_downstream_consumers: 时间线 SceneCell title??id 显示 + 抽屉编辑表单（批次 A）+
  // AI 摘要补全落点（批次 C）；canonDiff shallowNodeEqual 已纳入比较（scene-graph-analytics）。
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  // Story 3.4（D6）：本场涉及的 asset_card id 列表。scene_graph 是无正文轻量壳（prose 是结构
  // 声明非内容），assetRefs 是「场↔设定」的反向引用锚点——供涟漪诊断（3.4）reverse-ref 缩小
  // 「改了 asset X 影响哪些场」+ 3.7 InsightCard 数据源。与 WorldSubject.sourceCardId
  // （world-state.ts:114）/ relationship_node.assetCardId 同 id 空间（asset_card.id），零转换。
  // additive optional，零 migration（mirror :1508/:1515/:1592 先例）。消费者用 `?? []`。
  // 范式判据（ADR-3）：填充归 LLM——「这场涉及哪些设定卡」是语义判断（哪些角色/地点/道具出场），
  // 非「按字段名机械匹配」。story-planner 产 scene 时填 / scene_graph_update 工具改时填 / 手编填。
  // expected_downstream_consumers: Story 3.4 涟漪 reverse-ref（scenesByAssetRef）+ Story 3.7 InsightCard。
  assetRefs: z.array(z.string().min(1)).optional()
});

// Edge types (child3 §1.3 / Story 1.3 §6 边收口): only forward edges that enter the
// causal DAG. CAUSAL + SUSPENSE both feed DAG cycle detection (scene-graph-analytics).
// FORESHADOW → Promise ledger (Epic 6 Story 6.5); REVERSAL / SHARED-MOTIF /
// WORLD-COUPLING → mesh-cohesion edges, defer until mesh lines are actually built (§3.8).
export const sceneEdgeTypeSchema = z.enum([
  'CAUSAL',          // forward, enters DAG (1.3 cycle detection)
  'SUSPENSE',        // forward, enters DAG (1.3; serves DAG only, unrelated to cliffhanger per §3.9)
]);

export const sceneEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),   // SceneNode.id
  to: z.string().min(1),     // SceneNode.id
  type: sceneEdgeTypeSchema
  // validation (DAG/reachability/mesh mapping) deferred to 1.3
});

// Line track (full field set stored without validation; validation in 1.2/1.3)
export const lineTopologyRoleSchema = z.enum([
  'converging',          // Type 1 convergence (1.2/1.3 multi-root reachability BFS)
  'parallel-worldview',  // Type 2 mesh (1.3 world-event/theme mapping existence)
  'offline',             // offline (1.3 exempt from mainline reachability)
  'if-branch',           // IF branch (1.7 fork-point self-validation)
  'side'                 // side story / 番外 (1.7)
]).default('converging');

export const lineDisplacementSchema = z.enum([
  'none', 'prologue', 'epilogue', 'flashback', 'distant'
]).default('none');

// Story 1.2 (CR-004): discriminated union 替代 placeholder enum 'hidden-until-X'。
// target 不强约束 ref 类型（SceneNode.id | episodeId | storyTime label）——
// "隐藏直到哪个节点/事件"的语义判断归 LLM，纯代码不强指定 ref schema（1.3+ 视需要收紧）。
export const lineVisibilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('open') }),
  z.object({ status: z.literal('hidden-until'), target: z.string().min(1) })
]).default({ status: 'open' });

export const lineWeightSchema = z.object({
  value: z.number().min(0),
  mode: z.enum(['equal', 'main-sub']).default('equal')  // main-sub: weight parity does not apply
}).optional();

export const sceneLineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  topology_role: lineTopologyRoleSchema,
  // Story 1.9（叙事枚举，§3.9/§3.10）：线级叙事单元 + 收束契约（MICE）。自由值（z.string，非 closed
  // z.enum）+ co-located 词表（MICE_TYPE_VOCAB）作先验注入 story-planner，不锁死。snake_case 跟 Line
  // 约定（**非** miceType，interface-contracts 规则3 后加让步 + 1.2 phase_ref 先例）。
  // 正交区分（同一线两维度）：topology_role = 拓扑型（机械，封闭 enum，驱动 LINE_VALIDATION_PROFILE
  // 路由）vs mice_type = 叙事单元型（语义，开放 + 词表）。一机械一语义不冲突。
  // 范式判据（ADR-3 / creative-vs-mechanical）：语义型枚举值穷举归 LLM；词表是先验非门禁（§3.10）。
  // MICE 是线级收束契约（场属于线，场非叙事单元）——故挂 Line 而非 SceneNode（design D2）。
  // optional additive → 零 migration。下游：brief §6 关键剧情点（Epic 4）/ 收束检查（Epic 6 创作
  // 完整性）/ 工作台 UI（Epic 3）。
  mice_type: z.string().optional(),     // 线叙事单元（世界/观念/角色/事件 + 收束契约）
  thread_ref: z.string().min(1).optional(),           // thread anchor (asset_ref); absent = floating line warning (1.2)
  weight: lineWeightSchema,                            // weight parity (1.2 warning)
  worldEventRef: z.string().min(1).optional(),         // Type 2 validation anchor (1.3)
  themeRef: z.string().min(1).optional(),              // Type 2 validation anchor (1.3)
  displacement: lineDisplacementSchema,
  visibility: lineVisibilitySchema,
  convergence_target: z.string().min(1).optional(),    // Type 1 convergence target anchor_ref (1.3 BFS)
  phase_ref: z.string().min(1).optional(),             // Story 1.2 Thread model: ref outline_v2.phases[].id (§3.8). snake_case 跟随既有 thread_ref 约定（interface-contracts 规则3 后加让步）。
  is_main_thread: z.boolean().optional(),              // Story 1.2 Thread model: 主线定义阶段、其他线跨阶段（§3.8，语义校验推 1.3）
  story_time_span: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative()
  }).optional()
});

// Story 1.3 (§5 art-mode override): per-check 豁免记录，与 fieldMetadata.locked 正交
// （locked = AI 不擅改字段；art_overrides = 忽略某项校验）。零 migration（optional default []）。
// validateSceneGraph 读 art_overrides → 命中的 issue 降级为 info（不 block、仍可见）。
export const sceneArtOverrideSchema = z.object({
  check: z.string().min(1),     // issue code 被豁免，如 'causal-cycle'
  scope: z.string().optional(), // 可选：限定到某 node/edge/line id；缺省 = 该 check 全豁免
  reason: z.string().optional() // 人写的理由（Type3 林奇式故意打破因果留痕）
});

export const sceneGraphSchema = z.object({
  nodes: z.array(sceneNodeSchema).default([]),
  edges: z.array(sceneEdgeSchema).default([]),
  lines: z.array(sceneLineSchema).default([]),
  art_overrides: z.array(sceneArtOverrideSchema).default([]),
  version: z.number().int().nonnegative().default(0),
  updatedBy: z.enum(['user', 'agent', 'sync']).default('agent')  // aligns with relationshipGraphSchema/promiseRegistrySchema
});

export type SceneNode = z.infer<typeof sceneNodeSchema>;
export type SceneEdge = z.infer<typeof sceneEdgeSchema>;
export type SceneLine = z.infer<typeof sceneLineSchema>;
export type SceneGraph = z.infer<typeof sceneGraphSchema>;
export type SceneArtOverride = z.infer<typeof sceneArtOverrideSchema>;
export type SceneNodeRole = z.infer<typeof sceneNodeRoleSchema>;
export type PresentationSpan = z.infer<typeof presentationSpanSchema>;
export type LineTopologyRole = z.infer<typeof lineTopologyRoleSchema>;
export type LineVisibility = z.infer<typeof lineVisibilitySchema>;
export type MajorTurningPoint = z.infer<typeof majorTurningPointSchema>;
export type MajorTurningPointType = z.infer<typeof majorTurningPointTypeSchema>;

// ── Story 1.3 edit-path: bounded action enum for scene_graph_update tool ──
// design §1.2 / D3. 多线图大，全量替换（outline_update 式）易丢作者手改；bounded 操作
// 可逐条 review + 可逆（§3.8「write 是 action 枚举有界操作，不摸原始图」）。LLM 提议
// actions；shell handler 经 applySceneGraphActions（scene-graph-analytics.ts）投影成完整
// graph 进 field_patch（action:'set'，data=完整 graph），与 outline_update 同形，UI
// patch-review 不变。8 ops：scene/line 各 add/update/remove + edge add/remove（edge 无
// update——边是扁平 {from,to,type}，改它 = remove+add）。
export const sceneGraphActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_scene'),    scene: sceneNodeSchema.partial().required({ id: true }) }),
  z.object({ op: z.literal('update_scene'), scene: sceneNodeSchema.partial().required({ id: true }) }),
  z.object({ op: z.literal('remove_scene'), id: z.string().min(1) }),
  z.object({ op: z.literal('add_edge'),     edge: sceneEdgeSchema.partial().required({ id: true }) }),
  z.object({ op: z.literal('remove_edge'),  id: z.string().min(1) }),
  z.object({ op: z.literal('add_line'),     line: sceneLineSchema.partial().required({ id: true }) }),
  z.object({ op: z.literal('update_line'),  line: sceneLineSchema.partial().required({ id: true }) }),
  z.object({ op: z.literal('remove_line'),  id: z.string().min(1) }),
  // Story 1.7 (IF branch): fork-point 图操作 intent（在哪 fork + 新 branch 名）。
  // 下游拷贝集计算归纯代码 expander expandForkBranch（AGENT-001：图遍历非语义判断），
  // expander 输出 add_line/add_scene(带 origin_ref)/add_edge 批次喂 applySceneGraphActions
  // （projector 保持机械 by-id，design §6 trade-off：expander 独立 vs 入 projector 选独立）。
  // expected_downstream_consumers: 同人-1（IF 结构深化 E1 S.1.7）。
  // wiring（handler 调 expandForkBranch）随 fork UI/agent 流落地另接，1.7 仅落 schema + expander。
  z.object({
    op: z.literal('fork_branch'),
    fork_from_scene_id: z.string().min(1),   // canon fork-point（须 role:'fork-point'，在 is_main_thread 线）
    branch_line_id: z.string().min(1),        // 新 if-branch Line id
    branch_line_name: z.string().min(1).optional()
  }),
]);

export type SceneGraphAction = z.infer<typeof sceneGraphActionSchema>;
