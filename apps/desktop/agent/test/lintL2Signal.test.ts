import { describe, expect, it } from 'vitest';
import {
  LINT_L2_FINDING_LIMITS,
  projectLintReportForL2,
} from '../src/lint/lintL2Signal';
import type { LintChapterReport } from '@orison/shared-contracts';

// ── C1.2 Step 5：lint_report → L2 prompt 软信号投影单测（mirror 上游 collectRepairFindings 聚合语义）──
//
// 覆盖：agent 桶过滤 / 按规则聚合 + 计数 / 排序（count 降序 + ruleId 稳定序）/ 引文去重 + 截断 +
// 每规则封顶 / 规则数封顶 + truncated 标注 / density 样本收窄 / 缺位与坏形态 → null。

function makeReport(
  issues: Array<{ ruleId: string; title: string; review?: 'agent' | 'human' | 'none'; match: string }>,
  density: Array<{ ruleId: string; hits: number; perKilo: number; samples: string[] }> = [],
): LintChapterReport {
  return {
    chapterId: 'ep-1',
    issues: issues.map((i) => ({
      ruleId: i.ruleId,
      namespace: 'ns',
      title: i.title,
      level: 'medium',
      review: i.review ?? 'agent',
      fixability: 'manual',
      chapterId: 'ep-1',
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 2,
      match: i.match,
      context: { before: '', current: i.match, after: '' },
    })),
    densityIssues: density.map((d) => ({
      ruleId: d.ruleId,
      chapterId: 'ep-1',
      line: 1,
      column: 1,
      hits: d.hits,
      perKilo: d.perKilo,
      samples: d.samples,
    })),
    summary: { total: issues.length, high: 0, medium: issues.length, low: 0, visibleChars: 100 },
    upstream: { repo: 'r', commit: 'c', ruleVersion: '3.0.0' },
  };
}

describe('projectLintReportForL2 聚合', () => {
  it('按规则聚合 + 计数 + count 降序（同数 ruleId 稳定序）', () => {
    const projection = projectLintReportForL2(
      makeReport([
        { ruleId: 'rule.b', title: 'B', match: '命中一' },
        { ruleId: 'rule.a', title: 'A', match: '命中二' },
        { ruleId: 'rule.b', title: 'B', match: '命中三' },
        { ruleId: 'rule.b', title: 'B', match: '命中四' },
      ]),
    )!;

    expect(projection).not.toBeNull();
    // rule.b 3 次 > rule.a 1 次 → 降序在前；count = 原始命中处数。
    expect(projection.findings.map((f) => f.ruleId)).toEqual(['rule.b', 'rule.a']);
    expect(projection.findings[0]!.count).toBe(3);
    expect(projection.findings[0]!.title).toBe('B');
    expect(projection.findings[0]!.excerpts).toEqual(['命中一', '命中三', '命中四']);
    expect(projection.truncated).toBe(false);
  });

  it('human/none 桶命中不进投影（agent 桶过滤——防御全量桶来源口径不漂）', () => {
    const projection = projectLintReportForL2(
      makeReport([
        { ruleId: 'rule.agent', title: 'A', review: 'agent', match: '命中一' },
        { ruleId: 'rule.human', title: 'H', review: 'human', match: '命中二' },
        { ruleId: 'rule.none', title: 'N', review: 'none', match: '命中三' },
      ]),
    )!;

    expect(projection.findings.map((f) => f.ruleId)).toEqual(['rule.agent']);
  });

  it('引文去重（同句只展示一次）+ 码点截断（40 码点 + 省略号）', () => {
    const long = '很长的句子'.repeat(20); // 100 码点 > excerptChars
    const projection = projectLintReportForL2(
      makeReport([
        { ruleId: 'r', title: 'T', match: '同一句命中' },
        { ruleId: 'r', title: 'T', match: '同一句命中' }, // 重复引文 → 去重
        { ruleId: 'r', title: 'T', match: long },
      ]),
    )!;

    const excerpts = projection.findings[0]!.excerpts;
    expect(excerpts).toEqual(['同一句命中', `${Array.from(long).slice(0, 40).join('')}…`]);
    expect(Array.from(excerpts[1]!).length).toBe(LINT_L2_FINDING_LIMITS.excerptChars + 1); // 40 + 省略号
  });

  it('每规则引文封顶（第 4 条起不收）', () => {
    const projection = projectLintReportForL2(
      makeReport([
        { ruleId: 'r', title: 'T', match: '一' },
        { ruleId: 'r', title: 'T', match: '二' },
        { ruleId: 'r', title: 'T', match: '三' },
        { ruleId: 'r', title: 'T', match: '四' }, // 超 excerptsPerRule=3 → 不收（count 仍计 4）
        { ruleId: 'r', title: 'T', match: '五' },
      ]),
    )!;

    expect(projection.findings[0]!.count).toBe(5);
    expect(projection.findings[0]!.excerpts).toEqual(['一', '二', '三']);
  });

  it('规则组数封顶 25 + truncated=true（防 LLM 低估总数——mirror 3.3 top-N 教训）', () => {
    const issues = Array.from({ length: LINT_L2_FINDING_LIMITS.maxRules + 2 }, (_, i) => ({
      ruleId: `rule.${String(i).padStart(2, '0')}`,
      title: `T${i}`,
      match: `命中${i}`,
    }));
    const projection = projectLintReportForL2(makeReport(issues))!;

    expect(projection.findings).toHaveLength(LINT_L2_FINDING_LIMITS.maxRules);
    expect(projection.truncated).toBe(true);
    // 全部同 count=1 → ruleId 稳定升序取前 25（rule.00..rule.24），后 2 条截掉。
    expect(projection.findings[0]!.ruleId).toBe('rule.00');
    expect(projection.findings[24]!.ruleId).toBe('rule.24');
    expect(projection.findings.some((f) => f.ruleId === 'rule.25')).toBe(false);
  });

  it('density 投影：样本收窄 ≤3 + 截断 40 码点', () => {
    const long = '样'.repeat(60);
    const projection = projectLintReportForL2(
      makeReport([], [
        { ruleId: 'density.r', hits: 9, perKilo: 8.5, samples: ['样本一', long, '样本二', '样本三', '样本四'] },
      ]),
    )!;

    expect(projection.densityIssues).toHaveLength(1);
    const d = projection.densityIssues[0]!;
    expect(d.ruleId).toBe('density.r');
    expect(d.hits).toBe(9);
    expect(d.perKilo).toBe(8.5);
    // slice(0,3)：第 4/5 条样本丢弃；第 2 条超长样本截断为 40 码点 + 省略号。
    expect(d.samples).toHaveLength(LINT_L2_FINDING_LIMITS.densitySamples);
    expect(d.samples[0]).toBe('样本一');
    expect(d.samples[1]).toBe(`${Array.from(long).slice(0, 40).join('')}…`);
    expect(d.samples[2]).toBe('样本二');
    expect(d.samples.some((s) => s === '样本三')).toBe(false);
  });

  it('density 条目封顶 maxRules（CR-013——跨章合并输入随章数无界增长）：hits 降序取前 N + truncated', () => {
    // 27 条 density（> maxRules=25）——mirror 全稿 classify 的跨章 flatMap 形态（每章每规则一条）。
    const density = Array.from({ length: LINT_L2_FINDING_LIMITS.maxRules + 2 }, (_, i) => ({
      ruleId: `density.${String(i).padStart(2, '0')}`,
      hits: i, // 升序 hits → 截断后保留 hits 最大的后 25 条（升序编号 02..26）
      perKilo: 1,
      samples: ['样本'],
    }));
    const projection = projectLintReportForL2(makeReport([], density))!;

    expect(projection.densityIssues).toHaveLength(LINT_L2_FINDING_LIMITS.maxRules);
    expect(projection.truncated).toBe(true); // density 截断也置 truncated（告知消费方有未注入条目）
    expect(projection.densityIssues[0]!.ruleId).toBe('density.26'); // hits 最大者在前
    expect(projection.densityIssues.some((d) => d.ruleId === 'density.00')).toBe(false); // hits 最小被截
    expect(projection.densityIssues.some((d) => d.ruleId === 'density.01')).toBe(false);
  });

  it('density 恰在 maxRules 内：不 truncated（边界——恰好不封顶不算截断）', () => {
    const density = Array.from({ length: LINT_L2_FINDING_LIMITS.maxRules }, (_, i) => ({
      ruleId: `density.${String(i).padStart(2, '0')}`,
      hits: 1,
      perKilo: 1,
      samples: [],
    }));
    const projection = projectLintReportForL2(makeReport([], density))!;
    expect(projection.densityIssues).toHaveLength(LINT_L2_FINDING_LIMITS.maxRules);
    expect(projection.truncated).toBe(false);
  });
});

describe('projectLintReportForL2 降级', () => {
  it('undefined / 非对象 / 坏形态（issues 非数组）→ null（caller ?? \'\' 空段）', () => {
    expect(projectLintReportForL2(undefined)).toBeNull();
    expect(projectLintReportForL2('lint report')).toBeNull();
    expect(projectLintReportForL2({ issues: 'not-array', densityIssues: [] })).toBeNull();
    expect(projectLintReportForL2({ issues: [] })).toBeNull(); // densityIssues 缺 → 坏形态
  });

  it('空 report（lint-node 降级产物）→ findings/density 空 + truncated=false（L2 跳过 lint 段）', () => {
    const projection = projectLintReportForL2(makeReport([]))!;
    expect(projection.findings).toEqual([]);
    expect(projection.densityIssues).toEqual([]);
    expect(projection.truncated).toBe(false);
  });
});
