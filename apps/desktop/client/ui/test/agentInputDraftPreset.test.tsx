import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@orison/shared-contracts';

// Story 3.7 WP1：「应用并补充」预填——AgentInput 消费 insightInteractionSlice.draftPreset
// （消费即 consumeDraft 清空，避免重复注入）；已有输入追加不覆盖。

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
    draftPreset: null,
    ...overrides,
  } as any);
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Ask the agent/) as HTMLTextAreaElement;
}

describe('AgentInput draftPreset consumption (Story 3.7 应用并补充)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
  });

  afterEach(() => {
    cleanup();
  });

  it('mount 时已有 draftPreset → 预填进输入框并即刻清空（消费一次性）', async () => {
    seedStore({ draftPreset: '请修复这条结构问题：X\n补充说明：' });
    render(<AgentInput />);

    await waitFor(() => {
      expect(textarea().value).toBe('请修复这条结构问题：X\n补充说明：');
    });
    expect(useAppStore.getState().draftPreset).toBeNull();
  });

  it('运行中 presetDraft → 输入框追加已有文本之后（不覆盖用户打到一半的话）', async () => {
    seedStore();
    render(<AgentInput />);
    await userEvent.type(textarea(), '先别动第三章');

    useAppStore.getState().presetDraft('请修复这条结构问题：X\n补充说明：');

    await waitFor(() => {
      expect(textarea().value).toBe('先别动第三章\n请修复这条结构问题：X\n补充说明：');
    });
    expect(useAppStore.getState().draftPreset).toBeNull();
    // 二次 presetDraft 不重复注入上一条（每条只消费一次）。
    useAppStore.getState().presetDraft('第二条预填');
    await waitFor(() => {
      expect(textarea().value).toBe('先别动第三章\n请修复这条结构问题：X\n补充说明：\n第二条预填');
    });
  });
});
