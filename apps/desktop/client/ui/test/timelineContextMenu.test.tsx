/**
 * dogfood R2 CR-20：时间线右键菜单 fixed 定位贴视缘钳制。
 *
 * 旧行为：`left: clientX / top: clientY` 直落——贴右/下视缘时菜单裁切出屏，
 * 右/下缘菜单项不可达且无关闭目标（backdrop 在菜单下层，被裁走的区域点不到）。
 * 修复：clampContextMenuPosition 按菜单尺寸估计把落点钳进视口。纯函数 + 渲染两层。
 *
 * Run: `cd apps/desktop/client/ui && pnpm test timelineContextMenu`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampContextMenuPosition,
  CONTEXT_MENU_WIDTH_ESTIMATE,
  estimateContextMenuHeight,
  TimelineContextMenu,
  type ContextMenuItem,
} from '../src/features/structure/TimelineContextMenu';

const ITEMS: ContextMenuItem[] = [
  { kind: 'action', key: 'a', label: 'A', onPick: () => {} },
  { kind: 'separator', key: 'sep' },
  { kind: 'action', key: 'b', label: 'B', onPick: () => {} },
];

describe('clampContextMenuPosition (pure)', () => {
  it('leaves mid-screen points untouched', () => {
    expect(clampContextMenuPosition(300, 300, 280, 70, 1920, 1080)).toEqual({ left: 300, top: 300 });
  });

  it('right/bottom edge pulls the menu inside the viewport (reserved size)', () => {
    // x=1900 贴右缘 → left = 1920-280；y=1050 贴底缘 → top = 1080-70。
    expect(clampContextMenuPosition(1900, 1050, 280, 70, 1920, 1080)).toEqual({ left: 1640, top: 1010 });
  });

  it('negative points floor at 0 (top/left edge also unreachable)', () => {
    expect(clampContextMenuPosition(-50, -20, 280, 70, 1920, 1080)).toEqual({ left: 0, top: 0 });
  });

  it('viewport smaller than the estimate degrades to 0 (best effort, no negative)', () => {
    expect(clampContextMenuPosition(500, 500, 280, 70, 200, 50)).toEqual({ left: 0, top: 0 });
  });
});

describe('estimateContextMenuHeight', () => {
  it('counts actions at full row height and separators cheap', () => {
    // 2 actions × 28 + separator 5 + padding 8 = 69。
    expect(estimateContextMenuHeight(ITEMS)).toBe(2 * 28 + 5 + 8);
    expect(estimateContextMenuHeight([])).toBe(8);
  });
});

describe('TimelineContextMenu render (jsdom viewport 1024×768)', () => {
  afterEach(() => cleanup());

  it('mid-screen render keeps the click point', () => {
    const { container } = render(
      <TimelineContextMenu x={100} y={100} items={ITEMS} onClose={() => {}} ariaLabel="menu" />
    );
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]') as HTMLElement;
    expect(menu.style.left).toBe('100px');
    expect(menu.style.top).toBe('100px');
  });

  it('edge-point render clamps left/top inside the viewport', () => {
    const { container } = render(
      <TimelineContextMenu x={2000} y={2000} items={ITEMS} onClose={() => {}} ariaLabel="menu" />
    );
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]') as HTMLElement;
    expect(parseFloat(menu.style.left)).toBe(1024 - CONTEXT_MENU_WIDTH_ESTIMATE);
    expect(parseFloat(menu.style.top)).toBe(768 - estimateContextMenuHeight(ITEMS));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R10 因果侧手势矩阵补缺（research/gesture-matrix-r10.md §5 清单落码）：
// 置灰项可达性（R8「置灰而非消失」契约的组件级锚）+ 键盘导航（AC13 MenuEvent
// 零丢失的键盘面）+ backdrop 二连右键关闭。
// ─────────────────────────────────────────────────────────────────────────────

describe('TimelineContextMenu reachability (R10 matrix: 置灰项 + 键盘导航)', () => {
  afterEach(() => cleanup());

  const ITEMS_WITH_DISABLED: ContextMenuItem[] = [
    { kind: 'action', key: 'a', label: 'A', onPick: () => {} },
    { kind: 'action', key: 'b', label: 'B (blocked)', disabled: true, onPick: () => {} },
    { kind: 'action', key: 'c', label: 'C', onPick: () => {} },
  ];

  it('disabled item renders greyed-out (button[disabled]) — 置灰而非消失（R8 契约）', () => {
    const { container } = render(
      <TimelineContextMenu x={100} y={100} items={ITEMS_WITH_DISABLED} onClose={() => {}} ariaLabel="menu" />
    );
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]')!;
    const b = menu.querySelector('[data-menu-key="b"]') as HTMLButtonElement;
    expect(b).not.toBeNull(); // 项仍在 DOM（不消失）
    expect(b.disabled).toBe(true); // 置灰
    const a = menu.querySelector('[data-menu-key="a"]') as HTMLButtonElement;
    expect(a.disabled).toBe(false);
  });

  it('clicking a disabled item never fires onPick（写通道不因合成点击穿透）', () => {
    const onPick = vi.fn();
    const items: ContextMenuItem[] = [
      { kind: 'action', key: 'blocked', label: 'X', disabled: true, onPick },
    ];
    const { container } = render(
      <TimelineContextMenu x={100} y={100} items={items} onClose={() => {}} ariaLabel="menu" />
    );
    fireEvent.click(container.querySelector('[data-menu-key="blocked"]')!);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('keyboard nav skips disabled items (ArrowDown moves through the enabled-only ring)', () => {
    const { container } = render(
      <TimelineContextMenu x={100} y={100} items={ITEMS_WITH_DISABLED} onClose={() => {}} ariaLabel="menu" />
    );
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]') as HTMLElement;
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).dataset.menuKey).toBe('a');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    // b 为 disabled——键盘环（button:not([disabled])）跳过它直接落到 c。
    expect((document.activeElement as HTMLElement).dataset.menuKey).toBe('c');
  });

  it('Enter with no focused item activates the first enabled item (keyboard bootstrap)', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [
      { kind: 'action', key: 'first', label: 'F', onPick },
      { kind: 'action', key: 'blocked', label: 'B', disabled: true, onPick: () => {} },
    ];
    const { container } = render(
      <TimelineContextMenu x={100} y={100} items={items} onClose={onClose} ariaLabel="menu" />
    );
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]') as HTMLElement;
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1); // 首个可用项（disabled 排除在外）
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop contextmenu closes the menu（二连右键松手不弹浏览器默认菜单）', () => {
    const onClose = vi.fn();
    const { container } = render(
      <TimelineContextMenu x={100} y={100} items={ITEMS} onClose={onClose} ariaLabel="menu" />
    );
    const backdrop = container.querySelector('[data-testid="timeline-ctx-backdrop"]') as HTMLElement;
    fireEvent.contextMenu(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
