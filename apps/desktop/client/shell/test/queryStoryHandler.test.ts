import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryHit } from '@orison/shared-contracts';

// vi.hoisted so the mock factories (which run before imports) can reference the
// stubs. Mirrors the modelGatewayIpc.test.ts pattern.
const { getProject, searchClosure, warn } = vi.hoisted(() => ({
  getProject: vi.fn(),
  searchClosure: vi.fn(),
  warn: vi.fn(),
}));

// Mock the handler's only real dependencies. With closureRetrieval +
// projectRepository replaced, their transitive imports (getDb, modelGatewayIpc,
// model-protocols, sqliteVecLoader) never load - so this suite runs under plain
// vitest with NO better-sqlite3 ABI concern and ZERO network. The logger is
// mocked too so the error-path test does not touch ~/.orison/logs.
vi.mock('../main/db/projectRepository', () => ({ getProject }));
vi.mock('../main/db/closureRetrieval', () => ({ searchClosure }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn }) }));

import { queryStoryHandler, formatHitsForLlm } from '../main/ipc/toolHandlers/closureHandlers';

function makeHit(overrides: Partial<EntryHit> = {}): EntryHit {
  return {
    entryId: 'asset-A',
    projectId: 'p1',
    entryType: 'character',
    sourceKind: 'asset_card',
    name: 'Ranger',
    bodyText: 'Ranger\ntexas ranger silent hunter',
    visibility: 'known',
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

describe('queryStoryHandler (VS1 R5/AC5)', () => {
  beforeEach(() => {
    getProject.mockReset();
    searchClosure.mockReset();
    warn.mockReset();
  });

  it('registered project + query + hits -> output carries hit names, metadata.count + hits array', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    const hits = [
      makeHit(),
      makeHit({ entryId: 'asset-B', name: 'Scout', entryType: 'location', score: 0.0164 }),
    ];
    searchClosure.mockResolvedValue(hits);

    const result = await queryStoryHandler(ctx({ query: 'texas ranger' }));

    expect(result.title).toContain('query_story');
    expect(result.output).toContain('Ranger');
    expect(result.output).toContain('Scout');
    expect(result.metadata?.count).toBe(2);
    expect(result.metadata?.hits).toBe(hits);
    // searchClosure received the resolved projectId + raw query + passthrough opts.
    // k defaults to 10 via closureStoryQuerySchema (CR-08) when omitted.
    expect(searchClosure).toHaveBeenCalledOnce();
    expect(searchClosure).toHaveBeenCalledWith('p1', 'texas ranger', { entryType: undefined, k: 10 });
  });

  it('unregistered project -> friendly "未注册" message, count 0, no retrieval call', async () => {
    getProject.mockReturnValue(undefined);

    const result = await queryStoryHandler(ctx({ query: 'texas' }));

    expect(result.output).toBe('当前项目未注册到数据库，无法检索知识库。');
    expect(result.metadata?.count).toBe(0);
    expect(result.metadata?.hits).toEqual([]);
    expect(searchClosure).not.toHaveBeenCalled();
  });

  it('empty / whitespace query -> "请提供检索查询", count 0, no retrieval call', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });

    const empty = await queryStoryHandler(ctx({ query: '' }));
    expect(empty.output).toBe('请提供检索查询。');
    expect(empty.metadata?.count).toBe(0);

    const blank = await queryStoryHandler(ctx({ query: '   ' }));
    expect(blank.output).toBe('请提供检索查询。');
    expect(blank.metadata?.count).toBe(0);

    expect(searchClosure).not.toHaveBeenCalled();
  });

  it('searchClosure throws -> handler catches, returns error message, never rejects', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchClosure.mockRejectedValue(new Error('vec0 exploded'));

    const result = await queryStoryHandler(ctx({ query: 'texas' }));

    expect(result.output).toBe('检索失败: vec0 exploded');
    expect(result.metadata?.count).toBe(0);
    expect(result.metadata?.hits).toEqual([]);
    expect(result.metadata?.error).toBe('vec0 exploded');
    // The error path logged the failure.
    expect(warn).toHaveBeenCalledOnce();
  });

  it('passes entry_type + k through to searchClosure as { entryType, k }', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchClosure.mockResolvedValue([]);

    await queryStoryHandler(ctx({ query: 'texas', entry_type: 'character', k: 5 }));

    expect(searchClosure).toHaveBeenCalledOnce();
    expect(searchClosure).toHaveBeenCalledWith('p1', 'texas', { entryType: 'character', k: 5 });
  });

  // ── CR-08: k validation (closureStoryQuerySchema clamps k to [1, 50]) ──
  it('clamps k=-1 to 1 (never reaches SQL as an unbounded LIMIT)', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchClosure.mockResolvedValue([]);

    await queryStoryHandler(ctx({ query: 'texas', k: -1 }));

    expect(searchClosure).toHaveBeenCalledWith('p1', 'texas', { entryType: undefined, k: 1 });
  });

  it('clamps k=0 to 1 (never reaches SQL as LIMIT 0 → empty)', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchClosure.mockResolvedValue([]);

    await queryStoryHandler(ctx({ query: 'texas', k: 0 }));

    expect(searchClosure).toHaveBeenCalledWith('p1', 'texas', { entryType: undefined, k: 1 });
  });

  it('clamps k=999 down to 50 (LLM context budget cap)', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchClosure.mockResolvedValue([]);

    await queryStoryHandler(ctx({ query: 'texas', k: 999 }));

    expect(searchClosure).toHaveBeenCalledWith('p1', 'texas', { entryType: undefined, k: 50 });
  });

  it('defaults k to 10 when omitted', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });
    searchClosure.mockResolvedValue([]);

    await queryStoryHandler(ctx({ query: 'texas' }));

    expect(searchClosure).toHaveBeenCalledWith('p1', 'texas', { entryType: undefined, k: 10 });
  });

  it('rejects malformed params (non-string query) with a friendly message, never throws', async () => {
    getProject.mockReturnValue({ projectId: 'p1' });

    // query is a number — closureStoryQuerySchema.parse throws, but the handler
    // catches it (handleToolExecute does NOT catch handler throws).
    const result = await queryStoryHandler(ctx({ query: 12345 }));

    expect(result.output).toBe('检索参数无效，请提供查询文本。');
    expect(result.metadata?.count).toBe(0);
    expect(result.metadata?.hits).toEqual([]);
    expect(searchClosure).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('formatHitsForLlm (VS1 R5)', () => {
  it('empty hits -> explicit "no matches" line quoting the query', () => {
    expect(formatHitsForLlm('texas', [])).toBe('未找到与 "texas" 相关的条目。');
  });

  it('renders a hit block with name + type + relevance footer', () => {
    const out = formatHitsForLlm('texas', [
      makeHit({ score: 0.0328, vecDistance: 0.001 }),
    ]);
    expect(out).toContain('## Ranger (character)');
    expect(out).toContain('texas ranger silent hunter');
    expect(out).toContain('_相关性: 0.0328 vec=0.001_');
  });

  it('omits the vec segment when the vector arm did not run (vecDistance undefined)', () => {
    const out = formatHitsForLlm('texas', [makeHit({ score: 0.0164 })]);
    expect(out).toContain('_相关性: 0.0164_');
    expect(out).not.toContain('vec=');
  });

  it('caps body_text at ~500 chars with an ellipsis', () => {
    const long = 'x'.repeat(600);
    const out = formatHitsForLlm('texas', [makeHit({ bodyText: long })]);
    expect(out).toContain('x'.repeat(500) + '…');
    expect(out).not.toContain('x'.repeat(600));
  });

  // ── Story 8.3 S4：章源 hit 分节渲染（段级出处直供 8.4 调查简报）──
  it('chapter-source hit renders the 段级出处 header（第N章第a-b段，1 起闭区间）instead of the generic name(type) line', () => {
    const out = formatHitsForLlm('当铺', [
      makeHit({
        entryId: '00001:ch_001#c0',
        entryType: 'chapter',
        sourceKind: 'chapter',
        name: '第1章·段1',
        bodyText: '雨夜来客抱着铁盒进当铺。',
        chapterId: 'ch_001',
        chapterIndex: 0, // 0 起章序 → 第1章
        charStart: 0,
        charEnd: 120,
        paraStart: 0, // 0 起半开 → 第1段
        paraEnd: 2, // 半开终点 → 闭区间右端 = 2
        score: 0.0328,
      }),
    ]);
    expect(out).toContain('## 第1章·段1（出处：第1章 第1-2段）');
    // 通用 (type) 行不再出现；原文正文照常渲染；relevance footer 保留。
    expect(out).not.toContain('(chapter)');
    expect(out).toContain('雨夜来客抱着铁盒进当铺。');
    expect(out).toContain('_相关性: 0.0328_');
  });

  it('chapter-source hit without chapterIndex（episode 映射失败）falls back to the chapterId label', () => {
    const out = formatHitsForLlm('当铺', [
      makeHit({
        sourceKind: 'chapter',
        name: 'ch_007·段3',
        chapterId: 'ch_007',
        paraStart: 4,
        paraEnd: 6,
      }),
    ]);
    expect(out).toContain('## ch_007·段3（出处：ch_007 第5-6段）');
  });

  it('chapter-source hit missing span fields（病理态）falls back to the generic header', () => {
    const out = formatHitsForLlm('当铺', [
      makeHit({ sourceKind: 'chapter', entryType: 'chapter', name: '第1章·段1' }),
    ]);
    expect(out).toContain('## 第1章·段1 (chapter)');
  });

  it('mixed hit list: chapter and non-chapter hits each render their own header shape', () => {
    const out = formatHitsForLlm('texas', [
      makeHit({ sourceKind: 'chapter', name: '第2章·段1', chapterId: 'ch_002', chapterIndex: 1, paraStart: 0, paraEnd: 3 }),
      makeHit({ name: 'Ranger' }),
    ]);
    expect(out).toContain('## 第2章·段1（出处：第2章 第1-3段）');
    expect(out).toContain('## Ranger (character)');
  });
});
