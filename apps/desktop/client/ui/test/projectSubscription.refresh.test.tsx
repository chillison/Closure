import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshProjectDocument } from '../src/shared/store/projectSubscription';

/**
 * dogfood R2 #77：refreshProjectDocument 共用 helper 的双模式语义。
 * - hydrate:true（项目切换流缺省）：restoreProjectTabs + 翻 projectDocumentHydrated +
 *   刷字数；装载失败也翻旗标（防骨架屏卡死）——重构前切换流的逐句行为。
 * - hydrate:false（outline:changed 增量收敛）：不动旗标、不动 tab 布局；失败静默。
 * 用 stub store 直测（不经真实 appStore 切换订阅），readDirectory 空目录使
 * deriveChaptersFromDisk 确定性返回 []。
 */

type StubCalls = {
  loadCreativeFields: ReturnType<typeof vi.fn>;
  setNovelChapters: ReturnType<typeof vi.fn>;
  restoreProjectTabs: ReturnType<typeof vi.fn>;
  refreshWordCount: ReturnType<typeof vi.fn>;
};

function makeStubStore(projectPath: string | null) {
  let state: any = {
    currentProject: projectPath ? { projectId: 'p1', name: 'P', path: projectPath, type: 'novel' } : null,
    projectDocumentHydrated: false,
  };
  const calls: StubCalls = {
    loadCreativeFields: vi.fn(),
    setNovelChapters: vi.fn(),
    restoreProjectTabs: vi.fn(async () => {}),
    refreshWordCount: vi.fn(),
  };
  const store = {
    subscribe: vi.fn(),
    getState: () => ({ ...state, ...calls }),
    setState: (partial: any) => {
      state = { ...state, ...partial };
    },
  };
  return {
    store,
    calls,
    /** 只读裸 state（不含方法桩）——断言旗标用。 */
    rawState: () => state,
  };
}

const DOC = {
  novel: { chapters: [{ id: 'c1', title: 'T', sort_order: 0, sections: [] }] },
};

describe('refreshProjectDocument（R2 #77 共用 helper）', () => {
  beforeEach(() => {
    (window as any).orisonDesktop = {
      loadProjectDocument: vi.fn(async () => DOC),
      // 空目录列表：collectChapterFiles 找不到 chapters 目录 → derive 返回 []（确定性）。
      readDirectory: vi.fn(async () => []),
    };
  });

  afterEach(() => {
    delete (window as any).orisonDesktop;
    vi.restoreAllMocks();
  });

  it('hydrate:false（增量收敛）→ 装载文档+派生章节，不动旗标不动 tab 布局', async () => {
    const { store, calls, rawState } = makeStubStore('/p');
    await refreshProjectDocument(store as any, '/p', { hydrate: false });
    expect(calls.loadCreativeFields).toHaveBeenCalledWith(DOC);
    expect(calls.setNovelChapters).toHaveBeenCalledTimes(1);
    expect(calls.restoreProjectTabs).not.toHaveBeenCalled();
    expect(calls.refreshWordCount).not.toHaveBeenCalled();
    expect(rawState().projectDocumentHydrated).toBe(false);
  });

  it('hydrate 缺省 true（切换流）→ restoreProjectTabs + 翻旗标 + 刷字数', async () => {
    const { store, calls, rawState } = makeStubStore('/p');
    // 切换流真实调用形参就是无 options——按同形调用。
    await refreshProjectDocument(store as any, '/p');
    expect(calls.restoreProjectTabs).toHaveBeenCalledWith('/p');
    expect(calls.refreshWordCount).toHaveBeenCalledTimes(1);
    expect(rawState().projectDocumentHydrated).toBe(true);
  });

  it('装载中切换到别的项目 → 路径守卫丢弃（不跨项目串写）', async () => {
    const { store, calls } = makeStubStore('/p');
    let resolveDoc: (doc: unknown) => void = () => {};
    (window as any).orisonDesktop.loadProjectDocument = vi.fn(
      () => new Promise((resolve) => { resolveDoc = resolve; }),
    );
    const pending = refreshProjectDocument(store as any, '/p', { hydrate: false });
    // 文档回来时项目已切走。
    store.setState({ currentProject: { projectId: 'p2', name: 'Q', path: '/q', type: 'novel' } });
    resolveDoc(DOC);
    await pending;
    expect(calls.loadCreativeFields).not.toHaveBeenCalled();
    expect(calls.setNovelChapters).not.toHaveBeenCalled();
  });

  it('hydrate:false 失败 → 静默丢弃（旗标不翻、不抛）', async () => {
    const { store, rawState } = makeStubStore('/p');
    (window as any).orisonDesktop.loadProjectDocument = vi.fn(async () => {
      throw new Error('disk gone');
    });
    await expect(refreshProjectDocument(store as any, '/p', { hydrate: false })).resolves.toBeUndefined();
    expect(rawState().projectDocumentHydrated).toBe(false);
  });

  it('hydrate:true 失败 → 仍翻旗标（切换流防骨架屏卡死，重构前行为）', async () => {
    const { store, rawState } = makeStubStore('/p');
    (window as any).orisonDesktop.loadProjectDocument = vi.fn(async () => {
      throw new Error('disk gone');
    });
    await expect(refreshProjectDocument(store as any, '/p')).resolves.toBeUndefined();
    expect(rawState().projectDocumentHydrated).toBe(true);
  });

  it('无 loadProjectDocument API → 早退零副作用', async () => {
    delete (window as any).orisonDesktop;
    const { store, calls } = makeStubStore('/p');
    await refreshProjectDocument(store as any, '/p', { hydrate: false });
    expect(calls.loadCreativeFields).not.toHaveBeenCalled();
    expect(calls.setNovelChapters).not.toHaveBeenCalled();
  });
});
