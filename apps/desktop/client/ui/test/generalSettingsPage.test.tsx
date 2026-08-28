/**
 * thinking adapters task（S5，design §3.2）：对话上下文压缩红线设置。
 *
 * 两层：
 * - GeneralSettingsPage 纯 props 渲染——滑杆 50~100、当前值回显、说明文案；
 * - settingsSlice——setter 即存快照（payload 必须携带 contextCompaction，否则他处
 *   保存偏好的整文件覆盖写会把红线静默抹掉）+ 50–100 钳制 + loadUserPreferences 水合。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeneralSettingsPage } from '../src/shared/components/settings/GeneralSettingsPage';
import { createSettingsSlice, type SettingsSlice } from '../src/shared/store/settingsSlice';

const tFake = (key: string) => key;

function renderGeneralPage(redline: number, setRedline: (v: number) => void) {
  return render(
    <GeneralSettingsPage
      t={tFake}
      theme="system"
      setTheme={vi.fn()}
      locale="system"
      setLocale={vi.fn()}
      autoCheckUpdates
      setAutoCheckUpdates={vi.fn()}
      appVersion="1.0.0"
      onCheckForUpdate={() => {}}
      contextRedlinePercent={redline}
      setContextRedlinePercent={setRedline}
    />,
  );
}

afterEach(() => cleanup());

describe('GeneralSettingsPage 上下文压缩红线（thinking adapters task S5）', () => {
  beforeEach(() => {
    (window as any).orisonDesktop = {
      saveUserPreferences: vi.fn().mockResolvedValue(undefined),
      loadUserPreferences: vi.fn(),
      listImportedFonts: vi.fn().mockResolvedValue([]),
    };
  });

  it('renders the redline slider (50–100) with the current value and the explanation', () => {
    renderGeneralPage(95, vi.fn());
    const slider = screen.getByLabelText('settings.contextRedline') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.getAttribute('min')).toBe('50');
    expect(slider.getAttribute('max')).toBe('100');
    expect(slider.value).toBe('95');
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('settings.contextRedlineHint')).toBeInTheDocument();
    expect(screen.getByText('settings.contextTitle')).toBeInTheDocument();
  });

  it('moving the slider calls the setter with the numeric value', () => {
    const setContextRedlinePercent = vi.fn();
    renderGeneralPage(95, setContextRedlinePercent);
    fireEvent.change(screen.getByLabelText('settings.contextRedline'), { target: { value: '80' } });
    expect(setContextRedlinePercent).toHaveBeenCalledWith(80);
  });
});

describe('settingsSlice 红线持久化（thinking adapters task S5）', () => {
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

  it('setter 即存快照，payload 携带 contextCompaction.redlinePercent', () => {
    useTestStore.getState().setContextRedlinePercent(80);
    expect(useTestStore.getState().contextRedlinePercent).toBe(80);
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ contextCompaction: { redlinePercent: 80 } }),
    );
  });

  it('钳制到 50–100 界内（滑杆外的调用方/畸形值）', () => {
    useTestStore.getState().setContextRedlinePercent(300);
    expect(useTestStore.getState().contextRedlinePercent).toBe(100);
    useTestStore.getState().setContextRedlinePercent(10);
    expect(useTestStore.getState().contextRedlinePercent).toBe(50);
    useTestStore.getState().setContextRedlinePercent(Number.NaN);
    expect(useTestStore.getState().contextRedlinePercent).toBe(95); // 回默认
  });

  it('loadUserPreferences 水合红线（盘上越界值防御性钳回）', async () => {
    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
      contextCompaction: { redlinePercent: 75 },
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().contextRedlinePercent).toBe(75);

    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
      contextCompaction: { redlinePercent: 500 },
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().contextRedlinePercent).toBe(100);

    // 无 contextCompaction 字段（存量偏好文件）→ 默认 95。
    (window as any).orisonDesktop.loadUserPreferences.mockResolvedValue({
      theme: 'system',
      locale: 'system',
    });
    await useTestStore.getState().loadUserPreferences();
    expect(useTestStore.getState().contextRedlinePercent).toBe(95);
  });

  it('他处偏好 setter 的快照同样携带红线（整文件覆盖写不丢字段）', () => {
    useTestStore.getState().setContextRedlinePercent(88);
    (window as any).orisonDesktop.saveUserPreferences.mockClear();
    // 任意其它偏好变更（如 showWordCount）触发 buildPrefs 基座快照。
    useTestStore.getState().setShowWordCount(false);
    expect((window as any).orisonDesktop.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ contextCompaction: { redlinePercent: 88 } }),
    );
  });
});
