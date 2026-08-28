/**
 * dogfood R2 #12（findings #12，2026-08-25）：子代理产出卡（DispatchDraftCard）拦截路由
 * + 呈现。经 AgentMessages → AgentMessageItem tool 分支全链渲染（真实拦截位次序）：
 * - 三派发工具 ok:true 命中 → 产出卡（默认展开 + 产出类型徽标 + MD 正文），不走 AgentToolCard；
 * - ok:false（错误/空草案/降级提示）不拦截 → 照走 AgentToolCard（不能被误当草案）；
 * - 其他工具不拦截（零回归）；
 * - 用户可收起（Collapsible defaultOpen 可交互）。
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

function toolMessage(toolName: string, output: string, metadata: unknown): AgentMessage[] {
  return [
    msg({ id: 'u1', role: 'user', content: '派规划员' }),
    msg({
      id: 't1',
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: 'c1', toolName, output, metadata }],
    }),
  ];
}

beforeEach(() => {
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    activeSessionRunning: false,
    agentRunStates: {},
    agentSessionId: 'session-1',
    sendAgentMessage: vi.fn(),
    truncateAgentMessages: vi.fn(),
  } as any);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('拦截路由三分支（AgentMessageItem tool 分支，R2 #12）', () => {
  it.each([
    ['dispatch_story_planner', '大纲草案'],
    ['dispatch_episode_planner', '分集草案'],
    ['dispatch_researcher', '调研报告'],
  ])('%s ok:true → 产出卡（默认展开 + 徽标 + MD 正文），不走 AgentToolCard', (toolName, badge) => {
    const { container } = render(
      <AgentMessages
        messages={toolMessage(toolName, '# 草案标题\n\n**核心冲突**：测试。', { ok: true })}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-dispatch-draft')).not.toBeNull();
    // 默认展开：body 直接渲染（草案是核心交付物，不能再默认折叠不可见）。
    expect(container.querySelector('.agent-dispatch-draft-body')).not.toBeNull();
    // header：产出类型徽标（i18n）。
    expect(container.querySelector('.agent-dispatch-draft-badge')?.textContent).toBe(badge);
    // body：MD 渲染（h1/strong 结构——非旧 AgentToolCard 的裸 pre）。
    const md = container.querySelector('.agent-dispatch-draft-md') as HTMLElement;
    expect(md.querySelector('h1')?.textContent).toContain('草案标题');
    expect(md.querySelector('strong')?.textContent).toBe('核心冲突');
    // 未走默认工具卡（拦截替换呈现位）。
    expect(container.querySelector('.agent-tool-card')).toBeNull();
  });

  it('ok:false（dispatch failed / 空草案降级提示）不拦截——照走 AgentToolCard', () => {
    const { container } = render(
      <AgentMessages
        messages={toolMessage(
          'dispatch_story_planner',
          '规划员派发失败（timeout）。请重试。',
          { ok: false, reason: 'dispatch-failed' },
        )}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-dispatch-draft')).toBeNull();
    // 错误/降级提示仍由默认工具卡承载（默认折叠，header 承载工具名）。
    const toolCard = container.querySelector('.agent-tool-card') as HTMLElement;
    expect(toolCard).not.toBeNull();
    expect(toolCard.textContent).toContain('派出故事规划师');
  });

  it('无 metadata 的派发结果不拦截（unknown seam 守卫——形态不完整不认草案）', () => {
    const { container } = render(
      <AgentMessages
        messages={toolMessage('dispatch_researcher', '# 报告', undefined)}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-dispatch-draft')).toBeNull();
    expect(container.querySelector('.agent-tool-card')).not.toBeNull();
  });

  it('其他工具不拦截（零回归）', () => {
    const { container } = render(
      <AgentMessages
        messages={toolMessage('query_mentions', '查询完成', { ok: true })}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-dispatch-draft')).toBeNull();
    expect(container.querySelector('.agent-tool-card')).not.toBeNull();
  });

  it('用户可收起（defaultOpen 可交互——长草案不想看时）', async () => {
    const { container } = render(
      <AgentMessages
        messages={toolMessage('dispatch_story_planner', '# 草案', { ok: true })}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-dispatch-draft-body')).not.toBeNull();
    fireEvent.click(container.querySelector('.agent-dispatch-draft-header') as HTMLElement);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.agent-dispatch-draft-body')).toBeNull();
  });
});

describe('D1 footer 跳转钮（大纲草案卡「到大纲面板查看」）', () => {
  let setActivePage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePage = vi.fn();
    useAppStore.setState({ setActivePage } as any);
  });

  it('dispatch_story_planner 卡有 footer 钮，点击 setActivePage(outline)；不带焦点', () => {
    const { container } = render(
      <AgentMessages
        messages={toolMessage('dispatch_story_planner', '# 大纲草案', { ok: true })}
        loading={false}
        error={null}
      />,
    );
    const jump = container.querySelector('.agent-dispatch-draft-jump') as HTMLButtonElement;
    expect(jump).toBeTruthy();
    expect(jump.textContent).toBe('到大纲面板查看 →');
    fireEvent.click(jump);
    expect(setActivePage).toHaveBeenCalledWith('outline');
    // 草案期结构未落盘——不带 outlineFocusTarget（焦点由 patch 审查落盘路径负责）。
    expect(useAppStore.getState().outlineFocusTarget).toBeNull();
  });

  it.each(['dispatch_episode_planner', 'dispatch_researcher'])('%s 卡无 footer 钮（仅大纲草案）', (toolName) => {
    const { container } = render(
      <AgentMessages
        messages={toolMessage(toolName, '# 草案', { ok: true })}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-dispatch-draft-jump')).toBeNull();
  });
});
