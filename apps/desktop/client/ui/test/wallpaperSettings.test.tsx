/**
 * 08-25 设置：全窗口壁纸式背景（App 根唯一层，不分区）。三层：
 * - App 根背景层——有 url 渲染（background-image + opacity 内联变量）、无 url 不渲染、
 *   清空即卸载；`html[data-wallpaper]` 开关随 url 走（页面底面让位用）；
 *   08-26 磨砂变体：wallpaperFrost → `.app-wallpaper--frost` 类（CSS blur 整层）；
 * - settingsSlice——setter 即存快照（携带 wallpaperUrl/wallpaperOpacity/wallpaperFrost）
 *   + 0.1–1 钳制 + loadUserPreferences 水合；
 * - AppearanceSettingsPage——滑杆 10–100（0.1–1 的百分数面）、选图/恢复走 preload 桥、
 *   磨砂 checkbox（有壁纸才显）。
 *
 * （本包测试纪律：cd 到包内跑 vitest，勿在仓库根直跑——jsdom env 会丢。）
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsSlice, type SettingsSlice } from '../src/shared/store/settingsSlice';

// App 渲染面：五个视图组件与两个窗口钩子与本任务无关，mock 成空——被测对象是
// App.tsx 挂的那一层 .app-wallpaper。store 用真实 appStore（jsdom 可直接组装）。
vi.mock('../src/features/top-bar/TopBar', () => ({ TopBar: () => null }));
vi.mock('../src/pages/projects/ProjectsPage', () => ({ ProjectsPage: () => null }));
vi.mock('../src/pages/workspace/WorkspacePage', () => ({ WorkspacePage: () => null }));
vi.mock('../src/features/command-palette/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../src/shared/components/Toast', () => ({ Toast: () => null }));
vi.mock('../src/shared/components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../src/shared/hooks/useToolEvents', () => ({ useToolEvents: () => {} }));
vi.mock('../src/shared/hooks/useCloseGuard', () => ({ useCloseGuard: () => {} }));

import { App } from '../src/app/App';
import { useAppStore } from '../src/shared/store/appStore';
import { AppearanceSettingsPage } from '../src/shared/components/settings/AppearanceSettingsPage';

const tFake = (key: string, vars?: Record<string, string | number>) =>
  vars?.n !== undefined ? `${key}:${vars.n}` : key;

afterEach(() => cleanup());

describe('App 根背景层（全窗口壁纸，08-25）', () => {
  beforeEach(() => {
    (window as any).orisonDesktop = {
      saveUserPreferences: vi.fn().mockResolvedValue(undefined),
      loadUserPreferences: vi.fn(),
      listImportedFonts: vi.fn().mockResolvedValue([]),
    };
    useAppStore.setState({ wallpaperUrl: '', wallpaperOpacity: 1, wallpaperFrost: false } as any);
    delete document.documentElement.dataset.wallpaper;
  });

  it('renders nothing when no wallpaper url is set', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.app-wallpaper')).toBeNull();
    expect(document.documentElement.dataset.wallpaper).toBeUndefined();
  });

  it('renders the fixed bottom layer with the url and opacity when set', () => {
    useAppStore.getState().setWallpaperUrl('orison-file:///C:/Users/t/bg.png');
    useAppStore.getState().setWallpaperOpacity(0.4);

    const { container } = render(<App />);
    const layer = container.querySelector('.app-wallpaper') as HTMLElement;
    expect(layer).not.toBeNull();
    expect(layer.style.backgroundImage).toContain('orison-file:///C:/Users/t/bg.png');
    expect(layer.style.opacity).toBe('0.4');
    // 页面底面让位开关随 url 挂上（global.css 的 html[data-wallpaper] 规则消费）。
    expect(document.documentElement.dataset.wallpaper).toBe('on');
  });

  it('unmounts the layer (and clears the html flag) when the wallpaper is reset', () => {
    useAppStore.getState().setWallpaperUrl('orison-file:///C:/Users/t/bg.png');
    const { container, rerender } = render(<App />);
    expect(container.querySelector('.app-wallpaper')).not.toBeNull();

    useAppStore.getState().setWallpaperUrl('');
    rerender(<App />);
    expect(container.querySelector('.app-wallpaper')).toBeNull();
    expect(document.documentElement.dataset.wallpaper).toBeUndefined();
  });

  it('08-26 磨砂开关：frost on → 层带 --frost 变体类；off → 纯基类', () => {
    useAppStore.getState().setWallpaperUrl('orison-file:///C:/Users/t/bg.png');
    useAppStore.setState({ wallpaperFrost: true } as any);
    const { container, rerender } = render(<App />);
    let layer = container.querySelector('.app-wallpaper') as HTMLElement;
    expect(layer.className).toContain('app-wallpaper--frost');

    useAppStore.setState({ wallpaperFrost: false } as any);
    rerender(<App />);
    layer = container.querySelector('.app-wallpaper') as HTMLElement;
    expect(layer.className).not.toContain('app-wallpaper--frost');
  });
});

describe('settingsSlice 壁纸持久化（08-25）', () => {
  // 最小组合 store（本包测试纪律）：只装被测 slice。
  const useTestStore = create<SettingsSlice>()((...args) => ({
    ...createSettingsSlice(...args),
  }));

  beforeEach(() => {
    vi.restoreAllMocks();
    (window as any).orisonDesktop = {
      saveUserPreferences: vi.fn().mockResolvedValue(undefined),
      loadUserPreferences: vi.fn(),
      listImportedFonts: vi.fn().mockResolvedValue([]),
    };
  });

  it('setter 即存快照，payload 携带 wallpaperUrl / wallpaperOpacity', () => {
    useTestStore.getState().setWallpaperUrl('orison-file:///C:/w/bg.png');
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ wallpaperUrl: 'orison-file:///C:/w/bg.png' }),
    );
    expect(useTestStore.getState().wallpaperUrl).toBe('orison-file:///C:/w/bg.png');

    useTestStore.getState().setWallpaperOpacity(0.55);
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ wallpaperOpacity: 0.55 }),
    );
  });

  it('清空壁纸的快照不携带旧 URL（整文件覆盖写不复活已清除的壁纸）', () => {
    useTestStore.getState().setWallpaperUrl('orison-file:///C:/w/old.png');
    (window as any).orisonDesktop.saveUserPreferences.mockClear();
    useTestStore.getState().setWallpaperUrl('');
    const call = (window as any).orisonDesktop.saveUserPreferences.mock.calls[0][0];
    expect(call.wallpaperUrl).toBeUndefined();
    expect(useTestStore.getState().wallpaperUrl).toBe('');
  });

  it('他处偏好 setter 的基座快照携带壁纸三键（不丢字段）', () => {
    useTestStore.getState().setWallpaperUrl('orison-file:///C:/w/bg.png');
    useTestStore.getState().setWallpaperOpacity(0.7);
    useTestStore.getState().setWallpaperFrost(true);
    (window as any).orisonDesktop.saveUserPreferences.mockClear();
    useTestStore.getState().setShowWordCount(false);
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        wallpaperUrl: 'orison-file:///C:/w/bg.png',
        wallpaperOpacity: 0.7,
        wallpaperFrost: true,
      }),
    );
  });

  it('透明度钳制到 0.1–1 界内；非法值回默认 1', () => {
    useTestStore.getState().setWallpaperOpacity(0);
    expect(useTestStore.getState().wallpaperOpacity).toBe(0.1);
    useTestStore.getState().setWallpaperOpacity(5);
    expect(useTestStore.getState().wallpaperOpacity).toBe(1);
    useTestStore.getState().setWallpaperOpacity(Number.NaN);
    expect(useTestStore.getState().wallpaperOpacity).toBe(1);
  });

  it('loadUserPreferences 水合壁纸（越界值防御性钳回；缺键回默认）', async () => {
    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
      wallpaperUrl: 'orison-file:///C:/w/bg.png',
      wallpaperOpacity: 2,
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().wallpaperUrl).toBe('orison-file:///C:/w/bg.png');
    expect(useTestStore.getState().wallpaperOpacity).toBe(1);
    expect(document.documentElement.dataset.wallpaper).toBe('on');

    // 存量偏好文件（无壁纸键）→ 无壁纸 + 默认透明度。
    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().wallpaperUrl).toBe('');
    expect(useTestStore.getState().wallpaperOpacity).toBe(1);
    expect(document.documentElement.dataset.wallpaper).toBeUndefined();
  });

  it('08-26 磨砂：setter 即存快照；水合回读（缺键回默认 false）', async () => {
    useTestStore.getState().setWallpaperFrost(true);
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ wallpaperFrost: true }),
    );
    expect(useTestStore.getState().wallpaperFrost).toBe(true);

    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
      wallpaperFrost: true,
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().wallpaperFrost).toBe(true);

    // 存量文件无 wallpaperFrost 键 → 默认关。
    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().wallpaperFrost).toBe(false);
  });
});

describe('AppearanceSettingsPage 背景卡（08-25）', () => {
  function renderAppearancePage(opts: {
    url: string;
    opacity: number;
    frost?: boolean;
    setUrl?: ReturnType<typeof vi.fn>;
    setOpacity?: ReturnType<typeof vi.fn>;
    setFrost?: ReturnType<typeof vi.fn>;
  }) {
    return render(
      <AppearanceSettingsPage
        t={tFake}
        editorLineHeight={1.75}
        setEditorLineHeight={vi.fn()}
        readingFontFamily=""
        setReadingFontFamily={vi.fn()}
        readingFontWeight={400}
        setReadingFontWeight={vi.fn()}
        readingFontScale={1}
        setReadingFontScale={vi.fn()}
        wallpaperUrl={opts.url}
        setWallpaperUrl={opts.setUrl ?? vi.fn()}
        wallpaperOpacity={opts.opacity}
        setWallpaperOpacity={opts.setOpacity ?? vi.fn()}
        wallpaperFrost={opts.frost ?? false}
        setWallpaperFrost={opts.setFrost ?? vi.fn()}
        // R8 界面缩放：与本文件无关的兄弟设置项，喂缺省桩即可。
        interfaceScale={1}
        setInterfaceScale={vi.fn()}
      />,
    );
  }

  beforeEach(() => {
    (window as any).orisonDesktop = {
      listImportedFonts: vi.fn().mockResolvedValue([]),
      importFonts: vi.fn(),
      importWallpaper: vi.fn(),
      clearWallpaper: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('unset state: shows the none-label, no slider, no reset button', () => {
    renderAppearancePage({ url: '', opacity: 1 });
    expect(screen.getByText('settings.backgroundNone')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByText('settings.backgroundReset')).toBeNull();
    expect(screen.getByText('settings.backgroundChoose')).toBeInTheDocument();
    // 08-26 磨砂 checkbox 同样只在有壁纸时出现。
    expect(screen.queryByLabelText('settings.backgroundFrostHint')).toBeNull();
  });

  it('set state: thumbnail + 10–100 slider bound to the opacity', () => {
    renderAppearancePage({ url: 'orison-file:///C:/w/bg.png', opacity: 0.4 });
    const img = screen.getByAltText('') as HTMLImageElement;
    expect(img.className).toContain('wallpaper-preview');
    expect(img.getAttribute('src')).toBe('orison-file:///C:/w/bg.png');

    const slider = screen.getByLabelText('settings.backgroundOpacity') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.getAttribute('min')).toBe('10');
    expect(slider.getAttribute('max')).toBe('100');
    expect(slider.value).toBe('40');
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('moving the slider calls the setter with the 0.1–1 fraction', () => {
    const setWallpaperOpacity = vi.fn();
    renderAppearancePage({ url: 'orison-file:///C:/w/bg.png', opacity: 1, setOpacity: setWallpaperOpacity });
    fireEvent.change(screen.getByLabelText('settings.backgroundOpacity'), { target: { value: '25' } });
    expect(setWallpaperOpacity).toHaveBeenCalledWith(0.25);
  });

  it('08-26 磨砂 checkbox：有壁纸才显、checked 随 frost、点击调 setter', () => {
    const setWallpaperFrost = vi.fn();
    renderAppearancePage({ url: 'orison-file:///C:/w/bg.png', opacity: 1, frost: true, setFrost: setWallpaperFrost });
    const box = screen.getByLabelText('settings.backgroundFrostHint') as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(true);
    expect(screen.getByText('settings.backgroundFrost')).toBeInTheDocument();

    fireEvent.click(box);
    expect(setWallpaperFrost).toHaveBeenCalledWith(false);
  });

  it('choosing an image stores the returned orison-file url; reset clears via the bridge', async () => {
    const setWallpaperUrl = vi.fn();
    (window as any).orisonDesktop.importWallpaper.mockResolvedValue({
      url: 'orison-file:///C:/userData/wallpaper/pic.webp',
    });
    const unset = renderAppearancePage({ url: '', opacity: 1, setUrl: setWallpaperUrl });

    await fireEvent.click(unset.getByText('settings.backgroundChoose'));
    await waitFor(() =>
      expect(setWallpaperUrl).toHaveBeenCalledWith('orison-file:///C:/userData/wallpaper/pic.webp'),
    );

    // Reset（已设置态才有按钮）：清主进程目录 + 置空本地状态。
    (window as any).orisonDesktop.importWallpaper.mockClear();
    const set = renderAppearancePage({ url: 'orison-file:///C:/w/bg.png', opacity: 1, setUrl: setWallpaperUrl });
    await fireEvent.click(set.getByText('settings.backgroundReset'));
    await waitFor(() => expect((window as any).orisonDesktop.clearWallpaper).toHaveBeenCalled());
    expect(setWallpaperUrl).toHaveBeenCalledWith('');
  });
});
