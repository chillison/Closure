import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel, TextGenerationRequest } from '@orison/shared-contracts';
import { generateText } from '../src';

// Thinking adapters task S4b (B block, design §5.2): historical-reasoning
// round-trip on REQUEST messages. The agent layer stamps `reasoning_content`
// (GLM/Kimi/DeepSeek ecosystem wire name) + `reasoningSignature` (Anthropic)
// onto assistant history; these tests pin the protocol-layer sync that gets
// them onto the actual wire body:
//   - Anthropic path: buildAnthropicBody inserts a first-position thinking
//     block (text + signature both required — a missing signature skips the
//     block rather than forging one).
//   - OpenAI path: buildOpenAiArgs rebuilds messages into @ai-sdk's
//     ModelMessage shape which has no reasoning_content slot — a body patch
//     re-attaches it (gated to the reasoning_content ecosystem kinds).
// Mock patterns mirror thinking.test.ts.

const ORIGINAL_FETCH = globalThis.fetch;

type CapturedCall = { url: string; init?: RequestInit };

function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'deepseek-chat',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.test',
    apiKey: 'sk-test',
    capability: 'text',
    ...overrides,
  };
}

function anthropicModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return model({ protocol: 'anthropic-compatible', modelId: 'claude-opus-5', thinkingKind: 'claude-5', ...overrides });
}

function buildMock(captured: CapturedCall[], body: unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const OPENAI_OK = { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
const ANTHROPIC_OK = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };

function bodyOf(captured: CapturedCall[], index = 0): Record<string, unknown> {
  return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
}

describe('anthropic reasoning round-trip: thinking block in assistant history', () => {
  let captured: CapturedCall[];

  beforeEach(() => {
    captured = [];
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  const HISTORY: TextGenerationRequest['messages'] = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'prev answer',
      reasoning_content: '先想一步',
      reasoningSignature: 'sig-1',
    },
    { role: 'user', content: 'next' },
  ];

  it('assistant with reasoning + signature → first-position thinking block in the wire content array', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), { model: 'x', messages: HISTORY });

    const wireMessages = bodyOf(captured).messages as Array<{ role: string; content: unknown }>;
    expect(wireMessages).toHaveLength(3);
    const assistant = wireMessages[1];
    // Block array (not the collapsed plain-string form) headed by the thinking block.
    expect(Array.isArray(assistant.content)).toBe(true);
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: '先想一步', signature: 'sig-1' },
      { type: 'text', text: 'prev answer' },
    ]);
  });

  it('signature missing → the thinking block is skipped entirely (never forge a signature the endpoint would 400 on)', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), {
      model: 'x',
      messages: HISTORY.map((m) =>
        m.role === 'assistant' ? { ...m, reasoningSignature: undefined } : m,
      ),
    });

    const wireMessages = bodyOf(captured).messages as Array<{ role: string; content: unknown }>;
    // No thinking block anywhere; single-text assistant collapses back to the
    // plain string form (pre-feature wire shape).
    expect(wireMessages[1].content).toBe('prev answer');
    expect(JSON.stringify(bodyOf(captured).messages)).not.toContain('thinking');
  });

  it('assistant history without any reasoning → wire body byte-shape unchanged (zero regression)', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), {
      model: 'x',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'prev answer' },
        { role: 'user', content: 'next' },
      ],
    });

    const wireMessages = bodyOf(captured).messages as Array<{ role: string; content: unknown }>;
    expect(wireMessages[1].content).toBe('prev answer');
    expect(JSON.stringify(bodyOf(captured)).includes('reasoning')).toBe(false);
  });
});

describe('openai-compatible reasoning round-trip: reasoning_content body patch', () => {
  let captured: CapturedCall[];

  beforeEach(() => {
    captured = [];
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  const HISTORY: TextGenerationRequest['messages'] = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'prev answer',
      toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{"q":"x"}' }],
      reasoning_content: '工具前推理',
    },
    { role: 'tool', toolCallId: 'c1', content: 'tool out' },
    { role: 'user', content: 'next' },
  ];

  it('deepseek-v4 kind: assistant history reasoning lands on the wire as reasoning_content (DeepSeek+tools hard requirement)', async () => {
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    await generateText(model({ thinkingKind: 'deepseek-v4' }), { model: 'x', messages: HISTORY });

    const wireMessages = bodyOf(captured).messages as Array<Record<string, unknown>>;
    // System hoisted by the SDK — zip against non-system request order.
    const assistant = wireMessages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.reasoning_content).toBe('工具前推理');
    // Only the assistant message carries it.
    const carriers = wireMessages.filter((m) => 'reasoning_content' in m);
    expect(carriers).toHaveLength(1);
  });

  it('kimi-k3 kind: assistant history reasoning lands on the wire as reasoning_content (AC5-named obligation, CR-008)', async () => {
    // K3's Preserved thinking is always on — the vendor REQUIRES every
    // historical assistant reasoning_content back, tools or not.
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    await generateText(model({ modelId: 'kimi-k3', thinkingKind: 'kimi-k3' }), {
      model: 'x',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'prev answer', reasoning_content: '上一轮思考' },
        { role: 'user', content: 'next' },
      ],
    });

    const wireMessages = bodyOf(captured).messages as Array<Record<string, unknown>>;
    const assistant = wireMessages.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBe('上一轮思考');
  });

  it('no reasoning in history → no patch at all (wire body byte-identical)', async () => {
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    await generateText(model({ thinkingKind: 'deepseek-v4' }), {
      model: 'x',
      messages: HISTORY.map((m) => (m.role === 'assistant' ? { ...m, reasoning_content: undefined } : m)),
    });

    expect(JSON.stringify(bodyOf(captured)).includes('reasoning_content')).toBe(false);
  });

  it('non-ecosystem kind (openai first-party): reasoning_content is NOT attached — unknown message fields would 400 there', async () => {
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    await generateText(model({ modelId: 'gpt-5', thinkingKind: 'gpt5' }), { model: 'x', messages: HISTORY });

    expect(JSON.stringify(bodyOf(captured)).includes('reasoning_content')).toBe(false);
  });

  it('unknown kind (no registry entry): no injection either — fail-open to the pre-feature body', async () => {
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    await generateText(model({ modelId: 'mystery-model', thinkingKind: undefined }), {
      model: 'x',
      messages: HISTORY,
    });

    expect(JSON.stringify(bodyOf(captured)).includes('reasoning_content')).toBe(false);
  });
});
