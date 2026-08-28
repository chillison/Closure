/**
 * Story 1.5 Phase D / E2 (design §1.1 / §2.1 / §3b): pixel-geometry helpers for
 * the narrative timeline. Kept separate from `layout.ts` (which holds pure
 * SceneGraph derivation helpers, no pixels) because the geometry constants here
 * are UI-render concerns.
 *
 * ── 08-26 结构页重构 批 7（design §11「同构锁步」）──
 * 因果骨架换轴（storyTime 等距桶 → 章轴）后两区**共享同一条轨道模板**：
 * `.structure-canvas` 升 display:grid 宿主，inline `gridTemplateColumns` 由本模块
 * 的单源纯函数 `sharedColumnTracks(chapterTrackCount)` 产出一次；因果/工作台两个
 * 内网格各 `grid-template-columns: subgrid; grid-column: 1/-1` ——逐列宽度由浏览器
 * 在同一组轨道上解一次，天然锁步（⚠️「同 template 字符串喂两个独立 grid」不成立：
 * max-content 按各自内容解析，必须 subgrid——design §11 定案 2）。
 *
 * 等距列宽语义随换轴退役：colWidth(96) / totalGridWidth / structureLeftWidth 整族
 * 删除（删不留档，grep 守门）。x 向几何改「**列宽查表**」——与批 2 行高查表同一
 * 两级方案：
 *   ① 布局期 DOM 实测（useGridGeometry 'width' 模式，ResizeObserver rAF 去抖）；
 *   ② jsdom / 首帧回退名义常量表（`uniformChapterWidths`：章列 = chapterMinWidth、
 *      待编排列 = pendingColumnWidth——真实模板的逐列宽度镜像）。
 *
 * 常量法精神保留在可测性上：所有坐标数学是 offsets 查表的纯函数（输入数组 → 输出
 * 坐标），测试喂手写 fixture 数组即可精确断言，无 DOM 测量依赖。
 *
 * CR 组1 #119（裁决 1A）增补：查表分位之上有「实测纵带」seam（collectStackBands
 * 收集 DOM 实卡位置，resolveEndpointPixel / overlayCardBox 实测有效时贴真值）——
 * 与 workbenchLayout.measuredPendingOverflow 同款「可注入测量 + jsdom 固定口径回
 * 退」；纯函数性不变（测量结果作为数据入参）。
 */
import {
  MAX_CHAPTER_TRACKS,
  PENDING_COLUMN_SENTINEL,
  WORKBENCH_GEOMETRY,
} from './workbenchLayout';
import type { SharedEdgeEndpoint } from './workbenchLayout';

/** UI pixel constants for the shared-track grids + chrome (single source of truth).
 *
 * 批 7 注：laneLabelWidth 是共享模板的**首列**（两区同宽同位——subgrid 轨道锁定，
 * design §11 定案 2）；colWidth 等距族已随章轴换轴退役（§11 定案 5）。 */
export const TIMELINE_GEOMETRY = {
  /** leftmost column of the SHARED template: line/lane labels（含左缘色条 + 线名 +
   *  场景数）。消费位：sharedColumnTracks 首段 / EdgeLayer·PacingOverlay x 基准 /
   *  minimap 内容宽估算。 */
  laneLabelWidth: 160,
  /** top data row height (causal column headers; workbench 用 minmax(header, auto)
   *  折行——此处只是因果侧行模板字面 + jsdom 回退常数的一部分)。 */
  headerHeight: 32,
  /** default/fallback lane row height (measured auto rows replace it at runtime) */
  rowHeight: 64,
  /** cell-stack 内边距（镜像 structure.css .narrative-timeline-cell-stack 的 4px）
   *  ——overlayCardBox 的内缩量据此近似。 */
  cellStackPadding: 4,
  // ── 因果骨架 ↔ 工作台之间的保留带高度（CSS .structure-skeleton-gap 镜像锁定，
  //    design §1.1 定 46——批 4 AssocLayer 的短竖/短斜线居住区）──
  skeletonGapHeight: 46,
  /** horizontal padding around each skeleton's scroll area (CSS literal 12px 锁步
   *  纪律——批 7 起落位 .structure-canvas 自身 padding，scroll 包裹层只留纵向)。
   *  minimap 的内容宽估算单源消费。 */
  timelineScrollPadding: 12,
  // ── dogfood R2 批次 B (SP-4/SP-5): curve overlays + scale navigation ──
  /** MIN height of the volume-band second header row (.volume-band-strip /
   *  .workbench-band in structure.css) — 08-26 批 5 #42：卷名 2 行 wrap 时 band
   *  随内容长高（恒高退役；工作台首轨 minmax(22px, auto) 同步）。 */
  volumeBandHeight: 22,
  /** horizontal px slot one grid column occupies inside the minimap track
   *  (block 3px + 1px breathing gap). Drives minimapTrackWidth(columnCount). */
  minimapColSlotWidth: 4,
} as const;

export type PixelPoint = { x: number; y: number };

// ── 批 7：共享轨道模板单源（design §11 定案 1/2） ──

/**
 * 共享列模板（两区锁步的单源字符串）：
 *   `[泳道标签 px] repeat(N, minmax(108px, max-content)) [待编排定宽 px]`
 * StructurePage 以 inline style 注入 `.structure-canvas`（display:grid 宿主）一次；
 * 两个内网格 subgrid 接轨。零章时跳过 repeat(0,…)（非法构造——批 3 注），两区同步
 * 退化「仅待编排列」（§11 定案 5）。
 *
 * **勿写 min() 嵌 minmax()**（整条模板失效坑——mockup 踩坑钉住，chapterWorkbench.test
 * 字符串守门沿用）。
 */
export function sharedColumnTracks(chapterTrackCount: number): string {
  // CR 组1 #125 配套：轨道数封顶（离群 episode index 防线之二——派生层已钳，
  // 模板生成侧再钉一道，防其它调用点绕过单源喂巨数）。
  const t = Math.min(MAX_CHAPTER_TRACKS, Math.max(0, Math.floor(chapterTrackCount)));
  const { laneLabelWidth } = TIMELINE_GEOMETRY;
  const { chapterMinWidth, pendingColumnWidth } = WORKBENCH_GEOMETRY;
  const chapters =
    t > 0 ? ` repeat(${t}, minmax(${chapterMinWidth}px, max-content))` : '';
  return `${laneLabelWidth}px${chapters} ${pendingColumnWidth}px`;
}

/** 共享模板的轨道总数 = 章轨道数 + 待编排虚拟列（minimap/minimap 轨道基数等消费）。 */
export function sharedTrackCount(chapterTrackCount: number): number {
  // 同上：封顶与 sharedColumnTracks 同步（两者由同一 t 推导，不锁会漂）。
  return Math.min(MAX_CHAPTER_TRACKS, Math.max(0, Math.floor(chapterTrackCount))) + 1;
}

// ── 行/列累计查表（批 2 行高的列向镜像，批 7 x 几何升格为主路径） ──

/**
 * 宽度/高度数组 → 累计偏移查表。返回长度 = sizes.length + 1（offsets[0] = 0，
 * offsets[i+1] = offsets[i] + sizes[i]）：第 i 条轨道的前缘 = offsets[i]、宽度 =
 * offsets[i+1] - offsets[i]。负值防御性钳 0（实测路径不会给负值，手写 fixture 可
 * 能）。纯函数，单测锁定。
 *
 * CR 组1 #124b：非有限项（NaN/Infinity）按 0 处理——NaN 曾穿透 Math.max(0, x)
 * 直进累加链，一项污染其后全部偏移（级联过钳制洞）。逐项归零，坏项不传染。
 */
export function cumulativeOffsets(sizes: number[]): number[] {
  const out = new Array<number>(sizes.length + 1);
  out[0] = 0;
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    // Number.isFinite 先行：NaN / ±Infinity 一律按无效尺寸落 0，不进钳制函数
    // （Math.max(0, NaN) === NaN 是原洞的根因）。
    out[i + 1] = out[i]! + (Number.isFinite(s) && s > 0 ? s : 0);
  }
  return out;
}

/** 行高数组查表别名（公共面沿用批 2 名称；useGridGeometry re-export 同源取用）。 */
export function computeRowOffsets(heights: number[]): number[] {
  return cumulativeOffsets(heights);
}

/** 列宽数组查表（EdgeLayer/PacingOverlay 的 x 数学单源）。 */
export function computeColOffsets(widths: number[]): number[] {
  return cumulativeOffsets(widths);
}

/**
 * 名义列宽数组（jsdom / 首帧回退表）：章列 = WORKBENCH_GEOMETRY.chapterMinWidth
 * （真实模板的下限——max-content 只会上浮）、待编排虚拟列 = pendingColumnWidth
 * （定宽即真值）。与 sharedColumnTracks 的逐列镜像一一对应。
 */
export function nominalChapterWidths(chapterTrackCount: number): number[] {
  // #125 配套封顶（与 sharedColumnTracks 同界——名义表是真实模板的逐列镜像）。
  const t = Math.min(MAX_CHAPTER_TRACKS, Math.max(0, Math.floor(chapterTrackCount)));
  return [
    ...new Array<number>(t).fill(WORKBENCH_GEOMETRY.chapterMinWidth),
    WORKBENCH_GEOMETRY.pendingColumnWidth,
  ];
}

/**
 * 时间线区域在页内容里的名义像素宽（minimap 视口框/seek 映射的 jsdom 回退）。
 * 运行时以 .structure-skeleton 屏矩形 ÷zoom 实测替换（TimelineMinimap 内——#79：
 * canvas 盒被钳在视口宽，量内容载具；示意精度取舍注记见其文件头）。纯函数
 * （= 名义常量表求和），单测锁定。
 */
export function nominalTimelineRegionWidth(chapterTrackCount: number): number {
  const widths = nominalChapterWidths(chapterTrackCount);
  const sum = widths.reduce((acc, w) => acc + w, 0);
  return (
    2 * TIMELINE_GEOMETRY.timelineScrollPadding
    + TIMELINE_GEOMETRY.laneLabelWidth
    + sum
  );
}

// ── cell-stack 实测纵带（CR 组1 #119 / 裁决 1A：边锚点·节奏细条贴真实卡缘）──
//
// 查表分位公式（(subIndex+0.5)/stackSize × 行高）假设卡在 cell-stack 内均分——
// 卡间 gap、卡片实高差异都进不去，锚点/细条与真实卡缘存在系统性漂移。本段引入
// 「实测纵带」seam：DOM 实测每张卡的 top/height（网格坐标系自然 px），消费函数
// 实测有效则贴真值，否则回退原查表公式（jsdom / 首帧 / 测量未就绪）——语义与
// workbenchLayout.measuredPendingOverflow 同款「可注入测量 + jsdom 固定口径回退」。

/**
 * 单张场景卡的实测纵带。`top` 相对**网格 border-box 顶缘**（已含表头行与泳道偏移
 * ——即 resolveEndpointPixel 输出 y 的同一坐标系），`height` 为卡实高；单位自然 px
 * （collectStackBands 内部已按 zoom 归一）。y 无独立 subIndex 分位公式可绕——这是
 * 卡的真实位置本身。
 */
export type MeasuredCardBand = { top: number; height: number };

/**
 * cell-stack 实测纵带表：`${lineId}|${colValue}` → DOM 序卡带数组。
 *
 * ⚠️ 数组序 = 桶内 DOM 序 = 派生层的 subIndex 升序（deriveWorkbenchLayout 排序后
 * 渲染面按序平铺）——按下标取带即按 subIndex 取卡。键模板镜像 workbenchLayout /
 * NTP 的桶键单形（`${lineId}|${chapterIndex}`；待编排列 = 哨兵 -1）——改一处须三处
 * 同步。只读契约：消费方不得改写。
 */
export type StackBandTable = ReadonlyMap<string, readonly MeasuredCardBand[]>;

/** 桶键单源（上表注释的键模板的可执行化）。导出供测试对拍，运行时消费用内联同形。 */
export function stackBucketKey(lineId: string, colValue: number): string {
  return `${lineId}|${colValue}`;
}

/** 纵带有效性：有限数字 + 非负高（负高/NaN 带=测量噪声，不采信、回退查表）。 */
function isUsableBand(band: MeasuredCardBand | undefined): band is MeasuredCardBand {
  return (
    band !== undefined
    && Number.isFinite(band.top)
    && Number.isFinite(band.height)
    && band.height >= 0
  );
}

/**
 * 从结构页因果网格容器收集全部场景卡的实测纵带（#119 数据源）。
 *
 * 归属键来自既有 DOM 标记（零新增属性）：SceneCard 自带 `data-line-id`；所在
 * cell-stack 包裹层自带 `data-chapter`（章 index 数字串 / 'pending'）——closest 取
 * 包裹层即可定位桶。坐标取 getBoundingClientRect 并 ÷zoom 归一到自然量纲（批 C
 * 「canvas rect÷zoom 同一原点公式」惯例；CSS zoom 下 rect 已含缩放）。
 *
 * 回退：无容器 / 未布局（rect 全 0）/ zoom 非法 → 空表（消费侧走查表公式）。
 * 纯 DOM 读、无写入；jsdom 用 Object.defineProperty 注入假 rect 即可直测。
 */
export function collectStackBands(
  gridEl: Element | null | undefined,
  canvasZoom: number
): StackBandTable {
  const out = new Map<string, MeasuredCardBand[]>();
  if (!gridEl || typeof gridEl.querySelectorAll !== 'function') return out;
  const zoom = Number.isFinite(canvasZoom) && canvasZoom > 0 ? canvasZoom : 1;
  const base = gridEl.getBoundingClientRect();
  // 未布局（首帧前/jsdom）矩形全零——量不出可信拓扑，直接空表回退。
  if (!(base.width > 0) || !(base.height > 0)) return out;
  for (const card of Array.from(gridEl.querySelectorAll('.scene-card'))) {
    const laneId = card.getAttribute('data-line-id');
    const host = card.closest('[data-chapter]');
    const chapterRaw = host?.getAttribute('data-chapter') ?? '';
    if (!laneId || chapterRaw === '') continue;
    // 'pending' 是待编排虚拟列标记 → 哨兵 colValue（与派生层镜像一致）；其余须是
    // 章号数字串，畸形标记跳过该卡（宁可少一条带，不可错键污染邻桶）。
    const colValue = chapterRaw === 'pending'
      ? PENDING_COLUMN_SENTINEL
      : Number(chapterRaw);
    if (!Number.isInteger(colValue)) continue;
    const r = card.getBoundingClientRect();
    const band: MeasuredCardBand = {
      top: (r.top - base.top) / zoom,
      height: r.height / zoom,
    };
    if (!isUsableBand(band)) continue;
    const key = stackBucketKey(laneId, colValue);
    const arr = out.get(key);
    if (arr) arr.push(band);
    else out.set(key, [band]);
  }
  return out;
}

/**
 * 两张实测表的浅等价（NTP 重测回写去抖用）：键集相同 + 各桶逐条数值恒等。
 * getBoundingClientRect 对同一布局是确定性输出，严格相等不抖——不等才值得触发
 * 重渲染。
 */
export function stackBandsEqual(a: StackBandTable, b: StackBandTable): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, bandsA] of a) {
    const bandsB = b.get(key);
    if (!bandsB || bandsB.length !== bandsA.length) return false;
    for (let i = 0; i < bandsA.length; i++) {
      const x = bandsA[i]!;
      const y = bandsB[i]!;
      if (x.top !== y.top || x.height !== y.height) return false;
    }
  }
  return true;
}

/**
 * Resolve an edge endpoint to a pixel point inside the causal grid.
 *
 * 批 7：y 沿用 rowOffsets 查表（批 2）；x 改 **colOffsets 查表**（自适应章列下
 * 等距常量乘法不存在了——第 i 列中心 = laneLabelWidth + colOffsets[i] +
 * 该列宽/2，列宽 = colOffsets[i+1] - colOffsets[i]）。`stackSize` = 该
 * (lineId, colValue) 桶内碰撞卡数，卡在 cell-stack 内**纵向平铺**——第
 * subIndex 张卡中心落在行高的 (subIndex+0.5)/stackSize 分位处；单卡常态
 * （stackSize=1）即行中心。
 *
 * CR 组1 #123：查表越界（行/列右缘缺项——过渡帧长度不足或索引飞出）返回 **null**
 * 而非按 0 高/0 宽合成出点——调用方与悬空边同一策略整边跳过，不再留 0 尺寸假线头。
 *
 * CR 组1 #124c：subIndex 越界（负数 / ≥stackSize / NaN）钳进 [0, stack-1] 再进
 * 分位公式——曾越界漂到邻泳道视觉位置。
 *
 * CR 组1 #119（裁决 1A）：传入 `measured` 实测表且该卡带有效时，y 直接取真实卡带
 * 垂直中心（贴真实卡缘）；x 维度无堆叠语义，仍走列查表。
 */
export function resolveEndpointPixel(
  ep: SharedEdgeEndpoint,
  ctx: {
    rowIndex: number;
    colIndex: number;
    stackSize: number;
    rowOffsets: readonly number[];
    colOffsets: readonly number[];
  },
  measured?: StackBandTable
): PixelPoint | null {
  const { laneLabelWidth, headerHeight } = TIMELINE_GEOMETRY;
  // 越界判定（#123）：左缘必在表内且右缘（rowIndex+1 / colIndex+1）有定义——缺
  // 任一即「该行/列尚未解出宽度」，返回 null 让上层跳过这条端点。
  const top = ctx.rowOffsets[ctx.rowIndex];
  const bottom = ctx.rowOffsets[ctx.rowIndex + 1];
  const left = ctx.colOffsets[ctx.colIndex];
  const right = ctx.colOffsets[ctx.colIndex + 1];
  if (
    top === undefined || bottom === undefined
    || left === undefined || right === undefined
  ) {
    return null;
  }
  const colWidthPx = Math.max(0, right - left);
  const stack = Math.max(1, Math.floor(Number.isFinite(ctx.stackSize) ? ctx.stackSize : 1));
  // #124c：subIndex 钳进桶内合法位次（非有限当 0；越界钳边界——不再漂邻泳道）。
  const rawSub = ep.subIndex;
  const subIndex = Math.min(
    stack - 1,
    Math.max(0, Math.floor(Number.isFinite(rawSub) ? rawSub : 0))
  );
  // #119：实测带优先——该卡真实位置已知时弃用均匀分位近似。
  const band = measured?.get(stackBucketKey(ep.lineId, ep.colValue))?.[subIndex];
  let y: number;
  if (isUsableBand(band)) {
    y = band.top + band.height / 2;
  } else {
    const rowHeightPx = Math.max(0, bottom - top);
    y = headerHeight + top + rowHeightPx * ((subIndex + 0.5) / stack);
  }
  return { x: laneLabelWidth + left + colWidthPx / 2, y };
}

/**
 * 场景卡在网格内的占位盒（绝对定位叠层的锚；PacingOverlay 消费）。
 *
 * CR 组1 #119（裁决 1A）：传 `measured` 且该卡带有效时，top/height 取**实测真值**
 * ——节奏细条贴真实卡顶缘（旧双查表把卡高近似为行高均分，卡间 gap 折叠误差全部
 * 进 top）；left/width 仍由列查表承担（水平方向无堆叠语义，cell-stack 左右内缩
 * 仍是 CSS 布局权威的近似，注释沿袭批 7 口径）。
 *
 * CR 组1 #124d：width/height 一律 Math.max(0, …)——colWidthPx 不足 2×padding 时
 * 曾给负宽进 inline style。
 */
export function overlayCardBox(
  ctx: {
    rowIndex: number;
    colIndex: number;
    stackSize: number;
    subIndex: number;
    /**
     * 实测模式（#119）的桶键上下文——查表模式不消费。PacingOverlay 的 cells 自带
     * lineId/colValue，传参即得；缺省时实测表无法组键 → 自动走查表回退。
     */
    lineId?: string;
    colValue?: number;
  },
  rowOffsets: readonly number[],
  colOffsets: readonly number[],
  measured?: StackBandTable
): { left: number; top: number; width: number; height: number } {
  const { laneLabelWidth, headerHeight, cellStackPadding } = TIMELINE_GEOMETRY;
  const top0 = rowOffsets[ctx.rowIndex];
  const bottom = rowOffsets[ctx.rowIndex + 1];
  const left = colOffsets[ctx.colIndex];
  const right = colOffsets[ctx.colIndex + 1];
  // 缺右缘时盒无真立足点：行高/列宽按未解出落 0（装饰性叠层静默缺席优于错锚出画）。
  const rowHeightPx =
    top0 !== undefined && bottom !== undefined ? Math.max(0, bottom - top0) : 0;
  const colWidthPx =
    left !== undefined && right !== undefined ? Math.max(0, right - left) : 0;
  const stack = Math.max(1, Math.floor(Number.isFinite(ctx.stackSize) ? ctx.stackSize : 1));
  const rawSub = ctx.subIndex;
  const subIndex = Math.min(
    stack - 1,
    Math.max(0, Math.floor(Number.isFinite(rawSub) ? rawSub : 0))
  );
  const band =
    ctx.lineId !== undefined && Number.isInteger(ctx.colValue)
      ? measured?.get(stackBucketKey(ctx.lineId, ctx.colValue!))?.[subIndex]
      : undefined;
  if (isUsableBand(band)) {
    return {
      left: laneLabelWidth + (left ?? 0) + cellStackPadding,
      top: band.top,
      width: Math.max(0, colWidthPx - 2 * cellStackPadding),
      height: band.height,
    };
  }
  const cardHeight = rowHeightPx / stack;
  return {
    left: laneLabelWidth + (left ?? 0) + cellStackPadding,
    top: headerHeight + (top0 ?? 0) + subIndex * cardHeight + cellStackPadding,
    width: Math.max(0, colWidthPx - 2 * cellStackPadding),
    height: Math.max(0, cardHeight - 2 * cellStackPadding),
  };
}

/**
 * x（网格内容局部 px）→ 列 index 的反查（空白右键菜单「在此列新建场景」按光标 x
 * 反推列语义，openBlankMenu 消费）。二分查找最后一个 offsets[i] ≤ x 的 i，钳进
 * [0, count-1]。jsdom 回退表同构——测试确定性保持。纯函数，单测锁定。
 */
export function colIndexAtX(colOffsets: readonly number[], x: number): number {
  const count = Math.max(0, colOffsets.length - 1);
  if (count === 0) return 0;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((colOffsets[mid] ?? 0) <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
