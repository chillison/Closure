import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { computeColOffsets, computeRowOffsets } from './timelineGeometry';

// 单源在 timelineGeometry.ts（像素几何之家）；此处 re-export 维持 hook 模块公共面。
export { computeColOffsets, computeRowOffsets };

/**
 * 08-26 结构页重构 批 1（implement 1.2 / design §3.2-3.3）：网格行高实测 hook。
 * 批 7（design §11 定案 1/2）扩展出列宽镜像 `useGridColumnWidths`（章列自适应后
 * x 几何同样需要实测→查表两级方案；ResizeObserver/rAF 去抖/jdom 降级同一实现，
 * 抽共用底座避免两份 observer 漂移）。
 *
 * 背景：卡化后行高自适应、章轴换轨后列宽自适应——jsdom 算不了文本高/内容宽 →
 * 两级方案（design §3.2/§11）：
 *   ① 布局期 DOM 实测——useLayoutEffect 首测 + ResizeObserver 跟随（rAF 去抖防
 *      反馈环：列宽变化→行高变化→scrollbar→列宽再变，design §9.2；observer 生命期
 *      收口在共享底座 `useDomMeasure` 单份实现，AssocLayer 为第三消费面）；
 *   ② SVG 锚定查表——`rowOffsets[i]` / `colOffsets[i]` 累计数组（纯函数单源在
 *      timelineGeometry.ts），EdgeLayer/PacingOverlay 的坐标数学查表消费。
 *
 * jsdom 降级：offsetHeight/offsetWidth 全 0 → 尺寸全 0（不崩；消费端按全 0 回退
 * 名义常量表，几何查表退化为等价公式——测试确定性保持）；ResizeObserver 未实现
 * → 只跑 useLayoutEffect 首测。observer 只盯容器自身尺寸（不盯 viewport，避免
 * scrollbar 出现/消失引发的连锁）。
 */

export type GridGeometry = {
  /** 每行实测高（px；jsdom 下全 0）。长度 = rowCount。 */
  rowHeights: number[];
  /** computeRowOffsets(rowHeights)——长度 = rowCount + 1 的累计查表。 */
  rowOffsets: number[];
};

/** rAF 去抖句柄（jsdom 无 rAF 时退 setTimeout，句柄类型同 number 兼容两者）。 */
type RafHandle = number;

function scheduleRaf(cb: () => void): RafHandle {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(cb, 0) as unknown as RafHandle;
}

function cancelRaf(handle: RafHandle): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

/**
 * 共享底座（BMad CR 组2a「样板抽一份防三份漂移」）：布局期首测 + 双触发源的
 * rAF **合流**重测——ResizeObserver（容器尺寸变化）与可选滚动源共用同一 raf 句柄，
 * 同帧两源先后到也只测一次。
 *
 * - `measure`：测量回调。闭包新鲜度由调用方 useCallback 保证——effect 随其重建
 *   （依赖变化即重挂 = 重首测），这是 grid hooks 与 AssocLayer 共同的时序约定。
 * - `resolveObserverTarget`：RO 观察对象惰性解析（**effect 内**求值——首渲染期宿主
 *   可能尚未插入 DOM，closest/ref 直读都是 null，提早求值会永久跳过观察）。返回
 *   null 或环境无 RO（jsdom）→ 只跑首测，首测即终测。卸载竞态由 cancelled 拦截。
 *   调用方须给稳定引用（useCallback），否则 effect 每次渲染重挂。
 * - `resolveScrollRoot`：可选滚动重测源惰性解析（pin-right 钉驻成员的位移随页横滚
 *   发生，RO 对 sticky 元素相对内容的位移是盲的——关联线几何显式跟随；大规模降级
 *   归批 9）。监听 passive，不干预滚动自身。
 *
 * 供 useMeasuredSizes / useGridColumnWidths / AssocLayer 三处消费；此前三份手抄
 * observer 生命期样板（防「注释宣称底座实则两份」）收敛到此处单源。
 */
export function useDomMeasure(
  measure: () => void,
  resolveObserverTarget?: () => HTMLElement | null,
  resolveScrollRoot?: () => HTMLElement | null
): void {
  const rafRef = useRef<RafHandle | null>(null);
  useLayoutEffect(() => {
    measure();
    const el = resolveObserverTarget?.() ?? null;
    const scrollEl = resolveScrollRoot?.() ?? null;
    const canObserve = typeof ResizeObserver !== 'undefined' && el !== null;
    if (!canObserve && scrollEl === null) return; // jsdom：首测即终测
    let cancelled = false;
    const schedule = () => {
      if (cancelled || rafRef.current !== null) return;
      rafRef.current = scheduleRaf(() => {
        rafRef.current = null;
        measure();
      });
    };
    let ro: ResizeObserver | null = null;
    if (canObserve) {
      ro = new ResizeObserver(schedule);
      ro.observe(el!);
    }
    if (scrollEl !== null) scrollEl.addEventListener('scroll', schedule, { passive: true });
    return () => {
      cancelled = true;
      ro?.disconnect();
      if (scrollEl !== null) scrollEl.removeEventListener('scroll', schedule);
      if (rafRef.current !== null) {
        cancelRaf(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [measure, resolveObserverTarget, resolveScrollRoot]);
}

/**
 * 共用底座：实测容器内前 `count` 个 `selector` 元素的 offsetHeight / offsetWidth。
 * 观察对象 = 容器自身（盯网格根，不盯页面，防 scrollbar 反馈环）。过渡帧返回
 * 全 0 数组对齐（length 恒 = count），不崩。
 */
function useMeasuredSizes(
  containerRef: RefObject<HTMLElement | null>,
  count: number,
  selector: string,
  dimension: 'height' | 'width'
): number[] {
  const safeCount = Math.max(0, Math.floor(count));
  const [measured, setMeasured] = useState<number[]>(() => new Array<number>(safeCount).fill(0));

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const els = el.querySelectorAll(selector);
    const next = new Array<number>(safeCount).fill(0);
    const upTo = Math.min(safeCount, els.length);
    for (let i = 0; i < upTo; i++) {
      next[i] =
        dimension === 'height'
          ? (els[i] as HTMLElement).offsetHeight
          : (els[i] as HTMLElement).offsetWidth;
    }
    setMeasured((prev) =>
      prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next
    );
  }, [containerRef, safeCount, selector, dimension]);

  // 首测 + RO rAF 去抖生命期收口在共享底座 useDomMeasure（三消费面单源）。
  useDomMeasure(
    measure,
    useCallback(() => containerRef.current, [containerRef])
  );

  // count 变化的过渡帧：state 数组长度可能滞后一帧，渲染期先垫 0 对齐（effect
  // 在 paint 前跑 measure 校正），消费端拿到的长度恒 = count。
  return measured.length === safeCount ? measured : new Array<number>(safeCount).fill(0);
}

/**
 * 行高实测（批 2 公共面签名不变）：量 `[data-grid-row]` 元素的 offsetHeight。
 */
export function useGridGeometry(
  containerRef: RefObject<HTMLElement | null>,
  rowCount: number,
  rowSelector = '[data-grid-row]'
): GridGeometry {
  const rowHeights = useMeasuredSizes(containerRef, rowCount, rowSelector, 'height');
  const rowOffsets = useMemo(() => computeRowOffsets(rowHeights), [rowHeights]);
  return { rowHeights, rowOffsets };
}

export type ColumnGeometry = {
  /** 每列实测宽（px；jsdom 下全 0）。长度 = colCount。 */
  colWidths: number[];
  /** computeColOffsets(colWidths)——长度 = colCount + 1 的累计查表。 */
  colOffsets: number[];
};

/**
 * 列宽实测（批 7）：按**标记元素的 index 属性**回填宽度——章轴的稠密轨道数覆盖
 * gap 章空轨（真实宽 = minmax 下限，非 0），而列头只对实际存在的 episode 渲染，
 * 顺序遍历会把空轨孔洞错位。因此量 `[data-grid-col]` 标记并读其数值回填对应槽位
 * （同槽多行标记取首个非零）。NTP 在每个泳道的列头/待编排头落该属性。
 */
export function useGridColumnWidths(
  containerRef: RefObject<HTMLElement | null>,
  colCount: number,
  colSelector = '[data-grid-col]',
  indexAttr = 'dataGridCol'
): ColumnGeometry {
  const safeCount = Math.max(0, Math.floor(colCount));
  const [measured, setMeasured] = useState<number[]>(() => new Array<number>(safeCount).fill(0));

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const marks = el.querySelectorAll<HTMLElement>(colSelector);
    const next = new Array<number>(safeCount).fill(0);
    marks.forEach((m) => {
      const idx = Number.parseInt(m.dataset[indexAttr] ?? '', 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= safeCount) return;
      if (next[idx] !== 0) return; // 首个非零胜出（行×列重复标记）
      const w = m.offsetWidth;
      if (w > 0) next[idx] = w;
    });
    setMeasured((prev) =>
      prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next
    );
  }, [containerRef, safeCount, colSelector, indexAttr]);

  // 首测 + RO rAF 去抖生命期收口在共享底座 useDomMeasure（三消费面单源——本 hook
  // 曾手抄第二份样板，与头注「抽共用底座防漂移」矛盾的失配就地消解）。
  useDomMeasure(
    measure,
    useCallback(() => containerRef.current, [containerRef])
  );

  const colWidths =
    measured.length === safeCount ? measured : new Array<number>(safeCount).fill(0);
  const colOffsets = useMemo(() => computeColOffsets(colWidths), [colWidths]);
  return { colWidths, colOffsets };
}
