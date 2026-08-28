/**
 * consoleRing —— dev 态错误环（R9「Agent 自调试基建」渲染侧）。
 *
 * 目标：AI 附着式调试不必依赖主会话现场盯着 console——renderer 把近期发生的错误
 * 先落入 window.__orisonErrors 环形缓冲（容量 200，超限淘汰最旧），事后经
 * apps/desktop/e2e/src/attach.ts 的 `GET /errors` 路由按需读取（`?clear=1` 读取即清）。
 *
 * 挂载纪律（唯一挂载点）：shell/renderer/main.tsx 在 `if (import.meta.env.DEV)`
 * 分支内调用本模块的 installDevErrorRing。生产构建中该常量被 define 静态替换为
 * false、分支随之消除，本文件顶层零副作用即可被 rollup 整模块剔除——线上零字节
 * 引入。因此**本文件自身不做任何运行时环境判断**，DEV 门禁完全落在调用点。
 *
 * 跨包镜像约定：缓冲键名与条目形状以本文件为单源；attach.ts 里的同名键字符串与
 * 输出装配是消费侧镜像（两侧无 workspace 依赖可供共享，沿用 ADR-4 手动同步惯例）
 * ——改动键名或条目字段时必须两处同步。
 */
declare global {
  /**
   * 显式声明 vite/client 的标准形态，使本文件在被任一侧编译（ui 包 vitest 由
   * vite 注入；shell renderer 由 electron-vite 编译）时都能拿到确定的
   * import.meta.env 类型。成员形状与 vite/client 一致，重复合并安全。
   */
  interface ImportMetaEnv {
    readonly DEV: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/** 环形缓冲容量：200 条足覆盖一轮回归会话，超出后淘汰最旧。 */
export const ERROR_RING_CAPACITY = 200;

/** 暴露在 window 上的缓冲键名（attach.ts 消费侧镜像此同名字符串）。 */
export const ERROR_RING_WINDOW_KEY = '__orisonErrors';

/** 条目主消息长度上限。 */
export const ERROR_MESSAGE_MAX_CHARS = 500;

/** 条目堆栈/详情长度上限。 */
export const ERROR_STACK_MAX_CHARS = 1000;

/** 一条被捕获的错误记录。t 区分来源族；s 仅在拿到可用详情时才存在。 */
export interface OrisonErrorEntry {
  /** err = 未捕获脚本异常（error 事件）；reject = 未处理的 promise rejection；console = console.error */
  t: 'err' | 'reject' | 'console';
  /** 主消息（截断至 ERROR_MESSAGE_MAX_CHARS）。 */
  m: string;
  /** 堆栈或附加详情（截断至 ERROR_STACK_MAX_CHARS；拿不到则省略整个字段）。 */
  s?: string;
  /** 捕获时刻毫秒时间戳（attach 侧据此定位发生时段）。 */
  at: number;
}

/** 捕获窗口 error 事件所需的细节（对应 ErrorEvent 各字段的宽松化）。 */
export interface WindowErrorDetail {
  message?: string | null;
  source?: string | null;
  lineno?: number | null;
  colno?: number | null;
  error?: unknown;
}

/**
 * 数据核心：环形缓冲 + 三种来源的捕获函数。纯数据层、与宿主解耦，
 * 便于在不依赖真实浏览器事件构造能力的前提下逐一验证形状与容量行为。
 */
export interface OrisonErrorSink {
  /** 当前缓冲（同一数组实例的只读视图——读取方依赖引用恒定做原地清空）。 */
  entries(): readonly OrisonErrorEntry[];
  captureConsole(args: readonly unknown[]): void;
  captureWindowError(detail: WindowErrorDetail): void;
  captureUnhandledRejection(reason: unknown): void;
}

/** 松散文本化：string 直接使用；对象尝试 JSON 序列化（循环引用等失败回退 String()）。 */
function looseText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 尽力从 Error 形状的值上取堆栈；取不到返回 undefined（调用方据此省略 s 字段）。
 * `.stack` 可能是敌意 getter（throwing accessor）：必须在捕获端消化掉，否则错误环
 * 自己在 error/unhandledrejection 监听器里抛错——可递归派发 error 事件。
 */
function stackOf(errorLike: unknown): string | undefined {
  if (errorLike == null) return undefined;
  if (typeof errorLike === 'object' && 'stack' in errorLike) {
    let candidate: unknown;
    try {
      candidate = (errorLike as { stack?: unknown }).stack;
    } catch {
      return undefined;
    }
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const textual = looseText(errorLike).trim();
  return textual || undefined;
}

function windowErrorMessage(detail: WindowErrorDetail): string {
  const parts: string[] = [];
  const message = (detail.message ?? '').trim();
  if (message) parts.push(message);
  const source = detail.source?.trim();
  if (source) {
    const coords = [detail.lineno, detail.colno]
      .filter((n): n is number => typeof n === 'number')
      .join(':');
    parts.push(coords ? `(${source}:${coords})` : `(${source})`);
  }
  return clip(parts.join(' '), ERROR_MESSAGE_MAX_CHARS) || 'unknown script error';
}

export function createErrorRing(capacity: number = ERROR_RING_CAPACITY): OrisonErrorSink {
  // 容量钳制：0/负数会把环变成黑洞（每条进即弃、缓冲恒空静默吞记录），NaN 永不
  // 触发淘汰、无界增长——两类非法容量统一回落默认值；小数向下取整保整数边界。
  const cap =
    Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : ERROR_RING_CAPACITY;
  const buffer: OrisonErrorEntry[] = [];
  const push = (entry: OrisonErrorEntry): void => {
    buffer.push(entry);
    if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
  };
  const pushOptionalStack = (
    t: OrisonErrorEntry['t'],
    m: string,
    errorLike: unknown,
  ): void => {
    const stack = stackOf(errorLike);
    push({ t, m, at: Date.now(), ...(stack ? { s: clip(stack, ERROR_STACK_MAX_CHARS) } : {}) });
  };
  return {
    entries: () => buffer,

    captureConsole(args) {
      const joined = args.map((arg) => looseText(arg)).join(' ').trim();
      push({ t: 'console', m: clip(joined || '(empty console.error)', ERROR_MESSAGE_MAX_CHARS), at: Date.now() });
    },

    captureWindowError(detail) {
      pushOptionalStack('err', windowErrorMessage(detail), detail.error);
    },

    captureUnhandledRejection(reason) {
      // reason 的 name/message 同样可能是敌意 getter：主描述与兜底序列化都必须在
      // 捕获端消化——否则 unhandledrejection 监听器因「记录错误」再抛错，原始
      // reason 从此丢失（连占位条目都没有）。
      let main: string;
      try {
        main = reason instanceof Error
          ? `${reason.name}: ${reason.message}`
          : looseText(reason) || String(reason);
      } catch {
        try {
          main = looseText(reason) || String(reason);
        } catch {
          // 敌意 toString 连兜底序列化也炸时给无参占位，绝不反噬监听器。
          main = '(rejection reason threw while serializing)';
        }
      }
      pushOptionalStack('reject', clip(main, ERROR_MESSAGE_MAX_CHARS), reason);
    },
  };
}

const installations = new WeakMap<Window, () => void>();

/** 结构化取宿主 console（部分编译程序里 bare Window 上不声明 console 成员，须按形状访问）。 */
type ConsoleErrorHost = { error: (...data: unknown[]) => void };
function resolveConsoleErrorHost(win: Window): ConsoleErrorHost | undefined {
  const candidate = (win as unknown as { console?: Partial<ConsoleErrorHost> }).console;
  return candidate && typeof candidate.error === 'function'
    ? (candidate as ConsoleErrorHost)
    : undefined;
}

/**
 * 在指定窗口挂载错误环：绑定 error / unhandledrejection 监听器，包装
 * console.error 并把实时缓冲暴露到 window.__orisonErrors。重复调用幂等
 * （返回首次挂载的卸载函数，绝不重复绑定——HMR 与多次引导均安全）。
 * 返回卸载函数：摘除监听器并把 console.error 还原为原函数（缓冲区保留）。
 */
export function installDevErrorRing(
  win: Window,
  capacity: number = ERROR_RING_CAPACITY,
): () => void {
  const existing = installations.get(win);
  if (existing) return existing;

  const sink = createErrorRing(capacity);

  const onError = (event: Event): void => {
    // 资源加载失败（img/script 404 等）派发的是普通 Event 不是 ErrorEvent：
    // 无 message 无堆栈，纯属噪声，跳过。
    if (!(event instanceof ErrorEvent)) return;
    sink.captureWindowError({
      message: event.message,
      source: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error,
    });
  };
  const onUnhandledRejection = (event: Event): void => {
    sink.captureUnhandledRejection((event as { reason?: unknown }).reason);
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onUnhandledRejection);

  const consoleHost = resolveConsoleErrorHost(win);
  const pristineConsoleError = consoleHost?.error;
  const captureConsoleError = ((...args: unknown[]): void => {
    sink.captureConsole(args);
    if (pristineConsoleError) Reflect.apply(pristineConsoleError, consoleHost, args);
  }) as ConsoleErrorHost['error'];
  if (consoleHost && pristineConsoleError) {
    consoleHost.error = captureConsoleError;
  }

  // 暴露实时缓冲本体（引用恒定）：attach 读取方按 Array.isArray 判存在，
  // 以 length=0 实现「读取即清」的原地清空语义。
  (win as unknown as Record<string, unknown>)[ERROR_RING_WINDOW_KEY] = sink.entries();

  const uninstall = (): void => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onUnhandledRejection);
    // 自除挂载记录必须先于「他人已再包一层」的早退：否则该路径会把本失效闭包
    // 残留在 installations 里，之后 installDevErrorRing 幂等短路到它——错误环
    // 从此永不重绑（监听器与 console 包装双双失联）。身份核对防双卸载误删。
    if (installations.get(win) === uninstall) installations.delete(win);
    // 他人若在我们之后又包了一层 console.error，则不动它（只还原自家包装）。
    if (!consoleHost || consoleHost.error !== captureConsoleError) return;
    consoleHost.error = pristineConsoleError!;
  };
  installations.set(win, uninstall);
  return uninstall;
}
