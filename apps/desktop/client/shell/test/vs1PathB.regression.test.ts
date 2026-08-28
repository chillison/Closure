import { describe, expect, it, vi } from 'vitest';

// VS1 Path-B model-swap regression guard (R7/AC7).
//
// `parseVecDimFromSql` is the pure heart of the Path-B dynamic-dim mechanism:
// vec0 dims are fixed at CREATE time and have no ALTER path (research
// `embedding-model-swap-compatibility-2026-07-23.md` §1), so `reindexAll` DROPs
// + reCREATEs `entry_vec` at a new dim on a model swap, and `reindexAsset` /
// `searchClosure` must read the CURRENT dim from the live CREATE statement
// (via `getCurrentVecDim`) rather than a hardcoded constant. This test pins the
// parser so a swapped dim (1024 -> 768) and the "table absent" case both surface
// correctly - the AC7 smoke proves the real DB chain end-to-end; this test guards
// the parsing logic that makes the runtime dim check dim-agnostic, with no DB.
//
// `parseVecDimFromSql` lives in closureIndexer, whose import chain pulls in
// electron (`db/index.ts` imports `app`), model-protocols, and modelGatewayIpc at
// module load. Mock electron so the import resolves under plain vitest (same
// pattern as closureIndexer.test.ts). The heavy deps are never invoked - the
// parser is a pure string function with no DB / no network.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/vs1-pathb-regression', isPackaged: false },
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

import { parseVecDimFromSql } from '../main/db/closureIndexer';

describe('VS1 Path B regression (R7/AC7) - parseVecDimFromSql', () => {
  it('parses the dim from the initial vec0 CREATE statement (float[1024])', () => {
    // The exact DDL db/index.ts ships (VS1 initial dim).
    const sql = `CREATE VIRTUAL TABLE entry_vec USING vec0(
        entry_id TEXT PRIMARY KEY,
        project_id TEXT partition key,
        entry_type TEXT,
        source_kind TEXT,
        embedding float[1024] distance_metric=cosine
      )`;
    expect(parseVecDimFromSql(sql)).toBe(1024);
  });

  it('parses a swapped dim (float[768]) from a re-created entry_vec', () => {
    // The DDL reindexAll emits after a 1024 -> 768 model swap (R7/AC7).
    const sql =
      'CREATE VIRTUAL TABLE entry_vec USING vec0(entry_id TEXT PRIMARY KEY, project_id TEXT partition key, entry_type TEXT, source_kind TEXT, embedding float[768] distance_metric=cosine)';
    expect(parseVecDimFromSql(sql)).toBe(768);
  });

  it('returns null when the statement has no float[N] column', () => {
    // A non-vec0 table (closure_entry), or a vec0 table using int8/bit columns
    // (not used by Closure, but the parser must not crash or mis-report).
    expect(parseVecDimFromSql('CREATE TABLE closure_entry (entry_id TEXT PRIMARY KEY)')).toBeNull();
    expect(parseVecDimFromSql('CREATE VIRTUAL TABLE v USING vec0(embedding int8[768])')).toBeNull();
  });

  it('returns null for absent / empty input (entry_vec table missing)', () => {
    // sqlite_master.sql is null/undefined when the table does not exist (vec
    // extension not loaded, or not yet created) - the parser must surface that
    // as null so callers treat it as "no vector arm" (FTS-only degradation).
    expect(parseVecDimFromSql(null)).toBeNull();
    expect(parseVecDimFromSql(undefined)).toBeNull();
    expect(parseVecDimFromSql('')).toBeNull();
  });
});
