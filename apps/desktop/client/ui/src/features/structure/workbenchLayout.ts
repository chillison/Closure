/**
 * 08-26 结构页重构 批 3（implement 3.1/3.3 / design §1 §2 §3.1 / prd R1）：章节
 * 规划工作台（融合网格）纯派生。WeavingPanel/weavingLayout 的 `deriveWeavingLayout`
 * （literal 列 span + track 区间着色）随阅读骨架退役——本模块承接「阅读顺序 ×
 * 章节打包」语义：行 = 线 / 列 = 章 / 格 =（线, 章）内该线场景片按 readIndex 升序
 * 排 chip。跨章场景不再 literal 占列——chip 落在归属章（range 起点），span 视觉
 * （左直角右圆 + 续到 marker）承载跨章信号（mockup #mergedGrid 段拍板）。
 *
 * 派生单源（勿重写）：
 *   - readIndex：layout.ts `deriveReadIndexByNode`（presentationOrder 稳定序 0..N-1，
 *     阅读骨架退役后该派生保留——序号计算仍用它）。
 *   - 章归属：`resolveSceneChapterRange` 三级解析（presentationSpans → episodeId →
 *     presentationOrder.chapter），自 weavingLayout.ts 原样迁入（useWeavingEdit 同源）。
 *   - 行序：`orderLinesByPriority`（与因果骨架泳道同序——同线同行，跨视图对读的前提）。
 *
 * 倒叙（reordered）判定：节点的「故事时序位次」与「阅读序位次」错位——storyRank =
 * 按 (storyTime, 原数组序) 稳定排序后的 0..N-1 位次；reordered = storyRank !==
 * readIndex。与 AssociationLayer 旧「因果列 idx ≠ 阅读列 idx」同向（mockup：故事时序
 * 11、阅读序落到卷末 → 钢蓝序号）。
 *
 * 待编排列（design §2 缺口补齐）：`resolveSceneChapterRange` 返回 null 的场景
 * （三章解析全 miss）在旧编织网格被静默跳过——重排后完全不可见。本派生把它们收进
 * `pendingByLine`（末尾虚拟列，非 episode，纯渲染层聚合——**不产生任何 episode 数据
 * 写入**）。
 *
 * ── 08-26 结构页重构 批 7（design §11「同构锁步」定案 1/2）──
 * 因果骨架换轴（storyTime 等距桶退役 → 章轴）后，两区由**同一份派生**喂数据：
 *   - `causalSlots`：同一 (线, 章) 桶键的因果侧卡（每场景**只落起始章一格**——不
 *     复刻 chip 的 span 渲染，两区密度差即视图价值差），桶内按故事时序（storyTime,
 *     原数组序）升序并顺序编号 subIndex——cell-stack 纵向平铺与边端点分位共此单源。
 *   - `primaryCellByNode` / `edges`：旧 deriveTimelineLayout 的边锚定职责迁入
 *     （dangling 场景镜像进因果待编排列，colValue 用 PENDING_COLUMN_SENTINEL 哨兵，
 *     colIndex 查表把哨兵映到末位轨道）。deriveTimelineLayout 本体随换轴退役删除。
 *
 * Paradigm guard（ADR-3）：确定性纯函数——归属查表、序数派生、稳定排序；「这场景
 * 该进哪章」的语义决策归 LLM agent/作者（presentationSpans 写通道），本模块零语义。
 */
import type { z } from 'zod';
import type { SceneGraph, SceneNode, SceneNodeRole } from '@orison/shared-contracts';
import { episodeOutlineSchema } from '@orison/shared-contracts';
import { deriveReadIndexByNode, orderLinesByPriority } from './layout';

type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

// ── 几何常量（design §3.1 分轴宽度策略的融合侧单源；CSS 镜像见 structure.css 注） ──

export const WORKBENCH_GEOMETRY = {
  /**
   * 章列最小宽（design §3.1 拍板：下限 108px）。章 = 离散容器无等距语义——列宽
   * `minmax(108px, max-content)` 随内容自适应；上限由 chipMaxWidth 承担（chip 是
   * 列内容的 max-content 上界）。**禁 min() 嵌 minmax()**——整条 grid-template 会
   * 失效回退 auto 无上限（mockup 踩坑钉住）。
   */
  chapterMinWidth: 108,
  /**
   * chip 最大宽（~212px，承担章列宽上限；超限标题 2 行 clamp 后省略 + `title`
   * 悬停全名——批 5 #44 拍板修订）。inline style 施加于 chip（TS 单源）；structure.css
   * `.workbench-chip` 以字面 212px 镜像同一上界（批 6 #53 失配修复），两处由
   * structureCssLock 锁住 CSS 字面——改值须同步。
   */
  chipMaxWidth: 212,
  /**
   * 待编排虚拟列**定宽**（08-26 批 5 #46）：`minmax(108px, max-content)` 的
   * max-content 量度无视 flex-wrap——14 枚 dangling chip 的「一行总宽」把列撑到
   * 432px+（grid track sizing vs flex-wrap 交互的根因）。定宽 ~220px（≈chip
   * max-width + padding）让 chip 竖排 wrap；章列不受影响（仍走 minmax 自适应）。
   */
  pendingColumnWidth: 220,
  /**
   * 待编排堆**初见可见枚数**（批 8.3；R7 计数器化修订）：高度封顶 ≈ 此枚数，
   * **其余全部照常渲染**、常驻滚轮可达（不是 DOM 裁剪——「折叠的看不见」正是用户
   * 否决的原方案）。`.pending-overflow` 变体类只在总数超出此数时挂上（封顶+渐隐的
   * CSS 钩子）；「堆内 +N」徽标已退役，改由每线一枚待编排计数器报**总数**
   * （`.lane-pending-counter`——两区位置口径统一）。两包共用；数值改这里，CSS 封顶
   * 字面（pending 变体 max-height）按「枚数 × 卡高 + gap + padding」同步手调并锁 cssLock。
   */
  pendingStackVisibleCount: 3,
} as const;

/**
 * 待编排哨兵章（#63：拖回待编排的写通道）。chapter schema 是 int().nonnegative()
 * ——负数哨兵（-1）会被 zod 拒收；取远离真实章域的保留值（dangling 判定本就是
 * 「章号无对应 episode」，哨兵永不命中 → 恒 dangling）。project.yaml 手改场景
 * 请避免 999999 章号。导出单源：两区 pending drop 写入与派生防撞共用。
 */
export const PENDING_CHAPTER_SENTINEL = 999_999;

/**
 * 稠密章轨道数上限（CR 组1 #125：无上限护栏）：离群/畸形 agent 写入的巨大
 * episode index 曾让 chapterTrackCount 直冲 index+1，两区网格 repeat() 轨道与
 * 逐轨 cell-stack 渲染把主线程冻结。封顶是**离群防御线，不是产品规模目标**
 * （AC1 基准 ≤40 章；512 给百万字长篇留了数量级余量）。超出封顶的章按「无可
 * 归属轨道」处理——引用它的场景走既有待编排列收纳（与 dangling 同语义，数据零
 * 写入、不丢弃）；列头同样截断（subgrid 宿主模板由 sharedColumnTracks 同界钳）。
 */
export const MAX_CHAPTER_TRACKS = 512;

/** 章号在共享轨道域内的判定（#125 派生侧单点）。 */
function chapterInBounds(chapter: number): boolean {
  return Number.isInteger(chapter) && chapter >= 0 && chapter < MAX_CHAPTER_TRACKS;
}

/**
 * 倒叙判定（BMad CR 组1-E「同 storyTime 并行误判」并列豁免版）：节点参与**跨
 * storyTime 层**的阅读逆序才判倒叙——同 storyTime 并行场景之间的先后只是并列
 * 内部排序，不是时间位移，不再因位次错配误点钢蓝。
 *
 * 算法（排序一次 + 线性双向扫描）：
 *  1. storyTime 分层：(storyTime, 数组序) 升序遍历，同值并列归同层号 g；
 *  2. 按阅读序前向扫，跑动最大层号——当前层号更小 = 阅读更早处出现因果更晚的
 *     场景 → 本节点落在某个逆序对的迟到端；
 *  3. 反向扫，跑动最小层号——当前层号更大 = 其后还有因果更早的场景 → 早读端
 *     同样点亮（两端可见，保留旧位次语义把倒叙块整体染钢蓝的观感）。
 *
 * 纯函数。当前消费单源 = deriveWorkbenchLayout 内的 chip 旗（08-27 深夜目检 T4
 * 后 AssocLayer 侧不再消费——待编排方向关联线一律不渲染，透传委托已删）。
 */
export function deriveReorderedByNode(
  nodes: readonly SceneNode[],
  readIndexByNode: ReadonlyMap<string, number>
): ReadonlySet<string> {
  const layered = nodes
    .map((node, idx) => ({ node, idx }))
    .sort((a, b) => a.node.storyTime - b.node.storyTime || a.idx - b.idx);
  const groupByNode = new Map<string, number>();
  let layer = -1;
  let prevStoryTime = Number.NaN;
  for (const { node } of layered) {
    if (!(node.storyTime === prevStoryTime)) {
      layer += 1;
      prevStoryTime = node.storyTime;
    }
    groupByNode.set(node.id, layer);
  }

  const inReadingOrder = [...nodes].sort(
    (a, b) => (readIndexByNode.get(a.id) ?? 0) - (readIndexByNode.get(b.id) ?? 0)
  );
  const reordered = new Set<string>();
  let maxGroupSeen = Number.NEGATIVE_INFINITY;
  for (const node of inReadingOrder) {
    const g = groupByNode.get(node.id) ?? 0;
    if (g < maxGroupSeen) reordered.add(node.id);
    if (g > maxGroupSeen) maxGroupSeen = g;
  }
  let minGroupSeen = Number.POSITIVE_INFINITY;
  for (let k = inReadingOrder.length - 1; k >= 0; k--) {
    const node = inReadingOrder[k];
    const g = groupByNode.get(node.id) ?? 0;
    if (g > minGroupSeen) reordered.add(node.id);
    if (g < minGroupSeen) minGroupSeen = g;
  }
  return reordered;
}

// ── 章归属解析（自 weavingLayout.ts 原样迁入——useWeavingEdit/工作台同源） ──

/** A scene's resolved chapter-column range (inclusive). */
export type ChapterRange = {
  /** first chapter column (episode.index) the scene occupies */
  colStart: number;
  /** last chapter column (inclusive); colStart === colEnd = single-chapter scene */
  colEnd: number;
};

/**
 * Resolve a scene's chapter-column range [colStart, colEnd] from its publication
 * data. Resolution order (1.8 design): presentationSpans → episodeId (legacy) →
 * presentationOrder.chapter. Returns null when the scene resolves to no episode
 * (dangling) — the caller routes it to the 待编排 virtual column;
 * `validateSceneGraph` flags the ref.
 *
 * Pure & total — never throws. Defensive (CR-001): guards against malformed
 * partial-hydration data (non-array presentationSpans / missing presentationOrder).
 */
export function resolveSceneChapterRange(
  node: SceneNode,
  episodeById: Map<string, EpisodeOutline>,
  episodeByIndex: Map<number, EpisodeOutline>
): ChapterRange | null {
  // 1. presentationSpans (1.8, preferred) — multi-span = cross-chapter scene.
  const spans = node.presentationSpans;
  if (Array.isArray(spans) && spans.length > 0) {
    const indices: number[] = [];
    for (const span of spans) {
      // 元素级防御（CR 组1-E8）：注水/手改 project.yaml 可产 null 或非对象元素
      // （A 批只挡了非数组，这里补齐形状底线）——坏元素按不可解析跳过。
      if (span === null || typeof span !== 'object') continue;
      const ep = episodeById.get(span.episodeId);
      if (ep) indices.push(ep.index);
    }
    if (indices.length > 0) {
      return { colStart: Math.min(...indices), colEnd: Math.max(...indices) };
    }
    // all spans dangling → fall through to legacy/fallback (partially-dangling span
    // set is flagged by validateSceneGraph; the layout still tries the legacy fields).
  }

  // 2. episodeId (legacy 1.1 single) → single column.
  if (node.episodeId) {
    const ep = episodeById.get(node.episodeId);
    if (ep) return { colStart: ep.index, colEnd: ep.index };
  }

  // 3. presentationOrder.chapter fallback → episode with matching index (single).
  const chapter = node.presentationOrder?.chapter;
  if (typeof chapter === 'number') {
    const ep = episodeByIndex.get(chapter);
    if (ep) return { colStart: chapter, colEnd: chapter };
  }

  return null; // dangling — no resolvable episode
}

// ── 融合网格派生 ──

/** 已编排的场景片（一章或多章 range 解析成功）。 */
export type WorkbenchChipData = {
  nodeId: string;
  /** which row (lineId, maps to `WorkbenchLayout.rows[i].lineId`) */
  lineId: string;
  /** flows from `SceneNode.role` for the chip's shape/glyph axis */
  role: SceneNodeRole;
  /** 场景人类标题（SceneNode.title，optional；缺省回退 id） */
  title?: string;
  /** 归属章（range 起点）——chip 渲染所在列（episode.index） */
  colStart: number;
  /** range 终点（含）；> colStart = 跨章 span（宽卡物理形态承载语义——T10 起无文字徽记） */
  colEnd: number;
  /** 全局阅读序 0..N-1（deriveReadIndexByNode 单源派生；圆号显示 +1） */
  readIndex: number;
  /** 倒叙：参与跨 storyTime 层的阅读逆序（并列豁免版，deriveReorderedByNode）→ 钢蓝序号 */
  reordered: boolean;
  /**
   * T26 ②（发现批10·多线拷贝无标记）：该场景实际参与 >1 条线（valid lineTags
   * 数 >1——死 lineTag 不计入拷贝数）。**同 nodeId 每线一枚实例**的静态辨认标记
   * （chip 圆号双环 / SceneCard 回声条），运行时恒写入本单源。类型面 optional
   * 是对孤立测试/界外消费者的兼容（同 pending 判别位纪律）。
   */
  multiline?: boolean;
  /**
   * 显式判别位（CR 组 3a：`'colStart' in chip` 鸭子探测退役）——已编排恒 false，
   * 待编排恒 true。消费侧判 pending 读本位，不再做属性存在性探测。类型面 optional
   * 是对界外只读消费者的兼容（AssocLayer 的成员图仍以属性存在性窄化）；**运行时
   * deriveWorkbenchLayout 恒写入**——真值由本单源保证，不是「可能缺席的提示位」。
   */
  pending?: false;
};

/** 待编排场景片（章归属解析全 miss——末尾虚拟列收纳，灰态）。 */
export type PendingChipData = {
  nodeId: string;
  lineId: string;
  role: SceneNodeRole;
  title?: string;
  readIndex: number;
  /** 多线标记（同 WorkbenchChipData.multiline——待编排拷贝同样可多线）。 */
  multiline?: boolean;
  /** 显式判别位（同上）——待编排恒 true。 */
  pending: true;
};

/** 因果侧待编排列的哨兵 colValue（非负章域不冲突；colIndex 查表映射到末位轨道）。 */
export const PENDING_COLUMN_SENTINEL = -1;

/**
 * 因果骨架卡（批 7 章轴）：结构上与旧 TimelineCell 同形——(线, 章) 桶内一枚，
 * subIndex = 桶内纵向平铺序（故事时序升序后顺序编号）。colValue = 章起始 index
 * （跨章 span 场景只落起始章一格）；待编排场景为 PENDING_COLUMN_SENTINEL。
 */
export type CausalCardData = {
  nodeId: string;
  lineId: string;
  role: SceneNodeRole;
  title?: string;
  colValue: number;
  subIndex: number;
  /** 多线标记（同 WorkbenchChipData.multiline——两区同数据源同形）。 */
  multiline?: boolean;
};

/** 边锚定端点（primary cell——结构同旧 TimelineEdgeEndpoint，随派生单源迁移至此）。 */
export type SharedEdgeEndpoint = { lineId: string; colValue: number; subIndex: number };

export type SharedEdgePos = {
  edgeId: string;
  type: 'CAUSAL' | 'SUSPENSE';
  from: SharedEdgeEndpoint;
  to: SharedEdgeEndpoint;
};

export type WorkbenchLayout = {
  /** ordered lanes（orderLinesByPriority——与因果骨架泳道同序） */
  rows: { lineId: string; name: string }[];
  /** 章列：实际存在的 episode 按 index 升序（gapped indices 不进本表——网格轨道
   *  数由 maxChapterIndex+1 决定，格与列头按 raw index 对位，空轨道诚实留白） */
  cols: { index: number; title: string }[];
  /** 最大章 index + 1（含 gap 的稠密轨道数；无 episode 为 0） */
  chapterTrackCount: number;
  /** `${lineId}|${chapterIndex}` → 该（线, 章）格的场景片，readIndex 升序 */
  slots: Map<string, WorkbenchChipData[]>;
  /** 待编排列：lineId → 该线的 dangling 场景片，readIndex 升序 */
  pendingByLine: Map<string, PendingChipData[]>;
  /**
   * 因果侧卡桶（批 7）：**键与 slots 完全一致**（`${lineId}|${chapterIndex}`，
   * subgrid 锁步的行×列数据面），值为该格的场景卡，故事时序升序 + 顺序 subIndex。
   * dangling 场景镜像进同形桶（colValue = PENDING_COLUMN_SENTINEL，即键尾 |-1）。
   */
  causalSlots: Map<string, CausalCardData[]>;
  /** 因果侧待编排桶（哨兵列；键形同上）。 */
  causalPending: Map<string, CausalCardData[]>;
  /**
   * node.id → primary cell 端点（首个 valid lineTag 的因果卡）。待编排场景端点
   * colValue = PENDING_COLUMN_SENTINEL。O(1) 查表（CR-004 面沿用）。只读契约。
   */
  primaryCellByNode: Map<string, SharedEdgeEndpoint>;
  /** graph.edges 经 primaryCell 锚定后的副本（缺端点跳过——校验旗另有通道）。 */
  edges: SharedEdgePos[];
};

/**
 * 章轨道数单源（design §11 定案 1）：宿主 .structure-canvas 的共享模板列数与两区
 * 派生共用本函数（StructurePage 以 raw episode 数据直调——双区 derive 与宿主模板
 * 之间不存在第三条口径）。非数组/残缺数据防御性归零。
 */
export function episodeTrackCountOf(rawEpisodes: unknown): number {
  if (!Array.isArray(rawEpisodes)) return 0;
  let max = -1;
  for (const e of rawEpisodes) {
    const idx = (e as { index?: unknown } | null)?.index;
    if (typeof idx === 'number' && Number.isFinite(idx)) {
      // CR 组1 #125 同界：与 deriveWorkbenchLayout 的截断同一口径（只数封顶域内
      // 的章）——否则界外离群 index 会把宿主模板撑到与两区派生不一致的轨道数。
      const i = Math.floor(idx);
      if (i >= 0 && i < MAX_CHAPTER_TRACKS) max = Math.max(max, i);
    }
  }
  return max + 1;
}

/**
 * Derive the chapter-workbench layout (+ the chapter-axis causal mirror, 批 7)
 * from a SceneGraph + episode_outlines. Pure & deterministic: same input → same
 * output, inputs never mutated.
 *
 * @param episodes `creativeFields.episode_outlines`. A non-array value yields an
 *   empty cols/trackCount（全部场景进待编排列——无章可归属是真实状态，不静默吞）；
 *   两区同步退化「仅待编排列」（design §11 定案 5）。
 */
export function deriveWorkbenchLayout(
  graph: SceneGraph,
  episodes: EpisodeOutline[] | undefined
): WorkbenchLayout {
  const rows = orderLinesByPriority(graph.lines);
  const lineExists = new Set(graph.lines.map((l) => l.id));

  // CR-001 defense: Array.isArray guards a malformed episode_outlines value.
  const epsAll = Array.isArray(episodes)
    ? [...episodes].sort((a, b) => a.index - b.index)
    : [];
  // CR 组1 #125：轨道域封顶——界外章的列头不入网格（宿主模板同界，防 subgrid
  // 溢出）；其 index 域也随之收敛（下方 trackCount 由截断后的 max 推出）。
  const eps = epsAll.filter((e) => chapterInBounds(e.index));
  const cols = eps.map((e) => ({ index: e.index, title: e.title }));
  const maxChapterIndex = eps.length > 0 ? Math.max(...eps.map((e) => e.index)) : -1;

  const episodeById = new Map(eps.map((e) => [e.id, e] as const));
  const episodeByIndex = new Map(eps.map((e) => [e.index, e] as const));

  // ── 序数双源：readIndex（阅读序）+ 倒叙集合（并列豁免版，单源见模块层
  //    deriveReorderedByNode——组1-E「同 storyTime 并行误判」重构）──
  const readIndexByNode = deriveReadIndexByNode(graph.nodes);
  const reorderedSet = deriveReorderedByNode(graph.nodes, readIndexByNode);

  // 因果侧桶内排序键：(storyTime, 原数组序)——因果卡在格内的纵向平铺序即故事时序。
  const arrayIndexByNode = new Map<string, number>();
  graph.nodes.forEach((node, i) => arrayIndexByNode.set(node.id, i));

  const slots = new Map<string, WorkbenchChipData[]>();
  const pendingByLine = new Map<string, PendingChipData[]>();
  const causalSlots = new Map<string, CausalCardData[]>();
  const causalPending = new Map<string, CausalCardData[]>();
  const primaryCellByNode = new Map<string, SharedEdgeEndpoint>();

  const pushSlot = (lineId: string, chapter: number, chip: WorkbenchChipData) => {
    const key = `${lineId}|${chapter}`;
    const arr = slots.get(key);
    if (arr) arr.push(chip);
    else slots.set(key, [chip]);
  };
  const pushCausal = (
    bucket: Map<string, CausalCardData[]>,
    lineId: string,
    colValue: number,
    card: Omit<CausalCardData, 'subIndex'>
  ) => {
    const key = `${lineId}|${colValue}`;
    let arr = bucket.get(key);
    if (!arr) {
      arr = [];
      bucket.set(key, arr);
    }
    arr.push({ ...card, subIndex: arr.length }); // 顺序编号 = 插入序（见下方统一重排）
  };

  for (const node of graph.nodes) {
    const readIndex = readIndexByNode.get(node.id);
    if (readIndex === undefined) continue; // defensive — deriveReadIndexByNode seeds every node
    // CR-010/CR-001（layout.ts 同款防线）：dedupe lineTags + 非数组容忍。
    const lineTags = Array.isArray(node.lineTags) ? [...new Set(node.lineTags)] : [];
    // T26 ②：多线判定 = **实际参与**的线数（valid lineTags >1）——死 lineTag 无拷贝
    // 不计数，标记与「每线一枚实例」的渲染事实严格一致。
    const validLineTags = lineTags.filter((t) => lineExists.has(t));
    const multiline = validLineTags.length > 1;
    const primaryLine = validLineTags[0];
    let range = resolveSceneChapterRange(node, episodeById, episodeByIndex);
    // CR 组1 #125：解析结果落在封顶轨道域之外（该章列头已截断，chip 渲染会掉进
    // 不存在的轨道）→ 与 dangling 同语义降级进待编排列（纯渲染收纳、零 episode
    // 写入）。按 range 起点判定——chip 本就落归属章起点（colEnd 尾随段随起点同弃）。
    if (range && !chapterInBounds(range.colStart)) range = null;
    if (!range) {
      // dangling → 待编排列（虚拟列，纯渲染聚合——零 episode 写入）。因果侧镜像同收。
      for (const lineTag of validLineTags) {
        const arr = pendingByLine.get(lineTag);
        const chip: PendingChipData = {
          nodeId: node.id,
          lineId: lineTag,
          role: node.role,
          title: node.title,
          readIndex,
          multiline,
          pending: true,
        };
        if (arr) arr.push(chip);
        else pendingByLine.set(lineTag, [chip]);
        pushCausal(causalPending, lineTag, PENDING_COLUMN_SENTINEL, {
          nodeId: node.id,
          lineId: lineTag,
          role: node.role,
          title: node.title,
          colValue: PENDING_COLUMN_SENTINEL,
          multiline,
        });
      }
      if (primaryLine !== undefined) {
        primaryCellByNode.set(node.id, {
          lineId: primaryLine,
          colValue: PENDING_COLUMN_SENTINEL,
          subIndex: 0, // 占位——桶重排后按真实位次回填
        });
      }
      continue;
    }
    const reordered = reorderedSet.has(node.id);
    for (const lineTag of validLineTags) {
      pushSlot(lineTag, range.colStart, {
        nodeId: node.id,
        lineId: lineTag,
        role: node.role,
        title: node.title,
        colStart: range.colStart,
        colEnd: range.colEnd,
        readIndex,
        reordered,
        multiline,
        pending: false,
      });
      pushCausal(causalSlots, lineTag, range.colStart, {
        nodeId: node.id,
        lineId: lineTag,
        role: node.role,
        title: node.title,
        colValue: range.colStart,
        multiline,
      });
    }
    // primary cell = 首个 valid lineTag 的因果卡。
    if (primaryLine !== undefined) {
      primaryCellByNode.set(node.id, {
        lineId: primaryLine,
        colValue: range.colStart,
        subIndex: 0, // 占位——桶重排后按真实位次回填
      });
    }
  }

  // ── 格内排序：工作台 chip 按 readIndex 升序（阅读顺序即格内 chip 排列序）；──
  // ── 因果卡按 (storyTime, 原数组序) 升序后**回填 subIndex**——cell-stack DOM 序、 ──
  // ── 边端点分位、primaryCell 位次三面共此单源。                                ──
  for (const arr of slots.values()) arr.sort((a, b) => a.readIndex - b.readIndex);
  for (const arr of pendingByLine.values()) arr.sort((a, b) => a.readIndex - b.readIndex);

  const storyTimeByNode = new Map<string, number>(graph.nodes.map((n) => [n.id, n.storyTime]));
  const sortCausalBuckets = (bucket: Map<string, CausalCardData[]>) => {
    for (const arr of bucket.values()) {
      if (arr.length > 1) {
        const keyed = [...arr].sort((a, b) => {
          const at = storyTimeByNode.get(a.nodeId) ?? 0;
          const bt = storyTimeByNode.get(b.nodeId) ?? 0;
          return at - bt
            || (arrayIndexByNode.get(a.nodeId) ?? 0) - (arrayIndexByNode.get(b.nodeId) ?? 0);
        });
        keyed.forEach((card, i) => { card.subIndex = i; });
        arr.length = 0;
        arr.push(...keyed);
      } else {
        arr[0]!.subIndex = 0;
      }
    }
  };
  sortCausalBuckets(causalSlots);
  sortCausalBuckets(causalPending);

  // primaryCell 的 subIndex 回填为重排后的真实位次（桶 key 由端点行/列可复算）。
  for (const [nodeId, ep] of primaryCellByNode) {
    const key = `${ep.lineId}|${ep.colValue}`;
    const arr = ep.colValue === PENDING_COLUMN_SENTINEL
      ? causalPending.get(key)
      : causalSlots.get(key);
    const idx = arr?.findIndex((c) => c.nodeId === nodeId) ?? -1;
    if (idx >= 0) ep.subIndex = idx;
    else primaryCellByNode.delete(nodeId); // defensive — 不应发生（同源插入）
  }

  // 边锚定：primary cell 缺失（无 valid lineTag）→ 跳过（validateSceneGraph 另旗）。
  const edges: SharedEdgePos[] = [];
  for (const edge of graph.edges) {
    const from = primaryCellByNode.get(edge.from);
    const to = primaryCellByNode.get(edge.to);
    if (!from || !to) continue;
    edges.push({
      edgeId: edge.id,
      type: edge.type,
      from: { ...from },
      to: { ...to },
    });
  }

  return {
    rows,
    cols,
    chapterTrackCount: maxChapterIndex + 1,
    slots,
    pendingByLine,
    causalSlots,
    causalPending,
    primaryCellByNode,
    edges,
  };
}
