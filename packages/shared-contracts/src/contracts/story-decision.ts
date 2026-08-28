import { z } from 'zod';

// ── Story 2.6 / 4.1 Step 3：StoryDecision 创作决策 ADR 数据层（design §3.5 / conclusions §3.5/3.9）──
//
// StoryDecision = 创作决策的 ADR 式记录（open→decided→superseded/dropped 状态机）。是 codify 状态
// （conclusions §3.10「方法论 = 提问机；产出 = 回答；回答喂 schema」——LLM / 人写入并对它负责），
// 非纯代码外推。纯代码只做 schema / 查询 / 状态机（不裁断语义）；判定「这是不是好决策」归 LLM / 人。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical）：本文件 = 结构化 schema（codify 容器）。
// brief #8 filter open 决策（brief-compiler-node）是纯代码查询；accept 时登记 decided（Step 4
// chainRunner onAccept）是 LLM 判 route_decision 后产。本 step（Step 3）只建 schema + brief #8 消费 +
// assemble 注 story_decisions；不编码「某决策该不该改稿」（归 LLM route），只记录 + 查询。
//
// 与 conclusions §3.5 三档路由的关系：route=accept_as_truth 且正文偏离计划时，accept 分支建一条
// source:'accept_as_truth' 的 decided decision（Step 4 实现）。灰区 escalate_user / 明确缺陷
// auto_revise 不产 StoryDecision（auto_revise 走保义改稿闭环，escalate 走 PermissionService ask）。
//
// 字段设计（design §3.5 + conclusions §3.5/3.9 + 2.6 防写死）：
// - id：决策唯一标识（caller 注，如 'decision_001' / uuid）。
// - summary：决策摘要（如「角色 A 第3章突然硬气：目标成长，非 OOC」）——给主笔 / 审核的简短信号。
// - reason：创作意图（为什么这么决）——ADR 式 rationale，区分「这是 bug」vs「这是目标转折」。
// - alternatives：备选方案（2.6 防写死——open 时记录考虑过的替代，decided 后可回溯，避免无脑 decided）。
// - risk：必填风险（2.6 防写死核心——open 状态强制想清楚风险；「先 open 再无脑 decided」被这字段堵）。
// - status：open（未决，brief #8 警告）/ decided（已决，accept 登记）/ superseded（被新决策取代）/ dropped（放弃）。
// - source：登记方（director / accept_as_truth / user / workbench）——4.1 accept 用 accept_as_truth；
//   director / workbench 交互层登记 defer Director agent / Epic 3。
// - landingState：落地状态描述（已体现在正文 / 待落地）——落地公理②「验证落地」追踪（Reader-Audit 核心职责）。
// - supersededBy：superseded 链（指向取代它的 decision id）。
// - relatedEpisodeId：关联 episode（brief #8 filter 命中本章用；缺省 = 全局 open 决策，所有章都警告）。
// - createdAt：ISO 时间戳——⚠️ 调用方注入（schema 无 Date.now default，纯函数无 Date 副作用；
//   accept 登记 = chainRunner 入口注入；工作台 / Director = 各自入口注入）。
//
// 落点 shared-contracts（design §5）：跨包共享（agent brief-compiler #8 消费 + Step 4 accept 登记 +
// 未来 Director / 工作台 UI 登记）。零 migration（新文件；novelSchema 加 optional 字段 additive）。
//
// expected_downstream_consumers:
// - Story 4.1 Step 3（本 step）：schema + brief #8 openDecisions 收紧 + brief-compiler #8 编译 +
//   assemble 注 story_decisions + 两入口（write-chapter / closureChainIpc）读 novel.story_decisions[]。
// - Story 4.1 Step 4：chainRunner onAccept 登记 decided decision（source:'accept_as_truth'）。
// - Story 2.6：工作台 UI 登记 / Director agent 登记（交互层 defer E3 / Director）。

/**
 * StoryDecision status 枚举（⚠️ 扁平枚举非状态机--转换约束由写入方经 `assertTransition` 纯函数
 * 显式校验，2.6 CR-4.1-14 docstring 校准；合法矩阵见 assertTransition）。
 */
export const storyDecisionStatusSchema = z.enum([
  // open：未决（brief #8 openDecisions 警告主笔）。
  'open',
  // decided：已决（accept_as_truth 登记；正文 / 计划已据此调整）。
  'decided',
  // superseded：被新决策取代（supersededBy 指向取代者，形成链）。
  'superseded',
  // dropped：放弃（不再适用，不进 brief #8 警告）。
  'dropped',
]);
export type StoryDecisionStatus = z.infer<typeof storyDecisionStatusSchema>;

/** StoryDecision 登记方（谁产的这条决策记录）。 */
export const storyDecisionSourceSchema = z.enum([
  // director：Director agent 登记（2.6 决策登记段；Director 路径 parse 层强制此值，不信 Director 自报）。
  'director',
  // accept_as_truth：链段 accept_as_truth 分支自动登记正文偏离计划（4.1 Step 4 实现）。
  'accept_as_truth',
  // escalate_accepted：route=escalate_user 且用户 PatchReview accept（接受为真相）登记（2.6 CR-Edge-4--
  // 区别于 accept_as_truth：保留 escalation 上下文，落盘可辨「这条偏离经用户裁决」）。
  'escalate_accepted',
  // user：用户工作台手动登记（author 拍板、leader 产登记，2.6 story_decisions_update）。
  'user',
  // workbench：工作台其它流程登记（leader 自己的建议/判断，非 author 拍板）。
  'workbench',
]);
export type StoryDecisionSource = z.infer<typeof storyDecisionSourceSchema>;

/**
 * StoryDecision — 创作决策 ADR（design §3.5 / conclusions §3.5/3.9）。
 *
 * 状态机：open → decided（accept 登记）/ superseded（新决策取代，supersededBy 链）/ dropped（放弃）。
 * brief #8 openDecisions 消费 `status:'open'` 子集（按 relatedEpisodeId 命中本章或全局）。
 *
 * ⚠️ createdAt 无 schema default——调用方注入 ISO 串（纯函数无 Date 副作用）。accept 登记 =
 * chainRunner 入口注入；工作台 / Director = 各自入口注入。
 */
export const storyDecisionSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  reason: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  risk: z.string().min(1),
  status: storyDecisionStatusSchema.default('open'),
  source: storyDecisionSourceSchema.default('accept_as_truth'),
  landingState: z.string().optional(),
  supersededBy: z.string().optional(),
  relatedEpisodeId: z.string().optional(),
  // drop 时的一句理由（ADR 留痕：为什么放弃--2.6 additive optional，零 migration）。
  dropReason: z.string().optional(),
  // ISO 时间戳——caller 注入（见上）。
  createdAt: z.string().min(1),
});
export type StoryDecision = z.infer<typeof storyDecisionSchema>;

// ══ Story 2.6：状态机转换约束 + 悬空校验 + 相关性 filter + actions 重放（纯代码，写入方消费）══

/**
 * 合法 status 转换矩阵（2.6 CR-4.1-14：schema 是扁平枚举，转换约束由此纯函数显式承载，写入方
 * （story_decisions_update handler / applyFieldPatches story_decisions 分支）状态变更前必须调用校验）。
 *
 * 矩阵（ADR 式状态机，design D5）：
 * - open -> open（idempotent 更新，如补 alternatives）/ decided（拍板）/ superseded / dropped
 * - decided -> superseded / dropped
 * - decided -> decided 不允许（编辑走 supersede 留 ADR 链）/ decided -> open 不允许（重议走
 *   supersede：旧 -> superseded + 新 open）
 * - superseded / dropped = 终态（历史不可抹；再决策 = register 新 id）
 */
const STORY_DECISION_TRANSITIONS: Readonly<Record<StoryDecisionStatus, readonly StoryDecisionStatus[]>> = {
  open: ['open', 'decided', 'superseded', 'dropped'],
  decided: ['superseded', 'dropped'],
  superseded: [],
  dropped: [],
};

/** 校验 status 转换合法性（纯函数；非法转换返 false，caller 出对应错误文案）。 */
export function assertTransition(from: StoryDecisionStatus, to: StoryDecisionStatus): boolean {
  return STORY_DECISION_TRANSITIONS[from].includes(to);
}

/** 悬空 superseded 引用（2.6 CR-4.1-13：supersededBy 指向不存在的 decision id，链断无告警）。 */
export interface DanglingSupersededRef {
  id: string;
  supersededBy: string;
}

/**
 * 找出 supersededBy 悬空引用的决策（mirror findDanglingLineTags 哲学：纯代码结构校验，写入方
 * （story_decisions_update handler 更新后重算）报 warning 回 tool output，不抛、不阻断）。
 */
export function findDanglingSuperseded(decisions: readonly StoryDecision[]): DanglingSupersededRef[] {
  const ids = new Set(decisions.map((d) => d.id));
  return decisions
    .filter((d) => d.supersededBy !== undefined && !ids.has(d.supersededBy))
    .map((d) => ({ id: d.id, supersededBy: d.supersededBy as string }));
}

/**
 * 按 episode 相关性 filter 决策（2.6 单源 filter：brief-compiler #8（open）与 Reader-Audit
 * decidedDecisions（decided）共用，防两处各写一遍漂移）。
 *
 * 相关 = relatedEpisodeId 缺省（全局决策，所有章相关）或命中本章 episodeId。superseded/dropped
 * 由 status 参数天然排除（调用方只传 open / decided）。newestFirst 按 createdAt 降序（Reader-Audit
 * cap 截断用：新决策优先--旧 decided 大概率已落地稳定）。
 *
 * 范式判据：filter + 排序 = 纯代码查询；不判「这条决策重不重要」（归写入时的 LLM / 人）。
 */
export function collectRelevantDecisions(
  decisions: readonly StoryDecision[] | undefined,
  opts: { status: StoryDecisionStatus; episodeId?: string; newestFirst?: boolean; includeEpisodeScoped?: boolean },
): StoryDecision[] {
  if (!decisions || decisions.length === 0) return [];
  const relevant = decisions.filter((d) => {
    if (d.status !== opts.status) return false;
    // includeEpisodeScoped（2.6 CR-E03）：跳过 episode 匹配——leader 全量视角（作者解决的是所有
    // open 非仅本章相关）与裁决器参考（全局决策同样适用）用；不传时 episode-scoped 决策仅在
    // episodeId 命中时进（brief #8 / Reader-Audit 本章视角）。
    if (opts.includeEpisodeScoped === true) return true;
    if (d.relatedEpisodeId === undefined) return true; // 全局决策
    return d.relatedEpisodeId === opts.episodeId;
  });
  if (opts.newestFirst) {
    return [...relevant].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }
  return relevant;
}

// ══ Story 2.6：story_decisions_update 工具 action 契约（单源 schema，工具面与 shell handler 校验面共享）══

/**
 * 决策草稿（LLM 产决策时不带 createdAt--入口注入，纯函数无 Date 副作用的既有约定）。
 * source 缺省 'workbench'（leader 自己的建议）；author 拍板时 leader 传 'user'（引导段约定）。
 */
export const storyDecisionDraftSchema = storyDecisionSchema
  .omit({ createdAt: true })
  .extend({ source: storyDecisionSourceSchema.default('workbench') });
export type StoryDecisionDraft = z.infer<typeof storyDecisionDraftSchema>;

/** story_decisions_update action（覆盖状态机三语义：register / supersede / drop）。 */
export const storyDecisionActionSchema = z.discriminatedUnion('op', [
  // register：新登记（id 不得撞既有）或对既有 id 重登记（open->open 更新 / open->decided 拍板，经 assertTransition）。
  z.object({ op: z.literal('register'), decision: storyDecisionDraftSchema }),
  // supersede：旧决策 -> superseded（supersededBy 指新 id）+ 新决策入列（decided 或 open）。
  z.object({ op: z.literal('supersede'), oldId: z.string().min(1), decision: storyDecisionDraftSchema }),
  // drop：放弃决策（终态，dropReason 留痕）。
  z.object({ op: z.literal('drop'), id: z.string().min(1), reason: z.string().min(1) }),
]);
export type StoryDecisionAction = z.infer<typeof storyDecisionActionSchema>;

/**
 * story_decisions_update 请求体（mirror storySyncApplyRequestSchema 归属：shell handler 校验面与
 * agent builtin 工具参数面单源，防两入口 shape 漂移）。
 *
 * force：user-source 保护旁路（supersede/drop/re-register 目标是 source:'user'（author 拍板）的决策
 * 须显式 force--三层权威：用户决定硬，AI 不擅自改）。
 */
export const storyDecisionsUpdateRequestSchema = z.object({
  actions: z.array(storyDecisionActionSchema).min(1),
  autoApply: z.boolean().optional(),
  force: z.boolean().optional(),
});
export type StoryDecisionsUpdateRequest = z.infer<typeof storyDecisionsUpdateRequestSchema>;

/** applyDecisionActions 结果：成功（next + dangling warnings）或失败（一句错误，caller 转文案）。 */
export type DecisionApplyResult =
  | { ok: true; next: StoryDecision[]; warnings: string[] }
  | { ok: false; error: string };

/**
 * 对既有决策列表按序重放 actions（2.6 守卫单源：auto 档 handler 直写与 suggest 档 accept 重放
 * （applyFieldPatches story_decisions 分支）共用同一套校验，防两处漂移）。
 *
 * 重放语义（非 stale after 全量替换，2.2 CR-201 教训）：actions 对**当前列表**按序应用，staging 与
 * accept 之间列表若被他人改过，守卫（id 撞 / 转换合法性 / user-source）按 fresh 状态判，不会盲写快照。
 *
 * 守卫集（design §3）：
 * - register 新 id 不得撞既有；register 既有 id = 重登记（assertTransition(existing.status, incoming.status)）
 * - register/supersede 的新决策 status 须 open|decided
 * - supersede：oldId 须存在 + assertTransition(old, superseded) + 新 id 不得撞（含 oldId 自身）
 * - drop：id 须存在 + assertTransition(old, dropped)
 * - user-source 保护：supersede/drop/re-register 目标 source:'user' 且无 force -> 拒
 * - createdAt：新登记入口注入 nowISO；重登记保留原 createdAt（决策产生时间）+ 字段级合并
 *   （未提及的 relatedEpisodeId/landingState/alternatives 保留既有，2.6 CR-B02/E02）
 * - 末尾 findDanglingSuperseded -> warnings（不拒）
 *
 * 范式判据：状态机/悬空/守卫 = 纯代码；决策内容本身（summary/reason/risk 值不值得）归上游 LLM。
 */
export function applyDecisionActions(
  decisions: readonly StoryDecision[] | undefined,
  actions: readonly StoryDecisionAction[],
  opts: { force?: boolean; nowISO: string },
): DecisionApplyResult {
  const next: StoryDecision[] = (decisions ?? []).map((d) => ({ ...d }));
  const findById = (id: string) => next.find((d) => d.id === id);

  for (const action of actions) {
    if (action.op === 'register') {
      const draft = action.decision;
      if (draft.status !== 'open' && draft.status !== 'decided') {
        return { ok: false, error: `register 决策 status 须 open|decided，收到 '${draft.status}'（id=${draft.id}）` };
      }
      const existing = findById(draft.id);
      if (existing) {
        // 重登记：转换合法性 + user-source 保护（AI 不得擅自改写 author 拍板的决策内容）。
        if (existing.source === 'user' && !opts.force) {
          return { ok: false, error: `决策 '${draft.id}' 是作者拍板（source:'user'）--改写须显式 force` };
        }
        if (!assertTransition(existing.status, draft.status)) {
          return { ok: false, error: `决策 '${draft.id}' 不允许 ${existing.status}->${draft.status}（编辑走 supersede，重议走 supersede+新 open）` };
        }
        const idx = next.indexOf(existing);
        // 重登记 = 字段级合并非整条覆盖（2.6 CR-B02/E02：拍板 flow 只发 status/reason 等，未提及的
        // relatedEpisodeId/landingState 保留既有值，alternatives 不被 default [] 清空——docstring「补
        // alternatives」语义；真要换血走 supersede 留 ADR 链）。supersededBy/dropReason 只由
        // supersede/drop op 设置，register 不动。createdAt 保留决策产生时间。
        next[idx] = {
          ...existing,
          ...draft,
          alternatives: draft.alternatives.length > 0 ? draft.alternatives : existing.alternatives,
          relatedEpisodeId: draft.relatedEpisodeId ?? existing.relatedEpisodeId,
          landingState: draft.landingState ?? existing.landingState,
          supersededBy: existing.supersededBy,
          dropReason: existing.dropReason,
          createdAt: existing.createdAt,
        };
      } else {
        next.push({ ...draft, createdAt: opts.nowISO });
      }
    } else if (action.op === 'supersede') {
      const old = findById(action.oldId);
      if (!old) return { ok: false, error: `supersede 目标 '${action.oldId}' 不存在` };
      if (old.source === 'user' && !opts.force) {
        return { ok: false, error: `决策 '${action.oldId}' 是作者拍板（source:'user'）--取代须显式 force` };
      }
      if (!assertTransition(old.status, 'superseded')) {
        return { ok: false, error: `决策 '${action.oldId}'（${old.status}）不可再 superseded（终态不可抹，再决策 register 新 id）` };
      }
      const draft = action.decision;
      if (draft.status !== 'open' && draft.status !== 'decided') {
        return { ok: false, error: `supersede 新决策 status 须 open|decided，收到 '${draft.status}'（id=${draft.id}）` };
      }
      if (draft.id === action.oldId) {
        return { ok: false, error: `supersede 新决策 id 不得等于 oldId（'${draft.id}'）--取代者是新决策` };
      }
      if (findById(draft.id)) {
        return { ok: false, error: `supersede 新决策 id '${draft.id}' 已存在--id 须唯一` };
      }
      old.status = 'superseded';
      old.supersededBy = draft.id;
      next.push({ ...draft, createdAt: opts.nowISO });
    } else {
      const target = findById(action.id);
      if (!target) return { ok: false, error: `drop 目标 '${action.id}' 不存在` };
      if (target.source === 'user' && !opts.force) {
        return { ok: false, error: `决策 '${action.id}' 是作者拍板（source:'user'）--放弃须显式 force` };
      }
      if (!assertTransition(target.status, 'dropped')) {
        return { ok: false, error: `决策 '${action.id}'（${target.status}）不可再 dropped（终态）` };
      }
      target.status = 'dropped';
      target.dropReason = action.reason;
    }
  }

  const warnings = findDanglingSuperseded(next).map(
    (r) => `决策 '${r.id}' 的 supersededBy '${r.supersededBy}' 悬空（指向不存在的决策 id）`,
  );
  return { ok: true, next, warnings };
}

