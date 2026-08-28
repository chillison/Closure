import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { resolveRevealRange } from '../src/features/editor/TiptapEditor';

/**
 * C1.2 CR-004：reveal（lint issue 定位跳转）→ ProseMirror 选区范围的纯函数测试。
 * jsdom 不支持 ProseMirror 渲染交互（仓内先例 mock TiptapEditor），但 Editor 构造出的
 * doc 是纯数据——直接喂给 resolveRevealRange 验证两级定位粒度。
 */
function buildDoc(html: string) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit],
    content: html,
  });
  const doc = editor.state.doc;
  editor.destroy();
  return doc;
}

const DOC = () => buildDoc('<h1>标题</h1><p>第一段命中文字</p><p>第二段填充词尾巴</p>');

describe('resolveRevealRange', () => {
  it('文本精确定位：reveal.text 命中 → 选区覆盖命中原串', () => {
    const doc = DOC();
    const range = resolveRevealRange(doc, { line: 3, column: 4, text: '填充词' })!;
    expect(range).not.toBeNull();
    expect(doc.textBetween(range.from, range.to)).toBe('填充词');
  });

  it('文本未命中 → 行号近似降级：第 N 个 textblock 落光标（散文 markdown 一段一行）', () => {
    const doc = DOC();
    const range = resolveRevealRange(doc, { line: 2, text: '不存在于正文' })!;
    const $pos = doc.resolve(range.from);
    expect($pos.parent.textContent).toBe('第一段命中文字');
  });

  it('列偏移：1-based 码点列 → 块内 parentOffset（column 4 = 前 3 字后）', () => {
    const doc = DOC();
    const range = resolveRevealRange(doc, { line: 2, column: 4 })!;
    expect(doc.resolve(range.from).parentOffset).toBe(3);
  });

  it('行号越界 → 夹取最后一块（文末）', () => {
    const doc = DOC();
    const range = resolveRevealRange(doc, { line: 99 })!;
    expect(doc.resolve(range.from).parent.textContent).toBe('第二段填充词尾巴');
  });

  it('空文档 → 落首块内容位（不返回 null 崩跳转）', () => {
    const doc = buildDoc('<p></p>');
    const range = resolveRevealRange(doc, { line: 5 });
    expect(range).not.toBeNull();
    expect(doc.resolve(range!.from).parent.textContent).toBe('');
  });
});
