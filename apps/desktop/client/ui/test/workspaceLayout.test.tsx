import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLayout } from '../src/widgets/layout/WorkspaceLayout';
import { useAppStore } from '../src/shared/store/appStore';

describe('WorkspaceLayout', () => {
  beforeEach(() => {
    useAppStore.setState({ activePage: 'overview', currentProject: null });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ activePage: 'overview', currentProject: null });
    delete (window as any).orisonDesktop;
  });

  it('renders the standalone overview page by default', async () => {
    render(<WorkspaceLayout />);

    expect(screen.getByRole('navigation', { name: 'Main Navigation' })).toBeInTheDocument();
    // OverviewPage is lazy-loaded; its project-name input renders the translated placeholder.
    expect(await screen.findByPlaceholderText('Project Name')).toBeInTheDocument();
  });

  it('renders editor workspace and bottom panel for non-standalone modules', () => {
    useAppStore.setState({ activePage: 'novel', bottomPanelOpen: true, agentPanelOpen: true });

    render(<WorkspaceLayout />);

    expect(screen.getByRole('navigation', { name: 'Main Navigation' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Bottom Panel Tabs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse panel' })).toBeInTheDocument();
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
  });

  // dogfood R2 #19：watch 生命周期从 ProjectTree 移到布局级——项目打开期间恰好一个
  // watcher，不随侧栏面板/文件树开合（即 ProjectTree 挂卸）重启。
  it('项目打开期间启动目录 watcher，卸载（项目关闭）时停止', () => {
    const watchProject = vi.fn();
    const unwatchProject = vi.fn();
    (window as any).orisonDesktop = { watchProject, unwatchProject };
    useAppStore.setState({
      currentProject: { projectId: 'a', name: 'Project A', path: '/project-a', type: 'novel' },
    } as any);

    const view = render(<WorkspaceLayout />);

    expect(watchProject).toHaveBeenCalledTimes(1);
    expect(watchProject).toHaveBeenCalledWith('/project-a');
    expect(unwatchProject).not.toHaveBeenCalled();

    view.unmount();

    expect(unwatchProject).toHaveBeenCalledTimes(1);
  });

  it('切换项目时 watcher 换向：先停旧再启新', () => {
    const watchProject = vi.fn();
    const unwatchProject = vi.fn();
    (window as any).orisonDesktop = { watchProject, unwatchProject };
    useAppStore.setState({
      currentProject: { projectId: 'a', name: 'Project A', path: '/project-a', type: 'novel' },
    } as any);

    render(<WorkspaceLayout />);
    expect(watchProject).toHaveBeenCalledWith('/project-a');

    act(() => {
      useAppStore.setState({
        currentProject: { projectId: 'b', name: 'Project B', path: '/project-b', type: 'novel' },
      } as any);
    });

    expect(unwatchProject).toHaveBeenCalledTimes(1);
    expect(watchProject).toHaveBeenCalledTimes(2);
    expect(watchProject).toHaveBeenLastCalledWith('/project-b');
  });
});
