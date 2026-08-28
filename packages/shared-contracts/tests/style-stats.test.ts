import { describe, expect, it } from 'vitest';
import {
  computeStyleStats,
  renderStyleStatsBlock,
  styleStatsSchema,
} from '../src/contracts/style-stats';

// ─────────────────────────────────────────────────────────────────────────────
// 风格卡片 MVP A 路：机械统计块（task 08-28-style-card-mvp）。
// 度量口径（style-stats.ts 文件头）：分句按 。，！？；……切（clause，句长=prose 字符数）；
// 每非空行一段（段长=非空白字符含标点）；对话行=行首引号「『"'“‘；单句成段=整句终止（。，！？……）
// 至多一个。空/超短/纯标点防御是契约一部分（零计数、零占比、无 NaN、不抛错）。
// ─────────────────────────────────────────────────────────────────────────────

describe('computeStyleStats — 句长（分句）指标', () => {
  it('典型中文片段：分句数/中位/均值/区间正确（句长=去标点 prose 字符）', () => {
    // 分句：一二三四五六七八九(9)｜一二三(3)｜四五六(3)
    const stats = computeStyleStats('一二三四五六七八九。一二三，四五六。');
    expect(stats.clause.count).toBe(3);
    expect(stats.clause.minLength).toBe(3);
    expect(stats.clause.maxLength).toBe(9);
    // 三个值 9,3,3 → 排序 3,3,9 → 中位 3；均值 5。
    expect(stats.clause.medianLength).toBe(3);
    expect(stats.clause.meanLength).toBe(5);
  });

  it('偶数分句：中位取中间两值均值（round 1）', () => {
    // 分句长：一二三(3)｜一二三四(4)｜一二三四五(5)｜一二(2) → 排序 2,3,4,5 → 中位 3.5
    const stats = computeStyleStats('一二三。一二三四；一二三四五，一二。');
    expect(stats.clause.medianLength).toBe(3.5);
  });

  it('省略号/破折号不切分句（只按 。，！？；……与 ASCII !?,; 切———与……省略号本身在切分集内）', () => {
    // ……（U+2026×2）在切分集内；—（em-dash）不在。
    const stats = computeStyleStats('她说着——灯还在抖……她坐下。');
    // 切分：她说着——灯还在抖｜她坐下 → 2 分句
    expect(stats.clause.count).toBe(2);
    // 第二分句 prose：她坐下 = 3 字
    expect(stats.clause.minLength).toBe(3);
  });

  it('句长直方图分桶 + 占比', () => {
    // 四分句：9,3,11,22 → 短(≤10)=2｜中(11-20)=1｜长(21-35)=1｜超长=0
    const stats = computeStyleStats(
      '一二三四五六七八九。一二三。一二三四五六七八九十一。一二三四五六七八九十一二二二二二二二二二一一。',
    );
    expect(stats.clause.histogram.map((b) => b.count)).toEqual([2, 1, 1, 0]);
    expect(stats.clause.histogram[0]!.ratio).toBe(0.5);
    expect(stats.clause.histogram[1]!.ratio).toBe(0.25);
  });
});

describe('computeStyleStats — 段落与对话行', () => {
  it('每非空行一段；空行不计数；平均段长（非空白字符含标点）', () => {
    // 段1：他说了一句话。= 7 字符（含句号）；段2：「你好。」= 5 字符（含引号句号）；段3：她走= 2
    const stats = computeStyleStats('他说了一句话。\n\n「你好。」\n\n\n她走');
    expect(stats.paragraph.count).toBe(3);
    expect(stats.paragraph.meanLength).toBe(round1of((7 + 5 + 2) / 3));
  });

  it('对话行占比：行首引号（「『 与中英文双引号）判定（前导空白忽略）', () => {
    const stats = computeStyleStats('他说了一句话。\n「你好。」\n『深夜。』\n她说。');
    expect(stats.paragraph.count).toBe(4);
    expect(stats.dialogueLineRatio).toBe(0.5);
  });

  it('单句成段占比：整句终止（非逗号）至多一段含实文内容', () => {
    // 段1 两句（两个。）→ 非；段2 一句（尾引号残片无实文不计数）→ 是；段3 一句（逗号+一个句终）→ 是
    const stats = computeStyleStats('一句话。两句话。\n「你好。」\n她坐着，没动。');
    expect(stats.paragraph.singleSentenceRatio).toBe(round4of(2 / 3));
  });

  it('段长直方图分桶', () => {
    const long = '字'.repeat(60);
    const stats = computeStyleStats(`短。\n${long}。`);
    expect(stats.paragraph.histogram.map((b) => b.count)).toEqual([1, 1, 0, 0]);
  });
});

describe('computeStyleStats — 标点密度（每千字）', () => {
  it('叹号/问号/省略号/破折号按 run 计数，密度按非空白字符数归一', () => {
    // 非空白字符（含标点）：好！真的吗？好……真的……走了——好。 = 19
    const text = '好！真的吗？好……真的……走了——好。';
    const stats = computeStyleStats(text);
    expect(stats.totalChars).toBe(19);
    expect(stats.punctuationPerKilo.exclamation).toBeCloseTo((1 / 19) * 1000, 0);
    expect(stats.punctuationPerKilo.question).toBeCloseTo((1 / 19) * 1000, 0);
    // 省略号两个 run（……×2）；破折号一个 run（——）
    expect(stats.punctuationPerKilo.ellipsis).toBeCloseTo((2 / 19) * 1000, 0);
    expect(stats.punctuationPerKilo.dash).toBeCloseTo((1 / 19) * 1000, 0);
  });

  it('ASCII 叹号问号计入；省略号 ...（三点）算一个 run', () => {
    const text = '好!真的吗?好...真的...';
    const stats = computeStyleStats(text);
    expect(stats.punctuationPerKilo.exclamation).toBeGreaterThan(0);
    expect(stats.punctuationPerKilo.question).toBeGreaterThan(0);
    // 两个 ... run
    expect(stats.punctuationPerKilo.ellipsis).toBeGreaterThan(0);
  });
});

describe('computeStyleStats — 高频二字组合（2-gram 近似实词）', () => {
  it('prose 流 2-gram 聚合 + 计数降序 + top10 截断', () => {
    // per-段 2-gram：段1 少年看少年 → 少年×2；段2 少年走 → 少年+1、年走×1 → 少年共 3 最高
    const stats = computeStyleStats('少年看少年。\n少年走。');
    expect(stats.topBigrams[0]).toEqual({ text: '少年', count: 3 });
    expect(stats.topBigrams.length).toBeLessThanOrEqual(10);
  });

  it('停用字过滤：任一字为停用字的 2-gram 不入候选', () => {
    // 他的/的书/书他… 全含停用字（他/的）→ 空表
    const stats = computeStyleStats('他的书他的笔他的灯。');
    expect(stats.topBigrams).toEqual([]);
  });

  it('跨段不拼 2-gram（段落边界切断）', () => {
    // 两段各一词：夜色/冷雨 → 无「色冷」组合
    const stats = computeStyleStats('夜色。\n冷雨。');
    const texts = stats.topBigrams.map((b) => b.text);
    expect(texts).toContain('夜色');
    expect(texts).toContain('冷雨');
    expect(texts).not.toContain('色冷');
  });

  it('确定性：同输入两次计算结果深度相等', () => {
    const text = '夜色像一块浸了水的黑布。他站在门口，没有进去。\n「你来了。」她说着，把手里的灯放在桌上——灯芯还在抖。';
    expect(computeStyleStats(text)).toEqual(computeStyleStats(text));
  });
});

describe('computeStyleStats — 防御（空/超短/纯标点）', () => {
  it('空串：全零形态，不抛错无 NaN，schema 通过', () => {
    const stats = computeStyleStats('');
    expect(stats.totalChars).toBe(0);
    expect(stats.clause.count).toBe(0);
    expect(stats.clause.medianLength).toBe(0);
    expect(stats.clause.minLength).toBe(0);
    expect(stats.clause.maxLength).toBe(0);
    expect(stats.paragraph.count).toBe(0);
    expect(stats.paragraph.meanLength).toBe(0);
    expect(stats.paragraph.singleSentenceRatio).toBe(0);
    expect(stats.dialogueLineRatio).toBe(0);
    expect(stats.topBigrams).toEqual([]);
    expect(Number.isFinite(stats.punctuationPerKilo.exclamation)).toBe(true);
    expect(styleStatsSchema.safeParse(stats).success).toBe(true);
  });

  it('纯空白：零形态；纯标点：无分句（段落按非空行仍计 1，零分句零占比不炸）', () => {
    const blank = computeStyleStats('   \n\t  ');
    expect(blank.paragraph.count).toBe(0);
    expect(blank.clause.count).toBe(0);
    expect(styleStatsSchema.safeParse(blank).success).toBe(true);

    for (const text of ['。。。！？？，', '……——']) {
      const stats = computeStyleStats(text);
      expect(stats.clause.count).toBe(0);
      expect(stats.clause.meanLength).toBe(0);
      // 段落规则 = 每非空行一段（标点行非空）——照设计计 1，防御指「无分句、零占比、无 NaN」。
      expect(stats.paragraph.count).toBe(1);
      expect(stats.paragraph.meanLength).toBeGreaterThan(0);
      expect(styleStatsSchema.safeParse(stats).success).toBe(true);
    }
  });

  it('超短输入（一两字）：计数正确不炸', () => {
    const stats = computeStyleStats('走。');
    expect(stats.totalChars).toBe(2);
    expect(stats.clause.count).toBe(1);
    expect(stats.clause.medianLength).toBe(1);
    expect(stats.paragraph.count).toBe(1);
    expect(stats.paragraph.singleSentenceRatio).toBe(1);
  });

  it('超大片段不抛错（CR-019：min/max spread→reduce——数十万分句不撑爆参数栈）', () => {
    // 15 万分句 × 2 字 = 30 万字：旧实现 Math.min(...clauseLengths) 的 spread 在此量级抛
    // RangeError（computeStyleStats 在 dispatch 长度门之前就要先算 totalChars，必须任意大安全）。
    const giant = '短句。'.repeat(150_000);
    const stats = computeStyleStats(giant);
    expect(stats.clause.count).toBe(150_000);
    expect(stats.clause.minLength).toBe(2);
    expect(stats.clause.maxLength).toBe(2);
    expect(stats.clause.medianLength).toBe(2);
    expect(stats.totalChars).toBe(450_000);
    expect(styleStatsSchema.safeParse(stats).success).toBe(true);
  });

  it('非字符串输入防御（undefined/null → 零形态，不抛错）', () => {
    expect(computeStyleStats(undefined as unknown as string).totalChars).toBe(0);
    expect(computeStyleStats(null as unknown as string).totalChars).toBe(0);
  });
});

describe('styleStatsSchema — 契约形态', () => {
  it('典型片段计算结果过 schema（roundtrip）', () => {
    const stats = computeStyleStats('夜色像一块浸了水的黑布。他站在门口，没有进去。\n「你来了。」');
    const parsed = styleStatsSchema.safeParse(stats);
    expect(parsed.success).toBe(true);
  });

  it('直方图 label 非空 + count 非负整数的负例', () => {
    expect(styleStatsSchema.safeParse({ clause: { histogram: [{ label: '', count: 1, ratio: 1 }] } }).success).toBe(false);
  });
});

describe('renderStyleStatsBlock — markdown 渲染', () => {
  it('各指标行齐备 + 数字来自数据（纯投影）', () => {
    const stats = computeStyleStats('他说了一句话。\n「你好。」\n她走——走了……');
    const md = renderStyleStatsBlock(stats);
    expect(md).toContain('字数（非空白字符）');
    expect(md).toContain(`字数（非空白字符）：${stats.totalChars}`);
    expect(md).toContain(`分句：${stats.clause.count} 句`);
    expect(md).toContain(`段落：${stats.paragraph.count} 段`);
    expect(md).toContain(`对话行占比（行首引号「『"' 判定）：`);
    expect(md).toContain('标点密度（每千字）：叹号');
    expect(md).toContain('高频二字组合（近似实词，2-gram 简易聚合）：');
    expect(md).toContain('V2 统计指纹的升级插槽');
  });

  it('占比渲染为百分数；top10 条目为「词（次数）」形', () => {
    const stats = computeStyleStats('少年看少年。\n少年走很远。');
    const md = renderStyleStatsBlock(stats);
    expect(md).toMatch(/\d+(\.\d+)?%/);
    expect(md).toContain('少年（');
  });

  it('空 stats 渲染零值不产 NaN/undefined', () => {
    const md = renderStyleStatsBlock(computeStyleStats(''));
    expect(md).not.toContain('NaN');
    expect(md).not.toContain('undefined');
    expect(md).toContain('分句：0 句');
    expect(md).toContain('0/0 行');
    expect(md).toContain('（无——样本过短或全被停用词过滤）');
  });
});

// ── 测试内 round helper（与实现同口径，避免字面量抄错）──
function round1of(v: number): number {
  return Math.round(v * 10) / 10;
}
function round4of(v: number): number {
  return Math.round(v * 10000) / 10000;
}
