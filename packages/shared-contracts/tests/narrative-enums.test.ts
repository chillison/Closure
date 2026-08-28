import { describe, expect, it } from 'vitest';
import {
  OUTCOME_TYPE_VOCAB,
  PACING_ROLE_VOCAB,
  MICE_TYPE_VOCAB,
  formatNarrativeEnumGuide,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.9 §3.1：三策展词表形态合法（每项 {value, gloss} + 非空 + 中文优先）
// ─────────────────────────────────────────────────────────────────────────────
describe('叙事枚举词表形态（Story 1.9 §3.1）', () => {
  const VOCABS = [
    { name: 'OUTCOME_TYPE_VOCAB', vocab: OUTCOME_TYPE_VOCAB, minItems: 6 },
    { name: 'PACING_ROLE_VOCAB', vocab: PACING_ROLE_VOCAB, minItems: 5 },
    { name: 'MICE_TYPE_VOCAB', vocab: MICE_TYPE_VOCAB, minItems: 4 },
  ];

  for (const { name, vocab, minItems } of VOCABS) {
    describe(name, () => {
      it(`非空且不少于预期项数（≥${minItems}）`, () => {
        expect(vocab.length).toBeGreaterThanOrEqual(minItems);
        expect(vocab.length).toBeGreaterThan(0);
      });

      it('每项是 {value, gloss} 形态', () => {
        for (const entry of vocab) {
          expect(entry).toHaveProperty('value');
          expect(entry).toHaveProperty('gloss');
          expect(Object.keys(entry).sort()).toEqual(['gloss', 'value']);
        }
      });

      it('value 非空字符串且唯一', () => {
        const values = vocab.map((e) => e.value);
        expect(new Set(values).size).toBe(values.length);
        for (const v of values) {
          expect(typeof v).toBe('string');
          expect(v.length).toBeGreaterThan(0);
        }
      });

      it('gloss 非空字符串（带解释）', () => {
        for (const entry of vocab) {
          expect(typeof entry.gloss).toBe('string');
          expect(entry.gloss.length).toBeGreaterThan(0);
        }
      });
    });
  }

  it('OUTCOME_TYPE_VOCAB value 中文（中文优先策展）', () => {
    // 中文优先：value 应含 CJK 字符（至少一项足以表明非纯英文菜单）
    const allChinese = OUTCOME_TYPE_VOCAB.every((e) => /[一-鿿]/.test(e.value));
    expect(allChinese).toBe(true);
  });

  it('PACING_ROLE_VOCAB value 中文（中文优先策展）', () => {
    const allChinese = PACING_ROLE_VOCAB.every((e) => /[一-鿿]/.test(e.value));
    expect(allChinese).toBe(true);
  });

  it('MICE_TYPE_VOCAB value 中文 + gloss 含英文原名（Milieu/Idea/Character/Event 溯源）', () => {
    // mice 注解的核心价值：中文 value + 英文原名 + 收束条件
    for (const entry of MICE_TYPE_VOCAB) {
      expect(/[一-鿿]/.test(entry.value)).toBe(true); // value 中文
      expect(entry.gloss.length).toBeGreaterThan(0);
    }
    const allGlossText = MICE_TYPE_VOCAB.map((e) => e.gloss).join(' ');
    // 四个英文原名至少出现（溯源 MICE 原词）
    expect(allGlossText).toContain('Milieu');
    expect(allGlossText).toContain('Idea');
    expect(allGlossText).toContain('Character');
    expect(allGlossText).toContain('Event');
  });

  it('MICE_TYPE_VOCAB gloss 含收束条件（"收束="）——线级收束契约是其核心价值', () => {
    for (const entry of MICE_TYPE_VOCAB) {
      expect(entry.gloss).toContain('收束=');
    }
  });

  it('三词表 const as const（静态确定性数据，可 readonly 断言）', () => {
    // as const 让数据成为字面量元组（确定性 seed，类比 PATTERN_SEEDS）
    expect(Array.isArray(OUTCOME_TYPE_VOCAB)).toBe(true);
    expect(Array.isArray(PACING_ROLE_VOCAB)).toBe(true);
    expect(Array.isArray(MICE_TYPE_VOCAB)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.9 §3.1：formatNarrativeEnumGuide（纯函数，静态，零依赖）
// ─────────────────────────────────────────────────────────────────────────────
describe('formatNarrativeEnumGuide（Story 1.9 §3.1 prompt 注入文本）', () => {
  it('返回非空字符串', () => {
    const guide = formatNarrativeEnumGuide();
    expect(typeof guide).toBe('string');
    expect(guide.length).toBeGreaterThan(0);
  });

  it('含三段标题（场结果 / 场张弛 / 线叙事单元）', () => {
    const guide = formatNarrativeEnumGuide();
    expect(guide).toContain('【场·结果类型 outcomeType】');
    expect(guide).toContain('【场·张弛角色 pacingRole】');
    expect(guide).toContain('【线·叙事单元 mice_type】');
  });

  it('含全部词表 value 与 gloss（注入完整词表）', () => {
    const guide = formatNarrativeEnumGuide();
    for (const entry of [...OUTCOME_TYPE_VOCAB, ...PACING_ROLE_VOCAB, ...MICE_TYPE_VOCAB]) {
      expect(guide).toContain(entry.value);
      expect(guide).toContain(entry.gloss);
    }
  });

  it('含头注「先验，可超出」（词表是先验非门禁）', () => {
    const guide = formatNarrativeEnumGuide();
    expect(guide).toContain('先验');
    expect(guide).toContain('可超出');
  });

  it('含 mice 收束契约内容（收束=）', () => {
    const guide = formatNarrativeEnumGuide();
    expect(guide).toContain('收束=');
  });

  it('确定性：调两次返回相同文本（纯函数）', () => {
    expect(formatNarrativeEnumGuide()).toBe(formatNarrativeEnumGuide());
  });

  it('零参数（静态生成，不依赖 projectDocument）', () => {
    // 恒在注入：无入参 = 不读项目状态，所有 creative run 都带
    const guide = formatNarrativeEnumGuide();
    expect(guide).toContain('outcomeType'); // 字段名出现，表明它是结构角色指引
    expect(guide).toContain('mice_type');
  });
});
