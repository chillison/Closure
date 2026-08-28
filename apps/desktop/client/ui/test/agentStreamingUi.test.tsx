/**
 * dogfood T1 Stage 4（design §6.2/§6.5/§7.1/§7.2）：leader 流式呈现的组件面。
 *
 * 覆盖（implement.md Stage 4 测试清单）：
 * - stick-to-bottom 触发：同 length 的 content 增长（delta 更新同一条消息）也触发跟随滚动；
 *   离底远（>120px）不触发（既有闸门行为不回退）。dogfood R2 #11②：reasoning 增长同样计数。
 * - 流式占位渲染：空 content 三点 loading（生成中容器态）；有 content 走 MD 快照轨 +
 *   `agent-msg-md--streaming` caret class；全局三点与流式占位让位（不双指示）。
 * - reasoning 折叠块：R2 #11① 默认展开 / 收起互操作 / 流式 shimmer 态 / 非流式无 shimmer /
 *   R2 #11② 内层贴底跟随（上翻不抢、滚回恢复）。
 * - 重试动作：错误条重试钮 = 重发末条 user 消息（sendAgentMessage 复用）。
 * - typewriter 零回归：非流式新到最新 assistant 消息照旧走打字机（跳过钮「跳过」出现）；
 *   R2 #11⑤ 流式直出钮挪到输入行（消息体无任何 skip 钮）。
 * - BMad CR 组4（#50 追补）：会话切换跳底为有限帧 rAF 循环（晚 settle 多帧跟到底 /
 *   settle 提前收工 / ≤15 帧上限自停 / 卸载清挂起帧）。
 *
 * jsdom 无布局——scrollHeight/clientHeight 定值 + scrollIntoView prototype mock。
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

let scrollIntoView: ReturnType<typeof vi.fn>;
let originalScrollIntoView: unknown;

function instrumentContainer(scrollHeight: number, clientHeight: number): HTMLElement {
  const el = document.querySelector('.agent-messages') as HTMLElement;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => 0, set: () => {} });
  return el;
}

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

beforeEach(() => {
  scrollIntoView = vi.fn();
  // setup.ts 在 HTMLElement.prototype 装了 no-op scrollIntoView（jsdom 未实现）——mock
  // 必须盖在同一层（Element.prototype 会被其遮蔽），afterEach 还原。
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView;
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
  (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = originalScrollIntoView;
  vi.restoreAllMocks();
});

describe('stick-to-bottom 触发（delta 更新同一条消息，length 不变）', () => {
  it('离底 <120px 时：同 length 的 content 增长也触发跟随滚动', () => {
    const base = [
      msg({ id: 'u1', role: 'user', content: '写一段' }),
      msg({ id: 'a1', role: 'assistant', content: 'a'.repeat(10), streaming: true }),
    ];
    const { rerender } = render(<AgentMessages messages={base} loading={false} error={null} />);
    instrumentContainer(1000, 900); // distance = 100 < 120
    expect(scrollIntoView).toHaveBeenCalledTimes(1); // 挂载首轮

    // delta flush：同一条消息 content 变长（messages.length 不变）——旧依赖数组不触发，
    // Stage 4 补的「最后一条消息 content 长度」进依赖后触发。
    rerender(<AgentMessages
      messages={[base[0], msg({ id: 'a1', role: 'assistant', content: 'a'.repeat(60), streaming: true })]}
      loading={false}
      error={null}
    />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  // ── dogfood T1 CR-T1-044：跟随口径统一为全表扫 streaming 游标 ──

  it('并行 spawn_agent 双占位：**非末条** streaming 增长同样触发跟随（全表扫口径）', () => {
    const base = [
      msg({ id: 'a1', role: 'assistant', content: 'a'.repeat(10), streaming: true }), // 并行占位一（非末条）
      msg({ id: 'a2', role: 'assistant', content: 'b'.repeat(10), streaming: true }), // 并行占位二（末条）
    ];
    const { rerender } = render(<AgentMessages messages={base} loading={false} error={null} />);
    instrumentContainer(1000, 900);
    const baseline = scrollIntoView.mock.calls.length;

    // 末条 content 不变，只有非末条 a1 增长——旧「末条 content 长度」口径不触发。
    rerender(<AgentMessages
      messages={[
        msg({ id: 'a1', role: 'assistant', content: 'a'.repeat(80), streaming: true }),
        base[1],
      ]}
      loading={false}
      error={null}
    />);
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(baseline);
  });

  it('空占位出现/消失本身是跟随事件（游标 +1 计数，不依赖 content 非空）', () => {
    const base = [msg({ id: 'u1', role: 'user', content: '写' })];
    const { rerender } = render(<AgentMessages messages={base} loading={false} error={null} />);
    instrumentContainer(1000, 900);
    const baseline = scrollIntoView.mock.calls.length;

    rerender(<AgentMessages
      messages={[base[0], msg({ id: 'a1', role: 'assistant', content: '', streaming: true })]}
      loading={false}
      error={null}
    />);
    expect(scrollIntoView.mock.calls.length).toBe(baseline + 1);
  });

  // ── dogfood R2 #11②（findings #11② 外层）：reasoning 增长同样触发面板跟随 ──

  it('R2 #11②：content 不变、只有 reasoning 增长也触发跟随（折叠块默认展开后顶高视口）', () => {
    const base = [
      msg({ id: 'u1', role: 'user', content: '写一段' }),
      msg({ id: 'a1', role: 'assistant', content: 'a'.repeat(10), reasoning: 'r'.repeat(10), streaming: true }),
    ];
    const { rerender } = render(<AgentMessages messages={base} loading={false} error={null} />);
    instrumentContainer(1000, 900);
    const baseline = scrollIntoView.mock.calls.length;

    // 旧口径只计 content.length——reasoning 增长不触发跟随（思考流默认展开后被顶出视口）。
    rerender(<AgentMessages
      messages={[base[0], msg({ id: 'a1', role: 'assistant', content: 'a'.repeat(10), reasoning: 'r'.repeat(80), streaming: true })]}
      loading={false}
      error={null}
    />);
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(baseline);
  });

  it('离底远（>120px）不跟随——既有闸门行为不回退', () => {
    const base = [
      msg({ id: 'u1', role: 'user', content: '写一段' }),
      msg({ id: 'a1', role: 'assistant', content: 'a'.repeat(10), streaming: true }),
    ];
    const { rerender } = render(<AgentMessages messages={base} loading={false} error={null} />);
    instrumentContainer(5000, 400); // distance = 4600 > 120
    // 挂载轮在读数装配前以 jsdom 默认（distance 0）跑过一次——以此为基线，断言
    // content 增长后**不新增**跟随调用（离底远闸门不因 Stage 4 新依赖回退）。
    const baseline = scrollIntoView.mock.calls.length;

    rerender(<AgentMessages
      messages={[base[0], msg({ id: 'a1', role: 'assistant', content: 'a'.repeat(60), streaming: true })]}
      loading={false}
      error={null}
    />);
    expect(scrollIntoView.mock.calls.length).toBe(baseline);
  });
});

describe('流式占位渲染（生成中容器态 + caret class）', () => {
  it('空 content：占位内三点 loading（首正文 delta 前无空窗）；全局三点让位', async () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '写一段' }),
      msg({ id: 'a1', role: 'assistant', content: '', streaming: true }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={true} error={null} />);
    // 占位消息内三点（复用既有 loading 样式类）。
    expect(container.querySelector('.agent-msg .agent-message-loading')).not.toBeNull();
    // 全局三点让位（loading=true 但已有流式占位——同屏双指示冗余）。
    expect(container.querySelectorAll('.agent-messages > .agent-message-loading')).toHaveLength(0);
  });

  it('有 content：走 250ms MD 快照轨 + streaming caret class；无 content 时无 caret', async () => {
    const streamingMsg = msg({ id: 'a1', role: 'assistant', content: '部分正文内容', streaming: true });
    const { container, rerender } = render(
      <AgentMessages messages={[msg({ id: 'u1', role: 'user', content: '写' }), streamingMsg]} loading={true} error={null} />,
    );
    await act(async () => {});
    // 快照轨产出 MD HTML + streaming class（caret 由 CSS ::after 挂在最后一个块级子元素）。
    const md = container.querySelector('.agent-msg-md--streaming') as HTMLElement;
    expect(md).not.toBeNull();
    expect(md.textContent).toContain('部分正文内容');
    // 三点消失（已有正文）。
    expect(container.querySelector('.agent-msg .agent-message-loading')).toBeNull();

    // 终帧 streaming:false → caret class 移除（renderedHtml 收敛，排版零跳变）。
    rerender(<AgentMessages
      messages={[
        msg({ id: 'u1', role: 'user', content: '写' }),
        msg({ id: 'a1', role: 'assistant', content: '部分正文内容', streaming: false }),
      ]}
      loading={false}
      error={null}
    />);
    await act(async () => {});
    expect(container.querySelector('.agent-msg-md--streaming')).toBeNull();
    expect(container.querySelector('.agent-msg-md')?.textContent).toContain('部分正文内容');
  });

  // ── dogfood T1 CR-T1-043 + R2 #11⑤：「直出」激活后持续直出（不节流）──
  // R2 #11⑤：直出钮从消息正文底部挪到输入行（AgentInput），激活路径改为 store 跨组件
  // 信号 streamRevealTick（AgentMessageItem effect 消费）——本测试直接驱动 store action
  // （AgentInput 钮的 onClick 即此 action，组件面在 AgentInput 测试域）。

  it('CR-T1-043 / R2 #11⑤：直出信号后每次 flush 落地立即渲染（不等下一 250ms interval tick）', async () => {
    const { container, rerender } = render(
      <AgentMessages
        messages={[msg({ id: 'u1', role: 'user', content: '写' }), msg({ id: 'a1', role: 'assistant', content: '第一段正文。', streaming: true })]}
        loading={true}
        error={null}
      />,
    );
    await act(async () => {});
    // 消息体已无直出钮（R2 #11⑤ 挪走）。
    expect(container.querySelector('.agent-typewriter-skip')).toBeNull();
    act(() => { useAppStore.getState().requestStreamReveal(); });
    await act(async () => {});
    expect(container.querySelector('.agent-msg-md--streaming')?.textContent).toContain('第一段正文。');

    // flush 落地（新 content）——直出激活期间应**立即**进渲染（渐进轨 displayLen 恒贴
    // target + 头部快照即时对齐；旧实现只提前 ≤250ms 一次快照，此后照旧等 interval tick）。
    rerender(
      <AgentMessages
        messages={[msg({ id: 'u1', role: 'user', content: '写' }), msg({ id: 'a1', role: 'assistant', content: '第一段正文。第二段也到了。', streaming: true })]}
        loading={true}
        error={null}
      />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-msg-md--streaming')?.textContent).toContain('第二段也到了');
  });

  it('R2 #11⑤：直出信号只影响正在流式的消息（非流式消息零反应）', async () => {
    // 末条为 user 使 assistant 非最新——不进打字机（renderedHtml 立即渲染，断言不依赖动画时钟）。
    const messages = [
      msg({ id: 'u1', role: 'user', content: '写' }),
      msg({ id: 'a1', role: 'assistant', content: '已是终帧的正文。', streaming: false }),
      msg({ id: 'u2', role: 'user', content: '继续' }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    await act(async () => {});
    expect(container.querySelector('.agent-msg-md')?.textContent).toContain('已是终帧的正文。');
    act(() => { useAppStore.getState().requestStreamReveal(); });
    await act(async () => {});
    // 非流式消息无轨可拉：内容原样、无 streaming class。
    expect(container.querySelector('.agent-msg-md')?.textContent).toContain('已是终帧的正文。');
    expect(container.querySelector('.agent-msg-md--streaming')).toBeNull();
  });
});

describe('reasoning 折叠块（#27② + R2 #11①②）', () => {
  function reasoningMsg(streaming: boolean, reasoning = '深度思考内容全文'): AgentMessage {
    return msg({
      id: 'a1',
      role: 'assistant',
      content: '正文',
      reasoning,
      streaming,
    });
  }

  it('R2 #11①：默认展开（旧默认收起被用户否决）；流式期带 shimmer；可收起/再展开', async () => {
    const { container } = render(
      <AgentMessages messages={[msg({ id: 'u1', role: 'user', content: '写' }), reasoningMsg(true)]} loading={true} error={null} />,
    );
    await act(async () => {});
    const fold = container.querySelector('.agent-reasoning') as HTMLElement;
    expect(fold).not.toBeNull();
    // 默认展开：body 直接渲染；流式期 shimmer 活动指示在。
    const body = container.querySelector('.agent-reasoning-body') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.textContent).toContain('深度思考内容全文');
    expect(container.querySelector('.agent-reasoning--streaming .agent-reasoning-shimmer')).not.toBeNull();
    expect(container.textContent).toContain('思考过程');

    // 用户可收起（草案长文不想看时），再点展开。
    fireEvent.click(container.querySelector('.agent-reasoning-header') as HTMLElement);
    await act(async () => {});
    expect(container.querySelector('.agent-reasoning-body')).toBeNull();
    fireEvent.click(container.querySelector('.agent-reasoning-header') as HTMLElement);
    await act(async () => {});
    expect(container.querySelector('.agent-reasoning-body')).not.toBeNull();
  });

  it('非流式（重载会话）：折叠块在、R2 #23 默认收起（点开可见）、无 shimmer', async () => {
    const { container } = render(
      <AgentMessages messages={[msg({ id: 'u1', role: 'user', content: '写' }), reasoningMsg(false)]} loading={false} error={null} />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-reasoning')).not.toBeNull();
    // R2 #23：历史块装载即收起（摘要头在，点开可查）。
    expect(container.querySelector('.agent-reasoning-body')).toBeNull();
    expect(container.querySelector('.agent-reasoning-header')!.getAttribute('aria-expanded')).toBe('false');
    act(() => { fireEvent.click(container.querySelector('.agent-reasoning-header') as HTMLElement); });
    await act(async () => {});
    expect(container.querySelector('.agent-reasoning-body')).not.toBeNull();
    expect(container.querySelector('.agent-reasoning--streaming')).toBeNull();
    expect(container.querySelector('.agent-reasoning-shimmer')).toBeNull();
  });

  it('R2 #23：settle（streaming true→false）自动收起；用户手动开关过则豁免（显式选择优先）', async () => {
    const user = msg({ id: 'u1', role: 'user', content: '写' });
    // ① 未干预：流式中展开 → settle 自动收起。
    const { container, rerender, unmount } = render(
      <AgentMessages messages={[user, reasoningMsg(true)]} loading={true} error={null} />,
    );
    await act(async () => {});
    expect(container.querySelector('.agent-reasoning-body')).not.toBeNull();
    rerender(<AgentMessages messages={[user, reasoningMsg(false)]} loading={false} error={null} />);
    await act(async () => {});
    expect(container.querySelector('.agent-reasoning-body')).toBeNull();
    unmount();

    // ② 手动收起后 settle：保持收起（无操作）。
    const two = render(<AgentMessages messages={[user, reasoningMsg(true)]} loading={true} error={null} />);
    await act(async () => {});
    act(() => { fireEvent.click(two.container.querySelector('.agent-reasoning-header') as HTMLElement); });
    two.rerender(<AgentMessages messages={[user, reasoningMsg(false)]} loading={false} error={null} />);
    await act(async () => {});
    expect(two.container.querySelector('.agent-reasoning-body')).toBeNull();
    two.unmount();

    // ③ 流式中手动收起再点开 → settle 不自动收起（用户显式选择优先于默认策略）。
    const three = render(<AgentMessages messages={[user, reasoningMsg(true)]} loading={true} error={null} />);
    await act(async () => {});
    act(() => { fireEvent.click(three.container.querySelector('.agent-reasoning-header') as HTMLElement); });
    act(() => { fireEvent.click(three.container.querySelector('.agent-reasoning-header') as HTMLElement); });
    three.rerender(<AgentMessages messages={[user, reasoningMsg(false)]} loading={false} error={null} />);
    await act(async () => {});
    expect(three.container.querySelector('.agent-reasoning-body')).not.toBeNull();
  });

  it('R2 #11② 内层：reasoning 增长贴底跟随；用户上翻暂停不抢、滚回底部恢复', async () => {
    // R2 #11④：思考体接平滑出字轨后增长经 rAF 动画到达——手动队列步进帧驱动
    //（mirror useSmoothReveal.test.tsx），测「平滑生长 → 贴底」的真实集成路径。
    // CR-43（dogfood R2 BMad CR）：轨追平后拆 rAF 转 250ms 轮询——同步测试里真
    // interval 永不触发，pumpFrames 需先排空轮询回调（新目标发现 → 重排 rAF）再驱动帧。
    const rafQueue: Array<(t: number) => void> = [];
    let rafNow = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (cb: (t: number) => void) => {
        rafQueue.push(cb);
        return rafQueue.length;
      },
    );
    // 可重复触发的 interval 模型（Map 按 id 存活，clearInterval 移除）——setInterval 的
    // 回调是**反复**触发的，一次性 splice 消费会把「追平后空转的轮询」误当已拆除，后续
    // 新目标无人发现（真实浏览器里同 id interval 一直在跑）。
    const intervals = new Map<number, () => void>();
    let nextIntervalId = 1;
    const setIntSpy = vi.spyOn(window, 'setInterval').mockImplementation(((cb: () => void) => {
      const id = nextIntervalId++;
      intervals.set(id, cb);
      return id;
    }) as unknown as typeof window.setInterval);
    const clearIntSpy = vi.spyOn(window, 'clearInterval').mockImplementation(((id: number) => {
      intervals.delete(id);
    }) as unknown as typeof window.clearInterval);
    const pumpFrames = async (frames: number) => {
      for (let i = 0; i < frames; i++) {
        rafNow += 16;
        await act(async () => {
          for (const cb of [...intervals.values()]) cb(); // 追平后轮询：发现新目标 → 重排 rAF
        });
        const q = rafQueue.splice(0);
        await act(async () => {
          for (const cb of q) cb(rafNow);
        });
      }
    };
    const user = msg({ id: 'u1', role: 'user', content: '写' });
    const { container, rerender } = render(
      <AgentMessages messages={[user, reasoningMsg(true, '思'.repeat(50))]} loading={true} error={null} />,
    );
    await act(async () => {});
    const body = container.querySelector('.agent-reasoning-body') as HTMLElement;
    expect(body).not.toBeNull();
    // jsdom 无布局——实例上装可控 scroll 度量（scrollHeight 500 / clientHeight 100）。
    let scrollTop = 0;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = v; },
    });

    // reasoning 增长 → 平滑轨追平积压（≥1 字/帧，80 帧盖 50 字）→ 贴底（scrollTop = scrollHeight）。
    rerender(<AgentMessages messages={[user, reasoningMsg(true, '思'.repeat(100))]} loading={true} error={null} />);
    await pumpFrames(80);
    expect(scrollTop).toBe(500);

    // 用户上翻（scrollTop=100，距底 300px > 40）→ 跟随暂停（增长不抢滚动）。
    scrollTop = 100;
    fireEvent.scroll(body);
    rerender(<AgentMessages messages={[user, reasoningMsg(true, '思'.repeat(150))]} loading={true} error={null} />);
    await pumpFrames(80);
    expect(scrollTop).toBe(100);

    // 滚回底部（scrollTop=400，距底 0 ≤ 40）→ 恢复跟随。
    scrollTop = 400;
    fireEvent.scroll(body);
    rerender(<AgentMessages messages={[user, reasoningMsg(true, '思'.repeat(200))]} loading={true} error={null} />);
    await pumpFrames(80);
    expect(scrollTop).toBe(500);
    rafSpy.mockRestore();
    setIntSpy.mockRestore();
    clearIntSpy.mockRestore();
  });
});

describe('重试钮（D2：error 呈现处重发末条 user 消息）', () => {
  it('点击重试 → sendAgentMessage(末条 user content)', () => {
    const sendAgentMessage = vi.fn();
    useAppStore.setState({ sendAgentMessage } as any);
    const messages = [
      msg({ id: 'u1', role: 'user', content: '写第一章' }),
      msg({ id: 'a1', role: 'assistant', content: '（中断）', kind: 'aborted_partial' }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error="网关超时" />);
    const retry = container.querySelector('.agent-message-error-retry') as HTMLElement;
    expect(retry).not.toBeNull();
    expect(container.querySelector('.agent-message-error')?.textContent).toContain('网关超时');
    fireEvent.click(retry);
    expect(sendAgentMessage).toHaveBeenCalledWith('写第一章');
  });

  it('无 user 消息时不显重试钮（理论不达——防御）', () => {
    const { container } = render(<AgentMessages messages={[msg({ id: 'a1', role: 'assistant', content: 'x' })]} loading={false} error="err" />);
    expect(container.querySelector('.agent-message-error-retry')).toBeNull();
  });

  // ── dogfood T1 CR-T1-041：合成 user 指令不作重试锚 ──

  it('末条 user 是合成 length 续写指令 → 重试重发更早真人消息（不重发内部指令）', () => {
    const sendAgentMessage = vi.fn();
    useAppStore.setState({ sendAgentMessage } as any);
    const messages = [
      msg({ id: 'u1', role: 'user', content: '写第一章' }),
      msg({ id: 'a1', role: 'assistant', content: '（超长截断）' }),
      msg({ id: 'u2', role: 'user', content: 'Continue from where you left off. Execute the next step using the appropriate tool.' }),
      msg({ id: 'a2', role: 'assistant', content: '（又截断，run 失败）', kind: 'aborted_partial' }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error="网关超时" />);
    fireEvent.click(container.querySelector('.agent-message-error-retry') as HTMLElement);
    expect(sendAgentMessage).toHaveBeenCalledWith('写第一章');
  });

  it('全部 user 均为合成指令 → 不显重试钮（无可重发的真人消息）', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'Continue from where you left off. Execute the next step using the appropriate tool.' }),
      msg({ id: 'a1', role: 'assistant', content: '（失败）' }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error="网关超时" />);
    expect(container.querySelector('.agent-message-error-retry')).toBeNull();
  });
});

describe('typewriter 零回归（历史回放路径不变）', () => {
  it('非流式新到最新 assistant：打字机照旧（「跳过」钮出现——历史回放 skip 钮原位保留）', async () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '你好' }),
      msg({ id: 'a1', role: 'assistant', content: '这是打字机回放的消息' }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    await act(async () => {});
    const skip = container.querySelector('.agent-typewriter-skip') as HTMLElement;
    expect(skip).not.toBeNull();
    expect(skip.textContent).toContain('跳过');
  });

  it('R2 #11⑤：流式消息不进打字机且消息体无任何 skip 钮（直出钮已挪到输入行）', async () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '你好' }),
      msg({ id: 'a1', role: 'assistant', content: '流式正文渐进出现', streaming: true }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={true} error={null} />);
    await act(async () => {});
    // 旧「直出」钮悬在消息正文底部（不可按时常驻残影）——R2 #11⑤ 挪到 AgentInput
    // 输入行（store streamRevealTick 信号），消息体不再渲染任何 skip 钮。
    expect(container.querySelector('.agent-typewriter-skip')).toBeNull();
  });

  it('R2 #50：settledHistory 末条不进打字机（重开项目 autoResume——全量直出，无 skip 钮）', async () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '你好' }),
      msg({ id: 'a1', role: 'assistant', content: '上次会话的末条回答', settledHistory: true }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={false} error={null} />);
    await act(async () => {});
    // 无回放空泡首帧（空泡会打断 AgentMessages 的 [agentSessionId] 跳底量高，#50 根因半）。
    expect(container.querySelector('.agent-typewriter-skip')).toBeNull();
    // 全量直出：正文即刻完整可见。
    expect(container.textContent).toContain('上次会话的末条回答');
  });
});

describe('工具调用徽标去重（dogfood R2 #9：徽标=执行中，结果卡=完成态）', () => {
  it('结果卡已落地的调用不再渲染徽标；未落地的保留（执行中指示）', async () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '派规划员' }),
      msg({
        id: 'a1', role: 'assistant', content: '',
        toolCalls: [
          { id: 'call-done', name: 'dispatch_story_planner', arguments: '{}' },
          { id: 'call-pending', name: 'dispatch_researcher', arguments: '{}' },
        ],
      }),
      msg({
        id: 't1', role: 'tool', content: '',
        toolResults: [{ toolCallId: 'call-done', toolName: 'dispatch_story_planner', output: '完成' }],
      }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={true} error={null} />);
    await act(async () => {});
    const badges = container.querySelectorAll('.agent-tool-call-badge');
    // 只剩未完成的那个（badge 显示中文化标签，T2 #38）；已完成的由结果卡承载（不再双打）。
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toContain('派出研究员');
  });

  it('无任何结果时徽标全保留（旧渲染零回归）', async () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '查' }),
      msg({
        id: 'a1', role: 'assistant', content: '',
        toolCalls: [{ id: 'c1', name: 'query_mentions', arguments: '{}' }],
      }),
    ];
    const { container } = render(<AgentMessages messages={messages} loading={true} error={null} />);
    await act(async () => {});
    expect(container.querySelectorAll('.agent-tool-call-badge')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BMad CR 组4（#50 追补）：会话切换跳底改**有限帧 rAF 循环**——单帧复位追不上多帧
// 晚 settle 的布局（末条全量 MD 高度 / 子组件异步提交）。用可控 rAF 队列 + 可变
// scrollHeight 模拟「前几帧还在长高、随后冻结」的 settle 过程做确定性断言。
// ─────────────────────────────────────────────────────────────────────────────
describe('R2 #50 追补：跳底复位为有限帧 rAF 循环', () => {
  let queue: Array<() => void>;
  const cleanupFns: Array<() => void> = [];

  function installRafHarness(): { flushNext: () => boolean; pendingCount: () => number } {
    queue = [];
    const handles = new Map<number, () => void>();
    let seq = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      seq += 1;
      const id = seq;
      const wrap = () => cb(0);
      handles.set(id, wrap);
      queue.push(wrap);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const wrap = handles.get(id);
      if (!wrap) return;
      handles.delete(id);
      const i = queue.indexOf(wrap);
      if (i >= 0) queue.splice(i, 1);
    });
    cleanupFns.push(() => vi.unstubAllGlobals());
    return {
      flushNext: () => {
        const cb = queue.shift();
        if (cb) cb();
        return cb !== undefined;
      },
      pendingCount: () => queue.length,
    };
  }

  function instrument(el: HTMLElement) {
    let height = 100;
    const sets: number[] = [];
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => height,
    });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => sets[sets.length - 1] ?? 0,
      set: (v: number) => sets.push(v),
    });
    return {
      el, sets,
      grow: (to: number) => { height = to; },
      /** 最近一次被本容器记录的 scrollTop 写入值。 */
      lastSet: () => sets[sets.length - 1],
    };
  }

  /**
   * 驱动 rAF 队列直到被测容器发生**下一次** scrollTop 写入（或次数耗尽）。同树的
   * useTypewriter / useSmoothReveal 也各自挂一次性 rAF（与被测跳底循环共享全局
   * stub，且 useTypewriter 在禁用态仍自续帧）——断言面只认「写容器」这条独占信号，
   * 不对队列一一对应做假设。
   */
  function driveToNextWrite(h: ReturnType<typeof installRafHarness>, inst: ReturnType<typeof instrument>) {
    const baseline = inst.sets.length;
    for (let i = 0; i < 60; i++) {
      if (!h.flushNext()) break;
      if (inst.sets.length > baseline) return true;
    }
    return false;
  }

  /** 连续 n 次派发都不再产生写入（生产者停排的可观测口径）。 */
  function runsQuiet(h: ReturnType<typeof installRafHarness>, inst: ReturnType<typeof instrument>, n: number) {
    for (let i = 0; i < n; i++) {
      const before = inst.sets.length;
      if (!h.flushNext()) continue;
      if (inst.sets.length !== before) return false;
    }
    return true;
  }

  afterEach(() => {
    for (const fn of cleanupFns.reverse()) fn();
    cleanupFns.length = 0;
  });

  function mountTwoMessages() {
    return render(
      <AgentMessages
        messages={[
          msg({ id: 'u1', role: 'user', content: '写一段' }),
          msg({ id: 'a1', role: 'assistant', content: 'x'.repeat(80) }),
        ]}
        loading={false}
        error={null}
      />
    );
  }

  it('晚 settle 的多帧布局逐帧跟到底：连续两帧同高 → 提前收工，落点=最终高度', () => {
    const h = installRafHarness();
    mountTwoMessages();
    // instrument 晚于 effect 首跳（那次同步赋值发生在 mount 内，getter 未捕获）——
    // 从首帧 rAF 起所有复位都被 sets 记录。
    const inst = instrument(document.querySelector('.agent-messages') as HTMLElement);
    expect(driveToNextWrite(h, inst)).toBe(true);
    expect(inst.lastSet()).toBe(100); // frame1：初始高度
    inst.grow(400);
    expect(driveToNextWrite(h, inst)).toBe(true);
    expect(inst.lastSet()).toBe(400); // frame2 跟上（旧单帧复位只跟一帧，之后掉队）
    inst.grow(900);
    expect(driveToNextWrite(h, inst)).toBe(true);
    expect(inst.lastSet()).toBe(900); // frame3 仍跟随
    inst.grow(900); // 冻结
    expect(driveToNextWrite(h, inst)).toBe(true);
    expect(inst.lastSet()).toBe(900);
    // 连续两帧同高 → 收工：此后再无写入（生产者停排）。
    expect(runsQuiet(h, inst, 8)).toBe(true);
    expect(inst.sets.filter((v) => v === 900).length).toBeGreaterThanOrEqual(2);
  });

  it('异常布局下永远长高也有限次（≤15 帧）自停，不做无限循环', () => {
    const h = installRafHarness();
    mountTwoMessages();
    const inst = instrument(document.querySelector('.agent-messages') as HTMLElement);
    // 每帧都长高——settle 条件永不满足，唯一能停排的是帧数上限。
    let i = 0;
    while (driveToNextWrite(h, inst)) {
      i += 1;
      inst.grow(300 + i); // 写完立刻再长——下一帧读到新值必不 settle
      expect(i).toBeLessThanOrEqual(15);
    }
    expect(i).toBeLessThanOrEqual(15); // ≤15 帧后不再有写入（同步首跳未被 getter 捕获）
  });

  it('卸载清挂起帧（cancel 兜底，不再驱动已卸载容器）', () => {
    const h = installRafHarness();
    const { unmount } = mountTwoMessages();
    const inst = instrument(document.querySelector('.agent-messages') as HTMLElement);
    // 挂载后同树三方各挂一帧（useTypewriter / useSmoothReveal / 跳底循环）。
    expect(h.pendingCount()).toBeGreaterThanOrEqual(3);
    unmount();
    // 整树卸载后各生产者的 cleanup 都会 cancel 自己的帧（跳底循环在内）——队列
    // 彻底清空，绝无帧再驱动已卸载容器（驱动了就是写入，sets 即增长）。
    expect(h.pendingCount()).toBe(0);
    const writes = inst.sets.length;
    while (h.flushNext()) { /* 防御性排空 */ }
    expect(inst.sets.length).toBe(writes);
  });
});
