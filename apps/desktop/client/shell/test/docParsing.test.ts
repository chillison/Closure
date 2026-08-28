/**
 * Builtin document-parsing kernel tests (Story 3.6 WP6, R10 / design D11).
 *
 * REAL kernels, REAL fixtures — no mocking of pdfjs/mammoth:
 *
 *   - PDF fixtures are hand-built minimal valid PDFs (xref offsets computed
 *     by the builder), parsed by the actual pdfjs-dist legacy build — locks
 *     the real extraction path incl. per-page item joining + the scanned
 *     verdict math (dispatch: 手写最小合法 PDF 单页 Hello 文本).
 *   - DOCX fixture is a hand-built minimal OOXML package (STORE-method zip
 *     with hand-computed CRC32 — no zip dep in the repo) parsed by the real
 *     mammoth.
 *
 * ZERO network. Covers classifyDocumentKind dispatch + BOM strip + the
 * scan matrix (text page / scanned page / mixed doc average verdict).
 * Fixture builders live in test/fixtures/documentFixtures.ts (shared with
 * parseDocumentHandlers.test.ts).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NON_UTF8_SUSPECT_RATIO,
  SCANNED_PAGE_CHAR_THRESHOLD,
  classifyDocumentKind,
  decodeTextDocument,
  extractDocxText,
  extractPdfTextLayer,
  utf8ReplacementCharRatio,
} from '../main/research/docParsing';
import { buildDocxFixture, buildPdfFixture } from './fixtures/documentFixtures';

// ── classifyDocumentKind ──

describe('classifyDocumentKind', () => {
  it('maps extensions first', () => {
    expect(classifyDocumentKind('a/b/设定集.pdf')).toBe('pdf');
    expect(classifyDocumentKind('角色卡.docx')).toBe('docx');
    expect(classifyDocumentKind('notes.txt')).toBe('text');
    expect(classifyDocumentKind('设定.md')).toBe('text');
    expect(classifyDocumentKind('readme.markdown')).toBe('text');
  });

  it('extension wins over a lying mime; mime fills in when informative', () => {
    expect(classifyDocumentKind('scan.pdf', 'text/plain')).toBe('pdf');
    expect(classifyDocumentKind('noext', 'application/pdf')).toBe('pdf');
    expect(classifyDocumentKind('noext', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
    expect(classifyDocumentKind('noext', 'text/plain')).toBe('text');
    expect(classifyDocumentKind('noext', 'application/epub+zip')).toBe('unsupported');
  });

  it('uppercase extensions + unsupported kinds', () => {
    expect(classifyDocumentKind('DOC.PDF')).toBe('pdf');
    expect(classifyDocumentKind('book.epub')).toBe('unsupported');
    expect(classifyDocumentKind('data.xlsx')).toBe('unsupported');
    expect(classifyDocumentKind('archive.zip')).toBe('unsupported');
  });
});

// ── decodeTextDocument ──

describe('decodeTextDocument', () => {
  it('utf-8 decode + leading BOM strip', () => {
    expect(decodeTextDocument(Buffer.from('设定文档', 'utf-8'))).toBe('设定文档');
    expect(decodeTextDocument(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM 后正文', 'utf-8')]))).toBe('BOM 后正文');
  });
});

// ── P20 (CR 2026-08-15): non-UTF-8 detection via replacement-char ratio ──

describe('utf8ReplacementCharRatio (P20 mojibake detector)', () => {
  it('clean utf-8 (incl. CJK) → ratio 0; empty buffer → 0', () => {
    expect(utf8ReplacementCharRatio(Buffer.from('设定文档正文', 'utf-8'))).toBe(0);
    expect(utf8ReplacementCharRatio(Buffer.alloc(0))).toBe(0);
  });

  it('a GBK-style body read as utf-8 decodes to heavy U+FFFD → ratio above the 3% suspect line', () => {
    // GBK 编码的中文（每汉字 2 字节，多数非合法 utf-8 序列）。
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd5, 0xfd, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2]);
    const ratio = utf8ReplacementCharRatio(gbk);
    expect(ratio).toBeGreaterThan(NON_UTF8_SUSPECT_RATIO);
  });

  it('a single stray byte among healthy text stays BELOW the line (no false alarm)', () => {
    const buf = Buffer.concat([Buffer.from('正常的长文本内容，包含足量的合法 UTF-8 字符。'.repeat(4), 'utf-8'), Buffer.from([0xff])]);
    expect(utf8ReplacementCharRatio(buf)).toBeLessThanOrEqual(NON_UTF8_SUSPECT_RATIO);
  });
});

// ── extractPdfTextLayer (REAL pdfjs on hand-built fixtures) ──

// Real-kernel tests get a raised timeout (mirror parseDocumentHandlers.test.ts):
// the first call pays pdfjs module + worker init, which exceeds the 5s default
// under turbo's parallel package load (observed flaking under `pnpm test`);
// passes in isolation. 30s leaves ample headroom without masking a hang.
describe('extractPdfTextLayer', () => {
  it('single text page: extracts the string, kind=text, no scanned pages', async () => {
    const text = 'Hello Closure research page with enough body text to clear the scan threshold';
    const extraction = await extractPdfTextLayer(buildPdfFixture([text]));
    expect(extraction.kind).toBe('text');
    expect(extraction.pages).toBe(1);
    expect(extraction.scannedPages).toEqual([]);
    expect(extraction.text).toContain('Hello Closure');
    expect(extraction.avgCharsPerPage).toBe(text.replace(/\s+/g, '').length);
  }, 30_000);

  it('a SHORT single page (avg < threshold) is honestly judged scanned', async () => {
    // 12 non-ws chars/page < 50 → the whole-doc average rule fires — this is
    // the documented behavior, not a bug (thin text layer ≈ scanned).
    const extraction = await extractPdfTextLayer(buildPdfFixture(['Hello Closure']));
    expect(extraction.avgCharsPerPage).toBe('Hello Closure'.replace(/\s+/g, '').length);
    expect(extraction.kind).toBe('scanned');
  }, 30_000);

  it('scanned verdict: empty content stream → 0 chars/page → kind=scanned', async () => {
    const extraction = await extractPdfTextLayer(buildPdfFixture(['']));
    expect(extraction.kind).toBe('scanned');
    expect(extraction.pages).toBe(1);
    expect(extraction.scannedPages).toEqual([1]);
    expect(extraction.avgCharsPerPage).toBe(0);
  }, 30_000);

  it('mixed doc: page average ≥ threshold keeps kind=text, thin pages listed', async () => {
    // Page 1 carries well over 2× the threshold so the DOC average stays ≥50
    // even though page 2 is image-only.
    const longText = `page one ${'A'.repeat(SCANNED_PAGE_CHAR_THRESHOLD * 3)}`;
    const extraction = await extractPdfTextLayer(buildPdfFixture([longText, '']));
    expect(extraction.avgCharsPerPage).toBeGreaterThanOrEqual(SCANNED_PAGE_CHAR_THRESHOLD);
    expect(extraction.kind).toBe('text');
    expect(extraction.pages).toBe(2);
    expect(extraction.scannedPages).toEqual([2]);
    expect(extraction.text).toContain('page one');
  }, 30_000);

  it('two thin text pages average under the threshold → doc-level scanned verdict', async () => {
    const extraction = await extractPdfTextLayer(buildPdfFixture(['short', 'tiny']));
    expect(extraction.avgCharsPerPage).toBeLessThan(SCANNED_PAGE_CHAR_THRESHOLD);
    expect(extraction.kind).toBe('scanned');
  }, 30_000);

  it('multi-page text is joined in page order', async () => {
    const extraction = await extractPdfTextLayer(
      buildPdfFixture([`${'A'.repeat(60)}`, `${'B'.repeat(60)}`]),
    );
    expect(extraction.kind).toBe('text');
    expect(extraction.text.startsWith('A'.repeat(60))).toBe(true);
    expect(extraction.text.indexOf('B'.repeat(60))).toBeGreaterThan(0);
  }, 30_000);

  it('corrupt bytes throw (handler degrades friendly)', async () => {
    await expect(extractPdfTextLayer(Buffer.from('this is not a pdf at all', 'utf-8'))).rejects.toThrow();
  }, 30_000);
});

// ── extractDocxText (REAL mammoth on a hand-built docx) ──

describe('extractDocxText', () => {
  it('extracts the paragraph text from a minimal docx package', async () => {
    const text = await extractDocxText(buildDocxFixture('Hello Closure 设定文档正文'));
    expect(text).toContain('Hello Closure 设定文档正文');
  });

  it('corrupt docx throws (handler degrades friendly)', async () => {
    await expect(extractDocxText(Buffer.from('not a zip'))).rejects.toThrow();
  });
});

// ── pdfjs standard-font data dir resolution (best-effort helper path) ──

describe('pdfjs runtime resolution sanity', () => {
  it('pdfjs-dist standard_fonts exists in node_modules (standardFontDataUrl resolves)', () => {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('pdfjs-dist/package.json');
    expect(pkgPath).toBeTruthy();
    expect(existsSync(path.join(path.dirname(pkgPath), 'standard_fonts'))).toBe(true);
  });
});
