import { randomUUID } from 'node:crypto';
import type {
  ChainNodeDef,
  CheckpointStage,
  RunChainDeps,
  RunChainOptions,
  RunSnapshot,
  RunSnapshotSummary,
} from '../contracts/run';
import { ChainAbortedError } from '../contracts/run';
import { logger } from '../logger';
import type { ArcBeat, EscalateFinding, NovelStorySyncPayload } from '@orison/shared-contracts';
import { arcBeatSchema, archiveIssueSchema, compileReportSchema, researchSuspensionSchema, storyTimeDriftWarningSchema, REVIEW_ATTRIBUTION_VALUES } from '@orison/shared-contracts';

// ── Story 4.0 写章战术链段：runChain 驱动器（design §4.1 / implement.md 4.2/4.3）──
//
// runChain = subgraph 战术层执行器（ADR-17 两层分层）：顺序驱动 ChainNodeDef[] 节点，经 RunSnapshot.artifacts
// 流转 artifact，挂三类 checkpoint（brief/draft/verdict），route 节点判 route_decision 后驱动 revision 闭环
// （auto_revise → 重跑 from→through 切片，上限 cap，超限升级 escalate_user）。
//
// **不升一等概念**（spec line 126）：4.0 用简单顺序驱动 + 一个声明式 revisionLoop，不建完整图引擎。
// 证明比裸 subgraph 好后再升。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：runChain 本身是纯代码编排（机械分派），
// 不做语义判断——route_decision 归 LLM（route 节点）判，runChain 只机械执行 LLM 判定（分派 auto_revise/
// accept/escalate）。brief 编译节点的 #6 汇编也是纯代码（别处）。
//
// context isolation（ADR-17）：runChain 返完整 RunSnapshot，但 runChapterChain（Step 5）只把
// summarizeRunSnapshot(snapshot) 回给 leader（不灌内部 trace）。
//
// expected_downstream_consumers:
// - Story 4.0 Step 5：runChapterChain（workflow.ts）dispatchSubagent complete 回调调 runChain。
// - Story 4.3：onCheckpoint 扩 pause 行为（半自动模式配置）。
// - Story 4.1/4.2/4.5/6.6：节点升级 / 新节点接入（链段装配 Step 5 加 ChainNodeDef）。

/**
 * 顺序驱动链段节点（design §4.1）。
 *
 * 流程：
 * 1. 初始化 RunSnapshot（artifacts = initialArtifacts 浅拷贝；pendingNodes = chain ids 减 resumed）。
 * 2. （resume）跳过 resumedCompletedNodes 中的节点（initialArtifacts 须含其产出）。
 * 3. 顺序跑每节点：
 *    - abort 预检：signal.aborted → status='aborted' + onCheckpoint 持久 + 抛 ChainAbortedError。
 *    - DAG 依赖检查：contract.requiredArtifactKeys 缺失 → status='blocked' + errors 记录 + break。
 *    - node.run({run, requirement}) → {stateKey, artifact}。
 *    - error artifact 检查（artifact.error===true，Step 2 flag）→ status='error' + errors 记录 + break（链段不崩）。
 *    - 写 run.artifacts[stateKey]=artifact + completedNodes 记录。
 *    - checkpoint stage（brief/draft，以及非 through 节点的 verdict）→ **await** onCheckpoint(stage, run)；
 *      返 {action:'pause'} → status='paused' + currentNodeId 停该 checkpoint 节点 + break（design §3.2 / §2 Option A，Story 4.3）。
 *      **through 节点的 verdict checkpoint 不在此 fire**——改在下方终态处理后（CR-08-02-autonomy-modes-001，
 *      防 readonly 模式 verdict pause 抢断 route 终态处理致 silent data loss）。
 *    - revisionLoop 检查 + route 终态处理（仅 through 节点）：见下方 revision 闭环段。
 *
 * revision 闭环（design §4.1 / ADR-17 evaluator-optimizer）：
 * - through 节点（route）产出 route_decision 后判定：
 *   - **Story 7.4 候选④**：auto_revise 且 revisionCount < cap → persist snapshot + break 出主循环
 *     （status='auto_revise_pending'），交 leader（writeChapterTool）驱动 redo：revision-optimizer 编译
 *     RevisionIntent → redo 闭环四节点（draft-writer 段落级 + revision-guard 护栏 + multi-review 再审 + route 再判）。
 *     不再 chainRunner loopFromIdx 裸跑 targeted-revision（旧 7.3 状态）。**不 fire verdict checkpoint pause**
 *     （persist-only：onCheckpoint('verdict') 调用但 pause 决策忽略——auto_revise 非终态，CR-08-02-autonomy-modes-001）。
 *   - auto_revise 且 revisionCount >= cap（**cap=0 即触发**，单 runChain 内 cap 防御；正常 redo 循环 cap 在 leader）→
 *     强制 escalate_user（防死循环），落进终态处理。
 *   - accept_as_truth / escalate_user / cap-escalate（终态）→ 先 onAccept 产 chapter_accept（4.1/4.6 D4），
 *     **然后** fire verdict checkpoint（CR-08-02-autonomy-modes-001：终态处理后；pause 抢断 complete，
 *     chapter_accept 已产 → resume-continue 候选在）；onCheckpoint 返 continue / 无 → status='completed' + break。
 * - 切片约束：loopFromIdx <= loopThroughIdx（Step 5 装配按此排节点序；违反 → 启动时抛 config error）。
 *
 * abort/resume（design §4.1 / §4.6）：
 * - abort：signal.aborted → status='aborted' + onCheckpoint(lastStage, run)（让 Step 5 持久 chainSnapshot）
 *   + 抛 ChainAbortedError（携 snapshot，runChapterChain catch 后可读 .snapshot）。
 * - resume：resumedCompletedNodes 跳过已完成节点（节点重跑须 idempotent——LLM 节点重跑产出可能不同，4.0 接受）。
 *   4.0 in-memory 持久（resume 跨 abort 不跨进程重启）；disk 持久 follow-up（design §4.6 记档）。
 */
export async function runChain(opts: RunChainOptions, deps: RunChainDeps): Promise<RunSnapshot> {
  const { chain, initialArtifacts, requirement } = opts;

  // ── revisionLoop 索引校验（启动时一次）──
  let loopFromIdx = -1;
  let loopThroughIdx = -1;
  if (opts.revisionLoop) {
    loopFromIdx = chain.findIndex((c) => c.id === opts.revisionLoop!.from);
    loopThroughIdx = chain.findIndex((c) => c.id === opts.revisionLoop!.through);
    if (loopFromIdx < 0 || loopThroughIdx < 0) {
      throw new Error(
        `runChain: revisionLoop.from("${opts.revisionLoop.from}") or .through("${opts.revisionLoop.through}") not found in chain`,
      );
    }
    if (loopFromIdx > loopThroughIdx) {
      throw new Error(
        `runChain: revisionLoop.from index (${loopFromIdx}) must be <= through index (${loopThroughIdx}); re-order chain so the loop body is a contiguous forward slice`,
      );
    }
    if (opts.revisionLoop.cap < 0) {
      throw new Error(`runChain: revisionLoop.cap must be >= 0 (got ${opts.revisionLoop.cap})`);
    }
  }

  const completedSet = new Set<string>(opts.resumedCompletedNodes ?? []);

  const run: RunSnapshot = {
    runId: randomUUID(),
    status: 'running',
    currentNodeId: null,
    projectPath: deps.sessionContext.projectPath,
    completedNodes: [...completedSet],
    pendingNodes: chain.map((c) => c.id).filter((id) => !completedSet.has(id)),
    artifacts: { ...initialArtifacts },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
  };

  let lastCheckpointStage: CheckpointStage | undefined;

  // abort 预检（signal 已 abort，如 resume 一个被取消的链段）
  if (deps.signal.aborted) {
    run.status = 'aborted';
    emitAbortCheckpoint(run, lastCheckpointStage, opts, deps.sessionContext.id);
    throw new ChainAbortedError(run);
  }

  let pointer = 0;
  let revisionCount = 0;
  // resume：跳过已完成节点
  while (pointer < chain.length && completedSet.has(chain[pointer].id)) pointer++;

  while (pointer < chain.length) {
    // abort 中途检查（每节点前）
    if (deps.signal.aborted) {
      run.status = 'aborted';
      emitAbortCheckpoint(run, lastCheckpointStage, opts, deps.sessionContext.id);
      throw new ChainAbortedError(run);
    }

    const def = chain[pointer];
    run.currentNodeId = def.id;

    // ── DAG 依赖检查（requiredArtifactKeys 缺失 → blocked + break）──
    const required = def.node.contract?.requiredArtifactKeys ?? [];
    const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(run.artifacts, k));
    if (missing.length > 0) {
      run.status = 'blocked';
      pushError(run, `node "${def.id}" blocked: missing required artifacts [${missing.join(', ')}]`);
      // dogfood T1 Stage 6：blocked 也是该节点的终态（UI 步进条 errorNode 呈现）。
      opts.onNodeDone?.(def.id, 'blocked');
      break;
    }

    // ── 跑节点（CR-6：节点 sync throw 防御——非 AbortError → synthesize error artifact，统一走下方
    //    error-artifact 簿记路径，链段不崩）──
    let result: { stateKey: string; artifact: unknown };
    try {
      result = await def.node.run({ run, requirement });
    } catch (err) {
      // abort（节点内部取消，如 generate 被 signal abort）→ 走统一 abort 路径（status='aborted' +
      // onCheckpoint 持久 + ChainAbortedError，与 signal.aborted 预检一致——runChapterChain catch 后返 aborted summary）
      if (isAbortError(err)) {
        run.status = 'aborted';
        emitAbortCheckpoint(run, lastCheckpointStage, opts, deps.sessionContext.id);
        throw new ChainAbortedError(run);
      }
      const msg = err instanceof Error ? err.message : String(err);
      // synthesize error artifact（用节点 producedArtifactKeys[0] 或 def.id 作 stateKey）；不在此 pushError，
      // 让下方 isErrorArtifact 路径统一簿记一次（避免 throw + error-artifact 双记）。
      const errorStateKey = def.node.contract?.producedArtifactKeys?.[0] ?? def.id;
      result = {
        stateKey: errorStateKey,
        artifact: { error: true, nodeId: def.id, message: `threw: ${msg}` },
      };
    }

    // ── error artifact 检查（createLlmNode 兜底产出 / brief-compiler safeParse 失败 / CR-6 throw synthesize）──
    // artifact.error===true → 链段不崩，status='error' + 单条 errors 记录 + break。
    if (isErrorArtifact(result.artifact)) {
      run.artifacts[result.stateKey] = result.artifact;
      run.status = 'error';
      const msg = (result.artifact as { message?: string }).message ?? 'unknown error';
      pushError(run, `node "${def.id}" error: ${msg}`);
      // dogfood T1 Stage 6：error artifact 也是该节点的终态（throw 合成路径同走此处）。
      opts.onNodeDone?.(def.id, 'error');
      break;
    }

    // ── 写 artifact + completedNodes（去重，闭环重跑不重复 push）──
    run.artifacts[result.stateKey] = result.artifact;
    if (!completedSet.has(def.id)) {
      completedSet.add(def.id);
      run.completedNodes.push(def.id);
    }
    run.pendingNodes = run.pendingNodes.filter((id) => id !== def.id);
    // dogfood T1 Stage 6：节点成功边界（artifact 写入 + completedNodes 记录后、checkpoint staging 前）
    // fire 步进回调——每个节点都 fire（非仅 checkpoint 节点），UI 步进条数据源。
    opts.onNodeDone?.(def.id, 'done');

    // ── checkpoint staging（brief/draft，以及非 through 节点的 verdict；design §4.6 / CR-13 显式声明）──
    // CR-13：用 def.checkpointStage 显式声明（取代 nodeId 子串推断——子串匹配脆弱，未来节点 id 含
    // 'brief'/'draft'/'route' 子串会假触发）。链装配（chapter-chain.ts）按 design §4.6 标注；mock 链
    // 测试在 ChainNodeDef 上声明 checkpointStage。
    //
    // Story 4.3 Step 2（design §3.2 D2）：onCheckpoint 升 async 返 CheckpointDecision。返 {action:'pause'}
    // → status='paused' + currentNodeId 停该 checkpoint 节点（已在 :124 设）+ break + 返 snapshot
    // （runChapterChain 检测 paused summary → 交还 leader → 人响应后 resume 续跑，CR-2 读回 chainSnapshot
    // 跳过已完成节点，idempotent ADR-17）。返 {action:'continue'} / 无 onCheckpoint → 续跑（全自动零回归 = 4.0）。
    // 范式判据（ADR-3）：pause 决策纯代码机械判（policy.pauseStages.includes），非 LLM 语义判断。
    //
    // CR-08-02-autonomy-modes-001（critical，三 reviewer 独立确认）：through 节点（route-agent）的 verdict
    // checkpoint **不在此通用 staging 触发**——改在下方 revision 闭环段「终态处理后」fire。否则 readonly（微操）
    // 模式 route 返任何决策时 verdict pause 在终态处理前抢先 break → onAccept 产 chapter_accept / auto_revise
    // 触发 revision loop / escalate findings+裁决器 永不执行 → resume-continue 时 route 在 completedNodes 前缀
    // 跳过 → 终态永不补跑 → silent data loss（accept 候选丢 / revision 改稿丢 / escalate 裁决丢）。非 through
    // 节点的 verdict（无 revisionLoop 场景，如 mock 链测试）仍在此 fire（零回归）。
    const stage = def.checkpointStage;
    const isThroughNode = Boolean(opts.revisionLoop) && pointer === loopThroughIdx;
    if (stage && !(stage === 'verdict' && isThroughNode)) {
      lastCheckpointStage = stage;
      const decision = opts.onCheckpoint ? await opts.onCheckpoint(stage, run) : undefined;
      if (decision?.action === 'pause') {
        run.status = 'paused';
        break;
      }
    }

    // ── revision 闭环检查 + route 终态处理（仅 through 节点）──
    if (isThroughNode) {
      let effectiveDecision = readRouteDecision(result.artifact);

      // auto_revise 闭环（非终态）：**Story 7.4 候选④**——不再 chainRunner loopFromIdx 裸跑 targeted-revision，
      // 改 break 出主循环交 leader（writeChapterTool）驱动 redo：revision-optimizer 编译 RevisionIntent
      // （A-trigger audit-finding）→ runChapterChain redo 闭环四节点（draft-writer 段落级重写 + revision-guard
      // 护栏 + multi-review 再审 + route 再判）。cap 内 → persist snapshot + break（status='auto_revise_pending'，
      // routeDecision 携带 auto_revise）；cap 超限 → 强制 escalate_user（ADR-17 超限升级防死循环，既有路径不变）。
      //
      // **persist before break**（load-bearing）：redo resume 读 chainSnapshot 推 resumedCompletedNodes。chain段
      // [3..13]（world-extractor×5 / world-merge / emotion-verify / promise-emergence / storySync /
      // targeted-revision / multi-review）无 checkpointStage → 若不 persist，snapshot 停在 revision-guard(idx2)
      // 只含 [0..2]，redo resume 会重跑 world-extractor 3-7（昂贵 + 语义错：world-state 写后不应重抽）。故 break
      // 前经 onCheckpoint('verdict') 触发 persistChainSnapshot（workflow.ts onCheckpoint 闭包 persist 副作用）。
      // **pause 决策忽略**：auto_revise 非终态（CR-08-02-autonomy-modes-001），break 给 leader 驱动 redo；
      // readonly 模式 RevisionIntent 人确认关在 leader 侧（非 verdict checkpoint pause）。
      if (effectiveDecision === 'auto_revise') {
        if (revisionCount < opts.revisionLoop!.cap) {
          revisionCount += 1;
          lastCheckpointStage = 'verdict';
          if (opts.onCheckpoint) {
            // await 确保 persist 完成（persistChainSnapshot 同步，但守 await 契约）；decision 忽略（auto_revise
            // 非终态 break，不论 readonly verdict pauseStages——防 auto_revise pause 抢断 leader redo 驱动）。
            await opts.onCheckpoint('verdict', run);
          }
          run.status = 'auto_revise_pending';
          break;
        }
        // cap 超限 → 强制 escalate_user（ADR-17「超限升级」防死循环），落进下方终态处理。
        run.artifacts['route_decision'] = {
          decision: 'escalate_user',
          reason: `revision loop cap (${opts.revisionLoop!.cap}) reached; escalating to user`,
        };
        pushError(
          run,
          `revision loop cap (${opts.revisionLoop!.cap}) reached at "${def.id}"; forced escalate_user`,
        );
        effectiveDecision = 'escalate_user';
      }

      // ── 终态分支（accept_as_truth / escalate_user / cap-escalate）──
      // 4.1 Step 4（CR-15b）：route=accept_as_truth 时调 onAccept 产 chapter_accept artifact（不写盘）。
      // onAccept 由入口层提供（闭包捕获 project 数据做 chapterId 解析）；返回 ChapterAcceptArtifact（含
      // chapterId）→ 写 artifacts['chapter_accept']；返回 ChapterAcceptSkip（含 skipReason：no-draft/
      // no-chapter/no-nowiso，CR-4.1-08 区分失败模式）→ 不写 chapter_accept（accept 持久化阻断，入口层
      // 据闭包捕获的 skipReason 出对应文案，非旧纯 undefined 合并误导）。返回 undefined（4.0 既有 / 闭包
      // 未实现 skipReason）→ 同样不写。
      //
      // Story 4.6 D4 v2（CR-Edge-1/2 patch）：escalate 去掉 hasDraftText 门——accept_as_truth 或 escalate_user
      // 都调 onAccept，让 buildChapterAccept 单源判 draft（返 skipReason:'no-draft' 若空，入口层 acceptSkipReason
      // 闭包捕获，文案准确，修 CR-Edge-2「escalate-no-draft 误诊 no-chapter」）。cap-exceeded escalate 对称调
      // onAccept（修 CR-Edge-1「cap-exceeded 不对称」）。chapter_accept 候选语义不变（PatchReview accept 才落盘/登记）。
      if (
        (effectiveDecision === 'accept_as_truth' || effectiveDecision === 'escalate_user') &&
        opts.onAccept
      ) {
        const acceptResult = opts.onAccept(run, { nowISO: opts.nowISO ?? '' });
        if (acceptResult && 'chapterId' in acceptResult) {
          run.artifacts['chapter_accept'] = acceptResult;
        }
      }

      // ── verdict checkpoint（终态处理后 fire，CR-08-02-autonomy-modes-001）──
      // chapter_accept 已产（accept/escalate 路径，onAccept 在此之前调）/ escalate findings 已在 review artifact
      // （escalate 路径，summarizeRunSnapshot 抽）。readonly/suggest（pauseStages 含 verdict）→ pause 抢断 complete：
      // status='paused' + break（chapter_accept 在 run.artifacts，onCheckpoint 闘包先 persist chainSnapshot →
      // resume-continue 时 route 在 completedNodes 前缀跳过 → 链段无剩节点 → complete，候选在 summary 可落盘）。
      // 全自动（pauseStages=[] / 不含 verdict）→ onCheckpoint 返 continue → 落进 status='completed'。
      // 无 onCheckpoint（4.0 既有 / 测试）→ 不 pause，落进 status='completed'。无 checkpointStage='verdict' 声明 → 跳过。
      if (def.checkpointStage === 'verdict') {
        lastCheckpointStage = 'verdict';
        const verdictDecision = opts.onCheckpoint
          ? await opts.onCheckpoint('verdict', run)
          : undefined;
        if (verdictDecision?.action === 'pause') {
          run.status = 'paused';
          break;
        }
      }
      run.status = 'completed';
      break;
    }

    pointer += 1;
  }

  // Story 4.3 Step 2：pause 退出——保留 currentNodeId 在 checkpoint 节点（runChapterChain 据此经 chain 解析
  // pausedStage 填 summary，resume 据 completedNodes 续跑）。不 null（与 completed/aborted 区分：paused 链段
  // 仍「在」该节点 checkpoint 等人响应）。design §3.2 / §2 Option A。
  //
  // Story 7.4：auto_revise_pending 退出——同理保留 currentNodeId（停在 route 节点，leader 据此知链段在
  // route 判 auto_revise 后 break，待 redo）。不 null（与 completed/aborted 区分；routeDecision 携带 auto_revise）。
  if (run.status === 'paused' || run.status === 'auto_revise_pending') {
    return run;
  }

  // 跑完所有节点未触 route 终止 → 正常完成
  if (run.status === 'running') {
    run.status = 'completed';
  }
  run.currentNodeId = null;
  return run;
}

/**
 * 抽 RunSnapshot 摘要（context isolation，design §4.3 / ADR-17）。
 *
 * **只抽** {status, routeDecision, reviewVerdict, draftTitle/wordCount/text, errors, paused payload}——**不抽内部 trace /
 * 全量 artifacts**（防 leader 长程上下文爆炸）。runChapterChain（Step 5）只把此 summary 回给 leader。
 *
 * CR-15a 落地公理：`draftText`（初稿/修订稿正文）**是 deliverable 非 internal trace**——读者/dogfood
 * 须能检视产出正文（[[project-prose-landing-axiom]]），故 prose 豁免 context isolation。reviewer 原 wording
 * 「摘要剥 text 是把 deliverable 隔掉了」修正：剥内部 trace（scene_graph/chapter_brief/story.sync），
 * 不剥正文。持久化正文到 chapter .md（CR-15b）defer 4.1/chapter-integration。
 *
 * CR-3：删 revision.output 死 fallback——targeted-revision 节点 overwrite draft.initial（design §4 决断），
 * 链段不再产 revision.output artifact；旧 fallback 是 dormant 遗留（STATE_KEY_MAP 的 'revision.output'
 * 是 legacy DEFAULT_CHAIN 映射，链段用节点契约 producedArtifactKeys，见 registry.ts 注释）。
 *
 * Story 4.3 Step 2（design §3.4）：`status='paused'` 时抽 pause-review payload——`pausedStage`（从 pauseHint
 * 传入；summarize 无 chain 上下文，runChapterChain 持 chain 据 currentNodeId 经 checkpointStage 解析后透传，
 * honors「从 currentNodeId/checkpointStage 推」）+ `draftContent`（draft checkpoint 的正文，豁免 isolation 同
 * CR-15a）+ `briefContent`（brief checkpoint 的 chapter_brief）。非 paused 缺省（零回归）。
 *
 * @param pauseHint Story 4.3：paused summary 的 pausedStage 来源（runChapterChain 解析；缺省 → pausedStage
 *   undefined，仍产 draftContent/briefContent 若 artifact 在）。
 */
export function summarizeRunSnapshot(
  snapshot: RunSnapshot,
  pauseHint?: { pausedStage?: CheckpointStage },
): RunSnapshotSummary {
  const routeDecision = recordOf(snapshot.artifacts['route_decision']) as
    | { decision?: string; reason?: string; deviation?: boolean }
    | undefined;
  const review = recordOf(snapshot.artifacts['review.latest']);
  const draft = recordOf(snapshot.artifacts['draft.initial']);
  // 4.1 Step 4（CR-15b）：chapter_accept = accept 持久化载荷（onAccept 产，design §3.5）。deliverable 非 trace，
  // 同 draftText 豁免 context isolation——入口层（IPC/leader）据此持久化 chapters/*.md + project.yaml。
  const chapterAccept = snapshot.artifacts['chapter_accept'];

  const summary: RunSnapshotSummary = {
    status: snapshot.status,
    routeDecision:
      routeDecision?.decision !== undefined
        ? {
            decision: routeDecision.decision,
            reason: routeDecision.reason ?? '',
            // dogfood R2 #107 / R1.1c：deviation 投影——no-chapter 自动建章时入口层补产
            // storyDecisions 需要（buildAcceptStoryDecisions 单源；修前 summary 只有 decision+reason，
            // 补产只能静默降级不登记——用户拍板不降级）。只在 true 时带（false/缺省省略，零噪音）。
            ...(routeDecision.deviation === true ? { deviation: true } : {}),
          }
        : undefined,
    reviewVerdict: typeof review?.verdict === 'string' ? review.verdict : undefined,
    draftTitle: typeof draft?.title === 'string' ? draft.title : undefined,
    draftWordCount: typeof draft?.wordCount === 'number' ? draft.wordCount : undefined,
    draftText: typeof draft?.text === 'string' ? draft.text : undefined,
    errors: snapshot.errors ?? [],
  };
  if (chapterAccept && typeof chapterAccept === 'object' && !Array.isArray(chapterAccept)) {
    summary.chapter_accept = chapterAccept as RunSnapshotSummary['chapter_accept'];
  }
  // Story 4.6：route=escalate_user 时抽 Reader-Audit 灰区 findings grounding（quote/location/severity），
  // 供裁决器子 agent 初审 + 用户裁决。escalateFindings 是「用户裁决所需 deliverable」同 draftText/chapter_accept
  // 豁免 context isolation（非内部 trace）。非 escalate 缺省。
  if (routeDecision?.decision === 'escalate_user') {
    const escalateFindings = extractEscalateFindings(review);
    if (escalateFindings) summary.escalateFindings = escalateFindings;
  }
  // Story 7.4：route=auto_revise 时抽 Reader-Audit findings（leader write_chapter 据此调 revision-optimizer
  // 编译 RevisionIntent A-trigger audit-finding source）。复用 extractEscalateFindings 抽取逻辑（过滤 block/warn
  // drop info + grounding 硬要求），独立字段 autoReviseFindings（零回归 escalateFindings 语义/消费者不变）。
  // auto_revise 是 deliverable 非 internal trace（同 escalateFindings 豁免 context isolation）。
  if (routeDecision?.decision === 'auto_revise') {
    const autoReviseFindings = extractEscalateFindings(review);
    if (autoReviseFindings) summary.autoReviseFindings = autoReviseFindings;
  }
  // Story 2.2 WP-E：route 终态（accept_as_truth / escalate_user）抽 story.sync 反哺 patches——deliverable
  // 非 internal trace（同 chapter_accept/escalateFindings 豁免 context isolation），write_chapter applier
  // 据此转 story_sync_apply 落盘。**空 patches 不抽**（零痕迹，summary 不带空载荷）；auto_revise 中间轮
  // 不抽（非终态——提取每轮都发生但只有终轮的供反哺，中间轮只喂链内 multi-review 连续性记忆）。
  // 抽取是纯机械投影（field 过滤归 applier 的安全门），不判「这条 patch 该不该收」。
  if (
    (routeDecision?.decision === 'accept_as_truth' || routeDecision?.decision === 'escalate_user')
  ) {
    const storySync = recordOf(snapshot.artifacts['story.sync']);
    if (
      storySync &&
      Array.isArray(storySync.patches) &&
      storySync.patches.length > 0 &&
      typeof storySync.summary === 'string' &&
      storySync.summary.length > 0
    ) {
      summary.storySync = {
        runId: typeof storySync.runId === 'string' ? storySync.runId : snapshot.runId,
        chapterId: typeof storySync.chapterId === 'string' ? storySync.chapterId : '',
        summary: storySync.summary,
        patches: storySync.patches as NovelStorySyncPayload['patches'],
      };
    }
  }
  // Story 8.2：本章写时声明的弧节拍透传（源 artifacts['arc_emergence'].beats，arc-emergence-node 产）。
  // deliverable 非 internal trace（同 escalateFindings 豁免 context isolation）——write_chapter post-settle
  // 据此做关口判定（detectVolumeClosure：卷弧 close beat → arc-audit-agent 大审）。**恒设**（含空数组——
  // dispatch prompt 契约「无则空数组」：零节拍是停滞检测要看见的信号非零痕迹）；artifact 缺（旧链 /
  // bypass 路径）→ 空数组。逐条 arcBeatSchema safeParse 守性（坏条目丢好条目留，mirror per-element 哲学）。
  {
    const arcEmergence = recordOf(snapshot.artifacts['arc_emergence']) as { beats?: unknown } | undefined;
    const rawBeats = arcEmergence && Array.isArray(arcEmergence.beats) ? arcEmergence.beats : [];
    const beats: ArcBeat[] = rawBeats.flatMap((b) => {
      const parsed = arcBeatSchema.safeParse(b);
      return parsed.success ? [parsed.data] : [];
    });
    summary.arcEmergenceBeats = beats;
  }
  // Story 8.4 Step 3（A7 档案议题通道）：出发核查 verdict 的 archive_issues 透传（设定卡过时/矛盾——
  // deliverable 非 internal trace，同 escalateFindings 豁免 context isolation；write_chapter output 呈现
  // 给 leader/用户对话解决）。逐条 archiveIssueSchema safeParse 守性（坏条目丢好条目留，mirror
  // arcEmergenceBeats per-element 哲学）；空/缺不抽（零痕迹）。
  {
    const researchBrief = recordOf(snapshot.artifacts['research_brief']) as
      | { verdict?: { archive_issues?: unknown } }
      | undefined;
    const rawIssues =
      researchBrief?.verdict && Array.isArray(researchBrief.verdict.archive_issues)
        ? researchBrief.verdict.archive_issues
        : [];
    const archiveIssues = rawIssues.flatMap((i) => {
      const parsed = archiveIssueSchema.safeParse(i);
      return parsed.success ? [parsed.data] : [];
    });
    if (archiveIssues.length > 0) summary.archiveIssues = archiveIssues;
  }
  // Story 8.4 C2（design §3.3）：storyTime 漂移 warning 透传（源 artifacts['storytime_drift'].warnings，
  // storytime-drift-node 产——chapter-summary 链位旁守卫；mirror archiveIssues 透传形态：deliverable 非
  // internal trace，write_chapter 文案行呈现进 3.3 校验议题通道）。逐条 storyTimeDriftWarningSchema
  // safeParse 守性（坏条目丢好条目留，mirror arcEmergenceBeats per-element 哲学）；空/缺不抽（零噪音）。
  {
    const drift = recordOf(snapshot.artifacts['storytime_drift']) as { warnings?: unknown } | undefined;
    const rawWarnings = drift !== undefined && Array.isArray(drift.warnings) ? drift.warnings : [];
    const driftWarnings = rawWarnings.flatMap((w) => {
      const parsed = storyTimeDriftWarningSchema.safeParse(w);
      return parsed.success ? [parsed.data] : [];
    });
    if (driftWarnings.length > 0) summary.driftWarnings = driftWarnings;
  }
  // Story 8.4 B1（design §2.1）：热层编译报告透出（源 artifacts['compile_report']，brief-compiler-node
  // 汇总点产；mirror 章摘要 tokenEstimate 先例——观测 deliverable 豁免 context isolation）。safeParse 守形
  // （坏形态防御性丢，mirror researchSuspension 抽取模式）；artifact 缺（旧链 / bypass 路径）→ 缺省零痕迹。
  {
    const rawReport = recordOf(snapshot.artifacts['compile_report']);
    if (rawReport !== undefined) {
      const parsedReport = compileReportSchema.safeParse(rawReport);
      if (parsedReport.success) summary.compileReport = parsedReport.data;
    }
  }
  // Story 4.3 Step 2（design §3.4）：paused summary 抽 pause-review payload。draftContent/briefContent 豁免
  // context isolation（同 CR-15a prose / 4.6 escalateFindings 是 deliverable 非 internal trace）。draftContent
  // 源 draft.initial.text（同 draftText 源，仅 paused 时作 review 载荷抽）；briefContent 源 chapter_brief artifact。
  if (snapshot.status === 'paused') {
    summary.pausedStage = pauseHint?.pausedStage;
    if (typeof draft?.text === 'string') summary.draftContent = draft.text;
    const briefArtifact = snapshot.artifacts['chapter_brief'];
    if (briefArtifact !== undefined) summary.briefContent = briefArtifact;
    // Story 7.2：revision-guard pause（soft-violation）抽 revision_guard artifact 作 art-mode 卡载荷。
    // deliverable 非 trace（同 draftContent/escalateFindings 豁免 context isolation）。pausedStage 非
    // revision-guard 时 revision_guard 可能在（clean/skipped）但不作 pause 载荷抽（仅 soft-violation pause 才需）。
    if (pauseHint?.pausedStage === 'revision-guard') {
      const guardArtifact = snapshot.artifacts['revision_guard'];
      if (guardArtifact && typeof guardArtifact === 'object' && !Array.isArray(guardArtifact)) {
        summary.revisionGuard = guardArtifact as RunSnapshotSummary['revisionGuard'];
      }
    }
    // Story 8.4 Step 4（A8）：出发核查挂起 pause 抽挂起载荷（矛盾/偏离明细或缺漏清单——用户决断所需
    // 证据，deliverable 豁免 context isolation 同 escalateFindings）。safeParse 守形（载荷由 writer-node
    // 机械构造，坏形态防御性丢——status 仍 paused，文案退 draft 通用 pause；挂起 ≠ 错误，errors 不计）。
    {
      const research = recordOf(snapshot.artifacts['research_brief']) as
        | { suspended?: unknown }
        | undefined;
      if (research?.suspended !== undefined) {
        const parsed = researchSuspensionSchema.safeParse(research.suspended);
        if (parsed.success) summary.researchSuspension = parsed.data;
      }
    }
  }
  return summary;
}

/**
 * Story 4.3 Step 2：从链定义解析某节点 id 的 checkpointStage（runChapterChain 检测 status='paused' 后，据
 * snapshot.currentNodeId（停在 checkpoint 节点）经 chain 映射出 pausedStage，传给 summarizeRunSnapshot 作
 * pauseHint）。
 *
 * honors design §3.4「pausedStage 从 currentNodeId/checkpointStage 推」——summarize 无 chain 上下文，故
 * runChapterChain（持 chain）解析后以 pauseHint 传值（不耦合 summarize 到具体节点 id 子串，守 CR-13 精神）。
 * 无匹配 / 节点无 checkpointStage → undefined（defensive：pause 只在 checkpoint 节点触发，正常必有匹配）。
 */
export function resolveCheckpointStage(
  chain: ChainNodeDef[],
  nodeId: string | null,
): CheckpointStage | undefined {
  if (!nodeId) return undefined;
  return chain.find((c) => c.id === nodeId)?.checkpointStage;
}

// ── helpers ──

/** error artifact 判定（Step 2 createLlmNode 兜底产出 {error:true,...}；链段不崩，标记 + break）。 */
function isErrorArtifact(artifact: unknown): boolean {
  return Boolean(artifact && typeof artifact === 'object' && (artifact as { error?: unknown }).error === true);
}

/** AbortError 判定（节点内部取消传播；mirror createLlmNode.isAbortError）。 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError';
}

/** 从 route 节点产出读 decision（route_decision artifact shape: {decision, reason}）。 */
function readRouteDecision(artifact: unknown): string | undefined {
  const rec = recordOf(artifact);
  return typeof rec?.decision === 'string' ? rec.decision : undefined;
}

/** 安全取 record（过滤非对象/数组）。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Story 4.6：route=escalate_user 时从 Reader-Audit `review.latest.dimensions[].findings` 抽灰区 findings。
 *
 * 过滤 severity=block|warn（drop info 噪声——info 非灰区不需裁决器/用户关注）+ grounding 硬要求（quote/
 * location/explanation 缺则跳过，mirror reviewOutputSchema .min(1)）+ 控量 ≤8（防裁决器 prompt 爆）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：纯机械投影（过滤 + 字段抽取），不判「finding 多严重」
 * （归裁决器 LLM）。
 *
 * Story 8.4 Step 6（A11）：attribution 三态（审核对照归因）随字段透传——裁决器/用户判「正文 vs 计划哪个好」
 * 需知问题出在哪层（执行漏可改稿 / 规划盲需补查 / 计划层缺口须改上游）。枚举单源 shared
 * REVIEW_ATTRIBUTION_VALUES（值外字面量机械丢弃不透传——下游 EscalateFinding type 即契约）。
 */
function extractEscalateFindings(reviewArt: unknown): EscalateFinding[] | undefined {
  const review = recordOf(reviewArt);
  if (!review || !Array.isArray(review.dimensions)) return undefined;
  const findings: EscalateFinding[] = [];
  for (const dim of review.dimensions) {
    const d = recordOf(dim);
    if (!d || !Array.isArray(d.findings)) continue;
    for (const f of d.findings) {
      const finding = recordOf(f);
      if (!finding) continue;
      const severity = finding.severity;
      if (severity !== 'block' && severity !== 'warn') continue; // drop info 噪声
      const quote = typeof finding.quote === 'string' ? finding.quote : '';
      const location = typeof finding.location === 'string' ? finding.location : '';
      const explanation = typeof finding.explanation === 'string' ? finding.explanation : '';
      if (!quote || !location || !explanation) continue; // grounding 硬要求（CR-Edge-6：quote/location/explanation 空串均跳过——reviewOutputSchema 对 explanation 无 .min(1)，抽取严于 schema 是有意的 grounding 要求）
      if (findings.length >= 8) return findings; // 控量（防裁决器 prompt 爆）
      const attribution = REVIEW_ATTRIBUTION_VALUES.find((v) => v === finding.attribution);
      findings.push({
        severity,
        quote,
        location,
        explanation,
        ...(typeof finding.subClass === 'string' ? { subClass: finding.subClass } : {}),
        ...(attribution !== undefined ? { attribution } : {}),
      });
    }
  }
  return findings.length > 0 ? findings : undefined;
}

/** 累积错误到 run.errors（additive，不覆盖）。 */
function pushError(run: RunSnapshot, message: string): void {
  if (!run.errors) run.errors = [];
  run.errors.push(message);
}

/**
 * abort 时持久 checkpoint（design §4.1/§4.6）。
 * 调 onCheckpoint（若提供 + 有 lastStage）让 Step 5 runChapterChain 把 chainSnapshot 写入 RunStateStore
 * （resume 恢复 artifacts + completedNodes）。无 lastStage（abort 在任何 checkpoint 前）→ 不调（无 stage 可持久）。
 *
 * Story 4.3 Step 2：onCheckpoint 已升 async 返 CheckpointDecision，但 abort 路径**不能 await**（紧接着 throw
 * ChainAbortedError）。fire-and-forget：persistChainSnapshot 体同步执行（runState.setChainSnapshot 同步），
 * 故在 async 闭包 yield 前已完成持久（与 4.0 fire-and-forget 行为一致）。`void` 弃 Promise（决策被忽略——abort 中，
 * pause/continue 无意义）。design §6 「onCheckpoint async：保留 fire-and-forget 兜底」。
 */
function emitAbortCheckpoint(
  run: RunSnapshot,
  lastStage: CheckpointStage | undefined,
  opts: RunChainOptions,
  sessionId: string,
): void {
  // dogfood R2 #105 R2.5：abort 出口留痕（sessionId + 中断时节点 + 最近 checkpoint stage）——
  // 修前 abort 路径全线零日志（「中断原因未上日志」诊断盲区）。只记不重试，abort 语义不变。
  // sessionId = 链段 child session（runChain 作用域唯一 id 源）；projectPath 是跨层日志（workflow
  // 守卫/收口日志）可对齐的 join key。
  logger.info(
    { sessionId, projectPath: run.projectPath, currentNodeId: run.currentNodeId, lastCheckpointStage: lastStage },
    'chapter chain aborted — emitting checkpoint for resume',
  );
  if (lastStage && opts.onCheckpoint) {
    void opts.onCheckpoint(lastStage, run);
  }
}
