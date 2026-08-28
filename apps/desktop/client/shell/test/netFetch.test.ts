/**
 * Research netFetch seam tests (Story 3.6 WP2, R13 / design D6; CR 2026-08-15
 * P1/P2/P3).
 *
 * Covers: identifying-UA default + explicit-override precedence, init
 * passthrough, the non-2xx-returns (never throws) policy, typed error mapping
 * (network / timeout / abort), `expectOk` (http-status), the RESEARCH SESSION
 * seam (P2 — ses.fetch from session.fromPartition('research'), never the
 * default session), the MANUAL redirect loop with per-hop SSRF guard (P1),
 * and the streaming body cap (P3).
 *
 * Electron is mocked down to `session.fromPartition` — the suite runs under
 * plain vitest with ZERO network and ZERO real Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetch, fromPartition } = vi.hoisted(() => {
  const fetch = vi.fn();
  return {
    fetch,
    fromPartition: vi.fn(() => ({
      fetch,
      webRequest: { onBeforeRequest: vi.fn() },
    })),
  };
});

vi.mock('electron', () => ({
  session: { fromPartition, defaultSession: { fetch: vi.fn() } },
}));

import {
  DEFAULT_RESEARCH_TIMEOUT_MS,
  NET_FETCH_MAX_REDIRECTS,
  RESEARCH_UA,
  ResearchNetworkError,
  expectOk,
  netFetch,
  readBodyWithCap,
} from '../main/research/netFetch';

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

beforeEach(() => {
  fetch.mockReset();
  fromPartition.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('netFetch — research session seam (P2)', () => {
  it('issues via session.fromPartition("research", {cache:false}).fetch, NOT net.fetch/defaultSession', async () => {
    fetch.mockResolvedValue(new Response('ok'));

    await netFetch('https://zh.moegirl.org.cn/api.php');

    expect(fromPartition).toHaveBeenCalledWith('research', { cache: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://zh.moegirl.org.cn/api.php');
    expect(new Headers(init.headers).get('user-agent')).toBe(RESEARCH_UA);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('the session singleton is created ONCE per process (fromPartition never re-called per request)', async () => {
    fetch.mockResolvedValue(new Response('ok'));
    fromPartition.mockClear();
    await netFetch('https://a.example.com/');
    await netFetch('https://b.example.com/');
    // Either the session already existed from an earlier test in this file
    // (module state persists), or this pair created it — exactly once either way.
    expect(fromPartition.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('netFetch — headers / passthrough', () => {
  it('an explicit user-agent in init.headers WINS over the default', async () => {
    fetch.mockResolvedValue(new Response('ok'));

    await netFetch('https://cn.bing.com/', { headers: { 'user-agent': 'MyAgent/2.0' } });

    expect(new Headers(fetch.mock.calls[0][1].headers).get('user-agent')).toBe('MyAgent/2.0');
  });

  it('opts.ua overrides the default UA', async () => {
    fetch.mockResolvedValue(new Response('ok'));

    await netFetch('https://www.baidu.com/s', undefined, { ua: 'Other/9' });

    expect(new Headers(fetch.mock.calls[0][1].headers).get('user-agent')).toBe('Other/9');
  });

  it('passes method/body through (default path uses redirect:"follow")', async () => {
    fetch.mockResolvedValue(new Response('ok'));

    await netFetch('https://api.example.com/v1/search', { method: 'POST', body: '{"q":"x"}' });

    const init = fetch.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"q":"x"}');
    expect(init.redirect).toBe('follow');
  });

  it('NON-2xx responses are RETURNED, not thrown (callers judge per engine)', async () => {
    fetch.mockResolvedValue(new Response('captcha', { status: 503 }));

    const res = await netFetch('https://www.baidu.com/s?q=x');
    expect(res.status).toBe(503);
  });
});

describe('netFetch — typed transport errors', () => {
  it('transport failure → ResearchNetworkError reason "network" with cause preserved', async () => {
    const boom = new TypeError('net::ERR_CONNECTION_REFUSED');
    fetch.mockRejectedValue(boom);

    const err = await netFetch('https://nx.example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchNetworkError);
    const typed = err as ResearchNetworkError;
    expect(typed.reason).toBe('network');
    expect(typed.cause).toBe(boom);
    expect(typed.message).toContain('nx.example.com');
  });

  it('timeout → reason "timeout" (default budget is the designed 10s)', async () => {
    expect(DEFAULT_RESEARCH_TIMEOUT_MS).toBe(10_000);
    fetch.mockImplementation(() => new Promise<Response>(() => { /* never */ }));

    const err = await netFetch('https://slow.example.com/', undefined, { timeoutMs: 25 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ResearchNetworkError);
    expect((err as ResearchNetworkError).reason).toBe('timeout');
    expect((err as ResearchNetworkError).message).toContain('25ms');
  });

  it('timeoutMs: 0 disables the timeout (long document-parser uploads)', async () => {
    let settle!: (r: Response) => void;
    fetch.mockImplementation(() => new Promise<Response>((resolve) => { settle = resolve; }));

    const pending = netFetch('http://localhost:9999/file_parse', undefined, { timeoutMs: 0 });
    settle(new Response('done'));
    await expect(pending).resolves.toBeInstanceOf(Response);
  });

  it('an ALREADY-aborted external signal fails fast with reason "abort" (network untouched)', async () => {
    fetch.mockResolvedValue(new Response('ok'));
    const controller = new AbortController();
    controller.abort();

    const err = await netFetch('https://x.example.com/', undefined, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ResearchNetworkError);
    expect((err as ResearchNetworkError).reason).toBe('abort');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborting mid-flight → reason "abort" (distinct from timeout)', async () => {
    fetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const controller = new AbortController();

    const pending = netFetch('https://x.example.com/', undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const err = await pending.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResearchNetworkError);
    expect((err as ResearchNetworkError).reason).toBe('abort');
  });

  it('the internal signal is wired into the transport call (cancellation reaches ses.fetch)', async () => {
    let seenSignal: AbortSignal | null | undefined;
    fetch.mockImplementation((_url: string, init: RequestInit) => {
      seenSignal = init.signal;
      return Promise.resolve(new Response('ok'));
    });

    await netFetch('https://x.example.com/');
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false); // cleared timer did not abort it
  });
});

describe('netFetch — manual redirect loop with per-hop guard (P1)', () => {
  it('302 → guard re-runs on EVERY Location before the next hop; final 200 returns', async () => {
    fetch.mockImplementationOnce(async () => redirectResponse('https://hop.example.com/step2'))
      .mockImplementationOnce(async () => redirectResponse('http://final.example.com/ok', 301))
      .mockImplementationOnce(async () => new Response('landed'));
    const guarded: string[] = [];

    const res = await netFetch('https://start.example.com/', {}, {
      guard: async (url) => {
        guarded.push(url);
      },
    });

    expect(await res.text()).toBe('landed');
    expect(guarded).toEqual([
      'https://start.example.com/',
      'https://hop.example.com/step2',
      'http://final.example.com/ok',
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    // Every transport call under a guard runs in MANUAL redirect mode.
    for (const call of fetch.mock.calls) {
      expect((call[1] as RequestInit).redirect).toBe('manual');
    }
  });

  it('a redirect whose Location is a PRIVATE target is blocked by the guard → typed network error', async () => {
    fetch.mockImplementationOnce(async () => redirectResponse('http://192.168.1.1/admin'));

    const err = await netFetch('https://public.example.com/', {}, {
      guard: (url) => {
        if (url.includes('192.168.1.1')) throw new Error('SSRF blocked');
        return Promise.resolve();
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResearchNetworkError);
    expect((err as ResearchNetworkError).reason).toBe('network');
    expect(fetch).toHaveBeenCalledTimes(1); // the private hop NEVER fired
  });

  it('relative Location headers resolve against the CURRENT hop URL', async () => {
    fetch.mockImplementationOnce(async () => redirectResponse('/next'))
      .mockImplementationOnce(async () => new Response('ok'));
    const guarded: string[] = [];

    await netFetch('https://a.example.com/dir/page', {}, {
      guard: async (url) => {
        guarded.push(url);
      },
    });

    expect(guarded[1]).toBe('https://a.example.com/next');
  });

  it('a 30x WITHOUT a Location header → http-status error; beyond MAX hops → loop verdict', async () => {
    fetch.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(
      netFetch('https://a.example.com/', {}, { guard: async () => {} }),
    ).rejects.toMatchObject({ reason: 'http-status' });

    // Endless redirector: hop budget (5) exhausts.
    fetch.mockReset();
    fetch.mockImplementation(async () => redirectResponse('https://loop.example.com/next'));
    await expect(
      netFetch('https://loop.example.com/start', {}, { guard: async () => {} }),
    ).rejects.toMatchObject({ reason: 'http-status', message: expect.stringContaining('重定向') });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(NET_FETCH_MAX_REDIRECTS + 1);
  });

  it('303 demotes a POST to GET (fetch-spec method rewrite); 307 keeps it', async () => {
    fetch.mockImplementationOnce(async () => redirectResponse('https://a.example.com/land', 303))
      .mockImplementationOnce(async () => new Response('ok'));

    await netFetch('https://a.example.com/search', { method: 'POST', body: 'q=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, { guard: async () => {} });

    const second = fetch.mock.calls[1][1] as RequestInit;
    expect(second.method).toBe('GET');
    expect(second.body).toBeUndefined();

    fetch.mockReset();
    fetch.mockImplementationOnce(async () => redirectResponse('https://b.example.com/land', 307))
      .mockImplementationOnce(async () => new Response('ok'));
    await netFetch('https://b.example.com/search', { method: 'POST', body: 'q=x' }, { guard: async () => {} });
    expect((fetch.mock.calls[1][1] as RequestInit).method).toBe('POST');
  });

  it('NO guard → automatic following (transport default, hop 0 untouched by the loop)', async () => {
    fetch.mockResolvedValue(new Response('ok'));
    await netFetch('https://a.example.com/');
    expect((fetch.mock.calls[0][1] as RequestInit).redirect).toBe('follow');
  });
});

describe('readBodyWithCap (P3)', () => {
  it('Content-Length pre-check rejects BEFORE any byte is buffered', async () => {
    const res = new Response('x', { headers: { 'content-length': '999999' } });
    await expect(readBodyWithCap(res, 10, 'https://big.example.com/')).rejects.toMatchObject({
      reason: 'body-too-large',
      message: expect.stringContaining('Content-Length'),
    });
  });

  it('a lying/chunked stream is CUT the moment the cap is crossed (no full buffer)', async () => {
    // A stream whose declared length is absent (chunked) but real size is huge.
    const chunk = 'a'.repeat(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const res = new Response(stream); // no content-length header
    const err = await readBodyWithCap(res, 128 * 1024, 'https://fat.example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchNetworkError);
    expect((err as ResearchNetworkError).reason).toBe('body-too-large');
  });

  it('an under-cap body round-trips as a Buffer', async () => {
    const res = new Response('设定文档正文');
    const buf = await readBodyWithCap(res, 1024);
    expect(buf.toString('utf-8')).toBe('设定文档正文');
  });

  it('a bodyless Response falls back to arrayBuffer with the same cap', async () => {
    const res = new Response('ok');
    Object.defineProperty(res, 'body', { value: null });
    const buf = await readBodyWithCap(res, 2);
    expect(buf.length).toBe(2);
  });
});

describe('expectOk (opt-in non-2xx conversion)', () => {
  it('passes a 2xx response through', () => {
    const res = new Response('ok');
    expect(expectOk(res, 'https://x.example.com/')).toBe(res);
  });

  it('throws ResearchNetworkError reason "http-status" with status in the message', () => {
    const res = new Response('nope', { status: 404 });
    expect(() => expectOk(res, 'https://x.example.com/a')).toThrow(ResearchNetworkError);
    try {
      expectOk(res, 'https://x.example.com/a');
    } catch (err) {
      expect((err as ResearchNetworkError).reason).toBe('http-status');
      expect((err as ResearchNetworkError).message).toContain('404');
    }
  });
});
