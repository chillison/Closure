import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// dogfood R2 #77：outline:changed 分支契约测试——只验证 hook 的编排职责
// （守卫→300ms trailing debounce→refreshProjectDocument(hydrate:false)），
// helper 本体的装载语义在 projectSubscription.refresh.test.tsx 单测。
// partial mock：installProjectSubscription 保持真实现（appStore 组装层依赖它）。
vi.mock('../src/shared/store/projectSubscription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/store/projectSubscription')>();
  return { ...actual, refreshProjectDocument: vi.fn() };
});

import { useToolEvents } from '../src/shared/hooks/useToolEvents';
import { useAppStore } from '../src/shared/store/appStore';
import { refreshProjectDocument } from '../src/shared/store/projectSubscription';

const refreshMock = vi.mocked(refreshProjectDocument);

function ToolEventsHarness() {
  useToolEvents();
  return null;
}

/** 切换流本身也会调 refreshProjectDocument（无 options 参数）；增量分支按 hydrate:false 过滤。 */
const incrementalCalls = () =>
  refreshMock.mock.calls.filter((call) => (call[2] as { hydrate?: boolean } | undefined)?.hydrate === false);

describe('useToolEvents outline:changed 收敛刷新', () => {
  let emitToolEvent: ((event: { type: string; [key: string]: unknown }) => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    emitToolEvent = null;
    refreshMock.mockReset();
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'Manual', path: '/manual-project', type: 'novel' },
      openFiles: [],
      activeFilePath: null,
    } as any);
    (window as any).orisonDesktop = {
      onToolEvent: vi.fn((callback) => {
        emitToolEvent = callback;
        return vi.fn();
      }),
      wordCount: vi.fn(async () => 0),
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('当前项目的 outline:changed → 300ms trailing 后增量刷新（hydrate:false）', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({ type: 'outline:changed', projectPath: '/manual-project' });
    });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(incrementalCalls()).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(incrementalCalls()).toHaveLength(1);
    expect(incrementalCalls()[0][0]).toBe(useAppStore);
    expect(incrementalCalls()[0][1]).toBe('/manual-project');
  });

  it('窗口内连发合并成一次刷新（trailing debounce）', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({ type: 'outline:changed', projectPath: '/manual-project' });
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      emitToolEvent?.({ type: 'outline:changed', projectPath: '/manual-project' });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(incrementalCalls()).toHaveLength(1);
  });

  it('非当前项目的 outline:changed 被守卫拦下（不刷新）', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({ type: 'outline:changed', projectPath: '/other-project' });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(incrementalCalls()).toHaveLength(0);
  });

  it('卸载清掉 pending timer（挂起的防抖刷新不再发射）', () => {
    const { unmount } = render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({ type: 'outline:changed', projectPath: '/manual-project' });
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(incrementalCalls()).toHaveLength(0);
  });
});
