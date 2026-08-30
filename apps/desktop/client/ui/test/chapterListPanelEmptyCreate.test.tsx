import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChapterListPanel } from '../src/features/novel-workbench/ChapterListPanel';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';

/**
 * dogfood R2 #107 R1.2：ChapterListPanel 零章空态「新建第一章」按钮。
 * - 空态渲染按钮 / 有章时不渲染
 * - 点击 → createEntry + writeFile 两步，path 与 skeleton 逐字断言（磁盘派生
 *   消费契约 chapterDiskDerivation：frontmatter order + # 标题）
 * - 建成后主动派生注册（setNovelChapters → syncChaptersMeta 落 yaml）
 * - 失败路径（createEntry 拒 / writeFile 拒）toast 报错
 */

const PROJECT_PATH = 'C:/projects/暗城';
const SKELETON = '---\norder: 0\n---\n\n# 未命名章节\n';
const createBtnRegex = /^(新建第一章|Create First Chapter|novelChapter\.createFirstChapter)$/;
const failedToastRegex = /(新建章节失败|Failed to create chapter|novelChapter\.createFirstFailed)/;

/** mock `window.orisonDesktop`（mirror projectTreeProjectIsolation 惯例）。
 * 刻意不含 loadProjectDocument——projectSubscription 的切换装载流早退，
 * 隔离本组件行为；readDirectory/readFile 是 deriveChaptersFromDisk 的消费面。 */
function installDesktopApi(overrides: Record<string, unknown> = {}) {
  const api = {
    createEntry: vi.fn(async () => true),
    writeFile: vi.fn(async () => true),
    readDirectory: vi.fn(async () => [
      {
        name: 'chapters',
        path: '/chapters',
        isDir: true,
        children: [{ name: '第01章.md', path: '/chapters/第01章.md', isDir: false }],
      },
    ]),
    readFile: vi.fn(async () => SKELETON),
    syncChaptersMeta: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  (window as any).orisonDesktop = api;
  return api as {
    createEntry: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    syncChaptersMeta: ReturnType<typeof vi.fn>;
  };
}

describe('ChapterListPanel 零章空态新建按钮（dogfood R2 #107 R1.2）', () => {
  beforeEach(() => {
    localStorage.clear();
    useToastStore.setState({ toasts: [] });
    // 先设 project（触发订阅 reset 清 novelChapters），再种章列表
    // （novelWorkbench.test 同款两步 setState）。
    useAppStore.setState({
      currentProject: { projectId: 'p_001', name: '暗城', path: PROJECT_PATH, type: 'novel' },
    } as any);
    useAppStore.setState({ novelChapters: [], activeChapterId: null } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    (window as any).orisonDesktop = undefined;
  });

  it('零章空态渲染「新建第一章」按钮与空态文案', () => {
    installDesktopApi();
    render(<ChapterListPanel />);
    expect(
      screen.getByText(/(当前项目暂无章节|No chapters in this project yet|novelChapter\.emptyList)/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: createBtnRegex })).toBeTruthy();
  });

  it('有章时不渲染空态按钮', () => {
    installDesktopApi();
    useAppStore.setState({
      novelChapters: [
        { id: '第01章', title: '挖出来的是什么', sortOrder: 0, status: 'draft', sections: [] },
      ],
    } as any);
    render(<ChapterListPanel />);
    expect(screen.queryByRole('button', { name: createBtnRegex })).toBeNull();
    expect(screen.getByRole('list', { name: 'Chapter List' })).toBeTruthy();
  });

  it('点击按钮：createEntry + writeFile 参数逐字正确，并派生注册首章', async () => {
    const api = installDesktopApi();
    render(<ChapterListPanel />);
    await userEvent.click(screen.getByRole('button', { name: createBtnRegex }));

    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(1));
    expect(api.createEntry).toHaveBeenCalledWith(`${PROJECT_PATH}/chapters/第01章.md`, false);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    // skeleton 逐字：frontmatter order（0-based 对齐 episode.index）+ # 标题。
    expect(api.writeFile).toHaveBeenCalledWith(`${PROJECT_PATH}/chapters/第01章.md`, SKELETON);

    // 主动派生注册：章列表从空态翻成章条目（frontmatter order + # 标题被消费）。
    const list = await screen.findByRole('list', { name: 'Chapter List' });
    expect(within(list).getByText('未命名章节')).toBeTruthy();
    // yaml 注册口（AC3）：派生结果按 snake_case 映射落 syncChaptersMeta。
    await waitFor(() =>
      expect(api.syncChaptersMeta).toHaveBeenCalledWith(
        PROJECT_PATH,
        [expect.objectContaining({ id: '第01章', sort_order: 0 })],
      ),
    );
  });

  it('createEntry 失败（已存在/被拒）→ toast 报错且不写内容', async () => {
    const api = installDesktopApi({ createEntry: vi.fn(async () => false) });
    render(<ChapterListPanel />);
    await userEvent.click(screen.getByRole('button', { name: createBtnRegex }));

    await waitFor(() => expect(useToastStore.getState().toasts.length).toBeGreaterThan(0));
    expect(useToastStore.getState().toasts[0].message).toMatch(failedToastRegex);
    expect(useToastStore.getState().toasts[0].level).toBe('error');
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it('writeFile 失败 → toast 报错且不派生注册（空文件中间态无害）', async () => {
    const api = installDesktopApi({ writeFile: vi.fn(async () => false) });
    render(<ChapterListPanel />);
    await userEvent.click(screen.getByRole('button', { name: createBtnRegex }));

    await waitFor(() => expect(useToastStore.getState().toasts.length).toBeGreaterThan(0));
    expect(useToastStore.getState().toasts[0].message).toMatch(failedToastRegex);
    expect(api.syncChaptersMeta).not.toHaveBeenCalled();
  });
});
