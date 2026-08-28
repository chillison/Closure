/**
 * dogfood #44（2026-08-21）：聊天输入框手动高度跨重启持久。
 * 用户实录：顶边拖拽条调整后重启程序恢复默认。修法韧化双保险——
 * pointermove 同步写 ref + 拖拽中直接落 storage（React 连续事件异步批处理下，
 * pointerup 可能先于最后一次重渲染到达，读 ref 持久化到过期值）。
 *
 * 覆盖：
 * - 拖拽（pointerdown → move → up）后 orison_agentInputHeight 落盘。
 * - 预置 storage 后挂载 → textarea 高度恢复（auto-grow 下限 = 存储值）。
 *
 * jsdom 两坑（本文件已处理）：Pointer Capture API 未实现（mock 掉）；
 * fireEvent.pointer* 不带 clientY（NaN 高度会被 JSON.stringify 成 'null'）——
 * 统一用 MouseEvent 载体派发 pointer* 事件类型。
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@orison/shared-contracts';
import { AgentInput } from '../src/features/agent-panel/AgentInput';
import { useAppStore } from '../src/shared/store/appStore';

const modelConfig: ModelConfig = {
  keys: [
    {
      id: 'key_001',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test',
      models: [{ id: 'gpt-4o', alias: 'GPT-4o', capability: 'text', enabled: true }],
    },
  ],
};

function seedStore() {
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
  } as any);
  useAppStore.setState({
    resolvedLocale: 'en-US',
    modelConfig,
    agentSessionId: 'session-1',
    activeSessionRunning: false,
      agentRunStates: {},
    chapters: [],
    openFiles: [],
    pendingAttachments: [],
  } as any);
}

/** MouseEvent 载体派发 pointer* 事件（clientY 可用；React 委托按 type 收）。 */
function firePointer(el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientY: number) {
  fireEvent(el, new MouseEvent(type, { bubbles: true, clientY }));
}

/** jsdom 无布局：给 textarea 打高度探针（getBoundingClientRect/scrollHeight 均恒 0）。 */
function instrumentTextarea() {
  const el = document.querySelector('.agent-input-textarea') as HTMLTextAreaElement | null;
  if (!el) throw new Error('textarea not found');
  const boxHeight = 60;
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ height: boxHeight }) as DOMRect,
  });
  Object.defineProperty(el, 'scrollHeight', { get: () => boxHeight });
  return el;
}

function resizeHandle(container: HTMLElement): HTMLElement {
  const handle = container.querySelector('.agent-input-area .agent-input-resize') as HTMLElement | null;
  if (!handle) throw new Error('resize handle not found');
  return handle;
}

describe('AgentInput 手动高度持久（dogfood #44）', () => {
  beforeAll(() => {
    // jsdom 未实现 Pointer Capture API——拖拽条 pointerdown 里的 setPointerCapture 会抛。
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });

  beforeEach(() => {
    localStorage.clear();
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
    seedStore();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('拖拽后高度落盘 storage（move 直写 + pointerup 兜底双保险）', () => {
    const { container } = render(<AgentInput />);
    const el = instrumentTextarea();
    const handle = resizeHandle(container);

    // pointerdown（startY=500, startHeight=60）→ move 上移 240px（clientY=260）→ 高度 300。
    firePointer(handle, 'pointerdown', 500);
    firePointer(handle, 'pointermove', 260);
    firePointer(handle, 'pointerup', 260);

    expect(localStorage.getItem('orison_agentInputHeight')).toBe('300');
    expect(el.style.height).toBe('300px');
  });

  it('move 后紧接 up（不经重渲染）也持久化最新值——连续事件批处理竞态回归', () => {
    const { container } = render(<AgentInput />);
    instrumentTextarea();
    const handle = resizeHandle(container);

    // fireEvent 本身同步 dispatch——move 与 up 间无 flush 窗口即模拟批处理竞态：
    // 修复前 ref 同步在渲染期，up 读到的还是初值。
    firePointer(handle, 'pointerdown', 500);
    firePointer(handle, 'pointermove', 300);
    firePointer(handle, 'pointerup', 300);

    expect(localStorage.getItem('orison_agentInputHeight')).toBe('260');
  });

  it('重挂载（= 重启）从 storage 恢复高度，作为 auto-grow 下限', () => {
    localStorage.setItem('orison_agentInputHeight', '300');
    render(<AgentInput />);
    const el = instrumentTextarea();
    // auto-grow effect：空文本 grown=60 → max(60, 300) = 300。
    expect(el.style.height).toBe('300px');
  });
});
