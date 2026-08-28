import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { htmlToMarkdown, markdownToHtml } from '../../shared/utils/markdown';
import { useAppStore } from '../../shared/store/appStore';
import { registerEditorContentFlush } from '../../shared/store/editorContentFlush';
import { useI18n } from '../../shared/i18n/useI18n';
import { ContextMenu, type ContextMenuItem } from '../../shared/components/ContextMenu';
import { FindReplaceBar, type FindReplaceAdapter, type FindMatch, type FindReplaceMode } from './FindReplaceBar';
import { BubbleToolbar } from './file-editor/BubbleToolbar';
import type { FileRevealRequest } from '../../shared/store/fileTabsSlice';

export type TiptapEditorFormat = 'html' | 'markdown';

export type SelectionInfo = { text: string; from: number; to: number };

/**
 * doc/node 的结构子集（本文件位置换算所需）。不 import ProseMirror 类型包——`@tiptap/pm`
 * 非 ui 包直接依赖（pnpm 严格 node_modules 下不可达），结构化 typing 同样类型安全且零依赖。
 */
export type RevealDocLike = {
  descendants: (fn: (node: RevealNodeLike, pos: number) => boolean | void) => void;
};
export type RevealNodeLike = {
  isTextblock: boolean;
  isText: boolean;
  text?: string | null;
  textContent: string;
};

type TiptapEditorProps = {
  content?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  editable?: boolean;
  format?: TiptapEditorFormat;
  flush?: boolean;
  extraContextItems?: ContextMenuItem[];
  bubbleMenu?: boolean;
  disableFind?: boolean;
  onSelectionAction?: (action: 'review' | 'attach' | 'continue' | 'polish', selection: SelectionInfo) => void;
  /**
   * Story 7.1 B1：selection-update listener（readonly 模式也可用）。
   *
   * 与 {@link onSelectionAction} 互补：后者只在 editable 模式经右键菜单触发，readonly 模式不可用。
   * 本回调在编辑器的 `onSelectionUpdate` 钩子上挂，**每次选区变化都触发**——readonly 编辑器也能监听
   * （ChapterReviewPanel draft stage 用 TipTap 作只读正文渲染 + 选段捕获 → revision-optimizer 派发）。
   *
   * 选区空 → 回调 `null`；非空 → `{text, from, to}`（from/to 为 ProseMirror doc positions，作 anchoring
   * hint；text 为 `textBetween` 取出的纯文本，作 SelectionAnchor.quote）。
   */
  onSelectionChange?: (selection: SelectionInfo | null) => void;
  /**
   * C1.2 CR-004：一次性「跳转定位」请求（lint issue 点击）。编辑器挂载/请求到达后：
   * 选区落到目标位置并 scrollIntoView，随后调 `onRevealHandled`（消费方清 store 里的
   * pending reveal——一次性语义）。定位粒度见 {@link resolveRevealRange}。
   */
  reveal?: FileRevealRequest;
  onRevealHandled?: () => void;
};

/**
 * 展平 doc 文本 + 每字符的 ProseMirror position 映射（textblock 之间补 '\n'）。
 * find 的高亮定位与 reveal 跳转共用（同一映射语义单源）。
 */
function buildTextPositionMap(doc: RevealDocLike): { text: string; positions: number[] } {
  const chars: string[] = [];
  const positions: number[] = [];
  let needSep = false;
  doc.descendants((node, pos) => {
    if (node.isTextblock && needSep) {
      chars.push('\n');
      positions.push(pos);
      needSep = false;
    }
    if (node.isText) {
      for (let i = 0; i < node.text!.length; i++) {
        chars.push(node.text![i]);
        positions.push(pos + i);
      }
      needSep = true;
    }
  });
  return { text: chars.join(''), positions };
}

/**
 * CR-004：reveal 请求 → ProseMirror 选区范围。两级粒度（导出供测试）：
 * 1. **文本精确定位**（reveal.text 非空且在展平 doc 文本中命中）：选区覆盖命中原串——
 *    markdown 渲染块结构与源文本行非一一对应（段落间空行不产块），按命中文字定位比
 *    行号换算可靠；
 * 2. **行号近似降级**（无 text / 未命中）：第 N 个 textblock ≈ 源文本第 N 行——散文
 *    markdown 一段一行时即精确行；有段落间空行时偏移近似（滚动到大致段落 + 光标按列
 *    落位）。行号越界夹取到最后一块（文末）。
 * 返回 null = 空文档无处可落。
 */
export function resolveRevealRange(
  doc: RevealDocLike,
  reveal: FileRevealRequest,
): { from: number; to: number } | null {
  if (reveal.text && reveal.text.length > 0) {
    const { text, positions } = buildTextPositionMap(doc);
    const idx = text.indexOf(reveal.text);
    if (idx >= 0 && positions.length > 0) {
      const from = positions[idx]!;
      const lastIdx = Math.min(idx + reveal.text.length - 1, positions.length - 1);
      return { from, to: positions[lastIdx]! + 1 };
    }
  }
  let index = 0;
  let result: { from: number; to: number } | null = null;
  let lastBlockStart: number | null = null;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    lastBlockStart = pos + 1;
    if (result === null && index === reveal.line - 1) {
      // column 为 1-based 码点列；textContent 是 UTF-16——BMP 内 1:1（中文主场景），越界夹取。
      const text = node.textContent;
      const col = reveal.column && reveal.column > 1 ? Math.min(reveal.column - 1, text.length) : 0;
      result = { from: pos + 1 + col, to: pos + 1 + col };
    }
    index++;
    return true;
  });
  if (result !== null) return result;
  if (lastBlockStart !== null) return { from: lastBlockStart, to: lastBlockStart };
  return null;
}

const menuItems = [
  { command: 'toggleBold', activeName: 'bold', icon: 'format_bold', i18nKey: 'editor.bold' },
  { command: 'toggleItalic', activeName: 'italic', icon: 'format_italic', i18nKey: 'editor.italic' },
  { command: 'toggleStrike', activeName: 'strike', icon: 'strikethrough_s', i18nKey: 'editor.strikethrough' },
  { command: 'toggleCodeBlock', activeName: 'codeBlock', icon: 'code', i18nKey: 'editor.codeBlock' },
  { command: 'toggleBlockquote', activeName: 'blockquote', icon: 'format_quote', i18nKey: 'editor.quote' },
  { command: 'toggleBulletList', activeName: 'bulletList', icon: 'format_list_bulleted', i18nKey: 'editor.bulletList' },
  { command: 'toggleOrderedList', activeName: 'orderedList', icon: 'format_list_numbered', i18nKey: 'editor.orderedList' },
] as const;

type HeadingLevel = 1 | 2 | 3;

export function TiptapEditor({
  content = '',
  placeholder = '',
  onChange,
  editable = true,
  format = 'html',
  flush = false,
  extraContextItems,
  bubbleMenu = false,
  disableFind = false,
  onSelectionAction,
  onSelectionChange,
  reveal,
  onRevealHandled,
}: TiptapEditorProps) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const spellCheck = useAppStore((s) => s.spellCheck);
  const initialHtml = format === 'markdown' ? markdownToHtml(content) : content;
  const [findMode, setFindMode] = useState<FindReplaceMode | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Serializing the whole doc (getHTML + Turndown) on every keystroke is the
  // dominant "typing feels laggy" cost, and it drives a store update that
  // re-renders every openFiles subscriber. Debounce the serialization so it
  // runs at most every ~200ms during active typing; flush on blur/unmount so
  // autosave and tab switches never see stale content.
  const onChangeRef = useRef(onChange);
  const formatRef = useRef(format);
  onChangeRef.current = onChange;
  formatRef.current = format;
  // Story 7.1: ref for onSelectionChange so useEditor's onSelectionUpdate hook
  // reads the latest callback without forcing a full editor re-init on every
  // parent re-render (mirrors the onChange ref pattern above).
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  // CR-004: same ref pattern for the one-shot reveal consumption callback.
  const onRevealHandledRef = useRef(onRevealHandled);
  onRevealHandledRef.current = onRevealHandled;
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSerialize = useRef<null | (() => void)>(null);

  const flushChange = useCallback(() => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    const run = pendingSerialize.current;
    pendingSerialize.current = null;
    run?.();
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder || t('editor.startWriting') }),
    ],
    content: initialHtml,
    editable,
    editorProps: { attributes: { spellcheck: String(spellCheck) } },
    onUpdate: ({ editor: e }) => {
      if (!onChangeRef.current) return;
      // Capture the editor; serialize lazily inside the debounced flush so the
      // expensive getHTML+Turndown runs once per pause, not once per keystroke.
      pendingSerialize.current = () => {
        const html = e.getHTML();
        onChangeRef.current?.(formatRef.current === 'markdown' ? htmlToMarkdown(html) : html);
      };
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(flushChange, 200);
    },
    onSelectionUpdate: ({ editor: e }) => {
      // Story 7.1 B1: readonly selection listener. Mirror onSelectionAction's
      // extraction (textBetween with '\n\n' block separator) so multi-block
      // selections match markdown source. Fires null when selection is empty
      // so consumers can hide selection-dependent UI (e.g. 「指挥这段」 button).
      const cb = onSelectionChangeRef.current;
      if (!cb) return;
      const { from, to, empty } = e.state.selection;
      if (empty) {
        cb(null);
        return;
      }
      const text = e.state.doc.textBetween(from, to, '\n\n');
      cb(text ? { text, from, to } : null);
    },
    onBlur: () => flushChange(),
  });

  // Flush any pending edit when the editor unmounts (tab switch / remount) so
  // the last keystrokes within the debounce window are never dropped.
  useEffect(() => () => flushChange(), [flushChange]);

  // Save / project-switch / dirty checks call flushPendingEditorContent first.
  useEffect(() => registerEditorContentFlush(flushChange), [flushChange]);

  // Reactively reflect the spellcheck setting onto the editable element.
  useEffect(() => {
    editor?.setOptions({ editorProps: { attributes: { spellcheck: String(spellCheck) } } });
  }, [editor, spellCheck]);

  const handleFindClose = useCallback(() => setFindMode(null), []);

  useEffect(() => {
    if (!editable || disableFind) return;
    // Scope the find shortcut to THIS editor's wrapper. A window-level listener
    // made every mounted TiptapEditor (split view, outline) compete: the first
    // to register won via `defaultPrevented`, so Ctrl+F opened find in the wrong
    // pane regardless of focus. Listening on the wrapper means the shortcut only
    // fires for the editor the user is actually typing in.
    const el = wrapperRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'f') { e.preventDefault(); setFindMode('find'); }
      if (e.key === 'h') { e.preventDefault(); setFindMode('replace'); }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [editable, disableFind]);

  // Open the find bar when the menu bar / command palette issues a find request.
  // The nonce changes on every request so repeated menu clicks re-trigger it.
  const findRequest = useAppStore((s) => s.findRequest);
  useEffect(() => {
    if (!editable || disableFind || !findRequest) return;
    setFindMode(findRequest.mode);
  }, [findRequest, editable, disableFind]);

  useEffect(() => {
    if (!editor || editable !== editor.isEditable) editor.setEditable(editable);
  }, [editor, editable]);

  // C1.2 CR-004：一次性跳转定位——编辑器就绪 + reveal 请求到达后，选区落到目标位置并滚动。
  // reveal 是每次 openFile 新建的对象（identity 变化即触发）；完成后回调消费方清 store
  // pending（reveal 变 undefined 时本 effect 再跑一次但直接 return，不重复跳）。
  useEffect(() => {
    if (!editor || !reveal) return;
    const range = resolveRevealRange(editor.state.doc, reveal);
    if (range) {
      editor.chain().focus().setTextSelection(range).scrollIntoView().run();
    }
    onRevealHandledRef.current?.();
  }, [editor, reveal]);

  // Story 7.1 BMad CR F4（critical 回归修复）：sync editor content when `content` prop changes after mount.
  // useEditor captures `initialHtml = markdownToHtml(content)` on first mount only — without this effect, a
  // readonly ChapterReviewPanel editor would show STALE draft after a splice-driven redo re-pause (pausedReview.
  // draftContent updates but editor keeps old content). The replaced `<pre>{draftContent}</pre>` always rendered
  // current content; TipTap doesn't. editable check excludes the writable editor (author typing — don't clobber).
  // Mirror line 69 format-aware html derivation (format==='markdown' → markdownToHtml，else content 原样)。
  useEffect(() => {
    if (!editor || editable) return;
    const html = format === 'markdown' ? markdownToHtml(content) : content;
    // emitUpdate=false (TipTap 3 SetContentOptions): don't fire onUpdate (avoid feedback loop / dirty-flag flip
    // on programmatic setContent). TipTap 2 的 (content, false) 签名在 TipTap 3 改为 (content, {emitUpdate})。
    editor.commands.setContent(html, { emitUpdate: false });
  }, [editor, editable, content, format]);

  const findAdapter: FindReplaceAdapter = useMemo(() => {
    if (!editor) return { getText: () => '', highlight: () => {}, replaceOne: () => {}, replaceAll: () => {} };

    return {
      getText: () => buildTextPositionMap(editor!.state.doc).text,
      highlight: (match: FindMatch) => {
        const { positions } = buildTextPositionMap(editor!.state.doc);
        if (positions.length === 0) return;
        const from = positions[match.start] ?? 0;
        const to = match.end > 0 ? (positions[match.end - 1] ?? 0) + 1 : from;
        editor!.chain().setTextSelection({ from, to }).scrollIntoView().run();
      },
      replaceOne: (match: FindMatch, replacement: string) => {
        const { positions } = buildTextPositionMap(editor!.state.doc);
        if (positions.length === 0) return;
        const from = positions[match.start] ?? 0;
        const to = match.end > 0 ? (positions[match.end - 1] ?? 0) + 1 : from;
        editor!.chain().setTextSelection({ from, to }).deleteSelection().insertContent(replacement).run();
      },
      replaceAll: (matches: FindMatch[], replacement: string) => {
        for (let i = matches.length - 1; i >= 0; i--) {
          const { positions } = buildTextPositionMap(editor!.state.doc);
          if (positions.length === 0) return;
          const m = matches[i];
          const from = positions[m.start] ?? 0;
          const to = m.end > 0 ? (positions[m.end - 1] ?? 0) + 1 : from;
          editor!.chain().setTextSelection({ from, to }).deleteSelection().insertContent(replacement).run();
        }
      },
    };
  }, [editor]);

  if (!editor) return null;

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!editable) return;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const hasSelection = !editor.state.selection.empty;

  const ctxItems: ContextMenuItem[] = [
    { type: 'item', label: t('editor.cut'), icon: 'content_cut', disabled: !hasSelection, onClick: () => { document.execCommand('cut'); } },
    { type: 'item', label: t('editor.copy'), icon: 'content_copy', disabled: !hasSelection, onClick: () => { document.execCommand('copy'); } },
    { type: 'item', label: t('editor.paste'), icon: 'content_paste', onClick: () => { document.execCommand('paste'); } },
    { type: 'item', label: t('editor.selectAll'), icon: 'select_all', onClick: () => { editor.chain().focus().selectAll().run(); } },
    { type: 'separator' },
    { type: 'item', label: t('editor.bold'), icon: 'format_bold', onClick: () => { editor.chain().focus().toggleBold().run(); } },
    { type: 'item', label: t('editor.italic'), icon: 'format_italic', onClick: () => { editor.chain().focus().toggleItalic().run(); } },
    { type: 'item', label: t('editor.strikethrough'), icon: 'strikethrough_s', onClick: () => { editor.chain().focus().toggleStrike().run(); } },
    { type: 'separator' },
    { type: 'item', label: t('editor.heading', { level: '1' }), onClick: () => { editor.chain().focus().toggleHeading({ level: 1 }).run(); } },
    { type: 'item', label: t('editor.heading', { level: '2' }), onClick: () => { editor.chain().focus().toggleHeading({ level: 2 }).run(); } },
    { type: 'item', label: t('editor.heading', { level: '3' }), onClick: () => { editor.chain().focus().toggleHeading({ level: 3 }).run(); } },
    { type: 'separator' },
    { type: 'item', label: t('editor.bulletList'), icon: 'format_list_bulleted', onClick: () => { editor.chain().focus().toggleBulletList().run(); } },
    { type: 'item', label: t('editor.orderedList'), icon: 'format_list_numbered', onClick: () => { editor.chain().focus().toggleOrderedList().run(); } },
    { type: 'item', label: t('editor.quote'), icon: 'format_quote', onClick: () => { editor.chain().focus().toggleBlockquote().run(); } },
    { type: 'separator' },
    { type: 'item', label: t('editor.findReplace'), icon: 'find_replace', onClick: () => { setFindMode('find'); } },
    ...(onSelectionAction ? [
      { type: 'separator' } as const,
      { type: 'item' as const, label: t('editor.aiReview'), icon: 'rate_review', disabled: !hasSelection, onClick: () => {
        const { from, to } = editor.state.selection;
        // Use blockSeparator '\n\n' so multi-block selections match markdown source
        // (paragraphs are separated by blank lines), not TipTap's default single \n.
        const text = editor.state.doc.textBetween(from, to, '\n\n');
        if (text) onSelectionAction('review', { text, from, to });
      }},
      { type: 'item' as const, label: t('editor.aiContinue'), icon: 'auto_fix_high', disabled: !hasSelection, onClick: () => {
        const { from, to } = editor.state.selection;
        const text = editor.state.doc.textBetween(from, to, '\n\n');
        if (text) onSelectionAction('continue', { text, from, to });
      }},
      { type: 'item' as const, label: t('editor.aiPolish'), icon: 'auto_awesome', disabled: !hasSelection, onClick: () => {
        const { from, to } = editor.state.selection;
        const text = editor.state.doc.textBetween(from, to, '\n\n');
        if (text) onSelectionAction('polish', { text, from, to });
      }},
      { type: 'item' as const, label: t('editor.addToAgent'), icon: 'attach_file', disabled: !hasSelection, onClick: () => {
        const { from, to } = editor.state.selection;
        const text = editor.state.doc.textBetween(from, to, '\n\n');
        if (text) onSelectionAction('attach', { text, from, to });
      }},
    ] : []),
    ...(extraContextItems ?? []),
  ];

  return (
    <div ref={wrapperRef} className={`tiptap-wrapper${flush ? ' tiptap-wrapper--flush' : ''}`} onContextMenu={handleContextMenu}>
      {!disableFind && findMode && <FindReplaceBar initialMode={findMode} adapter={findAdapter} onClose={handleFindClose} />}
      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />}
      {bubbleMenu && editable && <BubbleToolbar editor={editor} />}
      {editable && (
        <div className="tiptap-toolbar" role="toolbar" aria-label="Formatting">
          {([1, 2, 3] as HeadingLevel[]).map((level) => (
            <button
              key={`h${level}`}
              type="button"
              className={`tiptap-toolbar-btn${editor.isActive('heading', { level }) ? ' is-active' : ''}`}
              onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
              title={t('editor.heading', { level: String(level) })}
            >
              H{level}
            </button>
          ))}
          <span className="tiptap-toolbar-divider" />
          {menuItems.map((item) => (
            <button
              key={item.command}
              type="button"
              className={`tiptap-toolbar-btn${editor.isActive(item.activeName) ? ' is-active' : ''}`}
              onClick={() => (editor.chain().focus() as any)[item.command]().run()}
              title={t(item.i18nKey)}
            >
              <span className="material-symbols-outlined" aria-hidden="true">{item.icon}</span>
            </button>
          ))}
        </div>
      )}
      <EditorContent editor={editor} className="tiptap-content" />
    </div>
  );
}
