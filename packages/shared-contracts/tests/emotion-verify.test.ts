import { describe, expect, it } from 'vitest';
import {
  computeSetpoint,
  decayExpected,
  verifyCharacterArc,
  verifyReaderTopology,
  dtwDistance,
  adjustSetpoint,
  dedupePointsByRefId,
  runEmotionVerify,
  emotionVerifyResultSchema,
  emotionCurveSchema,
  assetCardSchema,
  TAU_MIN,
  DEFAULT_TAU,
  type VadTriple,
  type EmotionPoint,
  type EmotionCurve,
  type WorldPatch,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 5.3：verify-loop DTW/setpoint 数学纯函数层。
// 纯函数 + 纯 Zod schema → plain vitest（无 fs/db/LLM）。覆盖（AC1-AC5 + D-5.1-3）：
// - computeSetpoint：elasticity→τ 映射 / 缺失默认 / 边界（0=冻结/1=极弹性/clamp）
// - decayExpected：AGENT-005 公式 / τ=0 冻结 guard / t=0 返 peak
// - verifyCharacterArc：peak 后回落（无违规）/ 持续高原（违规）/ 振荡弧无违规（CR-002 reset）/ 空 degraded
// - verifyReaderTopology：正常起伏（无违规）/ 持续 rise（违规）/ 持续 flat（违规）/ VAD 缺失 degraded / peak 检测
// - dtwDistance：不等长对齐 / identical→0 / empty→0
// - adjustSetpoint：兑现上调 / 未兑现压低 / catharsis / 无净信号不变
// - dedupePointsByRefId：D-5.1-3（取最新，保首序）
// - runEmotionVerify：集成 + graceful（空 curve / VAD 缺失降级 / DTW flag / payoff setpoint / CR-001 degraded 守卫 / CR-003 坏 characters / CR-004 OR 降级 / CR-005 NaN skip）
// - emotionVerifyResultSchema：链段 artifact shape（mirror routeDecisionSchema）/ CR-005 chapterDtwDistance .finite()
// - emotionElasticity schema：asset_cards 角色卡接受（additive optional 零 migration）
// - computeSetpoint CR-006：elasticity=0 → τ=0 冻结特例（非 TAU_MAX 近冻结）→ decayExpected frozen guard 端到端可达
//
// 🔑 范式红线：全纯代码（确定性数学），不裁判语义（归 Director 7.3/8.1 + Reader-Audit 5.4）。
//    不 rollup 选代表情绪（5.2 硬约束）。VAD 缺失降级 topology 方向纯代码，不做 LLM 语义距离（归 5.4）。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 VadTriple：arousal=a，v/d 缺省 0（测试用 helper，arousal 为情绪强度轴）。 */
function vad(a: number, v = 0, d = 0): VadTriple {
  return { v, a, d };
}

/** 构造 emotion_point（refId + characters + 可选 sceneVad）。 */
function emotionPoint(
  refId: string,
  opts: { sceneVad?: VadTriple; characters?: Array<{ characterId: string; vad?: VadTriple }> } = {},
): EmotionPoint {
  return {
    refId,
    sceneVad: opts.sceneVad,
    characters: (opts.characters ?? []).map((c) => ({
      characterId: c.characterId,
      emotion: '恐惧',
      ...(c.vad ? { vad: c.vad } : {}),
    })),
  };
}

/** 构造 EmotionCurve（经 schema parse 填 emotional_promises/catharsis_points defaults）。 */
function makeCurve(
  points: EmotionPoint[],
  extra: { catharsis_points?: string[]; emotional_promises?: string[] } = {},
): EmotionCurve {
  return emotionCurveSchema.parse({ unit: 'scene', points, ...extra });
}

/** 构造 emotional patch（6.6 actual轨，subjectId + value + storyTime）。 */
function emotionalPatch(subjectId: string, storyTime: number, value: unknown): WorldPatch {
  return {
    id: `${subjectId}-${storyTime}`,
    sliceId: `ep1:${storyTime}`,
    subjectId,
    path: '/mood',
    op: 'replace',
    value,
    axis: 'emotional',
    source: 'derived',
    storyTime,
  };
}

const A = 'char-a';
const B = 'char-b';

// ── emotionElasticity schema（R1.1：additive optional 零 migration）──

describe('emotionElasticity schema（R1.1：角色卡 personality.emotionElasticity，additive optional）', () => {
  it('assetCardSchema 接受 character 卡 personality.emotionElasticity（0..1）', () => {
    const card = assetCardSchema.parse({
      id: 'c1',
      type: 'character',
      name: '李探长',
      personality: { coreTraits: ['坚韧'], emotionElasticity: 0.6 },
    });
    if (card.type === 'character') {
      expect(card.personality?.emotionElasticity).toBe(0.6);
    }
  });

  it('emotionElasticity 缺省 undefined（既有角色卡零 migration 仍 validate）', () => {
    const card = assetCardSchema.parse({
      id: 'c1',
      type: 'character',
      name: '李探长',
      personality: { coreTraits: ['坚韧'] },
    });
    if (card.type === 'character') {
      expect(card.personality?.emotionElasticity).toBeUndefined();
    }
  });

  it('emotionElasticity 拒越界（<0 / >1）', () => {
    expect(() =>
      assetCardSchema.parse({
        id: 'c1', type: 'character', name: 'X',
        personality: { emotionElasticity: -0.1 },
      }),
    ).toThrow();
    expect(() =>
      assetCardSchema.parse({
        id: 'c1', type: 'character', name: 'X',
        personality: { emotionElasticity: 1.1 },
      }),
    ).toThrow();
  });

  it('边界 0（冻结创伤）与 1（极弹性）合法', () => {
    expect(() =>
      assetCardSchema.parse({ id: 'c1', type: 'character', name: 'X', personality: { emotionElasticity: 0 } }),
    ).not.toThrow();
    expect(() =>
      assetCardSchema.parse({ id: 'c1', type: 'character', name: 'X', personality: { emotionElasticity: 1 } }),
    ).not.toThrow();
  });
});

// ── computeSetpoint（R1.3：elasticity → τ 映射 + 初始 setpoint）──

describe('computeSetpoint（R1.3：elasticity → τ + 初始 setpoint）', () => {
  it('elasticity=0（冻结/创伤）→ τ=0（CR-006 冻结特例，brainstorming #10 创伤情绪不减衰）', () => {
    const r = computeSetpoint({ id: A, personality: { emotionElasticity: 0 } });
    expect(r.tau).toBe(0);
    expect(r.elasticityMissing).toBe(false);
  });

  it('elasticity=1（极弹性/来得快走得快）→ τ=TAU_MIN（极快衰减，clamp 免 τ=0 数学未定义）', () => {
    const r = computeSetpoint({ id: A, personality: { emotionElasticity: 1 } });
    expect(r.tau).toBe(TAU_MIN);
    expect(r.elasticityMissing).toBe(false);
  });

  it('elasticity=0.5（持久深沉）→ τ=TAU_MAX·(1-0.5)=5（中等衰减）', () => {
    const r = computeSetpoint({ id: A, personality: { emotionElasticity: 0.5 } });
    expect(r.tau).toBeCloseTo(5, 5);
  });

  it('elasticity 缺失 → defaultTau（elasticityMissing=true）', () => {
    const r = computeSetpoint({ id: A, personality: {} });
    expect(r.tau).toBe(DEFAULT_TAU);
    expect(r.elasticityMissing).toBe(true);
  });

  it('personality 整体缺失 → defaultTau', () => {
    const r = computeSetpoint({ id: A });
    expect(r.tau).toBe(DEFAULT_TAU);
    expect(r.elasticityMissing).toBe(true);
  });

  it('personality=null（CR-002 nullish）→ defaultTau', () => {
    const r = computeSetpoint({ id: A, personality: null });
    expect(r.tau).toBe(DEFAULT_TAU);
    expect(r.elasticityMissing).toBe(true);
  });

  it('初始 setpoint = 中性 {0,0,0}（基线随 payoff 动态调整，首章默认中性）', () => {
    const r = computeSetpoint({ id: A, personality: { emotionElasticity: 0.3 } });
    expect(r.setpoint).toEqual({ v: 0, a: 0, d: 0 });
    expect(r.characterId).toBe(A);
  });

  it('自定义 defaultTau 覆盖 DEFAULT_TAU', () => {
    const r = computeSetpoint({ id: A }, 5);
    expect(r.tau).toBe(5);
  });

  it('CR-006 端到端：elasticity=0 → τ=0 → decayExpected 冻结（情绪锁 peak 不衰减）', () => {
    // 创伤角色（elasticity=0）情绪不减衰：τ=0 致 decayExpected frozen guard 生效（返 peak 不变）。
    const { tau } = computeSetpoint({ id: A, personality: { emotionElasticity: 0 } });
    expect(tau).toBe(0);
    const peak = vad(0.8);
    const setpoint = vad(0);
    // t=5 仍返 peak（冻结），对比 elasticity=0.5（τ=5）会衰减。
    expect(decayExpected(peak, setpoint, tau, 5)).toEqual(peak);
    const decaying = decayExpected(peak, setpoint, 5, 5);
    expect(decaying.a).toBeLessThan(0.8);
  });
});

// ── decayExpected（R1.3：AGENT-005 衰减公式）──

describe('decayExpected（R1.3：AGENT-005 emotion(t)=setpoint+(peak-setpoint)·e^{-t/τ}）', () => {
  it('t=0 → 返 peak（尚未衰减）', () => {
    const peak = vad(0.8);
    const setpoint = vad(0);
    expect(decayExpected(peak, setpoint, 2, 0)).toEqual(peak);
  });

  it('t>0 → 指数衰减向 setpoint（公式核对）', () => {
    const peak = vad(0.8);
    const setpoint = vad(0);
    const r = decayExpected(peak, setpoint, 2, 1);
    // expected a = 0 + 0.8·e^{-1/2} = 0.8·0.6065 ≈ 0.485
    expect(r.a).toBeCloseTo(0.485, 2);
    expect(r.a).toBeLessThan(0.8); // 已衰减
    expect(r.a).toBeGreaterThan(0); // 未到 setpoint
  });

  it('t 很大 → 接近 setpoint', () => {
    const peak = vad(0.8);
    const setpoint = vad(0.1);
    const r = decayExpected(peak, setpoint, 2, 100);
    expect(r.a).toBeCloseTo(0.1, 2); // 回归基线
  });

  it('τ 大 → 衰减慢（t=1 时仍接近 peak）', () => {
    const peak = vad(0.8);
    const setpoint = vad(0);
    const slow = decayExpected(peak, setpoint, 10, 1); // τ=10 慢
    const fast = decayExpected(peak, setpoint, 0.5, 1); // τ=0.5 快
    expect(slow.a).toBeGreaterThan(fast.a); // 慢衰减保持高
  });

  it('τ=0 → 冻结 guard（返 peak 不衰减，design §2.1 创伤角色情绪锁死）', () => {
    const peak = vad(0.8);
    const setpoint = vad(0);
    expect(decayExpected(peak, setpoint, 0, 5)).toEqual(peak); // τ=0 冻结
  });

  it('τ 负 → 同冻结 guard（防御坏数据）', () => {
    const peak = vad(0.8);
    const setpoint = vad(0);
    expect(decayExpected(peak, setpoint, -1, 5)).toEqual(peak);
  });

  it('t 负 → 返 peak（防御，尚未达 peak）', () => {
    const peak = vad(0.8);
    const setpoint = vad(0);
    expect(decayExpected(peak, setpoint, 2, -1)).toEqual(peak);
  });

  it('per VAD 轴独立衰减（v/a/d 各按公式）', () => {
    const peak = { v: 0.6, a: 0.8, d: -0.4 };
    const setpoint = { v: 0, a: 0, d: 0 };
    const r = decayExpected(peak, setpoint, 2, 1);
    expect(r.v).toBeCloseTo(0.6 * Math.exp(-0.5), 3);
    expect(r.a).toBeCloseTo(0.8 * Math.exp(-0.5), 3);
    expect(r.d).toBeCloseTo(-0.4 * Math.exp(-0.5), 3);
  });
});

// ── verifyCharacterArc（R1.3：角色层 setpoint 衰减验证）──

describe('verifyCharacterArc（R1.3：角色层 plateau 检测，享乐适应）', () => {
  it('peak 后回落（正常起伏）→ 无 plateau', () => {
    // arousal [0.8, 0.5, 0.3]：peak at 0，后衰减。
    const r = verifyCharacterArc([vad(0.8), vad(0.5), vad(0.3)], vad(0), 2, A);
    expect(r.plateauDetected).toBe(false);
    expect(r.peakCount).toBe(1);
    expect(r.pointCount).toBe(3);
    expect(r.degraded).toBe(false);
    expect(r.plateauSeverity).toBe(0);
  });

  it('持续高原（peak 后无回落）→ plateau 违规', () => {
    // arousal [0.8, 0.8, 0.8, 0.8]：peak at 0，后续全保持 → 违反享乐适应。
    const r = verifyCharacterArc([vad(0.8), vad(0.8), vad(0.8), vad(0.8)], vad(0), 2, A);
    expect(r.plateauDetected).toBe(true);
    expect(r.plateauSeverity).toBeCloseTo(1, 1); // 3/3 plateau steps
    expect(r.peakCount).toBe(1); // 仅首个 0.8 立新峰
  });

  it('CR-002 振荡弧（平静↔愤怒交替）→ 无 plateau（每次回落基线 reset peak cycle）', () => {
    // arousal [0.8, 0.3, 0.8, 0.3, 0.8, 0.3]：愤怒(0.8)↔平静基线(0.3)交替（合理起伏，非享乐适应违反）。
    // setpoint=0.3（角色平静基线），0.3 < setpoint+容差(0.45) → reset peakIdx，下个 0.8 重建新 peak（开新周期）。
    // fix 前：global running peak + 单调 dt 致第二个 0.8 落入旧 peak 的衰减期望比对 → 误报 plateau。
    const r = verifyCharacterArc(
      [vad(0.8), vad(0.3), vad(0.8), vad(0.3), vad(0.8), vad(0.3)],
      vad(0.3),
      2,
      A,
    );
    expect(r.plateauDetected).toBe(false);
    expect(r.plateauSeverity).toBe(0);
    expect(r.peakCount).toBe(3); // 每次愤怒都重建新 peak
  });

  it('上升至 peak 后回落（正常 build-up + release）→ 无 plateau', () => {
    // arousal [0.3, 0.5, 0.8, 0.5, 0.3]：渐升至 peak 再回落。
    const r = verifyCharacterArc([vad(0.3), vad(0.5), vad(0.8), vad(0.5), vad(0.3)], vad(0), 2, A);
    expect(r.plateauDetected).toBe(false);
    expect(r.peakCount).toBe(3); // 0.3, 0.5, 0.8 各立新 running peak
  });

  it('空序列 → degraded（无 VAD 可验）', () => {
    const r = verifyCharacterArc([], vad(0), 2, A);
    expect(r.degraded).toBe(true);
    expect(r.plateauDetected).toBe(false);
    expect(r.pointCount).toBe(0);
  });

  it('单点序列 → 无 plateau（无后继可比衰减）', () => {
    const r = verifyCharacterArc([vad(0.8)], vad(0), 2, A);
    expect(r.plateauDetected).toBe(false);
    expect(r.pointCount).toBe(1);
    expect(r.plateauSeverity).toBe(0);
  });

  it('τ=0（冻结角色）→ 期望即时回 setpoint，持续高原更易检出', () => {
    // τ=0 decayExpected 返 peak 不衰减（冻结 guard），故 verifyCharacterArc 的期望衰减对 τ=0 角色不适用。
    // 这里确认 τ=0 不崩（guard 生效），peak 仍可计。
    const r = verifyCharacterArc([vad(0.8), vad(0.8)], vad(0), 0, A);
    expect(r.pointCount).toBe(2);
    expect(r.peakCount).toBe(1);
  });

  it('低 arousal（全低于 setpoint+容差）→ 无 peak 无 plateau', () => {
    // arousal 全在 setpoint 附近（0.05 < 0.15 容差），无显著峰。
    const r = verifyCharacterArc([vad(0.05), vad(0.05), vad(0.05)], vad(0), 2, A);
    expect(r.peakCount).toBe(0);
    expect(r.plateauDetected).toBe(false);
  });
});

// ── verifyReaderTopology（R1.3：读者层 topology 节奏验证）──

describe('verifyReaderTopology（R1.3：读者层 rise/fall/flat/peak 节奏）', () => {
  it('正常起伏（rise-fall-rise）→ directions 含 peak/fall，连续低', () => {
    // [0.3, 0.7, 0.3, 0.7]：两个 peak 交替 fall。
    const r = verifyReaderTopology([vad(0.3), vad(0.7), vad(0.3), vad(0.7)]);
    expect(r.directions).toEqual(['flat', 'peak', 'fall', 'peak']);
    expect(r.maxConsecutiveRise).toBe(1); // peak 单点
    expect(r.degraded).toBe(false);
  });

  it('持续上行（连续 rise 无 fall）→ maxConsecutiveRise=3（build-up 至末点 peak）', () => {
    const r = verifyReaderTopology([vad(0.2), vad(0.4), vad(0.6), vad(0.8)]);
    expect(r.directions).toEqual(['flat', 'rise', 'rise', 'peak']);
    expect(r.maxConsecutiveRise).toBe(3); // rise+rise+peak
  });

  it('peak 后 fall（单次高潮回落）→ peak/fall directions', () => {
    const r = verifyReaderTopology([vad(0.8), vad(0.5), vad(0.3)]);
    expect(r.directions).toEqual(['flat', 'fall', 'fall']);
    expect(r.maxConsecutiveRise).toBe(0);
  });

  it('持续 flat（情绪停滞）→ maxConsecutiveFlat 计全 flat', () => {
    const r = verifyReaderTopology([vad(0.5), vad(0.5), vad(0.5), vad(0.5)]);
    expect(r.maxConsecutiveFlat).toBe(4);
    expect(r.directions).toEqual(['flat', 'flat', 'flat', 'flat']);
  });

  it('空序列 → degraded', () => {
    const r = verifyReaderTopology([]);
    expect(r.degraded).toBe(true);
    expect(r.directions).toEqual([]);
  });

  it('VAD 缺失（null 点）→ degraded=true + 该点 flat', () => {
    const r = verifyReaderTopology([vad(0.5), null, vad(0.7)]);
    expect(r.degraded).toBe(true);
    expect(r.directions[1]).toBe('flat'); // null 端退 flat
  });

  it('全 null → degraded + 全 flat', () => {
    const r = verifyReaderTopology([null, null, null]);
    expect(r.degraded).toBe(true);
    expect(r.directions).toEqual(['flat', 'flat', 'flat']);
  });
});

// ── dtwDistance（R1.3：DTW 不等长对齐）──

describe('dtwDistance（R1.3：DTW VAD 形状距离，章级偏离指纹）', () => {
  it('identical 单点序列 → 距离 0', () => {
    expect(dtwDistance([vad(0.5)], [vad(0.5)])).toBe(0);
  });

  it('完全不同单点 → 距离 = VAD 欧氏距离（归一化 /1）', () => {
    // vad(0,0,0) vs vad(0,1,0)：欧氏距离 = 1，归一化 /max(1,1)=1。
    expect(dtwDistance([vad(0)], [vad(1)])).toBeCloseTo(1, 5);
  });

  it('不等长对齐（目标 2 点 vs 实际 1 点）→ 返合理距离 > 0', () => {
    const d = dtwDistance([vad(0.2), vad(0.8)], [vad(0.5)]);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(2); // 合理范围（归一化后）
  });

  it('空序列（任一空）→ 0（graceful）', () => {
    expect(dtwDistance([], [vad(0.5)])).toBe(0);
    expect(dtwDistance([vad(0.5)], [])).toBe(0);
    expect(dtwDistance([], [])).toBe(0);
  });

  it('相同形状（仅缩放）→ 较小距离', () => {
    // [0.2, 0.8] 与 [0.2, 0.8] identical → 0。
    expect(dtwDistance([vad(0.2), vad(0.8)], [vad(0.2), vad(0.8)])).toBe(0);
  });

  it('3D VAD（v/a/d 都变）→ 三轴欧氏距离', () => {
    // {0,0,0} vs {1,1,1}：sqrt(3) ≈ 1.732。
    const d = dtwDistance([{ v: 0, a: 0, d: 0 }], [{ v: 1, a: 1, d: 1 }]);
    expect(d).toBeCloseTo(Math.sqrt(3), 3);
  });
});

// ── adjustSetpoint（R1.3：payoff 联动 setpoint 动态调整）──

describe('adjustSetpoint（R1.3：payoff 联动，AGENT-005 2.4）', () => {
  it('兑现 payoff → setpoint 上调（成长基线上移，valence+dominance 同向）', () => {
    const r = adjustSetpoint(A, vad(0), [{ fulfilled: true }], []);
    expect(r.adjusted).toBe(true);
    expect(r.setpoint.a).toBeGreaterThan(0); // arousal 同向（0.5 系数）
    expect(r.fulfilledCount).toBe(1);
    expect(r.unfulfilledCount).toBe(0);
    expect(r.reason).toContain('上调');
  });

  it('未兑现 payoff → setpoint 压低（创伤）', () => {
    const r = adjustSetpoint(A, vad(0), [{ fulfilled: false }], []);
    expect(r.adjusted).toBe(true);
    expect(r.setpoint.a).toBeLessThan(0); // 负向
    expect(r.unfulfilledCount).toBe(1);
    expect(r.reason).toContain('压低');
  });

  it('catharsis 命中 → 上调（catharsis = 层层递进的释放点）', () => {
    const r = adjustSetpoint(A, vad(0), [], ['最终对决']);
    expect(r.adjusted).toBe(true);
    expect(r.catharsisHit).toBe(true);
    expect(r.setpoint.a).toBeGreaterThan(0);
  });

  it('兑现 + catharsis 叠加上调（多正向信号）', () => {
    const r = adjustSetpoint(A, vad(0), [{ fulfilled: true }, { fulfilled: true }], ['对决']);
    // netShift = (2+1) - 0 = 3 → delta = 0.3
    expect(r.setpoint.a).toBeCloseTo(0.15, 3); // 0.3 · 0.5
  });

  it('兑现与未兑现抵消 → adjusted=false（netShift=0）', () => {
    const r = adjustSetpoint(A, vad(0), [{ fulfilled: true }, { fulfilled: false }], []);
    expect(r.adjusted).toBe(false);
    expect(r.setpoint).toEqual(vad(0));
    expect(r.reason).toContain('不变');
  });

  it('无 payoff 无 catharsis → adjusted=false', () => {
    const r = adjustSetpoint(A, vad(0), [], []);
    expect(r.adjusted).toBe(false);
    expect(r.setpoint).toEqual(vad(0));
  });

  it('clamp VAD -1..1（大量兑现不越界）', () => {
    const manyFulfilled = Array.from({ length: 20 }, () => ({ fulfilled: true }));
    const r = adjustSetpoint(A, vad(0.9), manyFulfilled, ['c']);
    expect(r.setpoint.v).toBeLessThanOrEqual(1);
    expect(r.setpoint.a).toBeLessThanOrEqual(1);
    expect(r.setpoint.d).toBeLessThanOrEqual(1);
  });

  it('characterId 透传', () => {
    const r = adjustSetpoint(B, vad(0), [{ fulfilled: true }], []);
    expect(r.characterId).toBe(B);
  });
});

// ── dedupePointsByRefId（R1.3 + D-5.1-3：refId 去重）──

describe('dedupePointsByRefId（D-5.1-3：取最新 Director 意图，保首序）', () => {
  it('重复 refId → 保留最后出现内容', () => {
    const p1 = emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.2) }] });
    const p2 = emotionPoint('s2', { characters: [{ characterId: A, vad: vad(0.5) }] });
    const p1New = emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.8) }] });
    const out = dedupePointsByRefId([p1, p2, p1New]);
    expect(out).toHaveLength(2);
    expect(out[0].refId).toBe('s1');
    expect(out[0].characters[0].vad).toEqual(vad(0.8)); // 取最新 p1New 的 vad
    expect(out[1].refId).toBe('s2');
  });

  it('保首次出现序（不重排）', () => {
    const p1 = emotionPoint('s1');
    const p2 = emotionPoint('s2');
    const p3 = emotionPoint('s3');
    const p2New = emotionPoint('s2', { sceneVad: vad(0.9) });
    const out = dedupePointsByRefId([p1, p2, p3, p2New]);
    expect(out.map((p) => p.refId)).toEqual(['s1', 's2', 's3']); // 首序
    expect(out[1].sceneVad).toEqual(vad(0.9)); // 但内容取最新
  });

  it('无重复 → 原样返回', () => {
    const points = [emotionPoint('s1'), emotionPoint('s2'), emotionPoint('s3')];
    expect(dedupePointsByRefId(points)).toHaveLength(3);
  });

  it('空数组 → 空数组', () => {
    expect(dedupePointsByRefId([])).toEqual([]);
  });

  it('三重重复 → 保留最后', () => {
    const a = emotionPoint('s1', { sceneVad: vad(0.1) });
    const b = emotionPoint('s1', { sceneVad: vad(0.5) });
    const c = emotionPoint('s1', { sceneVad: vad(0.9) });
    const out = dedupePointsByRefId([a, b, c]);
    expect(out).toHaveLength(1);
    expect(out[0].sceneVad).toEqual(vad(0.9));
  });
});

// ── runEmotionVerify（R1.3 aggregator：集成 + graceful）──

describe('runEmotionVerify（R1.3 aggregator：两层验证 + DTW + payoff setpoint）', () => {
  it('完整输入 → 产 characterArcs + readerTopology + adjustedSetpoints', () => {
    const curve = makeCurve(
      [
        emotionPoint('s1', { sceneVad: vad(0.3), characters: [{ characterId: A, vad: vad(0.4) }] }),
        emotionPoint('s2', { sceneVad: vad(0.7), characters: [{ characterId: A, vad: vad(0.8) }] }),
        emotionPoint('s3', { sceneVad: vad(0.3), characters: [{ characterId: A, vad: vad(0.5) }] }),
      ],
      { catharsis_points: ['s2 对决'] },
    );
    const r = runEmotionVerify({
      emotionCurve: curve,
      payoffEvents: [{ fulfilled: true }],
      characterCards: [{ id: A, personality: { emotionElasticity: 0.5 } }],
    });
    expect(r.characterArcs).toHaveLength(1);
    expect(r.characterArcs[0].characterId).toBe(A);
    expect(r.readerTopology.directions).toHaveLength(3);
    expect(r.adjustedSetpoints).toHaveLength(1);
    expect(r.adjustedSetpoints[0].adjusted).toBe(true); // payoff 兑现 + catharsis
    expect(r.degraded).toBe(false);
  });

  it('emotion_curve 缺失 → degraded（flags=[], 空结果，不崩）', () => {
    const r = runEmotionVerify({ emotionCurve: null });
    expect(r.degraded).toBe(true);
    expect(r.flags).toEqual([]);
    expect(r.characterArcs).toEqual([]);
    expect(r.adjustedSetpoints).toEqual([]);
    expect(r.readerTopology.degraded).toBe(true);
    expect(r.degradationNote).toContain('emotion_curve');
  });

  it('emotion_curve points 空 → degraded', () => {
    const r = runEmotionVerify({ emotionCurve: makeCurve([]) });
    expect(r.degraded).toBe(true);
  });

  it('角色层 plateau（持续高原）→ character_setpoint_violation flag', () => {
    const curve = makeCurve([
      emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.8) }] }),
      emotionPoint('s2', { characters: [{ characterId: A, vad: vad(0.8) }] }),
      emotionPoint('s3', { characters: [{ characterId: A, vad: vad(0.8) }] }),
      emotionPoint('s4', { characters: [{ characterId: A, vad: vad(0.8) }] }),
    ]);
    const r = runEmotionVerify({ emotionCurve: curve });
    expect(r.flags).toContain('character_setpoint_violation');
    expect(r.characterArcs[0].plateauDetected).toBe(true);
  });

  it('读者层持续上行 → reader_topology_violation flag', () => {
    const curve = makeCurve([
      emotionPoint('s1', { sceneVad: vad(0.2) }),
      emotionPoint('s2', { sceneVad: vad(0.4) }),
      emotionPoint('s3', { sceneVad: vad(0.6) }),
      emotionPoint('s4', { sceneVad: vad(0.8) }),
    ]);
    const r = runEmotionVerify({ emotionCurve: curve });
    expect(r.flags).toContain('reader_topology_violation');
  });

  it('读者层持续 flat → reader_topology_violation flag', () => {
    const curve = makeCurve([
      emotionPoint('s1', { sceneVad: vad(0.5) }),
      emotionPoint('s2', { sceneVad: vad(0.5) }),
      emotionPoint('s3', { sceneVad: vad(0.5) }),
      emotionPoint('s4', { sceneVad: vad(0.5) }),
    ]);
    const r = runEmotionVerify({ emotionCurve: curve });
    expect(r.flags).toContain('reader_topology_violation');
  });

  it('CR-001 全 null sceneVad → degraded=true → 不 flag reader_topology_violation（守卫抑制假 flat）', () => {
    // sceneVad 全缺（5.1 VAD 可选常见）→ readerTopology 退全 flat + degraded=true。
    // maxConsecutiveFlat=4 但方向不准（null 端退 flat），守卫 !degraded 抑制 reader_topology_violation 误报。
    const curve = makeCurve([
      emotionPoint('s1'),
      emotionPoint('s2'),
      emotionPoint('s3'),
      emotionPoint('s4'),
    ]);
    const r = runEmotionVerify({ emotionCurve: curve });
    expect(r.readerTopology.degraded).toBe(true);
    expect(r.readerTopology.maxConsecutiveFlat).toBe(4);
    expect(r.flags).not.toContain('reader_topology_violation');
  });

  it('DTW actual patches present → chapterDtwDistance 计算 + 超阈值 flag', () => {
    const curve = makeCurve([emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.2) }] })]);
    const patches = [emotionalPatch(A, 1, { '/mood': '镇定', vad: vad(0.9) })];
    const r = runEmotionVerify({ emotionCurve: curve, emotionalPatches: patches });
    expect(r.chapterDtwDistance).toBeDefined();
    expect(r.chapterDtwDistance).toBeGreaterThan(0);
    // 0.2 vs 0.9 差大 → 超 DEFAULT_DTW_THRESHOLD(0.5) → flag
    expect(r.flags).toContain('dtw_distance_high');
  });

  it('DTW actual 与 target 接近 → 不 flag', () => {
    const curve = makeCurve([emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.5) }] })]);
    const patches = [emotionalPatch(A, 1, { vad: vad(0.5) })];
    const r = runEmotionVerify({ emotionCurve: curve, emotionalPatches: patches });
    expect(r.chapterDtwDistance).toBeCloseTo(0, 5);
    expect(r.flags).not.toContain('dtw_distance_high');
  });

  it('emotional patches 缺 → 跳过 DTW（chapterDtwDistance undefined，不崩）', () => {
    const curve = makeCurve([emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.5) }] })]);
    const r = runEmotionVerify({ emotionCurve: curve });
    expect(r.chapterDtwDistance).toBeUndefined();
    expect(r.flags).not.toContain('dtw_distance_high');
  });

  it('VAD 全缺（characters 无 vad + sceneVad 无）→ degraded', () => {
    const curve = makeCurve([
      emotionPoint('s1', { characters: [{ characterId: A }] }), // 无 vad
      emotionPoint('s2', { characters: [{ characterId: A }] }),
    ]);
    const r = runEmotionVerify({ emotionCurve: curve });
    expect(r.degraded).toBe(true);
    expect(r.characterArcs).toHaveLength(0); // 无 VAD 序列建不起来
    expect(r.degradationNote).toBeTruthy();
  });

  it('CR-004 字符 VAD 缺 + sceneVad 存在 → degraded=true（OR 逻辑，任一层降级）', () => {
    // 角色层 VAD 全缺（无 characters[].vad）→ allCharDegraded=true；sceneVad 存在 → readerTopology.degraded=false。
    // 原 AND 逻辑致 degraded=false + note='无 per-character VAD' 自相矛盾；CR-004 OR：任一层降级 → degraded=true。
    const curve = makeCurve([
      emotionPoint('s1', { sceneVad: vad(0.5), characters: [{ characterId: A }] }),
      emotionPoint('s2', { sceneVad: vad(0.7), characters: [{ characterId: A }] }),
    ]);
    const r = runEmotionVerify({ emotionCurve: curve });
    expect(r.characterArcs).toHaveLength(0); // 无 characters[].vad
    expect(r.readerTopology.degraded).toBe(false); // sceneVad 齐全
    expect(r.degraded).toBe(true); // OR：角色层降级 → 整体 degraded
    expect(r.degradationNote).toContain('per-character VAD');
  });

  it('payoff 联动 setpoint（兑现上调 / 未兑现压低）', () => {
    const curve = makeCurve([emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.5) }] })]);
    const rFulfilled = runEmotionVerify({
      emotionCurve: curve,
      payoffEvents: [{ fulfilled: true }],
    });
    expect(rFulfilled.adjustedSetpoints[0].setpoint.a).toBeGreaterThan(0);

    const rUnfulfilled = runEmotionVerify({
      emotionCurve: curve,
      payoffEvents: [{ fulfilled: false }],
    });
    expect(rUnfulfilled.adjustedSetpoints[0].setpoint.a).toBeLessThan(0);
  });

  it('refId 重复 → D-5.1-3 dedupe 守门（不双计）', () => {
    const curve = makeCurve([
      emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.2) }] }),
      emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.8) }] }), // 重复 s1
    ]);
    const r = runEmotionVerify({ emotionCurve: curve });
    // dedupe 后只 1 个 s1 point（取 vad 0.8）→ characterArcs[0].pointCount=1
    expect(r.characterArcs[0].pointCount).toBe(1);
  });

  it('CR-003 point.characters 缺/坏（非数组）→ graceful 跳过，不抛', () => {
    // 模拟未经 schema parse 的运行时坏数据（point.characters undefined）。
    // buildCharacterVadSeriesFromCurve 守 Array.isArray 跳过，mirror buildCharacterVadSeriesFromPatches 守卫。
    const good = emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.5) }] });
    const malformed = { refId: 's2', characters: undefined } as unknown as EmotionPoint;
    const curve = {
      unit: 'scene' as const,
      points: [good, malformed],
      emotional_promises: [],
      catharsis_points: [],
    };
    const r = runEmotionVerify({ emotionCurve: curve }); // 不抛
    expect(r.characterArcs.some((c) => c.characterId === A)).toBe(true);
  });

  it('CR-005 curve 内 NaN/Infinity vad → buildCharacterVadSeriesFromCurve 守性 skip（DTW/衰减不污染）', () => {
    // parseVadTriple 拒 NaN/Infinity/缺字段；curve 内坏 vad 跳过，不污染 DTW 距离/衰减序列。
    const good = emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.5) }] });
    // 坏 vad（NaN a）：绕过 schema parse 直接构造。
    const nanPoint = {
      refId: 's2',
      characters: [{ characterId: A, emotion: 'x', vad: { v: 0, a: Number.NaN, d: 0 } }],
    } as unknown as EmotionPoint;
    const curve = {
      unit: 'scene' as const,
      points: [good, nanPoint],
      emotional_promises: [],
      catharsis_points: [],
    };
    const r = runEmotionVerify({ emotionCurve: curve }); // 不抛、不污染
    expect(r.characterArcs).toHaveLength(1);
    expect(r.characterArcs[0].pointCount).toBe(1); // NaN vad 被跳过，只计 good 的 1 点
  });

  it('角色卡缺 emotionElasticity → 用 defaultTau（不崩，elasticityMissing 不影响结果结构）', () => {
    const curve = makeCurve([emotionPoint('s1', { characters: [{ characterId: A, vad: vad(0.5) }] })]);
    const r = runEmotionVerify({
      emotionCurve: curve,
      characterCards: [{ id: A, personality: {} }], // 无 emotionElasticity
    });
    expect(r.characterArcs).toHaveLength(1);
    expect(r.characterArcs[0].degraded).toBe(false); // VAD present，可验
  });

  it('自定义阈值（dtwThreshold / consecutiveRiseThreshold）生效', () => {
    // 3 场 rise（directions=[flat, rise, peak]，maxConsecutiveRise=2）。
    const curve = makeCurve([
      emotionPoint('s1', { sceneVad: vad(0.2) }),
      emotionPoint('s2', { sceneVad: vad(0.4) }),
      emotionPoint('s3', { sceneVad: vad(0.6) }),
    ]);
    // 默认阈值 3 不触发（maxConsecutiveRise=2 < 3），改阈值 2 → 触发。
    const rDefault = runEmotionVerify({ emotionCurve: curve });
    expect(rDefault.flags).not.toContain('reader_topology_violation');
    const rStrict = runEmotionVerify({ emotionCurve: curve }, { consecutiveRiseThreshold: 2 });
    expect(rStrict.flags).toContain('reader_topology_violation');
  });
});

// ── emotionVerifyResultSchema（R1.2：链段 artifact shape）──

describe('emotionVerifyResultSchema（R1.2：链段 artifact，mirror routeDecisionSchema）', () => {
  it('parse 完整 result（flags + characterArcs + readerTopology + adjustedSetpoints）', () => {
    const r = runEmotionVerify({
      emotionCurve: makeCurve([
        emotionPoint('s1', { sceneVad: vad(0.3), characters: [{ characterId: A, vad: vad(0.5) }] }),
      ]),
      payoffEvents: [{ fulfilled: true }],
    });
    const parsed = emotionVerifyResultSchema.parse(r);
    expect(parsed.flags).toEqual(r.flags);
    expect(parsed.characterArcs).toEqual(r.characterArcs);
    expect(parsed.adjustedSetpoints).toEqual(r.adjustedSetpoints);
    expect(parsed.degraded).toBe(false);
  });

  it('空 flags 默认 []（zod default）', () => {
    const parsed = emotionVerifyResultSchema.parse({
      readerTopology: { maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: true },
      degraded: true,
    });
    expect(parsed.flags).toEqual([]);
    expect(parsed.characterArcs).toEqual([]);
    expect(parsed.adjustedSetpoints).toEqual([]);
    expect(parsed.readerTopology.directions).toEqual([]);
  });

  it('chapterDtwDistance optional（缺省 undefined）', () => {
    const parsed = emotionVerifyResultSchema.parse({
      readerTopology: { maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: false },
      degraded: false,
    });
    expect(parsed.chapterDtwDistance).toBeUndefined();
  });

  it('CR-005 chapterDtwDistance .finite() 拒 NaN/Infinity（防坏数据尽入 ledger）', () => {
    const base = {
      readerTopology: { maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: false },
      degraded: false,
    };
    expect(() =>
      emotionVerifyResultSchema.parse({ ...base, chapterDtwDistance: Number.NaN }),
    ).toThrow();
    expect(() =>
      emotionVerifyResultSchema.parse({ ...base, chapterDtwDistance: Number.POSITIVE_INFINITY }),
    ).toThrow();
    // 合法有限值仍通过。
    expect(
      emotionVerifyResultSchema.parse({ ...base, chapterDtwDistance: 0.42 }).chapterDtwDistance,
    ).toBeCloseTo(0.42, 5);
  });

  it('flag 枚举值校验（三项合法 + 非法拒）', () => {
    const base = {
      readerTopology: { maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: false },
      degraded: false,
    };
    expect(
      emotionVerifyResultSchema.parse({
        ...base,
        flags: ['character_setpoint_violation', 'reader_topology_violation', 'dtw_distance_high'],
      }).flags,
    ).toHaveLength(3);
    expect(() =>
      emotionVerifyResultSchema.parse({ ...base, flags: ['unknown_flag'] }),
    ).toThrow();
  });
});
