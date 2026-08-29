import { describe, expect, it } from 'vitest';
import {
  detectStoryTimeDrift,
  STORYTIME_DRIFT_TOLERANCE,
  type SceneGraph,
  type SceneNode,
} from '@orison/shared-contracts';
import { summarizeRunSnapshot } from '../src/runtime/chainRunner';
import type { RunSnapshot } from '../src/contracts/run';
import { createStoryTimeDriftNode } from '../src/nodes/storytime-drift-node';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4 C2（design §3.3）：提取器 storyTime 漂移守卫测试。
//
// 三层：
// 1. 纯函数 detectStoryTimeDrift（shared）——错位 fixture 产 warning / 对齐零噪音 / 无数据章零报警
//    / 容差放宽（AC-11）。
// 2. 链段节点 createStoryTimeDriftNode——artifact 形态 + graceful 跳过（episodeId 缺 /
//    world_state.events 缺 / 坏条目丢好条目留）。
// 3. summarizeRunSnapshot driftWarnings 透出——mirror archiveIssues per-element safeParse 守性。
// ─────────────────────────────────────────────────────────────────────────────

function scene(id: string, storyTime: number, episodeId: string): SceneNode {
  return {
    id,
    storyTime,
    presentationOrder: { chapter: 0, pos: 0 },
    role: 'normal',
    lineTags: [],
    episodeId,
  };
}

/** 本章 ep-1 场窗 [100, 300] 的 scene_graph（a@100 / b@300 两场，episodeId 直挂）。 */
function makeGraph(): SceneGraph {
  return {
    nodes: [scene('s_a', 100, 'ep-1'), scene('s_b', 300, 'ep-1'), scene('s_other', 50, 'ep-2')],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };
}

describe('detectStoryTimeDrift（纯函数，design §3.3 / AC-11）', () => {
  it('错位 fixture：slice storyTime 在窗外（前/后各一）→ 2 条 warning 带 direction 与窗字段', () => {
    const warnings = detectStoryTimeDrift(makeGraph(), 'ep-1', [
      { sliceId: 'ep-1:100', storyTime: 100 }, // 窗内（= min）
      { sliceId: 'ep-1:300', storyTime: 300 }, // 窗内（= max）
      { sliceId: 'ep-1:40', storyTime: 40 }, // 窗前
      { sliceId: 'ep-1:900', storyTime: 900 }, // 窗后
    ]);
    expect(warnings).toEqual([
      { sliceId: 'ep-1:40', storyTime: 40, direction: 'before', windowMin: 100, windowMax: 300 },
      { sliceId: 'ep-1:900', storyTime: 900, direction: 'after', windowMin: 100, windowMax: 300 },
    ]);
  });

  it('对齐 fixture（全在窗内，含边界）→ 零 warning（零噪音）', () => {
    expect(
      detectStoryTimeDrift(makeGraph(), 'ep-1', [
        { sliceId: 'ep-1:100', storyTime: 100 },
        { sliceId: 'ep-1:200', storyTime: 200 },
        { sliceId: 'ep-1:300', storyTime: 300 },
      ]),
    ).toEqual([]);
  });

  it('无数据章零报警：无 slices / 本章无归属场 / episodeId 缺 / scene_graph 缺 → 全空', () => {
    expect(detectStoryTimeDrift(makeGraph(), 'ep-1', [])).toEqual([]); // 无 slices（CR-E8 空提取）
    expect(detectStoryTimeDrift(makeGraph(), 'ep-x', [{ sliceId: 'ep-x:10', storyTime: 10 }])).toEqual([]); // 本章无归属场（窗不可算，零噪音）
    expect(detectStoryTimeDrift(makeGraph(), undefined, [{ sliceId: 'x:10', storyTime: 10 }])).toEqual([]);
    expect(detectStoryTimeDrift(undefined, 'ep-1', [{ sliceId: 'x:10', storyTime: 10 }])).toEqual([]);
  });

  it('presentationSpans M:N 场计入窗（isSceneInEpisode 单源——跨章场也属本章窗）', () => {
    const graph = makeGraph();
    graph.nodes.push({
      ...scene('s_span', 500, 'ep-9'),
      presentationSpans: [{ episodeId: 'ep-1', pos: 0 }],
    });
    // 窗扩到 [100, 500]：原「窗后」的 400 现在窗内。
    expect(detectStoryTimeDrift(graph, 'ep-1', [{ sliceId: 'ep-1:400', storyTime: 400 }])).toEqual([]);
    // 600 仍在窗外（after）。
    expect(detectStoryTimeDrift(graph, 'ep-1', [{ sliceId: 'ep-1:600', storyTime: 600 }])).toHaveLength(1);
  });

  it('容差放宽：tolerance>0 时小漂移不报、大漂移仍报（初值 0 严格窗——校准点 dogfood）', () => {
    expect(STORYTIME_DRIFT_TOLERANCE).toBe(0); // 初值钉死（dogfood 校准前不动）
    const slices = [{ sliceId: 'ep-1:90', storyTime: 90 }]; // 窗前 10
    expect(detectStoryTimeDrift(makeGraph(), 'ep-1', slices)).toHaveLength(1); // 严格窗：报
    expect(detectStoryTimeDrift(makeGraph(), 'ep-1', slices, 10)).toEqual([]); // 容差 10：不报
    expect(detectStoryTimeDrift(makeGraph(), 'ep-1', [{ sliceId: 'ep-1:50', storyTime: 50 }], 10)).toHaveLength(1); // 窗前 50 > 容差：仍报
  });
});

// ── 链段节点 ──

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_drift',
    status: 'running',
    currentNodeId: 'storytime-drift-node',
    projectPath: '/test',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
  };
}

/** world-merge 产 `world_state.events` artifact 形态（writes[] 含 sliceId/storyTime）。 */
function worldEvents(writes: Array<{ sliceId: string; storyTime: number }>): Record<string, unknown> {
  return {
    writes: writes.map((w) => ({ ...w, title: 't', patchCount: 1, subjectCount: 1 })),
    totalPatches: writes.length,
    totalSubjects: 0,
    writeErrors: [],
  };
}

describe('storytime-drift-node（链段节点，design §3.3 链位旁守卫步骤）', () => {
  it('错位 fixture → artifact 携 warnings + 窗字段 + 永不 error:true（零阻断）', async () => {
    const node = createStoryTimeDriftNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1', brief: {} },
        scene_graph: makeGraph(),
        'world_state.events': worldEvents([
          { sliceId: 'ep-1:100', storyTime: 100 },
          { sliceId: 'ep-1:40', storyTime: 40 },
        ]),
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('storytime_drift');
    const artifact = result.artifact as {
      checked: boolean;
      windowMin: number;
      windowMax: number;
      warnings: Array<{ direction: string }>;
      error?: boolean;
    };
    expect(artifact.checked).toBe(true);
    expect(artifact.windowMin).toBe(100);
    expect(artifact.windowMax).toBe(300);
    expect(artifact.warnings).toHaveLength(1);
    expect(artifact.warnings[0].direction).toBe('before');
    expect((artifact as { error?: boolean }).error).toBeUndefined(); // 观测非门禁
  });

  it('对齐 fixture → checked + 空 warnings（零噪音，summary 不带空载荷）', async () => {
    const node = createStoryTimeDriftNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        scene_graph: makeGraph(),
        'world_state.events': worldEvents([{ sliceId: 'ep-1:250', storyTime: 250 }]),
      }),
      requirement: '',
    });
    const artifact = result.artifact as { checked: boolean; warnings: unknown[] };
    expect(artifact.checked).toBe(true);
    expect(artifact.warnings).toEqual([]);
  });

  it('graceful 跳过：episodeId 缺 / world_state.events 缺 → checked:false + skipped 原因，链不破', async () => {
    const node = createStoryTimeDriftNode();
    const noEp = await node.run({ run: makeRun({ scene_graph: makeGraph() }), requirement: '' });
    expect((noEp.artifact as { checked: boolean; skipped: string }).skipped).toBe('no_episodeId');
    expect((noEp.artifact as { episodeId: null }).episodeId).toBeNull();

    const noEvents = await node.run({
      run: makeRun({ chapter_brief_input: { episodeId: 'ep-1' }, scene_graph: makeGraph() }),
      requirement: '',
    });
    expect((noEvents.artifact as { checked: boolean; skipped: string }).skipped).toBe('no_world_events');
  });

  it('坏条目丢好条目留（writes 非数组条目 / 坏 sliceId / 非整数 storyTime 单独丢）', async () => {
    const node = createStoryTimeDriftNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        scene_graph: makeGraph(),
        'world_state.events': {
          writes: [
            null, // 坏条目：丢
            { sliceId: '', storyTime: 100 }, // 坏 sliceId：丢
            { sliceId: 'ep-1:abc', storyTime: 1.5 }, // 非整数 storyTime：丢
            { sliceId: 'ep-1:400', storyTime: 400 }, // 好条目：窗后漂移
          ],
        },
      }),
      requirement: '',
    });
    const artifact = result.artifact as { warnings: Array<{ sliceId: string }> };
    expect(artifact.warnings.map((w) => w.sliceId)).toEqual(['ep-1:400']);
  });
});

// ── summarize 透出（mirror archiveIssues per-element safeParse）──

describe('summarizeRunSnapshot — driftWarnings 透出（3.3 校验议题通道链路）', () => {
  const WARNING = { sliceId: 'ep-1:40', storyTime: 40, direction: 'before', windowMin: 100, windowMax: 300 };

  it('storytime_drift artifact warnings 在 → summary.driftWarnings 透出', () => {
    const summary = summarizeRunSnapshot({
      ...makeRun({ storytime_drift: { runId: 'r', episodeId: 'ep-1', checked: true, warnings: [WARNING], summary: 'drift' } }),
      status: 'completed',
    });
    expect(summary.driftWarnings).toEqual([WARNING]);
  });

  it('空 warnings / artifact 缺 → 缺省（零痕迹，summary 不带空载荷）', () => {
    const ok = summarizeRunSnapshot({
      ...makeRun({ storytime_drift: { runId: 'r', episodeId: 'ep-1', checked: true, warnings: [], summary: 'ok' } }),
      status: 'completed',
    });
    expect(ok.driftWarnings).toBeUndefined();
    expect(summarizeRunSnapshot({ ...makeRun({}), status: 'completed' }).driftWarnings).toBeUndefined();
  });

  it('坏条目 safeParse 丢好条目留（mirror arcEmergenceBeats per-element 哲学）', () => {
    const summary = summarizeRunSnapshot({
      ...makeRun({
        storytime_drift: {
          runId: 'r',
          episodeId: 'ep-1',
          checked: true,
          warnings: [{ sliceId: 'bad', storyTime: 'x', direction: 'before' }, WARNING], // 首条坏
          summary: 'drift',
        },
      }),
      status: 'completed',
    });
    expect(summary.driftWarnings).toEqual([WARNING]);
  });
});
