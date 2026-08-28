import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToolEvents } from '../src/shared/hooks/useToolEvents';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';

function ToolEventsHarness() {
  useToolEvents();
  return null;
}

describe('useToolEvents closure:indexed', () => {
  let emitToolEvent: ((event: { type: string; [key: string]: unknown }) => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    emitToolEvent = null;
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'Project', path: '/p', type: 'novel' },
      resolvedLocale: 'en-US',
      openFiles: [],
      activeFilePath: null,
    } as any);
    useToastStore.setState({ toasts: [] });
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
    vi.restoreAllMocks();
  });

  it('shows a success toast on a backfill success with count>0', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({
        type: 'closure:indexed',
        kind: 'asset_cards',
        projectPath: '/p',
        count: 5,
        status: 'success',
      });
    });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('success');
    // en template: "Setting-card index ready — {n} cards." → interpolated count.
    expect(toasts[0].message).toContain('5');
  });

  it('shows an error toast on an indexing failure', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({
        type: 'closure:indexed',
        kind: 'asset_cards',
        projectPath: '/p',
        count: 0,
        status: 'error',
        message: 'boom',
      });
    });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('error');
    expect(toasts[0].message).toContain('boom');
  });

  it('stays silent on an incremental save (count=0 success)', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({
        type: 'closure:indexed',
        kind: 'asset_cards',
        projectPath: '/p',
        count: 0,
        status: 'success',
      });
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('ignores a closure:indexed event from a non-current project', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({
        type: 'closure:indexed',
        kind: 'asset_cards',
        projectPath: '/other-project',
        count: 9,
        status: 'success',
      });
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
