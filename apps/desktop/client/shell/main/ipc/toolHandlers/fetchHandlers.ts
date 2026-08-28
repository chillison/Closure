/**
 * Web fetch + render-state capture tool handlers (Story 3.6 WP5, R3/R12 /
 * design D10).
 *
 * Two READ tools over the unified toolExecution channel (agent-side
 * remoteToolProxy registrations in agent/src/tool/builtin.ts — ids `web_fetch`
 * / `render_page`):
 *
 *   - `web_fetch {url, maxChars?}` — SSRF-guarded fetch (netGuard
 *     `assertPublicHttpUrl`, allowlist = configured SearXNG + docParser
 *     endpoint hosts — both are explicit user configuration, trusted D7)
 *     → `netFetch` → content-type dispatch: text/html → turndown Markdown
 *     (script/style/nav stripped), plain/markdown/json/xml → raw body,
 *     application/pdf → friendly hint to `parse_document`, image/* → friendly
 *     hint to `analyze_image`, anything else → unsupported hint. Output is
 *     capped (default 16K, max 32K) with 来源/检索日期 provenance (R6).
 *     Redirects: net.fetch follows by default and `response.url` reports the
 *     FINAL URL — it is re-guarded (netGuard contract: callers re-validate per
 *     hop) so a public URL cannot bounce into a private target.
 *   - `render_page {url, expandCollapsibles?, includeText?}` — thin wrapper
 *     over `captureRenderedPage` (research/renderCapture.ts): hidden sandbox
 *     window, textContent text channel + segmented scroll screenshots under
 *     `<project>/.orison/research-media/`. Screenshots are meant for the
 *     leader to compose with `analyze_image` (tools stay orthogonal).
 *
 * NEVER throws (mirror wikiHandlers / query_craft, R8): SSRF blocks, network
 * failures, non-2xx, capture failures all degrade to friendly outputs. All
 * network/window work lives here in the shell (agent 纯编排零网络,
 * spec/agent/agent-tools.md injection boundary). classifyTool defaults both to
 * 'read' (readonly/suggest/auto).
 *
 * Params are hand-coerced — this package has no direct zod dependency (mirror
 * wikiHandlers / genreContractHandlers coerce helpers); the agent-side tool
 * definitions carry the zod surface the LLM sees.
 *
 * Testability: `createWebFetchHandler` / `createRenderPageHandler` accept
 * injectable fetcher / guard / capture / config-loader seams — unit tests run
 * with ZERO network and ZERO real windows.
 */
import TurndownService from 'turndown';
import type { DocParserConfig, SearchConfig } from '@orison/shared-contracts';
import { getLogger } from '../../logger';
import { netFetch, readTextWithCap, ResearchNetworkError } from '../../research/netFetch';
import { assertPublicHttpUrl, SsrfBlockedError, urlOrigin } from '../../research/netGuard';
import { readSearchConfig } from '../../research/searchConfig';
import { readDocParserConfig } from '../../research/docParserConfig';
import { setResearchSessionAllowlist } from '../../research/researchSession';
import { captureRenderedPage, type RenderCaptureOutcome } from '../../research/renderCapture';
import type { ToolHandler, ToolExecuteResponse } from './types';

// ── Constants ──

export const WEB_FETCH_DEFAULT_MAX_CHARS = 16_000;
export const WEB_FETCH_MAX_CHARS_LIMIT = 32_000;
export const RENDER_TEXT_CAP = 16_000;
/**
 * web_fetch BODY byte budget (P3, CR 2026-08-15): the raw HTML/text body is
 * read through the netFetch streaming cap so the main process never buffers
 * an unbounded response. Output keeps the separate char cap above — a 2MB
 * page is process-safe while its Markdown still lands under the LLM budget.
 */
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;

// ── Param coercion (no zod in this package — mirror wikiHandlers) ──

export function coerceFetchParams(
  params: Record<string, unknown>,
): { url?: string; maxChars?: number } {
  const url = typeof params.url === 'string' && params.url.trim() ? params.url.trim() : undefined;
  let maxChars: number | undefined;
  if (typeof params.maxChars === 'number' && Number.isFinite(params.maxChars)) {
    maxChars = Math.min(Math.max(Math.round(params.maxChars), 1), WEB_FETCH_MAX_CHARS_LIMIT);
  }
  return { url, maxChars };
}

export function coerceRenderParams(
  params: Record<string, unknown>,
): { url?: string; expandCollapsibles: boolean; includeText: boolean } {
  const url = typeof params.url === 'string' && params.url.trim() ? params.url.trim() : undefined;
  return {
    url,
    expandCollapsibles: params.expandCollapsibles === true,
    includeText: params.includeText !== false,
  };
}

// ── Content-type dispatch (exported for tests) ──

export type FetchContentKind = 'html' | 'text' | 'pdf' | 'image' | 'other';

/**
 * Map a Content-Type header to the dispatch kind. An ABSENT content-type maps
 * to 'text' — real binary responses (pdf/images) always carry a type, so the
 * empty case is a type-less text body from a lazy static host; returning it
 * raw beats refusing it.
 */
export function classifyContentType(contentType: string): FetchContentKind {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (
    mime === 'text/plain'
    || mime === 'text/markdown'
    || mime === 'application/json'
    || mime === 'text/json'
    || mime === 'application/xml'
    || mime === 'text/xml'
    || mime === ''
  ) return 'text';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return 'other';
}

// ── HTML → Markdown cleaning (turndown, D1 "turndown 清洗+cap") ──

/** Tags dropped BEFORE conversion (noise the LLM never wants). */
export const TURNDOWN_REMOVED_TAGS = [
  'script',
  'style',
  'nav',
  'noscript',
  'iframe',
  'svg',
  'template',
] as const;

export function htmlToMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  for (const tag of TURNDOWN_REMOVED_TAGS) {
    // turndown matches tag names at runtime; its Filter TYPE only knows
    // HTMLElement tags ('svg' lives in SVGElementTagNameMap) — bridge the gap.
    service.remove(tag as Parameters<TurndownService['remove']>[0]);
  }
  return service.turndown(html).trim();
}

// ── Capping + provenance (exported for tests) ──

export function capFetchedText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}…\n\n[已截断，原文 ${text.length} 字符，仅保留前 ${maxChars}]`,
    truncated: true,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── SSRF allowlist (design D7) ──

/**
 * ORIGIN-level entries exempt from the private-address check (P9, CR
 * 2026-08-15): the user-configured SearXNG endpoint origins + the WP6
 * docParser endpoint origin (both are explicit user configuration — trusted
 * by design D7). An entry carries its port when the config URL does —
 * allowlisting `http://127.0.0.1:8000` opens port 8000 ONLY, not every port
 * on the host. Malformed entries are skipped, never fatal. As a side effect
 * the same set refreshes the research session's net-filter allowlist
 * (researchSession.ts, P2) — every handler run keeps the session guard in
 * sync with the config it just read (single source of truth).
 */
export function researchFetchAllowlist(config?: SearchConfig, docParserConfig?: DocParserConfig): string[] {
  const cfg = config ?? readSearchConfig();
  const origins = new Set<string>();
  for (const entry of cfg.searxngUrls ?? []) {
    try {
      origins.add(urlOrigin(new URL(entry)));
    } catch {
      // Malformed user config entry — skip.
    }
  }
  const docBaseUrl = docParserConfig === undefined ? readDocParserConfig().baseUrl : docParserConfig.baseUrl;
  if (docBaseUrl) {
    try {
      origins.add(urlOrigin(new URL(docBaseUrl)));
    } catch {
      // Malformed user config entry — skip.
    }
  }
  const list = [...origins];
  setResearchSessionAllowlist(list);
  return list;
}

/** Load the docParser config for the allowlist without ever throwing (never-throws, R8). */
function safeLoadDocParser(load: () => DocParserConfig): DocParserConfig {
  try {
    return load();
  } catch {
    return {};
  }
}

// ── Fetch seam ──

export interface FetchedPage {
  status: number;
  ok: boolean;
  /** Final URL after redirects (fetch follows by default). */
  finalUrl: string;
  contentType: string;
  body: string;
}

export type PageFetcher = (
  url: string,
  signal: AbortSignal,
  opts?: { allowlist?: readonly string[] },
) => Promise<FetchedPage>;

/**
 * Default fetcher: netFetch with the per-hop redirect guard (P1 — the SSRF
 * guard re-runs on EVERY redirect Location before the next hop) and the P3
 * streaming body cap (the raw body never exceeds {@link WEB_FETCH_MAX_BYTES}
 * in the main process).
 */
export async function netFetchPage(
  url: string,
  signal: AbortSignal,
  opts: { allowlist?: readonly string[] } = {},
): Promise<FetchedPage> {
  const guard = opts.allowlist
    ? (next: string) => assertPublicHttpUrl(next, opts.allowlist!)
    : undefined;
  const res = await netFetch(url, { signal }, { guard });
  const contentType = res.headers.get('content-type') ?? '';
  const body = await readTextWithCap(res, WEB_FETCH_MAX_BYTES, url);
  return { status: res.status, ok: res.ok, finalUrl: res.url || url, contentType, body };
}

// ── Friendly failure builders (never a throw, R8) ──

function ssrfBlockedOutput(url: string, err: unknown): ToolExecuteResponse {
  const message = err instanceof SsrfBlockedError ? err.message : `目标地址被安全策略拦截：${url}`;
  return {
    title: 'web_fetch',
    output: `${message}\n（安全策略：仅允许公网 http/https 地址；如需访问本地服务，请在设置「研究与视觉」中把它配置为研究端点。）`,
    metadata: {
      url,
      blocked: true,
      blockReason: err instanceof SsrfBlockedError ? err.blockReason : undefined,
    },
  };
}

function fetchFailureOutput(url: string, err: unknown): ToolExecuteResponse {
  const message = err instanceof Error ? err.message : String(err);
  return {
    title: 'web_fetch',
    output: `抓取失败：${message}。请确认 URL 可达后重试，或先用 web_search 找到可用来源。`,
    metadata: { url, error: message },
  };
}

function buildFetchSuccess(args: {
  requestedUrl: string;
  finalUrl: string;
  kind: FetchContentKind;
  contentType: string;
  content: string;
  maxChars: number;
  note?: string;
}): ToolExecuteResponse {
  const { text, truncated } = capFetchedText(args.content, args.maxChars);
  const redirected = args.finalUrl !== args.requestedUrl;
  const lines = [text, '', '---', `来源: ${args.finalUrl}`];
  if (redirected) lines.push(`重定向: ${args.requestedUrl} → ${args.finalUrl}`);
  if (args.note) lines.push(args.note);
  lines.push(`检索日期: ${today()}`);
  return {
    title: `web_fetch: ${args.requestedUrl.slice(0, 40)}`,
    output: lines.join('\n'),
    metadata: {
      url: args.requestedUrl,
      finalUrl: args.finalUrl,
      redirected,
      kind: args.kind,
      contentType: args.contentType,
      chars: text.length,
      truncated,
    },
  };
}

// ── web_fetch handler ──

export interface WebFetchHandlerDeps {
  fetchPage?: PageFetcher;
  loadConfig?: () => SearchConfig;
  /** WP6 seam: docParser endpoint host joins the SSRF allowlist. */
  loadDocParserConfig?: () => DocParserConfig;
  guard?: (url: string, allowlist: readonly string[]) => Promise<void>;
}

export function createWebFetchHandler(deps: WebFetchHandlerDeps = {}): ToolHandler {
  const fetchPage = deps.fetchPage ?? netFetchPage;
  const loadConfig = deps.loadConfig ?? readSearchConfig;
  const loadDocParserConfig = deps.loadDocParserConfig ?? readDocParserConfig;
  const guard = deps.guard ?? assertPublicHttpUrl;

  return async ({ params, abort }) => {
    const coerced = coerceFetchParams(params);
    if (!coerced.url) {
      return {
        title: 'web_fetch',
        output: '参数无效，请提供要抓取的 URL（url 字符串，http/https）。',
        metadata: { error: 'invalid-params' },
      };
    }
    const url = coerced.url;
    const maxChars = coerced.maxChars ?? WEB_FETCH_DEFAULT_MAX_CHARS;

    let allowlist: string[] = [];
    try {
      allowlist = researchFetchAllowlist(loadConfig(), safeLoadDocParser(loadDocParserConfig));
    } catch {
      // Config read failure → empty allowlist (guard stays fail-closed).
    }

    // 1) Pre-flight SSRF guard (file:// + private/loopback blocked).
    try {
      await guard(url, allowlist);
    } catch (err) {
      return ssrfBlockedOutput(url, err);
    }

    // 2) Fetch (transport failures degrade friendly). The allowlist rides the
    //    fetch options so the DEFAULT fetcher re-guards every redirect hop
    //    (P1) — injected test stubs simply ignore the extra argument.
    let page: FetchedPage;
    try {
      page = await fetchPage(url, abort, { allowlist });
    } catch (err) {
      if (err instanceof ResearchNetworkError && err.reason === 'body-too-large') {
        return {
          title: `web_fetch: ${url.slice(0, 40)}`,
          output: `页面过大（原始响应超过 ${WEB_FETCH_MAX_BYTES} 字节下载上限），已中止抓取。可改用 render_page 渲染捕获，或请用户把内容保存进项目后用 parse_document 解析。`,
          metadata: { url, error: 'body-too-large' },
        };
      }
      return fetchFailureOutput(url, err);
    }

    if (!page.ok) {
      return {
        title: `web_fetch: ${url.slice(0, 40)}`,
        output: `抓取失败：HTTP ${page.status}（${url}）。请确认地址正确后重试，或先用 web_search 找到可用来源。`,
        metadata: { url, finalUrl: page.finalUrl, status: page.status, error: `HTTP ${page.status}` },
      };
    }

    // 3) Redirect re-validation (netGuard contract: the caller re-runs the
    //    guard per hop — a public URL must not bounce into a private target).
    if (page.finalUrl && page.finalUrl !== url) {
      try {
        await guard(page.finalUrl, allowlist);
      } catch (err) {
        return ssrfBlockedOutput(page.finalUrl, err);
      }
    }

    // 4) Content-type dispatch (R3).
    const kind = classifyContentType(page.contentType);
    switch (kind) {
      case 'html':
        try {
          return buildFetchSuccess({
            requestedUrl: url,
            finalUrl: page.finalUrl,
            kind,
            contentType: page.contentType,
            content: htmlToMarkdown(page.body),
            maxChars,
          });
        } catch (err) {
          getLogger().warn({ err: err instanceof Error ? err.message : String(err), url }, 'web_fetch: turndown failed');
          return fetchFailureOutput(url, err);
        }
      case 'text':
        return buildFetchSuccess({
          requestedUrl: url,
          finalUrl: page.finalUrl,
          kind,
          contentType: page.contentType,
          content: page.body,
          maxChars,
          note: page.contentType ? undefined : '备注: 响应未声明 Content-Type，已按纯文本返回。',
        });
      case 'pdf':
        return {
          title: `web_fetch: ${url.slice(0, 40)}`,
          output:
            `该 URL 返回 PDF 文档（${page.contentType}），web_fetch 不解析 PDF 二进制。请用 parse_document 解析本地 PDF（filePath 传项目内相对路径；文件在线上时请用户下载到项目目录后重试）；扫描件或解析失败时改走 analyze_image 视觉路径。`,
          metadata: { url, finalUrl: page.finalUrl, kind, contentType: page.contentType },
        };
      case 'image':
        return {
          title: `web_fetch: ${url.slice(0, 40)}`,
          output:
            `该 URL 返回图片（${page.contentType}），web_fetch 不做图像分析。请改用 analyze_image 工具做视觉分析（url 传同一地址）。`,
          metadata: { url, finalUrl: page.finalUrl, kind, contentType: page.contentType },
        };
      default:
        return {
          title: `web_fetch: ${url.slice(0, 40)}`,
          output:
            `不支持的响应类型：${page.contentType || '(未声明)'}。web_fetch 支持 HTML / 纯文本 / Markdown / JSON / XML；PDF 请用 parse_document，图片请用 analyze_image，需要 JS 渲染的页面请用 render_page。`,
          metadata: { url, finalUrl: page.finalUrl, kind, contentType: page.contentType },
        };
    }
  };
}

// ── render_page handler ──

export interface RenderPageHandlerDeps {
  /** Capture kernel (default: captureRenderedPage; tests inject a stub). */
  capture?: typeof captureRenderedPage;
  loadConfig?: () => SearchConfig;
  /** WP6 seam: docParser endpoint host joins the SSRF allowlist. */
  loadDocParserConfig?: () => DocParserConfig;
}

export function formatRenderPageOutput(
  url: string,
  outcome: Extract<RenderCaptureOutcome, { ok: true }>,
  includeText: boolean,
): string {
  const parts: string[] = [];
  if (includeText) {
    const { text } = capFetchedText(outcome.text.trim(), RENDER_TEXT_CAP);
    parts.push(text.length > 0 ? text : '（页面无可提取文本——可能是纯视觉页，请看截图）');
  }
  if (outcome.images.length > 0) {
    parts.push('截图:');
    parts.push(outcome.images.map((file) => `- ${file}`).join('\n'));
    parts.push('注: 截图可用 analyze_image 工具做视觉分析；若 analyze_image 返回手动模式（未配视觉模型），按其提示把图+提示词转告用户手动分析后传回。');
  } else {
    parts.push('截图: （本次未产出截图，见下方备注）');
  }
  if (outcome.notes.length > 0) {
    parts.push(outcome.notes.map((note) => `备注: ${note}`).join('\n'));
  }
  parts.push('---');
  parts.push(`来源: ${url}`);
  parts.push(`检索日期: ${today()}`);
  return parts.join('\n');
}

export function createRenderPageHandler(deps: RenderPageHandlerDeps = {}): ToolHandler {
  const capture = deps.capture ?? captureRenderedPage;
  const loadConfig = deps.loadConfig ?? readSearchConfig;
  const loadDocParserConfig = deps.loadDocParserConfig ?? readDocParserConfig;

  return async ({ params, projectDir, abort }) => {
    const coerced = coerceRenderParams(params);
    if (!coerced.url) {
      return {
        title: 'render_page',
        output: '参数无效，请提供要渲染捕获的 URL（url 字符串，http/https）。',
        metadata: { error: 'invalid-params' },
      };
    }
    const url = coerced.url;

    let allowlist: string[] = [];
    try {
      allowlist = researchFetchAllowlist(loadConfig(), safeLoadDocParser(loadDocParserConfig));
    } catch {
      // Config read failure → empty allowlist (guard stays fail-closed).
    }

    let outcome: RenderCaptureOutcome;
    try {
      outcome = await capture(url, {
        projectDir,
        expandCollapsibles: coerced.expandCollapsibles,
        includeText: coerced.includeText,
        signal: abort,
        allowlist,
      });
    } catch (err) {
      // Belt-and-suspenders (R8): the kernel never throws, but an unforeseen
      // failure must still degrade to a friendly output.
      getLogger().warn({ err: err instanceof Error ? err.message : String(err), url }, 'render_page: unexpected failure');
      return {
        title: `render_page: ${url.slice(0, 40)}`,
        output: `渲染捕获失败：${err instanceof Error ? err.message : String(err)}。可改用 web_fetch 抓取原始 HTML。`,
        metadata: { url, error: 'unexpected' },
      };
    }

    if (!outcome.ok) {
      return {
        title: `render_page: ${url.slice(0, 40)}`,
        output: `${outcome.error}\n可改用 web_fetch 抓取原始 HTML（若页面不依赖 JS 渲染）。`,
        metadata: { url, error: outcome.error },
      };
    }

    return {
      title: `render_page: ${url.slice(0, 40)}`,
      output: formatRenderPageOutput(url, outcome, coerced.includeText),
      metadata: {
        url,
        images: outcome.images,
        notes: outcome.notes,
        includeText: coerced.includeText,
        expandCollapsibles: coerced.expandCollapsibles,
        chars: coerced.includeText ? outcome.text.length : 0,
      },
    };
  };
}

// Default handlers wired into toolExecution (ids align with the agent-side
// remoteToolProxy registrations in agent/src/tool/builtin.ts).
export const webFetchHandler: ToolHandler = createWebFetchHandler();
export const renderPageHandler: ToolHandler = createRenderPageHandler();
