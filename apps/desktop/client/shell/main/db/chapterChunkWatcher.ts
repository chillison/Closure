/**
 * Chapter-chunk Watcher — watches the active project directory for `chapters/*.md`
 * changes and triggers a per-chapter `reindexChapter` so chapter prose lands in the
 * closure_* retrieval index without an app restart (Story 8.3 S3, design §2.3).
 *
 * Mirror of `settingMdWatcher.ts` (same lifecycle + debounce + degrade philosophy):
 * - Recursive `fs.watch` on the project DIRECTORY (NOT a single file — atomic writes
 *   rename breaks single-file watch, mirror assetCardsWatcher/settingMdWatcher).
 *   The `chapterIdOfWatcherFilename` filter reacts ONLY to `.md` changes directly
 *   under `chapters/`, so the project dir's churn (settings/, .orison/ history,
 *   image drops) never spams a reindex.
 * - Debounce ~500ms (coalesce editor bursts); per-chapter reindex (NOT a full scan
 *   per save — 400 章 × 全扫每保存太贵；changed-chapter set 只含事件命中的章).
 * - Linux recursive watch unsupported -> degrade to the open-project backfill scan
 *   (rebuildChapterChunks) + manual rebuild path (mirror the sibling watchers).
 *
 * Deliberately NO self-write suppression (mirror settingMdWatcher): the indexer
 * writes to closure_* SQLite tables ONLY, NEVER to chapters/*.md, and the app's own
 * chapter writes (accept / chapter_write / editor saves) are exactly the events that
 * MUST trigger a reindex — hash-skip makes redundant triggers cheap.
 *
 * 串行化：per-project in-flight chain（Map<projectPath, Promise>，mirror
 * reindexAllSettingMd F5 惯例）——同 project 的 watcher flush 链到前一个 promise 后执行
 * （settle 后重取最新 pending 集），防并发 embed + stale 复活。
 *
 * best-effort 契约（红线）：watcher 回调 try/catch 全包，索引失败只 warn 不抛、不阻任何
 * 流程（正文落盘与索引解耦——索引是 DERIVED，可随时 rebuild）。
 *
 * 🔑 Same lifecycle as settingMdWatcher/assetCardsWatcher: started in
 * `project:watch` (project open, alongside startSettingMdWatcher), stopped in
 * `project:unwatch` (project close/switch) + `will-quit` (app quit) so no fs
 * watcher / timer outlives the active project / the process.
 */
import path from 'node:path';
import { watchDir, type DirWatcher } from '../fs/watchFactory';
import { assertSafePath } from '../ipc/pathGuard';
import { getProject } from './projectRepository';
import { reindexChapter, rebuildChapterChunks } from './chapterChunkIndexer';
import { getLogger } from '../logger';

let activeWatcher: DirWatcher | null = null;
let activeProjectDir: string | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

/** 待重索引章（debounce 窗口内累积；flush 时取走排序后逐章处理）。 */
const pendingChapterIds = new Set<string>();
/** 平台省略 filename 的事件（rename 类）→ 保守全量 rebuild（识别不了章，宁多扫不漏索引）。 */
let pendingFullRebuild = false;

/** Coalesce rapid saves (editor bursts) into one flush. */
const DEBOUNCE_MS = 500;

/** Per-project in-flight chain（watcher flush 串行化——同 project 前一个 flush settle 后才跑）。 */
const inflight = new Map<string, Promise<void>>();

/**
 * watcher 相对文件名 → chapterId（chapters/ 直接子文件 <stem>.md；mirror
 * mentionLedgerDegrade.chapterIdOfChapterFilePath 的相对路径版）。子目录
 * （chapters/draft/x.md）不是工具层可达章形态，不认；settings/ 等他路径零成本直过。
 */
function chapterIdOfWatcherFilename(filename: string): string | undefined {
  const normalized = filename.replace(/\\/g, '/');
  if (!normalized.startsWith('chapters/')) return undefined;
  const rest = normalized.slice('chapters/'.length);
  if (rest.length === 0 || rest.includes('/')) return undefined;
  if (!rest.toLowerCase().endsWith('.md')) return undefined;
  const stem = rest.slice(0, -3);
  return stem.length > 0 ? stem : undefined;
}

/** 链式入队（mirror reindexAllSettingMd inflight 惯例）：work 的错误被吞（warn）保证链不断。 */
function enqueueWork(projectDir: string, work: () => Promise<void>): void {
  const resolved = path.resolve(projectDir);
  const run = () =>
    work().catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectDir: resolved },
        'chapter chunk watcher: reindex work failed - continuing',
      );
    });
  const prior = inflight.get(resolved);
  const next = prior ? prior.then(run, run) : run();
  inflight.set(resolved, next);
  next.finally(() => {
    if (inflight.get(resolved) === next) inflight.delete(resolved);
  });
}

function scheduleFlush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
}

/** debounce 到点：取走 pending 集 → 串行逐章 reindex（或全量 rebuild）。全部 best-effort。 */
function flush(): void {
  debounceTimer = null;
  const projectDir = activeProjectDir;
  const chapterIds = [...pendingChapterIds].sort(); // 确定性序
  const fullRebuild = pendingFullRebuild;
  pendingChapterIds.clear();
  pendingFullRebuild = false;
  if (projectDir === null) return;
  if (chapterIds.length === 0 && !fullRebuild) return;

  enqueueWork(projectDir, async () => {
    // registry projectId（未注册 → 本轮跳过：项目没进 db 就没有可写行；项目打开 backfill 兜）。
    const projectId = getProject(path.resolve(projectDir))?.projectId;
    if (!projectId) {
      getLogger().warn(
        { projectDir },
        'chapter chunk watcher: project not registered - skipping reindex batch',
      );
      return;
    }
    if (fullRebuild) {
      // 全量 rebuild 覆盖逐章面（orphan 清理含内）——pending 章集是其子集，无需再逐章。
      await rebuildChapterChunks(projectId, projectDir);
      return;
    }
    for (const chapterId of chapterIds) {
      try {
        await reindexChapter(projectId, projectDir, chapterId);
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectId, chapterId },
          'chapter chunk watcher: per-chapter reindex failed - continuing',
        );
      }
    }
  });
}

/**
 * Start watching `projectDir` for `chapters/*.md` changes (recursive). Idempotent —
 * a second call while a watcher is live first stops the prior one (project switch
 * re-points the watcher, mirror the sibling watchers' single-active-watch contract).
 * An unsupported platform (Linux recursive watch) or transient failure degrades to
 * the open-project backfill scan (rebuildChapterChunks at the project:watch call
 * site) rather than crashing.
 */
export function startChapterChunkWatcher(projectDir: string): void {
  assertSafePath(projectDir);
  const resolved = path.resolve(projectDir);
  if (activeProjectDir === resolved && activeWatcher) return;

  stopChapterChunkWatcher();

  try {
    activeWatcher = watchDir(resolved, (_event, filename) => {
      try {
        if (filename === null) {
          // 平台省略 filename（rename 类事件，mirror settingMdWatcher F7/EDGE-3 保守分支）：
          // 识别不了章 → 全量 rebuild。取弃记档：全扫 400 章有 hash skip 兜底（纯内存分块 + 哈希
          // 对照，未变章零 embed），比漏索引一章便宜。
          pendingFullRebuild = true;
        } else {
          const chapterId = chapterIdOfWatcherFilename(filename);
          if (chapterId === undefined) return;
          pendingChapterIds.add(chapterId);
        }
        scheduleFlush();
      } catch (err) {
        // 红线：watcher 事件处理失败不阻流程（下一事件 / backfill 兜）。
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectDir: resolved },
          'chapter chunk watcher: event handling failed - continuing',
        );
      }
    });
    activeProjectDir = resolved;
    activeWatcher.on('error', (err) => {
      getLogger().warn(
        { projectDir: resolved, err: err instanceof Error ? err.message : String(err) },
        'chapter chunk watcher error',
      );
      stopChapterChunkWatcher();
    });
    getLogger().info({ projectDir: resolved }, 'chapter chunk watcher started');
  } catch (err) {
    // Recursive watch unsupported (e.g. Linux) or transient failure: degrade to the
    // open-project backfill scan rather than crashing (mirror the sibling watchers).
    getLogger().warn(
      { projectDir: resolved, err: err instanceof Error ? err.message : String(err) },
      'chapter chunk watcher unavailable - open-project backfill + summary-linked reindex still work',
    );
    activeWatcher = null;
    activeProjectDir = null;
  }
}

/**
 * Stop watching + clear any pending debounced flush. Safe to call when no watcher
 * is active. Called on project close/switch (alongside stopSettingMdWatcher) and on
 * app quit so no fs watcher / timer outlives the active project / the process.
 */
export function stopChapterChunkWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingChapterIds.clear();
  pendingFullRebuild = false;
  if (activeWatcher) {
    try {
      activeWatcher.close();
    } catch {
      // ignore close errors
    }
    activeWatcher = null;
    activeProjectDir = null;
  }
}
