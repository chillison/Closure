/**
 * 「设定」页右列——未知/越界 type 卡的只读视图（A1 波；B 波集成后定稿为唯一职责）。
 *
 * B 波集成定稿：已知 8 类卡在 SettingPage 直渲染 CardForm（编辑面），**本组件只承接
 * 未知 type 卡**（防御态，mirror WorldStatePanel KNOWN_SUBJECT_TYPES 回落）：卡头信息
 * （name / id 只读灰字 / 组徽标 / tier 文案 / status 文案——tier 未标显结构默认 +
 * 「默认」角标）+ 只读 JSON pretty + 提示文案——不给编辑面（编辑写路对越界 type 会
 * parse 拒，research §3.5）。
 */
import {
  cardGroupKey,
  cardStatus,
  cardTier,
  typeLabelKey,
  type AssetCardRow,
} from './cardList';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function CardSummary({ card, t }: { card: AssetCardRow | null; t: Translate }) {
  // rows 非空时页面派生回落首行，null 不可达——防御渲染（不发明占位文案键）。
  if (card === null) return <div className="setting-summary setting-summary--none" />;

  const { tier, explicit } = cardTier(card);
  const status = cardStatus(card);

  return (
    <div className="setting-summary">
      <header className="setting-summary-head">
        <h2 className="setting-summary-name">{card.name}</h2>
        <span className="setting-summary-id">id: {card.id}</span>
        <span className="setting-badge setting-badge--type">{t(typeLabelKey(cardGroupKey(card.type)))}</span>
        <span className={`setting-badge setting-badge--tier setting-badge--tier-${tier}`}>
          {t(`settingPage.tier.${tier}`)}
          {!explicit && (
            <span className="setting-badge-default">{t('settingPage.tier.defaultBadge')}</span>
          )}
        </span>
        <span className={`setting-badge setting-badge--status setting-badge--status-${status}`}>
          {t(`settingPage.status.${status}`)}
        </span>
        {card.type.length > 0 && (
          <span className="setting-summary-rawtype">type: {card.type}</span>
        )}
      </header>

      <div className="setting-readonly">
        <p className="setting-readonly-hint">{t('settingPage.other.readonlyHint')}</p>
        <pre className="setting-readonly-json">{JSON.stringify(card.raw, null, 2)}</pre>
      </div>
    </div>
  );
}
