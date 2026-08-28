/**
 * Hand-built binary document fixtures for the WP6 parsing tests (Story 3.6).
 *
 *   - `buildPdfFixture` — minimal valid PDFs (xref offsets computed by the
 *     builder) parsed by the REAL pdfjs-dist legacy build.
 *   - `buildDocxFixture` — minimal OOXML package as a STORE-method zip with
 *     hand-computed CRC32s (no zip dep in the repo) parsed by the REAL mammoth.
 *
 * Extracted from docParsing.test.ts so parseDocumentHandlers.test.ts can
 * share the builders without re-running the docParsing suites (importing a
 * *.test.ts from another test file duplicates its tests into that file's run).
 */

// ── PDF fixture builder ──

/**
 * Build a minimal valid PDF whose pages carry the given text-layer strings.
 * An EMPTY string renders an empty content stream (an image-only/scanned page
 * from the text layer's point of view). Objects: 1=Catalog 2=Pages, then
 * page/content pairs (3,4),(5,6)…, last object = the /F1 Helvetica font.
 *
 * Long text is wrapped at 70 chars/line — pdf.js v6 text extraction CLIPS
 * glyphs beyond the 612pt MediaBox (verified: a 109-char single line yields
 * only the 70 chars that fit), so one-line fixtures would under-count.
 *
 * NOTE: PDF literal strings in a Type1/WinAnsi content stream carry
 * single-byte encodings — CJK cannot ride them without an embedded CID font,
 * so fixtures use ASCII. (Production CJK PDFs embed fonts; pdf.js handles
 * those — fixtures only lock OUR join/threshold logic.)
 */
export function buildPdfFixture(pageTexts: string[]): Buffer {
  const wrapText = (text: string): string[] => {
    if (text.length === 0) return [];
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += 70) lines.push(text.slice(i, i + 70));
    return lines;
  };
  const streamFor = (text: string): string =>
    wrapText(text)
      .map((line, idx) => `BT /F1 12 Tf 72 ${720 - idx * 20} Td (${line}) Tj ET`)
      .join('\n');

  const n = pageTexts.length;
  const kids = Array.from({ length: n }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  const addObj = (num: number, content: string) => {
    offsets[num] = body.length;
    body += `${num} 0 obj\n${content}\nendobj\n`;
  };

  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  pageTexts.forEach((text, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    const fontNum = 3 + n * 2;
    addObj(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    const stream = streamFor(text);
    addObj(contentNum, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  addObj(3 + n * 2, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  const totalObjects = 3 + n * 2;
  const xrefOffset = body.length;
  body += `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjects; i++) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer << /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

// ── DOCX fixture builder (minimal OOXML package, STORE-method zip) ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a minimal valid .docx (single paragraph) as a STORE-method zip with
 * hand-computed CRC32s — the three parts mammoth minimally needs.
 */
export function buildDocxFixture(text: string): Buffer {
  const parts: Array<{ name: string; data: Buffer }> = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
        'utf-8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
        'utf-8',
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`,
        'utf-8',
      ),
    },
  ];

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf-8');
    const crc = crc32(part.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(part.data.length, 18);
    local.writeUInt32LE(part.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, name, part.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(part.data.length, 20);
    cd.writeUInt32LE(part.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);

    offset += local.length + name.length + part.data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len
  return Buffer.concat([...chunks, centralBuf, eocd]);
}
