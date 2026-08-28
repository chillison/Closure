/**
 * docParser endpoint adapter tests (Story 3.6 WP6, R10 / design D11).
 *
 * ZERO network — the fetcher seam is a mock that records the URL + FormData
 * and returns fixture responses. Locks:
 *
 *   - per-kind request shape: URL path, multipart field names, the file's
 *     name/mime, and the mineru `return_md=true` + `backend=pipeline` CPU-safe
 *     form fields (survey §1.3) / docling `to_formats=md`;
 *   - per-kind response extraction: mineru md_content (string AND array
 *     shapes — survey PR #5261 multi-file tolerance), docling
 *     document.md.content, custom {markdown};
 *   - the failure contract: non-2xx, non-JSON, missing-field, transport
 *     throw, unreadable file, unconfigured config — ALL return
 *     {ok:false, error}, never a throw (the handler degrades to builtin).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocParserConfig } from '@orison/shared-contracts';
import {
  extractCustomMarkdown,
  extractDoclingMarkdown,
  extractMineruMarkdown,
  parseViaEndpoint,
  type DocEndpointFetchInit,
  type DocEndpointFetcher,
  type DocEndpointFetchResult,
  type DocEndpointFetchOpts,
} from '../main/research/docParserAdapters';

// electron is imported transitively via netFetch — keep the mock minimal.
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

// ── Fixtures / helpers ──

const CONFIGS: Record<'mineru' | 'docling' | 'custom', DocParserConfig> = {
  mineru: { type: 'mineru', baseUrl: 'http://127.0.0.1:8000/' },
  docling: { type: 'docling', baseUrl: 'http://127.0.0.1:5001' },
  custom: { type: 'custom', baseUrl: 'http://192.168.1.10:9000/base/' },
};

let tmpDir: string;
let pdfPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'docparser-adapters-'));
  pdfPath = path.join(tmpDir, 'doc.pdf');
  writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake bytes', 'latin1'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RecordedCall {
  url: string;
  init: DocEndpointFetchInit;
  opts: DocEndpointFetchOpts | undefined;
}

function mockFetcher(
  respond: (call: RecordedCall) => Partial<DocEndpointFetchResult> | Promise<Partial<DocEndpointFetchResult>>,
): { fetcher: DocEndpointFetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetcher: DocEndpointFetcher = async (url, init = {}, opts) => {
    const call = { url, init, opts };
    calls.push(call);
    const res = await respond(call);
    return { status: 200, ok: true, text: '', ...res };
  };
  return { fetcher, calls };
}

function jsonOk(payload: unknown): Partial<DocEndpointFetchResult> {
  return { status: 200, ok: true, text: JSON.stringify(payload) };
}

function asForm(body: unknown): FormData {
  expect(body).toBeInstanceOf(FormData);
  return body as FormData;
}

// ── Request-shape + success extraction per kind ──

describe('parseViaEndpoint — mineru', () => {
  it('POSTs {base}/file_parse with files + return_md + backend=pipeline, reads md_content', async () => {
    const { fetcher, calls } = mockFetcher(() => jsonOk({ md_content: '# 拆解结果\n正文', middle_json: {} }));
    const result = await parseViaEndpoint(CONFIGS.mineru, pdfPath, 'doc.pdf', 'application/pdf', { fetcher });

    expect(result).toEqual({ ok: true, markdown: '# 拆解结果\n正文', via: 'endpoint-mineru' });
    expect(calls).toHaveLength(1);
    // Trailing slash on the configured baseUrl is normalized away.
    expect(calls[0].url).toBe('http://127.0.0.1:8000/file_parse');
    expect(calls[0].init.method).toBe('POST');

    const form = asForm(calls[0].init.body);
    const file = form.get('files');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('doc.pdf');
    expect((file as Blob).type).toBe('application/pdf');
    // CPU-safe defaults (survey §1.3) — the point of the adapter.
    expect(form.get('return_md')).toBe('true');
    expect(form.get('backend')).toBe('pipeline');
  });

  it('tolerates the multi-file array shape (takes [0]; we upload exactly one file)', async () => {
    const { fetcher } = mockFetcher(() => jsonOk({ md_content: ['# 第一份', '# 第二份'] }));
    const result = await parseViaEndpoint(CONFIGS.mineru, pdfPath, 'doc.pdf', 'application/pdf', { fetcher });
    expect(result).toEqual({ ok: true, markdown: '# 第一份', via: 'endpoint-mineru' });
  });
});

describe('parseViaEndpoint — docling', () => {
  it('POSTs {base}/v1/convert/source with files + to_formats=md, reads document.md.content', async () => {
    const { fetcher, calls } = mockFetcher(() =>
      jsonOk({ document: { md: { content: '# docling 转换结果', markdown: '# docling 转换结果' } } }),
    );
    const result = await parseViaEndpoint(CONFIGS.docling, pdfPath, 'doc.pdf', 'application/pdf', { fetcher });

    expect(result).toEqual({ ok: true, markdown: '# docling 转换结果', via: 'endpoint-docling' });
    expect(calls[0].url).toBe('http://127.0.0.1:5001/v1/convert/source');
    const form = asForm(calls[0].init.body);
    expect((form.get('files') as File).name).toBe('doc.pdf');
    expect(form.get('to_formats')).toBe('md');
  });
});

describe('parseViaEndpoint — custom', () => {
  it('POSTs {base}/parse with file, reads {markdown} (Closure thin protocol)', async () => {
    const { fetcher, calls } = mockFetcher(() => jsonOk({ markdown: '# 自定义端点' }));
    const result = await parseViaEndpoint(CONFIGS.custom, pdfPath, 'doc.pdf', 'application/pdf', { fetcher });

    expect(result).toEqual({ ok: true, markdown: '# 自定义端点', via: 'endpoint-custom' });
    // Base path with a trailing slash segment is preserved minus the slash.
    expect(calls[0].url).toBe('http://192.168.1.10:9000/base/parse');
    const form = asForm(calls[0].init.body);
    expect((form.get('file') as File).name).toBe('doc.pdf');
  });
});

// ── Failure contract (never a throw; handler degrades to builtin) ──

describe('parseViaEndpoint — failures degrade to {ok:false, error}', () => {
  it('unconfigured config → ok:false without touching the network', async () => {
    const { fetcher, calls } = mockFetcher(() => jsonOk({}));
    const result = await parseViaEndpoint({}, pdfPath, 'doc.pdf', 'application/pdf', { fetcher });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('未配置');
    expect(calls).toHaveLength(0);
  });

  it('non-2xx → per-kind HTTP error', async () => {
    for (const key of ['mineru', 'docling', 'custom'] as const) {
      const { fetcher } = mockFetcher(() => ({ status: 500, ok: false, text: 'boom' }));
      const result = await parseViaEndpoint(CONFIGS[key], pdfPath, 'doc.pdf', 'application/pdf', { fetcher });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('HTTP 500');
    }
  });

  it('non-JSON body → parse error', async () => {
    const { fetcher } = mockFetcher(() => ({ status: 200, ok: true, text: '<html>gateway error</html>' }));
    const result = await parseViaEndpoint(CONFIGS.mineru, pdfPath, 'doc.pdf', 'application/pdf', { fetcher });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('JSON');
  });

  it('2xx without the expected field → field-missing error (per kind)', async () => {
    const cases: Array<[keyof typeof CONFIGS, unknown, string]> = [
      ['mineru', { middle_json: {} }, 'md_content'],
      ['docling', { document: {} }, 'document.md.content'],
      ['custom', { text: 'nope' }, 'markdown'],
    ];
    for (const [key, payload, needle] of cases) {
      const { fetcher } = mockFetcher(() => jsonOk(payload));
      const result = await parseViaEndpoint(CONFIGS[key], pdfPath, 'doc.pdf', 'application/pdf', { fetcher });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(needle);
    }
  });

  it('empty-string markdown counts as missing (blank parse degrades to builtin scan verdict)', async () => {
    const { fetcher } = mockFetcher(() => jsonOk({ md_content: '   ' }));
    const result = await parseViaEndpoint(CONFIGS.mineru, pdfPath, 'doc.pdf', 'application/pdf', { fetcher });
    expect(result.ok).toBe(false);
  });

  it('transport throw (timeout/network) → friendly {ok:false}', async () => {
    const { fetcher } = mockFetcher(() => {
      throw new Error('请求超时（120000ms）');
    });
    const result = await parseViaEndpoint(CONFIGS.mineru, pdfPath, 'doc.pdf', 'application/pdf', { fetcher });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('解析端点调用失败');
  });

  it('unreadable local file → {ok:false} without a throw', async () => {
    const { fetcher } = mockFetcher(() => jsonOk({ md_content: 'x' }));
    const result = await parseViaEndpoint(
      CONFIGS.mineru,
      path.join(tmpDir, 'missing.pdf'),
      'missing.pdf',
      'application/pdf',
      { fetcher },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('读取文件失败');
  });
});

// ── Pure response extractors ──

describe('extract*Markdown (pure shape tolerance)', () => {
  it('mineru: string | string[0] | invalid shapes', () => {
    expect(extractMineruMarkdown({ md_content: '# md' })).toBe('# md');
    expect(extractMineruMarkdown({ md_content: ['# first', '# second'] })).toBe('# first');
    expect(extractMineruMarkdown({ md_content: [] })).toBeUndefined();
    expect(extractMineruMarkdown({ md_content: 42 })).toBeUndefined();
    expect(extractMineruMarkdown({ md_content: '' })).toBeUndefined();
    expect(extractMineruMarkdown({})).toBeUndefined();
    expect(extractMineruMarkdown(null)).toBeUndefined();
  });

  it('docling: document.md.content only', () => {
    expect(extractDoclingMarkdown({ document: { md: { content: '# ok' } } })).toBe('# ok');
    expect(extractDoclingMarkdown({ document: { md: {} } })).toBeUndefined();
    expect(extractDoclingMarkdown({ md: '# top-level 不算' })).toBeUndefined();
    expect(extractDoclingMarkdown({ document: { md: { content: '' } } })).toBeUndefined();
  });

  it('custom: top-level {markdown}', () => {
    expect(extractCustomMarkdown({ markdown: '# ok' })).toBe('# ok');
    expect(extractCustomMarkdown({ markdown: '' })).toBeUndefined();
    expect(extractCustomMarkdown({ md: '# 不算' })).toBeUndefined();
    expect(extractCustomMarkdown(null)).toBeUndefined();
  });
});
