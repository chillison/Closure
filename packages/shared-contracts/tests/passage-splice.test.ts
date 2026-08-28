import { describe, it, expect } from 'vitest';
import {
  buildSelectionAnchor,
  diceSimilarity,
  locateSelection,
  splicePassage,
} from '../src/contracts/passage-splice';
import type { SelectionAnchor } from '../src/contracts/attachment';

// ── Story 7.1 Step 3：段落级 splice 定位测试（Route 1，design §3.2）──
//
// 覆盖 locateSelection 三态（unique 单匹配 / unique 消歧 / ambiguous / not-found）+ splicePassage
// 成功 / 定位失败 graceful。mirror agentDiffSlice locatePassage 既有行为（已验证），scope 收窄为 anchor。

function anchor(quote: string, extra?: Partial<SelectionAnchor>): SelectionAnchor {
  return {
    quote,
    prefix: extra?.prefix ?? '',
    suffix: extra?.suffix ?? '',
    rangeHint: extra?.rangeHint ?? { from: 0, to: 0 },
  };
}

describe('diceSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(diceSimilarity('战斗开始了', '战斗开始了')).toBe(1);
  });

  it('returns 0 for empty input', () => {
    expect(diceSimilarity('', '战斗')).toBe(0);
    expect(diceSimilarity('战斗', '')).toBe(0);
  });

  it('returns partial for similar strings', () => {
    const sim = diceSimilarity('战斗开始了', '战斗开始');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

describe('locateSelection', () => {
  it('unique when quote appears exactly once', () => {
    const content = '前文。战斗开始了。后文。';
    // '战斗开始了' = 5 chars, from=3 (after '前文。'), to=3+5=8.
    const result = locateSelection(content, anchor('战斗开始了'));
    expect(result).toEqual({ status: 'unique', from: 3, to: 8 });
  });

  it('unique via anchor disambiguation when quote appears multiple times (clear winner)', () => {
    // quote 重复 2 次，prefix 区分。
    const content = '场景一：刀光闪过。场景二：刀光闪过。';
    const a = anchor('刀光闪过', { prefix: '场景一：' });
    const result = locateSelection(content, a);
    expect(result.status).toBe('unique');
    if (result.status === 'unique') {
      expect(result.from).toBe(4); // 场景一：后第一个"刀光闪过"
    }
  });

  it('ambiguous when quote repeats and prefix/suffix do not disambiguate', () => {
    const content = '刀光闪过。中间。刀光闪过。';
    // 无 prefix/suffix，两候选打分持平 → ambiguous。
    const result = locateSelection(content, anchor('刀光闪过'));
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('not-found when quote absent from content', () => {
    const content = '完全不同的正文。';
    const result = locateSelection(content, anchor('战斗开始了'));
    expect(result.status).toBe('not-found');
  });

  // BMad CR F8：quote .min(1) 后空 quote 在 schema 层拦（locateSelection 仍防御 findExactOccurrenceRanges
  // 空串返 [] → not-found，但生产路径 schema 先拒）。此处验 locateSelection 对空 quote 的防御行为。
  it('empty quote → not-found (defensive; schema-layer .min(1) catches upstream)', () => {
    // locateSelection 直接调（绕 schema），验 findExactOccurrenceRanges 空串返 [] → not-found 不崩。
    const result = locateSelection('正文', anchor(''));
    expect(result.status).toBe('not-found');
  });
});

describe('splicePassage', () => {
  it('splices passage into full draft replacing the located quote', () => {
    const fullDraft = '前文。战斗开始了。后文。';
    const a = anchor('战斗开始了');
    const result = splicePassage(fullDraft, a, '战斗惨烈地开始了');
    expect(result.status).toBe('spliced');
    if (result.status === 'spliced') {
      expect(result.text).toBe('前文。战斗惨烈地开始了。后文。');
    }
  });

  it('preserves text before and after the located passage exactly', () => {
    const fullDraft = '第一段。\n\n战斗开始了。\n\n最后一段。';
    const result = splicePassage(fullDraft, anchor('战斗开始了'), '战斗结束了');
    expect(result.status).toBe('spliced');
    if (result.status === 'spliced') {
      expect(result.text).toBe('第一段。\n\n战斗结束了。\n\n最后一段。');
    }
  });

  it('locate-failed when quote not found (graceful, no silent corruption)', () => {
    const fullDraft = '完全不同的正文。';
    const result = splicePassage(fullDraft, anchor('战斗开始了'), '新段落');
    expect(result.status).toBe('locate-failed');
    if (result.status === 'locate-failed') {
      expect(result.reason).toBe('not-found');
    }
  });

  it('locate-failed when ambiguous (graceful)', () => {
    const fullDraft = '刀光闪过。中间。刀光闪过。';
    const result = splicePassage(fullDraft, anchor('刀光闪过'), '新段落');
    expect(result.status).toBe('locate-failed');
    if (result.status === 'locate-failed') {
      expect(result.reason).toBe('ambiguous');
    }
  });
});

// ── BMad CR F2：纯代码构造 SelectionAnchor（buildSelectionAnchor）──

describe('buildSelectionAnchor（F2 纯代码 anchor 构造）', () => {
  it('constructs anchor with quote + prefix/suffix slices + rangeHint', () => {
    const draft = '前文内容在这里。战斗开始了。后文内容在这里。';
    // positions: 前(0)文(1)内(2)容(3)在(4)这(5)里(6)。(7)战(8)斗(9)开(10)始(11)了(12)。(13)后(14)...
    const anchor = buildSelectionAnchor(draft, '战斗开始了', 8, 13, 5);
    expect(anchor.quote).toBe('战斗开始了');
    expect(anchor.prefix).toBe('容在这里。'); // slice(3, 8) = 5 chars before position 8
    expect(anchor.suffix).toBe('。后文内容'); // slice(13, 18) = 5 chars after position 13
    expect(anchor.rangeHint).toEqual({ from: 8, to: 13 });
  });

  it('prefix clamps to 0 at document start (no negative slice)', () => {
    const draft = '战斗开始了。后文。';
    const anchor = buildSelectionAnchor(draft, '战斗开始了', 0, 5, 50);
    expect(anchor.prefix).toBe(''); // slice(max(0,0-50),0)=slice(0,0)=''
    expect(anchor.suffix).toBe('。后文。');
    expect(anchor.rangeHint).toEqual({ from: 0, to: 5 });
  });

  it('suffix clamps to draft length at document end', () => {
    const draft = '前文。战斗开始了';
    const anchor = buildSelectionAnchor(draft, '战斗开始了', 3, 8, 50);
    expect(anchor.prefix).toBe('前文。');
    expect(anchor.suffix).toBe(''); // slice(8, min(len, 8+50))=slice(8,8)=''
  });

  it('from/to clamped to draft bounds (defensive against bad PM positions)', () => {
    const draft = '短';
    const anchor = buildSelectionAnchor(draft, '短', 100, 200, 10);
    expect(anchor.rangeHint).toEqual({ from: 1, to: 1 }); // clamped to length
  });

  it('constructed anchor disambiguates duplicate quotes (F2 core value)', () => {
    // 重复 quote：两次「刀光闪过」，prefix 区分。
    const draft = '场景一：刀光闪过。中间。场景二：刀光闪过。';
    const anchor = buildSelectionAnchor(draft, '刀光闪过', 4, 8, 4); // 第一次「刀光闪过」
    expect(anchor.prefix).toBe('场景一：');
    // 用构造的 anchor 定位 → 应 unique 指向第一次（prefix 消歧）。
    const located = locateSelection(draft, anchor);
    expect(located.status).toBe('unique');
    if (located.status === 'unique') {
      expect(located.from).toBe(4); // 第一次位置
    }
  });
});
