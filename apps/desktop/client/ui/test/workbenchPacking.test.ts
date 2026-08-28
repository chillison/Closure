/**
 * T23（发现批10·宽卡天际线装填）：workbenchPacking 纯函数全量单测。
 *
 * 冻结契约（用户三段拍板终案 + first-fit 修正案）：
 *  - 跨 N 章的卡跨列横放、同线永不重叠、行高随轨道自动增长、单章卡竖排节奏；
 *  - 阅读序 first-fit：每卡取区间内最靠上的不碰撞位（候选 = 0 与 x 相交卡底边
 *    +gap 自上而下扫描）——链式跨章 [1-2][2-3][3-4] 两行收完（阶梯从构造上
 *    消失）；装填序=阅读序（非「宽卡先沉省行高」——用户示例语义优先）；
 *  - 文字驱动高度锚点（生产 geo）：7-8 字标题跨 2-3 章按 2 行、≥4 章按 1 行。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run workbenchPacking`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { describe, expect, it } from 'vitest';
import {
  chipHeightFromContent,
  estimateChipHeight,
  MAX_SETTLE_ROUNDS,
  packLaneChips,
  WORKBENCH_PACKING_GEO,
  type PackChipInput,
  type PackingGeometry,
} from '../src/features/structure/workbenchPacking';

/**
 * 圆数 geo（与生产同构、数值取整——断言可读）；生产 geo 的 CSS 镜像锚点与
 * 推演定标另测（单列预算 = floor((100−10−18−4)/12) = 5 字/行）。
 */
const GEO: PackingGeometry = {
  colWidth: 100,
  chipGapY: 2,
  lanePadTop: 2,
  lanePadBottom: 2,
  lineHeight: 16,
  chipPadY: 4,
  chipBorderY: 2,
  minChipHeight: 26,
  minLaneHeight: 40,
  chipPadX: 10,
  ordinalWidth: 18,
  ordinalHeight: 18,
  ordinalGapX: 4,
  charWidth: 12,
  charsPerExtraCol: 2,
};

/** 单字标题（1 行 → 高 = minChipHeight 26）的便捷构造。 */
function chip(
  nodeId: string,
  colStart: number,
  colEnd: number,
  readIndex: number,
  extra: Partial<PackChipInput> = {}
): PackChipInput {
  return { nodeId, colStart, colEnd, readIndex, title: '一', ...extra };
}

describe('packLaneChips (reading-order first-fit skyline)', () => {
  it('同章堆叠（单章卡竖排节奏）：readIndex 0,1,2 逐级下移、级距=gap+卡高；乱序输入同输出（装填序=阅读序）', () => {
    const shuffled = [chip('c', 0, 0, 2), chip('a', 0, 0, 0), chip('b', 0, 0, 1)];
    const { byNode, laneHeight } = packLaneChips(shuffled, GEO);
    expect(byNode.get('a')!.y).toBe(2); // 首卡：lanePadTop + contentY 0
    expect(byNode.get('b')!.y).toBe(30); // 2 + 26 + 2
    expect(byNode.get('c')!.y).toBe(58); // 30 + 26 + 2
    expect(laneHeight).toBe(86); // 2 + (56+26) + 2——行高随轨道自动增长
  });

  it('宽卡让位（用户拍板案①②）：W[0..1] read0、S[1..1] read1 → 单卡恒在宽卡下；跨列宽=列数×colWidth', () => {
    const { byNode, laneHeight } = packLaneChips(
      [chip('w', 0, 1, 0), chip('s', 1, 1, 1)],
      GEO
    );
    expect(byNode.get('w')!.y).toBe(2);
    expect(byNode.get('w')!.width).toBe(200); // 名义跨列宽 = 2 × colWidth（无列 gap）
    expect(byNode.get('s')!.y).toBe(30); // 宽卡底 28 + gap 2——撞到上方已放卡就下放
    expect(laneHeight).toBe(58); // 2 + (28+26) + 2
  });

  it('链式跨章两行收完（first-fit 修正案）：[1-2][2-3][3-4] → C 回填 y0 顶带（顺延规则的阶梯从构造上消失）', () => {
    const { byNode, laneHeight } = packLaneChips(
      [chip('a', 1, 2, 0), chip('b', 2, 3, 1), chip('c', 3, 4, 2)],
      GEO
    );
    expect(byNode.get('a')!.y).toBe(2); // 首卡顶带
    expect(byNode.get('b')!.y).toBe(30); // 撞 a（col2）→ 下放
    expect(byNode.get('c')!.y).toBe(2); // a 不占 ch3-4 顶带 → 空穴回填 y0
    expect(laneHeight).toBe(58); // 最深底 = b（28+26=54）→ 两行收完（顺延规则会是三行 86）
  });

  it('多宽卡交错：A[0..2]/B[1..3] 依阅读序让位；C[4..5] 不同列共享首行（行内左右序=章序=阅读序）', () => {
    const { byNode } = packLaneChips(
      [chip('a', 0, 2, 0), chip('b', 1, 3, 1), chip('c', 4, 5, 2)],
      GEO
    );
    expect(byNode.get('a')!.y).toBe(2);
    expect(byNode.get('b')!.y).toBe(30); // 与 a 交叠 col1-2 → 下放
    expect(byNode.get('c')!.y).toBe(2); // 与 a/b 都不相交 → 首行
    expect(byNode.get('c')!.width).toBe(200);
  });

  it('first-fit 无重叠不变量（含高度不等）：任意 x 相交两卡 y 带隔离 ≥ gap', () => {
    const inputs: PackChipInput[] = [
      chip('tall', 0, 1, 0, { measuredHeight: 60 }),
      chip('side', 2, 3, 1), // 与 tall 不同列 → 顶带
      chip('mid', 1, 2, 2), // 撞 tall（col1）与 side（col2）→ 最深底之下
      chip('late', 0, 0, 3, { measuredHeight: 40 }),
    ];
    const { byNode } = packLaneChips(inputs, GEO);
    const bands = inputs.map((c) => {
      const box = byNode.get(c.nodeId)!;
      return { start: c.colStart, end: c.colEnd, top: box.y, bottom: box.y + box.height };
    });
    for (let i = 0; i < bands.length; i++) {
      for (let j = i + 1; j < bands.length; j++) {
        const p = bands[i]!;
        const q = bands[j]!;
        if (p.start <= q.end && q.start <= p.end) {
          const separated = p.bottom + GEO.chipGapY <= q.top || q.bottom + GEO.chipGapY <= p.top;
          expect(separated, `bands ${i}/${j} must not overlap`).toBe(true);
        }
      }
    }
    // mid 具体位：候选 30（side 底+gap）仍撞 tall 带 → 落到 tall 底（62）+gap = 64。
    expect(byNode.get('mid')!.y).toBe(64);
  });

  it('行高累计与地板：空线 = minLaneHeight；单卡线 = 40 地板；深堆叠线随轨道增长', () => {
    expect(packLaneChips([], GEO).laneHeight).toBe(40);
    expect(packLaneChips([chip('a', 0, 0, 0)], GEO).laneHeight).toBe(40); // 2+26+2=30 < 40
    expect(
      packLaneChips([chip('a', 0, 0, 0), chip('b', 0, 0, 1), chip('c', 0, 0, 2)], GEO).laneHeight
    ).toBe(86);
  });

  it('measured 覆盖（两遍法第二遍输入）：实测高/宽替换估算；xCols 恒 0（chip 恒渲染于归属章槽）', () => {
    const { byNode } = packLaneChips([
      chip('a', 0, 1, 0, { measuredHeight: 40, measuredWidth: 250 }),
    ], GEO);
    const a = byNode.get('a')!;
    expect(a.height).toBe(40);
    expect(a.width).toBe(250);
    expect(a.xCols).toBe(0);
  });
});

describe('estimateChipHeight (文字驱动估算·生产 geo 锚点)', () => {
  const TITLE8 = '八个字标题呀呀呀'; // 8 CJK units（用户推演锚点的 7-8 字标题形态）

  it('推演锚点（用户拍板采纳）：7-8 字标题跨 1/2/3 章按 2 行、≥4 章按 1 行', () => {
    const geo = WORKBENCH_PACKING_GEO;
    const twoLine = Math.ceil(2 * geo.lineHeight + geo.chipPadY + geo.chipBorderY); // 40
    expect(estimateChipHeight(TITLE8, 1, geo)).toBe(twoLine); // 单列预算 6 → ceil(8/6)=2 行
    expect(estimateChipHeight(TITLE8, 2, geo)).toBe(twoLine); // 预算 max(6, 4)=6 → 2 行
    expect(estimateChipHeight(TITLE8, 3, geo)).toBe(twoLine); // 预算 max(6, 6)=6 → 2 行
    expect(estimateChipHeight(TITLE8, 4, geo)).toBe(geo.minChipHeight); // 预算 8 → 1 行 → 26 地板
  });

  it('短标题一行 → minChipHeight 地板；ASCII 半宽单位；空标题不炸（≥1 行）', () => {
    const geo = WORKBENCH_PACKING_GEO;
    expect(estimateChipHeight('唤醒', 1, geo)).toBe(geo.minChipHeight);
    expect(estimateChipHeight('abcdefgh', 1, geo)).toBe(geo.minChipHeight); // 4 units < 6 预算
    expect(estimateChipHeight('', 1, geo)).toBe(geo.minChipHeight);
  });

  it('长标题多行 + 宽了折行少自然矮的单调性（跨列预算增，不做机械 1/N 公式）', () => {
    const geo = WORKBENCH_PACKING_GEO;
    const T20 = '二'.repeat(20);
    const h1 = estimateChipHeight(T20, 1, geo); // ceil(20/6)=4 行
    const h4 = estimateChipHeight(T20, 4, geo); // ceil(20/8)=3 行
    const h8 = estimateChipHeight(T20, 8, geo); // ceil(20/16)=2 行
    expect(h1).toBeGreaterThan(h4);
    expect(h4).toBeGreaterThan(h8);
    expect(h8).toBeGreaterThan(geo.minChipHeight);
  });

  it('生产 geo = structure.css 字面镜像（改 CSS 须同步此处与 cssLock）', () => {
    expect(WORKBENCH_PACKING_GEO.colWidth).toBe(108); // ← WORKBENCH_GEOMETRY.chapterMinWidth 单源
    expect(WORKBENCH_PACKING_GEO.minChipHeight).toBe(26); // .workbench-chip min-height
    expect(WORKBENCH_PACKING_GEO.minLaneHeight).toBe(40); // .workbench-slot min-height
    expect(WORKBENCH_PACKING_GEO.chipGapY).toBe(2); // 旧 .workbench-slot flex gap
    expect(WORKBENCH_PACKING_GEO.lanePadTop).toBe(2.4); // --space-3xs
    expect(WORKBENCH_PACKING_GEO.chipPadX + WORKBENCH_PACKING_GEO.ordinalWidth).toBeCloseTo(27.6);
    expect(WORKBENCH_PACKING_GEO.ordinalHeight).toBe(18); // .workbench-chip-ord 18×18
  });
});

describe('chipHeightFromContent (两遍法实测换算·不动点口径)', () => {
  it('实测标题盒高 → border-box 卡高：单行由圆号下限托底 26 地板；两行 39.696；极矮内容不塌', () => {
    const geo = WORKBENCH_PACKING_GEO;
    expect(chipHeightFromContent(16.848, geo)).toBe(geo.minChipHeight); // 单行 < ord 18 → 圆号行决定
    expect(chipHeightFromContent(33.696, geo)).toBe(39.696); // 33.696 + 4 + 2（纯换算不量化——量化会与 epsilon 振荡；字符串确定性由装填 roundPx 承担）
    expect(chipHeightFromContent(5, geo)).toBe(geo.minChipHeight); // 极矮内容 → 地板
    expect(chipHeightFromContent(Number.NaN, geo)).toBe(geo.minChipHeight); // 非有限防御
  });

  it('MAX_SETTLE_ROUNDS 熔断阈值：远低于 React 嵌套更新上限（~50），敌意测量不触顶', () => {
    expect(MAX_SETTLE_ROUNDS).toBeLessThanOrEqual(10);
    expect(MAX_SETTLE_ROUNDS).toBeGreaterThan(2); // 正常收敛 1-2 轮须放行
  });
});
