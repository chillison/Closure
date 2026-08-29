// worker 拆卸崩溃病根兜底——DB 句柄显式 close（08-29 vitest 4 迁移专项 S1）：
// 每个测试文件收尾时关掉 persistence 模块级 dbCache 里的全部 per-project index.db，
// 使 worker 拆卸期不再析构未 close 的 better-sqlite3 句柄。
//
// 动态 import 放 afterAll 内（非顶层静态 import）：setupFiles 先于测试文件的
// vi.mock 注册执行，静态 import 会把 persistence 及其依赖以真实实现提前钉进模块
// 缓存，而 vi.mock 不作用于已缓存模块——会使测试文件对 '../src/skill/discovery'
// 等的 mock 失效。afterAll 时点 registry 已就绪，动态 import 解析到与测试同一实例
// （同形态先例：runtime 族测试 afterEach 内 `await import('../src/agent/persistence')`）。
//
// ⚠️ 覆盖范围边界（08-29 主会话实证，详 research/db-handle-census.md §四）：
// 此钩子只关「文件收尾时已在 cache 里」的句柄；最后 afterAll 之后由未 await 的
// 异步尾巴（chain 族迟到 createSession/persistSession）新开的 Database 无人再关
// （worker 死于 assert abort——exit/beforeExit/信号钩子均不触发）——该残余向量
// 的处结走 design §2.4 决策，本钩子不作虚功承诺。
import { afterAll } from 'vitest';

afterAll(async () => {
  const { closeAllDbs } = await import('../src/agent/persistence');
  closeAllDbs();
  // S1 根治实验②：终结器提前排干——isolate dispose 会强制跑 GC 终结器，已关库的
  // Statement/Database 包装对象在 env 死后析构即触发原生断言。此处显式 gc()（需
  // worker 以 --expose-gc 跑，经 NODE_OPTIONS 或 poolOptions execArgv）把终结器
  // 挪到 env 活着时执行。无 gc 时 no-op。
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
});
