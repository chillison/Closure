/**
 * dogfood R2 批次 A（详设 SP-1/SP-3）：场景/线生命的纯 action 构造层 + 拖拽写通道
 * 纯函数（SCENE_DRAG_MIME 编解码单源 + applyChapterDrop/applyPendingDrop 落图——
 * 自 useTimelineEdit/useWeavingEdit 收拢，hook 退化为唯一 I/O 缝）。
 *
 * 双通道铁律（research/ui-design-outline-timeline.md「两条铁律」1）：本模块产出的
 * 每个数组都喂 `applySceneGraphActions`（shared-contracts scene-graph-analytics）投影后
 * `updateField('scene_graph', …)` ——与 AI 工具 scene_graph_update 走**同一投影器、同一
 * 写缝**。UI 手势不新造写通道，也不存在 UI 独有的编辑能力。
 *
 * 级联语义（先读投影器再定稿，文案据实）：
 * - `remove_scene` 投影器**不级联删边**（scene-graph-analytics.ts docstring：「不级联
 *   （remove_scene 不自动清残留 edge——校验/可达性会暴露，保持机械可预测）」）。UI 删除
 *   场景是显式作者意图，残留 dangling edge 只会产校验噪音——故 `buildRemoveSceneActions`
 *   在**action 数组层**补齐 remove_edge（每条触及边一枚）+ remove_scene。投影器本身不动。
 * - `remove_line` 投影器**不摘除节点 lineTags**（仅按 id 过滤 lines 数组）。同理由
 *   `buildRemoveLineActions` 在数组层补 update_scene（每场景摘掉该 tag，场景保留）。
 *
 * 范式判据：全部为确定性结构操作（id 算术 + 集合过滤），零语义判断。纯函数、输入不
 * 变异，导出供单测。
 */
import type { z } from 'zod';
import type {
  EpisodeAction,
  SceneEdge,
  SceneGraph,
  SceneGraphAction,
  SceneNodeRole,
} from '@orison/shared-contracts';
import { episodeOutlineSchema } from '@orison/shared-contracts';
import {
  PENDING_CHAPTER_SENTINEL,
  resolveSceneChapterRange,
} from './workbenchLayout';

type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

// ── id 生成（`S-{max+1 起始 1}` 约定）──

/**
 * 在 `ids` 中找形如 `{prefix}-{n}` 的数值后缀最大值，返回 `prefix-{max+1}`；无匹配时
 * 从 1 起。非该形态的既有 id（story-planner 语义 id 如 `n_anchor` / `l_main`）不可能与
 * 生成的 `prefix-n` 撞名——同前缀的数值 id 已被 max 覆盖。纯函数。
 */
export function nextIdWithPrefix(ids: string[], prefix: string): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}-${max + 1}`;
}

/** 下一个场景 id（`S-1` 起步，跳过既有 `S-n`）。 */
export function nextSceneId(graph: SceneGraph): string {
  return nextIdWithPrefix(graph.nodes.map((n) => n.id), 'S');
}

/** 下一条线 id（`L-1` 起步）。 */
export function nextLineId(graph: SceneGraph): string {
  return nextIdWithPrefix(graph.lines.map((l) => l.id), 'L');
}

/** 下一条边 id（`E-1` 起步）。 */
export function nextEdgeId(graph: SceneGraph): string {
  return nextIdWithPrefix(graph.edges.map((e) => e.id), 'E');
}

// ── SP-1 新建场景 ──

export type AddSceneInput = {
  /**
   * 故事时序（机械默认）。08-26 批 7：因果骨架换轴章轴后，UI 建场景不再由列值
   * 提供 storyTime——调用方传 max+1 之类的中性默认；列语义（章归属）走
   * presentationOrder。
   */
  storyTime: number;
  /** 默认归属线（当前聚焦线 ∥ 第一条主线，调用方解析后传入）。 */
  lineTags: string[];
  /** 空标题省略（schema title.min(1)——空串无意义，缺省回退显示 id）。 */
  title?: string;
  role?: SceneNodeRole;
  /**
   * 呈现序显式指定（批 7 章轴：因果列头「＋」建场景时传 {chapter, pos}——章归属
   * 即所见即所得）。缺省时 schema 默认 {0,0} 兜底。
   */
  presentationOrder?: { chapter: number; pos: number };
};

/**
 * 构造 add_scene action（id 自动 `S-{max+1}`）。storyTime 钳为非负整数（schema 约束）；
 * chapter 同钳。纯函数；返回单个 action（调用方包成数组喂投影器）。
 */
/**
 * 构造 add_scene action（id 自动 `S-{max+1}`）。storyTime/chapter/pos 全走
 * `clampStoryTime` 单一钳制（NaN/负/小数 → 非负整数；schema 契约）；**省略分支具化
 * 默认 `{ chapter: 0, pos: 0 }`**（CR 组 3c：创建流程不再生产缺 presentationOrder 的
 * 形态——drop 处理器对无章数据拒写，schema 默认兜底改为显式产出，读写两路同形）。
 * 纯函数；返回单个 action（调用方包成数组喂投影器）。
 */
export function buildAddSceneAction(graph: SceneGraph, input: AddSceneInput): SceneGraphAction {
  const base = {
    id: nextSceneId(graph),
    storyTime: clampStoryTime(input.storyTime),
    role: input.role ?? 'normal' as const,
    lineTags: [...input.lineTags],
    ...(input.title ? { title: input.title } : {}),
    presentationOrder: input.presentationOrder
      ? {
          chapter: clampStoryTime(input.presentationOrder.chapter),
          pos: clampStoryTime(input.presentationOrder.pos),
        }
      : { chapter: 0, pos: 0 },
  };
  return {
    op: 'add_scene',
    scene: base,
  };
}

/** 全图最大 storyTime 的下一档（新建场景的中性机械默认；空图 → 0）。 */
export function nextStoryTime(graph: SceneGraph): number {
  let max = -1;
  for (const n of graph.nodes) {
    if (Number.isFinite(n.storyTime) && n.storyTime > max) max = n.storyTime;
  }
  return max + 1;
}

/**
 * 某一章内「下一个可用的 pos 追加位次」（新建场景的排序键——章内按 pos 排序后追加
 * 到末尾）。CR 组 3c 重构：**maxPos+1 算术替成员计数**——既有场景被删出空洞时（pos
 * {0,2}）成员计数会把新场景追加到已占用的 2 上撞位；取最大 pos+1 才是真正的章尾。
 *
 * 入参归一：非有限/负/小数 chapter 钳为非负整数（与 clampStoryTime 同域），残缺输入
 * 回 0 而非静默失配。`episodes` 可选传入时，归属判定并入 presentationSpans range
 * **起点**计数（跨章场景占据其起始章格——新场景应排其后）；缺省回退裸
 * presentationOrder.chapter 口径（无 episode 数据的调用面）。
 */
export function countScenesInChapter(
  graph: SceneGraph,
  chapter: number,
  episodes?: EpisodeOutline[]
): number {
  const ch = Number.isFinite(chapter) ? Math.max(0, Math.floor(chapter)) : -1;
  if (ch < 0) return 0;
  let byId: Map<string, EpisodeOutline> | undefined;
  let byIndex: Map<number, EpisodeOutline> | undefined;
  if (episodes !== undefined && Array.isArray(episodes)) {
    const eps = [...episodes];
    byId = new Map(eps.map((e) => [e.id, e] as const));
    byIndex = new Map(eps.map((e) => [e.index, e] as const));
  }
  const occupiesChapter = (node: SceneGraph['nodes'][number]): boolean => {
    // 有 episode 数据时解析口径即真值（spans 起点章 / episodeId 章 / 章号命中）；
    // 解析失败（dangling——进待编排列）不计入任何真实章。无数据回退裸章号。
    if (byId && byIndex) {
      const range = resolveSceneChapterRange(node, byId, byIndex);
      return range?.colStart === ch;
    }
    return node.presentationOrder?.chapter === ch;
  };
  let maxPos = -1;
  for (const node of graph.nodes) {
    if (!occupiesChapter(node)) continue;
    const rawPos = node.presentationOrder?.pos;
    if (typeof rawPos === 'number' && Number.isFinite(rawPos)) {
      maxPos = Math.max(maxPos, Math.floor(rawPos));
    }
  }
  return maxPos + 1;
}

/** 解析新建场景的默认归属线：当前聚焦线优先，缺省回退第一条主线，再回退首线。 */
export function resolveDefaultLineId(
  graph: SceneGraph,
  focusedLineId: string | null
): string | undefined {
  if (focusedLineId && graph.lines.some((l) => l.id === focusedLineId)) return focusedLineId;
  return (graph.lines.find((l) => l.is_main_thread) ?? graph.lines[0])?.id;
}

// ── SP-1 删除场景（边级联在数组层补齐）──

/** 触及该节点的全部边（入边 + 出边）。确认文案「将断开 N 条因果边」的 N 由此计。 */
export function edgesTouchingNode(graph: SceneGraph, nodeId: string): SceneEdge[] {
  return graph.edges.filter((e) => e.from === nodeId || e.to === nodeId);
}

/**
 * 删除场景的 action 批次：先逐边 remove_edge（投影器 remove_scene 不级联——数组层补齐，
 * 免得校验面板立刻冒 dangling-edge-endpoint 噪音），再 remove_scene。节点不存在返回空
 * 数组（调用方 no-op）。纯函数。
 */
export function buildRemoveSceneActions(graph: SceneGraph, nodeId: string): SceneGraphAction[] {
  if (!graph.nodes.some((n) => n.id === nodeId)) return [];
  return [
    ...edgesTouchingNode(graph, nodeId).map((e) => ({ op: 'remove_edge', id: e.id }) as const),
    { op: 'remove_scene', id: nodeId } as const,
  ];
}

// ── SP-3 线管理 ──

/** 归属该线的场景数。删线确认文案「M 场景将从该线移除归属（场景保留）」的 M 由此计。 */
export function countScenesOnLine(graph: SceneGraph, lineId: string): number {
  return graph.nodes.filter((n) => n.lineTags.includes(lineId)).length;
}

/** 构造 add_line action（id 自动 `L-{max+1}`、topology_role 默认 converging）。 */
export function buildAddLineAction(graph: SceneGraph, name: string): SceneGraphAction {
  return {
    op: 'add_line',
    line: { id: nextLineId(graph), name, topology_role: 'converging' },
  };
}

/**
 * 删除线的 action 批次：先逐场景 update_scene 摘除该 lineTag（投影器 remove_line 不摘
 * tag——数组层补齐，否则全线场景立刻 dangling-line-tag），再 remove_line。线不存在返回
 * 空数组。**场景保留**（删线 ≠ 删场景——update_scene 只改 lineTags）。纯函数。
 */
export function buildRemoveLineActions(graph: SceneGraph, lineId: string): SceneGraphAction[] {
  if (!graph.lines.some((l) => l.id === lineId)) return [];
  const stripActions = graph.nodes
    .filter((n) => n.lineTags.includes(lineId))
    .map((n) => ({
      op: 'update_scene',
      scene: { id: n.id, lineTags: n.lineTags.filter((t) => t !== lineId) },
    }) as const);
  return [...stripActions, { op: 'remove_line', id: lineId } as const];
}

// ── SP-2 抽屉连边 ──

/** 同向重复边（from→to 有序对已存在，不同 type 也算重复——同对双 type 是冗余结构）。 */
export function hasEdgeBetween(graph: SceneGraph, from: string, to: string): boolean {
  return graph.edges.some((e) => e.from === from && e.to === to);
}

/**
 * 构造 add_edge action（id 自动 `E-{max+1}`）。自环（from===to）或同向重复边返回 null
 * ——调用方禁用按钮/静默 no-op（确定性结构校验，非语义判断）。纯函数。
 */
export function buildAddEdgeAction(
  graph: SceneGraph,
  input: { from: string; to: string; type: SceneEdge['type'] }
): SceneGraphAction | null {
  if (input.from === input.to) return null;
  if (hasEdgeBetween(graph, input.from, input.to)) return null;
  return { op: 'add_edge', edge: { id: nextEdgeId(graph), ...input } };
}

// ── SP-2 storyTime 钳制 ──

/** schema `number().int().nonnegative()` 的钳制（NaN → 0）。 */
export function clampStoryTime(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

// ── D2 新增节点高亮 diff（纯函数，供单测）──

/**
 * diff 前后两图的节点 id 集，返回**新增**的 id 列表（保持 next 中的出现序）。任一侧
 * 缺省（首次 hydration / 图被清）返回空——高亮只在「有前态可比的 agent 落盘」时触发。
 */
export function diffAddedNodeIds(
  prev: SceneGraph | undefined,
  next: SceneGraph | undefined
): string[] {
  if (!prev || !next) return [];
  const prevIds = new Set(prev.nodes.map((n) => n.id));
  return next.nodes.filter((n) => !prevIds.has(n.id)).map((n) => n.id);
}

// ── 拖拽写通道（CR 组 5/3c 批 A）：拖拽载荷编码 + 落章/撤章纯函数 ──
//
// 写通道裁决注记（prd 组5「拖拽写通道绕投影器」，二选一的落地选择：文档化例外）：
// 四类 drop 手势直构下一张 SceneGraph 塞 `updateField('scene_graph', …)`，未经
// `applySceneGraphActions` 投影器。理由：chapter_assign/pending_unassign 需要新增
// action op 类型与投影语义，落点在 shared-contracts/shell（本批次文件面之外）；且
// 手势写入是单字段机械变异，与 ± 章按钮的「直写字段」写缝同构。**例外已在此声明**
// ——后续若增补 op 类型，两 hook 的 updateField 调用点切换为 applyActions 即收口。

/** 场景拖拽的 MIME 类型（HTML5 dataTransfer；因果骨架/工作台共享同一常量——单源）。 */
export const SCENE_DRAG_MIME = 'application/x-orison-scene-drag';

export type SceneDragPayload = { nodeId: string };

export function encodeDragPayload(payload: SceneDragPayload): string {
  return JSON.stringify(payload);
}

/**
 * Decode a drag payload from `dataTransfer.getData(...)`. Returns null on any
 * shape mismatch so callers can treat "not a scene drag" and "malformed" the
 * same way (ignore). **Accepts payloads with or without the legacy `mode`
 * field**（CR 组 3c 裁决 2B：「跨区拖=挪章」为正式契约——工作台不再以 mode 区分
 * 来源，mode 只作信息随行）。Pure + total — never throws.
 */
export function decodeDragPayload(raw: string | null | undefined): SceneDragPayload | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      typeof v === 'object'
      && v !== null
      && typeof (v as { nodeId?: unknown }).nodeId === 'string'
    ) {
      return v as SceneDragPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// ── drop 落图纯函数（自 useTimelineEdit/useWeavingEdit 收拢至本模型层——hook 只是
//    I/O 缝；「待编排落点跨 hook import 异味」随迁移消除）──

/**
 * 解析态判定：该节点是否已经处于目标状态（内容相等）。由 drop 写入方判断：
 * 内容相等 → 原引用返回（引用级 no-op——handler 靠 `next === graph` 跳过整次
 * updateField，版本 bump / undo 入栈 / sync IPC 落盘零发生）。
 */
function hasChapterShadows(node: SceneGraph['nodes'][number]): boolean {
  // presentationSpans（1.8 起优先解析口径）/ episodeId（legacy 单章）都会遮蔽
  // presentationOrder.chapter 的写入（resolveSceneChapterRange 三级序在前）。
  return node.presentationSpans !== undefined || node.episodeId !== undefined;
}

/**
 * Causal/workbench 共用的落章手势（批 7 章轴语义；CR 组 5 P0 ghost-write 修复）:
 * 把被拖场景的归属改写为目标的 presentationOrder.chapter，并**先剥去会遮蔽该写入的
 * 表现层字段（presentationSpans / episodeId）**——三级解析序里它们排在 chapter 前，
 * 不剥则写入被遮蔽（ghost write：版本+1/undo 入栈/落盘全发生、视觉不动，「拖回待
 * 编排」同样失效）。pos 保持不变（同章内排序键不受换章影响）。
 *
 * No-op：目标章与现状一致且无遮蔽字段 → 返回**原引用**。防御：非有限 target（NaN
 * 直通 Math.floor 会把 NaN 章写进 schema int 域）→ 原图；nodeId 未知或节点缺
 * presentationOrder → 原图不改写（编辑路径不比渲染路径脆）。
 * Pure — input never mutated。
 */
export function applyChapterDrop(
  graph: SceneGraph,
  nodeId: string,
  targetChapter: number
): SceneGraph {
  if (!Number.isFinite(targetChapter)) return graph;
  const clamped = Math.max(0, Math.floor(targetChapter));
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (node.id !== nodeId || !node.presentationOrder) return node;
    if (node.presentationOrder.chapter === clamped && !hasChapterShadows(node)) return node;
    changed = true;
    const { presentationSpans: _stripSpans, episodeId: _stripEpisodeId, ...rest } = node;
    return { ...rest, presentationOrder: { ...node.presentationOrder, chapter: clamped } };
  });
  return changed ? { ...graph, nodes } : graph;
}

/**
 * 待编排落点（#63 拖回待编排 = 撤章归属；CR 组 5 P0 同修）：章号改写为
 * PENDING_CHAPTER_SENTINEL 并**剥去 presentationSpans / episodeId**（同款遮蔽守卫
 * ——否则带 spans 的场景拖回待编排恒被解析序吃掉）。pos 保持不变（pending 内序与
 * pos 无关）。No-op：已是哨兵章且无遮蔽字段 → 返回**原引用**。防御同上。Pure。
 */
export function applyPendingDrop(graph: SceneGraph, nodeId: string): SceneGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (
      node.id !== nodeId
      || !node.presentationOrder
      || (node.presentationOrder.chapter === PENDING_CHAPTER_SENTINEL && !hasChapterShadows(node))
    ) {
      return node;
    }
    changed = true;
    const { presentationSpans: _stripSpans, episodeId: _stripEpisodeId, ...rest } = node;
    return {
      ...rest,
      presentationOrder: { ...node.presentationOrder, chapter: PENDING_CHAPTER_SENTINEL },
    };
  });
  return changed ? { ...graph, nodes } : graph;
}

// ── R6 方案 D（08-27-structure-fixes design §6.3）：按列号的占用区间改写 + 列命中 ──

/**
 * 把节点的章占用区间重写为 `[newStartCol..newEndCol]`（episodeId 按 index 反查）。
 * 方案 D 边缘直拖与「宽卡整区间平移」共用的单条 op——所有 span 区间写通道收口于此。
 *
 * 规则（design §6.3「单源契约」段 + CR 三轮拍板/修补）：
 * - no-op → **原引用**：非数组 episodes / 列号非法（非有限、newEnd<newStart、负起点）/
 *   **区间内任一章未建（整区间守卫——含两端点之间的内部 gap，CR3 G-F1）**、
 *   节点缺席或解析 miss（dangling·sentinel）/ 结果区间与现状等。
 * - 重写恒**剥去遮蔽字段**（presentationSpans + episodeId）：legacy 残锚若留下，缩回
 *   单章时会在解析序下复活跳位（ghost resurrection）；spans 是更高解析级，旧值必剥。
 * - 单章结果 = **删除 spans 字段**（规范形，applyRemoveChapter F3 同款——1 元素数组
 *   与 undefined 在 shallowNodeEqual 下不等价）。
 * - 首章变化时同步 `presentationOrder={chapter:newStart,pos:0}`，且多章结果的
 *   **spans[0].pos 一并归 0**（CR3 拍板：跨章平移不搬运旧章 pos——新章已有同位次
 *   场景时会撞号；presentationOrder 与 spans 首段同持「阅读起始位」）；首章未变则
 *   保留原 po 与原 pos（右缘增删不动格内序）。
 * - storyTime 零触碰。多线节点是节点级字段——全部 chip 随动（渲染面自然成立）。
 *
 * Pure — input never mutated.
 */
export function applyResizeSpanRange(
  graph: SceneGraph,
  nodeId: string,
  newStartCol: number,
  newEndCol: number,
  episodes: EpisodeOutline[]
): SceneGraph {
  if (!Array.isArray(episodes)) return graph;
  if (!Number.isFinite(newStartCol) || !Number.isFinite(newEndCol)) return graph;
  const start = Math.floor(newStartCol);
  const end = Math.floor(newEndCol);
  if (end < start || start < 0) return graph;
  const byId = new Map(episodes.map((e) => [e.id, e] as const));
  const byIndex = new Map(episodes.map((e) => [e.index, e] as const));
  // 整区间守卫（CR3 G-F1）：[start..end] **任一章**未建（含区间内部 gap）→ 原引用
  // 拒收。旧形态只验两端点，中间缺号在构建循环里 break 截断——写出「既非请求值也
  // 非原状态」的窄区间，截断到首段时更是 1 元素 spans 数组（违反单章规范形）。
  // 承诺整区间合法才兑现（gap 拒收纪律同族——承诺不可兑现就不兑现）。
  const spanEps: EpisodeOutline[] = [];
  for (let c = start; c <= end; c++) {
    const ep = byIndex.get(c);
    if (!ep) return graph;
    spanEps.push(ep);
  }

  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const current = resolveSceneChapterRange(node, byId, byIndex);
    if (!current) return node; // dangling/sentinel——无章语义可重写
    if (current.colStart === start && current.colEnd === end) return node; // 引用级 no-op

    changed = true;
    const { presentationSpans: _stripSpans, episodeId: _stripEpisodeId, ...rest } = node;
    const basePo = node.presentationOrder ?? { chapter: start, pos: 0 };
    // CR3 拍板：首章变化 → po 与 spans[0].pos 同步归 0（不撞新章既有位次）；
    // 首章未变 → 沿用原 pos（右缘增删不动格内序）。
    const moved = current.colStart !== start;
    const nextPo = moved ? { chapter: start, pos: 0 } : { ...basePo, chapter: start };
    const firstPos = moved
      ? 0
      : typeof basePo.pos === 'number' && Number.isFinite(basePo.pos)
        ? Math.max(0, Math.floor(basePo.pos))
        : 0;

    if (start === end) {
      // 单章规范形：无 spans 字段 + 无 legacy 残锚。
      return { ...rest, presentationOrder: nextPo };
    }
    // 多章 spans：首段持新起点 pos（首章变化=0，CR3 拍板），余段 0。
    const spans: { episodeId: string; pos: number }[] = spanEps.map((ep, i) => ({
      episodeId: ep.id,
      pos: i === 0 ? firstPos : 0,
    }));
    return { ...rest, presentationOrder: nextPo, presentationSpans: spans };
  });
  return changed ? { ...graph, nodes } : graph;
}

/**
 * 工作台槽位落点的目标列命中（§6.3 T1 实测梯的纯反查）。输入 = `.workbench-slot`
 * **槽位**矩形表——非列头（CR3 G-F8 JSDoc 修正：gap 章无列头但有槽位，其轨道区段由
 * 真实几何保留在表内；本函数只管**几何命中**，命中 gap 列后是否可写由调用方
 * episodeIndexSet 门槛拒收——§6.3「rect 表给出真实 index、episodeIndexSet 门槛判定
 * 该 index 是否可写」的分工）。**screen px 自洽系**：clientX 与
 * getBoundingClientRect 同量纲同原点，zoom 已含在 rect 里——不得再 ÷zoom。输出 =
 * 命中列的 episode index 或 null（拒收）。
 *
 * 裁定：
 * - 表外（首列左缘之前 / 末列右缘之后）→ null。右侧紧邻区已是待编排列带，隐式
 *   clamp 会把投掷误送末章；左侧是泳道标签带。
 * - 两列之间的缝隙（布局缝）→ null——拒收纪律的同族表达。
 * - gap 章的槽位在表内 → 几何命中该 gap index（可写与否归上游门槛，不在本函数）。
 * Pure & total — never throws；entries 全坏/空表 → null（调用方回退面锚梯）。
 */
export type ColumnRectEntry = { index: number; left: number; width: number };

export function columnIndexFromRects(
  entries: readonly ColumnRectEntry[],
  clientX: number
): number | null {
  if (!Number.isFinite(clientX)) return null;
  const clean = entries
    .filter((e) =>
      Number.isInteger(e.index)
      && Number.isFinite(e.left)
      && Number.isFinite(e.width)
      && e.width > 0
    )
    .sort((a, b) => a.left - b.left);
  if (clean.length === 0 || clientX < clean[0]!.left) return null;
  for (const entry of clean) {
    if (clientX < entry.left) return null; // 落在前一列右缘与本列左缘的缝里
    if (clientX < entry.left + entry.width) return entry.index;
  }
  return null; // 末列右缘之外
}

/**
 * 「在第 N 章新建场景」action 构造单源（因果列头 ＋ 与工作台槽位钮共用——同一
 * 机械语义：storyTime=全图 max+1 中性默认、默认线=聚焦线∥主线、pos 追加章尾）。
 * 图缺/线缺容忍：返回 action 时 lineTags 可为空数组（schema 允许——场景先建后归线）。
 */
export function buildNewSceneAtChapterAction(
  graph: SceneGraph,
  chapterIdx: number,
  opts: {
    /** 章内位次计数的数据源（缺省回退裸 po 口径）。 */
    episodes?: EpisodeOutline[];
    /** 默认归属线候选（当前聚焦线）。 */
    focusedLineId?: string | null;
  } = {}
): Extract<SceneGraphAction, { op: 'add_scene' }> {
  const lineId = resolveDefaultLineId(graph, opts.focusedLineId ?? null);
  const action = buildAddSceneAction(graph, {
    storyTime: nextStoryTime(graph),
    lineTags: lineId ? [lineId] : [],
    presentationOrder: {
      chapter: clampStoryTime(chapterIdx),
      pos: countScenesInChapter(graph, chapterIdx, opts.episodes),
    },
  });
  if (action.op !== 'add_scene') {
    // op 断言（CR3 G-edge）：窄化替代盲转型——buildAddSceneAction 契约恒产 add_scene
    // （字面 op），此分支按构造不可达；若未来 op 面扩出变种，在此早失败（两面板的
    // action.scene.id 取值不再下游炸 undefined）。
    throw new Error(
      `buildNewSceneAtChapterAction: buildAddSceneAction produced unexpected op '${String(action.op)}'`
    );
  }
  return action;
}

// ── R11 批3（08-27 追加需求批 3 / CR3 拍板转化）：插入新章 op ──

/** 插入新章的双字段 action 批次（「在两章间插入新章」入口的写通道单源）。 */
export type InsertChapterPlan = {
  /** 新章 episode id（`ep-{max+1}` 约定；调用方建后反馈用）。 */
  episodeId: string;
  /**
   * episode_outlines 投影批次（喂 `applyEpisodeActions`）：既有 index >= k 的章逐枚
   * update_episode（patch 只写 index+1）+ add_episode（新章落 k，机械默认显式补齐）。
   */
  episodeActions: EpisodeAction[];
  /**
   * scene_graph 投影批次（喂 `applySceneGraphActions`）：裸 presentationOrder.chapter
   * >= k 的场景逐枚 update_scene（chapter+1，pos 原样）。空数组 = 本图无位移面——
   * 调用方跳过该字段写（引用级 no-op 纪律：无变更字段不 bump 版本/不进 undo 栈）。
   */
  sceneActions: SceneGraphAction[];
};

/**
 * 构造「在 index k 插入新章」的双字段批次（R11 批3；两区列头菜单共用单源）。
 *
 * 语义（prd 批3「动 outline 章表，byId 引用使既有 spans 安全漂移」+ design §6.3）：
 * - episode_outlines：新章落 index k；既有 index >= k 的章全体 +1（k 后整体右移——
 *   projector 自身永不 renumber 的纪律下，显式排序决策由本构造层承担）。
 * - scene_graph：**裸** presentationOrder.chapter >= k 的场景同步 +1——裸章号与
 *   episode.index 同处一个章号空间，整体右移保持相对关系（含被 spans/episodeId
 *   遮蔽的裸值：遮蔽解除后仍落在正确章）。哨兵（PENDING_CHAPTER_SENTINEL，待编排）
 *   不动；presentationSpans / episodeId 按 episodeId 引用——章表 index 漂移后解析
 *   口径天然跟随，零触碰（byId 引用的漂移安全性）。storyTime / lineTags / edges
 *   零触碰。
 *
 * 防御：非数组 episodes / insertAt 非有限 → null（调用方 no-op）；insertAt 负数钳 0。
 * pos 原样保留（章内位次与插入章无关；schema pos 必填，残缺输入钳 0 兜底）。
 * Pure — input never mutated.
 */
export function buildInsertChapterActions(
  graph: SceneGraph,
  episodes: EpisodeOutline[],
  insertAt: number,
  newEpisodeTitle: string
): InsertChapterPlan | null {
  if (!Array.isArray(episodes)) return null;
  if (!Number.isFinite(insertAt)) return null;
  const k = Math.max(0, Math.floor(insertAt));
  const episodeId = nextIdWithPrefix(episodes.map((e) => e.id), 'ep');
  // 机械默认显式补齐（mirror applyEpisodeActions add 分支契约「episode 已过
  // episodeOutlineSchema，defaults 已填」——UI 侧不经 schema parse，由构造层保证
  // 写出的章即刻 schema-shaped）。
  const episodeActions: EpisodeAction[] = [
    ...episodes
      .filter((e) => e.index >= k)
      .map((e) => ({
        op: 'update_episode' as const,
        episodeId: e.id,
        patch: { index: e.index + 1 },
      })),
    {
      op: 'add_episode' as const,
      episode: {
        id: episodeId,
        index: k,
        title: newEpisodeTitle,
        character_progressions: [],
        emotional_beats: [],
        pacing_beats: [],
        foreshadowing: [],
        payoffs: [],
        dependsOn: [],
        status: 'planned',
      },
    },
  ];
  const sceneActions: SceneGraphAction[] = [];
  for (const node of graph.nodes) {
    const po = node.presentationOrder;
    if (!po) continue;
    const rawChapter = po.chapter;
    if (typeof rawChapter !== 'number' || !Number.isFinite(rawChapter)) continue;
    const ch = Math.max(0, Math.floor(rawChapter));
    if (ch === PENDING_CHAPTER_SENTINEL) continue; // 待编排哨兵不动
    if (ch < k) continue;
    sceneActions.push({
      op: 'update_scene',
      scene: {
        id: node.id,
        presentationOrder: {
          chapter: ch + 1,
          pos:
            typeof po.pos === 'number' && Number.isFinite(po.pos)
              ? Math.max(0, Math.floor(po.pos))
              : 0,
        },
      },
    });
  }
  return { episodeId, episodeActions, sceneActions };
}
