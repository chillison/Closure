// ── Story 8.3 S6：规模判定闸（design §6 数据驱动判定框架，纯函数）──
//
// F 块（cognition/presence 投影 + query_world_slice 载波）两项规模 defer 的判定逻辑单源：
// 压测 suite（retrievalScale.test.ts）灌满配 fixture 出实测 → 本闸按阈值出结论 →
// - 双指标达标 → 维持 defer（实测值记 deferred-work 收档）；
// - 投影超阈值 → S7 条件站实施 per-axis checkpoint（cognitive-only / presence-only 子集折叠基）；
// - 载波超阈值 → S7 条件站实施 storyTime 窗收窄（brief-compiler 按 scene 窗 / Reader-Audit 按本章 subject）。
//
// 阈值出处（design §6 判定框架，勿随手改——改阈值 = 改 S7 触发条件，须同步 design）：
// - 投影 fold P95 > 20ms（12 场/章 → 章编译投影段 > 240ms 可感知）；
// - 载波 payload > 5MB 或全量取数 > 100ms。
//
// 范式判据（ADR-3）：阈值比较 + 结论拼装 = 纯代码确定性计算，零语义判断。

/** 判定阈值（design §6）。JSDoc 数值即权威——与 design.md §6 同步变更。 */
export const SCALE_GATE_THRESHOLDS = {
  /** cognition/presence 投影（取数 + fold 合计）P95 上限（ms），超过 → per-axis checkpoint。 */
  projectionP95Ms: 20,
  /** query_world_slice 等价全量载波 payload 上限（字节），超过 → storyTime 窗收窄。 */
  payloadBytes: 5 * 1024 * 1024,
  /** 全量取数耗时上限（ms），超过 → storyTime 窗收窄。 */
  fullFetchMs: 100,
} as const;

/** F 块实测输入（retrievalScale suite 的观测量）。 */
export interface RetrievalScaleObservation {
  /** cognition 投影（cognitive 轴取数 + buildCognitionSnapshot fold）P95（ms）。 */
  cognitionP95Ms: number;
  /** presence 投影（双轴取数 + buildPresenceSignal fold）P95（ms）。 */
  presenceP95Ms: number;
  /** 全量 patches 载波字节数（fetchWorldPatchesViaTool 等价 IPC payload，UTF-8 JSON）。 */
  payloadBytes: number;
  /** 全量取数耗时（ms）。 */
  fullFetchMs: number;
}

/** 判定结论（S7 条件站的触发依据；maintainDefer = 两指标均达标）。 */
export interface RetrievalScaleVerdict {
  checkpointNeeded: boolean;
  windowNarrowingNeeded: boolean;
  /** 双指标均达标 → true（deferred-work 记实测值收档）。 */
  maintainDefer: boolean;
  /** 逐条结论（人话，console 记档用）。 */
  reasons: string[];
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * 按阈值判定 F 块规模 defer 的处置（纯函数，无 IO）。
 *
 * 投影与载波是两个独立指标：投影超阈值只触发 checkpoint，载波超阈值只触发窗收窄；
 * 任一触发即 `maintainDefer = false`（S7 条件站按需做其中一项或两项）。
 */
export function evaluateRetrievalScaleGate(
  obs: RetrievalScaleObservation,
): RetrievalScaleVerdict {
  const reasons: string[] = [];

  const projectionOver =
    obs.cognitionP95Ms > SCALE_GATE_THRESHOLDS.projectionP95Ms ||
    obs.presenceP95Ms > SCALE_GATE_THRESHOLDS.projectionP95Ms;
  if (obs.cognitionP95Ms > SCALE_GATE_THRESHOLDS.projectionP95Ms) {
    reasons.push(
      `cognition 投影 P95 ${fmt(obs.cognitionP95Ms)}ms > ${SCALE_GATE_THRESHOLDS.projectionP95Ms}ms → per-axis checkpoint（S7）`,
    );
  }
  if (obs.presenceP95Ms > SCALE_GATE_THRESHOLDS.projectionP95Ms) {
    reasons.push(
      `presence 投影 P95 ${fmt(obs.presenceP95Ms)}ms > ${SCALE_GATE_THRESHOLDS.projectionP95Ms}ms → per-axis checkpoint（S7）`,
    );
  }
  if (!projectionOver) {
    reasons.push(
      `投影 P95 cognition ${fmt(obs.cognitionP95Ms)}ms / presence ${fmt(obs.presenceP95Ms)}ms ≤ ${SCALE_GATE_THRESHOLDS.projectionP95Ms}ms → checkpoint 不触发`,
    );
  }

  const payloadOver = obs.payloadBytes > SCALE_GATE_THRESHOLDS.payloadBytes;
  const fetchOver = obs.fullFetchMs > SCALE_GATE_THRESHOLDS.fullFetchMs;
  if (payloadOver) {
    reasons.push(
      `载波 payload ${fmt(obs.payloadBytes / 1024 / 1024)}MB > ${fmt(SCALE_GATE_THRESHOLDS.payloadBytes / 1024 / 1024)}MB → storyTime 窗收窄（S7）`,
    );
  }
  if (fetchOver) {
    reasons.push(
      `全量取数 ${fmt(obs.fullFetchMs)}ms > ${SCALE_GATE_THRESHOLDS.fullFetchMs}ms → storyTime 窗收窄（S7）`,
    );
  }
  if (!payloadOver && !fetchOver) {
    reasons.push(
      `载波 payload ${fmt(obs.payloadBytes / 1024 / 1024)}MB / 取数 ${fmt(obs.fullFetchMs)}ms ≤ 阈值 → 窗收窄不触发`,
    );
  }

  const checkpointNeeded = projectionOver;
  const windowNarrowingNeeded = payloadOver || fetchOver;
  return {
    checkpointNeeded,
    windowNarrowingNeeded,
    maintainDefer: !checkpointNeeded && !windowNarrowingNeeded,
    reasons,
  };
}
