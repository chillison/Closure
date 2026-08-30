import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WORLD_CHANGED_CHANNEL } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #92 · BMad CR #7+#105/#8：preload world:changed 订阅缝。
//
// 修复的 bug：旧实现用 WeakMap<callback, wrapper> 记订阅簿记——① WeakMap 条目随 callback 可达性
// 可被 GC（登记不保证存活到显式退订）；② 同 callback 重复订阅时 set() 覆盖 Map 键但**旧 wrapper
// 仍挂在 channel 上**（每事件双调 callback），且 offWorldChanged 只能摘到最新那条。修复 = Map +
// 重复订阅守卫（先 removeListener 旧 wrapper 再挂新）+ 退订只摘本订阅 wrapper。
// 同场断言通道名单源（CR #8）：preload 与 shell worldNotify 共引 contracts WORLD_CHANGED_CHANNEL。
// ─────────────────────────────────────────────────────────────────────────────

const ipcRenderer = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer,
  webUtils: { getPathForFile: vi.fn() },
}));

import { exposedDesktopApi } from '../preload/index';
import type { WorldChangedEvent } from '@orison/shared-contracts';

/** 某 callback 当前（最新）注册在 channel 上的 wrapper。 */
function registeredWrappers(): Array<(_e: unknown, event: WorldChangedEvent) => void> {
  return ipcRenderer.on.mock.calls.map((c) => c[1] as (_e: unknown, event: WorldChangedEvent) => void);
}

function lastRemoved(): unknown {
  const calls = ipcRenderer.removeListener.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][1] : undefined;
}

beforeEach(() => {
  ipcRenderer.on.mockClear();
  ipcRenderer.removeListener.mockClear();
});

describe('preload world:changed 订阅缝（BMad CR #7+#105）', () => {
  it('订阅：以单源常量 WORLD_CHANGED_CHANNEL 注册 wrapper；事件经 wrapper 回调原 callback', () => {
    const cb = vi.fn();
    const unsub = exposedDesktopApi.onWorldChanged(cb);

    expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
    // 通道名单源（CR #8）——preload 与 contracts 常量同串，非硬编码漂移面。
    expect(ipcRenderer.on.mock.calls[0][0]).toBe(WORLD_CHANGED_CHANNEL);
    expect(WORLD_CHANGED_CHANNEL).toBe('world:changed');

    const wrapper = registeredWrappers()[0];
    const event: WorldChangedEvent = { projectId: '00004', kind: 'backfill' };
    wrapper(undefined, event);
    expect(cb).toHaveBeenCalledWith(event);

    expect(typeof unsub).toBe('function');
  });

  it('退订函数：摘本订阅 wrapper（removeListener 本监听器，非 removeAllListeners）；幂等', () => {
    const cb = vi.fn();
    const unsub = exposedDesktopApi.onWorldChanged(cb);
    const wrapper = registeredWrappers().at(-1)!;

    unsub();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(WORLD_CHANGED_CHANNEL, wrapper);

    // 幂等：二次退订不再触发 removeListener（map 已删，get !== listener）。
    unsub();
    expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
  });

  it('重复订阅守卫：同 callback 再订阅先摘旧 wrapper 再挂新——channel 上恒至多一条', () => {
    const cb = vi.fn();
    exposedDesktopApi.onWorldChanged(cb);
    const wrapper1 = registeredWrappers().at(-1)!;
    exposedDesktopApi.onWorldChanged(cb); // 重复订阅（如面板重开/StrictMode 双调场景）
    const wrapper2 = registeredWrappers().at(-1)!;

    // 守卫：旧 wrapper 被显式摘除（不残留双份），新 wrapper 是新函数。
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(WORLD_CHANGED_CHANNEL, wrapper1);
    expect(wrapper2).not.toBe(wrapper1);
    expect(ipcRenderer.on).toHaveBeenCalledTimes(2);

    // 新 wrapper 是当前生效面：事件回调仍达 callback（一次注册一份回调）。
    wrapper2(undefined, { projectId: 'p', kind: 'reset' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('offWorldChanged：按 callback 摘当前 wrapper；未订阅/已退订再 off 是 no-op', () => {
    const cb = vi.fn();
    exposedDesktopApi.onWorldChanged(cb);
    const wrapper = registeredWrappers().at(-1)!;

    exposedDesktopApi.offWorldChanged(cb);
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(WORLD_CHANGED_CHANNEL, wrapper);

    exposedDesktopApi.offWorldChanged(cb); // 已退订
    exposedDesktopApi.offWorldChanged(() => undefined); // 从未订阅
    expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
  });

  it('多 callback 隔离：摘 A 不动 B（各自 wrapper 独立，removeListener 只收自己的 wrapper）', () => {
    const cbA = vi.fn();
    const cbB = vi.fn();
    exposedDesktopApi.onWorldChanged(cbA);
    const wrapperA = registeredWrappers().at(-1)!;
    exposedDesktopApi.onWorldChanged(cbB);
    const wrapperB = registeredWrappers().at(-1)!;

    exposedDesktopApi.offWorldChanged(cbA);
    expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
    expect(lastRemoved()).toBe(wrapperA);
    expect(lastRemoved()).not.toBe(wrapperB);

    // B 仍生效。
    wrapperB(undefined, { projectId: 'p', kind: 'slice-written', sliceT: 2, subjectIds: ['a'] });
    expect(cbB).toHaveBeenCalledTimes(1);
    expect(cbA).toHaveBeenCalledTimes(0);
  });
});
