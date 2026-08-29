import { describe, expect, it } from 'vitest';
import { promiseRegistrySchema, type SceneGraph } from '@orison/shared-contracts';
import { assembleSceneWeightSignals, extractGenreCommitments } from '../src/tool/batch-signals';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 3：SceneWeightSignal L1 信号汇编（纯代码机械事实——零语义判断红线）。
// 各信号源（anchor / Promise 节拍 / 情绪峰 / InfoRelease / world-state 在场 / 大纲丰富度降级）。
// ─────────────────────────────────────────────────────────────────────────────

const FULL_EPISODE = {
  id: 'ep1',
  index: 1,
  title: '第1章',
  summary: '摘要',
  purpose: '目的',
  core_event: '核心事件',
  hook: '钩子',
  emotional_beats: ['紧张'],
  pacing_beats: ['推进'],
  foreshadowing: ['信物'],
  payoffs: [],
  character_progressions: [],
  status: 'planned' as const,
  dependsOn: [],
};

function makeGraph(): SceneGraph {
  return {
    nodes: [
      {
        id: 's-heavy',
        lineTags: ['main'],
        episodeId: 'ep1',
        storyTime: 3,
        storyTimeLabel: '第3日黄昏',
        presentationOrder: { chapter: 1, pos: 0 },
        role: 'core-anchor',
        outcomeType: '惨胜',
        pacingRole: '高潮',
        assetRefs: ['char-a', 'char-b'],
      },
      {
        id: 's-plain',
        lineTags: ['main'],
        episodeId: 'ep1',
        storyTime: 4,
        presentationOrder: { chapter: 1, pos: 1 },
        role: 'normal',
      },
    ],
    edges: [
      { id: 'e1', from: 's-plain', to: 's-heavy', type: 'CAUSAL' },
      { id: 'e2', from: 's-heavy', to: 's-plain', type: 'CAUSAL' },
      { id: 'e3', from: 's-heavy', to: 'nowhere', type: 'SUSPENSE' },
    ],
    lines: [{ id: 'main', name: '主线' }],
    art_overrides: [],
    version: 0,
    updatedBy: 'user',
  } as SceneGraph;
}

describe('Story 3.5 — assembleSceneWeightSignals', () => {
  it('各信号源齐备：结构 + Promise 节拍 + 逾期 + 情绪 + 信息释放 + world-state 在场', () => {
    const signals = assembleSceneWeightSignals(
      {
        sceneGraph: makeGraph(),
        episodeOutlines: [FULL_EPISODE],
        promiseRegistry: promiseRegistrySchema.parse({
          promises: [
            { id: 'p1', title: '身世之谜', summary: '读者被许诺主角身世将揭晓', status: 'open', deadlineEpisodeId: 'ep1' },
            { id: 'p2', title: '已兑现', summary: '已兑现的承诺', status: 'fulfilled' },
          ],
          beats: [
            { id: 'bt1', promiseId: 'p1', sceneRef: 's-heavy', kind: 'payoff' },
            { id: 'bt2', promiseId: 'p2', sceneRef: 's-other', kind: 'plant' },
          ],
        }),
        emotionCurve: {
          unit: 'scene',
          points: [
            {
              refId: 's-heavy',
              sceneMood: '紧张',
              sceneVad: { v: -0.4, a: 0.8, d: -0.2 },
              characters: [{ characterId: 'char-a', emotion: '恐惧', emotionEnd: '决意' }],
            },
          ],
          emotional_promises: [],
          catharsis_points: [],
        },
        infoReleaseMap: {
          entries: [
            { id: 'ir1', sceneRef: 's-heavy', reveal: ['真相A'], withhold: ['秘密B', '秘密C'], directive: { mode: 'sustain_unknown', actions: ['withhold'] } },
            { id: 'ir2', sceneRef: 's-heavy', reveal: ['线索D'] },
          ],
          version: 0,
          updatedBy: 'agent',
        },
        worldStatePatchCounts: new Map([['char-a', 7], ['char-b', 0], ['ghost', 3]]),
      },
      ['s-heavy', 's-plain'],
      { 's-heavy': 'ch-1', 's-plain': 'ch-1' },
    );

    expect(signals).toHaveLength(2);
    const heavy = signals[0];
    expect(heavy.sceneId).toBe('s-heavy');
    expect(heavy.chapterId).toBe('ch-1');
    expect(heavy.anchorType).toBe('core-anchor');
    expect(heavy.outcomeType).toBe('惨胜');
    expect(heavy.pacingRole).toBe('高潮');
    // 因果边计数（in 1 + out 2；e3 的 to 不在 sceneIds 但 from 在 → 计）。
    expect(heavy.causalEdgeCount).toBe(3);
    // Promise 节拍：只收 sceneRef 命中场（bt2 属 s-other 不收）。
    expect(heavy.promiseBeats).toEqual([{ promiseId: 'p1', kind: 'payoff', promiseTitle: '身世之谜' }]);
    // 逾期：open + deadlineEpisodeId === 本场 episode。
    expect(heavy.promiseDueTitles).toEqual(['身世之谜']);
    // 情绪投影。
    expect(heavy.emotion?.sceneMood).toBe('紧张');
    expect(heavy.emotion?.characters).toEqual([{ characterId: 'char-a', emotion: '恐惧', emotionEnd: '决意' }]);
    // 信息释放。
    expect(heavy.infoRelease).toEqual({ entryCount: 2, modes: ['sustain_unknown'], revealCount: 2, withholdCount: 2 });
    // world-state 在场（char-a 有历史；char-b 0 不列；ghost 非 assetRefs 不列）。
    expect(heavy.worldStateSubjects).toEqual([{ subjectId: 'char-a', patchCount: 7 }]);
    // 丰富度：episode 8 信号（summary/purpose/core_event/hook/4 beats 数组）≥5 + 场细节 4 ≥2 → rich。
    expect(heavy.outlineRichness).toBe('rich');

    const plain = signals[1];
    expect(plain.anchorType).toBeUndefined();
    expect(plain.promiseBeats).toEqual([]);
    expect(plain.emotion).toBeUndefined();
    expect(plain.infoRelease).toBeUndefined();
    expect(plain.worldStateSubjects).toEqual([]);
    expect(plain.causalEdgeCount).toBe(2);
  });

  it('数据源全缺 → graceful 降级（outlineRichness=none，无假数据）', () => {
    const signals = assembleSceneWeightSignals({ sceneGraph: makeGraph() }, ['s-heavy']);
    const s = signals[0];
    expect(s.promiseBeats).toEqual([]);
    expect(s.promiseDueTitles).toEqual([]);
    expect(s.emotion).toBeUndefined();
    expect(s.infoRelease).toBeUndefined();
    expect(s.worldStateSubjects).toEqual([]);
    // 无 episode outline → none（大纲鲁棒信号：leader 降级靠题材承诺+正文+world state 判）。
    expect(s.outlineRichness).toBe('none');
  });

  it('大纲丰富度三档：sparse（部分字段）vs rich（阈值齐）', () => {
    const sparseEpisode = { ...FULL_EPISODE, core_event: undefined, hook: undefined, emotional_beats: [], pacing_beats: [], foreshadowing: [] };
    const signals = assembleSceneWeightSignals(
      { sceneGraph: makeGraph(), episodeOutlines: [sparseEpisode] },
      ['s-heavy', 's-plain'],
    );
    // s-heavy：episode 信号 3（summary/purpose/progressions? no—progressions []）→ 实际 summary+purpose=2 <5 → sparse；
    // s-plain：episode 同 2 + 场细节 0 → sparse（episode 存在即非 none）。
    expect(signals[0].outlineRichness).toBe('sparse');
    expect(signals[1].outlineRichness).toBe('sparse');
  });

  it('schema 校验通过（SceneWeightSignal 契约形态）', async () => {
    const { sceneWeightSignalSchema } = await import('@orison/shared-contracts');
    const signals = assembleSceneWeightSignals({ sceneGraph: makeGraph() }, ['s-heavy']);
    for (const s of signals) {
      expect(sceneWeightSignalSchema.safeParse(s).success).toBe(true);
    }
  });
});

describe('Story 3.5 — extractGenreCommitments', () => {
  it('抽 creative_brief.commitments（滤空条目）；缺 → []', () => {
    expect(
      extractGenreCommitments({ commitments: [{ type: 'HE', content: '圆满结局' }, { type: '', content: 'x' }] }),
    ).toEqual([{ type: 'HE', content: '圆满结局' }]);
    expect(extractGenreCommitments(undefined)).toEqual([]);
    expect(extractGenreCommitments({})).toEqual([]);
  });
});
