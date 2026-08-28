import type {
  LintChapterReport,
  LintDensityIssue,
  LintFixPatch,
  LintFullReport,
  LintIssue,
  LintReview,
} from '@orison/shared-contracts';
import { projectCheckIssues } from './vendor/llmlint/src/check-report';
import { applyAutoFixWithChanges } from './vendor/llmlint/src/fix';
import { computeMaskedRanges } from './vendor/llmlint/src/markdown-mask';
import {
  countableVisibleChars,
  prepareScanContext,
} from './vendor/llmlint/src/scan-context';
import {
  buildLineStarts,
  locatePosition,
  scanHandlerRules,
  scanWithContext,
} from './vendor/llmlint/src/scanner';
import { scanDensity } from './vendor/llmlint/src/density';
import { loadRules } from './vendor/llmlint/src/rules';
import { LLMLINT_VERSION } from './vendor/llmlint/src/version';
import type {
  CompactIssue,
  CompactRuleEntry,
  LoadedRules,
  NormalizedLlmlintConfig,
  RegexRuleRecord,
} from './vendor/llmlint/src/types';
import { logger } from '../logger';

// ── C1.2 llmlint 静态引擎适配层（design §2）──
//
// Closure 消费面 = vendored llmlint 静态引擎（./vendor/llmlint/，upstream commit 7b0e5a0，
// AGPL-3.0-only，拷贝清单/修改清单见 vendor README）。本适配层职责：
//  1. getLintEngine 进程级单例——规则装载一次（静态数据），失败 → null（全链路降级不崩，
//     mirror Reader-Audit L1「失败降级不崩链」先例；调用点兜底空 report 归 lintNode/IPC 层）。
//  2. scanText 单章扫描——纯同步纯函数（regex → handler → density，mirror 上游 cli.ts checkFiles
//     管线，review 不过滤——「一次扫描产全量、按受众过滤投影」design §2，避免重复扫描）。
//  3. filterByReview 受众投影——链段内 L2 消费 review=agent 桶；报告面 review=all。
//  4. projectAutoFixes 机械修复投影——fixability:auto 命中 → 确定性替换补丁（dry-run 语义，
//     不落盘；应用归 lint:apply-fix IPC + 作者确认，D6「不静默改稿」）。
//
// 范式判据（ADR-3）：静态规则定位 = 不理解意义的确定性计算（纯代码合法域）；命中真假与
// 修复方向 = 语义判断，归 L2 multi-review / lint:classify LLM 通道或作者。本层永不产语义结论。
//
// span 语义（契约，packages/shared-contracts/src/contracts/lint.ts）：line/column/endLine/
// endColumn 全部 1-based、列按 Unicode 码点计（上游 scanner.ts locatePosition 原样投影）。
//
// rulesets 解析注意：vendored rules.ts 以自身模块位置定位 `../rulesets`（import.meta.url），
// dev（tsx）+ vitest 下指向源文件正确；生产打包（electron-vite bundle）下失配——与
// src/prompt/agentPrompt.ts 同款已知问题，由 shell lintIpc wiring 步骤处理（vendor README
// 「已知注意点」）。
//
// expected_downstream_consumers（interface-contracts 纪律，design §5）：
// - lint-node（链段 R6）：消费 scanText + filterByReview('agent') 产 lint_report artifact。
// - shell lintIpc（R2/R4）：消费 scanText（all 桶）聚合 LintFullReport + projectAutoFixes。
// - C1.3 诊断报告：消费 LintFullReport / 章级账。

/** 上游溯源常量（re-vendor 时随 vendor README 同步）。 */
export const LINT_UPSTREAM_REPO = 'https://github.com/notnotype/llmlint';
export const LINT_UPSTREAM_COMMIT = '7b0e5a0';

/**
 * 默认规则配置：builtin/default 全量 active 集，无覆盖（mirror 上游 cloneDefaultConfig）。
 *
 * 单源导出（CR-020）：lintEngine 内部缺省 + 两个 vendored 不变量/引擎测试共用——此前三处
 * 手写同形 literal 是漂移面（一处改另两处漏），收敛到本导出。
 */
export function defaultLintConfig(): NormalizedLlmlintConfig {
  return {
    rulesets: ['builtin/default'],
    trustedRulesets: [],
    rulesetOverrides: {},
    namespaces: {},
    rules: {},
    ignoreTerms: [],
    output: 'json',
  };
}

/** 引擎只读快照：规则集装载结果 + 上游溯源。 */
export interface LintEngine {
  /** 上游溯源（写入 LintChapterReport.upstream）。 */
  readonly upstream: LintChapterReport['upstream'];
  /** 规则库规模（数字随上游演进漂移，只作可观测，不作断言依据）。 */
  readonly registry: { totalRules: number; activeRules: number; disabledRules: number };
  /**
   * 单章扫描（纯同步纯函数；review 不过滤 = all 桶全量）。
   * 章正文按 Markdown 处理：computeMaskedRanges 遮罩 frontmatter/代码块等结构区
   * （对小说正文天然无害，design §2）。
   */
  scanText(text: string, opts: { chapterId: string; sceneId?: string }): LintChapterReport;
  /**
   * 受众桶投影（scan 一次、投影两次）：'agent' = 只留 review=agent 命中（喂 L2）；
   * 'all' = 原样。summary 随过滤重算（density 计数同上游 summarizeIssues 口径：只数 issues）。
   */
  filterByReview(report: LintChapterReport, review: 'agent' | 'all'): LintChapterReport;
  /**
   * 机械修复投影（dry-run，不落盘）：applyAutoFixWithChanges 对 fixability:auto 规则
   * （vendored 集内仅零宽字符/标点尾部清理等 2 条）跑确定性替换，变更明细 → LintFixPatch。
   * ⚠ patches 的 span 定位于**修复后文本**（applyAutoFixWithChanges 变更明细坐标语义，
   * 供确认 UI diff 标注）；应用时按确定性规则在当前正文重放，不依赖该坐标。
   */
  projectAutoFixes(args: {
    text: string;
    chapterId: string;
    filePath: string;
  }): { patches: LintFixPatch[]; fixedText: string; changed: boolean };
}

/** CompactIssue + 规则元数据 → LintIssue（自包含形态，不带上游 rules 字典间接层）。 */
function toLintIssue(
  issue: CompactIssue,
  meta: CompactRuleEntry,
  chapterId: string,
  sceneId: string | undefined,
): LintIssue {
  return {
    ruleId: issue.ruleId,
    namespace: meta.namespace,
    title: meta.title,
    level: meta.level,
    review: meta.review,
    fixability: meta.fixability,
    chapterId,
    ...(sceneId ? { sceneId } : {}),
    line: issue.line,
    column: issue.column,
    endLine: issue.endLine,
    endColumn: issue.endColumn,
    match: issue.match,
    ...(issue.detail ? { detail: issue.detail } : {}),
    context: issue.context,
    ...(meta.action.type === 'replace'
      ? { fix: { replacements: meta.action.replacements } }
      : {}),
  };
}

/** 按当前 issues 重算 summary（mirror 上游 summarizeIssues：只数 issues，density 不计入级别）。 */
function summarize(issues: LintIssue[], visibleChars: number): LintChapterReport['summary'] {
  const summary = { total: issues.length, high: 0, medium: 0, low: 0, visibleChars };
  for (const issue of issues) {
    summary[issue.level] += 1;
  }
  return summary;
}

/** 从引擎装载结果构建 LintEngine 实例（纯装配，无 IO）。 */
function createEngine(loaded: LoadedRules): LintEngine {
  const upstream = {
    repo: LINT_UPSTREAM_REPO,
    commit: LINT_UPSTREAM_COMMIT,
    ruleVersion: LLMLINT_VERSION,
  };
  // density 命中按 review 过滤需要规则元数据（CompactDensityIssue 不带 review）。
  const reviewById = new Map<string, LintReview>(loaded.rules.map((r) => [r.id, r.review]));
  const autoRules: RegexRuleRecord[] = loaded.regexRules.filter((r) => r.fixability === 'auto');

  return {
    upstream,
    registry: {
      totalRules: loaded.summary.totalRules,
      activeRules: loaded.summary.activeRules,
      disabledRules: loaded.summary.disabledRules,
    },
    scanText(text, opts) {
      const ctx = prepareScanContext(text, { maskedRanges: computeMaskedRanges(text) });
      const issues = [
        ...scanWithContext(ctx, loaded.regexRules),
        ...scanHandlerRules(ctx, loaded.handlerRules),
      ];
      const densityIssues = scanDensity(ctx, loaded.densityRules);
      const compact = projectCheckIssues(issues, densityIssues);
      const projected = compact.issues.map((issue) =>
        toLintIssue(issue, compact.rules[issue.ruleId]!, opts.chapterId, opts.sceneId),
      );

      return {
        chapterId: opts.chapterId,
        issues: projected,
        densityIssues: (compact.densityIssues ?? []).map(
          (issue): LintDensityIssue => ({
            ruleId: issue.ruleId,
            chapterId: opts.chapterId,
            line: issue.line,
            column: issue.column,
            hits: issue.hits,
            perKilo: issue.perKilo,
            samples: issue.samples,
          }),
        ),
        summary: summarize(projected, countableVisibleChars(ctx, ctx.layers.all)),
        upstream,
      };
    },
    filterByReview(report, review) {
      if (review === 'all') {
        return report;
      }
      const issues = report.issues.filter((issue) => issue.review === 'agent');
      const densityIssues = report.densityIssues.filter(
        (issue) => reviewById.get(issue.ruleId) === 'agent',
      );
      return { ...report, issues, densityIssues, summary: summarize(issues, report.summary.visibleChars) };
    },
    projectAutoFixes({ text, chapterId, filePath }) {
      const maskedRanges = computeMaskedRanges(text);
      const result = applyAutoFixWithChanges(text, autoRules, maskedRanges);
      const lineStarts = buildLineStarts(result.fixed);
      const patches = result.changes.map((change) => {
        const start = locatePosition(result.fixed, lineStarts, change.from);
        const end = locatePosition(
          result.fixed,
          lineStarts,
          Math.max(change.from, change.to - 1),
        );
        const rule = autoRules.find((r) => r.id === change.ruleId);
        return {
          chapterId,
          filePath,
          ruleId: change.ruleId,
          span: { line: start.line, column: start.column, endLine: end.line, endColumn: end.column },
          replacements:
            rule?.action.type === 'replace' ? rule.action.replacements : [change.inserted],
        };
      });
      return { patches, fixedText: result.fixed, changed: result.changes.length > 0 };
    },
  };
}

/**
 * 装载规则并构建引擎。失败（ruleset 缺失/JSON 损坏等）→ 记 error 日志 + 返 null（降级不抛，
 * mirror「失败降级不崩链」；调用方 lintNode / lintIpc 各自产空 report / graceful skip）。
 * config 参数供测试注入坏配置验证降级路径；生产调用缺省。
 */
export async function loadLintEngine(
  config: NormalizedLlmlintConfig = defaultLintConfig(),
): Promise<LintEngine | null> {
  try {
    const loaded = await loadRules(config);
    return createEngine(loaded);
  } catch (err) {
    // CR-006：装载失败零日志 = 不可诊断——error 级落日志（用户侧 i18n 文案同改，见 lint.yaml）。
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        rulesets: config.rulesets,
      },
      'lintEngine: rulesets load failed → null engine (degraded; next getLintEngine call retries)',
    );
    return null;
  }
}

// ── 进程级单例 ──

let enginePromise: Promise<LintEngine | null> | null = null;

/**
 * 进程级单例入口（design §2 getLintEngine）：首次调用装载规则（静态数据只装一次），成功结果
 * 进程内缓存。**装载失败不缓存**（CR-006）——null 结果清槽，下次调用重试（失败可能是瞬态的
 * 路径/打包环境问题；进程内永久 null 会让 lint 功能无重启不可恢复）。异步签名：loadRules 走
 * node:fs/promises，同步返回无法承载（design §2 伪码签名的落地形态）。
 */
export function getLintEngine(): Promise<LintEngine | null> {
  if (!enginePromise) {
    const attempt = loadLintEngine();
    enginePromise = attempt;
    // 旁挂清理（不影响返回值）：失败清槽让下次调用重试；并发等待者共享本次 null 结果。
    void attempt.then(
      (engine) => {
        if (!engine) enginePromise = null;
      },
      () => {
        enginePromise = null; // 防御（loadLintEngine 契约上不 reject）
      },
    );
  }
  return enginePromise;
}

/** 测试专用：清空单例缓存（vitest 间隔离用；生产代码不得调用）。 */
export function resetLintEngineForTests(): void {
  enginePromise = null;
}

/** 全稿聚合（lint:scan-full / post-settle 消费形态预演）：章级 report 数组 → LintFullReport。 */
export function aggregateFullReport(chapters: LintChapterReport[]): LintFullReport {
  const stats = {
    chapters: chapters.length,
    total: 0,
    high: 0,
    medium: 0,
    low: 0,
    densityIssues: 0,
  };
  for (const chapter of chapters) {
    stats.total += chapter.summary.total;
    stats.high += chapter.summary.high;
    stats.medium += chapter.summary.medium;
    stats.low += chapter.summary.low;
    stats.densityIssues += chapter.densityIssues.length;
  }
  return { chapters, generatedAt: new Date().toISOString(), stats };
}
