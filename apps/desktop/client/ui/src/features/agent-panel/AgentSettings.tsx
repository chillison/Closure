import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { ASK_CATEGORY_OPTIONS, GEAR_OPTIONS } from './gearMeta';
import type { BalancedAskCategory } from '@orison/shared-contracts';

type Props = { onClose: () => void };

export function AgentSettings({ onClose }: Props) {
  const {
    resolvedLocale, skillPackages, skillPackagesLoading,
    loadSkillPackages, toggleSkillPackage, toggleSkill,
    agentParticipationGear, agentBalancedAskCategories, agentTrustAdjudication,
    setAgentParticipationGear, activeSessionRunning,
  } = useAppStore(useShallow((s) => ({
    resolvedLocale: s.resolvedLocale,
    skillPackages: s.skillPackages,
    skillPackagesLoading: s.skillPackagesLoading,
    loadSkillPackages: s.loadSkillPackages,
    toggleSkillPackage: s.toggleSkillPackage,
    toggleSkill: s.toggleSkill,
    // Story 3.5: participation gear full settings (design §2.1 三入口之二 —
    // quick switch lives in the AgentPanel header, chat command is the third).
    agentParticipationGear: s.agentParticipationGear,
    agentBalancedAskCategories: s.agentBalancedAskCategories,
    agentTrustAdjudication: s.agentTrustAdjudication,
    setAgentParticipationGear: s.setAgentParticipationGear,
    activeSessionRunning: s.activeSessionRunning,
  })));

  const { t } = useI18n(resolvedLocale);
  const [expandedPkg, setExpandedPkg] = useState<string | null>(null);

  useEffect(() => { void loadSkillPackages(); }, [loadSkillPackages]);

  const gearDisabled = activeSessionRunning;
  const toggleCategory = (category: BalancedAskCategory, checked: boolean) => {
    const next = checked
      ? [...agentBalancedAskCategories, category]
      : agentBalancedAskCategories.filter((c) => c !== category);
    // Keep the contract's declared order for stable storage/diff.
    const ordered = ASK_CATEGORY_OPTIONS.map((o) => o.value).filter((v) => next.includes(v));
    // CR-011：禁取消最后一项（mirror zod .min(1)——空数组不属任一状态，致 balanced 静默永不问）。
    if (ordered.length === 0) return;
    setAgentParticipationGear(agentParticipationGear, { balancedAskCategories: ordered });
  };

  return (
    <div className="agent-settings">
      <div className="agent-settings-header">
        <span className="agent-settings-title">{t('agent.settings')}</span>
        <button type="button" className="agent-panel-icon-btn" onClick={onClose}>
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="agent-settings-body">
        {/* Story 3.5: participation gear section (smart/steer/balanced/hands_off) */}
        <div className="agent-settings-section">
          <div className="agent-settings-section-title">{t('agent.gearTitle')}</div>
          <p className="agent-settings-note">{t('agent.gearSettingsHint')}</p>
          <div className="agent-settings-gear-grid">
            {GEAR_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={`agent-settings-gear-option${agentParticipationGear === o.value ? ' is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="agent-participation-gear"
                  value={o.value}
                  checked={agentParticipationGear === o.value}
                  disabled={gearDisabled}
                  onChange={() => setAgentParticipationGear(o.value)}
                />
                <span>{t(o.i18nKey)}</span>
              </label>
            ))}
          </div>
          {/* balanced 档圈类别（仅 balanced 档语义相关时显示） */}
          {agentParticipationGear === 'balanced' && (
            <div className="agent-settings-gear-cats">
              <div className="agent-settings-subtitle">{t('agent.gearAskCategories')}</div>
              {ASK_CATEGORY_OPTIONS.map((o) => (
                <label key={o.value} className="agent-settings-cat-row">
                  <input
                    type="checkbox"
                    checked={agentBalancedAskCategories.includes(o.value)}
                    disabled={gearDisabled}
                    onChange={(e) => toggleCategory(o.value, e.target.checked)}
                  />
                  <span>{t(o.i18nKey)}</span>
                </label>
              ))}
            </div>
          )}
          {/* hands_off 档灰区处置（仅 hands_off 档语义相关时显示） */}
          {agentParticipationGear === 'hands_off' && (
            <div className="agent-settings-gear-trust">
              <label className="agent-settings-cat-row">
                <input
                  type="checkbox"
                  checked={agentTrustAdjudication}
                  disabled={gearDisabled}
                  onChange={(e) => setAgentParticipationGear('hands_off', { trustAdjudication: e.target.checked })}
                />
                <span>{t('agent.gearTrustAdjudication')}</span>
              </label>
              <p className="agent-settings-note">{t('agent.gearTrustAdjudicationHint')}</p>
            </div>
          )}
        </div>

        {/* Skills section */}
        <div className="agent-settings-section">
          <div className="agent-settings-section-title">{t('agent.skills')}</div>
          {skillPackagesLoading && (
            <div className="agent-settings-placeholder">{t('agent.loading')}</div>
          )}
          {!skillPackagesLoading && skillPackages.length === 0 && (
            <div className="agent-settings-placeholder">{t('agent.noSkillPackages')}</div>
          )}
          {skillPackages.map((pkg) => (
            <div key={pkg.name} className="agent-settings-pkg">
              <div className="agent-settings-pkg-row">
                <button
                  type="button"
                  className="agent-settings-pkg-expand"
                  onClick={() => setExpandedPkg(expandedPkg === pkg.name ? null : pkg.name)}
                >
                  <span className="material-symbols-outlined">
                    {expandedPkg === pkg.name ? 'expand_more' : 'chevron_right'}
                  </span>
                </button>
                <span className="agent-settings-pkg-name">{pkg.name}</span>
                <span className="agent-settings-pkg-count">{pkg.skills.length}</span>
                <label className="agent-toggle">
                  <input
                    type="checkbox"
                    checked={pkg.enabled}
                    onChange={(e) => toggleSkillPackage(pkg.name, e.target.checked)}
                  />
                  <span className="agent-toggle-track" />
                </label>
              </div>
              {expandedPkg === pkg.name && (
                <div className="agent-settings-skills-list">
                  {pkg.skills.map((sk) => (
                    <div key={sk.name} className="agent-settings-skill-row">
                      <span className="agent-settings-skill-name">{sk.name}</span>
                      {sk.description && (
                        <span className="agent-settings-skill-desc">{sk.description}</span>
                      )}
                      <label className="agent-toggle agent-toggle-sm">
                        <input
                          type="checkbox"
                          checked={sk.enabled}
                          disabled={!pkg.enabled}
                          onChange={(e) => toggleSkill(pkg.name, sk.name, e.target.checked)}
                        />
                        <span className="agent-toggle-track" />
                      </label>
                    </div>
                  ))}
                </div>
              )}
              <div className="agent-settings-pkg-path">{pkg.path}</div>
            </div>
          ))}
        </div>

        {/* MCP section */}
        <div className="agent-settings-section">
          <div className="agent-settings-section-title">{t('agent.mcp')}</div>
          <div className="agent-settings-placeholder">{t('agent.comingSoon')}</div>
        </div>

        {/* Plugins section */}
        <div className="agent-settings-section">
          <div className="agent-settings-section-title">{t('agent.plugins')}</div>
          <div className="agent-settings-placeholder">{t('agent.comingSoon')}</div>
        </div>
      </div>
    </div>
  );
}
