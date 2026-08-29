// worker 拆卸崩溃病根兜底——DB 句柄显式 close（08-29 vitest 4 迁移专项 S1）：
// 每个测试文件收尾时关闭 main/db 模块级单例句柄（closeDb 含 sqlite-vec 扩展态
// 复位），使 worker 拆卸期不再析构未 close 的 better-sqlite3 句柄。
//
// 动态 import 放 afterAll 内（非顶层静态 import）：几乎每个 shell 测试文件先
// vi.mock('electron', ...) 再 import '../main/db/index'——setup 静态 import 会先以
// 未 mock 的 electron（app=undefined）把 db/index 钉进模块缓存，而 vi.mock 不作用于
// 已缓存模块 → 该文件全部 getDb() 调用崩掉。afterAll 时点解析到测试已加载的同一单例。
//
// 容错（10 文件 vi.mock 掉整个 db/index 不导 closeDb 的形态）：mock 模块无真句柄
// 可关——typeof 守卫 + try/catch 静默跳过，不为兜底钩子本身制造 suite 级红。
import { afterAll } from 'vitest';

afterAll(async () => {
  try {
    const mod = (await import('../main/db/index')) as { closeDb?: () => void };
    if (typeof mod.closeDb === 'function') mod.closeDb();
  } catch {
    // mock 形态解析失败——无真句柄，无物可关
  }
});
