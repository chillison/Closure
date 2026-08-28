/**
 * Search config sidecar + engine resolution (Story 3.6 WP4, R2 / design D9).
 *
 * Three concerns:
 *
 *   1. `search-config.yaml` sidecar IO — mirror of `research-net.yaml` (configIpc
 *      model dir + parseFlatYaml + atomicWrite; absent/corrupt/schema-invalid
 *      file degrades to the default so a broken config never bricks search).
 *      Arrays ride indexed flat keys (`engineOrder.0`, `searxngUrls.0`; wiki
 *      site overrides ride object-array keys `wikiSites.0.id`, … — the
 *      established models-array sidecar pattern; FlatConfig has no arrays).
 *      API keys are safeStorage-encrypted via the configIpc helpers (hand-edited
 *      plaintext still reads — decrypt passes non-encrypted shapes through).
 *   2. `probeSearxngLocalhost` — GET 127.0.0.1:8888 `/search?format=json` with a
 *      2s budget; a hit injects the `searxng-local` engine at chain head. The
 *      result is cached per process (plus a manual reset for the settings UI).
 *      This probe is the SANCTIONED localhost access (SSRF guard allowlist
 *      anchor, design D7) — it does not go through assertPublicHttpUrl.
 *   3. `buildEngineAdapters` — config + probe outcome → ordered adapter list,
 *      skipping engines whose prerequisites are absent (no probe hit → no
 *      searxng-local; no key → no tavily/bocha; unknown ids skipped for forward
 *      compat).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_SEARCH_ENGINE_ORDER,
  parseFlatYaml,
  stringifyFlatYaml,
  searchConfigSchema,
  type SearchConfig,
  type WikiSiteOverride,
} from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { decrypt, encrypt, getModelDir } from '../ipc/configIpc';
import { netFetch, readTextWithCap } from './netFetch';
import {
  createAnysearchAdapter,
  createBaiduHtmlAdapter,
  createBingHtmlAdapter,
  createBochaAdapter,
  createDdgHtmlAdapter,
  createSearxngAdapter,
  createTavilyAdapter,
  netEngineFetch,
  type EngineAdapter,
  type EngineFetcher,
  type EngineFetchResult,
} from './searchEngines';

// ── Sidecar IO ──

function getSearchConfigPath(): string {
  return path.join(getModelDir(), 'search-config.yaml');
}

/** Read `engineOrder.0`, `engineOrder.1`, … (all-empty/absent → undefined). */
function readIndexedStrings(raw: Record<string, unknown>, prefix: string): string[] | undefined {
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const v = raw[`${prefix}.${i}`];
    if (typeof v !== 'string') break;
    const t = v.trim();
    if (t) out.push(t);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Read `wikiSites.0.id`, `wikiSites.0.name`, … — the object-array sidecar pattern
 * (mirror of readKeyFile's `models.${i}.*` keys). A row missing any required
 * field STOPS the walk (trailing garbage never corrupts earlier rows); the
 * schema then re-validates whatever was collected.
 */
function readWikiSiteOverrides(raw: Record<string, unknown>): WikiSiteOverride[] | undefined {
  const out: WikiSiteOverride[] = [];
  for (let i = 0; ; i++) {
    const id = raw[`wikiSites.${i}.id`];
    const name = raw[`wikiSites.${i}.name`];
    const apiBaseUrl = raw[`wikiSites.${i}.apiBaseUrl`];
    const searchKind = raw[`wikiSites.${i}.searchKind`];
    if (
      typeof id !== 'string' || !id.trim()
      || typeof name !== 'string' || !name.trim()
      || typeof apiBaseUrl !== 'string' || !apiBaseUrl.trim()
      || (searchKind !== 'opensearch' && searchKind !== 'fulltext')
    ) break;
    out.push({
      id: id.trim(),
      name: name.trim(),
      apiBaseUrl: apiBaseUrl.trim(),
      searchKind,
      ...(raw[`wikiSites.${i}.fulltextOnMirror`] === true ? { fulltextOnMirror: true } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Read the persisted search config. Absent/corrupt/schema-invalid file degrades
 * to the default (zero-key chain) — never throws.
 */
export function readSearchConfig(): SearchConfig {
  try {
    const p = getSearchConfigPath();
    if (!existsSync(p)) return { ...DEFAULT_SEARCH_CONFIG };
    const raw = parseFlatYaml(readFileSync(p, 'utf-8')) as Record<string, unknown>;
    const parsed = searchConfigSchema.safeParse({
      engineOrder: readIndexedStrings(raw, 'engineOrder'),
      searxngUrls: readIndexedStrings(raw, 'searxngUrls'),
      searxngLocalhostProbe: typeof raw.searxngLocalhostProbe === 'boolean' ? raw.searxngLocalhostProbe : undefined,
      tavilyApiKey: typeof raw.tavilyApiKey === 'string' && raw.tavilyApiKey.trim() ? decrypt(raw.tavilyApiKey) : undefined,
      bochaApiKey: typeof raw.bochaApiKey === 'string' && raw.bochaApiKey.trim() ? decrypt(raw.bochaApiKey) : undefined,
      anysearchApiKey: typeof raw.anysearchApiKey === 'string' && raw.anysearchApiKey.trim() ? decrypt(raw.anysearchApiKey) : undefined,
      wikiSitesOverrides: readWikiSiteOverrides(raw),
    });
    return parsed.success ? parsed.data : { ...DEFAULT_SEARCH_CONFIG };
  } catch {
    return { ...DEFAULT_SEARCH_CONFIG };
  }
}

/**
 * Persist the search config (write path, consumed by the WP10 settings UI).
 * Validates via the schema — an invalid config throws ZodError to the caller
 * instead of silently persisting a dead chain. Never throws for cleanup errors.
 */
export function writeSearchConfig(config: SearchConfig): void {
  const parsed = searchConfigSchema.parse(config);
  const p = getSearchConfigPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const flat: Record<string, string | number | boolean | null> = {
    searxngLocalhostProbe: parsed.searxngLocalhostProbe,
  };
  parsed.engineOrder?.forEach((id, i) => {
    flat[`engineOrder.${i}`] = id;
  });
  parsed.searxngUrls?.forEach((url, i) => {
    flat[`searxngUrls.${i}`] = url;
  });
  parsed.wikiSitesOverrides?.forEach((site, i) => {
    flat[`wikiSites.${i}.id`] = site.id;
    flat[`wikiSites.${i}.name`] = site.name;
    flat[`wikiSites.${i}.apiBaseUrl`] = site.apiBaseUrl;
    flat[`wikiSites.${i}.searchKind`] = site.searchKind;
    if (site.fulltextOnMirror) flat[`wikiSites.${i}.fulltextOnMirror`] = true;
  });
  if (parsed.tavilyApiKey) flat.tavilyApiKey = encrypt(parsed.tavilyApiKey);
  if (parsed.bochaApiKey) flat.bochaApiKey = encrypt(parsed.bochaApiKey);
  if (parsed.anysearchApiKey) flat.anysearchApiKey = encrypt(parsed.anysearchApiKey);
  atomicWriteFileSync(p, stringifyFlatYaml(flat), 'utf-8');
}

// ── localhost SearXNG startup probe ──

/** Default local SearXNG port (design D9: `searxng/searxng` docker default 8888). */
export const SEARXNG_LOCALHOST_URL = 'http://127.0.0.1:8888';
export const SEARXNG_PROBE_TIMEOUT_MS = 2_000;
/**
 * Negative-result TTL (P14, CR 2026-08-15): a MISS only sticks for 60s — a
 * SearXNG instance started after the app must be discovered within a minute
 * without a manual refresh. A HIT sticks per process (a live local instance
 * going away mid-run just degrades one engine).
 */
export const SEARXNG_PROBE_MISS_TTL_MS = 60_000;

interface ProbeCacheEntry {
  hit: boolean;
  /** When this entry was recorded (negative entries expire, positives do not). */
  at: number;
}

/** `undefined` = not probed yet; positive hits stick, misses expire (P14). */
let localhostProbeCache: ProbeCacheEntry | undefined;

async function defaultProbeFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<EngineFetchResult> {
  const res = await netFetch(url, { ...init, signal: opts.signal }, { timeoutMs: opts.timeoutMs });
  const text = await readTextWithCap(res, 64 * 1024, url);
  return { status: res.status, ok: res.ok, text };
}

export interface SearxngProbeOpts {
  /** Bypass the per-process cache (settings-page refresh button). */
  force?: boolean;
  signal?: AbortSignal;
  /** Injectable fetcher (tests); defaults to netFetch. */
  fetcher?: EngineFetcher;
  /** Injectable clock (tests) for the negative-TTL matrix. */
  now?: () => number;
}

/**
 * Probe a localhost SearXNG instance. A HIT = 2xx + JSON body with a `results`
 * array (i.e. an instance with the json format actually enabled). Never throws
 * — transport failures count as a miss; the outcome is cached per process
 * (misses carry a 60s TTL, hits stick — P14).
 */
export async function probeSearxngLocalhost(opts: SearxngProbeOpts = {}): Promise<boolean> {
  const now = opts.now ?? Date.now;
  if (!opts.force && localhostProbeCache !== undefined) {
    const fresh = localhostProbeCache.hit
      || now() - localhostProbeCache.at < SEARXNG_PROBE_MISS_TTL_MS;
    if (fresh) return localhostProbeCache.hit;
  }
  const fetcher = opts.fetcher ?? defaultProbeFetch;
  let hit = false;
  try {
    const res = await fetcher(
      `${SEARXNG_LOCALHOST_URL}/search?q=test&format=json`,
      { headers: { accept: 'application/json' } },
      { signal: opts.signal, timeoutMs: SEARXNG_PROBE_TIMEOUT_MS },
    );
    if (res.ok) {
      try {
        const json = JSON.parse(res.text) as { results?: unknown };
        hit = Array.isArray(json?.results);
      } catch {
        hit = false;
      }
    }
  } catch {
    hit = false;
  }
  localhostProbeCache = { hit, at: now() };
  return hit;
}

/** Clear the per-process probe cache (settings-page refresh / tests). */
export function resetSearxngLocalhostProbe(): void {
  localhostProbeCache = undefined;
}

// ── Engine resolution ──

export interface BuildEnginesDeps {
  /** localhost probe outcome (handler awaits `probeSearxngLocalhost` first). */
  probeHit?: boolean;
  /** Fetcher seam for the built adapters (tests inject fixtures). */
  fetcher?: EngineFetcher;
}

/**
 * Resolve the ordered adapter list for a chain run (P22, CR 2026-08-15):
 *
 *   - EXPLICIT `engineOrder` is fully respected (unknown ids skipped for
 *     forward compat — a stale sidecar id never bricks the chain).
 *   - NO explicit order: the default chain is `[searxng-local, bing, baidu,
 *     ddg]` (probe-gated head), and every ACTIVE upgrade engine — a keyed
 *     tavily/bocha/anysearch, a URL-configured searxng — QUEUE-JUMPS to the
 *     FRONT (D9「插队」: configuring an upgrade layer is a deliberate choice,
 *     it must actually run before the free fallbacks instead of sitting
 *     unlisted behind them). AnySearch only queue-jumps WITH a key — a keyless
 *     third-party cloud service is never auto-inserted into the zero-key
 *     local-first default chain.
 */
export function buildEngineAdapters(config: SearchConfig, deps: BuildEnginesDeps = {}): EngineAdapter[] {
  const fetcher = deps.fetcher ?? netEngineFetch;
  const explicitOrder = config.engineOrder;
  const upgradeIds: string[] = [];
  if (config.searxngUrls?.length) upgradeIds.push('searxng');
  if (config.tavilyApiKey) upgradeIds.push('tavily');
  if (config.bochaApiKey) upgradeIds.push('bocha');
  if (config.anysearchApiKey) upgradeIds.push('anysearch');
  const order = explicitOrder ?? [...upgradeIds, ...DEFAULT_SEARCH_ENGINE_ORDER];
  const adapters: EngineAdapter[] = [];
  for (const id of order) {
    switch (id) {
      case 'searxng-local':
        // Only materializes when the probe hit (default order lists it first but
        // it is inert without a live local instance).
        if (config.searxngLocalhostProbe !== false && deps.probeHit === true) {
          adapters.push(createSearxngAdapter([SEARXNG_LOCALHOST_URL], fetcher, 'searxng-local', 'builtin'));
        }
        break;
      case 'searxng':
        if (config.searxngUrls?.length) adapters.push(createSearxngAdapter(config.searxngUrls, fetcher));
        break;
      case 'bing':
        adapters.push(createBingHtmlAdapter(fetcher));
        break;
      case 'baidu':
        adapters.push(createBaiduHtmlAdapter(fetcher));
        break;
      case 'ddg':
        adapters.push(createDdgHtmlAdapter(fetcher));
        break;
      case 'tavily':
        if (config.tavilyApiKey) adapters.push(createTavilyAdapter(config.tavilyApiKey, fetcher));
        break;
      case 'bocha':
        if (config.bochaApiKey) adapters.push(createBochaAdapter(config.bochaApiKey, fetcher));
        break;
      case 'anysearch':
        // Listed explicitly = activates with or without a key (anonymous
        // quota); auto-INSERTED only with a key (see module doc).
        adapters.push(createAnysearchAdapter(config.anysearchApiKey, fetcher));
        break;
      default:
        break; // unknown id — skipped (forward compat)
    }
  }
  return adapters;
}
