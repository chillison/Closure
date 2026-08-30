import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Launch helper for the Electron e2e harness.
 *
 * Target = the electron-vite BUILD product (not dev mode). dev mode runs the
 * main process through the vite dev server (entry lives in memory, no stable
 * path for `electron.launch`), whereas `electron-vite build` emits a stable
 * `dist/main/index.cjs` which is the package.json `main` field. Launching the
 * build product also runs the real preload + IPC, i.e. release-equivalent
 * behaviour (closer to real than dev).
 *
 * `electron-playwright-helpers` `findLatestBuild` is NOT used: it targets
 * electron-builder packaged apps (.app/.exe in release/ or out/), not the
 * electron-vite `dist/main/index.cjs` file. The build path is a known stable
 * constant, so we resolve it directly and guard on existence with a clear
 * "build first" error.
 */

const here = dirname(fileURLToPath(import.meta.url));
// src/launch.ts -> src -> e2e -> desktop -> apps -> repo root (4 levels up)
const REPO_ROOT = resolve(here, '..', '..', '..', '..');

/** Absolute path to the shell package root (package.json `main` = dist/main/index.cjs). */
export const SHELL_APP_DIR = resolve(REPO_ROOT, 'apps', 'desktop', 'client', 'shell');

/** Absolute path to the shell's built main entry (package.json `main`). */
export const SHELL_MAIN_PATH = resolve(SHELL_APP_DIR, 'dist', 'main', 'index.cjs');

/**
 * Absolute path to the Electron binary. `require('electron')` (the npm package)
 * returns the path to the bundled Electron executable when called from a plain
 * Node context. Resolved via createRequire so it works under ESM + pnpm strict
 * node_modules.
 */
const nodeRequire = createRequire(import.meta.url);
const ELECTRON_BINARY_PATH = nodeRequire('electron') as string;

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
}

/**
 * Launch the desktop app and wait for its first window.
 *
 * - `headless: false` is a hard constraint: the window must be visible so the
 *   user can fill the API key in model-settings (the harness never touches the
 *   key value).
 * - `E2E_MODE=1` is injected as an opt-in signal the app MAY read to skip
 *   update checks / first-run friction; the app is not required to read it.
 */
export async function launchApp(): Promise<LaunchedApp> {
  if (!existsSync(SHELL_MAIN_PATH)) {
    throw new Error(
      `Electron build product not found at:\n  ${SHELL_MAIN_PATH}\n` +
        'Run `pnpm --filter @orison/desktop-shell build` first.',
    );
  }
  if (!ELECTRON_BINARY_PATH || !existsSync(ELECTRON_BINARY_PATH)) {
    throw new Error(
      'Electron binary not found. Ensure `electron` is installed: run `pnpm install`.',
    );
  }

  // dogfood R2 #99：启动目标 = shell 目录（package.json `main` 指向构建产物），而非
  // index.cjs 文件本身。直跑脚本文件落入 Electron default_app 语义：app.name 变
  // "Electron"、userData = %APPDATA%\Electron（空壳 profile）、getAppPath()=dist/main——
  // 用户 profile 级配置（窗口记忆/壁纸/渲染层 localStorage）全部丢失，与 dev
  // (`electron .`) / 打包形态的应用身份不一致。传目录则与 dev 同名同 profile。
  // `headless` 有意不传（Playwright electron.launch 也无此选项）：BrowserWindow
  // show:true 默认可见，满足硬约束 2（model-settings 手填 key）。
  const app = await electron.launch({
    executablePath: ELECTRON_BINARY_PATH,
    args: [SHELL_APP_DIR],
    env: { ...process.env, E2E_MODE: '1' },
  });

  // BMad CR M5: if firstWindow rejects (preload crash / build broken / timeout),
  // close the app to avoid leaking an Electron process with no window handle.
  try {
    const window = await app.firstWindow();
    return { app, window };
  } catch (e) {
    try {
      await app.close();
    } catch {
      // ignore - best-effort cleanup
    }
    throw e;
  }
}
