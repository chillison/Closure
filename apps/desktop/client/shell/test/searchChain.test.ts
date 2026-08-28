/**
 * Search chain executor tests (Story 3.6 WP4 / design D9) — the degrade matrix.
 *
 * ZERO network: stub adapters (deterministic hits / typed failures) + injected
 * zero-interval EngineGate + deterministic-now LruTtlCache. electron stubbed so
 * the real netFetch/netGuard modules load (ResearchNetworkError identity).
 *
 * Matrix: first-hit wins / timeout degrade / anti-bot degrade / empty degrade /
 * all-fail graceful summary / cache hit (+fingerprint) / all-fail NOT cached /
 * per-engine cap / url dedup / EngineGate per-host acquire / abort stops chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

import { ResearchNetworkError } from '../main/research/netFetch';
import { EngineGate, LruTtlCache, createSearchResultCache } from '../main/research/netGuard';
import { EngineUnavailableError, type EngineAdapter, type SearchHit } from '../main/research/searchEngines';
import {
  PER_ENGINE_RESULT_CAP,
  describeEngineFailure,
  runSearchChain,
  searchChainCacheKey,
  type SearchChainOutcome,
} from '../main/research/searchChain';
import type { SearchConfig } from '@orison/shared-contracts';

const signal = new AbortController().signal;

function hit(engine: string, n = 1): SearchHit[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `${engine}-${i}`,
    url: `https://${engine}.example.com/${i}`,
    snippet: 's',
    engine,
  }));
}

function adapter(
  id: string,
  impl: (query: string, signal: AbortSignal) => Promise<SearchHit[]>,
  hosts: string[] = [`${id}.example.com`],
): EngineAdapter {
  return { id, kind: 'builtin', hosts, search: impl };
}

/** Adapter that throws a typed engine failure. */
function failing(id: string, reason: 'timeout' | 'anti-bot' | 'empty' | 'http' | 'network' | 'transport-timeout' | 'transport-network' | 'transport-abort', hosts?: string[]): EngineAdapter {
  const impl = async () => {
    if (reason === 'transport-timeout') throw new ResearchNetworkError('timeout', '请求超时（10000ms）：x');
    if (reason === 'transport-network') throw new ResearchNetworkError('network', '网络请求失败：x');
    if (reason === 'transport-abort') throw new ResearchNetworkError('abort', '请求已取消：x');
    throw new EngineUnavailableError(id, reason, `${id}-${reason}`);
  };
  return adapter(id, impl, hosts);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runSearchChain — degrade matrix', () => {
  it('first engine with ≥1 hit wins; its hits return engine-tagged, failures stay empty', async () => {
    const outcome = await runSearchChain('q', config(), {
      adapters: [adapter('bing', async () => hit('bing', 2))],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal,
    });
    expect(outcome.engine).toBe('bing');
    expect(outcome.hits.length).toBe(2);
    expect(outcome.hits.every((h) => h.engine === 'bing')).toBe(true);
    expect(outcome.failures).toEqual([]);
    expect(outcome.fromCache).toBeUndefined();
  });

  it('timeout on engine 1 → degrades to engine 2 (failure recorded with reason)', async () => {
    const outcome = await runSearchChain('q', config(), {
      adapters: [
        failing('bing', 'transport-timeout'),
        adapter('baidu', async () => hit('baidu')),
      ],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal,
    });
    expect(outcome.engine).toBe('baidu');
    expect(outcome.failures).toEqual([{ engine: 'bing', reason: 'timeout', detail: '请求超时（10000ms）：x' }]);
  });

  it('anti-bot and empty degrade too; engine-specific failures keep their taxonomy', async () => {
    const outcome = await runSearchChain('q', config(), {
      adapters: [
        failing('bing', 'anti-bot'),
        failing('baidu', 'empty'),
        adapter('ddg', async () => hit('ddg')),
      ],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal,
    });
    expect(outcome.engine).toBe('ddg');
    expect(outcome.failures.map((f) => `${f.engine}:${f.reason}`)).toEqual(['bing:anti-bot', 'baidu:empty']);
  });

  it('http-status transport error maps to http; plain Error maps to network', async () => {
    const outcome = await runSearchChain('q', config(), {
      adapters: [
        failing('bing', 'http'),
        failing('baidu', 'transport-network'),
        failing('ddg', 'network'),
        adapter('tavily', async () => hit('tavily')),
      ],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal,
    });
    expect(outcome.engine).toBe('tavily');
    expect(outcome.failures.map((f) => f.reason)).toEqual(['http', 'network', 'network']);
  });

  it('ALL engines fail → {hits: [], failures} graceful summary — never throws', async () => {
    const outcome = await runSearchChain('q', config(), {
      adapters: [failing('bing', 'transport-timeout'), failing('baidu', 'anti-bot'), failing('ddg', 'transport-network')],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal,
    });
    expect(outcome).toEqual({
      hits: [],
      failures: [
        { engine: 'bing', reason: 'timeout', detail: '请求超时（10000ms）：x' },
        { engine: 'baidu', reason: 'anti-bot', detail: 'baidu-anti-bot' },
        { engine: 'ddg', reason: 'network', detail: '网络请求失败：x' },
      ],
    });
  });

  it('caps results at PER_ENGINE_RESULT_CAP per engine', async () => {
    const outcome = await runSearchChain('q', config(), {
      adapters: [adapter('bing', async () => hit('bing', 25))],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal,
    });
    expect(outcome.hits.length).toBe(PER_ENGINE_RESULT_CAP);
    expect(PER_ENGINE_RESULT_CAP).toBe(10);
  });

  it('dedups repeated urls within an engine result list', async () => {
    const dup = [{ title: 'a', url: 'https://x.example.com/1', snippet: '', engine: 'bing' }, { title: 'b', url: 'https://x.example.com/1', snippet: '', engine: 'bing' }];
    const outcome = await runSearchChain('q', config(), {
      adapters: [adapter('bing', async () => dup)],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal,
    });
    expect(outcome.hits.length).toBe(1);
  });

  it('an adapter resolving [] as success degrades as empty (defensive branch)', async () => {
    const outcome = await runSearchChain('q', config(), {
      adapters: [adapter('bing', async () => []), adapter('baidu', async () => hit('baidu'))],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal,
    });
    expect(outcome.engine).toBe('baidu');
    expect(outcome.failures[0]).toMatchObject({ engine: 'bing', reason: 'empty' });
  });
});

describe('runSearchChain — cache', () => {
  it('same query + same adapters → second call served from cache (fromCache, engines NOT re-run)', async () => {
    let calls = 0;
    const cache = freshCache();
    const deps = {
      adapters: [adapter('bing', async () => {
        calls += 1;
        return hit('bing');
      })],
      gate: new EngineGate(0),
      cache,
      signal,
    };
    const first = await runSearchChain('q', config(), deps);
    expect(first.fromCache).toBeUndefined();

    const second = await runSearchChain('q', config(), deps);
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
    expect(second.hits).toEqual(first.hits);
  });

  it('cache key fingerprint: different searxngUrls → different cache entries', async () => {
    let calls = 0;
    const cache = freshCache();
    const deps = {
      adapters: [adapter('searxng', async () => {
        calls += 1;
        return hit('searxng');
      }, ['searxng.example.com'])],
      gate: new EngineGate(0),
      cache,
      signal,
    };
    await runSearchChain('q', config({ searxngUrls: ['https://a.example'] }), deps);
    await runSearchChain('q', config({ searxngUrls: ['https://b.example'] }), deps);
    expect(calls).toBe(2); // different fingerprint → real run both times

    await runSearchChain('q', config({ searxngUrls: ['https://b.example'] }), deps);
    expect(calls).toBe(2); // same fingerprint again → cache
  });

  it('searchChainCacheKey excludes API keys (secrets never enter cache keys)', () => {
    const adapters = [adapter('tavily', async () => [])];
    const a = searchChainCacheKey('q', adapters, config({ tavilyApiKey: 'secret-a' }));
    const b = searchChainCacheKey('q', adapters, config({ tavilyApiKey: 'secret-b' }));
    expect(a).toBe(b);
  });

  it('all-fail outcomes are NOT cached (transient outages must not go sticky)', async () => {
    let calls = 0;
    const cache = freshCache();
    const deps = {
      adapters: [adapter('bing', async () => {
        calls += 1;
        throw new EngineUnavailableError('bing', 'timeout', 'x');
      })],
      gate: new EngineGate(0),
      cache,
      signal,
    };
    await runSearchChain('q', config(), deps);
    await runSearchChain('q', config(), deps);
    expect(calls).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('P8: same-query CONCURRENT calls share ONE in-flight run (engines fire once)', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new EngineGate(0);
    const cache = freshCache();
    const slow = adapter('bing', async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return hit('bing');
    });
    const first = runSearchChain('q', config(), { adapters: [slow], gate, cache, signal });
    // Let the first call reach the engine (past the gate await) so the adapter
    // counter + the in-flight promise are both in place.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = runSearchChain('q', config(), { adapters: [slow], gate, cache, signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1); // still ONE run while in flight
    release?.();
    const [a, b] = await Promise.all([first, second]);

    expect(calls).toBe(1); // ONE engine run served BOTH callers
    expect(a.hits).toEqual(b.hits);
    expect(a.engine).toBe('bing');
    // The joiner rode the live run, not the TTL cache (no fromCache flag).
    expect(b.fromCache).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('empty query short-circuits (no adapter runs)', async () => {
    const impl = vi.fn(async () => hit('bing'));
    const outcome = await runSearchChain('   ', config(), {
      adapters: [adapter('bing', impl)],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal,
    });
    expect(outcome).toEqual({ hits: [], failures: [] });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('runSearchChain — EngineGate + abort', () => {
  it('acquires the gate per engine host before searching (500ms default spacing between same-host calls)', async () => {
    const now = { v: 1_000 };
    const gate = new EngineGate(500, () => now.v);
    const waits: number[] = [];
    const origAcquire = gate.acquire.bind(gate);
    gate.acquire = async (host: string) => {
      waits.push(gate.waitMs(host));
      await origAcquire(host);
    };

    await runSearchChain('q', config(), {
      adapters: [
        failing('bing', 'empty'),
        adapter('baidu', async () => hit('baidu')),
      ],
      gate,
      cache: freshCache(),
      signal,
    });

    // First call: no wait; second (different host): no wait. Same-host would wait.
    expect(waits).toEqual([0, 0]);
    now.v = 1_200; // 200ms since mark — same host must wait 300ms
    expect(gate.waitMs('bing.example.com')).toBe(300);
  });

  it('an aborted signal stops the chain between engines (no further engines fire)', async () => {
    const impl = vi.fn(async () => hit('ddg'));
    const controller = new AbortController();
    controller.abort();
    const outcome = await runSearchChain('q', config(), {
      adapters: [failing('bing', 'transport-abort'), adapter('ddg', impl)],
      gate: new EngineGate(0),
      cache: freshCache(),
      signal: controller.signal,
    });
    expect(impl).not.toHaveBeenCalled(); // chain broke before ddg
    expect(outcome.engine).toBeUndefined();
    // Pre-aborted: the between-engines check fires BEFORE engine 1 — nothing
    // ran, so the failure list is empty (the tool layer's own post-check
    // surfaces the abort to the caller).
    expect(outcome.failures).toEqual([]);
  });
});

describe('describeEngineFailure', () => {
  it('EngineUnavailableError keeps engineId + own taxonomy', () => {
    const f = describeEngineFailure('x', new EngineUnavailableError('baidu', 'anti-bot', '验证码'));
    expect(f).toEqual({ engine: 'baidu', reason: 'anti-bot', detail: '验证码' });
  });

  it('ResearchNetworkError maps: timeout→timeout, http-status→http, abort/network→network; unknown → network', () => {
    expect(describeEngineFailure('b', new ResearchNetworkError('timeout', 't')).reason).toBe('timeout');
    expect(describeEngineFailure('b', new ResearchNetworkError('http-status', 'h')).reason).toBe('http');
    expect(describeEngineFailure('b', new ResearchNetworkError('abort', 'a')).reason).toBe('network');
    expect(describeEngineFailure('b', new Error('boom'))).toEqual({ engine: 'b', reason: 'network', detail: 'boom' });
    expect(describeEngineFailure('b', 'raw string')).toEqual({ engine: 'b', reason: 'network', detail: 'raw string' });
  });
});

function config(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return { searxngLocalhostProbe: true, ...overrides };
}

function freshCache(): LruTtlCache<SearchChainOutcome> {
  // Frozen clock — cache entries never expire; tests exercise key-fingerprint
  // behavior, not TTL (netGuard.test.ts owns the TTL matrix).
  return createSearchResultCache<SearchChainOutcome>({ now: () => 0 });
}
