/**
 * 「设定」页卡列表投影（task 08-30-asset-cards-visualization A1 波）。
 *
 * 纯函数模块（零 React/store 依赖）：unknown seam 元素级守卫（coerceAssetCards）→
 * 分组/过滤/搜索/tier 解析派生。组序 = 8 类 schema 序 + 「其他」殿后（未知/越界 type
 * 防御归组，mirror WorldStatePanel KNOWN_SUBJECT_TYPES 回落思路——research §3.5 legacy
 * `type:'image'` 卡实证在库）。
 *
 * 排序/tier 语义单源：tier 结构默认走 shared-contracts `resolveTier`（character/
 * golden_finger/rule → core，余 → micro——setting-prefix.ts 权威，UI 不复制判定表）。
 *
 * i18n 键契约（A3 波落 yaml，key 缺失时 t() 回落键名）：settingPage.type.<groupKey> /
 * settingPage.status.<status> / settingPage.tier.<tier> / settingPage.tier.defaultBadge。
 */
import {
  assetCardStatusSchema,
  assetCardTypeSchema,
  resolveTier as resolveTierCanonical,
  type AssetCard,
} from '@orison/shared-contracts';
import type { SettingTypeFilter } from '../../shared/store/settingSlice';

/** 8 类卡 type（schema 单源；UI 遍历用，避免散落字面量——mirror WORLD_AXES 先例）。 */
export const ASSET_CARD_TYPES = assetCardTypeSchema.options;
export type AssetCardType = (typeof ASSET_CARD_TYPES)[number];

/** 分组键：8 类之一或 'other'（未知/越界/缺省 type 的防御归组）。 */
export type CardGroupKey = AssetCardType | 'other';

/**
 * 列表读面所需的最小卡形态（元素级守卫产物）。`raw` 保留原始卡对象——右列只读 JSON
 * 呈现与 CardForm（已知 8 类的编辑面）消费全量字段。
 */
export type AssetCardRow = {
  id: string;
  name: string;
  type: string;
  raw: Record<string, unknown>;
};

export function isKnownCardType(type: string): type is AssetCardType {
  return (ASSET_CARD_TYPES as readonly string[]).includes(type);
}

/** 卡 type → 分组键：越界/缺省归 'other'。 */
export function cardGroupKey(type: string): CardGroupKey {
  return isKnownCardType(type) ? type : 'other';
}

/** 组/类型徽标的 i18n 键（A3 波 yaml 键契约）。 */
export function typeLabelKey(key: CardGroupKey): string {
  return `settingPage.type.${key}`;
}

function readString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * unknown seam 元素级守卫（spec ui/state-management.md「守卫必到元素级」+ layout-and-pages
 * 反模式「元素级 null/数字仍炸」）：非对象元素与缺 string id/name 的元素无法渲染行，
 * 防御性丢弃（注水 project.yaml 直达渲染派生的防崩闸）；type 越界保留原值归「其他」
 * 组（不丢卡——只读呈现，卡数据修复归写路）。非数组输入（旧项目无 asset_cards 键）
 * → 空数组（零卡空态由该形态天然给出）。
 *
 * 重复 id **first-wins 去重**（CR P11）：后条丢弃——同 id 双卡会撞 React key + 第二张
 * 不可编辑（replaceCardById 只换首个匹配）。写回契约不受影响（formCardOps 对 raw 直改）；
 * 与 removeCardById「按 id 删全部」配套：删除时幽灵对一次清干净，不残留显示层丢弃的暗条。
 */
export function coerceAssetCards(value: unknown): AssetCardRow[] {
  if (!Array.isArray(value)) return [];
  const rows: AssetCardRow[] = [];
  const seenIds = new Set<string>();
  for (const el of value) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) continue;
    const raw = el as Record<string, unknown>;
    const id = readString(raw.id);
    const name = readString(raw.name);
    if (id === null || name === null) continue;
    if (seenIds.has(id)) continue; // 重复 id 后条丢弃（first-wins）
    seenIds.add(id);
    rows.push({ id, name, type: readString(raw.type) ?? '', raw });
  }
  return rows;
}

/**
 * 生效 tier：显式标注（card.tier = core/micro）直接用；未标走结构默认（resolveTier
 * 单源——真实卡全未标，裸读 card.tier 恒空，research §7.1）。explicit=false 时 UI 加
 * 「默认」角标（i18n settingPage.tier.defaultBadge）。
 *
 * 实参 id/name/type 三字段均已在 coerceAssetCards 元素级守卫为 string——显式构造的
 * 最小实参过一次契约签名断言（resolveTier 只读 tier/type 两字段），非裸读 store 直灌。
 */
export function cardTier(card: AssetCardRow): { tier: 'core' | 'micro'; explicit: boolean } {
  const t = card.raw.tier;
  if (t === 'core' || t === 'micro') return { tier: t, explicit: true };
  const tier = resolveTierCanonical({ id: card.id, name: card.name, type: card.type } as AssetCard);
  return { tier, explicit: false };
}

/**
 * 状态徽标值：越界/缺省回落 'draft'（schema default）。成员判定 = assetCardStatusSchema
 * 单源（CR P10：schema 加值自动跟随，不再手抄枚举比对）。
 */
export function cardStatus(card: AssetCardRow): 'draft' | 'active' | 'deprecated' | 'locked' {
  const s = card.raw.status;
  return (assetCardStatusSchema.options as readonly unknown[]).includes(s)
    ? (s as 'draft' | 'active' | 'deprecated' | 'locked')
    : 'draft';
}

export function cardSummary(card: AssetCardRow): string | null {
  return readString(card.raw.summary);
}

export function cardTags(card: AssetCardRow): string[] {
  const tags = card.raw.tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** 搜索命中（name/summary/tags 纯前端过滤，不区分大小写包含——design §3 工具栏契约）。 */
export function searchMatches(card: AssetCardRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (card.name.toLowerCase().includes(q)) return true;
  const summary = cardSummary(card);
  if (summary !== null && summary.toLowerCase().includes(q)) return true;
  return cardTags(card).some((tag) => tag.toLowerCase().includes(q));
}

export type SettingCardGroup = {
  key: CardGroupKey;
  cards: AssetCardRow[];
};

/** 全卡集（搜索前）按分组键计数——chips 计数展示数据分布，不随搜索缩水。 */
export function countByGroupKey(cards: readonly AssetCardRow[]): Map<CardGroupKey, number> {
  const counts = new Map<CardGroupKey, number>();
  for (const card of cards) {
    const key = cardGroupKey(card.type);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * 死过滤回落（fail-soft）：持久化的 typeFilter 所指组在当前卡集无卡（卡被删/数据翻新）
 * → 'all'。防「过滤指向不存在组 → 列表恒空且无 chip 激活」的死胡同视图。
 */
export function effectiveTypeFilter(filter: SettingTypeFilter, cards: readonly AssetCardRow[]): SettingTypeFilter {
  if (filter === 'all') return 'all';
  return countByGroupKey(cards).get(filter as CardGroupKey) ? filter : 'all';
}

/**
 * 分组投影：'all' = 8 类 schema 序（只含有卡的组）+ 'other' 殿后；指定组 = 仅该组。
 * 搜索在组内即时过滤；空组滤除。
 */
export function groupCards(
  cards: readonly AssetCardRow[],
  filter: SettingTypeFilter,
  query: string,
): SettingCardGroup[] {
  const counts = countByGroupKey(cards);
  const wanted: CardGroupKey[] = [];
  if (filter === 'all') {
    for (const type of ASSET_CARD_TYPES) {
      if (counts.get(type)) wanted.push(type);
    }
    if (counts.get('other')) wanted.push('other');
  } else {
    wanted.push(filter as CardGroupKey);
  }
  return wanted
    .map((key) => ({
      key,
      cards: cards.filter((c) => cardGroupKey(c.type) === key && searchMatches(c, query)),
    }))
    .filter((g) => g.cards.length > 0);
}
