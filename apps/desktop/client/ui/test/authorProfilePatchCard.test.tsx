/**
 * Story 8.6 R4：AuthorProfilePatchCard——author_profile_update suggest 档的专用审阅卡
 * + AgentMessageItem 挂载（setting_md_patch 同位拦截）+ accept/reject 闭环。
 *
 * dogfood R2 #25：未决卡钉底（AgentPanel 滚动区外）不内联——内联只渲染 resolved 存档态；
 * pendingAuthorProfilePatchResults 收集器供 AgentPanel 钉底。
 *
 * 覆盖：metadata unknown-seam 形态守卫 / 专用卡渲染（说人话标题 + note 原文 + 词级 diff 面 +
 * result.output 保底）/ accept 调 author-profile:apply IPC（载荷只有 note——shell 对当前档案
 * 重新追加，永不写 stale after）/ accept 失败（ok:false）→ toast + 卡保持可操作 / reject 纯本地
 * 丢弃（Discarded 徽标，CR-08-16-007）/ agentLoading 门 + 两键 busy 在途互斥（CR-08-16-105）/
 * resolved map 按 toolCallId 键控。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorProfilePatchCard,
  extractAuthorProfilePatch,
  authorProfilePatchCardKey,
  isAuthorProfilePatchResolved,
  pendingAuthorProfilePatchResults,
} from '../src/features/agent-panel/AuthorProfilePatchCard';
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
    type: 'author_profile_patch',
    note: '这位作者偏好先聊人物再聊情节，对系统功能不熟悉，解释要带例子。',
    before: '## 2026-08-17 21:04\n上一位作者喜欢先定结局。',
    after: '## 2026-08-17 21:04\n上一位作者喜欢先定结局。\n\n## 2026-08-18 10:02\n这位作者偏好先聊人物再聊情节，对系统功能不熟悉，解释要带例子。',
    filePath: 'C:/Users/author/.orison/author_profile.md',
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

const applyIpc = vi.fn();

beforeEach(() => {
  applyIpc.mockReset();
  applyIpc.mockResolvedValue({ ok: true, filePath: 'C:/Users/author/.orison/author_profile.md' });
  useAppStore.setState({
    resolvedLocale: 'en-US',
    activeSessionRunning: false,
      agentRunStates: {},
    agentMode: 'suggest',
    agentMessages: [],
    currentProject: { path: '/proj', name: 'P' } as any,
    resolvedAuthorProfilePatches: {},
    pendingDiffsBySession: {},
  } as any);
  (globalThis as any).window = globalThis as any;
  (window as any).orisonDesktop = {
    applyAuthorProfileNote: applyIpc,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('extractAuthorProfilePatch（unknown seam 形态守卫）', () => {
  it('合法 metadata → 解析；关键字段缺失/类型错 → null', () => {
    const meta = extractAuthorProfilePatch(patchMetadata());
    expect(meta).not.toBeNull();
    expect(meta!.note).toContain('先聊人物');
    expect(meta!.before).toContain('上一位作者');
    expect(meta!.after).toContain('先聊人物');
    expect(meta!.filePath).toContain('author_profile.md');
    expect(extractAuthorProfilePatch(undefined)).toBeNull();
    expect(extractAuthorProfilePatch({ type: 'field_patch', field: 'creative_brief' })).toBeNull();
    expect(extractAuthorProfilePatch({ type: 'author_profile_patch' })).toBeNull();
    // note 空/空白 → null（accept 载荷为空是无意义卡）。
    expect(extractAuthorProfilePatch({ type: 'author_profile_patch', note: '   ', before: 'a', after: 'b' })).toBeNull();
    expect(extractAuthorProfilePatch({ type: 'author_profile_patch', note: 'n', before: 42, after: 'b' })).toBeNull();
    // filePath 可选（缺省仍解析）。
    const noPath = extractAuthorProfilePatch({ type: 'author_profile_patch', note: 'n', before: 'a', after: 'b' });
    expect(noPath).not.toBeNull();
    expect(noPath!.filePath).toBeUndefined();
  });

  it('card key：toolCallId 优先；缺省退化内容身份', () => {
    const meta = extractAuthorProfilePatch(patchMetadata())!;
    expect(authorProfilePatchCardKey({ toolCallId: 'call-1' }, meta)).toBe('author-profile:call-1');
    const fallback = authorProfilePatchCardKey({}, meta);
    expect(fallback).toMatch(/^author-profile:/);
    // 不同 note → 不同 key（内容身份可区分重复提议）。
    const other = extractAuthorProfilePatch(patchMetadata({ note: '另一条完全不同的观察。' }))!;
    expect(authorProfilePatchCardKey({}, other)).not.toBe(fallback);
  });
});

describe('AuthorProfilePatchCard 渲染 + AgentMessageItem 挂载', () => {
  it('专用卡渲染：说人话标题 + note 原文 + 词级 diff 面（SideBySideDiff）+ accept/reject + result.output 保底', () => {
    const result = {
      toolCallId: 'call-1',
      toolName: 'author_profile_update',
      output: 'Author-profile note prepared.',
      metadata: patchMetadata(),
    };
    const { container } = render(<AuthorProfilePatchCard result={result} />);
    expect(container.querySelector('.agent-diff-card')).toBeTruthy();
    expect(container.querySelector('.diff-side-by-side')).toBeTruthy();
    // 标题说人话（编辑视角邀请，非 envelope 术语）。
    expect(container.querySelector('.agent-diff-card-name')!.textContent)
      .toBe('Your editor wants to note an observation about you');
    // note 原文呈现（「这一笔要记什么」）。
    expect(container.querySelector('.agent-author-profile-note')!.textContent).toContain('先聊人物');
    expect(screen.getByText('Accept')).toBeTruthy();
    expect(screen.getByText('Reject')).toBeTruthy();
    // CR-001 精神：result.output 逐字保留（卡片是结构化摘要非双源）。
    expect(container.textContent).toContain('Author-profile note prepared.');
  });

  it('AgentMessageItem：author_profile_patch 在 WRITE_TOOLS 档之前拦截渲染（专用卡非 DiffCard/步骤卡）——R2 #25 后仅 resolved 存档态内联', () => {
    // R2 #25：未决卡钉底不内联——此处预置 resolved 使其以存档态回内联原位。
    useAppStore.setState({ resolvedAuthorProfilePatches: { 'author-profile:call-1': 'applied' } } as any);
    const msg = toolMessage('m1', [
      { toolCallId: 'call-1', toolName: 'author_profile_update', output: 'prepared', metadata: patchMetadata() },
    ]);
    const { container } = render(<AgentMessageItem message={msg} />);
    expect(container.querySelectorAll('.diff-side-by-side')).toHaveLength(1);
    expect(container.querySelectorAll('.agent-diff-card')).toHaveLength(1);
    // resolved 存档态：无 accept/reject 按钮，有 Applied 徽标。
    expect(screen.queryByText('Accept')).toBeNull();
    expect(container.textContent).toContain('Applied');
  });

  it('R2 #25：未决（resolved map 无 key）→ 内联不渲染（钉底由 AgentPanel 负责，防 run 继续被顶出视野）', () => {
    const msg = toolMessage('m1', [
      { toolCallId: 'call-1', toolName: 'author_profile_update', output: 'prepared', metadata: patchMetadata() },
    ]);
    const { container } = render(<AgentMessageItem message={msg} />);
    expect(container.querySelector('.diff-side-by-side')).toBeNull();
    expect(container.querySelector('.agent-diff-card')).toBeNull();
  });

  it('R2 #25：pendingAuthorProfilePatchResults 收集——未决收、已决漏、非本族不进；isAuthorProfilePatchResolved 判定', () => {
    const unresolved = { toolCallId: 'call-1', toolName: 'author_profile_update', metadata: patchMetadata() };
    const resolved = { toolCallId: 'call-2', toolName: 'author_profile_update', metadata: patchMetadata() };
    const other = { toolCallId: 'call-3', toolName: 'setting_md_update', metadata: { ok: true, applied: true } };
    const messages = [
      { toolResults: [unresolved] },
      { toolResults: [resolved, other] },
    ];
    expect(isAuthorProfilePatchResolved(unresolved, {})).toBe(false);
    expect(isAuthorProfilePatchResolved(unresolved, { 'author-profile:call-1': 'rejected' })).toBe(true);
    expect(isAuthorProfilePatchResolved(other, {})).toBe(true); // 非本族恒 true
    const pending = pendingAuthorProfilePatchResults(messages, { 'author-profile:call-2': 'applied' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolCallId).toBe('call-1');
  });

  it('非 author_profile_patch 的 author_profile_update 结果（autoApply 档）→ 无专用卡（auto 已直落），走普通工具卡', () => {
    const msg = toolMessage('m1', [
      { toolCallId: 'call-2', toolName: 'author_profile_update', output: '已记入作者档案', metadata: { ok: true, applied: true } },
    ]);
    const { container } = render(<AgentMessageItem message={msg} />);
    expect(container.querySelector('.diff-side-by-side')).toBeNull();
    expect(container.querySelector('.agent-diff-card')).toBeNull();
  });
});

describe('accept / reject 闭环', () => {
  it('accept → applyAuthorProfileNote IPC 收 {note}（无 stale after 载荷）；成功后 resolved（按钮消失 + Applied 徽标）', async () => {
    const result = {
      toolCallId: 'call-1',
      toolName: 'author_profile_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    const { container } = render(<AuthorProfilePatchCard result={result} />);
    await userEvent.click(screen.getByText('Accept'));

    expect(applyIpc).toHaveBeenCalledTimes(1);
    expect(applyIpc).toHaveBeenCalledWith({ note: patchMetadata().note });
    expect(screen.queryByText('Accept')).toBeNull();
    expect(screen.queryByText('Reject')).toBeNull();
    expect(container.textContent).toContain('Applied');
  });

  it('accept 失败（ok:false）→ toast + 卡保持可操作（可重试或 reject）', async () => {
    applyIpc.mockResolvedValue({ ok: false, reason: 'EACCES: permission denied' });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    const result = {
      toolCallId: 'call-1',
      toolName: 'author_profile_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    render(<AuthorProfilePatchCard result={result} />);
    await userEvent.click(screen.getByText('Accept'));

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(String(showToast.mock.calls[0]?.[0])).toContain('EACCES');
    expect(screen.getByText('Accept')).toBeTruthy(); // 仍可操作
    expect(useAppStore.getState().resolvedAuthorProfilePatches).toEqual({});
  });

  it('reject → 纯本地 resolve，IPC 不调（suggest 档从未写盘）；徽标显 Discarded 非 Applied（CR-08-16-007）', async () => {
    const result = {
      toolCallId: 'call-1',
      toolName: 'author_profile_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    const { container } = render(<AuthorProfilePatchCard result={result} />);
    await userEvent.click(screen.getByText('Reject'));

    expect(applyIpc).not.toHaveBeenCalled();
    expect(useAppStore.getState().resolvedAuthorProfilePatches['author-profile:call-1']).toBe('rejected');
    expect(screen.queryByText('Reject')).toBeNull();
    expect(container.textContent).toContain('Discarded');
    expect(container.textContent).not.toContain('Applied');
  });

  it('项目 run 在途 → accept 禁用，reject 不受限（busy 在途才互斥）', () => {
    useAppStore.setState({ agentRunStates: { 'sess-run': { sessionId: 'sess-run', phase: 'running', updatedAt: 1 } } } as any);
    const result = {
      toolCallId: 'call-1',
      toolName: 'author_profile_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    render(<AuthorProfilePatchCard result={result} />);
    expect((screen.getByText('Accept') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Reject') as HTMLButtonElement).disabled).toBe(false);
  });

  it('accept IPC 在途（busy）→ reject 禁用（CR-08-16-105：防「已丢弃」后档案仍被写入）', async () => {
    let release!: (v: { ok: true; filePath: string }) => void;
    applyIpc.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const result = {
      toolCallId: 'call-1',
      toolName: 'author_profile_update',
      output: 'prepared',
      metadata: patchMetadata(),
    };
    render(<AuthorProfilePatchCard result={result} />);
    await userEvent.click(screen.getByText('Accept'));
    expect((screen.getByText('Reject') as HTMLButtonElement).disabled).toBe(true);
    release({ ok: true, filePath: 'C:/Users/author/.orison/author_profile.md' });
    await waitFor(() => {
      expect(useAppStore.getState().resolvedAuthorProfilePatches['author-profile:call-1']).toBe('applied');
    });
  });

  it('两卡不同 toolCallId → 各自独立 resolve（互不影响）', async () => {
    const result1 = {
      toolCallId: 'call-1',
      toolName: 'author_profile_update',
      output: 'a',
      metadata: patchMetadata(),
    };
    const result2 = {
      toolCallId: 'call-2',
      toolName: 'author_profile_update',
      output: 'b',
      metadata: patchMetadata(),
    };
    const { container } = render(
      <div>
        <AuthorProfilePatchCard result={result1} />
        <AuthorProfilePatchCard result={result2} />
      </div>,
    );
    expect(container.querySelectorAll('.diff-side-by-side')).toHaveLength(2);
    await userEvent.click(screen.getAllByText('Reject')[0]);
    expect(screen.getAllByText('Accept')).toHaveLength(1);
  });
});
