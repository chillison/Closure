import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';

/**
 * Story 1.5 Phase B (design §1.1 / prd R4): empty state for the structure page
 * when scene_graph is absent/empty. The timeline is *derived* from scene_graph,
 * so there is nothing to render until story-planner produces one.
 * The CTA opens the AgentPanel for conversation; it does NOT run story-planner (Epic 4 / ADR-17). Zero
 * fabrication (落地公理): no skeleton rows/placeholder graph.
 */
export function TimelineEmptyState() {
  const { resolvedLocale, setAgentPanelOpen } = useAppStore(useShallow((s) => ({
    resolvedLocale: s.resolvedLocale,
    setAgentPanelOpen: s.setAgentPanelOpen,
  })));
  const { t } = useI18n(resolvedLocale);

  return (
    <div className="structure-empty">
      <span className="material-symbols-outlined structure-empty-icon" aria-hidden="true">account_tree</span>
      <h2 className="structure-empty-title">{t('structure.emptyTitle')}</h2>
      <p className="structure-empty-desc">{t('structure.emptyDesc')}</p>
      <button
        type="button"
        className="structure-empty-cta"
        onClick={() => setAgentPanelOpen(true)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">smart_toy</span>
        {t('structure.emptyCta')}
      </button>
    </div>
  );
}
