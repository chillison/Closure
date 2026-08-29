/**
 * Search config tests (Story 3.6 WP4 / design D9).
 *
 * Covers: the `searchConfigSchema` boundary (defaults + `.min(1)` optional-array
 * two-state contract), the `search-config.yaml` sidecar round-trip (indexed
 * flat-key arrays + safeStorage-encrypted API keys; absent/corrupt/schema-
 * invalid degrade to default), the localhost SearXNG probe (hit/miss/timeout +
 * per-process cache + force refresh), and the buildEngineAdapters resolution
 * matrix (probe gating, key gating, anonymous anysearch, unknown-id skip,
 * order preservation).
 *
 * Mocks mirror researchNetConfig.test.ts (electron + configIpc db-imports +
 * logger): plain vitest, no real ~/.orison writes, ZERO network.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchConfigSchema } from '@orison/shared-contracts';

const { handle, safeStorage, setProxy, reindexAll, reindexAllCraft, reindexAssetCards, reindexAllSettingMd, getProjectById, getProject, getDb, warn, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  setProxy: vi.fn().mockResolvedValue(undefined),
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
  session: { defaultSession: { setProxy } },
  net: { fetch: vi.fn() },
}));
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import { _setModelConfigDirForTest } from '../main/ipc/configIpc';
import {
  SEARXNG_LOCALHOST_URL,
  buildEngineAdapters,
  probeSearxngLocalhost,
  readSearchConfig,
  resetSearxngLocalhostProbe,
  writeSearchConfig,
} from '../main/research/searchConfig';
import type { EngineFetchResult, EngineFetcher } from '../main/research/searchEngines';
import type { SearchConfig } from '@orison/shared-contracts';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-search-config');

beforeEach(() => {
  vi.clearAllMocks();
  setProxy.mockReset().mockResolvedValue(undefined);
  getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });
  _setModelConfigDirForTest(TEST_MODEL_DIR);
  resetSearxngLocalhostProbe();
  rmBestEffort(TEST_MODEL_DIR);
});

afterEach(() => {
  _setModelConfigDirForTest(null);
  resetSearxngLocalhostProbe();
  rmBestEffort(TEST_MODEL_DIR);
});

// ── Schema boundary (shared-contracts) ──

describe('searchConfigSchema', () => {
  it('defaults: localhost probe on, no engines configured (zero-key chain)', () => {
    expect(searchConfigSchema.parse({})).toEqual({ searxngLocalhostProbe: true });
  });

  it('optional arrays are two-state: empty [] rejected, ≥1 accepted (spec convention)', () => {
    expect(() => searchConfigSchema.parse({ searxngUrls: [] })).toThrow();
    expect(() => searchConfigSchema.parse({ engineOrder: [] })).toThrow();
    expect(searchConfigSchema.parse({ searxngUrls: ['http://127.0.0.1:8888'] }).searxngUrls).toEqual(['http://127.0.0.1:8888']);
  });

  it('keys are optional non-empty trimmed strings; anysearch works without one', () => {
    expect(() => searchConfigSchema.parse({ tavilyApiKey: '   ' })).toThrow();
    expect(searchConfigSchema.parse({ anysearchApiKey: undefined }).anysearchApiKey).toBeUndefined();
  });
});

// ── Sidecar round-trip ──

describe('search-config.yaml sidecar', () => {
  it('absent file → default config', () => {
    expect(readSearchConfig()).toEqual({ searxngLocalhostProbe: true });
  });

  it('write → read round-trips engineOrder + searxngUrls + keys + probe flag', () => {
    writeSearchConfig({
      searxngLocalhostProbe: false,
      engineOrder: ['tavily', 'bing'],
      searxngUrls: ['https://searx.example.com', 'http://127.0.0.1:8888'],
      tavilyApiKey: 'tvly-abc',
    });
    expect(readSearchConfig()).toEqual({
      searxngLocalhostProbe: false,
      engineOrder: ['tavily', 'bing'],
      searxngUrls: ['https://searx.example.com', 'http://127.0.0.1:8888'],
      tavilyApiKey: 'tvly-abc',
    });
    // safeStorage unavailable in tests → plaintext passthrough (documented fallback)
    const raw = readFileSync(path.join(TEST_MODEL_DIR, 'search-config.yaml'), 'utf-8');
    expect(raw).toContain('engineOrder.0: tavily');
    expect(raw).toContain('searxngUrls.1: http://127.0.0.1:8888');
    expect(raw).toContain('searxngLocalhostProbe: false');
  });

  it('hand-edited PLAINTEXT key still reads (decrypt passes non-encrypted shapes through)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'search-config.yaml'),
      ['searxngLocalhostProbe: true', 'tavilyApiKey: tvly-plain'].join('\n'),
      'utf-8',
    );
    expect(readSearchConfig().tavilyApiKey).toBe('tvly-plain');
  });

  it('corrupt / schema-invalid file degrades to default (never bricks search)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    const file = path.join(TEST_MODEL_DIR, 'search-config.yaml');
    writeFileSync(file, '::: not [ valid yaml {{{', 'utf-8');
    expect(readSearchConfig()).toEqual({ searxngLocalhostProbe: true });

    writeFileSync(file, 'searxngUrls.0: ""\nsearxngLocalhostProbe: maybe\n', 'utf-8');
    expect(readSearchConfig()).toEqual({ searxngLocalhostProbe: true });
  });

  it('writeSearchConfig REJECTS an invalid config (no silent dead-chain persist)', () => {
    expect(() => writeSearchConfig({ searxngLocalhostProbe: true, searxngUrls: [] })).toThrow();
    expect(existsSync(path.join(TEST_MODEL_DIR, 'search-config.yaml'))).toBe(false);
  });

  // WP10: custom wiki sites ride the same sidecar as object-array indexed keys
  // (`wikiSites.0.id`, … — the readKeyFile models-array pattern).
  it('write → read round-trips wikiSitesOverrides (object-array indexed flat keys)', () => {
    writeSearchConfig({
      searxngLocalhostProbe: true,
      wikiSitesOverrides: [
        { id: 'prts', name: 'PRTS', apiBaseUrl: 'https://prts.wiki/', searchKind: 'fulltext', fulltextOnMirror: true },
        { id: 'fandom-ark', name: 'Fandom Ark', apiBaseUrl: 'https://arknights.fandom.com', searchKind: 'opensearch' },
      ],
    });
    const read = readSearchConfig().wikiSitesOverrides;
    expect(read).toHaveLength(2);
    // Trailing slash normalized away on the persisted read path (loadWikiSites
    // semantics start at the handler; the sidecar keeps the raw trimmed value).
    expect(read?.[0]).toMatchObject({ id: 'prts', name: 'PRTS', searchKind: 'fulltext', fulltextOnMirror: true });
    expect(read?.[1]).toMatchObject({ id: 'fandom-ark', searchKind: 'opensearch' });
    expect(read?.[1]?.fulltextOnMirror).toBeUndefined();
    const raw = readFileSync(path.join(TEST_MODEL_DIR, 'search-config.yaml'), 'utf-8');
    expect(raw).toContain('wikiSites.0.id: prts');
    expect(raw).toContain('wikiSites.0.searchKind: fulltext');
    expect(raw).toContain('wikiSites.0.fulltextOnMirror: true');
    expect(raw).toContain('wikiSites.1.apiBaseUrl: https://arknights.fandom.com');
  });

  it('a wikiSites row missing a required field stops the walk (trailing garbage never corrupts earlier rows)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'search-config.yaml'),
      [
        'searxngLocalhostProbe: true',
        'wikiSites.0.id: prts',
        'wikiSites.0.name: PRTS',
        'wikiSites.0.apiBaseUrl: https://prts.wiki',
        'wikiSites.0.searchKind: fulltext',
        // Row 1 lost its searchKind → the walk stops here; row 0 survives intact.
        'wikiSites.1.id: broken',
        'wikiSites.1.name: Broken',
      ].join('\n'),
      'utf-8',
    );
    expect(readSearchConfig().wikiSitesOverrides).toEqual([
      { id: 'prts', name: 'PRTS', apiBaseUrl: 'https://prts.wiki', searchKind: 'fulltext' },
    ]);
  });
});

// ── localhost SearXNG probe ──

describe('probeSearxngLocalhost', () => {
  const signal = new AbortController().signal;

  function fetcherReturning(result: Partial<EngineFetchResult> | Error): { fn: EngineFetcher; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fn: async (url) => {
        calls.push(url);
        if (result instanceof Error) throw result;
        return { status: 200, ok: true, text: '', ...result };
      },
    };
  }

  it('2xx + json with results[] → hit', async () => {
    const { fn, calls } = fetcherReturning({ text: '{"results":[{"title":"t","url":"https://x","content":"c"}]}' });
    await expect(probeSearxngLocalhost({ fetcher: fn, signal })).resolves.toBe(true);
    expect(calls[0]).toBe(`${SEARXNG_LOCALHOST_URL}/search?q=test&format=json`);
  });

  it('200 non-json / json without results / non-2xx / network error → miss (never throws)', async () => {
    await expect(probeSearxngLocalhost({ fetcher: fetcherReturning({ text: '<html>html format only</html>' }).fn, signal })).resolves.toBe(false);
    resetSearxngLocalhostProbe();
    await expect(probeSearxngLocalhost({ fetcher: fetcherReturning({ text: '{"query":"test"}' }).fn, signal })).resolves.toBe(false);
    resetSearxngLocalhostProbe();
    await expect(probeSearxngLocalhost({ fetcher: fetcherReturning({ status: 403, ok: false, text: 'forbidden' }).fn, signal })).resolves.toBe(false);
    resetSearxngLocalhostProbe();
    await expect(probeSearxngLocalhost({ fetcher: fetcherReturning(new Error('ECONNREFUSED')).fn, signal })).resolves.toBe(false);
  });

  it('result is cached per process; force bypasses the cache', async () => {
    const miss = fetcherReturning({ text: '{}' });
    await expect(probeSearxngLocalhost({ fetcher: miss.fn, signal })).resolves.toBe(false);
    expect(miss.calls.length).toBe(1);

    // Cached — second call does not refetch even with a hitting fetcher.
    const hit = fetcherReturning({ text: '{"results":[]}' });
    await expect(probeSearxngLocalhost({ fetcher: hit.fn, signal })).resolves.toBe(false);
    expect(hit.calls.length).toBe(0);

    // force re-probes.
    await expect(probeSearxngLocalhost({ fetcher: hit.fn, signal, force: true })).resolves.toBe(true);
    expect(hit.calls.length).toBe(1);
  });

  it('resetSearxngLocalhostProbe clears the cache', async () => {
    await expect(probeSearxngLocalhost({ fetcher: fetcherReturning({ text: '{}' }).fn, signal })).resolves.toBe(false);
    resetSearxngLocalhostProbe();
    const hit = fetcherReturning({ text: '{"results":[]}' });
    await expect(probeSearxngLocalhost({ fetcher: hit.fn, signal })).resolves.toBe(true);
  });

  // ── P14 (CR 2026-08-15): negative-result TTL ──

  it('P14: a MISS expires after 60s (a SearXNG started after the app is discovered); a HIT sticks per process', async () => {
    let t = 1_000_000;
    const miss = fetcherReturning({ text: '{}' });
    await expect(probeSearxngLocalhost({ fetcher: miss.fn, signal, now: () => t })).resolves.toBe(false);
    expect(miss.calls.length).toBe(1);

    // +30s: still cached (miss TTL is 60s).
    t += 30_000;
    await expect(probeSearxngLocalhost({ fetcher: miss.fn, signal, now: () => t })).resolves.toBe(false);
    expect(miss.calls.length).toBe(1);

    // +61s total: the negative verdict expired → re-probe fires (and hits now).
    t += 31_000;
    const turnedOn = fetcherReturning({ text: '{"results":[]}' });
    await expect(probeSearxngLocalhost({ fetcher: turnedOn.fn, signal, now: () => t })).resolves.toBe(true);
    expect(turnedOn.calls.length).toBe(1);

    // A HIT never expires within the process.
    const later = fetcherReturning({ text: '{}' });
    t += 10 * 60_000;
    await expect(probeSearxngLocalhost({ fetcher: later.fn, signal, now: () => t })).resolves.toBe(true);
    expect(later.calls.length).toBe(0);
  });
});

// ── Engine resolution ──

describe('buildEngineAdapters', () => {
  const fetcher = (async () => ({ status: 500, ok: false, text: '' })) as EngineFetcher;

  it('default order: searxng-local absent without a probe hit → bing/baidu/ddg builtins', () => {
    const adapters = buildEngineAdapters({ searxngLocalhostProbe: true }, { fetcher });
    expect(adapters.map((a) => a.id)).toEqual(['bing', 'baidu', 'ddg']);
    expect(adapters.every((a) => a.kind === 'builtin')).toBe(true);
  });

  it('probe hit injects searxng-local first (probed local instance = builtin, zero-config)', () => {
    const adapters = buildEngineAdapters({ searxngLocalhostProbe: true }, { probeHit: true, fetcher });
    expect(adapters.map((a) => a.id)).toEqual(['searxng-local', 'bing', 'baidu', 'ddg']);
    expect(adapters[0]?.kind).toBe('builtin');
    expect(adapters[0]?.hosts).toEqual(['127.0.0.1']);
  });

  it('probe disabled in config → searxng-local never built, even on a hit', () => {
    const adapters = buildEngineAdapters({ searxngLocalhostProbe: false }, { probeHit: true, fetcher });
    expect(adapters.map((a) => a.id)).toEqual(['bing', 'baidu', 'ddg']);
  });

  it('configured engines: searxng needs urls; tavily/bocha need keys; anysearch activates keyless', () => {
    const cfg: SearchConfig = {
      searxngLocalhostProbe: false,
      engineOrder: ['searxng', 'tavily', 'bocha', 'anysearch'],
    };
    expect(buildEngineAdapters(cfg, { fetcher }).map((a) => a.id)).toEqual(['anysearch']); // all prerequisites missing

    const full: SearchConfig = {
      ...cfg,
      searxngUrls: ['https://searx.example.com'],
      tavilyApiKey: 'tvly-x',
      bochaApiKey: 'sk-x',
    };
    expect(buildEngineAdapters(full, { fetcher }).map((a) => (a.id))).toEqual(['searxng', 'tavily', 'bocha', 'anysearch']);
    expect(buildEngineAdapters(full, { fetcher }).every((a) => a.kind === 'configured')).toBe(true);
  });

  it('custom engineOrder respected in order; unknown ids silently skipped (forward compat)', () => {
    const adapters = buildEngineAdapters(
      { searxngLocalhostProbe: true, engineOrder: ['ddg', 'baidu', 'future-engine', 'bing'] },
      { fetcher },
    );
    expect(adapters.map((a) => a.id)).toEqual(['ddg', 'baidu', 'bing']);
  });

  // ── P22 (CR 2026-08-15): active upgrade engines QUEUE-JUMP without an explicit order ──

  it('P22: keyed upgrade engines + configured searxng queue-jump AHEAD of the default chain (no explicit engineOrder)', () => {
    const adapters = buildEngineAdapters(
      {
        searxngLocalhostProbe: true,
        searxngUrls: ['http://192.168.1.5:8888'],
        tavilyApiKey: 'tvly-x',
        bochaApiKey: 'sk-x',
        anysearchApiKey: 'any-x',
      },
      { probeHit: true, fetcher },
    );
    expect(adapters.map((a) => a.id)).toEqual([
      'searxng', // URL-configured searxng
      'tavily', // keyed upgrades, SEARCH_ENGINE_IDS relative order
      'bocha',
      'anysearch',
      'searxng-local', // then the default chain, untouched
      'bing',
      'baidu',
      'ddg',
    ]);
  });

  it('P22: keyless anysearch is NEVER auto-inserted (zero-key local-first default chain); keyless = default order', () => {
    const adapters = buildEngineAdapters({ searxngLocalhostProbe: true }, { fetcher });
    expect(adapters.map((a) => a.id)).toEqual(['bing', 'baidu', 'ddg']);
  });

  it('P22: an EXPLICIT engineOrder is fully respected even when upgrade engines are keyed (no queue-jump)', () => {
    const adapters = buildEngineAdapters(
      {
        searxngLocalhostProbe: true,
        engineOrder: ['bing', 'tavily', 'baidu'],
        tavilyApiKey: 'tvly-x',
      },
      { fetcher },
    );
    expect(adapters.map((a) => a.id)).toEqual(['bing', 'tavily', 'baidu']);
  });

  it('hosts are exposed for the chain EngineGate', () => {
    const [bing] = buildEngineAdapters({ searxngLocalhostProbe: true }, { fetcher });
    expect(bing?.hosts).toEqual(['cn.bing.com']);
  });
});
