import type { ReusableAgentNodeContract, ArcBeat, ArchiveIssue, ChapterAcceptArtifact, ChapterAcceptResult, CompileReport, EscalateFinding, ResearchSuspension, RevisionGuardArtifact, NovelStorySyncPayload, StoryTimeDriftWarning } from '@orison/shared-contracts';
import type { SessionState } from '../types';
import type { GenerateFn } from '../nodes/llm-node';
import type { SessionPermissionMode } from '../runtime/toolPolicy';

// ── Story 4.0 写章战术链段：RunSnapshot + 节点契约接口 + runChain 选项类型 ──
//
// 本文件是 AgentNode 链段的「契约层」——RunSnapshot（artifact 流转载体）+ 节点接口（AgentNode /
// NodeResult / NodeRunInput）+ runChain 驱动器选项（ChainNodeDef / RunChainOptions / RunChainDeps /
// RunSnapshotSummary）。AgentNode/NodeResult 在 Step 4.1 从 nodes/base.ts 挪入此处（与 RunSnapshot /
// NodeRunInput 同处，清理前置：base.ts 仅留节点工厂，接口归契约层）。
//
// type-only import 避循环依赖：contracts/run.ts ⇄ nodes/llm-node.ts 互引类型（GenerateFn / AgentNode），
// 均为 `import type`（编译期擦除，无运行时循环）。SessionState 来自 types.ts（无反向依赖）。
//
// 期望下游消费者（design §5 下游预期接口）：
// - Story 4.0 Step 4：runChain 驱动器（runtime/chainRunner.ts）消费 RunChainOptions/RunChainDeps。
// - Story 4.0 Step 5：createChapterChainNodes 装配 ChainNodeDef[] + WorkflowRuntime.runChapterChain。
// - Story 4.1/4.2/4.3/4.5/6.6：节点 run() 升级 / 新节点接入（reads/owns 契约复用）。

export interface RunSnapshot {
  runId: string;
  status: string;
  currentNodeId: string | null;
  projectPath: string;
  completedNodes: string[];
  pendingNodes: string[];
  artifacts: Record<string, unknown>;
  review: { verdict?: string; summary?: string; reasons?: string[] } | null;
  archive: { versionId: string; archivedAt?: string; promptFiles?: string[] } | null;
  delivery: { deliveryId: string } | null;
  feedback: { feedbackId: string } | null;
  /**
   * 链段运行中累积的错误/告警信息（DAG 依赖缺失 / 节点 error artifact / revision cap 超限等）。
   * additive optional（Step 4.1 新增，零 migration）——summarizeRunSnapshot 抽取给 leader（context isolation：
   * 只回 summary 不回内部 trace）。节点正常产出不写此项。
   */
  errors?: string[];
}

export interface NodeRunInput {
  run: RunSnapshot;
  requirement: string;
}

/** 节点 run() 产出：写入 run.artifacts[stateKey] = artifact（design §4 数据流）。 */
export interface NodeResult {
  stateKey: string;
  artifact: unknown;
}

/**
 * AgentNode：链段节点契约（ADR-4 explicit contracts）。
 * - contract: 节点元数据（reads requiredArtifactKeys / owns producedArtifactKeys / sideEffects），可 null（临时节点）。
 * - run(input): 读 input.run.artifacts → 执行（LLM / 纯代码）→ 返 {stateKey, artifact}。
 *
 Step 4.1 从 nodes/base.ts 挪入此处（与 RunSnapshot/NodeRunInput 同处）。
 */
export interface AgentNode {
  contract: ReusableAgentNodeContract | null;
  run(input: NodeRunInput): Promise<NodeResult>;
}

/**
 * checkpoint 阶段（design §4.6 三类设点 + Story 7.2 revision-guard）。
 *
 * - brief-compiler→'brief'（brief 落定①）/ draft-writer→'draft'（draft 入库前②）/ route→'verdict'（verdict 分叉③）。
 * - Story 7.2：revision-guard→'revision-guard'（段落级改稿保义门，**动态 pause**——onCheckpoint 闘包读
 *   revision_guard.verdict，仅 soft-violation 才 pause；clean/hard-violation/skipped 不 pause 零打扰。
 *   非 deriveCheckpointPolicy 静态 pauseStages——revision-guard pause 由 verdict 驱动非 mode 驱动）。
 *
 * Story 4.3 提取为命名 type（ChainNodeDef.checkpointStage / CheckpointPolicy.pauseStages / onCheckpoint stage
 * 参数 / CheckpointDecision 共用，取代各处内联 union）。CR-13 显式声明取代旧 nodeId 子串推断。
 */
export type CheckpointStage = 'brief' | 'draft' | 'verdict' | 'revision-guard';

/**
 * 链段节点定义：id（链内唯一标识，用于 checkpoint stage 识别 + revisionLoop from/through 引用）+ node。
 *
 * `checkpointStage`（CR-13）：显式声明该节点触发的 checkpoint 阶段（brief/draft/verdict），取代早期
 * 的 nodeId 子串推断（`includes('brief'|'route'|'draft')` 脆弱——未来节点 id 含这些子串会假触发）。
 * 链装配（chapter-chain.ts）按 design §4.6 三类设点标注；chainRunner 用 `def.checkpointStage` 而非子串。
 * 不声明 → 该节点不触发 checkpoint（如 storySync/targeted-revision/multi-review 等中间节点）。
 */
export interface ChainNodeDef {
  id: string;
  node: AgentNode;
  /** 显式 checkpoint 阶段（design §4.6 三类设点）；缺省 → 该节点不触发 onCheckpoint（CR-13）。 */
  checkpointStage?: CheckpointStage;
}

/**
 * Story 4.3 onCheckpoint 返回的决策（design §3.2 D2，4.3 升 async 返决策）。
 *
 * - continue：链段继续下一节点（4.0 全自动 fire-and-forget 行为，零回归）。
 * - pause：链段在当前 checkpoint 中断（status='paused' + currentNodeId 停该 checkpoint 节点 + break +
 *   返 snapshot；runChapterChain 检测后交还 leader，design §2 Option A break-complete-callback）。
 *
 * 范式判据（ADR-3）：pause 决策由纯代码机械判（policy.pauseStages.includes），非 LLM 语义判断。
 */
export type CheckpointDecision = { action: 'continue' } | { action: 'pause' };

/**
 * Story 4.3 三模式 checkpoint 策略（design §3.1 / §4 映射表 / KD2）。
 *
 * - pauseStages：scheduled pause 的 checkpoint 阶段集合（半自动 / 微操模式在此停→交还 leader→人检→resume 续跑）。
 *   全自动 → `[]`（不 scheduled pause，连续跑完 = 4.0 行为零回归）。
 * - escalateMode：灰区 escalate（route=escalate_user）如何处理——`auto-trust` 采信裁决器 recommendation skip
 *   ask_user / `ask` 走 4.6 既有 PatchReview 裁决（design §3.8 / KD2「细分 ask_user = reactive escalate mode-dependent」）。
 *
 * escalateMode 字段本 step（2）落 type + derive，**消费点在 chainRunner route=escalate 分支 = Step 6 接通**
 * （本 step runChapterChain 只消费 pauseStages，escalateMode 暂透传不消费，design §3.8 / Step 6 mode-gating）。
 */
export interface CheckpointPolicy {
  pauseStages: CheckpointStage[];
  escalateMode: 'auto-trust' | 'ask';
}

/**
 * 从 SessionPermissionMode（3.1 autonomy 三档 readonly/suggest/auto）推导 CheckpointPolicy（design §4 映射表 / KD2）。
 *
 * - `auto`（全权/全自动）→ 无 scheduled pause + 灰区 `auto-trust` 裁决器（skip ask_user）。零回归：等价 4.0 行为。
 * - `suggest`（半自动）→ `['draft']` checkpoint pause（每章 prose review 一次，避 chat-fatigue ADR-17）+ 灰区 `ask`。
 * - `readonly`（微操/细分）→ `['brief','draft','verdict']` 全 checkpoint pause（逐确认）+ 灰区 `ask`（max 介入）。
 *
 * 复用 permissionMode 作密度信号（KD1：读值非用 tool-gating，不加新 UI 旋钮）。范式判据（ADR-3）：mode→checkpoint
 * 密度映射是用户偏好（UX/控制），pause/resume 机制纯代码（确定性）。
 *
 * 消费点：write_chapter tool / closureChainIpc 入口从 `session.permissionMode` 推导后传 runChapterChain `options.mode`
 * （Step 3 wiring）。本 step（2）只落 derive 函数 + runChapterChain 消费 pauseStages。
 */
export function deriveCheckpointPolicy(mode: SessionPermissionMode): CheckpointPolicy {
  switch (mode) {
    case 'auto':
      return { pauseStages: [], escalateMode: 'auto-trust' };
    case 'suggest':
      return { pauseStages: ['draft'], escalateMode: 'ask' };
    case 'readonly':
      return { pauseStages: ['brief', 'draft', 'verdict'], escalateMode: 'ask' };
  }
}

/**
 * Story 8.4 Step 4（A8）：checkpoint pause 判定**单源**（workflow.ts runChapterChain onCheckpoint 闭包
 * 调用；此前闭包内联判定，7.2 revision-guard 动态 pause 与 4.3 mode 驱动 pauseStages 两段逻辑散在
 * 闭包里，8.4 加第三段时收敛为纯函数——机械判定可单测，防闭包内联漂移）。
 *
 * 三层判定（顺序即优先级）：
 * 1. **revision-guard 动态 pause**（Story 7.2，verdict 驱动非 mode 驱动）：stage='revision-guard' 且
 *    `artifacts['revision_guard'].verdict==='soft-violation'` → pause（art-mode 卡）；clean/
 *    hard-violation/skipped → continue（clean 零打扰；hard-violation 已是 error artifact 链段停）。
 * 2. **出发核查挂起 pause**（Story 8.4，suspension 驱动非 mode 驱动，mirror 7.2 先例）：stage='draft'
 *    且 `artifacts['research_brief'].suspended` 存在 → pause——**全档位（含 auto，无例外）**：结构性
 *    矛盾不带病开写（prd 拍板 4 / A8；mirror 3.5「BLOCK 永不采信」）。挂起时 draft.initial 不存在，
 *    continue 会跳过 draft-writer 撞下游 DAG blocked——恢复只有 redo（resumeOptions=['redo','abort']）。
 * 3. **mode 驱动静态 pauseStages**（Story 4.3）：policy.pauseStages.includes(stage) → pause。
 *    policy 缺省（4.0 既有 / 无 onCheckpoint 消费方）→ 恒 continue（全自动零回归）。
 *
 * 范式判据（ADR-3）：三层全是纯代码机械判定（artifact 字段存在性 / 枚举匹配 / 集合包含）——pause 与否
 * 的**内容性判断**（矛盾真伪 / 该不该改）归人（leader 核实 + 用户决断），不在此编码。
 */
export function decideCheckpointPause(
  stage: CheckpointStage,
  snapshot: RunSnapshot,
  policy: CheckpointPolicy | undefined,
): CheckpointDecision {
  // 1. Story 7.2：revision-guard soft-violation 动态 pause（verdict 驱动）。
  if (stage === 'revision-guard') {
    const guard = snapshot.artifacts['revision_guard'] as { verdict?: string } | undefined;
    return guard?.verdict === 'soft-violation' ? { action: 'pause' } : { action: 'continue' };
  }
  // 2. Story 8.4 Step 4（A8）：出发核查挂起全档位暂停（suspension 驱动；auto 无例外——结构性矛盾
  //    不带病开写）。presence 判定（非 schema parse）：suspended 字段在即挂起意图成立（载荷由
  //    writer-node 机械构造，summarize 侧 safeParse 守形）。
  if (stage === 'draft') {
    const research = snapshot.artifacts['research_brief'] as { suspended?: unknown } | undefined;
    if (research !== undefined && research.suspended !== undefined) {
      return { action: 'pause' };
    }
  }
  // 3. Story 4.3：mode 驱动静态 pauseStages。
  return policy?.pauseStages.includes(stage) ? { action: 'pause' } : { action: 'continue' };
}

/**
 * 链段 abort 时抛出的错误（design §4.1 abort/resume）。
 * - name='AbortError'：与 runLoop/DOMException 取消语义一致（isAbortError 判定）。
 * - 携带 snapshot：runChapterChain（Step 5）catch 后可读 .snapshot 持久化到 RunStateStore.chainSnapshot，
 *   实现 ADR-17「RunSnapshot + 编排状态一起持久」（resume 不丢上下文）。
 */
export class ChainAbortedError extends Error {
  constructor(public readonly snapshot: RunSnapshot) {
    super('chain run aborted');
    this.name = 'AbortError';
  }
}

/**
 * runChain 选项（design §4.1）。
 *
 * - chain: 顺序节点数组（按 DAG 拓扑序排好；4.0 用简单顺序驱动，非完整图引擎——spec line 126「先 subgraph 模式」）。
 * - initialArtifacts: leader 注入的上游 artifact（scene_graph / settings_context / chapter_brief_input；
 *   链段不从 intake 重跑，spec line 35/124）。
 * - requirement: 本章需求描述（brief-compiler 作 episodeId 兜底等）。
 * - revisionLoop: 闭环配置（route auto_revise 时回 from→through 重跑，上限 cap，超限升级 escalate）。
 *   - from: 循环体重跑起始节点 id（如 targeted-revision）。
 *   - through: 循环体末节点 id（route，产出 route_decision 触发再判定）。
 *   - 约束：from 在 chain 中的 index 必须 <= through index（循环体 = chain 切片 [from..through]，
 *     Step 5 装配时按此约束排节点序；详见 chainRunner.runChain 注释）。
 *   - cap: 最大重跑次数（超限强制 escalate_user，防死循环——ADR-17 警示「迭代上限防死循环 + 超限升级」）。
 * - onCheckpoint: 三类设点回调（brief/draft/verdict，design §4.6）。Stage 由 ChainNodeDef.checkpointStage 显式
 *   声明（CR-13，取代旧 nodeId 子串推断）。4.0 全自动模式默认不 pause（只 resumable-abort）；pause-at-checkpoint 半自动 = Story 4.3。
 *   **Story 4.3 Step 2（design §3.2 D2）**：升级为 **async 返 CheckpointDecision**（4.0 同步 fire-and-forget → 4.3
 *   `Promise<{action:'continue'} | {action:'pause'}>`）。返 `{action:'pause'}` → runChain status='paused' + break +
 *   交还 leader（design §2 Option A）；返 `{action:'continue'}` → 续跑（全自动零回归 = 4.0 行为）。旧同步调用方
 *   包 async（workflow.ts onCheckpoint 闘包已升 async，design §3.4）。
 * - resumedCompletedNodes: resume 恢复用——已完成的节点 id 列表（initialArtifacts 须含其产出），
 *   runChain 跳过这些节点（节点重跑须 idempotent，ADR-17 警示；LLM 节点重跑产出可能不同，4.0 接受）。
 */
export interface RunChainOptions {
  chain: ChainNodeDef[];
  initialArtifacts: Record<string, unknown>;
  requirement: string;
  revisionLoop?: { from: string; through: string; cap: number };
  onCheckpoint?: (stage: CheckpointStage, snapshot: RunSnapshot) => Promise<CheckpointDecision>;
  /**
   * dogfood T1 Stage 6（design §4，r1）：**每节点**边界回调（additive optional）——onCheckpoint
   * 只在声明 checkpointStage 的节点 fire（brief/draft/revision-guard/verdict 四处），不能驱动
   * 全链步进；本回调在每个节点终态时同步 fire：成功 = 'done'（artifact 写入 + completedNodes
   * 记录后）、error artifact / 节点 throw 合成 = 'error'、DAG requiredArtifactKeys 缺失 = 'blocked'。
   * resume 跳过的节点不 fire（前一 run 已 fire 过）。消费方 = workflow runChapterChain（转
   * chain-node-done 事件，链 UI 步进条数据源）。缺省不调（零回归）。
   */
  onNodeDone?: (nodeId: string, status: 'done' | 'error' | 'blocked') => void;
  resumedCompletedNodes?: string[];
  /**
   * 4.1 Step 4（CR-15b）：accept 分支回调。route=accept_as_truth 时调，产 `chapter_accept` artifact
   * （{chapterId, candidate, storyDecisions?, runId}）写入 run.artifacts['chapter_accept']。**链段不写盘**
   * （纯驱动 + 可测；持久化在入口层 IPC/leader）。
   *
   * 回调由入口层（write-chapter tool / closureChainIpc）提供，闭包捕获 project 数据（novel.chapters +
   * episode_outlines）做 chapterId 解析。返回 undefined（draft 缺 / chapterId 映射失败）→ 不写 chapter_accept
   * （accept 持久化阻断，入口层据 summary.chapter_accept 缺省返明确报错）。
   *
   * `ctx.nowISO` = 入口注入 ISO 时间戳（StoryDecision.createdAt 用；纯函数无 Date，入口注入）。
   */
  onAccept?: (
    snapshot: RunSnapshot,
    ctx: { nowISO: string },
  ) => ChapterAcceptResult | undefined;
  /**
   * 4.1 Step 4：入口注入的 ISO 时间戳（onAccept ctx.nowISO 源；纯函数无 Date）。workflow.ts runChapterChain
   * 入口生成（`new Date().toISOString()`），threading 进 runChain opts。缺省 → ''（onAccept/buildChapterAccept
   * 收到空串 → CR-4.1-09：返 skipReason:'no-nowiso' 跳过 StoryDecision 登记，不产 invalid createdAt 违
   * `z.string().min(1)`；旧 docstring「闭包兜底」不存在，已校准）。生产路径 workflow.ts 总会注入。
   */
  nowISO?: string;
}

/**
 * runChain 依赖注入（design §4.1 RunChainDeps）。
 *
 * - generate: LLM 生成函数（GenerateFn from nodes/llm-node.ts，与 provider generate 兼容子集签名）。
 *   透传给 createLlmNode（Step 5 装配时 deps 注入）；runChain 自身不直接调 generate（节点内部调），
 *   保留在 deps 供 Step 5 createChapterChainNodes 透传 + 未来节点直接消费。
 * - sessionContext: 派发链段的 child session（SubagentRuntime.dispatch 产）——projectPath 等来源。
 * - signal: 链段 abort 信号（RunStateStore.beginRun 返；abort → 存 checkpoint + 抛 ChainAbortedError）。
 */
export interface RunChainDeps {
  generate: GenerateFn;
  sessionContext: SessionState;
  signal: AbortSignal;
}

/**
 * BMad CR-T1-056：per-project 活动链守卫 busy 拒绝的 errors[0] 机器可读前缀——
 * `chain_run_active|heldBy=<holderSessionId>`（mirror D4 project_run_active 消费语义：leader 据
 * 工具结果自察 / dogfood IPC 透传 UI 提示「该项目另一条链正在运行或暂停待审阅」）。
 */
export const CHAIN_RUN_ACTIVE_ERROR_PREFIX = 'chain_run_active';

/**
 * RunSnapshot 摘要（context isolation，design §4.3 / ADR-17）。
 *
 * 链段只回摘要给 leader，**不抽内部 trace / 全量 artifacts**（防 leader 长程上下文爆炸——spec line 29
 * 「链段只回 RunSnapshot 摘要，不灌 leader context」）。leader 据摘要决定下一步（继续/改/问用户）。
 *
 * - status: running/completed/blocked/error/aborted/**paused**(4.3)/**auto_revise_pending**(7.4：route 判
 *   auto_revise 时 break 出主循环交 leader 驱动 redo，非终态)。
 * - routeDecision: route 节点判决（auto_revise/accept_as_truth/escalate_user）。
 * - reviewVerdict: multi-review verdict（pass/revise/escalate）。
 * - draftTitle/draftWordCount: 初稿或修订稿的标题/字数（draft.initial 优先，否则 revision.output）。
 * - draftText: 初稿/修订稿正文（CR-15a 落地公理——prose 是 deliverable 非 internal trace，豁免 context
 *   isolation：链段产出须抵达读者/dogfood 检视）。持久化到 chapter .md defer 4.1（CR-15b）。
 * - pausedStage/draftContent/briefContent: Story 4.3 pause-review payload（status='paused' 时抽，design §3.4）。
 * - errors: 链段错误累积（DAG 缺失 / error artifact / cap 超限）。
 */
export interface RunSnapshotSummary {
  status: string;
  routeDecision?: {
    decision: string;
    reason: string;
    /**
     * dogfood R2 #107 / R1.1c：route 判正文偏离计划（deviation=true）时投影（源 route_decision
     * artifact 的 deviation boolean）。#107 no-chapter 自动建章时入口层（write_chapter /
     * closureChainIpc）补产 storyDecisions 的数据源（buildAcceptStoryDecisions 单源消费）——修前
     * summary 只有 decision+reason，补产只能静默降级不登记（用户拍板不降级）。只在 true 时出现
     * （false/缺省省略）。additive optional（零 migration）。镜像 shared ipc.ts
     * RunChapterChainSummary.routeDecision.deviation（两处平行 type 同步，B01 纪律）。
     */
    deviation?: true;
  };
  reviewVerdict?: string;
  draftTitle?: string;
  draftWordCount?: number;
  /** 初稿/修订稿正文（CR-15a：prose 是 deliverable，豁免 context isolation）。 */
  draftText?: string;
  /**
   * Story 4.3：status='paused' 时链段暂停的 checkpoint 阶段（brief/draft/verdict）。供 leader / UI 决定 review
   * 形态（draft→prose-review 面板 / brief→对话软门 / verdict→PatchReview）。非 paused 缺省。
   * additive optional（零 migration）。pausedStage 由 runChapterChain 从 currentNodeId 经 chain 的 checkpointStage
   * 解析后以 pauseHint 传入 summarize（summarize 无 chain 上下文，design §3.4「从 currentNodeId/checkpointStage 推」）。
   */
  pausedStage?: CheckpointStage;
  /**
   * Story 4.3：draft checkpoint pause 时的正文（review payload，豁免 context isolation 同 CR-15a prose 是 deliverable）。
   * 源 `artifacts['draft.initial'].text`（同 draftText 源，仅在 paused 时抽作 review 载荷）。非 paused 缺省。
   */
  draftContent?: string;
  /**
   * Story 4.3：brief checkpoint pause 时的 chapter_brief artifact（review payload，豁免 context isolation）。
   * 源 `artifacts['chapter_brief']`（object / 任意 shape，UI 据其渲染 brief 摘要供人确认）。非 paused 缺省。
   */
  briefContent?: unknown;
  /**
   * Story 7.2：revision-guard pause（soft-violation）时的保义门载荷。deliverable 非 trace（同 draftContent
   * 豁免 context isolation）——UI art-mode 卡据此展示 findings + 改前/改后，作者决定强行放行/改/取消。
   * 源 `artifacts['revision_guard']`。非 revision-guard pause 缺省。
   */
  revisionGuard?: RevisionGuardArtifact;
  /**
   * accept 持久化载荷（CR-15b / 4.1 Step 4：route=accept_as_truth 时，onAccept 产 chapter_accept artifact；
   * deliverable 非 trace，同 draftText 豁免 context isolation）。入口层据此持久化：IPC 调
   * acceptChapterCandidate 写盘 / leader 转 field_patch metadata 走 patch review。route 非 accept /
   * chapterId 映射失败 → 缺省。
   */
  chapter_accept?: ChapterAcceptArtifact;
  /**
   * route=escalate_user 时附带：Reader-Audit 灰区 findings grounding（quote/location/severity），
   * 供裁决器子 agent 初审 + 用户裁决（Story 4.6）。非 escalate 缺省。additive optional（零 migration）。
   */
  escalateFindings?: EscalateFinding[];
  /**
   * Story 7.4：route=auto_revise 时附带 Reader-Audit findings grounding（quote/location/severity），
   * 供 leader write_chapter 调 revision-optimizer 编译 RevisionIntent（A-trigger audit-finding source）。
   * 抽取逻辑同 escalateFindings（block/warn drop info + grounding 硬要求），独立字段（零回归 escalateFindings
   * 语义/消费者）。auto_revise break（status='auto_revise_pending'）时 leader 据此驱动 redo 闭环。非 auto_revise
   * 缺省。additive optional（零 migration）。
   */
  autoReviseFindings?: EscalateFinding[];
  /**
   * Story 2.2 WP-E：route 终态（accept_as_truth / escalate_user）时附带 story-sync 反哺提取载荷
   * （patches + summary，源 `artifacts['story.sync']`）。deliverable 非 internal trace（同 chapter_accept /
   * escalateFindings 豁免 context isolation）——write_chapter applier 据此转 story_sync_apply 落盘（suggest
   * 档 envelope 人审 / auto 档直落 / escalate 档随裁决材料呈现）。空 patches 不抽（零痕迹）；
   * auto_revise 中间轮不抽（非终态，防 summary 膨胀）。additive optional（零 migration）。
   */
  storySync?: NovelStorySyncPayload;
  /**
   * Story 8.2：本章写时声明的弧节拍（源 `artifacts['arc_emergence'].beats`，arc-emergence-node 产；
   * 无则空数组）。deliverable 非 internal trace（同 escalateFindings 豁免 context isolation）——
   * write_chapter post-settle 据此做关口判定（detectVolumeClosure：卷弧 close beat → 派 arc-audit-agent
   * 大审）+ 停滞检测兜底（本章零节拍可见）。additive optional（零 migration）。镜像 shared ipc.ts
   * RunChapterChainSummary.arcEmergenceBeats（两处平行 type 同步，B01 纪律）。
   */
  arcEmergenceBeats?: ArcBeat[];
  /**
   * Story 8.4 Step 3（A7 档案议题通道）：出发核查（资料员）verdict 的 archive_issues 透传（源
   * `artifacts['research_brief'].verdict.archive_issues`，writer-node 存档）。deliverable 非 internal trace
   * （同 escalateFindings 豁免 context isolation）——设定卡过时/矛盾须 leader/用户看见处理（人导演域，
   * 资料员无档案写权限）；呈现走 write_chapter output 文案行（3.3 校验议题进 chat 同通道：tool result →
   * leader 主动提 + 对话解决，不造新通道）。空/缺不抽（零痕迹）。additive optional（零 migration）。
   */
  archiveIssues?: ArchiveIssue[];
  /**
   * Story 8.4 C2（design §3.3）：提取器 storyTime 漂移 warning 透传（源
   * `artifacts['storytime_drift'].warnings`，storytime-drift-node 产——chapter-summary 链位旁守卫
   * 步骤）。deliverable 非 internal trace（同 archiveIssues 豁免 context isolation——3.3 校验议题
   * 进 chat 同通道：write_chapter 文案行呈现 → leader 主动提 + 对话解决，人核对 scene_graph 或
   * 重提取）。**零阻断零噪音**：warning 不进 errors 不停链；无 slices / 本章无归属场 / 全在窗内
   * → 空，缺省不抽（零痕迹）。additive optional（零 migration）。守卫容差 0 = 校准点 dogfood
   * （shared storytime-drift.ts STORYTIME_DRIFT_TOLERANCE 注释，deferred-work 记档）。
   */
  driftWarnings?: StoryTimeDriftWarning[];
  /**
   * Story 8.4 Step 4（A7/A8 矛盾暂停与挂起）：draft pause 因出发核查挂起（verify_exhausted /
   * research_contradiction）时的挂起载荷（源 `artifacts['research_brief'].suspended`，writer-node 产）。
   * deliverable 非 internal trace（同 escalateFindings 豁免 context isolation——用户决断所需证据：
   * 矛盾/偏离明细或缺漏清单）。**全档位暂停（含 auto）**——结构性问题不带病开写（mirror 3.5「BLOCK
   * 永不采信」哲学），挂起 ≠ 错误（errors 不计，恢复 = redo 重跑该章，design §1.7）。非挂起 pause /
   * 非 paused 缺省。additive optional（零 migration）。镜像 shared ipc.ts RunChapterChainSummary
   * .researchSuspension（两处平行 type 同步，B01 纪律——research-brief.ts researchSuspensionSchema 单源）。
   */
  researchSuspension?: ResearchSuspension;
  /**
   * Story 8.4 B1（design §2.1）：热层编译报告透出（源 `artifacts['compile_report']`，brief-compiler-node
   * 汇总点产；mirror 章摘要 tokenEstimate 先例——观测 deliverable 非 internal trace）。segments 各段
   * token 估算 + total（装配点两编译点之和）+ degraded（降级动作记录，缺失 = 未降级 L0）+ overloaded
   * （L3 复杂场景标记——write_chapter 据此落 leader 一行「建议拆章」人审文案）。artifact 缺（旧链 /
   * bypass 路径）缺省。additive optional（零 migration）。镜像 shared ipc.ts RunChapterChainSummary
   * .compileReport（两处平行 type 同步，B01 纪律——research-brief.ts compileReportSchema 单源守形）。
   */
  compileReport?: CompileReport;
  errors: string[];
}
