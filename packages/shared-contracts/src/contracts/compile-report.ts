import type { ChapterBrief } from './chapter-brief';
import type { PinnedPrefixItem } from './setting-prefix';
import { selectScenesForEpisode } from './scene-graph-analytics';
import type { SceneGraph } from './creative-fields';
import type { CompileReport, CompileReportDegraded, CompileReportSegment } from './research-brief';

// ── Story 8.4 B1/B2（design §2.1/§2.2/§2.3）：热层度量 + 三级降级梯（纯代码核心）──
//
// **定位（用户两次拍板，红线）**：预算**不做质量性硬 cap**——TH_* 阈值 = **机械异常量级**（bug 保险丝：
// 编译产物爆炸 / 重复注入等机械故障的量级线），正常写作**永不触发**。降级动作只做「编译参数收窄 /
// 可机械恢复段移出」，永不触碰写作意图内容。
//
// **铁律集（永不裁，测试钉死）**：骨架段（goal / 信息控制 / 禁写 / 情绪目标——用户点名四件，连同
// 参数/节奏/readiness 等 LLM 意图段与元数据）+ 设定侧全书目录 + 可查指针。机械判据：**降级梯只含
// 「纯代码汇编段」**（stateAtT / promiseTasks / openDecisions / characterProgressions /
// manipulationDirectives / plotPoints——全部可由只读工具重取或由上游数据重建）；leader 填的 LLM 意图段
// 一件不进梯（裁它们 = 质量判断，违「不做质量性裁剪」定位，范式归人/LLM）。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：本文件全部是**机械数学**——token
// 字符估算 / 求和 / 阈值比较 / 结构字段裁剪。「哪段重要 / 该不该拆章」归人（L3 出口人裁）。
//
// **汇总点（design §2.1 D3）**：settings_context 与 chapter_brief 是两个编译点（assembleChapterChainArtifacts
// 产前者〔随 initialArtifacts 携带 settings_context_report 段报告〕/ brief-compiler 节点产后者）——**两编译点
// 不各自判总额**，总额判定与降级动作统一在 brief-compiler 节点（链内汇合点：编译后 brief 只在此可见，且
// leader 工具与 shell IPC 两条写章入口都在此汇合，mirror D2 briefHash 判定落点 writer-node.ts 头注释）。
// 报告随链段 `compile_report` 伴生 artifact 携带（NodeResult 单 stateKey + mutate 先例 = 7.2 revision-guard），
// 经 summarizeRunSnapshot 透出 summary.compileReport（mirror 章摘要 tokenEstimate 先例）。
//
// expected_downstream_consumers:
// - Story 8.4 Step 7：assembleChapterChainArtifacts（settings 侧段报告产侧）+ brief-compiler-node（汇总/
//   判档/降级/报告 mutate）+ summarizeRunSnapshot（透出）+ write_chapter（L3 leader 一行，B 段唯一 leader 侧改动）。
// - Story 8.4 Step 9（压测）：满配热层合成数据 total < COMPILE_TH_WARN 断言（「正常写作永不触发」规模侧背书）。
// - dogfood：TH_* 校准（deferred-work 记档）。

// ── token 估算单源（estimateTextTokens）──
//
// agent `context/tokenEstimator.ts estimateTokens`（3.5 字符启发式，spec agent/context-management.md）与
// shared `world-state-reduce.ts estimateChapterSummaryTokens` 此前各自实现同一启发式——B1 度量跨两编译点
// （shared assemble + agent node）需单源，上提到 shared 此处；两处既有实现改为委托（零行为变化）。

/** token 估算字符比（混合 CJK/Latin 平均 ~1 token / 3.5 字符；agent context/tokenEstimator.ts 同源启发式上提单源）。 */
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 3.5;

/** 文本 token 估算（字符启发式，观测用非精确计数）。空串 → 0。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

// ── 阈值（机械异常量级 = bug 保险丝，非质量 cap）──

/** 三级降级梯阈值（design §2.2 表）。参数化：纯函数收 `CompileThresholds`，缺省 DEFAULT（测试可收窄验档）。 */
export interface CompileThresholds {
  /** L1 触发线（TH_WARN ≤ total < TH_MOVE → L1 压缩）。 */
  warn: number;
  /** L2 触发线（TH_MOVE ≤ total → L2 移出）。 */
  move: number;
  /** L3 触发线（L2 降级后仍 > TH_HARD → overloaded 复杂场景标记，人裁）。 */
  hard: number;
}

/**
 * 缺省阈值（**校准点 dogfood**——正常写作永不触发，初值按机械异常量级给宽松常数）：
 * - 正常编译产物量级：brief（十段 + stateAtT 快照）典型 ~3-10K tokens + 设定前缀（目录 + core 卡 lean
 *   字段）典型 ~2-5K tokens，合计 < 15K。TH_WARN=64K ≈ 正常上限的 4-10 倍——只有机械故障（编译产物
 *   爆炸 / 重复注入 / 注册表异常膨胀）能到。
 * - 相对上下文窗（CONTEXT_WINDOW=1M）：TH_HARD=128K ≈ 12.8%——异常量级，远非质量档。
 * - 压测背书：Step 9 满配热层断言 total < TH_WARN。dogfood 后按观测校准（deferred-work 记档）。
 */
export const DEFAULT_COMPILE_THRESHOLDS: Readonly<CompileThresholds> = {
  warn: 64_000,
  move: 96_000,
  hard: 128_000,
};

/** 降级档位（L3 不是独立档——是 L2 降级后仍超 TH_HARD 的 overloaded 标记，design §2.2）。 */
export type CompileTier = 'L0' | 'L1' | 'L2';

/**
 * 总额判档（纯代码机械比较，非语义）。L0 正常（仅度量报告）/ L1 压缩 / L2 移出。
 * L3（复杂场景）= L2 降级后仍 > hard → `buildCompileReport` 标 overloaded，不在此枚举。
 */
export function judgeCompileTier(total: number, th: Readonly<CompileThresholds> = DEFAULT_COMPILE_THRESHOLDS): CompileTier {
  if (total >= th.move) return 'L2';
  if (total >= th.warn) return 'L1';
  return 'L0';
}

// ── 段命名 + 分类（铁律集 / L1 可压缩 / L2 可移出）──

/**
 * brief 侧编译段名（snake_case，agentPolicy.fieldNameCase）。段 = brief 字段按职能分组（非逐字段），
 * 与降级分类一一对应。`settings:<label>` 前缀为设定侧段（assemble 产，不进 brief 段名 union）。
 */
export type BriefCompileSegmentName =
  | 'goal' // #1 目标/落点（goal + ending）——骨架
  | 'params' // #2 参数（pov + tone）——LLM 意图段
  | 'info_control' // #3 信息控制（readerKnows/protagonistKnows/mustHide/hintOnly）——骨架（用户点名）
  | 'pacing' // #4 节奏/下章牵引（pacing/opening/nextHook）——LLM 意图段
  | 'forbidden' // #5 禁写（doNotWrite + gap_whitelist）——骨架（用户点名）
  | 'emotion_target' // #10 情绪目标——骨架（用户点名）
  | 'readiness' // 就绪阶梯元数据（微小）——不裁（无意义）
  | 'plot_points' // #6 关键剧情点场列表（sceneId + continuity；stateAtT 单列）——纯代码汇编段
  | 'plot_points_state' // #6 stateAtT 状态快照（纯代码汇编段，L1 主压缩对象）
  | 'promise_tasks' // #7 Promise 任务（纯代码汇编段）
  | 'open_decisions' // #8 未决决策警告（纯代码汇编段）
  | 'manipulation_directives' // Director 操控指令 structured（纯代码汇编段；#3 自然语言骨架并行保留）
  | 'character_progressions'; // 本章角色弧走向（纯代码汇编段）

/** 全部 brief 编译段名（枚举单源，测试与遍引用）。 */
export const BRIEF_COMPILE_SEGMENT_NAMES: readonly BriefCompileSegmentName[] = [
  'goal', 'params', 'info_control', 'pacing', 'forbidden', 'emotion_target', 'readiness',
  'plot_points', 'plot_points_state', 'promise_tasks', 'open_decisions',
  'manipulation_directives', 'character_progressions',
];

/**
 * 铁律段集（**永不裁**，测试钉死）：用户点名四件（goal/信息控制/禁写/情绪目标）+ 其余 LLM 意图段
 * （params/pacing）+ readiness 元数据。机械判据：凡 leader 填写或意图承载段一律不裁——降级只动纯代码
 * 汇编段（见 COMPILE_L2_MOVE_ORDER）。设定侧铁律（全书目录 + 可查指针）在段内容层（compileSettingPrefix
 * 产的目录/指针 item），settings 侧无降级动作（见 estimateSettingsSegments 注释），天然不受梯影响。
 */
export const COMPILE_IRON_BRIEF_SEGMENTS: readonly BriefCompileSegmentName[] = [
  'goal', 'params', 'info_control', 'pacing', 'forbidden', 'emotion_target', 'readiness',
];

/**
 * L2 移出梯（**只含纯代码汇编段**，顺序即移出优先序——设计取舍非语义判断）：
 * 1. `plot_points_state`：stateAtT 状态反哺是 6.6 后加的增强段（非十段原始段），且 L1 已收窄仍超时先移
 *    （信息差笔误防护另有 Reader-Audit info-gap 维兜底）。
 * 2. `promise_tasks`：query_promise（伏笔账）可整段重取——写手自查通道一等公民。
 * 3. `character_progressions`：弧走向增强段（advisory；弧全量本就归可查询 growth_curve，8.5「不进 brief」原则）。
 * 4. `open_decisions`：未决决策警告（advisory）。
 * 5. `manipulation_directives`：Director 指令 structured 副本（#3 自然语言骨架并行保留，L2 裁判降级为
 *    仅 #3 文本——禁透露语义不丢）。
 * 6. `plot_points`：场列表 + 连续性（scene_graph_read 可重取）——结构核心最后移。
 *
 * L2 动作 = 移出低优段（sequential：按序移至 projected total < th.move 为止）+ 降级记录携可查指针文案
 * （「想查用 query_story」——design §2.2）；写手侧无需内嵌指针行：写手自查通道（A 段）本就是拉取路径
 * （PHASE1 指令已教它按需查询），指针面向 leader/人（compileReport.degraded / L3 报告）。
 */
export const COMPILE_L2_MOVE_ORDER: readonly BriefCompileSegmentName[] = [
  'plot_points_state',
  'promise_tasks',
  'character_progressions',
  'open_decisions',
  'manipulation_directives',
  'plot_points',
];

/**
 * L1 压缩参数：stateAtT 快照 per-场 subject 数收窄上限（**校准点 dogfood**）。fetch 通道缺省
 * subjectCap=12（buildWorldStateSnapshot 默认，world-state-reduce.ts）；L1 收窄至 6。**就地裁剪**
 * （design §2.1 D3 允许形态）——对已取回 snapshot 的 subjects 按 first-seen 序 slice，与回注编译参数
 * subjectCap=6 重取机械等价（同 first-seen 截断序），免二次 IPC。
 */
export const COMPILE_L1_SNAPSHOT_SUBJECT_CAP = 6;

// ── 段估算 ──

/** brief 字段 → 编译段分组（plot_points / plot_points_state 特殊处理：plotPoints 字段按 stateAtT 拆两段）。 */
const SEGMENT_FIELDS: Readonly<Record<Exclude<BriefCompileSegmentName, 'plot_points' | 'plot_points_state'>, readonly (keyof ChapterBrief)[]>> = {
  goal: ['goal', 'ending'],
  params: ['pov', 'tone'],
  info_control: ['readerKnows', 'protagonistKnows', 'mustHide', 'hintOnly'],
  pacing: ['pacing', 'opening', 'nextHook'],
  forbidden: ['doNotWrite', 'gap_whitelist'],
  emotion_target: ['emotionTarget'],
  readiness: ['readiness'],
  promise_tasks: ['promiseTasks'],
  open_decisions: ['openDecisions'],
  manipulation_directives: ['manipulationDirectives'],
  character_progressions: ['characterProgressions'],
};

/** JSON 序列化（undefined 值序列化为 undefined → null 会虚增估算，先滤掉；空对象段跳过）。 */
function pickJson(brief: ChapterBrief, keys: readonly (keyof ChapterBrief)[]): string | undefined {
  const parts: unknown[] = [];
  for (const key of keys) {
    const value = brief[key];
    if (value !== undefined) parts.push(value);
  }
  if (parts.length === 0) return undefined;
  return JSON.stringify(parts);
}

/**
 * 估算 brief 侧各编译段 token（B1 度量，纯机械）。plotPoints 拆两段：`plot_points`（场列表，stateAtT
 * 剥除序列化）+ `plot_points_state`（各场 stateAtT 序列化）——L1/L2 作用对象是后者，拆开使降级前后
 * 报告可对拍。全 undefined 段不产条目（报告反映实际组成）；段两和 ≠ 整 brief 序列化（括号/逗号开销）
 * ——启发式估算本就观测用，可接受。
 */
export function estimateBriefSegments(brief: ChapterBrief): CompileReportSegment[] {
  const segments: CompileReportSegment[] = [];
  for (const name of BRIEF_COMPILE_SEGMENT_NAMES) {
    if (name === 'plot_points' || name === 'plot_points_state') continue;
    const json = pickJson(brief, SEGMENT_FIELDS[name]);
    if (json !== undefined) segments.push({ name, token_estimate: estimateTextTokens(json) });
  }
  if (brief.plotPoints !== undefined) {
    const stripped = JSON.stringify(brief.plotPoints.map(({ stateAtT: _s, ...rest }) => rest));
    segments.push({ name: 'plot_points', token_estimate: estimateTextTokens(stripped) });
    if (brief.plotPoints.some((p) => p.stateAtT !== undefined)) {
      segments.push({
        name: 'plot_points_state',
        token_estimate: estimateTextTokens(JSON.stringify(brief.plotPoints.map((p) => p.stateAtT))),
      });
    }
  }
  return segments;
}

/**
 * 估算设定侧（settings_context 稳定前缀）各段 token（B1 度量）。逐 PinnedPrefixItem 一段（name =
 * `settings:<label>`），估算基 = renderSettingPrefixToString 同款 per-item 渲染文本（`label：\ncontent`，
 * mirror estimatePinnedTokens「按渲染串估」哲学）——与写手实际收到的 settings_context 组成逐项对齐。
 *
 * **设定侧无 L1/L2 降级动作（勘察结论，B2 范围决定）**：前缀由 compileSettingPrefix 纯代码产——目录
 * （全书目录）/core 卡内「可查详情」指针行 = 铁律；core 卡 lean 核心字段 / world_setting / creative_brief
 * 顶层是整体骨架单元，无「不伤铁律的机械子项裁剪通道」（卡内容是一体渲染文本）。设定侧膨胀（如卡数
 * 爆炸）落到 L3（overloaded → 建议拆章/清理，人裁）——与「阈值=机械异常量级」定位一致。
 */
export function estimateSettingsSegments(items: readonly PinnedPrefixItem[]): CompileReportSegment[] {
  return items.map((item) => ({
    name: `settings:${item.label}`,
    token_estimate: estimateTextTokens(`${item.label}：\n${item.content}`),
  }));
}

/**
 * story_plan 段估算（R2-盲5，2026-08-19）：draft-writer 稳定前缀第三块——`{{storyPlan}}` =
 * `JSON.stringify(selectScenesForEpisode(...))` 整段直注——此前不在 estimateBriefSegments（只估
 * chapter_brief 字段）与 estimateSettingsSegments（只估 prefix items）任何一侧，场元数据机械膨胀时
 * 降级梯结构性失明（保险丝看不到该通道）。本段以**同一投影单源**（selectScenesForEpisode，shared
 * 导出 + 同 JSON.stringify 序列化，mirror chapter-nodes buildDraftWriterVars 渲染）计量进报告 total——
 * brief-compiler 汇总点调用（scene_graph / episodeId 同源输入，与 #6 plotPoints 编译同数据）。
 *
 * **不进 L2 移出梯**：story_plan 是写手结构核心（场清单地图——「裁详情不裁地图」铁律同族），段膨胀
 * 归 L3 overloaded 人裁，无机械移出动作。scene_graph 缺 / 本章无场 → `'[]'` 估算（与写手实际收到的
 * 渲染一致——空投影也占稳定前缀字节，如实计量）。
 */
export function buildStoryPlanSegment(
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
): CompileReportSegment {
  return {
    name: 'story_plan',
    token_estimate: estimateTextTokens(JSON.stringify(selectScenesForEpisode(sceneGraph, episodeId))),
  };
}

/**
 * 读 settings_context_report artifact（assemble 产）为段列表（防御性，mirror isValidPromiseRegistry
 * 形态守卫哲学）：非数组 / 坏条目单独丢（per-element safeParse 语义）→ 好数据保留；artifact 缺 → []
 * （graceful——手构 fixture / 旧 chainSnapshot resume，总额判定退化为 brief 侧单边，L0 恒真零回归）。
 */
export function readSettingsCompileSegments(raw: unknown): CompileReportSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: CompileReportSegment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = (entry as { name?: unknown }).name;
    const tokenEstimate = (entry as { token_estimate?: unknown }).token_estimate;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (typeof tokenEstimate !== 'number' || !Number.isInteger(tokenEstimate) || tokenEstimate < 0) continue;
    out.push({ name, token_estimate: tokenEstimate });
  }
  return out;
}

// ── 降级动作 ──

/** L2 移出的降级记录文案（可查指针，design §2.2「替换为可查指针一行」——面向 leader/人，非写手 prompt）。 */
function moveOutAction(name: BriefCompileSegmentName): string {
  return `L2 移出热层（${name}），替换为可查指针——想查用 query_story`;
}

/**
 * L1 压缩：stateAtT 快照 subjects 按 first-seen 序收窄至 cap（就地裁剪，机械等价编译参数 subjectCap
 * 回注重取——同截断序，免二次 IPC）。防御：stateAtT 非 snapshot 形态（无 subjects 数组）不动（不猜
 * 结构）。浅拷贝不改入参（L0 路径零对象分配，保产物逐字节相同）。
 */
function trimStateAtTSubjects(
  brief: ChapterBrief,
  cap: number,
): { brief: ChapterBrief; trimmed: boolean } {
  if (!brief.plotPoints || brief.plotPoints.length === 0) return { brief, trimmed: false };
  let trimmed = false;
  const points = brief.plotPoints.map((p) => {
    const state = p.stateAtT;
    if (!state || typeof state !== 'object' || !Array.isArray((state as { subjects?: unknown }).subjects)) {
      return p;
    }
    const subjects = (state as { subjects: unknown[] }).subjects;
    if (subjects.length <= cap) return p;
    trimmed = true;
    return { ...p, stateAtT: { ...(state as object), subjects: subjects.slice(0, cap) } };
  });
  return trimmed ? { brief: { ...brief, plotPoints: points }, trimmed } : { brief, trimmed: false };
}

/**
 * L2 移出单段（纯代码汇编段；铁律段返 null——switch 白名单机械挡，非语义判断）。返回新 brief（浅拷贝
 * 剥字段）或 null（段缺失/空移——不产降级记录）。
 */
function moveOutSegment(brief: ChapterBrief, name: BriefCompileSegmentName): ChapterBrief | null {
  switch (name) {
    case 'plot_points_state': {
      if (!brief.plotPoints || !brief.plotPoints.some((p) => p.stateAtT !== undefined)) return null;
      const { plotPoints, ...rest } = brief;
      void plotPoints;
      return { ...rest, plotPoints: plotPoints.map((p) => {
        if (p.stateAtT === undefined) return p;
        const { stateAtT: _s, ...point } = p;
        void _s;
        return point;
      }) };
    }
    case 'promise_tasks': {
      if (brief.promiseTasks === undefined) return null;
      const { promiseTasks: _d, ...rest } = brief;
      void _d;
      return rest;
    }
    case 'open_decisions': {
      if (brief.openDecisions === undefined) return null;
      const { openDecisions: _d, ...rest } = brief;
      void _d;
      return rest;
    }
    case 'character_progressions': {
      if (brief.characterProgressions === undefined) return null;
      const { characterProgressions: _d, ...rest } = brief;
      void _d;
      return rest;
    }
    case 'manipulation_directives': {
      if (brief.manipulationDirectives === undefined) return null;
      const { manipulationDirectives: _d, ...rest } = brief;
      void _d;
      return rest;
    }
    case 'plot_points': {
      if (brief.plotPoints === undefined) return null;
      const { plotPoints: _d, ...rest } = brief;
      void _d;
      return rest;
    }
    // 铁律段（goal/params/info_control/pacing/forbidden/emotion_target/readiness）不在白名单——机械挡。
    default:
      return null;
  }
}

// ── 汇总 + 判档 + 降级 + 报告（brief-compiler 节点单入口）──

/** buildCompileReport 输出：降级后 brief（L0 时与入参同引用——产物逐字节相同）+ 报告 + 档位。 */
export interface BuildCompileReportResult {
  brief: ChapterBrief;
  report: CompileReport;
  tier: CompileTier;
}

function sumSegments(segments: readonly CompileReportSegment[]): number {
  let total = 0;
  for (const s of segments) total += s.token_estimate;
  return total;
}

/**
 * B1+B2 单入口（brief-compiler 节点调；**总额判定汇总点**——两编译点不各自判总额，design §2.1 D3）：
 *
 * 1. 估算 brief 侧段 + 读 settings 侧段（caller 传 assemble 产的段报告）→ 汇总 total。
 * 2. 判档：L0（total < warn）仅报告，brief 原样返回（同引用）；L1（warn ≤ total < move）压缩
 *    （stateAtT subjects 收窄，就地裁剪）；L2（move ≤ total）按 COMPILE_L2_MOVE_ORDER 顺序移出纯代码
 *    汇编段至 projected total < move（sequential 最小干预——保险丝哲学，非优化循环）。
 * 3. L3：L2 降级后 total 仍 > hard → report.overloaded=true（复杂场景标记——leader 一行「建议拆章」
 *    人裁，不静默继续也不静默砍；L1 档 total < move < hard 结构性不可能 overloaded）。
 * 4. 报告段列表 = settings 段 + **降级后** brief 段（对拍语义：报告反映写手实际收到什么）；
 *    degraded 二态（无降级不设字段，mirror schema .min(1) 契约）——**L1/L2 触发但零降级动作可做**
 *    （L1 各场 subjects ≤ cap 无可裁 / L2 梯段全 miss 无可移——恰是设定侧爆炸 + brief 侧无可裁场景）
 *    时同样不设字段（R2-盲1：空 [] 自违 .min(1) → summarize safeParse 拒收整份报告 → L3 人裁文案
 *    永不渲染，「不静默」承诺在该场景失效）。
 *
 * graceful：两侧段全空（空 brief + 无设定报告）→ 补占位段（schema segments .min(1)，token 0 如实）。
 * 纯函数（无 LLM/fs/db）；不 mutate 入参（L1/L2 路径浅拷贝）。
 */
export function buildCompileReport(
  brief: ChapterBrief,
  settingsSegments: readonly CompileReportSegment[],
  th: Readonly<CompileThresholds> = DEFAULT_COMPILE_THRESHOLDS,
): BuildCompileReportResult {
  const before = estimateBriefSegments(brief);
  const briefTotal = sumSegments(before);
  const settingsTotal = sumSegments(settingsSegments);
  const total = settingsTotal + briefTotal;
  const tier = judgeCompileTier(total, th);

  // L0：仅报告（正常路径——零对象分配、同引用返回，产物逐字节相同）。
  if (tier === 'L0') {
    const segments = [...settingsSegments, ...before];
    return {
      brief,
      tier,
      report: {
        segments: segments.length > 0 ? segments : [{ name: 'brief', token_estimate: 0 }],
        total,
        overloaded: false,
      },
    };
  }

  const degraded: CompileReportDegraded[] = [];
  let working = brief;

  if (tier === 'L1') {
    // L1 压缩：stateAtT subjects 收窄（唯一有既定语义的压缩通道——attrs 白名单不存在通用集，
    // world-state-reduce.ts 注释明言「动态 schema 难穷举关键 key，Phase D 不传 attrs」）。
    const trimmed = trimStateAtTSubjects(working, COMPILE_L1_SNAPSHOT_SUBJECT_CAP);
    if (trimmed.trimmed) {
      degraded.push({
        segment: 'plot_points_state',
        action: `L1 压缩：各场状态快照主体数收窄至 ${COMPILE_L1_SNAPSHOT_SUBJECT_CAP}（机械缩档）`,
      });
      working = trimmed.brief;
    }
  } else {
    // L2 移出（sequential：按梯序移至 projected total < move）。plot_points_state 居梯首——L1 缩档
    // 在 L2 无意义（该段整体移出），不重复做。
    const estimateByName = new Map(estimateBriefSegments(working).map((s) => [s.name as BriefCompileSegmentName, s.token_estimate]));
    let projected = total;
    for (const name of COMPILE_L2_MOVE_ORDER) {
      if (projected < th.move) break;
      const estimate = estimateByName.get(name);
      if (estimate === undefined) continue; // 段不在（未编译/已移出）——无可移
      const moved = moveOutSegment(working, name);
      if (moved === null) continue;
      working = moved;
      degraded.push({ segment: name, action: moveOutAction(name) });
      projected -= estimate;
    }
  }

  // 报告段 = settings 段 + 降级后 brief 段（写手实际收到什么）；total 重算（非 projected 残差——如实）。
  // R2-盲1：degraded 字段二态——零降级动作（L1 无可裁 / L2 全段 miss）不写字段（undefined），
  // 恒不落空 []（schema .min(1)——空数组会让 safeParse 拒收整份报告，L3 文案链断）。
  const after = estimateBriefSegments(working);
  const finalSegments = [...settingsSegments, ...after];
  const finalTotal = settingsTotal + sumSegments(after);
  return {
    brief: working,
    tier,
    report: {
      segments: finalSegments.length > 0 ? finalSegments : [{ name: 'brief', token_estimate: 0 }],
      total: finalTotal,
      ...(degraded.length > 0 ? { degraded } : {}),
      overloaded: tier === 'L2' && finalTotal > th.hard,
    },
  };
}
