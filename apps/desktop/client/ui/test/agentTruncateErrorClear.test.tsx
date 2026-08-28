/**
 * dogfood T1 CR-T1-045：truncate 成功清 agentError。
 *
 * 截断移除的是错误 run 的对话尾部——不清 agentError 则错误条与重试钮（重发末条 user）
 * 的锚点漂移到更早消息，重试答非所问。截断成功回调（agentSessionSlice
 * truncateAgentMessages ok 分支）同步置 null。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  truncateAgentSession: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../src/shared/api/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/shared/api/agent')>();
  return { ...original, ...apiMocks };
});

import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

beforeEach(() => {
  apiMocks.truncateAgentSession.mockClear();
  apiMocks.truncateAgentSession.mockResolvedValue({ ok: true });
  useAppStore.setState({
    agentSessionId: 'sess-a',
    activeSessionRunning: false,
    agentError: 'agent.gearSwitchFailed: boom',
    agentMessages: [
      msg({ id: 'u1', role: 'user', content: '第一条' }),
      msg({ id: 'u2', role: 'user', content: '第二条' }),
      msg({ id: 'a1', role: 'assistant', content: '中断的回答' }),
    ],
  } as any);
});

describe('CR-T1-045 — truncate 成功清 agentError（重试锚不漂移）', () => {
  it('截断成功：消息截断 + agentError 置 null（错误条/重试钮随尾部一起退场）', async () => {
    await useAppStore.getState().truncateAgentMessages('u2');
    const state = useAppStore.getState();
    expect(state.agentMessages.map((m) => m.id)).toEqual(['u1']);
    expect(state.agentError).toBeNull();
    expect(apiMocks.truncateAgentSession).toHaveBeenCalledWith('sess-a', 'u2');
  });

  it('截断被拒（tool-activity 闸门）：agentError 保留（错误仍锚定原尾部）', async () => {
    useAppStore.setState({
      agentMessages: [
        msg({ id: 'u1', role: 'user', content: '第一条' }),
        msg({ id: 't1', role: 'tool', content: '', toolResults: [{ toolCallId: 'c1', toolName: 'search', output: 'ok' }] }),
      ],
    } as any);
    const result = await useAppStore.getState().truncateAgentMessages('u1');
    expect(result.ok).toBe(false);
    expect(useAppStore.getState().agentError).toBe('agent.gearSwitchFailed: boom');
  });
});
