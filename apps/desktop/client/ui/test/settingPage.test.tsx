/**
 * 「设定」页读面测试（task 08-30-asset-cards-visualization A1 波；B 波语义更新）。
 *
 * 覆盖：
 * - 导航接线：setActivePage('setting') → WorkspaceLayout switch 渲染 SettingPage（懒加载）；
 * - 零卡空态（空数组/缺 asset_cards 键/非数组脏值三态同形）+ 双 CTA（找 AI 建 → 打开
 *   工作台；手动新建 → 8 类建卡菜单[B 波]）；
 * - 分组渲染：8 类 schema 序分组 + 组头计数 + 类型过滤 chips（计数/全部/其他）；
 * - tier 徽标：未标显 resolveTier 结构默认（character/golden_finger → core，
 *   location → micro）+「默认」角标；显式标注无角标；
 * - status 徽标（draft 缺省回落）；
 * - 未知/越界 type 防御：归「其他」组 + 点击右列只读 JSON pretty + 提示；元素级垃圾
 *   （null/数字/字符串）不崩不渲染（unknown seam 元素级守卫）；
 * - 过滤：chip 点击写 store + 列表收窄；持久化死过滤（所指组无卡）回落全部；
 * - 搜索：name/summary/tags 纯前端过滤；
 * - 左列双 tab：docs tab = settings/*.md 真列表（B 波）+ 空目录隐藏；
 * - 选中（B 波语义）：null = 未选（右列提示空态，无行高亮）；点击行写 store；
 *   持久化 id 失效 → 派生回落首行（不回写）。
 *
 * CRUD/locked/onSave 契约/总览跳转集成见 test/settingPageCrud.test.tsx（真 i18n）。
 * mock 形态照 spec/ui/testing.md：真实 useAppStore + 两步落种（先 currentProject 触发
 * projectSubscription reset、后落数据——worldStatePanelL1 谱）+ useI18n mock（t 返回
 * 键名——本文件断言不依赖翻译文案）+ data-* 测试锚（无 store action spy）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    t: (key: string) => key,
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

import { SettingPage } from '../src/features/setting/SettingPage';
import { WorkspaceLayout } from '../src/widgets/layout/WorkspaceLayout';
import { useAppStore } from '../src/shared/store/appStore';

// ── fixtures：dogfood 真卡形态（research §2.1——character×3 + golden_finger×1，
// tier 全未标，一张「（待补）」半成品）。unknown seam 之下是普通对象，不做类型断言。 ──

const DOGFOOD_CARDS = [
  {
    id: 'protagonist',
    type: 'character',
    name: '琉璃月',
    status: 'draft',
    summary: '远古地球「长兔耳族」最后幸存者，伪装成普通转学生',
    secrets: { surface: '普通转学生', truth: '全星际最稀有的远古长兔耳族最后幸存者' },
    basics: { gender: '女', age: '外表约 16-17 岁', race: '长兔耳族', occupation: '转学生' },
    personality: {
      coreTraits: ['警觉', '独立', '外冷内软'],
      surface: '冷淡寡言的转学生',
      innerTruth: '渴望被接纳却不敢靠近',
    },
    desireAndBottomline: {
      coreDesire: '作为普通人活下去',
      coreFear: '身份暴露后被当作实验体',
      oocAnchors: ['绝不主动伤人', '紧张时摸耳朵'],
    },
    background: { keyPastEvents: ['远古地球陷落', '被收容', '转入星舰学园'] },
    relationships: [
      { targetId: 'heroine-two', relationType: 'romance', label: '同桌→CP（感情线）' },
      { targetId: 'little-sister', relationType: 'family', label: '收养家庭的妹妹' },
    ],
    tags: [],
  },
  {
    id: 'heroine-two',
    type: 'character',
    name: '铃鹿雪',
    status: 'draft',
    summary: '同桌，最早察觉琉璃月异样的人',
    secrets: { surface: '优等生', truth: '观察力过人的敏锐者' },
    basics: { gender: '女', age: '16', race: '人类', occupation: '学生' },
    personality: { coreTraits: ['温柔', '敏锐'], surface: '邻家姐姐', innerTruth: '不安全感' },
    desireAndBottomline: { coreDesire: '守住日常', coreFear: '被抛下' },
    relationships: [],
    tags: [],
  },
  {
    id: 'little-sister',
    type: 'character',
    name: '小栗 蜜柑',
    status: 'draft',
    summary: '收养家庭的妹妹',
    basics: { gender: '女', age: '14', race: '人类', occupation: '学生' },
    personality: { coreTraits: ['黏人'], surface: '活泼', innerTruth: '（待补）' },
    desireAndBottomline: { coreDesire: '缠着姐姐', coreFear: '（待补）' },
    relationships: [{ targetId: 'protagonist', relationType: 'family', label: '姐姐（收养关系）' }],
    tags: [],
  },
  {
    id: 'animal-affinity',
    type: 'golden_finger',
    name: '小动物亲和（天生体质）',
    status: 'draft',
    summary: '靠近的小动物会主动亲近，无法主动关闭',
    abilitySystem: { coreAbility: '小动物主动亲近', derivedAbilities: ['安抚暴走个体'], boundaries: '无法召唤/指挥' },
    limitations: { hardLimits: '无法主动关闭', usageCost: '静止时被围观', conditionLimits: '接触距离 3 米' },
    origin: { origin: '远古地球长兔耳族血统' },
    balance: { coreLogic: '体质不可控', unsolvableDilemma: '想低调却总被小动物暴露' },
    tags: [],
  },
];

const DEFAULT_VIEW = { selectedCardId: null, tab: 'cards' as const, typeFilter: 'all' as const };

/** 两步落种：先 currentProject（null→path 触发 projectSubscription reset——同步清项目态，
 *  一步合落会被订阅 reset 把 creativeFields 当场抹掉），后落数据与视图态。 */
function seedState(cards: unknown, overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN',
  } as any);
  useAppStore.setState({
    creativeFields: { asset_cards: cards },
    settingView: { ...DEFAULT_VIEW, ...(overrides.settingView as object ?? {}) },
    settingViewHydratedPath: '/proj-1', // 已水合——挂载 effect 不读 storage（隔离持久化面）
    agentPanelOpen: false,
    mainView: 'page',
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'settingView')),
  } as any);
}

function rowOf(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-setting-card-id="${id}"]`);
  expect(el, `卡行 ${id} 应渲染`).not.toBeNull();
  return el as HTMLElement;
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
    settingView: { ...DEFAULT_VIEW },
    settingViewHydratedPath: null,
  } as any);
  delete (window as any).orisonDesktop;
});

describe('零卡空态（design §6/AC8；CR P1 修订：仅占卡区，页面壳照常渲染）', () => {
  it('空数组：卡区居中标题 + 双 CTA；工具栏/双 tab 照常渲染（docs tab 不被吞）', () => {
    seedState([]);
    const { container } = render(<SettingPage />);

    // CR P1：空态仅占卡区——工具栏（标题/新建/搜索）与 tabs 照常渲染。
    expect(screen.getByText('settingPage.title')).toBeInTheDocument();
    expect(container.querySelector('.setting-toolbar')).not.toBeNull();
    expect(container.querySelector('[data-setting-tab="cards"]')).not.toBeNull();
    expect(screen.getByText('settingPage.empty.title')).toBeInTheDocument();

    const ctaAi = screen.getByText('settingPage.empty.ctaAi').closest('button');
    expect(ctaAi).not.toBeNull();
    fireEvent.click(ctaAi!);
    expect(useAppStore.getState().agentPanelOpen).toBe(true);

    // B 波：手动新建激活（不再是 disabled 占位）——开 8 类菜单，选人物落骨架卡 + 选中。
    const ctaManual = screen.getByText('settingPage.empty.ctaManual').closest('button');
    expect(ctaManual?.hasAttribute('disabled')).toBe(false);
    fireEvent.click(ctaManual!);
    expect(container.querySelectorAll('[data-new-card-type]')).toHaveLength(8);
    fireEvent.click(container.querySelector('[data-new-card-type="character"]')!);
    const cards = useAppStore.getState().creativeFields.asset_cards as Array<{ id: string; type: string; status: string }>;
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('character');
    expect(cards[0].status).toBe('draft');
    expect(cards[0].id).toMatch(/^card-[a-z0-9]{6}$/);
    expect(useAppStore.getState().settingView.selectedCardId).toBe(cards[0].id);
    // 建卡后空态退场——卡列表接管（行渲染 + 新卡选中）。
    expect(screen.queryByText('settingPage.empty.title')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.setting-cardrow')).toHaveLength(1);
  });

  it('零卡 + settings/ 有文档：docs tab 可用（P1 主诉求——旧项目无卡但文档入口不消失）', async () => {
    seedState([]);
    (window as any).orisonDesktop = {
      readDirectory: vi.fn(async () => [{ name: 'style.md', path: '/style.md', isDir: false }]),
    };
    const { container } = render(<SettingPage />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(container.querySelector('[data-setting-tab="docs"]')!);
    expect(useAppStore.getState().settingView.tab).toBe('docs');
    expect(await screen.findByText('style')).toBeInTheDocument();
    // 卡区空态被 docs 列表替换（切回 cards tab 空态回来）。
    expect(screen.queryByText('settingPage.empty.title')).not.toBeInTheDocument();
    fireEvent.click(container.querySelector('[data-setting-tab="cards"]')!);
    expect(screen.getByText('settingPage.empty.title')).toBeInTheDocument();
  });

  it('旧项目无 asset_cards 键 / 非数组脏值 → 同空态（Array.isArray 守卫天然给出）', () => {
    for (const absent of [undefined, {}, 'not-an-array', null]) {
      cleanup();
      seedState(absent);
      render(<SettingPage />);
      expect(screen.getByText('settingPage.empty.title')).toBeInTheDocument();
    }
  });
});

describe('分组渲染 + tier/status 徽标（design §3）', () => {
  it('按 type 分组（schema 序）+ 组头计数 + chips 计数；初始无选中（B 波语义：右列提示空态）', () => {
    seedState(DOGFOOD_CARDS);
    const { container } = render(<SettingPage />);

    // 分组：character×3 + golden_finger×1（8 类 schema 序——character 在前）。
    const groups = container.querySelectorAll('[data-setting-group]');
    expect(groups).toHaveLength(2);
    expect(groups[0].getAttribute('data-setting-group')).toBe('character');
    expect(groups[0].querySelectorAll('.setting-cardrow')).toHaveLength(3);
    expect(groups[1].getAttribute('data-setting-group')).toBe('golden_finger');
    expect(groups[1].querySelectorAll('.setting-cardrow')).toHaveLength(1);
    // 组头 = 类型 i18n 键 + 计数。
    expect(groups[0].querySelector('.setting-group-head')?.textContent).toContain('settingPage.type.character');
    expect(groups[0].querySelector('.setting-group-head')?.textContent).toContain('3');

    // chips：全部(4) + 人物(3) + 金手指(1)——只显有卡的类型。
    const allChip = container.querySelector('[data-setting-filter="all"]');
    expect(allChip?.textContent).toContain('4');
    expect(container.querySelector('[data-setting-filter="character"]')?.textContent).toContain('3');
    expect(container.querySelector('[data-setting-filter="golden_finger"]')?.textContent).toContain('1');
    expect(container.querySelector('[data-setting-filter="lore"]')).toBeNull();

    // B 波选中语义：selectedCardId null = 未选——无行高亮、右列提示空态（不派生回落首行）。
    expect(container.querySelector('.setting-cardrow.is-selected')).toBeNull();
    expect(container.querySelector('.setting-selecthint')?.textContent).toBe('settingPage.selectHint');
    expect(useAppStore.getState().settingView.selectedCardId).toBeNull();
  });

  it('tier 未标：resolveTier 结构默认（character/golden_finger → core，location → micro）+「默认」角标', () => {
    const cards = [
      ...DOGFOOD_CARDS,
      { id: 'old-school', type: 'location', name: '星舰学园', status: 'active', summary: '主舞台' },
    ];
    seedState(cards);
    const { container } = render(<SettingPage />);

    for (const id of ['protagonist', 'heroine-two', 'little-sister', 'animal-affinity']) {
      const badge = rowOf(container, id).querySelector('.setting-badge--tier');
      expect(badge?.textContent, `${id} 结构默认 core`).toContain('settingPage.tier.core');
      expect(badge?.querySelector('.setting-badge-default'), `${id} 默认角标`).not.toBeNull();
    }
    const locBadge = rowOf(container, 'old-school').querySelector('.setting-badge--tier');
    expect(locBadge?.textContent, 'location 结构默认 micro').toContain('settingPage.tier.micro');
    expect(locBadge?.querySelector('.setting-badge-default')).not.toBeNull();
  });

  it('tier 显式标注：直接用标注值，无「默认」角标（core 与 micro 皆然）', () => {
    const cards = [
      { id: 'marked-core', type: 'location', name: '显式核心地点', tier: 'core', status: 'draft' },
      { id: 'marked-micro', type: 'character', name: '显式次要人物', tier: 'micro', status: 'draft' },
    ];
    seedState(cards);
    const { container } = render(<SettingPage />);

    const coreBadge = rowOf(container, 'marked-core').querySelector('.setting-badge--tier');
    expect(coreBadge?.textContent).toContain('settingPage.tier.core');
    expect(coreBadge?.querySelector('.setting-badge-default')).toBeNull();
    const microBadge = rowOf(container, 'marked-micro').querySelector('.setting-badge--tier');
    expect(microBadge?.textContent).toContain('settingPage.tier.micro');
    expect(microBadge?.querySelector('.setting-badge-default')).toBeNull();
  });

  it('status 徽标：draft 缺省回落；active/deprecated/locked 各显其键', () => {
    const cards = [
      { id: 'no-status', type: 'rule', name: '缺状态卡' },
      { id: 'st-active', type: 'rule', name: '生效卡', status: 'active' },
      { id: 'st-dep', type: 'rule', name: '废弃卡', status: 'deprecated' },
      { id: 'st-lock', type: 'rule', name: '锁定卡', status: 'locked' },
    ];
    seedState(cards);
    const { container } = render(<SettingPage />);

    expect(rowOf(container, 'no-status').querySelector('.setting-badge--status')?.textContent)
      .toBe('settingPage.status.draft');
    expect(rowOf(container, 'st-active').querySelector('.setting-badge--status')?.textContent)
      .toBe('settingPage.status.active');
    expect(rowOf(container, 'st-dep').querySelector('.setting-badge--status')?.textContent)
      .toBe('settingPage.status.deprecated');
    expect(rowOf(container, 'st-lock').querySelector('.setting-badge--status')?.textContent)
      .toBe('settingPage.status.locked');
  });
});

describe('未知/越界 type 防御（design §6；research §3.5 legacy image 卡实证）', () => {
  it('归「其他」组（只读）+ other chip；点击右列显只读 JSON pretty + 提示', () => {
    const cards = [
      ...DOGFOOD_CARDS,
      { id: 'img-1', type: 'image', name: '旧生图归档卡', status: 'draft', summary: '失效写路遗留' },
    ];
    seedState(cards);
    const { container } = render(<SettingPage />);

    // other 组殿后 + other chip 出现（计数 1）。
    const groups = container.querySelectorAll('[data-setting-group]');
    expect(groups[groups.length - 1].getAttribute('data-setting-group')).toBe('other');
    expect(groups[groups.length - 1].querySelectorAll('.setting-cardrow')).toHaveLength(1);
    expect(container.querySelector('[data-setting-filter="other"]')?.textContent).toContain('1');

    // 点击 → 右列只读 JSON pretty（卡内容可读）+ 提示文案；type 原值露出。
    fireEvent.click(rowOf(container, 'img-1'));
    expect(useAppStore.getState().settingView.selectedCardId).toBe('img-1');
    const json = container.querySelector('.setting-readonly-json');
    expect(json?.textContent).toContain('"id": "img-1"');
    expect(json?.textContent).toContain('"type": "image"');
    expect(screen.getByText('settingPage.other.readonlyHint')).toBeInTheDocument();
    expect(container.querySelector('.setting-summary-rawtype')?.textContent).toContain('image');
  });

  it('元素级垃圾（null/数字/字符串/缺 id 或 name 的对象）丢弃不崩（守卫到元素级）', () => {
    const cards = [
      null,
      42,
      'plain-string',
      { type: 'character', name: '缺 id 卡' },
      { id: 'no-name', type: 'character' },
      { id: 'bad-id', name: '', type: 'character' },
      DOGFOOD_CARDS[0],
    ];
    seedState(cards);
    const { container } = render(<SettingPage />);

    expect(container.querySelectorAll('.setting-cardrow')).toHaveLength(1);
    expect(rowOf(container, 'protagonist')).toBeInTheDocument();
    // B 波：无选中 → 右列提示空态（不再渲染只读摘要卡头）。
    expect(container.querySelector('.setting-selecthint')).not.toBeNull();
  });

  it('CR P14：重复 id 卡 first-wins 去重——单行渲染不撞 React key（写回契约不受影响）', () => {
    const cards = [
      DOGFOOD_CARDS[0],
      { ...DOGFOOD_CARDS[0], name: '幽灵复制品（同 id 后条）' },
      DOGFOOD_CARDS[1],
    ];
    seedState(cards);
    const { container } = render(<SettingPage />);

    // 首条生效、后条丢弃：protagonist 只渲染一行（原名字），heroine-one 正常。
    const protagonistRows = container.querySelectorAll('[data-setting-card-id="protagonist"]');
    expect(protagonistRows).toHaveLength(1);
    expect(protagonistRows[0].textContent).toContain('琉璃月');
    expect(protagonistRows[0].textContent).not.toContain('幽灵复制品');
    expect(container.querySelectorAll('.setting-cardrow')).toHaveLength(2);
    // chips 计数按去重后行集（全部 2 / 人物 2）。
    expect(container.querySelector('[data-setting-filter="all"]')?.textContent).toContain('2');
  });
});

describe('类型过滤 + 搜索（纯前端零 IPC）', () => {
  it('点击类型 chip：写 store + 列表收窄到该组', () => {
    seedState(DOGFOOD_CARDS);
    const { container } = render(<SettingPage />);

    fireEvent.click(container.querySelector('[data-setting-filter="golden_finger"]')!);

    expect(useAppStore.getState().settingView.typeFilter).toBe('golden_finger');
    const groups = container.querySelectorAll('[data-setting-group]');
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute('data-setting-group')).toBe('golden_finger');
    expect(groups[0].querySelectorAll('.setting-cardrow')).toHaveLength(1);
    // chip 激活态（aria-pressed）。
    expect(container.querySelector('[data-setting-filter="golden_finger"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-setting-filter="all"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('持久化死过滤（所指组已无卡）回落全部——不落「空列表无激活 chip」死胡同', () => {
    seedState(DOGFOOD_CARDS, { settingView: { selectedCardId: null, tab: 'cards', typeFilter: 'rule' } });
    const { container } = render(<SettingPage />);

    expect(container.querySelectorAll('[data-setting-group]')).toHaveLength(2);
    expect(container.querySelector('[data-setting-filter="all"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('搜索：name / summary / tags 命中（不区分大小写）；chips 计数不随搜索缩水', () => {
    const cards = [
      ...DOGFOOD_CARDS,
      { id: 'tagged', type: 'location', name: '某地点', status: 'draft', tags: ['琉璃', '秘密'] },
    ];
    seedState(cards);
    const { container } = render(<SettingPage />);

    // name 命中（protagonist）；heroine-two 的 summary 也提及「琉璃月」——summary 命中同权。
    fireEvent.change(screen.getByPlaceholderText('settingPage.toolbar.searchPlaceholder'), { target: { value: '琉璃月' } });
    expect(container.querySelectorAll('.setting-cardrow')).toHaveLength(2);
    expect(rowOf(container, 'protagonist')).toBeInTheDocument();
    expect(rowOf(container, 'heroine-two')).toBeInTheDocument();

    // tags 命中（另一张卡）。
    fireEvent.change(screen.getByPlaceholderText('settingPage.toolbar.searchPlaceholder'), { target: { value: '秘密' } });
    expect(container.querySelectorAll('.setting-cardrow')).toHaveLength(1);
    expect(rowOf(container, 'tagged')).toBeInTheDocument();

    // chips 计数仍报数据分布（全部 5 / 人物 3）——不随搜索缩水。
    expect(container.querySelector('[data-setting-filter="all"]')?.textContent).toContain('5');
    expect(container.querySelector('[data-setting-filter="character"]')?.textContent).toContain('3');

    // summary 命中 + 清空恢复。
    fireEvent.change(screen.getByPlaceholderText('settingPage.toolbar.searchPlaceholder'), { target: { value: '同桌' } });
    expect(container.querySelectorAll('.setting-cardrow')).toHaveLength(1);
    expect(rowOf(container, 'heroine-two')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('settingPage.toolbar.searchPlaceholder'), { target: { value: '' } });
    expect(container.querySelectorAll('.setting-cardrow')).toHaveLength(5);
  });

  it('搜索/过滤零命中：noMatch 提示行（B6——不静默空白）；清词恢复', () => {
    seedState(DOGFOOD_CARDS);
    const { container } = render(<SettingPage />);

    fireEvent.change(screen.getByPlaceholderText('settingPage.toolbar.searchPlaceholder'), { target: { value: '不存在的词' } });

    expect(container.querySelectorAll('.setting-cardrow')).toHaveLength(0);
    const hint = container.querySelector('[data-setting-no-match]');
    expect(hint?.textContent).toBe('settingPage.filter.noMatch');

    // 清词恢复（提示退场）。
    fireEvent.change(screen.getByPlaceholderText('settingPage.toolbar.searchPlaceholder'), { target: { value: '' } });
    expect(container.querySelector('[data-setting-no-match]')).toBeNull();
    expect(container.querySelectorAll('.setting-cardrow')).toHaveLength(4);
  });
});

describe('左列双 tab + 选中写 store', () => {
  it('docs tab：settings/*.md 列表（B 波 W5）——非 md/目录滤除，chips/列表让位', async () => {
    seedState(DOGFOOD_CARDS);
    (window as any).orisonDesktop = {
      readDirectory: vi.fn(async () => [
        { name: 'style.md', path: '/style.md', isDir: false },
        { name: 'world.md', path: '/world.md', isDir: false },
        { name: 'notes.txt', path: '/notes.txt', isDir: false }, // 非 md 滤除
        { name: 'archive', path: '/archive', isDir: true, children: [] }, // 目录滤除
      ]),
    };
    const { container } = render(<SettingPage />);

    // 读目录 IPC 异步——等一拍让 docs 可见性落定。
    await act(async () => { await Promise.resolve(); });
    // docs tab 出现（计数 2）。
    const docsTab = container.querySelector('[data-setting-tab="docs"]') as HTMLElement;
    expect(docsTab).not.toBeNull();
    expect(docsTab.textContent).toContain('2');
    fireEvent.click(docsTab);

    expect(useAppStore.getState().settingView.tab).toBe('docs');
    // 行 = 文件名去 .md；非 md 文件不出现。
    expect(await screen.findByText('style')).toBeInTheDocument();
    expect(screen.getByText('world')).toBeInTheDocument();
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
    expect(container.querySelector('[data-setting-filter="all"]')).toBeNull();
  });

  it('docs tab 空目录隐藏（AC6）——settings/ 无 md 时 tab 不渲染；持久化 tab=docs 死态回落 cards', async () => {
    seedState(DOGFOOD_CARDS);
    (window as any).orisonDesktop = {
      readDirectory: vi.fn(async () => [
        { name: 'cover.png', path: '/cover.png', isDir: false },
      ]),
    };
    const { container } = render(<SettingPage />);

    // 读目录 IPC 异步——等一拍让空态落定。
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-setting-tab="docs"]')).toBeNull();
    // 持久化 tab=docs（初装即空 = 死态）也回落 cards（CR-004 裁决 4：死态回落照旧）。
    act(() => {
      useAppStore.setState({ settingView: { selectedCardId: null, tab: 'docs', typeFilter: 'all' } } as any);
    });
    expect(container.querySelector('[data-setting-filter="all"]')).not.toBeNull();
  });

  it('CR-004 裁决 4：持久化 tab=docs 初帧直渲 docs（loading 骨架）——不先闪 cards 再翻回', async () => {
    let resolveDir: (v: unknown) => void = () => {};
    (window as any).orisonDesktop = {
      readDirectory: vi.fn(() => new Promise((res) => { resolveDir = res; })),
    };
    seedState(DOGFOOD_CARDS, { settingView: { selectedCardId: null, tab: 'docs', typeFilter: 'all' } });
    const { container } = render(<SettingPage />);

    // loading 期（IPC 未回）：docs tab 直渲 + 骨架占位——卡列表 chips 不出现（不闪 cards）。
    expect(container.querySelector('[data-setting-tab="docs"]')).not.toBeNull();
    expect(container.querySelector('[data-setting-docs-loading]')).not.toBeNull();
    expect(container.querySelector('[data-setting-filter="all"]')).toBeNull();

    await act(async () => {
      resolveDir([{ name: 'style.md', path: '/style.md', isDir: false }]);
      await Promise.resolve();
    });
    // 装载落定非空：列表直出（同帧切换无二次闪）。
    expect(await screen.findByText('style')).toBeInTheDocument();
    expect(container.querySelector('[data-setting-filter="all"]')).toBeNull();
  });

  it('CR-004 裁决 4：装载后目录被清空且用户停 docs tab → tab 内空态，不强切回 cards', async () => {
    let entries = [
      { name: 'style.md', path: '/style.md', isDir: false },
      { name: 'world.md', path: '/world.md', isDir: false },
    ];
    (window as any).orisonDesktop = {
      readDirectory: vi.fn(async () => entries),
    };
    seedState(DOGFOOD_CARDS);
    const { container } = render(<SettingPage />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(container.querySelector('[data-setting-tab="docs"]')!);
    expect(await screen.findByText('style')).toBeInTheDocument();

    // agent 删掉最后一个 md → file:changed 重拉 → 目录空。
    entries = [{ name: 'cover.png', path: '/cover.png', isDir: false }];
    await act(async () => {
      window.dispatchEvent(new CustomEvent('orison:tool-event', { detail: { type: 'file:changed' } }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // tab 内空态（docs.empty）；不闪回 cards（chips 仍不出场）；docs 钮仍在（用户在此 tab）。
    expect(container.querySelector('[data-setting-docs-empty]')?.textContent).toBe('settingPage.docs.empty');
    expect(container.querySelector('[data-setting-filter="all"]')).toBeNull();
    expect(container.querySelector('[data-setting-tab="docs"]')).not.toBeNull();

    // 用户切回 cards 再看：目录空 → docs 钮退场（AC6 空目录隐藏恢复）。
    fireEvent.click(container.querySelector('[data-setting-tab="cards"]')!);
    expect(container.querySelector('[data-setting-tab="docs"]')).toBeNull();
  });

  it('点击卡行：写 settingView.selectedCardId，右列 CardForm 跟随（key=card.id）', () => {
    seedState(DOGFOOD_CARDS);
    const { container } = render(<SettingPage />);

    fireEvent.click(rowOf(container, 'heroine-two'));

    expect(useAppStore.getState().settingView.selectedCardId).toBe('heroine-two');
    expect(rowOf(container, 'heroine-two').classList.contains('is-selected')).toBe(true);
    // 已知 type → CardForm（name 受控输入值跟随）。
    const nameInput = container.querySelector('.card-form-name') as HTMLInputElement;
    expect(nameInput.value).toBe('铃鹿雪');
    expect(container.querySelector('.card-form')?.getAttribute('data-card-type')).toBe('character');
  });

  it('选中卡被删（持久化 id 失效）：派生回落首行不空窗（CardForm 跟随）', () => {
    seedState(DOGFOOD_CARDS, { settingView: { selectedCardId: 'deleted-card', tab: 'cards', typeFilter: 'all' } });
    const { container } = render(<SettingPage />);

    const nameInput = container.querySelector('.card-form-name') as HTMLInputElement;
    expect(nameInput.value).toBe('琉璃月');
  });
});

describe('导航接线（design §9 三点：types/navItems/WorkspaceLayout switch）', () => {
  it('setActivePage("setting") → WorkspaceLayout 渲染 SettingPage（lazy）+ icon-rail 钮可达', async () => {
    useAppStore.setState({
      currentProject: null,
      activePage: 'overview',
      mainView: 'page',
      agentPanelOpen: false,
      creativeFields: {},
      settingView: { ...DEFAULT_VIEW },
      settingViewHydratedPath: null,
    } as any);
    useAppStore.setState({ creativeFields: { asset_cards: DOGFOOD_CARDS } } as any);
    act(() => {
      useAppStore.getState().setActivePage('setting');
    });

    render(<WorkspaceLayout />);

    // lazy 加载后卡名渲染（经 WorkspaceLayout switch case 'setting'；行 + 右列摘要两处）。
    expect((await screen.findAllByText('琉璃月')).length).toBeGreaterThan(0);
    // icon-rail 新钮（navItems.settingItem 经 SideNav 渲染——i18n mock 下 aria-label=键名）。
    expect(screen.getByRole('button', { name: 'nav.setting' })).toBeInTheDocument();
  });
});
