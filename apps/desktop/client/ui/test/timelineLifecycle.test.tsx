/**
 * dogfood R2 批次 A + D2：时间线场景/线生命周期手势 + 抽屉直写区 + 跳转/高亮闭环
 * （research/ui-design-outline-timeline.md SP-1/2/3 + 第三节 D2）。
 *
 * 覆盖（验收清单逐项）：
 *  - 右键菜单：格上（改名开抽屉/role 直选/复制 id/删除）/ 线标签（topology/可见度/
 *    删线）/ 空白与列头（在此列新建）；backdrop 外点 + Esc 关闭。
 *  - 新建投影：add_scene + 默认线（聚焦线 ∥ 主线）+ 建后开抽屉聚焦标题。
 *  - 删除：确认文案带边数/场景数（数据实）；投影后边级联清 + lineTags 摘除。
 *  - 抽屉直写区：role select / storyTime（blur 钳制）/ lineTags chips / 枚举 select
 *    （词表 + 自定义）/ 连边（自环·重复阻止）/ 删边 / 标题·摘要 500ms debounce /
 *    AI 补全发 sendAgentMessage / 定位滚动。
 *  - 线管理：新增线 + inline 改名 / topology update_line。
 *  - 工作台 chip 点击开抽屉（SP-3 接线，08-26 批 3 自编织格迁移）。
 *  - D2：focusIssueTargets 消费补 scrollIntoView；agent 落盘新增集 → highlightNodeIds
 *    → SceneCell 绿框类；user 落盘不高亮。
 *  - BMad CR（dogfood round2）：CR-4 TTL 不因图编辑中断；CR-25 高亮改走
 *    pendingStructureHighlight stash（挂载/晚到都消费）；CR-10 AI 指令带 id；
 *    CR-11 同值提交不写（右键 role/拓扑/位移 + 抽屉 select + 线改名）；CR-14 inline
 *    输入 commit-once 守卫（Enter/Esc 卸载后派生 blur 不二次提交）；CR-19 非法
 *    storyTime 还原不写；CR-23 __custom__ 哨兵撞值不双 option。
 *
 * Store 驱动照 NarrativeTimelinePanel.test 先例（useAppStore.setState）。Run:
 * `cd apps/desktop/client/ui && pnpm test timelineLifecycle`
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sceneGraphSchema, episodeOutlinesSchema, type SceneGraph } from '@orison/shared-contracts';
import { NarrativeTimelinePanel } from '../src/features/structure/NarrativeTimelinePanel';
import { SceneEditPopover } from '../src/features/structure/SceneEditPopover';
import { StructurePage } from '../src/features/structure/StructurePage';
import { useAppStore } from '../src/shared/store/appStore';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

const ALL_OVERLAYS_ON = { validation: true, displacement: true, visibility: true };

/**
 * 两线三场景 + 标题/摘要（直写区断言需要既有值）：
 *   s1 (l_main, t1) ──e1 CAUSAL──▶ s2 (l_main+l_side, t2) ──e2 SUSPENSE──▶ s3 (l_side, t3)
 */
function baseGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
      { id: 'l_side', name: '副线', topology_role: 'side' },
    ],
    nodes: [
      { id: 's1', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      {
        id: 's2', lineTags: ['l_main', 'l_side'], storyTime: 2, role: 'core-anchor',
        presentationOrder: { chapter: 0, pos: 1 }, title: '学院祭', summary: '旧摘要',
      },
      { id: 's3', lineTags: ['l_side'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 2, pos: 0 } },
    ],
    edges: [
      { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' },
      { id: 'e2', from: 's2', to: 's3', type: 'SUSPENSE' },
    ],
  });
}

const EPISODES = [
  { id: 'e0', index: 0, title: '第一章' },
  { id: 'e1', index: 1, title: '第二章' },
  { id: 'e2', index: 2, title: '第三章' },
];

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    creativeFields: { scene_graph: baseGraph(), episode_outlines: EPISODES },
    overlayToggles: { ...ALL_OVERLAYS_ON },
    selectedNodeId: null,
    focusedLineId: null,
    focusIssueTargets: null,
    highlightNodeIds: [],
    editingLineId: null,
    drawerTitleFocus: false,
    pendingStructureHighlight: [],
    resolvedLocale: 'en-US',
    currentProject: null,
    fieldMetadata: {},
    ...overrides,
  } as any);
}

describe('SP-1 scene context menu (open + actions)', () => {
  beforeEach(() => seedStore());
  afterEach(() => cleanup());

  it('opens on cell contextmenu with rename/roles/copy/delete items', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const cell = container.querySelector('[data-node-id="s2"]') as HTMLElement;
    fireEvent.contextMenu(cell);
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]');
    expect(menu).not.toBeNull();
    for (const key of ['rename', 'role-normal', 'role-core-anchor', 'role-secondary-anchor', 'role-fork-point', 'copy-id', 'delete']) {
      expect(menu!.querySelector(`[data-menu-key="${key}"]`)).not.toBeNull();
    }
    // 删除项 hint 携带真实边数（s2 有 e1 入 + e2 出 = 2）。
    expect(menu!.querySelector('[data-menu-key="delete"]')!.textContent).toContain('2');
  });

  it('closes on backdrop click and on Escape', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-node-id="s2"]')!);
    expect(container.querySelector('[data-testid="timeline-ctx-menu"]')).not.toBeNull();

    fireEvent.click(container.querySelector('[data-testid="timeline-ctx-backdrop"]')!);
    expect(container.querySelector('[data-testid="timeline-ctx-menu"]')).toBeNull();

    fireEvent.contextMenu(container.querySelector('[data-node-id="s2"]')!);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('[data-testid="timeline-ctx-menu"]')).toBeNull();
  });

  it('rename opens the popover with the title input focused (drawerTitleFocus flag)', () => {
    const { container } = render(<StructurePage />);
    fireEvent.contextMenu(container.querySelector('[data-node-id="s2"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="rename"]')!);
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover?.dataset.sceneId).toBe('s2');
    // 一次性旗标被消费 + 标题输入框拿到焦点（inline 编辑态语义）。
    expect(useAppStore.getState().drawerTitleFocus).toBe(false);
    expect((document.activeElement as HTMLElement)?.dataset?.field).toBe('title');
  });

  it('role item writes update_scene via the shared projector', () => {
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-node-id="s1"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="role-fork-point"]')!);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    expect(written.nodes.find((n) => n.id === 's1')!.role).toBe('fork-point');
    updateSpy.mockRestore();
  });

  it('copy-id does not crash without a clipboard (jsdom)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-node-id="s1"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="copy-id"]')!);
    expect(container.querySelector('[data-testid="timeline-ctx-menu"]')).toBeNull();
  });
});

describe('SP-1 scene delete (confirm copy + edge-cascade projection)', () => {
  beforeEach(() => seedStore());
  afterEach(() => cleanup());

  it('menu delete → confirm dialog with the real edge count → cascade projection', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-node-id="s2"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="delete"]')!);
    const desc = container.querySelector('.delete-confirm-desc');
    expect(desc?.textContent).toContain('2');
    fireEvent.click(container.querySelector('.delete-confirm-action')!);
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.some((n) => n.id === 's2')).toBe(false);
    // 投影器 remove_scene 不级联 → action 数组补齐：触及边（e1/e2）全清。
    expect(graph.edges).toHaveLength(0);
    expect(graph.nodes.map((n) => n.id)).toEqual(['s1', 's3']);
  });

  it('popover delete button → same dialog + projection, selection cleared', () => {
    seedStore({ selectedNodeId: 's2' });
    const { container } = render(<SceneEditPopover />);
    fireEvent.click(container.querySelector('[data-action="delete-scene"]')!);
    fireEvent.click(container.querySelector('.delete-confirm-action')!);
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.some((n) => n.id === 's2')).toBe(false);
    expect(graph.edges).toHaveLength(0);
    expect(useAppStore.getState().selectedNodeId).toBeNull();
  });
});

describe('SP-1 add scene (column ＋ / blank & column contextmenu)', () => {
  beforeEach(() => seedStore());
  afterEach(() => cleanup());

  it('column ＋ button writes add_scene with the default line + opens the popover focused', () => {
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<StructurePage />);
    // causal 侧「第 2 章」列头里的 ＋（批 7：col-value = 章 index）。
    const addBtn = container.querySelector(
      '[data-skeleton="causal"] [data-col-value="1"] [data-action="add-scene"]'
    ) as HTMLElement;
    expect(addBtn).not.toBeNull();
    fireEvent.click(addBtn);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    const added = written.nodes.find((n) => n.id === 'S-1')!;
    // 批 7 章轴：新建归属章 = 所点列（index 1）、pos 追加、storyTime = 全图 max+1 中性默认。
    expect(added).toMatchObject({ storyTime: 4, role: 'normal', lineTags: ['l_main'] });
    expect(added.presentationOrder).toMatchObject({ chapter: 1 });
    // 建后：选中该场景（抽屉开）+ 聚焦标题一次性旗标 + 输入框拿到焦点。
    expect(useAppStore.getState().selectedNodeId).toBe('S-1');
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover?.dataset.sceneId).toBe('S-1');
    expect((document.activeElement as HTMLElement)?.dataset?.field).toBe('title');
    updateSpy.mockRestore();
  });

  it('default line follows the focused lane when one is focused', () => {
    seedStore({ focusedLineId: 'l_side' });
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.click(container.querySelector('[data-col-value="2"] [data-action="add-scene"]')!);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    expect(written.nodes.find((n) => n.id === 'S-1')!.lineTags).toEqual(['l_side']);
    updateSpy.mockRestore();
  });

  it('column-header contextmenu offers add-in-this-column (same projection)', () => {
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-col-value="2"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="add-scene"]')!);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    const added = written.nodes.find((n) => n.id === 'S-1')!;
    expect(added.presentationOrder.chapter).toBe(2);
    expect(added.storyTime).toBe(4);
    updateSpy.mockRestore();
  });

  it('grid-blank contextmenu opens the add menu at the hit chapter (clientX inside column 0)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const grid = container.querySelector('.narrative-timeline-grid') as HTMLElement;
    // CR3 edge（首列左侧负坐标守卫）：jsdom 零矩形 + zoom=1 下 local = clientX − 160。
    // 默认 clientX=0 → local=−160（泳道标签带）——现在**不再**被钳回章 0 出菜单，
    // 须显式给进第 1 章轨（名义宽 108）的坐标：clientX=210 → local=50 → 章 0。
    fireEvent.contextMenu(grid, { clientX: 210, clientY: 10 });
    expect(container.querySelector('[data-testid="timeline-ctx-menu"]')).not.toBeNull();
    fireEvent.click(container.querySelector('[data-menu-key="add-scene"]')!);
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.some((n) => n.id === 'S-1')).toBe(true);
  });

  it('column ＋ buttons render on every causal column（08-26 批 3：单视图无 reading 分支）', () => {
    const { container } = render(<StructurePage />);
    const adds = container.querySelectorAll('[data-skeleton="causal"] [data-action="add-scene"]');
    expect(adds.length).toBeGreaterThan(0);
  });
});

describe('SP-3 line management (add / inline rename / topology / visibility / delete)', () => {
  beforeEach(() => seedStore());
  afterEach(() => cleanup());

  it('lane-list ＋ button adds L-1 (converging, default name) and enters inline rename', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.click(container.querySelector('[data-action="add-line"]')!);
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const added = graph.lines.find((l) => l.id === 'L-1')!;
    expect(added).toMatchObject({ name: 'New line', topology_role: 'converging' });
    // inline 改名态：泳道标签变输入框；Enter 提交 update_line。
    expect(useAppStore.getState().editingLineId).toBe('L-1');
    const input = container.querySelector('[data-lane-edit="L-1"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    fireEvent.change(input, { target: { value: '感情线' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const written = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(written.lines.find((l) => l.id === 'L-1')!.name).toBe('感情线');
    expect(useAppStore.getState().editingLineId).toBeNull();
    updateSpy.mockRestore();
  });

  it('lane contextmenu rename turns the label into an input (Esc cancels)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-lane-id="l_side"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="rename"]')!);
    const input = container.querySelector('[data-lane-edit="l_side"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useAppStore.getState().editingLineId).toBeNull();
    expect((useAppStore.getState().creativeFields.scene_graph as SceneGraph).lines.find((l) => l.id === 'l_side')!.name).toBe('副线');
  });

  it('topology menu item writes update_line', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-lane-id="l_side"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="topology-offline"]')!);
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.lines.find((l) => l.id === 'l_side')!.topology_role).toBe('offline');
  });

  it('same-value menu submissions write nothing (CR-11: scene role / line topology / displacement)', () => {
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<NarrativeTimelinePanel />);
    // s2 role = core-anchor → 右键同值 role 项不写。
    fireEvent.contextMenu(container.querySelector('[data-node-id="s2"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="role-core-anchor"]')!);
    expect(updateSpy).toHaveBeenCalledTimes(0);
    // l_side topology_role = side → 同值拓扑项不写。
    fireEvent.contextMenu(container.querySelector('[data-lane-id="l_side"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="topology-side"]')!);
    expect(updateSpy).toHaveBeenCalledTimes(0);
    // l_main displacement 默认 none → 同值位移项不写。
    fireEvent.contextMenu(container.querySelector('[data-lane-id="l_main"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="disp-none"]')!);
    expect(updateSpy).toHaveBeenCalledTimes(0);
    updateSpy.mockRestore();
  });

  it('line rename: same-name Enter writes nothing; blur commit still works after an Enter commit (CR-11/CR-14)', () => {
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<NarrativeTimelinePanel />);
    // 同值改名：Enter 提交现名 → 不写。
    fireEvent.contextMenu(container.querySelector('[data-lane-id="l_side"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="rename"]')!);
    let input = container.querySelector('[data-lane-edit="l_side"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '副线' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateSpy).toHaveBeenCalledTimes(0);
    // 再开改名（锁位随 editing 翻转重置）：blur 提交路径照常（守卫不死锁）。
    fireEvent.contextMenu(container.querySelector('[data-lane-id="l_side"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="rename"]')!);
    input = container.querySelector('[data-lane-edit="l_side"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '感情线' } });
    fireEvent.blur(input);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(written.lines.find((l) => l.id === 'l_side')!.name).toBe('感情线');
    updateSpy.mockRestore();
  });

  it('hidden-until menu path opens the target input and writes visibility on Enter', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-lane-id="l_side"]')!);
    fireEvent.click(container.querySelector('[data-menu-key="vis-hidden"]')!);
    const input = container.querySelector('[data-testid="timeline-visibility-input"] input');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: 's2' } });
    fireEvent.keyDown(input!, { key: 'Enter' });
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.lines.find((l) => l.id === 'l_side')!.visibility).toEqual({
      status: 'hidden-until',
      target: 's2',
    });
  });

  it('line delete confirms with the member count, strips lineTags, keeps scenes', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    fireEvent.contextMenu(container.querySelector('[data-lane-id="l_side"]')!);
    // 删除项 hint 带场景数（l_side 有 s2 + s3 = 2）。
    const deleteItem = container.querySelector('[data-menu-key="delete"]')!;
    expect(deleteItem.textContent).toContain('2');
    fireEvent.click(deleteItem);
    expect(container.querySelector('.delete-confirm-desc')?.textContent).toContain('2');
    fireEvent.click(container.querySelector('.delete-confirm-action')!);
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.lines.map((l) => l.id)).toEqual(['l_main']);
    // 场景保留 + lineTags 摘除（投影器 remove_line 不摘 → action 数组补齐）。
    expect(graph.nodes.map((n) => n.id)).toEqual(['s1', 's2', 's3']);
    expect(graph.nodes.find((n) => n.id === 's2')!.lineTags).toEqual(['l_main']);
    expect(graph.nodes.find((n) => n.id === 's3')!.lineTags).toEqual([]);
  });
});

describe('SP-2 popover direct-write zones (projection assertions)', () => {
  beforeEach(() => seedStore({ selectedNodeId: 's2' }));
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('storyTime number commits on blur with the nonnegative clamp', () => {
    const { container } = render(<SceneEditPopover />);
    const input = container.querySelector('[data-field="storyTime"]') as HTMLInputElement;
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    fireEvent.change(input, { target: { value: '-4' } });
    fireEvent.blur(input);
    const written = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(written.nodes.find((n) => n.id === 's2')!.storyTime).toBe(0);
    updateSpy.mockRestore();
  });

  it('cleared / non-numeric storyTime restores the current value without writing (CR-19)', () => {
    // spy 先于 render（组件闭包引用渲染时的 updateField——后 spy 会漏计）。
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<SceneEditPopover />);
    const input = container.querySelector('[data-field="storyTime"]') as HTMLInputElement;
    // 清空提交：还原现值（s2 storyTime=2），绝不静默跳 t=0。
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(updateSpy).toHaveBeenCalledTimes(0);
    expect((container.querySelector('[data-field="storyTime"]') as HTMLInputElement).value).toBe('2');
    // 非数字（parseInt NaN）同样还原不写。
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(updateSpy).toHaveBeenCalledTimes(0);
    expect((container.querySelector('[data-field="storyTime"]') as HTMLInputElement).value).toBe('2');
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.find((n) => n.id === 's2')!.storyTime).toBe(2);
    updateSpy.mockRestore();
  });

  it('same-value drawer submissions write nothing (CR-11: role select / enum select)', () => {
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<SceneEditPopover />);
    // s2 role = core-anchor → select 同值不写。
    fireEvent.change(container.querySelector('[data-field="role"]')!, { target: { value: 'core-anchor' } });
    expect(updateSpy).toHaveBeenCalledTimes(0);
    // 枚举：先写真值（词表值「达成」），再选同值 → 第二次不写。
    const outcome = container.querySelector('[data-field="outcomeType"]') as HTMLSelectElement;
    fireEvent.change(outcome, { target: { value: '达成' } });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    fireEvent.change(container.querySelector('[data-field="outcomeType"]')!, { target: { value: '达成' } });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    updateSpy.mockRestore();
  });

  it('enum custom input: Esc cancels without writing; blur commit still works after Esc (CR-14 lock re-arms per session)', () => {
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<SceneEditPopover />);
    // 进自定义态 → 打字 → Esc：不写（回退 select）。
    fireEvent.change(container.querySelector('[data-field="pacingRole"]')!, { target: { value: '__custom__' } });
    const input = container.querySelector('[data-field="pacingRole-custom"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '草稿' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(updateSpy).toHaveBeenCalledTimes(0);
    // 再进自定义态（锁位已重置）→ blur 提交照常（守卫不死锁正常流）。
    fireEvent.change(container.querySelector('[data-field="pacingRole"]')!, { target: { value: '__custom__' } });
    const input2 = container.querySelector('[data-field="pacingRole-custom"]') as HTMLInputElement;
    fireEvent.change(input2, { target: { value: '双线并进' } });
    fireEvent.blur(input2);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.find((n) => n.id === 's2')!.pacingRole).toBe('双线并进');
    updateSpy.mockRestore();
  });

  it('a stored value equal to the __custom__ sentinel renders ONE sentinel option (CR-23)', () => {
    const g = baseGraph();
    g.nodes[1]!.outcomeType = '__custom__'; // s2 的存量值恰为哨兵
    seedStore({ creativeFields: { scene_graph: g }, selectedNodeId: 's2' });
    const { container } = render(<SceneEditPopover />);
    const select = container.querySelector('[data-field="outcomeType"]') as HTMLSelectElement;
    // 不再「附加 option + 哨兵 option」双枚同值——只保留哨兵一枚，选择态如实落在其上。
    const sentinelOptions = [...select.querySelectorAll('option')].filter((o) => o.getAttribute('value') === '__custom__');
    expect(sentinelOptions).toHaveLength(1);
    expect(select.value).toBe('__custom__');
  });

  it('lineTags chip × removes membership; ＋ adds back from the remaining lines', () => {
    const { container } = render(<SceneEditPopover />);
    // s2 = l_main + l_side → remove l_side.
    fireEvent.click(container.querySelector('[data-action="remove-line-tag"][data-line-id="l_side"]')!);
    let graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.find((n) => n.id === 's2')!.lineTags).toEqual(['l_main']);
    // ＋ add：选项 = 剩余线（此时 l_side 可加回）。
    const addSelect = container.querySelector('[data-action="add-line-tag"]') as HTMLSelectElement;
    fireEvent.change(addSelect, { target: { value: 'l_side' } });
    graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.find((n) => n.id === 's2')!.lineTags).toEqual(['l_main', 'l_side']);
  });

  it('enum select commits a vocab value; 自定义… free input commits a custom value', () => {
    const { container } = render(<SceneEditPopover />);
    // 词表值（OUTCOME_TYPE_VOCAB 先验 options）。
    fireEvent.change(container.querySelector('[data-field="outcomeType"]')!, {
      target: { value: '达成' },
    });
    let graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.find((n) => n.id === 's2')!.outcomeType).toBe('达成');
    // 「自定义…」→ 自由输入词表外的值（词表是先验非门禁）。
    fireEvent.change(container.querySelector('[data-field="pacingRole"]')!, {
      target: { value: '__custom__' },
    });
    const input = container.querySelector('[data-field="pacingRole-custom"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: '双线并进' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.find((n) => n.id === 's2')!.pacingRole).toBe('双线并进');
  });

  it('enum select (unset) clears the field back to undefined', () => {
    const { container } = render(<SceneEditPopover />);
    fireEvent.change(container.querySelector('[data-field="outcomeType"]')!, {
      target: { value: '受挫' },
    });
    fireEvent.change(container.querySelector('[data-field="outcomeType"]')!, {
      target: { value: '' },
    });
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.find((n) => n.id === 's2')!.outcomeType).toBeUndefined();
  });

  it('duplicate edge selection blocks the add button; a fresh reverse pair stays enabled', () => {
    const { container } = render(<SceneEditPopover />);
    const toSelect = container.querySelector('[data-field="edge-to"]') as HTMLSelectElement;
    // s2→s3 已存在（e2）→ 同向重复 → 按钮禁用、无写。
    fireEvent.change(toSelect, { target: { value: 's3' } });
    expect((container.querySelector('[data-action="add-edge"]') as HTMLButtonElement).disabled).toBe(true);
    expect((useAppStore.getState().creativeFields.scene_graph as SceneGraph).edges).toHaveLength(2);
    // s1→s2 存在但 s2→s1 是新对（反向不重复）→ 按钮可用。
    fireEvent.change(toSelect, { target: { value: 's1' } });
    expect((container.querySelector('[data-action="add-edge"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('add edge succeeds for a fresh pair when one exists edge is removed first', () => {
    const { container } = render(<SceneEditPopover />);
    // 先删 e2（s2→s3）→ s3 变为可连的新对。
    fireEvent.click(container.querySelector('[data-action="remove-edge"][data-edge-id="e2"]')!);
    let graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.edges.map((e) => e.id)).toEqual(['e1']);
    fireEvent.change(container.querySelector('[data-field="edge-to"]')!, {
      target: { value: 's3' },
    });
    fireEvent.change(container.querySelector('[data-field="edge-type"]')!, {
      target: { value: 'CAUSAL' },
    });
    fireEvent.click(container.querySelector('[data-action="add-edge"]')!);
    graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.find((e) => e.from === 's2' && e.to === 's3')!.type).toBe('CAUSAL');
  });

  it('title + summary direct writes flush after the 500ms debounce (OutlineEditor mirror)', () => {
    vi.useFakeTimers();
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<SceneEditPopover />);
    const title = container.querySelector('[data-field="title"]') as HTMLInputElement;
    const summary = container.querySelector('[data-field="summary"]') as HTMLTextAreaElement;

    fireEvent.change(title, { target: { value: '新标题' } });
    fireEvent.change(summary, { target: { value: '新摘要' } });
    expect(updateSpy).toHaveBeenCalledTimes(0); // debounce 窗口内不写

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(updateSpy).toHaveBeenCalledTimes(1); // 一次手势批 = 一次写（两字段并一笔）
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    expect(written.nodes.find((n) => n.id === 's2')!).toMatchObject({ title: '新标题', summary: '新摘要' });
    updateSpy.mockRestore();
  });

  it('clearing the title flushes title: undefined (falls back to id display)', () => {
    vi.useFakeTimers();
    const { container } = render(<SceneEditPopover />);
    const title = container.querySelector('[data-field="title"]') as HTMLInputElement;
    fireEvent.change(title, { target: { value: '' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const graph = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(graph.nodes.find((n) => n.id === 's2')!.title).toBeUndefined();
  });

  it('让 AI 补全摘要 sends the prefilled chat message (author-sovereign accelerator)', () => {
    const sendSpy = vi.fn();
    seedStore({ selectedNodeId: 's2', sendAgentMessage: sendSpy });
    const { container } = render(<SceneEditPopover />);
    const btn = container.querySelector('[data-action="ai-summary"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false); // 无运行中 run → 可点
    fireEvent.click(btn);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // CR-10：指令预填「title (id)」形（title 可编辑可重复——id 是唯一稳定寻址键）
    // + 落盘工具名。s2 有标题「学院祭」→「学院祭 (s2)」。
    expect(String(sendSpy.mock.calls[0][0])).toContain('学院祭 (s2)');
    expect(String(sendSpy.mock.calls[0][0])).toContain('scene_graph_update');
  });

  it('locate button scrolls the scene cell into view (D2 定位态)', () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const { container } = render(<StructurePage />);
    const locateBtn = container.querySelector(
      '[data-popover="scene-edit"] [data-action="locate"]'
    ) as HTMLElement;
    expect(locateBtn).not.toBeNull();
    fireEvent.click(locateBtn);
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    scrollSpy.mockRestore();
  });
});

describe('SP-3 workbench chips share the popover (onSceneClick wiring, 批 3→4 迁移)', () => {
  beforeEach(() => {
    seedStore({
      creativeFields: {
        scene_graph: baseGraph(),
        episode_outlines: episodeOutlinesSchema.parse([
          { id: 'e0', index: 0, title: 'Ch0' },
          { id: 'e1', index: 1, title: 'Ch1' },
        ]),
      },
    });
  });
  afterEach(() => cleanup());

  it('clicking a workbench chip selects the scene and opens the drawer', () => {
    const { container } = render(<StructurePage />);
    expect(container.querySelector('[data-popover="scene-edit"]')).toBeNull();
    const chip = container.querySelector('.workbench-chip[data-node-id="s2"]') as HTMLElement;
    expect(chip).not.toBeNull();
    fireEvent.click(chip);
    const popover = container.querySelector('[data-popover="scene-edit"]') as HTMLElement;
    expect(popover?.dataset.sceneId).toBe('s2');
    expect(useAppStore.getState().selectedNodeId).toBe('s2');
  });
});

describe('D2 focus scroll + agent-landing highlight (CR-4/CR-25 两段式)', () => {
  beforeEach(() => seedStore());
  afterEach(() => cleanup());

  it('focusIssueTargets node hit selects + scrollIntoView(nearest) the target cell', () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    seedStore({ focusIssueTargets: [{ kind: 'node', id: 's3' }] });
    render(<NarrativeTimelinePanel />);
    expect(useAppStore.getState().selectedNodeId).toBe('s3');
    expect(useAppStore.getState().focusIssueTargets).toBeNull(); // one-shot consumed
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    scrollSpy.mockRestore();
  });

  it('focusIssueTargets line hit focuses the lane + scrolls the label', () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    seedStore({ focusIssueTargets: [{ kind: 'line', id: 'l_side' }] });
    render(<NarrativeTimelinePanel />);
    expect(useAppStore.getState().focusedLineId).toBe('l_side');
    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  it('pendingStructureHighlight (stashed by applySelectedPatches) pulses on mount + clears stash (CR-25)', () => {
    vi.useFakeTimers();
    // 他页接受 patch 的落盘产物：图已含新节点 + stash 待消费集。结构页挂载时消费。
    const landed = {
      ...baseGraph(),
      nodes: [
        ...baseGraph().nodes,
        { id: 'S-9', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 3 } },
      ],
    };
    seedStore({ creativeFields: { scene_graph: landed }, pendingStructureHighlight: ['S-9'] });
    const { container } = render(<StructurePage />);
    expect(useAppStore.getState().highlightNodeIds).toEqual(['S-9']);
    expect(useAppStore.getState().pendingStructureHighlight).toEqual([]); // 消费即清
    expect(
      (container.querySelector('[data-node-id="S-9"]') as HTMLElement).classList.contains('scene-card--highlight')
    ).toBe(true);
    vi.useRealTimers();
  });

  it('late stash arrival while the page is mounted is consumed too (update path)', () => {
    const { container } = render(<StructurePage />);
    expect(useAppStore.getState().highlightNodeIds).toEqual([]);
    act(() => {
      useAppStore.setState({ pendingStructureHighlight: ['s3'] } as any);
    });
    expect(useAppStore.getState().highlightNodeIds).toEqual(['s3']);
    expect(useAppStore.getState().pendingStructureHighlight).toEqual([]);
    expect(
      (container.querySelector('[data-node-id="s3"]') as HTMLElement).classList.contains('scene-card--highlight')
    ).toBe(true);
  });

  it('highlight clears after the 3s TTL even when the user edits inside the window (CR-4)', () => {
    vi.useFakeTimers();
    seedStore({ pendingStructureHighlight: ['s3'] });
    render(<StructurePage />);
    expect(useAppStore.getState().highlightNodeIds).toEqual(['s3']);

    // 3s 窗口内用户编辑（updateField 手势语义：source='user' 的图替换）。
    act(() => {
      vi.advanceTimersByTime(1000);
      const before = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
      useAppStore.setState((s) => ({
        creativeFields: { ...s.creativeFields, scene_graph: { ...before, lines: [...before.lines] } },
        fieldMetadata: { scene_graph: { version: 2, source: 'user', locked: false, dependsOn: [], stale: false } },
      }) as any);
    });
    // 旧实现的 timer 挂在图监听 effect 的 cleanup 里——dep 变化清 timer 不重挂 → 绿框
    // 永久滞留。现在 TTL 只跟 highlightNodeIds 走：编辑不打断倒计时。
    expect(useAppStore.getState().highlightNodeIds).toEqual(['s3']);
    act(() => {
      vi.advanceTimersByTime(2000); // 距高亮置位共 3s
    });
    expect(useAppStore.getState().highlightNodeIds).toEqual([]);
    vi.useRealTimers();
  });

  it('user-sourced edits (updateField) never enter the highlight set', () => {
    const { container } = render(<StructurePage />);
    const before = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const after = {
      ...before,
      nodes: [
        ...before.nodes,
        { id: 'S-8', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 4 } },
      ],
    };
    act(() => {
      useAppStore.setState((s) => ({
        creativeFields: { ...s.creativeFields, scene_graph: after },
        // updateField 恒记 source='user'。
        fieldMetadata: { scene_graph: { version: 2, source: 'user', locked: false, dependsOn: [], stale: false } },
      }) as any);
    });
    expect(useAppStore.getState().highlightNodeIds).toEqual([]);
    expect(container.querySelector('[data-node-id="S-8"]')?.classList.contains('scene-card--highlight')).toBe(false);
  });
});
