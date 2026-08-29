/**
 * analyze_image handler tests (Story 3.6 WP7, R11 / design D5).
 *
 * ZERO network / ZERO electron: the vision kernel (runVisionAnalysis), guard,
 * and binary fetcher are stubbed. Locks: param coercion, extension→mime
 * mapping, local-file branch (assertWithinProject invariant THROWS on escape,
 * mirror parse_document; missing/empty file degrade friendly), URL branch
 * (SSRF guard incl. redirect re-guard + 10MB download cap + non-2xx
 * degradation), the vision/manual output protocols (D5 manual relay package:
 * exported path + suggestedPrompt verbatim), and never-throws on every
 * failure path (R8).
 *
 * electron + db-imports mocked (analyzeImageHandlers imports searchConfig →
 * configIpc transitively, mirror fetchHandlers.test.ts); the vision kernel is
 * module-mocked (its real three-layer dispatch is covered in
 * visionAnalysis.test.ts).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handle, safeStorage, setProxy, reindexAll, reindexAllCraft, reindexAssetCards, reindexAllSettingMd, getProjectById, getProject, getDb, warn, info, runVisionAnalysis } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  setProxy: vi.fn().mockResolvedValue(undefined),
  reindexAll: vi.fn(),
  reindexAllCraft: vi.fn(),
  reindexAssetCards: vi.fn(),
  reindexAllSettingMd: vi.fn(),
  getProjectById: vi.fn(),
  getProject: vi.fn(),
  getDb: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  runVisionAnalysis: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  session: { defaultSession: { setProxy } },
  net: { fetch: vi.fn() },
  app: { getPath: vi.fn(() => '/home') },
  dialog: {},
  BrowserWindow: vi.fn(),
}));
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));
vi.mock('../main/research/visionAnalysis', () => ({ runVisionAnalysis }));

import { SsrfBlockedError } from '../main/research/netGuard';
import type { VisionAnalysisResult } from '../main/research/visionAnalysis';
import {
  ANALYZE_IMAGE_MAX_DOWNLOAD_BYTES,
  analyzeImageHandler,
  buildManualOutput,
  coerceAnalyzeImageParams,
  createAnalyzeImageHandler,
  mimeFromImageExtension,
  type BinaryFetcher,
  type FetchedBinary,
} from '../main/ipc/toolHandlers/analyzeImageHandlers';

// ── Fixtures / helpers ──

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_URL = 'https://example.com/char.png';

function pngBytes(padding = 64): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(padding, 7)]);
}

function binaryFixture(overrides: Partial<FetchedBinary> = {}): FetchedBinary {
  return {
    status: 200,
    ok: true,
    finalUrl: IMAGE_URL,
    contentType: 'image/png',
    buffer: pngBytes(),
    ...overrides,
  };
}

function visionResult(text: string): Extract<VisionAnalysisResult, { mode: 'vision' }> {
  return { mode: 'vision', text };
}

function manualResult(images: string[], suggestedPrompt: string): Extract<VisionAnalysisResult, { mode: 'manual' }> {
  return { mode: 'manual', images, suggestedPrompt };
}

function ctx(params: Record<string, unknown>, projectDir: string) {
  return { params, projectDir, sessionId: 's1', abort: new AbortController().signal };
}

type AnalyzeFn = (opts: {
  imageB64: string;
  mimeType: string;
  prompt: string;
  projectDir: string;
}) => Promise<VisionAnalysisResult>;

type HandlerOverrides = {
  fetchBinary?: BinaryFetcher;
  guard?: (url: string, allowlist: readonly string[]) => Promise<void>;
  analyze?: AnalyzeFn;
};

function handler(overrides: HandlerOverrides = {}) {
  return createAnalyzeImageHandler({
    fetchBinary: overrides.fetchBinary ?? (async () => binaryFixture()),
    guard: overrides.guard ?? (async () => {}),
    loadConfig: () => ({ searxngLocalhostProbe: true }),
    loadDocParserConfig: () => ({}),
    ...(overrides.analyze ? { analyze: overrides.analyze } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default kernel stub: vision mode with a marker text (individual tests override).
  runVisionAnalysis.mockResolvedValue(visionResult('图中的字是「闭」。'));
});

// ── Pure helpers ──

describe('coerceAnalyzeImageParams', () => {
  it('trims values, rejects blanks/non-strings', () => {
    expect(coerceAnalyzeImageParams({ imagePath: ' a.png ', prompt: ' 描述 ' }))
      .toEqual({ imagePath: 'a.png', imageUrl: undefined, prompt: '描述' });
    expect(coerceAnalyzeImageParams({ imagePath: '   ', prompt: 'x' }).imagePath).toBeUndefined();
    expect(coerceAnalyzeImageParams({ imagePath: 42, prompt: 'x' }).imagePath).toBeUndefined();
    expect(coerceAnalyzeImageParams({ imageUrl: IMAGE_URL, prompt: '   ' }).prompt).toBeUndefined();
  });
});

describe('mimeFromImageExtension', () => {
  it('maps known extensions, empty string for unknown (kernel sniffs the real bytes)', () => {
    expect(mimeFromImageExtension('.PNG')).toBe('image/png');
    expect(mimeFromImageExtension('.jpg')).toBe('image/jpeg');
    expect(mimeFromImageExtension('.jpeg')).toBe('image/jpeg');
    expect(mimeFromImageExtension('.gif')).toBe('image/gif');
    expect(mimeFromImageExtension('.webp')).toBe('image/webp');
    expect(mimeFromImageExtension('.bmp')).toBe('');
    expect(mimeFromImageExtension('')).toBe('');
  });
});

describe('buildManualOutput', () => {
  it('renders the D5 manual relay package (path + suggestedPrompt verbatim)', () => {
    const out = buildManualOutput('a.png', manualResult(['/p/.orison/research-media/1.png'], '识别图中全部文字'));
    expect(out).toContain('/p/.orison/research-media/1.png');
    expect(out).toContain('剪贴板');
    expect(out).toContain('提示词：识别图中全部文字');
    expect(out).toContain('贴回对话');
  });
});

// ── Local file branch ──

describe('analyze_image handler — imagePath', () => {
  let projectDir = '';

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), 'analyze-image-'));
  });

  afterEach(() => {
    rmBestEffort(projectDir);
  });

  it('reads the file and hands base64 + extension mime + prompt to the vision kernel', async () => {
    writeFileSync(path.join(projectDir, 'ref.png'), pngBytes());
    const analyze = vi.fn(async (_opts: Parameters<AnalyzeFn>[0]) => visionResult('分析文本'));

    const res = await handler({ analyze })(ctx({ imagePath: 'ref.png', prompt: '描述画面' }, projectDir));

    expect(analyze).toHaveBeenCalledTimes(1);
    const call = analyze.mock.calls[0]![0] as { imageB64: string; mimeType: string; prompt: string; projectDir: string };
    expect(Buffer.from(call.imageB64, 'base64')).toEqual(pngBytes());
    expect(call.mimeType).toBe('image/png');
    expect(call.prompt).toBe('描述画面');
    expect(call.projectDir).toBe(projectDir);

    expect(res.output).toContain('分析文本');
    expect(res.output).toContain(`来源: ref.png`);
    expect(res.output).toContain('检索日期');
    expect(res.metadata).toMatchObject({ mode: 'vision', source: 'ref.png' });
  });

  it('manual mode returns the relay protocol (kernel saved + copied; leader relays verbatim)', async () => {
    writeFileSync(path.join(projectDir, 'ref.png'), pngBytes());
    const analyze = vi.fn(async () => manualResult([path.join(projectDir, '.orison', 'research-media', '1.png')], '识别图中文字'));

    const res = await handler({ analyze })(ctx({ imagePath: 'ref.png', prompt: '识别图中文字' }, projectDir));

    expect(res.metadata).toMatchObject({
      mode: 'manual',
      images: [path.join(projectDir, '.orison', 'research-media', '1.png')],
      suggestedPrompt: '识别图中文字',
    });
    expect(res.output).toContain('视觉模型未配置');
    expect(res.output).toContain('research-media');
    expect(res.output).toContain('提示词：识别图中文字');
  });

  it('missing file degrades friendly (never-throws)', async () => {
    const res = await handler()(ctx({ imagePath: 'nope.png', prompt: 'x' }, projectDir));
    expect(res.output).toContain('不存在');
    expect(runVisionAnalysis).not.toHaveBeenCalled();
  });

  it('empty file degrades friendly', async () => {
    writeFileSync(path.join(projectDir, 'empty.png'), Buffer.alloc(0));
    const res = await handler()(ctx({ imagePath: 'empty.png', prompt: 'x' }, projectDir));
    expect(res.output).toContain('为空');
  });

  it('path escape THROWS (pattern B invariant — not a graceful-degrade case)', async () => {
    const h = handler();
    await expect(
      h(ctx({ imagePath: '../outside.png', prompt: 'x' }, projectDir)),
    ).rejects.toThrow(/escapes project directory/);
  });
});

// ── URL branch ──

describe('analyze_image handler — imageUrl', () => {
  it('downloads the binary and passes the content-type mime to the kernel', async () => {
    const analyze = vi.fn(async (_opts: Parameters<AnalyzeFn>[0]) => visionResult('ok'));
    const guard = vi.fn(async () => {});

    const res = await handler({ analyze, guard })(ctx({ imageUrl: IMAGE_URL, prompt: '看图' }, '/proj/alpha'));

    expect(guard).toHaveBeenCalledWith(IMAGE_URL, []);
    expect(analyze).toHaveBeenCalledTimes(1);
    const call = analyze.mock.calls[0]![0] as { mimeType: string };
    expect(call.mimeType).toBe('image/png');
    expect(res.output).toContain('ok');
    expect(res.metadata).toMatchObject({ mode: 'vision', source: IMAGE_URL });
  });

  it('SSRF block degrades friendly with the policy hint', async () => {
    const guard = vi.fn(async (url: string) => {
      throw new SsrfBlockedError(url, 'private-ip', '目标 IP 127.0.0.1 是私网/环回地址，已拦截');
    });
    const res = await handler({ guard })(ctx({ imageUrl: 'http://127.0.0.1/x.png', prompt: 'x' }, '/proj/alpha'));
    expect(res.output).toContain('拦截');
    expect(res.output).toContain('研究与视觉');
    expect(res.metadata).toMatchObject({ blocked: true });
  });

  it('redirects are re-guarded per hop (netGuard caller-duty contract)', async () => {
    const guard = vi.fn(async () => {});
    const fetchBinary: BinaryFetcher = async () => binaryFixture({ finalUrl: 'https://other.example.com/final.png' });

    await handler({ guard, fetchBinary })(ctx({ imageUrl: IMAGE_URL, prompt: 'x' }, '/proj/alpha'));

    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenNthCalledWith(2, 'https://other.example.com/final.png', []);
  });

  it('redirect into a blocked target is caught', async () => {
    const guard = vi.fn(async (url: string) => {
      if (url.includes('other.example.com')) {
        throw new SsrfBlockedError(url, 'private-ip', '重定向目标被拦截');
      }
    });
    const fetchBinary: BinaryFetcher = async () => binaryFixture({ finalUrl: 'https://other.example.com/final.png' });

    const res = await handler({ guard, fetchBinary })(ctx({ imageUrl: IMAGE_URL, prompt: 'x' }, '/proj/alpha'));
    expect(res.metadata).toMatchObject({ blocked: true });
  });

  it('non-2xx degrades friendly', async () => {
    const fetchBinary: BinaryFetcher = async () => binaryFixture({ status: 404, ok: false });
    const res = await handler({ fetchBinary })(ctx({ imageUrl: IMAGE_URL, prompt: 'x' }, '/proj/alpha'));
    expect(res.output).toContain('HTTP 404');
  });

  it('oversize download (>10MB) degrades friendly', async () => {
    const fetchBinary: BinaryFetcher = async () => binaryFixture({ buffer: Buffer.alloc(ANALYZE_IMAGE_MAX_DOWNLOAD_BYTES + 1) });
    const res = await handler({ fetchBinary })(ctx({ imageUrl: IMAGE_URL, prompt: 'x' }, '/proj/alpha'));
    expect(res.output).toContain('过大');
    expect(runVisionAnalysis).not.toHaveBeenCalled();
  });

  it('transport failure degrades friendly with fallback guidance', async () => {
    const fetchBinary: BinaryFetcher = async () => { throw new Error('boom'); };
    const res = await handler({ fetchBinary })(ctx({ imageUrl: IMAGE_URL, prompt: 'x' }, '/proj/alpha'));
    expect(res.output).toContain('下载图片失败');
    expect(res.output).toContain('imagePath');
  });
});

// ── Params + never-throws belt-and-suspenders ──

describe('analyze_image handler — params + kernel failure', () => {
  it('missing prompt / missing source / both blank → invalid-params output', async () => {
    const h = handler();
    const noPrompt = await h(ctx({ imagePath: 'a.png' }, '/proj/alpha'));
    expect(noPrompt.output).toContain('参数无效');
    const noSource = await h(ctx({ prompt: 'x' }, '/proj/alpha'));
    expect(noSource.output).toContain('参数无效');
    const blank = await h(ctx({ imagePath: '', imageUrl: ' ', prompt: 'x' }, '/proj/alpha'));
    expect(blank.output).toContain('参数无效');
  });

  it('local path takes precedence over url when both are given', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'analyze-image-prio-'));
    try {
      writeFileSync(path.join(projectDir, 'local.png'), pngBytes());
      const fetchBinary = vi.fn(async () => binaryFixture());
      const analyze = vi.fn(async () => visionResult('本地赢了'));

      const res = await handler({ fetchBinary, analyze })(ctx({ imagePath: 'local.png', imageUrl: IMAGE_URL, prompt: 'x' }, projectDir));

      expect(fetchBinary).not.toHaveBeenCalled();
      expect(res.metadata).toMatchObject({ source: 'local.png' });
      expect(res.output).toContain('本地赢了');
    } finally {
      rmBestEffort(projectDir);
    }
  });

  it('kernel throwing still degrades friendly (belt-and-suspenders, R8)', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'analyze-image-throw-'));
    try {
      writeFileSync(path.join(projectDir, 'ref.png'), pngBytes());
      const analyze = vi.fn(async () => { throw new Error('kernel blew up'); });

      const res = await handler({ analyze })(ctx({ imagePath: 'ref.png', prompt: 'x' }, projectDir));
      expect(res.output).toContain('视觉分析失败');
    } finally {
      rmBestEffort(projectDir);
    }
  });
});
