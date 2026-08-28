/**
 * 窗口状态持久化校验（dogfood 2026-08-21）：纯函数表驱动——数字健全 + 与任一
 * 工作区相交才恢复；显示器拔掉/换分辨率 → null → 默认居中，绝不恢复到屏幕外。
 */
import { describe, expect, it } from 'vitest';
import { validateWindowState } from '../main/windowState';

const MAIN_DISPLAY = { x: 0, y: 0, width: 2560, height: 1440 };
const SECOND_DISPLAY = { x: 2560, y: 0, width: 1920, height: 1080 };

describe('validateWindowState', () => {
  it('合法且落在主屏 → 原样返回', () => {
    const r = validateWindowState(
      { x: 100, y: 80, width: 1440, height: 960, isMaximized: true },
      [MAIN_DISPLAY, SECOND_DISPLAY],
    );
    expect(r).toEqual({ x: 100, y: 80, width: 1440, height: 960, isMaximized: true });
  });

  it('落在第二台显示器 → 恢复到第二台', () => {
    const r = validateWindowState(
      { x: 2600, y: 0, width: 1200, height: 800 },
      [MAIN_DISPLAY, SECOND_DISPLAY],
    );
    expect(r).not.toBeNull();
    expect(r!.x).toBe(2600);
  });

  it('显示器已拔（只余主屏，存档在第二屏）→ null 走默认居中', () => {
    const r = validateWindowState(
      { x: 2600, y: 0, width: 1200, height: 800 },
      [MAIN_DISPLAY],
    );
    expect(r).toBeNull();
  });

  it('完全不相交坐标（负空间）→ null', () => {
    expect(validateWindowState(
      { x: -5000, y: -5000, width: 1440, height: 960 },
      [MAIN_DISPLAY],
    )).toBeNull();
  });

  it('字段缺失/非数字/过小尺寸 → null', () => {
    expect(validateWindowState(null, [MAIN_DISPLAY])).toBeNull();
    expect(validateWindowState({}, [MAIN_DISPLAY])).toBeNull();
    expect(validateWindowState({ x: 0, y: 0, width: 'wide' as unknown, height: 960 }, [MAIN_DISPLAY])).toBeNull();
    expect(validateWindowState({ x: 0, y: 0, width: 100, height: 960 }, [MAIN_DISPLAY])).toBeNull();
    expect(validateWindowState({ x: 0, y: Number.NaN, width: 1440, height: 960 }, [MAIN_DISPLAY])).toBeNull();
  });

  it('isMaximized 仅接受布尔 true，其余 falsy 归 false', () => {
    const r = validateWindowState(
      { x: 0, y: 0, width: 1440, height: 960, isMaximized: 'yes' as unknown },
      [MAIN_DISPLAY],
    );
    expect(r!.isMaximized).toBe(false);
  });
});
