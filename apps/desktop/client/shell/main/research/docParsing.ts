/**
 * Builtin document-parsing fallback (Story 3.6 WP6, R10 / design D11).
 *
 * The NO-endpoint path of `parse_document` (and the degrade target when a
 * configured endpoint fails): pure local extraction with zero network —
 *
 *   - PDF  : pdfjs-dist LEGACY build text layer (`getTextContent()` per page,
 *     items joined in page order). Per-page non-whitespace char count under
 *     {@link SCANNED_PAGE_CHAR_THRESHOLD} marks an image-only page; a whole
 *     document averaging under the threshold is reported as `kind:'scanned'` —
 *     the handler then steers to the vision path (analyze_image) or to a
 *     configured MinerU/docling endpoint instead of returning near-empty text.
 *   - DOCX : mammoth `extractRawText` (already a shell dep, 1.9.0). docx is
 *     parsed LOCALLY even when an endpoint is configured — mammoth's raw-text
 *     quality is sufficient for research use and the parse is free/offline;
 *     the endpoint tier is reserved for PDF (where OCR/layout actually matter).
 *   - txt/md : direct utf-8 read (BOM stripped) — done inline by the handler.
 *   - EPUB : NOT implemented — implement.md marks it 最后实现可砍 (jszip+turndown).
 *     TODO(3.6-epub): add a stored-zip extractor if research demand shows up.
 *
 * All functions are pure Node (no electron import) — table-testable under plain
 * vitest with fixture buffers. The HANDLER (parseDocumentHandlers.ts) owns the
 * never-throws contract (R8); these kernels throw typed errors on corrupt
 * input for the handler to catch and degrade.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// ── Document-kind dispatch (pure, exported for tests) ──

export type DocumentKind = 'pdf' | 'docx' | 'text' | 'unsupported';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Map a file name (+ optional declared mime) to the parse dispatch kind.
 * Extension wins over a lying/absent content type — for a local file the name
 * is the more reliable signal; the mime only fills in when known.
 */
export function classifyDocumentKind(fileName: string, mime?: string): DocumentKind {
  const ext = path.extname(fileName).toLowerCase();
  const m = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (ext === '.pdf' || m === 'application/pdf') return 'pdf';
  if (ext === '.docx' || m === DOCX_MIME) return 'docx';
  if (ext === '.txt' || ext === '.md' || ext === '.markdown' || m === 'text/plain' || m === 'text/markdown') {
    return 'text';
  }
  return 'unsupported';
}

/** Decode a txt/md buffer as utf-8, stripping a leading BOM if present. */
export function decodeTextDocument(buffer: Buffer): string {
  const text = buffer.toString('utf-8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Replacement-char (U+FFFD) ratio among the utf-8-decoded characters (P20,
 * CR 2026-08-15): Node's utf-8 decoder substitutes every undecodable byte
 * sequence with U+FFFD, so a high ratio means the file is almost certainly
 * NOT utf-8 (GBK/GB18030 read as utf-8 = silent mojibake) — the handler adds
 * a conversion hint instead of handing the LLM garbage.
 */
export const NON_UTF8_SUSPECT_RATIO = 0.03;

export function utf8ReplacementCharRatio(buffer: Buffer): number {
  const text = buffer.toString('utf-8');
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count / text.length;
}

// ── Scanned-document detection (design D11) ──

/**
 * Per-page AND whole-document threshold: a page whose text layer carries fewer
 * non-whitespace characters than this is treated as image-only; a document
 * AVERAGING under it is a scanned PDF (no usable text layer at all).
 */
export const SCANNED_PAGE_CHAR_THRESHOLD = 50;

// ── PDF text layer (pdfjs-dist legacy build) ──

export interface PdfTextExtraction {
  kind: 'text' | 'scanned';
  pages: number;
  /** Page-order concatenated text layer (meaningful only for kind='text'). */
  text: string;
  /** Whole-document average of non-whitespace chars per page (scan verdict). */
  avgCharsPerPage: number;
  /** 1-based page numbers under the per-page threshold (image-only pages). */
  scannedPages: number[];
}

/**
 * Extract the PDF text layer page by page. Throws on a corrupt/undecodable PDF
 * or a zero-page document — the handler catches and degrades friendly (R8).
 * The pdfjs module is imported dynamically so it stays out of every consumer's
 * load path (only PDF parses pay the import cost).
 */
export async function extractPdfTextLayer(buffer: Buffer): Promise<PdfTextExtraction> {
  // Legacy build = the Node-compatible bundle (no DOM/canvas assumptions).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // Standard-14 font data (Helvetica & co): pdf.js wants it for glyph
    // mapping on non-embedded fonts; without it extraction still works for
    // WinAnsi text but logs a warning — resolve the bundled dir when we can.
    standardFontDataUrl: resolveStandardFontDataUrl(),
  });
  try {
    const doc = await task.promise;
    if (doc.numPages <= 0) throw new Error('PDF 无可读页面');

    const perPage: string[] = [];
    const scannedPages: number[] = [];
    let totalChars = 0;
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        let pageText = '';
        for (const item of content.items) {
          if ('str' in item && typeof item.str === 'string') pageText += item.str;
          if ('hasEOL' in item && item.hasEOL) pageText += '\n';
        }
        perPage.push(pageText);
        const chars = pageText.replace(/\s+/g, '').length;
        totalChars += chars;
        if (chars < SCANNED_PAGE_CHAR_THRESHOLD) scannedPages.push(pageNum);
      } finally {
        page.cleanup();
      }
    }

    const avgCharsPerPage = totalChars / doc.numPages;
    return {
      kind: avgCharsPerPage < SCANNED_PAGE_CHAR_THRESHOLD ? 'scanned' : 'text',
      pages: doc.numPages,
      text: perPage.join('\n\n').trim(),
      avgCharsPerPage,
      scannedPages,
    };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/**
 * Locate pdfjs-dist's bundled `standard_fonts/` dir as a URL-ish string
 * (forward slashes + trailing slash — pdf.js validates exactly that shape).
 * Best-effort: any failure returns undefined and extraction continues with
 * pdf.js's built-in glyph fallbacks (verified: WinAnsi text extracts fine).
 */
function resolveStandardFontDataUrl(): string | undefined {
  try {
    let pkgPath: string | undefined;
    try {
      // vitest / ESM: import.meta.url is this module's file URL.
      pkgPath = createRequire(import.meta.url).resolve('pdfjs-dist/package.json');
    } catch {
      // electron-vite CJS bundle: __dirname points at dist/main (or the source
      // dir in dev); pdfjs-dist is externalized so it resolves from there.
      if (typeof __dirname === 'string') {
        pkgPath = createRequire(path.join(__dirname, 'main.cjs')).resolve('pdfjs-dist/package.json');
      }
    }
    if (!pkgPath) return undefined;
    const dir = path.join(path.dirname(pkgPath), 'standard_fonts');
    if (!existsSync(dir)) return undefined;
    return `${dir.split(path.sep).join('/')}/`;
  } catch {
    return undefined;
  }
}

// ── DOCX (mammoth, local-first — see module doc for the rationale) ──

/**
 * Extract raw text from a DOCX buffer via mammoth `extractRawText`. Dynamic
 * import + default interop mirrors projectMetaIpc.convertDocxToMarkdown
 * (mammoth is CJS; the shim survives both vitest ESM and the built bundle).
 * Throws on a corrupt docx — the handler degrades friendly.
 */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammothMod = await import('mammoth');
  const mammoth = (mammothMod as { default?: unknown }).default ?? mammothMod;
  const { value } = await (mammoth as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  }).extractRawText({ buffer });
  return value;
}
