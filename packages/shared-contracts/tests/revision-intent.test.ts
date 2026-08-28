import { describe, expect, it } from 'vitest';
import {
  revisionIntentSchema,
  lockAuthoritySchema,
  revisionIntentSourceSchema,
  selectionAnchorSchema,
  coerceRevisionIntent,
  type RevisionIntent,
  type LockAuthority,
  type RevisionIntentSource,
  type SelectionAnchor,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 7.1（design §2.1）：RevisionIntent schema + SelectionAnchor 跨包迁移。
// 纯 Zod schema → plain vitest（无 fs/db/LLM）。覆盖：
// - selectionAnchorSchema：quote/prefix/suffix/rangeHint 必填 + rangeHint.from/to int
// - lockAuthoritySchema：hard/soft 2 档 + 非法 reject
// - revisionIntentSourceSchema：3 档 trigger（user-directive/audit-finding/redo-feedback）+ 非法 reject
// - revisionIntentSchema：全字段合法 fixture + 缺必填 reject + optional 字段（details/scope）二态
// - details 用 .min(1) 拒空 []（interface-contracts.md optional 数组二态契约）
// - lockedItems 空数组合法（无锁定项 = 无硬约束，非阻塞）
// - coerceRevisionIntent：合法对象 → RevisionIntent / 畸形 → undefined
// ─────────────────────────────────────────────────────────────────────────────

/** 合法 SelectionAnchor fixture。 */
const GOOD_ANCHOR: SelectionAnchor = {
  quote: '他猛地握紧了拳',
  prefix: '林动看着他，',
  suffix: '，转身离去',
  rangeHint: { from: 120, to: 135 },
};

/** 合法最小 RevisionIntent fixture（无 details / scope / 空 lockedItems）。 */
function baseIntent(overrides: Partial<RevisionIntent> = {}): RevisionIntent {
  return {
    change: { summary: '把这段战斗节奏改紧张' },
    lockedItems: [],
    rationale: { source: 'user-directive', note: '用户选段指挥精修' },
    provenance: {
      rawUserInstruction: '这段战斗改紧张点，别动角色性格',
      compilerNote: '细化战斗节奏，锁定角色性格硬约束',
    },
    ...overrides,
  } as RevisionIntent;
}

describe('selectionAnchorSchema（Story 7.1 迁移自 UI attachment.ts）', () => {
  it('全字段合法', () => {
    expect(selectionAnchorSchema.parse(GOOD_ANCHOR)).toEqual(GOOD_ANCHOR);
  });

  it('rangeHint.from/to 必填 int', () => {
    expect(() =>
      selectionAnchorSchema.parse({ ...GOOD_ANCHOR, rangeHint: { from: 0 } }),
    ).toThrow();
    expect(() =>
      selectionAnchorSchema.parse({ ...GOOD_ANCHOR, rangeHint: { from: 'a', to: 1 } }),
    ).toThrow();
  });

  it('quote/prefix/suffix 必填', () => {
    expect(() => {
      const { quote: _omit, ...rest } = GOOD_ANCHOR;
      void _omit;
      selectionAnchorSchema.parse(rest);
    }).toThrow();
  });

  it('空串 prefix/suffix 合法（anchoring 时周边可能无文本）', () => {
    const r = selectionAnchorSchema.parse({ ...GOOD_ANCHOR, prefix: '', suffix: '' });
    expect(r.prefix).toBe('');
    expect(r.suffix).toBe('');
  });
});

describe('lockAuthoritySchema（2 档权威分层）', () => {
  it('hard / soft 全合法', () => {
    const auths: LockAuthority[] = ['hard', 'soft'];
    for (const a of auths) {
      expect(lockAuthoritySchema.parse(a)).toBe(a);
    }
  });

  it('非法值 reject', () => {
    expect(() => lockAuthoritySchema.parse('strict')).toThrow();
    expect(() => lockAuthoritySchema.parse('')).toThrow();
  });
});

describe('revisionIntentSourceSchema（3 档 trigger）', () => {
  it('三 trigger 全合法', () => {
    const sources: RevisionIntentSource[] = ['user-directive', 'audit-finding', 'redo-feedback'];
    for (const s of sources) {
      expect(revisionIntentSourceSchema.parse(s)).toBe(s);
    }
  });

  it('非法值 reject', () => {
    expect(() => revisionIntentSourceSchema.parse('auto')).toThrow();
    expect(() => revisionIntentSourceSchema.parse('')).toThrow();
  });
});

describe('revisionIntentSchema（RevisionIntent 结构）', () => {
  it('合法最小 fixture（无 details / scope / 空 lockedItems）→ parse', () => {
    const intent = baseIntent();
    expect(revisionIntentSchema.parse(intent)).toEqual(intent);
  });

  it('全字段 fixture（含 details + lockedItems + scope）→ parse', () => {
    const intent = baseIntent({
      change: {
        summary: '战斗节奏改紧张',
        details: ['缩短动作间隙', '加内心独白细节', '提升感官密度'],
      },
      lockedItems: [
        { field: '角色性格', authority: 'hard', evidence: '「别动角色性格」（用户原话）' },
        { field: '结论', authority: 'soft', evidence: '该场结论是后续伏笔锚点，推断不该动' },
      ],
      scope: { anchor: GOOD_ANCHOR, chapterId: 'chapter-2' },
    });
    expect(revisionIntentSchema.parse(intent)).toEqual(intent);
  });

  it('lockedItems 空数组合法（无锁定项 = 无硬约束）', () => {
    const intent = baseIntent({ lockedItems: [] });
    expect(() => revisionIntentSchema.parse(intent)).not.toThrow();
  });

  it('lockedItem.evidence optional', () => {
    const intent = baseIntent({
      lockedItems: [{ field: '角色性格', authority: 'hard' }],
    });
    expect(revisionIntentSchema.parse(intent).lockedItems[0].evidence).toBeUndefined();
  });

  it('lockedItem.field 空串 reject', () => {
    const intent = baseIntent({
      lockedItems: [{ field: '', authority: 'hard' }],
    });
    expect(() => revisionIntentSchema.parse(intent)).toThrow();
  });

  it('details 用 .min(1) 拒空 []（optional 数组二态契约）', () => {
    const intent = baseIntent({
      change: { summary: '改', details: [] },
    });
    expect(() => revisionIntentSchema.parse(intent)).toThrow();
  });

  it('details 至少 1 项合法', () => {
    const intent = baseIntent({
      change: { summary: '改', details: ['一项细化'] },
    });
    expect(revisionIntentSchema.parse(intent).change.details).toEqual(['一项细化']);
  });

  it('change.summary 空串 reject（硬要求）', () => {
    const intent = baseIntent({ change: { summary: '' } });
    expect(() => revisionIntentSchema.parse(intent)).toThrow();
  });

  it('rationale.note 空串合法（允许触发原因简述）', () => {
    const intent = baseIntent({ rationale: { source: 'user-directive', note: '' } });
    expect(revisionIntentSchema.parse(intent).rationale.note).toBe('');
  });

  it('rationale.source 非法值 reject', () => {
    const intent = baseIntent({
      rationale: { source: 'auto-trigger' as RevisionIntentSource, note: 'x' },
    });
    expect(() => revisionIntentSchema.parse(intent)).toThrow();
  });

  it('provenance 两字段必填', () => {
    const { rawUserInstruction: _omit, ...rest } = baseIntent().provenance;
    void _omit;
    const intent = baseIntent({ provenance: rest as RevisionIntent['provenance'] });
    expect(() => revisionIntentSchema.parse(intent)).toThrow();
  });

  it('scope.anchor 用 selectionAnchorSchema 校验', () => {
    // anchor 缺 rangeHint → reject
    const intent = baseIntent({
      scope: { anchor: { quote: 'q', prefix: 'p', suffix: 's' } as SelectionAnchor },
    });
    expect(() => revisionIntentSchema.parse(intent)).toThrow();
  });

  it('scope.chapterId optional', () => {
    const intent = baseIntent({ scope: { anchor: GOOD_ANCHOR } });
    expect(revisionIntentSchema.parse(intent).scope?.chapterId).toBeUndefined();
  });

  it('scope 缺省合法（整章范围，A/C trigger 不带选区）', () => {
    const intent = baseIntent();
    expect(revisionIntentSchema.parse(intent).scope).toBeUndefined();
  });

  it('Story 7.4 §1.6：structuralEdit optional boolean（默认缺省=保守正常护栏）', () => {
    // 缺省 → undefined（保守，正常护栏行为）。
    const without = baseIntent();
    expect(revisionIntentSchema.parse(without).structuralEdit).toBeUndefined();

    // 显式 true → 结构编辑触发（revision-guard §1.6 放行故意结构改动）。
    const withFlag = baseIntent({ structuralEdit: true });
    expect(revisionIntentSchema.parse(withFlag).structuralEdit).toBe(true);

    // 显式 false 合法（等价缺省）。
    const withFalse = baseIntent({ structuralEdit: false });
    expect(revisionIntentSchema.parse(withFalse).structuralEdit).toBe(false);
  });

  it('Story 7.4 §1.6：structuralEdit 非法类型 reject（须 boolean）', () => {
    const intent = baseIntent({ structuralEdit: 'true' as unknown as boolean });
    expect(() => revisionIntentSchema.parse(intent)).toThrow();
  });

  it('缺 change → reject', () => {
    const { change: _omit, ...rest } = baseIntent();
    void _omit;
    expect(() => revisionIntentSchema.parse(rest)).toThrow();
  });

  it('缺 rationale → reject', () => {
    const { rationale: _omit, ...rest } = baseIntent();
    void _omit;
    expect(() => revisionIntentSchema.parse(rest)).toThrow();
  });

  it('缺 provenance → reject', () => {
    const { provenance: _omit, ...rest } = baseIntent();
    void _omit;
    expect(() => revisionIntentSchema.parse(rest)).toThrow();
  });
});

describe('coerceRevisionIntent（shape 守卫 + 归一）', () => {
  it('合法对象 → 返 RevisionIntent', () => {
    const intent = baseIntent();
    expect(coerceRevisionIntent(intent)).toEqual(intent);
  });

  it('畸形对象（缺必填）→ undefined', () => {
    expect(coerceRevisionIntent({ foo: 'bar' })).toBeUndefined();
    expect(coerceRevisionIntent({ change: {} })).toBeUndefined();
  });

  it('null / undefined / 非对象 → undefined', () => {
    expect(coerceRevisionIntent(null)).toBeUndefined();
    expect(coerceRevisionIntent(undefined)).toBeUndefined();
    expect(coerceRevisionIntent('string')).toBeUndefined();
    expect(coerceRevisionIntent(42)).toBeUndefined();
    expect(coerceRevisionIntent([])).toBeUndefined();
  });

  it('额外字段容忍（safeParse 默认 strip）', () => {
    const intent = baseIntent();
    const withExtra = { ...intent, unexpectedField: 'ignored' };
    const result = coerceRevisionIntent(withExtra);
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('unexpectedField');
  });
});
