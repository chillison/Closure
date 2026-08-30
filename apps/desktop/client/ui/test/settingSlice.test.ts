/**
 * settingSlice 状态机测试（task 08-30-asset-cards-visualization A1 波）。
 *
 * 覆盖：
 * - 交互 action（选中卡/tab/类型过滤）落 settingView + 同步持久化（视图态过刷新存活
 *   #86——按项目路径键控 localStorage）；
 * - 水合：刷新后读回快照恢复；幂等（每项目一次）；无项目路径 no-op；
 * - 水合 fail-soft：storage 畸形/旧版快照（非对象/数组/字段类型错/越界过滤值）逐项
 *   回落默认，不炸页面（unknown seam 元素级守卫纪律）；
 * - 项目隔离：registerProjectReset 清内存态；切项目后水合只读新项目的键——他项目
 *   持久化的选中卡不复活（state-management spec「持久化 × 项目隔离」）。
 *
 * 形态照 spec/ui/testing.md：最小组合 store（只装被测 slice + currentProject），
 * runProjectResets 直接调验证重置（worldStateSlice.test 谱）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { create } from 'zustand';
import {
  createSettingSlice,
  type SettingSlice,
  type SettingViewState,
} from '../src/shared/store/settingSlice';
import { runProjectResets } from '../src/shared/store/resetRegistry';
import { storage } from '../src/shared/store/storage';
import { normalizeProjectPathForCompare } from '../src/shared/store/projectRunBusy';

type TestState = SettingSlice & {
  currentProject: { path: string } | null;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  ...createSettingSlice(...args),
}));

const DEFAULT_VIEW: SettingViewState = {
  selectedCardId: null,
  tab: 'cards',
  typeFilter: 'all',
};

const PROJECT_A = { path: 'C:\\proj\\alpha' };
const PROJECT_B = { path: '/proj/beta' };

function seedProject(project: { path: string } | null) {
  useTestStore.setState({
    currentProject: project,
    settingView: { ...DEFAULT_VIEW },
    settingViewHydratedPath: null,
  });
}

function storedView(projectPath: string): unknown {
  return storage.get<unknown>(`setting_view_state:${normalizeProjectPathForCompare(projectPath)}`, null);
}

beforeEach(() => {
  localStorage.clear();
  seedProject(PROJECT_A);
});

describe('交互 action：改视图态 + 同步持久化（#86）', () => {
  it('selectSettingCard / setSettingTab / setSettingTypeFilter 落 state + storage', () => {
    useTestStore.getState().selectSettingCard('protagonist');
    useTestStore.getState().setSettingTab('docs');
    useTestStore.getState().setSettingTypeFilter('golden_finger');

    expect(useTestStore.getState().settingView).toEqual({
      selectedCardId: 'protagonist',
      tab: 'docs',
      typeFilter: 'golden_finger',
    });
    // 持久化键 = 前缀 + 归一化路径（Windows 反斜杠/盘符大小写不裂键）。
    expect(storedView(PROJECT_A.path)).toEqual({
      selectedCardId: 'protagonist',
      tab: 'docs',
      typeFilter: 'golden_finger',
    });
  });

  it('无项目路径时 action 只改内存不写 storage（无键可挂）', () => {
    seedProject(null);
    useTestStore.getState().selectSettingCard('x');
    expect(useTestStore.getState().settingView.selectedCardId).toBe('x');
    expect(localStorage.length).toBe(0);
  });

  it('CR P2①：未水合时外部 set action（总览跳转预选）先读回持久化基线——已存快照不被默认态覆盖', () => {
    // 已持久化快照：选中卡 + docs tab + character 过滤（模拟此前会话的视图态）。
    useTestStore.getState().selectSettingCard('protagonist');
    useTestStore.getState().setSettingTab('docs');
    useTestStore.getState().setSettingTypeFilter('character');
    // 模拟「页面未挂载/未水合」：内存态回默认、水合标记清空（storage 快照仍在）。
    useTestStore.setState({ settingView: { ...DEFAULT_VIEW }, settingViewHydratedPath: null });

    // 外部 set（总览统计块跳转预选——发生在设定页挂载/水合之前）。
    useTestStore.getState().setSettingTypeFilter('golden_finger');

    // 叠加在持久化基线上：选中卡/tab 保留，仅过滤被预选覆盖；水合标记顺带落定。
    expect(useTestStore.getState().settingView).toEqual({
      selectedCardId: 'protagonist',
      tab: 'docs',
      typeFilter: 'golden_finger',
    });
    expect(useTestStore.getState().settingViewHydratedPath).toBe(PROJECT_A.path);
    // storage 同步为叠加后的完整视图态（不丢字段）。
    expect(storedView(PROJECT_A.path)).toEqual({
      selectedCardId: 'protagonist',
      tab: 'docs',
      typeFilter: 'golden_finger',
    });
    // 后续挂载水合幂等 no-op（已被外部 set 落定，不再读 storage 覆盖）。
    useTestStore.getState().hydrateSettingViewState();
    expect(useTestStore.getState().settingView.typeFilter).toBe('golden_finger');
  });

  it('CR P2①：无快照项目未水合 set —— 落默认基线叠加 + 持久化（新项目首交互即建快照）', () => {
    seedProject(PROJECT_B);
    useTestStore.getState().setSettingTab('docs');
    expect(useTestStore.getState().settingView).toEqual({ ...DEFAULT_VIEW, tab: 'docs' });
    expect(useTestStore.getState().settingViewHydratedPath).toBe(PROJECT_B.path);
    expect(storedView(PROJECT_B.path)).toEqual({ ...DEFAULT_VIEW, tab: 'docs' });
  });
});

describe('水合（hydrateSettingViewState）', () => {
  it('读回快照恢复视图态（刷新存活）+ 标记已水合路径', () => {
    useTestStore.getState().selectSettingCard('protagonist');
    useTestStore.getState().setSettingTypeFilter('character');
    // 模拟刷新：内存态回默认，再水合。
    useTestStore.setState({ settingView: { ...DEFAULT_VIEW }, settingViewHydratedPath: null });

    useTestStore.getState().hydrateSettingViewState();

    expect(useTestStore.getState().settingView).toEqual({
      selectedCardId: 'protagonist',
      tab: 'cards',
      typeFilter: 'character',
    });
    expect(useTestStore.getState().settingViewHydratedPath).toBe(PROJECT_A.path);
  });

  it('幂等：已水合项目不重读 storage（水合标记后的 storage 变化不回灌）', () => {
    useTestStore.getState().hydrateSettingViewState();
    // 水合后再落一份新快照——二次 hydrate 应 no-op。
    storage.set(`setting_view_state:${normalizeProjectPathForCompare(PROJECT_A.path)}`, {
      selectedCardId: 'other-card',
      tab: 'docs',
      typeFilter: 'all',
    });
    useTestStore.getState().hydrateSettingViewState();
    expect(useTestStore.getState().settingView.selectedCardId).toBeNull();
  });

  it('无快照 → 落默认值并标记已水合', () => {
    useTestStore.getState().hydrateSettingViewState();
    expect(useTestStore.getState().settingView).toEqual(DEFAULT_VIEW);
    expect(useTestStore.getState().settingViewHydratedPath).toBe(PROJECT_A.path);
  });

  it('无项目路径 → no-op（不读 storage 不落水合标记）', () => {
    seedProject(null);
    useTestStore.getState().hydrateSettingViewState();
    expect(useTestStore.getState().settingViewHydratedPath).toBeNull();
  });

  it('fail-soft：畸形快照逐项回落默认（非对象/数组/字段类型错/越界过滤值）', () => {
    const key = `setting_view_state:${normalizeProjectPathForCompare(PROJECT_A.path)}`;
    for (const bad of [
      'just-a-string',
      42,
      [1, 2],
      {},
      { selectedCardId: 123, tab: 'weird', typeFilter: 'bogus' },
      { selectedCardId: '', typeFilter: 'image' },
    ]) {
      storage.set(key, bad);
      useTestStore.setState({ settingView: { ...DEFAULT_VIEW }, settingViewHydratedPath: null });
      useTestStore.getState().hydrateSettingViewState();
      // 逐字段守卫：合法字段保留（typeFilter:'image' 越界回 'all'），其余回落默认——
      // 不炸页面、不落 undefined 进 state。
      expect(useTestStore.getState().settingView).toEqual(DEFAULT_VIEW);
    }
  });

  it('fail-soft：快照内合法字段保留、畸形字段单独回落', () => {
    const key = `setting_view_state:${normalizeProjectPathForCompare(PROJECT_A.path)}`;
    storage.set(key, { selectedCardId: 'protagonist', tab: true, typeFilter: 99 });
    useTestStore.getState().hydrateSettingViewState();
    expect(useTestStore.getState().settingView).toEqual({
      selectedCardId: 'protagonist',
      tab: 'cards',
      typeFilter: 'all',
    });
  });
});

describe('项目隔离（state-management spec）', () => {
  it('registerProjectReset：切项目清内存视图态 + 水合标记', () => {
    useTestStore.getState().selectSettingCard('protagonist');
    useTestStore.getState().setSettingTab('docs');
    runProjectResets();
    expect(useTestStore.getState().settingView).toEqual(DEFAULT_VIEW);
    expect(useTestStore.getState().settingViewHydratedPath).toBeNull();
  });

  it('切项目水合只读新项目的键——他项目持久化选中卡不复活', () => {
    useTestStore.getState().selectSettingCard('protagonist');
    // 切项目：reset（projectSubscription 语义）+ 换 currentProject + 水合。
    runProjectResets();
    seedProject(PROJECT_B);
    useTestStore.getState().hydrateSettingViewState();
    expect(useTestStore.getState().settingView).toEqual(DEFAULT_VIEW);
    // A 项目的快照仍在自己的键下（不被 reset 破坏）。
    expect(storedView(PROJECT_A.path)).toEqual({ selectedCardId: 'protagonist', tab: 'cards', typeFilter: 'all' });
  });

  it('同项目重开（路径归一差异形态）读回同一键', () => {
    useTestStore.getState().selectSettingCard('protagonist');
    // 同项目换路径形态（尾斜杠 + 反斜杠 + 盘符大小写）→ 归一后同键。
    seedProject({ path: 'c:/proj/alpha/' });
    useTestStore.getState().hydrateSettingViewState();
    expect(useTestStore.getState().settingView.selectedCardId).toBe('protagonist');
  });
});
