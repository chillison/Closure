/**
 * dogfood R2 #109（R3.4）：TextFileEditor 路由——带 frontmatter 的章文件不再降级源码模式。
 *
 * - 仅 frontmatter 的 .md（`---\norder: N\n---` + 正文）→ 富文本编辑器（MarkdownEditor/
 *   TiptapEditor），无 SourceModeBanner。
 * - frontmatter + 表格等 lossy 构造 → 仍降级源码模式 + banner（降级保护本身保留，
 *   只是 frontmatter 不再触发）。
 * - 无 frontmatter 的普通 lossy（表格）→ 降级照旧（既有语义回归锚）。
 *
 * TiptapEditor / CodeEditor 各 mock成带标记的 div（本测试只关心路由，不关心编辑器内部）。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../src/shared/store/appStore';
import { TextFileEditor } from '../src/features/editor/TextFileEditor';
import type { FileTab } from '../src/shared/store/fileTabsSlice';

vi.mock('../src/features/editor/TiptapEditor', () => ({
  TiptapEditor: () => <div aria-label="Mock Tiptap" />,
}));

vi.mock('../src/features/editor/file-editor/CodeEditor', () => ({
  CodeEditor: () => <div aria-label="Mock Code Editor" />,
}));

function makeTab(id: string, name: string, content: string): FileTab {
  return { id, path: `/demo/chapters/${name}`, name, content, savedContent: content };
}

beforeEach(() => {
  useAppStore.setState({
    openFiles: [],
    activeFilePath: null,
    resolvedLocale: 'en-US',
    currentProject: { name: 'Demo', path: '/demo', type: 'novel' },
  } as any);
});

afterEach(cleanup);

describe('TextFileEditor front-matter routing (#109)', () => {
  it('opens a front-matter chapter in the rich editor without the source-mode banner', () => {
    const tab = makeTab('tab-1', '第01章.md', '---\norder: 0\n---\n\n# 挖出来的是什么\n\n正文。');
    const { container } = render(<TextFileEditor file={tab} />);
    expect(container.querySelector('[aria-label="Mock Tiptap"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Mock Code Editor"]')).toBeNull();
    expect(container.querySelector('.file-conflict-banner--info')).toBeNull();
  });

  it('accepts a CRLF front-matter chapter in the rich editor', () => {
    const tab = makeTab('tab-2', '第02章.md', '---\r\norder: 1\r\n---\r\n\r\n# 第二章\r\n\r\n正文。\r\n');
    const { container } = render(<TextFileEditor file={tab} />);
    expect(container.querySelector('[aria-label="Mock Tiptap"]')).toBeTruthy();
    expect(container.querySelector('.file-conflict-banner--info')).toBeNull();
  });

  it('still falls back to source mode when lossy constructs sit behind the front-matter', () => {
    const tab = makeTab(
      'tab-3',
      '第03章.md',
      '---\norder: 2\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    );
    const { container } = render(<TextFileEditor file={tab} />);
    expect(container.querySelector('[aria-label="Mock Code Editor"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Mock Tiptap"]')).toBeNull();
    expect(container.querySelector('.file-conflict-banner--info')).toBeTruthy();
  });

  it('keeps the source-mode fallback for plain lossy markdown (existing semantics)', () => {
    const tab = makeTab('tab-4', '第04章.md', 'Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    const { container } = render(<TextFileEditor file={tab} />);
    expect(container.querySelector('[aria-label="Mock Code Editor"]')).toBeTruthy();
    expect(container.querySelector('.file-conflict-banner--info')).toBeTruthy();
  });
});
