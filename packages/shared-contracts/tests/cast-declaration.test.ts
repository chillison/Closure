import { describe, expect, it } from 'vitest';
import {
  CAST_DECLARATION_STOP_MARKER,
  castDeclarationSchema,
  castMentionedEntrySchema,
  castPresentEntrySchema,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.7 S1：写手出场申报契约（design §2.1）。三态覆盖：合法（含归属字段/最简空名单）/
// 缺必填/空值与非法枚举拒收。收束标记常量 exact 断言（写手循环 parse 据此截取申报段——
// 值漂移 = 申报永不收束，load-bearing）。
// ─────────────────────────────────────────────────────────────────────────────

describe('castDeclarationSchema', () => {
  it('合法申报：梗概 + 登场（含归属卡）+ 提及（含新称呼归属）', () => {
    const parsed = castDeclarationSchema.parse({
      synopsis: '李玄在藏经阁发现三师叔的私印，决定夜探师门档案房。',
      present: [
        { name: '李玄' },
        { name: '三师叔', card: '李慕山' },
      ],
      mentioned: [
        { name: '老祖' },
        { name: '小师妹', belongsTo: '苏晚晴' },
      ],
    });
    expect(parsed.synopsis).toContain('藏经阁');
    expect(parsed.present).toHaveLength(2);
    expect(parsed.present[1].card).toBe('李慕山');
    expect(parsed.mentioned[0].belongsTo).toBeUndefined();
    expect(parsed.mentioned[1].belongsTo).toBe('苏晚晴');
  });

  it('最简申报：两名单为空数组合法（纯环境章/无提及章）', () => {
    const parsed = castDeclarationSchema.parse({
      synopsis: '雨夜，空山古寺无人。',
      present: [],
      mentioned: [],
    });
    expect(parsed.present).toEqual([]);
    expect(parsed.mentioned).toEqual([]);
  });

  it('缺 synopsis / 空 synopsis / synopsis 非串 → reject（申报不完整，caller graceful 降级保守账）', () => {
    const base = { present: [], mentioned: [] };
    expect(() => castDeclarationSchema.parse(base)).toThrow();
    expect(() => castDeclarationSchema.parse({ ...base, synopsis: '' })).toThrow();
    expect(() => castDeclarationSchema.parse({ ...base, synopsis: '   ' })).toThrow();
    expect(() => castDeclarationSchema.parse({ ...base, synopsis: 42 })).toThrow();
  });

  it('缺 present / 缺 mentioned / 非数组 → reject（两名单显式必填，空数组合法但键必须在）', () => {
    expect(() => castDeclarationSchema.parse({ synopsis: 's', mentioned: [] })).toThrow();
    expect(() => castDeclarationSchema.parse({ synopsis: 's', present: [] })).toThrow();
    expect(() =>
      castDeclarationSchema.parse({ synopsis: 's', present: '李玄', mentioned: [] }),
    ).toThrow();
  });

  it('登场/提及条目：空 name reject；card/belongsTo 空串 reject（有意义才填）', () => {
    expect(() => castPresentEntrySchema.parse({ name: '' })).toThrow();
    expect(() => castPresentEntrySchema.parse({ name: '李玄', card: '' })).toThrow();
    expect(() => castMentionedEntrySchema.parse({ name: '' })).toThrow();
    expect(() => castMentionedEntrySchema.parse({ name: '老祖', belongsTo: '' })).toThrow();
  });
});

describe('CAST_DECLARATION_STOP_MARKER', () => {
  it('收束标记 exact 值（写手循环 parse 依赖——值漂移 = 申报永不收束）', () => {
    expect(CAST_DECLARATION_STOP_MARKER).toBe('<CAST_DECLARATION_READY>');
  });
});
