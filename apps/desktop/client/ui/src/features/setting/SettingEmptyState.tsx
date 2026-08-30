/**
 * 「设定」页零卡空态（A1 波；B 波接 CRUD）：居中「还没有任何设定卡」+ 双 CTA——「找 AI
 * 建」（打开工作台/Agent 面板，TimelineEmptyState 先例通道）/「手动新建」（B 波：NewCardMenu
 * 8 类选择菜单，与工具栏同入口）。零卡含旧项目无 asset_cards 键（Array.isArray 守卫天然
 * 给出，design §6/AC8）。零 fabrication（落地公理）：不渲染骨架行/假卡。
 */
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { NewCardMenu } from './NewCardMenu';

export function SettingEmptyState() {
  const { resolvedLocale, setAgentPanelOpen } = useAppStore(useShallow((s) => ({
    resolvedLocale: s.resolvedLocale,
    setAgentPanelOpen: s.setAgentPanelOpen,
  })));
  const { t } = useI18n(resolvedLocale);

  return (
    <div className="setting-empty">
      <span className="material-symbols-outlined setting-empty-icon" aria-hidden="true">menu_book</span>
      <h2 className="setting-empty-title">{t('settingPage.empty.title')}</h2>
      <div className="setting-empty-actions">
        <button
          type="button"
          className="setting-empty-cta"
          onClick={() => setAgentPanelOpen(true)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">smart_toy</span>
          {t('settingPage.empty.ctaAi')}
        </button>
        <NewCardMenu variant="cta" />
      </div>
    </div>
  );
}
