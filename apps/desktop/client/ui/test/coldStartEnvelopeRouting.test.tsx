/**
 * Story 8.6（B01 三处同步 checklist 测试断言点）：冷启动引导写工具 envelope 捕获层测试。
 *
 * mirror arcPipelineEnvelopeRouting.test.tsx（Story 8.5 B01 形态）——suggest 档（缺省档）
 * leader 调 creative_brief_update / creative_preferences_update 的主路径依赖
 * agentSessionSlice results 循环的 WRITE_TOOLS toolId 门 → 泛化 field_patch 路由 →
 * setPendingPatch。WRITE_TOOLS 漏登任一工具时该 tool result 被静默丢弃，PatchReview 卡
 * 永不出现（CR-B01 断链形态）。author_profile_update 走专用分流不进 WRITE_TOOLS
 * （AuthorProfilePatchCard 位）——集合断言锚定它不混入。
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(async () => ({ id: 'session-1', messages: [] })),
  fetchAgentSession: vi.fn(),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(async () => []),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import { useAppStore } from '../src/shared/store/appStore';
import { handleAgentStreamEvent, __clearAgentEventTracks } from '../src/shared/store/agentEvents';
import { WRITE_TOOLS } from '../src/shared/store/agentDiffSlice';
import { AgentMessageItem } from '../src/features/agent-panel/AgentMessageItem';
import type { AgentStreamEvent } from '../src/shared/api/agent';
import type { AgentMessage } from '../src/shared/store/agentSlice';

describe('Story 8.6 B01 - 冷启动写工具 envelope 捕获（suggest 档主路径）', () => {
  const emitStreamEvent = (event: AgentStreamEvent): void => {
  // dogfood T1 Stage 3：路由测试直驱全局分发器（事件带 sessionId+projectPath 进活跃分支）。
  const s = useAppStore.getState();
  handleAgentStreamEvent(useAppStore, {
    ...event,
    sessionId: s.agentSessionId ?? '',
    projectPath: s.currentProject?.path,
  });
};

  beforeEach(() => {
    __clearAgentEventTracks();
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
      pausedReviewBySession: {},
      reviewResuming: false,
      resolvedLocale: 'zh-CN',
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('leader 调 creative_brief_update（field_patch field=creative_brief）-> pendingPatch surface', async () => {
    const sending = useAppStore.getState().sendAgentMessage('我想写一个关于审判日的故事');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-cb-1',
          results: [
            {
              toolCallId: 'call_cb_1',
              toolName: 'creative_brief_update',
              output: 'Creative-brief update prepared (raw_requirement, genre). Awaiting user review.',
              metadata: {
                type: 'field_patch',
                field: 'creative_brief',
                action: 'set',
                data: {
                  rawRequirement: '我想写一个关于审判日的故事：末法时代最后一场审判。',
                  genre: '奇幻',
                  theme: '审判与救赎',
                },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    expect(pending!.patches).toHaveLength(1);
    const entry = pending!.patches[0];
    expect(entry.field).toBe('creative_brief');
    expect(entry.action).toBe('set');
    expect(entry.generatedBy).toBe('creative_brief_update');
    expect((entry.data as { rawRequirement: string }).rawRequirement).toContain('审判日');
  });

  it('leader 调 creative_preferences_update（field_patch field=creative_preferences）-> pendingPatch surface', async () => {
    const sending = useAppStore.getState().sendAgentMessage('我习惯先写大纲骨架');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-cp-1',
          results: [
            {
              toolCallId: 'call_cp_1',
              toolName: 'creative_preferences_update',
              output: 'Creative-preferences update prepared (outline_depth). Awaiting user review.',
              metadata: {
                type: 'field_patch',
                field: 'creative_preferences',
                action: 'set',
                data: {
                  outline_depth: 'skeleton',
                  arc_timing: 'as_you_go',
                  note: '先骨架后 flesh，边写边排弧',
                },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    const entry = pending!.patches[0];
    expect(entry.field).toBe('creative_preferences');
    expect(entry.generatedBy).toBe('creative_preferences_update');
    expect((entry.data as { outline_depth: string }).outline_depth).toBe('skeleton');
  });
});

describe('WRITE_TOOLS 集合断言（B01 三处同步 #3）', () => {
  it('creative_brief_update / creative_preferences_update 在集合中；author_profile_update 不在（专用分流）', () => {
    expect(WRITE_TOOLS).toContain('creative_brief_update');
    expect(WRITE_TOOLS).toContain('creative_preferences_update');
    // author_profile_patch 走 AgentMessageItem 专用分流（mirror setting_md_update 的
    // setting_md_patch 先例位——但 setting_md_update 因 autoApply 档 field_patch 需求在
    // WRITE_TOOLS，author_profile_update 无 field_patch 形态，不进）。
    expect(WRITE_TOOLS).not.toContain('author_profile_update');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-003（8.6 BMad CR HIGH）：AgentMessageItem 渲染路由——两工具 autoApply 直落结果（非
// envelope）不落 WRITE_TOOLS fallthrough 渲染 DiffCard 误导壳（mirror setting_md 非 envelope
// 分支理由：无 pending diff 可匹配 →「已处理」壳）；field_patch envelope 照旧走 DiffCard。
// ─────────────────────────────────────────────────────────────────────────────

describe('CR-003 — autoApply 直落结果不进 DiffCard（AgentMessageItem 渲染路由）', () => {
  function toolMessage(id: string, results: Array<Record<string, unknown>>): AgentMessage {
    return {
      id,
      role: 'tool',
      content: '',
      toolResults: results as AgentMessage['toolResults'],
      createdAt: Date.now(),
    };
  }

  beforeEach(() => {
    useAppStore.setState({
      resolvedLocale: 'zh-CN',
      activeSessionRunning: false,
      agentRunStates: {},
      agentMode: 'suggest',
      pendingDiffsBySession: {},
      agentMessages: [],
      currentProject: { projectId: 'p1', name: 'P', path: '/proj', type: 'novel' },
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('autoApply 直落结果（metadata {ok, applied}，非 field_patch）→ 步骤卡（agent-tool-card），无 DiffCard 误导壳', () => {
    for (const toolName of ['creative_brief_update', 'creative_preferences_update']) {
      const msg = toolMessage(`m-${toolName}`, [
        {
          toolCallId: `call-${toolName}`,
          toolName,
          output: '创作简报已直接生效（本次更新字段：genre）。',
          metadata: { ok: true, applied: true, updatedFields: ['genre'] },
        },
      ]);
      const { container } = render(<AgentMessageItem message={msg} />);
      // 无 pending diff 可匹配——DiffCard 的「已处理」壳不得出现（误导）。
      expect(container.querySelector('.agent-diff-card')).toBeNull();
      // 落普通步骤卡（output 摘要默认折叠在卡内展开钮后——呈现位断言即可，mirror setting_md_update
      // 非 envelope 分支）。
      expect(container.querySelector('.agent-tool-card')).toBeTruthy();
    }
  });

  it('field_patch envelope 结果照旧走 WRITE_TOOLS diff 路径进 DiffCard（人审卡呈现位不变）', () => {
    const msg = toolMessage('m-envelope', [
      {
        toolCallId: 'call-env',
        toolName: 'creative_brief_update',
        output: '创作简报更新已备好——默认会先呈现给作者。',
        metadata: {
          type: 'field_patch',
          field: 'creative_brief',
          action: 'set',
          data: { rawRequirement: '末法时代最后一场审判' },
        },
      },
    ]);
    const { container } = render(<AgentMessageItem message={msg} />);
    // envelope 是人审 patch——DiffCard 呈现位保留（CR-003 只拦「非 field_patch 结果」）。
    expect(container.querySelector('.agent-diff-card')).toBeTruthy();
    expect(container.querySelector('.agent-tool-card')).toBeNull();
  });

  it('autoApply 失败无 metadata 的结果同样不进 DiffCard（步骤卡）', () => {
    const msg = toolMessage('m-fail', [
      {
        toolCallId: 'call-fail',
        toolName: 'creative_preferences_update',
        output: 'Creative-preferences auto-apply failed: locked. Updates were validated but nothing was persisted.',
      },
    ]);
    const { container } = render(<AgentMessageItem message={msg} />);
    expect(container.querySelector('.agent-diff-card')).toBeNull();
    expect(container.querySelector('.agent-tool-card')).toBeTruthy();
  });
});
