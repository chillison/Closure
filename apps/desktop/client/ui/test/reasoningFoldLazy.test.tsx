/**
 * CR-2（dogfood R2 BMad CR，用户拍板 A 方案）：ReasoningFold 默认展开 + 正文懒渲染。
 *
 * 默认展开语义（R2 #23 精化后 = 只有流式中的展开；历史/settle 收起），懒的是**正文
 * 挂载**——reasoning 流可到 MB 级 + 项目切换自动接续拉全量历史，装载即挂几百 KB 文本
 * 节点会卡。视口外历史消息只保留摘要头；进入视口（IntersectionObserver）才挂正文；
 * 流式中的当前消息豁免（即时渲染）。
 *
 * jsdom 无 IntersectionObserver——本文件装可控 mock 驱动视口回调；「无 IO 环境退化为
 * 直接挂载」的兜底路径由既有 agentStreamingUi 测试覆盖（未 mock IO → fallback 全挂，
 * 展开/收起互操作断言不因懒渲染回归）。
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

type IOCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void;

const instances: Array<{ cb: IOCallback; el: Element | null }> = [];

/** 可控 IntersectionObserver mock：捕获回调 + observe 目标，测试手动驱动 isIntersecting。 */
class MockIntersectionObserver {
  cb: IOCallback;
  el: Element | null = null;
  constructor(cb: IOCallback) {
    this.cb = cb;
    instances.push(this);
  }
  observe(el: Element) { this.el = el; }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
  get root() { return null; }
  get rootMargin() { return '200px'; }
  get thresholds() { return [0]; }
}

function fireIntersect(index: number): void {
  const inst = instances[index];
  if (!inst || !inst.el) throw new Error(`no observed target at index ${index}`);
  act(() => {
    inst.cb(
      [{ isIntersecting: true, target: inst.el! } as unknown as IntersectionObserverEntry],
      inst as unknown as IntersectionObserver,
    );
  });
}

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

beforeEach(() => {
  instances.length = 0;
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = MockIntersectionObserver;
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
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  vi.restoreAllMocks();
});

describe('ReasoningFold 正文懒渲染（CR-2 A 方案：默认展开 + 懒渲染）', () => {
  it('视口外历史消息：只挂摘要头，不挂正文（几百 KB 文本节点不随装载挂出）', async () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '写一段' }),
      msg({ id: 'a1', role: 'assistant', content: '正文', reasoning: '很长的思考过程'.repeat(200), streaming: false }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    await act(async () => {});
    // 摘要头在（标题 + 字数）；正文未挂（IO 已 observe、尚未 isIntersecting）。
    expect(container.querySelector('.agent-reasoning')).not.toBeNull();
    expect(container.querySelector('.agent-reasoning-title')?.textContent).toContain('思考过程');
    expect(container.querySelector('.agent-reasoning-body')).toBeNull();
    expect(instances.length).toBe(1); // 该 fold 已注册视口观察
  });

  it('进入视口（IO 回调 isIntersecting）→ 闩锁挂载位；R2 #23 历史块默认收起，点开后正文可见且闩锁不闪卸', async () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '写一段' }),
      msg({ id: 'a1', role: 'assistant', content: '正文', reasoning: '初始思考', streaming: false }),
    ];
    const { container, rerender } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    await act(async () => {});
    expect(container.querySelector('.agent-reasoning-body')).toBeNull();

    fireIntersect(0);
    // R2 #23：历史块（非流式）默认收起——进视口只解锁挂载位，正文仍需点开。
    expect(container.querySelector('.agent-reasoning-header')!.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.agent-reasoning-body')).toBeNull();
    act(() => { fireEvent.click(container.querySelector('.agent-reasoning-header') as HTMLElement); });
    const body = container.querySelector('.agent-reasoning-body') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.textContent).toContain('初始思考');

    // 闩锁：reasoning 增长（重放更长历史）正文保持挂载。
    rerender(<AgentMessages
      messages={[
        messages[0],
        msg({ id: 'a1', role: 'assistant', content: '正文', reasoning: '初始思考+更多', streaming: false }),
      ]}
      loading={false}
      error={null}
    />);
    await act(async () => {});
    expect(container.querySelector('.agent-reasoning-body')?.textContent).toContain('初始思考+更多');
  });

  it('流式中的当前消息豁免：正文即时渲染（不建 IO——必须立即挂）', async () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '写一段' }),
      msg({ id: 'a1', role: 'assistant', content: '', reasoning: '思考流进行中', streaming: true }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={true} error={null} />);
    await act(async () => {});
    // 流式消息：正文直接挂载（无 IO 等待）；无任何视口观察注册。
    const body = container.querySelector('.agent-reasoning-body') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.textContent).toContain('思考流进行中');
    expect(instances.length).toBe(0);
  });
});
