/**
 * 设定卡表单引擎字段规格（task 08-30-asset-cards-visualization A2 波，design §4/§5）。
 *
 * FIELD_SPEC 是「8 类设定卡的表单如何渲染」的声明式清单：组序 = 显示序（主显组在前，对齐
 * `CORE_FIELD_SPEC`（setting-prefix.ts）coreFields 涉及的组——写手供给的「核心字段优先」语义
 * 与可视化详情排序同源），组内 field = 点路径 + 控件类型。
 *
 * 权威数据源 = `packages/shared-contracts/src/contracts/creative-fields.ts` 的 8 个
 * *FieldsSchema + 4 公共 sub-schema + base。**双向对拍测试**（test/fieldSpec.schemaCrossCheck.test.ts）
 * 守死 spec ↔ schema 漂移：
 *   - 正向：每条 path 逐段 walk 对应 variant 的 Zod shape 必须存在，叶类型与 control 匹配；
 *   - 反向：schema 每个可编辑叶字段必须出现在 spec（SKIP_OBJECT_ARRAYS 清单内的除外——
 *     且清单内每项必须真实存在于 schema，防「假跳过」）。
 *
 * 不进 spec 的字段（design §4/§5 边界）：
 *   - `id`（身份键不可改：投影 by-id / 索引 entry_id / story-sync update_card 匹配）；
 *   - `type` / `status` / `tier`（卡头控件，非字段分区——CardForm 卡头单独渲染）；
 *   - `relationships`（KR-010 双源未定谳，图形化后置时再定——CR P7：CardForm 渲染只读
 *     摘要占位（`groupLabelFor('relationships')` + `settingPage.relationships.readonlyHint`），
 *     不做编辑）；
 *   - `details`（kv 自由表，由 CardForm 内置 KvTable 单独渲染——`FieldControl` 保留 `'kv'`
 *     枚举位以契约定稿，spec 条目暂不使用）。
 *
 * SKIP_OBJECT_ARRAYS：object 数组字段本波不进 spec（没有安全控件，硬上 textarea 存原文
 * 会写坏结构）。CardForm 对「卡上存在且在清单内」的字段显示只读占位（不改值——缺失控件
 * 不误伤数据）。当前 8 类 schema 无 object 数组叶（lore.versionSystem.versions 是
 * string[]、golden_finger.growthSystem.stages 是 string），清单为空；schema 未来新增
 * object 数组字段时反向对拍测试会红，届时把路径登进本清单（或补控件）。
 *
 * 标签出口（i18n 的唯一 seam——别在组件里散落硬编码标签）：
 *   - `labelFor(type, path, t?)` / `groupLabelFor(key, t?)` / `typeLabelFor(type, t?)` /
 *     `statusLabelFor` / `tierLabelFor` / `tierUnsetLabel` / `tierDefaultBadgeLabel` /
 *     `detailsGroupLabel` / `unsupportedFieldNote` / `deleteCardLabel` /
 *     `addChipPlaceholder` / `kvAddRowLabel` / kv 行与 chips 删除钮 aria
 *     （kvKeyAriaLabel / kvValueAriaLabel / kvDeleteAriaLabel / chipRemoveAriaLabel）。
 *   传入 `t` → 走 `translate`（键位派生函数 fieldI18nKey / groupI18nKey / … 给出 yaml 键
 *   形）；**缺省回落值仅测试与缺键防倒退用**（生产路径 CardForm 恒传 t——zh 界面真渲染
 *   中文人话，AC7）。本模块是纯 TS 非组件（不能用 hook），t 由组件层解析后传入
 *   （CardForm 自订 resolvedLocale，WorkingStyleSection 自含订阅先例）。
 *
 * 词表（vocabKey）：指向 shared-contracts 的 9 个分类词表常量（先验非门禁、开放输入——
 * schema 语义是自由 string，词表只作 UI 建议项）。`vocabFor(key)` 返回实值供 chips /
 * datalist 建议。
 */

import type { AssetCard } from '@orison/shared-contracts';
import {
  assetCardStatusSchema,
  CORE_FIELD_SPEC,
  GOLDEN_FINGER_ESSENCE_VOCAB,
  GOLDEN_FINGER_TYPE_VOCAB,
  LOCATION_TYPE_VOCAB,
  LORE_TYPE_VOCAB,
  ORGANIZATION_TYPE_VOCAB,
  POWER_SYSTEM_TYPE_VOCAB,
  PROP_TYPE_VOCAB,
  RULE_TYPE_VOCAB,
  VISUAL_MOTIF_TYPE_VOCAB,
} from '@orison/shared-contracts';

/** 8 类卡类型判别字面量（AssetCard discriminatedUnion 的 type 臂）。 */
export type AssetCardType = AssetCard['type'];

/**
 * 控件类型。`'boolean'` 是 z.boolean() 叶的控件（当前唯一实例 golden_finger.basics.unique；
 * 经 select 词表字符串伪装会写坏 schema）。`'kv'` 保留给 details 自由表（CardForm 内置
 * KvTable 渲染，spec 条目不使用）。
 */
export type FieldControl = 'text' | 'textarea' | 'number' | 'select' | 'string[]' | 'boolean' | 'kv';

/** 词表键 → shared-contracts 词表常量。 */
export type VocabKey =
  | 'POWER_SYSTEM'
  | 'LOCATION'
  | 'PROP'
  | 'ORGANIZATION'
  | 'RULE'
  | 'VISUAL_MOTIF'
  | 'LORE'
  | 'GOLDEN_FINGER'
  | 'GOLDEN_FINGER_ESSENCE';

export interface FieldSpecEntry {
  /** 卡上点路径（如 'personality.coreTraits'、顶层字段单段如 'landmarks'）。 */
  path: string;
  control: FieldControl;
  /** select/chips 建议词表（开放输入非门禁——schema 语义）。 */
  vocabKey?: VocabKey;
  /** number 钳制（如 emotionElasticity 0-1）。 */
  min?: number;
  max?: number;
}

/** key = 组标识（i18n `settingPage.group.<key>`；单字段组 key = 字段名）。 */
export interface GroupSpec {
  key: string;
  fields: readonly FieldSpecEntry[];
}

/** groups 组序 = 显示序（主显组在前）。 */
export interface TypeFieldSpec {
  groups: readonly GroupSpec[];
}

export const VOCAB_REGISTRY: Record<VocabKey, ReadonlyArray<{ value: string; gloss: string }>> = {
  POWER_SYSTEM: POWER_SYSTEM_TYPE_VOCAB,
  LOCATION: LOCATION_TYPE_VOCAB,
  PROP: PROP_TYPE_VOCAB,
  ORGANIZATION: ORGANIZATION_TYPE_VOCAB,
  RULE: RULE_TYPE_VOCAB,
  VISUAL_MOTIF: VISUAL_MOTIF_TYPE_VOCAB,
  LORE: LORE_TYPE_VOCAB,
  GOLDEN_FINGER: GOLDEN_FINGER_TYPE_VOCAB,
  GOLDEN_FINGER_ESSENCE: GOLDEN_FINGER_ESSENCE_VOCAB,
};

/** select/chips 建议词表实值（词表只是建议，输入开放）。 */
export function vocabFor(key: VocabKey | undefined): ReadonlyArray<{ value: string; gloss: string }> {
  return key ? VOCAB_REGISTRY[key] : [];
}

/**
 * status 枚举（卡头 select）——**shared-contracts 单源**（CR P10：手抄四值与 schema 漂移
 * 无对拍守门；schema 加值时 select/徽标/落盘自动跟随）。注意卡 status 的 'locked' 与
 * field 级 locked 是两个概念。
 */
export const STATUS_VALUES = assetCardStatusSchema.options;
export type AssetCardStatus = (typeof STATUS_VALUES)[number];

/** tier 三态（卡头 segmented；未标走 resolveTier 结构默认）。 */
export const TIER_VALUES = ['core', 'micro'] as const;

// ── 条目速写（纯数据构造，spec 表保持紧凑）──
const txt = (path: string): FieldSpecEntry => ({ path, control: 'text' });
const area = (path: string): FieldSpecEntry => ({ path, control: 'textarea' });
const arr = (path: string): FieldSpecEntry => ({ path, control: 'string[]' });
const num = (path: string, min: number, max: number): FieldSpecEntry => ({ path, control: 'number', min, max });
const sel = (path: string, vocabKey: VocabKey): FieldSpecEntry => ({ path, control: 'select', vocabKey });
const bool = (path: string): FieldSpecEntry => ({ path, control: 'boolean' });
const grp = (key: string, fields: readonly FieldSpecEntry[]): GroupSpec => ({ key, fields });

// ── 4 公共 sub-schema 组（所有 8 类共享，追加于 per-type 组后；secrets 恒主显——信息差域强调，
//    mockup 定稿「秘密」在主显区双栏并排）──
const COMMON_GROUPS: readonly GroupSpec[] = [
  grp('narrative', [txt('narrative.storyFunction'), txt('narrative.coreConflict')]),
  grp('writingCheatSheet', [
    txt('writingCheatSheet.firstImpression'),
    arr('writingCheatSheet.recurringImagery'),
    arr('writingCheatSheet.vocabulary.verbs'),
    arr('writingCheatSheet.vocabulary.adjectives'),
    arr('writingCheatSheet.vocabulary.metaphors'),
    arr('writingCheatSheet.vocabulary.forbidden'),
  ]),
  grp('secrets', [area('secrets.surface'), area('secrets.truth')]),
  grp('worldAndCanon', [arr('worldAndCanon.localRules'), arr('worldAndCanon.canonAnchors')]),
];

// ── base 编辑组（summary/tags/sourceRefs/firstAppearance；id/type/status/tier/relationships/
//    details 不进 spec，见文件头注）──
const BASE_GROUP: GroupSpec = grp('base', [
  area('summary'),
  arr('tags'),
  arr('sourceRefs'),
  txt('firstAppearance'),
]);

// ── per-type 组（组序 = 显示序：主显组在前——对齐 CORE_FIELD_SPEC coreFields 涉及的组；
//    character 组间细序按 mockup 定稿「性格 → 欲望底线」，其余类型按 CORE_FIELD_SPEC
//    coreFields 首现序；其后 per-type 次显组按 schema 声明序）──
const PER_TYPE_GROUPS: Record<AssetCardType, readonly GroupSpec[]> = {
  character: [
    grp('personality', [
      arr('personality.coreTraits'),
      txt('personality.surface'),
      txt('personality.innerTruth'),
      arr('personality.strengths'),
      arr('personality.weaknesses'),
      num('personality.emotionElasticity', 0, 1),
    ]),
    grp('desireAndBottomline', [
      txt('desireAndBottomline.coreDesire'),
      txt('desireAndBottomline.coreFear'),
      arr('desireAndBottomline.oocAnchors'),
    ]),
    grp('basics', [
      arr('basics.aliases'),
      txt('basics.gender'),
      txt('basics.orientation'),
      txt('basics.age'),
      txt('basics.race'),
      txt('basics.occupation'),
      txt('basics.faction'),
    ]),
    grp('abilities', [arr('abilities.core'), txt('abilities.cost')]),
    grp('voice', [txt('voice.speechStyle'), txt('voice.behaviorStyle')]),
    grp('background', [arr('background.keyPastEvents')]),
    grp('fanficCanon', [
      txt('fanficCanon.canonRef'),
      txt('fanficCanon.consistency'),
      txt('fanficCanon.deviation'),
    ]),
  ],
  location: [
    grp('basics', [
      arr('basics.aliases'),
      sel('basics.type', 'LOCATION'),
      txt('basics.scale'),
      txt('basics.region'),
    ]),
    grp('environment', [
      txt('environment.terrain'),
      txt('environment.climate'),
      txt('environment.palette'),
      txt('environment.lighting'),
      txt('environment.sound'),
      txt('environment.smell'),
      arr('environment.moodKeywords'),
    ]),
    grp('landmarks', [arr('landmarks')]),
    grp('ecology', [txt('ecology.economy'), txt('ecology.society'), txt('ecology.culture')]),
    grp('history', [
      area('history.origin'),
      arr('history.keyPastEvents'),
      txt('history.currentSituation'),
    ]),
  ],
  prop: [
    grp('basics', [
      arr('basics.aliases'),
      sel('basics.type', 'PROP'),
      txt('basics.rarity'),
      txt('basics.system'),
    ]),
    grp('mechanics', [
      txt('mechanics.coreFunction'),
      area('mechanics.workingPrinciple'),
      area('mechanics.useConditions'),
      area('mechanics.limitations'),
    ]),
    grp('appearance', [
      txt('appearance.dimensions'),
      txt('appearance.visual'),
      txt('appearance.sound'),
      txt('appearance.touch'),
      txt('appearance.smell'),
      arr('appearance.moodKeywords'),
    ]),
    grp('origin', [
      area('origin.creation'),
      arr('origin.keyPastEvents'),
      txt('origin.currentState'),
    ]),
    grp('value', [txt('value.economic'), txt('value.scarcity'), arr('value.demanders')]),
    grp('socioCulture', [
      txt('socioCulture.symbolism'),
      txt('socioCulture.perception'),
      arr('socioCulture.culturalLinks'),
    ]),
  ],
  organization: [
    grp('basics', [
      arr('basics.aliases'),
      txt('basics.shortName'),
      sel('basics.type', 'ORGANIZATION'),
      txt('basics.scale'),
      txt('basics.domain'),
      txt('basics.headquarters'),
    ]),
    grp('ideology', [
      txt('ideology.coreBelief'),
      txt('ideology.goalHierarchy'),
      txt('ideology.publicImage'),
      txt('ideology.hiddenFace'),
      arr('ideology.bottomLine'),
      arr('ideology.internalDisputes'),
    ]),
    grp('structure', [
      txt('structure.powerStructure'),
      txt('structure.decisionMechanism'),
      arr('structure.factions'),
    ]),
    grp('resources', [
      txt('resources.manpower'),
      txt('resources.economy'),
      txt('resources.military'),
      txt('resources.technology'),
      txt('resources.intelligence'),
    ]),
    grp('history', [area('history.origin'), arr('history.keyPastEvents')]),
    grp('culture', [
      arr('culture.symbols'),
      txt('culture.internalCulture'),
      arr('culture.taboos'),
    ]),
    grp('memberProfile', [txt('memberProfile')]),
  ],
  rule: [
    grp('definition', [
      area('definition.description'),
      area('definition.formalExpression'),
      txt('definition.nature'),
    ]),
    grp('boundaries', [
      area('boundaries.applicableBoundary'),
      arr('boundaries.knownExceptions'),
      arr('boundaries.loopholes'),
      arr('boundaries.paradoxes'),
    ]),
    grp('basics', [sel('basics.type', 'RULE'), txt('basics.scope'), txt('basics.level')]),
    grp('mechanism', [
      txt('mechanism.trigger'),
      area('mechanism.process'),
      txt('mechanism.result'),
      txt('mechanism.executor'),
    ]),
    grp('costs', [
      area('costs.violationConsequence'),
      txt('costs.exploitationCost'),
      txt('costs.abuseConsequence'),
    ]),
    grp('ecologicalImpact', [txt('ecologicalImpact')]),
    grp('cognition', [
      txt('cognition.levels'),
      arr('cognition.misconceptions'),
      txt('cognition.infoControl'),
    ]),
    grp('origin', [area('origin.origin'), arr('origin.keyPastEvents')]),
  ],
  visual_motif: [
    grp('basics', [
      sel('basics.type', 'VISUAL_MOTIF'),
      txt('basics.senseChannel'),
      txt('basics.level'),
      txt('basics.frequency'),
    ]),
    grp('definition', [
      txt('definition.coreImagery'),
      txt('definition.abstractMeaning'),
      area('definition.rationale'),
    ]),
    grp('narrativeFunction', [arr('narrativeFunction')]),
    grp('sensoryDetails', [
      txt('sensoryDetails.visual'),
      txt('sensoryDetails.sound'),
      txt('sensoryDetails.touch'),
      txt('sensoryDetails.smell'),
      txt('sensoryDetails.synesthesia'),
    ]),
    grp('variants', [arr('variants.list'), txt('variants.evolutionLogic')]),
    grp('themeMapping', [
      txt('themeMapping.surface'),
      txt('themeMapping.middle'),
      txt('themeMapping.deep'),
    ]),
    grp('designConstraints', [
      txt('designConstraints.antiAbuse'),
      arr('designConstraints.taboos'),
      txt('designConstraints.degradationWarning'),
    ]),
  ],
  lore: [
    grp('basics', [
      sel('basics.type', 'LORE'),
      txt('basics.genre'),
      txt('basics.spread'),
      txt('basics.credibility'),
      txt('basics.period'),
    ]),
    grp('truth', [txt('truth.levels'), txt('truth.gap'), arr('truth.evidence')]),
    grp('storyBody', [
      area('storyBody.fullVersion'),
      arr('storyBody.coreElements'),
      txt('storyBody.storyType'),
    ]),
    grp('versionSystem', [arr('versionSystem.versions'), txt('versionSystem.relations')]),
    grp('transmission', [
      txt('transmission.tellingMethod'),
      txt('transmission.distortionPattern'),
      txt('transmission.infoControl'),
    ]),
    grp('impact', [txt('impact')]),
    grp('unsolvedMysteries', [arr('unsolvedMysteries')]),
    grp('emotionalAtmosphere', [txt('emotionalAtmosphere')]),
  ],
  golden_finger: [
    grp('basics', [
      arr('basics.aliases'),
      sel('basics.type', 'GOLDEN_FINGER'),
      bool('basics.unique'),
      txt('basics.awakeningTime'),
      sel('basics.essence', 'GOLDEN_FINGER_ESSENCE'),
      txt('basics.packaging'),
    ]),
    grp('abilitySystem', [
      txt('abilitySystem.coreAbility'),
      arr('abilitySystem.derivedAbilities'),
      txt('abilitySystem.ultimateAbility'),
      area('abilitySystem.boundaries'),
    ]),
    grp('limitations', [
      area('limitations.hardLimits'),
      area('limitations.usageCost'),
      area('limitations.conditionLimits'),
      txt('limitations.cognitiveLimits'),
      area('limitations.emotionalMoralLimits'),
    ]),
    grp('growthSystem', [
      txt('growthSystem.mode'),
      txt('growthSystem.resources'),
      txt('growthSystem.stages'),
      txt('growthSystem.pacing'),
    ]),
    grp('origin', [area('origin.origin'), arr('origin.keyPastEvents')]),
    grp('worldRelation', [
      txt('worldRelation.legality'),
      txt('worldRelation.powerSystemPosition'),
      txt('worldRelation.uniqueness'),
    ]),
    grp('holderRelation', [
      area('holderRelation.attitudeEvolution'),
      txt('holderRelation.dependency'),
      txt('holderRelation.identity'),
      txt('holderRelation.sentience'),
    ]),
    grp('balance', [
      txt('balance.coreLogic'),
      area('balance.mechanism'),
      area('balance.unsolvableDilemma'),
      area('balance.shuangdianAndNuedian'),
    ]),
  ],
};

// ── SKIP_OBJECT_ARRAYS：object 数组字段清单（不进 spec，CardForm 只读占位）──
// 当前为空（见文件头注）；schema 新增 object 数组叶时反向对拍测试会红，把路径登进这里。
export const SKIP_OBJECT_ARRAYS: Readonly<Record<AssetCardType, readonly string[]>> = {
  character: [],
  location: [],
  prop: [],
  organization: [],
  rule: [],
  visual_motif: [],
  lore: [],
  golden_finger: [],
};

/** FIELD_SPEC = per-type 组 + 4 公共组 + base 组（全 8 类物化，组序即显示序）。 */
export const FIELD_SPEC: Record<AssetCardType, TypeFieldSpec> = {
  character: { groups: [...PER_TYPE_GROUPS.character, ...COMMON_GROUPS, BASE_GROUP] },
  location: { groups: [...PER_TYPE_GROUPS.location, ...COMMON_GROUPS, BASE_GROUP] },
  prop: { groups: [...PER_TYPE_GROUPS.prop, ...COMMON_GROUPS, BASE_GROUP] },
  organization: { groups: [...PER_TYPE_GROUPS.organization, ...COMMON_GROUPS, BASE_GROUP] },
  rule: { groups: [...PER_TYPE_GROUPS.rule, ...COMMON_GROUPS, BASE_GROUP] },
  visual_motif: { groups: [...PER_TYPE_GROUPS.visual_motif, ...COMMON_GROUPS, BASE_GROUP] },
  lore: { groups: [...PER_TYPE_GROUPS.lore, ...COMMON_GROUPS, BASE_GROUP] },
  golden_finger: { groups: [...PER_TYPE_GROUPS.golden_finger, ...COMMON_GROUPS, BASE_GROUP] },
};

/**
 * 主显组判定：CORE_FIELD_SPEC[type].coreFields 涉及的组（首段 = 组 key）为主显——
 * 单一真相源，不重复维护清单。`secrets` 恒主显（mockup 定稿：信息差域双栏强调）。
 */
export function isMainGroup(type: AssetCardType, groupKey: string): boolean {
  if (groupKey === 'secrets') return true;
  const core = CORE_FIELD_SPEC[type];
  return core.coreFields.some((f) => f.path[0] === groupKey);
}

/**
 * 显示序（单一出口，CardForm 消费）：主显组在前（稳定排序——组间保持 spec 声明相对序，
 * secrets 作公共组尾部主显自然落在 per-type 主显之后，mockup 定稿「性格 → 欲望底线 →
 * 秘密 → 折叠区」形态），次显组随后。
 */
export function displayGroups(type: AssetCardType): readonly GroupSpec[] {
  return [...FIELD_SPEC[type].groups].sort(
    (a, b) => Number(!isMainGroup(type, a.key)) - Number(!isMainGroup(type, b.key)),
  );
}

/** 卡上存在、且在 SKIP_OBJECT_ARRAYS 清单内的字段 → CardForm 只读占位（不改值）。 */
export function objectArrayPlaceholders(card: AssetCard, t?: Translate): Array<{ path: string; label: string }> {
  const skip = SKIP_OBJECT_ARRAYS[card.type as AssetCardType];
  if (!skip) return [];
  return skip
    .filter((path) => getPathPresence(card, path))
    .map((path) => ({ path, label: labelFor(card.type as AssetCardType, path, t) }));
}

function getPathPresence(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur !== undefined;
}

// ── 标签出口（i18n 唯一 seam；缺省回落仅测试/缺键防倒退用，生产路径 CardForm 恒传 t）──

/** 译者面结构类型（useI18n.t / translate 的签名——组件层解析后传入，本模块保持纯 TS）。 */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

function humanize(segment: string): string {
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** 字段标签：传入 t → translate（fieldI18nKey 路由公共/base 命名空间）；缺省回落 path 末段驼峰转空格。 */
export function labelFor(_type: AssetCardType, path: string, t?: Translate): string {
  if (t) return t(fieldI18nKey(_type, path));
  const segments = path.split('.');
  return humanize(segments[segments.length - 1]);
}

/** 组标题：传入 t → translate(groupI18nKey)；缺省回落 key 驼峰转空格。 */
export function groupLabelFor(key: string, t?: Translate): string {
  if (t) return t(groupI18nKey(key));
  return humanize(key);
}

const TYPE_LABELS: Record<AssetCardType, string> = {
  character: '人物',
  location: '地点',
  prop: '道具',
  organization: '组织',
  rule: '规则',
  visual_motif: '视觉母题',
  lore: '传说',
  golden_finger: '金手指',
};

/** 卡类型徽标（键 settingPage.type.<type>）。 */
export function typeLabelFor(type: AssetCardType, t?: Translate): string {
  if (t) return t(typeI18nKey(type));
  return TYPE_LABELS[type];
}

const STATUS_LABELS: Record<AssetCardStatus, string> = {
  draft: '草稿',
  active: '生效',
  deprecated: '废弃',
  locked: '锁定',
};

/** 卡状态标签（键 settingPage.status.<value>；卡 status 的「锁定」≠ field 级锁定）。 */
export function statusLabelFor(status: AssetCardStatus, t?: Translate): string {
  if (t) return t(statusI18nKey(status));
  return STATUS_LABELS[status];
}

/** tier 标签（键 settingPage.tier.<value>）。 */
export function tierLabelFor(tier: 'core' | 'micro', t?: Translate): string {
  if (t) return t(tierI18nKey(tier));
  return tier === 'core' ? '核心' : '次要';
}

/** tier「未标」段标签（键 settingPage.tier.unset）。 */
export function tierUnsetLabel(t?: Translate): string {
  return t ? t('settingPage.tier.unset') : '未标';
}

/** tier 未标时结构默认的「默认」角标（键 settingPage.tier.defaultBadge）。 */
export function tierDefaultBadgeLabel(t?: Translate): string {
  return t ? t('settingPage.tier.defaultBadge') : '默认';
}

/** details 自由键值表组标题（键 settingPage.group.details）。 */
export function detailsGroupLabel(t?: Translate): string {
  return t ? t(groupI18nKey('details')) : '自由补充';
}

/** object 数组占位行说明（键 settingPage.fieldUnsupported）。 */
export function unsupportedFieldNote(t?: Translate): string {
  return t ? t('settingPage.fieldUnsupported') : '（暂不支持表单编辑）';
}

/** 底部删除按钮（键 settingPage.action.delete）。 */
export function deleteCardLabel(t?: Translate): string {
  return t ? t('settingPage.action.delete') : '删除这张卡';
}

/** chips 添加输入占位（键 settingPage.addChip）。 */
export function addChipPlaceholder(t?: Translate): string {
  return t ? t('settingPage.addChip') : '＋ 添加';
}

/** kv 表添加行（键 settingPage.kvAddRow）。 */
export function kvAddRowLabel(t?: Translate): string {
  return t ? t('settingPage.kvAddRow') : '＋ 添加字段';
}

// ── 无视觉文案的 aria 标签（AC7 中文化纪律同等适用——读屏文案不算代码标识符）──

/** kv 表第 index 行（1 基）键输入 aria（键 settingPage.kvKeyAria）。 */
export function kvKeyAriaLabel(t: Translate | undefined, index: number): string {
  return t ? t('settingPage.kvKeyAria', { index }) : `键 ${index}`;
}

/** kv 表第 index 行（1 基）值输入 aria（键 settingPage.kvValueAria）。 */
export function kvValueAriaLabel(t: Translate | undefined, index: number): string {
  return t ? t('settingPage.kvValueAria', { index }) : `值 ${index}`;
}

/** kv 表第 index 行（1 基）删行钮 aria（键 settingPage.kvDeleteAria）。 */
export function kvDeleteAriaLabel(t: Translate | undefined, index: number): string {
  return t ? t('settingPage.kvDeleteAria', { index }) : `删除第 ${index} 行`;
}

/** kv 表重复键行的提示 title（键 settingPage.kvDuplicateKey；CR P9② 后行标记）。 */
export function kvDuplicateKeyTitle(t: Translate | undefined): string {
  return t ? t('settingPage.kvDuplicateKey') : '与上方行键重复（生效的是首行）';
}

/** chips 删除钮 aria（键 settingPage.chipRemoveAria；item = chip 文本）。 */
export function chipRemoveAriaLabel(t: Translate | undefined, item: string): string {
  return t ? t('settingPage.chipRemoveAria', { item }) : `删除 ${item}`;
}

// ── i18n 键位派生（yaml 键形；design §4：`settingPage.field.<type>.<path 换点为短横>`）──
// 命名空间路由（A3 yaml 实况）：4 公共组字段在 field.common.*（虚拟 type='common'，全 8 类
// 共键）；base 编辑组字段在 field.base.*；其余按真实 type。无路由直拼会在 common/base 上显
// 裸键名——test/fieldSpec.fieldKeys.test.ts 逐字段对拍守死。
const COMMON_GROUP_PATH_PREFIXES = ['narrative.', 'writingCheatSheet.', 'secrets.', 'worldAndCanon.'];
const BASE_FIELD_PATHS = new Set(['summary', 'tags', 'sourceRefs', 'firstAppearance']);

export function fieldI18nKey(type: AssetCardType, path: string): string {
  const hyphened = path.replace(/\./g, '-');
  if (COMMON_GROUP_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return `settingPage.field.common.${hyphened}`;
  }
  if (BASE_FIELD_PATHS.has(path)) {
    return `settingPage.field.base.${hyphened}`;
  }
  return `settingPage.field.${type}.${hyphened}`;
}
export function groupI18nKey(groupKey: string): string {
  return `settingPage.group.${groupKey}`;
}
export function typeI18nKey(type: AssetCardType): string {
  return `settingPage.type.${type}`;
}
export function statusI18nKey(status: AssetCardStatus): string {
  return `settingPage.status.${status}`;
}
export function tierI18nKey(tier: 'core' | 'micro'): string {
  return `settingPage.tier.${tier}`;
}
