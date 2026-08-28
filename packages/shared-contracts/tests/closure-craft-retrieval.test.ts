import { describe, expect, it } from 'vitest';
import {
  craftHitSchema,
  closureCraftQuerySchema,
  rerankRequestSchema,
  rerankResponseSchema,
  rerankPayloadSchema,
  CRAFT_TYPE_VOCAB,
  formatCraftTypeVocab,
  modelRefSchema,
} from '../src';

describe('closureCraftQuerySchema (Story 2.1)', () => {
  it('clamps k to [1, 50] (mirror closureStoryQuerySchema)', () => {
    expect(closureCraftQuerySchema.parse({ query: 'x', k: -1 }).k).toBe(1);
    expect(closureCraftQuerySchema.parse({ query: 'x', k: 0 }).k).toBe(1);
    expect(closureCraftQuerySchema.parse({ query: 'x', k: 999 }).k).toBe(50);
    expect(closureCraftQuerySchema.parse({ query: 'x', k: 7 }).k).toBe(7);
  });

  it('defaults k to 10 when omitted', () => {
    expect(closureCraftQuerySchema.parse({ query: 'x' }).k).toBe(10);
  });

  it('defaults query to empty string + craft_type optional (open string, non-closed enum)', () => {
    const parsed = closureCraftQuerySchema.parse({});
    expect(parsed.query).toBe('');
    expect(parsed.craft_type).toBeUndefined();
  });

  it('accepts any craft_type string (non-closed enum - users self-register new classes)', () => {
    expect(closureCraftQuerySchema.parse({ query: 'x', craft_type: 'shuangdian' }).craft_type).toBe('shuangdian');
    expect(closureCraftQuerySchema.parse({ query: 'x', craft_type: 'custom-new-class' }).craft_type).toBe(
      'custom-new-class',
    );
  });

  it('has NO projectId field (global scope, unlike closureStoryQuerySchema)', () => {
    const parsed = closureCraftQuerySchema.parse({ query: 'x' } as Record<string, unknown>);
    expect((parsed as Record<string, unknown>).projectId).toBeUndefined();
  });
});

describe('craftHitSchema (Story 2.1)', () => {
  it('has craftId/craftType (not entryId/entryType) + no projectId + no visibility', () => {
    const hit = craftHitSchema.parse({
      craftId: 'shuangdian-catalog',
      craftType: 'shuangdian',
      sourceKind: 'user',
      name: '爽点目录',
      bodyText: '...',
      score: 0.5,
    });
    expect(hit.craftId).toBe('shuangdian-catalog');
    expect(hit.craftType).toBe('shuangdian');
    expect(hit.rerankScore).toBeUndefined();
    expect(hit.ftsRank).toBeUndefined();
  });

  it('accepts optional rerankScore / ftsRank / vecDistance', () => {
    const hit = craftHitSchema.parse({
      craftId: 'c1',
      craftType: 'pattern',
      sourceKind: 'bundled',
      name: 'n',
      bodyText: 'b',
      score: 0.1,
      ftsRank: -2,
      vecDistance: 0.3,
      rerankScore: 0.9,
    });
    expect(hit.rerankScore).toBe(0.9);
    expect(hit.ftsRank).toBe(-2);
    expect(hit.vecDistance).toBe(0.3);
  });
});

describe('rerank schemas (Story 2.1)', () => {
  it('rerankRequestSchema: query + documents batch + optional top_n', () => {
    const req = rerankRequestSchema.parse({ query: 'q', documents: ['a', 'b'] });
    expect(req.documents).toEqual(['a', 'b']);
    expect(req.top_n).toBeUndefined();
    expect(rerankRequestSchema.parse({ query: 'q', documents: ['a'], top_n: 5 }).top_n).toBe(5);
  });

  it('rerankRequestSchema rejects empty documents (min 1)', () => {
    expect(() => rerankRequestSchema.parse({ query: 'q', documents: [] })).toThrow();
  });

  it('rerankResponseSchema: model + scores[]', () => {
    const res = rerankResponseSchema.parse({ model: 'bge-reranker-v2-m3', scores: [0.9, 0.1] });
    expect(res.scores).toEqual([0.9, 0.1]);
  });

  it('rerankPayloadSchema: ref + request (mirror generateEmbeddingPayloadSchema)', () => {
    const payload = rerankPayloadSchema.parse({
      ref: { keyId: 'k1', modelId: 'bge-reranker-v2-m3' },
      request: { query: 'q', documents: ['a', 'b'] },
    });
    expect(payload.ref.keyId).toBe('k1');
    expect(payload.request.documents).toHaveLength(2);
  });

  it('modelRefSchema is reusable for rerankModel config field', () => {
    expect(modelRefSchema.safeParse({ keyId: 'k', modelId: 'm' }).success).toBe(true);
    expect(modelRefSchema.safeParse({ keyId: '' }).success).toBe(false);
  });
});

describe('CRAFT_TYPE_VOCAB (Story 2.1)', () => {
  it('has 8 classes + uncategorized catch-all = 9 entries', () => {
    expect(CRAFT_TYPE_VOCAB).toHaveLength(9);
  });

  it('covers the 8 curated classes (incl. character/OC added in 2.1)', () => {
    const values = CRAFT_TYPE_VOCAB.map((e) => e.value);
    expect(values).toEqual(
      expect.arrayContaining([
        'shuangdian',
        'jinzhishao',
        'playbook',
        'qiaoduan',
        'jiezou',
        'liliang',
        'pattern',
        'character',
        'uncategorized',
      ]),
    );
  });

  it('every entry has a non-empty gloss (curation prior, not a closed enum gate)', () => {
    for (const e of CRAFT_TYPE_VOCAB) {
      expect(e.gloss.length).toBeGreaterThan(0);
    }
  });

  it('formatCraftTypeVocab produces injectable prior text mentioning the open-string policy', () => {
    const text = formatCraftTypeVocab();
    expect(text).toContain('craft_type');
    expect(text).toContain('先验');
    expect(text).toContain('可超出');
    expect(text).toContain('shuangdian');
    expect(text).toContain('character');
  });
});
