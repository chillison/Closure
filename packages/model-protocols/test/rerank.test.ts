import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
import { rerank, ProtocolHttpError } from '../src';

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

function rerankModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'bge-reranker-v2-m3',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.jina.ai',
    apiKey: 'sk-test',
    capability: 'rerank',
    ...overrides,
  };
}

describe('rerank (Story 2.1)', () => {
  let captured: CapturedCall[];

  beforeEach(() => {
    captured = [];
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('posts to /v1/rerank with Bearer auth + {model, query, documents, top_n}', async () => {
    // Jina/Cohere-style response: results[] sorted by relevance, each carrying
    // the ORIGINAL index of the document it scores.
    globalThis.fetch = buildMock(captured, {
      model: 'bge-reranker-v2-m3',
      results: [
        { index: 2, relevance_score: 0.97 },
        { index: 0, relevance_score: 0.42 },
        { index: 1, relevance_score: 0.11 },
      ],
      usage: { prompt_tokens: 15, total_tokens: 15 },
    });

    const res = await rerank(
      rerankModel(),
      { query: 'q', documents: ['doc0', 'doc1', 'doc2'], top_n: 3 },
    );

    expect(captured[0].url).toBe('https://api.jina.ai/v1/rerank');
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.model).toBe('bge-reranker-v2-m3');
    expect(body.query).toBe('q');
    expect(body.documents).toEqual(['doc0', 'doc1', 'doc2']);
    expect(body.top_n).toBe(3);
    const auth = (captured[0].init?.headers as Record<string, string>)?.authorization;
    expect(auth).toBe('Bearer sk-test');

    // scores are re-ordered back to INPUT order: doc2 -> 0.97, doc0 -> 0.42, doc1 -> 0.11.
    expect(res.scores).toEqual([0.42, 0.11, 0.97]);
    expect(res.model).toBe('bge-reranker-v2-m3');
    expect(res.usage?.totalTokens).toBe(15);
  });

  it('omits top_n from the body when not provided', async () => {
    globalThis.fetch = buildMock(captured, { results: [{ index: 0, relevance_score: 0.5 }] });
    await rerank(rerankModel(), { query: 'q', documents: ['a'] });
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.top_n).toBeUndefined();
  });

  it('normalizes baseUrl that already ends with /v1 (no double /v1/v1)', async () => {
    globalThis.fetch = buildMock(captured, { results: [{ index: 0, relevance_score: 1 }] });
    await rerank(rerankModel({ baseUrl: 'https://api.jina.ai/v1' }), {
      query: 'q',
      documents: ['a'],
    });
    expect(captured[0].url).toBe('https://api.jina.ai/v1/rerank');
  });

  it('fills missing indices with 0 (malformed response does not crash)', async () => {
    // Provider omitted index 1 entirely.
    globalThis.fetch = buildMock(captured, {
      results: [{ index: 0, relevance_score: 0.9 }],
    });
    const res = await rerank(rerankModel(), { query: 'q', documents: ['a', 'b'] });
    expect(res.scores).toEqual([0.9, 0]);
  });

  it('accepts the data[] shape variant (OpenAI-style)', async () => {
    globalThis.fetch = buildMock(captured, {
      data: [
        { index: 1, relevance_score: 0.8 },
        { index: 0, relevance_score: 0.2 },
      ],
    });
    const res = await rerank(rerankModel(), { query: 'q', documents: ['a', 'b'] });
    expect(res.scores).toEqual([0.2, 0.8]);
  });

  it('CR-craft-kb-008: accepts a `score` key (TEI/alternative providers)', async () => {
    // Some providers (TEI localhost, ZeroEntropy variants) use `score` instead of
    // `relevance_score`. Without the alias, every score defaults to 0 (silent no-op).
    globalThis.fetch = buildMock(captured, {
      results: [
        { index: 1, score: 0.88 },
        { index: 0, score: 0.33 },
      ],
    });
    const res = await rerank(rerankModel(), { query: 'q', documents: ['a', 'b'] });
    expect(res.scores).toEqual([0.33, 0.88]);
  });

  it('CR-craft-kb-008: falls back to positional alignment when `index` is absent', async () => {
    // Provider returned one result per input document IN INPUT ORDER, no index.
    globalThis.fetch = buildMock(captured, {
      results: [{ relevance_score: 0.1 }, { relevance_score: 0.2 }, { relevance_score: 0.3 }],
    });
    const res = await rerank(rerankModel(), { query: 'q', documents: ['a', 'b', 'c'] });
    expect(res.scores).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws ProtocolHttpError on non-2xx', async () => {
    globalThis.fetch = buildMock(captured, { error: { message: 'bad key' } }, 401);
    await expect(
      rerank(rerankModel(), { query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(ProtocolHttpError);
  });

  it('localhost baseUrl works (self-hosted TEI reranker)', async () => {
    globalThis.fetch = buildMock(captured, { results: [{ index: 0, relevance_score: 0.5 }] });
    await rerank(rerankModel({ baseUrl: 'http://localhost:8080' }), {
      query: 'q',
      documents: ['a'],
    });
    expect(captured[0].url).toBe('http://localhost:8080/v1/rerank');
  });
});
