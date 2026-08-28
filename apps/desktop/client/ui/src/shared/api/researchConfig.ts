/**
 * Research settings API shell (Story 3.6 WP10). Mirrors `shared/api/kbIndex.ts`
 * — every IPC call goes through `window.orisonDesktop` here, never directly
 * from a component (spec/ui/module-structure invariant: IPC 走 shared/api).
 *
 * - `fetchResearchConfig`: aggregate read (net proxy + search chain with
 *   REDACTED keys + doc parser + wiki presets) for the「研究与视觉」page.
 * - `saveResearchConfig`: aggregate write; REJECTS on schema violations so the
 *   caller can toast the Zod message (e.g. custom proxy without proxyUrl).
 * - `probeDocParserEndpoint` / `canaryProbeVisionModel`: settings-page test
 *   buttons (health lamp / silent-strip canary). Return null when the bridge is
 *   absent (tests / non-electron) — callers degrade gracefully.
 */
import type {
  DocParserProbeResult,
  ModelRef,
  ResearchConfigSave,
  ResearchConfigView,
  VisionCanaryResult,
} from '@orison/shared-contracts';

/** Read the preload bridge at call time (not module load) so tests that install
 *  a fake `window.orisonDesktop` per-case see it. Mirrors how slices access it. */
function api() {
  return window.orisonDesktop;
}

export async function fetchResearchConfig(): Promise<ResearchConfigView | null> {
  try {
    return (await api()?.loadResearchConfig()) ?? null;
  } catch {
    return null;
  }
}

export async function saveResearchConfig(config: ResearchConfigSave): Promise<void> {
  await api()?.saveResearchConfig(config);
}

export async function probeDocParserEndpoint(): Promise<DocParserProbeResult | null> {
  try {
    return (await api()?.probeResearchDocParser()) ?? null;
  } catch {
    return null;
  }
}

export async function canaryProbeVisionModel(ref: ModelRef): Promise<VisionCanaryResult | null> {
  try {
    return (await api()?.canaryProbeVision(ref)) ?? null;
  } catch {
    return null;
  }
}
