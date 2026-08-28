import { describe, expect, it } from 'vitest';
import {
  assembleChapterChainArtifacts,
  parseAdjudication,
  parseDirectorInfoRelease,
  parseDirectorEmotion,
  type ChapterChainProjectInput,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4.8 / implement.md 6.1/6.2：assembleChapterChainArtifacts 纯函数单测。
// 覆盖：scene_graph/settings_context/chapter_brief_input/promise_registry 四 artifact 组装 +
// episode_outlines optional 注入 + 缺字段降级（空图/空 registry/空 prefix）+ safeParse 防御。
// 纯函数（无 fs/db/LLM）-> plain vitest。
//
// fixture 用 `as ChapterChainProjectInput` 构造（assembler 内部 safeParse scene_graph / promise_registry
// 做真实验证；外层 cast 只过 TS）。scene_graph/promise_registry 字段写全 schema 必填项。
// ─────────────────────────────────────────────────────────────────────────────

/** 完整可解析的 scene_graph fixture（nodes/edges/lines 必填字段写全，对齐 sceneNodeSchema）。 */
const SCENE_GRAPH_FIXTURE = {
  nodes: [
    { id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor' },
    {
      id: 's2',
      storyTime: 1,
      presentationOrder: { chapter: 0, pos: 1 },
      role: 'normal',
      presentationSpans: [{ episodeId: 'ep1', pos: 0 }, { episodeId: 'ep2', pos: 0 }],
    },
  ],
  edges: [{ id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' }],
  lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }],
};

const PROMISE_REGISTRY_FIXTURE = {
  promises: [
    { id: 'p1', title: '神秘钥匙', summary: '主角捡到古老钥匙', status: 'open', category: 'setup_payoff' },
  ],
  beats: [
    { id: 'p1::s1', promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
  ],
  version: 3,
};

/** 构建一个含链段字段的 project 子集（cast 过 TS，assembler safeParse 做真实校验）。 */
function makeProject(overrides: Partial<ChapterChainProjectInput> = {}): ChapterChainProjectInput {
  return {
    creative_brief: {
      genre: '都市奇幻',
      genre_tags: ['都市', '奇幻'],
      commitments: [{ type: '情绪承诺', content: '主角成长' }],
    } as ChapterChainProjectInput['creative_brief'],
    world_setting: { premise: '灵气复苏的现代都市', era: '近未来', world_constitution: ['无重工'] } as ChapterChainProjectInput['world_setting'],
    asset_cards: [
      {
        id: 'char-1',
        type: 'character',
        name: '林动',
        tier: 'core',
        summary: '坚韧少年',
        narrative: { storyFunction: '主角', coreConflict: '家族兴衰' },
        desireAndBottomline: { coreDesire: '变强守护家族', coreFear: '失去亲人' },
        personality: { coreTraits: ['坚韧', '重情'] },
      },
    ] as ChapterChainProjectInput['asset_cards'],
    scene_graph: SCENE_GRAPH_FIXTURE as unknown as ChapterChainProjectInput['scene_graph'],
    promise_registry: PROMISE_REGISTRY_FIXTURE as unknown as ChapterChainProjectInput['promise_registry'],
    ...overrides,
  };
}

describe('assembleChapterChainArtifacts（Story 4.0 §4.8）', () => {
  // ════════════════════════════════════════════════════════════════════════════
  // 1. 四 artifact key 齐组装（scene_graph/settings_context/chapter_brief_input/promise_registry）
  // ════════════════════════════════════════════════════════════════════════════

  it('组装四 required artifact key + episode_outlines optional 注入', () => {
    const project = makeProject({
      episode_outlines: [
        { id: 'ep1', index: 0, title: '开篇' },
        { id: 'ep2', index: 1, title: 'B 城' },
      ] as unknown as ChapterChainProjectInput['episode_outlines'],
    });

    const artifacts = assembleChapterChainArtifacts(project, 'ep1', { goal: 'REACH_B_CITY', tone: '紧张' });

    // scene_graph 透传（结构正确）
    expect(artifacts['scene_graph']).toBeDefined();
    const sg = artifacts['scene_graph'] as { nodes: unknown[]; edges: unknown[]; lines: unknown[] };
    expect(sg.nodes).toHaveLength(2);
    expect(sg.edges).toHaveLength(1);

    // settings_context：2.3 compileSettingPrefix 渲染成字符串（含题材/世界前提/核心设定）
    expect(typeof artifacts['settings_context']).toBe('string');
    const settingsCtx = artifacts['settings_context'] as string;
    expect(settingsCtx).toContain('都市奇幻');
    expect(settingsCtx).toContain('灵气复苏的现代都市');
    expect(settingsCtx).toContain('林动');

    // chapter_brief_input：{episodeId, brief}
    expect(artifacts['chapter_brief_input']).toEqual({
      episodeId: 'ep1',
      brief: { goal: 'REACH_B_CITY', tone: '紧张' },
    });

    // promise_registry 透传（含 version，brief-compiler #7 + storySync 读）
    expect(artifacts['promise_registry']).toBeDefined();
    const pr = artifacts['promise_registry'] as { promises: unknown[]; beats: unknown[]; version: number };
    expect(pr.promises).toHaveLength(1);
    expect(pr.beats).toHaveLength(1);
    expect(pr.version).toBe(3);

    // episode_outlines optional 注入（brief-compiler 连续性标注用）
    expect(artifacts['episode_outlines']).toBeDefined();
    expect((artifacts['episode_outlines'] as unknown[])).toHaveLength(2);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. chapterBrief 缺省 → 空 brief（brief-compiler 仅填 #6 from scene_graph）
  // ════════════════════════════════════════════════════════════════════════════

  it('chapterBrief 缺省 → chapter_brief_input.brief = {}（不造假）', () => {
    const artifacts = assembleChapterChainArtifacts(makeProject(), 'ep1');
    expect(artifacts['chapter_brief_input']).toEqual({ episodeId: 'ep1', brief: {} });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. 缺字段降级：scene_graph 缺 → 空图 / promise_registry 缺 → 空 registry / 设定缺 → 空 settings_context
  // ════════════════════════════════════════════════════════════════════════════

  it('scene_graph 缺 → 空图 {nodes:[],edges:[],lines:[]}（schema 默认）', () => {
    const artifacts = assembleChapterChainArtifacts({}, 'ep1');
    const sg = artifacts['scene_graph'] as { nodes: unknown[]; edges: unknown[]; lines: unknown[] };
    expect(sg.nodes).toEqual([]);
    expect(sg.edges).toEqual([]);
    expect(sg.lines).toEqual([]);
  });

  it('promise_registry 缺 → {promises:[],beats:[],version:0} + schema 默认 updatedBy（storySync rules 兜底）', () => {
    const artifacts = assembleChapterChainArtifacts({}, 'ep1');
    const pr = artifacts['promise_registry'] as { promises: unknown[]; beats: unknown[]; version: number };
    expect(pr.promises).toEqual([]);
    expect(pr.beats).toEqual([]);
    expect(pr.version).toBe(0);
  });

  it('settings 全缺 → settings_context 空串（draft-writer 优雅消费空 projectContext）', () => {
    const artifacts = assembleChapterChainArtifacts({}, 'ep1');
    expect(artifacts['settings_context']).toBe('');
  });

  it('episode_outlines 缺 → 不注入该 key（brief-compiler 连续性降级，场列表仍准确）', () => {
    const artifacts = assembleChapterChainArtifacts(makeProject(), 'ep1');
    expect(artifacts['episode_outlines']).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. safeParse 防御：坏 scene_graph / promise_registry → 降级不抛
  // ════════════════════════════════════════════════════════════════════════════

  it('坏 scene_graph（结构错）→ safeParse 失败 → 空图降级（不抛）', () => {
    const artifacts = assembleChapterChainArtifacts(
      { scene_graph: { nodes: 'not-an-array' } as unknown as ChapterChainProjectInput['scene_graph'] },
      'ep1',
    );
    const sg = artifacts['scene_graph'] as { nodes: unknown[] };
    // safeParse 失败 → schema.parse({}) 默认空图
    expect(sg.nodes).toEqual([]);
  });

  it('坏 promise_registry（version 负数）→ safeParse 失败 → 空 registry 降级', () => {
    const artifacts = assembleChapterChainArtifacts(
      { promise_registry: { version: -1 } as unknown as ChapterChainProjectInput['promise_registry'] },
      'ep1',
    );
    const pr = artifacts['promise_registry'] as { promises: unknown[]; beats: unknown[]; version: number };
    expect(pr.promises).toEqual([]);
    expect(pr.beats).toEqual([]);
    expect(pr.version).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. settings_context 含 core 卡 lean 核心字段（2.3 compileSettingPrefix 集成验证）
  // ════════════════════════════════════════════════════════════════════════════

  it('settings_context 含 character core 卡的核心欲望/核心恐惧（2.3 prefix 集成）', () => {
    const artifacts = assembleChapterChainArtifacts(makeProject(), 'ep1');
    const settingsCtx = artifacts['settings_context'] as string;
    expect(settingsCtx).toContain('变强守护家族');
    expect(settingsCtx).toContain('失去亲人');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. 4.1 §3.3：settings_context 来自 compileSettingContext.stablePrefix（layout 契约）
  // ════════════════════════════════════════════════════════════════════════════

  it('4.1 §3.3：settings_context 来自 compileSettingContext.stablePrefix（prefix 标签 + 无 retrieval → 无 suffix 块）', () => {
    const artifacts = assembleChapterChainArtifacts(makeProject(), 'ep1');
    const settingsCtx = artifacts['settings_context'] as string;
    // prefix 渲染标记（compileSettingContext.stablePrefix = compileSettingPrefix 产）：
    // 设定目录 / 世界设定 / 创作 Brief 核心设定 三 label
    expect(settingsCtx).toContain('设定目录');
    expect(settingsCtx).toContain('世界设定');
    expect(settingsCtx).toContain('创作 Brief 核心设定');
    // 无 retrieval（4.5 defer）→ dynamicSuffix 空 → 不含 suffix 块标记（formatRetrievedSettings 的 `### name [type/sourceKind]` 格式）
    expect(settingsCtx).not.toMatch(/### .+\[.+\/.+\]/);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. 4.1 Step 3：story_decisions artifact 注入（brief-compiler #8 openDecisions 消费源）
  // ════════════════════════════════════════════════════════════════════════════

  it('4.1 Step 3：project 含 story_decisions → 注入 artifacts["story_decisions"]（safeParse 通过）', () => {
    const project = makeProject({
      story_decisions: [
        {
          id: 'd1',
          summary: '角色 A 突然硬气：目标成长',
          reason: '弧光转折',
          risk: '若铺垫不足会出戏',
          status: 'open',
          relatedEpisodeId: 'ep1',
          createdAt: '2026-08-01T00:00:00Z',
        },
      ] as unknown as ChapterChainProjectInput['story_decisions'],
    });

    const artifacts = assembleChapterChainArtifacts(project, 'ep1');
    expect(Array.isArray(artifacts['story_decisions'])).toBe(true);
    const decisions = artifacts['story_decisions'] as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].id).toBe('d1');
    // safeParse 应用 defaults（alternatives [] / source accept_as_truth）
    expect(decisions[0].alternatives).toEqual([]);
    expect(decisions[0].source).toBe('accept_as_truth');
  });

  it('4.1 Step 3：story_decisions 缺 → artifacts["story_decisions"]=[]（降级，mirror scene_graph/promise）', () => {
    const artifacts = assembleChapterChainArtifacts(makeProject(), 'ep1');
    expect(artifacts['story_decisions']).toEqual([]);
  });

  it('4.1 Step 3：坏 story_decisions（缺必填 risk）→ safeParse 失败 → [] 降级（不抛）', () => {
    const project = makeProject({
      story_decisions: [
        { id: 'd1', summary: '缺 risk' }, // 缺 risk（必填）
      ] as unknown as ChapterChainProjectInput['story_decisions'],
    });
    const artifacts = assembleChapterChainArtifacts(project, 'ep1');
    expect(artifacts['story_decisions']).toEqual([]);
  });

  it('CR-4.1-07：好坏混合 story_decisions → per-element filter（好条目保留，坏条目单独丢弃，非 all-or-nothing）', () => {
    // 旧 `storyDecisionSchema.array().safeParse` 是 all-or-nothing：一条坏决策（缺 risk）清空整个数组
    // → brief #8 openDecisions 全丢。CR-4.1-07 改逐条 safeParse：好条目保留，坏条目单独丢弃。
    const project = makeProject({
      story_decisions: [
        {
          id: 'd_good', summary: '好决策', reason: '弧光转折', risk: '若铺垫不足会出戏',
          status: 'open', relatedEpisodeId: 'ep1', createdAt: '2026-08-01T00:00:00Z',
        },
        { id: 'd_bad', summary: '缺 risk' }, // 缺 risk（必填）→ 坏条目，单独丢弃
      ] as unknown as ChapterChainProjectInput['story_decisions'],
    });

    const artifacts = assembleChapterChainArtifacts(project, 'ep1');
    const decisions = artifacts['story_decisions'] as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(1); // 好条目保留，坏条目单独丢弃（非旧 all-or-nothing 清空）
    expect(decisions[0].id).toBe('d_good');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 8. Story 6.3：info_release_map artifact 注入（mirror promise_registry，brief-compiler compileInfoRelease 消费源）
  // ════════════════════════════════════════════════════════════════════════════

  it('6.3：project 含 info_release_map → 注入 artifacts["info_release_map"]（safeParse 通过）', () => {
    const project = makeProject({
      info_release_map: {
        entries: [
          {
            id: 'ir1',
            sceneRef: 's1',
            episodeId: 'ep1',
            reveal: ['主角到达'],
            directive: { mode: 'reveal_first', actions: ['release'], target: '主角到达' },
          },
        ],
        version: 2,
      } as unknown as ChapterChainProjectInput['info_release_map'],
    });

    const artifacts = assembleChapterChainArtifacts(project, 'ep1');
    expect(artifacts['info_release_map']).toBeDefined();
    const map = artifacts['info_release_map'] as { entries: unknown[]; version: number };
    expect(map.entries).toHaveLength(1);
    expect(map.version).toBe(2);
  });

  it('6.3：info_release_map 缺 → {entries:[],version:0} + schema 默认 updatedBy（brief-compiler compileInfoRelease 降级）', () => {
    const artifacts = assembleChapterChainArtifacts(makeProject(), 'ep1');
    const map = artifacts['info_release_map'] as {
      entries: unknown[];
      version: number;
      updatedBy: string;
    };
    expect(map.entries).toEqual([]);
    expect(map.version).toBe(0);
    expect(map.updatedBy).toBe('agent'); // schema default
  });

  it('6.3：坏 info_release_map（entries 非数组）→ safeParse 失败 → 空 map 降级（不抛）', () => {
    const artifacts = assembleChapterChainArtifacts(
      {
        info_release_map: { entries: 'not-an-array' } as unknown as ChapterChainProjectInput['info_release_map'],
      },
      'ep1',
    );
    const map = artifacts['info_release_map'] as { entries: unknown[]; version: number };
    expect(map.entries).toEqual([]);
    expect(map.version).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 9. Story 5.2：emotion_curve artifact 注入（mirror info_release_map，brief-compiler compileEmotionTarget 消费源）
  // ════════════════════════════════════════════════════════════════════════════

  it('5.2：project 含 emotion_curve → 注入 artifacts["emotion_curve"]（safeParse 通过）', () => {
    const project = makeProject({
      emotion_curve: {
        unit: 'scene',
        points: [
          {
            refId: 's1',
            sceneMood: '压抑',
            characters: [{ characterId: 'c1', emotion: '恐惧', emotionEnd: '决心' }],
          },
        ],
        emotional_promises: ['正义'],
      } as unknown as ChapterChainProjectInput['emotion_curve'],
    });

    const artifacts = assembleChapterChainArtifacts(project, 'ep1');
    expect(artifacts['emotion_curve']).toBeDefined();
    const curve = artifacts['emotion_curve'] as { points: unknown[]; unit: string };
    expect(curve.points).toHaveLength(1);
    expect(curve.unit).toBe('scene');
  });

  it('5.2：emotion_curve 缺 → 空 curve（unit=scene fallback，brief-compiler compileEmotionTarget 降级）', () => {
    const artifacts = assembleChapterChainArtifacts(makeProject(), 'ep1');
    const curve = artifacts['emotion_curve'] as { points: unknown[]; unit: string };
    expect(curve.points).toEqual([]);
    expect(curve.unit).toBe('scene'); // assemble fallback 显式给 unit:'scene'（schema.unit 无 default，D-5.1-1）
  });

  it('5.2：坏 emotion_curve（points 非数组）→ safeParse 失败 → 空 curve 降级（不抛）', () => {
    const artifacts = assembleChapterChainArtifacts(
      {
        emotion_curve: { points: 'not-an-array' } as unknown as ChapterChainProjectInput['emotion_curve'],
      },
      'ep1',
    );
    const curve = artifacts['emotion_curve'] as { points: unknown[] };
    expect(curve.points).toEqual([]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 10. Story 2.5：genreContract artifact 注入（mirror promise_registry，review 节点 contract 维数据源）
  // ════════════════════════════════════════════════════════════════════════════

  it('2.5：project 含 creative_brief + world_setting → 注入 artifacts["genreContract"]（三字段齐）', () => {
    // makeProject fixture 已含 genre_tags / commitments / world_constitution（2.4 字段）
    const artifacts = assembleChapterChainArtifacts(makeProject(), 'ep1');
    expect(artifacts['genreContract']).toBeDefined();
    const gc = artifacts['genreContract'] as {
      commitments: Array<{ type: string; content: string }>;
      genre_tags: string[];
      world_constitution: string[];
    };
    // fixture: creative_brief.genre_tags = ['都市','奇幻']
    expect(gc.genre_tags).toEqual(['都市', '奇幻']);
    // fixture: creative_brief.commitments = [{type:'情绪承诺', content:'主角成长'}]
    expect(gc.commitments).toEqual([{ type: '情绪承诺', content: '主角成长' }]);
    // fixture: world_setting.world_constitution = ['无重工']
    expect(gc.world_constitution).toEqual(['无重工']);
  });

  it('2.5：creative_brief / world_setting 全缺 → genreContract 三字段空 []（graceful，review 跳过 contract 维不报）', () => {
    const artifacts = assembleChapterChainArtifacts({}, 'ep1');
    expect(artifacts['genreContract']).toBeDefined();
    const gc = artifacts['genreContract'] as {
      commitments: unknown[];
      genre_tags: unknown[];
      world_constitution: unknown[];
    };
    expect(gc.commitments).toEqual([]);
    expect(gc.genre_tags).toEqual([]);
    expect(gc.world_constitution).toEqual([]);
  });

  it('2.5：creative_brief 有但 commitments / genre_tags 缺 → Array.isArray 检查返 []（graceful）', () => {
    // direct 防御性抽取：字段缺/undefined → Array.isArray=false → []（非 schema default，mirror compileSettingPrefix 直读）
    const artifacts = assembleChapterChainArtifacts(
      {
        creative_brief: { genre: '仙侠' } as ChapterChainProjectInput['creative_brief'],
        world_setting: { premise: '修真界' } as ChapterChainProjectInput['world_setting'],
      },
      'ep1',
    );
    const gc = artifacts['genreContract'] as {
      commitments: unknown[];
      genre_tags: unknown[];
      world_constitution: unknown[];
    };
    expect(gc.commitments).toEqual([]);
    expect(gc.genre_tags).toEqual([]);
    expect(gc.world_constitution).toEqual([]);
  });

  it('2.5：commitments 含坏条目（缺 content）→ per-element safeParse filter（好条目保留，坏条目丢弃）', () => {
    // mirror story_decisions CR-4.1-07：坏条目单独丢弃不全丢
    const project = makeProject({
      creative_brief: {
        genre: '仙侠',
        commitments: [
          { type: 'HE', content: '大团圆结局' }, // 好条目
          { type: '缺 content' }, // 坏条目（缺 content）→ 丢弃
          'not-an-object', // 坏条目（非对象）→ 丢弃
        ],
        genre_tags: ['', '仙侠', 123 as unknown], // 空串 + 非字符串 丢弃，'仙侠' 保留
      } as ChapterChainProjectInput['creative_brief'],
    });

    const artifacts = assembleChapterChainArtifacts(project, 'ep1');
    const gc = artifacts['genreContract'] as {
      commitments: Array<{ type: string; content: string }>;
      genre_tags: string[];
    };
    expect(gc.commitments).toEqual([{ type: 'HE', content: '大团圆结局' }]);
    expect(gc.genre_tags).toEqual(['仙侠']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.6：parseAdjudication（裁决器建议解析，三路径鲁棒 robust extraction，对象形态）。
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdjudication（Story 4.6 裁决器建议解析）', () => {
  const GOOD = {
    analysis: '正文此处硬气是第 N 章压抑后的爆发，属角色弧推进；但与既定性格有张力',
    recommendation: 'accept',
    recommendationReason: '倾向接受为真相，后续校正',
    options: [
      { label: '改稿', reason: '硬气破坏既定角色弧一致性' },
      { label: '接受为真相', reason: '角色弧推进，计划追正文' },
    ],
  };

  it('纯 JSON 对象 → 解析（路径 3 整体 parse）', () => {
    expect(parseAdjudication(JSON.stringify(GOOD))).toEqual(GOOD);
  });

  it('fenced ```json 块 → 解析（路径 1）', () => {
    expect(parseAdjudication('```json\n' + JSON.stringify(GOOD) + '\n```')).toEqual(GOOD);
  });

  it('fenced ``` 块（无 json 标签）→ 解析（路径 1）', () => {
    expect(parseAdjudication('```\n' + JSON.stringify(GOOD) + '\n```')).toEqual(GOOD);
  });

  it('narration 包裹（含多余文字）+ brace-match → 解析（路径 2）', () => {
    expect(parseAdjudication('裁决结果：' + JSON.stringify(GOOD) + ' 以上。')).toEqual(GOOD);
  });

  it('recommendation=revise → 解析', () => {
    const r = parseAdjudication(JSON.stringify({ ...GOOD, recommendation: 'revise' }));
    expect(r?.recommendation).toBe('revise');
  });

  it('CR-Edge-5：recommendation 大小写/空白 → trim+toLowerCase 归一（"Accept"/"accept "/"REVISE"）', () => {
    expect(parseAdjudication(JSON.stringify({ ...GOOD, recommendation: 'Accept' }))?.recommendation).toBe('accept');
    expect(parseAdjudication(JSON.stringify({ ...GOOD, recommendation: 'accept ' }))?.recommendation).toBe('accept');
    expect(parseAdjudication(JSON.stringify({ ...GOOD, recommendation: 'REVISE' }))?.recommendation).toBe('revise');
    expect(parseAdjudication(JSON.stringify({ ...GOOD, recommendation: '  revise  ' }))?.recommendation).toBe('revise');
  });

  it('recommendationReason 缺省 → 仍解析（空串合法，非硬要求）', () => {
    const { recommendationReason: _omit, ...rest } = GOOD;
    void _omit;
    const r = parseAdjudication(JSON.stringify(rest));
    expect(r?.recommendationReason).toBe('');
  });

  it('缺 analysis → null（硬要求）', () => {
    expect(parseAdjudication(JSON.stringify({
      recommendation: 'accept', recommendationReason: 'r', options: GOOD.options,
    }))).toBeNull();
  });

  it('recommendation 非法值（"maybe"）→ null', () => {
    expect(parseAdjudication(JSON.stringify({ ...GOOD, recommendation: 'maybe' }))).toBeNull();
  });

  it('options 不足 2 → null（硬要求：呈用户两选项）', () => {
    expect(parseAdjudication(JSON.stringify({ ...GOOD, options: [GOOD.options[0]] }))).toBeNull();
  });

  it('option 缺 reason → 该 option 跳过；不足 2 → null', () => {
    expect(parseAdjudication(JSON.stringify({ ...GOOD, options: [{ label: '改稿' }, GOOD.options[1]] }))).toBeNull();
  });

  it('空字符串 / 非 JSON → null（graceful 降级 D5）', () => {
    expect(parseAdjudication('')).toBeNull();
    expect(parseAdjudication('   ')).toBeNull();
    expect(parseAdjudication('这不是 JSON')).toBeNull();
    expect(parseAdjudication('{"analysis":"Incomplete')).toBeNull();
  });

  it('options 上限 2（多给截断）', () => {
    const r = parseAdjudication(JSON.stringify({
      ...GOOD,
      options: [...GOOD.options, { label: '第三', reason: '多余' }],
    }));
    expect(r?.options.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.3：parseDirectorInfoRelease（Director 子 agent per-scene ManipulationDirective 解析，
// 三路径鲁棒 robust extraction，{entries:[...]} 形态）。
// 验：fenced/前后文字剥离 + {entries:[...]} / 裸数组双形态 + 逐条 safeParse 坏条目丢弃 + 全失败 graceful 空。
// ─────────────────────────────────────────────────────────────────────────────
describe('parseDirectorInfoRelease（Story 6.3 Director info-release 解析）', () => {
  const GOOD_ENTRY = {
    sceneRef: 's1',
    directive: {
      mode: 'sustain_unknown',
      actions: ['withhold', 'plant'],
      forbiddenMoves: ['主角提到那封密信'],
      target: '密信内容',
    },
  };

  it('裸 {entries:[...]} JSON → 解析出 typed entries', () => {
    const r = parseDirectorInfoRelease(JSON.stringify({ entries: [GOOD_ENTRY] }));
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual(GOOD_ENTRY);
  });

  it('```json 围栏 + 前导文字 → 剥离后解析（路径 1）', () => {
    const content = `逐场执导结果：\n\`\`\`json\n${JSON.stringify({ entries: [GOOD_ENTRY] })}\n\`\`\`\n完毕`;
    const r = parseDirectorInfoRelease(content);
    expect(r).toHaveLength(1);
    expect(r[0].sceneRef).toBe('s1');
    expect(r[0].directive.mode).toBe('sustain_unknown');
  });

  it('fenced ``` 块（无 json 标签）→ 解析（路径 1）', () => {
    const r = parseDirectorInfoRelease('```\n' + JSON.stringify({ entries: [GOOD_ENTRY] }) + '\n```');
    expect(r).toHaveLength(1);
  });

  it('narration 包裹（含多余文字）+ brace-match → 解析（路径 2）', () => {
    const r = parseDirectorInfoRelease('执导：' + JSON.stringify({ entries: [GOOD_ENTRY] }) + ' 以上。');
    expect(r).toHaveLength(1);
    expect(r[0].directive.actions).toEqual(['withhold', 'plant']);
  });

  it('裸数组形态 [...] → 宽容解析（Director 直接返数组，路径 3）', () => {
    const r = parseDirectorInfoRelease(JSON.stringify([GOOD_ENTRY]));
    expect(r).toHaveLength(1);
  });

  it('多 entry（逐场）→ 全解析', () => {
    const entries = [
      GOOD_ENTRY,
      { sceneRef: 's2', directive: { mode: 'reveal_first', actions: ['release'], target: '主角到达' } },
    ];
    const r = parseDirectorInfoRelease(JSON.stringify({ entries }));
    expect(r).toHaveLength(2);
    expect(r[1].sceneRef).toBe('s2');
    expect(r[1].directive.mode).toBe('reveal_first');
  });

  it('逐条 safeParse：坏条目（directive 缺 mode）丢弃，好条目保留（CR-4.1-07 同哲学）', () => {
    const badEntry = { sceneRef: 's2', directive: { actions: ['plant'] } }; // 缺 mode
    const r = parseDirectorInfoRelease(JSON.stringify({ entries: [GOOD_ENTRY, badEntry] }));
    expect(r).toHaveLength(1);
    expect(r[0].sceneRef).toBe('s1');
  });

  it('逐条 safeParse：缺 sceneRef 丢弃', () => {
    const badEntry = { directive: { mode: 'reveal_first', actions: ['release'] } }; // 缺 sceneRef
    const r = parseDirectorInfoRelease(JSON.stringify({ entries: [GOOD_ENTRY, badEntry] }));
    expect(r).toHaveLength(1);
  });

  it('directive 缺 actions（空数组）→ safeParse 拒（.min(1) 契约）', () => {
    const badEntry = { sceneRef: 's2', directive: { mode: 'reveal_first', actions: [] } };
    const r = parseDirectorInfoRelease(JSON.stringify({ entries: [badEntry] }));
    expect(r).toEqual([]);
  });

  it('forbiddenMoves/target 缺省 → 仍解析（optional）', () => {
    const entry = { sceneRef: 's1', directive: { mode: 'method_foreseen', actions: ['plant'] } };
    const r = parseDirectorInfoRelease(JSON.stringify({ entries: [entry] }));
    expect(r).toHaveLength(1);
    expect(r[0].directive.forbiddenMoves).toBeUndefined();
    expect(r[0].directive.target).toBeUndefined();
  });

  it('空 entries 数组 → 返空（Director 跑了但无操控）', () => {
    expect(parseDirectorInfoRelease(JSON.stringify({ entries: [] }))).toEqual([]);
  });

  it('非 JSON / 纯文字 → graceful 空（不抛）', () => {
    expect(parseDirectorInfoRelease('这不是 JSON')).toEqual([]);
  });

  it('空串 → 空', () => {
    expect(parseDirectorInfoRelease('')).toEqual([]);
    expect(parseDirectorInfoRelease('   ')).toEqual([]);
  });

  it('JSON.parse 失败（截断对象）→ graceful 空', () => {
    expect(parseDirectorInfoRelease('{"entries":[{Incomplete')).toEqual([]);
  });

  it('对象但无 entries 字段 → 空', () => {
    expect(parseDirectorInfoRelease(JSON.stringify({ foo: 'bar' }))).toEqual([]);
  });

  it('非法 mode（"foo"）→ safeParse 拒 → 空', () => {
    const badEntry = { sceneRef: 's1', directive: { mode: 'foo', actions: ['plant'] } };
    expect(parseDirectorInfoRelease(JSON.stringify({ entries: [badEntry] }))).toEqual([]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // P2：robust JSON extraction——multi-fence
  // ════════════════════════════════════════════════════════════════════════════

  it('P2 multi-fence：推理 ```text fence + 结果 ```json fence → 取 json fence 的 entries', () => {
    // Director 先输出推理 fenced 块（非 JSON），再输出 entries fenced 块。
    const content = [
      '我来分析本场信息差。',
      '',
      '```text',
      's1 场：主角尚未知道密信',
      '```',
      '',
      '```json',
      JSON.stringify({ entries: [GOOD_ENTRY] }),
      '```',
    ].join('\n');
    const r = parseDirectorInfoRelease(content);
    expect(r).toHaveLength(1);
    expect(r[0].sceneRef).toBe('s1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 5.2：parseDirectorEmotion（Director 子 agent emotion 段解析，
// mirror parseDirectorInfoRelease 三路径鲁棒，{emotionPoints:[...], emotionTarget:{...}} 形态）。
// 验：fenced/前后文字剥离 + {emotionPoints}/裸数组双形态 + 逐条 safeParse 坏条目丢弃 + emotionTarget 章级抽取
// + 与 InfoRelease entries 同对象共存互不干扰 + 全失败 graceful 空。
// ─────────────────────────────────────────────────────────────────────────────
describe('parseDirectorEmotion（Story 5.2 Director emotion 解析）', () => {
  const GOOD_POINT = {
    refId: 's1',
    sceneMood: '压抑',
    characters: [{ characterId: 'c1', emotion: '恐惧', emotionEnd: '决心', vad: { v: -0.7, a: 0.8, d: -0.3 } }],
  };
  const GOOD_TARGET = { emotion: '恐惧', emotionEnd: '决心', steer: '先压抑后爆发' };

  it('裸 {emotionPoints:[...]} JSON → 解析出 typed points', () => {
    const r = parseDirectorEmotion(JSON.stringify({ emotionPoints: [GOOD_POINT] }));
    expect(r.emotionPoints).toHaveLength(1);
    expect(r.emotionPoints[0]).toEqual(GOOD_POINT);
    expect(r.emotionTarget).toBeUndefined();
  });

  it('emotionTarget 章级目标抽取（Director 独立产非 rollup）', () => {
    const r = parseDirectorEmotion(JSON.stringify({ emotionPoints: [GOOD_POINT], emotionTarget: GOOD_TARGET }));
    expect(r.emotionPoints).toHaveLength(1);
    expect(r.emotionTarget).toEqual(GOOD_TARGET);
  });

  it('```json 围栏 + 前导文字 → 剥离后解析（路径 1）', () => {
    const content = `逐场情绪执导：\n\`\`\`json\n${JSON.stringify({ emotionPoints: [GOOD_POINT] })}\n\`\`\`\n完毕`;
    const r = parseDirectorEmotion(content);
    expect(r.emotionPoints).toHaveLength(1);
    expect(r.emotionPoints[0].refId).toBe('s1');
  });

  it('narration 包裹 + brace-match → 解析（路径 2）', () => {
    const r = parseDirectorEmotion('情绪：' + JSON.stringify({ emotionPoints: [GOOD_POINT] }) + ' 以上。');
    expect(r.emotionPoints).toHaveLength(1);
    expect(r.emotionPoints[0].characters[0].emotion).toBe('恐惧');
  });

  it('裸数组形态 [...] → 宽容解析（Director 直接返 points 数组，路径 3）', () => {
    const r = parseDirectorEmotion(JSON.stringify([GOOD_POINT]));
    expect(r.emotionPoints).toHaveLength(1);
  });

  it('逐条 safeParse：坏 point（缺 refId）丢弃，好 point 保留（CR-4.1-07 同哲学）', () => {
    const badPoint = { sceneMood: '压抑', characters: [{ characterId: 'c1', emotion: '恐惧' }] }; // 缺 refId
    const r = parseDirectorEmotion(JSON.stringify({ emotionPoints: [GOOD_POINT, badPoint] }));
    expect(r.emotionPoints).toHaveLength(1);
    expect(r.emotionPoints[0].refId).toBe('s1');
  });

  it('emotionTarget 坏（非对象）/ 缺 → undefined，不阻断 points', () => {
    const r = parseDirectorEmotion(JSON.stringify({ emotionPoints: [GOOD_POINT], emotionTarget: '坏字符串' }));
    expect(r.emotionPoints).toHaveLength(1);
    expect(r.emotionTarget).toBeUndefined();
  });

  it('与 InfoRelease entries 同对象共存：parseDirectorEmotion 只抽 emotion 段，不读 entries', () => {
    // Director 单次 dispatch 产 entries + emotionPoints + emotionTarget 同一 JSON 对象。
    const content = JSON.stringify({
      entries: [{ sceneRef: 's1', directive: { mode: 'reveal_first', actions: ['release'], target: 'x' } }],
      emotionPoints: [GOOD_POINT],
      emotionTarget: GOOD_TARGET,
    });
    const r = parseDirectorEmotion(content);
    expect(r.emotionPoints).toHaveLength(1);
    expect(r.emotionTarget).toEqual(GOOD_TARGET);
    // 反向：parseDirectorInfoRelease 同 content 只抽 entries（互不干扰，additive）
    const e = parseDirectorInfoRelease(content);
    expect(e).toHaveLength(1);
    expect(e[0].sceneRef).toBe('s1');
  });

  it('空 emotionPoints 数组 + 无 emotionTarget → 返空（Director 跑了但无情绪目标）', () => {
    expect(parseDirectorEmotion(JSON.stringify({ emotionPoints: [] }))).toEqual({ emotionPoints: [] });
  });

  it('非 JSON / 纯文字 → graceful 空（不抛）', () => {
    expect(parseDirectorEmotion('这不是 JSON')).toEqual({ emotionPoints: [] });
  });

  it('空串 → 空', () => {
    expect(parseDirectorEmotion('')).toEqual({ emotionPoints: [] });
    expect(parseDirectorEmotion('   ')).toEqual({ emotionPoints: [] });
  });

  it('对象但无 emotionPoints 字段（且无 emotionTarget）→ 空', () => {
    expect(parseDirectorEmotion(JSON.stringify({ foo: 'bar' }))).toEqual({ emotionPoints: [] });
  });

  it('JSON.parse 失败（截断对象）→ graceful 空', () => {
    expect(parseDirectorEmotion('{"emotionPoints":[{Incomplete')).toEqual({ emotionPoints: [] });
  });

  it('P2 multi-fence：推理 ```text fence + 结果 ```json fence → 取 json fence 的 emotion 段', () => {
    const content = [
      '我来设计本场情绪弧。',
      '',
      '```text',
      's1 场：主角从恐惧转决心',
      '```',
      '',
      '```json',
      JSON.stringify({ emotionPoints: [GOOD_POINT], emotionTarget: GOOD_TARGET }),
      '```',
    ].join('\n');
    const r = parseDirectorEmotion(content);
    expect(r.emotionPoints).toHaveLength(1);
    expect(r.emotionPoints[0].refId).toBe('s1');
    expect(r.emotionTarget?.steer).toBe('先压抑后爆发');
  });

  // BMad CR Blind-1 fix：emotionTarget 提取独立于 emotionPoints key（Director 可能只返章级目标无 per-scene points）。
  it('emotionPoints key 缺（仅 emotionTarget）→ emotionTarget 仍提取（BLIND-1 fix）', () => {
    const r = parseDirectorEmotion(JSON.stringify({ entries: [], emotionTarget: { emotion: '恐惧', steer: '压抑' } }));
    expect(r.emotionPoints).toEqual([]);
    expect(r.emotionTarget).toEqual({ emotion: '恐惧', steer: '压抑' });
  });

  it('emotionPoints 非数组（null）但 emotionTarget 在 → emotionTarget 提取（BLIND-1 fix）', () => {
    const r = parseDirectorEmotion(JSON.stringify({ emotionPoints: null, emotionTarget: { emotion: '决心' } }));
    expect(r.emotionPoints).toEqual([]);
    expect(r.emotionTarget?.emotion).toBe('决心');
  });
});
