import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

/**
 * Artifacts helpers (R4 / design §3.4).
 *
 * Every e2e run writes to `docs/tests/<YYYY-MM-DD>-<story>/` (gitignored at the
 * repo root). Each step captures a screenshot; planning / chapter steps also
 * snapshot `project.yaml` and chapter files; a `run.log` records the step
 * timeline + findings. All fs ops are guarded (try/catch) so an artifact
 * failure never crashes the test - it is logged and the run continues.
 */

const here = dirname(fileURLToPath(import.meta.url));
// src/artifacts.ts -> src -> e2e -> desktop -> apps -> repo root (4 up)
const REPO_ROOT = resolve(here, '..', '..', '..', '..');

function warn(msg: string): void {
  console.warn(`[artifacts] ${msg}`);
}

/**
 * Resolve (and create) the artifacts dir for a run: `docs/tests/<today>-<story>/`.
 * `story` is the Story slug (e.g. "narrative-timeline-ui"); the date is today.
 */
export function artifactsDirFor(story: string): string {
  // Local YYYY-MM-DD (BMad CR L7): toISOString() is UTC, which would file a
  // post-midnight run under "yesterday" for non-UTC users.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dir = resolve(REPO_ROOT, 'docs', 'tests', `${today}-${story}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Screenshot the window to `<step>.png` in the artifacts dir. Guarded: a
 * screenshot failure (e.g. window closed) is logged, not thrown.
 */
export async function screenshot(window: Page, step: string, artifactsDir: string): Promise<void> {
  try {
    mkdirSync(artifactsDir, { recursive: true });
    const path = resolve(artifactsDir, `${step}.png`);
    await window.screenshot({ path });
  } catch (e) {
    warn(`screenshot failed for step "${step}": ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Copy `project.yaml` -> `<step>.yaml` in the artifacts dir (no-op if the
 * project file does not exist yet, e.g. before project creation). Guarded.
 */
export function snapshotYaml(projectPath: string, step: string, artifactsDir: string): void {
  try {
    if (!existsSync(projectPath)) return;
    mkdirSync(artifactsDir, { recursive: true });
    copyFileSync(projectPath, resolve(artifactsDir, `${step}.yaml`));
  } catch (e) {
    warn(`snapshotYaml failed for step "${step}": ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Copy a chapter file -> `<step>-<basename>` in the artifacts dir (no-op if the
 * chapter file does not exist). Guarded.
 */
export function snapshotChapter(chapterPath: string, step: string, artifactsDir: string): void {
  try {
    if (!existsSync(chapterPath)) return;
    mkdirSync(artifactsDir, { recursive: true });
    const dest = resolve(artifactsDir, `${step}-${basename(chapterPath)}`);
    copyFileSync(chapterPath, dest);
  } catch (e) {
    warn(`snapshotChapter failed for step "${step}": ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Append a timestamped line to `run.log` in the artifacts dir (timeline of
 * steps + findings). Guarded.
 */
export function writeLog(artifactsDir: string, msg: string): void {
  try {
    mkdirSync(artifactsDir, { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(resolve(artifactsDir, 'run.log'), `[${ts}] ${msg}\n`, 'utf-8');
  } catch (e) {
    warn(`writeLog failed: ${e instanceof Error ? e.message : e}`);
  }
}
