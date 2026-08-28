/**
 * dogfood R2 批次 D1（详设第三节 · 断层①闭环）接线测试：
 * - PatchReviewPanel：outline/episode_outlines 命中 → OutlinePatchDiff 拦截展开区；
 *   delete action / 形态不完整 / 其他字段 → 裸 JSON 回退（零回归）。
 *   CR-6：merge action 同样回退（部分载荷不进结构化 diff——整片红删破除）。
 * - 接受落盘：toast（useToastStore，T1 Stage 3 行内 action 先例）+「到大纲面板查看 →」
 *   动作 = setOutlineFocusTarget（首个新增卷 id，无则 core）+ setActivePage('outline')。
 *   CR-5：locked outline 落盘不成立 → 无成功 toast；版本号从应用后 store 读。
 *   CR-16：多 outline entry 取最后一个（后 entry supersede 前）。
 *   CR-24：scene_graph 接受 → toast +「到时间线查看 →」= setActivePage('structure')。
 *   CR-31：toast 摘要计数（+N 卷 · +N 转折点）进文案。
 * - OutlineEditor：one-shot outlineFocusTarget 消费（scrollIntoView + pulse）→ clear；
 *   目标 id 数据中不存在 → 丢弃清空（防死等）。
 * slice 自身语义（apply/undo/art-override）不在此重复（creativeFieldsSceneGraph.test.ts）。
 */
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchReviewPanel } from '../src/features/agent-panel/PatchReviewPanel';
import { OutlineEditor } from '../src/features/editor/OutlineEditor';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';
import type { ProjectFieldPatch } from '@orison/shared-contracts';

vi.mock('../src/features/editor/TiptapEditor', () => ({
  TiptapEditor: ({ content = '' }: { content?: string }) => (
    <textarea aria-label="Mock Tiptap" value={content} readOnly />
  ),
}));

const outlinePatch: ProjectFieldPatch = {
  runId: 'run-d1',
  createdAt: '2026-08-26T00:00:00Z',
  patches: [
    {
      field: 'outline',
      action: 'set',
      data: {
        phases: [
          { id: 'p1', title: 'Volume One' },
          { id: 'p2', title: 'Volume Two', hook: 'the hook' },
        ],
      },
      fieldVersion: 3,
      generatedBy: 'story-planner-agent',
    },
  ],
};

function setupPanel(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    resolvedLocale: 'en-US',
    agentSessionId: 'sess-d1',
    pendingPatchBySession: {
      'sess-d1': { patch: outlinePatch, selections: { outline: true }, issues: [] },
    },
    fieldMetadata: {},
    creativeFields: {},
    ...overrides,
  } as any);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  useAppStore.setState({
    pendingPatchBySession: {},
    outlineFocusTarget: null,
    activePage: 'overview',
  } as any);
  useToastStore.setState({ toasts: [] });
});

describe('PatchReviewPanel：outline 结构化 diff 拦截 / 回退（D1）', () => {
  it('outline 行展开 → OutlinePatchDiff 拦截（无裸 pre）', () => {
    setupPanel();
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    const detail = document.querySelector('.patch-review-detail') as HTMLElement;
    expect(detail.querySelector('.outline-diff')).not.toBeNull();
    expect(detail.querySelector('pre')).toBeNull();
    // 内容来自结构化 diff：新增卷卡 + 新值徽章（en-US：New）。
    expect(detail.querySelectorAll('.outline-diff-phase--new')).toHaveLength(2);
    expect(detail.textContent).toContain('Volume Two');
  });

  it('episode_outlines 行展开 → 一行式简版拦截', () => {
    const episodePatch: ProjectFieldPatch = {
      runId: 'run-d1-ep',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [
        {
          field: 'episode_outlines',
          action: 'set',
          data: [{ id: 'ep1', index: 0, title: 'T1', purpose: 'p' }],
          fieldVersion: 2,
          generatedBy: 'episode-planner-agent',
        },
      ],
    };
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: episodePatch, selections: { episode_outlines: true }, issues: [] } },
    });
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    const detail = document.querySelector('.patch-review-detail') as HTMLElement;
    expect(detail.querySelector('.outline-diff-ep')).not.toBeNull();
    expect(detail.querySelector('pre')).toBeNull();
  });

  it('其他字段（scene_graph）照旧裸 JSON；outline delete action 回退；形态不完整回退', () => {
    const sceneGraphPatch: ProjectFieldPatch = {
      runId: 'run-sg',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [
        { field: 'scene_graph', action: 'set', data: { nodes: [], edges: [], lines: [] }, fieldVersion: 1, generatedBy: 'story-planner-agent' },
      ],
    };
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: sceneGraphPatch, selections: { scene_graph: true }, issues: [] } },
    });
    const { container: sgContainer } = render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    expect(sgContainer.querySelector('.patch-review-detail pre')).not.toBeNull();
    expect(sgContainer.querySelector('.outline-diff')).toBeNull();
    cleanup();

    // delete action：无新值可 diff → 回退（deleteValue 标签 + —）。
    const deletePatch: ProjectFieldPatch = {
      runId: 'run-del',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [{ field: 'outline', action: 'delete', data: { phases: [] }, fieldVersion: 4, generatedBy: 'story-planner-agent' }],
    };
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: deletePatch, selections: { outline: true }, issues: [] } },
    });
    const { container: delContainer } = render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    expect(delContainer.querySelector('.outline-diff')).toBeNull();
    expect(delContainer.querySelector('.patch-review-detail pre')?.textContent).toBe('—');
    cleanup();

    // envelope 形态不完整（data 非对象）：防御回退。
    const malformedPatch: ProjectFieldPatch = {
      runId: 'run-bad',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [{ field: 'outline', action: 'set', data: 'plain string', fieldVersion: 5, generatedBy: 'story-planner-agent' }],
    };
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: malformedPatch, selections: { outline: true }, issues: [] } },
    });
    const { container: badContainer } = render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    expect(badContainer.querySelector('.outline-diff')).toBeNull();
    expect(badContainer.querySelector('.patch-review-detail pre')).not.toBeNull();
    cleanup();

    // CR-6：merge action 是部分载荷（未提及字段非全量）——不进结构化 diff（旧 `!== 'delete'`
    // 门会把未提及 phase/episode 渲染成整片红删），照旧裸 JSON 回退。
    const mergePatch: ProjectFieldPatch = {
      runId: 'run-merge',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [{ field: 'outline', action: 'merge', data: { central_conflict: 'new conflict' }, fieldVersion: 7, generatedBy: 'story-planner-agent' }],
    };
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: mergePatch, selections: { outline: true }, issues: [] } },
    });
    const { container: mergeContainer } = render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    expect(mergeContainer.querySelector('.outline-diff')).toBeNull();
    expect(mergeContainer.querySelector('.patch-review-detail pre')).not.toBeNull();
    expect(mergeContainer.querySelector('.patch-review-detail pre')?.textContent).toContain('new conflict');
  });
});

describe('PatchReviewPanel：接受落盘 → toast + 跳转闭环（D1）', () => {
  it('选中 outline patch 接受：toast 带版本与行内动作；动作 = 焦点(首个新增卷) + 切大纲页', () => {
    const applySelectedPatches = vi.fn(() => {
      // CR-5：mirror 真实 slice 语义——落盘把 fieldMetadata.outline.version 写为应用后
      // 的真值（toast 版本从应用后 store 读，非 patch envelope）。
      useAppStore.setState({
        fieldMetadata: { outline: { version: 3, source: 'agent', locked: false, dependsOn: [], stale: false } },
      } as any);
      return outlinePatch;
    });
    const setOutlineFocusTarget = vi.fn();
    const setActivePage = vi.fn();
    // 现值已有一卷 p1 → patch 新增 p2（首个新增卷）。
    setupPanel({
      creativeFields: { outline: { phases: [{ id: 'p1', title: 'Volume One' }] } },
      applySelectedPatches,
      setOutlineFocusTarget,
      setActivePage,
    });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    expect(applySelectedPatches).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, level, duration, action] = showToast.mock.calls[0] as unknown as [
      string, string, number, { label: string; onClick: () => void },
    ];
    // toast 基建 = useToastStore（复用既有 Toast.tsx 行内动作钮渲染，非新提示组件）。
    // CR-31：摘要计数进文案（p2 新增 → +1 volumes；版本 v3 来自应用后 store）。
    expect(message).toBe('Applied: Outline v3 · +1 volumes');
    expect(level).toBe('success');
    expect(duration).toBeGreaterThan(2000); // 行内动作给的阅读窗 > 默认 success 2s
    expect(action.label).toBe('View in outline panel →');
    action.onClick();
    expect(setOutlineFocusTarget).toHaveBeenCalledWith({ section: 'phase', id: 'p2' });
    expect(setActivePage).toHaveBeenCalledWith('outline');
  });

  it('无新增卷时动作回退 core 区；未选中 outline / apply 空手 → 不 toast', () => {
    // patch 与现值同卷集（p1 已存在，无新增）→ 焦点回退 {section:'core'}。
    const samePhasesPatch: ProjectFieldPatch = {
      runId: 'run-same',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [{
        field: 'outline',
        action: 'set',
        data: { phases: [{ id: 'p1', title: 'Volume One renamed' }] },
        fieldVersion: 6,
        generatedBy: 'story-planner-agent',
      }],
    };
    const setOutlineFocusTarget = vi.fn();
    const setActivePage = vi.fn();
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: samePhasesPatch, selections: { outline: true }, issues: [] } },
      creativeFields: { outline: { phases: [{ id: 'p1', title: 'Volume One' }] } },
      applySelectedPatches: vi.fn(() => {
        useAppStore.setState({
          fieldMetadata: { outline: { version: 6, source: 'agent', locked: false, dependsOn: [], stale: false } },
        } as any);
        return samePhasesPatch;
      }),
      setOutlineFocusTarget,
      setActivePage,
    });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));
    expect(showToast).toHaveBeenCalledTimes(1);
    (showToast.mock.calls[0][3] as { onClick: () => void }).onClick();
    expect(setOutlineFocusTarget).toHaveBeenCalledWith({ section: 'core' });
    cleanup();

    // outline 未勾选 → 无 outlineEntry → 不 toast。
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: outlinePatch, selections: { outline: false }, issues: [] } },
      applySelectedPatches: vi.fn(() => outlinePatch),
      setOutlineFocusTarget,
      setActivePage,
    });
    const showToast2 = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));
    expect(showToast2).not.toHaveBeenCalled();
    cleanup();

    // apply 返回 null（空手）→ 不 toast。
    setupPanel({ applySelectedPatches: vi.fn(() => null) });
    const showToast3 = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));
    expect(showToast3).not.toHaveBeenCalled();
  });

  // ── CR-5（dogfood R2 BMad CR）：locked outline 的「已落盘」toast 假阳性破除 ──

  it('CR-5：locked outline → 落盘不成立，无成功 toast 无跳转（失败信号由 slice syncFailed toast 承担）', () => {
    const applySelectedPatches = vi.fn(() => outlinePatch);
    const setOutlineFocusTarget = vi.fn();
    const setActivePage = vi.fn();
    setupPanel({
      fieldMetadata: { outline: { version: 2, source: 'user', locked: true, dependsOn: [], stale: false } },
      applySelectedPatches,
      setOutlineFocusTarget,
      setActivePage,
    });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    // apply 照发（locked 拒绝在 shell 持久化层），但「已落盘」成功 toast + 跳转不出。
    expect(applySelectedPatches).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
    expect(setOutlineFocusTarget).not.toHaveBeenCalled();
    expect(setActivePage).not.toHaveBeenCalled();
  });

  // ── CR-16：多 outline entry 时后 entry supersede 前（跳转目标/版本与实际落盘一致）──

  it('CR-16：双 outline entry → 焦点/计数/版本取最后一个 entry（slice apply 循环末个生效）', () => {
    const twoEntryPatch: ProjectFieldPatch = {
      runId: 'run-dup',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [
        {
          field: 'outline',
          action: 'set',
          data: { phases: [{ id: 'p1', title: 'Volume One' }, { id: 'p2', title: 'Volume Two' }] },
          fieldVersion: 5,
          generatedBy: 'story-planner-agent',
        },
        {
          field: 'outline',
          action: 'set',
          data: { phases: [{ id: 'p1', title: 'Volume One' }, { id: 'p3', title: 'Volume Three' }] },
          fieldVersion: 7,
          generatedBy: 'story-planner-agent',
        },
      ],
    };
    const setOutlineFocusTarget = vi.fn();
    const setActivePage = vi.fn();
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: twoEntryPatch, selections: { outline: true }, issues: [] } },
      creativeFields: { outline: { phases: [{ id: 'p1', title: 'Volume One' }] } },
      applySelectedPatches: vi.fn(() => {
        useAppStore.setState({
          fieldMetadata: { outline: { version: 7, source: 'agent', locked: false, dependsOn: [], stale: false } },
        } as any);
        return twoEntryPatch;
      }),
      setOutlineFocusTarget,
      setActivePage,
    });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    // 版本 = 应用后 store 值（7）；首个新增卷 p3 来自末 entry（旧实现取首 entry 会错跳 p2）。
    const [message, , , action] = showToast.mock.calls[0] as unknown as [
      string, string, number, { label: string; onClick: () => void },
    ];
    expect(message).toBe('Applied: Outline v7 · +1 volumes');
    action.onClick();
    expect(setOutlineFocusTarget).toHaveBeenCalledWith({ section: 'phase', id: 'p3' });
  });

  // ── CR-31：落盘 toast 摘要计数（diffOutline().stats → 「v3 · +N 卷 · +N 转折点」）──

  it('CR-31：toast 摘要带 +N 卷 / +N 转折点计数（stats 接进文案）', () => {
    const statsPatch: ProjectFieldPatch = {
      runId: 'run-stats',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [{
        field: 'outline',
        action: 'set',
        data: {
          phases: [
            { id: 'pA', title: 'Volume A' },
            { id: 'pB', title: 'Volume B' },
          ],
          major_turning_points: [
            { type: 'core-anchor', label: 'First light' },
            { type: 'secondary-anchor', label: 'Steady' },
            { type: 'fork-point', label: 'The fork' },
          ],
        },
        fieldVersion: 4,
        generatedBy: 'story-planner-agent',
      }],
    };
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: statsPatch, selections: { outline: true }, issues: [] } },
      creativeFields: {},
      applySelectedPatches: vi.fn(() => {
        useAppStore.setState({
          fieldMetadata: { outline: { version: 4, source: 'agent', locked: false, dependsOn: [], stale: false } },
        } as any);
        return statsPatch;
      }),
      setOutlineFocusTarget: vi.fn(),
      setActivePage: vi.fn(),
    });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    const [message] = showToast.mock.calls[0] as unknown as [string];
    expect(message).toBe('Applied: Outline v4 · +2 volumes · +3 turning points');
  });

  // ── CR-24（dogfood R2 BMad CR）：scene_graph 接受落盘 → 「到时间线查看」跳转分支 ──
  // 绿脉冲经 W1-A 的 pendingStructureHighlight stash 由 StructurePage 挂载时消费（彼处测），
  // 本处断言 toast + 行内动作 = setActivePage('structure')。

  it('CR-24：scene_graph patch 接受 → toast + 行内「到时间线查看 →」= setActivePage("structure")', () => {
    const sceneGraphPatch: ProjectFieldPatch = {
      runId: 'run-sg-jump',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [{
        field: 'scene_graph',
        action: 'set',
        data: { nodes: [], edges: [], lines: [] },
        fieldVersion: 2,
        generatedBy: 'story-planner-agent',
      }],
    };
    const setActivePage = vi.fn();
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: sceneGraphPatch, selections: { scene_graph: true }, issues: [] } },
      applySelectedPatches: vi.fn(() => sceneGraphPatch),
      setActivePage,
    });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, level, , action] = showToast.mock.calls[0] as unknown as [
      string, string, number, { label: string; onClick: () => void },
    ];
    expect(message).toBe('Applied: Scene graph');
    expect(level).toBe('success');
    expect(action.label).toBe('View in timeline →');
    action.onClick();
    expect(setActivePage).toHaveBeenCalledWith('structure');
  });

  it('CR-24：locked scene_graph → 不 toast；outline + scene_graph 混合批 → 两条 toast 各自触发', () => {
    const mixedPatch: ProjectFieldPatch = {
      runId: 'run-mixed',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [
        outlinePatch.patches[0],
        { field: 'scene_graph', action: 'set', data: { nodes: [], edges: [], lines: [] }, fieldVersion: 2, generatedBy: 'story-planner-agent' },
      ],
    };
    const setOutlineFocusTarget = vi.fn();
    const setActivePage = vi.fn();
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: mixedPatch, selections: { outline: true, scene_graph: true }, issues: [] } },
      creativeFields: { outline: { phases: [{ id: 'p1', title: 'Volume One' }] } },
      applySelectedPatches: vi.fn(() => {
        useAppStore.setState({
          fieldMetadata: { outline: { version: 3, source: 'agent', locked: false, dependsOn: [], stale: false } },
        } as any);
        return mixedPatch;
      }),
      setOutlineFocusTarget,
      setActivePage,
    });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    // 混合批：outline toast（带计数）+ scene_graph toast（带时间线跳转）各一条。
    expect(showToast).toHaveBeenCalledTimes(2);
    const messages = showToast.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.startsWith('Applied: Outline v3'))).toBe(true);
    expect(messages).toContain('Applied: Scene graph');
    const sgAction = showToast.mock.calls
      .map((c) => c[3] as { label: string; onClick: () => void } | undefined)
      .find((a) => a?.label === 'View in timeline →');
    sgAction!.onClick();
    expect(setActivePage).toHaveBeenCalledWith('structure');
    cleanup();

    // locked scene_graph：落盘不成立 → 无 toast（CR-5 同型守卫）。
    const sgOnlyPatch: ProjectFieldPatch = {
      runId: 'run-sg-locked',
      createdAt: '2026-08-26T00:00:00Z',
      patches: [{ field: 'scene_graph', action: 'set', data: { nodes: [], edges: [], lines: [] }, fieldVersion: 3, generatedBy: 'story-planner-agent' }],
    };
    setupPanel({
      pendingPatchBySession: { 'sess-d1': { patch: sgOnlyPatch, selections: { scene_graph: true }, issues: [] } },
      fieldMetadata: { scene_graph: { version: 1, source: 'user', locked: true, dependsOn: [], stale: false } },
      applySelectedPatches: vi.fn(() => sgOnlyPatch),
      setActivePage,
    });
    const showToast2 = vi.spyOn(useToastStore.getState(), 'showToast');
    render(<PatchReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));
    expect(showToast2).not.toHaveBeenCalled();
  });
});

describe('OutlineEditor：outlineFocusTarget one-shot 消费（OE-5 / D1）', () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    // 首次给 currentProject 赋值会触发 projectSubscription 的项目切换复位（清
    // projectDocumentHydrated/creativeFields）——先空手打底吸收这次复位，再设真实态
    // （同 path 二次 set 不再触发复位；既有 outline* 测试文件同模式，首个 beforeEach
    // 吸收）。clearOutlineFocusTarget 用真实实现（断言 store 清空 = 真 one-shot 语义）。
    useAppStore.setState({
      currentProject: { name: 'Demo', path: '/demo', type: 'novel' },
    } as any);
    useAppStore.setState({
      resolvedLocale: 'en-US',
      projectDocumentHydrated: true,
      creativeFields: {
        outline: {
          phases: [
            { id: 'p1', title: 'Volume One' },
            { id: 'p2', title: 'Volume Two' },
          ],
        },
      },
      fieldMetadata: {},
      fieldUndoStack: [],
      fieldRedoStack: [],
      agentRunStates: {},
      sendAgentMessage: vi.fn(async () => undefined),
      updateField: vi.fn(),
    } as any);
    (globalThis.window as any) = globalThis.window ?? {};
    (window as any).orisonDesktop = { syncField: vi.fn(async () => undefined) };
  });

  afterEach(() => {
    scrollSpy.mockRestore();
  });

  it('phase 目标：滚到目标卷卡 + 2s pulse + store 清空（等待本地态同步后消费，clear-on-success）', () => {
    useAppStore.setState({ outlineFocusTarget: { section: 'phase', id: 'p2' } } as any);
    const { container } = render(<OutlineEditor />);
    const anchor = container.querySelector('#outline-anchor-phase-p2') as HTMLElement;
    expect(anchor).toBeTruthy();
    // 初挂载本地 phases 尚空 → effect 依赖 phases 重试，storeOutline 同步落地后这一轮消费。
    expect(anchor.className).toContain('outline-pulse');
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().outlineFocusTarget).toBeNull();
  });

  it('turningPoints 目标：滚到转折点区并清空', () => {
    useAppStore.setState({ outlineFocusTarget: { section: 'turningPoints' } } as any);
    const { container } = render(<OutlineEditor />);
    expect(container.querySelector('#outline-anchor-turning-points')).toBeTruthy();
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().outlineFocusTarget).toBeNull();
  });

  it('目标卷 id 不在数据中（被并发编辑删掉）→ 丢弃清空，不滚动', () => {
    useAppStore.setState({ outlineFocusTarget: { section: 'phase', id: 'p-gone' } } as any);
    render(<OutlineEditor />);
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().outlineFocusTarget).toBeNull();
  });
});
