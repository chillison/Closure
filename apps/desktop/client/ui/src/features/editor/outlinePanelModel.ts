import {
  applyEpisodeActions,
  type EpisodeAction,
  type EpisodeOutline,
  type MajorTurningPointType,
} from '@orison/shared-contracts';
import { randomUUID } from '../../shared/util/id';

/**
 * dogfood R2 批次 C（大纲面板升级）纯函数模型层。
 *
 * 范式判据（ADR-3）：这里只做「不理解意义」的机械投影——按 phase_ref 过滤集纲、
 * 按 line.phase_ref 数场景、经 applyEpisodeActions（shared-contracts 单一写通道投影器）
 * 投影 update_episode patch。语义产出（打磨文案/细化集纲）走 sendAgentMessage 对话路径，
 * 不在本层。防御式 narrow：creativeFields 是 Partial<Record<CreativeFieldKey, unknown>>，
 * 本层收 unknown 出类型化结果。
 */

/** update_episode 的 patch 形状（从契约的 discriminated union 成员推导，不复制字段清单）。 */
export type EpisodeUpdatePatch = Extract<EpisodeAction, { op: 'update_episode' }>['patch'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

/**
 * CR-15（dogfood R2）：集纲写投影的畸形值防线。null / undefined = 字段尚未建，宽容
 * coerce 成 []（首集写入合法路径）；其余非数组（字符串 / 对象等真畸形）返回 null，
 * 调用方据此 no-op（不 updateField）——原实现一律 coerce [] 再写，会把畸形在库数据
 * 静默清空成「只剩本次 patch 的一集」。
 */
function coerceEpisodeList(current: unknown): EpisodeOutline[] | null {
  if (current === null || current === undefined) return [];
  return Array.isArray(current) ? (current as EpisodeOutline[]) : null;
}

/**
 * OE-2 头部徽章：本卷「实际 M 场」——scene_graph.lines 中 phase_ref 命中本卷的线，
 * 其被 nodes.lineTags 引用的场景数（场景可属多线，按 node id 去重）。
 * 无命中线 / 无引用场景 → 0（UI 侧 0 = 不显示徽章）。大纲↔时间线首个可视桥。
 */
export function countPhaseScenes(sceneGraph: unknown, phaseId: string): number {
  if (!isRecord(sceneGraph)) return 0;
  const lines = sceneGraph.lines;
  if (!Array.isArray(lines)) return 0;

  const phaseLineIds = new Set<string>();
  for (const line of lines) {
    if (!isRecord(line) || line.phase_ref !== phaseId) continue;
    if (typeof line.id === 'string') phaseLineIds.add(line.id);
  }
  if (phaseLineIds.size === 0) return 0;

  const nodes = sceneGraph.nodes;
  if (!Array.isArray(nodes)) return 0;

  const sceneIds = new Set<string>();
  for (const node of nodes) {
    if (!isRecord(node) || !Array.isArray(node.lineTags)) continue;
    const tagged = node.lineTags.some((tag) => typeof tag === 'string' && phaseLineIds.has(tag));
    if (tagged && typeof node.id === 'string') sceneIds.add(node.id);
  }
  return sceneIds.size;
}

/**
 * OE-2 卷内集纲：episode_outlines 中 phase_ref 命中本卷的集，按 index 升序（章 = episode.index
 * 的读序约定）。非数组 / 无命中 → []。
 */
export function episodesForPhase(episodes: unknown, phaseId: string): EpisodeOutline[] {
  if (!Array.isArray(episodes)) return [];
  return episodes
    .filter((ep): ep is EpisodeOutline => isRecord(ep) && ep.phase_ref === phaseId)
    .sort((a, b) => (a.index || 0) - (b.index || 0));
}

/**
 * OE-2 集纲最小表单的写投影：经 shared-contracts 的 applyEpisodeActions（episode bounded
 * ops 的 update_episode op）投影出下一 full array——与 agent 工具 episode_outlines_update
 * 同一投影器，双通道铁律（手动 UI 与 AI 对话底层同走一个写通道）。调用方把结果交给
 * updateField('episode_outlines', next)（undo/持久化白拿）。
 *
 * 返回 null = current 真畸形非数组（CR-15）→ 调用方 no-op，不覆写在库数据。
 */
export function projectEpisodeUpdate(
  current: unknown,
  episodeId: string,
  patch: EpisodeUpdatePatch,
): EpisodeOutline[] | null {
  const list = coerceEpisodeList(current);
  if (list === null) return null;
  return applyEpisodeActions(list, [{ op: 'update_episode', episodeId, patch }]);
}

/**
 * CR-27（dogfood R2 批次 C 补完）：集纲手动增/删写投影（双通道铁律——episode_outlines_update
 * 工具已有 add_episode / remove_episode，此处给手动 UI 同一投影器 applyEpisodeActions 的
 * 通道）。畸形 current 政策同 projectEpisodeUpdate（null/undefined 宽容、真畸形 no-op）。
 */
export function projectEpisodeAdd(
  current: unknown,
  phaseId: string,
  title: string,
): EpisodeOutline[] | null {
  const list = coerceEpisodeList(current);
  if (list === null) return null;
  // index = 全局 max+1（index 是排序决策、无连续性契约——UI 增补取「排最后」的确定性
  // 决策；schema 数组 default 字段显式给全，保持落库对象 schema-valid）。
  const index = list.reduce((max, e) => Math.max(max, typeof e.index === 'number' ? e.index : 0), -1) + 1;
  const episode: EpisodeOutline = {
    id: `ep-${randomUUID()}`,
    index,
    title,
    character_progressions: [],
    emotional_beats: [],
    pacing_beats: [],
    foreshadowing: [],
    payoffs: [],
    dependsOn: [],
    phase_ref: phaseId,
    status: 'planned',
  };
  return applyEpisodeActions(list, [{ op: 'add_episode', episode }]);
}

export function projectEpisodeRemove(
  current: unknown,
  episodeId: string,
): EpisodeOutline[] | null {
  const list = coerceEpisodeList(current);
  if (list === null) return null;
  return applyEpisodeActions(list, [{ op: 'remove_episode', episodeId }]);
}

// ── CR-26（OE-4）：转折点 ↔ 锚点场景配对 ──
//
// majorTurningPointSchema 无显式 sceneRef（schema 注释明示「sceneRef 链接按落地公理推迟到
// 消费者」），本函数即消费者侧最小实现：锚点类转折点（core-anchor / secondary-anchor）与
// scene_graph 中 role 同类的场景按「同类第 n 个配第 n 个」确定性配对——纯机械计数（ADR-3 ✓，
// 「哪个转折点语义上对应哪场」是语义判断，归作者在时间线侧用 role 标记表达）。场景序 =
// storyTime 升序 + id 兜底（确定性）；fork-point 不关联（IF 分叉语义，设计 §OE-4）返回 null。

export type TurningPointAnchor = { id: string; title?: string };

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function anchorScenesForTurningPoints(
  types: MajorTurningPointType[],
  sceneGraph: unknown,
): Array<TurningPointAnchor | null> {
  const byRole = new Map<string, TurningPointAnchor[]>();
  if (isRecord(sceneGraph) && Array.isArray(sceneGraph.nodes)) {
    const anchors = sceneGraph.nodes
      .filter((n): n is Record<string, unknown> & { id: string } =>
        isRecord(n) && typeof n.id === 'string' && (n.role === 'core-anchor' || n.role === 'secondary-anchor'))
      .sort((a, b) =>
        (numOrZero(a.storyTime) - numOrZero(b.storyTime)) || String(a.id).localeCompare(String(b.id)));
    for (const n of anchors) {
      const role = String(n.role);
      const arr = byRole.get(role) ?? [];
      arr.push(typeof n.title === 'string' && n.title ? { id: n.id, title: n.title } : { id: n.id });
      byRole.set(role, arr);
    }
  }
  const counters = new Map<string, number>();
  return types.map((type) => {
    if (type === 'fork-point') return null;
    const ordinal = counters.get(type) ?? 0;
    counters.set(type, ordinal + 1);
    return byRole.get(type)?.[ordinal] ?? null;
  });
}

// ── CR-29（OE-3）：「活跃 = 最近 agent/user 编辑过的 phase」追踪 ──
//
// 记录存模块级而非组件 state：OutlineEditor 页切换即卸载（WorkspaceLayout switch 挂载），
// 本地 state 活不过重挂，而「活跃卷」恰恰要在下次挂载时决定 defaultOpen。不进
// creativeFieldsSlice（该 slice 正被并行 CR 修复改动，且这是页面级书签非应用状态）。
// 跨项目残留 id 无害——渲染侧 some() 归一化，不命中回退首卷。测试用 reset 复位。

let activePhaseRecord: string | null = null;

export function recordActivePhase(id: string): void {
  activePhaseRecord = id;
}

export function getRecordedActivePhase(): string | null {
  return activePhaseRecord;
}

export function resetActivePhaseTracking(): void {
  activePhaseRecord = null;
}

function stableJson(v: unknown): string {
  return JSON.stringify(v) ?? 'null';
}

/**
 * CR-29：diff 两份 outline.phases，返回「最近被编辑」的 phase id——新增或内容变化取末个
 * （多卷同改时后者覆盖，与「最近」语义一致）。prev/next 非数组 → null（不判）。删除不追
 * （被删卷不可能成为活跃卷，渲染侧归一化回退首卷）。
 */
export function latestChangedPhaseId(prev: unknown, next: unknown): string | null {
  if (!Array.isArray(prev) || !Array.isArray(next)) return null;
  const prevById = new Map<string, unknown>();
  for (const p of prev) {
    if (isRecord(p) && typeof p.id === 'string') prevById.set(p.id, p);
  }
  let changed: string | null = null;
  for (const p of next) {
    if (!isRecord(p) || typeof p.id !== 'string') continue;
    const before = prevById.get(p.id);
    if (before === undefined || stableJson(before) !== stableJson(p)) changed = p.id;
  }
  return changed;
}

/**
 * CR-29：diff 两份 episode_outlines，返回「最近被编辑的集所在卷」（phase_ref）。覆盖 agent
 * 落盘（applySelectedPatches 直写 store）与用户编辑回声（updateField）两条路；删除的集从
 * prev 取其 phase_ref（集已不在 next，卷仍应成为活跃卷）。无 phase_ref 的变更不追（挂不上卷）。
 */
export function latestChangedEpisodePhase(prev: unknown, next: unknown): string | null {
  if (!Array.isArray(prev) || !Array.isArray(next)) return null;
  const prevById = new Map<string, unknown>();
  for (const e of prev) {
    if (isRecord(e) && typeof e.id === 'string') prevById.set(e.id, e);
  }
  let changed: string | null = null;
  for (const e of next) {
    if (!isRecord(e) || typeof e.id !== 'string' || typeof e.phase_ref !== 'string') continue;
    const before = prevById.get(e.id);
    if (before === undefined || stableJson(before) !== stableJson(e)) changed = e.phase_ref;
  }
  if (changed !== null) return changed;
  const nextIds = new Set<unknown>();
  for (const e of next) {
    if (isRecord(e) && typeof e.id === 'string') nextIds.add(e.id);
  }
  for (const e of prev) {
    if (isRecord(e) && typeof e.id === 'string' && !nextIds.has(e.id) && typeof e.phase_ref === 'string') {
      changed = e.phase_ref;
    }
  }
  return changed;
}
