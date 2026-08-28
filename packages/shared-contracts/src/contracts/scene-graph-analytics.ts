// Scene-graph analytics — pure-code utilities over SceneGraph.
// Story 1.2 landed lineTags reference-integrity check + topology_role → validation
// profile routing declaration. Story 1.3 lands the validation layer itself:
// CAUSAL DAG cycle detection + Type 1 converging reachability + Type 2 mesh mapping
// existence + profile dispatch + structured Issue type + art-mode override downgrade.
//
// 范式判据 (ADR-3 / .trellis/spec/core/creative-vs-mechanical.md): all logic here is
// deterministic reference/topology routing — "does not understand meaning". Anchor
// placement, Thread-role semantics, issue detection that needs semantic judgement
// remain LLM-side. No LLM calls, no subjective thresholds.

import type { LineTopologyRole, SceneArtOverride, SceneGraph, SceneGraphAction, SceneNode, SceneEdge, SceneLine } from './creative-fields';

// ── lineTags reference integrity (Story 1.2 D5) ──
// 1.2 唯一落地的纯代码校验（字段 1.1 已落、确定性 ref 检查、即时消费者）。
// lineTags 引用 Line.id；引用不存在的 line = dangling。校验归纯代码 utility
// （非 Zod refine —— 跨节点需全 graph，schema 内省不适合）。

export interface DanglingLineTag {
  /** SceneNode.id that carries the dangling tag(s). */
  node: string;
  /** lineTags values that do not match any Line.id. */
  danglingTags: string[];
}

/**
 * 找出所有引用了不存在 Line.id 的 lineTags。
 * 返回空数组 = 所有 lineTags 都解析到 line（无 dangling）。
 */
export function findDanglingLineTags(graph: SceneGraph): DanglingLineTag[] {
  const lineIds = new Set(graph.lines.map((l) => l.id));
  return graph.nodes
    .filter((n) => n.lineTags.some((t) => !lineIds.has(t)))
    .map((n) => ({
      node: n.id,
      danglingTags: n.lineTags.filter((t) => !lineIds.has(t))
    }));
}

// ── Story 1.3 edit-path projection (design §1.2 / §4) ──
// bounded action 枚举 → 完整 graph 投影。shell handler 调此函数把 LLM 提议的 actions
// 投影成完整 graph 进 field_patch（action:'set'），与 outline_update 全量 data 同形，
// UI patch-review 不变。纯机械应用（add/update/remove by id），不做校验——校验归
// validateSceneGraph。范式：确定性结构变换，零语义判断。

// add 新条目时的机械默认（与 schema 默认一致：role 'normal' / lineTags [] /
// storyTime 0 / presentationOrder {0,0}；line: topology_role 'converging' /
// displacement 'none' / visibility open）。保证投影后 graph schema-valid（落盘 reload
// 不 corrupt）。add 接收 partial（设计 §1.2）；缺省字段填默认。
const SCENE_DEFAULTS = {
  storyTime: 0,
  presentationOrder: { chapter: 0, pos: 0 },
  role: 'normal' as const,
  lineTags: [] as string[],
};
const LINE_DEFAULTS = {
  topology_role: 'converging' as const,
  displacement: 'none' as const,
  visibility: { status: 'open' as const },
};

/**
 * 应用 bounded actions 到 graph，产出投影后的完整 graph（design §1.2 edit-path）。
 *
 * 语义（mechanical by id）：
 * - add_scene/add_edge/add_line: upsert。id 不存在 → 追加（partial 字段填机械默认）；
 *   id 已存在 → 浅合并（不丢既有字段，LLM 重提同 id = 修订）。
 * - update_scene/update_line: id 存在 → 浅合并 partial；不存在 → no-op（不能更新不存在的条目）。
 * - remove_scene/remove_edge/remove_line: 按 id 过滤；不存在 → no-op。不级联（remove_scene
 *   不自动清残留 edge——校验/可达性会暴露，保持机械可预测）。
 *
 * 不做 schema re-parse（输入 graph 已 parsed；默认与 schema 一致；actions 已独立 parse）。
 */
export function applySceneGraphActions(
  graph: SceneGraph,
  actions: SceneGraphAction[]
): SceneGraph {
  let nodes = [...graph.nodes];
  let edges = [...graph.edges];
  let lines = [...graph.lines];

  for (const action of actions) {
    switch (action.op) {
      case 'add_scene': {
        const idx = nodes.findIndex((n) => n.id === action.scene.id);
        if (idx === -1) {
          nodes.push({ ...SCENE_DEFAULTS, ...action.scene } as SceneNode);
        } else {
          nodes[idx] = { ...nodes[idx], ...action.scene };
        }
        break;
      }
      case 'update_scene': {
        const idx = nodes.findIndex((n) => n.id === action.scene.id);
        if (idx !== -1) nodes[idx] = { ...nodes[idx], ...action.scene };
        break;
      }
      case 'remove_scene': {
        nodes = nodes.filter((n) => n.id !== action.id);
        break;
      }
      case 'add_edge': {
        const idx = edges.findIndex((e) => e.id === action.edge.id);
        if (idx === -1) {
          edges.push({ ...action.edge } as SceneEdge);
        } else {
          edges[idx] = { ...edges[idx], ...action.edge };
        }
        break;
      }
      case 'remove_edge': {
        edges = edges.filter((e) => e.id !== action.id);
        break;
      }
      case 'add_line': {
        const idx = lines.findIndex((l) => l.id === action.line.id);
        if (idx === -1) {
          lines.push({ ...LINE_DEFAULTS, ...action.line } as SceneLine);
        } else {
          lines[idx] = { ...lines[idx], ...action.line };
        }
        break;
      }
      case 'update_line': {
        const idx = lines.findIndex((l) => l.id === action.line.id);
        if (idx !== -1) lines[idx] = { ...lines[idx], ...action.line };
        break;
      }
      case 'remove_line': {
        lines = lines.filter((l) => l.id !== action.id);
        break;
      }
    }
  }

  return { ...graph, nodes, edges, lines };
}

// ── topology_role → validation profile routing (Story 1.2 D4) ──
// 声明表：哪型走哪套校验。Story 1.3 的 checkReachability / checkMeshMapping 基于此
// profile dispatch（mainlineReachability / meshMapping 标志驱动，非硬编码 role 名），
// profile 改表即自动跟随。

export interface ValidationProfile {
  /**
   * Type 1 收敛线：要求每条 converging 线有路径到 convergence_target 锚点
   * (PLOTTER K_N 多线版多根可达 BFS)。1.3 实现。
   */
  mainlineReachability: boolean;
  /**
   * Type 2 网状线：要求 worldEventRef|themeRef 映射存在（§1.7 mesh mapping）。
   * 1.3 实现。
   */
  meshMapping: boolean;
  /**
   * 豁免主线可达性：offline / if-branch / side 本就脱离主线（1.7 self-validation）。
   */
  exempt: boolean;
}

/**
 * topology_role → 校验 profile 路由声明表。
 * checkReachability / checkMeshMapping / validateSceneGraph 经 getValidationProfile 消费。
 */
export const LINE_VALIDATION_PROFILE = {
  'converging':          { mainlineReachability: true,  meshMapping: false, exempt: false },
  'parallel-worldview':  { mainlineReachability: false, meshMapping: true,  exempt: false },
  'offline':             { mainlineReachability: false, meshMapping: false, exempt: true  },
  'if-branch':           { mainlineReachability: false, meshMapping: false, exempt: true  }, // 1.7 self-validation
  'side':                { mainlineReachability: false, meshMapping: false, exempt: true  }
} as const satisfies Readonly<Record<LineTopologyRole, ValidationProfile>>;

/**
 * consumer-facing profile dispatch（1.2 声明、1.3 实现）。
 * 给定 topology_role 返回该校验 profile；checkReachability / checkMeshMapping 据此决定是否跑。
 */
export function getValidationProfile(role: LineTopologyRole): ValidationProfile {
  return LINE_VALIDATION_PROFILE[role];
}

// ── Story 1.3 校验层（design §3）──
// 全部确定性图算法（DFS/BFS/集合存在性），零 LLM 调用、零主观阈值。
// Issue 用叙事语言表述（message），不暴露图论术语 / topology_role 给最终读者。

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface SceneGraphIssue {
  /** issue code，如 'causal-cycle' | 'unreachable-line' | 'missing-mesh-mapping' | 'dangling-line-tag'。 */
  code: string;
  severity: IssueSeverity;
  /** 叙事语言表述（非图论术语）。 */
  message: string;
  /** 牵涉的 node / edge / line。art_overrides.scope 按此 id 限定。 */
  targets: { kind: 'node' | 'edge' | 'line'; id: string }[];
  /** 可选的修复建议（叙事语言）。 */
  suggestion?: string;
}

// 仅 CAUSAL + SUSPENSE 是进 DAG 的前向边（design §6 / sceneEdgeTypeSchema）。
const FORWARD_EDGE_TYPES = new Set(['CAUSAL', 'SUSPENSE']);

/**
 * 构造前向边邻接表（CAUSAL + SUSPENSE）。防御性：edge.from/to 不在 nodes 列表时
 * 仍为其建 key（schema 不强制 edge↔node ref 完整性，纯代码校验须容忍），故 cycle/
 * reachability 不会因幻影端点崩溃。幻影端点本身由 findDanglingEdgeEndpoints 单独
 * 报 dangling-edge-endpoint warning（CR-010），cycle/reachability 结果仍按图结构如实计算。
 *
 * Story 1.7：detectCausalCycle 改 branch-aware 后，canon / 每 branch 各用独立 adjacency；
 * checkReachability 仍用此「全前向边」adjacency（可达性不分 branch——branch 节点经 fork
 * in-edge 可达 canon target 是合法的，不该被分支隔离误判为不可达）。
 */
function buildForwardAdjacency(graph: SceneGraph): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const n of graph.nodes) adjacency.set(n.id, []);
  for (const edge of graph.edges) {
    if (!FORWARD_EDGE_TYPES.has(edge.type)) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)!.push(edge.to);
  }
  return adjacency;
}

// ── Story 1.7: branch-aware 边归属推断（design §3.1，不加 edge 字段）──
// 边归属从端点 origin_ref 推断：canon 边 = 两端点均无 origin_ref；
// 涉及 branch 拷贝（任一端点有 origin_ref）= branch 边，归该拷贝所在 if-branch 线。
// canon cycle 排除所有 branch 边 → 不因 branch 存在报假环（AC1 边级）。

/**
 * 找 branch 拷贝节点所属的 if-branch 线 id（lineTags 中的 if-branch 线）。
 * 退化：lineTags 无 if-branch 线时取首个 lineTag，再退化取 sentinel（防御性，不崩）。
 */
function findBranchLineId(graph: SceneGraph, branchNode: SceneNode): string {
  const branchLine = graph.lines.find(
    (l) => l.topology_role === 'if-branch' && branchNode.lineTags.includes(l.id)
  );
  return branchLine?.id ?? branchNode.lineTags[0] ?? '__unknown_branch';
}

/**
 * 推断前向边归属（design §3.1）。
 * - 两端点 origin_ref 均空 → canon 边，返回 null。
 * - 否则（任一端点为 branch 拷贝）→ branch 边，返回该拷贝所属 if-branch 线 id。
 *   归属优先看 `to` 端点（P→拷贝 fork in-edge 的 to 是拷贝）；merge-back（拷贝→canon）
 *   用 `from` 端点。canon cycle 因此排除所有触及 branch 拷贝的边。
 */
function edgeBranchKey(
  graph: SceneGraph,
  edge: SceneEdge,
  nodeById: Map<string, SceneNode>
): string | null {
  const toNode = nodeById.get(edge.to);
  const fromNode = nodeById.get(edge.from);
  const toHasOrigin = !!toNode?.origin_ref;
  const fromHasOrigin = !!fromNode?.origin_ref;
  if (!toHasOrigin && !fromHasOrigin) return null; // canon 边
  const branchNode = toHasOrigin ? toNode! : fromNode!;
  return findBranchLineId(graph, branchNode);
}

/**
 * 三色 DFS 环检测（显式栈迭代，CR-011/CR-005 深链不溢出）。输入 adjacency → 返回所有环
 * （每个环 = 构成环的 node id 列表）。算法语义：回边到 GRAY = 环，环路径 = 当前 DFS
 * 路径从 v 到 top.node 这一段。
 */
function detectCyclesInAdjacency(adjacency: Map<string, string[]>): string[][] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adjacency.keys()) color.set(id, WHITE);
  const cycles: string[][] = [];

  for (const root of adjacency.keys()) {
    if (color.get(root) !== WHITE) continue;
    const path: string[] = [];
    const stack: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    color.set(root, GRAY);
    path.push(root);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const neighbors = adjacency.get(top.node) ?? [];
      if (top.next < neighbors.length) {
        const v = neighbors[top.next++];
        const c = color.get(v);
        if (c === GRAY) {
          const cycleStart = path.indexOf(v);
          cycles.push(path.slice(cycleStart));
        } else if (c === WHITE) {
          color.set(v, GRAY);
          path.push(v);
          stack.push({ node: v, next: 0 });
        }
        // BLACK = 已完成，跳过。
      } else {
        color.set(top.node, BLACK);
        path.pop();
        stack.pop();
      }
    }
  }
  return cycles;
}

/**
 * CAUSAL + SUSPENSE 前向边 DAG 无环检测（design §3.1 / child3 §2.1 K_C）。
 * 三色 DFS：遇回边（指向当前路径中 GRAY 节点）= 环。
 *
 * Story 1.7 branch-aware（design §3.1）：按 branch 分区（端点 origin_ref 推断归属，不加
 * edge 字段）：canon cycle 排除所有 branch 边（不因 branch 报假环 → AC1）；每 branch 独立
 * cycle 检测（AC2）。canon 环 = error（读者可见情节洞）；branch 环 = warning（if-branch
 * validation warning 级，分支可选内容、严重度低于 canon）。
 *
 * 回归：无 branch（无 origin_ref 节点）时所有前向边归 canon → 与原实现完全等价（同测过）。
 */
export function detectCausalCycle(graph: SceneGraph): SceneGraphIssue[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // 分区：canon adjacency + 每 branch 独立 adjacency（均初始化全 node key，含幻影端点防御）
  const canonAdj = new Map<string, string[]>();
  for (const n of graph.nodes) canonAdj.set(n.id, []);
  const branchAdjs = new Map<string, Map<string, string[]>>();

  for (const edge of graph.edges) {
    if (!FORWARD_EDGE_TYPES.has(edge.type)) continue;
    const branchKey = edgeBranchKey(graph, edge, nodeById);
    let adj: Map<string, string[]>;
    if (branchKey === null) {
      adj = canonAdj;
    } else {
      adj = branchAdjs.get(branchKey) ?? new Map();
      if (!branchAdjs.has(branchKey)) {
        for (const n of graph.nodes) adj.set(n.id, []);
        branchAdjs.set(branchKey, adj);
      }
    }
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    if (!adj.has(edge.to)) adj.set(edge.to, []);
    adj.get(edge.from)!.push(edge.to);
  }

  const issues: SceneGraphIssue[] = [];

  // canon cycle → error
  for (const cycle of detectCyclesInAdjacency(canonAdj)) {
    issues.push({
      code: 'causal-cycle',
      severity: 'error',
      message: '因果链形成闭环：读者会看到一个没有来源的结果，情节出现可见的洞。',
      targets: cycle.map((id) => ({ kind: 'node' as const, id })),
      suggestion: '打断环中某条因果边，或把它改为非因果的关联。'
    });
  }

  // per-branch cycle → warning
  for (const adj of branchAdjs.values()) {
    for (const cycle of detectCyclesInAdjacency(adj)) {
      issues.push({
        code: 'causal-cycle',
        severity: 'warning',
        message: '这条 IF 分支的因果链绕回了它自己：分支里会出现一个没有来源的结果。',
        targets: cycle.map((id) => ({ kind: 'node' as const, id })),
        suggestion: '打断这条分支里的某个环，或把它改为非因果的关联。'
      });
    }
  }

  return issues;
}

/**
 * Type 1 收敛线多根可达（design §3.2 / child3 §2.1 K_N）。
 * 对每条 profile.mainlineReachability=true 的线：BFS 该线节点能否（经前向边）到达
 * convergence_target。不可达 = warning（网状天然松，不 block）。
 * 反向 BFS（从 target 沿反向边扩展）= 一次 per target 求出「能到达 target 的节点集」，
 * 线节点不在集内 = 不可达。
 */
export function checkReachability(graph: SceneGraph): SceneGraphIssue[] {
  const adjacency = buildForwardAdjacency(graph);
  const reverseAdj = new Map<string, string[]>();
  for (const [u, vs] of adjacency) {
    for (const v of vs) {
      if (!reverseAdj.has(v)) reverseAdj.set(v, []);
      reverseAdj.get(v)!.push(u);
    }
  }

  const targetCache = new Map<string, Set<string>>();
  const computeCanReach = (target: string): Set<string> => {
    const cached = targetCache.get(target);
    if (cached) return cached;
    const reachable = new Set<string>([target]);
    const queue: string[] = [target];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const prev of reverseAdj.get(cur) ?? []) {
        if (!reachable.has(prev)) {
          reachable.add(prev);
          queue.push(prev);
        }
      }
    }
    targetCache.set(target, reachable);
    return reachable;
  };

  const issues: SceneGraphIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const line of graph.lines) {
    if (!getValidationProfile(line.topology_role).mainlineReachability) continue;
    // converging 线无 convergence_target = 结构性缺陷（收束线必须收束到某锚点）。
    // 与 §3.3 missing-mesh-mapping 对称：parallel-worldview 缺 worldEventRef/themeRef
    // 报 warning，converging 缺 target 同理报 warning。确定性存在性检查（非语义），
    // 补 prompt 侧 guard 之外的防线（用户手改 yaml 删 target 也兜住）。原 silent-skip
    // 会隐藏该缺陷——data channel 应暴露，不应静默。
    if (!line.convergence_target) {
      issues.push({
        code: 'missing-convergence-target',
        severity: 'warning',
        message: `线「${line.name}」是收束线但没有指定收束锚点，不知道这条线要汇向哪个场景。`,
        targets: [{ kind: 'line' as const, id: line.id }],
        suggestion: '为这条线指定 convergence_target（通常是 core-anchor 场景的 id）。'
      });
      continue; // 无 target 无法做可达性 BFS
    }
    // CR-010/CR-016: convergence_target 指向不存在的 node -> dangling（区别于
    // unreachable-line：修复方向是 target ref 本身，不是因果链）。确定性存在性检查，
    // 兑现 docstring「校验会暴露残留」承诺（remove_scene 不级联 -> 残留 target 由这里报）。
    if (!nodeIds.has(line.convergence_target)) {
      issues.push({
        code: 'dangling-convergence-target',
        severity: 'warning',
        message: `线「${line.name}」的收束锚点「${line.convergence_target}」不存在，这条线不知道汇向哪。`,
        targets: [{ kind: 'line' as const, id: line.id }],
        suggestion: '把 convergence_target 改成已存在的 core-anchor 场景 id，或补上该锚点场景。'
      });
      continue; // target 悬空无法做可达性 BFS
    }
    const lineNodeIds = graph.nodes
      .filter((n) => n.lineTags.includes(line.id))
      .map((n) => n.id);
    if (lineNodeIds.length === 0) continue;
    const canReach = computeCanReach(line.convergence_target);
    const unreachable = lineNodeIds.filter((id) => !canReach.has(id));
    if (unreachable.length > 0) {
      issues.push({
        code: 'unreachable-line',
        severity: 'warning',
        message: `线「${line.name}」有场景接不上收束锚点，这条线可能悬空或断链。`,
        targets: unreachable.map((id) => ({ kind: 'node' as const, id })),
        suggestion: '补上因果链让它通向锚点，或把这条线改为 offline / side 类型。'
      });
    }
  }
  return issues;
}

/**
 * Type 2 网状映射存在性（design §3.3 / child3 §1.7/§2.1）。
 * 对每条 profile.meshMapping=true 的线：要求 worldEventRef | themeRef 至少有一个。
 * 缺 = warning。无 parallel-worldview 线时自动 no-op（profile 路由）。
 *
 * CR-006 by-design 边界：仅检查字段「存在性」（line 是否声明了 worldEventRef/themeRef），
 * 非引用完整性--scene_graph 内无世界事件/主题表，worldEventRef/themeRef 指向的实体
 * 在图外（world_setting / 主题画像），ref 是否指向真实存在的实体归未来消费者（brief 编译
 * 4.1 / 一致性校验）在拥有该表时校验。纯代码此处只做不依赖外部表的确定性存在性检查。
 */
export function checkMeshMapping(graph: SceneGraph): SceneGraphIssue[] {
  const issues: SceneGraphIssue[] = [];
  for (const line of graph.lines) {
    if (!getValidationProfile(line.topology_role).meshMapping) continue;
    if (!line.worldEventRef && !line.themeRef) {
      issues.push({
        code: 'missing-mesh-mapping',
        severity: 'warning',
        message: `网状线「${line.name}」没有锚定任何世界事件或主题，可能与主线脱节。`,
        targets: [{ kind: 'line' as const, id: line.id }],
        suggestion: '为这条线指定 worldEventRef 或 themeRef，或改为 converging 类型。'
      });
    }
  }
  return issues;
}

// ── edge endpoint reference integrity (Story 1.3 CR-010/CR-016) ──
// edge.from/to 应指向现存 SceneNode.id；指向幻影节点 = dangling。确定性存在性检查
// （非语义）。remove_scene 不级联（design 选择：保持机械可预测）-> 残留 edge 由这里暴露，
// 兑现 applySceneGraphActions docstring「校验会暴露残留」承诺。

export interface DanglingEdgeEndpoint {
  /** edge.id whose from/to doesn't resolve to a SceneNode. */
  edge: string;
  /** endpoint ids that don't match any SceneNode.id. */
  missing: string[];
}

/**
 * 找出所有 from/to 不指向现存 SceneNode.id 的 edge。
 * 返回空数组 = 所有 edge 端点都解析到 node（无 dangling）。
 */
export function findDanglingEdgeEndpoints(graph: SceneGraph): DanglingEdgeEndpoint[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const result: DanglingEdgeEndpoint[] = [];
  for (const edge of graph.edges) {
    const missing: string[] = [];
    if (!nodeIds.has(edge.from)) missing.push(edge.from);
    if (!nodeIds.has(edge.to)) missing.push(edge.to);
    if (missing.length > 0) result.push({ edge: edge.id, missing });
  }
  return result;
}

// ── isolated node（08-26 结构页重构 批 5 / dogfood R2 #34）──
// 无任何连边（from/to 均不触及）的节点 = 孤立。孤立 ≠ 错——草稿期合法
// （severity info，非 error/warning）；无线可数 = 结构判定非语义（ADR-3 纯代码）。
// if-branch-orphan 只覆盖 if 分支线内部；本规则是全图通用的「单点无线」提示，
// 经 UI ValidationBadges 通道零新 UI（灰 i 角标）。消费面：Timeline/工作台校验
// 角标 + SceneEditPopover issues 区 + leader prompt structure-issues 段。

/**
 * 找出所有不被任何 edge（from 或 to）触及的孤立节点。
 * 返回空数组 = 所有节点都有连边（或图无节点）。
 */
export function findIsolatedNodes(graph: SceneGraph): SceneNode[] {
  const touched = new Set<string>();
  for (const edge of graph.edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  return graph.nodes.filter((n) => !touched.has(n.id));
}

/**
 * 应用 art_overrides（design §5）：命中的 issue 降级为 info（不 block、仍可见）。
 * 匹配规则（CR-012 修正）：
 * - check 相等；
 * - scope 缺省 = 该 code 全豁免（语义不变）；
 * - scope 给定 = issue 的 target 集合须整体落在 override.scope 所标识的 target 集合内。
 *   buildArtOverridesForErrors 把整 target 集合的稳定签名（sorted ids join）写入 scope，
 *   故此匹配精确到 issue 实例，不再因共享某 node 连带静音结构不同的同 code issue
 *   （如两个共享一个节点的不同因果环--旧 `targets.some(t => t.id === scope)` 的 bug）。
 */
function applyArtOverrides(
  issues: SceneGraphIssue[],
  overrides: SceneArtOverride[]
): SceneGraphIssue[] {
  if (overrides.length === 0) return issues;
  return issues.map((issue) => {
    const issueIds = new Set(issue.targets.map((t) => t.id));
    const matched = overrides.some((o) => {
      if (o.check !== issue.code) return false;
      if (o.scope === undefined) return true; // 全豁免该 check
      // scope = sorted-joined target ids（buildArtOverridesForErrors 写入）。
      const overrideIds = new Set(o.scope.split(',').filter(Boolean));
      if (overrideIds.size === 0) return true; // 防御：空 scope 视为全豁免
      // issue 的 target 集合须整体落在 override 所标识的实例内（实例级精确匹配）。
      return [...issueIds].every((id) => overrideIds.has(id));
    });
    return matched ? { ...issue, severity: 'info' } : issue;
  });
}

// ── Story 1.7 共享 helper（CR-05 抽取：fork 下游集 + fork-point 推断单一修复点）──
// expandForkBranch / canonDiff / checkIfBranches 三处复用，避免算法漂移分散。
// 范式：纯代码图遍历 + 集合存在性，零 LLM、零语义判断（ADR-3）。

/**
 * 计算 fork-point P 的 canon 下游集（post-fork 范围，CR-01 核心 + CR-05）。
 *
 * 从 forkId 沿前向边（CAUSAL/SUSPENSE）BFS，限 main-thread Line 节点（lineTags 含
 * 主线 id）。**不含 forkId 自身**。**不限 storyTime**（CR-01 修正：旧 `storyTime>P`
 * proxy 在等故事时链 `P(t1)→X(t1)→Y(t2)` 上破裂——X 等故事时不拷、Y 拷，Y' 无入边
 * 假阳性 orphan/missing-fork-point；前向 BFS 已天然是「P 之后 causally」，storyTime
 * 过滤是多余且有害的 proxy）。
 *
 * main-thread Line 取 `is_main_thread:true`；群像退化（无主线）→ forkNode 所在 Line。
 *
 * 消费者：expandForkBranch（决定拷贝集）+ canonDiff（决定 post-fork canon 范围）。
 */
function computeCanonDownstream(graph: SceneGraph, forkId: string): Set<string> {
  const forkNode = graph.nodes.find((n) => n.id === forkId);
  if (!forkNode) return new Set();

  const mainLine = graph.lines.find((l) => l.is_main_thread)
    ?? graph.lines.find((l) => forkNode.lineTags.includes(l.id))
    ?? null;
  const mainLineIds: Set<string> = mainLine
    ? new Set([mainLine.id])
    : new Set(forkNode.lineTags);

  const forwardAdj = buildForwardAdjacency(graph);
  const downstream = new Set<string>();
  const visited = new Set<string>([forkId]); // 排除 forkId 自身
  const queue: string[] = [forkId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of forwardAdj.get(cur) ?? []) {
      if (visited.has(next)) continue;
      const nextNode = graph.nodes.find((n) => n.id === next);
      if (!nextNode) continue;
      // 限 main-thread 子图：非主线节点阻断（不拷贝、不穿过）
      if (!nextNode.lineTags.some((t) => mainLineIds.has(t))) continue;
      visited.add(next);
      downstream.add(next); // 不限 storyTime（CR-01：proxy 破裂）
      queue.push(next);
    }
  }
  return downstream;
}

/**
 * 推断 branch 的 fork-point（CR-05）：canon 节点（无 origin_ref）经前向边连入 branch
 * （`e.to ∈ branchNodeIds`）的 canon `from` 端 = fork in-edge 的 canon 源头。
 *
 * 消费者：checkIfBranches（fork-point 合法性 + 可达性 BFS 起点）+ canonDiff（post-fork
 * 范围起点）。返回 null = branch 无合法 fork-point（来源不明）。
 */
function inferForkPoint(graph: SceneGraph, branchNodeIds: Set<string>): SceneNode | null {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of graph.edges) {
    if (!FORWARD_EDGE_TYPES.has(e.type)) continue;
    if (!branchNodeIds.has(e.to)) continue;
    const fromNode = nodeById.get(e.from);
    if (fromNode && !fromNode.origin_ref) return fromNode;
  }
  return null;
}

/**
 * Story 1.7 if-branch 自校验（design §3.2，warning 级，松）。
 *
 * 对每条 if-branch 线（已 exempt 主线可达，1.2 profile）增 self-validation：
 * - fork-point 合法：存在 canon 节点（无 origin_ref）经前向边连入 branch（= fork in-edge 的 canon 端）。
 * - fork-point 角色正确：该 canon 节点 role='fork-point'（让分叉关系显式）。
 * - branch 节点从 fork-point 可达（无孤儿）：BFS over 前向边，branch 节点不在可达集 = 孤儿。
 * - origin_ref 悬空（design §2.4）：branch 拷贝指向已删 canon 节点 → warning（确定性存在性检查，
 *   同 findDanglingEdgeEndpoints 范式；用户删 canon 节点后 branch 拷贝追溯不上来源须暴露，不静默）。
 *
 * **不强制到达结局**（design §3.2 Q4 松：what-if 可开放未结；"结局好不好"= 语义归 Epic 4 LLM）。
 * branch 内部环由 detectCausalCycle per-branch cycle 报（warning），此处不重复。
 * Issue 用叙事语言（design §3.2 ④：用户不看图论词，如"这条 IF 分支有场够不到分叉点"）。
 *
 * 范式判据：全确定性图遍历 + 存在性检查，零 LLM、零语义判断。
 *
 * side（番外，design §3.3）：topology_role:'side' 已 exempt 主线可达（1.2 profile），无 fork/
 * origin_ref/自校验要求。**OOC + 基调语义校验 = stub 占位**（1.7 不实现，归同人 / Epic 5 LLM 裁判）。
 */
function checkIfBranches(graph: SceneGraph): SceneGraphIssue[] {
  const issues: SceneGraphIssue[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const ifBranchLines = graph.lines.filter((l) => l.topology_role === 'if-branch');

  // CR-02: buildForwardAdjacency 一次构造（O(N+E)），可达性 BFS 复用，替代 per-branch
  // 全表 `for (const e of graph.edges)` 扫边（旧实现每分支 O(K×E)）。
  const fwd = buildForwardAdjacency(graph);

  for (const line of ifBranchLines) {
    const branchNodes = graph.nodes.filter((n) => n.lineTags.includes(line.id));
    const branchNodeIds = new Set(branchNodes.map((n) => n.id));
    if (branchNodeIds.size === 0) continue; // 空 branch 不校验

    // origin_ref 悬空（design §2.4）：branch 拷贝指向已删 canon 节点 → warning。
    // 确定性存在性检查（同 findDanglingEdgeEndpoints 范式）。放在 fork-point 推断之前：
    // 即使 fork-point 仍合法（P 在），branch 拷贝 origin_ref 悬空也是独立的来源追溯缺失，须单独暴露。
    for (const bn of branchNodes) {
      if (bn.origin_ref && !nodeById.has(bn.origin_ref)) {
        issues.push({
          code: 'if-branch-dangling-origin',
          severity: 'warning',
          message: `IF 分支「${line.name}」的场景「${bn.id}」指向了已被删除的主线场景（${bn.origin_ref}），追溯不上它的分叉来源。`,
          targets: [{ kind: 'node', id: bn.id }],
          suggestion: '补回被删的主线场景，或把这个分支场景的 origin_ref 清掉让它独立。'
        });
      }
    }

    // CR-05: fork-point 推断复用 inferForkPoint helper（与 canonDiff 单一修复点）
    const forkPoint = inferForkPoint(graph, branchNodeIds);
    if (!forkPoint) {
      issues.push({
        code: 'if-branch-missing-fork-point',
        severity: 'warning',
        message: `IF 分支「${line.name}」没有明确的分叉起点，看不出它是从主线的哪个抉择点分出来的。`,
        targets: [{ kind: 'line', id: line.id }],
        suggestion: '从主线某个抉择场景连一条因果边到这条分支的第一场。'
      });
      continue; // 无 fork-point 无法做可达性 BFS
    }

    // fork-point 角色合法（role='fork-point'，让分叉关系显式）
    if (forkPoint.role !== 'fork-point') {
      issues.push({
        code: 'if-branch-fork-point-role',
        severity: 'warning',
        message: `IF 分支「${line.name}」的分叉起点（场景「${forkPoint.id}」）没标成分叉点角色，分叉关系不够清晰。`,
        targets: [{ kind: 'node', id: forkPoint.id }],
        suggestion: `把场景「${forkPoint.id}」的角色标为 fork-point。`
      });
    }

    // branch 节点从 fork-point 可达（无孤儿）：CR-02 复用 fwd adjacency BFS（不再全表扫边）
    const reachable = new Set<string>([forkPoint.id]);
    const queue: string[] = [forkPoint.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of fwd.get(cur) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    const orphans = [...branchNodeIds].filter((id) => !reachable.has(id));
    if (orphans.length > 0) {
      issues.push({
        code: 'if-branch-orphan',
        severity: 'warning',
        message: `IF 分支「${line.name}」有场够不到分叉点，像悬在半空，接不上这条分支的因果。`,
        targets: orphans.map((id) => ({ kind: 'node' as const, id })),
        suggestion: '补上因果链让它从分叉点连下来，或把它拆成单独的线。'
      });
    }
    // Q4 松：不强制到达结局（what-if 可开放未结）—— 可选 ending 可达性 warning 推 Epic 4。
  }
  return issues;
}

/**
 * 编排（design §3.5）：全局因果环检测 + 按 profile 的 per-line 可达 / 映射 +
 * if-branch 自校验（1.7）+ 既有 lineTags 引用完整性（1.2 回归）→ 汇总 Issue[]，
 * 最后读 art_overrides 降级。供 1.5 Timeline flag / Epic 3 工作台 chat 消费。
 */
export function validateSceneGraph(graph: SceneGraph): SceneGraphIssue[] {
  const issues: SceneGraphIssue[] = [];

  // 全局：因果环（branch-aware：canon error + per-branch warning，1.7 §3.1）。
  issues.push(...detectCausalCycle(graph));

  // Per-line（按 profile dispatch）：可达性（converging）/ 映射（parallel-worldview）。
  issues.push(...checkReachability(graph));
  issues.push(...checkMeshMapping(graph));

  // Story 1.7 §3.2：if-branch 自校验（fork-point 合法 + 角色正确 + 无孤儿，warning 级）。
  // side 线 OOC/基调语义校验 = stub（design §3.3，归同人 / Epic 5），此处不实现。
  issues.push(...checkIfBranches(graph));

  // 1.2 回归：lineTags 引用完整性 → 结构化 Issue。
  for (const d of findDanglingLineTags(graph)) {
    issues.push({
      code: 'dangling-line-tag',
      severity: 'warning',
      message: `场景「${d.node}」标记了不存在的叙事线（${d.danglingTags.join(', ')}）。`,
      targets: [{ kind: 'node', id: d.node }],
      suggestion: '检查 lineTags 拼写，或先创建对应的叙事线。'
    });
  }

  // Story 1.3 CR-010/CR-016: edge 端点引用完整性 -> 结构化 Issue。
  // remove_scene 不级联 -> 残留 edge 端点悬空由这里暴露（兑现 docstring 承诺）。
  for (const d of findDanglingEdgeEndpoints(graph)) {
    issues.push({
      code: 'dangling-edge-endpoint',
      severity: 'warning',
      message: `场景连线「${d.edge}」指向了不存在的场景（${d.missing.join(', ')}），这条因果链是断的。`,
      targets: [{ kind: 'edge', id: d.edge }],
      suggestion: '补上缺失的场景节点，或删掉这条悬空边。'
    });
  }

  // 08-26 结构页重构 批 5（#34）：孤立节点（无任何连边）→ info（草稿期合法，
  // 提示「这场还没接进结构」——不 block、不催修）。
  // BMad CR 组4：① seenIds 去重——schema 不强制 node.id 唯一，重复 id 的损坏图
  // 会产出逐条相同的 issue（UI 角标计数虚高 + prompt 注入同质行）；同一 id 只报
  // 首个节点。② 消息用 title ?? id——author 可读名优先，id 兜底（title 与 UI 卡面
  // 同一显示口径）。
  const isolatedSeenIds = new Set<string>();
  for (const n of findIsolatedNodes(graph)) {
    if (isolatedSeenIds.has(n.id)) continue;
    isolatedSeenIds.add(n.id);
    issues.push({
      code: 'isolated-node',
      severity: 'info',
      message: `场景「${n.title ?? n.id}」没有任何连边，孤立地悬在结构之外（草稿期合法）。`,
      targets: [{ kind: 'node', id: n.id }],
      suggestion: '若它该推动剧情，从相邻场景连一条因果边过来；若只是草稿占位，可忽略。'
    });
  }

  return applyArtOverrides(issues, graph.art_overrides ?? []);
}

// ── Story 1.7: IF branch fork expander + canon diff（纯代码，ADR-3）──
// expandForkBranch：fork_branch action intent → 机械 add_line/add_scene/add_edge 批次
// （design §2.3）。canonDiff：post-fork 范围 branch vs canon 结构 shallow diff（design §2.4）。
// 范式判据：图遍历 / 拷贝 / 字段比较全确定性，零 LLM、零语义判断（"分叉含义"归 Epic 4 LLM）。

/**
 * Story 1.7 expandForkBranch（纯代码 expander，design §2.3）。
 *
 * 输入 graph + fork_branch action（fork_from_scene_id + branch_line_id）→ 输出既有
 * add_line / add_scene(带 origin_ref) / add_edge 批次，喂 applySceneGraphActions（projector
 * 保持机械 by-id）。LLM 只提 fork intent（在哪 fork + branch 名）；下游拷贝集计算 = 纯代码
 * 图遍历（AGENT-001：非语义判断，不该让 LLM 算）。
 *
 * 算法（design §2.3，CR-01/CR-04/CR-05 修正后）：
 * 1. CR-04 碰撞 guard：branch_line_id 已存在且非 if-branch → 跳过 add_line（不覆盖既有线身份）。
 * 2. 找 main-thread Line（is_main_thread:true；群像退化：fork-point 所在 Line）。
 * 3. CR-01 + CR-05：下游拷贝集 = computeCanonDownstream（前向 BFS、限主线、丢 storyTime proxy）。
 * 4. 每个下游 canon 节点 N → add_scene：新 id `${N.id}__${branchLineId}`（确定性可追溯），
 *    origin_ref=N.id，lineTags=[branchLineId]，role 降级 normal（fork-point 角色不继承）。
 * 5. 下游集内部前向边（两端皆 downstream）→ add_edge（from/to 重映新 id，type 保留，新 edge id）。
 * 6. CR-01 桥接边：每个无 branch-internal 入边的 downstream 拷贝 N' 补 P→N' 桥接（保 fan-out，
 *    避免 orphan）。type 取 canon P→N 直边 type（直边必存在——BFS 到达 N 必经某前驱，前驱不在
 *    downstream 则必是 P 直连；fallback 'CAUSAL' 纯防御，留作算法演进守卫）。
 *
 * expected_downstream_consumers:
 * - 同人-1（IF 结构深化 E1 S.1.7）：消费 fork_branch + expander 输出。
 * - Story 1.8（场↔章 M:N，已落地）：branch 拷贝继承 canon 的 presentationSpans（跨章发布交汇）。
 * - Story 1.9（叙事枚举，已落地）：branch 拷贝继承 canon 的 outcomeType/pacingRole（场结果/张弛角色）。
 */
export function expandForkBranch(
  graph: SceneGraph,
  action: Extract<SceneGraphAction, { op: 'fork_branch' }>
): SceneGraphAction[] {
  const { fork_from_scene_id: forkId, branch_line_id: branchLineId, branch_line_name: branchLineName } = action;

  // CR-04 碰撞 guard：branch_line_id 已存在且非 if-branch → 跳过 add_line（不静默改写既有线身份）。
  // 仍发 scene/edge 拷贝（branch 节点 lineTags 指 branchLineId，让既有线事实上承载 branch 节点；
  // 是否真承担 if-branch 角色由后续校验/人工裁决，不静默改写 topology_role）。
  const existingLine = graph.lines.find((l) => l.id === branchLineId);
  const skipAddLine = !!existingLine && existingLine.topology_role !== 'if-branch';

  // add_line（branch）— 总是声明（除非碰撞）；即使 P 缺失/无下游，作者声明 IF branch 的意图有效。
  // P 缺失 → 校验层报 if-branch-missing-fork-point（expander 不重复语义判断，design §6 职责分离）。
  const actions: SceneGraphAction[] = [];
  if (!skipAddLine) {
    actions.push({
      op: 'add_line',
      line: {
        id: branchLineId,
        name: branchLineName ?? branchLineId,
        topology_role: 'if-branch'
      }
    });
  }

  const forkNode = graph.nodes.find((n) => n.id === forkId);
  if (!forkNode) return actions; // P 不存在 → 仅声明空 branch，校验层报 fork-point 非法

  // CR-01 + CR-05: 下游拷贝集复用 computeCanonDownstream（causal-reachability，丢 storyTime proxy）
  const downstreamIds = computeCanonDownstream(graph, forkId);
  const downstream: SceneNode[] = [];
  for (const id of downstreamIds) {
    const n = graph.nodes.find((x) => x.id === id);
    if (n) downstream.push(n);
  }

  // 拷贝 downstream canon 节点 → add_scene（确定性 ID、origin_ref、lineTags、role 降级）
  const idMap = new Map<string, string>(); // canonId → branchCopyId
  for (const n of downstream) {
    const copyId = `${n.id}__${branchLineId}`;
    idMap.set(n.id, copyId);
    actions.push({
      op: 'add_scene',
      scene: {
        id: copyId,
        origin_ref: n.id,
        lineTags: [branchLineId],
        storyTime: n.storyTime,
        storyTimeLabel: n.storyTimeLabel,
        presentationOrder: n.presentationOrder,
        role: 'normal', // 降级：branch 拷贝不继承 fork-point/core-anchor 角色
        actRef: n.actRef,
        episodeId: n.episodeId,
        // Story 1.9：branch 拷贝继承 canon 场的结构角色（场结果 + 张弛角色），与 role/actRef 同理
        // （fork 后作者/LLM 可单独调整 branch 的这两字段）。primitive string，按值继承（无 deep-copy
        // 问题）。canonDiff.shallowNodeEqual 已纳入这两字段比较——分叉后 branch 改了会报 changed。
        outcomeType: n.outcomeType,
        pacingRole: n.pacingRole,
        // Story 1.8：branch 拷贝继承 canon 发布 spans（与 presentationOrder/episodeId 同列），
        // 让 IF 分支同样表达「这场跨哪些 episode 发布」。fork 后作者/LLM 可单独调整 branch 的 spans。
        // deep-copy（CR-002/006）：按值拷贝数组 + 每 span，免 branch 原地改（push/splice）静默 corrupt
        // canon + canonDiff 漏报（对齐 pattern-seeds CR-007 spread-copy 先例）。handler 路径经 Zod 重 parse
        // 已断别名；此 deep-copy 保护 action list 的直消费者（同人-1 IF / Epic 4.5 retrieval）。
        presentationSpans: n.presentationSpans?.map((s) => ({ ...s }))
      }
    });
  }

  // 下游集内部前向边（两端皆 downstream）→ add_edge（重映 id，type 保留）
  // 同时记录哪些 downstream 节点已有 branch-internal 入边（CR-01 桥接边判定用）
  const hasBranchInternalInput = new Set<string>();
  for (const e of graph.edges) {
    if (!FORWARD_EDGE_TYPES.has(e.type)) continue;
    if (downstreamIds.has(e.from) && downstreamIds.has(e.to)) {
      actions.push({
        op: 'add_edge',
        edge: {
          id: `${e.id}__${branchLineId}`,
          from: idMap.get(e.from)!,
          to: idMap.get(e.to)!,
          type: e.type
        }
      });
      hasBranchInternalInput.add(e.to);
    }
  }

  // CR-01 桥接边：每个无 branch-internal 入边的 downstream 拷贝 N' 补 P→N' 桥接（保 fan-out，无 orphan）。
  // canon `P→X→Y`（X 等故事时）fork 后得 `P→X'→Y'`：X 无 branch-internal 入边（canon 前驱 P 不在 downstream）
  // → 补 P→X' 桥接；Y 有 branch-internal 入边（X'→Y'）→ 不补。
  for (const n of downstream) {
    if (hasBranchInternalInput.has(n.id)) continue; // 已有 branch-internal 入边，不需桥接
    const directEdge = graph.edges.find(
      (e) => FORWARD_EDGE_TYPES.has(e.type) && e.from === forkId && e.to === n.id
    );
    actions.push({
      op: 'add_edge',
      edge: {
        id: `fork__${n.id}__${branchLineId}`,
        from: forkId,
        to: idMap.get(n.id)!,
        type: directEdge?.type ?? 'CAUSAL' // 直边必存在（BFS 不经非 downstream 前驱到达 N → 必 P 直连）；fallback 防御
      }
    });
  }

  return actions;
}

/**
 * Story 1.7 canonDiff（纯代码结构 diff，design §2.4）。
 *
 * 对比 branch Line 与其 canon 源（post-fork 范围），按 origin_ref 分类：
 * - added：branch 节点 origin_ref 缺省或指向不存在 canon（branch 独有）。
 * - removed：canon 下游节点无对应 branch 拷贝（canon 节点 fork 后被删 → 拷贝 origin_ref 悬空）。
 * - changed：origin_ref 指向现存 canon，结构字段 shallow diff（design §2.4）。
 * - same：origin_ref 指向现存 canon，结构字段全同。
 *
 * "changed" = 结构字段 shallow diff（role/storyTime/storyTimeLabel/presentationOrder/actRef/episodeId/outcomeType/pacingRole/presentationSpans；
 * **不含 lineTags**——branch 拷贝机械地标到不同 line 是 fork 本身的目的、非"分叉后变了什么"，
 * 含 lineTags 会让所有拷贝恒为 changed 失去信号；不含 id/origin_ref——id 恒不同，origin_ref 是指针）。
 * SceneNode 无 prose（D3 轻量壳），故 diff 仅结构层。范式：确定性字段比较，零语义（"分叉含义"归 Epic 4）。
 *
 * post-fork 范围 = fork-point P 之后主线节点（CR-05：复用 `computeCanonDownstream` + `inferForkPoint`
 * helper，与 expandForkBranch 单一修复点同算法）。P 推断 = `inferForkPoint`（canon 节点无 origin_ref
 * 且经前向边连入 branch = fork in-edge 的 canon 端）。
 *
 * expected_downstream_consumers:
 * - 同人-1（IF 结构深化）：消费 diff 做"分叉后变了什么"结构展示。
 * - Epic 4.5 retrieval：canonDiff 签名预留（不建 agent 工具包装，承 1.6 决议 scene_graph 不进 closure_*）。
 *   签名稳定：canonDiff(graph, branchLineId) → CanonDiff，调用方不该耦合内部字段顺序。
 */
export interface CanonDiffEdgeDelta {
  added: SceneEdge[];
  removed: SceneEdge[];
  changed: { branch: SceneEdge; canon: SceneEdge }[];
}

export interface CanonDiff {
  added: SceneNode[];
  removed: SceneNode[];
  changed: { branch: SceneNode; canon: SceneNode }[];
  same: SceneNode[];
  edges: CanonDiffEdgeDelta;
}

export function canonDiff(graph: SceneGraph, branchLineId: string): CanonDiff {
  const result: CanonDiff = {
    added: [], removed: [], changed: [], same: [],
    edges: { added: [], removed: [], changed: [] }
  };

  const branchNodes = graph.nodes.filter((n) => n.lineTags.includes(branchLineId));
  // branch 不存在（无 if-branch 线 / 无拷贝）→ 空delta（防御性，不崩）
  if (branchNodes.length === 0) return result;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const branchNodeIds = new Set(branchNodes.map((n) => n.id));

  // CR-05: fork-point 推断 + canon 下游集复用 helper（与 expandForkBranch 同算法，单一修复点）。
  // canonDownstreamIds = post-fork canon 范围（P 之后主线 canon 节点）；computeCanonDownstream
  // 限 main-thread lineTags 已天然排除 branch 拷贝（branch lineTags=[branchLineId] 非主线）。
  const forkPoint = inferForkPoint(graph, branchNodeIds);
  const canonDownstreamIds = forkPoint
    ? computeCanonDownstream(graph, forkPoint.id)
    : new Set<string>();

  // branch 拷贝 → canon 源映射（仅当 origin_ref 指向现存 canon 节点）
  const branchToCanon = new Map<string, string>();
  for (const bn of branchNodes) {
    if (bn.origin_ref && nodeById.has(bn.origin_ref)) {
      branchToCanon.set(bn.id, bn.origin_ref);
    }
  }
  const canonToBranch = new Map<string, string>();
  for (const [copyId, canonId] of branchToCanon) canonToBranch.set(canonId, copyId);

  // 节点分类：added / same / changed
  for (const bn of branchNodes) {
    const canonId = branchToCanon.get(bn.id);
    if (!canonId) {
      // origin_ref 缺省 OR 指向不存在 canon（悬空）→ branch 独有 → added
      result.added.push(bn);
    } else {
      const canonNode = nodeById.get(canonId)!;
      if (shallowNodeEqual(bn, canonNode)) result.same.push(bn);
      else result.changed.push({ branch: bn, canon: canonNode });
    }
  }

  // removed：canon downstream 节点无对应 branch 拷贝
  for (const canonId of canonDownstreamIds) {
    if (!canonToBranch.has(canonId)) {
      const cn = nodeById.get(canonId);
      if (cn) result.removed.push(cn);
    }
  }

  // 边分类（仅 branch 内部边 vs canon post-fork 边；fork in-edge 一端 canon 一端 branch，排除）
  const branchInternalEdges = graph.edges.filter(
    (e) => branchNodeIds.has(e.from) && branchNodeIds.has(e.to)
  );
  const matchedCanonEdgeIds = new Set<string>();
  for (const be of branchInternalEdges) {
    const canonFrom = branchToCanon.get(be.from);
    const canonTo = branchToCanon.get(be.to);
    if (!canonFrom || !canonTo) {
      // branch 端点是 added 节点（无 canon 映射）→ 边 added
      result.edges.added.push(be);
      continue;
    }
    const matchingCanon = graph.edges.find(
      (ce) => ce.from === canonFrom && ce.to === canonTo
        && canonDownstreamIds.has(canonFrom) && canonDownstreamIds.has(canonTo)
    );
    if (!matchingCanon) {
      result.edges.added.push(be);
    } else {
      matchedCanonEdgeIds.add(matchingCanon.id);
      if (be.type !== matchingCanon.type) {
        result.edges.changed.push({ branch: be, canon: matchingCanon });
      }
      // type 相同 → same（不报告，design §2.4 edges 无 same 类）
    }
  }
  // canon post-fork 边未被任何 branch 边匹配 → removed
  for (const ce of graph.edges) {
    if (!canonDownstreamIds.has(ce.from) || !canonDownstreamIds.has(ce.to)) continue;
    if (branchNodeIds.has(ce.from) || branchNodeIds.has(ce.to)) continue;
    if (!matchedCanonEdgeIds.has(ce.id)) result.edges.removed.push(ce);
  }

  return result;
}

/**
 * SceneNode 结构字段 shallow 相等（canonDiff "changed" 判定）。
 * 比较字段：role/storyTime/storyTimeLabel/presentationOrder/actRef/episodeId/outcomeType/pacingRole/title/summary/presentationSpans。
 * **不含 lineTags**（branch 拷贝机械标到不同 line 是 fork 目的、非分叉后变更信号）。
 * **不含 id/origin_ref**（id 恒不同；origin_ref 是指针）。SceneNode 无 prose（D3 壳）。
 *
 * presentationSpans 数组比较（Story 1.8）：用 JSON.stringify 稳定序列化后字符串比较。spans 是
 * `[{episodeId, pos}]` 简单值数组，JSON 序列化对元素顺序敏感（顺序变 = 不同发布编排 = 分叉后变了），
 * 满足 canonDiff「分叉后变了什么」的语义。undefined 归一为 [] 与缺失 spans（单章场）一致。
 * 简单值数组无需 deep-equal 库；稳定且可读（implement 选型理由）。
 *
 * outcomeType/pacingRole（Story 1.9）：primitive string，`?? ''` 归一后按值比较（对齐上方
 * presentationSpans `?? []` 的第三态归一哲学——undefined 与 '' 同为「未设」，免 LLM/手改产 ''
 * 落第三态致假 changed；BMad CR EDGE-1）。实值差异（如 '惨胜' vs '反转'、'达成' vs ''/undefined）
 * 仍是「分叉后变了什么」的合法 changed 信号。mice_type 在 Line 上不进 node diff（见 §4.3）。
 *
 * title/summary（dogfood R2 批次0）：同 `?? ''` 归一比较（mirror 1.9 两字段）——branch 改了场景
 * 标题/摘要是「分叉后变了什么」的合法 changed 信号；schema .min(1) + `?? ''` 归一致 '' 不入数据。
 */
function shallowNodeEqual(a: SceneNode, b: SceneNode): boolean {
  return a.role === b.role
    && a.storyTime === b.storyTime
    && a.storyTimeLabel === b.storyTimeLabel
    && a.presentationOrder.chapter === b.presentationOrder.chapter
    && a.presentationOrder.pos === b.presentationOrder.pos
    && a.actRef === b.actRef
    && a.episodeId === b.episodeId
    && (a.outcomeType ?? '') === (b.outcomeType ?? '')
    && (a.pacingRole ?? '') === (b.pacingRole ?? '')
    && (a.title ?? '') === (b.title ?? '')
    && (a.summary ?? '') === (b.summary ?? '')
    && JSON.stringify(a.presentationSpans ?? []) === JSON.stringify(b.presentationSpans ?? []);
}

// ── Story 4.1 scene 精选：按 episode 取本章相关 scene 结构摘要（design §3.1）──
//
// 4.0 draft-writer 的 `{{storyPlan}}` 是 `JSON.stringify(scene_graph 全量)`（粗 dump，含 edges/lines/
// art_overrides/version/updatedBy 等写作无关字段）。4.1 升级为「精选本章涉及场的结构面」——既瘦身上下文
// （只注本章相关 + 只注结构字段），又承接 Story 1.6 deferred（scene 召回消费点 = Writer compiled context，
// scene_graph 走纯代码结构查询，不进 closure_* 语义索引）。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：本节全是确定性结构查询（id 相等比较
// + 字段投影）——「不理解意义」。episode 归属判定（episodeId 直挂 / presentationSpans M:N）= 机械 ref
// 匹配；结构面投影 = 字段子集提取。不判「这场重要不重要」「这场讲什么」（归 LLM）。scene_graph 走纯代码
// 结构查询，**不进 closure_***（Story 1.6 决议：scene 召回消费点 = Writer compiled context，非语义索引）。
//
// scene 匹配单源（DRY）：原 brief-compiler `sceneMatchesEpisode`（nodes/brief-compiler-node.ts）+ chapter-brief
// `episodeHasScenes`（chapter-brief.ts readiness 用）+ 本节 `selectScenesForEpisode` 三处同形逻辑，统一抽到
// `isSceneInEpisode` 单一 source（保守：brief-compiler-node 19 case + chapter-brief 35 case 不破——逻辑等价）。
//
// expected_downstream_consumers:
// - Story 4.1：draft-writer `{{storyPlan}}` 注入选精选（替代全量 dump）。
// - Story 4.5：retrieval 复用 `selectScenesForEpisode` 作 scene 召回消费点（承接 1.6 deferred）。

/**
 * 判断 scene 是否属于某 episode（Story 1.8 M:N 交汇）——单源真值，brief-compiler / chapter-brief readiness
 * / selectScenesForEpisode 三处共用（DRY）。
 *
 * 匹配规则（与原 brief-compiler `sceneMatchesEpisode` / chapter-brief `episodeHasScenes` 同形）：
 * - `SceneNode.episodeId === episodeId`（单章场直挂，1.1 行为）
 * - 或 `presentationSpans` 任一 `span.episodeId === episodeId`（跨章场 M:N，1.8）
 *
 * 范式判据（ADR-3）：纯结构 ref 比较，非语义。不进 closure_*（1.6 决议）。
 */
export function isSceneInEpisode(node: SceneNode, episodeId: string): boolean {
  if (node.episodeId === episodeId) return true;
  return Boolean(node.presentationSpans?.some((s) => s.episodeId === episodeId));
}

/**
 * Scene 的结构面摘要（design §3.1）——供 draft-writer compiled context（4.1）/ retrieval（4.5）复用。
 *
 * 字段 = `SceneNode` 结构面子集（`Pick`）：id / role / lineTags（所在 curves）/ storyTime(+Label) /
 * presentationOrder（topology 锚点）/ presentationSpans（M:N 发布交汇）/ episodeId / outcomeType（场结果）
 * / pacingRole（张弛角色）/ actRef。**不含 `origin_ref`**（IF branch 拷贝指针 = 分叉机制，非写作结构面）；
 * **不含正文**（SceneNode 无 prose 字段——D3 轻量壳）；**不含全量 dump**（edges/lines/art_overrides/version
 * 等写作无关字段）。结构坐标面，非 embed 语义条目（范式判据：纯代码结构查询，不进 closure_*，1.6 决议）。
 */
export type SceneStructureDigest = Pick<
  SceneNode,
  | 'id' | 'role' | 'lineTags' | 'storyTime' | 'storyTimeLabel'
  | 'presentationOrder' | 'presentationSpans' | 'episodeId'
  | 'outcomeType' | 'pacingRole' | 'actRef'
>;

/**
 * 选取本章（episodeId）相关的 scene 结构摘要（design §3.1 scene 精选）。
 *
 * filter `graph.nodes` 命中本章（`isSceneInEpisode`，M:N-aware）→ 投影成 `SceneStructureDigest`（结构面，
 * 无正文/无全量 dump）。供 draft-writer `{{storyPlan}}` 注入（替代 4.0 全量 dump）+ 4.5 retrieval 复用
 * （承接 1.6 deferred：scene 召回消费点 = Writer compiled context）。
 *
 * 范式判据（ADR-3）：纯代码 filter + 字段投影，非语义判断。scene_graph 走结构查询，不进 closure_*。
 *
 * @param graph     SceneGraph（结构查询源；缺 → []）
 * @param episodeId 本章目标 episode id（缺 → []，无匹配——graceful）
 * @returns         命中场结构摘要数组（按 `graph.nodes` 原序）；无匹配 → []。
 */
export function selectScenesForEpisode(
  graph: SceneGraph | undefined,
  episodeId: string | undefined,
): SceneStructureDigest[] {
  if (!graph || !episodeId) return [];
  return graph.nodes
    .filter((n) => isSceneInEpisode(n, episodeId))
    .map((n) => ({
      id: n.id,
      role: n.role,
      lineTags: n.lineTags,
      storyTime: n.storyTime,
      storyTimeLabel: n.storyTimeLabel,
      presentationOrder: n.presentationOrder,
      presentationSpans: n.presentationSpans,
      episodeId: n.episodeId,
      outcomeType: n.outcomeType,
      pacingRole: n.pacingRole,
      actRef: n.actRef,
    }));
}

// ── Story 3.4 涟漪诊断 reverse-ref 原语（C-A7/D2，纯代码，ADR-3）──
//
// 改一条设定/线索后「缩小到哪些场/线受影响」的候选集汇编。供 ripple-diagnosis L1 候选缩小层
// （design §2.2）消费：纯代码结构过滤（id 相等比较）→ 产候选集；「实际受不受影响」归 L2 LLM。
// mirror selectScenesForEpisode 的 filter + Pick 投影范式。scene_graph 走纯代码结构查询，不进 closure_*。
//
// 三条 reverse-ref 经不同的结构字段（D6 design §4）：
// - scenesByAssetRef：scene.assetRefs（Story 3.4 D6 新增）——「这场涉及哪些设定卡」的反查。
// - scenesByLine：scene.lineTags（既有，refs Line.id）——「这线上有哪些场」。
// - linesByAssetRef：Line.thread_ref（既有，asset_ref anchor）——「哪些线锚定这张设定卡」。
//
// 各 ~5 行 filter + 投影。消费者用 `?? []` 归一 optional 数组（assetRefs/lineTags 缺省）。
// expected_downstream_consumers: Story 3.4 ripple-diagnosis L1 候选缩小 + Story 3.7 InsightCard。

/** Line 结构面摘要（涟漪诊断 reverse-ref 用）。结构子集投影，非语义。 */
export type SceneLineDigest = Pick<
  SceneLine,
  'id' | 'name' | 'topology_role' | 'thread_ref' | 'convergence_target' | 'mice_type'
>;

/**
 * 反查涉及某个 asset_card 的所有场（经 `scene.assetRefs`，Story 3.4 D6）。
 *
 * 改一张设定卡 → 这些场的结构/世界状态可能受影响（候选集）。范式判据（ADR-3）：纯结构 ref 过滤
 * （assetRefs 含 assetId 否），非语义。assetRefs 填充归 LLM（story-planner/scene_graph_update）；
 * 缺失场（旧项目未填 assetRefs）→ 不在候选集（涟漪诊断 graceful 标 degraded，design §2.3）。
 *
 * @param graph   SceneGraph（结构查询源；缺 → []）
 * @param assetId asset_card id（与 WorldSubject.sourceCardId 同 id 空间）
 * @returns       命中场结构摘要数组（按 graph.nodes 原序）；无匹配 → []。
 */
export function scenesByAssetRef(
  graph: SceneGraph | undefined,
  assetId: string | undefined,
): SceneStructureDigest[] {
  if (!graph || !assetId) return [];
  return graph.nodes
    .filter((n) => (n.assetRefs ?? []).includes(assetId))
    .map((n) => ({
      id: n.id,
      role: n.role,
      lineTags: n.lineTags,
      storyTime: n.storyTime,
      storyTimeLabel: n.storyTimeLabel,
      presentationOrder: n.presentationOrder,
      presentationSpans: n.presentationSpans,
      episodeId: n.episodeId,
      outcomeType: n.outcomeType,
      pacingRole: n.pacingRole,
      actRef: n.actRef,
    }));
}

/**
 * 反查某条线（Line）上的所有场（经 `scene.lineTags`，既有 ref）。
 *
 * 改一条线（收束契约 / 线叙事单元）→ 这些场可能受影响。纯结构 ref 过滤，非语义。
 *
 * @param graph  SceneGraph（缺 → []）
 * @param lineId Line.id（缺 → []）
 * @returns      命中场结构摘要数组（按 graph.nodes 原序）；无匹配 → []。
 */
export function scenesByLine(
  graph: SceneGraph | undefined,
  lineId: string | undefined,
): SceneStructureDigest[] {
  if (!graph || !lineId) return [];
  return graph.nodes
    .filter((n) => n.lineTags.includes(lineId))
    .map((n) => ({
      id: n.id,
      role: n.role,
      lineTags: n.lineTags,
      storyTime: n.storyTime,
      storyTimeLabel: n.storyTimeLabel,
      presentationOrder: n.presentationOrder,
      presentationSpans: n.presentationSpans,
      episodeId: n.episodeId,
      outcomeType: n.outcomeType,
      pacingRole: n.pacingRole,
      actRef: n.actRef,
    }));
}

/**
 * 反查锚定某个 asset_card 的所有线（经 `Line.thread_ref`，既有 asset_ref anchor）。
 *
 * 改一张设定卡 → 锚定它的线（thread_ref 指向该 assetId）可能受影响。纯结构 ref 比较，非语义。
 * thread_ref 缺省的线（floating line，1.2 warning）→ 不被任何 assetId 命中。
 *
 * @param graph   SceneGraph（缺 → []）
 * @param assetId asset_card id（thread_ref 值空间）
 * @returns       命中线结构摘要数组（按 graph.lines 原序）；无匹配 → []。
 */
export function linesByAssetRef(
  graph: SceneGraph | undefined,
  assetId: string | undefined,
): SceneLineDigest[] {
  if (!graph || !assetId) return [];
  return graph.lines
    .filter((l) => l.thread_ref === assetId)
    .map((l) => ({
      id: l.id,
      name: l.name,
      topology_role: l.topology_role,
      thread_ref: l.thread_ref,
      convergence_target: l.convergence_target,
      mice_type: l.mice_type,
    }));
}
