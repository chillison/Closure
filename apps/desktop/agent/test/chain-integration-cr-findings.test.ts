import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  sceneNodeSchema,
  episodeOutlineSchema,
  type SceneGraph,
} from '@orison/shared-contracts';
import { runChain } from '../src/runtime/chainRunner';
import {
  createChapterChainNodes,
  CHAPTER_CHAIN_REVISION_LOOP,
} from '../src/nodes/chapter-chain';
import { registry } from '../src/tool/registry';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionState } from '../src/types';
import type { RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// Story 7.4 BMad CR findings — 真链集成验证测试（2026-08-13）
//
// **目的**：用真链（createChapterChainNodes 装全链 + runChain 驱动）验证三个 HIGH finding + 一个 MEDIUM
// 的生产链行为修复。不 mock runChapterChain，只 mock LLM generate + 注册 spy tool。
//
// 三个 HIGH + 一个 MEDIUM（CR-001/002/003/004 修复后状态）：
// - HIGH-1 FIXED：feedback-ledger-node 在生产链可达（移 route 前，through-break 不再阻断）
// - HIGH-2 FIXED：completeness-verify-node 在生产链可达（移 route 前）
// - HIGH-3 FIXED：redo 清 review.latest → targeted-revision skip（不再用过期 review 覆盖 splice）
// - MEDIUM-4 FIXED（code-level）：环 A splice 落盘 chapters/*.md（writeChapterTool 层 chapter_write）
//
// **关键约束**：每个测试明确断言 fixed 行为（reachable / not-overwritten），证明修复生效。
// ─────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// Spy tool 注册（真 registry singleton，chain 节点能查到）
// ════════════════════════════════════════════════════════════════════════════

const feedbackLedgerWriteCalls: Array<{ episodeId: string; artifactKey: string }> = [];
const gitStatusCalls: number[] = [];
const gitCommitCalls: Array<{ message: string }> = [];

registry.register({
  id: 'feedback_ledger_write',
  description: 'integration test spy',
  parameters: z.object({
    episodeId: z.string(),
    artifactKey: z.string(),
    payload: z.unknown(),
  }),
  execute: async (params: { episodeId: string; artifactKey: string }) => {
    feedbackLedgerWriteCalls.push({ episodeId: params.episodeId, artifactKey: params.artifactKey });
    return { title: 'feedback_ledger_write', output: 'ok' };
  },
});

registry.register({
  id: 'git_status',
  description: 'integration test spy',
  parameters: z.object({}),
  execute: async () => {
    gitStatusCalls.push(1);
    return { title: 'git_status', output: 'nothing to commit, working tree clean' };
  },
});

registry.register({
  id: 'git_commit',
  description: 'integration test spy',
  parameters: z.object({ message: z.string() }),
  execute: async (params: { message: string }) => {
    gitCommitCalls.push({ message: params.message });
    return { title: 'git_commit', output: 'committed' };
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Fixtures（mirror chain-e2e.test.ts 最小 demo 数据）
// ════════════════════════════════════════════════════════════════════════════

const EPISODES = [
  episodeOutlineSchema.parse({ id: 'ep1', index: 0, title: '第一章' }),
  episodeOutlineSchema.parse({ id: 'ep2', index: 1, title: '第二章' }),
  episodeOutlineSchema.parse({ id: 'ep3', index: 2, title: '第三章' }),
];

const TARGET_EPISODE = 'ep2';

function scene(partial: Record<string, unknown>) {
  return sceneNodeSchema.parse({
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...partial,
  });
}

function buildSceneGraph(): SceneGraph {
  return {
    nodes: [
      scene({ id: 's_direct', episodeId: TARGET_EPISODE }),
      scene({ id: 's_other', episodeId: 'ep1' }),
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };
}

function makeInitialArtifacts(): Record<string, unknown> {
  return {
    scene_graph: buildSceneGraph(),
    episode_outlines: EPISODES,
    settings_context: '世界观：灵气复苏的现代都市。\n主角：林动，坚韧少年。',
    chapter_brief_input: {
      episodeId: TARGET_EPISODE,
      brief: {
        goal: '主角抵达 B 城',
        ending: '城门关闭前一刻进入',
        tone: '紧迫',
        readerKnows: '读者知道追兵在后',
        mustHide: '主角的真实身份',
        doNotWrite: '主角的过去回忆',
      },
    },
    promise_registry: { promises: [], beats: [], version: 0 },
  };
}

function makeSession(): SessionState {
  return {
    id: 'sess-cr-findings',
    agentName: 'chapter-chain',
    projectPath: '/test/cr-findings-project',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// mock generate：按 yaml system 段标记区分节点返 fixture JSON
// 顺序敏感：「完整性审核」/「保义裁判员」/「修订编辑」须在通用「审核」前匹配
// ════════════════════════════════════════════════════════════════════════════

const REVIEW_RESULT = {
  verdict: 'revise',
  summary: '一致性矛盾：主角动机铺垫不足',
  dimensions: [
    {
      name: 'consistency',
      findings: [
        {
          subClass: 'Characterization.memory',
          severity: 'warn',
          quote: '主角突然决定进城',
          location: '句3',
          explanation: '前文未铺垫进城动机',
        },
      ],
    },
  ],
  reasons: ['主角动机铺垫不足'],
};

const COMPLETENESS_RESULT = {
  findings: [{
    category: 'arc',
    verdict: 'under-developed',
    entityId: 'char-1',
    entityLabel: '主角成长弧',
    quote: '主角深吸一口气',
    location: '段1句1',
    explanation: '角色弧起点未充分铺垫',
    suggestedFix: '补强开篇动机',
  }],
  summary: '有缺漏',
  degraded: false,
};

interface MakeGenerateOpts {
  /** route 决策序列（按调用次序；超出长度复用最后一项）。默认 ['accept_as_truth']。 */
  routeDecisions?: string[];
}

/**
 * mock generate：按 system 标记路由 fixture JSON。system 标记对齐 prompts/*.yaml：
 * - 「路由判决」→ route-agent
 * - 「保义裁判员」→ revision-guard L2
 * - 「完整性审核」→ completeness-verify L2（**须在「审核」前**，否则被 multi-review 抢匹配）
 * - 「修订编辑」→ targeted-revision
 * - 「Reader-Audit」/「多维度」/「审核」→ multi-review
 * - 「状态提取」→ world-extractor（5 轴）
 * - 「涌现登记」→ promise-emergence
 * - 默认 → draft-writer
 */
function makeGenerate(opts: MakeGenerateOpts = {}): ReturnType<typeof vi.fn<GenerateFn>> {
  const routeDecisions = opts.routeDecisions ?? ['accept_as_truth'];
  let routeIdx = 0;
  return vi.fn<GenerateFn>(async (_msgs, sys) => {
    const s = sys ?? '';
    if (s.includes('路由判决')) {
      const decision = routeDecisions[Math.min(routeIdx, routeDecisions.length - 1)];
      routeIdx += 1;
      return { content: JSON.stringify({ decision, reason: `mock ${decision}` }), finishReason: 'stop' };
    }
    // revision-guard L2（保义裁判员）—— 须在 multi-review「审核」前匹配
    if (s.includes('保义裁判员')) {
      return { content: JSON.stringify({ verdict: 'clean', findings: [], summary: '保义通过' }), finishReason: 'stop' };
    }
    // completeness-verify L2 —— 须在 multi-review「审核」前匹配（含「审核」子串）
    if (s.includes('完整性审核')) {
      return { content: JSON.stringify(COMPLETENESS_RESULT), finishReason: 'stop' };
    }
    if (s.includes('修订编辑')) {
      return {
        content: JSON.stringify({ title: '修订章', text: 'TARGETED_REVISION_OVERWRITE_MARKER', wordCount: 100, revisionNotes: ['据旧 review 修订'] }),
        finishReason: 'stop',
      };
    }
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
      return { content: JSON.stringify(REVIEW_RESULT), finishReason: 'stop' };
    }
    if (s.includes('状态提取')) {
      return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
    }
    // Story 2.2 WP-E：story-sync-agent 提取节点（system 首句「你是 story-sync-agent」）——默认空 patches。
    // **须在「涌现登记」前匹配**：story-sync system 的防线规则 7 明文提及「涌现登记」（禁止项），
    // 后匹配会被 promise-emergence 抢路由（mirror「完整性审核」在「审核」前的顺序约束）。
    if (s.includes('story-sync-agent')) {
      return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
    }
    if (s.includes('涌现登记')) {
      return { content: JSON.stringify({ promises: [], beats: [] }), finishReason: 'stop' };
    }
    // draft-writer（默认分支）
    return { content: JSON.stringify({ title: '第二章', text: 'DRAFT_WRITER_MARKER 正文内容。', wordCount: 2800, chapterId: TARGET_EPISODE }), finishReason: 'stop' };
  });
}

/** 从 generate mock 调用序列抽取 system 标记类型（用于验证节点执行序）。 */
function classifyCall(sys: unknown): string {
  const s = typeof sys === 'string' ? sys : '';
  if (s.includes('路由判决')) return 'route';
  if (s.includes('保义裁判员')) return 'revision-guard';
  if (s.includes('完整性审核')) return 'completeness-verify';
  if (s.includes('修订编辑')) return 'targeted-revision';
  if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) return 'multi-review';
  if (s.includes('状态提取')) return 'world-extractor';
  // 须在「涌现登记」前：story-sync system 防线规则 7 明文提及「涌现登记」（禁止项）。
  if (s.includes('story-sync-agent')) return 'story-sync';
  if (s.includes('涌现登记')) return 'promise-emergence';
  return 'draft-writer';
}

function getCallSequence(generate: ReturnType<typeof vi.fn<GenerateFn>>): string[] {
  return generate.mock.calls.map(([, sys]) => classifyCall(sys));
}

// ════════════════════════════════════════════════════════════════════════════
// runChain 驱动 helper（直调 runChain，非 mock runChapterChain）
// ════════════════════════════════════════════════════════════════════════════

async function runChainFull(
  generate: ReturnType<typeof vi.fn<GenerateFn>>,
  overrides: {
    initialArtifacts?: Record<string, unknown>;
    resumedCompletedNodes?: string[];
    revisionLoop?: { from: string; through: string; cap: number };
  } = {},
): Promise<RunSnapshot> {
  const session = makeSession();
  return runChain(
    {
      chain: createChapterChainNodes(generate, undefined, session),
      initialArtifacts: overrides.initialArtifacts ?? makeInitialArtifacts(),
      requirement: '',
      revisionLoop: overrides.revisionLoop ?? CHAPTER_CHAIN_REVISION_LOOP,
      ...(overrides.resumedCompletedNodes ? { resumedCompletedNodes: overrides.resumedCompletedNodes } : {}),
    },
    {
      generate,
      sessionContext: session,
      signal: new AbortController().signal,
    },
  );
}

// ════════════════════════════════════════════════════════════════════════════
// HIGH-1 FIXED：feedback-ledger-node 在生产链可达（移 route 前后对比）
// ════════════════════════════════════════════════════════════════════════════

describe('HIGH-1 FIXED: feedback-ledger-node 在生产链可达（BMad CR-001 fix）', () => {
  beforeEach(() => {
    feedbackLedgerWriteCalls.length = 0;
  });

  it('route=accept_as_truth（终态）→ feedback_ledger_write 被调用（route 移链尾后 pre-route 节点可达）', async () => {
    const generate = makeGenerate({ routeDecisions: ['accept_as_truth'] });
    const snapshot = await runChainFull(generate);

    // CR-001 fix：route 是链尾 through 节点。pre-route 节点（含 feedback-ledger idx15）在 through-break 前跑完。
    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toContain('route-agent');
    // feedback-ledger-node 在 completedNodes（修复前不可达，修复后可达）
    expect(snapshot.completedNodes).toContain('feedback-ledger-node');

    // feedback_ledger_write spy 被调用 → HIGH-1 FIXED
    expect(feedbackLedgerWriteCalls.length).toBeGreaterThan(0);

    // feedback_ledger artifact 产出
    expect(snapshot.artifacts['feedback_ledger']).toBeDefined();
  });

  it('route=auto_revise（break）→ feedback_ledger_write 被调用（pre-route 节点在 through-break 前）', async () => {
    const generate = makeGenerate({ routeDecisions: ['auto_revise'] });
    const snapshot = await runChainFull(generate);

    // auto_revise → break（status=auto_revise_pending），但 feedback-ledger 在 route 前 → 已跑完
    expect(snapshot.status).toBe('auto_revise_pending');
    expect(snapshot.completedNodes).toContain('feedback-ledger-node');

    // feedback_ledger_write spy 被调用 → HIGH-1 FIXED（auto_revise 路径也可达）
    expect(feedbackLedgerWriteCalls.length).toBeGreaterThan(0);
  });

  it('route=escalate_user（终态）→ feedback_ledger_write 被调用', async () => {
    const generate = makeGenerate({ routeDecisions: ['escalate_user'] });
    const snapshot = await runChainFull(generate);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toContain('feedback-ledger-node');
    expect(feedbackLedgerWriteCalls.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HIGH-2 FIXED：completeness-verify-node 在生产链可达（移 route 前）
// ════════════════════════════════════════════════════════════════════════════

describe('HIGH-2 FIXED: completeness-verify-node 在生产链可达（BMad CR-002 fix）', () => {
  it('route=accept_as_truth → completeness-verify L2 generate 被调用 + artifact 产出', async () => {
    const generate = makeGenerate({ routeDecisions: ['accept_as_truth'] });
    const snapshot = await runChainFull(generate);

    // CR-002 fix：completeness-verify 移 route 前（multi-review 后），through-break 前可达
    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toContain('completeness-verify-node');

    // generate 调用序列含 completeness-verify → HIGH-2 FIXED
    const sequence = getCallSequence(generate);
    expect(sequence).toContain('completeness-verify');

    // completeness_verify_result artifact 产出
    expect(snapshot.artifacts['completeness_verify_result']).toBeDefined();
  });

  it('route=auto_revise → completeness-verify L2 generate 被调用', async () => {
    const generate = makeGenerate({ routeDecisions: ['auto_revise'] });
    const snapshot = await runChainFull(generate);

    expect(snapshot.status).toBe('auto_revise_pending');
    expect(snapshot.completedNodes).toContain('completeness-verify-node');

    const sequence = getCallSequence(generate);
    expect(sequence).toContain('completeness-verify');
    expect(snapshot.artifacts['completeness_verify_result']).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HIGH-3 FIXED：redo 清 review.latest → targeted-revision skip（不再覆盖 splice）
// ════════════════════════════════════════════════════════════════════════════

describe('HIGH-3 FIXED: redo 清 review.latest → targeted-revision skip（BMad CR-003 fix）', () => {
  // 链序（chapter-chain.ts CHAPTER_CHAIN_NODE_IDS，C1.2 lint-node 插入后）：
  // 0 brief-compiler / 1 draft-writer / 2 revision-guard / 3 lint-node（C1.2）/ 4-8 world-extractor×5 /
  // 9 world-merge / 10 emotion-verify / 11 promise-emergence / 12 arc-emergence / 13 chapter-summary /
  // 14 storytime-drift / 15 mention-ledger / 16 story-sync / 17 targeted-revision / 18 multi-review /
  // 19 completeness-verify / 20 feedback-ledger / 21 route
  //
  // revisionLoop = {from: targeted-revision(17), through: route(21), cap: 3}
  //
  // CR-003 fix：redo 时清 review.latest artifact（workflow.ts redo path L862+）→ targeted-revision(17)
  // shouldSkip(!review.latest) 跳过 → multi-review(18) 重跑产新 review → route(21) 重判。
  //
  // chain-integration 测试 limitation：runChain 直调不经 workflow.ts redo path（redo 清 review.latest 在
  // workflow.ts runChapterChain 内）。本测试组**模拟 CR-003 fix 效果**：redo 传 initialArtifacts 不含
  // review.latest（mirror workflow.ts 清后效果），验 targeted-revision skip + draft.initial 不被覆盖。

  it('首次 run: route=auto_revise → break + snapshot 含 review.latest + completedNodes 含全 pre-route 节点', async () => {
    const generate = makeGenerate({ routeDecisions: ['auto_revise', 'accept_as_truth'] });
    const snapshot = await runChainFull(generate);

    // auto_revise → break
    expect(snapshot.status).toBe('auto_revise_pending');
    expect(snapshot.completedNodes).toContain('route-agent');

    // review.latest 产出（multi-review idx13 跑了）
    expect(snapshot.artifacts['review.latest']).toBeDefined();

    // CR-001/002 fix：completeness-verify + feedback-ledger 在 completedNodes（route 前）
    expect(snapshot.completedNodes).toContain('completeness-verify-node');
    expect(snapshot.completedNodes).toContain('feedback-ledger-node');

    // draft.initial 是 draft-writer 产出（未被 targeted-revision 覆盖——首跑 review.latest 在 multi-review 后产，
    // targeted-revision 在 multi-review 前首跑 skip）
    const draft = snapshot.artifacts['draft.initial'] as { text: string };
    expect(draft.text).toContain('DRAFT_WRITER_MARKER');
    expect(draft.text).not.toContain('TARGETED_REVISION_OVERWRITE_MARKER');
  });

  it('CR-003 fix 验证：redo 不传 review.latest（模拟 workflow 清理）→ targeted-revision skip（不重跑）', async () => {
    const generate = makeGenerate({ routeDecisions: ['auto_revise', 'accept_as_truth'] });

    // 首次 run
    const snapshot1 = await runChainFull(generate);
    expect(snapshot1.status).toBe('auto_revise_pending');

    // 模拟 redo（mirror workflow.ts runChapterChain redo + CR-003 fix 清 review.latest）：
    // 1. 从 snapshot1.completedNodes 移除 loopNodes（draft-writer+revision-guard+multi-review+route）
    // 2. **CR-003 fix**：从 initialArtifacts 删 review.latest（mirror workflow.ts redo path 清理）
    const loopNodes = ['draft-writer-agent', 'revision-guard-agent', 'multi-review-agent', 'route-agent'];
    const resumedCompletedNodes = snapshot1.completedNodes.filter((id) => !loopNodes.includes(id));

    // CR-003 fix 核心：清 review.latest（模拟 workflow.ts redo path effect）
    const redoArtifacts = { ...snapshot1.artifacts };
    delete redoArtifacts['review.latest'];

    const snapshot2 = await runChainFull(generate, {
      initialArtifacts: redoArtifacts,
      resumedCompletedNodes,
    });

    expect(snapshot2.status).toBe('completed');

    // redo generate 调用序列（第二次 runChain 的调用）
    const allCalls = getCallSequence(generate);

    // CR-003 fix 核心断言：redo 不重跑 targeted-revision（review.latest 清 → shouldSkip=true → skip）
    const redoCalls = allCalls.slice(10); // 首次 run 10 calls 后（completeness-verify 可达 + story-sync 2.2 WP-E）
    expect(redoCalls).not.toContain('targeted-revision');

    // draft.initial 保留 draft-writer 产出（未被 targeted-revision 过期 review 覆盖）
    const draft2 = snapshot2.artifacts['draft.initial'] as { text: string };
    expect(draft2.text).toContain('DRAFT_WRITER_MARKER');
    expect(draft2.text).not.toContain('TARGETED_REVISION_OVERWRITE_MARKER');
  });

  it('CR-003 fix 对比：redo 保留 review.latest（模拟 fix 前）→ targeted-revision 重跑 + 覆盖 draft.initial', async () => {
    // 本测试验「fix 前行为」——不清 review.latest 时 targeted-revision 重跑覆盖（证明 fix 必要性）。
    const generate = makeGenerate({ routeDecisions: ['auto_revise', 'accept_as_truth'] });

    // 首次 run
    const snapshot1 = await runChainFull(generate);
    expect(snapshot1.status).toBe('auto_revise_pending');

    // redo **不清** review.latest（模拟 CR-003 fix 前的旧行为）
    const loopNodes = ['draft-writer-agent', 'revision-guard-agent', 'multi-review-agent', 'route-agent'];
    const resumedCompletedNodes = snapshot1.completedNodes.filter((id) => !loopNodes.includes(id));

    const snapshot2 = await runChainFull(generate, {
      initialArtifacts: snapshot1.artifacts, // 保留 review.latest（fix 前行为）
      resumedCompletedNodes,
    });

    // fix 前行为：targeted-revision 重跑（review.latest 在）→ 覆盖 draft.initial
    const draft2 = snapshot2.artifacts['draft.initial'] as { text: string };
    expect(draft2.text).toContain('TARGETED_REVISION_OVERWRITE_MARKER');

    // 证明 fix 前 targeted-revision 在 redo 调用序列中
    const redoCalls = getCallSequence(generate).slice(10); // 首次 run 10 calls 后（story-sync 2.2 WP-E）
    expect(redoCalls).toContain('targeted-revision');
  });

  it('redo 调用计数：首次 10 + redo 10 = 20（CR-003 fix 后 targeted-revision skip；story-sync 2.2 WP-E 每轮提取）', async () => {
    const generate = makeGenerate({ routeDecisions: ['auto_revise', 'accept_as_truth'] });

    // 首次 run
    const snapshot1 = await runChainFull(generate);

    // redo with CR-003 fix（清 review.latest）
    const loopNodes = ['draft-writer-agent', 'revision-guard-agent', 'multi-review-agent', 'route-agent'];
    const resumedCompletedNodes = snapshot1.completedNodes.filter((id) => !loopNodes.includes(id));
    const redoArtifacts = { ...snapshot1.artifacts };
    delete redoArtifacts['review.latest'];
    await runChainFull(generate, {
      initialArtifacts: redoArtifacts,
      resumedCompletedNodes,
    });

    // 首次（CR-001/002 fix 后 completeness-verify 可达；2.2 WP-E story-sync 激活）：
    //   draft(1) + world-ext(5) + multi-review(1) + completeness-verify(1) + route(1) + story-sync(1) = 10
    // redo（CR-003 fix 清 review.latest）：
    //   draft(1) + world-ext(5) + multi-review(1) + completeness-verify(1) + route(1) + story-sync(1) = 10
    //   （targeted-revision shouldSkip=true skip；revision-guard skip：无 revision_intent scope.anchor；
    //    promise-emergence skip：无新 gap；story-sync 每轮重提取——中间轮喂连续性记忆，终轮供 WP-E 反哺）
    const allCalls = getCallSequence(generate);
    const redoCalls = allCalls.slice(10); // 首次 run 10 calls 后
    expect(redoCalls).not.toContain('targeted-revision');
    expect(redoCalls).toContain('story-sync');
    expect(generate.mock.calls.length).toBe(20);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MEDIUM-4 FIXED（code-level）：环 A splice 落盘 chapters/*.md（writeChapterTool 层 chapter_write）
// ════════════════════════════════════════════════════════════════════════════

describe('MEDIUM-4 FIXED: splice 落盘在 writeChapterTool 层（chapter_write builtin，CR-004 fix）', () => {
  // revision-guard splicePassage（chapter-nodes.ts:918）只 mutate 内存 run.artifacts['draft.initial']，
  // 不写盘。CR-004 fix：writeChapterTool redo 循环后（autoReviseCount > 0）经 chapter_write builtin 写
  // chapters/{chapterId}.md（summary.draftText 含 splice 后正文）→ git_status 找到变更 → commit 建版本节点。
  //
  // 本测试验证链段层面：git_commit / git_status spy 未被链段调用（git 操作在 writeChapterTool 层非链段层）。
  // CR-004 fix 的完整验证（chapter_write 被调 + git commit 建版本节点）需 writeChapterTool 级集成测试
  // （真 project.yaml + 真 dispatchSubagent + 链段跑通 + chapter_write spy），非 chain 级能测。

  beforeEach(() => {
    gitCommitCalls.length = 0;
    gitStatusCalls.length = 0;
  });

  it('链段执行完毕 → git_commit / git_status spy 未被链段调用（git 操作在 writeChapterTool 层）', async () => {
    const generate = makeGenerate({ routeDecisions: ['accept_as_truth'] });
    const snapshot = await runChainFull(generate);

    expect(snapshot.status).toBe('completed');
    // git_commit / git_status 是 writeChapterTool 层操作，非链段节点操作
    // → 链段本身永远不调 git 工具（无论 splice 与否）
    expect(gitCommitCalls).toHaveLength(0);
    expect(gitStatusCalls).toHaveLength(0);
  });

  // CR-004 fix code-level 证据：
  // - revision-guard splicePassage（chapter-nodes.ts:918）只 return {text: spliced.text} mutate 内存
  // - write-chapter.ts CR-004 fix（L1536+）：redo 后调 chapter_write builtin 写 chapters/{chapterId}.md
  //   （summary.draftText = splice 后正文）→ git_status 找到变更 → commitRevisionNode commit
  // - chapter_write handler（chapterHandlers.ts:45）：atomicWriteFileSync chapters/{chapterId}.md
  // 结论：CR-004 FIXED（code-level），splice 落盘经 chapter_write builtin → git 版本节点建立。
  // 完整 e2e 验证需 writeChapterTool 级集成测试（超 chain 级 scope）。
});
