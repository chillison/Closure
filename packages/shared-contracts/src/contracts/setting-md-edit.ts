// ── Story 2.2 WP-B: setting_md bounded span-edit contract (design §3) ──
//
// Long-form setting prose lives at `<project>/settings/*.md` (markdown + YAML
// frontmatter, Story 2.3; storage + derived index + query_story retrieval are
// all built). This module adds the AGENT WRITE PATH: a bounded action union
// (create_file / replace_span / insert_after / remove_span / update_meta) plus
// the pure sequential application function the shell handler (suggest-tier
// projection + autoApply persist) and the accept-side IPC both consume.
//
// System anchor philosophy (design §3, aligned repo-wide by this story):
// structured fields = bounded actions (id/natural-key), free text = quote
// anchor splice, whole-file replacement ONLY for create_file. An LLM rewriting
// a whole long-form doc silently drops content (no way to notice what was
// omitted); bounded spans keep "what changed / what didn't" visible in the
// word-level diff card (Story 7.5 renderer).
//
// Span ops reuse the Story 7.1 splice primitives VERBATIM (locateSelection /
// splice semantics, `passage-splice.ts`) — zero new location code. The anchor
// here is the LLM-facing trimmed form `{quote, prefix?, suffix?}`; the full
// SelectionAnchor (all four fields required, `attachment.ts:23-41`) is
// constructed inside applySettingMdActions with prefix/suffix defaulting to ''
// and rangeHint pinned to the {from:0,to:0} placeholder (no editor offsets
// exist on this path — mirror F2: the caller supplies only what it can be
// responsible for). Prompt guidance tells the LLM to anchor on near-unique
// text (prefer heading lines); quote-only anchors over repeated text land in
// `ambiguous` and are REJECTED (zero fuzzy fallback, `passage-splice.ts:129`)
// — mirror rewrite_passage "LLM only has the quote" semantics.
//
// Paradigm (ADR-3): locating / splicing / frontmatter line surgery here are
// all mechanical (pure code, unit-testable); WHICH setting to deepen and WHAT
// the content should be are LLM (WP-A leader guidance segment).
//
// expected_downstream_consumers:
// - Story 2.2 Step 3: agent `setting_md_update` tool (builtin.ts) + shell
//   `settingMdHandlers.ts` (suggest envelope / autoApply persist) + the
//   `closure:accept-setting-md` IPC (settingMdIpc.ts).
// - UI `SettingMdPatchCard` renders the envelope's before/after via the 7.5
//   word-level diff renderer (agent-panel).

import { z } from 'zod';
import type { SelectionAnchor } from './attachment';
import { locateSelection } from './passage-splice';

// ── anchor (LLM-facing trimmed SelectionAnchor) ──

/**
 * Quote anchor for span ops. `quote` is the exact text to locate (primary
 * key, min(1) mirror selectionAnchorSchema CR F8); `prefix` / `suffix` are
 * optional disambiguators for repeated quotes (dice-tolerated by
 * scoreOccurrence, so a lightly-wrong recital still scores).
 */
export const settingMdAnchorSchema = z.object({
  quote: z.string().min(1),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});
export type SettingMdAnchor = z.infer<typeof settingMdAnchorSchema>;

// ── action union ──

const _settingMdActionSchemaRaw = z.discriminatedUnion('op', [
  // Whole-doc write — legal only when the doc does not exist yet, or exists
  // but is BLANK (whitespace-only — CR-016, 08-28-style-card-mvp: a blank file
  // carries no content to clobber, so the whole-file-replacement silent-loss
  // guard has nothing to protect). Whole-file replacement of a doc WITH
  // content remains the anti-pattern this bounded vocabulary exists to
  // prevent.
  z.object({
    op: z.literal('create_file'),
    title: z.string().min(1),
    content: z.string(),
    type: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    linked_entities: z.array(z.string().min(1)).optional(),
  }),
  // Replace the anchored span with `replacement` (splicePassage semantics).
  z.object({
    op: z.literal('replace_span'),
    anchor: settingMdAnchorSchema,
    replacement: z.string(),
  }),
  // Insert `insertion` immediately after the anchored span (anchor the
  // `## heading` line to append a new section).
  z.object({
    op: z.literal('insert_after'),
    anchor: settingMdAnchorSchema,
    insertion: z.string().min(1),
  }),
  // Delete the anchored span (never fuzzy — a quote that no longer matches
  // is rejected rather than "best-effort" deleted).
  z.object({
    op: z.literal('remove_span'),
    anchor: settingMdAnchorSchema,
  }),
  // Frontmatter-only edit (tags / linked_entities / type).
  z.object({
    op: z.literal('update_meta'),
    type: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    linked_entities: z.array(z.string().min(1)).optional(),
  }),
]);

// Top-level refine (mirror atomicEditOpSchema CR-002: member-level .refine
// returns ZodEffects and breaks the discriminatedUnion inference consumers
// switch on): an update_meta carrying none of its three fields is a no-op
// caller bug — reject at the schema surface, not mid-apply.
export const settingMdActionSchema = _settingMdActionSchemaRaw.refine(
  (a) =>
    a.op !== 'update_meta' ||
    a.type !== undefined ||
    a.tags !== undefined ||
    a.linked_entities !== undefined,
  {
    message: 'update_meta: provide at least one of type / tags / linked_entities',
    path: ['op'],
  },
);
export type SettingMdAction = z.infer<typeof settingMdActionSchema>;

/**
 * Tool request. `settingId` identifies the target doc:
 * - span ops / update_meta: REQUIRED (the doc must already exist; the handler
 *   rejects when it is missing rather than guessing).
 * - create_file: optional — omitted lets the shell derive a slug from `title`
 *   (sanitized + conflict -2); an explicit id is honored verbatim (still
 *   sanitized) so the LLM can pin a stable identity.
 * `autoApply` mirrors the Director dual-landing pattern (KD1: the leader
 * passes true only under permissionMode 'auto').
 */
export const settingMdUpdateRequestSchema = z.object({
  settingId: z.string().min(1).optional(),
  // Mirror asset_cards_update P16: an EMPTY action list is a caller bug,
  // rejected at the zod surface (the shell handler re-guards for lenient
  // providers that bypass this schema).
  actions: z.array(settingMdActionSchema).min(1),
  autoApply: z.boolean().optional(),
});
export type SettingMdUpdateRequest = z.infer<typeof settingMdUpdateRequestSchema>;

// ── accept-side IPC contract (closure:accept-setting-md) ──

export const acceptSettingMdInputSchema = z.object({
  projectPath: z.string().min(1),
  settingId: z.string().min(1),
  actions: z.array(settingMdActionSchema).min(1),
});
export type AcceptSettingMdInput = z.infer<typeof acceptSettingMdInputSchema>;

/**
 * Result of persisting a setting-md patch (accept IPC / autoApply landing).
 * `ok:false.reason` is user-facing (toast) — keep it actionable.
 */
export type AcceptSettingMdResult =
  | { ok: true; settingId: string; filePath: string; appliedCount: number; indexed: boolean }
  | { ok: false; reason: string };

// ── pure application ──

export type SettingMdApplyResult =
  | { ok: true; content: string; appliedCount: number }
  | { ok: false; reason: string; failedIndex: number; action: SettingMdAction };

type SingleApplyResult = { ok: true; content: string } | { ok: false; reason: string };

/**
 * Apply actions to a setting doc SEQUENTIALLY (each action sees the previous
 * action's output — a create_file followed by a replace_span edits the freshly
 * created text).
 *
 * EOL/BOM normalization at the boundary (CR-08-16-104): hand-edited Windows
 * docs may carry CRLF line endings, but an LLM reciting a multi-line quote
 * naturally produces LF — an exact-match anchor would systematically fail
 * not-found on such docs (single-line/heading anchors are unaffected). The
 * content is normalized once here (BOM strip + CRLF→LF) so every anchor match
 * and every reserialized write (atomicWrite writes plain LF utf-8; the
 * frontmatter surgery already drops the BOM on reserialize) sees one form.
 * Consequence: the first agent edit of a CRLF doc unifies its line endings —
 * standard tooling behavior, and visible in the word-level diff card.
 *
 * All-or-nothing: the first failing action aborts the whole batch and reports
 * `failedIndex` + the offending `action` so the caller can surface exactly
 * which edit could not land (never a partial write — mirror F1 "splice
 * failure must be loud, not a silent keep-previous").
 *
 * @param currentContent full on-disk doc text (frontmatter + body); undefined
 *   = the doc does not exist yet (only create_file may run).
 * @param actions        parsed SettingMdAction[] (schema-validated upstream).
 * @param opts.settingId resolved slug for create_file's frontmatter `id`
 *   (shell resolves it — slug + conflict suffix — BEFORE calling; omitted →
 *   the frontmatter carries no id and deriveSettingId falls back to the
 *   filename, which the shell writes as `<slug>.md` anyway).
 */
export function applySettingMdActions(
  currentContent: string | undefined,
  actions: readonly SettingMdAction[],
  opts: { settingId?: string } = {},
): SettingMdApplyResult {
  let content = normalizeSettingMdContent(currentContent);
  let appliedCount = 0;
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const result = applyOne(content, action, opts);
    if (!result.ok) {
      return { ok: false, reason: result.reason, failedIndex: i, action };
    }
    content = result.content;
    appliedCount += 1;
  }
  return { ok: true, content: content ?? '', appliedCount };
}

function applyOne(
  content: string | undefined,
  action: SettingMdAction,
  opts: { settingId?: string },
): SingleApplyResult {
  switch (action.op) {
    case 'create_file': {
      // CR-016 (08-28-style-card-mvp): blank existing content (empty file /
      // whitespace-only) counts as "does not exist" — nothing to clobber, and
      // no span op can anchor into a blank doc anyway.
      if (content !== undefined && content.trim().length > 0) {
        return {
          ok: false,
          reason:
            'create_file requires the doc to NOT exist yet (it already does) — edit the existing doc with replace_span / insert_after / remove_span / update_meta instead',
        };
      }
      const body = ensureTitleHeading(action.title, action.content);
      return {
        ok: true,
        content: renderSettingMdDoc(
          {
            ...(opts.settingId ? { id: opts.settingId } : {}),
            ...(action.type ? { type: action.type } : {}),
            ...(action.tags ? { tags: action.tags } : {}),
            ...(action.linked_entities ? { linked_entities: action.linked_entities } : {}),
            // Provenance is stamped by the renderer, never by the LLM.
            source: 'agent',
          },
          body,
        ),
      };
    }
    case 'replace_span': {
      if (content === undefined) return requireExistingDoc(action.op);
      const located = locateSpan(content, action.anchor);
      if (located.status !== 'unique') return { ok: false, reason: describeLocateFailure(action.anchor, located.status) };
      return { ok: true, content: content.slice(0, located.from) + action.replacement + content.slice(located.to) };
    }
    case 'insert_after': {
      if (content === undefined) return requireExistingDoc(action.op);
      const located = locateSpan(content, action.anchor);
      if (located.status !== 'unique') return { ok: false, reason: describeLocateFailure(action.anchor, located.status) };
      return { ok: true, content: content.slice(0, located.to) + action.insertion + content.slice(located.to) };
    }
    case 'remove_span': {
      if (content === undefined) return requireExistingDoc(action.op);
      const located = locateSpan(content, action.anchor);
      if (located.status !== 'unique') return { ok: false, reason: describeLocateFailure(action.anchor, located.status) };
      return { ok: true, content: content.slice(0, located.from) + content.slice(located.to) };
    }
    case 'update_meta': {
      if (content === undefined) return requireExistingDoc(action.op);
      return { ok: true, content: updateFrontmatter(content, action) };
    }
  }
}

function requireExistingDoc(op: string): SingleApplyResult {
  return {
    ok: false,
    reason: `${op} requires an existing doc (settings/<settingId>.md not found) — create it with create_file first, or check settingId`,
  };
}

/**
 * Boundary normalization (CR-08-16-104): BOM strip + CRLF→LF so quote anchors
 * match regardless of which editor last saved the doc (see applySettingMdActions
 * doc comment). `undefined` (doc does not exist) passes through untouched.
 *
 * 风格卡片 MVP（08-28 seam 5 单源化）：消费侧读卡（agent style-card.ts readStyleCardBody /
 * dispatch-style-analyzer.ts readCurrentStyleCard）与 apply 入口同一口径归一——勿在包外
 * 复制本实现（三处漂移风险），直接 import 本函数。
 */
export function normalizeSettingMdContent(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const bomStripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return bomStripped.includes('\r\n') ? bomStripped.replace(/\r\n/g, '\n') : bomStripped;
}

/**
 * Build the full SelectionAnchor the 7.1 primitives require (all four fields
 * required, attachment.ts:23-41): prefix/suffix default to '' (boundary-span
 * anchors are legal), rangeHint pinned to the {from:0,to:0} placeholder (no
 * editor offsets on the agent path). Note the placeholder gives scoreOccurrence
 * a mild early-document bias on repeated quotes; a clear winner still needs
 * real prefix/suffix context, so ambiguous stays ambiguous (by design).
 */
function locateSpan(
  content: string,
  anchor: SettingMdAnchor,
): { status: 'unique'; from: number; to: number } | { status: 'ambiguous' | 'not-found' } {
  const full: SelectionAnchor = {
    quote: anchor.quote,
    prefix: anchor.prefix ?? '',
    suffix: anchor.suffix ?? '',
    rangeHint: { from: 0, to: 0 },
  };
  const located = locateSelection(content, full);
  return located.status === 'unique' ? located : { status: located.status };
}

/** Quote preview for failure reasons (bounded so a long quote can't flood the message). */
function quotePreview(quote: string): string {
  const flat = quote.replace(/\s+/g, ' ').trim();
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat;
}

function describeLocateFailure(anchor: SettingMdAnchor, status: 'ambiguous' | 'not-found'): string {
  if (status === 'not-found') {
    return `span anchor "${quotePreview(anchor.quote)}" not found in the doc (no fuzzy fallback — quote the exact current text, or anchor a heading line)`;
  }
  return `span anchor "${quotePreview(anchor.quote)}" matches multiple places (ambiguous) — provide prefix/suffix context or pick a more unique quote (prefer a heading line)`;
}

// ── frontmatter rendering / surgery (no yaml dependency — this package has none) ──

/** Frontmatter payload for a rendered doc (mirror SettingFrontmatter field order). */
export interface SettingMdFrontmatterInput {
  id?: string;
  type?: string;
  tags?: readonly string[];
  linked_entities?: readonly string[];
  source: string;
}

/**
 * YAML single-quoted scalar: exact js-yaml round-trip for CJK / ':' / '#'
 * content ('' escapes embedded quotes); embedded newlines flatten (identity /
 * type / provenance are single-line values by contract).
 */
function yamlScalar(value: string): string {
  return `'${value.replace(/\r?\n/g, ' ').replace(/'/g, "''")}'`;
}

function yamlFlowArray(values: readonly string[]): string {
  return `[${values.map((v) => yamlScalar(v)).join(', ')}]`;
}

/**
 * Render a full setting doc (frontmatter fence + body). Mirrors the
 * READ consumer (`settingMd.ts` parseSettingMd / craftMd renderCraftDoc shape,
 * lineWidth-free single lines).
 */
export function renderSettingMdDoc(fm: SettingMdFrontmatterInput, body: string): string {
  const lines: string[] = ['---'];
  if (fm.id) lines.push(`id: ${yamlScalar(fm.id)}`);
  if (fm.type) lines.push(`type: ${yamlScalar(fm.type)}`);
  if (fm.tags) lines.push(`tags: ${yamlFlowArray(fm.tags)}`);
  if (fm.linked_entities) lines.push(`linked_entities: ${yamlFlowArray(fm.linked_entities)}`);
  lines.push(`source: ${yamlScalar(fm.source)}`);
  lines.push('---');
  return `${lines.join('\n')}\n${body}`;
}

/**
 * Prepend `# <title>` when the content has no level-1 heading — the index
 * display name comes from the first H1 (extractSettingName), so this
 * guarantees the curated title is the indexed name, not a mangled slug.
 * Mirror craftCurationHandlers.ensureTitleHeading.
 */
export function ensureTitleHeading(title: string, content: string): string {
  if (/^#\s+.+$/m.test(content)) return content;
  const safeTitle = title.replace(/\r?\n/g, ' ').trim();
  return `# ${safeTitle}\n\n${content}`;
}

/**
 * Surgical frontmatter edit for update_meta: replace ONLY the provided keys'
 * entry lines and pass every other line through VERBATIM (unknown user keys,
 * comments, formatting — never re-serialize what we did not change; a
 * load-modify-dump round-trip would drop comments and reorder keys).
 *
 * A provided key's entry spans its `key:` line plus any following
 * more-indented continuation lines (yaml block sequences `  - a` / folded
 * scalars) — all replaced by a single rendered line. A key absent from the
 * frontmatter is appended at the end of the block. A doc with no frontmatter
 * block gets one prepended (body untouched). No value parsing at all: the
 * old value is discarded wholesale, which is exactly replace-semantics.
 */
export function updateFrontmatter(content: string, action: Extract<SettingMdAction, { op: 'update_meta' }>): string {
  const replacements: Array<{ key: string; line: string }> = [];
  if (action.type !== undefined) replacements.push({ key: 'type', line: `type: ${yamlScalar(action.type)}` });
  if (action.tags !== undefined) replacements.push({ key: 'tags', line: `tags: ${yamlFlowArray(action.tags)}` });
  if (action.linked_entities !== undefined) {
    replacements.push({ key: 'linked_entities', line: `linked_entities: ${yamlFlowArray(action.linked_entities)}` });
  }
  if (replacements.length === 0) return content; // schema-refine guards this; defensive no-op

  // BOM + leading-whitespace tolerance mirror parseSettingMd (Windows editors);
  // the reserialized doc drops the BOM (atomicWrite writes plain utf-8).
  const bomStripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const fenceMatch = bomStripped.match(/^(\s*---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n?)([\s\S]*)$/);
  if (!fenceMatch) {
    // No frontmatter block → prepend one carrying only the provided keys.
    const lines = ['---', ...replacements.map((r) => r.line), '---'];
    return `${lines.join('\n')}\n${bomStripped}`;
  }
  const [, openFence, fmRaw, closeFence, tailSep, body] = fenceMatch;
  const eol = fmRaw.includes('\r\n') ? '\r\n' : '\n';
  const fmLines = fmRaw.split(/\r?\n/);

  const out: string[] = [];
  const replaced = new Set<string>();
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    // Top-level key line = starts at column 0 with `key:` (continuation lines
    // are indented by definition of the flat frontmatter we write/read).
    const keyMatch = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
    const replacement = keyMatch ? replacements.find((r) => r.key === keyMatch[1]) : undefined;
    if (replacement) {
      out.push(replacement.line);
      replaced.add(replacement.key);
      i += 1;
      // Consume the old value's continuation lines (block sequences / folded
      // scalars are indented; the next top-level key or the fence is not).
      while (i < fmLines.length && /^\s+\S/.test(fmLines[i])) i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  for (const r of replacements) {
    if (!replaced.has(r.key)) out.push(r.line);
  }
  return `${openFence}${out.join(eol)}${closeFence}${tailSep}${body}`;
}
