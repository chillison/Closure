import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the Closure/Orison desktop Electron e2e harness.
 *
 * The harness launches the REAL Electron app (built product, not headless)
 * so the user can fill the API key in the visible window and a real LLM
 * creative flow runs. Tests are therefore inherently non-parallel (single
 * Electron instance) and long-running.
 */
export default defineConfig({
  testDir: './tests',
  // NOTE: no top-level `headless` - Playwright's Config type does not accept
  // it, and Electron always shows its own windows (see src/launch.ts). The
  // visible window is what lets the user fill the API key during a run.
  // Smoke is quick; full-flow (Phase D) will need a longer per-test timeout,
  // but 60s is enough for launch + first-window + screenshot here.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Single Electron instance - never parallelize.
  fullyParallel: false,
  workers: 1,
  use: {
    trace: 'on-first-retry',
  },
});
