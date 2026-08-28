/**
 * Setting-md accept IPC (Story 2.2 WP-B, design §3) — the dedicated persist
 * path for the suggest-tier `setting_md_patch` envelope.
 *
 * `closure:accept-setting-md` is called by the UI diff card when the user
 * ACCEPTS a proposed setting-doc edit. The defining semantic: it **RE-APPLIES
 * the actions against the CURRENT file**, never persisting the stale proposed
 * `after` text — the file may have been edited between proposal and accept
 * (user edits, another tool call); blindly writing the proposal snapshot
 * would clobber those intermediate edits. A drifted anchor (quote no longer
 * locates uniquely) fails loudly with `{ok:false}` → the UI toasts「文档已变
 * 化，请重新提议」and the user asks the agent to re-propose. Anchors are local,
 * so unrelated edits elsewhere in the doc still apply cleanly.
 *
 * Structured-error shape (模式 A, mirror closureChainIpc): schema violations
 * and path rejections return `{ok:false, reason}` instead of throwing.
 * Persist core = `applyAndPersistSettingMd` (settingMdHandlers.ts — read fresh
 * + apply + atomicWrite + direct reindexSettingMd), wrapped in withProjectLock
 * so the read-modify-write is atomic against concurrent project writes.
 */
import { ipcMain } from 'electron';
import path from 'node:path';
import { acceptSettingMdInputSchema, type AcceptSettingMdResult } from '@orison/shared-contracts';
import { assertSafePath } from './pathGuard';
import { getLogger } from '../logger';
import { withProjectLock } from '../fs/projectWriteLock';
import { applyAndPersistSettingMd, isSafeSettingSlug } from './toolHandlers/settingMdHandlers';

export function registerSettingMdIpc(): void {
  ipcMain.handle(
    'closure:accept-setting-md',
    async (_event, input: unknown): Promise<AcceptSettingMdResult> => {
      // CR mirror (closureChainIpc CR-7): validate at the IPC boundary via the
      // shared schema; failures return structured {ok:false}, not throws.
      const parsed = acceptSettingMdInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, reason: `invalid input (${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'unknown'})` };
      }
      const { projectPath, settingId, actions } = parsed.data;

      // CR-10 mirror: path guard before any fs access.
      try {
        assertSafePath(projectPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `projectPath rejected: ${msg}` };
      }

      if (!isSafeSettingSlug(settingId)) {
        return { ok: false, reason: `settingId "${settingId.slice(0, 40)}" is not a safe slug (rejected)` };
      }

      try {
        return await withProjectLock(path.resolve(projectPath), async () =>
          applyAndPersistSettingMd(path.resolve(projectPath), settingId, actions),
        );
      } catch (err) {
        // Never throw across the IPC boundary (mirror 模式 A): surface the
        // failure so the card's toast can show it.
        const reason = err instanceof Error ? err.message : String(err);
        getLogger().warn({ err: reason, projectPath, settingId }, '[setting_md] accept persist failed');
        return { ok: false, reason: `accept failed: ${reason}` };
      }
    },
  );
}
