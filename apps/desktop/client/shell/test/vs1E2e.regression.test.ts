import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryHit } from '@orison/shared-contracts';

// VS1 Phase-6 cross-layer splice regression guard (AC6).
//
// The throwaway Electron smoke (scripts/smoke-vs1-e2e.cjs) proves the REAL
// end-to-end chain through the real DB + sqlite-vec. This committed vitest test
// guards the cross-layer CONTRACT that needs no DB: that `searchClosure`'s
// `EntryHit` shape flows through `queryStoryHandler` into `formatHitsForLlm`
// output UNCHANGED, and that `metadata.hits` is the exact `searchClosure` return
// (no clone/mutation). It complements queryStoryHandler.test.ts (阶段5, handler
// control flow) by pinning the shape-integrity of the splice - the agent tool
// channel must receive the real, complete EntryHit[] and render every field.
//
// Same vi.mock pattern as queryStoryHandler.test.ts: closureRetrieval +
// projectRepository replaced so their transitive imports (getDb, modelGatewayIpc,
// model-protocols, sqliteVecLoader) never load -> runs under plain vitest with
// NO better-sqlite3 ABI concern and ZERO network. formatHitsForLlm is NOT mocked
// - the real formatter runs so the EntryHit -> Markdown flow is exercised for
// real.
const { getProject, searchClosure, warn } = vi.hoisted(() => ({
  getProject: vi.fn(),
  searchClosure: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../main/db/projectRepository', () => ({ getProject }));
vi.mock('../main/db/closureRetrieval', () => ({ searchClosure }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn }) }));

import { queryStoryHandler } from '../main/ipc/toolHandlers/closureHandlers';

/** A fully-populated EntryHit (every field set) for shape-integrity assertions. */
function fullHit(overrides: Partial<EntryHit> = {}): EntryHit {
  return {
    entryId: 'asset-A',
    projectId: 'p1',
    entryType: 'character',
    sourceKind: 'asset_card',
    name: '德克萨斯游侠',
    bodyText: '德克萨斯游侠\n沉默的德州猎人擅长追踪遗迹目标',
    visibility: 'known',
    score: 0.0328,
    ftsRank: -2.5,
    vecDistance: 0.001,
    ...overrides,
  };
}

function ctx(params: Record<string, unknown>, projectDir = '/proj/alpha') {
  return {
    params,
    projectDir,
    sessionId: 's1',
    abort: new AbortController().signal,
  };
}

describe('VS1 e2e splice regression (AC6) - EntryHit shape flows through the handler', () => {
  beforeEach(() => {
    getProject.mockReset();
    searchClosure.mockReset();
    warn.mockReset();
    getProject.mockReturnValue({ projectId: 'p1' });
  });

  it('a hit with vecDistance renders the vec segment in the handler formatted output', async () => {
    const hit = fullHit({ vecDistance: 0.001, score: 0.0328 });
    searchClosure.mockResolvedValue([hit]);

    const result = await queryStoryHandler(ctx({ query: '德州猎人' }));

    // The hit name + type are rendered.
    expect(result.output).toContain('## 德克萨斯游侠 (character)');
    // The vecDistance flowed searchClosure -> handler -> formatHitsForLlm -> output.
    expect(result.output).toContain('_相关性: 0.0328 vec=0.001_');
  });

  it('a hit without vecDistance (FTS-only / offline arm) omits the vec segment', async () => {
    // Offline degradation path: vecDistance undefined -> the formatter must NOT
    // emit `vec=`. This is the splice contract for the FTS-only arm.
    const hit = fullHit({ vecDistance: undefined, ftsRank: -1.2, score: 0.0164 });
    searchClosure.mockResolvedValue([hit]);

    const result = await queryStoryHandler(ctx({ query: '德州猎人' }));

    expect(result.output).toContain('## 德克萨斯游侠 (character)');
    expect(result.output).toContain('_相关性: 0.0164_');
    expect(result.output).not.toContain('vec=');
  });

  it('metadata.hits is the exact searchClosure return (same ref, full EntryHit shape preserved)', async () => {
    // The agent tool channel must receive the real, COMPLETE EntryHit[] - no
    // clone, no projection, no field dropped. A downstream consumer reading
    // metadata.hits[0].ftsRank / .visibility / .sourceKind / .bodyText / .score
    // must see exactly what searchClosure returned.
    const hits: EntryHit[] = [fullHit(), fullHit({ entryId: 'asset-B', name: '古地图之厅', entryType: 'location', score: 0.0164, vecDistance: 1.0 })];
    searchClosure.mockResolvedValue(hits);

    const result = await queryStoryHandler(ctx({ query: '德州猎人' }));

    // Same array reference (no clone/mutation inside the handler).
    expect(result.metadata?.hits).toBe(hits);
    expect(result.metadata?.count).toBe(2);
    // Full shape preserved on every hit - deep equality against the input.
    expect(result.metadata?.hits).toEqual(hits);
    // Spot-check the optional + rarely-rendered fields survive the splice
    // (these are NOT in the formatted Markdown - only in metadata.hits).
    // metadata is Record<string, unknown>, so narrow before indexing.
    const mdHits = result.metadata?.hits as EntryHit[];
    expect(mdHits[0]).toMatchObject({
      entryId: 'asset-A',
      projectId: 'p1',
      entryType: 'character',
      sourceKind: 'asset_card',
      visibility: 'known',
      ftsRank: -2.5,
      vecDistance: 0.001,
      score: 0.0328,
    });
  });
});
