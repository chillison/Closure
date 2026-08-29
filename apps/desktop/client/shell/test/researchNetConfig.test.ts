/**
 * Research net proxy config tests (Story 3.6 WP2, R13 / design D6).
 *
 * Covers: the `researchNetConfigSchema` boundary (defaults + the
 * custom-requires-proxyUrl refine), the `research-net.yaml` sidecar round-trip
 * (mirror of the vision-model sidecar), corrupt/absent-file degradation to
 * `system`, the three-tier `applyResearchProxy` → `session.setProxy` mapping,
 * and write-time re-application.
 *
 * Mocks mirror modelConfigIpc.test.ts: electron (session/ipcMain/safeStorage),
 * the configIpc db-imports, and the logger — plain vitest, no real
 * ~/.orison writes (sidecar dir is overridden per test).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { researchNetConfigSchema } from '@orison/shared-contracts';

const { handle, safeStorage, setProxy, defaultSetProxy, fromPartition, reindexAll, reindexAllCraft, reindexAssetCards, reindexAllSettingMd, getProjectById, getProject, getDb, warn, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  setProxy: vi.fn().mockResolvedValue(undefined),
  defaultSetProxy: vi.fn().mockResolvedValue(undefined),
  fromPartition: vi.fn(() => ({
    setProxy: setProxy,
    fetch: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  })),
  reindexAll: vi.fn(),
  reindexAllCraft: vi.fn(),
  reindexAssetCards: vi.fn(),
  reindexAllSettingMd: vi.fn(),
  getProjectById: vi.fn(),
  getProject: vi.fn(),
  getDb: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  session: {
    // P2 (CR 2026-08-15): applyResearchProxy steers the RESEARCH partition
    // session only — the defaultSession setProxy spy exists to prove it is
    // NEVER touched.
    defaultSession: { setProxy: defaultSetProxy },
    fromPartition,
  },
}));
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import {
  DEFAULT_PROXY_BYPASS,
  applyResearchProxy,
  applyResearchProxyFromDisk,
  readResearchNetConfig,
  resolveProxyBypassList,
  writeResearchNetConfig,
  _setModelConfigDirForTest,
} from '../main/ipc/configIpc';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-research-net');

beforeEach(() => {
  vi.clearAllMocks();
  setProxy.mockReset().mockResolvedValue(undefined);
  getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });
  _setModelConfigDirForTest(TEST_MODEL_DIR);
  rmBestEffort(TEST_MODEL_DIR);
});

afterEach(() => {
  _setModelConfigDirForTest(null);
  rmBestEffort(TEST_MODEL_DIR);
});

// ── Schema boundary (shared-contracts) ──

describe('researchNetConfigSchema', () => {
  it('defaults to the system tier (zero-config research network)', () => {
    expect(researchNetConfigSchema.parse({})).toEqual({ proxyMode: 'system' });
  });

  it('custom WITHOUT proxyUrl is rejected at the schema boundary', () => {
    expect(() => researchNetConfigSchema.parse({ proxyMode: 'custom' })).toThrow();
    expect(() => researchNetConfigSchema.parse({ proxyMode: 'custom', proxyUrl: '   ' })).toThrow();
  });

  it('custom WITH proxyUrl passes; off tolerates a stale proxyUrl', () => {
    expect(researchNetConfigSchema.parse({ proxyMode: 'custom', proxyUrl: ' http://127.0.0.1:7890 ' })).toEqual({
      proxyMode: 'custom',
      proxyUrl: 'http://127.0.0.1:7890',
    });
    expect(researchNetConfigSchema.parse({ proxyMode: 'off', proxyUrl: 'http://old' })).toEqual({
      proxyMode: 'off',
      proxyUrl: 'http://old',
    });
  });
});

// ── Sidecar round-trip ──

describe('research-net.yaml sidecar', () => {
  it('absent file → system default', () => {
    expect(readResearchNetConfig()).toEqual({ proxyMode: 'system' });
  });

  it('write → read round-trips all three tiers', () => {
    writeResearchNetConfig({ proxyMode: 'custom', proxyUrl: 'socks5://127.0.0.1:1080', proxyBypass: '*.corp.example' });
    expect(readResearchNetConfig()).toEqual({
      proxyMode: 'custom',
      proxyUrl: 'socks5://127.0.0.1:1080',
      proxyBypass: '*.corp.example',
    });

    writeResearchNetConfig({ proxyMode: 'off' });
    expect(readResearchNetConfig()).toEqual({ proxyMode: 'off' });

    writeResearchNetConfig({ proxyMode: 'system' });
    expect(readResearchNetConfig()).toEqual({ proxyMode: 'system' });
  });

  it('corrupt / schema-invalid file degrades to system (never bricks research)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    const file = path.join(TEST_MODEL_DIR, 'research-net.yaml');
    writeFileSync(file, '::: not [ valid yaml {{{', 'utf-8');
    expect(readResearchNetConfig()).toEqual({ proxyMode: 'system' });

    writeFileSync(file, 'proxyMode: custom\n', 'utf-8'); // custom without proxyUrl
    expect(readResearchNetConfig()).toEqual({ proxyMode: 'system' });

    writeFileSync(file, 'proxyMode: bogus\n', 'utf-8');
    expect(readResearchNetConfig()).toEqual({ proxyMode: 'system' });
  });

  it('writeResearchNetConfig REJECTS an invalid config (no silent dead-proxy persist)', () => {
    expect(() => writeResearchNetConfig({ proxyMode: 'custom' })).toThrow();
    expect(existsSync(path.join(TEST_MODEL_DIR, 'research-net.yaml'))).toBe(false);
  });

  it('write persists flat yaml and re-applies immediately (write-time re-application)', () => {
    writeResearchNetConfig({ proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890' });
    const raw = readFileSync(path.join(TEST_MODEL_DIR, 'research-net.yaml'), 'utf-8');
    expect(raw).toContain('proxyMode: custom');
    expect(raw).toContain('proxyUrl: http://127.0.0.1:7890');
    expect(setProxy).toHaveBeenCalledTimes(1);
  });
});

// ── Three-tier applyResearchProxy mapping (design D6) ──

describe('applyResearchProxy', () => {
  it('system → mode system (Chromium auto-detects WPAD/PAC)', () => {
    applyResearchProxy({ proxyMode: 'system' });
    expect(setProxy).toHaveBeenCalledWith({ mode: 'system' });
  });

  it('P2: every tier steers the RESEARCH partition session — defaultSession is NEVER touched', () => {
    for (const config of [
      { proxyMode: 'system' as const },
      { proxyMode: 'custom' as const, proxyUrl: 'http://127.0.0.1:7890' },
      { proxyMode: 'off' as const },
    ]) {
      applyResearchProxy(config);
    }
    // The partition session is a per-process singleton — an earlier test in
    // this file may already have created it, so the assertion is "created at
    // most once", never re-created per tier.
    expect(fromPartition.mock.calls.length).toBeLessThanOrEqual(1);
    expect(defaultSetProxy).not.toHaveBeenCalled(); // CR edge#112: no whole-session proxy escape
  });

  it('custom → proxyRules + bypassList = default loopback + custom entries', () => {
    applyResearchProxy({ proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890', proxyBypass: '*.corp.example,10.0.0.0/8' });
    expect(setProxy).toHaveBeenCalledWith({
      proxyRules: 'http://127.0.0.1:7890',
      proxyBypassRules: `${DEFAULT_PROXY_BYPASS},*.corp.example,10.0.0.0/8`,
    });
  });

  it('custom without usable proxyUrl falls back to system (malformed entry never kills the network)', () => {
    // Schema normally prevents this shape; applyResearchProxy still tolerates it.
    applyResearchProxy({ proxyMode: 'custom' });
    expect(setProxy).toHaveBeenCalledWith({ mode: 'system' });
  });

  it('off → direct', () => {
    applyResearchProxy({ proxyMode: 'off' });
    expect(setProxy).toHaveBeenCalledWith({ mode: 'direct' });
  });

  it('a setProxy failure never throws (logged, previous proxy state kept)', async () => {
    setProxy.mockReset().mockRejectedValue(new Error('session gone'));
    applyResearchProxy({ proxyMode: 'off' });
    // The rejection rides the internal .catch — give it a macrotask tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalled();
  });
});

describe('applyResearchProxyFromDisk (startup path)', () => {
  it('applies the persisted tier', () => {
    writeResearchNetConfig({ proxyMode: 'off' });
    setProxy.mockClear();
    applyResearchProxyFromDisk();
    expect(setProxy).toHaveBeenCalledWith({ mode: 'direct' });
  });

  it('no sidecar yet → applies the system default', () => {
    applyResearchProxyFromDisk();
    expect(setProxy).toHaveBeenCalledWith({ mode: 'system' });
  });
});

describe('resolveProxyBypassList', () => {
  it('default = loopback trio; custom entries are APPENDED after the default', () => {
    expect(DEFAULT_PROXY_BYPASS).toBe('localhost,127.0.0.1,::1');
    expect(resolveProxyBypassList()).toBe(DEFAULT_PROXY_BYPASS);
    expect(resolveProxyBypassList('   ')).toBe(DEFAULT_PROXY_BYPASS);
    expect(resolveProxyBypassList('a.com,b.com')).toBe(`${DEFAULT_PROXY_BYPASS},a.com,b.com`);
  });
});
