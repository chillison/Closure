import yaml from 'js-yaml';

/**
 * Pure markdown-frontmatter parser for craft KB docs (Story 2.1).
 *
 * Craft docs are markdown + YAML frontmatter (Obsidian-style, user-editable):
 *
 *   ---
 *   id: shuangdian-catalog          # stable craft_id (defaults to filename slug)
 *   craft_type: shuangdian          # 8-class taxonomy + uncategorized (open string)
 *   tags: [网文, 爽点, 先抑后扬]     # orthogonal facets (genre/component links)
 *   source: wj-stup+本地笔记         # curation provenance
 *   summary: 爽点先抑后扬的节奏手册   # one-line curated summary (Story 8.7 R2)
 *   ---
 *   # 正文（craft 模式内容）
 *
 * Kept pure (no fs / no db) so it is unit-testable under plain vitest and
 * importable by both `craftKbPaths.ts` (scan/dedup) and `closureCraftIndexer.ts`
 * (reindex) without a cycle. `js-yaml` is already a shell dependency
 * (`@types/js-yaml` + `js-yaml`); it handles flow sequences (`tags: [a, b]`),
 * quotes, and CJK values the flat parser (`parseFlatYaml`) cannot.
 */

export type CraftFrontmatter = {
  id?: string;
  craft_type?: string;
  tags?: string[];
  source?: string;
  /** One-line curated summary (Story 8.7 R2). Optional - passthrough parse only;
   *  the indexer consuming it (summary_text column) is Story 8.7 S4. */
  summary?: string;
};

export type ParsedCraftMd = {
  frontmatter: CraftFrontmatter;
  body: string;
};

// U+FEFF (UTF-8 BOM) as a char code, checked below. Written this way (not as a
// literal / escape in a string) so eslint's no-irregular-whitespace rule does
// not flag the source.
const BOM_CHAR_CODE = 0xfeff;

/**
 * Parse the leading `---\n...\n---` frontmatter block. A doc with no frontmatter
 * (or malformed YAML) returns `{ frontmatter: {}, body: <full content> }` - the
 * doc is still indexable as `uncategorized` with the filename as craft_id (never
 * reject a user's craft doc over a frontmatter typo - degrade, don't drop).
 */
export function parseCraftMd(content: string): ParsedCraftMd {
  // CR-craft-kb-004: strip a UTF-8 BOM (U+FEFF) and tolerate leading whitespace
  // / blank lines before the `---` fence. Windows editors (Notepad) often save
  // with a BOM or a leading blank line; the previous anchored regex (`^---`)
  // failed frontmatter detection in that case -> the doc was mis-indexed as
  // `uncategorized` with the raw YAML left in the body. Strip BOM + allow
  // leading whitespace before the fence so it is recognized regardless of editor.
  const bomStripped = content.charCodeAt(0) === BOM_CHAR_CODE ? content.slice(1) : content;
  const fenceMatch = bomStripped.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fenceMatch) return { frontmatter: {}, body: bomStripped };
  const [, fmRaw, body] = fenceMatch;
  let frontmatter: CraftFrontmatter = {};
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

function normalizeFrontmatter(raw: Record<string, unknown>): CraftFrontmatter {
  const fm: CraftFrontmatter = {};
  const id = raw.id;
  if (typeof id === 'string' && id.trim()) fm.id = id.trim();
  const craftType = raw.craft_type;
  if (typeof craftType === 'string' && craftType.trim()) fm.craft_type = craftType.trim();
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
  return fm;
}

/**
 * Extract the doc's display name: the first level-1 heading (`# Foo`) in the
 * body. Returns null when no H1 is present (caller falls back to craft_id).
 * Exported for unit testing.
 */
export function extractCraftName(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Derive the stable craft_id: frontmatter `id` wins, else the filename without
 * the `.md` extension. The craft_id is the closure_craft_entry PK + the FTS/vec
 * join key. Exported for unit testing + reuse by the path scanner.
 *
 * CR-craft-kb-007: returns the EMPTY string when the derived id is empty /
 * whitespace-only (a file named `.md`, or a whitespace-only frontmatter `id`).
 * `''` is a legal TEXT PK in SQLite and would collide with every other empty-id
 * doc, so callers (scan path / indexer) MUST guard: skip + warn when the return
 * is empty (don't index a craft with no stable id).
 */
export function deriveCraftId(fileName: string, fm: CraftFrontmatter): string {
  if (fm.id && fm.id.trim()) return fm.id.trim();
  // CR-craft-kb-007: trim the filename-derived slug; a `.md` file derives to ''.
  return fileName.replace(/\.md$/i, '').trim();
}
