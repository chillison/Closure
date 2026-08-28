import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
import { generateText, generateImage, generateEmbeddings, ProtocolHttpError } from '../src';

const ORIGINAL_FETCH = globalThis.fetch;

type CapturedCall = { url: string; init?: RequestInit };

function buildMock(captured: CapturedCall[], body: unknown, status = 200) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'gpt-4o',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk-test',
    capability: 'text',
    ...overrides,
  };
}

describe('unified protocol', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  describe('generateText', () => {
    it('posts to /chat/completions with Bearer auth', async () => {
      globalThis.fetch = buildMock(captured, {
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });

      const result = await generateText(model(), {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        maxTokens: 256,
      });

      expect(captured[0].url).toBe('https://api.openai.com/v1/chat/completions');
      const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
      expect(body.model).toBe('gpt-4o');
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(result.text).toBe('hello');
      expect(result.finishReason).toBe('stop');
      expect(result.usage?.totalTokens).toBe(30);
    });

    it('throws ProtocolHttpError on non-2xx', async () => {
      globalThis.fetch = buildMock(captured, { error: { message: 'bad key' } }, 401);
      await expect(
        generateText(model(), { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
      ).rejects.toBeInstanceOf(ProtocolHttpError);
    });

    it('posts Anthropic-compatible text requests to /messages with x-api-key auth', async () => {
      globalThis.fetch = buildMock(captured, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-latest',
        content: [{ type: 'text', text: 'hello from claude' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 7 },
      });

      const result = await generateText(
        model({
          protocol: 'anthropic-compatible',
          modelId: 'claude-3-5-sonnet-latest',
          baseUrl: 'https://api.anthropic.com',
        }),
        {
          model: 'claude-3-5-sonnet-latest',
          messages: [
            { role: 'system', content: 'You are concise.' },
            { role: 'user', content: 'hi' },
          ],
          maxTokens: 256,
        },
      );

      expect(captured[0].url).toBe('https://api.anthropic.com/v1/messages');
      const headers = captured[0].init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-test');
      expect(headers['anthropic-version']).toBeTruthy();
      expect(headers.authorization).toBeUndefined();
      const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
      expect(body).toMatchObject({
        model: 'claude-3-5-sonnet-latest',
        system: 'You are concise.',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result).toEqual({
        model: 'claude-3-5-sonnet-latest',
        text: 'hello from claude',
        finishReason: 'stop',
        usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      });
    });

    it('defaults anthropic max_tokens to the 32768 guardrail when omitted (dogfood T1 D2)', async () => {
      globalThis.fetch = buildMock(captured, {
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-latest',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      await generateText(
        model({
          protocol: 'anthropic-compatible',
          modelId: 'claude-3-5-sonnet-latest',
          baseUrl: 'https://api.anthropic.com',
        }),
        {
          model: 'claude-3-5-sonnet-latest',
          messages: [{ role: 'user', content: 'write a chapter' }],
        },
      );

      const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
      expect(body.max_tokens).toBe(32768);
    });
  });

  describe('generateImage', () => {
    it('posts to /images/generations for prompt-only requests', async () => {
      globalThis.fetch = buildMock(captured, {
        data: [{ b64_json: 'AAAA' }],
      });

      const result = await generateImage(
        model({ modelId: 'dall-e-3', capability: 'image' }),
        { model: 'dall-e-3', prompt: 'a cat' },
      );

      expect(captured[0].url).toBe('https://api.openai.com/v1/images/generations');
      expect(result.images[0].b64Json).toBe('AAAA');
    });

    it('posts to /images/edits when image is provided', async () => {
      globalThis.fetch = buildMock(captured, {
        data: [{ b64_json: 'BBBB' }],
      });

      await generateImage(
        model({ modelId: 'gpt-image-1', capability: 'image' }),
        { model: 'gpt-image-1', prompt: 'edit', image: { b64Json: 'YWJj', mimeType: 'image/png' } },
      );

      expect(captured[0].url).toBe('https://api.openai.com/v1/images/edits');
    });
  });

  describe('generateEmbeddings', () => {
    it('posts to /embeddings with Bearer auth and maps data[] in input order', async () => {
      globalThis.fetch = buildMock(captured, {
        model: 'text-embedding-3-small',
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      });

      const result = await generateEmbeddings(
        model({ modelId: 'text-embedding-3-small' }),
        { input: ['first text', 'second text'] },
      );

      expect(captured[0].url).toBe('https://api.openai.com/v1/embeddings');
      const headers = captured[0].init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sk-test');
      const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
      expect(body).toEqual({ model: 'text-embedding-3-small', input: ['first text', 'second text'] });
      expect(result.model).toBe('text-embedding-3-small');
      expect(result.embeddings).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
      expect(result.usage).toEqual({ promptTokens: 7, totalTokens: 7 });
    });

    it('throws ProtocolHttpError on non-2xx', async () => {
      globalThis.fetch = buildMock(captured, { error: { message: 'bad key' } }, 401);
      await expect(
        generateEmbeddings(model(), { input: ['x'] }),
      ).rejects.toBeInstanceOf(ProtocolHttpError);
    });
  });

});

// ── Story 3.6 vision seam: user-message parts → dual-protocol wire shapes ──
describe('vision seam parts mapping (Story 3.6)', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('openai-compatible: image part serializes as image_url data URL, text part stays text', async () => {
    globalThis.fetch = buildMock(captured, {
      choices: [{ index: 0, message: { role: 'assistant', content: '一只猫' }, finish_reason: 'stop' }],
    });

    const result = await generateText(model(), {
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张图里是什么？' },
          { type: 'image', image: { b64Json: 'YWJj', mimeType: 'image/png' } },
        ],
      }],
    });

    expect(result.text).toBe('一只猫');
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里是什么？' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
      ],
    }]);
  });

  it('openai-compatible: pure string messages serialize byte-identically (zero regression)', async () => {
    globalThis.fetch = buildMock(captured, {
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });

    await generateText(model(), {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'hi' },
      ],
    });

    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    // The AI SDK re-injects the hoisted system message into the wire messages
    // array (OpenAI has no top-level system param). The user message stays a
    // plain string — exactly the pre-parts wire body.
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('anthropic-compatible: image part serializes as base64 image block', async () => {
    globalThis.fetch = buildMock(captured, {
      content: [{ type: 'text', text: '一只猫' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await generateText(
      model({ protocol: 'anthropic-compatible', modelId: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com' }),
      {
        model: 'claude-3-5-sonnet-latest',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', image: { b64Json: 'YWJj', mimeType: 'image/jpeg' } },
            { type: 'text', text: '这张图里是什么？' },
          ],
        }],
        maxTokens: 128,
      },
    );

    expect(result.text).toBe('一只猫');
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'YWJj' } },
        { type: 'text', text: '这张图里是什么？' },
      ],
    }]);
  });

  it('anthropic-compatible: pure string messages serialize byte-identically (zero regression)', async () => {
    globalThis.fetch = buildMock(captured, {
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });

    await generateText(
      model({ protocol: 'anthropic-compatible', modelId: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com' }),
      {
        model: 'claude-3-5-sonnet-latest',
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: 'hi' },
        ],
        maxTokens: 128,
      },
    );

    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    // String user content stays a plain string (not wrapped in a blocks array)
    // — exactly the pre-parts wire body.
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.system).toBe('You are concise.');
  });
});
