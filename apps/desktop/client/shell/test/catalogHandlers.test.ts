import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted so the mock factories (run before imports) can reference the stubs
// (mirror worldStateHandlers.test.ts pattern). Repos are mocked so the suite
// runs under plain vitest with NO better-sqlite3 ABI concern; the real SQL
// (listCatalogEntries / getCatalogEntry / listLastPatchFacts /
// listEpisodeStoryTimeWindows / aggregateMentionAppearance) is covered by
// catalogRepository.test.ts + gapStatsFetchParity.test.ts under Electron-as-Node
// (testing-discipline db round-trip Pattern).
const {
  getProject,
  listCatalogEntries,
  getCatalogEntry,
  getMentionAggregates,
  queryMentionLedger,
  listRecentEpisodeMentionSignals,
  aggregateMentionAppearance,
  listEpisodeStoryTimeWindows,
  listLastPatchFacts,
  warn,
} = vi.hoisted(() => ({
  getProject: vi.fn(),
  listCatalogEntries: vi.fn(),
  getCatalogEntry: vi.fn(),
  getMentionAggregates: vi.fn(),
  queryMentionLedger: vi.fn(),
  listRecentEpisodeMentionSignals: vi.fn(),
  aggregateMentionAppearance: vi.fn(),
  listEpisodeStoryTimeWindows: vi.fn(),
  listLastPatchFacts: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../main/db/projectRepository', () => ({ getProject }));
vi.mock('../main/db/catalogRepository', () => ({ listCatalogEntries, getCatalogEntry }));
vi.mock('../main/db/mentionLedgerRepository', () => ({
  getMentionAggregates,
  queryMentionLedger,
  listRecentEpisodeMentionSignals,
  aggregateMentionAppearance,
}));
vi.mock('../main/db/worldStateRepository', () => ({
  listEpisodeStoryTimeWindows,
  listLastPatchFacts,
}));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn }) }));

import {
  catalogEntriesHandler,
  getEntryHandler,
  queryMentionsHandler,
} from '../main/ipc/toolHandlers/catalogHandlers';
import type { ClosureMentionRow } from '@orison/shared-contracts';

function ctx(params: Record<string, unknown>, projectDir = '/proj/alpha') {
  return {
    params,
    projectDir,
    sessionId: 's1',
    abort: new AbortController().signal,
  };
}

function mentionRow(over: Partial<ClosureMentionRow> = {}): ClosureMentionRow {
  return {
    projectId: '00001',
    episodeId: 'ep-1',
    entryId: 'card-a',
    presence: 'present',
    declared: 1,
    presenceShot: 0,
    coarseHit: 1,
    planLinked: 0,
    coarseCount: 3,
    stateChanged: 0,
    source: 'full',
    updatedAt: '2026-08-19 00:00:00',
    ...over,
  };
}

/** 轻列窗行（listEpisodeStoryTimeWindows mock 形态——Story 8.3 S5 取数下推后 ledger/gap_stats 共用）。 */
function windowRecord(
  episodeId: string,
  episodeIndex: number | null,
  over: { storyTimeEnd?: number | null; storyTimeStart?: number | null } = {},
) {
  return {
    episodeId,
    episodeIndex,
    storyTimeStart: over.storyTimeStart ?? null,
    storyTimeEnd: over.storyTimeEnd ?? null,
  };
}

describe('catalogHandlers — catalog_entries (Story 8.7 S6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProject.mockReturnValue({ projectId: '00001' });
    getMentionAggregates.mockReturnValue([
      { entryId: 'erina', chapterCount: 12, lastEpisodeId: 'ep-23' },
    ]);
  });

  it('正常：薄行 + mention 聚合拼行 + 显式 total + 翻页指引（绝不静默截断）', async () => {
    listCatalogEntries.mockReturnValue({
      total: 34,
      rows: [
        { entryId: 'erina', entryType: 'character', name: '艾琳', summaryText: '少女剑士，背负家族血仇'.repeat(6) },
        { entryId: 'tavern', entryType: 'location', name: '老酒馆', summaryText: null },
      ],
    });

    const res = await catalogEntriesHandler(ctx({ offset: 0, limit: 2 }));

    expect(listCatalogEntries).toHaveBeenCalledWith('00001', {
      entryType: undefined,
      status: undefined,
      visibility: undefined,
      offset: 0,
      limit: 2,
    });
    // total 独立显式（34 > 本页 2），翻页指引带 next offset。
    expect(res.output).toContain('共 34 条');
    expect(res.output).toContain('offset=2');
    expect(res.output).toContain('本页第 1-2 条');
    const rows = (res.metadata as { rows: Array<Record<string, unknown>> }).rows;
    // mention 聚合拼行（有账条目）；summaryLine ≤ 60 截断 + 省略号。
    expect(rows[0]).toMatchObject({
      entryId: 'erina',
      mentionChapterCount: 12,
      lastMentionEpisode: 'ep-23',
    });
    const summaryLine = rows[0].summaryLine as string;
    expect(summaryLine.length).toBe(61); // 60 字 + 省略号
    expect(summaryLine.endsWith('…')).toBe(true);
    // 无账条目：mention 字段省略（二态纪律：无值不出现字段，非 0/空串占位）。
    expect(rows[1]).not.toHaveProperty('mentionChapterCount');
    expect(rows[1]).not.toHaveProperty('lastMentionEpisode');
    expect(rows[1]).not.toHaveProperty('summaryLine');
    expect(res.output).toContain('艾琳（character） · 出场 12 章，最后 ep-23');
    expect(res.metadata).toMatchObject({ ok: true, total: 34, count: 2 });
  });

  it('末页：无「还有更多」指引（已到末页标注）', async () => {
    listCatalogEntries.mockReturnValue({
      total: 2,
      rows: [
        { entryId: 'erina', entryType: 'character', name: '艾琳', summaryText: null },
        { entryId: 'tavern', entryType: 'location', name: '老酒馆', summaryText: null },
      ],
    });
    getMentionAggregates.mockReturnValue([]);

    const res = await catalogEntriesHandler(ctx({ offset: 0 }));

    expect(res.output).toContain('已到末页');
    expect(res.output).not.toContain('还有更多');
  });

  it('offset 越界：total 显式 + 回退指引（不出现「第 21-20 条」假象）', async () => {
    listCatalogEntries.mockReturnValue({ total: 2, rows: [] });

    const res = await catalogEntriesHandler(ctx({ offset: 20 }));

    expect(res.metadata).toMatchObject({ ok: true, total: 2, count: 0, offset: 20 });
    expect(res.output).toContain('offset=20 已超出范围');
    expect(res.output).toContain('共 2 条');
    expect(res.output).not.toContain('第 21-0 条');
  });

  it('零行：友好 miss（不抛错）+ 过滤条件透传', async () => {
    listCatalogEntries.mockReturnValue({ total: 0, rows: [] });

    const res = await catalogEntriesHandler(ctx({ entry_type: 'character', status: 'active' }));

    expect(listCatalogEntries).toHaveBeenCalledWith('00001', {
      entryType: 'character',
      status: 'active',
      visibility: undefined,
      offset: 0,
      limit: 20,
    });
    expect(res.output).toContain('没有匹配的条目');
    expect(res.metadata).toMatchObject({ ok: true, total: 0, count: 0 });
  });

  it('graceful：非法参数（limit 超上限）→ invalid_params；未注册 → project_not_registered', async () => {
    const bad = await catalogEntriesHandler(ctx({ limit: 999 }));
    expect(bad.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
    expect(listCatalogEntries).not.toHaveBeenCalled();

    getProject.mockReturnValue(undefined);
    const unregistered = await catalogEntriesHandler(ctx({}));
    expect(unregistered.metadata).toMatchObject({ ok: false, reason: 'project_not_registered' });
  });

  it('graceful：repo 抛错 → 友好失败文案（never-throws）', async () => {
    listCatalogEntries.mockImplementation(() => {
      throw new Error('db exploded');
    });
    const res = await catalogEntriesHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'query_failed' });
    expect(res.output).toContain('db exploded');
    expect(warn).toHaveBeenCalled();
  });
});

describe('catalogHandlers — get_entry (Story 8.7 S6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProject.mockReturnValue({ projectId: '00001' });
    getMentionAggregates.mockReturnValue([
      { entryId: 'erina', chapterCount: 12, lastEpisodeId: 'ep-23' },
    ]);
  });

  it('正常：全文 + 状态 + 简述 + 出场统计', async () => {
    getCatalogEntry.mockReturnValue({
      entryId: 'erina',
      entryType: 'character',
      name: '艾琳',
      summaryText: '少女剑士',
      bodyText: '# 艾琳\n左颊有疤…',
      status: 'active',
      visibility: 'known',
    });

    const res = await getEntryHandler(ctx({ entry_id: 'erina' }));

    expect(getCatalogEntry).toHaveBeenCalledWith('00001', 'erina');
    expect(res.output).toContain('## 艾琳（character）');
    expect(res.output).toContain('左颊有疤');
    expect(res.output).toContain('出场: 12 章，最后 ep-23');
    expect(res.metadata).toMatchObject({
      ok: true,
      mentionStats: { mentionChapterCount: 12, lastMentionEpisode: 'ep-23' },
    });
  });

  it('无状态条目（设定散文 status null）+ 无出场账：人话缺省文案，不编造', async () => {
    getCatalogEntry.mockReturnValue({
      entryId: '00001:magic-system',
      entryType: 'rule',
      name: '魔法体系',
      summaryText: null,
      bodyText: '灵力守恒…',
      status: null,
      visibility: 'known',
    });
    getMentionAggregates.mockReturnValue([]);

    const res = await getEntryHandler(ctx({ entry_id: '00001:magic-system' }));

    expect(res.output).toContain('无状态概念');
    expect(res.output).toContain('出场账未建立');
    expect(res.output).toContain('简述: （未生成）');
    expect(res.metadata).toMatchObject({ ok: true, mentionStats: {} });
  });

  it('不存在：友好 miss（never-throws）+ 指引回目录', async () => {
    getCatalogEntry.mockReturnValue(undefined);
    const res = await getEntryHandler(ctx({ entry_id: 'ghost' }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'entry_not_found', entryId: 'ghost' });
    expect(res.output).toContain('catalog_entries');
  });

  it('graceful：非法参数 → invalid_params；未注册 → project_not_registered', async () => {
    expect((await getEntryHandler(ctx({}))).metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
    getProject.mockReturnValue(undefined);
    expect((await getEntryHandler(ctx({ entry_id: 'x' }))).metadata).toMatchObject({
      ok: false,
      reason: 'project_not_registered',
    });
  });
});

describe('catalogHandlers — query_mentions ledger 视图 (Story 8.7 S6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProject.mockReturnValue({ projectId: '00001' });
    // 8.3 S5：章序取数走轻列窗查询（不拉 summary JSON；episodeId/episodeIndex 两字段消费）。
    listEpisodeStoryTimeWindows.mockReturnValue([
      windowRecord('ep-9', 9, { storyTimeEnd: 90, storyTimeStart: 81 }),
      windowRecord('ep-10', 10, { storyTimeEnd: 100, storyTimeStart: 91 }),
      windowRecord('ep-2', 2, { storyTimeEnd: 20, storyTimeStart: 11 }),
    ]);
  });

  it('实体出场史：章序排序（episode_index 而非字典序）+ 人话 presence/source/通道', async () => {
    queryMentionLedger.mockReturnValue([
      mentionRow({ episodeId: 'ep-9', entryId: 'erina' }),
      mentionRow({
        episodeId: 'ep-2',
        entryId: 'erina',
        presence: 'mentioned',
        declared: 0,
        source: 'conservative',
        coarseCount: 2,
      }),
      mentionRow({ episodeId: 'ep-10', entryId: 'erina', planLinked: 1, coarseCount: 0 }),
    ]);

    const res = await queryMentionsHandler(ctx({ entry_id: 'erina' }));

    expect(queryMentionLedger).toHaveBeenCalledWith('00001', {
      entryId: 'erina',
      episodeId: undefined,
      presence: undefined,
    });
    const rows = (res.metadata as { rows: ClosureMentionRow[] }).rows;
    // 章序（episode_index 2 < 9 < 10）非字典序（ep-10 < ep-2 < ep-9）。
    expect(rows.map((r) => r.episodeId)).toEqual(['ep-2', 'ep-9', 'ep-10']);
    expect(res.output).toContain('（第 3 章）'); // ep-2 → index 2 → 第 3 章
    expect(res.output).toContain('被提及');
    expect(res.output).toContain('保守账（无申报）');
    expect(res.output).toContain('含写手申报');
    expect(res.output).toContain('明写名 3 次');
    expect(res.output).toContain('计划登场');
    expect(res.metadata).toMatchObject({ ok: true, view: 'ledger', count: 3, entryId: 'erina' });
  });

  it('无 index 章：排最后 + 无「第 N 章」标注（graceful）', async () => {
    queryMentionLedger.mockReturnValue([
      mentionRow({ episodeId: 'ep-x' }),
      mentionRow({ episodeId: 'ep-2' }),
    ]);
    const res = await queryMentionsHandler(ctx({}));
    const rows = (res.metadata as { rows: ClosureMentionRow[] }).rows;
    expect(rows.map((r) => r.episodeId)).toEqual(['ep-2', 'ep-x']);
    expect(res.output).not.toContain('ep-x（第');
  });

  it('零行：友好 miss（账未建语义，非空结果）', async () => {
    queryMentionLedger.mockReturnValue([]);
    const res = await queryMentionsHandler(ctx({ entry_id: 'ghost' }));
    expect(res.output).toContain('没有匹配的记录');
    expect(res.metadata).toMatchObject({ ok: true, view: 'ledger', count: 0 });
  });

  it('graceful：非法参数（presence 坏值）→ invalid_params；未注册 → not_registered', async () => {
    expect((await queryMentionsHandler(ctx({ presence: 'ghost' }))).metadata).toMatchObject({
      ok: false,
      reason: 'invalid_params',
    });
    getProject.mockReturnValue(undefined);
    expect((await queryMentionsHandler(ctx({}))).metadata).toMatchObject({
      ok: false,
      reason: 'project_not_registered',
    });
  });
});

describe('catalogHandlers — query_mentions gap_stats 视图（Story 8.3 S5 取数下推后组装）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProject.mockReturnValue({ projectId: '00001' });
    // 窗：ep-2 [11,20] / ep-9 [81,90]。
    listEpisodeStoryTimeWindows.mockReturnValue([
      windowRecord('ep-2', 2, { storyTimeStart: 11, storyTimeEnd: 20 }),
      windowRecord('ep-9', 9, { storyTimeStart: 81, storyTimeEnd: 90 }),
    ]);
  });

  it('全实体统计（未收窄）：mention 走 per-entry 聚合（不拉全账行）+ patches per-subject 聚合 + 锚点 = 数据源最大 storyTime', async () => {
    // recent 的 ep-9 窗 end 90 = 锚点持有者 → gap 0 被 minGap 滤除（近期活跃者滤掉的 by-design 行为）。
    aggregateMentionAppearance.mockReturnValue([
      { entryId: 'erina', bestEpisodeId: 'ep-2', bestStoryTime: 20, hasUnresolvedWindow: false },
      { entryId: 'recent', bestEpisodeId: 'ep-9', bestStoryTime: 90, hasUnresolvedWindow: false },
    ]);
    // 无 mention 行的 subject：patches 口径（聚合投影形态——每 subject 只剩 max 行 70 → gap 20）。
    listLastPatchFacts.mockReturnValue([{ subjectId: 'mentor', storyTime: 70, sliceId: 'ep-7:70' }]);

    const res = await queryMentionsHandler(ctx({ view: 'gap_stats' }));

    // 未收窄 → mention 臂走聚合投影，不拉全账行（S5 数量级下降点的取数形态断言）。
    expect(aggregateMentionAppearance).toHaveBeenCalledWith('00001');
    expect(queryMentionLedger).not.toHaveBeenCalled();
    expect(listLastPatchFacts).toHaveBeenCalledWith('00001', undefined);
    const meta = res.metadata as {
      anchorStoryTime: number;
      stats: Array<{ entryId: string; basis: string; storyTimeGap: number; lastEpisodeId?: string }>;
    };
    expect(meta.anchorStoryTime).toBe(90);
    expect(meta.stats.map((s) => s.entryId)).toEqual(['erina', 'mentor']);
    // erina：mention 口径（最后 ep-2 窗 end 20 → gap 70）。
    expect(meta.stats[0]).toMatchObject({ basis: 'mention', storyTimeGap: 70, lastEpisodeId: 'ep-2' });
    // mentor：无 mention 行 → patches 口径（最后 70 → gap 20）。
    expect(meta.stats[1]).toMatchObject({ basis: 'patches', storyTimeGap: 20, lastEpisodeId: 'ep-7' });
    // 输出人话 + 机械统计声明（判断归 LLM）。
    expect(res.output).toContain('storyTime 90');
    expect(res.output).toContain('距今 70');
    expect(res.output).toContain('登场与被提及都算');
    expect(res.output).toContain('世界状态口径');
    expect(res.output).toContain('由你结合剧情判断');
    expect(res.metadata).toMatchObject({ ok: true, view: 'gap_stats' });
  });

  it('聚合带 hasUnresolvedWindow：该实体 mention 口径降档（退 patches / best-effort），与全行路径同语义', async () => {
    // 两实体都有窗缺章（allResolved=false）：erina 有 patches → 退世界状态口径；recent 无 patches →
    // best-effort（已解析窗行）。窗缺语义经 marker 行进纯函数——此处断言端到端输出。
    aggregateMentionAppearance.mockReturnValue([
      { entryId: 'erina', bestEpisodeId: 'ep-2', bestStoryTime: 20, hasUnresolvedWindow: true },
      { entryId: 'recent', bestEpisodeId: 'ep-2', bestStoryTime: 20, hasUnresolvedWindow: true },
    ]);
    listLastPatchFacts.mockReturnValue([{ subjectId: 'erina', storyTime: 60, sliceId: 'ep-6:60' }]);

    const res = await queryMentionsHandler(ctx({ view: 'gap_stats' }));

    const stats = (res.metadata as { stats: Array<{ entryId: string; basis: string }> }).stats;
    const erina = stats.find((s) => s.entryId === 'erina')!;
    expect(erina.basis).toBe('patches'); // 窗缺 + 有 patches → 退世界状态口径（60 → gap 30）
    const recent = stats.find((s) => s.entryId === 'recent')!;
    expect(recent.basis).toBe('mention'); // 窗缺 + 无 patches → best-effort（已解析窗行 20 → gap 70）
  });

  it('entry_id 收窄：mentions 全行路径（聚合不启用）+ patches 聚合下推 SQL 收窄', async () => {
    queryMentionLedger.mockReturnValue([mentionRow({ episodeId: 'ep-2', entryId: 'erina' })]);
    aggregateMentionAppearance.mockReturnValue([
      { entryId: 'erina', bestEpisodeId: 'ep-2', bestStoryTime: 20, hasUnresolvedWindow: false },
    ]);
    listLastPatchFacts.mockReturnValue([{ subjectId: 'erina', storyTime: 50, sliceId: 'ep-5:50' }]);

    const res = await queryMentionsHandler(ctx({ view: 'gap_stats', entry_id: 'erina' }));

    expect(queryMentionLedger).toHaveBeenCalledWith('00001', {
      entryId: 'erina',
      episodeId: undefined,
      presence: undefined,
    });
    // 已收窄 → 聚合路径不启用（收窄行集小，全行直取）。
    expect(aggregateMentionAppearance).not.toHaveBeenCalled();
    // patches 收窄下推进 SQL（subject 维度 WHERE）。
    expect(listLastPatchFacts).toHaveBeenCalledWith('00001', 'erina');
    // 锚点 = max(窗 90, erina patch 50) = 90；erina mention 口径完整（ep-2 窗 end 20 → gap 70）。
    const meta = res.metadata as { stats: Array<{ entryId: string }> };
    expect(meta.stats.map((s) => s.entryId)).toEqual(['erina']);
  });

  it('presence 收窄同样走全行路径（收窄面是账行真子集）', async () => {
    queryMentionLedger.mockReturnValue([mentionRow({ episodeId: 'ep-2', entryId: 'erina' })]);
    listLastPatchFacts.mockReturnValue([]);

    await queryMentionsHandler(ctx({ view: 'gap_stats', presence: 'present' }));

    expect(queryMentionLedger).toHaveBeenCalledWith('00001', {
      entryId: undefined,
      episodeId: undefined,
      presence: 'present',
    });
    expect(aggregateMentionAppearance).not.toHaveBeenCalled();
  });

  it('无锚点（无窗无 patches）：友好 miss（never-throws）', async () => {
    aggregateMentionAppearance.mockReturnValue([]);
    listEpisodeStoryTimeWindows.mockReturnValue([]);
    listLastPatchFacts.mockReturnValue([]);

    const res = await queryMentionsHandler(ctx({ view: 'gap_stats' }));

    expect(res.metadata).toMatchObject({ ok: false, reason: 'no_anchor' });
    expect(res.output).toContain('锚点');
  });

  it('零统计（全部近期活跃 / 无账）：友好空结果', async () => {
    aggregateMentionAppearance.mockReturnValue([]);
    listLastPatchFacts.mockReturnValue([]);

    const res = await queryMentionsHandler(ctx({ view: 'gap_stats' }));

    expect(res.metadata).toMatchObject({ ok: true, view: 'gap_stats', stats: [] });
    expect(res.output).toContain('没有可统计的出场记录');
  });

  it('graceful：repo 抛错 → 友好失败文案（never-throws）', async () => {
    aggregateMentionAppearance.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await queryMentionsHandler(ctx({ view: 'gap_stats' }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'query_failed' });
    expect(res.output).toContain('boom');
  });
});

describe('catalogHandlers — query_mentions signals 视图（Story 8.7 S9：落表对拍信号读取）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProject.mockReturnValue({ projectId: '00001' });
  });

  it('近期章有信号 → describeMentionSignal 单源人话行 + 机械对拍尾注；metadata 携 episodes', async () => {
    listRecentEpisodeMentionSignals.mockReturnValue([
      {
        episodeId: 'ep-5',
        signals: [
          { kind: 'hard_miss', episodeId: 'ep-5', entryId: 'card-wang' },
          { kind: 'alias_suggestion', episodeId: 'ep-5', name: '三师叔', entryId: 'card-li' },
        ],
      },
      { episodeId: 'ep-4', signals: [] }, // 零信号章不渲染行（metadata 原样保留）
    ]);

    const res = await queryMentionsHandler(ctx({ view: 'signals' }));

    expect(listRecentEpisodeMentionSignals).toHaveBeenCalledWith('00001', 3);
    expect(res.metadata).toMatchObject({ ok: true, view: 'signals' });
    // describeMentionSignal 单源文案（shared-contracts——与 leader 注入段同源防漂移）。
    expect(res.output).toContain('没把他报进本章人物表');
    expect(res.output).toContain('三师叔');
    expect(res.output).toContain('别名清单里没有');
    // 机械事实尾注（判断归消费端，范式红线）。
    expect(res.output).toContain('机械对拍事实');
  });

  it('零信号（全对上 / 账未建立）→ 友好空结果（非错误）', async () => {
    listRecentEpisodeMentionSignals.mockReturnValue([]);
    const res = await queryMentionsHandler(ctx({ view: 'signals' }));
    expect(res.metadata).toMatchObject({ ok: true, view: 'signals', episodes: [] });
    expect(res.output).toContain('全部对得上');
    expect(res.output).toContain('逐章建立');
  });
});
