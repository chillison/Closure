import { describe, expect, it } from 'vitest';
import {
  assembleChapterStateSummary,
  buildCognitionSnapshot,
  buildPresenceSignal,
  collectAsOfInvariantViolations,
  collectChapterWindowViolations,
  getCognitionAtTime,
  sceneNodeSchema,
  type ChapterSubjectActivityInput,
  type SceneNode,
  type WorldPatch,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4 C1/C2（design §3.1/§3.2）：as-of 投影审计（shared 半边）+ 同切点
// 不变量对拍（纯函数面）。
//
// 职责切分（六路径审计的落点，design §3.1 表）：
// - 本文件：cognition/presence 投影的纯函数截断语义（storyTime ≤ at、倒叙 fold、
//   presence per-patch at）+ 不变量 INV-1/2/3/5 的纯函数对拍。
// - shell `test/worldStateAsOfAudit.test.ts`：state 投影 / cognition / presence 的
//   真 db（listWorldPatches(at) SQL + flashback 插入序）+ 章摘要 as-of-N 真链。
// - agent `test/brief-as-of-audit.test.ts`：info-release compileInfoRelease 的
//   episode 过滤（INV-4）+ brief #6 stateAtT 批量 ats 主路径映射。
//
// ⚠️ as-of 截断的调用方契约：buildCognitionSnapshot 不自带 at——截断在调用方
// （shell listWorldPatches(at) 的 `s.story_time <= at`，真 SQL 在 shell 审计文件钉死）。
// 本文件用 `asOf(patches, T)`（storyTime ≤ T 过滤）mirror 该契约作纯函数面审计。
//
// 🔑 Step 9（design §3.4 断言①「不复制粘贴断言逻辑」）：INV-1/2/3/5 的对拍器已提升为
// shared 纯函数 `collectAsOfInvariantViolations` / `collectChapterWindowViolations`
// （src/contracts/as-of-invariants.ts）——400 章压测（shell worldStateScale.test.ts B6）
// 与本测试共用同一实现；本文件保留 INVARIANT_LIST（清单权威登记处）+ teeth fixture。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 同切点不变量清单（design §3.2，「后续加不变量 = 加测试」的权威清单源）。
 *
 * 每条不变量的对拍测试按 verifiedIn 落位；新增不变量时在此登记一行 + 在对应
 * 包补测试（INV id 进测试标题），保证清单与测试不漂移。
 */
export const INVARIANT_LIST = [
  {
    id: 'INV-1',
    statement: 'cognition characters ⊆ world subjects（认知账角色必在世界账主体中）',
    verifiedIn: 'shared as-of-invariants（纯函数面）+ shell worldStateAsOfAudit（真 db 面）',
  },
  {
    id: 'INV-2',
    statement: 'cognition 某角色 fact 的 evidence scene storyTime ≤ T（认知证据场不在切点的故事未来）',
    verifiedIn: 'shared as-of-invariants（scene_graph × cognitive patch 对拍）',
  },
  {
    id: 'INV-3',
    statement: 'presence 信号的 presence scene 在世界账该角色 presence 状态内（= reduce 出的 presence_scene）',
    verifiedIn: 'shared as-of-invariants（buildPresenceSignal × reduceSubject 对拍）+ shell worldStateAsOfAudit',
  },
  {
    id: 'INV-4',
    statement:
      'info-release 非本章 entries 零泄漏（episodeId/sceneRef 双锚任一命中本章才进；sceneRef 路径命中的 entry 其 sceneRef ⊆ 本章场集）',
    verifiedIn: 'agent brief-as-of-audit（compileInfoRelease × collectChapterSceneIds 对拍）',
  },
  {
    id: 'INV-5',
    statement:
      '章摘要 touched subjects ⊆ 该章窗内背书（②关系变化须窗内 patch、④新实体 firstSeen 须窗内——常规提取路径登记伴随 patch，故两者 ⊆ 窗内 patch 涉及主体）',
    verifiedIn: 'shared as-of-invariants（assembleChapterStateSummary 对拍）+ shell worldStateAsOfAudit（materialize 真链）',
  },
] as const;

// ── fixture helpers ──

/** mirror 调用方截断契约（listWorldPatches(at)：仅保留 storyTime <= at）。 */
function asOf(patches: readonly WorldPatch[], at: number | undefined): WorldPatch[] {
  return at === undefined ? [...patches] : patches.filter((p) => p.storyTime <= at);
}

let patchSeq = 0;

/** 构造 patch（id 自增保唯一；axis/op/source 可覆写）。 */
function patch(
  subjectId: string,
  storyTime: number,
  path: string,
  value: unknown,
  opts: { axis?: WorldPatch['axis']; op?: WorldPatch['op']; evidenceSceneId?: string } = {},
): WorldPatch {
  patchSeq += 1;
  return {
    id: `p${patchSeq}`,
    sliceId: `sl:${storyTime}`,
    subjectId,
    path,
    op: opts.op ?? 'replace',
    value,
    axis: opts.axis ?? 'physical',
    source: 'derived',
    storyTime,
    ...(opts.evidenceSceneId !== undefined ? { evidenceSceneId: opts.evidenceSceneId } : {}),
  };
}

function scene(id: string, storyTime: number): SceneNode {
  return sceneNodeSchema.parse({ id, storyTime, presentationOrder: { chapter: 0, pos: 0 } });
}

// ── C1 路径 2/3（shared 半边）：cognition / presence 投影截断语义 ──

describe('as-of 审计：cognition 投影（buildCognitionSnapshot × 调用方 at 过滤）', () => {
  const A = 'char-a';

  it('未来 storyTime 的认知不进切点快照（at 过滤 + 投影不含未来 fact）', () => {
    const patches = [
      patch(A, 100, '/knows/秘密X', true, { axis: 'cognitive' }),
      patch(A, 300, '/knows/秘密Z', true, { axis: 'cognitive' }), // 故事未来（> T=150）
    ];
    const snapshot = buildCognitionSnapshot(asOf(patches, 150));
    expect(snapshot).toBeDefined();
    const a = snapshot?.characters.find((c) => c.characterSubjectId === A);
    expect(a?.facts.map((f) => f.path)).toEqual(['/knows/秘密X']);
  });

  it('倒叙 fixture（数组序=插入序在后，storyTime 更早）必含且 fold 按 storyTime 非插入序', () => {
    // 插入序：先写 storyTime 300（后段），再补 storyTime 100 的倒叙/前史——fold 必须
    // 按 storyTime 排序叠加（applyPatches 规范化排序），插入序不参与语义。
    const patches = [
      patch(A, 300, '/believes/国王', '最终怀疑', { axis: 'cognitive' }),
      patch(A, 100, '/believes/国王', '最初忠诚', { axis: 'cognitive' }),
      patch(A, 200, '/believes/国王', '中期动摇', { axis: 'cognitive' }),
    ];
    // 切点 150：只有倒叙补入的 t=100 patch 进——「后注入但 storyTime 更早」必含（fold 正确）。
    const snapshot = buildCognitionSnapshot(asOf(patches, 150));
    const a = snapshot?.characters.find((c) => c.characterSubjectId === A);
    expect(a?.facts.map((f) => [f.path, f.value])).toEqual([
      ['/believes/国王', '最初忠诚'],
    ]);

    // 全史 fold：同 path 多值按 storyTime 序终值 = 最大 storyTime 的值（非数组末位）。
    const latest = getCognitionAtTime(patches, A, 250);
    expect((latest as { believes?: { 国王?: string } }).believes?.国王).toBe('中期动摇');
    expect((getCognitionAtTime(patches, A) as { believes?: { 国王?: string } }).believes?.国王).toBe(
      '最终怀疑',
    );
  });
});

describe('as-of 审计：presence 投影（buildPresenceSignal per-patch at 截断）', () => {
  it('在场 reduce 截断在认知发生时刻（c.storyTime）——之后改的 presence 不回灌', () => {
    const A = 'char-a';
    const patches = [
      patch(A, 50, '/presence_scene', 's_market'),
      patch(A, 100, '/knows/密信', true, { axis: 'cognitive', evidenceSceneId: 's_reveal' }),
      patch(A, 200, '/presence_scene', 's_palace'), // 认知发生后才挪场——不得进 @100 的 reduce
    ];
    const signals = buildPresenceSignal(patches);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      characterSubjectId: A,
      evidenceSceneId: 's_reveal',
      storyTime: 100,
      presenceSceneId: 's_market', // 未来 s_palace 被截断
    });
  });

  it('presence 恰为揭露场 → 无信号（≠ 才产信号）', () => {
    const G = 'char-guard';
    const patches = [
      patch(G, 50, '/presence_scene', 's_gate'),
      patch(G, 100, '/knows/口令', true, { axis: 'cognitive', evidenceSceneId: 's_gate' }),
    ];
    expect(buildPresenceSignal(patches)).toEqual([]);
  });
});

// ── C2：同切点五源合成 fixture + 不变量对拍（INV-1/2/3/5 纯函数面）──
//
// 切点 T=100。世界账 subjects = {A, B, guild}；场 storyTime：s_origin=10 / s_flash=40 /
// s_market=50 / s_reveal=90 / s_palace=150 / s_future=200。patches 插入序故意与
// storyTime 序错开（倒叙形态），证 fold 不依赖插入序。

const T = 100;
const A = 'char-a';
const B = 'char-b';

/** 五源 fixture（patches / 场 storyTime 表 / 世界账 subjects）。 */
function makeCutpointFixture() {
  const sceneById = new Map<string, SceneNode>([
    ['s_origin', scene('s_origin', 10)],
    ['s_flash', scene('s_flash', 40)],
    ['s_market', scene('s_market', 50)],
    ['s_reveal', scene('s_reveal', 90)],
    ['s_palace', scene('s_palace', 150)],
    ['s_future', scene('s_future', 200)],
  ]);
  const worldSubjects = new Set(['char-a', 'char-b', 'guild']);
  // 插入序（数组序）与 storyTime 序错开：倒叙场 s_flash 的 patch 排在后面。
  const patches: WorldPatch[] = [
    patch(A, 10, '/presence_scene', 's_origin'),
    patch(A, 50, '/presence_scene', 's_market'),
    patch(A, 100, '/knows/密信', true, { axis: 'cognitive', evidenceSceneId: 's_reveal' }),
    patch(A, 40, '/title', '目击者', { op: 'replace' }), // 倒叙补入（后插入、storyTime 更早）
    patch(B, 100, '/knows/传闻', true, { axis: 'cognitive', evidenceSceneId: 's_market' }),
    patch(B, 50, '/presence_scene', 's_market'),
    patch(A, 200, '/knows/未来秘密', true, { axis: 'cognitive', evidenceSceneId: 's_future' }),
    patch(A, 150, '/presence_scene', 's_palace'),
  ];
  return { sceneById, worldSubjects, patches };
}

/**
 * 不变量对拍（INV-1/2/3）——**提升后单源**：`collectAsOfInvariantViolations`（src/contracts/
 * as-of-invariants.ts，Step 9 提升）。teeth 测试用坏 fixture 证各检查非恒真。
 */
function collectInvariantViolations(
  fixture: ReturnType<typeof makeCutpointFixture>,
  at: number,
): string[] {
  return collectAsOfInvariantViolations(fixture, at);
}

describe('同切点不变量对拍（INV-1/2/3，T=100 五源 fixture）', () => {
  it('一致 fixture：三不变量全过（violations 空）', () => {
    expect(collectInvariantViolations(makeCutpointFixture(), T)).toEqual([]);
  });

  it('INV-1 teeth：认知账出现世界账未登记角色 → 违反被列出', () => {
    const fixture = makeCutpointFixture();
    fixture.patches.push(patch('char-ghost', 80, '/knows/黑幕', true, { axis: 'cognitive' }));
    const violations = collectInvariantViolations(fixture, T);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('INV-1');
    expect(violations[0]).toContain('char-ghost');
  });

  it('INV-2 teeth：cognitive patch storyTime ≤ T 但 evidence scene 在故事未来 → 违反被列出', () => {
    const fixture = makeCutpointFixture();
    // 跨账错位：fact 在 T 前已知，但挂在 storyTime=200 的揭露场。
    fixture.patches.push(
      patch(B, 90, '/knows/超前知晓', true, { axis: 'cognitive', evidenceSceneId: 's_future' }),
    );
    const violations = collectInvariantViolations(fixture, T);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('INV-2');
    expect(violations[0]).toContain('s_future');
  });

  it('INV-3 teeth：信号在场场不在登记集合（构造层不可达——由 reduce 同源性保证，本条只钉 presence 集合成员式）', () => {
    // buildPresenceSignal 的 presenceSceneId 直接来自 reduceSubject——纯函数层两路径同源，
    // 「≠ reduce」形态构造不出（这正是 INV-3 成立的机制）。此测试钉成员式判定的数据面：
    // 信号 storyTime ≤ T（切点内）且信号确实来自切点内的 cognitive patch。
    const fixture = makeCutpointFixture();
    const signals = buildPresenceSignal(asOf(fixture.patches, T));
    for (const s of signals) {
      expect(s.storyTime).toBeLessThanOrEqual(T);
      const sourced = fixture.patches.some(
        (p) =>
          p.axis === 'cognitive' &&
          p.subjectId === s.characterSubjectId &&
          p.path === s.factPath &&
          p.storyTime === s.storyTime &&
          p.evidenceSceneId === s.evidenceSceneId,
      );
      expect(sourced).toBe(true);
    }
    // fixture 中 A 的密信（揭露场 s_reveal ≠ 在场 s_market）产 1 条信号；B 在揭露场本人在场 → 无信号。
    expect(signals.map((s) => s.characterSubjectId).sort()).toEqual([A]);
  });
});

describe('同切点不变量对拍（INV-5：章摘要 touched subjects × 本章窗 patches）', () => {
  /** 本章窗 patches subjects（「窗内 patches 涉及主体」单源）。 */
  const windowPatchSubjects = (chapterPatches: readonly WorldPatch[]): Set<string> =>
    new Set(chapterPatches.map((p) => p.subjectId));

  function subjectInput(
    partial: Partial<ChapterSubjectActivityInput> & Pick<ChapterSubjectActivityInput, 'subjectId' | 'type' | 'firstSeenStoryTime'>,
  ): ChapterSubjectActivityInput {
    return { lastActiveEpisodeIndex: 1, ...partial };
  }

  it('常规提取路径（登记伴随 patch）：②④ touched subjects ⊆ 窗内 patch 主体，跨章主体零泄漏', () => {
    // 本章 ep-2（index 1，窗 [200,200]）：hero 伤 + bob 登场（带 patch）+ bob 关系变化。
    const chapterPatches: WorldPatch[] = [
      patch('hero', 200, '/hp', 70, { op: 'increment' }),
      patch('bob', 200, '/hp', 80),
      patch('bob', 200, '/关系/hero', '决裂', { axis: 'relational' }),
    ];
    const { summary } = assembleChapterStateSummary({
      episodeId: 'ep-2',
      episodeIndex: 1,
      storyTimeStart: 200,
      storyTimeEnd: 200,
      subjects: [
        subjectInput({ subjectId: 'hero', type: 'character', firstSeenStoryTime: 100 }),
        subjectInput({ subjectId: 'bob', type: 'character', firstSeenStoryTime: 200 }),
        // rival：他章主体（firstSeen 300 窗外）——④ 不得收录（跨章零泄漏）。
        subjectInput({ subjectId: 'rival', type: 'character', firstSeenStoryTime: 300 }),
      ],
      chapterPatches,
      promises: [],
      beatsBefore: [],
      beatsThrough: [],
      chapterBeats: [],
      beatsNextEpisode: [],
      nextEpisodeId: null,
    });

    const windowSubjects = windowPatchSubjects(chapterPatches);
    expect(windowSubjects).toEqual(new Set(['hero', 'bob']));

    // ② 关系变化主体 ⊆ 窗内 patch 主体（提升后单源对拍器，Step 9）。
    expect(summary.relationshipChanges.map((r) => r.subjectId)).toEqual(['bob']);
    // ④ 新实体 ⊆ 窗内 patch 主体（常规路径 firstSeen ∈ 窗 ⇔ 本章 slice 携 patch 登记）。
    expect(summary.newEntities.map((n) => n.subjectId)).toEqual(['bob']);
    expect(
      collectChapterWindowViolations(
        [...summary.relationshipChanges.map((r) => r.subjectId), ...summary.newEntities.map((n) => n.subjectId)],
        windowSubjects,
      ),
    ).toEqual([]);
  });

  it('窗内 relational patch 全量收录（② 背书方向）——非本章窗的 relational 不在输入即不产出', () => {
    // ② 的输入即本章窗 patches（caller 归窗，真链归 shell 审计钉死）；纯函数面钉：
    // 输入只含本章窗 patches 时输出 ⊆ 输入主体（无凭空主体）。
    const chapterPatches: WorldPatch[] = [
      patch('hero', 200, '/关系/bob', '同盟', { axis: 'relational' }),
    ];
    const { summary } = assembleChapterStateSummary({
      episodeId: 'ep-2',
      episodeIndex: 1,
      storyTimeStart: 200,
      storyTimeEnd: 200,
      subjects: [subjectInput({ subjectId: 'hero', type: 'character', firstSeenStoryTime: 100 })],
      chapterPatches,
      promises: null,
      beatsBefore: [],
      beatsThrough: [],
      chapterBeats: [],
      beatsNextEpisode: [],
      nextEpisodeId: null,
    });
    expect(summary.relationshipChanges).toHaveLength(1);
    const windowSubjects = windowPatchSubjects(chapterPatches);
    expect(
      collectChapterWindowViolations(summary.relationshipChanges.map((r) => r.subjectId), windowSubjects),
    ).toEqual([]);
  });

  it('INV-5 teeth：touched subject 无窗内 patch 背书 → 违反被列出（提升后单源对拍器非恒真）', () => {
    // 构造层：摘要 touched 带跨章主体（rival 窗外）而窗内只有 hero——INV-5 对拍器须报 rival。
    expect(collectChapterWindowViolations(['hero', 'rival'], new Set(['hero']))).toEqual([
      'INV-5: touched subject rival 无本章窗内 patch 背书（跨章泄漏）',
    ]);
  });
});
