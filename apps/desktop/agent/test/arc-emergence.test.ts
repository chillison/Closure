import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createArcEmergenceNode,
  extractGrowthArcCandidates,
  extractLineArcCandidates,
  extractVolumeArcCandidates,
  parseArcEmergenceOutput,
  type ArcEmergenceArtifact,
} from '../src/nodes/arc-emergence-node';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { RunSnapshot } from '../src/contracts/run';
import { registry } from '../src/tool/registry';
import { summarizeRunSnapshot } from '../src/runtime/chainRunner';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.2 Step 3：arc-emergence-node 测试（mirror promise-emergence.test.ts）。
//
// 不测真实 generateText（LLM 质量归 dogfood，mirror 6.5 先例）。测四块：
// 1. 段 1 纯代码候选抽取（lines / phases / character cards）。
// 2. parseArcEmergenceOutput（坏条目丢弃 / 围栏 / 裸数组 / 非 JSON 抛）。
// 3. 节点 graceful 三路（无 episodeId / LLM 失败 / 零 beats）+ happy path（autoApply 写入 + artifact）。
// 4. summarizeRunSnapshot arcEmergenceBeats 透传（本章 beats / 坏条目守性 / 恒设空数组）。
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_arc',
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

const EPISODES = [
  { id: 'ep1', index: 0, title: '第一章' },
  { id: 'ep2', index: 1, title: '第二章' },
];

const LINE_ARCS_RUN = makeRun({
  'draft.initial': { text: '主角推开城门，回望来路。' },
  scene_graph: {
    nodes: [],
    edges: [],
    lines: [
      { id: 'line-main', name: '主线', topology_role: 'converging', mice_type: '事件' },
      // 坏条目：缺 name → 守性跳过
      { id: 'bad-line', topology_role: 'side' },
    ],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  },
  'chapter_brief_input': { episodeId: 'ep2', brief: { goal: '抵达 B 城' } },
  episode_outlines: EPISODES,
});

// ════════════════════════════════════════════════════════════════════════════
// 1. 段 1 纯代码候选抽取
// ════════════════════════════════════════════════════════════════════════════

describe('extractLineArcCandidates / extractVolumeArcCandidates / extractGrowthArcCandidates（段 1 纯代码）', () => {
  it('lines → 线弧候选（含 mice_type/visibility 投影；坏条目跳过）', () => {
    const candidates = extractLineArcCandidates({
      nodes: [],
      edges: [],
      lines: [
        {
          id: 'line-main', name: '主线', topology_role: 'converging', mice_type: '事件',
          visibility: { status: 'hidden-until', target: 'ep5' }, convergence_target: 'anchor-1',
        },
        { id: 'bad', topology_role: 'side' }, // 缺 name → 跳过
      ],
      art_overrides: [],
      version: 0,
      updatedBy: 'agent',
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: 'line-main',
      name: '主线',
      mice_type: '事件',
      visibilityStatus: 'hidden-until',
      visibilityTarget: 'ep5',
      convergence_target: 'anchor-1',
    });
  });

  it('outline_phases → 卷弧候选（goal/climax/hook 投影；缺 → 空数组 graceful）', () => {
    const phases = extractVolumeArcCandidates([
      { id: 'phase-1', title: '第一卷', goal: '进城', climax: '城门决战', hook: '南方的信' },
      { id: 'bad', goal: '缺 title' }, // 坏条目跳过
    ]);
    expect(phases).toEqual([
      { id: 'phase-1', title: '第一卷', goal: '进城', climax: '城门决战', hook: '南方的信' },
    ]);
    expect(extractVolumeArcCandidates(undefined)).toEqual([]);
  });

  it('asset_cards type=character → 成长弧候选（非角色卡 / 缺 id 跳过；缺 name 回退 id）', () => {
    const growth = extractGrowthArcCandidates([
      { id: 'char-1', type: 'character', name: '林动' },
      { id: 'item-1', type: 'item', name: '铜钥匙' },
      { type: 'character', name: '无 id' }, // 缺 id 跳过
      { id: 'char-anon', type: 'character' }, // 缺 name → name 回退 id
    ]);
    expect(growth).toEqual([
      { characterId: 'char-1', name: '林动' },
      { characterId: 'char-anon', name: 'char-anon' },
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. parseArcEmergenceOutput（LLM 段输出解析）
// ════════════════════════════════════════════════════════════════════════════

const LLM_OUTPUT = {
  actions: [
    {
      type: 'add_beat',
      beat: {
        episodeId: 'ep2',
        episodeIndex: 1,
        arcRef: 'line-main',
        arcKind: 'line',
        action: 'advance',
        note: '主角沿主线推进到 B 城',
      },
    },
    {
      type: 'add_beat',
      beat: {
        episodeId: 'ep2',
        episodeIndex: 1,
        arcRef: 'phase-1',
        arcKind: 'volume',
        action: 'close',
        grounding: '城门在他身后轰然关闭。',
      },
    },
    // 坏条目：close 无 grounding → arcBeatWriteSchema superRefine 拒 → safeParse 丢
    {
      type: 'add_beat',
      beat: { episodeId: 'ep2', episodeIndex: 1, arcRef: 'line-main', arcKind: 'line', action: 'close' },
    },
    // 坏条目：非法 type → 丢
    { type: 'bogus_op', foo: 'bar' },
  ],
};

describe('parseArcEmergenceOutput', () => {
  it('裸 JSON {actions:[...]} → ArcLedgerAction[]（close 无 grounding 坏条目丢，好条目保留）', () => {
    const actions = parseArcEmergenceOutput(JSON.stringify(LLM_OUTPUT));
    expect(actions).toHaveLength(2);
    expect(actions[0].beat.action).toBe('advance');
    expect(actions[1].beat.action).toBe('close');
    expect(actions[1].beat.grounding).toBe('城门在他身后轰然关闭。');
  });

  it('```json 围栏 + 前导文字 → extractJson 剥离后 parse 成功', () => {
    const fenced = `弧节拍登记结果：\n\`\`\`json\n${JSON.stringify(LLM_OUTPUT)}\n\`\`\``;
    expect(parseArcEmergenceOutput(fenced)).toHaveLength(2);
  });

  it('裸数组 [...] → 归一为 actions', () => {
    expect(parseArcEmergenceOutput(JSON.stringify(LLM_OUTPUT.actions))).toHaveLength(2);
  });

  it('root 非 JSON → 抛（触发 createLlmNode 重试/兜底）', () => {
    expect(() => parseArcEmergenceOutput('not json at all')).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. createArcEmergenceNode（契约 + graceful 三路 + happy path autoApply）
// ════════════════════════════════════════════════════════════════════════════

describe('createArcEmergenceNode', () => {
  it('契约：required=[draft.initial, scene_graph]，produced=[arc_emergence] + sideEffects persist', () => {
    const node = createArcEmergenceNode({ generate: vi.fn() });
    expect(node.contract?.nodeId).toBe('arc-emergence-node');
    expect(node.contract?.requiredArtifactKeys).toEqual(['draft.initial', 'scene_graph']);
    expect(node.contract?.producedArtifactKeys).toEqual(['arc_emergence']);
    expect(node.contract?.sideEffects).toContain('persist_artifact');
  });

  it('graceful：episodeId 缺（chapter_brief_input 无 episode 关联）→ 空 beats + skipped，不调 LLM', async () => {
    const generate = vi.fn<GenerateFn>();
    const node = createArcEmergenceNode({ generate });
    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: '正文。' },
        scene_graph: { nodes: [], edges: [], lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }] },
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('arc_emergence');
    const art = result.artifact as ArcEmergenceArtifact;
    expect(art.beats).toEqual([]);
    expect(art.skipped).toMatch(/no episodeId/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('graceful：三类候选全空（无 lines/phases/角色卡）→ 跳 LLM 省 8.2 dormant 零成本', async () => {
    const generate = vi.fn<GenerateFn>();
    const node = createArcEmergenceNode({ generate });
    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: '正文。' },
        scene_graph: { nodes: [], edges: [], lines: [] },
        'chapter_brief_input': { episodeId: 'ep2' },
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });
    const art = result.artifact as ArcEmergenceArtifact;
    expect(art.beats).toEqual([]);
    expect(art.skipped).toMatch(/no arc candidates/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('graceful：LLM 返畸形 JSON 两次 → 空 beats + skipped，不破 chain（mirror promise CR-E3）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: 'totally not json', finishReason: 'stop' }));
    const node = createArcEmergenceNode({ generate });
    const result = await node.run({ run: LINE_ARCS_RUN, requirement: '' });
    expect(result.stateKey).toBe('arc_emergence');
    const art = result.artifact as ArcEmergenceArtifact;
    expect(art.beats).toEqual([]);
    expect(art.skipped).toMatch(/LLM arc emergence failed/);
    // generate 重试两次（createLlmNode 重试机制）
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('graceful：LLM 判零 beats（空 actions）→ 不写盘，空 beats artifact（非失败）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: JSON.stringify({ actions: [] }), finishReason: 'stop' }));
    const updateExecute = vi.fn();
    registry.register({
      id: 'arc_ledger_update',
      description: 'mock',
      parameters: z.object({}),
      execute: updateExecute,
    });
    const node = createArcEmergenceNode({ generate });
    const result = await node.run({ run: LINE_ARCS_RUN, requirement: '' });
    const art = result.artifact as ArcEmergenceArtifact;
    expect(art.beats).toEqual([]);
    expect(art.skipped).toMatch(/no valid arc actions/);
    expect(updateExecute).not.toHaveBeenCalled();
  });

  it('happy path：LLM 产 beats → arc_ledger_update builtin（autoApply:true）+ episode 字段纯代码覆写 + applied=true', async () => {
    // mock query_arc（既有 beats 避重复）+ arc_ledger_update（验 autoApply 入参 + episode 覆写后的 beats）。
    registry.register({
      id: 'query_arc',
      description: 'mock',
      parameters: z.object({}),
      async execute() {
        return {
          title: 'mock',
          output: '',
          metadata: { ok: true, beatCount: 0, beats: [], truncated: false },
        };
      },
    });
    const updateExecute = vi.fn(async (params: Record<string, unknown>) => {
      // 🔑 mirror promise A1 核心断言：emergence 调时传 autoApply:true（绕开 PatchReview 直接落盘）。
      expect(params.autoApply).toBe(true);
      const actions = params.actions as Array<{ type: string; beat: { episodeId: string; episodeIndex: number } }>;
      expect(actions).toHaveLength(1);
      // episodeId/episodeIndex 纯代码覆写（LLM 产也不信坐标字段，mirror 7.1 F2 判据）——
      // 本 fixture 的 LLM 输出故意带错 episodeId=epX / episodeIndex=99，覆写后必须是解析值。
      expect(actions[0].beat.episodeId).toBe('ep2');
      expect(actions[0].beat.episodeIndex).toBe(1);
      return {
        title: 'mock',
        output: 'applied',
        metadata: { ok: true, applied: true, beatCount: 2 },
      };
    });
    registry.register({
      id: 'arc_ledger_update',
      description: 'mock',
      parameters: z.object({}),
      execute: updateExecute,
    });

    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({
        actions: [
          {
            type: 'add_beat',
            beat: {
              // 🔑 故意幻觉坐标：节点须纯代码覆写为 resolved 值（ep2 / 1）。
              episodeId: 'epX-hallucinated',
              episodeIndex: 99,
              arcRef: 'line-main',
              arcKind: 'line',
              action: 'advance',
              note: '推进',
            },
          },
        ],
      }),
      finishReason: 'stop',
    }));
    const node = createArcEmergenceNode({ generate });
    const result = await node.run({ run: LINE_ARCS_RUN, requirement: '' });

    expect(result.stateKey).toBe('arc_emergence');
    const art = result.artifact as ArcEmergenceArtifact;
    expect(art.beats).toHaveLength(1);
    // artifact 内 beats 也是覆写后坐标（LLM 幻觉字段不落 artifact）。
    expect(art.beats[0]).toMatchObject({ episodeId: 'ep2', episodeIndex: 1, arcRef: 'line-main', action: 'advance' });
    expect(art.skipped).toBeUndefined();
    expect(art.applied).toBe(true);
    expect(art.writeError).toBeUndefined();
  });

  it('graceful：arc_ledger_update builtin 抛错 → 记 writeError 不破 chain（applied 不设）', async () => {
    registry.register({
      id: 'arc_ledger_update',
      description: 'mock',
      parameters: z.object({}),
      async execute() {
        throw new Error('Field arc_registry is locked and cannot be edited');
      },
    });
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({
        actions: [
          { type: 'add_beat', beat: { episodeId: 'ep2', episodeIndex: 1, arcRef: 'line-main', arcKind: 'line', action: 'advance' } },
        ],
      }),
      finishReason: 'stop',
    }));
    const node = createArcEmergenceNode({ generate });
    const result = await node.run({ run: LINE_ARCS_RUN, requirement: '' });
    const art = result.artifact as ArcEmergenceArtifact;
    expect(art.beats).toHaveLength(1);
    expect(art.applied).toBeUndefined();
    expect(art.writeError).toMatch(/locked/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. summarizeRunSnapshot arcEmergenceBeats 透传（Story 8.2 链段 → leader 摘要）
// ════════════════════════════════════════════════════════════════════════════

describe('summarizeRunSnapshot — arcEmergenceBeats 透传', () => {
  it('arc_emergence artifact 带 beats → summary.arcEmergenceBeats 透传（write_chapter 关口判定消费）', () => {
    const run = makeRun({
      draft: undefined,
      arc_emergence: {
        beats: [
          { id: 'b1', episodeId: 'ep2', episodeIndex: 1, arcRef: 'phase-1', arcKind: 'volume', action: 'close', grounding: '城门关闭。' },
        ],
        lineCandidates: 1,
        volumeCandidates: 1,
        growthCandidates: 0,
        beatsProduced: 1,
      },
      route_decision: { decision: 'accept_as_truth', reason: 'ok' },
    });
    run.status = 'completed';
    const summary = summarizeRunSnapshot(run);
    expect(summary.arcEmergenceBeats).toHaveLength(1);
    expect(summary.arcEmergenceBeats![0]).toMatchObject({ arcRef: 'phase-1', arcKind: 'volume', action: 'close' });
  });

  it('arc_emergence 缺 / 零 beats → 恒设空数组（零节拍 = 停滞检测要看见的信号非零痕迹）', () => {
    const run = makeRun({});
    run.status = 'completed';
    expect(summarizeRunSnapshot(run).arcEmergenceBeats).toEqual([]);

    const run2 = makeRun({ arc_emergence: { beats: [], beatsProduced: 0 } });
    run2.status = 'completed';
    expect(summarizeRunSnapshot(run2).arcEmergenceBeats).toEqual([]);
  });

  it('坏 beat 条目守性丢弃（per-element safeParse，好条目保留）', () => {
    const run = makeRun({
      arc_emergence: {
        beats: [
          { episodeId: 'ep2', episodeIndex: 1, arcRef: 'line-main', arcKind: 'line', action: 'advance' }, // 无 id 但 schema 无 id 必填？——id required
          { id: 'b2', episodeId: 'ep2', episodeIndex: 1, arcRef: 'line-main', arcKind: 'line', action: 'advance' },
        ],
      },
    });
    run.status = 'completed';
    const summary = summarizeRunSnapshot(run);
    // 第一条缺 id（arcBeatSchema required）→ 丢；第二条保留。
    expect(summary.arcEmergenceBeats).toHaveLength(1);
    expect(summary.arcEmergenceBeats![0].id).toBe('b2');
  });
});
