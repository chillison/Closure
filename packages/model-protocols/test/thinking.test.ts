import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel, TextGenerationRequest, ThinkingControl } from '@orison/shared-contracts';
import {
  generateText,
  generateTextStream,
  ProtocolContextOverflowError,
  ProtocolHttpError,
  isContextOverflowError,
} from '../src';

// Thinking adapters task S2 — request-side injection (design §2.1 dispatch
// table), cap three-layers (design §2.2), fault tolerance (design §2.3/§4.1),
// Anthropic signature capture (B block, design §5.1), zen probe (design §2.3).
// Mock patterns mirror protocols.test.ts / streaming.test.ts.

const ORIGINAL_FETCH = globalThis.fetch;

type CapturedCall = { url: string; init?: RequestInit };
type Responder = (call: CapturedCall) => Response;

function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'gpt-4o',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.test',
    apiKey: 'sk-test',
    capability: 'text',
    ...overrides,
  };
}

function anthropicModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return model({ protocol: 'anthropic-compatible', modelId: 'claude-opus-5', ...overrides });
}

function buildMock(captured: CapturedCall[], body: unknown, status = 200) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function queuedFetch(captured: CapturedCall[], responders: Responder[]) {
  let call = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry = { url: String(input), init };
    captured.push(entry);
    const responder = responders[Math.min(call, responders.length - 1)];
    call += 1;
    return responder(entry);
  });
}

function sseResponse(chunks: string[], signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => controller.error(signal?.reason ?? new TypeError('fetch failed'));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    },
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorBody(message: string): unknown {
  return { error: { message, type: 'invalid_request_error' } };
}

function anthEvent(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function openaiChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4o',
    ...payload,
  })}\n\n`;
}

const OPENAI_DONE = 'data: [DONE]\n\n';

const OPENAI_OK = { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
const ANTHROPIC_OK = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };

const ANTHROPIC_STREAM_OK = [
  anthEvent('message_start'),
  anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
  anthEvent('content_block_stop', { index: 0 }),
  anthEvent('message_delta', { delta: { stop_reason: 'end_turn' } }),
  anthEvent('message_stop'),
];

const OPENAI_STREAM_OK = [
  openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }),
  openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  OPENAI_DONE,
];

const CLAUDE_5_LIMITS = { contextWindow: 1_048_576, maxOutputTokens: 131_072 };

// ── Thinking injection: OpenAI-compatible path (fetch body patch) ──

describe('thinking injection (openai-compatible path)', () => {
  let captured: CapturedCall[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    warnSpy.mockRestore();
  });

  function bodyOf(index = 0): Record<string, unknown> {
    return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
  }

  async function run(modelOverride: Partial<ResolvedModel>, thinking: ThinkingControl | undefined, requestExtra: Partial<TextGenerationRequest> = {}) {
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    const request: TextGenerationRequest = {
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      ...requestExtra,
    };
    if (thinking) request.thinking = thinking;
    return generateText(model(modelOverride), request);
  }

  it('glm-forced-effort medium maps to thinking enabled + reasoning_effort high (vendor lacks medium)', async () => {
    await run({ modelId: 'glm-5.3', thinkingKind: 'glm-forced-effort' }, { level: 'medium' });
    expect(bodyOf().thinking).toEqual({ type: 'enabled' });
    expect(bodyOf().reasoning_effort).toBe('high');
    expect(bodyOf().temperature).toBe(0.7); // GLM has no documented temperature lock
  });

  it('glm-forced-effort off is illegal — degraded to enabled + effort low with a warning (UI normally greys it out)', async () => {
    await run({ modelId: 'glm-5.3', thinkingKind: 'glm-forced-effort' }, { level: 'off' });
    expect(bodyOf().thinking).toEqual({ type: 'enabled' });
    expect(bodyOf().reasoning_effort).toBe('low');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('is illegal on glm-forced-effort'));
  });

  it('glm-dynamic-basic low injects the bare switch only — no reasoning_effort key', async () => {
    await run({ modelId: 'glm-4.6', thinkingKind: 'glm-dynamic-basic' }, { level: 'low' });
    expect(bodyOf().thinking).toEqual({ type: 'enabled' });
    expect('reasoning_effort' in bodyOf()).toBe(false);
    expect(bodyOf().temperature).toBe(0.7);
  });

  it('glm-dynamic-basic off injects thinking disabled', async () => {
    await run({ modelId: 'glm-4.6', thinkingKind: 'glm-dynamic-basic' }, { level: 'off' });
    expect(bodyOf().thinking).toEqual({ type: 'disabled' });
  });

  it('glm-dynamic-effort custom xhigh passes the vendor-native tier through', async () => {
    await run({ modelId: 'glm-5.2', thinkingKind: 'glm-dynamic-effort' }, { level: 'custom', custom: 'xhigh' });
    expect(bodyOf().thinking).toEqual({ type: 'enabled' });
    expect(bodyOf().reasoning_effort).toBe('xhigh');
  });

  it('kimi-k2 low: switch enabled + temperature dropped (vendor locks it)', async () => {
    await run({ modelId: 'kimi-k2.6', thinkingKind: 'kimi-k2' }, { level: 'low' });
    expect(bodyOf().thinking).toEqual({ type: 'enabled' });
    expect('temperature' in bodyOf()).toBe(false);
  });

  it('kimi-k2 off: switch disabled + temperature kept (lock applies to thinking mode)', async () => {
    await run({ modelId: 'kimi-k2.6', thinkingKind: 'kimi-k2' }, { level: 'off' });
    expect(bodyOf().thinking).toEqual({ type: 'disabled' });
    expect(bodyOf().temperature).toBe(0.7);
  });

  it('kimi-k27-forced low: switch enabled + temperature dropped; no effort field (CR-009 split from kimi-k2)', async () => {
    await run({ modelId: 'kimi-k2.7-code', thinkingKind: 'kimi-k27-forced' }, { level: 'low' });
    expect(bodyOf().thinking).toEqual({ type: 'enabled' });
    expect('reasoning_effort' in bodyOf()).toBe(false);
    expect('temperature' in bodyOf()).toBe(false);
  });

  it('kimi-k27-forced off is illegal (disabled errors at the vendor) — degraded to enabled with a warning', async () => {
    await run({ modelId: 'kimi-k2.7-code', thinkingKind: 'kimi-k27-forced' }, { level: 'off' });
    expect(bodyOf().thinking).toEqual({ type: 'enabled' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('is illegal on kimi-k27-forced'));
  });

  it('CR-006: a claude kind at an openai-compatible relay is a kind×protocol mismatch — warned once per (keyId, kind), body carries no thinking fields', async () => {
    const relayModel = { modelId: 'claude-opus-5', thinkingKind: 'claude-5' } satisfies Partial<ResolvedModel>;
    await run(relayModel, { level: 'high' });
    await run(relayModel, { level: 'high' });
    const body = bodyOf(1);
    expect('thinking' in body).toBe(false);
    expect('reasoning_effort' in body).toBe(false);
    expect('output_config' in body).toBe(false);
    const skipWarns = warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('not injectable'));
    expect(skipWarns.length).toBe(1); // once per (keyId, kind), not per request
  });

  it('kimi-k3 high: no thinking object (official guidance), effort set, max_tokens renamed, temperature dropped', async () => {
    await run({ modelId: 'kimi-k3', thinkingKind: 'kimi-k3' }, { level: 'high' });
    const body = bodyOf();
    expect('thinking' in body).toBe(false);
    expect(body.reasoning_effort).toBe('high');
    expect(body.max_completion_tokens).toBe(32_768); // default guardrail cap, renamed
    expect('max_tokens' in body).toBe(false);
    expect('temperature' in body).toBe(false);
  });

  it('kimi-k3 with explicit maxTokens keeps the cap under its new name (no k3 default clamp on explicit values)', async () => {
    await run(
      { modelId: 'kimi-k3', thinkingKind: 'kimi-k3', limits: { contextWindow: 1_048_576, maxOutputTokens: 1_048_576 } },
      { level: 'low' },
      { maxTokens: 500_000 },
    );
    expect(bodyOf().max_completion_tokens).toBe(500_000);
  });

  it('deepseek-v4 low: switch enabled + effort + temperature dropped; off: disabled, no effort, temperature kept', async () => {
    await run({ modelId: 'deepseek-v4-flash', thinkingKind: 'deepseek-v4' }, { level: 'low' });
    expect(bodyOf().thinking).toEqual({ type: 'enabled' });
    expect(bodyOf().reasoning_effort).toBe('low');
    expect('temperature' in bodyOf()).toBe(false);

    captured = [];
    await run({ modelId: 'deepseek-v4-flash', thinkingKind: 'deepseek-v4' }, { level: 'off' });
    expect(bodyOf().thinking).toEqual({ type: 'disabled' });
    expect('reasoning_effort' in bodyOf()).toBe(false);
    expect(bodyOf().temperature).toBe(0.7);
  });

  it('openai-o max pre-maps down to high; no switch parameter exists', async () => {
    await run({ modelId: 'o3', thinkingKind: 'openai-o' }, { level: 'max' });
    expect('thinking' in bodyOf()).toBe(false);
    expect(bodyOf().reasoning_effort).toBe('high');
  });

  it('gpt5 off is expressed as reasoning_effort none', async () => {
    await run({ modelId: 'gpt-5.1', thinkingKind: 'gpt5' }, { level: 'off' });
    expect(bodyOf().reasoning_effort).toBe('none');
  });

  it('gemini kind injects nothing (compat passthrough unverified — v1 expectation management only)', async () => {
    await run({ modelId: 'gemini-3-pro', thinkingKind: 'gemini' }, { level: 'high' });
    const body = bodyOf();
    expect('thinking' in body).toBe(false);
    expect('reasoning_effort' in body).toBe(false);
  });

  it('an invalid custom value is re-validated here and skipped with a warning (runtime defense)', async () => {
    await run({ modelId: 'glm-4.6', thinkingKind: 'glm-dynamic-basic' }, { level: 'custom', custom: 'bogus' });
    const body = bodyOf();
    expect('thinking' in body).toBe(false);
    expect('reasoning_effort' in body).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not valid'));
  });
});

// ── Thinking injection: Anthropic-compatible path (buildAnthropicBody tail) ──

describe('thinking injection (anthropic-compatible path)', () => {
  let captured: CapturedCall[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    warnSpy.mockRestore();
  });

  function bodyOf(index = 0): Record<string, unknown> {
    return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
  }

  async function run(modelOverride: Partial<ResolvedModel>, thinking: ThinkingControl | undefined, requestExtra: Partial<TextGenerationRequest> = {}) {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    const request: TextGenerationRequest = {
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      ...requestExtra,
    };
    if (thinking) request.thinking = thinking;
    return generateText(anthropicModel(modelOverride), request);
  }

  it('claude-5 high: adaptive + display summarized + output_config effort + temperature dropped', async () => {
    await run({ thinkingKind: 'claude-5' }, { level: 'high' });
    expect(bodyOf().thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(bodyOf().output_config).toEqual({ effort: 'high' });
    expect('temperature' in bodyOf()).toBe(false);
  });

  it('claude-5 off: thinking disabled, no output_config', async () => {
    await run({ thinkingKind: 'claude-5' }, { level: 'off' });
    expect(bodyOf().thinking).toEqual({ type: 'disabled' });
    expect('output_config' in bodyOf()).toBe(false);
  });

  it('claude-forced off is illegal — degraded to adaptive + low with a warning', async () => {
    await run({ modelId: 'claude-fable-5', thinkingKind: 'claude-forced' }, { level: 'off' });
    expect(bodyOf().thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(bodyOf().output_config).toEqual({ effort: 'low' });
    // The degraded ON-state + zero-thinking mock response also arms the zen
    // probe — expected; the assertion only pins the degradation warning.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('is illegal on claude-forced'));
  });

  it('claude-budget high: budget_tokens 16384 and max_tokens lifted to budget + 8192 above the caller cap', async () => {
    await run({ modelId: 'claude-opus-4-5', thinkingKind: 'claude-budget' }, { level: 'high' }, { maxTokens: 4096 });
    expect(bodyOf().thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 });
    expect(bodyOf().max_tokens).toBe(16_384 + 8_192); // caller cap 4096 < floor → lifted
  });

  it('claude-budget custom 8192: budget parsed numerically, max_tokens lifted to 16384', async () => {
    await run(
      { modelId: 'claude-opus-4-5', thinkingKind: 'claude-budget' },
      { level: 'custom', custom: '8192' },
      { maxTokens: 4096 },
    );
    expect(bodyOf().thinking).toEqual({ type: 'enabled', budget_tokens: 8_192 });
    expect(bodyOf().max_tokens).toBe(8_192 + 8_192);
  });

  it('claude-budget off: thinking disabled', async () => {
    await run({ modelId: 'claude-opus-4-5', thinkingKind: 'claude-budget' }, { level: 'off' }, { maxTokens: 4096 });
    expect(bodyOf().thinking).toEqual({ type: 'disabled' });
    expect(bodyOf().max_tokens).toBe(4096); // no lift when off
  });

  it('deepseek-v4 on the Anthropic endpoint speaks its OWN field names: reasoning.effort + output_config', async () => {
    await run({ modelId: 'deepseek-v4-pro', thinkingKind: 'deepseek-v4' }, { level: 'low' });
    expect(bodyOf().reasoning).toEqual({ effort: 'low' });
    expect(bodyOf().output_config).toEqual({ effort: 'low' });
    expect('thinking' in bodyOf()).toBe(false); // NOT Claude's thinking object
  });

  it('deepseek-v4 off on the Anthropic endpoint: reasoning.effort none, no output_config, temperature kept', async () => {
    await run({ modelId: 'deepseek-v4-pro', thinkingKind: 'deepseek-v4' }, { level: 'off' });
    expect(bodyOf().reasoning).toEqual({ effort: 'none' });
    expect('output_config' in bodyOf()).toBe(false);
    expect(bodyOf().temperature).toBe(0.5);
  });

  it('gemini kind at an Anthropic endpoint injects nothing', async () => {
    await run({ modelId: 'gemini-3-pro', thinkingKind: 'gemini' }, { level: 'high' });
    const body = bodyOf();
    expect('thinking' in body).toBe(false);
    expect('reasoning' in body).toBe(false);
    expect('output_config' in body).toBe(false);
  });
});

// ── Zero-regression: auto/absent controls keep the wire body byte-identical ──

describe('zero-regression: thinking auto/absent keeps the wire body byte-identical', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('openai-compatible: absent vs {level:"auto"} produce identical body strings', async () => {
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    const base = { model: 'x', messages: [{ role: 'user' as const, content: 'hi' }], temperature: 0.7, maxTokens: 1234 };
    await generateText(model({ modelId: 'glm-5.3', thinkingKind: 'glm-forced-effort' }), base);
    await generateText(model({ modelId: 'glm-5.3', thinkingKind: 'glm-forced-effort' }), { ...base, thinking: { level: 'auto' } });
    const raw0 = captured[0]?.init?.body as string;
    const raw1 = captured[1]?.init?.body as string;
    expect(raw1).toBe(raw0);
    expect('thinking' in JSON.parse(raw1)).toBe(false);
  });

  it('anthropic-compatible: absent vs {level:"auto"} produce identical body strings', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    const base = { model: 'x', messages: [{ role: 'user' as const, content: 'hi' }], temperature: 0.5, maxTokens: 1234 };
    await generateText(anthropicModel({ thinkingKind: 'claude-5' }), base);
    await generateText(anthropicModel({ thinkingKind: 'claude-5' }), { ...base, thinking: { level: 'auto' } });
    const raw0 = captured[0]?.init?.body as string;
    const raw1 = captured[1]?.init?.body as string;
    expect(raw1).toBe(raw0);
    const parsed = JSON.parse(raw1);
    expect('thinking' in parsed).toBe(false);
    expect('output_config' in parsed).toBe(false);
  });
});

// ── Cap resolution (design §2.2) ──

describe('cap resolution (design §2.2)', () => {
  let captured: CapturedCall[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    warnSpy.mockRestore();
  });

  function bodyOf(index = 0): Record<string, unknown> {
    return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
  }

  it('streaming tops out at the model output ceiling (openai-compatible)', async () => {
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(OPENAI_STREAM_OK, call.init?.signal)]);
    await generateTextStream(
      model({ modelId: 'glm-5.3', thinkingKind: 'glm-forced-effort', limits: CLAUDE_5_LIMITS }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    expect(bodyOf().max_tokens).toBe(131_072);
  });

  it('streaming tops out at the model output ceiling (anthropic-compatible)', async () => {
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(ANTHROPIC_STREAM_OK, call.init?.signal)]);
    await generateTextStream(
      anthropicModel({ thinkingKind: 'claude-5', limits: CLAUDE_5_LIMITS }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    expect(bodyOf().max_tokens).toBe(131_072);
  });

  it('an explicit maxTokens above the ceiling is clamped to it (streaming)', async () => {
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(OPENAI_STREAM_OK, call.init?.signal)]);
    await generateTextStream(
      model({ modelId: 'glm-5.3', thinkingKind: 'glm-forced-effort', limits: CLAUDE_5_LIMITS }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 200_000 },
      undefined,
      () => {},
    );
    expect(bodyOf().max_tokens).toBe(131_072);
  });

  it('streaming with an UNKNOWN model (no registry limits) keeps the 32K guardrail fallback', async () => {
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(OPENAI_STREAM_OK, call.init?.signal)]);
    await generateTextStream(
      model({ modelId: 'mystery-model' }), // no thinkingKind, no limits
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    expect(bodyOf().max_tokens).toBe(32_768); // unknown → guardrail, not uncapped
  });

  it('non-streaming stays at the bounded 32K guardrail even for known-limits models (#50)', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(
      anthropicModel({ thinkingKind: 'claude-5', limits: CLAUDE_5_LIMITS }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(bodyOf().max_tokens).toBe(32_768);
  });

  it('non-streaming clamps an explicit maxTokens to the model ceiling', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(
      anthropicModel({ thinkingKind: 'claude-5', limits: CLAUDE_5_LIMITS }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 200_000 },
    );
    expect(bodyOf().max_tokens).toBe(131_072);
  });

  it('kimi-k3 default streaming cap clamps to 262144 (ceiling == context window → hour-level generations)', async () => {
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(OPENAI_STREAM_OK, call.init?.signal)]);
    await generateTextStream(
      model({ modelId: 'kimi-k3', thinkingKind: 'kimi-k3', limits: { contextWindow: 1_048_576, maxOutputTokens: 1_048_576 } }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'low' } },
      undefined,
      () => {},
    );
    expect(bodyOf().max_completion_tokens).toBe(262_144); // clamped AND renamed
    expect('max_tokens' in bodyOf()).toBe(false);
  });

  it('CR-010: the kimi-k3 rename also applies with NO thinking control — the auto-mode top-out already breaks byte parity there', async () => {
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(OPENAI_STREAM_OK, call.init?.signal)]);
    await generateTextStream(
      model({ modelId: 'kimi-k3', thinkingKind: 'kimi-k3', limits: { contextWindow: 1_048_576, maxOutputTokens: 1_048_576 } }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] }, // no thinking key at all
      undefined,
      () => {},
    );
    // The raised 262,144 cap rides under the vendor's CURRENT parameter name —
    // sending it as max_tokens is not a documented K3 request shape.
    expect(bodyOf().max_completion_tokens).toBe(262_144);
    expect('max_tokens' in bodyOf()).toBe(false);
    expect('thinking' in bodyOf()).toBe(false); // rename-only patch: no thinking injection
    expect('reasoning_effort' in bodyOf()).toBe(false);
  });

  it('CR-007: explicit maxTokens below the thinking floor is raised to it with a warning (claude-5 high → 64K)', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(
      anthropicModel({ thinkingKind: 'claude-5', limits: CLAUDE_5_LIMITS }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8_192, thinking: { level: 'high' } },
    );
    expect(bodyOf().max_tokens).toBe(64_000); // floor wins over the explicit umbrella
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('thinking floor'));
  });

  it('CR-007: the same floor applies on the streaming path (not just non-streaming)', async () => {
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(ANTHROPIC_STREAM_OK, call.init?.signal)]);
    await generateTextStream(
      anthropicModel({ thinkingKind: 'claude-5', limits: CLAUDE_5_LIMITS }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8_192, thinking: { level: 'high' } },
      undefined,
      () => {},
    );
    expect(bodyOf().max_tokens).toBe(64_000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('thinking floor'));
  });

  it('CR-007: no floor when thinking is off/auto/absent — the explicit cap rides unchanged', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(
      anthropicModel({ thinkingKind: 'claude-5', limits: CLAUDE_5_LIMITS }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8_192, thinking: { level: 'off' } },
    );
    expect(bodyOf().max_tokens).toBe(8_192);
    expect(warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('thinking floor'))).toHaveLength(0);
  });

  it('CR-007: kimi-k3 floor (16K) lifts a too-small explicit cap under the renamed parameter', async () => {
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    await generateText(
      model({ modelId: 'kimi-k3', thinkingKind: 'kimi-k3' }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8_192, thinking: { level: 'low' } },
    );
    expect(bodyOf().max_completion_tokens).toBe(16_000);
    expect('max_tokens' in bodyOf()).toBe(false);
  });

  it('degradation to non-streaming clamps an explicit maxTokens to 32K unconditionally (guardrailApplied=false case)', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('stream is not supported'), 400),
      () => jsonResponse(ANTHROPIC_OK, 200),
    ]);
    const result = await generateTextStream(
      anthropicModel({ thinkingKind: 'claude-5', limits: CLAUDE_5_LIMITS }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 131_072 },
      undefined,
      () => {},
    );
    expect(captured.length).toBe(2);
    expect(bodyOf(0).max_tokens).toBe(131_072); // stream attempt at the explicit cap
    expect(bodyOf(1).max_tokens).toBe(32_768); // degraded call clamped (#50 defense)
    expect(result.text).toBe('ok');
  });
});

// ── Thinking-param rejection retry (design §2.3 backstop) ──

describe('thinking-param rejection retry (design §2.3)', () => {
  let captured: CapturedCall[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    warnSpy.mockRestore();
  });

  function bodyOf(index = 0): Record<string, unknown> {
    return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
  }

  it('openai non-streaming: 400 naming thinking retries once without the thinking fields', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody("Unknown parameter: 'thinking' is not supported"), 400),
      () => jsonResponse(OPENAI_OK, 200),
    ]);
    const result = await generateText(
      model({ modelId: 'glm-4.6', thinkingKind: 'glm-dynamic-basic' }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'low' } },
    );
    expect(captured.length).toBe(2);
    expect(bodyOf(0).thinking).toEqual({ type: 'enabled' });
    expect('thinking' in bodyOf(1)).toBe(false);
    expect('reasoning_effort' in bodyOf(1)).toBe(false);
    expect(result.text).toBe('ok');
  });

  it('anthropic streaming: 400 naming thinking retries the stream once without thinking fields', async () => {
    globalThis.fetch = queuedFetch(captured, [
      // CR-011: texts must now carry the structured rejection shape
      // (reject-word + parameter-word + thinking target).
      () => jsonResponse(errorBody('unsupported parameter: thinking is not available on this endpoint'), 400),
      (call) => sseResponse(ANTHROPIC_STREAM_OK, call.init?.signal),
    ]);
    const result = await generateTextStream(
      anthropicModel({ thinkingKind: 'claude-5' }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'high' } },
      undefined,
      () => {},
    );
    expect(captured.length).toBe(2);
    expect(bodyOf(0).thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect('thinking' in bodyOf(1)).toBe(false);
    expect(result.text).toBe('ok');
  });

  it('a second thinking rejection still fails loudly after both layers stripped once', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('unsupported parameter: thinking'), 400),
      () => jsonResponse(errorBody('unsupported parameter: thinking'), 400),
      () => jsonResponse(errorBody('unsupported parameter: thinking'), 400),
    ]);
    await expect(
      generateTextStream(
        anthropicModel({ thinkingKind: 'claude-5' }),
        { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'high' } },
        undefined,
        () => {},
      ),
    ).rejects.toMatchObject({ name: 'ProtocolHttpError', status: 400 });
    // stream(thinking) → stream(stripped) → degraded non-stream(thinking, the
    // ORIGINAL request rides to the degraded call) → degraded non-stream
    // (stripped) — bounded at 4, then the real error surfaces.
    expect(captured.length).toBe(4);
  });

  it('CR-011: quota/limit/timeout/billing texts mentioning reasoning do NOT arm the strip retry', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('reasoning token quota exceeded — check your billing plan'), 400),
      () => jsonResponse(OPENAI_OK, 200), // must never be reached
    ]);
    await expect(
      generateText(
        model({ modelId: 'glm-5.3', thinkingKind: 'glm-forced-effort' }),
        { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'low' } },
      ),
    ).rejects.toMatchObject({ name: 'ProtocolHttpError', status: 400 });
    expect(captured.length).toBe(1); // no strip retry — the real error surfaces immediately
  });

  it('CR-011: a context-overflow 400 matching the thinking-rejection shape surfaces as CONTEXT_OVERFLOW first — no strip retry', async () => {
    // Matches BOTH predicates: overflow family ("prompt is too long") AND the
    // structured thinking-rejection shape (invalid + parameter + thinking).
    // Overflow classification must win — compaction is the fix, not stripping.
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('invalid parameter: thinking — prompt is too long: 200000 tokens > 195999 maximum'), 400),
      () => jsonResponse(OPENAI_OK, 200), // must never be reached
    ]);
    const err = await generateText(
      model({ modelId: 'glm-5.3', thinkingKind: 'glm-forced-effort' }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'low' } },
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolContextOverflowError);
    expect(captured.length).toBe(1);
  });
});

// ── Context overflow marker (design §4.1) ──

describe('context overflow marker (design §4.1)', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('openai non-streaming: a context-length 400 rejects with the marked error, no retries', async () => {
    globalThis.fetch = buildMock(
      captured,
      { error: { message: "This model's maximum context length is 4097 tokens, however you requested 5000 tokens" } },
      400,
    );
    const err = await generateText(
      model(),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolContextOverflowError);
    expect((err as ProtocolContextOverflowError).code).toBe('CONTEXT_OVERFLOW');
    expect(isContextOverflowError(err)).toBe(true);
    expect(captured.length).toBe(1); // 400 is non-retryable, nothing to strip
  });

  it('anthropic streaming: a prompt-too-long 400 surfaces the marker immediately — no degraded call', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('prompt is too long: 200000 tokens > 195999 maximum'), 400),
    ]);
    const err = await generateTextStream(
      anthropicModel(),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolContextOverflowError);
    expect(captured.length).toBe(1); // degrade cannot fix an oversized prompt
  });

  it('the predicate also recognizes snake_case codes and raw (unmarked) shapes', () => {
    expect(isContextOverflowError(new ProtocolHttpError('context_length_exceeded', 400))).toBe(true);
    expect(isContextOverflowError(new ProtocolHttpError('input is too long for the context window', 400))).toBe(true);
    expect(isContextOverflowError(new ProtocolHttpError('bad key', 401))).toBe(false);
    expect(isContextOverflowError(new Error('not an http error'))).toBe(false);
  });
});

// ── Anthropic signature capture (B block, design §5.1) ──

describe('anthropic signature capture (B block)', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('streaming: signature_delta frames aggregate onto reasoningSignature', async () => {
    const chunks = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '推理' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'abc' } }),
      anthEvent('content_block_stop', { index: 0 }),
      anthEvent('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '答案' } }),
      anthEvent('content_block_stop', { index: 1 }),
      anthEvent('message_delta', { delta: { stop_reason: 'end_turn' } }),
      anthEvent('message_stop'),
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, call.init?.signal)]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(result.reasoning).toBe('推理');
    expect(result.reasoningSignature).toBe('sig-abc');
    expect(result.text).toBe('答案');
  });

  it('streaming: a second thinking block resets the capture — the LAST block wins (single-block round-trip)', async () => {
    const chunks = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-old' } }),
      anthEvent('content_block_stop', { index: 0 }),
      anthEvent('content_block_start', { index: 1, content_block: { type: 'thinking', thinking: '' } }),
      anthEvent('content_block_delta', { index: 1, delta: { type: 'thinking_delta', thinking: '再想' } }),
      anthEvent('content_block_delta', { index: 1, delta: { type: 'signature_delta', signature: 'sig-new' } }),
      anthEvent('content_block_stop', { index: 1 }),
      anthEvent('message_delta', { delta: { stop_reason: 'end_turn' } }),
      anthEvent('message_stop'),
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, call.init?.signal)]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(result.reasoningSignature).toBe('sig-new');
  });

  it('non-streaming: the thinking block signature maps onto reasoningSignature', async () => {
    globalThis.fetch = buildMock(captured, {
      content: [
        { type: 'thinking', thinking: '推理', signature: 'sig-9' },
        { type: 'text', text: '答案' },
      ],
      stop_reason: 'end_turn',
    });

    const result = await generateText(
      anthropicModel(),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(result.reasoning).toBe('推理');
    expect(result.reasoningSignature).toBe('sig-9');
    expect(result.text).toBe('答案');
  });
});

// ── zen probe (design §2.3) ──

describe('zen probe: gateway silently stripping the thinking field', () => {
  let captured: CapturedCall[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    warnSpy.mockRestore();
  });

  it('warns exactly once per (keyId, modelId) when an injected ON-state yields zero thinking trace', async () => {
    const probeModel = anthropicModel({ keyId: 'zen-probe-1', thinkingKind: 'claude-5' });
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);

    await generateText(probeModel, { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'high' } });
    await generateText(probeModel, { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'high' } });

    const stripWarns = warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('silently stripping'));
    expect(stripWarns.length).toBe(1); // once per (keyId, modelId), not per request
  });

  it('does not warn when the response carries thinking blocks (positive control)', async () => {
    globalThis.fetch = buildMock(captured, {
      content: [
        { type: 'thinking', thinking: '推理' },
        { type: 'text', text: 'ok' },
      ],
      stop_reason: 'end_turn',
    });

    await generateText(
      anthropicModel({ keyId: 'zen-probe-2', thinkingKind: 'claude-5' }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'high' } },
    );

    expect(warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('silently stripping')).length).toBe(0);
  });

  it('does not arm when the effective state is off (zero thinking is expected then)', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);

    await generateText(
      anthropicModel({ keyId: 'zen-probe-3', thinkingKind: 'claude-5' }),
      { model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'off' } },
    );

    expect(warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('silently stripping')).length).toBe(0);
  });
});
