import { describe, expect, it, vi } from 'vitest';
import {
  sceneNodeSchema,
  episodeOutlineSchema,
  type SceneGraph,
} from '@orison/shared-contracts';
import { runChain, summarizeRunSnapshot } from '../src/runtime/chainRunner';
import {
  createChapterChainNodes,
  CHAPTER_CHAIN_REVISION_LOOP,
} from '../src/nodes/chapter-chain';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionState } from '../src/types';
import type { RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4 / implement.md 7.1：写章战术链段端到端集成测（4.0 dogfooding gate 的 mock-LLM 版）。
//
// **全链 runChain + mock generate（不调真 LLM）**：真节点（createChapterChainNodes 装配的 6 节点）+
// mock generate（按 system 标记返 fixture JSON）+ assembled initialArtifacts（scene_graph/设定/
// ChapterBrief/promise_registry）→ runChain 跑全链 → 验产出 + 全链 artifact 流转 + revision 闭环。
//
// 与 Step 4/5 单测的分工：
// - Step 4 chainRunner.test.ts：runChain 驱动器纯逻辑测（mock 节点 run()，不涉真 chapter-chain 节点）。
// - Step 5 runChapterChain.test.ts：runChapterChain 包装层（dispatchSubagent + context isolation + abort +
//   chainSnapshot 持久）+ 真 LLM 节点经包装层跑通。
// - **Step 7.1 本文件**：真 6 节点 + mock generate 跑 runChain 全链，重点验**全链 artifact 流转** +
//   **yaml `{{var}}` 被 renderTemplate 消费** + **brief #6 plotPoints 汇编** + **三档 route_decision** +
//   **revision 闭环 draft.initial overwrite** + **summarizeRunSnapshot context isolation**。
//
// 用 runChain 直调（非 runChapterChain）—— Step 5 已测包装层；e2e 重点在链内 artifact 流转，runChain 直调
// 给完整 snapshot 访问（chapter_brief / draft.initial / review.latest 等），context isolation 单独验。
//
// 三档 route 场景（额量）：
// 1. revision 闭环（auto_revise → targeted-revision 改稿 → accept_as_truth 终止）—— 主详测，7 断言全验。
// 2. happy-path（accept 首判，无闭环）。
// 3. escalate 路径（route 返 escalate_user → 链段立即结束）。
// 4. cap 超限（route 持续 auto_revise → cap 上限 → 强制 escalate_user）。
// ─────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// fixture：最小 demo 数据（scene_graph 含 M:N 跨章场 + episode_outlines + 设定 + brief + registry）
// ════════════════════════════════════════════════════════════════════════════

const EPISODES = [
  episodeOutlineSchema.parse({ id: 'ep1', index: 0, title: '第一章' }),
  episodeOutlineSchema.parse({ id: 'ep2', index: 1, title: '第二章' }),
  episodeOutlineSchema.parse({ id: 'ep3', index: 2, title: '第三章' }),
];

const TARGET_EPISODE = 'ep2';

/** 构造 valid SceneNode（schema.parse 填默认 lineTags/role，避免漏 required 字段）。 */
function scene(partial: Record<string, unknown>) {
  return sceneNodeSchema.parse({
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...partial,
  });
}

/**
 * demo scene_graph：3 场覆盖 brief #6 汇编矩阵。
 * - s_direct：episodeId=ep2（单章场直挂，1.1 行为）→ 命中。
 * - s_cross：presentationSpans=[ep2,ep3]（跨章场 M:N，1.8）→ 命中（续到后章）。
 * - s_other：episodeId=ep1（他章场）→ 不命中（排除）。
 */
function buildSceneGraph(): SceneGraph {
  return {
    nodes: [
      scene({ id: 's_direct', episodeId: TARGET_EPISODE }),
      scene({
        id: 's_cross',
        presentationSpans: [
          { episodeId: TARGET_EPISODE, pos: 0 },
          { episodeId: 'ep3', pos: 0 },
        ],
      }),
      scene({ id: 's_other', episodeId: 'ep1' }),
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };
}

/** 链段 initialArtifacts（mirror write_chapter tool / dogfood IPC 组装产物）。 */
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
        emotionTarget: { emotion: '紧张', emotionEnd: '释然', vad: { v: -0.5, a: 0.8, d: 0.1 }, steer: '窒息感再松一口气' },
      },
    },
    promise_registry: { promises: [], beats: [], version: 0 },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// mock generate：按 system 标记路由 fixture（route 用计数器返决策序列）
// ════════════════════════════════════════════════════════════════════════════

const INITIAL_DRAFT = {
  title: '第二章 B 城',
  text: '黄昏的荒野上，主角深吸一口气，攥紧行囊向远方的城墙走去。INITIAL_DRAFT_MARKER',
  wordCount: 2800,
  chapterId: TARGET_EPISODE,
};

const REVISED_DRAFT = {
  title: '第二章 B 城（修订）',
  text: '主角攥紧拳头，目光投向远方巍峨的城壁，脚步不由自主地加快。REVISED_DRAFT_MARKER',
  wordCount: 2950,
  chapterId: TARGET_EPISODE,
  revisionNotes: ['补强主角动机：加入对家人的牵挂'],
};

const REVIEW_RESULT = {
  verdict: 'revise',
  summary: '一致性矛盾：主角动机铺垫不足（Reader-Audit 双层审核）',
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
    {
      name: 'narrative-feature',
      findings: [
        { severity: 'info', quote: '深吸一口气', location: '句1', explanation: 'cliché 微表情（语境尚可）' },
      ],
    },
  ],
  reasons: ['主角动机铺垫不足', 'L1 cliché hotspot 已回应（句1，降级 info）'],
};

interface GenerateOverrides {
  /** route 决策序列（按调用次序；超出长度时复用最后一项）。默认 ['auto_revise','accept_as_truth']。 */
  routeDecisions?: string[];
  /** route 每次返的 reason 文本。 */
  routeReason?: string;
}

/**
 * mock generate：按 yaml system 段标记区分节点返 fixture JSON。
 * - system 含「路由判决」→ route-agent，按 routeDecisions 序列返（计数器）。
 * - system 含「修订编辑」→ targeted-revision-agent，返 REVISED_DRAFT。
 * - system 含「Reader-Audit」/「审核」/「多维度」→ Reader-Audit（multi-review-agent 节点），返 REVIEW_RESULT。
 * - 其余（含「故事写作者」）→ draft-writer-agent，返 INITIAL_DRAFT。
 *
 * system 标记对齐 prompts/*.yaml（route-agent.yaml「路由判决」/ targeted-revision「修订编辑」/
 * multi-review-agent.yaml「Reader-Audit 双层审核员」/ draft-writer「故事写作者」）。Story 4.2：multi-review
 * 节点换为 Reader-Audit composite（L1→L2），yaml system 段 rework 为「Reader-Audit 双层审核员」——
 * matcher 加 'Reader-Audit' 关键字（'审核' 仍在 yaml，向后兼容旧 fixture）。
 */
function makeE2eGenerate(overrides: GenerateOverrides = {}) {
  const routeDecisions = overrides.routeDecisions ?? ['auto_revise', 'accept_as_truth'];
  const routeReason = overrides.routeReason ?? 'mock route reason';
  let routeIdx = 0;
  return vi.fn<GenerateFn>(async (_msgs, sys) => {
    const s = sys ?? '';
    if (s.includes('路由判决')) {
      const decision = routeDecisions[Math.min(routeIdx, routeDecisions.length - 1)];
      routeIdx += 1;
      return {
        content: JSON.stringify({ decision, reason: `${routeReason} (${decision})` }),
        finishReason: 'stop',
      };
    }
    if (s.includes('修订编辑')) {
      return { content: JSON.stringify(REVISED_DRAFT), finishReason: 'stop' };
    }
    // completeness-verify L2（「完整性审核」——须在 generic「审核」前匹配）
    if (s.includes('完整性审核')) {
      return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
    }
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
      return { content: JSON.stringify(REVIEW_RESULT), finishReason: 'stop' };
    }
    // world-extractor（5 轴提取器，6.6 Phase C1/C2）—— yaml system 含「<轴>状态提取专家」，共同子串「状态提取」
    if (s.includes('状态提取')) {
      return {
        content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }),
        finishReason: 'stop',
      };
    }
    // Story 2.2 WP-E：story-sync-agent 提取节点（system 首句「你是 story-sync-agent」）——默认空 patches
    if (s.includes('story-sync-agent')) {
      return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
    }
    // draft-writer（默认分支）
    return { content: JSON.stringify(INITIAL_DRAFT), finishReason: 'stop' };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// runChain e2e 驱动 helper
// ════════════════════════════════════════════════════════════════════════════

function makeSession(): SessionState {
  return {
    id: 'sess_e2e',
    agentName: 'chapter-chain',
    projectPath: '/test/e2e-project',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 用真 6 节点 + mock generate 跑 runChain 全链（design §4.1 数据流）。 */
async function runChainE2E(
  generate: ReturnType<typeof vi.fn<GenerateFn>>,
  revisionLoop: { from: string; through: string; cap: number } = CHAPTER_CHAIN_REVISION_LOOP,
): Promise<RunSnapshot> {
  const session = makeSession();
  return runChain(
    {
      chain: createChapterChainNodes(generate, undefined, session),
      initialArtifacts: makeInitialArtifacts(),
      requirement: '',
      revisionLoop,
    },
    {
      generate,
      sessionContext: session,
      signal: new AbortController().signal,
    },
  );
}

/** 收集 mock generate 收到的所有 user prompt（验 yaml `{{var}}` 渲染）。 */
function collectUserPrompts(generate: ReturnType<typeof vi.fn<GenerateFn>>): string[] {
  return generate.mock.calls.map(([msgs]) => {
    const msg = (msgs as Array<{ content?: string }> | undefined)?.[0];
    return msg?.content ?? '';
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. revision 闭环主场景（Story 7.4：auto_revise → break 交 leader 驱动 redo）— 7 断言全验
// ════════════════════════════════════════════════════════════════════════════

describe('chain-e2e — Story 7.4 auto_revise break（交 leader 驱动 redo）', () => {
  it('全链跑通：draft 产出 + review verdict + auto_revise break + draft 未裸改 + yaml 渲染 + brief #6 + summary isolation', async () => {
    const generate = makeE2eGenerate(); // route: auto_revise → accept_as_truth（7.4：首次 auto_revise 即 break）
    const snapshot = await runChainE2E(generate);

    // ── 断言 1：chapter draft 产出（draft.initial 含 title/text/wordCount，非空）──
    const draft = snapshot.artifacts['draft.initial'] as Record<string, unknown>;
    expect(draft).toBeDefined();
    expect(typeof draft.title).toBe('string');
    expect(draft.title).not.toBe('');
    expect(typeof draft.text).toBe('string');
    expect(draft.text).not.toBe('');
    expect(typeof draft.wordCount).toBe('number');
    expect(draft.wordCount).toBeGreaterThan(0);

    // ── 断言 2：review.verdict 产出（review.latest 含 verdict + dimensions）──
    const review = snapshot.artifacts['review.latest'] as Record<string, unknown>;
    expect(review).toBeDefined();
    expect(review.verdict).toBe('revise');
    expect(Array.isArray(review.dimensions)).toBe(true);
    expect((review.dimensions as unknown[]).length).toBeGreaterThan(0);

    // ── 断言 3：route_decision = 'auto_revise'（Story 7.4：break 不 loop，交 leader 驱动 redo）──
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string; reason: string };
    expect(routeDecision.decision).toBe('auto_revise');
    expect(typeof routeDecision.reason).toBe('string');
    // status = auto_revise_pending（break 出主循环，非 completed）
    expect(snapshot.status).toBe('auto_revise_pending');

    // ── 断言 4：Story 7.4 auto_revise break（无 loop 重跑，draft.initial 未被 targeted-revision 覆盖）──
    // 调用计数：draft-writer(1) + 5 轴 world-extractor(5) + targeted-revision 首跑 skip(0) + multi-review(1)
    // + completeness-verify(1) + route(1) + story-sync(1，2.2 WP-E 激活 LLM 提取) = 10。
    // 不再闭环重跑（auto_revise break 非 loop，targeted-revision 裸改稿路径不走）。
    expect(generate.mock.calls.length).toBe(10);
    // draft.initial 未被 overwrite（仍是 INITIAL_DRAFT，非 REVISED_DRAFT——无 loop 裸改稿）
    expect(draft.text).toContain('INITIAL_DRAFT_MARKER');
    expect(draft.text).not.toContain('REVISED_DRAFT_MARKER');
    expect(draft.title).toBe(INITIAL_DRAFT.title);

    // ── 断言 5：yaml `{{var}}` 渲染（mock generate 收到的 userPrompt 不含字面 `{{...}}` 模板标记）──
    // 证 renderTemplate 把 yaml user 段的 {{verdict}}/{{reasons}}/{{chapterBrief}}/{{draft}}/
    // {{chapterTask}}/{{storyPlan}}/{{projectContext}}/{{draftText}}/{{reviewResult}} 全替换为值。
    //
    // 精确匹配 mustache 标记 `{{...}}`（非裸 `}}`）：buildPrompt 把 chapterTask/storyPlan 等结构化 artifact
    // JSON.stringify 注入 yaml，JSON 嵌套对象闭合会产合法 `}}`（如 `{"emotionTarget":{...}}`），不能误判。
    // JSON.stringify 不产 `{{`（外内两层 `{` 间必有 key 名隔开）→ 模板标记 = 唯一 `{{` 来源。
    const userPrompts = collectUserPrompts(generate);
    expect(userPrompts.length).toBe(10); // 每个 generate 调用都有 user prompt（CR-002：completeness-verify 可达 9；2.2 WP-E story-sync 激活 10）
    for (const content of userPrompts) {
      expect(content).not.toMatch(/\{\{[^{}]*\}\}/); // 无残留 `{{key}}` 模板标记
      expect(content).not.toContain('{{'); // JSON 不产 `{{` → 见到就是未渲染模板
    }
    // 额定：验具体 var 真的注入了（非空替换）—— draft-writer user prompt 含 chapter_brief goal + settings
    const draftCall = generate.mock.calls.find(([_msgs, sys]) => {
      const s = sys ?? '';
      return (
        !s.includes('路由判决') &&
        !s.includes('Reader-Audit') &&
        !s.includes('多维度') &&
        !s.includes('审核') &&
        !s.includes('完整性审核') &&
        !s.includes('修订编辑') &&
        !s.includes('状态提取')
      );
    });
    expect(draftCall).toBeDefined();
    const draftUserContent = (draftCall![0] as Array<{ content?: string }>)[0]?.content ?? '';
    expect(draftUserContent).toContain('主角抵达 B 城'); // chapter_brief.goal 经 brief-compiler 透传
    expect(draftUserContent).toContain('灵气复苏'); // settings_context 注入 {{projectContext}}

    // ── 断言 6：brief #6 汇编（chapter_brief artifact 含 plotPoints from scene_graph）──
    const chapterBrief = snapshot.artifacts['chapter_brief'] as { plotPoints?: Array<{ sceneId: string; continuity?: string }> };
    expect(chapterBrief).toBeDefined();
    expect(Array.isArray(chapterBrief.plotPoints)).toBe(true);
    // 命中 2 场（s_direct 单章场 + s_cross M:N 跨章场），排除 s_other（他章场）
    const sceneIds = chapterBrief.plotPoints!.map((p) => p.sceneId);
    expect(sceneIds).toEqual(['s_direct', 's_cross']);
    // 连续性标注：s_direct 单章场 → '本章内'；s_cross spans=[ep2,ep3] → '续到后章'
    const byId = Object.fromEntries(chapterBrief.plotPoints!.map((p) => [p.sceneId, p.continuity]));
    expect(byId.s_direct).toBe('本章内');
    expect(byId.s_cross).toBe('续到后章');
    // LLM 段透传（brief #1 goal / #5 doNotWrite / #10 emotionTarget）
    const briefRecord = chapterBrief as unknown as Record<string, unknown>;
    expect(briefRecord.goal).toBe('主角抵达 B 城');
    expect(briefRecord.doNotWrite).toBe('主角的过去回忆');
    expect(briefRecord.emotionTarget).toEqual({
      emotion: '紧张',
      emotionEnd: '释然',
      vad: { v: -0.5, a: 0.8, d: 0.1 },
      steer: '窒息感再松一口气',
    });

    // ── 断言 7：summarizeRunSnapshot 返回 summary（不含内部 trace）──
    const summary = summarizeRunSnapshot(snapshot);
    expect(summary.status).toBe('auto_revise_pending');
    expect(summary.routeDecision).toEqual({
      decision: 'auto_revise',
      reason: expect.stringContaining('auto_revise'),
    });
    expect(summary.reviewVerdict).toBe('revise');
    expect(summary.draftTitle).toBe(INITIAL_DRAFT.title); // 初稿标题（未被修订覆盖）
    expect(summary.draftWordCount).toBe(INITIAL_DRAFT.wordCount);
    expect(Array.isArray(summary.errors)).toBe(true);
    // Story 7.4：auto_revise 时 autoReviseFindings 抽取（block/warn drop info，grounding 硬要求）
    expect(summary.autoReviseFindings).toBeDefined();
    expect(summary.autoReviseFindings!.length).toBe(1); // 1 warn finding（info 被过滤）
    expect(summary.autoReviseFindings![0].severity).toBe('warn');
    // context isolation：summary 不含内部 trace / 全量 artifacts
    const summaryKeys = Object.keys(summary);
    expect(summaryKeys).not.toContain('artifacts');
    expect(summaryKeys).not.toContain('completedNodes');
    expect(summaryKeys).not.toContain('scene_graph');
    expect(summaryKeys).not.toContain('chapter_brief');
    expect(summaryKeys).not.toContain('draft');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. happy-path（accept 首判，无闭环）
// ════════════════════════════════════════════════════════════════════════════

describe('chain-e2e — happy-path（accept 首判，无 revision 闭环）', () => {
  it('route 首判 accept_as_truth → 链段结束（10 generate 调用，无闭环）', async () => {
    const generate = makeE2eGenerate({
      routeDecisions: ['accept_as_truth'],
      routeReason: '正文达标',
    });
    const snapshot = await runChainE2E(generate);

    // route 首判 accept → 链段结束
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string };
    expect(routeDecision.decision).toBe('accept_as_truth');
    expect(snapshot.status).toBe('completed');

    // 无闭环：generate 调用 = draft-writer(1) + 5 轴 world-extractor(5) + targeted-revision 首跑 skip(0)
    // + multi-review(1) + completeness-verify(1) + route(1) + story-sync(1，2.2 WP-E) = 10
    expect(generate.mock.calls.length).toBe(10);

    // draft.initial = 初稿（未被 overwrite，因 targeted-revision 首跑 skip）
    const draft = snapshot.artifacts['draft.initial'] as { text: string };
    expect(draft.text).toContain('INITIAL_DRAFT_MARKER');

    // yaml 渲染（无字面 {{）
    for (const content of collectUserPrompts(generate)) {
      expect(content).not.toContain('{{');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. escalate 路径（route 返 escalate_user → 链段立即结束）
// ════════════════════════════════════════════════════════════════════════════

describe('chain-e2e — escalate 路径（route 返 escalate_user）', () => {
  it('route 首判 escalate_user → 链段结束（10 generate 调用，无闭环）', async () => {
    const generate = makeE2eGenerate({
      routeDecisions: ['escalate_user'],
      routeReason: 'OOC 边界难断，需作者拍板',
    });
    const snapshot = await runChainE2E(generate);

    // route 首判 escalate_user → 链段结束（上发 leader）
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string; reason: string };
    expect(routeDecision.decision).toBe('escalate_user');
    expect(snapshot.status).toBe('completed');

    // 无闭环：generate 调用 = draft(1) + 5 轮 world-extractor(5) + multi-review(1) + completeness-verify(1)
    // + route(1) + story-sync(1，2.2 WP-E) = 10
    expect(generate.mock.calls.length).toBe(10);

    // summary 透传 escalate（leader 据此决定 ask_user）
    const summary = summarizeRunSnapshot(snapshot);
    expect(summary.routeDecision?.decision).toBe('escalate_user');
    expect(summary.status).toBe('completed');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Story 7.4 cap=0 → auto_revise 立即 escalate（cap 防御路径；正常 redo 循环 cap 在 leader）
// ════════════════════════════════════════════════════════════════════════════

describe('chain-e2e — Story 7.4 cap=0 auto_revise 立即 escalate', () => {
  it('cap=0：route auto_revise → 立即 escalate（cap 防御路径，无 loop 重跑）', async () => {
    // Story 7.4：cap=0 → revisionCount=0 < 0 = false → 立即 escalate（单 runChain 内 cap 防御；
    // 正常 redo 循环 cap 在 leader writeChapterTool 兜底计数）。
    const generate = makeE2eGenerate({
      routeDecisions: ['auto_revise'], // 永远 auto_revise
      routeReason: '仍有缺陷',
    });
    const snapshot = await runChainE2E(generate, {
      ...CHAPTER_CHAIN_REVISION_LOOP,
      cap: 0,
    });

    // cap=0 → 强制 escalate_user（runChain 覆写 route_decision）
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string; reason: string };
    expect(routeDecision.decision).toBe('escalate_user');
    expect(routeDecision.reason).toContain('cap');

    // status completed + errors 记 cap 超限
    expect(snapshot.status).toBe('completed');
    expect(snapshot.errors?.some((e) => e.includes('cap'))).toBe(true);

    // generate 调用：首轮 10（draft-writer + 5 轮 world-extractor + multi-review + completeness-verify
    // + route + story-sync（2.2 WP-E）），cap=0 无 loop 重跑
    expect(generate.mock.calls.length).toBe(10);

    // draft.initial 未被 overwrite（cap=0 无 loop，targeted-revision 不跑）
    const draft = snapshot.artifacts['draft.initial'] as { text: string };
    expect(draft.text).toContain('INITIAL_DRAFT_MARKER');

    // summary 透传强制 escalate
    const summary = summarizeRunSnapshot(snapshot);
    expect(summary.routeDecision?.decision).toBe('escalate_user');
  });

  it('cap=0 默认行为一致（cap=3 时 auto_revise → break 非 escalate；cap 在 leader 循环兜底）', async () => {
    // 对照：cap=3（生产配置）时 auto_revise → break（status=auto_revise_pending），不在 chainRunner 内 escalate。
    // leader writeChapterTool 跨 redo 循环 cap=3 兜底（本 e2e 测 chain 段行为，不验 leader 循环）。
    const generate = makeE2eGenerate({
      routeDecisions: ['auto_revise'],
      routeReason: '仍有缺陷',
    });
    const snapshot = await runChainE2E(generate); // 默认 CHAPTER_CHAIN_REVISION_LOOP cap=3

    // cap=3 → auto_revise break（status=auto_revise_pending），routeDecision 仍 auto_revise（未 escalate）
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string };
    expect(routeDecision.decision).toBe('auto_revise');
    expect(snapshot.status).toBe('auto_revise_pending');

    // generate 调用：首轮 10（draft + 5 轮 world-extractor + multi-review + completeness-verify + route
    // + story-sync（2.2 WP-E）），无 loop 重跑
    expect(generate.mock.calls.length).toBe(10);
  });
});
