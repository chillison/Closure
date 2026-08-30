/**
 * Leading YAML front-matter utilities — single source for the front-matter
 * block shape across the UI (dogfood R2 #109).
 *
 * Front-matter is machine metadata, never prose: the chapters disk-derivation
 * reads the chapter `order:` from it (see `shared/store/chapterDiskDerivation.ts`),
 * and the rich markdown editor strips it before the body reaches TipTap
 * (marked would drop it) and re-attaches the captured block byte-for-byte on
 * every write-back — so editing a chapter file no longer forces source mode and
 * can never physically delete the `order:` line (which would break chapter
 * ordering on the next save).
 *
 * Round-trip safety: `restoreFrontmatter(splitFrontmatter(t).frontmatter,
 * splitFrontmatter(t).body) === t` for any input. The captured block is the
 * exact matched source substring (CRLF variants, indentation, comments and a
 * leading BOM included) — never parsed and re-serialized.
 *
 * Regex semantics are what `chapterDiskDerivation` used to keep privately
 * (trailing blanks tolerated after the opening `---`, closing `---` followed
 * by a newline or EOF, CRLF tolerated), plus the BOM tolerance the old
 * `markdown.ts` check had: a BOM'd front-matter block must still be stripped,
 * or the rich editor would silently drop it on the next save.
 */

const FRONTMATTER_RE = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type FrontmatterSplit = {
  /**
   * The exact leading front-matter block as it appears in the source — opening
   * `---` line through the closing `---` line's newline, byte-for-byte — or
   * null when the document has no front-matter.
   */
  frontmatter: string | null;
  /** The document with the front-matter block removed. */
  body: string;
};

/** Split a document into its front-matter block (byte-exact) and body. */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[0], body: text.slice(match[0].length) };
}

/** The exact leading front-matter block (delimiters included), or null. */
export function getFrontmatterBlock(text: string): string | null {
  return text.match(FRONTMATTER_RE)?.[0] ?? null;
}

/** The YAML text between the delimiters, or null when there is no block. */
export function getFrontmatterInner(text: string): string | null {
  return text.match(FRONTMATTER_RE)?.[1] ?? null;
}

/** The document with its leading front-matter block removed (passthrough when none). */
export function stripFrontmatter(text: string): string {
  return splitFrontmatter(text).body;
}

/**
 * Re-attach a front-matter block captured by {@link splitFrontmatter} in front
 * of a body. Byte-exact inverse of the split; `null` passes the body through.
 *
 * One normalization: a block that ended at EOF (closing `---` with no trailing
 * newline) gets a line separator inserted before a non-empty body, keeping the
 * closing delimiter a line start so the next strip stays stable. Such a block
 * can only come from a file with no body at all, so no original is altered.
 */
export function restoreFrontmatter(frontmatter: string | null, body: string): string {
  if (!frontmatter) return body;
  if (body === '') return frontmatter;
  return frontmatter.endsWith('\n') ? frontmatter + body : `${frontmatter}\n${body}`;
}
