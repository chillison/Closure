import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sceneNodeSchema, episodeOutlineSchema, type SceneGraph, type WorldPatch } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.6 Phase D：brief-compiler-node #6 stateAtT 接通（reduce 反哺）。
// 核心断言：
// 1. query_world_slice builtin 工具注册 + 返 patches → compilePlotPoints 每场按 storyTime reduce 填 stateAtT
// 2. stateAtT shape = WorldStateSnapshot（{ at, subjects:[{subjectId,state,issueCount}] }）
// 3. graceful：工具未注册 / 无 patches → stateAtT undefined（4.1 既有状态不造假）
//
// vi.mock registry：fetchWorldPatchesViaTool 经 registry.get('query_world_slice') 取工具；
// 测试控制 mock tool 的返回（patches fixture / 抛错 / undefined=未注册）以覆盖三条路径。
// ─────────────────────────────────────────────────────────────────────────────

// mock registry：每个测试设置 mockGet（undefined = 工具未注册；否则 mock tool.execute 返预设 slices）。
let mockGet: ((id: string) => unknown) | undefined;
vi.mock('../src/tool/registry', () => ({
  registry: {
    get: (id: string) => mockGet?.(id),
  },
}));

import { createBriefCompilerNode } from '../src/nodes/brief-compiler-node';
import type { RunSnapshot } from '../src/contracts/run';

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_state',
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
const TARGET_EPISODE = 'ep1';

function scene(partial: Record<string, unknown>) {
  return sceneNodeSchema.parse({
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...partial,
  });
}

/** 两场（s_a storyTime=10 / s_b storyTime=20），都挂 TARGET_EPISODE。 */
function buildSceneGraph(): SceneGraph {
  return {
    nodes: [
      scene({ id: 's_a', episodeId: TARGET_EPISODE, storyTime: 10 }),
      scene({ id: 's_b', episodeId: TARGET_EPISODE, storyTime: 20 }),
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };
}

/** 构造 mock query_world_slice tool：execute 返含 patches 的 slices（metadata.slices[].patches）。 */
function mockToolReturning(slices: Array<{ patches: WorldPatch[] }>): unknown {
  return {
    execute: async () => ({
      title: 'query_world_slice',
      output: '',
      metadata: { ok: true, count: slices.length, slices },
    }),
  };
}

/** 前章状态 fixture：主角 hp 在 storyTime 5 设 100，storyTime 15 扣 30（=70）。 */
function priorChapterPatches(): WorldPatch[] {
  return [
    {
      id: 'p1', sliceId: 'sl1', subjectId: 'erina', path: '/hp', op: 'replace',
      value: 100, axis: 'physical', source: 'derived', storyTime: 5,
    } as WorldPatch,
    {
      id: 'p2', sliceId: 'sl1', subjectId: 'erina', path: '/hp', op: 'increment',
      value: -30, axis: 'physical', source: 'derived', storyTime: 15,
    } as WorldPatch,
  ];
}

beforeEach(() => {
  mockGet = undefined; // 默认未注册（graceful 路径）。
});

describe('brief-compiler-node #6 stateAtT（Phase D 接通）', () => {
  it('工具注册 + 返 patches → 每场按 storyTime reduce 填 stateAtT（WorldStateSnapshot shape）', async () => {
    const patches = priorChapterPatches();
    mockGet = (id: string) => (id === 'query_world_slice' ? mockToolReturning([{ patches }]) : undefined);

    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as {
      plotPoints: Array<{ sceneId: string; stateAtT?: { at: number; subjects: Array<{ subjectId: string; state: Record<string, unknown> }> } }>;
    };
    const byId = Object.fromEntries(brief.plotPoints.map((p) => [p.sceneId, p.stateAtT]));

    // s_a storyTime=10：erina hp=100（5 的 replace 已生效；15 的 increment -30 被截断 storyTime 10<15）。
    expect(byId.s_a?.at).toBe(10);
    const erinaAtA = byId.s_a.subjects.find((s) => s.subjectId === 'erina');
    expect(erinaAtA?.state.hp).toBe(100);

    // s_b storyTime=20：erina hp=70（5 + 15 都生效，100-30）。
    expect(byId.s_b?.at).toBe(20);
    const erinaAtB = byId.s_b.subjects.find((s) => s.subjectId === 'erina');
    expect(erinaAtB?.state.hp).toBe(70);
  });

  it('工具未注册（测试环境 registry 空）→ stateAtT undefined（graceful，4.1 既有状态不造假）', async () => {
    mockGet = () => undefined; // 工具未注册。

    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as { plotPoints: Array<{ stateAtT?: unknown }> };
    for (const p of brief.plotPoints) {
      expect(p.stateAtT).toBeUndefined();
    }
  });

  it('工具返空 patches（首章无前章状态）→ stateAtT undefined（graceful）', async () => {
    mockGet = (id: string) => (id === 'query_world_slice' ? mockToolReturning([{ patches: [] }]) : undefined);

    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as { plotPoints: Array<{ stateAtT?: unknown }> };
    for (const p of brief.plotPoints) {
      expect(p.stateAtT).toBeUndefined();
    }
  });

  it('工具 execute 抛错 → stateAtT undefined（graceful，不崩节点）', async () => {
    mockGet = (id: string) =>
      id === 'query_world_slice'
        ? { execute: async () => { throw new Error('IPC failed'); } }
        : undefined;

    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    // 节点不崩（产 chapter_brief artifact，非 error artifact）。
    expect(result.stateKey).toBe('chapter_brief');
    const brief = result.artifact as { plotPoints: Array<{ stateAtT?: unknown }> };
    for (const p of brief.plotPoints) {
      expect(p.stateAtT).toBeUndefined();
    }
  });

  it('该场 storyTime 前无 populated 状态 → stateAtT undefined（snapshot subjects 空 → graceful）', async () => {
    // patches 全在 storyTime 100+（两场 storyTime 10/20 都截断完）→ snapshot subjects 空 → undefined。
    const patches: WorldPatch[] = [
      {
        id: 'p_late', sliceId: 'sl_late', subjectId: 'erina', path: '/hp', op: 'replace',
        value: 100, axis: 'physical', source: 'derived', storyTime: 100,
      } as WorldPatch,
    ];
    mockGet = (id: string) => (id === 'query_world_slice' ? mockToolReturning([{ patches }]) : undefined);

    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as { plotPoints: Array<{ stateAtT?: unknown }> };
    for (const p of brief.plotPoints) {
      expect(p.stateAtT).toBeUndefined();
    }
  });
});
