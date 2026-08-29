import { defineConfig } from 'vitest/config';

// agent 包 vitest.config 先例（C3.2 超时漂移教训）补齐到 shell：该包测试以重量级集成
// 形态为主（isomorphic-git 快照 / watcher debounce / temp 目录 db / 400 章压测族），
// 正常耗时 2-4s（gitCreateNodeDeletion 单测本机 3.5s、负载下 5.7s），CI 慢机 + 并行
// worker CPU 争用下越过 vitest 默认 5s testTimeout —— 公仓首推 CI 三平台全红即此
// （08-28 release prep 实录）。统一放宽到 30s；断言失败不受影响。
export default defineConfig({
  test: {
    testTimeout: 30_000,
    // 08-29 vitest 4 迁移专项 S1：每测试文件收尾显式关 main/db 单例句柄
    // ——worker 拆卸期不再析构未 close 的 better-sqlite3 Database（详 test/setup.ts）。
    setupFiles: ['./test/setup.ts'],
    // vitest 3 默认 forks 池在 Windows 慢 runner 重负载下有两族进程级噪声：
    // `Timeout calling "onTaskUpdate"`（RPC 超时）与 tinypool `ERR_IPC_CHANNEL_CLOSED`
    // （拆台竞态）——均与测试正确性无关（1611 全过仍 exit 1，公仓 CI 多轮实录）。
    // 08-29 vitest 4 迁移专项 R3：threads 池保留（消 IPC 拆台族），
    // dangerouslyIgnoreUnhandledErrors 豁免撤除——node 23.8 + vitest 4.1.11 三连
    // 全量绿后撤；噪声若复发再评估池选择（design §4）。
    pool: 'threads',
  },
});
