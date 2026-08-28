/**
 * Story 8.6 R8：NewProjectDialog 表单退役——structure_pattern 选择行删除，
 * creativeBrief 组装统一 `{rawRequirement: 项目名}`（真灵感待冷启动对话补）。
 * 2026-08-20 dogfood：项目类型行同退役（恒 novel；script 创建路径随选项消失，'script'
 * 仍是 schema 合法历史值）。同日 overlay 误关修复回归——从对话框内拖选文字、在遮罩上
 * 释放 → 不得关闭（dogfood 实录：选中项目名即丢输入）；纯遮罩按下+释放 → 关闭。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectDialog } from '../src/shared/components/NewProjectDialog';
import { useAppStore } from '../src/shared/store/appStore';

declare global {
  interface Window {
    orisonDesktop: any;
  }
}

const saveProjectMeta = vi.fn();
const openProject = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  saveProjectMeta.mockReset().mockResolvedValue({ ok: true });
  openProject.mockReset().mockResolvedValue({ opened: true });
  onClose.mockReset();
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    openProject,
  } as any);
  (globalThis as any).window = globalThis as any;
  (window as any).orisonDesktop = {
    createProjectDirectory: vi.fn(async () => '/base/MyNovel'),
    pickProjectDirectory: vi.fn(async () => null),
    pickCoverImage: vi.fn(async () => null),
    copyCoverImage: vi.fn(async () => undefined),
    ensureProjectRegistration: vi.fn(async () => ({ projectId: 'p1' })),
    saveProjectMeta,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function createProject(name: string) {
  render(<NewProjectDialog onClose={onClose} />);
  const nameInput = screen.getByPlaceholderText('项目名称');
  await userEvent.type(nameInput, name);
  await userEvent.click(screen.getByRole('button', { name: '创建' }));
  // handleCreate is async — flush microtasks (IPC mocks resolve immediately).
  await Promise.resolve();
  await Promise.resolve();
}

describe('NewProjectDialog 表单退役', () => {
  it('表单无 structure_pattern 与项目类型选择行（选项均不渲染）', () => {
    render(<NewProjectDialog onClose={onClose} />);
    expect(screen.queryByText('结构 pattern')).toBeNull();
    expect(screen.queryByText(/空白起步/)).toBeNull();
    expect(screen.queryByText(/锚点单线/)).toBeNull();
    expect(screen.queryByText(/总分总莲花/)).toBeNull();
    expect(screen.queryByText('项目类型')).toBeNull();
    expect(screen.queryByRole('button', { name: '小说' })).toBeNull();
    expect(screen.queryByRole('button', { name: '剧本' })).toBeNull();
  });

  it('创建 → saveProjectMeta 收 {type:"novel", creativeBrief:{rawRequirement}} 无 structure_pattern', async () => {
    await createProject('我的小说');
    expect(saveProjectMeta).toHaveBeenCalledTimes(1);
    const meta = saveProjectMeta.mock.calls[0][1];
    expect(meta.type).toBe('novel');
    expect(meta.creativeBrief).toEqual({ rawRequirement: '我的小说' });
    expect(meta.creativeBrief.structure_pattern).toBeUndefined();
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('overlay 误关（useOverlayDismiss 回归）', () => {
  it('从输入框拖选、在遮罩上释放 → 不关闭，输入保留', async () => {
    render(<NewProjectDialog onClose={onClose} />);
    const nameInput = screen.getByPlaceholderText('项目名称');
    await userEvent.type(nameInput, '长标题小说名');
    const overlay = screen.getByRole('dialog');
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: nameInput },
      { keys: '[/MouseLeft]', target: overlay },
    ]);
    expect(onClose).not.toHaveBeenCalled();
    expect((nameInput as HTMLInputElement).value).toBe('长标题小说名');
  });

  it('纯遮罩点击（按下与释放均在遮罩上）→ 关闭', async () => {
    render(<NewProjectDialog onClose={onClose} />);
    const overlay = screen.getByRole('dialog');
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: overlay },
      { keys: '[/MouseLeft]', target: overlay },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
