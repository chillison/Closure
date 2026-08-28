import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexStatus } from '@orison/shared-contracts';
import { KbIndexSettingsPage } from '../src/features/kb-index/KbIndexSettingsPage';
import { useAppStore } from '../src/shared/store/appStore';

const tFake = (key: string) => key;

const SAMPLE_STATUS: IndexStatus = {
  embeddingConfiguredModelId: 'embed-m',
  craft: { count: 7, pending: 1, model: 'craft-m', degraded: false },
  story: { projectId: '00001', projectAssets: 3, assetCards: 4, settingMd: 2, chapterChunks: 5, chapterSummaries: 2, pending: 2, model: 'embed-m', degraded: false },
};

describe('KbIndexSettingsPage', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    (globalThis.window as any) = globalThis.window ?? {};
    (window as any).orisonDesktop = {
      getIndexStatus: vi.fn(async () => SAMPLE_STATUS),
      rebuildCraftKb: vi.fn(),
      rebuildStoryIndex: vi.fn(),
    };
  });

  it('renders craft + story sections with counts and fetches status on mount', async () => {
    const fetchIndexStatus = vi.fn(async () => {
      useAppStore.setState({ indexStatus: SAMPLE_STATUS } as any);
    });
    useAppStore.setState({
      indexStatus: SAMPLE_STATUS,
      indexLoading: false,
      indexRebuilding: null,
      fetchIndexStatus,
      rebuildCraftIndex: vi.fn(),
      rebuildStoryIndex: vi.fn(),
      currentProject: { projectId: '00001' },
    } as any);

    render(<KbIndexSettingsPage t={tFake} />);

    expect(screen.getByText('kbIndex.craftTitle')).toBeTruthy();
    expect(screen.getByText('kbIndex.storyTitle')).toBeTruthy();
    // Count labels render.
    expect(screen.getByText('kbIndex.projectAssets')).toBeTruthy();
    expect(screen.getByText('kbIndex.assetCards')).toBeTruthy();
    expect(screen.getByText('kbIndex.settingMd')).toBeTruthy();
    await waitFor(() => expect(fetchIndexStatus).toHaveBeenCalled());
  });

  it('shows the no-project hint when no project is open', () => {
    useAppStore.setState({
      indexStatus: null,
      indexLoading: false,
      indexRebuilding: null,
      fetchIndexStatus: vi.fn(async () => undefined),
      rebuildCraftIndex: vi.fn(),
      rebuildStoryIndex: vi.fn(),
      currentProject: null,
    } as any);

    render(<KbIndexSettingsPage t={tFake} />);
    expect(screen.getByText('kbIndex.noProjectHint')).toBeTruthy();
  });

  // dogfood 2026-08-21（#39）：model 空且 pending>0 是「待补向量」的中间态（向量一条
  // 没落 ≠ 未配置——dim 降级/重建前），直译「未配置」会误导配了模型的用户。
  it('向量模型格：model 空且 pending>0 显示待补向量而非未配置', () => {
    const status: IndexStatus = {
      embeddingConfiguredModelId: 'embed-m',
      craft: { count: 7, pending: 0, model: 'craft-m', degraded: false },
      story: {
        projectId: '00001',
        projectAssets: 3,
        assetCards: 4,
        settingMd: 2,
        chapterChunks: 5,
        chapterSummaries: 2,
        pending: 6,
        model: null,
        degraded: true,
      },
    };
    useAppStore.setState({
      indexStatus: status,
      indexLoading: false,
      indexRebuilding: null,
      fetchIndexStatus: vi.fn(async () => undefined),
      rebuildCraftIndex: vi.fn(),
      rebuildStoryIndex: vi.fn(),
      currentProject: { projectId: '00001' },
    } as any);

    render(<KbIndexSettingsPage t={tFake} />);
    expect(screen.getByText('kbIndex.modelPending')).toBeTruthy();
    expect(screen.queryByText('kbIndex.modelNone')).toBeNull();
    // craft 有落向量模型 → 显示模型值本体。
    expect(screen.getByText('craft-m')).toBeTruthy();
  });

  // dogfood #39（T2 C2）：向量降级可见——degraded 由 shell 判定（isVectorArmDegraded
  // 单源），本页只渲染；不再只有 dev 日志知道向量臂静默 FTS-only。
  it('story degraded → 显示降级横幅（标题/明细/指引），craft 非降级不显示', () => {
    const status: IndexStatus = {
      embeddingConfiguredModelId: 'embed-new',
      craft: { count: 7, pending: 0, model: 'embed-new', degraded: false },
      story: {
        projectId: '00001',
        projectAssets: 3,
        assetCards: 4,
        settingMd: 2,
        chapterChunks: 5,
        chapterSummaries: 2,
        pending: 4,
        model: 'embed-old',
        degraded: true,
        // CR-T2-006：mismatch 明细改纯渲染 shell 的 storedModels（不再本地 LIMIT 1 重算）。
        storedModels: ['embed-old'],
      },
    };
    useAppStore.setState({
      indexStatus: status,
      indexLoading: false,
      indexRebuilding: null,
      fetchIndexStatus: vi.fn(async () => undefined),
      rebuildCraftIndex: vi.fn(),
      rebuildStoryIndex: vi.fn(),
      currentProject: { projectId: '00001' },
    } as any);

    render(<KbIndexSettingsPage t={tFake} />);
    expect(screen.getByText('kbIndex.degradedTitle')).toBeTruthy();
    // 存量模型 ≠ 配置模型 → mismatch 明细行 + pending 明细行 + 指引行都在。
    expect(screen.getByText('kbIndex.degradedModel')).toBeTruthy();
    expect(screen.getByText('kbIndex.degradedPending')).toBeTruthy();
    expect(screen.getByText('kbIndex.degradedAction')).toBeTruthy();
    // degraded 横幅是 per-section 的：story 降级不代表 craft 降级。
    const banners = screen.getAllByText('kbIndex.degradedTitle');
    expect(banners).toHaveLength(1);
  });

  it('degraded 但该段重建进行中 → 横幅不显示（计数实时下降期不闪）', () => {
    const status: IndexStatus = {
      embeddingConfiguredModelId: 'embed-m',
      craft: { count: 0, pending: 0, model: null, degraded: false },
      story: {
        projectId: '00001',
        projectAssets: 3,
        assetCards: 4,
        settingMd: 2,
        chapterChunks: 5,
        chapterSummaries: 2,
        pending: 4,
        model: null,
        degraded: true,
      },
    };
    useAppStore.setState({
      indexStatus: status,
      indexLoading: false,
      indexRebuilding: 'story',
      fetchIndexStatus: vi.fn(async () => undefined),
      rebuildCraftIndex: vi.fn(),
      rebuildStoryIndex: vi.fn(),
      currentProject: { projectId: '00001' },
    } as any);

    render(<KbIndexSettingsPage t={tFake} />);
    expect(screen.queryByText('kbIndex.degradedTitle')).toBeNull();
  });

  it('未配置模型时 degraded=false → 无横幅（pending 是预期 FTS-only 态，非降级）', () => {
    const status: IndexStatus = {
      embeddingConfiguredModelId: null,
      craft: { count: 0, pending: 0, model: null, degraded: false },
      story: {
        projectId: '00001',
        projectAssets: 3,
        assetCards: 4,
        settingMd: 2,
        chapterChunks: 5,
        chapterSummaries: 2,
        pending: 9,
        model: null,
        degraded: false,
      },
    };
    useAppStore.setState({
      indexStatus: status,
      indexLoading: false,
      indexRebuilding: null,
      fetchIndexStatus: vi.fn(async () => undefined),
      rebuildCraftIndex: vi.fn(),
      rebuildStoryIndex: vi.fn(),
      currentProject: { projectId: '00001' },
    } as any);

    render(<KbIndexSettingsPage t={tFake} />);
    expect(screen.queryByText('kbIndex.degradedTitle')).toBeNull();
  });

  // ── CR-T2-006（2026-08-25）：混合态明细——mismatch 推导归 shell（storedModels DISTINCT
  // 全量），UI 纯渲染；存量多模型 → 「多模型版本」行，非单模型不符行。──

  it('CR-T2-006: 混合存量（多模型、零 pending）→ degradedMixed 行，非 degradedModel 单模型行', () => {
    const status: IndexStatus = {
      embeddingConfiguredModelId: 'embed-new',
      craft: { count: 0, pending: 0, model: null, degraded: false, storedModels: [] },
      story: {
        projectId: '00001',
        projectAssets: 3,
        assetCards: 4,
        settingMd: 2,
        chapterChunks: 5,
        chapterSummaries: 2,
        pending: 0, // 混合态零 pending：旧写法横幅只剩标题+指引，无因可陈
        model: 'embed-new',
        degraded: true,
        storedModels: ['embed-new', 'embed-old'],
      },
    };
    useAppStore.setState({
      indexStatus: status,
      indexLoading: false,
      indexRebuilding: null,
      fetchIndexStatus: vi.fn(async () => undefined),
      rebuildCraftIndex: vi.fn(),
      rebuildStoryIndex: vi.fn(),
      currentProject: { projectId: '00001' },
    } as any);

    render(<KbIndexSettingsPage t={tFake} />);
    expect(screen.getByText('kbIndex.degradedTitle')).toBeTruthy();
    expect(screen.getByText('kbIndex.degradedMixed')).toBeTruthy();
    expect(screen.queryByText('kbIndex.degradedModel')).toBeNull();
    // 零 pending → pending 明细行不显示。
    expect(screen.queryByText('kbIndex.degradedPending')).toBeNull();
  });

  // ── CR-T2-014（2026-08-25）：后台扫在途（status.sweepInflight）并入「重建中」面——
  // 非本页发起的扫期间横幅不闪、按钮置「重建中…」。──

  it('CR-T2-014: sweepInflight（indexRebuilding=null）→ 横幅不显示 + 两段按钮呈重建中', () => {
    const status: IndexStatus = {
      embeddingConfiguredModelId: 'embed-m',
      sweepInflight: true,
      craft: { count: 0, pending: 3, model: null, degraded: true, storedModels: [] },
      story: {
        projectId: '00001',
        projectAssets: 3,
        assetCards: 4,
        settingMd: 2,
        chapterChunks: 5,
        chapterSummaries: 2,
        pending: 4,
        model: null,
        degraded: true,
        storedModels: [],
      },
    };
    useAppStore.setState({
      indexStatus: status,
      indexLoading: false,
      indexRebuilding: null, // 非本页发起——扫在途只经状态面透出
      fetchIndexStatus: vi.fn(async () => undefined),
      rebuildCraftIndex: vi.fn(),
      rebuildStoryIndex: vi.fn(),
      currentProject: { projectId: '00001' },
    } as any);

    render(<KbIndexSettingsPage t={tFake} />);
    expect(screen.queryByText('kbIndex.degradedTitle')).toBeNull(); // 横幅不闪
    // 两段（craft/story）都呈「重建中…」（扫覆盖两侧）。
    expect(screen.getAllByText('kbIndex.rebuilding')).toHaveLength(2);
    expect(screen.queryByText('kbIndex.rebuildStory')).toBeNull();
    expect(screen.queryByText('kbIndex.rebuildCraft')).toBeNull();
  });

  // dogfood #42：重建进行中每 2s 轮询状态——「待补向量」实时下降，而非整段重建
  // （可能数分钟）结束才一次性刷新。
  it('重建进行中每 2s 轮询状态，rebuilding 归 null 停表', async () => {
    vi.useFakeTimers();
    try {
      const fetchIndexStatus = vi.fn(async () => undefined);
      useAppStore.setState({
        indexStatus: SAMPLE_STATUS,
        indexLoading: false,
        indexRebuilding: 'story',
        fetchIndexStatus,
        rebuildCraftIndex: vi.fn(),
        rebuildStoryIndex: vi.fn(),
        currentProject: { projectId: '00001' },
      } as any);

      render(<KbIndexSettingsPage t={tFake} />);
      // mount 即 fetch 一次。
      await act(async () => {});
      const afterMount = fetchIndexStatus.mock.calls.length;
      expect(afterMount).toBeGreaterThanOrEqual(1);

      // 推进 2s × 2 → 再来两次轮询。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(fetchIndexStatus.mock.calls.length).toBeGreaterThanOrEqual(afterMount + 2);

      // rebuilding 归 null（完成/失败）→ 停表。
      act(() => {
        useAppStore.setState({ indexRebuilding: null } as any);
      });
      const stopped = fetchIndexStatus.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(fetchIndexStatus.mock.calls.length).toBe(stopped);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires rebuild actions when the rebuild buttons are clicked', async () => {
    const rebuildCraftIndex = vi.fn().mockResolvedValue(undefined);
    const rebuildStoryIndex = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      indexStatus: SAMPLE_STATUS,
      indexLoading: false,
      indexRebuilding: null,
      fetchIndexStatus: vi.fn(async () => undefined),
      rebuildCraftIndex,
      rebuildStoryIndex,
      currentProject: { projectId: '00001' },
    } as any);

    render(<KbIndexSettingsPage t={tFake} />);

    await userEvent.click(screen.getByRole('button', { name: 'kbIndex.rebuildCraft' }));
    expect(rebuildCraftIndex).toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'kbIndex.rebuildStory' }));
    expect(rebuildStoryIndex).toHaveBeenCalled();
  });
});
