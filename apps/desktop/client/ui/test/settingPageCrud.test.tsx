/**
 * 「设定」页 B 波集成测试（task 08-30-asset-cards-visualization）。
 *
 * 覆盖（dispatch B1-B9）：
 * - **onSave 落盘契约**：CardForm 编辑 → updateField('asset_cards') 收到 raw 直改数组——
 *   目标卡替换、垃圾元素（null/数字）**原样保留**（守卫产物写回会静默删盘上垃圾——
 *   formCardOps CRUD 投影契约的正测）；
 * - 新建（工具栏 8 类菜单 → 骨架卡 append + 选中）；
 * - 删除（全局确认框：取消不删、确认删 + selectedCardId 显式清写 null → 右列空态）；
 * - locked 三态（横幅/只读/禁建；解锁走既有 toggleFieldLock IPC 调用面）；
 * - 文档点击开文件 tab（readFile + openFile 既有通道）；
 * - 总览跳转（人物/地点统计块可点 → setActivePage('setting') + 类型过滤预选）；
 * - 标签中文化冒烟：真 i18n（本文件**不 mock** useI18n，resolvedLocale 钉 zh-CN）——
 *   表单/徽标渲染中文人话非键名（AC7）。
 *
 * mock 形态照 spec/ui/testing.md：真实 useAppStore + 两步落种（先 currentProject 触发
 * projectSubscription reset、后落数据——worldStatePanelL1 谱）+ data-* 测试锚。git API
 * mock 仅为 OverviewPage 渲染（overviewMetaPersistence 谱）。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/api/git', () => ({
  gitIsRepo: vi.fn(async () => false),
  gitLog: vi.fn(async () => []),
  gitCreateNode: vi.fn(async () => undefined),
  gitStatusCount: vi.fn(async () => 0),
}));

import { SettingPage } from '../src/features/setting/SettingPage';
import { OverviewPage } from '../src/features/overview/OverviewPage';
import { useAppStore } from '../src/shared/store/appStore';
import { useConfirmStore } from '../src/shared/store/confirmStore';
import { useToastStore } from '../src/shared/store/toastStore';

const PROTAGONIST = {
  id: 'protagonist',
  type: 'character',
  name: '琉璃月',
  status: 'draft',
  summary: '远古地球「长兔耳族」最后幸存者',
  secrets: { surface: '普通转学生', truth: '全星际最稀有的远古长兔耳族最后幸存者' },
  basics: { gender: '女' },
  personality: { coreTraits: ['警觉', '独立'], surface: '冷淡寡言的转学生' },
  tags: [],
};
const HEROINE = {
  id: 'heroine-two',
  type: 'character',
  name: '铃鹿雪',
  status: 'draft',
  summary: '同桌',
  tags: [],
};

const DEFAULT_VIEW = { selectedCardId: null as string | null, tab: 'cards' as const, typeFilter: 'all' as const };

function seedState(cards: unknown, overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN', // 真 i18n 中文渲染（AC7 冒烟）
    activePage: 'overview',
    mainView: 'page',
    agentPanelOpen: false,
  } as any);
  useAppStore.setState({
    creativeFields: { asset_cards: cards },
    fieldMetadata: {},
    novelChapters: [],
    projectWordCount: 0,
    openFiles: [],
    settingView: { ...DEFAULT_VIEW, ...((overrides.settingView as object) ?? {}) },
    settingViewHydratedPath: '/proj-1',
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'settingView')),
  } as any);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  useAppStore.setState({
    activePage: 'overview',
    mainView: 'page',
    agentPanelOpen: false,
    currentProject: null,
    creativeFields: {},
    fieldMetadata: {},
    settingView: { ...DEFAULT_VIEW },
    settingViewHydratedPath: null,
    openFiles: [],
    activeFilePath: null,
  } as any);
  useConfirmStore.getState().resolveConfirm(false); // 挂起确认兜底清态
  delete (window as any).orisonDesktop;
});

describe('onSave 落盘契约（B1 + dispatch 契约 2：垃圾元素保留）', () => {
  it('表单编辑 → updateField 收到 raw 直改数组：目标卡替换、垃圾/兄弟卡原样保留', () => {
    const cards = [PROTAGONIST, HEROINE, null, 42];
    seedState(cards);
    const { container } = render(<SettingPage />);

    // 选中 protagonist → 卡头 name（名称）改值 blur。
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);
    const nameInput = container.querySelector('.card-form-name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '琉璃月（真名）' } });
    fireEvent.blur(nameInput);

    const next = useAppStore.getState().creativeFields.asset_cards as unknown[];
    expect(next).toHaveLength(4);
    expect((next[0] as { name: string }).name).toBe('琉璃月（真名）');
    expect((next[0] as { id: string }).id).toBe('protagonist');
    // 🔑 垃圾元素保留（raw 直改——守卫产物写回会静默删除盘上垃圾）。
    expect(next[2]).toBeNull();
    expect(next[3]).toBe(42);
    // 兄弟卡不动（引用原对象）。
    expect(next[1]).toBe(HEROINE);
  });

  it('CR P17：卡名清空/纯空白 blur —— 回显旧名，不落盘不改头显', () => {
    seedState([PROTAGONIST]);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);
    const nameInput = container.querySelector('.card-form-name') as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: '' } });
    fireEvent.blur(nameInput);
    expect(nameInput.value).toBe('琉璃月'); // 回显旧值
    expect((useAppStore.getState().creativeFields.asset_cards as Array<{ name: string }>)[0].name)
      .toBe('琉璃月'); // 不落盘

    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.blur(nameInput);
    expect(nameInput.value).toBe('琉璃月');
    expect((useAppStore.getState().creativeFields.asset_cards as Array<{ name: string }>)[0].name)
      .toBe('琉璃月');
  });

  it('CR P19：删除竞态——表单滞留编辑时卡已被删，blur 保存被丢弃（不 append 复活）', () => {
    seedState([PROTAGONIST, HEROINE]);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);

    // 模拟 agent 删卡：store 数据翻新为只剩 HEROINE（表单仍滞留 protagonist 编辑面）。
    act(() => {
      useAppStore.setState({ creativeFields: { asset_cards: [HEROINE] } } as any);
    });

    const nameInput = container.querySelector('.card-form-name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '迟到的编辑' } });
    fireEvent.blur(nameInput);

    const next = useAppStore.getState().creativeFields.asset_cards as Array<{ id: string; name: string }>;
    expect(next).toHaveLength(1); // 无 append——已删卡不复活
    expect(next[0].id).toBe('heroine-two');
  });

  it('status 离散即存走同一投影（change 即存不待 blur）', () => {
    seedState([PROTAGONIST]);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'active' } });

    const next = useAppStore.getState().creativeFields.asset_cards as Array<{ status: string }>;
    expect(next[0].status).toBe('active');
  });

  it('CR P13：tier 为 null（yaml 空值）——未标钮 aria-checked=true（三态不再零选中）', () => {
    seedState([{ ...PROTAGONIST, tier: null }]);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);

    const radios = container.querySelectorAll('.card-form-tier [role="radio"]');
    expect(radios).toHaveLength(3);
    expect(radios[0].getAttribute('aria-checked')).toBe('true'); // 未标（含 null 判定）
    expect(radios[1].getAttribute('aria-checked')).toBe('false');
    expect(radios[2].getAttribute('aria-checked')).toBe('false');
    // 未标 + 结构默认 core：核心钮带「默认」角标。
    expect(radios[1].textContent).toContain('默认');
  });

  it('CR P7：卡内 relationships 只读占位——逐条摘要 + 后置说明，不做编辑', () => {
    const card = {
      ...PROTAGONIST,
      relationships: [
        { targetId: 'heroine-two', relationType: 'romance', label: '同桌→CP' },
        { targetId: 'little-sister', relationType: 'family' },
        'garbage-entry', // 元素级防御：非对象边丢弃不炸
      ],
    };
    seedState([card, HEROINE]);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);

    const sect = container.querySelector('.card-form-sect-relationships') as HTMLElement;
    expect(sect).not.toBeNull();
    expect(sect.querySelector('.card-form-sect-header')?.textContent).toContain('关系');
    const items = sect.querySelectorAll('.card-form-rel-item');
    expect(items).toHaveLength(2); // 垃圾边丢弃
    expect(items[0].textContent).toContain('heroine-two');
    expect(items[0].textContent).toContain('romance');
    expect(items[0].textContent).toContain('同桌→CP');
    expect(items[1].textContent).toContain('little-sister');
    expect(sect.querySelector('.card-form-rel-hint')?.textContent)
      .toContain('图形化视图'); // 「后置」语义文案（zh 真渲染）
  });

  it('CR P7 对照：无 relationships 的卡不渲染关系区', () => {
    seedState([PROTAGONIST]);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);
    expect(container.querySelector('.card-form-sect-relationships')).toBeNull();
  });
});

describe('新建（B3：8 类菜单 → 骨架卡 append + 选中）', () => {
  it('工具栏新建 → 8 类菜单 → 选人物：骨架卡（card- id/draft/未命名）append + 选中进表单', () => {
    seedState([PROTAGONIST, HEROINE]);
    const { container } = render(<SettingPage />);

    fireEvent.click(container.querySelector('[data-setting-new-card]')!);
    const items = container.querySelectorAll('[data-new-card-type]');
    expect(items).toHaveLength(8);
    fireEvent.click(container.querySelector('[data-new-card-type="character"]')!);

    const next = useAppStore.getState().creativeFields.asset_cards as Array<{ id: string; type: string; name: string; status: string }>;
    expect(next).toHaveLength(3);
    const skeleton = next[2];
    expect(skeleton.id).toMatch(/^card-[a-z0-9]{6}$/);
    expect(skeleton.type).toBe('character');
    expect(skeleton.name).toBe('未命名'); // i18n 骨架名（zh）
    expect(skeleton.status).toBe('draft');
    expect(useAppStore.getState().settingView.selectedCardId).toBe(skeleton.id);
    // 选中跟随：右列 CardForm 切到新卡（key=card.id 清草稿血缘）。
    const nameInput = container.querySelector('.card-form-name') as HTMLInputElement;
    expect(nameInput.value).toBe('未命名');
  });

  it('新建骨架 id 与现存 id 不撞车（重摇）', () => {
    // 占满 6 位 base36 常见撞车位不现实——此测守 contract：id 前缀 + 长度 + 唯一性。
    const cards = [PROTAGONIST];
    seedState(cards);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-new-card]')!);
    fireEvent.click(container.querySelector('[data-new-card-type="rule"]')!);
    const next = useAppStore.getState().creativeFields.asset_cards as Array<{ id: string }>;
    expect(new Set(next.map((c) => c.id)).size).toBe(next.length);
  });
});

describe('删除（B3：确认框 + 显式清写选中）', () => {
  it('确认框显卡名；取消不删；确认后数组落盘 + selectedCardId 显式 null + 右列空态', async () => {
    seedState([PROTAGONIST, HEROINE]);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);

    // 删除按钮 → 全局确认框（App 级 ConfirmDialog 的 store 面）。
    fireEvent.click(screen.getByRole('button', { name: '删除这张卡' }));
    const confirmState = useConfirmStore.getState();
    expect(confirmState.confirmOpen).toBe(true);
    expect(confirmState.confirmOptions?.message).toContain('琉璃月'); // deleteConfirm {name} 插值
    expect(confirmState.confirmOptions?.variant).toBe('danger');

    // 取消 → 不删。
    act(() => { useConfirmStore.getState().resolveConfirm(false); });
    expect((useAppStore.getState().creativeFields.asset_cards as unknown[]).length).toBe(2);

    // 再删 → 确认 → 数组 -1 + 选中显式清写 null + 右列空态提示。
    fireEvent.click(screen.getByRole('button', { name: '删除这张卡' }));
    await act(async () => { useConfirmStore.getState().resolveConfirm(true); });
    const next = useAppStore.getState().creativeFields.asset_cards as Array<{ id: string }>;
    expect(next.map((c) => c.id)).toEqual(['heroine-two']);
    expect(useAppStore.getState().settingView.selectedCardId).toBeNull();
    expect(container.querySelector('.setting-selecthint')).not.toBeNull();
    expect(container.querySelector('.card-form')).toBeNull();
  });
});

describe('locked（B4：field 级锁三态）', () => {
  const LOCKED_META = {
    asset_cards: { version: 1, source: 'user', locked: true, dependsOn: [], stale: false },
  };

  it('未锁：无横幅，表单可编辑，新建可点（对照态）', () => {
    seedState([PROTAGONIST]);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);

    expect(container.querySelector('[data-setting-locked]')).toBeNull();
    expect((container.querySelector('.card-form-name') as HTMLInputElement).disabled).toBe(false);
    expect((container.querySelector('[data-setting-new-card]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('已锁：横幅 + 表单只读 + 删除钮隐藏 + 新建禁用', () => {
    seedState([PROTAGONIST]);
    useAppStore.setState({ fieldMetadata: LOCKED_META } as any);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);

    const banner = container.querySelector('[data-setting-locked]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('设定卡已被锁定'); // 真 zh 文案（非键名）
    expect((container.querySelector('.card-form-name') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '删除这张卡' })).toBeNull();
    expect((container.querySelector('[data-setting-new-card]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('解锁钮走既有 toggleFieldLock IPC 调用面（PatchReviewPanel 字段锁同通道）', () => {
    seedState([PROTAGONIST]);
    useAppStore.setState({ fieldMetadata: LOCKED_META } as any);
    const toggleIpc = vi.fn(async () => null);
    (window as any).orisonDesktop = { toggleFieldLock: toggleIpc };
    const { container } = render(<SettingPage />);

    fireEvent.click(screen.getByRole('button', { name: '解锁' }));

    // IPC 入参（projectPath, 'asset_cards'）+ 乐观翻转 → 横幅退场、恢复可编辑。
    expect(toggleIpc).toHaveBeenCalledWith('/proj-1', 'asset_cards');
    expect(container.querySelector('[data-setting-locked]')).toBeNull();
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);
    expect((container.querySelector('.card-form-name') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('文档区块（B7：点击开文件 tab；CR P15 读失败兜底）', () => {
  it('点击文档行 → readFile + openFile 既有通道 → 文件 tab 激活', async () => {
    seedState([PROTAGONIST]);
    const readFile = vi.fn(async () => '# 风格基准');
    (window as any).orisonDesktop = {
      readDirectory: vi.fn(async () => [
        { name: 'style.md', path: '/style.md', isDir: false },
      ]),
      readFile,
    };
    const { container } = render(<SettingPage />);
    // 读目录 IPC 异步——等一拍让 docs tab 可见性落定。
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(container.querySelector('[data-setting-tab="docs"]')!);

    fireEvent.click(await screen.findByText('style'));

    await act(async () => { await Promise.resolve(); });
    expect(readFile).toHaveBeenCalledWith('/proj-1/settings/style.md');
    const state = useAppStore.getState();
    expect(state.activeFilePath).toBe('/proj-1/settings/style.md');
    expect(state.mainView).toBe('files');
    const tab = state.openFiles.find((f) => f.path === '/proj-1/settings/style.md');
    expect(tab?.content).toBe('# 风格基准');
    expect(tab?.name).toBe('style.md');
  });

  it('CR P13/P15：读失败（null/异常）不开空 tab 不新建 md——错误 toast + tab 不开', async () => {
    for (const readFile of [
      vi.fn(async () => null), // 瞬态失败（文件占用等）
      vi.fn(async () => { throw new Error('io'); }),
    ]) {
      cleanup();
      seedState([PROTAGONIST]);
      (window as any).orisonDesktop = {
        readDirectory: vi.fn(async () => [
          { name: 'style.md', path: '/style.md', isDir: false },
        ]),
        readFile,
      };
      const { container } = render(<SettingPage />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(container.querySelector('[data-setting-tab="docs"]')!);
      fireEvent.click(await screen.findByText('style'));
      await act(async () => { await Promise.resolve(); });

      const state = useAppStore.getState();
      // tab 不开（不落空文件/不新建 md——空 tab 一保存会截断有内容 md）。
      expect(state.openFiles).toHaveLength(0);
      expect(state.activeFilePath).toBeNull();
      expect(state.mainView).toBe('page');
      // 失败反馈：全库 toast 通道（error 级，zh 文案带文件名）。
      const toast = useToastStore.getState().toasts.at(-1);
      expect(toast?.level).toBe('error');
      expect(toast?.message).toContain('style.md');
    }
  });
});

describe('总览跳转（B8：统计块可点 → 设定页；CR P12/P20 修订）', () => {
  it('人物数/地点数统计块可点 → setActivePage("setting") + 类型过滤预选', () => {
    seedState([
      PROTAGONIST,
      HEROINE,
      { id: 'school', type: 'location', name: '星舰学园', status: 'draft' },
    ]);
    render(<OverviewPage />);

    fireEvent.click(document.querySelector('[data-overview-jump="character"]')!);
    expect(useAppStore.getState().activePage).toBe('setting');
    expect(useAppStore.getState().settingView.typeFilter).toBe('character');

    fireEvent.click(document.querySelector('[data-overview-jump="location"]')!);
    expect(useAppStore.getState().activePage).toBe('setting');
    expect(useAppStore.getState().settingView.typeFilter).toBe('location');
  });

  it('CR P20：地点数全来自 legacy world_setting 回退（无 location 卡）——跳转不预选（落 all）', () => {
    seedState([PROTAGONIST], {
      creativeFields: {
        asset_cards: [PROTAGONIST],
        world_setting: { era: '近未来', locations: [{ name: '星舰学园' }, { name: '旧城区' }] },
      },
    });
    render(<OverviewPage />);

    // 地点统计块有数（legacy 回退 = 2），但设定页没有 location 卡。
    const locationBlock = document.querySelector('[data-overview-jump="location"]')!;
    expect(locationBlock.textContent).toContain('2');

    fireEvent.click(locationBlock);
    expect(useAppStore.getState().activePage).toBe('setting');
    // 不预选 location（死过滤静默错位）——显式落 all。
    expect(useAppStore.getState().settingView.typeFilter).toBe('all');
  });

  it('CR P12：Space 键 preventDefault（div 默认滚动）+ 长按 repeat 不连跳', () => {
    seedState([PROTAGONIST]);
    render(<OverviewPage />);
    const block = document.querySelector('[data-overview-jump="character"]')! as HTMLElement;

    const down = (opts: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, ...opts });
      block.dispatchEvent(e);
      return e;
    };

    const first = down({});
    expect(first.defaultPrevented).toBe(true); // Space 默认页面滚动被拦
    expect(useAppStore.getState().activePage).toBe('setting');

    // repeat 长按：不再触发跳转（activePage 已变，验证 setSettingTypeFilter 不被连发——
    // 经 filter 值稳定性断言）。
    useAppStore.getState().setSettingTypeFilter('golden_finger'); // 打标
    act(() => { useAppStore.setState({ activePage: 'overview' } as any); });
    down({ repeat: true });
    expect(useAppStore.getState().activePage).toBe('overview'); // repeat 被拦
    expect(useAppStore.getState().settingView.typeFilter).toBe('golden_finger'); // 未被 repeat 改写
  });
});

describe('标签中文化冒烟（B2/AC7：真 t 渲染非键名）', () => {
  it('选中已知卡：组名/字段名/类型徽标/tier/status 全中文人话，零键名露出', () => {
    seedState([PROTAGONIST]);
    const { container } = render(<SettingPage />);
    fireEvent.click(container.querySelector('[data-setting-card-id="protagonist"]')!);

    // 组名（主显组默认展开）：性格 / 秘密；次显折叠头：基本信息 / 卡面信息。
    expect(screen.getByRole('button', { name: '性格' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '秘密' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '基本信息' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '卡面信息' })).toBeInTheDocument();
    // 字段名（主显组内）：核心性格（chips）/ 表层表现 / 核心欲望。
    expect(within(document.querySelector('.card-form-sect-secrets') as HTMLElement).getByLabelText('表面')).toBeInTheDocument();
    expect(within(document.querySelector('.card-form-sect-secrets') as HTMLElement).getByLabelText('真相')).toBeInTheDocument();
    // 卡头：类型徽标「人物」/ status select 现值「草稿」/ tier 未标显「核心（默认）」。
    expect(container.querySelector('.card-form-type-badge')?.textContent).toBe('人物');
    expect((screen.getByRole('combobox') as HTMLSelectElement).selectedOptions[0].textContent).toBe('草稿');
    const formEl = container.querySelector('.card-form') as HTMLElement;
    expect(within(formEl).getAllByText('默认').length).toBeGreaterThan(0); // 左列行徽标同词——表单内定界
    // 零键名露出（真 t 通道断言——缺键/路由错会显 settingPage.* 裸键）。
    expect(container.textContent).not.toContain('settingPage.field.');
    expect(container.textContent).not.toContain('settingPage.group.');
  });
});
