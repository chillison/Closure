/**
 * Render-state page capture service (Story 3.6 WP5, R12 / design D10).
 *
 * `captureRenderedPage(url, opts)` loads a page inside a HIDDEN, fully
 * sandboxed BrowserWindow and returns the DUAL-CHANNEL capture the survey
 * (multimodal-parsing §5.2, MDN) motivates:
 *
 *   1. TEXT — `document.body.textContent`, NOT innerText: innerText honors the
 *      render state, so display:none collapsed blocks (wikidot `[[collapsible]]`
 *      etc.) are DROPPED, while textContent returns everything. Purely-textual
 *      hiding tricks are fully covered by this channel alone.
 *   2. IMAGES — segmented scroll captures via `webContents.capturePage()`
 *      (no fullPage exists — Electron #17834). Purely-visual tricks
 *      (opacity:0 / same-color text / animation reveals / layout storytelling)
 *      only this channel can express; visual analysis itself is the leader's
 *      job composing `analyze_image` (tools stay orthogonal, design D10).
 *
 * Sandbox hardening (survey §4.4 checklist): show:false + sandbox +
 * contextIsolation + nodeIntegration:false + webSecurity, will-navigate locked
 * to the initial URL (post-load auto-nav/redirect smuggling cancelled),
 * setWindowOpenHandler deny, permission requests denied, downloads cancelled.
 *
 * Proxy linkage (design D6; CR P2): the window rides the shared `research`
 * partition session (`webPreferences.partition`), the SAME session
 * `applyResearchProxy` (configIpc) steers and `netFetch` issues from — the
 * system/custom/off tier governs this window with zero extra wiring, and the
 * session's webRequest private-net filter covers the sandbox's subresources
 * (arbitrary page JS cannot reach literal-IP private hosts).
 *
 * NEVER throws — every failure (SSRF block, load failure, timeout, abort)
 * returns `{ ok:false, error }` with a friendly message (R8).
 *
 * Windows note (survey §4.1): hidden ≠ minimized — a minimized window captures
 * a 0-height image on Windows; the window is only ever hidden, never minimized.
 *
 * Testability: the BrowserWindow constructor, the filesystem, the sleep and
 * the clock are ALL injectable seams — unit tests run with ZERO real windows,
 * ZERO fs side effects, and instant waits.
 */
import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RESEARCH_PARTITION } from './researchSession';
import { assertPublicHttpUrl, SsrfBlockedError } from './netGuard';

// ── Constants (design D10 / WP5 scope) ──

export const RENDER_VIEWPORT_WIDTH = 1280;
export const RENDER_VIEWPORT_HEIGHT = 800;
/** Mutation sampling interval: two consecutive equal counts = DOM stable. */
export const RENDER_STABLE_INTERVAL_MS = 500;
/**
 * Per-stage budget for the LOAD phase only (CR P7): a hung page cannot hang
 * the tool call. The TRUE total budget for the whole capture (load + DOM
 * stability + text + screenshots) is {@link RENDER_CAPTURE_TOTAL_BUDGET_MS}.
 */
export const RENDER_LOAD_TIMEOUT_MS = 8_000;
/**
 * TRUE total budget (CR P7): the ENTIRE capture — load, DOM stability wait,
 * text extraction, segmented screenshots — races one 20s clock; exceeding it
 * fails the capture with a render-timeout message (the 8s load-stage budget
 * above is a subset, not the ceiling).
 */
export const RENDER_CAPTURE_TOTAL_BUDGET_MS = 20_000;
/** Scroll step per captured segment = viewport height. */
export const RENDER_SEGMENT_HEIGHT = RENDER_VIEWPORT_HEIGHT;
/** Taller than 3 viewports → switch to segmented capture. */
export const RENDER_SEGMENT_THRESHOLD = RENDER_VIEWPORT_HEIGHT * 3;
/** Max segments for over-long pages (token budget, design D10 risk table). */
export const RENDER_MAX_SEGMENTS = 3;
/** Settle wait after each scroll before capturePage. */
export const RENDER_SCROLL_SETTLE_MS = 300;
/**
 * research-media retention: screenshots are research intermediates, NOT assets
 * (WP5 scope) — over this count the oldest files (by mtime) are evicted.
 */
export const RENDER_MEDIA_FILE_CAP = 50;

// ── Injected page scripts (exported so tests match them exactly) ──

/** Install a MutationObserver counting every DOM change after load. */
export const RENDER_OBSERVER_SCRIPT = `(() => {
  window.__closureMutationCount = 0;
  new MutationObserver(() => { window.__closureMutationCount += 1; })
    .observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
  return window.__closureMutationCount;
})()`;

export const RENDER_READ_MUTATIONS_SCRIPT = 'window.__closureMutationCount';

/**
 * Text channel — textContent on purpose (NOT innerText): collapsed
 * display:none blocks are invisible to innerText but fully present in
 * textContent (survey §5.2 / MDN innerText).
 */
export const RENDER_TEXT_CONTENT_SCRIPT = 'document.body ? document.body.textContent : ""';

export const RENDER_SCROLL_HEIGHT_SCRIPT = 'document.documentElement.scrollHeight';

/**
 * Force-expand collapsible regions (optional channel): common wiki collapse
 * classes un-hidden via CSS + native `<details>` opened via the `open`
 * attribute (CSS alone cannot reveal a closed details' content — the browser
 * hides it natively).
 */
export const RENDER_EXPAND_SCRIPT = `(() => {
  const css = document.createElement('style');
  css.textContent = '.collapsible-block,.collapsible,.collapsible-block-folded,' +
    '.collapsible-block-unfolded,.collapsible-content{display:block !important;}';
  document.head.appendChild(css);
  document.querySelectorAll('details:not([open])').forEach((d) => { d.open = true; });
  return true;
})()`;

export function renderScrollScript(offset: number): string {
  return `window.scrollTo(0, ${offset})`;
}

// ── Window seam (structural subset of Electron BrowserWindow) ──

export interface CapturedImage {
  toPNG(): Buffer;
}

export interface RenderWebContents {
  /** Resolves on did-finish-load, rejects on did-fail-load. */
  loadURL(url: string): Promise<void>;
  /** The URL of the loaded page (final URL after redirects) — re-guarded per hop. */
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<CapturedImage>;
  stop(): void;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  session: { setPermissionRequestHandler(handler: (callback: (granted: boolean) => void) => void): void };
  on(event: string, listener: (event: { preventDefault(): void }, url?: string) => void): void;
}

export interface RenderWindow {
  webContents: RenderWebContents;
  destroy(): void;
}

export interface RenderWindowOptions {
  show: false;
  width: number;
  height: number;
  webPreferences: {
    sandbox: boolean;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    webSecurity: boolean;
    javascript: boolean;
    /**
     * Shared research partition (CR P2): the window rides the same session as
     * netFetch — proxy tier applies, and the session's webRequest private-net
     * filter covers sandbox subresources.
     */
    partition: string;
  };
}

export type RenderWindowFactory = (options: RenderWindowOptions) => RenderWindow;

/**
 * Default factory: real Electron BrowserWindow. The real webContents is a
 * superset of {@link RenderWebContents}; the cast keeps the seam narrow so
 * tests can pass a fake without touching electron types.
 */
const defaultWindowFactory: RenderWindowFactory = (options) =>
  new BrowserWindow(options) as unknown as RenderWindow;

// ── Filesystem seam ──

export interface RenderCaptureFs {
  ensureDir(dir: string): void;
  writeFile(filePath: string, data: Buffer): void;
  listFiles(dir: string): string[];
  mtimeMs(filePath: string): number;
  removeFile(filePath: string): void;
}

const defaultFs: RenderCaptureFs = {
  ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
  writeFile: (file, data) => writeFileSync(file, data),
  listFiles: (dir) =>
    readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
  mtimeMs: (file) => statSync(file).mtimeMs,
  removeFile: (file) => unlinkSync(file),
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Retention sweep: keep the newest {@link RENDER_MEDIA_FILE_CAP} files in the
 * research-media dir, evict the oldest by mtime. Shared with the vision
 * manual-export files that live in the same dir — the cap is directory-wide
 * by design. Best-effort: never throws.
 */
export function pruneMediaDir(dir: string, fs: RenderCaptureFs): void {
  try {
    const names = fs.listFiles(dir);
    if (names.length <= RENDER_MEDIA_FILE_CAP) return;
    const full = names.map((name) => path.join(dir, name));
    full.sort((a, b) => fs.mtimeMs(a) - fs.mtimeMs(b));
    const excess = full.length - RENDER_MEDIA_FILE_CAP;
    for (let i = 0; i < excess; i += 1) {
      try {
        fs.removeFile(full[i]);
      } catch {
        // Race with another writer — skip; the next sweep catches it.
      }
    }
  } catch {
    // Retention is best-effort — never fails the capture.
  }
}

/**
 * Prune with the REAL fs (CR P12): shared by the vision manual-export files
 * that live in the same `research-media` dir — the retention cap is
 * directory-wide by design, so EVERY writer to that dir sweeps it.
 */
export function pruneMediaDirBestEffort(dir: string): void {
  pruneMediaDir(dir, defaultFs);
}

// ── Capture kernel ──

export type RenderCaptureOutcome =
  | { ok: true; text: string; images: string[]; notes: string[] }
  | { ok: false; error: string };

export interface CaptureRenderedPageOptions {
  projectDir: string;
  /** Inject the collapsible-expansion script before extract/capture. */
  expandCollapsibles?: boolean;
  /** Include the text channel (default true). */
  includeText?: boolean;
  /** External abort (tool run aborts). */
  signal?: AbortSignal;
  /** SSRF allowlist — exact hostnames exempt from the private-address check. */
  allowlist?: readonly string[];
}

export interface RenderCaptureDeps {
  createWindow?: RenderWindowFactory;
  sleep?: (ms: number) => Promise<void>;
  fs?: RenderCaptureFs;
  now?: () => number;
  guard?: (url: string, allowlist: readonly string[]) => Promise<void>;
}

export async function captureRenderedPage(
  url: string,
  options: CaptureRenderedPageOptions,
  deps: RenderCaptureDeps = {},
): Promise<RenderCaptureOutcome> {
  const createWindow = deps.createWindow ?? defaultWindowFactory;
  const sleep = deps.sleep ?? defaultSleep;
  const fs = deps.fs ?? defaultFs;
  const now = deps.now ?? Date.now;
  const guard = deps.guard ?? assertPublicHttpUrl;
  const allowlist = options.allowlist ?? [];

  if (options.signal?.aborted) {
    return { ok: false, error: `渲染捕获已被取消：${url}` };
  }
  try {
    await guard(url, allowlist);
  } catch (err) {
    return { ok: false, error: captureFailureMessage(err, url) };
  }

  let win: RenderWindow | null = null;
  let destroyed = false;
  const destroyWindow = (): void => {
    if (destroyed) return;
    destroyed = true;
    try {
      win?.destroy();
    } catch {
      // Already gone — idempotent teardown.
    }
  };
  const onAbort = (): void => {
    try {
      win?.webContents.stop();
    } catch {
      // Already gone.
    }
    destroyWindow();
  };
  if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    win = createWindow({
      show: false,
      width: RENDER_VIEWPORT_WIDTH,
      height: RENDER_VIEWPORT_HEIGHT,
      // Locked-down sandbox: research pages run ARBITRARY third-party JS inside
      // these walls — every capability beyond rendering is denied (R12). The
      // shared research partition puts the subresource traffic behind the
      // session's private-net filter + proxy tier (CR P2).
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        javascript: true,
        partition: RESEARCH_PARTITION,
      },
    });
    const wc = win.webContents;

    // Navigation lock: any navigation to a different URL is cancelled
    // (post-load redirect smuggling / auto-nav defense). HTTP redirects of the
    // INITIAL loadURL are part of the same navigation and do not fire
    // will-navigate — the guard above already vetted the entry URL.
    wc.on('will-navigate', (event, target) => {
      if (target !== undefined && target !== url) event.preventDefault();
    });
    wc.on('will-download', (event) => event.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.session.setPermissionRequestHandler((callback) => callback(false));

    // The whole capture (load → stability → text → screenshots) races the TRUE
    // total budget (CR P7) — one 20s clock for the entire flow, not per-stage
    // budgets that can sum past it.
    const flow = async (): Promise<RenderCaptureOutcome> => {
      // Load stage carries its own tighter budget: a hung page fails FAST
      // instead of eating the whole 20s before anyone notices.
      await Promise.race([
        wc.loadURL(url),
        sleep(RENDER_LOAD_TIMEOUT_MS).then(() => {
          throw new Error(`页面加载超时（${RENDER_LOAD_TIMEOUT_MS}ms）：${url}`);
        }),
      ]);

      // Redirect re-validation (netGuard caller-duty contract, mirror web_fetch /
      // analyze_image): HTTP redirects of the INITIAL loadURL do not fire
      // will-navigate (they are part of the same programmatic navigation), so the
      // navigation lock cannot see them — a public entry URL must not bounce the
      // sandbox window into a private/loopback target. The pre-flight guard above
      // only vetted the entry URL; the FINAL URL is re-guarded here.
      const finalUrl = wc.getURL();
      if (finalUrl && finalUrl !== url) {
        try {
          await guard(finalUrl, allowlist);
        } catch (err) {
          return { ok: false, error: captureFailureMessage(err, finalUrl) };
        }
      }

      // DOM stability: sample the mutation counter every 500ms; two consecutive
      // equal samples = stable. Iterations are hard-bounded (the sample count
      // derived from the total budget) and the 20s total race above is the real
      // ceiling — a churning page still terminates.
      await wc.executeJavaScript(RENDER_OBSERVER_SCRIPT);
      const maxSamples = Math.max(1, Math.floor(RENDER_CAPTURE_TOTAL_BUDGET_MS / RENDER_STABLE_INTERVAL_MS));
      let lastCount = -1;
      for (let sample = 0; sample < maxSamples; sample += 1) {
        await sleep(RENDER_STABLE_INTERVAL_MS);
        const count = Number(await wc.executeJavaScript(RENDER_READ_MUTATIONS_SCRIPT)) || 0;
        if (count === lastCount) break;
        lastCount = count;
      }

      const notes: string[] = [];
      if (options.expandCollapsibles === true) {
        await wc.executeJavaScript(RENDER_EXPAND_SCRIPT);
        notes.push('已注入 CSS 强制展开折叠块后提取/截图。');
      }

      const text = options.includeText === false
        ? ''
        : String((await wc.executeJavaScript(RENDER_TEXT_CONTENT_SCRIPT)) ?? '');

      const images: string[] = [];
      const mediaDir = path.join(options.projectDir, '.orison', 'research-media');
      try {
        fs.ensureDir(mediaDir);
        const scrollHeight = Number(await wc.executeJavaScript(RENDER_SCROLL_HEIGHT_SCRIPT)) || 0;
        const neededSegments = Math.ceil(scrollHeight / RENDER_SEGMENT_HEIGHT);
        const segments = scrollHeight > RENDER_SEGMENT_THRESHOLD
          ? Math.min(RENDER_MAX_SEGMENTS, neededSegments)
          : 1;
        const ts = now();
        for (let i = 0; i < segments; i += 1) {
          if (segments > 1) {
            await wc.executeJavaScript(renderScrollScript(i * RENDER_SEGMENT_HEIGHT));
            await sleep(RENDER_SCROLL_SETTLE_MS);
          }
          const png = (await wc.capturePage()).toPNG();
          if (png.length === 0) {
            notes.push(`第 ${i + 1} 段截图为空，已跳过（隐藏窗口可能尚未完成绘制）。`);
            continue;
          }
          // CR P12: a random suffix keeps PARALLEL captures in the same
          // millisecond from overwriting each other (and the image from ever
          // pairing with the wrong prompt downstream).
          const file = path.join(mediaDir, `render-${ts}-${randomUUID().slice(0, 8)}-${i}.png`);
          fs.writeFile(file, png);
          images.push(file);
        }
        if (scrollHeight > RENDER_SEGMENT_THRESHOLD && neededSegments > RENDER_MAX_SEGMENTS) {
          notes.push(`页面超长（约 ${scrollHeight}px，需 ${neededSegments} 段），仅截取前 ${RENDER_MAX_SEGMENTS} 段。`);
          // CR P19: lazy-loading pages keep growing DURING the scroll —
          // re-measure once the segments are done; growth beyond a viewport
          // while already capped means the bottom was silently missed.
          const finalScrollHeight = Number(await wc.executeJavaScript(RENDER_SCROLL_HEIGHT_SCRIPT)) || 0;
          if (finalScrollHeight > scrollHeight + RENDER_VIEWPORT_HEIGHT) {
            notes.push(`页面在滚动截图过程中继续增长（约 ${finalScrollHeight}px），底部内容未完整捕获。`);
          }
        }
        pruneMediaDir(mediaDir, fs);
      } catch (err) {
        // Screenshots are the SECOND channel — a capture failure never fails the
        // run when the text channel already carries the content.
        notes.push(`截图失败（${err instanceof Error ? err.message : String(err)}），本次仅返回文本。`);
      }

      return { ok: true, text, images, notes };
    };

    return await Promise.race([
      flow(),
      sleep(RENDER_CAPTURE_TOTAL_BUDGET_MS).then(() => {
        throw new Error(`页面渲染超时（总预算 ${RENDER_CAPTURE_TOTAL_BUDGET_MS}ms，含加载/稳定等待/截图）：${url}`);
      }),
    ]);
  } catch (err) {
    return { ok: false, error: captureFailureMessage(err, url, options.signal?.aborted === true) };
  } finally {
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
    destroyWindow();
  }
}

function captureFailureMessage(err: unknown, url: string, aborted = false): string {
  if (err instanceof SsrfBlockedError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  // CR P21: aborting during the DOM-stability window surfaces as Electron's
  // "Object has been destroyed" once onAbort tears the window down — with the
  // abort flag set that IS a cancellation, never a render failure.
  if (aborted && /destroyed/i.test(message)) return `渲染捕获已被取消：${url}`;
  const cancelled = /abort|cancel|取消/i.test(message);
  if (cancelled) return `渲染捕获已被取消：${url}`;
  return `渲染捕获失败（${url}）：${message}`;
}
