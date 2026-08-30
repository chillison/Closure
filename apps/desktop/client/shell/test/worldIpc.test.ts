/**
 * dogfood R2 #92 S2：世界状态面板读面 IPC + world:changed 事件（design v2「实时数据交互」；
 * BMad CR 2026-08-30 #1+#200/#3+#104/#4/#13 修订）。
 *
 * 覆盖（mirror wallpaperIpc.test 组织——hoisted mock + getHandlers 模式；repo 全 mock 走
 * worldStateHandlers.test 的 ABI-free 套路，真 db round-trip 归 worldPanelAggregates.test）：
 * - world:overview 聚合：主体行（patchCount/lastStoryTime/axes canonical 序 + 登记未写 null 形态）、
 *   锚点行（跨 episode 同 storyTime 归并 / axisCounts 五键缺轴 0 / epRange 紧凑形 / label=title=
 *   slice.title）、patchTotal、latestT 升序、空库 latestT=null、**零 patch slice 不产出锚点不抬
 *   latestT（CR #13）**、取数面零 withPatches（CR #1+#200）。
 * - world:slice-detail：storyTime 精确切窄取数（CR #1+#200）/ 组头全史 stats、缺失时点零值锚点 +
 *   空组（graceful 不 throw）。
 * - world:subject-detail：仅 patches 透传 + 零 reduce 计算（CR #4——reduceWorldSubjectCheckpointed
 *   不在调用面）+ 旧 `at` 入参被 strip。
 * - world:changed 三写入口全发：write_world_events（kind=slice-written + canonical subjectIds，经
 *   #91 身份解析后）/ amend_world_state（kind=amendment）/ resetWorldStateForBackfill（kind=backfill）；
 *   发射载荷全部过 worldChangedEventSchema（superRefine 形状守门，CR #9+#108）。
 * - epRange 数值尾排序（CR #3+#104）：ep1-9 < ep1-10 < ep1-101 / 跨卷 ep1-x < ep2-x。
 * - 真 sendWorldChanged（importActual，electron mock 可控）：全窗口广播通道+载荷 / getAllWindows 抛
 *   不上抛（best-effort 红线）/ 单窗 send 失败不拖累其余窗口。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  worldChangedEventSchema,
  type WorldOverview,
  type WorldPatch,
  type WorldPatchAxis,
  type WorldSlice,
  type WorldSliceDetail,
  type WorldSubjectDetail,
} from '@orison/shared-contracts';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  getAllWindows: vi.fn((): unknown[] => []),
}));
const repo = vi.hoisted(() => ({
  // worldIpc 读面（BMad CR #1+#200：db 聚合查询替代全量 patches）：
  listWorldSubjects: vi.fn(),
  listWorldSubjectActivityStats: vi.fn(),
  listWorldAnchorStats: vi.fn(),
  listWorldSlices: vi.fn(),
  listWorldPatches: vi.fn(),
  // worldStateHandlers / worldStateBackfill 依赖面（同一 mock 模块须供给全导出面）：
  reduceWorldSubject: vi.fn(),
  findWorldRefs: vi.fn(),
  insertWorldSlice: vi.fn(),
  buildWorldSnapshotCheckpointed: vi.fn(),
  listChapterSummaries: vi.fn(),
  resolveWorldSubjectIdentity: vi.fn(),
  resetWorldState: vi.fn(),
}));
const misc = vi.hoisted(() => ({
  getProject: vi.fn(),
  sendWorldChanged: vi.fn(),
  materializeChapterSummaryCore: vi.fn(),
  worldSliceEpisodeId: vi.fn(),
  readKnownEpisodeIds: vi.fn(),
  loadProject: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle },
  BrowserWindow: { getAllWindows: electron.getAllWindows },
}));
vi.mock('../main/db/worldStateRepository', () => ({ ...repo }));
vi.mock('../main/db/projectRepository', () => ({ getProject: misc.getProject }));
// worldStateBackfill 静态复用面（mirror worldStateBackfill.test 的 mock 工厂导出集）。
vi.mock('../main/db/worldStateMaterialize', () => ({
  materializeChapterSummaryCore: misc.materializeChapterSummaryCore,
  worldSliceEpisodeId: misc.worldSliceEpisodeId,
  readKnownEpisodeIds: misc.readKnownEpisodeIds,
  waitForSummaryIndexQueue: vi.fn(async () => undefined),
}));
// worldStateHandlers 的 project.yaml 三源动态 import 面（mirror worldStateHandlers.test）。
vi.mock('@orison/desktop-local-bff', () => ({ loadProject: misc.loadProject }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn: misc.warn, info: misc.info }) }));
// 发射面 mock（三写入口断言 kind+载荷用）；真模块行为经 vi.importActual 单测（见末段 describe）。
vi.mock('../main/ipc/worldNotify', () => ({
  WORLD_CHANGED_CHANNEL: 'world:changed',
  sendWorldChanged: misc.sendWorldChanged,
}));

import { registerWorldIpc } from '../main/ipc/worldIpc';
import { resetWorldStateForBackfill } from '../main/db/worldStateBackfill';
import {
  amendWorldStateHandler,
  writeWorldEventsHandler,
} from '../main/ipc/toolHandlers/worldStateHandlers';

// ── handlers 提取（wallpaperIpc.test getHandlers 模式）──

// handler 提取形态（ipcMain.handle mock 面无类型——显式签名喂回返回类型）。
type IpcHandler<T> = (_e: unknown, input: unknown) => Promise<T>;

function getWorldHandlers() {
  electron.handle.mockReset();
  registerWorldIpc();
  const overview = electron.handle.mock.calls.find(([c]) => c === 'world:overview')![1] as IpcHandler<WorldOverview>;
  const sliceDetail = electron.handle.mock.calls.find(([c]) => c === 'world:slice-detail')![1] as IpcHandler<WorldSliceDetail>;
  const subjectDetail = electron.handle.mock.calls.find(([c]) => c === 'world:subject-detail')![1] as IpcHandler<WorldSubjectDetail>;
  return { overview, sliceDetail, subjectDetail };
}

// ── fixture（形态 mirror dogfood 真库：canonical subject id / 中文 title / 跨 episode 同 storyTime）──

function mkPatch(
  id: string,
  sliceId: string,
  subjectId: string,
  path: string,
  axis: WorldPatchAxis,
): WorldPatch {
  return {
    id,
    sliceId,
    subjectId,
    path,
    op: 'replace',
    value: 'v',
    axis,
    source: 'derived',
    storyTime: Number(sliceId.split(':')[1]),
  };
}

const SLICES: Array<WorldSlice & { patches: WorldPatch[] }> = [
  {
    id: 'ep1-01:1', projectId: '00001', storyTime: 1, title: '荒野舱醒', episodeId: 'ep1-01',
    patches: [
      mkPatch('p1', 'ep1-01:1', 'character:shen-yan', '/presence_scene', 'physical'),
      mkPatch('p2', 'ep1-01:1', 'character:shen-yan', '/mood', 'emotional'),
      mkPatch('p3', 'ep1-01:1', 'character:shen-yan', '/suspects/舱体来源异常', 'cognitive'),
      mkPatch('p4', 'ep1-01:1', 'character:miya', '/presence_scene', 'physical'),
      mkPatch('p5', 'ep1-01:1', 'item:cryo-pod-01', '/status', 'physical'),
    ],
  },
  {
    id: 'ep1-06:2', projectId: '00001', storyTime: 2, title: '入住小栗家', episodeId: 'ep1-06',
    patches: [
      mkPatch('p6', 'ep1-06:2', 'character:miya', '/knows/沈砚的伤势', 'cognitive'),
      mkPatch('p7', 'ep1-06:2', 'group:archaeology-team', '/status', 'factional'),
    ],
  },
  {
    // 跨 episode 同 storyTime（一场景跨多章：presentationSpans）——与 ep1-06:2 归并同锚点。
    id: 'ep1-08:2', projectId: '00001', storyTime: 2, title: '', episodeId: 'ep1-08',
    patches: [mkPatch('p8', 'ep1-08:2', 'character:shen-yan', '/location', 'physical')],
  },
  {
    id: 'ep1-13:3', projectId: '00001', storyTime: 3, title: '入学首日', episodeId: 'ep1-13',
    patches: [mkPatch('p9', 'ep1-13:3', 'character:shen-yan', '/suspects/小关的动机', 'cognitive')],
  },
  {
    // CR #13 零 patch slice（登记残留 / 提取器空产物）：**不产出锚点行、不抬 latestT**——对应
    // db 聚合（listWorldAnchorStats）对该 storyTime 无行的真行为（真库对拍见 worldPanelAggregates.test）。
    id: 'ep1-20:4', projectId: '00001', storyTime: 4, title: '空切片', episodeId: 'ep1-20',
    patches: [],
  },
];

const SUBJECTS = [
  { id: 'character:shen-yan', type: 'character', name: '沈砚', firstSeenStoryTime: 1 },
  { id: 'character:miya', type: 'character', name: '米娅', firstSeenStoryTime: 1 },
  { id: 'item:cryo-pod-01', type: 'item', name: '休眠舱', firstSeenStoryTime: 1 },
  { id: 'group:archaeology-team', type: 'group', name: '考古队', firstSeenStoryTime: 2 },
  // 登记未写（resetWorldState 保身份清切面的存量主体常态）——patchCount 0 / lastStoryTime null。
  { id: 'character:ghost-01', type: 'character', name: '幽灵', firstSeenStoryTime: 1 },
];

/** db 聚合 fixture（listWorldSubjectActivityStats 真形态——全史口径，与 SLICES 行一致）。 */
const SUBJECT_STATS = [
  {
    subjectId: 'character:shen-yan', patchCount: 5, firstStoryTime: 1, lastStoryTime: 3,
    // db GROUP_CONCAT 无序——消费侧 canonical 序归一的输入面（真实形态：出现序任意）。
    axes: ['emotional', 'physical', 'cognitive'],
  },
  {
    subjectId: 'character:miya', patchCount: 2, firstStoryTime: 1, lastStoryTime: 2,
    axes: ['cognitive', 'physical'],
  },
  { subjectId: 'item:cryo-pod-01', patchCount: 1, firstStoryTime: 1, lastStoryTime: 1, axes: ['physical'] },
  {
    subjectId: 'group:archaeology-team', patchCount: 1, firstStoryTime: 2, lastStoryTime: 2,
    axes: ['factional'],
  },
  // 未登记主体（patch 引用但 SUBJECTS 无行——#91 漂移形态）：overview 须合成 entity 哨兵行（CR #6）。
  {
    subjectId: 'item:orphan-relic', patchCount: 2, firstStoryTime: 1, lastStoryTime: 2,
    axes: ['physical'],
  },
];

/** db 聚合 fixture（listWorldAnchorStats 真形态——storyTime 升序，零 patch 的 t=4 无行）。 */
const ANCHOR_STATS = [
  {
    t: 1, subjectCount: 3, patchCount: 5,
    axisCounts: { physical: 3, cognitive: 1, emotional: 1, relational: 0, factional: 0 },
  },
  {
    t: 2, subjectCount: 3, patchCount: 3,
    axisCounts: { physical: 1, cognitive: 1, emotional: 0, relational: 0, factional: 1 },
  },
  {
    t: 3, subjectCount: 1, patchCount: 1,
    axisCounts: { physical: 0, cognitive: 1, emotional: 0, relational: 0, factional: 0 },
  },
];

/** 装配读面 fixture（repo mock 同步喂同一世界态；listWorldSlices 按 opts.storyTime 仿真 repo 精确过滤）。 */
function seedWorldFixture() {
  repo.listWorldSubjects.mockReturnValue(SUBJECTS);
  repo.listWorldSubjectActivityStats.mockReturnValue(SUBJECT_STATS);
  repo.listWorldAnchorStats.mockReturnValue(ANCHOR_STATS);
  repo.listWorldSlices.mockImplementation(
    (_pid: string, opts?: { storyTime?: number }) =>
      opts?.storyTime === undefined
        ? SLICES
        : SLICES.filter((s) => s.storyTime === opts.storyTime),
  );
}

beforeEach(() => {
  for (const fn of [
    ...Object.values(repo),
    ...Object.values(misc),
    electron.getAllWindows,
    electron.handle,
  ]) {
    (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  electron.getAllWindows.mockReturnValue([]);
  // 身份解析默认直通（mirror worldStateHandlers.test 同款 passthrough 缺省）。
  repo.resolveWorldSubjectIdentity.mockImplementation(
    (_pid: string, subjects: unknown, patches: unknown) => ({
      subjects,
      patches,
      remaps: [],
      reusedCount: 0,
    }),
  );
});

// ── world:overview ──

describe('world:overview 聚合', () => {
  it('主体行：patchCount/lastStoryTime/axes（db 聚合无序输入 → canonical 轴序输出）+ 登记未写主体 0/null/[]', async () => {
    seedWorldFixture();
    const { overview } = getWorldHandlers();

    const res = await overview(null, { projectId: '00001' });

    const shen = res.subjects.find((s) => s.id === 'character:shen-yan')!;
    expect(shen).toMatchObject({ patchCount: 5, lastStoryTime: 3 });
    // 轴序 = worldPatchAxisSchema enum 序（physical→cognitive→emotional），非字母序/非 db 出现序。
    expect(shen.axes).toEqual(['physical', 'cognitive', 'emotional']);
    const ghost = res.subjects.find((s) => s.id === 'character:ghost-01')!;
    expect(ghost).toMatchObject({ patchCount: 0, lastStoryTime: null, axes: [] });
    // 未登记主体哨兵行（CR #6）：合成 entity 形态带聚合计数——L1 选择区与 L2/头部计数同口径。
    const orphan = res.subjects.find((s) => s.id === 'item:orphan-relic')!;
    expect(orphan).toMatchObject({ type: 'entity', patchCount: 2, lastStoryTime: 2, axes: ['physical'] });
    expect(res.subjects).toHaveLength(6);
  });

  it('锚点行：跨 episode 同 storyTime 归并 / 五键 axisCounts 缺轴 0 / epRange 紧凑形 / label=title=slice.title', async () => {
    seedWorldFixture();
    const { overview } = getWorldHandlers();

    const res = await overview(null, { projectId: '00001' });

    expect(res.anchors.map((a) => a.t)).toEqual([1, 2, 3]); // 数据层升序（UI 降序渲染）
    const a1 = res.anchors[0];
    expect(a1).toMatchObject({
      t: 1, label: '荒野舱醒', title: '荒野舱醒', epRange: 'ep1-01',
      subjectCount: 3, patchCount: 5,
    });
    expect(a1.axisCounts).toEqual({
      physical: 3, cognitive: 1, emotional: 1, relational: 0, factional: 0,
    });
    // t=2：ep1-06:2 + ep1-08:2 归并（subjectCount/patchCount 取 db 聚合行；title 取组内首个非空）。
    const a2 = res.anchors[1];
    expect(a2).toMatchObject({
      subjectCount: 3, patchCount: 3, title: '入住小栗家',
    });
    expect(a2.axisCounts).toEqual({
      physical: 1, cognitive: 1, emotional: 0, relational: 0, factional: 1,
    });
    // epRange：{ep1-06, ep1-08} → 公共前缀 + 数字尾紧凑形。
    expect(a2.epRange).toBe('ep1-06..8');
    expect(res.anchors[2]).toMatchObject({ t: 3, subjectCount: 1, patchCount: 1 });
    expect(res.patchTotal).toBe(9);
    expect(res.latestT).toBe(3);
  });

  it('零 patch slice（t=4 空切片）不产出锚点行、不抬 latestT（CR #13）', async () => {
    seedWorldFixture();
    const { overview } = getWorldHandlers();

    const res = await overview(null, { projectId: '00001' });

    // db 聚合（ANCHOR_STATS）对 t=4 无行——即便 slice 行存在（ep1-20:4）也不建锚点。
    expect(res.anchors.some((a) => a.t === 4)).toBe(false);
    expect(res.latestT).toBe(3);
    expect(res.patchTotal).toBe(9); // 空切片零贡献
  });

  it('空库：latestT=null（L1 空态判定键）+ anchors [] + patchTotal 0（登记未写主体仍列）', async () => {
    repo.listWorldSubjects.mockReturnValue([SUBJECTS[4]]);
    repo.listWorldSlices.mockReturnValue([]);
    repo.listWorldSubjectActivityStats.mockReturnValue([]);
    repo.listWorldAnchorStats.mockReturnValue([]);
    const { overview } = getWorldHandlers();

    const res = await overview(null, { projectId: '00001' });

    expect(res).toMatchObject({ patchTotal: 0, latestT: null });
    expect(res.anchors).toEqual([]);
    expect(res.subjects.map((s) => s.id)).toEqual(['character:ghost-01']);
    // 取数面（CR #1+#200）：overview 不带 withPatches——零 patch 行实例化。
    expect(repo.listWorldSlices).toHaveBeenCalledWith('00001', {});
    expect(repo.listWorldSubjectActivityStats).toHaveBeenCalledWith('00001');
    expect(repo.listWorldAnchorStats).toHaveBeenCalledWith('00001');
  });

  it('坏参（projectId 缺失）→ zod throw（模式 B，mirror task:upsert parse 形态）', async () => {
    const { overview } = getWorldHandlers();
    await expect(overview(null, {})).rejects.toThrow();
  });
});

// ── epRange 数值尾排序（CR #3+#104——computeEpRange 经 overview 锚点行驱动）──

describe('computeEpRange 数值尾排序', () => {
  async function anchorEpRangeOf(episodeIds: Array<string | undefined>): Promise<string | undefined> {
    repo.listWorldSubjects.mockReturnValue([]);
    repo.listWorldSubjectActivityStats.mockReturnValue([]);
    repo.listWorldAnchorStats.mockReturnValue([
      { t: 1, subjectCount: 1, patchCount: 1, axisCounts: { physical: 1, cognitive: 0, emotional: 0, relational: 0, factional: 0 } },
    ]);
    repo.listWorldSlices.mockReturnValue(
      episodeIds.map((episodeId, i) => ({
        id: `${episodeId ?? `x${i}`}:1`, projectId: '00001', storyTime: 1, title: '', episodeId,
      })),
    );
    const { overview } = getWorldHandlers();
    const res = await overview(null, { projectId: '00001' });
    return res.anchors[0]?.epRange;
  }

  it('字典序倒置修复：{ep1-10, ep1-9} → ep1-9..10（非 ep1-10..9）', async () => {
    expect(await anchorEpRangeOf(['ep1-10', 'ep1-9'])).toBe('ep1-9..10');
  });

  it('多位数字尾：{ep1-101, ep1-99} → ep1-99..101', async () => {
    expect(await anchorEpRangeOf(['ep1-101', 'ep1-99'])).toBe('ep1-99..101');
  });

  it('跨卷：head 先序 {ep2-3, ep1-5} → ep1-5..ep2-3（非尾数字值序倒挂）', async () => {
    expect(await anchorEpRangeOf(['ep2-3', 'ep1-5'])).toBe('ep1-5..ep2-3');
  });

  it('非数字尾回退 localeCompare 全串：{ep1-b, ep1-a} → ep1-a..ep1-b', async () => {
    expect(await anchorEpRangeOf(['ep1-b', 'ep1-a'])).toBe('ep1-a..ep1-b');
  });

  it('单 id 原样 / 全 undefined → undefined', async () => {
    expect(await anchorEpRangeOf(['ep1-07'])).toBe('ep1-07');
    expect(await anchorEpRangeOf([undefined, undefined])).toBeUndefined();
  });
});

// ── world:slice-detail ──

describe('world:slice-detail 时点切片', () => {
  it('storyTime 精确切窄取数（CR #1+#200）：t=2 组只含该时点 patches + 组头全史 stats', async () => {
    seedWorldFixture();
    const { sliceDetail } = getWorldHandlers();

    const res = await sliceDetail(null, { projectId: '00001', t: 2 });

    // 取数面：storyTime 精确 opt（repo 侧过滤，非 at 的 <= 累计语义）。
    expect(repo.listWorldSlices).toHaveBeenCalledWith('00001', { withPatches: true, storyTime: 2 });
    expect(res.anchor.t).toBe(2);
    expect(res.anchor.patchCount).toBe(3);
    // 组按 subjectId 排序（确定性输出；UI 自行重排）。
    expect(res.groups.map((g) => g.subject.id)).toEqual([
      'character:miya', 'character:shen-yan', 'group:archaeology-team',
    ]);
    const miya = res.groups[0];
    expect(miya.patches.map((p) => p.path)).toEqual(['/knows/沈砚的伤势']);
    // 组头 WorldSubjectRow 是全史口径（patchCount=2 含 t=1 的 presence_scene），非本时点计数。
    expect(miya.subject).toMatchObject({ patchCount: 2, lastStoryTime: 2 });
    expect(miya.subject.axes).toEqual(['physical', 'cognitive']);
    // 精确时点：t=1 的 /presence_scene 不出现在任何组；跨 episode 切片 ep1-08:2 在场。
    const allPaths = res.groups.flatMap((g) => g.patches.map((p) => p.path));
    expect(allPaths).not.toContain('/presence_scene');
    expect(allPaths).toContain('/location');
  });

  it('缺失时点 → 零值锚点 + 空组（graceful 不 throw）', async () => {
    seedWorldFixture();
    const { sliceDetail } = getWorldHandlers();

    const res = await sliceDetail(null, { projectId: '00001', t: 99 });

    expect(res.groups).toEqual([]);
    expect(res.anchor).toMatchObject({ t: 99, subjectCount: 0, patchCount: 0 });
    expect(res.anchor.axisCounts).toEqual({
      physical: 0, cognitive: 0, emotional: 0, relational: 0, factional: 0,
    });
    expect(res.anchor.label).toBeUndefined();
  });
});

// ── world:subject-detail ──

describe('world:subject-detail 主体详情', () => {
  it('仅 patches 透传 + 零 reduce 计算（CR #4——reduceWorldSubjectCheckpointed 不在调用面）', async () => {
    const { subjectDetail } = getWorldHandlers();
    const patches = [mkPatch('p1', 'ep1-01:1', 'character:shen-yan', '/presence_scene', 'physical')];
    repo.listWorldPatches.mockReturnValue(patches);

    const res = await subjectDetail(null, { projectId: '00001', subjectId: 'character:shen-yan' });

    expect(res.patches).toBe(patches);
    expect(Object.keys(res)).toEqual(['patches']); // reduced/issues 已砍
    expect(repo.listWorldPatches).toHaveBeenCalledWith('00001', 'character:shen-yan');
  });

  it('旧 `at` 入参被 strip（通道不收截断点——切线归 UI 本地）', async () => {
    const { subjectDetail } = getWorldHandlers();
    repo.listWorldPatches.mockReturnValue([]);

    const res = await subjectDetail(null, {
      projectId: '00001', subjectId: 'character:shen-yan', at: 5,
    });

    expect(res.patches).toEqual([]);
    expect(repo.listWorldPatches).toHaveBeenCalledWith('00001', 'character:shen-yan');
  });
});

// ── world:changed 事件三写入口 ──

describe('world:changed 三写入口发射', () => {
  function toolCtx(params: Record<string, unknown>) {
    return { params, projectDir: '/proj/alpha', sessionId: 's1', abort: new AbortController().signal };
  }

  beforeEach(() => {
    misc.getProject.mockReturnValue({ projectId: '00001' });
  });

  it('write_world_events → kind=slice-written + sliceT + subjectIds（写章链/backfill 落表共用口）', async () => {
    const res = await writeWorldEventsHandler(
      toolCtx({
        slice: { id: 'ep1-02:2', storyTime: 2, title: 't' },
        patches: [
          { subjectId: 'character:shen-yan', path: '/hp', op: 'replace', value: 50, axis: 'physical' },
          { subjectId: 'character:miya', path: '/mood', op: 'replace', value: '平静', axis: 'emotional' },
          { subjectId: 'character:shen-yan', path: '/location', op: 'replace', value: 'X', axis: 'physical' },
        ],
        subjects: [],
      }),
    );

    expect(res.metadata).toMatchObject({ ok: true });
    expect(misc.sendWorldChanged).toHaveBeenCalledTimes(1);
    expect(misc.sendWorldChanged).toHaveBeenCalledWith({
      projectId: '00001',
      kind: 'slice-written',
      sliceT: 2,
      // 去重后的受影响主体集。
      subjectIds: ['character:shen-yan', 'character:miya'],
    });
    // 发射载荷过契约形状门（superRefine：slice-written 必带 sliceT，CR #9+#108）。
    expect(() =>
      worldChangedEventSchema.parse(misc.sendWorldChanged.mock.calls[0][0]),
    ).not.toThrow();
  });

  it('零 patch 写入 → subjectIds 缺省不传（非空数组）——载荷仍过 superRefine 形状门', async () => {
    await writeWorldEventsHandler(
      toolCtx({ slice: { id: 'ep1-21:5', storyTime: 5, title: 't' }, patches: [], subjects: [] }),
    );

    expect(misc.sendWorldChanged).toHaveBeenCalledTimes(1);
    const event = misc.sendWorldChanged.mock.calls[0][0];
    expect(event).toEqual({ projectId: '00001', kind: 'slice-written', sliceT: 5 });
    expect(() => worldChangedEventSchema.parse(event)).not.toThrow();
  });

  it('subjectIds 取 #91 身份解析后的 canonical 集（非请求原样变体）', async () => {
    repo.resolveWorldSubjectIdentity.mockImplementation(
      (_pid: string, subjects: unknown, patches: Array<{ subjectId: string }>) => ({
        subjects,
        patches: patches.map((p) => ({ ...p, subjectId: 'character:shen-yan' })),
        remaps: [{ from: 'shenyan', to: 'character:shen-yan' }],
        reusedCount: 1,
      }),
    );

    await writeWorldEventsHandler(
      toolCtx({
        slice: { id: 'ep1-02:2', storyTime: 2, title: 't' },
        patches: [{ subjectId: 'shenyan', path: '/hp', op: 'replace', value: 50, axis: 'physical' }],
        subjects: [],
      }),
    );

    expect(misc.sendWorldChanged).toHaveBeenCalledWith(
      expect.objectContaining({ subjectIds: ['character:shen-yan'] }),
    );
  });

  it('amend_world_state → kind=amendment（同 handler 双 source 分流）', async () => {
    await amendWorldStateHandler(
      toolCtx({
        slice: { id: 'am-fix:2', storyTime: 2, title: '修补' },
        patches: [{ subjectId: 'item:cryo-pod-01', path: '/status', op: 'replace', value: 'sealed', axis: 'physical' }],
      }),
    );

    expect(misc.sendWorldChanged).toHaveBeenCalledWith({
      projectId: '00001',
      kind: 'amendment',
      sliceT: 2,
      subjectIds: ['item:cryo-pod-01'],
    });
    // amendment 载荷过 superRefine 形状门（必带 sliceT，CR #9+#108）。
    expect(() =>
      worldChangedEventSchema.parse(misc.sendWorldChanged.mock.calls[0][0]),
    ).not.toThrow();
  });

  it('写失败（repo 抛）→ 不发射（catch 路径在发射点之前）', async () => {
    repo.insertWorldSlice.mockImplementation(() => {
      throw new Error('db locked');
    });

    const res = await writeWorldEventsHandler(
      toolCtx({ slice: { id: 's', storyTime: 1, title: 't' }, patches: [] }),
    );

    expect(res.metadata).toMatchObject({ ok: false, reason: 'write_failed' });
    expect(misc.sendWorldChanged).not.toHaveBeenCalled();
  });

  it('resetWorldStateForBackfill → kind=backfill（不带 sliceT/subjectIds——全量清空保守重拉）', () => {
    resetWorldStateForBackfill('00042');

    expect(repo.resetWorldState).toHaveBeenCalledWith('00042');
    expect(misc.sendWorldChanged).toHaveBeenCalledTimes(1);
    expect(misc.sendWorldChanged).toHaveBeenCalledWith({ projectId: '00042', kind: 'backfill' });
    // backfill 载荷过 superRefine 形状门（全量语义不带 sliceT/subjectIds，合法）。
    expect(() =>
      worldChangedEventSchema.parse(misc.sendWorldChanged.mock.calls[0][0]),
    ).not.toThrow();
  });

  it('发射侧形状拒绝锚（CR #9+#108）：schema 拒 slice-written 缺 sliceT / 拒空 subjectIds——发射器永不产此形', () => {
    // 若未来发射点漂移出这些形状，载荷会在消费侧（renderer 订阅面校验 / 测试）显式炸掉而非静默。
    expect(
      worldChangedEventSchema.safeParse({ projectId: 'p', kind: 'slice-written', subjectIds: ['a'] }).success,
    ).toBe(false);
    expect(
      worldChangedEventSchema.safeParse({ projectId: 'p', kind: 'slice-written', sliceT: 1, subjectIds: [] }).success,
    ).toBe(false);
    expect(
      worldChangedEventSchema.safeParse({ projectId: 'p', kind: 'amendment', subjectIds: ['a'] }).success,
    ).toBe(false);
  });
});

// ── 真 sendWorldChanged（importActual——发射器本体行为，electron mock 可控）──

describe('sendWorldChanged 广播器（真模块）', () => {
  it('全窗口广播 world:changed + 载荷原样', async () => {
    const send1 = vi.fn();
    const send2 = vi.fn();
    electron.getAllWindows.mockReturnValue([
      { webContents: { send: send1 } },
      { webContents: { send: send2 } },
    ]);
    const actual = await vi.importActual<typeof import('../main/ipc/worldNotify')>(
      '../main/ipc/worldNotify',
    );

    const payload = { projectId: '00001', kind: 'slice-written' as const, sliceT: 2, subjectIds: ['a'] };
    expect(() => actual.sendWorldChanged(payload)).not.toThrow();
    expect(send1).toHaveBeenCalledWith('world:changed', payload);
    expect(send2).toHaveBeenCalledWith('world:changed', payload);
  });

  it('getAllWindows 抛（无 electron 语境）→ 不上抛，只 warn（best-effort 红线）', async () => {
    electron.getAllWindows.mockImplementation(() => {
      throw new Error('BrowserWindow unavailable');
    });
    const actual = await vi.importActual<typeof import('../main/ipc/worldNotify')>(
      '../main/ipc/worldNotify',
    );

    expect(() => actual.sendWorldChanged({ projectId: 'p', kind: 'reset' })).not.toThrow();
    expect(misc.warn).toHaveBeenCalled();
  });

  it('单窗 send 失败 → 其余窗口照发 + 不上抛', async () => {
    const send1 = vi.fn(() => {
      throw new Error('dead window');
    });
    const send2 = vi.fn();
    electron.getAllWindows.mockReturnValue([
      { webContents: { send: send1 } },
      { webContents: { send: send2 } },
    ]);
    const actual = await vi.importActual<typeof import('../main/ipc/worldNotify')>(
      '../main/ipc/worldNotify',
    );

    expect(() => actual.sendWorldChanged({ projectId: 'p', kind: 'amendment' })).not.toThrow();
    expect(send2).toHaveBeenCalledWith('world:changed', { projectId: 'p', kind: 'amendment' });
  });
});
