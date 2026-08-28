// ── Story 7.2：meaning-preservation 护栏 L1 廉价信号层（design §1.1，零数据依赖）──
//
// 改后段落 vs 改前段落的**机械结构幅度核对**：lengthRatio（剧变 flag）+ 字符 n-gram Jaccard 相似度
// （改动幅度 hint）。纯 TS 集合运算——零 LLM、零 native 依赖（不调 tagChinese / compress / 不查词库）。
//
// 🔑 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：L1 只算长度比 + n-gram 集合相似度
// ——「不理解意义」。flagged 仅作 L2 聚焦 hint（「这段改动幅度大，重点查」），**永不直接产越界 verdict**。
// 漂移模式①②③④⑤⑥ 全归 L2（含口癖⑤——口癖纯代码检测 defer 反 AI 味模块，本 L1 不含）。
//
// 🔑 L1 范围（用户 2026-08-12 定）：口癖纯代码检测（crutch/cliché/em-dash 词库命中密度）属反 AI 味模块
// （Epic 10 / child2 表述层），需词库数据 + per-author/per-genre baseline，用户暂无数据（网上有现成总结好
// 的程序以后纳入）。stylometry computeL1SignalReport 9 信号**不在 7.2 复用**——等反 AI 味模块统一接。
// 本 L1 只做零数据依赖的幅度核对。
//
// expected_downstream_consumers:
// - Story 7.2 revision-guard 节点（chapter-nodes.ts createRevisionGuardNode）：调 computeRevisionGuardL1
//   产 report，flagged 时渲染 l1Hint 喂 L2 prompt（聚焦非门禁）。
// - Story 7.4 A-trigger：复用本 L1（核心零数据依赖，换 trigger 零改插入，design §1.6）。

/** L1 护栏输入（7.1 已有的 artifact，零新 fetch，零 native 依赖）。 */
export interface RevisionGuardL1Input {
  /** 改前段落（revision_intent.scope.anchor.quote，选区原文 = 作者意图活样本）。 */
  beforeText: string;
  /** 改后段落（draft-writer passageText = AI 改后段落）。 */
  afterText: string;
}

/** 选区范围幅度核对（机械，零数据依赖）。 */
export interface RevisionGuardRangeCheck {
  /** 改后长度 / 改前长度比（剧变 = 可疑：改了一段不该改这么多）。before 空 → 1（不 flag）。 */
  lengthRatio: number;
  /**
   * 字符 n-gram（首版 3-gram）Jaccard 相似度（改前→改后结构漂移幅度；越低 = 改动越大）。
   * 纯机械集合运算 |A∩B|/|A∪B|，零词库/native 依赖。before/after 任一空 → 1（不 flag）。
   */
  ngramSimilarity: number;
  /** lengthRatio 超阈 OR ngramSimilarity 过低。仅 L2 聚焦 hint，永不下 verdict。 */
  flagged: boolean;
  /** 诚实说明：flag 原因 / skip 原因（空文本）/ 数值。 */
  note: string;
}

/** L1 护栏 report——选区范围幅度核对（纯 hint，永不下 verdict，零数据依赖）。 */
export interface RevisionGuardL1Report {
  /** 选区范围幅度核对（机械）。 */
  rangeCheck: RevisionGuardRangeCheck;
}

// ── 阈值（绝对软阈，首版；零数据依赖故无 baseline 校准需求）──
// 命名常量便于调参。改阈值不改语义（仍软 hint）。dogfood 调幅度边界（design §5 待定①）。
export const REVISION_GUARD_L1_THRESHOLDS = {
  /** 改后 < 改前 50% = 剧烈缩短嫌疑（改了一段不该改这么少）。 */
  LENGTH_RATIO_MIN: 0.5,
  /** 改后 > 改前 200% = 剧烈膨胀嫌疑（改了一段不该改这么多）。 */
  LENGTH_RATIO_MAX: 2.0,
  /** 字符 3-gram Jaccard < 0.3 = 改动幅度大（聚焦 hint，非越界判定）。 */
  NGRAM_SIMILARITY: 0.3,
} as const;

/** 字符 n-gram size（首版 3-gram——中文 3 字覆盖多数词素，短文本稳定）。 */
const NGRAM_SIZE = 3;

/**
 * 字符 n-gram 集合（多 set 容重复——Jaccard 用 multiset 交并保词频敏感）。
 *
 * 返 Map<gram, count>（multiset）。纯机械滑窗切片，零语义。文本短于 ngram size → 单 gram = 全文。
 */
function charNgramCounts(text: string): Map<string, number> {
  const m = new Map<string, number>();
  if (text.length === 0) return m;
  if (text.length <= NGRAM_SIZE) {
    m.set(text, 1);
    return m;
  }
  for (let i = 0; i <= text.length - NGRAM_SIZE; i += 1) {
    const g = text.slice(i, i + NGRAM_SIZE);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/**
 * 字符 n-gram Jaccard 相似度（multiset Jaccard = Σmin(a,b) / Σmax(a,b)）。
 *
 * 纯机械集合运算，零词库/native 依赖。任一空 → 1（不 flag，caller 据此判无幅度异常）。
 * multiset 版（非 set Jaccard）对词频敏感——同词重复增减会被反映（对应「删语气词」类幅度）。
 */
function ngramJaccard(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 1;
  const ca = charNgramCounts(a);
  const cb = charNgramCounts(b);
  let intersection = 0;
  let union = 0;
  // 交 = Σ min(countA, countB)；并先累 A 全量，再补 B 独有（max）。
  for (const [g, count] of ca) {
    const other = cb.get(g) ?? 0;
    intersection += Math.min(count, other);
    union += count;
  }
  for (const [g, count] of cb) {
    const other = ca.get(g) ?? 0;
    if (count > other) union += count - other; // B 独有部分补并集
  }
  return union > 0 ? intersection / union : 1;
}

/**
 * 计算 Reader-Audit 护栏 L1 纯代码 report（design §1.1）。
 *
 * 选区范围幅度核对：lengthRatio（剧变 flag）+ 字符 3-gram Jaccard（改动幅度 hint）。
 * 纯代码：长度比 + 集合运算。**零 LLM、零语义判断、零 native 依赖**（ADR-3）。
 * L1 永不产越界 verdict——flagged 仅作 L2 LLM 聚焦 hint（范式红线）。
 *
 * 空文本 graceful：before/after 任一空 → lengthRatio=1 + ngramSimilarity=1 + flagged=false + note 标空
 * （不 flag，让 L2 纯语义判，mirror stylometry 软信号降级哲学）。
 *
 * @param args.beforeText 改前段落（scope.anchor.quote）。
 * @param args.afterText  改后段落（draft passageText）。
 * @returns               RevisionGuardL1Report（rangeCheck）。
 */
export function computeRevisionGuardL1(args: RevisionGuardL1Input): RevisionGuardL1Report {
  const before = args.beforeText ?? '';
  const after = args.afterText ?? '';
  const beforeLen = before.length;
  const afterLen = after.length;

  // 空文本 graceful（before/after 任一空 → 不 flag，L2 纯语义判）。
  if (beforeLen === 0 || afterLen === 0) {
    return {
      rangeCheck: {
        lengthRatio: 1,
        ngramSimilarity: 1,
        flagged: false,
        note: `空文本（before=${beforeLen}字, after=${afterLen}字），L1 不 flag → L2 纯语义判`,
      },
    };
  }

  const lengthRatio = afterLen / beforeLen;
  const ngramSim = ngramJaccard(before, after);
  const lengthFlagged =
    lengthRatio < REVISION_GUARD_L1_THRESHOLDS.LENGTH_RATIO_MIN ||
    lengthRatio > REVISION_GUARD_L1_THRESHOLDS.LENGTH_RATIO_MAX;
  const ngramFlagged = ngramSim < REVISION_GUARD_L1_THRESHOLDS.NGRAM_SIMILARITY;
  const flagged = lengthFlagged || ngramFlagged;

  const reasons: string[] = [];
  if (lengthFlagged) {
    reasons.push(
      `lengthRatio=${lengthRatio.toFixed(3)}（${lengthRatio < REVISION_GUARD_L1_THRESHOLDS.LENGTH_RATIO_MIN ? `缩至 ${Math.round(lengthRatio * 100)}%` : `膨胀至 ${Math.round(lengthRatio * 100)}%`}）`,
    );
  }
  if (ngramFlagged) {
    reasons.push(`ngramSim=${ngramSim.toFixed(3)}（<${REVISION_GUARD_L1_THRESHOLDS.NGRAM_SIMILARITY} = 改动幅度大）`);
  }
  const note = flagged
    ? `幅度 hint：${reasons.join('；')}（聚焦 L2，非越界判定）`
    : `lengthRatio=${lengthRatio.toFixed(3)}, ngramSim=${ngramSim.toFixed(3)}（幅度正常，不 flag）`;

  return {
    rangeCheck: {
      lengthRatio,
      ngramSimilarity: ngramSim,
      flagged,
      note,
    },
  };
}

/**
 * 空 L1 report（graceful 降级用——computeRevisionGuardL1 throw 时 caller 兜底）。
 *
 * mirror stylometry 降级：L1 失败不崩链，空 report = 不 flag，L2 仍跑（纯语义判，无幅度 hint）。
 */
export function emptyRevisionGuardL1Report(): RevisionGuardL1Report {
  return {
    rangeCheck: {
      lengthRatio: 1,
      ngramSimilarity: 1,
      flagged: false,
      note: 'L1 compute failed → 空 report（降级，L2 纯语义判无幅度 hint）',
    },
  };
}
