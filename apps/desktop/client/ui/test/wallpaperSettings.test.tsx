/**
 * 08-25 设置：全窗口壁纸式背景（App 根唯一层，不分区）。三层：
 * - App 根背景层——有 url 渲染（background-image + opacity 内联变量）、无 url 不渲染、
 *   清空即卸载；`html[data-wallpaper]` 开关随 url 走（页面底面让位用）；
 *   08-29 磨砂滑杆化：wallpaperFrostBlur > 0 → 内联 filter blur + 过扫 transform
 *   （N=20 时 =1.05 与旧固定磨砂严格一致）；= 0 → 无 filter/transform；
 * - settingsSlice——setter 即存快照（携带 wallpaperUrl/wallpaperOpacity/wallpaperFrostBlur）
 *   + 0.1–1 / 0–50 钳制 + loadUserPreferences 水合；
 * - AppearanceSettingsPage——不透明度滑杆 10–100（0.1–1 的百分数面）、磨砂滑杆 0–50
 *   （{n}px 值面）、选图/恢复走 preload 桥（两滑杆均仅已设壁纸时显示）。
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
    useAppStore.setState({ wallpaperUrl: '', wallpaperOpacity: 1, wallpaperFrostBlur: 0 } as any);
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

  it('08-29 磨砂滑杆化：blur > 0 → 内联 filter + 过扫 transform（20 = 旧固定行为）；0 → 无', () => {
    useAppStore.getState().setWallpaperUrl('orison-file:///C:/Users/t/bg.png');
    useAppStore.setState({ wallpaperFrostBlur: 20 } as any);
    const { container, rerender } = render(<App />);
    let layer = container.querySelector('.app-wallpaper') as HTMLElement;
    // 类名恒为纯基类（--frost 固定变体已退役，强度走内联样式）。
    expect(layer.className).toBe('app-wallpaper');
    expect(layer.style.filter).toBe('blur(20px)');
    expect(layer.style.transform).toBe('scale(1.05)');

    useAppStore.setState({ wallpaperFrostBlur: 6 } as any);
    rerender(<App />);
    layer = container.querySelector('.app-wallpaper') as HTMLElement;
    expect(layer.style.filter).toBe('blur(6px)');
    expect(layer.style.transform).toBe('scale(1.015)');

    useAppStore.setState({ wallpaperFrostBlur: 0 } as any);
    rerender(<App />);
    layer = container.querySelector('.app-wallpaper') as HTMLElement;
    expect(layer.style.filter).toBe('');
    expect(layer.style.transform).toBe('');
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
    useTestStore.getState().setWallpaperFrostBlur(20);
    (window as any).orisonDesktop.saveUserPreferences.mockClear();
    useTestStore.getState().setShowWordCount(false);
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        wallpaperUrl: 'orison-file:///C:/w/bg.png',
        wallpaperOpacity: 0.7,
        wallpaperFrostBlur: 20,
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

  it('08-29 磨砂滑杆化：setter 即存快照；水合回读（缺键回默认 0）', async () => {
    useTestStore.getState().setWallpaperFrostBlur(20);
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ wallpaperFrostBlur: 20 }),
    );
    expect(useTestStore.getState().wallpaperFrostBlur).toBe(20);

    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
      wallpaperFrostBlur: 12,
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().wallpaperFrostBlur).toBe(12);

    // 存量文件无 wallpaperFrostBlur 键 → 默认 0（关）。
    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().wallpaperFrostBlur).toBe(0);
  });

  it('磨砂半径钳制到 0–50 整数界内；非法值回默认 0', () => {
    useTestStore.getState().setWallpaperFrostBlur(999);
    expect(useTestStore.getState().wallpaperFrostBlur).toBe(50);
    useTestStore.getState().setWallpaperFrostBlur(-5);
    expect(useTestStore.getState().wallpaperFrostBlur).toBe(0);
    useTestStore.getState().setWallpaperFrostBlur(12.7);
    expect(useTestStore.getState().wallpaperFrostBlur).toBe(13);
    useTestStore.getState().setWallpaperFrostBlur(Number.NaN);
    expect(useTestStore.getState().wallpaperFrostBlur).toBe(0);
  });
});

describe('AppearanceSettingsPage 背景卡（08-25）', () => {
  function renderAppearancePage(opts: {
    url: string;
    opacity: number;
    frostBlur?: number;
    setUrl?: ReturnType<typeof vi.fn>;
    setOpacity?: ReturnType<typeof vi.fn>;
    setFrostBlur?: ReturnType<typeof vi.fn>;
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
        wallpaperFrostBlur={opts.frostBlur ?? 0}
        setWallpaperFrostBlur={opts.setFrostBlur ?? vi.fn()}
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
    // 08-29 磨砂滑杆同样只在有壁纸时出现（queryByRole('slider') 全 null 已覆盖两滑杆）。
    expect(screen.queryByLabelText('settings.backgroundFrost')).toBeNull();
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

  it('08-29 磨砂滑杆：0–50 整数档、值面 {n}px、拖动调 setter 传数值', () => {
    const setWallpaperFrostBlur = vi.fn();
    renderAppearancePage({
      url: 'orison-file:///C:/w/bg.png',
      opacity: 1,
      frostBlur: 20,
      setFrostBlur: setWallpaperFrostBlur,
    });
    // 滑杆经 aria-label 可寻（行标签是 span 非 <label>，不参与 ByLabelText 匹配）。
    const slider = screen.getByLabelText('settings.backgroundFrost') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.getAttribute('min')).toBe('0');
    expect(slider.getAttribute('max')).toBe('50');
    expect(slider.getAttribute('step')).toBe('1');
    expect(slider.value).toBe('20');
    expect(screen.getByText('20px')).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: '35' } });
    expect(setWallpaperFrostBlur).toHaveBeenCalledWith(35);
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
