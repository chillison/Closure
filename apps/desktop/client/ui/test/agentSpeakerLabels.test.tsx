/**
 * dogfood R2 #29：说话者标签分化——绘画/派发并流时 UI 无法区分 Leader 与 Sub Agent
 * （全员「Agent」+ 子代理叠重复徽章）。修后：leader 气泡显 Leader；子代理气泡显
 * 「子代理 · 具体名称」，名称随 locale 翻译（roleLabel 词表，词表外回落原文 id）。
 * 覆盖：标签分化 / 角色名翻译 / 词表外回落 / tool 消息徽章翻译 / 组头翻译。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { roleLabel } from '../src/features/agent-panel/toolMeta';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      // 轻量翻译桩：只翻本测试断言用到的键（真 i18n 加载链由其他测试覆盖）。
      const dict: Record<string, string> = {
        'agent.leader': 'Leader',
        'agent.subAgent': '子代理',
        'agent.childSubagent': '子代理',
        'agent.childSkill': '技能',
        'agent.role.story-planner-agent': '故事规划师',
      };
      if (key in dict) return dict[key];
      return Object.keys(vars ?? {}).length ? key : key;
    },
    tArray: () => [],
    ready: true,
  }),
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

beforeEach(() => {
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    activeSessionRunning: false,
    agentRunStates: {},
    agentSessionId: 'session-1',
    sendAgentMessage: vi.fn(),
    truncateAgentMessages: vi.fn(),
  } as never);
});

afterEach(() => {
  cleanup();
});

describe('说话者标签分化（R2 #29）', () => {
  it('leader 气泡显 Leader；子代理气泡显「子代理 · 具体名称」且不叠重复徽章', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '画一下' }),
      msg({ id: 'a1', role: 'assistant', content: '我来安排。' }),
      msg({ id: 'a2', role: 'assistant', content: '[subagent:story-planner-agent] 结构草案已出' }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    const labels = Array.from(container.querySelectorAll('.agent-msg-label'));
    expect(labels[1]?.textContent).toBe('Leader');
    expect(labels[2]?.textContent).toContain('子代理 · 故事规划师');
    expect(labels[2]?.classList.contains('agent-msg-label--child')).toBe(true);
    // assistant 消息不再叠 ChildBadge（身份并入标签行，去重）。
    expect(container.querySelectorAll('.agent-child-badge')).toHaveLength(0);
  });

  it('词表外角色回落原文 id；skill 来源照常区分', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant', content: '[subagent:researcher] 报告完成' }),
      msg({ id: 'a2', role: 'assistant', content: '[skill:story:d1] 技法步骤完成' }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    const labels = Array.from(container.querySelectorAll('.agent-msg-label'));
    expect(labels[0]?.textContent).toContain('子代理 · researcher');
    // skill 标签的 :d1 是深度标记（parseChildTag 语义）——role = story。
    expect(labels[1]?.textContent).toContain('技能 · story');
  });

  it('tool 消息徽章照旧（无标签行可挂）且角色名经词表翻译', () => {
    const messages = [
      msg({
        id: 't1',
        role: 'tool',
        content: '[subagent:story-planner-agent]',
        toolResults: [{ toolCallId: 'c1', toolName: 'search', output: 'ok' }] as never,
      }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    expect(container.querySelector('.agent-child-badge')?.textContent).toContain('子代理 · 故事规划师');
  });

  it('roleLabel 纯函数：词表内翻译 / 词表外回落', () => {
    const t = (key: string) => (key === 'agent.role.story-planner-agent' ? '故事规划师' : key);
    expect(roleLabel('story-planner-agent', t)).toBe('故事规划师');
    expect(roleLabel('researcher', t)).toBe('researcher');
    // 缺翻译（t 回落键本身）→ 回落原文 id。
    const rawT = (key: string) => key;
    expect(roleLabel('story-planner-agent', rawT)).toBe('story-planner-agent');
  });
});
