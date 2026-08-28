/**
 * consoleRing 单测 —— R9「Agent 自调试基建」渲染侧错误环。
 *
 * 覆盖：三来源形状 / 截断上限 / 环形覆盖与缓冲引用恒定 / 挂载幂等 /
 * 卸载还原 / window.__orisonErrors 原地清空语义，外加一条跨包契约锁：
 * 渲染入口必须保留 import.meta.env.DEV 守卫——那是「生产构建零字节引入」
 * 与「DEV=false 不挂载」的唯一执行点（守卫在调用点、模块自身不判环境）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ERROR_MESSAGE_MAX_CHARS,
  ERROR_RING_CAPACITY,
  ERROR_RING_WINDOW_KEY,
  ERROR_STACK_MAX_CHARS,
  createErrorRing,
  installDevErrorRing,
  type OrisonErrorEntry,
} from '../src/shared/dev/consoleRing';

const installedUninstalls: Array<() => void> = [];
const x = (n: number): string => 'x'.repeat(n);

afterEach(() => {
  // jsdom 环境在同文件内共享同一 window：逐条卸载，防监听器跨测试串扰
  while (installedUninstalls.length > 0) {
    installedUninstalls.pop()?.();
  }
});

function install(win: Window = window): () => void {
  const uninstall = installDevErrorRing(win);
  installedUninstalls.push(uninstall);
  return uninstall;
}

const typeOfAll = (entries: readonly OrisonErrorEntry[]): string[] =>
  entries.map((e) => e.t);

describe('createErrorRing（数据层）', () => {
  it('三种捕获源各自产出对应 t 的条目', () => {
    const ring = createErrorRing();
    const boom = new Error('boom');

    ring.captureConsole(['c1', { a: 1 }]);
    ring.captureWindowError({ message: 'w-msg', source: 'app.js', lineno: 12, colno: 34, error: boom });
    ring.captureUnhandledRejection(boom);

    expect(typeOfAll(ring.entries())).toEqual(['console', 'err', 'reject']);
    const [consoleEntry, errEntry, rejectEntry] = ring.entries();
    expect(consoleEntry?.m).toBe('c1 {"a":1}');
    expect(errEntry?.m).toBe('w-msg (app.js:12:34)');
    expect(rejectEntry?.m).toBe('Error: boom');
    for (const entry of ring.entries()) {
      expect(typeof entry.at).toBe('number');
      expect(entry.m.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_CHARS);
    }
  });

  it('m 截断至 500、s 截断至 1000', () => {
    const ring = createErrorRing();

    ring.captureConsole([x(ERROR_MESSAGE_MAX_CHARS + 100)]);
    ring.captureWindowError({ message: 'short', error: new Error(x(ERROR_STACK_MAX_CHARS + 100)) });

    expect(ring.entries()[0]?.m).toHaveLength(ERROR_MESSAGE_MAX_CHARS);
    expect(ring.entries()[1]?.s).toHaveLength(ERROR_STACK_MAX_CHARS);
  });

  it('拿不到堆栈时省略 s 字段而非空串', () => {
    const ring = createErrorRing();

    ring.captureWindowError({ message: 'no error object attached' });

    const entry = ring.entries().at(-1);
    expect(entry?.t).toBe('err');
    expect(entry && 's' in entry).toBe(false);
  });

  it('超容量淘汰最旧，且缓冲引用恒定（原地淘汰，读取方才能安全清空）', () => {
    const ring = createErrorRing(3);
    const stableRef = ring.entries();

    for (let i = 0; i < 5; i += 1) ring.captureConsole([String(i)]);

    expect(ring.entries()).toBe(stableRef); // 同一数组实例
    expect(typeOfAll(ring.entries())).toEqual(['console', 'console', 'console']);
    expect(ring.entries().map((e) => e.m)).toEqual(['2', '3', '4']); // 旧的头两条被挤掉
  });

  it('console 对象参数经 JSON 序列化，循环引用回退 String() 不抛错', () => {
    const ring = createErrorRing();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => ring.captureConsole([cyclic])).not.toThrow();
    expect(ring.entries().at(-1)?.m).toContain('[object Object]');

    ring.captureConsole([{ a: 1 }]);
    expect(ring.entries().at(-1)?.m).toBe('{"a":1}');
  });

  it('.stack 为抛错 getter 时安全省略 s 字段，监听器零反噬', () => {
    const ring = createErrorRing();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'stack', {
      get() {
        throw new TypeError('hostile-stack-getter');
      },
      enumerable: true,
    });

    expect(() => ring.captureWindowError({ message: 'w-hostile', error: hostile })).not.toThrow();
    const entry = ring.entries().at(-1);
    expect(entry?.t).toBe('err');
    expect(entry?.m).toBe('w-hostile');
    expect(entry && 's' in entry).toBe(false);
  });

  it('rejection reason 的 name/message 为抛错 getter 时降级序列化，不炸捕获', () => {
    const ring = createErrorRing();
    const hostile = new Error('secret-payload');
    Object.defineProperty(hostile, 'name', {
      get() {
        throw new TypeError('hostile-name-getter');
      },
      enumerable: true,
    });
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new TypeError('hostile-message-getter');
      },
      enumerable: true,
    });

    expect(() => ring.captureUnhandledRejection(hostile)).not.toThrow();
    const entry = ring.entries().at(-1);
    expect(entry?.t).toBe('reject');
    // 敌意 toString 连兜底序列化都炸时落入无参占位，但条目必须存在且消息非空
    expect(entry?.m).toBe('(rejection reason threw while serializing)');
  });

  it('容量 0/负数/NaN 钳制到默认容量（防黑洞与无界增长）', () => {
    for (const bad of [0, -5, Number.NaN]) {
      const ring = createErrorRing(bad);
      for (let i = 0; i < ERROR_RING_CAPACITY + 10; i += 1) ring.captureConsole([String(i)]);
      expect(ring.entries()).toHaveLength(ERROR_RING_CAPACITY);
      expect(ring.entries().at(-1)?.m).toBe(String(ERROR_RING_CAPACITY + 9));
    }
  });

  it('小数容量向下取整', () => {
    const ring = createErrorRing(2.9);
    for (let i = 0; i < 4; i += 1) ring.captureConsole([String(i)]);
    expect(ring.entries()).toHaveLength(2);
    expect(ring.entries().map((e) => e.m)).toEqual(['2', '3']);
  });
});

describe('installDevErrorRing（jsdom 集成）', () => {
  it('真实事件链路：error / unhandledrejection / console.error 三源各触发一条', async () => {
    install();

    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'boom',
        filename: 'app.js',
        lineno: 12,
        colno: 34,
        error: new Error('boom-stack'),
      }),
    );
    const reason = new Error('rejected-payload');
    if (typeof PromiseRejectionEvent === 'function') {
      window.dispatchEvent(
        new PromiseRejectionEvent('unhandledrejection', {
          reason,
          promise: Promise.resolve(),
        }),
      );
    } else {
      // 环境缺构造器时的兜底形状：处理器只消费 reason 字段
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));
    }
    console.error('logged-via-console', 42);

    const entries = (window as unknown as Record<string, unknown>)[ERROR_RING_WINDOW_KEY] as readonly OrisonErrorEntry[];
    expect(entries.filter((e) => e.t === 'err')).toHaveLength(1);
    expect(entries.find((e) => e.t === 'err')?.m).toBe('boom (app.js:12:34)');
    expect(entries.find((e) => e.t === 'err')?.s).toContain('boom-stack');
    expect(entries.filter((e) => e.t === 'reject')).toHaveLength(1);
    expect(entries.find((e) => e.t === 'reject')?.m).toBe('Error: rejected-payload');
    expect(entries.filter((e) => e.t === 'console')).toHaveLength(1);
    expect(entries.find((e) => e.t === 'console')?.m).toBe('logged-via-console 42');
  });

  it('暴露到 window 的键即环形缓冲本体；length=0 原地清空生效', () => {
    install();

    const exposed = (window as unknown as Record<string, unknown>)[ERROR_RING_WINDOW_KEY] as readonly OrisonErrorEntry[];
    expect(Array.isArray(exposed)).toBe(true);

    console.error('grow-1');
    console.error('grow-2');
    expect(exposed.length).toBe(2); // 同一引用，捕获写入即刻可见

    (exposed as unknown[]).length = 0; // attach.ts GET /errors?clear=1 采用的同款原地清空
    expect(exposed.length).toBe(0);

    window.dispatchEvent(new ErrorEvent('error', { message: 'refilled-after-clear' }));
    expect(exposed.length).toBe(1);
    expect(exposed[0]?.t).toBe('err');
  });

  it('重复挂载幂等：同一事件只被捕获一次', () => {
    install();
    install(); // 第二次应返回首次的卸载函数且不再绑定

    console.error('only-once');

    const entries = (window as unknown as Record<string, unknown>)[ERROR_RING_WINDOW_KEY] as readonly OrisonErrorEntry[];
    expect(entries.filter((e) => e.m === 'only-once')).toHaveLength(1);
  });

  it('uninstall 还原 console.error 本体并停止捕获', () => {
    const pristine = window.console.error;
    const uninstallLocal = install();

    console.error('captured-before-uninstall');
    expect(((window as unknown as Record<string, unknown>)[ERROR_RING_WINDOW_KEY] as readonly OrisonErrorEntry[]).at(-1)?.m).toBe(
      'captured-before-uninstall',
    );

    uninstallLocal();
    expect(window.console.error).toBe(pristine); // 引用还原

    console.error('after-uninstall'); // 还原后错误环已摘除（原样打印，不入环）
    const entries = (window as unknown as Record<string, unknown>)[ERROR_RING_WINDOW_KEY] as readonly OrisonErrorEntry[];
    expect(entries.at(-1)?.m).toBe('captured-before-uninstall');
  });

  it('他人后续包装 console.error 后卸载仍自除挂载记录，重挂载重建全新绑定', () => {
    const pristineError = window.console.error;
    try {
      const uninstallLocal = install();

      // 第三方在我们之后又包了一层 console.error
      const previous = window.console.error;
      window.console.error = ((...args: unknown[]) =>
        Reflect.apply(previous, window.console, args)) as typeof console.error;

      uninstallLocal(); // 命中「包装不一致」早退分支——但必须已自除挂载记录
      installedUninstalls.pop(); // 已手工消费，防 afterEach 二次弹出错位

      // 卸载后：window error 监听器已摘除——事件不再入环。
      // （console 链路例外：第三方包装仍引用着我们的 capture 层继续转发，
      // 这是「只还原自家包装、不拆他人调用链」的既定语义，不入环断言不成立。）
      window.dispatchEvent(new ErrorEvent('error', { message: 'event-after-stale-uninstall' }));
      const exposed = (window as unknown as Record<string, unknown>)[ERROR_RING_WINDOW_KEY] as readonly OrisonErrorEntry[];
      expect(exposed.some((e) => e.m === 'event-after-stale-uninstall')).toBe(false);

      // 关键回归点：重挂载不得幂等短路到已失效闭包——
      // ① 新缓冲取代旧缓冲暴露在 window 键上；② console 与 error 事件双双重绑。
      install();
      const secondExposed = (window as unknown as Record<string, unknown>)[ERROR_RING_WINDOW_KEY] as readonly OrisonErrorEntry[];
      expect(secondExposed).not.toBe(exposed);

      console.error('rebound-after-stale');
      expect(secondExposed.some((e) => e.m === 'rebound-after-stale')).toBe(true);

      window.dispatchEvent(new ErrorEvent('error', { message: 'event-after-reinstall' }));
      expect(secondExposed.some((e) => e.m === 'event-after-reinstall')).toBe(true);
    } finally {
      // 还原链：卸载现存挂载（其还原到第三方的包装），再把最原始 console.error 归位，
      // 防共享 jsdom console 污染后续测试。
      while (installedUninstalls.length > 0) installedUninstalls.pop()?.();
      window.console.error = pristineError;
    }
  });
});

describe('渲染入口契约锁（跨包）', () => {
  it('shell/renderer/main.tsx 在 import.meta.env.DEV 分支内挂载错误环', () => {
    // 从本测试目录上跳三层到 apps/desktop，再进 client/shell/renderer。
    const mainTsxPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../client/shell/renderer/main.tsx',
    );
    const source = readFileSync(mainTsxPath, 'utf-8');

    expect(source).toContain('import.meta.env.DEV');
    expect(source).toContain('installDevErrorRing(');
    // 门禁分支必须先于 React 引导执行，保证启动早期的异常也被记录
    expect(source.indexOf('import.meta.env.DEV')).toBeLessThan(source.indexOf('createRoot('));
  });
});
