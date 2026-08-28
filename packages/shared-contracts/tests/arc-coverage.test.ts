import { describe, expect, it } from 'vitest';
import {
  arcCoverageReportSchema,
  arcProgressionGapSchema,
  findArcCoverageGaps,
  readGrowthCurveSkipCount,
  readGrowthCurves,
} from '../src/contracts/arc-coverage';
import { computeCompletenessCandidates } from '../src/contracts/completeness-candidates';
import {
  episodeOutlineSchema,
  growthCurveFieldSchema,
  type EpisodeOutline,
} from '../src/contracts/creative-fields';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5 R4：readGrowthCurves（三形态归一单源）+ findArcCoverageGaps（弧覆盖缺口）。
// 覆盖（implement.md Step 1）：单源归一三形态 + 坏数据 graceful / 零曲线 / 有曲线 /
// 悬空 progression（聚合去重）/ 坏 episodeOutlines / schema 契约 + 与 4.4 消费等价。
//
// 范式红线：只报结构事实（id 存在性），不判「该不该有弧」（归 leader LLM，ADR-3）。
// ─────────────────────────────────────────────────────────────────────────────

const curve = (characterId: string, extra: Record<string, unknown> = {}) => ({
  character_id: characterId,
  start_state: '起点',
  ...extra,
});

const episode = (id: string, characterIds: string[]) =>
  episodeOutlineSchema.parse({
    id,
    index: 0,
    title: id,
    character_progressions: characterIds.map((cid) => ({ characterId: cid, from: 'A', to: 'B' })),
  });

// ── readGrowthCurves（三形态归一单源，从 completeness-candidates readGrowthCurve 上提，行为等价）──

describe('readGrowthCurves：三形态归一（单源，行为等价上提）', () => {
  it('null / undefined → undefined（source-missing 语义）', () => {
    expect(readGrowthCurves(undefined)).toBeUndefined();
    expect(readGrowthCurves(null)).toBeUndefined();
  });

  it('单条形态 → 包成数组 + safeParse 应用 defaults（turning_points 等）', () => {
    const out = readGrowthCurves(curve('c1', { desire: '被认可' }));
    expect(out).toHaveLength(1);
    expect(out![0].character_id).toBe('c1');
    expect(out![0].desire).toBe('被认可');
    expect(out![0].turning_points).toEqual([]); // defaults 已填
    expect(out![0].regressions).toEqual([]);
  });

  it('array 形态直通（canonical）+ 坏条目跳过不抛', () => {
    const out = readGrowthCurves([curve('c1'), 'garbage', null, curve('c2')]);
    expect(out).toHaveLength(2);
    expect(out!.map((c) => c.character_id)).toEqual(['c1', 'c2']);
  });

  it('Record 形态 → values（宽容解析：值自带 character_id 直用 + 坏值跳过不抛）', () => {
    const out = readGrowthCurves({
      c1: curve('c1'),
      garbage: 'not-a-curve',
      c2: curve('c2'),
    });
    expect(out).toHaveLength(2);
    expect(out!.map((c) => c.character_id)).toEqual(['c1', 'c2']);
  });

  // ── CR-Blind-F2（8.5 CR）：Record key 补缺 character_id（对齐 storage 侧 growthCurveFieldSchema 同语义）。──
  it('Record 值缺 character_id → key 补（值内自带优先；手写 yaml 常态 key 即角色 id）', () => {
    const out = readGrowthCurves({
      charA: { start_state: '落魄书生' }, // 无 character_id → key 补
      charB: curve('char-real'), // 值内自带 → 值内优先（key charB 被忽略）
    });
    expect(out).toHaveLength(2);
    expect(out!.map((c) => c.character_id)).toEqual(['charA', 'char-real']);
    expect(out![0]).toMatchObject({ character_id: 'charA', start_state: '落魄书生' });
    // key 补缺条目同样过 safeParse（defaults 已填）。
    expect(out![0].turning_points).toEqual([]);
  });

  it('双侧等价：key-only Record 经 readGrowthCurves 与 storage 侧 growthCurveFieldSchema 归一结果一致（消两套真相）', () => {
    const record = {
      charA: { start_state: '落魄书生', desire: '翻身' },
      charB: { start_state: '隐世高人' },
    };
    expect(readGrowthCurves(record)).toEqual(growthCurveFieldSchema.parse(record));
  });

  it('Record 值缺 character_id 且缺 start_state → 仍跳过（key 只补身份，不补必填结构）', () => {
    expect(readGrowthCurves({ charA: { desire: '无起点' } })).toBeUndefined();
  });

  it('0 有效条目 / 非对象原始值 → undefined', () => {
    expect(readGrowthCurves({})).toBeUndefined(); // 空 Record
    expect(readGrowthCurves([])).toBeUndefined(); // 空 array
    expect(readGrowthCurves('a string')).toBeUndefined();
    expect(readGrowthCurves(42)).toBeUndefined();
    expect(readGrowthCurves({ k: 'garbage' })).toBeUndefined(); // Record 全坏值
  });

  it('单源双消费等价：computeCompletenessCandidates 单条形态 raw → arc 候选仍产出（4.4 零回归）', () => {
    // readGrowthCurve 上提为 readGrowthCurves 后，4.4 消费路径行为等价（逻辑等价搬家证明）。
    const report = computeCompletenessCandidates({
      growthCurveRaw: curve('c1', { turning_points: [{ turning_point: '觉醒', linked_episode_ids: ['ep1'] }] }),
      writtenEpisodeIds: ['ep1'],
    });
    expect(report.arc).toHaveLength(1);
    expect(report.arc[0].character_id).toBe('c1');
    expect(report.arc[0].turningPointsTouchedWritten).toBe(1);
  });
});

// ── readGrowthCurveSkipCount（CR-002：读侧坏形态计数透出——「空」与「坏」两态可区分）──

describe('readGrowthCurveSkipCount：坏形态计数（CR-002）', () => {
  it('null / undefined / 全好数据 / 空 Record → 0（缺字段 ≠ 坏数据；好数据零坏条目）', () => {
    expect(readGrowthCurveSkipCount(undefined)).toBe(0);
    expect(readGrowthCurveSkipCount(null)).toBe(0);
    expect(readGrowthCurveSkipCount([curve('c1'), curve('c2')])).toBe(0);
    expect(readGrowthCurveSkipCount(curve('c1'))).toBe(0); // 单条好形态
    expect(readGrowthCurveSkipCount({ c1: curve('c1') })).toBe(0); // Record 全好
    expect(readGrowthCurveSkipCount({})).toBe(0); // 空 Record：合法空非坏
  });

  it('array 混坏条目 → 逐条计数（好条目照常读，readGrowthCurves 行为不变）', () => {
    const raw = [curve('c1'), 'garbage', null, curve('c2')];
    expect(readGrowthCurveSkipCount(raw)).toBe(2);
    expect(readGrowthCurves(raw)).toHaveLength(2); // 有效曲线照常（既有行为零回归）
  });

  it('Record 混坏值 → 逐条计数（key 补缺好值照常读）', () => {
    expect(readGrowthCurveSkipCount({ c1: curve('c1'), garbage: 'not-a-curve', junk: 42 })).toBe(2);
    // key-only 好值（key 补 character_id）不算坏。
    expect(readGrowthCurveSkipCount({ charA: { start_state: '落魄书生' } })).toBe(0);
  });

  it('整体非对象非数组（string/number）→ 1（字段存在但整体形态坏，引导段如实显示数据坏）', () => {
    expect(readGrowthCurveSkipCount('a string')).toBe(1);
    expect(readGrowthCurveSkipCount(42)).toBe(1);
  });
});

// ── findArcCoverageGaps（弧覆盖缺口，纯函数）──

describe('findArcCoverageGaps：零曲线信号', () => {
  it('growthCurveRaw undefined / null / 空 Record → totalCurves=0（引导段主动提议时机判断用）', () => {
    for (const raw of [undefined, null, {}]) {
      const report = findArcCoverageGaps(raw, [episode('ep1', ['c1'])]);
      expect(report.totalCurves).toBe(0);
      expect(report.characterIds).toEqual([]);
    }
  });

  it('零曲线 + episode 有 progression 引用 → 悬空缺口如实报（不因零曲线而吞）', () => {
    const report = findArcCoverageGaps(undefined, [episode('ep1', ['c1'])]);
    expect(report.progressionsWithoutCurve).toHaveLength(1);
    expect(report.progressionsWithoutCurve[0].characterId).toBe('c1');
  });
});

describe('findArcCoverageGaps：现状清单', () => {
  it('有曲线 → totalCurves + characterIds 如实清单（8.6「有曲线」阶段判定 = totalCurves > 0）', () => {
    const report = findArcCoverageGaps([curve('c1'), curve('c2')], undefined);
    expect(report.totalCurves).toBe(2);
    expect(report.characterIds).toEqual(['c1', 'c2']);
  });

  it('characterIds 去重保首现序 + totalCurves = 去重角色数（CR-007：与写侧 add_curve partial-merge 语义一致）', () => {
    const report = findArcCoverageGaps([curve('c1'), curve('c1'), curve('c2')], undefined);
    expect(report.totalCurves).toBe(2); // CR-007：同角色双条目归并一角色一弧（去重计数，非原始条目数 3）
    expect(report.characterIds).toEqual(['c1', 'c2']); // 清单去重
  });
});

describe('findArcCoverageGaps：悬空 progression（dangling 同构真缺口）', () => {
  it('episode 引用无 curve 角色 → 按角色聚合一条（episodeIds 收全部引用集，episode 原序）', () => {
    const report = findArcCoverageGaps(
      [curve('c1')],
      [episode('ep1', ['c1', 'c2']), episode('ep2', ['c2']), episode('ep3', ['c1'])],
    );
    expect(report.progressionsWithoutCurve).toHaveLength(1);
    const gap = report.progressionsWithoutCurve[0];
    expect(gap.characterId).toBe('c2');
    expect(gap.episodeIds).toEqual(['ep1', 'ep2']);
    expect(gap.message).toContain('c2');
    expect(gap.message).toContain('ep1');
  });

  it('同 episode 内重复引用同悬空角色 → episodeIds 场内去重', () => {
    const report = findArcCoverageGaps(undefined, [episode('ep1', ['c2', 'c2'])]);
    expect(report.progressionsWithoutCurve).toHaveLength(1);
    expect(report.progressionsWithoutCurve[0].episodeIds).toEqual(['ep1']);
  });

  it('引用的角色全有 curve → 无缺口', () => {
    const report = findArcCoverageGaps([curve('c1')], [episode('ep1', ['c1'])]);
    expect(report.progressionsWithoutCurve).toEqual([]);
  });

  it('episodeOutlines undefined / 空数组 → 无 progression 可查（空缺口，graceful）', () => {
    expect(findArcCoverageGaps([curve('c1')], undefined).progressionsWithoutCurve).toEqual([]);
    expect(findArcCoverageGaps([curve('c1')], []).progressionsWithoutCurve).toEqual([]);
  });

  it('episodeOutlines 非数组（caller 传 raw 未 parse 数据）→ 守卫归一空数组不抛（CR-Edge-F6）', () => {
    const report = findArcCoverageGaps(
      [curve('c1')],
      'not-an-array' as unknown as EpisodeOutline[],
    );
    expect(report.totalCurves).toBe(1); // growth_curve 侧照常
    expect(report.progressionsWithoutCurve).toEqual([]); // 无可查，不抛
    const report2 = findArcCoverageGaps(undefined, { id: 'ep1' } as unknown as EpisodeOutline[]);
    expect(report2.progressionsWithoutCurve).toEqual([]);
  });
});

describe('findArcCoverageGaps：坏数据 graceful（不抛，坏元素跳过）', () => {
  it('episodeOutlines 元素非对象 / id 坏 / character_progressions 非数组 → 跳过不抛', () => {
    const report = findArcCoverageGaps(
      undefined,
      [
        null,
        'not-an-episode',
        { id: 42, index: 0, title: 't', character_progressions: [{ characterId: 'c1', from: 'a', to: 'b' }] },
        { id: 'ep-prog-not-array', index: 0, title: 't', character_progressions: 'not-an-array' },
        episodeOutlineSchema.parse({ id: 'ep-no-prog', index: 0, title: 't' }),
      ] as unknown as ReturnType<typeof episode>[],
    );
    // id 坏（number）的 episode 被跳过 → c1 引用不入缺口；character_progressions 非数组 → 跳过。
    expect(report.progressionsWithoutCurve).toEqual([]);
  });

  it('progression 元素非对象 / characterId 非字符串 → 跳过；合法悬空条目仍报', () => {
    const mixed = episodeOutlineSchema.parse({
      id: 'ep1',
      index: 0,
      title: 't',
      character_progressions: [],
    });
    // 注入坏元素（绕过 schema 构造 raw 形态——消费端可能传 raw 未 parse 数据）
    (mixed.character_progressions as unknown[]).push(null, { characterId: 42 }, 'garbage', {
      characterId: 'c2',
      from: 'A',
      to: 'B',
    });
    const report = findArcCoverageGaps(undefined, [mixed]);
    expect(report.progressionsWithoutCurve).toHaveLength(1);
    expect(report.progressionsWithoutCurve[0].characterId).toBe('c2');
  });
});

// ── schema 契约 ──

describe('arc-coverage schema 契约（输出可被 schema parse）', () => {
  it('混合形态产出全部通过 arcCoverageReportSchema（输出契约自洽）', () => {
    const report = findArcCoverageGaps([curve('c1')], [episode('ep1', ['c1', 'c2'])]);
    expect(arcCoverageReportSchema.safeParse(report).success).toBe(true);
  });

  it('arcProgressionGapSchema 拒绝空 episodeIds 与空 characterId（契约下界）', () => {
    expect(
      arcProgressionGapSchema.safeParse({ characterId: '', episodeIds: ['ep1'], message: 'x' }).success,
    ).toBe(false);
    expect(
      arcProgressionGapSchema.safeParse({ characterId: 'c1', episodeIds: [], message: 'x' }).success,
    ).toBe(false);
  });

  it('message 超 5 集折叠「等 N 集」，episodeIds 数据保全（mirror setting-coverage）', () => {
    const episodes = ['ep1', 'ep2', 'ep3', 'ep4', 'ep5', 'ep6', 'ep7'].map((id) => episode(id, ['c2']));
    const report = findArcCoverageGaps(undefined, episodes);
    expect(report.progressionsWithoutCurve[0].episodeIds).toHaveLength(7);
    expect(report.progressionsWithoutCurve[0].message).toContain('等 7 集');
  });
});
