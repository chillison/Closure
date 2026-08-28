/**
 * Story 1.5 Phase A (design §4 / §1.2): PatchReviewPanel UI behaviour.
 *
 * The panel is the resurrected UI consumer for the creativeFieldsSlice patch
 * channel (store API stayed intact in 1.3; only the UI was deleted in 94b40d7).
 * These tests cover the wiring: null guard, patch listing, action forwarding.
 * The slice's own behaviour (validate, art_overrides, CR-013 merge) is covered
 * by creativeFieldsSceneGraph.test.ts — not duplicated here. Actions are mocked
 * (vi.fn) so these tests assert forwarding, not slice semantics.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchReviewPanel } from '../src/features/agent-panel/PatchReviewPanel';
import { useAppStore } from '../src/shared/store/appStore';
import type { ProjectFieldPatch } from '@orison/shared-contracts';

const sceneGraphPatch: ProjectFieldPatch = {
  runId: 'run-1',
  createdAt: '2026-07-27T00:00:00Z',
  patches: [
    {
      field: 'scene_graph',
      action: 'set',
      data: { nodes: [], edges: [], lines: [] },
      fieldVersion: 1,
      generatedBy: 'story-planner-agent',
    },
  ],
};

const multiFieldPatch: ProjectFieldPatch = {
  runId: 'run-2',
  createdAt: '2026-07-27T00:00:00Z',
  patches: [
    {
      field: 'outline',
      action: 'merge',
      data: { central_conflict: '新冲突' },
      fieldVersion: 2,
      generatedBy: 'story-planner-agent',
    },
    {
      field: 'scene_graph',
      action: 'set',
      data: { nodes: [], edges: [], lines: [] },
      fieldVersion: 1,
      generatedBy: 'story-planner-agent',
    },
  ],
};

describe('PatchReviewPanel', () => {
  let togglePatchSelection: ReturnType<typeof vi.fn>;
  let applySelectedPatches: ReturnType<typeof vi.fn>;
  let setPendingPatch: ReturnType<typeof vi.fn>;
  let toggleFieldLock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    togglePatchSelection = vi.fn();
    applySelectedPatches = vi.fn();
    setPendingPatch = vi.fn();
    toggleFieldLock = vi.fn();

    useAppStore.setState({
      resolvedLocale: 'en-US',
      agentSessionId: 'sess-pr',
      pendingPatchBySession: {},
      fieldMetadata: {},
      togglePatchSelection,
      applySelectedPatches,
      setPendingPatch,
      toggleFieldLock,
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when pendingPatch is null', () => {
    render(<PatchReviewPanel />);
    expect(screen.queryByText('Patch Review')).toBeNull();
  });

  it('lists pending patches when pendingPatch is non-null', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);

    // Title + run id.
    expect(screen.getByText('Patch Review')).toBeTruthy();
    expect(screen.getByText(/Run: run-1/)).toBeTruthy();
    // Field label resolves via creative.tabs.scene_graph (CR-003 key added).
    expect(screen.getByText('Scene Graph')).toBeTruthy();
    // Action label resolves via creative.patch.set.
    expect(screen.getByText('Set')).toBeTruthy();
    // generatedBy is surfaced verbatim.
    expect(screen.getByText('story-planner-agent')).toBeTruthy();
  });

  it('lists every patch entry in a multi-field patch', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: multiFieldPatch, selections: { outline: true, scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);

    // Both field labels render (outline tab + scene_graph tab).
    expect(screen.getByText('Outline')).toBeTruthy();
    expect(screen.getByText('Scene Graph')).toBeTruthy();
    // Both action labels render (merge + set).
    expect(screen.getByText('Merge')).toBeTruthy();
    expect(screen.getAllByText('Set')).toHaveLength(1);
  });

  it('reflects the checkbox state from patchSelections and forwards toggles', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    await userEvent.click(checkbox);
    expect(togglePatchSelection).toHaveBeenCalledWith('scene_graph');
  });

  it('forwards Apply to applySelectedPatches', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    expect(applySelectedPatches).toHaveBeenCalledTimes(1);
  });

  it('forwards Reject to setPendingPatch(null)', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject All' }));

    expect(setPendingPatch).toHaveBeenCalledWith('sess-pr', null);
  });

  it('does not show issue badges when pendingPatchIssues is empty', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
          } as any);

    const { container } = render(<PatchReviewPanel />);
    expect(container.querySelector('.patch-review-badge')).toBeNull();
  });

  it('surfaces scene_graph error/warning counts from the Story 1.3 data channel', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true }, issues: [
        { code: 'causal-cycle', severity: 'error', message: 'm', targets: [] },
        { code: 'unreachable-line', severity: 'warning', message: 'm', targets: [] },
      ] } },
    } as any);

    const { container } = render(<PatchReviewPanel />);
    expect(container.querySelector('.patch-review-badge--error')?.textContent).toBe('1');
    expect(container.querySelector('.patch-review-badge--warning')?.textContent).toBe('1');
  });

  it('does not show issue badges on non-scene_graph patches', () => {
    const outlinePatch: ProjectFieldPatch = {
      runId: 'run-3',
      createdAt: '2026-07-27T00:00:00Z',
      patches: [
        {
          field: 'outline',
          action: 'set',
          data: { central_conflict: 'x' },
          fieldVersion: 1,
          generatedBy: 'story-planner-agent',
        },
      ],
    };
    // Issues are scene_graph-scoped at the slice level, but guard anyway: an
    // outline row must not show badges even if issues were somehow present.
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: outlinePatch, selections: { outline: true }, issues: [
        { code: 'causal-cycle', severity: 'error', message: 'm', targets: [] },
      ] } },
    } as any);

    const { container } = render(<PatchReviewPanel />);
    expect(container.querySelector('.patch-review-badge')).toBeNull();
  });

  // Story 4.1 Step 5：write_chapter accept_as_truth → field_patch chapter_candidate
  // → PatchReviewPanel 显示章节正文候选行（label / action / generatedBy），accept 走
  // applySelectedPatches → applyAgentFieldPatch IPC（持久化 chapters/*.md）。
  it('renders a chapter_candidate patch row from write_chapter（Story 4.1 Step 5）', () => {
    const chapterCandidatePatch: ProjectFieldPatch = {
      runId: 'run-cc',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run_mock', candidate: { content: '正文…' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: chapterCandidatePatch, selections: { chapter_candidate: true } } },
    } as any);

    render(<PatchReviewPanel />);

    // creative.tabs.chapter_candidate label resolves（"Chapter Draft" en-US）。
    expect(screen.getByText('Chapter Draft')).toBeTruthy();
    // generatedBy 透传（write_chapter）。
    expect(screen.getByText('write_chapter')).toBeTruthy();
  });

  // ── Story 3.1 WP5: per-row field-lock toggle wiring. ──

  it('renders a lock button per creative-field row and forwards to toggleFieldLock', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
      fieldMetadata: {},
    } as any);

    render(<PatchReviewPanel />);

    // Unlocked scene_graph row exposes a "Lock field" button (en-US).
    const lockBtn = screen.getByRole('button', { name: 'Lock field' });
    await userEvent.click(lockBtn);

    expect(toggleFieldLock).toHaveBeenCalledWith('scene_graph');
  });

  it('reflects the locked state from fieldMetadata on the lock button', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
      fieldMetadata: { scene_graph: { version: 1, source: 'user', locked: true, dependsOn: [], stale: false } },
    } as any);

    render(<PatchReviewPanel />);

    // A locked row exposes an "Unlock field" button, marked pressed.
    const lockBtn = screen.getByRole('button', { name: 'Unlock field' });
    expect(lockBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not render a lock button on chapter_candidate rows (not a creative field)', () => {
    const chapterCandidatePatch: ProjectFieldPatch = {
      runId: 'run-cc',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run_mock', candidate: { content: '正文…' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: chapterCandidatePatch, selections: { chapter_candidate: true } } },
    } as any);

    render(<PatchReviewPanel />);

    // No lock/unlock button on a chapter_candidate row.
    expect(screen.queryByRole('button', { name: 'Lock field' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unlock field' })).toBeNull();
  });
});
