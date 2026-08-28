/**
 * Story 4.1 Step 5（design §3.4）：工作台 leader 触发入口。
 *
 * 覆盖三段接线：
 * 1. ChapterListPanel「生成」按钮 → sendAgentMessage（自然语言 + episodeId/chapterId 上下文）。
 * 2. agentSessionSlice：write_chapter tool result 的 field_patch chapter_candidate metadata →
 *    setPendingPatch（pendingPatch 非空，PatchReviewPanel 可显示）。依赖 WRITE_TOOLS 含 write_chapter
 *    （Step 5 接线；4.0 capability-only 时 write_chapter 不在 WRITE_TOOLS，metadata 被过滤）。
 * 3. 「生成」按钮 disabled when agentLoading（防重复触发）。
 *
 * 跳过 e2e harness（用户 2026-08-01 拍）；jsdom 单测覆盖。
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

import { ChapterListPanel } from '../src/features/novel-workbench/ChapterListPanel';
import { useAppStore } from '../src/shared/store/appStore';
import { handleAgentStreamEvent, __clearAgentEventTracks } from '../src/shared/store/agentEvents';
import type { AgentStreamEvent } from '../src/shared/api/agent';

describe('Story 4.1 Step 5 — 工作台 leader 触发入口', () => {
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
    // capture onEvent（streamAgentMessage 第 3 参）以便人工 emit tool 事件。
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
    (globalThis as any).window = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };

    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'P', path: '/proj', type: 'novel' },
      creativeFields: {
        episode_outlines: [
          { id: 'ep1', index: 0, title: '开篇' },
          { id: 'ep2', index: 1, title: 'B 城' },
        ],
      },
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

  // 注意：novelChapters 必须在每个测试体内 setState（不能放 beforeEach）—— appStore 的
  // installProjectSubscription 在 currentProject 变化时异步清空 novelChapters，beforeEach
  // 的 setState 会被订阅回调覆盖；体内 setState 发生在订阅清空之后才稳定。

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. ChapterListPanel「生成」按钮 → sendAgentMessage（含 episodeId/chapterId）
  // ─────────────────────────────────────────────────────────────────────────────

  it('「生成」按钮点击 → sendAgentMessage 被调，消息含 episodeId + chapterId（leader 凭引导调 write_chapter）', async () => {
    useAppStore.setState({
      novelChapters: [
        { id: 'ch_001', title: '开篇', sortOrder: 0, status: 'draft', sections: [] },
        { id: 'ch_002', title: '入城', sortOrder: 1, status: 'planned' as any, sections: [] },
      ],
      creativeFields: {
        episode_outlines: [
          { id: 'ep1', index: 0, title: '开篇' },
          { id: 'ep2', index: 1, title: 'B 城' },
        ],
      },
    } as any);

    render(<ChapterListPanel />);

    const generateBtns = screen.getAllByRole('button', { name: '生成本章（写章链段）' });
    expect(generateBtns).toHaveLength(2);

    await act(async () => {
      fireEvent.click(generateBtns[0]);
    });
    await waitFor(() => expect(apiMocks.streamAgentMessage).toHaveBeenCalledTimes(1));

    const sentContent = apiMocks.streamAgentMessage.mock.calls[0][1] as string;
    // episodeId（chapter.sortOrder=0 → episode.index=0 → ep1）+ chapterId 直传。
    expect(sentContent).toContain('ep1');
    expect(sentContent).toContain('ch_001');
    expect(sentContent).toContain('write_chapter');
  });

  // CR-4.1-18：无 episode（章未在 episode_outlines 排出）→ 禁用「生成」按钮（write_chapter episodeId 必填；
  // UI 健壮避免 leader 收到无法调工具的消息卡住）。ordinal 兜底（Number.isFinite）确保即使 sortOrder 异常，
  // 按钮已禁用 → 不会发「第 NaN 章」消息。episodeId 保持必填 + readiness gate 不变。

  it('CR-4.1-18：章未在 episode_outlines 排出 → 「生成」按钮禁用 + tooltip 提示先规划 episode（不发消息）', () => {
    useAppStore.setState({
      novelChapters: [{ id: 'ch_99', title: '游离章', sortOrder: 9, status: 'draft', sections: [] }],
      creativeFields: { episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }] },
    } as any);

    render(<ChapterListPanel />);
    // aria-label 切到「未接 episode」tooltip（非 generateChapter）。
    const btn = screen.getByRole('button', { name: '本章未在 episode_outlines 排出，先规划 episode 再生成' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(btn);
    // 按钮禁用 → 不发消息（episodeId 必填，避免 leader 卡）。
    expect(apiMocks.streamAgentMessage).not.toHaveBeenCalled();
  });

  it('CR-4.1-18：sortOrder 非有限数（undefined）→ 按钮禁用，不发「第 NaN 章」消息（ordinal 兜底）', () => {
    useAppStore.setState({
      novelChapters: [
        { id: 'ch_x', title: '坏数据', sortOrder: undefined as unknown as number, status: 'draft', sections: [] },
      ],
      creativeFields: { episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }] },
    } as any);

    render(<ChapterListPanel />);
    const btn = screen.getByRole('button', { name: '本章未在 episode_outlines 排出，先规划 episode 再生成' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(btn);
    expect(apiMocks.streamAgentMessage).not.toHaveBeenCalled();
  });

  it('项目 run 在途时「生成」按钮 disabled（isProjectRunActive 语义，r8 三分）（防重复触发）', () => {
    useAppStore.setState({
      novelChapters: [{ id: 'ch_001', title: '开篇', sortOrder: 0, status: 'draft', sections: [] }],
      creativeFields: { episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }] },
      agentRunStates: { 'sess-bg': { sessionId: 'sess-bg', phase: 'running', projectPath: '/proj', updatedAt: 1 } },
    } as any);

    render(<ChapterListPanel />);

    const btn = screen.getByRole('button', { name: '生成本章（写章链段）' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. agentSessionSlice：write_chapter field_patch chapter_candidate → setPendingPatch
  //    （依赖 WRITE_TOOLS 含 write_chapter；4.0 时不在 → metadata 被过滤，pendingPatch 不设）
  // ─────────────────────────────────────────────────────────────────────────────

  it('write_chapter tool result 带 field_patch chapter_candidate metadata → pendingPatch 含 chapter_candidate（PatchReviewPanel 可显示）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());
    // 等 createAgentSession resolve + streamAgentMessage 被调（emitStreamEvent 就绪）。

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-1',
          results: [
            {
              toolCallId: 'call_1',
              toolName: 'write_chapter',
              output: 'status: completed\n已生成章节候选（chapter ch_001），等待你在工作台审阅后落盘。',
              metadata: {
                type: 'field_patch',
                field: 'chapter_candidate',
                action: 'set',
                data: {
                  chapterId: 'ch_001',
                  runId: 'run_mock',
                  candidate: { title: '开篇', content: '正文…', wordCount: 2800 },
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
    expect(pending?.patches).toHaveLength(1);
    expect((pending?.patches[0].field as string)).toBe('chapter_candidate');
    expect((pending?.patches[0].data as { chapterId: string }).chapterId).toBe('ch_001');
    expect(pending?.patches[0].generatedBy).toBe('write_chapter');
  });

  it('write_chapter tool result 无 metadata → pendingPatch 不设（不误触 patch review）', async () => {
    const initialPatch = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-2',
          results: [
            { toolCallId: 'call_2', toolName: 'write_chapter', output: 'status: completed' },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    expect((useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null)).toBe(initialPatch);
  });

  it('非 write tool 的 field_patch chapter_candidate metadata → 不被收进 pendingPatch（WRITE_TOOLS gate）', async () => {
    // read tool（非 WRITE_TOOLS）即使带 field_patch metadata 也不该进 patch review —— WRITE_TOOLS
    // gate 是防御性过滤，避免任意 tool 的 metadata 污染 patch review 流。
    const sending = useAppStore.getState().sendAgentMessage('看一下');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-3',
          results: [
            {
              toolCallId: 'call_3',
              toolName: 'read_file',
              output: 'ok',
              metadata: { type: 'field_patch', field: 'chapter_candidate', action: 'set', data: { chapterId: 'x' } },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    expect((useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null)).toBeNull();
  });
});
