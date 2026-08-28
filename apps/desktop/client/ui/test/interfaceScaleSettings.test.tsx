/**
 * R8 设置：全局界面缩放（08-26 structure-rebuild）。两层：
 * - settingsSlice——setter 即存快照（携带 interfaceScale）+ 契约钳制
 *   （0.85–1.3 带，NaN/缺键回默认 1）+ loadUserPreferences 水合；
 *   实际施加在 shell（webContents.setZoomFactor，见 shared-contracts 选型注释），
 *   渲染层零 DOM 施加。
 * - AppearanceSettingsPage——四档单选（85%/100%/115%/130%，当前档 is-active 高亮），
 *   点击调 setter 传原值；值面 % 内联渲染（壁纸透明度滑杆同款范式）。
 *
 * （本包测试纪律：cd 到包内跑 vitest，勿在仓库根直跑——jsdom env 会丢。）
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsSlice, type SettingsSlice } from '../src/shared/store/settingsSlice';
import { AppearanceSettingsPage } from '../src/shared/components/settings/AppearanceSettingsPage';

const tFake = (key: string) => key;

afterEach(() => cleanup());

describe('settingsSlice 界面缩放持久化（R8）', () => {
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

  it('setter 即存快照，payload 携带 interfaceScale（档位原值）', () => {
    useTestStore.getState().setInterfaceScale(1.15);
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ interfaceScale: 1.15 }),
    );
    expect(useTestStore.getState().interfaceScale).toBe(1.15);
  });

  it('他处偏好 setter 的基座快照携带 interfaceScale（不丢字段）', () => {
    useTestStore.getState().setInterfaceScale(0.85);
    (window as any).orisonDesktop.saveUserPreferences.mockClear();
    useTestStore.getState().setShowWordCount(false);
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ interfaceScale: 0.85 }),
    );
  });

  it('越界钳回合法带（0.85–1.3）；非法值回默认 1（白屏安全：仅数值经快照持久化）', () => {
    useTestStore.getState().setInterfaceScale(5);
    expect(useTestStore.getState().interfaceScale).toBe(1.3);
    useTestStore.getState().setInterfaceScale(0.01);
    expect(useTestStore.getState().interfaceScale).toBe(0.85);
    useTestStore.getState().setInterfaceScale(Number.NaN);
    expect(useTestStore.getState().interfaceScale).toBe(1);
  });

  it('loadUserPreferences 水合界面缩放；存量文件无键 → 默认 1', async () => {
    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
      interfaceScale: 1.3,
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().interfaceScale).toBe(1.3);

    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().interfaceScale).toBe(1);

    // 水合不触发写回（只读水合，避免启动期无谓落盘）。
    expect((window as any).orisonDesktop.saveUserPreferences).not.toHaveBeenCalled();
  });
});

describe('AppearanceSettingsPage 界面缩放卡（R8）', () => {
  function renderAppearancePage(opts: { scale?: number; setScale?: ReturnType<typeof vi.fn> }) {
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
        wallpaperUrl=""
        setWallpaperUrl={vi.fn()}
        wallpaperOpacity={1}
        setWallpaperOpacity={vi.fn()}
        wallpaperFrost={false}
        setWallpaperFrost={vi.fn()}
        interfaceScale={opts.scale ?? 1}
        setInterfaceScale={opts.setScale ?? vi.fn()}
      />,
    );
  }

  it('renders the four presets as percent labels with the current one highlighted', () => {
    renderAppearancePage({ scale: 1 });
    // 同名双现（背景卡同款）：区块标题 + 行标签。
    expect(screen.getAllByText('settings.interfaceScale')).toHaveLength(2);
    expect(screen.getByText('settings.interfaceScaleDesc')).toBeInTheDocument();
    for (const pct of ['85%', '100%', '115%', '130%']) {
      expect(screen.getByText(pct)).toBeInTheDocument();
    }
    const active = screen.getByText('100%').closest('button') as HTMLButtonElement;
    expect(active.className).toContain('is-active');
    const inactive = screen.getByText('130%').closest('button') as HTMLButtonElement;
    expect(inactive.className).not.toContain('is-active');
  });

  it('clicking a preset calls the setter with the raw preset value', () => {
    const setInterfaceScale = vi.fn();
    renderAppearancePage({ scale: 1, setScale: setInterfaceScale });
    fireEvent.click(screen.getByText('115%'));
    expect(setInterfaceScale).toHaveBeenCalledWith(1.15);
  });

  // BMad CR 组4：非预设值（盘面手改/钳制后浮点）就近高亮——当前档必有一枚亮灯。
  it('non-preset scale highlights the NEAREST preset (no all-dim row)', () => {
    renderAppearancePage({ scale: 1.2 }); // 落在 1.15 与 1.3 之间，距 1.15 更近
    const active = screen.getByText('115%').closest('button') as HTMLButtonElement;
    expect(active.className).toContain('is-active');
    for (const pct of ['85%', '100%', '130%']) {
      expect((screen.getByText(pct).closest('button') as HTMLButtonElement).className).not.toContain('is-active');
    }
  });

  it('lower-half non-preset snaps to the lower neighbour (0.92 → 85%)', () => {
    renderAppearancePage({ scale: 0.92 });
    expect(
      (screen.getByText('85%').closest('button') as HTMLButtonElement).className,
    ).toContain('is-active');
  });
});
