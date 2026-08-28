/**
 * C1.2 lint IPC shell（llmlint 全稿扫描 / 语境判断 / 机械修复应用）。Mirror
 * `shared/api/kbIndex.ts` — every IPC call goes through `window.orisonDesktop`
 * here, never directly from a component or slice（spec/ui/module-structure
 * invariant：IPC 走 shared/api）。
 */
import type {
  LintApplyFixResult,
  LintClassifyResult,
  LintFixPatch,
  LintModelProbeResult,
  LintScanFullResult,
} from '@orison/shared-contracts';

/** Read the preload bridge at call time (not module load) so tests that install
 *  a fake `window.orisonDesktop` per-case see it. Mirrors how slices access it. */
function api() {
  return window.orisonDesktop;
}

export async function lintScanFull(projectPath: string): Promise<LintScanFullResult | null> {
  return (await api()?.lintScanFull({ projectPath })) ?? null;
}

export async function lintClassify(projectPath: string): Promise<LintClassifyResult | null> {
  return (await api()?.lintClassify({ projectPath })) ?? null;
}

export async function lintApplyFix(
  projectPath: string,
  patches: LintFixPatch[],
): Promise<LintApplyFixResult | null> {
  return (await api()?.lintApplyFix({ projectPath, patches })) ?? null;
}

/** CR-014：judge-model resolvability probe（shell 单源——review-judge 档解析 + default 哨兵）。 */
export async function lintModelProbe(): Promise<LintModelProbeResult | null> {
  return (await api()?.lintModelProbe()) ?? null;
}
