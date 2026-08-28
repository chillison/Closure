import { useAppStore } from '../../shared/store/appStore';
import { useShallow } from 'zustand/react/shallow';
import { useI18n } from '../../shared/i18n/useI18n';

/**
 * dogfood T1 Stage 3（r8 键控）：只渲染**当前视图会话**（agentSessionId）的确认卡——后台
 * 会话的确认卡不漏进前台输入区（D3 落地的强制前置）。confirm/reject 按卡所属会话发
 * （sessionId 显式传参，agentDiffSlice 不再硬编码当前会话）。
 */
export function AgentConfirmCard() {
  const { sessionId, pending, confirm, reject, resolvedLocale } = useAppStore(useShallow((s) => ({
    sessionId: s.agentSessionId,
    pending: s.agentSessionId ? s.pendingToolConfirmBySession[s.agentSessionId] : undefined,
    confirm: s.confirmPendingTool,
    reject: s.rejectPendingTool,
    resolvedLocale: s.resolvedLocale,
  })));
  const { t } = useI18n(resolvedLocale);

  if (!pending || !sessionId) return null;

  return (
    <div className="agent-confirm-card">
      <div className="agent-confirm-card-header">
        <span className="material-symbols-outlined">warning</span>
        <span>{t('agent.confirm')}: <strong>{pending.name}</strong></span>
      </div>
      <pre className="agent-confirm-card-input">
        {JSON.stringify(pending.input, null, 2)}
      </pre>
      <div className="agent-confirm-card-actions">
        <button type="button" className="agent-confirm-btn agent-confirm-btn-accept" onClick={() => confirm(sessionId)}>
          {t('agent.accept')}
        </button>
        <button type="button" className="agent-confirm-btn agent-confirm-btn-reject" onClick={() => reject(sessionId)}>
          {t('agent.reject')}
        </button>
      </div>
    </div>
  );
}
