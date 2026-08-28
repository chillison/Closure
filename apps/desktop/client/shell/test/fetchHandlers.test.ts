/**
 * web_fetch + render_page handler tests (Story 3.6 WP5, R3/R12 / design D10).
 *
 * ZERO network / ZERO windows: the fetcher, guard and capture seams are
 * injected stubs. Locks: param coercion + clamping, the content-type dispatch
 * matrix, HTML→Markdown cleaning (script/style/nav stripped), capping +
 * provenance lines (来源/检索日期), redirect re-guarding (per-hop contract),
 * the friendly pdf/image/other hand-off hints, and never-throws on every
 * failure path (R8). render_page: capture passthrough options + output
 * assembly (text cap, 截图 list, analyze_image hand-off note) + graceful
 * failure outputs.
 *
 * electron + configIpc db-imports + logger mocked (fetchHandlers imports
 * searchConfig → configIpc transitively); turndown runs REAL so the HTML
 * cleaning assertions exercise the actual converter.
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
  app: { getPath: vi.fn(() => '/home') },
  dialog: {},
  BrowserWindow: vi.fn(),
}));
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import type { SearchConfig } from '@orison/shared-contracts';
import { SsrfBlockedError } from '../main/research/netGuard';
import { ResearchNetworkError } from '../main/research/netFetch';
import type { CaptureRenderedPageOptions, RenderCaptureOutcome } from '../main/research/renderCapture';
import {
  WEB_FETCH_DEFAULT_MAX_CHARS,
  WEB_FETCH_MAX_CHARS_LIMIT,
  capFetchedText,
  classifyContentType,
  coerceFetchParams,
  coerceRenderParams,
  createRenderPageHandler,
  createWebFetchHandler,
  htmlToMarkdown,
  renderPageHandler,
  researchFetchAllowlist,
  webFetchHandler,
  type FetchedPage,
  type PageFetcher,
} from '../main/ipc/toolHandlers/fetchHandlers';

// ── Fixtures / helpers ──

const URL_A = 'https://example.com/article';
const URL_B = 'https://mirror.example.com/article';

function pageFixture(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    status: 200,
    ok: true,
    finalUrl: URL_A,
    contentType: 'text/html; charset=utf-8',
    body: '<html><body><h1>标题</h1><p>正文段落。</p></body></html>',
    ...overrides,
  };
}

function ctx(params: Record<string, unknown>) {
  return { params, projectDir: '/proj/alpha', sessionId: 's1', abort: new AbortController().signal };
}

function fetchHandler(overrides: {
  fetchPage?: PageFetcher;
  guard?: (url: string, allowlist: readonly string[]) => Promise<void>;
  config?: SearchConfig;
} = {}) {
  return createWebFetchHandler({
    fetchPage: overrides.fetchPage ?? (async () => pageFixture()),
    loadConfig: () => overrides.config ?? { searxngLocalhostProbe: true },
    guard: overrides.guard ?? (async () => {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Pure helpers ──

describe('coerceFetchParams', () => {
  it('trims url, rejects blanks/non-strings, clamps maxChars into [1, 32000]', () => {
    expect(coerceFetchParams({ url: ` ${URL_A} ` })).toEqual({ url: URL_A, maxChars: undefined });
    expect(coerceFetchParams({ url: '   ' }).url).toBeUndefined();
    expect(coerceFetchParams({ url: 42 }).url).toBeUndefined();
    expect(coerceFetchParams({ url: 'x', maxChars: 99_999 }).maxChars).toBe(WEB_FETCH_MAX_CHARS_LIMIT);
    expect(coerceFetchParams({ url: 'x', maxChars: 0 }).maxChars).toBe(1);
    expect(coerceFetchParams({ url: 'x', maxChars: 1_234.6 }).maxChars).toBe(1235);
    expect(WEB_FETCH_DEFAULT_MAX_CHARS).toBe(16_000);
  });
});

describe('coerceRenderParams', () => {
  it('defaults expandCollapsibles=false / includeText=true', () => {
    expect(coerceRenderParams({ url: URL_A })).toEqual({ url: URL_A, expandCollapsibles: false, includeText: true });
    expect(coerceRenderParams({ url: URL_A, expandCollapsibles: true, includeText: false })).toEqual({
      url: URL_A,
      expandCollapsibles: true,
      includeText: false,
    });
  });
});

describe('classifyContentType (dispatch matrix)', () => {
  it('maps every family', () => {
    expect(classifyContentType('text/html; charset=utf-8')).toBe('html');
    expect(classifyContentType('application/xhtml+xml')).toBe('html');
    expect(classifyContentType('text/plain')).toBe('text');
    expect(classifyContentType('text/markdown')).toBe('text');
    expect(classifyContentType('application/json')).toBe('text');
    expect(classifyContentType('application/xml; charset=utf-8')).toBe('text');
    expect(classifyContentType('text/xml')).toBe('text');
    expect(classifyContentType('application/pdf')).toBe('pdf');
    expect(classifyContentType('image/png')).toBe('image');
    expect(classifyContentType('image/jpeg')).toBe('image');
    expect(classifyContentType('application/octet-stream')).toBe('other');
    expect(classifyContentType('video/mp4')).toBe('other');
  });

  it('an ABSENT content-type maps to text (type-less static hosts)', () => {
    expect(classifyContentType('')).toBe('text');
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings/paragraphs and strips script/style/nav noise', () => {
    const html = [
      '<html><head><title>t</title><style>.x{color:red}</style></head>',
      '<body>',
      '<nav><a href="/x">站点导航</a></nav>',
      '<script>evilTracking()</script>',
      '<noscript>请开 JS</noscript>',
      '<h1>文档标题</h1><p>正文内容。</p>',
      '</body></html>',
    ].join('');
    const md = htmlToMarkdown(html);
    expect(md).toContain('# 文档标题');
    expect(md).toContain('正文内容。');
    expect(md).not.toContain('evilTracking');
    expect(md).not.toContain('站点导航');
    expect(md).not.toContain('color:red');
    expect(md).not.toContain('请开 JS');
  });
});

describe('capFetchedText', () => {
  it('passes short text through; long text gets the 截断 tail', () => {
    expect(capFetchedText('短文本', 100)).toEqual({ text: '短文本', truncated: false });
    const { text, truncated } = capFetchedText('a'.repeat(100), 10);
    expect(truncated).toBe(true);
    expect(text.startsWith('a'.repeat(10))).toBe(true);
    expect(text).toContain('已截断');
    expect(text).toContain('仅保留前 10]');
  });
});

describe('researchFetchAllowlist (SSRF exemptions, P9 origin-level)', () => {
  it('extracts searxng URL ORIGINS (port included when configured), skips malformed entries', () => {
    expect(
      researchFetchAllowlist(
        {
          searxngLocalhostProbe: true,
          searxngUrls: ['http://localhost:8888', 'https://searx.example.com/search', 'not a url'],
        },
        // Hermetic: explicit unconfigured docParser — an omitted param reads
        // the machine's real doc-parser.yaml sidecar and would leak host state.
        {},
      ),
    ).toEqual(['localhost:8888', 'searx.example.com']);
  });

  it('no configured URLs → empty allowlist (guard stays fail-closed)', () => {
    expect(researchFetchAllowlist({ searxngLocalhostProbe: true }, {})).toEqual([]);
  });

  // ── WP6 seam: the docParser endpoint origin joins the allowlist ──

  it('docParser baseUrl ORIGIN is exempted port-exact (P9: 8000 opens 8000 only)', () => {
    expect(
      researchFetchAllowlist(
        { searxngLocalhostProbe: true },
        { type: 'mineru', baseUrl: 'http://127.0.0.1:8000/' },
      ),
    ).toEqual(['127.0.0.1:8000']);
  });

  it('unconfigured docParser adds nothing; malformed baseUrl is skipped', () => {
    expect(researchFetchAllowlist({ searxngLocalhostProbe: true }, {})).toEqual([]);
    expect(
      researchFetchAllowlist(
        { searxngLocalhostProbe: true, searxngUrls: ['http://localhost:8888'] },
        { type: 'custom', baseUrl: '::not a url::' },
      ),
    ).toEqual(['localhost:8888']);
  });

  it('P9: same host on DIFFERENT ports yields two distinct origins (no port-squashing dedupe)', () => {
    expect(
      researchFetchAllowlist(
        { searxngLocalhostProbe: true, searxngUrls: ['http://my.host:8888'] },
        { type: 'docling', baseUrl: 'http://my.host:5001' },
      ),
    ).toEqual(['my.host:8888', 'my.host:5001']);
  });
});

// ── web_fetch handler ──

describe('web_fetch handler', () => {
  it('missing/blank url → friendly invalid-params output (never a throw)', async () => {
    const handler = fetchHandler();
    const missing = await handler(ctx({}));
    expect(missing.output).toContain('参数无效');
    const blank = await handler(ctx({ url: '   ' }));
    expect(blank.output).toContain('参数无效');
  });

  it('SSRF block → friendly 拦截 output (not a throw), fetcher never called', async () => {
    const fetchPage = vi.fn();
    const handler = fetchHandler({
      fetchPage,
      guard: async () => {
        throw new SsrfBlockedError('http://192.168.1.4/x', 'private-ip', '目标 IP 192.168.1.4 是私网地址');
      },
    });
    const result = await handler(ctx({ url: 'http://192.168.1.4/x' }));
    expect(result.output).toContain('私网地址');
    expect(result.output).toContain('安全策略');
    expect(result.metadata).toMatchObject({ blocked: true, blockReason: 'private-ip' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('html → turndown Markdown + 来源/检索日期 provenance', async () => {
    const result = await fetchHandler()(ctx({ url: URL_A }));
    expect(result.output).toContain('# 标题');
    expect(result.output).toContain('正文段落。');
    expect(result.output).toContain(`来源: ${URL_A}`);
    expect(result.output).toMatch(/检索日期: \d{4}-\d{2}-\d{2}/);
    expect(result.metadata).toMatchObject({ kind: 'html', redirected: false, truncated: false });
  });

  it('json → raw body passthrough (kind text)', async () => {
    const body = JSON.stringify({ items: [1, 2, 3] });
    const result = await fetchHandler({
      fetchPage: async () => pageFixture({ contentType: 'application/json', body }),
    })(ctx({ url: URL_A }));
    expect(result.output).toContain('"items":[1,2,3]');
    expect(result.metadata).toMatchObject({ kind: 'text' });
  });

  it('empty content-type → raw text + 未声明 note', async () => {
    const result = await fetchHandler({
      fetchPage: async () => pageFixture({ contentType: '', body: '裸文本' }),
    })(ctx({ url: URL_A }));
    expect(result.output).toContain('裸文本');
    expect(result.output).toContain('未声明 Content-Type');
  });

  it('pdf → hand-off hint to parse_document', async () => {
    const result = await fetchHandler({
      fetchPage: async () => pageFixture({ contentType: 'application/pdf', body: '%PDF-1.4' }),
    })(ctx({ url: URL_A }));
    expect(result.output).toContain('parse_document');
    expect(result.metadata).toMatchObject({ kind: 'pdf' });
  });

  it('image → hand-off hint to analyze_image', async () => {
    const result = await fetchHandler({
      fetchPage: async () => pageFixture({ contentType: 'image/png', body: ' PNG' }),
    })(ctx({ url: URL_A }));
    expect(result.output).toContain('analyze_image');
    expect(result.metadata).toMatchObject({ kind: 'image' });
  });

  it('unsupported type → friendly 不支持 hint', async () => {
    const result = await fetchHandler({
      fetchPage: async () => pageFixture({ contentType: 'video/mp4', body: '' }),
    })(ctx({ url: URL_A }));
    expect(result.output).toContain('不支持');
    expect(result.metadata).toMatchObject({ kind: 'other' });
  });

  it('non-2xx → friendly HTTP status output', async () => {
    const result = await fetchHandler({
      fetchPage: async () => pageFixture({ status: 404, ok: false, body: '' }),
    })(ctx({ url: URL_A }));
    expect(result.output).toContain('HTTP 404');
    expect(result.metadata).toMatchObject({ status: 404 });
  });

  it('transport failure → friendly 抓取失败 output', async () => {
    const result = await fetchHandler({
      fetchPage: async () => {
        throw new Error('请求超时（10000ms）');
      },
    })(ctx({ url: URL_A }));
    expect(result.output).toContain('抓取失败');
    expect(result.output).toContain('请求超时');
  });

  it('P3: body-too-large from the streaming cap → friendly 页面过大 output (never a raw throw)', async () => {
    const result = await fetchHandler({
      fetchPage: async () => {
        throw new ResearchNetworkError('body-too-large', '响应体超过 2097152 字节上限，已中止下载');
      },
    })(ctx({ url: URL_A }));
    expect(result.output).toContain('页面过大');
    expect(result.output).toContain('render_page');
    expect(result.metadata).toMatchObject({ url: URL_A, error: 'body-too-large' });
  });

  it('redirect to ANOTHER PUBLIC url → guard re-runs on the hop, 来源 = final + 重定向 line', async () => {
    const guardCalls: string[] = [];
    const guard = async (url: string) => {
      guardCalls.push(url);
    };
    const result = await fetchHandler({
      guard,
      fetchPage: async () => pageFixture({ finalUrl: URL_B }),
    })(ctx({ url: URL_A }));

    expect(guardCalls).toEqual([URL_A, URL_B]);
    expect(result.output).toContain(`来源: ${URL_B}`);
    expect(result.output).toContain(`重定向: ${URL_A} → ${URL_B}`);
    expect(result.metadata).toMatchObject({ redirected: true, finalUrl: URL_B });
  });

  it('redirect into a PRIVATE target → blocked on the hop (per-hop re-guard contract)', async () => {
    const result = await fetchHandler({
      guard: async (url: string) => {
        if (url === URL_B) {
          throw new SsrfBlockedError(URL_B, 'private-ip', `域名解析到私网地址，已拦截：${URL_B}`);
        }
      },
      fetchPage: async () => pageFixture({ finalUrl: URL_B }),
    })(ctx({ url: URL_A }));

    expect(result.output).toContain('已拦截');
    expect(result.metadata).toMatchObject({ blocked: true, url: URL_B });
  });

  it('maxChars caps the returned content with the 截断 tail', async () => {
    const result = await fetchHandler({
      fetchPage: async () => pageFixture({ body: '<html><body><p>' + '长'.repeat(500) + '</p></body></html>' }),
    })(ctx({ url: URL_A, maxChars: 50 }));
    expect(result.metadata).toMatchObject({ truncated: true });
    expect(result.output).toContain('已截断');
    expect((result.metadata as { chars: number }).chars).toBeLessThanOrEqual(120);
  });
});

// ── render_page handler ──

describe('render_page handler', () => {
  function captureStub(outcome: RenderCaptureOutcome) {
    const calls: { url: string; options: CaptureRenderedPageOptions }[] = [];
    const capture = async (url: string, options: CaptureRenderedPageOptions) => {
      calls.push({ url, options });
      return outcome;
    };
    return { capture, calls };
  }

  const okOutcome: Extract<RenderCaptureOutcome, { ok: true }> = {
    ok: true,
    text: '渲染后的页面全文',
    images: ['/proj/alpha/.orison/research-media/render-1-0.png', '/proj/alpha/.orison/research-media/render-1-1.png'],
    notes: ['已注入 CSS 强制展开折叠块后提取/截图。'],
  };

  it('missing url → friendly invalid-params output', async () => {
    const { capture } = captureStub(okOutcome);
    const result = await createRenderPageHandler({ capture })(ctx({}));
    expect(result.output).toContain('参数无效');
  });

  it('ok capture → text + 截图 list + analyze_image hand-off note + provenance', async () => {
    const { capture, calls } = captureStub(okOutcome);
    const result = await createRenderPageHandler({ capture })(ctx({ url: URL_A }));

    expect(calls[0]).toMatchObject({ url: URL_A });
    expect(calls[0].options).toMatchObject({ projectDir: '/proj/alpha', expandCollapsibles: false, includeText: true });
    expect(result.output).toContain('渲染后的页面全文');
    expect(result.output).toContain('截图:');
    expect(result.output).toContain('- /proj/alpha/.orison/research-media/render-1-0.png');
    expect(result.output).toContain('analyze_image');
    expect(result.output).toContain('手动模式');
    expect(result.output).toContain('备注: 已注入 CSS');
    expect(result.output).toContain(`来源: ${URL_A}`);
    expect(result.output).toMatch(/检索日期: \d{4}-\d{2}-\d{2}/);
    expect(result.metadata).toMatchObject({ url: URL_A, images: okOutcome.images, includeText: true });
  });

  it('expandCollapsibles passthrough + empty-text page gets the 纯视觉页 hint', async () => {
    const { capture, calls } = captureStub({ ok: true, text: '', images: ['/p/x.png'], notes: [] });
    const result = await createRenderPageHandler({ capture })(ctx({ url: URL_A, expandCollapsibles: true }));
    expect(calls[0].options).toMatchObject({ expandCollapsibles: true });
    expect(result.output).toContain('无可提取文本');
  });

  it('includeText:false → no text section, screenshots still listed; metadata chars 0', async () => {
    const { capture } = captureStub(okOutcome);
    const result = await createRenderPageHandler({ capture })(ctx({ url: URL_A, includeText: false }));
    expect(result.output).not.toContain('渲染后的页面全文');
    expect(result.output).toContain('- /proj/alpha/.orison/research-media/render-1-0.png');
    expect(result.metadata).toMatchObject({ includeText: false, chars: 0 });
  });

  it('text channel is capped at 16K', async () => {
    const { capture } = captureStub({ ok: true, text: '字'.repeat(30_000), images: [], notes: [] });
    const result = await createRenderPageHandler({ capture })(ctx({ url: URL_A }));
    expect(result.output).toContain('已截断');
    expect(result.output.length).toBeLessThan(20_000);
  });

  it('capture failure → friendly error + web_fetch advice', async () => {
    const { capture } = captureStub({ ok: false, error: '渲染捕获失败（https://x/）：ERR_TIMED_OUT' });
    const result = await createRenderPageHandler({ capture })(ctx({ url: URL_A }));
    expect(result.output).toContain('ERR_TIMED_OUT');
    expect(result.output).toContain('web_fetch');
    expect(result.metadata).toMatchObject({ url: URL_A });
  });

  it('a THROWING capture seam → belt-and-suspenders friendly output (R8)', async () => {
    const capture = vi.fn(async () => {
      throw new Error('kernel exploded');
    });
    const result = await createRenderPageHandler({ capture })(ctx({ url: URL_A }));
    expect(result.output).toContain('渲染捕获失败');
    expect(result.output).toContain('kernel exploded');
  });

  it('the default exports are wired handler functions', () => {
    expect(typeof webFetchHandler).toBe('function');
    expect(typeof renderPageHandler).toBe('function');
  });
});
