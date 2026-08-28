import type { LintChapterReport } from '@orison/shared-contracts';

// ── C1.2 R6（design §3.2）：lint_report → L2 prompt 软信号投影（纯函数，ADR-3）──
//
// multi-review Reader-Audit composite 消费链段 `lint_report` artifact 时的**聚合封顶投影**：
// 按规则聚合 + 引文去重/截断/封顶 + 规则数封顶——mirror 上游 llmlint evals
// collectRepairFindings（repair-prompt.ts DEFAULT_FINDING_LIMITS：maxRules 25 / excerptsPerRule 3 /
// excerptChars 40）的长度纪律，防长章命中爆炸把 L2 prompt 撑爆。
//
// 范式判据（ADR-3）：本投影 = 纯代码机械聚合（分组/计数/排序/截断，零语义）；「命中是否真问题、
// 怎么改」归 L2 LLM 语义裁判（静态命中 ≠ 定罪）。不产任何真阳/误报结论。
//
// expected_downstream_consumers：
// - chapter-nodes.ts createReaderAuditNode：lintReport templateVar（JSON 序列化本投影）。
// - 未来 lint:classify IPC（shell，Step 7）：同形聚合输入（单源防漂移）。

/** 聚合封顶（mirror 上游 DEFAULT_FINDING_LIMITS）。 */
export const LINT_L2_FINDING_LIMITS = {
  /** 最多注入的规则组数（按命中数降序取前 N）。 */
  maxRules: 25,
  /** 每规则组引文样例上限（去重后）。 */
  excerptsPerRule: 3,
  /** 单条引文码点截断（超出加省略号）。 */
  excerptChars: 40,
  /** 密度指纹每条样本上限（samples 引擎侧 ≤8，投影再收窄控 prompt 长度）。 */
  densitySamples: 3,
} as const;

/** 一条聚合后的规则组（count = 原始命中处数；excerpts 去重/截断/封顶后可能少于 count）。 */
export interface LintL2Finding {
  ruleId: string;
  title: string;
  count: number;
  excerpts: string[];
}

/** 密度指纹投影（hits/perKilo 机械事实 + 收窄样本）。 */
export interface LintL2DensityIssue {
  ruleId: string;
  hits: number;
  perKilo: number;
  samples: string[];
}

/** lintReport templateVar 的投影形态（JSON 序列化注入 L2 prompt）。 */
export interface LintL2Projection {
  findings: LintL2Finding[];
  densityIssues: LintL2DensityIssue[];
  /**
   * 投影被截断时 true（告知 L2/classify 有截断，防低估总量——mirror 3.3 top-N 教训）：
   * 规则组数超 maxRules **或** density 条目超 maxRules（CR-013：跨章合并的 densityIssues
   * 随章数无界增长——每章每规则一条，200 章稿即 200 条同规则条目，不封顶会把 classify
   * 输入与 L2 prompt 撑爆）。density 按 hits 降序取前 N（保最大信号；同数按 ruleId 稳定序）。
   */
  truncated: boolean;
}

/** 码点截断（超出加省略号；中文正文按码点截断与上游 excerptChars 同口径）。 */
function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('')}…`;
}

/** 引文压缩：压掉换行/连续空白再截断（同句只展示一次的「去重命中」展示口径，mirror 上游）。 */
function excerptOf(match: string): string {
  return truncateChars(match.trim().replace(/\s+/gu, ' '), LINT_L2_FINDING_LIMITS.excerptChars);
}

function isValidReport(raw: unknown): raw is LintChapterReport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as { issues?: unknown; densityIssues?: unknown };
  return Array.isArray(r.issues) && Array.isArray(r.densityIssues);
}

/**
 * lint_report artifact → L2 投影。artifact 缺/坏形态 → null（caller `?? ''` 降级空段，
 * mirror world_state_snapshot graceful 哲学——lint_report 不在 Reader-Audit
 * requiredArtifactKeys，老链/旧 snapshot/bypass 路径无此 key 是合法状态）。
 *
 * 聚合语义（mirror 上游 collectRepairFindings）：
 * - 只取 review==='agent' 命中（human/none 桶是作者偏好/机械诊断，不驱动 L2 改写判断）——
 *   链段 lint-node 已产 agent 桶，此处过滤是防御（artifact 换全量桶来源时口径不漂）。
 * - 按规则聚合，命中数降序（同数按 ruleId 稳定序）；引文去重 + 截断 + 每规则封顶；规则数封顶。
 * - densityIssues 逐条投影（样本收窄 ≤3 条 ×40 码点）+ 条目数封顶 maxRules（CR-013，
 *   hits 降序——跨章合并输入随章数无界增长，防 classify 输入/L2 prompt 膨胀）。
 */
export function projectLintReportForL2(raw: unknown): LintL2Projection | null {
  if (!isValidReport(raw)) return null;
  const report = raw as LintChapterReport & {
    issues: Array<{ ruleId: string; title?: string; review?: string; match: string }>;
  };

  // 按规则聚合（issue 自带 ruleId/title/review——LintChapterReport 是逐条自包含形态，无 rules 字典间接层）。
  const byRule = new Map<string, LintL2Finding & { seen: Set<string> }>();
  for (const issue of report.issues) {
    if (issue.review !== 'agent') continue;
    if (typeof issue.ruleId !== 'string' || issue.ruleId.length === 0) continue;
    let bucket = byRule.get(issue.ruleId);
    if (!bucket) {
      bucket = {
        ruleId: issue.ruleId,
        title: typeof issue.title === 'string' ? issue.title : issue.ruleId,
        count: 0,
        excerpts: [],
        seen: new Set<string>(),
      };
      byRule.set(issue.ruleId, bucket);
    }
    bucket.count += 1;
    if (typeof issue.match === 'string') {
      const excerpt = excerptOf(issue.match);
      if (
        excerpt.length > 0 &&
        !bucket.seen.has(excerpt) &&
        bucket.excerpts.length < LINT_L2_FINDING_LIMITS.excerptsPerRule
      ) {
        bucket.seen.add(excerpt);
        bucket.excerpts.push(excerpt);
      }
    }
  }

  const sorted = [...byRule.values()]
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId))
    .slice(0, LINT_L2_FINDING_LIMITS.maxRules)
    .map(({ ruleId, title, count, excerpts }) => ({ ruleId, title, count, excerpts }));

  // CR-013：density 封顶（跨章合并输入随章数无界增长）——hits 降序取前 maxRules，
  // 同数按 ruleId 稳定序；截断判定用封顶**前**条数（恰好=maxRules 未丢条目，不算截断）。
  const densityAll = report.densityIssues
    .filter((d) => typeof d.ruleId === 'string' && d.ruleId.length > 0)
    .map((d) => ({
      ruleId: d.ruleId,
      hits: d.hits,
      perKilo: d.perKilo,
      samples: (Array.isArray(d.samples) ? d.samples : [])
        .filter((s): s is string => typeof s === 'string')
        .map((s) => truncateChars(s.trim().replace(/\s+/gu, ' '), LINT_L2_FINDING_LIMITS.excerptChars))
        .slice(0, LINT_L2_FINDING_LIMITS.densitySamples),
    }));
  const densityIssues = [...densityAll]
    .sort((a, b) => b.hits - a.hits || a.ruleId.localeCompare(b.ruleId))
    .slice(0, LINT_L2_FINDING_LIMITS.maxRules);

  return {
    findings: sorted,
    densityIssues,
    truncated:
      byRule.size > LINT_L2_FINDING_LIMITS.maxRules ||
      densityAll.length > LINT_L2_FINDING_LIMITS.maxRules,
  };
}
