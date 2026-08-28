import { ipcMain } from 'electron';
import { creativeFieldKeySchema } from '@orison/shared-contracts';
import type { ProjectFieldPatch } from '@orison/shared-contracts';
import { onFieldEdited, applyFieldPatchesWithSkipped, toggleFieldLock } from '@orison/desktop-local-bff';
import { assertSafePath } from './pathGuard';
import { withProjectLock } from '../fs/projectWriteLock';
import { notifyProjectQuarantined } from './toolNotify';

export function registerFieldSyncIpc() {
  ipcMain.handle('field:sync', async (_event, projectPath: string, field: string, data: unknown) => {
    assertSafePath(projectPath);
    const parsedField = creativeFieldKeySchema.parse(field);
    await withProjectLock(projectPath, () => {
      const result = onFieldEdited(projectPath, parsedField, data);
      // quarantine-notify（2026-08-27）：判腐隔离不透出则静默变 bootstrap 空文档落盘
      // （本字段之外的数据全丢）。renderer 按工程去重。
      if (result.quarantined) notifyProjectQuarantined(projectPath, result.quarantined);
      return result;
    });
  });

  ipcMain.handle('field:apply-agent-patch', async (_event, projectPath: string, fieldPatch: ProjectFieldPatch) => {
    assertSafePath(projectPath);
    // Story 3.1: return { applied, skipped } so the UI can surface locked-field
    // skips to the author (design WP5). applyFieldPatchesWithSkipped collects
    // locked drops (previously silent).
    return await withProjectLock(projectPath, () => applyFieldPatchesWithSkipped(projectPath, fieldPatch));
  });

  // Story 3.1: toggle a creative field's lock without bumping its version. UI lock
  // buttons call this; locked fields reject user edits (onFieldEdited throws) and
  // skip agent patches (applyFieldPatchesWithSkipped collects them).
  ipcMain.handle('field:toggle-lock', async (_event, projectPath: string, field: string) => {
    assertSafePath(projectPath);
    const parsedField = creativeFieldKeySchema.parse(field);
    await withProjectLock(projectPath, () => {
      // quarantine-notify：mirror field:sync——判腐隔离事实推通知中心。
      const quarantined = toggleFieldLock(projectPath, parsedField);
      if (quarantined) notifyProjectQuarantined(projectPath, quarantined);
      return quarantined;
    });
  });
}