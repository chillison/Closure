/**
 * Search chain executor (Story 3.6 WP4, R2 / design D9).
 *
 * Walks the resolved adapter list in priority order:
 *
 *   per engine → EngineGate.acquire(host) [min 500ms between calls to the same
 *   engine host] → adapter.search() → first engine with ≥1 hit WINS (its hits
 *   return, `engine`-tagged). A failure records {engine, reason, detail} and
 *   the chain falls through to the next engine. ALL engines failing resolves
 *   `{hits: [], failures}` — the handler turns that into the friendly
 *   per-engine summary. NEVER throws (R8 graceful degradation).
 *
 * Same-query results ride the shared `LruTtlCache` (TTL 10min, LRU 50, WP2
 * netGuard): the cache key = query + adapter ids + searxngUrls (everything that
 * changes the answer — API keys are deliberately NOT in the key: secrets never
 * enter cache keys, and key presence is already encoded by which adapters
 * exist). All-fail outcomes are NOT cached — a transient outage must not go
 * sticky for 10 minutes.
 *
 * Results: capped at 10 per engine, deduped by exact URL (SERP pages sometimes
 * repeat a link within one engine).
 *
 * Pure orchestration — no electron import; the whole degrade matrix is unit-
 * testable with stub adapters + injectable gate/cache.
 */
import { ResearchNetworkError } from './netFetch';
import { EngineGate, LruTtlCache, createSearchResultCache } from './netGuard';
import { EngineUnavailableError, type EngineAdapter, type EngineFailureReason, type SearchHit } from './searchEngines';
import type { SearchConfig } from '@orison/shared-contracts';

// ── Types ──

export interface ChainEngineFailure {
  engine: string;
  reason: EngineFailureReason;
  detail: string;
}

export interface SearchChainOutcome {
  hits: SearchHit[];
  /** Engines that ran and failed, in order (empty when the first engine hit). */
  failures: ChainEngineFailure[];
  /** Adapter id that produced the hits (first-hit-wins). */
  engine?: string;
  fromCache?: boolean;
}

export interface SearchChainDeps {
  /** Resolved + ordered adapters (buildEngineAdapters). */
  adapters: readonly EngineAdapter[];
  /** Per-host throttle (tests pass a zero-interval gate). */
  gate?: EngineGate;
  /** Same-query cache (tests inject a deterministic-now cache). */
  cache?: LruTtlCache<SearchChainOutcome>;
  /** External abort (tool run aborts stop the chain between engines). */
  signal?: AbortSignal;
}

/** Max hits taken from a single engine (design D9). */
export const PER_ENGINE_RESULT_CAP = 10;

/** Module-level defaults shared by handler runs. */
const defaultChainGate = new EngineGate();
const defaultChainCache = createSearchResultCache<SearchChainOutcome>();

/**
 * Same-query in-flight merges (P8, CR 2026-08-15): the TTL cache only dedupes
 * SETTLED results — two concurrent tool calls with the same query would both
 * fire the whole engine chain (duplicate engine hits are exactly what the
 * anti-ban throttle exists to prevent). Concurrent callers share ONE run.
 */
const inFlightChains = new Map<string, Promise<SearchChainOutcome>>();

/** Stand-in signal when deps carry none (a bare signal that never aborts). */
const neverAbort = new AbortController().signal;

/**
 * Cache fingerprint: query + ordered adapter ids + searxng URLs. Two searxng
 * URL lists under the same adapter id produce different answers, so the URLs
 * ride the key; API keys never do (see module doc). The separator inside the
 * template below is the u0000 ESCAPE SEQUENCE (P5, CR 2026-08-15) — the raw
 * NUL byte previously embedded here made git treat this file as binary (no
 * diff/blame); the escape produces the identical runtime string while keeping
 * the source textual.
 */
export function searchChainCacheKey(query: string, adapters: readonly EngineAdapter[], config: SearchConfig): string {
  const ids = adapters.map((a) => a.id).join(',');
  const urls = (config.searxngUrls ?? []).join('|');
  return `${query}\u0000${ids}\u0000${urls}`;
}

/**
 * Classify any thrown value into a chain failure record. `EngineUnavailableError`
 * keeps its own taxonomy; transport-layer `ResearchNetworkError` maps
 * (timeout→timeout, http-status→http, network/abort→network); anything else is
 * a network-class failure with the raw message (a stub adapter throwing a
 * plain Error still degrades instead of killing the chain).
 */
export function describeEngineFailure(engineId: string, err: unknown): ChainEngineFailure {
  if (err instanceof EngineUnavailableError) {
    return { engine: err.engineId || engineId, reason: err.reason, detail: err.message };
  }
  if (err instanceof ResearchNetworkError) {
    const reason: EngineFailureReason =
      err.reason === 'timeout' ? 'timeout' : err.reason === 'http-status' ? 'http' : 'network';
    return { engine: engineId, reason, detail: err.message };
  }
  return { engine: engineId, reason: 'network', detail: err instanceof Error ? err.message : String(err) };
}

/** Run the engine chain. NEVER throws — see module doc. */
export async function runSearchChain(
  query: string,
  config: SearchConfig,
  deps: SearchChainDeps,
): Promise<SearchChainOutcome> {
  const gate = deps.gate ?? defaultChainGate;
  const cache = deps.cache ?? defaultChainCache;
  const q = query.trim();
  if (!q) return { hits: [], failures: [] };

  const cacheKey = searchChainCacheKey(q, deps.adapters, config);
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  // P8 in-flight merge: a concurrent same-fingerprint call joins the RUNNING
  // promise instead of firing a second engine chain.
  const pending = inFlightChains.get(cacheKey);
  if (pending) return { ...(await pending) };

  const run = runChainOnce(q, cacheKey, gate, cache, deps);
  inFlightChains.set(cacheKey, run);
  try {
    return await run;
  } finally {
    inFlightChains.delete(cacheKey);
  }
}

/** The single-run engine walk (cache + in-flight bookkeeping live above). */
async function runChainOnce(
  q: string,
  cacheKey: string,
  gate: EngineGate,
  cache: LruTtlCache<SearchChainOutcome>,
  deps: SearchChainDeps,
): Promise<SearchChainOutcome> {
  const failures: ChainEngineFailure[] = [];
  const seenUrls = new Set<string>();
  for (const adapter of deps.adapters) {
    // An aborted tool run stops the chain between engines (the tool layer's own
    // post-check surfaces the abort; no point firing further engines).
    if (deps.signal?.aborted) break;

    for (const host of adapter.hosts) {
      await gate.acquire(host);
    }

    let hits: SearchHit[];
    try {
      hits = await adapter.search(q, deps.signal ?? neverAbort);
    } catch (err) {
      failures.push(describeEngineFailure(adapter.id, err));
      continue;
    }

    const deduped: SearchHit[] = [];
    for (const hit of hits.slice(0, PER_ENGINE_RESULT_CAP)) {
      if (seenUrls.has(hit.url)) continue;
      seenUrls.add(hit.url);
      deduped.push(hit);
    }
    if (deduped.length === 0) {
      // Adapters never resolve [] as success, so this is a defensive branch —
      // e.g. an all-duplicate hit list from a hand-written adapter.
      failures.push({ engine: adapter.id, reason: 'empty', detail: `「${q}」无有效搜索结果` });
      continue;
    }

    const outcome: SearchChainOutcome = { hits: deduped, failures, engine: adapter.id };
    cache.set(cacheKey, outcome);
    return outcome;
  }

  // Every engine failed (or none ran) — NOT cached (transient outages must not
  // go sticky); the handler renders the per-engine summary.
  return { hits: [], failures };
}
