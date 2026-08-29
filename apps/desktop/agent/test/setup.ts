// worker 拆卸崩溃病根兜底——DB 句柄显式 close + 终结器排干（08-29 vitest 4 迁移专项 S1）：
// 每个测试文件收尾时关掉 persistence 模块级 dbCache 里的全部 per-project index.db，
// 随后强制 GC——两段合起来把 better-sqlite3 ObjectWrap 的析构确定性挪到 env 活着时
// 执行，压掉 worker 拆卸期的原生崩彩票（node ObjectWrap 拆卸回归 nodejs/node#65195：
// 任何在 env 死后析构的 wrapper 都会撞 `RemoveEnvironmentCleanupHook (env) != nullptr`
// 断言 abort）。
//
// 动态 import 放 afterAll 内（非顶层静态 import）：setupFiles 先于测试文件的
// vi.mock 注册执行，静态 import 会把 persistence 及其依赖以真实实现提前钉进模块
// 缓存，而 vi.mock 不作用于已缓存模块——会使测试文件对 '../src/skill/discovery'
// 等的 mock 失效。afterAll 时点 registry 已就绪，动态 import 解析到与测试同一实例
// （同形态先例：runtime 族测试 afterEach 内 `await import('../src/agent/persistence')`）。
//
// 运行时启 gc：--expose-gc 对 worker_threads execArgv 非法（node
// ERR_WORKER_INVALID_EXEC_ARGV），改 v8.setFlagsFromString + vm 新上下文取回
// （node 官方 trick，forks/threads 两池通用）。失败静默 no-op。
import { afterAll } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';

try {
  v8.setFlagsFromString('--expose_gc');
  (globalThis as { gc?: () => void }).gc = vm.runInNewContext('gc') as () => void;
} catch {
  // 运行时启 gc 失败——兜底降级为无 gc
}

afterAll(async () => {
  const { closeAllDbs } = await import('../src/agent/persistence');
  closeAllDbs();
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
    gc();
  }
});
