/**
 * WorldStatePanel L2/L3 交互测试（dogfood R2 #92，task 08-29-world-state-panel S5）。
 *
 * 覆盖：
 * - L2 分组渲染（面包屑/场景摘要行含章范围徽标/组头/变更行）、chips 计数过滤（弱轴 0 灰显）+
 *   **本地过滤零 IPC**（交互质量不变式）；组头点进主体；stale chrome 防御（#202）与
 *   未知轴默认显示（#10/#110/#205）。
 * - 变更行展开 value 三分支（分层对象层名小标 + vad 紧凑形 + subject:// 引用 chip 跳转）。
 * - 跳场景钮（#203 拍板「开章文件 tab」：映射命中可点 openWriting 开该章 md 文件 tab /
 *   查不到章或章未写正文置灰不崩）。
 * - L3 切线：快照本地回退（mock 的 subjectDetail 不变、at 不重发——零 IPC 断言）、
 *   进视图首拉（契约无 at 参——CR #4 砍 shell reduce 后切线全本地）、更晚折叠计数、更晚锚点隐藏、
 *   回现在。
 * - 路径钻取（快照键 → 只看该 path + 首条自动展开 + 手动收起 + ✕ 清除）；过滤空分支（#103）。
 * - issues 徽标（broken-relative 行内警示）；L2/L3 三态（骨架/错误重试/空态）；i18n en。
 *
 * 形态照 spec/ui/testing.md：真实 useAppStore + seed state（LintPanel/worldStatePanelL1 谱）
 * + 文件级 mock 桥（hand-made vi.fn，beforeEach mockClear——vitest 4 单 spy 纪律）。
 * jsdom 零布局 → 窗口化不激活（全量渲染），窗口化行为由 worldWindowedRows.test 直测。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorldOverview,
  WorldPatch,
  WorldPatchAxis,
  WorldSliceDetail,
  WorldSubjectDetail,
  WorldSubjectRow,
} from '@orison/shared-contracts';
import { WorldStatePanel } from '../src/features/world-state/WorldStatePanel';
import { useAppStore } from '../src/shared/store/appStore';
import type { WorldViewState } from '../src/shared/store/worldStateSlice';

// ── 文件级单 mock 桥（零 spyOn——挂自建 vi.fn；beforeEach 清计数）──

function sliceDetailFixture(): WorldSliceDetail {
  return { anchor: ANCHOR_T3, groups: [] };
}
function subjectDetailFixture(): WorldSubjectDetail {
  return { patches: [] }; // CR #4 后契约仅全史 patches（快照/issues 由 UI 本地 reduceSubject 重算）
}
const worldOverviewSpy = vi.fn(async (): Promise<WorldOverview> => OVERVIEW);
const worldSliceDetailSpy = vi.fn(async (): Promise<WorldSliceDetail> => sliceDetailFixture());
const worldSubjectDetailSpy = vi.fn(async (): Promise<WorldSubjectDetail> => subjectDetailFixture());
// #203 跳场景出口 = openWriting（readFile + openFile 文件 tab 流）——桥面须带 readFile。
const readFileSpy = vi.fn(async (): Promise<string> => '# 第十三章\n正文内容');

function installBridge() {
  (window as any).orisonDesktop = {
    worldOverview: worldOverviewSpy,
    worldSliceDetail: worldSliceDetailSpy,
    worldSubjectDetail: worldSubjectDetailSpy,
    readFile: readFileSpy,
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

const SHEN_ROW = subjectRow('character:shen-yan', { name: '沈砚', lastStoryTime: 3, axes: ['physical', 'cognitive', 'emotional'] });
const MIYA_ROW = subjectRow('character:miya', { name: '米娅', lastStoryTime: 3, axes: ['cognitive', 'emotional', 'relational'] });
const POD_ROW = subjectRow('item:cryo-pod-01', { name: '休眠舱', lastStoryTime: 1, axes: ['physical'] });

let patchSeq = 0;
function patch(overrides: Partial<WorldPatch> & { path: string; storyTime: number; axis: WorldPatchAxis }): WorldPatch {
  patchSeq += 1;
  return {
    id: `p-${patchSeq}`,
    sliceId: `ep-x:${overrides.storyTime}`,
    subjectId: 'character:shen-yan',
    op: 'replace',
    source: 'derived',
    ...overrides,
  };
}

const P_T3_MOOD = patch({
  path: '/mood', storyTime: 3, axis: 'emotional',
  value: { objective: '入学紧张', reader_perceived: '故作老成', vad: { v: -0.2, a: 0.5, d: 0 } },
  summary: '身份伪装下的应激',
});
const P_T3_SUSP = patch({
  path: '/suspects/小关的动机', storyTime: 3, axis: 'cognitive',
  value: '小关对舱体坐标的兴趣超出了顺路的解释范围',
  summary: '疑虑转移', evidenceSceneId: 's3',
});
const P_T3_REL = patch({
  subjectId: 'character:miya',
  path: '/relationship/subject:character:shen-yan', storyTime: 3, axis: 'relational',
  value: { objective: '保护对象', reader_perceived: '普通同学' },
  summary: '关系双层',
});
const P_T2_KNOW = patch({
  path: '/knows/米娅的医护手法', storyTime: 2, axis: 'cognitive',
  value: '缝合进针角度是战地规程', summary: '识破手法来源',
});
const P_T2_LOC = patch({
  path: '/location', storyTime: 2, axis: 'physical',
  value: 'subject://item:cryo-pod-01 附近 → 小栗家客房', summary: '移居小栗家',
});
const P_T1_PRESENCE = patch({ path: '/presence_scene', storyTime: 1, axis: 'physical', value: 's1', summary: '核心场景在场' });
const P_T1_MOOD = patch({
  path: '/mood', storyTime: 1, axis: 'emotional',
  value: { objective: '警觉不安', reader_perceived: '镇定自持' }, summary: '双层情绪',
});
const P_T1_SUSP = patch({
  path: '/suspects/舱体来源异常', storyTime: 1, axis: 'cognitive',
  value: '表面光洁无锈，与埋藏地层年代不符', summary: '来源疑虑',
});
// 无基准 increment → 本地 reduce 产 broken-relative issue（issues 徽标测试数据）。
const P_T1_HP = patch({ path: '/hp', storyTime: 1, axis: 'physical', op: 'increment', value: -10, summary: '受伤扣减' });

const ALL_PATCHES: WorldPatch[] = [P_T3_MOOD, P_T3_SUSP, P_T2_KNOW, P_T2_LOC, P_T1_PRESENCE, P_T1_MOOD, P_T1_SUSP, P_T1_HP];

const ANCHOR_T1 = {
  t: 1, label: '唤醒当日', epRange: 'ep1-01..05', title: '荒野舱醒',
  subjectCount: 5, patchCount: 16,
  axisCounts: { physical: 7, cognitive: 6, emotional: 3, relational: 0, factional: 0 },
};
const ANCHOR_T2 = {
  t: 2, label: '入住小栗家', epRange: 'ep1-06..12', title: '屋檐之下',
  subjectCount: 3, patchCount: 4,
  axisCounts: { physical: 2, cognitive: 1, emotional: 0, relational: 1, factional: 0 },
};
const ANCHOR_T3 = {
  t: 3, label: '入学首日', epRange: 'ep1-13..20', title: '陌生教室',
  subjectCount: 2, patchCount: 3,
  axisCounts: { physical: 0, cognitive: 1, emotional: 1, relational: 1, factional: 0 },
};

const OVERVIEW: WorldOverview = {
  subjects: [SHEN_ROW, MIYA_ROW, POD_ROW],
  anchors: [ANCHOR_T1, ANCHOR_T2, ANCHOR_T3],
  patchTotal: 23,
  latestT: 3,
};

const SLICE_DETAIL: WorldSliceDetail = {
  anchor: ANCHOR_T3,
  groups: [
    { subject: SHEN_ROW, patches: [P_T3_MOOD, P_T3_SUSP] },
    { subject: MIYA_ROW, patches: [P_T3_REL] },
  ],
};

const SUBJECT_DETAIL: WorldSubjectDetail = {
  patches: ALL_PATCHES,
};

// 跳场景映射数据（scene_graph → episode_outlines → novelChapters 三段链）。
const SCENE_GRAPH = { nodes: [{ id: 's3', episodeId: 'ep1-13', storyTime: 3 }], lines: [], edges: [] };
const EPISODES = [{ id: 'ep1-13', index: 12 }];
const CHAPTERS = [{
  id: 'ch-13', title: '第十三章', sortOrder: 12, status: 'draft' as const,
  // #203：跳转出口开的是章正文文件 tab——章 fixture 须携 contentFile（章未写置灰见下方用例）。
  sections: [{ id: 'ch-13-s', sortOrder: 0, contentFile: 'chapters/ep1-13.md' }],
}];

const DEFAULT_VIEW: WorldViewState = {
  view: 'overview',
  viewT: null,
  selectedSubjectId: null,
  asOfT: null,
  pathFilter: null,
  axisOn: { physical: true, cognitive: true, emotional: true, relational: true, factional: true },
};

function viewState(overrides: Partial<WorldViewState> = {}): WorldViewState {
  return { ...DEFAULT_VIEW, ...overrides };
}

function seedState(overrides: Record<string, unknown> = {}) {
  // 两步落种（worldStatePanelL1 谱）：先 currentProject（null→path 触发 reset），再数据。
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN',
  } as any);
  useAppStore.setState({
    worldView: viewState(),
    worldViewHydratedPath: '/proj-1',
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
    activeChapterId: null,
    // 文件 tab 面跨测复位（跳场景断言 openWriting 落点——上测开过的 tab 不泄漏进本测）。
    openFiles: [],
    activeFilePath: null,
    creativeFields: {},
    novelChapters: [],
    ...overrides,
  } as any);
}

/** L3 就绪态种子（detail 已装且主体/时点匹配 → 挂载 effect 不发 IPC）。 */
function seedSubjectView(overrides: Record<string, unknown> = {}) {
  seedState({
    worldView: viewState({ view: 'subject', selectedSubjectId: 'character:shen-yan' }),
    worldSubjectDetail: SUBJECT_DETAIL,
    worldSubjectDetailSubjectId: 'character:shen-yan',
    ...overrides,
  });
}

/** 轴 chip 按轴名取按钮（chips 行内 scoping——AxisDots 的 title 同名，避免歧义）。 */
function chipButton(container: HTMLElement, label: string): HTMLButtonElement {
  const chips = [...container.querySelectorAll('.world-chips-row .world-axis-chip')];
  const hit = chips.find((el) => el.querySelector('.world-axis-chip-label')?.textContent === label);
  expect(hit, `chips 行应有「${label}」`).toBeTruthy();
  return hit as HTMLButtonElement;
}

function spineScroll(container: HTMLElement): HTMLElement {
  return container.querySelector('.world-spine-scroll')!;
}

beforeEach(() => {
  worldOverviewSpy.mockClear();
  worldSliceDetailSpy.mockClear();
  worldSubjectDetailSpy.mockClear();
  readFileSpy.mockClear();
  worldOverviewSpy.mockImplementation(async () => OVERVIEW);
  worldSliceDetailSpy.mockImplementation(async () => SLICE_DETAIL);
  worldSubjectDetailSpy.mockImplementation(async () => SUBJECT_DETAIL);
  localStorage.clear();
  installBridge();
});

afterEach(() => {
  cleanup();
  delete (window as any).orisonDesktop;
});

describe('L2 时点切片', () => {
  it('分组渲染齐备：面包屑 / 场景摘要行 / 组头（主体+变更数+点进主体）/ 变更行（path+op+摘要）', () => {
    seedState({
      worldView: viewState({ view: 'slice', viewT: 3 }),
      worldSliceDetail: SLICE_DETAIL,
      worldSliceDetailT: 3,
    });
    const { container } = render(<WorldStatePanel />);

    // 面包屑：世界 › 入学首日（t=3）。
    expect(screen.getByText('世界')).toBeInTheDocument();
    expect(screen.getByText('入学首日（t=3）')).toBeInTheDocument();

    // 场景摘要行（#208：含章范围徽标 epRange）。
    expect(screen.getByText('场景「陌生教室」')).toBeInTheDocument();
    expect(screen.getByText('ep1-13..20')).toBeInTheDocument();
    expect(screen.getByText('2 个主体 · 3 项变更')).toBeInTheDocument();

    // 组头（跨主体分组）。
    const names = [...container.querySelectorAll('.world-sgrp-name')].map((el) => el.textContent);
    expect(names).toEqual(['沈砚', '米娅']);
    expect(screen.getByText('2 项变更 · 点进主体 ›')).toBeInTheDocument();
    expect(screen.getByText('1 项变更 · 点进主体 ›')).toBeInTheDocument();

    // 变更行：path / op / 摘要。
    expect(screen.getByText('/mood')).toBeInTheDocument();
    expect(screen.getByText('/suspects/小关的动机')).toBeInTheDocument();
    expect(screen.getByText('/relationship/subject:character:shen-yan')).toBeInTheDocument();
    expect(screen.getByText('疑虑转移')).toBeInTheDocument();
  });

  it('chips：计数来自锚点聚合、弱轴 0 灰显、点轴过滤即时生效——纯本地零 IPC', () => {
    seedState({
      worldView: viewState({ view: 'slice', viewT: 3 }),
      worldSliceDetail: SLICE_DETAIL,
      worldSliceDetailT: 3,
    });
    const { container } = render(<WorldStatePanel />);

    // 已装数据（detail T 匹配 + overview 已装）→ 挂载零拉取。
    expect(worldOverviewSpy).not.toHaveBeenCalled();
    expect(worldSliceDetailSpy).not.toHaveBeenCalled();

    // 计数来自 anchor.axisCounts（physical 0 / cognitive 1 / relational 1）。
    expect(chipButton(container, '物理').className).toContain('is-empty');
    expect(chipButton(container, '认知').querySelector('.world-axis-chip-count')!.textContent).toBe('1');
    expect(chipButton(container, '关系').querySelector('.world-axis-chip-count')!.textContent).toBe('1');

    // 点认知 chip → 认知行消失、组重建（沈砚组只剩情绪 1 行）；关系行保留。两现存组
    // 各 1 行 → '1 项变更' 出现两次（getByText 会因多元素炸，用 getAllByText）。
    fireEvent.click(chipButton(container, '认知'));
    expect(screen.queryByText('/suspects/小关的动机')).toBeNull();
    expect(screen.getByText('/mood')).toBeInTheDocument();
    expect(screen.getByText('/relationship/subject:character:shen-yan')).toBeInTheDocument();
    expect(screen.getAllByText('1 项变更 · 点进主体 ›').length).toBe(2);
    expect(screen.queryByText('2 项变更 · 点进主体 ›')).toBeNull();

    // 交互质量不变式：本地过滤零 IPC——三桥 spy 全程未增。
    expect(worldOverviewSpy).not.toHaveBeenCalled();
    expect(worldSliceDetailSpy).not.toHaveBeenCalled();
    expect(worldSubjectDetailSpy).not.toHaveBeenCalled();
  });

  it('未知轴防御（#10/#205）：契约外轴默认显示不静默过滤，chips 不产 NaN 计数', () => {
    const exotic = patch({
      path: '/custom_axis_field', storyTime: 3, axis: 'esoteric' as WorldPatchAxis,
      value: '未来扩展轴载荷', summary: '未知轴',
    });
    seedState({
      worldView: viewState({ view: 'slice', viewT: 3 }),
      worldSliceDetail: { anchor: ANCHOR_T3, groups: [{ subject: SHEN_ROW, patches: [P_T3_MOOD, exotic] }] },
      worldSliceDetailT: 3,
    });
    const { container } = render(<WorldStatePanel />);

    // 未知轴行默认显示（axisOn[axis] !== false——axisOn 只登记五轴）。
    expect(screen.getByText('/custom_axis_field')).toBeInTheDocument();
    // chips 只列五轴、计数来自锚点聚合全键 record——未知轴不造 chip、无 NaN。
    expect(container.textContent).not.toContain('NaN');
    // 关情绪轴：情绪行消失、未知轴行不受 chips 影响（不静默滤掉）。
    fireEvent.click(chipButton(container, '情绪'));
    expect(screen.queryByText('/mood')).toBeNull();
    expect(screen.getByText('/custom_axis_field')).toBeInTheDocument();
  });

  it('L2 stale chrome 防御（#202）：detail T 不匹配时不消费旧 anchor/组——面包屑与计数取 overview 行，正文骨架', async () => {
    // 场景：从 t=3 下钻后（t=3 detail 在缓存）导航到 t=1——新 detail 在途，旧数据不得配新 viewT 渲染。
    seedState({
      worldView: viewState({ view: 'slice', viewT: 1 }),
      worldSliceDetail: SLICE_DETAIL, // t=3 的旧缓存
      worldSliceDetailT: 3,
    });
    const { container } = render(<WorldStatePanel />);

    // 面包屑 = viewT=1 的 overview 锚点（唤醒当日），非旧 t=3 的入学首日。
    expect(screen.getByText('唤醒当日（t=1）')).toBeInTheDocument();
    expect(screen.queryByText('入学首日（t=3）')).toBeNull();
    // chips 计数取 overview t=1 锚（认知 6），非旧锚的 1。
    expect(chipButton(container, '认知').querySelector('.world-axis-chip-count')!.textContent).toBe('6');
    // 正文骨架（未就绪不闪旧组；错误块独立——此处无错误，加载中）。
    expect(screen.getByRole('status', { name: '加载世界状态…' })).toBeInTheDocument();
    expect(container.querySelector('.world-sgrp')).toBeNull();
    // 等在途请求落定（跨测在途 resolve 竞态防护，本文件实录先例）。
    await waitFor(() => expect(useAppStore.getState().worldSliceDetailT).toBe(1));
  });

  it('组头点进主体 → 直达 L3', () => {
    seedState({
      worldView: viewState({ view: 'slice', viewT: 3 }),
      worldSliceDetail: SLICE_DETAIL,
      worldSliceDetailT: 3,
    });
    const { container } = render(<WorldStatePanel />);
    const head = [...container.querySelectorAll('.world-sgrp-head')].find((el) => el.textContent?.includes('沈砚'))!;
    fireEvent.click(head);

    expect(useAppStore.getState().worldView.view).toBe('subject');
    expect(useAppStore.getState().worldView.selectedSubjectId).toBe('character:shen-yan');
  });

  it('变更行展开完整 value：分层对象逐层显（层名小标）+ vad 紧凑形；再点收起', () => {
    seedState({
      worldView: viewState({ view: 'slice', viewT: 3 }),
      worldSliceDetail: SLICE_DETAIL,
      worldSliceDetailT: 3,
    });
    const { container } = render(<WorldStatePanel />);

    const moodHead = [...container.querySelectorAll('.world-patch-head')].find((el) => el.textContent?.includes('/mood'))!;
    // 未展开：value 不在。
    expect(spineScroll(container).textContent).not.toContain('入学紧张');
    fireEvent.click(moodHead);
    // 分层渲染：客观/读者感知层名 + 各层值 + vad 紧凑串。
    const value = container.querySelector('.world-patch-value')!;
    expect(value.textContent).toContain('客观');
    expect(value.textContent).toContain('入学紧张');
    expect(value.textContent).toContain('读者感知');
    expect(value.textContent).toContain('故作老成');
    expect(value.textContent).toContain('情绪投影');
    expect(value.textContent).toContain('v -0.2 · a 0.5 · d 0');
    fireEvent.click(moodHead);
    expect(spineScroll(container).textContent).not.toContain('入学紧张');
  });

  it('跳场景钮：scene→章映射命中 → 可点，openWriting 开该章正文 md 文件 tab（#203 拍板出口）', async () => {
    seedState({
      worldView: viewState({ view: 'slice', viewT: 3 }),
      worldSliceDetail: SLICE_DETAIL,
      worldSliceDetailT: 3,
      creativeFields: { scene_graph: SCENE_GRAPH, episode_outlines: EPISODES },
      novelChapters: CHAPTERS,
    });
    render(<WorldStatePanel />);

    const jump = screen.getByRole('button', { name: '跳场景' });
    expect((jump as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(jump);

    // openWriting 同款流：readFile + openFile → 文件 tab 激活（mainView 切 files）。
    await waitFor(() => {
      expect(useAppStore.getState().activeFilePath).toBe('/proj-1/chapters/ep1-13.md');
    });
    expect(useAppStore.getState().mainView).toBe('files');
    expect(useAppStore.getState().openFiles[0]?.name).toBe('ep1-13.md');
  });

  it('跳场景钮：章未写正文文件（sections 空）→ 置灰不崩（点击无效）', () => {
    seedState({
      worldView: viewState({ view: 'slice', viewT: 3 }),
      worldSliceDetail: SLICE_DETAIL,
      worldSliceDetailT: 3,
      creativeFields: { scene_graph: SCENE_GRAPH, episode_outlines: EPISODES },
      novelChapters: [{ ...CHAPTERS[0], sections: [] }], // 章 row 在、正文文件未建。
    });
    render(<WorldStatePanel />);

    const jump = screen.getByRole('button', { name: '跳场景' });
    expect((jump as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(jump);
    expect(useAppStore.getState().activeFilePath).toBeNull();
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('跳场景钮：查不到章映射 → 置灰不崩（点击无效）', () => {
    seedState({
      worldView: viewState({ view: 'slice', viewT: 3 }),
      worldSliceDetail: SLICE_DETAIL,
      worldSliceDetailT: 3,
      // 无 scene_graph / 无章表 → 映射断链。
    });
    render(<WorldStatePanel />);

    const jump = screen.getByRole('button', { name: '跳场景' });
    expect((jump as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(jump);
    expect(useAppStore.getState().activeFilePath).toBeNull();
  });

  it('未就绪骨架（detail 未装且在途 → status 块）', async () => {
    seedState({ worldView: viewState({ view: 'slice', viewT: 3 }) });
    const { unmount } = render(<WorldStatePanel />);
    expect(screen.getByRole('status', { name: '加载世界状态…' })).toBeInTheDocument();
    // 等在途请求落定后再 unmount——跨测在途 resolve 会落进下一测的 store，盖掉注入的
    // 失败（stale-resolve 竞态，本文件实录）。
    await waitFor(() => expect(useAppStore.getState().worldSliceDetail).not.toBeNull());
    unmount();
  });

  it('拉取失败错误块 + 重试闭环（挂载首拉 reject → 重试成功落数据）', async () => {
    worldSliceDetailSpy
      .mockRejectedValueOnce(new Error('切片拉取失败'))
      .mockImplementation(async () => SLICE_DETAIL);
    seedState({ worldView: viewState({ view: 'slice', viewT: 3 }) });
    render(<WorldStatePanel />);
    expect(await screen.findByText('世界状态加载失败')).toBeInTheDocument();
    expect(screen.getByText('切片拉取失败')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(worldSliceDetailSpy).toHaveBeenCalledTimes(2); // 挂载首拉 + 重试
      expect(worldSliceDetailSpy).toHaveBeenLastCalledWith({ projectId: 'p1', t: 3 });
    });
    expect(await screen.findByText('场景「陌生教室」')).toBeInTheDocument();
  });

  it('空时点（服务端 friendly-empty：零值锚点 + 空组）', () => {
    seedState({
      worldView: viewState({ view: 'slice', viewT: 3 }),
      worldSliceDetail: { anchor: ANCHOR_T3, groups: [] },
      worldSliceDetailT: 3,
    });
    render(<WorldStatePanel />);
    expect(screen.getByText('该时点没有变更。')).toBeInTheDocument();
  });
});

describe('L3 主体脊柱', () => {
  it('切线：点锚点圆点 → 快照本地回退 + 更晚折叠计数 + 更晚锚点隐藏；点切线行回现在——全程零 IPC', () => {
    seedSubjectView();
    const { container } = render(<WorldStatePanel />);
    expect(worldSubjectDetailSpy).not.toHaveBeenCalled();

    // 初始：回放现在，最新快照含 t2/t3 态。
    expect(screen.getByText('回放：现在')).toBeInTheDocument();
    const snapshot = container.querySelector('.world-snapshot')!;
    expect(snapshot.textContent).toContain('最新状态');
    expect(snapshot.textContent).toContain('入学紧张');
    expect(snapshot.textContent).toContain('缝合进针角度是战地规程');

    // 点 t=1 锚点圆点切线。
    fireEvent.click(screen.getByRole('button', { name: '切线到 t=1' }));
    expect(useAppStore.getState().worldView.asOfT).toBe(1);

    // 切线行带锚点 label；快照回退到 t=1（旧值在、新值不在）。
    expect(screen.getByText(/回放：唤醒当日（t=1）/)).toBeInTheDocument();
    const reverted = container.querySelector('.world-snapshot')!;
    expect(reverted.textContent).toContain('t=1 时状态');
    expect(reverted.textContent).toContain('警觉不安');
    expect(reverted.textContent).not.toContain('入学紧张');
    expect(reverted.textContent).not.toContain('缝合进针角度');

    // 更晚折叠灰条：t>1 共 4 条（mood/suspects t3 + knows/location t2）。
    expect(screen.getByText('▲ 4 条更晚的变更在回放之后（点击回到现在）')).toBeInTheDocument();

    // 更晚锚点隐藏：脊柱只剩 t=1 块。
    expect(spineScroll(container).textContent).not.toContain('t=3');
    expect(spineScroll(container).textContent).not.toContain('t=2');
    expect(spineScroll(container).textContent).toContain('t=1');

    // 零 IPC：切线是本地重折叠，subject-detail 不重发。
    expect(worldSubjectDetailSpy).not.toHaveBeenCalled();

    // 点切线行回现在。
    fireEvent.click(screen.getByRole('button', { name: /回放：唤醒当日/ }));
    expect(useAppStore.getState().worldView.asOfT).toBeNull();
    expect(screen.getByText('回放：现在')).toBeInTheDocument();
    expect(screen.queryByText(/条更晚的变更/)).toBeNull();
    expect(spineScroll(container).textContent).toContain('t=3');
    expect(worldSubjectDetailSpy).not.toHaveBeenCalled();
  });

  it('进视图首拉无 at 参：持久化恢复 asOf=2 的 L3 → bridge 只收 projectId+subjectId（切线全本地，CR #4）', async () => {
    seedSubjectView({
      worldView: viewState({ view: 'subject', selectedSubjectId: 'character:shen-yan', asOfT: 2 }),
      worldSubjectDetail: null,
      worldSubjectDetailSubjectId: null,
    });
    render(<WorldStatePanel />);

    await waitFor(() => expect(worldSubjectDetailSpy).toHaveBeenCalledTimes(1));
    expect(worldSubjectDetailSpy).toHaveBeenLastCalledWith({
      projectId: 'p1',
      subjectId: 'character:shen-yan',
    });
  });

  it('路径钻取：点快照键 → 只看该 path 全部变更 + 首条自动展开 + 手动收起 + ✕ 清除', () => {
    seedSubjectView();
    const { container } = render(<WorldStatePanel />);

    // 快照键 = patch path（mood 在场）。
    fireEvent.click(screen.getByRole('button', { name: 'mood' }));
    expect(useAppStore.getState().worldView.pathFilter).toBe('/mood');

    // 钻取条 + 行内只留 /mood（两个时点块各 1 行）。
    expect(container.querySelector('.world-pathfilter code')!.textContent).toBe('/mood');
    expect(screen.queryByText('/suspects/小关的动机')).toBeNull();
    expect(screen.queryByText('/knows/米娅的医护手法')).toBeNull();
    expect(spineScroll(container).textContent).toContain('t=3');
    expect(spineScroll(container).textContent).toContain('t=1');

    // 首条自动展开：两块的 mood 值未点行即可见。
    expect(spineScroll(container).textContent).toContain('入学紧张');
    expect(spineScroll(container).textContent).toContain('警觉不安');

    // 手动收起（autoOpen XOR 显式翻转）。
    const t3MoodHead = [...container.querySelectorAll('.world-patch-head')].find(
      (el) => el.textContent?.includes('/mood') && el.textContent?.includes('身份伪装'),
    )!;
    fireEvent.click(t3MoodHead);
    expect(spineScroll(container).textContent).not.toContain('入学紧张');
    expect(spineScroll(container).textContent).toContain('警觉不安');

    // ✕ 清除 → 全部变更回来。
    fireEvent.click(screen.getByRole('button', { name: '✕ 清除' }));
    expect(useAppStore.getState().worldView.pathFilter).toBeNull();
    expect(screen.getByText('/suspects/小关的动机')).toBeInTheDocument();
  });

  it('未知轴防御（L3，#110）：行默认显示 + 本地轴计数容错不 NaN；关五轴不隐藏未知轴行', () => {
    const exotic = patch({
      path: '/custom_axis_field', storyTime: 1, axis: 'esoteric' as WorldPatchAxis,
      value: '未来扩展轴载荷', summary: '未知轴',
    });
    seedSubjectView({ worldSubjectDetail: { patches: [exotic] } });
    const { container } = render(<WorldStatePanel />);

    expect(screen.getByText('/custom_axis_field')).toBeInTheDocument();
    // 本地计数 Record<string, number> ?? 0 容错——chips 不产 NaN。
    expect(container.textContent).not.toContain('NaN');
    // 五轴全关（未知轴不在 chips 里、axisOn 无其键）→ 未知轴行仍显示。
    for (const label of ['物理', '认知', '情绪', '关系', '势力']) {
      fireEvent.click(chipButton(container, label));
    }
    expect(screen.getByText('/custom_axis_field')).toBeInTheDocument();
  });

  it('过滤空分支（#103）：轴全关 → 过滤空态提示（区别于空库态）', () => {
    seedSubjectView({
      worldView: viewState({
        view: 'subject',
        selectedSubjectId: 'character:shen-yan',
        axisOn: { physical: false, cognitive: false, emotional: false, relational: false, factional: false },
      }),
    });
    render(<WorldStatePanel />);

    expect(screen.getByText('当前轴过滤下没有可显示的变更。')).toBeInTheDocument();
    expect(screen.queryByText('该主体还没有任何变更记录。')).toBeNull();
  });

  it('过滤空分支（#103）：路径钻取无命中 → 同一空态提示', () => {
    seedSubjectView({
      worldView: viewState({ view: 'subject', selectedSubjectId: 'character:shen-yan', pathFilter: '/不存在的路径' }),
    });
    render(<WorldStatePanel />);

    expect(screen.getByText('当前轴过滤下没有可显示的变更。')).toBeInTheDocument();
  });

  it('issues 徽标：无基准 increment → 行内「基准缺失」警示（本地 reduce 产出）', () => {
    seedSubjectView();
    const { container } = render(<WorldStatePanel />);

    const badge = container.querySelector('.world-issue-badge')!;
    expect(badge.textContent).toBe('基准缺失');
    // 徽标挂在 /hp 行内（title 带 reduce 的诊断信息）。
    expect(badge.closest('.world-patch')?.textContent).toContain('/hp');
  });

  it('快照值内 subject:// 引用 → 可点 chip 直达该主体 L3', () => {
    seedSubjectView();
    const { container } = render(<WorldStatePanel />);

    // 快照 location 值含引用；chip 显示主体名（主体列表在手解析）。
    const chip = container.querySelector('.world-snapshot .world-ref-chip') as HTMLButtonElement;
    expect(chip.textContent).toBe('休眠舱');
    fireEvent.click(chip);

    expect(useAppStore.getState().worldView.selectedSubjectId).toBe('item:cryo-pod-01');
    expect(useAppStore.getState().worldView.view).toBe('subject');
  });

  it('空主体（零变更）空态', () => {
    seedSubjectView({
      worldSubjectDetail: { patches: [] },
    });
    render(<WorldStatePanel />);

    expect(screen.getByText('该主体还没有任何变更记录。')).toBeInTheDocument();
    expect(screen.getByText('这个时点还没有任何状态（早于全部变更）。')).toBeInTheDocument();
  });

  it('拉取失败错误块 + 重试闭环（挂载首拉 reject → 重试成功）', async () => {
    worldSubjectDetailSpy
      .mockRejectedValueOnce(new Error('主体拉取失败'))
      .mockImplementation(async () => SUBJECT_DETAIL);
    seedSubjectView({ worldSubjectDetail: null, worldSubjectDetailSubjectId: null });
    render(<WorldStatePanel />);

    expect(await screen.findByText('主体拉取失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(worldSubjectDetailSpy).toHaveBeenCalledTimes(2); // 挂载首拉 + 重试
      expect(worldSubjectDetailSpy).toHaveBeenLastCalledWith({
        projectId: 'p1',
        subjectId: 'character:shen-yan',
        at: undefined,
      });
    });
    expect(await screen.findByText('回放：现在')).toBeInTheDocument();
  });
});

describe('i18n en（L3 面）', () => {
  it('en locale 下 L2/L3 文案齐平渲染', () => {
    seedSubjectView({ resolvedLocale: 'en-US' });
    const { container } = render(<WorldStatePanel />);

    expect(screen.getByText('Replay: now')).toBeInTheDocument();
    expect(container.querySelector('.world-snapshot')!.textContent).toContain('latest state');
    expect(chipButton(container, 'Physical')).toBeTruthy();
    expect(screen.getByText('World')).toBeInTheDocument();
  });
});
