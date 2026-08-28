import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * dogfood R2 批次 A（详设 SP-1）：时间线右键菜单的通用呈现件。
 *
 * 三种菜单（场景格 / 线标签 / 列头·空白）共用一个「items 描述 + 定位渲染」的组件：
 *   - `position: fixed` 落在鼠标点（clientX/Y）——不需要 positioned ancestor，两副骨架
 *     （causal/reading）各自挂载实例互不干扰；贴右/下视缘时按菜单尺寸估计钳进
 *     视口（CR-20——旧版直接裁切出屏，右/下缘项不可达且无关闭目标）；
 *   - 透明 backdrop（fixed inset 0）吃外点点击 → 关闭；Esc → 关闭；contextmenu 到
 *     backdrop 上也关闭（松手第二次右键不弹浏览器默认菜单——preventDefault）；
 *   - 调用方保证 contextmenu 事件已 `stopPropagation + preventDefault`（菜单语义不吞
 *     格子自身的 click/drag）。
 *
 * 样式照 agent-panel 下拉先例（structure.css 批次 A 节）。纯呈现：items 由调用方构造，
 * 本组件不做任何数据访问。
 */
export type ContextMenuItem =
  | {
      kind: 'action';
      key: string;
      label: string;
      /** 危险项（删除）红字。 */
      danger?: boolean;
      /** 次要说明（如「将断开 N 条因果边」）。 */
      hint?: string;
      disabled?: boolean;
      onPick: () => void;
    }
  | { kind: 'separator'; key: string };

export type TimelineContextMenuProps = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  ariaLabel: string;
};

// ── CR-20：fixed 定位贴视缘钳制的尺寸估计（预留量）──
// 宽度按 CSS .timeline-ctx-menu 的 max-width 280 最坏预留；行高/分隔线/padding 按
// 现行 token 组合估（12px 字 + space-3xs 垂直 padding）。估计只影响钳制余量——
// 偏差表现为菜单离视缘稍远/稍近，不再裁切出屏即可达。
export const CONTEXT_MENU_WIDTH_ESTIMATE = 280;
const ITEM_HEIGHT_ESTIMATE = 28;
const SEPARATOR_HEIGHT_ESTIMATE = 5;
const VERTICAL_PADDING_ESTIMATE = 8;

/** items → 菜单渲染高度估计（CR-20 clamp 的垂直预留量）。 */
export function estimateContextMenuHeight(items: ContextMenuItem[]): number {
  return items.reduce(
    (h, item) => h + (item.kind === 'separator' ? SEPARATOR_HEIGHT_ESTIMATE : ITEM_HEIGHT_ESTIMATE),
    VERTICAL_PADDING_ESTIMATE
  );
}

/**
 * CR-20：把鼠标点钳进视口（预留菜单尺寸估计）。贴右/下缘时整体移入视口（旧行
 * 为直接裁切出屏——右/下缘项不可达且无关闭目标）；左/上缘同理钳 0。视口比估计
 * 还小时退化为 0（尽量可达）。纯函数，单测锁定。
 */
export function clampContextMenuPosition(
  x: number,
  y: number,
  estimatedMenuWidth: number,
  estimatedMenuHeight: number,
  viewportWidth: number,
  viewportHeight: number
): { left: number; top: number } {
  const left = Math.max(0, Math.min(x, viewportWidth - estimatedMenuWidth));
  const top = Math.max(0, Math.min(y, viewportHeight - estimatedMenuHeight));
  return { left, top };
}

export function TimelineContextMenu({ x, y, items, onClose, ariaLabel }: TimelineContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // CR-20：fixed 定位前钳进视口（预留菜单尺寸——宽度最坏 280，高度按 items 估计）。
  const { left, top } = clampContextMenuPosition(
    x,
    y,
    CONTEXT_MENU_WIDTH_ESTIMATE,
    estimateContextMenuHeight(items),
    typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth,
    typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerHeight
  );

  // Esc 关闭（backdrop 拿不到焦点——监听 window keydown；菜单是短命浮层，effect 随卸载清）。
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 菜单项键盘导航：ArrowUp/Down + Enter（可聚焦 action 项间移动）。方向键默认滚动被
  // preventDefault 拦下（菜单打开时不滚格子）。
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    if (buttons.length === 0) return;
    e.preventDefault();
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Enter') {
      // Enter 落在聚焦按钮上浏览器原生触发 click；无聚焦时激活首项（键盘可达兜底）。
      if (idx === -1) buttons[0]?.click();
      return;
    }
    const next = e.key === 'ArrowDown' ? (idx + 1) % buttons.length : (idx - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <>
      {/* backdrop：吃外点（click/contextmenu）→ 关闭。z 序压在内容上、菜单下。 */}
      <div
        className="timeline-ctx-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        data-testid="timeline-ctx-backdrop"
      />
      <div
        ref={menuRef}
        className="timeline-ctx-menu"
        role="menu"
        aria-label={ariaLabel}
        style={{ left, top }}
        onKeyDown={handleKeyDown}
        data-testid="timeline-ctx-menu"
      >
        {items.map((item) =>
          item.kind === 'separator' ? (
            <div key={item.key} className="timeline-ctx-sep" role="separator" />
          ) : (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`timeline-ctx-item${item.danger ? ' timeline-ctx-item--danger' : ''}`}
              disabled={item.disabled}
              data-menu-key={item.key}
              onClick={() => {
                onClose();
                item.onPick();
              }}
            >
              <span className="timeline-ctx-item-label">{item.label}</span>
              {item.hint && <span className="timeline-ctx-item-hint">{item.hint}</span>}
            </button>
          )
        )}
      </div>
    </>
  );
}
