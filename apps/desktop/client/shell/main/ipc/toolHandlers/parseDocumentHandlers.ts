/**
 * parse_document tool handler (Story 3.6 WP6, R10 / design D11).
 *
 * `parse_document {filePath, maxChars?}` — parse an in-project document to
 * Markdown, endpoint-first with builtin fallback:
 *
 *   - PDF  : configured docParser endpoint (sidecar + /health probe ok) is
 *     tried FIRST (MinerU/docling OCR+layout quality, design D11); endpoint
 *     failure/unconfigured/dead-probe degrades to the builtin pdfjs text
 *     layer with the failure recorded as a note. A scanned verdict (avg
 *     <50 chars/page) returns the vision-path hint (analyze_image or
 *     configure an endpoint) instead of near-empty text.
 *   - DOCX : ALWAYS local mammoth (extractDocxText) — mammoth's raw-text
 *     quality is sufficient for research use and the parse is free/offline;
 *     the endpoint tier is reserved for PDF where OCR/layout actually matter
 *     (deliberate local-first call, NOT an oversight).
 *   - txt/md : direct utf-8 read.
 *   - EPUB : not implemented (implement.md 最后实现可砍 — see docParsing TODO).
 *
 * Path safety (mirror imageHandlers): `filePath` is project-RELATIVE; the
 * resolved path must stay inside projectDir (`assertWithinProject` throws on
 * escape — pattern B, an LLM probing ../../etc/passwd is an invariant
 * violation, not a graceful-degrade case). Everything ELSE never throws
 * (R8): missing file, unsupported kind, corrupt parse, dead endpoint all
 * degrade to friendly outputs.
 *
 * Reached via the unified toolExecution channel (agent-side remoteToolProxy
 * registration in agent/src/tool/builtin.ts — id `parse_document`). All
 * network/FS lives here in the shell (agent 纯编排零网络,
 * spec/agent/agent-tools.md injection boundary). classifyTool defaults to
 * 'read' (readonly/suggest/auto).
 *
 * Params are hand-coerced — no zod in this package (mirror wikiHandlers /
 * fetchHandlers coerce helpers); the agent-side tool definition carries the
 * zod surface the LLM sees.
 *
 * Testability: `createParseDocumentHandler` accepts injectable config loader
 * / probe / endpoint parser / pdf+docx extractors — unit tests run with ZERO
 * network (the real pdfjs/mammoth kernels are covered separately in
 * docParsing.test.ts with real fixture buffers).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DocParserConfig } from '@orison/shared-contracts';
import { assertWithinProject } from '../pathGuard';
import { getLogger } from '../../logger';
import {
  NON_UTF8_SUSPECT_RATIO,
  SCANNED_PAGE_CHAR_THRESHOLD,
  classifyDocumentKind,
  decodeTextDocument,
  extractDocxText,
  extractPdfTextLayer,
  utf8ReplacementCharRatio,
  type DocumentKind,
  type PdfTextExtraction,
} from '../../research/docParsing';
import { parseViaEndpoint, type EndpointParseResult } from '../../research/docParserAdapters';
import { probeDocParser, readDocParserConfig, type DocParserProbeResult } from '../../research/docParserConfig';
import { capFetchedText } from './fetchHandlers';
import type { ToolHandler, ToolExecuteResponse } from './types';

// ── Constants ──

export const PARSE_DOC_DEFAULT_MAX_CHARS = 32_000;
export const PARSE_DOC_MAX_CHARS_LIMIT = 64_000;
/**
 * PDF size ceiling (P4, CR 2026-08-15): a >100MB PDF read into the main
 * process (then multipart-copied for the endpoint, or text-layer-paged by
 * pdfjs) is a friendly-reject — the user should split it or point the
 * docParser endpoint at it directly.
 */
export const PARSE_PDF_MAX_BYTES = 100 * 1024 * 1024;

/** Machine-readable provenance labels (design D11 + dispatch 6.4). */
export type ParseDocVia =
  | 'endpoint-mineru'
  | 'endpoint-docling'
  | 'endpoint-custom'
  | 'builtin-pdfjs'
  | 'builtin-mammoth'
  | 'direct-read';

export const PARSE_VIA_LABELS: Record<ParseDocVia, string> = {
  'endpoint-mineru': '端点 MinerU',
  'endpoint-docling': '端点 docling',
  'endpoint-custom': '端点 custom',
  'builtin-pdfjs': '内置 PDF 文本层',
  'builtin-mammoth': '内置 mammoth',
  'direct-read': '直读',
};

/** Mime defaults per kind (only used for the endpoint multipart upload). */
const PDF_MIME = 'application/pdf';

// ── Param coercion (no zod in this package — mirror wikiHandlers) ──

export function coerceParseDocParams(params: Record<string, unknown>): { filePath?: string; maxChars?: number } {
  const filePath = typeof params.filePath === 'string' && params.filePath.trim() ? params.filePath.trim() : undefined;
  let maxChars: number | undefined;
  if (typeof params.maxChars === 'number' && Number.isFinite(params.maxChars)) {
    maxChars = Math.min(Math.max(Math.round(params.maxChars), 1), PARSE_DOC_MAX_CHARS_LIMIT);
  }
  return { filePath, maxChars };
}

// ── Output builders (never a throw) ──

function buildSuccess(args: {
  filePath: string;
  via: ParseDocVia;
  content: string;
  maxChars: number;
  kind: DocumentKind;
  pages?: number;
  scannedPages?: number[];
  notes?: string[];
}): ToolExecuteResponse {
  const { text, truncated } = capFetchedText(args.content, args.maxChars);
  const lines = [text, '', '---', `来源: ${args.filePath}（解析: ${PARSE_VIA_LABELS[args.via]}）`];
  if (args.pages !== undefined) lines.push(`页数: ${args.pages}`);
  for (const note of args.notes ?? []) lines.push(`备注: ${note}`);
  return {
    title: `parse_document: ${args.filePath.slice(0, 40)}`,
    output: lines.join('\n'),
    metadata: {
      via: args.via,
      kind: args.kind,
      chars: text.length,
      truncated,
      pages: args.pages,
      scannedPages: args.scannedPages,
    },
  };
}

function buildScannedOutput(args: {
  filePath: string;
  extraction: PdfTextExtraction;
  notes: string[];
}): ToolExecuteResponse {
  const lines = [
    `该 PDF 疑似扫描件（共 ${args.extraction.pages} 页，文本层平均 ${Math.round(args.extraction.avgCharsPerPage)} 字符/页，低于 ${SCANNED_PAGE_CHAR_THRESHOLD} 的判定阈值）——内置文本层提取拿不到可用内容，未返回正文。`,
    '建议二选一：',
    '- 在设置「研究与视觉」配置文档解析端点（MinerU / docling，带 OCR 能力）后重试 parse_document；',
    '- 将 PDF 页面截图保存到项目内，用 analyze_image 逐页视觉识别（视觉模型未配置时会返回手动分析导出协议）。',
  ];
  for (const note of args.notes) lines.push(`备注: ${note}`);
  return {
    title: `parse_document: ${args.filePath.slice(0, 40)}`,
    output: lines.join('\n'),
    metadata: {
      via: 'builtin-pdfjs',
      kind: 'pdf',
      scanned: true,
      pages: args.extraction.pages,
      scannedPages: args.extraction.scannedPages,
      avgCharsPerPage: Math.round(args.extraction.avgCharsPerPage),
    },
  };
}

function buildFailureOutput(filePath: string, message: string, extra?: Record<string, unknown>): ToolExecuteResponse {
  return {
    title: `parse_document: ${filePath.slice(0, 40)}`,
    output: `${message}\n支持的格式：PDF / DOCX / TXT / MD（EPUB 暂不支持）。请确认文件路径正确且文件未损坏。`,
    metadata: { error: message, ...extra },
  };
}

// ── Handler ──

export interface ParseDocumentHandlerDeps {
  /** Endpoint config loader (default: sidecar readDocParserConfig, never throws). */
  loadConfig?: () => DocParserConfig;
  /** Endpoint health probe (default: probeDocParser). */
  probe?: (opts?: { force?: boolean; signal?: AbortSignal }) => Promise<DocParserProbeResult>;
  /** Endpoint parser (default: parseViaEndpoint; tests inject stubs). */
  parseEndpoint?: typeof parseViaEndpoint;
  /** PDF text-layer kernel (default: extractPdfTextLayer). */
  extractPdf?: typeof extractPdfTextLayer;
  /** DOCX kernel (default: extractDocxText). */
  extractDocx?: typeof extractDocxText;
}

export function createParseDocumentHandler(deps: ParseDocumentHandlerDeps = {}): ToolHandler {
  const loadConfig = deps.loadConfig ?? readDocParserConfig;
  const probe = deps.probe ?? ((opts?: { force?: boolean; signal?: AbortSignal }) => probeDocParser(opts));
  const parseEndpoint = deps.parseEndpoint ?? parseViaEndpoint;
  const extractPdf = deps.extractPdf ?? extractPdfTextLayer;
  const extractDocx = deps.extractDocx ?? extractDocxText;

  // PDF branch: endpoint-first (configured + probed healthy), builtin fallback
  // with the failure recorded, scanned verdict → vision-path hint.
  async function parsePdfBranch(input: {
    filePath: string;
    fullPath: string;
    buffer: Buffer;
    maxChars: number;
    abort: AbortSignal;
  }): Promise<ToolExecuteResponse> {
    const notes: string[] = [];

    // 1) Endpoint tier — only for PDF, only when configured AND healthy.
    let config: DocParserConfig = {};
    try {
      config = loadConfig();
    } catch {
      // Config read failure → unconfigured (builtin path).
    }
    if (config.type && config.baseUrl) {
      let probeResult: DocParserProbeResult;
      try {
        probeResult = await probe({ signal: input.abort });
      } catch (err) {
        probeResult = { ok: false, detail: errMsg(err) };
      }
      if (probeResult.ok) {
        let endpointResult: EndpointParseResult;
        try {
          // P4: the handler's already-read buffer rides along — the endpoint
          // adapter must not read the same PDF a second time.
          endpointResult = await parseEndpoint(config, input.fullPath, path.basename(input.filePath), PDF_MIME, {
            signal: input.abort,
            buffer: input.buffer,
          });
        } catch (err) {
          endpointResult = { ok: false, error: errMsg(err) };
        }
        if (endpointResult.ok) {
          return buildSuccess({
            filePath: input.filePath,
            via: endpointResult.via,
            content: endpointResult.markdown,
            maxChars: input.maxChars,
            kind: 'pdf',
          });
        }
        notes.push(`解析端点失败（${endpointResult.error}），已降级内置 PDF 文本层提取`);
      } else {
        notes.push(`解析端点探活失败（${probeResult.detail ?? '未知原因'}），已降级内置 PDF 文本层提取`);
      }
    }

    // 2) Builtin tier — pdfjs text layer (+ scanned detection).
    let extraction: PdfTextExtraction;
    try {
      extraction = await extractPdf(input.buffer);
    } catch (err) {
      return buildFailureOutput(input.filePath, `PDF 解析失败：${errMsg(err)}（文件可能已损坏或加密）`, { kind: 'pdf' });
    }

    if (extraction.kind === 'scanned') {
      return buildScannedOutput({ filePath: input.filePath, extraction, notes });
    }
    if (extraction.scannedPages.length > 0) {
      notes.push(`第 ${extraction.scannedPages.join('、')} 页疑似扫描页（无文本层），这些页内容可能缺失。`);
    }
    return buildSuccess({
      filePath: input.filePath,
      via: 'builtin-pdfjs',
      content: extraction.text,
      maxChars: input.maxChars,
      kind: 'pdf',
      pages: extraction.pages,
      scannedPages: extraction.scannedPages,
      notes,
    });
  }

  return async ({ params, projectDir, abort }) => {
    const coerced = coerceParseDocParams(params);
    if (!coerced.filePath) {
      return {
        title: 'parse_document',
        output: '参数无效，请提供要解析的文档路径（filePath 字符串，项目内相对路径，如 research/设定集.pdf）。',
        metadata: { error: 'invalid-params' },
      };
    }
    const filePath = coerced.filePath;
    const maxChars = coerced.maxChars ?? PARSE_DOC_DEFAULT_MAX_CHARS;

    // Path safety: project-relative resolve + containment (throws on escape —
    // mirror imageHandlers; an escaped path is an invariant violation, not a
    // graceful-degrade case).
    const fullPath = path.resolve(projectDir, filePath);
    assertWithinProject(projectDir, fullPath);

    let fileSize: number;
    try {
      fileSize = (await stat(fullPath)).size;
    } catch {
      return buildFailureOutput(filePath, `文件不存在或无法访问：${filePath}`);
    }
    if (fileSize === 0) {
      return buildFailureOutput(filePath, `文件为空：${filePath}`);
    }

    const kind = classifyDocumentKind(filePath);
    if (kind === 'unsupported') {
      return buildFailureOutput(filePath, `不支持的文档格式：${path.extname(filePath) || '(无扩展名)'}`, { kind });
    }
    // P4: >100MB PDFs are a friendly reject BEFORE reading a single byte.
    if (kind === 'pdf' && fileSize > PARSE_PDF_MAX_BYTES) {
      return buildFailureOutput(
        filePath,
        `PDF 过大（${Math.round(fileSize / 1024 / 1024)}MB，超过 ${Math.round(PARSE_PDF_MAX_BYTES / 1024 / 1024)}MB 上限）。请拆分文档，或直接在 MinerU/docling 端点的界面中解析该文件。`,
        { kind, bytes: fileSize },
      );
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(fullPath);
    } catch (err) {
      return buildFailureOutput(filePath, `读取文件失败：${errMsg(err)}`);
    }

    try {
      switch (kind) {
        case 'pdf':
          return await parsePdfBranch({ filePath, fullPath, buffer, maxChars, abort });
        case 'docx':
          // Local-first BY DESIGN (module doc): mammoth quality is enough for
          // research text extraction and costs zero network — the endpoint
          // tier stays reserved for PDF (OCR/layout), so it is not tried here.
          try {
            const text = await extractDocx(buffer);
            return buildSuccess({ filePath, via: 'builtin-mammoth', content: text, maxChars, kind });
          } catch (err) {
            return buildFailureOutput(filePath, `DOCX 解析失败：${errMsg(err)}（文件可能已损坏）`, { kind });
          }
        case 'text': {
          // P20: heavy U+FFFD presence = the file is almost certainly not
          // utf-8 — decode still proceeds (best effort) but the note tells
          // the author to convert instead of trusting mojibake.
          const notes: string[] = [];
          if (utf8ReplacementCharRatio(buffer) > NON_UTF8_SUSPECT_RATIO) {
            notes.push('疑似非 UTF-8 编码（GBK/GB18030 等）——已按 UTF-8 解码，正文可能出现乱码；建议先转存为 UTF-8 后重新解析。');
          }
          return buildSuccess({ filePath, via: 'direct-read', content: decodeTextDocument(buffer), maxChars, kind, notes });
        }
        default:
          return buildFailureOutput(filePath, `不支持的文档格式：${kind}`);
      }
    } catch (err) {
      // Belt-and-suspenders (R8): branch helpers never throw, but an
      // unforeseen failure must still degrade to a friendly output.
      getLogger().warn({ err: errMsg(err), filePath }, 'parse_document: unexpected failure');
      return buildFailureOutput(filePath, `解析失败：${errMsg(err)}`, { kind });
    }
  };
}

// Default handler wired into toolExecution (id aligns with the agent-side
// remoteToolProxy registration in agent/src/tool/builtin.ts).
export const parseDocumentHandler: ToolHandler = createParseDocumentHandler();

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
