/**
 * Story 3.4 Phase 3.3：工作台「检查改动影响」affordance 测试。
 *
 * 覆盖两段接线（mirror writeChapterTrigger.test.tsx 模式）：
 * 1. NovelWorkbench sidebar header「检查改动影响」按钮 → sendAgentMessage（含 diagnose_impacts 引导）。
 * 2. agentLoading 时按钮 disabled（防重复触发）。
 *
 * chat-first：作者也可直接在对话说「检查改动影响」（leader 据 segment 段调 tool）——按钮是 affordance 非必需。
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(async () => ({ id: 'session-1', messages: [] })),
  fetchAgentSession: vi.fn(),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(async () => []),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import { NovelWorkbench } from '../src/features/novel-workbench/NovelWorkbench';
import { useAppStore } from '../src/shared/store/appStore';
import { handleAgentStreamEvent, __clearAgentEventTracks } from '../src/shared/store/agentEvents';

describe('Story 3.4 Phase 3.3 — 工作台「检查改动影响」affordance', () => {
  beforeEach(() => {
    apiMocks.streamAgentMessage.mockReset();
    apiMocks.createAgentSession.mockReset();
    apiMocks.createAgentSession.mockResolvedValue({ id: 'session-1', messages: [] });
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
    (globalThis as any).window = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };

    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'P', path: '/proj', type: 'novel' },
      agentSessionId: null,
      agentMessages: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      agentMode: 'suggest',
      pendingPatchBySession: {},
                  fieldMetadata: {},
      resolvedLocale: 'zh-CN',
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('「检查改动影响」按钮点击 → sendAgentMessage 被调，消息含 diagnose_impacts 引导', async () => {
    render(<NovelWorkbench />);

    const btn = screen.getByRole('button', { name: '检查改动影响（涟漪诊断）' });
    expect(btn).toBeDefined();

    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(apiMocks.streamAgentMessage).toHaveBeenCalledTimes(1));

    const sentContent = apiMocks.streamAgentMessage.mock.calls[0][1] as string;
    // 消息含 diagnose_impacts 引导（leader 凭此调 tool）。
    expect(sentContent).toContain('diagnose_impacts');
    expect(sentContent).toContain('涟漪');
  });

  it('项目 run 在途时「检查改动影响」按钮 disabled（isProjectRunActive 语义，r8 三分）（防重复触发）', () => {
    useAppStore.setState({
      agentRunStates: { 'sess-bg': { sessionId: 'sess-bg', phase: 'running', projectPath: '/proj', updatedAt: 1 } },
    } as any);

    render(<NovelWorkbench />);

    const btn = screen.getByRole('button', { name: '检查改动影响（涟漪诊断）' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
