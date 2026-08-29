// worker 拆卸崩溃病根兜底——DB 句柄显式 close + 终结器排干（08-29 vitest 4 迁移专项 S1）：
// 每个测试文件收尾时关闭 main/db 模块级单例句柄（closeDb 含 sqlite-vec 扩展态
// 复位），随后强制 GC——两段合起来把 better-sqlite3 ObjectWrap 的析构确定性
// 挪到 env 活着时执行，压掉 worker 拆卸期的原生崩彩票（node ObjectWrap 拆卸
// 回归 nodejs/node#65195 家族：任何在 env 死后析构的 wrapper 都会撞
// `RemoveEnvironmentCleanupHook (env) != nullptr` 断言 abort）。
//
// 动态 import 放 afterAll 内（非顶层静态 import）：几乎每个 shell 测试文件先
// vi.mock('electron', ...) 再 import '../main/db/index'——setup 静态 import 会先以
// 未 mock 的 electron（app=undefined）把 db/index 钉进模块缓存，而 vi.mock 不作用于
// 已缓存模块 → 该文件全部 getDb() 调用崩掉。afterAll 时点解析到测试已加载的同一单例。
//
// 容错（10 文件 vi.mock 掉整个 db/index 不导 closeDb 的形态）：mock 模块无真句柄
// 可关——typeof 守卫 + try/catch 静默跳过，不为兜底钩子本身制造 suite 级红。
//
// 运行时启 gc：--expose-gc 对 worker_threads 的 execArgv 非法（node 直接
// ERR_WORKER_INVALID_EXEC_ARGV），改用 v8.setFlagsFromString + vm 新上下文取回
// （node 官方 trick，threads/forks 两池通用）。失败则静默 no-op。
import { afterAll } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';

try {
  v8.setFlagsFromString('--expose_gc');
  (globalThis as { gc?: () => void }).gc = vm.runInNewContext('gc') as () => void;
} catch {
  // 运行时启 gc 失败（V8 版本面变化等）——兜底降级为无 gc
}

afterAll(async () => {
  try {
    const mod = (await import('../main/db/index')) as { closeDb?: () => void };
    if (typeof mod.closeDb === 'function') mod.closeDb();
  } catch {
    // mock 形态解析失败——无真句柄，无物可关
  }
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
    gc();
  }
});
