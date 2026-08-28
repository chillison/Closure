/**
 * Story 2.2 WP-B：SettingMdPatchCard——setting_md_update suggest 档的专用审阅卡
 * + AgentMessageItem 挂载（findings 档同款拦截）+ accept/reject 闭环。
 *
 * dogfood R2 #25：未决卡钉底（AgentPanel 滚动区外）不内联——内联只渲染 resolved 存档态；
 * pendingSettingMdPatchResults 收集器供 AgentPanel 钉底。
 *
 * 覆盖：metadata unknown-seam 形态守卫 / 专用卡渲染（词级 diff 面 + result.output 保底）/
 * accept 调 closure:accept-setting-md IPC（projectPath + settingId + actions 全量重放载荷）/
 * accept 失败（ok:false，文件已变）→ toast + 卡保持可操作 / reject 纯本地丢弃（Discarded 徽标，
 * CR-08-16-007）/ agentLoading 门（accept 禁用；两键 busy 在途互斥 CR-08-16-105）/ resolved map 按 toolCallId 键控。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettingMdPatchCard,
  extractSettingMdPatch,
  settingMdPatchCardKey,
  isSettingMdPatchResolved,
  pendingSettingMdPatchResults,
} from '../src/features/agent-panel/SettingMdPatchCard';
import { AgentMessageItem } from '../src/features/agent-panel/AgentMessageItem';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

declare global {
  interface Window {
    orisonDesktop: any;
  }
}

function patchMetadata(over: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'setting_md_patch',
    settingId: 'magic-system',
    filePath: '/proj/settings/magic-system.md',
    actions: [{ op: 'replace_span', anchor: { quote: '施法消耗精神力。' }, replacement: '施法消耗生命力。' }],
    before: '# 魔法体系\n\n施法消耗精神力。',
    after: '# 魔法体系\n\n施法消耗生命力。',
    created: false,
    summary: 'settings/magic-system.md · edit · replace_span×1',
    ...over,
  };
}

function toolMessage(id: string, results: Array<Record<string, unknown>>): AgentMessage {
  return {
    id,
    role: 'tool',
    content: '',
    toolResults: results as AgentMessage['toolResults'],
    createdAt: Date.now(),
  };
}

const acceptIpc = vi.fn();

beforeEach(() => {
  acceptIpc.mockReset();
  acceptIpc.mockResolvedValue({ ok: true, settingId: 'magic-system', appliedCount: 1, indexed: true });
  useAppStore.setState({
    resolvedLocale: 'en-US',
    activeSessionRunning: false,
      agentRunStates: {},
    agentMode: 'suggest',
    agentMessages: [],
    currentProject: { path: '/proj', name: 'P' } as any,
    resolvedSettingMdPatches: {},
    pendingDiffsBySession: {},
  } as any);
  (globalThis as any).window = globalThis as any;
  (window as any).orisonDesktop = {
    acceptSettingMdPatch: acceptIpc,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('extractSettingMdPatch（unknown seam 形态守卫）', () => {
  it('合法 metadata → 解析；关键字段缺失/类型错 → null', () => {
    const meta = extractSettingMdPatch(patchMetadata());
    expect(meta).not.toBeNull();
    expect(meta!.settingId).toBe('magic-system');
    expect(meta!.actions).toHaveLength(1);
    expect(meta!.before).toContain('精神力');
    expect(extractSettingMdPatch(undefined)).toBeNull();
    expect(extractSettingMdPatch({ type: 'field_patch', field: 'x' })).toBeNull();
    expect(extractSettingMdPatch({ type: 'setting_md_patch' })).toBeNull();
    expect(extractSettingMdPatch({ type: 'setting_md_patch', settingId: 'x', actions: 'nope', before: '', after: '' })).toBeNull();
    expect(extractSettingMdPatch({ type: 'setting_md_patch', settingId: 'x', actions: [], before: 'a', after: 'b' })).toBeNull();
    expect(extractSettingMdPatch({ type: 'setting_md_patch', settingId: 'x', actions: [42], before: 'a', after: 'b' })).toBeNull();
    // 任一条 action 畸形 → 整体 null（accept 重放全部 actions，静默丢一条 = 改变补丁语义）。
    expect(extractSettingMdPatch({
      type: 'setting_md_patch', settingId: 'x',
      actions: [{ op: 'replace_span', anchor: { quote: 'q' }, replacement: 'r' }, { op: 'bogus' }],
      before: 'a', after: 'b',
    })).toBeNull();
    expect(extractSettingMdPatch({ type: 'setting_md_patch', settingId: 'x', actions: [], before: 42, after: '' })).toBeNull();
  });

  it('card key：toolCallId 优先；缺省退化内容身份', () => {
    const meta = extractSettingMdPatch(patchMetadata())!;
    expect(settingMdPatchCardKey({ toolCallId: 'call-1' }, meta)).toBe('setting-md:call-1');
    expect(settingMdPatchCardKey({}, meta)).toBe('setting-md:magic-system:1:施法消耗精神力。');
  });
});

describe('SettingMdPatchCard 渲染 + AgentMessageItem 挂载', () => {
  it('专用卡渲染：词级 diff 面（SideBySideDiff）+ summary + accept/reject + result.output 保底', () => {
    const result = {
      toolCallId: 'call-1',
      toolName: 'setting_md_update',
      output: 'Setting-doc update prepared (edit: replace_span×1).',
      metadata: patchMetadata(),
    };
    const { container } = render(<SettingMdPatchCard result={result} />);
    // 专用卡壳 + 词级 diff 渲染器（7.5 SideBySideDiff readonly 形态）。
    expect(container.querySelector('.agent-diff-card')).toBeTruthy();
    expect(container.querySelector('.diff-side-by-side')).toBeTruthy();
    // 卡名 = 工具标签 + settingId（同 span 内多文本节点，断言容器文本）。
    expect(container.querySelector('.agent-diff-card-name')!.textContent).toBe('Update setting doc · magic-system');
    expect(screen.getByText('Accept')).toBeTruthy();
    expect(screen.getByText('Reject')).toBeTruthy();
    // CR-001 精神：result.output 逐字保留（卡片是结构化摘要非双源）。
    expect(container.querySelector('.agent-diff-card-body')!.textContent)
      .toContain('Setting-doc update prepared');
  });

  it('AgentMessageItem：setting_md_patch 在 WRITE_TOOLS 档之前拦截渲染（非 DiffCard 误导壳）——R2 #25 后仅 resolved 存档态内联', () => {
    // R2 #25：未决卡钉底不内联——此处预置 resolved 使其以存档态回内联原位。
    useAppStore.setState({ resolvedSettingMdPatches: { 'setting-md:call-1': 'applied' } } as any);
    const msg = toolMessage('m1', [
      { toolCallId: 'call-1', toolName: 'setting_md_update', output: 'prepared', metadata: patchMetadata() },
    ]);
    const { container } = render(<AgentMessageItem message={msg} />);
    // 专用卡（含词级 diff）出现，且每 result 只渲染一张卡；resolved 存档态无 accept/reject。
    expect(container.querySelectorAll('.diff-side-by-side')).toHaveLength(1);
    expect(container.querySelectorAll('.agent-diff-card')).toHaveLength(1);
    expect(screen.queryByText('Accept')).toBeNull();
    expect(container.textContent).toContain('Applied');
  });

  it('R2 #25：未决（resolved map 无 key）→ 内联不渲染（钉底由 AgentPanel 负责）', () => {
    const msg = toolMessage('m1', [
      { toolCallId: 'call-1', toolName: 'setting_md_update', output: 'prepared', metadata: patchMetadata() },
    ]);
    const { container } = render(<AgentMessageItem message={msg} />);
    expect(container.querySelector('.diff-side-by-side')).toBeNull();
    expect(container.querySelector('.agent-diff-card')).toBeNull();
  });

  it('R2 #25：pendingSettingMdPatchResults 收集——未决收、已决漏、非本族不进', () => {
    const unresolved = { toolCallId: 'call-1', toolName: 'setting_md_update', metadata: patchMetadata() };
    const resolved = { toolCallId: 'call-2', toolName: 'setting_md_update', metadata: patchMetadata() };
    const other = { toolCallId: 'call-3', toolName: 'write_file', metadata: { ok: true } };
    const messages = [{ toolResults: [unresolved] }, { toolResults: [resolved, other] }];
    expect(isSettingMdPatchResolved(unresolved, {})).toBe(false);
    expect(isSettingMdPatchResolved(unresolved, { 'setting-md:call-1': 'rejected' })).toBe(true);
    const pending = pendingSettingMdPatchResults(messages, { 'setting-md:call-2': 'applied' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolCallId).toBe('call-1');
  });

  it('非 setting_md_patch 的 setting_md_update 结果（autoApply 档）→ 无专用卡（auto 已直落）', () => {
    const msg = toolMessage('m1', [
      { toolCallId: 'call-2', toolName: 'setting_md_update', output: 'applied', metadata: { ok: true, applied: true } },
    ]);
    const { container } = render(<AgentMessageItem message={msg} />);
    expect(container.querySelector('.diff-side-by-side')).toBeNull();
    expect(container.querySelector('.agent-diff-card')).toBeNull();
  });
});

describe('accept / reject 闭环', () => {
  it('accept → acceptSettingMdPatch IPC 收 {projectPath, settingId, actions 全量}；成功后 resolved（按钮消失 + Applied 徽标）', async () => {
    const result = {
      toolCallId: 'call-1',
      toolName: 'setting_md_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    const { container } = render(<SettingMdPatchCard result={result} />);
    await userEvent.click(screen.getByText('Accept'));

    expect(acceptIpc).toHaveBeenCalledTimes(1);
    expect(acceptIpc).toHaveBeenCalledWith({
      projectPath: '/proj',
      settingId: 'magic-system',
      actions: (patchMetadata() as { actions: unknown[] }).actions,
    });
    // resolved：按钮消失、徽标出现。
    expect(screen.queryByText('Accept')).toBeNull();
    expect(screen.queryByText('Reject')).toBeNull();
    expect(container.textContent).toContain('Applied');
  });

  it('accept 失败（ok:false，文件已变化）→ toast + 卡保持可操作（可重试或 reject）', async () => {
    acceptIpc.mockResolvedValue({ ok: false, reason: 'span anchor "…" not found' });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    const result = {
      toolCallId: 'call-1',
      toolName: 'setting_md_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    render(<SettingMdPatchCard result={result} />);
    await userEvent.click(screen.getByText('Accept'));

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(String(firstToastMessage(showToast))).toContain('not found');
    expect(screen.getByText('Accept')).toBeTruthy(); // 仍可操作
    expect(useAppStore.getState().resolvedSettingMdPatches).toEqual({});
  });

  it('reject → 纯本地 resolve，IPC 不调（suggest 档从未写盘）；徽标显 Discarded 非 Applied（CR-08-16-007）', async () => {
    const result = {
      toolCallId: 'call-1',
      toolName: 'setting_md_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    const { container } = render(<SettingMdPatchCard result={result} />);
    await userEvent.click(screen.getByText('Reject'));

    expect(acceptIpc).not.toHaveBeenCalled();
    expect(useAppStore.getState().resolvedSettingMdPatches['setting-md:call-1']).toBe('rejected');
    expect(screen.queryByText('Reject')).toBeNull();
    // CR-08-16-007：拒掉的补丁从未写盘——绝不能显「已应用」。
    expect(container.textContent).toContain('Discarded');
    expect(container.textContent).not.toContain('Applied');
  });

  it('项目 run 在途 → accept 禁用（防与 leader 写竞争同文件），reject 不受限（busy 在途才互斥）', () => {
    useAppStore.setState({ agentRunStates: { 'sess-run': { sessionId: 'sess-run', phase: 'running', updatedAt: 1 } } } as any);
    const result = {
      toolCallId: 'call-1',
      toolName: 'setting_md_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    render(<SettingMdPatchCard result={result} />);
    expect((screen.getByText('Accept') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Reject') as HTMLButtonElement).disabled).toBe(false);
  });

  it('accept IPC 在途（busy）→ reject 禁用（CR-08-16-105：防「已丢弃」后文件仍被写入 + 徽标与行为相反）', async () => {
    let release!: (v: { ok: true; settingId: string; filePath: string; appliedCount: number; indexed: boolean }) => void;
    acceptIpc.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const result = {
      toolCallId: 'call-1',
      toolName: 'setting_md_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    render(<SettingMdPatchCard result={result} />);
    await userEvent.click(screen.getByText('Accept'));
    // busy 窗口：reject 被禁用（先到先得，两键互斥）。
    expect((screen.getByText('Reject') as HTMLButtonElement).disabled).toBe(true);
    release({ ok: true, settingId: 'magic-system', filePath: '/proj/settings/magic-system.md', appliedCount: 1, indexed: true });
    await waitFor(() => {
      expect(useAppStore.getState().resolvedSettingMdPatches['setting-md:call-1']).toBe('applied');
    });
  });

  it('两卡不同 toolCallId → 各自独立 resolve（互不影响）', async () => {
    const result1 = {
      toolCallId: 'call-1',
      toolName: 'setting_md_update',
      output: 'a',
      metadata: patchMetadata(),
    };
    const result2 = {
      toolCallId: 'call-2',
      toolName: 'setting_md_update',
      output: 'b',
      metadata: patchMetadata(),
    };
    const { container } = render(
      <div>
        <SettingMdPatchCard result={result1} />
        <SettingMdPatchCard result={result2} />
      </div>,
    );
    expect(container.querySelectorAll('.diff-side-by-side')).toHaveLength(2);
    await userEvent.click(screen.getAllByText('Reject')[0]);
    // 只第一张 resolved。
    expect(screen.getAllByText('Accept')).toHaveLength(1);
  });
});

/** Toast spy 首参（i18n 后的字符串）提取 helper。 */
function firstToastMessage(spy: ReturnType<typeof vi.spyOn>): unknown {
  return spy.mock.calls[0]?.[0];
}
