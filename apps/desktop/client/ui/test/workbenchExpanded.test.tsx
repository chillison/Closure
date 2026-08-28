import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLayout } from '../src/widgets/layout/WorkspaceLayout';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';

// Story 3.2 + dogfood 2026-08-21 拍板：两种布局模式——docked（AgentPanel = 定宽侧栏，
// 长期默认）与 expanded（AgentPanel **全屏占据主区**直到项目文件侧栏旁，主区不渲染；
// 原「主区/工作台分屏」形态退役，并排需求由 docked 拖宽覆盖）。模式与 activePage 正交，
// 对话锚定不动。测试覆盖：state 切换、布局翻转 + BottomPanel 抑制 + split 互斥、
// AC5（切目标面板不丢对话）、项目隔离（切项目重置 expanded）。

const OR_KEY = 'orison_agentExpanded';

describe('workbench state (panelsSlice)', () => {
  beforeEach(() => {
    useAppStore.setState({
      agentExpanded: false,
      agentPanelOpen: false,
      splitDirection: 'none',
      splitFilePath: null,
    } as any);
    localStorage.removeItem(OR_KEY);
  });

  it('defaults to docked (agentExpanded false)', () => {
    expect(useAppStore.getState().agentExpanded).toBe(false);
  });

  it('toggleAgentExpanded flips the in-memory flag without persisting (project-scoped viewing state)', () => {
    // CR-001: agentExpanded is a viewing state (like mainView/splitDirection),
    // NOT persisted. A restart must not revive an expanded mode that project
    // isolation cleared — otherwise the previous project's direction context
    // would leak into a new project after restart.
    const { toggleAgentExpanded } = useAppStore.getState();
    toggleAgentExpanded();
    expect(useAppStore.getState().agentExpanded).toBe(true);
    expect(localStorage.getItem(OR_KEY)).toBeNull();

    toggleAgentExpanded();
    expect(useAppStore.getState().agentExpanded).toBe(false);
    expect(localStorage.getItem(OR_KEY)).toBeNull();
  });

  it('setAgentExpanded flips the in-memory flag without persisting', () => {
    useAppStore.getState().setAgentExpanded(true);
    expect(useAppStore.getState().agentExpanded).toBe(true);
    expect(localStorage.getItem(OR_KEY)).toBeNull();
    useAppStore.getState().setAgentExpanded(false);
    expect(useAppStore.getState().agentExpanded).toBe(false);
    expect(localStorage.getItem(OR_KEY)).toBeNull();
  });

  it('setAgentExpanded collapses an active split when entering expanded (expanded ⊥ split)', () => {
    useAppStore.setState({ splitDirection: 'horizontal', splitFilePath: 'I:/proj/c2.md' } as any);
    useAppStore.getState().setAgentExpanded(true);
    const s = useAppStore.getState();
    expect(s.agentExpanded).toBe(true);
    expect(s.splitDirection).toBe('none');
    expect(s.splitFilePath).toBeNull();
  });

  it('setSplit refuses to open a split while expanded (symmetric guard, toasts)', () => {
    useAppStore.setState({
      agentExpanded: true,
      activeFilePath: 'I:/proj/c1.md',
      openFiles: [
        { path: 'I:/proj/c1.md' },
        { path: 'I:/proj/c2.md' },
      ],
    } as any);
    // Spy on the toast sink so we can assert the guard fired without depending
    // on the toast UI. setSplit re-reads useToastStore.getState() at call time.
    const toastSpy = vi.spyOn(useToastStore.getState(), 'showToast');
    useAppStore.getState().setSplit('horizontal');
    // Split must remain collapsed.
    expect(useAppStore.getState().splitDirection).toBe('none');
    expect(useAppStore.getState().splitFilePath).toBeNull();
    expect(toastSpy).toHaveBeenCalled();
    toastSpy.mockRestore();
  });
});

describe('workbench project isolation', () => {
  beforeEach(() => {
    (window as any).orisonDesktop = {
      abortAgentRun: vi.fn(),
      loadProjectDocument: vi.fn().mockResolvedValue(null),
      writeFile: vi.fn().mockResolvedValue(true),
    };
    useAppStore.setState({
      currentProject: null,
      addRecentProject: vi.fn(),
      loadBgTasks: vi.fn(),
      agentExpanded: false,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resets agentExpanded to docked when the project changes', () => {
    useAppStore.setState({
      currentProject: { projectId: 'A', name: 'A', path: 'I:/proj-a', type: 'novel' },
    } as any);
    useAppStore.setState({ agentExpanded: true } as any);

    useAppStore.setState({
      currentProject: { projectId: 'B', name: 'B', path: 'I:/proj-b', type: 'novel' },
    } as any);

    expect(useAppStore.getState().agentExpanded).toBe(false);
  });
});

describe('WorkspaceLayout workbench expanded mode', () => {
  beforeEach(() => {
    (window as any).orisonDesktop = {
      abortAgentRun: vi.fn(),
      loadAgentSkills: vi.fn().mockResolvedValue([]),
      listAgentSessions: vi.fn().mockResolvedValue([]),
      loadProjectDocument: vi.fn().mockResolvedValue(null),
    };
    useAppStore.setState({
      activePage: 'overview',
      mainView: 'page',
      agentPanelOpen: false,
      agentExpanded: false,
      bottomPanelOpen: false,
      splitDirection: 'none',
      splitFilePath: null,
      openFiles: [],
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAppStore.setState({
      activePage: 'overview',
      agentPanelOpen: false,
      agentExpanded: false,
      bottomPanelOpen: false,
    } as any);
  });

  it('docked default: no expanded class and BottomPanel renders when open', async () => {
    useAppStore.setState({
      agentPanelOpen: true,
      bottomPanelOpen: true,
      agentExpanded: false,
    } as any);
    const { container } = render(<WorkspaceLayout />);
    await screen.findByPlaceholderText('Project Name');
    expect(container.querySelector('.workspace-row--expanded')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Bottom Panel Tabs' })).toBeInTheDocument();
  });

  it('expanded: applies the expanded class and suppresses BottomPanel', async () => {
    useAppStore.setState({
      agentPanelOpen: true,
      bottomPanelOpen: true,
      agentExpanded: true,
    } as any);
    const { container } = render(<WorkspaceLayout />);
    await waitFor(() => {
      expect(container.querySelector('.workspace-row--expanded')).not.toBeNull();
    });
    expect(screen.queryByRole('navigation', { name: 'Bottom Panel Tabs' })).toBeNull();
  });

  it('expanded is FULLSCREEN: workspace-main unmounted, workbench wrapper fills the row', async () => {
    // dogfood 2026-08-21 拍板：放大 = 占满主区（主区不渲染），非原分屏形态。
    useAppStore.setState({
      agentPanelOpen: true,
      agentExpanded: true,
    } as any);
    const { container } = render(<WorkspaceLayout />);
    await waitFor(() => {
      expect(container.querySelector('.workspace-row--expanded')).not.toBeNull();
    });
    // 主区整体不挂载（占满 = 独占，不是并排）。
    expect(container.querySelector('#main-content')).toBeNull();
    const dominant = container.querySelector('.workspace-workbench-dominant') as HTMLElement;
    expect(dominant).not.toBeNull();
    expect(dominant.style.flex).toContain('1');
  });

  it('falls back to docked proportions when the panel is closed even if agentExpanded is true in store', async () => {
    // agentExpanded stays true in store but the panel is closed — the layout
    // must not render an expanded workbench beside nothing.
    useAppStore.setState({
      agentPanelOpen: false,
      agentExpanded: true,
    } as any);
    const { container } = render(<WorkspaceLayout />);
    await screen.findByPlaceholderText('Project Name');
    expect(container.querySelector('.workspace-row--expanded')).toBeNull();
    expect(container.querySelector('.workspace-workbench-dominant')).toBeNull();
  });

  it('AC5: switching activePage while expanded keeps agent messages and pending patch', async () => {
    const messages = [{ id: 'm1', role: 'user' as const, content: 'hi', createdAt: 1 }];
    // A minimal pending-patch shape — only identity matters here; switching the
    // target panel must not reset the in-flight review.
    const pendingPatch = { runId: 'r1', patches: [], createdAt: 1 } as any;
    useAppStore.setState({
      agentPanelOpen: true,
      agentExpanded: true,
      agentMessages: messages,
      pendingPatch,
    } as any);
    render(<WorkspaceLayout />);
    await waitFor(() => {
      expect(useAppStore.getState().agentExpanded).toBe(true);
    });

    // 'novel' is the legacy fallback to OverviewPage (proven safe to render) —
    // the point is that activePage switching never touches agent conversation
    // state, which lives in a separate slice.
    useAppStore.getState().setActivePage('novel');
    useAppStore.getState().setActivePage('overview');

    const s = useAppStore.getState();
    expect(s.agentMessages).toEqual(messages);
    expect(s.pendingPatch).toEqual(pendingPatch);
    expect(s.agentExpanded).toBe(true);
  });

  it('expanded ⊥ split: setAgentExpanded(true) collapses an active split and re-renders expanded', async () => {
    useAppStore.setState({
      agentPanelOpen: true,
      agentExpanded: false,
      splitDirection: 'horizontal',
      splitFilePath: 'I:/proj/c2.md',
      openFiles: [
        { id: 't1', path: 'I:/proj/c1.md', name: 'c1.md', content: '', savedContent: '', kind: 'text' },
        { id: 't2', path: 'I:/proj/c2.md', name: 'c2.md', content: '', savedContent: '', kind: 'text' },
      ],
      activeFilePath: 'I:/proj/c1.md',
      mainView: 'files',
    } as any);
    const { container } = render(<WorkspaceLayout />);
    // Docked initially.
    expect(container.querySelector('.workspace-row--expanded')).toBeNull();

    useAppStore.getState().setAgentExpanded(true);
    expect(useAppStore.getState().splitDirection).toBe('none');
    await waitFor(() => {
      expect(container.querySelector('.workspace-row--expanded')).not.toBeNull();
    });
  });
});
