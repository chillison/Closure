import { afterEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// CR-008（08-29）：watchFactory 生产默认分支测试钉。R3 的硬门是「factory 默认实现
// 与原语句 `watch(dir, { recursive: true }, cb)` 逐字等价」，但该分支此前零断言——
// options 被改形（丢 recursive / 多键）不会红。本文件 mock `node:fs` 的 watch 钉
// 三态：默认分支精确参数 / 注入分支全接管（真 fs.watch 零触碰）/ null 复位回真分支。
// 五个 watcher 的行为面（debounce/过滤/串行化/生命周期）在各自测试——合成事件源。
// ─────────────────────────────────────────────────────────────────────────────

const watchMock = vi.hoisted(() => vi.fn(() => ({ close() {}, on() {} })));
vi.mock('node:fs', () => ({ watch: watchMock }));

import { setWatchFactory, watchDir } from '../main/fs/watchFactory';

describe('watchFactory（R3 注入缝——CR-008 三态钉）', () => {
  afterEach(() => {
    setWatchFactory(null); // 复位生产默认（防注入态泄漏进后续测试）
    vi.clearAllMocks();
  });

  it('默认分支：无注入时走真 fs.watch——(dir, { recursive: true }, cb) 逐字（options 无多无漏）', () => {
    const cb = (_event: string, _filename: string | null) => {};
    watchDir('C:/proj', cb);

    expect(watchMock).toHaveBeenCalledTimes(1);
    // toHaveBeenCalledWith 对每参 deep-equal：第二参恰为 { recursive: true }——
    // 多键/少键/改值都红（「逐字等价」硬门的断言守卫）。
    expect(watchMock).toHaveBeenCalledWith('C:/proj', { recursive: true }, cb);
  });

  it('默认分支返回值透传 fs.watch 句柄（DirWatcher 切片：close/on 可用）', () => {
    const sentinel = { close: vi.fn(), on: vi.fn() };
    watchMock.mockReturnValueOnce(sentinel);

    const handle = watchDir('C:/proj', () => {});

    expect(handle).toBe(sentinel);
    expect(typeof handle.close).toBe('function');
    expect(typeof handle.on).toBe('function');
  });

  it('注入分支：setWatchFactory(fake) 后全走 fake——真 fs.watch 零触碰，句柄原样返回', () => {
    const fakeHandle = { close() {}, on() {} };
    const fake = vi.fn(() => fakeHandle);
    setWatchFactory(fake);

    const cb = (_event: string, _filename: string | null) => {};
    const handle = watchDir('C:/watched', cb);

    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake).toHaveBeenCalledWith('C:/watched', cb);
    expect(handle).toBe(fakeHandle);
    expect(watchMock).not.toHaveBeenCalled();
  });

  it('复位分支：setWatchFactory(null) 后再走生产默认真 fs.watch', () => {
    setWatchFactory(() => ({ close() {}, on() {} })); // 先入注入态
    setWatchFactory(null);

    const cb = (_event: string, _filename: string | null) => {};
    watchDir('C:/after-reset', cb);

    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledWith('C:/after-reset', { recursive: true }, cb);
  });
});
