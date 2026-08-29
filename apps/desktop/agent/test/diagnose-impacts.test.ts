import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4 Phase 2.1-2.4：diagnose_impacts tool 测试。
//
// 测四块（implement.md Phase 2 验证门）：
// 1. L1 候选缩小：narrowable（asset_cards）→ reverse-ref 缩小；non-narrowable（world_setting）→ 全图。
// 2. L2 dispatch：dispatchRippleDiagnosis 被调 + parse findings + 呈 leader。
// 3. graceful：无 stale / 无候选 / 无 world state（degraded + backfill precheck）/ L2 失败 / skillExecutor 缺。
// 4. backfill 接线（2.4）：无 patches + 有旧章 → backfillNeeded 信号 + degraded findings。
//
// mock registry：fetchWorldPatchesViaTool 经 registry.get('query_world_slice')。
// mock skillExecutor.runAgentWithExplicitSystem：控制 L2 返回（合法 JSON / 抛错 / parse 失败）。
// 真实磁盘 project.yaml（mkdtempSync + JSON 写，js-yaml 是 JSON 超集）。
// ─────────────────────────────────────────────────────────────────────────────

// mock registry：每个测试设置 mockGet（undefined = 工具未注册；否则 mock tool.execute 返预设 slices）。
let mockGet: ((id: string) => unknown) | undefined;
vi.mock('../src/tool/registry', () => ({
  registry: {
    get: (id: string) => mockGet?.(id),
  },
}));

import { diagnoseImpactsTool } from '../src/tool/diagnose-impacts';

/** 建一个 world patch fixture（fetchWorldPatchesViaTool shape guard 过）。 */
function makePatch(
  subjectId: string,
  storyTime: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `p-${subjectId}-${storyTime}`,
    sliceId: `sl-${storyTime}`,
    subjectId,
    path: '/hp',
    op: 'replace',
    value: 100,
    axis: 'physical',
    source: 'derived',
    summary: 'HP set',
    storyTime,
    ...overrides,
  };
}

/** mock query_world_slice tool：返含给定 patches 的 slices。 */
function makeWorldStateTool(patches: Record<string, unknown>[]) {
  return {
    execute: vi.fn().mockResolvedValue({
      metadata: {
        slices: patches.length > 0 ? [{ patches }] : [],
      },
    }),
  };
}

/** 合法 L2 ripple-diagnosis-agent 输出 JSON 串。 */
function l2Output(findings: unknown[], summary: string, degraded = false): string {
  return JSON.stringify({ findings, summary, degraded });
}

describe('diagnose_impacts tool（Story 3.4 Phase 2）', () => {
  let projectPath = '';
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let runBackfill: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'diagnose-impacts-'));
    runAgentWithExplicitSystem = vi.fn();
    runBackfill = vi.fn();
    ctx = {
      sessionId: 'leader-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runAgentWithExplicitSystem, runBackfill },
    };
    mockGet = undefined;
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
    mockGet = undefined;
  });

  /** 写 project.yaml fixture（JSON 格式，js-yaml 超集）。 */
  function writeProjectYaml(opts: {
    stale?: string[];
    nodes?: Record<string, unknown>[];
    lines?: Record<string, unknown>[];
    assetCards?: Record<string, unknown>[];
    hasChapters?: boolean;
  }): void {
    const stale = opts.stale ?? [];
    const fieldMeta: Record<string, unknown> = {};
    for (const key of [
      'creative_brief', 'world_setting', 'outline', 'episode_outlines',
      'growth_curve', 'pacing_curve', 'emotion_curve', 'asset_cards',
      'relationship_graph', 'promise_registry', 'info_release_map', 'scene_graph',
    ]) {
      fieldMeta[key] = { version: 1, source: 'user', locked: false, stale: stale.includes(key) };
    }

    const doc: Record<string, unknown> = {
      meta: { id: 'p1', name: 'test', type: 'novel', version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      field_metadata: fieldMeta,
      scene_graph: {
        nodes: opts.nodes ?? [
          { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'], assetRefs: ['char_a'] },
          { id: 's2', episodeId: 'ep1', storyTime: 20, presentationOrder: { chapter: 0, pos: 1 }, lineTags: ['l1'] },
        ],
        edges: [],
        lines: opts.lines ?? [{ id: 'l1', name: '主线', topology_role: 'converging' }],
        art_overrides: [],
        version: 0,
      },
      asset_cards: opts.assetCards ?? [{ id: 'char_a', type: 'character', name: '角色A' }],
      episode_outlines: [{ id: 'ep1', index: 0, title: '第一章' }],
    };
    if (opts.hasChapters) {
      doc.novel = { chapters: [{ id: 'ch1', title: '第一章', sort_order: 0, episodeId: 'ep1' }] };
    }
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
  }

  function ctxWithSkillExecutor(overrides: Partial<ToolContext> = {}): ToolContext {
    return { ...ctx, ...overrides };
  }

  // ── graceful：无 stale ──
  it('无 stale 字段 → 友善告知，不跑 L1/L2', async () => {
    writeProjectYaml({ stale: [] });
    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());
    expect(res.output).toContain('无 stale');
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
  });

  // ── graceful：project.yaml 不可读 ──
  it('project.yaml 不可读 → 告知无法诊断', async () => {
    // 不写 project.yaml → readFile 抛
    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());
    expect(res.output).toContain('无法读取');
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
  });

  // ── L1 缩小：narrowable（asset_cards）→ reverse-ref ──
  it('asset_cards stale + scene.assetRefs 填了 → reverse-ref 缩小到候选场 + L2 被调', async () => {
    writeProjectYaml({
      stale: ['asset_cards'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'], assetRefs: ['char_a'] },
        { id: 's2', episodeId: 'ep1', storyTime: 20, presentationOrder: { chapter: 0, pos: 1 }, lineTags: ['l1'], assetRefs: ['char_b'] },
        { id: 's3', episodeId: 'ep1', storyTime: 30, presentationOrder: { chapter: 0, pos: 2 }, lineTags: ['l1'] }, // 无 assetRefs
      ],
      assetCards: [{ id: 'char_a', type: 'character', name: 'A' }],
    });
    mockGet = () => makeWorldStateTool([makePatch('char_a', 5)]);

    runAgentWithExplicitSystem.mockResolvedValue({
      content: l2Output([{ code: 'conflict', severity: 'error', impactType: 'conflict', message: '矛盾', targets: [{ kind: 'scene', id: 's1' }] }], '1 error', false),
    });

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    // L2 被调（allowedTools=['query_world_state']）
    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const callArgs = runAgentWithExplicitSystem.mock.calls[0];
    expect(callArgs[1]).toBe('ripple-diagnosis-agent');
    expect(callArgs[3]?.allowedTools).toEqual(['query_world_state']);

    // 候选缩小：只有 s1 涉及 char_a（s2 是 char_b 不在 assetCards、s3 无 assetRefs）
    // → candidateScenes var 只含 s1
    const vars = callArgs[2] as Record<string, string>;
    const candidates = JSON.parse(vars.candidateScenes);
    expect(candidates.scenes).toHaveLength(1);
    expect(candidates.scenes[0].sceneId).toBe('s1');

    // metadata 含 findings
    const meta = res.metadata as { findings: unknown[] };
    expect(meta.findings).toHaveLength(1);
    expect(res.output).toContain('1 error');
  });

  // ── BMad CR Fix 5（E9 scenesByLine）：线锚定 asset → 线上场（未直接 ref asset）也进候选 ──
  it('asset_cards stale + line.thread_ref 锚 asset + 场在线上但无 assetRef → scenesByLine 收入候选', async () => {
    writeProjectYaml({
      stale: ['asset_cards'],
      nodes: [
        // s1 直接 ref char_a（scenesByAssetRef 命中）
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l2'], assetRefs: ['char_a'] },
        // s2 在 l2 上但无 assetRef（仅经 scenesByLine 命中——Fix 5 前漏报，Fix 5 后收入候选）
        { id: 's2', episodeId: 'ep1', storyTime: 20, presentationOrder: { chapter: 0, pos: 1 }, lineTags: ['l2'] },
        // s3 在 l1 上（l1 未锚 char_a）→ 不应进候选
        { id: 's3', episodeId: 'ep1', storyTime: 30, presentationOrder: { chapter: 0, pos: 2 }, lineTags: ['l1'] },
      ],
      lines: [
        { id: 'l2', name: 'char_a 线', topology_role: 'converging', thread_ref: 'char_a' },
        { id: 'l1', name: '无关线', topology_role: 'side' },
      ],
      assetCards: [{ id: 'char_a', type: 'character', name: 'A' }],
    });
    mockGet = () => makeWorldStateTool([makePatch('char_a', 5)]);

    runAgentWithExplicitSystem.mockResolvedValue({ content: l2Output([], 'ok', false) });

    await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    const candidates = JSON.parse(vars.candidateScenes);
    const candidateIds = candidates.scenes.map((s: { sceneId: string }) => s.sceneId);
    // s1（直接 ref char_a）+ s2（在 l2 线上，l2 锚 char_a）均进候选；s3 在 l1（未锚 char_a）不进。
    expect(candidateIds).toContain('s1');
    expect(candidateIds).toContain('s2');
    expect(candidateIds).not.toContain('s3');
  });

  // ── BMad CR Fix 5（E9 NARROWABLE）：relationship_graph stale 不再 narrowable → 全图候选 ──
  it('relationship_graph stale → 全图候选（删 narrowable，无关系反查原语）', async () => {
    writeProjectYaml({
      stale: ['relationship_graph'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
        { id: 's2', episodeId: 'ep1', storyTime: 20, presentationOrder: { chapter: 0, pos: 1 }, lineTags: ['l1'] },
      ],
    });
    mockGet = () => makeWorldStateTool([makePatch('sub1', 5)]);

    runAgentWithExplicitSystem.mockResolvedValue({ content: l2Output([], 'ok', false) });

    await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    const candidates = JSON.parse(vars.candidateScenes);
    // relationship_graph 非 narrowable → 全图候选（含 s1 + s2），非空集假「无可诊断」。
    expect(candidates.scenes).toHaveLength(2);
  });

  // ── L1 缩小：non-narrowable（world_setting）→ 全图候选 ──
  it('world_setting stale → 全图场为候选（D2 trade-off）', async () => {
    writeProjectYaml({
      stale: ['world_setting'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
        { id: 's2', episodeId: 'ep1', storyTime: 20, presentationOrder: { chapter: 0, pos: 1 }, lineTags: ['l1'] },
      ],
    });
    mockGet = () => makeWorldStateTool([makePatch('sub1', 5)]);

    runAgentWithExplicitSystem.mockResolvedValue({
      content: l2Output([], '无影响', false),
    });

    await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    const candidates = JSON.parse(vars.candidateScenes);
    // 全图：s1 + s2 都是候选
    expect(candidates.scenes).toHaveLength(2);
  });

  // ── L2 dispatch：world state snapshot 注入 candidateScenes var ──
  it('候选场含 world state snapshot（截至 storyTime 的累积状态）', async () => {
    writeProjectYaml({
      stale: ['world_setting'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });
    mockGet = () => makeWorldStateTool([makePatch('sub1', 5, { path: '/hp', value: 80 })]);

    runAgentWithExplicitSystem.mockResolvedValue({ content: l2Output([], 'ok', false) });
    await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    const candidates = JSON.parse(vars.candidateScenes);
    expect(candidates.scenes[0].worldStateSummary).not.toBe('无');
    expect(candidates.scenes[0].degraded).toBe(false);
  });

  // ── graceful：无 world state（degraded）──
  it('无 world state patches → 候选场全 degraded + L2 仍被调（产 no-events findings）', async () => {
    writeProjectYaml({
      stale: ['world_setting'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });
    mockGet = () => makeWorldStateTool([]); // 空 patches

    runAgentWithExplicitSystem.mockResolvedValue({
      content: l2Output(
        [{ code: 'no-events', severity: 'warning', impactType: 'no-events', message: '无数据', targets: [{ kind: 'scene', id: 's1' }], degraded: true }],
        'degraded',
        true,
      ),
    });

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    const candidates = JSON.parse(vars.candidateScenes);
    expect(candidates.scenes[0].degraded).toBe(true);
    expect(candidates.scenes[0].worldStateSummary).toBe('无');

    const meta = res.metadata as { degraded: boolean; findings: Array<{ degraded?: boolean }> };
    expect(meta.degraded).toBe(true);
  });

  // ── 2.4 backfill 接线：无 patches + 有旧章 → backfillNeeded 信号 ──
  it('无 patches + 有旧章 → backfillNeeded 信号 + degraded findings + summary 标注', async () => {
    writeProjectYaml({
      stale: ['world_setting'],
      hasChapters: true,
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });
    mockGet = () => makeWorldStateTool([]); // 无 world state

    runAgentWithExplicitSystem.mockResolvedValue({
      content: l2Output(
        [{ code: 'no-events', severity: 'warning', impactType: 'no-events', message: '无', targets: [{ kind: 'scene', id: 's1' }], degraded: true }],
        'degraded',
        true,
      ),
    });

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    // output 含 backfill 建议
    expect(res.output).toContain('backfill');
    const meta = res.metadata as { degradationNote?: string };
    expect(meta.degradationNote).toContain('backfill');
  });

  // ── graceful：L2 dispatch 失败 → L1 degraded fallback ──
  it('L2 dispatch 抛错 → L1 degraded findings fallback（AC6 永不假 pass）', async () => {
    writeProjectYaml({
      stale: ['world_setting'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });
    mockGet = () => makeWorldStateTool([makePatch('sub1', 5)]);

    runAgentWithExplicitSystem.mockRejectedValue(new Error('agent failed'));

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const meta = res.metadata as { degraded: boolean; findings: unknown[]; summary: string };
    expect(meta.degraded).toBe(true);
    // 有 patches → 场不 degraded（有 world state）→ L2 失败 fallback findings=[]
    // （buildDegradedFindings 只对 degraded=true 的场产 finding；有 patches 的场 degraded=false → 空）
    expect(meta.summary).toContain('未能完成');
  });

  // ── graceful：L2 parse 失败 → degraded ──
  it('L2 返非 JSON → parseRippleImpacts null → degraded fallback', async () => {
    writeProjectYaml({
      stale: ['world_setting'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });
    mockGet = () => makeWorldStateTool([makePatch('sub1', 5)]);

    runAgentWithExplicitSystem.mockResolvedValue({ content: '这不是 JSON' });

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const meta = res.metadata as { degraded: boolean };
    expect(meta.degraded).toBe(true);
  });

  // ── graceful：skillExecutor 缺 → graceful 告知 ──
  it('skillExecutor 缺（旧 runtime）→ graceful degraded', async () => {
    writeProjectYaml({
      stale: ['world_setting'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });
    mockGet = () => makeWorldStateTool([makePatch('sub1', 5)]);

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor({ skillExecutor: undefined }));

    const meta = res.metadata as { degraded: boolean };
    expect(meta.degraded).toBe(true);
  });

  // ── L1 补漏：L2 漏标 degraded 场 → L1 补 no-events finding ──
  it('L2 漏标 degraded 场 → L1 补 no-events finding（守不漏报）', async () => {
    writeProjectYaml({
      stale: ['world_setting'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });
    // 无 patches → s1 degraded
    mockGet = () => makeWorldStateTool([]);

    // L2 返空 findings（漏标 s1 的 no-events）
    runAgentWithExplicitSystem.mockResolvedValue({
      content: l2Output([], '无发现', false),
    });

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const meta = res.metadata as { findings: Array<{ code: string; targets: Array<{ id: string }> }> };
    // L1 补了 s1 的 no-events finding
    const noEventsFindings = meta.findings.filter((f) => f.code === 'no-events');
    expect(noEventsFindings.length).toBeGreaterThanOrEqual(1);
    expect(noEventsFindings.some((f) => f.targets.some((t) => t.id === 's1'))).toBe(true);
  });

  // ── changeDiff var 含字段描述 ──
  it('changeDiff var 含 stale 字段描述（帮 LLM 理解改动性质）', async () => {
    writeProjectYaml({
      stale: ['asset_cards'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'], assetRefs: ['char_a'] },
      ],
    });
    mockGet = () => makeWorldStateTool([makePatch('char_a', 5)]);
    runAgentWithExplicitSystem.mockResolvedValue({ content: l2Output([], 'ok', false) });

    await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    expect(vars.changeDiff).toContain('asset_cards');
    expect(vars.changeDiff).toContain('设定卡片');
  });

  // ── impactTypeVocab var 注入 prompt ──
  it('impactTypeVocab var 注入 prompt（词表先验）', async () => {
    writeProjectYaml({
      stale: ['asset_cards'],
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'], assetRefs: ['char_a'] },
      ],
    });
    mockGet = () => makeWorldStateTool([makePatch('char_a', 5)]);
    runAgentWithExplicitSystem.mockResolvedValue({ content: l2Output([], 'ok', false) });

    await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    expect(vars.impactTypeVocab).toContain('conflict');
    expect(vars.impactTypeVocab).toContain('stale-derivative');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // B3 backfill 接线（3.4 收尾）：backfillNeeded → runBackfill → 重新 buildCandidateReport
  // ════════════════════════════════════════════════════════════════════════════

  // ── backfill 成功 → buildCandidateReport 重跑（现在有 world state）+ L2 收到非 degraded 候选 ──
  it('backfillNeeded + runBackfill 成功 → 重跑 buildCandidateReport + L2 收到 world state 数据', async () => {
    // 第一次 buildCandidateReport：无 world state（mockGet 返空 patches）
    // backfill 成功后重跑：mockGet 改为返有 patches（模拟 backfill 写了 world state）
    let backfillDone = false;
    mockGet = () => makeWorldStateTool(backfillDone ? [makePatch('sub1', 5)] : []);

    writeProjectYaml({
      stale: ['world_setting'],
      hasChapters: true,
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });

    // runBackfill mock：模拟成功（设 backfillDone=true 让重跑时 mockGet 返有 patches）
    runBackfill.mockImplementation(async () => {
      backfillDone = true;
      return { ok: true, episodesProcessed: 1, episodesWritten: 1, totalPatches: 5 };
    });

    runAgentWithExplicitSystem.mockResolvedValue({ content: l2Output([], 'ok', false) });

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    // runBackfill 被调一次
    expect(runBackfill).toHaveBeenCalledTimes(1);
    expect(runBackfill).toHaveBeenCalledWith('leader-1', expect.objectContaining({ abort: expect.any(AbortSignal) }));

    // L2 被调（重跑 buildCandidateReport 后候选场不再 degraded）
    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    const candidates = JSON.parse(vars.candidateScenes);
    expect(candidates.scenes[0].degraded).toBe(false);
    expect(candidates.scenes[0].worldStateSummary).not.toBe('无');

    // output 含 backfill 成功提示
    expect(res.output).toContain('已自动补提取');
    // output 不含 backfill 需求警告
    expect(res.output).not.toContain('⚠️');
  });

  // ── backfill 失败 → 保持 degrade 路径（degraded findings 告知作者）──
  it('backfillNeeded + runBackfill 失败 → 保持 degrade 路径（degraded findings）', async () => {
    mockGet = () => makeWorldStateTool([]); // 无 world state

    writeProjectYaml({
      stale: ['world_setting'],
      hasChapters: true,
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });

    runBackfill.mockResolvedValue({ ok: false, reason: 'no chapters to backfill' });

    runAgentWithExplicitSystem.mockResolvedValue({
      content: l2Output(
        [{ code: 'no-events', severity: 'warning', impactType: 'no-events', message: '无', targets: [{ kind: 'scene', id: 's1' }], degraded: true }],
        'degraded',
        true,
      ),
    });

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    // runBackfill 被调
    expect(runBackfill).toHaveBeenCalledTimes(1);

    // L2 被调（候选场仍 degraded）
    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    const candidates = JSON.parse(vars.candidateScenes);
    expect(candidates.scenes[0].degraded).toBe(true);

    // output 含 backfill 警告
    expect(res.output).toContain('backfill');
    const meta = res.metadata as { degraded: boolean };
    expect(meta.degraded).toBe(true);
  });

  // ── backfill 不可用（skillExecutor 无 runBackfill）→ graceful degrade ──
  it('backfillNeeded + runBackfill 不可用 → graceful degrade（backward compat）', async () => {
    mockGet = () => makeWorldStateTool([]);

    writeProjectYaml({
      stale: ['world_setting'],
      hasChapters: true,
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });

    runAgentWithExplicitSystem.mockResolvedValue({
      content: l2Output(
        [{ code: 'no-events', severity: 'warning', impactType: 'no-events', message: '无', targets: [{ kind: 'scene', id: 's1' }], degraded: true }],
        'degraded',
        true,
      ),
    });

    // skillExecutor 无 runBackfill（旧 runtime）
    await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor({ skillExecutor: { runAgentWithExplicitSystem } }));

    // L2 仍被调（graceful degrade 路径）
    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
  });

  // ── backfill 抛错 → catch + 保持 degrade 路径 ──
  it('runBackfill 抛错 → catch + graceful degrade（不崩 chain）', async () => {
    mockGet = () => makeWorldStateTool([]);

    writeProjectYaml({
      stale: ['world_setting'],
      hasChapters: true,
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });

    runBackfill.mockRejectedValue(new Error('db locked'));

    runAgentWithExplicitSystem.mockResolvedValue({
      content: l2Output(
        [{ code: 'no-events', severity: 'warning', impactType: 'no-events', message: '无', targets: [{ kind: 'scene', id: 's1' }], degraded: true }],
        'degraded',
        true,
      ),
    });

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    // 不崩——正常返回（L2 仍被调）
    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    expect(res.output).toBeDefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BMad CR Fix 1（E1 静默假成功）：backfill 返 degraded/reason（writeErrors/cap）→ diagnose 不报成功
  // ════════════════════════════════════════════════════════════════════════════

  it('runBackfill 返 {ok:true, degraded:true, reason}（writeErrors/cap）→ 不报成功，走 degrade 路径', async () => {
    // 第一次 buildCandidateReport：无 world state（mockGet 返空 patches）
    // backfill 返 degraded（writeErrors）→ backfillSucceeded=false → 不重跑 buildCandidateReport
    mockGet = () => makeWorldStateTool([]);

    writeProjectYaml({
      stale: ['world_setting'],
      hasChapters: true,
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 10, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] },
      ],
    });

    // runBackfill 返 ok:true 但 degraded:true + reason（模拟 writeErrors / cap 截断场景）
    runBackfill.mockResolvedValue({
      ok: true,
      degraded: true,
      reason: '1 write errors (see logs)',
      episodesProcessed: 1,
      episodesWritten: 0,
    });

    runAgentWithExplicitSystem.mockResolvedValue({
      content: l2Output(
        [{ code: 'no-events', severity: 'warning', impactType: 'no-events', message: '无', targets: [{ kind: 'scene', id: 's1' }], degraded: true }],
        'degraded',
        true,
      ),
    });

    const res = await diagnoseImpactsTool.execute({}, ctxWithSkillExecutor());

    // runBackfill 被调
    expect(runBackfill).toHaveBeenCalledTimes(1);

    // 候选场仍 degraded（backfill 未全生效，buildCandidateReport 未重跑）
    const vars = runAgentWithExplicitSystem.mock.calls[0][2] as Record<string, string>;
    const candidates = JSON.parse(vars.candidateScenes);
    expect(candidates.scenes[0].degraded).toBe(true);

    // output 不含「已自动补提取」成功提示（backfill 未真成功）
    expect(res.output).not.toContain('已自动补提取');
    // output 含 backfill 警告（仍 degraded）
    expect(res.output).toContain('backfill');
    const meta = res.metadata as { degraded: boolean };
    expect(meta.degraded).toBe(true);
  });
});
