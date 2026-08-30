/**
 * 世界状态面板 slice（dogfood R2 #92，task 08-29-world-state-panel S3）。
 *
 * 三级视图状态机（design v2「视图模型」）：
 *   L1 overview（默认）→ L2 slice（某 storyTime 的世界切片）→ L3 subject（主体脊柱）。
 * 状态 = `{view, viewT, selectedSubjectId, asOfT, axisOn, pathFilter}`（嵌套单字段
 * `worldView`，便于整体持久化/重置）+ 三份数据缓存（overview / sliceDetail /
 * subjectDetail，各带 loading/error + **数据归属 projectId**）。
 *
 * 关键不变式（prd「实时数据交互」+ design「交互质量不变式」）：
 * 1. **交互状态与数据刷新解耦**：`world:changed` 事件只按当前视图重拉受影响数据，
 *    view/viewT/selectedSubjectId/asOfT/axisOn/pathFilter 一律不动（#86）。
 * 2. **视图状态过刷新存活**（#86）：交互态按项目路径键控持久化到 localStorage
 *    （storage.ts 既有 persist 先例；键含归一化项目路径 → 切项目不复活他项目的
 *    视图态，满足 state-management spec「持久化字段 × 项目隔离」纪律——reset 只清
 *    内存，storage 各项目只读自己的键）。数据缓存不持久化（重开时按视图重拉）。
 * 3. **过滤/钻取/as-of/层级切换纯本地零 IPC**：导航 action 只改内存 + 写 storage，
 *    不发任何 IPC；IPC 拉取仅四种时机——进视图（loadWorldDataForView）/ world:changed
 *    事件（可见性门控 + debounce，见下）/ 面板打开补偿（onWorldPanelVisibility）/
 *    手动刷新（force）。
 * 4. 竞态守卫（三闸）：每个 load 在 await 后重检 currentProject（项目切换期间在途
 *    resolve 丢弃，mirror projectSubscription 纪律）+ **请求接管（supersede）**——导航/
 *    事件触发的新请求按 identity 接管在途旧请求：旧请求 resolve 后 seq 对账作废，不
 *    覆盖新请求的数据、不动 loading。旧形态「loading 即丢弃」在快速切换主体/时点时会把
 *    B 的拉取吞进 A 的在途（选中已是 B、数据停在 A → ready 永假、骨架卡死），且两个
 *    在途乱序 resolve 会后写覆盖——supersede 双向根治。同 identity 非 force 的重复调用
 *    仍去重（StrictMode 双挂载零重复 IPC）。+ **数据归属闸（#100+#101）**——缓存携带
 *    落地时的 projectId，非 force 去重只在「归属 = 当前项目 或 归属未知（直种/旧态）」
 *    时生效：归属明确属他项目（reset 尚未跑到的切换窗口）→ 不去重、接管重拉；
 *    projectId 未注册时 load 返回不动（不拉 IPC、不落数据——不渲染假态，待注册后由
 *    既有挂载/事件 effect 重触发）。
 *
 * 事件响应（#2+#107+#201+#17，CR 批）：
 * - **可见性门控**：handleWorldChanged 仅在 `activeSidebarPanel === 'world'`
 *   （panelsSlice 状态，slice 内 get() 读 merged store——不绑组件局部 state）时响应：
 *   面板关闭时写章链逐 slice 事件不再触发全量重拉 IPC 风暴。聚合窗到期时二次门控
 *   （窗内面板切走 → 丢弃本窗不补拉）。
 * - **debounce**：增量类事件（slice-written/amendment）连发合并——首条到达开 150ms
 *   固定聚合窗（trailing），窗内后续事件并入，到期按**并集**重拉一次（窗内任一事件
 *   命中当前 viewT/subjectId 即刷新——只留最后一条会漏掉中间命中事件）。固定窗
 *   （非每条重置）保证持续事件流不会饿死永不触发。
 * - **backfill/reset 立即**：终态类事件不走 debounce——到达即全量重拉一次，同时丢弃
 *   在途聚合窗（全量语义已覆盖增量）。
 * - **打开补偿**：事件可丢（门控/窗口丢弃）的读侧兜底——面板关→开边沿 force 重拉
 *   当前视图数据（onWorldPanelVisibility，App.tsx 按 activeSidebarPanel 接线通知）。
 *
 * 订阅组织（mirror updateSlice.subscribeUpdateEvents）：App 挂载时调
 * subscribeWorldEvents() 一次，模块级桥订阅 app 生命周期常驻；桥缺失（S2 preload
 * 未接线/旧 preload）时静默跳过——面板照常手动刷新，不因缺事件面报错。**注册成功才
 * 置旗标**（#12）：半残桥 onWorldChanged 抛错时旗标保持 false、下次调用可重试（吞错
 * 不炸 App 引导 effect，与桥缺面同策略）。
 */
import type { StateCreator } from 'zustand';
import type {
  WorldChangedEvent,
  WorldOverview,
  WorldPatchAxis,
  WorldSliceDetail,
  WorldSubjectDetail,
} from '@orison/shared-contracts';
import type { SidebarPanel } from './types';
import { registerProjectReset } from './resetRegistry';
import { storage } from './storage';
import { normalizeProjectPathForCompare } from './projectRunBusy';
import {
  fetchWorldOverview,
  fetchWorldSliceDetail,
  fetchWorldSubjectDetail,
} from '../api/worldState';

// ── 视图状态机 ──

/** 三级缩放视图（design「视图模型」；L2/L3 渲染在 S5，状态机本 slice 先行就位）。 */
export type WorldView = 'overview' | 'slice' | 'subject';

/** 五轴全集（镜像 worldPatchAxisSchema；UI 遍历用，避免散落字面量）。 */
export const WORLD_AXES: readonly WorldPatchAxis[] = [
  'physical',
  'cognitive',
  'emotional',
  'relational',
  'factional',
];

/** 轴开关（Record 而非 Set——JSON 持久化天然安全，O(1) 判定）。 */
export type WorldAxisToggles = Record<WorldPatchAxis, boolean>;

/**
 * 视图状态默认值。DRY 单源（mirror structureSlice DEFAULT_OVERLAY_TOGGLES 先例）：
 * registerProjectReset 与 slice 初始值同引此处，加字段不会漂移。asOfT/pathFilter 缺省
 * null = 现在 / 无钻取；axisOn 缺省全开（容忍缺轴是数据层契约：缺轴计 0，非 UI 预设）。
 */
const DEFAULT_AXIS_ON: WorldAxisToggles = {
  physical: true,
  cognitive: true,
  emotional: true,
  relational: true,
  factional: true,
};

export type WorldViewState = {
  view: WorldView;
  /** L2 锚定的 storyTime（场锚点，非章号）。 */
  viewT: number | null;
  /** L3 选中的主体 id。 */
  selectedSubjectId: string | null;
  /** L3 as-of 截断 storyTime；null = 现在（缺省语义单源在 worldSubjectDetailRequestSchema）。 */
  asOfT: number | null;
  /** L3 快照键钻取（JSON Pointer path；null = 无钻取）。 */
  pathFilter: string | null;
  axisOn: WorldAxisToggles;
};

const DEFAULT_VIEW_STATE: WorldViewState = {
  view: 'overview',
  viewT: null,
  selectedSubjectId: null,
  asOfT: null,
  pathFilter: null,
  axisOn: { ...DEFAULT_AXIS_ON },
};

// ── 持久化（视图状态过刷新存活，#86）──

const VIEW_STATE_KEY_PREFIX = 'world_view_state:';

/** 持久化键 = 前缀 + 归一化项目路径（projectRunBusy 单源归一——Windows 斜杠/盘符大小写
 *  漂移不会裂成两个键）。按项目键控 → 项目隔离由键空间保证，见文件头注 2。 */
function viewStateStorageKey(projectPath: string): string {
  return VIEW_STATE_KEY_PREFIX + normalizeProjectPathForCompare(projectPath);
}

function persistViewState(state: WorldViewState, projectPath: string | null | undefined): void {
  if (!projectPath) return;
  storage.set(viewStateStorageKey(projectPath), state);
}

/**
 * storage 读回形态守卫（unknown seam 纪律：localStorage 是不可信边界，畸形/旧版快照
 * 不得直灌 state——元素级校验，缺字段回落默认，axisOn 逐轴验 boolean 后与全集合并，
 * 未知键丢弃）。返回 null = 无可用快照。
 *
 * viewT/asOfT 判定用 `Number.isInteger`（#16+#109）：storyTime 契约是
 * `z.number().int()`——非整数（如 1.5）放行会在 IPC 边界炸（schema 校验 reject），
 * 读回即拒、回落 null。
 */
function coerceSavedViewState(raw: unknown): WorldViewState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const viewT = typeof r.viewT === 'number' && Number.isInteger(r.viewT) ? r.viewT : null;
  const selectedSubjectId = typeof r.selectedSubjectId === 'string' && r.selectedSubjectId.length > 0
    ? r.selectedSubjectId
    : null;
  // 层级必需字段丢失 → 回默认层（不出「slice 视图无锚点」这类自相矛盾态）。
  let view: WorldView = r.view === 'slice' || r.view === 'subject' ? r.view : 'overview';
  if (view === 'slice' && viewT === null) view = 'overview';
  if (view === 'subject' && selectedSubjectId === null) view = 'overview';
  const axisOn = { ...DEFAULT_AXIS_ON };
  if (r.axisOn && typeof r.axisOn === 'object') {
    const saved = r.axisOn as Record<string, unknown>;
    for (const axis of WORLD_AXES) {
      if (typeof saved[axis] === 'boolean') axisOn[axis] = saved[axis] as boolean;
    }
  }
  return {
    view,
    viewT,
    selectedSubjectId,
    asOfT: typeof r.asOfT === 'number' && Number.isInteger(r.asOfT) ? r.asOfT : null,
    pathFilter: typeof r.pathFilter === 'string' && r.pathFilter.length > 0 ? r.pathFilter : null,
    axisOn,
  };
}

// ── 事件影响判定（design「面板响应」；纯函数便于单测与 Wave 3 复用）──

/**
 * L2 当前时点是否受事件影响：slice-written/amendment 且 sliceT 命中当前 viewT，或
 * backfill/reset 全量（清切面后锚点聚合必变）。amendment 写入也落 slice——design 字面
 * 只列 slice-written/backfill/reset，这里按「amendment 必带 sliceT 命中才重拉」收窄，
 * 不会全量误拉。
 */
export function worldEventAffectsSlice(event: WorldChangedEvent, viewT: number): boolean {
  if (event.kind === 'backfill' || event.kind === 'reset') return true;
  return event.sliceT === viewT;
}

/**
 * L3 选中主体是否受事件影响：backfill/reset 全量保守重拉（subjectIds 不填）；否则
 * 看 subjectIds 是否包含选中主体（slice-written/amendment 填）。
 */
export function worldEventAffectsSubject(event: WorldChangedEvent, subjectId: string): boolean {
  if (event.kind === 'backfill' || event.kind === 'reset') return true;
  return event.subjectIds?.includes(subjectId) ?? false;
}

/**
 * world:changed 增量事件（slice-written/amendment）的固定聚合窗时长（trailing debounce，
 * #2+#107+#201）。导出供测试对表（窗后断言/跨测排干），勿内联字面量。
 */
export const WORLD_EVENT_DEBOUNCE_MS = 150;

// ── slice ──

export type WorldStateSlice = {
  /** 三级视图状态机（交互态全量；持久化面 = 本字段整体）。 */
  worldView: WorldViewState;
  /** 视图态已为哪个项目路径水合过（防重复读 storage；项目切换 reset 清空）。 */
  worldViewHydratedPath: string | null;

  // 三数据缓存（project-scoped，不持久化）。*ProjectId = 数据归属（#100：非 force
  // 去重判定含归属；null = 无缓存或直种态无归属信息）。
  worldOverview: WorldOverview | null;
  worldOverviewProjectId: string | null;
  worldOverviewLoading: boolean;
  worldOverviewError: string | null;
  worldSliceDetail: WorldSliceDetail | null;
  /** worldSliceDetail 属于哪个 viewT（判「当前视图数据是否已装」用）。 */
  worldSliceDetailT: number | null;
  worldSliceDetailProjectId: string | null;
  worldSliceDetailLoading: boolean;
  worldSliceDetailError: string | null;
  worldSubjectDetail: WorldSubjectDetail | null;
  /** worldSubjectDetail 属于哪个主体。 */
  worldSubjectDetailSubjectId: string | null;
  /**
   * **vestigial（恒 null，契约 CR #4 后不再被写）**：通道不收 as-of 截断点（载荷 = 全史
   * patches），as-of 归属 UI 本地折叠。字段保留占位兼容既有 seed/消费面（无读者）。
   */
  worldSubjectDetailProjectId: string | null;
  worldSubjectDetailLoading: boolean;
  worldSubjectDetailError: string | null;

  /** 事件订阅已挂（App 引导期一次；桥缺失时保持 false 不重试报错）。 */
  worldEventsSubscribed: boolean;
  /**
   * 面板可见性（App.tsx 按 `activeSidebarPanel === 'world'` 接线通知）。只用于关→开
   * 补偿的边沿检测——事件门控本身读 activeSidebarPanel 单源，不依赖本字段（两者由
   * 同一接线保持一致）。跨项目切换不重置：activeSidebarPanel 本就不随项目 reset。
   */
  worldPanelVisible: boolean;

  // 导航 actions（纯本地零 IPC——只改内存 + 写 storage）
  goWorldOverview: () => void;
  goWorldSlice: (t: number) => void;
  goWorldSubject: (subjectId: string) => void;
  setWorldAsOf: (t: number | null) => void;
  setWorldPathFilter: (path: string | null) => void;
  toggleWorldAxis: (axis: WorldPatchAxis) => void;

  // 数据 actions
  /** 面板挂载/项目切换后调：先水合视图态再按当前视图拉数（幂等，加载中跳过）。 */
  loadWorldDataForView: () => void;
  /** force = 事件驱动/手动刷新（已装数据也重拉）；在途加载中跳过。 */
  loadWorldOverview: (force?: boolean) => Promise<void>;
  loadWorldSliceDetail: (t: number, force?: boolean) => Promise<void>;
  /**
   * `at` 参数已废弃（契约 CR #4，通道不收 as-of——切线折叠 UI 本地重算）；参数位保留
   * 为既有调用面形参兼容，值被忽略。去重键只看 subjectId。
   */
  loadWorldSubjectDetail: (subjectId: string, force?: boolean) => Promise<void>;
  /** 从 storage 水合当前项目的视图态（每项目一次；无快照落默认值）。 */
  hydrateWorldViewState: () => void;
  /** App 引导期挂 world:changed 订阅（mirror subscribeUpdateEvents）。 */
  subscribeWorldEvents: () => void;
  /** 事件处理（订阅回调入口；独立暴露供测试直调）。 */
  handleWorldChanged: (event: WorldChangedEvent) => void;
  /**
   * 面板可见性通知（App.tsx 接线：activeSidebarPanel 变化时调）。关→开边沿 force 重拉
   * 当前视图数据——面板关闭期间被可见性门控丢弃的 world:changed 事件的读侧补偿
   * （事件可丢，读侧兜底）。开→关无动作。
   */
  onWorldPanelVisibility: (visible: boolean) => void;
};

type Deps = WorldStateSlice & {
  currentProject: { projectId?: string; path: string } | null;
  /** panelsSlice 状态（事件可见性门控单源；最小组合测试 store 须随附本字段）。 */
  activeSidebarPanel: SidebarPanel;
};

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 非 force 去重的归属判定（#100+#101）：归属 = 当前项目 或 归属未知（null——直种/旧态
 * 缓存，如测试 seedState）→ 可去重；归属明确属他项目（reset 尚未跑到的切换窗口）→
 * 不去重（接管重拉），防止他项目缓存吞掉当前项目的拉取。
 */
function ownedByCurrent(cachedProjectId: string | null, projectId: string): boolean {
  return cachedProjectId === null || cachedProjectId === projectId;
}

export const createWorldStateSlice: StateCreator<Deps, [], [], WorldStateSlice> = (set, get) => {
  // 请求接管（supersede）记账（闭包级，随 slice 创建一次，见文件头注 4）：seq 单调递增，
  // 在途请求被新请求接管后按 seq 作废；inFlight 记当前在途 identity——同 identity 非
  // force 重复调用去重（零重复 IPC），不同 identity（导航/项目切换）直接接管。
  let overviewReqSeq = 0;
  let overviewInFlight: { seq: number; projectId: string } | null = null;
  let sliceReqSeq = 0;
  let sliceInFlight: { seq: number; projectId: string; t: number } | null = null;
  let subjectReqSeq = 0;
  let subjectInFlight: { seq: number; projectId: string; subjectId: string } | null = null;

  // world:changed 增量事件聚合窗（#2+#107+#201：可见性门控 + 连发合并，见文件头注）。
  // 固定窗：首条事件开窗，窗内后续并入不重置——持续事件流不会饿死（每条重置的经典
  // trailing 会永不触发）。
  let burstEvents: WorldChangedEvent[] | null = null;
  let burstTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelBurst = () => {
    if (burstTimer !== null) {
      clearTimeout(burstTimer);
      burstTimer = null;
    }
    burstEvents = null;
  };

  const fireBurst = () => {
    burstTimer = null;
    const events = burstEvents;
    burstEvents = null;
    if (events === null || events.length === 0) return;
    // 窗口期内面板可能已切走——执行时二次门控，丢弃本窗（不补拉：重新打开面板由
    // onWorldPanelVisibility(true) 的 force 补偿兜底）。
    if ((get() as Deps).activeSidebarPanel !== 'world') return;
    const s = get();
    // L1 + 选择区 chrome：恒重拉（轻查询——listLastPatchFacts 投影，design 权衡）。
    void get().loadWorldOverview(true);
    // L2/L3：窗内**任一**事件命中当前交互态才重拉（并集判定——只看最后一条会漏中间
    // 命中事件），且用**当前**交互态（viewT/selected/asOf）作参数——交互状态与数据
    // 刷新解耦（design 交互质量不变式 1/#86）。
    const viewT = s.worldView.viewT;
    const selectedSubjectId = s.worldView.selectedSubjectId;
    if (s.worldView.view === 'slice' && viewT !== null
      && events.some((e) => worldEventAffectsSlice(e, viewT))) {
      void get().loadWorldSliceDetail(viewT, true);
    }
    if (s.worldView.view === 'subject' && selectedSubjectId !== null
      && events.some((e) => worldEventAffectsSubject(e, selectedSubjectId))) {
      // as-of 不进请求（契约 CR #4：载荷与切线无关，切线折叠 UI 本地重算）。
      void get().loadWorldSubjectDetail(selectedSubjectId, true);
    }
  };

  /** 按当前视图拉三通道（打开即拉 force=false 走去重；事件/补偿/手动 force=true 接管重拉）。 */
  const refreshForCurrentView = (force: boolean) => {
    void get().loadWorldOverview(force);
    const s = get();
    if (s.worldView.view === 'slice' && s.worldView.viewT !== null) {
      void get().loadWorldSliceDetail(s.worldView.viewT, force);
    }
    if (s.worldView.view === 'subject' && s.worldView.selectedSubjectId !== null) {
      void get().loadWorldSubjectDetail(s.worldView.selectedSubjectId, force);
    }
  };

  /** 导航/交互 action 的公共落点：改视图态 + 同步持久化（交互态过刷新存活，#86）。 */
  const applyView = (partial: Partial<WorldViewState>) => {
    const projectPath = (get() as Deps).currentProject?.path;
    set((s) => {
      const worldView = { ...s.worldView, ...partial };
      persistViewState(worldView, projectPath);
      return { worldView };
    });
  };

  // 项目隔离（state-management spec）：视图态（选中主体/锚定/切线）与三数据缓存全部
  // project-scoped，切项目一律回默认。storage 不动——按项目键控，他项目只读自己的键，
  // 无跨项目复活路径（spec 反模式「reset 清内存不清 storage → 重启读回旧值」不成立）。
  // worldPanelVisible 不重置：它镜像 activeSidebarPanel（panelsSlice 的项目 reset 不清
  // 它），重置反而会在面板持续可见时制造假边沿。
  registerProjectReset(() => {
    set({
      worldView: { ...DEFAULT_VIEW_STATE, axisOn: { ...DEFAULT_AXIS_ON } },
      worldViewHydratedPath: null,
      worldOverview: null,
      worldOverviewProjectId: null,
      worldOverviewLoading: false,
      worldOverviewError: null,
      worldSliceDetail: null,
      worldSliceDetailT: null,
      worldSliceDetailProjectId: null,
      worldSliceDetailLoading: false,
      worldSliceDetailError: null,
      worldSubjectDetail: null,
      worldSubjectDetailSubjectId: null,
      worldSubjectDetailProjectId: null,
      worldSubjectDetailLoading: false,
      worldSubjectDetailError: null,
    });
  });

  return {
    worldView: { ...DEFAULT_VIEW_STATE, axisOn: { ...DEFAULT_AXIS_ON } },
    worldViewHydratedPath: null,

    worldOverview: null,
    worldOverviewProjectId: null,
    worldOverviewLoading: false,
    worldOverviewError: null,
    worldSliceDetail: null,
    worldSliceDetailT: null,
    worldSliceDetailProjectId: null,
    worldSliceDetailLoading: false,
    worldSliceDetailError: null,
    worldSubjectDetail: null,
    worldSubjectDetailSubjectId: null,
    worldSubjectDetailProjectId: null,
    worldSubjectDetailLoading: false,
    worldSubjectDetailError: null,

    worldEventsSubscribed: false,
    worldPanelVisible: false,

    // 导航语义照 v3 mockup（用户拍板形态）：goSlice/goSubject 清切线与钻取、保留轴开关；
    // goOverview 只回层级，保留 viewT/selected（原地返回上下文，不销毁）。
    goWorldOverview: () => applyView({ view: 'overview' }),
    goWorldSlice: (t) => applyView({ view: 'slice', viewT: t, asOfT: null, pathFilter: null }),
    goWorldSubject: (subjectId) => applyView({ view: 'subject', selectedSubjectId: subjectId, asOfT: null, pathFilter: null }),
    setWorldAsOf: (t) => applyView({ asOfT: t }),
    setWorldPathFilter: (path) => applyView({ pathFilter: path }),
    toggleWorldAxis: (axis) => {
      const cur = get().worldView.axisOn;
      applyView({ axisOn: { ...cur, [axis]: !cur[axis] } });
    },

    hydrateWorldViewState: () => {
      const projectPath = (get() as Deps).currentProject?.path;
      if (!projectPath) return;
      if (get().worldViewHydratedPath === projectPath) return;
      const saved = coerceSavedViewState(
        storage.get<unknown>(viewStateStorageKey(projectPath), null),
      );
      set({
        // 无快照也标记已水合并落默认值——后续导航 action 直接增量持久化。
        worldViewHydratedPath: projectPath,
        worldView: saved ?? { ...DEFAULT_VIEW_STATE, axisOn: { ...DEFAULT_AXIS_ON } },
      });
    },

    loadWorldDataForView: () => {
      get().hydrateWorldViewState();
      refreshForCurrentView(false);
    },

    async loadWorldOverview(force = false) {
      const projectId = (get() as Deps).currentProject?.projectId;
      // projectId 未注册（#101）：返回不动——不拉 IPC、不落数据不染假态；待注册后由
      // 既有挂载/事件 effect 重触发。
      if (!projectId) return;
      const s = get();
      // 非 force 去重含数据归属（#100）：缓存属他项目（reset 未跑到的切换窗口）不去重。
      if (!force && s.worldOverview !== null && ownedByCurrent(s.worldOverviewProjectId, projectId)) return;
      // 同 identity（项目）在途去重；他项目在途 → 接管（归属不符不去重）。
      if (!force && overviewInFlight !== null && overviewInFlight.projectId === projectId) return;
      const seq = ++overviewReqSeq;
      overviewInFlight = { seq, projectId };
      set({ worldOverviewLoading: true, worldOverviewError: null });
      try {
        const overview = await fetchWorldOverview(projectId);
        // 接管/项目双闸：await 期间有更新请求接管或项目已切走——本请求作废，不写状态。
        if (seq !== overviewReqSeq) return;
        if ((get() as Deps).currentProject?.projectId !== projectId) return;
        set({ worldOverview: overview, worldOverviewProjectId: projectId, worldOverviewLoading: false });
      } catch (err) {
        if (seq !== overviewReqSeq) return;
        if ((get() as Deps).currentProject?.projectId !== projectId) return;
        set({ worldOverviewLoading: false, worldOverviewError: errorReason(err) });
      } finally {
        if (overviewInFlight?.seq === seq) overviewInFlight = null;
      }
    },

    async loadWorldSliceDetail(t, force = false) {
      const projectId = (get() as Deps).currentProject?.projectId;
      if (!projectId) return; // #101：未注册返回不动（同 loadWorldOverview）
      const s = get();
      if (!force
        && s.worldSliceDetail !== null
        && s.worldSliceDetailT === t
        && ownedByCurrent(s.worldSliceDetailProjectId, projectId)) return;
      if (!force && sliceInFlight !== null && sliceInFlight.projectId === projectId && sliceInFlight.t === t) {
        return;
      }
      const seq = ++sliceReqSeq;
      sliceInFlight = { seq, projectId, t };
      set({ worldSliceDetailLoading: true, worldSliceDetailError: null });
      try {
        const detail = await fetchWorldSliceDetail(projectId, t);
        if (seq !== sliceReqSeq) return;
        if ((get() as Deps).currentProject?.projectId !== projectId) return;
        set({
          worldSliceDetail: detail,
          worldSliceDetailT: t,
          worldSliceDetailProjectId: projectId,
          worldSliceDetailLoading: false,
        });
      } catch (err) {
        if (seq !== sliceReqSeq) return;
        if ((get() as Deps).currentProject?.projectId !== projectId) return;
        set({ worldSliceDetailLoading: false, worldSliceDetailError: errorReason(err) });
      } finally {
        if (sliceInFlight?.seq === seq) sliceInFlight = null;
      }
    },

    /**
     * L3 主体详情拉取。**`at` 参数已废弃（契约 CR #4）**：通道不收 as-of 截断点（载荷 =
     * 全史 patches，与切线无关——切线回放的快照折叠/issues 全部 UI 本地重算，切线零
     * IPC）。参数位保留只为既有调用面形参兼容（组件按 `(subjectId, asOfT)` 形态调用），
     * 值被忽略；去重/接管键只看 subjectId（同主体不同 as-of 不重拉）。
     */
    async loadWorldSubjectDetail(subjectId, force = false) {
      const projectId = (get() as Deps).currentProject?.projectId;
      if (!projectId) return; // #101：未注册返回不动（同 loadWorldOverview）
      const s = get();
      if (
        !force
        && s.worldSubjectDetail !== null
        && ownedByCurrent(s.worldSubjectDetailProjectId, projectId)
        && s.worldSubjectDetailSubjectId === subjectId
      ) return;
      if (
        !force
        && subjectInFlight !== null
        && subjectInFlight.projectId === projectId
        && subjectInFlight.subjectId === subjectId
      ) return;
      const seq = ++subjectReqSeq;
      subjectInFlight = { seq, projectId, subjectId };
      set({ worldSubjectDetailLoading: true, worldSubjectDetailError: null });
      try {
        const detail = await fetchWorldSubjectDetail(projectId, subjectId);
        if (seq !== subjectReqSeq) return;
        if ((get() as Deps).currentProject?.projectId !== projectId) return;
        set({
          worldSubjectDetail: detail,
          worldSubjectDetailSubjectId: subjectId,
          worldSubjectDetailProjectId: projectId,
          worldSubjectDetailLoading: false,
        });
      } catch (err) {
        if (seq !== subjectReqSeq) return;
        if ((get() as Deps).currentProject?.projectId !== projectId) return;
        set({ worldSubjectDetailLoading: false, worldSubjectDetailError: errorReason(err) });
      } finally {
        if (subjectInFlight?.seq === seq) subjectInFlight = null;
      }
    },

    subscribeWorldEvents: () => {
      if (get().worldEventsSubscribed) return;
      const bridge = window.orisonDesktop;
      if (!bridge?.onWorldChanged) return; // 桥缺面（S2 未接线/旧 preload）——静默，手动刷新兜底
      try {
        bridge.onWorldChanged((event) => {
          get().handleWorldChanged(event);
        });
        // #12：注册成功才置旗标——半残桥 onWorldChanged 抛错时旗标保持 false，下次可重试。
        set({ worldEventsSubscribed: true });
      } catch {
        // 吞错不炸 App 引导 effect（与桥缺面同策略：读侧手动刷新兜底；下次调用可重试）。
      }
    },

    handleWorldChanged: (event) => {
      // 可见性门控（#2）：面板不可见不响应——写章链逐 slice 事件的 IPC 风暴由可见性截断；
      // 关闭期间的数据陈旧由 onWorldPanelVisibility(true) 的 force 补偿兜底。
      if ((get() as Deps).activeSidebarPanel !== 'world') return;
      const projectId = (get() as Deps).currentProject?.projectId;
      // 他项目的事件（多窗口/后台写）与本面板无关——不过滤会把别的项目数据拉进当前视图。
      if (!projectId || event.projectId !== projectId) return;
      if (event.kind === 'backfill' || event.kind === 'reset') {
        // 终态类：立即全量重拉一次；在途聚合窗丢弃（全量语义已覆盖增量）。
        cancelBurst();
        refreshForCurrentView(true);
        return;
      }
      // 增量类（slice-written/amendment）：并入固定 150ms 聚合窗（窗已开则并入不重置），
      // 到期并集判定重拉（fireBurst）。
      (burstEvents ??= []).push(event);
      if (burstTimer === null) {
        burstTimer = setTimeout(fireBurst, WORLD_EVENT_DEBOUNCE_MS);
      }
    },

    onWorldPanelVisibility: (visible) => {
      // 边沿触发：重复通知（false→false / true→true）无动作。
      if (visible === get().worldPanelVisible) return;
      set({ worldPanelVisible: visible });
      if (!visible) return; // 开→关无动作（事件门控读 activeSidebarPanel，与此处无关）
      // 关→开补偿：事件可丢（门控/窗口丢弃）的读侧兜底——force 重拉当前视图数据。
      // 先水合（幂等）：lazy Suspense 窗口期面板挂载 effect 可能尚未跑，视图态先就位。
      get().hydrateWorldViewState();
      refreshForCurrentView(true);
    },
  };
};
