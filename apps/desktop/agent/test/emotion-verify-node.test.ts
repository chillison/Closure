import { describe, expect, it } from 'vitest';
import {
  createEmotionVerifyNode,
  derivePayoffEvents,
  extractCharacterCards,
  EMOTION_VERIFY_RESULT_KEY,
} from '../src/nodes/emotion-verify-node';
import type { EmotionCurve, PromiseRegistry, WorldPatch } from '@orison/shared-contracts';
import type { RunSnapshot } from '../src/contracts/run';
import { registry } from '../src/tool/registry';

// ─────────────────────────────────────────────────────────────────────────────
// Story 5.3 R2：emotion-verify-node 集成测（design §1-§3 / §10 graceful）。
//
// 不测 runEmotionVerify 内部数学（R1 单测已覆盖：setpoint 衰减 / topology / DTW / payoff 联动 / refId dedupe）。
// 测四块（implement.md R2.5）：
// 1. derivePayoffEvents：promise_registry + episodeOutlines → PayoffEvent[]（resolvePromiseFulfillment 派生）。
// 2. extractCharacterCards：asset_cards → CharacterCardForEmotion[]（type='character' + emotionElasticity）。
// 3. 节点 run() artifact 流转：emotion_curve → emotion_verify_result（shape + flag 路径）。
// 4. 🔑 graceful（design §10）：emotion_curve 缺/空 / patches 缺 / payoff 缺 / asset_cards 缺 → 降级不崩链。
//
// 范式（creative-vs-mechanical）：节点是纯代码机械组装（取 4 源 + 调 runEmotionVerify 纯函数），无 LLM。
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_emotion_verify',
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

// 合成 emotion_curve（per-scene points + characters VAD + sceneVad，Director 目标轨形态）。
function makeEmotionCurve(): EmotionCurve {
  return {
    unit: 'scene',
    points: [
      {
        refId: 'scene-1',
        sceneMood: '压抑',
        sceneVad: { v: -0.6, a: 0.3, d: -0.4 },
        characters: [
          {
            characterId: 'char-1',
            emotion: '恐惧',
            vad: { v: -0.7, a: 0.8, d: -0.3 },
          },
        ],
      },
      {
        refId: 'scene-2',
        sceneMood: '爆发',
        sceneVad: { v: 0.1, a: 0.9, d: 0.3 },
        characters: [
          {
            characterId: 'char-1',
            emotion: '愤怒',
            vad: { v: -0.2, a: 0.95, d: 0.4 },
          },
        ],
      },
    ],
    emotional_promises: [],
    catharsis_points: [],
  };
}

// 合成 emotional 轴 patch（per-subject per-chapter，6.6 实际轨形态，value 含 vad 投影）。
// sliceId 默认 'ep1:5'（6.6 稳定 slice.id 约定 `${episodeId}:${storyTime}`，world-state-merge.ts:160）；
// 多章测试传 sliceId 覆盖（如 'ep2:5' / 'ep1:6'），id 含 sliceId 保唯一。
function emotionalPatch(
  subjectId: string,
  vad: { v: number; a: number; d: number },
  storyTime = 5,
  sliceId = 'ep1:5',
): WorldPatch {
  return {
    id: `emo-${subjectId}-${storyTime}-${sliceId}`,
    sliceId,
    subjectId,
    path: '/mood',
    op: 'replace',
    value: { objective: '恐惧', vad },
    axis: 'emotional',
    source: 'derived',
    storyTime,
  } as WorldPatch;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. derivePayoffEvents（纯函数：promise_registry → PayoffEvent[]）
// ════════════════════════════════════════════════════════════════════════════

describe('derivePayoffEvents', () => {
  const episodeOutlines = [
    { id: 'ep1', index: 0 },
    { id: 'ep2', index: 1 },
    { id: 'ep3', index: 2 },
  ];

  it('promise 有有效 payoff beat（resolvePromiseFulfillment=fulfilled）→ {fulfilled:true}', () => {
    const registryData: PromiseRegistry = {
      promises: [
        { id: 'p1', title: 't', summary: 's', status: 'open', importance: 0.5, tags: [], autoFulfill: true, related_asset_ids: [], related_promise_ids: [], source_type: 'emergent' },
      ],
      beats: [
        { id: 'b1', promiseId: 'p1', kind: 'payoff', sceneRef: 'scene-1', state: 'planned' },
      ],
      version: 0,
    };
    const events = derivePayoffEvents(registryData, 'ep2', episodeOutlines);
    expect(events).toEqual([{ fulfilled: true }]);
  });

  it('promise open + deadlineEpisodeId 已过（index < current）→ {fulfilled:false}', () => {
    const registryData: PromiseRegistry = {
      promises: [
        { id: 'p1', title: 't', summary: 's', status: 'open', importance: 0.5, tags: [], autoFulfill: true, related_asset_ids: [], related_promise_ids: [], source_type: 'emergent', deadlineEpisodeId: 'ep1' },
      ],
      beats: [],
      version: 0,
    };
    // currentEpisodeId='ep2'（index 1）> deadline 'ep1'（index 0）→ 已过 → 未兑现。
    const events = derivePayoffEvents(registryData, 'ep2', episodeOutlines);
    expect(events).toEqual([{ fulfilled: false }]);
  });

  it('promise open + deadlineEpisodeId 未到（index > current）→ 不产事件', () => {
    const registryData: PromiseRegistry = {
      promises: [
        { id: 'p1', title: 't', summary: 's', status: 'open', importance: 0.5, tags: [], autoFulfill: true, related_asset_ids: [], related_promise_ids: [], source_type: 'emergent', deadlineEpisodeId: 'ep3' },
      ],
      beats: [],
      version: 0,
    };
    // currentEpisodeId='ep2'（index 1）< deadline 'ep3'（index 2）→ 未到 → 无事件。
    const events = derivePayoffEvents(registryData, 'ep2', episodeOutlines);
    expect(events).toEqual([]);
  });

  it('promise open + deadlineEpisodeId === current（本章尚在写）→ 不产事件（未过）', () => {
    const registryData: PromiseRegistry = {
      promises: [
        { id: 'p1', title: 't', summary: 's', status: 'open', importance: 0.5, tags: [], autoFulfill: true, related_asset_ids: [], related_promise_ids: [], source_type: 'emergent', deadlineEpisodeId: 'ep2' },
      ],
      beats: [],
      version: 0,
    };
    const events = derivePayoffEvents(registryData, 'ep2', episodeOutlines);
    expect(events).toEqual([]);
  });

  it('abandoned promise → 不产事件（既非兑现也非未兑现创伤）', () => {
    const registryData: PromiseRegistry = {
      promises: [
        { id: 'p1', title: 't', summary: 's', status: 'abandoned', importance: 0.5, tags: [], autoFulfill: true, related_asset_ids: [], related_promise_ids: [], source_type: 'emergent' },
      ],
      beats: [],
      version: 0,
    };
    const events = derivePayoffEvents(registryData, 'ep2', episodeOutlines);
    expect(events).toEqual([]);
  });

  it('promise open + deadlineEpisodeId 已过，但 episodeOutlines 缺（无 index）→ 不判未兑现（graceful）', () => {
    const registryData: PromiseRegistry = {
      promises: [
        { id: 'p1', title: 't', summary: 's', status: 'open', importance: 0.5, tags: [], autoFulfill: true, related_asset_ids: [], related_promise_ids: [], source_type: 'emergent', deadlineEpisodeId: 'ep1' },
      ],
      beats: [],
      version: 0,
    };
    // episodeOutlines 空 → 无法判前后 → 不产未兑现事件。
    const events = derivePayoffEvents(registryData, 'ep2', []);
    expect(events).toEqual([]);
  });

  it('空 registry / 空 promises → []', () => {
    expect(derivePayoffEvents(undefined, 'ep1', episodeOutlines)).toEqual([]);
    expect(
      derivePayoffEvents({ promises: [], beats: [], version: 0 }, 'ep1', episodeOutlines),
    ).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. extractCharacterCards（纯函数：asset_cards → CharacterCardForEmotion[]）
// ════════════════════════════════════════════════════════════════════════════

describe('extractCharacterCards', () => {
  it('character 卡带 emotionElasticity → 抽 {id, personality:{emotionElasticity}}', () => {
    const cards = extractCharacterCards([
      { id: 'c1', type: 'character', personality: { emotionElasticity: 0.3 } },
    ]);
    expect(cards).toEqual([{ id: 'c1', personality: { emotionElasticity: 0.3 } }]);
  });

  it('character 卡缺 emotionElasticity → 抽 {id}（computeSetpoint 视为缺失用默认 τ）', () => {
    const cards = extractCharacterCards([
      { id: 'c1', type: 'character', personality: {} },
    ]);
    expect(cards).toEqual([{ id: 'c1', personality: {} }]);
  });

  it('character 卡缺 personality → 抽 {id}（无 personality 字段）', () => {
    const cards = extractCharacterCards([{ id: 'c1', type: 'character' }]);
    expect(cards).toEqual([{ id: 'c1' }]);
  });

  it('非 character 卡（location/prop/...）→ 跳过', () => {
    const cards = extractCharacterCards([
      { id: 'l1', type: 'location', personality: { emotionElasticity: 0.5 } },
      { id: 'p1', type: 'prop' },
    ]);
    expect(cards).toEqual([]);
  });

  it('坏条目（缺 id / 非对象）→ 跳过不抛', () => {
    const cards = extractCharacterCards([
      { type: 'character', personality: { emotionElasticity: 0.5 } }, // 缺 id
      null,
      'not-an-object',
      { id: 'c2', type: 'character', personality: 'not-an-object' }, // personality 非对象 → 抽 {id}
    ]);
    expect(cards).toEqual([{ id: 'c2' }]);
  });

  it('非数组 / undefined → []', () => {
    expect(extractCharacterCards(undefined)).toEqual([]);
    expect(extractCharacterCards('not-array')).toEqual([]);
    expect(extractCharacterCards(null)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. 节点 run() artifact 流转 + shape
// ════════════════════════════════════════════════════════════════════════════

describe('createEmotionVerifyNode — run() artifact 流转', () => {
  it('emotion_curve present → 产 emotion_verify_result artifact（stateKey + 形态）', async () => {
    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({ emotion_curve: makeEmotionCurve() }),
      requirement: '',
    });

    expect(result.stateKey).toBe(EMOTION_VERIFY_RESULT_KEY);
    // artifact 形态：含 flags / characterArcs / readerTopology / adjustedSetpoints / degraded。
    expect(result.artifact).toBeDefined();
    expect(typeof result.artifact).toBe('object');
    const art = result.artifact as { flags: unknown[]; characterArcs: unknown[]; readerTopology: { directions: unknown[] }; adjustedSetpoints: unknown[]; degraded: boolean };
    expect(Array.isArray(art.flags)).toBe(true);
    expect(Array.isArray(art.characterArcs)).toBe(true);
    expect(Array.isArray(art.readerTopology.directions)).toBe(true);
    expect(Array.isArray(art.adjustedSetpoints)).toBe(true);
    expect(typeof art.degraded).toBe('boolean');
  });

  it('emotion_curve 有 VAD → characterArcs 非空（角色层 setpoint 衰减验证跑了）', async () => {
    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({ emotion_curve: makeEmotionCurve() }),
      requirement: '',
    });
    const art = result.artifact as { characterArcs: Array<{ characterId: string }> };
    // char-1 在两点都有 vad → characterArcs 含 char-1 metric。
    expect(art.characterArcs.length).toBeGreaterThan(0);
    expect(art.characterArcs.some((c) => c.characterId === 'char-1')).toBe(true);
  });

  it('readerTopology directions 长度 = points 长度（per-scene 方向）', async () => {
    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({ emotion_curve: makeEmotionCurve() }),
      requirement: '',
    });
    const art = result.artifact as { readerTopology: { directions: unknown[] } };
    // makeEmotionCurve 有 2 points → directions 长 2（首点 flat + 第 2 点方向）。
    expect(art.readerTopology.directions).toHaveLength(2);
  });

  it('不声明 checkpointStage（增强节点，不触发 checkpoint）', () => {
    // chapter-chain.test.ts 已验 chain 装配含本节点 + id；此处验 contract 形态。
    const node = createEmotionVerifyNode();
    expect(node.contract?.nodeId).toBe('emotion-verify-node');
    expect(node.contract?.producedArtifactKeys).toEqual([EMOTION_VERIFY_RESULT_KEY]);
    // requiredArtifactKeys 空（design §10 graceful：emotion_curve 缺也不阻断链）。
    expect(node.contract?.requiredArtifactKeys).toEqual([]);
    expect(node.contract?.sideEffects).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 🔑 graceful（design §10）：数据源缺/坏 → 降级不崩链
// ════════════════════════════════════════════════════════════════════════════

describe('createEmotionVerifyNode — graceful（design §10 不阻断链）', () => {
  it('emotion_curve 缺（undefined）→ degraded result（flags=[], degraded=true），不抛', async () => {
    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({}), // 无 emotion_curve
      requirement: '',
    });
    expect(result.stateKey).toBe(EMOTION_VERIFY_RESULT_KEY);
    const art = result.artifact as { flags: unknown[]; degraded: boolean; degradationNote?: string };
    expect(art.flags).toEqual([]);
    expect(art.degraded).toBe(true);
    expect(art.degradationNote).toMatch(/emotion_curve/);
  });

  it('emotion_curve 空（points=[]）→ degraded result', async () => {
    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({ emotion_curve: { unit: 'scene', points: [], emotional_promises: [], catharsis_points: [] } }),
      requirement: '',
    });
    const art = result.artifact as { flags: unknown[]; degraded: boolean };
    expect(art.flags).toEqual([]);
    expect(art.degraded).toBe(true);
  });

  it('emotion_curve 坏（非对象 / 数组）→ degraded result，不抛', async () => {
    const node = createEmotionVerifyNode();
    const result1 = await node.run({
      run: makeRun({ emotion_curve: 'not-an-object' }),
      requirement: '',
    });
    const result2 = await node.run({
      run: makeRun({ emotion_curve: ['array', 'not', 'curve'] }),
      requirement: '',
    });
    expect((result1.artifact as { degraded: boolean }).degraded).toBe(true);
    expect((result2.artifact as { degraded: boolean }).degraded).toBe(true);
  });

  it('无 query_world_slice builtin（patches 缺）→ DTW 跳过，emotion_verify_result 仍产出（目标弧自洽验证）', async () => {
    // registry 未注册 query_world_slice（fetchWorldPatchesViaTool 返 undefined）→ emotionalPatches undefined
    // → runEmotionVerify 跳过 DTW（chapterDtwDistance undefined）。目标弧 setpoint/topology 验证仍跑。
    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({ emotion_curve: makeEmotionCurve() }),
      requirement: '',
    });
    const art = result.artifact as { chapterDtwDistance?: number; characterArcs: unknown[] };
    expect(art.chapterDtwDistance).toBeUndefined(); // DTW 跳过
    expect(art.characterArcs.length).toBeGreaterThan(0); // 目标弧验证仍跑
  });

  it('promise_registry 缺 → payoffEvents 空，adjustedSetpoints 不调整（netShift=0）', async () => {
    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({ emotion_curve: makeEmotionCurve() }), // 无 promise_registry
      requirement: '',
    });
    const art = result.artifact as { adjustedSetpoints: Array<{ adjusted: boolean }> };
    // 无 payoff + 无 catharsis → adjustSetpoint netShift=0 → adjusted=false。
    expect(art.adjustedSetpoints.length).toBeGreaterThan(0);
    expect(art.adjustedSetpoints.every((s) => s.adjusted === false)).toBe(true);
  });

  it('asset_cards 缺 → characterArcs 仍产（computeSetpoint 用默认 τ）', async () => {
    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({ emotion_curve: makeEmotionCurve() }), // 无 asset_cards
      requirement: '',
    });
    const art = result.artifact as { characterArcs: Array<{ characterId: string; degraded: boolean }> };
    // char-1 VAD present → characterArcs 含 char-1，elasticity 缺 → 默认 τ（degraded=false，VAD 在）。
    expect(art.characterArcs.some((c) => c.characterId === 'char-1')).toBe(true);
  });

  it('有 query_world_slice builtin 返 emotional patches → DTW 跑（chapterDtwDistance 数值）', async () => {
    // 注册 mock query_world_slice 返 emotional patches（含 vad）→ DTW 跑出 chapterDtwDistance。
    registry.register({
      id: 'query_world_slice',
      description: 'mock emotional patches',
      parameters: (await import('zod')).z.object({}),
      async execute() {
        return {
          title: 'mock',
          output: '',
          metadata: {
            slices: [
              {
                storyTime: 5,
                patches: [
                  emotionalPatch('char-1', { v: -0.5, a: 0.7, d: -0.2 }, 5),
                ],
              },
            ],
          },
        };
      },
    });

    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({ emotion_curve: makeEmotionCurve() }),
      requirement: '',
    });
    const art = result.artifact as { chapterDtwDistance?: number };
    // actual（1 patch）vs target（2 points）DTW 跑 → chapterDtwDistance 数值（≥0）。
    expect(art.chapterDtwDistance).toBeDefined();
    expect(typeof art.chapterDtwDistance).toBe('number');
    expect(art.chapterDtwDistance!).toBeGreaterThanOrEqual(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. 🔑 多章 patches filter（design §2.1 章级偏离指纹 + sliceId prefix 约定）
//
// R2 fresh-verify 抓到的 bug：fetchWorldPatchesViaTool 取**跨章**全集（无 subjectIds/type/at 过滤），
// DTW 在本章 emotion_curve（本章目标 per-scene）vs actual patches 比对——actual 必须限本章，否则跨章
// actual vs 本章 target = 多章项目语义错位（DTW 距离无意义）。fix = node 侧 filter sliceId prefix
// `${currentEpisodeId}:`（不改共用 fetchWorldPatchesViaTool / runEmotionVerify 签名）。
// ════════════════════════════════════════════════════════════════════════════

describe('createEmotionVerifyNode — 多章 patches filter（design §2.1 章级偏离指纹）', () => {
  // 合成单点 emotion_curve（char-1 vad = baseline），便于 DTW 精确断言（单点 target vs 单点 actual = 精确距离）。
  function makeSinglePointCurve(char1Vad: { v: number; a: number; d: number }): EmotionCurve {
    return {
      unit: 'scene',
      points: [
        {
          refId: 'scene-1',
          sceneMood: '压抑',
          sceneVad: char1Vad,
          characters: [{ characterId: 'char-1', emotion: '恐惧', vad: char1Vad }],
        },
      ],
      emotional_promises: [],
      catharsis_points: [],
    };
  }

  // 注册 mock query_world_slice 返跨章 patches（slice 集合，patches 跨 episode 不同 sliceId prefix）。
  async function registerCrossChapterMock(patches: WorldPatch[]) {
    const z = (await import('zod')).z;
    registry.register({
      id: 'query_world_slice',
      description: 'mock cross-chapter emotional patches',
      parameters: z.object({}),
      async execute() {
        return {
          title: 'mock',
          output: '',
          metadata: {
            // 按 sliceId 分组slice（fetchWorldPatchesViaTool 展平时忽略 slice 维度，只取 patches）；
            // 这里每 patch 一 slice 简化（sliceId 不同 → 模拟跨章）。
            slices: patches.map((p) => ({ storyTime: p.storyTime, patches: [p] })),
          },
        };
      },
    });
  }

  it('currentEpisodeId present → DTW 只用本章 patches（历史章 sliceId 不同 prefix 被滤掉）', async () => {
    // 目标 char-1 vad = baseline；本章 ep2 patch vad = baseline（精确匹配 → DTW=0）。
    const baseline = { v: -0.7, a: 0.8, d: -0.3 };
    const currentPatch = emotionalPatch('char-1', baseline, 5, 'ep2:5');
    // 历史章 ep1 patch vad 狂偏（若混入 DTW，距离激增）。
    const historyPatch = emotionalPatch('char-1', { v: 0.9, a: -0.9, d: 0.9 }, 5, 'ep1:5');
    await registerCrossChapterMock([currentPatch, historyPatch]);

    const node = createEmotionVerifyNode();
    const result = await node.run({
      // chapter_brief_input.episodeId = 'ep2' → node filter sliceId.startsWith('ep2:')
      run: makeRun({
        emotion_curve: makeSinglePointCurve(baseline),
        chapter_brief_input: { episodeId: 'ep2' },
      }),
      requirement: '',
    });
    const art = result.artifact as { chapterDtwDistance?: number };
    // 只用本章 ep2 patch（vad 精确匹配目标）→ DTW=0。历史 ep1 被滤掉（若混入距离 >0）。
    expect(art.chapterDtwDistance).toBe(0);
  });

  it('currentEpisodeId 缺（chapter_brief_input 无 episodeId）→ 不 filter（全集，graceful）', async () => {
    // 同上数据集，但不传 chapter_brief_input → currentEpisodeId undefined → 不 filter → 全集 patches 进 DTW。
    const baseline = { v: -0.7, a: 0.8, d: -0.3 };
    const currentPatch = emotionalPatch('char-1', baseline, 5, 'ep2:5');
    const historyPatch = emotionalPatch('char-1', { v: 0.9, a: -0.9, d: 0.9 }, 5, 'ep1:5');
    await registerCrossChapterMock([currentPatch, historyPatch]);

    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({ emotion_curve: makeSinglePointCurve(baseline) }), // 无 chapter_brief_input
      requirement: '',
    });
    const art = result.artifact as { chapterDtwDistance?: number };
    // 不 filter → ep1 + ep2 都进 DTW（char-1 actual = 2 点，含狂偏 ep1）→ 距离 >0（历史章混入致偏离）。
    expect(art.chapterDtwDistance).toBeDefined();
    expect(art.chapterDtwDistance!).toBeGreaterThan(0);
  });

  it('currentEpisodeId present + 本章无 patches（全在历史章）→ filter 后空，DTW 跳过（graceful）', async () => {
    // 目标 char-1 vad，但 mock 返的 patches 全是历史章 ep1（本章 ep2 无 patches）→ filter 后空 → DTW 跳过。
    const baseline = { v: -0.7, a: 0.8, d: -0.3 };
    const historyPatch1 = emotionalPatch('char-1', { v: 0.9, a: -0.9, d: 0.9 }, 5, 'ep1:5');
    const historyPatch2 = emotionalPatch('char-1', { v: 0.8, a: -0.8, d: 0.8 }, 6, 'ep1:6');
    await registerCrossChapterMock([historyPatch1, historyPatch2]);

    const node = createEmotionVerifyNode();
    const result = await node.run({
      run: makeRun({
        emotion_curve: makeSinglePointCurve(baseline),
        chapter_brief_input: { episodeId: 'ep2' },
      }),
      requirement: '',
    });
    const art = result.artifact as { chapterDtwDistance?: number };
    // 本章 ep2 filter 后无 patches → DTW 跳过（chapterDtwDistance undefined），不崩。
    expect(art.chapterDtwDistance).toBeUndefined();
  });
});
