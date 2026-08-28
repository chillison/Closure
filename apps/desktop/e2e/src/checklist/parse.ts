import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * Checklist parsing (R3 / design §3.2 + §4).
 *
 * A Story prd MAY end with a `### E2E UI Checklist` section listing the new /
 * changed UI elements that the e2e harness must verify. Each line is a pipe
 * delimited triple `元素 | 期望 | 时机`:
 *
 * ```markdown
 * ### E2E UI Checklist
 *
 * - structure 页双骨架 | cells>0 + AssociationLayer 连线渲染 | planning 后
 * - PatchReviewPanel | agent patch 时显 + accept 后 project.yaml 更新 | 每 agent 后
 * ```
 *
 * `parseChecklist` is a PURE function (no fs) over the markdown string; the fs
 * read is split into `readChecklistFromPrd`. `getActiveTaskPrdPath` resolves the
 * active task's prd via `task.py current --source` (canonical) with a
 * `.trellis/.runtime/sessions/` fallback, so the harness does not hard-code a
 * task path.
 */

const here = dirname(fileURLToPath(import.meta.url));
// src/checklist/parse.ts -> checklist -> src -> e2e -> desktop -> apps -> repo (5 up)
const REPO_ROOT = resolve(here, '..', '..', '..', '..', '..');

export interface ChecklistItem {
  /** UI element being verified (e.g. "structure 页双骨架"). */
  element: string;
  /** Expected behaviour / render (e.g. "cells>0 + 连线渲染"). */
  expected: string;
  /** Flow moment when the assertion runs (e.g. "planning 后", "每 agent 后"). */
  when: string;
}

export type ChecklistWarnFn = (msg: string) => void;

const defaultWarn: ChecklistWarnFn = (msg) => console.warn(`[checklist] ${msg}`);

const SECTION_HEADING = /^###\s+E2E UI Checklist\s*$/;
/** Next `##` or `###` heading ends the checklist section (design §4). */
const SECTION_END = /^#{2,3}\s/;
const LIST_MARKER = /^[-*+]\s+/;
/** Whole-field placeholder like `<UI 元素>` -> legend/template row, skip. */
const PLACEHOLDER = /^<[^>]+>$/;

/**
 * Parse a single markdown line into a ChecklistItem, or `null` if it does not
 * match the 3-field `元素 | 期望 | 时机` format. Returns `null` (and emits a
 * warning via `onWarn`) for: wrong field count, empty fields, trailing-pipe
 * surplus beyond one empty, and legend/placeholder rows. Never throws.
 */
function parseLine(rawLine: string, onWarn: ChecklistWarnFn): ChecklistItem | null {
  // Strip a leading list marker (-, * or +) so both `- a | b | c` and `a | b | c` work.
  const stripped = rawLine.replace(LIST_MARKER, '').trim();
  if (stripped === '') return null;

  const fields = stripped.split('|').map((f) => f.trim());
  // Tolerate a single trailing pipe (`a | b | c |`) by dropping trailing empties.
  while (fields.length > 0 && fields[fields.length - 1] === '') {
    fields.pop();
  }

  if (fields.length !== 3) {
    onWarn(`skip line (expected 3 fields, got ${fields.length}): ${rawLine.trim()}`);
    return null;
  }
  if (fields.some((f) => f === '')) {
    onWarn(`skip line (empty field): ${rawLine.trim()}`);
    return null;
  }
  // Legend / template row like `<UI 元素> | <期望> | <时机>` -> skip.
  if (fields.every((f) => PLACEHOLDER.test(f))) {
    onWarn(`skip line (legend/placeholder): ${rawLine.trim()}`);
    return null;
  }

  return { element: fields[0], expected: fields[1], when: fields[2] };
}

/**
 * Parse a prd markdown string's `### E2E UI Checklist` section into items.
 *
 * Pure (no fs). Missing section or empty section -> `[]` (not an error: a
 * non-UI Story or a Story with no checklist legitimately yields no items).
 * Malformed lines are skipped with a warning (via `onWarn`, defaults to
 * `console.warn`) rather than throwing.
 */
export function parseChecklist(markdown: string, onWarn: ChecklistWarnFn = defaultWarn): ChecklistItem[] {
  const lines = markdown.split(/\r?\n/);
  const items: ChecklistItem[] = [];
  let inSection = false;
  let inComment = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (!inSection) {
      if (SECTION_HEADING.test(line)) inSection = true;
      continue;
    }

    // Next ## / ### heading ends the section.
    if (SECTION_END.test(line)) break;

    // HTML comment handling (single-line and multi-line).
    if (inComment) {
      if (/-->$/.test(line)) inComment = false;
      continue;
    }
    if (/^<!--/.test(line)) {
      if (!/-->$/.test(line)) inComment = true;
      continue;
    }

    if (line === '') continue;

    const item = parseLine(line, onWarn);
    if (item) items.push(item);
  }

  return items;
}

/**
 * Read a prd file from disk and parse its checklist section.
 *
 * Missing file -> `[]` with a warning (harness must not crash on a bad path).
 * Missing/empty section -> `[]`.
 */
export function readChecklistFromPrd(prdPath: string): ChecklistItem[] {
  if (!existsSync(prdPath)) {
    defaultWarn(`prd not found: ${prdPath}`);
    return [];
  }
  const markdown = readFileSync(prdPath, 'utf-8');
  return parseChecklist(markdown);
}

/**
 * Read all session JSON files in `<repoRoot>/.trellis/.runtime/sessions/` and
 * return the `current_task` of the most recently seen one (ISO `last_seen_at`
 * comparison). Returns `null` if no session / no current_task.
 *
 * This mirrors `task.py current`'s resolution logic as a fallback when the
 * python helper is unavailable (e.g. in a unit test with a temp repoRoot).
 */
function readActiveTaskFromSessions(repoRoot: string): string | null {
  const sessionsDir = resolve(repoRoot, '.trellis', '.runtime', 'sessions');
  if (!existsSync(sessionsDir)) return null;

  let best: { task: string; seen: string } | null = null;
  for (const entry of readdirSync(sessionsDir)) {
    if (!entry.endsWith('.json')) continue;
    let parsed: { current_task?: string; last_seen_at?: string };
    try {
      parsed = JSON.parse(readFileSync(resolve(sessionsDir, entry), 'utf-8'));
    } catch {
      continue;
    }
    if (!parsed.current_task || !parsed.last_seen_at) continue;
    if (!best || parsed.last_seen_at > best.seen) {
      best = { task: parsed.current_task, seen: parsed.last_seen_at };
    }
  }
  return best?.task ?? null;
}

/**
 * Resolve the active task's prd path under a given repo root.
 *
 * Primary: `python <repoRoot>/.trellis/scripts/task.py current --source` and
 * parse the `Current task: <path>` line. Fallback: read session files directly.
 * Returns the absolute prd path if the active task dir has a `prd.md`, else
 * `null`. Exported (not cached) so unit tests can drive it against a temp dir.
 */
export function resolveActiveTaskPrdPath(repoRoot: string): string | null {
  const scriptPath = resolve(repoRoot, '.trellis', 'scripts', 'task.py');
  let taskDir: string | null = null;

  if (existsSync(scriptPath)) {
    const result = spawnSync('python', [scriptPath, 'current', '--source'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    if (!result.error && result.status === 0) {
      const match = result.stdout.match(/Current task:\s*(.+)/);
      if (match) taskDir = match[1].trim();
    }
  }

  if (taskDir === null) taskDir = readActiveTaskFromSessions(repoRoot);
  if (taskDir === null) return null;

  const prdPath = resolve(repoRoot, taskDir, 'prd.md');
  return existsSync(prdPath) ? prdPath : null;
}

let _cachedPrdPath: string | null | undefined;

/**
 * Get the active task's prd path (cached per-run). Returns `null` if no active
 * task or no prd.md. Used by the harness to find the current Story's checklist.
 */
export function getActiveTaskPrdPath(): string | null {
  if (_cachedPrdPath === undefined) {
    _cachedPrdPath = resolveActiveTaskPrdPath(REPO_ROOT);
  }
  return _cachedPrdPath;
}

/** Reset the per-run cache (test helper). */
export function resetActiveTaskPrdPathCache(): void {
  _cachedPrdPath = undefined;
}

/**
 * Derive a story slug from the active task dir basename by stripping the
 * leading `MM-DD-` date prefix (e.g. `07-27-narrative-timeline-ui` ->
 * `narrative-timeline-ui`). Used to name the artifacts dir. Returns `null` if
 * no active task.
 */
export function activeTaskStorySlug(): string | null {
  const prdPath = getActiveTaskPrdPath();
  if (!prdPath) return null;
  const taskDir = basename(dirname(prdPath));
  return taskDir.replace(/^\d{2}-\d{2}-/, '');
}
