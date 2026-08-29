import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  buildWorldStateSnapshot,
  buildCognitionSnapshot,
  buildPresenceSignal,
  episodeOutlineSchema,
  sceneNodeSchema,
  type SceneGraph,
  type WorldPatch,
} from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.1 Step 5：fetch 切换等价性测试（本 story 最高风险防线——fetch 切换静默变语义 = B01 类断链）。
//
// 等价断言两侧走**不同代码路径**（同一 synthetic patches 喂两侧）：
// - 左（新 IPC 路径）：registry 注册 mock build_world_snapshot（metadata 形态 mirror Step 3
//   buildWorldSnapshotHandler 实产）→ fetch*ViaTool 新 helper 的 IPC 抽取层。mock 的 snapshot 值由
//   shared 纯函数构造（buildWorldStateSnapshot 等）——模拟 shell handler checkpoint-backed 输出；
//   「checkpointed fold ≡ 纯函数全 fold」由 Step 2 shell repository 测试锚定，此处验证 fetch 契约层。
// - 右（旧路径基准）：registry 仅注册 query_world_slice → 新 helper 的 fallback 分支（= 8.1 前旧代码的
//   逐字保留）+ shared 纯函数本地 fold。
//
// 覆盖矩阵（patch 形态 × 路径）：
// - state 投影：replace / increment / list append（重复值保留——无 kindResolver 即 list 语义）/
//   remove / amendment 同 storyTime 覆盖 / relational / cognitive / 3 subjects / 多 storyTime 截断
//   （早期空 / 中段 / 全量 / 超出）。
// - cognition 投影：多角色 first-seen 序 / 无 cognitive patches → undefined。
// - presence 投影：evidenceSceneId ≠ presence_scene 信号 / 无可疑 → undefined。
// - graceful：工具抛错 / ok:false / 坏 metadata；fallback 模式（build_world_snapshot 未注册）。
// - 批量：ats 去重对齐 / 超 BUILD_WORLD_SNAPSHOT_ATS_MAX(32) 分批 / brief-compiler 同 storyTime 场共享引用。
// ─────────────────────────────────────────────────────────────────────────────

// mock registry（mirror brief-compiler-stateAtT.test.ts 模式）：mockGet 控制工具可见性。
let mockGet: ((id: string) => unknown) | undefined;
vi.mock('../src/tool/registry', () => ({
  registry: {
    get: (id: string) => mockGet?.(id),
  },
}));

import {
  fetchWorldPatchesViaTool,
  fetchWorldStateSnapshotsViaTool,
  fetchWorldStateSnapshotViaTool,
  fetchCognitionSnapshotViaTool,
  fetchPresenceSignalViaTool,
} from '../src/nodes/world-state-query';
import { createBriefCompilerNode } from '../src/nodes/brief-compiler-node';
import type { RunSnapshot } from '../src/contracts/run';

// ── synthetic patches（3 subjects / storyTime 5-15 / 含 amendment / list append / increment）──

function basePatches(): WorldPatch[] {
  return [
    // erina（subject 1）：scalar replace + list（array replace 建基准 + append 重复值）+ remove + increment。
    { id: 'p1', sliceId: 'sl1', subjectId: 'erina', path: '/hp', op: 'replace', value: 100, axis: 'physical', source: 'derived', storyTime: 5 },
    { id: 'p1b', sliceId: 'sl2', subjectId: 'erina', path: '/inventory', op: 'replace', value: [], axis: 'physical', source: 'derived', storyTime: 7 },
    { id: 'p2', sliceId: 'sl2', subjectId: 'erina', path: '/inventory', op: 'append', value: '地图', axis: 'physical', source: 'derived', storyTime: 8 },
    { id: 'p3', sliceId: 'sl2', subjectId: 'erina', path: '/inventory', op: 'append', value: '地图', axis: 'physical', source: 'derived', storyTime: 9 },
    { id: 'p4', sliceId: 'sl2', subjectId: 'erina', path: '/scout_badge', op: 'replace', value: true, axis: 'physical', source: 'derived', storyTime: 9 },
    { id: 'p5', sliceId: 'sl3', subjectId: 'erina', path: '/scout_badge', op: 'remove', axis: 'physical', source: 'derived', storyTime: 12 },
    { id: 'p6', sliceId: 'sl3', subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical', source: 'derived', storyTime: 15 },
    // crow（subject 2）：cognitive evidenceSceneId ≠ presence_scene（presence 信号源）。
    { id: 'p7', sliceId: 'sl4', subjectId: 'crow', path: '/presence_scene', op: 'replace', value: 'sceneB', axis: 'physical', source: 'derived', storyTime: 5 },
    { id: 'p8', sliceId: 'sl4', subjectId: 'crow', path: '/knows/秘密', op: 'replace', value: true, axis: 'cognitive', source: 'derived', storyTime: 6, evidenceSceneId: 'sceneA' },
    // rin（subject 3）：relational + amendment 同 storyTime 覆盖（derived 40 → amendment 70）。
    { id: 'p9', sliceId: 'sl5', subjectId: 'rin', path: '/trust/erina', op: 'replace', value: 40, axis: 'relational', source: 'derived', storyTime: 10 },
    { id: 'p10', sliceId: 'sl5', subjectId: 'rin', path: '/trust/erina', op: 'replace', value: 70, axis: 'relational', source: 'amendment', storyTime: 10 },
    // erina cognitive：evidenceSceneId == presence_scene（不产 presence 信号）。
    { id: 'p11', sliceId: 'sl6', subjectId: 'erina', path: '/knows/密道', op: 'replace', value: true, axis: 'cognitive', source: 'derived', storyTime: 11, evidenceSceneId: 'sceneC' },
    { id: 'p12', sliceId: 'sl6', subjectId: 'erina', path: '/presence_scene', op: 'replace', value: 'sceneC', axis: 'physical', source: 'derived', storyTime: 11 },
  ];
}

/** 无 cognitive patches 的 fixture（cognition/presence 空数据 graceful 用）。 */
function physicalOnlyPatches(): WorldPatch[] {
  return [
    { id: 'q1', sliceId: 'slq', subjectId: 'erina', path: '/hp', op: 'replace', value: 100, axis: 'physical', source: 'derived', storyTime: 5 },
  ];
}

// ── mock 工具（metadata 形态 mirror Step 3 worldStateHandlers 实产）──

/** mock query_world_slice（旧路径基准）：execute 返 slices[{patches}]（fetchWorldPatchesViaTool 消费形态）。 */
function mockQueryWorldSlice(patches: WorldPatch[]): unknown {
  return {
    execute: async () => ({
      title: 'query_world_slice',
      output: '',
      metadata: { ok: true, count: 1, slices: [{ patches }] },
    }),
  };
}

/** mock build_world_snapshot state 投影：按请求 ats（或单点 at/缺省最新）用 shared 纯函数构造 snapshots
 *  （模拟 shell handler checkpoint-backed 输出）。记录收到的 params 供透传断言。 */
function mockBuildWorldSnapshotState(
  patches: WorldPatch[],
  onParams?: (params: Record<string, unknown>) => void,
): unknown {
  return {
    execute: async (params: Record<string, unknown>) => {
      onParams?.(params);
      const ats: Array<number | undefined> = Array.isArray(params.ats)
        ? (params.ats as number[])
        : params.at !== undefined
          ? [params.at as number]
          : [undefined];
      const snapshots = ats.map((at) =>
        buildWorldStateSnapshot(patches, at, {
          ...(typeof params.subjectCap === 'number' ? { subjectCap: params.subjectCap } : {}),
          ...(Array.isArray(params.attrs) ? { attrs: params.attrs as string[] } : {}),
        }),
      );
      return {
        title: 'build_world_snapshot',
        output: '',
        metadata: { ok: true, projection: 'state', count: snapshots.length, snapshots },
      };
    },
  };
}

/** mock build_world_snapshot cognition 投影（mirror handler：空数据 snapshot:null）。 */
function mockBuildWorldSnapshotCognition(patches: WorldPatch[]): unknown {
  return {
    execute: async () => {
      const snapshot = buildCognitionSnapshot(patches);
      return {
        title: 'build_world_snapshot (cognition)',
        output: '',
        metadata: {
          ok: true,
          projection: 'cognition',
          at: null,
          characterCount: snapshot?.characters.length ?? 0,
          snapshot: snapshot ?? null,
        },
      };
    },
  };
}

/** mock build_world_snapshot presence 投影（mirror handler：signals 数组可空）。 */
function mockBuildWorldSnapshotPresence(patches: WorldPatch[]): unknown {
  return {
    execute: async () => {
      const signals = buildPresenceSignal(patches);
      return {
        title: 'build_world_snapshot (presence)',
        output: '',
        metadata: { ok: true, projection: 'presence', at: null, count: signals.length, signals },
      };
    },
  };
}

/** 旧路径基准归一：snapshot subjects 空 → undefined（mirror compileSceneStateAtT 语义）。 */
function normalizeSnapshot(snapshot: ReturnType<typeof buildWorldStateSnapshot>) {
  return snapshot.subjects.length > 0 ? snapshot : undefined;
}

beforeEach(() => {
  mockGet = undefined; // 默认全未注册（graceful 路径）。
});

// ── state 投影：批量 ats ──

describe('fetchWorldStateSnapshotsViaTool（批量 state 投影）等价性', () => {
  it('新 IPC 路径 ≡ 旧路径基准（fetchWorldPatchesViaTool 全集 + 本地 fold），多截断点含空 subjects', async () => {
    const patches = basePatches();
    const ats = [1, 5, 10, 15, 100]; // 1 = 早期无数据（→undefined）；100 = 超出全量。

    // 左：新 IPC 路径（build_world_snapshot 注册）。
    let received: Record<string, unknown> | undefined;
    mockGet = (id) =>
      id === 'build_world_snapshot' ? mockBuildWorldSnapshotState(patches, (p) => { received = p; }) : undefined;
    const left = await fetchWorldStateSnapshotsViaTool('/test', ats);

    // 右：旧路径基准——fallback 分支（= 8.1 前旧代码逐字保留）。
    mockGet = (id) => (id === 'query_world_slice' ? mockQueryWorldSlice(patches) : undefined);
    const right = await fetchWorldStateSnapshotsViaTool('/test', ats);

    // 右侧再独立对齐 shared 纯函数直算（三方一致）。
    const pure = ats.map((at) => normalizeSnapshot(buildWorldStateSnapshot(patches, at)));

    expect(left).toEqual(right);
    expect(left).toEqual(pure);
    // 形态：与 ats 等长对齐；早期截断点归一 undefined；非空项 snapshot 非空。
    expect(left).toHaveLength(ats.length);
    expect(left![0]).toBeUndefined(); // at=1 无数据 → undefined（旧语义保持）。
    expect(left![1]!.subjects.length).toBeGreaterThan(0);

    // 透传断言：单请求批量 ats + state 投影；未传 opts 无 subjectCap/attrs 键。
    expect(received).toMatchObject({ projection: 'state' });
    expect(received!.ats).toEqual(ats);
    expect('subjectCap' in received!).toBe(false);
    expect('attrs' in received!).toBe(false);
  });

  it('fixture fold 语义锚：increment / list append 重复保留 / remove / amendment 覆盖全生效', async () => {
    const patches = basePatches();
    const snapshots = await (async () => {
      mockGet = (id) =>
        id === 'build_world_snapshot' ? mockBuildWorldSnapshotState(patches) : undefined;
      return fetchWorldStateSnapshotsViaTool('/test', [100]);
    })();
    const state = snapshots![0]!;
    const byId = Object.fromEntries(state.subjects.map((s) => [s.subjectId, s.state]));

    // erina @100：hp=100-30=70；inventory 重复 append 保留两条（无 kindResolver = list 语义）；badge 已 remove。
    expect((byId.erina as Record<string, unknown>).hp).toBe(70);
    expect((byId.erina as Record<string, unknown>).inventory).toEqual(['地图', '地图']);
    expect('scout_badge' in (byId.erina as Record<string, unknown>)).toBe(false);
    // rin @100：同 storyTime amendment 后叠 → trust.erina=70（嵌套 pointer，非 derived 的 40）。
    expect((byId.rin as Record<string, { erina?: unknown }>).trust?.erina).toBe(70);
  });

  it('subjectCap/attrs 透传两侧等价', async () => {
    const patches = basePatches();
    const opts = { subjectCap: 2, attrs: ['hp', 'knows'] };

    mockGet = (id) => (id === 'build_world_snapshot' ? mockBuildWorldSnapshotState(patches) : undefined);
    const left = await fetchWorldStateSnapshotsViaTool('/test', [100], opts);

    mockGet = (id) => (id === 'query_world_slice' ? mockQueryWorldSlice(patches) : undefined);
    const right = await fetchWorldStateSnapshotsViaTool('/test', [100], opts);

    expect(left).toEqual(right);
    // cap=2：first-seen 序 erina/crow 截断（rin 不入）；attrs 顶层投影只剩 hp/knows 键。
    const subjects = left![0]!.subjects.map((s) => s.subjectId);
    expect(subjects).toEqual(['erina', 'crow']);
    const erinaState = left![0]!.subjects[0]!.state as Record<string, unknown>;
    expect(Object.keys(erinaState).sort()).toEqual(['hp', 'knows']);
    expect(erinaState.hp).toBe(70);
  });

  it('ats 超 32 自动分批（每请求 ≤ BUILD_WORLD_SNAPSHOT_ATS_MAX，结果等长对齐且等价）', async () => {
    const patches = basePatches();
    const ats = Array.from({ length: 40 }, (_, i) => i + 1);
    const receivedAts: number[][] = [];
    mockGet = (id) =>
      id === 'build_world_snapshot'
        ? mockBuildWorldSnapshotState(patches, (p) => receivedAts.push(p.ats as number[]))
        : undefined;
    const left = await fetchWorldStateSnapshotsViaTool('/test', ats);

    // 40 ats → 32 + 8 两批。
    expect(receivedAts.map((a) => a.length)).toEqual([32, 8]);
    expect(left).toHaveLength(40);
    // 与本地纯函数全量对齐（分批不丢不错位）。
    expect(left).toEqual(ats.map((at) => normalizeSnapshot(buildWorldStateSnapshot(patches, at))));
  });

  it('ats 空 → 返 [] 不发 IPC', async () => {
    let called = 0;
    mockGet = () => ({
      execute: async () => {
        called += 1;
        return { metadata: { ok: true, snapshots: [] } };
      },
    });
    const result = await fetchWorldStateSnapshotsViaTool('/test', []);
    expect(result).toEqual([]);
    expect(called).toBe(0);
  });

  it('fallback 模式（build_world_snapshot 未注册 + query_world_slice 注册）= 旧全 fold 行为（既有测试兼容锚）', async () => {
    const patches = basePatches();
    mockGet = (id) => (id === 'query_world_slice' ? mockQueryWorldSlice(patches) : undefined);
    const result = await fetchWorldStateSnapshotsViaTool('/test', [5, 15]);
    expect(result).toEqual([5, 15].map((at) => normalizeSnapshot(buildWorldStateSnapshot(patches, at))));
  });

  it('graceful：execute 抛错 / ok:false / 坏 metadata → undefined', async () => {
    mockGet = () => ({
      execute: async () => { throw new Error('IPC failed'); },
    });
    expect(await fetchWorldStateSnapshotsViaTool('/test', [10])).toBeUndefined();

    mockGet = () => ({
      execute: async () => ({ metadata: { ok: false, reason: 'project_not_registered' } }),
    });
    expect(await fetchWorldStateSnapshotsViaTool('/test', [10])).toBeUndefined();

    mockGet = () => ({
      execute: async () => ({ metadata: { ok: true } }), // snapshots 缺 → 全项 undefined（不崩不错位）
    });
    expect(await fetchWorldStateSnapshotsViaTool('/test', [10])).toEqual([undefined]);
  });
});

// ── state 投影：单点（Reader-Audit 基底，签名与返回契约零变）──

describe('fetchWorldStateSnapshotViaTool（单点 state 投影）等价性', () => {
  it.each([
    { label: 'at 指定（中段截断）', at: 10 },
    { label: 'at 缺省（最新全叠加）', at: undefined },
    { label: '早期 at（subjects 空 → undefined）', at: 1 },
  ])('$label：新 IPC 路径 ≡ 旧路径基准', async ({ at }) => {
    const patches = basePatches();

    mockGet = (id) => (id === 'build_world_snapshot' ? mockBuildWorldSnapshotState(patches) : undefined);
    const left = await fetchWorldStateSnapshotViaTool('/test', at);

    mockGet = (id) => (id === 'query_world_slice' ? mockQueryWorldSlice(patches) : undefined);
    const right = await fetchWorldStateSnapshotViaTool('/test', at);

    expect(left).toEqual(right);
    expect(left).toEqual(normalizeSnapshot(buildWorldStateSnapshot(patches, at)));
  });

  it('调用方契约零变：签名 (projectPath, at?, opts?) 保持（write-chapter.ts 零改）', async () => {
    // 编译期签名由 typecheck 保证；此处运行时验证 at=undefined 缺省参数路径可调。
    const patches = basePatches();
    mockGet = (id) => (id === 'build_world_snapshot' ? mockBuildWorldSnapshotState(patches) : undefined);
    const snapshot = await fetchWorldStateSnapshotViaTool('/test');
    expect(snapshot!.subjects.length).toBe(3); // 3 subjects 全量。
  });
});

// ── cognition 投影（6.2 数据源）──

describe('fetchCognitionSnapshotViaTool（cognition 投影）等价性', () => {
  it('新 projection 路径 ≡ 旧 fetch+buildCognitionSnapshot 路径（多角色 first-seen 序）', async () => {
    const patches = basePatches();

    mockGet = (id) => (id === 'build_world_snapshot' ? mockBuildWorldSnapshotCognition(patches) : undefined);
    const left = await fetchCognitionSnapshotViaTool('/test');

    mockGet = (id) => (id === 'query_world_slice' ? mockQueryWorldSlice(patches) : undefined);
    const right = await fetchCognitionSnapshotViaTool('/test');

    expect(left).toEqual(right);
    // fixture 锚：crow（st6 首见）先于 erina（st11）。
    expect(left!.characters.map((c) => c.characterSubjectId)).toEqual(['crow', 'erina']);
  });

  it('无 cognitive patches → 两侧均 undefined（handler snapshot:null 归一 + 纯函数 undefined）', async () => {
    const patches = physicalOnlyPatches();

    mockGet = (id) => (id === 'build_world_snapshot' ? mockBuildWorldSnapshotCognition(patches) : undefined);
    expect(await fetchCognitionSnapshotViaTool('/test')).toBeUndefined();

    mockGet = (id) => (id === 'query_world_slice' ? mockQueryWorldSlice(patches) : undefined);
    expect(await fetchCognitionSnapshotViaTool('/test')).toBeUndefined();
  });
});

// ── presence 投影（6.4 D1 数据源）──

describe('fetchPresenceSignalViaTool（presence 投影）等价性', () => {
  it('新 projection 路径 ≡ 旧 fetch+buildPresenceSignal 路径（evidence ≠ presence 产信号）', async () => {
    const patches = basePatches();

    mockGet = (id) => (id === 'build_world_snapshot' ? mockBuildWorldSnapshotPresence(patches) : undefined);
    const left = await fetchPresenceSignalViaTool('/test');

    mockGet = (id) => (id === 'query_world_slice' ? mockQueryWorldSlice(patches) : undefined);
    const right = await fetchPresenceSignalViaTool('/test');

    expect(left).toEqual(right);
    // fixture 锚：仅 crow 产信号（presence sceneB ≠ evidence sceneA）；erina sceneC == sceneC 无信号。
    expect(left).toHaveLength(1);
    expect(left![0]).toMatchObject({
      characterSubjectId: 'crow',
      evidenceSceneId: 'sceneA',
      presenceSceneId: 'sceneB',
    });
  });

  it('无可疑信号 → 两侧均 undefined（空数组归一）', async () => {
    // 只有 erina 的 evidence == presence（不产信号）→ signals 空。
    const patches = basePatches().filter((p) => p.subjectId !== 'crow');
    mockGet = (id) => (id === 'build_world_snapshot' ? mockBuildWorldSnapshotPresence(patches) : undefined);
    expect(await fetchPresenceSignalViaTool('/test')).toBeUndefined();

    mockGet = (id) => (id === 'query_world_slice' ? mockQueryWorldSlice(patches) : undefined);
    expect(await fetchPresenceSignalViaTool('/test')).toBeUndefined();
  });

  it('CR-9 逐元素 shape 守卫：坏元素丢弃、好元素保留（与 state/cognition 守卫族对齐）；全坏 → undefined', async () => {
    const good = buildPresenceSignal(basePatches())[0]!;
    mockGet = () => ({
      execute: async () => ({
        title: 'build_world_snapshot (presence)',
        output: '',
        metadata: {
          ok: true,
          projection: 'presence',
          at: null,
          count: 4,
          // IPC 边界坏形态：缺关键标量字段的条目 / null / 字符串混入 signals 数组。
          signals: [{ junk: true }, null, 'x', { ...good, factPath: 42 }, good],
        },
      }),
    });

    const res = await fetchPresenceSignalViaTool('/test');
    expect(res).toEqual([good]); // 坏元素丢弃，好元素原样保留

    mockGet = () => ({
      execute: async () => ({
        title: 'build_world_snapshot (presence)',
        output: '',
        metadata: { ok: true, projection: 'presence', at: null, count: 1, signals: [{ junk: true }] },
      }),
    });
    expect(await fetchPresenceSignalViaTool('/test')).toBeUndefined(); // 全坏 → undefined（不注入假数据）
  });
});

// ── cognition/presence graceful（mirror state 投影三态）──

describe('cognition/presence 投影 graceful', () => {
  it('工具注册但 execute 抛错 → undefined（不崩链）', async () => {
    mockGet = () => ({
      execute: async () => { throw new Error('IPC failed'); },
    });
    expect(await fetchCognitionSnapshotViaTool('/test')).toBeUndefined();
    expect(await fetchPresenceSignalViaTool('/test')).toBeUndefined();
  });

  it('ok:false（project 未注册）→ undefined', async () => {
    mockGet = () => ({
      execute: async () => ({ metadata: { ok: false, reason: 'project_not_registered' } }),
    });
    expect(await fetchCognitionSnapshotViaTool('/test')).toBeUndefined();
    expect(await fetchPresenceSignalViaTool('/test')).toBeUndefined();
  });

  it('全工具未注册（registry 空）→ undefined', async () => {
    mockGet = () => undefined;
    expect(await fetchWorldStateSnapshotViaTool('/test')).toBeUndefined();
    expect(await fetchCognitionSnapshotViaTool('/test')).toBeUndefined();
    expect(await fetchPresenceSignalViaTool('/test')).toBeUndefined();
  });
});

// ── 旧路径基准前提（fallback 与纯函数基准共用的取数源）──

describe('fetchWorldPatchesViaTool（保留：fallback 基准 + 全 patches 消费者）', () => {
  it('旧路径基准前提：query_world_slice 注册 → 返回 fixture 全集（等价断言右侧行之有效）', async () => {
    const patches = basePatches();
    mockGet = (id) => (id === 'query_world_slice' ? mockQueryWorldSlice(patches) : undefined);
    const fetched = await fetchWorldPatchesViaTool('/test');
    expect(fetched).toHaveLength(patches.length);
  });

  it('未注册 → undefined（既有 graceful 契约零变）', async () => {
    mockGet = () => undefined;
    expect(await fetchWorldPatchesViaTool('/test')).toBeUndefined();
  });
});

// ── brief-compiler 批量贴回（同 storyTime 场共享 snapshot + ats 去重）──

describe('brief-compiler #6 批量贴回（Step 5 等价重构）', () => {
  function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
    return {
      runId: 'run_equiv',
      status: 'running',
      currentNodeId: null,
      projectPath: '/test',
      completedNodes: [],
      pendingNodes: [],
      artifacts,
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    };
  }

  it('多场共享 storyTime → 同 snapshot 引用；ats 去重单次批量请求', async () => {
    const patches = basePatches();
    const receivedAts: number[][] = [];
    mockGet = (id) =>
      id === 'build_world_snapshot'
        ? mockBuildWorldSnapshotState(patches, (p) => {
            if (Array.isArray(p.ats)) receivedAts.push(p.ats as number[]);
          })
        : undefined;

    // 3 场：s_a/s_b 同 storyTime=10，s_c storyTime=20 → ats 去重 [10, 20]。
    const scene = (partial: Record<string, unknown>) =>
      sceneNodeSchema.parse({
        storyTime: 0,
        presentationOrder: { chapter: 0, pos: 0 },
        ...partial,
      });
    const sceneGraph: SceneGraph = {
      nodes: [
        scene({ id: 's_a', episodeId: 'ep1', storyTime: 10 }),
        scene({ id: 's_b', episodeId: 'ep1', storyTime: 10 }),
        scene({ id: 's_c', episodeId: 'ep1', storyTime: 20 }),
      ],
      edges: [],
      lines: [],
      art_overrides: [],
      version: 0,
      updatedBy: 'agent',
    };

    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } },
        scene_graph: sceneGraph,
        episode_outlines: [episodeOutlineSchema.parse({ id: 'ep1', index: 0, title: '第一章' })],
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('chapter_brief');

    // 一次批量请求，ats 去重。
    expect(receivedAts).toEqual([[10, 20]]);

    const brief = result.artifact as {
      plotPoints: Array<{ sceneId: string; stateAtT?: { at?: number } }>;
    };
    const byId = Object.fromEntries(brief.plotPoints.map((p) => [p.sceneId, p.stateAtT]));

    // 同 storyTime 两场：**同一 snapshot 引用**（Map 贴回共享，非重复构造）。
    expect(byId.s_a).toBe(byId.s_b);
    // 内容 ≡ 本地纯函数 fold。
    expect(byId.s_a).toEqual(buildWorldStateSnapshot(patches, 10));
    expect(byId.s_c).toEqual(buildWorldStateSnapshot(patches, 20));
    expect((byId.s_a as { at?: number }).at).toBe(10);
  });
});
