import { describe, expect, it } from 'vitest';
import { lintChapterReportSchema } from '@orison/shared-contracts';
import { createLintNode, LINT_REPORT_KEY } from '../src/nodes/lint-node';
import type { LintEngine } from '../src/lint/lintEngine';
import type { RunSnapshot } from '../src/contracts/run';

// ── C1.2 Step 4：lint-node 链段静态扫描节点测试（implement.md Step 4）──
//
// 覆盖：产 lint_report artifact（agent 桥投影 + schema 契约面）/ draft 缺位降级 / 引擎 null 降级 /
// 扫描异常降级 / redo 幂等（纯函数 over artifacts——同输入两次运行同报告）。
//
// 样例纪律（mirror lintEngine.test.ts）：命中样例钉在 vendored commit 7b0e5a0 的确定性触发文本
// 「他不是怯懦，而是清醒。」（story-deslop.not-is-comparison handler 命中，review=agent level=high）。

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_lint_node',
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

/** 触发文本（agent 桶命中：story-deslop.not-is-comparison，handler 状态机「不是A，而是B」）。 */
const HIT_TEXT = '他不是怯懦，而是清醒。清醒得近乎冷酷。';

/** 对照文本（无 lint 命中——降级断言的干净基线）。 */
const CLEAN_TEXT = '他把伞收起来，雨还没有停。她转身进了门。';

function makeArtifacts(text: string): Record<string, unknown> {
  return {
    'draft.initial': { text, wordCount: 20, chapterId: 'ep-1' },
    chapter_brief_input: { episodeId: 'ep-1', brief: { goal: 'g' } },
  };
}

describe('lint-node 产 lint_report artifact', () => {
  it('命中样例：agent 桶 issues 注入 + schema 契约面通过 + chapterId 取 episodeId', async () => {
    const node = createLintNode();
    const result = await node.run({ run: makeRun(makeArtifacts(HIT_TEXT)), requirement: '' });

    expect(result.stateKey).toBe(LINT_REPORT_KEY);
    // schema 契约面（LintChapterReport，链段 artifact 即此形态）
    expect(() => lintChapterReportSchema.parse(result.artifact)).not.toThrow();
    const report = lintChapterReportSchema.parse(result.artifact);
    expect(report.chapterId).toBe('ep-1');
    // 「不是A，而是B」handler 命中（agent 桶，review=agent）
    expect(report.issues.map((i) => i.ruleId)).toContain('story-deslop.not-is-comparison');
    // agent 桶投影（design §2「链段内消费 review=agent 桶」）：全量命中里 review=human/none 的不进
    expect(report.issues.every((i) => i.review === 'agent')).toBe(true);
    expect(report.summary.total).toBe(report.issues.length);
    expect(report.summary.visibleChars).toBeGreaterThan(0);
  });

  it('对照样例：无命中 → 空 issues 的合法 report（非降级——正常扫描零命中，degraded 缺省）', async () => {
    const node = createLintNode();
    const result = await node.run({ run: makeRun(makeArtifacts(CLEAN_TEXT)), requirement: '' });

    const report = lintChapterReportSchema.parse(result.artifact);
    expect(report.chapterId).toBe('ep-1');
    expect(report.issues).toEqual([]);
    expect(report.summary.total).toBe(0);
    expect(report.degraded).toBeUndefined(); // 引擎真跑过的诚实结果（CR-007：干净章 ≠ 降级章）
  });
});

describe('lint-node 降级（graceful，不破链）', () => {
  it('draft.initial 缺位 → 空 report + degraded 标记（stateKey 仍 lint_report，不抛不 error artifact）', async () => {
    const node = createLintNode();
    const result = await node.run({
      run: makeRun({ chapter_brief_input: { episodeId: 'ep-1' } }),
      requirement: '',
    });

    expect(result.stateKey).toBe(LINT_REPORT_KEY);
    const report = lintChapterReportSchema.parse(result.artifact);
    expect(report.issues).toEqual([]);
    expect(report.summary.total).toBe(0);
    expect(report.degraded).toBe(true); // CR-007：issues 空 ≠ 干净章——降级产物可区分
    expect(report.summary.visibleChars).toBe(0); // 诚实 0（引擎没跑不算字数）
  });

  it('draft.initial.text 空串 → 同降级空 report', async () => {
    const node = createLintNode();
    const result = await node.run({
      run: makeRun({ 'draft.initial': { text: '' }, chapter_brief_input: { episodeId: 'ep-1' } }),
      requirement: '',
    });

    const report = lintChapterReportSchema.parse(result.artifact);
    expect(report.issues).toEqual([]);
  });

  it('引擎 null（rulesets 装载失败）→ 空 report + degraded 降级', async () => {
    const node = createLintNode({ getEngine: async () => null });
    const result = await node.run({ run: makeRun(makeArtifacts(HIT_TEXT)), requirement: '' });

    expect(result.stateKey).toBe(LINT_REPORT_KEY);
    const report = lintChapterReportSchema.parse(result.artifact);
    expect(report.issues).toEqual([]);
    expect(report.degraded).toBe(true);
    expect(report.upstream.commit).toBeTruthy(); // 静态溯源常量仍在（描述 vendored 来源非装载声明）
  });

  it('引擎扫描抛错 → try/catch 兜底空 report + degraded（mirror Reader-Audit L1 E1 哲学）', async () => {
    const badEngine = {
      scanText: () => {
        throw new Error('boom');
      },
    } as unknown as LintEngine;
    const node = createLintNode({ getEngine: async () => badEngine });
    const result = await node.run({ run: makeRun(makeArtifacts(HIT_TEXT)), requirement: '' });

    expect(result.stateKey).toBe(LINT_REPORT_KEY);
    const report = lintChapterReportSchema.parse(result.artifact);
    expect(report.issues).toEqual([]);
    expect(report.degraded).toBe(true);
  });

  it('chapter_brief_input 缺 episodeId → chapterId 兜底 \'chain\'（schema 非空要求）', async () => {
    const node = createLintNode({ getEngine: async () => null });
    const result = await node.run({
      run: makeRun({ 'draft.initial': { text: HIT_TEXT } }),
      requirement: '',
    });
    const report = lintChapterReportSchema.parse(result.artifact);
    expect(report.chapterId).toBe('chain');
  });
});

describe('lint-node redo 幂等（纯函数 over artifacts）', () => {
  it('同一输入两次运行 → 产出报告 deep-equal（redo 重跑零副作用，design §3.1）', async () => {
    const node = createLintNode();
    const run = makeRun(makeArtifacts(HIT_TEXT));

    const first = await node.run({ run, requirement: '' });
    const second = await node.run({ run, requirement: '' });

    expect(second.artifact).toEqual(first.artifact);
  });

  it('真实引擎单例路径（缺省 getEngine）：同输入两次运行同报告（集成口径）', async () => {
    const node = createLintNode();
    const run = makeRun(makeArtifacts(HIT_TEXT));

    const first = await node.run({ run, requirement: '' });
    const second = await node.run({ run, requirement: '' });

    // 真实引擎在场（vendored rulesets 装载成功）——非空命中证明非降级路径。
    const report = lintChapterReportSchema.parse(first.artifact);
    expect(report.issues.length).toBeGreaterThan(0);
    expect(second.artifact).toEqual(first.artifact);
  });
});

describe('lint-node 契约', () => {
  it('contract：nodeId/required/produced/sideEffects（链段装配面）', () => {
    const node = createLintNode();
    expect(node.contract?.nodeId).toBe('lint-node');
    expect(node.contract?.requiredArtifactKeys).toEqual(['draft.initial']);
    expect(node.contract?.producedArtifactKeys).toEqual(['lint_report']);
    expect(node.contract?.sideEffects).toEqual([]);
  });
});
