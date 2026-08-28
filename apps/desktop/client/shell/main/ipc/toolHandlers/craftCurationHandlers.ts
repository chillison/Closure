/**
 * save_craft_doc tool handler (Story 3.6 WP9 / R5/R6 策展, design D13).
 *
 * Curates researched material into the GLOBAL craft KB (`~/.orison/craft-kb/`,
 * cross-project reference library — NOT project data, so no projectDir scope).
 * Writes `~/.orison/craft-kb/research/<slug>.md` (subdir is recursively indexed,
 * CR-craft-kb-003) as markdown + YAML frontmatter, then directly awaits
 * `reindexCraftDoc` so `query_craft` can retrieve it immediately (AC4 闭环：
 * save_craft_doc → query_craft 检回). The craftKbWatcher (500ms debounce) also
 * sees the write in production — the direct reindex makes "即刻可检回"
 * deterministic instead of relying on the watcher.
 *
 * Frontmatter mirrors the READ-side consumption shape (craftMd.ts
 * CraftFrontmatter — source is a free provenance STRING, persisted as
 * closure_craft_entry.source by closureCraftIndexer CR-craft-kb-012):
 *
 *   ---
 *   id: <slug>                  # = filename stem (deriveCraftId reads this)
 *   craft_type: <open string>   # 8-class vocab + uncategorized, or self-registered
 *   tags: [...]                 # orthogonal facets
 *   source: <sourceUrl | 检索 YYYY-MM-DD>   # provenance (R6: URL + retrieval date)
 *   source_note: <free text>    # kept for human provenance (not indexed)
 *   ---
 *   # <title>                   # prepended when content has no H1 (index name)
 *   <content>
 *
 * NEVER throws (R8, mirror query_craft never-throws): invalid params, path
 * escape, fs failure, reindex failure all degrade to friendly outputs — the
 * file write and the reindex failure are reported independently (a failed
 * reindex never un-saves the doc; the watcher / manual rebuild recovers it).
 *
 * Path safety: the craft KB is a GLOBAL dir (no projectDir constraint applies
 * from handleToolExecute), so the defense is a STRICT whitelist slug (no path
 * separators can survive) + an isSafePath(craft-kb-root, target) belt check
 * (防 ../ 逃逸). classifyTool = 'write' (toolPolicy WRITE_TOOLS — 显式写入动作,
 * readonly/suggest 不可用, mirror write_file).
 *
 * Params are hand-coerced — no zod in this package (mirror wikiHandlers /
 * fetchHandlers); the agent-side tool definition carries the zod surface the
 * LLM sees.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { isSafePath } from '../pathGuard';
import { getLogger } from '../../logger';
import { getCraftKbUserDir, listCraftMdFiles } from '../../db/craftKbPaths';
import { reindexCraftDoc } from '../../db/closureCraftIndexer';
import type { ToolHandler } from './types';

/** Research curation subdir (recursively indexed, CR-craft-kb-003). */
const RESEARCH_SUBDIR = 'research';

/** Slug length cap (Windows MAX_PATH headroom for ~/.orison/craft-kb/research/<slug>.md). */
const SLUG_MAX_LEN = 80;

/** Max -2/-3/… conflict suffix attempts before falling back to a timestamped slug. */
const MAX_CONFLICT_ATTEMPTS = 100;

/** Windows reserved device names — a bare reserved slug would fail/unlink weirdly on win32. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export type SaveCraftDocParams = {
  craft_type?: string;
  title?: string;
  content?: string;
  tags?: string[];
  sourceUrl?: string;
  sourceNote?: string;
  filename?: string;
};

/** Hand-coerce raw params (mirror wikiHandlers): strings trimmed + non-empty; tags filtered to non-empty strings. */
export function coerceSaveCraftDocParams(params: Record<string, unknown>): SaveCraftDocParams {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const tags = Array.isArray(params.tags)
    ? params.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
    : undefined;
  return {
    craft_type: str(params.craft_type),
    title: str(params.title),
    content: typeof params.content === 'string' && params.content.trim() ? params.content : undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
    sourceUrl: str(params.sourceUrl),
    sourceNote: str(params.sourceNote),
    filename: str(params.filename),
  };
}

/**
 * Strict whitelist slug (防路径逃逸——白名单外字符全替换为 '-'，分隔符不可能存活)：
 * ASCII letters / digits / `_` / `-` + CJK 统一表意文字（一-鿿，中文标题直接成可读 slug）。
 * Collapse 连续 '-'，trim 首尾，cap 长度；空结果回退 'untitled'；Windows 保留名加后缀。
 */
export function slugifyCraftDoc(input: string): string {
  const stem = input.replace(/\.md$/i, '');
  let slug = stem
    .replace(/[^\w一-鿿-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
    .replace(/^-+|-+$/g, '');
  if (!slug) slug = 'untitled';
  if (WINDOWS_RESERVED.has(slug.toLowerCase())) slug = `${slug}-doc`;
  return slug;
}

/** Frontmatter source string (R6 provenance): sourceUrl + 检索日期 ISO（craftMd source 消费自由串形态）。 */
export function buildCraftSource(sourceUrl: string | undefined, retrievedAt: Date): string {
  const date = retrievedAt.toISOString().slice(0, 10);
  return sourceUrl ? `${sourceUrl} | 检索 ${date}` : `agent 研究策展 | 检索 ${date}`;
}

/**
 * Body normalization: prepend `# <title>` when the content has no level-1
 * heading — the index name comes from the first H1 (craftMd.extractCraftName),
 * falling back to the craft_id (slug) otherwise; the H1 guarantees the indexed
 * display name is the curated title, not a hyphen-mangled slug. Content with
 * its own H1 passes through untouched (author structure preserved).
 */
export function ensureTitleHeading(title: string, content: string): string {
  if (/^#\s+.+$/m.test(content)) return content;
  const safeTitle = title.replace(/\r?\n/g, ' ').trim();
  return `# ${safeTitle}\n\n${content}`;
}

/** Render the full doc (frontmatter fence + body). Exported for unit testing. */
export function renderCraftDoc(fm: {
  id: string;
  craft_type: string;
  tags?: string[];
  source: string;
  source_note?: string;
}, body: string): string {
  const fmPayload: Record<string, unknown> = {
    id: fm.id,
    craft_type: fm.craft_type,
    ...(fm.tags ? { tags: fm.tags } : {}),
    source: fm.source,
    ...(fm.source_note ? { source_note: fm.source_note } : {}),
  };
  // lineWidth: -1 disables line wrapping — a wrapped plain scalar (e.g. a long
  // source URL) folds back with altered spacing on yaml.load; no-wrap keeps the
  // round-trip exact.
  return `---\n${yaml.dump(fmPayload, { lineWidth: -1 }).trimEnd()}\n---\n${body}`;
}

/**
 * Pick a conflict-free slug: never overwrite (design D13). Conflicts checked on
 * BOTH faces — (a) same craft_id anywhere in the KB (listCraftMdFiles priority
 * merge: a same-id user doc would silently SHADOW a bundled seed / duplicate
 * another user doc with only a warn), (b) an existing file at the target path
 * (catches unparseable docs the scan skipped). Suffix -2/-3/… up to MAX, then a
 * timestamped fallback.
 */
export function pickConflictFreeSlug(baseSlug: string): string {
  const userDir = getCraftKbUserDir();
  let existingIds: Set<string>;
  try {
    existingIds = new Set(listCraftMdFiles().map((f) => f.craftId));
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[save_craft_doc] craft KB scan failed — falling back to file-existence conflict check',
    );
    existingIds = new Set();
  }

  const taken = (slug: string): boolean =>
    existingIds.has(slug) || existsSync(path.join(userDir, RESEARCH_SUBDIR, `${slug}.md`));

  if (!taken(baseSlug)) return baseSlug;
  for (let n = 2; n <= MAX_CONFLICT_ATTEMPTS; n++) {
    const candidate = `${baseSlug}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${baseSlug}-${Date.now()}`;
}

/**
 * save_craft_doc handler：写 `~/.orison/craft-kb/research/<slug>.md` + 直接 reindex（FTS/vec
 * 即刻可查）→ 返回确认 + 绝对路径。never-throws（R8）。classifyTool='write'（readonly/suggest 不可用）。
 */
export const saveCraftDocHandler: ToolHandler = async ({ params }) => {
  const p = coerceSaveCraftDocParams(params);
  if (!p.craft_type || !p.title || !p.content) {
    return {
      title: 'save_craft_doc',
      output: '策展保存被拒：craft_type / title / content 均为必填（content 为 markdown 正文）。请补全后重试。',
    };
  }

  try {
    const baseSlug = slugifyCraftDoc(p.filename ?? p.title);
    const slug = pickConflictFreeSlug(baseSlug);

    const userDir = getCraftKbUserDir();
    const researchDir = path.join(userDir, RESEARCH_SUBDIR);
    const filePath = path.join(researchDir, `${slug}.md`);

    // Belt-and-suspenders (whitelist slug makes separators unreachable, but the
    // final target must provably sit inside the craft-kb root — 防 ../ 逃逸).
    if (!isSafePath(userDir, filePath)) {
      getLogger().warn({ filePath }, '[save_craft_doc] resolved path escaped craft-kb root — refusing');
      return {
        title: 'save_craft_doc',
        output: `策展保存被拒：目标路径越出 craft KB 根目录（${filePath}）。请简化 title/filename 后重试。`,
      };
    }

    const body = ensureTitleHeading(p.title, p.content);
    const doc = renderCraftDoc(
      {
        id: slug,
        craft_type: p.craft_type,
        tags: p.tags,
        source: buildCraftSource(p.sourceUrl, new Date()),
        source_note: p.sourceNote,
      },
      body,
    );

    mkdirSync(researchDir, { recursive: true });
    atomicWriteFileSync(filePath, doc, 'utf-8');

    // Direct reindex (deterministic 即刻可检回；production watcher is a 500ms
    // debounce backup). Failure NEVER un-saves the doc — watcher / manual
    // rebuild (closure:rebuild-craft-kb) recovers the index.
    let indexed = true;
    let indexNote = 'craft KB 已重建索引，query_craft 即刻可检回。';
    try {
      await reindexCraftDoc(filePath, 'user');
    } catch (err) {
      indexed = false;
      const reason = err instanceof Error ? err.message : String(err);
      indexNote = `索引重建失败（${reason}）——文档已保存，craft KB watcher 会自动补索引（或设置页手动重建）。`;
      getLogger().warn({ err: reason, filePath }, '[save_craft_doc] direct reindex failed — file saved');
    }

    return {
      title: `save_craft_doc: ${slug}`,
      output: [
        `已策展入全局 craft KB：${filePath}`,
        `（craft_type: ${p.craft_type}${p.tags ? `，tags: ${p.tags.join(' / ')}` : ''}，id: ${slug}）`,
        indexNote,
      ].join('\n'),
      metadata: { ok: true, filePath, craftId: slug, craftType: p.craft_type, indexed },
    };
  } catch (err) {
    // Never-throws contract (R8): fs failure / unexpected errors degrade to a
    // friendly message — handleToolExecute does NOT catch handler throws.
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason }, '[save_craft_doc] save failed');
    return {
      title: 'save_craft_doc',
      output: `策展保存失败：${reason}。文档未写入（或写入不完整），请重试或检查磁盘权限。`,
      metadata: { ok: false, error: reason },
    };
  }
};
