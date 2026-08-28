import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewPage } from '../src/features/overview/OverviewPage';
import { gitCreateNode, gitLog } from '../src/shared/api/git';
import { useAppStore } from '../src/shared/store/appStore';

vi.mock('../src/shared/api/git', () => ({
  gitIsRepo: vi.fn(async () => false),
  gitLog: vi.fn(async () => []),
  gitCreateNode: vi.fn(async () => undefined),
  gitStatusCount: vi.fn(async () => 0),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('Overview 项目元数据持久化', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      currentProject: {
        projectId: 'project-a',
        name: 'Project A',
        path: '/project-a',
        type: 'novel',
      },
      creativeFields: {},
      novelChapters: [],
      projectWordCount: 0,
      openFiles: [],
    } as any);
    (window as any).orisonDesktop = {
      saveProjectMeta: vi.fn(async () => undefined),
      wordCount: vi.fn(async () => 0),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('输入立即进入 Store，并在卸载时保存最后值', () => {
    const view = render(<OverviewPage />);
    const nameInput = screen.getByPlaceholderText('Project Name');

    fireEvent.change(nameInput, { target: { value: 'Project A edited' } });

    expect(useAppStore.getState().currentProject?.name).toBe('Project A edited');
    view.unmount();
    expect((window as any).orisonDesktop.saveProjectMeta).toHaveBeenCalledWith(
      '/project-a',
      expect.objectContaining({ name: 'Project A edited' }),
    );
  });

  it('选择封面期间切换项目时不写入新项目', async () => {
    const picked = deferred<string | null>();
    (window as any).orisonDesktop.pickCoverImage = vi.fn(() => picked.promise);
    (window as any).orisonDesktop.copyCoverImage = vi.fn(async () => '/project-a/cover.png');

    render(<OverviewPage />);
    fireEvent.click(screen.getByTitle('Set cover'));

    await act(async () => {
      useAppStore.setState({
        currentProject: {
          projectId: 'project-b',
          name: 'Project B',
          path: '/project-b',
          type: 'novel',
        },
      } as any);
      picked.resolve('/external/cover.png');
      await picked.promise;
    });

    expect((window as any).orisonDesktop.copyCoverImage).not.toHaveBeenCalled();
    expect(useAppStore.getState().currentProject?.coverImage).toBeUndefined();
  });

  it('快照完成时不把旧项目记录渲染到新项目', async () => {
    const created = deferred<void>();
    vi.mocked(gitCreateNode).mockImplementation(() => created.promise);
    vi.mocked(gitLog).mockResolvedValue([]);

    render(<OverviewPage />);
    await act(async () => {});
    vi.mocked(gitLog).mockClear();
    fireEvent.click(screen.getByText('Save version'));

    await act(async () => {
      useAppStore.setState({
        currentProject: {
          projectId: 'project-b',
          name: 'Project B',
          path: '/project-b',
          type: 'novel',
        },
      } as any);
      created.resolve();
      await created.promise;
    });

    expect(vi.mocked(gitLog).mock.calls.filter(([path]) => path === '/project-a')).toHaveLength(0);
  });

  // Story 3.4（R5）：外部改 currentProject meta（agent patch / 其他面板编辑）后，
  // 本地 useState 应自愈回灌（mirror OutlineEditor 自愈守卫）。此前 hydrate 只 path-keyed，
  // 同 path 的 meta 变化不触发 re-seed → agent 改 name 后概览页仍显示旧值。
  it('外部改 currentProject.name 后输入框自愈回灌（非抢焦点）', async () => {
    render(<OverviewPage />);
    const nameInput = screen.getByPlaceholderText('Project Name') as HTMLInputElement;
    await act(async () => {});
    expect(nameInput.value).toBe('Project A');

    // 模拟外部改（agent patch / 其他面板编辑——同 path 不同 name）
    await act(async () => {
      useAppStore.setState({
        currentProject: {
          projectId: 'project-a',
          name: 'Agent Renamed',
          path: '/project-a',
          type: 'novel',
        },
      } as any);
    });

    // 本地输入应自愈为 store 的新值
    expect(nameInput.value).toBe('Agent Renamed');
  });

  it('外部改 logline / synopsis 后也自愈回灌', async () => {
    render(<OverviewPage />);
    await act(async () => {});

    await act(async () => {
      useAppStore.setState({
        currentProject: {
          projectId: 'project-a',
          name: 'Project A',
          path: '/project-a',
          type: 'novel',
          logline: 'AI 改的 logline',
          synopsis: 'AI 改的 synopsis',
        },
      } as any);
    });

    // 用 value 断言（i18n placeholder 在测试环境解析值不固定，用 value 找更稳）
    const allInputs = screen.getAllByRole('textbox');
    const logline = allInputs.find((el) => (el as HTMLInputElement).value === 'AI 改的 logline');
    const synopsis = allInputs.find((el) => (el as HTMLInputElement).value === 'AI 改的 synopsis');
    expect(logline).toBeTruthy();
    expect(synopsis).toBeTruthy();
  });

  it('用户正在打字时不被外部改抢焦点（userEditedRef 门控）', async () => {
    render(<OverviewPage />);
    const nameInput = screen.getByPlaceholderText('Project Name') as HTMLInputElement;
    await act(async () => {});

    // 模拟用户正在打字（触发 markEdited → userEditedRef=true + debounce pending）
    fireEvent.change(nameInput, { target: { value: '正在打字中' } });
    expect(nameInput.value).toBe('正在打字中');

    // 此时外部改 name（同 path）——不应抢焦点/覆盖用户的打字
    await act(async () => {
      useAppStore.setState({
        currentProject: {
          projectId: 'project-a',
          name: '不该覆盖',
          path: '/project-a',
          type: 'novel',
        },
      } as any);
    });

    // 用户正在打字 → 输入框保持用户的值
    expect(nameInput.value).toBe('正在打字中');
  });
});
