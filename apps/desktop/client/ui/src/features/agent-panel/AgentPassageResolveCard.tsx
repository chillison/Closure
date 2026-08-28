import { useAppStore } from '../../shared/store/appStore';
import { useShallow } from 'zustand/react/shallow';
import { useI18n } from '../../shared/i18n/useI18n';

/**
 * Candidate-location confirm card for a passage rewrite that could not be
 * applied automatically — either the original text drifted (not-found) or it
 * matched several spots (ambiguous). Rendered above AgentInput, mirroring
 * AgentConfirmCard. The state machine lives in agentDiffSlice.
 *
 * dogfood T1 Stage 3（r8 键控）：只渲染当前视图会话的 resolve 卡；动作按卡所属会话发。
 */
export function AgentPassageResolveCard() {
  const { sessionId, resolve, resolvePassageAt, cancelPassageResolve, resolvedLocale } = useAppStore(useShallow((s) => ({
    sessionId: s.agentSessionId,
    resolve: s.agentSessionId ? s.pendingPassageResolveBySession[s.agentSessionId] : undefined,
    resolvePassageAt: s.resolvePassageAt,
    cancelPassageResolve: s.cancelPassageResolve,
    resolvedLocale: s.resolvedLocale,
  })));
  const { t } = useI18n(resolvedLocale);

  if (!resolve || !sessionId) return null;

  const heading = resolve.reason === 'ambiguous'
    ? t('agent.relocateAmbiguous')
    : t('agent.relocateNotFound');

  return (
    <div className="agent-passage-resolve-card">
      <div className="agent-passage-resolve-header">
        <span className="material-symbols-outlined">my_location</span>
        <span>{heading}</span>
      </div>

      {resolve.candidates.length === 0 ? (
        <div className="agent-passage-resolve-empty">{t('agent.noCandidates')}</div>
      ) : (
        <ul className="agent-passage-resolve-list">
          {resolve.candidates.map((c, i) => (
            <li key={`${c.from}-${c.to}-${i}`} className="agent-passage-resolve-item">
              <span className="agent-passage-resolve-excerpt">{c.excerpt}</span>
              <button
                type="button"
                className="agent-passage-resolve-btn"
                onClick={() => resolvePassageAt(sessionId, resolve.diffId, i)}
              >
                {t('agent.useThisLocation')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="agent-passage-resolve-actions">
        <button type="button" className="agent-passage-resolve-cancel" onClick={() => cancelPassageResolve(sessionId)}>
          {t('agent.cancel')}
        </button>
      </div>
    </div>
  );
}
