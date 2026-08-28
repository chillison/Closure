import { dialog, ipcMain } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { assertSafePath, assertWithinProject } from './pathGuard';
import { withProjectLock } from '../fs/projectWriteLock';
import { getLogger } from '../logger';
import { notifyUI, notifyProjectQuarantined } from './toolNotify';
import { readDirectoryRecursive } from './projectIpcHelpers';
import { commitProjectCreateNode } from './gitIpc';

/** camelCase meta (coverImage/projectId) mapped to project.yaml snake_case meta. */
const META_KEY_MAP: Record<string, string> = {
  name: 'name',
  type: 'type',
  logline: 'logline',
  synopsis: 'synopsis',
  genre: 'genre',
  theme: 'theme',
  writing_style: 'writing_style',
  writingStyle: 'writing_style',
  tone: 'tone',
  coverImage: 'cover_image',
  cover_image: 'cover_image',
  projectId: 'project_id',
  project_id: 'project_id',
};

/** Merge incoming meta into project document's meta (empty string/null clears). */
function applyMetaToDocument(doc: Record<string, any>, meta: Record<string, unknown>): void {
  if (!doc.meta || typeof doc.meta !== 'object') doc.meta = {};
  for (const [inKey, value] of Object.entries(meta)) {
    const docKey = META_KEY_MAP[inKey];
    if (!docKey) continue; // chapters etc. don't go into project.yaml meta
    if (docKey === 'name') {
      if (typeof value === 'string' && value.trim()) doc.meta.name = value;
    } else if (docKey === 'type') {
      if (value === 'script' || value === 'novel') doc.meta.type = value;
    } else if (value === undefined) {
      continue;
    } else {
      doc.meta[docKey] = value ? value : undefined;
    }
  }
}

/**
 * Story 1.4: seed creative_brief from NewProjectDialog's pattern selection.
 * creative_brief is a top-level creative field (not meta), so META_KEY_MAP skips it.
 * Only seeds when the doc has no creative_brief yet (creation) -- never overwrites an
 * existing brief (subsequent meta saves / edits leave it alone). The creativeBrief
 * payload is validated by projectDocumentSchema.parse at save time (structure_pattern
 * enum + rawRequirement required). rawRequirement defaults to project name when absent.
 */
function seedCreativeBrief(doc: Record<string, any>, meta: Record<string, unknown>): void {
  if (doc.creative_brief !== undefined) return; // 已有 brief 不覆盖
  const brief = meta.creativeBrief;
  if (!brief || typeof brief !== 'object') return;
  const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : doc.meta?.name;
  doc.creative_brief = {
    ...brief,
    ...(name && !(brief as Record<string, unknown>).rawRequirement ? { rawRequirement: name } : {}),
  };
}

/** project.yaml meta (snake_case) back to legacy camelCase shape for the renderer. */
function projectMetaToLegacyShape(meta: Record<string, any>): Record<string, unknown> {
  return {
    ...meta,
    writingStyle: meta.writing_style,
    coverImage: meta.cover_image,
    projectId: meta.project_id,
  };
}

/**
 * Convert a .docx file to Markdown. mammoth extracts the document body as HTML
 * (headings, bold/italic, lists, basic tables), then turndown maps it to
 * Markdown. Complex formatting (comments, advanced styles) is intentionally
 * dropped — prose-first conversion for a writing tool.
 */
async function convertDocxToMarkdown(fullPath: string): Promise<string> {
  const mammothMod = await import('mammoth');
  const mammoth = (mammothMod as { default?: unknown }).default ?? mammothMod;
  const { value: html } = await (mammoth as {
    convertToHtml: (i: { buffer: Buffer }) => Promise<{ value: string }>;
  }).convertToHtml({ buffer: readFileSync(fullPath) });

  const TurndownService = (await import('turndown')).default;
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return turndown.turndown(html);
}

/**
 * Build a non-colliding `<base>.md` path within `dir`, appending `-1`, `-2`, ...
 * if a file already exists.
 */
function uniqueMarkdownPath(dir: string, baseName: string): string {
  let candidate = path.join(dir, `${baseName}.md`);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${baseName}-${i}.md`);
    i++;
  }
  return candidate;
}

/**
 * quarantine-notify（2026-08-27）：迁移/加载结果携带判腐隔离事实时推 renderer 通知中心。
 * renderer 按工程去重（useToolEvents），多加载点各自上报不会刷屏。
 */
function reportQuarantine(
  projectDir: string,
  quarantined: { backupPath: string | null; reason: string; recovered: boolean } | null,
): void {
  if (quarantined) notifyProjectQuarantined(projectDir, quarantined);
}

/**
 * migrate → load 双段加载（save-meta / ensure-document / sync-meta 既有语义：migrate 返回
 * null 时再裸 load 一次），两段的判腐隔离事实都上报。project.yaml 均不可得时返回 null。
 */
async function loadExistingDocument(projectDir: string): Promise<{ document: unknown | null }> {
  const { migrateLegacyProjectJsonWithQuarantine, loadProjectWithQuarantine } =
    await import('@orison/desktop-local-bff');
  const migrated = migrateLegacyProjectJsonWithQuarantine(projectDir);
  reportQuarantine(projectDir, migrated.quarantined);
  if (migrated.document) return { document: migrated.document };
  const reloaded = loadProjectWithQuarantine(projectDir);
  reportQuarantine(projectDir, reloaded.quarantined);
  return { document: reloaded.document };
}

export function registerProjectMetaIpc(): void {
  /* ── docx import / conversion ── */

  ipcMain.handle('project:import-docx', async (_, projectDir: string) => {
    assertSafePath(projectDir);
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Word', extensions: ['docx'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const src = result.filePaths[0];
    const markdown = await convertDocxToMarkdown(src);
    const baseName = path.basename(src, path.extname(src));
    const dest = uniqueMarkdownPath(projectDir, baseName);
    assertWithinProject(projectDir, dest);
    atomicWriteFileSync(dest, markdown, 'utf-8');
    const rel = '/' + path.relative(projectDir, dest).split(path.sep).join('/');
    notifyUI({ type: 'file:changed', projectPath: projectDir, path: rel });
    return rel;
  });

  ipcMain.handle('project:docx-to-html', async (_, fullPath: string) => {
    assertSafePath(fullPath);
    if (!existsSync(fullPath) || path.extname(fullPath).toLowerCase() !== '.docx') return null;
    try {
      const mammothMod = await import('mammoth');
      const mammoth = (mammothMod as { default?: unknown }).default ?? mammothMod;
      const { value } = await (mammoth as {
        convertToHtml: (i: { buffer: Buffer }) => Promise<{ value: string }>;
      }).convertToHtml({ buffer: readFileSync(fullPath) });
      return value;
    } catch {
      return null;
    }
  });

  ipcMain.handle('project:docx-to-markdown', async (_, fullPath: string, projectDir: string) => {
    assertSafePath(fullPath);
    assertSafePath(projectDir);
    if (!existsSync(fullPath) || path.extname(fullPath).toLowerCase() !== '.docx') return null;
    const markdown = await convertDocxToMarkdown(fullPath);
    const dir = path.dirname(fullPath);
    const baseName = path.basename(fullPath, path.extname(fullPath));
    const dest = uniqueMarkdownPath(dir, baseName);
    assertSafePath(dest);
    atomicWriteFileSync(dest, markdown, 'utf-8');
    notifyUI({ type: 'file:changed', projectPath: projectDir, path: dest });
    return dest;
  });

  /* ── Meta save/load/sync ── */

  ipcMain.handle('project:save-meta', async (_, projectDir: string, meta: Record<string, unknown>) => {
    assertSafePath(projectDir);
    return withProjectLock(projectDir, async () => {
      try {
        const { saveProject, createEmptyProjectDocument } =
          await import('@orison/desktop-local-bff');
        // CR-28（dogfood R2）：existing 为空 = 全新文档首写（新建项目流程 NewProjectDialog
        // 的 saveProjectMeta 落的就是这条）——首写落地后挂 git 首节点「项目创建」。
        const { document: existingDoc } = await loadExistingDocument(projectDir);
        const doc = (existingDoc ?? createEmptyProjectDocument(
          typeof meta.name === 'string' && meta.name.trim() ? meta.name : path.basename(projectDir),
          meta.type === 'script' ? 'script' : 'novel',
        )) as Record<string, any>;
        const next = structuredClone(doc) as Record<string, any>;
        applyMetaToDocument(next, meta);
        seedCreativeBrief(next, meta);
        next.meta.updated_at = new Date().toISOString();
        next.meta.version = (next.meta.version ?? 0) + 1;
        saveProject(projectDir, next as any);
        if (!existingDoc) {
          // 首节点失败不阻塞项目创建（commitProjectCreateNode 内部已捕获 warn；此处再兜
          // 一层，保证任何拒绝形态都不把已成功的 yaml 落盘翻成 {ok:false}）。
          try {
            await commitProjectCreateNode(projectDir);
          } catch {
            // best effort — yaml already saved
          }
        }
        return { ok: true };
      } catch (err) {
        // CR-008：seedCreativeBrief 增 parse 失败面（creativeBrief payload 经 IPC 信任边界）。
        // 对齐 sync-meta 模式：不抛错（避免 IPC reject + 调用方 unhandled），返回 {ok:false,error}。
        const message = err instanceof Error ? err.message : String(err);
        getLogger().warn({ err: message, projectDir }, 'project:save-meta failed');
        return { ok: false, error: message };
      }
    });
  });

  // Idempotent project.yaml initialization for create/import flows: guarantees
  // the config file exists without rewriting (or bumping version of) one that's
  // already there. Legacy project.json is migrated in if present.
  ipcMain.handle('project:ensure-document', async (_, projectDir: string, meta: Record<string, unknown>) => {
    assertSafePath(projectDir);
    return withProjectLock(projectDir, async () => {
      try {
        const { saveProject, createEmptyProjectDocument } =
          await import('@orison/desktop-local-bff');
        // Migration (if any) already lands a valid project.yaml on disk.
        const { document: existing } = await loadExistingDocument(projectDir);
        if (existing) return { ok: true };
        // No document yet -> create a fresh one seeded from the supplied meta.
        const doc = createEmptyProjectDocument(
          typeof meta.name === 'string' && meta.name.trim() ? meta.name : path.basename(projectDir),
          meta.type === 'script' ? 'script' : 'novel',
        );
        const next = structuredClone(doc) as Record<string, any>;
        applyMetaToDocument(next, meta);
        seedCreativeBrief(next, meta);
        saveProject(projectDir, next as any);
        // CR-28（dogfood R2）：ensure-document 也会首建文档（save-meta 半途失败的补救
        // 路径 / 打开既有目录补文档）——初始内容就绪点同样挂首节点。只在零提交 repo 上
        // 生效（unborn HEAD 判定）；失败不阻塞（mirror save-meta）。
        try {
          await commitProjectCreateNode(projectDir);
        } catch {
          // best effort — yaml already saved
        }
        return { ok: true };
      } catch (err) {
        // CR-008：与 save-meta 一致，parse/写盘失败返回 {ok:false,error}（不抛错）。
        const message = err instanceof Error ? err.message : String(err);
        getLogger().warn({ err: message, projectDir }, 'project:ensure-document failed');
        return { ok: false, error: message };
      }
    });
  });

  ipcMain.handle('project:load-meta', async (_, projectDir: string) => {
    assertSafePath(projectDir);
    return withProjectLock(projectDir, async () => {
      try {
        const { migrateLegacyProjectJsonWithQuarantine } = await import('@orison/desktop-local-bff');
        const migrated = migrateLegacyProjectJsonWithQuarantine(projectDir);
        reportQuarantine(projectDir, migrated.quarantined);
        if (!migrated.document) return null;
        return projectMetaToLegacyShape(migrated.document.meta);
      } catch {
        return null;
      }
    });
  });

  ipcMain.handle('project:load-document', async (_, projectDir: string) => {
    assertSafePath(projectDir);
    try {
      const { loadProjectWithQuarantine } = await import('@orison/desktop-local-bff');
      const result = loadProjectWithQuarantine(projectDir);
      reportQuarantine(projectDir, result.quarantined);
      return result.document ?? null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('project:sync-meta', async (_, projectDir: string, meta: Record<string, unknown>) => {
    assertSafePath(projectDir);
    return withProjectLock(projectDir, async () => {
      try {
        const { saveProject, createEmptyProjectDocument } = await import('@orison/desktop-local-bff');
        // project.yaml is the single source of truth; missing -> migrate old json or fallback rebuild.
        const { document: existing } = await loadExistingDocument(projectDir);
        const doc = (existing ?? createEmptyProjectDocument(
          typeof meta.name === 'string' && meta.name.trim() ? meta.name : path.basename(projectDir),
          meta.type === 'script' ? 'script' : 'novel',
        )) as Record<string, any>;
        const next = structuredClone(doc) as Record<string, any>;
        applyMetaToDocument(next, meta);
        next.meta.updated_at = new Date().toISOString();
        next.meta.version = (next.meta.version ?? 0) + 1;
        saveProject(projectDir, next as any);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        getLogger().warn({ err: message, projectDir }, 'project:sync-meta failed');
        return { ok: false, error: message };
      }
    });
  });

  ipcMain.handle('project:sync-chapters-meta', async (_, projectDir: string, chapters: Array<{
    id: string;
    title: string;
    sort_order: number;
    status: string;
    summary?: string;
    summary_source?: string;
    sections?: Array<{
      id: string;
      title?: string;
      sort_order: number;
      content_file: string;
      word_count?: number;
    }>;
  }>) => {
    assertSafePath(projectDir);
    return withProjectLock(projectDir, async () => {
      try {
        const { loadProjectWithQuarantine, saveProject } = await import('@orison/desktop-local-bff');
        const result = loadProjectWithQuarantine(projectDir);
        reportQuarantine(projectDir, result.quarantined);
        const doc = result.document;
        if (!doc) return { ok: false, error: 'project document not found' };
        const next = structuredClone(doc) as Record<string, any>;
        if (!next.novel) next.novel = { chapters: [] };
        next.novel.chapters = chapters.map((ch) => {
          const existing = (next.novel.chapters ?? []).find((e: any) => e.id === ch.id);
          return { ...existing, ...ch, sections: ch.sections ?? existing?.sections ?? [] };
        });
        next.meta.version = (next.meta.version ?? 0) + 1;
        next.meta.updated_at = new Date().toISOString();
        saveProject(projectDir, next as any);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        getLogger().warn({ err: message, projectDir }, 'project:sync-chapters-meta failed');
        return { ok: false, error: message };
      }
    });
  });

  ipcMain.handle('project:read-directory', async (_, projectDir: string, maxDepth = 5) => {
    assertSafePath(projectDir);
    if (!existsSync(projectDir)) return [];
    // Clamp maxDepth to prevent abuse
    const clampedDepth = Math.min(Math.max(maxDepth, 1), 8);
    return readDirectoryRecursive(projectDir, projectDir, clampedDepth);
  });
}
