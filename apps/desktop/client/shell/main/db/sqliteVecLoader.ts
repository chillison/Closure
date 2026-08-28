import type Database from 'better-sqlite3';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { getLoadablePath } from '@photostructure/sqlite-vec';
import { getLogger } from '../logger';

// Whether the sqlite-vec extension is loaded on the active connection.
// Downstream retrieval/indexer code will consult isSqliteVecAvailable() to
// decide whether vec0 tables are usable (graceful degradation when the binary
// cannot load — e.g. a packaging regression — which is never an "offline"
// condition; offline degradation is about the embed/rerank cloud endpoint).
let vecAvailable = false;

/**
 * Load the sqlite-vec loadable extension (@photostructure/sqlite-vec fork)
 * into the shared better-sqlite3 connection. Required before any vec0 virtual
 * table DDL/SQL is usable (KB hybrid retrieval — ADR-3 / VS1).
 *
 * Why a loadable extension, not a native addon: sqlite-vec ships as a SQLite
 * loadable extension (.dll/.dylib/.so) whose ABI contract is SQLite's, not
 * Node/Electron's. better-sqlite3 statically bundles a compatible SQLite, so
 * this adds ZERO electron-rebuild burden (it never enters pnpm
 * `onlyBuiltDependencies` / `rebuild:native`) and is loaded at runtime via
 * `db.loadExtension()`.
 *
 * Path resolution (the Electron packaging crux — research
 * `vector-engine-selection-2026-07-23.md` §1 + design §5):
 *  1. Primary — the fork's `getLoadablePath()`: resolves
 *     `dist/<platform>-<arch>/vec0.<ext>` from the package's `__dirname` and
 *     rewrites `app.asar` -> `app.asar.unpacked`, so the same call works in dev
 *     (node_modules) AND in a packaged Electron app (provided the binaries are
 *     asar-unpacked — see electron-builder.yml `asarUnpack`). The package is
 *     externalized by electron-vite (`externalizeDepsPlugin`), so `__dirname`
 *     points at the real package folder at runtime.
 *  2. Fallback — an explicit `process.resourcesPath` resolver (ResearchClaw
 *     pattern) for the edge case where `getLoadablePath()` cannot locate the
 *     binary (e.g. an unusual asar layout). Only matches a real file on disk.
 *
 * Best-effort: a load failure is logged and `isSqliteVecAvailable()` stays
 * false. The registry tables (projects/tasks/project_assets) do not depend on
 * vec0, so the rest of the db stays usable — closure-* features just disable
 * until the binary is fixed (design §7 rollback).
 *
 * Returns true if the extension is loaded (or was already loaded on this
 * connection); false if it could not be loaded.
 */
export function loadSqliteVec(db: Database.Database): boolean {
  if (vecAvailable) return true;

  const candidate = resolveExtensionPath();
  if (!candidate) {
    getLogger().warn(
      { platform: process.platform, arch: process.arch },
      'sqlite-vec: no loadable binary found for this platform — vector features disabled',
    );
    vecAvailable = false;
    return false;
  }

  try {
    db.loadExtension(candidate);
    vecAvailable = true;
    getLogger().info({ path: candidate }, 'sqlite-vec extension loaded');
    return true;
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), path: candidate },
      'sqlite-vec: loadExtension failed — vector features disabled',
    );
    vecAvailable = false;
    return false;
  }
}

/** True iff the sqlite-vec extension is loaded on the active connection. */
export function isSqliteVecAvailable(): boolean {
  return vecAvailable;
}

/**
 * Reset the loaded-state cache. Called by `closeDb()` so that a reopened
 * connection re-loads the extension instead of falsely reporting available.
 */
export function resetSqliteVecState(): void {
  vecAvailable = false;
}

function resolveExtensionPath(): string | null {
  // Primary: fork's resolver handles dev + packaged-asar-unpacked.
  try {
    const primary = getLoadablePath();
    if (primary && existsSync(primary)) return primary;
  } catch {
    // fall through to the packaged resolver
  }
  return resolvePackagedPath();
}

/**
 * Fallback resolver: build the path explicitly from process.resourcesPath.
 * Only relevant inside a packaged Electron app whose asar layout confuses the
 * fork's `__dirname`-based resolver. Returns null unless the file truly exists.
 */
function resolvePackagedPath(): string | null {
  if (!process.resourcesPath) return null;
  const ext = extensionSuffix(process.platform);
  const dir = platformDir();
  if (!ext || !dir) return null;
  const candidate = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@photostructure',
    'sqlite-vec',
    'dist',
    dir,
    `vec0.${ext}`,
  );
  return existsSync(candidate) ? candidate : null;
}

function extensionSuffix(platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return 'dll';
  if (platform === 'darwin') return 'dylib';
  if (platform === 'linux') return 'so';
  return null;
}

function platformDir(): string | null {
  if (process.platform === 'linux') {
    return isMusl() ? `linux-${process.arch}-musl` : `linux-${process.arch}`;
  }
  return `${process.platform}-${process.arch}`;
}

function isMusl(): boolean {
  try {
    return readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {
    return false;
  }
}
