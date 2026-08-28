/**
 * T26（发现批10·多线实例三合一，2026-08-28）：多线场景「同一节点跨线实例」的
 * 轻量共享态 mini-store。
 *
 * ── 为什么需要它（用户缺陷定谳事实）──
 * 多线场景（lineTags 多条）在工作台每线行各渲染一枚 chip 实例（因果骨架同理，
 * 每线一枚卡）——同章节数据的投影。**提交时全实例同步**（updateField 单写通道，
 * 动态测试已证）；但 **T15 实时预览是 WorkbenchChip 本地 state，兄弟实例不知情**
 * ——被拖实例实时变宽、其余线的拷贝纹丝不动，用户判为缺陷（「按住时另一条线那
 * 份没动」）。同理：悬停任一拷贝时弧恒从主线那份画（T17 hover 只认 nodeId）、
 * 拷贝之间无任何静态标记可辨认。
 *
 * ── 形态：模块级 store，按 nodeId 键 ──
 *   - `publishNodePreview` / `clearNodePreview`：resize 手势的预览区间
 *     `{start, end}`（数据级——列号，非像素；像素盒由各实例用各自的视图注入
 *     resolver 换算，几何随视图走）。
 *   - `setNodeHover` / `clearNodeHover`：悬停键 `{nodeId, lineId}` 对（T25 弧
 *     逐实例锚定的身份源；悬停哪份拷贝 = 哪个 (node, line) 实例）。
 *   - 订阅端 hook（useSyncExternalStore）：
 *     `useNodePreview(nodeId)`（兄弟实例共享预览渲染）、
 *     `useNodeHoverLit(nodeId)`（同 nodeId 全实例柔光，含悬停者自身——视觉差异
 *     由 CSS :not(:hover) 承载）、`useNodeHoverKey()`（全键订阅，AssocLayer 渲染
 *     滤集唯一消费者）。
 *
 * ── 高频纪律（dispatch 明示）──
 *   - **不进 app store**：指针移动频率的 setState 会把每次预览步进广播成整页
 *     订阅者重渲染；模块 store 把通知粒度收敛到「该 nodeId 的订阅实例」（预览）
 *     或「旧/新 nodeId 两组 + 全键订阅者」（悬停）。
 *   - 发布即精确：setNodeHover 同值 no-op；clearNodeHover 按**完整键**条件清
 *     （leave 事件天然先于下一 enter 到达——React 由 mouseout/mouseover 合成
 *     enter/leave，mouseout 先派发；按键条件清即便次序颠倒也不会误杀新目标）。
 *
 * 手势归属不变（T26 ①）：gestureRef/pointer 配对/提交全在被拖实例本地，本 store
 * 只承载「预览值」的发布/订阅；T14 中断面纪律同步（endResize 清共享键与
 * gestureRef 生命周期同拍）。
 *
 * Paradigm guard：零语义——纯共享态中继；「拖到哪章」的语义归手势与写通道。
 */
import { useCallback, useSyncExternalStore } from 'react';

/** resize 预览区间（数据级：章列号，含端；像素换算归各实例视图注入 resolver）。 */
export type NodePreviewRange = { start: number; end: number };

/** 悬停键：(nodeId, lineId) 实例身份对——悬停哪份拷贝就记哪份。 */
export type NodeHoverKey = { nodeId: string; lineId: string };

type Listener = () => void;

/** nodeId → 订阅回调集（预览与悬停柔光共用——粒度都是 nodeId 级）。 */
const listenersByNode = new Map<string, Set<Listener>>();
/** 悬停全键订阅者（AssocLayer 渲染滤集——唯一消费者，单例级成本）。 */
const hoverKeyListeners = new Set<Listener>();

const previewByNode = new Map<string, NodePreviewRange>();
let hoverKey: NodeHoverKey | null = null;

function notifyNode(nodeId: string): void {
  const set = listenersByNode.get(nodeId);
  if (!set) return;
  for (const cb of set) cb();
}

function notifyHoverKeyListeners(): void {
  for (const cb of hoverKeyListeners) cb();
}

function subscribeNode(nodeId: string, cb: Listener): () => void {
  let set = listenersByNode.get(nodeId);
  if (!set) {
    set = new Set();
    listenersByNode.set(nodeId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listenersByNode.delete(nodeId);
  };
}

// ── 预览（T26 ①：跨实例 resize 预览传播）──

/**
 * 发布预览区间（手势拥有者每次预览步进调用）。只通知该 nodeId 的订阅实例——
 * 指针频率路径零全局广播。
 */
export function publishNodePreview(nodeId: string, range: NodePreviewRange): void {
  previewByNode.set(nodeId, range);
  notifyNode(nodeId);
}

/** 清除共享预览键（抬手/取消/拥有者卸载兜底）——兄弟实例随订阅回落。 */
export function clearNodePreview(nodeId: string): void {
  if (!previewByNode.has(nodeId)) return;
  previewByNode.delete(nodeId);
  notifyNode(nodeId);
}

/** 兄弟实例（及拥有者自身的非本地路径）订阅共享预览；null = 无进行中手势。 */
export function useNodePreview(nodeId: string): NodePreviewRange | null {
  const subscribe = useCallback((cb: Listener) => subscribeNode(nodeId, cb), [nodeId]);
  const getSnapshot = useCallback(() => previewByNode.get(nodeId) ?? null, [nodeId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ── 悬停（T26 ②：兄弟柔光 + T25 ③：弧逐实例锚定的身份源）──

/**
 * 发布悬停键（卡/chip 的 onMouseEnter）。同值 no-op（同实例子元素间抖动零通知）；
 * 变更时通知旧/新 nodeId 两组订阅者（柔光翻转）+ 全键订阅者（弧滤集）。
 */
export function setNodeHover(key: NodeHoverKey): void {
  if (hoverKey && hoverKey.nodeId === key.nodeId && hoverKey.lineId === key.lineId) return;
  const prev = hoverKey;
  hoverKey = key;
  if (prev) notifyNode(prev.nodeId);
  notifyNode(key.nodeId);
  notifyHoverKeyListeners();
}

/**
 * 条件清（按完整键）：store 当前键与本实例身份全等才清——迟到的 leave（次序
 * 颠倒的极端形态）不会误杀已移交给兄弟实例的新悬停。悬停移出/卸载路径共用。
 */
export function clearNodeHover(key: NodeHoverKey): void {
  if (!hoverKey || hoverKey.nodeId !== key.nodeId || hoverKey.lineId !== key.lineId) return;
  hoverKey = null;
  notifyNode(key.nodeId);
  notifyHoverKeyListeners();
}

/** 同 nodeId 全实例柔光订阅（悬停者自身也命中——视觉退让归 CSS :not(:hover)）。 */
export function useNodeHoverLit(nodeId: string): boolean {
  const subscribe = useCallback((cb: Listener) => subscribeNode(nodeId, cb), [nodeId]);
  const getSnapshot = useCallback(() => hoverKey?.nodeId === nodeId, [nodeId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 悬停全键订阅（AssocLayer 渲染滤集专用——返回稳定对象引用直至变更）。 */
export function useNodeHoverKey(): NodeHoverKey | null {
  return useSyncExternalStore(subscribeHoverKey, getHoverKey);
}
function subscribeHoverKey(cb: Listener): () => void {
  hoverKeyListeners.add(cb);
  return () => hoverKeyListeners.delete(cb);
}
function getHoverKey(): NodeHoverKey | null {
  return hoverKey;
}

/** 测试专用：整仓复位（防用例间模块态泄漏——生产零消费者）。 */
export function __resetNodeSharedStateForTests(): void {
  previewByNode.clear();
  hoverKey = null;
  listenersByNode.clear();
  hoverKeyListeners.clear();
}
