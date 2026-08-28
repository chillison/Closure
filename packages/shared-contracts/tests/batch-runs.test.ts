import { describe, expect, it } from 'vitest';
import {
  BALANCED_ASK_CATEGORIES_DEFAULT,
  PARTICIPATION_GEAR_DEFAULT,
  TRUST_ADJUDICATION_DEFAULT,
  balancedAskCategorySchema,
  batchKindSchema,
  batchRunStateSchema,
  batchStatusSchema,
  participationGearSchema,
  sceneWeightSignalSchema,
} from '../src/contracts/batch-runs';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 1：participationGear / balancedAskCategories / trustAdjudication /
// BatchRunState / SceneWeightSignal 契约（design §2.1 / §3.1 / §6）。全 additive——
// 旧数据不受影响（schema 只校验新字段的形态）。
// ─────────────────────────────────────────────────────────────────────────────

describe('participationGear schema', () => {
  it('接受四档枚举值', () => {
    for (const gear of ['smart', 'steer', 'balanced', 'hands_off']) {
      expect(participationGearSchema.safeParse(gear).success).toBe(true);
    }
  });

  it('拒绝垃圾值（IPC 边界/runtime 双防线共用此 schema）', () => {
    for (const junk of ['turbo', '', 'SMART', null, undefined, 1]) {
      expect(participationGearSchema.safeParse(junk).success).toBe(false);
    }
  });

  it('默认档位 = smart', () => {
    expect(PARTICIPATION_GEAR_DEFAULT).toBe('smart');
  });
});

describe('balancedAskCategories schema + defaults', () => {
  it('默认三项全（protagonist_safety / information_gap / direction_turn）', () => {
    expect(BALANCED_ASK_CATEGORIES_DEFAULT).toEqual([
      'protagonist_safety',
      'information_gap',
      'direction_turn',
    ]);
  });

  it('拒绝词表外类别（封闭枚举——类别是机械匹配标签非语义自由值）', () => {
    expect(balancedAskCategorySchema.safeParse('protagonist_safety').success).toBe(true);
    expect(balancedAskCategorySchema.safeParse('pacing').success).toBe(false);
  });

  it('trustAdjudication 默认 false（仍停下问，安全默认）', () => {
    expect(TRUST_ADJUDICATION_DEFAULT).toBe(false);
  });
});

describe('batchKind / batchStatus schema', () => {
  it('batchKind：progress / report', () => {
    expect(batchKindSchema.safeParse('progress').success).toBe(true);
    expect(batchKindSchema.safeParse('report').success).toBe(true);
    expect(batchKindSchema.safeParse('other').success).toBe(false);
  });

  it('batchStatus：running / paused / done / aborted', () => {
    expect(batchStatusSchema.safeParse('running').success).toBe(true);
    expect(batchStatusSchema.safeParse('paused').success).toBe(true);
    expect(batchStatusSchema.safeParse('done').success).toBe(true);
    expect(batchStatusSchema.safeParse('aborted').success).toBe(true);
    expect(batchStatusSchema.safeParse('cancelled').success).toBe(false);
  });
});

describe('batchRunStateSchema', () => {
  const validBatch = {
    batchId: 'batch-1',
    createdAt: 1723600000000,
    lineTag: 'main',
    targetAnchorSceneId: 's5',
    orderedSceneIds: ['s1', 's2', 's5'],
    doneSceneIds: ['s1'],
    gear: 'smart',
    status: 'running',
    chapterMap: { s1: 'ch-0', s2: 'ch-1', s5: 'ch-1' },
    sessionId: 'sess-1',
  };

  it('完整形态 parse 通过 + 类型推断', () => {
    const result = batchRunStateSchema.parse(validBatch);
    expect(result.batchId).toBe('batch-1');
    expect(result.doneSceneIds).toEqual(['s1']);
    expect(result.chapterMap.s5).toBe('ch-1');
  });

  it('orderedSceneIds 至少 1（空批无意义）', () => {
    expect(batchRunStateSchema.safeParse({ ...validBatch, orderedSceneIds: [] }).success).toBe(false);
  });

  it('doneSceneIds 缺省 default []（additive——旧记录无字段仍 parse）', () => {
    const { doneSceneIds: _omitted, ...minimal } = validBatch;
    const result = batchRunStateSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.doneSceneIds).toEqual([]);
  });

  it('sessionId / lineTag / targetAnchorSceneId / updatedAt optional（additive）', () => {
    const result = batchRunStateSchema.safeParse({
      batchId: 'b',
      createdAt: 1,
      orderedSceneIds: ['s1'],
      gear: 'hands_off',
      status: 'done',
      chapterMap: {},
    });
    expect(result.success).toBe(true);
  });

  it('gear 垃圾值拒绝（batches.json per-element filter 的依据）', () => {
    expect(batchRunStateSchema.safeParse({ ...validBatch, gear: 'yolo' }).success).toBe(false);
  });
});

describe('sceneWeightSignalSchema', () => {
  it('最小信号卡 parse（机械事实容器——无重要性分值字段）', () => {
    const result = sceneWeightSignalSchema.safeParse({
      sceneId: 's1',
      storyTime: 3,
      role: 'normal',
      causalEdgeCount: 2,
      outlineRichness: 'sparse',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promiseBeats).toEqual([]);
      expect(result.data.worldStateSubjects).toEqual([]);
      expect(result.data.anchorType).toBeUndefined();
    }
  });

  it('完整信号卡（锚点 / Promise 节拍 / 情绪 / 信息释放 / world-state）parse', () => {
    const result = sceneWeightSignalSchema.safeParse({
      sceneId: 's2',
      chapterId: 'ch-1',
      storyTime: 5,
      storyTimeLabel: '第5日黄昏',
      role: 'core-anchor',
      anchorType: 'core-anchor',
      lineTags: ['main'],
      outcomeType: '惨胜',
      pacingRole: '高潮',
      causalEdgeCount: 4,
      promiseBeats: [{ promiseId: 'p1', kind: 'payoff', promiseTitle: '身世之谜' }],
      promiseDueTitles: ['金手指代价'],
      emotion: {
        sceneMood: '紧张',
        sceneVad: { v: -0.4, a: 0.8, d: -0.2 },
        characters: [{ characterId: 'char-a', emotion: '恐惧', emotionEnd: '决意' }],
      },
      infoRelease: { entryCount: 2, modes: ['sustain_unknown'], revealCount: 1, withholdCount: 3 },
      worldStateSubjects: [{ subjectId: 'char-a', patchCount: 7 }],
      outlineRichness: 'rich',
    });
    expect(result.success).toBe(true);
  });

  it('outlineRichness 三档封闭（rich/sparse/none）', () => {
    for (const r of ['rich', 'sparse', 'none']) {
      expect(sceneWeightSignalSchema.safeParse({ sceneId: 's', storyTime: 0, role: 'normal', causalEdgeCount: 0, outlineRichness: r }).success).toBe(true);
    }
    expect(sceneWeightSignalSchema.safeParse({ sceneId: 's', storyTime: 0, role: 'normal', causalEdgeCount: 0, outlineRichness: 'partial' }).success).toBe(false);
  });
});
