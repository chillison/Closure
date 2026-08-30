/**
 * 简版列表窗口化 hook 测试（dogfood R2 #92，task 08-29-world-state-panel S6）。
 *
 * jsdom 零布局（clientHeight=0）→ virtualized=false 全量渲染（面板测试零影响）；
 * 真窗口化行为经 **几何探针** 覆盖：Object.defineProperty 覆写容器的 clientHeight /
 * scrollTop（jsdom 无布局，这两个属性默认恒 0/不可设），fireEvent.scroll 触发 onScroll
 * 测量，断言窗口范围与 spacer 垫高。敌意面：rowCount 变化（过滤收窄）后窗口自愈。
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useRef } from 'react';
import { useWindowedRows } from '../src/features/world-state/useWindowedRows';

const ROW_H = 30;

function Probe({ rowCount, scrollTop, clientHeight, rowH = ROW_H }: {
  rowCount: number;
  scrollTop: number;
  clientHeight: number;
  rowH?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const win = useWindowedRows({ containerRef: ref, rowCount, rowEstimates: rowH });
  return (
    <div
      data-testid="host"
      ref={(el) => {
        ref.current = el;
        if (el) {
          Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
          Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true });
        }
      }}
      onScroll={win.onScroll}
      data-virtualized={String(win.virtualized)}
      data-start={win.startIndex}
      data-end={win.endIndex}
      data-pad-top={win.padTop}
      data-pad-bottom={win.padBottom}
    >
      <div data-testid="pad-top" style={{ height: win.padTop }} />
      {Array.from({ length: win.endIndex - win.startIndex + 1 }, (_, i) => (
        <div key={win.startIndex + i} data-testid="row" data-index={win.startIndex + i} />
      ))}
      <div data-testid="pad-bottom" style={{ height: win.padBottom }} />
    </div>
  );
}

function readWin(container: HTMLElement) {
  const host = container.querySelector<HTMLElement>('[data-testid="host"]')!;
  return {
    virtualized: host.dataset.virtualized === 'true',
    start: Number(host.dataset.start),
    end: Number(host.dataset.end),
    padTop: Number(host.dataset.padTop),
    padBottom: Number(host.dataset.padBottom),
    rows: [...container.querySelectorAll<HTMLElement>('[data-testid="row"]')].map((el) => Number(el.dataset.index)),
  };
}

afterEach(cleanup);

describe('useWindowedRows（简版窗口化）', () => {
  it('jsdom 零布局（clientHeight=0）→ 不窗口化全量渲染（面板测试语义零影响）', () => {
    const { container } = render(<Probe rowCount={500} scrollTop={0} clientHeight={0} />);
    const win = readWin(container);
    expect(win.virtualized).toBe(false);
    expect(win.start).toBe(0);
    expect(win.end).toBe(499);
    expect(win.padTop).toBe(0);
    expect(win.padBottom).toBe(0);
  });

  it('长列表 + 有视口 → 窗口化：顶部窗口 + 尾部垫高', () => {
    const { container } = render(<Probe rowCount={200} scrollTop={0} clientHeight={400} />);
    const win = readWin(container);
    // 200 行 × 30 = 6000 > 400×1.5 → 窗口化；顶部从 0 起。
    expect(win.virtualized).toBe(true);
    expect(win.start).toBe(0);
    // 覆盖视口 400/30 ≈ 14 行 + overscan 6 → 至少渲染 20 行、不超过全量。
    expect(win.rows.length).toBeGreaterThanOrEqual(20);
    expect(win.rows.length).toBeLessThan(60);
    expect(win.rows[0]).toBe(0);
    expect(win.padTop).toBe(0);
    expect(win.padBottom).toBe(200 * ROW_H - (win.end + 1) * ROW_H);
  });

  it('滚动后窗口平移（scrollTop=3000 → 中段窗口 + 双侧垫高）', () => {
    const { container } = render(<Probe rowCount={200} scrollTop={3000} clientHeight={400} />);
    // 初始 render 尚未测量（viewportHeight=0 → 全量）；layout effect 已完成测量+重渲。
    const host = container.querySelector<HTMLElement>('[data-testid="host"]')!;
    fireEvent.scroll(host); // 显式触发 onScroll（滚动事件驱动窗口推进）
    const win = readWin(container);
    expect(win.virtualized).toBe(true);
    // scrollTop 3000 = 行 100 的前缀和恰在其上 → 顶行 100；向上 overscan 6 → start 94。
    expect(win.start).toBe(94);
    expect(win.rows).not.toContain(0);
    expect(win.rows).toContain(100);
    expect(win.padTop).toBe(94 * ROW_H);
    expect(win.padTop + win.padBottom).toBeLessThan(200 * ROW_H);
  });

  it('number 统一估高对全行生效（#204）——非 FALLBACK 30 死值：垫高按传入行高派生', () => {
    const ROW = 50; // ≠ FALLBACK_ROW_ESTIMATE(30)——死值路径下垫高会按 30 派生，可判别。
    const { container } = render(<Probe rowCount={200} scrollTop={3000} clientHeight={400} rowH={ROW} />);
    const host = container.querySelector<HTMLElement>('[data-testid="host"]')!;
    fireEvent.scroll(host);
    const win = readWin(container);
    expect(win.virtualized).toBe(true);
    // scrollTop 3000 / 50 = 行 60 前缀和恰在其上 → 顶行 60，向上 overscan 6 → start 54。
    expect(win.start).toBe(54);
    expect(win.rows).toContain(60);
    // 垫高 = 前缀和（按 50/行），不是 FALLBACK 30 的 54×30。
    expect(win.padTop).toBe(54 * ROW);
    expect(win.padBottom).toBe(200 * ROW - (win.end + 1) * ROW);
  });

  it('短列表（估高 ≤ 1.5× 视口）不窗口化——零开销路径', () => {
    const { container } = render(<Probe rowCount={10} scrollTop={0} clientHeight={200} />);
    const win = readWin(container);
    expect(win.virtualized).toBe(false);
    expect(win.end).toBe(9);
  });

  it('列表收窄（过滤）后窗口自愈：rowCount 骤减不出越界窗口', () => {
    const { container, rerender } = render(<Probe rowCount={200} scrollTop={3000} clientHeight={400} />);
    const host = container.querySelector<HTMLElement>('[data-testid="host"]')!;
    fireEvent.scroll(host);
    expect(readWin(container).virtualized).toBe(true);

    rerender(<Probe rowCount={5} scrollTop={3000} clientHeight={400} />);
    const win = readWin(container);
    expect(win.end).toBeLessThanOrEqual(4);
    expect(win.rows.every((i) => i >= 0 && i < 5)).toBe(true);
  });
});
