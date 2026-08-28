import { describe, expect, it, vi, beforeEach } from 'vitest';

// CR-006：mock @orison/shared-contracts 让 computeCompletenessCandidates 可控（默认 delegate 到 actual，
// 不影响其他测试；L1 throw 测试用 mockImplementationOnce 局部覆盖）。vi.mock hoist 到所有 import 前。
vi.mock('@orison/shared-contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/shared-contracts')>();
  return {
    ...actual,
    computeCompletenessCandidates: vi.fn(actual.computeCompletenessCandidates),
  };
});

// Story 8.7 S9：mock registry（mirror world-state-query-equivalence.test.ts 模式）——L1 出场间隔计数
// 经 mention-query 取数（registry 内部直调）。mockGet 控制工具可见性；默认 undefined = 工具环境不可用
// （既有测试零回归——fetch graceful 不加 appearanceGaps 字段）。
let mockGet: ((id: string) => unknown) | undefined;
vi.mock('../src/tool/registry', () => ({
  registry: {
    get: (id: string) => mockGet?.(id),
  },
}));

import {
  computeCompletenessCandidates,
  COMPLETENESS_VERIFY_RESULT_KEY,
  completenessVerifyResultSchema,
} from '@orison/shared-contracts';
import { createCompletenessVerifyNode } from '../src/nodes/completeness-verify-node';
import { MAX_ATTEMPTS } from '../src/nodes/llm-node';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { GenerateResult } from '../src/provider/ipc-provider';
import type { RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.4 R2：completeness-verify-node 集成测（design §2-§5 / §8 graceful / AC6）。
//
// 测三块（implement.md Step 7.1）：
// 1. L1 候选注入 + L2 generate mock + parse → completeness_verify_result artifact（shape + stateKey）。
// 2. AC6 fallback：L2 parse 失败 → findings=[] + degraded=true + summary 标注（永不假 pass）。
// 3. graceful：所有数据源缺 → L1 降级空候选 + L2 仍跑 + degraded=true 标注（不崩链）。
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_completeness',
    status: 'running',
    currentNodeId: null,
    projectPath: '/test/project',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}

function makeOkResult(json: object): GenerateResult {
  return { content: JSON.stringify(json), finishReason: 'stop' };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. L1 候选注入 + L2 parse → completeness_verify_result artifact
// ════════════════════════════════════════════════════════════════════════════

describe('completeness-verify-node — L1→L2 happy path', () => {
  it('累积 artifacts → L1 候选汇编 → L2 generate → parse → completeness_verify_result（stateKey + shape）', async () => {
    const validResult = {
      findings: [
        {
          category: 'arc',
          verdict: 'under-developed',
          entityId: 'char-1',
          entityLabel: '主角成长弧',
          quote: '正文原句片段',
          location: '段3',
          explanation: 'wound_or_lack 未体现',
          suggestedFix: '下章安排觉察场',
        },
      ],
      summary: '发现 1 处角色弧 under-developed',
    };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(validResult));
    const node = createCompletenessVerifyNode({ generate });

    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: '本章正文……' },
      }),
      requirement: '',
    });

    expect(result.stateKey).toBe(COMPLETENESS_VERIFY_RESULT_KEY);
    const artifact = result.artifact as { findings: unknown[]; summary: string };
    expect(artifact.findings).toHaveLength(1);
    expect(artifact.summary).toBe('发现 1 处角色弧 under-developed');
    // generate 被调一次（首次 parse 成功，无重试）
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('buildPrompt：draftText + candidates + writtenChapters 三 var 注入 user prompt', async () => {
    const validResult = { findings: [], summary: '无缺漏', degraded: false };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(validResult));
    const node = createCompletenessVerifyNode({ generate });

    await node.run({
      run: makeRun({
        'draft.initial': { text: '本章正文 XYZ' },
        'chapter_brief_input': { episodeId: 'ep_target', brief: { goal: 'g' } },
        // episode_outlines 条目含 index（episodeOutlineSchema required）——deriveWrittenEpisodeIds 按
        // index <= currentEpisodeId.index 派生已写集（mirror 5.3 isDeadlinePassed index 排序哲学）。
        // ep_other index=0 < ep_target index=1 → ep_other 也是已写（之前的章）；两 id 均进 writtenChapters。
        'episode_outlines': [
          { id: 'ep_other', index: 0, title: '前章' },
          { id: 'ep_target', index: 1, title: '本章' },
        ],
        'growth_curve': [
          {
            character_id: 'char-1',
            start_state: '起点',
            turning_points: [],
            linked_episode_ids: [],
          },
        ],
      }),
      requirement: '',
    });

    const [messages, , , , opts] = generate.mock.calls[0];
    const userContent = messages[0]?.content ?? '';
    // draftText 注入
    expect(userContent).toContain('本章正文 XYZ');
    // candidates 注入（L1 候选报告 JSON 序列化）——含 character_id（L1 汇编产出）
    expect(userContent).toContain('char-1');
    // writtenChapters 注入（已写 episode id + title 列表）——两 episode 均 index<=current，都进已写集
    expect(userContent).toContain('ep_target');
    expect(userContent).toContain('ep_other');
    // modelRef 透传（deps 无 modelRef → undefined）
    expect(opts?.modelRef).toBeUndefined();
  });

  it('deriveWrittenEpisodeIds 按 index 排序：未来 episode（index > current）不进 writtenChapters（mirror 5.3 isDeadlinePassed，防假 deadlinePassed 机械事实）', async () => {
    const validResult = { findings: [], summary: '无缺漏' };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(validResult));
    const node = createCompletenessVerifyNode({ generate });

    await node.run({
      run: makeRun({
        'draft.initial': { text: '正文' },
        // current = ep_now（index=1）；ep_past（index=0）已写；ep_future（index=2）未来未写。
        'chapter_brief_input': { episodeId: 'ep_now' },
        'episode_outlines': [
          { id: 'ep_past', index: 0, title: '过去章' },
          { id: 'ep_now', index: 1, title: '本章' },
          { id: 'ep_future', index: 2, title: '未来章' },
        ],
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // ep_past + ep_now 在 writtenChapters（index <= 1）
    expect(userContent).toContain('ep_past');
    expect(userContent).toContain('ep_now');
    // ep_future 不在 writtenChapters（index 2 > current 1）——防假 deadlinePassed 机械事实
    expect(userContent).not.toContain('ep_future');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. AC6 fallback：L2 parse 失败 → findings=[] + degraded=true（永不假 pass）
// ════════════════════════════════════════════════════════════════════════════

describe('completeness-verify-node — AC6 fallback', () => {
  it('L2 持续 parse 失败 → fallback artifact（findings=[] + degraded=true，mirror R6① 永不假 pass）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ random: 'not the expected shape' }));
    const node = createCompletenessVerifyNode({ generate });

    const result = await node.run({
      run: makeRun({ 'draft.initial': { text: '正文' } }),
      requirement: '',
    });

    // 重试 MAX_ATTEMPTS 次后 fallback
    expect(generate).toHaveBeenCalledTimes(MAX_ATTEMPTS); // CR-010：常量引用替代硬编码（mirror createReaderAuditNode）
    expect(result.stateKey).toBe(COMPLETENESS_VERIFY_RESULT_KEY);
    const artifact = result.artifact as {
      findings: unknown[];
      summary: string;
      degraded: boolean;
      degradationNote?: string;
    };
    expect(artifact.findings).toEqual([]);
    expect(artifact.degraded).toBe(true);
    expect(artifact.summary).toContain('解析失败');
    expect(artifact.degradationNote).toContain('L2 parse 失败');
  });

  it('L2 返非法 category → schema 拒 → 重试 → fallback', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({
      findings: [
        {
          category: 'custom-not-in-enum', // 非封闭 enum
          verdict: 'missing',
          entityId: 'x',
          entityLabel: 'x',
          quote: 'q',
          location: 'l',
          explanation: 'e',
          suggestedFix: 'f',
        },
      ],
      summary: 's',
    }));
    const node = createCompletenessVerifyNode({ generate });

    const result = await node.run({
      run: makeRun({ 'draft.initial': { text: '正文' } }),
      requirement: '',
    });

    expect(generate).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(result.stateKey).toBe(COMPLETENESS_VERIFY_RESULT_KEY);
    expect((result.artifact as { degraded: boolean }).degraded).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. graceful：所有数据源缺 → L1 降级 + L2 仍跑（不崩链）
// ════════════════════════════════════════════════════════════════════════════

describe('completeness-verify-node — graceful degradation', () => {
  it('所有数据源缺 → L1 降级空候选 + L2 仍跑（R6① 永不崩链）', async () => {
    const validResult = { findings: [], summary: '无缺漏（数据源缺）', degraded: true };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(validResult));
    const node = createCompletenessVerifyNode({ generate });

    const result = await node.run({
      run: makeRun({}), // 完全无 artifacts
      requirement: '',
    });

    // L2 仍跑了（generate 被调），节点不崩，产正常 artifact（非 fallback）
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.stateKey).toBe(COMPLETENESS_VERIFY_RESULT_KEY);
    const artifact = result.artifact as { degraded: boolean; findings: unknown[] };
    // L2 收到 degraded=true 候选报告 → prompt 段指示该类跳过不报 → findings=[]
    expect(artifact.findings).toEqual([]);
  });

  it('draft.initial 缺 → draftText 空串，L1 仍跑，L2 收空 draftText（graceful，零回归）', async () => {
    const validResult = { findings: [], summary: '无缺漏' };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(validResult));
    const node = createCompletenessVerifyNode({ generate });

    await node.run({
      run: makeRun({ /* 无 draft.initial */ }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // draftText 注入为空串（yaml 模板塌成空行，零回归）
    // candidates 仍注入（L1 候选报告，degraded=true）——yaml 用中文「候选报告」标签
    expect(userContent).toContain('候选报告');
    expect(userContent).toContain('degraded'); // degraded=true 标注透传到 L2 prompt
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. schema-acceptance（5 类 fixture，mirror 6.2/5.4 测试既定模式）
// ════════════════════════════════════════════════════════════════════════════

describe('completeness-verify-node — schema-acceptance 5 类 finding', () => {
  it('L2 返 5 类各一 finding → schema parse 通过（验证 schema 不拒 completeness finding）', async () => {
    const fiveCategoryFindings = {
      findings: [
        {
          category: 'arc',
          verdict: 'under-developed',
          entityId: 'char-1',
          entityLabel: '主角成长弧',
          quote: '正文 A',
          location: '段1',
          explanation: 'e1',
          suggestedFix: 'f1',
        },
        {
          category: 'line',
          verdict: 'missing',
          entityId: 'line-1',
          entityLabel: '主线',
          quote: '正文 B',
          location: '段2',
          explanation: 'e2',
          suggestedFix: 'f2',
        },
        {
          category: 'emotion-arc',
          verdict: 'missing',
          entityId: 'emotion-arc',
          entityLabel: '跨弧情绪弧',
          quote: '正文 C',
          location: '段3',
          explanation: 'e3',
          suggestedFix: 'f3',
        },
        {
          category: 'promise',
          verdict: 'missing',
          entityId: 'promise-1',
          entityLabel: 'Promise：密信',
          quote: '正文 D',
          location: '段4',
          explanation: 'e4',
          suggestedFix: 'f4',
        },
        {
          category: 'theme',
          verdict: 'under-developed',
          entityId: '救赎',
          entityLabel: '主题：救赎',
          quote: '正文 E',
          location: '段5',
          explanation: 'e5',
          suggestedFix: 'f5',
        },
      ],
      summary: '5 类缺漏汇总',
    };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(fiveCategoryFindings));
    const node = createCompletenessVerifyNode({ generate });

    const result = await node.run({
      run: makeRun({ 'draft.initial': { text: '正文' } }),
      requirement: '',
    });

    expect(result.stateKey).toBe(COMPLETENESS_VERIFY_RESULT_KEY);
    const artifact = result.artifact;
    // artifact 应通过 schema（不抛），含 5 类 finding
    const parsed = completenessVerifyResultSchema.parse(artifact);
    expect(parsed.findings).toHaveLength(5);
    const categories = parsed.findings.map((f) => f.category);
    expect(categories).toEqual(['arc', 'line', 'emotion-arc', 'promise', 'theme']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. L1 throw → fallback 分支（CR-006 补测试覆盖）
// ════════════════════════════════════════════════════════════════════════════

describe('completeness-verify-node — L1 throw fallback（CR-006）', () => {
  it('computeCompletenessCandidates 抛错 → 降级 artifact（degraded=true + degradationNote）+ L2 仍跑 + stateKey 正确', async () => {
    // CR-001 修复后 compute 内部按类 try/catch，单类坏数据不抛——这里 mock 整体抛测节点级 catch 分支（:242-258）。
    vi.mocked(computeCompletenessCandidates).mockImplementationOnce(() => {
      throw new Error('L1 内部异常测试');
    });
    const validResult = { findings: [], summary: '无缺漏', degraded: true };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(validResult));
    const node = createCompletenessVerifyNode({ generate });

    const result = await node.run({
      run: makeRun({ 'draft.initial': { text: '正文' } }),
      requirement: '',
    });

    // L2 仍跑了（generate 被调，节点不崩，产正常 artifact 非 L2 parse fallback）
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.stateKey).toBe(COMPLETENESS_VERIFY_RESULT_KEY);
    // candidates 已降级（L1 catch 兜底），L2 收 degraded=true 候选报告
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('L1 候选汇编异常');
    // artifact shape 正常（L2 parse 成功，非 L2 fallback）
    const artifact = result.artifact as { findings: unknown[]; degraded: boolean };
    expect(artifact.findings).toEqual([]);
  });

  it('L2 generate 抛 AbortError → 重抛不吞成 fallback artifact（CR-006 :282 isAbortError 重抛路径）', async () => {
    // isAbortError 检测 err.name === 'AbortError'（llm-node.ts:161-165）。L2 generate retry loop 内
    // isAbortError 命中 → throw err（取消语义：传播，不吞成 fallback artifact）。
    const abortErr = new DOMException('aborted', 'AbortError');
    const generate = vi.fn<GenerateFn>(async () => {
      throw abortErr;
    });
    const node = createCompletenessVerifyNode({ generate });

    await expect(
      node.run({
        run: makeRun({ 'draft.initial': { text: '正文' } }),
        requirement: '',
      }),
    ).rejects.toBe(abortErr);
    // 只调一次（首次抛 AbortError 立即重抛，不重试不 fallback）
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Story 8.7 S9：L1 出场间隔计数信号（design §2.4 编译面——纯计数不判意义红线）
// ════════════════════════════════════════════════════════════════════════════

/** 本章 scene_graph（场挂 episodeId + storyTime——resolveAnchorStoryTime 锚源）。 */
const S9_SCENE_GRAPH = {
  lines: [],
  nodes: [
    { id: 's1', lineTags: [], storyTime: 100, presentationOrder: { chapter: 9, pos: 0 }, episodeId: 'ep_now' },
  ],
};

/** 注册三取数工具（出场账/章摘要/世界状态——metadata 形态 mirror shell handlers 实产）。 */
function registerS9Tools(opts: { mentionRows?: Array<Record<string, unknown>>; summaries?: Array<Record<string, unknown>>; patches?: unknown[] }): void {
  mockGet = (id: string) => {
    const exec = async (params: Record<string, unknown>) => {
      if (id === 'query_mentions') {
        return { title: id, output: '', metadata: { ok: true, view: 'ledger', count: opts.mentionRows?.length ?? 0, rows: opts.mentionRows ?? [] } };
      }
      if (id === 'query_chapter_summary') {
        void params;
        return { title: id, output: '', metadata: { ok: true, count: opts.summaries?.length ?? 0, summaries: opts.summaries ?? [] } };
      }
      return { title: id, output: '', metadata: { ok: true, count: 1, slices: [{ patches: opts.patches ?? [] }] } };
    };
    return { id, description: `fake ${id}`, parameters: {}, execute: exec };
  };
}

describe('completeness-verify-node — S9 L1 出场间隔计数（纯计数信号）', () => {
  beforeEach(() => {
    mockGet = undefined;
  });

  it('anchor 在 + 出场账在 → appearanceGaps 机械事实进 candidates（entryId/最后露面章/间隔/口径——无任何判断词）', async () => {
    registerS9Tools({
      mentionRows: [
        {
          projectId: '00001', episodeId: 'ep-2', entryId: 'char-mei', presence: 'mentioned',
          declared: 1, presenceShot: 0, coarseHit: 1, planLinked: 0, coarseCount: 1, stateChanged: 0,
          source: 'full', updatedAt: '2026-08-19 00:00:00',
        },
      ],
      summaries: [{ episodeId: 'ep-2', episodeIndex: 2, storyTimeEnd: 40, summary: { storyTimeStart: 30 }, tokenEstimate: 10, truncated: false, patchRowidHigh: 0 }],
      patches: [],
    });
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ findings: [], summary: '无缺漏' }));
    const node = createCompletenessVerifyNode({ generate });

    await node.run({
      run: makeRun({
        'draft.initial': { text: '正文' },
        'chapter_brief_input': { episodeId: 'ep_now' },
        'scene_graph': S9_SCENE_GRAPH,
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // appearanceGaps 字段出现 + 机械事实四件（纯计数断言——字段即事实，无 verdict/judgment 字段）。
    expect(userContent).toContain('appearanceGaps');
    expect(userContent).toContain('"entryId":"char-mei"');
    expect(userContent).toContain('"lastEpisodeId":"ep-2"');
    expect(userContent).toContain('"storyTimeGap":60'); // anchor 100 - 窗 end 40
    expect(userContent).toContain('"basis":"mention"');
    // 红线：L1 输入不含判断词（「该出场/遗忘」归 L2——candidates 只携带机械字段）。
    expect(userContent).not.toContain('appearanceGaps":[{"entryId":"char-mei","verdict"');
  });

  it('工具环境不可用（registry 空）+ anchor 在 → appearanceGapNote 如实标注（查不了≠查了没有）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ findings: [], summary: '无缺漏' }));
    const node = createCompletenessVerifyNode({ generate });

    await node.run({
      run: makeRun({
        'draft.initial': { text: '正文' },
        'chapter_brief_input': { episodeId: 'ep_now' },
        'scene_graph': S9_SCENE_GRAPH,
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('appearanceGapNote');
    expect(userContent).toContain('出场间隔统计不可用');
    // ⚠ 用 JSON 键精确标记（'"appearanceGaps":'）——yaml user 模板的 appearanceGaps 说明段也含裸词
    // 「appearanceGaps」，裸子串断言会误命中模板文本。
    expect(userContent).not.toContain('"appearanceGaps":');
  });

  it('scene_graph 缺（anchor 不可解析）→ 零打扰：无 appearanceGaps 也无 note（既有行为零回归）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ findings: [], summary: '无缺漏' }));
    const node = createCompletenessVerifyNode({ generate });

    await node.run({
      run: makeRun({
        'draft.initial': { text: '正文' },
        'chapter_brief_input': { episodeId: 'ep_now' },
        // 无 scene_graph → resolveAnchorStoryTime undefined → 不取数不加字段。
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).not.toContain('"appearanceGaps":');
    expect(userContent).not.toContain('"appearanceGapNote"');
  });
});
