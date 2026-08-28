/**
 * CR 组1 edge-3（BMad CR 组 2b-B4 同源）：VolumeBandTint 越界分段守卫直测。
 *
 * band.fromCol/toCol 落在实测列宽表之外（过渡帧 / 列表突缩）时，旧实现用 `?? 0`
 * 静默把错锚零宽帘画在 lane 左缘——现在整段跳过，等列宽表就绪的下一帧自然恢复。
 * 组件是因果侧活代码路径（NarrativeTimelinePanel 唯一挂载；工作台卷带走 CSS
 * gridColumn 定位不经此处——grep 2026-08-27 复核）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run volumeBandTint`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TIMELINE_GEOMETRY } from '../src/features/structure/timelineGeometry';
import { VolumeBandTint } from '../src/features/structure/VolumeBand';
import type { VolumeBand } from '../src/features/structure/volumeBands';

const phase = (id: string) => ({ id, title: id });
const band = (phaseId: string | null, fromCol: number, toCol: number): VolumeBand => ({
  phaseId,
  title: phaseId ?? '',
  fromCol,
  toCol,
});

function renderTint(bands: VolumeBand[], colOffsets: number[]) {
  return render(
    <VolumeBandTint
      bands={bands}
      phases={[phase('p1'), phase('p2')]}
      colOffsets={colOffsets}
    />
  );
}

afterEach(cleanup);

describe('VolumeBandTint out-of-range segment guard (CR 组1 edge-3)', () => {
  it('in-bounds band renders one segment anchored to the offsets table', () => {
    const { container } = renderTint([band('p1', 0, 1)], [0, 108, 320]);
    const seg = container.querySelector('.volume-band-tint-segment') as HTMLElement;
    expect(seg).not.toBeNull();
    const { laneLabelWidth, headerHeight } = TIMELINE_GEOMETRY;
    expect(seg.style.left).toBe(`${laneLabelWidth + 0}px`);
    expect(seg.style.width).toBe('320px');
    expect(seg.style.top).toBe(`${headerHeight}px`);
  });

  it('from/to beyond the table → segment skipped entirely（不再零宽/错锚静默画出）', () => {
    // 表只有两列；band 指向第 3..5 列（越界）。
    const { container } = renderTint([band(null, 2, 4)], [0, 108, 216]);
    expect(container.querySelectorAll('.volume-band-tint-segment')).toHaveLength(0);
    // 半越界：from 有解析、to+1 缺右缘 → 同样整段跳过。
    const partial = renderTint([band('p1', 1, 5)], [0, 108, 216]);
    expect(partial.container.querySelectorAll('.volume-band-tint-segment')).toHaveLength(0);
  });

  it('degenerate ranges: zero and negative width segments are skipped (畸形表防御)', () => {
    // 零宽：相邻偏移相等（from === to 右缘）。
    const zero = renderTint([band('p1', 1, 1)], [0, 100, 100]);
    expect(zero.container.querySelectorAll('.volume-band-tint-segment')).toHaveLength(0);
    // 负宽：倒挂的 offsets 表（防御面——正常累计表不会产出）。
    const neg = renderTint([band('p1', 0, 0)], [100, 40]);
    expect(neg.container.querySelectorAll('.volume-band-tint-segment')).toHaveLength(0);
  });

  it('mixed batch: invalid segments skip while valid ones still paint（逐段判定非整层放弃）', () => {
    const { container } = renderTint(
      // offsets 表右缘 index = 2 ⇒ 合法 band 的 toCol ≤ 1；p2 段整体越界跳过。
      [band(null, 0, 0), band('p2', 7, 8), band('p1', 1, 1)],
      [0, 100, 260]
    );
    const segs = Array.from(container.querySelectorAll('.volume-band-tint-segment')) as HTMLElement[];
    expect(segs).toHaveLength(2);
    expect(segs[0]!.style.left).toBe(`${TIMELINE_GEOMETRY.laneLabelWidth}px`);
    expect(segs[0]!.style.width).toBe('100px');
    expect(segs[1]!.style.left).toBe(`${TIMELINE_GEOMETRY.laneLabelWidth + 100}px`);
    expect(segs[1]!.style.width).toBe('160px');
  });
});
