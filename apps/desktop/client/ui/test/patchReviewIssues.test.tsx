/**
 * Story 3.7 #1（WP3 / design D4）：PatchReviewIssues——3.3 线 A 议题区 extract 成独立组件，
 * per-issue 换 InsightCard（应用=发对话消息 / 忽略=会话内隐藏 / 展开=suggestion+targets+跳时间线
 * +应用并补充）。汇总头保持数据真相（summarizeIssues 语义，已忽略条目不排除）。
 *
 * dismissInsight/presetDraft 用真实 slice action（jsdom 内真跑 store 更新 → 重渲染隐藏断言）；
 * sendAgentMessage/setFocusIssueTargets/setActivePage 注入 vi.fn（mirror PatchReviewPanel.test 先例，
 * 断言转发非 slice 语义）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchReviewIssues } from '../src/features/agent-panel/PatchReviewIssues';
import { useAppStore } from '../src/shared/store/appStore';
import { insightDismissKey } from '../src/shared/store/insightInteractionSlice';
import type { SceneGraphIssue } from '@orison/shared-contracts';

const issueError: SceneGraphIssue = {
  code: 'causal-cycle',
  severity: 'error',
  message: '线 A 与线 B 互为因果，形成环',
  targets: [{ kind: 'node', id: 'node-3' }, { kind: 'line', id: 'line-a' }],
  suggestion: '断开 node-3 → node-7 的边',
};
const issueWarning: SceneGraphIssue = {
  code: 'unreachable-line',
  severity: 'warning',
  message: '线 C 汇聚目标不可达',
  targets: [{ kind: 'edge', id: 'edge-12' }],
};
const issueInfo: SceneGraphIssue = {
  code: 'future-new-rule',
  severity: 'info',
  message: '某条 info 级提示',
  targets: [],
};

const stubPatch = { runId: 'run-pi', createdAt: '2026-08-01T00:00:00Z', patches: [] } as any;

describe('Story 3.7 #1 — PatchReviewIssues（议题区 extract + InsightCard 化）', () => {
  let sendAgentMessage: ReturnType<typeof vi.fn>;
  let setFocusIssueTargets: ReturnType<typeof vi.fn>;
  let setActivePage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendAgentMessage = vi.fn();
    setFocusIssueTargets = vi.fn();
    setActivePage = vi.fn();
    useAppStore.setState({
      resolvedLocale: 'en-US',
            dismissed: {},
      draftPreset: null,
      activeSessionRunning: false,
      agentRunStates: {},
      sendAgentMessage,
      setFocusIssueTargets,
      setActivePage,
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('无 issues → 组件 null（自守卫）', () => {
    const { container } = render(<PatchReviewIssues />);
    expect(container.querySelector('.patch-review-issues-section')).toBeNull();
  });

  it('per-issue InsightCard：title verbatim / severity 三档 class / dimension 词表标签 / 汇总头计数', () => {
    useAppStore.setState({
      agentSessionId: 'sess-pi',
      pendingPatchBySession: { 'sess-pi': { patch: stubPatch, issues: [issueError, issueWarning, issueInfo] } },
    } as any);

    const { container } = render(<PatchReviewIssues />);

    const cards = container.querySelectorAll('.insight-card');
    expect(cards.length).toBe(3);
    // severity 三档 → insight-card--${sev}（结构 issue 三档原样，不经 toInsightSeverity 变换）。
    expect(cards[0].className).toContain('insight-card--error');
    expect(cards[1].className).toContain('insight-card--warning');
    expect(cards[2].className).toContain('insight-card--info');
    // title = issue.message verbatim（ValidationOverlay 既有约定）。
    expect(screen.getByText('线 A 与线 B 互为因果，形成环')).toBeTruthy();
    // dimension = insightCodeLabel：词表内（causal-cycle）显标签，词表外（future-new-rule）显原文。
    expect(screen.getByText('Causal cycle')).toBeTruthy();
    expect(screen.getByText('future-new-rule')).toBeTruthy();
    // source badge。
    expect(screen.getAllByText('Structure check').length).toBe(3);
    // 汇总头三档计数（数据真相）。
    expect(container.querySelector('.patch-review-severity-count--error')?.textContent).toBe('1');
    expect(container.querySelector('.patch-review-severity-count--warning')?.textContent).toBe('1');
    expect(container.querySelector('.patch-review-severity-count--info')?.textContent).toBe('1');
  });

  it('应用（有 suggestion）→ sendAgentMessage 带 message+suggestion 全文（单击直发，递条子非传话）', async () => {
    useAppStore.setState({ agentSessionId: 'sess-pi', pendingPatchBySession: { 'sess-pi': { patch: stubPatch, issues: [issueError] } } } as any);
    render(<PatchReviewIssues />);

    await userEvent.click(screen.getByText('Apply'));
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage).toHaveBeenCalledWith(
      'Please fix this structural issue: 线 A 与线 B 互为因果，形成环 (suggested direction: 断开 node-3 → node-7 的边)',
    );
  });

  it('应用（无 suggestion）→ 走无 suggestion 模板', async () => {
    useAppStore.setState({ agentSessionId: 'sess-pi', pendingPatchBySession: { 'sess-pi': { patch: stubPatch, issues: [issueWarning] } } } as any);
    render(<PatchReviewIssues />);

    await userEvent.click(screen.getByText('Apply'));
    expect(sendAgentMessage).toHaveBeenCalledWith('Please fix this structural issue: 线 C 汇聚目标不可达');
  });

  it('项目 run 在途 → 应用按钮禁用、忽略不受限（D11 / r8 三分：isProjectRunActive 语义）', () => {
    useAppStore.setState({
      agentSessionId: 'sess-pi',
      pendingPatchBySession: { 'sess-pi': { patch: stubPatch, issues: [issueError] } },
      agentRunStates: { 'sess-run': { sessionId: 'sess-run', phase: 'running', updatedAt: 1 } },
    } as any);
    render(<PatchReviewIssues />);

    expect((screen.getByText('Apply') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Ignore') as HTMLButtonElement).disabled).toBe(false);
  });

  it('忽略 → 该卡消失；汇总头计数保持数据真相；全部忽略 → 组件整体 null', async () => {
    useAppStore.setState({ agentSessionId: 'sess-pi', pendingPatchBySession: { 'sess-pi': { patch: stubPatch, issues: [issueError, issueWarning] } } } as any);
    const { container } = render(<PatchReviewIssues />);
    expect(container.querySelectorAll('.insight-card').length).toBe(2);

    // 忽略第一条（真实 slice action → store 更新 → 重渲染）。
    await userEvent.click(screen.getAllByText('Ignore')[0]);
    expect(container.querySelectorAll('.insight-card').length).toBe(1);
    expect(screen.queryByText('线 A 与线 B 互为因果，形成环')).toBeNull();
    // 汇总头 = 数据真相：已忽略条目仍计数（error 1 / warning 1）。
    expect(container.querySelector('.patch-review-severity-count--error')?.textContent).toBe('1');
    expect(container.querySelector('.patch-review-severity-count--warning')?.textContent).toBe('1');

    // 忽略第二条 → 组件整体 null。
    await userEvent.click(screen.getByText('Ignore'));
    expect(container.querySelector('.patch-review-issues-section')).toBeNull();
  });

  it('展开态 children：suggestion（→ 前缀）+ targets 列表 + 跳时间线 + 应用并补充（D3 预填）', async () => {
    useAppStore.setState({ agentSessionId: 'sess-pi', pendingPatchBySession: { 'sess-pi': { patch: stubPatch, issues: [issueError] } } } as any);
    render(<PatchReviewIssues />);

    await userEvent.click(screen.getByText('Expand'));

    // suggestion 既有呈现（→ 前缀）保留在展开态。
    expect(screen.getByText(/断开 node-3 → node-7 的边/)).toBeTruthy();
    // targets 列表（kind:id 原样）。
    expect(screen.getByText('node:node-3')).toBeTruthy();
    expect(screen.getByText('line:line-a')).toBeTruthy();

    // 跳时间线（3.3 原逻辑 per-issue：该 issue 的 targets + 切 structure 页）。
    await userEvent.click(screen.getByText('Fix in timeline'));
    expect(setFocusIssueTargets).toHaveBeenCalledWith(issueError.targets);
    expect(setActivePage).toHaveBeenCalledWith('structure');

    // 应用并补充 → presetDraft 预填（不直发；sendAgentMessage 零调用）。
    await userEvent.click(screen.getByText('Apply with notes'));
    expect(useAppStore.getState().draftPreset).toBe(
      'Please fix this structural issue: 线 A 与线 B 互为因果，形成环 (suggested direction: 断开 node-3 → node-7 的边)\nAdditional notes: ',
    );
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it('应用并补充（无 suggestion）→ 无 suggestion 预填模板', async () => {
    useAppStore.setState({ agentSessionId: 'sess-pi', pendingPatchBySession: { 'sess-pi': { patch: stubPatch, issues: [issueWarning] } } } as any);
    render(<PatchReviewIssues />);

    await userEvent.click(screen.getByText('Expand'));
    await userEvent.click(screen.getByText('Apply with notes'));
    expect(useAppStore.getState().draftPreset).toBe(
      'Please fix this structural issue: 线 C 汇聚目标不可达\nAdditional notes: ',
    );
  });

  it('已忽略 key 经 insightDismissKey(source i18n key, message) 判定（locale 无关身份键）', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pi': { patch: stubPatch, issues: [issueError] } },
      dismissed: { [insightDismissKey('agent.insight.sourceStructure', issueError.message)]: true },
    } as any);

    const { container } = render(<PatchReviewIssues />);
    // 已忽略 → 全部隐藏 → 组件 null。
    expect(container.querySelector('.patch-review-issues-section')).toBeNull();
  });
});
