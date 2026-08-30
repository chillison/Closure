import type { ActivePage } from '../../shared/store/appStore';

export type PageNavItem = { id: ActivePage; icon: string; i18nKey: string };

/** Group 1: Overview + Outline + Structure + Assets + Setting */
export const overviewItem: PageNavItem = { id: 'overview', icon: 'dashboard', i18nKey: 'nav.overview' };
export const outlineItem: PageNavItem = { id: 'outline', icon: 'auto_stories', i18nKey: 'nav.outline' };
export const structureItem: PageNavItem = { id: 'structure', icon: 'account_tree', i18nKey: 'nav.structure' };
export const assetsItem: PageNavItem = { id: 'assets', icon: 'perm_media', i18nKey: 'nav.assets' };
// 「设定」页（task 08-30-asset-cards-visualization，A1 波）：asset_cards 8 类设定卡的
// 浏览/编辑聚合页。id 用单数 'setting'（避开 SettingsDialog 的 app 级 settings 概念）；
// i18n 键 nav.setting 两 locale 已在位（test/settingPageI18n.test.ts 守卫齐平）。
export const settingItem: PageNavItem = { id: 'setting', icon: 'menu_book', i18nKey: 'nav.setting' };

/** Group 2: Production tools */
export const productionItems: PageNavItem[] = [
  { id: 'image_gen', icon: 'image', i18nKey: 'nav.imageGen' },
];

