/**
 * 08-25 设置：全窗口背景——configIpc `config:import-wallpaper` / `config:clear-wallpaper`
 * （镜像 importFonts 范式，mock dialog + 真 fs）：
 * - import：拷贝源图到 userData/wallpaper/<basename>（重名覆盖），返回**拷贝件**的
 *   orison-file URL（正斜杠形态——渲染侧要进 CSS url("")，反斜杠会被 CSS 字符串转义吃掉）；
 * - 取消 / 非图片扩展名 → null（不建目录不拷贝）；
 * - clear：删目录内全部文件、保留目录本身；目录不存在时静默；
 * - 路径授权：registerConfigIpc 内 allowPath(wallpaperDir)——orison-file 协议的
 *   assertSafePath 只认 allowedRoots（默认仅项目根），未授权则 <img>/背景加载 403。
 * - 08-29 磨砂滑杆化：user-preferences 读写路径的 wallpaperFrostBlur 归一案也在本文件
 *   （写只落新键 + 写时钳；存量旧布尔键 wallpaperFrost 读路径折算 true→20 / false→0）。
 */
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserPreferencesConfig } from '@orison/shared-contracts';

const { handle, safeStorage, showOpenDialog, appGetPath } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  showOpenDialog: vi.fn(),
  appGetPath: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  dialog: { showOpenDialog },
  app: { getPath: appGetPath },
  // orisonFileProtocol 导入面需要 net；断言只走纯函数 resolveOrisonFilePath。
  net: { fetch: vi.fn() },
}));

const TEST_ROOT = path.join(process.cwd(), 'test-tmp-wallpaper');
const USER_DATA = path.join(TEST_ROOT, 'userData');
const WALLPAPER_DIR = path.join(USER_DATA, 'wallpaper');

// 磨砂归一案走 user-preferences 读写 handler：prefs 路径在 os.homedir() 下（与
// import/clear 的 app.getPath('userData') 分家），一并指进临时目录。
const PREFS_HOME = path.join(TEST_ROOT, 'home');
const PREFS_PATH = path.join(PREFS_HOME, '.orison', 'user', 'preferences.yaml');
vi.spyOn(os, 'homedir').mockReturnValue(PREFS_HOME);

import { registerConfigIpc } from '../main/ipc/configIpc';
import { resolveOrisonFilePath } from '../main/orisonFileProtocol';

function getHandlers() {
  handle.mockReset();
  registerConfigIpc();
  const importH = handle.mock.calls.find(([c]) => c === 'config:import-wallpaper')![1];
  const clearH = handle.mock.calls.find(([c]) => c === 'config:clear-wallpaper')![1];
  return { importH, clearH };
}

function getPrefsHandlers() {
  handle.mockReset();
  registerConfigIpc();
  const save = handle.mock.calls.find(([c]) => c === 'config:save-user-preferences')![1];
  const load = handle.mock.calls.find(([c]) => c === 'config:load-user-preferences')![1];
  return { save, load };
}

beforeEach(() => {
  rmBestEffort(TEST_ROOT);
  mkdirSync(TEST_ROOT, { recursive: true });
  appGetPath.mockReturnValue(USER_DATA);
});

afterEach(() => {
  rmBestEffort(TEST_ROOT);
  showOpenDialog.mockReset();
});

describe('config:import-wallpaper', () => {
  it('copies the picked image into userData/wallpaper and returns a forward-slash orison-file URL (same-name re-import overwrites)', async () => {
    const { importH } = getHandlers();
    const src = path.join(TEST_ROOT, 'bg.png');
    writeFileSync(src, 'png-bytes-v1');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] });

    const dest = path.join(WALLPAPER_DIR, 'bg.png');
    await expect(importH(null)).resolves.toEqual({
      url: `orison-file:///${dest.replace(/\\/g, '/')}`,
    });
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toBe('png-bytes-v1');

    // 同名重选 → 覆盖旧拷贝（不是第二份文件）。
    writeFileSync(src, 'png-bytes-v2');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] });
    await importH(null);
    expect(readdirSync(WALLPAPER_DIR)).toEqual(['bg.png']);
    expect(readFileSync(dest, 'utf-8')).toBe('png-bytes-v2');
  });

  it('returns null when the dialog is canceled (no directory created)', async () => {
    const { importH } = getHandlers();
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(importH(null)).resolves.toBeNull();
    expect(existsSync(WALLPAPER_DIR)).toBe(false);
  });

  it('returns null for a non-image extension (filters are advisory, not a hard guarantee)', async () => {
    const { importH } = getHandlers();
    const src = path.join(TEST_ROOT, 'notes.txt');
    writeFileSync(src, 'text');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] });
    await expect(importH(null)).resolves.toBeNull();
    expect(existsSync(WALLPAPER_DIR)).toBe(false);
  });

  it('authorizes the wallpaper dir for the orison-file protocol at registration time', async () => {
    const { importH } = getHandlers();
    const src = path.join(TEST_ROOT, 'photo.jpg');
    writeFileSync(src, 'jpg-bytes');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] });

    const { url } = (await importH(null)) as { url: string };
    // assertSafePath 只认 allowedRoots——registerConfigIpc 已 allowPath(wallpaperDir)，
    // 协议解析不抛「Path outside allowed scope」且解析回拷贝件绝对路径。
    expect(() => resolveOrisonFilePath(url)).not.toThrow();
    expect(resolveOrisonFilePath(url)).toBe(path.join(WALLPAPER_DIR, 'photo.jpg'));
  });
});

describe('config:clear-wallpaper', () => {
  it('deletes files inside the wallpaper dir but keeps the dir itself', async () => {
    const { clearH } = getHandlers();
    mkdirSync(WALLPAPER_DIR, { recursive: true });
    writeFileSync(path.join(WALLPAPER_DIR, 'a.png'), 'a');
    writeFileSync(path.join(WALLPAPER_DIR, 'b.jpg'), 'b');

    // handler 本体同步返回 void（preload 的 invoke 桥才包 Promise）。
    expect(clearH(null)).toBeUndefined();
    expect(existsSync(WALLPAPER_DIR)).toBe(true);
    expect(readdirSync(WALLPAPER_DIR)).toEqual([]);
  });

  it('is a no-op when the dir does not exist', () => {
    const { clearH } = getHandlers();
    expect(clearH(null)).toBeUndefined();
    expect(existsSync(WALLPAPER_DIR)).toBe(false);
  });
});

describe('磨砂强度 wallpaperFrostBlur（08-29 开关→滑杆，读路径归一零迁移）', () => {
  /** 手写存量盘文件（旧版本 writeUserPreferences 产物 / 用户手改形态）。 */
  function writePrefsDisk(body: string) {
    mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
    writeFileSync(PREFS_PATH, body, 'utf-8');
  }

  it('写路径只落新键并写时钳 0–50 整数；NaN 不落键（盘面干净可手改）', async () => {
    const { save, load } = getPrefsHandlers();

    await save({}, { theme: 'system', locale: 'system', wallpaperFrostBlur: 12.5 } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(13);
    // 盘上只有新键（旧布尔键不再写；带冒号防 'wallpaperFrostBlur' 子串误命中）。
    const disk = readFileSync(PREFS_PATH, 'utf-8');
    expect(disk).toContain('wallpaperFrostBlur: 13');
    expect(disk).not.toContain('wallpaperFrost:');

    await save({}, { theme: 'system', locale: 'system', wallpaperFrostBlur: 999 } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(50);

    await save({}, { theme: 'system', locale: 'system', wallpaperFrostBlur: -1 } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(0);

    // NaN：不写键 → 盘上无新键 → 读回默认 0（interfaceScale 同款有限数值守卫）。
    await save({}, { theme: 'system', locale: 'system', wallpaperFrostBlur: Number.NaN } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(0);
  });

  it('存量旧布尔键折算：true → 20（原固定半径不丢）、false → 0、无键 → 0', async () => {
    const { load } = getPrefsHandlers();

    writePrefsDisk('theme: system\nlocale: system\nwallpaperFrost: true\n');
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(20);

    writePrefsDisk('theme: system\nlocale: system\nwallpaperFrost: false\n');
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(0);

    writePrefsDisk('theme: system\nlocale: system\n');
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(0);
  });

  it('新旧键并存 → 新键优先；新键非法（手改乱值）→ 视同缺席折回旧布尔', async () => {
    const { load } = getPrefsHandlers();

    writePrefsDisk('theme: system\nlocale: system\nwallpaperFrost: true\nwallpaperFrostBlur: 35\n');
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(35);

    writePrefsDisk('theme: system\nlocale: system\nwallpaperFrost: true\nwallpaperFrostBlur: abc\n');
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(20);
  });

  it('存量盘上新键越界/非整数 → 读路径钳回 0–50 整数', async () => {
    const { load } = getPrefsHandlers();

    writePrefsDisk('theme: system\nlocale: system\nwallpaperFrostBlur: 500\n');
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(50);

    writePrefsDisk('theme: system\nlocale: system\nwallpaperFrostBlur: -30\n');
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(0);

    writePrefsDisk('theme: system\nlocale: system\nwallpaperFrostBlur: 12.7\n');
    expect(((await load({})) as UserPreferencesConfig).wallpaperFrostBlur).toBe(13);
  });
});
