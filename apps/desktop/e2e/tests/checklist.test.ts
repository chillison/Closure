import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  parseChecklist,
  readChecklistFromPrd,
  resolveActiveTaskPrdPath,
  type ChecklistItem,
} from '../src/checklist/parse.js';

/**
 * Unit-style tests for the checklist parser (Phase B gate). No Electron launch.
 * run under the playwright test runner.
 */

test.describe('parseChecklist (pure)', () => {
  const collect = (md: string): string[] => {
    const warns: string[] = [];
    parseChecklist(md, (m) => warns.push(m));
    return warns;
  };

  test('parses a valid 3-field line', () => {
    const md = '### E2E UI Checklist\n\n- structure 页双骨架 | cells>0 + 连线渲染 | planning 后\n';
    const items = parseChecklist(md);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      element: 'structure 页双骨架',
      expected: 'cells>0 + 连线渲染',
      when: 'planning 后',
    } satisfies ChecklistItem);
  });

  test('parses multiple lines (multi-line)', () => {
    const md = [
      '### E2E UI Checklist',
      '',
      '- a | b | c',
      '- PatchReviewPanel | agent patch 时显 + accept 后 project.yaml 更新 | 每 agent 后',
      '- SceneDetailDrawer | 点场景出 drawer + 机会主义 幕/beat | structure 页交互',
    ].join('\n');
    const items = parseChecklist(md);
    expect(items.map((i) => i.element)).toEqual([
      'a',
      'PatchReviewPanel',
      'SceneDetailDrawer',
    ]);
    expect(items[1].when).toBe('每 agent 后');
  });

  test('returns [] for an empty section (heading present, no items)', () => {
    const md = '### E2E UI Checklist\n\nsome prose but no pipe lines\n';
    expect(parseChecklist(md)).toEqual([]);
  });

  test('returns [] for a missing section (no heading)', () => {
    const md = '# Some PRD\n\n- a | b | c\n';
    expect(parseChecklist(md)).toEqual([]);
  });

  test('skips malformed lines with a warning, keeps valid ones', () => {
    const md = [
      '### E2E UI Checklist',
      '',
      '- good | one | planning 后',
      '- too few fields | only two',
      '- too | many | non | empty | fields',
      '- also good | two | 每 agent 后',
    ].join('\n');
    const warns = collect(md);
    const items = parseChecklist(md);
    expect(items.map((i) => i.element)).toEqual(['good', 'also good']);
    // Two malformed lines -> two warnings.
    expect(warns).toHaveLength(2);
    expect(warns.every((w) => w.startsWith('skip line'))).toBe(true);
  });

  test('tolerates a trailing pipe (3 fields + trailing empty)', () => {
    const md = '### E2E UI Checklist\n\n- a | b | c |\n';
    const items = parseChecklist(md);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ element: 'a', expected: 'b', when: 'c' });
  });

  test('skips HTML comments (single-line and multi-line)', () => {
    const md = [
      '### E2E UI Checklist',
      '',
      '<!-- legend: this is a comment -->',
      '<!-- multi',
      'line comment -->',
      '- real | item | planning 后',
    ].join('\n');
    expect(parseChecklist(md)).toHaveLength(1);
  });

  test('skips the legend/placeholder row', () => {
    const md = '### E2E UI Checklist\n\n- <UI 元素> | <期望行为> | <流程时机>\n- real | item | planning 后\n';
    const items = parseChecklist(md);
    expect(items.map((i) => i.element)).toEqual(['real']);
  });

  test('strips - and * list markers', () => {
    const md = '### E2E UI Checklist\n\n- a | b | c\n* d | e | f\n';
    expect(parseChecklist(md).map((i) => i.element)).toEqual(['a', 'd']);
  });

  test('section ends at the next ## / ### heading', () => {
    const md = [
      '### E2E UI Checklist',
      '',
      '- inside | one | planning 后',
      '',
      '## Next Section',
      '',
      '- outside | two | planning 后',
    ].join('\n');
    expect(parseChecklist(md).map((i) => i.element)).toEqual(['inside']);
  });

  test('does not treat "cells>0" as a placeholder (no leading <)', () => {
    const md = '### E2E UI Checklist\n\n- skeleton | cells>0 + 连线 | planning 后\n';
    const items = parseChecklist(md);
    expect(items).toHaveLength(1);
    expect(items[0].expected).toBe('cells>0 + 连线');
  });
});

test.describe('readChecklistFromPrd (fs)', () => {
  let tempDir: string;

  test.beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'e2e-checklist-'));
  });

  test.afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('reads + parses a real prd file', () => {
    const prdPath = join(tempDir, 'prd.md');
    writeFileSync(
      prdPath,
      ['# Story PRD', '', '### E2E UI Checklist', '', '- a | b | planning 后', ''].join('\n'),
      'utf-8',
    );
    const items = readChecklistFromPrd(prdPath);
    expect(items).toHaveLength(1);
    expect(items[0].element).toBe('a');
  });

  test('returns [] (no throw) when the prd file is missing', () => {
    expect(readChecklistFromPrd(join(tempDir, 'nope.md'))).toEqual([]);
  });
});

test.describe('resolveActiveTaskPrdPath (sessions fallback)', () => {
  let tempRoot: string;

  test.beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'e2e-taskroot-'));
  });

  test.afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeSession(task: string | null, seen: string): void {
    const sessionsDir = resolve(tempRoot, '.trellis', '.runtime', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'test.json'),
      JSON.stringify({ platform: 'test', last_seen_at: seen, current_task: task }),
      'utf-8',
    );
  }

  test('resolves the active task prd from the most recent session', () => {
    writeSession('.trellis/tasks/foo', '2026-07-27T00:00:00Z');
    const taskDir = resolve(tempRoot, '.trellis', 'tasks', 'foo');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'prd.md'), '# Foo', 'utf-8');

    const prdPath = resolveActiveTaskPrdPath(tempRoot);
    expect(prdPath).not.toBeNull();
    expect(prdPath).toBe(join(taskDir, 'prd.md'));
    expect(existsSync(prdPath as string)).toBe(true);
  });

  test('returns null when no session / no current_task', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'e2e-empty-'));
    try {
      expect(resolveActiveTaskPrdPath(emptyRoot)).toBeNull();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test('returns null when the task dir has no prd.md', () => {
    writeSession('.trellis/tasks/bar', '2026-07-27T00:00:00Z');
    // No prd.md created under .trellis/tasks/bar.
    expect(resolveActiveTaskPrdPath(tempRoot)).toBeNull();
  });
});
