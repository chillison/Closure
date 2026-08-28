/**
 * CR-T2-005（dogfood T2 patch 批，2026-08-25）——embedding 重建扫在途闸。
 *
 * 问题：启动 reconcile 的后台扫（`reindexAllForChangedModel`，可能数分钟）与用户侧
 * 手动重建（`closure:rebuild-story-index`）/ save-model 触发的迁移扫之间无互斥——两路
 * 并发重嵌会竞争 `entry_vec` 的 DROP+重建（全局事件），错峰写入对方刚重建的表。
 *
 * 机制：模块级布尔旗标 + RAII 式 `runWithEmbeddingSweepGate(fn)`（set → await → finally
 * clear）。互斥语义取「拒绝/跳过 + 友好提示」而非「排队等待」：
 * - 手动重建 → `{ ok:false, error:'sweep-in-progress' }`（模式 A，UI toast 提示稍后重试）；
 * - save-model 触发 → 跳过本次（warn 留痕；下次启动 reconcile 以 designation 比对兜底，
 *   确定性自愈，比排队更简单且不占内存队列）。
 * - 启动 reconcile 扫与 save-model 迁移扫自身都经 `runWithEmbeddingSweepGate` 包裹——
 *   任意来源的扫在途时旗标都为真。
 *
 * 为何独立小模块（而非放 embeddingIndexReconcile / configIpc）：设置方（reconcile +
 * configIpc save-model）与查方（closureIndexIpc status/rebuild）横跨三个模块；
 * embeddingIndexReconcile 已 import configIpc（reindexAllForChangedModel），configIpc 反向
 * import 它会造**新环**（configIpc ↔ modelGatewayIpc 存量环之外再加一直边，depcruise
 * no-circular）。本模块零 import，任何方向引它都不成环。
 *
 * 范式判据 (ADR-3)：互斥记账 = 纯机械，零语义。
 */

let sweepInflight = false;

/** CR-T2-014：重建扫是否在途（`closure:index-status` 并入「重建中」面，防降级横幅闪）。 */
export function isEmbeddingSweepInflight(): boolean {
  return sweepInflight;
}

/**
 * 在扫闸内执行 fn：置旗 → await → finally 清旗（fn 抛错也清，不卡死后续启动）。
 * 同步返回 fn 的结果。不做排队/合并——重复触发由调用方按上述「拒绝/跳过」策略处理。
 */
export async function runWithEmbeddingSweepGate<T>(fn: () => Promise<T>): Promise<T> {
  sweepInflight = true;
  try {
    return await fn();
  } finally {
    sweepInflight = false;
  }
}
