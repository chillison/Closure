import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { deriveSettingId, parseSettingMd } from './settingMd';
import { getLogger } from '../logger';

/**
 * Per-project long-form setting prose file-system enumeration (Story 2.3, design
 * §3.1). Mirrors `craftKbPaths.ts` but PROJECT-SCOPED: the docs live at
 * `<project>/settings/*.md` (a new per-project directory convention, sibling of
 * `chapters/`), NOT under a global `~/.orison/` dir. There is no bundled seed
 * dir + no user-override merge (the project dir IS the single source).
 *
 * Returns `{filePath, settingId, projectDir}[]` for the indexer. Recursive
 * (mirror craftKbPaths CR-craft-kb-003) so docs organized in subfolders
 * (`settings/magic/system.md`) are indexed too. A `.md` file with no frontmatter
 * `id` derives its settingId from the filename. Files that cannot be read/parsed
 * are logged + skipped (never throw - one bad doc must not brick the scan).
 *
 * CR-craft-kb-007 (mirrored): a doc whose derived settingId is empty/whitespace
 * (a file named `.md`, or a whitespace-only frontmatter `id`) is skipped + warned
 * - an empty settingId would collide with every other empty-id doc within the
 * namespaced `entry_id` (`${projectId}:`), so it must never reach the index.
 */

export type SettingMdFile = {
  filePath: string;
  settingId: string;
  projectDir: string;
};

/**
 * Recursively enumerate `.md` setting docs under `{projectDir}/settings/`.
 * Returns [] when the `settings/` dir is absent (a project with no long-form
 * setting prose - the common case) or unreadable (never throw - mirror
 * craftKbPaths.listMdFilesIn). The caller (indexer) treats [] as "nothing to
 * index" + orphan cleanup of stale setting_md rows for the project.
 */
export function listSettingMdFiles(projectDir: string): SettingMdFile[] {
  const settingsDir = path.join(projectDir, 'settings');
  // Dedup by settingId (mirror craftKbPaths.listCraftMdFiles, BMad CR E1). Two docs
  // deriving the same settingId (e.g. settings/magic/system.md + settings/lore/
  // system.md, both filename-slug-derived with no frontmatter id) would upsert the
  // same namespaced entry_id -> the second silently clobbers the first's body/
  // vector + inflates `reindexed`. Keep the first encountered, warn on drop so the
  // user can rename one or add a frontmatter `id`.
  const bySettingId = new Map<string, SettingMdFile>();
  for (const filePath of listMdFilesIn(settingsDir)) {
    const parsed = safeReadAndParse(filePath);
    if (!parsed) continue;
    const prev = bySettingId.get(parsed.settingId);
    if (prev) {
      getLogger().warn(
        { settingId: parsed.settingId, kept: prev.filePath, dropped: filePath },
        'setting_md: duplicate settingId in project - dropping later file (rename or add frontmatter id)',
      );
      continue;
    }
    bySettingId.set(parsed.settingId, { filePath, settingId: parsed.settingId, projectDir });
  }
  return [...bySettingId.values()];
}

/**
 * Recursively enumerate `.md` files under `dir` (mirror craftKbPaths
 * CR-craft-kb-003). Subdirectories are descended into so docs organized in
 * folders are indexed. Returns [] when the dir is absent / unreadable (never
 * throw - one bad dir must not brick the scan).
 */
function listMdFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), dir },
      'setting_md: cannot read settings directory - skipping',
    );
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      // stat failed (broken symlink / race) - skip this entry.
      continue;
    }
    if (isDir) {
      // Recurse into subdirectories (depth unbounded - mirror craftKbPaths; the
      // settings dir is small + user-curated, readdirSync does not follow
      // symlinks for the recursion target itself).
      out.push(...listMdFilesIn(full));
    } else if (isFile && entry.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function safeReadAndParse(filePath: string): { settingId: string } | null {
  try {
    // Defer the full fs read to the indexer (avoid a double read in production);
    // here we only need the settingId for the scan. Read once - the indexer
    // re-reads, but setting docs are small + few and the scan runs rarely
    // (project open / rebuild). Mirror craftKbPaths.safeReadAndParse.
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter } = parseSettingMd(content);
    const settingId = deriveSettingId(path.basename(filePath), frontmatter);
    // CR-craft-kb-007: empty / whitespace settingId is namespaced into
    // `${projectId}:` but the suffix would still be empty, colliding with every
    // other empty-id doc in the project - skip + warn.
    if (!settingId) {
      getLogger().warn(
        { filePath },
        'setting_md: doc derives to an empty settingId (filename + frontmatter id both empty) - skipping',
      );
      return null;
    }
    return { settingId };
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), filePath },
      'setting_md: cannot parse file - skipping',
    );
    return null;
  }
}
