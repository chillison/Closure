import { describe, expect, it } from 'vitest';
import {
  applyDecisionActions,
  assertTransition,
  collectRelevantDecisions,
  findDanglingSuperseded,
  storyDecisionActionSchema,
  storyDecisionDraftSchema,
  storyDecisionsUpdateRequestSchema,
  type StoryDecision,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.6 Step 1：纯函数（assertTransition / findDanglingSuperseded /
// collectRelevantDecisions）+ action 契约（storyDecisionDraftSchema /
// storyDecisionActionSchema / storyDecisionsUpdateRequestSchema）+
// applyDecisionActions 重放守卫集（design §3）。纯函数 -> plain vitest。
// ─────────────────────────────────────────────────────────────────────────────

/** 解析 action（zod defaults 补齐 alternatives/source——applyDecisionActions 收 output 类型）。 */
function asActions(raw: unknown[]): import('../src').StoryDecisionAction[] {
  const parsed = storyDecisionActionSchema.array().safeParse(raw);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

function baseDecision(overrides: Partial<StoryDecision> = {}): StoryDecision {
  return {
    id: 'decision_001',
    summary: '女主真背叛主角团',
    reason: '妹妹被挟持，背叛是被迫且有底层动机',
    risk: '铺垫不足则读者恨她弃书',
    status: 'open',
    source: 'workbench',
    alternatives: [],
    createdAt: '2026-08-01T10:00:00Z',
    ...overrides,
  } as StoryDecision;
}

describe('assertTransition（转换矩阵，CR-4.1-14）', () => {
  it('open 全出边合法（open/decided/superseded/dropped）', () => {
    for (const to of ['open', 'decided', 'superseded', 'dropped'] as const) {
      expect(assertTransition('open', to)).toBe(true);
    }
  });

  it('decided 仅 superseded/dropped 合法', () => {
    expect(assertTransition('decided', 'superseded')).toBe(true);
    expect(assertTransition('decided', 'dropped')).toBe(true);
    expect(assertTransition('decided', 'decided')).toBe(false); // 编辑走 supersede
    expect(assertTransition('decided', 'open')).toBe(false); // 重议走 supersede + 新 open
  });

  it('superseded / dropped 终态（无出边）', () => {
    for (const from of ['superseded', 'dropped'] as const) {
      for (const to of ['open', 'decided', 'superseded', 'dropped'] as const) {
        expect(assertTransition(from, to)).toBe(false);
      }
    }
  });
});

describe('findDanglingSuperseded（悬空链，CR-4.1-13）', () => {
  it('supersededBy 指向存在的 id -> 无悬空', () => {
    const decisions = [
      baseDecision({ id: 'd1', status: 'superseded', supersededBy: 'd2' }),
      baseDecision({ id: 'd2', status: 'decided' }),
    ];
    expect(findDanglingSuperseded(decisions)).toEqual([]);
  });

  it('supersededBy 指向不存在的 id -> 报悬空', () => {
    const decisions = [baseDecision({ id: 'd1', status: 'superseded', supersededBy: 'ghost' })];
    expect(findDanglingSuperseded(decisions)).toEqual([{ id: 'd1', supersededBy: 'ghost' }]);
  });

  it('无 supersededBy 的决策不参与（含 open/decided/dropped）', () => {
    const decisions = [
      baseDecision({ id: 'd1' }),
      baseDecision({ id: 'd2', status: 'decided' }),
      baseDecision({ id: 'd3', status: 'dropped' }),
    ];
    expect(findDanglingSuperseded(decisions)).toEqual([]);
  });

  it('空列表 -> []', () => {
    expect(findDanglingSuperseded([])).toEqual([]);
  });
});

describe('collectRelevantDecisions（单源 filter）', () => {
  const decisions = [
    baseDecision({ id: 'open-ep3', status: 'open', relatedEpisodeId: 'ep3', createdAt: '2026-08-01T10:00:00Z' }),
    baseDecision({ id: 'open-global', status: 'open', createdAt: '2026-08-01T11:00:00Z' }),
    baseDecision({ id: 'open-ep9', status: 'open', relatedEpisodeId: 'ep9' }),
    baseDecision({ id: 'decided-ep3', status: 'decided', relatedEpisodeId: 'ep3', createdAt: '2026-08-01T09:00:00Z' }),
    baseDecision({ id: 'decided-global', status: 'decided', createdAt: '2026-08-01T12:00:00Z' }),
    baseDecision({ id: 'superseded-global', status: 'superseded', supersededBy: 'x', createdAt: '2026-08-01T13:00:00Z' }),
    baseDecision({ id: 'dropped-global', status: 'dropped' }),
  ];

  it('open + ep3：命中本章 + 全局，排除他章 / 非 open', () => {
    const r = collectRelevantDecisions(decisions, { status: 'open', episodeId: 'ep3' });
    expect(r.map((d) => d.id).sort()).toEqual(['open-ep3', 'open-global']);
  });

  it('decided + ep3：命中本章 + 全局，superseded/dropped 天然排除', () => {
    const r = collectRelevantDecisions(decisions, { status: 'decided', episodeId: 'ep3' });
    expect(r.map((d) => d.id).sort()).toEqual(['decided-ep3', 'decided-global']);
  });

  it('newestFirst 按 createdAt 降序（cap 截断用）', () => {
    const r = collectRelevantDecisions(decisions, { status: 'decided', episodeId: 'ep3', newestFirst: true });
    expect(r.map((d) => d.id)).toEqual(['decided-global', 'decided-ep3']);
  });

  it('undefined / 空列表 -> []（graceful）', () => {
    expect(collectRelevantDecisions(undefined, { status: 'open' })).toEqual([]);
    expect(collectRelevantDecisions([], { status: 'open' })).toEqual([]);
  });

  it('includeEpisodeScoped（CR-E03）：无 episodeId 视角也含 episode-scoped（leader 全量 / 裁决器）', () => {
    // 不传 includeEpisodeScoped + 无 episodeId：episode-scoped 全被滤掉（opts.episodeId undefined 永不等）。
    const scoped = collectRelevantDecisions(decisions, { status: 'open' });
    expect(scoped.map((d) => d.id)).toEqual(['open-global']);
    // 传 includeEpisodeScoped：episode-scoped open 也进（leader 提醒 / 裁决器参考视角）。
    const all = collectRelevantDecisions(decisions, { status: 'open', includeEpisodeScoped: true });
    expect(all.map((d) => d.id).sort()).toEqual(['open-ep3', 'open-ep9', 'open-global']);
    // 与 episodeId 共存时 episodeId 优先语义不变（includeEpisodeScoped 不放大有 episode 视角的查询）。
    const withEp = collectRelevantDecisions(decisions, { status: 'open', episodeId: 'ep3', includeEpisodeScoped: true });
    expect(withEp.map((d) => d.id).sort()).toEqual(['open-ep3', 'open-ep9', 'open-global']);
  });
});

describe('storyDecisionDraftSchema / action / request 契约', () => {
  it('draft：无 createdAt 合法 + source 缺省 workbench', () => {
    const r = storyDecisionDraftSchema.parse({
      id: 'd1',
      summary: 's',
      reason: 'r',
      risk: 'k',
    });
    expect(r.source).toBe('workbench');
    expect((r as { createdAt?: unknown }).createdAt).toBeUndefined();
  });

  it('request：三 op 全 parse + autoApply/force optional', () => {
    const parsed = storyDecisionsUpdateRequestSchema.parse({
      actions: [
        { op: 'register', decision: { id: 'd1', summary: 's', reason: 'r', risk: 'k', status: 'open', source: 'user' } },
        { op: 'supersede', oldId: 'd0', decision: { id: 'd2', summary: 's', reason: 'r', risk: 'k', status: 'decided' } },
        { op: 'drop', id: 'd3', reason: '方向已废' },
      ],
      autoApply: true,
      force: true,
    });
    expect(parsed.actions).toHaveLength(3);
    expect(parsed.force).toBe(true);
  });

  it('request：空 actions -> reject（min(1) 二态约定）', () => {
    expect(() => storyDecisionsUpdateRequestSchema.parse({ actions: [] })).toThrow();
  });

  it('action：未知 op -> reject', () => {
    expect(() =>
      storyDecisionActionSchema.parse({ op: 'delete', id: 'd1' }),
    ).toThrow();
  });
});

describe('applyDecisionActions（重放守卫集）', () => {
  const nowISO = '2026-08-16T08:00:00Z';

  it('register 新 id：追加 + nowISO 注入 createdAt', () => {
    const r = applyDecisionActions(
      [],
      asActions([{ op: 'register', decision: { id: 'd1', summary: 's', reason: 'r', risk: 'k', status: 'open', source: 'user' } }]),
      { nowISO },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next).toHaveLength(1);
      expect(r.next[0].createdAt).toBe(nowISO);
      expect(r.warnings).toEqual([]);
    }
  });

  it('register 既有 id 的 open->open 幂等更新：合法（更新内容，createdAt 保留）', () => {
    const r = applyDecisionActions(
      [baseDecision({ id: 'd1', summary: '旧描述', createdAt: '2026-01-01T00:00:00Z' })],
      asActions([{ op: 'register', decision: { id: 'd1', summary: 's2', reason: 'r2', risk: 'k2', status: 'open' } }]),
      { nowISO },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next).toHaveLength(1);
      expect(r.next[0].summary).toBe('s2');
      expect(r.next[0].createdAt).toBe('2026-01-01T00:00:00Z');
    }
  });

  it('register 既有 id 的 open->decided 拍板：合法 + createdAt 保留', () => {
    const r = applyDecisionActions(
      [baseDecision({ id: 'd1', status: 'open', createdAt: '2026-01-01T00:00:00Z' })],
      asActions([{ op: 'register', decision: { id: 'd1', summary: 's', reason: 'r', risk: 'k', status: 'decided' } }]),
      { nowISO },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next[0].status).toBe('decided');
      expect(r.next[0].createdAt).toBe('2026-01-01T00:00:00Z'); // 保留决策产生时间
    }
  });

  it('register 重登记 = 字段级合并非整条覆盖（CR-B02/E02）：未提及的 relatedEpisodeId/landingState/alternatives 保留', () => {
    // 拍板 flow 实况：作者说「就按 d1 定了」→ leader 只发 status/reason 等，不发全部字段。
    const existing = baseDecision({
      id: 'd1',
      status: 'open',
      relatedEpisodeId: 'ep5',
      landingState: '第 5 章起态度转冷',
      alternatives: ['假背叛'],
      createdAt: '2026-01-01T00:00:00Z',
    });
    const r = applyDecisionActions(
      [existing],
      asActions([{ op: 'register', decision: { id: 'd1', summary: 's', reason: '拍板', risk: 'k', status: 'decided', source: 'user', alternatives: [] } }]),
      { nowISO },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.next[0];
      expect(d.relatedEpisodeId).toBe('ep5'); // 未提及 -> 保留（不是静默变全局）
      expect(d.landingState).toBe('第 5 章起态度转冷'); // 未提及 -> 保留（Reader-Audit 白名单证据）
      expect(d.alternatives).toEqual(['假背叛']); // draft 空（zod default []）-> 保留既有 ADR 历史
      expect(d.status).toBe('decided'); // 提及的 -> draft 值生效
    }
    // draft 显式带非空 alternatives -> 替换（LLM 重发完整列表时信它）。
    const r2 = applyDecisionActions(
      [existing],
      asActions([{ op: 'register', decision: { id: 'd1', summary: 's', reason: 'r', risk: 'k', status: 'open', alternatives: ['假背叛', '真背叛'] } }]),
      { nowISO },
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.next[0].alternatives).toEqual(['假背叛', '真背叛']);
  });

  it('register decided->decided 重登记 -> 拒（编辑走 supersede）', () => {
    const r = applyDecisionActions(
      [baseDecision({ id: 'd1', status: 'decided' })],
      asActions([{ op: 'register', decision: { id: 'd1', summary: 's', reason: 'r', risk: 'k', status: 'decided' } }]),
      { nowISO },
    );
    expect(r).toMatchObject({ ok: false });
  });

  it('register status superseded/dropped -> 拒', () => {
    const r = applyDecisionActions(
      [],
      asActions([{ op: 'register', decision: { id: 'd1', summary: 's', reason: 'r', risk: 'k', status: 'dropped' } }]),
      { nowISO },
    );
    expect(r).toMatchObject({ ok: false });
  });

  it('supersede：旧 -> superseded + supersededBy 链 + 新决策入列', () => {
    const r = applyDecisionActions(
      [baseDecision({ id: 'd1', status: 'decided', summary: '假背叛（无间道）' })],
      asActions([{ op: 'supersede', oldId: 'd1', decision: { id: 'd2', summary: '真背叛', reason: 'r', risk: 'k', status: 'decided' } }]),
      { nowISO },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next).toHaveLength(2);
      const old = r.next.find((d) => d.id === 'd1');
      expect(old?.status).toBe('superseded');
      expect(old?.supersededBy).toBe('d2');
      expect(r.next.find((d) => d.id === 'd2')?.status).toBe('decided');
    }
  });

  it('supersede 目标不存在 -> 拒', () => {
    const r = applyDecisionActions(
      [],
      asActions([{ op: 'supersede', oldId: 'ghost', decision: { id: 'd2', summary: 's', reason: 'r', risk: 'k', status: 'decided' } }]),
      { nowISO },
    );
    expect(r).toMatchObject({ ok: false });
  });

  it('supersede 新 id 撞既有 -> 拒', () => {
    const r = applyDecisionActions(
      [baseDecision({ id: 'd1' }), baseDecision({ id: 'd2' })],
      asActions([{ op: 'supersede', oldId: 'd1', decision: { id: 'd2', summary: 's', reason: 'r', risk: 'k', status: 'decided' } }]),
      { nowISO },
    );
    expect(r).toMatchObject({ ok: false });
  });

  it('drop：终态 + dropReason 留痕', () => {
    const r = applyDecisionActions(
      [baseDecision({ id: 'd1', status: 'open' })],
      [{ op: 'drop', id: 'd1', reason: '作者改走原定主线' }],
      { nowISO },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next[0].status).toBe('dropped');
      expect(r.next[0].dropReason).toBe('作者改走原定主线');
    }
  });

  it('drop 终态再 drop -> 拒', () => {
    const r = applyDecisionActions(
      [baseDecision({ id: 'd1', status: 'dropped' })],
      [{ op: 'drop', id: 'd1', reason: '再弃' }],
      { nowISO },
    );
    expect(r).toMatchObject({ ok: false });
  });

  describe('user-source 保护（三层权威：用户决定硬）', () => {
    it('supersede user 决策无 force -> 拒；force -> 过', () => {
      const userDecision = [baseDecision({ id: 'd1', status: 'decided', source: 'user' })];
      const action = asActions(asActions([{ op: 'supersede', oldId: 'd1', decision: { id: 'd2', summary: 's', reason: 'r', risk: 'k', status: 'decided' } }]));
      expect(applyDecisionActions(userDecision, action, { nowISO })).toMatchObject({ ok: false });
      const forced = applyDecisionActions(userDecision, action, { nowISO, force: true });
      expect(forced.ok).toBe(true);
    });

    it('drop user 决策无 force -> 拒', () => {
      const r = applyDecisionActions(
        [baseDecision({ id: 'd1', source: 'user' })],
        [{ op: 'drop', id: 'd1', reason: 'AI 擅自弃' }],
        { nowISO },
      );
      expect(r).toMatchObject({ ok: false });
    });

    it('register 改写 user 决策无 force -> 拒', () => {
      const r = applyDecisionActions(
        [baseDecision({ id: 'd1', status: 'open', source: 'user' })],
        asActions([{ op: 'register', decision: { id: 'd1', summary: '改', reason: 'r', risk: 'k', status: 'decided', source: 'workbench' } }]),
        { nowISO },
      );
      expect(r).toMatchObject({ ok: false });
    });
  });

  it('既有悬空 supersededBy（盘上遗留）-> warnings 报（不拒）', () => {
    const r = applyDecisionActions(
      [baseDecision({ id: 'd1', status: 'superseded', supersededBy: 'ghost' })],
      asActions([{ op: 'register', decision: { id: 'd2', summary: 's', reason: 'r', risk: 'k', status: 'open' } }]),
      { nowISO },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain('ghost');
    }
  });

  it('不 mutate 入参（纯函数）', () => {
    const input = [baseDecision({ id: 'd1', status: 'decided' })];
    applyDecisionActions(input, [{ op: 'drop', id: 'd1', reason: 'x' }], { nowISO });
    expect(input[0].status).toBe('decided');
    expect(input[0].dropReason).toBeUndefined();
  });
});
