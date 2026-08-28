/**
 * thinking adapters task（S5，design §3.2 触发 ①）：Agent 面板头部「压缩上下文」按钮。
 *
 * - 点击 → shared/api/agent.compactAgentSession(sessionId)（preload → agent:compact-session，
 *   S3 已落地）；false 是布尔通道不可分辨原因（会话不在/无可压缩/D4 busy/未接线）→
 *   toast 并列列出原因（CR-017，不再断言单一「无可压缩」）；
 * - run 进行中 / 无活跃会话 → 禁用（与档位切换同款 mid-run 门——压缩会重排在途
 *   run 的消息面）；成功路径的 toast 由 compaction 流事件统一弹（agentEvents），此处不重复。
 *
 * mirror agentParticipationGear.test：mock IPC 边界（api 模块），slice/组件真实跑。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const compactAgentSession = vi.fn();
vi.mock('../src/shared/api/agent', async () => {
  const actual = await vi.importActual<typeof import('../src/shared/api/agent')>(
    '../src/shared/api/agent',
  );
  return {
    ...actual,
    compactAgentSession: (...args: unknown[]) => compactAgentSession(...args),
  };
});

import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';

function seedStore(overrides: Record<string, unknown> = {}) {
  // 两段式 seed：先落 currentProject（null→path 触发 projectSubscription 的真切换
  // 重置——runProjectResets 会清 agent 态），重置尘埃落定后再补会话态。一次性
  // setState 会被订阅内的重置同步清掉 agentSessionId（gear 测试同款现实）。
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
  } as any);
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    resolvedLocale: 'en-US',
    agentSessionId: 'session-1',
    activeSessionRunning: false,
    agentRunStates: {},
    agentError: null,
    agentMessages: [],
    agentSkills: [],
    agentSkillError: null,
    loadAgentSkills: vi.fn().mockResolvedValue(undefined),
    skillPackages: [],
    skillPackagesLoading: false,
    loadSkillPackages: vi.fn().mockResolvedValue(undefined),
    toggleSkillPackage: vi.fn(),
    toggleSkill: vi.fn(),
    agentParticipationGear: 'smart',
    ...overrides,
  } as any);
}

function compactButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Compact context' }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.restoreAllMocks();
  compactAgentSession.mockReset();
  localStorage.clear();
  (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
});

afterEach(() => cleanup());

describe('AgentPanel 手动压缩上下文按钮（thinking adapters task S5）', () => {
  it('空闲会话：按钮可用，点击调用 compactAgentSession(sessionId)', async () => {
    compactAgentSession.mockResolvedValue(true);
    seedStore();
    render(<AgentPanel />);

    const button = compactButton();
    expect(button.disabled).toBe(false);
    await userEvent.click(button);

    expect(compactAgentSession).toHaveBeenCalledWith('session-1');
    // 成功路径的提示由 compaction 流事件统一弹——此处不重复 toast。
    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages).not.toContain('Not executed: session not found / nothing to compact / a task is running in this project');
  });

  it('返回 false（布尔通道不可分辨原因）→ toast 并列列出原因（CR-017）', async () => {
    compactAgentSession.mockResolvedValue(false);
    seedStore();
    render(<AgentPanel />);

    await userEvent.click(compactButton());

    expect(compactAgentSession).toHaveBeenCalledWith('session-1');
    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages).toContain('Not executed: session not found / nothing to compact / a task is running in this project');
  });

  it('IPC reject → error toast，不裸抛', async () => {
    compactAgentSession.mockRejectedValue(new Error('boom'));
    seedStore();
    render(<AgentPanel />);

    await userEvent.click(compactButton());

    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages).toContain('Compaction request failed');
  });

  it('run 进行中 → 禁用（mid-run 门，与档位切换同款）', () => {
    compactAgentSession.mockResolvedValue(true);
    seedStore({ activeSessionRunning: true });
    render(<AgentPanel />);

    expect(compactButton().disabled).toBe(true);
    expect(compactAgentSession).not.toHaveBeenCalled();
  });

  it('无活跃会话 → 禁用', () => {
    seedStore({ agentSessionId: null });
    render(<AgentPanel />);

    expect(compactButton().disabled).toBe(true);
  });
});
