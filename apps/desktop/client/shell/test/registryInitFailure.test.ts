import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmBestEffort } from './rmBestEffort';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #101①（R3.1）：注册库初始化失败 = 原生错误框 + 非零码退出，不再无窗静默死。
// 旧病根：main/index.ts whenReady 回调内 `throw err` → unhandledRejection 只记不退 →
// registerAllIpc/createWindow 永不执行。本套锚 initProjectRegistryOrExit 的失败路径：
// mock db 抛 ERR_DLOPEN_FAILED（mirror #101① 实录的 better-sqlite3 .node ABI 不匹配形态），
// 断言 showErrorBox 参数（含错误详情/日志目录路径/rebuild:native 指引）与 exit(1)；
// 成功路径返回 true、不弹窗不退出。
// ─────────────────────────────────────────────────────────────────────────────

// 日志目录重定向（dogfood #104-a ORISON_LOG_DIR 口，vi.hoisted 先于 import 执行——logger
// 单例首调即读到它）：断言「弹窗含日志目录」用临时目录路径，测试全程不碰真实 ~/.orison/logs，
// 同时实跑验证重定向口接线。fatal 落盘不强求断言（pino sync:false 异步 flush；showErrorBox
// 同步模态在真 app 里天然留时——设计 §3.1 定谳）。
const LOGS_DIR = vi.hoisted(() => {
  const dir = process.cwd() + '/test-tmp-registry-init-failure-logs';
  process.env.ORISON_LOG_DIR = dir;
  return dir;
});

const { getDbMock, showErrorBoxMock, exitMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  showErrorBoxMock: vi.fn(),
  exitMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    // 打包态：跳过模块级 CDP 口配置块（dev 分支会摸 app.commandLine + getLogger）。
    isPackaged: true,
    // whenReady 永不 settle → 启动回调永不触发（本套只直测被抽出的 initProjectRegistryOrExit，
    // 不真跑启动序列）。
    whenReady: () => new Promise<never>(() => {}),
    on: vi.fn(),
    exit: exitMock,
  },
  BrowserWindow: class {},
  dialog: { showErrorBox: showErrorBoxMock },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  protocol: { handle: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

// updateIpc 顶层 import electron-updater（重依赖，与本套零相关）——mock 掉保 main/index 可达。
vi.mock('electron-updater', () => ({ default: {} }));

// 注册库初始化失败注入点（vi.mock 整模块替换 db/index——真实 getDb 需 better-sqlite3 ABI 匹配，
// 本套不依赖真 db）。
vi.mock('../main/db', () => ({ getDb: getDbMock, closeDb: vi.fn() }));

import { initProjectRegistryOrExit } from '../main/index';
import { getLogsDirPath } from '../main/logger';

afterAll(() => {
  rmBestEffort(LOGS_DIR);
});

describe('initProjectRegistryOrExit（#101①：注册库失败不再无窗静默死）', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    showErrorBoxMock.mockClear();
    exitMock.mockClear();
  });

  it('getDb 抛 ERR_DLOPEN_FAILED → showErrorBox（code+详情+日志目录+rebuild 指引）+ exit(1)，返回 false', () => {
    const dlopenErr = new Error(
      "The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version requires NODE_MODULE_VERSION 136.",
    );
    (dlopenErr as NodeJS.ErrnoException).code = 'ERR_DLOPEN_FAILED';
    getDbMock.mockImplementation(() => {
      throw dlopenErr;
    });

    const ok = initProjectRegistryOrExit();

    expect(ok).toBe(false);
    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    const [title, content] = showErrorBoxMock.mock.calls[0] as [string, string];
    expect(title).toBe('Closure 启动失败');
    expect(content).toContain('ERR_DLOPEN_FAILED');
    expect(content).toContain('NODE_MODULE_VERSION');
    expect(content).toContain(getLogsDirPath());
    expect(content).toContain('pnpm rebuild:native');
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('成功路径：getDb 不抛 → 返回 true，不弹窗不退出', () => {
    getDbMock.mockReturnValue({});
    const ok = initProjectRegistryOrExit();
    expect(ok).toBe(true);
    expect(showErrorBoxMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('非 Error 抛出物（字符串）也不炸——detail 走 String() 分支', () => {
    getDbMock.mockImplementation(() => {
      throw 'raw string failure';
    });
    const ok = initProjectRegistryOrExit();
    expect(ok).toBe(false);
    const [, content] = showErrorBoxMock.mock.calls[0] as [string, string];
    expect(content).toContain('raw string failure');
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
