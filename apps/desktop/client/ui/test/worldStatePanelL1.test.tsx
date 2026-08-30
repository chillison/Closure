/**
 * WorldStatePanel L1 总览渲染测试（dogfood R2 #92，task 08-29-world-state-panel S4）。
 *
 * 覆盖：L1 脊柱（锚点降序/行内容/轴点）、活跃主体条（窗口+排序+点击直达 L3）、
 * 主体选择区（type 分组/组内活跃排序/搜索即时过滤）、**本地过滤零 IPC**（交互质量
 * 不变式——数据已在手，搜索不得触发 worldOverview 重拉）、三态（加载骨架/空态/错误
 * 重试）、提取中细条、导航动作落 store、zh/en i18n 齐平。
 *
 * 形态照 spec/ui/testing.md：真实 useAppStore + seed state（LintPanel 谱）+
 * 文件级 mock 桥（hand-made vi.fn，beforeEach mockClear——vitest 4 单 spy 纪律）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorldOverview, WorldSubjectRow } from '@orison/shared-contracts';
import { WorldStatePanel } from '../src/features/world-state/WorldStatePanel';
import { useAppStore } from '../src/shared/store/appStore';
import type { WorldViewState } from '../src/shared/store/worldStateSlice';

// ── 文件级单 mock 桥（零 spyOn——挂自建 vi.fn；beforeEach 清计数）──
const worldOverviewSpy = vi.fn(async (): Promise<WorldOverview> => OVERVIEW);

function installBridge() {
  (window as any).orisonDesktop = {
    worldOverview: worldOverviewSpy,
    worldSliceDetail: vi.fn(async () => ({ anchor: {}, groups: [] })),
    worldSubjectDetail: vi.fn(async () => ({ patches: [] })),
    onWorldChanged: vi.fn(() => () => {}),
  };
}

// ── fixtures ──

function subjectRow(id: string, overrides: Partial<WorldSubjectRow> = {}): WorldSubjectRow {
  const [type, ...rest] = id.split(':');
  return {
    id,
    type,
    name: rest.join(':'),
    firstSeenStoryTime: 1,
    patchCount: 2,
    lastStoryTime: 3,
    axes: ['physical'],
    ...overrides,
  };
}

const SUBJECTS: WorldSubjectRow[] = [
  subjectRow('character:shen-yan', { name: '沈砚', lastStoryTime: 3, axes: ['physical', 'cognitive', 'emotional'] }),
  subjectRow('character:miya', { name: '米娅', lastStoryTime: 3, axes: ['cognitive', 'emotional'] }),
  subjectRow('character:lao-wei', { name: '老魏', lastStoryTime: 1 }),
  subjectRow('group:archaeology-team', { name: '考古队', lastStoryTime: 2 }),
  subjectRow('item:cryo-pod-01', { name: '休眠舱', lastStoryTime: null, patchCount: 0, axes: [] }),
];

const OVERVIEW: WorldOverview = {
  subjects: SUBJECTS,
  anchors: [
    {
      t: 1,
      label: '唤醒当日',
      epRange: 'ep1-01..05',
      title: '荒野舱醒',
      subjectCount: 5,
      patchCount: 16,
      axisCounts: { physical: 7, cognitive: 6, emotional: 3, relational: 0, factional: 0 },
    },
    {
      t: 3,
      label: '入学首日',
      epRange: 'ep1-13..20',
      title: '陌生教室',
      subjectCount: 2,
      patchCount: 5,
      axisCounts: { physical: 2, cognitive: 2, emotional: 1, relational: 0, factional: 0 },
    },
  ],
  patchTotal: 21,
  latestT: 3,
};

const DEFAULT_VIEW: WorldViewState = {
  view: 'overview',
  viewT: null,
  selectedSubjectId: null,
  asOfT: null,
  pathFilter: null,
  axisOn: { physical: true, cognitive: true, emotional: true, relational: true, factional: true },
};

function seedState(overrides: Record<string, unknown> = {}) {
  // 两步落种：先落 currentProject（null→path 触发 projectSubscription 的
  // runProjectResets——同步清项目态），再落面板数据。一步合落会被订阅 reset 把
  // worldOverview 等当场抹掉（本文件首测实录）。
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN',
  } as any);
  useAppStore.setState({
    worldView: { ...DEFAULT_VIEW, axisOn: { ...DEFAULT_VIEW.axisOn } },
    worldViewHydratedPath: '/proj-1', // 已水合——挂载 effect 不读 storage（隔离持久化面）
    worldOverview: OVERVIEW,
    worldOverviewLoading: false,
    worldOverviewError: null,
    worldSliceDetail: null,
    worldSliceDetailT: null,
    worldSliceDetailLoading: false,
    worldSliceDetailError: null,
    worldSubjectDetail: null,
    worldSubjectDetailSubjectId: null,
    worldSubjectDetailLoading: false,
    worldSubjectDetailError: null,
    ...overrides,
  } as any);
}

/** 选择区主体行名列表（首文本节点——排除 id slug 副标）。 */
function pickerRowNames(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('.world-subject-name')].map((el) => el.childNodes[0].textContent);
}

beforeEach(() => {
  worldOverviewSpy.mockClear();
  worldOverviewSpy.mockImplementation(async () => OVERVIEW);
  localStorage.clear();
  installBridge();
});

afterEach(() => {
  cleanup();
  delete (window as any).orisonDesktop;
});

describe('L1 世界总览', () => {
  it('时点脊柱降序渲染（现在在上）且锚点行内容齐备（t/label/章范围/活动计数/轴点/场景标题）', () => {
    seedState();
    const { container } = render(<WorldStatePanel />);

    const ts = [...container.querySelectorAll('.world-anchor-t')].map((el) => el.textContent);
    expect(ts).toEqual(['t=3', 't=1']);

    const row = screen.getByText('入学首日').closest('button');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('t=3');
    expect(row!.textContent).toContain('ep1-13..20');
    expect(row!.textContent).toContain('2 个主体 · 5 项变更');
    expect(row!.textContent).toContain('「陌生教室」');
    // 轴点分布：t=3 锚 physical/cognitive/emotional 三轴在场（relational/factional 计 0 不渲染）。
    const meta = row!.querySelector('.world-anchor-meta')!;
    expect(meta.querySelectorAll('.world-axis-dot').length).toBe(3);
  });

  it('点锚点行 → 进入 L2 视图（view=slice + viewT 锚定）', () => {
    seedState();
    render(<WorldStatePanel />);

    fireEvent.click(screen.getByText('入学首日').closest('button')!);

    expect(useAppStore.getState().worldView.view).toBe('slice');
    expect(useAppStore.getState().worldView.viewT).toBe(3);
  });

  it('新时点滑入动画：同项目出新时点标记一次性入场；跨项目切换清基线不误触（#106）', () => {
    seedState();
    const { container } = render(<WorldStatePanel />);

    // 同项目刷新出新时点 t=5 → 标记滑入（首挂不标、只对「运行中出现」的时点生效）。
    const ANCHOR_T5 = {
      t: 5, label: '夜航启程', epRange: 'ep1-21..26', title: '离港', subjectCount: 2, patchCount: 4,
      axisCounts: { physical: 2, cognitive: 1, emotional: 1, relational: 0, factional: 0 },
    };
    act(() => {
      useAppStore.setState({
        worldOverview: { ...OVERVIEW, anchors: [...OVERVIEW.anchors, ANCHOR_T5], latestT: 5 },
      } as any);
    });
    const fresh = container.querySelector('.world-anchor.is-fresh');
    expect(fresh).not.toBeNull();
    expect(fresh!.querySelector('.world-anchor-t')?.textContent).toBe('t=5');

    // 切项目（reset 清 overview → 新项目 overview 落地）：基线已清，新项目锚点全按首装
    // 处理，不标 fresh（旧项目 t 集不得把新项目锚点判成「新」）。
    act(() => {
      useAppStore.setState({
        currentProject: { projectId: 'p2', name: 'P2', path: '/proj-2', type: 'novel' },
      } as any);
    });
    act(() => {
      useAppStore.setState({
        worldOverview: { ...OVERVIEW, anchors: [ANCHOR_T5, ...OVERVIEW.anchors], latestT: 5 },
      } as any);
    });
    expect(container.querySelector('.world-anchor.is-fresh')).toBeNull();
  });

  it('活跃主体条：最近时点窗口内的主体成 chips，点击直达 L3', () => {
    seedState();
    render(<WorldStatePanel />);

    // latestT=3：沈砚/米娅（last=3）在窗口内；老魏（last=1）、休眠舱（null）不在。
    expect(screen.getByRole('button', { name: '沈砚' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '米娅' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '老魏' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '米娅' }));

    expect(useAppStore.getState().worldView.view).toBe('subject');
    expect(useAppStore.getState().worldView.selectedSubjectId).toBe('character:miya');
  });
});

describe('主体选择区', () => {
  it('type 分组 + 组内 lastStoryTime 降序（登记未写沉底）+ 行内容（名/id/最后时点）', () => {
    seedState();
    const { container } = render(<WorldStatePanel />);

    // 分组头：角色 3 / 群体 1 / 实体 / 物 1（开放 type 的已知展示名）。
    expect(screen.getByText('角色')).toBeInTheDocument();
    expect(screen.getByText('群体')).toBeInTheDocument();
    expect(screen.getByText('实体 / 物')).toBeInTheDocument();

    // 角色组内排序：沈砚(3)=米娅(3) 在前（数据序稳定）、老魏(1) 随后；休眠舱(null) 在 item 组。
    const names = [...container.querySelectorAll('.world-subject-name')].map(
      (el) => el.childNodes[0].textContent,
    );
    expect(names.indexOf('老魏')).toBeGreaterThan(names.indexOf('沈砚'));
    expect(names).toContain('休眠舱');

    // 行内容：id slug 副标 + 最后时点 / 登记未写。
    expect(container.textContent).toContain('shen-yan');
    expect(container.textContent).toContain('最后 t=1');
    expect(container.textContent).toContain('登记未写');
  });

  it('未登记主体（entity 哨兵行）分组文案——去「哨兵」黑话（#19）', () => {
    // merge 兜底登记的裸引用主体（type=entity，批次 α overview 补的哨兵行）——渲染面按普通
    // 主体分组渲染，组名走 typeLabels.entity 人话文案。
    const entityRow = subjectRow('entity:orphan-ref', {
      name: 'orphan-ref', lastStoryTime: null, patchCount: 0, axes: [],
    });
    seedState({ worldOverview: { ...OVERVIEW, subjects: [...SUBJECTS, entityRow] } });
    const { container } = render(<WorldStatePanel />);

    expect(screen.getByText('未登记主体')).toBeInTheDocument();
    expect(container.textContent).toContain('orphan-ref');
    expect(container.textContent).not.toContain('哨兵');
  });

  it('搜索即时过滤主体（名/id 命中）——纯本地零 IPC', () => {
    seedState();
    const { container } = render(<WorldStatePanel />);

    expect(worldOverviewSpy).not.toHaveBeenCalled(); // seeded 数据，挂载不拉
    fireEvent.change(screen.getByPlaceholderText('搜索主体…'), { target: { value: '米娅' } });

    expect(pickerRowNames(container)).toEqual(['米娅']);

    // id 命中：搜 slug 也能找到（name 不同路径）。
    fireEvent.change(screen.getByPlaceholderText('搜索主体…'), { target: { value: 'cryo' } });
    expect(pickerRowNames(container)).toEqual(['休眠舱']);

    // 交互质量不变式：本地过滤零 IPC——桥 spy 全程未增。
    expect(worldOverviewSpy).not.toHaveBeenCalled();
  });

  it('搜索无命中显示无匹配文案', () => {
    seedState();
    render(<WorldStatePanel />);

    fireEvent.change(screen.getByPlaceholderText('搜索主体…'), { target: { value: '不存在的名字' } });

    expect(screen.getByText('无匹配主体')).toBeInTheDocument();
  });

  it('点主体行 → 直达 L3 且行标记选中态', () => {
    seedState();
    const { container } = render(<WorldStatePanel />);

    // 经选择区行点击（考古队同时是活跃 chip——last=2 落在窗口内，须锚定选择区行）。
    const row = [...container.querySelectorAll('.world-subject-row')].find(
      (btn) => btn.textContent?.includes('考古队'),
    )!;
    fireEvent.click(row);

    expect(useAppStore.getState().worldView.view).toBe('subject');
    expect(useAppStore.getState().worldView.selectedSubjectId).toBe('group:archaeology-team');
    const selected = container.querySelector('.world-subject-row.is-selected .world-subject-name');
    expect(selected?.textContent).toContain('考古队');
  });
});

describe('三态 + 提取中信号', () => {
  it('加载态：overview 未装且 loading → 骨架 status 块', () => {
    seedState({ worldOverview: null, worldOverviewLoading: true });
    render(<WorldStatePanel />);

    expect(screen.getByRole('status', { name: '加载世界状态…' })).toBeInTheDocument();
  });

  it('空态：latestT=null（空库判定键在契约）→ 空态文案，无锚点渲染', () => {
    seedState({
      worldOverview: { ...OVERVIEW, anchors: [], patchTotal: 0, latestT: null, subjects: [SUBJECTS[4]] },
    });
    render(<WorldStatePanel />);

    expect(screen.getByText('尚未从正文提取世界状态')).toBeInTheDocument();
    expect(screen.queryByText('入学首日')).toBeNull();
    // 主体身份仍在（reset 保身份形态）——选择区照常渲染登记未写主体。
    expect(screen.getByText('休眠舱')).toBeInTheDocument();
  });

  it('错误态：展示错误 + 重试钮，重试触发重拉并落地数据', async () => {
    // 挂载即拉的首次请求 reject（catch 落错误态）；重试走第二次调用（成功）。
    worldOverviewSpy.mockRejectedValueOnce(new Error('auto fail')).mockImplementation(async () => OVERVIEW);
    seedState({ worldOverview: null });
    render(<WorldStatePanel />);

    expect(await screen.findByText('世界状态加载失败')).toBeInTheDocument();
    expect(screen.getByText('auto fail')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => {
      expect(worldOverviewSpy).toHaveBeenCalledTimes(2);
      expect(worldOverviewSpy).toHaveBeenLastCalledWith({ projectId: 'p1' });
      expect(useAppStore.getState().worldOverview).not.toBeNull();
    });
    expect(screen.getByText('入学首日')).toBeInTheDocument();
  });

  it('extracting 信号 → 「世界提取中…」细条可见', () => {
    seedState({ worldOverview: { ...OVERVIEW, extracting: true } });
    render(<WorldStatePanel />);

    expect(screen.getByText('世界提取中…')).toBeInTheDocument();
  });

  it('手动刷新钮 → 强制重拉 overview（force 通路兜底）', async () => {
    seedState();
    render(<WorldStatePanel />);

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => expect(worldOverviewSpy).toHaveBeenCalledTimes(1));
  });
});

describe('i18n 齐平（zh/en）', () => {
  it('en locale 下同一面板渲染英文文案', () => {
    seedState({ resolvedLocale: 'en-US' });
    render(<WorldStatePanel />);

    expect(screen.getByText('World State')).toBeInTheDocument();
    expect(screen.getByText('Recently present / active')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search subjects…')).toBeInTheDocument();
  });

  it('zh 文案零英文术语露出（标题/计数/时点/主体措辞）', () => {
    seedState();
    render(<WorldStatePanel />);

    expect(screen.getByText('世界状态')).toBeInTheDocument();
    expect(screen.getByText('5 个主体 · 21 项变更 · 2 个时点')).toBeInTheDocument();
    expect(screen.getByText('最近在场 / 活跃')).toBeInTheDocument();
  });
});
