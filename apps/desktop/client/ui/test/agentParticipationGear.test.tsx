import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the IPC boundary only; the slice action under test (setAgentParticipationGear)
// runs for real against this mock — persist → await { ok } → roll back + surface
// error on failure (mirror agentInputBehaviorMode.test).
const setAgentSessionParticipationGear = vi.fn();
vi.mock('../src/shared/api/agent', async () => {
  const actual = await vi.importActual<typeof import('../src/shared/api/agent')>(
    '../src/shared/api/agent',
  );
  return {
    ...actual,
    setAgentSessionParticipationGear: (...args: unknown[]) => setAgentSessionParticipationGear(...args),
  };
});

import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { AgentSettings } from '../src/features/agent-panel/AgentSettings';
import { useAppStore } from '../src/shared/store/appStore';
import { gearOptionsIfChanged } from '../src/shared/store/agentSessionSlice';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 7：参与档位 UI——AgentPanel header 快捷切换 + AgentSettings 完整
// 设置（balanced 圈类别 / hands_off trust 开关仅在语义相关档位显示）+ i18n key
// + slice 持久化/回滚 + options 只在偏离默认时同步。
// ─────────────────────────────────────────────────────────────────────────────

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    resolvedLocale: 'en-US',
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
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
    // Deterministic gear defaults per test (overrides win).
    agentParticipationGear: 'smart',
    agentBalancedAskCategories: ['protagonist_safety', 'information_gap', 'direction_turn'],
    agentTrustAdjudication: false,
    ...overrides,
  } as any);
}

function gearSelect(): HTMLSelectElement {
  return screen.getByTitle('Participation') as HTMLSelectElement;
}

describe('Story 3.5 — participation gear（AgentPanel header 快捷切换）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setAgentSessionParticipationGear.mockReset();
    localStorage.clear();
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
  });

  afterEach(() => cleanup());

  it('header 渲染四档 select（i18n key），默认 smart', () => {
    seedStore();
    render(<AgentPanel />);
    const select = gearSelect();
    expect(select.value).toBe('smart');
    expect(screen.getByRole('option', { name: 'Smart' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Steer' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Balanced' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Hands-off' })).toBeTruthy();
  });

  it('切换经 IPC 持久化；默认 options 不随档位切换发送（additive 只更新显式键）', async () => {
    setAgentSessionParticipationGear.mockResolvedValue({ ok: true });
    seedStore();
    render(<AgentPanel />);

    await userEvent.selectOptions(gearSelect(), 'steer');

    await waitFor(() => {
      expect(setAgentSessionParticipationGear).toHaveBeenCalledWith(
        'session-1',
        'I:/echo/project',
        'steer',
        undefined,
      );
    });
    expect(useAppStore.getState().agentParticipationGear).toBe('steer');
    expect(useAppStore.getState().agentError).toBeNull();
  });

  it('runtime 拒改（运行中）→ 回滚到已确认档 + agentError i18n key', async () => {
    setAgentSessionParticipationGear.mockResolvedValue({ ok: false });
    seedStore({ agentParticipationGear: 'smart' });
    render(<AgentPanel />);

    await userEvent.selectOptions(gearSelect(), 'hands_off');

    await waitFor(() => {
      expect(useAppStore.getState().agentParticipationGear).toBe('smart');
    });
    expect(useAppStore.getState().agentError).toBe('agent.gearSwitchFailed');
    expect(gearSelect().value).toBe('smart');
  });

  it('streaming 中 select 禁用（UI 入口；中途调档走 chat 指令）', () => {
    seedStore({ activeSessionRunning: true });
    render(<AgentPanel />);
    expect(gearSelect()).toBeDisabled();
  });

  it('活跃批量横幅：从最近 batch metadata 机械派生（档位 + n/N）；无则不显示', () => {
    const batch = {
      batchId: 'b-1', createdAt: 1, orderedSceneIds: ['s1', 's2', 's3'], doneSceneIds: ['s1', 's2'],
      gear: 'steer', status: 'running', chapterMap: {},
    };
    seedStore({
      agentMessages: [
        {
          id: 't1', role: 'tool', content: '', createdAt: 1, batchId: 'b-1', batchKind: 'progress',
          toolResults: [{ toolCallId: 'c1', toolName: 'batch_status', output: 'ok', metadata: { type: 'batch_status', batch } }],
        } as any,
      ],
    });
    render(<AgentPanel />);

    expect(screen.getByText('Batch writing in progress · 2/3 scenes · Steer')).toBeTruthy();
  });

  it('无批量 → 无横幅', () => {
    seedStore({ agentMessages: [{ id: 'm1', role: 'assistant', content: 'hi', createdAt: 1 } as any] });
    const { container } = render(<AgentPanel />);
    expect(container.querySelector('.agent-batch-banner')).toBeNull();
  });
});

describe('Story 3.5 — participation gear（AgentSettings 完整设置）', () => {
  beforeEach(() => {
    setAgentSessionParticipationGear.mockReset();
    setAgentSessionParticipationGear.mockResolvedValue({ ok: true });
    localStorage.clear();
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
  });

  afterEach(() => cleanup());

  it('四档 radio；balanced 档显圈类别勾选（默认三项全）；hands_off 档显 trust 开关', async () => {
    seedStore({ agentParticipationGear: 'balanced' });
    render(<AgentSettings onClose={vi.fn()} />);

    // balanced：圈类别可见，trust 不可见。
    expect(screen.getByText('Always-ask categories (Balanced)')).toBeTruthy();
    expect(screen.getByText('Protagonist safety')).toBeTruthy();
    expect(screen.queryByText(/trust the AI's first-pass/i)).toBeNull();

    // 切到 hands_off：trust 开关可见，圈类别消失。
    await userEvent.click(screen.getByRole('radio', { name: /Hands-off/ }));
    await waitFor(() => {
      expect(screen.queryByText('Always-ask categories (Balanced)')).toBeNull();
    });
    expect(screen.getByLabelText(/trust the AI's first-pass/i)).toBeTruthy();
  });

  it('smart 档：圈类别与 trust 均不显示（仅语义相关档位显示）', () => {
    seedStore({ agentParticipationGear: 'smart' });
    render(<AgentSettings onClose={vi.fn()} />);
    expect(screen.queryByText('Always-ask categories (Balanced)')).toBeNull();
    expect(screen.queryByText(/trust the AI's first-pass/i)).toBeNull();
  });

  it('勾选圈类别 → setAgentParticipationGear 带 options（IPC 收到显式键）', async () => {
    seedStore({ agentParticipationGear: 'balanced' });
    render(<AgentSettings onClose={vi.fn()} />);

    // 取消一项 → options 偏离默认 → IPC 带显式 options。
    await userEvent.click(screen.getByLabelText('Information-gap decisions'));

    await waitFor(() => {
      expect(setAgentSessionParticipationGear).toHaveBeenCalledWith(
        'session-1',
        'I:/echo/project',
        'balanced',
        { balancedAskCategories: ['protagonist_safety', 'direction_turn'], trustAdjudication: false },
      );
    });
    expect(useAppStore.getState().agentBalancedAskCategories).toEqual(['protagonist_safety', 'direction_turn']);
  });
});

describe('Story 3.5 — gearOptionsIfChanged（options 只在偏离默认时同步）', () => {
  it('默认三元组 → undefined（跳过 IPC payload）', () => {
    expect(gearOptionsIfChanged(['protagonist_safety', 'information_gap', 'direction_turn'], false)).toBeUndefined();
  });

  it('偏离默认（收窄类别 / trust=true）→ 返回显式 options', () => {
    expect(gearOptionsIfChanged(['protagonist_safety'], false)).toEqual({
      balancedAskCategories: ['protagonist_safety'],
      trustAdjudication: false,
    });
    expect(gearOptionsIfChanged(['protagonist_safety', 'information_gap', 'direction_turn'], true)).toEqual({
      balancedAskCategories: ['protagonist_safety', 'information_gap', 'direction_turn'],
      trustAdjudication: true,
    });
  });
});
