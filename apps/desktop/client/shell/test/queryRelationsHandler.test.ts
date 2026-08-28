import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelationHit } from '@orison/shared-contracts';

// vi.hoisted so mock factories (run before imports) can reference stubs (mirror queryStoryHandler.test.ts).
const { getProject, searchRelations, warn } = vi.hoisted(() => ({
  getProject: vi.fn(),
  searchRelations: vi.fn(),
  warn: vi.fn(),
}));

// Mock the handler's only real dependencies. relationRetrieval + projectRepository replaced →
// transitive imports (getDb) never load → plain vitest, NO better-sqlite3 ABI concern, ZERO network.
vi.mock('../main/db/projectRepository', () => ({ getProject }));
vi.mock('../main/db/relationRetrieval', () => ({ searchRelations }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn }) }));

import { queryRelationsHandler, formatRelationHits } from '../main/ipc/toolHandlers/closureHandlers';

function makeHit(overrides: Partial<RelationHit> = {}): RelationHit {
  return {
    entryId: 'asset-B',
    projectId: 'p1',
    entryType: 'character',
    name: 'Scout',
    bodyText: "Scout is A's rival",
    relationType: 'rivalry',
    depth: 1,
    viaPath: ['asset-A', 'asset-B'],
    ...overrides,
  };
}

function ctx(params: Record<string, unknown>, projectDir = '/proj/alpha') {
  return { params, projectDir, sessionId: 's1', abort: new AbortController().signal };
}

describe('queryRelationsHandler (Story 6.4 D2)', () => {
  beforeEach(() => {
    getProject.mockReset();
    searchRelations.mockReset();
    warn.mockReset();
  });

  it('registered + seed + hits → output carries names, metadata.count + hits', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    const hits = [
      makeHit(),
      makeHit({ entryId: 'asset-C', name: 'Mentor', relationType: 'mentor', depth: 2 }),
    ];
    searchRelations.mockReturnValue(hits);

    const result = await queryRelationsHandler(ctx({ seed_entry_id: 'asset-A' }));

    expect(result.title).toContain('query_relations');
    expect(result.output).toContain('Scout');
    expect(result.output).toContain('Mentor');
    expect(result.metadata?.count).toBe(2);
    expect(result.metadata?.hits).toBe(hits);
    // depth default 2, budget default 20 (relationQuerySchema clamp) when omitted.
    expect(searchRelations).toHaveBeenCalledOnce();
    expect(searchRelations).toHaveBeenCalledWith('p1', 'asset-A', {
      depth: 2,
      budget: 20,
      relationType: undefined,
      visibility: undefined,
    });
  });

  it('unregistered project → friendly message, count 0, no traversal', async () => {
    getProject.mockReturnValue(undefined);
    const result = await queryRelationsHandler(ctx({ seed_entry_id: 'asset-A' }));
    expect(result.metadata?.count).toBe(0);
    expect(result.output).toContain('未注册');
    expect(searchRelations).not.toHaveBeenCalled();
  });

  it('invalid params (missing seed_entry_id) → friendly message, count 0', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    const result = await queryRelationsHandler(ctx({}));
    expect(result.metadata?.count).toBe(0);
    expect(searchRelations).not.toHaveBeenCalled();
  });

  it('searchRelations throws → graceful empty (never rejects, mirror "never throws")', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchRelations.mockImplementation(() => {
      throw new Error('cte boom');
    });
    const result = await queryRelationsHandler(ctx({ seed_entry_id: 'asset-A' }));
    expect(result.metadata?.count).toBe(0);
    expect(result.output).toContain('关系遍历失败');
  });

  it('empty hits → "未找到" message', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchRelations.mockReturnValue([]);
    const result = await queryRelationsHandler(ctx({ seed_entry_id: 'asset-A' }));
    expect(result.output).toContain('未找到');
  });

  it('depth/budget clamped (out-of-range → [1,5]/[1,100])', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchRelations.mockReturnValue([]);
    await queryRelationsHandler(ctx({ seed_entry_id: 'asset-A', depth: 99, budget: 9999 }));
    expect(searchRelations).toHaveBeenCalledWith('p1', 'asset-A', {
      depth: 5,
      budget: 100,
      relationType: undefined,
      visibility: undefined,
    });
  });

  it('relation_type + visibility 透传', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchRelations.mockReturnValue([]);
    await queryRelationsHandler(
      ctx({ seed_entry_id: 'asset-A', relation_type: 'rivalry', visibility: 'secret' }),
    );
    expect(searchRelations).toHaveBeenCalledWith('p1', 'asset-A', {
      depth: 2,
      budget: 20,
      relationType: 'rivalry',
      visibility: 'secret',
    });
  });

  it('formatRelationHits：空 → 未找到；非空 → name + relation/hop footer', () => {
    expect(formatRelationHits([])).toContain('未找到');
    const out = formatRelationHits([makeHit()]);
    expect(out).toContain('Scout');
    expect(out).toContain('rivalry');
    expect(out).toContain('hop=1');
  });
});
