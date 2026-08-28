/**
 * Story 7.5：词级 diff（token 序列 LCS 对齐）。
 *
 * 配合 `tokenize.ts`：两行 prose 各自 tokenize 成 Token[] 后，做最长公共子序列（LCS）对齐，
 * 产出 `{equal, add, remove}` 的 TokenDiff[]，渲染层据 kind 染色（GitHub 式行内红绿）。
 *
 * **为什么词级用 LCS 而行级保留贪心**（design §1.2）：词级在单行内（token 数有限，几十量级），
 * LCS O(n·m) 完全可承受且产最优对齐；行级是整章（行数大）用贪心是性能妥协。两层输入规模差
 * 几个数量级，算法选择不同是合理的。
 *
 * 范式判据（ADR-3）：LCS 对齐 = 纯机械序列运算、不理解意义 → 纯代码。
 */

import { tokenize } from './tokenize';
import type { Token } from './tokenize';

/** 行内 token 级 diff 段（驱动渲染：equal=不变文本、add=新增词绿、remove=删除词红）。 */
export type TokenDiff = {
  kind: 'equal' | 'add' | 'remove';
  token: Token;
};

/**
 * CJK 成对块字符级细化的长度闸（BMad CR Blind-002 / Edge-002）。任一侧 CJK 串超此长度则跳过细化，
 * 回退整块换（防 (n·m) DP 表爆内存——256²×8B ≈ 524KB 上限安全）。典型标点切分 run ~6-30 字远低于此。
 */
const REFINE_CJK_MAX_LEN = 256;

/**
 * 两 token 序列做 LCS → TokenDiff[]。
 *
 * 标准 DP：`dp[i][j]` = oldTokens[0..i) 与 newTokens[0..j) 的 LCS 长度。回溯产出
 * equal（两序列都走且 token.text 相同）/ remove（只走 old）/ add（只走 new）。
 *
 * Token 相等判定 = `text` 严格相等（kind 隐含在 text 里，无需额外比）。空白 token 也参与对齐
 * （连续空格差异应可视化——但渲染层可把 space 的 add/remove 淡化处理，见 SideBySideDiff）。
 *
 * @param oldTokens  改前行 tokenize 结果。
 * @param newTokens  改后行 tokenize 结果。
 * @returns          按文本顺序合并的 TokenDiff[]（相邻同 kind 已合并方便渲染）。
 */
export function diffTokens(oldTokens: Token[], newTokens: Token[]): TokenDiff[] {
  const n = oldTokens.length;
  const m = newTokens.length;

  // 边界：一侧空 → 全 remove / 全 add。
  if (n === 0 && m === 0) return [];
  if (n === 0) return newTokens.map((token) => ({ kind: 'add', token }));
  if (m === 0) return oldTokens.map((token) => ({ kind: 'remove', token }));

  // DP 表（n+1 × m+1），用 Int 数组省内存。
  const dp: number[] = new Array((n + 1) * (m + 1)).fill(0);
  const idx = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldTokens[i].text === newTokens[j].text) {
        dp[idx(i, j)] = dp[idx(i + 1, j + 1)] + 1;
      } else {
        dp[idx(i, j)] = Math.max(dp[idx(i + 1, j)], dp[idx(i, j + 1)]);
      }
    }
  }

  // 回溯产出 TokenDiff[]。
  const raw: TokenDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTokens[i].text === newTokens[j].text) {
      raw.push({ kind: 'equal', token: oldTokens[i] });
      i++;
      j++;
    } else if (dp[idx(i + 1, j)] >= dp[idx(i, j + 1)]) {
      raw.push({ kind: 'remove', token: oldTokens[i] });
      i++;
    } else {
      raw.push({ kind: 'add', token: newTokens[j] });
      j++;
    }
  }
  while (i < n) {
    raw.push({ kind: 'remove', token: oldTokens[i] });
    i++;
  }
  while (j < m) {
    raw.push({ kind: 'add', token: newTokens[j] });
    j++;
  }

  return raw;
}

/**
 * 便利：两行原始文本 → tokenize → LCS → refineCJK → TokenDiff[]（行内词级 diff 一步到位）。
 *
 * 供 SideBySideDiff 在成对的 changed 行（remove 行 + add 行）上调用。
 */
export function diffLineWords(oldLine: string, newLine: string): TokenDiff[] {
  return refineCjkPairs(diffTokens(tokenize(oldLine), tokenize(newLine)));
}

/**
 * Story 7.5 质量：CJK 成对块的字符级细化。
 *
 * 背景：CJK 整串切下，「她死死盯着」与「她紧紧盯着」是两个**不可分割的 cjk token**，token 级 LCS
 * 无法切出公共子串 → 整块换（remove 整串 + add 整串）。但「她」「盯着」两串相同，整块红绿反而
 * 掩盖了真正改动（死死/紧紧），削弱「一眼看出」核心诉求。
 *
 * 修法：扫描 diffTokens 产出，遇到**相邻的 remove(cjk)+add(cjk) 对**（或 add+remove），对两个 CJK
 * 串**内部**做字符级 LCS，把相同的字（她/盯着）标为 equal、不同的字（死死/紧紧）标 remove/add。
 *
 * 范式：CJK 串内字符级 LCS = 纯机械序列运算，延续 Closure 字符级中文处理范式（revision-guard-l1
 * 3-gram / passage-splice bigram 同源）。仍不引依赖、不判语义（「死死」是不是一个词」归分词，不做）。
 *
 * 边界：
 * - 配对的两串完全不同（无公共字）→ 字符级 LCS 仍产整块换，与未细化等价（无害）。
 * - 只在 cjk kind 上细化（英文 word 已是合理粒度，标点单字符无需细化）。
 * - 单字 cjk 串（如「她」vs「他」）→ 字符级即单字 diff，自然处理。
 */
export function refineCjkPairs(diffs: TokenDiff[]): TokenDiff[] {
  if (diffs.length < 2) return diffs;
  const out: TokenDiff[] = [];
  let i = 0;
  while (i < diffs.length) {
    const cur = diffs[i];
    const next = diffs[i + 1];
    // remove(cjk) 紧跟 add(cjk)。
    if (cur && next && cur.kind === 'remove' && next.kind === 'add'
      && cur.token.kind === 'cjk' && next.token.kind === 'cjk') {
      out.push(...diffCjkChars(cur.token.text, next.token.text));
      i += 2;
      continue;
    }
    // add(cjk) 紧跟 remove(cjk)（顺序倒置，LCS 回溯可能产出）。
    // refineCjkPairs 已把对侧文本按 old/new 语义顺序传入 diffCjkChars，输出 remove=旧字/add=新字
    // 的语义顺序恒定；渲染层 renderWordDiff 按 kind（非位置）取 left/right，无需视觉顺序重排。
    if (cur && next && cur.kind === 'add' && next.kind === 'remove'
      && cur.token.kind === 'cjk' && next.token.kind === 'cjk') {
      out.push(...diffCjkChars(next.token.text, cur.token.text));
      i += 2;
      continue;
    }
    out.push(cur);
    i++;
  }
  return out;
}

/**
 * 两个 CJK 字符串做字符级 LCS → TokenDiff[]（每 token = 单字，kind='cjk'）。
 *
 * 调用方（refineCjkPairs）负责按 old/new 语义顺序传入：第一参数恒为改前串、第二参数恒为改后串。
 * 故输出始终是 remove（旧字）在前、add（新字）在后的语义顺序，不依赖输入 diff 的位置顺序。
 * 渲染层 renderWordDiff 按 kind 取 left/right 列，无需视觉顺序重排。
 *
 * 🔑 BMad CR（Blind-002 / Edge-002 两独立 reviewer 确认）：字符级 LCS 分配 (n+1)·(m+1) DP 表，
 * 对千级无标点 CJK run（古文 / AI 生成连写 / 人名罗列 / 咒文长段）会爆内存（5000² ≈ 190MB）+ 冻结
 * renderer。**长度闸**：任一侧超 REFINE_CJK_MAX_LEN 则跳过细化，回退整块换（remove 整串 + add 整串），
 * 与未细化等价（仅精度降级，非错误——refineCjkPairs 入口注释已说明「无害」）。256²×8B = 524KB 上限安全。
 *
 * @param oldText 改前 CJK 串。
 * @param newText 改后 CJK 串。
 */
function diffCjkChars(oldText: string, newText: string): TokenDiff[] {
  // 长度闸（BMad CR）：超长 CJK 串跳过字符级细化，回退整块换，防爆内存/冻结。
  if (oldText.length > REFINE_CJK_MAX_LEN || newText.length > REFINE_CJK_MAX_LEN) {
    return [
      { kind: 'remove', token: { text: oldText, kind: 'cjk' } },
      { kind: 'add', token: { text: newText, kind: 'cjk' } },
    ];
  }
  const oldChars = [...oldText];
  const newChars = [...newText];
  // 复用 diffTokens 的 LCS（把每字当独立 token，kind='cjk'）。
  const oldTokens: Token[] = oldChars.map((text) => ({ text, kind: 'cjk' as const }));
  const newTokens: Token[] = newChars.map((text) => ({ text, kind: 'cjk' as const }));
  const charDiff = diffTokens(oldTokens, newTokens);
  // 合并相邻同 kind（「死死」两字 remove 合成一个 span，渲染干净）。
  const merged: TokenDiff[] = [];
  for (const d of charDiff) {
    const last = merged[merged.length - 1];
    if (last && last.kind === d.kind) {
      last.token = { text: last.token.text + d.token.text, kind: 'cjk' };
    } else {
      merged.push({ kind: d.kind, token: { text: d.token.text, kind: 'cjk' } });
    }
  }
  return merged;
}
