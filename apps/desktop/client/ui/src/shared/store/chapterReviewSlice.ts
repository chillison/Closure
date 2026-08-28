import type { StateCreator } from 'zustand';
import type { ChapterReviewMetadata, RevisionIntent, RunChapterChainSummary } from '@orison/shared-contracts';
import { compileRevisionIntent, resumeChapterChain } from '../api/agent';
import type { SelectionInfo } from '../../features/editor/TiptapEditor';
import { registerProjectReset } from './resetRegistry';
import { useToastStore } from './toastStore';
import { getSessionProject } from './agentEvents';
import { parseChainBusyError, showChainRunBusyToast, showRunBusyToast } from './projectRunBusy';

// ── Types ──

/**
 * Story 4.3 Step 4（design §3.6 / §5）：draft checkpoint prose-review state.
 *
 * 当写章链段（write_chapter / closure:run-chapter-chain）在 checkpoint pause（半自动/微操模式），
 * leader write_chapter tool 产 `chapter_review` metadata 挂 tool result（mirror 4.6 chapter_accept→
 * field_patch metadata 模式）。agentSessionSlice 的 tool-result 路由据 `meta.type==='chapter_review'`
 * 派发到本 slice 的 `setPausedReview`（落 pausedReview），AgentPanel mount ChapterReviewPanel 渲染
 * 正文 + 三动作（continue/redo/abort）。
 *
 * 三动作走结构化 IPC `closure:resume-chapter-chain`（mirror 4.6 PatchReview accept/reject——UI 直接
 * 调结构化入口，非经 leader LLM 解释，design §3.5 D7）。IPC 返 RunChapterChainSummary：
 * - status='paused' → 链段在下一 checkpoint 又停，更新 pausedReview 渲染新载荷。
 * - status='completed'|'aborted'|'error'（或其他）→ 链段终结，清 pausedReview（panel 卸载）。
 *
 * Story 7.1 B1（design §4.2）：draft stage 选区指挥精修扩展。
 * - `reviewSelection`：TipTap onSelectionChange 产的当前选区（draft prose 内）。
 * - `compiledIntent` / `intentCompiling` / `intentCompileError`：revision-optimizer 子 agent 编译状态。
 * - `compileIntent` 调 `closure:compile-revision-intent` IPC 派优化 Agent。
 * - `confirmRedoWithIntent` 调 resume-chapter-chain redo + revisionIntent（段落级改稿执行）。
 *
 * 范式判据（ADR-3）：mode 选择 = 用户偏好（UX/控制）；pause/resume 机制 = 纯代码（确定性 IPC 分派）；
 * 意图编译归 LLM（revision-optimizer），UI/slice 只做机械控制信号派发。
 * 本 slice 不做语义判断——只路由 metadata + 派发机械控制信号。
 */
export type ChapterReviewSlice = {
  /**
   * dogfood T1 Stage 3（r8 设计要点 5「第 5 个隐形单槽」）：pausedReview per-session 键控。
   * chainSnapshot 按 parentSessionId 键（shell 侧），UI 侧对称键控——多会话并发时各自
   * pause 互不顶。写入点（agentEvents dispatcher 的 chapter_review 路由 / runResume）都握
   * sessionId；ChapterReviewPanel 只渲染当前视图会话的键。
   */
  pausedReviewBySession: Record<string, ChapterReviewMetadata | undefined>;
  /** True while a resume/redo/abort IPC call is in flight（禁用三动作按钮，防重入）。 */
  reviewResuming: boolean;
  /** Story 7.1 B1：draft prose 内的当前选区（ChapterReviewPanel draft stage TipTap 产）。null = 无选区。 */
  reviewSelection: SelectionInfo | null;
  /** Story 7.1 B1：编译出的 RevisionIntent（确认关用）；null = 未编译 / 已清除 / 编译失败。 */
  compiledIntent: RevisionIntent | null;
  /** Story 7.1 B1：编译中 loading（compileIntent IPC flight，禁用相关按钮）。 */
  intentCompiling: boolean;
  /** Story 7.1 B1：编译失败原因（IPC 返 error 或 throw）；null = 无错误。UI 据此提示重述或手改。 */
  intentCompileError: string | null;
  setPausedReview: (sessionId: string, meta: ChapterReviewMetadata | null) => void;
  /** 清某会话的 pausedReview 键（deleteAgentSession / cancelAgent 用）。 */
  clearPausedReviewFor: (sessionId: string) => void;
  /** Story 7.1 B1：更新当前选区（TipTap onSelectionChange 回调）。 */
  setReviewSelection: (selection: SelectionInfo | null) => void;
  reviewContinue: () => Promise<void>;
  reviewRedo: (feedback?: string) => Promise<void>;
  reviewAbort: () => Promise<void>;
  /**
   * Story 7.1 B1：调 revision-optimizer 子 agent 编译 RevisionIntent。
   *
   * selectedPassage = 用户选中的正文段（render revision-optimizer yaml {{selectedPassage}}）；
   * userInstruction = 用户粗指令原文（render {{userInstruction}}，也作 rawUserInstruction ground truth）；
   * chapterContext = optional 本章 brief JSON 串（帮 optimizer 判锁定项背景）。
   *
   * 🔑 BMad CR F2：selectionFrom/selectionTo + draftText 透传给 IPC——IPC 层纯代码构造 scope.anchor
   * （buildSelectionAnchor 切 prefix/suffix + rangeHint），LLM 不产 anchor。
   *
   * 返 {intent} 非空 → 落 compiledIntent（确认关用）；返 null 或 throw → 落 intentCompileError（graceful，
   * 不假信心不静默 fail，mirror revision-optimizer dispatch 的 graceful 哲学）。
   */
  compileIntent: (
    selectedPassage: string,
    userInstruction: string,
    selectionFrom: number,
    selectionTo: number,
    draftText: string,
    chapterContext?: string,
  ) => Promise<void>;
  /**
   * Story 7.1 B1：确认 RevisionIntent → 调 resume-chapter-chain redo + revisionIntent（段落级改稿执行）。
   *
   * 清除 B1 trigger 状态（compiledIntent / reviewSelection / intentCompileError）后走 runResume redo path，
   * IPC revisionIntent 字段透传到 runChapterChain redo → revision_intent artifact 注入 → draft-writer
   * 段落级 directive → splice 回整章 draft.initial.text（design §3.2 Route 1）。
   */
  confirmRedoWithIntent: (intent: RevisionIntent) => Promise<void>;
  /**
   * Story 7.2 art-mode：revision-guard soft-violation pause 后作者「强行放行」。
   *
   * 调 resume-chapter-chain **redo** + guardOverride='force-accept'（redo.nodeId=revision-guard-agent 在
   * IPC 层据 guardOverride 切，重跑 guard splice soft-violation 稿）。design §1.5 + implement 风险点②：
   * soft-violation pause 时 revision-guard 已在 completedNodes，continue 会跳过 → 必须 redo 重跑。
   */
  forceAcceptGuard: () => Promise<void>;
  /** Story 7.1 B1：清除编译结果（取消确认关 / 重新编译前重置）。 */
  clearCompiledIntent: () => void;
};

type Deps = ChapterReviewSlice & {
  currentProject: { path?: string } | null;
  agentSessionId: string | null;
  /** dogfood T1 CR-T1-027：busy 拒绝 toast 的一键跳转（project_run_active 占用者会话）。 */
  switchAgentSession: (sessionId: string) => Promise<void>;
  /** Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺 envelope 组路由进 PatchReview（creativeFieldsSlice 实现）。 */
  setPendingPatch: (sessionId: string, patch: import('@orison/shared-contracts').ProjectFieldPatch | null) => void;
};

// ── Implementation ──

/**
 * 从 paused 的 RunChapterChainSummary 重建 ChapterReviewMetadata（resume 后链段在下一 checkpoint
 * 又停时，把新 checkpoint 的载荷渲染进 panel）。shape 单源 = ChapterReviewMetadata（与 write-chapter.ts
 * 的 metadata 组装对齐，design §3.5/§3.6）。
 *
 * summary 不回传 chapterId（IPC resume 不复写）——chapterId 由 caller 从上一轮 pausedReview 保留透传。
 *
 * dogfood R2 #83/#84（2026-08-28）：挂起载荷透传——resume 后再挂起（同矛盾再核实 / 新矛盾）时旧实现
 * 丢 researchSuspension + 恒给三钮，把写前挂起渲染成可「继续写」的草稿审阅卡（死循环入口）。现 mirror
 * write-chapter.ts 组装：researchSuspension 在 → resumeOptions=['redo','abort']（挂起无正文可续，恢复
 * 只有 redo——continue 会撞下游 DAG blocked）；挂起载荷随卡透传（决断卡数据源）。
 */
function metadataFromPausedSummary(summary: RunChapterChainSummary): ChapterReviewMetadata {
  const stage = summary.pausedStage ?? 'draft';
  const suspension = summary.researchSuspension;
  const meta: ChapterReviewMetadata = {
    type: 'chapter_review',
    stage,
    resumeOptions: suspension ? ['redo', 'abort'] : ['continue', 'redo', 'abort'],
  };
  if (summary.draftContent !== undefined) meta.draftContent = summary.draftContent;
  if (summary.briefContent !== undefined) meta.briefContent = summary.briefContent;
  // Story 7.2：revision-guard pause 抽 revisionGuard 载荷（findings + 改前/改后 + L1 幅度）供 art-mode 卡。
  if (stage === 'revision-guard' && summary.revisionGuard) {
    meta.revisionGuard = summary.revisionGuard;
  }
  // dogfood R2 #83/#84：挂起 pause 抽挂起载荷（矛盾/偏离明细——决断卡数据源）。
  if (suspension) meta.researchSuspension = suspension;
  return meta;
}

export const createChapterReviewSlice: StateCreator<Deps, [], [], ChapterReviewSlice> = (set, get) => {
  // 项目级状态：切项目必须清——否则上个项目 paused 的 review 泄漏到新项目，三动作会调错项目的
  // resume IPC（写错项目章节，同 agentDiffSlice pendingDiffs 项目隔离硬约束）。[[state-management]]
  // dogfood T1 CR-T1-025：pausedReview 是「等待用户」挂起键（按定义不再产事件）——批3 的
  // owner==当前项目过滤会把离开项目的挂起卡销毁，切回后审阅面板永久丢（主进程 run 死等只能
  // abort 救）。改「按 owner 归属保留」：有归属的键跨项目存活（mirror agentRunStates；渲染面
  // 按 sessionId 键控隔离——ChapterReviewPanel 只读视图会话的键），仅清无归属残键。
  // Story 7.1 B1：选区 + 编译状态是视图态（绑当前面板），无条件清。
  registerProjectReset(() => {
    const nextPaused: Record<string, ChapterReviewMetadata | undefined> = {};
    for (const sid of Object.keys(get().pausedReviewBySession)) {
      if (getSessionProject(sid) !== undefined) nextPaused[sid] = get().pausedReviewBySession[sid];
    }
    set({
      pausedReviewBySession: nextPaused,
      reviewResuming: false,
      reviewSelection: null,
      compiledIntent: null,
      intentCompiling: false,
      intentCompileError: null,
    });
  });

  /**
   * 三动作共享驱动：调 closure:resume-chapter-chain IPC，据返回 summary 和解 pausedReview。
   * - paused → 更新 pausedReview（下一 checkpoint）。
   * - 其他（completed/aborted/error）→ 清 pausedReview（panel 卸载）。
   * - IPC throw / summary.status='error' → 清 pausedReview + toast 报错（不留死面板）。
   *
   * chapterId 透传：从当前 pausedReview 取（IPC resume 不复写；leader write_chapter 初次 pause 时
   * 由 params.chapterId 写入 metadata）。无 chapterId 时 IPC 接受缺省（runChapterChain resume 据
   * chainSnapshot 续跑，不依赖 chapterId）。
   *
   * Story 7.1 B1：revisionIntent optional 透传——confirmRedoWithIntent 用此 path 触发段落级改稿
   * （design §3.2 Route 1）；其他两动作（continue/abort）不传 revisionIntent。
   */
  async function runResume(
    action: 'continue' | 'redo' | 'abort',
    feedback?: string,
    revisionIntent?: RevisionIntent,
    guardOverride?: 'force-accept',
  ): Promise<void> {
    // CR-004：store 层 guard 兜底——程序化双触发（快捷键 / 双 Enter / 非 UI 调用）在首 IPC 未 set
    // reviewResuming 重渲染前竞态，UI 按钮禁用挡不住程序化路径。guard 在 set 前读，单 IPC 进 flight。
    if (get().reviewResuming) return;
    const project = get().currentProject;
    // dogfood T1 Stage 3：resume 绑**视图会话**（ChapterReviewPanel 只渲染视图会话的
    // pausedReview 键——三动作从视图面板发出，owner 恒 = agentSessionId）。
    const sessionId = get().agentSessionId;
    const meta = sessionId ? get().pausedReviewBySession[sessionId] : undefined;
    if (!project?.path || !sessionId) return;
    // CR-002：capture projectPath 在 await 前——await 期间若用户切项目（registerProjectReset 清了
    // pausedReview + 翻 currentProject），IPC 返后写回老项目 pausedReview 会泄漏到新项目（跨项目 resume/写）。
    // post-await 复核 currentProject.path 与 capture 的 path，不等 → 丢弃结果（取消 token 语义）。
    const projectPath = project.path;

    const setPaused = (value: ChapterReviewMetadata | null) => {
      set((s) => {
        if (!value) {
          if (!(sessionId in s.pausedReviewBySession)) return s;
          const next = { ...s.pausedReviewBySession };
          delete next[sessionId];
          return { pausedReviewBySession: next };
        }
        return { pausedReviewBySession: { ...s.pausedReviewBySession, [sessionId]: value } };
      });
    };

    set({ reviewResuming: true });
    try {
      const summary = await resumeChapterChain({
        projectPath,
        sessionId,
        ...(meta?.chapterId ? { chapterId: meta.chapterId } : {}),
        action,
        ...(action === 'redo' && feedback ? { feedback } : {}),
        // Story 7.1 B1：revisionIntent 仅 redo path 透传（continue/abort 无段落级改稿语义）。
        ...(action === 'redo' && revisionIntent ? { revisionIntent } : {}),
        // Story 7.2 art-mode：guardOverride 仅 redo path 透传（force-accept 重跑 revision-guard splice）。
        ...(action === 'redo' && guardOverride ? { guardOverride } : {}),
      });
      // CR-002：await 后、写 state 前复核项目未切——切了则丢弃结果（新项目不该见老链段结果：
      // 不写 pausedReview、不 toast，仅翻 reviewResuming:false 释放 guard）。
      if (get().currentProject?.path !== projectPath) {
        set({ reviewResuming: false });
        return;
      }
      if (summary.status === 'paused') {
        const next = metadataFromPausedSummary(summary);
        // chapterId 保留透传（resume summary 不回传；保留前一轮的避免丢失追踪）。
        if (!next.chapterId && meta?.chapterId) next.chapterId = meta.chapterId;
        setPaused(next);
        set({ reviewResuming: false });
      } else {
        // dogfood T1 CR-T1-027：busy 拒绝（run 未启动——shell D4 闸 / agent 层链守卫）优先于
        // 终态和解：chainSnapshot 与 pausedReview **原样保留**（面板在，busy run 结束后可重试），
        // 只翻 reviewResuming；文案/跳转与 chat 路径同款（projectRunBusy 单源——链租约 id 换
        // 文案无跳转）。旧实现 errors.join(';') 原样透出机器串 + 误清 pausedReview（面板消失丢
        // resume 能力）。
        const busy = summary.status === 'error' ? parseChainBusyError(summary.errors) : undefined;
        if (busy) {
          set({ reviewResuming: false });
          const locale = (get() as unknown as { resolvedLocale?: string }).resolvedLocale ?? 'zh-CN';
          if (busy.kind === 'chain_run_active') {
            // agent 层链守卫：占用者是真实会话但链在跑——文案提示等待，无跳转钮。
            showChainRunBusyToast(locale);
          } else {
            showRunBusyToast({
              heldBySessionId: busy.heldBySessionId,
              projectPath: busy.projectPath,
              locale,
              onJump: (sid) => { void get().switchAgentSession(sid); },
            });
          }
          return;
        }
        setPaused(null);
        set({ reviewResuming: false });
        // ── dogfood R2 #93（P0-2/P0-3，2026-08-28）：resume 终态收尾路由 ──
        //
        // P0-2 chapter_accept envelope → pendingPatch：resume 车道跑在 leader 工具调用生命周期外，
        // write_chapter 的 metadata field_patch 通道走不到（链完成只回 IPC 调用方，审核卡永不出现 →
        // 章节永不落盘）。shell #93 修复后 review 档（suggest/readonly 会话）不直落、envelope 留
        // summary 返 UI——此处 mirror leader 路径的 agentEvents field_patch 路由（field/action/data
        // 形态与 write-chapter.ts metadata 组装逐字段对齐），用户 PatchReview accept 后经
        // applyAgentFieldPatch → acceptChapterCandidateCore 落 chapters/（既有收口，无新持久化路径）。
        // chapterPersisted（auto 档 shell 已直落）→ 不 stage（防双写），toast 告知落盘去向。
        //
        // P0-3 链完成回报：resume 完成此前对用户零痕迹（leader 已在 pause 前终态、无回调机制，对话面
        // 静默）。最小侵入 = 完成卡落审核面（pendingPatch 即「写章完成 · 待审阅」面）+ toast 摘要
        // （routeDecision + 字数 + 下一步动作）。leader 回注机制不存在（write_chapter 工具调用已返回，
        // 无 runLoop 再入通道）——UI 卡是本轮拍板形态，记档待未来 leader 回注设计。
        const accept = summary.chapter_accept;
        if (accept && !summary.chapterPersisted) {
          get().setPendingPatch(sessionId, {
            runId: sessionId,
            createdAt: new Date().toISOString(),
            patches: [{
              field: 'chapter_candidate',
              action: 'set',
              data: {
                chapterId: accept.chapterId,
                runId: accept.runId,
                candidate: accept.candidate,
                ...(accept.storyDecisions && accept.storyDecisions.length > 0
                  ? { storyDecisions: accept.storyDecisions }
                  : {}),
              },
              // mirror agentEvents field_patch 路由对非 creative field 的取值（fieldMetadata 不跟踪
              // chapter_candidate → 恒 0+1；PatchReview 仅展示用）。
              fieldVersion: 1,
              generatedBy: 'write_chapter',
            }],
          });
          const titlePart = summary.draftTitle ? `《${summary.draftTitle}》` : `章节 ${accept.chapterId}`;
          const wordPart = summary.draftWordCount !== undefined ? `（${summary.draftWordCount} 字）` : '';
          useToastStore
            .getState()
            .showToast(
              summary.routeDecision?.decision === 'escalate_user'
                ? `写章完成：${titlePart}${wordPart}——灰区裁决：审阅卡 accept=接受为真相 / reject=改稿`
                : `写章完成：${titlePart}${wordPart}——章节候选待审阅后落盘`,
              'info',
            );
        } else if (summary.chapterPersisted) {
          const titlePart = summary.draftTitle ? `《${summary.draftTitle}》` : `章节 ${accept?.chapterId ?? ''}`;
          const wordPart = summary.draftWordCount !== undefined ? `（${summary.draftWordCount} 字）` : '';
          useToastStore
            .getState()
            .showToast(`写章完成：${titlePart}${wordPart}——已直接落盘 chapters/（全自动档）`, 'success');
        } else if (
          summary.status === 'completed' &&
          (summary.routeDecision?.decision === 'accept_as_truth' ||
            summary.routeDecision?.decision === 'escalate_user')
        ) {
          // accept/escalate 但无 envelope（skip：no-draft/no-chapter/no-nowiso——shell 已把 describeAcceptSkip
          // 细节附进 errors：accept 走既有 skip 文案 / review 档 escalate 走「灰区上发：无章节候选」文案；
          // check 补含 escalate 分支——否则 review 档 escalate 无候选时 shell 声称「UI 终态 toast 消费」
          // 实则零分支吃它 → 静默）→ toast 告知（不静默——用户须知道稿没落盘和为什么）。
          useToastStore
            .getState()
            .showToast(`写章完成但未生成章节候选：${summary.errors.join('; ')}`, 'error');
        }
        // Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺路由（shell applyStorySyncOnResume 产出——
        // suggest 档链段必 pause，终态提取只经 resume IPC 回 UI，write_chapter 的 metadata 路由走不到）。
        // storySyncReview（suggest/readonly 人审档）→ setPendingPatch 进 PatchReview（mirror
        // agentSessionSlice storySyncPatches 路由落点；creativeFieldsSlice merge 语义跨批不丢）；
        // storySyncLanded（auto 直落档）→ toast 告知（非静默——auto 落盘无 chat 行）。缺省零动作。
        if (summary.storySyncReview && summary.storySyncReview.patches.length > 0) {
          get().setPendingPatch(sessionId, {
            runId: sessionId,
            createdAt: new Date().toISOString(),
            patches: summary.storySyncReview.patches,
          });
          useToastStore
            .getState()
            .showToast(
              `正文反哺（${summary.storySyncReview.note}）：${summary.storySyncReview.patches.length} 个设定补丁待审阅`,
              'info',
            );
        } else if (summary.storySyncLanded && summary.storySyncLanded.fields.length > 0) {
          useToastStore
            .getState()
            .showToast(
              `正文反哺（${summary.storySyncLanded.note}）：${summary.storySyncLanded.fields.join('、')} 已自动落盘`,
              'success',
            );
        }
        // error summary（IPC Zod/路径校验失败 / loadProject 失败 / 链段跑崩）→ toast 告知（不静默）。
        if (summary.status === 'error' && summary.errors.length > 0) {
          useToastStore.getState().showToast(`链段续跑失败: ${summary.errors.join('; ')}`, 'error');
        }
      }
    } catch (err) {
      // CR-002：catch 路径同样复核项目未切——切了则静默丢弃（不 toast 老项目错误到新项目）。
      if (get().currentProject?.path !== projectPath) {
        set({ reviewResuming: false });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setPaused(null);
      set({ reviewResuming: false });
      useToastStore.getState().showToast(`链段续跑失败: ${msg}`, 'error');
    }
  }

  /**
   * Story 7.1 B1：调 closure:compile-revision-intent IPC 派 revision-optimizer 子 agent 编译意图。
   *
   * 范式判据（ADR-3）：意图编译归 LLM（IPC 内部 dispatch revision-optimizer 子 agent）；本函数只机械
   * 派发 + 状态和（compiledIntent / intentCompileError），不做语义判断。
   *
   * 项目隔离 + 重入 guard mirror runResume：await 期间切项目丢弃结果；intentCompiling=true 时 no-op
   * （防双触发）。
   */
  async function doCompileIntent(
    selectedPassage: string,
    userInstruction: string,
    selectionFrom: number,
    selectionTo: number,
    draftText: string,
    chapterContext?: string,
  ): Promise<void> {
    if (get().intentCompiling) return;
    const project = get().currentProject;
    const sessionId = get().agentSessionId;
    if (!project?.path || !sessionId) return;
    const projectPath = project.path;

    set({ intentCompiling: true, intentCompileError: null, compiledIntent: null });
    try {
      const result = await compileRevisionIntent({
        projectPath,
        sessionId,
        selectedPassage,
        userInstruction,
        selectionFrom,
        selectionTo,
        draftText,
        ...(chapterContext ? { chapterContext } : {}),
      });
      // CR-002 同款：await 后复核项目未切——切了则丢弃结果（新项目不该见老 compiledIntent）。
      if (get().currentProject?.path !== projectPath) {
        set({ intentCompiling: false });
        return;
      }
      if (result.intent) {
        set({ compiledIntent: result.intent, intentCompiling: false, intentCompileError: null });
      } else {
        // IPC 返 null intent（optimizer parse 失败 / dispatch 失败 / 无 invalid input）→ 落 error。
        // 不假信心、不静默 fail（mirror revision-optimizer graceful）。
        set({
          compiledIntent: null,
          intentCompiling: false,
          intentCompileError: result.error ?? '意图编译失败，请重述或手改',
        });
      }
    } catch (err) {
      if (get().currentProject?.path !== projectPath) {
        set({ intentCompiling: false });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      set({ compiledIntent: null, intentCompiling: false, intentCompileError: msg });
    }
  }

  return {
  pausedReviewBySession: {},
  reviewResuming: false,
  reviewSelection: null,
  compiledIntent: null,
  intentCompiling: false,
  intentCompileError: null,
  setPausedReview: (sessionId, meta) => set((s) => {
    if (!meta) {
      if (!(sessionId in s.pausedReviewBySession)) return s;
      const next = { ...s.pausedReviewBySession };
      delete next[sessionId];
      return { pausedReviewBySession: next };
    }
    return { pausedReviewBySession: { ...s.pausedReviewBySession, [sessionId]: meta } };
  }),
  clearPausedReviewFor: (sessionId) => set((s) => {
    if (!(sessionId in s.pausedReviewBySession)) return s;
    const next = { ...s.pausedReviewBySession };
    delete next[sessionId];
    return { pausedReviewBySession: next };
  }),
  setReviewSelection: (selection) => set({ reviewSelection: selection }),

    reviewContinue: () => {
      // BMad CR F5：plain continue/redo/abort 也清 B1 trigger 状态（避免下一 checkpoint pause 残留旧 intent 卡片
      // / 旧选区——stale anchor 指向已变 draft → splice 失败 silent，edge-005）。
      set({ compiledIntent: null, reviewSelection: null, intentCompileError: null });
      return runResume('continue');
    },
    reviewRedo: (feedback) => {
      set({ compiledIntent: null, reviewSelection: null, intentCompileError: null });
      return runResume('redo', feedback);
    },
    reviewAbort: () => {
      set({ compiledIntent: null, reviewSelection: null, intentCompileError: null });
      return runResume('abort');
    },

    compileIntent: (selectedPassage, userInstruction, selectionFrom, selectionTo, draftText, chapterContext) =>
      doCompileIntent(selectedPassage, userInstruction, selectionFrom, selectionTo, draftText, chapterContext),

    confirmRedoWithIntent: (intent) => {
      // BMad CR F6：guard first（runResume 内 reviewResuming 检查）then clear——若先 clear 再 guard，
      // guard 拒时（reviewResuming=true 重入）compiledIntent 已丢但 IPC 没发，用户确认的 intent 丢失。
      // runResume 内 set reviewResuming=true 原子保护；先调 runResume，clear 在其 guard 通过后由其内部
      // 流程推进（但 compiledIntent 须在 IPC 发出前清避下一 pause 残留——故 runResume 调用前 clear，
      // 但 runResume 内 guard 失败时 no-op 不发 IPC，此时 clear 已发生 = 用户 intent 丢失）。
      // 折中：本地 guard（同 runResume 逻辑）先查，通过才 clear + runResume。
      if (get().reviewResuming) return Promise.resolve();
      set({ compiledIntent: null, reviewSelection: null, intentCompileError: null });
      return runResume('redo', undefined, intent);
    },

    forceAcceptGuard: () => {
      // Story 7.2 art-mode：soft-violation 强行放行。redo + guardOverride（IPC 据 guardOverride 切
      // redo.nodeId=revision-guard-agent 重跑 guard splice）。同 confirmRedoWithIntent 的重入 guard 哲学。
      if (get().reviewResuming) return Promise.resolve();
      set({ compiledIntent: null, reviewSelection: null, intentCompileError: null });
      return runResume('redo', undefined, undefined, 'force-accept');
    },

    clearCompiledIntent: () => set({ compiledIntent: null, intentCompileError: null }),
  };
};
