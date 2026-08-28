import { describe, expect, it } from 'vitest';
import {
  storyDecisionSchema,
  storyDecisionStatusSchema,
  storyDecisionSourceSchema,
  type StoryDecision,
  type StoryDecisionStatus,
  type StoryDecisionSource,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.6 / 4.1 Step 3（design §3.5）：StoryDecision 创作决策 ADR schema。
// 纯 Zod schema -> plain vitest（无 fs/db/LLM）。覆盖：
// - status 状态机 4 档 enum（open/decided/superseded/dropped）
// - source enum 4 档（director/accept_as_truth/user/workbench）
// - 必填字段（id/summary/reason/risk/createdAt）缺一即 reject
// - alternatives default []（2.6 防写死：备选方案）
// - status / source default（open / accept_as_truth）
// - createdAt 无 Date.now default（纯函数无 Date 副作用，caller 注入 ISO）
// - supersededBy / landingState / relatedEpisodeId optional
// - superseded 链（supersededBy 指向取代者 id）
// ─────────────────────────────────────────────────────────────────────────────

/** 合法最小 StoryDecision fixture（仅必填；alternatives/status/source 走 default）。 */
function baseDecision(overrides: Partial<StoryDecision> = {}): StoryDecision {
  return {
    id: 'decision_001',
    summary: '角色 A 第3章突然硬气：目标成长，非 OOC',
    reason: '此处偏离软弱人设是为弧光转折服务，体现角色在第3章的关键成长节点',
    risk: '若前置铺垫不足，读者可能出戏认为是 bug 而非设计',
    createdAt: '2026-08-01T10:00:00Z',
    ...overrides,
  } as StoryDecision;
}

describe('storyDecisionStatusSchema（4 档状态机 enum）', () => {
  it('4 档全合法', () => {
    const stages: StoryDecisionStatus[] = ['open', 'decided', 'superseded', 'dropped'];
    for (const s of stages) {
      expect(storyDecisionStatusSchema.parse(s)).toBe(s);
    }
  });

  it('非法档 reject', () => {
    expect(() => storyDecisionStatusSchema.parse('closed')).toThrow();
    expect(() => storyDecisionStatusSchema.parse('')).toThrow();
  });
});

describe('storyDecisionSourceSchema（4 档登记方 enum）', () => {
  it('4 档全合法', () => {
    const sources: StoryDecisionSource[] = ['director', 'accept_as_truth', 'user', 'workbench'];
    for (const s of sources) {
      expect(storyDecisionSourceSchema.parse(s)).toBe(s);
    }
  });

  it('非法 source reject', () => {
    expect(() => storyDecisionSourceSchema.parse('system')).toThrow();
  });
});

describe('storyDecisionSchema（必填字段）', () => {
  it('合法最小 fixture pass（alternatives/status/source 走 default）', () => {
    const r = storyDecisionSchema.parse(baseDecision());
    expect(r.id).toBe('decision_001');
    expect(r.summary).toContain('目标成长');
    expect(r.reason).toContain('弧光转折');
    expect(r.risk).toContain('出戏');
    expect(r.alternatives).toEqual([]); // default
    expect(r.status).toBe('open'); // default
    expect(r.source).toBe('accept_as_truth'); // default
    expect(r.createdAt).toBe('2026-08-01T10:00:00Z');
  });

  it('id 缺 → reject', () => {
    expect(() => storyDecisionSchema.parse(baseDecision({ id: '' }))).toThrow();
  });

  it('summary 缺 → reject', () => {
    expect(() => storyDecisionSchema.parse(baseDecision({ summary: '' }))).toThrow();
  });

  it('reason 缺 → reject', () => {
    expect(() => storyDecisionSchema.parse(baseDecision({ reason: '' }))).toThrow();
  });

  it('risk 缺 → reject（2.6 防写死核心：open 强制想清楚风险）', () => {
    expect(() => storyDecisionSchema.parse(baseDecision({ risk: '' }))).toThrow();
  });

  it('createdAt 缺 → reject（无 Date.now default，caller 必须注入 ISO）', () => {
    const { createdAt: _omit, ...rest } = baseDecision();
    void _omit;
    expect(() => storyDecisionSchema.parse(rest)).toThrow();
  });

  it('createdAt 空串 → reject（min(1)）', () => {
    expect(() => storyDecisionSchema.parse(baseDecision({ createdAt: '' }))).toThrow();
  });
});

describe('storyDecisionSchema（default 行为）', () => {
  it('alternatives 缺省 → []（2.6 防写死：备选方案默认空数组）', () => {
    const { alternatives: _omit, ...rest } = baseDecision();
    void _omit;
    const r = storyDecisionSchema.parse(rest);
    expect(r.alternatives).toEqual([]);
  });

  it('alternatives 显式填 pass + round-trip', () => {
    const r = storyDecisionSchema.parse(baseDecision({ alternatives: ['保持软弱', '渐进硬化'] }));
    expect(r.alternatives).toEqual(['保持软弱', '渐进硬化']);
  });

  it('status 缺省 → open', () => {
    const { status: _omit, ...rest } = baseDecision();
    void _omit;
    expect(storyDecisionSchema.parse(rest).status).toBe('open');
  });

  it('source 缺省 → accept_as_truth', () => {
    const { source: _omit, ...rest } = baseDecision();
    void _omit;
    expect(storyDecisionSchema.parse(rest).source).toBe('accept_as_truth');
  });
});

describe('storyDecisionSchema（optional 字段 + superseded 链）', () => {
  it('landingState / supersededBy / relatedEpisodeId optional（缺省合法）', () => {
    const r = storyDecisionSchema.parse(baseDecision());
    expect(r.landingState).toBeUndefined();
    expect(r.supersededBy).toBeUndefined();
    expect(r.relatedEpisodeId).toBeUndefined();
  });

  it('superseded 状态带 supersededBy 链（指向取代者 id）', () => {
    const superseded = storyDecisionSchema.parse(
      baseDecision({
        id: 'decision_001',
        status: 'superseded',
        supersededBy: 'decision_007',
      }),
    );
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededBy).toBe('decision_007');
  });

  it('relatedEpisodeId 命中本章 episode（brief #8 filter 用）', () => {
    const r = storyDecisionSchema.parse(
      baseDecision({ relatedEpisodeId: 'ep3', status: 'open' }),
    );
    expect(r.relatedEpisodeId).toBe('ep3');
  });

  it('全局 open 决策（relatedEpisodeId 缺省，所有章警告）合法', () => {
    const r = storyDecisionSchema.parse(baseDecision({ status: 'open' }));
    expect(r.relatedEpisodeId).toBeUndefined();
    expect(r.status).toBe('open');
  });

  it('source = director（Director agent 登记，defer Director 建立）合法', () => {
    const r = storyDecisionSchema.parse(baseDecision({ source: 'director' }));
    expect(r.source).toBe('director');
  });
});

describe('storyDecisionSchema（round-trip 确定性）', () => {
  it('parse 输出再 parse 等价', () => {
    const once = storyDecisionSchema.parse(
      baseDecision({
        alternatives: ['A', 'B'],
        status: 'decided',
        source: 'user',
        landingState: '已体现在第3章正文',
        relatedEpisodeId: 'ep3',
      }),
    );
    const twice = storyDecisionSchema.parse(once);
    expect(twice).toEqual(once);
  });
});
