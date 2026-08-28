/**
 * Research net guard + throttle tests (Story 3.6 WP2, R3 / design D7).
 *
 * Table-driven per the implement.md WP2 checklist: private-address matrix
 * (every CIDR the design lists + public counterexamples + fail-closed),
 * assertPublicHttpUrl (scheme / allowlist / literal-IP fast path / DNS
 * resolve-then-check), LRU+TTL cache, and the engine gate. netGuard is pure
 * Node (no electron) and takes an injected DNS lookup fn + injectable clock —
 * the suite touches ZERO network and ZERO real time.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EngineGate,
  LruTtlCache,
  SEARCH_RESULT_CACHE_CAPACITY,
  SEARCH_RESULT_TTL_MS,
  SsrfBlockedError,
  assertPublicHttpUrl,
  createSearchResultCache,
  isPrivateAddress,
  parseIpv6Bytes,
  urlOrigin,
} from '../main/research/netGuard';

/** DNS lookup stub: resolves per a static host→addresses table, records calls. */
function makeLookup(table: Record<string, string[]>) {
  const fn = vi.fn(async (hostname: string): Promise<string[]> => {
    const hit = table[hostname];
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });
  return fn;
}

function expectBlocked(promise: Promise<void>, reason: string): Promise<void> {
  return promise.then(
    () => { throw new Error('expected assertPublicHttpUrl to throw'); },
    (err: unknown) => {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).blockReason).toBe(reason);
    },
  );
}

// ── isPrivateAddress: the full matrix from the design/dispatch table ──

describe('isPrivateAddress (SSRF matrix)', () => {
  const blocked: Array<[string, string]> = [
    ['127.0.0.1', 'IPv4 loopback'],
    ['127.8.8.8', '127/8 any (not just .0.0.1)'],
    ['10.0.0.1', '10/8 private'],
    ['10.255.255.255', '10/8 upper edge'],
    ['172.16.0.1', '172.16/12 lower edge'],
    ['172.31.255.255', '172.16/12 upper edge'],
    ['192.168.1.1', '192.168/16 private'],
    ['169.254.1.1', '169.254/16 link-local'],
    ['169.254.169.254', 'cloud metadata endpoint'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', '0/8 this-network'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fc00::1', 'fc00::/7 unique-local (fc)'],
    ['fd12:3456:789a::1', 'fc00::/7 unique-local (fd)'],
    ['fe80::1', 'fe80::/10 link-local'],
    ['fe80::ffff', 'fe80::/10 link-local'],
    ['febf::1', 'fe80::/10 upper edge (febf)'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:192.168.0.1', 'IPv4-mapped private (192.168)'],
  ];
  const allowed: Array<[string, string]> = [
    ['8.8.8.8', 'public DNS'],
    ['1.1.1.1', 'public DNS'],
    ['172.32.0.1', 'just outside 172.16/12'],
    ['172.15.255.255', 'just below 172.16/12'],
    ['192.169.1.1', 'just outside 192.168/16'],
    ['169.253.1.1', 'just below 169.254/16'],
    ['126.0.0.1', 'just below 127/8'],
    ['11.0.0.1', 'just outside 10/8'],
    ['2001:db8::1', 'public documentation range'],
    ['2606:4700::1', 'public global unicast'],
    ['fec0::1', 'just outside fe80::/10 (fec0, deprecated site-local)'],
    ['64:ff9b::1.2.3.4', 'NAT64 public (embedded v4, not ::ffff: mapped)'],
    ['fe00::1', 'below fe80::/10'],
  ];

  it.each(blocked)('blocks %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(allowed)('allows %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('fails CLOSED on unparseable input (a guard never opens on garbage)', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
    expect(isPrivateAddress('999.1.1.1')).toBe(true);
    expect(isPrivateAddress('01.2.3.4')).toBe(true); // leading-zero octet rejected → closed
  });
});

describe('parseIpv6Bytes', () => {
  it('expands :: compression and embedded IPv4 tails to 16 bytes', () => {
    expect(parseIpv6Bytes('::1')).toHaveLength(16);
    expect(parseIpv6Bytes('::1')?.[15]).toBe(1);
    expect(parseIpv6Bytes('::ffff:127.0.0.1')).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1,
    ]);
    expect(parseIpv6Bytes('fe80::a')).toBeDefined();
    expect(parseIpv6Bytes('::')).toEqual(new Array(16).fill(0));
  });
  it('rejects malformed literals', () => {
    expect(parseIpv6Bytes('1::2::3')).toBeNull(); // two ::
    expect(parseIpv6Bytes('1:2:3')).toBeNull(); // too short, no ::
    expect(parseIpv6Bytes(':1::2')).toBeNull();
    expect(parseIpv6Bytes('1::2:')).toBeNull();
    expect(parseIpv6Bytes('1g::2')).toBeNull();
    expect(parseIpv6Bytes('1:2:3:4:5:6:7:8:9')).toBeNull(); // too long
  });
});

// ── assertPublicHttpUrl ──

describe('assertPublicHttpUrl', () => {
  it('rejects file:// (and any non-http scheme)', async () => {
    await expectBlocked(assertPublicHttpUrl('file:///C:/Users/secret.yaml'), 'scheme');
    await expectBlocked(assertPublicHttpUrl('ftp://example.com/pub'), 'scheme');
    await expectBlocked(assertPublicHttpUrl('data:text/html,hello'), 'scheme');
  });

  it('rejects an unparseable URL', async () => {
    await expectBlocked(assertPublicHttpUrl('not a url at all'), 'invalid-url');
  });

  it('literal private IPs are blocked SYNCHRONOUSLY (no DNS call)', async () => {
    const lookup = makeLookup({});
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.5:8080/path',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data',
      'https://[::1]/',
      'https://[fe80::1]/',
      'https://[fd00::1]/',
    ]) {
      await expectBlocked(assertPublicHttpUrl(url, [], lookup), 'private-ip');
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('literal PUBLIC IPs pass synchronously (no DNS call)', async () => {
    const lookup = makeLookup({});
    await expect(assertPublicHttpUrl('http://8.8.8.8/', [], lookup)).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('hostnames resolve then check: public answers pass', async () => {
    const lookup = makeLookup({ 'zh.moegirl.org.cn': ['93.184.216.34'], 'dual.example.com': ['1.1.1.1', '2606:4700::1'] });
    await expect(assertPublicHttpUrl('https://zh.moegirl.org.cn/rest.php', [], lookup)).resolves.toBeUndefined();
    await expect(assertPublicHttpUrl('https://dual.example.com/', [], lookup)).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('EVERY resolved address must be public — one private hit among many blocks (multi-A smuggling)', async () => {
    const lookup = makeLookup({ 'evil.example.com': ['93.184.216.34', '10.0.0.5'] });
    await expectBlocked(assertPublicHttpUrl('https://evil.example.com/', [], lookup), 'private-ip');
  });

  it('a hostname resolving to an IPv4-mapped private address is blocked', async () => {
    const lookup = makeLookup({ 'mapped.example.com': ['::ffff:127.0.0.1'] });
    await expectBlocked(assertPublicHttpUrl('https://mapped.example.com/', [], lookup), 'private-ip');
  });

  it('DNS failure / empty answer → fail-closed (dns-failed)', async () => {
    const throwing = makeLookup({});
    await expectBlocked(assertPublicHttpUrl('https://nx.example.com/', [], throwing), 'dns-failed');
    const empty = vi.fn(async () => [] as string[]);
    await expectBlocked(assertPublicHttpUrl('https://empty.example.com/', [], empty), 'dns-failed');
  });

  it('allowlisted exact hosts pass WITHOUT DNS (localhost probe / configured endpoints)', async () => {
    const lookup = makeLookup({});
    await expect(assertPublicHttpUrl('http://localhost:8888/search?q=x', ['localhost'], lookup)).resolves.toBeUndefined();
    await expect(
      assertPublicHttpUrl('http://127.0.0.1:8888/', ['127.0.0.1', 'localhost'], lookup),
    ).resolves.toBeUndefined();
    await expect(
      assertPublicHttpUrl('http://my-searxng.local/search', ['my-searxng.local'], lookup),
    ).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('allowlist matching is host-EXACT and case-insensitive — no suffix tricks', async () => {
    const lookup = makeLookup({ 'localhost.evil.com': ['127.0.0.1'] });
    await expectBlocked(
      assertPublicHttpUrl('http://localhost.evil.com/', ['localhost'], lookup),
      'private-ip',
    );
    await expect(
      assertPublicHttpUrl('http://LOCALHOST:8888/', ['localhost'], makeLookup({})),
    ).resolves.toBeUndefined();
  });

  // ── P9 (CR 2026-08-15): origin-level allowlist matching ──

  it('P9: a PORTED allowlist entry opens ONLY that origin — other ports on the same host stay blocked', async () => {
    const lookup = makeLookup({});
    // Allowlisted 127.0.0.1:8888 → exactly that origin passes …
    await expect(
      assertPublicHttpUrl('http://127.0.0.1:8888/search', ['127.0.0.1:8888'], lookup),
    ).resolves.toBeUndefined();
    // … but 9999 (and every other port) is a private target again.
    await expectBlocked(
      assertPublicHttpUrl('http://127.0.0.1:9999/admin', ['127.0.0.1:8888'], lookup),
      'private-ip',
    );
    expect(lookup).not.toHaveBeenCalled(); // literal-IP fast path, no DNS
  });

  it('P9: a BARE-host allowlist entry matches the host on ANY port (hostname trust)', async () => {
    await expect(
      assertPublicHttpUrl('http://127.0.0.1:8888/', ['127.0.0.1'], makeLookup({})),
    ).resolves.toBeUndefined();
    await expect(
      assertPublicHttpUrl('http://127.0.0.1:7000/', ['127.0.0.1'], makeLookup({})),
    ).resolves.toBeUndefined();
  });

  it('P9: urlOrigin keeps brackets on ported IPv6 entries', () => {
    expect(urlOrigin(new URL('http://[::1]:8888/'))).toBe('[::1]:8888');
    expect(urlOrigin(new URL('http://[::1]/'))).toBe('::1');
    expect(urlOrigin(new URL('https://searx.example.com/search'))).toBe('searx.example.com');
    expect(urlOrigin(new URL('http://my.host:5001'))).toBe('my.host:5001');
  });
});

// ── LruTtlCache (search result cache) ──

describe('LruTtlCache / createSearchResultCache', () => {
  it('defaults carry the design values (TTL 10min, LRU cap 50)', () => {
    expect(SEARCH_RESULT_TTL_MS).toBe(10 * 60 * 1000);
    expect(SEARCH_RESULT_CACHE_CAPACITY).toBe(50);
    const cache = createSearchResultCache<string>();
    cache.set('q', 'hits');
    expect(cache.get('q')).toBe('hits');
  });

  it('TTL: hit before expiry, miss after (lazy eviction)', () => {
    let t = 1_000_000;
    const cache = new LruTtlCache<string>(60_000, 10, () => t);
    cache.set('q1', 'a');
    t += 59_999;
    expect(cache.get('q1')).toBe('a'); // just inside the window
    t += 1;
    expect(cache.get('q1')).toBeUndefined(); // expired
    expect(cache.size).toBe(0); // lazily dropped
  });

  it('LRU: reading a key refreshes its recency, so the OLDEST READ key is evicted', () => {
    let t = 0;
    const cache = new LruTtlCache<string>(60_000, 3, () => t);
    cache.set('a', '1');
    t++;
    cache.set('b', '2');
    t++;
    cache.set('c', '3');
    t++;
    expect(cache.get('a')).toBe('1'); // refresh a → order now b, c, a
    t++;
    cache.set('d', '4'); // over capacity → evicts b (least recently used)
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
    expect(cache.get('d')).toBe('4');
  });

  it('re-setting an existing key refreshes BOTH its value and recency', () => {
    let t = 0;
    const cache = new LruTtlCache<string>(60_000, 2, () => t);
    cache.set('a', '1');
    t++;
    cache.set('b', '2');
    t++;
    cache.set('a', '1b'); // a refreshed → order b, a
    cache.set('c', '3'); // evicts b
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1b');
    expect(cache.get('c')).toBe('3');
  });
});

// ── EngineGate ──

describe('EngineGate', () => {
  it('first call to an engine host needs no wait', () => {
    const t = 1_000;
    const gate = new EngineGate(500, () => t);
    expect(gate.waitMs('cn.bing.com')).toBe(0);
  });

  it('after a call, the same host must wait out the interval (500ms default honored)', () => {
    let t = 1_000;
    const gate = new EngineGate(500, () => t);
    gate.mark('cn.bing.com');
    t = 1_200;
    expect(gate.waitMs('cn.bing.com')).toBe(300);
    t = 1_500;
    expect(gate.waitMs('cn.bing.com')).toBe(0);
    t = 9_999;
    expect(gate.waitMs('cn.bing.com')).toBe(0); // never negative
  });

  it('different engine hosts are gated INDEPENDENTLY', () => {
    const t = 1_000;
    const gate = new EngineGate(500, () => t);
    gate.mark('cn.bing.com');
    expect(gate.waitMs('www.baidu.com')).toBe(0); // untouched host
    gate.mark('www.baidu.com');
    expect(gate.waitMs('cn.bing.com')).toBe(500);
  });

  it('acquire marks the engine and waits only when needed', async () => {
    let t = 1_000;
    const gate = new EngineGate(20, () => t);
    await gate.acquire('cn.bing.com'); // fresh host → no sleep, marks it
    expect(gate.waitMs('cn.bing.com')).toBe(20);
    // The fake clock must advance alongside real time: the P8 acquire loop
    // re-derives waitMs from `now` after every sleep, so a frozen clock would
    // (correctly) never release the waiter.
    const start = Date.now();
    const ticker = setInterval(() => {
      t += 5;
    }, 5);
    await gate.acquire('cn.bing.com'); // waits out the remainder, re-marks
    clearInterval(ticker);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15); // loose bound, anti-flake
    expect(gate.waitMs('cn.bing.com')).toBeLessThanOrEqual(20); // re-marked by acquire
  });

  it('P8: two waiters waking from the same instant stay MUTUALLY SPACED (re-check loop)', async () => {
    let t = 1_000;
    const gate = new EngineGate(50, () => t);
    gate.mark('engine.example.com'); // both incoming waiters owe the interval
    const marks: number[] = [];
    const observe = (p: Promise<void>) => p.then(() => marks.push(t));
    const ticker = setInterval(() => {
      t += 10;
    }, 5);
    await Promise.all([
      observe(gate.acquire('engine.example.com')),
      observe(gate.acquire('engine.example.com')),
    ]);
    clearInterval(ticker);
    // The first waiter marks; the second re-derives a FRESH interval off that
    // mark instead of firing alongside it (the pre-P8 single-sleep bug).
    expect(marks.length).toBe(2);
    expect(marks[1] - marks[0]).toBeGreaterThanOrEqual(40); // one interval minus ticker granularity
  });
});
