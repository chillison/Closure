import {
  completeProjectIdentityBackfill,
  type ProjectRecord,
} from '../db/projectRepository';

/**
 * 校验磁盘项目身份，并为迁移前已登记、但尚无 project_id 的旧项目执行一次性补写。
 *
 * 调用方必须确认路径来自路径守卫或持久注册表，并在同一项目的 withProjectLock 内
 * 调用，避免与其他 project.yaml 写入竞争。已有但不一致的 project_id 永远不会被覆盖。
 *
 * quarantine-notify（2026-08-27）：返回值额外携带 loadProject/migrate 的判腐隔离事实
 * （project.yaml 被改名 `.corrupt-*` 时调用方推 renderer 通知中心），null = 正常加载。
 */
export async function loadVerifiedProjectDocument(projectPath: string, registration: ProjectRecord) {
  const { loadProjectWithQuarantine, migrateLegacyProjectJsonWithQuarantine, saveProject } =
    await import('@orison/desktop-local-bff');
  const loaded = migrateLegacyProjectJsonWithQuarantine(projectPath);
  const document = loaded.document ?? loadProjectWithQuarantine(projectPath).document;
  if (!document) return { document: null, quarantined: loaded.quarantined };

  const diskProjectId = typeof document.meta.project_id === 'string'
    ? document.meta.project_id.trim()
    : '';
  if (diskProjectId) {
    if (diskProjectId !== registration.projectId) return { document: null, quarantined: loaded.quarantined };
    if (registration.identityBackfillPending) {
      completeProjectIdentityBackfill(projectPath, registration.projectId);
    }
    return { document, quarantined: loaded.quarantined };
  }

  if (!registration.identityBackfillPending || registration.deletedAt) return { document: null, quarantined: loaded.quarantined };

  const next = structuredClone(document);
  next.meta.project_id = registration.projectId;
  next.meta.updated_at = new Date().toISOString();
  next.meta.version = (next.meta.version ?? 0) + 1;
  saveProject(projectPath, next);
  completeProjectIdentityBackfill(projectPath, registration.projectId);
  return { document: next, quarantined: loaded.quarantined };
}
