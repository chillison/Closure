/**
 * docParser config tests (Story 3.6 WP6, R10 / design D11).
 *
 * Covers: the `docParserConfigSchema` boundary (all-or-nothing type+baseUrl
 * pair — "type 定了 baseUrl 必填"), the `doc-parser.yaml` sidecar round-trip
 * (absent/corrupt/schema-invalid degrade to unconfigured default), and the
 * /health probe matrix (2s hit / http fail / transport fail / unconfigured
 * + per-process cache semantics incl. config-change invalidation + force).
 *
 * Mocks mirror searchConfig.test.ts (electron + configIpc db-imports +
 * logger): plain vitest, no real ~/.orison writes, ZERO network.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docParserConfigSchema } from '@orison/shared-contracts';

const { handle, safeStorage, setProxy, reindexAll, reindexAllCraft, reindexAllAssetCards, reindexAllSettingMd, getProjectById, getProject, getDb, warn, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  setProxy: vi.fn().mockResolvedValue(undefined),
  reindexAll: vi.fn(),
  reindexAllCraft: vi.fn(),
  reindexAllAssetCards: vi.fn(),
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
  session: { defaultSession: { setProxy } },
  net: { fetch: vi.fn() },
}));
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAllAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import { _setModelConfigDirForTest } from '../main/ipc/configIpc';
import {
  DOC_PARSER_PROBE_TIMEOUT_MS,
  probeDocParser,
  readDocParserConfig,
  resetDocParserProbe,
  writeDocParserConfig,
  type DocParserProbeFetcher,
} from '../main/research/docParserConfig';
import type { DocParserConfig } from '@orison/shared-contracts';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-doc-parser-config');

beforeEach(() => {
  vi.clearAllMocks();
  setProxy.mockReset().mockResolvedValue(undefined);
  getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });
  _setModelConfigDirForTest(TEST_MODEL_DIR);
  resetDocParserProbe();
  rmBestEffort(TEST_MODEL_DIR);
});

afterEach(() => {
  _setModelConfigDirForTest(null);
  resetDocParserProbe();
  rmBestEffort(TEST_MODEL_DIR);
});

// ── Schema boundary (shared-contracts) ──

describe('docParserConfigSchema', () => {
  it('empty object = unconfigured (the valid "use builtin" state)', () => {
    expect(docParserConfigSchema.parse({})).toEqual({});
  });

  it('type without baseUrl is rejected (不能探活/调用的半配置)', () => {
    expect(docParserConfigSchema.safeParse({ type: 'mineru' }).success).toBe(false);
  });

  it('baseUrl without type is rejected too (no adapter to dispatch on)', () => {
    expect(docParserConfigSchema.safeParse({ baseUrl: 'http://127.0.0.1:8000' }).success).toBe(false);
  });

  it('valid pairs parse for all three kinds; non-URL baseUrl rejected', () => {
    for (const type of ['mineru', 'docling', 'custom'] as const) {
      expect(docParserConfigSchema.parse({ type, baseUrl: 'http://127.0.0.1:8000' })).toEqual({
        type,
        baseUrl: 'http://127.0.0.1:8000',
      });
    }
    expect(docParserConfigSchema.safeParse({ type: 'custom', baseUrl: 'not a url' }).success).toBe(false);
  });
});

// ── Sidecar round-trip ──

describe('doc-parser.yaml sidecar', () => {
  it('absent file → unconfigured default', () => {
    expect(readDocParserConfig()).toEqual({});
  });

  it('write → read round-trips the pair (flat yaml keys)', () => {
    writeDocParserConfig({ type: 'mineru', baseUrl: 'http://127.0.0.1:8000/' });
    expect(readDocParserConfig()).toEqual({ type: 'mineru', baseUrl: 'http://127.0.0.1:8000/' });
  });

  it('corrupt yaml → default (never throws, never bricks parse_document)', () => {
    const dir = TEST_MODEL_DIR;
    if (!existsSync(dir)) writeDocParserConfig({ type: 'docling', baseUrl: 'http://x' });
    writeFileSync(path.join(dir, 'doc-parser.yaml'), '\t{{{ not yaml', 'utf-8');
    expect(readDocParserConfig()).toEqual({});
  });

  it('schema-invalid sidecar (type without baseUrl) → default', () => {
    const dir = TEST_MODEL_DIR;
    writeDocParserConfig({ type: 'docling', baseUrl: 'http://127.0.0.1:5001' });
    writeFileSync(path.join(dir, 'doc-parser.yaml'), 'type: docling\n', 'utf-8');
    expect(readDocParserConfig()).toEqual({});
  });

  it('write rejects a half-config (ZodError to the settings caller)', () => {
    expect(() => writeDocParserConfig({ type: 'mineru' } as DocParserConfig)).toThrow();
  });
});

// ── Probe matrix ──

type ProbeCall = { url: string; opts: { timeoutMs?: number } };

function probeFetcher(
  respond: (call: ProbeCall) => { ok: boolean; status: number } | Promise<{ ok: boolean; status: number }>,
): { fetcher: DocParserProbeFetcher; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const fetcher: DocParserProbeFetcher = async (url, _init, opts) => {
    const call = { url, opts };
    calls.push(call);
    return respond(call);
  };
  return { fetcher, calls };
}

const CONFIGURED: DocParserConfig = { type: 'mineru', baseUrl: 'http://127.0.0.1:8000/' };

describe('probeDocParser', () => {
  it('GET {base}/health (trailing slash normalized) with the 2s budget; 2xx = ok + kind echo', async () => {
    const { fetcher, calls } = probeFetcher(() => ({ ok: true, status: 200 }));
    const result = await probeDocParser({ config: CONFIGURED, fetcher });
    expect(result).toEqual({ ok: true, kind: 'mineru' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:8000/health');
    expect(calls[0].opts.timeoutMs).toBe(DOC_PARSER_PROBE_TIMEOUT_MS);
    expect(DOC_PARSER_PROBE_TIMEOUT_MS).toBe(2_000);
  });

  it('non-2xx health → ok:false with the HTTP detail', async () => {
    const { fetcher } = probeFetcher(() => ({ ok: false, status: 503 }));
    const result = await probeDocParser({ config: CONFIGURED, fetcher });
    expect(result).toEqual({ ok: false, kind: 'mineru', detail: expect.stringContaining('503') });
  });

  it('transport failure → ok:false, never a throw', async () => {
    const { fetcher } = probeFetcher(() => {
      throw new Error('请求超时（2000ms）');
    });
    const result = await probeDocParser({ config: CONFIGURED, fetcher });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('mineru');
    expect(result.detail).toContain('2000ms');
  });

  it('unconfigured → ok:false WITHOUT caching (a later save takes effect next call)', async () => {
    const { fetcher, calls } = probeFetcher(() => ({ ok: true, status: 200 }));
    const unconfigured = await probeDocParser({ fetcher });
    expect(unconfigured.ok).toBe(false);
    expect(calls).toHaveLength(0);

    // Same fetcher, now with a config injected — must probe (not served from any cache).
    const configured = await probeDocParser({ config: CONFIGURED, fetcher });
    expect(configured).toEqual({ ok: true, kind: 'mineru' });
    expect(calls).toHaveLength(1);
  });

  it('result cached per config pair; force re-probes', async () => {
    const { fetcher, calls } = probeFetcher(() => ({ ok: true, status: 200 }));
    await probeDocParser({ config: CONFIGURED, fetcher });
    await probeDocParser({ config: CONFIGURED, fetcher });
    expect(calls).toHaveLength(1);

    await probeDocParser({ config: CONFIGURED, fetcher, force: true });
    expect(calls).toHaveLength(2);
  });

  it('a CONFIG CHANGE re-probes (cache keyed by type|baseUrl)', async () => {
    const { fetcher, calls } = probeFetcher(() => ({ ok: true, status: 200 }));
    await probeDocParser({ config: CONFIGURED, fetcher });
    await probeDocParser({ config: { type: 'docling', baseUrl: 'http://127.0.0.1:5001' }, fetcher });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('http://127.0.0.1:5001/health');
  });

  it('default config source = the sidecar read (writes take effect)', async () => {
    writeDocParserConfig({ type: 'custom', baseUrl: 'http://10.0.0.5:7000' });
    const { fetcher, calls } = probeFetcher(() => ({ ok: true, status: 200 }));
    const result = await probeDocParser({ fetcher });
    expect(result).toEqual({ ok: true, kind: 'custom' });
    expect(calls[0].url).toBe('http://10.0.0.5:7000/health');
  });
});
