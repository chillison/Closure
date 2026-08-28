import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@orison/shared-contracts';

// Mock the IPC boundary only. The slice action under test (setAgentBehaviorMode)
// runs for real against this mock, exercising the genuine UI behavior:
// persist → await { ok } → roll back + surface error on failure.
const setAgentSessionBehaviorMode = vi.fn();
vi.mock('../src/shared/api/agent', async () => {
  const actual = await vi.importActual<typeof import('../src/shared/api/agent')>(
    '../src/shared/api/agent',
  );
  return { ...actual, setAgentSessionBehaviorMode: (...args: unknown[]) => setAgentSessionBehaviorMode(...args) };
});

import { AgentInput } from '../src/features/agent-panel/AgentInput';
import { useAppStore } from '../src/shared/store/appStore';

const modelConfig: ModelConfig = {
  keys: [
    {
      id: 'key_001',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test',
      models: [
        { id: 'gpt-4o', alias: 'GPT-4o', capability: 'text', enabled: true },
      ],
    },
  ],
};

function seedStore(overrides: Record<string, unknown> = {}) {
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
    agentError: null,
    chapters: [],
    openFiles: [],
    pendingAttachments: [],
    pendingToolConfirmBySession: {},
    pendingPassageResolveBySession: {},
    ...overrides,
  } as any);
}

function behaviorSelect(): HTMLSelectElement {
  // The behavior-mode dropdown is the <select> whose accessible title is the
  // behaviorModeTitle tooltip ("Behavior mode" in en-US).
  return screen.getByTitle('Behavior mode') as HTMLSelectElement;
}

describe('AgentInput behavior-mode switching (Story 3.1 WP1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setAgentSessionBehaviorMode.mockReset();
    // Clear orison_* localStorage keys so the persisted behavior mode doesn't
    // bleed across tests (the slice reads it at reset time).
    localStorage.clear();
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the second (behavior) select alongside the autonomy select', () => {
    seedStore();
    render(<AgentInput />);
    // Two selects in the toolbar: autonomy (Micro/Assist/Full) + behavior
    // (Normal/Discuss/Plan). The behavior select is present + starts at 'normal'.
    const select = behaviorSelect();
    expect(select).toBeTruthy();
    expect(select.value).toBe('normal');
  });

  it('persists the switch through the IPC boundary and keeps the new mode on success', async () => {
    setAgentSessionBehaviorMode.mockResolvedValue({ ok: true });
    seedStore();
    render(<AgentInput />);

    await userEvent.selectOptions(behaviorSelect(), 'plan');

    await waitFor(() => {
      expect(setAgentSessionBehaviorMode).toHaveBeenCalledWith(
        'session-1',
        'I:/echo/project',
        'plan',
      );
    });
    expect(useAppStore.getState().agentBehaviorMode).toBe('plan');
    expect(useAppStore.getState().agentError).toBeNull();
  });

  it('rolls the select back and surfaces an error when the runtime refuses the switch', async () => {
    setAgentSessionBehaviorMode.mockResolvedValue({ ok: false });
    seedStore({ agentBehaviorMode: 'normal' });
    render(<AgentInput />);

    await userEvent.selectOptions(behaviorSelect(), 'discuss');

    await waitFor(() => {
      expect(useAppStore.getState().agentBehaviorMode).toBe('normal');
    });
    expect(useAppStore.getState().agentError).toBe('agent.behaviorSwitchFailed');
    expect(behaviorSelect().value).toBe('normal');
  });

  it('is disabled while a turn is running and no session exists yet', () => {
    seedStore({ activeSessionRunning: true, agentSessionId: null });
    render(<AgentInput />);
    expect(behaviorSelect()).toBeDisabled();
  });
});
