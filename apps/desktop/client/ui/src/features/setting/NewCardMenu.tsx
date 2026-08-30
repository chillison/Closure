/**
 * 新建设定卡入口（task 08-30-asset-cards-visualization B 波 CRUD，design §5）。
 *
 * 按钮 + 8 类选择下拉菜单（schema 序）→ 骨架卡 append 落盘 + 选中进表单。工具栏与零卡
 * 空态双入口共用（variant 切换外观；空态「手动新建」CTA 同一菜单，W0 mockup 双 CTA 拍板）。
 *
 * 自含组件：卡数据读 store（raw 直读 + createCardSkeleton/appendCard 投影——新建流
 * 显式 append，CR P19 后与 replaceCardById 分离）；i18n 自订 resolvedLocale。
 * locked（field 级 asset_cards 锁）时禁用——落盘会被 onFieldEdited 拒（locked 检查）。
 */
import { useState } from 'react';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import {
  ASSET_CARD_TYPES,
  typeLabelKey,
  type AssetCardType,
} from './cardList';
import { appendCard, createCardSkeleton } from './formCardOps';

export function NewCardMenu({ variant = 'toolbar' }: { variant?: 'toolbar' | 'cta' }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const [open, setOpen] = useState(false);

  const createCard = (type: AssetCardType) => {
    setOpen(false);
    // 竞态安全：全经 getState 现取（菜单打开期间数据可能翻新）；骨架名走 i18n（AC7）。
    const state = useAppStore.getState();
    const rawCards = state.creativeFields.asset_cards;
    const skeleton = createCardSkeleton(type, t('settingPage.action.untitled'), rawCards);
    state.updateField('asset_cards', appendCard(rawCards, skeleton));
    state.selectSettingCard(skeleton.id);
  };

  // locked 读 field 级元数据（B4 同源）；锁态禁用入口。
  const locked = useAppStore((s) => s.fieldMetadata.asset_cards?.locked === true);

  const labelKey = variant === 'cta' ? 'settingPage.empty.ctaManual' : 'settingPage.toolbar.newCard';
  const buttonCls = variant === 'cta' ? 'setting-empty-cta' : 'setting-new-btn';

  return (
    <div
      className="setting-newmenu"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className={buttonCls}
        disabled={locked}
        aria-haspopup="menu"
        aria-expanded={open}
        data-setting-new-card
        onClick={() => { setOpen((v) => !v); }}
      >
        <span className="material-symbols-outlined" aria-hidden="true">add</span>
        {t(labelKey)}
      </button>
      {open && (
        <>
          {/* 透明背板收菜单（点击菜单外任意处关——jsdom/真机同路径，零 document listener） */}
          <button
            type="button"
            className="setting-newmenu-backdrop"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => { setOpen(false); }}
          />
          <div className="setting-newmenu-popover" role="menu" aria-label={t('settingPage.toolbar.newCard')}>
            {ASSET_CARD_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="menuitem"
                className="setting-newmenu-item"
                data-new-card-type={type}
                onClick={() => { createCard(type); }}
              >
                {t('settingPage.action.create', { type: t(typeLabelKey(type)) })}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
