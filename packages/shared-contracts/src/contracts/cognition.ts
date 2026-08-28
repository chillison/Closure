import type { ReducedState, WorldPatch } from './world-state';
import { applyPatches, reduceSubject } from './world-state-reduce';
import type { SceneNode } from './creative-fields';

// ── Story 6.1：CognitionGraph 查询层 + perspective 层（design §2/§3 / ADR-3 / ADR-14 / conclusions §3.6/§3.7）──
//
// 6.6 已建轴无关 reduce 引擎（reduceSubject/buildWorldStateSnapshot）+ 认知轴提取器 + patch value 可选
// {objective, reader_perceived} 分层约定。6.1 在其上「升级消费」（world-state.ts:34）：
// - CognitionGraph = per-character `knows_at_time_t` 查询层（纯函数，**不建表**——照 §3.1「不存当前状态只存
//   变更条目」+ brief-compiler compileSceneStateAtT 先例；查询走既有 closure_world_patch.axis='cognitive'）。
// - perspective 层正式化：三视角（客观/作者设计 vs 读者感知 vs 角色感知=认知轴，§3.6）+ gap **检测**纯函数。
//
// 🔑 范式判据（ADR-3 / creative-vs-mechanical）：CognitionGraph reduce/projection + gap 检测 = 纯代码
// （查询/汇编/结构比较，无 LLM/无 db/无副作用）；**叙事工具命名（伏笔/戏剧反讽/悬念/误导）= 语义归 LLM**
// （提取器 flag / 6.5 Promise 涌现）。dramatic_irony 与 suspense 纯结构上重叠（都 reader>character），区分
// 需叙事意图判断 → 不进纯代码。detectPerspectiveGap 只报「哪些视角分歧 + 方向」，不命名工具。
//
// 落点 shared-contracts（design §5）：纯函数 DRY 跨包（shell cognition query handler + agent cognition query
// builtin + brief-compiler 可选 cognition 投影共用）。零 migration（新文件）。
//
// expected_downstream_consumers:
// - Story 6.1 Phase B/C：shell query_cognition IPC handler + agent builtin（取 patches → 本函数 reduce）。
// - Story 6.2：KNOWLEDGE_VIOLATION/FORGOTTEN_REVEAL 检测的消费侧——查 getCognitionAtTime 判角色 @ storyTime 认知。
// - Story 6.5：PerspectiveGap shape + detectPerspectiveGap = Promise 涌现输入（LLM 读 gap 信号 + 正文登记 Promise）。

// ── CognitionGraph 查询（纯函数，消费认知轴 patches）──

/**
 * 查某角色在虚构时刻 t 的认知状态（CognitionGraph `knows_at_time_t`）。纯函数。
 *
 * 预过滤 `axis==='cognitive'` patches → reduceSubject（轴无关，复用 6.6 reduce）→ 返该角色在 t 的认知字典
 * （knows/believes/misunderstands/suspects 等，value 可含 {objective, reader_perceived} 分层）。
 *
 * @param patches            全部候选 patches（自行 filter cognitive + 截断 at；通常传项目全集）。
 * @param characterSubjectId 角色 subject id（6.6 认知提取器产的 cognitive-axis subject）。
 * @param at                 storyTime 截断点（仅叠加 storyTime <= at）；undefined = 取最新（全叠加）。
 * @returns                  该角色在 t 的 reduced 认知状态（嵌套对象，叶由 path 寻址）。
 */
export function getCognitionAtTime(
  patches: readonly WorldPatch[],
  characterSubjectId: string,
  at?: number,
): ReducedState {
  const cognitive = patches.filter((p) => p.axis === 'cognitive');
  const { state } = reduceSubject(cognitive, characterSubjectId, at);
  return state;
}

/**
 * per-scene 物化：该场 storyTime 截断点下所有角色的认知（CognitionGraph 节点）。纯函数。
 *
 * mirror brief-compiler `compileSceneStateAtT` 姿态，但**仅认知轴 + per-character**（stateAtT 是全轴 capped
 * snapshot 混轴；本函数只取 cognitive patches 逐角色 reduce → 角色认知纯净视图）。
 *
 * @param scene   目标场（取 scene.storyTime 截断；挂场景 = CognitionGraph 节点关联 SceneNode.storyTime）。
 * @param patches 全部候选 patches（自行 filter cognitive + 截断 scene.storyTime）；undefined/空 → undefined（graceful）。
 * @returns       { [characterSubjectId]: 认知状态 } 或 undefined（无 cognitive patches / 该 storyTime 前无认知）。
 */
export function compileCognitionForScene(
  scene: SceneNode,
  patches: readonly WorldPatch[] | undefined,
): Record<string, ReducedState> | undefined {
  if (!patches || patches.length === 0) return undefined;
  const cognitive = patches.filter((p) => p.axis === 'cognitive' && p.storyTime <= scene.storyTime);
  if (cognitive.length === 0) return undefined;
  // 收集 cognitive patches 涉及的唯一 subjectId（= 角色，first-seen 序），逐个 reduce。
  const subjectIds: string[] = [];
  const seen = new Set<string>();
  for (const p of cognitive) {
    if (p.subjectId && !seen.has(p.subjectId)) {
      seen.add(p.subjectId);
      subjectIds.push(p.subjectId);
    }
  }
  const result: Record<string, ReducedState> = {};
  for (const subjectId of subjectIds) {
    const { state } = reduceSubject(cognitive, subjectId, scene.storyTime);
    // 丢空状态角色（该角色在该 storyTime 前无 populated 认知）——免噪音。
    if (Object.keys(state).length > 0) result[subjectId] = state;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ── perspective 层（三视角投影 + gap 检测纯函数）──
//
// 三视角（§3.6）：objective（客观/作者设计）/ readerPerceived（读者感知）/ characterPerceived（角色感知=
// 认知轴本身）。认知轴/关系轴 patch value 可选分层 {objective, reader_perceived}（6.6 约定，非 schema 字段，
// world-state.ts:60-61）；projectPerspective 把分层 value 投影成 views，detectPerspectiveGap 比较分歧。
//
// 空间永在（optional）：不是每 fact 都有三视角（§3.6「填不填由 LLM 读正文定」）。投影只组装存在的。

export interface PerspectiveViews {
  /** 客观/作者设计（value 内 objective 层，或跨轴 fact-join 调用方填——跨轴 join 归 6.5，DW-6）。 */
  objective?: unknown;
  /** 读者感知（value 内 reader_perceived 层，或调用方填）。 */
  readerPerceived?: unknown;
  /** 角色感知（认知轴 value 本身，§3.6）；单值 value 时为此，分层 value 时由调用方跨轴填。 */
  characterPerceived?: unknown;
}

/** 三视角结构性分歧方向（§3.7 矩阵的方向信号；叙事工具命名归 LLM，不进此枚举）。 */
export const PERSPECTIVE_DIVERGENCES = [
  'objective_vs_reader',
  'objective_vs_character',
  'reader_vs_character',
] as const;
export type PerspectiveDivergence = (typeof PERSPECTIVE_DIVERGENCES)[number];

/**
 * perspective gap 检测结果（纯结构性，6.5 Promise 涌现输入 shape）。
 *
 * 纯代码只报「哪些视角存在 + 哪些彼此分歧」；「这 gap 是伏笔/戏剧反讽/悬念/误导 + 是不是 Promise」= 语义
 * 归 LLM（提取器 flag / 6.5 涌现登记）。dramatic_irony 与 suspense 纯结构重叠，纯代码不区分。
 */
export interface PerspectiveGap {
  factPath: string;
  hasObjective: boolean;
  hasReaderPerceived: boolean;
  hasCharacterPerceived: boolean;
  divergences: PerspectiveDivergence[];
}

// ── 内部 helper（read-only JSON Pointer 寻址 + layered 判定 + stable JSON 比较）──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 判 value 是否承载 perspective 分层。reader_perceived 是强信号（非常用词）；
 * 单独 objective 不够——"objective" 是常用词（如 {objective:'任务目标'} 非分层，CR-E4）。
 * 要求 reader_perceived 在场（认知提取器 prompt 约定分层必含 reader_perceived 键）。
 */
function isLayeredValue(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return 'reader_perceived' in v;
}

/** 解析 JSON Pointer path → 段数组（mirror world-state-reduce parsePointer；'' → []，非 / 开头 → null）。 */
function parsePointer(path: string): string[] | null {
  if (path === '') return [];
  if (!path.startsWith('/')) return null;
  return path.split('/').slice(1).map((tok) => tok.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** 按 JSON Pointer 从 reduced state read-only 取值（mirror world-state-reduce getState；无写入）。 */
function getValueByPointer(root: ReducedState, pointer: string): unknown {
  const segments = parsePointer(pointer);
  if (segments === null) return undefined;
  let cur: unknown = root;
  for (const seg of segments) {
    if (isPlainObject(cur)) cur = cur[seg];
    else if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else return undefined;
  }
  return cur;
}

/** stable JSON 相等（plain object key 排序递归，{a:1,b:2}==={b:2,a:1}；非 JSON 值由调用方自律）。 */
function jsonEqual(a: unknown, b: unknown): boolean {
  return stableJsonStringify(a) === stableJsonStringify(b);
}

function stableJsonStringify(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJsonStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableJsonStringify((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

/**
 * 从角色认知 state 按 factPath 投影出 perspective views。纯函数。
 *
 * - value 是分层对象 {objective, reader_perceived} → 投影 {objective, readerPerceived}（角色真实 vs 展示，
 *   认知轴 concealment / 关系轴读者感知的常见形态）。
 * - value 单值 → 投影 {characterPerceived: value}（角色主观认知，无分层）。
 * - factPath 不存在 → 空 views {}（无该 fact 认知）。
 *
 * @param cognition getCognitionAtTime 产的角色认知 state（嵌套对象）。
 * @param factPath  JSON Pointer（如 '/believes/国王'），定位认知字典内某 fact 的 value。
 */
export function projectPerspective(cognition: ReducedState, factPath: string): PerspectiveViews {
  const value = getValueByPointer(cognition, factPath);
  if (value === undefined) return {};
  if (isLayeredValue(value)) {
    const v = value as { objective?: unknown; reader_perceived?: unknown };
    return { objective: v.objective, readerPerceived: v.reader_perceived };
  }
  return { characterPerceived: value };
}

/**
 * 检测 perspective views 结构性分歧（哪些视角存在 + 哪些彼此不同）。纯函数，不命名叙事工具。
 *
 * 三视角全一致 / 仅一视图存在 / 全空 → null（无 gap）。≥2 视图存在且至少一对分歧 → PerspectiveGap。
 * stable JSON 比较（结构相同即等）。divergences 列出分歧视角对（§3.7 矩阵的方向信号）。
 *
 * 🔑 不裁判语义：返「objective_vs_reader 分歧」纯代码能定；「这是伏笔还是悬念」「是不是 Promise」归 LLM。
 *
 * @param views    projectPerspective 产或调用方跨轴 fact-join 组装的三视角。
 * @param factPath 该 gap 所属的 fact（JSON Pointer，供 6.5 Promise 登记 + 6.2 定位）。
 */
export function detectPerspectiveGap(views: PerspectiveViews, factPath: string): PerspectiveGap | null {
  const hasObjective = views.objective !== undefined;
  const hasReader = views.readerPerceived !== undefined;
  const hasCharacter = views.characterPerceived !== undefined;
  const divergences: PerspectiveDivergence[] = [];
  if (hasObjective && hasReader && !jsonEqual(views.objective, views.readerPerceived)) {
    divergences.push('objective_vs_reader');
  }
  if (hasObjective && hasCharacter && !jsonEqual(views.objective, views.characterPerceived)) {
    divergences.push('objective_vs_character');
  }
  if (hasReader && hasCharacter && !jsonEqual(views.readerPerceived, views.characterPerceived)) {
    divergences.push('reader_vs_character');
  }
  if (divergences.length === 0) return null;
  return {
    factPath,
    hasObjective,
    hasReaderPerceived: hasReader,
    hasCharacterPerceived: hasCharacter,
    divergences,
  };
}

// ── Story 6.2：typed BeliefStatus 投影层（design §3 / R4）──
//
// 认知轴 patch value 是自由 JSON 字典（/knows/<fact> /believes/<topic> /suspects/<target> /misunderstands/<x>，
// event-extractor-cognitive.yaml:23-24,31 明文禁硬编码 BeliefStatus/EpistemicStatus 枚举——「状态分类是 6.2 检测层
// 的工作，本轴只记角色主观以为的内容」）。6.1 D4 把 typed BeliefStatus 引入延后到 6.2。
//
// 本段加**投影纯函数**把自由结构投成 typed `BeliefStatus` 视图，供纯代码结构查询（R2/R3 transmit 场/状态回退
// 机械预筛 DW-1）+ L2 Reader-Audit 读结构化认知（cognition_snapshot → cognitionContext）。**不动认知轴自由 JSON
// 本体**（投影层 additive，design D2）。
//
// 🔑 范式判据（ADR-3 / creative-vs-mechanical）：path key 前缀 → status 是**结构性映射**（key 名即分类，纯代码可判）
// ——knows/believes→believes_true / suspects→suspects / misunderstands→believes_false / absent key→unaware（消费侧
// 语义：fact 不在视图 = 角色不知道 = unaware）。**灰区不细分归 L2**：believes key 的 value 若含强怀疑语义，纯代码
// 不判（归 believes_true，是否真怀疑归 L2 语义，design §11 风险 D2）。违规「是否真表现知情」= 语义归 L2，不在投影里判。
//
// expected_downstream_consumers:
// - Story 6.2：cognition_snapshot（caller chain 启动前取）= per-character CharacterBeliefView 投影 → Reader-Audit
//   L2 判 KNOWLEDGE_VIOLATION（视图无/transmit 场未在场却表现知情）/ FORGOTTEN_REVEAL（前章 believes_true 本章写不知）。
// - Story 4.4（cross-arc 完整性）：BeliefStatus 投影视图可被 4.4 消费做 cross-arc 认知一致性（接口预留，blocked E5）。
// - Story 8.1：ChapterStateSummary 物化含认知终态（per-character CharacterBeliefView 形态）。
// - 同人 OOC 维（未来）：BeliefStatus + 认知状态机是 OOC 检测基底（角色行为 vs 既定认知）。

/** typed BeliefStatus（FR-311 BeliefStatus 半边，PlotLens R3 §2.1 4 值；认知轴自由 JSON 的投影目标）。 */
export const BELIEF_STATUSES = ['believes_true', 'unaware', 'suspects', 'believes_false'] as const;
export type BeliefStatus = (typeof BELIEF_STATUSES)[number];

/**
 * 单个角色对单个 fact 的 typed 认知投影项。
 *
 * - path：JSON Pointer（如 '/believes/国王'），对齐 projectPerspective/detectPerspectiveGap 的 factPath 约定，
 *   供 L2 定位 + 跨轴 fact-join（6.5 Promise 涌现 / 6.2 transmit 场查）。
 * - status：path key 前缀推断的结构分类（knows/believes→believes_true / suspects→suspects /
 *   misunderstands→believes_false）。**absent key → unaware**（消费侧：fact 不在 facts[] = 角色 unaware）。
 * - value：原始 value（投影不改变认知轴数据；可能为分层 {objective, reader_perceived}）。
 * - hasReaderPerceivedLayer：value 是否承载 perspective 分层（reader_perceived 键在场 = 角色表象 vs 真实分歧，
 *   白名单信号——KNOWLEDGE_VIOLATION 可能是叙述视角差/伪装，不报）。
 */
export interface CharacterFactBelief {
  path: string;
  status: BeliefStatus;
  value: unknown;
  hasReaderPerceivedLayer: boolean;
}

/**
 * 单个角色的 typed 认知投影视图（@ 截断 storyTime，通常 chain 启动前 = 前章累积认知）。
 *
 * facts[] 只含认知轴 patch 显式登记的 fact（knows/believes/suspects/misunderstands 字典内的项）。**未登记的
 * fact = 角色 unaware**（消费侧据 facts[] 缺该 fact 判 unaware，L2 查「视图里无 X 但正文表现知情」→ KNOWLEDGE_VIOLATION）。
 */
export interface CharacterBeliefView {
  characterSubjectId: string;
  facts: CharacterFactBelief[];
}

/** 认知轴字典 key → BeliefStatus 结构映射（key 名即分类，纯代码可判；§3.6「可错」自由 JSON 约定）。 */
const COGNITION_KEY_TO_STATUS: Record<string, BeliefStatus> = {
  knows: 'believes_true',
  believes: 'believes_true',
  suspects: 'suspects',
  misunderstands: 'believes_false',
};

/**
 * 把角色的认知 state（自由 JSON 字典）投成 typed BeliefStatus 视图。纯函数，不改输入。
 *
 * 遍历 cognition 顶层 key（knows/believes/suspects/misunderstands）→ 每个嵌套 factId 产 CharacterFactBelief。
 * path key 前缀推断 status（结构映射）；分层 value 标 hasReaderPerceivedLayer（reader_perceived 键在场）。
 *
 * - 未识别的顶层 key（非 knows/believes/suspects/misunderstands）→ 跳过（认知轴自由 JSON，不强加枚举）。
 * - 非对象 bucket → 跳过（防御畸形提取，graceful）。
 * - 空 cognition / 全空 → { characterSubjectId, facts: [] }（消费侧：该角色 unaware 所有 fact）。
 *
 * 🔑 灰区不细分（design §11 D2）：believes key 的 value 若含怀疑语义，纯代码归 believes_true（不判「真怀疑」，
 * 那归 L2）。dramatic_irony/suspense 的叙事意图区分同 detectPerspectiveGap 般不进纯代码。
 *
 * @param cognition          getCognitionAtTime 产的角色认知 state（嵌套对象 {knows:{...},believes:{...},...}）。
 * @param characterSubjectId 角色 subject id（透传到视图，供 L2 定位 + cognition_snapshot 多角色聚合）。
 */
export function projectBeliefStatus(
  cognition: ReducedState,
  characterSubjectId: string,
): CharacterBeliefView {
  const facts: CharacterFactBelief[] = [];
  for (const [key, bucket] of Object.entries(cognition)) {
    const status = COGNITION_KEY_TO_STATUS[key];
    if (!status) continue; // 未识别顶层 key → 跳过（自由 JSON，不强制枚举）
    if (!isPlainObject(bucket)) continue; // 防御畸形提取
    for (const [factId, value] of Object.entries(bucket)) {
      facts.push({
        path: `/${key}/${factId}`,
        status,
        value,
        hasReaderPerceivedLayer: isLayeredValue(value),
      });
    }
  }
  return { characterSubjectId, facts };
}

/**
 * CognitionSnapshot（Story 6.2：Reader-Audit 认知状态机维数据源，mirror WorldStateSnapshot 姿态）。
 *
 * caller chain 启动前取（write_chapter tool / closureChainIpc）→ initialArtifacts['cognition_snapshot'] →
 * Reader-Audit buildPrompt cognitionContext var。**不在 Reader-Audit requiredArtifactKeys**（optional 消费，
 * mirror world_state_snapshot/promise_registry 哲学——首章/无前章认知/fetch 失败 → 缺 → 空段降级）。
 *
 * 捕获时机 = chain 启动前（此时 closure_world_state 仅含前章 events，本章认知提取器在 draft 后跑）→
 * snapshot 自然反映「截至本章前的角色认知状态」（前章积累的 believes_true 等），L2 对照本章 draft 判
 * FORGOTTEN_REVEAL（前章已知 vs 本章写不知）无循环自证（mirror world_state_snapshot 基底逻辑）。
 */
export interface CognitionSnapshot {
  /** per-character BeliefStatus 投影视图（前章累积认知；空数组 = 无 cognitive patches / 首章）。 */
  characters: CharacterBeliefView[];
}

/**
 * 从 patches 构造 CognitionSnapshot（filter cognitive → per-character reduce → projectBeliefStatus）。纯函数。
 *
 * 落 shared-contracts（DRY）：agent fetchCognitionSnapshotViaTool（经 query_world_slice builtin 取 patches）+
 * shell fetchCognitionSnapshotForIpc（直调 db listWorldSlices 取 patches）两入口共用同投影形态。
 *
 * 范式判据（ADR-3）：snapshot 构造 = 纯代码 reduce + 投影（查询/汇编/结构映射），无 LLM/无 db/无副作用。
 * 「消费 snapshot 判认知违背」归 Reader-Audit L2 语义裁判，snapshot 本身只机械投影。
 *
 * @param patches 全部候选 patches（自行 filter cognitive）；空/无 cognitive → undefined（graceful）。
 * @returns       snapshot（characters 非空）；undefined = 无 cognitive patches / 全角色空认知（caller 不注入 artifact）。
 */
export function buildCognitionSnapshot(
  patches: readonly WorldPatch[],
  // CR-002：subjectCap 截断（mirror buildWorldStateSnapshot world-state.ts:386 default 12）——长篇多 POV
  // 时防全角色全 fact 倾倒胀 cognitionContext var 撑爆 Reader-Audit LLM context。first-seen 序=叙事出现序。
  subjectCap = 12,
): CognitionSnapshot | undefined {
  const cognitive = patches.filter((p) => p.axis === 'cognitive');
  if (cognitive.length === 0) return undefined;
  // 收集 cognitive patches 涉及的唯一 subjectId（first-seen 序），逐个 reduce + 投影。
  const subjectIds: string[] = [];
  const seen = new Set<string>();
  for (const p of cognitive) {
    if (p.subjectId && !seen.has(p.subjectId)) {
      seen.add(p.subjectId);
      subjectIds.push(p.subjectId);
    }
  }
  const capped = subjectIds.slice(0, subjectCap);
  // S7 同族修复（Story 8.3，2026-08-20）：per-subject 对**全量** cognitive 数组 reduceSubject 同为
  // O(subjects × cog_total) 乘积形态（S6 实测 7.21ms 达标——cap 12 限制下量级小，同族顺路修非阈值
  // 触发）。groupBy(subjectId) 预分组逐位等价论证同 buildPresenceSignal；复杂度
  // O(cog_total + Σ subjects_i × cog_{subject_i})。
  // S7 路径 A 终局裁决（主上下文）：**不做增量折叠**——本函数每 subject 只在 at=undefined 单查询点
  // 折叠一次（无逐查询点重折叠乘积，presence 的 320k 次重折叠病灶在此不存在），groupBy 消掉全量
  // 扫描面后已足（复测 7.2ms ≤ 20ms）；不为达标而改。
  const cognitiveBySubject = new Map<string, WorldPatch[]>();
  for (const p of cognitive) {
    const group = cognitiveBySubject.get(p.subjectId);
    if (group === undefined) cognitiveBySubject.set(p.subjectId, [p]);
    else group.push(p);
  }
  const characters: CharacterBeliefView[] = [];
  for (const subjectId of capped) {
    const { state } = reduceSubject(cognitiveBySubject.get(subjectId) ?? [], subjectId);
    if (Object.keys(state).length === 0) continue;
    const view = projectBeliefStatus(state, subjectId);
    // CR-003：守 facts 非空（非 state 非空）——state 可含非 bucket 顶层 key（被 projectBeliefStatus 跳过）
    // 致 facts 空；空 facts 角色不入 characters[]（违「丢空状态角色免噪音」契约 + L2 见无认知角色误读 unaware）。
    if (view.facts.length > 0) characters.push(view);
  }
  return characters.length > 0 ? { characters } : undefined;
}

// ── Story 6.4 D1（6.2 DW-1）：在场性预筛信号（physical /presence_scene vs cognitive evidenceSceneId）──
//
// 6.2 info-gap 维的在场性机械预筛数据源。cognitive patch 带 evidenceSceneId（fact 揭露场，transmit 场），
// physical 轴 /presence_scene（角色当前在场场）。两者都在 closure_world_state（同源，mirror buildCognitionSnapshot）。
// 本纯函数对每条带 evidenceSceneId 的 cognitive patch，reduce 该角色在该认知 storyTime 的 physical presence_scene，
// 若 ≠ evidenceSceneId → 产「A 表现知情但不在 fact 揭露场」信号，注入 Reader-Audit cognitionContext 给 L2
// （机械信号增强，非替代语义裁判）。
//
// 范式判据（ADR-3）：reduce + 结构比对纯代码；违规裁判归 L2。
// graceful：无 evidenceSceneId cognitive / 无 physical presence → 无信号（空数组，caller 不注入，降级为 6.2 既有纯语义判路径）。
// 时态近似：用 cognitive patch.storyTime 作 presence reduce 截断点（A 在认知发生时刻的在场场）；精度 dogfood 后视。

export interface PresenceSignal {
  characterSubjectId: string;
  /** 认知 fact 的 path（JSON Pointer，如 /knows/秘密）。 */
  factPath: string;
  /** 该认知证据所在 scene id（cognitive patch.evidenceSceneId，transmit 场）。 */
  evidenceSceneId: string;
  /** 该认知发生的 storyTime（presence reduce 截断点）。 */
  storyTime: number;
  /** reduce 出的角色实际在场 scene id（≠ evidenceSceneId 触发信号）。 */
  presenceSceneId: string;
}

/**
 * per-subject presence 增量折叠（S7 路径 A 内部 helper）。纯函数。
 *
 * 把该 subject 的 physical 史按 storyTime 稳定升序后，对升序去重查询点逐窗
 * applyPatches(seed, window) 折叠，每查询点快照 `presence_scene`。窗划分 = (前一查询点, 当前查询点]
 * （首窗 = (-∞, 首查询点]）——storyTime 区间不相交 ⇒ 逐窗拼接（各窗内复合排序键：storyTime 升序 →
 * derived 先 amendment → 输入序稳定）≡ 全量 fold 的排序序列 ⇒ 每个快照 ≡
 * reduceSubject(group, subjectId, at).state.presence_scene（8.1 seeded reduce 等价原语，JSDoc
 * 「applyPatches(ckpt.state, window) ≡ 全量 fold」；worldStateAsOfAudit / as-of-invariants 全套守卫背书）。
 */
function foldPresenceSnapshots(
  group: readonly WorldPatch[],
  ats: readonly number[],
): Map<number, unknown> {
  const snapshots = new Map<number, unknown>();
  // storyTime 稳定升序：同 storyTime 保输入相对序（applyPatches 窗内排序的 tie-break 输入）。
  const ordered = group.slice().sort((a, b) => a.storyTime - b.storyTime);
  let seed: ReducedState = {};
  let cursor = 0;
  for (const at of ats) {
    const window: WorldPatch[] = [];
    while (cursor < ordered.length && ordered[cursor]!.storyTime <= at) {
      window.push(ordered[cursor]!);
      cursor += 1;
    }
    if (window.length > 0) seed = applyPatches(seed, window).state;
    snapshots.set(at, seed.presence_scene);
  }
  return snapshots;
}

/**
 * 从 patches 构造在场性预筛信号（filter cognitive with evidenceSceneId → per-subject 增量折叠
 * physical presence_scene at 各认知 storyTime → 比对 evidenceSceneId）。纯函数（无 LLM/db/副作用）。
 *
 * S7 终局修法（Story 8.3，2026-08-20 主上下文裁决路径 A「调用内增量折叠」，否决 per-axis
 * checkpoint——checkpoint 帮不了消费已取回 patches 的纯函数）。演进记档：原 per-cognitive-patch
 * reduceSubject 全量 physical 扫描 = O(cog × phys_total)（S6 满配实测 P95 129.79ms）→ groupBy
 * (subjectId) 预分组仍 O(Σ cog_i × phys_{subject_i})（复测 117.99ms：每条认知 patch 把同 subject
 * 的 physical 史从头重折叠；fixture 里 hero 独占 800 physical × 800 认知 ≈ 320k 次折叠为最坏形态）
 * → 增量折叠：per-subject 查询点（认知 storyTimes 去重升序）与 physical 史单次扫描逐窗折叠，
 * 折叠总量 = phys_total（fixture 320k → 800 次）。信号按 cognitiveWithScene 输入序发射（快照
 * 预计算后原序走一遍）——序契约与修前一致；对拍锚 = tests/cognition.test.ts S7 基线（修前实现）。
 *
 * @param patches 全部候选 patches（自行 filter）；空/无 evidenceSceneId cognitive/无 physical → 空数组（graceful）。
 * @returns       信号列表（A 表现知情但不在 fact 揭露场的 fact）。空 = 无可疑 / 无在场数据。
 */
export function buildPresenceSignal(patches: readonly WorldPatch[]): PresenceSignal[] {
  const cognitiveWithScene = patches.filter(
    (p) => p.axis === 'cognitive' && typeof p.evidenceSceneId === 'string',
  );
  if (cognitiveWithScene.length === 0) return [];
  const physical = patches.filter((p) => p.axis === 'physical');
  // 无在场数据 → 不预筛（graceful，mirror 6.2「不依赖在场场」原路径不变）。
  if (physical.length === 0) return [];

  // 1. groupBy(subjectId)：physical 史 + 认知查询点各一份（均保输入相对序）。
  const physicalBySubject = new Map<string, WorldPatch[]>();
  for (const p of physical) {
    const group = physicalBySubject.get(p.subjectId);
    if (group === undefined) physicalBySubject.set(p.subjectId, [p]);
    else group.push(p);
  }
  const atsBySubject = new Map<string, Set<number>>();
  for (const c of cognitiveWithScene) {
    const ats = atsBySubject.get(c.subjectId);
    if (ats === undefined) atsBySubject.set(c.subjectId, new Set([c.storyTime]));
    else ats.add(c.storyTime);
  }

  // 2. per-subject 增量折叠预计算 presence 快照。无 physical 史的 subject 缺位 = presence
  //    undefined（≡ 修前 reduceSubject([]) → state {} → 无 presence_scene → 不产信号）。
  const presenceBySubjectAt = new Map<string, Map<number, unknown>>();
  for (const [subjectId, ats] of atsBySubject) {
    const group = physicalBySubject.get(subjectId);
    if (group === undefined) continue;
    presenceBySubjectAt.set(
      subjectId,
      foldPresenceSnapshots(group, [...ats].sort((a, b) => a - b)),
    );
  }

  // 3. 按 cognitiveWithScene 输入序发射信号（修前信号序契约不变）。
  const signals: PresenceSignal[] = [];
  for (const c of cognitiveWithScene) {
    const presence = presenceBySubjectAt.get(c.subjectId)?.get(c.storyTime);
    if (typeof presence === 'string' && presence !== c.evidenceSceneId) {
      signals.push({
        characterSubjectId: c.subjectId,
        factPath: c.path,
        evidenceSceneId: c.evidenceSceneId as string,
        storyTime: c.storyTime,
        presenceSceneId: presence,
      });
    }
  }
  return signals;
}

