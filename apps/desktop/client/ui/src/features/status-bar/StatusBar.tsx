import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { AUTOSAVE_RETRY_EVENT } from '../../shared/hooks/useAutoSave';
import { gitStatusCount, gitCreateNode, gitIsRepo } from '../../shared/api/git';

function formatSavedAt(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

export function StatusBar() {
  const {
    activeSessionRunning,
    agentSessionId,
    activeFilePath,
    openFiles,
    resolvedLocale,
    activePage,
    saveStatus,
    lastSavedAt,
    projectPath,
  } = useAppStore(useShallow((s) => ({
    activeSessionRunning: s.activeSessionRunning,
    agentSessionId: s.agentSessionId,
    activeFilePath: s.activeFilePath,
    openFiles: s.openFiles,
    resolvedLocale: s.resolvedLocale,
    activePage: s.activePage,
    saveStatus: s.saveStatus,
    lastSavedAt: s.lastSavedAt,
    projectPath: s.currentProject?.path ?? null,
  })));

  const { t } = useI18n(resolvedLocale);

  const activeFile = openFiles.find((f) => f.path === activeFilePath);

  const agentStatus = activeSessionRunning
    ? t('statusBar.agentRunning')
    : agentSessionId
      ? t('statusBar.agentIdle')
      : '';

  // Git dirty count
  const [dirtyCount, setDirtyCount] = useState(0);
  const [showCommitInput, setShowCommitInput] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    setDirtyCount(0);
    // dogfood R2 #1：未开版本管理是合法状态（Timeline opt-in）——先探 repo 再起轮询
    //（mirror OverviewPage:176-182 守卫先例），否则非 repo 项目每 30s 一条主进程
    // NotFoundError WARN + 无效 IPC。批次 0 落「新建项目自动开版本管理」后仅存量项目
    // 走此分支。
    void gitIsRepo(projectPath).then((isRepo) => {
      if (cancelled || !isRepo) return;
      const poll = () => {
        gitStatusCount(projectPath).then((n) => { if (!cancelled) setDirtyCount(n); });
      };
      poll();
      // gitStatusCount runs isomorphic-git statusMatrix — a full working-tree
      // scan on the main process. Polling every 5s was a recurring stall on large
      // repos; 30s is frequent enough for a dirty-count badge. (Event-driven
      // refresh off the project watcher is the longer-term improvement.)
      intervalId = setInterval(poll, 30000);
    });
    return () => { cancelled = true; if (intervalId) clearInterval(intervalId); };
  }, [projectPath]);

  const handleSaveVersion = useCallback(async () => {
    if (!projectPath || !commitMsg.trim()) return;
    await gitCreateNode(projectPath, commitMsg.trim());
    setCommitMsg('');
    setShowCommitInput(false);
    setDirtyCount(0);
  }, [projectPath, commitMsg]);

  const retrySave = () => {
    window.dispatchEvent(new Event(AUTOSAVE_RETRY_EVENT));
  };

  const renderSaveStatus = () => {
    if (saveStatus === 'saving') {
      return (
        <span className="status-bar-item status-bar-save is-saving">
          <span className="material-symbols-outlined status-bar-save-icon">sync</span>
          {t('statusBar.saving')}
        </span>
      );
    }
    if (saveStatus === 'error') {
      return (
        <button
          type="button"
          className="status-bar-item status-bar-save status-bar-save-retry is-error"
          onClick={retrySave}
          title={t('statusBar.saveRetry')}
        >
          <span className="material-symbols-outlined status-bar-save-icon">error</span>
          {t('statusBar.saveFailed')}
        </button>
      );
    }
    if (saveStatus === 'saved' && lastSavedAt != null) {
      return (
        <span className="status-bar-item status-bar-save is-saved">
          <span className="material-symbols-outlined status-bar-save-icon">cloud_done</span>
          {t('statusBar.savedAt', { time: formatSavedAt(lastSavedAt, resolvedLocale) })}
        </span>
      );
    }
    return null;
  };

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {!activeFile && (
          <span className="status-bar-item status-bar-page">{activePage}</span>
        )}
        {projectPath && dirtyCount > 0 && !showCommitInput && (
          <button
            type="button"
            className="status-bar-item status-bar-git-dirty"
            onClick={() => setShowCommitInput(true)}
            title={t('statusBar.saveVersion')}
          >
            <span className="material-symbols-outlined">commit</span>
            {t('statusBar.changes', { n: String(dirtyCount) })}
          </button>
        )}
        {showCommitInput && (
          <span className="status-bar-item status-bar-commit-input">
            <input
              type="text"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSaveVersion();
                if (e.key === 'Escape') setShowCommitInput(false);
              }}
              placeholder={t('timeline.nodeMessage')}
              autoFocus
            />
            <button type="button" disabled={!commitMsg.trim()} onClick={() => void handleSaveVersion()}>
              <span className="material-symbols-outlined">check</span>
            </button>
            <button type="button" onClick={() => setShowCommitInput(false)}>
              <span className="material-symbols-outlined">close</span>
            </button>
          </span>
        )}
      </div>
      <div className="status-bar-right">
        {renderSaveStatus()}
        {agentStatus && (
          <span className={`status-bar-item status-bar-agent${activeSessionRunning ? ' is-running' : ''}`}>
            <span className="material-symbols-outlined status-bar-agent-icon">smart_toy</span>
            {agentStatus}
          </span>
        )}
      </div>
    </div>
  );
}
