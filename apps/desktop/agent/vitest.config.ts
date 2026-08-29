import { defineConfig } from 'vitest/config';

// 该包测试以重量级集成形态为主（runtime 装配 / temp 目录 / 链 e2e / 400 章压测族），
// 正常耗时 1.5-2.5s，但在并行 worker CPU 争用下会越过 vitest 默认 5s testTimeout，
// 造成「超时集合每轮漂移」的假失败（根 pnpm test 门间歇性红）。统一放宽到 30s；
// 断言失败不受影响——只消灭负载型超时噪音。
export default defineConfig({
  test: {
    testTimeout: 30_000,
    // rmBestEffort：fs.rmSync EPERM 全局兜底（Windows 句柄释放竞态，详 setup 文件头注）。
    setupFiles: ['./test/setup/rmBestEffort.ts'],
  },
});
