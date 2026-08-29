/**
 * Research settings IPC wiring tests (Story 3.6 WP10, design D14).
 *
 * The sidecar IO + probe/canary kernels run REAL (via _setModelConfigDirForTest,
 * mirror modelConfigIpc.test.ts); only electron, the configIpc db-imports, the
 * logger, and the two probe kernels are module-mocked (their own logic is
 * covered by docParserConfig.test.ts / visionAnalysis.test.ts). Locks:
 *
 * - load REDACTS search API keys ('' + `*Set` booleans) — the renderer must
 *   never see key material, even after a save with real keys.
 * - save treats '' / undefined keys as keep-existing (the writeModelConfig
 *   sentinel) — a redacted round-trip save must not wipe stored keys.
 * - save schema refines reject: `custom` proxy without proxyUrl, docParser
 *   type without baseUrl (invariant violations go the throw route, 模式 B).
 * - wiki site overrides round-trip through the aggregate + read-only presets.
 * - the two probe channels forward to the kernels with the settings-page
 *   semantics (doc probe force=true; canary takes the ref verbatim).
 */
import { rmBestEffort } from './rmBestEffort';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchConfigSave } from '@orison/shared-contracts';

const { handle, safeStorage, setProxy, reindexAll, reindexAllCraft, reindexAssetCards, reindexAllSettingMd, getProjectById, getProject, getDb, warn, info, probeDocParser, canaryProbeVision } = vi.hoisted(() => ({
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
  probeDocParser: vi.fn(),
  canaryProbeVision: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  session: {
    defaultSession: { setProxy: vi.fn() },
    // P2: applyResearchProxy (via writeResearchNetConfig on the save path)
    // instantiates the research partition session.
    fromPartition: vi.fn(() => ({ setProxy: vi.fn().mockResolvedValue(undefined), webRequest: { onBeforeRequest: vi.fn() } })),
  },
  net: { fetch: vi.fn() },
  app: { getPath: vi.fn(() => '/home') },
  dialog: {},
  clipboard: {},
  nativeImage: {},
  BrowserWindow: vi.fn(),
}));
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));
// The doc-parser sidecar IO (read/write) stays REAL so the aggregate round-trip
// exercises it; only the network probe kernel is stubbed (its own logic lives
// in docParserConfig.test.ts).
vi.mock('../main/research/docParserConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/research/docParserConfig')>();
  return { ...actual, probeDocParser };
});
vi.mock('../main/research/visionAnalysis', () => ({ canaryProbeVision }));

import { _setModelConfigDirForTest } from '../main/ipc/configIpc';
import { registerResearchConfigIpc } from '../main/ipc/researchConfigIpc';
import { readSearchConfig } from '../main/research/searchConfig';
import type { ResearchConfigView } from '@orison/shared-contracts';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-research-config-ipc');

type Handlers = Record<string, (...args: unknown[]) => unknown>;

function registeredHandlers(): Handlers {
  const out: Handlers = {};
  for (const [channel, handler] of handle.mock.calls) out[channel as string] = handler as (...args: unknown[]) => unknown;
  return out;
}

function basePayload(overrides: Partial<ResearchConfigSave> = {}): ResearchConfigSave {
  return {
    net: { proxyMode: 'system' },
    search: { searxngLocalhostProbe: true },
    docParser: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setProxy.mockReset().mockResolvedValue(undefined);
  handle.mockReset();
  _setModelConfigDirForTest(TEST_MODEL_DIR);
  rmBestEffort(TEST_MODEL_DIR);
});

afterEach(() => {
  _setModelConfigDirForTest(null);
  rmBestEffort(TEST_MODEL_DIR);
});

describe('research settings IPC', () => {
  it('registers exactly the four WP10 channels', () => {
    registerResearchConfigIpc();
    expect(Object.keys(registeredHandlers()).sort()).toEqual([
      'research:canary-vision',
      'research:load-config',
      'research:probe-doc-parser',
      'research:save-config',
    ]);
  });

  it('load returns the defaults (redacted empty keys, probe on, presets listed)', async () => {
    registerResearchConfigIpc();
    const h = registeredHandlers();
    const view = (await h['research:load-config']()) as ResearchConfigView;
    expect(view.search.tavilyApiKey).toBe('');
    expect(view.search.tavilyApiKeySet).toBe(false);
    expect(view.search.searxngLocalhostProbe).toBe(true);
    expect(view.net.proxyMode).toBe('system');
    expect(view.docParser).toEqual({});
    expect(view.wikiPresets.map((p) => p.id)).toEqual(['moegirl-cn', 'moegirl-uk']);
  });

  it('load REDACTS configured keys to "" with *Set=true (renderer never sees key material)', async () => {
    registerResearchConfigIpc();
    const h = registeredHandlers();
    await h['research:save-config'](
      {},
      basePayload({ search: { searxngLocalhostProbe: true, tavilyApiKey: 'tvly-secret', bochaApiKey: 'bocha-secret' } }),
    );

    const view = (await h['research:load-config']()) as ResearchConfigView;
    expect(view.search.tavilyApiKey).toBe('');
    expect(view.search.bochaApiKey).toBe('');
    expect(view.search.anysearchApiKey).toBe('');
    expect(view.search.tavilyApiKeySet).toBe(true);
    expect(view.search.bochaApiKeySet).toBe(true);
    expect(view.search.anysearchApiKeySet).toBe(false);
    // The real keys DID persist (the sentinel merge kept them).
    expect(readSearchConfig().tavilyApiKey).toBe('tvly-secret');
    expect(readSearchConfig().bochaApiKey).toBe('bocha-secret');
  });

  it('save with redacted keys KEEPS the persisted ones (writeModelConfig sentinel)', async () => {
    registerResearchConfigIpc();
    const h = registeredHandlers();
    await h['research:save-config'](
      {},
      basePayload({ search: { searxngLocalhostProbe: true, tavilyApiKey: 'tvly-secret' } }),
    );
    // Second save round-trips the REDACTED view (keys '' / absent).
    await h['research:save-config'](
      {},
      basePayload({ search: { searxngLocalhostProbe: false, tavilyApiKey: '', bochaApiKey: undefined } }),
    );

    const persisted = readSearchConfig();
    expect(persisted.tavilyApiKey).toBe('tvly-secret'); // sentinel kept it
    expect(persisted.searxngLocalhostProbe).toBe(false); // non-secret field took the new value
  });

  it('P6: null explicitly CLEARS a persisted key (the sidecar field is deleted)', async () => {
    registerResearchConfigIpc();
    const h = registeredHandlers();
    await h['research:save-config'](
      {},
      basePayload({
        search: { searxngLocalhostProbe: true, tavilyApiKey: 'tvly-secret', bochaApiKey: 'bocha-secret' },
      }),
    );

    // Clear ONLY tavily (null); bocha rides the '' keep-sentinel.
    await h['research:save-config'](
      {},
      basePayload({
        search: { searxngLocalhostProbe: true, tavilyApiKey: null, bochaApiKey: '' },
      }),
    );

    const persisted = readSearchConfig();
    expect(persisted.tavilyApiKey).toBeUndefined(); // cleared
    expect(persisted.bochaApiKey).toBe('bocha-secret'); // kept

    // The load view reflects the clear (*Set=false).
    const view = (await h['research:load-config']()) as ResearchConfigView;
    expect(view.search.tavilyApiKeySet).toBe(false);
    expect(view.search.bochaApiKeySet).toBe(true);
  });

  it('save rejects custom proxy without proxyUrl (schema refine, throw route)', async () => {
    registerResearchConfigIpc();
    const h = registeredHandlers();
    await expect(
      h['research:save-config']({}, basePayload({ net: { proxyMode: 'custom' } })),
    ).rejects.toThrow();
  });

  it('save rejects docParser type without baseUrl (all-or-nothing refine)', async () => {
    registerResearchConfigIpc();
    const h = registeredHandlers();
    await expect(
      h['research:save-config']({}, basePayload({ docParser: { type: 'mineru' } })),
    ).rejects.toThrow();
  });

  it('wiki site overrides round-trip through the aggregate save/load', async () => {
    registerResearchConfigIpc();
    const h = registeredHandlers();
    await h['research:save-config'](
      {},
      basePayload({
        search: {
          searxngLocalhostProbe: true,
          wikiSitesOverrides: [
            { id: 'prts', name: 'PRTS', apiBaseUrl: 'https://prts.wiki', searchKind: 'fulltext', fulltextOnMirror: true },
          ],
        },
      }),
    );

    const view = (await h['research:load-config']()) as ResearchConfigView;
    expect(view.search.wikiSitesOverrides).toEqual([
      { id: 'prts', name: 'PRTS', apiBaseUrl: 'https://prts.wiki', searchKind: 'fulltext', fulltextOnMirror: true },
    ]);
    expect(readSearchConfig().wikiSitesOverrides).toHaveLength(1);
  });

  it('saving the aggregate without overrides clears them (explicit list wins, no stale merge)', async () => {
    registerResearchConfigIpc();
    const h = registeredHandlers();
    await h['research:save-config'](
      {},
      basePayload({
        search: {
          searxngLocalhostProbe: true,
          wikiSitesOverrides: [{ id: 'prts', name: 'PRTS', apiBaseUrl: 'https://prts.wiki', searchKind: 'fulltext' }],
        },
      }),
    );
    await h['research:save-config']({}, basePayload());

    expect(readSearchConfig().wikiSitesOverrides).toBeUndefined();
  });

  it('doc-parser probe channel forwards with force=true (settings-page refresh semantics)', async () => {
    probeDocParser.mockResolvedValue({ ok: true, kind: 'mineru' });
    registerResearchConfigIpc();
    const h = registeredHandlers();
    const result = await h['research:probe-doc-parser']();
    expect(probeDocParser).toHaveBeenCalledWith({ force: true });
    expect(result).toEqual({ ok: true, kind: 'mineru' });
  });

  it('canary channel forwards the ref verbatim and returns the structured verdict', async () => {
    canaryProbeVision.mockResolvedValue({ ok: true, answer: '闭' });
    registerResearchConfigIpc();
    const h = registeredHandlers();
    const ref = { keyId: 'key_001', modelId: 'qwen-vl-max' };
    const result = await h['research:canary-vision']({}, ref);
    expect(canaryProbeVision).toHaveBeenCalledWith(ref);
    expect(result).toEqual({ ok: true, answer: '闭' });
  });
});
