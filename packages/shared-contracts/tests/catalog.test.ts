import { describe, expect, it } from 'vitest';
import {
  CATALOG_ENTRIES_LIMIT_DEFAULT,
  CATALOG_ENTRIES_LIMIT_MAX,
  catalogEntriesRequestSchema,
  catalogEntriesResultSchema,
  catalogRowSchema,
  getEntryRequestSchema,
  getEntryResultSchema,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.7 S1：扫描层统一目录契约（design §4.1）。三态覆盖：请求合法/缺省（limit default）/
// 边界拒收（offset 负、limit 0/超 max）；薄行与结果形状；get_entry 下钻。
// 「绝不静默截断」红线 = total 语义（过滤后总数非本页行数）——schema 层强制 total 必填。
// ─────────────────────────────────────────────────────────────────────────────

describe('catalogEntriesRequestSchema', () => {
  it('空参 → limit default 20（offset 缺省不造默认值，handler 视作 0）', () => {
    const parsed = catalogEntriesRequestSchema.parse({});
    expect(parsed.limit).toBe(CATALOG_ENTRIES_LIMIT_DEFAULT);
    expect(parsed.offset).toBeUndefined();
    expect(parsed.entry_type).toBeUndefined();
  });

  it('过滤 + 翻页参数齐传合法；limit 上限含端点', () => {
    const parsed = catalogEntriesRequestSchema.parse({
      entry_type: 'character',
      status: 'active',
      visibility: 'known',
      offset: 40,
      limit: CATALOG_ENTRIES_LIMIT_MAX,
    });
    expect(parsed).toEqual({
      entry_type: 'character',
      status: 'active',
      visibility: 'known',
      offset: 40,
      limit: CATALOG_ENTRIES_LIMIT_MAX,
    });
    expect(catalogEntriesRequestSchema.parse({ limit: 1 }).limit).toBe(1);
  });

  it('offset 负 / limit 0 / limit 超 max / 非整数 → reject', () => {
    expect(() => catalogEntriesRequestSchema.parse({ offset: -1 })).toThrow();
    expect(() => catalogEntriesRequestSchema.parse({ limit: 0 })).toThrow();
    expect(() => catalogEntriesRequestSchema.parse({ limit: CATALOG_ENTRIES_LIMIT_MAX + 1 })).toThrow();
    expect(() => catalogEntriesRequestSchema.parse({ limit: 1.5 })).toThrow();
    expect(() => catalogEntriesRequestSchema.parse({ offset: 1.5 })).toThrow();
  });
});

describe('catalogRowSchema / catalogEntriesResultSchema', () => {
  it('薄行：必有 id/类型/名字，统计与简述行缺省合法（缺省 = 暂无出场账/暂无简述）', () => {
    const row = catalogRowSchema.parse({
      entryId: 'char-lixuan',
      entryType: 'character',
      name: '李玄',
    });
    expect(row.summaryLine).toBeUndefined();
    expect(row.mentionChapterCount).toBeUndefined();
    expect(row.lastMentionEpisode).toBeUndefined();

    const full = catalogRowSchema.parse({
      entryId: 'char-lixuan',
      entryType: 'character',
      name: '李玄',
      summaryLine: '背着师门血案的杂役弟子',
      mentionChapterCount: 12,
      lastMentionEpisode: 'ep-31',
    });
    expect(full.mentionChapterCount).toBe(12);
    expect(full.lastMentionEpisode).toBe('ep-31');
  });

  it('薄行缺 entryId/name → reject；mentionChapterCount 负数 reject', () => {
    expect(() => catalogRowSchema.parse({ entryType: 'character', name: '李玄' })).toThrow();
    expect(() =>
      catalogRowSchema.parse({ entryId: 'e', entryType: 'character' }),
    ).toThrow();
    expect(() =>
      catalogRowSchema.parse({ entryId: 'e', entryType: 'c', name: 'n', mentionChapterCount: -1 }),
    ).toThrow();
  });

  it('结果：total 必填（绝不静默截断——过滤后总数是翻页依据）+ rows 数组', () => {
    const result = catalogEntriesResultSchema.parse({
      total: 137,
      rows: [
        { entryId: 'e1', entryType: 'character', name: '李玄' },
        { entryId: 'e2', entryType: 'rule', name: '代价法则', summaryLine: '施术必偿' },
      ],
    });
    expect(result.total).toBe(137);
    expect(result.rows).toHaveLength(2);
    // total > offset + rows.length = 还有更多页（红线语义：本页短 ≠ 只有这些）。
    expect(result.total).toBeGreaterThan(result.rows.length);

    expect(() => catalogEntriesResultSchema.parse({ rows: [] })).toThrow(); // 缺 total
    expect(() => catalogEntriesResultSchema.parse({ total: 0 })).toThrow(); // 缺 rows
    expect(catalogEntriesResultSchema.parse({ total: 0, rows: [] }).total).toBe(0);
  });
});

describe('getEntryRequestSchema / getEntryResultSchema', () => {
  it('请求：entry_id 必填非空', () => {
    expect(getEntryRequestSchema.parse({ entry_id: 'char-lixuan' }).entry_id).toBe('char-lixuan');
    expect(() => getEntryRequestSchema.parse({})).toThrow();
    expect(() => getEntryRequestSchema.parse({ entry_id: '' })).toThrow();
  });

  it('结果：全量形状（简述/全文/状态/可见性/出场统计）合法', () => {
    const parsed = getEntryResultSchema.parse({
      entryId: 'char-lixuan',
      type: 'character',
      name: '李玄',
      summary: '背着师门血案的杂役弟子，性沉毅。',
      bodyText: '李玄……（全文拼料）',
      status: 'active',
      visibility: 'known',
      mentionStats: { mentionChapterCount: 12, lastMentionEpisode: 'ep-31' },
    });
    expect(parsed.status).toBe('active');
    expect(parsed.mentionStats.mentionChapterCount).toBe(12);
  });

  it('结果：status nullable（设定散文无状态）+ summary/统计字段缺省合法（暂无简述/暂无账）', () => {
    const parsed = getEntryResultSchema.parse({
      entryId: '00042:magic-system',
      type: 'magic_system',
      name: '魔法体系',
      bodyText: '# 魔法体系\n（长文）',
      status: null,
      visibility: 'known',
      mentionStats: {},
    });
    expect(parsed.status).toBeNull();
    expect(parsed.summary).toBeUndefined();
    expect(parsed.mentionStats.lastMentionEpisode).toBeUndefined();
  });

  it('结果：缺必填（bodyText/visibility/mentionStats）→ reject', () => {
    const base = {
      entryId: 'e',
      type: 'character',
      name: 'n',
      bodyText: 'b',
      status: 'draft',
      visibility: 'known',
      mentionStats: {},
    };
    for (const key of ['bodyText', 'visibility', 'mentionStats', 'name']) {
      const over: Record<string, unknown> = { ...base };
      delete over[key];
      expect(() => getEntryResultSchema.parse(over)).toThrow();
    }
  });
});
