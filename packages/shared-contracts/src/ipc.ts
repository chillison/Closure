import { z } from 'zod';
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  TextGenerationRequest,
  TextGenerationResponse,
} from './contracts/generation';
import type { ModelCapability, ModelConfig, ModelProtocol } from './contracts/model';
import type {
  DocParserProbeResult,
  ResearchConfigSave,
  ResearchConfigView,
  VisionCanaryResult,
} from './contracts/research';
import type { NovelStorySyncPayload } from './contracts/novel-orchestration';
import type { FieldPatchEntry } from './contracts/project-patch';
import type { CraftRebuildResult, RerankPayload, RerankResponse } from './contracts/closure-craft-retrieval';
import type { IndexStatus, StoryRebuildResult } from './contracts/closure-index';
import type { ChapterBrief } from './contracts/chapter-brief';
import type { ChapterAcceptArtifact, EscalateFinding } from './contracts/chapter-integration';
import type { ArcBeat } from './contracts/arc-registry';
import type { ArchiveIssue, CompileReport, ResearchSuspension } from './contracts/research-brief';
import type { StoryTimeDriftWarning } from './contracts/storytime-drift';
import type { RevisionIntent } from './contracts/revision-intent';
import type { RevisionGuardArtifact } from './contracts/revision-guard';
import type { BalancedAskCategory, ParticipationGear } from './contracts/batch-runs';
import type { AcceptSettingMdInput, AcceptSettingMdResult } from './contracts/setting-md-edit';
import type { ApplyAuthorProfileNoteInput, ApplyAuthorProfileNoteResult } from './contracts/author-profile';
import type { LintClassifyResult, LintFixPatch, LintFullReport } from './contracts/lint';
import type {
  WorldChangedEvent,
  WorldOverview,
  WorldOverviewRequest,
  WorldSliceDetail,
  WorldSliceDetailRequest,
  WorldSubjectDetail,
  WorldSubjectDetailRequest,
} from './contracts/world-panel';

export const desktopIpcSchema = z.object({
  channel: z.enum([
    'project:pick-directory',
    'project:create-directory',
    'project:pick-cover-image',
    'project:copy-cover-image',
    'project:import-docx',
    'project:docx-to-html',
    'project:docx-to-markdown',
    'project:save-meta',
    'project:ensure-document',
    'project:sync-meta',
    'project:sync-chapters-meta',
    'project:load-meta',
    'project:load-document',
    'project:read-directory',
    'project:delete-entry',
    'project:rename-entry',
    'project:create-entry',
    'project:read-file',
    'project:read-file-binary',
    'project:write-file',
    'project:word-count',
    'project:path-exists',
    'project:save-base64-image',
    'project:move-file',
    'project:delete-file',
    'project:import-files',
    'project:search',
    'project:watch',
    'project:unwatch',
    'project:ensure-registration',
    'project:list-registered',
    'project:touch-registration',
    'config:load-model',
    'config:save-model',
    'config:load-user-preferences',
    'config:save-user-preferences',
    'config:list-imported-fonts',
    'config:import-fonts',
    'config:import-wallpaper',
    'config:clear-wallpaper',
    'research:load-config',
    'research:save-config',
    'research:probe-doc-parser',
    'research:canary-vision',
    'model:list-remote-models',
    'model:generate-text',
    'model:generate-image',
    'model:generate-embedding',
    'model:rerank',
    'closure:rebuild-craft-kb',
    'closure:index-status',
    'closure:rebuild-story-index',
    'closure:accept-setting-md',
    'lint:scan-full',
    'lint:classify',
    'lint:apply-fix',
    'lint:model-probe',
    'author-profile:apply',
    'storySync:run',
    'field:sync',
    'field:apply-agent-patch',
    'field:toggle-lock',
    'git:is-repo',
    'git:init',
    'git:log',
    'git:commit-diff',
    'git:file-at-commit',
    'git:create-node',
    'git:list-branches',
    'git:current-branch',
    'git:create-branch',
    'git:checkout-branch',
    'git:status-count',
    'task:list',
    'task:upsert',
    'task:update-status',
    'task:delete',
    'asset:list',
    'asset:upsert',
    'asset:update',
    'asset:delete',
    'asset:import-files',
    'world:overview',
    'world:slice-detail',
    'world:subject-detail',
    'agent:create-session',
    'agent:get-session',
    'agent:set-session-mode',
    'agent:set-session-behavior-mode',
    'agent:set-session-participation-gear',
    'agent:list-sessions',
    'agent:delete-session',
    'agent:stream-message',
    'agent:resolve-confirmation',
    'agent:list-skills',
    'agent:execute-skill',
    'agent:list-continuations',
    'agent:restore-continuation',
    'agent:abort-run',
    'agent:compact-session',
    'agent:list-skill-packages',
    'agent:set-package-enabled',
    'agent:set-skill-enabled',
    'log:open-dir',
    'log:write',
    'app:get-version',
    'update:check',
    'update:download',
    'update:install',
  ])
});

/* ── Skill Package types ── */

export type SkillPackageInfo = {
  name: string;
  path: string;
  enabled: boolean;
  skills: Array<{ name: string; description?: string; enabled: boolean }>;
};

/* ── Project registry (SQLite, ~/.orison) ── */

/**
 * A project registered in the local machine registry (`~/.orison/data/projects.db`).
 * This is the durable source of truth for "which projects exist on this machine",
 * surviving app version changes / reinstalls (unlike the localStorage recent list).
 */
export type RegisteredProject = {
  projectId: string;
  name: string;
  type: 'novel' | 'script';
  /** Absolute path to the project folder (also the registry's unique fingerprint). */
  path: string;
  coverImage?: string;
  /** ISO timestamp of the last time the project was opened. */
  lastOpenedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectLifecycleError =
  | 'invalid-name'
  | 'name-exists'
  | 'not-found'
  | 'protected-path'
  | 'operation-failed';

export type ProjectLifecycleResult =
  | { ok: true; project?: RegisteredProject }
  | { ok: false; error: ProjectLifecycleError };

/* ── Shared types ── */

export type { ModelCapability, ModelProtocol, DiscoveredModel, ApiKeyConfig, ApiKeyEntry, ModelConfig, ResolvedModel } from './contracts/model';

/**
 * Request to list models from a remote endpoint.
 */
export type ListRemoteModelsRequest = {
  keyId?: string;
  protocol?: ModelProtocol;
  apiKey?: string;
  baseUrl?: string;
};

/**
 * A model discovered from the remote /v1/models endpoint.
 */
export type RemoteModel = {
  id: string;
  capability: ModelCapability;
  alias: string;
};

/* ── Generation IPC payloads ── */

/**
 * Model reference used in generation requests.
 * Points to a specific key + model combination.
 */
export type ModelRef = {
  keyId: string;
  modelId: string;
};

export type GenerateTextPayload = {
  ref: ModelRef;
  request: TextGenerationRequest;
};

export type GenerateImagePayload = {
  ref: ModelRef;
  request: ImageGenerationRequest;
};

export type GenerateEmbeddingPayload = {
  ref: ModelRef;
  request: EmbeddingRequest;
};

/**
 * Story-sync IPC payload.
 */
export type RunStorySyncPayload = {
  ref: ModelRef;
  runId: string;
  chapterId: string;
  candidate: Record<string, unknown>;
  context: Record<string, unknown>;
  fieldVersions: Partial<Record<string, number>>;
};

export type RunStorySyncResult = {
  patches: NovelStorySyncPayload['patches'];
  summary: string;
  fallbackToRules: boolean;
};

// ── Story 4.0 写章战术链段：dogfood IPC `closure:run-chapter-chain`（design §4.8 / implement.md 6.2）──
//
// 无工作台 leader session 时（4.0 工作台 UX defer E3/4.1），dogfood + 测试经此 IPC 触发链段：
// handler loadProject → assembleChapterChainArtifacts → runtime.runChapterChain(stubParentSession, artifacts)。
// 结构镜像 leader `write_chapter` tool（agent）——两入口共用 assembleChapterChainArtifacts 纯函数。

/**
 * `closure:run-chapter-chain` 请求体。
 *
 * - projectPath：项目根绝对路径（loadProject 读 `<projectPath>/project.yaml`）。
 * - episodeId：本章目标 episode（refs episode_outlines[].id）。
 * - chapterBrief：leader 填的 LLM 段（#1-5,10）；缺 → 空 brief（brief-compiler 仅填 #6 from scene_graph）。
 * - sceneIds：可选场过滤（4.0 未用——brief-compiler 按 episodeId 匹配场；预留 4.1 细化）。
 * - chapterId：可选，用户工作台选章直传（4.1 Step 4；绕过 episode.index→sort_order 映射推断，优先）。
 */
export type RunChapterChainInput = {
  projectPath: string;
  episodeId: string;
  chapterBrief?: ChapterBrief;
  sceneIds?: string[];
  chapterId?: string;
};

/**
 * Story 4.3 Step 3：`closure:resume-chapter-chain` 请求体（design §3.5 / controller resume 设计）。
 *
 * resume/redo/abort 走结构化 IPC（mirror 4.6 PatchReview accept/reject 模式，非 leader LLM 解释）。
 * 镜像 `resumeChapterChainInputSchema`（chapter-chain-artifacts.ts，Zod 单源）。
 *
 * - projectPath：项目根绝对路径（assertSafePath 守卫 + 持久化目录）。
 * - sessionId：chainSnapshot 所在 parent 会话（leader session / dogfood stub parent）——runChapterChain
 *   读 runState.getChainSnapshot(sessionId) 续跑。
 * - chapterId：optional，UI 透传（持久化映射用，同 RunChapterChainInput.chapterId 语义）。
 * - action：continue（续跑）/ redo（重跑 draft-writer，带 feedback）/ abort（清 chainSnapshot 弃链段）。
 * - feedback：redo 时的改稿指令（进 draft-writer user prompt 的 {{revisionFeedback}}；其他 action 忽略）。
 * - revisionIntent：Story 7.1 Route 1——B trigger 选区指挥精修时，用户确认后的 RevisionIntent（进
 *   initialArtifacts['revision_intent']，draft-writer 段落级 directive + splice 消费；其他 action 忽略）。
 *   与 feedback 互斥语义：feedback 是 C trigger 整章自由文本（redo_feedback artifact），revisionIntent 是
 *   B trigger 结构化意图（revision_intent artifact）。两者可共存（feedback 作补充说明）但不强制。
 * - guardOverride：Story 7.2 art-mode——soft-violation pause 后作者「强行放行」（revision_guard_override
 *   artifact → revision-guard force-accept splice）。**仅 action=redo 时透传**（soft-violation pause 时 guard 已
 *   在 completedNodes，continue 会跳过 → splice 不发生；IPC redoOpts 据 guardOverride 切 redo.nodeId）。
 */
export type ResumeChapterChainInput = {
  projectPath: string;
  sessionId: string;
  chapterId?: string;
  action: 'continue' | 'redo' | 'abort';
  feedback?: string;
  /** Story 7.1 Route 1：B trigger 选区精修的 RevisionIntent（revision_intent artifact 注入）。 */
  revisionIntent?: RevisionIntent;
  /** Story 7.2 art-mode：soft-violation 强行放行（revision_guard_override artifact 注入）。 */
  guardOverride?: 'force-accept';
};

/**
 * Story 7.1 Route 1：`closure:compile-revision-intent` IPC 请求体（B trigger 选区指挥精修）。
 *
 * UI 在 draft checkpoint pause 后，用户在 TipTap 选段 + 写粗指令 → 调本 IPC 派 revision-optimizer 子 agent
 * 编译 RevisionIntent。selectedPassage + userInstruction 是核心入参；chapterContext（本章 brief）+ auditFindings
 * 是 optional 辅助（帮 optimizer 判锁定项背景）。
 *
 * 🔑 Story 7.1 BMad CR F2（范式订正）：scope.anchor 由 **IPC 层纯代码构造**（非 LLM 产）——
 * `selectionFrom/selectionTo`（TipTap ProseMirror 位置）+ `draftText`（整章正文）经 IPC 传入，
 * IPC 用确定性字符串切片构 SelectionAnchor（quote=selectedPassage / prefix=slice(from-N,from) /
 * suffix=slice(to,to+N) / rangeHint={from,to}）。anchor 是非语义机械活归纯代码（ADR-3 /
 * feedback-semantic-llm-nonsemantic-purecode）；LLM 只编译意图（change/locks/rationale），不产 anchor。
 */
export type CompileRevisionIntentInput = {
  projectPath: string;
  sessionId: string;
  /** 作者选中的正文段（改稿范围，渲染 revision-optimizer yaml {{selectedPassage}}，也作 anchor.quote）。 */
  selectedPassage: string;
  /** 作者粗指令原文（硬权威来源，渲染 {{userInstruction}}，也作 provenance.rawUserInstruction 的 ground truth）。 */
  userInstruction: string;
  /** 本章创作意图（brief LLM 段 JSON 串，渲染 {{chapterContext}}，帮 optimizer 判锁定项背景）。optional。 */
  chapterContext?: string;
  /** Reader-Audit 审核发现 JSON 串（渲染 {{auditFindings}}；B trigger 通常空，A trigger 归 7.4）。optional。 */
  auditFindings?: string;
  /** 🔑 F2：选区起始 ProseMirror 位置（IPC 构 anchor.rangeHint.from + 切 prefix）。required（B trigger 必带选区）。 */
  selectionFrom: number;
  /** 🔑 F2：选区结束 ProseMirror 位置（IPC 构 anchor.rangeHint.to + 切 suffix）。required。 */
  selectionTo: number;
  /** 🔑 F2：整章 draft 正文（IPC 构 anchor.prefix/suffix 切片源；splice 目标文本）。required。 */
  draftText: string;
  /** 选区锚点上下文窗口（prefix/suffix 切多少字符，default 50）。optional。 */
  anchorContextChars?: number;
};

/**
 * Story 7.1 Route 1：`closure:compile-revision-intent` IPC 响应。
 *
 * - `intent`：编译出的 RevisionIntent（用户确认关用）；null = 编译失败 graceful（optimizer 不可用 / parse 失败）。
 * - `error?`：失败原因（UI 据此告知「意图编译失败，请重述或手改」）。
 */
export type CompileRevisionIntentResult = {
  intent: RevisionIntent | null;
  error?: string;
};

/**
 * `closure:run-chapter-chain` 响应 = RunSnapshot 摘要（context isolation，design §4.3 / ADR-17）。
 *
 * 镜像 agent `RunSnapshotSummary`（contracts/run.ts）shape——链段只回摘要给调用方，不灌内部 trace /
 * 全量 artifacts。agent RunSnapshotSummary 结构上满足本类型（TS 结构兼容）。
 *
 * CR-15a 落地公理：`draftText`（初稿/修订稿正文）是 deliverable 非 internal trace——读者/dogfood 须能
 * 检视产出正文（[[project-prose-landing-axiom]]），prose 豁免 context isolation。
 *
 * CR-15b（4.1 Step 4）：`chapter_accept` = accept 持久化载荷（chapterId + candidate + storyDecisions），
 * 亦为 deliverable 非 internal trace——入口层（IPC 直接写盘 / leader 转 field_patch 走 patch review）
 * 据此持久化 chapters/*.md + project.yaml + story_decisions。同 draftText 豁免 context isolation。
 */
export type RunChapterChainSummary = {
  status: string;
  routeDecision?: {
    decision: string;
    reason: string;
    /**
     * dogfood R2 #107 / R1.1c：route 判正文偏离计划（deviation=true）时投影——#107 no-chapter
     * 自动建章的入口层补产 storyDecisions 数据源（buildAcceptStoryDecisions 单源消费）。
     * 只在 true 时出现（false/缺省省略——route 非 accept 终态本就无此语义）。additive optional
     * （零 migration）。镜像 agent RunSnapshotSummary.routeDecision.deviation（两处平行 type 同步）。
     */
    deviation?: true;
  };
  reviewVerdict?: string;
  draftTitle?: string;
  draftWordCount?: number;
  /** 初稿/修订稿正文（CR-15a：prose 是 deliverable，豁免 context isolation）。 */
  draftText?: string;
  /**
   * accept 持久化载荷（CR-15b：route=accept_as_truth 时，链段 onAccept 产；deliverable，豁免 context isolation）。
   * 入口层据此持久化：IPC 调 acceptChapterCandidate 写盘 / leader 转 field_patch metadata 走 patch review。
   * route 非 accept / chapterId 映射失败 → 缺省（持久化阻断，调用方报明确错误）。
   */
  chapter_accept?: ChapterAcceptArtifact;
  /**
   * route=escalate_user 时附带：Reader-Audit 灰区 findings grounding（quote/location/severity），
   * 供裁决器子 agent 初审 + 用户裁决（Story 4.6）。非 escalate 缺省。
   */
  escalateFindings?: EscalateFinding[];
  /**
   * Story 4.3：status='paused' 时链段暂停的 checkpoint 阶段（brief/draft/verdict）。供 leader / UI 决定 review
   * 形态（draft→prose-review 面板 / brief→对话软门 / verdict→PatchReview）。非 paused 缺省。
   * additive optional（零 migration）。镜像 agent RunSnapshotSummary.pausedStage。
   *
   * Story 7.2：加 'revision-guard'（段落级改稿保义门 soft-violation pause → art-mode 卡）。UI 据 pausedStage
   * = 'revision-guard' 展 guard 确认卡（findings + before/after + 强行放行/改/取消）。
   */
  pausedStage?: 'brief' | 'draft' | 'verdict' | 'revision-guard';
  /**
   * Story 4.3：draft checkpoint pause 时的正文（review payload，豁免 context isolation 同 CR-15a prose 是 deliverable）。
   * 源 `artifacts['draft.initial'].text`。非 paused 缺省。镜像 agent RunSnapshotSummary.draftContent。
   */
  draftContent?: string;
  /**
   * Story 4.3：brief checkpoint pause 时的 chapter_brief artifact（review payload，豁免 context isolation）。
   * 非 paused 缺省。镜像 agent RunSnapshotSummary.briefContent。
   */
  briefContent?: unknown;
  /**
   * Story 7.2：pausedStage='revision-guard' 时的保义门载荷（soft-violation findings + 改前/改后 + L1 幅度）。
   * 供 UI art-mode 确认卡展示（作者据此决定强行放行/改/取消）。deliverable 非 internal trace（同
   * draftContent/escalateFindings 豁免 context isolation）。非 revision-guard pause 缺省。
   * 镜像 agent RunSnapshotSummary.revisionGuard。
   */
  revisionGuard?: RevisionGuardArtifact;
  /**
   * Story 2.2 WP-E（CR-08-16-201）：resume 终态透传 story-sync 提取载荷（mirror agent
   * RunSnapshotSummary.storySync 的 deliverable 豁免——suggest 档链段必在 draft checkpoint
   * pause，终态提取只能经 resume IPC 回到 UI/落盘点，write_chapter 的 applier 走不到）。
   * 由 resume IPC handler 消费（转 story_sync_apply），非 paused/completed 直跑路径缺省。
   */
  storySync?: NovelStorySyncPayload;
  /**
   * Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺的**人审档**产出——shell 消费 storySync 后
   * 把投影 envelope 组（FULL data + fieldVersion=diskVersion+1，mirror write_chapter suggest 档
   * metadata.storySyncPatches 形态）挂在这里返给 UI；chapterReviewSlice.runResume 路由进
   * PatchReview（setPendingPatch merge）。auto 档直落时不设（走 storySyncLanded）。
   */
  storySyncReview?: { note: string; patches: FieldPatchEntry[] };
  /**
   * Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺的 **auto 直落档**产出（已落盘字段清单 +
   * 章节出处）——UI toast 告知（非静默）。suggest 档不设（走 storySyncReview）。
   */
  storySyncLanded?: { note: string; fields: string[] };
  /**
   * dogfood R2 #93（P0-2）：resume 终态 chapter_accept 的落盘去向标记。true = shell 侧已直落
   * chapters/（auto 档 dogfood stub 会话语义 / auto-trust 采信 accept）；缺省 = 未落盘——envelope
   * 仍在 `chapter_accept` 字段，待 UI 路由进 pendingPatch 人审（suggest/readonly leader 会话，
   * mirror write_chapter metadata field_patch 路径——resume 车道跑在 leader 工具调用生命周期外，
   * envelope 只能经 resume summary 返 UI）。UI（chapterReviewSlice.runResume）据此分流：未落盘 →
   * stage 审核卡；已落盘 → toast 告知（非静默）。
   */
  chapterPersisted?: true;
  /**
   * Story 8.2：本章写时声明的弧节拍（arc-emergence-node 产经 arcRegistry 透传；无则空数组）。
   * 供入口层关口判定（卷弧 close beat → arc-audit-agent 大审）+ 停滞检测。镜像 agent
   * RunSnapshotSummary.arcEmergenceBeats（两处平行 type 同步，B01 纪律——arc-registry.ts
   * ArcBeat 单源）。
   */
  arcEmergenceBeats?: ArcBeat[];
  /**
   * Story 8.4 Step 3（A7 档案议题通道）：出发核查（资料员）verdict 的 archive_issues 透传（设定卡
   * 疑似过时/与正文矛盾）。deliverable 非 internal trace（同 escalateFindings 豁免）——leader/用户
   * 须看见处理（资料员只报告不改档案）。空/缺不抽（零痕迹）。additive optional（零 migration）。
   * 镜像 agent RunSnapshotSummary.archiveIssues（两处平行 type 同步，B01 纪律——research-brief.ts
   * archiveIssueSchema 单源）。
   */
  archiveIssues?: ArchiveIssue[];
  /**
   * Story 8.4 C2（design §3.3）：提取器 storyTime 漂移 warning 透传（本章提取的世界状态事件时间落在
   * 本章场景 storyTime 窗外——提取误差 / scene_graph 过时 / 跨章误归属，机械层不区分）。零阻断零噪音
   * （warning 不停链；对齐/无数据章缺省不抽）。additive optional（零 migration）。镜像 agent
   * RunSnapshotSummary.driftWarnings（两处平行 type 同步，B01 纪律——storytime-drift.ts 单源）。
   */
  driftWarnings?: StoryTimeDriftWarning[];
  /**
   * Story 8.4 Step 4（A8）：draft pause 因出发核查挂起（矛盾/超限）时的挂起载荷（用户决断所需证据，
   * deliverable 豁免 context isolation——mirror escalateFindings）。全档位暂停（含 auto），恢复 = redo
   * 重跑该章。非挂起 pause / 非 paused 缺省。镜像 agent RunSnapshotSummary.researchSuspension
   * （两处平行 type 同步，B01 纪律——research-brief.ts researchSuspensionSchema 单源）。
   */
  researchSuspension?: ResearchSuspension;
  /**
   * Story 8.4 B1（design §2.1）：热层编译报告透出（源 artifacts['compile_report']，brief-compiler-node
   * 汇总点产；mirror 章摘要 tokenEstimate 先例）。segments 各段 token 估算 + total（两编译点之和）+
   * degraded（降级动作记录，缺失 = 未降级 L0）+ overloaded（L3 复杂场景标记——建议拆章人审）。artifact
   * 缺（旧链 / bypass 路径）缺省。additive optional（零 migration）。镜像 agent RunSnapshotSummary
   * .compileReport（两处平行 type 同步，B01 纪律——research-brief.ts compileReportSchema 单源守形）。
   */
  compileReport?: CompileReport;
  errors: string[];
};

export type UserPreferencesConfig = {
  theme: string;
  locale: string;
  /** Whether to silently check for updates on startup. Defaults to true. */
  autoCheckUpdates?: boolean;
  /** @deprecated Custom manifest URL — superseded by the electron-updater GitHub feed. Read for back-compat only. */
  updateManifestUrl?: string;
  /** Reading font family for editor + agent panel body text. CSS font-family value or font stack name. */
  readingFontFamily?: string;
  /** Reading font weight for editor + agent panel body text (e.g. 400 / 500 / 600). */
  readingFontWeight?: number;
  /** Reading font scale multiplier for editor + agent panel body text (1 = default). */
  readingFontScale?: number;

  // ── Writing settings ──
  paragraphIndent?: boolean;
  showWordCount?: boolean;
  /** Whether auto-save is enabled. When false, only manual Ctrl+S saves. Defaults to true. */
  autoSaveEnabled?: boolean;
  /** Auto-save debounce interval in milliseconds. Defaults to 1500. */
  autoSaveInterval?: number;
  /** Whether the manuscript/code editors enable native browser spellcheck. Defaults to false. */
  spellCheck?: boolean;
  /** Target character count for the active document. 0 = no goal. Defaults to 0. */
  wordCountGoal?: number;

  // ── Appearance settings ──
  editorLineHeight?: number;

  // ── App wallpaper（08-25 全窗口背景，壁纸式不分区）──
  /**
   * Full-window wallpaper image URL (`orison-file:///` + absolute path of a
   * copy under `userData/wallpaper/` — the copy decouples the background from
   * the source file). Empty/undefined = no wallpaper.
   */
  wallpaperUrl?: string;
  /** Wallpaper image opacity 0.1–1.0 (default 1). 10% floor keeps it visible. */
  wallpaperOpacity?: number;
  /**
   * Frosted-glass blur radius for the wallpaper layer, in px (0–50 integer,
   * default 0 = off). Blurs the image itself so busy backgrounds stop fighting
   * foreground text. Purely cosmetic — no effect when no wallpaper is set.
   * Legacy boolean `wallpaperFrost` (08-26 fixed-20px toggle) normalizes on the
   * shell read path — true → 20, false/missing/garbage → 0 — and the write path
   * only ever persists this numeric key (zero migration for old disk files).
   */
  wallpaperFrostBlur?: number;

  // ── Context compaction (conversation window) ──
  /**
   * Conversation context-compaction controls. `redlinePercent` is the
   * context-window usage percentage (50–100, default 95) at which automatic
   * compaction triggers — below the redline nothing is compacted (thinking
   * history etc. is preserved verbatim). 95 ≈ "compact only when the window is
   * nearly full", leaving headroom for the reply. Persisted flat as
   * `contextCompaction.redlinePercent`; the shell read path clamps to 50–100
   * and falls back to the default on illegal/missing values.
   */
  contextCompaction?: { redlinePercent: number };

  // ── Global interface scale（08-26 structure-rebuild R8）──
  /**
   * Whole-app UI zoom level. Must be a finite number within the legal band;
   * anything else (hand-edited YAML / corrupt value / missing key on legacy
   * files) clamps back or falls back to 1 at every consumption point — see
   * clampInterfaceScale. NOTE: this preference is persisted and displayed by
   * the renderer, but APPLIED by the shell (webContents.setZoomFactor), not as
   * CSS zoom / root font-size — mechanism trade-offs are documented at the
   * helper below.
   */
  interfaceScale?: number;
};

/** Preset levels offered in Settings ▸ 外观; rendered as 85% / 100% / 115% / 130%. */
export const INTERFACE_SCALE_PRESETS = [0.85, 1, 1.15, 1.3] as const;
/** Legal hand-edit band; out-of-band values clamp back (shell read/write + renderer defensive). */
export const INTERFACE_SCALE_MIN = INTERFACE_SCALE_PRESETS[0];
export const INTERFACE_SCALE_MAX = INTERFACE_SCALE_PRESETS[INTERFACE_SCALE_PRESETS.length - 1];

/**
 * R8 default zoom (single source). The `UserPreferencesConfig.interfaceScale` schema
 * key stays optional (legacy files without it are the normal case), so consumers
 * reference THIS constant instead of re-deriving from
 * `DEFAULT_USER_PREFERENCES.interfaceScale` — that shape forces either a `!`
 * assertion or a scattered `?? 1` at every consumption point; both vanish when
 * the default lives here (BMad CR 组4：interfaceScale 契约单一化).
 */
export const INTERFACE_SCALE_DEFAULT: number = INTERFACE_SCALE_PRESETS[1];

/** Single source of truth for user-preference defaults, shared by main + renderer. */
export const DEFAULT_USER_PREFERENCES: UserPreferencesConfig = {
  theme: 'system',
  locale: 'system',
  autoCheckUpdates: true,
  readingFontWeight: 400,
  readingFontScale: 1,
  paragraphIndent: true,
  showWordCount: true,
  autoSaveEnabled: true,
  autoSaveInterval: 1500,
  spellCheck: false,
  wordCountGoal: 0,
  editorLineHeight: 1.75,
  wallpaperOpacity: 1,
  wallpaperFrostBlur: 0,
  contextCompaction: { redlinePercent: 95 },
  interfaceScale: INTERFACE_SCALE_DEFAULT,
};

/* ── Global interface scale（08-26 structure-rebuild R8）──
 *
 * 需求：偏好键 interfaceScale，四档预设 [0.85, 1.0, 1.15, 1.3]，默认 1.0；启动即生效
 * + 设置内改动即时生效，无需重启；解析失败回退默认 1.0，不得白屏。
 *
 * 施加方式选型（考察结论钉在此处——单源决策点）：
 * ① CSS `zoom` 施加于应用根元素 —— 否决。本仓有十余个 clientX/Y / getBoundingClientRect
 *    驱动的定位面（AgentInput 右键菜单、TiptapEditor、FileTabBar、ProjectTree、
 *    ResizeHandle 拖宽、结构页 SceneEditPopover / TimelineContextMenu 等）。CSS zoom
 *    生效时事件坐标仍是视口系，而这些面的 inline left/top px 会被有效 zoom 放大——
 *    指针锚定与拖拽数学全体漂移；结构页面正处于并行重构禁区（不可越界修复）。
 * ② 根 font-size 缩放 —— 否决。只覆盖 rem 消费面（scales.css 的间距/圆角/字号 token
 *    是 rem），而结构页 SVG 几何常量等 px 字面量不随动：非「整体」缩放，1.15+ 即出
 *    「文字涨框格不涨」的错位，恰好砸在本次重构的页面上。
 * ✔ 采用 Electron webContents.setZoomFactor（Chromium 原生页面级缩放，与浏览器
 *   Ctrl+滚轮同语义）：视口本身重标定，事件坐标 / fixed 浮层 / rect 实测三方保持自洽，
 *   全仓零逐组件适配点，渲染层不做任何 DOM 施加（白屏无从谈起）。施加点两处：
 *   createWindow 启动读盘一次 + config:save-user-preferences 落盘后对发起方 sender
 *   即时施加。
 */
/**
 * Clamp an arbitrary (possibly corrupt) interfaceScale value into the legal
 * band. NaN / non-number / missing → default 1; out-of-band numbers clamp to
 * the nearest preset bound — same lenient-read story as redlinePercent and
 * wallpaperOpacity. Used by the shell YAML read path, the shell write path
 * (clamp-before-persist keeps the disk file always legal), AND defensively by
 * the renderer store so a malformed disk value can never reach setZoomFactor.
 */
export function clampInterfaceScale(value: unknown): number {
  if (!Number.isFinite(value as number)) return INTERFACE_SCALE_DEFAULT;
  return Math.min(INTERFACE_SCALE_MAX, Math.max(INTERFACE_SCALE_MIN, value as number));
}

/** A font file the user imported into the app's font folder. */
export type ImportedFont = {
  /** CSS font-family name (derived from the file stem). */
  family: string;
  /** `data:` URL of the font file, ready to feed an @font-face src. */
  dataUrl: string;
};

/* ── Update check IPC ── */

/** @deprecated Legacy custom-manifest shape — kept for type back-compat, no longer fetched. */
export type UpdateManifest = {
  /** Latest available version (semver-like, e.g. "0.2.0"). */
  latestVersion: string;
  /** External URL the user follows to download the new build. */
  downloadUrl: string;
  /** Optional human-readable changelog. */
  releaseNotes?: string;
};

export type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string; latestVersion: string }
  | {
      status: 'available';
      currentVersion: string;
      latestVersion: string;
      /** True when the major version increased (current -> latest). Drives the prominent guided banner. */
      isMajor: boolean;
      releaseNotes?: string;
      /** Fallback download page, used by portable builds that cannot self-update. */
      downloadUrl?: string;
      /** True for portable/dir builds: no in-app download; user opens downloadUrl manually. */
      manual?: boolean;
    }
  | { status: 'not-configured' }
  /** Running unpackaged (dev) — electron-updater is unavailable. */
  | { status: 'dev'; currentVersion: string }
  | { status: 'error'; message: string };

/** Progressive update lifecycle events pushed from main -> renderer over `update:event`. */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; currentVersion: string; latestVersion: string; isMajor: boolean; releaseNotes?: string; manual?: boolean; downloadUrl?: string }
  | { type: 'not-available'; currentVersion: string }
  | { type: 'download-progress'; percent: number }
  | { type: 'downloaded'; latestVersion: string }
  | { type: 'error'; message: string };

/* ── Git IPC types ── */

export type GitCommitEntry = {
  oid: string;
  parents: string[];
  message: string;
  author: string;
  timestamp: number;
  tag?: string;
};

export type GitFileDiff = {
  filepath: string;
  status: 'added' | 'modified' | 'deleted';
};

/** A single regex search hit within a project file. */
export type ProjectSearchResult = {
  /** Path relative to the project directory. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** Trimmed matching line text. */
  text: string;
};

/**
 * Canonical type for the preload API surface exposed via contextBridge.
 */
export type ProjectMutationResult = { ok: true } | { ok: false; error: string };

/**
 * Story 3.1: leader runLoop behavior mode — orthogonal to SessionPermissionMode
 * (which gates tool permission). normal = execute directly; discuss = converse
 * without writing; plan = restate a plan first, then execute on confirmation.
 * See design.md WP1.
 */
export type AgentBehaviorMode = 'normal' | 'discuss' | 'plan';

/**
 * Story 3.5: 参与档位别名（zod 单源在 contracts/batch-runs.ts participationGearSchema；
 * 此处 alias 保 ipc.ts 既有命名惯例——mirror AgentBehaviorMode 但不重复定义枚举值，
 * interface-contracts「No different-name-same-semantics」以 re-export 满足）。
 */
export type { ParticipationGear, BalancedAskCategory } from './contracts/batch-runs';

/* ── C1.2 lint（llmlint 静态扫描）IPC payload types ── */

/** scan-full 附带的章定位面（issue 跳转 / fix 确认文案用；报告本体 LintFullReport 只含 chapterId）。 */
export type LintChapterFile = {
  chapterId: string;
  title: string;
  /** 章正文绝对路径（project.yaml novel.chapters[].sections[0].content_file 解析产物）。 */
  filePath: string;
};

/**
 * scan-full 跳章/未覆盖条目（CR-011，additive optional——handler 恒填，旧构造者可缺省）。
 * reason 稳定码：'no-content-file'（无 id/无 sections[0].content_file）/ 'escapes-project-dir'
 * （路径穿越防御）/ 'not-landed'（正文文件不存在）/ 'unreadable'（读失败/编码不可解）/
 * 'scan-failed'（引擎对该章抛错）/ 'multi-section'（多 section 章只扫 sections[0]——跟随
 * batch 先例，多余 section 的正文未扫，note 计数）。UI（C1.3/batch B）按 reason 呈现。
 */
export type LintSkippedChapter = {
  chapterId: string;
  reason: string;
  note?: string;
};

/** `lint:scan-full` 结果（模式 A：失败带稳定 error code，不抛）。 */
export type LintScanFullResult =
  | {
      ok: true;
      report: LintFullReport;
      chapterFiles: LintChapterFile[];
      /** 引擎 dry-run 投影的机械修复补丁（fixability:auto；作者确认后经 lint:apply-fix 应用）。 */
      fixPatches: LintFixPatch[];
      /** 未入扫描的章及原因（CR-011：跳章不再静默；handler 恒填，消费侧 ?? [] 防御旧载荷）。 */
      skipped?: LintSkippedChapter[];
    }
  | {
      ok: false;
      error: 'no-project' | 'project-not-found' | 'engine-unavailable' | 'operation-failed';
      message?: string;
    };

/** apply-fix 单章应用结果（引擎按当前正文重放确定性修复——changes=0 表示已无可修项未写盘）。 */
export type LintApplyFixChapterResult = {
  chapterId: string;
  filePath: string;
  changes: number;
  written: boolean;
  note?: string;
};

/** `lint:apply-fix` 结果（模式 A）。 */
export type LintApplyFixResult =
  | { ok: true; results: LintApplyFixChapterResult[] }
  | {
      ok: false;
      error: 'no-project' | 'project-not-found' | 'engine-unavailable' | 'invalid-patches' | 'operation-failed';
      message?: string;
    };

/**
 * `lint:model-probe` 结果（CR-014，additive）：review-judge 档解析 + resolveModel
 * 是否成功（shell 单源——与 lint:classify 同一解析链；纯配置解析，不发网络请求）。
 * renderer 端不再自启发式探测（旧「任一启用模型」与 shell 端 default 哨兵语义会漂移）。
 */
export type LintModelProbeResult = { available: boolean };

export type OrisonDesktopApi = {
  pickProjectDirectory(): Promise<string | null>;
  createProjectDirectory(parentDir: string, name: string): Promise<string>;
  pickCoverImage(): Promise<string | null>;
  copyCoverImage(src: string, projectDir: string): Promise<string>;
  importDocx(projectDir: string): Promise<string | null>;
  docxToHtml(fullPath: string): Promise<string | null>;
  docxToMarkdown(fullPath: string, projectDir: string): Promise<string | null>;
  saveProjectMeta(projectDir: string, meta: Record<string, unknown>): Promise<ProjectMutationResult>;
  /** Idempotently ensure `<projectDir>/project.yaml` exists (create-if-absent, no version bump). */
  ensureProjectDocument(projectDir: string, meta: Record<string, unknown>): Promise<ProjectMutationResult>;
  syncProjectMeta(projectDir: string, meta: Record<string, unknown>): Promise<ProjectMutationResult>;
  syncChaptersMeta(projectDir: string, chapters: Array<{
    id: string;
    title: string;
    sort_order: number;
    status: string;
    summary?: string;
    summary_source?: string;
    sections?: Array<{
      id: string;
      title?: string;
      sort_order: number;
      content_file: string;
      word_count?: number;
    }>;
  }>): Promise<ProjectMutationResult>;
  loadProjectMeta(projectDir: string): Promise<Record<string, unknown> | null>;
  getLocale(): string;
  minimize(): void;
  maximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  platform: string;
  syncField(projectPath: string, field: string, data: unknown): Promise<void>;
  applyAgentFieldPatch(projectPath: string, fieldPatch: unknown): Promise<unknown>;
  /**
   * Story 3.1: toggle a creative field's `locked` flag without bumping its
   * version or marking downstream stale (distinct from syncField's user-edit
   * path, which bumps version + marks dependents stale). Locked fields reject
   * user edits (throw) and skip agent patches (surfaced via skipped[]).
   */
  toggleFieldLock(projectPath: string, field: string): Promise<void>;
  loadProjectDocument(projectDir: string): Promise<Record<string, unknown> | null>;
  loadModelConfig(): Promise<ModelConfig>;
  saveModelConfig(config: ModelConfig): Promise<void>;
  /** Whether OS keyring encryption is available for API keys (false → plaintext on disk). */
  isKeyEncryptionAvailable(): Promise<boolean>;
  /**
   * Story 3.6 WP10: read the「研究与视觉」settings aggregate — research net proxy
   * tier + search-engine chain config (API keys REDACTED to '' + `*Set` flags) +
   * doc-parser endpoint config + read-only wiki presets. Never throws for a
   * corrupt sidecar (each side degrades to its default).
   */
  loadResearchConfig(): Promise<ResearchConfigView>;
  /**
   * Story 3.6 WP10: persist the research settings aggregate (all three sidecars).
   * Search-engine API keys use the writeModelConfig sentinel: '' / undefined =
   * keep the persisted key. Schema violations (e.g. `custom` proxy without a
   * proxyUrl, docParser type without baseUrl) reject with the Zod message.
   */
  saveResearchConfig(config: ResearchConfigSave): Promise<void>;
  /**
   * Story 3.6 WP10: probe the configured doc-parser endpoint (`GET {base}/health`,
   * force refresh — bypasses the per-process cache so the settings-page lamp
   * reflects the just-saved config).
   */
  probeResearchDocParser(): Promise<DocParserProbeResult>;
  /**
   * Story 3.6 WP10: run the vision-model canary probe (known-answer image →
   * silent-strip detection, design D4) against the given `{keyId, modelId}` ref.
   */
  canaryProbeVision(ref: ModelRef): Promise<VisionCanaryResult>;
  listRemoteModels(request: ListRemoteModelsRequest): Promise<RemoteModel[]>;
  generateText(payload: GenerateTextPayload): Promise<TextGenerationResponse>;
  generateImage(payload: GenerateImagePayload): Promise<ImageGenerationResponse>;
  generateEmbedding(payload: GenerateEmbeddingPayload): Promise<EmbeddingResponse>;
  rerank(payload: RerankPayload): Promise<RerankResponse>;
  /**
   * Trigger a full rebuild of the global craft KB index (~/.orison/craft-kb/ +
   * bundled seeds): DROP+reCREATE the vec0 table on a dim change + re-embed every
   * craft doc. Returns a typed result; `ok:false` carries a stable error code for
   * the renderer (Story 2.1 CR-craft-kb-011).
   */
  rebuildCraftKb(): Promise<CraftRebuildResult>;
  /**
   * Story 2.7: fetch derived-index status for the KB index management page —
   * craft (global) counts + the current project's story counts (project_assets
   * + asset_cards), with pending_embed + model provenance. `projectId` omitted
   * when no project is open (story counts return zero / null).
   */
  getIndexStatus(input: { projectId?: string }): Promise<IndexStatus>;
  /**
   * Story 2.7: rebuild the current project's story derived index (project_assets
   * via `reindexAll` + asset_cards via `reindexAssetCards`) under the resolved
   * embedding model — the manual escape hatch complementary to the watcher.
   * Returns a typed result; `ok:false` carries a stable error code (模式 A).
   */
  rebuildStoryIndex(input: { projectId: string }): Promise<StoryRebuildResult>;
  /**
   * Story 4.0: trigger the chapter-chain subgraph for a given episode (dogfood +
   * test entry; leader `write_chapter` tool is the agent-side mirror). Loads the
   * project, assembles initialArtifacts (scene_graph + 2.3 setting prefix +
   * ChapterBrief + promise_registry), dispatches a chapter-chain child session,
   * and returns a RunSnapshot summary (context isolation — no internal trace).
   */
  runChapterChain(input: RunChapterChainInput): Promise<RunChapterChainSummary>;
  /**
   * Story 4.3: resume / redo / abort a paused chapter chain (structured IPC mirror of
   * the leader write_chapter paused-review flow — UI calls this directly rather than
   * having the leader re-interpret a user message). Reads the chainSnapshot persisted
   * under `sessionId` (set by runChapterChain's onCheckpoint), then either continues
   * (skip completed nodes), redoes draft-writer with feedback, or aborts (clears the
   * snapshot). Returns the same RunChapterChainSummary shape as runChapterChain.
   */
  resumeChapterChain(input: ResumeChapterChainInput): Promise<RunChapterChainSummary>;
  /**
   * Story 7.1 Route 1：B trigger 选区指挥精修——编译改稿意图。UI 在 draft checkpoint pause 后，
   * 用户选段 + 写粗指令 → 调本 IPC → 派 revision-optimizer 子 agent → 返 RevisionIntent（用户确认关用）
   * OR null（编译失败 graceful）。确认后 UI 再调 resumeChapterChain(action=redo, revisionIntent=确认后的 intent)。
   */
  compileRevisionIntent(input: CompileRevisionIntentInput): Promise<CompileRevisionIntentResult>;
  /**
   * Story 2.2 WP-B: persist an accepted setting-md patch. The UI diff card
   * calls this on accept — the shell RE-APPLIES the bounded actions against
   * the CURRENT `settings/<settingId>.md` (never writes the stale proposed
   * `after`), so intermediate user edits are never clobbered; a drifted
   * anchor returns `{ok:false}` (the card toasts「文档已变化，请重新提议」).
   * Also the persist core behind the `setting_md_update` tool's autoApply path.
   */
  acceptSettingMdPatch(input: AcceptSettingMdInput): Promise<AcceptSettingMdResult>;
  /**
   * Story 8.6 R4: append an accepted author-profile note (UI diff-card accept
   * path). The shell appends the note as a NEW dated entry to
   * `~/.orison/author_profile.md` against the CURRENT file — never writes the
   * stale proposed `after` snapshot, so author edits between proposal and
   * accept are always preserved (append-only semantics).
   */
  applyAuthorProfileNote(input: ApplyAuthorProfileNoteInput): Promise<ApplyAuthorProfileNoteResult>;
  /**
   * C1.2: run a full-manuscript static lint scan (vendored llmlint engine) —
   * enumerate chapter prose from project.yaml (traversal-guarded, unlanded
   * chapters skipped), scan each chapter (review=all bucket), aggregate a
   * LintFullReport, persist `.orison/lint/full-report.json`, and return the
   * report + chapter locator map + dry-run auto-fix patches. 模式 A — never
   * throws; failure carries a stable error code.
   */
  lintScanFull(input: { projectPath: string }): Promise<LintScanFullResult>;
  /**
   * C1.2: LLM contextual classification of the last scan's review=agent bucket
   * hits (shell direct model-gateway call — review-judge task slot with the
   * default-sentinel auto-pick fallback, single structured judgment + one
   * JSON-parse retry). No model configured / call or parse failure / no report
   * on disk → `{degraded:true, verdicts:[]}` — the static report stays
   * independently complete (R3 graceful degradation).
   */
  lintClassify(input: { projectPath: string }): Promise<LintClassifyResult>;
  /**
   * C1.2: apply the author-confirmed mechanical fix patches. Re-derives the
   * deterministic fixes from the CURRENT chapter prose (idempotent replay —
   * patch spans are scan-time artifacts, never trusted as write coordinates;
   * authoritative file paths come from project.yaml, not the renderer payload),
   * writes inside withProjectLock, then rescans the touched chapters to refresh
   * `.orison/lint/<chapterId>.json` ledgers + the full-report entries.
   */
  lintApplyFix(input: { projectPath: string; patches: LintFixPatch[] }): Promise<LintApplyFixResult>;
  /**
   * C1.2 CR-014: probe whether the lint contextual-judgment model is resolvable
   * (review-judge task slot with the default-sentinel auto-pick fallback — the
   * SAME resolution chain lint:classify uses, resolved in the shell as the
   * single source of truth). Pure config resolution, no network request.
   */
  lintModelProbe(): Promise<LintModelProbeResult>;
  /**
   * dogfood R2 #92：世界状态面板读面——L1 世界总览（design v2 三级缩放）。主体轻量投影（每主体
   * 一行最后变化）+ storyTime 场锚点聚合行；写章链世界提取运行中附带 extracting 态。载荷契约
   * 单源 contracts/world-panel.ts。
   */
  worldOverview(input: WorldOverviewRequest): Promise<WorldOverview>;
  /**
   * L2 时点详情：该 storyTime 全部变更跨主体分组（anchor 聚合行 + per-subject 组，组内 patches
   * 可展开 value）。
   */
  worldSliceDetail(input: WorldSliceDetailRequest): Promise<WorldSliceDetail>;
  /**
   * L3 主体详情：仅全史 patches（BMad CR #4 砍除 shell 侧 reduce/reduced/issues 载荷与 `at` 参数）
   * ——as-of 切线快照/折叠由 UI 本地纯函数重算（数据已在手零 IPC）。
   */
  worldSubjectDetail(input: WorldSubjectDetailRequest): Promise<WorldSubjectDetail>;
  /**
   * 订阅 `world:changed` 推送事件（world 数据三写入口——写章链 slice 落表 / backfill reset /
   * amendment——事务提交后 best-effort 发射）。返回退订函数，只移除本监听器（mirror
   * onUpdateEvent / onToolEvent 形态）。
   */
  onWorldChanged(callback: (event: WorldChangedEvent) => void): () => void;
  /** 显式退订单个监听器（removeListener 本监听器，绝不 removeAllListeners）。 */
  offWorldChanged(callback: (event: WorldChangedEvent) => void): void;
  runStorySync(payload: RunStorySyncPayload): Promise<RunStorySyncResult>;
  loadUserPreferences(): Promise<UserPreferencesConfig>;
  saveUserPreferences(config: UserPreferencesConfig): Promise<void>;
  /** Enumerate fonts the user has imported into the app's font folder. */
  listImportedFonts(): Promise<ImportedFont[]>;
  /** Open a file picker, copy chosen font files into the app, return all imported fonts. */
  importFonts(): Promise<ImportedFont[]>;
  /**
   * Open a file picker (single image), copy the chosen file into
   * `userData/wallpaper/`, and return its `orison-file:///` URL. Null when the
   * dialog is canceled (or the picked file is not a supported image).
   */
  importWallpaper(): Promise<{ url: string } | null>;
  /** Delete the imported wallpaper files (the wallpaper directory itself is kept). */
  clearWallpaper(): Promise<void>;
  showItemInFolder(fullPath: string): void;
  openPath(fullPath: string): void;
  /** Open an external https URL in the user's default browser. */
  openExternal(url: string): void;
  readDirectory(projectDir: string, maxDepth?: number): Promise<FileTreeEntry[]>;
  deleteEntry(fullPath: string): Promise<boolean>;
  renameEntry(oldPath: string, newPath: string): Promise<boolean>;
  createEntry(fullPath: string, isDir: boolean): Promise<boolean>;
  readFile(fullPath: string): Promise<string | null>;
  /** Regex text search across a project directory; returns structured hits. */
  searchProject(projectDir: string, query: string, maxResults?: number): Promise<ProjectSearchResult[]>;
  readFileBinary(fullPath: string): Promise<BinaryFilePayload | null>;
  readFileBinary(fullPath: string): Promise<BinaryFilePayload | null>;
  writeFile(fullPath: string, content: string): Promise<boolean>;
  wordCount(projectDir: string): Promise<number>;
  pathExists(fullPath: string): Promise<boolean>;
  saveBase64Image(projectDir: string, input: SaveBase64ImageInput): Promise<SavedImageFile>;
  moveProjectFile(projectDir: string, fromRelativePath: string, toRelativePath: string): Promise<string>;
  deleteProjectFile(projectDir: string, relativePath: string): Promise<boolean>;
  importFiles(projectDir: string, targetRelDir: string, sourcePaths: string[]): Promise<string[]>;
  pathForFile(file: File): string;
  watchProject(projectDir: string): Promise<void>;
  unwatchProject(): Promise<void>;
  ensureProjectRegistration(input: { projectId?: string; name: string; type: 'novel' | 'script'; localFingerprint: string; path?: string; coverImage?: string }): Promise<{ projectId: string; name: string; type: string }>;
  /** List every project registered on this machine (durable across version changes). */
  listRegisteredProjects(): Promise<RegisteredProject[]>;
  /** Bump last-opened time (and optionally cover image) for a registered project. */
  touchProjectRegistration(input: { localFingerprint: string; coverImage?: string }): Promise<void>;
  /** 将项目内容复制到同级新目录，并生成独立项目身份。 */
  duplicateProject(projectPath: string, name: string): Promise<ProjectLifecycleResult>;
  /** 只重命名项目元数据，不移动项目目录。 */
  renameProject(projectPath: string, name: string): Promise<ProjectLifecycleResult>;
  /** 将项目目录移入系统回收站，并软归档注册记录。 */
  deleteProject(projectPath: string): Promise<ProjectLifecycleResult>;
  // Task persistence (SQLite)
  listTasks(projectId: string, limit?: number): Promise<TaskRecord[]>;
  upsertTask(input: TaskUpsertInput): Promise<void>;
  updateTaskStatus(taskId: string, status: string, errorMessage?: string): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  // Asset persistence (SQLite)
  listAssets(projectId: string): Promise<AssetRecord[]>;
  upsertAsset(input: AssetUpsertInput): Promise<void>;
  updateAsset(projectId: string, assetId: string, fields: Partial<Pick<AssetRecord, 'assetName' | 'assetGroup' | 'summary' | 'assetStatus'>>): Promise<void>;
  deleteAsset(projectId: string, assetId: string): Promise<void>;
  /** Open a native picker to import external image files into assets/images and
   *  register them. Returns the relative paths actually imported. */
  importAssets(projectDir: string, projectId: string): Promise<string[]>;
  // Logging
  openLogsDir(): Promise<string>;
  writeLog(payload: { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; message: string; meta?: Record<string, unknown> }): Promise<void>;
  // Version + update
  getAppVersion(): Promise<string>;
  checkForUpdate(): Promise<UpdateCheckResult>;
  /** Begin downloading the available update (electron-updater). */
  downloadUpdate(): Promise<void>;
  /** Quit and install the downloaded update now. */
  installUpdate(): Promise<void>;
  /** Subscribe to update lifecycle events. Returns an unsubscribe fn. */
  onUpdateEvent(callback: (event: UpdateEvent) => void): () => void;
  // Git
  gitIsRepo(dir: string): Promise<boolean>;
  gitInit(dir: string): Promise<{ initialized: boolean }>;
  gitLog(dir: string, depth?: number): Promise<GitCommitEntry[]>;
  gitCommitDiff(dir: string, oid: string): Promise<GitFileDiff[]>;
  gitFileAtCommit(dir: string, oid: string, filepath: string): Promise<string | null>;
  gitCreateNode(dir: string, message: string, tag?: string): Promise<{ oid: string }>;
  gitListBranches(dir: string): Promise<string[]>;
  gitCurrentBranch(dir: string): Promise<string>;
  gitCreateBranch(dir: string, name: string, fromOid?: string): Promise<void>;
  gitCheckoutBranch(dir: string, name: string): Promise<void>;
  /** Restore the working tree to `oid` and commit it as a new node on the current branch. */
  gitRestoreVersion(dir: string, oid: string, message: string): Promise<{ oid: string }>;
  gitStatusCount(dir: string): Promise<number>;
  onToolEvent(callback: (data: { type: string; [key: string]: unknown }) => void): () => void;
  // Agent
  createAgentSession(input: { agentName: string; projectPath: string; mode?: 'readonly' | 'suggest' | 'auto'; behaviorMode?: AgentBehaviorMode; participationGear?: ParticipationGear }): Promise<unknown>;
  getAgentSession(id: string, projectPath?: string): Promise<unknown>;
  setAgentSessionMode(sessionId: string, projectPath: string | undefined, mode: 'readonly' | 'suggest' | 'auto'): Promise<{ ok: boolean }>;
  /** Story 3.1: set the leader runLoop's behavior mode (normal/discuss/plan). */
  setAgentSessionBehaviorMode(sessionId: string, projectPath: string | undefined, behaviorMode: AgentBehaviorMode): Promise<{ ok: boolean }>;
  /**
   * Story 3.5: set the leader's participation gear (smart/steer/balanced/hands_off) +
   * balanced 档圈类别 / hands_off trustAdjudication。Session 级持久化；跑动中拒改（下一轮生效，
   * mirror setAgentSessionBehaviorMode；chat 指令中途调档走 leader 的 set_participation_gear 工具）。
   */
  setAgentSessionParticipationGear(
    sessionId: string,
    projectPath: string | undefined,
    gear: ParticipationGear,
    options?: { balancedAskCategories?: BalancedAskCategory[]; trustAdjudication?: boolean },
  ): Promise<{ ok: boolean }>;
  listAgentSessions(projectPath?: string): Promise<unknown>;
  deleteAgentSession(id: string, projectPath?: string): Promise<boolean>;
  /**
   * 从此截断（dogfood 2026-08-21）：丢弃 messageId 及其后全部（runtime 内存+JSONL+索引）。
   * 纯对话尾巴专用——含工具痕迹（含只读）/运行中/未找到 → ok:false 拒绝。
   */
  truncateAgentSession(sessionId: string, messageId: string): Promise<
    { ok: true; removed: number } | { ok: false; reason: 'not-found' | 'running' | 'tool-activity' }
  >;
  streamAgentMessage(input: { sessionId: string; content: string; attachments?: unknown[] }): Promise<StreamAgentMessageResult>;
  onAgentStreamEvent(callback: (event: { type: string; data: unknown }) => void): () => void;
  resolveAgentConfirmation(sessionId: string, callId: string, approved: boolean): Promise<unknown>;
  listAgentSkills(projectPath: string): Promise<unknown>;
  executeAgentSkill(sessionId: string, skillName: string, request?: unknown): Promise<unknown>;
  listAgentContinuations(sessionId: string): Promise<unknown>;
  restoreAgentContinuation(sessionId: string, continuationId: string): Promise<unknown>;
  abortAgentRun(sessionId: string): Promise<boolean>;
  /**
   * Context-compaction manual trigger (compaction three-trigger model, trigger
   * ① manual): compact the given leader session's conversation NOW via a single
   * summarization compaction pass. The redline (②) and window-overflow (③)
   * auto-triggers live inside the runtime — this is the user-initiated path
   * (leader toolbar button; the one-line-command form attaches here once the
   * dual-use command bar exists). Idle semantics: without an active run the
   * runtime loads the persisted session and compacts it independently.
   * Returns true when a compaction ran; false when the runtime seam is not
   * wired yet, or the session is missing / busy.
   */
  compactAgentSession(sessionId: string): Promise<boolean>;
  // Skill package management
  listSkillPackages(projectPath?: string): Promise<SkillPackageInfo[]>;
  setPackageEnabled(packageName: string, enabled: boolean): Promise<{ ok: boolean }>;
  setSkillEnabled(packageName: string, skillName: string, enabled: boolean): Promise<{ ok: boolean }>;
  // Window lifecycle
  onBeforeClose(callback: () => void): () => void;
  confirmClose(): void;
};

/**
 * `agent:stream-message` invoke 返回值（dogfood T1 Stage 3 D4 + CR-T1-013 契约同步）。
 *
 * - completed/aborted/error：run 已走完的终态（message 为 error/aborted 附言）。
 * - rejected：**run 未启动**的结构化拒绝——两种 code：
 *   - `project_run_active`：D4 同项目单 run 闸（shell projectActiveRuns）占用，heldBySessionId
 *     为占用者（会话 id 或链租约 id `chain-run:closure:*`——后者不可跳转，UI 换文案不提供跳转钮）。
 *   - `session_run_active`：该会话自身 runState 已有活跃 run（重叠 invoke）——UI 按「已占用」
 *     处理，不 purge 流占位、不显错误横幅。
 */
export type StreamAgentMessageResult =
  | { status: 'completed' | 'aborted' | 'error'; message?: string }
  | { status: 'rejected'; code?: string; heldBySessionId?: string; projectPath?: string };

/* ── 风格卡片 MVP（08-28 C 路）：request_style_input 事件链契约 ── */

/**
 * `style_input_requested` tool:event 载荷（风格卡片 MVP）。
 *
 * 链路：leader `request_style_input` 工具 → shell handler（toolExecution）→ notifyUI
 * （tool:event 既有推送通道，零新 IPC/preload 面）→ renderer useToolEvents（过
 * current-project 匹配守卫）→ 风格片段对话框（StyleInputDialog）弹出。
 *
 * - projectPath：工具执行的 projectDir（消费侧项目匹配守卫用）。
 * - prompt：leader 可选传的一句提示语，显示在对话框顶部（告诉作者贴什么样的片段）。
 */
export type StyleInputRequestedEvent = {
  type: 'style_input_requested';
  projectPath: string;
  prompt?: string;
};

/**
 * 风格片段结构化 user message 的标记行约定（风格卡片 MVP，D4 原文直传 / D6 对话框收集）。
 *
 * `agent:stream-message` 的 content 只收纯文本——fragment/notes 分离字段以**标记行**结构化。
 * 对话框提交侧用 buildStyleInputMessage 构造；按 sourceMessageId 机械提取原文的一侧
 * （dispatch_style_analyzer）**直接 import parseStyleInputMessage 解析，勿自行复制格式**
 * （单源防两处漂移）。形态：
 *
 * ```
 * [style-input-fragment]
 * <fragment 逐字原文（内部换行原样保留）>
 * [style-input-notes]
 * <notes（可省略整段；有 marker 行时可为空串）>
 * ```
 *
 * - fragment 两标记行之间**逐字节**保存（构造端已 trim，解析端不再 trim——保 verbatim）。
 * - 无备注时 notes 标记行整段省略。
 * - 标记行判定**独占一行**（行首 + 行尾即 `\n`/串尾；带余文或尾随空白不算标记行）——
 *   防手打文本里的伪标记被误认成结构边界（CR-011）。
 * - fragment/notes 含与标记行 trim 相等的独立行 → 构造**抛错**（响亮拒绝，不静默坏解析）。
 */
export const STYLE_INPUT_FRAGMENT_MARKER = '[style-input-fragment]';
export const STYLE_INPUT_NOTES_MARKER = '[style-input-notes]';

/** parseStyleInputMessage 的返回：fragment 逐字节原文 + 可选作者备注。 */
export type StyleInputMessage = {
  fragment: string;
  notes?: string;
};

/** 构造风格片段结构化 user message（对话框提交侧单源；含保留标记行时抛错）。 */
export function buildStyleInputMessage(fragment: string, notes?: string): string {
  assertNoMarkerLine(fragment, 'fragment');
  const hasNotes = notes !== undefined && notes.length > 0;
  if (hasNotes) assertNoMarkerLine(notes as string, 'notes');
  const base = `${STYLE_INPUT_FRAGMENT_MARKER}\n${fragment}`;
  return hasNotes
    ? `${base}\n${STYLE_INPUT_NOTES_MARKER}\n${notes}`
    : base;
}

/**
 * 从消息 content 机械提取风格片段结构（dispatch 侧单源）。
 * 非 style-input 消息（无行首 fragment 标记）→ null。fragment 逐字节原样返回（不 trim）。
 *
 * **两个标记都必须独占一行**（CR-011 收紧）：行首（串首或前随 `\n`）且行尾即 `\n` 或串尾
 * ——标记后带余文（含尾随空格）不算标记行，该次出现按普通正文对待。防用户手打文本里
 * 「[style-input-notes] 余文」形态被误认成结构边界导致 notes 起点错位。
 */
export function parseStyleInputMessage(content: string): StyleInputMessage | null {
  const head = content.indexOf(STYLE_INPUT_FRAGMENT_MARKER);
  // fragment 标记须独占一行（行首 + 行尾即 \n 或 EOS）——行中/行尾带余文的同文不算。
  if (head === -1 || (head !== 0 && content[head - 1] !== '\n')) return null;
  const afterMarker = head + STYLE_INPUT_FRAGMENT_MARKER.length;
  if (afterMarker < content.length && content[afterMarker] !== '\n') return null;
  const fragmentStart = afterMarker + 1;
  const notesHead = content.indexOf(`\n${STYLE_INPUT_NOTES_MARKER}`, fragmentStart);
  if (notesHead === -1) {
    return { fragment: content.slice(fragmentStart) };
  }
  // notes 标记同判独占一行（CR-011）：行尾非 \n/EOS（带余文/尾随空白）→ 不是标记——
  // 该行按 fragment 正文原样保留，整条按无 notes 段解析。
  const afterNotes = notesHead + 1 + STYLE_INPUT_NOTES_MARKER.length;
  if (afterNotes < content.length && content[afterNotes] !== '\n') {
    return { fragment: content.slice(fragmentStart) };
  }
  const notesStart = afterNotes + 1;
  return {
    fragment: content.slice(fragmentStart, notesHead),
    notes: content.slice(notesStart),
  };
}

function assertNoMarkerLine(text: string, where: string): void {
  const hit = [STYLE_INPUT_FRAGMENT_MARKER, STYLE_INPUT_NOTES_MARKER].find((marker) =>
    text.split('\n').some((line) => line.trim() === marker),
  );
  if (hit !== undefined) {
    throw new Error(`${where} contains the reserved marker line ${hit}`);
  }
}

export type FileTreeEntry = {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeEntry[];
};

export type SaveBase64ImageInput = {
  b64Json: string;
  mimeType: string;
  directory: 'temp/images/generation' | 'assets/images';
  fileName?: string;
};

export type SavedImageFile = {
  relativePath: string;
  fullPath: string;
  fileName: string;
};

/** Binary file payload returned by `project:read-file-binary`. */
export type BinaryFilePayload = {
  base64: string;
  mimeType: string;
};

/* ── Task persistence types ── */

export type TaskRecord = {
  taskId: string;
  projectId: string;
  taskType: string;
  name: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  errorMessage?: string;
  outputPayload?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskUpsertInput = {
  taskId: string;
  projectId: string;
  taskType: string;
  name: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  errorMessage?: string;
  outputPayload?: string;
};

export type AssetRecord = {
  assetId: string;
  projectId: string;
  assetType: string;
  assetName: string;
  assetGroup: string;
  assetStatus: string;
  relativePath: string;
  sourceTaskId?: string;
  summary?: string;
  version: number;
  updatedAt: string;
};

export type AssetUpsertInput = {
  assetId: string;
  projectId: string;
  assetType: string;
  assetName: string;
  assetGroup?: string;
  assetStatus?: string;
  relativePath: string;
  sourceTaskId?: string;
  summary?: string;
};
