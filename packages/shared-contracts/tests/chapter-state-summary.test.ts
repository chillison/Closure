import { describe, expect, it } from 'vitest';
import {
  applyPatches,
  assembleChapterStateSummary,
  assembleWorldSnapshot,
  buildWorldStateSnapshot,
  buildWorldSnapshotRequestSchema,
  chapterStateSummarySchema,
  materializeChapterSummaryRequestSchema,
  promiseBeatSchema,
  promiseEntrySchema,
  queryChapterSummaryRequestSchema,
  reduceSubject,
  worldPatchSchema,
  BUILD_WORLD_SNAPSHOT_ATS_MAX,
  CHARACTER_END_STATES_CAP,
  FORESHADOW_CHANGES_CAP,
  ORACLE_DORMANT_CAP,
  QUERY_CHAPTER_SUMMARY_EPISODE_CAP,
  type AssembleChapterStateSummaryInput,
  type ChapterSubjectActivityInput,
  type PromiseBeat,
  type PromiseBeatKind,
  type PromiseEntry,
  type WorldKindResolver,
  type WorldPatch,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.1 Step 1：checkpoint seeded reduce 原语 + ChapterStateSummary 汇编纯函数。
// 覆盖（implement.md Step 1）：
// - applyPatches seeded 等价性（确定性伪随机 patch 序列上 seed+window ≡ full fold deep-equal，多种子）
// - Oracle dormancy 窗口边界（3 章界内 / 边界 N-2 vs N-3 / 无历史 / 源缺失降级）
// - 字段级 cap 截断 + truncated 标记
// - chapterStateSummarySchema round-trip + 三个 IPC request schema
// 范式红线（creative-vs-mechanical）：汇编全纯代码零语义判断——测试也只断言机械事实。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 valid WorldPatch（mirror world-state.test.ts 的 mkPatch；value 仅在 !== undefined 时带）。 */
let patchSeq = 0;
function mkPatch(
  over: Pick<WorldPatch, 'subjectId' | 'path' | 'op' | 'storyTime'> &
    Partial<Omit<WorldPatch, 'subjectId' | 'path' | 'op' | 'storyTime'>>,
): WorldPatch {
  return worldPatchSchema.parse({
    id: over.id ?? `p${++patchSeq}`,
    sliceId: over.sliceId ?? 'sl1',
    subjectId: over.subjectId,
    path: over.path,
    op: over.op,
    axis: over.axis ?? 'physical',
    source: over.source ?? 'derived',
    storyTime: over.storyTime,
    ...(over.value !== undefined ? { value: over.value } : {}),
    ...(over.summary ? { summary: over.summary } : {}),
  });
}

/** 确定性 PRNG（mulberry32）——无 Math.random，同 seed 恒同序列。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const kindResolver: WorldKindResolver = (path) => (path === '/inventory' ? 'collection' : undefined);

const GEN_PATHS = ['/hp', '/label', '/events', '/equipment/weapon', '/inventory', '/memory/师门'] as const;
const GEN_OPS = ['replace', 'increment', 'remove', 'append'] as const;

/** 确定性随机 patch 序列（多 subject / 全 op / 混 value 类型 / 双 source / 混轴；首条保证 broken-relative）。 */
function genPatches(seed: number, count: number): WorldPatch[] {
  const rand = mulberry32(seed);
  const ri = (n: number) => Math.floor(rand() * n);
  const patches: WorldPatch[] = [
    // 确定性 edge：increment 缺基准 → broken-relative（保证 issue 计数断言非空转）。
    mkPatch({ subjectId: 'hero', path: '/hp', op: 'increment', value: -5, storyTime: 1 }),
  ];
  for (let i = 0; i < count; i++) {
    const op = GEN_OPS[ri(GEN_OPS.length)];
    const path = GEN_PATHS[ri(GEN_PATHS.length)];
    const storyTime = 1 + ri(40);
    const source = ri(2) === 0 ? 'derived' : 'amendment';
    let value: unknown = undefined;
    switch (ri(4)) {
      case 0:
        value = ri(200); // number（increment 数值路径）
        break;
      case 1:
        value = `s${ri(50)}`; // string
        break;
      case 2:
        value = [{ t: ri(10) }]; // array（list / collection）
        break;
      case 3:
        value = { k: ri(10) }; // object
        break;
    }
    patches.push(
      mkPatch({
        subjectId: ri(4) === 0 ? 'npc' : 'hero',
        path,
        op,
        value,
        storyTime,
        source,
        axis: ri(5) === 0 ? 'cognitive' : 'physical',
      }),
    );
  }
  return patches;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyPatches：seeded 等价性（checkpoint 语义，design §3.2 等价性论证的测试化）
// ─────────────────────────────────────────────────────────────────────────────

describe('applyPatches — seeded 等价性（checkpoint 语义）', () => {
  it('确定性随机序列：seed+window ≡ 全量 fold（state 严格相等 + issue 计数相加），多种子多截断点', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const patches = genPatches(seed, 120);
      for (const cut of [10, 20, 30]) {
        for (const at of [25, undefined] as const) {
          if (at !== undefined && at <= cut) continue;
          const full = reduceSubject(patches, 'hero', at, { kindResolver });
          const seedFold = reduceSubject(patches, 'hero', cut, { kindResolver });
          const window = patches.filter(
            (p) => p.subjectId === 'hero' && p.storyTime > cut && (at === undefined || p.storyTime <= at),
          );
          const seeded = applyPatches(seedFold.state, window, { kindResolver });
          expect(seeded.state).toStrictEqual(full.state);
          // checkpoint 不存 issue 明细：seed 侧计数 + 窗口计数 ≡ 全量 fold 计数。
          expect(seedFold.issues.length + seeded.issues.length).toBe(full.issues.length);
        }
      }
    }
  });

  it('随机序列保证产生 issue（broken-relative / invalid-op）——等价性断言非空转', () => {
    let totalIssues = 0;
    for (const seed of [1, 7, 42, 1337, 90210]) {
      totalIssues += reduceSubject(genPatches(seed, 120), 'hero', undefined, { kindResolver }).issues.length;
    }
    expect(totalIssues).toBeGreaterThan(0);
  });

  it('窗口乱序输入 → applyPatches 规范化排序后结果不变（canonical order 保证）', () => {
    const patches = genPatches(42, 120);
    const cut = 15;
    const at = 35;
    const seedFold = reduceSubject(patches, 'hero', cut, { kindResolver });
    const window = patches.filter((p) => p.subjectId === 'hero' && p.storyTime > cut && p.storyTime <= at);
    const rand = mulberry32(999);
    const shuffled = window.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    expect(applyPatches(seedFold.state, shuffled, { kindResolver }).state).toStrictEqual(
      applyPatches(seedFold.state, window, { kindResolver }).state,
    );
  });

  it('applyPatches 不污染 seed（防御性深拷贝——checkpoint state 可复用）', () => {
    const seed = { hp: 100, equipment: { weapon: 'sword' } };
    const { state } = applyPatches(seed, [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'increment', value: -30, storyTime: 2 }),
      mkPatch({ subjectId: 'h', path: '/equipment/weapon', op: 'replace', value: 'axe', storyTime: 3 }),
    ]);
    expect(seed).toStrictEqual({ hp: 100, equipment: { weapon: 'sword' } }); // 原 seed 不变
    expect(state).toStrictEqual({ hp: 70, equipment: { weapon: 'axe' } });
  });

  it('reduceSubject = 空 seed 起 applyPatches（重构零变证明：单 subject 全集等价）', () => {
    const patches = genPatches(7, 80);
    const only = patches.filter((p) => p.subjectId === 'hero');
    expect(applyPatches({}, only, { kindResolver }).state).toStrictEqual(
      reduceSubject(patches, 'hero', undefined, { kindResolver }).state,
    );
  });

  it('patch.value 不被 fold 写穿（重复 fold 同一批 patches 结果恒同——同输入恒同输出前提）', () => {
    const patches = genPatches(7, 120);
    const first = reduceSubject(patches, 'hero', undefined, { kindResolver });
    const second = reduceSubject(patches, 'hero', undefined, { kindResolver });
    const third = reduceSubject(patches, 'hero', undefined, { kindResolver });
    expect(second.state).toStrictEqual(first.state);
    expect(third.state).toStrictEqual(first.state);
  });

  it('seed 含 undefined 值键原样保留（clone 非 JSON 路径——保 seeded ≡ full-fold 严格等价）', () => {
    const seeded = applyPatches({ hp: undefined, bag: [{ a: 1 }] }, []);
    expect('hp' in seeded.state).toBe(true);
    expect(seeded.state).toStrictEqual({ hp: undefined, bag: [{ a: 1 }] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assembleWorldSnapshot：drop-empty + attrs 投影单源（design §3.2）
// ─────────────────────────────────────────────────────────────────────────────

describe('assembleWorldSnapshot — drop-empty + attrs 投影单源', () => {
  it('投影掉非白名单顶层 key；空投影/空状态 subject 丢弃；顺序保持', () => {
    const subjects = assembleWorldSnapshot(
      [
        { subjectId: 'a', state: { hp: 70, location: 'x' }, issueCount: 0 },
        { subjectId: 'b', state: {}, issueCount: 2 },
        { subjectId: 'c', state: { location: 'y' }, issueCount: 0 },
      ],
      ['hp'],
    );
    expect(subjects).toEqual([{ subjectId: 'a', state: { hp: 70 }, issueCount: 0 }]);
  });

  it('attrs 缺省/空数组 = 不投影（保完整状态；空状态仍丢）', () => {
    const entries = [
      { subjectId: 'a', state: { hp: 70 }, issueCount: 1 },
      { subjectId: 'b', state: {}, issueCount: 0 },
    ];
    expect(assembleWorldSnapshot(entries)).toEqual([{ subjectId: 'a', state: { hp: 70 }, issueCount: 1 }]);
    expect(assembleWorldSnapshot(entries, [])).toEqual([{ subjectId: 'a', state: { hp: 70 }, issueCount: 1 }]);
  });

  it('与 buildWorldStateSnapshot 内联路径一致（重构单源等价）', () => {
    const patches = [
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 70, storyTime: 10 }),
      mkPatch({ subjectId: 'erina', path: '/memory', op: 'replace', value: 'secret', storyTime: 12 }),
    ];
    const snap = buildWorldStateSnapshot(patches, undefined, { attrs: ['hp'] });
    expect(snap.subjects).toEqual(
      assembleWorldSnapshot([{ subjectId: 'erina', state: { hp: 70, memory: 'secret' }, issueCount: 0 }], ['hp']),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assembleChapterStateSummary：fixtures
// ─────────────────────────────────────────────────────────────────────────────

function subj(
  id: string,
  lastActive: number | null,
  over: Partial<ChapterSubjectActivityInput> = {},
): ChapterSubjectActivityInput {
  return {
    subjectId: id,
    type: 'character',
    firstSeenStoryTime: 1,
    lastActiveEpisodeIndex: lastActive,
    ...(lastActive !== null ? { endState: { hp: 100 } } : {}),
    ...over,
  };
}

function baseInput(over: Partial<AssembleChapterStateSummaryInput> = {}): AssembleChapterStateSummaryInput {
  return {
    episodeId: 'ep-10',
    episodeIndex: 10,
    storyTimeStart: 900,
    storyTimeEnd: 999,
    subjects: [],
    chapterPatches: [],
    promises: [],
    beatsBefore: [],
    beatsThrough: [],
    chapterBeats: [],
    beatsNextEpisode: [],
    nextEpisodeId: 'ep-11',
    ...over,
  };
}

function mkPromise(id: string, over: Record<string, unknown> = {}): PromiseEntry {
  return promiseEntrySchema.parse({ id, title: `承诺 ${id}`, summary: '向读者许了什么', ...over });
}

let beatSeq = 0;
function mkBeat(promiseId: string, kind: PromiseBeatKind, over: Record<string, unknown> = {}): PromiseBeat {
  return promiseBeatSchema.parse({ id: `beat-${++beatSeq}`, promiseId, sceneRef: 'scene-1', kind, ...over });
}

// ─────────────────────────────────────────────────────────────────────────────
// Oracle dormancy 窗口边界（design §3.3 v2 修正：cast 模型澄清）
// ─────────────────────────────────────────────────────────────────────────────

describe('assembleChapterStateSummary — Oracle dormancy 窗口边界', () => {
  it('3 章窗内（N/N-1/N-2）活跃进 cast；N-3 起标 dormant（最近休眠在前）', () => {
    const r = assembleChapterStateSummary(
      baseInput({
        subjects: [
          subj('curr', 10), // 本章
          subj('prev', 9), // N-1
          subj('edge', 8), // N-2 边界——仍活跃
          subj('justOut', 7, { lastChangedEpisodeId: 'ep-7' }), // N-3 —— dormant
          subj('longGone', 3, { lastChangedEpisodeId: 'ep-3' }), // 久休
        ],
      }),
    );
    expect(r.summary.characterEndStates.map((s) => s.subjectId)).toEqual(['curr', 'prev', 'edge']);
    expect(r.summary.oracleDormant.map((s) => s.subjectId)).toEqual(['justOut', 'longGone']);
    expect(r.summary.oracleDormant[0].lastChangedEpisodeId).toBe('ep-7');
    expect(r.summary.truncated).toBe(false);
    expect(r.summary.degradedNote).toBeUndefined();
  });

  it('无历史（首章/第 2 章）不误标 dormant——窗口内有多少算多少', () => {
    const r0 = assembleChapterStateSummary(baseInput({ episodeIndex: 0, subjects: [subj('a', 0)] }));
    expect(r0.summary.characterEndStates.map((s) => s.subjectId)).toEqual(['a']);
    expect(r0.summary.oracleDormant).toEqual([]);

    const r1 = assembleChapterStateSummary(
      baseInput({ episodeIndex: 1, subjects: [subj('a', 1), subj('b', 0)] }),
    );
    expect(r1.summary.characterEndStates.map((s) => s.subjectId).sort()).toEqual(['a', 'b']);
    expect(r1.summary.oracleDormant).toEqual([]);
  });

  it('episodeIndex null（源缺失）降级：已折叠者进 cast、不标 dormant + degradedNote', () => {
    const r = assembleChapterStateSummary(
      baseInput({
        episodeIndex: null,
        subjects: [
          subj('a', 3, { endState: { hp: 5 } }),
          subj('b', 3, { endState: undefined }), // 无折叠 → 两处不进
        ],
      }),
    );
    expect(r.summary.characterEndStates.map((s) => s.subjectId)).toEqual(['a']);
    expect(r.summary.oracleDormant).toEqual([]);
    expect(r.summary.degradedNote).toContain('episode_outlines');
  });

  it('无 patch 史 subject（lastActive null）不进 cast 也不标 dormant，但可作新实体', () => {
    const r = assembleChapterStateSummary(
      baseInput({ subjects: [subj('stub', null, { firstSeenStoryTime: 950 })] }),
    );
    expect(r.summary.characterEndStates).toEqual([]);
    expect(r.summary.oracleDormant).toEqual([]);
    expect(r.summary.newEntities.map((s) => s.subjectId)).toEqual(['stub']);
  });

  it('活跃 cast 空 endState → drop-empty 不收录', () => {
    const r = assembleChapterStateSummary(baseInput({ subjects: [subj('a', 10, { endState: {} })] }));
    expect(r.summary.characterEndStates).toEqual([]);
  });

  it('outlines 整档缺失（n null + lastActive 全 null + 已折叠）：降级分支仍收录已折叠者（Step 3 修 guard 序）', () => {
    // 场景 = shell materialize handler「episode_outlines 缺」路径：indexById 空 → 全 subject
    // lastActiveEpisodeIndex null，但 caller 对本章触及者已折叠。原 guard 序（无史先判）会把已折叠者
    // 也挡在 n===null 分支外 → cast 恒空；修后 n===null 优先，仅看 endState（design §3.2 降级意图）。
    const r = assembleChapterStateSummary(
      baseInput({
        episodeIndex: null,
        subjects: [
          subj('a', null, { endState: { hp: 5 } }),
          subj('b', null, { endState: undefined }),
        ],
      }),
    );
    expect(r.summary.characterEndStates.map((s) => s.subjectId)).toEqual(['a']);
    expect(r.summary.oracleDormant).toEqual([]);
    expect(r.summary.degradedNote).toContain('episode_outlines');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 字段级 cap 截断 + truncated 标记（design §3.3 token 预算：截断不静默）
// ─────────────────────────────────────────────────────────────────────────────

describe('assembleChapterStateSummary — cap 截断 + truncated 标记', () => {
  it(`characterEndStates cap ${CHARACTER_END_STATES_CAP}：最近活跃序截断 + truncated`, () => {
    // episodeIndex 2 → 活跃窗 = index >= 0（全部活跃）；序 = lastActive 降序 s29..s00。
    const subjects = Array.from({ length: 30 }, (_, i) => subj(`s${String(i).padStart(2, '0')}`, i));
    const r = assembleChapterStateSummary(baseInput({ episodeIndex: 2, subjects }));
    expect(r.summary.characterEndStates).toHaveLength(CHARACTER_END_STATES_CAP);
    expect(r.summary.characterEndStates.map((s) => s.subjectId)).toEqual(
      Array.from({ length: CHARACTER_END_STATES_CAP }, (_, i) => `s${String(29 - i).padStart(2, '0')}`),
    );
    expect(r.summary.truncated).toBe(true);
  });

  it('relationshipChanges cap 20（storyTime 升序截断）+ truncated', () => {
    const chapterPatches = Array.from({ length: 25 }, (_, i) =>
      mkPatch({
        subjectId: 'a',
        path: '/relation/trust',
        op: 'replace',
        value: i,
        storyTime: 900 + i,
        axis: 'relational',
      }),
    );
    const r = assembleChapterStateSummary(baseInput({ chapterPatches }));
    expect(r.summary.relationshipChanges).toHaveLength(20);
    expect(r.summary.relationshipChanges[0].storyTime).toBe(900);
    expect(r.summary.relationshipChanges[19].storyTime).toBe(919);
    expect(r.summary.truncated).toBe(true);
  });

  it('openPromises cap 20（registry 序截断）+ truncated', () => {
    const promises = Array.from({ length: 25 }, (_, i) => mkPromise(`p${i}`));
    const r = assembleChapterStateSummary(baseInput({ promises }));
    expect(r.summary.openPromises).toHaveLength(20);
    expect(r.summary.openPromises.map((p) => p.promiseId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `p${i}`),
    );
    expect(r.summary.truncated).toBe(true);
  });

  it('newEntities cap 20（firstSeen 升序截断）+ truncated', () => {
    const subjects = Array.from({ length: 30 }, (_, i) =>
      subj(`n${String(i).padStart(2, '0')}`, null, { firstSeenStoryTime: 901 + i }),
    );
    const r = assembleChapterStateSummary(baseInput({ subjects }));
    expect(r.summary.newEntities).toHaveLength(20);
    expect(r.summary.newEntities[0].subjectId).toBe('n00');
    expect(r.summary.truncated).toBe(true);
  });

  it('nextChapterPayoffs cap 15 + truncated', () => {
    const promises = Array.from({ length: 20 }, (_, i) => mkPromise(`q${i}`));
    const beatsNextEpisode = promises.map((p) => mkBeat(p.id, 'payoff', { episodeId: 'ep-11' }));
    const r = assembleChapterStateSummary(baseInput({ promises, beatsNextEpisode }));
    expect(r.summary.nextChapterPayoffs).toHaveLength(15);
    expect(r.summary.truncated).toBe(true);
  });

  it('无截断 → truncated false', () => {
    const r = assembleChapterStateSummary(
      baseInput({
        subjects: [subj('a', 10)],
        chapterPatches: [
          mkPatch({
            subjectId: 'a',
            path: '/relation/trust',
            op: 'replace',
            value: 1,
            storyTime: 910,
            axis: 'relational',
            summary: '信任加深',
          }),
        ],
      }),
    );
    expect(r.summary.truncated).toBe(false);
  });

  // ── Story 8.2 cap 回填（8.1 deferred-work 关闭）：oracleDormant / foreshadowChanges 机械防爆 cap ──
  // 50000 级非预算（用户 2026-08-17 拍板认账 median 1302）；正常量级零触及 = 零行为变化，
  // 极端量级（提取器回归级倾倒）截断 + truncated=true。

  it(`正常量级零行为变化：oracleDormant ${ORACLE_DORMANT_CAP - 1} 条全保留 + truncated false（防爆 cap 非预算）`, () => {
    // episodeIndex 2 → 活跃窗 = index >= 0；构造 CAP-1 个 dormant（lastActive 全 < 0 不可能——
    // 直接用 index 2 + lastActive null 的 subject 会进「无史」分支，改用大 episodeIndex 压 dormant 区）。
    const subjects = [
      subj('active', 42),
      ...Array.from({ length: ORACLE_DORMANT_CAP - 1 }, (_, i) =>
        subj(`d${String(i).padStart(5, '0')}`, 0, { lastChangedEpisodeId: 'ep-0' }),
      ),
    ];
    const r = assembleChapterStateSummary(baseInput({ episodeIndex: 42, subjects }));
    expect(r.summary.oracleDormant).toHaveLength(ORACLE_DORMANT_CAP - 1);
    expect(r.summary.oracleDormant[0].lastChangedEpisodeId).toBe('ep-0');
    expect(r.summary.truncated).toBe(false);
  });

  it(`oracleDormant 超 ${ORACLE_DORMANT_CAP} 截断（最近休眠序保序）+ truncated true`, () => {
    const subjects = [
      subj('active', 42),
      ...Array.from({ length: ORACLE_DORMANT_CAP + 3 }, (_, i) =>
        subj(`d${String(i).padStart(5, '0')}`, 5 - Math.floor(i / 2), { lastChangedEpisodeId: `ep-${i}` }),
      ),
    ];
    const r = assembleChapterStateSummary(baseInput({ episodeIndex: 42, subjects }));
    expect(r.summary.oracleDormant).toHaveLength(ORACLE_DORMANT_CAP);
    expect(r.summary.truncated).toBe(true);
  });

  it(`foreshadowChanges 正常量级零行为变化（< ${FORESHADOW_CHANGES_CAP} 全保留）；超 cap 截断 + truncated true`, () => {
    const promises = [mkPromise('p1')];
    const mkChapterBeats = (count: number) =>
      Array.from({ length: count }, (_, i) => mkBeat('p1', 'advance', { id: `beat-${i}`, episodeId: 'ep-10' }));

    const normal = assembleChapterStateSummary(
      baseInput({ promises, chapterBeats: mkChapterBeats(5), beatsThrough: mkChapterBeats(5) }),
    );
    expect(normal.summary.foreshadowChanges).toHaveLength(5);
    expect(normal.summary.truncated).toBe(false);

    const chapterBeats = mkChapterBeats(FORESHADOW_CHANGES_CAP + 10);
    const extreme = assembleChapterStateSummary(
      baseInput({ promises, chapterBeats, beatsThrough: chapterBeats }),
    );
    expect(extreme.summary.foreshadowChanges).toHaveLength(FORESHADOW_CHANGES_CAP);
    expect(extreme.summary.truncated).toBe(true);
  });

  it(`schema 层强制：oracleDormant / foreshadowChanges 超 cap 数组 parse reject（mirror 既有 cap 字段）`, () => {
    const overDormant = Array.from({ length: ORACLE_DORMANT_CAP + 1 }, (_, i) => ({
      subjectId: `s${i}`,
    }));
    expect(() =>
      chapterStateSummarySchema.parse({
        episodeId: 'e',
        episodeIndex: 1,
        storyTimeStart: 1,
        storyTimeEnd: 2,
        oracleDormant: overDormant,
      }),
    ).toThrow();

    const overForeshadow = Array.from({ length: FORESHADOW_CHANGES_CAP + 1 }, (_, i) => ({
      promiseId: `p${i}`,
      title: 't',
      stageChange: { from: 'planted', to: 'echoed' },
      beatKind: 'advance',
      sceneRef: 's',
    }));
    expect(() =>
      chapterStateSummarySchema.parse({
        episodeId: 'e',
        episodeIndex: 1,
        storyTimeStart: 1,
        storyTimeEnd: 2,
        foreshadowChanges: overForeshadow,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 六字段汇编内容（机械事实，零语义判断）
// ─────────────────────────────────────────────────────────────────────────────

describe('assembleChapterStateSummary — 六字段汇编内容', () => {
  it('② relational patch 摘录：summary 透传；缺省机械回退 op+path；storyTime 升序；非 relational 轴排除', () => {
    const chapterPatches = [
      mkPatch({
        subjectId: 'a',
        path: '/relation/trust',
        op: 'replace',
        value: 1,
        storyTime: 920,
        axis: 'relational',
      }), // 无 summary → 回退
      mkPatch({
        subjectId: 'a',
        path: '/relation/trust',
        op: 'increment',
        value: 1,
        storyTime: 905,
        axis: 'relational',
        summary: '并肩作战后信任加深',
      }),
      mkPatch({ subjectId: 'a', path: '/hp', op: 'replace', value: 50, storyTime: 910, axis: 'physical' }), // 排除
    ];
    const r = assembleChapterStateSummary(baseInput({ chapterPatches }));
    expect(r.summary.relationshipChanges).toHaveLength(2);
    expect(r.summary.relationshipChanges[0]).toMatchObject({ storyTime: 905, summary: '并肩作战后信任加深' });
    expect(r.summary.relationshipChanges[1].summary).toBe('replace /relation/trust');
  });

  it('③ 伏笔状态变更：本章 plant+advance 逐条列（from=unplanted → to=echoed）；dangling promiseId 跳过', () => {
    const p1 = mkPromise('p1');
    const plant = mkBeat('p1', 'plant', { episodeId: 'ep-10' });
    const advance = mkBeat('p1', 'advance', { episodeId: 'ep-10' });
    const dangling = mkBeat('ghost', 'payoff', { episodeId: 'ep-10' });
    const r = assembleChapterStateSummary(
      baseInput({ promises: [p1], chapterBeats: [plant, advance, dangling], beatsThrough: [plant, advance] }),
    );
    expect(r.summary.foreshadowChanges.map((c) => c.beatKind)).toEqual(['plant', 'advance']);
    expect(r.summary.foreshadowChanges[0].stageChange).toEqual({ from: 'unplanted', to: 'echoed' });
  });

  it('③ 前章已有 plant → from=planted（beatsBefore 派生）', () => {
    const p1 = mkPromise('p1');
    const priorPlant = mkBeat('p1', 'plant', { episodeId: 'ep-09' });
    const advance = mkBeat('p1', 'advance', { episodeId: 'ep-10' });
    const r = assembleChapterStateSummary(
      baseInput({ promises: [p1], beatsBefore: [priorPlant], beatsThrough: [priorPlant, advance], chapterBeats: [advance] }),
    );
    expect(r.summary.foreshadowChanges[0].stageChange).toEqual({ from: 'planted', to: 'echoed' });
  });

  it('⑤ 未决承诺：排除 fulfilled / abandoned / 派生 paid_off；带 deadlineEpisodeId', () => {
    const promises = [
      mkPromise('open1', { deadlineEpisodeId: 'ep-12' }),
      mkPromise('done', { status: 'fulfilled' }),
      mkPromise('gone', { status: 'abandoned' }),
      mkPromise('paid'), // status open 但至本章末有 payoff beat → 派生 paid_off → 排除
    ];
    const payoff = mkBeat('paid', 'payoff', { episodeId: 'ep-10' });
    const r = assembleChapterStateSummary(baseInput({ promises, beatsThrough: [payoff] }));
    expect(r.summary.openPromises).toHaveLength(1);
    expect(r.summary.openPromises[0]).toMatchObject({
      promiseId: 'open1',
      stage: 'unplanted',
      deadlineEpisodeId: 'ep-12',
    });
  });

  it('⑥ 下章回收：next-episode beat + deadline 到期（无 beat 落场也列）；promiseId 去重；无下一章 → 空', () => {
    const promises = [
      mkPromise('beatP'),
      mkPromise('dl', { deadlineEpisodeId: 'ep-11' }),
      mkPromise('both', { deadlineEpisodeId: 'ep-11' }),
    ];
    const nextBeat = mkBeat('beatP', 'payoff', { episodeId: 'ep-11', note: '真相揭晓' });
    const bothBeat = mkBeat('both', 'payoff', { episodeId: 'ep-11' }); // both 有 beat → deadline 不重复列
    const r = assembleChapterStateSummary(baseInput({ promises, beatsNextEpisode: [nextBeat, bothBeat] }));
    expect(r.summary.nextChapterPayoffs.map((p) => p.promiseId)).toEqual(['beatP', 'both', 'dl']);
    expect(r.summary.nextChapterPayoffs[0].note).toBe('真相揭晓');
    expect(r.summary.nextChapterPayoffs[2].note).toBe('deadline 到期');

    const rNone = assembleChapterStateSummary(baseInput({ promises, nextEpisodeId: null }));
    expect(rNone.summary.nextChapterPayoffs).toEqual([]);
  });

  it('⑥ CR-3 settled promise 不进下章回收：fulfilled+deadline 命中 / abandoned+beat 命中 / 已 paid_off 均排除', () => {
    const promises = [
      mkPromise('doneFulfilled', { status: 'fulfilled', deadlineEpisodeId: 'ep-11' }), // deadline 命中但已了结
      mkPromise('goneAbandoned', { status: 'abandoned' }), // beat 落下章但已弃
      mkPromise('alreadyPaid'), // status open 但至本章末已 paid_off（beatsThrough 含 payoff）→ 无需再回收
      mkPromise('stillOpen', { deadlineEpisodeId: 'ep-11' }), // 对照：真未决 → 进
    ];
    const paidOffBeat = mkBeat('alreadyPaid', 'payoff', { episodeId: 'ep-10' });
    const abandonedBeat = mkBeat('goneAbandoned', 'payoff', { episodeId: 'ep-11' });
    const r = assembleChapterStateSummary(
      baseInput({ promises, beatsThrough: [paidOffBeat], beatsNextEpisode: [abandonedBeat] }),
    );
    expect(r.summary.nextChapterPayoffs.map((p) => p.promiseId)).toEqual(['stillOpen']);
  });

  it('④ 新实体窗口闭区间边界：start/end 含、窗外排除、窗 null → 空', () => {
    const subjects = [
      subj('in1', null, { firstSeenStoryTime: 900 }),
      subj('in2', null, { firstSeenStoryTime: 999 }),
      subj('out1', null, { firstSeenStoryTime: 899 }),
      subj('out2', null, { firstSeenStoryTime: 1000 }),
    ];
    const r = assembleChapterStateSummary(baseInput({ subjects }));
    expect(r.summary.newEntities.map((s) => s.subjectId).sort()).toEqual(['in1', 'in2']);

    const rNull = assembleChapterStateSummary(
      baseInput({ subjects, storyTimeStart: null, storyTimeEnd: null }),
    );
    expect(rNull.summary.newEntities).toEqual([]);
    expect(rNull.summary.storyTimeStart).toBeNull();
    expect(rNull.summary.storyTimeEnd).toBeNull();
  });

  it('promises null（源缺失）→ ③⑤⑥ 空 + degradedNote（design §5 缺源 graceful）', () => {
    const r = assembleChapterStateSummary(
      baseInput({ promises: null, chapterBeats: [mkBeat('x', 'plant')], nextEpisodeId: 'ep-11' }),
    );
    expect(r.summary.foreshadowChanges).toEqual([]);
    expect(r.summary.openPromises).toEqual([]);
    expect(r.summary.nextChapterPayoffs).toEqual([]);
    expect(r.summary.degradedNote).toContain('promise_registry');
  });

  it('tokenEstimate = ceil(JSON 长度 / 3.5)（字符启发式 mirror context-management）', () => {
    const r = assembleChapterStateSummary(baseInput({ subjects: [subj('a', 10, { name: '艾莉娜' })] }));
    expect(r.tokenEstimate).toBe(Math.ceil(JSON.stringify(r.summary).length / 3.5));
    expect(r.tokenEstimate).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chapterStateSummarySchema round-trip + Story 8.1 IPC request schemas
// ─────────────────────────────────────────────────────────────────────────────

describe('chapterStateSummarySchema — round-trip', () => {
  it('汇编输出 parse 通过（truncated/数组显式构造无 default 依赖）', () => {
    const r = assembleChapterStateSummary(baseInput({ subjects: [subj('a', 10)] }));
    const parsed = chapterStateSummarySchema.parse(r.summary);
    expect(parsed.episodeId).toBe('ep-10');
    expect(parsed.episodeIndex).toBe(10);
    expect(parsed.truncated).toBe(false);
    expect(parsed.oracleDormant).toEqual([]);
  });

  it('缺 episodeId → reject', () => {
    expect(() =>
      chapterStateSummarySchema.parse({ episodeIndex: null, storyTimeStart: null, storyTimeEnd: null }),
    ).toThrow();
  });

  it('nullable 字段接受 null；storyTime 类型错（string）reject', () => {
    const base = { episodeId: 'e', episodeIndex: null, storyTimeStart: null, storyTimeEnd: null };
    expect(chapterStateSummarySchema.parse(base).episodeIndex).toBeNull();
    expect(() => chapterStateSummarySchema.parse({ ...base, storyTimeEnd: 'x' })).toThrow();
  });

  // ── Story 8.7（R5）additive：synopsis 章级一段话梗概（写手申报产物递入）──
  it('synopsis optional：缺省合法（缺申报/降级章 undefined 不编造）；带值 round-trip；非串 reject', () => {
    const base = { episodeId: 'e', episodeIndex: 1, storyTimeStart: 1, storyTimeEnd: 2 };
    expect(chapterStateSummarySchema.parse(base).synopsis).toBeUndefined();
    const withSynopsis = chapterStateSummarySchema.parse({
      ...base,
      synopsis: '李玄夜探档案房，三师叔的私印浮出水面。',
    });
    expect(withSynopsis.synopsis).toContain('私印');
    expect(() => chapterStateSummarySchema.parse({ ...base, synopsis: 42 })).toThrow();
  });

  it(`超 cap 数组 reject（schema 级强制 CHARACTER_END_STATES_CAP=${CHARACTER_END_STATES_CAP}）`, () => {
    const over = Array.from({ length: CHARACTER_END_STATES_CAP + 1 }, (_, i) => ({
      subjectId: `s${i}`,
      type: 'character',
      state: { hp: 1 },
    }));
    expect(() =>
      chapterStateSummarySchema.parse({
        episodeId: 'e',
        episodeIndex: 1,
        storyTimeStart: 1,
        storyTimeEnd: 2,
        characterEndStates: over,
      }),
    ).toThrow();
  });

  it('stageChange 非法 stage 枚举 reject', () => {
    expect(() =>
      chapterStateSummarySchema.parse({
        episodeId: 'e',
        episodeIndex: 1,
        storyTimeStart: 1,
        storyTimeEnd: 2,
        foreshadowChanges: [
          {
            promiseId: 'p',
            title: 't',
            stageChange: { from: 'bogus', to: 'planted' },
            beatKind: 'plant',
            sceneRef: 's',
          },
        ],
      }),
    ).toThrow();
  });
});

describe('Story 8.1 IPC request schemas', () => {
  it('buildWorldSnapshotRequestSchema：空参合法（取最新）；ats/at 各自合法', () => {
    expect(buildWorldSnapshotRequestSchema.parse({})).toEqual({});
    expect(buildWorldSnapshotRequestSchema.parse({ ats: [1, 2] })).toMatchObject({ ats: [1, 2] });
    expect(buildWorldSnapshotRequestSchema.parse({ at: 3 })).toMatchObject({ at: 3 });
  });

  it('buildWorldSnapshotRequestSchema：ats 与 at 同传 → reject（CR-2 互斥强制——原同传静默取 at 吞批量请求）', () => {
    expect(() => buildWorldSnapshotRequestSchema.parse({ ats: [1, 2], at: 3 })).toThrow();
  });

  it(`buildWorldSnapshotRequestSchema：ats 超 ${BUILD_WORLD_SNAPSHOT_ATS_MAX} reject（防滥用）`, () => {
    const ats = Array.from({ length: BUILD_WORLD_SNAPSHOT_ATS_MAX + 1 }, (_, i) => i);
    expect(() => buildWorldSnapshotRequestSchema.parse({ ats })).toThrow();
    expect(
      buildWorldSnapshotRequestSchema.parse({ ats: ats.slice(0, BUILD_WORLD_SNAPSHOT_ATS_MAX) }).ats,
    ).toHaveLength(BUILD_WORLD_SNAPSHOT_ATS_MAX);
  });

  it('buildWorldSnapshotRequestSchema：projection 非法枚举 reject', () => {
    expect(() => buildWorldSnapshotRequestSchema.parse({ projection: 'vibes' })).toThrow();
  });

  it(`queryChapterSummaryRequestSchema：空参/fromIndex-toIndex 合法；episodeIds 超 ${QUERY_CHAPTER_SUMMARY_EPISODE_CAP} reject`, () => {
    expect(queryChapterSummaryRequestSchema.parse({})).toEqual({});
    expect(queryChapterSummaryRequestSchema.parse({ fromIndex: 0, toIndex: 10 })).toEqual({
      fromIndex: 0,
      toIndex: 10,
    });
    const ids = Array.from({ length: QUERY_CHAPTER_SUMMARY_EPISODE_CAP + 1 }, (_, i) => `ep-${i}`);
    expect(() => queryChapterSummaryRequestSchema.parse({ episodeIds: ids })).toThrow();
  });

  it('queryChapterSummaryRequestSchema：episodeIds 空数组 reject（CR-1——曾绕过收窄全表倾倒）', () => {
    expect(() => queryChapterSummaryRequestSchema.parse({ episodeIds: [] })).toThrow();
  });

  it('materializeChapterSummaryRequestSchema：episodeId 必填', () => {
    expect(materializeChapterSummaryRequestSchema.parse({ episodeId: 'ep-10' }).episodeId).toBe('ep-10');
    expect(() => materializeChapterSummaryRequestSchema.parse({})).toThrow();
  });
});
