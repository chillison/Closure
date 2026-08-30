/**
 * World state panel read API shell (dogfood R2 #92，task 08-29-world-state-panel S3)。
 * Mirrors `shared/api/kbIndex.ts` — every IPC call goes through `window.orisonDesktop`
 * here, never directly from a component or slice (module-structure invariant: IPC 走
 * shared/api）。
 *
 * 三读通道（契约单源 packages/shared-contracts/src/contracts/world-panel.ts）：
 * - `fetchWorldOverview`：L1 世界总览（主体轻量投影 + storyTime 场锚点聚合行）。
 * - `fetchWorldSliceDetail`：L2 时点详情（该 storyTime 全部变更跨主体分组）。
 * - `fetchWorldSubjectDetail`：L3 主体详情（仅全史 patches——契约 CR #4 后通道不收 as-of
 *   截断点，切线回放的快照折叠/issues 全部 UI 本地重算）。
 *
 * 桥缺失显式报错（#5+#102+#210，CR 批）：桥整体缺失或旧 preload 无 world 面时 throw
 * `Error('desktop bridge unavailable')`——**绝不** `?? null` 伪装成「成功但空」（假空态/
 * 永久骨架）。slice catch 落 error 态 → 面板错误卡 + 重试。错误消息稳定，勿改文案
 * （测试断言全等）。
 *
 * 事件订阅面（onWorldChanged）不走本文件——slice 的 subscribeWorldEvents 直接挂桥
 * （mirror updateSlice.subscribeUpdateEvents 形态），保持 hook-free 的模块级订阅。
 */
import type { WorldOverview, WorldSliceDetail, WorldSubjectDetail } from '@orison/shared-contracts';

/** Read the preload bridge at call time (not module load) so tests that install
 *  a fake `window.orisonDesktop` per-case see it. Mirrors how slices access it. */
function api() {
  return window.orisonDesktop;
}

export async function fetchWorldOverview(projectId: string): Promise<WorldOverview> {
  const bridge = api();
  if (!bridge?.worldOverview) throw new Error('desktop bridge unavailable');
  return bridge.worldOverview({ projectId });
}

export async function fetchWorldSliceDetail(projectId: string, t: number): Promise<WorldSliceDetail> {
  const bridge = api();
  if (!bridge?.worldSliceDetail) throw new Error('desktop bridge unavailable');
  return bridge.worldSliceDetail({ projectId, t });
}

/**
 * L3 主体详情（**仅全史 patches**——契约 CR #4：as-of 切线的快照折叠/issues 是 UI 本地
 * 纯函数重算，通道不收 at 截断点）。 */
export async function fetchWorldSubjectDetail(
  projectId: string,
  subjectId: string,
): Promise<WorldSubjectDetail> {
  const bridge = api();
  if (!bridge?.worldSubjectDetail) throw new Error('desktop bridge unavailable');
  return bridge.worldSubjectDetail({ projectId, subjectId });
}
