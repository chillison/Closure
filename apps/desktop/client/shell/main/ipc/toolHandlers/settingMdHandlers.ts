/**
 * setting_md_update tool handler (Story 2.2 WP-B, design §3).
 *
 * Long-form setting prose lives at `<project>/settings/*.md` (Story 2.3:
 * storage + settingMdIndexer derived index + query_story retrieval). This
 * handler is the agent WRITE path — a bounded span vocabulary (create_file /
 * replace_span / insert_after / remove_span / update_meta) applied by the
 * pure `applySettingMdActions` (shared-contracts, reuses the 7.1 splice
 * primitives verbatim — zero new location code in the shell).
 *
 * Dual landing (mirror emotionCurveHandlers DW-4 / asset_cards_update):
 * - autoApply === true (leader passes it ONLY under permissionMode 'auto',
 *   KD1): `withProjectLock` + read fresh + apply + atomicWrite + DIRECT
 *   `reindexSettingMd` (deterministic 即刻可检回 — mirror save_craft_doc; the
 *   500ms settingMdWatcher is the backup face). Returns `{ok, applied:true}`.
 * - autoApply absent/false (suggest default): does NOT write. Returns the
 *   dedicated `{type:'setting_md_patch', settingId, actions, before, after}`
 *   envelope (NOT field_patch — setting_md is not a creative field and
 *   PatchReviewPanel's patchFieldSchema cannot carry it, mirror the
 *   chapter_candidate dedicated-routing precedent). The UI renders a dedicated
 *   word-level diff card; accept calls `closure:accept-setting-md`, which
 *   RE-APPLIES the actions against the current file (never persists the stale
 *   proposed `after` — the file may have been edited between proposal and
 *   accept; a drifted anchor fails loudly instead of clobbering user edits).
 *
 * Path safety: derived slugs go through a strict whitelist slugify (no path
 * separator can survive — mirror craftCurationHandlers / Story 3.6 lesson);
 * EXPLICIT settingIds are validated against the same safe charset and
 * REJECTED (not mangled — mangling an id would silently miss the target doc)
 * with a friendly message. Belt-and-suspenders isSafePath against the
 * settings/ root. Never throws (mirror the handler never-throws contract).
 *
 * projectId for the namespaced entry_id (`${projectId}:${settingId}`) is
 * resolved INSIDE reindexSettingMd from the registry (getProject(path)
 * ?.projectId) — do not re-implement it here.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import {
  applySettingMdActions,
  settingMdUpdateRequestSchema,
  type AcceptSettingMdResult,
  type SettingMdAction,
} from '@orison/shared-contracts';
import { isSafePath } from '../pathGuard';
import { getLogger } from '../../logger';
import { withProjectLock } from '../../fs/projectWriteLock';
import { listSettingMdFiles } from '../../db/settingMdPaths';
import { reindexSettingMd } from '../../db/settingMdIndexer';
import type { ToolHandler } from './types';

/** Slug length cap (Windows MAX_PATH headroom for <project>/settings/<slug>.md). */
const SETTING_SLUG_MAX_LEN = 80;

/** Max -2/-3/… conflict suffix attempts before falling back to a timestamped slug. */
const MAX_CONFLICT_ATTEMPTS = 100;

/** Windows reserved device names — a bare reserved slug would fail/unlink weirdly on win32. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Strict whitelist slugify for DERIVED slugs (title → filename): ASCII letters
 * / digits / `_` / `-` + CJK unified ideographs. Everything else collapses to
 * '-' so no path separator / traversal can survive (mirror slugifyCraftDoc,
 * Story 3.6 lesson). Empty result falls back to 'untitled'; Windows reserved
 * names get a suffix.
 */
export function slugifySettingDoc(input: string): string {
  const stem = input.replace(/\.md$/i, '');
  let slug = stem
    .replace(/[^\w一-鿿-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SETTING_SLUG_MAX_LEN)
    .replace(/^-+|-+$/g, '');
  if (!slug) slug = 'untitled';
  if (WINDOWS_RESERVED.has(slug.toLowerCase())) slug = `${slug}-doc`;
  return slug;
}

/**
 * Validate an EXPLICIT settingId against the safe charset (reject, never
 * mangle — a mangled id would silently miss the existing target doc). Blocks
 * path separators, traversal ('..'), control chars + NUL (Story 3.6 lesson),
 * leading dots (hidden files), Windows reserved names, over-length slugs.
 */
export function isSafeSettingSlug(input: string): boolean {
  const s = input.trim();
  if (!s || s.length > SETTING_SLUG_MAX_LEN) return false;
  if (s !== input) return false; // surrounding whitespace → let the caller trim + retry
  if (s.startsWith('.')) return false;
  if (s.includes('..')) return false;
  // Control chars + NUL (Story 3.6 lesson). Code-point loop, not a regex with unicode
  // escapes (a literal NUL byte in source makes git treat the file as binary).
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  if (WINDOWS_RESERVED.has(s.toLowerCase())) return false;
  // CR-08-16-013：'.' 不在白名单——派生 slugify 把 '.' 折成 '-'（slugifySettingDoc），显式 id 若
  // 放行 '.' 同一 settingId 会经两路径落到不同文件（magic.system.md vs magic-system.md），身份空间
  // 分叉。两处字符集保持一致（注释「same safe charset」如今为真）。
  return /^[\w一-鿿][\w一-鿿\-]*$/.test(s);
}

/**
 * Pick a conflict-free slug for create_file (never overwrite — mirror
 * pickConflictFreeSlug two faces): (a) same settingId anywhere under
 * settings/ (listSettingMdFiles resolves frontmatter ids + subfolders — a
 * same-id doc in settings/magic/ would shadow the new flat file), (b) an
 * existing file at the target path (catches unparseable docs the scan
 * skipped). Suffix -2/-3/… up to MAX, then a timestamped fallback.
 */
export function pickConflictFreeSettingSlug(projectDir: string, baseSlug: string): string {
  let existingIds: Set<string>;
  try {
    existingIds = new Set(listSettingMdFiles(projectDir).map((f) => f.settingId));
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectDir },
      '[setting_md] settings scan failed — falling back to file-existence conflict check',
    );
    existingIds = new Set();
  }
  const settingsDir = path.join(projectDir, 'settings');
  const taken = (slug: string): boolean =>
    existingIds.has(slug) || existsSync(path.join(settingsDir, `${slug}.md`));
  if (!taken(baseSlug)) return baseSlug;
  for (let n = 2; n <= MAX_CONFLICT_ATTEMPTS; n += 1) {
    const candidate = `${baseSlug}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${baseSlug}-${Date.now()}`;
}

/**
 * Read the current doc text. Result-object (CR-08-16-110) — `ok:true` with
 * `content` undefined = the file does not exist (create_file legal); `ok:false`
 * = the file EXISTS but cannot be read (EACCES / EISDIR / lock) — callers must
 * NOT treat that as "doesn't exist" (create_file would then overwrite through
 * a read error). Never throws (mirror the handler never-throws contract).
 */
type ReadSettingMdResult = { ok: true; content?: string } | { ok: false; reason: string };
function readSettingMdFile(filePath: string): ReadSettingMdResult {
  try {
    if (!existsSync(filePath)) return { ok: true };
    return { ok: true, content: readFileSync(filePath, 'utf-8') };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, filePath }, '[setting_md] settings doc read failed');
    return { ok: false, reason };
  }
}

/** Human-readable op-count summary for the envelope / outputs. */
function summarizeActions(actions: readonly SettingMdAction[]): string {
  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a.op, (counts.get(a.op) ?? 0) + 1);
  return [...counts.entries()].map(([op, n]) => `${op}×${n}`).join(' · ');
}

/** Format an applySettingMdActions failure for an LLM-facing output line. */
export function describeApplyFailure(result: { reason: string; failedIndex: number; action: SettingMdAction }): string {
  return `${result.reason}（第 ${result.failedIndex + 1} 项操作，op=${result.action.op}）`;
}

/**
 * Persist core shared by the autoApply tool path and the accept IPC: read the
 * CURRENT file fresh → apply → mkdir → atomicWrite → direct reindex (best
 * effort — a reindex failure NEVER un-saves the doc; the settingMdWatcher /
 * manual rebuild recovers it, mirror save_craft_doc). Callers wrap in
 * withProjectLock so read-modify-write is atomic against concurrent edits.
 */
export async function applyAndPersistSettingMd(
  projectDir: string,
  settingId: string,
  actions: readonly SettingMdAction[],
): Promise<AcceptSettingMdResult> {
  const settingsDir = path.join(projectDir, 'settings');
  const filePath = path.join(settingsDir, `${settingId}.md`);
  // Belt-and-suspenders (the safe-slug checks upstream make separators
  // unreachable, but the final target must provably sit inside settings/).
  if (!isSafePath(settingsDir, filePath)) {
    return { ok: false, reason: `目标路径越出了设定文档目录（${filePath}）` };
  }

  const read = readSettingMdFile(filePath);
  if (!read.ok) {
    return {
      ok: false,
      reason: `无法读取当前文档（${read.reason}）——请检查文件权限，或确认它是常规文件`,
    };
  }
  const current = read.content;
  const result = applySettingMdActions(current, actions, { settingId });
  if (!result.ok) {
    return {
      ok: false,
      reason: `${describeApplyFailure(result)}——文档可能与提议时已发生变化；请重新读取后再重新提议`,
    };
  }

  mkdirSync(settingsDir, { recursive: true });
  atomicWriteFileSync(filePath, result.content, 'utf-8');

  // CR-08-16-108：reindexSettingMd 返 boolean（false = 项目未注册跳过索引等非 throw 路径）——
  // 必须消费返回值，否则 indexed:true 谎称「query_story 现在可检回」。
  let indexed = false;
  try {
    indexed = await reindexSettingMd(projectDir, filePath);
  } catch (err) {
    indexed = false;
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), filePath },
      '[setting_md] direct reindex failed — file saved, watcher will recover the index',
    );
  }
  return { ok: true, settingId, filePath, appliedCount: result.appliedCount, indexed };
}

/**
 * setting_md_update：bounded span 编辑 → 双档落盘（见文件头）。suggest 档产
 * setting_md_patch envelope（before/after 全文由 handler 读当前文件 + 纯代码投影算出），
 * 不写盘——accept 时 shell 重放 actions（见 applyAndPersistSettingMd 注释）。
 */
export const settingMdUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  // Trust-boundary: parse the whole request through the schema (mirror
  // assetCardsHandlers' per-action parse; invalid shapes surface to the LLM).
  const parsed = settingMdUpdateRequestSchema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      title: 'setting_md_update',
      output:
        `设定文档更新被拒：请求格式无效（${issue?.path.join('.') ?? '?'}：${issue?.message ?? '未知'}）。` +
        '请提供 settingId（区间编辑 / update_meta 必填；create_file 会从标题派生）+ 非空 actions 数组' +
        '（操作：create_file / replace_span / insert_after / remove_span / update_meta）。',
    };
  }
  const rawSettingId = parsed.data.settingId;
  const actions = parsed.data.actions;
  const autoApply = parsed.data.autoApply === true;

  // ── resolve the target settingId ──
  const hasCreate = actions.some((a) => a.op === 'create_file');
  let settingId: string;
  if (rawSettingId !== undefined) {
    if (!isSafeSettingSlug(rawSettingId)) {
      return {
        title: 'setting_md_update',
        output:
          `设定文档更新被拒：settingId "${rawSettingId.slice(0, 40)}" 不是安全的标识符` +
          '（路径分隔符 / ".." / 控制字符 / 前导点 / Windows 保留名会被拒绝）。' +
          '请使用简单标识符，如 "magic-system"（字母 / 数字 / 中文 / "-" / "_"）。',
      };
    }
    // Explicit id honored verbatim (create_file with an explicit id does NOT
    // get a -2 suffix — silently renaming an explicitly requested id would
    // contradict the request; a collision fails the apply loudly instead).
    settingId = rawSettingId;
  } else if (hasCreate) {
    const create = actions.find(
      (a): a is Extract<SettingMdAction, { op: 'create_file' }> => a.op === 'create_file',
    );
    if (!create) {
      // Unreachable (hasCreate just matched) — defensive, mirror the projector
      // backstop convention: fail friendly instead of crashing on undefined.
      return {
        title: 'setting_md_update',
        output: '设定文档更新被拒：解析标识符时缺少 create_file 操作。',
      };
    }
    settingId = pickConflictFreeSettingSlug(projectDir, slugifySettingDoc(create.title));
  } else {
    return {
      title: 'setting_md_update',
      output:
        '设定文档更新被拒：区间编辑和 update_meta 必须提供 settingId' +
        '（只有 create_file 可以从标题派生）。请传入目标文档 id，如 "magic-system"。',
    };
  }

  const settingsDir = path.join(projectDir, 'settings');
  const filePath = path.join(settingsDir, `${settingId}.md`);
  if (!isSafePath(settingsDir, filePath)) {
    getLogger().warn({ filePath }, '[setting_md] resolved path escaped settings root — refusing');
    return {
      title: 'setting_md_update',
      output: `设定文档更新被拒：目标路径越出了设定文档目录（${filePath}）。`,
    };
  }

  // ── autoApply path: direct persist under the project lock ──
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await applyAndPersistSettingMd(projectDir, settingId, actions);
        if (!result.ok) {
          return { title: 'setting_md_update', output: `设定文档更新被拒：${result.reason}。未做任何改动。` };
        }
        return {
          title: `setting_md_update: ${settingId}`,
          output:
            `设定文档已生效（${summarizeActions(actions)}）→ ${result.filePath}` +
            (result.indexed
              ? '。已同步更新检索，现在可检索到该文档。'
              // CR-08-16-108：false 含「项目未注册跳过索引」与 reindex throw 两态——统一真话：
              // 已保存但未索引，watcher / 手动 rebuild 兜底。
              : '。已保存但尚未同步检索（项目未注册或索引重建失败）——设定文档监视器或手动重建会补上，检索可能暂时找不到它。'),
          metadata: {
            ok: true,
            applied: true,
            settingId,
            filePath: result.filePath,
            appliedCount: result.appliedCount,
            indexed: result.indexed,
            // Batch rows (BatchReportCard L1) read metadata.filePath via toolSummary.
            summary: `settings/${settingId}.md · ${summarizeActions(actions)}`,
          },
        };
      });
    } catch (err) {
      // Graceful (mirror emotionCurveHandlers autoApply catch): a lock/fs
      // failure never throws out of the handler.
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: reason, projectDir }, '[setting_md] autoApply landing failed');
      return {
        title: 'setting_md_update',
        output: `设定文档自动生效失败：${reason}。未做任何改动。`,
      };
    }
  }

  // ── suggest path (default): project only, never write ──
  const read = readSettingMdFile(filePath);
  if (!read.ok) {
    // CR-08-16-110：suggest 路径无外层 catch（autoApply 有），读失败在此友好拒——绝不抛穿
    // never-throws 契约，也绝不把「读不了」当「不存在」（create_file 语义保护）。
    return {
      title: 'setting_md_update',
      output:
        `设定文档更新被拒：无法读取 ${filePath} 的当前内容（${read.reason}）。` +
        '请检查文件权限、确认它是常规文件后重试。',
    };
  }
  const current = read.content;
  const result = applySettingMdActions(current, actions, { settingId });
  if (!result.ok) {
    return {
      title: 'setting_md_update',
      output: `设定文档更新被拒：${describeApplyFailure(result)}。未暂存任何改动——请修正操作（重新读取文档、引用精确原文）后重试。`,
    };
  }
  const created = current === undefined;
  return {
    title: `setting_md_update: ${settingId}`,
    output:
      `设定文档更新已备好（${created ? '新建文档' : '编辑'}：${summarizeActions(actions)}）。` +
      '请在对话内的对照卡审阅——确认后写入 settings/' + `${settingId}.md 并同步更新检索。`,
    metadata: {
      type: 'setting_md_patch',
      settingId,
      filePath,
      actions,
      // Display-only projection of the CURRENT file; accept re-applies from
      // disk (see file header) so these are the diff faces, not the payload.
      before: current ?? '',
      after: result.content,
      created,
      summary: `settings/${settingId}.md · ${created ? '新建' : '编辑'} · ${summarizeActions(actions)}`,
    },
  };
};
