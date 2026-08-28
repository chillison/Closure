/**
 * 08-26 结构页重构 批 4（implement 4.4 / design §6.4 / prd R1 线聚焦）：lineHover
 * ——悬停线元素 → 该线保持、其余降透明 25%（含因果边/关联线/两侧泳道标签），
 * 移开回落。
 *
 * 两层覆盖：
 *  1. 纯 DOM 函数（resolveHoverLine / applyLineHover）——手搭 fixture 树断言类切换
 *     （幂等 / 全清 / dim 只进非 hovered 线）。
 *  2. StructurePage 集成——页级 mouseover 委托真实挂载面：悬停 A 线卡 → B 线卡/
 *     chip 降透明、悬停场景的对照弧渲染（T17 per-NODE 渲染滤集，与 dim 通道并行
 *     互不干扰）；移到空白回落。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run structureLineHover`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { episodeOutlinesSchema, sceneGraphSchema, type SceneGraph } from '@orison/shared-contracts';
import { applyLineHover, resolveHoverLine } from '../src/features/structure/lineHover';
import { StructurePage } from '../src/features/structure/StructurePage';
import { useAppStore } from '../src/shared/store/appStore';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

/** 两线各一场景 + 一章（全部顺叙单章 → 关联线全 minor——揭示规则的可控样本）。 */
function twoLineGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_a', name: '甲线', topology_role: 'converging', is_main_thread: true },
      { id: 'l_b', name: '乙线', topology_role: 'side' },
    ],
    nodes: [
      { id: 's_a', lineTags: ['l_a'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 }, title: '甲场景' },
      { id: 's_b', lineTags: ['l_b'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 1 }, title: '乙场景' },
    ],
    edges: [{ id: 'e_ab', from: 's_a', to: 's_b', type: 'CAUSAL' }],
  });
}

// ── (1) 纯 DOM 函数 ──

/** 手搭线元素树：两线卡 + 两泳道标签 + 两关联线 path + 一条因果边 path。 */
function buildFixture(): { root: HTMLDivElement; byId: Record<string, Element> } {
  const root = document.createElement('div');
  const mk = (cls: string, attrs: Record<string, string>) => {
    const el = document.createElement(cls === 'assoc-link' ? 'path' : 'div');
    el.className = cls;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    root.appendChild(el);
    return el;
  };
  const byId = {
    cardA: mk('scene-card', { 'data-node-id': 's_a', 'data-line-id': 'l_a' }),
    cardB: mk('scene-card', { 'data-node-id': 's_b', 'data-line-id': 'l_b' }),
    laneA: mk('lane-label', { 'data-lane-id': 'l_a' }),
    laneB: mk('lane-label', { 'data-lane-id': 'l_b' }),
    assocA: mk('assoc-link assoc-link--minor', { 'data-node-id': 's_a', 'data-line-id': 'l_a' }),
    assocB: mk('assoc-link assoc-link--minor', { 'data-node-id': 's_b', 'data-line-id': 'l_b' }),
    edge: mk('narrative-edge', { 'data-edge-id': 'e_ab', 'data-line-id': 'l_a' }),
  };
  return { root, byId };
}

describe('resolveHoverLine (pure DOM read)', () => {
  afterEach(() => cleanup());

  it('resolves the line from a card (data-line-id)', () => {
    const { byId } = buildFixture();
    expect(resolveHoverLine(byId.cardA)).toBe('l_a');
  });

  it('resolves the line from a lane label (data-lane-id)', () => {
    const { byId } = buildFixture();
    expect(resolveHoverLine(byId.laneB)).toBe('l_b');
  });

  it('resolves through a nested child (closest)', () => {
    const { byId } = buildFixture();
    const child = document.createElement('span');
    byId.cardA.appendChild(child);
    expect(resolveHoverLine(child)).toBe('l_a');
  });

  it('non-line element / null target → null', () => {
    const root = document.createElement('div');
    expect(resolveHoverLine(root)).toBeNull();
    expect(resolveHoverLine(null)).toBeNull();
  });
});

describe('applyLineHover (class toggling)', () => {
  afterEach(() => cleanup());

  it('hovering line A: B-side elements dim, A-side stay; assoc members only get dim', () => {
    const { root, byId } = buildFixture();
    applyLineHover(root, 'l_a');
    expect(byId.cardA.classList.contains('structure-hover-dim')).toBe(false);
    expect(byId.laneA.classList.contains('structure-hover-dim')).toBe(false);
    expect(byId.edge.classList.contains('structure-hover-dim')).toBe(false); // e_ab 的 from 线 = l_a
    expect(byId.cardB.classList.contains('structure-hover-dim')).toBe(true);
    expect(byId.laneB.classList.contains('structure-hover-dim')).toBe(true);
    // T17：assoc `--show` 揭示类已随渲染门槛迁移退役——本函数对关联线只剩 dim。
    expect(byId.assocA.classList.contains('assoc-link--show')).toBe(false);
    expect(byId.assocA.classList.contains('structure-hover-dim')).toBe(false);
    // 非 hovered 线的关联线同时降透明。
    expect(byId.assocB.classList.contains('structure-hover-dim')).toBe(true);
    expect(byId.assocB.classList.contains('assoc-link--show')).toBe(false);
  });

  it('null line clears every dim class (回落)', () => {
    const { root, byId } = buildFixture();
    applyLineHover(root, 'l_a');
    applyLineHover(root, null);
    for (const el of Object.values(byId)) {
      expect(el.classList.contains('structure-hover-dim')).toBe(false);
    }
  });

  it('idempotent: re-applying the same line keeps classes stable', () => {
    const { root, byId } = buildFixture();
    applyLineHover(root, 'l_a');
    applyLineHover(root, 'l_a');
    expect(byId.cardB.classList.contains('structure-hover-dim')).toBe(true);
    expect(byId.assocB.classList.contains('structure-hover-dim')).toBe(true);
  });
});

// ── (2) StructurePage 集成（canvas mouseover 委托）──

describe('line hover via StructurePage (delegated mouseover)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: twoLineGraph(),
        episode_outlines: episodeOutlinesSchema.parse([{ id: 'e0', index: 0, title: '第一章' }]),
      },
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
    } as any);
  });
  afterEach(() => cleanup());

  it('hovering an A-line card dims B-line cards/chips; the hovered scene arc mounts alone (T17)', () => {
    const { container } = render(<StructurePage />);
    // T17：默认零弧（hover∨selected 是唯一显示门）。
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
    const cardA = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_a"]') as HTMLElement;
    const cardB = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_b"]') as HTMLElement;
    const chipA = container.querySelector('.workbench-chip[data-line-id="l_a"]') as HTMLElement;
    const chipB = container.querySelector('.workbench-chip[data-line-id="l_b"]') as HTMLElement;
    expect(cardA && cardB && chipA && chipB).toBeTruthy();

    fireEvent.mouseOver(cardA);

    expect(cardA.classList.contains('structure-hover-dim')).toBe(false);
    expect(chipA.classList.contains('structure-hover-dim')).toBe(false);
    expect(cardB.classList.contains('structure-hover-dim')).toBe(true);
    expect(chipB.classList.contains('structure-hover-dim')).toBe(true);
    // per-NODE 渲染滤集（与 dim 通道并行）：只有悬停场景 s_a 的弧渲染，s_b 无弧；
    // 揭示类退役（显示即渲染，无类开关）。
    const assocA = container.querySelector('.assoc-link[data-node-id="s_a"]') as SVGElement;
    expect(assocA).not.toBeNull();
    expect(assocA.classList.contains('assoc-link--show')).toBe(false);
    expect(assocA.classList.contains('structure-hover-dim')).toBe(false); // 同线不 dim
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
  });

  it('hovering a workbench chip (B side) keeps B and dims A (both skeletons)', () => {
    const { container } = render(<StructurePage />);
    const chipB = container.querySelector('.workbench-chip[data-line-id="l_b"]') as HTMLElement;
    fireEvent.mouseOver(chipB);
    const cardA = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_a"]') as HTMLElement;
    expect(cardA.classList.contains('structure-hover-dim')).toBe(true);
    // chip 侧悬停同 nodeId：该场景的弧渲染（任一端命中即可）。
    const assocB = container.querySelector('.assoc-link[data-node-id="s_b"]') as SVGElement;
    expect(assocB).not.toBeNull();
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
  });

  it('hovering a lane label participates (两侧泳道标签都是聚焦入口)', () => {
    const { container } = render(<StructurePage />);
    const laneA = container.querySelector('[data-skeleton="causal"] [data-lane-id="l_a"]') as HTMLElement;
    fireEvent.mouseOver(laneA);
    const cardB = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_b"]') as HTMLElement;
    expect(cardB.classList.contains('structure-hover-dim')).toBe(true);
  });

  it('moving to a non-line area falls back (dims cleared, arc unmounts)', () => {
    const { container } = render(<StructurePage />);
    const cardA = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_a"]') as HTMLElement;
    fireEvent.mouseOver(cardA);
    const cardB = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_b"]') as HTMLElement;
    expect(cardB.classList.contains('structure-hover-dim')).toBe(true);
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
    // 双通道回落（T25 起两通道异源）：弧通道 = 载体 leave（SceneCard/chip 的
    // onMouseLeave 发布清键——真实浏览器里移向空白必途经卡面 mouseout）；
    // dim 通道 = lineHover 页级 mouseover 委托（空白命中清 dim）。
    fireEvent.mouseOut(cardA);
    const blank = container.querySelector('[data-skeleton="causal"] .narrative-timeline-scroll') as HTMLElement;
    fireEvent.mouseOver(blank);
    expect(cardB.classList.contains('structure-hover-dim')).toBe(false);
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
  });

  // ── BMad CR 组2a/3a：委托根升 .structure-page + 逃逸出口 ──

  it('hovering PAGE-LEVEL chrome (zoombar) clears the focus (delegation root upgraded; no stale dim)', () => {
    const { container } = render(<StructurePage />);
    const cardA = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_a"]') as HTMLElement;
    const cardB = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_b"]') as HTMLElement;
    fireEvent.mouseOver(cardA);
    expect(cardB.classList.contains('structure-hover-dim')).toBe(true);
    // 指针移进页级 chrome（旧 canvas 根收不到 mouseover 的盲区——降透明曾滞留）。
    fireEvent.mouseOver(container.querySelector('.structure-zoombar')!);
    expect(cardB.classList.contains('structure-hover-dim')).toBe(false);
  });

  it('relatedTarget outside the page (crossing into an out-of-window surface) clears via the escape exit', () => {
    const { container } = render(<StructurePage />);
    const page = container.querySelector('.structure-page') as HTMLElement;
    const cardA = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_a"]') as HTMLElement;
    const cardB = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_b"]') as HTMLElement;
    fireEvent.mouseOver(cardA);
    expect(cardB.classList.contains('structure-hover-dim')).toBe(true);
    // relatedTarget = 根外的真实 Node（body——page 的祖先非后代 → contains false）。
    const crossing = new MouseEvent('mouseover', { bubbles: true });
    Object.defineProperty(crossing, 'relatedTarget', { value: document.body });
    fireEvent(cardA, crossing);
    expect(page.contains(document.body)).toBe(false); // 前置自检：确实判「根外」
    expect(cardB.classList.contains('structure-hover-dim')).toBe(false);
  });

  it('mouseleave of the whole page clears the focus', () => {
    const { container } = render(<StructurePage />);
    const page = container.querySelector('.structure-page') as HTMLElement;
    const cardA = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_a"]') as HTMLElement;
    const cardB = container.querySelector('[data-skeleton="causal"] .scene-card[data-line-id="l_b"]') as HTMLElement;
    fireEvent.mouseOver(cardA);
    expect(cardB.classList.contains('structure-hover-dim')).toBe(true);
    fireEvent.mouseLeave(page);
    expect(cardB.classList.contains('structure-hover-dim')).toBe(false);
  });
});
