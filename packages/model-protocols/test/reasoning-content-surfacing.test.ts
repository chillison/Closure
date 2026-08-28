import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
import { generateText, generateTextStream } from '../src';
import type { GenerationDelta } from '../src';
import { withReasoningContentSurfacing } from '../src/generate';

// dogfood R2 #7 (2026-08-25): `reasoning_content` surfacing on the
// OpenAI-compatible path. Root cause under test: GLM/Kimi/DeepSeek stream
// vendor reasoning as a separate SSE field that @ai-sdk/openai's chunk zod
// boundary strips — during the whole reasoning phase the SDK emitted ZERO
// parts (UI blackout + 240s first-event watchdog false-killing healthy
// streams). The fix is a fetch-level transform folding `reasoning_content`
// into `<think>`-wrapped content deltas ahead of extractReasoningMiddleware.

const ORIGINAL_FETCH = globalThis.fetch;

type CapturedCall = { url: string; init?: RequestInit };
type Responder = (call: CapturedCall) => Response;

function deepseekModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'deepseek-v4-pro',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    capability: 'text',
    thinkingKind: 'deepseek-v4',
    limits: { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
    ...overrides,
  };
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function chunkLine(delta: Record<string, unknown>, finishReason: unknown = null): string {
  return (
    `data: ${JSON.stringify({
      id: 'x',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`
  );
}

const DONE = 'data: [DONE]\n\n';

/** Wire-shaped reasoning phase: content stays null, reasoning rides its own field. */
function reasoningChunk(text: string, first = false): string {
  return chunkLine(
    first ? { role: 'assistant', content: null, reasoning_content: text } : { content: null, reasoning_content: text },
  );
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('OpenAI streaming: reasoning_content surfacing (dogfood R2 #7)', () => {
  it('emits reasoning deltas then clean text deltas for a reasoning_content stream', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> =>
      sseResponse([
        reasoningChunk('', true), // role chunk with empty reasoning (DeepSeek's opening frame)
        reasoningChunk('Let'),
        'data: {"choices":[{"index":0,"delta":{"content":null,"reasoning_content":" me think"},"finish_reason":null}]}' + '\n\n',
        chunkLine({ content: 'Hello' }),
        chunkLine({ content: ' world' }, 'stop'),
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}' + '\n\n',
        DONE,
      ]),
    );
    const deltas: GenerationDelta[] = [];
    const res = await generateTextStream(
      deepseekModel(),
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], lane: 'background' },
      { lane: 'background' },
      (d) => deltas.push(d),
    );
    const reasoning = deltas.filter((d) => d.type === 'reasoning').map((d) => d.delta).join('');
    const text = deltas.filter((d) => d.type === 'text').map((d) => d.delta).join('');
    expect(reasoning).toBe('Let me think');
    expect(text).toBe('Hello world');
    expect(res.text).toBe('Hello world');
    expect(res.reasoning).toBe('Let me think');
    expect(res.finishReason).toBe('stop');
  });

  it('closes the think block before tool_calls flow (child-agent dispatch shape)', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> =>
      sseResponse([
        reasoningChunk('planning', true),
        reasoningChunk(' the outline'),
        chunkLine({
          content: null,
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'outline_update', arguments: '{"outline":' } },
          ],
        }),
        chunkLine({
          content: null,
          tool_calls: [
            { index: 0, function: { arguments: '1}' } },
          ],
        }, 'tool_calls'),
        DONE,
      ]),
    );
    const deltas: GenerationDelta[] = [];
    const res = await generateTextStream(
      deepseekModel(),
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'plan' }], lane: 'background' },
      { lane: 'background' },
      (d) => deltas.push(d),
    );
    expect(deltas.filter((d) => d.type === 'reasoning').map((d) => d.delta).join('')).toBe('planning the outline');
    expect(deltas.filter((d) => d.type === 'text')).toEqual([]);
    expect(res.reasoning).toBe('planning the outline');
    expect(res.text).toBe('');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls?.[0]).toMatchObject({ id: 'call_1', name: 'outline_update' });
    expect(res.finishReason).toBe('tool_use');
  });

  it('reassembles SSE lines split across network chunk boundaries mid-JSON', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":null,"reasoning_',
        'content":"frag"},"finish_reason":null}]}',
        '\n\ndata: {"choices":[{"index":0,"delta":{"content":"done"},"fin',
        'ish_reason":"stop"}]}\n\n',
        DONE,
      ]),
    );
    const deltas: GenerationDelta[] = [];
    const res = await generateTextStream(
      deepseekModel(),
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], lane: 'background' },
      { lane: 'background' },
      (d) => deltas.push(d),
    );
    expect(deltas.filter((d) => d.type === 'reasoning').map((d) => d.delta).join('')).toBe('frag');
    expect(res.text).toBe('done');
    expect(res.reasoning).toBe('frag');
  });

  it('keeps non-reasoning streams byte-identical for gated-out vendors (unknown thinkingKind)', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> =>
      sseResponse([
        chunkLine({ role: 'assistant', content: null }),
        chunkLine({ content: 'plain' }, 'stop'),
        DONE,
      ]),
    );
    const deltas: GenerationDelta[] = [];
    const res = await generateTextStream(
      deepseekModel({ modelId: 'some-unknown-model', thinkingKind: undefined, limits: undefined }),
      { model: 'some-unknown-model', messages: [{ role: 'user', content: 'x' }], lane: 'background' },
      { lane: 'background' },
      (d) => deltas.push(d),
    );
    expect(deltas.map((d) => d.delta).join('')).toBe('plain');
    expect(res.text).toBe('plain');
    expect(res.reasoning).toBeUndefined();
  });

  it('keeps gated vendors passthrough-clean when the stream carries no reasoning_content', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> =>
      sseResponse([chunkLine({ role: 'assistant', content: null }), chunkLine({ content: 'no think here' }, 'stop'), DONE]),
    );
    const res = await generateTextStream(
      deepseekModel(),
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], lane: 'background' },
      { lane: 'background' },
      () => {},
    );
    expect(res.text).toBe('no think here');
    expect(res.reasoning).toBeUndefined();
  });
});

describe('OpenAI non-streaming: reasoning_content folding (dogfood R2 #7)', () => {
  it('folds message.reasoning_content into reasoning + clean text', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          model: 'deepseek-v4-pro',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'The answer', reasoning_content: 'because of reasons' },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await generateText(deepseekModel(), {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.text).toBe('The answer');
    expect(res.reasoning).toBe('because of reasons');
  });

  it('passes JSON without reasoning_content through untouched', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'plain' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await generateText(deepseekModel(), {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.text).toBe('plain');
    expect(res.reasoning).toBeUndefined();
  });
});

// ── Wrapper boundary hardening (dogfood R2 CR-40 / CR-41) ──
//
// Direct unit tests on the fetch wrapper: the SDK path always supplies a
// parseable string body and well-formed frames, so the boundary shapes
// (non-string bodies, array message content, stale content-length, gateway
// empty-openers, truncated SSE tails) need direct invocation.

describe('withReasoningContentSurfacing boundary hardening (CR-40)', () => {
  it('detects SSE by the RESPONSE content-type when init.body is not a string (CR-40①)', async () => {
    // A stream-shaped body (or any non-string body) made the old request-body
    // sniff leave `streaming` false → the SSE transform never engaged.
    const encoder = new TextEncoder();
    const inner: typeof globalThis.fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(reasoningChunk('inner')));
          controller.enqueue(encoder.encode(chunkLine({ content: 'answer' }, 'stop')));
          controller.enqueue(encoder.encode(DONE));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'content-length': '999' },
      });
    };
    const res = await withReasoningContentSurfacing(inner)('https://x.test/v1/chat/completions', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>(),
    });
    const out = await res.text();
    expect(out).toContain('<think>inner');
    expect(out).toContain('</think>');
    expect(out).toContain('answer');
    expect(out).not.toContain('"reasoning_content":"inner"'); // folded away, not passed through
    // CR-40③ (streaming rebuild): the rewrite changed the body — the stale
    // content-length must not survive onto the rebuilt Response.
    expect(res.headers.get('content-length')).toBeNull();
  });

  it('never template-stringifies array-shaped message.content in JSON responses (CR-40②)', async () => {
    const original = JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'multimodal part' }],
            reasoning_content: 'inner',
          },
        },
      ],
    });
    const inner: typeof globalThis.fetch = async () =>
      new Response(original, { status: 200, headers: { 'content-type': 'application/json' } });
    const res = await withReasoningContentSurfacing(inner)('https://x.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: false }),
    });
    const parsed = JSON.parse(await res.text()) as {
      choices: Array<{ message: { content: unknown; reasoning_content?: unknown } }>;
    };
    // Non-string content shape: verbatim passthrough — the old code turned it
    // into `<think>inner</think>[object Object]`.
    expect(Array.isArray(parsed.choices[0]!.message.content)).toBe(true);
    expect((parsed.choices[0]!.message.content as Array<{ text: string }>)[0]!.text).toBe('multimodal part');
    expect(parsed.choices[0]!.message.reasoning_content).toBe('inner');
  });

  it('drops the stale content-length header when folding reasoning into a JSON body (CR-40③)', async () => {
    const original = JSON.stringify({
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ans', reasoning_content: 'why' } },
      ],
    });
    const inner: typeof globalThis.fetch = async () =>
      new Response(original, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(original.length) },
      });
    const res = await withReasoningContentSurfacing(inner)('https://x.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: false }),
    });
    expect(res.headers.get('content-length')).toBeNull(); // body length changed → header is stale
    const text = await res.text();
    expect(text.length).not.toBe(original.length);
    expect((JSON.parse(text) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe(
      '<think>why</think>ans',
    );
  });
});

describe('rewriteSseLine boundaries (CR-41)', () => {
  it('an empty reasoning_content chunk passes through verbatim — no <think> opened (CR-41①)', async () => {
    // Some gateways emit the reasoning phase's opening frame with an EMPTY
    // reasoning_content field; the old code opened <think> on it.
    const inner: typeof globalThis.fetch = async () =>
      sseResponse([
        chunkLine({ role: 'assistant', content: null, reasoning_content: '' }),
        chunkLine({ content: 'Hello' }, 'stop'),
        DONE,
      ]);
    const res = await withReasoningContentSurfacing(inner)('https://x.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
    });
    const out = await res.text();
    expect(out).not.toContain('<think');
    expect(out).not.toContain('</think');
    expect(out).toContain('"reasoning_content":""'); // byte-identical passthrough
    expect(out).toContain('Hello');
  });

  it('flush-synthesized closing lands as its own SSE event after a non-blank terminal data line (CR-41②)', async () => {
    const encoder = new TextEncoder();

    async function collectTruncatedTail(rawTail: string): Promise<string> {
      const inner: typeof globalThis.fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(rawTail));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      const res = await withReasoningContentSurfacing(inner)('https://x.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ stream: true }),
      });
      return res.text();
    }

    // Shape A: terminal data line carries a line terminator but NO blank line
    // (transform already emitted it). Shape B: no terminator at all (line sits
    // in the flush buffer). Both used to let the synthetic closing merge into
    // the terminal event — SSE joins consecutive data: lines into one frame.
    for (const tail of [
      reasoningChunk('partialA').replace(/\n\n$/, '\n'),
      reasoningChunk('partialB').replace(/\n\n$/, ''),
    ]) {
      const out = await collectTruncatedTail(tail);
      expect(out).toContain('<think>partial');
      expect(out).toContain('</think>');
      expect(out).toContain('\n\ndata: '); // blank line separates the closing event
      const events = out.split('\n\n').filter((ev) => ev.trim() !== '');
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (const event of events) {
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        expect(() => JSON.parse(data)).not.toThrow(); // never a merged two-frame blob
      }
    }
  });
});
