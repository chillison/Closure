import { useState, useMemo, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { DeleteConfirmDialog } from '../../features/model-settings/DeleteConfirmDialog';
import { deriveSessionBadge } from '../../shared/store/agentEvents';

type Props = { onClose: () => void };

/**
 * dogfood T1 Stage 3（design §5.4/§5.5，D3 + 徽标）：
 * - 切换二次确认弹窗退役（#47②）——切换**不再中断**在途 run，徽标（running /
 *   awaiting_confirm / awaiting_review）+ 行内停止钮接岗。
 * - 会话行徽标状态机（deriveSessionBadge：键控槽 + run 态派生）；运行中行常显停止钮
 *   （后台 run 可从列表停——abortAgentRun(sessionId)）。
 */
export function AgentHistory({ onClose }: Props) {
  const {
    sessions, switchAgentSession, deleteAgentSession, resolvedLocale, agentSessionId,
    agentRunStates, pendingToolConfirmBySession, pendingDiffsBySession,
    pendingPatchBySession, pausedReviewBySession, draftSession, loadAgentSessions,
  } = useAppStore(useShallow((s) => ({
    // 注：键控记录直选（引用稳定）；徽标派生放 useMemo——嵌套新对象进 useShallow 返回值
    // 会破浅比较（新 {} 每次不等 → 无限重渲，React getSnapshot 环）。
    sessions: s.agentSessions,
    switchAgentSession: s.switchAgentSession,
    deleteAgentSession: s.deleteAgentSession,
    resolvedLocale: s.resolvedLocale,
    agentSessionId: s.agentSessionId,
    agentRunStates: s.agentRunStates,
    pendingToolConfirmBySession: s.pendingToolConfirmBySession,
    pendingDiffsBySession: s.pendingDiffsBySession,
    pendingPatchBySession: s.pendingPatchBySession,
    pausedReviewBySession: s.pausedReviewBySession,
    draftSession: s.draftSession,
    loadAgentSessions: s.loadAgentSessions,
  })));
  const { t } = useI18n(resolvedLocale);

  // dogfood R2 #14：任一会话 run 结束（running 集合收缩）→ 刷新列表一次——开着的历史
  // 面板对 updated_at 重排 / messageCount / 标题实时可见（旧实现只在面板挂载时拉一次）。
  const prevRunningRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const running = new Set(
      Object.entries(agentRunStates)
        .filter(([, r]) => r.phase === 'running')
        .map(([id]) => id),
    );
    const anyFinished = [...prevRunningRef.current].some((id) => !running.has(id));
    prevRunningRef.current = running;
    if (anyFinished) void loadAgentSessions();
  }, [agentRunStates, loadAgentSessions]);

  // 徽标派生（deriveSessionBadge：键控槽 + run 态 → 三态状态机）。
  const badges = useMemo(() => {
    const out: Record<string, ReturnType<typeof deriveSessionBadge>> = {};
    for (const sess of sessions) out[sess.id] = deriveSessionBadge({
      agentRunStates,
      pendingToolConfirmBySession,
      pendingDiffsBySession,
      pendingPatchBySession,
      pausedReviewBySession,
    }, sess.id);
    return out;
  }, [sessions, agentRunStates, pendingToolConfirmBySession, pendingDiffsBySession, pendingPatchBySession, pausedReviewBySession]);

  // dogfood #46：原 window.confirm 是 Windows 原生弹窗，与应用自绘确认框不统一——
  // 换 DeleteConfirmDialog（alertdialog 模式，同模型删除确认）。删除确认保留（不可逆动作）。
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);

  const badgeLabel = (badge: ReturnType<typeof deriveSessionBadge>): string =>
    badge === 'running' ? t('agent.badgeRunning')
      : badge === 'awaiting_confirm' ? t('agent.badgeAwaitingConfirm')
        : badge === 'awaiting_review' ? t('agent.badgeAwaitingReview')
          : '';

  const stopBackgroundRun = (sessionId: string) => {
    void window.orisonDesktop.abortAgentRun(sessionId);
  };

  return (
    <div className="agent-history">
      <div className="agent-history-header">
        <span>{t('agent.history')}</span>
        <button type="button" className="agent-panel-icon-btn" onClick={onClose}>
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="agent-history-list">
        {/* R2 #14：懒建语义的可见化——点「新会话」后当前视图即草稿，列表顶部给占位行
            （active 高亮、不可点——当前就在这；首条消息发出后由真条目接替）。 */}
        {draftSession && !agentSessionId && (
          <div className="agent-history-item is-active">
            <span className="agent-history-item-btn agent-history-item-btn--draft">
              <span className="agent-history-item-title">{t('agent.draftSession')}</span>
              <span className="agent-history-item-meta">{t('agent.draftSessionMeta')}</span>
            </span>
          </div>
        )}
        {sessions.length === 0 && !draftSession && (
          <div className="agent-history-empty">{t('agent.noHistory')}</div>
        )}
        {sessions.map((s) => {
          const badge = badges[s.id] ?? 'idle';
          return (
          <div key={s.id} className={`agent-history-item${s.id === agentSessionId ? ' is-active' : ''}`}>
            <button
              type="button"
              className="agent-history-item-btn"
              // D3：切换不中断在途 run（原 agentLoading 二次确认弹窗退役）。
              onClick={() => {
                switchAgentSession(s.id);
                onClose();
              }}
            >
              <span className="agent-history-item-title">{s.title || 'Untitled'}</span>
              <span className="agent-history-item-meta">
                {new Date(s.updatedAt).toLocaleDateString()} · {s.messageCount} msgs
              </span>
            </button>
            {badge !== 'idle' && (
              <span className={`agent-history-badge agent-history-badge--${badge}`} title={badgeLabel(badge)}>
                <span className="agent-history-badge-dot" aria-hidden="true" />
                <span className="agent-history-badge-label">{badgeLabel(badge)}</span>
              </span>
            )}
            {badge === 'running' && (
              <button
                type="button"
                className="agent-history-item-stop"
                onClick={() => stopBackgroundRun(s.id)}
                title={t('agent.stop')}
                aria-label={t('agent.stop')}
              >
                <span className="material-symbols-outlined">stop</span>
              </button>
            )}
            <button
              type="button"
              className="agent-history-item-delete"
              onClick={() => setPendingDelete({ id: s.id, title: s.title || 'Untitled' })}
              title={t('agent.deleteSession')}
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </div>
          );
        })}
      </div>

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        title={t('agent.deleteSession')}
        description={pendingDelete ? t('agent.deleteSessionConfirm', { title: pendingDelete.title }) : ''}
        confirmLabel={t('agent.deleteSessionAction')}
        cancelLabel={t('projects.cancel')}
        onConfirm={() => {
          if (pendingDelete) deleteAgentSession(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
