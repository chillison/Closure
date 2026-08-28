// Stylometry — Reader-Audit L1 pure-code signal layer contract (Story 4.2).
//
// This file is the home of the L1 stylometry module per design §4 (same precedent
// as scene-graph-analytics.ts: pure-code utility in shared-contracts, consumed by
// the agent node). Story 4.2 Step 1 lands ONLY the POS tagger contract types here;
// Step 2 will add computeL1SignalReport() + L1SignalReport + the 9 signal
// implementations + storyTime fold in this same file.
//
// 范式判据 (ADR-3 / .trellis/spec/core/creative-vs-mechanical.md): everything that
// will live in this file is deterministic stylometry / structure lookup / threshold
// hit — "does not understand meaning". POS tagging itself is deterministic
// tokenization (DAG + HMM) + lexicon-based tag lookup — a pure-code utility, NOT
// semantic judgement. Semantic slop / contradiction / imagery-staleness judgement
// stays L2 LLM-side (createReaderAuditNode, Step 5).
//
// Why the contract type lives in shared-contracts (not next to the native wrapper):
// shared-contracts carries no native runtime deps (only zod). The concrete tagger
// wrapper (using the @node-rs/jieba native binding) lives in the consuming package
// (@orison/desktop-agent/src/audit/pos-tagger.ts). This file defines ONLY the
// contract type so Step 2's computeL1SignalReport can accept a TagChineseFn via
// dependency injection — agent injects the concrete tagger at call time, keeping
// shared-contracts native-free (consistent with ADR-2 injection seams).

import type { SceneGraph } from './creative-fields';
import { selectScenesForEpisode, type SceneStructureDigest } from './scene-graph-analytics';
import { CLICHE_PHRASES_ZH, CRUTCH_WORDS_ZH, FILTER_WORDS_ZH, escapeRegExp } from './wordbanks';

/**
 * A single POS-tagged token — the unit the L1 stylometry layer consumes.
 *
 * `token`: the segmented word (maps to jieba's `word`).
 * `pos`:   the part-of-speech tag. jieba uses the ICTCLAS tagset (Chinese Penn
 *          Treebank family): n/v/a/d/r/p/u/x/f/s/z/t/m/q/c/uj/ul/nr/ns/... .
 *          Stylometry only consumes POS *classes* for POS-gram skeleton repetition
 *          + CR:PoS compression — it never does semantic judgement on tags (ADR-3).
 */
export interface PosTag {
  token: string;
  pos: string;
}

/**
 * Chinese POS tagger function contract (deterministic, no semantic judgement).
 *
 * The tagger performs deterministic tokenization (DAG + HMM for OOV) + lexicon
 * POS lookup — it segments "月光/冷冷地/远方" and tags each token, but it does NOT
 * understand the text. This is the creative-vs-mechanical boundary: stylometry is
 * mechanical (POS class statistics), creative quality is LLM (Step 5).
 *
 * Implementations:
 * - @orison/desktop-agent `tagChinese` (@node-rs/jieba 2.0.1 NAPI-RS binding).
 *
 * @param text Chinese prose (e.g. draft.initial.text or a sub-segment)
 * @returns    {token, pos}[] in segmentation order; empty input → []
 *
 * Degradation contract: when the native binding is unavailable at runtime, the
 * concrete implementation returns [] (and exposes a companion availability flag).
 * Step 2 L1 must check that flag and skip POS-dependent signals (POS-gram +
 * CR:PoS) when false — design §10 rollback keeps the other 7 non-POS signals up.
 *
 * expected_downstream_consumers:
 * - Story 4.2 Step 2 `computeL1SignalReport` (this file): consumes the injected
 *   tagger to compute POS-gram skeleton repetition + CR:PoS signals.
 * - Story 4.5 retrieval: may reuse a Chinese tokenizer for scene recall / FTS.
 */
export type TagChineseFn = (text: string) => PosTag[];

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.2 Step 2 — L1 纯代码 stylometry 模块（design §4 / implement Step 2）
// ─────────────────────────────────────────────────────────────────────────────
//
// computeL1SignalReport：Reader-Audit L1 纯代码层（design §2 双层架构）。消费 draft 正文 +
// scene_graph + 注入的 tagger/compress seam，产出 L1SignalReport（9 anti-slop 软信号 + 1 一致性
// L1 storyTime context hint）。L2 LLM（Step 5 createReaderAuditNode）消费本 report 的 hotspots
// 做语义判定（意象陈腐/矛盾/agency），L1 永不直接产 BLOCK/verdict（R3 §6.4 软信号红线）。
//
// 范式判据核（.trellis/spec/core/creative-vs-mechanical.md）：本节全是确定性统计 / 结构查 / 阈值
// 命中 / 词库子串匹配——「不理解意义」。任何「这段是否真 slop / 套话是否挣得位置 / 矛盾是否真矛盾」
// 归 Step 5 L2 LLM。L1 只算 value + flagged（机械阈值）+ evidence（机械定位），不判语义。
//
// 9 anti-slop 信号（design §4 表 + R3 §6.1/§3）：
//  1. POS-gram 骨架重复率（3-gram）— POS 依赖（R3 §6.1 ★ 最高价值）
//  2. CR:PoS（POS 序列压缩比）— POS 依赖（R3 §3.1）
//  3. sentence_length_variance / burstiness（句长 CV）— 无 POS（R3 §6.1）
//  4. lexical_diversity（unique/total，tagger 增强）— R3 §6.1（≤0.20 高危）
//  5. cliche_ratio（cliché 词库命中密度）— R3 §3.4（Step 3 词库）
//  6. crutch_word_density（4 类词库命中密度）— R3 §6.1（Step 3 词库）
//  7. filter_word_density（POV 漂移词库命中密度）— R3 §6.1（Step 3 词库）
//  8. punctuation_rhythm CV + 长破折号密度 — R3 §6.1 + §3.4 ★ ChatGPT hyphen
//  9. CR-words（gzip 压缩比）— R3 §3.1
//
// 一致性 L1（design §4 storyTime fold）——诚实 scope：
//  - DO：selectScenesForEpisode 取本章场，按 storyTime/presentationOrder 排序，产 expectedOrder
//    作 L2 context hint（复用 scene-graph-analytics 范式，不造平行结构）。
//  - DEFER：全 fold（draft 段落 → scene 映射 → 序失配机械检测）需场景切分（未建），无法机械做。
//    绝不造假机械检查（诚实公平 + 范式判断）。L2 LLM 消费 expectedOrder 做语义「draft 是否符合
//    预期场景序」判断。report.storyTimeContext.fullFoldDeferred = true 明示此 defer。
//
// DI seams（ADR-2 注入，保 shared-contracts native-free / renderer-safe）：
//  - tagChinese?: TagChineseFn —— @node-rs/jieba（agent 注入）。缺 → POS-gram/CR:PoS skip +
//    lexical_diversity 降级为 char-based TTR。
//  - compress?: (s) => 压缩字节数 —— node:zlib gzipSync（agent 注入）。缺 → CR-words/CR:PoS skip。
//    用 TextEncoder（Web API，renderer-safe）算输入字节，compress 注入算压缩字节，比值维度一致。
//
// 软阈值（THRESHOLDS）——绝对软阈值，flagged 仅作 L2 hint，永不 gate（R3 §6.4：stylometric
// 跨 genre 不稳）。per-author/per-genre baseline 校准 defer（近端增强，首版不做）。
//
// expected_downstream_consumers（线性耦合，interface-contracts.md）：
//  - Story 4.2 Step 5 createReaderAuditNode：消费 L1SignalReport.hotspots + signals 喂 L2 prompt。
//  - 未来 per-author baseline：消费 L1SignalReport.signals[].value 做基线校准（R3 §6.4）。
//  - 4.6 裁决器 / Epic 7 改稿护栏：消费 evidence[].location 定位改稿（findings grounding 复用）。

/** L1 信号证据——正文原句片段 + 位置（句索引，机械定位）。 */
export interface L1SignalEvidence {
  /** 正文原句片段（grounding，喂 L2 引用）。 */
  quote: string;
  /** 位置：首版用句索引（按 。！？切），形如 "句3"。 */
  location: string;
}

/** L1 单信号——name + value + flagged + evidence（+ optional note）。 */
export interface L1Signal {
  name: string;
  /** 信号主值（语义随 name 变，见 THRESHOLDS / 信号注释；如 CV / 比例 / 密度）。 */
  value: number;
  /** 软信号 flag——仅作 L2 hint，L1 永不据此产 BLOCK/verdict（R3 §6.4）。 */
  flagged: boolean;
  /** flagged 时的证据（原句 + 句索引）；未 flagged 或 skip 时为空。 */
  evidence: L1SignalEvidence[];
  /** 可选 note：skip 原因 / 降级度量 / defer 标注（诚实报告）。 */
  note?: string;
}

/** L2 聚焦热点——某位置上聚集的信号名（按句索引聚合）。 */
export interface L1Hotspot {
  location: string;
  signals: string[];
}

/**
 * 一致性 L1 storyTime fold context（诚实 scope——仅结构查询，不做 draft→scene 映射）。
 *
 * 复用 selectScenesForEpisode 取本章场，按 storyTime 升序排序，作 L2「预期场景序」context hint。
 * 全 fold（draft 段落 → scene 映射 → 序失配机械检测）需场景切分（未建），defer 给 L2 语义判定。
 */
export interface L1StoryTimeContext {
  /** 本章 episodeId（来自 args，无则 undefined）。 */
  episodeId?: string;
  /** 本章涉及场按 storyTime/presentationOrder 升序的结构摘要（selectScenesForEpisode 投影）。 */
  expectedOrder: SceneStructureDigest[];
  /** 诚实 defer 标注：全 fold 机械检测未做（需场景切分），L2 语义判定 draft 是否符合预期序。 */
  fullFoldDeferred: true;
  /** 诚实说明：做了什么 / defer 了什么（喂 L2 context + 调试可观测）。 */
  note: string;
}

/** L1 完整 report——9 anti-slop 信号 + hotspots + storyTime context。 */
export interface L1SignalReport {
  signals: L1Signal[];
  hotspots: L1Hotspot[];
  /** 一致性 L1 storyTime fold context（scene_graph 提供时；无 scene_graph 则缺省）。 */
  storyTimeContext?: L1StoryTimeContext;
}

/** L1 stylometry 注入依赖（ADR-2 seams，保 shared-contracts native-free）。 */
export interface L1StylometryDeps {
  /**
   * 中文 POS tagger（@node-rs/jieba，agent 注入）。缺 → POS-gram/CR:PoS skip +
   * lexical_diversity 降级为 char-based TTR（design §10 rollback：余 7 信号仍上）。
   */
  tagChinese?: TagChineseFn;
  /**
   * 压缩函数（返回压缩字节数，agent 注入 `(s) => gzipSync(s, {level:9}).length`）。
   * 缺 → CR-words/CR:PoS skip。注入（非 import node:zlib）保 shared-contracts renderer-safe。
   * 输入字节用 TextEncoder（Web API）算，与 compress 输出字节同维度（UTF-8 bytes）。
   */
  compress?: (input: string) => number;
}

// ── 软阈值（R3 §6.1/§3 火山权重序；绝对软阈值，flagged 仅作 L2 hint，永不 gate）──
// 首版绝对阈值；per-author/per-genre baseline 校准 defer（R3 §6.4：stylometric 跨 genre 不稳）。
// 命名常量便于调参 + 未来 baseline 替换。改阈值不改语义（仍软信号）。
export const L1_THRESHOLDS = {
  /** POS 3-gram 重复率（重复 trigram 占比）>0.15 = 骨架重复 hint（R3 §6.1 ★ 最高价值）。 */
  POSGRAM_REPEAT_RATIO: 0.15,
  /** POS 序列压缩比 <0.45 = 高度可压缩 = 骨架重复 hint（R3 §3.1）。 */
  CR_POS: 0.45,
  /** 句长 CV <0.3 = 节奏单调 hint（R3 §6.1 自然 3.5±2.5；CV 维度无关，用 0.3 软阈）。 */
  SENTENCE_LENGTH_CV: 0.3,
  /** 词汇多样性 TTR <0.20 = 词汇贫乏高危（R3 §6.1）。 */
  LEXICAL_DIVERSITY: 0.2,
  /** cliché 命中密度（每 token）>0.005 = cliché 过载 hint（R3 §3.4）。 */
  CLICHE_DENSITY: 0.005,
  /** crutch 命中密度（每 token）>0.03 = crutch 过载 hint（R3 §6.1）。 */
  CRUTCH_DENSITY: 0.03,
  /** filter 命中密度（每 token）>0.025 = POV 漂移 hint（R3 §6.1）。 */
  FILTER_DENSITY: 0.025,
  /** 标点节奏 CV <0.3 = 标点节奏单调 hint（R3 §6.1）。 */
  PUNCT_RHYTHM_CV: 0.3,
  /** 长破折号密度（每 char）>0.0008 = AI 痕迹 hint（R3 §3.4 ★ 真人基线接近 0）。 */
  EM_DASH_PER_CHAR: 0.0008,
  /** 正文 gzip 压缩比 <0.40 = 高度可压缩 = 重复 hint（R3 §3.1）。 */
  CR_WORDS: 0.4,
} as const;

// ── 句切分（按 。！？切，首版 location = 句索引）──
// 非语义判断——机械标点切分。保留 trim 后非空句。
const SENTENCE_SPLIT_RE = /[。！？!?…\n]+/;
/** 中文标点（句/分句终止 + 逗号 + 顿号 + 分号 + 冒号 + 换行 + 长破折号）——punctuation rhythm / countProseChars 用。 */
// ⚠️ 不加 `g` flag：本 regex 同时用于 `.test(ch)`（countProseChars / computeTtr 逐字判）+ `.split(text)`
// （computePunctuationRhythm）。`.test()` 在 `g` flag 下是 stateful（match 后 lastIndex 推进，下次 test 从
// lastIndex 起），逐字测连续标点时第 2 个标点会被误判为非标点（lastIndex=1 已到 1-char 串尾 → miss → 计入
// prose，膨胀分母）。`.split()` 不需 `g`（始终找全分隔符），去 `g` 后两用法皆正确（interface-contracts.md
// 行为风险改动：本修是 bugfix——修连续标点误计 prose，非风格清理）。
//
// B9（CR patch）：字符表含 `—`（U+2014 em-dash）——em-dash 是标点非 prose，计入则 countProseChars 把它当
// prose 字符，自衰减 em-dash 密度（emDashCount/proseChars，分母被 em-dash 膨胀）。纳入后：countProseChars
// 排除 em-dash（密度分母诚实）+ computePunctuationRhythm 把 em-dash 作节奏断点（split 在 — 处切断 run）。
const PUNCTUATION_CHARS_RE = /[。！？!?；;，,、.：:\n…"'""''「」（）()—]/;

/** 标点符号 U+2014（中文破折号 — ，AI 文本常成对 ——）。 */
const EM_DASH_CHAR = '—';

/**
 * 切句——按 。！？切，trim 后过滤空。location 用 1-based 句索引（"句N"）。
 * 机械标点切分，非语义。空/纯空白正文 → []。
 */
function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 非空白 + 非标点的字符数（char-based 正文长度，无 POS 时 token 估计分母用）。 */
function countProseChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (PUNCTUATION_CHARS_RE.test(ch)) continue;
    n++;
  }
  return n;
}

/**
 * token 估计——tagger 可用时返词级 token 数（pos!=='x'，排除标点），否则 char/1.7（中文均词长 ~1.7）。
 * 机械计数，非语义。作 density 信号分母（cliche/crutch/filter per-token rate）。
 *
 * B3（CR patch）：消费预分词 `tags`（由 computeL1SignalReport 一次分词得，避免各信号重复分词）。
 * B13（CR patch）：删 `wordLevel` 返回值——唯一调用方只取 token 数（死返回值）。
 */
function estimateTokenCount(text: string, tags?: PosTag[]): number {
  if (tags) {
    const wordTokens = tags.filter((t) => t.pos !== 'x' && t.token.trim().length > 0).length;
    if (wordTokens > 0) return wordTokens;
  }
  // 退化：char-based 估计（中文均词长 ~1.7 char/word）
  return Math.max(1, Math.round(countProseChars(text) / 1.7));
}

/**
 * 词库子串匹配器——编译 bank 为 RegExp alternation，一次扫全 bank 命中。
 * 返 {sentenceIdx → matchedPhrases[]} 映射（per-sentence 证据定位）+ 总命中数。
 * 机械匹配（≥2 字词原子串匹配），非语义。bank 空 → 无命中。
 */
function matchWordbankPerSentence(
  sentences: string[],
  bank: readonly string[],
): { perSentence: Map<number, string[]>; totalHits: number } {
  const perSentence = new Map<number, string[]>();
  let totalHits = 0;
  // E11（CR patch）：滤除空/单字条目（与 wordbanks ≥2 字约定一致）——防空/单字条目（如「想」）子串误命中
  // （想法/理想）致密度膨胀。零长死循环已防（pattern.exec lastIndex 推进）；命中数膨胀本守卫防。
  const filtered = bank.filter((s) => s.length >= 2);
  if (filtered.length === 0) return { perSentence, totalHits };
  const pattern = new RegExp(filtered.map(escapeRegExp).join('|'), 'g');
  for (let i = 0; i < sentences.length; i++) {
    pattern.lastIndex = 0;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(sentences[i])) !== null) {
      matches.push(m[0]);
      totalHits++;
      if (m.index === pattern.lastIndex) pattern.lastIndex++; // 防零长死循环（防御）
    }
    if (matches.length > 0) perSentence.set(i, matches);
  }
  return { perSentence, totalHits };
}

/** 数组均值 / 总体 stddev / CV——纯统计，非语义。空/单元素 → 0。 */
function stats(values: number[]): { mean: number; stddev: number; cv: number } {
  if (values.length === 0) return { mean: 0, stddev: 0, cv: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) return { mean, stddev: 0, cv: 0 };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  const cv = mean > 0 ? stddev / mean : 0;
  return { mean, stddev, cv };
}

/**
 * UTF-8 字节长度（Web API TextEncoder，renderer-safe——非 node:zlib）。
 * 与注入的 compress 输出（字节数）同维度，比值维度一致。
 */
const TEXT_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function utf8ByteLength(s: string): number {
  if (TEXT_ENCODER) return TEXT_ENCODER.encode(s).length;
  // 退化（极旧环境无 TextEncoder）：按 char 长度粗估（renderer 现代环境不会走此分支）
  return s.length;
}

// ── 信号 1：POS-gram 骨架重复率（3-gram）— POS 依赖 ──
function computePosgramRepeat(text: string, tags?: PosTag[]): L1Signal {
  const name = 'posgram_skeleton_repeat';
  if (!tags) {
    return { name, value: 0, flagged: false, evidence: [], note: 'skipped: tagger 未注入（design §10 rollback）' };
  }
  const wordTags = tags.filter((t) => t.pos !== 'x'); // 排除标点
  if (wordTags.length < 4) {
    return { name, value: 0, flagged: false, evidence: [], note: `文本过短（${wordTags.length} 词级 token < 4），POS-gram 不可靠，skip` };
  }
  const trigrams: string[] = [];
  for (let i = 0; i + 2 < wordTags.length; i++) {
    trigrams.push(`${wordTags[i].pos}|${wordTags[i + 1].pos}|${wordTags[i + 2].pos}`);
  }
  const total = trigrams.length;
  const unique = new Set(trigrams).size;
  const repeatRatio = total > 0 ? (total - unique) / total : 0; // 0=全唯一，~1=全同骨架
  const flagged = repeatRatio > L1_THRESHOLDS.POSGRAM_REPEAT_RATIO;
  // 证据：找重复次数最多的 trigram 骨架
  const trigramCounts = new Map<string, number>();
  for (const tg of trigrams) trigramCounts.set(tg, (trigramCounts.get(tg) ?? 0) + 1);
  const topTrigram = [...trigramCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const evidence: L1SignalEvidence[] = [];
  if (flagged && topTrigram && topTrigram[1] > 1) {
    // B14（CR patch）：诚实全文级——不固定取前两句（非真实重复位点，grounding 不准），只报最高频骨架
    // 全文出现次数（全文级骨架重复，诚实不假造位点）。
    evidence.push({
      quote: `最高频 POS 3-gram 骨架 [${topTrigram[0]}] 出现 ${topTrigram[1]} 次（共 ${total} 个 trigram，unique ${unique}）`,
      location: '全文',
    });
  }
  return {
    name,
    value: repeatRatio,
    flagged,
    evidence,
    note: `repeatRatio=${repeatRatio.toFixed(3)}（>${L1_THRESHOLDS.POSGRAM_REPEAT_RATIO} flagged）`,
  };
}

// ── 信号 2：CR:PoS（POS 序列压缩比）— POS + compress 依赖 ──
function computeCrPos(
  compress: ((s: string) => number) | undefined,
  text: string,
  tags?: PosTag[],
): L1Signal {
  const name = 'cr_pos';
  if (!tags || !compress) {
    return { name, value: 0, flagged: false, evidence: [], note: 'skipped: tagger 或 compress 未注入' };
  }
  const wordTags = tags.filter((t) => t.pos !== 'x');
  if (wordTags.length < 4) {
    return { name, value: 0, flagged: false, evidence: [], note: `文本过短（${wordTags.length} token < 4），CR:PoS 不可靠，skip` };
  }
  const posSeq = wordTags.map((t) => t.pos).join(' ');
  const compressed = compress(posSeq);
  const inputBytes = utf8ByteLength(posSeq);
  const ratio = inputBytes > 0 ? compressed / inputBytes : 0; // 越低 = 越可压缩 = 骨架越重复
  const flagged = ratio < L1_THRESHOLDS.CR_POS;
  const evidence: L1SignalEvidence[] = flagged
    ? [{ quote: `POS 序列压缩比 ${ratio.toFixed(3)}（<${L1_THRESHOLDS.CR_POS} = 骨架重复可压缩）`, location: '全文' }]
    : [];
  return { name, value: ratio, flagged, evidence, note: `crPos=${ratio.toFixed(3)}` };
}

// ── 信号 3：sentence_length_variance / burstiness（句长 CV）— 无 POS ──
function computeSentenceLengthCv(text: string, sentences: string[]): L1Signal {
  const name = 'sentence_length_variance';
  if (sentences.length < 2) {
    return { name, value: 0, flagged: false, evidence: [], note: `句数 ${sentences.length} < 2，方差不可靠，skip` };
  }
  const lengths = sentences.map((s) => countProseChars(s));
  const { cv, stddev } = stats(lengths);
  // B4（CR patch）：去 `cv > 0` 守卫——cv=0（所有句等长，最单调情形）应 flag（length<2 skip 已防单样本）。
  const flagged = cv < L1_THRESHOLDS.SENTENCE_LENGTH_CV; // 低 CV = 句长单调
  // 证据：取样展示句长节奏（首 3 句 + 其字数）
  const evidence: L1SignalEvidence[] = [];
  if (flagged) {
    sentences.slice(0, 3).forEach((s, i) => {
      evidence.push({ quote: `${s}（${lengths[i]} 字）`, location: `句${i + 1}` });
    });
    evidence.push({
      quote: `句长 CV=${cv.toFixed(3)}（stddev=${stddev.toFixed(1)} 字，<${L1_THRESHOLDS.SENTENCE_LENGTH_CV} = 节奏单调）`,
      location: '全文',
    });
  }
  return { name, value: cv, flagged, evidence, note: `cv=${cv.toFixed(3)},stddev=${stddev.toFixed(1)}` };
}

// ── 信号 4：lexical_diversity（TTR，tagger 增强）─ R3 §6.1（≤0.20 高危）──
function computeLexicalDiversity(text: string, tags?: PosTag[]): L1Signal {
  const name = 'lexical_diversity';
  const { ttr, source } = computeTtr(text, tags);
  if (ttr === null) {
    return { name, value: 0, flagged: false, evidence: [], note: '空正文 / 无可用 token，skip' };
  }
  const flagged = ttr < L1_THRESHOLDS.LEXICAL_DIVERSITY;
  const evidence: L1SignalEvidence[] = flagged
    ? [{ quote: `词汇多样性 TTR=${ttr.toFixed(3)}（<${L1_THRESHOLDS.LEXICAL_DIVERSITY} = 词汇贫乏高危，R3 §6.1）`, location: '全文' }]
    : [];
  // B6（CR patch）：诚实报告 TTR 来源——tagger 注入但返空（wordTokens===0）走 char-fallback 时标
  // 'char-based fallback'，不撒谎 'word-level，tagger 增强'（旧 note 据 `tagger` 真值判，返空时撒谎）。
  const ttrStr = `ttr=${ttr.toFixed(3)}`;
  const note =
    source === 'word'
      ? `${ttrStr}（word-level，tagger 增强）`
      : tags
        ? `${ttrStr}（char-based fallback，tagger 返空/全标点）`
        : `${ttrStr}（char-based 退化，tagger 未注入）`;
  return { name, value: ttr, flagged, evidence, note };
}

/**
 * TTR = unique/total。tagger 可用 → word-level（pos!=='x'）；否则 char-level（退化为非标点字）。
 * B3（CR patch）：消费预分词 tags（避免重复分词）。
 * B6（CR patch）：返 source 明示 TTR 来源（word/char/empty）——调用方据 source + tags 真值给诚实 note。
 * 返 ttr=null = 空 / 无可用 token（空正文、纯标点）—— 调用方据此 skip（避免空文本 TTR=0 假阳性 flag）。
 */
function computeTtr(text: string, tags?: PosTag[]): { ttr: number | null; source: 'word' | 'char' | 'empty' } {
  if (tags) {
    const wordTokens = tags
      .filter((t) => t.pos !== 'x' && t.token.trim().length > 0)
      .map((t) => t.token.trim());
    if (wordTokens.length > 0) {
      return { ttr: new Set(wordTokens).size / wordTokens.length, source: 'word' };
    }
    // tagger 注入但返空/全标点 → 落 char-fallback（source='char' + tags 真值 → note 标 'tagger 返空'）
  }
  // char-level 退化
  const chars: string[] = [];
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (PUNCTUATION_CHARS_RE.test(ch)) continue;
    chars.push(ch);
  }
  if (chars.length === 0) return { ttr: null, source: 'empty' };
  return { ttr: new Set(chars).size / chars.length, source: 'char' };
}

// ── 信号 5/6/7：词库命中密度（cliche / crutch / filter）— 共用 helper ──
function computeWordbankDensity(
  name: string,
  sentences: string[],
  text: string,
  bank: readonly string[],
  tokenCount: number,
  threshold: number,
  evidenceLabel: string,
): L1Signal {
  const { perSentence, totalHits } = matchWordbankPerSentence(sentences, bank);
  const density = tokenCount > 0 ? totalHits / tokenCount : 0;
  const flagged = density > threshold;
  const evidence: L1SignalEvidence[] = [];
  if (flagged) {
    // 前 5 个命中句作证据
    let count = 0;
    for (const [idx, phrases] of perSentence) {
      if (count >= 5) break;
      evidence.push({
        quote: `${sentences[idx]}【命中：${phrases.join(', ')}】`,
        location: `句${idx + 1}`,
      });
      count++;
    }
    evidence.push({
      quote: `${evidenceLabel}：${totalHits} 命中 / ${tokenCount} tokens = 密度 ${density.toFixed(4)}（>${threshold}）`,
      location: '全文',
    });
  }
  return {
    name,
    value: density,
    flagged,
    evidence,
    note: `${totalHits} hits, density=${density.toFixed(4)}`,
  };
}

// ── 信号 8：punctuation_rhythm CV + 长破折号密度 — 无 POS ──
function computePunctuationRhythm(text: string): L1Signal {
  const name = 'punctuation_rhythm';
  // 标点间 prose run 长度（标点节奏）
  const runs = text
    .split(PUNCTUATION_CHARS_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => countProseChars(s));
  const { cv } = stats(runs);
  // 长破折号密度（U+2014）
  let emDashCount = 0;
  for (const ch of text) {
    if (ch === EM_DASH_CHAR) emDashCount++;
  }
  const proseChars = countProseChars(text);
  const emDashDensity = proseChars > 0 ? emDashCount / proseChars : 0;
  // B4（CR patch）：去 `cv > 0` 守卫——cv=0（所有 run 等长，最单调情形）现在 flag。但 runs < 2（空正文/单 run）
  // 时 stats 不可靠（单样本 cv 恒 0），不据此 flag（同 computeSentenceLengthCv length<2 skip 哲学）。
  const rhythmFlagged = runs.length >= 2 && cv < L1_THRESHOLDS.PUNCT_RHYTHM_CV;
  const emDashFlagged = emDashDensity > L1_THRESHOLDS.EM_DASH_PER_CHAR;
  const flagged = rhythmFlagged || emDashFlagged;
  const evidence: L1SignalEvidence[] = [];
  if (emDashFlagged) {
    // 找含长破折号的句
    const sentences = splitSentences(text);
    sentences.forEach((s, i) => {
      if (s.includes(EM_DASH_CHAR) && evidence.length < 5) {
        evidence.push({ quote: `${s}【含长破折号 —，R3 §3.4 ChatGPT hyphen 痕迹】`, location: `句${i + 1}` });
      }
    });
    evidence.push({
      quote: `长破折号密度 ${emDashDensity.toFixed(5)}（>${L1_THRESHOLDS.EM_DASH_PER_CHAR}，真人基线接近 0）`,
      location: '全文',
    });
  }
  if (rhythmFlagged) {
    evidence.push({
      quote: `标点节奏 CV=${cv.toFixed(3)}（<${L1_THRESHOLDS.PUNCT_RHYTHM_CV} = 标点节奏单调）`,
      location: '全文',
    });
  }
  const noteParts: string[] = [`cv=${cv.toFixed(3)}`, `emDash=${emDashCount}（density ${emDashDensity.toFixed(5)})`];
  return { name, value: cv, flagged, evidence, note: noteParts.join(', ') };
}

// ── 信号 9：CR-words（正文 gzip 压缩比）— compress 依赖 ──
function computeCrWords(
  compress: ((s: string) => number) | undefined,
  text: string,
): L1Signal {
  const name = 'cr_words';
  if (!compress) {
    return { name, value: 0, flagged: false, evidence: [], note: 'skipped: compress 未注入' };
  }
  if (text.trim().length === 0) {
    return { name, value: 0, flagged: false, evidence: [], note: '空正文，skip' };
  }
  const compressed = compress(text);
  const inputBytes = utf8ByteLength(text);
  const ratio = inputBytes > 0 ? compressed / inputBytes : 0; // 越低 = 越可压缩 = 越重复
  const flagged = ratio < L1_THRESHOLDS.CR_WORDS;
  const evidence: L1SignalEvidence[] = flagged
    ? [{ quote: `正文压缩比 ${ratio.toFixed(3)}（<${L1_THRESHOLDS.CR_WORDS} = 高度可压缩 = 重复泔水 hint）`, location: '全文' }]
    : [];
  return { name, value: ratio, flagged, evidence, note: `crWords=${ratio.toFixed(3)}` };
}

// ── 一致性 L1：storyTime fold context（诚实 scope——结构查询 only）──
function computeStoryTimeContext(
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
): L1StoryTimeContext | undefined {
  if (!sceneGraph || !episodeId) return undefined;
  const scenes = selectScenesForEpisode(sceneGraph, episodeId);
  // 按 storyTime 升序，再按 presentationOrder（chapter, pos）稳定排序——机械结构排序，非语义。
  const expectedOrder = [...scenes].sort((a, b) => {
    if (a.storyTime !== b.storyTime) return a.storyTime - b.storyTime;
    if (a.presentationOrder.chapter !== b.presentationOrder.chapter) {
      return a.presentationOrder.chapter - b.presentationOrder.chapter;
    }
    return a.presentationOrder.pos - b.presentationOrder.pos;
  });
  return {
    episodeId,
    expectedOrder,
    fullFoldDeferred: true,
    note: `L1 仅做结构查询：取本章 ${scenes.length} 场，按 storyTime/presentationOrder 排序作 L2 context。` +
      `全 fold（draft 段落 → scene 映射 → 序失配机械检测）需场景切分（未建），defer 给 L2 语义判定（design §4）。`,
  };
}

/**
 * 计算 Reader-Audit L1 纯代码信号 report（design §4）。
 *
 * 9 anti-slop 软信号（POS 依赖信号在 tagger 缺时 skip + 降级）+ 1 storyTime fold context hint。
 * 纯代码：确定性统计 / 结构查 / 阈值命中 / 词库子串匹配。**零 LLM、零语义判断**（ADR-3）。
 * L1 永不产 BLOCK/verdict——所有 flagged 仅作 L2 LLM hint（R3 §6.4 软信号红线）。
 *
 * @param args.draftText   正文（draft.initial.text）
 * @param args.sceneGraph  SceneGraph（storyTime fold 结构查询源；缺 → 无 storyTimeContext）
 * @param args.episodeId   本章 episode id（缺 → storyTimeContext 缺省）
 * @param args.deps        注入依赖（tagChinese / compress，ADR-2 seams）
 * @returns                L1SignalReport（signals + hotspots + storyTimeContext?）
 */
export function computeL1SignalReport(args: {
  draftText: string;
  sceneGraph?: SceneGraph;
  episodeId?: string;
  deps?: L1StylometryDeps;
}): L1SignalReport {
  const { draftText, sceneGraph, episodeId, deps } = args;
  const tagger = deps?.tagChinese;
  const compress = deps?.compress;
  const text = draftText ?? '';
  const sentences = splitSentences(text);
  // B3（CR patch）：tagger 可用时**一次**分词得 PosTag[]，复用给 POS-gram/CR:PoS/lexical/tokenCount
  // （消除全文 4× 冗余分词：旧 estimateTokenCount/posgram/crPos/lexical 各调 tagger(text)）。
  const tags = tagger ? tagger(text) : undefined;
  const tokenCount = estimateTokenCount(text, tags);

  const signals: L1Signal[] = [
    // POS-依赖信号（tagger 缺时 skip）
    computePosgramRepeat(text, tags),
    computeCrPos(compress, text, tags),
    // 无 POS 信号
    computeSentenceLengthCv(text, sentences),
    computeLexicalDiversity(text, tags),
    // 词库命中密度信号（Step 3 词库）
    computeWordbankDensity(
      'cliche_ratio', sentences, text, CLICHE_PHRASES_ZH,
      tokenCount, L1_THRESHOLDS.CLICHE_DENSITY, 'cliché 命中',
    ),
    computeWordbankDensity(
      'crutch_word_density', sentences, text, CRUTCH_WORDS_ZH.all,
      tokenCount, L1_THRESHOLDS.CRUTCH_DENSITY, 'crutch 命中',
    ),
    computeWordbankDensity(
      'filter_word_density', sentences, text, FILTER_WORDS_ZH,
      tokenCount, L1_THRESHOLDS.FILTER_DENSITY, 'filter 命中',
    ),
    // 标点节奏 + 长破折号
    computePunctuationRhythm(text),
    // compress-依赖信号
    computeCrWords(compress, text),
  ];

  // hotspots：按句索引聚合 flagged 信号（喂 L2 聚焦）
  const locationToSignals = new Map<string, string[]>();
  for (const sig of signals) {
    if (!sig.flagged) continue;
    for (const ev of sig.evidence) {
      if (ev.location === '全文') continue; // 全文级证据不入 per-location hotspot
      const list = locationToSignals.get(ev.location) ?? [];
      list.push(sig.name);
      locationToSignals.set(ev.location, list);
    }
  }
  const hotspots: L1Hotspot[] = [...locationToSignals.entries()]
    .map(([location, sigs]) => ({ location, signals: [...new Set(sigs)] }))
    // B7（CR patch）：numeric 排序——句索引按数值序（句2 < 句11），非字符串序（旧 '句11' < '句2'，错位）。
    .sort((a, b) => a.location.localeCompare(b.location, 'zh', { numeric: true }));

  const storyTimeContext = computeStoryTimeContext(sceneGraph, episodeId);

  return { signals, hotspots, storyTimeContext };
}
