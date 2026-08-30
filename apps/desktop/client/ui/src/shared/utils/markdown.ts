import { marked } from 'marked';
import TurndownService from 'turndown';
import { stripFrontmatter } from './frontmatter';

marked.setOptions({
  gfm: true,
  breaks: false,
});

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});

turndown.addRule('strikethrough', {
  filter: ['s', 'del'] as Array<keyof HTMLElementTagNameMap>,
  replacement: (content) => `~~${content}~~`,
});

export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';
  return (marked.parse(markdown, { async: false }) as string).trimEnd();
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown
    .turndown(html)
    .replace(/^([*+-]) {2,}/gm, '$1 ')
    .replace(/^(\d+\.) {2,}/gm, '$1 ')
    .trim();
}

// ── Round-trip loss detection ──────────────────────────────────────────────
// The TipTap editor only registers StarterKit (no table/image/html nodes). A
// markdown→HTML→TipTap→markdown round-trip silently drops any construct the
// schema doesn't know, so an unsuspecting edit + autosave permanently deletes
// tables, images and HTML blocks. We detect those specific high-value
// constructs and, when they wouldn't survive, fall back to a raw source editor
// rather than corrupting the manuscript. We count constructs before/after
// (rather than full-string equality) because marked+turndown reformats even
// lossless content (list markers, emphasis tokens, blank lines).
//
// Front-matter is exempt (dogfood #109): the editor strips it before the body
// reaches TipTap and re-attaches the captured block byte-exact on every
// write-back (see frontmatter.ts), so it never round-trips through the rich
// editor at all — only the body is judged here.

const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
// A GFM table delimiter row (`---|---`, `| :-- | --: |`). It must contain a
// pipe — a bare `---` line is a horizontal rule / setext underline, which
// writers use as scene breaks and which the round-trip preserves (as `* * *`).
const TABLE_DELIM_RE = /^(?=[^\n]*\|)[\s:|-]*-[\s:|-]*$/gm;
// Raw block/inline HTML tags StarterKit won't round-trip (turndown keeps <a>,
// <strong>, <em>, <code> etc. via its rules, so scope to structural/table/media
// tags that get dropped).
const RAW_HTML_RE = /<\/?(?:table|thead|tbody|tr|td|th|div|span|section|article|figure|figcaption|img|iframe|video|audio|details|summary|mark|sub|sup|kbd)\b[^>]*>/gi;

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** Remove fenced blocks and inline code, where markdown syntax is literal text. */
function stripCodeSpans(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * True when opening `md` in the TipTap editor would lose content on the next
 * save. Callers should fall back to a raw source editor when this returns true.
 */
export function isMarkdownRoundTripLossy(md: string): boolean {
  if (!md) return false;
  // Front-matter is machine metadata the editor never round-trips (stripped on
  // load, re-attached byte-exact on save — see frontmatter.ts), so it no longer
  // forces source mode by itself. Judge the body only; any construct still
  // present in the body keeps triggering the fallback.
  const body = stripFrontmatter(md);
  // Images: the proxy round-trip below preserves them (turndown ships an <img>
  // rule), but the real editor schema has no image node and drops them — so
  // presence outside code spans is already lossy.
  if (countMatches(stripCodeSpans(body), IMAGE_RE) > 0) return true;

  const roundTripped = htmlToMarkdown(markdownToHtml(body));

  // Any structural HTML in the source that the round-trip strips out.
  if (countMatches(body, RAW_HTML_RE) > countMatches(roundTripped, RAW_HTML_RE)) return true;
  // GFM tables dropped (no table node) — compare delimiter-row counts.
  if (countMatches(body, TABLE_DELIM_RE) > countMatches(roundTripped, TABLE_DELIM_RE)) return true;

  return false;
}

