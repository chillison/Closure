// ── 风格卡片 MVP（task 08-28-style-card-mvp A 路）：机械统计块（stylometry）契约 ──
//
// 作者提交心仪文风片段 → 本模块纯代码算一份机械统计（句长/段落/对话行/标点密度/高频二字组合），
// 渲染成 markdown 统计块喂给 style-analyzer-agent（作九遍扫描的节奏佐证），并由
// dispatch_style_analyzer 机械注入风格卡第②节。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：本文件全是确定性计数 /
// 切分 / 聚合——「不理解意义」。统计数字的含义解读（句长节奏说明什么、意象密度高不高）归
// style-analyzer-agent（LLM）。与 stylometry.ts（Reader-Audit L1）同族但独立成文件：本块
// 服务「学一个声音」（正面画像），L1 服务「抓 AI 味」（负面信号），度量面不同不共享实现。
//
// 精度取舍（MVP，design.md 取舍记录）：
// - 分句按中文标点 。，！？；…… 切（含 ASCII !?,; 与换行）——切的是「分句」（clause）非整句，
//   句长统计即分句长（中文文风分析的短句/长句口径）。
// - 段落按「每个非空行一段」（网文分段惯例——单换行即分段），非空行分隔式。
// - 高频实词用中文 2-gram 简易聚合 + 内置小停用字表过滤，**不引分词依赖**——2-gram 会产出
//   跨词边界的碎片组合（如「少年们」产 少年+年们），top10 只作辅助信号，精度取舍注明。
//
// expected_downstream_consumers:
// - agent `dispatch_style_analyzer`（tool/dispatch-style-analyzer.ts）：computeStyleStats +
//   renderStyleStatsBlock 先算喂入 style-analyzer-agent，再机械注入卡第②节。
// - prompts/style-analyzer-agent.yaml {{styleStats}} var（分析佐证）。
// - V2 TSD 统计指纹（epics.md defer 表 FR-191~203）：本块是其升级插槽。

import { z } from 'zod';

// ── 切分/判定规则（集中在此，测试与渲染标签共用同一定义）──

/**
 * 分句切分（clause split）：中文句读标点 。，！？；…… + ASCII !?,; + 换行。
 * 不含 ASCII '.'（小数点/缩写误切）；不含顿号、（比逗号更小的并列停顿，文风上不构成分句）。
 */
const CLAUSE_SPLIT_RE = /[。！？；，…!?,;\n]+/;

/** 整句终止符（单句成段判定用）：句号/叹号/问号/省略号/换行——逗号不算句终。 */
const TERMINAL_SPLIT_RE = /[。！？…!?\n]+/;

/** 对话行判定：行首（忽略前导空白）为引号类字符（「『"'“‘）。 */
const DIALOGUE_LINE_START_RE = /^[「『"'“‘]/;

/** 省略号计数：… 连续串或 ASCII ... 连续串，各算一个省略号。 */
const ELLIPSIS_RUN_RE = /(…+|\.{3,})/g;

/** 破折号计数：—（U+2014）连续串算一个破折号（—— 是一个破折号的规范形态）。 */
const DASH_RUN_RE = /—+/g;

/**
 * 停用字表（函数内嵌，不引分词依赖——MVP 精度取舍）：高频虚字/代词/语气字。
 * 二字组合任一字命中表内即不入高频候选（粗过滤——会漏掉含虚字的真词，取舍注明）。
 */
const STOP_CHARS = new Set(
  '的了是在我你他她它们和与就都而或着之于不没也还又把从对向以为这那很再只等被让给跟比个什么呢吧啊吗呀哦嗯地得要会能来去说做看听想'.split(
    '',
  ),
);

/** 标点/空白字符集（prose 字符计数与 2-gram 提取时排除）。 */
const NON_PROSE_CHARS = new Set(
  ' \t\r\n　。．！？；，、：…—―–·!?,;:\'`^~"“”‘’「」『』《》〈〉【】〔〕()（）[]｛｝{}|\\/*_+-=<>#@$%&'.split(
    '',
  ),
);

/** 分句长分桶（字 = prose 字符，不含标点）。 */
const CLAUSE_BUCKETS: ReadonlyArray<{ label: string; max: number }> = [
  { label: '短句（≤10字）', max: 10 },
  { label: '中句（11-20字）', max: 20 },
  { label: '长句（21-35字）', max: 35 },
  { label: '超长句（≥36字）', max: Number.POSITIVE_INFINITY },
];

/** 段长分桶（字 = 非空白字符，含标点——网文「字数」口径）。 */
const PARAGRAPH_BUCKETS: ReadonlyArray<{ label: string; max: number }> = [
  { label: '短段（≤50字）', max: 50 },
  { label: '中段（51-150字）', max: 150 },
  { label: '长段（151-300字）', max: 300 },
  { label: '超长段（≥301字）', max: Number.POSITIVE_INFINITY },
];

// ── 契约 schema ──

/** 直方图桶：标签 + 计数 + 占比（0-1，round 4）。 */
export const styleStatsBucketSchema = z.object({
  label: z.string().min(1),
  count: z.number().int().nonnegative(),
  ratio: z.number().nonnegative(),
});
export type StyleStatsBucket = z.infer<typeof styleStatsBucketSchema>;

/** 高频二字组合条目（近似实词——2-gram 简易聚合，精度取舍见文件头）。 */
export const styleStatsBigramSchema = z.object({
  text: z.string().min(2),
  count: z.number().int().positive(),
});
export type StyleStatsBigram = z.infer<typeof styleStatsBigramSchema>;

/**
 * 机械统计块（StyleStats）——风格卡第②节的数据形态。
 * 全指标对空/超短输入零安全（零计数/零占比/空数组，无 NaN——防御是契约一部分）。
 */
export const styleStatsSchema = z.object({
  /** 非空白字符总数（含标点——「字数」口语口径）。 */
  totalChars: z.number().int().nonnegative(),
  /** 分句（按 。，！？；……切）。 */
  clause: z.object({
    count: z.number().int().nonnegative(),
    /** 中位分句长（偶数个取中间均值，round 1）。 */
    medianLength: z.number().nonnegative(),
    meanLength: z.number().nonnegative(),
    minLength: z.number().nonnegative(),
    maxLength: z.number().nonnegative(),
    histogram: z.array(styleStatsBucketSchema),
  }),
  /** 段落（每非空行一段）。 */
  paragraph: z.object({
    count: z.number().int().nonnegative(),
    /** 平均段长（非空白字符，round 1）。 */
    meanLength: z.number().nonnegative(),
    histogram: z.array(styleStatsBucketSchema),
    /** 单句成段占比（段内至多一个整句终止——短促独立段手法信号）。 */
    singleSentenceRatio: z.number().nonnegative(),
  }),
  /** 对话行占比（行首引号「『"'“‘ 判定，0-1，round 4）。 */
  dialogueLineRatio: z.number().nonnegative(),
  /** 标点密度（每千字，round 1）。 */
  punctuationPerKilo: z.object({
    exclamation: z.number().nonnegative(),
    question: z.number().nonnegative(),
    ellipsis: z.number().nonnegative(),
    dash: z.number().nonnegative(),
  }),
  /** 高频二字组合 top10（计数降序，平局按首现序——确定性）。 */
  topBigrams: z.array(styleStatsBigramSchema),
});
export type StyleStats = z.infer<typeof styleStatsSchema>;

// ── 计数 helper（纯机械）──

/** 去掉首尾空白后的非空行列表（段落切分：每非空行一段）。 */
function splitParagraphs(fragment: string): string[] {
  return fragment
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 非空白字符数（含标点）。 */
function countNonWhitespace(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    n += 1;
  }
  return n;
}

/** prose 字符（去空白 + 去标点）——分句长与 2-gram 的计量单位。 */
function isProseChar(ch: string): boolean {
  return !/\s/.test(ch) && !NON_PROSE_CHARS.has(ch);
}

function countProseChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (isProseChar(ch)) n += 1;
  }
  return n;
}

function splitClauses(fragment: string): string[] {
  return fragment
    .split(CLAUSE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => {
      // 分句须含实文——滤掉切分后残留的纯标点残片（如 ……—— 的尾破折号，— 不在切分集内）。
      for (const ch of s) {
        if (isProseChar(ch)) return true;
      }
      return false;
    });
}

/**
 * 是否单句成段：整句终止切分后至多一段**含实文**的内容（逗号不算句终）。
 * 段内必须含 prose 字符才算「一句」——滤掉句号后残留的纯标点残片（如 「你好。」 的尾引号 »），
 * 防对话行被误判成两句。
 */
function isSingleSentenceParagraph(paragraph: string): boolean {
  return paragraph
    .split(TERMINAL_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => {
      for (const ch of s) {
        if (isProseChar(ch)) return true;
      }
      return false;
    }).length <= 1;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 数组中位数（偶数取中间均值）。空数组 → 0。 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 计数 → 分桶直方（占比 round 4；空输入全零桶）。 */
function bucketize(
  values: number[],
  buckets: ReadonlyArray<{ label: string; max: number }>,
): StyleStatsBucket[] {
  const counts = buckets.map(() => 0);
  for (const v of values) {
    for (let i = 0; i < buckets.length; i += 1) {
      if (v <= buckets[i]!.max) {
        counts[i]! += 1;
        break;
      }
    }
  }
  const total = values.length;
  return buckets.map((b, i) => ({
    label: b.label,
    count: counts[i]!,
    ratio: total > 0 ? round4(counts[i]! / total) : 0,
  }));
}

/** 正则 run 计数（global flag——调用前重置 lastIndex 防跨调用状态渗漏）。 */
function countRuns(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

/**
 * 高频二字组合 top N（per-段落 2-gram，任一字为停用字即弃——MVP 精度取舍见文件头）。
 * 确定性：计数降序，平局按首现序。
 */
function topBigrams(paragraphs: string[], limit: number): StyleStatsBigram[] {
  const counts = new Map<string, { count: number; firstSeen: number }>();
  let seq = 0;
  for (const paragraph of paragraphs) {
    const prose: string[] = [];
    for (const ch of paragraph) {
      if (isProseChar(ch)) prose.push(ch);
    }
    for (let i = 0; i + 1 < prose.length; i += 1) {
      const a = prose[i]!;
      const b = prose[i + 1]!;
      if (STOP_CHARS.has(a) || STOP_CHARS.has(b)) continue;
      const gram = a + b;
      const entry = counts.get(gram);
      if (entry) entry.count += 1;
      else counts.set(gram, { count: 1, firstSeen: seq++ });
    }
  }
  return [...counts.entries()]
    .map(([text, { count, firstSeen }]) => ({ text, count, firstSeen }))
    .sort((x, y) => y.count - x.count || x.firstSeen - y.firstSeen)
    .slice(0, limit)
    .map(({ text, count }) => ({ text, count }));
}

/**
 * 计算文风片段的机械统计块（纯函数，零 LLM、零 IO）。
 *
 * 空串/纯空白/纯标点输入 → 全零形态（count 0、ratio 0、空数组），永不抛错、永无 NaN——
 * 调用方（dispatch_style_analyzer）在「材料不足」判定前就要先算本块，防御是契约一部分。
 *
 * @param fragment 作者提交的文风片段原文（verbatim）
 */
export function computeStyleStats(fragment: string): StyleStats {
  const text = typeof fragment === 'string' ? fragment : '';
  const paragraphs = splitParagraphs(text);
  const clauses = splitClauses(text);
  const clauseLengths = clauses.map((c) => countProseChars(c));
  const paragraphLengths = paragraphs.map((p) => countNonWhitespace(p));
  const totalChars = countNonWhitespace(text);

  const dialogueLines = paragraphs.filter((p) => DIALOGUE_LINE_START_RE.test(p)).length;
  const singleSentence = paragraphs.filter((p) => isSingleSentenceParagraph(p)).length;

  const perKilo = (hits: number): number =>
    totalChars > 0 ? round1((hits / totalChars) * 1000) : 0;
  let exclamation = 0;
  let question = 0;
  for (const ch of text) {
    if (ch === '！' || ch === '!') exclamation += 1;
    if (ch === '？' || ch === '?') question += 1;
  }

  return {
    totalChars,
    clause: {
      count: clauseLengths.length,
      medianLength: round1(median(clauseLengths)),
      meanLength:
        clauseLengths.length > 0
          ? round1(clauseLengths.reduce((a, b) => a + b, 0) / clauseLengths.length)
          : 0,
      // CR-019：min/max 用 reduce 线性归约——spread（Math.min(...lengths)）在超大片段（数万
      // 分句）会撑爆参数栈抛 RangeError，而 computeStyleStats 在长度门之前就要先算（totalChars
      // 本身来自本计算），必须对任意大输入安全。
      minLength: clauseLengths.length > 0 ? clauseLengths.reduce((a, b) => (a < b ? a : b)) : 0,
      maxLength: clauseLengths.length > 0 ? clauseLengths.reduce((a, b) => (a > b ? a : b)) : 0,
      histogram: bucketize(clauseLengths, CLAUSE_BUCKETS),
    },
    paragraph: {
      count: paragraphs.length,
      meanLength:
        paragraphLengths.length > 0
          ? round1(paragraphLengths.reduce((a, b) => a + b, 0) / paragraphLengths.length)
          : 0,
      histogram: bucketize(paragraphLengths, PARAGRAPH_BUCKETS),
      singleSentenceRatio:
        paragraphs.length > 0 ? round4(singleSentence / paragraphs.length) : 0,
    },
    dialogueLineRatio:
      paragraphs.length > 0 ? round4(dialogueLines / paragraphs.length) : 0,
    punctuationPerKilo: {
      exclamation: perKilo(exclamation),
      question: perKilo(question),
      ellipsis: perKilo(countRuns(text, ELLIPSIS_RUN_RE)),
      dash: perKilo(countRuns(text, DASH_RUN_RE)),
    },
    topBigrams: topBigrams(paragraphs, 10),
  };
}

// ── markdown 渲染（嵌卡第②节用；渲染是纯投影——数据在 compute 单源）──

/** 占比渲染：0.3333 → "33.3%"。 */
function percent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

/**
 * 渲染统计块为 markdown（嵌风格卡第②节；亦作 {{styleStats}} var 喂分析者）。
 * 只做纯投影——不带节标题（标题由 dispatch_style_analyzer 机械注入时补）。
 */
export function renderStyleStatsBlock(stats: StyleStats): string {
  const clauseHist = stats.clause.histogram
    .map((b) => `${b.label} ${percent(b.ratio)}（${b.count}）`)
    .join('｜');
  const paraHist = stats.paragraph.histogram
    .map((b) => `${b.label} ${percent(b.ratio)}（${b.count}）`)
    .join('｜');
  const bigrams = stats.topBigrams.length > 0
    ? stats.topBigrams.map((b) => `${b.text}（${b.count}）`).join('｜')
    : '（无——样本过短或全被停用词过滤）';
  const dialogue = stats.paragraph.count > 0
    ? `${percent(stats.dialogueLineRatio)}（${Math.round(stats.dialogueLineRatio * stats.paragraph.count)}/${stats.paragraph.count} 行）`
    : '0%（0/0 行）';
  const single = stats.paragraph.count > 0
    ? `${percent(stats.paragraph.singleSentenceRatio)}（${Math.round(stats.paragraph.singleSentenceRatio * stats.paragraph.count)} 段）`
    : '0%（0 段）';
  return [
    '> 本节由代码对提交原文机械统计（分句按 。，！？；……切；每非空行一段）。第②节是 V2 统计指纹的升级插槽。',
    `- 字数（非空白字符）：${stats.totalChars}`,
    `- 分句：${stats.clause.count} 句｜句长：中位 ${stats.clause.medianLength} 字 / 平均 ${stats.clause.meanLength} 字 / 区间 ${stats.clause.minLength}-${stats.clause.maxLength} 字`,
    `- 句长分布：${clauseHist}`,
    `- 段落：${stats.paragraph.count} 段｜平均段长 ${stats.paragraph.meanLength} 字｜单句成段 ${single}`,
    `- 段长分布：${paraHist}`,
    `- 对话行占比（行首引号「『"' 判定）：${dialogue}`,
    `- 标点密度（每千字）：叹号 ${stats.punctuationPerKilo.exclamation}｜问号 ${stats.punctuationPerKilo.question}｜省略号 ${stats.punctuationPerKilo.ellipsis}｜破折号 ${stats.punctuationPerKilo.dash}`,
    `- 高频二字组合（近似实词，2-gram 简易聚合）：${bigrams}`,
  ].join('\n');
}
