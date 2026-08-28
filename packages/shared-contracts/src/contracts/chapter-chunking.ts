import type { ChapterChunk } from './closure-retrieval';
import { CHUNK_FLOOR_CHARS, CHUNK_MAX_CHARS, CHUNK_TARGET_CHARS } from './closure-retrieval';

// ── Story 8.3 S2：章正文语义分块器（纯函数，design §2.1 / prd Requirements 1 红线）──
//
// 把一章 markdown 正文切成一组互不重叠、按序全覆盖的检索 chunk。分块红线（用户钉）：**必须按
// 语义切、不能固定窗口硬切、最好按段落分**——本模块的一切切分决策都落在段落边界或句读边界上，
// 唯一例外是「单句自身超上限」的极窄路（中文句读也切不开），按上限字符硬切并在 chunk 上标
// `degenerate:true`（诚实标注，不静默）。
//
// 证据带（research/semantic-chunking-survey-2026-08-20.md）：叙事语料上结构边界（段落递归 87.86）
// 显著优于 embedding 断点式 semantic chunking（71.45 垫底）——段落聚合正是实证背书的路线；叙事
// QA 偏大块（350-450 字证据带）；floor/soft-cap 双参数是 docling/lsfusion 工程先例；无 overlap 由
// parent 返回承担上下文延续。尺寸常量（S1 `closure-retrieval.ts`）是证据带锚点非中文实测——
// dogfood 校准点，压测只证结构不证质量。
//
// 入参按调用方给的字符串原样处理（含 BOM/CRLF 时偏移与该字符串一一对应）；读取侧的 BOM-strip/
// 行尾归一归调用方（S3 索引器，mirror craftMd/setting-md 读取惯例）。
//
// expected_downstream_consumers:
// - shell S3 索引器 reindexChapter / rebuildChapterChunks（chapters/*.md → closure_entry 章源行）。
// - shell S6 压测 fixture（retrievalScale.test.ts 合成 400 章的分块基准）。

/** 转场标记（markdown 水平分隔线）：同一字符（`-` `*` `_` 之一）出现 3+ 次、允许夹空格、独占一段。 */
const THEMATIC_BREAK_RE = /^([-_*])(?:[ \t]*\1){2,}$/;

/** 中文句读（句末/半句末标点 + 引文收尾，design §2.1 第 4 条）。 */
const SENTENCE_ENDERS = new Set(['。', '！', '？', '…', '；', '」', '』']);

/** 引文收尾符：不算句末——后面常跟「他说/他问」类叙述，句子要延续到下一个句读。 */
const CLOSING_QUOTES = new Set(['」', '』']);

/** 引文开头符：收尾引号后紧跟新引文 = 一来一回的回合边界，可切。 */
const OPENING_QUOTES = new Set(['「', '『']);

interface SourceBlock {
  /** 段落在原文中的字符区间 [start, end)——两端收到首个/末个非空白字符。 */
  start: number;
  end: number;
  /** 整段就是水平分隔线（转场标记）——硬边界，不进任何 chunk 内容。 */
  isMarker: boolean;
}

interface TextSpan {
  start: number;
  end: number;
}

interface ChunkSpan extends TextSpan {
  paraStart: number;
  paraEnd: number;
  degenerate?: boolean;
}

function isWsCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0b || code === 0x0c || code === 0x0d;
}

/**
 * 按空行把正文切成段落块（markdown 惯例：空白行分界）。段落 = 连续非空行组成的块——块内
 * 换行保留（多行段/对话行随段落走）。整段单行且匹配水平分隔线 = 转场标记（`isMarker`）。
 */
function splitBlocks(text: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  const len = text.length;
  let runStart = -1; // 进行中块的起点（首个非空白字符偏移）；-1 = 无进行中块
  let runEnd = -1; // 进行中块的终点（末个非空白字符之后）

  const flush = () => {
    if (runStart >= 0) {
      const body = text.slice(runStart, runEnd);
      blocks.push({
        start: runStart,
        end: runEnd,
        // 单行且整段就是分隔线才算转场标记；多行块 / 正文混排的 --- 行按保守正文处理
        isMarker: !body.includes('\n') && THEMATIC_BREAK_RE.test(body),
      });
      runStart = -1;
      runEnd = -1;
    }
  };

  let lineStart = 0;
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? len : nl;
    let s = lineStart;
    while (s < lineEnd && isWsCode(text.charCodeAt(s))) s++;
    if (s >= lineEnd) {
      flush(); // 空白行 = 段落分界
    } else {
      let e = lineEnd;
      while (e > s && isWsCode(text.charCodeAt(e - 1))) e--;
      if (runStart < 0) runStart = s;
      runEnd = e;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  flush();
  return blocks;
}

/**
 * 把一个超长段按中文句读切句（句子完整优先，绝不字符硬切）。连续句读（。……」）视为一个收尾，
 * 切点在整串之后；收尾若是引文收尾符且后面跟着叙述（他说/他问）则句子延续——引文与其归属
 * 叙述不被拆开，只有下一回合（新引文开头）或段末才是边界（对话不腰斩）。
 */
function splitSentences(text: string, para: SourceBlock): TextSpan[] {
  const sentences: TextSpan[] = [];
  let start = para.start;
  let i = para.start;
  while (i < para.end) {
    if (SENTENCE_ENDERS.has(text[i])) {
      let j = i + 1;
      while (j < para.end && SENTENCE_ENDERS.has(text[j])) j++;
      const endsWithClosingQuote = j > i && CLOSING_QUOTES.has(text[j - 1]);
      const nextOpensQuote = j < para.end && OPENING_QUOTES.has(text[j]);
      if (endsWithClosingQuote && !nextOpensQuote && j < para.end) {
        i = j; // 引文收尾 + 后跟归属叙述：句子延续到下一个句读
        continue;
      }
      sentences.push({ start, end: j });
      start = j;
      while (start < para.end && isWsCode(text.charCodeAt(start))) start++;
      i = start;
    } else {
      i++;
    }
  }
  if (start < para.end) sentences.push({ start, end: para.end });
  return sentences;
}

/**
 * 超长段递归降级：段内切句后按同一贪心规则（target/max）聚合，产出的 chunk 都落在句读边界、
 * 共享该段的段落区间。单句自身仍超上限（句读也切不开）才按上限字符硬切，标 `degenerate:true`。
 */
function emitSentenceChunks(text: string, para: SourceBlock, paraIdx: number, out: ChunkSpan[]): void {
  let cur: TextSpan | null = null;
  const closeCur = () => {
    if (cur) {
      out.push({ start: cur.start, end: cur.end, paraStart: paraIdx, paraEnd: paraIdx + 1 });
      cur = null;
    }
  };

  for (const sent of splitSentences(text, para)) {
    if (sent.end - sent.start > CHUNK_MAX_CHARS) {
      // 极窄路：单句超上限，句读切不开——按上限字符硬切 + degenerate 诚实标注
      closeCur();
      for (let p = sent.start; p < sent.end; p += CHUNK_MAX_CHARS) {
        const end = Math.min(p + CHUNK_MAX_CHARS, sent.end);
        out.push({ start: p, end, paraStart: paraIdx, paraEnd: paraIdx + 1, degenerate: true });
      }
      continue;
    }
    if (cur && sent.end - cur.start > CHUNK_MAX_CHARS) closeCur();
    if (cur) cur.end = sent.end;
    else cur = { start: sent.start, end: sent.end };
    if (cur.end - cur.start >= CHUNK_TARGET_CHARS) closeCur();
  }
  closeCur();
}

/**
 * 单个 stretch（转场标记之间的段序列）的贪心聚合。长度按「首段起点到末段终点」的原文切片计
 * （含段间空白——被索引文本的真实尺寸）。尾块低于 floor 并入前块（并入后允许超上限——floor
 * 优先于 max，docling/lsfusion 防碎片先例）；首块无前块可并，保持原样。不跨转场标记（调用方
 * 已按标记切 stretch）。
 */
function chunkStretch(text: string, paras: readonly SourceBlock[], paraBase: number): ChunkSpan[] {
  const spans: ChunkSpan[] = [];
  let cur: ChunkSpan | null = null;
  const closeCur = () => {
    if (cur) {
      spans.push(cur);
      cur = null;
    }
  };

  for (let i = 0; i < paras.length; i++) {
    const para = paras[i];
    const paraIdx = paraBase + i;
    if (para.end - para.start > CHUNK_MAX_CHARS) {
      closeCur(); // 超长段不与邻段聚合（自身已超上限），独立走句读降级
      emitSentenceChunks(text, para, paraIdx, spans);
      continue;
    }
    if (cur && para.end - cur.start > CHUNK_MAX_CHARS) closeCur(); // 并入会超上限：开新块
    if (cur) {
      cur.end = para.end;
      cur.paraEnd = paraIdx + 1;
    } else {
      cur = { start: para.start, end: para.end, paraStart: paraIdx, paraEnd: paraIdx + 1 };
    }
    if (cur.end - cur.start >= CHUNK_TARGET_CHARS) closeCur(); // 到达目标尺寸：收块
  }
  closeCur();

  if (spans.length >= 2) {
    const last = spans[spans.length - 1];
    if (last.end - last.start < CHUNK_FLOOR_CHARS) {
      const prev = spans[spans.length - 2];
      prev.end = last.end;
      prev.paraEnd = last.paraEnd;
      if (last.degenerate) prev.degenerate = true;
      spans.pop();
    }
  }
  return spans;
}

/**
 * `chunkChapter` 的可选入参（章元数据位，design §2.1 输入形状）。
 *
 * - `synopsis`：章梗概。**当前不影响分块决策**——chunk 的 span/text 只由正文段落结构决定；
 *   梗概是索引组料（`buildChunkIndexText` 单源消费），不是切分依据。选项位保留给调用方传章
 *   元数据的稳定形状；若 dogfood 校准后要求「正文+梗概合计控长」，扩此处而不动调用面。
 */
export interface ChapterChunkOptions {
  synopsis?: string;
}

/**
 * 把一章 markdown 正文切成检索用 chunk（段落原子 + 贪心聚合，语义分块红线落地）。
 *
 * 切法（design §2.1，证据带见模块头）：
 * 1. **段落原子**：按空行切段落，段落是最小不可分割单位——段落级 chunk 边界永远不落段中。
 * 2. **转场标记硬边界**：整段就是水平分隔线（`---`/`***`/`___`/`* * *` 等）= 作者显式标记的
 *    转场——聚合绝不跨标记，标记行不进任何 chunk。中文破折号「——」不是标记。
 * 3. **贪心聚合**：段序列按序聚合到 `CHUNK_TARGET_CHARS`（到目标即收块）；并入下一段会超
 *    `CHUNK_MAX_CHARS` 时开新块；收尾块低于 `CHUNK_FLOOR_CHARS` 时并入前块（并入后允许超
 *    上限——floor 优先于 max）。
 * 4. **超长段递归降级**：单段超上限时按中文句读（。！？…；」』）切句再贪心聚合，句子完整
 *    优先；切点不落在一来一回对话中间（引文与其归属叙述同句、回合边界才切）。单句自身仍超
 *    上限（句读也切不开的极窄路）才按上限字符硬切，该 chunk 标 `degenerate:true`。
 * 5. **无 overlap**：chunk 互不重叠、按序全覆盖。
 *
 * 输出保证：`chunk.text === text.slice(chunk.charStart, chunk.charEnd)`（原文逐字切片）；
 * span 均为半开 [start, end)；段落序只数正文段落（转场标记行不占号——「第 a-b 段」按正文段
 * 计）；同输入同输出（确定性，无 Date/random）；空章/纯标记章/纯空白章 → `[]`（零 chunk
 * 合法）。
 */
export function chunkChapter(text: string, opts?: ChapterChunkOptions): ChapterChunk[] {
  const chunks: ChapterChunk[] = [];
  let stretch: SourceBlock[] = [];
  let paraBase = 0;
  let index = 0;

  const flushStretch = () => {
    if (stretch.length === 0) return;
    for (const span of chunkStretch(text, stretch, paraBase)) {
      const chunk: ChapterChunk = {
        index: index++,
        paraStart: span.paraStart,
        paraEnd: span.paraEnd,
        charStart: span.start,
        charEnd: span.end,
        text: text.slice(span.start, span.end),
      };
      if (span.degenerate) chunk.degenerate = true; // 二态：正常 chunk 无此键
      chunks.push(chunk);
    }
    paraBase += stretch.length;
    stretch = [];
  };

  for (const block of splitBlocks(text)) {
    if (block.isMarker) {
      flushStretch(); // 转场标记 = 硬边界
      continue;
    }
    stretch.push(block);
  }
  flushStretch();
  return chunks;
}

/**
 * chunk 索引组料（design §2.1 contextual prefix——Anthropic contextual retrieval 的零 LLM
 * 成本变体：Closure 每章 synopsis 复用到全章 chunk，embed/FTS 双臂看「梗概+正文」，返回呈现
 * 给原文）。梗概是既有产物（8.7 章摘要 synopsis），纯代码不合成——缺失就退化，零编造。
 *
 * - synopsis 非空白 → `[梗概：{synopsis}]\n{chunkText}`（synopsis trim 后使用——组料规范化，
 *   chunkText 原文不动）。
 * - synopsis 缺失/空白 → chunkText 原样（prefix 退化空，不造章号章名——组料依赖面最小化：
 *   章名/章序变更不触发全章重嵌，design 复审缺漏 #3）。
 */
export function buildChunkIndexText(chunkText: string, synopsis?: string): string {
  const trimmed = synopsis === undefined ? '' : synopsis.trim();
  if (!trimmed) return chunkText;
  return `[梗概：${trimmed}]\n${chunkText}`;
}
