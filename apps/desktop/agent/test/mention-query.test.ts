import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  ClosureMentionRow,
  MentionSignal,
  WorldPatch,
} from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.7 S9：mention-query 取数面测试（design §2.4 弹药/编译面共用的取数腿）。
//
// 覆盖（dispatch S9 交付 1/6 的双源断言）：
// - fetchAppearanceGapStatsViaTools：mention 行优先（窗齐 = mention 口径）/ 出场账工具缺 → 退 patches
//   口径 / 窗缺章回退 / 分批（>50 章）/ 坏行逐条丢 / degradedReasons 注记。
// - fetchAmmoViaTools（research-verifier 弹药接缝）：anchor 缺降级 / 组合面透传。
// - fetchRecentMentionSignalsViaTool：三态（ok 正常读零信号章滤除 / no_project 未注册常态 /
//   unavailable 工具缺·查询失败真降级）（BMad CR-007）。
//
// mock registry（mirror world-state-query-equivalence.test.ts 模式）：mockGet 控制工具可见性；
// 间隔统计本体（buildAppearanceGapStats 双源语义）在 shared-contracts 单测锚定，此处锚定取数契约层。
// ─────────────────────────────────────────────────────────────────────────────

let mockGet: ((id: string) => unknown) | undefined;
vi.mock('../src/tool/registry', () => ({
  registry: {
    get: (id: string) => mockGet?.(id),
  },
}));

import {
  fetchAppearanceGapStatsViaTools,
  fetchEpisodeStoryTimeWindowsViaTool,
  fetchMentionLedgerRowsViaTool,
  fetchRecentMentionSignalsViaTool,
} from '../src/nodes/mention-query';
import { fetchAmmoViaTools } from '../src/nodes/research-verifier';
import type { WriterVerifyInput } from '../src/nodes/writer-node';

// ── fake 工具（metadata 形态 mirror catalogHandlers / worldStateHandlers 实产）──

/** 合法 mention 账行（closureMentionRowSchema 全字段）。 */
function row(episodeId: string, entryId: string): ClosureMentionRow {
  return {
    projectId: '00001',
    episodeId,
    entryId,
    presence: 'present',
    declared: 1,
    presenceShot: 0,
    coarseHit: 1,
    planLinked: 0,
    coarseCount: 2,
    stateChanged: 0,
    source: 'full',
    updatedAt: '2026-08-19 00:00:00',
  };
}

/** 章摘要 record（query_chapter_summary metadata.summaries 元素形态）。 */
function summaryRecord(episodeId: string, storyTimeEnd: number): Record<string, unknown> {
  return {
    episodeId,
    episodeIndex: Number(episodeId.replace(/\D/g, '')) || null,
    storyTimeEnd,
    summary: { storyTimeStart: storyTimeEnd - 10 },
    tokenEstimate: 100,
    truncated: false,
    patchRowidHigh: 0,
    updatedAt: '2026-08-19 00:00:00',
  };
}

function worldPatch(subjectId: string, storyTime: number): WorldPatch {
  return {
    id: `p-${subjectId}-${storyTime}`,
    sliceId: `sl-${subjectId}`,
    subjectId,
    path: '/hp',
    op: 'replace',
    axis: 'physical',
    source: 'derived',
    storyTime,
  };
}

function fakeTool(id: string, execute: (params: Record<string, unknown>) => unknown): unknown {
  return {
    id,
    description: `fake ${id}`,
    parameters: {},
    execute: async (params: Record<string, unknown>) => execute(params),
  };
}

/** 三工具全配（出场账 + 章摘要 + 世界状态）。 */
function registerAll(opts: {
  mentionRows?: Array<Record<string, unknown>>;
  summaries?: Array<Record<string, unknown>>;
  patches?: WorldPatch[];
}): void {
  mockGet = (id: string) => {
    if (id === 'query_mentions') {
      return fakeTool(id, () => ({
        title: id,
        output: '',
        metadata: { ok: true, view: 'ledger', count: opts.mentionRows?.length ?? 0, rows: opts.mentionRows ?? [] },
      }));
    }
    if (id === 'query_chapter_summary') {
      return fakeTool(id, (params) => ({
        title: id,
        output: '',
        metadata: { ok: true, count: opts.summaries?.length ?? 0, summaries: opts.summaries ?? [] },
      }));
    }
    if (id === 'query_world_slice') {
      return fakeTool(id, () => ({
        title: id,
        output: '',
        metadata: { ok: true, count: 1, slices: [{ patches: opts.patches ?? [] }] },
      }));
    }
    return undefined;
  };
}

// ── fetchMentionLedgerRowsViaTool ──

describe('fetchMentionLedgerRowsViaTool — 出场账行取数', () => {
  beforeEach(() => {
    mockGet = undefined;
  });

  it('正常读：逐条 safeParse（坏行丢好行留）；工具缺/ok:false → undefined', async () => {
    registerAll({ mentionRows: [row('ep-1', 'char-a') as unknown as Record<string, unknown>, { episodeId: 'bad' }] });
    const rows = await fetchMentionLedgerRowsViaTool('/test');
    expect(rows).toHaveLength(1);
    expect(rows![0].entryId).toBe('char-a');

    mockGet = undefined;
    expect(await fetchMentionLedgerRowsViaTool('/test')).toBeUndefined();

    mockGet = (id) =>
      id === 'query_mentions'
        ? fakeTool(id, () => ({ title: id, output: '', metadata: { ok: false, reason: 'project_not_registered' } }))
        : undefined;
    expect(await fetchMentionLedgerRowsViaTool('/test')).toBeUndefined();
  });
});

// ── fetchEpisodeStoryTimeWindowsViaTool ──

describe('fetchEpisodeStoryTimeWindowsViaTool — 章摘要窗取数（分批 + graceful）', () => {
  beforeEach(() => {
    mockGet = undefined;
  });

  it('只查传入章 + 超 50 章分批（episodeIds chunk ≤ cap）', async () => {
    const calls: Array<string[]> = [];
    const episodeIds = Array.from({ length: 120 }, (_, i) => `ep-${i}`);
    mockGet = (id) =>
      id === 'query_chapter_summary'
        ? fakeTool(id, (params) => {
            const ids = (params as { episodeIds: string[] }).episodeIds;
            calls.push(ids);
            return {
              title: id,
              output: '',
              metadata: {
                ok: true,
                count: ids.length,
                summaries: ids.map((ep) => summaryRecord(ep, 10)),
              },
            };
          })
        : undefined;
    const windows = await fetchEpisodeStoryTimeWindowsViaTool('/test', episodeIds);
    expect(windows).toHaveLength(120);
    expect(calls).toHaveLength(3); // 120 章 → 50+50+20 三批。
    expect(calls[0]).toHaveLength(50);
    expect(calls[2]).toHaveLength(20);
    expect(windows[0]).toMatchObject({ episodeId: 'ep-0', storyTimeStart: 0, storyTimeEnd: 10 });
  });

  it('工具缺 → 空窗（mention 口径不完整→纯函数走 patches 回退）；单批失败不弃整面', async () => {
    expect(await fetchEpisodeStoryTimeWindowsViaTool('/test', ['ep-1'])).toEqual([]);

    // 51 章 → 两批（50 + 1）；第一批抛 → 该批章无窗，第二批照常（部分失败容忍是设计内——实体级
    // patches 回退接住，非整面弃守）。
    const filler = Array.from({ length: 50 }, (_, i) => `ep-f${i}`);
    let call = 0;
    mockGet = (id) =>
      id === 'query_chapter_summary'
        ? fakeTool(id, (params) => {
            call += 1;
            if (call === 1) throw new Error('ipc down');
            const ids = (params as { episodeIds: string[] }).episodeIds;
            return {
              title: id,
              output: '',
              metadata: { ok: true, count: ids.length, summaries: ids.map((ep) => summaryRecord(ep, 5)) },
            };
          })
        : undefined;
    const windows = await fetchEpisodeStoryTimeWindowsViaTool('/test', [...filler, 'ep-keep']);
    expect(windows.map((w) => w.episodeId)).toEqual(['ep-keep']);
  });
});

// ── fetchAppearanceGapStatsViaTools（组合面：双源单源纯函数）──

describe('fetchAppearanceGapStatsViaTools — 间隔统计组合面（S9 双源）', () => {
  beforeEach(() => {
    mockGet = undefined;
  });

  it('mention 行优先：窗齐 → mention 口径（提及也算露面）；无 mention 行的 subject 退 patches 口径', async () => {
    registerAll({
      mentionRows: [row('ep-2', 'char-mentioned') as unknown as Record<string, unknown>],
      summaries: [summaryRecord('ep-2', 50)],
      patches: [worldPatch('char-mentioned', 50), worldPatch('subject-no-row', 30)],
    });
    const face = await fetchAppearanceGapStatsViaTools('/test', 100);
    expect(face.degradedReasons).toEqual([]);
    const mentioned = face.stats.find((s) => s.entryId === 'char-mentioned')!;
    // mention 口径：窗 end=50（storyTimeEnd 优先），gap = 100-50。
    expect(mentioned).toMatchObject({ basis: 'mention', lastEpisodeId: 'ep-2', lastStoryTime: 50, storyTimeGap: 50 });
    // patches-only subject（无 mention 行）：世界状态口径回退（backfill 前兼容）。
    const noRow = face.stats.find((s) => s.entryId === 'subject-no-row')!;
    expect(noRow).toMatchObject({ basis: 'patches', lastStoryTime: 30, storyTimeGap: 70 });
  });

  it('出场账工具缺 → 全体退 patches 口径（8.4 前行为等价）+ degradedReasons 注记', async () => {
    mockGet = (id) =>
      id === 'query_world_slice'
        ? fakeTool(id, () => ({ title: id, output: '', metadata: { ok: true, count: 1, slices: [{ patches: [worldPatch('char-a', 20)] }] } }))
        : undefined;
    const face = await fetchAppearanceGapStatsViaTools('/test', 100);
    expect(face.degradedReasons).toContain('出场账查询不可用（退世界状态口径）');
    expect(face.stats).toHaveLength(1);
    expect(face.stats[0]).toMatchObject({ entryId: 'char-a', basis: 'patches', storyTimeGap: 80 });
  });

  it('窗缺章（摘要无行）→ 该实体 mention 口径不完整 → 退 patches 口径', async () => {
    registerAll({
      mentionRows: [row('ep-9', 'char-far') as unknown as Record<string, unknown>],
      summaries: [], // ep-9 无摘要行 → 窗缺
      patches: [worldPatch('char-far', 40)],
    });
    const face = await fetchAppearanceGapStatsViaTools('/test', 100);
    const far = face.stats.find((s) => s.entryId === 'char-far')!;
    expect(far.basis).toBe('patches');
    expect(far.lastStoryTime).toBe(40);
  });
});

// ── fetchAmmoViaTools（弹药接缝：anchor + 组合面透传）──

describe('fetchAmmoViaTools — 资料员弹药接缝（S9 双源接线）', () => {
  beforeEach(() => {
    mockGet = undefined;
  });

  function verifyInput(over: Partial<WriterVerifyInput> = {}): WriterVerifyInput {
    return {
      brief: { plan: '', entries: [], issues: [], execution_plan: [], deviations: [] },
      episodeId: 'ep-12',
      chapterBrief: {},
      sceneGraph: undefined,
      episodeOutlines: undefined,
      ...over,
    };
  }

  it('anchor 缺（scene_graph 缺/本章无场）→ 间隔缺 + 注记（弧停滞照常走自己的降级）', async () => {
    registerAll({ patches: [worldPatch('char-a', 10)] });
    const ammo = await fetchAmmoViaTools('/test', verifyInput({ sceneGraph: undefined }));
    expect(ammo.intervals).toEqual([]);
    expect(ammo.degradedReasons).toContain('本章开场 storyTime 无法解析（scene_graph 缺或本章无场）');
  });

  it('anchor 在 + 出场账在 → 间隔走 mention 口径（弹药面消费组合面，不重写口径）', async () => {
    registerAll({
      mentionRows: [row('ep-2', 'char-mei') as unknown as Record<string, unknown>],
      summaries: [summaryRecord('ep-2', 20)],
      patches: [],
    });
    // query_arc + episodeOutlines 配齐（弧停滞路不降级——本测试聚焦间隔口径，degradedReasons 应空）。
    const base = mockGet;
    mockGet = (id) =>
      id === 'query_arc'
        ? fakeTool(id, () => ({ title: id, output: '', metadata: { ok: true, beats: [] } }))
        : base?.(id);
    const sceneGraph = {
      lines: [],
      nodes: [{ id: 's1', lineTags: [], storyTime: 100, presentationOrder: { chapter: 9, pos: 0 }, episodeId: 'ep-12' }],
    };
    const ammo = await fetchAmmoViaTools('/test', verifyInput({ sceneGraph, episodeOutlines: [{ id: 'ep-12', index: 9 }] }));
    expect(ammo.intervals).toHaveLength(1);
    expect(ammo.intervals[0]).toMatchObject({ entryId: 'char-mei', basis: 'mention', storyTimeGap: 80 });
    expect(ammo.degradedReasons).toEqual([]);
  });
});

// ── fetchRecentMentionSignalsViaTool（leader 注入段数据源；BMad CR-007 三态）──

describe('fetchRecentMentionSignalsViaTool — 落表信号读取（三态）', () => {
  beforeEach(() => {
    mockGet = undefined;
  });

  it('ok：正常读（零信号章滤除）；工具缺/ok:false（无 reason）→ unavailable', async () => {
    const signals: MentionSignal[] = [
      { kind: 'hard_miss', episodeId: 'ep-5', entryId: 'char-a' },
      { kind: 'bad-shape' } as unknown as MentionSignal, // 坏形态条目整条丢
    ];
    mockGet = (id) =>
      id === 'query_mentions'
        ? fakeTool(id, (params) => ({
            title: id,
            output: '',
            metadata: {
              ok: true,
              view: 'signals',
              episodes: [
                { episodeId: 'ep-5', signals },
                { episodeId: 'ep-4', signals: [] }, // 零信号章不进 leader 面
                { episodeId: 'bad' },
              ],
            },
          }))
        : undefined;
    const out = await fetchRecentMentionSignalsViaTool('/test');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') throw new Error('unreachable');
    expect(out.episodes).toHaveLength(1);
    expect(out.episodes[0].episodeId).toBe('ep-5');
    expect(out.episodes[0].signals).toEqual([{ kind: 'hard_miss', episodeId: 'ep-5', entryId: 'char-a' }]);

    // 工具缺 → unavailable（真降级——leader 段出「暂不可用」行）。
    mockGet = undefined;
    expect(await fetchRecentMentionSignalsViaTool('/test')).toEqual({ kind: 'unavailable' });

    // ok:false 无 project_not_registered reason（查询失败族）→ unavailable。
    mockGet = (id) =>
      id === 'query_mentions'
        ? fakeTool(id, () => ({ title: id, output: '', metadata: { ok: false, reason: 'query_failed' } }))
        : undefined;
    expect(await fetchRecentMentionSignalsViaTool('/test')).toEqual({ kind: 'unavailable' });
  });

  it('BMad CR-007：项目未注册（reason=project_not_registered）→ no_project（常态非降级，leader 段静默）', async () => {
    mockGet = (id) =>
      id === 'query_mentions'
        ? fakeTool(id, () => ({
            title: id,
            output: '当前项目未注册到数据库，无法访问出场账。',
            metadata: { ok: false, reason: 'project_not_registered' },
          }))
        : undefined;
    expect(await fetchRecentMentionSignalsViaTool('/test')).toEqual({ kind: 'no_project' });
  });
});
