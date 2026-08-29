import { defineConfig } from 'vitest/config';

// agent 包 vitest.config 先例（C3.2 超时漂移教训）补齐到 shell：该包测试以重量级集成
// 形态为主（isomorphic-git 快照 / watcher debounce / temp 目录 db / 400 章压测族），
// 正常耗时 2-4s（gitCreateNodeDeletion 单测本机 3.5s、负载下 5.7s），CI 慢机 + 并行
// worker CPU 争用下越过 vitest 默认 5s testTimeout —— 公仓首推 CI 三平台全红即此
// （08-28 release prep 实录）。统一放宽到 30s；断言失败不受影响。
export default defineConfig({
  test: {
    testTimeout: 30_000,
    // vitest 3 默认 forks 池在 Windows 慢 runner 重负载下有两族进程级噪声：
    // `Timeout calling "onTaskUpdate"`（RPC 超时）与 tinypool `ERR_IPC_CHANNEL_CLOSED`
    // （拆台竞态）——均与测试正确性无关（1611 全过仍 exit 1，公仓 CI 多轮实录）。
    // threads 池（worker_threads，无子进程 IPC）从根上消后者；前者由 ignore 兜底。
    pool: 'threads',
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
