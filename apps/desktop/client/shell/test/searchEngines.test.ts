/**
 * Search engine adapter tests (Story 3.6 WP4 / design D9).
 *
 * ZERO network: HTML fixtures are hand-written minimal samples shaped exactly
 * like the 2026-08-15 本机实测 baseline (bing b_algo block / baidu c-container
 * block / captcha pages / searxng-tavily-bocha-anysearch json envelopes); every
 * fetch goes through an injected recording stub. The tests lock OUR ported
 * selector logic only (openserp / SearXNG / ddgs blueprints) — the live SERPs
 * WILL drift; a site redesign = swap the fixture + selectors, single point.
 *
 * electron is stubbed so the real netFetch module loads (ResearchNetworkError
 * class identity stays intact for instanceof checks).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

import {
  createBaiduHtmlAdapter,
  createBingHtmlAdapter,
  createDdgHtmlAdapter,
  createSearxngAdapter,
  createAnysearchAdapter,
  createBochaAdapter,
  createTavilyAdapter,
  extractCookiePair,
  looksLikeBaiduCaptcha,
  looksLikeBingCaptcha,
  parseBaiduHtml,
  parseBingHtml,
  parseBochaJson,
  parseDdgHtml,
  parseSearxngJson,
  parseTavilyJson,
  parseAnysearchJson,
  unwrapDdgRedirect,
  EngineUnavailableError,
  netEngineFetch,
  type EngineFetchInit,
  type EngineFetchOpts,
  type EngineFetcher,
  type EngineFetchResult,
} from '../main/research/searchEngines';

// ── Fixture helpers ──

const signal = new AbortController().signal;

function res(text: string, init: Partial<EngineFetchResult> = {}): EngineFetchResult {
  return { status: 200, ok: true, text, ...init };
}

/** Recording fetcher: routes by URL substring; unmatched URLs throw (network). */
function makeFetcher(
  routes: Record<string, EngineFetchResult | Error>,
): { fetcher: EngineFetcher; calls: { url: string; init?: EngineFetchInit; opts?: EngineFetchOpts }[] } {
  const calls: { url: string; init?: EngineFetchInit; opts?: EngineFetchOpts }[] = [];
  return {
    calls,
    fetcher: async (url, init, opts) => {
      calls.push({ url, init, opts });
      for (const [needle, value] of Object.entries(routes)) {
        if (url.includes(needle)) {
          if (value instanceof Error) throw value;
          return value;
        }
      }
      throw new Error(`network fail: ${url}`);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Fixtures (2026-08-15 实测基线 minimal samples) ──

const BING_HTML = `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/arknights" aria-label="明日方舟官网">明日方舟 - 官网</a></h2><div class="b_caption"><p><span class="algoSlug_icon">图标</span>《明日方舟》是由鹰角网络开发的战术策略手游。</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/blank"></a></h2><div class="b_caption"><p>空标题块。</p></div></li>
<li class="b_algo"><h2><a aria-label="罗德岛档案库"></a></h2><div class="b_caption"><div>caption div 兜底摘要。</div></div></li>
<li class="b_ad"><h2><a href="https://ad.example.com/promo">广告位</a></h2><div class="b_caption"><p>买它</p></div></li>
<div class="b_ans"><li class="b_algo"><h2><a href="https://carousel.example.com/x">轮播复用块</a></h2></li></div>
</ol></body></html>`;

const BAIDU_HTML = `<html><body><div id="content_left">
<div class="result c-container new-pmd" data-tuiguang="1"><h3><a href="http://ad.example.com/1">推广结果</a></h3><div class="c-abstract">推广摘要</div></div>
<div class="result c-container new-pmd" srcid="1599"><h3><a href="http://www.baidu.com/link?url=abc">阿米娅 - 萌娘百科</a></h3><div class="c-abstract">阿米娅是《明日方舟》的主角。</div></div>
<div class="result c-container"><h3><a href="http://www.baidu.com/link?url=def">明日方舟</a></h3><span class="content-right_3Jb4I">罗德岛的领导者。</span></div>
<div class="result c-container"><h3><a href="http://www.baidu.com/link?url=ghi">干员档案</a></h3><div class="summary-gap_68jXq">hash 后缀摘要。</div></div>
<div class="c-container new-pmd"><h3><a href="http://www.baidu.com/link?url=jkl">无 result 类的块</a></h3></div>
</div></body></html>`;

const BAIDU_CAPTCHA_HTML = '<html><body><div class="passMod_dialog-wrapper"><div>百度安全验证</div></div></body></html>';

const BAIDU_NO_RESULT_HTML = '<html><body><div id="content_left"><div class="content_none">很抱歉，没有找到</div></div></body></html>';

const BING_CAPTCHA_HTML = '<html><body><div class="captcha_header">Verify that you are not a robot</div></body></html>';

const DDG_HTML = `<html><body>
<div class="links_main links_deep result__body">
<h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Famiya&rut=abc123">阿米娅 - 萌娘百科</a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Famiya&rut=abc123">阿米娅是《明日方舟》的主角。</a>
</div>
<div class="links_main links_deep result__body">
<h2><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=foo&uddg=https%3A%2F%2Fad.example.com">广告结果</a></h2>
</div>
<div class="links_main links_deep result__body">
<h2><a class="result__a" href="https://plain.example.com/direct">直接链接结果</a></h2>
</div>
</body></html>`;

const SEARXNG_JSON = JSON.stringify({
  query: '阿米娅',
  results: [
    { title: '阿米娅', url: 'https://example.com/amiya', content: '主角', engine: 'bing' },
    { title: '', url: 'https://example.com/empty-title', content: '缺标题被跳过' },
  ],
});

const TAVILY_JSON = JSON.stringify({
  query: '阿米娅',
  results: [{ title: '阿米娅', url: 'https://example.com/amiya', content: 'Tavily 摘要', score: 0.99 }],
});

const BOCHA_JSON = JSON.stringify({
  code: 200,
  data: {
    webPages: {
      value: [
        { name: '阿米娅', url: 'https://example.com/amiya', snippet: '', summaries: [{ text: '博查长摘要' }] },
      ],
    },
  },
});

const ANYSEARCH_JSON = JSON.stringify({
  code: 0,
  data: { results: [{ title: '阿米娅', url: 'https://example.com/amiya', snippet: '', content: 'AnySearch 正文摘要' }] },
});

// ── Bing ──

describe('parseBingHtml (openserp + SearXNG bing.py port)', () => {
  it('parses b_algo blocks: h2 a title/href + b_caption p snippet with algoSlug stripped', () => {
    const hits = parseBingHtml(BING_HTML);
    // 1 full hit: block 2 has no anchor text AND no aria-label-with-href →
    // skipped; block 3 has aria-label but no href → skipped (SearXNG rule).
    expect(hits.length).toBe(1);

    expect(hits[0]).toEqual({
      title: '明日方舟 - 官网',
      url: 'https://example.com/arknights',
      snippet: '《明日方舟》是由鹰角网络开发的战术策略手游。', // slug icon text stripped
      engine: 'bing',
    });
  });

  it('falls back to aria-label when the anchor text is empty (openserp fallback chain)', () => {
    const hits = parseBingHtml(BING_HTML);
    // Block 3: empty <a> text but aria-label present — no href though → still skipped.
    // The aria-label fallback case with a href:
    const html = '<ol id="b_results"><li class="b_algo"><h2><a aria-label="可见标题" href="https://x.example.com/a"></a></h2></li></ol>';
    const withHref = parseBingHtml(html);
    expect(withHref[0]?.title).toBe('可见标题');
    expect(hits.find((h) => h.title === '罗德岛档案库')).toBeUndefined(); // no href → skipped
  });

  it('direct-child selector excludes the carousel block that reuses b_algo styling', () => {
    const hits = parseBingHtml(BING_HTML);
    expect(hits.find((h) => h.url === 'https://carousel.example.com/x')).toBeUndefined();
  });

  it('excludes li.b_ad commercial slots (only b_algo selected)', () => {
    const hits = parseBingHtml(BING_HTML);
    expect(hits.find((h) => h.url === 'https://ad.example.com/promo')).toBeUndefined();
  });
});

describe('bing adapter', () => {
  it('returns hits on 200', async () => {
    const { fetcher, calls } = makeFetcher({ '/search': res(BING_HTML) });
    const hits = await createBingHtmlAdapter(fetcher).search('明日方舟', signal);
    expect(hits.length).toBe(1);
    expect(calls[0]?.url).toBe('https://cn.bing.com/search?q=' + encodeURIComponent('明日方舟'));
  });

  it('captcha page → anti-bot EngineUnavailableError', async () => {
    const { fetcher } = makeFetcher({ '/search': res(BING_CAPTCHA_HTML) });
    await expect(createBingHtmlAdapter(fetcher).search('x', signal)).rejects.toMatchObject({
      reason: 'anti-bot',
    });
    expect(looksLikeBingCaptcha(BING_CAPTCHA_HTML)).toBe(true);
  });

  it('0 parsed hits (legit empty page) → empty, non-2xx → http', async () => {
    const empty = makeFetcher({ '/search': res('<ol id="b_results"></ol>') });
    await expect(createBingHtmlAdapter(empty.fetcher).search('x', signal)).rejects.toMatchObject({ reason: 'empty' });

    const http = makeFetcher({ '/search': res('denied', { status: 403, ok: false }) });
    await expect(createBingHtmlAdapter(http.fetcher).search('x', signal)).rejects.toMatchObject({ reason: 'http' });
  });
});

// ── Baidu ──

describe('parseBaiduHtml (openserp baidu port)', () => {
  it('parses result c-container blocks: h3 a + c-abstract, skipping tuiguang ads', () => {
    const hits = parseBaiduHtml(BAIDU_HTML);
    expect(hits.map((h) => h.title)).toEqual(['阿米娅 - 萌娘百科', '明日方舟', '干员档案', '无 result 类的块']);
    expect(hits[0]?.snippet).toBe('阿米娅是《明日方舟》的主角。');
  });

  it('prefix-matches the hash-suffix abstract classes (content-right_ / summary-gap_ trap)', () => {
    const hits = parseBaiduHtml(BAIDU_HTML);
    expect(hits[1]?.snippet).toBe('罗德岛的领导者。'); // content-right_3Jb4I
    expect(hits[2]?.snippet).toBe('hash 后缀摘要。'); // summary-gap_68jXq
  });

  it('covers blocks that drop the result class via the new-pmd alt selector', () => {
    const hits = parseBaiduHtml(BAIDU_HTML);
    expect(hits[3]?.url).toBe('http://www.baidu.com/link?url=jkl');
  });
});

describe('baidu adapter', () => {
  it('bootstraps BAIDUID from the homepage set-cookie, then searches WITH the cookie (hardening)', async () => {
    // `/s?wd=` listed FIRST — the search URL also contains `baidu.com/`, and
    // routes match in insertion order.
    const { fetcher, calls } = makeFetcher({
      '/s?wd=': res(BAIDU_HTML),
      'baidu.com/': res('', { setCookie: ['BAIDUID=ABC123:FG=1; Path=/; Max-Age=31536000', 'BIDUPSID=XYZ; Path=/'] }),
    });
    const hits = await createBaiduHtmlAdapter(fetcher).search('阿米娅', signal);
    expect(hits.length).toBe(4);

    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toBe('https://www.baidu.com/'); // homepage first
    expect(calls[1]?.url).toContain('/s?wd=');
    expect((calls[1]?.init?.headers as Record<string, string>).cookie).toBe('BAIDUID=ABC123:FG=1'); // BAIDUID only
  });

  it('homepage bootstrap failure degrades to the bare search (no cookie header)', async () => {
    const { fetcher, calls } = makeFetcher({ '/s?wd=': res(BAIDU_HTML) }); // homepage unrouted → network fail
    const hits = await createBaiduHtmlAdapter(fetcher).search('阿米娅', signal);
    expect(hits.length).toBe(4);
    expect((calls[1]?.init?.headers as Record<string, string> | undefined)?.cookie).toBeUndefined();
  });

  it('P13: a FAILED bootstrap is probed exactly ONCE — later searches never re-hit the homepage', async () => {
    // Homepage unrouted (probe fails); the adapter must not re-probe on every
    // search — a repeated homepage hit is itself a risk-control trigger.
    const { fetcher, calls } = makeFetcher({ '/s?wd=': res(BAIDU_HTML) });
    const adapter = createBaiduHtmlAdapter(fetcher);
    await adapter.search('第一次', signal);
    await adapter.search('第二次', signal);
    await adapter.search('第三次', signal);
    const homeCalls = calls.filter((c) => c.url === 'https://www.baidu.com/');
    expect(homeCalls.length).toBe(1); // probed once, sentinel stuck at ''
    expect(calls.filter((c) => c.url.includes('/s?wd=')).length).toBe(3);
  });

  it('captcha page → anti-bot; no-result page → empty', async () => {
    const captcha = makeFetcher({ '/s?wd=': res(BAIDU_CAPTCHA_HTML) });
    await expect(createBaiduHtmlAdapter(captcha.fetcher).search('x', signal)).rejects.toMatchObject({ reason: 'anti-bot' });

    const noResult = makeFetcher({ '/s?wd=': res(BAIDU_NO_RESULT_HTML) });
    await expect(createBaiduHtmlAdapter(noResult.fetcher).search('x', signal)).rejects.toMatchObject({ reason: 'empty' });
  });

  it('wappass redirect landing (finalUrl) counts as captcha (SearXNG baidu.py)', async () => {
    expect(looksLikeBaiduCaptcha('<html></html>', 'https://wappass.baidu.com/captcha?x=1')).toBe(true);
    expect(looksLikeBaiduCaptcha('<html>正常页</html>', 'https://www.baidu.com/s?wd=x')).toBe(false);
  });
});

// ── DDG ──

describe('parseDdgHtml (ddgs port)', () => {
  it('parses result__body blocks, filters y.js ads, unwraps uddg redirects', () => {
    const hits = parseDdgHtml(DDG_HTML);
    expect(hits.length).toBe(2);
    expect(hits[0]).toEqual({
      title: '阿米娅 - 萌娘百科',
      url: 'https://example.com/amiya', // unwrapped from //duckduckgo.com/l/?uddg=…
      snippet: '阿米娅是《明日方舟》的主角。',
      engine: 'ddg',
    });
    expect(hits[1]?.url).toBe('https://plain.example.com/direct'); // plain href passes through
    expect(hits.find((h) => h.url.includes('ad.example.com'))).toBeUndefined(); // ad dropped
  });

  it('unwrapDdgRedirect leaves non-wrapped hrefs untouched', () => {
    expect(unwrapDdgRedirect('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(unwrapDdgRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2Fy&rut=z')).toBe('https://x.com/y');
  });
});

describe('ddg adapter', () => {
  it('POSTs form-encoded q to the html endpoint (no vqd token)', async () => {
    const { fetcher, calls } = makeFetcher({ 'html.duckduckgo.com': res(DDG_HTML) });
    const hits = await createDdgHtmlAdapter(fetcher).search('阿米娅', signal);
    expect(hits.length).toBe(2);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(`q=${encodeURIComponent('阿米娅')}`);
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('anomaly page parses to 0 → anti-bot; plain empty → empty', async () => {
    const anomaly = makeFetcher({ 'duckduckgo': res('<html>If this persists you have likely been flagged for an anomaly. bots.</html>') });
    await expect(createDdgHtmlAdapter(anomaly.fetcher).search('x', signal)).rejects.toMatchObject({ reason: 'anti-bot' });

    const empty = makeFetcher({ 'duckduckgo': res('<html><body>no results</body></html>') });
    await expect(createDdgHtmlAdapter(empty.fetcher).search('x', signal)).rejects.toMatchObject({ reason: 'empty' });
  });
});

// ── JSON engines ──

describe('searxng adapter + parseSearxngJson', () => {
  it('parses results[] {title,url,content}', () => {
    const hits = parseSearxngJson(SEARXNG_JSON);
    expect(hits).toEqual([{ title: '阿米娅', url: 'https://example.com/amiya', snippet: '主角', engine: 'searxng' }]);
  });

  it('tries URLs in order; first URL that yields hits wins', async () => {
    const { fetcher, calls } = makeFetcher({
      'bad.example': res('not json', { status: 200 }),
      'good.example': res(SEARXNG_JSON),
    });
    const hits = await createSearxngAdapter(['https://bad.example', 'https://good.example/'], fetcher).search('阿米娅', signal);
    expect(hits.length).toBe(1);
    expect(calls.map((c) => c.url)).toEqual([
      'https://bad.example/search?q=%E9%98%BF%E7%B1%B3%E5%A8%85&format=json',
      'https://good.example/search?q=%E9%98%BF%E7%B1%B3%E5%A8%85&format=json',
    ]);
  });

  it('all URLs failing → last error; all answering-but-empty → empty', async () => {
    const allFail = makeFetcher({ 'a.example': res('x', { status: 500, ok: false }), 'b.example': res('y', { status: 403, ok: false }) });
    await expect(
      createSearxngAdapter(['https://a.example', 'https://b.example'], allFail.fetcher).search('q', signal),
    ).rejects.toMatchObject({ reason: 'http' });

    const allEmpty = makeFetcher({ 'a.example': res('{"results":[]}'), 'b.example': res('{"results":[]}') });
    await expect(
      createSearxngAdapter(['https://a.example', 'https://b.example'], allEmpty.fetcher).search('q', signal),
    ).rejects.toMatchObject({ reason: 'empty' });
  });

  it('P18: a 200 NON-JSON body is an http-class endpoint error (json format not enabled), NOT empty', async () => {
    const htmlOnly = makeFetcher({ 'a.example': res('<html>json format disabled</html>') });
    await expect(
      createSearxngAdapter(['https://a.example'], htmlOnly.fetcher).search('q', signal),
    ).rejects.toMatchObject({
      reason: 'http',
      message: expect.stringContaining('json format'),
    });
  });

  it('P18: a REAL per-URL error outranks the empty classification in the final verdict', async () => {
    // URL A answers a VALID but resultless envelope; URL B answers non-JSON
    // (a real endpoint problem). The honest verdict is B's error, not "empty".
    const mixed = makeFetcher({
      'a.example': res('{"results":[]}'),
      'b.example': res('<html>not json</html>'),
    });
    await expect(
      createSearxngAdapter(['https://a.example', 'https://b.example'], mixed.fetcher).search('q', signal),
    ).rejects.toMatchObject({ reason: 'http', message: expect.stringContaining('不是 JSON') });
  });
});

describe('tavily / bocha / anysearch adapters', () => {
  it('tavily: Bearer key POST → results[] {title,url,content}', async () => {
    const { fetcher, calls } = makeFetcher({ 'api.tavily.com': res(TAVILY_JSON) });
    const hits = await createTavilyAdapter('tvly-test', fetcher).search('阿米娅', signal);
    expect(hits[0]).toEqual({ title: '阿米娅', url: 'https://example.com/amiya', snippet: 'Tavily 摘要', engine: 'tavily' });
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tvly-test');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('bocha: Bing-compatible envelope, summaries[] fallback when snippet empty', async () => {
    const hits = parseBochaJson(BOCHA_JSON);
    expect(hits[0]).toEqual({ title: '阿米娅', url: 'https://example.com/amiya', snippet: '博查长摘要', engine: 'bocha' });

    const { fetcher, calls } = makeFetcher({ 'api.bochaai.com': res(BOCHA_JSON) });
    const viaAdapter = await createBochaAdapter('sk-bocha', fetcher).search('阿米娅', signal);
    expect(viaAdapter.length).toBe(1);
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-bocha');
  });

  it('bocha: code !== 200 envelope parses to 0 → empty', () => {
    expect(parseBochaJson('{"code":429,"msg":"limit"}')).toEqual([]);
  });

  it('anysearch: code:0 envelope {data.results[]}, anonymous works (no auth header without key)', async () => {
    expect(parseAnysearchJson(ANYSEARCH_JSON)[0]?.snippet).toBe('AnySearch 正文摘要'); // snippet falls back to content

    const { fetcher, calls } = makeFetcher({ 'api.anysearch.com': res(ANYSEARCH_JSON) });
    const hits = await createAnysearchAdapter(undefined, fetcher).search('阿米娅', signal);
    expect(hits.length).toBe(1);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined(); // key optional — anonymous
    expect(headers['content-type']).toBe('application/json');
  });

  it('anysearch: code !== 0 envelope → empty via adapter', async () => {
    const { fetcher } = makeFetcher({ 'api.anysearch.com': res('{"code":401,"message":"unauthorized"}') });
    await expect(createAnysearchAdapter(undefined, fetcher).search('q', signal)).rejects.toMatchObject({ reason: 'empty' });
  });
});

// ── Misc ──

describe('shared helpers', () => {
  it('extractCookiePair takes the first pair of a set-cookie header', () => {
    expect(extractCookiePair('BAIDUID=ABC:FG=1; Path=/; Max-Age=1')).toBe('BAIDUID=ABC:FG=1');
  });

  it('EngineUnavailableError carries engineId + reason', () => {
    const err = new EngineUnavailableError('bing', 'anti-bot', 'x');
    expect(err.name).toBe('EngineUnavailableError');
    expect(err.engineId).toBe('bing');
    expect(err.reason).toBe('anti-bot');
  });

  it('netEngineFetch is exported as the default fetch seam', () => {
    expect(typeof netEngineFetch).toBe('function');
  });
});
