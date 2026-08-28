import type { CreativeFieldKey, WorkflowSyncEvent } from '@orison/shared-contracts';
import { createSyncEvent, markStaleFields, projectDocumentSchema } from '@orison/shared-contracts';
import { loadProjectWithQuarantine, saveProject, bootstrapProjectFromMeta } from './localProjectRepository';
import type { ProjectQuarantineInfo } from './localProjectRepository';

const FIELD_TO_KEY: Record<string, string> = {
  creative_brief: 'creative_brief',
  world_setting: 'world_setting',
  outline: 'outline_v2',
  episode_outlines: 'episode_outlines',
  growth_curve: 'growth_curve',
  pacing_curve: 'pacing_curve',
  emotion_curve: 'emotion_curve',
  asset_cards: 'asset_cards',
  relationship_graph: 'relationship_graph',
  promise_registry: 'promise_registry',
  info_release_map: 'info_release_map',
  scene_graph: 'scene_graph',
  // Story 8.2：写手弧节拍 creative field（field==docKey 默认模式）。loose 类型无 typecheck 兜底——
  // 漏加 = onFieldEdited 只 persist metadata 不 persist beats（silent data-drop，interface-contracts 3a）。
  arc_registry: 'arc_registry',
  // Story 8.6：创作深度偏好（field==docKey 默认模式；同上 loose 类型无 typecheck 兜底，3a）。
  creative_preferences: 'creative_preferences'
};

/**
 * 用户手动编辑某个创作字段后调用。
 * 递增 fieldVersion，生成 WorkflowSyncEvent，标记下游 stale 字段。
 *
 * Story 6.5 A1（emergence 自动落盘）：可选 `options.source` / `options.reason` 让自动链段节点（非人编辑）
 * 复用同一落盘流（version bump + markStaleFields + parse + saveProject），区别仅 source='agent'（非 'user'）。
 * emergence promise-emergence-node 经 promise_ledger_update builtin autoApply 模式调 handler → handler 调本函数
 * （source='agent'），落地 Promise ledger creative field（mirror 用户编辑流，design §3.3 emergence 走自动非 PatchReview）。
 * 缺省（无 options / source='user'）= 用户手编流（fieldSyncIpc syncField IPC 调），向后兼容。
 */
export function onFieldEdited(
  projectPath: string,
  field: CreativeFieldKey,
  newData: unknown,
  options?: { source?: 'user' | 'agent'; reason?: string }
): {
  syncEvent: WorkflowSyncEvent;
  staleFields: CreativeFieldKey[];
  /**
   * 判腐隔离事实（quarantine-notify，2026-08-27）：loadProject 判腐改名时透出，
   * IPC 层（field:sync）据此推通知中心。null = 正常加载零隔离。
   * 不透出则隔离静默变 bootstrap 空文档——本字段之外的 creative field 全丢而用户零感知。
   */
  quarantined: ProjectQuarantineInfo | null;
} {
  const source = options?.source ?? 'user';
  const reason = options?.reason ?? `用户编辑了 ${field}`;

  // project.yaml 不存在时自愈重建（首次编辑一个只存过 project.json 的项目）。
  const { document: loaded, quarantined } = loadProjectWithQuarantine(projectPath);
  const project = loaded ?? bootstrapProjectFromMeta(projectPath);

  const next = structuredClone(project) as Record<string, any>;

  // 检查字段是否被锁定
  if (!next.field_metadata) next.field_metadata = {};
  const currentMeta = next.field_metadata[field] ?? {
    version: 0,
    source: 'user',
    locked: false,
    dependsOn: [],
    stale: false
  };

  if (currentMeta.locked) {
    throw new Error(`Field ${field} is locked and cannot be edited`);
  }

  const fromVersion = currentMeta.version;
  const toVersion = fromVersion + 1;

  // 更新字段数据
  const docKey = FIELD_TO_KEY[field];
  if (docKey) {
    next[docKey] = newData;
  }

  // 更新当前字段的 metadata
  next.field_metadata[field] = {
    ...currentMeta,
    version: toVersion,
    source,
    stale: false
  };

  // 生成同步事件
  const syncEvent = createSyncEvent({
    source,
    field,
    fromVersion,
    toVersion,
    reason
  });

  // 标记下游 stale
  const currentStale: CreativeFieldKey[] = [];
  const staleFields = markStaleFields(currentStale, field);

  for (const staleField of staleFields) {
    if (!next.field_metadata[staleField]) {
      next.field_metadata[staleField] = {
        version: 0,
        source: 'agent',
        locked: false,
        dependsOn: [],
        stale: true
      };
    } else {
      next.field_metadata[staleField].stale = true;
    }
  }

  // 兜底 meta：手改/历史 project.yaml 可能缺 meta，直接 `next.meta.version += 1`
  // 会抛 TypeError，导致整次保存静默失败（编辑写不进盘）。
  if (!next.meta || typeof next.meta !== 'object') {
    const now = new Date().toISOString();
    next.meta = {
      id: crypto.randomUUID(),
      name: typeof next.name === 'string' ? next.name : 'Untitled',
      type: next.type === 'script' ? 'script' : 'novel',
      version: 0,
      created_at: now,
      updated_at: now
    };
  }
  if (typeof next.meta.version !== 'number') next.meta.version = 0;
  next.meta.version += 1;
  next.meta.updated_at = new Date().toISOString();

  const validated = projectDocumentSchema.parse(next);
  saveProject(projectPath, validated);

  return { syncEvent, staleFields, quarantined };
}

/**
 * Story 3.1: toggle a creative field's `locked` flag. Distinct from onFieldEdited
 * — no fieldVersion bump, no downstream stale marking; only the lock flips. Locked
 * fields reject user edits (onFieldEdited throws → UI toast) and the author is told
 * via the leader prompt not to propose patches to them (buildInteractionModeSegment,
 * workflow.ts). UI lock buttons call this via the `field:toggle-lock` IPC.
 *
 * quarantine-notify：返回判腐隔离事实（mirror onFieldEdited——loadProject ?? bootstrap
 * 同款静默隔离面），null = 正常加载。
 */
export function toggleFieldLock(
  projectPath: string,
  field: CreativeFieldKey
): ProjectQuarantineInfo | null {
  const { document: loaded, quarantined } = loadProjectWithQuarantine(projectPath);
  const project = loaded ?? bootstrapProjectFromMeta(projectPath);
  const next = structuredClone(project) as Record<string, any>;
  if (!next.field_metadata) next.field_metadata = {};
  const currentMeta = next.field_metadata[field] ?? {
    version: 0,
    source: 'user',
    locked: false,
    dependsOn: [],
    stale: false,
  };
  next.field_metadata[field] = { ...currentMeta, locked: !currentMeta.locked };
  const validated = projectDocumentSchema.parse(next);
  saveProject(projectPath, validated);
  return quarantined;
}
