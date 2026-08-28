import type { SceneGraphIssue, IssueSeverity } from '@orison/shared-contracts';

/**
 * Story 1.5 Phase D-overlay (design §1.1 / §2.1 / D4): surfaces
 * `validateSceneGraph` issues as severity badges anchored to the elements they
 * flag (scene cells / edges / lane labels).
 *
 * Two pieces + one shared summariser:
 *   - `indexIssuesByTarget`: pure lookup-map builder. An issue appears under
 *     EACH of its targets (a 3-node causal cycle shows a badge on all 3 cells).
 *   - `summarizeIssues`: pure reduction of an issue list to the counts/worst/
 *     tooltip tuple shared by both HTML + SVG badge renderers.
 *   - `ValidationBadges`: inline badge cluster for HTML targets (SceneCell,
 *     LaneRow). EdgeLayer renders its own SVG variant (a `<circle>+<text>` is
 *     structurally different from spans) but reuses `summarizeIssues`.
 *
 * Severity → token binding (theme-tokens spec, no hardcoded hex):
 *   error   → --error / --error-bg        (red — must-fix plot hole)
 *   warning → --warning / --warning-bg    (amber — likely problem)
 *   info    → --on-surface-variant / --surface-container-high
 *                                    (grey — art_overrides downgrade, FYI only)
 *
 * The Issue.message is 叙事语言 (non-graph-theory, per scene-graph-analytics §3).
 * Surface it verbatim in the `title` tooltip — never rephrase (the message IS
 * the author-facing reason; rephrasing would lose the LLM-agent's framing).
 *
 * Paradigm guard: this module only routes already-computed pure-code validation
 * output to the screen. Which issue fires, its severity, its targets — all
 * decided by `validateSceneGraph` (deterministic graph algorithms in
 * shared-contracts). No semantic judgement here.
 */

export type IssueTargetKind = 'node' | 'edge' | 'line';

/**
 * The overlay toggle keys owned by `structureSlice.overlayToggles`.
 * Mirrors `keyof StructureOverlayToggles` without importing the store type —
 * keeps this pure-render module decoupled from the store slice.
 *
 * dogfood R2 批次 B：+ emotion / pacing（EmotionOverlay / PacingOverlay 的
 * 工具栏开关）。foreshadow 是工具栏的禁用占位，不是 slice 键（预留位无状态）。
 */
export type StructureOverlayKey = 'validation' | 'displacement' | 'visibility' | 'emotion' | 'pacing';

export type IssueLookup = {
  node: Map<string, SceneGraphIssue[]>;
  edge: Map<string, SceneGraphIssue[]>;
  line: Map<string, SceneGraphIssue[]>;
};

/**
 * Build per-target-id lookup maps from `validateSceneGraph` output. Pure:
 * same input → same output, input never mutated. An issue with N targets
 * appears under all N (e.g. a cycle flags every node on the cycle path; an
 * unreachable-line issue flags each stranded node).
 *
 * Consumers (NarrativeTimelinePanel) pass `lookup.node.get(cell.nodeId)` etc.
 * down to the leaf components, so each cell/edge/lane only re-renders its own
 * badges. Missing key → undefined → `ValidationBadges` renders nothing.
 */
export function indexIssuesByTarget(issues: SceneGraphIssue[]): IssueLookup {
  const lookup: IssueLookup = {
    node: new Map(),
    edge: new Map(),
    line: new Map(),
  };
  for (const issue of issues) {
    for (const target of issue.targets) {
      const bucket = lookup[target.kind].get(target.id);
      if (bucket) bucket.push(issue);
      else lookup[target.kind].set(target.id, [issue]);
    }
  }
  return lookup;
}

/** Severity iteration order for the HTML badge cluster (worst → mildest). */
const SEVERITY_ORDER: ReadonlyArray<IssueSeverity> = ['error', 'warning', 'info'];

type SeverityCounts = Record<IssueSeverity, number>;

function countBySeverity(issues: SceneGraphIssue[]): SeverityCounts {
  const counts: SeverityCounts = { error: 0, warning: 0, info: 0 };
  // CR-007 defense: an out-of-contract severity (TS-exhaustive but runtime-
  // defensive against malformed data, bundled with CR-001) falls into the error
  // bucket instead of writing NaN (`counts[unknownKey]++` would create a NaN
  // entry and the badge would undercount).
  for (const i of issues) {
    if (i.severity in counts) counts[i.severity]++;
    else counts.error++;
  }
  return counts;
}

/**
 * Compose the badge tooltip from issue messages (叙事语言, verbatim) + any
 * suggestions. One block per issue so the author sees every reason behind a
 * target's flag at a glance. `\n` renders as a line break in the native tooltip.
 */
function composeBadgeTitle(issues: SceneGraphIssue[]): string | undefined {
  if (issues.length === 0) return undefined;
  return issues
    .map((i) => (i.suggestion ? `${i.message}\n→ ${i.suggestion}` : i.message))
    .join('\n');
}

export type IssueSummary = {
  counts: SeverityCounts;
  /** worst severity present (error > warning > info), or null when empty */
  worst: IssueSeverity | null;
  /** total issue count (sum across severities) */
  count: number;
  /** aggregated tooltip (verbatim messages + suggestions), undefined when empty */
  title: string | undefined;
};

/**
 * Reduce an issue list to the badge summary shared by HTML + SVG renderers.
 * Pure; exported so EdgeLayer (SVG) and ValidationBadges (HTML) stay in sync
 * on colour/count/tooltip semantics without duplicating the logic.
 */
export function summarizeIssues(issues: SceneGraphIssue[]): IssueSummary {
  const counts = countBySeverity(issues);
  const worst = SEVERITY_ORDER.find((s) => counts[s] > 0) ?? null;
  return {
    counts,
    worst,
    count: issues.length,
    title: composeBadgeTitle(issues),
  };
}

type ValidationBadgesProps = {
  /** issues whose targets include this element. Empty/undefined → render nothing. */
  issues?: SceneGraphIssue[];
};

/**
 * Inline severity badge cluster for HTML targets (SceneCell, LaneRow). Renders
 * one small pill per severity present (error first), each showing that
 * severity's count. The cluster carries a `title` with all issue messages so
 * hover explains the flag without occupying cell space.
 *
 * Renders null when there are no issues — so callers can pass
 * `lookup.node.get(id)` through unconditionally and let the component gate.
 */
export function ValidationBadges({ issues }: ValidationBadgesProps) {
  if (!issues || issues.length === 0) return null;
  const { counts, title } = summarizeIssues(issues);
  return (
    <span className="validation-badges" title={title}>
      {SEVERITY_ORDER.map((sev) => {
        const n = counts[sev];
        if (n === 0) return null;
        return (
          <span
            key={sev}
            className={`validation-badge validation-badge--${sev}`}
            data-validation-severity={sev}
          >
            {n}
          </span>
        );
      })}
    </span>
  );
}
