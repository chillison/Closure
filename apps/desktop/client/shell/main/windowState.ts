import { app, screen } from 'electron';
import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Window bounds persistence (dogfood 2026-08-21): remember the app window's
 * size / position / which display it was on across launches. The state lives
 * in userData/window-state.json; a saved position that no longer intersects
 * any connected display (monitor unplugged / resolution changed) is DISCARDED
 * so the window can never restore off-screen — it falls back to Electron's
 * default centered placement.
 */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/**
 * Pure validator (no electron import at call time — table-testable): numeric
 * fields sane + the saved rectangle intersects at least one work area.
 */
export function validateWindowState(raw: unknown, workAreas: Array<{ x: number; y: number; width: number; height: number }>): WindowState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const width = n(r.width);
  const height = n(r.height);
  const x = n(r.x);
  const y = n(r.y);
  if (width === null || height === null || width < 200 || height < 200) return null;
  if (x === null || y === null) return null;
  const intersects = workAreas.some(
    (wa) =>
      x < wa.x + wa.width &&
      x + width > wa.x &&
      y < wa.y + wa.height &&
      y + height > wa.y,
  );
  if (!intersects) return null;
  return { x, y, width, height, isMaximized: r.isMaximized === true };
}

export function loadWindowState(): WindowState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
    return validateWindowState(raw, screen.getAllDisplays().map((d) => d.workArea));
  } catch {
    return null; // missing/corrupt file → default placement
  }
}

/**
 * Debounced save on resize/move + final flush on close. getNormalBounds()
 * returns the RESTORED bounds while maximized, so a maximize-state save never
 * overwrites the remembered normal size with full-screen dimensions.
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const save = (): void => {
    if (win.isDestroyed()) return;
    try {
      const b = win.getNormalBounds();
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(
        stateFile(),
        JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, isMaximized: win.isMaximized() }),
      );
    } catch {
      /* best effort — a failed save must never block window close */
    }
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('close', save);
}
