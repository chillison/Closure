/**
 * 08-26 结构页重构 批 1（implement 1.2 / design §3.2-3.3）：网格行高实测 hook 测试。
 *
 * 两层：
 *   1. computeRowOffsets 纯函数——累计查表（prefix sums，offsets[0]=0、长度 n+1），
 *      批 2 EdgeLayer 的 y 数学查表消费的几何单源。
 *   2. useGridGeometry jsdom smoke——offsetHeight 全 0（无 layout）→ 行高全 0 不崩；
 *      DOM 行不足 / rowCount 超前变化 → 缺位垫 0，长度恒对齐。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run useGridGeometry`
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useRef } from 'react';
import {
  computeRowOffsets,
  useGridGeometry,
} from '../src/features/structure/useGridGeometry';

describe('computeRowOffsets（纯函数：累计查表）', () => {
  it('前缀和 + 首位 0（第 i 行顶边 = offsets[i]、底边 = offsets[i+1]）', () => {
    expect(computeRowOffsets([10, 20, 30])).toEqual([0, 10, 30, 60]);
    expect(computeRowOffsets([64])).toEqual([0, 64]);
  });

  it('空数组 → [0]（零行网格仍有一个锚点）', () => {
    expect(computeRowOffsets([])).toEqual([0]);
  });

  it('负高防御性钳 0（手写 fixture 容错，实测路径不会给负值）', () => {
    expect(computeRowOffsets([-5, 20])).toEqual([0, 0, 20]);
  });
});

/** 探针：挂 hook，把行高/查表序列化进 value 属性断言（jsdom 无可视化输出）。 */
function GeometryProbe({ rowCount, rows }: { rowCount: number; rows: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { rowHeights, rowOffsets } = useGridGeometry(ref, rowCount);
  return (
    <div ref={ref} data-geometry-host>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} data-grid-row style={{ height: 40 }} />
      ))}
      <output data-testid="heights" value={rowHeights.join(',')} />
      <output data-testid="offsets" value={rowOffsets.join(',')} />
    </div>
  );
}

describe('useGridGeometry（jsdom smoke：clientHeight=0 → 全 0 不崩）', () => {
  afterEach(cleanup);

  it('挂载即首测；jsdom offsetHeight=0 → 行高全 0，查表长度 = rowCount+1', () => {
    const { container } = render(<GeometryProbe rowCount={3} rows={3} />);
    expect(container.querySelector('[data-geometry-host]')).not.toBeNull();
    expect(container.querySelector('[data-testid="heights"]')!.getAttribute('value')).toBe('0,0,0');
    expect(container.querySelector('[data-testid="offsets"]')!.getAttribute('value')).toBe('0,0,0,0');
  });

  it('DOM 行数少于 rowCount → 缺位记 0（过渡/残缺 DOM 不崩，长度仍对齐）', () => {
    const { container } = render(<GeometryProbe rowCount={5} rows={2} />);
    expect(container.querySelector('[data-testid="heights"]')!.getAttribute('value')).toBe('0,0,0,0,0');
    expect(container.querySelector('[data-testid="offsets"]')!.getAttribute('value')).toBe('0,0,0,0,0,0');
  });

  it('rowCount 收缩 → 返回数组长度跟随（渲染期垫 0，不残留旧行）', () => {
    const { container, rerender } = render(<GeometryProbe rowCount={4} rows={4} />);
    rerender(<GeometryProbe rowCount={2} rows={4} />);
    expect(container.querySelector('[data-testid="heights"]')!.getAttribute('value')).toBe('0,0');
    expect(container.querySelector('[data-testid="offsets"]')!.getAttribute('value')).toBe('0,0,0');
  });
});
