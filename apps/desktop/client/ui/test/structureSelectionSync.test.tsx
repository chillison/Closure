/**
 * 08-26 结构页重构 批 4（implement 4.3 / design §5 / prd R2 选中态跨视图同步）：
 * selectedNodeId 单源 —— 因果骨架 SceneCard 与章节工作台 WorkbenchChip 同场景
 * **同显**选中（外环同款同公式，CSS 类两侧对称）；多线场景在所属各线的卡/chip
 * 上全部呈现；取消选中两侧同清。Popover 移位重载已由 SceneEditPopover.test 覆盖。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run structureSelectionSync`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { episodeOutlinesSchema, sceneGraphSchema, type SceneGraph } from '@orison/shared-contracts';
import { act } from 'react';
import { StructurePage } from '../src/features/structure/StructurePage';
import { useAppStore } from '../src/shared/store/appStore';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

/**
 * 两线 + 一个多线场景（s_multi 同属两线）：选中 s_multi 时因果侧应有 2 张选中卡
 * （每线一张）、工作台侧 2 枚选中 chip——跨视图同步 + 多线全显一次断言。
 */
function syncGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
      { id: 'l_side', name: '副线', topology_role: 'side' },
    ],
    nodes: [
      {
        id: 's_multi', lineTags: ['l_main', 'l_side'], storyTime: 2, role: 'core-anchor',
        presentationOrder: { chapter: 0, pos: 0 }, title: '双线场景',
      },
      {
        id: 's_plain', lineTags: ['l_main'], storyTime: 1, role: 'normal',
        presentationOrder: { chapter: 0, pos: 1 }, title: '单线场景',
      },
    ],
    edges: [],
  });
}

describe('selectedNodeId cross-view sync (SceneCard ↔ WorkbenchChip)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: syncGraph(),
        episode_outlines: episodeOutlinesSchema.parse([{ id: 'e0', index: 0, title: '第一章' }]),
      },
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
    } as any);
  });
  afterEach(() => cleanup());

  it('programmatic selection shows BOTH views selected for the same scene (multi-line: all cards/chips)', () => {
    const { container } = render(<StructurePage />);
    act(() => {
      useAppStore.setState({ selectedNodeId: 's_multi' } as any);
    });
    // 因果侧：s_multi 双线 → 2 张选中卡。
    const selectedCards = container.querySelectorAll('[data-skeleton="causal"] .scene-card--selected');
    expect(selectedCards).toHaveLength(2);
    for (const card of selectedCards) {
      expect((card as HTMLElement).dataset.nodeId).toBe('s_multi');
      expect((card as HTMLElement).dataset.selected).toBe('true');
    }
    // 工作台侧：同场景 2 枚选中 chip（同一外环公式——类对称，CSS 承担视觉）。
    const selectedChips = container.querySelectorAll('.workbench-chip--selected');
    expect(selectedChips).toHaveLength(2);
    for (const chip of selectedChips) {
      expect((chip as HTMLElement).dataset.nodeId).toBe('s_multi');
      expect((chip as HTMLElement).dataset.selected).toBe('true');
    }
    // 其他场景两侧都不带。
    const plainCard = container.querySelector('[data-skeleton="causal"] .scene-card[data-node-id="s_plain"]') as HTMLElement;
    const plainChip = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(plainCard.classList.contains('scene-card--selected')).toBe(false);
    expect(plainChip.classList.contains('workbench-chip--selected')).toBe(false);
  });

  it('clicking a causal card selects it in both views; clicking a workbench chip does too', () => {
    const { container } = render(<StructurePage />);
    // 因果卡点击。
    fireEvent.click(
      container.querySelector('[data-skeleton="causal"] .scene-card[data-node-id="s_plain"]')!,
      { clientX: 50, clientY: 50 }
    );
    expect(container.querySelectorAll('[data-skeleton="causal"] .scene-card--selected')).toHaveLength(1);
    expect(container.querySelectorAll('.workbench-chip--selected')).toHaveLength(1);
    expect(useAppStore.getState().selectedNodeId).toBe('s_plain');

    // 工作 chip 点击（换场景）。
    fireEvent.click(
      container.querySelector('.workbench-chip[data-node-id="s_multi"][data-line-id="l_side"]')!,
      { clientX: 80, clientY: 80 }
    );
    expect(useAppStore.getState().selectedNodeId).toBe('s_multi');
    expect(container.querySelectorAll('.workbench-chip--selected')).toHaveLength(2);
    expect(container.querySelectorAll('[data-skeleton="causal"] .scene-card--selected')).toHaveLength(2);
  });

  it('deselect clears both views (and closes the popover)', () => {
    const { container } = render(<StructurePage />);
    act(() => {
      useAppStore.setState({ selectedNodeId: 's_multi' } as any);
    });
    expect(container.querySelectorAll('.workbench-chip--selected').length).toBeGreaterThan(0);
    act(() => {
      useAppStore.setState({ selectedNodeId: null } as any);
    });
    expect(container.querySelectorAll('[data-skeleton="causal"] .scene-card--selected')).toHaveLength(0);
    expect(container.querySelectorAll('.workbench-chip--selected')).toHaveLength(0);
    expect(container.querySelector('[data-popover="scene-edit"]')).toBeNull();
  });
});
