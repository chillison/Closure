import type { StoryDecision } from './story-decision';

// ── Story 4.1 Step 4：chapter-integration 持久化（CR-15b）共享纯函数 ──
//
// design §3.3 layering 合规路径：**agent 不能 fs 直写 project.yaml**（data-model.md L31 所有权：project.yaml
// 受管配置，只结构化 IPC 在项目锁内写）。链段 child session **不写盘**——产 `chapter_accept` artifact
// 经 RunSnapshotSummary 回传，入口层（IPC 同层调 acceptChapterCandidate / leader 返 field_patch metadata
// 走既有 patch review 流）持久化。本文件 = 入口层 + 链段共用的**纯函数**（无 fs / 无 Date / 无 db）：
//
// - `acceptChapterCandidateCore`：acceptChapterCandidate（local-bff standalone API）+ applyFieldPatches
//   chapter_candidate 分支共同的项目 mutation 纯逻辑（DRY）。两 local-bff 调用方包 disk 写盘（mkdir +
//   atomicWrite + saveProject），core 只算 `updatedProject + mdPath + mdContent + chapterMeta`。
// - `resolveChapterIdForEpisode`：episodeId → episode_outlines[].index → novel.chapters[sort_order===index]
//   映射（章号从 episode.index 派生，creative-fields.ts:952 / weavingLayout.ts「章 = episode.index, derived
//   not stored」）。映射失败 → undefined（accept 阻断 + 明确报错，非静默写错位置）。
// - `buildChapterAccept`：链段 accept 分支（onAccept 回调）从 RunSnapshot + project 上下文产 chapter_accept
//   artifact（不写盘）。入口层（write-chapter tool / closureChainIpc）提供 onAccept 闭包调本函数。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：本文件全确定性（结构 mutation / ref 查询 /
// 字段投影），「不理解意义」。deviation 判定（正文是否偏离计划）归 LLM route 节点（route_decision.deviation
// 字段，yaml 输出）；本处只机械读 boolean 决定是否登记 StoryDecision。chapterId 映射 = 纯结构查询。
//
// 落点 shared-contracts（design §5）：跨包共享（agent 链段 onAccept + local-bff 两调用方 + shell IPC 入口）。
// 纯函数（无 fs/db/LLM/Date）→ 可 plain vitest 单测。零 migration（新文件；调用方 additive optional 字段）。
//
// expected_downstream_consumers:
// - Story 4.1 Step 4（本 step）：local-bff acceptChapterCandidate + applyFieldPatches 重构调 core；
//   agent chainRunner onAccept 调 buildChapterAccept；write_chapter / closureChainIpc 入口层持久化。
// - Story 4.1 Step 5：工作台 leader 触发入口（UI 接线）消费 chapter_accept field_patch metadata。
// - Story 2.6：工作台 UI 决策登记 / Director agent 登记（交互层 defer E3 / Director）。

// ── ChapterCandidate：draft 产出 → 持久化候选 shape ──
//
// mirror local-bff novelProjectRepository.ChapterCandidate + novel-orchestration chapterCandidatePatchSchema.candidate
// （两处同形 {title?, content, summary?, wordCount?}）。draft-writer 产出 {title, text, wordCount} → candidate
// 映射 title→title / text→content / wordCount→wordCount（content 字段名对齐 chapter_candidate patch 既有契约）。

/** 章节候选内容（draft 产出 → chapter markdown + 元数据更新）。 */
export interface ChapterCandidate {
  title?: string;
  content: string;
  summary?: string;
  wordCount?: number;
}

// ── chapterId 映射所需的最小 chapter / episode 结构（结构性，避免拉全 ProjectDocument 类型）──

/** resolveChapterIdForEpisode 接受的章节结构子集（novel.chapters[] 元素满足）。 */
export interface ResolvableChapter {
  id: string;
  /** 章节排序序号（0-based；章号从 episode.index 派生，故 sort_order===episode.index 为本章）。 */
  sort_order?: number;
}

/** resolveChapterIdForEpisode 接受的 episode 结构子集（episode_outlines[] 元素满足）。 */
export interface ResolvableEpisode {
  id: string;
  /** episode 索引（0-based，章号源——creative-fields.ts:952 / weavingLayout.ts）。 */
  index: number;
}

// ── acceptChapterCandidateCore：项目 mutation 纯逻辑（不写盘）──

/**
 * acceptChapterCandidateCore 接受的项目结构子集（ProjectDocument 满足；结构 typing 避免拉全类型 + migration）。
 *
 * `novel.chapters[]` + `novel.story_decisions[]`（4.1 Step 3 落库点）+ `meta.{version, updated_at}`。
 * core 不做 schema re-parse（纯 mutation；调用方包 projectDocumentSchema.parse + saveProject）。
 */
export interface ChapterIntegrationProject {
  novel?: {
    chapters?: Array<{
      id: string;
      title?: string;
      sort_order?: number;
      summary?: string;
      // CR-4.1-11：对齐 chapterSchema 实际（z.enum(['ai','user']).optional()）；旧 `string` type-lie 放宽。
      summary_source?: 'ai' | 'user';
      status?: string;
      word_count?: number;
      last_run_id?: string;
      generated_at?: string;
      sections?: Array<{ id: string; content_file: string; word_count?: number; sort_order?: number }>;
    }>;
    story_decisions?: StoryDecision[];
  };
  meta: { version: number; updated_at: string };
}

/** core 产出的本章元数据快照（持久化后状态，供调用方 / 测试断言）。 */
export interface ChapterMetaSnapshot {
  title?: string;
  summary?: string;
  // CR-4.1-11：对齐 chapterSchema（z.enum(['ai','user']).optional()）；旧 `'ai'` type-lie（pre-existing
  // 'user' 会被窄化丢）。candidate 无 summary 时保留原 chapter.summary_source（可能 'user'）。
  summary_source?: 'ai' | 'user';
  word_count?: number;
  status: string;
  last_run_id: string;
  generated_at: string;
}

export interface AcceptChapterCandidateInput {
  project: ChapterIntegrationProject;
  chapterId: string;
  runId: string;
  candidate: ChapterCandidate;
  /** ISO 时间戳——caller 注入（core 纯函数无 Date；local-bff 调用方 `new Date().toISOString()`）。 */
  nowISO: string;
  /** accept 登记 StoryDecision（route=accept_as_truth 且正文偏离计划时，onAccept 建 decided decision）。 */
  storyDecisions?: StoryDecision[];
}

export interface AcceptChapterCandidateResult {
  /** mutation 后的项目（章节元数据更新 + story_decisions 追加 + meta.version/updated_at 递增）。 */
  updatedProject: ChapterIntegrationProject;
  /** section.content_file（相对路径，调用方 join projectPath + mkdir + atomicWrite）。 */
  mdPath: string;
  /** candidate.content（调用方 atomicWrite 写入 mdPath）。 */
  mdContent: string;
  /** 本章更新后元数据快照。 */
  chapterMeta: ChapterMetaSnapshot;
}

/**
 * accept 章节 candidate 的项目 mutation 纯逻辑（design §3.3 / CR-15b）。**不写盘**——disk 写盘（mkdir +
 * atomicWrite + saveProject）在 local-bff 调用方。
 *
 * 逻辑（mirror acceptChapterCandidate + applyFieldPatches chapter_candidate 共同部分）：
 * 1. structuredClone project（不改入参引用）。
 * 2. 查 novel.chapters + chapter(by id) + section[0]——任一缺失 → 返 null（调用方决定 throw 或静默 skip）。
 * 3. 更新章节元数据：title（candidate 有）/ summary + summary_source='ai'（candidate 有）/ word_count +
 *    section.word_count（candidate 有）/ status='draft' / last_run_id=runId / generated_at=nowISO。
 * 4. story_decisions 追加（若提供）到 novel.story_decisions（create array if absent）。
 *
 * ⚠️ **不动 meta.version / meta.updated_at**：版本递增是调用方的 batch 级关注点（acceptChapterCandidate
 * 单 candidate 调用 bump 一次；applyFieldPatches 整批 patch loop-end bump 一次）。core 若 bump 会让
 * applyFieldPatches 的 loop-end 再 bump 一次 → double-count。调用方各自 bump meta。
 *
 * 调用方行为差异（由调用方处理，core 统一返 null on missing）：
 * - `acceptChapterCandidate`（standalone API）：null → throw「chapter not found」（显式失败）。
 * - `applyFieldPatches` chapter_candidate 分支：null → continue（静默 skip，mirror 4.0 前姿态）。
 *
 * @returns mutation 结果，或 null（章节 / section 缺失）。调用方决定如何处理 null。
 */
export function acceptChapterCandidateCore(
  input: AcceptChapterCandidateInput,
): AcceptChapterCandidateResult | null {
  const { project, chapterId, runId, candidate, nowISO, storyDecisions } = input;

  const next = structuredClone(project) as ChapterIntegrationProject;

  // CR-4.1-10：删旧 `if (!next.novel) next.novel = { chapters }` 无效分支——`chapters` 派生自 `next.novel?.chapters`，
  // 缺已下方 null return，故 next.novel 必存在（旧分支 unreachable）。且若 reach，`next.novel = { chapters }`
  // 会丢 story_decisions + 同级键（重建 novel 只含 chapters）。改用 local `novel` 引用：经此命名引用 TS 能
  // narrow（旧经中间变量 `chapters` 的 optional chain 不能传播 narrowing 回 `next.novel`，故旧代码靠被删的
  // 无效分支作 type-guard）。`novel` 与 `next.novel` 同一引用，mutate 经 `next` 返回。
  const novel = next.novel;
  if (!novel || !novel.chapters) return null;
  const chapters = novel.chapters;
  const chapter = chapters.find((ch) => ch.id === chapterId);
  if (!chapter) return null;
  const section = chapter.sections?.[0];
  if (!section) return null;

  // 更新章节元数据（与 acceptChapterCandidate / applyFieldPatches 共同逻辑一致）。
  if (candidate.title !== undefined) {
    chapter.title = candidate.title;
  }
  if (candidate.summary !== undefined) {
    chapter.summary = candidate.summary;
    chapter.summary_source = 'ai';
  }
  if (candidate.wordCount !== undefined) {
    chapter.word_count = candidate.wordCount;
    section.word_count = candidate.wordCount;
  }
  chapter.status = 'draft';
  chapter.last_run_id = runId;
  chapter.generated_at = nowISO;

  // story_decisions 追加（accept 登记；create novel.story_decisions 若 absent）。novel 经 local 引用 TS
  // 已 narrow 为 defined（无需旧无效 type-guard 分支）。
  if (storyDecisions && storyDecisions.length > 0) {
    if (!novel.story_decisions) novel.story_decisions = [];
    novel.story_decisions.push(...storyDecisions);
  }

  return {
    updatedProject: next,
    mdPath: section.content_file,
    mdContent: candidate.content,
    chapterMeta: {
      title: chapter.title,
      summary: chapter.summary,
      // CR-4.1-11：cast 删——ChapterIntegrationProject.novel.chapters[].summary_source 已收紧为
      // `'ai' | 'user' | undefined`（对齐 schema），直接读类型正确（旧 `as 'ai' | undefined` 是 type-lie）。
      summary_source: chapter.summary_source,
      word_count: chapter.word_count,
      status: chapter.status,
      last_run_id: chapter.last_run_id,
      generated_at: chapter.generated_at,
    },
  };
}

// ── resolveChapterIdForEpisode：episodeId → chapterId 映射 ──

/**
 * 解析 episodeId 对应的 novel.chapters[].id（design §3.3 / CR-15b 硬约束）。
 *
 * 映射链（章号源 = episode.index，creative-fields.ts:952 注释 + weavingLayout.ts:17「章 = episode.index,
 * derived not stored」）：
 * 1. directChapterId 提供（用户工作台选章直传）→ 直接返回（绕过映射推断，优先）。
 * 2. episode_outlines.find(id===episodeId).index → novel.chapters.filter(sort_order===index) 唯一命中 → id。
 * 3. 任一步缺失 / 歧义（episode 不存在 / 0 命中=章未注册 / >1 命中=sort_order 重复歧义）→ undefined
 *    （accept 阻断 + 明确报错，CR-4.1-06：旧 `find` 取首个静默写错章）。
 *
 * sort_order 与 episode.index 均为 0-based nonnegative int（chapterSchema.sort_order / episodeOutlineSchema.index）
 * ——第 1 章 = sort_order 0 = episode.index 0。两者直等映射（与 brief-compiler episodeIndexById 同源）。
 *
 * 范式判据（ADR-3）：纯结构查询（ref 相等 + 数值相等），非语义。不判「这章属不属于这 episode」（章号派生
 * 是数据约定，非判断）。
 *
 * @param episodeOutlines  project.episode_outlines（章号源；缺 → 仅靠 directChapterId）
 * @param novelChapters    project.novel.chapters（注册章节；缺 → 仅靠 directChapterId）
 * @param episodeId        本章目标 episode id（refs episode_outlines[].id）
 * @param directChapterId  用户工作台选章直传（优先；绕过映射推断）
 * @returns                chapter id，或 undefined（映射失败）
 */
export function resolveChapterIdForEpisode(
  episodeOutlines: ReadonlyArray<ResolvableEpisode> | undefined,
  novelChapters: ReadonlyArray<ResolvableChapter> | undefined,
  episodeId: string,
  directChapterId?: string,
): string | undefined {
  // 用户直传优先（绕过映射推断）。
  if (directChapterId) return directChapterId;

  // episode → index
  if (!episodeOutlines) return undefined;
  const episode = episodeOutlines.find((ep) => ep.id === episodeId);
  if (!episode) return undefined;
  const targetIndex = episode.index;

  // index → chapter（sort_order===index）
  if (!novelChapters) return undefined;
  // CR-4.1-06：多命中检测——chapterSchema.sort_order 无唯一约束，两章共 sort_order 时旧 `find`
  // 取首个命中会静默写错章（accept 持久化到错位置）。改 filter + length!==1 防御：0（章未注册）或
  // >1（映射歧义）均 → undefined（accept 阻断 + 入口层据 skipReason:'no-chapter' 出明确报错）。
  const matches = novelChapters.filter((ch) => ch.sort_order === targetIndex);
  if (matches.length !== 1) return undefined;
  return matches[0].id;
}

// ── resolveEpisodeIdForChapter：chapterId → episodeId（正向链取反，Story 8.7 BMad CR-001）──

/**
 * 解析 chapterId 对应的 episode id（`resolveChapterIdForEpisode` 的反向）。
 *
 * 映射链取反转置：chapter.id → sort_order → `episode_outlines.filter(index===sort_order)` 唯一命中 →
 * id；再经正向 `resolveChapterIdForEpisode` 回代校验（**正反一致性**——双章共 sort_order 时正向本就
 * undefined，反向同判 undefined，两侧不会「一个能解析一个不能」）。任一步缺失/歧义（章不存在 /
 * sort_order 缺 / 多 episode 同 index / 正向回代不符）→ undefined（调用方 best-effort 跳过，不猜）。
 *
 * 使用方（shell mentionLedgerDegrade，Story 8.7 BMad CR-001 方案 A）：章正文落盘点（chapter_write
 * 工具 / write_file / 编辑器写盘 IPC）的 mention 账降档 hook——落盘点只知 chapterId（文件 stem）不知
 * episode，经本函数单源取反（与 chapterHandlers chapter_list 增强共用同一 canonical 链，防两处漂移）。
 *
 * 范式判据（ADR-3）：纯结构查询（数值相等 + ref 相等），非语义。
 */
export function resolveEpisodeIdForChapter(
  episodeOutlines: ReadonlyArray<ResolvableEpisode> | undefined,
  novelChapters: ReadonlyArray<ResolvableChapter> | undefined,
  chapterId: string,
): string | undefined {
  if (!episodeOutlines || !novelChapters) return undefined;
  const chapter = novelChapters.find((ch) => ch.id === chapterId);
  if (!chapter || typeof chapter.sort_order !== 'number') return undefined;
  // sort_order → episode（index 唯一命中；0/>1 均歧义 → undefined，mirror 正向 CR-4.1-06 防御）。
  const candidates = episodeOutlines.filter((ep) => ep.index === chapter.sort_order);
  if (candidates.length !== 1) return undefined;
  // 正向回代校验：sort_order 双章时正向解析 undefined/他章，反向不得单侧放行（镜像错位防线）。
  return resolveChapterIdForEpisode(episodeOutlines, novelChapters, candidates[0].id) === chapterId
    ? candidates[0].id
    : undefined;
}

// ── buildChapterAccept：链段 accept 分支产 chapter_accept artifact（不写盘）──

/**
 * buildChapterAccept 接受的 RunSnapshot 结构子集（agent RunSnapshot 满足；结构 typing 避免跨包 import）。
 *
 * artifacts 含 'draft.initial'（candidate 源）+ 'route_decision'（deviation 判定源）。Record<string, unknown>
 * → run.artifacts 直传，buildChapterAccept 防御性 narrow（mirror chainRunner.recordOf）。
 */
export interface ChapterAcceptSnapshot {
  runId: string;
  artifacts: Record<string, unknown>;
}

/** chapter_accept artifact（链段产出，入口层消费做持久化）。 */
export interface ChapterAcceptArtifact {
  /** 目标 chapter id（resolveChapterIdForEpisode 解析；链段不写盘，入口层按此 id 持久化）。 */
  chapterId: string;
  /** draft 产出 → chapter markdown + 元数据更新候选。 */
  candidate: ChapterCandidate;
  /** accept 登记的 StoryDecision（route 判正文偏离计划时，decided decision；无偏离 → 缺省）。 */
  storyDecisions?: StoryDecision[];
  /** 链段 runId（acceptChapterCandidate 按 runId 记 last_run_id）。 */
  runId: string;
}

/**
 * 审核归因三态（Story 8.4 Step 6 / A11，design §1.9）：Reader-Audit 消费写手调查简报（写作执行案）
 * 后，对「正文 vs 计划」类 finding 标注问题出在哪一层：
 * - `execution_gap`：执行案里安排了、正文没写出来（写手执行漏了，改本章正文可修）。
 * - `planning_blind`：执行案里就没安排（写手调查时漏了，需补调查补写）。
 * - `plan_level`：大纲/任务卡层就没安排（上游计划的缺口，非本章写手的执行问题，本章改稿修不了）。
 *
 * 值单源：agent reviewOutputSchema findings 的 attribution zod enum + chainRunner
 * extractEscalateFindings 机械透传均引本 const（三处同步纪律——枚举字面量不重复手写）。
 */
export const REVIEW_ATTRIBUTION_VALUES = ['execution_gap', 'planning_blind', 'plan_level'] as const;
export type ReviewAttribution = (typeof REVIEW_ATTRIBUTION_VALUES)[number];

/**
 * 灰区审核 finding（Story 4.6）：route=escalate_user 时从 Reader-Audit `review.latest.dimensions[].findings`
 * 抽取，附 RunSnapshotSummary 传给裁决器子 agent + 用户裁决。shape 同 agent reviewOutputSchema findings
 * （chapter-nodes.ts），但落 shared-contracts 供跨包（agent run.ts RunSnapshotSummary + ipc.ts
 * RunChapterChainSummary 两处平行 type 同步）。
 *
 * severity 只 'block'|'warn'（extractEscalateFindings drop info 噪声——info 非灰区不需裁决器/用户关注；
 * CR-Edge-7：type 反映抽取保证，非源 reviewOutputSchema 的 block|warn|info 全集）。quote/location/explanation
 * 必填（grounding 硬要求，R3 §1.2 ConStory-Checker evidence-grounded）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：本 type 只承载 finding 数据（机械投影），不判「finding 多严重」
 * （归裁决器 LLM）。抽取（chainRunner summarizeRunSnapshot 过滤 block+warn）= 纯代码机械。
 */
export interface EscalateFinding {
  subClass?: string;
  severity: 'block' | 'warn';
  quote: string;
  location: string;
  explanation: string;
  /**
   * Story 8.4 Step 6（A11 审核对照归因）：三态见 REVIEW_ATTRIBUTION_VALUES。optional——无调查简报
   * （旧章/直写/自查降级路径）或与计划无关的 finding 不带。机械透传字段（归因判定产自 Reader-Audit
   * L2 语义，抽取只投影不判）。
   */
  attribution?: ReviewAttribution;
}

/**
 * buildChapterAccept 跳过（不产 chapter_accept）的原因（CR-4.1-08 区分失败模式）。
 *
 * 旧 buildChapterAccept 三种失败（无 draft 正文 / 章映射失败 / nowISO 缺）都返纯 `undefined`，入口层
 * 统一报「章未注册」——no-draft / no-nowiso 时该文案误导（draft-writer 没写正文 ≠ 章未注册）。
 * CR-4.1-08：返区分式 `{skipReason}`，入口层据 skipReason 出对应文案。
 */
export type ChapterAcceptSkipReason = 'no-draft' | 'no-chapter' | 'no-nowiso';

/** buildChapterAccept 跳过结果（区分失败模式，CR-4.1-08；不再返纯 undefined）。 */
export interface ChapterAcceptSkip {
  skipReason: ChapterAcceptSkipReason;
}

/** buildChapterAccept 返回：成功（ChapterAcceptArtifact，含 chapterId）或 跳过（ChapterAcceptSkip）。 */
export type ChapterAcceptResult = ChapterAcceptArtifact | ChapterAcceptSkip;

/** 安全取 record（过滤非对象/数组），mirror chainRunner.recordOf。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 链段 accept 分支（onAccept 回调）从 RunSnapshot + project 上下文产 chapter_accept artifact（design §3.5 /
 * §3.3）。**不写盘**（纯函数；持久化在入口层 IPC/leader）。
 *
 * 逻辑：
 * 1. nowISO 缺（CR-4.1-09）→ `{skipReason:'no-nowiso'}`（不产 invalid createdAt 违 `z.string().min(1)`；
 *    跳过 StoryDecision 登记）。
 * 2. 读 draft.initial {title, text, wordCount} → ChapterCandidate（title→title / text→content / wordCount→wordCount）。
 *    draft 缺 / 无 text → `{skipReason:'no-draft'}`（无产出可持久化）。
 * 3. 读 route_decision.deviation（LLM 判正文是否偏离计划）→ deviation=true 时建一条 decided StoryDecision
 *    （source:'accept_as_truth', relatedEpisodeId=episodeId, createdAt=nowISO）；无偏离 → 不建（story_decisions 缺省）。
 * 4. resolveChapterIdForEpisode 解析 chapterId（directChapterId 优先 → episode.index → sort_order 唯一命中）。
 *    映射失败 / 歧义 → `{skipReason:'no-chapter'}`（accept 阻断持久化，入口层返明确报错，非静默写错位置）。
 * 5. 返 ChapterAcceptArtifact `{chapterId, candidate, storyDecisions?, runId}`。
 *
 * CR-4.1-08：失败模式返 `{skipReason}` 区分式（非旧纯 undefined 合并误导）——入口层据 skipReason 出对应文案
 * （describeAcceptSkip）。CR-4.1-09：nowISO 缺前置 skip，与 CR-4.1-08 区分式协同。
 *
 * 范式判据：candidate 组装 + chapterId 映射 = 纯代码（机械）；deviation 判定 = LLM route（route_decision.deviation
 * 字段，route-agent.yaml 输出）；本处只机械读 boolean 决定是否登记 + 组装。不判「偏离好不好」（归 LLM route）。
 *
 * @param snapshot  链段 RunSnapshot（读 draft.initial + route_decision）
 * @param ctx.nowISO          ISO 时间戳（入口注入，StoryDecision.createdAt 用；缺 → no-nowiso skip）
 * @param ctx.episodeId       本章 episode id
 * @param ctx.episodeOutlines project.episode_outlines（chapterId 映射源）
 * @param ctx.novelChapters   project.novel.chapters（chapterId 映射目标）
 * @param ctx.directChapterId 用户直传 chapterId（优先）
 * @returns          ChapterAcceptArtifact（成功）或 ChapterAcceptSkip（skipReason 区分失败模式）
 */
export function buildChapterAccept(
  snapshot: ChapterAcceptSnapshot,
  ctx: {
    nowISO: string;
    episodeId: string;
    episodeOutlines?: ReadonlyArray<ResolvableEpisode>;
    novelChapters?: ReadonlyArray<ResolvableChapter>;
    directChapterId?: string;
  },
): ChapterAcceptResult {
  // CR-4.1-09：nowISO 缺 → no-nowiso skip（不产 invalid createdAt 违 z.string().min(1)；StoryDecision 不登记）。
  // 与 CR-4.1-08 区分式协同：跳过返 {skipReason}，入口层出对应文案（非旧纯 undefined 合并误导）。
  if (!ctx.nowISO) return { skipReason: 'no-nowiso' };

  // 1. draft.initial → candidate
  const draft = recordOf(snapshot.artifacts['draft.initial']);
  const text = typeof draft?.text === 'string' ? draft.text : undefined;
  if (!draft || !text) return { skipReason: 'no-draft' }; // 无正文产出，无可持久化
  const candidate: ChapterCandidate = { content: text };
  if (typeof draft.title === 'string') candidate.title = draft.title;
  if (typeof draft.wordCount === 'number') candidate.wordCount = draft.wordCount;

  // 2. route_decision.deviation → decided StoryDecision
  const route = recordOf(snapshot.artifacts['route_decision']);
  const deviation = route?.deviation === true;
  let storyDecisions: StoryDecision[] | undefined;
  if (deviation) {
    const routeReason = typeof route?.reason === 'string' && route.reason.length > 0
      ? route.reason
      : 'route 判定正文偏离计划，按正文为真相接受';
    // 2.6 CR-Edge-4：source 按 route decision 值设（不再恒 'accept_as_truth'）--escalate_user
    // 路径（用户经裁决器建议后 PatchReview accept）登记 'escalate_accepted'，落盘保留 escalation
    // 上下文（可辨「这条偏离经用户裁决」）。escalate 候选只在用户 accept 时落盘（reject -> 改稿
    // 重跑，decision 随候选丢弃不落地），故 build 时标注安全。
    const isEscalate = route?.decision === 'escalate_user';
    storyDecisions = [
      {
        id: `accept-${snapshot.runId}`,
        summary: isEscalate
          ? '正文偏离计划，经灰区裁决后接受为真相（escalate_accepted）'
          : '正文偏离计划，按正文为真相接受（accept_as_truth）',
        reason: routeReason,
        alternatives: [],
        risk: '后续章节的计划 / 状态须据此偏离校正（正文 = 真相，计划追正文）',
        status: 'decided',
        source: isEscalate ? 'escalate_accepted' : 'accept_as_truth',
        landingState: `已体现在 episode ${ctx.episodeId} 正文`,
        relatedEpisodeId: ctx.episodeId,
        createdAt: ctx.nowISO,
      },
    ];
  }

  // 3. chapterId 解析（directChapterId 优先 → episode.index → sort_order 唯一命中）
  const chapterId = resolveChapterIdForEpisode(
    ctx.episodeOutlines,
    ctx.novelChapters,
    ctx.episodeId,
    ctx.directChapterId,
  );
  if (!chapterId) return { skipReason: 'no-chapter' }; // 映射失败/歧义 → accept 阻断持久化（入口层返明确报错）

  // 4. 返 chapter_accept artifact
  const artifact: ChapterAcceptArtifact = {
    chapterId,
    candidate,
    runId: snapshot.runId,
  };
  if (storyDecisions && storyDecisions.length > 0) artifact.storyDecisions = storyDecisions;
  return artifact;
}

/**
 * accept skipReason → 入口层文案（CR-4.1-08：区分 no-draft/no-chapter/no-nowiso 失败模式，非旧统一「章未注册」误导）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：纯机械文案映射（skipReason enum → 固定描述），非语义判断。
 * 落点 shared-contracts：write-chapter tool（agent）+ closureChainIpc（shell）两入口共用（DRY）。
 */
export function describeAcceptSkip(reason: ChapterAcceptSkipReason): string {
  switch (reason) {
    case 'no-draft':
      return 'draft 产出为空（draft-writer 未生成正文），无法持久化';
    case 'no-nowiso':
      return '时间戳缺失（nowISO 未注入），无法登记 StoryDecision';
    case 'no-chapter':
      return '章未在 project.yaml 注册或映射歧义（novel.chapters 无匹配 episode.index 的 sort_order / 多章同 sort_order），先在工作台建章';
  }
}
