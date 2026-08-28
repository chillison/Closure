/**
 * 08-26 结构页重构 批 4（implement 4.4 / design §6.1 §6.4 / prd R1 线聚焦）：
 * 线级悬停聚焦——悬停任一线元素（因果卡 / 工作 chip / 两侧泳道标签）→ 该线全部
 * 元素保持、其余降透明 25%（含因果边 + 关联线），移开回落。
 *
 * 行为单源 = mockup v1.6 的 mouseenter/mouseleave（浏览器断言过的验收标准）：
 * 类切换由本模块的纯 DOM 函数完成，StructurePage 只挂委托监听（同 wheel 拦截先例
 * ——页级 mouseover 委托 + relatedTarget/mouseleave 清态出口，closest
 * '[data-line-id],[data-lane-id]' 命线）。
 *
 * 悬停态刻意不入 store / 不走 React state（design §6.4 拍板空间）：hover 是高频
 * 瞬态，类切换零重渲染；副作用 = React 重渲染可能重建元素而丢类——鼠标一动即恢复
 * （瞬态可接受，mockup 同性质）。
 *
 * 参与元素面：所有携带 `data-line-id` 的元素（SceneCard / WorkbenchChip /
 * EdgeLayer path / AssocLayer path）+ 两侧泳道标签（`data-lane-id`）。判等取
 * data-line-id ?? data-lane-id。关联线**何时渲染**不归本模块（AssocLayer 的
 * hover∨selected 渲染滤集单源）；本模块对已渲染成员只做 dim 聚焦。
 */

/**
 * 从事件目标解析悬停线 id（closest 上溯最近线元素）。非线元素 / null → null。
 * 纯 DOM 读函数（jsdom 可直接断言）。
 */
export function resolveHoverLine(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('[data-line-id], [data-lane-id]');
  if (!el) return null;
  return el.getAttribute('data-line-id') ?? el.getAttribute('data-lane-id');
}

/**
 * 施加线聚焦态（幂等）：
 *   - `hoveredLineId` 非空：其他线的元素降透明（`.structure-hover-dim`，CSS 25%）；
 *   - `hoveredLineId` 为 null：全清（回落）。
 *
 * 纯 DOM 操作函数（不触 React）。root = 委托根（BMad CR 组2a/3a 后升
 * `.structure-page`——zoombar/minimap/legend 已页级化，参与元素查询随根走，升级了
 * 根也一并覆盖 chrome 上的历史残留类）。
 */
export function applyLineHover(root: ParentNode, hoveredLineId: string | null): void {
  const els = root.querySelectorAll('[data-line-id], [data-lane-id]');
  els.forEach((el) => {
    const line = el.getAttribute('data-line-id') ?? el.getAttribute('data-lane-id');
    if (line === null) return;
    const keep = hoveredLineId !== null && line === hoveredLineId;
    el.classList.toggle('structure-hover-dim', hoveredLineId !== null && !keep);
  });
}
