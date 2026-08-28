import { describe, expect, it } from 'vitest';
import {
  assetCardSchema,
  countCharacterCards,
  findSettingCoverageGaps,
  findUnanchoredCharacterProgressions,
  sceneGraphSchema,
  settingCoverageGapSchema,
  type AssetCard,
  type SceneGraph,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.2 WP-C：findSettingCoverageGaps（B 轴结构覆盖缺口，纯函数）。
// 覆盖（implement.md Step 1）：悬空 ref / 全命中 / 空 scene_graph / assetRefs 缺省 /
// 空 assetCards / 重复 ref 幂等（场内去重 + 跨场聚合）+ 顺序确定性 + schema 契约。
//
// 范式红线：只报结构缺口（id 存在性），不判「设定够不够用」（归 leader LLM，ADR-3）。
// ─────────────────────────────────────────────────────────────────────────────

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

const card = (id: string): AssetCard =>
  assetCardSchema.parse({ id, type: 'character', name: id });

/** Minimal scene fixture (mirror scene-graph-analytics.test node helper + optional assetRefs). */
function node(id: string, assetRefs?: string[]) {
  return {
    id,
    lineTags: [],
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...(assetRefs ? { assetRefs } : {}),
  };
}

// ── dangling_ref（悬空引用 → warning）──

describe('findSettingCoverageGaps：dangling_ref（悬空引用 → warning）', () => {
  it('引用不存在的卡 → 一条 warning（ref + sceneIds + message 含卡 id）', () => {
    const graph = parseGraph({ nodes: [node('s1', ['ghost'])] });
    const gaps = findSettingCoverageGaps(graph, [card('hero')]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: 'dangling_ref', ref: 'ghost', severity: 'warning' });
    expect(gaps[0].sceneIds).toEqual(['s1']);
    expect(gaps[0].message).toContain('ghost');
    // Output contract holds: produced gaps parse through the exported schema.
    expect(settingCoverageGapSchema.safeParse(gaps[0]).success).toBe(true);
  });

  it('全部 refs 命中既有卡 → 空数组（无缺口）', () => {
    const graph = parseGraph({
      nodes: [node('s1', ['hero']), node('s2', ['hero', 'sect'])],
    });
    expect(findSettingCoverageGaps(graph, [card('hero'), card('sect')])).toEqual([]);
  });

  it('部分命中 → 只报悬空项（命中的 ref 不产生条目）', () => {
    const graph = parseGraph({ nodes: [node('s1', ['hero', 'ghost'])] });
    const gaps = findSettingCoverageGaps(graph, [card('hero')]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].ref).toBe('ghost');
  });

  it('空 assetCards → 所有引用悬空（机械真相：无卡可解析）', () => {
    const graph = parseGraph({ nodes: [node('s1', ['a']), node('s2', ['b'])] });
    const gaps = findSettingCoverageGaps(graph, []);
    expect(gaps.map((g) => g.ref).sort()).toEqual(['a', 'b']);
    expect(gaps.every((g) => g.kind === 'dangling_ref' && g.severity === 'warning')).toBe(true);
  });

  it('assetCards undefined → 归一为空数组，同空数组行为', () => {
    const graph = parseGraph({ nodes: [node('s1', ['a'])] });
    expect(findSettingCoverageGaps(graph, undefined)).toHaveLength(1);
  });
});

// ── scene_no_refs（零引用场 → info）──

describe('findSettingCoverageGaps：scene_no_refs（零引用场 → info）', () => {
  it('assetRefs 缺省 → 每场一条 info（sceneIds 单场 / ref 无）', () => {
    const graph = parseGraph({ nodes: [node('s1'), node('s2')] });
    const gaps = findSettingCoverageGaps(graph, [card('hero')]);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ kind: 'scene_no_refs', severity: 'info', sceneIds: ['s1'] });
    expect(gaps[0].ref).toBeUndefined();
    expect(gaps[1].sceneIds).toEqual(['s2']);
  });

  it('assetRefs 空数组 → 同缺省报 info（缺省或空同态）', () => {
    const graph = parseGraph({ nodes: [node('s1', [])] });
    const gaps = findSettingCoverageGaps(graph, [card('hero')]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('scene_no_refs');
  });
});

// ── graceful（空图 / undefined）──

describe('findSettingCoverageGaps：graceful（空图 / undefined）', () => {
  it('空 scene_graph（无 nodes）→ 空数组', () => {
    expect(findSettingCoverageGaps(parseGraph({}), [card('hero')])).toEqual([]);
  });

  it('sceneGraph undefined → 空数组（无场可查）', () => {
    expect(findSettingCoverageGaps(undefined, [card('hero')])).toEqual([]);
  });
});

// ── 重复 ref 幂等（报告形态 = 按悬空卡聚合，非每场一条）──
//
// Report shape rationale: the consumer is the leader injection segment listing
// top-N gaps — N per-scene entries for one missing card would flood the top-N and
// crowd out other distinct gaps; the fix is card-centric (create the card once via
// asset_cards_update). sceneIds keeps the full fact (chapter-scene gate filter
// still works), so aggregation loses no information vs per-scene reporting.

describe('findSettingCoverageGaps：重复 ref 幂等（按悬空卡聚合）', () => {
  it('同一场内重复引用同一悬空 ref → 场内去重单条', () => {
    const graph = parseGraph({ nodes: [node('s1', ['ghost', 'ghost'])] });
    const gaps = findSettingCoverageGaps(graph, [card('hero')]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].sceneIds).toEqual(['s1']);
  });

  it('多场引用同一悬空 ref → 聚合一条（sceneIds 收全部场，按 graph 原序）', () => {
    const graph = parseGraph({
      nodes: [node('s1', ['ghost']), node('s2', ['ghost']), node('s3', ['ghost'])],
    });
    const gaps = findSettingCoverageGaps(graph, []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('dangling_ref');
    expect(gaps[0].sceneIds).toEqual(['s1', 's2', 's3']);
  });

  it('超展示上限的场引用同一卡 → message 折叠「等 N 场」，sceneIds 数据保全', () => {
    const graph = parseGraph({
      nodes: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id) => node(id, ['ghost'])),
    });
    const gaps = findSettingCoverageGaps(graph, []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].sceneIds).toHaveLength(7);
    expect(gaps[0].message).toContain('等 7 场');
  });
});

// ── 输出顺序与 schema 契约 ──

describe('findSettingCoverageGaps：输出顺序与 schema 契约', () => {
  it('顺序确定：dangling_ref（warning）在前按首现场序、scene_no_refs（info）在后按 graph 原序', () => {
    const graph = parseGraph({
      nodes: [node('s1', ['ghost1']), node('s2'), node('s3', ['ghost2']), node('s4')],
    });
    const gaps = findSettingCoverageGaps(graph, []);
    expect(gaps.map((g) => g.ref ?? g.sceneIds[0])).toEqual(['ghost1', 'ghost2', 's2', 's4']);
    expect(gaps.map((g) => g.severity)).toEqual(['warning', 'warning', 'info', 'info']);
  });

  it('混合形态产出全部通过 settingCoverageGapSchema（输出契约自洽）', () => {
    const graph = parseGraph({ nodes: [node('s1', ['hero', 'ghost']), node('s2')] });
    const gaps = findSettingCoverageGaps(graph, [card('hero')]);
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) {
      expect(settingCoverageGapSchema.safeParse(gap).success).toBe(true);
    }
  });

  it('schema 拒绝未知 kind 与空 sceneIds（契约下界）', () => {
    expect(
      settingCoverageGapSchema.safeParse({ kind: 'nope', sceneIds: ['s1'], severity: 'info', message: 'x' }).success,
    ).toBe(false);
    expect(
      settingCoverageGapSchema.safeParse({ kind: 'scene_no_refs', sceneIds: [], severity: 'info', message: 'x' }).success,
    ).toBe(false);
  });
});

// ── dogfood R2 #21（08-26 拍板 A+B）：出场人物零卡检测纯函数 ──

describe('countCharacterCards（全库 character 卡计数）', () => {
  it('undefined / 空数组 → 0（零卡的机械事实）', () => {
    expect(countCharacterCards(undefined)).toBe(0);
    expect(countCharacterCards([])).toBe(0);
  });

  it('只计 type=character（地点/规则卡不计入）', () => {
    const character = assetCardSchema.parse({ id: 'hero', type: 'character', name: '主角' });
    const location = assetCardSchema.parse({ id: 'city', type: 'location', name: '城', location_type: '城市' });
    expect(countCharacterCards([character, location])).toBe(1);
    expect(countCharacterCards([character])).toBe(1);
  });
});

describe('findUnanchoredCharacterProgressions（集纲人物段悬空）', () => {
  it('progressions 人物无卡 → 去重保序 id 列表', () => {
    const episode = {
      id: 'ep1', index: 0, title: 't',
      character_progressions: [
        { characterId: 'hero', from: 'a', to: 'b' },
        { characterId: 'ghost', from: 'a', to: 'b' },
        { characterId: 'hero', from: 'b', to: 'c' },
      ],
    };
    expect(findUnanchoredCharacterProgressions(episode, [card('hero')])).toEqual(['ghost']);
    expect(findUnanchoredCharacterProgressions(episode, [])).toEqual(['hero', 'ghost']);
  });

  it('episode undefined / progressions 缺省 → []（没声明就没悬空——「这集有谁」是语义判断不在此）', () => {
    expect(findUnanchoredCharacterProgressions(undefined, [])).toEqual([]);
    expect(findUnanchoredCharacterProgressions({ character_progressions: [] }, [])).toEqual([]);
  });

  it('全有卡 → []（引用闭合）', () => {
    const episode = {
      character_progressions: [{ characterId: 'hero', from: 'a', to: 'b' }],
    };
    expect(findUnanchoredCharacterProgressions(episode, [card('hero')])).toEqual([]);
  });
});
