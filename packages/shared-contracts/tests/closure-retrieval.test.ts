import { describe, expect, it } from 'vitest';
import {
  CHUNK_FLOOR_CHARS,
  CHUNK_MAX_CHARS,
  CHUNK_TARGET_CHARS,
  chapterChunkSchema,
  closureSearchRequestSchema,
  entryHitSchema,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.7 S1（R2/R4 additive）：检索契约扩字段——EntryHit 加 summaryText/vectorKind（双向量
// 分型命中类别）；ClosureSearchRequest 加 status/visibility 预过滤。全 additive optional：
// 既有构造路径（无新字段）必须照旧 parse 通过（零回归锚）。
// ─────────────────────────────────────────────────────────────────────────────

function mkHit(over: Record<string, unknown> = {}) {
  return {
    entryId: '00042:char-lixuan',
    projectId: '00042',
    entryType: 'character',
    sourceKind: 'setting_card',
    name: '李玄',
    bodyText: '李玄……（拼料全文）',
    visibility: 'known',
    score: 0.031,
    ...over,
  };
}

describe('entryHitSchema — Story 8.7 additive 字段', () => {
  it('既有形状（无新字段）照旧 parse 通过——additive 零回归锚', () => {
    const parsed = entryHitSchema.parse(mkHit());
    expect(parsed.summaryText).toBeUndefined();
    expect(parsed.vectorKind).toBeUndefined();
  });

  it('summaryText / vectorKind 带值合法（identity 命中携简述 / body 命中）', () => {
    const identity = entryHitSchema.parse(
      mkHit({ summaryText: '背着师门血案的杂役弟子', vectorKind: 'identity' }),
    );
    expect(identity.vectorKind).toBe('identity');
    const body = entryHitSchema.parse(mkHit({ vectorKind: 'body' }));
    expect(body.vectorKind).toBe('body');
    expect(body.summaryText).toBeUndefined();
  });

  it('缺必填（entryId/score/bodyText）→ reject（additive 不放松既有约束）', () => {
    for (const key of ['entryId', 'projectId', 'name', 'bodyText', 'score']) {
      const hit: Record<string, unknown> = mkHit();
      delete hit[key];
      expect(() => entryHitSchema.parse(hit)).toThrow();
    }
  });
});

describe('closureSearchRequestSchema — Story 8.7 additive 预过滤参数', () => {
  it('既有形状照旧 parse + k default 10（additive 零回归锚）', () => {
    const parsed = closureSearchRequestSchema.parse({ projectId: '00042', query: '李玄' });
    expect(parsed.k).toBe(10);
    expect(parsed.status).toBeUndefined();
    expect(parsed.visibility).toBeUndefined();
  });

  it('status / visibility 过滤参数合法（visibility 值域现状恒 known——接口就位）', () => {
    const parsed = closureSearchRequestSchema.parse({
      projectId: '00042',
      query: '李玄',
      status: 'active',
      visibility: 'known',
      entryType: 'character',
    });
    expect(parsed.status).toBe('active');
    expect(parsed.visibility).toBe('known');
  });

  it('缺 projectId / query → reject（additive 不放松既有约束）', () => {
    expect(() => closureSearchRequestSchema.parse({ query: 'q' })).toThrow();
    expect(() => closureSearchRequestSchema.parse({ projectId: '00042' })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 S1（正文分块契约 + EntryHit 章源扩展字段，design §2.1/§2.2）：
// chunk 常量钉值（dogfood 校准点的防漂移锚——改值须过校准流程不是随手改）、
// chapterChunkSchema 形态、EntryHit 六个章源 optional 字段的二态纪律。
// ─────────────────────────────────────────────────────────────────────────────

describe('chunk 常量（Story 8.3 分块参数，dogfood 校准点）', () => {
  it('目标/上限/下限三值钉死（证据带锚点：叙事块 350-450 / floor 防碎片）', () => {
    expect(CHUNK_TARGET_CHARS).toBe(400);
    expect(CHUNK_MAX_CHARS).toBe(500);
    expect(CHUNK_FLOOR_CHARS).toBe(50);
  });
});

describe('chapterChunkSchema — 分块器输出形态（S2 chunkChapter 契约）', () => {
  it('合法 chunk 全字段 parse 往返（半开 span + 原文 text）', () => {
    const chunk = chapterChunkSchema.parse({
      index: 0,
      paraStart: 0,
      paraEnd: 3,
      charStart: 0,
      charEnd: 412,
      text: '雨夜里他推开当铺的门……',
    });
    expect(chunk.index).toBe(0);
    expect(chunk.text).toContain('当铺');
  });

  it('负数 / 缺字段 / 非整数 → reject（span 数学约定由 schema 钉住）', () => {
    expect(() => chapterChunkSchema.parse({ index: -1, paraStart: 0, paraEnd: 1, charStart: 0, charEnd: 10, text: 'x' })).toThrow();
    expect(() => chapterChunkSchema.parse({ index: 0, paraStart: 0, paraEnd: 1, charStart: 0, charEnd: 10 })).toThrow();
    expect(() => chapterChunkSchema.parse({ index: 1.5, paraStart: 0, paraEnd: 1, charStart: 0, charEnd: 10, text: 'x' })).toThrow();
  });
});

describe('entryHitSchema — Story 8.3 章源扩展字段（二态纪律：无值键不出现）', () => {
  it('既有形状（无章源字段）照旧 parse 通过——additive 零回归锚', () => {
    const parsed = entryHitSchema.parse(mkHit());
    expect(parsed.chapterId).toBeUndefined();
    expect(parsed.chapterIndex).toBeUndefined();
    expect(parsed.charStart).toBeUndefined();
    expect(parsed.charEnd).toBeUndefined();
    expect(parsed.paraStart).toBeUndefined();
    expect(parsed.paraEnd).toBeUndefined();
  });

  it('章源 hit（source_kind=chapter 的 chunk 行）携六字段合法——段级出处锚定', () => {
    const parsed = entryHitSchema.parse(
      mkHit({
        sourceKind: 'chapter',
        chapterId: 'ep_12',
        chapterIndex: 12,
        charStart: 320,
        charEnd: 705,
        paraStart: 6,
        paraEnd: 9,
      }),
    );
    expect(parsed.chapterId).toBe('ep_12');
    expect(parsed.chapterIndex).toBe(12);
    expect(parsed.charStart).toBe(320);
    expect(parsed.charEnd).toBe(705);
    expect(parsed.paraStart).toBe(6);
    expect(parsed.paraEnd).toBe(9);
  });

  it('部分携带（只有 chapterId 无 span）照旧合法——字段各自 optional 非 all-or-nothing', () => {
    const parsed = entryHitSchema.parse(mkHit({ chapterId: 'ep_1' }));
    expect(parsed.chapterId).toBe('ep_1');
    expect(parsed.charStart).toBeUndefined();
  });
});
