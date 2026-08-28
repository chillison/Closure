import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/shared/store/appStore';

/**
 * dogfood R2 #22：工作方式卡——creative_preferences 四轴在总览页的显示与直改。
 * 覆盖：四轴渲染/absent 未设态提示、点选直写 updateField、note blur 落盘（空 trim 清键）。
 */

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    t: (key: string) => key,
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

import { WorkingStyleSection } from '../src/features/overview/WorkingStyleSection';

describe('WorkingStyleSection（工作方式卡）', () => {
  beforeEach(() => {
    useAppStore.setState({
      projectDocumentHydrated: true,
      creativeFields: { creative_preferences: undefined },
      updateField: vi.fn(),
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  const getStore = () => useAppStore.getState() as unknown as {
    creativeFields: { creative_preferences?: Record<string, unknown> };
    updateField: ReturnType<typeof vi.fn>;
  };

  it('未设态：四轴标签 + 未设定提示（absent = 标准档语义可见）', () => {
    render(<WorkingStyleSection />);
    expect(screen.getByText('overview.workingStyleOutlineDepth')).toBeTruthy();
    expect(screen.getByText('overview.workingStyleArcTiming')).toBeTruthy();
    expect(screen.getByText('overview.workingStyleWorldDepth')).toBeTruthy();
    expect(screen.getByText('overview.workingStyleCharacterDepth')).toBeTruthy();
    // 四轴全 absent → 四条未设提示。
    expect(screen.getAllByText('overview.workingStyleUnset')).toHaveLength(4);
  });

  it('点选轴值直写 updateField（保序合并既有轴，不清其他）', () => {
    const store = getStore();
    useAppStore.setState({
      creativeFields: {
        creative_preferences: { outline_depth: 'skeleton' },
      },
    } as never);
    render(<WorkingStyleSection />);
    const arcBtn = screen.getByRole('radio', { name: 'overview.workingStyleArcTiming_upfront' });
    fireEvent.click(arcBtn);
    expect(store.updateField).toHaveBeenCalledWith('creative_preferences', {
      outline_depth: 'skeleton',
      arc_timing: 'upfront',
    });
  });

  it('已设轴高亮 aria-checked', () => {
    useAppStore.setState({
      creativeFields: { creative_preferences: { world_depth: 'shell' } },
    } as never);
    render(<WorkingStyleSection />);
    const shellBtn = screen.getByRole('radio', { name: 'overview.workingStyleWorldDepth_shell' });
    expect(shellBtn.getAttribute('aria-checked')).toBe('true');
    const upfrontBtn = screen.getByRole('radio', { name: 'overview.workingStyleWorldDepth_upfront' });
    expect(upfrontBtn.getAttribute('aria-checked')).toBe('false');
  });

  it('note：输入后 blur 落盘；盘上有值时清空 → 落盘对象不含 note 键（清除语义）；无变化不写', () => {
    const store = getStore();
    // 盘上已有 note（模拟此前落盘）。
    useAppStore.setState({
      creativeFields: { creative_preferences: { note: '旧备注' } },
    } as never);
    render(<WorkingStyleSection />);
    const note = screen.getByPlaceholderText('overview.workingStyleNotePlaceholder') as HTMLTextAreaElement;
    // 清空 → 落盘对象不含 note 键。
    fireEvent.change(note, { target: { value: '   ' } });
    fireEvent.blur(note);
    expect(store.updateField).toHaveBeenCalledWith('creative_preferences', {});
    // 清除已生效（同步 store）后值未变化再 blur → 不重复写。
    store.updateField.mockClear();
    useAppStore.setState({ creativeFields: { creative_preferences: {} } } as never);
    fireEvent.change(note, { target: { value: '  ' } });
    fireEvent.blur(note);
    expect(store.updateField).not.toHaveBeenCalled();
    // 输入新值 → 带 note 落盘（合并既有轴不清）。
    store.updateField.mockClear();
    fireEvent.change(note, { target: { value: '偏好快节奏' } });
    fireEvent.blur(note);
    expect(store.updateField).toHaveBeenCalledWith('creative_preferences', { note: '偏好快节奏' });
  });
});
