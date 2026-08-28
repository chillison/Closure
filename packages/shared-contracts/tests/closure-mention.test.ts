import { describe, expect, it } from 'vitest';
import {
  buildAppearanceGapStats,
  buildCoarseScan,
  closureMentionRowSchema,
  computeMentionSignals,
  describeMentionSignal,
  mergeMentionChannels,
  mentionPresenceSchema,
  mentionSourceSchema,
  queryMentionsRequestSchema,
  resolveCastNames,
  type CastDeclaration,
  type ClosureMentionRow,
  type MentionChannelFacts,
  type MentionSignal,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.7 S1：mention 共现账契约（design §1.1/§4.1）。三态覆盖：合法行（四通道计数）/
// 缺必填/枚举拒收；请求 schema 空参全默认 + 双向参数 + 枚举拒收。
//
// Story 8.7 S3：汇账纯函数家族（design §2.2/§2.4）。每函数正常/降级/边界三面（dispatch 纪律）。
// ─────────────────────────────────────────────────────────────────────────────

function mkRow(over: Record<string, unknown> = {}) {
  return {
    projectId: '00042',
    episodeId: 'ep-12',
    entryId: 'char-lixuan',
    presence: 'present',
    declared: 1,
    presenceShot: 1,
    coarseHit: 1,
    planLinked: 0,
    coarseCount: 7,
    stateChanged: 1,
    source: 'full',
    updatedAt: '2026-08-19 12:00:00',
    ...over,
  };
}

describe('closureMentionRowSchema', () => {
  it('合法行 round-trip（全通道命中 full 账 + present 最高态）', () => {
    const parsed = closureMentionRowSchema.parse(mkRow());
    expect(parsed.entryId).toBe('char-lixuan');
    expect(parsed.presence).toBe('present');
    expect(parsed.source).toBe('full');
    expect(parsed.coarseCount).toBe(7);
  });

  it('保守账行合法（declared=0 通道全零、mentioned 档、conservative 源）', () => {
    const parsed = closureMentionRowSchema.parse(
      mkRow({
        presence: 'mentioned',
        declared: 0,
        presenceShot: 0,
        coarseHit: 1,
        stateChanged: 0,
        source: 'conservative',
      }),
    );
    expect(parsed.presence).toBe('mentioned');
    expect(parsed.source).toBe('conservative');
  });

  it('缺必填（entryId/updatedAt/presence/source）→ reject', () => {
    for (const key of ['projectId', 'episodeId', 'entryId', 'presence', 'source', 'updatedAt']) {
      const row: Record<string, unknown> = mkRow();
      delete row[key];
      expect(() => closureMentionRowSchema.parse(row)).toThrow();
    }
  });

  it('presence / source 枚举外值 → reject（db CHECK 约束的 schema 镜像）', () => {
    expect(() => closureMentionRowSchema.parse(mkRow({ presence: 'cameo' }))).toThrow();
    expect(() => closureMentionRowSchema.parse(mkRow({ source: 'partial' }))).toThrow();
    expect(mentionPresenceSchema.parse('mentioned')).toBe('mentioned');
    expect(mentionSourceSchema.parse('full')).toBe('full');
    expect(() => mentionPresenceSchema.parse('absent')).toThrow();
    expect(() => mentionSourceSchema.parse('')).toThrow();
  });

  it('计数列负数/非整数 → reject（通道命中 0/1 与次数计数域）', () => {
    expect(() => closureMentionRowSchema.parse(mkRow({ declared: -1 }))).toThrow();
    expect(() => closureMentionRowSchema.parse(mkRow({ coarseCount: 1.5 }))).toThrow();
  });
});

describe('queryMentionsRequestSchema', () => {
  it('空参合法（ledger 视图默认；gap_stats 无 entry_id = 全实体统计属合法查询面）', () => {
    expect(queryMentionsRequestSchema.parse({})).toEqual({});
  });

  it('双向参数 + presence 过滤 + gap_stats 视图均合法', () => {
    expect(queryMentionsRequestSchema.parse({ entry_id: 'char-lixuan' })).toEqual({
      entry_id: 'char-lixuan',
    });
    expect(queryMentionsRequestSchema.parse({ episode_id: 'ep-12' })).toEqual({
      episode_id: 'ep-12',
    });
    expect(
      queryMentionsRequestSchema.parse({ entry_id: 'e', episode_id: 'ep-1', presence: 'mentioned' }),
    ).toEqual({ entry_id: 'e', episode_id: 'ep-1', presence: 'mentioned' });
    expect(queryMentionsRequestSchema.parse({ view: 'gap_stats' })).toEqual({ view: 'gap_stats' });
  });

  it('presence / view 枚举外值 + entry_id 空串 → reject（防拼写错静默空结果）', () => {
    expect(() => queryMentionsRequestSchema.parse({ presence: 'cameo' })).toThrow();
    expect(() => queryMentionsRequestSchema.parse({ view: 'stats' })).toThrow();
    expect(() => queryMentionsRequestSchema.parse({ entry_id: '' })).toThrow();
    expect(() => queryMentionsRequestSchema.parse({ episode_id: '' })).toThrow();
  });
});

// ── S3 fixtures ──

const CARDS = [
  { entryId: 'card-lixuan', name: '李玄', aliases: ['玄真子'] },
  { entryId: 'card-wangwu', name: '王五' },
];

function decl(over: Partial<CastDeclaration> = {}): CastDeclaration {
  return { synopsis: '本章梗概', present: [], mentioned: [], ...over };
}

function fact(entryId: string, over: Partial<MentionChannelFacts> = {}): MentionChannelFacts {
  return {
    entryId,
    coarseCount: 0,
    presenceShot: false,
    planLinked: false,
    stateChanged: false,
    ...over,
  };
}

/** 类型化 mention 行（schema.parse 产出 ClosureMentionRow——gap 统计函数入参类型安全）。 */
function mentionRow(over: Record<string, unknown> = {}): ClosureMentionRow {
  return closureMentionRowSchema.parse({ ...mkRow(), ...over });
}

describe('resolveCastNames（S3：申报名字解析三步）', () => {
  it('正常：精确卡名 → 别名 → 归属映射三级解析 + alias 建议', () => {
    const resolved = resolveCastNames(
      decl({
        present: [{ name: '李玄' }, { name: '三师叔', card: '王五' }],
        mentioned: [{ name: '玄真子' }, { name: '老醉鬼', belongsTo: 'card-lixuan' }],
      }),
      CARDS,
    );
    // 精确名（李玄）+ 归属映射（三师叔→王五：present 池条目）/（老醉鬼→李玄：mentioned 池条目）
    // ——归属映射按申报条目所在池归位（归属可指卡名或卡 id）。
    expect(resolved.declaredPresent).toEqual(new Set(['card-lixuan', 'card-wangwu']));
    expect(resolved.declaredMentioned).toEqual(new Set(['card-lixuan']));
    // 归属映射解析但称呼不在卡名/别名 → alias 建议。
    expect([...resolved.aliasSuggestions].sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
      { name: '三师叔', entryId: 'card-wangwu' },
      { name: '老醉鬼', entryId: 'card-lixuan' },
    ]);
    expect(resolved.unresolved).toEqual([]);
  });

  it('既有别名解析不产 alias 建议（名字已在卡称呼集内）', () => {
    const resolved = resolveCastNames(decl({ mentioned: [{ name: '玄真子' }] }), CARDS);
    expect(resolved.declaredMentioned).toEqual(new Set(['card-lixuan']));
    expect(resolved.aliasSuggestions).toEqual([]);
  });

  it('降级：三步全失败进新面孔池（belongsTo 解析失败也保留线索）', () => {
    const resolved = resolveCastNames(
      decl({
        present: [{ name: '神秘人' }],
        mentioned: [{ name: '小师妹', belongsTo: '不存在的人' }],
      }),
      CARDS,
    );
    expect(resolved.declaredPresent).toEqual(new Set());
    expect(resolved.unresolved).toEqual([
      { name: '神秘人', declaredAs: 'present' },
      { name: '小师妹', declaredAs: 'mentioned', belongsTo: '不存在的人' },
    ]);
  });

  it('边界：无申报（undefined）→ 全空（保守账章）', () => {
    const resolved = resolveCastNames(undefined, CARDS);
    expect(resolved.declaredPresent.size).toBe(0);
    expect(resolved.declaredMentioned.size).toBe(0);
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.aliasSuggestions).toEqual([]);
  });
});

describe('buildCoarseScan（S3：不重叠子串保守计数）', () => {
  it('正常：多卡多称呼各自计数 + cardIndex 序输出', () => {
    const scan = buildCoarseScan('王五出门，李玄拦住了王五。玄真子只是李玄的道号。', CARDS);
    expect(scan.get('card-wangwu')).toBe(2);
    expect(scan.get('card-lixuan')).toBe(3); // 李玄×2 + 玄真子×1
    expect([...scan.keys()]).toEqual(['card-lixuan', 'card-wangwu']);
  });

  it('同位置多称呼命中取最长（同卡 name vs alias 不双计）', () => {
    const cards = [{ entryId: 'card-lsf', name: '李三丰', aliases: ['李三'] }];
    expect(buildCoarseScan('李三丰', cards).get('card-lsf')).toBe(1);
  });

  it('跨卡同位置长名独占（防短名误归因）', () => {
    const cards = [
      { entryId: 'card-ls', name: '李三' },
      { entryId: 'card-lsf', name: '李三丰' },
    ];
    const scan = buildCoarseScan('李三丰来了，又叫了一遍李三丰。', cards);
    expect(scan.get('card-lsf')).toBe(2);
    expect(scan.has('card-ls')).toBe(false);
  });

  it('边界：空文本 / 空索引 / 空串称呼 / 自重叠串 / name==alias 去重', () => {
    expect(buildCoarseScan('', CARDS).size).toBe(0);
    expect(buildCoarseScan('李玄', []).size).toBe(0);
    expect(buildCoarseScan('李玄', [{ entryId: 'x', name: '', aliases: [''] }]).size).toBe(0);
    // 同 needle 自重叠：'aaaa' 中 'aa' 非重叠计数 = 2。
    expect(buildCoarseScan('aaaa', [{ entryId: 'x', name: 'aa' }]).get('x')).toBe(2);
    // name 与 alias 相同 → 同位置不双计。
    expect(
      buildCoarseScan('王五', [{ entryId: 'x', name: '王五', aliases: ['王五'] }]).get('x'),
    ).toBe(1);
  });
});

describe('mergeMentionChannels（S3：四通道合并取最高态 + source 档）', () => {
  it('正常：申报章各档位正确 + source=full + entryId 升序', () => {
    const rows = mergeMentionChannels({
      cardIndex: CARDS,
      declaration: decl({
        present: [{ name: '李玄' }],
        mentioned: [{ name: '王五' }],
      }),
      channelFacts: [
        fact('card-lixuan'), // 申报登场 → present
        fact('card-wangwu'), // 仅申报提及 → mentioned
        fact('card-erina', { coarseCount: 3 }), // 仅粗筛明写名 → mentioned（明写名≠露面）
        fact('card-zhaosi', { presenceShot: true }), // 在场记录 → present
      ],
    });
    const by = new Map(rows.map((r) => [r.entryId, r]));
    expect(by.get('card-lixuan')).toMatchObject({ presence: 'present', declared: 1, source: 'full' });
    expect(by.get('card-wangwu')).toMatchObject({ presence: 'mentioned', declared: 1, source: 'full' });
    expect(by.get('card-erina')).toMatchObject({
      presence: 'mentioned',
      declared: 0,
      coarseHit: 1,
      coarseCount: 3,
      source: 'full',
    });
    expect(by.get('card-zhaosi')).toMatchObject({ presence: 'present', presenceShot: 1, source: 'full' });
    expect(rows.map((r) => r.entryId)).toEqual([...rows.map((r) => r.entryId)].sort());
  });

  it('stateChanged 升 present（未申报也升——状态变化说明本人动了戏）+ planLinked 不升档', () => {
    const rows = mergeMentionChannels({
      cardIndex: CARDS,
      channelFacts: [
        fact('card-a', { stateChanged: true, planLinked: true }),
        fact('card-b', { planLinked: true }),
      ],
    });
    const by = new Map(rows.map((r) => [r.entryId, r]));
    expect(by.get('card-a')).toMatchObject({ presence: 'present', stateChanged: 1, planLinked: 1 });
    expect(by.get('card-b')).toMatchObject({ presence: 'mentioned', planLinked: 1 });
  });

  it('降级：无申报章 → conservative + declared 全 0', () => {
    const rows = mergeMentionChannels({
      cardIndex: CARDS,
      channelFacts: [fact('card-lixuan', { coarseCount: 1 })],
    });
    expect(rows).toEqual([
      {
        entryId: 'card-lixuan',
        presence: 'mentioned',
        declared: 0,
        presenceShot: 0,
        coarseHit: 1,
        planLinked: 0,
        coarseCount: 1,
        stateChanged: 0,
        source: 'conservative',
      },
    ]);
  });

  it('边界：申报了但纯代码通道零命中 → 行仍在（申报是主通道）', () => {
    const rows = mergeMentionChannels({
      cardIndex: CARDS,
      declaration: decl({ present: [{ name: '王五' }] }),
      channelFacts: [],
    });
    expect(rows).toEqual([
      {
        entryId: 'card-wangwu',
        presence: 'present',
        declared: 1,
        presenceShot: 0,
        coarseHit: 0,
        planLinked: 0,
        coarseCount: 0,
        stateChanged: 0,
        source: 'full',
      },
    ]);
  });
});

describe('computeMentionSignals（S3：对拍差异五类信号）', () => {
  it('正常：hard_miss / soft_miss / plan_deviation 同章并出（对照系正确时零误报）', () => {
    const signals = computeMentionSignals({
      episodeId: 'ep-1',
      cardIndex: CARDS,
      declaration: decl({
        present: [{ name: '李玄' }],
        mentioned: [{ name: '王五' }],
      }),
      channelFacts: [
        fact('card-lixuan', { stateChanged: true }), // 已申报登场 → 无信号
        fact('card-wangwu', { stateChanged: true }), // 仅申报提及但动了戏 → hard_miss
        fact('card-erina', { coarseCount: 2 }), // 明写名没报 → soft_miss
        fact('card-zhaosi', { planLinked: true }), // 计划登场没写成 → plan_deviation
        fact('card-sunliu', { planLinked: true, coarseCount: 1 }), // 计划写成+粗筛命中：无 plan_deviation，但明写名没报 → soft_miss
      ],
    });
    expect(signals).toEqual([
      { kind: 'hard_miss', episodeId: 'ep-1', entryId: 'card-wangwu' },
      { kind: 'soft_miss', episodeId: 'ep-1', entryId: 'card-erina', coarseCount: 2 },
      { kind: 'soft_miss', episodeId: 'ep-1', entryId: 'card-sunliu', coarseCount: 1 },
      { kind: 'plan_deviation', episodeId: 'ep-1', entryId: 'card-zhaosi' },
    ]);
  });

  it('new_face + alias_suggestion（申报侧信号，echo episodeId）', () => {
    const signals = computeMentionSignals({
      episodeId: 'ep-2',
      cardIndex: CARDS,
      declaration: decl({
        present: [{ name: '神秘人', card: '李玄' }],
        mentioned: [{ name: '老醉鬼' }],
      }),
      channelFacts: [],
    });
    // '神秘人' 归属映射解析成功（→李玄）→ alias 建议非新面孔；'老醉鬼' 无归属解析 → 新面孔。
    // 输出五类固定序：new_face 在 alias_suggestion 前（组内 name 升序）。
    expect(signals).toEqual([
      { kind: 'new_face', episodeId: 'ep-2', name: '老醉鬼', declaredAs: 'mentioned' },
      { kind: 'alias_suggestion', episodeId: 'ep-2', name: '神秘人', entryId: 'card-lixuan' },
    ]);
  });

  it('降级：无申报章 → hard/soft/new_face/alias 不产生（无对照系不刷屏），plan 对拍照常', () => {
    const signals = computeMentionSignals({
      episodeId: 'ep-3',
      cardIndex: CARDS,
      channelFacts: [
        fact('card-erina', { stateChanged: true, coarseCount: 5 }),
        fact('card-zhaosi', { planLinked: true }),
      ],
    });
    expect(signals).toEqual([{ kind: 'plan_deviation', episodeId: 'ep-3', entryId: 'card-zhaosi' }]);
  });

  it('边界：空申报 + 空通道 → 零信号', () => {
    expect(computeMentionSignals({ episodeId: 'ep-4', cardIndex: CARDS, channelFacts: [] })).toEqual([]);
  });
});

describe('buildAppearanceGapStats（S3：出场间隔统计单源纯函数）', () => {
  const WINDOWS = [
    { episodeId: 'ep-1', storyTimeStart: 100, storyTimeEnd: 110 },
    { episodeId: 'ep-2', storyTimeStart: 150, storyTimeEnd: null }, // end 缺 → 用 start
    { episodeId: 'ep-3', storyTimeStart: 200, storyTimeEnd: 210 },
  ];

  it('正常：mention 行优先（提及也算露面）+ end 优先 + gap 降序', () => {
    const stats = buildAppearanceGapStats(
      [
        mentionRow({ episodeId: 'ep-1', entryId: 'card-a', presence: 'present' }),
        mentionRow({ episodeId: 'ep-3', entryId: 'card-a', presence: 'mentioned' }), // 提及也算
        mentionRow({ episodeId: 'ep-2', entryId: 'card-b', presence: 'mentioned' }),
      ],
      [],
      WINDOWS,
      300,
    );
    expect(stats).toEqual([
      {
        entryId: 'card-b',
        basis: 'mention',
        lastEpisodeId: 'ep-2',
        lastStoryTime: 150,
        storyTimeGap: 150,
      },
      {
        entryId: 'card-a',
        basis: 'mention',
        lastEpisodeId: 'ep-3',
        lastStoryTime: 210,
        storyTimeGap: 90,
      },
    ]);
  });

  it('minGap 滤近期 + cap 截断', () => {
    const mentions = [
      mentionRow({ episodeId: 'ep-1', entryId: 'card-a' }), // gap 190
      mentionRow({ episodeId: 'ep-3', entryId: 'card-b' }), // gap 90
      mentionRow({ episodeId: 'ep-2', entryId: 'card-c' }), // gap 150
    ];
    expect(buildAppearanceGapStats(mentions, [], WINDOWS, 300, 12, 100)).toEqual([
      {
        entryId: 'card-a',
        basis: 'mention',
        lastEpisodeId: 'ep-1',
        lastStoryTime: 110,
        storyTimeGap: 190,
      },
      {
        entryId: 'card-c',
        basis: 'mention',
        lastEpisodeId: 'ep-2',
        lastStoryTime: 150,
        storyTimeGap: 150,
      },
    ]);
    expect(buildAppearanceGapStats(mentions, [], WINDOWS, 300)).toHaveLength(3);
    expect(buildAppearanceGapStats(mentions, [], WINDOWS, 300, 2)).toHaveLength(2);
  });

  it('窗缺章回退 patches 口径（同 id 不双报；patches-only subject 照报）', () => {
    const stats = buildAppearanceGapStats(
      [mentionRow({ episodeId: 'ep-9', entryId: 'card-a' })], // ep-9 无窗
      [
        { subjectId: 'card-a', storyTime: 50, sliceId: 'ep-0:50' }, // 同 id → patches 兜底
        { subjectId: 'subj-x', storyTime: 120, sliceId: 'ep-2:120' }, // patches-only
      ],
      WINDOWS,
      300,
    );
    const by = new Map(stats.map((s) => [s.entryId, s]));
    expect(by.get('card-a')).toEqual({
      entryId: 'card-a',
      basis: 'patches',
      lastEpisodeId: 'ep-0',
      lastStoryTime: 50,
      storyTimeGap: 250,
    });
    expect(by.get('subj-x')).toEqual({
      entryId: 'subj-x',
      basis: 'patches',
      lastEpisodeId: 'ep-2',
      lastStoryTime: 120,
      storyTimeGap: 180,
    });
    expect(stats.filter((s) => s.entryId === 'card-a')).toHaveLength(1);
  });

  it('窗缺 + 无 patches → 已解析窗 best-effort；全行无窗且无 patches → 跳过', () => {
    const stats = buildAppearanceGapStats(
      [
        mentionRow({ episodeId: 'ep-1', entryId: 'card-d' }), // 有窗（end=110）
        mentionRow({ episodeId: 'ep-9', entryId: 'card-d' }), // 无窗 → best-effort 仍用 ep-1
        mentionRow({ episodeId: 'ep-9', entryId: 'card-e' }), // 全行无窗且无 patches → 跳过
      ],
      [],
      WINDOWS,
      300,
    );
    expect(stats).toEqual([
      {
        entryId: 'card-d',
        basis: 'mention',
        lastEpisodeId: 'ep-1',
        lastStoryTime: 110,
        storyTimeGap: 190,
      },
    ]);
  });

  it('边界：空输入 → 空结果；未来/同点数据（gap<=0）被 minGap 滤除', () => {
    expect(buildAppearanceGapStats([], [], [], 100)).toEqual([]);
    expect(buildAppearanceGapStats([mentionRow({ episodeId: 'ep-3', entryId: 'card-a' })], [], WINDOWS, 210)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.7 S9：describeMentionSignal 人话单行（query_mentions signals 视图与 leader 注入段
// 单源双消费——锚定五类各行文案，防两处漂移）。
// ─────────────────────────────────────────────────────────────────────────────

describe('describeMentionSignal — 五类信号人话单行（S9 单源双消费）', () => {
  it('queryMentionsRequestSchema view 收 signals（枚举扩展）；五类各成行含关键事实', () => {
    expect(queryMentionsRequestSchema.safeParse({ view: 'signals' }).success).toBe(true);

    expect(
      describeMentionSignal({ kind: 'hard_miss', episodeId: 'ep-5', entryId: 'card-a' }),
    ).toBe('[ep-5] card-a：世界状态显示他动了戏（状态变了），但写手没把他报进本章人物表');
    expect(
      describeMentionSignal({ kind: 'soft_miss', episodeId: 'ep-5', entryId: 'card-a', coarseCount: 3 }),
    ).toBe('[ep-5] card-a：名字在正文出现了 3 次，但写手没报（登场或被提及都没报）');
    expect(
      describeMentionSignal({ kind: 'plan_deviation', episodeId: 'ep-4', entryId: 'card-b' }),
    ).toBe('[ep-4] card-b：计划里本章该登场，但正文、人物表、状态记录里都没有——计划没写成');
    expect(
      describeMentionSignal({ kind: 'new_face', episodeId: 'ep-4', name: '三师叔', declaredAs: 'present', belongsTo: '李玄' }),
    ).toBe('[ep-4] 新面孔「三师叔」：写手申报他登场（写手标注归属：李玄），但项目没有对应的卡');
    expect(
      describeMentionSignal({ kind: 'alias_suggestion', episodeId: 'ep-3', name: '老三', entryId: 'card-c' }),
    ).toBe('[ep-3] 称呼「老三」：写手用它指 card-c，但这张卡的别名清单里没有——补录后记账与检索才都认得这个称呼');
  });

  it('BMad CR-004：未知 kind（版本 skew/手改库行）→ default 降级文案，不产 "undefined" 字面', () => {
    // 信号行从 db JSON 列直出（零 schema 校验）——新版本写的 kind 旧版本不识的形态会到这里。
    const unknownKind = describeMentionSignal({
      kind: 'future_signal',
      episodeId: 'ep-9',
    } as unknown as MentionSignal);
    expect(unknownKind).toContain('未知信号类型');
    expect(unknownKind).toContain('kind=future_signal');
    expect(unknownKind).toContain('ep-9');
    expect(unknownKind).not.toContain('undefined');

    // kind/episodeId 缺失的坏行：占位文案不炸（不产 "undefined" / 空 []）。
    const mangled = describeMentionSignal({} as unknown as MentionSignal);
    expect(mangled).toContain('未知信号类型');
    expect(mangled).toContain('(缺失)');
    expect(mangled).toContain('未知章');
    expect(mangled).not.toContain('undefined');
  });
});
