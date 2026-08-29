/**
 * Vision seam kernel tests (Story 3.6 WP1, R9/R9b, design D2-D5).
 *
 * Covers: magic-byte format sniffing + media_type strict-match guard,
 * downscaling (>5MB / long edge >1568), the three-layer dispatch (visionModel
 * direct call / manual export when unconfigured — never a blind main-model
 * call / generation-failure degradation), and the silent-strip canary probe.
 *
 * All externals mocked: electron (nativeImage/clipboard), configIpc (config
 * disk read), modelGatewayIpc (ref resolution), @orison/model-protocols
 * (generation), logger.
 */
import { existsSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { nativeImage, clipboard, readModelConfigFromDisk, resolveModel, generateText, warn } = vi.hoisted(() => ({
  nativeImage: { createFromBuffer: vi.fn() },
  clipboard: { writeImage: vi.fn() },
  readModelConfigFromDisk: vi.fn(),
  resolveModel: vi.fn(),
  generateText: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({ nativeImage, clipboard }));
vi.mock('../main/ipc/configIpc', () => ({ readModelConfigFromDisk }));
vi.mock('../main/ipc/modelGatewayIpc', () => ({ resolveModel }));
vi.mock('@orison/model-protocols', () => ({ generateText }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info: vi.fn() }) }));

import {
  CANARY_EXPECTED_CHAR,
  CANARY_IMAGE_B64,
  CANARY_PROMPT,
  VISION_MAX_EDGE,
  canaryProbeVision,
  prepareVisionImage,
  runVisionAnalysis,
  sniffImageFormat,
} from '../main/research/visionAnalysis';

// ── Fixtures ──

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REENCODED_PNG = Buffer.concat([PNG_MAGIC, Buffer.from('re-encoded-png-bytes')]);

function pngBytes(padding = 64): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(padding, 7)]);
}

function jpegBytes(padding = 64): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(padding, 7)]);
}

/** Controllable nativeImage stand-in (empty probe / size probe / resize / toPNG). */
function makeImage(opts: { width?: number; height?: number; empty?: boolean } = {}) {
  const size = { width: opts.width ?? 64, height: opts.height ?? 64 };
  const img = {
    isEmpty: () => opts.empty === true,
    getSize: () => ({ ...size }),
    resize: vi.fn(() => img),
    toPNG: () => REENCODED_PNG,
  };
  return img;
}

const RESOLVED_VISION_MODEL = {
  keyId: 'k1',
  modelId: 'qwen-vl-max',
  protocol: 'openai-compatible' as const,
  baseUrl: 'https://relay.example.com/v1',
  apiKey: 'sk-test',
  capability: 'text' as const,
};

const TEST_PROJECT_DIR = path.join(process.cwd(), 'test-tmp-vision-media');

beforeEach(() => {
  vi.clearAllMocks();
  nativeImage.createFromBuffer.mockReset().mockReturnValue(makeImage());
  rmBestEffort(TEST_PROJECT_DIR);
});

afterEach(() => {
  rmBestEffort(TEST_PROJECT_DIR);
});

// ── Format sniffing (pure) ──

describe('sniffImageFormat', () => {
  it('detects all four whitelisted formats by magic bytes', () => {
    expect(sniffImageFormat(pngBytes())).toBe('png');
    expect(sniffImageFormat(jpegBytes())).toBe('jpeg');
    expect(sniffImageFormat(Buffer.from('GIF89a rest-of-gif'))).toBe('gif');
    expect(sniffImageFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('webp');
  });

  it('returns null for non-whitelisted / unknown / truncated bytes', () => {
    expect(sniffImageFormat(Buffer.from('BM windows-bitmap'))).toBeNull(); // bmp
    expect(sniffImageFormat(Buffer.alloc(32, 7))).toBeNull();
    expect(sniffImageFormat(Buffer.from([0x89, 0x50]))).toBeNull(); // truncated png magic
  });
});

// ── Pre-validation: media_type guard + downscale ──

describe('prepareVisionImage', () => {
  it('corrects a mismatched declared mimeType to the sniffed format (media_type always matches bytes)', () => {
    const prepared = prepareVisionImage(pngBytes().toString('base64'), 'image/jpeg');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.mimeType).toBe('image/png');
    expect(prepared.note).toBeTruthy();
  });

  it('keeps a matching declaration untouched', () => {
    const prepared = prepareVisionImage(pngBytes().toString('base64'), 'image/png');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.mimeType).toBe('image/png');
    expect(prepared.note).toBeUndefined();
  });

  it('rejects non-whitelisted formats with a friendly reason', () => {
    const prepared = prepareVisionImage(Buffer.from('BM bitmap').toString('base64'), 'image/bmp');
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason).toContain('jpeg/png/gif/webp');
  });

  it('downscales when the long edge exceeds 1568 (re-encoded PNG, mimeType matches by construction)', () => {
    const img = makeImage({ width: 3000, height: 2000 });
    nativeImage.createFromBuffer.mockReturnValue(img);
    const prepared = prepareVisionImage(jpegBytes().toString('base64'), 'image/jpeg');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(img.resize).toHaveBeenCalledWith({ width: VISION_MAX_EDGE }); // width >= height → only width given (aspect preserved)
    expect(prepared.buffer).toBe(REENCODED_PNG);
    expect(prepared.mimeType).toBe('image/png');
  });

  it('resizes by height when the height is the long edge', () => {
    const img = makeImage({ width: 800, height: 4000 });
    nativeImage.createFromBuffer.mockReturnValue(img);
    const prepared = prepareVisionImage(jpegBytes().toString('base64'), 'image/jpeg');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(img.resize).toHaveBeenCalledWith({ height: VISION_MAX_EDGE });
    expect(prepared.mimeType).toBe('image/png');
  });

  it('re-encodes oversized (>5MB) but dimension-valid images', () => {
    const bigBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(6 * 1024 * 1024, 3)]);
    nativeImage.createFromBuffer.mockReturnValue(makeImage({ width: 800, height: 600 }));
    const prepared = prepareVisionImage(bigBytes.toString('base64'), 'image/png');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.buffer).toBe(REENCODED_PNG);
    expect(prepared.mimeType).toBe('image/png');
  });

  it('fails friendly when oversized AND undecodable (no way to shrink without new deps)', () => {
    const bigBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(6 * 1024 * 1024, 3)]);
    nativeImage.createFromBuffer.mockReturnValue(makeImage({ empty: true }));
    const prepared = prepareVisionImage(bigBytes.toString('base64'), 'image/png');
    expect(prepared.ok).toBe(false);
  });

  it('passes through decodable-but-small images as original bytes', () => {
    const bytes = pngBytes(128);
    nativeImage.createFromBuffer.mockReturnValue(makeImage({ width: 512, height: 512 }));
    const prepared = prepareVisionImage(bytes.toString('base64'), 'image/png');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.buffer).toEqual(bytes); // content-equal (base64 re-decode always allocates)
    expect(prepared.mimeType).toBe('image/png');
  });

  it('rejects empty image data', () => {
    const prepared = prepareVisionImage('', 'image/png');
    expect(prepared.ok).toBe(false);
  });
});

// ── Three-layer dispatch (R9b) ──

describe('runVisionAnalysis', () => {
  it('layer 1: configured visionModel → parts message via the model, corrected mimeType on the wire', async () => {
    readModelConfigFromDisk.mockReturnValue({
      keys: [],
      visionModel: { keyId: 'k1', modelId: 'qwen-vl-max' },
    });
    resolveModel.mockReturnValue(RESOLVED_VISION_MODEL);
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '一只戴着兜帽的猫' });

    // declared mimeType deliberately mismatches the png bytes — the wire part
    // must carry the sniffed/corrected media_type (Anthropic-400 guard).
    const result = await runVisionAnalysis({
      imageB64: pngBytes().toString('base64'),
      mimeType: 'image/webp',
      prompt: '这张图里是什么？',
      projectDir: TEST_PROJECT_DIR,
    });

    expect(result).toEqual({ mode: 'vision', text: '一只戴着兜帽的猫' });
    expect(resolveModel).toHaveBeenCalledWith(
      { keyId: 'k1', modelId: 'qwen-vl-max' },
      expect.objectContaining({ visionModel: { keyId: 'k1', modelId: 'qwen-vl-max' } }),
    );
    expect(generateText).toHaveBeenCalledTimes(1);
    const [, request] = generateText.mock.calls[0];
    expect(request.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里是什么？' },
        { type: 'image', image: { b64Json: pngBytes().toString('base64'), mimeType: 'image/png' } },
      ],
    }]);
  });

  it('layer 2: no visionModel → manual export (never blind-calls the main model)', async () => {
    readModelConfigFromDisk.mockReturnValue({ keys: [] });

    const result = await runVisionAnalysis({
      imageB64: pngBytes().toString('base64'),
      mimeType: 'image/png',
      prompt: '这张图里是什么？',
      projectDir: TEST_PROJECT_DIR,
    });

    expect(result.mode).toBe('manual');
    if (result.mode !== 'manual') return;
    expect(result.suggestedPrompt).toBe('这张图里是什么？');
    expect(result.images).toHaveLength(1);
    const saved = result.images[0];
    expect(saved.startsWith(path.join(TEST_PROJECT_DIR, '.orison', 'research-media'))).toBe(true);
    expect(saved.endsWith('.png')).toBe(true);
    expect(existsSync(saved)).toBe(true);
    expect(clipboard.writeImage).toHaveBeenCalledTimes(1);
    expect(generateText).not.toHaveBeenCalled(); // red line: main model never tried
  });

  it('unresolvable visionModel ref degrades to manual export (graceful, R8)', async () => {
    readModelConfigFromDisk.mockReturnValue({
      keys: [],
      visionModel: { keyId: 'gone', modelId: 'qwen-vl-max' },
    });
    resolveModel.mockImplementation(() => {
      throw new Error("Model ref points to unknown key 'gone'");
    });

    const result = await runVisionAnalysis({
      imageB64: pngBytes().toString('base64'),
      mimeType: 'image/png',
      prompt: '分析',
      projectDir: TEST_PROJECT_DIR,
    });

    expect(result.mode).toBe('manual');
    expect(generateText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('layer 3-ish: generation failure degrades to manual export, never throws', async () => {
    readModelConfigFromDisk.mockReturnValue({
      keys: [],
      visionModel: { keyId: 'k1', modelId: 'qwen-vl-max' },
    });
    resolveModel.mockReturnValue(RESOLVED_VISION_MODEL);
    generateText.mockRejectedValue(new Error('endpoint 502'));

    const result = await runVisionAnalysis({
      imageB64: pngBytes().toString('base64'),
      mimeType: 'image/png',
      prompt: '分析',
      projectDir: TEST_PROJECT_DIR,
    });

    expect(result.mode).toBe('manual');
    if (result.mode !== 'manual') return;
    expect(existsSync(result.images[0])).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('invalid image bytes → friendly failure message, no throw, no export', async () => {
    readModelConfigFromDisk.mockReturnValue({
      keys: [],
      visionModel: { keyId: 'k1', modelId: 'qwen-vl-max' },
    });
    resolveModel.mockReturnValue(RESOLVED_VISION_MODEL);

    const result = await runVisionAnalysis({
      imageB64: Buffer.from('BM not-a-vision-format').toString('base64'),
      mimeType: 'image/bmp',
      prompt: '分析',
      projectDir: TEST_PROJECT_DIR,
    });

    expect(result).toEqual({ mode: 'vision', text: expect.stringContaining('预处理失败') });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('manual export saves raw bytes under the sniffed extension when nativeImage cannot decode', async () => {
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    nativeImage.createFromBuffer.mockReturnValue(makeImage({ empty: true }));

    const webpBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32, 5)]);
    const result = await runVisionAnalysis({
      imageB64: webpBytes.toString('base64'),
      mimeType: 'image/webp',
      prompt: '分析',
      projectDir: TEST_PROJECT_DIR,
    });

    expect(result.mode).toBe('manual');
    if (result.mode !== 'manual') return;
    expect(result.images[0].endsWith('.webp')).toBe(true);
    expect(existsSync(result.images[0])).toBe(true);
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });
});

// ── Canary probe (D4): silent-strip detection ──

describe('canaryProbeVision', () => {
  it('canary constant is a valid 64×64 PNG (guards against constant corruption)', () => {
    const buffer = Buffer.from(CANARY_IMAGE_B64, 'base64');
    // PNG magic + IHDR width/height big-endian at bytes 16..23
    expect(buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(buffer.readUInt32BE(16)).toBe(64);
    expect(buffer.readUInt32BE(20)).toBe(64);
  });

  it('answer containing the expected character → ok', async () => {
    resolveModel.mockReturnValue(RESOLVED_VISION_MODEL);
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '闭' });

    const result = await canaryProbeVision({ keyId: 'k1', modelId: 'qwen-vl-max' });

    expect(result).toEqual({ ok: true, answer: '闭' });
    const [, request] = generateText.mock.calls[0];
    expect(request.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: CANARY_PROMPT },
        { type: 'image', image: { b64Json: CANARY_IMAGE_B64, mimeType: 'image/png' } },
      ],
    }]);
  });

  it('answer WITHOUT the character → silent-strip verdict (middleman stripped the image)', async () => {
    resolveModel.mockReturnValue(RESOLVED_VISION_MODEL);
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '抱歉，我没有收到任何图片。' });

    const result = await canaryProbeVision({ keyId: 'k1', modelId: 'qwen-vl-max' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('silent-strip');
    expect(result.message).toContain('静默剥离');
  });

  it('generation failure → generate-failed verdict (transport, not silent-strip)', async () => {
    resolveModel.mockReturnValue(RESOLVED_VISION_MODEL);
    generateText.mockRejectedValue(new Error('401 unauthorized'));

    const result = await canaryProbeVision({ keyId: 'k1', modelId: 'qwen-vl-max' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('generate-failed');
  });

  it('unresolvable ref → resolve-failed verdict, generation never attempted', async () => {
    resolveModel.mockImplementation(() => {
      throw new Error('unknown key');
    });

    const result = await canaryProbeVision({ keyId: 'gone', modelId: 'qwen-vl-max' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('resolve-failed');
    expect(generateText).not.toHaveBeenCalled();
  });
});
