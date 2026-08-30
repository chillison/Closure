/**
 * 设定卡全字段表单（task 08-30-asset-cards-visualization A2 波，design §3/§5；CR patch 波
 * 修订：tier 未标判定含 null、卡名空值回显、relationships 只读占位）。
 *
 * 受控组件（InsightCard 纯受控壳哲学）：props 进（card）、props 出（onSave 整张新卡）——
 * 卡数据零 store 直连，B 波（页面集成）负责「构造新数组替换目标卡 → updateField('asset_cards')」。
 * 例外订阅：resolvedLocale（i18n，WorkingStyleSection 自含订阅先例）——标签经 fieldSpec
 * 标签出口传 t 渲染（AC7 中文人话）。
 * 选中卡切换时建议宿主以 `key={card.id}` 挂载（清空草稿/折叠态血缘）。
 *
 * 结构：卡头（name blur 存[空值回显存量，CR P17] / id 只读 / type 徽标 / status select /
 * tier 三态——未标位高亮 resolveTier 结构默认 + 「默认」角标；未标判定 `tier !== core/micro`
 * 含 yaml null，CR P13）→ FIELD_SPEC 组序分区（主显展开、次显折叠 useState 局部）→
 * secrets 双栏 → relationships 只读摘要（CR P7，KR-010 后置）→ object 数组占位
 * （SKIP_OBJECT_ARRAYS）→ details kv 自由表 → 底部删除按钮（onDeleteRequest 透传，
 * 确认框归宿主）。
 *
 * 入口契约：card.type 须为 8 类（A1 波列表对未知 type 走 JSON 只读视图，不经本表单）；
 * 防御性兜底返回 null。卡上 spec 外的未知字段经 formCardOps 浅展平天然保留。
 */

import { useState } from 'react';
import { resolveTier } from '@orison/shared-contracts';
import type { AssetCard } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import {
  FIELD_SPEC,
  STATUS_VALUES,
  deleteCardLabel,
  detailsGroupLabel,
  displayGroups,
  groupLabelFor,
  isMainGroup,
  labelFor,
  objectArrayPlaceholders,
  statusLabelFor,
  tierDefaultBadgeLabel,
  tierLabelFor,
  tierUnsetLabel,
  typeLabelFor,
  unsupportedFieldNote,
  vocabFor,
} from './fieldSpec';
import type { FieldSpecEntry, TypeFieldSpec } from './fieldSpec';
import {
  addChipValue,
  commitNumberField,
  commitTextField,
  getPathValue,
  removeChipValue,
  setCardDetails,
  setPathValue,
} from './formCardOps';
import {
  FormBooleanControl,
  FormChipsControl,
  FormKvTable,
  FormNumberControl,
  FormSelectControl,
  FormTextControl,
} from './formControls';
import './formCardForm.css';

export interface CardFormProps {
  card: AssetCard;
  /** 落盘回调：收到「整张新卡」（含未知字段保留）；无变化不触发。 */
  onSave: (next: AssetCard) => void;
  /** 全表只读（field 级 locked / 审阅态）。 */
  readOnly?: boolean;
  /** 底部删除按钮透传（确认框归宿主——A2 波不接，B 波接）。 */
  onDeleteRequest?: () => void;
}

export function CardForm({ card, onSave, readOnly = false, onDeleteRequest }: CardFormProps) {
  // i18n 自含订阅（WorkingStyleSection 先例——组件自订 resolvedLocale）：标签全走 fieldSpec
  // 标签出口传入 t（zh 真渲染中文人话，AC7）；卡**数据**仍零 store 直连（受控 props 契约）。
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);

  // 折叠态局部（design §5：交互 affordance 留组件局部；跨卡记忆归 settingSlice 的列表折叠，
  // 非此物）。存「显式翻转」：主显默认开、次显默认合。
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({});

  // 入口断言 8 类（防御：store seam 是 unknown，A1 列表已归「其他」组走 JSON 视图）。
  const spec: TypeFieldSpec | undefined = (FIELD_SPEC as Record<string, TypeFieldSpec | undefined>)[card.type];
  if (!spec) {
    if (typeof console !== 'undefined') {
      console.warn(`[CardForm] 未知卡类型 ${String(card.type)}——应由列表侧 JSON 只读视图处理`);
    }
    return null;
  }

  const save = (next: AssetCard | null) => {
    if (!next || readOnly) return;
    onSave(next);
  };

  // ── 卡头 ──
  // 卡名必填（schema）：空/纯空白 blur 拒绝并回显存量（CR P17——rejectEmpty 交给控件层）。
  const commitName = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === card.name) return;
    save({ ...card, name: trimmed });
  };
  const commitStatus = (value: string) => {
    if (value === card.status) return;
    save(setPathValue(card, 'status', value));
  };
  /** tier 三态：'core'/'micro' 写值；未标 → 删键（回落结构默认）。 */
  const commitTier = (value: 'core' | 'micro' | undefined) => {
    if (value === card.tier) return;
    save(setPathValue(card, 'tier', value));
  };
  const effectiveTier = resolveTier(card);
  // 未标判定（CR P13）：tier 经 unknown seam 可为 yaml null——判 `!== core/micro`（与
  // cardList.cardTier 同语义），null 时三态组不再零选中（radiogroup ARIA 违约）。
  const tierUnset = card.tier !== 'core' && card.tier !== 'micro';

  // ── 字段渲染 ──
  const renderField = (entry: FieldSpecEntry) => {
    const label = labelFor(card.type, entry.path, t);
    const value = getPathValue(card, entry.path);
    switch (entry.control) {
      case 'text':
        return (
          <FormTextControl
            label={label}
            value={value}
            disabled={readOnly}
            onCommit={(raw) => { save(commitTextField(card, entry.path, raw)); }}
          />
        );
      case 'textarea':
        return (
          <FormTextControl
            multiline
            rows={2}
            label={label}
            value={value}
            disabled={readOnly}
            onCommit={(raw) => { save(commitTextField(card, entry.path, raw)); }}
          />
        );
      case 'number':
        return (
          <FormNumberControl
            label={label}
            value={value}
            min={entry.min}
            max={entry.max}
            disabled={readOnly}
            onCommit={(v) => { save(commitNumberField(card, entry.path, v)); }}
          />
        );
      case 'select':
        return (
          <FormSelectControl
            label={label}
            value={value}
            suggestions={vocabFor(entry.vocabKey)}
            disabled={readOnly}
            t={t}
            onCommit={(raw) => { save(commitTextField(card, entry.path, raw)); }}
          />
        );
      case 'string[]':
        return (
          <FormChipsControl
            label={label}
            value={value}
            suggestions={entry.vocabKey ? vocabFor(entry.vocabKey) : undefined}
            disabled={readOnly}
            t={t}
            onAdd={(item) => { save(addChipValue(card, entry.path, item)); }}
            onRemove={(item) => { save(removeChipValue(card, entry.path, item)); }}
          />
        );
      case 'boolean':
        return (
          <FormBooleanControl
            label={label}
            value={value}
            disabled={readOnly}
            onCommit={(v) => {
              const current = getPathValue(card, entry.path);
              const cur = current === true;
              if (v === cur) return;
              save(setPathValue(card, entry.path, v));
            }}
          />
        );
      case 'kv':
      default:
        return null; // kv 保留位（details 由内置 KvTable 渲染，spec 条目不使用）
    }
  };

  const placeholders = objectArrayPlaceholders(card, t);

  // relationships 只读摘要数据（CR P7）：unknown seam 元素级守卫——非对象元素丢弃，
  // targetId 缺失的边不成行（不炸渲染）；只呈现不编辑。
  const relationships = (Array.isArray(card.relationships) ? card.relationships : [])
    .map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : null))
    .filter((r): r is Record<string, unknown> => r !== null && typeof r['targetId'] === 'string')
    .map((r) => ({
      targetId: r['targetId'] as string,
      relationType: typeof r['relationType'] === 'string' ? r['relationType'] : undefined,
      label: typeof r['label'] === 'string' ? r['label'] : undefined,
    }));

  return (
    <div className="card-form" data-card-type={card.type}>
      {/* ── 卡头：name / id / type 徽标 / status / tier 三态 ── */}
      <header className="card-form-head">
        <FormTextControl
          className="card-form-name"
          label={t('settingPage.head.name')}
          value={card.name}
          disabled={readOnly}
          rejectEmpty
          onCommit={commitName}
        />
        <span className="card-form-id">id: {card.id}</span>
        <span className="card-form-type-badge">{typeLabelFor(card.type, t)}</span>
        <select
          className="card-form-status"
          aria-label={t('settingPage.head.status')}
          value={card.status}
          disabled={readOnly}
          onChange={(e) => { commitStatus(e.target.value); }}
        >
          {STATUS_VALUES.map((s) => (
            <option key={s} value={s}>{statusLabelFor(s, t)}</option>
          ))}
        </select>
        <div className="card-form-tier" role="radiogroup" aria-label={t('settingPage.head.tier')}>
          <button
            type="button"
            role="radio"
            aria-checked={tierUnset}
            className={`card-form-tier-btn${tierUnset ? ' is-unset' : ''}`}
            disabled={readOnly}
            onClick={() => { commitTier(undefined); }}
          >{tierUnsetLabel(t)}</button>
          {(['core', 'micro'] as const).map((tier) => (
            <button
              key={tier}
              type="button"
              role="radio"
              aria-checked={card.tier === tier}
              className={`card-form-tier-btn${effectiveTier === tier ? ' is-active' : ''}`}
              disabled={readOnly}
              onClick={() => { commitTier(tier); }}
            >
              {tierLabelFor(tier, t)}
              {tierUnset && effectiveTier === tier && (
                <span className="card-form-tier-default">{tierDefaultBadgeLabel(t)}</span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* ── 字段分区（displayGroups 显示序：主显在前展开、次显折叠）── */}
      {displayGroups(card.type).map((group) => {
        const main = isMainGroup(card.type, group.key);
        const open = collapsedOverride[group.key] !== undefined ? collapsedOverride[group.key] : main;
        // 单字段组（path === key）：组标题即字段标签，不再重复渲染字段标签
        const singleUntitled = group.fields.length === 1 && group.fields[0].path === group.key;
        const secrets = group.key === 'secrets';
        return (
          <section
            key={group.key}
            className={`card-form-sect${main ? ' is-main' : ''}${secrets ? ' card-form-sect-secrets' : ''}`}
          >
            <button
              type="button"
              className={`card-form-sect-header${open ? ' is-open' : ''}`}
              aria-expanded={open}
              onClick={() => { setCollapsedOverride((prev) => ({ ...prev, [group.key]: !open })); }}
            >
              {groupLabelFor(group.key, t)}
            </button>
            {open && (
              <div className={`card-form-fields${singleUntitled ? ' is-single' : ''}`}>
                {group.fields.map((entry) => (
                  <div key={entry.path} className={`card-form-field${singleUntitled ? ' is-untitled' : ''}`}>
                    {!singleUntitled && <span className="card-form-field-label">{labelFor(card.type, entry.path, t)}</span>}
                    {renderField(entry)}
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      {/* ── relationships 只读摘要（CR P7/裁决 5：KR-010 双源后置，不做编辑——卡内
          legacy 边只读呈现，图形化视图随关系数据生产路径建立后提供）── */}
      {relationships.length > 0 && (
        <section className="card-form-sect card-form-sect-relationships">
          <span className="card-form-sect-header">
            {groupLabelFor('relationships', t)}
            <span className="card-form-rel-count">{relationships.length}</span>
          </span>
          <ul className="card-form-rel-list">
            {relationships.map((rel, i) => (
              <li key={`${rel.targetId}-${i}`} className="card-form-rel-item">
                <span className="card-form-rel-target">{rel.targetId}</span>
                {rel.relationType && <span className="card-form-rel-type">{rel.relationType}</span>}
                {rel.label && <span className="card-form-rel-label">{rel.label}</span>}
              </li>
            ))}
          </ul>
          <p className="card-form-rel-hint">{t('settingPage.relationships.readonlyHint')}</p>
        </section>
      )}

      {/* ── object 数组占位（SKIP_OBJECT_ARRAYS——只读不改值）── */}
      {placeholders.length > 0 && (
        <section className="card-form-sect card-form-sect-skipnote">
          <span className="card-form-sect-header">{unsupportedFieldNote(t)}</span>
          <ul className="card-form-skipnote-list">
            {placeholders.map((p) => (
              <li key={p.path}><span className="card-form-field-label">{p.label}</span>{unsupportedFieldNote(t)}</li>
            ))}
          </ul>
        </section>
      )}

      {/* ── details 自由键值表 ── */}
      <section className="card-form-sect">
        <span className="card-form-sect-header">{detailsGroupLabel(t)}</span>
        <FormKvTable
          details={card.details}
          disabled={readOnly}
          t={t}
          onCommit={(next) => { save(setCardDetails(card, next)); }}
        />
      </section>

      {/* ── 底部删除按钮（确认框归宿主）── */}
      {!readOnly && onDeleteRequest && (
        <footer className="card-form-foot">
          <button type="button" className="card-form-delete" onClick={onDeleteRequest}>
            {deleteCardLabel(t)}
          </button>
        </footer>
      )}
    </div>
  );
}
