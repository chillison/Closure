/**
 * renderCapture service tests (Story 3.6 WP5, R12 / design D10).
 *
 * ZERO real windows / ZERO fs / instant waits: the BrowserWindow factory, the
 * filesystem seam, the sleep and the clock are all injected fakes (the fake
 * webContents answers the KNOWN injected scripts with fixture values). Locks:
 * the sandbox/security wiring, guard-before-load ordering, DOM-stability
 * sampling, textContent (not innerText) extraction, expandCollapsibles
 * injection, segmented vs single capture (2400 threshold, 3-segment cap,
 * over-long note), research-media retention, abort propagation, and the
 * never-throws contract on every failure path (R8).
 *
 * electron mocked down to a BrowserWindow stub — the default factory is never
 * exercised here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));

import path from 'node:path';
import {
  RENDER_CAPTURE_TOTAL_BUDGET_MS,
  RENDER_EXPAND_SCRIPT,
  RENDER_LOAD_TIMEOUT_MS,
  RENDER_MEDIA_FILE_CAP,
  RENDER_OBSERVER_SCRIPT,
  RENDER_READ_MUTATIONS_SCRIPT,
  RENDER_SCROLL_HEIGHT_SCRIPT,
  RENDER_TEXT_CONTENT_SCRIPT,
  captureRenderedPage,
  pruneMediaDir,
  renderScrollScript,
  type RenderCaptureFs,
  type RenderWindow,
  type RenderWindowFactory,
} from '../main/research/renderCapture';
import { RESEARCH_PARTITION } from '../main/research/researchSession';
import { SsrfBlockedError } from '../main/research/netGuard';

// The netGuard guard is stubbed per-test; the SSRF matrix itself lives in
// netGuard.test.ts. This spy lets tests assert entry-URL vetting happened.
const PUBLIC_URL = 'https://scp-wiki-cn.wikidot.com/scp-173';

// ── Fakes ──

interface FakeWindowCalls {
  scripts: string[];
  registered: string[];
  destroyed: boolean;
  stopped: boolean;
  listeners: Record<string, (event: { preventDefault(): void }, url?: string) => void>;
}

function createFakeWindow(opts: {
  text?: string;
  scrollHeight?: number;
  /** Second+ scrollHeight probe (P19 lazy-growth: pages that expand while scrolling). */
  scrollHeightAfter?: number;
  loadError?: Error;
  png?: Buffer;
  abortController?: AbortController;
  /** Final URL reported after load ('' / undefined = same as entry → no re-guard). */
  finalUrl?: string;
} = {}) {
  const calls: FakeWindowCalls = { scripts: [], registered: [], destroyed: false, stopped: false, listeners: {} };
  let scrollProbes = 0;
  const win: RenderWindow = {
    webContents: {
      loadURL: async () => {
        if (opts.loadError) throw opts.loadError;
        if (opts.abortController) {
          // Abort inside a macrotask BEFORE loadURL settles — the capture chain
          // itself runs on microtasks, so a setTimeout in the test body would
          // fire only after the whole capture finished.
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              opts.abortController!.abort();
              resolve();
            }, 0);
          });
        }
      },
      getURL: () => opts.finalUrl ?? '',
      executeJavaScript: async (code: string) => {
        if (opts.abortController?.signal.aborted && code === RENDER_READ_MUTATIONS_SCRIPT) {
          throw new DOMException('The operation was aborted', 'AbortError');
        }
        calls.scripts.push(code);
        if (code === RENDER_OBSERVER_SCRIPT) return 0;
        if (code === RENDER_READ_MUTATIONS_SCRIPT) return 0;
        if (code === RENDER_TEXT_CONTENT_SCRIPT) return opts.text ?? '页面文本内容';
        if (code === RENDER_SCROLL_HEIGHT_SCRIPT) {
          scrollProbes += 1;
          return scrollProbes > 1 ? (opts.scrollHeightAfter ?? opts.scrollHeight ?? 800) : (opts.scrollHeight ?? 800);
        }
        if (code === RENDER_EXPAND_SCRIPT) return true;
        if (code.startsWith('window.scrollTo')) return true;
        throw new Error(`unexpected script: ${code}`);
      },
      capturePage: async () => ({ toPNG: () => opts.png ?? Buffer.from('fake-png-bytes') }),
      stop: () => {
        calls.stopped = true;
      },
      setWindowOpenHandler: () => {
        calls.registered.push('open-handler-deny');
      },
      session: {
        setPermissionRequestHandler: () => {
          calls.registered.push('permission-deny');
        },
      },
      on: (event, listener) => {
        calls.registered.push(`on:${event}`);
        calls.listeners[event] = listener;
      },
    },
    destroy: () => {
      calls.destroyed = true;
    },
  };
  return { win, calls };
}

function createFakeFs() {
  const mtimes = new Map<string, number>();
  // Starts high so files pre-populated via setMtime(1..N) always sort as the
  // OLDEST entries and a later writeFile lands newest — deterministic pruning.
  let clock = 1_000;
  const removed: string[] = [];
  const fs: RenderCaptureFs = {
    ensureDir: vi.fn(),
    writeFile: (file) => {
      clock += 1;
      mtimes.set(file, clock);
    },
    listFiles: () => [...mtimes.keys()].map((f) => f.split(/[\\/]/).pop() ?? f),
    mtimeMs: (file) => mtimes.get(file) ?? 0,
    removeFile: (file) => {
      removed.push(file);
      mtimes.delete(file);
    },
  };
  return { fs, mtimes, removed, setMtime: (file: string, mtime: number) => mtimes.set(file, mtime) };
}

function instantDeps(
  window: ReturnType<typeof createFakeWindow>,
  fs: RenderCaptureFs,
  overrides: { guard?: (url: string, allowlist: readonly string[]) => Promise<void> } = {},
) {
  return {
    createWindow: vi.fn(() => window.win) as RenderWindowFactory,
    // Short waits (stability samples, scroll settle) resolve instantly; the
    // 8s load-budget race NEVER resolves — models "the budget hasn't elapsed"
    // so the race is won by loadURL, not by its own timeout rejection.
    sleep: (ms: number) =>
      ms >= 8_000 ? new Promise<void>(() => { /* never — budget not elapsed */ }) : Promise.resolve(),
    fs,
    now: () => 1_700_000_000_000,
    guard: overrides.guard ?? (async () => {}),
  };
}

const PROJECT = '/proj/alpha';
const MEDIA_DIR = path.join(PROJECT, '.orison', 'research-media');
const baseOptions = { projectDir: PROJECT };

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Guard ordering ──

describe('captureRenderedPage — SSRF guard', () => {
  it('a blocked URL → ok:false with the guard message; NO window is ever created', async () => {
    const { win, calls } = createFakeWindow();
    const factory = vi.fn(() => win);
    const outcome = await captureRenderedPage(
      'http://127.0.0.1:8080/admin',
      baseOptions,
      {
        createWindow: factory,
        sleep: async () => {},
        fs: createFakeFs().fs,
        guard: async () => {
          throw new SsrfBlockedError('http://127.0.0.1:8080/admin', 'private-ip', '目标 IP 是私网地址');
        },
      },
    );

    expect(outcome).toMatchObject({ ok: false, error: '目标 IP 是私网地址' });
    expect(factory).not.toHaveBeenCalled();
    expect(calls.destroyed).toBe(false);
  });

  it('a pre-aborted signal → ok:false 取消 without opening a window', async () => {
    const controller = new AbortController();
    controller.abort();
    const factory = vi.fn(() => createFakeWindow().win);
    const outcome = await captureRenderedPage(
      PUBLIC_URL,
      { ...baseOptions, signal: controller.signal },
      { createWindow: factory, sleep: async () => {}, fs: createFakeFs().fs },
    );
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.error).toContain('取消');
    expect(factory).not.toHaveBeenCalled();
  });

  it('redirect re-guard (caller-duty contract): a public entry redirecting to a PRIVATE final URL is blocked after load', async () => {
    const fake = createFakeWindow({ finalUrl: 'http://192.168.1.1/admin' });
    const guard = vi.fn(async (url: string) => {
      if (url === 'http://192.168.1.1/admin') {
        throw new SsrfBlockedError(url, 'private-ip', `目标 IP 是私网地址：${url}`);
      }
    });
    const outcome = await captureRenderedPage(
      PUBLIC_URL,
      baseOptions,
      instantDeps(fake, createFakeFs().fs, { guard }),
    );

    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.error).toContain('192.168.1.1');
    // Entry URL vetted once, final URL vetted once — never extracted further.
    expect(guard).toHaveBeenNthCalledWith(1, PUBLIC_URL, []);
    expect(guard).toHaveBeenNthCalledWith(2, 'http://192.168.1.1/admin', []);
    // The window is torn down even on the block.
    expect(fake.calls.destroyed).toBe(true);
  });

  it('redirect re-guard: a public final URL passes and capture proceeds', async () => {
    const fake = createFakeWindow({ text: '重定向后的正文', scrollHeight: 1200, finalUrl: 'https://mirror.example.com/scp-173' });
    const guard = vi.fn(async () => {});
    const outcome = await captureRenderedPage(
      PUBLIC_URL,
      baseOptions,
      instantDeps(fake, createFakeFs().fs, { guard }),
    );

    expect(outcome).toMatchObject({ ok: true, text: '重定向后的正文' });
    expect(guard).toHaveBeenNthCalledWith(2, 'https://mirror.example.com/scp-173', []);
  });
});

// ── Happy path + security wiring ──

describe('captureRenderedPage — sandbox wiring + dual channels', () => {
  it('loads a short page: text via textContent, single capture, all sandbox locks installed', async () => {
    const fake = createFakeWindow({ text: '基金会文档正文', scrollHeight: 1200 });
    const fakeFs = createFakeFs();
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, fakeFs.fs));

    expect(outcome).toEqual({
      ok: true,
      text: '基金会文档正文',
      // P12: the filename carries a random suffix between the timestamp and
      // the segment index (parallel same-ms captures never collide).
      images: [expect.stringMatching(/[\\/]render-1700000000000-[0-9a-f]{8}-0\.png$/)],
      notes: [],
    });
    // Text channel is textContent (NOT innerText) — the survey-mandated choice.
    expect(fake.calls.scripts).toContain(RENDER_TEXT_CONTENT_SCRIPT);
    // Single capture: no scroll scripts.
    expect(fake.calls.scripts.some((s) => s.startsWith('window.scrollTo'))).toBe(false);
    // Sandbox wiring: navigation lock + download cancel + open-deny + permission-deny.
    expect(fake.calls.registered).toEqual(
      expect.arrayContaining(['on:will-navigate', 'on:will-download', 'open-handler-deny', 'permission-deny']),
    );
    expect(fake.calls.destroyed).toBe(true);
  });

  it('P2: the window rides the shared research partition session (proxy + net-filter linkage)', async () => {
    const fake = createFakeWindow();
    const factory = vi.fn(() => fake.win) as RenderWindowFactory;
    await captureRenderedPage(PUBLIC_URL, baseOptions, {
      ...instantDeps(fake, createFakeFs().fs),
      createWindow: factory,
    });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      show: false,
      webPreferences: expect.objectContaining({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: RESEARCH_PARTITION,
      }),
    }));
  });

  it('will-navigate lock cancels nav to a DIFFERENT url but allows the same url', async () => {
    const fake = createFakeWindow();
    await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, createFakeFs().fs));

    const listener = fake.calls.listeners['will-navigate'];
    expect(listener).toBeDefined();
    let prevented = 0;
    const event = { preventDefault: () => { prevented += 1; } };
    listener(event, 'https://evil.example.com/');
    expect(prevented).toBe(1);
    listener(event, PUBLIC_URL);
    expect(prevented).toBe(1); // same-url nav (reload) untouched
  });

  it('expandCollapsibles injects the expansion script + notes it', async () => {
    const fake = createFakeWindow();
    const outcome = await captureRenderedPage(
      PUBLIC_URL,
      { ...baseOptions, expandCollapsibles: true },
      instantDeps(fake, createFakeFs().fs),
    );
    expect(fake.calls.scripts).toContain(RENDER_EXPAND_SCRIPT);
    expect(outcome.ok && outcome.notes.some((n) => n.includes('折叠块'))).toBe(true);
  });

  it('includeText:false skips the text script and returns empty text', async () => {
    const fake = createFakeWindow();
    const outcome = await captureRenderedPage(
      PUBLIC_URL,
      { ...baseOptions, includeText: false },
      instantDeps(fake, createFakeFs().fs),
    );
    expect(fake.calls.scripts).not.toContain(RENDER_TEXT_CONTENT_SCRIPT);
    expect(outcome).toMatchObject({ ok: true, text: '' });
  });
});

// ── Segmented capture ──

describe('captureRenderedPage — segmented scroll capture', () => {
  it('exactly 2400px stays a single capture (threshold is strictly greater)', async () => {
    const fake = createFakeWindow({ scrollHeight: 2400 });
    const fakeFs = createFakeFs();
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, fakeFs.fs));
    expect(outcome.ok && outcome.images.length).toBe(1);
    expect(fake.calls.scripts.some((s) => s.startsWith('window.scrollTo'))).toBe(false);
  });

  it('3000px page → 3 segments at 0/800/1600 + 超长 note (needed 4 > cap 3)', async () => {
    const fake = createFakeWindow({ scrollHeight: 3000 });
    const fakeFs = createFakeFs();
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, fakeFs.fs));

    const scrollScripts = fake.calls.scripts.filter((s) => s.startsWith('window.scrollTo'));
    expect(scrollScripts).toEqual([renderScrollScript(0), renderScrollScript(800), renderScrollScript(1600)]);
    expect(outcome.ok && outcome.images.length).toBe(3);
    expect(outcome.ok && outcome.notes.some((n) => n.includes('超长') && n.includes('4 段'))).toBe(true);
  });

  it('2480px page → 4 segments needed → capped at 3 + 超长 note', async () => {
    const fake = createFakeWindow({ scrollHeight: 2480 });
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, createFakeFs().fs));
    expect(outcome.ok && outcome.images.length).toBe(3);
    expect(outcome.ok && outcome.notes.some((n) => n.includes('超长'))).toBe(true);
  });

  it('P19: a page that KEEPS GROWING during the scroll gets the incomplete-capture note', async () => {
    // 4000px initially (5 segments > cap 3); the re-measure after the scroll
    // answers 5200 (> initial + one viewport) → the bottom was silently missed.
    const fake = createFakeWindow({ scrollHeight: 4000, scrollHeightAfter: 5200 });
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, createFakeFs().fs));
    expect(outcome.ok && outcome.images.length).toBe(3);
    expect(outcome.ok && outcome.notes.some((n) => n.includes('继续增长'))).toBe(true);
    expect(outcome.ok && outcome.notes.some((n) => n.includes('未完整捕获'))).toBe(true);
  });

  it('P19: a page whose height is STABLE gets no growth note', async () => {
    // Same 4000px on the re-measure → only the plain 超长 note.
    const fake = createFakeWindow({ scrollHeight: 4000, scrollHeightAfter: 4000 });
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, createFakeFs().fs));
    expect(outcome.ok && outcome.notes.some((n) => n.includes('继续增长'))).toBe(false);
    expect(outcome.ok && outcome.notes.some((n) => n.includes('超长'))).toBe(true);
  });

  it('an EMPTY capture (0-byte PNG) → skipped image + note, run still ok', async () => {
    const fake = createFakeWindow({ png: Buffer.alloc(0) });
    const fakeFs = createFakeFs();
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, fakeFs.fs));
    expect(outcome).toMatchObject({ ok: true, text: '页面文本内容', images: [] });
    expect(outcome.ok && outcome.notes.some((n) => n.includes('截图为空'))).toBe(true);
  });

  it('a writeFile failure → ok:true with 截图失败 note (text channel survives)', async () => {
    const fake = createFakeWindow();
    const fakeFs = createFakeFs();
    fakeFs.fs.writeFile = () => {
      throw new Error('disk full');
    };
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, fakeFs.fs));
    expect(outcome).toMatchObject({ ok: true, images: [] });
    expect(outcome.ok && outcome.notes.some((n) => n.includes('截图失败'))).toBe(true);
  });
});

// ── Failure paths (never throws, R8) ──

describe('captureRenderedPage — failures', () => {
  it('loadURL rejection → ok:false friendly message, window destroyed', async () => {
    const fake = createFakeWindow({ loadError: new Error('ERR_NAME_NOT_RESOLVED') });
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, createFakeFs().fs));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('渲染捕获失败');
      expect(outcome.error).toContain('ERR_NAME_NOT_RESOLVED');
    }
    expect(fake.calls.destroyed).toBe(true);
  });

  it('abort mid-run → ok:false 取消 + webContents.stop + destroy', async () => {
    const controller = new AbortController();
    const fake = createFakeWindow({ abortController: controller });
    const deps = instantDeps(fake, createFakeFs().fs);

    const outcome = await captureRenderedPage(
      PUBLIC_URL,
      { ...baseOptions, signal: controller.signal },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('取消');
    expect(fake.calls.stopped).toBe(true);
    expect(fake.calls.destroyed).toBe(true);
  });

  it('P21: "Object has been destroyed" AFTER an abort reads as 已取消, never a render failure', async () => {
    const controller = new AbortController();
    // Abort during load; the stability probe then throws Electron's destroyed
    // error (onAbort tore the window down mid-script).
    const fake = createFakeWindow({ abortController: controller });
    const win = fake.win;
    const originalExec = win.webContents.executeJavaScript.bind(win.webContents);
    win.webContents.executeJavaScript = async (code: string) => {
      if (controller.signal.aborted && code === RENDER_READ_MUTATIONS_SCRIPT) {
        throw new Error('Object has been destroyed');
      }
      return originalExec(code);
    };

    const outcome = await captureRenderedPage(
      PUBLIC_URL,
      { ...baseOptions, signal: controller.signal },
      instantDeps(fake, createFakeFs().fs),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('渲染捕获已被取消');
      expect(outcome.error).not.toContain('渲染捕获失败');
    }
  });

  it('P7: a HUNG page (stability never settles) is cut by the TRUE 20s total budget', async () => {
    const fake = createFakeWindow();
    const win = fake.win;
    const originalExec = win.webContents.executeJavaScript.bind(win.webContents);
    // The stability probe never answers — the flow would hang forever without
    // the total-budget race.
    win.webContents.executeJavaScript = (code: string) =>
      code === RENDER_READ_MUTATIONS_SCRIPT
        ? new Promise(() => { /* never */ })
        : originalExec(code);

    const outcome = await captureRenderedPage(
      PUBLIC_URL,
      baseOptions,
      {
        ...instantDeps(fake, createFakeFs().fs),
        // Short waits resolve instantly; the LOAD stage (8s) never elapses;
        // the TOTAL budget (20s) DOES — the race kills the hung capture.
        sleep: (ms: number) =>
          ms === RENDER_CAPTURE_TOTAL_BUDGET_MS
            ? Promise.resolve()
            : ms >= RENDER_LOAD_TIMEOUT_MS
              ? new Promise<void>(() => { /* never */ })
              : Promise.resolve(),
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('渲染超时');
      expect(outcome.error).toContain('20000');
    }
    expect(fake.calls.destroyed).toBe(true); // the finally always tears the window down
  });
});

// ── Retention ──

describe('research-media retention', () => {
  it('capture beyond the cap evicts the OLDEST files (mtime order)', async () => {
    const fakeFs = createFakeFs();
    // Pre-populate exactly at the cap with ascending mtimes (oldest first).
    for (let i = 1; i <= RENDER_MEDIA_FILE_CAP; i += 1) {
      fakeFs.setMtime(path.join(MEDIA_DIR, `keep-${String(i).padStart(2, '0')}.png`), i);
    }
    const fake = createFakeWindow();
    const outcome = await captureRenderedPage(PUBLIC_URL, baseOptions, instantDeps(fake, fakeFs.fs));

    expect(outcome.ok && outcome.images.length).toBe(1);
    // 51 files > 50 → exactly one eviction, and it is the oldest (keep-01).
    expect(fakeFs.removed).toEqual([path.join(MEDIA_DIR, 'keep-01.png')]);
  });

  it('pruneMediaDir keeps the NEWEST files when mtimes differ from insertion order', () => {
    const fakeFs = createFakeFs();
    const names = Array.from({ length: RENDER_MEDIA_FILE_CAP + 2 }, (_, i) => `f-${i}.png`);
    // Explicit mtimes: f-1 oldest, f-0 second-oldest, the rest newest.
    names.forEach((name, i) => fakeFs.setMtime(path.join(MEDIA_DIR, name), i));
    fakeFs.setMtime(path.join(MEDIA_DIR, 'f-1.png'), -2);
    fakeFs.setMtime(path.join(MEDIA_DIR, 'f-0.png'), -1);

    pruneMediaDir(MEDIA_DIR, fakeFs.fs);
    expect(fakeFs.removed.sort()).toEqual(
      [path.join(MEDIA_DIR, 'f-0.png'), path.join(MEDIA_DIR, 'f-1.png')].sort(),
    );
  });
});
