import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { launchApp, SHELL_MAIN_PATH } from '../src/launch.js';

const here = dirname(fileURLToPath(import.meta.url));
// tests/smoke.spec.ts -> tests -> e2e -> desktop -> apps -> repo root (4 up)
const REPO_ROOT = resolve(here, '..', '..', '..', '..');

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const ARTIFACTS_DIR = resolve(REPO_ROOT, 'docs', 'tests', `${today}-smoke`);

/**
 * Phase A smoke test: prove the harness can launch the REAL Electron app
 * (build product, visible window), render its first window without crashing,
 * capture a screenshot, and close cleanly.
 *
 * Does NOT fill an API key or navigate the creative flow - that is Phase C/D.
 */
test('app launches + window visible + screenshot', async () => {
  test.skip(
    !existsSync(SHELL_MAIN_PATH),
    'shell build product not found - run `pnpm --filter @orison/desktop-shell build` first',
  );

  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const { app, window } = await launchApp();

  try {
    await window.waitForLoadState('domcontentloaded');
    // Minimal "didn't crash" assertion: the renderer has a visible body.
    await expect(window.locator('body')).toBeVisible();

    const screenshotPath = resolve(ARTIFACTS_DIR, 'smoke.png');
    await window.screenshot({ path: screenshotPath });
    expect(existsSync(screenshotPath)).toBe(true);
  } finally {
    await app.close();
  }
});
