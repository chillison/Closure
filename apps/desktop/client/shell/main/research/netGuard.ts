/**
 * Research network guard + throttling (Story 3.6 WP2, R3 / design D7).
 *
 * Pure Node (no electron import) so the whole matrix is table-testable under
 * plain vitest with an injected DNS lookup fn — zero network dependency.
 *
 * SSRF policy (D7), fail-closed throughout:
 *   - scheme whitelist http/https (file:, ftp:, data:, … are blocked);
 *   - DNS resolve-then-check: for hostnames, EVERY resolved address must be
 *     public (blocks multi-A records that smuggle one private hit); resolution
 *     failure or an empty answer blocks (cannot verify → block);
 *   - literal-IP hostnames are checked synchronously (no DNS round-trip);
 *   - `allowlist` = ORIGIN-level entries that bypass the check (`host` entry =
 *     any port on that host; `host:port` entry = that origin ONLY, P9) — the
 *     user-configured SearXNG / doc-parser endpoints + auto-probed localhost
 *     hits.
 *
 * Redirect re-validation is the CALLER's duty (WP5 web_fetch/render_page
 * handlers re-run this guard per hop) — a single pre-flight check cannot see
 * where a public URL redirects to.
 *
 * Throttling (D9): `LruTtlCache` (same-query search results, TTL 10min, LRU
 * cap 50) + `EngineGate` (min 500ms between calls to the same engine host).
 * Both take an injectable `now` for deterministic tests.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// ── SSRF guard ──

/** Why a URL was blocked. `dns-failed` exists because the policy is fail-closed. */
export type SsrfBlockReason = 'invalid-url' | 'scheme' | 'private-ip' | 'dns-failed';

/** Thrown by {@link assertPublicHttpUrl}; handlers catch and degrade friendly (R8). */
export class SsrfBlockedError extends Error {
  readonly url: string;
  readonly blockReason: SsrfBlockReason;

  constructor(url: string, blockReason: SsrfBlockReason, message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.url = url;
    this.blockReason = blockReason;
  }
}

/** Resolves a hostname to ALL of its addresses (A + AAAA). Injectable for tests. */
export type DnsLookupFn = (hostname: string) => Promise<string[]>;

/**
 * Origin string for allowlist matching (P9, CR 2026-08-15): `host` when the
 * URL carries no explicit port, `host:port` when it does. IPv6 literals get
 * brackets back when a port is present (`[::1]:8888`). An allowlist entry
 * WITH a port only matches that exact origin; a bare-host entry matches the
 * host on ANY port.
 */
export function urlOrigin(url: URL): string {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!url.port) return host;
  return host.includes(':') ? `[${host}]:${url.port}` : `${host}:${url.port}`;
}

/**
 * Origin-level allowlist match (P9): an entry equals the request's origin
 * (`host:port` — port-exact) OR the entry is a BARE host that equals the
 * request hostname (any port). The reverse holds too — allowlisting
 * `127.0.0.1:8888` does NOT open `127.0.0.1:9999`.
 */
export function allowlistMatchesOrigin(entry: string, url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const e = entry.trim().toLowerCase();
  return e === urlOrigin(url) || e === host;
}

async function defaultDnsLookup(hostname: string): Promise<string[]> {
  const result = await dnsLookup(hostname, { all: true });
  return result.map((r) => r.address);
}

/** Parse a dotted-quad into 4 octets, or null. Leading-zero octets are rejected. */
export function parseIpv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Parse an IPv6 literal into 16 bytes, or null. Handles `::` compression,
 * embedded IPv4 tails (`::ffff:127.0.0.1`), and rejects malformed forms
 * (double `::`, empty groups, out-of-range groups).
 */
export function parseIpv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  // Embedded IPv4 tail → rewrite as two hex groups so the rest is uniform.
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4Octets(s.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dbl = s.indexOf('::');
  const hasDbl = dbl !== -1;
  if (hasDbl && s.indexOf('::', dbl + 1) !== -1) return null;

  let head: string[];
  let tail: string[] = [];
  if (hasDbl) {
    const headStr = s.slice(0, dbl);
    const tailStr = s.slice(dbl + 2);
    // Reject ':1::2' / '1::2:' shapes — only the bare '::' may sit at an end.
    if (headStr.endsWith(':') || tailStr.startsWith(':')) return null;
    head = headStr === '' ? [] : headStr.split(':');
    tail = tailStr === '' ? [] : tailStr.split(':');
  } else {
    head = s.split(':');
    if (head.some((g) => g === '')) return null;
  }
  if (head.length + tail.length > 8) return null;
  for (const g of [...head, ...tail]) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }
  const fill = 8 - head.length - tail.length;
  if (hasDbl ? fill < 1 : fill !== 0) return null;

  const groups = [...head, ...Array.from({ length: hasDbl ? fill : 0 }, () => '0'), ...tail];
  const bytes: number[] = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

function isPrivateIpv4(o: number[]): boolean {
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this network" (incl. 0.0.0.0)
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  return false;
}

function isPrivateIpv6(bytes: number[]): boolean {
  const allZeroExcept = (idx: number, value: number) =>
    bytes.every((b, i) => (i === idx ? b === value : b === 0));
  if (bytes.every((b) => b === 0)) return true; // :: unspecified
  if (allZeroExcept(15, 1)) return true; // ::1 loopback
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  // IPv4-mapped ::ffff:a.b.c.d — check the embedded v4 or the mapping smuggles
  // loopback/private v4 past the guard.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(bytes.slice(12));
  }
  return false;
}

/**
 * Whether an IP literal is private/loopback/link-local/unspecified (must NOT be
 * fetched). Unparseable input returns TRUE — a guard fails closed, never open.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIpv4Octets(ip);
  if (v4) return isPrivateIpv4(v4);
  const v6 = parseIpv6Bytes(ip);
  if (v6) return isPrivateIpv6(v6);
  return true;
}

/**
 * Assert a research URL points at a public http(s) target. Resolves when the
 * URL is allowed; throws {@link SsrfBlockedError} otherwise (never a bare
 * Error, so callers can branch on `blockReason` for the friendly message).
 *
 * Fast path: literal-IP hostnames and allowlisted hosts decide synchronously
 * (no DNS). Hostnames resolve via `lookup` (injectable) and EVERY address must
 * be public.
 */
export async function assertPublicHttpUrl(
  url: string,
  allowlist: readonly string[] = [],
  resolveHost: DnsLookupFn = defaultDnsLookup,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(url, 'invalid-url', `URL 格式非法：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(url, 'scheme', `非 http/https 协议已拦截（${parsed.protocol}）：${url}`);
  }
  // URL#hostname keeps brackets on IPv6 literals — strip for matching.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (allowlist.some((entry) => allowlistMatchesOrigin(entry, parsed))) return;

  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new SsrfBlockedError(url, 'private-ip', `目标 IP ${hostname} 是私网/环回/链路本地地址，已拦截：${url}`);
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch (err) {
    throw new SsrfBlockedError(
      url,
      'dns-failed',
      `域名 ${hostname} DNS 解析失败（fail-closed 拦截）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(url, 'dns-failed', `域名 ${hostname} DNS 解析结果为空（fail-closed 拦截）：${url}`);
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new SsrfBlockedError(url, 'private-ip', `域名 ${hostname} 解析到私网地址 ${addr}，已拦截：${url}`);
    }
  }
}

// ── Throttle layer (design D9) ──

/** Same-query search-result cache lifetime. */
export const SEARCH_RESULT_TTL_MS = 10 * 60 * 1000;
/** Max cached queries (LRU — least recently used query is evicted first). */
export const SEARCH_RESULT_CACHE_CAPACITY = 50;
/** Min interval between two calls to the SAME engine host (anti-ban hygiene). */
export const ENGINE_MIN_INTERVAL_MS = 500;

/**
 * Tiny LRU + TTL cache (query → hits). `Map` iteration order does the LRU
 * bookkeeping: `get` re-inserts to refresh recency, `set` evicts the oldest
 * entry when over capacity, and expired entries are dropped lazily on access.
 * All time reads go through the injectable `now` — deterministic under test.
 */
export class LruTtlCache<T> {
  private map = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = SEARCH_RESULT_TTL_MS,
    private readonly capacity: number = SEARCH_RESULT_CACHE_CAPACITY,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** Search-result cache with the research defaults (query → hits, TTL 10min, LRU 50). */
export function createSearchResultCache<T>(overrides?: {
  ttlMs?: number;
  capacity?: number;
  now?: () => number;
}): LruTtlCache<T> {
  return new LruTtlCache<T>(overrides?.ttlMs, overrides?.capacity, overrides?.now);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Per-engine-host rate gate (D9): min interval between two calls to the same
 * engine host. `waitMs`/`mark` are pure bookkeeping (tests assert the math via
 * an injected clock); `acquire` is the convenience the WP4 chain executor uses
 * (wait out the remainder, then mark).
 */
export class EngineGate {
  private lastAt = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: number = ENGINE_MIN_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** ms this engine host must still wait (0 = may call now). Pure — no timers. */
  waitMs(engineHost: string): number {
    const last = this.lastAt.get(engineHost);
    if (last === undefined) return 0;
    const remaining = this.minIntervalMs - (this.now() - last);
    return remaining > 0 ? remaining : 0;
  }

  /** Record that a call to this engine host just fired. */
  mark(engineHost: string): void {
    this.lastAt.set(engineHost, this.now());
  }

  /**
   * Wait out the remaining interval (if any), then mark. P8 (CR 2026-08-15):
   * the wait is a RE-CHECK LOOP, not a single sleep — two waiters waking from
   * the same instant both re-derive `waitMs` (the first to mark pushes the
   * other back out), so concurrent acquirers stay mutually spaced instead of
   * firing together.
   */
  async acquire(engineHost: string): Promise<void> {
    for (;;) {
      const wait = this.waitMs(engineHost);
      if (wait <= 0) break;
      await sleep(wait);
    }
    this.mark(engineHost);
  }
}
