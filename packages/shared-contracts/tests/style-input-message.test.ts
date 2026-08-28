/**
 * 风格卡片 MVP（08-28 C 路）：风格片段结构化 user message 标记行约定。
 *
 * 这是 **A 路对齐单源**的契约测试——对话框提交侧用 buildStyleInputMessage 构造，
 * dispatch 侧按 sourceMessageId 机械提取原文时直接 import parseStyleInputMessage
 * （勿自行复制格式）。此处钉死：往返逐字节一致 / 无备注省略 notes 段 / 非 style-input
 * 消息 null / 保留标记行响亮拒绝。
 */
import { describe, expect, it } from 'vitest';
import {
  STYLE_INPUT_FRAGMENT_MARKER,
  STYLE_INPUT_NOTES_MARKER,
  buildStyleInputMessage,
  parseStyleInputMessage,
} from '../src/ipc';

describe('style-input 结构化消息约定（buildStyleInputMessage / parseStyleInputMessage）', () => {
  it('构造→解析往返逐字节一致（多行 fragment + notes）', () => {
    const fragment = '第一段。\n\n第二段——带「引号」与\t制表符。\n行尾空格保留   ';
    const notes = '想学它的对话节奏';
    const message = buildStyleInputMessage(fragment, notes);
    // 形态断言：标记行结构。
    expect(message).toBe(`${STYLE_INPUT_FRAGMENT_MARKER}\n${fragment}\n${STYLE_INPUT_NOTES_MARKER}\n${notes}`);
    // 解析往返：fragment 逐字节（不 trim）。
    const parsed = parseStyleInputMessage(message);
    expect(parsed).toEqual({ fragment, notes });
  });

  it('空 notes（空串/undefined）→ 整段 notes 标记省略，解析 notes undefined', () => {
    for (const notes of [undefined, '']) {
      const message = buildStyleInputMessage('片段正文', notes);
      expect(message).not.toContain(STYLE_INPUT_NOTES_MARKER);
      const parsed = parseStyleInputMessage(message);
      expect(parsed).toEqual({ fragment: '片段正文' });
    }
  });

  it('非 style-input 消息 → null（含行中/行尾偶现标记文本）', () => {
    expect(parseStyleInputMessage('普通用户消息')).toBeNull();
    expect(parseStyleInputMessage('我说 [style-input-fragment] 是什么意思')).toBeNull();
    expect(parseStyleInputMessage('[style-input-fragment]-余文')).toBeNull();
    // 尾随空白同不算标记行（独占一行 = 行尾即 \n/EOS，CR-011）。
    expect(parseStyleInputMessage(`[style-input-fragment] \n正文`)).toBeNull();
  });

  it('CR-011：notes 标记行带余文 → 不算标记（整条按无 notes 段解析，伪标记行留在 fragment 原样）', () => {
    // 手打文本形态：`[style-input-notes] 余文`——行首命中但行尾非 \n/EOS，不是结构边界。
    const message = `${STYLE_INPUT_FRAGMENT_MARKER}\n片段正文。\n${STYLE_INPUT_NOTES_MARKER} 余文\n继续内容`;
    expect(parseStyleInputMessage(message)).toEqual({
      fragment: `片段正文。\n${STYLE_INPUT_NOTES_MARKER} 余文\n继续内容`,
    });
  });

  it('CR-011：notes 标记行带尾随空白 → 同不算标记（防尾空格绕过整行判定）', () => {
    const message = `${STYLE_INPUT_FRAGMENT_MARKER}\n片段。\n${STYLE_INPUT_NOTES_MARKER}  \n备注`;
    expect(parseStyleInputMessage(message)).toEqual({
      fragment: `片段。\n${STYLE_INPUT_NOTES_MARKER}  \n备注`,
    });
  });

  it('CR-011：notes 标记行恰在串尾（EOS）→ 合法标记（notes 空串）', () => {
    const message = `${STYLE_INPUT_FRAGMENT_MARKER}\n片段。\n${STYLE_INPUT_NOTES_MARKER}`;
    expect(parseStyleInputMessage(message)).toEqual({ fragment: '片段。', notes: '' });
  });

  it('fragment/notes 含保留标记行 → 构造抛错（响亮拒绝，不静默坏解析）', () => {
    expect(() => buildStyleInputMessage(`正常\n${STYLE_INPUT_NOTES_MARKER}\n续`, '备注')).toThrow();
    expect(() => buildStyleInputMessage('正常', `备注\n${STYLE_INPUT_FRAGMENT_MARKER}`)).toThrow();
    // trim 相等也算（防行尾空白绕过）。
    expect(() => buildStyleInputMessage(`正常\n  ${STYLE_INPUT_NOTES_MARKER}  `)).toThrow();
  });

  it('fragment 结尾换行的往返仍逐字节（notes 存在时 slice 精确）', () => {
    const fragment = '带尾换行\n';
    const message = buildStyleInputMessage(fragment, 'note');
    expect(parseStyleInputMessage(message)).toEqual({ fragment, notes: 'note' });
  });
});
