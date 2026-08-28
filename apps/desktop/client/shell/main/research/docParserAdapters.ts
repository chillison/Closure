/**
 * Document-parser ENDPOINT adapters (Story 3.6 WP6, R10 / design D11).
 *
 * `parseViaEndpoint` — the thin-protocol tier of `parse_document`, tried FIRST
 * for PDF when a docParser endpoint is configured and healthy. The three kinds
 * share one contract (multipart POST a local file, read markdown out of the
 * JSON response) but are NOT isomorphic (survey §2.3: MinerU / file_parse vs
 * docling /v1/convert — 薄协议+双 adapter is the settled route):
 *
 *   - mineru : `POST {base}/file_parse` multipart `files` + `return_md=true` +
 *     `backend=pipeline` (CPU-safe default — the default hybrid backend needs
 *     a GPU and fails every parse on CPU-only hosts, survey §1.3). Response
 *     `md_content`; multi-file uploads return an ARRAY (survey PR #5261) — we
 *     upload exactly one file and tolerate both shapes.
 *   - docling: `POST {base}/v1/convert/source` multipart `files` +
 *     `to_formats=md`. ASSUMPTION (recorded, fixture-locked): docling-serve v1
 *     accepts multipart file uploads on /v1/convert/source (the design/dispatch
 *     reading; the survey table also lists a dedicated /v1/convert/file) and
 *     responds `document.md.content`. If a live docling build rejects the
 *     shape, adjusting is a fixture + URL-constant swap — the handler degrades
 *     to the builtin fallback meanwhile, so a contract drift can never break
 *     parse_document.
 *   - custom : `POST {base}/parse` multipart `file` → `{markdown}`. This is
 *     Closure's OWN thin contract (survey §2.3 route A) for self-hosted
 *     wrappers around anything else — NOT a de-facto standard.
 *
 * Failure contract: NEVER throws — every failure returns `{ok:false, error}`
 * so the handler degrades to the builtin fallback with a recorded note (R8).
 * All transport goes through `netFetch` (Electron net.fetch — system proxy
 * honored, design D6); the endpoint host is the user's own configuration, so
 * the SSRF guard exempts it via the research allowlist instead of blocking it.
 */
import { readFileSync } from 'node:fs';
import type { DocParserConfig } from '@orison/shared-contracts';
import { netFetch, readTextWithCap } from './netFetch';

// ── Types ──

export type EndpointVia = 'endpoint-mineru' | 'endpoint-docling' | 'endpoint-custom';

export type EndpointParseResult =
  | { ok: true; markdown: string; via: EndpointVia }
  | { ok: false; error: string };

export interface DocEndpointFetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** JSON string body or a multipart FormData body. */
  body?: string | FormData;
}

export interface DocEndpointFetchResult {
  status: number;
  ok: boolean;
  text: string;
}

export interface DocEndpointFetchOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Injectable fetcher (tests pass fixtures; ZERO network). */
export type DocEndpointFetcher = (
  url: string,
  init?: DocEndpointFetchInit,
  opts?: DocEndpointFetchOpts,
) => Promise<DocEndpointFetchResult>;

/**
 * Default endpoint budget. MinerU's CPU pipeline parses slowly (and the FIRST
 * request may download 1-2GB of models, survey §1.3) — the 10s research
 * default would kill every real parse.
 */
export const DOC_ENDPOINT_TIMEOUT_MS = 120_000;

/** Endpoint RESPONSE body budget (P3, CR 2026-08-15): markdown JSON capped at 8MB. */
export const DOC_ENDPOINT_BODY_MAX_BYTES = 8 * 1024 * 1024;

/** Default fetcher: netFetch (system proxy + typed transport errors). */
async function netEndpointFetch(
  url: string,
  init: DocEndpointFetchInit = {},
  opts: DocEndpointFetchOpts = {},
): Promise<DocEndpointFetchResult> {
  const res = await netFetch(
    url,
    { method: init.method, headers: init.headers, body: init.body, signal: opts.signal },
    { timeoutMs: opts.timeoutMs ?? DOC_ENDPOINT_TIMEOUT_MS },
  );
  return { status: res.status, ok: res.ok, text: await readTextWithCap(res, DOC_ENDPOINT_BODY_MAX_BYTES, url) };
}

export interface ParseViaEndpointOpts extends DocEndpointFetchOpts {
  /** Injectable fetcher (tests); defaults to netFetch. */
  fetcher?: DocEndpointFetcher;
  /**
   * Pre-read file buffer (P4, CR 2026-08-15): when the caller already read
   * the file (parse_document reads once and shares the buffer with the
   * builtin fallback), pass it here — the adapter must not re-read (the old
   * path read the SAME PDF a second time off the main-process event loop).
   */
  buffer?: Buffer;
}

// ── Response-shape extractors (pure, exported for tests) ──

/**
 * MinerU `md_content`: string for a single-file upload, string[] when the
 * server answered a multi-file batch (we upload one file; take [0]). Any other
 * shape = no markdown → undefined (caller degrades to the builtin fallback).
 */
export function extractMineruMarkdown(body: unknown): string | undefined {
  const raw = (body as { md_content?: unknown } | null)?.md_content;
  if (typeof raw === 'string') return raw.trim().length > 0 ? raw : undefined;
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (typeof first === 'string' && first.trim().length > 0) return first;
  }
  return undefined;
}

/** docling-serve v1 `document.md.content` (recorded assumption, module doc). */
export function extractDoclingMarkdown(body: unknown): string | undefined {
  const content = (body as { document?: { md?: { content?: unknown } } } | null)?.document?.md?.content;
  return typeof content === 'string' && content.trim().length > 0 ? content : undefined;
}

/** custom thin protocol: top-level `{ markdown }` (Closure-defined contract). */
export function extractCustomMarkdown(body: unknown): string | undefined {
  const raw = (body as { markdown?: unknown } | null)?.markdown;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

// ── Adapter entry ──

function fileBlob(buffer: Buffer, fileName: string, mime: string): Blob {
  // Uint8Array view (not the Buffer itself) — Buffer is a subclass with pool
  // slicing semantics some runtimes reject as a BlobPart.
  return new Blob([new Uint8Array(buffer)], { type: mime || 'application/octet-stream' });
}

/**
 * Parse a local file through the configured docParser endpoint. NEVER throws
 * — unconfigured config, unreadable file, transport failure, non-2xx, and
 * unparseable/empty responses all return `{ok:false, error}`.
 */
export async function parseViaEndpoint(
  config: DocParserConfig,
  filePath: string,
  fileName: string,
  mime: string,
  opts: ParseViaEndpointOpts = {},
): Promise<EndpointParseResult> {
  if (!config.type || !config.baseUrl) {
    return { ok: false, error: '未配置文档解析端点' };
  }
  let buffer: Buffer;
  if (opts.buffer) {
    buffer = opts.buffer;
  } else {
    try {
      buffer = readFileSync(filePath);
    } catch (err) {
      return { ok: false, error: `读取文件失败：${errMsg(err)}` };
    }
  }

  const fetcher = opts.fetcher ?? netEndpointFetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  try {
    switch (config.type) {
      case 'mineru':
        return await parseMineru(fetcher, base, buffer, fileName, mime, opts);
      case 'docling':
        return await parseDocling(fetcher, base, buffer, fileName, mime, opts);
      case 'custom':
        return await parseCustom(fetcher, base, buffer, fileName, mime, opts);
    }
  } catch (err) {
    return { ok: false, error: `解析端点调用失败：${errMsg(err)}` };
  }
}

async function fetchJson(
  fetcher: DocEndpointFetcher,
  url: string,
  form: FormData,
  opts: ParseViaEndpointOpts,
  endpointName: string,
): Promise<{ json?: unknown; error?: string }> {
  const res = await fetcher(url, { method: 'POST', body: form }, opts);
  if (!res.ok) {
    return { error: `${endpointName} 端点返回 HTTP ${res.status}` };
  }
  try {
    return { json: JSON.parse(res.text) };
  } catch {
    return { error: `${endpointName} 端点响应不是合法 JSON` };
  }
}

async function parseMineru(
  fetcher: DocEndpointFetcher,
  base: string,
  buffer: Buffer,
  fileName: string,
  mime: string,
  opts: ParseViaEndpointOpts,
): Promise<EndpointParseResult> {
  const form = new FormData();
  form.append('files', fileBlob(buffer, fileName, mime), fileName);
  form.append('return_md', 'true');
  // CPU-safe default (survey §1.3) — see module doc.
  form.append('backend', 'pipeline');
  const { json, error } = await fetchJson(fetcher, `${base}/file_parse`, form, opts, 'MinerU');
  if (error) return { ok: false, error };
  const md = extractMineruMarkdown(json);
  return md !== undefined
    ? { ok: true, markdown: md, via: 'endpoint-mineru' }
    : { ok: false, error: 'MinerU 端点响应中未找到可用的 md_content 字段' };
}

async function parseDocling(
  fetcher: DocEndpointFetcher,
  base: string,
  buffer: Buffer,
  fileName: string,
  mime: string,
  opts: ParseViaEndpointOpts,
): Promise<EndpointParseResult> {
  const form = new FormData();
  form.append('files', fileBlob(buffer, fileName, mime), fileName);
  form.append('to_formats', 'md');
  const { json, error } = await fetchJson(fetcher, `${base}/v1/convert/source`, form, opts, 'docling');
  if (error) return { ok: false, error };
  const md = extractDoclingMarkdown(json);
  return md !== undefined
    ? { ok: true, markdown: md, via: 'endpoint-docling' }
    : { ok: false, error: 'docling 端点响应中未找到 document.md.content 字段' };
}

async function parseCustom(
  fetcher: DocEndpointFetcher,
  base: string,
  buffer: Buffer,
  fileName: string,
  mime: string,
  opts: ParseViaEndpointOpts,
): Promise<EndpointParseResult> {
  const form = new FormData();
  form.append('file', fileBlob(buffer, fileName, mime), fileName);
  const { json, error } = await fetchJson(fetcher, `${base}/parse`, form, opts, 'custom');
  if (error) return { ok: false, error };
  const md = extractCustomMarkdown(json);
  return md !== undefined
    ? { ok: true, markdown: md, via: 'endpoint-custom' }
    : { ok: false, error: 'custom 端点响应中未找到 markdown 字段' };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
