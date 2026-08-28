import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/shared/store/appStore';
import { useConfirmStore } from '../src/shared/store/confirmStore';
import { OutlineEditor } from '../src/features/editor/OutlineEditor';
import {
  countPhaseScenes,
  episodesForPhase,
  projectEpisodeUpdate,
  projectEpisodeAdd,
  projectEpisodeRemove,
  anchorScenesForTurningPoints,
  latestChangedPhaseId,
  latestChangedEpisodePhase,
  recordActivePhase,
  getRecordedActivePhase,
  resetActivePhaseTracking,
} from '../src/features/editor/outlinePanelModel';

vi.mock('../src/features/editor/TiptapEditor', () => ({
  TiptapEditor: ({ content = '' }: { content?: string }) => (
    <textarea aria-label="Mock Tiptap" value={content} readOnly />
  ),
}));

declare global {
  interface Window {
    orisonDesktop: any;
  }
}

/**
 * dogfood R2 批次 C（大纲面板升级）：OE-1 状态条 / OE-2 卷内集纲 + 实际场数 + 语义建议入口 /
 * OE-3 卷锚点导航。纯函数（outlinePanelModel）与组件接线均在此覆盖；既有 outlineEditor.test.tsx
 * 的防回灌/防早写回归不重复。
 */

const makePhase = (id: string, title: string) => ({ id, title });

const makeEpisode = (id: string, index: number, title: string, phase_ref?: string) => ({
  id,
  index,
  title,
  purpose: `purpose-${id}`,
  character_progressions: [],
  emotional_beats: [],
  pacing_beats: [],
  foreshadowing: [],
  payoffs: [],
  dependsOn: [],
  status: 'planned',
  ...(phase_ref ? { phase_ref } : {}),
});

function setupStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    currentProject: { name: 'Demo', path: '/demo', type: 'novel' },
    projectDocumentHydrated: true,
    creativeFields: {},
    fieldMetadata: {},
    fieldUndoStack: [],
    fieldRedoStack: [],
    agentRunStates: {},
    resolvedLocale: 'en-US',
    sendAgentMessage: vi.fn(async () => undefined),
    updateField: vi.fn(),
    ...overrides,
  } as any);
  (globalThis.window as any) = globalThis.window ?? {};
  (window as any).orisonDesktop = {
    syncField: vi.fn(async () => undefined),
  };
}

describe('outlinePanelModel pure helpers', () => {
  it('countPhaseScenes：按 line.phase_ref 计数 + 多线场景去重 + 无命中 0', () => {
    const graph = {
      nodes: [
        { id: 'S-1', lineTags: ['L1'] },
        { id: 'S-2', lineTags: ['L1', 'L-other'] }, // 多线场景只数一次
        { id: 'S-3', lineTags: ['Lx'] },
      ],
      lines: [
        { id: 'L1', phase_ref: 'p1' },
        { id: 'L-other', phase_ref: 'p1' },
        { id: 'Lx', phase_ref: 'p2' },
      ],
    };
    expect(countPhaseScenes(graph, 'p1')).toBe(2);
    expect(countPhaseScenes(graph, 'p2')).toBe(1);
    expect(countPhaseScenes(graph, 'p9')).toBe(0);
    expect(countPhaseScenes(undefined, 'p1')).toBe(0);
    expect(countPhaseScenes({ nodes: [] }, 'p1')).toBe(0);
  });

  it('episodesForPhase：phase_ref 过滤 + 按 index 升序；非数组 → []', () => {
    const eps = [
      { id: 'b', index: 3, phase_ref: 'p1' },
      { id: 'a', index: 1, phase_ref: 'p1' },
      { id: 'c', index: 2, phase_ref: 'p2' },
    ];
    expect(episodesForPhase(eps, 'p1').map((e) => e.id)).toEqual(['a', 'b']);
    expect(episodesForPhase(null, 'p1')).toEqual([]);
    expect(episodesForPhase('nope', 'p1')).toEqual([]);
  });

  it('projectEpisodeUpdate：update_episode 浅合并投影 / 未知 id 幂等跳过', () => {
    const current = [
      { id: 'ep1', index: 0, title: 'T1', purpose: 'old' },
      { id: 'ep2', index: 1, title: 'T2', purpose: 'keep' },
    ];
    const next = projectEpisodeUpdate(current, 'ep1', { purpose: 'new', hook: 'h' });
    expect(next!.find((e) => e.id === 'ep1')).toMatchObject({ title: 'T1', purpose: 'new', hook: 'h' });
    expect(next!.find((e) => e.id === 'ep2')?.purpose).toBe('keep');
    expect(projectEpisodeUpdate(current, 'zz', { purpose: 'x' })).toHaveLength(2);
  });

  it('CR-15：null/undefined 容忍 coerce 成 []；真畸形非数组 → null（no-op 信号，不静默清空在库数据）', () => {
    // null/undefined = 字段尚未建 → coerce []：update 对未知 id 幂等跳过（不新增不覆写）
    const fromNull = projectEpisodeUpdate(null, 'epX', { purpose: 'first write' });
    expect(fromNull).toEqual([]);
    // add 是合法首写路径：coerce [] + add → 一集
    expect(projectEpisodeAdd(undefined, 'p1', 'New')).toHaveLength(1);
    // 真畸形：字符串 / 对象 / 数字——一律 null（调用方据此不 updateField）
    expect(projectEpisodeUpdate('garbage', 'epX', { purpose: 'x' })).toBeNull();
    expect(projectEpisodeUpdate({ not: 'an array' }, 'epX', { purpose: 'x' })).toBeNull();
    expect(projectEpisodeUpdate(42, 'epX', { purpose: 'x' })).toBeNull();
    expect(projectEpisodeAdd('garbage', 'p1', 'New')).toBeNull();
    expect(projectEpisodeRemove(null, 'epX')).toEqual([]);
    expect(projectEpisodeRemove({ bad: 1 }, 'epX')).toBeNull();
  });

  it('CR-27：projectEpisodeAdd 产 schema 形状的整集（phase_ref 挂卷 / index 全局 max+1 / status planned）；remove 删集', () => {
    const current = [
      makeEpisode('ep1', 0, 'T1', 'p1'),
      makeEpisode('ep5', 4, 'T5', 'p2'),
    ];
    const next = projectEpisodeAdd(current, 'p1', '新集')!;
    expect(next).toHaveLength(3);
    const added = next.find((e) => e.id !== 'ep1' && e.id !== 'ep5')!;
    expect(added).toMatchObject({ title: '新集', index: 5, phase_ref: 'p1', status: 'planned' });
    expect(added.character_progressions).toEqual([]);
    expect(added.dependsOn).toEqual([]);
    expect(projectEpisodeRemove(current, 'ep1')!.map((e) => e.id)).toEqual(['ep5']);
    expect(projectEpisodeRemove(current, 'zz')).toHaveLength(2); // 幂等
  });

  it('CR-26：anchorScenesForTurningPoints 确定性配对——同类第 n 个转折点配 storyTime 升序第 n 个同类场景；fork-point 不参与', () => {
    const graph = {
      nodes: [
        { id: 'S-10', role: 'core-anchor', storyTime: 3, lineTags: [] },
        { id: 'S-14', role: 'core-anchor', storyTime: 1, title: '决战', lineTags: [] },
        { id: 'S-2', role: 'secondary-anchor', storyTime: 0, lineTags: [] },
        { id: 'S-9', role: 'normal', storyTime: 2, lineTags: [] },
      ],
    };
    const anchors = anchorScenesForTurningPoints(
      ['core-anchor', 'core-anchor', 'secondary-anchor', 'secondary-anchor', 'fork-point'],
      graph,
    );
    expect(anchors[0]).toMatchObject({ id: 'S-14', title: '决战' }); // storyTime 1 在前
    expect(anchors[1]).toMatchObject({ id: 'S-10' }); // 无 title → 裸 id
    expect(anchors[2]).toMatchObject({ id: 'S-2' });
    expect(anchors[3]).toBeNull(); // 同类场景用尽 → ghost
    expect(anchors[4]).toBeNull(); // fork-point 不关联
    // 防御：scene_graph 畸形 → 全 null（不配对、不崩）
    expect(anchorScenesForTurningPoints(['core-anchor'], 'garbage')[0]).toBeNull();
    expect(anchorScenesForTurningPoints(['core-anchor'], { nodes: 'x' })[0]).toBeNull();
  });

  it('CR-29：latestChangedPhaseId / latestChangedEpisodePhase——变更/新增取末个、无差异 null、删除的集回溯 prev 卷', () => {
    const p1 = { id: 'p1', title: 'A' };
    const p2 = { id: 'p2', title: 'B' };
    expect(latestChangedPhaseId([p1, p2], [p1, p2])).toBeNull();
    expect(latestChangedPhaseId([p1, p2], [p1, { id: 'p2', title: 'B2' }])).toBe('p2');
    expect(latestChangedPhaseId([p1, p2], [p1, p2, { id: 'p3', title: 'C' }])).toBe('p3');
    expect(latestChangedPhaseId([p1], [p1, { id: 'p2', title: 'X' }, { id: 'p3', title: 'Y' }])).toBe('p3'); // 多卷同改取末个
    expect(latestChangedPhaseId('bad', [p1])).toBeNull();

    const e1 = makeEpisode('ep1', 0, 'T1', 'p1');
    const e2 = makeEpisode('ep2', 1, 'T2', 'p3');
    expect(latestChangedEpisodePhase([e1], [e1, e2])).toBe('p3'); // 新增集挂 p3
    expect(latestChangedEpisodePhase([e1], [{ ...e1, purpose: 'edited' }])).toBe('p1'); // 改集回声
    expect(latestChangedEpisodePhase([e1, e2], [e1])).toBe('p3'); // 删 e2 → prev 的 phase_ref
    expect(latestChangedEpisodePhase([e1], [{ ...e1, purpose: 'x', phase_ref: undefined }])).toBeNull(); // 无卷锚不追
    expect(latestChangedEpisodePhase(null, [e1])).toBeNull();

    // 记录器：模块级持久 + 复位（测试隔离用）
    recordActivePhase('p9');
    expect(getRecordedActivePhase()).toBe('p9');
    resetActivePhaseTracking();
    expect(getRecordedActivePhase()).toBeNull();
  });
});

describe('OutlineEditor batch C upgrade', () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    setupStore();
    resetActivePhaseTracking(); // CR-29 模块级记录跨测试隔离
  });

  afterEach(() => {
    cleanup(); // 卸载残留组件——其 store 订阅 effect 会写 CR-29 模块记录（无 auto-cleanup，见 timelineLifecycle 先例）
    scrollSpy.mockRestore();
    vi.useRealTimers();
  });

  it('OE-1 状态条：version / 上次修改来源 / stale 徽章 / undo-redo 禁用态', () => {
    setupStore({
      creativeFields: { outline: { phases: [] } },
      fieldMetadata: {
        outline: { version: 3, source: 'agent', locked: false, dependsOn: [], stale: true },
      },
      fieldUndoStack: [{ field: 'outline', data: { phases: [] } }],
      fieldRedoStack: [],
    });
    const { container } = render(<OutlineEditor />);
    const bar = container.querySelector('.outline-field-toolbar');
    expect(bar).toBeTruthy();
    expect(bar!.textContent).toContain('v3');
    expect(bar!.textContent).toContain('AI applied');
    expect(bar!.querySelector('.outline-stale-badge')).toBeTruthy();
    const [undoBtn, redoBtn] = container.querySelectorAll('.outline-status-btn');
    expect((undoBtn as HTMLButtonElement).disabled).toBe(false);
    expect((redoBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('OE-1：无 metadata 不显 v/来源，stale=false 无徽章；undo 点击接 undoField', () => {
    const undoField = vi.fn();
    setupStore({
      undoField,
      fieldUndoStack: [{ field: 'outline', data: {} }],
    });
    const { container } = render(<OutlineEditor />);
    expect(container.querySelector('.outline-stale-badge')).toBeNull();
    expect(container.querySelector('.outline-status-version')).toBeNull();
    expect(container.querySelector('.outline-status-source')).toBeNull();
    const [undoBtn] = container.querySelectorAll('.outline-status-btn');
    expect((undoBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(undoBtn);
    expect(undoField).toHaveBeenCalledTimes(1);
  });

  it('OE-2：头部「实际 N 场」徽章 + 卷内集纲（首卷默认展开、其余收起、E 号与过滤正确）', () => {
    setupStore({
      creativeFields: {
        outline: { phases: [makePhase('p1', 'Volume One'), makePhase('p2', 'Volume Two')] },
        scene_graph: {
          nodes: [
            { id: 'S-1', lineTags: ['L1'] },
            { id: 'S-2', lineTags: ['L1', 'L-other'] },
            { id: 'S-3', lineTags: ['L2'] },
          ],
          lines: [
            { id: 'L1', phase_ref: 'p1' },
            { id: 'L-other', phase_ref: 'p1' },
            { id: 'L2', phase_ref: 'p2' },
          ],
        },
        episode_outlines: [
          makeEpisode('ep2', 1, 'Second', 'p1'),
          makeEpisode('ep1', 0, 'First', 'p1'),
          makeEpisode('ep3', 2, 'Other volume', 'p2'),
        ],
      },
    });
    const { container } = render(<OutlineEditor />);
    const phases = container.querySelectorAll('.outline-phase');
    expect(phases.length).toBe(2);
    // OE-3 defaultOpen：首卷展开、次卷收起
    expect(phases[0].className).toContain('is-open');
    expect(phases[1].className).not.toContain('is-open');
    // 实际场数：p1 → S-1/S-2 去重 2；p2 → S-3 1
    expect(phases[0].querySelector('.outline-phase-scenes')?.textContent).toContain('2 scenes');
    expect(phases[1].querySelector('.outline-phase-scenes')?.textContent).toContain('1 scenes');
    // 集纲：phase_ref 过滤 + index 升序 + E{index+1}
    const items = phases[0].querySelectorAll('.outline-ep-item');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('E1');
    expect(items[0].textContent).toContain('First');
    expect(items[1].textContent).toContain('E2');
    expect(items[1].textContent).toContain('Second');
  });

  it('OE-2：集纲最小表单编辑经 applyEpisodeActions 投影 → updateField(episode_outlines)', async () => {
    const updateField = vi.fn();
    setupStore({
      updateField,
      creativeFields: {
        outline: { phases: [makePhase('p1', 'Volume One')] },
        episode_outlines: [
          makeEpisode('ep1', 0, 'First', 'p1'),
          makeEpisode('ep2', 1, 'Second', 'p2'),
        ],
      },
    });
    const { container } = render(<OutlineEditor />);
    fireEvent.click(container.querySelector('.outline-ep-edit')!);
    const form = container.querySelector('.outline-ep-form');
    expect(form).toBeTruthy();
    const purposeArea = form!.querySelector('textarea')!;
    fireEvent.change(purposeArea, { target: { value: 'polished purpose' } });
    // debounce 未到不写
    await vi.advanceTimersByTimeAsync(300);
    expect(updateField).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(updateField).toHaveBeenCalledTimes(1);
    const [field, next] = (updateField as any).mock.calls[0];
    expect(field).toBe('episode_outlines');
    const arr = next as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    // 浅合并：目标集更新 purpose，title 保留；他卷集不动
    expect(arr.find((e) => e.id === 'ep1')).toMatchObject({ title: 'First', purpose: 'polished purpose' });
    expect(arr.find((e) => e.id === 'ep2')?.purpose).toBe('purpose-ep2');
  });

  it('OE-2.3：语义字段「让 AI 打磨」点击 → sendAgentMessage 预填字段名与当前值', () => {
    const sendAgentMessage = vi.fn(async () => undefined);
    setupStore({
      sendAgentMessage,
      creativeFields: {
        outline: { phases: [], central_conflict: 'the conflict text' },
      },
    });
    const { container } = render(<OutlineEditor />);
    const polishButtons = container.querySelectorAll('.outline-core-field .outline-ai-polish');
    expect(polishButtons.length).toBe(3);
    fireEvent.click(polishButtons[0]);
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    const msg = (sendAgentMessage as any).mock.calls[0][0] as string;
    expect(msg).toContain('Central Conflict');
    expect(msg).toContain('the conflict text');
    expect(msg).toContain('outline_update');
  });

  it('OE-2：空卷集纲空态 CTA「让 AI 细化本卷集纲」→ sendAgentMessage 派发', () => {
    const sendAgentMessage = vi.fn(async () => undefined);
    setupStore({
      sendAgentMessage,
      creativeFields: { outline: { phases: [makePhase('p1', 'Volume One')] } },
    });
    const { container } = render(<OutlineEditor />);
    expect(container.querySelector('.outline-ep-empty')).toBeTruthy();
    const refine = container.querySelector('.outline-ep-refine') as HTMLButtonElement;
    expect(refine).toBeTruthy();
    fireEvent.click(refine);
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(((sendAgentMessage as any).mock.calls[0][0] as string)).toContain('Volume One');
  });

  it('OE-3：>3 卷出现左侧导航，点击 scrollIntoView + 2s 高亮；≤3 卷无导航', async () => {
    setupStore({
      creativeFields: {
        outline: {
          phases: [makePhase('p1', 'V1'), makePhase('p2', 'V2'), makePhase('p3', 'V3'), makePhase('p4', 'V4')],
        },
      },
    });
    const { container } = render(<OutlineEditor />);
    expect(container.querySelector('.outline-nav')).toBeTruthy();
    const links = container.querySelectorAll('.outline-nav-link');
    expect(links.length).toBe(6); // 4 卷 + 转折点 + 笔记
    fireEvent.click(links[1]); // p2
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    const target = container.querySelector('#outline-anchor-phase-p2')!;
    expect(target).toBeTruthy();
    expect(target.className).toContain('outline-pulse');
    // 高亮 2s 后消退
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(container.querySelector('#outline-anchor-phase-p2')!.className).not.toContain('outline-pulse');
  });

  it('OE-3：≤3 卷不出现导航', () => {
    setupStore({
      creativeFields: {
        outline: { phases: [makePhase('p1', 'V1'), makePhase('p2', 'V2'), makePhase('p3', 'V3')] },
      },
    });
    const { container } = render(<OutlineEditor />);
    expect(container.querySelector('.outline-nav')).toBeNull();
  });
});

describe('OutlineEditor dogfood R2 CR fixes (wave 1-B)', () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    setupStore();
    resetActivePhaseTracking();
  });

  afterEach(() => {
    cleanup();
    scrollSpy.mockRestore();
    vi.useRealTimers();
    // requestConfirm 残留 pending resolver 清理（confirmStore 无 reset 钩子）
    useConfirmStore.setState({ confirmOpen: false, confirmOptions: null, confirmResolve: null });
  });

  it('CR-9：outline 锁定 → 三处「让 AI 打磨」禁用 + is-locked 可见态；解锁 → 可用', () => {
    setupStore({
      creativeFields: { outline: { phases: [], central_conflict: 'c' } },
      fieldMetadata: { outline: { version: 1, source: 'user', locked: true, dependsOn: [], stale: false } },
    });
    const { container, unmount } = render(<OutlineEditor />);
    const polishButtons = container.querySelectorAll<HTMLButtonElement>('.outline-core-field .outline-ai-polish');
    expect(polishButtons.length).toBe(3);
    for (const btn of polishButtons) {
      expect(btn.disabled).toBe(true);
      expect(btn.className).toContain('is-locked');
      expect(btn.title).toContain('locked');
    }
    unmount();
    // 解锁回归：不锁定 → 可用、无 is-locked
    setupStore({
      creativeFields: { outline: { phases: [], central_conflict: 'c' } },
      fieldMetadata: { outline: { version: 1, source: 'user', locked: false, dependsOn: [], stale: false } },
    });
    const { container: c2 } = render(<OutlineEditor />);
    const unlocked = c2.querySelectorAll<HTMLButtonElement>('.outline-core-field .outline-ai-polish');
    expect(unlocked[0].disabled).toBe(false);
    expect(unlocked[0].className).not.toContain('is-locked');
  });

  it('CR-9：episode_outlines 锁定 → 编辑/添加/删除/AI 细化入口全禁用', () => {
    setupStore({
      creativeFields: {
        outline: { phases: [makePhase('p1', 'V1')] },
        episode_outlines: [makeEpisode('ep1', 0, 'First', 'p1')],
      },
      fieldMetadata: { episode_outlines: { version: 1, source: 'user', locked: true, dependsOn: [], stale: false } },
    });
    const { container } = render(<OutlineEditor />);
    const edit = container.querySelector<HTMLButtonElement>('.outline-ep-edit')!;
    const add = container.querySelector<HTMLButtonElement>('.outline-ep-add')!;
    const remove = container.querySelector<HTMLButtonElement>('.outline-ep-remove')!;
    const refine = container.querySelector<HTMLButtonElement>('.outline-ep-refine')!;
    expect(edit).toBeTruthy();
    expect(add).toBeTruthy();
    expect(remove).toBeTruthy();
    expect(refine).toBeTruthy();
    for (const btn of [edit, add, remove, refine]) {
      expect(btn.disabled).toBe(true);
      expect(btn.title).toContain('locked');
    }
  });

  it('CR-22：集 index 缺失 → E1 兜底而非 ENaN', () => {
    setupStore({
      creativeFields: {
        outline: { phases: [makePhase('p1', 'V1')] },
        episode_outlines: [{ ...makeEpisode('ep1', 0, 'NoIndex', 'p1'), index: undefined }],
      },
    });
    const { container } = render(<OutlineEditor />);
    const id = container.querySelector('.outline-ep-id')!;
    expect(id.textContent).toBe('E1');
    expect(id.textContent).not.toContain('NaN');
  });

  it('CR-26：转折点关联——已挂 chip / 未挂 ghost / fork 无 chip；chip 点击切 structure + one-shot 聚焦', () => {
    const setActivePage = vi.fn();
    const setFocusIssueTargets = vi.fn();
    setupStore({
      setActivePage,
      setFocusIssueTargets,
      creativeFields: {
        outline: {
          phases: [],
          major_turning_points: [
            { type: 'core-anchor', label: 'A' },
            { type: 'core-anchor', label: 'B' },
            { type: 'secondary-anchor', label: 'C' },
            { type: 'fork-point', label: 'D' },
          ],
        },
        scene_graph: {
          nodes: [
            { id: 'S-10', role: 'core-anchor', storyTime: 3, lineTags: [] },
            { id: 'S-14', role: 'core-anchor', storyTime: 1, lineTags: [] },
          ],
          lines: [],
        },
      },
    });
    const { container } = render(<OutlineEditor />);
    // 转折点折叠区先展开
    fireEvent.click(container.querySelector('#outline-anchor-turning-points .outline-toggle-header')!);
    const rows = container.querySelectorAll('.outline-turning-point');
    expect(rows.length).toBe(4);
    const chips = container.querySelectorAll<HTMLButtonElement>('.outline-tp-anchor-chip');
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toContain('S-14'); // storyTime 升序第 1 个配第 1 个 core-anchor
    expect(chips[1].textContent).toContain('S-10');
    // 未挂：ghost + 「到时间线挂」
    const ghost = container.querySelector('.outline-tp-anchor-ghost')!;
    expect(ghost).toBeTruthy();
    expect(ghost.textContent).toContain('No anchor scene');
    const goTimeline = ghost.querySelector<HTMLButtonElement>('.outline-tp-go-timeline')!;
    expect(goTimeline).toBeTruthy();
    // fork-point 行无任何关联 UI
    expect(rows[3].querySelector('.outline-tp-anchor-chip, .outline-tp-anchor-ghost')).toBeNull();
    // chip 点击 → 切页 + 聚焦（mirror「在时间线修复」双动作）
    fireEvent.click(chips[0]);
    expect(setActivePage).toHaveBeenCalledWith('structure');
    expect(setFocusIssueTargets).toHaveBeenCalledWith([{ kind: 'node', id: 'S-14' }]);
    // ghost「到时间线挂」→ 仅切页（不聚焦具体节点）
    setActivePage.mockClear();
    setFocusIssueTargets.mockClear();
    fireEvent.click(goTimeline);
    expect(setActivePage).toHaveBeenCalledWith('structure');
    expect(setFocusIssueTargets).not.toHaveBeenCalled();
  });

  it('CR-27：添加一集 → applyEpisodeActions 投影 add_episode（phase_ref 挂本卷 + 默认题 + planned）', () => {
    const updateField = vi.fn();
    setupStore({
      updateField,
      creativeFields: {
        outline: { phases: [makePhase('p1', 'V1')] },
        episode_outlines: [makeEpisode('ep1', 3, 'Existing', 'p2')],
      },
    });
    const { container } = render(<OutlineEditor />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.outline-ep-add')!);
    expect(updateField).toHaveBeenCalledTimes(1);
    const [field, next] = (updateField as any).mock.calls[0];
    expect(field).toBe('episode_outlines');
    const arr = next as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    const added = arr.find((e) => e.id !== 'ep1')!;
    expect(added).toMatchObject({ title: 'New episode', phase_ref: 'p1', index: 4, status: 'planned' });
  });

  it('CR-27：删除有确认——确认后删集 / 取消 no-op', async () => {
    const updateField = vi.fn();
    setupStore({
      updateField,
      creativeFields: {
        outline: { phases: [makePhase('p1', 'V1')] },
        episode_outlines: [makeEpisode('ep1', 0, 'First', 'p1'), makeEpisode('ep2', 1, 'Second', 'p1')],
      },
    });
    const { container } = render(<OutlineEditor />);
    fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.outline-ep-remove')[0]);
    // 确认弹层挂起中不写
    expect(updateField).not.toHaveBeenCalled();
    await act(async () => {
      useConfirmStore.getState().resolveConfirm(false);
    });
    expect(updateField).not.toHaveBeenCalled();
    fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.outline-ep-remove')[0]);
    await act(async () => {
      useConfirmStore.getState().resolveConfirm(true);
    });
    expect(updateField).toHaveBeenCalledTimes(1);
    const [field, next] = (updateField as any).mock.calls[0];
    expect(field).toBe('episode_outlines');
    expect((next as Array<Record<string, unknown>>).map((e) => e.id)).toEqual(['ep2']);
  });

  it('CR-29：活跃卷追踪——外部（agent/undo）改 p2 后重挂载 p2 默认展开；无记录回退首卷', () => {
    const base = { phases: [makePhase('p1', 'V1'), makePhase('p2', 'V2'), makePhase('p3', 'V3')] };
    setupStore({ creativeFields: { outline: base } });
    const first = render(<OutlineEditor />);
    // 无记录：首卷兜底（回归）
    const blocks1 = first.container.querySelectorAll('.outline-phase');
    expect(blocks1[0].className).toContain('is-open');
    expect(blocks1[1].className).not.toContain('is-open');
    // agent 落盘：p2 内容变更（外部 store 写入 = applySelectedPatches / undo 同路径）
    act(() => {
      useAppStore.setState({
        creativeFields: {
          outline: { phases: [makePhase('p1', 'V1'), makePhase('p2', 'V2 edited'), makePhase('p3', 'V3')] },
        },
      });
    });
    first.unmount();
    const second = render(<OutlineEditor />);
    const blocks2 = second.container.querySelectorAll('.outline-phase');
    expect(blocks2[1].className).toContain('is-open');
    expect(blocks2[0].className).not.toContain('is-open');
    expect(blocks2[2].className).not.toContain('is-open');
  });

  it('CR-29：episode_outlines 外部变更 → 被改集所在卷成活跃卷；用户编辑回声同机制', () => {
    setupStore({
      creativeFields: {
        outline: { phases: [makePhase('p1', 'V1'), makePhase('p3', 'V3')] },
        episode_outlines: [makeEpisode('ep1', 0, 'First', 'p1')],
      },
    });
    const first = render(<OutlineEditor />);
    expect(first.container.querySelectorAll('.outline-phase')[0].className).toContain('is-open');
    // agent 落盘：p3 新增一集（外部 store 写入）
    act(() => {
      useAppStore.setState({
        creativeFields: {
          outline: { phases: [makePhase('p1', 'V1'), makePhase('p3', 'V3')] },
          episode_outlines: [makeEpisode('ep1', 0, 'First', 'p1'), makeEpisode('ep9', 9, 'New', 'p3')],
        },
      });
    });
    first.unmount();
    const second = render(<OutlineEditor />);
    const blocks = second.container.querySelectorAll('.outline-phase');
    expect(blocks[1].className).toContain('is-open');
    expect(blocks[0].className).not.toContain('is-open');
  });
});
