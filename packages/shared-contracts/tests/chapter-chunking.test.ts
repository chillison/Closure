import { describe, expect, it } from 'vitest';
import {
  CHUNK_FLOOR_CHARS,
  CHUNK_MAX_CHARS,
  buildChunkIndexText,
  chapterChunkSchema,
  chunkChapter,
} from '../src';
import type { ChapterChunk } from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 S2：章正文语义分块器（chunkChapter / buildChunkIndexText，design §2.1）。
// 分块红线（prd AC-3）：任何 chunk 边界不得落在句中/段中——硬切零容忍（唯一例外 = 单句超上限
// 的 degenerate 极窄路，须诚实标注）。守门断言用独立重扫的段落边界做交叉验证（不复用被测代码
// 的解析器——实现与测试各自解析，对拍才有守门力）。
// ─────────────────────────────────────────────────────────────────────────────

/** 造一句恰好 len 字的中文句（len-1 个填充字 + 句号）——长度精确可控。 */
function sent(len: number): string {
  return '墨'.repeat(len - 1) + '。';
}

/** 造一段无句读的叙述填充段（恰好 len 字）——长度精确可控，用于段落聚合算术。 */
function plain(len: number): string {
  return '雨'.repeat(len);
}

// ── 守门 helper（独立实现，交叉验证）──

const ENDERS = new Set(['。', '！', '？', '…', '；', '」', '』']);
const BREAK_RE = /^([-_*])(?:[ \t]*\1){2,}$/;

/** 独立重扫段落边界：非空行聚块，start = 块首非空白偏移，end = 块末非空白之后。 */
function scanParagraphBoundaries(text: string): { starts: Set<number>; ends: Set<number> } {
  const starts = new Set<number>();
  const ends = new Set<number>();
  let offset = 0;
  let curStart = -1;
  let curEnd = -1;
  const flush = () => {
    if (curStart >= 0) {
      starts.add(curStart);
      ends.add(curEnd);
      curStart = -1;
      curEnd = -1;
    }
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flush();
    } else {
      const leadWs = line.length - line.trimStart().length;
      const trailWs = line.length - line.trimEnd().length;
      if (curStart < 0) curStart = offset + leadWs;
      curEnd = offset + line.length - trailWs;
    }
    offset += line.length + 1;
  }
  flush();
  return { starts, ends };
}

/** 往前跳过空白后的第一个字符（句读判断用）。 */
function prevNonWs(text: string, p: number): string {
  let i = p - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  return i >= 0 ? text[i] : '';
}

/** 缝隙（chunk 之间 / 首尾外侧）只允许空白与转场标记——正文字符零丢失零重复。 */
function isAllowedGap(gap: string): boolean {
  if (gap.trim() === '') return true;
  return gap.split(/\n\s*\n/).every((piece) => piece.trim() === '' || BREAK_RE.test(piece.trim()));
}

/** 红线守门：schema 合法 + 原文逐字保真 + 非 degenerate 边界只落段落边界/句读处。 */
function assertSemanticBoundaries(text: string, chunks: ChapterChunk[]): void {
  const { starts, ends } = scanParagraphBoundaries(text);
  for (const c of chunks) {
    expect(() => chapterChunkSchema.parse(c), `chunk ${c.index} schema 合法`).not.toThrow();
    expect(c.text, `chunk ${c.index} text = slice(charStart, charEnd) 原文保真`).toBe(
      text.slice(c.charStart, c.charEnd),
    );
    if (c.degenerate) continue; // 极窄路硬切：已诚实标注，豁免位置守门
    if (c.charStart > 0) {
      expect(
        starts.has(c.charStart) || ENDERS.has(prevNonWs(text, c.charStart)),
        `chunk ${c.index} 起点 ${c.charStart} 落在段中/句中（硬切零容忍）`,
      ).toBe(true);
    }
    if (c.charEnd < text.length) {
      expect(
        ends.has(c.charEnd) || ENDERS.has(text[c.charEnd - 1]),
        `chunk ${c.index} 终点 ${c.charEnd} 落在段中/句中（硬切零容忍）`,
      ).toBe(true);
    }
  }
}

/** 全覆盖守门：按序无重叠 + 首尾/间隙只允许空白与转场标记。 */
function assertCoverage(text: string, chunks: ChapterChunk[]): void {
  chunks.forEach((c, i) => {
    expect(c.charStart, `chunk ${i} 非空`).toBeLessThan(c.charEnd);
    if (i === 0) return;
    const prev = chunks[i - 1];
    expect(prev.charEnd, `chunk ${i - 1}→${i} 无重叠`).toBeLessThanOrEqual(c.charStart);
    expect(
      isAllowedGap(text.slice(prev.charEnd, c.charStart)),
      `chunk ${i - 1}→${i} 缝隙夹正文：${JSON.stringify(text.slice(prev.charEnd, c.charStart))}`,
    ).toBe(true);
  });
  if (chunks.length > 0) {
    expect(isAllowedGap(text.slice(0, chunks[0].charStart))).toBe(true);
    expect(isAllowedGap(text.slice(chunks[chunks.length - 1].charEnd))).toBe(true);
  }
}

/** 独立数正文段落数（空行切块，剔除整段为水平分隔线的块）。 */
function countContentParas(text: string): number {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '' && !BREAK_RE.test(b)).length;
}

/** 段落覆盖守门：每个正文段落至少落进一个 chunk 的段落区间（超长段多 chunk 共享段号）。 */
function assertParaCoverage(chunks: ChapterChunk[], paraCount: number): void {
  const covered = new Array<number>(paraCount).fill(0);
  for (const c of chunks) {
    expect(c.paraStart).toBeGreaterThanOrEqual(0);
    expect(c.paraStart).toBeLessThan(c.paraEnd);
    expect(c.paraEnd).toBeLessThanOrEqual(paraCount);
    for (let p = c.paraStart; p < c.paraEnd; p++) covered[p] += 1;
  }
  covered.forEach((n, i) => expect(n, `正文段落 ${i} 未被任何 chunk 覆盖`).toBeGreaterThanOrEqual(1));
}

/** 组合守门：每个实质测试都全跑。 */
function checkAll(text: string, chunks: ChapterChunk[]): void {
  assertSemanticBoundaries(text, chunks);
  assertCoverage(text, chunks);
  assertParaCoverage(chunks, countContentParas(text));
}

// ── 集成 fixture：确定性合成 ~2.5k 字章（段落 30-200 分布 + 一个转场标记 + 一个 600 超长段）──

const INTEGRATION_FIXTURE = [
  sent(90) + sent(90), // P0 180
  sent(175) + sent(175), // P1 350
  sent(80), // P2 80
  sent(90) + sent(90), // P3 180
  '---', // 转场标记（不占段落号）
  sent(280) + sent(180) + sent(140), // P4 600 超长段（句读降级）
  sent(30), // P5 30
  sent(100) + sent(100), // P6 200
  sent(75) + sent(75), // P7 150
  sent(60) + sent(60), // P8 120
  sent(175), // P9 175
  sent(40), // P10 40
  sent(85) + sent(85), // P11 170
  sent(90), // P12 90
  sent(65) + sent(65), // P13 130
].join('\n\n');

describe('chunkChapter — 段落贪心聚合（target 到档即收 / max 超限开新块 / floor 尾块并入）', () => {
  it('多段 30-200 字分布贪心聚合：到目标收块、超上限切分（100+120+150 | 160）', () => {
    const text = [plain(100), plain(120), plain(150), plain(160)].join('\n\n');
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(2);
    // 100+120+150 = 372（含两个段间空白）<400 继续聚；+160 → 534>500 开新块
    expect(chunks[0]).toMatchObject({
      index: 0,
      paraStart: 0,
      paraEnd: 3,
      charStart: 0,
      charEnd: 374,
    });
    expect(chunks[0].text).toBe(`${plain(100)}\n\n${plain(120)}\n\n${plain(150)}`);
    expect(chunks[1]).toMatchObject({ index: 1, paraStart: 3, paraEnd: 4, charStart: 376, charEnd: 536 });
    expect(chunks[1].text).toBe(plain(160));
  });

  it('350+80 并块（432 ≤ 500）——够放就并', () => {
    const text = [plain(350), plain(80)].join('\n\n');
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ paraStart: 0, paraEnd: 2, charStart: 0, charEnd: 432 });
    expect(chunks[0].charEnd - chunks[0].charStart).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it('350+180 分块（并入 532 > 500）——超上限不并', () => {
    const text = [plain(350), plain(180)].join('\n\n');
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ paraStart: 0, paraEnd: 1, charStart: 0, charEnd: 350 });
    expect(chunks[1]).toMatchObject({ paraStart: 1, paraEnd: 2, charStart: 352, charEnd: 532 });
  });

  it(`尾段 ${'30'} 字 < floor 并入前块（并入后 512 > 500 允许——floor 优先于 max）`, () => {
    const text = [plain(480), plain(30)].join('\n\n');
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ paraStart: 0, paraEnd: 2, charStart: 0, charEnd: 512 });
    expect(chunks[0].text).toBe(`${plain(480)}\n\n${plain(30)}`);
    expect(chunks[0].charEnd - chunks[0].charStart).toBeGreaterThan(CHUNK_MAX_CHARS); // floor 赢了 max
    expect(30).toBeLessThan(CHUNK_FLOOR_CHARS);
  });

  it('单段自成块不受 floor 影响（无前块可并，保持原样）', () => {
    const text = plain(30);
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ paraStart: 0, paraEnd: 1, charStart: 0, charEnd: 30 });
  });
});

describe('chunkChapter — 转场标记硬边界（聚合不跨标记，标记行不进内容）', () => {
  it.each(['---', '***', '___', '* * *', '- - -'])('标记 %s：两侧段落不并块、标记不进任何 chunk', (marker) => {
    const text = [plain(100), marker, plain(100)].join('\n\n');
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(2); // 无标记时会并成一块（202 ≤ 500）——硬边界生效
    expect(chunks[0].text).toBe(plain(100));
    expect(chunks[1].text).toBe(plain(100));
    expect(chunks[0].paraEnd).toBe(chunks[1].paraStart); // 段落号连续（标记不占号）
    expect(chunks[1].charStart).toBe(100 + 2 + marker.length + 2);
    for (const c of chunks) expect(c.text).not.toContain(marker);
  });

  it('无标记章 = 纯段落聚合（200+200 → 402 一块）', () => {
    const text = [plain(200), plain(200)].join('\n\n');
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ paraStart: 0, paraEnd: 2, charStart: 0, charEnd: 402 });
  });

  it('中文破折号「——」与两连字符「--」不是转场标记（保守按正文段处理）', () => {
    for (const pseudo of ['——', '--']) {
      const text = [plain(100), pseudo, plain(100)].join('\n\n');
      const chunks = chunkChapter(text);
      checkAll(text, chunks);
      expect(chunks).toHaveLength(1); // 三段连聚（206 ≤ 500），伪标记段是正文段
      expect(chunks[0]).toMatchObject({ paraStart: 0, paraEnd: 3 });
      expect(chunks[0].text).toContain(pseudo);
    }
  });

  it('正文段内夹 --- 行（无空行包围）不误判为标记——多行段按保守正文处理', () => {
    const mixed = '他说完了。\n---\n她还没开口。';
    const text = `${mixed}\n\n${plain(100)}`;
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('\n---\n'); // 段内标记行原样保留
  });

  it('首尾标记不产生空块/空 chunk（标记段被跳过，段落号从正文段起算）', () => {
    const text = ['---', plain(100), '***'].join('\n\n');
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ paraStart: 0, paraEnd: 1, charStart: 5, charEnd: 105 });
    expect(chunks[0].text).toBe(plain(100));
  });
});

describe('chunkChapter — 超长段句读递归降级（句子完整优先）', () => {
  it('600 字段按句读切两块（300 | 230+70），每块以句读收尾、段内零缝隙', () => {
    const text = sent(300) + sent(230) + sent(70); // 单段 600 字
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(2);
    // 两块共享同一段落区间（句读块是段内切分），charSpan 段内连续无缝
    expect(chunks[0]).toMatchObject({ paraStart: 0, paraEnd: 1, charStart: 0, charEnd: 300 });
    expect(chunks[1]).toMatchObject({ paraStart: 0, paraEnd: 1, charStart: 300, charEnd: 600 });
    expect(chunks[0].charEnd).toBe(chunks[1].charStart);
    for (const c of chunks) {
      expect(c.text.endsWith('。')).toBe(true); // 句子完整：块以句读边界结束
      expect(c.degenerate).toBeUndefined(); // 句读切得开就不是硬切
    }
  });

  it('单句 1200 字（句读也切不开的极窄路）：按上限硬切 + degenerate 诚实标注', () => {
    const text = '墨'.repeat(1199) + '。'; // 全段一个句子
    const chunks = chunkChapter(text);
    assertCoverage(text, chunks); // degenerate 块仍守覆盖/无重叠；位置守门对其豁免（已标注）
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.charEnd - c.charStart)).toEqual([500, 500, 200]);
    expect(chunks.every((c) => c.degenerate === true)).toBe(true); // 不静默
    expect(chunks.map((c) => c.paraStart)).toEqual([0, 0, 0]);
  });

  it('超长段与前后正常段不互相并入（各归各块）', () => {
    const superlong = sent(300) + sent(230) + sent(70); // 600
    const text = [plain(200), superlong, plain(200)].join('\n\n');
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => [c.paraStart, c.paraEnd])).toEqual([
      [0, 1], // 前段
      [1, 2], // 超长段句读块 1（280+180=460）
      [1, 2], // 超长段句读块 2（140）
      [2, 3], // 后段
    ]);
  });
});

describe('chunkChapter — 对话不腰斩（切点只落句读/回合边界）', () => {
  it('一来一回短对话行聚在同一段落块内，随段落原子不被切', () => {
    const dialogue =
      '「你听说了吗？」老张压低了声音。\n「听说什么？」\n「当铺昨晚进了批货。」他顿了顿，「而且不止一批。」';
    const text = `${dialogue}\n\n${plain(100)}`;
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(1); // 对话段 + 邻段一块（远低于上限）
    expect(chunks[0].text).toContain('「你听说了吗？」老张压低了声音。');
    expect(chunks[0].text).toContain('「听说什么？」');
    expect(chunks[0].text).toContain('「而且不止一批。」');
  });

  it('超长对话段按回合切：引文+归属叙述同句、回合边界（下一引文开头）才切', () => {
    const turn = `「${'是'.repeat(240)}。」他答。`; // 246 字/回合
    const text = turn + turn + turn; // 738 字单段 → 句读降级
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(2); // 246+246=492 ≤500 一块；第三回合 246 另一块
    expect(chunks[0].text).toBe(turn + turn); // 切点恰在回合边界——不落一来一回中间
    expect(chunks[1].text).toBe(turn);
    expect(chunks[0].charEnd).toBe(chunks[1].charStart);
    expect(chunks[1].text.startsWith('「')).toBe(true);
  });

  it('引文收尾引号不是句末：「走吧。」她说。 与引文同句不被拆', () => {
    const text = `${'走'.repeat(300)}。「去吧。」她说。${'停'.repeat(300)}。`; // 610 字单段
    const chunks = chunkChapter(text);
    checkAll(text, chunks);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toContain('「去吧。」她说。'); // 引文 + 归属叙述整句同块
    expect(chunks[0].text.endsWith('她说。')).toBe(true); // 块以归属叙述句读收尾（不是 」腰斩）
    expect(chunks[1].text).toBe(`${'停'.repeat(300)}。`);
  });
});

describe('chunkChapter — 空与退化输入（graceful，零 chunk 合法）', () => {
  it.each([
    ['空串', ''],
    ['纯空白', "   \n\n \t \n"],
    ['纯转场标记', '---\n\n***'],
    ['只有换行', '\n\n\n'],
  ])('%s → []', (_label, text) => {
    expect(chunkChapter(text)).toEqual([]);
  });
});

describe('chunkChapter — 确定性与选项位语义', () => {
  it('同输入两次调用 deep-equal（无 Date/random）', () => {
    expect(chunkChapter(INTEGRATION_FIXTURE)).toEqual(chunkChapter(INTEGRATION_FIXTURE));
  });

  it('synopsis 选项不影响分块决策（组料归 buildChunkIndexText 单源，prefix 不进 chunk）', () => {
    expect(chunkChapter(INTEGRATION_FIXTURE, { synopsis: '他回到了当铺。' })).toEqual(
      chunkChapter(INTEGRATION_FIXTURE),
    );
    for (const c of chunkChapter(INTEGRATION_FIXTURE, { synopsis: '他回到了当铺。' })) {
      expect(c.text).not.toContain('[梗概：'); // text = 原文，prefix 只进索引组料
    }
  });
});

describe('chunkChapter — 中文长文集成（确定性合成 ~2.5k 字章，红线守门全跑）', () => {
  it('段落分布 + 转场标记 + 超长段混合：块数合理（~6±2）/ span 全覆盖 / 无 overlap', () => {
    const contentChars = INTEGRATION_FIXTURE.replace(/\s/g, '').length;
    expect(contentChars).toBeGreaterThanOrEqual(2400); // ~2.5k 量级锚
    expect(contentChars).toBeLessThanOrEqual(2600);

    const chunks = chunkChapter(INTEGRATION_FIXTURE);
    checkAll(INTEGRATION_FIXTURE, chunks);

    // 贪心算术（常量 400/500/50 下手工推演的确定性结果；常量是 dogfood 校准点，改值须重验此表）
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.length).toBeLessThanOrEqual(8);
    expect(chunks.map((c) => [c.paraStart, c.paraEnd])).toEqual([
      [0, 1], // P0=180（P1 并入会 532>500）
      [1, 3], // P1+P2=432 ≥400 收块
      [3, 4], // P3=180
      [4, 5], // P4 超长段句读块 1：280+180=460
      [4, 5], // P4 句读块 2：140
      [5, 8], // P5+P6+P7=384（P8 并入 506>500）
      [8, 11], // P8+P9+P10=339（P11 并入 511>500）
      [11, 14], // P11+P12+P13=394（≥floor 不触发尾块并入）
    ]);
    expect(chunks.map((c) => c.charEnd - c.charStart)).toEqual([180, 432, 180, 460, 140, 384, 339, 394]);

    // 转场标记不进任何 chunk；chunk 序号连续
    for (const c of chunks) {
      expect(c.text).not.toContain('---');
      expect(c.text.length).toBeGreaterThan(0);
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
});

describe('buildChunkIndexText — 索引组料 contextual prefix（零编造）', () => {
  it('synopsis 非空：前缀格式钉死 [梗概：…] + 换行 + 原文', () => {
    expect(buildChunkIndexText('正文段。', '他回到了当铺。')).toBe('[梗概：他回到了当铺。]\n正文段。');
  });

  it('synopsis 首尾空白 trim 后使用（组料规范化，chunkText 原文不动）', () => {
    expect(buildChunkIndexText('正文段。', '  前后带空白。\n ')).toBe('[梗概：前后带空白。]\n正文段。');
  });

  it.each([
    ['undefined', undefined],
    ['空串', ''],
    ['纯空白', '   \n\t '],
  ])('synopsis %s → chunkText 原样（退化空前缀，不造章号章名）', (_label, synopsis) => {
    expect(buildChunkIndexText('正文段。', synopsis)).toBe('正文段。');
  });
});

describe('chapterChunkSchema — degenerate additive（S2 最小扩契约，二态纪律）', () => {
  it('正常 chunk 无 degenerate 键（parse 后 undefined）；硬切 chunk 标 true', () => {
    const base = { index: 0, paraStart: 0, paraEnd: 1, charStart: 0, charEnd: 10, text: 'x' };
    expect(chapterChunkSchema.parse(base).degenerate).toBeUndefined();
    expect(chapterChunkSchema.parse({ ...base, degenerate: true }).degenerate).toBe(true);
  });

  it('分块器输出全量可 parse（含 degenerate 块——S3 索引器 parse 不丢标注）', () => {
    const degenerateText = '墨'.repeat(1199) + '。';
    for (const c of chunkChapter(degenerateText)) {
      const parsed = chapterChunkSchema.parse(c);
      expect(parsed.degenerate).toBe(true); // 不被 zod strip——标注落在 schema 内
    }
  });
});
