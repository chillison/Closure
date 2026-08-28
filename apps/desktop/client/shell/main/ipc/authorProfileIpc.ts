/**
 * Author-profile accept IPC (Story 8.6 R4, design D6 / §3.1) — the dedicated
 * persist path for the suggest-tier `author_profile_patch` envelope.
 *
 * `author-profile:apply` is called by the UI diff card when the user ACCEPTS a
 * proposed author-profile note. The defining semantic (mirror
 * `closure:accept-setting-md`): it **RE-APPENDS the note against the CURRENT
 * file** (`appendAuthorProfileNote` — append-only, never writes the stale
 * proposed `after` snapshot), so author edits made between proposal and accept
 * are always preserved. There is no anchor-drift failure mode (nothing locates
 * into existing text); a read/fs failure returns `{ok:false}` → the UI toasts
 * and the user can retry.
 *
 * Structured-error shape (模式 A, mirror settingMdIpc / closureChainIpc):
 * schema violations and fs failures return `{ok:false, reason}` instead of
 * throwing. No projectPath involved — the profile is a machine-level global
 * file (`~/.orison/author_profile.md`), so there is no assertSafePath face.
 */
import { ipcMain } from 'electron';
import { applyAuthorProfileNoteInputSchema, type ApplyAuthorProfileNoteResult } from '@orison/shared-contracts';
import { getLogger } from '../logger';
import { appendAuthorProfileNote } from './toolHandlers/authorProfileHandlers';

export function registerAuthorProfileIpc(): void {
  ipcMain.handle(
    'author-profile:apply',
    async (_event, input: unknown): Promise<ApplyAuthorProfileNoteResult> => {
      // Validate at the IPC boundary via the shared schema; failures return
      // structured {ok:false}, not throws（模式 A）。
      const parsed = applyAuthorProfileNoteInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, reason: `invalid input (${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'unknown'})` };
      }

      try {
        return appendAuthorProfileNote(parsed.data.note);
      } catch (err) {
        // Never throw across the IPC boundary（模式 A）：appendAuthorProfileNote 本身
        // never-throws，此 catch 是兜底 belt。
        const reason = err instanceof Error ? err.message : String(err);
        getLogger().warn({ err: reason }, '[author_profile] accept append failed');
        return { ok: false, reason: `accept failed: ${reason}` };
      }
    },
  );
}
