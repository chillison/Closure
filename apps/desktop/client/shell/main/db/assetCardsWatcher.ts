/**
 * Asset-cards Watcher - watches the active project directory for `project.yaml`
 * changes and triggers an incremental `reindexAssetCards` so asset_cards edits land
 * in `closure_*` without an app restart (Story 2.7, design §A).
 *
 * Mirror of `craftKbWatcher.ts` + `projectWatcher.ts`:
 * - Recursive `fs.watch` on the project DIRECTORY (NOT a single file - `saveProject`
 *   uses `atomicWriteFileSync` whose atomic rename breaks single-file watch; mirror
 *   projectWatcher's directory-listen approach), filtering for `project.yaml`.
 * - Debounce ~500ms (coalesce rapid saves).
 * - Linux recursive watch unsupported -> degrade to the open-project backfill scan
 *   + manual rebuild IPC (mirror projectWatcher / craftKbWatcher).
 *
 * Deliberately NO self-write suppression (unlike projectWatcher's
 * `registerSelfWrite`): the indexer writes to `closure_*` SQLite tables ONLY,
 * NEVER to `project.yaml`, so every `project.yaml` change - including the app's own
 * `field:sync` / `field:apply-agent-patch` saves - is a genuine reindex-worthy
 * event. Hooking `projectWatcher` directly would skip the app's own field-sync saves
 * (its self-write suppression would swallow them) - the most common save path - so
 * this watcher is a separate, dedicated listener (hard constraint, design §A).
 */
import path from 'node:path';
import { watchDir, type DirWatcher } from '../fs/watchFactory';
import { assertSafePath } from '../ipc/pathGuard';
import { reindexAssetCards } from './assetCardsIndexer';
import { getLogger } from '../logger';

let activeWatcher: DirWatcher | null = null;
let activeProjectDir: string | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

/** Coalesce rapid saves (field-sync + autosave bursts) into one reindex. */
const DEBOUNCE_MS = 500;

/**
 * Decide whether a watcher event should trigger a reindex. The project directory
 * has high file activity (chapter autosaves, image drops, .orison/ history), so
 * reacting to every event would spam `loadProject` + orphan-enumerate on unrelated
 * churn - react ONLY to a `project.yaml` change.
 *
 * - F6 (BLIND-4): match the ROOT `project.yaml` only, not a nested one. Recursive
 *   watch reports filenames relative to the watched dir; a backup / template
 *   subdir's `project.yaml` would otherwise trigger a spurious reindex. The root
 *   file is the bare basename with NO path separator (normalize backslashes for
 *   Windows before the equality check, so `\`-separated relative paths are rejected
 *   the same as `/`-separated ones).
 * - F7 (EDGE-3): a null filename (some platforms omit it on rename events) is
 *   treated as a potential `project.yaml` save -> trigger a reindex. fs.watch is
 *   inconsistent across platforms, and a null event could be the only signal for
 *   the atomicWriteFileSync rename. Conservative: trigger + let the content-hash
 *   skip make the redundant scan cheap (mirror projectWatcher, whose isNoise(null)
 *   returns false so it too reacts to null events).
 */
function shouldReact(filename: string | null): boolean {
  if (filename === null) return true;
  return filename.replace(/\\/g, '/') === 'project.yaml';
}

function scheduleReindex(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const projectDir = activeProjectDir;
    if (!projectDir) return;
    // Fire-and-forget: reindex does async embeds (slow) and must not block the
    // watcher loop. Per-card failures are logged + skipped inside the scan. The
    // trailing .catch is belt-and-suspenders so no unhandled rejection escapes.
    void reindexAssetCards(projectDir).catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectDir },
        'asset_cards watcher: debounced reindex failed - continuing',
      );
    });
  }, DEBOUNCE_MS);
}

/**
 * Start watching `projectDir` for project.yaml changes (recursive). Idempotent - a
 * second call while a watcher is live first stops the prior one (a project switch
 * re-points the watcher at the new project, mirror projectWatcher's single-active-
 * watch contract). An unsupported platform (Linux recursive watch) or transient
 * failure degrades to the open-project backfill scan + manual rebuild IPC rather
 * than crashing.
 */
export function startAssetCardsWatcher(projectDir: string): void {
  assertSafePath(projectDir);
  const resolved = path.resolve(projectDir);
  if (activeProjectDir === resolved && activeWatcher) return;

  stopAssetCardsWatcher();

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
        'asset_cards watcher error',
      );
      stopAssetCardsWatcher();
    });
    getLogger().info({ projectDir: resolved }, 'asset_cards watcher started');
  } catch (err) {
    // Recursive watch unsupported (e.g. Linux) or transient failure: degrade to
    // the open-project backfill scan + manual rebuild IPC rather than crashing.
    getLogger().warn(
      { projectDir: resolved, err: err instanceof Error ? err.message : String(err) },
      'asset_cards watcher unavailable - backfill scan + manual rebuild still work',
    );
    activeWatcher = null;
    activeProjectDir = null;
  }
}

/**
 * Stop watching + clear any pending debounced reindex. Safe to call when no watcher
 * is active. Called on project close/switch (alongside `unwatchProject`) and on app
 * quit so no fs watcher / timer outlives the active project / the process.
 */
export function stopAssetCardsWatcher(): void {
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
