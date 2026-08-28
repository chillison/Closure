import { describe, expect, it } from 'vitest';
import {
  COMPLETENESS_VERIFY_CONTRACT,
  COMPLETENESS_VERIFY_RESULT_KEY,
  collectArcCandidates,
  collectEmotionArcCandidates,
  collectLineCandidates,
  collectPromiseCandidates,
  collectThemeCandidates,
  completenessCandidateReportSchema,
  completenessVerifyResultSchema,
  computeCompletenessCandidates,
} from '../src/contracts/completeness-candidates';
import { growthCurveSchema, promiseRegistrySchema, sceneGraphSchema } from '../src/contracts/creative-fields';
import type { EmotionCurve, PromiseRegistry, SceneGraph } from '../src/contracts/creative-fields';
import type { EmotionVerifyResult } from '../src/contracts/emotion-verify';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.4 L1 候选汇编单测（design §4 / §10 graceful / ADR-3 范式判据）。
//
// 测四块（implement.md Step 1.4）：
// 1. 5 类候选汇编（arc/line/emotion-arc/promise/theme）—— 正常 + 缺源降级 + 边界。
// 2. computeCompletenessCandidates 聚合 + degraded 标注。
// 3. completenessVerifyResultSchema（L2 产出 shape）—— accept valid / reject invalid grounding。
// 4. contract shape（COMPLETENESS_VERIFY_CONTRACT / COMPLETENESS_VERIFY_RESULT_KEY）。
//
// 范式（creative-vs-mechanical）：L1 = 纯代码机械（查询/汇编/计数/派生），不做语义裁判。
// ─────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// 1. arc 候选汇编（collectArcCandidates）
// ════════════════════════════════════════════════════════════════════════════

describe('collectArcCandidates', () => {
  it('空 growth_curve → 空候选', () => {
    expect(collectArcCandidates(undefined, ['ep1', 'ep2'])).toEqual([]);
    expect(collectArcCandidates([], ['ep1'])).toEqual([]);
  });

  it('单 growth_curve → 候选含设计意图 + turning_point 进度', () => {
    const curves = [
      {
        character_id: 'char-1',
        start_state: '自卑',
        wound_or_lack: '被遗弃',
        desire: '被认可',
        need: '自我接纳',
        turning_points: [
          { turning_point: '觉醒', linked_episode_ids: ['ep1'] },
          { turning_point: '决裂', linked_episode_ids: ['ep3'] },
        ],
        regressions: ['ep2 倒退'],
        end_state: '成长',
        linked_episode_ids: ['ep1', 'ep2', 'ep3'],
      },
    ];
    const candidates = collectArcCandidates(curves, ['ep1', 'ep2']);
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.character_id).toBe('char-1');
    expect(c.wound_or_lack).toBe('被遗弃');
    expect(c.desire).toBe('被认可');
    expect(c.need).toBe('自我接纳');
    expect(c.turningPointCount).toBe(2);
    // ep1 在 writtenEpisodeIds，ep3 不在 → turningPointsTouchedWritten = 1
    expect(c.turningPointsTouchedWritten).toBe(1);
    expect(c.turningPointEpisodeIds).toEqual(['ep1', 'ep3']);
    expect(c.regressionCount).toBe(1);
    expect(c.end_state).toBe('成长');
    // linked_episode_ids ∩ written = ['ep1', 'ep2']
    expect(c.linkedEpisodeIds).toEqual(['ep1', 'ep2']);
  });

  it('设计节奏判据：转折点设计在未写章节 → turningPointsTouchedWritten=0（L2 该角色不报 under-developed）', () => {
    const curves = [
      growthCurveSchema.parse({
        character_id: 'char-late',
        start_state: '起点',
        turning_points: [{ turning_point: '后期转折', linked_episode_ids: ['ep10'] }],
        linked_episode_ids: [],
      }),
    ];
    const candidates = collectArcCandidates(curves, ['ep1', 'ep2']);
    expect(candidates[0].turningPointsTouchedWritten).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. line 候选汇编（collectLineCandidates）
// ════════════════════════════════════════════════════════════════════════════

describe('collectLineCandidates', () => {
  it('空 scene_graph → 空候选', () => {
    expect(collectLineCandidates(undefined, ['ep1'])).toEqual([]);
    expect(collectLineCandidates(sceneGraphSchema.parse({ nodes: [], edges: [], lines: [] }), ['ep1'])).toEqual([]);
  });

  it('多 line + lineTags 场分布 + themeRef 锚定 → 候选含机械事实', () => {
    const sg = sceneGraphSchema.parse({
      nodes: [
        { id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal', lineTags: ['main'] },
        { id: 's2', episodeId: 'ep1', storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', lineTags: ['main'] },
        { id: 's3', episodeId: 'ep2', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal', lineTags: ['dark'] },
        // 未写章节场（ep3 不在 written）
        { id: 's4', episodeId: 'ep3', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal', lineTags: ['main'] },
      ],
      edges: [],
      lines: [
        { id: 'main', name: '主线', topology_role: 'converging', themeRef: '救赎' },
        { id: 'dark', name: '暗线', topology_role: 'converging', visibility: { status: 'hidden-until', target: 'ep5' } },
      ],
    }) as SceneGraph;
    const candidates = collectLineCandidates(sg, ['ep1', 'ep2']);
    expect(candidates).toHaveLength(2);
    const main = candidates.find((c) => c.id === 'main')!;
    expect(main.name).toBe('主线');
    expect(main.topology_role).toBe('converging');
    expect(main.hasThemeRef).toBe(true);
    // main 线场：s1 (ep1), s2 (ep1), s4 (ep3 不在 written) → 2 场
    expect(main.sceneCountInWrittenEpisodes).toBe(2);
    // CR-003：visibility 默认 'open'（lineVisibilitySchema default）
    expect(main.visibilityStatus).toBe('open');
    expect(main.visibilityTarget).toBeUndefined();
    const dark = candidates.find((c) => c.id === 'dark')!;
    expect(dark.hasThemeRef).toBe(false);
    expect(dark.sceneCountInWrittenEpisodes).toBe(1); // s3 (ep2)
    // CR-003：暗线 visibility=hidden-until，L2 据「该浮出未浮出」判线推进 missing
    expect(dark.visibilityStatus).toBe('hidden-until');
    expect(dark.visibilityTarget).toBe('ep5');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. emotion-arc 候选汇编（collectEmotionArcCandidates）
// ════════════════════════════════════════════════════════════════════════════

describe('collectEmotionArcCandidates', () => {
  it('两源都缺 → null（L2 跳过情绪弧维）', () => {
    expect(collectEmotionArcCandidates(undefined, undefined)).toBeNull();
  });

  it('5.3 flag 透传 + 目标 payoff 点机械计数', () => {
    const curve = {
      unit: 'scene',
      points: [
        { refId: 's1', sceneMood: '压抑' },
        { refId: 's2', sceneMood: '爆发' },
        { refId: 's3', sceneMood: '高潮释放' },
        { refId: 's4', sceneMood: '平静' },
      ],
      emotional_promises: [],
      catharsis_points: [],
    } as unknown as EmotionCurve;
    const verifyResult = {
      flags: ['character_setpoint_violation', 'dtw_distance_high'],
      characterArcs: [],
      readerTopology: { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: false },
      adjustedSetpoints: [],
      degraded: false,
    } as EmotionVerifyResult;

    const candidate = collectEmotionArcCandidates(curve, verifyResult)!;
    expect(candidate.emotionVerifyFlags).toEqual(['character_setpoint_violation', 'dtw_distance_high']);
    expect(candidate.targetPointCount).toBe(4);
    // '爆发' 命中 + '高潮释放' 命中 '高潮' + '释放' → 2 payoff 点
    expect(candidate.targetPayoffPointCount).toBe(2);
    expect(candidate.emotionVerifyDegraded).toBe(false);
  });

  it('5.3 verify degraded → degraded 标记透传（L2 知道数学指纹不可信）', () => {
    const verifyResult = {
      flags: [],
      characterArcs: [],
      readerTopology: { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: true },
      adjustedSetpoints: [],
      degraded: true,
      degradationNote: 'emotion_curve 缺失',
    } as EmotionVerifyResult;
    const candidate = collectEmotionArcCandidates(undefined, verifyResult)!;
    expect(candidate.emotionVerifyDegraded).toBe(true);
    expect(candidate.targetPointCount).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. promise 候选汇编（collectPromiseCandidates）
// ════════════════════════════════════════════════════════════════════════════

describe('collectPromiseCandidates', () => {
  it('空 registry → 空候选', () => {
    expect(collectPromiseCandidates(undefined, 'ep2', new Map([['ep1', 0], ['ep2', 1]]))).toEqual([]);
    const empty: PromiseRegistry = { promises: [], beats: [], version: 0, updatedBy: 'agent' };
    expect(collectPromiseCandidates(empty, 'ep2', new Map([['ep1', 0]]))).toEqual([]);
  });

  it('resolvePromiseFulfillment 派生 + deadlinePassed 判定（纯代码机械，非语义）', () => {
    const registry = promiseRegistrySchema.parse({
      promises: [
        {
          id: 'p1',
          title: '密信',
          summary: '主角密信的归宿',
          status: 'open',
          importance: 0.7,
          autoFulfill: true,
          deadlineEpisodeId: 'ep1', // deadline 已过（ep1 idx=0 < current ep2 idx=2）
        },
        {
          id: 'p2',
          title: '已兑现',
          summary: '已兑现的 Promise',
          status: 'fulfilled',
          importance: 0.5,
          autoFulfill: true,
        },
        {
          id: 'p3',
          title: 'abandoned',
          summary: '放弃的 Promise',
          status: 'abandoned',
          importance: 0.5,
          autoFulfill: true,
        },
      ],
      beats: [
        { id: 'b1', promiseId: 'p1', sceneRef: 's1', episodeId: 'ep0', kind: 'plant' },
        { id: 'b2', promiseId: 'p2', sceneRef: 's2', episodeId: 'ep1', kind: 'payoff' },
      ],
      version: 1,
    });
    // CR-002：index map 替代 writtenEpisodeIds，纯 index 严格比较 mirror 5.3 isDeadlinePassed。
    const indexByEpisodeId = new Map([
      ['ep0', 0],
      ['ep1', 1],
      ['ep2', 2],
    ]);
    const candidates = collectPromiseCandidates(registry, 'ep2', indexByEpisodeId);
    expect(candidates).toHaveLength(3);

    const p1 = candidates.find((c) => c.id === 'p1')!;
    expect(p1.derivedStatus).toBe('open');
    expect(p1.deadlinePassed).toBe(true); // open + deadline ep1 idx=1 < current ep2 idx=2
    expect(p1.plantEpisodeIds).toEqual(['ep0']);
    expect(p1.payoffBeatCount).toBe(0);

    const p2 = candidates.find((c) => c.id === 'p2')!;
    expect(p2.derivedStatus).toBe('fulfilled');
    expect(p2.deadlinePassed).toBe(false); // fulfilled 不判过期
    expect(p2.payoffBeatCount).toBe(1);

    const p3 = candidates.find((c) => c.id === 'p3')!;
    expect(p3.derivedStatus).toBe('abandoned');
    expect(p3.deadlinePassed).toBe(false); // abandoned 不判过期
  });

  it('deadlineEpisodeId === currentEpisodeId（同 index）→ deadlinePassed=false（本章尚在写，payoff 仍可能现）', () => {
    const registry = promiseRegistrySchema.parse({
      promises: [
        {
          id: 'p1',
          title: '本章 deadline',
          summary: '本章 deadline 的 Promise',
          status: 'open',
          importance: 0.5,
          autoFulfill: true,
          deadlineEpisodeId: 'ep_now',
        },
      ],
      beats: [],
    });
    const candidates = collectPromiseCandidates(registry, 'ep_now', new Map([['ep_now', 0]]));
    expect(candidates[0].deadlinePassed).toBe(false); // deadlineIdx 0 === currentIdx 0 → 不严格小于 → false
  });

  it('CR-002 重复 episode index（平行线 / IF 分支）→ 不造假 deadlinePassed（mirror 5.3 严格 `<`）', () => {
    // 场景：deadline ep_a 与 current ep_b 共享 index=2（IF 分支平行章）。旧集合法判 passed（id 不同 + 在 written 集），
    // 新 index 法判 not passed（idx 相等不严格小于），mirror 5.3 isDeadlinePassed 严格 `<`。
    const registry = promiseRegistrySchema.parse({
      promises: [
        {
          id: 'p1',
          title: '平行章 deadline',
          summary: '平行章 deadline 的 Promise',
          status: 'open',
          importance: 0.5,
          autoFulfill: true,
          deadlineEpisodeId: 'ep_a',
        },
      ],
      beats: [],
    });
    const indexByEpisodeId = new Map([
      ['ep_a', 2],
      ['ep_b', 2],
    ]);
    const candidates = collectPromiseCandidates(registry, 'ep_b', indexByEpisodeId);
    expect(candidates[0].deadlinePassed).toBe(false); // deadlineIdx 2 === currentIdx 2 → 不严格小于 → false
  });

  it('CR-002 indexByEpisodeId 缺 → graceful false（无 index 排序不造假「已过」）', () => {
    const registry = promiseRegistrySchema.parse({
      promises: [
        {
          id: 'p1',
          title: '无 index map',
          summary: '无 index map 的 Promise',
          status: 'open',
          importance: 0.5,
          autoFulfill: true,
          deadlineEpisodeId: 'ep1',
        },
      ],
      beats: [],
    });
    // 无 indexByEpisodeId 参数 → graceful false
    const candidates = collectPromiseCandidates(registry, 'ep2');
    expect(candidates[0].deadlinePassed).toBe(false);
  });

  it('Story 8.3 S5 预索引（groupBy）行为等价：大 P×B 交错 fixture 计数/派生态/去重序不漂移', () => {
    // 60 promises × 每 promise 3-4 条交错 beats（promiseId 非连续——预索引分组必须正确归位）。
    // 手算锚定：plant 同章重复 → 去重保首现序 / payoff+echo 计数 / derivedStatus 混合
    // （fulfilled 回退 open / abandoned 直通 / autoFulfill=false 手管）/ 孤儿 beat 不产候选。
    const promises = Array.from({ length: 60 }, (_, i) => ({
      id: `p-${String(i).padStart(2, '0')}`,
      title: `线 ${i}`,
      summary: `线 ${i} 的承诺`,
      status: i % 7 === 0 ? 'fulfilled' : 'open',
      importance: 0.5,
      autoFulfill: i % 5 !== 0,
      ...(i === 3 ? { deadlineEpisodeId: 'ep-01' } : {}),
    }));
    type Beat = { id: string; promiseId: string; sceneRef: string; episodeId: string; kind: string };
    const perPromise: Beat[][] = promises.map((p, i) => {
      const epA = `ep-${String(i % 10).padStart(2, '0')}`;
      const epB = `ep-${String((i + 3) % 10).padStart(2, '0')}`;
      const beats: Beat[] = [
        { id: `${p.id}-plant1`, promiseId: p.id, sceneRef: `${p.id}-s1`, episodeId: epA, kind: 'plant' },
        // 同章重复 plant（去重保首现）：
        { id: `${p.id}-plant2`, promiseId: p.id, sceneRef: `${p.id}-s2`, episodeId: epA, kind: 'plant' },
        { id: `${p.id}-adv`, promiseId: p.id, sceneRef: `${p.id}-s3`, episodeId: epB, kind: 'advance' },
      ];
      if (i % 2 === 0) {
        beats.push({
          id: `${p.id}-payoff`,
          promiseId: p.id,
          sceneRef: `${p.id}-s4`,
          episodeId: 'ep-09',
          kind: 'payoff',
        });
      }
      return beats;
    });
    // 轮转交错（round-robin 取各 promise 首条再取次条——同 promise 的 beats 在数组中不相邻）。
    const beats: Beat[] = [];
    for (let round = 0; round < 4; round++) {
      for (const list of perPromise) {
        if (round < list.length) beats.push(list[round]);
      }
    }
    // 孤儿 beat（promiseId 不在 promises——不产候选，也不崩）。
    beats.push({ id: 'orphan-1', promiseId: 'p-orphan', sceneRef: 's', episodeId: 'ep-00', kind: 'payoff' });

    const registry = promiseRegistrySchema.parse({ promises, beats, version: 1 });
    const indexByEpisodeId = new Map(
      Array.from({ length: 10 }, (_, i) => [`ep-${String(i).padStart(2, '0')}`, i] as const),
    );
    const candidates = collectPromiseCandidates(registry, 'ep-05', indexByEpisodeId);
    expect(candidates).toHaveLength(60); // 孤儿不产候选

    for (let i = 0; i < 60; i++) {
      const c = candidates.find((x) => x.id === `p-${String(i).padStart(2, '0')}`)!;
      const autoFulfill = i % 5 !== 0;
      const hasPayoff = i % 2 === 0;
      expect(c.payoffBeatCount).toBe(hasPayoff ? 1 : 0);
      expect(c.echoedBeatCount).toBe(1); // advance
      expect(c.plantEpisodeIds).toEqual([`ep-${String(i % 10).padStart(2, '0')}`]); // 去重保首现
      // derivedStatus：手管（autoFulfill=false）直通存储态；否则有 payoff → fulfilled；
      // 无 payoff 且存 fulfilled → 回退 open（payoff 被删语义）；无 payoff 存 open → open。
      if (!autoFulfill) expect(c.derivedStatus).toBe(i % 7 === 0 ? 'fulfilled' : 'open');
      else if (hasPayoff) expect(c.derivedStatus).toBe('fulfilled');
      else expect(c.derivedStatus).toBe('open');
      if (i !== 3) expect(c.deadlinePassed).toBe(false); // 除 p-03 外无 deadline
    }
    // p-03：open + autoFulfill + 无 payoff（奇数）+ deadline ep-01 idx=1 < current ep-05 idx=5 → passed。
    const p03 = candidates.find((x) => x.id === 'p-03')!;
    expect(p03.deadlinePassed).toBe(true);
    expect(p03.deadlineEpisodeId).toBe('ep-01');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. theme 候选汇编（collectThemeCandidates）
// ════════════════════════════════════════════════════════════════════════════

describe('collectThemeCandidates', () => {
  it('两源都缺 → null', () => {
    expect(collectThemeCandidates(undefined, undefined)).toBeNull();
    expect(
      collectThemeCandidates(undefined, sceneGraphSchema.parse({ nodes: [], edges: [], lines: [] }) as SceneGraph),
    ).toBeNull();
  });

  it('declaredThemes + themeMappings + linesAnchoringTheme 合并', () => {
    const projectTheme = {
      declaredThemes: ['救赎', '成长'],
      themeMappings: [
        { cardId: 'vm1', cardName: '雨夜', surface: '雨', middle: '洗涤', deep: '重生' },
      ],
    };
    const sg = sceneGraphSchema.parse({
      nodes: [],
      edges: [],
      lines: [
        { id: 'main', name: '主线', topology_role: 'converging', themeRef: '救赎' },
      ],
    }) as SceneGraph;
    const candidate = collectThemeCandidates(projectTheme, sg)!;
    expect(candidate.declaredThemes).toEqual(['救赎', '成长']);
    expect(candidate.themeMappings).toHaveLength(1);
    expect(candidate.themeMappings[0].deep).toBe('重生');
    expect(candidate.linesAnchoringTheme).toEqual([{ lineId: 'main', lineName: '主线', themeRef: '救赎' }]);
  });

  it('仅 scene_graph 含 themeRef 线 → 候选仍产出（declaredThemes 空但 linesAnchoringTheme 非空）', () => {
    const sg = sceneGraphSchema.parse({
      nodes: [],
      edges: [],
      lines: [
        { id: 'l1', name: '主题线', topology_role: 'parallel-worldview', themeRef: '孤独' },
      ],
    }) as SceneGraph;
    const candidate = collectThemeCandidates(undefined, sg)!;
    expect(candidate.declaredThemes).toEqual([]);
    expect(candidate.linesAnchoringTheme).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. computeCompletenessCandidates 聚合 + degraded 标注
// ════════════════════════════════════════════════════════════════════════════

describe('computeCompletenessCandidates', () => {
  it('全源缺 → degraded=true + degradationNote 列所有类 + 各类空候选', () => {
    const report = computeCompletenessCandidates({
      growthCurveRaw: undefined,
      sceneGraph: undefined,
      emotionCurve: undefined,
      emotionVerifyResult: undefined,
      promiseRegistry: undefined,
      projectTheme: undefined,
      currentEpisodeId: 'ep1',
      writtenEpisodeIds: ['ep1'],
    });
    expect(report.arc).toEqual([]);
    expect(report.line).toEqual([]);
    expect(report.emotionArc).toBeNull();
    expect(report.promise).toEqual([]);
    expect(report.theme).toBeNull();
    expect(report.degraded).toBe(true);
    expect(report.degradationNote).toContain('arc');
    expect(report.degradationNote).toContain('line');
    expect(report.degradationNote).toContain('emotion-arc');
    expect(report.degradationNote).toContain('promise');
    expect(report.degradationNote).toContain('theme');
  });

  it('全源就绪 → degraded=false + 各类候选产出', () => {
    const report = computeCompletenessCandidates({
      growthCurveRaw: [
        growthCurveSchema.parse({
          character_id: 'char-1',
          start_state: '起点',
          turning_points: [{ turning_point: 'tp1', linked_episode_ids: ['ep1'] }],
          linked_episode_ids: ['ep1'],
        }),
      ],
      sceneGraph: sceneGraphSchema.parse({
        nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal', lineTags: ['l1'] }],
        edges: [],
        lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }],
      }) as SceneGraph,
      emotionCurve: { unit: 'scene', points: [], emotional_promises: [], catharsis_points: [] } as unknown as EmotionCurve,
      emotionVerifyResult: {
        flags: [],
        characterArcs: [],
        readerTopology: { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: false },
        adjustedSetpoints: [],
        degraded: false,
      } as EmotionVerifyResult,
      promiseRegistry: promiseRegistrySchema.parse({
        promises: [
          {
            id: 'p1',
            title: 'Promise1',
            summary: '测试 Promise',
            status: 'open',
            importance: 0.5,
            autoFulfill: true,
          },
        ],
        beats: [],
      }),
      projectTheme: { declaredThemes: ['救赎'], themeMappings: [] },
      currentEpisodeId: 'ep1',
      writtenEpisodeIds: ['ep1'],
    });
    expect(report.arc).toHaveLength(1);
    expect(report.line).toHaveLength(1);
    expect(report.emotionArc).not.toBeNull();
    expect(report.promise).toHaveLength(1);
    expect(report.theme).not.toBeNull();
    expect(report.degraded).toBe(false);
    expect(report.degradationNote).toBe('');
  });

  it('CR-008 legitimate-empty：promise_registry 在但 0 Promise → 不 degraded（masking 真损坏反例）', () => {
    // 用户尚未登记任何 Promise（首章常见）= legitimate-empty，非 source-missing。
    // degraded=false 让 L2 知道「数据源没坏，该类就是空」，区分真损坏（artifact 缺）。
    const emptyRegistry = promiseRegistrySchema.parse({ promises: [], beats: [] });
    const report = computeCompletenessCandidates({
      growthCurveRaw: [
        growthCurveSchema.parse({
          character_id: 'char-1',
          start_state: '起点',
          turning_points: [],
          linked_episode_ids: [],
        }),
      ],
      sceneGraph: undefined, // 故意缺：source-missing → degraded line 类
      emotionCurve: undefined,
      emotionVerifyResult: undefined,
      promiseRegistry: emptyRegistry, // 在但空：legitimate-empty
      projectTheme: undefined,
    });
    expect(report.promise).toEqual([]);
    // degradationNote 只记 source-missing 类（line/emotion-arc/theme），**不**含 promise legitimate-empty。
    // 用前缀断言（'arc: '）避免子串匹配到 'emotion-arc:'
    expect(report.degradationNote).not.toContain('promise');
    expect(report.degradationNote).toContain('line:');
    expect(report.degradationNote).toContain('emotion-arc:');
    expect(report.degradationNote).toContain('theme:');
    // arc 类有候选（growthCurveRaw present + 非空）→ 不记 arc source-missing（前缀断言避开 emotion-arc 子串）
    expect(report.degradationNote).not.toContain('arc: growth_curve');
  });

  it('CR-001 blast radius：growth_curve 坏数据（turning_points 非数组）不核爆五类（Array.isArray 守卫降级）', () => {
    // 坏数据：turning_points 是字符串非数组。旧代码 flatMap 抛 → 全局 try/catch 核爆五类全降级。
    // CR-001 修复后：Array.isArray 守卫降级 turning_points=[]，单类自身兜住，不抛、不核爆其他类。
    const report = computeCompletenessCandidates({
      growthCurveRaw: [
        {
          character_id: 'char-bad',
          start_state: '起点',
          turning_points: 'not-an-array', // 坏数据
          regressions: null, // 坏数据
          linked_episode_ids: 42, // 坏数据
        },
      ],
      sceneGraph: sceneGraphSchema.parse({
        nodes: [],
        edges: [],
        lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }],
      }) as SceneGraph,
      emotionCurve: undefined,
      emotionVerifyResult: undefined,
      promiseRegistry: undefined,
      projectTheme: undefined,
    });
    // arc 类自身兜住坏数据：候选仍产出（turningPointsTouchedWritten=0 等），不抛
    expect(report.arc).toHaveLength(1);
    expect(report.arc[0].character_id).toBe('char-bad');
    expect(report.arc[0].turningPointCount).toBe(0); // Array.isArray 降级 [] → length 0
    expect(report.arc[0].regressionCount).toBe(0);
    expect(report.arc[0].linkedEpisodeIds).toEqual([]);
    // line 类不受 arc 坏数据影响（按类隔离）
    expect(report.line).toHaveLength(1);
    expect(report.line[0].id).toBe('l1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. completenessVerifyResultSchema（L2 产出 shape）
// ════════════════════════════════════════════════════════════════════════════

describe('completenessVerifyResultSchema', () => {
  it('5 类各一 finding（schema-acceptance fixture）', () => {
    const valid = {
      findings: [
        {
          category: 'arc',
          verdict: 'under-developed',
          entityId: 'char-1',
          entityLabel: '主角成长弧',
          quote: '主角面对危机时仍未展现觉醒迹象',
          location: '第1章段3',
          explanation: 'wound_or_lack=被遗弃未在正文体现',
          suggestedFix: '下章安排主角觉察被遗弃创伤的内心独白',
        },
        {
          category: 'line',
          verdict: 'missing',
          entityId: 'dark-1',
          entityLabel: '暗线：密信',
          quote: '密信自第二场后未再提及',
          location: '第2章段1',
          explanation: '暗藏线设计但场分布稀，该浮出未浮出',
          suggestedFix: '下章安排密信浮现的暗示场',
        },
        {
          category: 'emotion-arc',
          verdict: 'missing',
          entityId: 'emotion-arc',
          entityLabel: '跨弧情绪弧',
          quote: '目标爆发情绪未真释放',
          location: '第3章高潮场',
          explanation: 'payoff 点铺垫不足',
          suggestedFix: '下章加强情绪积累的细节描写',
        },
        {
          category: 'promise',
          verdict: 'missing',
          entityId: 'p1',
          entityLabel: 'Promise：密信归宿',
          quote: '密信的归宿问题尚未兑现',
          location: '第1章',
          explanation: 'deadline 已过仍 open',
          suggestedFix: '下章安排密信归宿的 payoff beat',
        },
        {
          category: 'theme',
          verdict: 'missing',
          entityId: '救赎',
          entityLabel: '主题：救赎',
          quote: '救赎仅作为叙述者口号',
          location: '第1章段1',
          explanation: '主题未通过事件/角色弧挣得',
          suggestedFix: '下章安排角色通过行动体现救赎',
        },
      ],
      summary: '5 类缺漏检测汇总',
    };
    const parsed = completenessVerifyResultSchema.parse(valid);
    expect(parsed.findings).toHaveLength(5);
    expect(parsed.findings[0].category).toBe('arc');
    expect(parsed.findings[3].category).toBe('promise');
    expect(parsed.degraded).toBe(false); // default
  });

  it('grounding 硬要求：quote 空串 → schema 拒收', () => {
    const invalid = {
      findings: [
        {
          category: 'arc',
          verdict: 'missing',
          entityId: 'c1',
          entityLabel: '弧',
          quote: '', // 空 → 拒
          location: '段1',
          explanation: 'e',
          suggestedFix: 'f',
        },
      ],
      summary: 's',
    };
    expect(() => completenessVerifyResultSchema.parse(invalid)).toThrow();
  });

  it('grounding 硬要求：location 空串 → schema 拒收', () => {
    const invalid = {
      findings: [
        {
          category: 'theme',
          verdict: 'missing',
          entityId: 't1',
          entityLabel: '主题',
          quote: '正文原句',
          location: '', // 空 → 拒
          explanation: 'e',
          suggestedFix: 'f',
        },
      ],
      summary: 's',
    };
    expect(() => completenessVerifyResultSchema.parse(invalid)).toThrow();
  });

  it('CR-004：entityLabel / explanation / suggestedFix 空串 → schema 拒收（AC4 落地公理 schema 层硬保证）', () => {
    const base = {
      category: 'arc',
      verdict: 'missing',
      entityId: 'c1',
      quote: '正文原句',
      location: '段1',
      summary: 's',
    } as const;
    // entityLabel 空 → 拒
    expect(() =>
      completenessVerifyResultSchema.parse({
        findings: [{ ...base, entityLabel: '', explanation: 'e', suggestedFix: 'f' }],
        summary: 's',
      }),
    ).toThrow();
    // explanation 空 → 拒（AC4：每个缺漏 verdict 必须答「怎么影响后章正文」，空串过关破坏此保证）
    expect(() =>
      completenessVerifyResultSchema.parse({
        findings: [{ ...base, entityLabel: '弧', explanation: '', suggestedFix: 'f' }],
        summary: 's',
      }),
    ).toThrow();
    // suggestedFix 空 → 拒
    expect(() =>
      completenessVerifyResultSchema.parse({
        findings: [{ ...base, entityLabel: '弧', explanation: 'e', suggestedFix: '' }],
        summary: 's',
      }),
    ).toThrow();
  });

  it('非法 category / verdict → schema 拒收（封闭 enum 机械控制信号）', () => {
    const invalid = {
      findings: [
        {
          category: 'custom', // 非封闭 enum
          verdict: 'missing',
          entityId: 'x',
          entityLabel: 'x',
          quote: 'q',
          location: 'loc',
          explanation: 'e',
          suggestedFix: 'f',
        },
      ],
      summary: 's',
    };
    expect(() => completenessVerifyResultSchema.parse(invalid)).toThrow();
  });

  it('缺 findings/summary → default 兜底（findings=[]）或 required 拒（summary 必填）', () => {
    const noFindings = completenessVerifyResultSchema.parse({ summary: '无缺漏' });
    expect(noFindings.findings).toEqual([]);
    expect(noFindings.degraded).toBe(false);
    // summary 必填（无 default）
    expect(() => completenessVerifyResultSchema.parse({})).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. contract shape
// ════════════════════════════════════════════════════════════════════════════

describe('contract shape', () => {
  it('COMPLETENESS_VERIFY_CONTRACT: nodeId / requiredArtifactKeys=[] / producedArtifactKeys', () => {
    expect(COMPLETENESS_VERIFY_CONTRACT.nodeId).toBe('completeness-verify-node');
    expect(COMPLETENESS_VERIFY_CONTRACT.requiredArtifactKeys).toEqual([]);
    expect(COMPLETENESS_VERIFY_CONTRACT.producedArtifactKeys).toEqual(['completeness_verify_result']);
    expect(COMPLETENESS_VERIFY_CONTRACT.sideEffects).toContain('call_model');
  });

  it('COMPLETENESS_VERIFY_RESULT_KEY = "completeness_verify_result"', () => {
    expect(COMPLETENESS_VERIFY_RESULT_KEY).toBe('completeness_verify_result');
  });

  it('completenessCandidateReportSchema 守卫报告形态（L1 产出可被 schema parse）', () => {
    const report = computeCompletenessCandidates({ writtenEpisodeIds: [] });
    expect(() => completenessCandidateReportSchema.parse(report)).not.toThrow();
  });
});
