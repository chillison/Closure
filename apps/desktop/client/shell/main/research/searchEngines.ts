/**
 * Search engine adapters (Story 3.6 WP4, R2 / design D9).
 *
 * One adapter per engine behind a uniform contract:
 *
 *   EngineAdapter = { id, kind, hosts, search(query, signal) → SearchHit[] }
 *
 * Failure contract: adapters NEVER return an empty array as "success" — zero
 * parsed hits throw `EngineUnavailableError('empty')`; transport failures
 * propagate the fetcher's `ResearchNetworkError` for the CHAIN executor to map
 * (timeout / network / abort). Anti-bot (captcha page signatures) and HTTP
 * status anomalies are classified here, per engine, from the ported selector
 * blueprints. This is what lets the chain degrade gracefully engine-by-engine
 * (R8) instead of failing the whole search.
 *
 * HTML selectors are PORTED, not invented (2026-08-15 user directive 别从零踩坑):
 *   - bing  : openserp `bing/selectors.go` (`#b_results > li.b_algo` direct-child
 *     + `h2 a` with aria-label fallback + `b_caption p/div/p` 3-level snippet)
 *     + SearXNG `engines/bing.py` (empty href/title skip + `span.algoSlug_icon`
 *     noise strip).
 *   - baidu : openserp `baidu/selectors.go` (`#content_left div.result.c-container`
 *     + `[data-tuiguang]` ad markers + `div.passMod_dialog-wrapper` captcha +
 *     hash-suffix abstract classes PREFIX-matched) + SearXNG `engines/baidu.py`
 *     (wappass redirect = captcha).
 *   - ddg   : ddgs `engines/duckduckgo.py` (POST html endpoint, body-class blocks,
 *     `duckduckgo.com/y.js?` ad filter, no vqd token).
 * A live SERP WILL drift — adapters are fixture-tested (test/searchEngines.test.ts
 * locks OUR parsing logic only; a site redesign = swap the fixture + selectors).
 *
 * Electron `net.fetch` carries a genuine Chromium TLS fingerprint, so the
 * tls-client fingerprint spoofing the Go/Python blueprints need is NOT ported
 * (design D9); UA stays the identifying research default (netFetch).
 */
import { parse } from 'node-html-parser';
import type { HTMLElement } from 'node-html-parser';
import { netFetch, readTextWithCap, ResearchNetworkError } from './netFetch';

// ── Types ──

/** Normalized search result. `engine` = source adapter id (provenance for the LLM). */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

/** Why an engine could not produce hits. Drives the chain's degrade + all-fail summary. */
export type EngineFailureReason = 'timeout' | 'anti-bot' | 'empty' | 'http' | 'network';

/** Typed engine failure — thrown by adapters, caught + classified by the chain executor. */
export class EngineUnavailableError extends Error {
  constructor(
    public readonly engineId: string,
    public readonly reason: EngineFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

export interface EngineAdapter {
  /** Chain-order id (config engineOrder / SearchHit.engine). */
  id: string;
  /** `builtin` = zero-config free engine; `configured` = user-enabled upgrade layer. */
  kind: 'builtin' | 'configured';
  /** Hostname(s) this adapter talks to — the chain executor's EngineGate keys. */
  hosts: string[];
  /** Search; zero hits throws `EngineUnavailableError('empty')`, never resolves `[]` as success. */
  search(query: string, signal: AbortSignal): Promise<SearchHit[]>;
}

// ── Fetch seam ──

/** Minimal fetch view an adapter needs (status/body/final URL/cookies). */
export interface EngineFetchResult {
  status: number;
  ok: boolean;
  text: string;
  /** Post-redirect landing URL (baidu wappass captcha detection). */
  finalUrl?: string;
  /** `set-cookie` headers (baidu BAIDUID bootstrap). */
  setCookie?: string[];
}

export interface EngineFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface EngineFetchOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Injectable fetcher (tests pass fixture-backed stubs; ZERO network). */
export type EngineFetcher = (url: string, init?: EngineFetchInit, opts?: EngineFetchOpts) => Promise<EngineFetchResult>;

/**
 * SERP HTML body budget (P3, CR 2026-08-15): a search engine response is read
 * through the netFetch streaming cap — the main process never buffers an
 * unbounded body (a lying/chunked SERP gets cut at 2MB).
 */
export const ENGINE_BODY_MAX_BYTES = 2 * 1024 * 1024;

/** Default fetcher: netFetch (research session — system proxy, Chromium TLS). */
export async function netEngineFetch(
  url: string,
  init: EngineFetchInit = {},
  opts: EngineFetchOpts = {},
): Promise<EngineFetchResult> {
  const res = await netFetch(
    url,
    { method: init.method, headers: init.headers, body: init.body, signal: opts.signal },
    { timeoutMs: opts.timeoutMs },
  );
  const text = await readTextWithCap(res, ENGINE_BODY_MAX_BYTES, url);
  const headers = res.headers as unknown as { getSetCookie?: () => string[] } | undefined;
  return {
    status: res.status,
    ok: res.ok,
    text,
    finalUrl: typeof res.url === 'string' && res.url ? res.url : undefined,
    setCookie: headers && typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : undefined,
  };
}

// ── Shared helpers ──

/** Collapse whitespace runs + trim (search snippets are one-line for the LLM). */
export function collapseWs(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function httpError(engineId: string, res: EngineFetchResult, url: string): EngineUnavailableError {
  return new EngineUnavailableError(engineId, 'http', `HTTP ${res.status}：${url}`);
}

function emptyError(engineId: string, query: string): EngineUnavailableError {
  return new EngineUnavailableError(engineId, 'empty', `「${query}」无搜索结果`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ── Bing (openserp bing/selectors.go + SearXNG engines/bing.py) ──

export const BING_BASE = 'https://cn.bing.com';

/** openserp bing captcha selectors + the two English text markers. */
export function looksLikeBingCaptcha(html: string): boolean {
  const root = parse(html);
  if (root.querySelector('div.captcha') || root.querySelector('div.captcha_header')) return true;
  const lower = html.toLowerCase();
  return lower.includes('verify that you are not a robot') || lower.includes('enter the characters you see');
}

/**
 * Parse a bing SERP. Direct-child `#b_results > li.b_algo` excludes the
 * carousel/related-search cards that REUSE b_algo styling deeper in the tree
 * (openserp) and the `li.b_ad` commercial slots (only b_algo is selected).
 */
export function parseBingHtml(html: string, engine = 'bing'): SearchHit[] {
  const root = parse(html);
  const blocks = root.querySelectorAll('#b_results > li.b_algo');
  const hits: SearchHit[] = [];
  for (const block of blocks) {
    const a = block.querySelector('h2 a');
    if (!a) continue;
    // Bing occasionally renders an empty <h2><a/></h2> — the visible title sits
    // in aria-label (openserp fallback chain: h2 a → h2 → a[aria-label]).
    let title = collapseWs(a.text);
    if (!title) {
      const label = a.getAttribute('aria-label');
      title = label ? collapseWs(label) : '';
    }
    const href = a.getAttribute('href') ?? '';
    // SearXNG bing.py: empty href OR empty title → skip the block.
    if (!title || !href) continue;
    hits.push({ title, url: href, snippet: bingSnippet(block), engine });
  }
  return hits;
}

/** `div.b_caption p` → `div.b_caption div` → any `p` (openserp 3-level fallback), algoSlug stripped. */
function bingSnippet(block: HTMLElement): string {
  const node =
    block.querySelector('div.b_caption p') ??
    block.querySelector('div.b_caption div') ??
    block.querySelector('p');
  if (!node) return '';
  // SearXNG bing.py: strip the `span.algoSlug_icon` noise prefix Bing injects
  // before recent snippets (the tree is throwaway — in-place removal is fine).
  node.querySelectorAll('span.algoSlug_icon').forEach((n) => n.remove());
  return collapseWs(node.text);
}

export function createBingHtmlAdapter(fetcher: EngineFetcher = netEngineFetch): EngineAdapter {
  return {
    id: 'bing',
    kind: 'builtin',
    hosts: ['cn.bing.com'],
    async search(query, signal) {
      const url = `${BING_BASE}/search?q=${encodeURIComponent(query)}`;
      const res = await fetcher(url, {}, { signal });
      if (!res.ok) throw httpError('bing', res, url);
      if (looksLikeBingCaptcha(res.text)) {
        throw new EngineUnavailableError('bing', 'anti-bot', `必应返回验证码页（captcha）：${url}`);
      }
      const hits = parseBingHtml(res.text, 'bing');
      if (hits.length === 0) throw emptyError('bing', query);
      return hits;
    },
  };
}

// ── Baidu (openserp baidu/selectors.go + SearXNG engines/baidu.py) ──
//
// Archived decision (2026-08-15 实测): baidu `tn=json` (the SearXNG master
// route) is a NEWS-SEARCH feed, not a general web SERP — NOT adopted here; the
// general web path stays HTML. A news-vertical consumer may revive it later.
const BAIDU_HOST = 'www.baidu.com';

/** openserp ad markers: promoted results carry tuiguang (推广) attributes/icons — on the block ITSELF or a descendant. */
function isBaiduAd(block: HTMLElement): boolean {
  // data-* markers sit on the result block itself — querySelector only sees
  // descendants, so self attributes are checked directly.
  if (block.hasAttribute('data-tuiguang')) return true;
  const dataClick = block.getAttribute('data-click');
  if (dataClick?.includes('tuiguang')) return true;
  if (block.querySelector('[data-tuiguang]')) return true;
  if (block.querySelector('[data-click*="tuiguang"]')) return true;
  if (block.querySelector('.ec-tuiguang')) return true;
  if (block.querySelector('.c-icon-bear-p')) return true;
  return false;
}

/** openserp baidu captcha: dialog wrapper selector + 「百度安全验证」text marker; SearXNG: wappass redirect. */
export function looksLikeBaiduCaptcha(html: string, finalUrl?: string): boolean {
  if (finalUrl && finalUrl.includes('wappass.baidu.com')) return true;
  const root = parse(html);
  if (root.querySelector('div.passMod_dialog-wrapper')) return true;
  if (root.querySelector('button.timeout-button')) return true;
  return html.includes('百度安全验证');
}

/**
 * Parse a baidu SERP. Main organic blocks `#content_left div.result.c-container`
 * (openserp); the `div.c-container.new-pmd` alt covers blocks that drop the
 * `result` class. A comma selector never double-counts an element matching both.
 */
export function parseBaiduHtml(html: string, engine = 'baidu'): SearchHit[] {
  const root = parse(html);
  const blocks = root.querySelectorAll('#content_left div.result.c-container, #content_left div.c-container.new-pmd');
  const hits: SearchHit[] = [];
  for (const block of blocks) {
    if (isBaiduAd(block)) continue;
    const a = block.querySelector('h3 a') ?? block.querySelector('a[href]');
    const title = a ? collapseWs(a.text) : '';
    const href = a?.getAttribute('href') ?? '';
    if (!title || !href) continue;
    hits.push({ title, url: href, snippet: baiduSnippet(block), engine });
  }
  return hits;
}

/**
 * Baidu abstract container classes carry a per-build hash suffix (`summary-
 * gap_3Jb4I` / `content-right_68jXq` coexist on the same page) — the fallbacks
 * must PREFIX-match, never exact-match (openserp 摘要 Alt trap).
 */
function baiduSnippet(block: HTMLElement): string {
  const node =
    block.querySelector('div.c-abstract') ??
    block.querySelector('[class*="content-right_"]') ??
    block.querySelector('[class*="summary-gap_"]');
  return node ? collapseWs(node.text) : '';
}

/** `BAIDUID=XXX:FG=1; Path=/; …` → `BAIDUID=XXX:FG=1` (first pair of a set-cookie header). */
export function extractCookiePair(setCookieHeader: string): string {
  const pair = setCookieHeader.split(';', 1)[0] ?? '';
  return pair.trim();
}

export function createBaiduHtmlAdapter(fetcher: EngineFetcher = netEngineFetch): EngineAdapter {
  // Bootstrap cookie sentinel (P13, CR 2026-08-15): `null` = not probed yet;
  // `''` = probed and FAILED — never re-fetch the homepage on every search (a
  // failing bootstrap retried per call is itself a risk-control trigger, the
  // opposite of the hardening's goal); a BAIDUID pair = use it. 2026-08-15
  // 本机实测: /s answers without any cookie — the bootstrap is HARDENING for
  // the risk-control path (调研: 裸抓弱 UA 会得「百度安全验证」), so a failed
  // bootstrap degrades to the bare search for the adapter's lifetime.
  let cachedCookie: string | null = null;

  async function ensureCookie(signal: AbortSignal): Promise<string> {
    if (cachedCookie !== null) return cachedCookie;
    cachedCookie = ''; // probed — a concurrent call must not re-probe
    try {
      const home = await fetcher(`https://${BAIDU_HOST}/`, {}, { signal, timeoutMs: 5_000 });
      const baiduid = (home.setCookie ?? [])
        .map(extractCookiePair)
        .find((pair) => pair.startsWith('BAIDUID=') && pair.length > 'BAIDUID='.length);
      if (baiduid) cachedCookie = baiduid;
    } catch {
      // Homepage fetch failed — bare search is the probed baseline ('' sticks).
    }
    return cachedCookie;
  }

  return {
    id: 'baidu',
    kind: 'builtin',
    hosts: [BAIDU_HOST],
    async search(query, signal) {
      const cookie = await ensureCookie(signal);
      const url = `https://${BAIDU_HOST}/s?wd=${encodeURIComponent(query)}&rn=10`;
      const headers: Record<string, string> = {};
      if (cookie) headers.cookie = cookie;
      const res = await fetcher(url, { headers }, { signal });
      if (!res.ok) throw httpError('baidu', res, url);
      if (looksLikeBaiduCaptcha(res.text, res.finalUrl)) {
        throw new EngineUnavailableError('baidu', 'anti-bot', `百度返回安全验证页：${url}`);
      }
      const hits = parseBaiduHtml(res.text, 'baidu');
      if (hits.length === 0) throw emptyError('baidu', query);
      return hits;
    },
  };
}

// ── DuckDuckGo (ddgs engines/duckduckgo.py) ──

const DDG_URL = 'https://html.duckduckgo.com/html/';

/** DDG html wraps external urls as `//duckduckgo.com/l/?uddg=<encoded>&rut=…` — unwrap to the target. */
export function unwrapDdgRedirect(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (!m) return href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

/**
 * Parse a DDG html SERP. Result blocks are the `result__body` divs (ddgs xpath
 * `//div[contains(@class,'body')]` — the real class is `links_main links_deep
 * result__body`); ads are hrefs under `duckduckgo.com/y.js?` (checked on the RAW
 * href, before uddg unwrapping, so an ad's wrapped target cannot slip through).
 */
export function parseDdgHtml(html: string, engine = 'ddg'): SearchHit[] {
  const root = parse(html);
  const blocks = root.querySelectorAll('div[class*="result__body"]');
  const hits: SearchHit[] = [];
  for (const block of blocks) {
    const a = block.querySelector('h2 a');
    if (!a) continue;
    const rawHref = a.getAttribute('href') ?? '';
    if (!rawHref || rawHref.includes('duckduckgo.com/y.js')) continue;
    const href = unwrapDdgRedirect(rawHref);
    const title = collapseWs(a.text);
    if (!title || !href) continue;
    const snippetNode = block.querySelector('a.result__snippet');
    hits.push({ title, url: href, snippet: snippetNode ? collapseWs(snippetNode.text) : '', engine });
  }
  return hits;
}

export function createDdgHtmlAdapter(fetcher: EngineFetcher = netEngineFetch): EngineAdapter {
  return {
    id: 'ddg',
    kind: 'builtin',
    hosts: ['html.duckduckgo.com'],
    async search(query, signal) {
      // ddgs port: POST form-encoded to the html endpoint (no vqd token needed).
      const res = await fetcher(
        DDG_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `q=${encodeURIComponent(query)}`,
        },
        { signal },
      );
      if (!res.ok) throw httpError('ddg', res, DDG_URL);
      const hits = parseDdgHtml(res.text, 'ddg');
      if (hits.length === 0) {
        // DDG anomaly/challenge pages also parse to 0 — anti-bot when the page
        // smells like a block, otherwise a genuine empty result.
        if (res.text.toLowerCase().includes('anomaly')) {
          throw new EngineUnavailableError('ddg', 'anti-bot', `DuckDuckGo 返回反爬拦截页：${DDG_URL}`);
        }
        throw emptyError('ddg', query);
      }
      return hits;
    },
  };
}

// ── JSON engines (shared envelope parsing) ──

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function pickString(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/**
 * Parse a SearXNG `format=json` response: `{ results: [{ title, url, content }] }`.
 * Distinguishes (P18, CR 2026-08-15) a body that is NOT JSON at all (an
 * instance without the json format enabled answers 200 with an HTML error
 * page — that is an endpoint problem, `'http'`-class) from a VALID envelope
 * that simply carries no usable results (`'empty'`).
 */
export function tryParseSearxng(text: string, engine = 'searxng'): { parseable: boolean; hits: SearchHit[] } {
  const json = parseJson(text);
  const root = asRecord(json);
  if (!root) return { parseable: false, hits: [] };
  const results = root.results;
  if (!Array.isArray(results)) return { parseable: false, hits: [] };
  const hits: SearchHit[] = [];
  for (const entry of results) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const title = pickString(rec, 'title');
    const url = pickString(rec, 'url');
    if (!title || !url) continue;
    hits.push({ title, url, snippet: pickString(rec, 'content'), engine });
  }
  return { parseable: true, hits };
}

/** Hits-only view of {@link tryParseSearxng} (empty when unparseable). */
export function parseSearxngJson(text: string, engine = 'searxng'): SearchHit[] {
  return tryParseSearxng(text, engine).hits;
}

/**
 * SearXNG adapter over a list of base URLs (public instances flake; try in
 * order, first URL that yields hits wins). REAL errors (transport failure /
 * non-2xx / 200 non-JSON, P18) take priority in the final throw — an
 * all-empty answer only wins when every URL actually parsed and came back
 * resultless; otherwise the last real error is the honest verdict.
 */
export function createSearxngAdapter(
  urls: readonly string[],
  fetcher: EngineFetcher = netEngineFetch,
  id = 'searxng',
  kind: EngineAdapter['kind'] = 'configured',
): EngineAdapter {
  return {
    id,
    kind,
    hosts: urls.map(hostOf),
    async search(query, signal) {
      let lastError: unknown;
      let anyAnsweredEmpty = false;
      for (const rawBase of urls) {
        const base = rawBase.replace(/\/+$/, '');
        const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
        try {
          const res = await fetcher(url, { headers: { accept: 'application/json' } }, { signal });
          if (!res.ok) {
            lastError = httpError(id, res, url);
            continue;
          }
          const parsed = tryParseSearxng(res.text, id);
          if (!parsed.parseable) {
            // P18: 200 with a non-JSON body = the instance almost surely has
            // the json format disabled — a REAL endpoint problem, not "empty".
            lastError = new EngineUnavailableError(
              id,
              'http',
              `SearXNG 实例返回 200 但响应不是 JSON（可能未开启 json format）：${url}`,
            );
            continue;
          }
          if (parsed.hits.length > 0) return parsed.hits;
          anyAnsweredEmpty = true;
        } catch (err) {
          // Abort must not try the next URL — the whole search is cancelled.
          if (err instanceof ResearchNetworkError && err.reason === 'abort') throw err;
          lastError = err;
        }
      }
      // P18 priority: a REAL per-URL error is the honest verdict; the empty
      // classification only wins when every URL parsed and answered resultless.
      if (lastError !== undefined) {
        throw lastError instanceof Error
          ? lastError
          : new EngineUnavailableError(id, 'network', `所有 SearXNG 实例均不可用`);
      }
      if (anyAnsweredEmpty) throw emptyError(id, query);
      throw new EngineUnavailableError(id, 'network', `所有 SearXNG 实例均不可用`);
    },
  };
}

/**
 * Parse a Tavily response: `{ results: [{ title, url, content }] }`.
 * (Bocha's Bing-compatible envelope is separate — see parseBochaJson.)
 */
export function parseTavilyJson(text: string, engine = 'tavily'): SearchHit[] {
  const root = asRecord(parseJson(text));
  if (!root || !Array.isArray(root.results)) return [];
  const hits: SearchHit[] = [];
  for (const entry of root.results) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const title = pickString(rec, 'title');
    const url = pickString(rec, 'url');
    if (!title || !url) continue;
    hits.push({ title, url, snippet: pickString(rec, 'content'), engine });
  }
  return hits;
}

export function createTavilyAdapter(apiKey: string, fetcher: EngineFetcher = netEngineFetch): EngineAdapter {
  return {
    id: 'tavily',
    kind: 'configured',
    hosts: ['api.tavily.com'],
    async search(query, signal) {
      const url = 'https://api.tavily.com/search';
      const res = await fetcher(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, max_results: 10 }),
        },
        { signal },
      );
      if (!res.ok) throw httpError('tavily', res, url);
      const hits = parseTavilyJson(res.text, 'tavily');
      if (hits.length === 0) throw emptyError('tavily', query);
      return hits;
    },
  };
}

/**
 * Parse a Bocha (博查) response — Bing-compatible envelope:
 * `{ code: 200, data: { webPages: { value: [{ name, url, snippet, summaries: [{ text }] }] } } }`.
 */
export function parseBochaJson(text: string, engine = 'bocha'): SearchHit[] {
  const root = asRecord(parseJson(text));
  if (!root) return [];
  const code = root.code;
  if (code !== undefined && code !== 200) return [];
  const data = asRecord(root.data);
  const webPages = asRecord(data?.webPages);
  const value = webPages?.value;
  if (!Array.isArray(value)) return [];
  const hits: SearchHit[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const title = pickString(rec, 'name');
    const url = pickString(rec, 'url');
    if (!title || !url) continue;
    let snippet = pickString(rec, 'snippet');
    if (!snippet && Array.isArray(rec.summaries)) {
      const first = asRecord(rec.summaries[0]);
      snippet = first ? pickString(first, 'text') : '';
    }
    hits.push({ title, url, snippet, engine });
  }
  return hits;
}

export function createBochaAdapter(apiKey: string, fetcher: EngineFetcher = netEngineFetch): EngineAdapter {
  return {
    id: 'bocha',
    kind: 'configured',
    hosts: ['api.bochaai.com'],
    async search(query, signal) {
      const url = 'https://api.bochaai.com/web-search';
      const res = await fetcher(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, summary: true, count: 10 }),
        },
        { signal },
      );
      if (!res.ok) throw httpError('bocha', res, url);
      const hits = parseBochaJson(res.text, 'bocha');
      if (hits.length === 0) throw emptyError('bocha', query);
      return hits;
    },
  };
}

/**
 * Parse an AnySearch REST v1 envelope:
 * `{ code: 0, data: { results: [{ title, url, snippet, content }] } }`.
 */
export function parseAnysearchJson(text: string, engine = 'anysearch'): SearchHit[] {
  const root = asRecord(parseJson(text));
  if (!root || root.code !== 0) return [];
  const data = asRecord(root.data);
  const results = data?.results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const entry of results) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const title = pickString(rec, 'title');
    const url = pickString(rec, 'url');
    if (!title || !url) continue;
    hits.push({ title, url, snippet: pickString(rec, 'snippet', 'content'), engine });
  }
  return hits;
}

/** AnySearch key is OPTIONAL — anonymous access works at a lower quota (调研 §1.3). */
export function createAnysearchAdapter(
  apiKey: string | undefined,
  fetcher: EngineFetcher = netEngineFetch,
): EngineAdapter {
  return {
    id: 'anysearch',
    kind: 'configured',
    hosts: ['api.anysearch.com'],
    async search(query, signal) {
      const url = 'https://api.anysearch.com/v1/search';
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetcher(
        url,
        { method: 'POST', headers, body: JSON.stringify({ query }) },
        { signal },
      );
      if (!res.ok) throw httpError('anysearch', res, url);
      const hits = parseAnysearchJson(res.text, 'anysearch');
      if (hits.length === 0) throw emptyError('anysearch', query);
      return hits;
    },
  };
}
