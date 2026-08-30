/**
 * dogfood R2 #109（R3.4）：frontmatter 章文件的富文本编辑往返。
 *
 * 覆盖（对照 implement.md 1.1 checklist）：
 * - 加载剥离：带 frontmatter 的章文件进 MarkdownEditor，编辑区只见正文（无 `---` 头），
 *   打开即干净（content === savedContent，不因 frontmatter 误标 dirty）。
 * - 编辑回拼逐字节保序：CRLF 变体、frontmatter 内注释/缩进原文回拼（parse→re-stringify 禁止）。
 * - autoSave 红线：saveFile 落盘内容必含 frontmatter（丢 `order:` = 章序崩坏，回到降级要防的事故）；
 *   自存后编辑区不被重载/回弹。
 * - 外部重载重捕获：savedContent 外部变更（reloadFile/reconcile 形态）→ 编辑区切到新正文，
 *   后续编辑回拼的是新 frontmatter。
 * - 对账基准：tab 全文模型（content/savedContent 恒含 frontmatter），外部对账不误报冲突。
 *
 * TiptapEditor mock 成受控 textarea（jsdom 不支持 ProseMirror；onChange 即编辑器
 * emit 的 body-only markdown）。store 用真实 useAppStore setState 注入（ui/testing.md）。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../src/shared/store/appStore';
import { MarkdownEditor } from '../src/features/editor/file-editor/MarkdownEditor';
import type { FileTab } from '../src/shared/store/fileTabsSlice';

vi.mock('../src/features/editor/TiptapEditor', () => ({
  TiptapEditor: ({ content = '', onChange }: { content?: string; onChange?: (value: string) => void }) => (
    <textarea
      aria-label="Mock Tiptap"
      value={content}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

function makeTab(id: string, path: string, content: string): FileTab {
  // kind:'text' — reconcileExternalFile/saveFile gate on it.
  return { id, path, name: path.split('/').pop() ?? path, content, savedContent: content, kind: 'text' };
}

/** Mirror FileEditor: select the tab from the live store so edits re-render. */
function Harness({ path }: { path: string }) {
  const file = useAppStore((s) => s.openFiles.find((f) => f.path === path));
  if (!file) return null;
  return <MarkdownEditor file={file} />;
}

function getEditor(container: HTMLElement): HTMLTextAreaElement {
  const ta = container.querySelector('textarea[aria-label="Mock Tiptap"]');
  expect(ta).toBeTruthy();
  return ta as HTMLTextAreaElement;
}

function getTab(path: string): FileTab {
  const tab = useAppStore.getState().openFiles.find((f) => f.path === path);
  expect(tab).toBeTruthy();
  return tab as FileTab;
}

const PATH = '/demo/chapters/第01章.md';

beforeEach(() => {
  (window as any).orisonDesktop = {
    writeFile: vi.fn(async () => true),
  };
  useAppStore.setState({
    openFiles: [],
    activeFilePath: null,
    resolvedLocale: 'en-US',
    currentProject: { name: 'Demo', path: '/demo', type: 'novel' },
  } as any);
});

afterEach(cleanup);

describe('MarkdownEditor front-matter handling (#109)', () => {
  it('feeds the editor the body only and opens clean (no front-matter dirty flag)', () => {
    const md = '---\norder: 0\n---\n\n# 挖出来的是什么\n\n正文第一段。';
    useAppStore.setState({ openFiles: [makeTab('tab-1', PATH, md)] } as any);

    const { container } = render(<Harness path={PATH} />);
    const ta = getEditor(container);
    expect(ta.value).not.toContain('---');
    expect(ta.value).not.toContain('order:');
    expect(ta.value).toContain('# 挖出来的是什么');
    // Full-text tab model: front-matter lives in the tab, not the editor, so
    // opening does not mark the file dirty.
    expect(getTab(PATH).content).toBe(md);
    expect(getTab(PATH).content === getTab(PATH).savedContent).toBe(true);
  });

  it('re-attaches the captured front-matter byte-exact on edits (CRLF/comments/indent preserved)', () => {
    const frontmatter = '---\r\n# 章节注册元数据\r\norder: 0\r\n  indent: keep\r\n---\r\n';
    const md = frontmatter + '\r\n# 标题\r\n\r\n旧正文。\r\n';
    useAppStore.setState({ openFiles: [makeTab('tab-2', PATH, md)] } as any);

    const { container } = render(<Harness path={PATH} />);
    const ta = getEditor(container);
    expect(ta.value).not.toContain('order:');
    expect(ta.value).toContain('旧正文。');

    fireEvent.change(ta, { target: { value: '\n# 标题\n\n新正文。' } });

    const tab = getTab(PATH);
    // Byte-exact restore: the ORIGINAL CRLF block (comments + indentation
    // untouched) followed by the body the editor emitted.
    expect(tab.content).toBe(frontmatter + '\n# 标题\n\n新正文。');
    // Dirty until saved — front-matter re-attach must not mask real edits.
    expect(tab.content !== tab.savedContent).toBe(true);
  });

  it('autosave red line: saveFile writes the front-matter to disk and stays clean after', async () => {
    const frontmatter = '---\r\norder: 3\r\n---\r\n';
    useAppStore.setState({ openFiles: [makeTab('tab-3', PATH, frontmatter + '\r\n# 第二章\r\n')] } as any);

    const { container } = render(<Harness path={PATH} />);
    const ta = getEditor(container);
    fireEvent.change(ta, { target: { value: '# 第二章\n\n编辑后的正文' } });

    const ok = await useAppStore.getState().saveFile(PATH);
    expect(ok).toBe(true);

    const writeArg = (window.orisonDesktop.writeFile as any).mock.calls[0][1];
    expect(writeArg.startsWith(frontmatter)).toBe(true);
    expect(writeArg).toContain('编辑后的正文');

    const tab = getTab(PATH);
    expect(tab.savedContent).toBe(writeArg); // full text, front-matter intact
    expect(tab.content).toBe(writeArg); // clean after save
    // Own save does not remount/reload the editor: it keeps the edited body.
    expect(ta.value).toBe('# 第二章\n\n编辑后的正文');
  });

  it('external reload re-captures the front-matter from the new disk content', async () => {
    useAppStore.setState({ openFiles: [makeTab('tab-4', PATH, '---\norder: 0\n---\n\n# 旧标题\n')] } as any);

    const { container } = render(<Harness path={PATH} />);
    const ta = getEditor(container);
    expect(ta.value).toContain('# 旧标题');

    // External change lands reloadFile-style: content + savedContent swapped to
    // the new disk text (front-matter changed too).
    const disk = '---\norder: 5\n---\n\n# 新标题\n\n新正文。';
    act(() => {
      useAppStore.setState((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === PATH ? { ...f, content: disk, savedContent: disk, externalState: undefined } : f,
        ),
      }) as any);
    });

    await waitFor(() => expect(getEditor(container).value).toContain('# 新标题'));
    const fresh = getEditor(container);
    expect(fresh.value).not.toContain('order: 5');

    // Subsequent edits re-attach the NEW front-matter block.
    fireEvent.change(fresh, { target: { value: '# 新标题\n\n改动' } });
    expect(getTab(PATH).content.startsWith('---\norder: 5\n---\n')).toBe(true);
  });

  it('reconcile against a front-matter chapter does not flag a false conflict', async () => {
    const frontmatter = '---\norder: 1\n---\n';
    const md = frontmatter + '\n# 标题\n\n正文。\n';
    useAppStore.setState({ openFiles: [makeTab('tab-5', PATH, md)] } as any);

    const { container } = render(<Harness path={PATH} />);
    expect(getEditor(container).value).toContain('正文。');

    // External writer changed the body on disk while the tab was clean: the
    // reconcile must adopt it banner-free — the tab models the FULL text, so
    // there is no front-matter/body baseline mismatch to misread as dirty.
    const disk2 = frontmatter + '\n# 标题\n\n外部改过的正文。\n';
    act(() => {
      useAppStore.getState().reconcileExternalFile(PATH, disk2, md);
    });

    const tab = getTab(PATH);
    expect(tab.externalState).toBeUndefined();
    expect(tab.content).toBe(disk2);
    expect(tab.savedContent).toBe(disk2);
    await waitFor(() => expect(getEditor(container).value).toContain('外部改过的正文。'));
    expect(getEditor(container).value).not.toContain('order:');
  });
});
