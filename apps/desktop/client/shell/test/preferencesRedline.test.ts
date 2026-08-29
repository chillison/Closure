import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserPreferencesConfig } from '@orison/shared-contracts';

const { handle, safeStorage } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  // 08-25 背景：registerConfigIpc 注册期 allowPath(userData/wallpaper) → mock getPath。
  app: { getPath: () => `${process.cwd()}/test-tmp-user-data` },
}));

const TEST_HOME = path.join(process.cwd(), 'test-tmp-user-prefs-redline');

// User-preferences path derives from os.homedir(); point it at a temp dir.
vi.spyOn(os, 'homedir').mockReturnValue(TEST_HOME);

import { registerConfigIpc } from '../main/ipc/configIpc';

function getHandlers() {
  handle.mockReset();
  registerConfigIpc();
  const save = handle.mock.calls.find(([c]) => c === 'config:save-user-preferences')![1];
  const load = handle.mock.calls.find(([c]) => c === 'config:load-user-preferences')![1];
  return { save, load };
}

function preferencesPath(): string {
  return path.join(TEST_HOME, '.orison', 'user', 'preferences.yaml');
}

/** Hand-write a preferences.yaml (the dir only exists after a first save). */
function writePreferencesFile(lines: string[]): void {
  mkdirSync(path.dirname(preferencesPath()), { recursive: true });
  writeFileSync(preferencesPath(), lines.join('\n') + '\n', 'utf8');
}

// 08-25 thinking-controls S3（design §3.2）：contextCompaction.redlinePercent——压缩红线
// 偏好的落盘/读取契约。读路径是唯一钳制点（clamp 50~100、非法/缺省回默认 95），存量
// preferences.yaml（无该键）零迁移照常加载。
describe('user preferences contextCompaction.redlinePercent (08-25 S3)', () => {
  beforeEach(() => {
    rmBestEffort(TEST_HOME);
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    rmBestEffort(TEST_HOME);
  });

  it('defaults to 95 when the file is absent', async () => {
    const { load } = getHandlers();
    const read = (await load({})) as UserPreferencesConfig;
    expect(read.contextCompaction).toEqual({ redlinePercent: 95 });
  });

  it('zero migration: a legacy preferences.yaml without the key loads as usual and falls back to 95', async () => {
    writePreferencesFile(['theme: dark', 'locale: zh-CN', 'editorLineHeight: 1.9']);
    const { load } = getHandlers();
    const read = (await load({})) as UserPreferencesConfig;
    expect(read.contextCompaction).toEqual({ redlinePercent: 95 });
    // Existing fields keep loading untouched alongside the new key.
    expect(read.theme).toBe('dark');
    expect(read.editorLineHeight).toBe(1.9);
  });

  it('round-trips a valid value through the save/load handlers', async () => {
    const { save, load } = getHandlers();
    const written: UserPreferencesConfig = {
      theme: 'dark',
      locale: 'zh-CN',
      contextCompaction: { redlinePercent: 80 },
    };
    await save({}, written);
    const read = (await load({})) as UserPreferencesConfig;
    expect(read.contextCompaction).toEqual({ redlinePercent: 80 });
  });

  it('a save without contextCompaction (legacy caller) writes no key and reloads as 95', async () => {
    const { save, load } = getHandlers();
    await save({}, { theme: 'dark', locale: 'en' });
    const onDisk = (await load({})) as UserPreferencesConfig;
    expect(onDisk.contextCompaction).toEqual({ redlinePercent: 95 });
  });

  it('illegal values (string / NaN / null) fall back to 95', async () => {
    for (const illegal of ['ninety', '.nan', 'null', '']) {
      writePreferencesFile(['theme: dark', 'locale: en', `contextCompaction.redlinePercent: ${illegal}`]);
      const { load } = getHandlers();
      const read = (await load({})) as UserPreferencesConfig;
      expect(read.contextCompaction).toEqual({ redlinePercent: 95 });
    }
  });

  it('clamps hand-edited out-of-range values into 50–100 on read', async () => {
    const cases: Array<[string, number]> = [
      ['contextCompaction.redlinePercent: 10', 50],
      ['contextCompaction.redlinePercent: 0', 50],
      ['contextCompaction.redlinePercent: 101', 100],
      ['contextCompaction.redlinePercent: 500', 100],
      ['contextCompaction.redlinePercent: 50', 50],
      ['contextCompaction.redlinePercent: 100', 100],
    ];
    for (const [line, expected] of cases) {
      writePreferencesFile(['theme: dark', 'locale: en', line]);
      const { load } = getHandlers();
      const read = (await load({})) as UserPreferencesConfig;
      expect(read.contextCompaction).toEqual({ redlinePercent: expected });
    }
  });

  it('an out-of-range value round-tripped through save is clamped on the read side', async () => {
    // The write path persists what it is given (typeof guard only — mirror of
    // editorLineHeight); the read path is the single enforcement point.
    const { save, load } = getHandlers();
    await save({}, { theme: 'dark', locale: 'en', contextCompaction: { redlinePercent: 120 } });
    const read = (await load({})) as UserPreferencesConfig;
    expect(read.contextCompaction).toEqual({ redlinePercent: 100 });
  });
});
