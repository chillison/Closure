import { z } from 'zod';
import { promiseBeatKindSchema, promiseDerivedStageSchema } from './creative-fields';

// ── Story 6.6 实际轨状态引擎：WorldState 契约（design §3 / ADR-14 / ADR-3）──
//
// 6.6 = 实际轨状态引擎（正文之上的派生事件溯源）。双轨互补：
// - 实际轨（本 spec）：5 轴提取器从正文提取 events → 纯代码 reduce → closure_world_state 派生表
//   （精确，可查任意虚构时刻 storyTime）。prose 仍是唯一文件真相源（ADR-1 不变；ADR-14 派生可重建）。
// - 目标轨：creative-field 写作计划原样（asset_cards / scene_graph / relationship_graph / emotion_curve /
//   brief…），模糊（计划常无精确 storyTime），不投影成快照。「目标实现了没」= 语义判断归 Reader-Audit /
//   裁决器 LLM（ADR-3），非 6.6 纯代码 diff。
//
// 状态模型 largely 照搬 NeuroBook world-engine 核心（docs/neuro-book-reference/world-engine/）：
// subject（主体，任意 type，首次提取自动创建）+ slice（切面 = storyTime + patches[]）+ patch
// （subjectId + path + op + value + summary）+ 4 op（replace/increment/remove/append）+ 4 kind
// （scalar/list/collection/object，决定 op 语义）+ ref（subject://id scalar，不双向冗余、reduce 不解引用）
// + reduce（按 storyTime 升序叠加，截断 at，单 subject）。reduce 纯函数落 world-state-reduce.ts。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical）：本文件 = 结构化 schema（codify 容器），
// 纯代码只做 schema / 查询 / 确定性 reduce（不裁断语义）；「目标 vs 实际是否一致」「修补是否该执行」
// 归 LLM agent（Reader-Audit / 状态修补 Agent）。
//
// 落点 shared-contracts（design §5）：reduce 纯函数 DRY 跨包（shell repository 查询 + agent 提取器测试共用），
// 跨包类型共享（shell db repository + agent 提取器/修补 Agent）。零 migration（新文件；closure_world_state
// 3 表 Phase B 在 shell initSchema 新建，不动既有表）。
//
// ⚠️ 类型层 camelCase（db 列才 snake_case，Phase B repository 做映射，db-repository.md 惯例）。
//
// expected_downstream_consumers:
// - Story 6.6 Phase B（shell）：closure_world_subject/slice/patch 3 表 + worldStateRepository（snake_case↔camelCase）
//   + toolExecution IPC（query_world_state / write_world_events / amend_world_state）。
// - Story 6.6 Phase C（agent）：5 轴提取器（createLlmNode 产 WorldPatch[] source='derived'）+ 状态修补 Agent
//   （AmendmentRequest → AmendmentDecision，accept 产 WorldPatch[] source='amendment'）。
// - Story 6.6 Phase D：brief-compiler #6 stateAtT（reduce 基础快照反哺）+ Reader-Audit world_state_snapshot 基底。
// - Story 6.1：认知轴 perspective 层升级消费（6.6 只 reduce 基础认知状态）。
// - Story 5.1：情绪轴 VAD 层升级消费（6.6 只 reduce 基础情绪状态/转变）。
// - Story 6.5：Promise ledger 从 objective/reader_perceived gap 涌现（6.6 产 gap 信号预留）。

// ── op 全集（NeuroBook schema-system.md §3）──
// patch 的动词。全集受属性 kind 约束（见 world-state-reduce.ts kind×op 矩阵）：
// - replace：设绝对值（含覆盖、含嵌套路径）；后写覆盖前值。
// - increment：数值相对增量（数值 scalar 专用）；基于当前值累加，缺基准 → broken-relative。
//   可交换、对「往前插切面补历史」稳定（记录连续变化优先 increment，绝对值才 replace）。
// - remove：不带 value 删 path（路径不存在幂等）；collection 带 value 按 stable JSON 删元素（找不到幂等）；
//   list 带 value 会被拒绝（invalid-op）。
// - append：数组追加（单元素）；list 末尾追加不支持中间插；collection 按 stable JSON 去重追加；缺基准 → broken-relative。
export const worldPatchOpSchema = z.enum(['replace', 'increment', 'remove', 'append']);
export type WorldPatchOp = z.infer<typeof worldPatchOpSchema>;

// ── kind（NeuroBook schema-system.md §2）──
// 属性的「op 语义类」，决定接受哪些 op、reduce 怎么叠加。6.6 schema 宽松动态不预设字段（未声明属性默认
// scalar，照 NeuroBook §8）；reduce 时 kind 由「调用方 kindResolver 声明」优先，否则由当前值类型推断
// （array→list 默认 / plain object→object / 其余→scalar）。list vs collection 区分需 kindResolver 显式声明
// （NeuroBook：z.array() 默认 list，.unique() 才是 collection——无 schema 时同理需显式声明）。
export const WORLD_KINDS = ['scalar', 'list', 'collection', 'object'] as const;
export type WorldKind = (typeof WORLD_KINDS)[number];
export const worldKindSchema = z.enum(WORLD_KINDS);

// ── axis（5 轴，conclusions §3.6）──
// 每轴一提取器、每章并行、每个读全章。patch 标所属轴供管理面区分；reduce 不按 axis 过滤（同 subject
// 全轴叠加）。认知轴 reader_perceived / 关系轴 objective+reader_perceived 分层由 patch value 结构承载，
// 非新 axis（轴 = 状态维度非层级）。
export const worldPatchAxisSchema = z.enum([
  'physical', // 物理（位置/伤势/物品/能力）
  'cognitive', // 认知（角色主观可错：知道/相信/误解）
  'emotional', // 情绪（基础状态/转变语义态；Story 5.1：patch value 可选带 vad 投影，mirror vadTripleSchema 形态，填充归 5.2 抽取 LLM——VAD 非情绪真相，语义态 /mood 为一等）
  'relational', // 关系（objective + reader_perceived；角色对关系的感知归认知轴）
  'factional', // 势力（宏观格局兴衰）
]);
export type WorldPatchAxis = z.infer<typeof worldPatchAxisSchema>;

// ── source（派生 vs 修补覆盖层，design §3 amendment）──
// 同表标记区分：derived（提取器从正文派生，唯一 events 源）/ amendment（修补 Agent 裁决后写的覆盖层）。
// reduce 不分 source 全叠加（amendment 应用在 derived 之上）；重跑提取时 derived 从 prose 重建、
// amendment 清零（修补临时性，依附当时派生快照）。
export const worldPatchSourceSchema = z.enum(['derived', 'amendment']);
export type WorldPatchSource = z.infer<typeof worldPatchSourceSchema>;

// ── ref 引用规则（NeuroBook schema-system.md §5）──
// subject 之间的关系 = 值为引用的普通 scalar 属性（op replace）。引用串统一 subject://<id>，纯 id 不编码
// type。不双向冗余存（关系只存一边）；reduce 不自动解引用（返 subject://id 字符串本身，关联视图调用方
// 组合多个 reduce）。id 约束 [\w-]+（ASCII word + hyphen，对齐 NeuroBook §10 既有 recording 示例）。
export const WORLD_SUBJECT_REF_PREFIX = 'subject://';

/** subject 引用串 schema（`subject://<id>`，NeuroBook §5/§10）。 */
export const worldSubjectRefSchema = z
  .string()
  .regex(/^subject:\/\/[\w-]+$/, 'invalid subject ref (expected subject://<id>)');
export type WorldSubjectRef = z.infer<typeof worldSubjectRefSchema>;

/** 构造 subject 引用串：`subject://${subjectId}`。 */
export function createSubjectRef(subjectId: string): string {
  return `${WORLD_SUBJECT_REF_PREFIX}${subjectId}`;
}

/** 解析 subject 引用串 → id；非 subject:// 前缀或空 id 返 null（不抛）。 */
export function parseSubjectRef(ref: string): string | null {
  if (!ref.startsWith(WORLD_SUBJECT_REF_PREFIX)) return null;
  const id = ref.slice(WORLD_SUBJECT_REF_PREFIX.length);
  return id.length > 0 ? id : null;
}

// ── WorldSubject（主体，NeuroBook subject-lifecycle §1-§2）──
// subject = 参与世界模拟、能独立演变状态的主体（不限于人物：王国/物品/任务/阵营皆可）。任意 type
// （照 NeuroBook 通用），首次提取自动创建。有 asset_cards 卡的 id=卡 id 引用对齐目标轨（sourceCardId，
// 引用不复制静态字段，避双真相源，asset-card-model.md 静态/动态边界）；无卡的（群体/世界事件/任务）独立 id。
//
// subject 不限智慧生物——判断标准是「它有没有需要随时间追踪的独立状态」（recording-principles §1）。
// 一组功能相同的龙套先用单一 subject 表示整体（如 cultist-patrol-01），个体变重要时才拆分（§2）。
export const worldSubjectSchema = z.object({
  id: z.string().min(1),
  // 开放 type（任意 string，照 NeuroBook 通用 subject；不限于 asset_cards 4 类）。
  type: z.string().min(1),
  name: z.string().optional(),
  // 引用 asset_cards 卡 id（有卡的 subject 对齐目标轨；无卡的缺省）。
  sourceCardId: z.string().optional(),
  // 首次提取自动创建时的 storyTime（主体登记是稳定登记，删其唯一切面不删身份，subject-lifecycle §6）。
  firstSeenStoryTime: z.number().int(),
});
export type WorldSubject = z.infer<typeof worldSubjectSchema>;

// ── dogfood R2 #91：subject ID 单源生成器（形态规范 + 归一匹配键）──
//
// 背景：五个提取器（physical/cognitive/emotional/relational/factional）各自产 subject 时 ID 生成规则
// 不一致——同一角色以 `shen-yan` / `character:shen-yan` / `character:shenyan` 三形态并存（dogfood R2 #91
// 落库实证：11 个 subject 实际 ~7 个主体）。跨章状态分裂：下一章提取器再造第四个分身，mood/believes
// 挂到不同分身，Epic 6 信息差 / E5 情绪的跨章连续性从根上被稀释。
//
// 规范形态（canonical）：`<type>:<slug>`——type 小写开放词，slug = 小写、连字符分词、无空白（如
// `character:shen-yan` / `item:cryo-pod-01` / `group:archaeology-team`）。**有 asset_cards 卡的 subject
// id = 卡 id 原样**（对齐目标轨契约，不进本生成器——调用方按 sourceCardId 优先规则短路）。
//
// 范式判据（ADR-3）：本族 = 纯代码确定性规范化（不理解意义——名字→拼音 slug 是语义判断归提取器
// LLM，本函数只把 LLM 已产的 id-ish 串收敛到单一形态）。
//
// 消费面：agent 侧 parseAxisExtraction（五提取器共用 parse 点）+ shell 侧写入面身份解析
// （resolveWorldSubjectIdentity 查重复用）与存量分身合并迁移（migrateWorldSubjectIds）——三处共用
// 本单源，防形态漂移再裂分身。

/**
 * slug 形态规范化：剥类型式前缀段（`word:`，可多段）→ 小写 → 空白串折叠为单连字符 → 连字符叠折
 * → 缘连字符剥离。
 *
 * - `character:shen-yan` → `shen-yan`；`group:archaeology-team` → `archaeology-team`（幂等）
 * - `Shen Yan` → `shen-yan`（空白串→连字符）；`cryo_pod_01` 保留 `_`（id 契约 [\w-]）
 * - 中文本体保留（LLM 产中文名 id 时原样——转拼音是语义判断归提取器，纯代码不臆造）
 * - 规范后为空（输入 `character:` / `-` / 全空白等退化形态）→ 回退固定占位 `unnamed`。**不能回退原始
 *   串**：原始串自带可再剥的前缀/缘连字符，经 worldSubjectId 组 `<type>:<slug>` 后每轮叠一层
 *   （`character:` → `character:character:` → …）——canonical 非幂等，迁移会每启动改名一次。`unnamed`
 *   是纯字母 slug = 本函数定点（再过稳定不变）；不同退化 id 撞占位 = 垃圾输入互并，无害。
 */
export function worldSubjectSlug(nameOrSlug: string): string {
  const raw = (nameOrSlug ?? '').trim();
  let s = raw.toLowerCase();
  // 剥类型式前缀段：`[a-z]+:` 循环剥（`character:group:x` 这类多层前缀全剥；type 段必为纯字母小写）。
  s = s.replace(/^(?:[a-z]+:)+/, '');
  // 空白串（含全角空格等 Unicode whitespace）→ 单连字符（词界保留：`shen yan` 与 `shen-yan` 同形）。
  s = s.replace(/\s+/g, '-');
  // 连字符叠折 + 缘剥离（纯形态清理，不改词界）。
  s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'unnamed';
}

/**
 * 规范 subject id：`<type>:<slug>`。
 *
 * type 小写化（空串 → `entity` 泛型兜底，mirror merge linkReferencedSubjects stub type）；slug 走
 * worldSubjectSlug。对已规范形态幂等（`character:shen-yan` → `character:shen-yan`）。
 * ⚠️ 有 asset_cards 卡的 subject **不走本函数**——id = sourceCardId 原样（调用方短路，对齐目标轨）。
 */
export function worldSubjectId(type: string, nameOrSlug: string): string {
  const t = (type ?? '').trim().toLowerCase();
  return `${t.length > 0 ? t : 'entity'}:${worldSubjectSlug(nameOrSlug)}`;
}

/**
 * 归一匹配键：`<type>:<去连字符/下划线 slug>`。
 *
 * 形态差异全部同键：前缀有无（`shen-yan` vs `character:shen-yan`）、连字符/下划线（`shenyan` vs
 * `shen-yan` vs `shen_yan`）、大小写、空白。只保留「type + 本体字符序」这一身份信号。用于：
 * - 提取器写入面查重复用（shell resolveWorldSubjectIdentity——LLM 连字符习惯逐章漂移，精确 id 查
 *   不到时按本键兜住，复用既有主体不建分身）；
 * - 存量分身合并分组（shell migrateWorldSubjectIds）。
 * ⚠️ 同键 ≠ 必然同实体（极端异名可撞键）——消费面按「同 type + 同键」分组/复用，撞键误合并风险由
 * sourceCardId 卡锚优先规则 + 语义修补 Agent 兜底。
 */
export function worldSubjectMatchKey(type: string, nameOrSlug: string): string {
  const t = (type ?? '').trim().toLowerCase();
  return `${t.length > 0 ? t : 'entity'}:${worldSubjectSlug(nameOrSlug).replace(/[-_]/g, '')}`;
}

/**
 * 无 type 语境的 slug-only 归一键（patch value 内 `subject://<id>` ref 解析用——ref 串不携带 type）。
 * 消费面须**唯一命中才解析**（多义留原值，不臆测——resolveWorldSubjectIdentity 调用方保证）。
 */
export function worldSubjectSlugKey(nameOrSlug: string): string {
  return worldSubjectSlug(nameOrSlug).replace(/[-_]/g, '');
}

// ── WorldSlice（切面，NeuroBook subject-lifecycle §3）──
// slice = 一个 storyTime + 一组 patch。切面是增量（delta）非全量快照——核心诉求是「往前插切面补历史/
// 补设定」，增量模型让后续变更自然叠加。同 storyTime 只能有一个 slice（补同时刻内容先读出再 editPatches）。
// kind 是 timeline/UI/日志的过滤标签，不参与 reduce（开放 string，省略默认 event）。
export const worldSliceSchema = z.object({
  id: z.string().min(1),
  // registry 5 位 projectId（mirror 2.7/2.3，非 meta.id UUID——避跨项目命名空间失配）。
  projectId: z.string().min(1),
  storyTime: z.number().int(),
  // timeline 分类标签（不参与 reduce）；开放 string，省略默认 'event'。
  kind: z.string().optional(),
  title: z.string().min(1),
  summary: z.string().optional(),
  // Story 8.1：slice 所属 episode id（chapter = episode 维度锚，落 closure_world_slice.episode_id 列）。
  // 稳定 slice.id = `${episodeId}:${storyTime}`（mergeWorldEvents 产）已隐含归属，但解析 id 是 magic string
  // 契约（design §7：解析是隐式契约，列是显式契约 + 可索引）——显式字段供 per-episode 查询（listWorldSlices
  // episodeId 过滤 + ChapterStateSummary 物化）。调用方未提供 / 存量行 → undefined（db NULL），查询侧 legacy
  // fallback `slice_id LIKE '<episodeId>:%'`（design §4）。
  episodeId: z.string().min(1).optional(),
});
export type WorldSlice = z.infer<typeof worldSliceSchema>;

// ── WorldPatch（状态变更，NeuroBook subject-lifecycle §3 / schema-system §3）──
// 一条 patch = 对某 subject 的某个 JSON Pointer path 做某 op。path 必须以 / 开头（如 /hp、/equipment/weapon、
// /memory/师门）。value 普通 remove 省略；collection remove 可带 value 按 stable JSON 删元素。
//
// ⚠️ storyTime 从 slice 反范式化到 patch：reduce 是纯函数（无 db / 无 slice 查询），需 per-patch storyTime
// 才能按 storyTime 升序叠加 + 截断 at。Phase B shell repository 读表时 JOIN slice.story_time 填充此字段；
// 提取器写 patch 时已知所属 slice 的 storyTime。DB 层 story_time 仍在 slice 表（design §4 归一化），
// TS 类型层反范式化供 reduce 纯函数用——两层各取所需（db 归一化 / TS reduce 纯度）。
export const worldPatchSchema = z.object({
  id: z.string().min(1),
  sliceId: z.string().min(1),
  subjectId: z.string().min(1),
  // JSON Pointer（RFC 6902），以 / 开头。reduce 内 parsePointer 解析，非法 path → invalid-op issue。
  path: z.string().min(1),
  op: worldPatchOpSchema,
  // 大部分 op 带 value（replace/increment/append/collection-remove）；普通 remove 省略。
  // unknown + optional——合法 JSON 值皆可（NaN/Infinity/Date 等非普通 JSON 由调用方/提取器自律）。
  value: z.unknown().optional(),
  axis: worldPatchAxisSchema,
  source: worldPatchSourceSchema,
  summary: z.string().optional(),
  // 反范式化自 slice（见上注释）——reduce 按 storyTime 排序/截断用。
  storyTime: z.number().int(),
  // Story 6.4 D1（6.2 DW-1）：认知轴 patch 的证据所在 scene id（transmit 场）。可选——仅认知轴填
  // （其他轴不填）。6.2 info-gap 预筛：A 表现知情 X → 查 X.evidenceSceneId 场 A 是否在场。缺失=未提取，降级不预筛。
  evidenceSceneId: z.string().min(1).optional(),
});
export type WorldPatch = z.infer<typeof worldPatchSchema>;

// ── WorldIssue（reduce issues 反馈通道，NeuroBook subject-lifecycle §7 / schema-system §3）──
// E issues（持久数据错误，读时现算，必须修）。6.6 Phase A 两 code：
// - broken-relative：相对 op（increment/append）缺有效基准（missing 或类型错）——跳过该 patch。
// - invalid-op：op-kind 组合非法 / value 类型错 / 非有限数结果——跳过该 patch。
// （NeuroBook 完整 code 表更细；6.6 Phase A 收敛两 code 覆盖 reduce 跳过场景，后续 epic 可扩。）
export const worldIssueCodeSchema = z.enum(['broken-relative', 'invalid-op']);
export type WorldIssueCode = z.infer<typeof worldIssueCodeSchema>;

export const worldIssueSchema = z.object({
  code: worldIssueCodeSchema,
  // 出问题的 patch path（定位用）。
  path: z.string(),
  message: z.string(),
});
export type WorldIssue = z.infer<typeof worldIssueSchema>;

// ── reduce 产出的 subject 状态（嵌套对象，叶由 JSON Pointer path 寻址）──
// reduce 后的 subject 状态 = 嵌套对象（如 { hp:70, equipment:{weapon:'subject://sword-01'}, inventory:[...] }）。
// patch path `/equipment/weapon` → state.equipment.weapon；patch path `/hp` → state.hp。根是 subject 属性容器。
// ref 返 subject://id 字符串本身（不解引用）；调用方要关联视图自己组合多个 reduce（NeuroBook §5/§4）。
export type ReducedState = Record<string, unknown>;

// ── WorldStateSnapshot（Story 6.6 Phase D：消费端反哺用章节级状态快照）──
// brief #6 stateAtT（per scene）+ Reader-Audit 一致基底（chapter-level）共用此 shape。buildWorldStateSnapshot
// 纯函数（world-state-reduce.ts）从 patches 构造：filter at 截断 → 唯一 subjectId 收集（cap）→ 每 subject
// reduceSubject → 可选 attrs 投影。落 shared-contracts：agent（经 query_world_slice builtin 取 patches）+
// shell（经 worldStateRepository 取 patches）两入口共用同 reduce 形态（DRY）。
//
// 范式判据（ADR-3）：snapshot 构造 = 纯代码 reduce（查询/汇编/叠加），无 LLM/无 db/无副作用。「消费 snapshot
// 判是否矛盾」归 Reader-Audit LLM（ADR-3 语义裁判），snapshot 本身只机械 reduce。
//
// 空快照（subjects=[]）合法——表示 at 截断点无已建立状态（首章 / 该 storyTime 前无 events）。消费端据
// subjects.length 判空 graceful（brief-compiler stateAtT → undefined；Reader-Audit worldStateContext → 空段）。
export interface WorldStateSubjectSnapshot {
  /** 主体 id（有 asset_cards 卡的 = 卡 id；无卡的独立 id，如 group:xxx）。 */
  subjectId: string;
  /** 该 subject 在 at 截断点的 reduced 状态（已按 attrs 投影 + storyTime 截断叠加）。 */
  state: ReducedState;
  /** reduce 跳过的 patch 数（broken-relative / invalid-op，NeuroBook E issues）。0 = 干净。 */
  issueCount: number;
}

export interface WorldStateSnapshot {
  /** storyTime 截断点（仅叠加 storyTime <= at 的 patches）；undefined = 取最新（全叠加）。 */
  at?: number;
  /** 涉及 subjects 的 reduced 状态（按 first-seen 序，cap subjectCap 防全量倾倒，NeuroBook §8）。 */
  subjects: WorldStateSubjectSnapshot[];
}

// ── 状态修补 Agent 契约（design §3 / ADR-3 语义裁判归 LLM）──
//
// leader 不直接 write/editPatches——向修补 Agent 发 AmendmentRequest；Agent 读正文 + 当前 reduce 裁判：
// 修补与正文一致则 accept（产 amendmentPatches[]，source='amendment'）；矛盾则 reject（prose 仍是裁判权威
// /真相源，ADR-1/ADR-14）。「修补是否该执行」= 语义判断归 LLM（ADR-3），非纯代码规则。经 runAgentWithExplicitSystem
// 调度（allowedTools=[] 纯判断，mirror 4.5/4.6，orchestration-pattern.md）。

/**
 * 写入时 patch 输入（提取器/修补 Agent 语义输出，无 infra 字段）。
 *
 * 提前声明于此（早于 amendmentDecisionSchema + Phase B IPC schemas 消费）——提取器 / 修补 Agent 的 LLM 输出
 * 形态 + write_world_events / amend_world_state handler 入参形态共用单源（DRY）。
 *
 * ⚠️ 无 source/id/sliceId/storyTime——infra 字段由 shell `insertWorldSlice` 注入（source 由 handler 按 toolId
 * 强制：write_world_events='derived' / amend_world_state='amendment'，防调用方误标；id=randomUUID；
 * sliceId=所属 slice.id；storyTime 反范式自 slice）。
 */
export const worldPatchInputSchema = z.object({
  subjectId: z.string().min(1),
  path: z.string().min(1),
  op: worldPatchOpSchema,
  value: z.unknown().optional(),
  axis: worldPatchAxisSchema,
  summary: z.string().optional(),
  // Story 6.4 D1（6.2 DW-1）：认知轴 patch 证据所在 scene id（提取器产，mirror worldPatchSchema.evidenceSceneId）。
  evidenceSceneId: z.string().min(1).optional(),
});
export type WorldPatchInput = z.infer<typeof worldPatchInputSchema>;

/** 修补请求（leader → 修补 Agent）。 */
export const amendmentRequestSchema = z.object({
  subjectId: z.string().min(1),
  // 问题描述（leader 发现的状态问题，如「主角 HP 应为 50 而非 100」）。
  problemDescription: z.string().min(1),
  // 当前 reduce 状态快照（修补 Agent 裁判输入之一；嵌套对象同 ReducedState）。
  currentState: z.record(z.string(), z.unknown()),
});
export type AmendmentRequest = z.infer<typeof amendmentRequestSchema>;

/** 修补裁决（修补 Agent → leader）。accept 时 amendmentPatches 填（source='amendment' 由 handler 注入）；reject 时空数组。 */
export const amendmentDecisionSchema = z.object({
  // accept：修补与正文一致，执行（写 amendment 覆盖层）；reject：矛盾，不改（prose 为裁判权威）。
  decision: z.enum(['accept', 'reject']),
  // 裁决理由（accept 说明为何改 / reject 说明为何矛盾）——ADR 式 rationale，供 leader/用户复核。
  reason: z.string().min(1),
  // accept 时填修补覆盖层 patches（WorldPatchInput 形态——LLM 可产 + amend_world_state handler 可直接消费；
  // source='amendment' 由 handler 强制注入，id/sliceId/storyTime 由 infra 注入，故 patch 不带这些字段）；
  // reject 时空数组（default）。
  amendmentPatches: z.array(worldPatchInputSchema).default([]),
});
export type AmendmentDecision = z.infer<typeof amendmentDecisionSchema>;

/**
 * parse 修补裁决（world-amender-agent 子 agent 返纯 JSON 对象）。
 *
 * 三路径鲁棒（mirror parseAdjudication P2，对象形态）：① fenced 块（multi-fence tolerant）
 * ② first{..last} brace-match ③ 整体 parse。任一路径提取到合法 AmendmentDecision 即返；
 * 失败返 null（caller graceful 降级——不假 accept，prose 为裁判权威故 reject/降级安全）。
 *
 * 合法性硬要求：decision∈{accept,reject} + reason 非空。accept 时 amendmentPatches 逐条 safeParse
 * （worldPatchInputSchema，丢坏条目保留好条目，mirror parseAxisExtraction 哲学）；reject 时忽略 amendmentPatches。
 *
 * ⚠️ decision trim+toLowerCase 归一（LLM 可能返 "Accept"/"ACCEPT"），mirror parseAdjudication recommendation 容错。
 */
export function parseAmendmentDecision(content: string): AmendmentDecision | null {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return null;

  // 路径 1：fenced 块（multi-fence tolerant）。
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1];
    if (!inner) continue;
    const parsed = tryParseAmendmentDecision(inner);
    if (parsed) return parsed;
  }

  // 路径 2：brace-match（first { to last }）。
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryParseAmendmentDecision(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }

  // 路径 3：整体试 parse（无 fence 单对象）。
  const whole = tryParseAmendmentDecision(trimmed);
  if (whole) return whole;

  return null;
}

/** 单候选字符串试 parse + shape 校验为 AmendmentDecision（失败返 null）。 */
function tryParseAmendmentDecision(candidate: string): AmendmentDecision | null {
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  // decision trim+toLowerCase 归一（LLM 可能返 "Accept"/"REJECT"）。
  const decisionRaw = typeof o.decision === 'string' ? o.decision.trim().toLowerCase() : '';
  const decision = decisionRaw === 'accept' || decisionRaw === 'reject' ? decisionRaw : null;
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  if (!decision || !reason) return null; // 硬要求：decision + reason
  // amendmentPatches 逐条 safeParse（worldPatchInputSchema，丢坏条目保留好条目）。
  const patchesRaw = Array.isArray(o.amendmentPatches) ? o.amendmentPatches : [];
  const amendmentPatches: WorldPatchInput[] = [];
  for (const p of patchesRaw) {
    const parsed = worldPatchInputSchema.safeParse(p);
    if (parsed.success) amendmentPatches.push(parsed.data);
  }
  return { decision, reason, amendmentPatches };
}

// ── Story 6.6 Phase B：IPC handler 入参 schemas（shell handler 校验 + agent tool 描述共用单源）──
//
// 落 shared-contracts（mirror closureStoryQuerySchema 模式）：shell 包不直接依赖 zod，handler 校验
// 复用此处 schema；agent builtin.ts tool 描述也复用（避免 query_story 那样 inline + shared 双份漂移）。
// handler 从 projectDir 解析 projectId（mirror query_story），故 tool 入参均不含 projectId。
//
// ⚠️ 写入 patch 输入（worldPatchInputSchema，已在上方「状态修补 Agent 契约」段提前声明）无 source/id/
// sliceId/storyTime——infra 字段由 shell `insertWorldSlice` 注入（source 由 handler 按 toolId 强制：
// write_world_events='derived' / amend_world_state='amendment'，防调用方误标；id=randomUUID；
// sliceId=所属 slice.id；storyTime 反范式自 slice）。

/** 写入时 slice 输入（caller 提供 id/storyTime/title；projectId 由 handler 解析注入）。 */
export const worldSliceInputSchema = worldSliceSchema.omit({ projectId: true });
export type WorldSliceInput = z.infer<typeof worldSliceInputSchema>;

/** 主体登记输入（首次出现时建；复用 WorldSubject schema）。 */
export const worldSubjectInputSchema = worldSubjectSchema;

/** query_world_state handler/tool 入参。 */
export const queryWorldStateRequestSchema = z.object({
  subjectId: z.string().min(1),
  at: z.number().int().optional(),
  attrs: z.array(z.string().min(1)).optional(),
});
export type QueryWorldStateRequest = z.infer<typeof queryWorldStateRequestSchema>;

/** query_world_slice handler/tool 入参（收窄 subjectIds/type/at，可选附 patches）。 */
export const queryWorldSliceRequestSchema = z.object({
  subjectIds: z.array(z.string().min(1)).optional(),
  type: z.string().optional(),
  withPatches: z.boolean().optional(),
  at: z.number().int().optional(),
  // Story 6.4 D4（6.1 DW）：axis filter（cognitive/physical/emotional/relational/factional）——
  // 单轴查询不扫全轴（规模耐受，memory 6.1 DW 延 6.4）。仅过滤 withPatches 返回的 patches；不传则全部轴。
  // CR Blind-4：用 worldPatchAxisSchema enum（防拼写错静默空），与 listWorldPatches 类型签名一致。
  axis: worldPatchAxisSchema.optional(),
});
export type QueryWorldSliceRequest = z.infer<typeof queryWorldSliceRequestSchema>;

/** find_world_refs handler/tool 入参。 */
export const findWorldRefsRequestSchema = z.object({
  subjectId: z.string().min(1),
});
export type FindWorldRefsRequest = z.infer<typeof findWorldRefsRequestSchema>;

/**
 * write_world_events / amend_world_state 共享入参（slice + patches + 可选 subjects）。source 区分由
 * toolId 决定（handler 强制），故 patches 不带 source。subjects default []——首次提取自动建主体时填。
 */
export const writeWorldStateRequestSchema = z.object({
  slice: worldSliceInputSchema,
  patches: z.array(worldPatchInputSchema),
  subjects: z.array(worldSubjectInputSchema).default([]),
});
export type WriteWorldStateRequest = z.infer<typeof writeWorldStateRequestSchema>;

// ── Story 8.1：checkpoint 缓存 + ChapterStateSummary（百万字长程有界化，design §3）──
//
// 8.1 = 6.6 派生索引之上的二级派生缓存：checkpoint 把 reduce fold 成本从 O(总史) 压到 O(单 subject 增量窗)；
// per-episode ChapterStateSummary 把「前情」从 O(章正文) 压到 O(章摘要)。两者 DERIVED 可 drop 重建（prose 仍是
// 唯一文件真相源，ADR-1/14 不变）。seeded reduce 原语（applyPatches）+ 摘要汇编纯函数落 world-state-reduce.ts。
//
// 范式判据（ADR-3）：六字段全部「查询/汇编/确定性计算」over 既有 LLM 已产结构化数据（patches/subjects/
// promise_registry）；salience 取舍 = 活跃序 + cap（既有 subjectCap 哲学），不判「谁重要」（若未来要判 = LLM，
// 8.2+ 事）。
//
// ⚠️ 命名空间：「世界状态 checkpoint」（下方 SubjectCheckpoint，reduce 折叠态缓存）与 agent 运行时 runLoop 的
// RunCheckpoint（runState.ts，pause/resume 编排语义）是**不同概念不同命名空间**，注释互指防混。

/**
 * checkpoint 增量阈值（design §3.1 Q2 定案：不做「每 N 章全量 subject 扫描」，做增量阈值式）。
 * 每次章物化时对本次触及 subject，若距其上一 checkpoint 的折叠增量 ≥ 此值则在其本章末 storyTime 写 checkpoint。
 * fold 窗上界 = 25 patches/subject（远小于全史）；checkpoint 行数 = O(总 patches / 25)。最终值待 synthetic
 * 压测校准（design §10）。
 */
export const CHECKPOINT_MIN_PATCH_DELTA = 25;

/** 单 subject 折叠态 checkpoint（storyTime 截断点处的 reduce 结果缓存）。 */
export interface SubjectCheckpoint {
  /** registry 5 位 projectId（mirror closure_world_* 既有表）。 */
  projectId: string;
  subjectId: string;
  /** 截断点（某章末 storyTime）。有效性 belt：不存在 patch: rowid > patchRowidHigh 且 storyTime <= atStoryTime。 */
  atStoryTime: number;
  /** 该点折叠态（含 amendment 叠加）；seeded reduce 起点 = applyPatches(state, window)（world-state-reduce.ts）。 */
  state: ReducedState;
  /** reduce 至该点累计 issue 数（checkpoint 不存 issue 明细——快照 issueCount = 本值 + 窗口 issues.length）。 */
  issueCount: number;
  /** 水印：已折叠的最大 patch rowid（显式失效漏网路径〔重写 slice 产零 patch / 手动改库〕的 belt 校验用）。 */
  patchRowidHigh: number;
  /** 观测：折叠的 patch 数（8.3 cognition/presence per-character checkpoint 化评估数据，design §10）。 */
  patchCountFolded: number;
}

// ── ChapterStateSummary 六字段（design §3.3，全纯代码汇编）──

/** ① 角色终态条目（活跃 cast = 本章 N 与前两章 N-1、N-2 内有 patch 的 subjects，最近活跃序 cap）。 */
export const characterEndStateSchema = z.object({
  subjectId: z.string().min(1),
  name: z.string().optional(),
  type: z.string().min(1),
  /** 本章末折叠态（ReducedState 形态，嵌套对象）。 */
  state: z.record(z.string(), z.unknown()),
});
export type CharacterEndState = z.infer<typeof characterEndStateSchema>;

/**
 * ①b Oracle dormant 标记（曾出场但连续 3 章含本章无 patch——「仅增量 diff」落地：摘要不重复携带不变终态，
 * 需要全量者走 query_world_state〔checkpoint-backed〕或按 lastChangedEpisodeId 回溯那章摘要）。
 */
export const oracleDormantEntrySchema = z.object({
  subjectId: z.string().min(1),
  name: z.string().optional(),
  lastChangedEpisodeId: z.string().optional(),
});
export type OracleDormantEntry = z.infer<typeof oracleDormantEntrySchema>;

/** ② 关系温度变化条目（本章 relational 轴 patch 摘录；summary 是提取器 LLM 写的自然语言，缺省机械回退 op+path）。 */
export const relationshipChangeSchema = z.object({
  subjectId: z.string().min(1),
  path: z.string().min(1),
  summary: z.string().optional(),
  storyTime: z.number().int(),
});
export type RelationshipChange = z.infer<typeof relationshipChangeSchema>;

/** Promise 派生阶段前后差（③：from = 本章前 beats 派生 / to = 至本章末 beats 派生；新 Promise from=unplanted 恒可算）。 */
export const promiseStageChangeSchema = z.object({
  from: promiseDerivedStageSchema,
  to: promiseDerivedStageSchema,
});
export type PromiseStageChange = z.infer<typeof promiseStageChangeSchema>;

/** ③ 伏笔状态变更条目（per beat：本章窗内 promise beat + derivePromiseStage 前后差）。 */
export const foreshadowChangeSchema = z.object({
  promiseId: z.string().min(1),
  title: z.string().min(1),
  stageChange: promiseStageChangeSchema,
  beatKind: promiseBeatKindSchema,
  sceneRef: z.string().min(1),
});
export type ForeshadowChange = z.infer<typeof foreshadowChangeSchema>;

/** ④ 新引入实体条目（firstSeenStoryTime ∈ 本章 slices 窗的 subjects）。 */
export const newEntitySchema = z.object({
  subjectId: z.string().min(1),
  type: z.string().min(1),
  name: z.string().optional(),
  sourceCardId: z.string().optional(),
});
export type NewEntity = z.infer<typeof newEntitySchema>;

/** ⑤ 未决承诺条目（status open 且至本章末派生态非 paid_off）。 */
export const openPromiseEntrySchema = z.object({
  promiseId: z.string().min(1),
  title: z.string().min(1),
  stage: promiseDerivedStageSchema,
  deadlineEpisodeId: z.string().optional(),
});
export type OpenPromiseEntry = z.infer<typeof openPromiseEntrySchema>;

/** ⑥ 下章回收清单条目（beats 落在下一 episode 的场 OR deadlineEpisodeId = 下一 episode）。 */
export const nextChapterPayoffSchema = z.object({
  promiseId: z.string().min(1),
  title: z.string().min(1),
  note: z.string().optional(),
});
export type NextChapterPayoff = z.infer<typeof nextChapterPayoffSchema>;

// 字段级 cap（design §3.3 token 预算：超预算截断不静默——truncated 标记；最终值待压测校准 design §10）。
// oracleDormant / foreshadowChanges 的 cap 是 Story 8.2 回填（8.1 deferred-work 关闭）：**机械防爆上限
// 非预算**——用户 2026-08-17 拍板认账（实测章摘要 median 1302 / max 1436，不追 ~500 预算目标；弧 agent
// 通读正文后章摘要角色 = 导航地图）。50000 级只为挡「条目数 = bug 级爆炸」（如提取器回归产出全史倾倒），
// 正常量级（dormant 条目极小 / 本章 beats 少）永不触及 = 零行为变化。
export const CHARACTER_END_STATES_CAP = 12;
export const RELATIONSHIP_CHANGES_CAP = 20;
export const NEW_ENTITIES_CAP = 20;
export const OPEN_PROMISES_CAP = 20;
export const NEXT_CHAPTER_PAYOFFS_CAP = 15;
export const ORACLE_DORMANT_CAP = 50000;
export const FORESHADOW_CHANGES_CAP = 50000;

/**
 * ChapterStateSummary（每章结构化摘要〔~500 token 预算〕，六字段全纯代码汇编，design §3.3）。落
 * closure_chapter_summary（DERIVED 可 drop 重建）；消费 = query_chapter_summary 查询工具 + 8.2 分弧折叠 reader。
 *
 * episodeIndex / storyTimeStart / storyTimeEnd nullable：源缺失（episode_outlines 无 index / 本章无 slices）时
 * graceful 降级 null + degradedNote，不造数（design §5「缺源 graceful」哲学；db 列 episode_index/story_time_end
 * 同为 nullable，design §4）。
 */
export const chapterStateSummarySchema = z.object({
  episodeId: z.string().min(1),
  /** 本章 episode index 冗余快照；null = 源缺失——dormancy 判定降级（见 assembleChapterStateSummary）。 */
  episodeIndex: z.number().int().nullable(),
  /** 本章 slices storyTime 窗（闭区间 [start, end]）；null = 本章无已提取 events。 */
  storyTimeStart: z.number().int().nullable(),
  storyTimeEnd: z.number().int().nullable(),
  // Story 8.7（R5）：章级一段话梗概——写手出场申报产物（castDeclarationSchema.synopsis 递入，
  // mention-ledger 物化时回填）。additive optional -> 零 migration（mirror tier 字段先例）：缺申报 /
  // 降级直写 / 修订失效章 undefined 不编造（mirror degradedNote 哲学——梗概是语义产物，纯代码不合成）。
  synopsis: z.string().optional(),
  characterEndStates: z.array(characterEndStateSchema).max(CHARACTER_END_STATES_CAP).default([]),
  oracleDormant: z.array(oracleDormantEntrySchema).max(ORACLE_DORMANT_CAP).default([]),
  relationshipChanges: z.array(relationshipChangeSchema).max(RELATIONSHIP_CHANGES_CAP).default([]),
  foreshadowChanges: z.array(foreshadowChangeSchema).max(FORESHADOW_CHANGES_CAP).default([]),
  newEntities: z.array(newEntitySchema).max(NEW_ENTITIES_CAP).default([]),
  openPromises: z.array(openPromiseEntrySchema).max(OPEN_PROMISES_CAP).default([]),
  nextChapterPayoffs: z.array(nextChapterPayoffSchema).max(NEXT_CHAPTER_PAYOFFS_CAP).default([]),
  /** 任一 cap 字段被截断 → true（超预算截断不静默）。 */
  truncated: z.boolean().default(false),
  /** 源缺失降级说明（promise_registry 缺 / episode index 缺等；多条 '；' 连接）。 */
  degradedNote: z.string().optional(),
});
export type ChapterStateSummary = z.infer<typeof chapterStateSummarySchema>;

// ── Story 8.1 IPC 请求 schemas（handler 校验 + agent tool 描述共用单源，mirror 既有 request schema 风格）──

/** build_world_snapshot 的 ats 批量上限（防滥用，design §10 定案 ~32）。 */
export const BUILD_WORLD_SNAPSHOT_ATS_MAX = 32;

/** query_chapter_summary 单次调用 episode 数上限（episodeIds 维度 schema 强制；fromIndex/toIndex 范围由 handler 收窄至此）。 */
export const QUERY_CHAPTER_SUMMARY_EPISODE_CAP = 50;

/** build_world_snapshot handler/tool 入参（ats 批量 / at 单点；projection 默认 'state'）。 */
export const buildWorldSnapshotRequestSchema = z
  .object({
    /** 批量 storyTime 截断点（brief #6 各场一次 IPC）；与 at 二选一。 */
    ats: z.array(z.number().int()).max(BUILD_WORLD_SNAPSHOT_ATS_MAX).optional(),
    /** 单点截断（Reader-Audit 基底 / cognition / presence 投影）；与 ats 二选一。 */
    at: z.number().int().optional(),
    subjectCap: z.number().int().positive().optional(),
    attrs: z.array(z.string().min(1)).optional(),
    /** 'state'（默认：brief #6 / Reader-Audit 基底）| 'cognition'（6.2）| 'presence'（6.4）——shell 侧投影。 */
    projection: z.enum(['state', 'cognition', 'presence']).optional(),
  })
  // CR-2（8.1 修复批）：ats 与 at 互斥强制（原注释「二选一」无 schema 约束——同传时 handler 静默取 at，
  // 批量请求被吞）。两者都缺省 = 合法（取最新）。refine 在 object 层（superRefine 不需——无路径定位需求）。
  .refine((v) => !(v.ats !== undefined && v.at !== undefined), {
    message: 'ats 与 at 互斥（二选一；都缺省 = 取最新）',
  });
export type BuildWorldSnapshotRequest = z.infer<typeof buildWorldSnapshotRequestSchema>;

/** query_chapter_summary handler/tool 入参（三选一收窄，mirror slice.list 收窄哲学）。 */
export const queryChapterSummaryRequestSchema = z.object({
  // CR-1（8.1 修复批）：episodeIds 空数组曾是「已提供」态（handler hasIds 判 !== undefined）→ 绕过收窄
  // 全表倾倒。min(1) 在 schema 层闭死；handler 侧 hasIds 判 length 作 belt。
  episodeIds: z
    .array(z.string().min(1))
    .min(1)
    .max(QUERY_CHAPTER_SUMMARY_EPISODE_CAP)
    .optional(),
  fromIndex: z.number().int().optional(),
  toIndex: z.number().int().optional(),
});
export type QueryChapterSummaryRequest = z.infer<typeof queryChapterSummaryRequestSchema>;

/** materialize_chapter_summary handler/tool 入参（handler 强制 source 语义，mirror writeWorldStateRequest 哲学）。 */
export const materializeChapterSummaryRequestSchema = z.object({
  episodeId: z.string().min(1),
});
export type MaterializeChapterSummaryRequest = z.infer<typeof materializeChapterSummaryRequestSchema>;
