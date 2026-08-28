/**
 * Tool Notification - pushes events to the renderer when tools modify state.
 */
import { BrowserWindow } from 'electron';
import type { ProjectQuarantineInfo } from '@orison/desktop-local-bff';
import type { StyleInputRequestedEvent } from '@orison/shared-contracts';

export type ToolEvent =
  // Project-scoped events always carry a projectPath (the project they belong to).
  | ({ projectPath: string } & (
      | { type: 'file:changed'; path: string; paths?: string[] }
      | { type: 'chapter:changed'; chapterId: string }
      | { type: 'outline:changed' }
      | { type: 'image:created'; paths: string[] }
      | { type: 'git:changed' }
      | { type: 'memory:changed' }
      // 风格卡片 MVP（08-28 C 路）：leader request_style_input 工具的 UI 请求——renderer
      // 弹风格片段对话框（StyleInputDialog）。payload 契约单源 shared-contracts
      // StyleInputRequestedEvent（projectPath 由本 union 外层统一携带）。
      | Omit<StyleInputRequestedEvent, 'projectPath'>
      // Story 2.7: setting-card (asset_cards) backfill outcome. Always project-
      // scoped (the useToolEvents handler guards on projectPath). F4
      // (BLIND-2=ACCEPT-2): the craft KB rebuild has NO closure:indexed event - it
      // goes through the kb-index slice (synchronous CraftRebuildResult, 模式 A) +
      // its own toast, so a kind:'craft' variant was dead (never emitted, and even
      // if emitted it lacks projectPath -> dropped by the project-match guard).
      // Removed.
      | { type: 'closure:indexed'; kind: 'asset_cards'; count: number; status: 'success' | 'error'; message?: string }
      // quarantine-notify (2026-08-27): loadProject judged project.yaml corrupt and
      // renamed it aside (`.corrupt-<timestamp>` backup). Emitted from every
      // user-facing load IPC site (project open chain + in-session meta/field
      // writes); the renderer notification center dedupes per project per session
      // (useToolEvents), so multi-site emission is safe. Unlike other tool events
      // it is handled BEFORE the current-project match guard - quarantine can fire
      // during cold-start project listing, before any project is open.
      | { type: 'project:quarantined'; backupPath: string | null; reason: string; recovered: boolean }
    ));

export function notifyUI(event: ToolEvent) {
  BrowserWindow.getAllWindows().forEach((w) => {
    w.webContents.send('tool:event', event);
  });
}

/**
 * quarantine-notify：把 loadProject 判腐隔离事实推给 renderer 通知中心
 * （复用 tool:event 既有推送通道，不新造通知通道——PRD 硬约束 1）。
 */
export function notifyProjectQuarantined(projectPath: string, quarantine: ProjectQuarantineInfo) {
  notifyUI({
    type: 'project:quarantined',
    projectPath,
    backupPath: quarantine.backupPath,
    reason: quarantine.reason,
    recovered: quarantine.recovered,
  });
}
