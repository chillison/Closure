import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CraftHit } from '@orison/shared-contracts';

// Mirror of queryStoryHandler.test.ts: mock the handler's only real dependencies
// (searchCraft + logger) so the suite runs under plain vitest with NO DB / network.
const { searchCraft, warn } = vi.hoisted(() => ({
  searchCraft: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../main/db/closureCraftRetrieval', () => ({ searchCraft }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn }) }));

import { queryCraftHandler, formatCraftHitsForLlm } from '../main/ipc/toolHandlers/closureCraftHandlers';

function makeHit(overrides: Partial<CraftHit> = {}): CraftHit {
  return {
    craftId: 'shuangdian-catalog',
    craftType: 'shuangdian',
    sourceKind: 'user',
    name: '爽点目录',
    bodyText: '爽点三层：即时/累积/终极',
    score: 0.0328,
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

describe('queryCraftHandler (Story 2.1)', () => {
  beforeEach(() => {
    searchCraft.mockReset();
    warn.mockReset();
  });

  it('query + hits -> output carries hit names, metadata.count + hits array (NO projectId resolved)', async () => {
    const hits = [
      makeHit(),
      makeHit({ craftId: 'jinzhishao-7types', name: '金手指7类', craftType: 'jinzhishao', score: 0.0164 }),
    ];
    searchCraft.mockResolvedValue(hits);

    const result = await queryCraftHandler(ctx({ query: '爽点设计' }));

    expect(result.title).toContain('query_craft');
    expect(result.output).toContain('爽点目录');
    expect(result.output).toContain('金手指7类');
    expect(result.metadata?.count).toBe(2);
    expect(result.metadata?.hits).toBe(hits);
    // searchCraft received the raw query + passthrough opts. NO projectId (global).
    expect(searchCraft).toHaveBeenCalledOnce();
    expect(searchCraft).toHaveBeenCalledWith('爽点设计', { craftType: undefined, k: 10 });
  });

  it('empty / whitespace query -> "请提供检索查询", count 0, no retrieval call', async () => {
    const empty = await queryCraftHandler(ctx({ query: '' }));
    expect(empty.output).toBe('请提供检索查询。');
    expect(empty.metadata?.count).toBe(0);

    const blank = await queryCraftHandler(ctx({ query: '   ' }));
    expect(blank.output).toBe('请提供检索查询。');
    expect(blank.metadata?.count).toBe(0);

    expect(searchCraft).not.toHaveBeenCalled();
  });

  it('searchCraft throws -> handler catches, returns error message, never rejects', async () => {
    searchCraft.mockRejectedValue(new Error('vec0 exploded'));

    const result = await queryCraftHandler(ctx({ query: '爽点' }));

    expect(result.output).toBe('检索失败: vec0 exploded');
    expect(result.metadata?.count).toBe(0);
    expect(result.metadata?.hits).toEqual([]);
    expect(result.metadata?.error).toBe('vec0 exploded');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('passes craft_type + k through to searchCraft as { craftType, k }', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: '金手指', craft_type: 'jinzhishao', k: 5 }));
    expect(searchCraft).toHaveBeenCalledWith('金手指', { craftType: 'jinzhishao', k: 5 });
  });

  // k validation (closureCraftQuerySchema clamps k to [1, 50], mirror CR-08)
  it('clamps k=-1 to 1', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: 'x', k: -1 }));
    expect(searchCraft).toHaveBeenCalledWith('x', { craftType: undefined, k: 1 });
  });

  it('clamps k=999 down to 50', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: 'x', k: 999 }));
    expect(searchCraft).toHaveBeenCalledWith('x', { craftType: undefined, k: 50 });
  });

  it('defaults k to 10 when omitted', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: 'x' }));
    expect(searchCraft).toHaveBeenCalledWith('x', { craftType: undefined, k: 10 });
  });

  it('rejects malformed params (non-string query) with a friendly message, never throws', async () => {
    const result = await queryCraftHandler(ctx({ query: 12345 }));
    expect(result.output).toBe('检索参数无效，请提供查询文本。');
    expect(result.metadata?.count).toBe(0);
    expect(result.metadata?.hits).toEqual([]);
    expect(searchCraft).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('accepts a custom craft_type (non-closed enum - user self-registers new classes)', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: 'x', craft_type: 'custom-new-class' }));
    expect(searchCraft).toHaveBeenCalledWith('x', { craftType: 'custom-new-class', k: 10 });
  });
});

describe('formatCraftHitsForLlm (Story 2.1)', () => {
  it('empty hits -> explicit "no matches" line quoting the query', () => {
    expect(formatCraftHitsForLlm('爽点', [])).toBe('未找到与 "爽点" 相关的 craft 文档。');
  });

  it('renders a hit block with name + craft_type + relevance footer', () => {
    const out = formatCraftHitsForLlm('爽点', [
      makeHit({ score: 0.0328, vecDistance: 0.001, rerankScore: 0.9 }),
    ]);
    expect(out).toContain('## 爽点目录 (shuangdian)');
    expect(out).toContain('爽点三层');
    expect(out).toContain('_相关性: 0.0328 vec=0.001 rerank=0.900_');
  });

  it('omits vec/rerank segments when those arms did not run', () => {
    const out = formatCraftHitsForLlm('爽点', [makeHit({ score: 0.0164 })]);
    expect(out).toContain('_相关性: 0.0164_');
    expect(out).not.toContain('vec=');
    expect(out).not.toContain('rerank=');
  });

  it('caps body_text at ~800 chars with an ellipsis', () => {
    const long = 'x'.repeat(900);
    const out = formatCraftHitsForLlm('q', [makeHit({ bodyText: long })]);
    expect(out).toContain('x'.repeat(800) + '…');
    expect(out).not.toContain('x'.repeat(900));
  });
});
