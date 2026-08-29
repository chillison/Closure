import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // agent/shell 两包先例（C3.2 超时漂移教训 + 08-28 shell 同款）：turbo 并行全量时
    // worker CPU 争用会把慢测（设置页 user-event 族）顶过 vitest 默认 5s testTimeout
    // ——单包独跑无症状、并行即假红。统一放宽 30s；断言失败不受影响。hookTimeout
    // 同族防线（before/afterEach 默认 10s 同样吃并行饥饿）一并放宽。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  }
});
