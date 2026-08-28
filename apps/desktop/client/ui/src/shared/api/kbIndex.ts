/**
 * KB index management API shell (Story 2.7 B段). Mirrors `shared/api/assets.ts`
 * etc. — every IPC call goes through `window.orisonDesktop` here, never directly
 * from a component or slice (spec/ui/module-structure invariant: IPC 走 shared/api).
 *
 * - `fetchIndexStatus`: craft (global) + current-project story derived-index
 *   counts / pending / model for the「知识库索引」settings page.
 * - `rebuildCraft`: orphan 2.1 `closure:rebuild-craft-kb` finally wired to a UI
 *   button (full reindex of the global craft KB).
 * - `rebuildStory`: Story 2.7 `closure:rebuild-story-index` — reindexAll
 *   (project_assets) + reindexAssetCards (asset_cards) for the current project.
 */
import type { CraftRebuildResult, IndexStatus, StoryRebuildResult } from '@orison/shared-contracts';

/** Read the preload bridge at call time (not module load) so tests that install
 *  a fake `window.orisonDesktop` per-case see it. Mirrors how slices access it. */
function api() {
  return window.orisonDesktop;
}

export async function fetchIndexStatus(projectId?: string): Promise<IndexStatus | null> {
  return (await api()?.getIndexStatus({ projectId: projectId ?? undefined })) ?? null;
}

export async function rebuildCraft(): Promise<CraftRebuildResult | null> {
  return (await api()?.rebuildCraftKb()) ?? null;
}

export async function rebuildStory(projectId: string): Promise<StoryRebuildResult | null> {
  return (await api()?.rebuildStoryIndex({ projectId })) ?? null;
}
