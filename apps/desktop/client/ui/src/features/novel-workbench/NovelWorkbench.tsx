import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { isProjectRunActive } from '../../shared/store/agentSessionSlice';
import { useI18n } from '../../shared/i18n/useI18n';
import { ChapterActionsBar } from './ChapterActionsBar';
import { ChapterListPanel } from './ChapterListPanel';
import { ChapterResultPanel } from './ChapterResultPanel';

/**
 * Story 3.4 Phase 3.3：工作台「检查改动影响」affordance（chat-first，mirror ChapterListPanel:65 按钮）。
 *
 * 涟漪诊断的对话主入口——作者点此按钮 → sendAgentMessage → leader runLoop 凭 buildInteractionModeSegment
 * 的 stale 待诊断段引导调 diagnose_impacts tool。按钮是 affordance 非必需——作者也可直接在对话说
 * 「检查改动影响」，leader 同样据 segment 段调 tool。
 *
 * autonomy 轴：V1 手动触发（按钮 + chat）；全权模式自动触发 option 归 TODO（安全起见 leader 自检 stale
 * 后调诊断，非每 turn 自动）。
 */
export function NovelWorkbench() {
  // dogfood T1 Stage 3（r8 三分）：工作台触发闸是**项目运行**语义（该项目任一会话在跑都禁——
  // D4 同项目单 run），非视图运行态。
  const { resolvedLocale, sendAgentMessage, projectRunActive } = useAppStore(
    useShallow((s) => ({
      resolvedLocale: s.resolvedLocale,
      sendAgentMessage: s.sendAgentMessage,
      projectRunActive: isProjectRunActive(s),
    })),
  );
  const { t } = useI18n(resolvedLocale);

  const handleCheckImpact = useCallback(() => {
    void sendAgentMessage(t('rippleImpact.checkImpactMessage'));
  }, [sendAgentMessage, t]);

  return (
    <div className="novel-workbench" aria-label="Novel Workbench">
      <aside className="novel-workbench-sidebar">
        <header className="novel-workbench-sidebar-header">
          <strong>{t('script.chapters')}</strong>
          <button
            type="button"
            className="novel-workbench-check-impact-btn"
            onClick={handleCheckImpact}
            disabled={projectRunActive}
            title={t('rippleImpact.checkImpact')}
            aria-label={t('rippleImpact.checkImpact')}
          >
            <span className="material-symbols-outlined">cached</span>
          </button>
        </header>
        <ChapterListPanel />
        {/* AutoModeConsole removed: the auto-mode execution engine was deleted
            with the Python agent chain (commit 820a969) and never replaced, so
            the console was a non-functional shell. Hidden until the engine is
            rebuilt — see docs/internal/auto-mode-rebuild-plan.md. */}
      </aside>

      <main className="novel-workbench-main">
        <ChapterActionsBar />
        <ChapterResultPanel />
      </main>
    </div>
  );
}
