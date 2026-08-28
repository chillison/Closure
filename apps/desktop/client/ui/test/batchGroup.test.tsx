import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BatchGroup } from '../src/features/agent-panel/BatchGroup';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 8：<BatchGroup>——默认折叠 + header 机械进度行（n/N 场 · 当前场 ·
// 档位徽章，从最近 batch toolResult.metadata 派生）；无 metadata 降级消息计数；
// 咨询停问可见性（leader 停下时折叠组下方露出尾消息）。
// ─────────────────────────────────────────────────────────────────────────────

function msg(partial: Partial<AgentMessage> & { role: AgentMessage['role'] }): AgentMessage {
  return { id: partial.id ?? Math.random().toString(36).slice(2), content: '', createdAt: 1, ...partial } as AgentMessage;
}

const batchFixture = {
  batchId: 'b-1',
  createdAt: 1,
  orderedSceneIds: ['s1', 's2', 's3'],
  doneSceneIds: ['s1'],
  gear: 'smart',
  status: 'running',
  chapterMap: { s1: 'c1', s2: 'c1', s3: 'c2' },
};

function batchToolMessage(id: string, metadata: unknown): AgentMessage {
  return msg({
    id,
    role: 'tool',
    content: '',
    batchId: 'b-1',
    batchKind: 'progress',
    toolResults: [{ toolCallId: 'c1', toolName: 'batch_status', output: 'status ok', metadata }],
  });
}

const progressMessages: AgentMessage[] = [
  batchToolMessage('t1', { type: 'batch_status', batch: batchFixture }),
  msg({ id: 'a1', role: 'tool', content: '', batchId: 'b-1', batchKind: 'progress', toolResults: [{ toolCallId: 'c2', toolName: 'write_chapter', output: 'chapter done' }] }),
];

describe('Story 3.5 — BatchGroup（默认折叠 + 机械进度行）', () => {
  beforeEach(() => {
    useAppStore.setState({
      resolvedLocale: 'en-US',
      agentBatchExpanded: {},
      activeSessionRunning: false,
      agentRunStates: {},
    } as any);
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ agentBatchExpanded: {} } as any);
  });

  it('header 从最近 batch metadata 派生进度行（n/N · 当前场 · 档位徽章），body 默认折叠', () => {
    render(<BatchGroup batchId="b-1" messages={progressMessages} isLastOverall={false} agentLoading={false} />);

    expect(screen.getByText('1/3 scenes')).toBeTruthy();
    expect(screen.getByText('Now: s2')).toBeTruthy();
    expect(screen.getByText('Smart')).toBeTruthy();
    // 折叠：组内消息不可见。
    expect(screen.queryByText('chapter done')).toBeNull();
  });

  it('点击 header 展开 → body 嵌套渲染组内消息（复用既有渲染路径）', async () => {
    const { container } = render(<BatchGroup batchId="b-1" messages={progressMessages} isLastOverall={false} agentLoading={false} />);
    await userEvent.click(container.querySelector('.agent-batch-group-header')!);

    expect(screen.getByText('chapter done')).toBeTruthy();
    expect(useAppStore.getState().agentBatchExpanded['b-1']).toBe(true);
  });

  it('无 metadata → 降级为消息计数（不显示 N，不编造）', () => {
    const plain = [
      msg({ id: 'a1', role: 'assistant', content: '通报', batchId: 'b-2', batchKind: 'progress' }),
      msg({ id: 'a2', role: 'assistant', content: '推进', batchId: 'b-2', batchKind: 'progress' }),
    ];
    render(<BatchGroup batchId="b-2" messages={plain} isLastOverall={false} agentLoading={false} />);

    expect(screen.getByText('2 messages')).toBeTruthy();
    expect(screen.queryByText(/scenes/)).toBeNull();
  });

  it('坏 metadata（schema 不过）→ graceful 降级，不崩渲染', () => {
    const malformed = [batchToolMessage('t1', { type: 'batch_status', batch: { batchId: 'x' } })];
    render(<BatchGroup batchId="b-1" messages={malformed} isLastOverall={false} agentLoading={false} />);
    expect(screen.getByText('1 messages')).toBeTruthy();
  });

  it('咨询可见性：折叠 + 组含末尾消息 + leader 停下 → 尾消息露出在组下方', () => {
    const withTail = [
      ...progressMessages,
      msg({ id: 'q1', role: 'user', content: '重点场要怎么写？', batchId: 'b-1', batchKind: 'progress' }),
    ];
    render(<BatchGroup batchId="b-1" messages={withTail} isLastOverall agentLoading={false} />);

    // body 折叠但尾消息（turn break 的咨询）可见。
    expect(screen.getByText('重点场要怎么写？')).toBeTruthy();
  });

  it('streaming 中（agentLoading）→ 尾消息不露出（进度行为主，杀刷屏）', () => {
    const withTail = [
      ...progressMessages,
      msg({ id: 'q1', role: 'user', content: '重点场要怎么写？', batchId: 'b-1', batchKind: 'progress' }),
    ];
    render(<BatchGroup batchId="b-1" messages={withTail} isLastOverall agentLoading />);

    expect(screen.queryByText('重点场要怎么写？')).toBeNull();
  });

  it('展开后尾消息在 body 内渲染，不重复露出', async () => {
    const withTail = [
      ...progressMessages,
      msg({ id: 'q1', role: 'user', content: '重点场要怎么写？', batchId: 'b-1', batchKind: 'progress' }),
    ];
    const { container } = render(<BatchGroup batchId="b-1" messages={withTail} isLastOverall agentLoading={false} />);
    await userEvent.click(container.querySelector('.agent-batch-group-header')!);

    const occurrences = screen.getAllByText('重点场要怎么写？');
    expect(occurrences).toHaveLength(1);
  });

  it('组非末尾（isLastOverall=false）→ 尾消息不露出', () => {
    const withTail = [
      ...progressMessages,
      msg({ id: 'q1', role: 'user', content: '重点场要怎么写？', batchId: 'b-1', batchKind: 'progress' }),
    ];
    render(<BatchGroup batchId="b-1" messages={withTail} isLastOverall={false} agentLoading={false} />);
    expect(screen.queryByText('重点场要怎么写？')).toBeNull();
  });

  it('doneSceneIds 非前缀（乱序落盘）→ 当前场 = 拓扑序首个未完成场（非按 done 数取下标）', () => {
    // leader 可乱序落章：s3 已完成（done=1）但 s1/s2 未写。当前场必须是 s1，
    // 不是 orderedSceneIds[1]='s2'（按计数取下标会指错）。
    const gapped = [
      batchToolMessage('t1', {
        type: 'batch_status',
        batch: { ...batchFixture, doneSceneIds: ['s3'] },
      }),
    ];
    render(<BatchGroup batchId="b-1" messages={gapped} isLastOverall={false} agentLoading={false} />);

    expect(screen.getByText('1/3 scenes')).toBeTruthy();
    expect(screen.getByText('Now: s1')).toBeTruthy();
  });
});
