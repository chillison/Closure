/**
 * 风格卡片 MVP（08-28 C 路）：request_style_input 事件链 → 风格片段对话框。
 *
 * 覆盖：
 * - 事件 → 对话框弹出（projectPath 过 current-project 匹配守卫；不匹配不开）。
 * - 幂等：已开时重复请求不重置（首个 prompt 保留）。
 * - 取消 → 清 pending（对话框卸载）。**草稿保留**（CR-012）——重开对话框草稿还原。
 * - 提交 → 清 pending + 草稿 + sendAgentMessage 收到标记行结构化消息（形态断言 + 往返逐字节）。
 * - 300 字校验：不足禁提交 + 提示；run 在途禁提交（防 sendAgentMessage 静默早退丢消息）。
 * - 提交发送失败（sendAgentMessage 返 false，CR-012）→ 对话框保持 + 草稿保留（非静默丢）。
 * - 字数码点口径（CR-014）：emoji/扩展平面字符按码点计 1 非 UTF-16 的 2。
 *
 * 链路测的是 renderer 半段（tool:event → useToolEvents → styleInputSlice → dialog）；
 * shell 半段（handler → notifyUI）在 shell 包，agent 半段（builtin 注册）在 agent 包。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STYLE_INPUT_FRAGMENT_MARKER,
  STYLE_INPUT_NOTES_MARKER,
  parseStyleInputMessage,
} from '@orison/shared-contracts';
import { useToolEvents } from '../src/shared/hooks/useToolEvents';
import { StyleInputDialog, STYLE_INPUT_MIN_CHARS } from '../src/features/agent-panel/StyleInputDialog';
import { useAppStore } from '../src/shared/store/appStore';

const PROJECT_PATH = 'C:\\proj\\style-mvp';

let emit: ((event: Record<string, unknown>) => void) | undefined;
let sendSpy: ReturnType<typeof vi.fn>;

/** mirror App.tsx 挂载形态：useToolEvents（App 级 hook）+ 条件挂载对话框。 */
function Harness() {
  useToolEvents();
  const pending = useAppStore((s) => s.pendingStyleInput);
  return pending !== null ? <StyleInputDialog /> : null;
}

function fire(event: Record<string, unknown>): void {
  act(() => {
    emit!(event);
  });
}

function styleEvent(projectPath: string, prompt?: string): Record<string, unknown> {
  return { type: 'style_input_requested', projectPath, ...(prompt !== undefined ? { prompt } : {}) };
}

beforeEach(() => {
  emit = undefined;
  // sendAgentMessage 契约（CR-012 后）返 boolean——mock 缺省「已派发」。
  sendSpy = vi.fn().mockResolvedValue(true);
  useAppStore.setState({
    pendingStyleInput: null,
    styleInputDraft: { fragment: '', notes: '' },
    resolvedLocale: 'zh-CN',
    activeSessionRunning: false,
    currentProject: { path: PROJECT_PATH },
    sendAgentMessage: sendSpy,
  } as any);
  (window as any).orisonDesktop = {
    onToolEvent: (cb: (event: Record<string, unknown>) => void) => {
      emit = cb;
      return () => { emit = undefined; };
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as any).orisonDesktop;
});

function fillFragment(text: string): void {
  fireEvent.change(screen.getByLabelText('小说原文'), { target: { value: text } });
}

describe('request_style_input 事件链 → 风格片段对话框', () => {
  it('事件（当前项目）→ 对话框弹出 + leader 提示语显示', () => {
    render(<Harness />);
    expect(useAppStore.getState().pendingStyleInput).toBeNull();

    fire(styleEvent(PROJECT_PATH, '贴一段你最想模仿的原文'));

    expect(useAppStore.getState().pendingStyleInput).toEqual({ prompt: '贴一段你最想模仿的原文' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('贴一段你最想模仿的原文')).toBeTruthy();
    expect(screen.getByLabelText('小说原文')).toBeTruthy();
    expect(screen.getByLabelText('备注（可选）')).toBeTruthy();
  });

  it('无 prompt 的事件 → 默认说明显示', () => {
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH));
    expect(screen.getByText(/至少 300 字/)).toBeTruthy();
  });

  it('项目不匹配的事件 → 不弹（current-project 匹配守卫）', () => {
    render(<Harness />);
    fire(styleEvent('C:\\proj\\other-project'));
    expect(useAppStore.getState().pendingStyleInput).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('幂等：已开时重复请求不重置（首个 prompt 保留）', () => {
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH, '第一个提示'));
    fire(styleEvent(PROJECT_PATH, '第二个提示'));
    expect(useAppStore.getState().pendingStyleInput).toEqual({ prompt: '第一个提示' });
    expect(screen.getByText('第一个提示')).toBeTruthy();
    expect(screen.queryByText('第二个提示')).toBeNull();
  });

  it('取消（按钮 / overlay 点击）→ 清 pending（对话框卸载），草稿保留（CR-012）；内容区点击不误触', () => {
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH));
    // 打了半截的草稿（fragment + notes）——cancel 后必须还在。
    fillFragment('打到一半的片段——cancel 不该丢');
    fireEvent.change(screen.getByLabelText('备注（可选）'), { target: { value: '想学对话节奏' } });
    // 两个「取消」钮（头部关闭 X aria-label + 底部按钮）——取底部文字钮。
    fireEvent.click(screen.getAllByRole('button', { name: '取消' })[1]);
    expect(useAppStore.getState().pendingStyleInput).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // CR-012：草稿在 slice 存活（组件已卸载）。
    expect(useAppStore.getState().styleInputDraft).toEqual({
      fragment: '打到一半的片段——cancel 不该丢',
      notes: '想学对话节奏',
    });

    // overlay（role=dialog 元素自身）点击 → 取消（mirror ImageEditDialog 关闭语义）。
    fire(styleEvent(PROJECT_PATH));
    // CR-012：重开对话框 → 草稿还原（textarea 值来自 slice 非组件态）。
    expect((screen.getByLabelText('小说原文') as HTMLTextAreaElement).value).toBe('打到一半的片段——cancel 不该丢');
    expect((screen.getByLabelText('备注（可选）') as HTMLTextAreaElement).value).toBe('想学对话节奏');
    fireEvent.click(screen.getByRole('dialog'));
    expect(useAppStore.getState().pendingStyleInput).toBeNull();
    expect(useAppStore.getState().styleInputDraft.fragment).toBe('打到一半的片段——cancel 不该丢');

    // 内容区（overlay 的内层容器）点击不误触取消（stopPropagation）。
    fire(styleEvent(PROJECT_PATH));
    fireEvent.click(screen.getByRole('dialog').firstElementChild!);
    expect(useAppStore.getState().pendingStyleInput).not.toBeNull();
  });

  it('提交 → 清 pending + 清草稿 + sendAgentMessage 收到标记行结构化消息（往返逐字节）', async () => {
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH));
    // 多行 fragment（含空行/行尾空格）——逐字节往返是 D4 直传的红线（长度过 300 门）。
    // 约定：对话框构造前 trim 外围空白（粘贴误伤），内部结构（空行/行内空格）逐字节保留。
    const fragment = `${'夜色压下来，他数着窗外的灯。'.repeat(24)}\n\n他数着窗外的灯，一盏、两盏——第三盏灭了。\n行尾空格   `.trim();
    fillFragment(`${fragment}  `);
    fireEvent.change(screen.getByLabelText('备注（可选）'), { target: { value: '想学它的对话节奏' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    // 提交改为「发送确认成功才关」（CR-012）——清 pending/草稿在 await 之后，flush 微任务再断言。
    await act(async () => {});

    expect(useAppStore.getState().pendingStyleInput).toBeNull();
    // CR-012：发送确认成功 → 草稿同清（下次重开是干净对话框）。
    expect(useAppStore.getState().styleInputDraft).toEqual({ fragment: '', notes: '' });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const content = sendSpy.mock.calls[0][0] as string;
    // 形态断言：标记行结构 + 解析往返逐字节（外围 trim 过、内部原样）。
    expect(content.startsWith(`${STYLE_INPUT_FRAGMENT_MARKER}\n`)).toBe(true);
    expect(content).toContain(`\n${STYLE_INPUT_NOTES_MARKER}\n想学它的对话节奏`);
    const parsed = parseStyleInputMessage(content);
    expect(parsed).toEqual({ fragment, notes: '想学它的对话节奏' });
    expect(fragment).toContain('\n\n他数着窗外的灯，一盏、两盏');
  });

  it('无备注提交 → 消息省略 notes 段', () => {
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH));
    fillFragment('a'.repeat(STYLE_INPUT_MIN_CHARS));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    const content = sendSpy.mock.calls[0][0] as string;
    expect(content).not.toContain(STYLE_INPUT_NOTES_MARKER);
    expect(parseStyleInputMessage(content)?.fragment).toBe('a'.repeat(STYLE_INPUT_MIN_CHARS));
  });

  it('300 字校验：不足 → 禁提交 + 提示；达标 → 解禁', () => {
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH));

    fillFragment('短片段');
    const submit = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/片段太短/)).toBeTruthy();
    expect(screen.getByText(/3 \/ 300 字/)).toBeTruthy();

    fillFragment('b'.repeat(STYLE_INPUT_MIN_CHARS));
    expect((screen.getByRole('button', { name: '提交' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/片段太短/)).toBeNull();
  });

  it('run 在途 → 禁提交（防 sendAgentMessage 静默早退丢消息），跑完解禁', () => {
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH));
    fillFragment('c'.repeat(STYLE_INPUT_MIN_CHARS));

    act(() => {
      useAppStore.setState({ activeSessionRunning: true } as any);
    });
    let submit = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/对话正在回复中/)).toBeTruthy();

    act(() => {
      useAppStore.setState({ activeSessionRunning: false } as any);
    });
    submit = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('片段含保留标记行 → 提交响亮提示且不发送（对话框保持可改）', () => {
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH));
    fillFragment(`${'d'.repeat(STYLE_INPUT_MIN_CHARS)}\n${STYLE_INPUT_NOTES_MARKER}`);
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(sendSpy).not.toHaveBeenCalled();
    // 对话框保持开着（pending 未清）。
    expect(useAppStore.getState().pendingStyleInput).not.toBeNull();
  });

  it('CR-012：提交时 sendAgentMessage 返 false（run 竞态早退）→ 对话框保持 + 草稿保留（非静默丢）', async () => {
    // 竞态场景：点提交瞬间 run 翻活跃（canSubmit 判定已过）或同项目他 run 占用——
    // sendAgentMessage 早退返 false。旧实现「先关对话框再 fire-and-forget 发送」会把
    // 草稿连消息一起静默丢（对话框已卸载、消息没发出）。
    sendSpy = vi.fn().mockResolvedValue(false);
    useAppStore.setState({ sendAgentMessage: sendSpy } as any);
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH));
    const fragment = 'e'.repeat(STYLE_INPUT_MIN_CHARS);
    fillFragment(fragment);
    fireEvent.change(screen.getByLabelText('备注（可选）'), { target: { value: '备注也保留' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    // 发送确实被调用过（用户动作发生过），但早退未发——对话框保持打开。
    expect(sendSpy).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(useAppStore.getState().pendingStyleInput).not.toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 草稿原样保留（fragment + notes）——作者改完/等 run 空闲后可再提交。
    expect(useAppStore.getState().styleInputDraft).toEqual({ fragment, notes: '备注也保留' });
    expect((screen.getByLabelText('小说原文') as HTMLTextAreaElement).value).toBe(fragment);

    // run 空闲后再次提交（send 恢复 true）→ 正常关闭 + 清草稿。
    sendSpy.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await act(async () => {});
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().pendingStyleInput).toBeNull();
    expect(useAppStore.getState().styleInputDraft).toEqual({ fragment: '', notes: '' });
  });

  it('CR-014：字数按码点计——emoji 算 1 字非 UTF-16 的 2（与工具侧 computeStyleStats 口径对齐）', () => {
    render(<Harness />);
    fire(styleEvent(PROJECT_PATH));

    // 150 个 emoji：码点 150（不足 300 禁提交）；UTF-16 length=300（旧口径会误显示 300 并放行）。
    fillFragment('😀'.repeat(150));
    expect(screen.getByText(/150 \/ 300 字/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '提交' }) as HTMLButtonElement).disabled).toBe(true);

    // 码点恰达 300 的 emoji 片段 → 解禁（旧 UTF-16 口径会显示 600——同样过门但数字错位）。
    fillFragment('😀'.repeat(STYLE_INPUT_MIN_CHARS));
    expect(screen.getByText(/300 \/ 300 字/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '提交' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
