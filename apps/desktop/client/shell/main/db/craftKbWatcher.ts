/**
 * Craft KB Watcher — watches `~/.orison/craft-kb/` for filesystem changes and
 * triggers an incremental reindex so user edits / additions / deletions land in
 * `closure_craft_*` without an app restart (Story 2.1, design §4).
 *
 * Mirror of `projectWatcher.ts`: recursive `fs.watch` (Windows + macOS native;
 * Linux degrades to the startup scan + manual rebuild IPC), debounce, app-quit
 * cleanup. ONLY the writable user dir is watched — the bundled seed dir is
 * read-only (`process.resourcesPath`), so there is nothing to observe there.
 *
 * No self-write suppression: the indexer writes to `closure_craft_*` tables only
 * (NEVER to craft-kb md files), so every watcher event is a genuine user / editor
 * change worth reindexing (unlike projectWatcher, which must skip the app's own
 * saves). Debounced to coalesce rapid editor saves into one scan.
 */
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { getCraftKbUserDir } from './craftKbPaths';
import { scanAndReindexCraftKb } from './closureCraftIndexer';
import { getLogger } from '../logger';

let activeWatcher: FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

/** Coalesce rapid editor saves (multi-file paste, find-replace) into one scan. */
const DEBOUNCE_MS = 500;

/**
 * Decide whether a watcher event should trigger a reindex. Returns true for any
 * `.md` change (the scan is idempotent + content-hash-skips unchanged docs, so a
 * false-positive is cheap) and for events where the filename is unavailable
 * (some platforms omit it — trigger a full scan to be safe). Skips `node_modules`
 * and non-`.md` siblings (editor swap files like `4913`, images, etc.).
 */
function shouldReact(filename: string | null): boolean {
  if (filename === null) return true; // filename unavailable — full scan
  const segments = filename.split(/[/\\]/);
  if (segments.some((seg) => seg === 'node_modules')) return false;
  return filename.toLowerCase().endsWith('.md');
}

function scheduleReindex(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Fire-and-forget: craft reindex does async embeds (slow) and must not block
    // the watcher loop. Best-effort: per-doc failures are logged + skipped inside
    // the scan. The trailing .catch is belt-and-suspenders against an unexpected
    // throw so no unhandled rejection escapes.
    void scanAndReindexCraftKb().catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'craft KB watcher: debounced reindex failed - continuing',
      );
    });
  }, DEBOUNCE_MS);
}

/**
 * Start watching the user craft KB dir (recursive). Idempotent — a second call
 * while a watcher is live is a no-op. If the dir is absent it is created (empty,
 * harmless) so the watcher can pick up future user additions; a mkdir failure or
 * an unsupported platform (Linux recursive watch) degrades to the startup scan +
 * manual rebuild IPC rather than crashing.
 */
export function startCraftKbWatcher(): void {
  if (activeWatcher) return;
  const dir = getCraftKbUserDir();
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), dir },
        'craft KB watcher: cannot create user dir - skipping watch',
      );
      return;
    }
  }
  try {
    activeWatcher = watch(dir, { recursive: true }, (_event, filename) => {
      const name = typeof filename === 'string' ? filename : null;
      if (!shouldReact(name)) return;
      scheduleReindex();
    });
    activeWatcher.on('error', (err) => {
      getLogger().warn({ dir, err: err instanceof Error ? err.message : String(err) }, 'craft KB watcher error');
      stopCraftKbWatcher();
    });
    getLogger().info({ dir }, 'craft KB watcher started');
  } catch (err) {
    // Recursive watch unsupported (e.g. Linux) or transient failure: degrade to
    // the startup scan + manual rebuild IPC rather than crashing.
    getLogger().warn(
      { dir, err: err instanceof Error ? err.message : String(err) },
      'craft KB watcher unavailable - startup scan + manual rebuild still work',
    );
    activeWatcher = null;
  }
}

/**
 * Stop watching + clear any pending debounced reindex. Safe to call when no
 * watcher is active. Called on app quit (alongside closeDb) so no fs watcher /
 * timer outlives the process.
 */
export function stopCraftKbWatcher(): void {
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
  }
}
