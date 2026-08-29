import path from 'node:path';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';

const TEST_DIR = path.join(process.cwd(), 'test-tmp-atomic-write');

describe('atomicWriteFileSync', () => {
  beforeEach(() => {
    rmBestEffort(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmBestEffort(TEST_DIR);
  });

  it('writes through a temp file and leaves no temp files behind', () => {
    const target = path.join(TEST_DIR, 'settings.yaml');

    atomicWriteFileSync(target, 'theme: dark', 'utf-8');

    expect(readFileSync(target, 'utf-8')).toBe('theme: dark');
    expect(readdirSync(TEST_DIR).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('does not corrupt the existing file when the target directory is invalid', () => {
    const target = path.join(TEST_DIR, 'settings.yaml');
    writeFileSync(target, 'theme: light', 'utf-8');

    expect(() => atomicWriteFileSync(path.join(target, 'nested.yaml'), 'bad', 'utf-8')).toThrow();
    expect(readFileSync(target, 'utf-8')).toBe('theme: light');
  });
});
