/**
 * Doc-parser endpoint config sidecar + health probe (Story 3.6 WP6, R10 /
 * design D11).
 *
 * Two concerns (mirror of searchConfig.ts):
 *
 *   1. `doc-parser.yaml` sidecar IO — `{type, baseUrl}` pair in configIpc's
 *      model dir. Absent/corrupt/schema-invalid file degrades to the default
 *      (unconfigured → builtin parsing) so a broken config never bricks
 *      parse_document. No secrets ride here (an endpoint URL is not a key),
 *      so no safeStorage round-trip.
 *   2. `probeDocParser` — GET `{base}/health` with a 2s budget. BOTH endpoint
 *      kinds expose the SAME health path (MinerU FastAPI /health and
 *      docling-serve /health, survey §1.4 + §2.1), so one probe answers all
 *      three kinds — a 2xx = ok. The result is cached per process keyed by the
 *      config pair (a config change re-probes); unconfigured is NOT cached (a
 *      later save must take effect on the next call without a forced refresh).
 *
 * The probe is the SANCTIONED endpoint access — the user explicitly configured
 * this URL, so it bypasses the SSRF guard (mirror probeSearxngLocalhost,
 * design D7) and goes straight through netFetch (system proxy honored, D6).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DOC_PARSER_CONFIG,
  docParserConfigSchema,
  parseFlatYaml,
  stringifyFlatYaml,
  type DocParserConfig,
  type DocParserKind,
} from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { getModelDir } from '../ipc/configIpc';
import { netFetch } from './netFetch';

// ── Sidecar IO ──

function getDocParserConfigPath(): string {
  return path.join(getModelDir(), 'doc-parser.yaml');
}

/**
 * Read the persisted doc-parser config. Absent/corrupt/schema-invalid file
 * degrades to the default (unconfigured → builtin fallback) — never throws.
 */
export function readDocParserConfig(): DocParserConfig {
  try {
    const p = getDocParserConfigPath();
    if (!existsSync(p)) return { ...DEFAULT_DOC_PARSER_CONFIG };
    const raw = parseFlatYaml(readFileSync(p, 'utf-8')) as Record<string, unknown>;
    const parsed = docParserConfigSchema.safeParse({
      type: typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : undefined,
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : undefined,
    });
    return parsed.success ? parsed.data : { ...DEFAULT_DOC_PARSER_CONFIG };
  } catch {
    return { ...DEFAULT_DOC_PARSER_CONFIG };
  }
}

/**
 * Persist the doc-parser config (write path, consumed by the WP10 settings
 * UI). Validates via the schema — an invalid half-config (type without
 * baseUrl) throws ZodError to the caller instead of silently persisting.
 */
export function writeDocParserConfig(config: DocParserConfig): void {
  const parsed = docParserConfigSchema.parse(config);
  const p = getDocParserConfigPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const flat: Record<string, string> = {};
  if (parsed.type) flat.type = parsed.type;
  if (parsed.baseUrl) flat.baseUrl = parsed.baseUrl;
  atomicWriteFileSync(p, stringifyFlatYaml(flat), 'utf-8');
}

// ── Health probe ──

export const DOC_PARSER_PROBE_TIMEOUT_MS = 2_000;

export interface DocParserProbeResult {
  ok: boolean;
  /** Echo of the configured kind — present only when a config exists. */
  kind?: DocParserKind;
  /** Failure detail (settings-page health lamp / handler degrade note). */
  detail?: string;
}

export interface DocParserProbeFetcher {
  (
    url: string,
    init: { method?: string; headers?: Record<string, string> },
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ ok: boolean; status: number }>;
}

const defaultProbeFetch: DocParserProbeFetcher = async (url, init, opts) => {
  const res = await netFetch(url, { ...init, signal: opts.signal }, { timeoutMs: opts.timeoutMs });
  return { ok: res.ok, status: res.status };
};

export interface ProbeDocParserOpts {
  /** Bypass the per-process cache (settings-page refresh button). */
  force?: boolean;
  signal?: AbortSignal;
  /** Injectable fetcher (tests); defaults to netFetch. */
  fetcher?: DocParserProbeFetcher;
  /** Injectable config (tests); defaults to the sidecar read. */
  config?: DocParserConfig;
}

/** Cache keyed by the config pair — a config change invalidates naturally. */
let probeCache: { key: string; result: DocParserProbeResult } | undefined;

/**
 * Probe the configured doc-parser endpoint (`GET {base}/health`, 2s budget).
 * A 2xx = ok (both MinerU and docling-serve expose /health). NEVER throws —
 * transport failures, timeouts, and the unconfigured state all return
 * `{ok:false}` with a detail. See module doc for the caching policy.
 */
export async function probeDocParser(opts: ProbeDocParserOpts = {}): Promise<DocParserProbeResult> {
  const config = opts.config ?? readDocParserConfig();
  if (!config.type || !config.baseUrl) {
    // Unconfigured is NOT cached — a later save must take effect immediately.
    return { ok: false, detail: '未配置文档解析端点（使用内置解析）' };
  }

  const key = `${config.type}|${config.baseUrl}`;
  if (!opts.force && probeCache?.key === key) return probeCache.result;

  const fetcher = opts.fetcher ?? defaultProbeFetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  let result: DocParserProbeResult;
  try {
    const res = await fetcher(`${base}/health`, { method: 'GET' }, { signal: opts.signal, timeoutMs: DOC_PARSER_PROBE_TIMEOUT_MS });
    result = res.ok
      ? { ok: true, kind: config.type }
      : { ok: false, kind: config.type, detail: `端点健康检查返回 HTTP ${res.status}` };
  } catch (err) {
    result = { ok: false, kind: config.type, detail: errMsg(err) };
  }
  probeCache = { key, result };
  return result;
}

/** Clear the per-process probe cache (settings refresh / tests). */
export function resetDocParserProbe(): void {
  probeCache = undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
