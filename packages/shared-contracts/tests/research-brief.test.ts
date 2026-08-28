import { describe, expect, it } from 'vitest';
import {
  researchBriefSchema,
  researchBriefEntrySchema,
  researchBriefKeyFactSchema,
  researchBriefExecutionPlanSchema,
  researchSuspensionSchema,
  verificationVerdictSchema,
  verificationChecklistSchema,
  compileReportSchema,
  type ResearchBrief,
  type VerificationVerdict,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4（design §1.4/§1.5/§2.1）：调查简报 / 核实判定 / 热层编译报告三 schema。
// 纯 Zod schema -> plain vitest。覆盖结构红线：
// - 出处锚定强制（key_facts[].source 非空串 / 纯空白拒绝）
// - 执行案零大纲正文字段（硬塞的 outline 字段 parse 处剥除——复制无处可放，双真相源红线）
// - 许可 = checklist 四判定全过（pass↔checklist 一致性 refine + gaps 清空一致性）
// - compileReport degraded 二态（缺失=未降级 / ≥1=有降级 / [] 第三态拒收）
// - 三 schema 正反例 round-trip
// ─────────────────────────────────────────────────────────────────────────────

/** 合法完整调查简报 fixture（正例基线）。 */
function validBrief(): ResearchBrief {
  return {
    entries: [
      {
        ref: 'char_main',
        kind: 'asset',
        key_facts: [
          { fact: '林昭的核心创伤是兄长失踪', source: 'asset_cards:char_main.wound' },
          { fact: '左颊有旧疤', source: '第 3 章' },
        ],
      },
      {
        ref: 'ch_12',
        kind: 'chapter',
        key_facts: [{ fact: '当铺掌柜已识破赝品', source: '第 12 章末段' }],
      },
      {
        ref: 'sc_41',
        kind: 'scene',
        key_facts: [{ fact: '本场 storyTime=118，雨夜', source: 'scene_graph:sc_41' }],
      },
      {
        ref: 'promise_sword',
        kind: 'promise',
        key_facts: [{ fact: '墙上古剑未兑现，deadline 迫近', source: 'promise_registry:promise_sword' }],
      },
      {
        ref: 'arc_summary_main',
        kind: 'summary',
        key_facts: [{ fact: '主角弧处于停滞期', source: '弧摘要:arc_main' }],
      },
    ],
    issues: [
      { desc: '任务卡点名「当铺密谈」但 scene_graph 无此场', severity: 'warn' },
    ],
    execution_plan: [
      { scene_ref: 'sc_41', beat_coverage: 'promise_sword advance（假剑出手）', notes: '短句推进，掌柜视角压轴' },
      { scene_ref: 'sc_42', beat_coverage: '无节拍（过场）' },
    ],
    deviations: [
      { scene_ref: 'sc_41', plan_says: '当场识破', brief_says: '延迟两场再揭穿', reason: '识破太早泄信息差张力' },
    ],
    plan: '本章以假剑流转推进伏笔，掌柜的沉默制造信息差压强。',
  };
}

describe('researchBriefSchema（正例 round-trip）', () => {
  it('五段全填合法：parse round-trip 等价', () => {
    const brief = validBrief();
    expect(researchBriefSchema.parse(brief)).toEqual(brief);
  });

  it('entries 五种 kind 全合法（asset/chapter/scene/promise/summary）', () => {
    const brief = validBrief();
    const kinds = brief.entries.map((e) => e.kind);
    expect(kinds).toEqual(['asset', 'chapter', 'scene', 'promise', 'summary']);
    expect(researchBriefSchema.parse(brief).entries).toHaveLength(5);
  });

  it('issues / deviations / execution_plan 空 [] 合法（查无可记 / 无偏离 / 无规划的结构态）', () => {
    const r = researchBriefSchema.parse({
      entries: [{ ref: 'x', kind: 'asset', key_facts: [{ fact: 'f', source: '卡 x' }] }],
      issues: [],
      execution_plan: [],
      deviations: [],
      plan: 'p',
    });
    expect(r.issues).toEqual([]);
    expect(r.execution_plan).toEqual([]);
    expect(r.deviations).toEqual([]);
  });

  it('parse round-trip 确定性：parse 输出再 parse 等价', () => {
    const once = researchBriefSchema.parse(validBrief());
    expect(researchBriefSchema.parse(once)).toEqual(once);
  });
});

describe('researchBriefSchema（出处锚定强制——红线 ①）', () => {
  it('key_facts[].source 空串 → reject', () => {
    expect(() =>
      researchBriefSchema.parse({
        ...validBrief(),
        entries: [{ ref: 'x', kind: 'asset', key_facts: [{ fact: 'f', source: '' }] }],
      }),
    ).toThrow();
  });

  it('key_facts[].source 纯空白 → reject（trim 后 ≥1 字符）', () => {
    expect(() =>
      researchBriefKeyFactSchema.parse({ fact: 'f', source: '   ' }),
    ).toThrow();
  });

  it('key_facts[].source 缺失 → reject（强制字段）', () => {
    expect(() => researchBriefKeyFactSchema.parse({ fact: 'f' })).toThrow();
  });

  it('key_facts[].fact 空串 → reject', () => {
    expect(() => researchBriefKeyFactSchema.parse({ fact: '', source: '第 1 章' })).toThrow();
  });

  it('key_facts 空数组 → reject（entry 存在即须携带事实——零事实条目是噪音）', () => {
    expect(() => researchBriefEntrySchema.parse({ ref: 'x', kind: 'asset', key_facts: [] })).toThrow();
  });

  it('source 前后空白被 trim 归一（出处锚定可复核）', () => {
    const r = researchBriefKeyFactSchema.parse({ fact: 'f', source: '  第 3 章  ' });
    expect(r.source).toBe('第 3 章');
  });
});

describe('researchBriefSchema（执行案零大纲正文——红线 ②）', () => {
  it('execution_plan 条目只有 scene_ref/beat_coverage/notes 三字段', () => {
    const r = researchBriefExecutionPlanSchema.parse({
      scene_ref: 'sc_41',
      beat_coverage: 'promise advance',
      notes: '短句',
    });
    expect(Object.keys(r).sort()).toEqual(['beat_coverage', 'notes', 'scene_ref']);
  });

  it('硬塞的「大纲正文」字段 parse 处剥除——复制无处可放（双真相源红线）', () => {
    const r = researchBriefExecutionPlanSchema.parse({
      scene_ref: 'sc_41',
      beat_coverage: 'beat',
      // LLM 违规尝试内嵌大纲正文（任何形态的字段名）——zod strip 未声明字段，物理不可能落进章档案：
      outline_text: '雨夜，掌柜展开假剑，烛火摇曳。他忽然笑了——「这剑，三年前就该来了。」……',
      outlineProse: '第三章 大纲正文……',
      大纲正文: '掌柜与少年对峙的完整大纲段落……',
    });
    expect(Object.keys(r).sort()).toEqual(['beat_coverage', 'scene_ref']);
    expect(JSON.stringify(r)).not.toContain('雨夜');
    expect(JSON.stringify(r)).not.toContain('大纲');
  });

  it('顶层硬塞 outline 字段同样剥除（简报整体无大纲正文字段位）', () => {
    const r = researchBriefSchema.parse({
      ...validBrief(),
      outline_snapshot: '第三章完整大纲正文……',
    } as never);
    expect(JSON.stringify(r)).not.toContain('outline_snapshot');
    expect(r.plan).toBeDefined();
  });

  it('scene_ref 空串 → reject（引用场 id 强制——对拍大纲的 join 键）', () => {
    expect(() => researchBriefExecutionPlanSchema.parse({ scene_ref: '', beat_coverage: 'b' })).toThrow();
  });

  it('scene_ref 缺失 → reject；notes optional', () => {
    expect(() => researchBriefExecutionPlanSchema.parse({ beat_coverage: 'b' })).toThrow();
    const r = researchBriefExecutionPlanSchema.parse({ scene_ref: 'sc_1', beat_coverage: 'b' });
    expect(r.notes).toBeUndefined();
  });
});

describe('researchBriefSchema（必填字段反例）', () => {
  it('缺 entries / issues / execution_plan / deviations / plan 任一 → reject（五段全必填）', () => {
    const brief = validBrief();
    for (const key of ['entries', 'issues', 'execution_plan', 'deviations', 'plan'] as const) {
      const { [key]: _omit, ...rest } = brief;
      expect(() => researchBriefSchema.parse(rest)).toThrow();
    }
  });

  it('issues severity 非法值 → reject（info|warn|contradiction 封闭 enum）', () => {
    expect(() =>
      researchBriefSchema.parse({ ...validBrief(), issues: [{ desc: 'd', severity: 'fatal' }] }),
    ).toThrow();
  });

  it('entries kind 非法值 → reject', () => {
    expect(() =>
      researchBriefSchema.parse({
        ...validBrief(),
        entries: [{ ref: 'x', kind: 'lore', key_facts: [{ fact: 'f', source: 's' }] }],
      }),
    ).toThrow();
  });

  it('deviations 四字段必填（缺 plan_says → reject）', () => {
    expect(() =>
      researchBriefSchema.parse({
        ...validBrief(),
        deviations: [{ scene_ref: 'sc_1', brief_says: 'b', reason: 'r' }],
      }),
    ).toThrow();
  });

  it('plan 空串 → reject（本章写作要点总述强制非空）', () => {
    expect(() => researchBriefSchema.parse({ ...validBrief(), plan: '' })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verificationVerdictSchema（design §1.5 资料员核实判定）
// ─────────────────────────────────────────────────────────────────────────────

/** 四判定全过 fixture（pass=true 基线）。 */
function allPassChecklist() {
  return { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true };
}

/** 合法完整 verdict fixture。 */
function validVerdict(): VerificationVerdict {
  return {
    checklist: { entities_checked: false, sources_grounded: true, gaps_cleared: false, contradictions_zero: true },
    pass: false,
    gaps: [
      { desc: '任务卡点名「当铺密谈」但简报无该场核查记录', source_hint: 'scene_graph 本章 episode 场清单 + query_story「当铺」' },
    ],
    suggestions: [
      { text: '让 15 章未出场的少女 C 背景露一面', basis: '出场间隔统计：少女 C 距上次出场 15 章' },
    ],
    archive_issues: [{ card_ref: 'asset_cards:pawn_shop', problem: '当铺设定卡仍写「原掌柜在任」，正文已换人' }],
    escalate: false,
  };
}

describe('verificationVerdictSchema（正例 round-trip）', () => {
  it('全字段填合法：parse round-trip 等价（含缺漏+建议+档案议题）', () => {
    const v = validVerdict();
    expect(verificationVerdictSchema.parse(v)).toEqual(v);
  });

  it('四判定全过 + pass=true + 三清单空 [] 合法（一轮过发许可）', () => {
    const r = verificationVerdictSchema.parse({
      checklist: allPassChecklist(),
      pass: true,
      gaps: [],
      suggestions: [],
      archive_issues: [],
    });
    expect(r.pass).toBe(true);
    expect(r.escalate).toBeUndefined();
  });

  it('escalate=true 与 pass=true 并存合法（正交——核查全过仍需用户决断偏离）', () => {
    const r = verificationVerdictSchema.parse({
      checklist: allPassChecklist(),
      pass: true,
      gaps: [],
      suggestions: [],
      archive_issues: [],
      escalate: true,
    });
    expect(r.pass).toBe(true);
    expect(r.escalate).toBe(true);
  });
});

describe('verificationVerdictSchema（许可=清单全过 refine 钉死——非主观满足感）', () => {
  it('checklist 全 true 但 pass=false → reject（主观压下全过核查——资料员越权守门）', () => {
    expect(() =>
      verificationVerdictSchema.parse({
        checklist: allPassChecklist(),
        pass: false,
        gaps: [],
        suggestions: [],
        archive_issues: [],
      }),
    ).toThrow(/pass 与 checklist/);
  });

  it('checklist 任一 false 但 pass=true → reject（越权放水）', () => {
    expect(() =>
      verificationVerdictSchema.parse({
        checklist: { entities_checked: false, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
        pass: true,
        gaps: [],
        suggestions: [],
        archive_issues: [],
      }),
    ).toThrow(/pass 与 checklist/);
  });

  it('pass=true 但 gaps 非空 → reject（gaps_cleared 与 gaps 内容矛盾）', () => {
    expect(() =>
      verificationVerdictSchema.parse({
        checklist: allPassChecklist(),
        pass: true,
        gaps: [{ desc: '缺', source_hint: 'hint' }],
        suggestions: [],
        archive_issues: [],
      }),
    ).toThrow(/gaps/);
  });

  // ── CR-004（2026-08-19）：反向红线——pass=false ⇒ gaps 非空（补双向钉死）──

  it('pass=false + gaps=[] → reject（未过许可必须给出缺什么——空清单让补查回合无从下手）', () => {
    expect(() =>
      verificationVerdictSchema.parse({
        checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: false, contradictions_zero: true },
        pass: false,
        gaps: [],
        suggestions: [],
        archive_issues: [],
      }),
    ).toThrow(/pass=false 但缺漏清单为空/);
  });

  it('pass=false + gaps=[] 且 escalate=true（矛盾升级形态）→ 同 reject（escalate 不豁免反向红线）', () => {
    expect(() =>
      verificationVerdictSchema.parse({
        checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: false },
        pass: false,
        gaps: [],
        suggestions: [],
        archive_issues: [],
        escalate: true,
      }),
    ).toThrow(/pass=false 但缺漏清单为空/);
  });

  it('pass=false + gaps 非空（checklist 一致）→ 合法（补查回合的正路形态）', () => {
    const r = verificationVerdictSchema.parse({
      checklist: { entities_checked: false, sources_grounded: true, gaps_cleared: false, contradictions_zero: true },
      pass: false,
      gaps: [{ desc: '未核查配角王五的行踪', source_hint: 'query_story 搜「王五」' }],
      suggestions: [],
      archive_issues: [],
    });
    expect(r.pass).toBe(false);
    expect(r.gaps).toHaveLength(1);
  });
});

describe('verificationVerdictSchema（字段级验证）', () => {
  it('checklist 四布尔缺一 → reject', () => {
    expect(() =>
      verificationChecklistSchema.parse({ entities_checked: true, sources_grounded: true, gaps_cleared: true }),
    ).toThrow();
  });

  it('gaps 缺 desc / 缺 source_hint → reject（缺漏只给「缺什么+出处线索」，两件都强制）', () => {
    expect(() => verificationVerdictSchema.parse({ ...validVerdict(), gaps: [{ desc: 'd' }] })).toThrow();
    expect(() =>
      verificationVerdictSchema.parse({ ...validVerdict(), gaps: [{ source_hint: 'h' }] }),
    ).toThrow();
  });

  it('gaps source_hint 空串 → reject', () => {
    expect(() =>
      verificationVerdictSchema.parse({ ...validVerdict(), gaps: [{ desc: 'd', source_hint: '' }] }),
    ).toThrow();
  });

  it('suggestions 缺 basis → reject（建议必带机械弹药依据——不进 pass 但结构强制）', () => {
    expect(() =>
      verificationVerdictSchema.parse({ ...validVerdict(), suggestions: [{ text: '让少女 C 露面' }] }),
    ).toThrow();
  });

  it('archive_issues 缺 card_ref / problem → reject', () => {
    expect(() =>
      verificationVerdictSchema.parse({ ...validVerdict(), archive_issues: [{ problem: 'p' }] }),
    ).toThrow();
    expect(() =>
      verificationVerdictSchema.parse({ ...validVerdict(), archive_issues: [{ card_ref: 'c' }] }),
    ).toThrow();
  });

  it('escalate optional：缺失合法（默认无升级）', () => {
    const r = verificationVerdictSchema.parse({
      checklist: { entities_checked: false, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
      pass: false,
      gaps: [{ desc: 'd', source_hint: 'h' }],
      suggestions: [],
      archive_issues: [],
    });
    expect(r.escalate).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compileReportSchema（design §2.1 热层编译报告——纯代码产物）
// ─────────────────────────────────────────────────────────────────────────────

describe('compileReportSchema（正例 round-trip）', () => {
  it('segments+total+overloaded 合法（L0 正常态无 degraded）', () => {
    const r = compileReportSchema.parse({
      segments: [
        { name: '任务卡#1 目标', token_estimate: 120 },
        { name: '任务卡#6 剧情点', token_estimate: 340 },
        { name: '设定前缀', token_estimate: 5200 },
      ],
      total: 5660,
      overloaded: false,
    });
    expect(r.total).toBe(5660);
    expect(r.degraded).toBeUndefined();
    expect(r.overloaded).toBe(false);
  });

  it('携带 degraded（L1/L2 降级动作记录）round-trip', () => {
    const report = {
      segments: [
        { name: '任务卡#1 目标', token_estimate: 120 },
        { name: '状态快照', token_estimate: 800 },
      ],
      total: 920,
      degraded: [{ segment: '状态快照', action: 'attrs 收窄（L1 缩档）' }],
      overloaded: false,
    };
    expect(compileReportSchema.parse(report)).toEqual(report);
  });

  it('overloaded=true（L3 复杂场景标记）合法', () => {
    const r = compileReportSchema.parse({
      segments: [{ name: '设定前缀', token_estimate: 999999 }],
      total: 999999,
      degraded: [{ segment: '低优段', action: '移出热层改可查指针（L2）' }],
      overloaded: true,
    });
    expect(r.overloaded).toBe(true);
  });
});

describe('compileReportSchema（结构约束）', () => {
  it('segments 空 [] → reject（报告存在即有段——空报告无意义）', () => {
    expect(() => compileReportSchema.parse({ segments: [], total: 0, overloaded: false })).toThrow();
  });

  it('degraded 空 [] → reject（二态：缺失=未降级 / ≥1=有降级，[] 第三态拒收）', () => {
    expect(() =>
      compileReportSchema.parse({ segments: [{ name: 'a', token_estimate: 1 }], total: 1, degraded: [], overloaded: false }),
    ).toThrow();
  });

  it('token_estimate 负数 / 非整数 → reject', () => {
    expect(() =>
      compileReportSchema.parse({ segments: [{ name: 'a', token_estimate: -1 }], total: 0, overloaded: false }),
    ).toThrow();
    expect(() =>
      compileReportSchema.parse({ segments: [{ name: 'a', token_estimate: 1.5 }], total: 1, overloaded: false }),
    ).toThrow();
  });

  it('total 负数 → reject；overloaded 缺失 → reject（必填）', () => {
    expect(() =>
      compileReportSchema.parse({ segments: [{ name: 'a', token_estimate: 1 }], total: -5, overloaded: false }),
    ).toThrow();
    expect(() =>
      compileReportSchema.parse({ segments: [{ name: 'a', token_estimate: 1 }], total: 1 }),
    ).toThrow();
  });

  it('degraded 条目缺 segment / action → reject', () => {
    expect(() =>
      compileReportSchema.parse({
        segments: [{ name: 'a', token_estimate: 1 }],
        total: 1,
        degraded: [{ action: 'x' }],
        overloaded: false,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4 Step 4（design §1.7 矛盾暂停）：researchSuspensionSchema 挂起载荷结构。
// ─────────────────────────────────────────────────────────────────────────────

describe('researchSuspensionSchema（Story 8.4 Step 4 挂起载荷）', () => {
  it('verify_exhausted 形态：kind + rounds + gaps（缺漏清单）parse 通过', () => {
    const parsed = researchSuspensionSchema.parse({
      kind: 'verify_exhausted',
      rounds: 3,
      gaps: [{ desc: '未核查王五', source_hint: 'query_story 搜「王五」' }],
    });
    expect(parsed.kind).toBe('verify_exhausted');
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.evidence).toBeUndefined();
  });

  it('research_contradiction 形态：evidence（contradictions + deviations + 可选 verdict）parse 通过', () => {
    const parsed = researchSuspensionSchema.parse({
      kind: 'research_contradiction',
      rounds: 1,
      evidence: {
        contradictions: [{ desc: '任务卡与第 3 章矛盾', severity: 'contradiction' }],
        deviations: [{ scene_ref: 's1', plan_says: 'P', brief_says: 'B', reason: 'R' }],
      },
    });
    expect(parsed.evidence?.contradictions).toHaveLength(1);
    expect(parsed.evidence?.deviations).toHaveLength(1);
    expect(parsed.evidence?.verdict).toBeUndefined(); // 机械 belt 拦下时无 LLM verdict——合法
  });

  it('kind 封闭枚举（bogus reject）+ rounds 非法（负数/非整数 reject）+ gaps 条目缺 source_hint reject', () => {
    expect(() => researchSuspensionSchema.parse({ kind: 'bogus', rounds: 1 })).toThrow();
    expect(() => researchSuspensionSchema.parse({ kind: 'verify_exhausted', rounds: -1 })).toThrow();
    expect(() => researchSuspensionSchema.parse({ kind: 'verify_exhausted', rounds: 1.5 })).toThrow();
    expect(() =>
      researchSuspensionSchema.parse({ kind: 'verify_exhausted', rounds: 1, gaps: [{ desc: 'x' }] }),
    ).toThrow();
  });
});
