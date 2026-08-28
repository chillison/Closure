/**
 * dogfood R2 #11（findings #11④，2026-08-25）：流式出字平滑过渡的 displayLen 动画轨
 * （useSmoothReveal hook 层单测）。
 *
 * rAF 手动步进（dispatch 方案 F：「jsdom rAF 用 vi.useFakeTimers 或手动步进」——jsdom
 * pretendToBeVisual 有 rAF 但帧时机不可控，测试内 stub 成显式队列、按给定时间戳逐帧
 * 驱动，确定性验证不变式）：
 * - 挂载即全量：流式中途挂载不重放既有内容（r4 不变式——index 归零全量重放是实证事故）；
 * - grow-only：displayLen 单调逼近 target，target 变化不重置、不回退；
 * - 终帧拉满：active → false 直接全量（不经动画帧）；
 * - reveal 拉满（CR-T1-043）：revealed=true 恒贴 target，含后续 target 增长的即时跟随；
 * - reduced-motion：跳过动画恒全量（零帧推进即满）。
 * - CR-43（dogfood R2 BMad CR）：prefersReducedMotion 的 MediaQueryList 模块级缓存
 *   （matchMedia 每渲染新建 → 多渲染只建一次）；追平后拆 rAF 转静态轮询、新目标回 rAF。
 * - CR-46（dogfood R2 BMad CR）：displayLen 边界避开代理对中间（emoji reveal 无替换符）。
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSmoothReveal } from '../src/features/agent-panel/useSmoothReveal';

type Props = { text: string; active: boolean; revealed?: boolean };

let queue: FrameRequestCallback[] = [];
const originalRaf = window.requestAnimationFrame;
const originalCancelRaf = window.cancelAnimationFrame;
const originalMatchMedia = (window as unknown as { matchMedia?: unknown }).matchMedia;

/** 驱动一帧：排空当前队列（回调会自行重新入队——step 首行重排）。 */
function fireFrame(time: number): void {
  const frames = queue;
  queue = [];
  for (const cb of frames) cb(time);
}

function renderReveal(initialProps: Props) {
  return renderHook(
    ({ text, active, revealed }: Props) => useSmoothReveal(text, { active, revealed }),
    { initialProps },
  );
}

describe('useSmoothReveal（R2 #11④ displayLen 动画轨）', () => {
  beforeEach(() => {
    queue = [];
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
    (window as unknown as { matchMedia?: unknown }).matchMedia = originalMatchMedia;
    queue = [];
    cleanup();
    vi.restoreAllMocks();
  });

  it('挂载即全量：流式中途挂载不重放既有内容（r4 不变式）', () => {
    const { result } = renderReveal({ text: 'a'.repeat(100), active: true });
    expect(result.current).toBe(100);
  });

  it('grow-only：target 增长后逐帧单调逼近；target 再变不重置、不回退', () => {
    const { result, rerender } = renderReveal({ text: '', active: true });
    expect(result.current).toBe(0);

    rerender({ text: 'a'.repeat(60), active: true });
    act(() => fireFrame(100)); // 首帧只记时基
    act(() => fireFrame(116)); // 16ms：自适应速率步进 ≥1 字
    const mid = result.current;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThanOrEqual(60);

    // target 再增长：displayLen 从当前值继续（不归零、不回退）。
    rerender({ text: 'a'.repeat(120), active: true });
    act(() => fireFrame(132));
    act(() => fireFrame(148));
    expect(result.current).toBeGreaterThanOrEqual(mid);
    expect(result.current).toBeLessThanOrEqual(120);
  });

  it('终帧拉满：active → false 直接全量（不经动画帧）', () => {
    const { result, rerender } = renderReveal({ text: '', active: true });
    rerender({ text: 'a'.repeat(80), active: true });
    act(() => fireFrame(100)); // 时基帧（displayLen 仍 0，未追平）
    rerender({ text: 'a'.repeat(80), active: false });
    expect(result.current).toBe(80);
  });

  it('reveal 拉满（CR-T1-043）：revealed=true 恒贴 target，后续 target 增长即时跟随', () => {
    const { result, rerender } = renderReveal({ text: '', active: true });
    rerender({ text: 'a'.repeat(50), active: true, revealed: true });
    expect(result.current).toBe(50);
    rerender({ text: 'a'.repeat(90), active: true, revealed: true });
    expect(result.current).toBe(90); // 不等任何 rAF 帧
  });

  it('reduced-motion：跳过动画恒全量（零帧推进即满）', async () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = vi
      .fn()
      .mockReturnValue({ matches: true });
    // CR-43 模块级 MQL 缓存——需「缓存首次初始化即命中本 mock」：resetModules 后动态
    // import 拿全新模块实例（文件头静态 import 的旧实例已缓存 jsdom 真 MQL）。
    vi.resetModules();
    const { useSmoothReveal: freshHook } = await import('../src/features/agent-panel/useSmoothReveal');
    const { result, rerender } = renderHook(
      ({ text, active }: Props) => freshHook(text, { active }),
      { initialProps: { text: '', active: true } },
    );
    rerender({ text: 'a'.repeat(70), active: true });
    expect(result.current).toBe(70);
    // 动画时钟未启动——effect 对 reduced-motion 早退，零 rAF 入队。
    expect(queue).toHaveLength(0);
  });

  // ── CR-43（dogfood R2 BMad CR）：常驻开销治理 ──

  it('CR-43：prefersReducedMotion 模块级缓存——多渲染只 matchMedia 一次（旧实现每渲染新建 MQL）', async () => {
    const matchMediaMock = vi.fn().mockReturnValue({ matches: false });
    (window as unknown as { matchMedia: unknown }).matchMedia = matchMediaMock;
    vi.resetModules();
    const { useSmoothReveal: freshHook } = await import('../src/features/agent-panel/useSmoothReveal');
    const { rerender } = renderHook(
      ({ text, active }: Props) => freshHook(text, { active }),
      { initialProps: { text: 'a'.repeat(10), active: true } },
    );
    rerender({ text: 'a'.repeat(20), active: true });
    rerender({ text: 'a'.repeat(30), active: true });
    // 挂载（render + effect 各一次）+ 两次 rerender（render 路径各一次）全走同一缓存 MQL。
    expect(matchMediaMock).toHaveBeenCalledTimes(1);
  });

  it('CR-43：追平后拆 rAF 转静态轮询；轮询发现新目标 → 回 rAF 恢复生长', () => {
    // 可重复触发的 interval 模型（Map 按 id 存活，clearInterval 移除——真实 interval 的
    // 回调反复触发，一次性消费模型会把空转轮询误当已拆除）。mirror rAF 队列手法，确定性
    // 驱动轮询路径。
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

    const { result, rerender } = renderReveal({ text: '', active: true });
    rerender({ text: 'a'.repeat(10), active: true });
    // 追平 10 字（≥1 字/帧 + 首帧时基 + 追平后触发 settle 帧的额外一帧）。
    for (let f = 0; f < 14; f++) act(() => fireFrame(100 + f * 16));
    expect(result.current).toBe(10);
    // 追平后：无 rAF 在队（旧实现每帧 no-op 回调常驻）+ 轮询已挂。
    expect(queue).toHaveLength(0);
    expect(intervals.size).toBeGreaterThanOrEqual(1);

    // 新目标到达：轮询 tick 发现 displayLen < target → 拆轮询回 rAF。
    rerender({ text: 'a'.repeat(30), active: true });
    act(() => {
      for (const cb of [...intervals.values()]) cb();
    });
    expect(queue.length).toBeGreaterThanOrEqual(1);
    act(() => fireFrame(1000)); // 停摆后首帧只记时基
    act(() => fireFrame(1016));
    expect(result.current).toBeGreaterThan(10);
    expect(result.current).toBeLessThanOrEqual(30);

    setIntSpy.mockRestore();
    clearIntSpy.mockRestore();
  });

  // ── CR-46（dogfood R2 BMad CR）：代理对边界 ──

  it('CR-46：displayLen 边界避开代理对中间——emoji reveal 不渲染替换符', () => {
    // 😀 = U+1F600 = 高代理 D83D + 低代理 DE00（2 code units）。低代理落在 index 2/4/6——
    // 旧实现步进到这些长度时 slice 会把一对劈开（渲染端出孤立高代理 → U+FFFD 替换符）。
    const text = '😀😀😀a';
    const { result, rerender } = renderReveal({ text: '', active: true });
    rerender({ text, active: true });
    const seen: number[] = [];
    for (let f = 0; f < 40 && Math.floor(result.current) < text.length; f++) {
      act(() => fireFrame(100 + f * 16));
      seen.push(Math.floor(result.current));
    }
    expect(result.current).toBe(text.length); // 追平（grow-only 终点 = 全量）
    for (const len of seen) {
      if (len <= 0 || len >= text.length) continue;
      // 展示边界不得落在低代理上（CR 判据：(target.charCodeAt(len) & 0xfc00) === 0xdc00）。
      expect((text.charCodeAt(len) & 0xfc00) === 0xdc00).toBe(false);
      // 等价渲染侧判据：已显示段不得以孤立高代理收尾（那是替换符的来源）。
      const shown = text.slice(0, len);
      expect((shown.charCodeAt(shown.length - 1) & 0xfc00) === 0xd800).toBe(false);
    }
  });
});
