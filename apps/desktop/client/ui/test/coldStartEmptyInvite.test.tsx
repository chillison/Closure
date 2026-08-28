/**
 * Story 8.6 D13：AgentMessages 空态邀请卡——升级既有 `agent-messages-empty` 呈现位
 * （非新容器，对话即主入口）。
 *
 * 覆盖：空态渲染（标题 + 开放式邀请一句 + 三示例起点 chip）/ 点击 chip =
 * sendAgentMessage(预填文案)（普通用户消息走正常 send 链路，leader 侧靠雷达 no 态识别
 * ——零识别特例）/ 有消息后不再显示 / loading 时不显示（既有条件不变）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

function userMessage(content: string): AgentMessage {
  return { id: `u-${content}`, role: 'user', content, createdAt: Date.now() };
}

let sendSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendSpy = vi.fn();
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    activeSessionRunning: false,
      agentRunStates: {},
    sendAgentMessage: sendSpy,
  } as any);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AgentMessages 空态邀请卡（Story 8.6 D13）', () => {
  it('空会话 + 非 loading → 标题 + 邀请句 + 三示例 chip 渲染', () => {
    const { container } = render(<AgentMessages messages={[]} loading={false} error={null} />);
    const empty = container.querySelector('.agent-messages-empty');
    expect(empty).toBeTruthy();
    expect(screen.getByText('想写点什么？')).toBeTruthy();
    expect(screen.getByText('一句话、一个人物、一个画面都可以——跟我聊聊你想写的故事。')).toBeTruthy();
    expect(screen.getByText('我想到一个人物')).toBeTruthy();
    expect(screen.getByText('我有一个世界观')).toBeTruthy();
    expect(screen.getByText('我想到一个爆点')).toBeTruthy();
  });

  it('点击 chip → sendAgentMessage(预填文案)——普通用户消息走正常 send 链路', async () => {
    render(<AgentMessages messages={[]} loading={false} error={null} />);
    await userEvent.click(screen.getByText('我想到一个人物'));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('我想到一个人物');

    await userEvent.click(screen.getByText('我有一个世界观'));
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenLastCalledWith('我有一个世界观');
  });

  it('有消息后不再显示空态卡（既有条件不变）', () => {
    const { container } = render(
      <AgentMessages messages={[userMessage('我想到一个人物')]} loading={false} error={null} />,
    );
    expect(container.querySelector('.agent-messages-empty')).toBeNull();
    expect(screen.queryByText('想写点什么？')).toBeNull();
  });

  it('loading 时不显示空态卡（既有条件不变）', () => {
    const { container } = render(<AgentMessages messages={[]} loading={true} error={null} />);
    expect(container.querySelector('.agent-messages-empty')).toBeNull();
  });
});
