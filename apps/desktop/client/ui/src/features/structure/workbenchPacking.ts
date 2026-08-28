/**
 * T23（发现批10·宽卡天际线装填，2026-08-28 用户三段拍板终案）：章节工作台线行内
 * chip 的装填纯函数。用户规则（忠实执行）：
 *   ① 跨 N 章的卡 = 一张真正的横长方形横跨覆盖列；
 *   ② 文字完全显示=硬约束（卡高不低于文字所需；宽了折行少自然矮——不做机械
 *      1/N 公式，面积守恒只是自然结果）；
 *   ③ 同线内永不重叠——撞到已放卡就下放到刚好不压的位置，行高随轨道自动增长；
 *   ④ 单章卡保持现有竖排节奏（同章多卡阅读序从上往下）。
 *
 * ── 装填算法 = 阅读序 first-fit 天际线 ──
 * 按 readIndex 逐卡放置；每张卡放在其横向区间 [colStart..colEnd] 内「最靠上的
 * 不碰撞位置」——候选 y 自上而下扫描（0 与各 x 相交已放卡的底边+gap），取首个
 * 与全部相交卡都不碰撞者。
 *
 * 为什么按阅读序处理而非「宽卡先沉」（视觉顾问曾建议宽卡先沉省行高）：用户
 * 示例语义优先——「①唤醒 拉宽到第 2 章、②落到下面」要求后序卡给先序卡让位，
 * 装填序必须就是阅读序，行高节约不 overriding 语义。
 * 为什么 first-fit 而非「y=区间内已放卡最大底边」顺延（用户拍板修正，优先级
 * 高于初版次序顺延规则）：顺延对 [1-2][2-3][3-4] 链式跨章产三级阶梯（每卡都
 * 撞前卡一列→逐级下移）；first-fit 下 C[3-4] 升回 y0（A[1-2] 不占 ch3-4 的
 * y0 带）——阶梯从构造上消失，两行收完。
 *
 * 不变式（测试锁定）：
 *   1. 同列且带位冲突的两卡按阅读序上下排——先放者已占的带后放者进不去（用户
 *      拍板「横跨 1-2 的卡永远在上、单独占第 2 章的卡在下」由构造保持）；
 *   2. 不同列卡可共享同一行（行内左右序=章序=阅读序，语义无损）；
 *   3. 同章多单卡真堆叠不受影响（那是真实内容高度的逐级下放，不是空穴回填）。
 *
 * ── 高度 = 文字驱动估算 + 两遍法实测校正 ──
 * 估算：行数 = ceil(标题字宽单位 / 每行字数预算)，预算随卡宽增——推演锚点
 * （用户拍板采纳进设计）：7-8 字中文标题在跨 2-3 章卡上按 2 行估、≥4 章按
 * 1 行估（预算 = max(单列实宽折算, 每跨一列 +2 字)）。高 = max(minChipHeight,
 * 行数×行高 + 竖 padding + 边框)。
 * 两遍法（防估偏差，T18 首帧 bump 同款机制由 ChapterWorkbench 承接）：首遍按
 * 估算定位渲染（估算帧**不钉 inline height**——卡高随文字内容自然生长，「完全
 * 显示」托底），挂载后 useLayoutEffect 实测**标题盒高**（.workbench-chip-title
 * 的 scrollHeight，chipHeightFromContent 换算成卡高）带 measuredHeight 重排
 * 一次——实测低于估算时收缩、高于时下放后续卡，一次落定无闪烁（settle 先于
 * paint）。
 *
 * ── 不动点纪律（真机 max-depth 回炉修正，2026-08-28）──
 * 实测面与写面**结构性隔离**：settle 只写 chip 的 inline height，实测只读
 * title——title 永不接收 inline height，其高度只由（卡宽=列盒 seam、字体、文本）
 * 决定，三者皆非 settle 写面 ⇒ 重测值与 applied 无关 ⇒ applied 后重测必同值。
 * 旧形（测 chip 自身 scrollHeight）自引用已应用的 inline height（scrollHeight =
 * max(clientHeight, content) 的 clientHeight 分量），任何口径偏差（边框双计/
 * 整数圆整/÷zoom 小数）都绕过全等守卫成环。配套防线（ChapterWorkbench 侧）：
 * epsilon 等值（±0.5px）+ 轮次熔断（MAX_SETTLE_ROUNDS）。
 *
 * Paradigm guard：纯确定性装填——坐标数学 + 文字量估算；「这场景该进哪章」的
 * 语义决策照旧归 LLM agent/作者（presentationSpans 写通道），本模块零语义。
 * 像素常量是 structure.css 字面镜像（几何单源纪律——改 CSS 须同步此处与
 * structureCssLock）。独立成文件不并入 workbenchLayout：后者是像素无关的图
 * 派生域（mirror timelineGeometry 的「几何常量=UI 渲染关注点」分域先例）。
 */
import { WORKBENCH_GEOMETRY } from './workbenchLayout';

/** 装填几何参数（生产值 = WORKBENCH_PACKING_GEO 的 structure.css 镜像；测试可注入自定义值）。 */
export type PackingGeometry = {
  /** 单章列名义宽 px（生产 = WORKBENCH_GEOMETRY.chapterMinWidth 单源引用；宿主共享
   *  轨道无列 gap——相邻列零间隙，跨列名义宽 = 列数 × colWidth）。 */
  colWidth: number;
  /** 上下相邻卡间隙 px（镜像旧 .workbench-slot flex gap 2px 的卡距节奏）。 */
  chipGapY: number;
  /** 线行顶 padding px（镜像 .workbench-slot padding-top = --space-3xs 2.4px）。 */
  lanePadTop: number;
  /** 线行底 padding px（同上镜像）。 */
  lanePadBottom: number;
  /** 标题行高 px（.workbench-chip line-height 1.35 × --text-sm 0.78rem×16 ≈ 16.848）。 */
  lineHeight: number;
  /** chip 竖向 padding 合计 px（2px × 2）。 */
  chipPadY: number;
  /** chip 上下边框合计 px（1px × 2——inline height 是 border-box，估算须含）。 */
  chipBorderY: number;
  /** 卡最小高 px（.workbench-chip min-height 26——「序号带 18px + 竖 padding」的地板）。 */
  minChipHeight: number;
  /** 空线行高地板 px（.workbench-slot min-height 40 镜像——无线/浅线行可见性下限）。 */
  minLaneHeight: number;
  /** chip 横向 padding 合计 px（--space-2xs 4 + --space-xs 5.6）。 */
  chipPadX: number;
  /** 阅读序圆号宽 px（.workbench-chip-ord width 18）。 */
  ordinalWidth: number;
  /** 阅读序圆号高 px（.workbench-chip-ord 18×18 方章——宽高同字面；chipHeightFromContent
   *  的内容下限，校验角标行（16px ≤ 18）随之下限覆盖）。 */
  ordinalHeight: number;
  /** 圆号与标题间隙 px（.workbench-chip gap = --space-2xs 4）。 */
  ordinalGapX: number;
  /** 标称汉字字宽 px（CJK 全宽 = --text-sm 12.48；ASCII 按半宽 0.5 单位计）。 */
  charWidth: number;
  /** 每跨一列追加的每行字数预算（推演锚点定标——见模块头「高度」段）。 */
  charsPerExtraCol: number;
};

/**
 * 生产装填几何（structure.css 字面镜像单源；cssLock/单测锚住关键值——改 CSS
 * 字面须同步此处）。rem 换算按根字号 16px。
 */
export const WORKBENCH_PACKING_GEO: PackingGeometry = {
  colWidth: WORKBENCH_GEOMETRY.chapterMinWidth, // 108（共享轨道单源引用，非字面复制）
  chipGapY: 2,
  lanePadTop: 2.4,
  lanePadBottom: 2.4,
  lineHeight: 16.848,
  chipPadY: 4,
  chipBorderY: 2,
  minChipHeight: 26,
  minLaneHeight: 40,
  chipPadX: 9.6,
  ordinalWidth: 18,
  ordinalHeight: 18,
  ordinalGapX: 4,
  charWidth: 12.48,
  charsPerExtraCol: 2,
};

/**
 * settle 轮次熔断阈值（真机 max-depth 回炉修正第三防线）：结构隔离（实测只读
 * title）下正常 1-2 轮收敛；连续这么多个轮次不等值 = 敌意/非幂等测量——停用
 * 本轮校正（保持最后装填）不再 setState，确保永不触 React 嵌套更新上限（~50）。
 */
export const MAX_SETTLE_ROUNDS = 8;

/** 单卡的装填输入（ChapterWorkbench 从派生 chip 组装；title 由调用方解析回退）。 */
export type PackChipInput = {
  nodeId: string;
  colStart: number;
  colEnd: number;
  title: string;
  /** 全局阅读序（deriveReadIndexByNode 单源）——装填序=阅读序（用户拍板）。 */
  readIndex: number;
  /** 两遍法第二遍注入的实测卡高（含边框盒高，ChapterWorkbench settle 产出）；
   *  缺省走文字驱动估算。 */
  measuredHeight?: number;
  /** 实测跨列盒宽（resolveColumnBox 列盒 seam 产出，屏系 rect ÷zoom 归一）；
   *  缺省 = 列数 × colWidth 名义值。 */
  measuredWidth?: number;
};

/** 单卡装填输出盒。 */
export type PackedChipBox = {
  nodeId: string;
  /** 相对归属槽 padding-box 左缘的偏移（列数单位）。chip 恒渲染于归属章
   *  （colStart）槽——装填区间起点即锚列，恒 0；保留字段是装填输出的形状契约
   *  （未来若 chip 与锚列解耦，此处即平移列数）。 */
  xCols: number;
  /** 相对线行顶（= 槽 padding-box 顶；槽在 grid 行内 stretch 同顶）的纵向偏移 px。
   *  已含 lanePadTop——消费侧直接作 inline top。 */
  y: number;
  /** 跨列盒宽 px（名义或实测）。 */
  width: number;
  /** 卡高 px（估算或实测——消费侧仅在实测帧钉 inline height，估算帧内容自撑）。 */
  height: number;
};

/** 一条线（泳道行）的装填结果。 */
export type LanePacking = {
  byNode: Map<string, PackedChipBox>;
  /**
   * 线行高 px（含上下 lanePad；minLaneHeight 地板）。ChapterWorkbench 以槽
   * inline minHeight 消费——grid 行轨 repeat(N, auto) 随 grid item 高度生长，
   * 「行高随轨道自动增长」的驱动位。
   */
  laneHeight: number;
};

/** 输出圆整到 0.01px：镜像常量含 2.4/16.848 等小数，浮点和会产 30.399999… 尾——
 * inline style 字符串须确定性（jsdom 断言 + 真实渲染一致性）。 */
const roundPx = (v: number): number => Math.round(v * 100) / 100;

/** 标题字宽单位（CJK/全宽=1，ASCII 等半宽=0.5）——估算口径，非排版精确值。 */
function titleUnits(title: string): number {
  let u = 0;
  for (const ch of title) u += ch.charCodeAt(0) > 0x7f ? 1 : 0.5;
  return u;
}

/**
 * 每行字数预算（随卡宽增）：单列按列宽实折（保持既有竖排卡的行数口径），跨列
 * 按推演锚点定标（每跨一列 +2 字）——两者取 max，宽卡预算单调不降。
 */
function charsPerLineBudget(spanCols: number, geo: PackingGeometry): number {
  const single = Math.floor(
    (geo.colWidth - geo.chipPadX - geo.ordinalWidth - geo.ordinalGapX) / geo.charWidth
  );
  return Math.max(1, single, geo.charsPerExtraCol * spanCols);
}

/**
 * 文字驱动高度估算（两遍法首遍）：行数 = ceil(字宽单位 / 每行预算)，高 =
 * max(minChipHeight, ceil(行数×行高 + 竖 padding + 边框))。宽了折行少自然矮
 * （预算随卡宽增）——不做机械 1/N 公式（用户拍板）。
 */
export function estimateChipHeight(
  title: string,
  spanCols: number,
  geo: PackingGeometry = WORKBENCH_PACKING_GEO
): number {
  const lines = Math.max(1, Math.ceil(titleUnits(title) / charsPerLineBudget(spanCols, geo)));
  return Math.max(
    geo.minChipHeight,
    Math.ceil(lines * geo.lineHeight + geo.chipPadY + geo.chipBorderY)
  );
}

/**
 * 实测标题盒高（content-box：不含 chip 竖 padding/边框）→ chip 装填高（border-box
 * 口径，与 inline height 严格同源）。两遍法第二遍的换算单源——**不动点关键**：
 * 实测面是 title（永不接收 inline height），本换算纯函数 ⇒ applied 后重测必同值。
 * 内容下限取圆号高（ord 18——标题单行 16.848 < 18 时卡高由圆号行决定；校验角标
 * 16px ≤ 18 随之覆盖）。
 */
export function chipHeightFromContent(
  titleBoxHeight: number,
  geo: PackingGeometry = WORKBENCH_PACKING_GEO
): number {
  const content = Number.isFinite(titleBoxHeight) ? titleBoxHeight : 0;
  return Math.max(
    geo.minChipHeight,
    Math.max(geo.ordinalHeight, content) + geo.chipPadY + geo.chipBorderY
  );
}

/**
 * 装填一条线（阅读序 first-fit 天际线）。纯函数：输入不变异、同输入同输出。
 *
 * 算法（不变式见模块头）：按 readIndex 升序逐卡；每卡在区间 [colStart..colEnd]
 * 内取「最靠上的不碰撞 y」——候选集 = {0} ∪ {x 相交已放卡底边 + gap}（升序），
 * 碰撞判定 = 与任一相交卡 y 带距离 < gap；最深底边候选必然无碰撞（全卡皆其上）
 * ⇒ 函数全终止。返回 byNode（nodeId → 盒）+ laneHeight。
 */
export function packLaneChips(
  chips: readonly PackChipInput[],
  geo: PackingGeometry = WORKBENCH_PACKING_GEO
): LanePacking {
  const ordered = [...chips].sort(
    (a, b) =>
      (Number.isFinite(a.readIndex) ? a.readIndex : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(b.readIndex) ? b.readIndex : Number.MAX_SAFE_INTEGER)
  );
  // 已放卡带（content 坐标：y=0 = 线内容顶，不含 lanePadTop——输出时统一加）。
  const placed: { start: number; end: number; top: number; bottom: number }[] = [];
  const byNode = new Map<string, PackedChipBox>();
  let maxBottom = 0;
  for (const chip of ordered) {
    const start = chip.colStart;
    const end = Math.max(start, chip.colEnd); // 防御：colEnd < colStart 时按单列
    const spanCols = end - start + 1;
    const height = chip.measuredHeight ?? estimateChipHeight(chip.title, spanCols, geo);
    const width = chip.measuredWidth ?? spanCols * geo.colWidth;
    const blockers = placed.filter((p) => p.start <= end && start <= p.end);
    const candidates = [0, ...blockers.map((p) => p.bottom + geo.chipGapY)]
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .sort((a, b) => a - b);
    let y = candidates[candidates.length - 1] ?? 0; // 兜底 = 最深底边候选（必然无碰撞）
    for (const cand of candidates) {
      const collide = blockers.some(
        (p) => cand < p.bottom + geo.chipGapY && p.top < cand + height + geo.chipGapY
      );
      if (!collide) {
        y = cand;
        break;
      }
    }
    placed.push({ start, end, top: y, bottom: y + height });
    if (y + height > maxBottom) maxBottom = y + height;
    byNode.set(chip.nodeId, {
      nodeId: chip.nodeId,
      xCols: 0,
      y: roundPx(geo.lanePadTop + y),
      width: roundPx(width),
      height: roundPx(height),
    });
  }
  return {
    byNode,
    laneHeight: roundPx(
      Math.max(geo.minLaneHeight, geo.lanePadTop + maxBottom + geo.lanePadBottom)
    ),
  };
}
