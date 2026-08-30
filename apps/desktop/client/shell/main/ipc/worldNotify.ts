/**
 * dogfood R2 #92：`world:changed` 推送事件发射器（shell → renderer，main webContents.send）。
 *
 * world 数据三写入口（write_world_events / amend_world_state 落表 handler + resetWorldStateForBackfill）
 * 在**事务提交后**（insertWorldSlice / resetWorldState 同步单事务，返回即已落）best-effort 广播——
 * 面板据此事件驱动重拉（design「实时数据交互」：L1 恒重拉 / L2 当前时点受影响重拉 / L3 选中主体
 * ∈ subjectIds 重拉，交互态不动）。
 *
 * 广播形态 mirror ipc/toolNotify.ts（BrowserWindow.getAllWindows 全窗口遍历）：发射点在
 * toolHandlers / db 层，无 getMainWindow 注入面；广播不需要窗口懒解析（窗口重建自动覆盖）。
 * db 层（worldStateBackfill）import 本模块 mirror 既有跨层薄工具先例（fs/projectWatcher →
 * ipc/toolNotify、db/assetCardsWatcher → ipc/pathGuard）——禁的是 db → ipc/toolHandlers 业务
 * 倒置（CR-8 定谳），薄推送工具不在此列。
 *
 * **NEVER throws（best-effort 契约红线）**：send 失败只 warn 不抛、绝不阻写路径；连 logger
 * 本身不可用（测试 mock 缺面 / 启动早期）也吞掉——任何环境下不得向上传播（写事务已提交，
 * 通知失败不能反过来把写报成失败）。
 */
import { BrowserWindow } from 'electron';
import { WORLD_CHANGED_CHANNEL, type WorldChangedEvent } from '@orison/shared-contracts';
import { getLogger } from '../logger';

/**
 * 推送通道名（单源常量在 shared-contracts contracts/world-panel.ts `WORLD_CHANGED_CHANNEL`，
 * BMad CR #8——发射侧与 preload 订阅面共同引用，本文件不再自带定义）。**不在** desktopIpcSchema
 * enum——push 事件与 update:event / tool:event / agent:stream-event 同例：enum 只收 invoke 通道。
 */

/** 广播失败记 warn（自身再包一层 try——logger 不可用时吞掉，best-effort 契约）。 */
function logWorldChangedFailure(err: unknown, event: WorldChangedEvent): void {
  try {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), event },
      'world:changed broadcast failed - continuing (best-effort, write already committed)',
    );
  } catch {
    // logger 不可用（mock 缺面 / 启动早期）——绝不向上抛。
  }
}

/**
 * 向全部窗口广播 world 数据变更。NEVER throws。
 *
 * per-window try/catch：单窗 send 失败只记 warn，其余窗口照发（一个死窗口不拖累其他订阅者）。
 */
export function sendWorldChanged(event: WorldChangedEvent): void {
  let windows: BrowserWindow[];
  try {
    windows = BrowserWindow.getAllWindows();
  } catch (err) {
    logWorldChangedFailure(err, event);
    return;
  }
  for (const win of windows) {
    try {
      win.webContents.send(WORLD_CHANGED_CHANNEL, event);
    } catch (err) {
      logWorldChangedFailure(err, event);
    }
  }
}
