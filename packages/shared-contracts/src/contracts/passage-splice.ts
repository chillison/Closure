import type { SelectionAnchor } from './attachment';

// ── Story 7.1：段落级改稿 splice 定位（Route 1，design §3.2）──
//
// draft-writer 输出改后段落（passageText）后，节点须把它 splice 回完整 draft.initial.text：
// 经 SelectionAnchor（quote + prefix/suffix 消歧 + rangeHint 邻近 + dice 兜底）定位原段在 draft 中
// 的位置 → 替换 → 写回完整 text。下游 5+ 消费者（summarizeRunSnapshot / buildChapterAccept /
// Reader-Audit / completeness-verify / story-sync）全读完整 splice 后 text，**不感知段落级**。
//
// 🔑 纯代码机械（ADR-3 / creative-vs-mechanical）：定位 + 字符串替换 = 不理解意义，归纯代码。选区
// 锚点在编辑时捕获（quote 精确 + prefix/suffix 消歧 + rangeHint 邻近 hint），捕获后 draft 可能漂移
// （中间被改），故须多路径定位 + graceful 失败。
//
// mirror ui `agentDiffSlice.ts` locatePassage/scoreOccurrence/diceSimilarity/findExactOccurrenceRanges
// 逻辑（既有，已验证），但 scope 收窄为「SelectionAnchor 定位 + splice」（非 ui 的段落候选/整章重写
// 模糊逻辑——那是 ui passage-diff 专用，7.1 不需）。ui agentDiffSlice 保持不动（其用例独立）。
//
// expected_downstream_consumers:
// - Story 7.1 Step 3：draft-writer 节点 parseOutput 调 locateAndSplicePassage splice 回整章。
// - 未来 7.5 词级 diff：splice 边界可复用作 diff 锚点。

/**
 * Dice coefficient on character bigrams（mirror agentDiffSlice.diceSimilarity）。
 *
 * 廉价模糊相似度，用于 quote 精确匹配失败时的兜底（draft 漂移致 quote 微变）。中文按字符 bigram。
 */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let overlap = 0;
  for (const [g, count] of ba) {
    const other = bb.get(g);
    if (other) overlap += Math.min(count, other);
  }
  const total = a.length - 1 + (b.length - 1);
  return total > 0 ? (2 * overlap) / total : 0;
}

/** Character bigrams 计数（mirror agentDiffSlice.bigrams）。 */
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/**
 * splice 定位结果。
 * - `unique`：唯一匹配（精确匹配唯一 OR 多精确匹配经 anchor 消歧出 clear winner），from/to 为原段范围。
 * - `ambiguous`：多个候选无法消歧（quote 在 draft 多处出现且 prefix/suffix 不分胜负）——caller 须 graceful。
 * - `not-found`：quote 在 draft 中找不到（draft 中间被大改 / 选区漂移）——caller 须 graceful。
 */
export type LocateResult =
  | { status: 'unique'; from: number; to: number }
  | { status: 'ambiguous'; candidates: { from: number; to: number }[] }
  | { status: 'not-found' };

/**
 * 在 content 中定位所有 needle 的精确出现范围（mirror agentDiffSlice.findExactOccurrenceRanges）。
 */
function findExactOccurrenceRanges(haystack: string, needle: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push({ from: idx, to: idx + needle.length });
    from = idx + 1;
  }
  return out;
}

/**
 * 经 anchor context（prefix/suffix）+ rangeHint 邻近给候选打分（mirror agentDiffSlice.scoreOccurrence）。
 *
 * 精确 prefix/suffix 匹配 +2 各；不精确走 dice 兜底（微漂容错）；邻近 rangeHint.from 越近分越高（小 tie-breaker）。
 */
function scoreOccurrence(content: string, idx: number, len: number, anchor?: SelectionAnchor): number {
  if (!anchor) return 0;
  let score = 0;
  if (anchor.prefix) {
    const before = content.slice(Math.max(0, idx - anchor.prefix.length), idx);
    if (before.endsWith(anchor.prefix)) score += 2;
    else score += diceSimilarity(before, anchor.prefix);
  }
  if (anchor.suffix) {
    const after = content.slice(idx + len, idx + len + anchor.suffix.length);
    if (after.startsWith(anchor.suffix)) score += 2;
    else score += diceSimilarity(after, anchor.suffix);
  }
  const drift = Math.abs(idx - anchor.rangeHint.from);
  score += 1 / (1 + drift / 100);
  return score;
}

/**
 * 经 SelectionAnchor 在 content 中定位选段（design §3.2 splice 第一步）。
 *
 * 流程（mirror agentDiffSlice.locatePassage 哲学，scope 收窄为 anchor 定位）：
 *  1. quote 精确匹配：唯一 → unique；多个 → 经 anchor.scoreOccurrence 消歧（clear winner → unique，否则 ambiguous）。
 *  2. quote 精确全失败 → not-found（caller graceful；不做 ui 的整章重写/段落候选模糊——7.1 scope 外，
 *     且 7.1 anchor 在编辑时捕获精度高，draft 漂移概率低于 ui passage-diff 场景）。
 *
 * @param content 完整 draft.initial.text（splice 目标）。
 * @param anchor  选区锚点（quote 精确匹配 key + prefix/suffix 消歧 + rangeHint 邻近）。
 */
export function locateSelection(content: string, anchor: SelectionAnchor): LocateResult {
  const occurrences = findExactOccurrenceRanges(content, anchor.quote);
  if (occurrences.length === 1) {
    return { status: 'unique', from: occurrences[0].from, to: occurrences[0].to };
  }
  if (occurrences.length > 1) {
    // 多精确匹配 → anchor 消歧（prefix/suffix + rangeHint 打分）。
    const scored = occurrences
      .map((o) => ({ o, score: scoreOccurrence(content, o.from, o.to - o.from, anchor) }))
      .sort((a, b) => b.score - a.score);
    // clear winner（最高分严格 > 次高分，且差距 > 0.5 避免微弱领先误判）→ unique。
    // BMad CR F9：删 unreachable `scored.length === 1`（本分支 occurrences.length > 1，scored 等长必 > 1）。
    if (scored.length >= 2 && scored[0].score - scored[1].score > 0.5) {
      return { status: 'unique', from: scored[0].o.from, to: scored[0].o.to };
    }
    return { status: 'ambiguous', candidates: occurrences };
  }
  // quote 精确匹配全失败 → not-found。draft 中间被大改 / 选区漂移，caller graceful。
  return { status: 'not-found' };
}

/**
 * splice 结果。
 * - `spliced`：splice 成功，text = splice 后的完整正文。
 * - `locate-failed`：定位失败（ambiguous/not-found），caller graceful（保留原 draft + flag 重选）。
 */
export type SpliceResult =
  | { status: 'spliced'; text: string }
  | { status: 'locate-failed'; reason: 'ambiguous' | 'not-found' };

/**
 * 把改后段落 splice 回完整 draft 正文（design §3.2 splice 第二步）。
 *
 * @param fullDraft   splice 前完整 draft.initial.text。
 * @param anchor      选区锚点（定位原段）。
 * @param passageText 改后段落（draft-writer 输出，替原段）。
 * @returns           spliced（完整 text 原段被换）OR locate-failed（caller graceful）。
 */
export function splicePassage(
  fullDraft: string,
  anchor: SelectionAnchor,
  passageText: string,
): SpliceResult {
  const located = locateSelection(fullDraft, anchor);
  if (located.status !== 'unique') {
    return { status: 'locate-failed', reason: located.status };
  }
  const text = fullDraft.slice(0, located.from) + passageText + fullDraft.slice(located.to);
  return { status: 'spliced', text };
}

// ── Story 7.1 BMad CR F2：纯代码构造 SelectionAnchor（IPC 层用，非 LLM 产）──
//
// 🔑 范式订正（feedback-semantic-llm-nonsemantic-purecode）：anchor 构造是非语义机械活（quote=选中文本 /
// prefix=前文切片 / suffix=后文切片 / rangeHint=编辑器位置），归纯代码。原 design 让 revision-optimizer
// LLM 产 anchor，但 LLM 无 draft body / ProseMirror 位置 → hallucinate 空 prefix/suffix → 重复 quote 永远
// ambiguous（blind-002/edge-002）。F2 订正：UI 选区时已有 {text, from, to} + draft 正文，IPC 用本函数
// 确定性切片构 anchor，LLM 只编译意图（change/locks/rationale）。

/**
 * 纯代码构造 SelectionAnchor（F2，design §3.2 IPC 层用）。
 *
 * @param draftText      整章正文（prefix/suffix 切片源）。
 * @param selectedText   选中文本（= anchor.quote）。
 * @param from           选区起始位置（ProseMirror / 字符 offset，= anchor.rangeHint.from）。
 * @param to             选区结束位置（= anchor.rangeHint.to）。
 * @param contextChars   prefix/suffix 切多少字符（default 50，消歧够用 + 不胀 prompt）。
 * @returns              SelectionAnchor（quote + prefix + suffix + rangeHint）。
 *
 * 确定性字符串切片，零幻觉。prefix = draftText.slice(max(0, from-N), from)，
 * suffix = draftText.slice(to, to+N)，rangeHint = {from, to}（编辑器权威坐标）。
 * locateSelection 用 quote 精确匹配 + prefix/suffix 消歧 + rangeHint 邻近，三重定位。
 */
export function buildSelectionAnchor(
  draftText: string,
  selectedText: string,
  from: number,
  to: number,
  contextChars = 50,
): SelectionAnchor {
  const safeFrom = Math.max(0, Math.min(from, draftText.length));
  const safeTo = Math.max(safeFrom, Math.min(to, draftText.length));
  const prefixStart = Math.max(0, safeFrom - contextChars);
  const prefix = draftText.slice(prefixStart, safeFrom);
  const suffix = draftText.slice(safeTo, Math.min(draftText.length, safeTo + contextChars));
  return {
    quote: selectedText,
    prefix,
    suffix,
    rangeHint: { from: safeFrom, to: safeTo },
  };
}
