/**
 * dogfood 2026-08-21：HMR 重执行 appStore 后 project 订阅断流回归。
 *
 * 复现（用户实录）：改 i18n yaml（被 5 个 slice import）→ vite 把 slice→appStore
 * 整链拖入失效重执行 → 全新 store 实例。projectSubscription.ts 是 appStore 的
 * **依赖**（非 importer），不随之失效——旧模块级 `installed` flag 让
 * installProjectSubscription 对新 store 直接 early-return：新 store 永远收不到
 * 切换事件，loadCreativeFields 不跑，总览承诺区全空（盘上数据完好）。
 * 修复：WeakSet 按 store 实例判重 + prevProject 收进闭包。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installProjectSubscription } from '../src/shared/store/projectSubscription';

type FakeStore = {
  subscribe: (l: (s: any) => void) => () => void;
  getState: () => any;
  setState: (partial: any) => void;
};

function makeStore() {
  const listeners = new Set<(s: any) => void>();
  const state = {
    currentProject: null as any,
    addRecentProject: vi.fn(),
    loadBgTasks: vi.fn(),
    loadCreativeFields: vi.fn(),
    setNovelChapters: vi.fn(),
    restoreProjectTabs: vi.fn().mockResolvedValue(undefined),
    refreshWordCount: vi.fn(),
  };
  const store: FakeStore = {
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    getState: () => state,
    setState: (partial) => { Object.assign(state, partial); listeners.forEach((l) => l(state)); },
  };
  return { store, state };
}

const project = { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' };

beforeEach(() => {
  (window as any).orisonDesktop = {
    loadProjectDocument: vi.fn().mockResolvedValue({ meta: {}, novel: { chapters: [] } }),
  };
});

afterEach(() => {
  delete (window as any).orisonDesktop;
});

describe('installProjectSubscription 按 store 实例判重（HMR 断流回归）', () => {
  it('同一 store 重复 install 幂等（只挂一个订阅）', () => {
    const { store } = makeStore();
    installProjectSubscription(store);
    installProjectSubscription(store);
    store.setState({ currentProject: project });
    expect((window as any).orisonDesktop.loadProjectDocument).toHaveBeenCalledTimes(1);
  });

  it('新 store 实例（模拟 HMR 重执行 appStore）重跑 install → 订阅生效、水合触发', async () => {
    const a = makeStore();
    installProjectSubscription(a.store);
    a.store.setState({ currentProject: project });
    expect((window as any).orisonDesktop.loadProjectDocument).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(a.state.loadCreativeFields).toHaveBeenCalledTimes(1));

    // 模拟 HMR：appStore.ts 失效重执行 → 全新 store 实例 + 模块 scope 重跑 install。
    const b = makeStore();
    installProjectSubscription(b.store);
    b.store.setState({ currentProject: project });
    // 旧 flag 版在此断流：install early-return，setState 无人监听，水合永远不跑。
    await vi.waitFor(() => expect(b.state.loadCreativeFields).toHaveBeenCalledTimes(1));
    expect((window as any).orisonDesktop.loadProjectDocument).toHaveBeenCalledTimes(2);
  });
});
