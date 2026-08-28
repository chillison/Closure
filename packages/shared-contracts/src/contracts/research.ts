import { z } from 'zod';

// ── Story 3.6 research tools contracts ──
//
// Home for the research tool family's cross-package contracts (shell ↔ UI).
// WP2 lands the network tier (`ResearchNetConfig`, R13 / design D6); later work
// packages extend this file with the search-engine config (WP4 `searchConfig`),
// the document-parser endpoint config (WP6 `docParserConfig`), and the wiki site
// registry (WP3) — mirror of how `closure-craft-retrieval.ts` grew per-story.
//
// All research outbound goes through Electron `net.fetch` on the dedicated
// `research` partition session (P2, CR 2026-08-15 — the proxy tier NEVER
// touches defaultSession, so a research proxy setting cannot change proxying
// for the whole app; Chromium still honors the system proxy incl. WPAD/PAC,
// which is the entire reason the session fetch is the seam,
// web-search-design-survey). The three proxy tiers map onto
// `<research session>.setProxy`:
//   system → {mode:'system'}                       (default, zero-config)
//   custom → {proxyRules: url, proxyBypassRules}   (Cherry Studio mirror)
//   off    → {mode:'direct'}
// Known limitation: session-level proxy AUTHENTICATION is not supported
// (Electron #21269) — the settings page must surface it (WP10).

/** Proxy tier for research network calls. `system` (default) = Chromium stack auto-detects (WPAD/PAC). */
export const researchProxyModeSchema = z.enum(['system', 'custom', 'off']);
export type ResearchProxyMode = z.infer<typeof researchProxyModeSchema>;

/**
 * Research network config (persisted as the `research-net.yaml` sidecar in
 * configIpc, mirror of the vision-model sidecar).
 *
 * Top-level refine (not a member-level one — the union would still infer fine,
 * but the constraint spans proxyMode × proxyUrl): `custom` without a usable
 * proxyUrl is meaningless, so it is rejected at the schema boundary instead of
 * degrading at `setProxy` time.
 */
export const researchNetConfigSchema = z
  .object({
    proxyMode: researchProxyModeSchema.default('system'),
    /** Proxy server rules, e.g. `http://127.0.0.1:7890` or `socks5://host:1080`. Required when proxyMode='custom'. */
    proxyUrl: z.string().trim().min(1).optional(),
    /** Extra bypass hosts appended AFTER the default `localhost,127.0.0.1,::1` (comma-separated). */
    proxyBypass: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.proxyMode !== 'custom' || v.proxyUrl !== undefined, {
    message: 'custom 代理模式必须配置 proxyUrl',
    path: ['proxyUrl'],
  });

export type ResearchNetConfig = z.infer<typeof researchNetConfigSchema>;

/** Fresh-install default: follow the system proxy (zero-config research network). */
export const DEFAULT_RESEARCH_NET_CONFIG: ResearchNetConfig = { proxyMode: 'system' };

// ── Story 3.6 WP3/WP10: wiki site registry contracts (R1 / design D8+D14) ──

/**
 * How `wiki_search` queries a site: 'opensearch' = title-prefix only (official
 * moegirl blocks api.php fulltext); 'fulltext' = api.php list=search works
 * (fulltext ⊇ prefix). Mirrors the shell-side `WikiSite.searchKind` union — the
 * settings UI and the sidecar round-trip through this contract.
 */
export const wikiSearchKindSchema = z.enum(['opensearch', 'fulltext']);

/**
 * A user-defined wiki site (settings page「自定义站点」, design D14). Structurally
 * the shell-side `WikiSite` minus internal flags the UI cannot edit —
 * `loadWikiSites(overrides)` merges these after the read-only presets and drops
 * any id that collides with a preset.
 */
export const wikiSiteOverrideSchema = z.object({
  /** Stable tool-param id (e.g. 'prts'); must not collide with a preset id. */
  id: z.string().trim().min(1),
  /** Human-readable name shown in tool outputs. */
  name: z.string().trim().min(1),
  /**
   * API base URL without trailing slash — endpoints hang off the root.
   * `.url()` (P10, CR 2026-08-15): a malformed base URL must be rejected at
   * the schema boundary instead of exploding at URL-build time inside the
   * handlers.
   */
  apiBaseUrl: z.string().trim().min(1).url(),
  searchKind: wikiSearchKindSchema,
  /** Site's api.php is fully accessible (mirror-grade) — enables the degraded `api.php?action=parse` read path. */
  fulltextOnMirror: z.boolean().optional(),
});

export type WikiSiteOverride = z.infer<typeof wikiSiteOverrideSchema>;

// ── Story 3.6 WP4: search-engine chain config (R2 / design D9) ──

/**
 * Known engine ids the chain executor can dispatch on. NOT a closed enum on
 * `engineOrder` (open strings, unknown ids silently skipped at adapter-build
 * time) — a stale/future id in a persisted sidecar must not brick the whole
 * config into schema-degrade-to-default.
 */
export const SEARCH_ENGINE_IDS = [
  'searxng-local',
  'searxng',
  'bing',
  'baidu',
  'ddg',
  'tavily',
  'bocha',
  'anysearch',
] as const;
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];

/**
 * Default chain order (D9): probed localhost SearXNG first (when a local
 * instance answers, it aggregates more engines than any single site), then the
 * zero-key HTML chain. `searxng-local` only materializes when the startup probe
 * hits; `ddg` is the overseas fallback (unreachable from mainland networks —
 * fails are silently skipped by the chain).
 */
export const DEFAULT_SEARCH_ENGINE_ORDER: readonly string[] = ['searxng-local', 'bing', 'baidu', 'ddg'];

/**
 * Search-engine chain config (persisted as the `search-config.yaml` sidecar in
 * configIpc's model dir, mirror of `research-net.yaml`).
 *
 * Optional arrays carry the two-state contract (`.min(1)` rejects a meaning-
 * less empty `[]`, spec core/interface-contracts) — absence = "not configured".
 * `anysearchApiKey` is OPTIONAL: AnySearch answers anonymously at a lower
 * quota (anysearch-and-serp-libs-survey §1.3), so the engine activates with or
 * without a key once listed in engineOrder.
 */
export const searchConfigSchema = z.object({
  /** Engine ids in priority order. Unknown ids are skipped at adapter-build time. */
  engineOrder: z.array(z.string().min(1)).min(1).optional(),
  /** User-configured SearXNG instance base URLs (instance must enable the json format). */
  searxngUrls: z.array(z.string().trim().min(1)).min(1).optional(),
  /** Probe http://127.0.0.1:8888 (2s) when building the chain; a hit injects `searxng-local` first. Default true. */
  searxngLocalhostProbe: z.boolean().default(true),
  tavilyApiKey: z.string().trim().min(1).optional(),
  bochaApiKey: z.string().trim().min(1).optional(),
  /** Optional — anonymous access works (lower quota). */
  anysearchApiKey: z.string().trim().min(1).optional(),
  /** Custom user wiki sites (D14「预设只读+自定义增删」) merged after the presets by loadWikiSites. */
  wikiSitesOverrides: z.array(wikiSiteOverrideSchema).min(1).optional(),
});

export type SearchConfig = z.infer<typeof searchConfigSchema>;

/** Fresh-install default: probe localhost SearXNG + the zero-key HTML chain. */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = { searxngLocalhostProbe: true };

// ── Story 3.6 WP6: document-parser endpoint config (R10 / design D11) ──

/** Endpoint kind. mineru = mineru-api FastAPI; docling = docling-serve; custom = Closure thin protocol. */
export const docParserKindSchema = z.enum(['mineru', 'docling', 'custom']);
export type DocParserKind = z.infer<typeof docParserKindSchema>;

/**
 * Document-parser endpoint config (persisted as the `doc-parser.yaml` sidecar
 * in configIpc's model dir, mirror of `search-config.yaml`).
 *
 * BOTH fields absent = not configured → the builtin fallback parses locally
 * (pdfjs text layer / mammoth docx / direct read, design D11). Top-level refine
 * keeps the pair all-or-nothing: `type` without `baseUrl` cannot be probed or
 * called, and a bare `baseUrl` has no defined adapter (the probe + adapters
 * dispatch on `type`) — rejecting the half-config at the schema boundary beats
 * guessing at read time.
 */
export const docParserConfigSchema = z
  .object({
    /** Endpoint kind. Absent (+ no baseUrl) = not configured → builtin fallback. */
    type: docParserKindSchema.optional(),
    /** Endpoint base URL, e.g. `http://127.0.0.1:8000`. Required when type is set. */
    baseUrl: z.string().url().optional(),
  })
  .refine((v) => (v.type === undefined) === (v.baseUrl === undefined), {
    message: 'docParser 配置须 type 与 baseUrl 成对出现（两者都空=未配置，走内置解析兜底；type 定了 baseUrl 必填）',
    path: ['baseUrl'],
  });

export type DocParserConfig = z.infer<typeof docParserConfigSchema>;

/** Fresh-install default: no endpoint → builtin fallback parsing. */
export const DEFAULT_DOC_PARSER_CONFIG: DocParserConfig = {};

// ── Story 3.6 WP10: settings-page IPC contracts (design D14) ──
//
// One aggregate read (`research:load-config`) + one aggregate write
// (`research:save-config`) mirror how `config:load-model` / `config:save-model`
// cover the whole ModelConfig incl. its sidecars. API keys are REDACTED on the
// load path (`''` + `*Set` booleans) and the save path treats an empty/missing
// key as "keep the persisted one" — the writeModelConfig redact sentinel.
//
// `DocParserProbeResult` / `VisionCanaryResult` below are the IPC mirrors of the
// shell-side producer types (`research/docParserConfig.ts` / `research/
// visionAnalysis.ts`); researchConfigIpc annotates its handler returns with
// these so a drift in either producer fails typecheck at the wiring point.

/**
 * Save payload for `research:save-config`. `search` keys are a THREE-state
 * sentinel (P6, CR 2026-08-15): `null` = explicit CLEAR (delete the persisted
 * key), `''`/undefined = keep the persisted one (the writeModelConfig redact
 * sentinel — the renderer never echoes key material back), a non-empty string
 * = set/replace.
 */
export const researchConfigSaveKeySchema = z.union([z.string(), z.null()]);

export const researchConfigSaveSchema = z.object({
  net: researchNetConfigSchema,
  search: z.object({
    engineOrder: z.array(z.string().min(1)).min(1).optional(),
    searxngUrls: z.array(z.string().trim().min(1)).min(1).optional(),
    searxngLocalhostProbe: z.boolean(),
    wikiSitesOverrides: z.array(wikiSiteOverrideSchema).min(1).optional(),
    /** null = explicit clear; '' / undefined = keep the persisted key. */
    tavilyApiKey: researchConfigSaveKeySchema.optional(),
    bochaApiKey: researchConfigSaveKeySchema.optional(),
    anysearchApiKey: researchConfigSaveKeySchema.optional(),
  }),
  docParser: docParserConfigSchema,
});

export type ResearchConfigSave = z.infer<typeof researchConfigSaveSchema>;

/**
 * Load result for `research:load-config`. API keys always come back `''`
 * (redacted); the `*Set` booleans tell the settings page whether a key exists
 * so the password inputs can show a「已配置」placeholder without echoing secrets.
 */
export interface ResearchConfigView {
  net: ResearchNetConfig;
  search: {
    engineOrder?: string[];
    searxngUrls?: string[];
    searxngLocalhostProbe: boolean;
    wikiSitesOverrides?: WikiSiteOverride[];
    tavilyApiKey: string;
    bochaApiKey: string;
    anysearchApiKey: string;
    tavilyApiKeySet: boolean;
    bochaApiKeySet: boolean;
    anysearchApiKeySet: boolean;
  };
  docParser: DocParserConfig;
  /** Read-only wiki presets (D14「预设只读」) for the settings display. */
  wikiPresets: WikiSiteOverride[];
}

/** Health-probe outcome for the configured doc-parser endpoint (`GET {base}/health`). */
export interface DocParserProbeResult {
  ok: boolean;
  /** Echo of the configured kind — present only when a config exists. */
  kind?: DocParserKind;
  /** Failure detail (settings-page health lamp / degrade note). */
  detail?: string;
}

/**
 * Vision-model canary probe verdict (D4 known-answer image → silent-strip
 * detection). `ok:true` = the model read the embedded character; reason
 * `silent-strip` = the call succeeded but the image was almost surely stripped.
 */
export type VisionCanaryResult =
  | { ok: true; answer: string }
  | { ok: false; reason: 'resolve-failed' | 'generate-failed' | 'silent-strip'; message: string };
