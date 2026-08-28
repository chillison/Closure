/**
 * Story 7.5：词级 diff 的 token 化（CJK 整串 + 英文按空格/标点切）。
 *
 * 纯函数，零依赖。延续 Closure 字符级中文处理范式（revision-guard-l1 3-gram / passage-splice
 * bigram 同源），但为「一眼看出改了什么」的可视化目标，**把连续 CJK 字符聚成一个可视单元**
 * （非逐字符、非分词——不分词 = 不判「这是不是一个词」，纯机械聚合，守 ADR-3 不碰语义）。
 *
 * 范式判据（ADR-3 / [[feedback-semantic-llm-nonsemantic-purecode]]）：tokenization = 机械切分、
 * 不理解意义 → 纯代码。漂移裁判已在 7.2 归 LLM revision-guard，本模块只服务于渲染层 highlight。
 *
 * 切分规则（design §2.1）：
 * - `cjk`   连续 `\p{Script=Han}`（中日韩统一表意文字 + 兼容）当一个 token。中文无词间空格，
 *           GitHub 原版 word-diff 按空格切对中文失效；整串聚合让「死死」vs「紧紧」产整块红绿
 *           （非逐字碎块），一眼可读。整段全改 → 整段一个 cjk 块全红绿（设计意图，视觉正确）。
 * - `word`  连续 ASCII 字母/数字（`[A-Za-z0-9]`）当一个 token（英文单词/数字，GitHub 原版行为）。
 * - `space` 连续空白当一个 token（保留，LCS 对齐用——空格差异也需可视化）。
 * - `punct` 单个标点/符号一个 token（中英文标点）。
 * - `other` 兜底单字符（罕见表意文字扩展/emoji 等）。
 */

/** Token 可视化类别（驱动渲染 + CSS class）。 */
export type TokenKind = 'cjk' | 'word' | 'space' | 'punct' | 'other';

/** 一个 token = 一段文本 + 类别。 */
export type Token = {
  text: string;
  kind: TokenKind;
};

// CJK 统一表意文字 + 扩展 A/B/C/D/E/F/G/H/I（`\p{Script=Han}` + `u` flag 覆盖**全部** Han 含扩展区，
// 罕用字亦正确归 cjk，整个代理对作一个 token——BMad CR Edge-005 实测订正：原注释误称扩展区落 other）。
const CJK_RUN = /\p{Script=Han}+/u;
const WORD_RUN = /[A-Za-z0-9]+/;
const SPACE_RUN = /\s+/;

/**
 * 判断单个码点的 token 类别（用于 `other`/`punct` 兜底）。
 * 标点/符号 = Unicode 类别 P（Punctuation）或 S（Symbol）。其余非 cjk/word/space 归 other。
 */
function classifyCodePoint(ch: string): TokenKind {
  // 用扩展正则的零宽断言查单字符的 Unicode 类别。
  if (/^\p{Script=Han}$/u.test(ch)) return 'cjk';
  if (/^[A-Za-z0-9]$/.test(ch)) return 'word';
  if (/^\s$/.test(ch)) return 'space';
  if (/^[\p{P}\p{S}]$/u.test(ch)) return 'punct';
  return 'other';
}

/**
 * 把文本切成 Token[]。
 *
 * 贪心单遍扫描：在每个位置尝试匹配最长 run（cjk → word → space），不匹配则取单字符按类别归
 * punct/other。O(n) 复杂度。空串返回 []。
 *
 * @param text 原始文本（一段 prose，可能含中英文混排）。
 * @returns    Token 数组，拼接其 text 恢复原文本（lossless）。
 */
export function tokenize(text: string): Token[] {
  if (!text) return [];
  const tokens: Token[] = [];
  let i = 0;
  // 用 sticky 正则（y flag）从指定位置匹配，避免反复 slice 子串。
  const cjkRe = new RegExp(CJK_RUN.source, 'uy');
  const wordRe = new RegExp(WORD_RUN.source, 'y');
  const spaceRe = new RegExp(SPACE_RUN.source, 'y');

  while (i < text.length) {
    cjkRe.lastIndex = i;
    const cjk = cjkRe.exec(text);
    if (cjk && cjk.index === i && cjk[0]) {
      tokens.push({ text: cjk[0], kind: 'cjk' });
      i += cjk[0].length;
      continue;
    }
    wordRe.lastIndex = i;
    const word = wordRe.exec(text);
    if (word && word.index === i && word[0]) {
      tokens.push({ text: word[0], kind: 'word' });
      i += word[0].length;
      continue;
    }
    spaceRe.lastIndex = i;
    const space = spaceRe.exec(text);
    if (space && space.index === i && space[0]) {
      tokens.push({ text: space[0], kind: 'space' });
      i += space[0].length;
      continue;
    }
    // 兜底：单字符按类别（punct / other）。🔑 BMad CR Edge-001：用码点迭代（非 text[i] 码元索引），
    // 代理对字符（emoji / 非 BMP 符号 U+1F000+）作一个完整 token，否则高/低代理各被拆成一个 'other'
    // token → partial diff 时 emoji 被劈成两个 span 渲染（背景/删除线错位）。
    const codePoint = text.codePointAt(i);
    if (codePoint == null) break;
    const ch = String.fromCodePoint(codePoint);
    tokens.push({ text: ch, kind: classifyCodePoint(ch) });
    // 代理对占 2 个 UTF-16 码元，advance 2；否则 1。
    i += ch.length;
  }
  return tokens;
}
