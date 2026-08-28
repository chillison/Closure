import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/shared/diff/tokenize';
import { diffLineWords, diffTokens, refineCjkPairs } from '../src/shared/diff/wordDiff';
import type { TokenDiff } from '../src/shared/diff/wordDiff';

// Story 7.5：词级 diff 的 token 化（CJK 整串切）+ 行内 LCS 对齐。
// 纯函数单测（ADR-3 纯代码 utility 天然可测）。覆盖中文整串 / 英文 / 混排 / 标点 / 边界。

describe('tokenize — CJK 整串切', () => {
  it('连续中文聚成一个 cjk token（非逐字符）', () => {
    const tokens = tokenize('她死死盯着');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('cjk');
    expect(tokens[0].text).toBe('她死死盯着');
  });

  it('英文单词/数字按连续字母数字切', () => {
    const tokens = tokenize('the cat42 sat');
    // ['the', ' ', 'cat42', ' ', 'sat']
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ['word', 'the'],
      ['space', ' '],
      ['word', 'cat42'],
      ['space', ' '],
      ['word', 'sat'],
    ]);
  });

  it('中英文混排：CJK 串与 ASCII word 各成独立 token', () => {
    const tokens = tokenize('她死死盯着window');
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ['cjk', '她死死盯着'],
      ['word', 'window'],
    ]);
  });

  it('标点各成单 token', () => {
    const tokens = tokenize('你好。世界！');
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ['cjk', '你好'],
      ['punct', '。'],
      ['cjk', '世界'],
      ['punct', '！'],
    ]);
  });

  it('连续空白聚成一个 space token（保留空格差异可可视化）', () => {
    const tokens = tokenize('a   b');
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ['word', 'a'],
      ['space', '   '],
      ['word', 'b'],
    ]);
  });

  it('空串返回 []', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('仅空白返回单个 space token', () => {
    const tokens = tokenize('   ');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('space');
  });

  it('lossless：拼接 token.text 恢复原文本', () => {
    const cases = ['她死死盯着window', 'Hello, 世界！ 123', 'a  b\n  c', '。！？…', ''];
    for (const text of cases) {
      expect(tokenize(text).map((t) => t.text).join('')).toBe(text);
    }
  });

  it('BMad CR-001 surrogate pair：emoji 作一个完整 token（非拆成两个 other 码元）', () => {
    // emoji U+1F600 = 😀 是代理对（2 UTF-16 码元）。码点迭代下应作 1 个 token。
    const tokens = tokenize('😀');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].text).toBe('😀');
    // lossless 验证（含 emoji 的混合串）。
    const mixed = '她笑了😀';
    expect(tokenize(mixed).map((t) => t.text).join('')).toBe(mixed);
  });

  it('CJK 扩展区（非 BMP Han）作一个 cjk token（含代理对，BMad CR Edge-005 订正）', () => {
    // U+20000（CJK Ext B，代理对）应归 cjk 作一个 token，非 other。
    const tokens = tokenize('𠀀');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('cjk');
    expect(tokens[0].text).toBe('𠀀');
  });
});

describe('diffLineWords — 行内词级 LCS', () => {
  it('相同行全 equal', () => {
    const diff = diffLineWords('她死死盯着', '她死死盯着');
    expect(diff.every((d) => d.kind === 'equal')).toBe(true);
    expect(diff.map((d) => d.token.text).join('')).toBe('她死死盯着');
  });

  it('两 CJK 串完全无公共字 → 整块 remove + 整块 add（细化无害）', () => {
    // 选真正无公共字的 CJK 串对（diffLineWords 经 refineCjkPairs 做字符级 LCS）。
    const diff = diffLineWords('甲乙', '丙丁');
    expect(diff.map((d) => d.kind)).toEqual(['remove', 'add']);
  });

  it('两 CJK 串部分公共字 → 字符级 LCS 标出真改动（死死/紧紧），公共字保留', () => {
    const diff = diffLineWords('她死死盯着', '她紧紧盯着');
    // 她=equal, 死死=remove, 紧紧=add, 盯着=equal
    const kinds = diff.map((d) => d.kind);
    expect(kinds).toEqual(['equal', 'remove', 'add', 'equal']);
    expect(diff[1].token.text).toBe('死死');
    expect(diff[2].token.text).toBe('紧紧');
  });

  it('英文行：保留公共词，变动的词成 remove+add', () => {
    const diff = diffLineWords('the cat sat', 'the dog sat');
    const kinds = diff.map((d) => d.kind);
    // equal(the) + remove(cat) + add(dog) + equal( )equal(sat)（空格保留为 equal）
    expect(kinds.filter((k) => k === 'equal').length).toBeGreaterThanOrEqual(1);
    expect(kinds).toContain('remove');
    expect(kinds).toContain('add');
    // remove 的文本是 cat，add 的是 dog
    expect(diff.filter((d) => d.kind === 'remove').map((d) => d.token.text).join('')).toBe('cat');
    expect(diff.filter((d) => d.kind === 'add').map((d) => d.token.text).join('')).toBe('dog');
  });

  it('纯新增（old 空）→ 全 add', () => {
    const diff = diffLineWords('', '新内容');
    expect(diff.every((d) => d.kind === 'add')).toBe(true);
  });

  it('纯删除（new 空）→ 全 remove', () => {
    const diff = diffLineWords('旧内容', '');
    expect(diff.every((d) => d.kind === 'remove')).toBe(true);
  });

  it('两侧空 → []', () => {
    expect(diffLineWords('', '')).toEqual([]);
  });

  it('前缀公共后缀变动：equal 前缀保留', () => {
    const diff = diffLineWords('他说：', '他说：你好');
    // equal(他说：) + add(你好)
    expect(diff[0].kind).toBe('equal');
    expect(diff.some((d) => d.kind === 'add' && d.token.text === '你好')).toBe(true);
  });
});

describe('diffTokens — LCS 对齐正确性', () => {
  it('公共子序列保留为 equal，变动为 remove+add（离散 token）', () => {
    // 'a b c' tokenize → [word:a, space, word:b, space, word:c]；'a x c' 同理。
    const oldT = tokenize('a b c');
    const newT = tokenize('a x c');
    const diff = diffTokens(oldT, newT);
    const kinds = diff.map((d) => d.kind);
    // equal(a) equal(space) remove(b) add(x) equal(space) equal(c)
    expect(kinds).toEqual(['equal', 'equal', 'remove', 'add', 'equal', 'equal']);
    expect(diff.filter((d) => d.kind === 'remove').map((d) => d.token.text).join('')).toBe('b');
    expect(diff.filter((d) => d.kind === 'add').map((d) => d.token.text).join('')).toBe('x');
  });

  it('顺序保持：按文本顺序输出，不乱序', () => {
    const diff = diffLineWords('a b c d', 'a b c d');
    expect(diff.map((d) => d.token.text).join('')).toBe('a b c d');
  });
});

describe('refineCjkPairs — CJK 成对块字符级细化（两种 diff 顺序）', () => {
  // 构造 remove+add 和 add+remove 两种顺序的输入，验证 refine 都正确标 remove=旧字/add=新字。
  function makePair(order: 'remove-add' | 'add-remove'): TokenDiff[] {
    const oldTok = { text: '她死死盯着', kind: 'cjk' as const };
    const newTok = { text: '她紧紧盯着', kind: 'cjk' as const };
    return order === 'remove-add'
      ? [{ kind: 'remove', token: oldTok }, { kind: 'add', token: newTok }]
      : [{ kind: 'add', token: newTok }, { kind: 'remove', token: oldTok }];
  }

  it('remove+add 顺序：remove 段含死死（旧）、add 段含紧紧（新）', () => {
    const refined = refineCjkPairs(makePair('remove-add'));
    const removes = refined.filter((d) => d.kind === 'remove').map((d) => d.token.text).join('');
    const adds = refined.filter((d) => d.kind === 'add').map((d) => d.token.text).join('');
    expect(removes).toBe('死死');
    expect(adds).toBe('紧紧');
  });

  it('add+remove 顺序：仍 remove=死死（旧）、add=紧紧（新），顺序不反转语义', () => {
    const refined = refineCjkPairs(makePair('add-remove'));
    const removes = refined.filter((d) => d.kind === 'remove').map((d) => d.token.text).join('');
    const adds = refined.filter((d) => d.kind === 'add').map((d) => d.token.text).join('');
    expect(removes).toBe('死死');
    expect(adds).toBe('紧紧');
  });

  it('非 CJK 成对（英文 word）不细化', () => {
    const input: TokenDiff[] = [
      { kind: 'remove', token: { text: 'cat', kind: 'word' } },
      { kind: 'add', token: { text: 'dog', kind: 'word' } },
    ];
    expect(refineCjkPairs(input)).toEqual(input);
  });

  it('BMad CR-002 长度闸：超长 CJK 串跳过细化回退整块换（防爆内存）', () => {
    // 构造 >256 字的 CJK 成对块（首尾相同，中间不同——细化本应标出，但长度闸跳过）。
    const oldText = '她' + '死'.repeat(300) + '盯着';
    const newText = '她' + '紧'.repeat(300) + '盯着';
    const diff = diffLineWords(oldText, newText);
    // 长度闸触发：整块 remove + 整块 add（非字符级细化）。
    const removes = diff.filter((d) => d.kind === 'remove');
    const adds = diff.filter((d) => d.kind === 'add');
    expect(removes.length).toBe(1);
    expect(adds.length).toBe(1);
    expect(removes[0].token.text).toBe(oldText);
    expect(adds[0].token.text).toBe(newText);
  });
});
