/**
 * 简版列表窗口化（dogfood R2 #92，task 08-29-world-state-panel S6）。
 *
 * 选型说明：ui 包无既有虚拟列表先例（grep overscan/virtualiz/useVirtual 零命中），引入
 * react-window 类依赖不在本 task 范围——自实现最小窗口化：**模型估高 + 前缀和定位**，
 * 不做 DOM 实测高度缓存（复杂度不值：面板列表 = 几百行级，行高方差由 overscan 吸收）。
 *
 * - 逐行估高由调用方按内容行数派生（组块 = 头 + N 行 × 行高），估高偏差 ±20% 在
 *   overscan（默认 6 行）缓冲内不露白；number 入参 = 均一估高全行生效（#204）。
 * - jsdom 零布局（clientHeight=0）→ virtualized=false 全量渲染——测试语义不受窗口化
 *   影响（真窗口化行为由本 hook 的直测覆盖：override clientHeight/scrollTop 探针）。
 * - 仅在列表估高显著超视口（>1.5×）时启用窗口化——短列表零开销零行为差。
 *
 * 与 spec/ui/layout-and-pages「sticky 钉驻前提族」的关系：长列表滚动区是**独立滚动容器**
 * （chrome 固定其上，非 sticky），从根上规避 sticky 三前提族的静默退化路径。
 */
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';

export interface WindowedRows {
  startIndex: number;
  /** 含端（slice(startIndex, endIndex + 1)）。 */
  endIndex: number;
  padTop: number;
  padBottom: number;
  /** 挂滚动容器的 onScroll（测量 + 窗口推进）。 */
  onScroll: () => void;
  /** 本轮是否实际窗口化（false = 全量渲染，spacers 为零高）。 */
  virtualized: boolean;
}

const FALLBACK_ROW_ESTIMATE = 30;

export function useWindowedRows(params: {
  containerRef: RefObject<HTMLElement | null>;
  rowCount: number;
  /** 每行估高（px）：number = 均一；number[] = 逐行模型估高（内容行数派生）。 */
  rowEstimates: number | readonly number[];
  overscan?: number;
}): WindowedRows {
  const { containerRef, rowCount, rowEstimates, overscan = 6 } = params;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight);
  }, [containerRef]);

  // 每次渲染后重测（同值 setState 自动 bail，不构成渲染循环）——内容高度变化（展开/折叠/
  // 过滤）后下一帧窗口自动跟进；也覆盖初始挂载测量。
  useLayoutEffect(measure);

  /** 前缀和：prefix[i] = 前 i 行估高累计；prefix[rowCount] = 总估高。number 入参 = 均一
   * 估高对全行生效（#204——原实现 number 走不进本 memo、恒落 FALLBACK 死值）。 */
  const prefix = useMemo(() => {
    const p = new Array<number>(rowCount + 1);
    p[0] = 0;
    for (let i = 0; i < rowCount; i += 1) {
      const est = typeof rowEstimates === 'number' ? rowEstimates : rowEstimates[i];
      p[i + 1] = p[i] + (typeof est === 'number' && est > 0 ? est : FALLBACK_ROW_ESTIMATE);
    }
    return p;
  }, [rowCount, rowEstimates]);

  const totalEstimate = prefix[rowCount] ?? 0;
  // 短列表（估高 ≤ 1.5× 视口）不窗口化——零开销路径也覆盖 jsdom（clientHeight=0）。
  const virtualized = viewportHeight > 0 && totalEstimate > viewportHeight * 1.5;
  if (!virtualized || rowCount === 0) {
    return {
      startIndex: 0,
      endIndex: rowCount - 1,
      padTop: 0,
      padBottom: 0,
      onScroll: measure,
      virtualized: false,
    };
  }

  // 二分：首个 prefix[lo] > scrollTop 的行 = 视口顶行；再向上留 overscan。
  let lo = 0;
  let hi = rowCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const start = Math.max(0, lo - 1 - overscan);

  // 向下扩：覆盖视口底（scrollTop + viewportHeight）再留 overscan。
  let end = start;
  while (end < rowCount - 1 && prefix[end + 1] - prefix[start] < scrollTop + viewportHeight) {
    end += 1;
  }
  end = Math.min(rowCount - 1, end + overscan);

  return {
    startIndex: start,
    endIndex: end,
    padTop: prefix[start],
    padBottom: Math.max(0, totalEstimate - prefix[end + 1]),
    onScroll: measure,
    virtualized: true,
  };
}
