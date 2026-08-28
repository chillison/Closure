import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  artifactsDirFor,
  screenshot,
  snapshotYaml,
  snapshotChapter,
  writeLog,
} from '../src/artifacts.js';

/**
 * Unit-style tests for the artifacts helpers (Phase B gate). No Electron launch
 * - `screenshot` is driven by a stub Page that writes a dummy file.
 */

const here = dirname(fileURLToPath(import.meta.url));
// tests/ -> e2e -> desktop -> apps -> repo root (4 up)
const REPO_ROOT = resolve(here, '..', '..', '..', '..');
const today = new Date().toISOString().slice(0, 10);

/** Minimal Page stub: `screenshot({ path })` writes a dummy file to `path`. */
function stubPage(behaviour: 'ok' | 'throw' = 'ok'): Page {
  return {
    screenshot: async (opts: { path: string }) => {
      if (behaviour === 'throw') throw new Error('stub screenshot failure');
      writeFileSync(opts.path, 'dummy-png');
    },
  } as unknown as Page;
}

test.describe('artifactsDirFor', () => {
  const story = 'test-unit-artifacts';
  let dir: string;

  test.beforeAll(() => {
    dir = artifactsDirFor(story);
  });

  test.afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns docs/tests/<today>-<story>/ path', () => {
    expect(dir).toBe(resolve(REPO_ROOT, 'docs', 'tests', `${today}-${story}`));
  });

  test('creates the dir', () => {
    expect(existsSync(dir)).toBe(true);
  });
});

test.describe('screenshot / snapshot / log (temp dir)', () => {
  let tempDir: string;

  test.beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'e2e-artifacts-'));
  });

  test.afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('screenshot writes <step>.png via the window', async () => {
    await screenshot(stubPage(), 'step-one', tempDir);
    expect(existsSync(join(tempDir, 'step-one.png'))).toBe(true);
  });

  test('screenshot does not throw when window.screenshot throws', async () => {
    await expect(screenshot(stubPage('throw'), 'step-bad', tempDir)).resolves.toBeUndefined();
    expect(existsSync(join(tempDir, 'step-bad.png'))).toBe(false);
  });

  test('snapshotYaml copies project.yaml -> <step>.yaml', () => {
    const src = join(tempDir, 'project.yaml');
    writeFileSync(src, 'title: test\n', 'utf-8');
    snapshotYaml(src, 'plan', tempDir);
    expect(readFileSync(join(tempDir, 'plan.yaml'), 'utf-8')).toBe('title: test\n');
  });

  test('snapshotYaml is a no-op (no throw) when the project file is missing', () => {
    snapshotYaml(join(tempDir, 'missing.yaml'), 'noop', tempDir);
    expect(existsSync(join(tempDir, 'noop.yaml'))).toBe(false);
  });

  test('snapshotChapter copies -> <step>-<basename>', () => {
    const src = join(tempDir, 'chapter-01.md');
    writeFileSync(src, '# Ch1\n', 'utf-8');
    snapshotChapter(src, 'draft', tempDir);
    expect(readFileSync(join(tempDir, 'draft-chapter-01.md'), 'utf-8')).toBe('# Ch1\n');
  });

  test('snapshotChapter is a no-op (no throw) when the chapter is missing', () => {
    snapshotChapter(join(tempDir, 'missing.md'), 'noop', tempDir);
    expect(existsSync(join(tempDir, 'noop-missing.md'))).toBe(false);
  });

  test('writeLog appends timestamped lines to run.log', () => {
    writeLog(tempDir, 'first step');
    writeLog(tempDir, 'second step');
    const content = readFileSync(join(tempDir, 'run.log'), 'utf-8');
    expect(content).toContain('first step');
    expect(content).toContain('second step');
    // Two lines, each timestamped.
    expect(content.trim().split('\n')).toHaveLength(2);
  });
});
