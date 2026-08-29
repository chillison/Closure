import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// Story 7.4 Step 3+4：write_chapter Director atomic-edit apply 落盘 + scene_graph 刷新 + §1.6 structuralEdit
// 联动单测。mirror write-chapter-feedback-ledger.test.ts 模式。mock：
// - skillExecutor.runAgentWithExplicitSystem（director 返 atomicEditProposals JSON）+
//   runChapterChain。
// - getSession（permissionMode → autoApplyFlag）。
// - registry feedback_ledger_read（返上一章 review 含 no-suspense finding → Director 产 atomicEditProposals）。
// - registry scene_graph_update / promise_ledger_update（mock 落盘 / field_patch 返回）。
// 验：
// (a) auto mode + atomicEdits valid → scene_graph_update(autoApply=true) 被调 + initialArtifacts['scene_graph']
//     刷新（draft-writer 消费新 graph 单轮闭环）+ revision_intent.structuralEdit=true 注入（§1.6 数据通道）；
// (b) non-auto mode + atomicEdits valid → scene_graph_update(autoApply=false) 被调 + field_patch envelope 入
//     write_chapter output metadata（sceneGraphPatch）+ scene_graph 不刷新（patch 未 accept）；
// (c) Director 无 atomicEditProposals → scene_graph_update 不调（零回归）；
// (d) scene_graph_update 未注册（registry 空）→ graceful skip，链段照跑；
// (e) blocking validation → scene_graph_update 不调（7.3 CR-003 保障，不落盘）。

vi.mock('../src/agent/session', () => ({
  getSession: vi.fn(),
  loadSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  loadSessionMeta: vi.fn(),
}));

import { getSession } from '../src/agent/session';

const mockedGetSession = vi.mocked(getSession);

function setSessionPermissionMode(mode: 'readonly' | 'suggest' | 'auto' | undefined): void {
  if (mode === undefined) {
    mockedGetSession.mockReturnValue(undefined);
    return;
  }
  mockedGetSession.mockReturnValue({ permissionMode: mode } as SessionState);
}

describe('write_chapter Director atomic-edit apply（Story 7.4 Step 3+4）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-atomic-'));
    runChapterChain = vi.fn();
    runAgentWithExplicitSystem = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: {
        runChapterChain,
        runAgentWithExplicitSystem,
        runSubagent: vi.fn(),
        executeSkillByName: vi.fn(),
      },
    };
    // 默认 suggest（non-auto）；auto mode 测试显式 setSessionPermissionMode('auto')。
    setSessionPermissionMode('suggest');
  });

  afterEach(() => {
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
    vi.resetModules();
  });

  // 两 episode project（ep1 index 0 / ep2 index 1）+ scene_graph（s1/s2 ∈ ep2）。写 ep2 → 上章 = ep1。
  // mirror write-chapter-feedback-ledger.test.ts writeTwoEpisodeProject。
  function writeTwoEpisodeProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomLine: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: {
        nodes: [
          { id: 's1', episodeId: 'ep2', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor', outcomeType: '反转' },
          { id: 's2', episodeId: 'ep2', storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        ],
        edges: [],
        lines: [],
      },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [
        { id: 'ep1', index: 0, title: '开篇' },
        { id: 'ep2', index: 1, title: '第二章' },
      ],
    }), 'utf8');
  }

  const SUMMARY_OK: RunSnapshotSummary = {
    status: 'completed',
    routeDecision: { decision: 'accept_as_truth', reason: '通过' },
    reviewVerdict: 'pass',
    draftTitle: '第二章',
    draftWordCount: 2000,
    errors: [],
  };

  // 上一章 ep1 review.latest（含 no-suspense warn → Director 产 add_suspense atomicEditProposal）。
  const PREV_EP1_ENTRIES = [
    {
      episodeId: 'ep1',
      artifactKey: 'review.latest',
      payload: {
        verdict: 'pass',
        summary: '上章通过',
        dimensions: [
          {
            name: 'narrative-feature',
            findings: [
              { severity: 'warn', quote: '中段太平无悬念', location: '段 3', explanation: '悬念不足', subClass: 'no-suspense' },
            ],
          },
        ],
      },
      producedAt: '2026-08-12T00:00:00Z',
    },
  ];

  // role-aware mock：director-agent -> directorResponse。
  function mockSubAgents(directorResponse: string): void {
    runAgentWithExplicitSystem.mockImplementation((_sid, role) => {
      if (role === 'director-agent') return Promise.resolve({ content: directorResponse });
      return Promise.resolve({ content: '{}' });
    });
  }

  /** 动态注册 mock feedback_ledger_read tool（返 entries）。 */
  async function registerFeedbackReadTool(entries: unknown[]): Promise<void> {
    const { registry } = await import('../src/tool/registry');
    registry.register({
      id: 'feedback_ledger_read',
      description: 'mock for test',
      parameters: z.object({}),
      execute: async () => ({
        title: 'feedback_ledger_read: mock',
        output: 'mock',
        metadata: { ok: true, episodeId: 'ep1', count: entries.length, entries },
      }),
    });
  }

  /** 动态注册 mock scene_graph_update tool，返 autoApply 响应或 field_patch envelope。 */
  async function registerSceneGraphUpdateTool(
    responder: (params: { autoApply?: boolean; actions?: unknown[] }) => { metadata: Record<string, unknown>; output: string },
  ): Promise<ReturnType<typeof vi.fn>> {
    const { registry } = await import('../src/tool/registry');
    const execute = vi.fn().mockImplementation(async (params: { autoApply?: boolean; actions?: unknown[] }) => {
      const r = responder(params);
      return { title: 'scene_graph_update: mock', output: r.output, metadata: r.metadata };
    });
    registry.register({
      id: 'scene_graph_update',
      description: 'mock for test',
      parameters: z.object({}),
      execute,
    });
    return execute;
  }

  /** 动态注册 mock promise_ledger_update tool。 */
  async function registerPromiseLedgerUpdateTool(
    responder: (params: { autoApply?: boolean; actions?: unknown[] }) => { metadata: Record<string, unknown>; output: string },
  ): Promise<ReturnType<typeof vi.fn>> {
    const { registry } = await import('../src/tool/registry');
    const execute = vi.fn().mockImplementation(async (params: { autoApply?: boolean; actions?: unknown[] }) => {
      const r = responder(params);
      return { title: 'promise_ledger_update: mock', output: r.output, metadata: r.metadata };
    });
    registry.register({
      id: 'promise_ledger_update',
      description: 'mock for test',
      parameters: z.object({}),
      execute,
    });
    return execute;
  }

  // Director 产 add_suspense atomicEditProposal（s1→s2，mirror write-chapter-feedback-ledger test e）。
  const DIRECTOR_WITH_ATOMIC = {
    entries: [],
    emotionPoints: [],
    emotionTarget: { emotion: '期待' },
    atomicEditProposals: [
      { op: { op: 'add_suspense', atSceneId: 's1', resolveTowardsSceneId: 's2' }, sourceIssueRef: 'no-suspense', rationale: '中段太平需悬念钩子' },
    ],
  };

  // 投影后的 scene_graph（mock handler 返——含新 suspense 场 s_suspense）。
  const PROJECTED_GRAPH = {
    nodes: [
      { id: 's1', episodeId: 'ep2', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor' },
      { id: 's2', episodeId: 'ep2', storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      { id: 's_suspense', episodeId: 'ep2', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' },
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };

  // ════════════════════════════════════════════════════════════════════════════
  // a. auto mode + atomicEdits valid → scene_graph_update(autoApply=true) + scene_graph 刷新 + structuralEdit intent
  // ════════════════════════════════════════════════════════════════════════════

  it('auto mode + atomicEdits valid → scene_graph_update(autoApply=true) 被调 + scene_graph 刷新 + revision_intent.structuralEdit=true 注入', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify(DIRECTOR_WITH_ATOMIC));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('auto');
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    const sceneGraphExecute = await registerSceneGraphUpdateTool((p) => {
      // 验 caller 传 autoApply=true（auto mode）。
      expect(p.autoApply).toBe(true);
      return {
        metadata: { ok: true, applied: true, data: PROJECTED_GRAPH, sceneCount: 3 },
        output: 'Auto-applied',
      };
    });
    await registerPromiseLedgerUpdateTool(() => ({
      metadata: { ok: true, applied: true, promiseCount: 0, beatCount: 0 },
      output: 'Auto-applied',
    }));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // scene_graph_update 被调（atomicEdits valid → leader 调度落盘）。
    expect(sceneGraphExecute).toHaveBeenCalledTimes(1);

    // initialArtifacts['scene_graph'] 刷新为投影后 graph（design §3.2 单轮闭环：draft-writer 消费新 graph）。
    const [, artifacts] = runChapterChain.mock.calls[0];
    const sceneGraph = artifacts['scene_graph'] as { nodes: Array<{ id: string }> };
    expect(sceneGraph.nodes.map((n) => n.id)).toContain('s_suspense');

    // revision_intent.structuralEdit=true 注入（§1.6 放行码数据通道，环 B 整章重写 minimal intent）。
    const intent = artifacts['revision_intent'] as { structuralEdit?: boolean; change?: { summary?: string } } | undefined;
    expect(intent).toBeDefined();
    expect(intent?.structuralEdit).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // b. non-auto mode + atomicEdits valid → scene_graph_update(autoApply=false) + field_patch envelope 入 metadata + scene_graph 不刷新
  // ════════════════════════════════════════════════════════════════════════════

  it('non-auto mode + atomicEdits valid → scene_graph_update(autoApply=false) + field_patch 入 metadata + scene_graph 不刷新', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify(DIRECTOR_WITH_ATOMIC));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    // 默认 suggest（non-auto）。
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    const sceneGraphExecute = await registerSceneGraphUpdateTool((p) => {
      // non-auto mode → autoApply=false（field_patch envelope 路径）。
      expect(p.autoApply).toBe(false);
      return {
        metadata: { type: 'field_patch', field: 'scene_graph', action: 'set', data: PROJECTED_GRAPH },
        output: 'Awaiting review',
      };
    });
    await registerPromiseLedgerUpdateTool(() => ({
      metadata: { type: 'field_patch', field: 'promise_registry', action: 'set', data: { promises: [], beats: [] } },
      output: 'Awaiting review',
    }));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(sceneGraphExecute).toHaveBeenCalledTimes(1);

    // scene_graph 不刷新（non-auto patch 未 accept → draft-writer 用旧 graph）。
    const [, artifacts] = runChapterChain.mock.calls[0];
    const sceneGraph = artifacts['scene_graph'] as { nodes: Array<{ id: string }> };
    expect(sceneGraph.nodes.map((n) => n.id)).not.toContain('s_suspense');

    // revision_intent 不注入（无 structuralEdit 标记——非 auto 未落盘不触发 prose 重生成）。
    expect(artifacts['revision_intent']).toBeUndefined();

    // field_patch envelope 入 write_chapter output metadata（供 UI PatchReview 人审，routing 归 UI Story）。
    expect(result.metadata?.sceneGraphPatch).toMatchObject({
      type: 'field_patch',
      field: 'scene_graph',
      action: 'set',
    });
    // add_suspense 只产 sceneGraphActions（无 promiseActions，atomic-edit.ts expandAtomicEditOp）→
    // promise_ledger_update 不调 → promiseRegistryPatch 不产。promise patch 路径由 add_foreshadow 类 op 覆盖。
    expect(result.metadata?.promiseRegistryPatch).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // c. Director 无 atomicEditProposals → scene_graph_update 不调（零回归）
  // ════════════════════════════════════════════════════════════════════════════

  it('Director 无 atomicEditProposals → scene_graph_update 不调 + scene_graph 不刷新（零回归）', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify({ entries: [], emotionPoints: [], emotionTarget: { emotion: '期待' } }));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    const sceneGraphExecute = await registerSceneGraphUpdateTool(() => ({
      metadata: { ok: true, applied: true, data: PROJECTED_GRAPH },
      output: 'should not be called',
    }));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // Director 无 atomicEditProposals → directorAtomicEdits null → scene_graph_update 不调。
    expect(sceneGraphExecute).not.toHaveBeenCalled();
    // scene_graph 不刷新（保持原 assembled graph，2 节点 s1/s2）。
    const [, artifacts] = runChapterChain.mock.calls[0];
    const sceneGraph = artifacts['scene_graph'] as { nodes: Array<{ id: string }> };
    expect(sceneGraph.nodes).toHaveLength(2);
    expect(artifacts['revision_intent']).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // d. scene_graph_update 未注册（registry 空）→ graceful skip，链段照跑
  // ════════════════════════════════════════════════════════════════════════════

  it('scene_graph_update 未注册（registry 空仅 feedback_ledger_read）→ graceful skip，链段照跑', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify(DIRECTOR_WITH_ATOMIC));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    // 不注册 scene_graph_update（registry 仅 feedback_ledger_read）——测试环境 graceful。
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // graceful skip：链段照跑（runChapterChain 仍调），scene_graph 未刷新（保持原 2 节点）。
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [, artifacts] = runChapterChain.mock.calls[0];
    const sceneGraph = artifacts['scene_graph'] as { nodes: Array<{ id: string }> };
    expect(sceneGraph.nodes).toHaveLength(2);
    expect(artifacts['revision_intent']).toBeUndefined();
    // result 不崩（graceful）。
    expect(result.output).toContain('status: completed');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // e. CR-009 batch-aware filter：proposal B 锚 proposal A 创的新场不被滤幻觉
  // ════════════════════════════════════════════════════════════════════════════

  it('🔑 CR-009：proposal B（add_suspense atSceneId=bridgeNew）锚 proposal A（add_plot_bridge 创 bridgeNew）不被滤', async () => {
    writeTwoEpisodeProject();
    // Director 产两 proposal：A 加桥（创 bridgeNew 场），B 加悬念（锚 bridgeNew）。
    // 7.3 旧版（filter 跑在展开前，allSceneIds 不含 bridgeNew）→ B 被当幻觉滤掉。
    // 7.4 CR-009 batch-aware：collectCreatedSceneIds 收 bridgeNew 入 allSceneIds → B 保留。
    const directorWithBatch = {
      entries: [],
      emotionPoints: [],
      emotionTarget: { emotion: '期待' },
      atomicEditProposals: [
        {
          op: { op: 'add_plot_bridge', between: { fromSceneId: 's1', toSceneId: 's2' }, bridgeScene: { id: 'bridgeNew', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } } },
          rationale: 's1 到 s2 断裂需桥',
        },
        {
          op: { op: 'add_suspense', atSceneId: 'bridgeNew', resolveTowardsSceneId: 's2' },
          rationale: '桥场加悬念钩子',
        },
      ],
    };
    mockSubAgents(JSON.stringify(directorWithBatch));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('auto');
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    // 捕获 scene_graph_update handler 收到的 actions——验 B（add_suspense 悬念边）存活。
    let receivedActions: unknown[] = [];
    const sceneGraphExecute = await registerSceneGraphUpdateTool((p) => {
      receivedActions = (p.actions ?? []) as unknown[];
      return { metadata: { ok: true, applied: true, data: { ...PROJECTED_GRAPH, nodes: [...PROJECTED_GRAPH.nodes, { id: 'bridgeNew', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }] } }, output: 'ok' };
    });
    await registerPromiseLedgerUpdateTool(() => ({ metadata: { ok: true, applied: true }, output: 'ok' }));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // scene_graph_update 被调（两 proposal valid → leader 调度落盘）。
    expect(sceneGraphExecute).toHaveBeenCalledTimes(1);
    // B 存活证据：actions 含 SUSPENSE 边（bridgeNew→s2）——B 的 add_suspense 展开产物。
    // 若 B 被滤（7.3 旧版），actions 只有 A 的 3 条（add_scene + 2 CAUSAL），无 SUSPENSE。
    const suspenseEdges = receivedActions.filter(
      (a) => (a as { op?: string; edge?: { type?: string } }).op === 'add_edge'
        && (a as { edge?: { type?: string } }).edge?.type === 'SUSPENSE',
    );
    expect(suspenseEdges.length).toBeGreaterThan(0);
    // 验 SUSPENSE 边 from=bridgeNew（B 锚 A 创的场）。
    const bridgeSuspense = suspenseEdges.find(
      (a) => (a as { edge?: { from?: string } }).edge?.from === 'bridgeNew',
    );
    expect(bridgeSuspense).toBeDefined();
  });
});
