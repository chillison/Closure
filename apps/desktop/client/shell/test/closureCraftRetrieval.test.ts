import path from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';

const TEST_HOME = path.join(process.cwd(), 'test-tmp-closure-craft-retrieval');

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));

import { searchCraft } from '../main/db/closureCraftRetrieval';
import { EMBED_DIM, floatArrayToBuffer } from '../main/db/closureIndexer';
import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';

let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function clean() {
  closeDb();
  resetSqliteVecState();
  try { if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
}

function stubModel(): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'text-embedding-3-test',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:0',
    apiKey: 'stub',
    capability: 'embedding',
  };
}

function vecSlot(slot: number): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  v[slot] = 1.0;
  return v;
}
const VEC_A = vecSlot(0);
const VEC_B = vecSlot(1);
const VEC_C = vecSlot(2);

// Story 8.7 multi-vector seeding (S5 fix for the S4 schema change): one
// closure_craft_vec row per vector — vector_id `${craftId}#${kind}` is the PK
// and the vector_kind column carries the kind (mirror of reindexCraftDoc's
// write shape). Positional `vec` = the #body row; `opts.identityVec` adds the
// #identity row (craft docs are all long docs). `opts.summaryText` seeds the
// 8.7 doc column. Idempotent seed: prior rows for the craft_id are cleared
// first (closure_craft_entry delete fires AFTER DELETE, clearing FTS; the vec
// delete is gated on the extension — closure_craft_vec only exists when
// sqlite-vec loaded). Mirrors the production upsert intent (reindexCraftDoc
// uses ON CONFLICT; this helper seeds the derived tables directly).
function seedCraft(
  craftId: string,
  craftType: string,
  name: string,
  body: string,
  vec: number[] | null,
  opts?: { identityVec?: number[] | null; summaryText?: string },
) {
  const db = getDb();
  if (isSqliteVecAvailable()) {
    db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(craftId);
  }
  db.prepare('DELETE FROM closure_craft_entry WHERE craft_id=?').run(craftId);
  db.prepare(
    `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text, summary_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(craftId, craftType, 'user', name, body, opts?.summaryText ?? null);
  if (!isSqliteVecAvailable()) return;
  const insertVec = db.prepare(
    `INSERT INTO closure_craft_vec (vector_id, craft_id, craft_type, source_kind, vector_kind, embedding)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  if (vec) {
    insertVec.run(`${craftId}#body`, craftId, craftType, 'user', 'body', floatArrayToBuffer(vec));
  }
  if (opts?.identityVec) {
    insertVec.run(
      `${craftId}#identity`,
      craftId,
      craftType,
      'user',
      'identity',
      floatArrayToBuffer(opts.identityVec),
    );
  }
}

describe.skipIf(!sqliteUsable)('closureCraftRetrieval DB integration (Story 2.1)', () => {
  // beforeEach (not beforeAll): each test seeds craft_ids 'A'/'B'/... and several
  // assert an EXACT hit set (e.g. structured-only expects exactly its 2 docs). A
  // shared DB across tests would accumulate rows and pollute those assertions.
  // getDb() re-creates the data dir + schema on the next call, so cleaning before
  // every test gives each a fresh derived index (the VS1 closureRetrieval suite
  // uses beforeAll and has the same accumulation latent under a real ABI run).
  beforeEach(clean);
  afterAll(clean);

  it('FTS-only path (no model): body-term query returns the matching craft doc, no vecDistance', async () => {
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    seedCraft('A', 'shuangdian', '爽点目录', '爽点\ntexas ranger silent hunter', VEC_A);
    seedCraft('B', 'shuangdian', '金手指', '金手指\noregon trail', VEC_B);

    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });

    const ids = hits.map((h) => h.craftId);
    expect(ids).toContain('A');
    expect(ids).not.toContain('B');
    const a = hits.find((h) => h.craftId === 'A')!;
    expect(a.vecDistance).toBeUndefined();
    expect(a.ftsRank).toBeDefined();
    expect(a.name).toBe('爽点目录');
    expect(a.craftType).toBe('shuangdian');
  });

  it('both-arms RRF: consensus hit ranks first', async () => {
    // Story 8.7 note: D's body carries "texas" TWICE so its FTS rank is
    // decisively better than A's — the consensus margin must not hinge on
    // vec0's unspecified tie order between D and B's equal-distance vectors
    // (the multi-vector GROUP BY dedupe orders ties by id, which flipped the
    // knife-edge 1/61+1/63 vs 1/62+1/62 comparison of the old single-occurrence
    // seed).
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A);
    seedCraft('B', 'shuangdian', 'Scout', 'Scout\noregon trail', VEC_B);
    seedCraft('C', 'playbook', 'Stronghold', 'Stronghold\nmountain pass', VEC_C);
    seedCraft('D', 'shuangdian', 'Sentinel', 'Sentinel\ntexas texas consensus', VEC_B);

    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].craftId).toBe('D'); // consensus (FTS + vec)
    expect(hits[0].ftsRank).toBeDefined();
    expect(hits[0].vecDistance).toBeDefined();
  });

  it('craft_type filter excludes other types', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_B);
    seedCraft('L', 'playbook', 'Lone Star', 'Lone Star\ntexas playbook', VEC_B);

    const noFilter = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_B,
    });
    expect(noFilter.map((h) => h.craftId).sort()).toEqual(['A', 'L']);

    const shuangdianOnly = await searchCraft('texas', { k: 10, craftType: 'shuangdian' }, {
      resolveModel: () => null,
      embed: async () => VEC_B,
    });
    expect(shuangdianOnly.map((h) => h.craftId)).toEqual(['A']);
    expect(shuangdianOnly.every((h) => h.craftType === 'shuangdian')).toBe(true);
  });

  it('vec-only path: special-char query sanitizes to null FTS, vec arm still returns hits', async () => {
    seedCraft('B', 'shuangdian', 'Scout', 'Scout\noregon trail', VEC_B);
    seedCraft('C', 'playbook', 'Stronghold', 'Stronghold\nmountain pass', VEC_C);

    const hits = await searchCraft('*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].craftId).toBe('B');
    expect(hits[0].vecDistance).toBeDefined();
    expect(hits[0].ftsRank).toBeUndefined();
  });

  it('structured-only fallback: empty query + no model returns docs (score 0)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', null);
    seedCraft('B', 'shuangdian', 'Scout', 'Scout\noregon trail', null);

    const hits = await searchCraft('', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });

    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.score === 0)).toBe(true);
  });

  it('parent-doc return: hits carry closure_craft_entry fields (no projectId)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A);

    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    const a = hits.find((h) => h.craftId === 'A')!;
    expect(a.craftType).toBe('shuangdian');
    expect(a.sourceKind).toBe('user');
    expect(a.name).toBe('Ranger');
    expect(a.bodyText).toBe('Ranger\ntexas ranger');
    // CraftHit has NO projectId field (global scope).
    expect((a as Record<string, unknown>).projectId).toBeUndefined();
  });

  it('rerank stage re-orders RRF hits by rerankScore (additive, shared stage)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A);
    seedCraft('D', 'shuangdian', 'Sentinel', 'Sentinel\ntexas consensus', VEC_B);

    const rerankModel = {
      keyId: 'k1',
      modelId: 'bge-reranker-stub',
      protocol: 'openai-compatible' as const,
      baseUrl: 'http://localhost:0',
      apiKey: 'stub',
      capability: 'rerank' as const,
    };
    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null, // FTS-only RRF
      embed: async () => VEC_A,
      resolveRerankModel: () => rerankModel,
      rerank: async (_m, _q, docs) =>
        docs.map((d) => (d.includes('Ranger') ? 0.99 : 0.1)),
    });

    expect(hits[0].craftId).toBe('A');
    expect(hits[0].rerankScore).toBe(0.99);
    expect(hits[1].craftId).toBe('D');
    expect(hits[1].rerankScore).toBe(0.1);
  });

  it('rerank unavailable -> degrades to RRF order (no rerankScore, never blocks)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A);
    seedCraft('D', 'shuangdian', 'Sentinel', 'Sentinel\ntexas consensus', VEC_B);

    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
      resolveRerankModel: () => null, // no rerank model -> degrade
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.rerankScore === undefined)).toBe(true);
  });

  // ── Story 8.7 S5: dual-vector retrieval (craft mirror) ──

  it('dual-vector: identity-row hit passes vectorKind="identity" + summaryText; body-row hit "body"', async () => {
    seedCraft('IDOC', 'shuangdian', '爽点目录', '爽点\ntexas body lore', VEC_A, {
      identityVec: VEC_B,
      summaryText: '网文爽点速查',
    });
    seedCraft('BDOC', 'playbook', 'Scout', 'Scout\noregon trail', VEC_B);

    // '*' sanitizes to a null FTS term -> vec-only path (query embeds to VEC_B):
    // IDOC's identity row (distance 0) beats its orthogonal body row.
    const hits = await searchCraft('*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });

    expect(hits.length).toBeGreaterThanOrEqual(2);
    const idoc = hits.find((h) => h.craftId === 'IDOC')!;
    expect(idoc.vectorKind).toBe('identity');
    expect(idoc.summaryText).toBe('网文爽点速查');
    const bdoc = hits.find((h) => h.craftId === 'BDOC')!;
    expect(bdoc.vectorKind).toBe('body');
    expect(bdoc.summaryText).toBeUndefined();
  });

  it('rerank doc carries the 【name】summary header before the body (craft mirror)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A, { summaryText: '游侠指南' });
    // Second FTS hit: the rerank stage early-returns on a 1-hit pool.
    seedCraft('D', 'shuangdian', 'Sentinel', 'Sentinel\ntexas consensus', VEC_B);

    const rerankModel = {
      keyId: 'k1',
      modelId: 'bge-reranker-stub',
      protocol: 'openai-compatible' as const,
      baseUrl: 'http://localhost:0',
      apiKey: 'stub',
      capability: 'rerank' as const,
    };
    const seenDocs: string[] = [];
    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null, // FTS-only -> RRF surfaces A + D
      embed: async () => VEC_A,
      resolveRerankModel: () => rerankModel,
      rerank: async (_m, _q, docs) => {
        seenDocs.push(...docs);
        return docs.map(() => 0.5);
      },
    });

    expect(hits.length).toBe(2);
    expect(seenDocs).toHaveLength(2);
    expect(seenDocs).toContain('【Ranger】游侠指南\nRanger\ntexas ranger');
    expect(seenDocs).toContain('【Sentinel】\nSentinel\ntexas consensus');
    // Hit bodyText untouched (prefix lives only in the rerank doc build).
    const a = hits.find((h) => h.craftId === 'A')!;
    expect(a.bodyText).toBe('Ranger\ntexas ranger');
  });

  it('degradation: no model -> FTS-only, vectorKind undefined on every hit (identity arm equally absent)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A, {
      identityVec: VEC_B,
      summaryText: '游侠指南',
    });
    seedCraft('B', 'shuangdian', 'Scout', 'Scout\noregon trail', VEC_B);

    // No embedding model -> vec arm (identity AND body) skipped: only the FTS
    // hit A surfaces; kind stays undefined though a #identity row exists.
    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_B,
    });
    expect(hits.map((h) => h.craftId)).toEqual(['A']);
    expect(hits.every((h) => h.vectorKind === undefined)).toBe(true);
    // Entry-level summary still passes through on the FTS-only path.
    expect(hits[0].summaryText).toBe('游侠指南');
  });
});
