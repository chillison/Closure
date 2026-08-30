/**
 * 「设定」页左列卡列表（A1 波）：类型过滤 chips（计数）+ 按 type 分组的卡行。
 * 行 = name + tier 徽标（未标显结构默认 + 「默认」角标）+ status 徽标 + summary 单行截断。
 * 纯受控组件（props 传入零 store 直连——InsightCard 受控壳先例）；数据/过滤派生在
 * SettingPage（cardList.ts 纯函数），本组件只渲染。
 */
import {
  ASSET_CARD_TYPES,
  cardStatus,
  cardSummary,
  cardTier,
  typeLabelKey,
  type AssetCardRow,
  type SettingCardGroup,
  type CardGroupKey,
} from './cardList';
import type { SettingTypeFilter } from '../../shared/store/settingSlice';

/** i18n 译者面（useI18n.t 的结构类型——子组件 prop 传递用，WorldStatePanel 同款）。 */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** tier 徽标：显式标注直接用；未标显结构默认（resolveTier）+ 「默认」角标。 */
function TierBadge({ card, t }: { card: AssetCardRow; t: Translate }) {
  const { tier, explicit } = cardTier(card);
  return (
    <span className={`setting-badge setting-badge--tier setting-badge--tier-${tier}`}>
      {t(`settingPage.tier.${tier}`)}
      {!explicit && (
        <span className="setting-badge-default">{t('settingPage.tier.defaultBadge')}</span>
      )}
    </span>
  );
}

export function SettingCardList({ rows, filter, groups, counts, selectedId, onSelect, onFilter, t }: {
  rows: readonly AssetCardRow[];
  filter: SettingTypeFilter;
  groups: readonly SettingCardGroup[];
  counts: Map<CardGroupKey, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onFilter: (filter: SettingTypeFilter) => void;
  t: Translate;
}) {
  // chips = 全部 + 有卡的 8 类（schema 序）+ 其他（有未知/越界 type 卡才出现）。
  const chips: Array<{ key: SettingTypeFilter; labelKey: string; count: number }> = [
    { key: 'all', labelKey: 'settingPage.filter.all', count: rows.length },
    ...ASSET_CARD_TYPES
      .filter((type) => (counts.get(type) ?? 0) > 0)
      .map((type) => ({ key: type as SettingTypeFilter, labelKey: typeLabelKey(type), count: counts.get(type) ?? 0 })),
  ];
  if ((counts.get('other') ?? 0) > 0) {
    chips.push({ key: 'other', labelKey: typeLabelKey('other'), count: counts.get('other') ?? 0 });
  }

  return (
    <div className="setting-list">
      <div className="setting-chips" role="group">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={`setting-chip${filter === chip.key ? ' is-on' : ''}`}
            aria-pressed={filter === chip.key}
            data-setting-filter={chip.key}
            onClick={() => onFilter(chip.key)}
          >
            {t(chip.labelKey)}
            <span className="setting-chip-count">{chip.count}</span>
          </button>
        ))}
      </div>
      <div className="setting-groups">
        {groups.length === 0 && (
          // 过滤/搜索无匹配（B6）：rows 非空但当前组合筛出零行——显提示，不静默空白。
          <p className="setting-list-empty" data-setting-no-match>{t('settingPage.filter.noMatch')}</p>
        )}
        {groups.map((group) => (
          <section key={group.key} className="setting-group" data-setting-group={group.key}>
            <h3 className="setting-group-head">
              {t(typeLabelKey(group.key))}
              <span className="setting-group-count">{group.cards.length}</span>
            </h3>
            {group.cards.map((card) => {
              const summary = cardSummary(card);
              return (
                <button
                  key={card.id}
                  type="button"
                  className={`setting-cardrow${selectedId === card.id ? ' is-selected' : ''}`}
                  aria-current={selectedId === card.id ? 'true' : undefined}
                  data-setting-card-id={card.id}
                  onClick={() => onSelect(card.id)}
                >
                  <span className="setting-cardrow-name">
                    {card.name}
                    <TierBadge card={card} t={t} />
                    <span className={`setting-badge setting-badge--status setting-badge--status-${cardStatus(card)}`}>
                      {t(`settingPage.status.${cardStatus(card)}`)}
                    </span>
                  </span>
                  {summary !== null && <span className="setting-cardrow-summary">{summary}</span>}
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
