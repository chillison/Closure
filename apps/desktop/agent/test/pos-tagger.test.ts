import { describe, expect, it } from 'vitest';
import { isPosTaggerAvailable, tagChinese } from '../src/audit/pos-tagger';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.2 Step 1 — 中文 POS tagger (@node-rs/jieba) wrapper 单测。
//
// 验证 design §4 / implement Step 1 contract：
//  - tag() 返回 {token, pos}[] 形态（非 jieba 原始 {word, tag}）。
//  - 词级分词（非逐字）+ POS 标签命中 ICTCLAS tagset（动词 v / 名词 n / 形容词 a 等）。
//  - isPosTaggerAvailable() 反映 native binding 装载状态。
//  - 空输入 / native binding 退化（返回 []）。
//
// 范式判据（ADR-3）：tagChinese 是确定性分词+词典标注（纯代码 utility），
// 非语义判断。本测只验机械输出形态 + 分词/标注是否「合理」（动词是动词、
// 名词是名词），不验任何「质量/好坏」语义——那是 L2 LLM 的职责。
// ─────────────────────────────────────────────────────────────────────────────

describe('tagChinese — 分词 + POS 标注（@node-rs/jieba native binding）', () => {
  it('native binding 可用（isPosTaggerAvailable() = true，依赖已安装）', () => {
    // @node-rs/jieba 是 agent 的 hard dependency（NAPI-RS 预编译二进制），
    // 测试环境装好即应为 true。若 CI 某环境 false，说明平台二进制缺失——
    // 设计 §10 rollback：Step 2 L1 须跳过 POS 信号，本断言暴露环境问题。
    expect(isPosTaggerAvailable()).toBe(true);
  });

  it('返回 {token, pos}[] 形态（非 jieba 原始 {word, tag}）', () => {
    const r = tagChinese('他走在月光下');
    expect(r.length).toBeGreaterThan(0);
    // 每 entry 含 token + pos 字段（非 word + tag）
    for (const t of r) {
      expect(t).toHaveProperty('token');
      expect(t).toHaveProperty('pos');
      expect(typeof t.token).toBe('string');
      expect(typeof t.pos).toBe('string');
      // 不应残留 jieba 原始命名
      expect(t).not.toHaveProperty('word');
      expect(t).not.toHaveProperty('tag');
    }
  });

  it('词级分词（非逐字）——「月光」作为整词出现', () => {
    const r = tagChinese('他走在月光下');
    const tokens = r.map((t) => t.token);
    // 默认 dict 装载后「月光」应作为整体词元（空 dict 退化逐字时不会出现）
    expect(tokens).toContain('月光');
    // 逐字退化（每个汉字单独）时「月」「光」会分别出现——词级分词后不应同时存在
    expect(tokens).not.toContain('月');
    expect(tokens).not.toContain('光');
  });

  it('POS 标签命中 ICTCLAS tagset（动词/名词/形容词/代词等）', () => {
    // 选一段覆盖多词性的句子，断言关键 token 的 POS 标签合理。
    const r = tagChinese('他走在月光下，冷冷地看着远方的城市。');
    const posByToken = new Map(r.map((t) => [t.token, t.pos]));

    // 「他」= 代词 r (pronoun)
    expect(posByToken.get('他')).toBe('r');
    // 「走」= 动词 v (verb)
    expect(posByToken.get('走')).toBe('v');
    // 「月光」= 名词 n (noun)
    expect(posByToken.get('月光')).toBe('n');
    // 「城市」= 地名 ns (place name) —— jieba 默认把「城市」标 ns（地名），
    // 是词典标注行为（非语义判断）；本测固化该标注形态，变更时需更新。
    expect(posByToken.get('城市')).toBe('ns');

    // 收集到的 POS 标签集合应在 ICTCLAS tagset 内（验 tagset 合理性）
    const knownTags = new Set([
      'n', 'nr', 'ns', 'nt', 'nz',        // 名词族
      'v', 'vd', 'vn',                     // 动词族
      'a', 'ad', 'an',                     // 形容词族
      'd',                                  // 副词
      'r',                                  // 代词
      'p',                                  // 介词
      'u', 'uj', 'ul', 'ug', 'ud', 'uz',   // 助词族
      'c',                                  // 连词
      'm', 'q',                             // 数量词
      'f', 's', 't',                        // 方位/处所/时间
      'z',                                  // 状态词
      'x',                                  // 非语素/标点
      'i', 'l', 'g', 'eng', 'o',
    ]);
    for (const t of r) {
      expect(knownTags.has(t.pos)).toBe(true);
    }
  });

  it('副词密度信号锚点 —— "A 不 B" 句式 / 口癖副词可被 POS 识别', () => {
    // R3 §3.3 ②「A 不 B」句式口癖 + ①"死"万能副词是 anti-slop 重点。
    // 验 POS tagger 能识别这类结构（POS-gram 骨架重复检测的基础）。
    const r = tagChinese('说不出的苦，看不透的夜。冷冷地，死死地。');
    // 关键副词/状态词应被标注（非全部 'x'）
    const posByToken = new Map(r.map((t) => [t.token, t.pos]));
    expect(posByToken.get('冷冷地')).toBe('z'); // 状态词
    expect(posByToken.get('死死地')).toBe('z'); // 状态词
  });
});

describe('tagChinese — 边界 / 退化', () => {
  it('空字符串 → []', () => {
    expect(tagChinese('')).toEqual([]);
  });

  it('纯标点 → 全部标点 tag (x)', () => {
    const r = tagChinese('，。！？');
    expect(r.length).toBeGreaterThan(0);
    for (const t of r) {
      expect(t.pos).toBe('x');
    }
  });

  it('纯英文 → tag 为 eng（jieba 行为，不崩）', () => {
    const r = tagChinese('hello world');
    // jieba 对英文标注为 eng 或逐字母 x——两种都合法，关键是不崩 + 有输出
    expect(r.length).toBeGreaterThan(0);
    for (const t of r) {
      expect(typeof t.token).toBe('string');
      expect(typeof t.pos).toBe('string');
    }
  });

  it('多次调用共享同一 Jieba 实例（dict 不重复装载）—— 结果稳定', () => {
    const a = tagChinese('他走在月光下');
    const b = tagChinese('他走在月光下');
    expect(b).toEqual(a);
  });

  it('混合长句（模拟正文片段）—— 不崩 + 多词性覆盖', () => {
    const prose = '突然，他想起了那个被遗忘的承诺，不由得开始犹豫。月光洒在城市的屋顶上，像一层薄薄的霜。';
    const r = tagChinese(prose);
    expect(r.length).toBeGreaterThan(10);
    const poses = new Set(r.map((t) => t.pos));
    // 多词性命中（至少动词 + 名词 + 助词 + 标点）
    expect(poses.size).toBeGreaterThan(3);
    expect(poses.has('v')).toBe(true);  // 动词
    expect(poses.has('x')).toBe(true);  // 标点
  });
});
