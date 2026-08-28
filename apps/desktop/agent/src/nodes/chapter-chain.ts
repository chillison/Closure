import { gzipSync } from 'node:zlib';
import type { ChainNodeDef } from '../contracts/run';
import type { SessionState } from '../types';
import type { GenerateFn } from './llm-node';
import { createBriefCompilerNode } from './brief-compiler-node';
import {
  createReaderAuditNode,
  createRevisionGuardNode,
  createRouteNode,
} from './chapter-nodes';
import { createWriterNode } from './writer-node';
import { createResearchVerifier } from './research-verifier';
import { createStorySyncNode } from './story-sync-agent';
import {
  createWorldExtractorNode,
  createWorldMergeNode,
  type WorldWriter,
} from './world-extractor-node';
import { createPromiseEmergenceNode } from './promise-emergence-node';
import { createArcEmergenceNode } from './arc-emergence-node';
import { createEmotionVerifyNode } from './emotion-verify-node';
import { createLintNode } from './lint-node';
import { createCompletenessVerifyNode } from './completeness-verify-node';
import { createFeedbackLedgerNode } from './feedback-ledger-node';
import { createChapterSummaryNode } from './chapter-summary-node';
import { createStoryTimeDriftNode } from './storytime-drift-node';
import {
  createMentionLedgerNode,
  createTargetedRevisionWithMentionDegrade,
} from './mention-ledger-node';
import { tagChinese } from '../audit/pos-tagger';
import { registry } from '../tool/registry';
import { logger } from '../logger';
import type { SlotAssignment, TaskModelSlot, WriteWorldStateRequest } from '@orison/shared-contracts';
import { assignmentContextWindowTokens, assignmentModelRef, assignmentThinkingControl } from '../runtime/taskModelRouting';
import { readContextPolicy } from '../runtime/contextPolicy';

/**
 * C3.2 任务路由 + S4b 思考策略：链装配的每节点 slot 解析闭包（workflow.ts runChapterChain
 * 注入，生产装配 = `(slot) => resolveTaskModel(slot)`）。返回 **assignment 整体**
 *（modelRef + thinking 策略，S1 slotAssignmentSchema）——模型与思考策略同源随档（design
 * §1.2「不杂交」）。缺省/空档 undefined → modelRef=undefined（provider default 哨兵自动选择）
 * + thinking=undefined（auto 不注入）= 未配置任务档的现状路径（字节级零变化）。
 */
export type ChainSlotResolver = (slot: TaskModelSlot) => SlotAssignment | undefined;

// ── Story 4.0 写章战术链段：写章链装配（design §4 / implement.md 5.1）──
//
// createChapterChainNodes 装配「brief 编译 → draft → storySync → revision 闭环（targeted-revision ↔
// multi-review ↔ route）」的 6 节点链段。每个节点是一个 AgentNode（纯代码 brief-compiler / storySync 或
// createLlmNode 实例化的 LLM 节点），按 ChainNodeDef 数组顺序驱动（chainRunner.runChain）。
//
// 链序决断（controller 2026-07-31 / design §4 实现决断）：
// 数组序 = [brief-compiler, draft-writer, storySync, targeted-revision, multi-review, route]
// （**非 DAG 直觉序**——DAG 里 targeted-revision 在 multi-review 之后，但链数组里必须在之前）。
// 原因：chainRunner revisionLoop 是连续前向切片 [from..through]（from<=through），loop 体
// [targeted-revision→multi-review→route] 必须在数组里连续 → targeted-revision 排 multi-review 前。
//
// revision 闭环自适应（design §4 / implement.md 5.1b）：
// - 首跑：targeted-revision 在 multi-review 前 → review.latest 缺 → shouldSkip → pass-through draft.initial
//   （不 generate）；multi-review 首跑产 review.latest；route 判 auto_revise → 闭环重跑。
// - 重跑：targeted-revision 见 review.latest → 改稿 overwrite draft.initial；multi-review 再审最新稿；
//   route 再判。迭代上限 cap，超限 → escalate_user（防死循环，ADR-17）。
//
// 节点 deps（generate + per-slot modelRef）由 runChapterChain（Step 5.2）从 WorkflowRuntime 注入——LLM 节点
// 经 createLlmNode 用单次 generate（design §4.2 / §6 tradeoff）；modelRef 经 C3.2 任务路由按节点档位
// 各自解析（llmDepsFor(slot)，见下）。session 供未来节点读 projectPath 等
// （4.0 LLM 节点不直接用 session，签名预留）。
//
// Story 4.2：Reader-Audit composite 节点（createReaderAuditNode）消费 L1 DI seams（tagChinese + compress）。
// tagChinese 从 agent native 模块（@node-rs/jieba，pos-tagger.ts）注入；compress 用 node:zlib gzipSync
// （agent node 运行环境）。draft-writer / targeted-revision / route 经 createLlmNode 忽略这两个字段（结构兼容）。
//
// 不升一等概念（spec line 126）：4.0 用简单顺序数组 + 一个声明式 revisionLoop，不建完整图引擎。
//
// expected_downstream_consumers:
// - Story 4.0 Step 5.2：runChapterChain（workflow.ts）调本装配 + CHAPTER_CHAIN_REVISION_LOOP。
// - Story 8.4：retrieval-agent 转岗资料员——核实子循环在 draft-writer 节点内派发（createWriterNode
//   deps.verifier，见下装配），非链内独立节点、也非 leader 侧派发；链段节点序不变。

/**
 * revision 闭环配置（design §4.1 / implement.md 5.1）。
 *
 * - from: 循环体重跑起始节点 = targeted-revision-agent（auto_revise 时改稿）。
 * - through: 循环体末节点 = route-agent（产出 route_decision 触发再判定）。BMad CR-001/002 fix 后 route 是链尾，
 *   pre-route 节点（completeness-verify + feedback-ledger）在 through-break 前跑完。
 * - cap: 最大重跑次数 = 3（超限强制 escalate_user，防死循环——ADR-17「迭代上限防死循环 + 超限升级」）。
 *
 * 切片 [from..through] = [targeted-revision, multi-review, completeness-verify, feedback-ledger, route]
 * （C1.2 后链数组 idx 17..21，from<=through ✓；绝对 idx 随后续链插入漂移，以 CHAPTER_CHAIN_NODE_IDS
 * 实序为准）。BMad CR-001/002 fix：completeness + feedback-ledger 移 route 前
 * （原 route 后 through-break 不可达），现在 loop 切片内。auto_revise 走 leader redo（chainRunner break 非
 * loopFromIdx），loop 切片不重跑 completeness/feedback-ledger；redo 重跑时两者覆盖重写（upsert idempotent 安全）。
 */
export const CHAPTER_CHAIN_REVISION_LOOP = {
  from: 'targeted-revision-agent',
  through: 'route-agent',
  cap: 3,
} as const;

/**
 * 链段节点 id 顺序（链装配权威序，供测试 + 链序守门）。
 *
 * Story 6.6 Phase C2：5 轴提取器（physical/cognitive/emotional/relational/factional）顺序挂载（draft 后、
 * world-merge 前）。**物理串行**——chainRunner 本便顺序驱动（一次只跑一个 LLM 节点），5 轴顺序跑守
 * `feedback-api-concurrency-no-parallel`（不引入并发）。world-merge 在 5 轴全跑完后机械组装 + 调
 * write_world_events 落表。revision 闭环切片 [targeted-revision..route] 仍连续；world 节点在闭环切片外，
 * 但 **Story 7.4 起 auto_revise 走 leader 驱动 redo**——redo 移除 draft-writer 出 completedSet 后
 * chainRunner 从它重跑到链尾全部（orchestration-pattern 语义 2），world 提取器与 story-sync **每轮 redo
 * 都重跑**：world 轴靠稳定 slice.id idempotent 替换（不累积）；story-sync 每轮重提取非白烧——中间轮喂
 * 该轮 multi-review 连续性记忆，终轮提取供 WP-E 反哺 applier（redo 产新 draft 本需新提取）。
 */
export const CHAPTER_CHAIN_NODE_IDS = [
  'brief-compiler-node',
  'draft-writer-agent',
  // Story 7.2：revision-guard 段落级改稿保义门（draft-writer 紧后）。
  // draft-writer 段落级时只产 passageText + 保改前整章（不 splice），本节点 L1+L2 判定后 splice：
  // clean → splice 落 draft.initial / soft-violation → pause art-mode / hard-violation → error。
  // 整章路径（无 revision_intent）pass-through 零回归。checkpointStage='revision-guard' 动态 pause
  // （workflow.ts onCheckpoint 闭包读 revision_guard.verdict，仅 soft-violation pause）。
  'revision-guard-agent',
  // C1.2 R6（用户拍板「软信号进闭环」）：lint-node 静态扫描纯代码节点（revision-guard 紧后、
  // world-extractor 前）。链位理由（design §3.1）：draft.initial 在 revision-guard splice 后才落定
  // （段落级模式），此前正文是「改前整章 + 改后段」混合形态非终版；world-extractor 前不影响五轴；
  // revision 闭环切片 [targeted-revision..route] 不含本节点 → auto_revise 闭环重跑不重复扫；redo
  // 重跑幂等（纯函数 over artifacts，lint_report 覆盖重写零副作用）。产 lint_report（review=agent
  // 桶 LintChapterReport）→ multi-review L2 叙事特征维软信号消费（静态命中≠定罪，L2 语义裁判）。
  'lint-node',
  // Story 6.6 Phase C1/C2：5 轴 world-state 提取器（物理串行顺序跑）+ merge 写表。draft 后；revision 闭环前。
  'world-extractor-physical',
  'world-extractor-cognitive',
  'world-extractor-emotional',
  'world-extractor-relational',
  'world-extractor-factional',
  'world-merge-node',
  // Story 5.3：emotion-verify 纯代码节点（world-merge 后、promise-emergence 前；revision 闭环外，跑一次）。
  'emotion-verify-node',
  // Story 6.5：Promise 涌现登记节点（world-merge 后、story-sync 前；revision 闭环外，跑一次）。
  'promise-emergence-node',
  // Story 8.2：写时弧节拍登记节点（promise-emergence 后、chapter-summary 前；revision 闭环外，跑一次）。
  // LLM 判线弧/卷弧本章 advance/close + 成长弧 advance（弧闭合 = 写手写时声明，语义归 LLM，用户拍板），
  // 经 arc_ledger_update（autoApply）写 arc_registry creative field。与 promise-emergence（读者债）认知
  // 任务不同故独立节点（design §7 trade-off：每章 +1 LLM pass 换契约洁净）。伏笔弧不在此（归 promise）。
  'arc-emergence-node',
  // Story 8.1：ChapterStateSummary 物化节点（promise-emergence 后、story-sync 前；revision 闭环切片外）。
  // 物化时机：summary 六字段含伏笔状态变更/未解决承诺/下章回收清单 → 须在 promise-emergence（写
  // promise_registry）之后取数才新鲜（design §2 链位理由）。redo 每轮重跑（orchestration-pattern 语义 2：
  // redo 重跑到链尾全部）→ handler 幂等 upsert last-write-wins，终轮摘要即终态；revision loop 切片
  // [targeted-revision..route] 不含本节点 → auto_revise 闭环重跑不重复物化。
  'chapter-summary-node',
  // Story 8.4 C2：storyTime 漂移守卫（纯代码观测节点，chapter-summary 紧后同链位——design §3.3
  // 定的「chapter-summary 旁」：输入 world_state.events 自 world-merge 已产，与 chapter-summary
  // 同属「提取落表后机械观测」族聚拢；必在 route（through-break）前；revision loop 切片外跑一次，
  // redo 重跑幂等（纯函数 over artifacts 零副作用）。窗外 warning 进校验议题通道（summarize
  // driftWarnings → write_chapter 文案行），零阻断零噪音（详 storytime-drift-node.ts 头注释）。
  'storytime-drift-node',
  // Story 8.7 S8：mention 共现账汇账节点（纯代码薄节点，storytime-drift 紧后、story-sync 前；revision
  // 闭环外跑一次）。四通道汇账（写手申报 + 在场记录升格 + 正文明写名粗筛 + 计划登场对拍）→ 经
  // record_episode_mentions builtin 写 closure_mention（per-episode 全量替换幂等）+ 章摘要 synopsis 回填
  // （UPDATE json_set——chapter-summary 物化在前由链序保证）。链位理由：①chapter-summary 后（synopsis
  // 回填前提）②route（through 节点）前（through-break 可达性）③world-merge 后（本章 patches 已落表，
  // 在场/状态通道取数新鲜）。产 mention_signals artifact（五类对拍差异信号，S9 leader 注入段消费）。
  // redo 每轮重跑 → per-episode 全量替换终轮账即终态；auto_revise 闭环重跑（loop 切片外）不重复记账。
  'mention-ledger-node',
  'story-sync-agent',
  'targeted-revision-agent',
  'multi-review-agent',
  // Story 4.4 + BMad CR-001/002 fix（2026-08-13）：completeness-verify 移 route 前。
  // 原放 route 后（idx15）但 route 是 through 节点 → chainRunner through-break（chainRunner.ts:296-297）
  // 致 post-through 节点不可达 → completeness-verify 生产链从不跑（4.4 pre-existing）。
  // 移 route 前（multi-review idx13 后）：completeness requiredArtifactKeys 消费 emotion_curve/
  // promise_registry/asset_cards 等（不依赖 route_decision），移 route 前语义安全（prd 集成测试段已确认）。
  // 4.4 原意 mirror emotion-verify（route 前），放 route 后是实施偏差，7.4 顺修。
  'completeness-verify-node',
  // Story 7.4 + BMad CR-001 fix（2026-08-13）：feedback-ledger 移 route 前。
  // 原放链尾（route 后 idx16）但 route through-break 致不可达 → ledger 写侧结构性失效（表永远空）。
  // 移 route 前（completeness-verify 后）：feedback-ledger 读 review.latest（multi-review 产）+
  // emotion_verify_result（emotion-verify-node 产）+ completeness_verify_result
  // （completeness-verify-node 产），三者都在 route 前产出 ✓。
  // route 仍 through 终点（break 后无 post-through 节点，可达性解决）。
  'feedback-ledger-node',
  // route-agent 是 through 节点（revisionLoop.through）——chainRunner auto_revise/accept/escalate 三档
  // 决策后 break。放链尾确保所有 pre-route 节点（含 completeness + feedback-ledger）在 through-break 前跑完。
  'route-agent',
] as const;

/**
 * 装配写章链段节点数组（design §4 / implement.md 5.1）。
 *
 * @param generate LLM 生成函数（GenerateFn，与 provider generate 兼容子集；runChapterChain 注入 generateImpl）。
 * @param resolveSlot C3.2 任务路由：每节点 slot 解析闭包（替代单份 modelRef，design §5 表）——各 LLM 节点
 *   装配行按 design §2 档位表各自调 resolveSlot(<slot>)；缺省 undefined → 全 undefined（自动选择现状）。
 * @param _session 派发链段的 child session（4.0 LLM 节点不直接用，签名预留供未来节点读 projectPath 等）。
 * @param signal  链段 abort 信号（CR-001 接线：runChapterChain 的 options.abort 同一 signal——runChain
 *   deps 持有的取消信号在此**同源透传给节点构造 deps**，写手 agent 循环（阶段一自查/补查/阶段二）与
 *   资料员核实子循环的取消窗口从「makeAgentLoop 兜底自建永不 abort 的 signal」变为真可中断。缺省 =
 *   各节点内部自建永不 abort 的 signal（4.0 既有行为——测试装配 / 不需取消的场景））。
 * @returns ChainNodeDef[]——按链序排好的 6 节点（brief-compiler → draft-writer → storySync →
 *   targeted-revision → multi-review → route）。
 */
export function createChapterChainNodes(
  generate: GenerateFn,
  resolveSlot: ChainSlotResolver | undefined,
  session: SessionState,
  signal?: AbortSignal,
  /** dogfood T1 Stage 6（design §4 / r1）：draft-writer 阶段二正文增量回调（runChapterChain 注入；装配处补 nodeId/role）。缺省不开（零回归）。 */
  onNodeDelta?: (data: { nodeId: string; role: string; phase?: string; messageId: string; delta: string }) => void,
): ChainNodeDef[] {
  // C3.2 任务路由（design §2 档位表 canonical）：单份 llmDeps 拆为 llmDepsFor(slot)——每个 LLM 节点
  // 装配行各自解析（接线漏了 = 恒走 fallback，与未配置不可观测区分 → 接线测试钉 generate 实收
  // opts.modelRef，task-model-routing.wiring.test.ts）。装配时解析一次（每章 run 一次——改档下一次
  // 链装配生效，design §1「链车道下一次链装配」语义）。
  // S4b：assignment 整体随档——llmDeps 增 thinking（assignmentThinkingControl 归一：custom 优先、
  // 非 auto 档位 {level}、否则 undefined=auto 不注入）。
  const resolveAssignment = (slot: TaskModelSlot): SlotAssignment | undefined => resolveSlot?.(slot);
  // Story 4.2：tagChinese + compress 注入 Reader-Audit L1（ADR-2 DI seams）。draft-writer/targeted-revision/
  // route 经 createLlmNode 忽略这两个字段（只读 generate/modelRef/signal）。compress 用 gzip level 9（同
  // stylometry.test.ts fixture 形态）。tagChinese native binding 缺时 isPosTaggerAvailable()=false，L1 跳过
  // POS 信号（design §10 rollback，余 7 信号仍上）。
  const llmDepsFor = (slot: TaskModelSlot) => {
    const assignment = resolveAssignment(slot);
    return {
      generate,
      modelRef: assignmentModelRef(assignment),
      thinking: assignmentThinkingControl(assignment),
      // CR-001：真 abort signal 进 llmDeps——写手 agent 循环（loopDeps 透传 makeAgentLoop）与全部
      // createLlmNode 系节点（legacy 直写引擎 / Reader-Audit / revision-guard / targeted-revision /
      // route）共享同一取消信号（runChain deps.signal 同源）。缺省 undefined → 各节点自建永不 abort
      // 的 signal（4.0 既有行为，测试装配零回归）。
      ...(signal !== undefined ? { signal } : {}),
      tagChinese,
      compress: (s: string) => gzipSync(s, { level: 9 }).length,
    };
  };
  // C3.2 design §2 软回退链：自查档空 → 跟随 writer-draft 档（S5 定案「两阶段同模型」既有默认）→
  // 自动选择。**assignment 粒度回退**（S4b，design §1.2）：取整 assignment（模型+思考策略同源），
  // 不出现 selfcheck 模型 + draft 思考策略的杂交。writer-selfcheck 档的**全部**调用面（Phase1
  // 自查/补查 loop + 资料员核实子循环）共用此值——核实器不得绕过回退链单独落自动选择（否则只配
  // draft 时自查阶段被劈成两个模型）。
  const writerSelfcheckAssignment = resolveAssignment('writer-selfcheck') ?? resolveAssignment('writer-draft');
  // S4c（design §4.1「makeAgentLoop 补闸门」接线）：写手两阶段循环 + 资料员核实子循环的 pre-gate
  // 窗口/红线——窗口取各自 loop 所用 assignment 的模型 limits（Phase2 写作/2.5 申报 = writer-draft；
  // Phase1 自查/补查 + 核实 = selfcheck 回退链整体）；红线链装配时 readContextPolicy() 现读
  //（seam 由 shell 注入，与 slot 同「下一次链装配生效」语义）。链段单发 createLlmNode 节点无会话史，
  // 不涉闸门（design §4.1）。未配置/未知模型 → undefined → S4a 接收面回落 1M。
  const writerDraftAssignment = resolveAssignment('writer-draft');
  const selfcheckWindowTokens = assignmentContextWindowTokens(writerSelfcheckAssignment);
  const draftWindowTokens = assignmentContextWindowTokens(writerDraftAssignment);
  const chainRedlinePercent = readContextPolicy()?.redlinePercent;
  // Story 6.6 Phase C1：world-state 写入器——经 registry 查 write_world_events builtin 工具（remoteToolProxy
  // → toolExecution IPC → shell worldStateHandlers）。工具未注册（测试环境 registry 空 / 未 registerBuiltinTools）
  // → 跳过落表 + warn 日志（graceful，merge 节点仍产 artifact）。生产路径 registerBuiltinTools 已注册该工具。
  // session 提供 projectPath / sessionId（handler 从 projectDir 解析 projectId；sessionId 走 toolExecution 通道）。
  const writeWorldEvents: WorldWriter = async (req: WriteWorldStateRequest) => {
    const tool = registry.get('write_world_events');
    if (!tool) {
      logger.warn(
        { sliceId: req.slice.id },
        'chapter-chain: write_world_events tool not registered → skip world-state write (merge node still produces artifact)',
      );
      return;
    }
    await tool.execute(req, {
      projectPath: session.projectPath,
      sessionId: session.id,
      abort: new AbortController().signal,
    });
  };
  return [
    // CR-13：checkpointStage 显式声明（取代 chainRunner 旧 nodeId 子串推断——子串匹配脆弱）。
    // 三类设点（design §4.6）：brief-compiler→brief（brief 落定①）/ draft-writer→draft（draft 入库前②）/
    // route→verdict（verdict 分叉③）。storySync/targeted-revision/Reader-Audit/world-* 不声明 → 不触发 checkpoint。
    { id: 'brief-compiler-node', node: createBriefCompilerNode(), checkpointStage: 'brief' },
    // Story 8.4 A2/A9 + Step 3（A4-A6）+ Step 4（A7/A8）：draft-writer 位换 createWriterNode（节点内
    // 两阶段 agent 循环——阶段一自查产调查简报 / 阶段二写作产 draft.initial 契约零变；writer 逻辑独立于
    // writer-node.ts，本装配行是 chapter-chain 唯一改动）+ 注入资料员核实器（createResearchVerifier——
    // retrieval-agent.yaml 转岗核实员，独立子循环对照任务卡核简报产 verdict；gaps 补查回合在节点内消费，
    // design §1.5；escalate/超限 → pause 型挂起载荷 research_brief.suspended → workflow onCheckpoint
    // decideCheckpointPause 全档位暂停，Step 4）。工具环境不可用（registry 空）/ 段落级改稿 intent →
    // 节点内部降级单发直写（design §5 零回归）；核实器自身失败 → graceful pass（增强层，research-verifier 内处理）。
    // Story 8.7 S9：核实器机械弹药出场间隔统计升级双源（出场账 mention 行优先——提及也算露面；无账/窗缺
    // 退世界状态口径），取数经 registry 内部直调（mention-query.ts 组合面，mirror 本文件 writeWorldEvents
    // 「链内经 registry 取数」先例）——装配面零新增参数，弹药口径升级在 research-verifier/mention-query 内闭环。
    {
      id: 'draft-writer-agent',
      // C3.2：写手双档（design §2）——deps.modelRef = writer-draft 档（Phase2 写作/2.5 申报/legacy
      // 直写引擎共用）；selfcheckModelRef = writer-selfcheck 档（Phase1 自查/补查 + 资料员核实子循环，
      // 8.4 阶段一核实回路），空档软回退 writer-draft 档（writerSelfcheckRef，见上）。writer-node 内
      // buildLoop 按 phase 取用。
      // dogfood T1 Stage 6：onNodeDelta 注入（nodeId/role 元数据在此补齐——writer-node 只产
      // phase/messageId/delta；seq 由 workflow runChapterChain 包装时分配）。
      node: createWriterNode({
        ...llmDepsFor('writer-draft'),
        selfcheckModelRef: assignmentModelRef(writerSelfcheckAssignment),
        selfcheckThinking: assignmentThinkingControl(writerSelfcheckAssignment),
        // S4c pre-gate 注入（见上方 writerSelfcheckAssignment 注释块的 S4c 段）。
        ...(draftWindowTokens !== undefined ? { contextWindowTokens: draftWindowTokens } : {}),
        ...(selfcheckWindowTokens !== undefined ? { selfcheckContextWindowTokens: selfcheckWindowTokens } : {}),
        ...(chainRedlinePercent !== undefined ? { redlinePercent: chainRedlinePercent } : {}),
        ...(onNodeDelta
          ? {
              onNodeDelta: (d) =>
                onNodeDelta({ nodeId: 'draft-writer-agent', role: 'draft-writer-agent', ...d }),
            }
          : {}),
        verifier: createResearchVerifier({
          generate,
          modelRef: assignmentModelRef(writerSelfcheckAssignment),
          thinking: assignmentThinkingControl(writerSelfcheckAssignment),
          ...(selfcheckWindowTokens !== undefined ? { contextWindowTokens: selfcheckWindowTokens } : {}),
          ...(chainRedlinePercent !== undefined ? { redlinePercent: chainRedlinePercent } : {}),
          // CR-001：核实子循环同源 signal（与写手循环 / runChain deps 同一取消信号）。
          ...(signal !== undefined ? { signal } : {}),
          projectPath: session.projectPath,
        }),
      }),
      checkpointStage: 'draft',
    },
    // Story 7.2：revision-guard 段落级改稿保义门（draft-writer 紧后）。
    // checkpointStage='revision-guard'——但 pause 是**动态**的：workflow.ts onCheckpoint 闭包读
    // run.artifacts['revision_guard'].verdict，仅 'soft-violation' 返 pause（clean/hard-violation/skipped
    // → continue 零打扰）。故不进 deriveCheckpointPolicy.pauseStages（那是 mode 驱动静态；revision-guard
    // 是 verdict 驱动动态）。chainRunner onCheckpoint 已是 async 返 CheckpointDecision（4.3），读 artifact 判。
    // producedArtifactKeys=['draft.initial','revision_guard']——clean splice 落 draft.initial + guard 报告
    // mutate revision_guard（NodeResult 单 stateKey，design §1.3）。
    { id: 'revision-guard-agent', node: createRevisionGuardNode(llmDepsFor('review-judge')), checkpointStage: 'revision-guard' },
    // C1.2 R6（design §3.1）：lint-node 静态扫描（纯代码，无 LLM）——draft.initial（revision-guard
    // splice 后落定）→ llmlint 静态引擎 agent 桶扫描 → lint_report artifact（链段软信号，
    // multi-review L2 叙事特征维消费，规则不单独定罪）。不声明 checkpointStage（链外增强节点，
    // mirror emotion-verify 不触发 checkpoint）。graceful：引擎缺位/draft 缺位/异常 → 空 report
    // 降级不破链（mirror Reader-Audit L1 try/catch 先例）；redo 重跑幂等（纯函数覆盖重写）。
    { id: 'lint-node', node: createLintNode() },
    // Story 6.6 Phase C1/C2：world-state 5 轴提取（LLM，物理串行顺序跑）+ merge 写表（纯代码）。draft 后挂；
    // revision 闭环外。5 轴各一 createWorldExtractorNode(axis)（C1 physical + C2 cognitive/emotional/
    // relational/factional）；axis 强制注入每条 patch（不信 LLM 标注）。物理串行（design §6 / feedback-api-
    // concurrency-no-parallel）：chainRunner 顺序驱动，5 轴顺序跑，不引入并发。merge 节点 requiredArtifactKeys
    // 含全部 5 轴 world_events.<axis>（见 world-extractor-node.ts WORLD_MERGE_CONTRACT）。
    { id: 'world-extractor-physical', node: createWorldExtractorNode('physical', llmDepsFor('extraction')) },
    { id: 'world-extractor-cognitive', node: createWorldExtractorNode('cognitive', llmDepsFor('extraction')) },
    { id: 'world-extractor-emotional', node: createWorldExtractorNode('emotional', llmDepsFor('extraction')) },
    { id: 'world-extractor-relational', node: createWorldExtractorNode('relational', llmDepsFor('extraction')) },
    { id: 'world-extractor-factional', node: createWorldExtractorNode('factional', llmDepsFor('extraction')) },
    { id: 'world-merge-node', node: createWorldMergeNode({ writeWorldEvents }) },
    // Story 5.3：emotion-verify 纯代码节点（world-merge 后、promise-emergence 前）。
    // 不声明 checkpointStage（增强非硬约束节点，mirror storySync/world-* 不触发 checkpoint）。graceful：
    // emotion_curve / emotional patches / promise_registry / asset_cards 任一缺 → runEmotionVerify 降级 degraded
    // result，不阻断链（design §10，mirror promise-emergence CR-E3 graceful 哲学）。纯代码节点无 LLM generate /
    // 无写表——只取 4 源 + 调 runEmotionVerify 纯函数 aggregator（setpoint/topology/DTW/payoff 数学，ADR-3）。
    // 产 emotion_verify_result artifact（链段，mirror route_decision 形态，不进 project.yaml）。
    { id: 'emotion-verify-node', node: createEmotionVerifyNode() },
    // Story 6.5：Promise 涌现登记节点（world-merge 后、story-sync 前；revision 闭环外）。
    // 段 1 纯代码 gap 检测（复用 6.1 detectPerspectiveGap）+ 段 2 LLM 涌现登记（promise-emergence-agent.yaml）
    // → 经 promise_ledger_update builtin 写 promise_registry。CR-E3 graceful：失败不破 chain（增强非硬约束）。
    // 段 1 经 query_world_slice builtin 取全轴 patches（registry 内部，mirror fetchWorldPatchesViaTool），
    // 段 2 LLM deps（generate/modelRef/signal）透传 llmDeps（tagChinese/compress 经 createLlmNode 忽略）。
    { id: 'promise-emergence-node', node: createPromiseEmergenceNode(llmDepsFor('extraction')) },
    // Story 8.2：写时弧节拍登记节点（promise-emergence 后、chapter-summary 前；revision 闭环外，跑一次）。
    // 段 1 纯代码（候选抽取 lines/phases/角色卡 + query_arc 既有 beats + episode 定位——episodeId/episodeIndex
    // 纯代码覆写，mirror 7.1 F2 坐标字段判据）+ 段 2 LLM 声明（arc-emergence-agent.yaml：advance/close 语义
    // 判断 + close 必带 grounding）→ arc_ledger_update（autoApply=true，mirror promise A1）写 arc_registry。
    // graceful（mirror promise CR-E3）：LLM 失败 / 工具缺 / 零 beats / 无候选 → 空 beats artifact + warning
    // 不破链。不声明 checkpointStage（链外增强节点，mirror promise-emergence 不触发 checkpoint）。
    // expected_downstream_consumers：Story 8.2 Step 4 post-settle——summary.arcEmergenceBeats 透传本章
    // beats → write_chapter detectVolumeClosure 关口大审判定 + detectArcStagnation 停滞触发。
    // redo 每轮重跑（orchestration-pattern 语义 2）→ arc_ledger_update 幂等（同 episodeId+arcRef+action
    // 自然键覆盖不累积）；loop 切片外 auto_revise 闭环重跑不重复登记。
    { id: 'arc-emergence-node', node: createArcEmergenceNode(llmDepsFor('extraction')) },
    // Story 8.1：ChapterStateSummary 物化节点（纯代码薄节点，promise-emergence 后、story-sync 前）。
    // 读 chapter_brief_input.episodeId → 调 materialize_chapter_summary builtin → shell handler 组装六字段
    // 摘要 + 机会式 checkpoint 落派生表（design §2 物化流）。不声明 checkpointStage（链外增强节点，mirror
    // emotion-verify / feedback-ledger 不触发 checkpoint）。graceful：episodeId 缺 / 工具未注册 / 物化失败
    // → warn + 降级 artifact 不破链（summary 是 DERIVED 可 backfill 重建，增强非硬约束）。
    // redo 每轮重跑幂等 upsert last-write-wins；loop 切片外 loop 重跑不重复物化（见上 NODE_IDS 注释）。
    { id: 'chapter-summary-node', node: createChapterSummaryNode() },
    // Story 8.4 C2（design §3.3）：storyTime 漂移守卫——纯代码观测节点（chapter-summary 紧后同链位，
    // 链位理由见 CHAPTER_CHAIN_NODE_IDS 注 + storytime-drift-node.ts 头注释）。读 world_state.events
    // （本章提取 slices storyTime 集）× scene_graph（本章场窗，isSceneInEpisode 单源）→ detectStoryTimeDrift
    // 纯函数比对 → storytime_drift artifact → summarize driftWarnings 透出 → write_chapter 校验议题文案。
    // 不声明 checkpointStage（链外观测节点，mirror chapter-summary 不触发 checkpoint）。graceful：episodeId
    // 缺 / world_state.events 缺 / 本章无归属场 → 跳过零噪音，链不破；warning 零阻断（不进 errors 不停链）。
    { id: 'storytime-drift-node', node: createStoryTimeDriftNode() },
    // Story 8.7 S8（design §2.2）：mention 共现账汇账——纯代码薄节点（cast_declaration / draft.initial /
    // scene_graph 投影 → record_episode_mentions builtin → shell 组装核心四通道合并 + 写表 + synopsis
    // 回填）。不声明 checkpointStage（链外增强节点，mirror chapter-summary 不触发 checkpoint）。
    // graceful：episodeId 缺 / 工具未注册 / 无申报（保守账）/ 通道输入缺 → 降级或保守账，不破链。
    // requiredArtifactKeys=[draft.initial, scene_graph]（dispatch 指定——粗筛源 + 计划对拍源硬依赖；
    // 链位上 world-extractor 已要求同两 key，恒在场）。「读工具零持久化副作用」红线不适用于本节点——
    // 它是链上写节点（sideEffects: persist_artifact，mirror chapter-summary-node 定位）。
    { id: 'mention-ledger-node', node: createMentionLedgerNode() },
    // Story 2.2 WP-E：story-sync 节点真跑 LLM 提取（激活空转件）。deps 注入 llmDeps（generate/modelRef/
    // signal，mirror world-extractor；tagChinese/compress 字段被节点忽略——结构兼容）+ session.projectPath
    // （loadStorySyncContext 读 project.yaml 组 context + field_metadata 版本）。graceful：LLM/parse 失败 →
    // 节点内降级 rules 兜底（空 patches）链不破。story.sync artifact 形态不变（multi-review 连续性记忆
    // 用途零回归）；终态反哺经 summarizeRunSnapshot deliverable 豁免 + write_chapter applier 消费。
    { id: 'story-sync-agent', node: createStorySyncNode({ llm: llmDepsFor('extraction'), projectPath: session.projectPath }) },
    // Story 8.7 S8：targeted-revision 位换降档包装（createTargetedRevisionWithMentionDegrade——修订实际
    // 落盘后经 degrade_episode_mentions 把本章 mention 账降保守档 + synopsis 标 stale，design §2.3；包装
    // 只外层观察，shouldSkip/契约/产物零变）。对话侧修订（rewrite_passage）不在此接（S10 惰性指纹兜底）。
    {
      id: 'targeted-revision-agent',
      node: createTargetedRevisionWithMentionDegrade(llmDepsFor('writer-draft')),
    },
    // Story 4.2：multi-review 节点换为 Reader-Audit composite（L1 stylometry → L2 LLM 双层审核）。
    // 节点 id 仍 'multi-review-agent'（design §10 节点替换隔离：stable artifact contract + registry +
    // checkpoint 不变）；factory 函数改名 createReaderAuditNode，实现换为 composite L1→L2。
    { id: 'multi-review-agent', node: createReaderAuditNode(llmDepsFor('review-judge')) },
    // Story 4.4 + BMad CR-001/002 fix：completeness-verify 移 route 前（原 route 后 through-break 不可达）。
    // 不声明 checkpointStage（增强非硬约束节点，mirror emotion-verify-node / storySync 不触发 checkpoint）。
    // graceful：累积数据源任一缺 → L1 降级空候选 + L2 跳过该类 + degraded=true 标注，不阻断链（design §8，AC6）。
    // L2 LLM 做语义挣得裁判（判挣得/兑现/推进，机械测不出）；L1 纯代码候选汇编（枚举/派生/统计，假信心门红线：
    // 不做伪量化评分）。产 completeness_verify_result artifact（链段，mirror emotion_verify_result 形态，不进
    // project.yaml）。verdict 经 write_chapter completenessFeedback var 透传 Director（cross-chapter 持久化
    // 经 feedback-ledger-node 接通，Step 2 激活）。
    { id: 'completeness-verify-node', node: createCompletenessVerifyNode(llmDepsFor('review-judge')) },
    // Story 7.4 + BMad CR-001 fix：feedback-ledger 移 route 前（原 route 后 through-break 不可达）。
    // 不声明 checkpointStage（增强非硬约束节点，mirror emotion-verify / storySync 不触发 checkpoint）。
    // graceful：三 artifact 不全（falsy 守卫）/ episodeId 缺 / 工具未注册 → warn 继续，不阻断链（design §2.2，
    // mirror 6.6 world-state 增强哲学）。读 run.artifacts 三 key → 调 feedback_ledger_write builtin 写 ledger
    // （per-episode per-artifact upsert）。在 loop 切片 [targeted-revision..route] 内——auto_revise 走 leader redo
    // （chainRunner break 非 loopFromIdx），loop 切片不重跑 ledger；redo 重跑时 ledger 覆盖重写（upsert idempotent）。
    { id: 'feedback-ledger-node', node: createFeedbackLedgerNode() },
    // route 通过 through 节点放链尾——所有 pre-route 节点（含 completeness + feedback-ledger）在 through-break
    // 前跑完。checkpointStage='verdict'（verdict 分叉③，CR-08-02-autonomy-modes-001 终态处理后 fire）。
    { id: 'route-agent', node: createRouteNode(llmDepsFor('review-judge')), checkpointStage: 'verdict' },
  ];
}
