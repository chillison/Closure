import {
  resolveChapterIdForEpisode,
  type ResolvableChapter,
  type ResolvableEpisode,
  type SceneGraph,
  type SceneNode,
} from '@orison/shared-contracts';

// ── Story 3.5（design §3.3 / §6）：批量场列表解析 + 场→章分组（纯代码，ADR-3）──
//
// 线→锚点有序场解析：沿 lineTag 选线内场 → 前向边（CAUSAL/SUSPENSE）拓扑序 → 截到（含）下一 typed
// 锚点（core-anchor / secondary-anchor / fork-point）。边界确定性质疑（「写到哪」的创作语义）归
// leader——工具三选择器（lineTag / targetAnchorSceneId / sceneIds）给 leader 全控空间。
//
// 场→章分组（M:N 关键映射，1.8 presentationSpans）：批量按场迭代（判轻重单位），write_chapter 按章写
// （章是发布单位）——一章只写一次；场无章映射（新场未指派章）→ graceful 上报，leader 作为一次咨询处理。
//
// 范式判据（ADR-3）：拓扑排序 / 边界截断 / ref 解析 = 纯代码结构查询（零语义判断——「写到哪算合适」
// 「这场重不重要」不在此判）。

/** 单批场数上限（design §6：预算上限，超限 graceful 拒——leader 换更近锚点 / 显式 sceneIds）。 */
export const BATCH_SCENE_CAP = 8;

/** typed 锚点角色（sceneNodeRoleSchema 的非 normal 值；「是否锚点」是结构事实非语义判断）。 */
const ANCHOR_ROLES = new Set(['core-anchor', 'secondary-anchor', 'fork-point']);

export interface BatchScenePlanInput {
  sceneGraph: SceneGraph;
  /** 沿哪条线（Line.id）。 */
  lineTag?: string;
  /** 显式目标锚点（截到此场含）。 */
  targetAnchorSceneId?: string;
  /** 显式场列表（全控——顺序仍解析为拓扑序）。 */
  sceneIds?: string[];
}

export type BatchScenePlanFailureReason =
  | 'no-selector'
  | 'line-not-found'
  | 'no-anchor'
  | 'anchor-not-in-selection'
  | 'scene-not-found'
  | 'empty-selection'
  | 'cap-exceeded';

export type BatchScenePlanResult =
  | { ok: true; orderedSceneIds: string[]; targetAnchorSceneId?: string; lineTag?: string }
  | { ok: false; reason: BatchScenePlanFailureReason; detail: string };

/**
 * 前向边（CAUSAL + SUSPENSE，mirror scene-graph-analytics buildForwardAdjacency 的边类型集合）
 * 拓扑排序（Kahn），限定 selected 集。tie-break：storyTime → presentationOrder.chapter → pos → id
 * （确定性，测试可复现）。环残留（选定集内有因果环——校验层另报）按 tie-break 序追加（防御性不崩）。
 */
function topoSortSelected(graph: SceneGraph, selected: Set<string>): string[] {
  // 邻接 + 入度（只计 selected 内的边）。
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of selected) {
    adjacency.set(id, []);
    indegree.set(id, 0);
  }
  for (const edge of graph.edges) {
    if (edge.type !== 'CAUSAL' && edge.type !== 'SUSPENSE') continue;
    if (!selected.has(edge.from) || !selected.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  // tie-break 键（确定性排序）。
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const sortKey = (id: string): [number, number, number, string] => {
    const n = nodeById.get(id);
    if (!n) return [Number.MAX_SAFE_INTEGER, 0, 0, id];
    return [n.storyTime, n.presentationOrder.chapter, n.presentationOrder.pos, id];
  };
  const compareKey = (a: string, b: string): number => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < 4; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  };

  // Kahn：每轮取入度 0 的最小键节点（确定性）。
  const pending = [...selected].sort(compareKey);
  const ordered: string[] = [];
  while (pending.length > 0) {
    const idx = pending.findIndex((id) => (indegree.get(id) ?? 0) === 0);
    if (idx === -1) {
      // 环残留：按 tie-break 追加剩余（防御——因果环由 validateSceneGraph 另行暴露）。
      ordered.push(...pending.sort(compareKey));
      break;
    }
    const [id] = pending.splice(idx, 1);
    ordered.push(id);
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
    }
  }
  return ordered;
}

/**
 * 解析批量有序场列表（纯函数）。
 *
 * 选择器优先级：sceneIds（全控）> targetAnchorSceneId（显式锚点边界）> lineTag（线→下一锚点）。
 * 返回 orderedSceneIds（拓扑序）+ 边界信息；graceful failure 带 reason + detail（leader 据此
 * 向作者澄清，非静默跳过）。
 *
 * cap 检查**不在本函数**（调用方 tool 守门——本函数保持纯解析，测试面小）。
 */
export function resolveBatchScenePlan(input: BatchScenePlanInput): BatchScenePlanResult {
  const { sceneGraph } = input;
  const nodeById = new Map(sceneGraph.nodes.map((n) => [n.id, n]));

  // ── 选择集 ──
  let selected: Set<string>;
  let lineTag: string | undefined;

  if (input.sceneIds && input.sceneIds.length > 0) {
    // 显式列表（全控）：逐 id 存在性校验。
    const missing = input.sceneIds.filter((id) => !nodeById.has(id));
    if (missing.length > 0) {
      return { ok: false, reason: 'scene-not-found', detail: `scene_graph 中不存在这些场：${missing.join(', ')}` };
    }
    selected = new Set(input.sceneIds);
  } else if (input.targetAnchorSceneId || input.lineTag) {
    if (input.lineTag) {
      const line = sceneGraph.lines.find((l) => l.id === input.lineTag);
      if (!line) {
        return { ok: false, reason: 'line-not-found', detail: `scene_graph 中不存在线「${input.lineTag}」（检查 lineTag 拼写，或先建线）` };
      }
      lineTag = input.lineTag;
      selected = new Set(sceneGraph.nodes.filter((n) => n.lineTags.includes(input.lineTag!)).map((n) => n.id));
    } else {
      // 只有显式锚点、无线 → 全图场为候选（锚点边界仍截断）。
      selected = new Set(sceneGraph.nodes.map((n) => n.id));
    }
  } else {
    return { ok: false, reason: 'no-selector', detail: 'start_batch 需要 lineTag / targetAnchorSceneId / sceneIds 至少一个' };
  }

  if (selected.size === 0) {
    return { ok: false, reason: 'empty-selection', detail: lineTag ? `线「${lineTag}」上没有场` : '选定范围为空' };
  }

  const ordered = topoSortSelected(sceneGraph, selected);

  // ── 边界截断 ──
  if (input.targetAnchorSceneId) {
    const anchorId = input.targetAnchorSceneId;
    if (!selected.has(anchorId)) {
      return {
        ok: false,
        reason: 'anchor-not-in-selection',
        detail: `目标锚点「${anchorId}」不在选定范围内${lineTag ? `（线「${lineTag}」）` : ''}`,
      };
    }
    const idx = ordered.indexOf(anchorId);
    return { ok: true, orderedSceneIds: ordered.slice(0, idx + 1), targetAnchorSceneId: anchorId, ...(lineTag ? { lineTag } : {}) };
  }

  // lineTag（无显式锚点）→ 截到拓扑序上第一个 typed 锚点（含）。无锚点 → 需澄清（design：无 anchor graceful）。
  const anchorIdx = ordered.findIndex((id) => {
    const role = nodeById.get(id)?.role;
    return role !== undefined && ANCHOR_ROLES.has(role);
  });
  if (anchorIdx === -1) {
    return {
      ok: false,
      reason: 'no-anchor',
      detail: `线「${lineTag}」上没有 typed 锚点（core-anchor / secondary-anchor / fork-point），无法确定批量边界——请作者指一个收束点（可用 targetAnchorSceneId 传任意场）`,
    };
  }
  return {
    ok: true,
    orderedSceneIds: ordered.slice(0, anchorIdx + 1),
    targetAnchorSceneId: ordered[anchorIdx],
    ...(lineTag ? { lineTag } : {}),
  };
}

/**
 * 返回场的 episodeId 候选顺序数组：
 * - CR-016：优先级统一为「非空 presentationSpans 优先（≥1 span）> 直挂 episodeId 兜底」；
 *   `presentationSpans:[]` 空数组视为「未设」（非真值，遮蔽直挂是 bug，CR-016 fix）→ 回退 episodeId；
 *   无任何则空数组（unmapped）。
 * - 由 batch-planning（groupScenesByChapter）+ batch-signals 共用 helper（interface-contracts helper 复用先于重造）。
 */
export function resolveSceneEpisodeCandidates(
  node: Pick<SceneNode, 'episodeId' | 'presentationSpans'>,
): string[] {
  if (node.presentationSpans && node.presentationSpans.length > 0) {
    return node.presentationSpans.map((s) => s.episodeId);
  }
  return node.episodeId ? [node.episodeId] : [];
}

// ── 场→章分组（design §3.3 M:N）──

export interface ChapterGroupResult {
  /** sceneId → chapterId（写章目标；一章多场 → write_chapter 一次带该章全部待写场）。 */
  chapterMap: Record<string, string>;
  /** 无章映射的场（新场未指派章）——caller graceful 上报「需先指派章」。 */
  unmappedSceneIds: string[];
}

/**
 * 按场解析承载章（纯函数）。
 *
 * 每场 episode 候选 = presentationSpans 各 span（M:N，1.8）或直挂 episodeId（单章场）。候选按
 * episode.index 升序（**真实存在查找**——外键 index 不保证连续，interface-contracts convention），
 * 取首个能 resolve 出已注册章的 episode。全失败 → unmapped（「需先指派章」graceful）。
 *
 * 跨章场（多 span 落不同章）：归最早 episode 的章——该章写时 brief-compiler 经 selectScenesForEpisode
 * 自然收入本场（章是发布单位，M:N 语义如此，design §3.3）。
 */
export function groupScenesByChapter(
  sceneGraph: SceneGraph,
  orderedSceneIds: readonly string[],
  episodeOutlines: readonly ResolvableEpisode[] | undefined,
  novelChapters: readonly ResolvableChapter[] | undefined,
): ChapterGroupResult {
  const nodeById = new Map(sceneGraph.nodes.map((n) => [n.id, n]));
  const outlineById = new Map((episodeOutlines ?? []).map((e) => [e.id, e]));
  const chapterMap: Record<string, string> = {};
  const unmappedSceneIds: string[] = [];

  for (const sceneId of orderedSceneIds) {
    const node = nodeById.get(sceneId);
    if (!node) {
      unmappedSceneIds.push(sceneId);
      continue;
    }
    // episode 候选（CR-016：统一用 resolveSceneEpisodeCandidates——非空 spans 优先，空 [] 回退直挂）。
    const episodeCandidates = resolveSceneEpisodeCandidates(node);
    // 按 episode.index 升序（index 缺 / 非数排最后——防御，schema 保证 int nonnegative 但缺字段容错）。
    const withIndex = episodeCandidates
      .map((id) => ({ id, index: outlineById.get(id)?.index }))
      .sort((a, b) => {
        const ai = typeof a.index === 'number' ? a.index : Number.MAX_SAFE_INTEGER;
        const bi = typeof b.index === 'number' ? b.index : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    let resolved: string | undefined;
    for (const candidate of withIndex) {
      resolved = resolveChapterIdForEpisode(episodeOutlines, novelChapters, candidate.id);
      if (resolved) break;
    }
    if (resolved) {
      chapterMap[sceneId] = resolved;
    } else {
      unmappedSceneIds.push(sceneId);
    }
  }
  return { chapterMap, unmappedSceneIds };
}

/** 场显示名（storyTimeLabel 缺省退 id——SceneNode 无 title 字段，结构壳）。 */
export function sceneDisplayName(node: SceneNode | undefined): string {
  if (!node) return '(unknown)';
  return node.storyTimeLabel && node.storyTimeLabel.length > 0 ? node.storyTimeLabel : node.id;
}
