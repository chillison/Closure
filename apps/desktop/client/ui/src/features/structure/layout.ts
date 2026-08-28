/**
 * Story 1.5 Phase C / E1 (design §3 / §3b): pure-code timeline derivation helpers.
 *
 * ── 08-26 结构页重构 批 7（design §11「同构锁步」定案 5：退役清理）──
 * `deriveTimelineLayout`（storyTime 分桶 → 唯一列集合 + readPosition 双轴参数化）
 * **整函数退役删除**——因果骨架换轴到章轴后，两区（因果卡桶 + 工作 chip 桶）由
 * workbenchLayout 的单源派生 `deriveWorkbenchLayout` 一并产出（行序 / 章归属 /
 * pending 镜像 / 边锚定共用一份，subgrid 锁步的前提就是数据面单源）。
 *
 * 本文件保留三件共享底座：
 *   - `isSceneGraphLike` —— store unknown 的形状守卫缝。
 *   - `orderLinesByPriority` —— 泳道序单源（两区同线同行）。
 *   - `deriveReadIndexByNode` —— 阅读序派生单源（工作台 chip 圆号 / 倒叙判定消费；
 *     原 readPosition 轴渲染面随阅读骨架退役，派生按 prd/implement 3.1 承诺保留）。
 */
import type {
  SceneGraph,
  SceneLine,
  SceneNode,
  LineTopologyRole
} from '@orison/shared-contracts';

/**
 * Defensive shape guard (CR-001): ensure a `creativeFields.scene_graph` value
 * actually looks like a SceneGraph before treating it as one. The store cast
 * (`as SceneGraph | undefined`) trusts `unknown` data; partial hydration or a
 * malformed agent patch could leave `.nodes` / `.lines` / `.edges` undefined,
 * which would crash the downstream derivations (`.map` on undefined). Mirrors the
 * `OutlineEditor` `?? []` seam pattern (defensive at the consumption edge).
 */
export function isSceneGraphLike(value: unknown): value is SceneGraph {
  return (
    typeof value === 'object'
    && value !== null
    && Array.isArray((value as { nodes?: unknown }).nodes)
    && Array.isArray((value as { lines?: unknown }).lines)
    && Array.isArray((value as { edges?: unknown }).edges)
  );
}

// ── Row ordering priority ──

/**
 * Lane order within the non-main-thread tier (design §3).
 * is_main_thread=true lines come first; remaining lines sort by topology_role
 * priority below, stable within each group by original array order.
 *
 * Shared by BOTH zones of the structure page (causal skeleton lanes + chapter
 * workbench rows via deriveWorkbenchLayout) so both views produce IDENTICAL row
 * order — a scene's lane must match across them for cross-view reading (同线同行).
 *
 * Pure & deterministic. Exported single source (DRY — avoids the two views' row
 * orders drifting apart).
 */
const TOPOLOGY_PRIORITY: Record<LineTopologyRole, number> = {
  converging: 0,
  'parallel-worldview': 1,
  offline: 2,
  'if-branch': 3,
  side: 4
};

export function orderLinesByPriority(lines: SceneLine[]): { lineId: string; name: string }[] {
  const indexed = lines.map((line, idx) => ({ line, idx }));
  indexed.sort((a, b) => {
    const aMain = a.line.is_main_thread ? 0 : 1;
    const bMain = b.line.is_main_thread ? 0 : 1;
    if (aMain !== bMain) return aMain - bMain;
    // CR-006 defense: `?? 99` so an unmapped/out-of-contract topology_role
    // (TS-exhaustive but runtime-defensive against malformed agent data) sorts
    // to the end instead of producing NaN (undefined-undefined).
    const aP = TOPOLOGY_PRIORITY[a.line.topology_role] ?? 99;
    const bP = TOPOLOGY_PRIORITY[b.line.topology_role] ?? 99;
    if (aP !== bP) return aP - bP;
    return a.idx - b.idx; // stable within group
  });
  return indexed.map(({ line }) => ({ lineId: line.id, name: line.name }));
}

/**
 * 读侧阅读序键的形状守卫（CR 组1 #121）：presentationOrder 缺字段/非对象/字段非
 * 有限数字时**不 throw、不把 NaN 送进比较器污染全序**——该节点整体视为「无有效
 * 阅读序」，归一为稳定末位（chapter=pos=+∞）。
 *
 * 选型说明（CR 给了「稳定末位 ∥ 读侧默认 {0,0}」两案，取稳定末位）：无法定序的
 * 场景本就是最晚被安排的对象——与工作台「待编排列收尾」语义同向；若取默认 {0,0}
 * 反而会把它插到全书最前，与失序的真实状态相反。任一字段无效即整体降末位（半有
 * 效键排序会产生「章内漂移」的伪精度，不如整键诚实）。
 *
 * +∞ 键的两个比较性质：① 与任意有限键不等 → 有序恒在前；② 两键同为 +∞ 时相等
 * 短路进原数组序平票分支——两路都不会出现 NaN 相减。
 */
type ReadOrderKey = { readonly chapter: number; readonly pos: number };
const UNORDERED_LAST: ReadOrderKey = { chapter: Number.POSITIVE_INFINITY, pos: Number.POSITIVE_INFINITY };

function readOrderKey(node: SceneNode): ReadOrderKey {
  // 形状探针式读法同 isSceneGraphLike：store cast 信任 unknown，部分注水数据在此
  // 收敛为末位而不是炸掉整个派生（schema 合法路径零行为差异——chapter/pos 恒有限）。
  const po = (node as { presentationOrder?: unknown }).presentationOrder;
  if (!po || typeof po !== 'object') return UNORDERED_LAST;
  const chapter = (po as { chapter?: unknown }).chapter;
  const pos = (po as { pos?: unknown }).pos;
  if (typeof chapter !== 'number' || !Number.isFinite(chapter)) return UNORDERED_LAST;
  if (typeof pos !== 'number' || !Number.isFinite(pos)) return UNORDERED_LAST;
  return { chapter, pos };
}

/**
 * per-node 阅读序派生：按 presentationOrder.{chapter,pos} 稳定序（同 (chapter,pos)
 * 平票按原数组序）给每个节点 0..N-1 的全局 readIndex。**派生不存储**——章是排序键，
 * 序号由本函数单源计算。
 *
 * CR 组1 #121：比较器经 readOrderKey 收敛坏输入（缺 presentationOrder / NaN /
 * Infinity → 全体稳定末位），派生对**任意输入 total**（Map 覆盖全部节点 id）。
 *
 * 批 7 注：readPosition 独立轴的渲染面已退役；本派生是工作台 chip 阅读序号与倒叙
 * 判定（storyRank ≠ readIndex）的数据源（prd/implement 3.1 单源承诺），勿在消费侧
 * 重写排序。Pure & deterministic：同输入同输出，输入不被突变。
 */
export function deriveReadIndexByNode(nodes: SceneNode[]): Map<string, number> {
  const indexedNodes = nodes.map((node, idx) => ({ node, idx }));
  indexedNodes.sort((a, b) => {
    const ao = readOrderKey(a.node);
    const bo = readOrderKey(b.node);
    if (ao.chapter !== bo.chapter) return ao.chapter - bo.chapter;
    if (ao.pos !== bo.pos) return ao.pos - bo.pos;
    return a.idx - b.idx; // stable within identical (chapter,pos)
  });
  const out = new Map<string, number>();
  indexedNodes.forEach(({ node }, i) => out.set(node.id, i));
  return out;
}
