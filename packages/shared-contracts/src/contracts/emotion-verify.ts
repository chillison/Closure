import { z } from 'zod';
import { vadTripleSchema } from './creative-fields';
import type { VadTriple, EmotionPoint, EmotionCurve } from './creative-fields';
import type { WorldPatch } from './world-state';

// ── Story 5.3：verify-loop DTW/setpoint 数学纯函数层（design §1-§12 / ADR-3 / AGENT-005）──
//
// 5.3 = chapter-chain 内事后 verify-loop 纯代码节点（emotion-verify-node，R2 落 agent 包）。本文件落 shared-contracts：
// schema（emotion_verify_result 链段 artifact）+ 一组纯函数（setpoint 衰减 / topology / DTW / payoff 联动 / refId dedupe）。
// 跨包 DRY（agent emotion-verify-node 消费 + 未来 ledger/dashboard 统计 + R2 集成测共用同形态）。
//
// 🔑 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md §5.3 段）：全确定性数学 = 纯代码（无 LLM/无 db/无副作用）：
// - setpoint 指数衰减（AGENT-005：emotion(t)=setpoint+(peak-setpoint)·e^{-t/τ}，τ=角色卡 emotionElasticity 映射）。
// - topology 方向比对（sceneMood 弧 rise/fall/flat/peak，写作思维原理 line 305-306 读者对持续刺激麻木）。
// - DTW VAD 形状距离（不等长对齐，章级偏离指纹）。
// - payoff 联动 setpoint 调整（兑现上调/未兑现压低，AGENT-005 2.4）。
// **不裁判语义**：偏离后「重规划成什么」归 Director（7.3/8.1）；turning point 识别 / VAD 缺失语义距离归 LLM（5.4 Reader-Audit）。
// **正交于 6.x「对比归语义」**（world-state.ts:5-10 指「目标是否落地正文」归 Reader-Audit；5.3 DTW 是 VAD 形状统计指纹不裁判落地）。
// **不 rollup 选代表情绪**（5.2 硬约束，brief-compiler-node.ts:553-555）：per-scene points 透传 DTW/衰减，不机械选章级代表情绪。
//
// 两层正交（design §2，用户定写作视角重审）：
// - 角色层 setpoint 衰减（characters 弧 → 性格基线回归，brainstorming #1/#22/#10）。
// - 读者层 topology 节奏（sceneMood 弧 → rise/fall/peak 避麻木，写作思维原理 line 305-306）。
// 两层各验各的，共鸣因果链（角色情绪→读者共鸣，line 128）。
//
// expected_downstream_consumers:
// - Story 5.3 R2：agent emotion-verify-node（消费 emotion_curve artifact + emotional patches + payoff + asset_cards）→ runEmotionVerify → emotion_verify_result artifact。
// - Story 7.3/8.1：Director 重规划段读 emotion_verify_result.flags（偏离 flag 反哺下一轮 Director，:48 placeholder，5.3 产 flag 不实写重规划）。
// - Story 5.4：Reader-Audit 情绪维可选预筛信号（场景情绪落地检查的辅信号）。
// - Epic 3/10：ledger 统计指纹 → dashboard 可视化（滞后做）。

// ── 常量（确定性，单测覆盖边界）──

/** τ 上限（非冻结角色的最长衰减时间常数）。design §4：冷漠 τ 小/敏感 τ 大/创伤冻结。 */
export const TAU_MAX = 10;
/** τ 下限（elasticity=1 极弹性时的快衰减；clamp 免 τ=0 致 e^{-t/τ} 数学未定义——冻结特例由 computeSetpoint 单独判）。 */
export const TAU_MIN = 0.1;
/** 缺 emotionElasticity 时的默认 τ（design §4：缺失用全局默认，题材 playbook 后续 D8 接）。 */
export const DEFAULT_TAU = 2;
/** payoff 联动 setpoint 步长（每兑现/未兑现/catharsis 的 VAD 位移，AGENT-005 2.4 固定步长）。 */
export const PAYOFF_STEP = 0.1;
/** plateau 容差（实际 arousal 超期望衰减值多少视为「未回落」，纯代码机械阈值）。 */
export const PLATEAU_TOLERANCE = 0.15;
/** plateau 严重度触发阈值（sustained 高原占比 ≥ 此值 → flag，design §2.1 持续无回落的高原）。 */
export const PLATEAU_SEVERITY_THRESHOLD = 0.3;
/** DTW 距离超此值 → flag（章级偏离指纹，design §2.1 辅；归一化距离 0..2ish）。 */
export const DEFAULT_DTW_THRESHOLD = 0.5;
/** 读者 topology 持续上行场数触发阈值（连续 rise/peak ≥ 此值 → 持续高潮致麻木 flag，line 305-306）。 */
export const DEFAULT_CONSECUTIVE_RISE_THRESHOLD = 3;
/** 读者 topology 持续 flat 场数触发阈值（连续 flat ≥ 此值 → 情绪停滞 flag，line 305-306）。 */
export const DEFAULT_CONSECUTIVE_FLAT_THRESHOLD = 3;
/** topology 方向 delta 阈值（|arousal delta| < 此值视为 flat，纯代码机械阈值）。 */
export const FLAT_DELTA_THRESHOLD = 0.05;

// ── 输入 shape ──

/**
 * 角色卡（emotion-verify 消费的最小子集）。
 *
 * 结构上兼容 character asset card（assetCardSchema type='character'）——只读 id + personality.emotionElasticity。
 * 调用方传完整角色卡即可（structural typing）。避免 emotion-verify.ts 依赖完整 assetCardSchema（layering）。
 */
export interface CharacterCardForEmotion {
  id: string;
  personality?: {
    emotionElasticity?: number;
  } | null;
}

/**
 * payoff 事件（caller 从 promiseRegistry 算后传入，emotion-verify 不耦合 promise 内部）。
 *
 * caller（R2 emotion-verify-node）用 resolvePromiseFulfillment（creative-fields.ts:371）判每 Promise 兑现态：
 * - fulfilled（有有效 payoff beat）→ { fulfilled: true }。
 * - open + deadlineEpisodeId 已过（预期 payoff 未现）→ { fulfilled: false }。
 *
 * 范式判据：promise 兑现态派生（resolvePromiseFulfillment 纯函数）= 纯代码；setpoint 调整步长 = 纯代码。
 */
export interface PayoffEvent {
  fulfilled: boolean;
}

// ── 输出 sub-result shape ──

/** 读者层 topology 方向（rise 上升 / fall 下降 / flat 持平 / peak 局部峰，design §2.2）。 */
export const TOPOLOGY_DIRECTIONS = ['rise', 'fall', 'flat', 'peak'] as const;
export type TopologyDirection = (typeof TOPOLOGY_DIRECTIONS)[number];

/** 角色层 setpoint 衰减验证结果（单角色，design §2.1）。 */
export interface CharacterArcMetric {
  characterId: string;
  /** 检测到 plateau（peak 后无回落高原，违反享乐适应）→ 角色层 flag。 */
  plateauDetected: boolean;
  /** 峰值数量（arousal 新高次数，统计指纹）。 */
  peakCount: number;
  /** 序列长度（VAD present 的点数；0 = VAD 全缺，degraded）。 */
  pointCount: number;
  /** VAD 缺失（无法数值验证 setpoint 衰减）→ degraded=true。 */
  degraded: boolean;
  /** plateau 严重度（sustained 高原占比 0..1，统计指纹进 ledger）。 */
  plateauSeverity: number;
}

/** 读者层 topology 节奏验证结果（design §2.2）。 */
export interface ReaderTopologyMetric {
  /** 方向序列（per-scene，rise/fall/flat/peak）。 */
  directions: TopologyDirection[];
  /** 连续上行场数（rise|peak 连续计数最大值，含高潮 build-up）。 */
  maxConsecutiveRise: number;
  /** 连续 flat 场数（flat 连续计数最大值）。 */
  maxConsecutiveFlat: number;
  /** VAD 缺失（无 sceneVad → 无法数值判方向，退 flat + degraded=true）。 */
  degraded: boolean;
}

/** payoff 联动后的 per-character setpoint（AGENT-005 2.4，design §2.1，反哺下一轮 Director）。 */
export interface AdjustedSetpoint {
  characterId: string;
  setpoint: VadTriple;
  /** 是否相对原 setpoint 有变（payoff/catharsis 触发调整）。 */
  adjusted: boolean;
  /** 兑现 payoff 数。 */
  fulfilledCount: number;
  /** 未兑现 payoff 数。 */
  unfulfilledCount: number;
  /** 本章是否命中 catharsis_point（curve 级）。 */
  catharsisHit: boolean;
  /** 调整理由（供 ledger / Director 参考）。 */
  reason: string;
}

// ── emotionVerifyResultSchema（链段 artifact，mirror routeDecisionSchema 形态，非 creative field）──
//
// emotion_verify_result 是链段 artifact（mirror route_decision），流转 RunSnapshot 但**不进 project.yaml**（非 creative
// field）。flag + 统计指纹供 Director 重规划入口（7.3/8.1）+ ledger 可视化（Epic 3/10）+ 5.4 Reader-Audit 可选预筛。
// adjustedSetpoints 反哺下一轮 Director（作者「边写边调整后续情绪线」思维，写作思维原理 line 358-390）。

/** 两层偏离 flag（design §6：角色 setpoint 违反 / 读者 topology 违反 / DTW 距离超阈值）。 */
export const emotionVerifyFlagSchema = z.enum([
  'character_setpoint_violation',
  'reader_topology_violation',
  'dtw_distance_high',
]);
export type EmotionVerifyFlag = z.infer<typeof emotionVerifyFlagSchema>;

export const characterArcMetricSchema = z.object({
  characterId: z.string().min(1),
  plateauDetected: z.boolean(),
  peakCount: z.number().nonnegative(),
  pointCount: z.number().nonnegative(),
  degraded: z.boolean(),
  plateauSeverity: z.number().min(0).max(1),
});

export const readerTopologyMetricSchema = z.object({
  directions: z.array(z.enum(TOPOLOGY_DIRECTIONS)).default([]),
  maxConsecutiveRise: z.number().nonnegative(),
  maxConsecutiveFlat: z.number().nonnegative(),
  degraded: z.boolean(),
});

export const adjustedSetpointSchema = z.object({
  characterId: z.string().min(1),
  setpoint: vadTripleSchema,
  adjusted: z.boolean(),
  fulfilledCount: z.number().nonnegative(),
  unfulfilledCount: z.number().nonnegative(),
  catharsisHit: z.boolean(),
  reason: z.string(),
});

/**
 * emotion_verify_result artifact shape（Story 5.3 链段产物）。
 *
 * - flags：两层偏离 flag（角色/读者/DTW）。消费：Director 重规划入口（7.3/8.1）+ 5.4 可选预筛。
 * - characterArcs：per-character 角色层 setpoint 衰减验证（plateau 检测）。
 * - readerTopology：读者层 topology 节奏验证（持续上行/flat 检测）。
 * - chapterDtwDistance：章级 DTW 偏离指纹（辅，VAD 形状距离；actual patches 缺 → undefined）。
 * - adjustedSetpoints：payoff 联动后的 per-character setpoint（反哺下一轮 Director）。
 * - degraded：VAD 缺失 / 无 emotion_curve → 降级标注（不阻断链，mirror promise-emergence graceful）。
 * - degradationNote：降级原因（供 ledger / 调试）。
 */
export const emotionVerifyResultSchema = z.object({
  flags: z.array(emotionVerifyFlagSchema).default([]),
  characterArcs: z.array(characterArcMetricSchema).default([]),
  readerTopology: readerTopologyMetricSchema,
  chapterDtwDistance: z.number().finite().optional(),
  adjustedSetpoints: z.array(adjustedSetpointSchema).default([]),
  degraded: z.boolean(),
  degradationNote: z.string().optional(),
});
export type EmotionVerifyResult = z.infer<typeof emotionVerifyResultSchema>;

// ── 内部 helper ──

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** VAD 三维欧氏距离（DTW cost cell，纯函数）。 */
function vadDistance(a: VadTriple, b: VadTriple): number {
  const dv = a.v - b.v;
  const da = a.a - b.a;
  const dd = a.d - b.d;
  return Math.sqrt(dv * dv + da * da + dd * dd);
}

/** 从 unknown 守性 parse VadTriple（{v,a,d 均为有限 number}，否则 null）。 */
function parseVadTriple(vad: unknown): VadTriple | null {
  if (!vad || typeof vad !== 'object') return null;
  const v = vad as Record<string, unknown>;
  if (typeof v.v !== 'number' || typeof v.a !== 'number' || typeof v.d !== 'number') return null;
  // Number.isFinite 拒 NaN + Infinity（CR-005：vadTripleSchema 的 .min/.max NaN 比较返 false 可漏 NaN，此处兜底）。
  if (!Number.isFinite(v.v) || !Number.isFinite(v.a) || !Number.isFinite(v.d)) return null;
  return { v: v.v, a: v.a, d: v.d };
}

/**
 * 从 6.6 emotional patch value 守性抽 VAD（best-effort，design §3 双轨粒度差）。
 *
 * 6.6 emotional patch value 是自由 JSON（worldPatchSchema.value: z.unknown()），5.2 约定可带可选 vad 投影。
 * 常见形态：单值 `/mood="恐惧"`（无 VAD）/ `{objective:"恐惧", reader_perceived:"镇定", vad:{v,a,d}}`（分层 + VAD）/
 * `{vad:{v,a,d}}`（直挂 VAD）。本 helper 从常见形态 best-effort 抽 VAD；抽不到返 null（DTW 降级跳过）。
 *
 * 范式判据：抽 VAD = 纯代码结构查找（无语义）；「这个 mood 该映射什么 VAD」归提取器 LLM（5.2 已产）。
 */
function extractVadFromPatchValue(value: unknown): VadTriple | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  // 直挂 vad。
  const direct = parseVadTriple(obj.vad);
  if (direct) return direct;
  // 分层 {objective, reader_perceived}（认知/情绪轴分层约定，6.6）：objective.vad 优先（角色真实情绪）。
  if (obj.objective && typeof obj.objective === 'object') {
    const v = parseVadTriple((obj.objective as Record<string, unknown>).vad);
    if (v) return v;
  }
  if (obj.reader_perceived && typeof obj.reader_perceived === 'object') {
    const v = parseVadTriple((obj.reader_perceived as Record<string, unknown>).vad);
    if (v) return v;
  }
  return null;
}

// ── 纯函数（design §2，AGENT-005）──

/**
 * 从角色卡 personality.emotionElasticity 映射 τ + 初始 setpoint（性格基线 VAD，design §4）。
 *
 * τ 映射：
 * - elasticity=0（冻结/创伤）→ τ=0 **冻结特例**（CR-006：忠实 brainstorming #10 创伤情绪不减衰）。
 *   decayExpected 的 τ<=0 frozen guard 生效（返 peak 不衰减），情绪锁在 peak。design §4 原注「τ=TAU_MAX 近冻结」
 *   改为真冻结——TAU_MAX=10 仍非零衰减（伪冻结），且 TAU_MIN=0.1 clamp 致 frozen guard 不可达（死码）。
 * - 否则 `τ = TAU_MAX · (1 - elasticity)` clamp [TAU_MIN, TAU_MAX]：
 *   - elasticity=1（极弹性/来得快走得快）→ τ=TAU_MIN（极快衰减回基线）。
 *   - 中间（持久深沉）→ 中等 τ。
 *   clamp [TAU_MIN, TAU_MAX] 免无界（极弹性仍走快衰减）。
 *
 * 初始 setpoint = 性格基线 VAD。asset_cards 角色卡 schema 无基线 VAD 字段（设计：基线随 payoff 动态调整，
 * 首章默认中性 {0,0,0}）。setpoint 经 adjustSetpoint（payoff 联动）逐章演化，反哺下一轮 Director。
 *
 * @param characterCard  角色卡（读 id + personality.emotionElasticity）。
 * @param defaultTau     elasticity 缺失时的默认 τ（缺省 DEFAULT_TAU）。
 * @returns              { characterId, setpoint(初始中性), tau, elasticityMissing }。
 */
export function computeSetpoint(
  characterCard: CharacterCardForEmotion,
  defaultTau: number = DEFAULT_TAU,
): { characterId: string; setpoint: VadTriple; tau: number; elasticityMissing: boolean } {
  const raw = characterCard.personality?.emotionElasticity;
  let tau: number;
  let elasticityMissing = false;
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    tau = defaultTau;
    elasticityMissing = true;
  } else if (raw === 0) {
    // CR-006：冻结特例——elasticity=0 = 创伤冻结（brainstorming #10），τ=0 致 decayExpected frozen guard 生效。
    tau = 0;
  } else {
    // τ = TAU_MAX · (1 - elasticity)：elasticity 高 → τ 小（快衰减）/ 低 → τ 大（慢衰减）。
    // clamp [TAU_MIN, TAU_MAX]：TAU_MIN 免 τ=0 数学未定义（冻结由上面 raw===0 特例单独处理），TAU_MAX 免无界。
    tau = clamp(TAU_MAX * (1 - raw), TAU_MIN, TAU_MAX);
  }
  return {
    characterId: characterCard.id,
    setpoint: { v: 0, a: 0, d: 0 },
    tau,
    elasticityMissing,
  };
}

/**
 * AGENT-005 衰减公式：`emotion(t) = setpoint + (peak - setpoint) · e^{-t/τ}`（per VAD 轴，纯函数）。
 *
 * 高潮（peak）后情绪向性格基线 setpoint 指数衰减回归——高潮是峰非高原（brainstorming #1/#22/#10）。
 * - τ 大 = 慢衰减（持久深沉）/ τ 小 = 快衰减（极弹性）。
 * - τ <= 0 = 冻结 guard（design §2.1「τ=0 冻结」：创伤角色情绪不衰减，锁死在 peak，返 peak 不变）。
 * - t <= 0 = 尚未衰减（返 peak）。
 *
 * @param peak     t=0 时的峰值情绪（场内高潮 VAD）。
 * @param setpoint 性格基线 VAD（t→∞ 的回归目标）。
 * @param tau      衰减时间常数（computeSetpoint 产）。
 * @param t        距 peak 的时间（场数差 / storyTime 差）。
 * @returns        t 时刻的期望情绪 VAD。
 */
export function decayExpected(peak: VadTriple, setpoint: VadTriple, tau: number, t: number): VadTriple {
  // τ<=0 冻结 guard：创伤角色情绪锁死在 peak，不衰减（design §2.1）。
  if (tau <= 0) return { v: peak.v, a: peak.a, d: peak.d };
  // t<=0 → 返 peak（尚未衰减）。
  if (t <= 0) return { v: peak.v, a: peak.a, d: peak.d };
  const decay = Math.exp(-t / tau);
  return {
    v: setpoint.v + (peak.v - setpoint.v) * decay,
    a: setpoint.a + (peak.a - setpoint.a) * decay,
    d: setpoint.d + (peak.d - setpoint.d) * decay,
  };
}

/**
 * per-character VAD 序列衰减验证（角色层 setpoint 衰减，design §2.1）。纯函数。
 *
 * arousal（唤醒度）为情绪强度轴（VAD 中 arousal = 激活度，高潮 = 高 arousal）。算法：
 * - 跟踪 running peak（arousal 新高且高于 setpoint+容差 → 新峰，更新 peakArousal/peakIdx）。
 * - peak 后每点算期望衰减 `decayExpected(peak, setpoint, tau, dt)`，实际 arousal 超期望+容差 → plateauStep。
 * - plateauSeverity = plateauSteps / (pointCount-1)，≥ PLATEAU_SEVERITY_THRESHOLD → plateauDetected（flag）。
 *
 * **plateau = peak 后无回落高原**（违反享乐适应：高潮是峰非高原，brainstorming #1）。正常起伏（peak 后衰减）不 flag。
 *
 * @param vadSeries   per-character VAD 序列（按场序，从 emotion_curve.points[].characters[].vad 抽）。
 * @param setpoint    性格基线 VAD（computeSetpoint 产）。
 * @param tau         衰减时间常数（computeSetpoint 产）。
 * @param characterId 角色 id（透传结果，供聚合）。
 */
export function verifyCharacterArc(
  vadSeries: readonly VadTriple[],
  setpoint: VadTriple,
  tau: number,
  characterId: string,
): CharacterArcMetric {
  const pointCount = vadSeries.length;
  if (pointCount === 0) {
    return { characterId, plateauDetected: false, peakCount: 0, pointCount: 0, degraded: true, plateauSeverity: 0 };
  }
  let peakCount = 0;
  let plateauSteps = 0;
  let peakArousal = Number.NEGATIVE_INFINITY;
  let peakIdx = -1;
  for (let i = 0; i < vadSeries.length; i++) {
    const a = vadSeries[i].a;
    // CR-002: arousal 回落到 baseline 附近（setpoint+容差以下）→ reset peak cycle（开新周期）。
    // 防振荡弧（合理平静↔愤怒交替，如 [0.8,0.3,0.8,0.3]）误报 plateau：每次回落基线重置 running peak，
    // 下个新高重建 peak；持续高原（peak 后维持高位不回落）不受影响（arousal 不满足 reset 条件，仍累计 plateauSteps）。
    if (a < setpoint.a + PLATEAU_TOLERANCE) {
      peakIdx = -1;
      peakArousal = Number.NEGATIVE_INFINITY;
      continue;
    }
    // 新峰：arousal 高于 setpoint+容差 且高于当前 running peak（含首峰建立）。
    if (a > setpoint.a + PLATEAU_TOLERANCE && a > peakArousal) {
      peakCount++;
      peakArousal = a;
      peakIdx = i;
      continue;
    }
    // peak 后衰减期：实际 arousal 与期望衰减比对。
    if (peakIdx >= 0 && i > peakIdx) {
      const dt = i - peakIdx;
      const peak = vadSeries[peakIdx];
      const expected = decayExpected(peak, setpoint, tau, dt);
      if (a > expected.a + PLATEAU_TOLERANCE) {
        plateauSteps++; // 实际高于期望 → 未回落（plateau）
      }
    }
  }
  const plateauSeverity = pointCount > 1 ? plateauSteps / (pointCount - 1) : 0;
  const plateauDetected = plateauSteps > 0 && plateauSeverity >= PLATEAU_SEVERITY_THRESHOLD;
  return { characterId, plateauDetected, peakCount, pointCount, degraded: false, plateauSeverity };
}

/**
 * 读者层 topology 节奏验证（sceneMood 弧 rise/fall/flat/peak，design §2.2）。纯函数。
 *
 * 写作正当性：写作思维原理 line 305-306「情绪无法长时间保存，需持续阶段性动态操控」——**读者**对持续刺激麻木。
 * 作者画情绪线（line 358-390）必须有起落（rise/fall/peak 交替），持续上行无回落 = 持续高潮致麻木 → flag。
 *
 * 算法（arousal 为读者氛围强度轴，从 sceneVad.a 抽）：
 * - per-point 方向：rise（arousal 上升）/ fall（下降）/ flat（持平）/ peak（局部最大：上升后接下降，或末点上升）。
 * - 连续计数：maxConsecutiveRise（rise|peak 连续，含高潮 build-up）/ maxConsecutiveFlat。
 * - 违规检测由 caller 按阈值判（runEmotionVerify 用 DEFAULT_CONSECUTIVE_RISE/FLAT_THRESHOLD）。
 *
 * VAD 缺失（sceneVad null）→ 该点方向 flat + degraded=true（无数值判方向，退 flat；语义距离归 5.4 LLM）。
 *
 * @param sceneVadSeries per-scene 读者氛围 VAD 序列（从 emotion_curve.points[].sceneVad 抽，可能含 null）。
 */
export function verifyReaderTopology(
  sceneVadSeries: readonly (VadTriple | null | undefined)[],
): ReaderTopologyMetric {
  const n = sceneVadSeries.length;
  if (n === 0) {
    return { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: true };
  }
  const arousals: (number | null)[] = sceneVadSeries.map((v) =>
    v && typeof v.a === 'number' && !Number.isNaN(v.a) ? v.a : null,
  );
  const degraded = arousals.some((a) => a === null);
  const directions: TopologyDirection[] = [];
  for (let i = 0; i < n; i++) {
    const cur = arousals[i];
    if (i === 0 || cur === null || arousals[i - 1] === null) {
      // 首点 / 任一端 null → flat（无前继或缺失，无法判方向）。
      directions.push('flat');
      continue;
    }
    const prev = arousals[i - 1] as number;
    const delta = cur - prev;
    const next = i + 1 < n ? arousals[i + 1] : null;
    // peak：上升且后继下降（或末点上升 = 末点高潮）。局部最大。
    const isPeak = delta > FLAT_DELTA_THRESHOLD && (next === null || next < cur - FLAT_DELTA_THRESHOLD);
    if (isPeak) {
      directions.push('peak');
    } else if (delta > FLAT_DELTA_THRESHOLD) {
      directions.push('rise');
    } else if (delta < -FLAT_DELTA_THRESHOLD) {
      directions.push('fall');
    } else {
      directions.push('flat');
    }
  }
  // 连续计数：rise|peak 算上行（含高潮 build-up）/ flat 单算 / fall 断开。
  let maxConsecutiveRise = 0;
  let maxConsecutiveFlat = 0;
  let curRise = 0;
  let curFlat = 0;
  for (const d of directions) {
    if (d === 'rise' || d === 'peak') {
      curRise++;
      curFlat = 0;
      if (curRise > maxConsecutiveRise) maxConsecutiveRise = curRise;
    } else if (d === 'flat') {
      curFlat++;
      curRise = 0;
      if (curFlat > maxConsecutiveFlat) maxConsecutiveFlat = curFlat;
    } else {
      // fall 断开两组连续。
      curRise = 0;
      curFlat = 0;
    }
  }
  return { directions, maxConsecutiveRise, maxConsecutiveFlat, degraded };
}

/**
 * DTW（Dynamic Time Warping）不等长 VAD 序列对齐距离（章级偏离指纹，辅，design §2.1）。纯函数。
 *
 * 经典 DTW（O(n·m)）+ VAD 三维欧氏距离 cost。对齐目标轨 per-scene VAD 序列 vs 实际轨 per-chapter VAD 序列
 * （章切面 vs 多场点，不等长，design §3 双轨粒度差）。归一化（/max(n,m)）使距离与序列长度解耦，可比跨弧。
 *
 * 🔑 **统计指纹非语义裁判**（正交于 6.x「对比归语义」）：DTW 量 VAD 形状距离，不判「目标是否落地正文」
 * （归 Reader-Audit 5.4）。DTW 进 ledger 作可追踪统计指纹（07-23 design:258）。
 *
 * @param targetSeries 目标轨 VAD 序列（Director per-scene 产，per-character）。
 * @param actualSeries 实际轨 VAD 序列（6.6 emotional patches per-chapter，per-character）。
 * @returns            归一化 DTW 距离（≥0）；任一空 → 0（graceful，无可比）。
 */
export function dtwDistance(targetSeries: readonly VadTriple[], actualSeries: readonly VadTriple[]): number {
  const n = targetSeries.length;
  const m = actualSeries.length;
  if (n === 0 || m === 0) return 0;
  // dp[i][j] = align target[0..i-1] with actual[0..j-1] 的最小累计 cost。
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Number.POSITIVE_INFINITY));
  dp[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = vadDistance(targetSeries[i - 1], actualSeries[j - 1]);
      dp[i][j] = cost + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  // 归一化：/max(n,m) 解耦序列长度（跨弧可比）。
  return dp[n][m] / Math.max(n, m);
}

/**
 * payoff 联动 setpoint 动态调整（AGENT-005 2.4，design §2.1）。纯函数。
 *
 * 兑现 payoff → setpoint 上调（角色成长基线上移，写作思维原理 line 477 高潮提供超越日常的满足感）；
 * 未兑现 → 压低（创伤，line 67 失去目标与情绪付出）；catharsis_point 命中 → 上调（层层递进的释放点）。
 *
 * 调整幅度固定步长 PAYOFF_STEP（每兑现/catharsis 上调 / 每未兑现压低），valence+dominance 同向（成长=掌控感上移）、
 * arousal 轻微同向（0.5 系数，情绪基态微调），clamp VAD -1..1（vadTripleSchema 范围守）。
 *
 * 🔑 **纯代码机械调整**——不判「这个 payoff 该上调 setpoint 多少」（归 LLM Director 重规划，design §6），
 * 只做确定性步长叠加。范式判据：payoff 计数（resolvePromiseFulfillment 派生）+ 步长数学 = 纯代码（ADR-3）。
 *
 * @param characterId      角色 id（透传，供聚合）。
 * @param currentSetpoint  当前 setpoint VAD（computeSetpoint 产的初始中性 或 上轮 adjusted）。
 * @param payoffEvents     payoff 事件（caller 从 promiseRegistry 算：{fulfilled}）。
 * @param catharsisPoints  catharsis_points（from emotion_curve.catharsis_points，curve 级 string；>0 = 命中）。
 */
export function adjustSetpoint(
  characterId: string,
  currentSetpoint: VadTriple,
  payoffEvents: readonly PayoffEvent[],
  catharsisPoints: readonly string[],
): AdjustedSetpoint {
  const fulfilledCount = payoffEvents.filter((e) => e.fulfilled).length;
  const unfulfilledCount = payoffEvents.filter((e) => !e.fulfilled).length;
  const catharsisHit = catharsisPoints.length > 0;
  const upShift = fulfilledCount + (catharsisHit ? 1 : 0);
  const netShift = upShift - unfulfilledCount;
  if (netShift === 0) {
    return {
      characterId,
      setpoint: { v: currentSetpoint.v, a: currentSetpoint.a, d: currentSetpoint.d },
      adjusted: false,
      fulfilledCount,
      unfulfilledCount,
      catharsisHit,
      reason: '无 payoff/catharsis 净信号，setpoint 不变',
    };
  }
  const delta = PAYOFF_STEP * netShift;
  const setpoint: VadTriple = {
    v: clamp(currentSetpoint.v + delta, -1, 1),
    a: clamp(currentSetpoint.a + delta * 0.5, -1, 1),
    d: clamp(currentSetpoint.d + delta, -1, 1),
  };
  const reason =
    netShift > 0
      ? `setpoint 上调（成长基线上移）：兑现 ${fulfilledCount} + catharsis ${catharsisHit ? 1 : 0}`
      : `setpoint 压低（创伤）：未兑现 ${unfulfilledCount}`;
  return { characterId, setpoint, adjusted: true, fulfilledCount, unfulfilledCount, catharsisHit, reason };
}

/**
 * emotion_curve.points[] refId 去重（D-5.1-3，5.1 deferred owner=5.3）。纯函数。
 *
 * emotionPointSchema 无 refId 唯一约束，重复 refId 双计致 DTW/衰减序列重复点歧义。取**最新**（最后出现 =
 * Director 最新意图，design §7），保留**首次出现序**（场序稳定，避重排）。
 *
 * @param points emotion_curve.points[]（可能含重复 refId）。
 * @returns       deduped points（每 refId 保留最后出现内容，序 = 首次出现序）。
 */
export function dedupePointsByRefId(points: readonly EmotionPoint[]): EmotionPoint[] {
  const lastIdxByRefId = new Map<string, number>();
  points.forEach((p, i) => {
    lastIdxByRefId.set(p.refId, i);
  });
  const seen = new Set<string>();
  const result: EmotionPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const refId = points[i].refId;
    if (seen.has(refId)) continue;
    seen.add(refId);
    const lastIdx = lastIdxByRefId.get(refId);
    if (lastIdx === undefined) continue;
    result.push(points[lastIdx]);
  }
  return result;
}

// ── 序列抽取 helper（runEmotionVerify 内部用）──

/**
 * 从 emotion_curve 抽 per-character VAD 序列（按 point 序，每角色 vad 序列）。
 *
 * 每点 characters[].vad 是该角色在该场的情绪起点（vadEnd 是场内转变终点，另算不混入 inter-scene 弧）。
 * 角色在多点出现 → 序列按 point 序；某点缺该角色 → 跳过（不补 null，序列只含 present 场）。
 */
function buildCharacterVadSeriesFromCurve(curve: EmotionCurve): Map<string, VadTriple[]> {
  const series = new Map<string, VadTriple[]>();
  for (const point of curve.points) {
    // CR-003: point.characters 缺/坏（非数组，未经 schema parse 的运行时数据）→ graceful 跳过，不抛。
    if (!Array.isArray(point.characters)) continue;
    for (const c of point.characters) {
      // CR-005: parseVadTriple 守 NaN/非 finite/缺字段 → skip（mirror extractVadFromPatchValue 守卫）。
      const vad = parseVadTriple(c.vad);
      if (!vad) continue; // VAD 缺失/坏跳过（降级，5.1 范式：VAD 可选投影）
      const list = series.get(c.characterId);
      if (list) list.push(vad);
      else series.set(c.characterId, [vad]);
    }
  }
  return series;
}

/**
 * 从 6.6 emotional patches 抽 per-character VAD 序列（按 storyTime 序，每角色 vad 序列）。
 *
 * emotional patches（axis='emotional'）per-subject per-chapter storyTime。subjectId=角色 id。value 经
 * extractVadFromPatchValue best-effort 抽 VAD；抽不到跳过（VAD 缺失，DTW 降级）。
 */
function buildCharacterVadSeriesFromPatches(patches: readonly WorldPatch[]): Map<string, VadTriple[]> {
  const emotional = patches
    .filter((p) => p.axis === 'emotional')
    .slice()
    .sort((a, b) => a.storyTime - b.storyTime);
  const series = new Map<string, VadTriple[]>();
  for (const p of emotional) {
    const vad = extractVadFromPatchValue(p.value);
    if (!vad || !p.subjectId) continue;
    const list = series.get(p.subjectId);
    if (list) list.push(vad);
    else series.set(p.subjectId, [vad]);
  }
  return series;
}

/** 从 emotion_curve 抽 sceneVad 序列（per-point，sceneVad 缺 → null）。 */
function buildSceneVadSeries(curve: EmotionCurve): (VadTriple | null)[] {
  return curve.points.map((p) => (p.sceneVad ?? null));
}

// ── aggregator：runEmotionVerify（design §1-§3，emotion-verify-node 调）──

/** runEmotionVerify 可选项（阈值 + 默认 τ，纯代码机械参数）。 */
export interface RunEmotionVerifyOptions {
  /** DTW 距离超阈值 → flag（章级偏离指纹）。default DEFAULT_DTW_THRESHOLD。 */
  dtwThreshold?: number;
  /** 持续上行场数阈值（≥ → reader_topology_violation flag）。default DEFAULT_CONSECUTIVE_RISE_THRESHOLD。 */
  consecutiveRiseThreshold?: number;
  /** 持续 flat 场数阈值（≥ → reader_topology_violation flag）。default DEFAULT_CONSECUTIVE_FLAT_THRESHOLD。 */
  consecutiveFlatThreshold?: number;
  /** elasticity 缺失时的默认 τ。default DEFAULT_TAU。 */
  defaultTau?: number;
}

/** runEmotionVerify 输入（emotion-verify-node 从 artifact + asset_cards 组装）。 */
export interface RunEmotionVerifyInput {
  /** 目标轨 emotion_curve（Director 前向产，5.2）。undefined/null/空 → degraded result。 */
  emotionCurve?: EmotionCurve | null;
  /** 实际轨 emotional patches（6.6 写后抽取，供 DTW 章级指纹辅）。undefined → 跳过 DTW。 */
  emotionalPatches?: readonly WorldPatch[] | null;
  /** payoff 事件（caller 从 promiseRegistry 经 resolvePromiseFulfillment 算后传入，供 setpoint 联动）。 */
  payoffEvents?: readonly PayoffEvent[] | null;
  /** 角色卡（personality.emotionElasticity → τ；缺失用 defaultTau）。 */
  characterCards?: readonly CharacterCardForEmotion[] | null;
}

/**
 * 组合上述纯函数，产 EmotionVerifyResult（emotion-verify-node 调，design §1-§3）。纯函数 + graceful。
 *
 * 流程：
 * 1. emotion_curve 缺/空 → degraded result（flags=[], characterArcs=[], readerTopology 空, adjustedSetpoints=[]）。
 * 2. dedupePointsByRefId（D-5.1-3 守门，design §7）。
 * 3. 角色层：per-character VAD 序列 + computeSetpoint（角色卡 → τ/setpoint）→ verifyCharacterArc → characterArcs。
 * 4. 读者层：sceneVad 序列 → verifyReaderTopology → readerTopology。
 * 5. DTW（辅，actual patches present）：per-character target vs actual VAD 序列 DTW，跨角色均 → chapterDtwDistance。
 * 6. setpoint 联动：per-character adjustSetpoint（payoff + catharsis from curve.catharsis_points）→ adjustedSetpoints。
 * 7. flags 聚合：任角色 plateau → character_setpoint_violation / topology 违规 → reader_topology_violation /
 *    DTW > 阈值 → dtw_distance_high。
 *
 * graceful：emotion_curve 空 / VAD 全缺 / elasticity 缺 / patches 缺 → 降级（degraded=true + note），不崩、不阻断。
 *
 * 🔑 范式判据：全确定性数学（衰减/topology/DTW/payoff 步长），无 LLM/无 db/无副作用。不裁判语义（归 Director/Reader-Audit）。
 *
 * @param input    emotion_curve + emotional patches + payoff + 角色卡。
 * @param options  阈值 + 默认 τ（纯代码机械参数）。
 * @returns        EmotionVerifyResult（emotion_verify_result artifact shape）。
 */
export function runEmotionVerify(
  input: RunEmotionVerifyInput,
  options?: RunEmotionVerifyOptions,
): EmotionVerifyResult {
  const dtwThreshold = options?.dtwThreshold ?? DEFAULT_DTW_THRESHOLD;
  const consecutiveRiseThreshold = options?.consecutiveRiseThreshold ?? DEFAULT_CONSECUTIVE_RISE_THRESHOLD;
  const consecutiveFlatThreshold = options?.consecutiveFlatThreshold ?? DEFAULT_CONSECUTIVE_FLAT_THRESHOLD;
  const defaultTau = options?.defaultTau ?? DEFAULT_TAU;

  const curve = input.emotionCurve;
  if (!curve || curve.points.length === 0) {
    return {
      flags: [],
      characterArcs: [],
      readerTopology: { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: true },
      adjustedSetpoints: [],
      degraded: true,
      degradationNote: 'emotion_curve 缺失或 points 为空',
    };
  }

  // D-5.1-3 守门：refId dedupe（取最新 Director 意图，保场序稳定）。
  const dedupedPoints = dedupePointsByRefId(curve.points);
  const dedupedCurve: EmotionCurve = { ...curve, points: dedupedPoints };

  // 角色卡 → tau/setpoint 表（缺失角色用 defaultTau）。
  const cardMap = new Map<string, CharacterCardForEmotion>();
  for (const card of input.characterCards ?? []) cardMap.set(card.id, card);

  // ── 角色层 setpoint 衰减验证 ──
  const charSeries = buildCharacterVadSeriesFromCurve(dedupedCurve);
  const characterArcs: CharacterArcMetric[] = [];
  const setpointByChar = new Map<string, { setpoint: VadTriple; tau: number }>();
  for (const [characterId, series] of charSeries) {
    const card = cardMap.get(characterId);
    const { setpoint, tau } = computeSetpoint(card ?? { id: characterId }, defaultTau);
    setpointByChar.set(characterId, { setpoint, tau });
    characterArcs.push(verifyCharacterArc(series, setpoint, tau, characterId));
  }

  // ── 读者层 topology 节奏验证 ──
  const sceneVadSeries = buildSceneVadSeries(dedupedCurve);
  const readerTopology = verifyReaderTopology(sceneVadSeries);

  // ── DTW 章级偏离指纹（辅，actual patches present 时）──
  let chapterDtwDistance: number | undefined;
  let dtwFlag = false;
  if (input.emotionalPatches && input.emotionalPatches.length > 0) {
    const actualSeries = buildCharacterVadSeriesFromPatches(input.emotionalPatches);
    if (actualSeries.size > 0 && charSeries.size > 0) {
      let sum = 0;
      let count = 0;
      for (const [characterId, target] of charSeries) {
        const actual = actualSeries.get(characterId);
        if (!actual || actual.length === 0) continue;
        sum += dtwDistance(target, actual);
        count++;
      }
      if (count > 0) {
        chapterDtwDistance = sum / count;
        dtwFlag = chapterDtwDistance > dtwThreshold;
      }
    }
  }

  // ── payoff 联动 setpoint 调整 ──
  const catharsisPoints = curve.catharsis_points ?? [];
  const payoffEvents = input.payoffEvents ?? [];
  const adjustedSetpoints: AdjustedSetpoint[] = [];
  // 角色层出现过的角色 + 有角色卡但未出现的角色都算 setpoint（payoff 是章级信号，作用于已知角色）。
  // 简化：只调整 emotion_curve 出现过的角色（有目标弧的角色），payoff/catharsis 作章级信号统一应用。
  for (const [characterId, { setpoint }] of setpointByChar) {
    adjustedSetpoints.push(adjustSetpoint(characterId, setpoint, payoffEvents, catharsisPoints));
  }

  // ── flags 聚合 ──
  const flags: EmotionVerifyFlag[] = [];
  if (characterArcs.some((m) => m.plateauDetected)) flags.push('character_setpoint_violation');
  // CR-001: readerTopology.degraded 时方向全退 flat（sceneVad 缺无数值判方向），maxConsecutiveFlat 假高 → 守卫抑制。
  // 5.1 VAD 可选致全 null sceneVad 常见，不守卫则几乎每章误报 reader_topology_violation。
  if (
    !readerTopology.degraded &&
    (readerTopology.maxConsecutiveRise >= consecutiveRiseThreshold ||
      readerTopology.maxConsecutiveFlat >= consecutiveFlatThreshold)
  ) {
    flags.push('reader_topology_violation');
  }
  if (dtwFlag) flags.push('dtw_distance_high');

  // 降级标注：VAD 全缺（角色/读者都 degraded）/ patches 缺（DTW 跳过，非降级仅无辅指纹）。
  const allCharDegraded = characterArcs.length === 0 || characterArcs.every((m) => m.degraded);
  // CR-004: OR 逻辑——任一层降级则整体 degraded=true（消费者检查 degraded 知「部分不可信」+ note 说明哪层）。
  // 原 AND 逻辑致字符 VAD 全缺 + sceneVad 存在 → degraded=false + note='无 per-character VAD' 自相矛盾。
  const degraded = allCharDegraded || readerTopology.degraded;
  const degradationNotes: string[] = [];
  if (characterArcs.length === 0) degradationNotes.push('无 per-character VAD（emotion_curve 无 characters[].vad）');
  else if (allCharDegraded) degradationNotes.push('所有角色 VAD 缺失（仅 topology 方向可用或全缺）');
  if (readerTopology.degraded) degradationNotes.push('部分 sceneVad 缺失（topology 退 flat）');

  const result: EmotionVerifyResult = {
    flags,
    characterArcs,
    readerTopology,
    adjustedSetpoints,
    degraded,
  };
  if (chapterDtwDistance !== undefined) result.chapterDtwDistance = chapterDtwDistance;
  if (degradationNotes.length > 0) result.degradationNote = degradationNotes.join('；');
  return result;
}
