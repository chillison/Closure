/**
 * dogfood R2 #11⑤（findings #11⑤，2026-08-25）：输入行直出钮（AgentInput）。
 * 直出钮从消息正文底部挪到输入行 stop 钮左侧——渲染条件 = 存在 streaming 且 content
 * 非空的消息（不可按即不渲染，无 disabled 残影）；点击发跨组件信号 requestStreamReveal
 * （streamRevealTick +1，AgentMessageItem effect 消费拉满渐进轨）。
 * CR-38（dogfood R2 BMad CR）：条件放宽为 content **或 reasoning** 非空——think-first
 * 纯思考期（content 空、reasoning 流中）恰是最想直出的窗口。
 */
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentInput } from '../src/features/agent-panel/AgentInput';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

function seedStore(agentMessages: AgentMessage[], overrides: Record<string, unknown> = {}) {
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
  } as any);
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    agentSessionId: 'session-1',
    activeSessionRunning: true,
    agentRunStates: {},
    agentError: null,
    chapters: [],
    openFiles: [],
    pendingAttachments: [],
    pendingToolConfirmBySession: {},
    pendingPassageResolveBySession: {},
    agentMessages,
    ...overrides,
  } as any);
}

function revealButton(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.agent-input-row button[title="直出"]');
}

beforeEach(() => {
  localStorage.clear();
  (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('输入行直出钮（R2 #11⑤）', () => {
  it('存在 streaming 且 content 非空的消息 → 直出钮渲染在 stop 钮左侧', () => {
    seedStore([
      msg({ id: 'u1', role: 'user', content: '写' }),
      msg({ id: 'a1', role: 'assistant', content: '流式正文进行中', streaming: true }),
    ]);
    const { container } = render(<AgentInput />);
    const reveal = revealButton(container);
    expect(reveal).not.toBeNull();
    // 位于输入行按钮组最前（stop 之前——DOM 序即视觉序）。
    const buttons = container.querySelectorAll('.agent-input-row .agent-input-btn');
    expect(buttons.length).toBe(2);
    expect(buttons[0]).toBe(reveal);
    expect(buttons[1]!.getAttribute('title')).toBe('停止');
  });

  it('streaming 消息 content 为空（首 delta 前）→ 不渲染（不可按即无残影）', () => {
    seedStore([
      msg({ id: 'a1', role: 'assistant', content: '', streaming: true }),
    ]);
    const { container } = render(<AgentInput />);
    expect(revealButton(container)).toBeNull();
  });

  // ── CR-38（dogfood R2 BMad CR）：纯思考期可用 ──

  it('CR-38：streaming 消息 content 空、reasoning 非空（纯思考期）→ 直出钮渲染', () => {
    seedStore([
      msg({ id: 'a1', role: 'assistant', content: '', reasoning: '深度思考进行中…'.repeat(10), streaming: true }),
    ]);
    const { container } = render(<AgentInput />);
    expect(revealButton(container)).not.toBeNull();
  });

  it('CR-38：content 与 reasoning 均空 → 仍不渲染（占位本身无轨可拉）', () => {
    seedStore([
      msg({ id: 'a1', role: 'assistant', content: '', reasoning: '', streaming: true }),
    ]);
    const { container } = render(<AgentInput />);
    expect(revealButton(container)).toBeNull();
  });

  it('无 streaming 消息（终帧后）→ 不渲染', () => {
    seedStore([
      msg({ id: 'a1', role: 'assistant', content: '已完成的正文', streaming: false }),
    ]);
    const { container } = render(<AgentInput />);
    expect(revealButton(container)).toBeNull();
  });

  it('点击 → streamRevealTick +1（跨组件直出信号）', async () => {
    seedStore([
      msg({ id: 'a1', role: 'assistant', content: '流式正文', streaming: true }),
    ]);
    const before = useAppStore.getState().streamRevealTick;
    const { container } = render(<AgentInput />);
    await userEvent.click(revealButton(container)!);
    expect(useAppStore.getState().streamRevealTick).toBe(before + 1);
  });
});
