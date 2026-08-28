/**
 * Wiki tool handler tests (Story 3.6 WP3 / design D8).
 *
 * ZERO network: every MediaWiki response is a fixture shaped exactly like the
 * 2026-08-15 本机实探 baseline (opensearch array / list=search / rest.php page /
 * api.php parse / api.php error object). The tests lock OUR logic only — URL
 * building, parsing, merge/dedup, cleaning, capping, degradation, friendly
 * failure (never-throws) — because the live Wiki API WILL drift.
 *
 * Handlers run with injected fixture fetchers + a zero-interval EngineGate;
 * `netFetch`/logger are module-mocked so no Electron and no log files load.
 * WP10 additionally mocks the search-config sidecar reader — the handlers now
 * resolve presets + user wiki-site overrides from it per call (see the
 * default-resolution test).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetch, warn, readSearchConfig } = vi.hoisted(() => ({
  fetch: vi.fn(),
  warn: vi.fn(),
  readSearchConfig: vi.fn(),
}));

vi.mock('../main/research/netFetch', () => ({ netFetch: fetch }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn }) }));
// WP10: handlers resolve presets + user wiki-site overrides from the search
// sidecar per call. Mock the reader so tests are hermetic (no ~/.orison reads)
// and so the default-resolution path can inject overrides on demand.
vi.mock('../main/research/searchConfig', () => ({ readSearchConfig }));

import { netFetch } from '../main/research/netFetch';
import { EngineGate, SsrfBlockedError } from '../main/research/netGuard';
import { WIKI_SITE_PRESETS, loadWikiSites, type WikiSite } from '../main/research/wikiSites';
import {
  articleUrl,
  capWikitext,
  cleanSnippet,
  cleanWikitext,
  coerceSearchParams,
  createWikiReadHandler,
  createWikiSearchHandler,
  extractApiError,
  extractParseWikitext,
  formatSearchOutput,
  fulltextSearchUrl,
  mergeSearchHits,
  netFetchJson,
  opensearchUrl,
  parseFulltextSearchResponse,
  parseOpenSearchResponse,
  parseRestPage,
  parsePageUrl,
  restPageUrl,
  wikiOutboundAllowlist,
  WIKITEXT_CAP,
  WIKI_READ_TOTAL_BUDGET_MS,
  type WikiJsonFetcher,
  type WikiJsonResult,
  type WikiSearchHit,
} from '../main/ipc/toolHandlers/wikiHandlers';

// ── Fixtures (2026-08-15 real response shapes) ──

const CN = WIKI_SITE_PRESETS[0]; // official, opensearch
const UK = WIKI_SITE_PRESETS[1]; // mirror, fulltext

const OPENSEARCH_FIXTURE = [
  '阿米',
  ['阿米娅', '阿米娅（明日方舟）'],
  ['', '罗德岛公开领导人之一。'],
  ['https://zh.moegirl.org.cn/阿米娅', 'https://zh.moegirl.org.cn/阿米娅（明日方舟）'],
];

const FULLTEXT_FIXTURE = {
  query: {
    search: [
      {
        ns: 0,
        title: '阿米娅',
        pageid: 320144,
        size: 210345,
        snippet: '《明日方舟》中的主角。<span class="searchmatch">阿米娅</span>是罗德岛的&nbsp;领导人…',
        timestamp: '2026-07-30T12:00:00Z',
      },
    ],
  },
};

const WIKITEXT_FIXTURE = [
  "'''阿米娅'''是游戏《明日方舟》及其衍生作品的登场角色。{{明日方舟人物信息|称号=首领}}",
  '<!-- 维护性注释，LLM 不需要 -->',
  '罗德岛的精英干员<ref name="arknights">官方设定集</ref>，同时也是<ref>博士的同伴</ref>。',
  '<ref name="empty" />',
  '<div style="display:none">隐藏导航数据</div>',
  '带路党<ref>另一条引用\n跨多行\n内容</ref>结束。',
  '{{信息栏|test=1}}',
].join('\n');

const REST_PAGE_FIXTURE = {
  id: 320144,
  key: '阿米娅',
  title: '阿米娅',
  latest: { id: 512345, timestamp: '2026-08-01T00:00:00Z' },
  content_model: 'wikitext',
  license: { url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/cn/', title: '知识共享 署名-非商业性使用-相同方式共享 3.0' },
  source: WIKITEXT_FIXTURE,
};

const PARSE_FIXTURE = {
  parse: {
    title: '阿米娅',
    pageid: 320144,
    revid: 512345,
    text: { '*': '<div>unused html</div>' },
    wikitext: { '*': WIKITEXT_FIXTURE },
  },
};

const API_ERROR_FIXTURE = { error: { code: 'action-notallowed', info: 'The action you have requested is limited to users in the group' } };

// ── Test helpers ──

function ctx(params: Record<string, unknown>) {
  return { params, projectDir: '/proj/alpha', sessionId: 's1', abort: new AbortController().signal };
}

/** Recording fetcher routing by predicate; default = generic failure. */
function makeFetcher(route: (url: string) => WikiJsonResult): { fn: WikiJsonFetcher; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fn: async (url: string) => {
      calls.push(url);
      return route(url);
    },
  };
}

const okJson = (json: unknown): WikiJsonResult => ({ ok: true, status: 200, json });
const httpFail = (status: number): WikiJsonResult => ({ ok: false, status, error: `HTTP ${status}` });
const netFail: WikiJsonResult = { ok: false, status: 0, error: '网络请求失败：timeout' };

function zeroDeps(fetcher: WikiJsonFetcher, sites?: readonly WikiSite[]) {
  return {
    sites: sites ?? loadWikiSites(),
    gate: new EngineGate(0),
    fetchJson: fetcher,
    // Hermetic: the default guard would hit real DNS for the preset hosts.
    guard: async () => {},
  };
}

beforeEach(() => {
  fetch.mockReset();
  warn.mockReset();
  // Default sidecar = empty search config (presets only — zero-key default).
  readSearchConfig.mockReset().mockReturnValue({ searxngLocalhostProbe: true });
});

// ── URL builders ──

describe('URL builders', () => {
  it('opensearchUrl — official api.php, encoded query, limit passthrough', () => {
    expect(opensearchUrl(CN, '阿米 娅', 5)).toBe(
      `https://zh.moegirl.org.cn/api.php?action=opensearch&search=${encodeURIComponent('阿米 娅')}&limit=5&format=json`,
    );
  });

  it('fulltextSearchUrl — mirror api.php list=search', () => {
    expect(fulltextSearchUrl(UK, '阿米娅', 8)).toBe(
      `https://moegirl.uk/api.php?action=query&list=search&srsearch=${encodeURIComponent('阿米娅')}&srlimit=8&format=json`,
    );
  });

  it('parsePageUrl / restPageUrl / articleUrl — encoded title', () => {
    const title = '阿米娅（明日方舟）';
    expect(parsePageUrl(UK, title)).toBe(`https://moegirl.uk/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`);
    expect(restPageUrl(CN, title)).toBe(`https://zh.moegirl.org.cn/rest.php/v1/page/${encodeURIComponent(title)}`);
    expect(articleUrl(CN, title)).toBe(`https://zh.moegirl.org.cn/${encodeURIComponent(title)}`);
  });
});

// ── Response parsing ──

describe('parseOpenSearchResponse', () => {
  it('zips [term, titles, descs, urls] into hits with API-provided urls', () => {
    const hits = parseOpenSearchResponse(OPENSEARCH_FIXTURE, CN);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ title: '阿米娅', url: 'https://zh.moegirl.org.cn/阿米娅', site: 'moegirl-cn' });
    expect(hits[1]).toMatchObject({ title: '阿米娅（明日方舟）', snippet: '罗德岛公开领导人之一。' });
  });

  it('tolerates the legacy [term, titles] form — constructed urls (encoded), empty snippets', () => {
    const hits = parseOpenSearchResponse(['阿米', ['阿米娅']], CN);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe(articleUrl(CN, '阿米娅'));
    expect(hits[0].snippet).toBe('');
  });

  it('non-array json → [] (never throws)', () => {
    expect(parseOpenSearchResponse({ weird: 1 }, CN)).toEqual([]);
  });
});

describe('parseFulltextSearchResponse', () => {
  it('maps query.search[] — snippet HTML stripped, entities decoded, constructed url', () => {
    const hits = parseFulltextSearchResponse(FULLTEXT_FIXTURE, UK);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: '阿米娅', url: articleUrl(UK, '阿米娅'), site: 'moegirl-uk' });
    expect(hits[0].snippet).toContain('阿米娅');
    expect(hits[0].snippet).not.toContain('<span');
    expect(hits[0].snippet).not.toContain('&nbsp;');
  });

  it('drops entries without a title; malformed json → []', () => {
    expect(parseFulltextSearchResponse({ query: { search: [{ snippet: 'x' }, { title: 'ok' }] } }, UK)).toHaveLength(1);
    expect(parseFulltextSearchResponse({ batchcomplete: true }, UK)).toEqual([]);
    expect(parseFulltextSearchResponse('nope', UK)).toEqual([]);
  });
});

describe('parseRestPage / extractParseWikitext / extractApiError', () => {
  it('parseRestPage — title + source + license passthrough', () => {
    const page = parseRestPage(REST_PAGE_FIXTURE);
    expect(page?.title).toBe('阿米娅');
    expect(page?.wikitext).toBe(WIKITEXT_FIXTURE);
    expect(page?.license).toEqual(REST_PAGE_FIXTURE.license);
  });

  it('parseRestPage — missing source → null (shape failure degrades)', () => {
    expect(parseRestPage({ title: '阿米娅', license: REST_PAGE_FIXTURE.license })).toBeNull();
    expect(parseRestPage(null)).toBeNull();
  });

  it('extractParseWikitext — reads parse.wikitext["*"]', () => {
    const parsed = extractParseWikitext(PARSE_FIXTURE);
    expect(parsed?.title).toBe('阿米娅');
    expect(parsed?.wikitext).toBe(WIKITEXT_FIXTURE);
    expect(extractParseWikitext({ parse: { title: 'x' } })).toBeNull();
    expect(extractParseWikitext(API_ERROR_FIXTURE)).toBeNull();
  });

  it('extractApiError — api.php error object → friendly code：info; absent → undefined', () => {
    expect(extractApiError(API_ERROR_FIXTURE)).toContain('action-notallowed');
    expect(extractApiError(API_ERROR_FIXTURE)).toContain('limited to users');
    expect(extractApiError(OPENSEARCH_FIXTURE)).toBeUndefined();
    expect(extractApiError({})).toBeUndefined();
  });
});

// ── Snippet cleaning ──

describe('cleanSnippet', () => {
  it('strips tags, decodes entities (&amp; last so &amp;lt; stays single-decoded), collapses ws', () => {
    expect(cleanSnippet('<span class="searchmatch">阿米娅</span>&nbsp;是&nbsp;罗德岛的')).toBe('阿米娅 是 罗德岛的');
    expect(cleanSnippet('a &amp;lt; b &quot;q&quot; &#39;r&#39; &amp; c')).toBe(`a &lt; b "q" 'r' & c`);
    expect(cleanSnippet('   x\t\ty   ')).toBe('x y');
  });
});

// ── Cleaning / capping ──

describe('cleanWikitext / capWikitext', () => {
  it('strips refs (multiline + attrs), self-closing refs, comments, hidden divs — keeps templates', () => {
    const out = cleanWikitext(WIKITEXT_FIXTURE);
    expect(out).not.toContain('<ref');
    expect(out).not.toContain('官方设定集');
    expect(out).not.toContain('维护性注释');
    expect(out).not.toContain('隐藏导航数据');
    expect(out).toContain('{{明日方舟人物信息|称号=首领}}');
    expect(out).toContain('{{信息栏|test=1}}');
    expect(out).toContain("'''阿米娅'''");
    // 多行 ref（跨行内容）也整体移除
    expect(out).not.toContain('跨多行');
  });

  it('strips hidden divs with flexible style spacing/quotes (blank line left, collapsed)', () => {
    const out = cleanWikitext('前\n<div style="display: none">a</div>\n<div style=\'display:none\'>b</div>\n后');
    expect(out).toBe('前\n\n后');
  });

  it('collapses blank-line runs and horizontal whitespace, trims both ends', () => {
    const out = cleanWikitext('  \n\n\nA   B\t\tC  \n\n\n\n  D  \n\n');
    expect(out).toBe('A B C\n\nD');
  });

  it('capWikitext — under cap untouched; over cap sliced with truncation tail + url', () => {
    const short = capWikitext('abc', 'https://x');
    expect(short).toEqual({ text: 'abc', truncated: false });

    const long = capWikitext('x'.repeat(WIKITEXT_CAP + 500), 'https://zh.moegirl.org.cn/rest.php/v1/page/%E9%98%BF%E7%B1%B3%E5%A8%85');
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeGreaterThan(WIKITEXT_CAP);
    expect(long.text).toContain('[已截断，全文：https://zh.moegirl.org.cn/rest.php/v1/page/%E9%98%BF%E7%B1%B3%E5%A8%85]');
  });
});

// ── Merge / format ──

describe('mergeSearchHits / formatSearchOutput', () => {
  const officialHit = (title: string): WikiSearchHit => ({ title, url: `https://zh.moegirl.org.cn/${title}`, snippet: '', site: 'moegirl-cn' });
  const mirrorHit = (title: string): WikiSearchHit => ({ title, url: `https://moegirl.uk/${title}`, snippet: 's', site: 'moegirl-uk' });

  it('exact-title dedup keeps the FIRST (official priority) occurrence', () => {
    const merged = mergeSearchHits([
      { site: CN, hits: [officialHit('阿米娅')] },
      { site: UK, hits: [mirrorHit('阿米娅'), mirrorHit('凯尔希')] },
    ]);
    expect(merged.map((h) => h.title)).toEqual(['阿米娅', '凯尔希']);
    expect(merged[0].site).toBe('moegirl-cn');
  });

  it('formatSearchOutput — numbered title+site, url, snippet line, notes appended', () => {
    const out = formatSearchOutput('阿米娅', [
      { title: '阿米娅', url: 'https://zh.moegirl.org.cn/阿米娅', snippet: '主角。', site: 'moegirl-cn' },
      { title: '凯尔希', url: 'https://moegirl.uk/凯尔希', snippet: '', site: 'moegirl-uk' },
    ], ['注：官方站（前缀搜索）无命中。']);
    expect(out).toContain('「阿米娅」的 wiki 搜索结果（2 条）');
    expect(out).toContain('1. **阿米娅**（moegirl-cn）');
    expect(out).toContain('https://zh.moegirl.org.cn/阿米娅');
    expect(out).toContain('2. **凯尔希**（moegirl-uk）');
    expect(out).not.toContain('https://moegirl.uk/凯尔希\n   \n'); // no empty snippet line
    expect(out).toContain('注：官方站（前缀搜索）无命中。');
  });
});

// ── netFetchJson seam (mocked netFetch) ──

describe('netFetchJson', () => {
  it('2xx JSON → {ok, json}; 2xx non-JSON → ok without json; non-2xx → error', async () => {
    fetch.mockResolvedValueOnce(new Response('{"a":1}'));
    const good = await netFetchJson('https://x/', new AbortController().signal);
    expect(good).toEqual({ ok: true, status: 200, json: { a: 1 } });

    fetch.mockResolvedValueOnce(new Response('<html>blocked</html>', { status: 200 }));
    const nonJson = await netFetchJson('https://x/', new AbortController().signal);
    expect(nonJson.ok).toBe(true);
    expect(nonJson.json).toBeUndefined();

    fetch.mockResolvedValueOnce(new Response('nope', { status: 503 }));
    const fail = await netFetchJson('https://x/', new AbortController().signal);
    expect(fail).toEqual({ ok: false, status: 503, error: 'HTTP 503' });

    fetch.mockRejectedValueOnce(new Error('net::ERR_TIMED_OUT'));
    const transport = await netFetchJson('https://x/', new AbortController().signal);
    expect(transport).toEqual({ ok: false, status: 0, error: 'net::ERR_TIMED_OUT' });
  });

  it('passes the abort signal through to netFetch', async () => {
    fetch.mockResolvedValue(new Response('{}'));
    const signal = new AbortController().signal;
    await netFetchJson('https://x/', signal);
    expect(fetch).toHaveBeenCalledWith('https://x/', { signal });
  });
});

// ── wiki_search handler ──

describe('wiki_search handler', () => {
  it('auto mode: queries BOTH sites (opensearch on cn, list=search on uk), merges with official priority', async () => {
    const fetcher = makeFetcher((url) =>
      url.startsWith('https://zh.moegirl.org.cn/') ? okJson(OPENSEARCH_FIXTURE)
        : url.startsWith('https://moegirl.uk/') ? okJson({ query: { search: [{ title: '阿米娅', snippet: '镜像摘要' }] } })
        : httpFail(500),
    );
    const gate = new EngineGate(0);
    const acquireSpy = vi.spyOn(gate, 'acquire');
    const handler = createWikiSearchHandler({ sites: loadWikiSites(), gate, fetchJson: fetcher.fn });

    const result = await handler(ctx({ query: '阿米' }));

    // Sequential, registry order, correct endpoints.
    expect(fetcher.calls[0]).toBe(opensearchUrl(CN, '阿米', 10));
    expect(fetcher.calls[1]).toBe(fulltextSearchUrl(UK, '阿米', 10));
    // Per-host EngineGate keys (scope: moegirl hostnames).
    expect(acquireSpy).toHaveBeenCalledWith('zh.moegirl.org.cn');
    expect(acquireSpy).toHaveBeenCalledWith('moegirl.uk');

    const hits = result.metadata?.hits as WikiSearchHit[];
    // Exact-title dedup: official「阿米娅」wins, mirror duplicate dropped, distinct title kept.
    expect(hits.map((h) => h.title)).toEqual(['阿米娅', '阿米娅（明日方舟）']);
    expect(hits[0].site).toBe('moegirl-cn');
    expect(result.metadata?.count).toBe(2);
    expect(result.output).toContain('阿米娅（明日方舟）');
    expect(result.output).toContain('https://zh.moegirl.org.cn/阿米娅');
  });

  it("site='moegirl-cn': single site, API urls + snippets in output", async () => {
    const fetcher = makeFetcher(() => okJson(OPENSEARCH_FIXTURE));
    const handler = createWikiSearchHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ query: '阿米', site: 'moegirl-cn' }));

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]).toContain('action=opensearch');
    expect(result.output).toContain('罗德岛公开领导人之一。');
  });

  it('clamps limit into [1,10] (LLM params never reach a URL raw)', async () => {
    const fetcher = makeFetcher(() => okJson(OPENSEARCH_FIXTURE));
    const handler = createWikiSearchHandler(zeroDeps(fetcher.fn));

    await handler(ctx({ query: '阿米', limit: 999 }));
    expect(fetcher.calls[0]).toContain('limit=10');

    await handler(ctx({ query: '阿米', limit: -3 }));
    expect(fetcher.calls[1]).toContain('limit=1');
  });

  it('invalid / empty params → friendly message, zero network', async () => {
    const fetcher = makeFetcher(() => okJson(OPENSEARCH_FIXTURE));
    const handler = createWikiSearchHandler(zeroDeps(fetcher.fn));

    for (const bad of [{}, { query: 123 }, { query: '   ' }]) {
      const result = await handler(ctx(bad));
      expect(result.output).toContain('搜索参数无效');
      expect(result.metadata?.count).toBe(0);
    }
    expect(fetcher.calls).toHaveLength(0);
  });

  it('unknown site id → friendly list of known sites, zero network', async () => {
    const fetcher = makeFetcher(() => okJson(OPENSEARCH_FIXTURE));
    const handler = createWikiSearchHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ query: '阿米', site: 'prts' }));
    expect(result.output).toContain('未知站点');
    expect(result.output).toContain('moegirl-cn');
    expect(result.output).toContain('moegirl-uk');
    expect(fetcher.calls).toHaveLength(0);
  });

  it('opensearch empty (site=moegirl-cn) → 未找到 + prefix hint', async () => {
    const fetcher = makeFetcher(() => okJson(['阿米', [], [], []]));
    const handler = createWikiSearchHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ query: '不存在的词', site: 'moegirl-cn' }));
    expect(result.output).toContain('未找到');
    expect(result.output).toContain('前缀');
    expect(result.output).toContain("site='moegirl-uk'");
  });

  it('fulltext empty (site=moegirl-uk) → 未找到 WITHOUT the prefix hint', async () => {
    const fetcher = makeFetcher(() => okJson({ query: { search: [] } }));
    const handler = createWikiSearchHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ query: '不存在的词', site: 'moegirl-uk' }));
    expect(result.output).toContain('未找到');
    expect(result.output).not.toContain('前缀');
  });

  it('auto: official fails + mirror works → mirror hits + failure note + errors metadata', async () => {
    const fetcher = makeFetcher((url) =>
      url.startsWith('https://zh.moegirl.org.cn/') ? httpFail(403) : okJson(FULLTEXT_FIXTURE),
    );
    const handler = createWikiSearchHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ query: '阿米娅' }));

    const hits = result.metadata?.hits as WikiSearchHit[];
    expect(hits).toHaveLength(1);
    expect(hits[0].site).toBe('moegirl-uk');
    expect(result.output).toContain('查询失败：HTTP 403');
    expect(result.metadata?.errors).toEqual([{ site: 'moegirl-cn', error: 'HTTP 403' }]);
  });

  it('auto: a 200 response carrying an api.php error object still degrades (action-notallowed)', async () => {
    const fetcher = makeFetcher((url) =>
      url.startsWith('https://zh.moegirl.org.cn/') ? okJson(API_ERROR_FIXTURE) : okJson(FULLTEXT_FIXTURE),
    );
    const handler = createWikiSearchHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ query: '阿米娅' }));
    expect((result.metadata?.hits as WikiSearchHit[])[0].site).toBe('moegirl-uk');
    expect(result.output).toContain('action-notallowed');
  });

  it('auto: BOTH sites fail → friendly summary, never throws', async () => {
    const fetcher = makeFetcher((url) => (url.includes('moegirl.org.cn') ? httpFail(403) : netFail));
    const handler = createWikiSearchHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ query: '阿米娅' }));
    expect(result.output).toContain('未找到');
    expect(result.output).toContain('HTTP 403');
    expect(result.output).toContain('网络请求失败');
    expect(result.metadata?.count).toBe(0);
  });

  // WP10: without deps.sites the handler resolves presets + the user's sidecar
  // overrides PER CALL — a settings-page edit takes effect on the next tool
  // invocation without an app restart, and a custom site is queryable.
  it('default resolution: sidecar wikiSitesOverrides join the registry per call (no restart needed)', async () => {
    const PRTS: WikiSite = {
      id: 'prts',
      name: 'PRTS',
      apiBaseUrl: 'https://prts.wiki',
      searchKind: 'fulltext',
      fulltextOnMirror: true,
    };
    readSearchConfig.mockReturnValue({
      searxngLocalhostProbe: true,
      wikiSitesOverrides: [{ ...PRTS }],
    });
    const fetcher = makeFetcher((url) =>
      url.startsWith('https://prts.wiki/')
        ? okJson({ query: { search: [{ title: '阿米娅', snippet: 'PRTS 摘要' }] } })
        : httpFail(500),
    );
    const handler = createWikiSearchHandler({ gate: new EngineGate(0), fetchJson: fetcher.fn, guard: async () => {} });

    // site='prts' routes to the custom site (unknown-site branch would not fetch).
    const result = await handler(ctx({ query: '阿米娅', site: 'prts' }));
    expect(fetcher.calls).toEqual([fulltextSearchUrl(PRTS, '阿米娅', 10)]);
    const hits = result.metadata?.hits as WikiSearchHit[];
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: '阿米娅', site: 'prts' });

    // A preset-id collision in the sidecar is DROPPED (presets are read-only) —
    // 'moegirl-cn' still routes to the REAL official preset, not the fake.
    readSearchConfig.mockReturnValue({
      searxngLocalhostProbe: true,
      wikiSitesOverrides: [{ ...PRTS, id: 'moegirl-cn', name: 'fake official' }],
    });
    const dupe = await handler(ctx({ query: 'x', site: 'moegirl-cn' }));
    expect(dupe.output).not.toContain('未知站点');
    expect(fetcher.calls.some((url) => url.startsWith('https://zh.moegirl.org.cn/'))).toBe(true);
  });

  // ── P10 (CR 2026-08-15): outbound SSRF guard — site origins JOIN the
  // allowlist (trust = join, never bypass) ──

  it('P10: a custom INTERNAL site origin is allowlisted (trusted at its configured origin), other private targets stay blocked', async () => {
    const INTERNAL: WikiSite = {
      id: 'internal-wiki',
      name: '内网维基',
      apiBaseUrl: 'http://192.168.1.20:8080',
      searchKind: 'opensearch',
    };
    const sites = loadWikiSites([INTERNAL]);
    // The REAL guard (no pass-through): the internal site's origin passes …
    expect(wikiOutboundAllowlist(sites)).toContain('192.168.1.20:8080');

    const guardCalls: Array<{ url: string; allowlist: readonly string[] }> = [];
    const fetcher = makeFetcher((url) =>
      url.startsWith('http://192.168.1.20:8080/')
        ? okJson(['阿米', ['内网词条'], [], []])
        : httpFail(500),
    );
    const handler = createWikiSearchHandler({
      sites,
      gate: new EngineGate(0),
      fetchJson: fetcher.fn,
      guard: async (url, allowlist) => {
        guardCalls.push({ url, allowlist });
        // Port-exact origin semantics (P9): another port on the same host
        // stays a private target.
        if (url.includes('192.168.1.20:') && !url.startsWith('http://192.168.1.20:8080/')) {
          throw new SsrfBlockedError(url, 'private-ip', 'blocked');
        }
      },
    });

    const result = await handler(ctx({ query: '内网', site: 'internal-wiki' }));
    expect(fetcher.calls).toHaveLength(1);
    expect(guardCalls[0]?.allowlist).toContain('192.168.1.20:8080');
    expect(result.metadata?.count).toBe(1);
  });

  it('P10: a custom site whose origin the guard BLOCKS degrades per-site (never a throw)', async () => {
    const BAD: WikiSite = {
      id: 'blocked-wiki',
      name: '被拦站点',
      apiBaseUrl: 'http://10.0.0.5:9000',
      searchKind: 'opensearch',
    };
    const sites = loadWikiSites([BAD]);
    const fetcher = makeFetcher(() => okJson(['x', []]));
    const handler = createWikiSearchHandler({
      sites,
      gate: new EngineGate(0),
      fetchJson: fetcher.fn,
      guard: async (url) => {
        if (url.startsWith('http://10.0.0.5:9000/')) {
          throw new SsrfBlockedError(url, 'private-ip', `目标 IP 10.0.0.5 是私网/环回/链路本地地址，已拦截：${url}`);
        }
      },
    });

    const result = await handler(ctx({ query: 'x', site: 'blocked-wiki' }));
    expect(fetcher.calls).toHaveLength(0); // blocked BEFORE the fetch fired
    expect(result.output).toContain('已拦截');
    expect(result.metadata?.errors).toHaveLength(1);
  });
});

// ── wiki_read handler ──

describe('wiki_read handler', () => {
  it('primary official rest.php ok → cleaned wikitext + 来源/许可/检索日期, via=rest', async () => {
    const fetcher = makeFetcher(() => okJson(REST_PAGE_FIXTURE));
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅' }));

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]).toBe(restPageUrl(CN, '阿米娅'));
    expect(result.output).toContain('# 阿米娅');
    expect(result.output).toContain(`来源: ${restPageUrl(CN, '阿米娅')}`);
    expect(result.output).toContain('许可: 知识共享 署名-非商业性使用-相同方式共享 3.0');
    expect(result.output).toMatch(/检索日期: \d{4}-\d{2}-\d{2}/);
    // cleaning applied
    expect(result.output).not.toContain('<ref');
    expect(result.output).toContain('{{明日方舟人物信息|称号=首领}}');
    expect(result.metadata).toMatchObject({ site: 'moegirl-cn', via: 'rest', truncated: false, url: restPageUrl(CN, '阿米娅') });
  });

  it('official 404 → degrades to mirror api.php?action=parse (via=mirror-parse + 备注)', async () => {
    const fetcher = makeFetcher((url) =>
      url.startsWith('https://zh.moegirl.org.cn/') ? httpFail(404) : okJson(PARSE_FIXTURE),
    );
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅' }));

    expect(fetcher.calls).toEqual([restPageUrl(CN, '阿米娅'), parsePageUrl(UK, '阿米娅')]);
    expect(result.metadata).toMatchObject({ site: 'moegirl-uk', via: 'mirror-parse', url: parsePageUrl(UK, '阿米娅') });
    expect(result.output).toContain(`来源: ${parsePageUrl(UK, '阿米娅')}`);
    expect(result.output).toContain('降级镜像站');
    expect(result.output).toContain('# 阿米娅');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('official transport failure → mirror degradation still succeeds', async () => {
    const fetcher = makeFetcher((url) =>
      url.startsWith('https://zh.moegirl.org.cn/') ? netFail : okJson(PARSE_FIXTURE),
    );
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅' }));
    expect(result.metadata?.via).toBe('mirror-parse');
  });

  it('official 200 non-JSON → mirror degradation (shape failure degrades)', async () => {
    const fetcher = makeFetcher((url) =>
      url.startsWith('https://zh.moegirl.org.cn/') ? { ok: true, status: 200 } : okJson(PARSE_FIXTURE),
    );
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅' }));
    expect(result.metadata?.via).toBe('mirror-parse');
  });

  it("site='moegirl-uk' primary ok → mirror rest.php works too (via=rest)", async () => {
    const fetcher = makeFetcher(() => okJson(REST_PAGE_FIXTURE));
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅', site: 'moegirl-uk' }));
    expect(fetcher.calls).toEqual([restPageUrl(UK, '阿米娅')]);
    expect(result.metadata?.site).toBe('moegirl-uk');
    expect(result.metadata?.via).toBe('rest');
  });

  it("site='moegirl-uk' primary fails → falls back to the OFFICIAL rest.php (via=rest-fallback)", async () => {
    const fetcher = makeFetcher((url) =>
      url.startsWith('https://moegirl.uk/') ? httpFail(502) : okJson(REST_PAGE_FIXTURE),
    );
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅', site: 'moegirl-uk' }));
    expect(fetcher.calls).toEqual([restPageUrl(UK, '阿米娅'), restPageUrl(CN, '阿米娅')]);
    expect(result.metadata).toMatchObject({ site: 'moegirl-cn', via: 'rest-fallback' });
    expect(result.output).toContain('降级备用站');
  });

  it('all sources fail → friendly failure summary listing each site, never throws', async () => {
    const fetcher = makeFetcher(() => netFail);
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅' }));

    expect(fetcher.calls).toHaveLength(2); // official rest + mirror parse both attempted
    expect(result.output).toContain('读取失败');
    expect(result.output).toContain('官方站');
    expect(result.output).toContain('镜像站');
    expect(result.output).toContain('wiki_search');
    expect(result.metadata?.error).toContain('网络请求失败');
    expect(warn).toHaveBeenCalled();
  });

  it('P24: the mirror api.php parse path carries the hard-coded CC BY-NC-SA 3.0 license (provenance)', async () => {
    const fetcher = makeFetcher((url) =>
      url.startsWith('https://zh.moegirl.org.cn/') ? httpFail(404) : okJson(PARSE_FIXTURE),
    );
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅' }));

    expect(result.metadata?.via).toBe('mirror-parse');
    expect(result.output).toContain('许可: CC BY-NC-SA 3.0');
    expect(result.output).toContain('creativecommons.org/licenses/by-nc-sa/3.0');
  });

  it('P17: an aborted signal between fallbacks reports 已取消, NOT 全站失败', async () => {
    const controller = new AbortController();
    const fetcher = makeFetcher(() => {
      // Abort DURING the primary fetch → the fallback loop's per-site abort
      // check fires before any further site is contacted.
      controller.abort();
      return httpFail(404);
    });
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler({ params: { title: '阿米娅' }, projectDir: '/proj/alpha', sessionId: 's1', abort: controller.signal });

    expect(fetcher.calls).toHaveLength(1); // no fallback site was contacted
    expect(result.output).toContain('已取消');
    expect(result.output).not.toContain('读取失败');
    expect(result.metadata).toMatchObject({ error: 'aborted' });
  });

  it('P17: the degradation loop honors ONE 30s total budget — later sites are not attempted after it runs out', async () => {
    let t = 1_000_000;
    const fetcher = makeFetcher((url) => {
      if (url.startsWith('https://zh.moegirl.org.cn/')) {
        t += WIKI_READ_TOTAL_BUDGET_MS + 1; // primary fetch ate the whole budget
        return httpFail(404);
      }
      return okJson(PARSE_FIXTURE);
    });
    const handler = createWikiReadHandler({ ...zeroDeps(fetcher.fn), now: () => t });

    const result = await handler(ctx({ title: '阿米娅' }));

    expect(fetcher.calls).toHaveLength(1); // fallback site never contacted
    expect(result.output).toContain('总预算耗尽');
    expect(result.output).toContain('读取失败'); // still the friendly all-sources summary
  });

  it('oversized wikitext → capped at 16000 with truncation tail + full url', async () => {
    const big = `${'长'.repeat(WIKITEXT_CAP + 2000)}`;
    const fetcher = makeFetcher(() => okJson({ ...REST_PAGE_FIXTURE, source: big }));
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅' }));

    expect(result.metadata?.truncated).toBe(true);
    expect((result.metadata?.chars as number)).toBeGreaterThanOrEqual(WIKITEXT_CAP);
    expect(result.output).toContain('[已截断，全文：');
    expect(result.output).toContain(restPageUrl(CN, '阿米娅'));
  });

  it('missing/empty title → friendly full-width-bracket guidance, zero network', async () => {
    const fetcher = makeFetcher(() => okJson(REST_PAGE_FIXTURE));
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const missing = await handler(ctx({}));
    expect(missing.output).toContain('参数无效');
    expect(missing.output).toContain('全角括号');

    const blank = await handler(ctx({ title: '   ' }));
    expect(blank.output).toContain('参数无效');
    expect(fetcher.calls).toHaveLength(0);
  });

  it('unknown site → friendly known-site list, zero network', async () => {
    const fetcher = makeFetcher(() => okJson(REST_PAGE_FIXTURE));
    const handler = createWikiReadHandler(zeroDeps(fetcher.fn));

    const result = await handler(ctx({ title: '阿米娅', site: 'fandom' }));
    expect(result.output).toContain('未知站点');
    expect(result.output).toContain('moegirl-cn');
    expect(fetcher.calls).toHaveLength(0);
  });
});

// ── Param coercion (pure) ──

describe('coerceSearchParams', () => {
  it('passes valid shapes through; clamps limit; drops invalid shapes', () => {
    expect(coerceSearchParams({ query: '阿米娅', site: 'auto', limit: 5 })).toEqual({ query: '阿米娅', site: 'auto', limit: 5 });
    expect(coerceSearchParams({ query: 'x', limit: 99 }).limit).toBe(10);
    expect(coerceSearchParams({ query: 'x', limit: 0 }).limit).toBe(1);
    expect(coerceSearchParams({ query: 'x', limit: 'ten' }).limit).toBeUndefined();
    expect(coerceSearchParams({ query: 'x', site: '' }).site).toBeUndefined();
    expect(coerceSearchParams({ query: 42, site: 'auto' })).toEqual({ query: undefined, site: 'auto', limit: undefined });
  });
});

// ── Default handlers exist (toolExecution wiring imports these consts) ──

describe('default handler exports', () => {
  it('are functions (registered by toolExecution as wiki_search / wiki_read)', async () => {
    const { wikiSearchHandler, wikiReadHandler } = await import('../main/ipc/toolHandlers/wikiHandlers');
    expect(typeof wikiSearchHandler).toBe('function');
    expect(typeof wikiReadHandler).toBe('function');
  });
});
