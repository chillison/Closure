/**
 * Setting-md Watcher - watches the active project directory for `settings/*.md`
 * changes and triggers an incremental `reindexAllSettingMd` so long-form setting
 * prose edits land in `closure_*` without an app restart (Story 2.3, design
 * §3.1).
 *
 * Mirror of `assetCardsWatcher.ts` + `craftKbWatcher.ts`:
 * - Recursive `fs.watch` on the project DIRECTORY (NOT a single file, and NOT the
 *   `settings/` subdir alone - `saveProject` / atomic writes use `atomicWriteFileSync`
 *   whose atomic rename breaks single-file watch; mirror assetCardsWatcher's
 *   directory-listen approach). The `shouldReact` filter reacts ONLY to `.md`
 *   changes under `settings/`, so the project dir's high churn (chapter autosaves,
 *   image drops, .orison/ history) does not spam a reindex. Watching the project
 *   dir (rather than `settings/` directly) also catches a `settings/` dir CREATED
 *   mid-session without needing to pre-create an empty dir in every project.
 * - Debounce ~500ms (coalesce rapid saves).
 * - Linux recursive watch unsupported -> degrade to the open-project backfill scan
 *   + manual rebuild IPC (mirror projectWatcher / craftKbWatcher / assetCardsWatcher).
 *
 * Deliberately NO self-write suppression (mirror assetCardsWatcher + craftKbWatcher):
 * the indexer writes to `closure_*` SQLite tables ONLY, NEVER to `settings/*.md`,
 * so every `settings/*.md` change - including the app's own writes - is a genuine
 * reindex-worthy event.
 *
 * 🔑 Same lifecycle as `assetCardsWatcher`: started alongside it in `project:watch`
 * (project open), stopped in `project:unwatch` (project close/switch) + `will-quit`
 * (app quit) so no fs watcher / timer outlives the active project / the process
 * (mirror 2.7 BMad CR F-patch: watcher leak guard).
 */
import path from 'node:path';
import { watchDir, type DirWatcher } from '../fs/watchFactory';
import { assertSafePath } from '../ipc/pathGuard';
import { reindexAllSettingMd } from './settingMdIndexer';
import { getLogger } from '../logger';

let activeWatcher: DirWatcher | null = null;
let activeProjectDir: string | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

/** Coalesce rapid saves (editor bursts) into one reindex. */
const DEBOUNCE_MS = 500;

/**
 * Decide whether a watcher event should trigger a reindex. The project directory
 * has high file activity (chapter autosaves, image drops, .orison/ history), so
 * reacting to every event would spam `listSettingMdFiles` + orphan-enumerate on
 * unrelated churn - react ONLY to a `.md` change UNDER `settings/`.
 *
 * - Normalize backslashes for Windows before the prefix check (recursive watch
 *   reports filenames relative to the watched dir; `\`-separated relative paths
 *   must match the same as `/`-separated ones). A nested doc
 *   (`settings/magic/system.md`) also matches the `settings/` prefix.
 * - Mirror assetCardsWatcher F7 (EDGE-3): a null filename (some platforms omit it
 *   on rename events) is treated as a potential `settings/*.md` save -> trigger a
 *   reindex. fs.watch is inconsistent across platforms, and a null event could be
 *   the only signal for an atomicWriteFileSync rename. Conservative: trigger +
 *   let the content-hash skip make the redundant scan cheap.
 */
function shouldReact(filename: string | null): boolean {
  if (filename === null) return true;
  const normalized = filename.replace(/\\/g, '/');
  return normalized.startsWith('settings/') && normalized.toLowerCase().endsWith('.md');
}

function scheduleReindex(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const projectDir = activeProjectDir;
    if (!projectDir) return;
    // Fire-and-forget: reindex does async embeds (slow) and must not block the
    // watcher loop. Per-doc failures are logged + skipped inside the scan. The
    // trailing .catch is belt-and-suspenders so no unhandled rejection escapes.
    void reindexAllSettingMd(projectDir).catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectDir },
        'setting_md watcher: debounced reindex failed - continuing',
      );
    });
  }, DEBOUNCE_MS);
}

/**
 * Start watching `projectDir` for `settings/*.md` changes (recursive). Idempotent
 * - a second call while a watcher is live first stops the prior one (a project
 * switch re-points the watcher at the new project, mirror assetCardsWatcher's
 * single-active-watch contract). An unsupported platform (Linux recursive watch)
 * or transient failure degrades to the open-project backfill scan + manual
 * rebuild IPC rather than crashing.
 */
export function startSettingMdWatcher(projectDir: string): void {
  assertSafePath(projectDir);
  const resolved = path.resolve(projectDir);
  if (activeProjectDir === resolved && activeWatcher) return;

  stopSettingMdWatcher();

  try {
    activeWatcher = watchDir(resolved, (_event, filename) => {
      const name = typeof filename === 'string' ? filename : null;
      if (!shouldReact(name)) return;
      scheduleReindex();
    });
    activeProjectDir = resolved;
    activeWatcher.on('error', (err) => {
      getLogger().warn(
        { projectDir: resolved, err: err instanceof Error ? err.message : String(err) },
        'setting_md watcher error',
      );
      stopSettingMdWatcher();
    });
    getLogger().info({ projectDir: resolved }, 'setting_md watcher started');
  } catch (err) {
    // Recursive watch unsupported (e.g. Linux) or transient failure: degrade to
    // the open-project backfill scan + manual rebuild IPC rather than crashing.
    getLogger().warn(
      { projectDir: resolved, err: err instanceof Error ? err.message : String(err) },
      'setting_md watcher unavailable - backfill scan + manual rebuild still work',
    );
    activeWatcher = null;
    activeProjectDir = null;
  }
}

/**
 * Stop watching + clear any pending debounced reindex. Safe to call when no
 * watcher is active. Called on project close/switch (alongside
 * `stopAssetCardsWatcher` / `unwatchProject`) and on app quit so no fs watcher /
 * timer outlives the active project / the process.
 */
export function stopSettingMdWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (activeWatcher) {
    try {
      activeWatcher.close();
    } catch {
      // ignore close errors
    }
    activeWatcher = null;
    activeProjectDir = null;
  }
}
