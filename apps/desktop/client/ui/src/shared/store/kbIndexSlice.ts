/**
 * KB index management slice (Story 2.7 B段). Powers the「知识库索引」settings
 * page: derived-index status (craft global + current-project story) + manual
 * rebuild actions. Mirrors the slice composition pattern (settingsSlice /
 * backgroundTasksSlice): project-scoped state self-registers a project-reset so
 * switching projects never bleeds the previous project's story counts into the
 * new one (spec/ui/state-management invariant).
 *
 * Rebuild feedback: the manual rebuild IPCs return typed results synchronously
 * (StoryRebuildResult / CraftRebuildResult, 模式 A), so the slice surfaces a
 * success/error toast directly from the result — distinct from the watcher's
 * fire-and-forget backfill, which goes through the `closure:indexed` event →
 * useToolEvents toast pipeline (C段). One toast per click, no event coupling.
 */
import type { StateCreator } from 'zustand';
import type { CraftRebuildResult, IndexStatus, StoryRebuildResult } from '@orison/shared-contracts';
import { registerProjectReset } from './resetRegistry';
import { useToastStore } from './toastStore';
import { translate } from '../i18n/useI18n';
import { fetchIndexStatus, rebuildCraft, rebuildStory } from '../api/kbIndex';

export type KbIndexRebuild = 'craft' | 'story';

export type KbIndexSlice = {
  indexStatus: IndexStatus | null;
  indexLoading: boolean;
  /** Which rebuild is in flight (craft | story), or null when idle. Drives the
   *  per-button disabled +「重建中…」affordance on the settings page. */
  indexRebuilding: KbIndexRebuild | null;
  fetchIndexStatus: () => Promise<void>;
  rebuildCraftIndex: () => Promise<void>;
  rebuildStoryIndex: () => Promise<void>;
};

type Deps = KbIndexSlice & {
  currentProject: { projectId?: string } | null;
  resolvedLocale: string;
};

/** Map a rebuild error code to a translated user message. Both rebuild IPCs use
 *  the same 模式 A codes (no-embedding-model / operation-failed), plus story adds
 *  no-project-path and sweep-in-progress (CR-T2-005). The message is surfaced as
 *  an error toast. */
function rebuildErrorMessage(locale: string, error: string, fallback: string): string {
  switch (error) {
    case 'no-embedding-model':
      return translate(locale, 'kbIndex.errorNoEmbeddingModel');
    case 'no-project-path':
      return translate(locale, 'kbIndex.errorNoProjectPath');
    case 'sweep-in-progress':
      return translate(locale, 'kbIndex.errorSweepInProgress');
    case 'operation-failed':
      return translate(locale, 'kbIndex.errorOperationFailed');
    default:
      return fallback || translate(locale, 'kbIndex.errorOperationFailed');
  }
}

export const createKbIndexSlice: StateCreator<
  Deps,
  [],
  [],
  KbIndexSlice
> = (set, get) => {
  registerProjectReset(() => {
    // story counts are project-scoped; drop them on switch so stale counts from
    // the previous project never render for the new one. craft is global, but the
    // whole status snapshot is cheap to refetch on the next page open.
    set({ indexStatus: null, indexLoading: false, indexRebuilding: null });
  });

  return {
    indexStatus: null,
    indexLoading: false,
    indexRebuilding: null,

    async fetchIndexStatus() {
      const projectId = get().currentProject?.projectId;
      set({ indexLoading: true });
      try {
        const status = await fetchIndexStatus(projectId);
        set({ indexStatus: status, indexLoading: false });
      } catch (err) {
        const locale = get().resolvedLocale ?? 'en-US';
        useToastStore
          .getState()
          .showToast(
            translate(locale, 'kbIndex.statusLoadFailed', { reason: err instanceof Error ? err.message : String(err) }),
            'error',
          );
        set({ indexLoading: false });
      }
    },

    async rebuildCraftIndex() {
      const locale = get().resolvedLocale ?? 'en-US';
      set({ indexRebuilding: 'craft' });
      try {
        const result = (await rebuildCraft()) as CraftRebuildResult | null;
        if (result && result.ok) {
          useToastStore
            .getState()
            .showToast(translate(locale, 'kbIndex.rebuildCraftSuccess', { n: result.reindexed }), 'success');
        } else if (result && !result.ok) {
          useToastStore
            .getState()
            .showToast(rebuildErrorMessage(locale, result.error, ''), 'error');
        }
        // Refresh counts regardless of outcome (a failed rebuild may still have
        // partial work; the status snapshot is the source of truth for the UI).
        await get().fetchIndexStatus();
      } catch (err) {
        useToastStore
          .getState()
          .showToast(rebuildErrorMessage(locale, 'operation-failed', err instanceof Error ? err.message : String(err)), 'error');
      } finally {
        set({ indexRebuilding: null });
      }
    },

    async rebuildStoryIndex() {
      const locale = get().resolvedLocale ?? 'en-US';
      const projectId = get().currentProject?.projectId;
      if (!projectId) {
        useToastStore.getState().showToast(translate(locale, 'kbIndex.errorNoProjectPath'), 'error');
        return;
      }
      set({ indexRebuilding: 'story' });
      try {
        const result = (await rebuildStory(projectId)) as StoryRebuildResult | null;
        if (result && result.ok) {
          useToastStore
            .getState()
            .showToast(translate(locale, 'kbIndex.rebuildStorySuccess', { n: result.reindexed }), 'success');
        } else if (result && !result.ok) {
          useToastStore
            .getState()
            .showToast(rebuildErrorMessage(locale, result.error, ''), 'error');
        }
        await get().fetchIndexStatus();
      } catch (err) {
        useToastStore
          .getState()
          .showToast(rebuildErrorMessage(locale, 'operation-failed', err instanceof Error ? err.message : String(err)), 'error');
      } finally {
        set({ indexRebuilding: null });
      }
    },
  };
};
