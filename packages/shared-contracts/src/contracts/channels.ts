// ── dogfood R2 #99：推送通道名单源叶子模块（zod-free）──
//
// 背景：preload（sandbox:true）只能 require('electron')——任何值导入把 zod
// （其 bundle 顶层 require("node:crypto")）经 contracts barrel 拖进 preload
// bundle 都会让 preload 整体崩溃、window.orisonDesktop 消失、全 app IPC 静默
// 哑掉（08-30 #92 commit 实录，08-28 前的常驻老窗口不重跑 preload 故未炸）。
// 因此 IPC 推送通道名常量放在本**零依赖叶子模块**：preload 深导入
// `@orison/shared-contracts/contracts/channels` 只内联本文件，不触 zod。
// 守卫：shell 测试 preload-sandbox-imports 对 preload 值导入闭包静态断言。
//
// ⚠️ 本文件禁 import 任何东西（含 type-only 以外的相对模块）——加了就会
// 重新打开 sandbox 崩溃面。shell 侧消费面仍走 barrel（world-panel re-export）。
export const WORLD_CHANGED_CHANNEL = 'world:changed';
