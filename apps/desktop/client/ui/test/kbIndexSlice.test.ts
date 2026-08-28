import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { createKbIndexSlice, type KbIndexSlice } from '../src/shared/store/kbIndexSlice';
import { runProjectResets } from '../src/shared/store/resetRegistry';
import { useToastStore } from '../src/shared/store/toastStore';
import type { IndexStatus, StoryRebuildResult, CraftRebuildResult } from '@orison/shared-contracts';

declare global {
  interface Window {
    orisonDesktop: any;
  }
}

type TestState = KbIndexSlice & {
  currentProject: { projectId?: string } | null;
  resolvedLocale: string;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  resolvedLocale: 'en-US',
  ...createKbIndexSlice(...args),
}));

const SAMPLE_STATUS: IndexStatus = {
  embeddingConfiguredModelId: 'embed-m',
  craft: { count: 7, pending: 1, model: 'craft-m', degraded: false },
  story: { projectId: '00001', projectAssets: 3, assetCards: 4, settingMd: 2, chapterChunks: 5, chapterSummaries: 2, pending: 2, model: 'embed-m', degraded: false },
};

describe('kbIndexSlice', () => {
  beforeEach(() => {
    useTestStore.setState({
      currentProject: { projectId: '00001' },
      resolvedLocale: 'en-US',
      indexStatus: null,
      indexLoading: false,
      indexRebuilding: null,
    });
    useToastStore.setState({ toasts: [] });
    (globalThis.window as any) = globalThis.window ?? {};
    (window as any).orisonDesktop = {
      getIndexStatus: vi.fn(async () => SAMPLE_STATUS),
      rebuildCraftKb: vi.fn(),
      rebuildStoryIndex: vi.fn(),
    };
  });

  it('fetchIndexStatus stores the status snapshot', async () => {
    await useTestStore.getState().fetchIndexStatus();
    expect(useTestStore.getState().indexStatus).toEqual(SAMPLE_STATUS);
    expect((window as any).orisonDesktop.getIndexStatus).toHaveBeenCalledWith({ projectId: '00001' });
  });

  it('fetchIndexStatus passes undefined projectId when no project is open', async () => {
    useTestStore.setState({ currentProject: null });
    await useTestStore.getState().fetchIndexStatus();
    expect((window as any).orisonDesktop.getIndexStatus).toHaveBeenCalledWith({ projectId: undefined });
  });

  it('rebuildStoryIndex surfaces a success toast + refreshes status', async () => {
    const result: StoryRebuildResult = { ok: true, reindexed: 9, dimChanged: false, newDim: null };
    (window as any).orisonDesktop.rebuildStoryIndex = vi.fn(async () => result);
    await useTestStore.getState().rebuildStoryIndex();
    expect((window as any).orisonDesktop.rebuildStoryIndex).toHaveBeenCalledWith({ projectId: '00001' });
    expect(useTestStore.getState().indexRebuilding).toBeNull();
    expect(useToastStore.getState().toasts[0].level).toBe('success');
  });

  it('rebuildStoryIndex surfaces an error toast on no-embedding-model', async () => {
    const result: StoryRebuildResult = { ok: false, error: 'no-embedding-model' };
    (window as any).orisonDesktop.rebuildStoryIndex = vi.fn(async () => result);
    await useTestStore.getState().rebuildStoryIndex();
    expect(useToastStore.getState().toasts[0].level).toBe('error');
  });

  it('rebuildStoryIndex bails with an error toast when no project is open', async () => {
    useTestStore.setState({ currentProject: null });
    await useTestStore.getState().rebuildStoryIndex();
    expect((window as any).orisonDesktop.rebuildStoryIndex).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].level).toBe('error');
  });

  it('rebuildCraftIndex surfaces a success toast + calls the orphan craft IPC', async () => {
    const result: CraftRebuildResult = { ok: true, reindexed: 7, dimChanged: false, newDim: null };
    (window as any).orisonDesktop.rebuildCraftKb = vi.fn(async () => result);
    await useTestStore.getState().rebuildCraftIndex();
    expect((window as any).orisonDesktop.rebuildCraftKb).toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].level).toBe('success');
  });

  it('registerProjectReset clears index state on project switch', () => {
    useTestStore.setState({
      indexStatus: SAMPLE_STATUS,
      indexLoading: true,
      indexRebuilding: 'story',
    });
    runProjectResets();
    expect(useTestStore.getState().indexStatus).toBeNull();
    expect(useTestStore.getState().indexLoading).toBe(false);
    expect(useTestStore.getState().indexRebuilding).toBeNull();
  });
});
