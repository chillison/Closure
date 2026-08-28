/**
 * Closure craft KB manual-rebuild IPC (Story 2.1 CR-craft-kb-011, design §4).
 *
 * `closure:rebuild-craft-kb` is the manual escape hatch complementary to the
 * startup scan + the file watcher: a full `reindexAllCraft` (DROP+reCREATE the
 * vec0 table on a dim change + re-embed every craft doc). It is the IPC surface
 * for a future "Rebuild craft KB" UI action (Epic 3 settings / command-bar); 2.1
 * ships no UI button (agent-facing story), so this handler is the deliverable.
 *
 * Returns a typed `CraftRebuildResult`: the missing-embedding-model state is an
 * expected user condition, not an invariant violation, so it is reported as
 * `{ ok:false, error:'no-embedding-model' }` rather than a thrown IPC rejection
 * (模式 A — ipc-handlers spec). A model-swap reindex that needs network embeds
 * is slow (minutes on a large library), so the handler awaits + the renderer
 * shows a progress affordance (the startup scan + watcher are fire-and-forget;
 * this manual path is user-initiated and synchronous-to-the-click).
 */
import { ipcMain } from 'electron';
import type { CraftRebuildResult } from '@orison/shared-contracts';
import { reindexAllCraft } from '../db/closureCraftIndexer';
import { getLogger } from '../logger';

export function registerClosureCraftIpc(): void {
  ipcMain.handle('closure:rebuild-craft-kb', async (): Promise<CraftRebuildResult> => {
    try {
      const result = await reindexAllCraft();
      getLogger().info(
        { reindexed: result.reindexed, dimChanged: result.dimChanged, newDim: result.newDim },
        'craft KB manual rebuild succeeded',
      );
      return { ok: true, ...result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Match the stable error thrown by reindexAllCraft on a missing model.
      const error: 'no-embedding-model' | 'operation-failed' = /no embedding model configured/i.test(msg)
        ? 'no-embedding-model'
        : 'operation-failed';
      getLogger().warn({ err: msg }, 'craft KB manual rebuild failed');
      return { ok: false, error };
    }
  });
}
