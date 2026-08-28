import { describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';

// closureRerank imports resolveRerankModel from modelGatewayIpc (default). Mock
// electron + modelGatewayIpc so the import chain loads under plain vitest with
// NO better-sqlite3 ABI concern and ZERO network. Tests drive rerankCandidates
// via its DI seam (resolveModel/rerank stubs) so the degrade logic is unit-tested
// without a DB.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/closure-rerank-test', isPackaged: false },
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveModel: () => {
    throw new Error('should not be called');
  },
}));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn: () => undefined, info: () => undefined }) }));

import { rerankCandidates } from '../main/db/closureRerank';

// A properly-typed rerank ResolvedModel (return annotation forces the literal to
// be checked against ResolvedModel so protocol/capability are the union members,
// not widened to string).
function rerankStubModel(): ResolvedModel {
  return {
    keyId: 'k',
    modelId: 'reranker-stub',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:0',
    apiKey: 'stub',
    capability: 'rerank',
  };
}

type StubHit = { bodyText: string; rerankScore?: number; id: string };

function hits(...items: StubHit[]): StubHit[] {
  return items;
}

describe('rerankCandidates (Story 2.1 shared rerank stage)', () => {
  it('no rerank model -> degrades to RRF order (slice 0..k), no rerankScore', async () => {
    const input = hits(
      { bodyText: 'a', id: 'A' },
      { bodyText: 'b', id: 'B' },
      { bodyText: 'c', id: 'C' },
    );
    const out = await rerankCandidates('q', input, 2, { resolveModel: () => null });
    expect(out.map((h) => h.id)).toEqual(['A', 'B']); // original order, sliced to k=2
    expect(out.every((h) => h.rerankScore === undefined)).toBe(true);
  });

  it('rerank model available -> re-sorted by rerankScore DESC, rerankScore attached, sliced to k', async () => {
    const input = hits(
      { bodyText: 'a', id: 'A' },
      { bodyText: 'b', id: 'B' },
      { bodyText: 'c', id: 'C' },
    );
    const out = await rerankCandidates('q', input, 2, {
      resolveModel: () => rerankStubModel(),
      // B is most relevant, then A, then C.
      rerank: async (_m, _q, docs) => docs.map((_, i) => (i === 1 ? 0.9 : i === 0 ? 0.5 : 0.1)),
    });
    expect(out.map((h) => h.id)).toEqual(['B', 'A']); // re-sorted by score DESC
    expect(out[0].rerankScore).toBe(0.9);
    expect(out[1].rerankScore).toBe(0.5);
  });

  it('rerank endpoint throws -> degrades to RRF order (never rejects)', async () => {
    const input = hits({ bodyText: 'a', id: 'A' }, { bodyText: 'b', id: 'B' });
    const out = await rerankCandidates('q', input, 10, {
      resolveModel: () => rerankStubModel(),
      rerank: async () => {
        throw new Error('endpoint down');
      },
    });
    expect(out.map((h) => h.id)).toEqual(['A', 'B']); // original order preserved
    expect(out.every((h) => h.rerankScore === undefined)).toBe(true);
  });

  it('score count mismatch -> degrades to RRF order (no garbage reorder)', async () => {
    const input = hits({ bodyText: 'a', id: 'A' }, { bodyText: 'b', id: 'B' });
    const out = await rerankCandidates('q', input, 10, {
      resolveModel: () => rerankStubModel(),
      rerank: async () => [0.9], // wrong count (expected 2)
    });
    expect(out.map((h) => h.id)).toEqual(['A', 'B']); // degrade, no reorder
  });

  it('hits.length <= 1 -> returns slice (nothing to rerank)', async () => {
    const single = hits({ bodyText: 'a', id: 'A' });
    const out = await rerankCandidates('q', single, 10, {
      resolveModel: () => rerankStubModel(),
      rerank: async () => {
        throw new Error('should not be called for <=1 hits');
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('A');
  });

  it('empty/whitespace query -> degrades (cross-encoder has nothing to score against)', async () => {
    const input = hits({ bodyText: 'a', id: 'A' }, { bodyText: 'b', id: 'B' });
    let rerankCalled = false;
    const out = await rerankCandidates('   ', input, 10, {
      resolveModel: () => rerankStubModel(),
      rerank: async () => {
        rerankCalled = true;
        return [0.5, 0.5];
      },
    });
    expect(rerankCalled).toBe(false);
    expect(out.map((h) => h.id)).toEqual(['A', 'B']);
  });

  it('resolveModel throwing -> degrades (never rejects)', async () => {
    const input = hits({ bodyText: 'a', id: 'A' }, { bodyText: 'b', id: 'B' });
    const out = await rerankCandidates('q', input, 10, {
      resolveModel: () => {
        throw new Error('disk read failed');
      },
    });
    expect(out.map((h) => h.id)).toEqual(['A', 'B']);
  });
});
