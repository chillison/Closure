/**
 * Research partition session (Story 3.6 CR 2026-08-15 P2, resolves edge#112
 * "沙箱子资源 SSRF 全敞开 + setProxy 作用全会话").
 *
 * ALL research outbound — `netFetch` (ses.fetch), the render_page sandbox
 * BrowserWindow (`webPreferences.partition: 'research'`), every search/wiki/
 * doc-parser request — rides ONE dedicated `session.fromPartition('research')`
 * singleton:
 *
 *   1. Proxy isolation: `applyResearchProxy` (configIpc) calls `setProxy` on
 *      THIS session only — a research proxy tier (esp. `off`) can never change
 *      proxying for the app's defaultSession (UI, model gateway, updater).
 *      Chromium still auto-honors the system proxy incl. WPAD/PAC on a
 *      partition session; `setProxy({mode:'system'})` just states it.
 *   2. Sandbox subresource net-filter: a `webRequest.onBeforeRequest` guard
 *      cancels NON-mainFrame requests whose URL hostname is a LITERAL private
 *      IP (loopback/private/link-local/unspecified) unless the origin is
 *      allowlisted. The render sandbox runs arbitrary third-party page JS —
 *      its subresource fetches never pass `assertPublicHttpUrl`, so this is
 *      the only net-layer line covering them. netFetch traffic crosses the
 *      same filter; that is two defense lines, not a conflict — netFetch's
 *      egress already went through `assertPublicHttpUrl` (or is a sanctioned
 *      localhost probe/endpoint in the allowlist).
 *
 *      Deliberately NO DNS here (performance + complexity): only literal-IP
 *      hostnames are checked synchronously. A hostname that RESOLVES to a
 *      private address slips past this filter — that residual
 *      DNS-rebinding-shaped risk is the accepted D1 defer (documented in
 *      prd Review Findings), partially mitigated by assertPublicHttpUrl's
 *      resolve-then-check on the netFetch paths.
 *
 * The allowlist is ORIGIN-level (P9): the always-on localhost SearXNG probe
 * origin (`127.0.0.1:8888`) plus the configurable origins pushed by
 * `setResearchSessionAllowlist` (fetchHandlers' researchFetchAllowlist +
 * the research:save-config handler refresh it).
 *
 * Pure state, no filesystem: `setResearchSessionAllowlist` never touches
 * electron, so unit tests with a stubbed electron can call it freely. The
 * session object is created lazily on first `getResearchSession()` — module
 * import has zero electron side effects.
 */
import { session } from 'electron';
import { isPrivateAddress } from './netGuard';

/** The research partition name (shared with renderCapture's BrowserWindow). */
export const RESEARCH_PARTITION = 'research';

/** Sanctioned localhost origins that ALWAYS pass the net-filter (design D7/D9). */
const ALWAYS_ALLOWED_ORIGINS: readonly string[] = ['127.0.0.1:8888'];

let configurableOrigins: Set<string> = new Set();
let researchSession: Electron.Session | undefined;
let guardInstalled = false;

/**
 * The research partition session (lazy singleton, `cache: false` — research
 * responses are one-shot tool data, never worth a disk cache).
 */
export function getResearchSession(): Electron.Session {
  if (!researchSession) {
    researchSession = session.fromPartition(RESEARCH_PARTITION, { cache: false });
    installRequestGuard(researchSession);
  }
  return researchSession;
}

/**
 * Replace the configurable portion of the net-filter allowlist (origin-level
 * entries: `host` = any port, `host:port` = exact origin, P9). Pure state —
 * no electron access, test-safe.
 */
export function setResearchSessionAllowlist(origins: readonly string[]): void {
  configurableOrigins = new Set(origins.map((o) => o.trim().toLowerCase()).filter(Boolean));
}

function originAllowed(origin: string, host: string): boolean {
  return (
    ALWAYS_ALLOWED_ORIGINS.includes(origin)
    || configurableOrigins.has(origin)
    || configurableOrigins.has(host)
  );
}

/**
 * Install the private-net net-filter on the research session (idempotent).
 * NON-mainFrame requests (sandbox subresources; the mainFrame navigation was
 * already vetted by assertPublicHttpUrl + re-checked on the final URL) whose
 * hostname is a literal private IP and whose origin is not allowlisted are
 * CANCELLED. Never throws — a filter failure must not take the session down.
 */
function installRequestGuard(target: Electron.Session): void {
  if (guardInstalled) return;
  guardInstalled = true;
  try {
    target.webRequest.onBeforeRequest((details, callback) => {
      try {
        if (details.resourceType === 'mainFrame') {
          callback({});
          return;
        }
        const parsed = new URL(details.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          callback({});
          return;
        }
        const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const origin = parsed.port
          ? (host.includes(':') ? `[${host}]:${parsed.port}` : `${host}:${parsed.port}`)
          : host;
        // Literal-IP hostnames only — no DNS in the hot path (module doc).
        if (/^[0-9.]+$/.test(host) || host.includes(':')) {
          if (isPrivateAddress(host) && !originAllowed(origin, host)) {
            callback({ cancel: true });
            return;
          }
        }
        callback({});
      } catch {
        // Unparseable URL — let the request proceed; netFetch's own guard is
        // fail-closed for the requests it issues.
        callback({});
      }
    });
  } catch {
    // webRequest unavailable (tests / exotic embeds) — the netFetch-side guard
    // remains the primary line; do not brick session creation.
    guardInstalled = false;
  }
}
