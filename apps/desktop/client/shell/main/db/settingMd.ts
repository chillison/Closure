import yaml from 'js-yaml';

/**
 * Pure markdown-frontmatter parser for per-project long-form setting prose
 * (Story 2.3, design §3.1).
 *
 * Setting prose docs are markdown + YAML frontmatter (Obsidian-style,
 * user-editable), living at `<project>/settings/*.md`:
 *
 *   ---
 *   id: magic-system                # stable settingId (defaults to filename slug)
 *   type: magic_system              # open string (magic_system/faction/...)
 *   tags: [魔法, 代价]              # orthogonal facets
 *   linked_entities: [char-protag]  # related asset_card ids (retrieval boosting)
 *   source: 用户笔记                 # provenance
 *   summary: 以代价驱动的硬魔法体系   # one-line curated summary (Story 8.7 R2)
 *   ---
 *   # 魔法体系
 *   （长 form prose 正文）
 *
 * Kept pure (no fs / no db) so it is unit-testable under plain vitest and
 * importable by both `settingMdPaths.ts` (scan) and `settingMdIndexer.ts`
 * (reindex) without a cycle. `js-yaml` is already a shell dependency (mirror
 * craftMd.ts); it handles flow sequences, quotes, and CJK values a flat parser
 * cannot.
 *
 * Mirror of `craftMd.ts` (CR-craft-kb-004 BOM/whitespace tolerance, malformed
 * -> degrade not drop, CR-craft-kb-007 empty-id guard). Differences from craft:
 * `type` (open string) instead of `craft_type`; adds `linked_entities` (string[]
 * of related asset_card ids for retrieval relevance boosting - parsed + hashed
 * here, the boosting consumer is downstream retrieval).
 */

export type SettingFrontmatter = {
  id?: string;
  type?: string;
  tags?: string[];
  linked_entities?: string[];
  source?: string;
  /** One-line curated summary (Story 8.7 R2). Optional - passthrough parse only;
   *  the indexer consuming it (summary_text column + hashPayload) is Story 8.7 S4. */
  summary?: string;
};

export type ParsedSettingMd = {
  frontmatter: SettingFrontmatter;
  body: string;
};

// U+FEFF (UTF-8 BOM) as a char code (mirror craftMd.ts - avoids eslint's
// no-irregular-whitespace flagging a literal BOM in source).
const BOM_CHAR_CODE = 0xfeff;

/**
 * Parse the leading `---\n...\n---` frontmatter block. A doc with no frontmatter
 * (or malformed YAML) returns `{ frontmatter: {}, body: <full content> }` - the
 * doc is still indexable as `type=uncategorized` with the filename as settingId
 * (never reject a user's setting doc over a frontmatter typo - degrade, don't
 * drop). Mirror craftMd.parseCraftMd.
 */
export function parseSettingMd(content: string): ParsedSettingMd {
  // Strip a UTF-8 BOM (U+FEFF) + tolerate leading whitespace / blank lines before
  // the `---` fence (mirror craftMd CR-craft-kb-004: Windows editors save with a
  // BOM / leading blank line; an anchored `^---` would miss it -> mis-indexed).
  const bomStripped = content.charCodeAt(0) === BOM_CHAR_CODE ? content.slice(1) : content;
  const fenceMatch = bomStripped.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fenceMatch) return { frontmatter: {}, body: bomStripped };
  const [, fmRaw, body] = fenceMatch;
  let frontmatter: SettingFrontmatter = {};
  try {
    const parsed = yaml.load(fmRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = normalizeFrontmatter(parsed as Record<string, unknown>);
    }
  } catch {
    // malformed YAML frontmatter -> treat as empty (body still indexed)
  }
  return { frontmatter, body: body ?? '' };
}

function normalizeFrontmatter(raw: Record<string, unknown>): SettingFrontmatter {
  const fm: SettingFrontmatter = {};
  const id = raw.id;
  if (typeof id === 'string' && id.trim()) fm.id = id.trim();
  const type = raw.type;
  if (typeof type === 'string' && type.trim()) fm.type = type.trim();
  const source = raw.source;
  if (typeof source === 'string' && source.trim()) fm.source = source.trim();
  const summary = raw.summary;
  if (typeof summary === 'string' && summary.trim()) fm.summary = summary.trim();
  const tags = raw.tags;
  if (Array.isArray(tags)) {
    const strs = tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim());
    if (strs.length > 0) fm.tags = strs;
  } else if (typeof tags === 'string' && tags.trim()) {
    // tolerate a comma/sep string: `tags: a, b`
    fm.tags = tags.split(/[，,]/).map((t) => t.trim()).filter(Boolean);
  }
  const linked = raw.linked_entities;
  if (Array.isArray(linked)) {
    const strs = linked.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim());
    if (strs.length > 0) fm.linked_entities = strs;
  } else if (typeof linked === 'string' && linked.trim()) {
    // tolerate a comma/sep string: `linked_entities: char-a, char-b`
    fm.linked_entities = linked.split(/[，,]/).map((t) => t.trim()).filter(Boolean);
  }
  return fm;
}

/**
 * Extract the doc's display name: the first level-1 heading (`# Foo`) in the
 * body. Returns null when no H1 is present (caller falls back to settingId).
 * Mirror craftMd.extractCraftName. Exported for unit testing.
 */
export function extractSettingName(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Derive the stable settingId: frontmatter `id` wins, else the filename without
 * the `.md` extension. The settingId is namespaced into `entry_id` as
 * `${projectId}:${settingId}` by the indexer (avoids the cross-project PK
 * collision risk Story 2.7's raw card.id has - design §6). Exported for unit
 * testing + reuse by the path scanner.
 *
 * Mirror craftMd.deriveCraftId (CR-craft-kb-007): returns the EMPTY string when
 * the derived id is empty / whitespace-only (a `.md` filename, or a
 * whitespace-only frontmatter `id`). Callers (scan path / indexer) MUST guard:
 * skip + warn when the return is empty (don't index a setting with no stable id).
 */
export function deriveSettingId(fileName: string, fm: SettingFrontmatter): string {
  if (fm.id && fm.id.trim()) return fm.id.trim();
  // trim the filename-derived slug; a `.md` file derives to ''.
  return fileName.replace(/\.md$/i, '').trim();
}
