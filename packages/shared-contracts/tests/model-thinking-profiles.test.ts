import { describe, expect, it } from 'vitest';
import {
  THINKING_PROFILES,
  mapLevel,
  thinkingKindSchema,
  validateCustom,
} from '../src';

// ── Thinking adapters task (2026-08-25): unified-level → vendor mapping ──

describe('THINKING_PROFILES coverage', () => {
  it('every thinking kind has a profile (Record completeness over the 15-member enum)', () => {
    expect(Object.keys(THINKING_PROFILES).sort()).toEqual([...thinkingKindSchema.options].sort());
    expect(thinkingKindSchema.options).toHaveLength(15); // CR-009: +kimi-k27-forced
  });

  it('every non-gemini profile lists the five selectable levels; gemini lists none (v1 no-inject)', () => {
    for (const [kind, profile] of Object.entries(THINKING_PROFILES)) {
      if (kind === 'gemini') {
        expect(profile.levels).toEqual([]);
      } else {
        expect(profile.levels).toEqual(['off', 'low', 'medium', 'high', 'max']);
      }
    }
  });

  it('forced-thinking models mark off illegal', () => {
    expect(THINKING_PROFILES['glm-forced-effort'].offLegal).toBe(false);
    expect(THINKING_PROFILES['glm-forced-basic'].offLegal).toBe(false);
    expect(THINKING_PROFILES['kimi-k3'].offLegal).toBe(false);
    expect(THINKING_PROFILES['kimi-k27-forced'].offLegal).toBe(false); // CR-009: k2.7 disabled errors at vendor
    expect(THINKING_PROFILES['claude-forced'].offLegal).toBe(false);
    expect(THINKING_PROFILES['openai-o'].offLegal).toBe(false);
  });

  it('dropTemperature is set exactly where the vendor documents a temperature constraint', () => {
    const dropping = Object.entries(THINKING_PROFILES)
      .filter(([, profile]) => profile.dropTemperature)
      .map(([kind]) => kind)
      .sort();
    expect(dropping).toEqual([
      'claude-4x',
      'claude-5',
      'claude-budget',
      'claude-forced',
      'deepseek-v4',
      'gpt5',
      'kimi-k2',
      'kimi-k27-forced', // CR-009
      'kimi-k3',
      'openai-o',
    ]);
  });

  it('reasoning round-trip obligations match research A (required on deepseek+k3+k2.7+claude, none on no-reasoning paths)', () => {
    expect(THINKING_PROFILES['deepseek-v4'].reasoningRoundTrip).toBe('required');
    expect(THINKING_PROFILES['kimi-k3'].reasoningRoundTrip).toBe('required');
    expect(THINKING_PROFILES['kimi-k27-forced'].reasoningRoundTrip).toBe('required'); // CR-009: Preserved always on (keep default 'all')
    expect(THINKING_PROFILES['claude-forced'].reasoningRoundTrip).toBe('required');
    expect(THINKING_PROFILES['kimi-k2'].reasoningRoundTrip).toBe('optional'); // k2.5/k2.6 keep=null drops history
    expect(THINKING_PROFILES['glm-dynamic-basic'].reasoningRoundTrip).toBe('optional');
    expect(THINKING_PROFILES['openai-o'].reasoningRoundTrip).toBe('none');
    expect(THINKING_PROFILES['gpt5'].reasoningRoundTrip).toBe('none');
  });
});

describe('mapLevel', () => {
  it('auto maps to nothing for EVERY kind (no injection = pre-feature default)', () => {
    for (const kind of thinkingKindSchema.options) {
      expect(mapLevel(kind, 'auto')).toEqual({});
    }
  });

  it('every kind × level pair yields a non-empty result (gemini excepted)', () => {
    const levels = ['off', 'low', 'medium', 'high', 'max'] as const;
    for (const kind of thinkingKindSchema.options) {
      for (const level of levels) {
        const mapped = mapLevel(kind, level);
        if (kind === 'gemini') {
          expect(mapped).toEqual({});
        } else {
          expect(Object.keys(mapped).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('medium pre-maps to high where the vendor set lacks medium (glm-5.3/5.2, kimi-k3, deepseek)', () => {
    expect(mapLevel('glm-forced-effort', 'medium')).toEqual({ effort: 'high' });
    expect(mapLevel('glm-dynamic-effort', 'medium')).toEqual({ effort: 'high' });
    expect(mapLevel('kimi-k3', 'medium')).toEqual({ effort: 'high' });
    expect(mapLevel('deepseek-v4', 'medium')).toEqual({ effort: 'high' });
    // ...and passes through where medium is native (claude / openai).
    expect(mapLevel('claude-5', 'medium')).toEqual({ effort: 'medium' });
    expect(mapLevel('claude-4x', 'medium')).toEqual({ effort: 'medium' });
    expect(mapLevel('gpt5', 'medium')).toEqual({ effort: 'medium' });
    expect(mapLevel('openai-o', 'medium')).toEqual({ effort: 'medium' });
  });

  it('fixed tiers pass through on effort-capable kinds', () => {
    expect(mapLevel('glm-forced-effort', 'low')).toEqual({ effort: 'low' });
    expect(mapLevel('glm-forced-effort', 'max')).toEqual({ effort: 'max' });
    expect(mapLevel('glm-dynamic-effort', 'low')).toEqual({ effort: 'low' });
    expect(mapLevel('kimi-k3', 'max')).toEqual({ effort: 'max' });
    expect(mapLevel('deepseek-v4', 'high')).toEqual({ effort: 'high' });
    expect(mapLevel('claude-forced', 'max')).toEqual({ effort: 'max' });
    expect(mapLevel('gpt5', 'high')).toEqual({ effort: 'high' });
  });

  it('effort-less kinds emit the on/off switch only (no effort field)', () => {
    expect(mapLevel('glm-forced-basic', 'high')).toEqual({ on: true });
    expect(mapLevel('glm-dynamic-basic', 'low')).toEqual({ on: true });
    expect(mapLevel('kimi-k2', 'max')).toEqual({ on: true });
    expect(mapLevel('kimi-k27-forced', 'high')).toEqual({ on: true }); // CR-009: k2.7 has no effort field
    expect(mapLevel('glm-dynamic-basic', 'off')).toEqual({ on: false });
    expect(mapLevel('kimi-k2', 'off')).toEqual({ on: false });
  });

  it('off maps to the vendor switch where one exists (legality is offLegal/UI/guard business)', () => {
    expect(mapLevel('glm-forced-effort', 'off')).toEqual({ on: false });
    expect(mapLevel('glm-dynamic-effort', 'off')).toEqual({ on: false });
    expect(mapLevel('deepseek-v4', 'off')).toEqual({ on: false });
    expect(mapLevel('kimi-k3', 'off')).toEqual({ on: false }); // illegal (UI-gated); runtime guard degrades
    expect(mapLevel('kimi-k27-forced', 'off')).toEqual({ on: false }); // CR-009: illegal (disabled errors); runtime guard degrades
    expect(mapLevel('claude-forced', 'off')).toEqual({ on: false }); // illegal (400 at vendor); runtime guard degrades
    expect(mapLevel('openai-o', 'off')).toEqual({ on: false }); // illegal; no vendor switch exists
  });

  it('claude-budget maps unified levels to budget token numbers on the effort channel', () => {
    expect(mapLevel('claude-budget', 'low')).toEqual({ effort: '2048' });
    expect(mapLevel('claude-budget', 'medium')).toEqual({ effort: '8192' });
    expect(mapLevel('claude-budget', 'high')).toEqual({ effort: '16384' });
    expect(mapLevel('claude-budget', 'max')).toEqual({ effort: '32768' });
    expect(mapLevel('claude-budget', 'off')).toEqual({ on: false });
  });

  it('openai-o tops out at high; gpt5 maps off to effort none', () => {
    expect(mapLevel('openai-o', 'max')).toEqual({ effort: 'high' }); // documented tiers top out at high
    expect(mapLevel('openai-o', 'high')).toEqual({ effort: 'high' });
    expect(mapLevel('gpt5', 'off')).toEqual({ effort: 'none' }); // no switch; none ≈ off (5.1+)
    expect(mapLevel('gpt5', 'max')).toEqual({ effort: 'max' });
  });

  it('gemini maps everything to nothing (v1 does not inject)', () => {
    expect(mapLevel('gemini', 'high')).toEqual({});
    expect(mapLevel('gemini', 'off')).toEqual({});
  });
});

describe('validateCustom', () => {
  it('enum kinds accept a listed tier and reject an unlisted one', () => {
    expect(validateCustom('glm-forced-effort', 'low')).toEqual({ ok: true, value: 'low' });
    expect(validateCustom('glm-forced-effort', 'medium').ok).toBe(false); // 5.3 rejects medium outright
    expect(validateCustom('kimi-k3', 'max')).toEqual({ ok: true, value: 'max' });
    expect(validateCustom('claude-5', 'xhigh')).toEqual({ ok: true, value: 'xhigh' });
    expect(validateCustom('deepseek-v4', 'xhigh')).toEqual({ ok: true, value: 'xhigh' }); // accepted, collapses to high
    expect(validateCustom('openai-o', 'max').ok).toBe(false); // documented tiers top out at high
    expect(validateCustom('gpt5', 'none')).toEqual({ ok: true, value: 'none' });
  });

  it('numeric kinds validate an inclusive integer range and normalize the value', () => {
    expect(validateCustom('claude-budget', '2048')).toEqual({ ok: true, value: '2048' });
    expect(validateCustom('claude-budget', '6000')).toEqual({ ok: true, value: '6000' });
    expect(validateCustom('claude-budget', '1024').ok).toBe(true); // min bound inclusive
    expect(validateCustom('claude-budget', '32768').ok).toBe(true); // base max bound inclusive
    expect(validateCustom('claude-budget', '1023').ok).toBe(false); // below min
    expect(validateCustom('claude-budget', '32769').ok).toBe(false); // above the BASE max (limits unknown)
    expect(validateCustom('claude-budget', 'abc').ok).toBe(false);
    expect(validateCustom('claude-budget', '2048.5').ok).toBe(false); // non-integer
  });

  it('CR-020: known limits move the numeric ceiling to maxOutputTokens - 1 (budget must stay below max_tokens)', () => {
    // A model with a verified 64K output ceiling accepts budgets above the
    // 32768 base — the old hardcoded range capped the large-budget tiers.
    const limits64k = { contextWindow: 200_000, maxOutputTokens: 65_536 };
    expect(validateCustom('claude-budget', '50000', limits64k)).toEqual({ ok: true, value: '50000' });
    expect(validateCustom('claude-budget', '65535', limits64k).ok).toBe(true); // ceiling - 1 inclusive
    expect(validateCustom('claude-budget', '65536', limits64k).ok).toBe(false); // ceiling itself excluded (budget < max_tokens)
    // A SMALLER known ceiling tightens the range too — limits replace the base, not just raise it.
    const limits8k = { contextWindow: 200_000, maxOutputTokens: 8_192 };
    expect(validateCustom('claude-budget', '8191', limits8k).ok).toBe(true);
    expect(validateCustom('claude-budget', '8192', limits8k).ok).toBe(false);
  });

  it('non-customizable kinds reject any custom value (enum-less on/off + gemini)', () => {
    expect(validateCustom('gemini', 'high').ok).toBe(false);
    expect(validateCustom('glm-forced-basic', 'high').ok).toBe(false);
    expect(validateCustom('glm-dynamic-basic', 'low').ok).toBe(false);
    expect(validateCustom('kimi-k2', 'low').ok).toBe(false);
  });

  it('rejections carry a human-readable reason', () => {
    const result = validateCustom('claude-budget', '1023');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('1024');
  });
});
