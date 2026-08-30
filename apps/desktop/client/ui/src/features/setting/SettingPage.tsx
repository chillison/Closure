/**
 * 「设定」页（task 08-30-asset-cards-visualization A1 波；B 波集成收尾；CR patch 波修订）——
 * asset_cards 8 类设定卡的 master-detail 读+写面（形态权威：research/mockup-setting-page-v1.html，
 * W0 用户拍板）。
 *
 * 结构：顶部工具栏（新建[NewCardMenu 8 类菜单] + 搜索框）/ 左列（双 tab 设定卡|设定文档 +
 * 类型过滤 chips + 分组卡列表）/ 右列（locked 横幅 + CardForm[A2 表单，key=card.id 清草稿
 * 血缘] / 未知 type 只读 JSON / 未选卡提示）。
 *
 * 零卡空态（CR P1 修订）：**仅占卡区**——工具栏/双 tab 照常渲染（docs tab 可用），卡列表区
 * 显 SettingEmptyState 双 CTA；不再整页吞掉（旧项目无卡但有设定文档时文档入口不消失）。
 *
 * docs tab 生效位（CR-004 裁决 4 修订）：按持久化 tab 直渲（loading 期骨架占位，不先闪
 * cards）；装载落定后初装即空（本挂载从未有文档）→ 死态回落 cards；装载后被清空而用户正停
 * docs tab → tab 内显空态不强切。显隐/死态派生见下方 docsTabAlive 注释。
 *
 * 数据流（design §2）：读 = useAppStore(creativeFields.asset_cards)（unknown seam——
 * coerceAssetCards 元素级守卫）+ selector 派生分组/过滤/搜索；outline:changed →
 * refreshProjectDocument 现行链自动翻新 store（agent 写卡三路全覆盖，零事件工程）。
 * 写 = CardForm onSave → replaceCardById **对 raw 数组直改**（守卫产物写回会静默删盘上
 * 垃圾元素——formCardOps CRUD 投影契约；目标已不在数组则丢弃不复活，CR P19）→
 * updateField('asset_cards', newArr)（creativeFieldsSlice 现行通道；syncField 拒绝回传 =
 * slice 内 catch → creative.field.syncFailed 错误 toast，草稿留表单，零新机制）。
 *
 * 交互态（settingSlice，持久化过刷新存活 #86）：选中卡 id / tab / 类型过滤；搜索词是
 * 纯渲染 affordance 留组件局部。选中语义（B 波定稿）：null = 未选（右列提示空态——删除
 * 流显式清写落此）；持久化 id 失效（卡被 agent 删/数据翻新）→ 派生回落首行不回写。
 *
 * B4 locked：fieldMetadata.asset_cards.locked（field 级锁，≠卡 status.locked）→ 整编辑
 * 面只读横幅 + 解锁钮走 creativeFieldsSlice.toggleFieldLock（既有 field:toggle-lock
 * IPC 的 UI 侧调用面，PatchReviewPanel 字段锁同款）。
 */
import { useEffect, useMemo, useState } from 'react';
import type { AssetCard } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useConfirmStore } from '../../shared/store/confirmStore';
import {
  coerceAssetCards,
  countByGroupKey,
  effectiveTypeFilter,
  groupCards,
  isKnownCardType,
  cardStatus,
} from './cardList';
import { SettingCardList } from './SettingCardList';
import { CardSummary } from './CardSummary';
import { SettingEmptyState } from './SettingEmptyState';
import { CardForm } from './CardForm';
import { NewCardMenu } from './NewCardMenu';
import { SettingDocsList, useSettingDocs } from './SettingDocsList';
import { removeCardById, replaceCardById } from './formCardOps';

export function SettingPage() {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const rawCards = useAppStore((s) => s.creativeFields.asset_cards);
  const toggleFieldLock = useAppStore((s) => s.toggleFieldLock);
  const projectPath = useAppStore((s) => s.currentProject?.path);
  const locked = useAppStore((s) => s.fieldMetadata.asset_cards?.locked === true);
  const settingView = useAppStore((s) => s.settingView);
  const selectSettingCard = useAppStore((s) => s.selectSettingCard);
  const setSettingTab = useAppStore((s) => s.setSettingTab);
  const setSettingTypeFilter = useAppStore((s) => s.setSettingTypeFilter);
  const hydrateSettingViewState = useAppStore((s) => s.hydrateSettingViewState);

  // 视图态水合（幂等/每项目一次）：持久化的选中卡/tab/过滤刷新存活（#86）。deps 含
  // projectPath（CR P12）：项目切换时页面不重挂（activePage 跨项目存活）——reset 清了
  // 水合标记但挂载 effect 不再跑，新项目持久化视图态会落默认；水合幂等，加路径依赖
  // 不改变「每项目一次」语义。
  useEffect(() => {
    hydrateSettingViewState();
  }, [hydrateSettingViewState, projectPath]);

  // 搜索词：纯渲染 affordance，组件局部（mockup 同语义——刷新不保）。
  const [search, setSearch] = useState('');

  const rows = useMemo(() => coerceAssetCards(rawCards), [rawCards]);

  // 设定文档（B7）：settings/*.md 列表 + 空目录 tab 显隐/死态派生（CR-004 裁决 4，见头注）。
  const docs = useSettingDocs(projectPath);

  // ── 写路（B 波集成）──

  /**
   * CardForm onSave 落盘（契约：formCardOps CRUD 投影）：raw 直改保垃圾元素；目标 id
   * 已不在数组（表单滞留编辑时卡被删）→ replaceCardById 原样返回不 append（CR P19 防
   * 复活已删卡）。拒绝回传实况：updateField void 返回（fire-and-forget），其内部 syncField
   * 已带 .catch → creative.field.syncFailed 错误 toast（所有字段编辑器同一通道）——零新机制。
   */
  const handleSave = (next: AssetCard) => {
    const state = useAppStore.getState();
    state.updateField('asset_cards', replaceCardById(state.creativeFields.asset_cards, next));
  };

  /** CardForm 删除请求 → 全局确认框（confirmStore + App 级 ConfirmDialog，ProjectTree dogfood #46 同款）→ 数组落盘 + 显式清写选中（右列空态）。 */
  const handleDeleteRequest = async () => {
    const current = useAppStore.getState();
    const id = current.settingView.selectedCardId;
    const capturedPath = current.currentProject?.path;
    const target = coerceAssetCards(current.creativeFields.asset_cards).find((c) => c.id === id);
    if (!id || !target || !capturedPath) return;
    const name = target.name;
    const confirmed = await useConfirmStore.getState().requestConfirm({
      title: t('settingPage.action.delete'),
      message: t('settingPage.action.deleteConfirm', { name }),
      confirmLabel: t('common.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;
    // 竞态守卫：确认框期间项目可能切换/数据可能翻新——项目变了只清选中不动新项目数据；
    // 卡已不存在则同样只清选中。
    const fresh = useAppStore.getState();
    const stillThere = fresh.currentProject?.path === capturedPath
      && coerceAssetCards(fresh.creativeFields.asset_cards).some((c) => c.id === id);
    if (stillThere) {
      fresh.updateField('asset_cards', removeCardById(fresh.creativeFields.asset_cards, id));
    }
    fresh.selectSettingCard(null); // 显式清写（派生回落不回写——删除流负责清，null=右列空态）
  };

  // ── 读面派生 ──

  // 选中语义（B 波定稿，头注）：null = 未选；失效 id → 回落首行（不回写）。
  const selected = settingView.selectedCardId === null
    ? null
    : rows.find((c) => c.id === settingView.selectedCardId) ?? rows[0] ?? null;

  /**
   * 表单卡：已知 8 类才给 CardForm（未知 type 走 JSON 只读视图）。
   * `as` 构造位点断言（非裸读 unknown seam）：id/name/type 已过 coerceAssetCards 元素级
   * 守卫为 string + type 过 8 类枚举门；卡体其余字段由 CardForm/formCardOps 的 unknown-safe
   * 取值面（getPathValue/asChipValues/浅展平）消费，畸形值不炸。status 收窄到 4 值枚举
   * （select 受控值需合法；schema default 'draft'——垃圾值修复为缺省，落盘即 schema 同形）。
   */
  const formCard: AssetCard | null = selected !== null && isKnownCardType(selected.type)
    ? ({ ...selected.raw, status: cardStatus(selected) } as AssetCard)
    : null;

  const filter = effectiveTypeFilter(settingView.typeFilter, rows);
  const counts = countByGroupKey(rows);
  const groups = groupCards(rows, filter, search);

  // docs tab 生效位（CR-004 裁决 4，见文件头注）：
  // - loading 期（含初装）：按持久化 tab 直渲——tab=docs 时 docs 钮可见 + 内容区骨架，
  //   不先闪 cards 再翻回；
  // - 初装落定即空（本挂载从未有文档，hadEntries=false）→ 死态：隐藏 docs 钮 + tab=docs
  //   回落 cards（持久化死 tab 不落死胡同，照旧）；
  // - 装载后被清空（hadEntries=true）而用户正停 docs tab → 非死：tab 内显空态不强切；
  //   用户在 cards tab 时目录再空 → 照 AC6 隐藏 docs 钮（再有文档时重新出现）。
  const docsDead = docs.loaded && !docs.loading && docs.entries.length === 0 && !docs.hadEntries;
  const onDocsTab = settingView.tab === 'docs';
  const showDocsTab = onDocsTab ? !docsDead : docs.entries.length > 0;
  const effectiveTab = onDocsTab && docsDead ? 'cards' : settingView.tab;

  return (
    <div className="setting-page">
      <div className="setting-toolbar">
        <h1 className="setting-title">{t('settingPage.title')}</h1>
        <NewCardMenu />
        <input
          className="setting-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('settingPage.toolbar.searchPlaceholder')}
          aria-label={t('settingPage.toolbar.searchPlaceholder')}
        />
      </div>
      <div className="setting-layout">
        <div className="setting-left">
          <div className="setting-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`setting-tab${effectiveTab === 'cards' ? ' is-active' : ''}`}
              aria-selected={effectiveTab === 'cards'}
              data-setting-tab="cards"
              onClick={() => setSettingTab('cards')}
            >
              {t('settingPage.tab.cards')}
              <span className="setting-tab-count">{rows.length}</span>
            </button>
            {/* docs tab：显隐/死态派生见上方 docsDead 注释（CR-004 裁决 4）。 */}
            {showDocsTab && (
              <button
                type="button"
                role="tab"
                className={`setting-tab${effectiveTab === 'docs' ? ' is-active' : ''}`}
                aria-selected={effectiveTab === 'docs'}
                data-setting-tab="docs"
                onClick={() => setSettingTab('docs')}
              >
                {t('settingPage.tab.docs')}
                <span className="setting-tab-count">{docs.entries.length}</span>
              </button>
            )}
          </div>
          {effectiveTab === 'cards' ? (
            // 零卡空态仅占卡区（CR P1）：工具栏/双 tab 照常渲染，docs tab 不被吞掉。
            rows.length === 0 ? (
              <SettingEmptyState />
            ) : (
              <SettingCardList
                rows={rows}
                filter={filter}
                groups={groups}
                counts={counts}
                selectedId={selected?.id ?? null}
                onSelect={selectSettingCard}
                onFilter={setSettingTypeFilter}
                t={t}
              />
            )
          ) : (
            <SettingDocsList state={docs} />
          )}
        </div>
        <div className="setting-detail">
          {/* B4 locked 横幅（field 级锁，非卡状态）：chrome 位——钉在滚动面之上不随内容滚走。 */}
          {locked && (
            <div className="setting-lockbar" role="status" data-setting-locked>
              <span className="material-symbols-outlined" aria-hidden="true">lock</span>
              <span className="setting-lockbar-text">{t('settingPage.locked.banner')}</span>
              <button
                type="button"
                className="setting-lockbar-unlock"
                onClick={() => { toggleFieldLock('asset_cards'); }}
              >
                {t('settingPage.locked.unlock')}
              </button>
            </div>
          )}
          <div className="setting-right">
            {formCard !== null ? (
              <CardForm
                key={formCard.id}
                card={formCard}
                onSave={handleSave}
                readOnly={locked}
                onDeleteRequest={handleDeleteRequest}
              />
            ) : selected !== null ? (
              <CardSummary card={selected} t={t} />
            ) : (
              <div className="setting-summary setting-summary--none setting-selecthint">
                {t('settingPage.selectHint')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
