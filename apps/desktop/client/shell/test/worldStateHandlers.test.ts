import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted so the mock factories (run before imports) can reference the stubs
// (mirror queryStoryHandler.test.ts / modelGatewayIpc.test.ts pattern).
const {
  getProject,
  reduceWorldSubject,
  listWorldSlices,
  listWorldPatches,
  findWorldRefs,
  insertWorldSlice,
  warn,
  // Story 8.1 Step 3 handlers 的 repo 依赖（同模式追加）。
  buildWorldSnapshotCheckpointed,
  listChapterSummaries,
  listWorldSubjects,
  reduceWorldSubjectCheckpointed,
  getLatestWorldCheckpoint,
  getWorldPatchRowidHigh,
  upsertChapterSummaryWithCheckpoints,
  backfillWorldSliceEpisodeIds,
  // CR-8（8.1 修复批）：materialize 核心下潜 db/worldStateMaterialize 后新增的 repo 依赖（slice.id
  // 硬化前缀解析——fixture slice 均带 episodeId 列，实际不被调用，占位防 mock 缺导出）。
  parseEpisodeIdFromSliceId,
  // dogfood R2 #91：写入面 subject 身份解析（write handler 落 insertWorldSlice 前调用）。
  resolveWorldSubjectIdentity,
  loadProject,
  // dogfood R2 #91：write handler remap 时 getLogger().info（原 mock 只有 warn）。
  info,
} = vi.hoisted(() => ({
  getProject: vi.fn(),
  reduceWorldSubject: vi.fn(),
  listWorldSlices: vi.fn(),
  listWorldPatches: vi.fn(),
  findWorldRefs: vi.fn(),
  insertWorldSlice: vi.fn(),
  warn: vi.fn(),
  buildWorldSnapshotCheckpointed: vi.fn(),
  listChapterSummaries: vi.fn(),
  listWorldSubjects: vi.fn(),
  reduceWorldSubjectCheckpointed: vi.fn(),
  getLatestWorldCheckpoint: vi.fn(),
  getWorldPatchRowidHigh: vi.fn(),
  upsertChapterSummaryWithCheckpoints: vi.fn(),
  backfillWorldSliceEpisodeIds: vi.fn(),
  parseEpisodeIdFromSliceId: vi.fn(),
  resolveWorldSubjectIdentity: vi.fn(),
  loadProject: vi.fn(),
  info: vi.fn(),
}));

// Mock the handler's real deps. With projectRepository + worldStateRepository
// replaced, their transitive imports (getDb, modelGatewayIpc, sqliteVecLoader)
// never load — so this suite runs under plain vitest with NO better-sqlite3 ABI
// concern and ZERO network. The logger is mocked too. getCognitionAtTime /
// compileCognitionForScene / buildCognitionSnapshot / buildPresenceSignal /
// assembleChapterStateSummary come from @orison/shared-contracts (real, pure) —
// they process the synthetic patches/fixture returned by the repo mocks,
// exercising the real reduce/projection (DRY, mirror brief-compiler-stateAtT.test.ts).
vi.mock('../main/db/projectRepository', () => ({ getProject }));
vi.mock('../main/db/worldStateRepository', () => ({
  reduceWorldSubject,
  listWorldSlices,
  listWorldPatches,
  findWorldRefs,
  insertWorldSlice,
  buildWorldSnapshotCheckpointed,
  listChapterSummaries,
  listWorldSubjects,
  reduceWorldSubjectCheckpointed,
  getLatestWorldCheckpoint,
  getWorldPatchRowidHigh,
  upsertChapterSummaryWithCheckpoints,
  backfillWorldSliceEpisodeIds,
  parseEpisodeIdFromSliceId,
  resolveWorldSubjectIdentity,
}));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));
// materialize 的 project.yaml 三源经 local-bff loadProject（handler 内动态 import；mirror
// assetCardsHandlers.test.ts 顶层 mock + per-test 控制模式）。
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

import {
  amendWorldStateHandler,
  buildWorldSnapshotHandler,
  findWorldRefsHandler,
  materializeChapterSummaryHandler,
  queryChapterSummaryHandler,
  queryCognitionGraphHandler,
  queryCognitionHandler,
  queryWorldSliceHandler,
  queryWorldStateHandler,
  writeWorldEventsHandler,
} from '../main/ipc/toolHandlers/worldStateHandlers';
import type { WorldPatch, WorldSlice } from '@orison/shared-contracts';

/** listWorldSlices withPatches 返回形态（repo 内联类型，测试侧同构别名）。 */
type SliceWithPatches = WorldSlice & { patches?: WorldPatch[] };

function ctx(params: Record<string, unknown>, projectDir = '/proj/alpha') {
  return {
    params,
    projectDir,
    sessionId: 's1',
    abort: new AbortController().signal,
  };
}

describe('worldStateHandlers (Story 6.6 Phase B)', () => {
  beforeEach(() => {
    getProject.mockReset();
    reduceWorldSubject.mockReset();
    listWorldSlices.mockReset();
    listWorldPatches.mockReset();
    findWorldRefs.mockReset();
    insertWorldSlice.mockReset();
    warn.mockReset();
    // dogfood R2 #91：身份解析默认直通（subjects/patches 原样、零改写）——具体 remap 行为由
    // worldSubjectIdMigration.test.ts 对真实现测试；此处只验证 handler 接线。
    resolveWorldSubjectIdentity.mockReset();
    resolveWorldSubjectIdentity.mockImplementation(
      (_pid: string, subjects: unknown, patches: unknown) => ({
        subjects,
        patches,
        remaps: [],
        reusedCount: 0,
      }),
    );
  });

  it('query_world_state derives projectId + returns reduced state + issues in metadata', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    reduceWorldSubject.mockReturnValue({
      state: { hp: 70, location: 'subject://altar' },
      issues: [],
    });

    const res = await queryWorldStateHandler(ctx({ subjectId: 'erina', attrs: ['hp', 'location'] }));

    expect(getProject).toHaveBeenCalledWith(expect.stringContaining('alpha'));
    // resolveProjectId passes through: reduce called with the 5-digit registry id.
    expect(reduceWorldSubject).toHaveBeenCalledWith('00001', 'erina', undefined, { attrs: ['hp', 'location'] });
    expect(res.metadata).toMatchObject({ ok: true, subjectId: 'erina', state: { hp: 70 } });
    expect((res.metadata as { issues: unknown[] }).issues).toEqual([]);
  });

  it('query_world_state degrades to a friendly miss when project not registered (never throws)', async () => {
    getProject.mockReturnValue(undefined);
    const res = await queryWorldStateHandler(ctx({ subjectId: 'erina' }));
    expect(reduceWorldSubject).not.toHaveBeenCalled();
    expect(res.metadata).toMatchObject({ ok: false, reason: 'project_not_registered' });
  });

  it('query_world_state degrades on invalid params (missing subjectId)', async () => {
    const res = await queryWorldStateHandler(ctx({ at: 100 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
  });

  it('query_world_slice lists slices + returns count + slices array', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    listWorldSlices.mockReturnValue([
      { id: 's1', projectId: '00001', storyTime: 100, title: '出生', patches: undefined },
    ]);

    const res = await queryWorldSliceHandler(
      ctx({ subjectIds: ['erina'], withPatches: true }),
    );

    expect(listWorldSlices).toHaveBeenCalledWith('00001', {
      subjectIds: ['erina'],
      type: undefined,
      withPatches: true,
      at: undefined,
    });
    expect(res.metadata).toMatchObject({ ok: true, count: 1 });
  });

  it('find_world_refs returns refs + count', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    findWorldRefs.mockReturnValue([
      { subjectId: 'erina', path: '/equipment/weapon', sliceId: 's1', storyTime: 100, value: 'subject://sword-01' },
    ]);

    const res = await findWorldRefsHandler(ctx({ subjectId: 'sword-01' }));
    expect(findWorldRefs).toHaveBeenCalledWith('00001', 'sword-01');
    expect(res.metadata).toMatchObject({ ok: true, count: 1, subjectId: 'sword-01' });
  });

  it('write_world_events forces source="derived" + injects infra (patches omit source)', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    const slice = { id: 'slice-x', storyTime: 100, title: '事件' };
    const patches = [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 50, axis: 'physical' as const }];

    const res = await writeWorldEventsHandler(ctx({ slice, patches, subjects: [] }));

    expect(insertWorldSlice).toHaveBeenCalledWith('00001', slice, patches, [], 'derived');
    expect(res.metadata).toMatchObject({ ok: true, source: 'derived', patchCount: 1, sliceId: 'slice-x' });
  });

  it('amend_world_state forces source="amendment" (same shape, different source)', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    const slice = { id: 'slice-amend', storyTime: 200, title: '修补' };
    const patches = [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 50, axis: 'physical' as const }];

    const res = await amendWorldStateHandler(ctx({ slice, patches }));

    expect(insertWorldSlice).toHaveBeenCalledWith('00001', slice, patches, [], 'amendment');
    expect(res.metadata).toMatchObject({ ok: true, source: 'amendment' });
  });

  it('dogfood R2 #91: write gate resolves subject identity before insert (remaps flow into insert + metadata)', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    const slice = { id: 'slice-gate', storyTime: 100, title: '变体形态' };
    const rawSubjects = [{ id: 'shenyan', type: 'character', name: '沈砚', firstSeenStoryTime: 100 }];
    const rawPatches = [
      { subjectId: 'shenyan', path: '/mood', op: 'replace', value: '警惕', axis: 'emotional' as const },
    ];
    // 身份解析 mock：shenyan 变体 → 复用既有 canonical id character:shen-yan。
    resolveWorldSubjectIdentity.mockImplementation((_pid: string, subjects: unknown, patches: unknown) => ({
      subjects: [{ ...(rawSubjects[0] as object), id: 'character:shen-yan' }],
      patches: [{ ...(rawPatches[0] as object), subjectId: 'character:shen-yan' }],
      remaps: [{ from: 'shenyan', to: 'character:shen-yan' }],
      reusedCount: 1,
    }));

    const res = await writeWorldEventsHandler(
      ctx({ slice, patches: rawPatches, subjects: rawSubjects }),
    );

    // insert 收到解析后的 canonical id（非请求原样）。
    const call = insertWorldSlice.mock.calls[0];
    expect((call[2] as Array<{ subjectId: string }>)[0].subjectId).toBe('character:shen-yan');
    expect(((call[3] as Array<{ id: string }>)[0]).id).toBe('character:shen-yan');
    // remap 进 metadata（运行阶段可见性——leader/审计可察身份归并）。
    expect(res.metadata).toMatchObject({
      ok: true,
      subjectRemaps: [{ from: 'shenyan', to: 'character:shen-yan' }],
      subjectReusedCount: 1,
    });
  });

  it('write_world_events rejects patches carrying a `source` field is NOT trusted — handler injects regardless', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    // Even if a caller tries to pass source on a patch, the write schema omits
    // `source` so it is stripped (z.object default strip); the handler always
    // passes 'derived'. This proves source is never trusted from the caller.
    const slice = { id: 'slice-y', storyTime: 100, title: 't' };
    const patches = [
      { subjectId: 'erina', path: '/hp', op: 'replace', value: 1, axis: 'physical' as const, source: 'amendment' },
    ];

    await writeWorldEventsHandler(ctx({ slice, patches }));

    const call = insertWorldSlice.mock.calls[0];
    expect(call[4]).toBe('derived'); // source forced to derived despite caller's amendment attempt
    // strip mode dropped the bogus source key from the patch.
    expect((call[2] as unknown[])[0]).not.toHaveProperty('source');
  });

  it('write handler degrades on repo failure (never throws, surfaces error)', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    insertWorldSlice.mockImplementation(() => {
      throw new Error('db locked');
    });

    const res = await writeWorldEventsHandler(
      ctx({ slice: { id: 's', storyTime: 1, title: 't' }, patches: [] }),
    );

    expect(res.metadata).toMatchObject({ ok: false, reason: 'write_failed', error: 'db locked' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 6.1 CognitionGraph query handlers（query_cognition / query_cognition_graph）
// 消费认知轴 patches → getCognitionAtTime / compileCognitionForScene 真实 reduce 投影。
// ════════════════════════════════════════════════════════════════════════════

// 合成认知轴 patches fixture（erina + kael 两角色，含分层 value + 跨 storyTime 演化 + 非 cognitive 混入）。
function makeCognitivePatches(): WorldPatch[] {
  return [
    {
      id: 'p1', sliceId: 's1', subjectId: 'erina', path: '/believes/king', op: 'replace',
      value: { objective: '怀疑国王', reader_perceived: '效忠国王' },
      axis: 'cognitive', source: 'derived', storyTime: 10, summary: '表面效忠实则怀疑',
    },
    {
      id: 'p2', sliceId: 's1', subjectId: 'erina', path: '/knows/secret', op: 'replace',
      value: '叛乱密谋', axis: 'cognitive', source: 'derived', storyTime: 10,
    },
    {
      id: 'p3', sliceId: 's2', subjectId: 'erina', path: '/believes/king', op: 'replace',
      value: '确认叛乱', axis: 'cognitive', source: 'derived', storyTime: 20,
    },
    {
      id: 'p4', sliceId: 's1', subjectId: 'kael', path: '/suspects/erina', op: 'replace',
      value: '间谍', axis: 'cognitive', source: 'derived', storyTime: 10,
    },
    // 非 cognitive patch（应被 getCognitionAtTime 预过滤排除）
    {
      id: 'p5', sliceId: 's1', subjectId: 'erina', path: '/hp', op: 'replace',
      value: 70, axis: 'physical', source: 'derived', storyTime: 10,
    },
  ];
}

describe('queryCognitionHandler + queryCognitionGraphHandler (Story 6.1)', () => {
  // 这个 describe 是 6.6 describe 的 sibling——上面那个 beforeEach 只作用于 6.6 describe，
  // 故此处单独 reset（mirror 6.6 describe 的 beforeEach，避免 mock 跨测试累积）。
  beforeEach(() => {
    getProject.mockReset();
    listWorldPatches.mockReset();
    warn.mockReset();
  });

  it('query_cognition：erina @ storyTime 10 → 认知字典含分层 value（objective/reader_perceived 保留）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    listWorldPatches.mockReturnValue(makeCognitivePatches().filter((p) => p.subjectId === 'erina' && p.storyTime <= 10));

    const res = await queryCognitionHandler(ctx({ characterSubjectId: 'erina', at: 10 }));

    expect(listWorldPatches).toHaveBeenCalledWith('00001', 'erina', 10);
    expect(res.metadata).toMatchObject({ ok: true, characterSubjectId: 'erina', at: 10 });
    const cognition = (res.metadata as any).cognition;
    // 分层 value 原样保留（reduce 不消解 objective/reader_perceived）
    expect(cognition.believes.king).toEqual({ objective: '怀疑国王', reader_perceived: '效忠国王' });
    expect(cognition.knows.secret).toBe('叛乱密谋');
    // 非 cognitive patch（hp）被预过滤排除
    expect(cognition.hp).toBeUndefined();
  });

  it('query_cognition：erina @ storyTime 20 → 后写覆盖（believes/king 替换为单值「确认叛乱」）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    listWorldPatches.mockReturnValue(makeCognitivePatches().filter((p) => p.subjectId === 'erina' && p.storyTime <= 20));

    const res = await queryCognitionHandler(ctx({ characterSubjectId: 'erina', at: 20 }));

    const cognition = (res.metadata as any).cognition;
    // storyTime 20 的 replace 覆盖 storyTime 10 的分层 value
    expect(cognition.believes.king).toBe('确认叛乱');
  });

  it('query_cognition：characterSubjectId 缺失 → invalid_params（never throws）', async () => {
    const res = await queryCognitionHandler(ctx({ at: 10 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
    expect(listWorldPatches).not.toHaveBeenCalled();
  });

  it('query_cognition：at 非整数 → invalid_params', async () => {
    const res = await queryCognitionHandler(ctx({ characterSubjectId: 'erina', at: 1.5 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
  });

  it('query_cognition：项目未注册 → notRegistered（never throws）', async () => {
    getProject.mockReturnValue(undefined);
    const res = await queryCognitionHandler(ctx({ characterSubjectId: 'erina' }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'project_not_registered' });
  });

  it('query_cognition_graph：storyTime 10 → 全角色认知图（erina + kael，physical 排除）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    listWorldPatches.mockReturnValue(makeCognitivePatches().filter((p) => p.storyTime <= 10));

    const res = await queryCognitionGraphHandler(ctx({ at: 10 }));

    expect(listWorldPatches).toHaveBeenCalledWith('00001', undefined, 10);
    expect(res.metadata).toMatchObject({ ok: true, at: 10, characterCount: 2 });
    const cognition = (res.metadata as any).cognition;
    expect(cognition.erina).toBeDefined();
    expect(cognition.kael.suspects.erina).toBe('间谍');
    // physical patch 不进认知图
    expect(cognition.erina.hp).toBeUndefined();
  });

  it('query_cognition_graph：at 缺省 → 取最大 storyTime（最新）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    // at undefined → listWorldPatches 返全集（不过滤 storyTime）
    listWorldPatches.mockReturnValue(makeCognitivePatches());

    const res = await queryCognitionGraphHandler(ctx({}));

    // at 缺省：handler 算 max storyTime（=20）作截断点
    expect(res.metadata).toMatchObject({ ok: true, at: 20 });
    const cognition = (res.metadata as any).cognition;
    // storyTime 20：erina believes/king = 确认叛乱（20 的 replace 覆盖 10 的分层）
    expect(cognition.erina.believes.king).toBe('确认叛乱');
  });

  it('query_cognition_graph：无 patches → 友好空（never throws）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    listWorldPatches.mockReturnValue([]);
    const res = await queryCognitionGraphHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: true, at: null, characterCount: 0, cognition: {} });
  });

  it('query_cognition_graph：项目未注册 → notRegistered', async () => {
    getProject.mockReturnValue(undefined);
    const res = await queryCognitionGraphHandler(ctx({ at: 10 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'project_not_registered' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 8.1 Step 3 handlers（build_world_snapshot / query_chapter_summary /
// materialize_chapter_summary）。repo 全 mock；shared-contracts 纯函数
// （assembleChapterStateSummary / buildCognitionSnapshot / buildPresenceSignal）
// 真跑——组装/投影逻辑被真实 exercised（mirror 6.1 describe 哲学）。
// ════════════════════════════════════════════════════════════════════════════

describe('buildWorldSnapshotHandler (Story 8.1)', () => {
  beforeEach(() => {
    getProject.mockReset();
    buildWorldSnapshotCheckpointed.mockReset();
    listWorldPatches.mockReset();
    warn.mockReset();
  });

  it('state 投影（at 单点）：checkpoint-backed repo 调用 + snapshots 透传', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    buildWorldSnapshotCheckpointed.mockReturnValue({
      at: 100,
      subjects: [{ subjectId: 'erina', state: { hp: 70 }, issueCount: 0 }],
    });

    const res = await buildWorldSnapshotHandler(ctx({ at: 100, subjectCap: 5 }));

    expect(buildWorldSnapshotCheckpointed).toHaveBeenCalledWith('00001', 100, {
      subjectCap: 5,
      attrs: undefined,
    });
    expect(res.metadata).toMatchObject({ ok: true, projection: 'state', count: 1 });
    const snapshots = (res.metadata as { snapshots: unknown[] }).snapshots;
    expect(snapshots).toHaveLength(1);
    expect(res.output).toContain('erina');
  });

  it('state 投影（ats 批量）：per at 各一次 checkpoint-backed fold', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    buildWorldSnapshotCheckpointed.mockImplementation((_p: string, at: number | undefined) => ({
      at,
      subjects: [],
    }));

    const res = await buildWorldSnapshotHandler(ctx({ ats: [100, 200, 300] }));

    expect(buildWorldSnapshotCheckpointed).toHaveBeenCalledTimes(3);
    expect(res.metadata).toMatchObject({ ok: true, count: 3 });
  });

  it('state 投影（缺省 at）：单 snapshot 取最新', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    buildWorldSnapshotCheckpointed.mockReturnValue({ at: undefined, subjects: [] });

    const res = await buildWorldSnapshotHandler(ctx({}));

    expect(buildWorldSnapshotCheckpointed).toHaveBeenCalledWith('00001', undefined, {
      subjectCap: undefined,
      attrs: undefined,
    });
    expect(res.metadata).toMatchObject({ ok: true, count: 1 });
  });

  it('cognition 投影：SQL 侧 cognitive 轴预过滤（8.3 S5 / 6.4 E4）+ 真实 buildCognitionSnapshot 投影', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    listWorldPatches.mockReturnValue(makeCognitivePatches().filter((p) => p.storyTime <= 10));

    const res = await buildWorldSnapshotHandler(ctx({ projection: 'cognition', at: 10 }));

    // 轴收窄下推进 SQL（不再全轴取回后 TS filter）——cognition 只消费 cognitive 轴。
    expect(listWorldPatches).toHaveBeenCalledWith('00001', undefined, 10, 'cognitive');
    expect(res.metadata).toMatchObject({ ok: true, projection: 'cognition', at: 10, characterCount: 2 });
    expect(res.output).toContain('角色认知快照');
  });

  it('cognition 投影：无 cognitive patches → 友好空（never throws）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    listWorldPatches.mockReturnValue([]);

    const res = await buildWorldSnapshotHandler(ctx({ projection: 'cognition' }));

    expect(listWorldPatches).toHaveBeenCalledWith('00001', undefined, undefined, 'cognitive');
    expect(res.metadata).toMatchObject({ ok: true, projection: 'cognition', characterCount: 0, snapshot: null });
  });

  it('presence 投影：SQL 侧双轴 IN 预过滤（cognitive evidenceSceneId × physical presence 对拍）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    const patches: WorldPatch[] = [
      {
        id: 'p1', sliceId: 's1', subjectId: 'erina', path: '/knows/秘密', op: 'replace',
        value: true, axis: 'cognitive', source: 'derived', storyTime: 10, evidenceSceneId: 'scene-reveal',
      },
      {
        id: 'p2', sliceId: 's1', subjectId: 'erina', path: '/presence_scene', op: 'replace',
        value: 'scene-other', axis: 'physical', source: 'derived', storyTime: 5,
      },
    ];
    listWorldPatches.mockReturnValue(patches);

    const res = await buildWorldSnapshotHandler(ctx({ projection: 'presence' }));

    // presence 双轴同取（buildPresenceSignal 两轴都消费——单轴会断对拍臂）；IN 单次扫描。
    expect(listWorldPatches).toHaveBeenCalledWith('00001', undefined, undefined, ['cognitive', 'physical']);
    expect(res.metadata).toMatchObject({ ok: true, projection: 'presence', count: 1 });
    const signals = (res.metadata as { signals: Array<{ presenceSceneId: string }> }).signals;
    expect(signals[0].presenceSceneId).toBe('scene-other');
  });

  it('坏参（ats 超 32）→ invalid_params（zod .max 拒）', async () => {
    const res = await buildWorldSnapshotHandler(ctx({ ats: Array.from({ length: 33 }, (_, i) => i) }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
  });

  it('CR-2 ats 与 at 同传 → invalid_params（schema 互斥 refine——原同传静默取 at 吞批量请求）', async () => {
    const res = await buildWorldSnapshotHandler(ctx({ ats: [100, 200], at: 100 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
    expect(buildWorldSnapshotCheckpointed).not.toHaveBeenCalled();
  });

  it('项目未注册 → notRegistered（never throws）', async () => {
    getProject.mockReturnValue(undefined);
    const res = await buildWorldSnapshotHandler(ctx({ at: 100 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'project_not_registered' });
  });

  it('repo 抛 → friendly error metadata（never throws）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    buildWorldSnapshotCheckpointed.mockImplementation(() => {
      throw new Error('db locked');
    });
    const res = await buildWorldSnapshotHandler(ctx({ at: 100 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'snapshot_failed', error: 'db locked' });
  });
});

describe('queryChapterSummaryHandler (Story 8.1)', () => {
  beforeEach(() => {
    getProject.mockReset();
    listChapterSummaries.mockReset();
    warn.mockReset();
  });

  it('episodeIds 收窄：listChapterSummaries 透传 + markdown lines 输出 + summaries 透传', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    listChapterSummaries.mockReturnValue([
      {
        episodeId: 'ep-004',
        episodeIndex: 3,
        storyTimeEnd: 400,
        summary: {
          episodeId: 'ep-004', episodeIndex: 3, storyTimeStart: 400, storyTimeEnd: 400,
          characterEndStates: [{ subjectId: 'erina', type: 'character', state: { hp: 55 } }],
          oracleDormant: [], relationshipChanges: [], foreshadowChanges: [],
          newEntities: [], openPromises: [], nextChapterPayoffs: [],
          truncated: false,
        },
        tokenEstimate: 120,
        truncated: false,
        patchRowidHigh: 9,
        updatedAt: '2026-08-17',
      },
    ]);

    const res = await queryChapterSummaryHandler(ctx({ episodeIds: ['ep-004'] }));

    expect(listChapterSummaries).toHaveBeenCalledWith('00001', {
      episodeIds: ['ep-004'],
      fromIndex: undefined,
      toIndex: undefined,
    });
    expect(res.metadata).toMatchObject({ ok: true, count: 1 });
    expect(res.output).toContain('ep-004');
    expect(res.output).toContain('终态 1');
  });

  it('无收窄参数 → invalid_params（防倾倒，至少其一）', async () => {
    const res = await queryChapterSummaryHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
    expect(listChapterSummaries).not.toHaveBeenCalled();
  });

  it('CR-1 episodeIds 空数组 → invalid_params（schema .min(1) 拒——曾绕过收窄全表倾倒）', async () => {
    const res = await queryChapterSummaryHandler(ctx({ episodeIds: [] }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
    expect(listChapterSummaries).not.toHaveBeenCalled();
  });

  it('fromIndex 单给（不成对）→ invalid_params', async () => {
    const res = await queryChapterSummaryHandler(ctx({ fromIndex: 0 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
  });

  it('范围超 cap 50 → invalid_params（handler 收窄）', async () => {
    const res = await queryChapterSummaryHandler(ctx({ fromIndex: 0, toIndex: 50 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
  });

  it('fromIndex > toIndex → invalid_params', async () => {
    const res = await queryChapterSummaryHandler(ctx({ fromIndex: 5, toIndex: 3 }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
  });

  it('项目未注册 → notRegistered', async () => {
    getProject.mockReturnValue(undefined);
    const res = await queryChapterSummaryHandler(ctx({ episodeIds: ['ep-004'] }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'project_not_registered' });
  });

  it('repo 抛 → friendly error metadata（never throws）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    listChapterSummaries.mockImplementation(() => {
      throw new Error('db locked');
    });
    const res = await queryChapterSummaryHandler(ctx({ episodeIds: ['ep-004'] }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'list_failed', error: 'db locked' });
  });
});

// ── materialize fixture（4 章 patches + 2 promises + 3 beats，六字段全字段有数据）──

/** 合成 slice+patches fixture（ep-001..ep-004；ep-004 为物化目标章）。 */
function makeMaterializeSlices(): SliceWithPatches[] {
  return [
    {
      id: 'ep-001:100', projectId: '00001', storyTime: 100, title: '序章', episodeId: 'ep-001',
      patches: [
        { id: 'p1', sliceId: 'ep-001:100', subjectId: 'erina', path: '/hp', op: 'replace', value: 100, axis: 'physical', source: 'derived', storyTime: 100 },
        { id: 'p2', sliceId: 'ep-001:100', subjectId: 'old-mentor', path: '/location', op: 'replace', value: '塔顶', axis: 'physical', source: 'derived', storyTime: 100 },
      ],
    },
    {
      id: 'ep-002:200', projectId: '00001', storyTime: 200, title: '相遇', episodeId: 'ep-002',
      patches: [
        { id: 'p3', sliceId: 'ep-002:200', subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical', source: 'derived', storyTime: 200 },
        { id: 'p4', sliceId: 'ep-002:200', subjectId: 'erina', path: '/relations/kael', op: 'replace', value: '盟友', axis: 'relational', source: 'derived', storyTime: 200, summary: '并肩作战后信任加深' },
        { id: 'p5', sliceId: 'ep-002:200', subjectId: 'kael', path: '/knows/秘密', op: 'replace', value: true, axis: 'cognitive', source: 'derived', storyTime: 200 },
      ],
    },
    {
      id: 'ep-003:300', projectId: '00001', storyTime: 300, title: '密谋', episodeId: 'ep-003',
      patches: [
        { id: 'p6', sliceId: 'ep-003:300', subjectId: 'kael', path: '/suspects/erina', op: 'replace', value: '间谍', axis: 'cognitive', source: 'derived', storyTime: 300 },
      ],
    },
    {
      id: 'ep-004:400', projectId: '00001', storyTime: 400, title: '摊牌', episodeId: 'ep-004',
      patches: [
        { id: 'p7', sliceId: 'ep-004:400', subjectId: 'erina', path: '/hp', op: 'replace', value: 55, axis: 'physical', source: 'derived', storyTime: 400 },
        { id: 'p8', sliceId: 'ep-004:400', subjectId: 'erina', path: '/relations/kael', op: 'replace', value: '决裂', axis: 'relational', source: 'derived', storyTime: 400, summary: '摊牌后决裂' },
        { id: 'p9', sliceId: 'ep-004:400', subjectId: 'raven', path: '/hp', op: 'replace', value: 80, axis: 'physical', source: 'derived', storyTime: 400 },
      ],
    },
  ];
}

/** 最小合法 SceneNode（beat 场归属解析用；episodeId 直挂单章场）。 */
function makeSceneNode(id: string, episodeId: string, storyTime: number) {
  return { id, episodeId, storyTime, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal', lineTags: [] };
}

/** materialize fixture 的 loadProject 返回 doc（outlines + promise_registry + scene_graph）。 */
function makeMaterializeDoc(): Record<string, unknown> {
  return {
    episode_outlines: [
      { id: 'ep-001', index: 0, title: '序章' },
      { id: 'ep-002', index: 1, title: '相遇' },
      { id: 'ep-003', index: 2, title: '密谋' },
      { id: 'ep-004', index: 3, title: '摊牌' },
      { id: 'ep-005', index: 4, title: '决战' },
    ],
    promise_registry: {
      promises: [
        { id: 'pm-1', title: '身世之谜', summary: '主角身世待揭', status: 'open', deadlineEpisodeId: 'ep-005' },
        { id: 'pm-2', title: '旧剑来历', summary: '旧剑的来历', status: 'open' },
      ],
      beats: [
        // 无显式 episodeId——场归属解析（sc-1 挂 ep-001）→ min-index 0（before + through）。
        { id: 'b-1', promiseId: 'pm-2', sceneRef: 'sc-1', kind: 'plant' },
        // 本章 beat（sc-4 挂 ep-004，场归属路径）。
        { id: 'b-2', promiseId: 'pm-1', sceneRef: 'sc-4', kind: 'advance' },
        // 下一章 beat（显式 episodeId 路径）。
        { id: 'b-3', promiseId: 'pm-2', sceneRef: 'sc-5', episodeId: 'ep-005', kind: 'payoff' },
      ],
    },
    scene_graph: {
      nodes: [
        makeSceneNode('sc-1', 'ep-001', 100),
        makeSceneNode('sc-2', 'ep-002', 200),
        makeSceneNode('sc-3', 'ep-003', 300),
        makeSceneNode('sc-4', 'ep-004', 400),
        makeSceneNode('sc-5', 'ep-005', 500),
      ],
    },
  };
}

/** materialize fixture 的 subjects / folds / checkpoint mocks 一并设置。 */
function setupMaterializeMocks(doc: Record<string, unknown> | null) {
  loadProject.mockReturnValue(doc);
  listWorldSlices.mockReturnValue(makeMaterializeSlices());
  listWorldSubjects.mockReturnValue([
    { id: 'erina', type: 'character', name: '艾莉娜', firstSeenStoryTime: 100 },
    { id: 'old-mentor', type: 'character', name: '导师', firstSeenStoryTime: 100 },
    { id: 'kael', type: 'character', name: '凯尔', firstSeenStoryTime: 200 },
    { id: 'raven', type: 'character', name: '渡鸦', firstSeenStoryTime: 400 },
  ]);
  reduceWorldSubjectCheckpointed.mockImplementation(
    (_p: string, subjectId: string) => {
      if (subjectId === 'erina') {
        // hit + 折叠增量 30 ≥ 25 → 阈值推进路径（CR-10：命中点累计基数 4 → 推进行 patchCountFolded=34）。
        return {
          state: { hp: 55, relations: { kael: '决裂' } }, issues: [], issueCount: 0,
          patchesFolded: 30, checkpointHit: true,
          hitAtStoryTime: 200, hitPatchCountFolded: 4,
        };
      }
      if (subjectId === 'kael') {
        return {
          state: { knows: { 秘密: true }, suspects: { erina: '间谍' } }, issues: [], issueCount: 0,
          patchesFolded: 2, checkpointHit: false,
        };
      }
      return { state: { hp: 80 }, issues: [], issueCount: 0, patchesFolded: 1, checkpointHit: false };
    },
  );
  getWorldPatchRowidHigh.mockReturnValue(99);
  upsertChapterSummaryWithCheckpoints.mockReset();
}

describe('materializeChapterSummaryHandler (Story 8.1)', () => {
  beforeEach(() => {
    getProject.mockReset();
    loadProject.mockReset();
    listWorldSlices.mockReset();
    listWorldSubjects.mockReset();
    reduceWorldSubjectCheckpointed.mockReset();
    getLatestWorldCheckpoint.mockReset();
    getWorldPatchRowidHigh.mockReset();
    upsertChapterSummaryWithCheckpoints.mockReset();
    warn.mockReset();
  });

  it('全六字段内容断言（①cast+①b dormant+②关系+③伏笔+④新实体+⑤未决+⑥下章回收）+ 机会式 checkpoint', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    setupMaterializeMocks(makeMaterializeDoc());

    const res = await materializeChapterSummaryHandler(ctx({ episodeId: 'ep-004' }));

    expect(res.metadata).toMatchObject({ ok: true, episodeId: 'ep-004', truncated: false });
    const summary = (res.metadata as { summary: Record<string, unknown> }).summary;

    // 窗 + index。
    expect(summary.episodeIndex).toBe(3);
    expect(summary.storyTimeStart).toBe(400);
    expect(summary.storyTimeEnd).toBe(400);

    // ① 角色终态：活跃 cast = erina(3)/raven(3)/kael(2)（old-mentor idx 0 < n-2=1 不进）。
    const cast = summary.characterEndStates as Array<{ subjectId: string; state: Record<string, unknown> }>;
    expect(cast.map((c) => c.subjectId).sort()).toEqual(['erina', 'kael', 'raven']);
    const erinaEnd = cast.find((c) => c.subjectId === 'erina');
    expect(erinaEnd?.state.hp).toBe(55);

    // ①b dormant：old-mentor 连续 3 章无 patch → 标记 + 回溯锚。
    const dormant = summary.oracleDormant as Array<{ subjectId: string; lastChangedEpisodeId?: string }>;
    expect(dormant).toHaveLength(1);
    expect(dormant[0]).toMatchObject({ subjectId: 'old-mentor', lastChangedEpisodeId: 'ep-001' });

    // ② 关系温度变化：本章 relational patch（ep-004 决裂）。
    const rel = summary.relationshipChanges as Array<{ summary?: string; storyTime: number }>;
    expect(rel).toHaveLength(1);
    expect(rel[0].summary).toBe('摊牌后决裂');
    expect(rel[0].storyTime).toBe(400);

    // ③ 伏笔状态变更：本章 beat b-2（pm-1 advance）from=unplanted → to=echoed。
    const fore = summary.foreshadowChanges as Array<{
      promiseId: string; beatKind: string; sceneRef: string;
      stageChange: { from: string; to: string };
    }>;
    expect(fore).toHaveLength(1);
    expect(fore[0]).toMatchObject({
      promiseId: 'pm-1', beatKind: 'advance', sceneRef: 'sc-4',
      stageChange: { from: 'unplanted', to: 'echoed' },
    });

    // ④ 新引入实体：raven firstSeen 400 ∈ 本章窗。
    const news = summary.newEntities as Array<{ subjectId: string }>;
    expect(news.map((n) => n.subjectId)).toEqual(['raven']);

    // ⑤ 未决承诺：pm-1(echoed, deadline) + pm-2(planted)。
    const open = summary.openPromises as Array<{ promiseId: string; stage: string }>;
    expect(open).toHaveLength(2);
    const pm1 = open.find((o) => o.promiseId === 'pm-1');
    expect(pm1).toMatchObject({ stage: 'echoed' });
    expect((pm1 as { deadlineEpisodeId?: string }).deadlineEpisodeId).toBe('ep-005');

    // ⑥ 下章回收：b-3 落 ep-005（pm-2）+ pm-1 deadline 到期。
    const next = summary.nextChapterPayoffs as Array<{ promiseId: string; note?: string }>;
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ promiseId: 'pm-2' });
    expect(next[1]).toMatchObject({ promiseId: 'pm-1', note: 'deadline 到期' });

    // 落盘：单 WAL 事务 upsert（summary + 机会式 checkpoint 批）。
    expect(upsertChapterSummaryWithCheckpoints).toHaveBeenCalledTimes(1);
    const [pid, row, checkpoints] = upsertChapterSummaryWithCheckpoints.mock.calls[0];
    expect(pid).toBe('00001');
    expect(row.episodeId).toBe('ep-004');
    expect(row.episodeIndex).toBe(3);
    expect(row.truncated).toBe(false);
    expect(row.patchRowidHigh).toBe(99);
    // 机会式 checkpoint：erina hit + 增量 30 ≥ 25 → 推进至本章末（唯一 advance 行）。CR-10：
    // patchCountFolded = 命中点基数（hitPatchCountFolded 4）+ 本窗 30 = 34（自命中点累计，非 latest 重查）。
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      subjectId: 'erina', atStoryTime: 400, patchRowidHigh: 99, patchCountFolded: 34,
    });
    // checkpointCount = 1 推进 + 2 lazy 首建（kael/raven miss 路径）。
    expect(res.metadata).toMatchObject({ checkpointCount: 3 });
    expect(res.output).toContain('ep-004');
  });

  it('CR-4 as-of-N 截断：物化 ep-001 时 ep-002+ 的未来章 slices 不进本章活动归类（backfill/非线性写作序）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    setupMaterializeMocks(makeMaterializeDoc());

    const res = await materializeChapterSummaryHandler(ctx({ episodeId: 'ep-001' }));

    expect(res.metadata).toMatchObject({ ok: true, episodeId: 'ep-001' });
    const summary = (res.metadata as { summary: Record<string, unknown> }).summary;

    // n=0：cast 只含 ep-001 内有 patch 的 subjects（erina/old-mentor）——kael（ep-002/3 活跃）与
    // raven（ep-004 登场）是「未来章」数据，不得进本章视角的活动/dormancy 判定。
    expect(summary.episodeIndex).toBe(0);
    expect(summary.storyTimeStart).toBe(100);
    expect(summary.storyTimeEnd).toBe(100);
    const cast = summary.characterEndStates as Array<{ subjectId: string }>;
    expect(cast.map((c) => c.subjectId).sort()).toEqual(['erina', 'old-mentor']);
    expect(summary.oracleDormant).toEqual([]); // 无「曾出场且 3 章未动」的过去史
    // ④ 新实体：firstSeen ∈ [100,100]——erina/old-mentor；raven（400）是未来登场不进。
    const news = summary.newEntities as Array<{ subjectId: string }>;
    expect(news.map((s) => s.subjectId).sort()).toEqual(['erina', 'old-mentor']);
    // ② ep-001 无 relational patch → 空。
    expect(summary.relationshipChanges).toEqual([]);
  });

  it('幂等：同 episodeId 二次调用 upsert 覆盖（不累积）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    setupMaterializeMocks(makeMaterializeDoc());

    await materializeChapterSummaryHandler(ctx({ episodeId: 'ep-004' }));
    await materializeChapterSummaryHandler(ctx({ episodeId: 'ep-004' }));

    expect(upsertChapterSummaryWithCheckpoints).toHaveBeenCalledTimes(2);
    const first = upsertChapterSummaryWithCheckpoints.mock.calls[0][1];
    const second = upsertChapterSummaryWithCheckpoints.mock.calls[1][1];
    expect(second.episodeId).toBe('ep-004');
    // 同 episode 重物化 = last-wins 覆盖（row 形态不变，无第二行）。
    expect(second.episodeIndex).toBe(first.episodeIndex);
  });

  it('缺 promise_registry → degradedNote + ③⑤⑥ 空（design §5 缺源 graceful）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    const doc = makeMaterializeDoc();
    delete doc.promise_registry;
    setupMaterializeMocks(doc);

    const res = await materializeChapterSummaryHandler(ctx({ episodeId: 'ep-004' }));

    expect(res.metadata).toMatchObject({ ok: true });
    const summary = (res.metadata as { summary: Record<string, unknown> }).summary;
    expect(summary.degradedNote).toContain('promise_registry');
    expect(summary.foreshadowChanges).toEqual([]);
    expect(summary.openPromises).toEqual([]);
    expect(summary.nextChapterPayoffs).toEqual([]);
    // db 侧字段照常（①②④ 不受 yaml 缺源影响）。
    expect((summary.characterEndStates as unknown[]).length).toBe(3);
    expect((summary.relationshipChanges as unknown[]).length).toBe(1);
  });

  it('episode_outlines 缺 → episodeIndex null 降级（cast 判定降级，本章触及者仍携终态）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    const doc = makeMaterializeDoc();
    delete doc.episode_outlines;
    setupMaterializeMocks(doc);

    const res = await materializeChapterSummaryHandler(ctx({ episodeId: 'ep-004' }));

    expect(res.metadata).toMatchObject({ ok: true });
    const summary = (res.metadata as { summary: Record<string, unknown> }).summary;
    expect(summary.episodeIndex).toBeNull();
    // n null：cast 降级 = 仅本章触及者（erina/raven）携终态，不标 dormant。
    const cast = summary.characterEndStates as Array<{ subjectId: string }>;
    expect(cast.map((c) => c.subjectId).sort()).toEqual(['erina', 'raven']);
    expect(summary.oracleDormant).toEqual([]);
    // ⑤ 派生态 stage 窗不可判 → pm 未兑现照列（stage unplanted，不假 paid_off）。
    const open = summary.openPromises as Array<{ promiseId: string }>;
    expect(open.map((o) => o.promiseId).sort()).toEqual(['pm-1', 'pm-2']);
  });

  it('坏参（缺 episodeId）→ invalid_params', async () => {
    const res = await materializeChapterSummaryHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
  });

  it('项目未注册 → notRegistered（never throws）', async () => {
    getProject.mockReturnValue(undefined);
    const res = await materializeChapterSummaryHandler(ctx({ episodeId: 'ep-004' }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'project_not_registered' });
    expect(upsertChapterSummaryWithCheckpoints).not.toHaveBeenCalled();
  });

  it('repo 抛 → friendly error metadata（never throws，不落盘）', async () => {
    getProject.mockReturnValue({ projectId: '00001' });
    setupMaterializeMocks(makeMaterializeDoc());
    listWorldSlices.mockImplementation(() => {
      throw new Error('db locked');
    });

    const res = await materializeChapterSummaryHandler(ctx({ episodeId: 'ep-004' }));

    expect(res.metadata).toMatchObject({ ok: false, reason: 'materialize_failed', error: 'db locked' });
    expect(upsertChapterSummaryWithCheckpoints).not.toHaveBeenCalled();
  });
});
