import { describe, expect, it } from 'vitest';
import {
  compileReportSchema,
  episodeOutlineSchema,
  estimateTextTokens,
  promiseRegistrySchema,
  sceneNodeSchema,
  selectScenesForEpisode,
  type CompileReport,
  type SceneGraph,
} from '@orison/shared-contracts';
import { createBriefCompilerNode } from '../src/nodes/brief-compiler-node';
import { summarizeRunSnapshot } from '../src/runtime/chainRunner';
import type { RunSnapshot } from '../src/contracts/run';

// ── Story 8.4 B1/B2（design §2.1/§2.2）：brief-compiler-node 热层度量汇总点接线 + summarize 透出 ──
//
// 汇总点（D3）：settings_context_report（assemble 产）+ 本节点 brief 侧段估算 → 汇总判档 →
// compile_report 伴生 artifact（mutate 落盘，mirror 7.2 revision-guard）→ summarizeRunSnapshot 透出
// summary.compileReport（mirror 章摘要 tokenEstimate 先例）。
//
// 零回归锚：正常规模（L0 恒真）chapter_brief 产物逐字段不变（既有 brief-compiler-node.test.ts 全绿 +
// 此处 goal/plotPoints 点检）；降级路径经 fake settings 段报告数字驱动（token_estimate 是机械量，虚报
// 即等价「设定侧膨胀」——无需 96K 字符 fixture）。

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_compile_report',
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

const EPISODES = [
  episodeOutlineSchema.parse({ id: 'ep1', index: 0, title: '第一章' }),
];

function buildSceneGraph(): SceneGraph {
  return {
    nodes: [
      sceneNodeSchema.parse({ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }),
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };
}

/** 本章 promise beat fixture（brief #7 编译源）。 */
function buildPromiseRegistry() {
  return promiseRegistrySchema.parse({
    promises: [{ id: 'p1', title: '国王的佩剑', summary: '壁上佩剑将在终章出鞘。' }],
    beats: [{ id: 'b1', promiseId: 'p1', episodeId: 'ep1', sceneRef: 's1', kind: 'plant' }],
    version: 0,
  });
}

const SETTINGS_REPORT = [
  { name: 'settings:设定目录', token_estimate: 120 },
  { name: 'settings:世界设定', token_estimate: 80 },
];

describe('brief-compiler-node — compile_report 伴生 artifact（B1 汇总点）', () => {
  it('正常规模（L0）：报告落 artifact，total = 两编译点段和，无 degraded；chapter_brief 产物不变', async () => {
    const node = createBriefCompilerNode();
    const run = makeRun({
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: '主角进城' } },
      scene_graph: buildSceneGraph(),
      episode_outlines: EPISODES,
      promise_registry: buildPromiseRegistry(),
      settings_context_report: SETTINGS_REPORT,
    });
    const result = await node.run({ run, requirement: '' });

    const report = run.artifacts['compile_report'] as CompileReport;
    expect(report).toBeDefined();
    expect(report.overloaded).toBe(false);
    expect(report.degraded).toBeUndefined();
    // 汇总 = settings 段（200）+ brief 段（含 settings: 前缀两条 + brief 侧条目）
    const settingsSum = SETTINGS_REPORT.reduce((a, s) => a + s.token_estimate, 0);
    const briefSum = report.segments
      .filter((s) => !s.name.startsWith('settings:'))
      .reduce((a, s) => a + s.token_estimate, 0);
    expect(report.total).toBe(settingsSum + briefSum);
    expect(report.segments.some((s) => s.name === 'settings:设定目录')).toBe(true);
    expect(report.segments.some((s) => s.name === 'goal')).toBe(true);
    // L0 零回归：brief 产物照常编译（goal 透传 + plotPoints 汇编 + promiseTasks #7）
    const brief = result.artifact as Record<string, unknown>;
    expect(brief.goal).toBe('主角进城');
    expect(brief.plotPoints).toEqual([{ sceneId: 's1', continuity: '本章内', stateAtT: undefined }]);
    expect(brief.promiseTasks).toHaveLength(1);
  });

  it('settings_context_report 缺（旧 chainSnapshot resume / 手构 fixture）→ graceful []，报告照产（brief 单边）', async () => {
    const node = createBriefCompilerNode();
    const run = makeRun({
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: '主角进城' } },
      scene_graph: buildSceneGraph(),
    });
    await node.run({ run, requirement: '' });
    const report = run.artifacts['compile_report'] as CompileReport;
    expect(report).toBeDefined();
    expect(report.segments.every((s) => !s.name.startsWith('settings:'))).toBe(true);
  });

  it('设定侧膨胀（fake 段数字虚报 ≥ TH_MOVE）→ L2 降级 brief 侧纯代码汇编段 + overloaded=true（L3）', async () => {
    const node = createBriefCompilerNode();
    const run = makeRun({
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: '主角进城', mustHide: '密道' } },
      scene_graph: buildSceneGraph(),
      episode_outlines: EPISODES,
      promise_registry: buildPromiseRegistry(),
      // 虚报设定侧膨胀：150K tokens ≥ TH_MOVE(96K)——settings 侧无降级动作，梯移空 brief 侧后仍 > TH_HARD(128K)。
      settings_context_report: [{ name: 'settings:设定目录', token_estimate: 150_000 }],
    });
    const result = await node.run({ run, requirement: '' });

    const report = run.artifacts['compile_report'] as CompileReport;
    expect(report.overloaded).toBe(true);
    expect(report.degraded).toBeDefined();
    // 纯代码汇编段被移出（promiseTasks / plotPoints——梯耗尽，settings 500 恒 ≥ move）
    const brief = result.artifact as Record<string, unknown>;
    expect(brief.promiseTasks).toBeUndefined();
    expect(brief.plotPoints).toBeUndefined();
    // 铁律段不动（goal / mustHide）
    expect(brief.goal).toBe('主角进城');
    expect(brief.mustHide).toBe('密道');
    // 报告段 = settings 段 + 降级后 brief 段（写手实际收到什么）
    expect(report.segments.some((s) => s.name === 'goal')).toBe(true);
    expect(report.segments.some((s) => s.name === 'promise_tasks')).toBe(false);
  });

  it('contract producedArtifactKeys 含 compile_report（may-produce 声明，mirror revision-guard）', () => {
    const node = createBriefCompilerNode();
    expect(node.contract?.producedArtifactKeys).toContain('chapter_brief');
    expect(node.contract?.producedArtifactKeys).toContain('compile_report');
  });

  // ── R2-盲1（2026-08-19）：L1 触发 + 零降级动作（无可裁）→ degraded 不落空 []（summarize 拒收链）──

  it('R2-盲1：设定侧膨胀撑进 L1 + brief 侧无可裁（stateAtT 缺 → 收窄 no-op）→ 报告无 degraded 字段且 schema 过，summarize 照常透出', async () => {
    const node = createBriefCompilerNode();
    const run = makeRun({
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: '主角进城' } },
      scene_graph: buildSceneGraph(),
      episode_outlines: EPISODES,
      // 70K ∈ [TH_WARN 64K, TH_MOVE 96K) → L1；测试环境 fetchWorldStateSnapshotsViaTool 无工具 →
      // stateAtT 全 undefined → plot_points_state 段缺 → L1 收窄零动作（无可裁——本条靶场景）。
      settings_context_report: [{ name: 'settings:设定目录', token_estimate: 70_000 }],
    });
    await node.run({ run, requirement: '' });

    const report = run.artifacts['compile_report'] as CompileReport;
    // 修复前：degraded=[]（空数组）→ compileReportSchema .min(1) 拒收 → summarize 丢 compileReport。
    expect(report.degraded).toBeUndefined();
    expect('degraded' in report).toBe(false);
    expect(report.overloaded).toBe(false);
    expect(compileReportSchema.safeParse(report).success).toBe(true);
    // summarize 级锚：safeParse 守形放行 → summary.compileReport 透出（L3 文案链的上游前提）。
    const summary = summarizeRunSnapshot({ ...run, status: 'completed' });
    expect(summary.compileReport).toBeDefined();
    expect(summary.compileReport?.total).toBe(report.total);
  });

  // ── R2-盲5（2026-08-19）：story_plan 段（写手稳定前缀 {{storyPlan}} 直注块）进计量 ──

  it('R2-盲5：story_plan 段进报告（与 selectScenesForEpisode 投影同源）+ total 含它', async () => {
    const node = createBriefCompilerNode();
    const sceneGraph = buildSceneGraph();
    const run = makeRun({
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: '主角进城' } },
      scene_graph: sceneGraph,
      episode_outlines: EPISODES,
      settings_context_report: SETTINGS_REPORT,
    });
    const result = await node.run({ run, requirement: '' });

    const report = run.artifacts['compile_report'] as CompileReport;
    const storyPlan = report.segments.find((s) => s.name === 'story_plan');
    expect(storyPlan).toBeDefined();
    // 段估算与写手稳定前缀渲染同源（buildDraftWriterVars 同一投影 + 同 JSON 序列化）。
    expect(storyPlan!.token_estimate).toBe(
      estimateTextTokens(JSON.stringify(selectScenesForEpisode(sceneGraph, 'ep1'))),
    );
    // total 含它（token_estimate 是机械量——段在报告内即计入汇总）。
    expect(report.total).toBeGreaterThanOrEqual(storyPlan!.token_estimate);
    // chapter_brief 产物不含 story_plan（段是计量投影，非 brief 字段——写手侧另有 {{storyPlan}} 注入）。
    expect((result.artifact as Record<string, unknown>).storyPlan).toBeUndefined();
  });
});

describe('summarizeRunSnapshot — compileReport 透出（B1，mirror 章摘要 tokenEstimate）', () => {
  const REPORT: CompileReport = {
    segments: [{ name: 'goal', token_estimate: 42 }],
    total: 42,
    overloaded: false,
  };

  function snapshotWithCompileReport(artifact: unknown): RunSnapshot {
    return { ...makeRun({ compile_report: artifact }), status: 'completed' };
  }

  it('compile_report artifact 在 → summary.compileReport 透出', () => {
    const summary = summarizeRunSnapshot(snapshotWithCompileReport(REPORT));
    expect(summary.compileReport).toEqual(REPORT);
  });

  it('artifact 缺 / 坏形态 → 缺省（防御性丢，零痕迹）', () => {
    expect(summarizeRunSnapshot(snapshotWithCompileReport(undefined)).compileReport).toBeUndefined();
    expect(summarizeRunSnapshot(makeRun({})).compileReport).toBeUndefined();
    expect(
      summarizeRunSnapshot(snapshotWithCompileReport({ segments: [], total: -1 })).compileReport,
    ).toBeUndefined(); // schema reject（segments .min(1) / total .min(0)）→ 防御丢
  });
});
