import { describe, expect, it } from 'vitest';
import type { SceneGraph } from '@orison/shared-contracts';
import {
  BATCH_SCENE_CAP,
  groupScenesByChapter,
  resolveBatchScenePlan,
} from '../src/tool/batch-planning';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 3：场列表解析（拓扑序 / 锚点边界 / graceful 需澄清）+ 场→章分组
//（presentationSpans M:N / 无章映射 graceful / 外键 index 非连续）。
// ─────────────────────────────────────────────────────────────────────────────

function node(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    lineTags: ['main'],
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...overrides,
  };
}

function makeGraph(): SceneGraph {
  return {
    nodes: [
      node('s1', { storyTime: 1, episodeId: 'ep0' }),
      node('s2', { storyTime: 2, episodeId: 'ep0' }),
      // typed 锚点（批量边界）。
      node('s3', { storyTime: 3, episodeId: 'ep1', role: 'core-anchor', storyTimeLabel: '第3日黄昏' }),
      node('s4', { storyTime: 4, episodeId: 'ep1' }),
      // 另一条线。
      node('x1', { lineTags: ['side'], storyTime: 1, episodeId: 'ep1' }),
      // 未指派章的新场。
      node('orphan', { lineTags: ['side'], storyTime: 5 }),
    ],
    edges: [
      { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' },
      { id: 'e2', from: 's2', to: 's3', type: 'CAUSAL' },
      { id: 'e3', from: 's3', to: 's4', type: 'SUSPENSE' },
    ],
    lines: [
      { id: 'main', name: '主线' },
      { id: 'side', name: '支线' },
    ],
    art_overrides: [],
    version: 0,
    updatedBy: 'user',
  } as SceneGraph;
}

const EPISODES = [
  { id: 'ep0', index: 0 },
  { id: 'ep1', index: 1 },
];

const CHAPTERS = [
  { id: 'ch-0', sort_order: 0 },
  { id: 'ch-1', sort_order: 1 },
];

describe('Story 3.5 — resolveBatchScenePlan', () => {
  it('lineTag → 拓扑序截到（含）第一个 typed 锚点', () => {
    const result = resolveBatchScenePlan({ sceneGraph: makeGraph(), lineTag: 'main' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.orderedSceneIds).toEqual(['s1', 's2', 's3']);
      expect(result.targetAnchorSceneId).toBe('s3');
      expect(result.lineTag).toBe('main');
    }
  });

  it('拓扑序遵守因果边（s1→s2→s3），tie-break storyTime 确定性', () => {
    // 乱序 nodes 数组（s3 在最前）——拓扑序仍按边。
    const graph = makeGraph();
    graph.nodes = [graph.nodes[2], graph.nodes[0], graph.nodes[1], graph.nodes[3], graph.nodes[4], graph.nodes[5]];
    const result = resolveBatchScenePlan({ sceneGraph: graph, lineTag: 'main' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.orderedSceneIds).toEqual(['s1', 's2', 's3']);
  });

  it('targetAnchorSceneId 显式锚点 → 截到该场（含）；锚点在选定范围外 → graceful', () => {
    const result = resolveBatchScenePlan({ sceneGraph: makeGraph(), lineTag: 'main', targetAnchorSceneId: 's4' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.orderedSceneIds).toEqual(['s1', 's2', 's3', 's4']);

    const bad = resolveBatchScenePlan({ sceneGraph: makeGraph(), lineTag: 'main', targetAnchorSceneId: 'x1' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('anchor-not-in-selection');
  });

  it('sceneIds 全控列表：存在性校验 + 拓扑序重排（不截断）', () => {
    // 乱序传入 → 按因果边重排。
    const result = resolveBatchScenePlan({ sceneGraph: makeGraph(), sceneIds: ['s3', 's1', 's2'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.orderedSceneIds).toEqual(['s1', 's2', 's3']);

    const bad = resolveBatchScenePlan({ sceneGraph: makeGraph(), sceneIds: ['s1', 'nope'] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('scene-not-found');
  });

  it('无线锚点 → graceful 需澄清（no-anchor，leader 作一次咨询）', () => {
    // side 线无锚点场。
    const result = resolveBatchScenePlan({ sceneGraph: makeGraph(), lineTag: 'side' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-anchor');
  });

  it('lineTag 不存在 → graceful（line-not-found）', () => {
    const result = resolveBatchScenePlan({ sceneGraph: makeGraph(), lineTag: 'ghost' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('line-not-found');
  });

  it('无选择器 → graceful（no-selector）', () => {
    const result = resolveBatchScenePlan({ sceneGraph: makeGraph() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-selector');
  });

  it('因果环残留防御：环成员按 tie-break 追加（不崩——环由 validateSceneGraph 另报）', () => {
    const graph = makeGraph();
    graph.edges.push({ id: 'e4', from: 's4', to: 's2', type: 'CAUSAL' }); // s2→s3→s4→s2 环。
    const result = resolveBatchScenePlan({ sceneGraph: graph, lineTag: 'main', targetAnchorSceneId: 's4' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.orderedSceneIds).toHaveLength(4);
      expect(new Set(result.orderedSceneIds)).toEqual(new Set(['s1', 's2', 's3', 's4']));
    }
  });

  it('BATCH_SCENE_CAP = 8（design §6 默认）', () => {
    expect(BATCH_SCENE_CAP).toBe(8);
  });
});

describe('Story 3.5 — groupScenesByChapter（M:N）', () => {
  it('直挂 episodeId 场按 episode.index → chapter（sort_order===index）', () => {
    const graph = makeGraph();
    const result = groupScenesByChapter(graph, ['s1', 's3'], EPISODES, CHAPTERS);
    expect(result.unmappedSceneIds).toEqual([]);
    expect(result.chapterMap).toEqual({ s1: 'ch-0', s3: 'ch-1' });
  });

  it('presentationSpans 跨章场归最早 episode 的章（M:N：随首个承载章写掉）', () => {
    const graph = makeGraph();
    graph.nodes.push(
      node('span-scene', {
        storyTime: 6,
        episodeId: undefined,
        presentationSpans: [
          { episodeId: 'ep1', pos: 0 },
          { episodeId: 'ep0', pos: 1 },
        ],
      }),
    );
    const result = groupScenesByChapter(graph, ['span-scene'], EPISODES, CHAPTERS);
    expect(result.unmappedSceneIds).toEqual([]);
    // ep0（index 0）最早 → ch-0。
    expect(result.chapterMap['span-scene']).toBe('ch-0');
  });

  it('无章映射（episodeId / spans 缺失）→ unmapped graceful（「需先指派章」信号）', () => {
    const result = groupScenesByChapter(makeGraph(), ['orphan'], EPISODES, CHAPTERS);
    expect(result.unmappedSceneIds).toEqual(['orphan']);
    expect(result.chapterMap).toEqual({});
  });

  it('episode 无对应已注册章（章未注册 / sort_order 冲突）→ unmapped', () => {
    const result = groupScenesByChapter(makeGraph(), ['s1'], EPISODES, [
      { id: 'ch-a', sort_order: 0 },
      { id: 'ch-b', sort_order: 0 }, // sort_order 冲突 → resolveChapterIdForEpisode undefined。
    ]);
    expect(result.unmappedSceneIds).toEqual(['s1']);
  });

  it('外键 index 非连续（gap [0,2]）：按值解析不按数组位置', () => {
    const episodes = [{ id: 'ep0', index: 0 }, { id: 'ep2', index: 2 }];
    const chapters = [{ id: 'ch-0', sort_order: 0 }, { id: 'ch-2', sort_order: 2 }];
    const result = groupScenesByChapter(makeGraph(), ['s1', 's3'], episodes, chapters);
    // s3 挂 ep1（不存在于该 outlines）→ unmapped；s1 → ch-0。
    expect(result.chapterMap).toEqual({ s1: 'ch-0' });
    expect(result.unmappedSceneIds).toEqual(['s3']);
  });
});
