/**
 * useToolEvents — listens for tool execution events pushed from Shell
 * and dispatches a custom DOM event so components can react.
 * Also handles file:changed events by reloading affected open tabs, and
 * surfaces a conflict when a file changes on disk under unsaved edits.
 */
import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { useToastStore } from '../store/toastStore';
import { translate } from '../i18n/useI18n';
import { normalizePath } from '../utils/paths';
import { deriveChaptersFromDisk } from '../store/chapterDiskDerivation';
import { refreshProjectDocument } from '../store/projectSubscription';

const MARKDOWN_EXT = /\.md$/i;

export function useToolEvents() {
  useEffect(() => {
    const api = (window as any).orisonDesktop;
    if (!api?.onToolEvent) return;

    // Coalesce bursts of writes (e.g. auto-mode generating many chapters) into a
    // single project-wide rescan instead of one full scan per file.
    let wordCountTimer: ReturnType<typeof setTimeout> | null = null;
    let chapterRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let outlineRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleWordCountRefresh = () => {
      if (wordCountTimer !== null) clearTimeout(wordCountTimer);
      wordCountTimer = setTimeout(() => {
        wordCountTimer = null;
        void useAppStore.getState().refreshWordCount();
      }, 400);
    };
    const scheduleChapterRefresh = () => {
      if (chapterRefreshTimer !== null) clearTimeout(chapterRefreshTimer);
      chapterRefreshTimer = setTimeout(() => {
        chapterRefreshTimer = null;
        const state = useAppStore.getState();
        const projectPath = state.currentProject?.path;
        if (!projectPath) return;
        void deriveChaptersFromDisk(projectPath, state.novelChapters)
          .then((chapters) => {
            const latest = useAppStore.getState();
            if (latest.currentProject?.path !== projectPath) return;
            latest.setNovelChapters(chapters);
          })
          .catch(() => {});
      }, 300);
    };

    // dogfood R2 #77：agent 写 project.yaml 后 UI 不自愈（要重开项目才见）——盘是单一
    // 真相源，纯时间序 last-write-wins（不按写入方身份分优先级，用户拍板）。shell 在
    // saveProject 落盘后推 outline:changed（守卫在上方 project-match 门）；此处 300ms
    // trailing debounce（同秒多字段写合并成一次文档重拉，mirror scheduleChapterRefresh
    // 风格）→ refreshProjectDocument 增量刷新（hydrate:false，不动 tab 布局/水合旗标）。
    // 刻意不碰 pendingPatch 审核卡：接受 = 更晚的用户裁定写，按时间序合法胜出
    // （syncField REPLACE 幂等），与本刷新是同一 last-write-wins 序，无冲突语义。
    const scheduleOutlineRefresh = () => {
      if (outlineRefreshTimer !== null) clearTimeout(outlineRefreshTimer);
      outlineRefreshTimer = setTimeout(() => {
        outlineRefreshTimer = null;
        const projectPath = useAppStore.getState().currentProject?.path;
        if (!projectPath) return;
        void refreshProjectDocument(useAppStore, projectPath, { hydrate: false });
      }, 300);
    };

    // Reconcile a single open tab against its on-disk file. Reads the file and
    // compares to the tab's saved content so our OWN writes (disk === saved) are
    // ignored. Genuine external edits: clean tab → silent reload; dirty tab →
    // conflict banner. Missing file → external-delete flag.
    const reconcileTab = async (fullPath: string) => {
      const state = useAppStore.getState();
      const tab = state.openFiles.find((f) => f.path === fullPath);
      if (!tab || tab.kind !== 'text') return;
      let disk: string | null | undefined;
      try {
        disk = await api.readFile(fullPath);
      } catch {
        return;
      }
      if (typeof disk !== 'string') {
        // File no longer readable (deleted/moved). Only flag if the tab has
        // unsaved work worth warning about; otherwise leave it (tree refresh
        // handles the listing) so a transient read race doesn't nag the user.
        const latest = useAppStore.getState();
        const latestTab = latest.openFiles.find((file) => file.path === fullPath);
        if (latestTab && latestTab.content !== latestTab.savedContent) {
          latest.markExternalChange(fullPath, 'deleted');
        }
        return;
      }
      state.reconcileExternalFile(fullPath, disk, tab.savedContent);
    };

    const unsubscribe = api.onToolEvent((event: { type: string; [key: string]: unknown }) => {
      const eventProjectPath = typeof event.projectPath === 'string'
        ? normalizePath(event.projectPath)
        : null;
      if (!eventProjectPath) return;

      // quarantine-notify（2026-08-27）：loadProject 判腐隔离 → 通知中心持久通知。
      // 与其他 tool:event 不同，本事件是「某工程的 project.yaml 被改名」的会话级事实，
      // 必须先于 current-project 匹配守卫处理——冷启动 project:list-registered 的隔离
      // 发生在任何工程打开之前（currentProject 仍为 null），走守卫会被吞掉（08-27
      // 事故形态：空白工程零提示）。通知中心按 key（工程路径）去重，AC2 防重。
      if (event.type === 'project:quarantined') {
        pushQuarantineNotification(event, eventProjectPath);
        return;
      }

      const currentProjectPath = useAppStore.getState().currentProject?.path;
      if (
        !currentProjectPath
        || normalizePath(currentProjectPath) !== eventProjectPath
      ) {
        return;
      }
      window.dispatchEvent(new CustomEvent('orison:tool-event', { detail: event }));

      // 风格卡片 MVP（08-28 C 路）：leader request_style_input 工具 → 风格片段对话框弹出。
      // 事件带 projectPath 已过上方 current-project 匹配守卫；store 内幂等（已开不重置）。
      if (event.type === 'style_input_requested') {
        const prompt = typeof event.prompt === 'string' && event.prompt.length > 0
          ? event.prompt
          : undefined;
        useAppStore.getState().requestStyleInput(prompt);
        return;
      }

      if (event.type === 'file:changed') {
        const state = useAppStore.getState();
        const projectPath = state.currentProject?.path;
        // Prefer the concrete changed-path list; fall back to the single `path`.
        const rels: string[] = Array.isArray(event.paths) && event.paths.length > 0
          ? (event.paths as string[])
          : (typeof event.path === 'string' && event.path ? [event.path as string] : []);
        for (const rel of rels) {
          const fullPath = projectPath ? normalizePath(`${projectPath}/${rel}`) : rel;
          // Only touch files actually open as tabs.
          if (state.openFiles.some((f) => f.path === fullPath)) {
            void reconcileTab(fullPath);
          }
        }
        if (projectPath && rels.some((rel) => isChapterMarkdownPath(rel, projectPath))) {
          scheduleChapterRefresh();
        }
      }

      // Any on-disk content change can move the project word count; refresh the
      // aggregate so the overview stays accurate even while it is mounted.
      if (event.type === 'file:changed' || event.type === 'chapter:changed') {
        scheduleWordCountRefresh();
      }
      if (event.type === 'chapter:changed') {
        scheduleChapterRefresh();
      }

      // dogfood R2 #77：creative fields 文档（project.yaml）落盘后收敛刷新（见上方
      // scheduleOutlineRefresh 注释——debounce 合并 + refreshProjectDocument 增量模式）。
      if (event.type === 'outline:changed') {
        scheduleOutlineRefresh();
      }

      // Story 2.7 C段: setting-card (asset_cards) backfill / watcher outcome.
      // The shell emits `closure:indexed` (kind 'asset_cards', project-scoped —
      // passes the project-match guard above) when the fire-and-forget reindex
      // completes. success+count>0 → toast; error → toast; count===0 (incremental
      // save, nothing indexed) stays silent so it never spams on every save.
      // Manual rebuilds return synchronous typed results handled in the slice.
      if (event.type === 'closure:indexed') {
        const locale = useAppStore.getState().resolvedLocale ?? 'en-US';
        const count = typeof event.count === 'number' ? event.count : 0;
        if (event.status === 'error') {
          const reason = typeof event.message === 'string' ? event.message : '';
          useToastStore
            .getState()
            .showToast(translate(locale, 'kbIndex.indexedError', { reason }), 'error');
        } else if (count > 0) {
          useToastStore
            .getState()
            .showToast(translate(locale, 'kbIndex.indexedSuccess', { n: count }), 'success');
        }
      }
    });

    return () => {
      if (wordCountTimer !== null) clearTimeout(wordCountTimer);
      if (chapterRefreshTimer !== null) clearTimeout(chapterRefreshTimer);
      if (outlineRefreshTimer !== null) clearTimeout(outlineRefreshTimer);
      unsubscribe();
    };
  }, []);
}

function isChapterMarkdownPath(path: string, projectPath: string): boolean {
  const normalized = normalizePath(path);
  const project = normalizePath(projectPath).replace(/\/+$/, '');
  const relative = normalized.startsWith(`${project}/`)
    ? normalized.slice(project.length + 1)
    : normalized.replace(/^\/+/, '');
  return relative.startsWith('chapters/') && MARKDOWN_EXT.test(relative);
}

/**
 * quarantine-notify（2026-08-27）：把 shell 推来的判腐隔离事实写进通知中心
 * （复用既有 pushNotification API；通知持久——读过之前不清失，由用户手动清除）。
 * 文案双语经 i18n（notifications.* 族），备份文件名取 basename 内插。
 * 同一工程一次会话只发一条：通知中心 key 去重（project-quarantine:<路径>）。
 */
function pushQuarantineNotification(event: { [key: string]: unknown }, projectPath: string): void {
  const state = useAppStore.getState();
  const locale = state.resolvedLocale ?? 'en-US';
  const backupPath = typeof event.backupPath === 'string' ? event.backupPath : null;
  const reason = typeof event.reason === 'string' ? event.reason : '';
  const recovered = event.recovered === true;
  const backupName = backupPath ? backupPath.split(/[\\/]/).pop() : null;
  // 三态文案：无备份（改名失败，原文件原位）/ 抢救成功打开 / 空工程重建打开（PRD 主文案）。
  const bodyKey =
    backupName == null
      ? 'notifications.quarantineBodyNoBackup'
      : recovered
        ? 'notifications.quarantineBodyRecovered'
        : 'notifications.quarantineBodyEmpty';
  state.pushNotification(
    translate(locale, 'notifications.quarantineTitle'),
    translate(locale, bodyKey, backupName != null ? { backup: backupName } : { reason }),
    'warning',
    `project-quarantine:${projectPath}`,
  );
}
