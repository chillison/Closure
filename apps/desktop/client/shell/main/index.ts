import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { setPromptsBaseDir } from '@orison/desktop-agent';
import { INTERFACE_SCALE_DEFAULT } from '@orison/shared-contracts';
import { getLogger, getLogsDirPath, installGlobalErrorHandlers } from './logger';
import { registerProjectIpc } from './ipc/projectIpc';
import { initProjectsRoot } from './ipc/pathGuard';
import { loadWindowState, trackWindowState } from './windowState';
import { registerWindowIpc } from './ipc/windowIpc';
import { registerConfigIpc, readUserPreferencesFromDisk, applyResearchProxyFromDisk } from './ipc/configIpc';
import { registerFieldSyncIpc } from './ipc/fieldSyncIpc';
import { notifyUI } from './ipc/toolNotify';
import { subscribeProjectSaved } from '@orison/desktop-local-bff';
import { registerModelProviderIpc } from './ipc/modelProviderIpc';
import { registerModelGatewayIpc } from './ipc/modelGatewayIpc';
import { registerStorySyncIpc } from './ipc/storySyncIpc';
import { registerTaskIpc } from './ipc/taskIpc';
import { registerAssetIpc } from './ipc/assetIpc';
import { registerLogIpc } from './ipc/logIpc';
import { registerUpdateIpc, checkForUpdateOnStartup } from './ipc/updateIpc';
import { registerGitIpc } from './ipc/gitIpc';
import { registerAgentIpc } from './ipc/agentIpc';
import { registerClosureCraftIpc } from './ipc/closureCraftIpc';
import { registerClosureIndexIpc } from './ipc/closureIndexIpc';
import { registerClosureChainIpc } from './ipc/closureChainIpc';
import { registerSettingMdIpc } from './ipc/settingMdIpc';
import { registerAuthorProfileIpc } from './ipc/authorProfileIpc';
import { registerResearchConfigIpc } from './ipc/researchConfigIpc';
import { registerLintIpc } from './ipc/lintIpc';
import { registerWorldIpc } from './ipc/worldIpc';
import { fetchOrisonFile } from './orisonFileProtocol';
import { closeDb, getDb } from './db';
import { scanAndReindexCraftKb } from './db/closureCraftIndexer';
import { reconcileEmbeddingIndexOnStartup } from './db/embeddingIndexReconcile';
import { startCraftKbWatcher, stopCraftKbWatcher } from './db/craftKbWatcher';
import { stopAssetCardsWatcher } from './db/assetCardsWatcher';
import { stopSettingMdWatcher } from './db/settingMdWatcher';
import { stopChapterChunkWatcher } from './db/chapterChunkWatcher';

/* ── CSP ── */

/**
 * dev 口径单源（BMad CR 组4：isDev/isPackaged 双轨并存收敛）：一切「dev 才…」的
 * 判定一律用 `!app.isPackaged`。与 ELECTRON_RENDERER_URL 的关系——后者只在 vite dev
 * 启动器下被注入、指向 renderer dev server，它是 **loadURL 的数据来源**，不是 dev/
 * 打包判据：打包产物即使被注入该 env 也按打包态处理（CSP 不放开 unsafe-eval、
 * localhost 不进导航白名单），而 dev 实例直接加载 file:// 时仍是 dev（CDP 调试口照开）。
 * 下文 renderer 加载分支仍读该 env——那是取 URL 值，不是判态。
 */
const isDev = !app.isPackaged;

/**
 * dev-only CDP 调试口：e2e/dogfood 的附着式自检约定——Claude 经
 * playwright connectOverCDP 附着「用户正在看的这个 dev 实例」实时截图/驱动
 * 找 bug（工具侧 = apps/desktop/e2e/src/attach.ts）。打包产物不开
 * （isPackaged 守卫，见上方 isDev 单源）。ORISON_CDP_PORT 数值校验：仅接受十进制
 * 数字串且落在 1–65535；非法值 warn + 回落默认 9222（附着面失联必须可诊断，不静默）。
 * '0' 仍是显式关闭语义（合法通道）。
 */
if (!app.isPackaged) {
  const CDP_PORT_DEFAULT = '9222';
  const rawPort = process.env.ORISON_CDP_PORT;
  let cdpPort = CDP_PORT_DEFAULT;
  if (rawPort === undefined || rawPort === '') {
    // 未设 = 默认口（旧行为保持）。
  } else if (rawPort === '0') {
    cdpPort = ''; // 显式关闭
  } else if (/^\d+$/.test(rawPort)) {
    const portNum = Number(rawPort);
    if (portNum >= 1 && portNum <= 65535) {
      cdpPort = String(portNum); // 规范化前导零等写法
    } else {
      getLogger().warn(
        { value: rawPort },
        `ORISON_CDP_PORT out of range (1-65535) — falling back to ${CDP_PORT_DEFAULT}`,
      );
    }
  } else {
    getLogger().warn(
      { value: rawPort },
      `ORISON_CDP_PORT must be a decimal number (1-65535, or "0" to disable) — falling back to ${CDP_PORT_DEFAULT}`,
    );
  }
  if (cdpPort !== '') {
    app.commandLine.appendSwitch('remote-debugging-port', cdpPort);
  }
}

// App icon (Windows/Linux runtime window + taskbar). macOS uses the bundled
// .icns from electron-builder, so a runtime icon is not needed there.
// `resources/` is copied next to the app via electron-builder `files`, and in
// dev it sits two levels up from dist/main. Prefer the .ico on Windows for
// crisp taskbar rendering, the .png elsewhere.
function resolveAppIcon(): string {
  const base = path.join(__dirname, '../../resources');
  return process.platform === 'win32'
    ? path.join(base, 'icon.ico')
    : path.join(base, 'icon.png');
}

const CSP = [
  "default-src 'self'",
  isDev ? "script-src 'self' 'unsafe-eval'" : "script-src 'self'",
  // Fonts are bundled locally now (Material Symbols woff2 + system CJK
  // fallbacks), so no Google Fonts CDN is whitelisted. 'self' covers the
  // fingerprinted woff2 emitted into the build; data: kept for inlined assets.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: orison-file: https:",
  `connect-src 'self' ${isDev ? 'ws://localhost:* https:' : 'https:'}`,
].join('; ');

// The single live window. IPC handlers that need a window resolve it lazily via
// `getMainWindow()` so they can be registered ONCE for the app lifetime — a
// recreated window (macOS dock re-activate) is picked up automatically. Calling
// ipcMain.handle twice for the same channel throws, which previously crashed the
// app when a second window was created.
let mainWindow: BrowserWindow | null = null;
const getMainWindow = (): BrowserWindow | null => mainWindow;

let cspInstalled = false;
let ipcRegistered = false;

/**
 * dogfood #48：探测 agent 契约 prompts 真实基址并注入（setPromptsBaseDir）。
 * 候选：打包 resources/prompts（extraResources——release prep 待建，craft KB 同款债）；
 * dev 仓库布局 shell → ../../agent/prompts。全不中 → warn（yaml 契约将 degrade，
 * researcher/写章链节点拿到空 system+brief）。
 */
function wireAgentPromptsDir(): void {
  const log = getLogger();
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'prompts') : null,
    path.resolve(app.getAppPath(), '..', '..', 'agent', 'prompts'),
    // dogfood R2 #97：build 产物直启（electron dist/main/index.cjs，e2e harness 即此形态）
    // 时 getAppPath() 解析到 dist/main 而非 shell 根 → dev 布局候选落空、契约静默 degrade。
    // __dirname 候选两态皆中：build = dist/main（↑4 = apps/desktop）/ dev = shell/main
    // 源码（↑4 同样 = apps/desktop）→ + agent/prompts。existsSync 不中即跳过，零风险。
    path.resolve(__dirname, '..', '..', '..', '..', 'agent', 'prompts'),
  ].filter((p): p is string => p !== null);
  for (const dir of candidates) {
    if (existsSync(dir)) {
      setPromptsBaseDir(dir);
      log.info({ dir }, 'agent prompts base dir wired');
      return;
    }
  }
  log.warn({ candidates }, 'agent prompts base dir not found — yaml contracts degrade to empty');
}

/** Register every IPC handler exactly once. Window-bound ones use getMainWindow. */
function registerAllIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  // 文档目录用系统 Known Folder 解析（Windows 重定位文档后 homedir/Documents 失真），
  // 须在首个消费者（registerProjectIpc 的根目录 mkdir/picker defaultPath）之前生效。
  initProjectsRoot(app.getPath('documents'));
  // dogfood #48：yaml 契约 prompts 基址注入——agent 被打进 dist/main/index.cjs 后
  // agentPrompt 的 import.meta.url heuristic 解析到 shell/prompts（不存在）→ 全部
  // degrade empty（researcher 丢 brief 实录）。dev 仓库布局 / 打包 resources 两候选。
  wireAgentPromptsDir();
  registerProjectIpc();
  registerWindowIpc(getMainWindow);
  registerConfigIpc();
  registerModelProviderIpc();
  registerModelGatewayIpc();
  registerStorySyncIpc();
  registerFieldSyncIpc();
  // dogfood R2 #77：creative fields 文档变更广播——盘上 project.yaml 是单一真相源，
  // UI 收敛（纯时间序 last-write-wins，不按写入方分优先级）。saveProject 是 yaml 唯一
  // 写入口（local-bff 订阅钩子），落盘后推 ToolEvent 孤儿类型 outline:changed（契约既有、
  // 此前零发射零消费）。刻意绕开 projectWatcher 的 file:changed——其自写抑制（tab 冲突
  // 保护）语义留给编辑器文件，本事件由写入口确定性发射。registerAllIpc 幂等 = 恰注册一次。
  subscribeProjectSaved((projectPath) => notifyUI({ type: 'outline:changed', projectPath }));
  registerTaskIpc();
  registerAssetIpc();
  registerLogIpc();
  registerUpdateIpc(getMainWindow);
  registerGitIpc();
  registerAgentIpc(getMainWindow);
  registerClosureCraftIpc();
  registerClosureIndexIpc();
  // dogfood T1 Stage 6：getMainWindow 透传——链 IPC 的 chain-delta/chain-node-done 事件经
  // agent:stream-event 广播（mirror registerAgentIpc(getWin) 模式，窗口重建懒解析）。
  registerClosureChainIpc(getMainWindow);
  registerSettingMdIpc();
  registerAuthorProfileIpc();
  registerResearchConfigIpc();
  // C1.2 llmlint：全稿静态扫描 / LLM 语境判断 / 机械修复应用（lintIpc 自含三 handler）。
  registerLintIpc();
  // dogfood R2 #92：世界状态面板读面三通道（world:overview / world:slice-detail /
  // world:subject-detail——纯读，无窗口面；world:changed 推送不经本注册器，发射埋三写入口
  // 经 worldNotify 全窗口广播）。
  registerWorldIpc();
}

function createWindow() {
  const isMac = process.platform === 'darwin';

  // 上次的窗口大小/位置/所在显示器（dogfood 2026-08-21）；显示器已拔/尺寸失真时
  // loadWindowState 返回 null → 走默认居中，绝不恢复到屏幕外。
  const savedWindowState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: savedWindowState?.width ?? 1440,
    height: savedWindowState?.height ?? 960,
    x: savedWindowState?.x,
    y: savedWindowState?.y,
    minWidth: 1100,
    minHeight: 720,
    icon: isMac ? undefined : resolveAppIcon(),
    frame: isMac,                          // Windows/Linux 隐藏原生标题栏
    titleBarStyle: isMac ? 'hidden' : undefined, // macOS 保留红绿灯
    trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (savedWindowState?.isMaximized) mainWindow.maximize();
  trackWindowState(mainWindow);

  const win = mainWindow;

  // Inject CSP via response headers — only in production builds, and only once
  // (the listener is on the shared defaultSession, so re-adding it per window
  // would stack duplicate handlers).
  if (!isDev && !cspInstalled) {
    cspInstalled = true;
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP],
        },
      });
    });
  }

  // Prevent Chromium from swallowing shortcuts we handle in the renderer
  const passthroughKeys = new Set(['Tab', 'n', 'w', 't']);
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && passthroughKeys.has(input.key)) {
      event.preventDefault();
    }
  });

  // Navigation / popup hard guards — renderer must not open arbitrary URLs or
  // spawn windows. External links go through openExternal (https-only).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    // Allow the initial load and Vite HMR reloads in dev; block everything else.
    const allowed =
      url.startsWith('file:')
      || (isDev && (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')));
    if (!allowed) {
      event.preventDefault();
      getLogger().warn({ url }, 'blocked renderer navigation');
    }
  });

  // Guard window close — ask renderer to check for unsaved files
  let forceClose = false;
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    win.webContents.send('app:before-close');
  });
  const onCloseConfirmed = (event: Electron.IpcMainEvent) => {
    // Only react to the confirmation from this window's renderer.
    if (event.sender !== win.webContents) return;
    forceClose = true;
    win.close();
  };
  ipcMain.on('app:close-confirmed', onCloseConfirmed);
  win.on('closed', () => {
    ipcMain.removeListener('app:close-confirmed', onCloseConfirmed);
    if (mainWindow === win) mainWindow = null;
  });

  // R8 全局界面缩放：启动即读偏好整体缩放（Chromium 页面级 zoom，机制选型注释在
  // shared-contracts clampInterfaceScale / configIpc 施加点）。读路径已钳回合法带，
  // 缺键/非法值回默认——这里拿到的一定是可用数值；缺键回退走契约单一源
  // INTERFACE_SCALE_DEFAULT（BMad CR 组4：散布 `?? 1` 收敛）。
  win.webContents.setZoomFactor(
    readUserPreferencesFromDisk().interfaceScale ?? INTERFACE_SCALE_DEFAULT
  );

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Silent update check on startup (packaged builds only). The renderer
  // surfaces a guided prompt only if a newer version is found. Delay so the
  // window/renderer is ready to receive the `update:event` stream.
  if (readUserPreferencesFromDisk().autoCheckUpdates !== false) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => void checkForUpdateOnStartup(), 5000);
    });
  }
}

/* ── Custom protocol for serving local project files ── */
// Note: registerSchemesAsPrivileged was removed in Electron 18+ — protocol.handle() handles it natively

/**
 * dogfood R2 #101①：注册库初始化失败 = 启动关键路径断裂。旧实现是本文件 whenReady 回调内
 * 直接 `throw err`——`.then()` 回调里的 throw 变 unhandledRejection，而 installGlobalErrorHandlers
 * 只记不退 → registerAllIpc/createWindow 永不执行 = 无窗静默死（用户面零信号，仅两行日志）。
 * 修法：原生错误对话框承载可复制诊断（Windows 下 Ctrl+C 整框复制——UI 侧无 copy-diagnostics
 * 实现）+ `app.exit(1)` 非零码退出（Electron 原生出口，对 e2e/启动器可见）。showErrorBox
 * 同步模态天然给 pino 异步 flush（destination sync:false）留时，不加人为延时。
 * installGlobalErrorHandlers 的「只记不退」全局语义不动——运行期单点错误不杀 app，仅启动
 * 关键路径局部收紧。deps（getDb/showErrorBox/exit）注入供测试替换；返回 false 时调用方中止
 * 启动序列（不再注册 IPC / 开窗——与旧 throw 的中止语义等价但可诊断）。
 */
export function initProjectRegistryOrExit(
  deps: {
    getDb: () => unknown;
    showErrorBox: (title: string, content: string) => void;
    exit: (code: number) => void;
  } = {
    getDb,
    showErrorBox: (title, content) => dialog.showErrorBox(title, content),
    exit: (code) => app.exit(code),
  },
): boolean {
  try {
    deps.getDb();
    getLogger().info('project registry initialized');
    return true;
  } catch (err) {
    const logger = getLogger();
    logger.fatal({ err }, 'project registry initialization failed');
    const code = err !== null && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : null;
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    deps.showErrorBox(
      'Closure 启动失败',
      `项目注册库初始化失败，应用将以非零码退出。\n\n${code ? `code: ${code}\n` : ''}${detail}\n\n` +
        `日志目录：${getLogsDirPath()}\n` +
        '若刚切换过 node 版本或重装依赖：开发者模式请先运行 pnpm rebuild:native 重建原生模块。',
    );
    deps.exit(1);
    return false;
  }
}

app.whenReady().then(() => {
  // Register orison-file:// protocol to serve local files from sandbox
  protocol.handle('orison-file', (request) => {
    return fetchOrisonFile(request.url);
  });

  installGlobalErrorHandlers();
  const logger = getLogger();
  logger.info({ platform: process.platform, version: app.getVersion() }, 'desktop main starting');
  // 数据库迁移必须在 IPC 和窗口创建前完成，不能依赖项目页是否触发首次查询。
  // 这样旧表缺列会在启动阶段一次性修复，不会等到复制/删除时才暴露失败。
  // dogfood R2 #101①：失败路径弹原生错误框（详情+日志目录+重编指引）+ app.exit(1)；
  // 返回 false 即中止启动序列（不再注册 IPC / 开窗——与旧 throw 的中止语义等价但可诊断）。
  if (!initProjectRegistryOrExit()) return;
  // Story 3.6 WP2 (R13/D6; CR P2): apply the persisted research proxy tier
  // before any research network call can fire (all research outbound rides the
  // dedicated `research` partition session, so one setProxy covers netFetch +
  // the render sandbox while defaultSession stays untouched). Best-effort — a
  // proxy failure must never block launch; read-side degradation lands on the
  // `system` default anyway.
  try {
    applyResearchProxyFromDisk();
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'research proxy startup apply failed - continuing',
    );
  }
  // Story 2.1: scan the global craft KB (~/.orison/craft-kb/ + bundled seeds) and
  // incrementally reindex new/changed docs into closure_craft_* on startup. Fire-
  // and-forget: craft reindex does async embeds (slow), must not block app launch.
  // Best-effort: per-doc failures are logged + skipped inside the scan.
  //
  // dogfood #39 (T2 Batch C1): chain the embedding-index reconcile AFTER the craft
  // scan — a previous model-change rebuild that failed (dim probe 失败 left-as-is)
  // left the vector arm silently FTS-only; the reconcile re-detects the mismatch at
  // every startup and re-runs the rebuild sweep, replacing the luck-based
  // "next model change" self-heal. Chained (not parallel) so the two startup embed
  // passes stay serialized; equally fire-and-forget + best-effort.
  void scanAndReindexCraftKb()
    .catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'craft KB startup scan failed - continuing',
      );
    })
    .then(() => reconcileEmbeddingIndexOnStartup())
    .catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'embedding index startup reconcile failed - continuing',
      );
    });
  // Story 2.1 CR-craft-kb-011: watch the user craft KB dir for incremental
  // edits / additions / deletions so a reindex lands without an app restart.
  // Started after the startup scan begins; best-effort (Linux recursive watch /
  // missing dir degrade to the startup scan + manual rebuild IPC).
  startCraftKbWatcher();
  registerAllIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Release the SQLite handle on quit. In WAL mode an open handle keeps a file
// lock that, on Windows, blocks deleting/reopening the DB file. Without this the
// connection only closed in tests, never on real app exit.
app.on('will-quit', () => {
  // Stop the craft KB watcher + clear its debounce timer so no fs watcher / timer
  // outlives the process (Story 2.1 CR-craft-kb-011).
  try {
    stopCraftKbWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopCraftKbWatcher on quit failed');
  }
  // Story 2.7: stop the asset_cards watcher too so no fs watcher / debounce timer
  // outlives the process (mirror stopCraftKbWatcher).
  try {
    stopAssetCardsWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopAssetCardsWatcher on quit failed');
  }
  // Story 2.3: stop the setting_md watcher too (same lifecycle as
  // assetCardsWatcher - mirror stopAssetCardsWatcher).
  try {
    stopSettingMdWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopSettingMdWatcher on quit failed');
  }
  // Story 8.3: stop the chapter chunk watcher too (same lifecycle - mirror
  // stopSettingMdWatcher).
  try {
    stopChapterChunkWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopChapterChunkWatcher on quit failed');
  }
  try {
    closeDb();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'closeDb on quit failed');
  }
});
