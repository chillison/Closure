import { describe, expect, it, vi } from 'vitest';
import {
  EVAL_DEFAULT_K,
  evalCaseSchema,
  evalExpectedSchema,
  evalSetFromCases,
  evalSetSchema,
  scoreEvalCases,
  type EntryHit,
  type EvalCase,
  type EvalExpected,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 S8：fiction eval 契约 + 打分纯函数（design §6b）。三个面：
//   ① schema：EvalCase/EvalExpected 形态与 refine 门（entryId/chapterId 至少其一）。
//   ② evalSetFromCases：per-element 容错（坏条目 warn 跳过不丢全，mirror foreshadow E5）。
//   ③ scoreEvalCases：recall@k / MRR / perCase 结构（含 k 截断、章级锚、spanBonus、any-of）。
// 纯函数零依赖——无 DB 无 yaml（yaml 面由 shell retrievalEval smoke 覆盖）。
// ─────────────────────────────────────────────────────────────────────────────

function mkHit(over: Record<string, unknown> = {}): EntryHit {
  return {
    entryId: '00042:card-lin',
    projectId: '00042',
    entryType: 'character',
    sourceKind: 'setting_card',
    name: '临',
    bodyText: '临的档案拼料……',
    visibility: 'known',
    score: 0.031,
    ...over,
  };
}

function mkCase(id: string, expected: EvalExpected[]): EvalCase {
  return { id, query: `查询-${id}`, expected };
}

describe('evalExpectedSchema — 期望命中形态', () => {
  it('三种合法锚：entryId / chapterId / 两者齐（charSpan 可选叠加）', () => {
    expect(evalExpectedSchema.parse({ entryId: '00042:card-lin' })).toEqual({
      entryId: '00042:card-lin',
    });
    const chapter = evalExpectedSchema.parse({ chapterId: 'ch_012' });
    expect(chapter.chapterId).toBe('ch_012');
    const both = evalExpectedSchema.parse({
      entryId: '00042:ch_012#c0',
      chapterId: 'ch_012',
      charSpan: [1200, 1680],
    });
    expect(both.charSpan).toEqual([1200, 1680]);
  });

  it('entryId 与 chapterId 全缺 → reject（charSpan 是加分项不能单独作锚）', () => {
    expect(() => evalExpectedSchema.parse({ charSpan: [0, 100] })).toThrow();
    expect(() => evalExpectedSchema.parse({})).toThrow();
  });

  it('空串 id / 非法 charSpan（负数 / 起止倒置 / 非整数）→ reject', () => {
    expect(() => evalExpectedSchema.parse({ entryId: '' })).toThrow();
    expect(() => evalExpectedSchema.parse({ chapterId: ' ' })).toThrow();
    expect(() => evalExpectedSchema.parse({ entryId: 'x', charSpan: [-1, 10] })).toThrow();
    expect(() => evalExpectedSchema.parse({ entryId: 'x', charSpan: [10, 10] })).toThrow();
    expect(() => evalExpectedSchema.parse({ entryId: 'x', charSpan: [1.5, 10] })).toThrow();
  });
});

describe('evalCaseSchema / evalSetSchema — case 形态', () => {
  it('合法 case 全字段 parse（未知键剥除——作者 yaml 手滑键不炸）', () => {
    const parsed = evalCaseSchema.parse({
      id: 'lin-cry',
      query: '临上次哭是哪一章',
      expected: [{ chapterId: 'ch_012', charSpan: [1200, 1680] }],
      note: '雨夜对峙',
      stray: '未知键',
    });
    expect(parsed.id).toBe('lin-cry');
    expect(parsed.note).toBe('雨夜对峙');
    expect('stray' in parsed).toBe(false);
  });

  it('缺 id / 缺 query / expected 空 → reject（空 expected 是无锚数据错误，非合法 miss）', () => {
    expect(() => evalCaseSchema.parse({ query: 'q', expected: [{ entryId: 'x' }] })).toThrow();
    expect(() => evalCaseSchema.parse({ id: 'x', expected: [{ entryId: 'x' }] })).toThrow();
    expect(() => evalCaseSchema.parse({ id: 'x', query: 'q', expected: [] })).toThrow();
  });

  it('evalSetSchema 严格校验整个评估集（程序化构造面）', () => {
    const set = evalSetSchema.parse({ cases: [mkCase('a', [{ entryId: 'e-a' }])] });
    expect(set.cases).toHaveLength(1);
    expect(() => evalSetSchema.parse({ cases: [{ id: 'bad' }] })).toThrow();
  });
});

describe('evalSetFromCases — per-element 容错（坏条目跳过不丢全）', () => {
  it('好条目保留 + 坏条目 skipped 计数 + console.warn（mirror foreshadow E5）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const good = mkCase('good', [{ entryId: 'e-1' }]);
      const raw = {
        cases: [
          good,
          { id: 'no-query' }, // 缺 query + expected
          { id: 'empty-expected', query: 'q', expected: [] }, // expected 空
          { id: 'no-anchor', query: 'q', expected: [{ charSpan: [0, 9] }] }, // 期望无锚
          { id: 'ok-again', query: 'q2', expected: [{ chapterId: 'ch_1' }] },
        ],
      };
      const result = evalSetFromCases(raw);
      expect(result.cases.map((c) => c.id)).toEqual(['good', 'ok-again']);
      expect(result.skipped).toBe(3);
      expect(warn).toHaveBeenCalledTimes(3);
      // warn 文案带具体原因（作者修档反馈面）。
      expect(warn.mock.calls[0]![0]).toContain('expected');
    } finally {
      warn.mockRestore();
    }
  });

  it('raw 非对象 / cases 非数组 → 空集 + warn（B6：两分支都有作者反馈，无静默）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(evalSetFromCases(null)).toEqual({ cases: [], skipped: 0 });
      expect(evalSetFromCases('string')).toEqual({ cases: [], skipped: 0 });
      expect(evalSetFromCases([{ id: 'x' }])).toEqual({ cases: [], skipped: 0 }); // 顶层数组非集
      expect(evalSetFromCases({})).toEqual({ cases: [], skipped: 0 });
      // B6（CR 2026-08-20）：根非对象分支补 warn（对齐 JSDoc「warn + 空集」契约——此前静默，
      // 作者写错档零反馈）——null/string/array 三次 + cases-缺数组一次 = 4。
      expect(warn).toHaveBeenCalledTimes(4);
      expect(warn.mock.calls[0]![0]).toContain('根不是对象');
      expect(warn.mock.calls[3]![0]).toContain('cases');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('scoreEvalCases — recall@k / MRR / perCase', () => {
  it('全命中 rank1 → recall 1 / MRR 1；perCase 与入参同序', () => {
    const cases = [mkCase('a', [{ entryId: 'hit-a' }]), mkCase('b', [{ entryId: 'hit-b' }])];
    const hits = new Map<string, EntryHit[]>([
      ['a', [mkHit({ entryId: 'hit-a' })]],
      ['b', [mkHit({ entryId: 'hit-b' })]],
    ]);
    const result = scoreEvalCases(cases, hits);
    expect(result.recallAtK).toBe(1);
    expect(result.mrr).toBe(1);
    expect(result.perCase.map((p) => p.caseId)).toEqual(['a', 'b']);
    expect(result.perCase[0]).toEqual({ caseId: 'a', hit: true, firstRank: 1, matchedExpected: cases[0]!.expected[0] });
  });

  it('混合命中（rank1 / rank3 / rank2 / miss）→ recall 3/4，MRR = (1 + 1/3 + 1/2 + 0)/4', () => {
    const cases = [
      mkCase('a', [{ entryId: 'e-1' }]),
      mkCase('b', [{ entryId: 'e-2' }]),
      mkCase('c', [{ entryId: 'e-3' }]),
      mkCase('d', [{ entryId: 'never' }]),
    ];
    const filler = (id: string): EntryHit => mkHit({ entryId: `noise-${id}` });
    const hits = new Map<string, EntryHit[]>([
      ['a', [mkHit({ entryId: 'e-1' }), filler('a1'), filler('a2')]],
      ['b', [filler('b1'), filler('b2'), mkHit({ entryId: 'e-2' })]],
      ['c', [filler('c1'), mkHit({ entryId: 'e-3' }), filler('c2')]],
      ['d', [filler('d1'), filler('d2')]],
    ]);
    const result = scoreEvalCases(cases, hits, 5);
    expect(result.recallAtK).toBe(0.75);
    expect(result.mrr).toBeCloseTo((1 + 1 / 3 + 1 / 2 + 0) / 4, 12);
    expect(result.perCase[1]!.firstRank).toBe(3);
    expect(result.perCase[3]).toEqual({ caseId: 'd', hit: false }); // miss 二态：无 firstRank 键
  });

  it('k 截断：rank 3 命中在 k=2 下不可见 → miss（recall 只看前 k 条）', () => {
    const cases = [mkCase('b', [{ entryId: 'e-2' }])];
    const hits = new Map<string, EntryHit[]>([
      ['b', [mkHit({ entryId: 'n1' }), mkHit({ entryId: 'n2' }), mkHit({ entryId: 'e-2' })]],
    ]);
    expect(scoreEvalCases(cases, hits, 5).recallAtK).toBe(1);
    expect(scoreEvalCases(cases, hits, 2).recallAtK).toBe(0);
    expect(scoreEvalCases(cases, hits, 2).perCase[0]!.hit).toBe(false);
  });

  it('章级锚：章源 hit 的 chapterId 命中期望；非章源 hit 无 chapterId 不误命中', () => {
    const cases = [mkCase('ch', [{ chapterId: 'ch_012' }])];
    const chapterHit = mkHit({ entryId: '00042:ch_012#c1', sourceKind: 'chapter', chapterId: 'ch_012' });
    const cardHit = mkHit({ entryId: '00042:card-x' }); // 卡行：chapterId 键不存在
    const result = scoreEvalCases(cases, new Map([['ch', [cardHit, chapterHit]]]));
    expect(result.perCase[0]!.hit).toBe(true);
    expect(result.perCase[0]!.firstRank).toBe(2); // 第 1 条卡不匹配，第 2 条章段命中
    expect(result.perCase[0]!.matchedExpected).toEqual({ chapterId: 'ch_012' });
  });

  it('any-of 多期望：命中任一即算，matchedExpected = 实际兑现的那条', () => {
    const cases = [mkCase('multi', [{ entryId: 'e-a' }, { chapterId: 'ch_9' }, { entryId: 'e-c' }])];
    const result = scoreEvalCases(
      cases,
      new Map([['multi', [mkHit({ entryId: 'e-c' })]]]),
    );
    expect(result.recallAtK).toBe(1);
    expect(result.perCase[0]!.matchedExpected).toEqual({ entryId: 'e-c' });
  });

  it('spanBonus：区间交集非空 → true；相离 → false；不可算（任一侧无区间）→ 键不出现', () => {
    const spanCase = (span: [number, number]) => mkCase('s', [{ chapterId: 'ch_1', charSpan: span }]);
    const chapterHit = (start: number, end: number): EntryHit =>
      mkHit({ entryId: '00042:ch_1#c0', sourceKind: 'chapter', chapterId: 'ch_1', charStart: start, charEnd: end });

    const overlap = scoreEvalCases([spanCase([150, 250])], new Map([['s', [chapterHit(100, 200)]]]));
    expect(overlap.perCase[0]!.spanBonus).toBe(true); // [100,200) ∩ [150,250) = [150,200) 非空

    const disjoint = scoreEvalCases([spanCase([300, 400])], new Map([['s', [chapterHit(100, 200)]]]));
    expect(disjoint.perCase[0]!.spanBonus).toBe(false);

    // 期望无 charSpan → 不算加分（键不出现）。
    const noExpSpan = scoreEvalCases([mkCase('s', [{ chapterId: 'ch_1' }])], new Map([['s', [chapterHit(100, 200)]]]));
    expect('spanBonus' in noExpSpan.perCase[0]!).toBe(false);

    // 命中非章源（无区间）→ 不可算（键不出现）。
    const noHitSpan = scoreEvalCases([spanCase([0, 50])], new Map([['s', [mkHit({ entryId: 'card' })]]]));
    expect(noHitSpan.recallAtK).toBe(0); // 且不误命中（chapterId 锚对卡行不匹配）
    expect('spanBonus' in noHitSpan.perCase[0]!).toBe(false);
  });

  it('hitsByQuery 缺该 case 的结果 / 空 hits → 按 miss 处理；零 case → 全零不 NaN', () => {
    const missing = scoreEvalCases([mkCase('x', [{ entryId: 'e' }])], new Map());
    expect(missing.recallAtK).toBe(0);
    expect(missing.mrr).toBe(0);
    expect(missing.perCase[0]!.hit).toBe(false);

    const empty = scoreEvalCases([], new Map());
    expect(empty).toEqual({ recallAtK: 0, mrr: 0, perCase: [] });
  });

  it('非正值 k 按 1 兜底（防御手滑参数——不让打分静默全 miss）+ 默认 k = 5', () => {
    expect(EVAL_DEFAULT_K).toBe(5);
    const cases = [mkCase('a', [{ entryId: 'e-1' }])];
    const hits = new Map([['a', [mkHit({ entryId: 'e-1' })]]]);
    expect(scoreEvalCases(cases, hits, 0).recallAtK).toBe(1);
    expect(scoreEvalCases(cases, hits).recallAtK).toBe(1);
  });
});
