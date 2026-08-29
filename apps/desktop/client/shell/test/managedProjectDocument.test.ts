import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { isManagedProjectDocumentPath } from '../main/ipc/managedProjectDocument';
import { writeFileHandler } from '../main/ipc/toolHandlers/fileHandlers';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmBestEffort(dir);
  }
});

describe('managed project document guard', () => {
  it('recognizes project.yaml case-insensitively without blocking other yaml files', () => {
    expect(isManagedProjectDocumentPath('I:/story/project.yaml')).toBe(true);
    expect(isManagedProjectDocumentPath('I:/story/PROJECT.YAML')).toBe(true);
    expect(isManagedProjectDocumentPath('I:/story/notes.yaml')).toBe(false);
  });

  it('rejects agent write_file attempts targeting project.yaml', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'orison-managed-project-'));
    tempDirs.push(projectDir);

    await expect(writeFileHandler({
      params: { filePath: 'project.yaml', content: 'meta: {}' },
      projectDir,
      sessionId: 'session',
      abort: new AbortController().signal,
    })).rejects.toThrow(/managed project document/i);
  });
});
