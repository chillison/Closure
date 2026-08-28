import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  episodeOutlineSchema,
  infoReleaseMapSchema,
  sceneNodeSchema,
  type InfoReleaseMap,
  type SceneGraph,
} from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4 C1/C2（design §3.1 路径 4/6 + §3.2 INV-4）：agent 侧 as-of 审计。
//
// 路径 4（info-release compileInfoRelease）：非本章 episode 的 entries 零进简报
// （episodeId/sceneRef 双锚任一命中本章才进；sceneRef 直判路径正反例）。既有锚：
// brief-compiler-node.test.ts「filter 本章相关」——本文件是审计角度的补钉 + INV-4
// 对拍（compileInfoRelease 输出 × collectChapterSceneIds 本章场集）。
//
// 路径 6（brief #6 state-at-T）：build_world_snapshot 批量 ats 主路径的映射正确性
// （请求的 ats = 本章场 storyTime 去重首见序；每场贴回 at=该场 storyTime 的 snapshot；
// 同 storyTime 场共享同一条；空 snapshot 项 → stateAtT undefined）。
// 边界数学（storyTime ≤ at：前场数据在/后场数据不在）不在 mock 层重测——由两处真
// 实锚钉死：fallback 路径真 fold（brief-compiler-stateAtT.test.ts：s_a@10 含 t=5 的
// hp=100、不含 t=15 的 -30）+ shell 真 db（worldStateAsOfAudit.test.ts 路径 1）。
//
// 不变量清单权威源：shared-contracts/tests/as-of-invariants.test.ts `INVARIANT_LIST`
// （INV id 进测试标题，「后续加不变量 = 加测试」）。
// ─────────────────────────────────────────────────────────────────────────────

// mock registry：每个测试设置 mockGet（undefined = 工具未注册）。
let mockGet: ((id: string) => unknown) | undefined;
vi.mock('../src/tool/registry', () => ({
  registry: {
    get: (id: string) => mockGet?.(id),
  },
}));

import {
  createBriefCompilerNode,
  collectChapterSceneIds,
} from '../src/nodes/brief-compiler-node';
import type { RunSnapshot } from '../src/contracts/run';

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_asof',
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
  episodeOutlineSchema.parse({ id: 'ep2', index: 1, title: '第二章' }),
  episodeOutlineSchema.parse({ id: 'ep3', index: 2, title: '第三章' }),
];
const TARGET_EPISODE = 'ep2'; // index 1 = 本章

function scene(partial: Record<string, unknown>) {
  return sceneNodeSchema.parse({
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...partial,
  });
}

beforeEach(() => {
  mockGet = undefined; // 默认无工具（路径 4 隔离：stateAtT 走 graceful undefined）
});

// ── 路径 4 + INV-4：compileInfoRelease episode 过滤（非本章零泄漏） ──

describe('as-of 审计：compileInfoRelease 非本章 entries 零泄漏（C1 路径 4 / INV-4）', () => {
  /**
   * 本章场集：s_cur（episodeId 直挂 ep2）/ s_span（presentationSpans 含 ep2）。
   * 非本章：s_other（ep1 直挂）/ s_future_span（spans 仅 ep3）/ s_ghost_scene（graph 外）。
   */
  function chapterSceneGraph(): SceneGraph {
    return {
      nodes: [
        scene({ id: 's_cur', episodeId: TARGET_EPISODE }),
        scene({ id: 's_span', presentationSpans: [{ episodeId: TARGET_EPISODE, pos: 0 }] }),
        scene({ id: 's_other', episodeId: 'ep1' }),
        scene({ id: 's_future_span', presentationSpans: [{ episodeId: 'ep3', pos: 0 }] }),
      ],
      edges: [],
      lines: [],
      art_overrides: [],
      version: 0,
      updatedBy: 'agent',
    };
  }

  function makeInfoReleaseMap(entries: Record<string, unknown>[]): InfoReleaseMap {
    return infoReleaseMapSchema.parse({ entries });
  }

  it('INV-4：非本章 entry（episodeId 他章 ∧ sceneRef ∉ 本章场集）零进简报；双锚正反例', async () => {
    const sceneGraph = chapterSceneGraph();
    const map = makeInfoReleaseMap([
      // 正例①：episodeId + sceneRef 双锚全中本章 → 进。
      { id: 'ir_cur', sceneRef: 's_cur', episodeId: TARGET_EPISODE, directive: { mode: 'reveal_first', actions: ['release'], target: 'T-cur' } },
      // 正例②：sceneRef 直判路径（无 episodeId）——sceneRef ∈ 本章场集（s_span spans 命中）→ 进。
      { id: 'ir_span', sceneRef: 's_span', directive: { mode: 'reveal_first', actions: ['release'], target: 'T-span' } },
      // 正例③：episodeId 直挂本章（sceneRef 指他章场）→ 进（episodeId 是合法归属锚，
      // mirror 既有锚 brief-compiler-node.test.ts ir_ep；sceneRef 一致性归 Director 数据面非过滤面）。
      { id: 'ir_ep_direct', sceneRef: 's_other', episodeId: TARGET_EPISODE, directive: { mode: 'reveal_first', actions: ['release'], target: 'T-ep-direct' } },
      // 反例①：episodeId 他章 + sceneRef 他章直挂场 → 拒。
      { id: 'ir_other_ep', sceneRef: 's_other', episodeId: 'ep1', directive: { mode: 'reveal_first', actions: ['release'], target: 'T-out-1' } },
      // 反例②：episodeId 他章 + sceneRef 悬空（graph 外）→ 拒。
      { id: 'ir_dangling', sceneRef: 's_ghost_scene', episodeId: 'ep1', directive: { mode: 'reveal_first', actions: ['release'], target: 'T-out-2' } },
      // 反例③：episodeId 他章 + sceneRef 指他章 spans 场（s_future_span 仅 ep3）→ 拒。
      { id: 'ir_future_span', sceneRef: 's_future_span', episodeId: 'ep3', directive: { mode: 'reveal_first', actions: ['release'], target: 'T-out-3' } },
    ]);

    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: sceneGraph,
        episode_outlines: EPISODES,
        info_release_map: map,
      }),
      requirement: '',
    });

    const brief = result.artifact as { readerKnows?: string; manipulationDirectives: unknown[] };
    // 三个正例进、三个反例零泄漏。
    expect(brief.manipulationDirectives).toHaveLength(3);
    expect(brief.readerKnows).toContain('T-cur');
    expect(brief.readerKnows).toContain('T-span');
    expect(brief.readerKnows).toContain('T-ep-direct');
    for (const out of ['T-out-1', 'T-out-2', 'T-out-3']) {
      expect(brief.readerKnows).not.toContain(out);
    }

    // INV-4 对拍面：sceneRef 直判路径的进入者（ir_span）其 sceneRef ∈ 本章场集；
    // 本章场集单源（collectChapterSceneIds × isSceneInEpisode）与过滤判据一致。
    const chapterSceneIds = collectChapterSceneIds(sceneGraph, TARGET_EPISODE);
    expect([...chapterSceneIds].sort()).toEqual(['s_cur', 's_span']);
    expect(chapterSceneIds.has('s_other')).toBe(false);
    expect(chapterSceneIds.has('s_future_span')).toBe(false);
  });
});

// ── 路径 6：brief #6 stateAtT 批量 ats 主路径（build_world_snapshot）映射 ──

describe('as-of 审计：brief #6 stateAtT 批量 ats 主路径映射（C1 路径 6）', () => {
  /** 三场：s_a@10 / s_c@10（同 storyTime）/ s_b@20，全挂 TARGET_EPISODE。 */
  function storyTimeSceneGraph(): SceneGraph {
    return {
      nodes: [
        scene({ id: 's_a', episodeId: TARGET_EPISODE, storyTime: 10 }),
        scene({ id: 's_c', episodeId: TARGET_EPISODE, storyTime: 10 }),
        scene({ id: 's_b', episodeId: TARGET_EPISODE, storyTime: 20 }),
      ],
      edges: [],
      lines: [],
      art_overrides: [],
      version: 0,
      updatedBy: 'agent',
    };
  }

  /** mock build_world_snapshot：捕获请求 params + 按预设 snapshots 返回。 */
  function mockBuildWorldSnapshot(
    snapshots: unknown[],
  ): { paramsList: Array<Record<string, unknown>> } {
    const paramsList: Array<Record<string, unknown>> = [];
    mockGet = (id: string) =>
      id === 'build_world_snapshot'
        ? {
            execute: async (_params: Record<string, unknown>) => {
              paramsList.push(_params);
              return {
                title: 'build_world_snapshot',
                output: '',
                metadata: { ok: true, snapshots },
              };
            },
          }
        : undefined;
    return { paramsList };
  }

  it('请求 ats = 本章场 storyTime 去重首见序（10,20）；每场贴回 at=自身 storyTime 的 snapshot；同 storyTime 共享', async () => {
    const { paramsList } = mockBuildWorldSnapshot([
      { at: 10, subjects: [{ subjectId: 'erina', state: { hp: 100 }, issueCount: 0 }] },
      { at: 20, subjects: [{ subjectId: 'erina', state: { hp: 70 }, issueCount: 0 }] },
    ]);

    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: storyTimeSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    // 一次批量 IPC；ats 去重（s_a/s_c 共享 10）+ 首见序；projection 固定 state。
    expect(paramsList).toHaveLength(1);
    expect(paramsList[0]).toMatchObject({ ats: [10, 20], projection: 'state' });
    // 不走 fallback（query_world_slice 未注册也不会被取）。

    const brief = result.artifact as {
      plotPoints: Array<{
        sceneId: string;
        stateAtT?: { at: number; subjects: Array<{ subjectId: string; state: Record<string, unknown> }> };
      }>;
    };
    const byId = Object.fromEntries(brief.plotPoints.map((p) => [p.sceneId, p.stateAtT]));

    // 每场贴回 at = 自身 storyTime 的 snapshot（不串位）。
    expect(byId.s_a?.at).toBe(10);
    expect(byId.s_a?.subjects.find((s) => s.subjectId === 'erina')?.state.hp).toBe(100);
    expect(byId.s_c?.at).toBe(10);
    expect(byId.s_c?.subjects.find((s) => s.subjectId === 'erina')?.state.hp).toBe(100);
    expect(byId.s_b?.at).toBe(20);
    expect(byId.s_b?.subjects.find((s) => s.subjectId === 'erina')?.state.hp).toBe(70);
    // 同 storyTime 场共享同一条 snapshot（fetch 去重，Map 贴回）。
    expect(byId.s_a).toEqual(byId.s_c);
  });

  it('某截断点 snapshot subjects 空 → 该 storyTime 场 stateAtT undefined（贴回层守卫）；其余场不受影响', async () => {
    mockBuildWorldSnapshot([
      { at: 10, subjects: [{ subjectId: 'erina', state: { hp: 100 }, issueCount: 0 }] },
      { at: 20, subjects: [] },
    ]);

    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: storyTimeSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as { plotPoints: Array<{ sceneId: string; stateAtT?: unknown }> };
    const byId = Object.fromEntries(brief.plotPoints.map((p) => [p.sceneId, p.stateAtT]));
    expect(byId.s_a).toBeDefined();
    expect(byId.s_c).toBeDefined();
    expect(byId.s_b).toBeUndefined();
  });

  it('本章无场（scene_graph 空）→ 零 IPC（ats 空数组短路）+ plotPoints 空', async () => {
    const { paramsList } = mockBuildWorldSnapshot([]);
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep9', brief: { goal: 'g' } },
        scene_graph: {
          nodes: [scene({ id: 's_a', episodeId: TARGET_EPISODE, storyTime: 10 })],
          edges: [],
          lines: [],
          art_overrides: [],
          version: 0,
          updatedBy: 'agent',
        },
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    expect(paramsList).toHaveLength(0);
    const brief = result.artifact as { plotPoints: unknown[] };
    expect(brief.plotPoints).toEqual([]);
  });
});
