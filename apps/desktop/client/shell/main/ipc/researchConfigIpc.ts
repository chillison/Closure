/**
 * Research settings IPC (Story 3.6 WP10, design D14).
 *
 * Pure wiring — the business logic lives in the research/ sidecar modules this
 * file calls (readSearchConfig / readResearchNetConfig / readDocParserConfig /
 * probeDocParser / canaryProbeVision). Channels:
 *
 *   research:load-config      aggregate read; API keys REDACTED to '' + `*Set`
 *                             booleans (the renderer must never see secrets —
 *                             mirror of redactModelConfig).
 *   research:save-config      aggregate write; '' / undefined keys keep the
 *                             persisted ones (the writeModelConfig sentinel).
 *   research:probe-doc-parser forced health probe (settings-page「测试连接」).
 *   research:canary-vision    known-answer image probe for the designated
 *                             vision model (settings-page「测试视觉探针」).
 *
 * Schema violations on save (custom proxy without proxyUrl, docParser type
 * without baseUrl, …) reject with the Zod message — invariant violations go the
 * throw route (模式 B, spec/shell/ipc-handlers).
 */
import { ipcMain } from 'electron';
import type {
  DocParserProbeResult,
  ModelRef,
  ResearchConfigSave,
  ResearchConfigView,
  VisionCanaryResult,
} from '@orison/shared-contracts';
import { researchConfigSaveSchema } from '@orison/shared-contracts';
import { readResearchNetConfig, writeResearchNetConfig } from './configIpc';
import { readDocParserConfig, writeDocParserConfig, probeDocParser } from '../research/docParserConfig';
import { readSearchConfig, writeSearchConfig, resetSearxngLocalhostProbe } from '../research/searchConfig';
import { WIKI_SITE_PRESETS } from '../research/wikiSites';
import { canaryProbeVision } from '../research/visionAnalysis';
import { researchFetchAllowlist } from './toolHandlers/fetchHandlers';
import { setResearchSessionAllowlist } from '../research/researchSession';

/**
 * Three-state key sentinel (P6, CR 2026-08-15): `null` = explicit CLEAR (the
 * persisted key is deleted — writeSearchConfig omits it from the rewritten
 * sidecar), `''`/undefined = keep the persisted one (writeModelConfig redact
 * sentinel), a non-empty string = set/replace.
 */
function resolveKey(next: string | null | undefined, existing: string | undefined): string | undefined {
  if (next === null) return undefined;
  const t = next?.trim();
  return t ? t : existing;
}

export function registerResearchConfigIpc() {
  ipcMain.handle('research:load-config', (): ResearchConfigView => {
    const search = readSearchConfig();
    return {
      net: readResearchNetConfig(),
      docParser: readDocParserConfig(),
      // Redact: the renderer shows placeholders via the *Set flags, never the
      // decrypted key material (readSearchConfig returns DECRYPTED keys).
      search: {
        engineOrder: search.engineOrder,
        searxngUrls: search.searxngUrls,
        searxngLocalhostProbe: search.searxngLocalhostProbe,
        wikiSitesOverrides: search.wikiSitesOverrides,
        tavilyApiKey: '',
        bochaApiKey: '',
        anysearchApiKey: '',
        tavilyApiKeySet: !!search.tavilyApiKey,
        bochaApiKeySet: !!search.bochaApiKey,
        anysearchApiKeySet: !!search.anysearchApiKey,
      },
      wikiPresets: WIKI_SITE_PRESETS.map((s) => ({
        id: s.id,
        name: s.name,
        apiBaseUrl: s.apiBaseUrl,
        searchKind: s.searchKind,
      })),
    };
  });

  ipcMain.handle('research:save-config', async (_, payload: ResearchConfigSave): Promise<void> => {
    const parsed = researchConfigSaveSchema.parse(payload);
    // Merge the redact-sentinel keys with the persisted config BEFORE the
    // sidecar write — a '' key from the renderer must not wipe the stored
    // one; a null key deliberately CLEARS it (P6: writeSearchConfig omits it
    // from the rewritten sidecar, deleting the field).
    const existing = readSearchConfig();
    const search = {
      engineOrder: parsed.search.engineOrder,
      searxngUrls: parsed.search.searxngUrls,
      searxngLocalhostProbe: parsed.search.searxngLocalhostProbe,
      wikiSitesOverrides: parsed.search.wikiSitesOverrides,
      tavilyApiKey: resolveKey(parsed.search.tavilyApiKey, existing.tavilyApiKey),
      bochaApiKey: resolveKey(parsed.search.bochaApiKey, existing.bochaApiKey),
      anysearchApiKey: resolveKey(parsed.search.anysearchApiKey, existing.anysearchApiKey),
    };
    writeSearchConfig(search);
    writeResearchNetConfig(parsed.net);
    writeDocParserConfig(parsed.docParser);
    // P14 (CR 2026-08-15): a fresh config invalidates the localhost probe's
    // cached verdict — the next search re-probes within seconds instead of
    // riding a stale negative for the process lifetime.
    resetSearxngLocalhostProbe();
    // Keep the research session's net-filter allowlist in sync with what was
    // just persisted (P2 — the guard trusts the configured origins).
    setResearchSessionAllowlist(researchFetchAllowlist(search, parsed.docParser));
  });

  ipcMain.handle('research:probe-doc-parser', async (): Promise<DocParserProbeResult> => {
    // force=true — the settings page probes right after a save, so the cached
    // verdict of the previous config must not shadow the fresh answer.
    return probeDocParser({ force: true });
  });

  ipcMain.handle('research:canary-vision', async (_, ref: ModelRef): Promise<VisionCanaryResult> => {
    return canaryProbeVision(ref);
  });
}
