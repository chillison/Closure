/**
 * Research network fetch seam (Story 3.6 WP2, R13 / design D6; CR 2026-08-15
 * P1/P2/P3).
 *
 * ALL research outbound (search engines, wiki endpoints, web_fetch, doc-parser
 * health probes) goes through this wrapper over the DEDICATED research
 * partition session's `fetch` (researchSession.ts, P2) — the Chromium
 * networking stack automatically honors the system proxy (incl. WPAD/PAC;
 * JupyterLab Desktop precedent, web-search-design-survey), and the research
 * proxy tier (applyResearchProxy, configIpc) steers ONLY that session. This
 * module stays dumb transport and never reads config.
 *
 * Agent code NEVER reaches this file — research handlers live in the shell
 * (agent 纯编排零网络, spec/agent/agent-tools.md injection boundary).
 *
 * Error contract:
 *   - Non-2xx responses are RETURNED, not thrown — the caller decides per
 *     engine/endpoint whether a status is fatal (`expectOk` opts in).
 *   - Transport-layer failures (timeout / abort / network) throw a typed
 *     `ResearchNetworkError` for the engine chain executor (WP4) to catch and
 *     degrade gracefully (R8).
 *
 * SSRF redirect policy (P1): a caller that passes `opts.guard` gets MANUAL
 * redirect following (max {@link NET_FETCH_MAX_REDIRECTS} hops) — every
 * Location is re-guarded BEFORE the next hop, so a public URL can never
 * bounce through a 30x into a private target. Callers WITHOUT a guard keep
 * the transport's automatic following (the sanctioned localhost probes and
 * already-guarded engine endpoints). The documented net.fetch limitation
 * "the .url of the returned Response is incorrect" makes the manual loop the
 * ONLY reliable way to know where redirects landed — we track every hop URL
 * ourselves.
 *
 * Body budget (P3): netFetch never reads the body itself (the Response is
 * passed through); callers MUST read via `readBodyWithCap`/`readTextWithCap`
 * so a lying/oversized body cannot balloon the main process. Content-Length
 * is pre-checked and the stream is cut the moment the cap is crossed.
 *
 * Default UA is identifying (`Closure/1.0 (writing-research)`, D9 anti-bot
 * hygiene: search engines see an honest crawler-style agent, not a spoofed
 * browser). An explicit `user-agent` in `init.headers` or `opts.ua` wins.
 */
import { getResearchSession } from './researchSession';

/** Identifying default UA for all research outbound (D9). */
export const RESEARCH_UA = 'Closure/1.0 (writing-research)';

/** Default request budget (design D9: chain per-engine timeout 10s). */
export const DEFAULT_RESEARCH_TIMEOUT_MS = 10_000;

/** Max manual redirect hops before the chain is declared a loop (P1). */
export const NET_FETCH_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Classification carried on {@link ResearchNetworkError}. `body-too-large` is
 * the P3 streaming-cap verdict.
 */
export type ResearchNetworkErrorReason = 'timeout' | 'abort' | 'http-status' | 'network' | 'body-too-large';

/**
 * Typed transport error. `reason` discriminates the failure class for the chain
 * executor; the underlying error (if any) rides the standard `cause` chain.
 */
export class ResearchNetworkError extends Error {
  readonly reason: ResearchNetworkErrorReason;

  constructor(reason: ResearchNetworkErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ResearchNetworkError';
    this.reason = reason;
  }
}

export interface NetFetchOptions {
  /** Abort the request after this many ms. `0` disables the timeout. Default 10s. */
  timeoutMs?: number;
  /** User-Agent override. Default {@link RESEARCH_UA}. */
  ua?: string;
  /** External abort signal (tool run aborts, chain cancellation). */
  signal?: AbortSignal;
  /**
   * SSRF guard re-run on EVERY hop, redirects included (P1). When present,
   * redirects are followed MANUALLY (max {@link NET_FETCH_MAX_REDIRECTS}) —
   * each Location header is guarded before the next fetch. If the transport
   * answers a manual request with an opaque response (manual mode degraded),
   * a single automatic follow takes over from the current URL — the callers'
   * entry + final-URL guards remain the belt.
   */
  guard?: (url: string) => Promise<void>;
}

/**
 * Fetch a research URL via the research partition session with a default
 * timeout, identifying UA, and typed errors. See module doc for the
 * non-2xx + redirect policies.
 */
export async function netFetch(url: string, init: RequestInit = {}, opts: NetFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS;
  const external = opts.signal ?? init.signal;

  if (external?.aborted) {
    // Pre-aborted signal: fail fast without touching the network.
    throw new ResearchNetworkError('abort', `请求在发出前已被取消：${url}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs)
    : null;
  const onExternalAbort = () => controller.abort();
  if (external) external.addEventListener('abort', onExternalAbort, { once: true });

  // Identifying UA by default; an explicit caller UA always wins.
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) {
    headers.set('user-agent', opts.ua ?? RESEARCH_UA);
  }

  try {
    const flow = opts.guard
      ? followWithGuard(url, init, headers, controller, opts.guard)
      : fetchOnce(url, init.method ?? 'GET', headers, init.body, controller, 'follow');
    // Race the transport against its own abort signal so timeout/abort
    // classification holds even if the transport is slow to settle — the
    // abort rejection always wins the race the moment the timer/signal fires.
    // Losing-promise rejections are absorbed by `race` (no unhandled runs).
    return await Promise.race([flow, abortRejection(controller)]);
  } catch (err) {
    // Typed verdicts thrown INSIDE the guarded loop (redirect budget, missing
    // Location, hop-guard rejections) are final — they must survive as their
    // own classification, not be re-wrapped as generic network errors.
    if (err instanceof ResearchNetworkError) throw err;
    if (timedOut) {
      throw new ResearchNetworkError('timeout', `请求超时（${timeoutMs}ms）：${url}`, { cause: err });
    }
    if (external?.aborted) {
      throw new ResearchNetworkError('abort', `请求已取消：${url}`, { cause: err });
    }
    throw new ResearchNetworkError('network', `网络请求失败：${url}（${errMsg(err)}）`, { cause: err });
  } finally {
    if (timer) clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

/** One transport call on the research session (method/body are CALLER-tracked —
 *  the manual loop rewrites them per redirect hop). */
function fetchOnce(
  url: string,
  method: string,
  headers: Headers,
  body: RequestInit['body'],
  controller: AbortController,
  redirect: 'follow' | 'manual',
): Promise<Response> {
  return getResearchSession().fetch(url, {
    method,
    headers,
    body,
    signal: controller.signal,
    redirect,
  } as RequestInit);
}

/**
 * Manual redirect loop with per-hop SSRF re-guard (P1). Every hop (including
 * hop 0) is guarded BEFORE the fetch fires; 30x Location headers are resolved
 * relative to the current URL; 303 (and per the fetch spec 301/302 for
 * non-GET/HEAD) rewrite the method to GET and drop the body; the hop budget
 * prevents redirect loops.
 */
async function followWithGuard(
  startUrl: string,
  init: RequestInit,
  headers: Headers,
  controller: AbortController,
  guard: (url: string) => Promise<void>,
): Promise<Response> {
  let currentUrl = startUrl;
  let method = init.method ?? 'GET';
  let body = init.body;

  for (let hop = 0; hop <= NET_FETCH_MAX_REDIRECTS; hop += 1) {
    await guard(currentUrl);

    const res = await fetchOnce(currentUrl, method, headers, body, controller, 'manual');
    if (!REDIRECT_STATUSES.has(res.status)) {
      if ((res.type === 'opaqueredirect' || res.status === 0) && hop === 0) {
        // Manual mode degraded on this transport — fall back to automatic
        // following from the current URL (callers' entry + final-URL guards
        // remain). Only on hop 0: after a guarded hop chain the manual
        // answers were real, so a status-0 here is a genuine anomaly.
        return fetchOnce(currentUrl, method, headers, body, controller, 'follow');
      }
      return res;
    }

    const location = res.headers.get('location');
    if (!location) {
      throw new ResearchNetworkError(
        'http-status',
        `重定向响应（HTTP ${res.status}）缺少 Location 头：${currentUrl}`,
      );
    }
    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new ResearchNetworkError(
        'http-status',
        `重定向 Location 非法（${location}）：${currentUrl}`,
      );
    }
    if (hop === NET_FETCH_MAX_REDIRECTS) {
      throw new ResearchNetworkError(
        'http-status',
        `重定向超过 ${NET_FETCH_MAX_REDIRECTS} 跳，已中止（疑似重定向循环）：${startUrl} → … → ${next.toString()}`,
      );
    }
    // Fetch-spec method rewrite: 303 always becomes GET; 301/302 demote
    // non-GET/HEAD to GET (307/308 preserve method + body).
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-length');
      headers.delete('content-type');
    }
    currentUrl = next.toString();
  }
  // Unreachable — the hop budget throws inside the loop.
  throw new ResearchNetworkError('http-status', `重定向超出预算：${startUrl}`);
}

// ── Body budgets (P3) ──

/**
 * Read a response body with a hard byte cap. Content-Length is pre-checked
 * (an over-declared length fails BEFORE a byte is buffered); a lying or
 * chunked stream is cut the moment the cap is crossed (reader.cancel + typed
 * throw). Callers that pass the returned Response around MUST read through
 * this helper — the main process never buffers an unbounded body.
 */
export async function readBodyWithCap(response: Response, maxBytes: number, url?: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResearchNetworkError(
      'body-too-large',
      `响应体过大（Content-Length ${declared} 字节，超过 ${maxBytes} 上限）${url ? `：${url}` : ''}`,
    );
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new ResearchNetworkError(
        'body-too-large',
        `响应体过大（${buffer.length} 字节，超过 ${maxBytes} 上限）${url ? `：${url}` : ''}`,
      );
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResearchNetworkError(
        'body-too-large',
        `响应体超过 ${maxBytes} 字节上限，已中止下载${url ? `：${url}` : ''}`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** `readBodyWithCap` + utf-8 decode (the common text consumer path). */
export async function readTextWithCap(response: Response, maxBytes: number, url?: string): Promise<string> {
  const buffer = await readBodyWithCap(response, maxBytes, url);
  return buffer.toString('utf-8');
}

/**
 * Opt-in non-2xx → typed error conversion (`reason: 'http-status'`). Handlers
 * that treat any non-2xx as failure call this on the returned Response; engine
 * adapters that degrade per-status inspect the Response themselves.
 */
export function expectOk(response: Response, url?: string): Response {
  if (!response.ok) {
    throw new ResearchNetworkError(
      'http-status',
      `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}：${url ?? response.url}`,
    );
  }
  return response;
}

function abortRejection(controller: AbortController): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new DOMException('The operation was aborted', 'AbortError')),
      { once: true },
    );
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
