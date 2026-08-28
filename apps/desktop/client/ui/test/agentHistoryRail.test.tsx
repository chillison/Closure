import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { useAppStore } from '../src/shared/store/appStore';

// ─────────────────────────────────────────────────────────────────────────────
// 全屏历史细栏（dogfood 2026-08-21）：历史钮双模行为 + 双渲染回归。
// 复现路径（用户实录）：docked 点历史（整面视图）→ 展开 → 再点历史 → 旧 view 残留
// 'history' 与细栏同时渲染 = 两个历史面板。修复：expanded 分支先清 view 回 chat
// + 进入全屏时 effect 兜底回落；细栏挂右侧（历史钮在头部右侧，就近原则）。
// ─────────────────────────────────────────────────────────────────────────────

function panelHistoryButton(): HTMLElement {
  return screen.getByRole('button', { name: 'History' });
}

describe('AgentPanel fullscreen history rail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
      resolvedLocale: 'en-US',
      agentMessages: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      agentSessionId: 'session-1',
      agentExpanded: false,
      toggleAgentExpanded: vi.fn(),
      loadAgentSkills: vi.fn().mockResolvedValue(undefined),
      loadAgentSessions: vi.fn().mockResolvedValue(undefined),
      agentSessions: [],
    } as any);
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ agentExpanded: false } as any);
  });

  it('docked：历史钮切整面视图（无细栏）', async () => {
    render(<AgentPanel />);
    await userEvent.click(panelHistoryButton());
    // 整面历史（无细栏容器）；AgentHistory 头部自带关闭钮（icon 连字 close）。
    expect(document.querySelectorAll('.agent-history').length).toBe(1);
    expect(document.querySelector('.agent-history-rail')).toBeNull();
    const historyHeader = document.querySelector('.agent-history-header') as HTMLElement;
    expect(within(historyHeader).getByRole('button')).toBeInTheDocument();
  });

  it('expanded：历史钮开右侧细栏，聊天保留', async () => {
    useAppStore.setState({ agentExpanded: true } as any);
    render(<AgentPanel />);
    await userEvent.click(panelHistoryButton());
    const rail = document.querySelector('.agent-history-rail');
    expect(rail).not.toBeNull();
    // 聊天输入仍在（细栏不顶掉聊天）。
    expect(screen.getByPlaceholderText(/Ask the agent/)).toBeInTheDocument();
  });

  it('回归：docked 点历史→展开→再点历史 = 只有一个历史面板（view 残留清理）', async () => {
    render(<AgentPanel />);
    // ① docked 点历史 → 整面视图。
    await userEvent.click(panelHistoryButton());
    expect(document.querySelectorAll('.agent-history').length).toBe(1);
    // ② 展开（store 直改，绕过 toggle mock）。
    actSetExpanded(true);
    // effect 兜底：整面历史回落聊天。
    await waitForChatRestored();
    // ③ 再点历史 → 细栏开启，仍只有一个 .agent-history。
    await userEvent.click(panelHistoryButton());
    expect(document.querySelector('.agent-history-rail')).not.toBeNull();
    expect(document.querySelectorAll('.agent-history').length).toBe(1);
  });

  it('细栏在主列右侧（DOM 顺序：main 在前，rail 在后）', async () => {
    useAppStore.setState({ agentExpanded: true } as any);
    render(<AgentPanel />);
    await userEvent.click(panelHistoryButton());
    const body = document.querySelector('.agent-panel-body') as HTMLElement;
    const children = Array.from(body.children).map((c) => c.className);
    expect(children[0]).toContain('agent-panel-main');
    expect(children[children.length - 1]).toContain('agent-history-rail');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 3 D3（#47② 弹窗退役）：切会话/新建会话**不再中断**在途 run——二次确认
// 弹窗退役，徽标 + 停止钮接岗。此处负断言新行为：运行中切换**无确认弹窗**、立即切换、
// run 不被 abort（switchAgentSession 不再调 abortAgentRun）。
// ─────────────────────────────────────────────────────────────────────────────
describe('session-leave 弹窗退役（dogfood T1 Stage 3 D3）', () => {
  const SAMPLE_SESSIONS = [
    { id: 'session-2', title: 'Second', updatedAt: Date.now(), messageCount: 3 },
    { id: 'session-3', title: 'Third', updatedAt: Date.now(), messageCount: 1 },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).window = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
      resolvedLocale: 'en-US',
      agentMessages: [],
      activeSessionRunning: true, // 在途 run（旧守卫的触发条件——新行为下不该再拦）
      agentRunStates: {},
      agentError: null,
      agentSessionId: 'session-1',
      agentExpanded: false,
      toggleAgentExpanded: vi.fn(),
      loadAgentSkills: vi.fn().mockResolvedValue(undefined),
      loadAgentSessions: vi.fn().mockResolvedValue(undefined),
      newAgentSession: vi.fn().mockResolvedValue(undefined),
      switchAgentSession: vi.fn().mockResolvedValue(undefined),
      agentSessions: SAMPLE_SESSIONS,
    } as any);
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ activeSessionRunning: false } as any);
  });

  it('运行中点历史会话：无确认弹窗，立即切换，run 不被 abort（D3）', async () => {
    const switchAgentSession = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ switchAgentSession } as any);
    render(<AgentPanel />);
    await userEvent.click(panelHistoryButton());

    await userEvent.click(screen.getByRole('button', { name: /Second/ }));
    // 弹窗退役负断言：无 alertdialog；切换已发生；abortAgentRun 未被调（run 留在后台）。
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(switchAgentSession).toHaveBeenCalledWith('session-2');
    expect((window as any).orisonDesktop.abortAgentRun).not.toHaveBeenCalled();
  });

  it('运行中点新建会话：无确认弹窗，直接新建（不 abort 在途 run）', async () => {
    const newAgentSession = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ newAgentSession } as any);
    render(<AgentPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(newAgentSession).toHaveBeenCalledTimes(1);
    expect((window as any).orisonDesktop.abortAgentRun).not.toHaveBeenCalled();
  });

  it('非运行中切换：同样直接切（行为与运行中一致——守卫整体退役）', async () => {
    const switchAgentSession = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ switchAgentSession, activeSessionRunning: false } as any);
    render(<AgentPanel />);
    await userEvent.click(panelHistoryButton());

    await userEvent.click(screen.getByRole('button', { name: /Second/ }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(switchAgentSession).toHaveBeenCalledWith('session-2');
  });

  it('运行中的后台会话行显 running 徽标 + 行内停止钮（徽标接岗 #47②）', async () => {
    useAppStore.setState({
      switchAgentSession: vi.fn().mockResolvedValue(undefined),
      agentRunStates: { 'session-2': { sessionId: 'session-2', phase: 'running', projectPath: 'I:/echo/project', updatedAt: 1 } },
    } as any);
    render(<AgentPanel />);
    await userEvent.click(panelHistoryButton());

    const badge = document.querySelector('.agent-history-badge--running');
    expect(badge).not.toBeNull();
    const stopBtn = document.querySelector('.agent-history-item-stop') as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();
    await userEvent.click(stopBtn);
    expect((window as any).orisonDesktop.abortAgentRun).toHaveBeenCalledWith('session-2');
  });
});

function actSetExpanded(v: boolean) {
  useAppStore.setState({ agentExpanded: v } as any);
}

async function waitForChatRestored() {
  await vi.waitFor(() => {
    expect(document.querySelector('.agent-panel-main')).not.toBeNull();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #14（2026-08-25）：「新会话」草稿行 + 列表实时刷新。
// 懒建语义保留（首条消息才真建会话）——点「新会话」后列表顶部渲染草稿占位行；
// run 结束（running 集合收缩）刷新列表一次（updated_at 重排/计数实时可见）。
// ─────────────────────────────────────────────────────────────────────────────
describe('R2 #14：新会话草稿行 + 列表实时刷新', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
      resolvedLocale: 'en-US',
      agentMessages: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      agentSessionId: null,
      agentExpanded: false,
      toggleAgentExpanded: vi.fn(),
      loadAgentSkills: vi.fn().mockResolvedValue(undefined),
      loadAgentSessions: vi.fn().mockResolvedValue(undefined),
      agentSessions: [],
      draftSession: false,
    } as any);
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ agentRunStates: {}, draftSession: false } as any);
  });

  it('点过「新会话」（草稿态）：列表顶部草稿行，空态文案让位', async () => {
    useAppStore.setState({ draftSession: true } as any);
    render(<AgentPanel />);
    await userEvent.click(panelHistoryButton());
    const draft = document.querySelector('.agent-history-item-btn--draft') as HTMLElement;
    expect(draft).not.toBeNull();
    expect(draft.textContent).toContain('New chat');
    // 草稿行即当前视图，不再叠加「暂无历史」空态。
    expect(document.querySelector('.agent-history-empty')).toBeNull();
  });

  it('未点过（挂载空白视图）：无草稿行，空列表显空态', async () => {
    render(<AgentPanel />);
    await userEvent.click(panelHistoryButton());
    expect(document.querySelector('.agent-history-item-btn--draft')).toBeNull();
    expect(document.querySelector('.agent-history-empty')).not.toBeNull();
  });

  it('run 结束（running 集合收缩）→ 刷新列表一次（实时重排/计数）', async () => {
    // effect 挂在 AgentHistory 上——先开历史视图让组件挂载，再触发 running→idle 迁移。
    useAppStore.setState({ agentRunStates: { 's-run': { phase: 'running' } } } as any);
    render(<AgentPanel />);
    await userEvent.click(panelHistoryButton());
    const loadAgentSessions = useAppStore.getState().loadAgentSessions as ReturnType<typeof vi.fn>;
    loadAgentSessions.mockClear(); // 面板挂载期的首次拉取不计入。
    useAppStore.setState({ agentRunStates: {} } as any);
    await waitFor(() => expect(loadAgentSessions).toHaveBeenCalledTimes(1));
  });
});
