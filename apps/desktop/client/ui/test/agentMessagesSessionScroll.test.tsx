/**
 * dogfood 2026-08-21：切历史会话后消息区直接落到底部（最新消息）。
 *
 * 复现：stick-to-bottom 闸门（离底 <120px 才跟随）把新载入的长历史当成
 * 「用户主动离开底部」，不滚动；docked 视图切换重挂容器还把 scrollTop 归零
 * ——用户选完历史会话停在对话开头，要手动滚很久才看到最新进展。
 * 修复：effect 挂 [agentSessionId]，会话切换无条件 scrollTop = scrollHeight。
 *
 * jsdom 无布局（scrollHeight/clientHeight 恒 0），用 defineProperty 在容器上
 * 装 spy setter / 定值 getter 断言赋值行为。
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

function historyMessages(n: number): AgentMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `消息 ${i}`,
    createdAt: 1700000000 + i,
  })) as AgentMessage[];
}

let setScrollTop: ReturnType<typeof vi.fn>;

function instrumentContainer(): HTMLElement {
  const el = document.querySelector('.agent-messages') as HTMLElement;
  // scrollHeight 定值（远超阈值），scrollTop 装 spy setter（jsdom 无布局读不回来）。
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 5000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => 0, set: setScrollTop });
  return el;
}

beforeEach(() => {
  setScrollTop = vi.fn();
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    activeSessionRunning: false,
      agentRunStates: {},
    agentSessionId: 'session-1',
    sendAgentMessage: vi.fn(),
    truncateAgentMessages: vi.fn(),
  } as any);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('切历史会话落底（dogfood 2026-08-21）', () => {
  it('agentSessionId 变化 → 无条件 scrollTop = scrollHeight（绕过 stick-to-bottom 闸门）', () => {
    render(<AgentMessages messages={historyMessages(6)} loading={false} error={null} />);
    instrumentContainer();
    // 切换会话（真实链路 switchAgentSession 换 sessionId；消息列表由父层随 props 换新）。
    act(() => {
      useAppStore.setState({ agentSessionId: 'session-2' } as any);
    });
    expect(setScrollTop).toHaveBeenCalledWith(5000);
  });

  it('同会话追加消息不强制落底（既有 stick-to-bottom 行为不变）', () => {
    const { rerender } = render(
      <AgentMessages messages={historyMessages(6)} loading={false} error={null} />,
    );
    instrumentContainer();
    // 追加一条（messages.length 变化走旧闸门：离底 4600 > 120 → 不滚）。
    rerender(<AgentMessages messages={historyMessages(7)} loading={false} error={null} />);
    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it('R2 #50：跳底下一帧复位一次（autoResume 末条全量渲染后布局晚 settle 兜底）', async () => {
    render(<AgentMessages messages={historyMessages(6)} loading={false} error={null} />);
    instrumentContainer();
    act(() => {
      useAppStore.setState({ agentSessionId: 'session-2' } as any);
    });
    // 首帧同步赋值一次。
    expect(setScrollTop).toHaveBeenCalledTimes(1);
    // 下一帧 rAF 复位一次（jsdom rAF 定时器驱动），值同 scrollHeight。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(setScrollTop).toHaveBeenCalledTimes(2);
    expect(setScrollTop).toHaveBeenLastCalledWith(5000);
  });
});
