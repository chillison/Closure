/**
 * CR-42（dogfood R2 BMad CR）：present_result 结果卡抑制的成功形收紧。
 *
 * 旧实现按名 continue 跑在 ok/error 判别前——错误形结果（metadata.ok === false，工具
 * handler 的错误/降级 envelope）也被吞，工具失败 UI 零痕迹。收紧为 mirror 相邻
 * DispatchDraftCard 拦截对 ok:false 的穿透先例（极性相反：present_result 成功的 metadata
 * 无 ok 键，非 false 即成功形）：仅 `ok !== false` 抑制，错误形穿透落 AgentToolCard
 * 结果卡（错误态类 + output 呈现）。
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

/** assistant(带 present_result 调用) + tool 结果消息的固定两件套（badge 由结果卡承载去重）。 */
function presentResultMessages(toolResult: {
  metadata?: unknown;
  output: string;
}): AgentMessage[] {
  return [
    msg({ id: 'u1', role: 'user', content: '呈现结果' }),
    msg({
      id: 'a1',
      role: 'assistant',
      content: '这是呈现给用户看的正文。',
      toolCalls: [{ id: 'c1', name: 'present_result', arguments: '{}' }],
    }),
    msg({
      id: 't1',
      role: 'tool',
      content: toolResult.output,
      toolResults: [{ toolCallId: 'c1', toolName: 'present_result', ...toolResult }],
    }),
  ];
}

beforeEach(() => {
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

describe('present_result 结果卡抑制（CR-42）', () => {
  it('成功形（metadata 无 ok 键）：抑制——正文即产物，无结果卡无步骤组（R2 #13 语义零回归）', async () => {
    const messages = presentResultMessages({
      output: '已呈现（等用户确认意图）。',
      metadata: { presentResult: { awaitingIntentConfirmation: true } },
    });
    const { container } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    await act(async () => {});
    expect(container.querySelector('.agent-tool-card')).toBeNull();
    expect(container.querySelector('.agent-work-steps')).toBeNull();
  });

  it('错误形（metadata.ok === false）：穿透落 AgentToolCard 结果卡（错误态可见，不再零痕迹）', async () => {
    const messages = presentResultMessages({
      output: 'Error: present_result 执行失败',
      metadata: { ok: false, reason: 'handler-failure' },
    });
    const { container } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    await act(async () => {});
    const card = container.querySelector('.agent-tool-card') as HTMLElement;
    expect(card).not.toBeNull();
    // AgentToolCard 的 Error 前缀判错 → 错误态类（卡默认折叠，header 状态位即错误呈现）。
    expect(card.className).toContain('agent-tool-card--error');
    expect(container.querySelector('.agent-tool-card-status--error')).not.toBeNull();
    // 展开卡 → output 呈现（失败详情可达）。
    fireEvent.click(container.querySelector('.agent-tool-card-header') as HTMLElement);
    await act(async () => {});
    expect(card.textContent).toContain('present_result 执行失败');
  });
});
