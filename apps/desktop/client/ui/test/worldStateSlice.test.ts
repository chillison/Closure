/**
 * worldStateSlice 状态机测试（dogfood R2 #92，task 08-29-world-state-panel S3 + CR 批）。
 *
 * 覆盖（design「实时数据交互」+「交互质量不变式」+ CR patch 批）：
 * - 三级导航语义（照 v3 mockup：goSlice/goSubject 清切线与钻取、axisOn 保留）；
 * - world:changed 事件驱动重拉——L1 恒拉 / L2 按时点收窄 / L3 按主体收窄，
 *   **交互状态（view/viewT/selected/asOfT/axisOn/pathFilter）一律不动**（#86）；
 * - CR #2+#107+#201+#17：事件可见性门控（面板不可见零重拉）+ 增量事件 debounce
 *   （同窗连发合并一次、并集判定不漏中间命中、固定窗持续流不饿死）+ backfill/reset
 *   立即 + 打开补偿（关→开边沿 force 重拉，事件可丢的读侧兜底）；
 * - CR #5+#102+#210：桥缺失显式报错落 error 态（不再 `?? null` 伪装空态）+ 重试；
 * - CR #100+#101：数据归属闸（缓存/在途携 projectId，他项目不去重——接管重拉）+
 *   projectId 未注册返回不动（不拉 IPC 不落假态）；
 * - CR #16+#109：持久化快照非整数 viewT/asOfT 拒收（Number.isInteger）；
 * - CR #12：subscribeWorldEvents 注册成功才置旗标（半残桥抛错可重试）；
 * - 事件按 projectId 过滤（他项目写入不进当前视图）；
 * - 视图态按项目键控持久化 + 水合（刷新存活）+ 项目隔离（切项目回默认、
 *   stale resolve 丢弃——projectSubscription 竞态纪律）；
 * - 加载请求接管（supersede）：在途切换主体/时点/force 刷新不丢请求（旧「loading 即
 *   丢弃」会吞掉 B 的拉取 → 骨架卡死）、旧请求后到作废不覆盖；同 identity 重复调用
 *   仍去重。
 *
 * mock 形态照 spec/ui/testing.md：注入 seam（mock window.orisonDesktop 桥），
 * 最小组合 store（只装被测 slice + currentProject + activeSidebarPanel——事件门控
 * 读 panelsSlice 状态，最小 store 须随附）。
 *
 * 计时口径：**真实定时器**（debounce 聚合窗 = WORLD_EVENT_DEBOUNCE_MS=150ms）——窗后
 * 断言用 sleepPastDebounce（150ms+余量）；beforeEach 先排干上一测遗留聚合窗（真实
 * 定时器防跨测串扰：遗留尾弹在本测 spy 清零前触发并清账）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type {
  WorldChangedEvent,
  WorldOverview,
  WorldSubjectDetail,
  WorldSubjectRow,
} from '@orison/shared-contracts';
import {
  createWorldStateSlice,
  WORLD_EVENT_DEBOUNCE_MS,
  type WorldStateSlice,
  type WorldViewState,
} from '../src/shared/store/worldStateSlice';
import type { SidebarPanel } from '../src/shared/store/types';
import { runProjectResets } from '../src/shared/store/resetRegistry';
import { storage } from '../src/shared/store/storage';
import { normalizeProjectPathForCompare } from '../src/shared/store/projectRunBusy';

type TestState = WorldStateSlice & {
  currentProject: { projectId?: string; path: string } | null;
  activeSidebarPanel: SidebarPanel;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  activeSidebarPanel: 'world',
  ...createWorldStateSlice(...args),
}));

// ── 文件级单 mock（spec/ui/testing.md 纪律：hand-made vi.fn 挂桥，beforeEach 清计数）──

/** L3 detail 契约（CR #4 后）= 仅全史 patches（reduced/issues/at 已删——切线折叠 UI
 *  本地重算）。fixture 单源，as-of 切换不再触发请求（见「切线零 IPC」测试）。 */
function subjectDetailFixture(): WorldSubjectDetail {
  return { patches: [] };
}

const worldOverviewSpy = vi.fn(async (): Promise<WorldOverview> => overviewFixture());
const worldSliceDetailSpy = vi.fn(async () => ({ anchor: anchorFixture(3), groups: [] }));
const worldSubjectDetailSpy = vi.fn(async (): Promise<WorldSubjectDetail> => subjectDetailFixture());
let worldChangedListener: ((event: WorldChangedEvent) => void) | null = null;

function installBridge() {
  worldChangedListener = null;
  (window as any).orisonDesktop = {
    worldOverview: worldOverviewSpy,
    worldSliceDetail: worldSliceDetailSpy,
    worldSubjectDetail: worldSubjectDetailSpy,
    onWorldChanged: (cb: (event: WorldChangedEvent) => void) => {
      worldChangedListener = cb;
      return () => { worldChangedListener = null; };
    },
  };
}

/** 真实定时器下等过 debounce 聚合窗 + 余量——窗后断言与 beforeEach 跨测排干共用。 */
async function sleepPastDebounce() {
  await new Promise((resolve) => setTimeout(resolve, WORLD_EVENT_DEBOUNCE_MS + 80));
}

// ── fixtures ──

function subjectRow(id: string, overrides: Partial<WorldSubjectRow> = {}): WorldSubjectRow {
  return {
    id,
    type: 'character',
    name: id,
    firstSeenStoryTime: 1,
    patchCount: 2,
    lastStoryTime: 3,
    axes: ['physical'],
    ...overrides,
  };
}

function anchorFixture(t: number) {
  return {
    t,
    label: `时点${t}`,
    epRange: 'ep1-01..05',
    subjectCount: 2,
    patchCount: 4,
    axisCounts: { physical: 2, cognitive: 1, emotional: 1, relational: 0, factional: 0 },
  };
}

function overviewFixture(): WorldOverview {
  return {
    subjects: [subjectRow('character:hero'), subjectRow('character:miya')],
    anchors: [anchorFixture(1), anchorFixture(3)],
    patchTotal: 6,
    latestT: 3,
  };
}

type TestProject = { projectId?: string; path: string };
const PROJECT_A: TestProject = { projectId: 'p-a', path: 'C:\\proj\\alpha' };
const PROJECT_B: TestProject = { projectId: 'p-b', path: '/proj/beta' };

const DEFAULT_VIEW: WorldViewState = {
  view: 'overview',
  viewT: null,
  selectedSubjectId: null,
  asOfT: null,
  pathFilter: null,
  axisOn: { physical: true, cognitive: true, emotional: true, relational: true, factional: true },
};

/** 落种项目 + 面板可见性（事件门控读 activeSidebarPanel——默认 'world' 让事件测试直跑，
 *  门控测试显式传 'explorer'）。 */
function seedProject(project: TestProject | null, panel: SidebarPanel = 'world') {
  useTestStore.setState({ currentProject: project, activeSidebarPanel: panel });
}

beforeEach(async () => {
  // 每测复位：**先排干上一测遗留的 debounce 聚合窗**（真实定时器防跨测串扰——遗留尾弹
  // 在本测 spy 清零前触发并清账，此后再无新窗可开），再跑全部注册 reset（回默认）+
  // 清桥/mock 计数 + 清 storage（持久化测试互不串）。
  // 周期旗标（同 updateSlice，reset 不清——worldEventsSubscribed 订阅面 +
  // worldPanelVisible 镜像 activeSidebarPanel 不随项目 reset）——测试里显式归位保证
  // 每测从「未订阅 + 面板不可见」起步（否则上一测的 visible=true 会吞掉本测的关→开边沿）。
  await sleepPastDebounce();
  runProjectResets();
  useTestStore.setState({ worldEventsSubscribed: false, worldPanelVisible: false });
  seedProject(null);
  worldOverviewSpy.mockClear();
  worldSliceDetailSpy.mockClear();
  worldSubjectDetailSpy.mockClear();
  worldOverviewSpy.mockImplementation(async () => overviewFixture());
  localStorage.clear();
  installBridge();
});

describe('三级导航状态机（v3 mockup 语义）', () => {
  it('goWorldSlice：进 L2 锚定 viewT，清切线与钻取，axisOn 保留', () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.setWorldAsOf(2);
    s.setWorldPathFilter('/mood');
    s.toggleWorldAxis('physical');

    s.goWorldSlice(7);

    expect(useTestStore.getState().worldView).toEqual({
      ...DEFAULT_VIEW,
      view: 'slice',
      viewT: 7,
      axisOn: { ...DEFAULT_VIEW.axisOn, physical: false },
    });
  });

  it('goWorldSubject：进 L3 选中主体，清切线与钻取', () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.setWorldAsOf(2);
    s.setWorldPathFilter('/mood');
    s.goWorldSubject('character:hero');

    expect(useTestStore.getState().worldView).toEqual({
      ...DEFAULT_VIEW,
      view: 'subject',
      selectedSubjectId: 'character:hero',
    });
  });

  it('goWorldOverview：只回层级，viewT/selected 原地保留（返回上下文不销毁）', () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSlice(5);
    s.goWorldOverview();

    const view = useTestStore.getState().worldView;
    expect(view.view).toBe('overview');
    expect(view.viewT).toBe(5);
  });

  it('setWorldAsOf / setWorldPathFilter / toggleWorldAxis 各自独立生效', () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSubject('character:hero');
    s.setWorldAsOf(9);
    s.setWorldPathFilter('/suspects/舱体');
    s.toggleWorldAxis('cognitive');

    expect(useTestStore.getState().worldView).toEqual({
      view: 'subject',
      viewT: null,
      selectedSubjectId: 'character:hero',
      asOfT: 9,
      pathFilter: '/suspects/舱体',
      axisOn: { ...DEFAULT_VIEW.axisOn, cognitive: false },
    });
  });
});

describe('world:changed 事件驱动重拉（交互态不动；debounce 窗后触发）', () => {
  it('L3：选中主体受影响 → 重拉该主体（请求不带 as-of——契约 CR #4 切线折叠本地算）+ 重拉 overview，交互态一律不动', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.subscribeWorldEvents();
    expect(worldChangedListener).not.toBeNull();

    s.goWorldSubject('character:hero');
    s.setWorldAsOf(2);
    s.setWorldPathFilter('/mood');
    await useTestStore.getState().loadWorldSubjectDetail('character:hero', 2);
    expect(worldSubjectDetailSpy).toHaveBeenCalledTimes(1);
    expect(worldSubjectDetailSpy).toHaveBeenLastCalledWith({ projectId: 'p-a', subjectId: 'character:hero' });
    worldOverviewSpy.mockClear();

    worldChangedListener!({
      projectId: 'p-a',
      kind: 'slice-written',
      sliceT: 9,
      subjectIds: ['character:hero'],
    });
    // 事件重拉经 debounce 聚合窗（150ms）+ fire-and-forget void——waitFor 兜窗期。
    await vi.waitFor(() => expect(worldSubjectDetailSpy).toHaveBeenCalledTimes(2));
    expect(worldSubjectDetailSpy).toHaveBeenLastCalledWith({ projectId: 'p-a', subjectId: 'character:hero' });
    await vi.waitFor(() => expect(worldOverviewSpy).toHaveBeenCalledTimes(1));

    // #86：交互状态与数据刷新解耦——全部保持事件前的值。
    expect(useTestStore.getState().worldView).toEqual({
      view: 'subject',
      viewT: null,
      selectedSubjectId: 'character:hero',
      asOfT: 2,
      pathFilter: '/mood',
      axisOn: { ...DEFAULT_VIEW.axisOn },
    });
  });

  it('L3：subjectIds 不含选中主体 → 窗后仍不重拉主体', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSubject('character:hero');
    await s.loadWorldSubjectDetail('character:hero');
    worldSubjectDetailSpy.mockClear();

    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 9, subjectIds: ['character:miya'] });
    await sleepPastDebounce(); // 窗触发：overview 拉但主体不受影响

    expect(worldSubjectDetailSpy).not.toHaveBeenCalled();
    expect(worldOverviewSpy).toHaveBeenCalledTimes(1);
  });

  it('L2：sliceT 命中当前 viewT 才重拉；未命中不拉', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSlice(3);
    await s.loadWorldSliceDetail(3);
    worldSliceDetailSpy.mockClear();

    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 4 });
    expect(worldSliceDetailSpy).not.toHaveBeenCalled(); // 窗口未到期
    await sleepPastDebounce();
    expect(worldSliceDetailSpy).not.toHaveBeenCalled(); // 窗后也未命中 viewT=3

    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 3 });
    await vi.waitFor(() => expect(worldSliceDetailSpy).toHaveBeenCalledTimes(1));
  });

  it('L2/L3：backfill/reset 全量保守重拉（subjectIds 不填，立即不等窗）', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSubject('character:hero');
    await s.loadWorldSubjectDetail('character:hero');
    worldSubjectDetailSpy.mockClear();

    s.handleWorldChanged({ projectId: 'p-a', kind: 'backfill' });
    // 终态类立即同步触发（load 体首 await 前即调桥）——waitFor 兜异步落地。
    await vi.waitFor(() => expect(worldSubjectDetailSpy).toHaveBeenCalledTimes(1));
  });

  it('他项目事件被过滤：不重拉任何数据', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSubject('character:hero');
    await s.loadWorldSubjectDetail('character:hero');
    worldSubjectDetailSpy.mockClear();
    worldOverviewSpy.mockClear();

    s.handleWorldChanged({ projectId: 'p-other', kind: 'backfill' });
    await sleepPastDebounce();

    expect(worldSubjectDetailSpy).not.toHaveBeenCalled();
    expect(worldOverviewSpy).not.toHaveBeenCalled();
  });

  it('subscribeWorldEvents：桥缺事件面时静默跳过（S2 未接线期手动刷新兜底）', () => {
    seedProject(PROJECT_A);
    (window as any).orisonDesktop = {}; // 无 onWorldChanged
    expect(() => useTestStore.getState().subscribeWorldEvents()).not.toThrow();
    expect(useTestStore.getState().worldEventsSubscribed).toBe(false);
  });

  it('subscribeWorldEvents：onWorldChanged 抛错（半残桥）→ 旗标保持 false 且下次可重试（#12）', () => {
    seedProject(PROJECT_A);
    (window as any).orisonDesktop = {
      onWorldChanged: () => { throw new Error('half-broken bridge'); },
    };
    expect(() => useTestStore.getState().subscribeWorldEvents()).not.toThrow();
    expect(useTestStore.getState().worldEventsSubscribed).toBe(false); // 注册未成功——旗标不置位

    installBridge(); // 桥修复——旗标保持 false 才有重试通路
    useTestStore.getState().subscribeWorldEvents();
    expect(useTestStore.getState().worldEventsSubscribed).toBe(true);
    expect(worldChangedListener).not.toBeNull();
  });
});

describe('事件可见性门控 + debounce + 打开补偿（#2+#107+#201+#17）', () => {
  it('面板不可见（activeSidebarPanel ≠ world）：事件被门控——增量与终态全截断，零重拉', async () => {
    seedProject(PROJECT_A, 'explorer');
    const s = useTestStore.getState();
    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 9, subjectIds: ['character:hero'] });
    s.handleWorldChanged({ projectId: 'p-a', kind: 'backfill' });
    await sleepPastDebounce();

    expect(worldOverviewSpy).not.toHaveBeenCalled();
    expect(worldSubjectDetailSpy).not.toHaveBeenCalled();
    expect(worldSliceDetailSpy).not.toHaveBeenCalled();
  });

  it('聚合窗内面板切走：尾弹丢弃不补拉（重新打开由补偿兜底）', async () => {
    seedProject(PROJECT_A);
    useTestStore.getState().handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 9 });
    useTestStore.setState({ activeSidebarPanel: 'explorer' }); // 窗内关面板
    await sleepPastDebounce();
    expect(worldOverviewSpy).not.toHaveBeenCalled();
  });

  it('增量事件 debounce：同窗连发合并为一次重拉（并集判定命中中间事件）', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSlice(3);
    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 9 });
    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 3 });
    s.handleWorldChanged({ projectId: 'p-a', kind: 'amendment', sliceT: 9 });
    expect(worldOverviewSpy).not.toHaveBeenCalled(); // 窗口未到期：零 IPC
    expect(worldSliceDetailSpy).not.toHaveBeenCalled();

    await sleepPastDebounce();
    expect(worldOverviewSpy).toHaveBeenCalledTimes(1); // 三连发 → 一次 overview
    expect(worldSliceDetailSpy).toHaveBeenCalledTimes(1); // 并集含 t=3 命中（中间事件不漏）
  });

  it('并集不漏：窗内首条命中选中主体、末条不含 → 仍重拉该主体', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSubject('character:hero');
    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 9, subjectIds: ['character:hero'] });
    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 9, subjectIds: ['character:miya'] });
    await sleepPastDebounce();
    expect(worldSubjectDetailSpy).toHaveBeenCalledTimes(1); // 只看最后一条（miya）会漏 hero
  });

  it('固定聚合窗：跨窗事件分两次拉（持续事件流不饿死——每窗必触发）', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 9 });
    await sleepPastDebounce(); // 窗 1 触发
    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 9 }); // 新窗
    await sleepPastDebounce();
    expect(worldOverviewSpy).toHaveBeenCalledTimes(2);
  });

  it('backfill 立即重拉且丢弃在途聚合窗：窗内增量不重复拉', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.handleWorldChanged({ projectId: 'p-a', kind: 'slice-written', sliceT: 9 }); // 开窗
    s.handleWorldChanged({ projectId: 'p-a', kind: 'backfill' }); // 立即全量 + 弃窗
    expect(worldOverviewSpy).toHaveBeenCalledTimes(1); // 同步即发——不等窗
    await sleepPastDebounce();
    expect(worldOverviewSpy).toHaveBeenCalledTimes(1); // 被弃的窗不再触发第二次
  });

  it('打开补偿：关→开边沿 force 重拉当前视图（已装缓存也重拉——非 force 会被去重吞掉）', async () => {
    seedProject(PROJECT_A, 'explorer');
    await useTestStore.getState().loadWorldOverview(); // 已装缓存（归属 p-a）
    worldOverviewSpy.mockClear();

    useTestStore.getState().onWorldPanelVisibility(true);
    await vi.waitFor(() => expect(worldOverviewSpy).toHaveBeenCalledTimes(1));
  });

  it('补偿按当前视图收窄：L3 持久化视图 force 重拉主体详情（请求不带 as-of）', async () => {
    seedProject(PROJECT_A, 'explorer');
    // 预置持久化快照：L3 视图 + 切线 asOf=2（面板关闭期间存留）。
    storage.set(`world_view_state:${normalizeProjectPathForCompare(PROJECT_A.path)}`, {
      ...DEFAULT_VIEW,
      view: 'subject',
      selectedSubjectId: 'character:hero',
      asOfT: 2,
    });

    useTestStore.getState().onWorldPanelVisibility(true);
    await vi.waitFor(() => expect(worldSubjectDetailSpy).toHaveBeenCalledTimes(1));
    expect(worldSubjectDetailSpy).toHaveBeenLastCalledWith({ projectId: 'p-a', subjectId: 'character:hero' });
  });

  it('可见性通知边沿去重：true→true 不重复拉；开→关无动作', async () => {
    seedProject(PROJECT_A, 'explorer');
    useTestStore.getState().onWorldPanelVisibility(true);
    await vi.waitFor(() => expect(worldOverviewSpy).toHaveBeenCalledTimes(1));
    worldOverviewSpy.mockClear();

    useTestStore.getState().onWorldPanelVisibility(true); // 重复通知（App 重挂/StrictMode）
    useTestStore.getState().onWorldPanelVisibility(false); // 开→关
    await sleepPastDebounce();
    expect(worldOverviewSpy).not.toHaveBeenCalled();
  });
});

describe('api 桥缺失显式报错（#5+#102+#210）', () => {
  it('桥整体缺失：load 落 error 态（不再伪装空态/永久骨架）；桥恢复后重试成功', async () => {
    seedProject(PROJECT_A);
    (window as any).orisonDesktop = undefined;
    await useTestStore.getState().loadWorldOverview();

    let st = useTestStore.getState();
    expect(st.worldOverview).toBeNull();
    expect(st.worldOverviewLoading).toBe(false);
    expect(st.worldOverviewError).toBe('desktop bridge unavailable');

    installBridge();
    await useTestStore.getState().loadWorldOverview(true); // 错误卡「重试」通路 = force 重拉
    st = useTestStore.getState();
    expect(st.worldOverview).not.toBeNull();
    expect(st.worldOverviewError).toBeNull();
  });

  it('旧 preload 部分桥（有桥无 world 面）：同样显式报错', async () => {
    seedProject(PROJECT_A);
    (window as any).orisonDesktop = {};
    await useTestStore.getState().loadWorldSliceDetail(3);
    expect(useTestStore.getState().worldSliceDetailError).toBe('desktop bridge unavailable');
  });
});

describe('数据归属竞态（#100+#101）', () => {
  it('非 force 去重含归属：缓存属他项目（reset 未跑到的切换窗口）→ 接管重拉不吞', async () => {
    seedProject(PROJECT_A);
    await useTestStore.getState().loadWorldOverview();
    expect(useTestStore.getState().worldOverviewProjectId).toBe('p-a');
    worldOverviewSpy.mockClear();

    seedProject(PROJECT_B); // 模拟切换窗口（未跑 reset——缓存仍是 p-a 的）
    await useTestStore.getState().loadWorldOverview(); // 非 force——不得被 p-a 缓存去重

    expect(worldOverviewSpy).toHaveBeenCalledTimes(1);
    expect(worldOverviewSpy).toHaveBeenLastCalledWith({ projectId: 'p-b' });
    expect(useTestStore.getState().worldOverviewProjectId).toBe('p-b'); // 归属随数据换代
  });

  it('在途去重含归属：他项目在途不吞当前项目拉取（接管重发，旧请求后到作废）', async () => {
    seedProject(PROJECT_A);
    let resolveA!: () => void;
    worldOverviewSpy.mockImplementationOnce(
      () => new Promise((res) => { resolveA = () => res(overviewFixture()); }),
    );
    const loadA = useTestStore.getState().loadWorldOverview(); // p-a 在途（慢）
    worldOverviewSpy.mockClear();

    seedProject(PROJECT_B);
    await useTestStore.getState().loadWorldOverview(); // 非 force——不得被 p-a 在途去重

    expect(worldOverviewSpy).toHaveBeenCalledTimes(1);
    resolveA();
    await loadA;
    expect(useTestStore.getState().worldOverviewProjectId).toBe('p-b'); // A 后到作废不覆盖
  });

  it('projectId 未注册：load 返回不动——不拉 IPC、不落数据不染假态', async () => {
    seedProject({ path: 'C:\\proj\\gamma', projectId: undefined });
    useTestStore.getState().loadWorldDataForView();
    await sleepPastDebounce();

    expect(worldOverviewSpy).not.toHaveBeenCalled();
    const st = useTestStore.getState();
    expect(st.worldOverview).toBeNull();
    expect(st.worldOverviewLoading).toBe(false);
    expect(st.worldOverviewError).toBeNull();
  });
});

describe('视图态持久化 + 项目隔离（#86 / state-management spec）', () => {
  it('导航与交互 action 持久化视图态；水合在刷新后恢复原视图原状态', () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSlice(5);
    s.setWorldAsOf(2);
    s.setWorldPathFilter('/mood');
    s.toggleWorldAxis('emotional');

    const saved = storage.get<WorldViewState>(
      `world_view_state:${normalizeProjectPathForCompare(PROJECT_A.path)}`,
      DEFAULT_VIEW,
    );
    expect(saved).toEqual({
      view: 'slice',
      viewT: 5,
      selectedSubjectId: null,
      asOfT: 2,
      pathFilter: '/mood',
      axisOn: { ...DEFAULT_VIEW.axisOn, emotional: false },
    });

    // 模拟刷新：新 store 实例（内存回默认）+ 同项目水合 → 视图态恢复。
    const useSecondStore = create<TestState>()((...args) => ({
      currentProject: PROJECT_A,
      activeSidebarPanel: 'world',
      ...createWorldStateSlice(...args),
    }));
    useSecondStore.getState().hydrateWorldViewState();
    expect(useSecondStore.getState().worldView).toEqual(saved);
  });

  it('畸形持久化快照被形态守卫挡下：缺必需字段回默认层', () => {
    seedProject(PROJECT_A);
    storage.set(`world_view_state:${normalizeProjectPathForCompare(PROJECT_A.path)}`, {
      view: 'slice',
      viewT: '不是数字',
      axisOn: '不是对象',
    });

    useTestStore.getState().hydrateWorldViewState();

    // viewT 非法 → null → slice 层级必需字段丢失 → 回 overview 默认态。
    expect(useTestStore.getState().worldView.view).toBe('overview');
    expect(useTestStore.getState().worldView.viewT).toBeNull();
    expect(useTestStore.getState().worldView.axisOn).toEqual(DEFAULT_VIEW.axisOn);
  });

  it('非整数 viewT/asOfT 拒收（#16+#109：storyTime 契约是 int——1.5 放行会在 IPC 边界炸）', () => {
    seedProject(PROJECT_A);
    storage.set(`world_view_state:${normalizeProjectPathForCompare(PROJECT_A.path)}`, {
      ...DEFAULT_VIEW,
      view: 'subject',
      selectedSubjectId: 'character:hero',
      viewT: 1.5,
      asOfT: 2.5,
    });

    useTestStore.getState().hydrateWorldViewState();

    const v = useTestStore.getState().worldView;
    expect(v.viewT).toBeNull(); // 1.5 拒收
    expect(v.asOfT).toBeNull(); // 2.5 拒收
    expect(v.view).toBe('subject'); // subject 层级仍成立（selectedSubjectId 合法）
    expect(v.selectedSubjectId).toBe('character:hero');
  });

  it('项目切换：视图态与三数据缓存全回默认；他项目水合不复活本项目视图', () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSubject('character:hero');
    useTestStore.setState({ worldOverview: overviewFixture(), worldSubjectDetail: subjectDetailFixture() });

    seedProject(PROJECT_B);
    runProjectResets();

    const st = useTestStore.getState();
    expect(st.worldView).toEqual(DEFAULT_VIEW);
    expect(st.worldOverview).toBeNull();
    expect(st.worldOverviewProjectId).toBeNull();
    expect(st.worldSubjectDetail).toBeNull();
    expect(st.worldViewHydratedPath).toBeNull();

    // B 项目水合：B 无快照 → 保持默认（A 的快照只在 A 的键下，无跨项目复活）。
    st.hydrateWorldViewState();
    expect(useTestStore.getState().worldView).toEqual(DEFAULT_VIEW);

    // 切回 A：A 的快照恢复——「刷新/重开回到原视图原状态」按项目成立。
    seedProject(PROJECT_A);
    useTestStore.getState().hydrateWorldViewState();
    expect(useTestStore.getState().worldView.view).toBe('subject');
    expect(useTestStore.getState().worldView.selectedSubjectId).toBe('character:hero');
  });

  it('竞态守卫：await 期间项目已切走 → stale 数据丢弃', async () => {
    seedProject(PROJECT_A);
    let resolveA!: (value: WorldOverview) => void;
    worldOverviewSpy.mockImplementationOnce(() => new Promise<WorldOverview>((res) => { resolveA = res; }));

    const pending = useTestStore.getState().loadWorldOverview();
    seedProject(PROJECT_B);
    resolveA(overviewFixture());
    await pending;

    expect(useTestStore.getState().worldOverview).toBeNull();
  });
});

describe('loadWorldDataForView（打开即拉 + 按当前视图）', () => {
  it('L1：拉 overview（幂等——已装数据不重拉）', async () => {
    seedProject(PROJECT_A);
    useTestStore.getState().loadWorldDataForView();
    expect(worldOverviewSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(useTestStore.getState().worldOverview).not.toBeNull());

    useTestStore.getState().loadWorldDataForView();
    expect(worldOverviewSpy).toHaveBeenCalledTimes(1); // 非强制跳过
  });

  it('恢复到 L3 视图时：水合后按选中主体拉主体详情（as-of 不进请求——切线折叠本地算）', async () => {
    seedProject(PROJECT_A);
    // 预置持久化快照：L3 视图 + 切线 asOf=2（模拟刷新后重开）。
    storage.set(`world_view_state:${normalizeProjectPathForCompare(PROJECT_A.path)}`, {
      ...DEFAULT_VIEW,
      view: 'subject',
      selectedSubjectId: 'character:hero',
      asOfT: 2,
    });

    useTestStore.getState().loadWorldDataForView();
    await vi.waitFor(() => expect(worldSubjectDetailSpy).toHaveBeenCalledTimes(1));
    expect(worldSubjectDetailSpy).toHaveBeenLastCalledWith({ projectId: 'p-a', subjectId: 'character:hero' });
  });

  it('切线零 IPC（契约 CR #4）：切线不进请求面——同主体重复非 force 拉取 → 不重拉', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSubject('character:hero');
    await s.loadWorldSubjectDetail('character:hero');
    worldSubjectDetailSpy.mockClear();

    // 切线回放（asOf 变化）纯本地 reduceSubject 重折叠——slice 拉取面无 as-of 维度，
    // 数据已装后重复非 force 调用走去重，零 IPC。
    await useTestStore.getState().loadWorldSubjectDetail('character:hero');
    await useTestStore.getState().loadWorldSubjectDetail('character:hero');
    expect(worldSubjectDetailSpy).not.toHaveBeenCalled();
  });
});

describe('加载请求接管（supersede）与去重（快速导航竞态守卫）', () => {
  it('L3 在途切换主体：B 的拉取不被 A 的在途吞掉；A 后到 resolve 作废不覆盖 B', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSubject('character:hero');
    // A 慢（手动挂起）、B 快——旧「loading 即丢弃」形态下 B 的调用被直接吞掉（选中是 B、
    // 数据停在 A → ready 永假、骨架卡死）。
    let resolveA!: () => void;
    worldSubjectDetailSpy.mockImplementationOnce(
      () => new Promise((res) => { resolveA = () => res(subjectDetailFixture()); }),
    );
    const loadA = useTestStore.getState().loadWorldSubjectDetail('character:hero');

    useTestStore.getState().goWorldSubject('character:miya');
    await useTestStore.getState().loadWorldSubjectDetail('character:miya');

    expect(worldSubjectDetailSpy).toHaveBeenCalledTimes(2);
    expect(worldSubjectDetailSpy).toHaveBeenNthCalledWith(2, {
      projectId: 'p-a', subjectId: 'character:miya',
    });
    const landed = useTestStore.getState();
    expect(landed.worldSubjectDetailSubjectId).toBe('character:miya');
    expect(landed.worldSubjectDetailLoading).toBe(false);

    // A 后到 resolve：seq 已被 B 接管 → 作废，不覆盖 B 的数据、不清 B 的状态。
    resolveA();
    await loadA;
    expect(useTestStore.getState().worldSubjectDetailSubjectId).toBe('character:miya');
    expect(useTestStore.getState().worldSubjectDetailLoading).toBe(false);
  });

  it('L2 在途切换时点：新时点拉取不被吞掉；旧时点后到作废', async () => {
    seedProject(PROJECT_A);
    const s = useTestStore.getState();
    s.goWorldSlice(1);
    let resolveT1!: () => void;
    worldSliceDetailSpy.mockImplementationOnce(
      () => new Promise((res) => { resolveT1 = () => res({ anchor: anchorFixture(1), groups: [] }); }),
    );
    const loadT1 = useTestStore.getState().loadWorldSliceDetail(1);

    useTestStore.getState().goWorldSlice(3);
    await useTestStore.getState().loadWorldSliceDetail(3);

    expect(worldSliceDetailSpy).toHaveBeenCalledTimes(2);
    expect(useTestStore.getState().worldSliceDetailT).toBe(3);
    resolveT1();
    await loadT1;
    expect(useTestStore.getState().worldSliceDetailT).toBe(3);
  });

  it('同 identity 非 force 重复调用仍去重（StrictMode 双挂载零重复 IPC）', async () => {
    seedProject(PROJECT_A);
    let resolveFirst!: () => void;
    worldOverviewSpy.mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = () => res(overviewFixture()); }),
    );
    const first = useTestStore.getState().loadWorldOverview();
    useTestStore.getState().loadWorldOverview(); // 同项目在途 → 去重
    expect(worldOverviewSpy).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
    expect(useTestStore.getState().worldOverview).not.toBeNull();
  });

  it('force（事件/手动刷新）在途不丢弃：接管旧请求重发，旧请求作废不动 loading', async () => {
    seedProject(PROJECT_A);
    let resolveFirst!: () => void;
    worldOverviewSpy.mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = () => res(overviewFixture()); }),
    );
    const first = useTestStore.getState().loadWorldOverview();
    // 写事件到达（force）——旧形态被 loading 丢弃，数据停在事件前；supersede 形态重发。
    const second = useTestStore.getState().loadWorldOverview(true);
    expect(worldOverviewSpy).toHaveBeenCalledTimes(2);

    resolveFirst();
    await first;
    // 旧请求作废：不写数据、不清 loading（second 仍持有）。
    await second;
    const st = useTestStore.getState();
    expect(st.worldOverview).not.toBeNull();
    expect(st.worldOverviewLoading).toBe(false);
  });
});
