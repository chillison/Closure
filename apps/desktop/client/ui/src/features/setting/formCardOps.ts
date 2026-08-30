/**
 * CardForm 纯卡片操作（task 08-30-asset-cards-visualization A2 波）。
 *
 * 全部纯函数：读（点路径取值，null 安全——CR-002 后组值可为 null）、写（沿路径不可变重建，
 * 兄弟字段全保留——卡上 spec 外的未知字段经浅展平天然保真，不丢数据）。空值语义：文本清空
 * → 删叶键（yaml 干净，optional 字段缺失即未设）；chips 删到空 → 留 `[]`（schema default
 * 同形）。返回 `null` = 无变化（调用方跳过 onSave，防无谓落盘/undo 栈噪音）。
 */

import type { AssetCard } from '@orison/shared-contracts';

/** 点路径取值（'personality.coreTraits'）。中途 null/非对象 → undefined（不抛）。 */
export function getPathValue(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 沿路径不可变写值；value === undefined → 删叶键。中间层缺失/为 null → 建新对象。 */
export function setPathValue(card: AssetCard, path: string, value: unknown): AssetCard {
  return setAt(card, path.split('.'), value) as AssetCard;
}

function setAt(current: unknown, segments: readonly string[], value: unknown): unknown {
  const [head, ...rest] = segments;
  const base: Record<string, unknown> =
    current !== null && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  if (rest.length === 0) {
    if (value === undefined) delete base[head];
    else base[head] = value;
  } else {
    const child = setAt(base[head], rest, value);
    if (child === undefined) delete base[head];
    else base[head] = child;
  }
  return base;
}

/**
 * 文本字段落盘：trim；空串 → 删键（原值非 undefined 时——含非字符串存值的显式清空，
 * CR P18：unknown seam 上 number/null/对象等非字符串存值在表单显影为空串，「清空」必须
 * 落「无值」而非静默保留隐形原值）；与现值同 → null（无变化）。
 */
export function commitTextField(card: AssetCard, path: string, raw: string): AssetCard | null {
  const trimmed = raw.trim();
  const existing = getPathValue(card, path);
  if (trimmed === '') {
    return existing === undefined ? null : setPathValue(card, path, undefined);
  }
  const existingStr = typeof existing === 'string' ? existing : '';
  if (trimmed === existingStr) return null;
  return setPathValue(card, path, trimmed);
}

/** 防御性读 string[]：非数组/含非字符串项 → 过滤（渲染与增量操作都从这走）。 */
export function asChipValues(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** chips 添加：trim、去重；无变化 → null。 */
export function addChipValue(card: AssetCard, path: string, item: string): AssetCard | null {
  const trimmed = item.trim();
  if (!trimmed) return null;
  const current = asChipValues(getPathValue(card, path));
  if (current.includes(trimmed)) return null;
  return setPathValue(card, path, [...current, trimmed]);
}

/** chips 删除：不存在 → null；删到空留 []（schema default 同形）。 */
export function removeChipValue(card: AssetCard, path: string, item: string): AssetCard | null {
  const current = asChipValues(getPathValue(card, path));
  const next = current.filter((x) => x !== item);
  if (next.length === current.length) return null;
  return setPathValue(card, path, next);
}

/** number 落盘（调用方已钳制）；undefined → 删键；与现值同 → null。 */
export function commitNumberField(card: AssetCard, path: string, value: number | undefined): AssetCard | null {
  const existing = getPathValue(card, path);
  const existingNum = typeof existing === 'number' ? existing : undefined;
  if (value === existingNum) return null;
  return setPathValue(card, path, value);
}

/** details 落盘：空对象 → 删键（yaml 干净）。 */
export function setCardDetails(
  card: AssetCard,
  details: Record<string, unknown> | undefined,
): AssetCard {
  return setPathValue(card, 'details', details && Object.keys(details).length > 0 ? details : undefined);
}

/** details 防御性读：非普通对象 → undefined。 */
export function asDetailsRecord(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

// ── CRUD 投影（B 波集成：updateField('asset_cards') 的载荷构造）──────────────────
// 🔑 契约：**必须对 raw 数组直改**（store seam unknown seam 的原值）——coerceAssetCards
// 的 rows 是守卫产物（元素级垃圾已丢弃、形态已收窄），把 rows 写回 = 静默删除盘上垃圾元素
// （null/数字/缺 id-name 键的元素、未知 type 卡会被丢）。以下全部保留非对象/越界元素原样。

/** raw 元素是否为 id 等值的目标卡（元素级防御——非对象不炸）。 */
function rawCardId(el: unknown): unknown {
  if (el === null || typeof el !== 'object' || Array.isArray(el)) return undefined;
  return (el as Record<string, unknown>).id;
}

/**
 * 保存投影（CR P19 改义）：raw 中 id 匹配的**首个**元素替换为 next（其余元素——含垃圾/
 * 未知 type 卡——原样保留）；**无匹配 → 原样返回不 append**——目标 id 已不在数组（表单
 * 滞留编辑时卡被删：删除流/agent patch 翻新）则丢弃本次保存，不复活已删卡。新建流走
 * `appendCard` 显式追加（id 经 createCardSkeleton 查重不撞）。
 */
export function replaceCardById(raw: unknown, next: AssetCard): unknown[] {
  const arr = Array.isArray(raw) ? raw : [];
  let replaced = false;
  return arr.map((el) => {
    if (!replaced && rawCardId(el) === next.id) {
      replaced = true;
      return next;
    }
    return el;
  });
}

/** 新建投影：骨架卡 append（与 replaceCardById 分离——replace 路径不再隐式 append）。 */
export function appendCard(raw: unknown, card: AssetCard): unknown[] {
  const arr = Array.isArray(raw) ? raw : [];
  return [...arr, card];
}

/**
 * 删除投影：按 id 移除目标卡（**全部同 id 匹配**——与 coerceAssetCards 显示层 first-wins
 * 去重配套定谳：显示只亮首条，但删除按 id 清全部，重复 id 幽灵对一次删净不残留），其余
 * 元素（含垃圾）原样保留。
 */
export function removeCardById(raw: unknown, id: string): unknown[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.filter((el) => rawCardId(el) !== id);
}

/** 骨架卡 id：`card-` + 6 位 base36 随机（design §5）；与现存 id 撞车则重摇（上限 20 次）。 */
function newCardId(taken: Set<string>): string {
  let id = `card-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < 20 && taken.has(id); i++) {
    id = `card-${Math.random().toString(36).slice(2, 8)}`;
  }
  return id;
}

/**
 * 新建骨架卡（design §5）：`{id: 'card-xxxxxx', type, name: <未命名/i18n>, status: 'draft'}`。
 * id 生成后不可改（身份键：投影 by-id / 索引 entry_id / story-sync update_card 匹配）。
 * tags/relationships/sourceRefs 显式 []（z.infer 输出类型必填；盘上与 schema default 同形）。
 */
export function createCardSkeleton(
  type: AssetCard['type'],
  untitledName: string,
  rawCards: unknown,
): AssetCard {
  const taken = new Set<string>();
  if (Array.isArray(rawCards)) {
    for (const el of rawCards) {
      const id = rawCardId(el);
      if (typeof id === 'string') taken.add(id);
    }
  }
  // 构造位点断言（非 unknown seam 读）：8 variant 的 per-type 字段全 optional，base 骨架
  //（id/name/status/tags/relationships/sourceRefs/type 字面量）对任一 variant 恒合法。
  return {
    id: newCardId(taken),
    type,
    name: untitledName,
    status: 'draft',
    tags: [],
    relationships: [],
    sourceRefs: [],
  } as AssetCard;
}

/** 钳制 number（min/max 缺失侧不钳）。 */
export function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let out = value;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}
