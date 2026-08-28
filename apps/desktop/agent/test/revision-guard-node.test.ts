import { describe, expect, it, vi } from 'vitest';
import { createRevisionGuardNode } from '../src/nodes/chapter-nodes';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { RunSnapshot } from '../src/contracts/run';
import type { GenerateResult } from '../src/provider/ipc-provider';

// ─────────────────────────────────────────────────────────────────────────────
// Story 7.2（design §1.3）：revision-guard 节点三层处置测试。
//
// createLlmNode 的重试 + abort 逻辑由 llm-node.test.ts 覆盖。此处验 revision-guard composite 节点：
// 1. clean → mutate revision_guard + return draft.initial spliced（splice 从 draft-writer 搬到此）
// 2. soft-violation → return revision_guard soft-violation + draft.initial 不动（保改前）+ 触发 pause（节点边界）
// 3. hard-violation → return error artifact + draft.initial 不动
// 4. 无 revision_intent → pass-through（draft.initial 原样，skipped 标记）
// 5. L2 parse 失败 → hard-violation fallback（永不假 clean）
// 6. force-accept（art-mode）→ resume 重跑 soft-violation + guardOverride → splice + forceAccepted 标记
// 7. 段落级但 draft 缺 passageText/previousFullText → error artifact
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_guard',
    status: 'running',
    currentNodeId: null,
    projectPath: '/test',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}

function makeGuardResult(json: object): GenerateResult {
  return { content: JSON.stringify(json), finishReason: 'stop' };
}

/** 段落级 revision_intent fixture（带 scope.anchor，B trigger）。 */
const PASSAGE_INTENT = {
  change: { summary: '战斗改紧张点' },
  lockedItems: [{ field: '角色性格', authority: 'hard', evidence: '别动角色性格' }],
  rationale: { source: 'user-directive' as const, note: '用户选段指挥' },
  provenance: { rawUserInstruction: '这段战斗改紧张点，别动角色性格', compilerNote: '锁定角色性格' },
  scope: {
    anchor: { quote: '战斗开始了', prefix: '前文。', suffix: '。后文', rangeHint: { from: 3, to: 8 } },
  },
};

/** draft.initial 段落级形态（Story 7.2：text=改前整章 + passageText=改后段，draft-writer 不 splice）。
 *
 * passageText 不带尾句号——对齐 PASSAGE_INTENT.anchor.quote「战斗开始了」（不含句号），splice 替换后
 * 原文「。后文。」的句号保留（splice 是 quote→passageText 逐字替换，非句子级）。
 */
const PASSAGE_DRAFT = {
  title: '第二章',
  text: '前文。战斗开始了。后文。',
  passageText: '战斗惨烈地开始了',
};

describe('revision-guard 节点（Story 7.2 三层处置）', () => {
  it('clean → mutate revision_guard（clean）+ return draft.initial spliced（选区段被换）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeGuardResult({ verdict: 'clean', findings: [], summary: '保义通过' }),
    );
    const node = createRevisionGuardNode({ generate });
    const run = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: PASSAGE_INTENT,
      'draft.initial': { ...PASSAGE_DRAFT },
    });
    const result = await node.run({ run, requirement: '' });

    // return draft.initial（splice 后）。
    expect(result.stateKey).toBe('draft.initial');
    const artifact = result.artifact as { text: string; passageText?: string };
    // splice：选区段「战斗开始了」→「战斗惨烈地开始了。」，前文/后文不动。
    expect(artifact.text).toBe('前文。战斗惨烈地开始了。后文。');
    expect(artifact.passageText).toBeUndefined(); // splice 后 passageText 清除

    // mutate revision_guard 记 clean。
    const guard = run.artifacts['revision_guard'] as { verdict: string; findings: unknown[] };
    expect(guard.verdict).toBe('clean');
    expect(guard.findings).toEqual([]);
  });

  it('soft-violation → return revision_guard soft-violation + draft.initial 不动（保改前）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeGuardResult({
        verdict: 'soft-violation',
        findings: [
          {
            pattern: 'tone-rhythm-cut',
            violatedScope: 'tone',
            authority: 'soft',
            evidence: { before: '抱歉了', after: '', explanation: '删语气词' },
          },
        ],
        summary: '软锁越界',
      }),
    );
    const node = createRevisionGuardNode({ generate });
    const run = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: PASSAGE_INTENT,
      'draft.initial': { ...PASSAGE_DRAFT },
    });
    const result = await node.run({ run, requirement: '' });

    // return revision_guard（draft.initial 不动，stateKey=revision_guard）。
    expect(result.stateKey).toBe('revision_guard');
    const artifact = result.artifact as {
      verdict: string;
      findings: { pattern: string; authority: string }[];
      beforeText: string;
      afterText: string;
    };
    expect(artifact.verdict).toBe('soft-violation');
    expect(artifact.findings).toHaveLength(1);
    expect(artifact.findings[0].pattern).toBe('tone-rhythm-cut');
    expect(artifact.beforeText).toBe('战斗开始了');
    expect(artifact.afterText).toBe('战斗惨烈地开始了');

    // 🔑 draft.initial 未被 splice（保改前整章 + passageText，pause 交还 leader）。
    const draft = run.artifacts['draft.initial'] as { text: string; passageText?: string };
    expect(draft.text).toBe('前文。战斗开始了。后文。'); // 改前整章不动
    expect(draft.passageText).toBe('战斗惨烈地开始了'); // passageText 保留
  });

  it('hard-violation → return error artifact + draft.initial 不动（强制拦，mirror 7.1 F1）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeGuardResult({
        verdict: 'hard-violation',
        findings: [
          {
            pattern: 'agency-removal',
            violatedScope: '角色性格',
            authority: 'hard',
            evidence: { before: '不说话', after: '死寂', explanation: '人沉默换环境死寂' },
          },
        ],
        summary: '硬锁越界',
      }),
    );
    const node = createRevisionGuardNode({ generate });
    const run = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: PASSAGE_INTENT,
      'draft.initial': { ...PASSAGE_DRAFT },
    });
    const result = await node.run({ run, requirement: '' });

    expect(result.stateKey).toBe('revision_guard');
    const artifact = result.artifact as { error?: boolean; message?: string; findings?: unknown[] };
    expect(artifact.error).toBe(true);
    expect(artifact.message).toContain('硬锁越界');
    expect(artifact.findings).toHaveLength(1);

    // draft.initial 未动。
    const draft = run.artifacts['draft.initial'] as { text: string };
    expect(draft.text).toBe('前文。战斗开始了。后文。');
  });

  it('无 revision_intent（整章路径）→ pass-through（draft.initial 原样 + skipped 标记）', async () => {
    const generate = vi.fn<GenerateFn>();
    const node = createRevisionGuardNode({ generate });
    const run = makeRun({
      chapter_brief: { goal: 'g' },
      'draft.initial': { title: '第二章', text: '整章正文……' },
      // 无 revision_intent
    });
    const result = await node.run({ run, requirement: '' });

    // return draft.initial 原样（整章路径零回归）。
    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual({ title: '第二章', text: '整章正文……' });
    // generate 未调（pass-through 不跑 L2）。
    expect(generate).not.toHaveBeenCalled();

    // mutate revision_guard 记 skipped。
    const guard = run.artifacts['revision_guard'] as { verdict: string; skipped?: boolean };
    expect(guard.verdict).toBe('clean');
    expect(guard.skipped).toBe(true);
  });

  it('revision_intent 无 scope（整章 intent / A trigger 无选区）→ pass-through', async () => {
    const generate = vi.fn<GenerateFn>();
    const node = createRevisionGuardNode({ generate });
    const intentNoScope = { ...PASSAGE_INTENT, scope: undefined };
    const run = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: intentNoScope,
      'draft.initial': { title: '第二章', text: '整章正文……' },
    });
    const result = await node.run({ run, requirement: '' });
    expect(result.stateKey).toBe('draft.initial');
    expect(generate).not.toHaveBeenCalled();
  });

  it('L2 parse 失败（畸形 JSON 重试后仍失败）→ hard-violation fallback（永不假 clean）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({
      content: '这不是 JSON，我也不会输出 JSON',
      finishReason: 'stop',
    }));
    const node = createRevisionGuardNode({ generate });
    const run = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: PASSAGE_INTENT,
      'draft.initial': { ...PASSAGE_DRAFT },
    });
    const result = await node.run({ run, requirement: '' });

    // escalate fallback → error artifact（hard-violation 语义，永不假 clean）。
    expect(result.stateKey).toBe('revision_guard');
    const artifact = result.artifact as { error?: boolean; message?: string };
    expect(artifact.error).toBe(true);
    expect(artifact.message).toContain('保义裁判失败');
    expect(generate).toHaveBeenCalledTimes(2); // MAX_ATTEMPTS=2（初试 + 重试）
  });

  it('段落级但 draft 缺 passageText → error artifact（防畸形）', async () => {
    const generate = vi.fn<GenerateFn>();
    const node = createRevisionGuardNode({ generate });
    const run = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: PASSAGE_INTENT,
      'draft.initial': { title: '第二章', text: '前文。战斗开始了。后文。' }, // 无 passageText
    });
    const result = await node.run({ run, requirement: '' });

    expect(result.stateKey).toBe('revision_guard');
    const artifact = result.artifact as { error?: boolean; message?: string };
    expect(artifact.error).toBe(true);
    expect(artifact.message).toContain('passageText');
    expect(generate).not.toHaveBeenCalled(); // L1 后、L2 前就 error（draft 缺字段）
  });

  it('force-accept（art-mode）：resume 重跑 soft-violation + guardOverride → splice + forceAccepted 标记', async () => {
    // resume 场景：revision_guard 已是 soft-violation（pause 时产）+ revision_guard_override=force-accept。
    const generate = vi.fn<GenerateFn>(); // force-accept 不调 L2（直接 splice）
    const node = createRevisionGuardNode({ generate });
    const run = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: PASSAGE_INTENT,
      'draft.initial': { ...PASSAGE_DRAFT }, // text=改前 + passageText=改后（pause 时未 splice）
      revision_guard_override: 'force-accept',
      revision_guard: {
        // pause 时产的 soft-violation guard（含 findings + before/after）
        verdict: 'soft-violation',
        findings: [
          { pattern: 'tone-rhythm-cut', violatedScope: 'tone', authority: 'soft', evidence: { before: 'b', after: 'a', explanation: '删语气词' } },
        ],
        beforeText: '战斗开始了',
        afterText: '战斗惨烈地开始了', // 对齐 quote 无句号（splice quote→afterText 逐字替换）
        summary: '软锁越界',
      },
    });
    const result = await node.run({ run, requirement: '' });

    // force-accept → splice 落 draft.initial。
    expect(result.stateKey).toBe('draft.initial');
    const artifact = result.artifact as { text: string; passageText?: string };
    expect(artifact.text).toBe('前文。战斗惨烈地开始了。后文。'); // splice 后
    expect(artifact.passageText).toBeUndefined();

    // guard 标 forceAccepted（保留原 soft findings 可观测）。
    const guard = run.artifacts['revision_guard'] as {
      verdict: string;
      forceAccepted?: boolean;
      findings: unknown[];
    };
    expect(guard.verdict).toBe('clean');
    expect(guard.forceAccepted).toBe(true);
    expect(guard.findings).toHaveLength(1); // 原 soft findings 保留

    // L2 未调（force-accept 走 splice 短路，不重判）。
    expect(generate).not.toHaveBeenCalled();
  });

  it('clean 但 splice 定位失败（quote 不在 previous draft）→ error artifact（mirror 7.1 F1）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeGuardResult({ verdict: 'clean', findings: [], summary: '保义通过' }),
    );
    const node = createRevisionGuardNode({ generate });
    const run = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: PASSAGE_INTENT, // quote「战斗开始了」
      'draft.initial': {
        title: '第二章',
        text: '完全不同的正文，quote 不在。', // previousFullText 不含 quote
        passageText: '新段落',
      },
    });
    const result = await node.run({ run, requirement: '' });

    // clean 但 splice locate-failed → error artifact（非静默，flag 重选）。
    expect(result.stateKey).toBe('revision_guard');
    const artifact = result.artifact as { error?: boolean; message?: string };
    expect(artifact.error).toBe(true);
    expect(artifact.message).toContain('段落定位失败');
  });

  it('buildPrompt 注入 L2 vars（6 类清单 + 逐词对照 + 锁定项 + 上下文）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeGuardResult({ verdict: 'clean', findings: [], summary: '' }),
    );
    const node = createRevisionGuardNode({ generate });
    await node.run({
      run: makeRun({
        chapter_brief: { goal: '战斗章' },
        revision_intent: PASSAGE_INTENT,
        'draft.initial': { ...PASSAGE_DRAFT },
      }),
      requirement: '',
    });
    const userContent = generate.mock.calls[0]?.[0]?.[0]?.content ?? '';
    // L2 user 段含改前/改后/锁定项/L1 hint/作者原话（revision-guard-agent.yaml 的 6 类清单在 system 段）。
    expect(userContent).toContain('战斗开始了'); // beforeText（选区 quote）
    expect(userContent).toContain('战斗惨烈地开始了'); // afterText（passageText）
    expect(userContent).toContain('角色性格'); // lockedItems field
    expect(userContent).toContain('这段战斗改紧张点'); // userInstruction 硬权威
  });

  // ── Story 7.4 §1.6：structuralEdit 联动（revision-guard 放行码注入）──

  it('Story 7.4 §1.6：structuralEdit=true（段落级，带 scope）→ L2 prompt 含结构编辑放行码', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeGuardResult({ verdict: 'clean', findings: [], summary: '结构编辑放行' }),
    );
    const node = createRevisionGuardNode({ generate });
    // structuralEdit=true + 段落级 scope（Step 5 auto_revise 段落级结构改稿形态）。
    await node.run({
      run: makeRun({
        chapter_brief: { goal: '结构编辑章' },
        revision_intent: { ...PASSAGE_INTENT, structuralEdit: true },
        'draft.initial': { ...PASSAGE_DRAFT },
      }),
      requirement: '',
    });
    const userContent = generate.mock.calls[0]?.[0]?.[0]?.content ?? '';
    // §1.6 放行码注入：L2 prompt 含「结构编辑标记」段（故意的结构改动不算漂移，只查顺手越界锁定项）。
    expect(userContent).toContain('结构编辑标记');
    expect(userContent).toContain('故意的结构改动'); // 放行语义
  });

  it('Story 7.4 §1.6：structuralEdit 缺省（正常改稿）→ L2 prompt 不含结构编辑放行码（零回归）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeGuardResult({ verdict: 'clean', findings: [], summary: '' }),
    );
    const node = createRevisionGuardNode({ generate });
    await node.run({
      run: makeRun({
        chapter_brief: { goal: '战斗章' },
        revision_intent: PASSAGE_INTENT, // 无 structuralEdit（正常段落级改稿）
        'draft.initial': { ...PASSAGE_DRAFT },
      }),
      requirement: '',
    });
    const userContent = generate.mock.calls[0]?.[0]?.[0]?.content ?? '';
    // 无 structuralEdit → 放行码不注入（正常护栏 6 类全查，零回归）。
    expect(userContent).not.toContain('结构编辑标记');
    expect(userContent).not.toContain('故意的结构改动');
  });

  // ── BMad CR-007：structuralEdit 非布尔 → strip flag 保 intent（不丢整个 intent）──

  it('BMad CR-007：structuralEdit="true"（字符串非布尔）+ 段落级 scope → strip flag 保 intent（guard 正常运行不 skip）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeGuardResult({ verdict: 'clean', findings: [], summary: '正常护栏通过' }),
    );
    const node = createRevisionGuardNode({ generate });
    // structuralEdit="true"（LLM 常返字符串非布尔）+ 段落级 scope。
    // 旧代码：readRevisionIntent return undefined → guard skip（splice 不发生，redo 浪费迭代）。
    // CR-007：strip flag（视为未设=保守正常护栏）→ intent 保 → guard 正常运行 → splice 发生。
    const result = await node.run({
      run: makeRun({
        chapter_brief: { goal: '战斗章' },
        revision_intent: { ...PASSAGE_INTENT, structuralEdit: 'true' as unknown as boolean },
        'draft.initial': { ...PASSAGE_DRAFT },
      }),
      requirement: '',
    });

    // guard 运行了（非 skip）→ generate 被调（L2 裁判），非整章 skip 路径。
    expect(generate).toHaveBeenCalledTimes(1);
    // return draft.initial spliced（guard clean → splice 发生，选区段被换）。
    expect(result.stateKey).toBe('draft.initial');
    const artifact = result.artifact as { text: string; passageText?: string };
    expect(artifact.text).toBe('前文。战斗惨烈地开始了。后文。'); // splice 发生
    expect(artifact.passageText).toBeUndefined(); // splice 后 passageText 清除
    // L2 prompt 不含结构编辑放行码（structuralEdit 被 strip 为 undefined → 正常 6 类全查）。
    const userContent = generate.mock.calls[0]?.[0]?.[0]?.content ?? '';
    expect(userContent).not.toContain('结构编辑标记');
    expect(userContent).not.toContain('故意的结构改动');
  });

  it('Story 7.4 §1.6：structuralEdit=true 但无 scope（环 B 整章重写）→ guard 走整章 skip（不调 L2）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeGuardResult({ verdict: 'clean', findings: [], summary: '' }),
    );
    const node = createRevisionGuardNode({ generate });
    // 环 B 形态：structuralEdit=true 但无 scope.anchor（整章重写，buildStructuralEditIntent 产的 minimal intent）。
    const run = makeRun({
      chapter_brief: { goal: '结构编辑整章' },
      revision_intent: {
        change: { summary: '结构编辑后按新场景图重新生成正文' },
        lockedItems: [],
        rationale: { source: 'audit-finding', note: 'Director atomic-edit' },
        provenance: { rawUserInstruction: '(Director)', compilerNote: 'structuralEdit' },
        structuralEdit: true,
        // 无 scope（整章重写非段落精修）。
      },
      'draft.initial': { text: '整章正文' },
    });
    const result = await node.run({ run, requirement: '' });
    // 无 scope.anchor → guard 走整章 skip 路径（无 before/after 可比），不调 generate（L2）。
    expect(generate).not.toHaveBeenCalled();
    // return draft.initial 原样 + mutate revision_guard skipped 标记（零回归：flag 携带但不触发 L2）。
    expect(result.stateKey).toBe('draft.initial');
    const guard = run.artifacts['revision_guard'] as { skipped?: boolean; verdict?: string } | undefined;
    expect(guard?.skipped).toBe(true);
    expect(guard?.verdict).toBe('clean');
  });
});
