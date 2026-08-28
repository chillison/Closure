import crypto from 'node:crypto';
import type { FieldDependencyGraph, WorkflowSyncEvent } from './agent-contract';
import { creativeFieldKeys, type CreativeFieldKey } from './creative-fields';

// ── 硬编码依赖图 ──
// upstream 变化 → downstream 需要重算

const DEPENDENCY_EDGES: { upstream: CreativeFieldKey; downstream: CreativeFieldKey }[] = [
  { upstream: 'asset_cards', downstream: 'world_setting' },
  { upstream: 'asset_cards', downstream: 'outline' },
  { upstream: 'asset_cards', downstream: 'growth_curve' },
  { upstream: 'asset_cards', downstream: 'pacing_curve' },
  { upstream: 'asset_cards', downstream: 'emotion_curve' },
  { upstream: 'asset_cards', downstream: 'promise_registry' },
  { upstream: 'asset_cards', downstream: 'episode_outlines' },
  { upstream: 'relationship_graph', downstream: 'world_setting' },
  { upstream: 'relationship_graph', downstream: 'outline' },
  { upstream: 'relationship_graph', downstream: 'growth_curve' },
  { upstream: 'relationship_graph', downstream: 'pacing_curve' },
  { upstream: 'relationship_graph', downstream: 'emotion_curve' },
  { upstream: 'relationship_graph', downstream: 'promise_registry' },
  { upstream: 'relationship_graph', downstream: 'episode_outlines' },
  { upstream: 'world_setting', downstream: 'outline' },
  { upstream: 'world_setting', downstream: 'growth_curve' },
  { upstream: 'world_setting', downstream: 'pacing_curve' },
  { upstream: 'world_setting', downstream: 'emotion_curve' },
  { upstream: 'world_setting', downstream: 'promise_registry' },
  { upstream: 'world_setting', downstream: 'episode_outlines' },
  { upstream: 'outline', downstream: 'growth_curve' },
  { upstream: 'outline', downstream: 'pacing_curve' },
  { upstream: 'outline', downstream: 'emotion_curve' },
  { upstream: 'outline', downstream: 'promise_registry' },
  { upstream: 'outline', downstream: 'episode_outlines' },
  { upstream: 'growth_curve', downstream: 'episode_outlines' },
  { upstream: 'pacing_curve', downstream: 'episode_outlines' },
  { upstream: 'emotion_curve', downstream: 'episode_outlines' },
  { upstream: 'promise_registry', downstream: 'episode_outlines' },
  // Story 3.4（C-A4/D2）：scene_graph 入图。scene_graph 是 CreativeFieldKey（creative-fields.ts:17）
  // 但此前无入边 → producer 侧 markStaleFields 永不标 scene_graph stale（消费端无候选）。
  // 加 4 条上游边：outline（大纲下沉场景粒度）+ asset_cards/relationship_graph/world_setting
  // （设定变更影响场景结构）。改 outline → scene_graph stale；改 world_setting → scene_graph stale。
  // 图遍历（computeAffectedFields BFS）传递闭包：改 asset_cards → world_setting → outline → scene_graph
  // 已由传递覆盖，显式加 asset_cards→scene_graph 补直连（同层 asset_cards 已有→outline 边，但
  // scene_graph 消费 asset_cards 更直接——场涉及哪些设定卡）。零 migration（纯加边）。
  { upstream: 'outline', downstream: 'scene_graph' },
  { upstream: 'asset_cards', downstream: 'scene_graph' },
  { upstream: 'relationship_graph', downstream: 'scene_graph' },
  { upstream: 'world_setting', downstream: 'scene_graph' }
];

export function getDefaultDependencyGraph(): FieldDependencyGraph {
  return { edges: [...DEPENDENCY_EDGES] };
}

export function computeAffectedFields(changedField: CreativeFieldKey): CreativeFieldKey[] {
  const affected = new Set<CreativeFieldKey>();
  const queue: CreativeFieldKey[] = [changedField];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of DEPENDENCY_EDGES) {
      if (edge.upstream === current && !affected.has(edge.downstream)) {
        affected.add(edge.downstream);
        queue.push(edge.downstream);
      }
    }
  }

  return [...affected];
}

export function createSyncEvent(params: {
  source: 'user' | 'agent' | 'sync';
  field: CreativeFieldKey;
  entityId?: string;
  fromVersion: number;
  toVersion: number;
  reason: string;
}): WorkflowSyncEvent {
  return {
    id: `evt_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    source: params.source,
    field: params.field,
    entityId: params.entityId,
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    reason: params.reason,
    affectedFields: computeAffectedFields(params.field)
  };
}

export function markStaleFields(
  currentStale: CreativeFieldKey[],
  changedField: CreativeFieldKey
): CreativeFieldKey[] {
  const affected = computeAffectedFields(changedField);
  const merged = new Set([...currentStale, ...affected]);
  return [...merged];
}

// Story 3.4（C-A3）：markStaleFields 的对偶——从 currentStale 中移除已解决（resolved）的字段。
// 纯函数，不改入参，返回新数组。resolve/dismiss 一项涟漪影响后调此清 stale（落盘 stale:false）。
// 幂等：resolved 含不在 currentStale 中的字段时安全（Set difference 自动忽略）。
export function clearStaleFields(
  currentStale: CreativeFieldKey[],
  resolvedFields: CreativeFieldKey[]
): CreativeFieldKey[] {
  const resolvedSet = new Set(resolvedFields);
  return currentStale.filter((f) => !resolvedSet.has(f));
}

export function initFieldVersions(): Record<CreativeFieldKey, number> {
  const versions = {} as Record<CreativeFieldKey, number>;
  for (const key of creativeFieldKeys) {
    versions[key] = 0;
  }
  return versions;
}
