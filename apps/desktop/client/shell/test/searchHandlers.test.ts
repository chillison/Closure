/**
 * web_search handler tests (Story 3.6 WP4 / design D9).
 *
 * ZERO network: the handler runs with injected config loader + probe + fetcher
 * stubs and a zero-interval gate. Locks: param coercion + clamping, the probe →
 * engine-resolution wiring, hit output format (engine-tagged markdown), the
 * all-fail friendly summary, degraded-engine notes, and never-throws on every
 * failure path (R8).
 *
 * electron + configIpc db-imports + logger mocked (searchHandlers imports
 * searchConfig → configIpc transitively); research modules themselves are REAL
 * so the handler → chain → adapter path runs end-to-end against fixtures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { EngineGate, createSearchResultCache } from '../main/research/netGuard';
import type { EngineFetchResult, EngineFetcher } from '../main/research/searchEngines';
import type { SearchChainOutcome } from '../main/research/searchChain';
import type { SearchConfig } from '@orison/shared-contracts';
import {
  coerceSearchParams,
  createWebSearchHandler,
  formatAllFailOutput,
  formatSearchOutput,
  webSearchHandler,
} from '../main/ipc/toolHandlers/searchHandlers';

// ── Fixtures ──

const BING_HTML = `<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/amiya">阿米娅 - 萌娘百科</a></h2><div class="b_caption"><p>阿米娅是《明日方舟》的主角。</p></div></li></ol>`;
const BAIDU_HTML = `<div id="content_left"><div class="result c-container"><h3><a href="http://www.baidu.com/link?url=b">明日方舟</a></h3><div class="c-abstract">策略手游。</div></div></div>`;

function ctx(params: Record<string, unknown>) {
  return { params, projectDir: '/proj/alpha', sessionId: 's1', abort: new AbortController().signal };
}

function bingFetcher(text = BING_HTML): EngineFetcher {
  return async () => ({ status: 200, ok: true, text } as EngineFetchResult);
}

function defaultDeps(overrides: Partial<{ config: SearchConfig; probeHit: boolean; fetcher: EngineFetcher }> = {}) {
  const probeCalls: AbortSignal[] = [];
  return {
    probeCalls,
    deps: {
      loadConfig: () => overrides.config ?? { searxngLocalhostProbe: true },
      probe: async (signal: AbortSignal) => {
        probeCalls.push(signal);
        return overrides.probeHit ?? false;
      },
      fetcher: overrides.fetcher ?? bingFetcher(),
      gate: new EngineGate(0),
      cache: createSearchResultCache<SearchChainOutcome>({ now: () => 0 }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Param coercion ──

describe('coerceSearchParams', () => {
  it('extracts query + clamps limit into [1, 10]', () => {
    expect(coerceSearchParams({ query: ' 阿米娅 ', limit: 99 })).toEqual({ query: ' 阿米娅 ', limit: 10 });
    expect(coerceSearchParams({ query: 'x', limit: 0 })).toEqual({ query: 'x', limit: 1 });
    expect(coerceSearchParams({ query: 'x', limit: 3.7 })).toEqual({ query: 'x', limit: 4 });
    expect(coerceSearchParams({ query: 'x' })).toEqual({ query: 'x' });
    // limit coerces even without a query — the handler guards the query first.
    expect(coerceSearchParams({ limit: 5 })).toEqual({ limit: 5 });
  });
});

// ── Formatting ──

describe('formatSearchOutput / formatAllFailOutput', () => {
  it('hit list carries title + engine tag + url + snippet', () => {
    const out = formatSearchOutput('阿米娅', [
      { title: '阿米娅 - 萌娘百科', url: 'https://example.com/amiya', snippet: '主角', engine: 'bing' },
    ]);
    expect(out).toContain('「阿米娅」的 web 搜索结果（1 条）');
    expect(out).toContain('1. **阿米娅 - 萌娘百科**（bing）');
    expect(out).toContain('https://example.com/amiya');
    expect(out).toContain('主角');
  });

  it('all-fail summary lists per-engine reasons + actionable advice', () => {
    const out = formatAllFailOutput('阿米娅', [
      { engine: 'bing', reason: 'timeout', detail: '请求超时' },
      { engine: 'baidu', reason: 'anti-bot', detail: '验证码' },
    ]);
    expect(out).toContain('所有搜索引擎均不可用');
    expect(out).toContain('- bing（请求超时）：请求超时');
    expect(out).toContain('- baidu（触发反爬/验证码拦截）：验证码');
    expect(out).toContain('建议');
  });
});

// ── Handler ──

describe('web_search handler', () => {
  it('missing/empty query → friendly invalid-params output (never a throw)', async () => {
    const handler = createWebSearchHandler(defaultDeps().deps);
    const missing = await handler(ctx({}));
    expect(missing.output).toContain('搜索参数无效');
    expect(missing.metadata).toMatchObject({ count: 0 });

    const blank = await handler(ctx({ query: '   ' }));
    expect(blank.output).toContain('搜索参数无效');
  });

  it('probe hit injects searxng-local ahead of bing (engine chain order visible in metadata)', async () => {
    const searxngJson = JSON.stringify({ results: [{ title: '本地实例结果', url: 'https://searxng.local/x', content: 'c' }] });
    const calls: string[] = [];
    const fetcher: EngineFetcher = async (url) => {
      calls.push(url);
      if (url.includes('127.0.0.1:8888')) return { status: 200, ok: true, text: searxngJson };
      return { status: 200, ok: true, text: BING_HTML };
    };
    const { deps } = defaultDeps({ probeHit: true, fetcher });
    const handler = createWebSearchHandler(deps);
    const result = await handler(ctx({ query: '阿米娅' }));

    expect(result.metadata).toMatchObject({ count: 1, engine: 'searxng-local' });
    expect((result.metadata as { engines: string[] }).engines).toEqual(['searxng-local', 'bing', 'baidu', 'ddg']);
    expect(result.output).toContain('本地实例结果');
    expect(result.output).toContain('（searxng-local）');
    expect(calls[0]).toContain('127.0.0.1:8888/search');
  });

  it('default chain (no probe hit): bing hit → markdown output + engine tag + bing probed first', async () => {
    const calls: string[] = [];
    const fetcher: EngineFetcher = async (url) => {
      calls.push(url);
      return { status: 200, ok: true, text: BING_HTML };
    };
    const { deps } = defaultDeps({ fetcher });
    const handler = createWebSearchHandler(deps);
    const result = await handler(ctx({ query: '阿米娅', limit: 1 }));

    expect(result.title).toBe('web_search: 阿米娅');
    expect(result.metadata).toMatchObject({ count: 1, engine: 'bing' });
    expect(result.output).toContain('1. **阿米娅 - 萌娘百科**（bing）');
    expect(calls).toEqual(['https://cn.bing.com/search?q=' + encodeURIComponent('阿米娅')]);
  });

  it('degrades bing(captcha) → baidu(hit); output notes the skipped engine', async () => {
    const fetcher: EngineFetcher = async (url) => {
      if (url.includes('bing.com')) {
        return { status: 200, ok: true, text: '<div class="captcha">Verify that you are not a robot</div>' };
      }
      return { status: 200, ok: true, text: BAIDU_HTML };
    };
    const { deps } = defaultDeps({ fetcher });
    const result = await createWebSearchHandler(deps)(ctx({ query: '明日方舟' }));

    expect(result.metadata).toMatchObject({ engine: 'baidu' });
    expect(result.output).toContain('（baidu）');
    expect(result.output).toContain('注：以下引擎已自动跳过——bing（触发反爬/验证码拦截）');
  });

  it('all engines fail → friendly per-engine summary, count 0, never throws', async () => {
    const fetcher: EngineFetcher = async () => ({ status: 403, ok: false, text: 'denied' });
    const { deps } = defaultDeps({ fetcher });
    const result = await createWebSearchHandler(deps)(ctx({ query: '阿米娅' }));

    expect(result.metadata).toMatchObject({ count: 0 });
    expect(result.output).toContain('所有搜索引擎均不可用');
    expect(result.output).toContain('- bing（HTTP 状态异常）');
    const failures = (result.metadata as { failures: { engine: string }[] }).failures.map((f) => f.engine);
    expect(failures).toEqual(['bing', 'baidu', 'ddg']);
  });

  it('probe disabled in config → probe never fires, straight to the builtins', async () => {
    const { deps, probeCalls } = defaultDeps({ config: { searxngLocalhostProbe: false } });
    const result = await createWebSearchHandler(deps)(ctx({ query: '阿米娅' }));
    expect(probeCalls.length).toBe(0);
    expect((result.metadata as { engines: string[] }).engines).toEqual(['bing', 'baidu', 'ddg']);
  });

  it('a throwing loadConfig degrades to the default config (search still runs)', async () => {
    const { deps } = defaultDeps();
    deps.loadConfig = () => {
      throw new Error('sidecar unreadable');
    };
    const result = await createWebSearchHandler(deps)(ctx({ query: '阿米娅' }));
    expect(result.metadata).toMatchObject({ count: 1, engine: 'bing' });
  });

  it('a throwing probe counts as a miss (builtins still run)', async () => {
    const { deps } = defaultDeps();
    deps.probe = async () => {
      throw new Error('probe crashed');
    };
    const result = await createWebSearchHandler(deps)(ctx({ query: '阿米娅' }));
    expect(result.metadata).toMatchObject({ engine: 'bing' });
  });

  it('engineOrder of only unavailable engines → empty-chain friendly output', async () => {
    const { deps } = defaultDeps({ config: { searxngLocalhostProbe: true, engineOrder: ['tavily'] } }); // no key → skipped
    const result = await createWebSearchHandler(deps)(ctx({ query: '阿米娅' }));
    expect(result.output).toContain('搜索引擎链为空');
    expect((result.metadata as { engines: string[] }).engines).toEqual([]);
  });

  it('same query twice → second run served from cache (fromCache metadata)', async () => {
    let calls = 0;
    const fetcher: EngineFetcher = async () => {
      calls += 1;
      return { status: 200, ok: true, text: BING_HTML };
    };
    const { deps } = defaultDeps({ fetcher });
    const handler = createWebSearchHandler(deps);
    await handler(ctx({ query: '阿米娅' }));
    const second = await handler(ctx({ query: '阿米娅' }));
    expect(calls).toBe(1);
    expect(second.metadata).toMatchObject({ fromCache: true, engine: 'bing' });
  });

  it('the default export is a wired handler function', async () => {
    expect(typeof webSearchHandler).toBe('function');
  });
});
