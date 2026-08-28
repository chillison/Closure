import { z } from 'zod';

// ── C1.2 llmlint 集成：lint 静态扫描结果契约（design §5）──
//
// 上游 = notnotype/llmlint 静态引擎（vendored 于 apps/desktop/agent/src/lint/vendor/llmlint/，
// commit 7b0e5a0，AGPL-3.0-only）。本文件定义 Closure 侧的扫描结果 schema：上游
// CheckJsonReport（check-report.ts 紧凑投影）→ LintChapterReport 的跨包契约面。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：静态规则**定位**=
// 不理解意义的确定性计算（纯代码合法域，lintEngine 纯函数）；命中真假与修复方向=
// 语义判断（归 L2 multi-review / lint:classify LLM 通道或作者）。schema 只承载定位证据
// （rule id/severity/span/quote/建议），不承载语义结论——静态命中 ≠ 定罪。
//
// 🔑 span 语义（上游 scanner.ts 原样保留）：line/column/endLine/endColumn 全部 **1-based**，
// 列按 **Unicode 码点**计（非 UTF-16 code unit）。跨层消费（UI 编辑器跳转 / apply-fix 定位）
// 必须按此口径换算。
//
// severity 展示映射（high→BLOCK 等）留 C1.3 表现层，schema 保上游 level 原语义。
//
// expected_downstream_consumers（interface-contracts 纪律，design §5）：
// - lintChapterReport → C1.3 诊断报告 + multi-review L2（lint-node 链段 artifact `lint_report`
//   即此 schema 的 issues/densityIssues 部分，R6 软信号）。
// - lintFullReport → C1.3（全稿聚合 + 持久化 `.orison/lint/full-report.json`）。
// - lintFixPatch → lint:apply-fix IPC（作者确认后的机械修复载荷）。
// - lintClassifyResult → Lint tab 语境判断展示（C1.3 消费 verdicts）。

/** 上游 `RuleLevel` 原语义：high 命中在 CLI 语义里即 exit-1 级。 */
export const lintLevelSchema = z.enum(['high', 'medium', 'low']);
export type LintLevel = z.infer<typeof lintLevelSchema>;

/** 上游 `Review` 原语义：审查受众三桶（agent=需 LLM 读上下文判断 / human=人工或风格偏好 / none=纯机械诊断）。 */
export const lintReviewSchema = z.enum(['agent', 'human', 'none']);
export type LintReview = z.infer<typeof lintReviewSchema>;

/** 上游 `Fixability` 原语义：auto=脚本可盲改（仅零宽字符/标点尾部等 2 条）/ candidate=有候选需语境确认 / manual=无机械替换。 */
export const lintFixabilitySchema = z.enum(['auto', 'candidate', 'manual']);
export type LintFixability = z.infer<typeof lintFixabilitySchema>;

/**
 * 1-based 码点 span（上游 scanner.ts locatePosition 原样投影）。
 * endColumn 为命中末字符所在列（非排他列）。
 */
export const lintSpanSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});
export type LintSpan = z.infer<typeof lintSpanSchema>;

/**
 * 单处静态命中（regex ∪ handler）。上游 CompactIssue + 规则元数据按 id 去重展开为逐条
 * 自包含形态（Closure 消费面不带上游 rules 字典间接层）。
 */
export const lintIssueSchema = z
  .object({
    /** 上游规则 id（如 `story-deslop.not-is-comparison`）。 */
    ruleId: z.string().min(1),
    /** 上游 namespace（分类，74 个；支持中文 alias 归一后的形态）。 */
    namespace: z.string().min(1),
    /** 规则紧凑人类可读标签（≤20 码点，上游 rule-titles 不变量守门）。 */
    title: z.string().min(1),
    level: lintLevelSchema,
    review: lintReviewSchema,
    fixability: lintFixabilitySchema,
    chapterId: z.string().min(1),
    /** 场级定位（链段内 lint-node 有 scene 上下文时填；全稿扫描缺省）。 */
    sceneId: z.string().min(1).optional(),
    /** 1-based 码点 span（见 lintSpanSchema 注释）。 */
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive(),
    /** 命中原文字符串（grounding 先例：review finding quote）。 */
    match: z.string(),
    /** handler 命中的动态补充说明（如具体计数）；regex 命中无此字段。 */
    detail: z.string().optional(),
    /** 行内前后文（上游紧凑形态已按码点裁剪，被裁侧带省略号标记）。 */
    context: z.object({
      before: z.string(),
      current: z.string(),
      after: z.string(),
    }),
    /** 规则自带确定性替换模板（action.replace）；suggest 型/无模板缺省。模板不授予权限（上游不变量 I13）——应用与否只看 fixability 与作者确认。 */
    fix: z
      .object({
        replacements: z.array(z.string()).min(1),
      })
      .optional(),
  })
  .strict();
export type LintIssue = z.infer<typeof lintIssueSchema>;

/** 密度指纹命中（全文 doc / 每段 paragraph 最多一条，锚在首个命中位置）。 */
export const lintDensityIssueSchema = z
  .object({
    ruleId: z.string().min(1),
    chapterId: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    /** 总命中次数。 */
    hits: z.number().int().nonnegative(),
    /** 每千可见字命中数（分母跳过遮罩/豁免/结构行）。 */
    perKilo: z.number().nonnegative(),
    /** 去重样本（≤8 条），供 L2/作者快速识别命中形态。 */
    samples: z.array(z.string()),
  })
  .strict();
export type LintDensityIssue = z.infer<typeof lintDensityIssueSchema>;

/** 章级 lint 报告：lint-node 链段 artifact（`lint_report`）与全稿聚合的单章条目共用此形态。 */
export const lintChapterReportSchema = z
  .object({
    chapterId: z.string().min(1),
    issues: z.array(lintIssueSchema),
    densityIssues: z.array(lintDensityIssueSchema),
    summary: z.object({
      total: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
      /** 可见字数（与 density perKilo 同分母；修复篇幅护栏 ±20% 的基准）。 */
      visibleChars: z.number().int().nonnegative(),
    }),
    /** 上游溯源（re-vendor 时随 vendor README 更新）。 */
    upstream: z.object({
      repo: z.string().min(1),
      commit: z.string().min(1),
      ruleVersion: z.string().min(1),
    }),
    /**
     * 降级标记（CR-007，additive optional）：true = 引擎缺位/异常/正文缺位时的降级空 report——
     * **issues 空 ≠ 干净章**。消费侧（C1.3 统计、±20% 篇幅护栏基线）必须排除 degraded 章；
     * 缺省/undefined = 引擎真跑过的诚实结果（含零命中的干净章）。
     */
    degraded: z.boolean().optional(),
  })
  .strict();
export type LintChapterReport = z.infer<typeof lintChapterReportSchema>;

/** 全稿聚合统计（跨章机械累加，纯代码）。 */
export const lintFullStatsSchema = z
  .object({
    chapters: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    densityIssues: z.number().int().nonnegative(),
  })
  .strict();
export type LintFullStats = z.infer<typeof lintFullStatsSchema>;

/** 全稿扫描报告（lint:scan-full 产；持久化 `.orison/lint/full-report.json`，C1.3 消费）。 */
export const lintFullReportSchema = z
  .object({
    chapters: z.array(lintChapterReportSchema),
    generatedAt: z.string().min(1),
    stats: lintFullStatsSchema,
  })
  .strict();
export type LintFullReport = z.infer<typeof lintFullReportSchema>;

/**
 * 机械修复载荷（lint:apply-fix 输入的单条补丁）。dry-run 语义投影（projectAutoFixes）产、
 * 作者确认后应用（withProjectLock 写章文件，D6）；span 为扫描时点定位，应用时以
 * match/replacements 在当前正文重定位（正文可能在确认前被编辑）。
 */
export const lintFixPatchSchema = z
  .object({
    chapterId: z.string().min(1),
    filePath: z.string().min(1),
    ruleId: z.string().min(1),
    span: lintSpanSchema,
    /** 确定性替换（空串=删除；支持 $1 反向引用模板，上游 fix.ts 展开语义）。 */
    replacements: z.array(z.string()).min(1),
  })
  .strict();
export type LintFixPatch = z.infer<typeof lintFixPatchSchema>;

/**
 * LLM 语境判断结果（lint:classify 产，R3）。verdict 按规则组聚合（非逐条）——
 * classify 输入即按规则聚合封顶的 agent 桶命中（mirror 上游 collectRepairFindings）。
 * degraded=true 表示 LLM 未配置/失败，静态报告独立完整可用（graceful skip 先例）。
 */
export const lintClassifyResultSchema = z
  .object({
    verdicts: z.array(
      z.object({
        ruleId: z.string().min(1),
        /** 该规则组命中判为真阳的比例（0..1，LLM 语义判断）。 */
        truePositiveRatio: z.number().min(0).max(1),
        note: z.string(),
      }),
    ),
    degraded: z.boolean(),
    /**
     * 覆盖不足标记（CR-012，additive optional）：true = verdicts 非空但未覆盖输入清单的全部
     * 规则组（LLM 漏判部分组）。verdicts 为空的诚实空结果不带此标记（无可判 ≠ 部分覆盖）。
     */
    partial: z.boolean().optional(),
  })
  .strict();
export type LintClassifyResult = z.infer<typeof lintClassifyResultSchema>;
