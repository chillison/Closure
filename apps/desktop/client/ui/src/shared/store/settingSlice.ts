/**
 * 「设定」页 slice（task 08-30-asset-cards-visualization A1 波）。
 *
 * 持有页面交互态（design §3）：选中卡 id / 左列 tab（设定卡|设定文档）/ 类型过滤选择。
 * 搜索词与折叠态是纯渲染 affordance，留组件局部 useState（mirror worldStateSlice 纪律）。
 *
 * 持久化（#86 教训——刷新/重开不丢）：交互态按项目路径键控持久化到 localStorage
 * （storage.ts 既有 persist 先例；键含归一化项目路径 → 切项目不复活他项目的视图态，
 * 满足 state-management spec「持久化字段 × 项目隔离」纪律——reset 只清内存，storage
 * 各项目只读自己的键）。水合 fail-soft：storage 读回经元素级形态守卫（unknown seam
 * 纪律——localStorage 是不可信边界），畸形/旧版快照逐字段回落默认，不炸页面。
 *
 * 数据零缓存：卡数据走 creativeFieldsSlice.creativeFields.asset_cards（outline:changed
 * → refreshProjectDocument 现行链自动翻新，research §3.4——本 slice 不拉任何 IPC）。
 */
import type { StateCreator } from 'zustand';
import { assetCardTypeSchema } from '@orison/shared-contracts';
import { registerProjectReset } from './resetRegistry';
import { storage } from './storage';
import { normalizeProjectPathForCompare } from './projectRunBusy';

/** 左列双 tab（W0 mockup 用户拍板默认案）：设定卡 / 设定文档（W5 交付文档列表）。 */
export type SettingPageTab = 'cards' | 'docs';

/**
 * 类型过滤值：'all' | 8 类卡 type | 'other'（未知/越界 type 的防御归组——research §3.5
 * legacy `type:'image'` 卡实证）。8 类枚举单源 = shared-contracts assetCardTypeSchema。
 */
const CARD_TYPE_VALUES: readonly string[] = assetCardTypeSchema.options;
export type SettingTypeFilter = 'all' | 'other' | (typeof assetCardTypeSchema.options)[number];

/** 页面交互态（嵌套单字段 `settingView`，便于整体持久化/重置——mirror worldView）。 */
export type SettingViewState = {
  /** 选中的卡 id；null = 未选（页面派生回落首行，不回写 store）。 */
  selectedCardId: string | null;
  tab: SettingPageTab;
  typeFilter: SettingTypeFilter;
};

const DEFAULT_VIEW_STATE: SettingViewState = {
  selectedCardId: null,
  tab: 'cards',
  typeFilter: 'all',
};

const VIEW_STATE_KEY_PREFIX = 'setting_view_state:';

/** 持久化键 = 前缀 + 归一化项目路径（projectRunBusy 单源归一——Windows 斜杠/盘符大小写
 *  漂移不会裂成两个键；mirror worldStateSlice viewStateStorageKey）。 */
function viewStateStorageKey(projectPath: string): string {
  return VIEW_STATE_KEY_PREFIX + normalizeProjectPathForCompare(projectPath);
}

function persistViewState(state: SettingViewState, projectPath: string | null | undefined): void {
  if (!projectPath) return;
  storage.set(viewStateStorageKey(projectPath), state);
}

function coerceSettingTypeFilter(raw: unknown): SettingTypeFilter {
  if (raw === 'all' || raw === 'other') return raw;
  return CARD_TYPE_VALUES.includes(raw as string) ? (raw as SettingTypeFilter) : 'all';
}

/**
 * storage 读回形态守卫（fail-soft）：元素级校验，缺字段/类型错逐项回落默认，
 * 未知键丢弃。返回 null = 无可用快照（落默认值）。
 */
function coerceSavedViewState(raw: unknown): SettingViewState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    selectedCardId: typeof r.selectedCardId === 'string' && r.selectedCardId.length > 0
      ? r.selectedCardId
      : null,
    tab: r.tab === 'docs' ? 'docs' : 'cards',
    typeFilter: coerceSettingTypeFilter(r.typeFilter),
  };
}

export type SettingSlice = {
  settingView: SettingViewState;
  /** 视图态已为哪个项目路径水合过（防重复读 storage；项目切换 reset 清空）。 */
  settingViewHydratedPath: string | null;

  selectSettingCard: (id: string | null) => void;
  setSettingTab: (tab: SettingPageTab) => void;
  setSettingTypeFilter: (filter: SettingTypeFilter) => void;
  /** 从 storage 水合当前项目的视图态（每项目一次幂等；无快照落默认值）。 */
  hydrateSettingViewState: () => void;
};

type Deps = SettingSlice & {
  currentProject: { path: string } | null;
};

export const createSettingSlice: StateCreator<Deps, [], [], SettingSlice> = (set, get) => {
  /**
   * 交互 action 公共落点：改视图态 + 同步持久化（视图态过刷新存活，#86）。
   *
   * 未水合先水合守卫（CR P2①）：页面未挂载/未水合时外部 set action（总览统计块跳转
   * setSettingTypeFilter 预选）若直接叠加在内存默认态上，会把已持久化快照（选中卡/
   * tab/过滤）整体覆盖——先读回本项目 storage 基线再叠加 partial，并顺带落水合标记
   * （后续挂载水合幂等 no-op）。
   */
  const applyView = (partial: Partial<SettingViewState>) => {
    const projectPath = (get() as Deps).currentProject?.path;
    const hydrated = typeof projectPath === 'string'
      && get().settingViewHydratedPath === projectPath;
    const base = hydrated
      ? get().settingView
      : (projectPath
          ? coerceSavedViewState(storage.get<unknown>(viewStateStorageKey(projectPath), null))
          : null) ?? { ...DEFAULT_VIEW_STATE };
    const settingView = { ...base, ...partial };
    persistViewState(settingView, projectPath);
    set(
      projectPath && !hydrated
        ? { settingView, settingViewHydratedPath: projectPath }
        : { settingView },
    );
  };

  // 项目隔离（state-management spec）：选中卡/tab/过滤是 project-scoped 视图态，切项目
  // 一律回默认。storage 不动——按项目键控，他项目只读自己的键，无跨项目复活路径。
  registerProjectReset(() => {
    set({
      settingView: { ...DEFAULT_VIEW_STATE },
      settingViewHydratedPath: null,
    });
  });

  return {
    settingView: { ...DEFAULT_VIEW_STATE },
    settingViewHydratedPath: null,

    selectSettingCard: (id) => applyView({ selectedCardId: id }),
    setSettingTab: (tab) => applyView({ tab }),
    setSettingTypeFilter: (filter) => applyView({ typeFilter: filter }),

    hydrateSettingViewState: () => {
      const projectPath = (get() as Deps).currentProject?.path;
      if (!projectPath) return;
      if (get().settingViewHydratedPath === projectPath) return;
      const saved = coerceSavedViewState(
        storage.get<unknown>(viewStateStorageKey(projectPath), null),
      );
      set({
        // 无快照也标记已水合并落默认值——后续交互 action 直接增量持久化。
        settingViewHydratedPath: projectPath,
        settingView: saved ?? { ...DEFAULT_VIEW_STATE },
      });
    },
  };
};
