/**
 * Story 1.5 Phase D-overlay (design §1.1 / §2.1 / D4-D5): ValidationOverlay
 * integration via NarrativeTimelinePanel. Covers the issue-target → badge
 * mapping + the `overlayToggles.validation` gate + the toolbar wiring.
 *
 * The pure helpers (indexIssuesByTarget / summarizeIssues) and validateSceneGraph
 * itself are covered by scene-graph-analytics unit tests — not duplicated here.
 * This file asserts the wiring: that issues land on the right DOM anchors
 * (cells / lane labels), with the right severity class, and disappear when the
 * validation overlay is toggled off.
 *
 * Store is driven via useAppStore.setState (same convention as
 * PatchReviewPanel.test.tsx / NarrativeTimelinePanel.test.tsx). Actions are
 * mocked (vi.fn) for the toolbar forwarding test.
 *
 * Run: `cd apps/desktop/client/ui && pnpm test ValidationOverlay`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sceneGraphSchema } from '@orison/shared-contracts';
import type { SceneGraph } from '@orison/shared-contracts';
import { NarrativeTimelinePanel } from '../src/features/structure/NarrativeTimelinePanel';
import { useAppStore } from '../src/shared/store/appStore';

// Schema-parse fills mechanical defaults; tests only spell load-bearing fields.
function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

/**
 * Fixture engineered to trigger one of each issue-target shape so the badge
 * mapping is audited end-to-end:
 *   - causal-cycle (error, node targets): s_a ↔ s_b CAUSAL back-edge.
 *   - unreachable-line (warning, node target): s_orphan sits on l_main but has
 *     no forward path to the convergence target s_anchor.
 *   - dangling-line-tag (warning, node target): s_typo tags a non-existent line.
 *   - missing-mesh-mapping (warning, line target): l_mesh is parallel-worldview
 *     without worldEventRef/themeRef.
 *
 * l_main has a valid convergence_target ('s_anchor') and every cycle node has a
 * forward path to it, so no line-level issue fires for l_main — its lane label
 * stays badge-free (negative case for the line-badge path).
 */
function graphWithIssues(): SceneGraph {
  return parseGraph({
    lines: [
      {
        id: 'l_main',
        name: '主线',
        topology_role: 'converging',
        is_main_thread: true,
        convergence_target: 's_anchor',
      },
      { id: 'l_mesh', name: '网状线', topology_role: 'parallel-worldview' },
    ],
    nodes: [
      { id: 's_a', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's_b', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 0 } },
      {
        id: 's_anchor',
        lineTags: ['l_main'],
        storyTime: 10,
        role: 'core-anchor',
        presentationOrder: { chapter: 0, pos: 0 },
      },
      { id: 's_orphan', lineTags: ['l_main'], storyTime: 5, presentationOrder: { chapter: 0, pos: 0 } },
      {
        id: 's_typo',
        lineTags: ['l_main', 'ghost_line'],
        storyTime: 3,
        presentationOrder: { chapter: 0, pos: 0 },
      },
    ],
    edges: [
      { id: 'e_ab', from: 's_a', to: 's_b', type: 'CAUSAL' },
      { id: 'e_ba', from: 's_b', to: 's_a', type: 'CAUSAL' }, // cycle!
      { id: 'e_a_anchor', from: 's_a', to: 's_anchor', type: 'CAUSAL' }, // s_a reaches anchor
      { id: 'e_typo_anchor', from: 's_typo', to: 's_anchor', type: 'CAUSAL' }, // s_typo reaches anchor
    ],
  });
}

// dogfood R2 批次 B：emotion/pacing 两键入态（默认关——曲线叠层不惊扰老视图）。
const ALL_OVERLAYS_ON = { validation: true, displacement: true, visibility: true, emotion: false, pacing: false };

describe('ValidationOverlay (NarrativeTimelinePanel integration)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: graphWithIssues() },
      overlayToggles: { ...ALL_OVERLAYS_ON },
      toggleOverlay: vi.fn(),
      resolvedLocale: 'en-US',
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('surfaces a causal-cycle error badge on each node in the cycle path', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // s_a and s_b are the two nodes on the cycle → each carries the error badge.
    const sA = container.querySelector('[data-node-id="s_a"]');
    const sB = container.querySelector('[data-node-id="s_b"]');
    expect(sA?.querySelector('.validation-badge--error')).not.toBeNull();
    expect(sB?.querySelector('.validation-badge--error')).not.toBeNull();
    // One cycle issue touches each → count is 1.
    expect(sA?.querySelector('.validation-badge--error')?.textContent).toBe('1');
    // severity data attr lets downstream tooling query badges without colour class.
    expect(sA?.querySelector('[data-validation-severity="error"]')).not.toBeNull();
  });

  it('surfaces a warning badge on an unreachable scene (unreachable-line)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // s_orphan has no forward path to s_anchor → unreachable-line warning.
    const orphan = container.querySelector('[data-node-id="s_orphan"]');
    expect(orphan?.querySelector('.validation-badge--warning')).not.toBeNull();
    expect(orphan?.querySelector('.validation-badge--error')).toBeNull();
  });

  it('surfaces a warning badge on a scene with a dangling lineTag', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // s_typo tags 'ghost_line' which matches no line → dangling-line-tag warning.
    const typo = container.querySelector('[data-node-id="s_typo"]');
    expect(typo?.querySelector('.validation-badge--warning')).not.toBeNull();
  });

  it('surfaces an info badge on an isolated node (no edges at all — #34, batch 5 R7)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // s_orphan has NO touching edges → isolated-node info（草稿合法非错误——灰 i 徽标
    // 走既有 ValidationBadges 通道零新 UI）。同图仍有其 unreachable warning（并存）。
    const orphan = container.querySelector('[data-node-id="s_orphan"]');
    expect(orphan?.querySelector('.validation-badge--info')).not.toBeNull();
    expect(orphan?.querySelector('.validation-badge--info')?.textContent).toBe('1');
  });

  it('leaves a clean scene badge-free', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // s_anchor is the convergence target; it reaches itself trivially and has no
    // dangling tags → no issue targets it.
    const anchor = container.querySelector('[data-node-id="s_anchor"]');
    expect(anchor?.querySelector('.validation-badge')).toBeNull();
  });

  it('surfaces a warning badge on a lane label for a missing-mesh-mapping line', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // l_mesh is parallel-worldview with no worldEventRef/themeRef → line-target
    // warning. Badge sits on the lane label (not on a cell).
    const meshLane = container.querySelector('[data-lane-id="l_mesh"]');
    expect(meshLane?.querySelector('.validation-badge--warning')).not.toBeNull();
    // l_main has a valid convergence_target + reachable scenes → no line badge.
    const mainLane = container.querySelector('[data-lane-id="l_main"]');
    expect(mainLane?.querySelector('.validation-badge')).toBeNull();
  });

  it('uses the verbatim issue message as the badge tooltip', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    // The Issue.message is 叙事语言 (non-graph-theory); surface it verbatim,
    // never rephrased. dangling-line-tag's message starts with the scene id.
    // The tooltip lives on the `.validation-badges` cluster (hovering anywhere
    // on the badges shows all messages for that target), not on each pill.
    const typoBadges = container.querySelector(
      '[data-node-id="s_typo"] .validation-badges'
    ) as HTMLElement;
    expect(typoBadges.title).toContain('s_typo');
    // tooltip composes message + suggestion (prefixed with →).
    expect(typoBadges.title).toContain('→');
  });

  it('renders no badges at all when overlayToggles.validation is off', () => {
    useAppStore.setState({
      overlayToggles: { validation: false, displacement: true, visibility: true },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    // The single gate: validation off → empty issue lookup → every anchor clean.
    expect(container.querySelectorAll('.validation-badge')).toHaveLength(0);
    expect(container.querySelectorAll('[data-validation-severity]')).toHaveLength(0);
    // cells + lanes still render (the grid itself is unaffected by the toggle).
    expect(container.querySelectorAll('.scene-card').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-lane-id]').length).toBeGreaterThan(0);
  });

  it('renders one checkbox per overlay in the toolbar, reflecting current state', () => {
    render(<NarrativeTimelinePanel />);
    // dogfood R2 批次 B 重组后：1.5 期三开关（全选）+ 情绪/节奏（默认关）+
    // 伏笔禁用占位 = 6 枚。data-overlay-key lets the wiring test target a toggle.
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes).toHaveLength(6);
    const keys = checkboxes.map((c) => c.dataset.overlayKey).sort();
    expect(keys).toEqual(['displacement', 'emotion', 'foreshadow', 'pacing', 'validation', 'visibility']);
    // legacy 三开关反映当前 state（on）；曲线组默认 off；伏笔占位 disabled + off。
    for (const key of ['validation', 'displacement', 'visibility'] as const) {
      const el = checkboxes.find((c) => c.dataset.overlayKey === key)!;
      expect(el.checked).toBe(true);
    }
    for (const key of ['emotion', 'pacing', 'foreshadow'] as const) {
      const el = checkboxes.find((c) => c.dataset.overlayKey === key)!;
      expect(el.checked).toBe(false);
    }
    expect(checkboxes.find((c) => c.dataset.overlayKey === 'foreshadow')!.disabled).toBe(true);
  });

  it('forwards a toolbar checkbox flip to toggleOverlay(key)', async () => {
    const toggleOverlay = vi.fn();
    useAppStore.setState({ toggleOverlay } as any);
    render(<NarrativeTimelinePanel />);

    const validationCheckbox = screen.getByRole('checkbox', {
      // label wraps input + span; getByLabelText matches the visible label text.
      name: 'Validation',
    }) as HTMLInputElement;

    await userEvent.click(validationCheckbox);
    expect(toggleOverlay).toHaveBeenCalledWith('validation');
  });
});
