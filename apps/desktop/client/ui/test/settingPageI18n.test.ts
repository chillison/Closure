/**
 * settingPage i18n 齐平守卫（task 08-30-asset-cards-visualization A3）。
 *
 * 1. **zh/en 键齐平**：两 locale 的 settingPage.yaml 展平键集完全相等（结构性 diff——加键
 *    漏一侧即红；mirror worldStateI18n.test.ts 谱）。
 * 2. **页面壳键逐键在位**（组件实际消费清单——CR P8 后零备用键，死键即红）：title/tab/
 *    toolbar/filter/type×9/status×4/tier×4/empty/other/docs/action/locked 等——漏键 = 组件
 *    显裸键名。
 * 3. **nav.setting 两 locale 在位**（icon-rail 新钮）+ translate 通道冒烟（eager glob
 *    加载链真见到新文件，防放错目录/解析失败静默）。
 * 4. **词表防漂移（宽松）**：组键全集 = creative-fields.ts 8 个 *FieldsSchema 顶层键去重
 *    + 4 公共组 + base（精确集合相等）；每类型字段键至少覆盖该类全部组（每组 ≥1 键）且达到
 *    该类 schema leaf 字段数下限。严格 leaf 级双向对拍归 FIELD_SPEC 波的对拍测试，此处只守
 *    组级覆盖 + 数量下限。
 * 5. **插值占位完整**：deleteConfirm 带 {name}、create 带 {type}（两侧——丢占位 = 渲染裸模板）。
 *
 * 直读 yaml 原文（?raw + js-yaml）而非经 translate——结构比较需要完整键树，translate
 * 只能按点路径探测缺键（probe 式），结构性守卫用源头数据（mirror worldStateI18n 注记）。
 */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import zhRaw from '../src/shared/i18n/zh-CN/settingPage.yaml?raw';
import enRaw from '../src/shared/i18n/en-US/settingPage.yaml?raw';
import navZhRaw from '../src/shared/i18n/zh-CN/nav.yaml?raw';
import navEnRaw from '../src/shared/i18n/en-US/nav.yaml?raw';
import { translate } from '../src/shared/i18n/useI18n';

function flattenEntries(node: unknown, prefix: string, out: Map<string, unknown>): void {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') flattenEntries(value, path, out);
      else out.set(path, value);
    }
  }
}

const zhDoc = yaml.load(zhRaw) as Record<string, unknown>;
const enDoc = yaml.load(enRaw) as Record<string, unknown>;
const zhEntries = new Map<string, unknown>();
const enEntries = new Map<string, unknown>();
flattenEntries(zhDoc.settingPage, '', zhEntries);
flattenEntries(enDoc.settingPage, '', enEntries);

const CARD_TYPES = [
  'character',
  'location',
  'prop',
  'organization',
  'rule',
  'visual_motif',
  'lore',
  'golden_finger',
] as const;

// 组键全集（唯一权威 = packages/shared-contracts/src/contracts/creative-fields.ts：
// 8 个 *FieldsSchema 顶层键去重 + 4 公共 sub-schema 组 + base 编辑组 + details 自由键值组
// + relationships 只读占位组[CR P7——base 字段的 CardForm 只读摘要区]）。
const EXPECTED_GROUP_KEYS = [
  'abilities', 'abilitySystem', 'appearance', 'background', 'balance', 'base', 'basics',
  'boundaries', 'cognition', 'costs', 'culture', 'definition', 'desireAndBottomline',
  'designConstraints', 'details', 'ecologicalImpact', 'ecology', 'emotionalAtmosphere', 'environment',
  'fanficCanon', 'growthSystem', 'holderRelation', 'history', 'ideology', 'impact',
  'landmarks', 'limitations', 'mechanism', 'mechanics', 'memberProfile', 'narrative',
  'narrativeFunction', 'origin', 'personality', 'relationships', 'resources', 'secrets',
  'sensoryDetails', 'socioCulture', 'storyBody', 'structure', 'themeMapping', 'transmission',
  'truth', 'unsolvedMysteries', 'value', 'variants', 'versionSystem', 'voice', 'worldAndCanon',
  'worldRelation', 'writingCheatSheet',
];

// 每类型期望组 + 最小字段数（下限 = creative-fields.ts 该类 leaf 字段精确数；schema 加字段
// 不破下限、删字段/漏整组即红——宽松断言防漂移）。
const PER_TYPE_EXPECTATION: Record<(typeof CARD_TYPES)[number], { groups: string[]; minFields: number }> = {
  character: {
    groups: ['basics', 'personality', 'desireAndBottomline', 'abilities', 'voice', 'background', 'fanficCanon'],
    minFields: 24,
  },
  location: { groups: ['basics', 'environment', 'ecology', 'history', 'landmarks'], minFields: 18 },
  prop: { groups: ['basics', 'appearance', 'mechanics', 'origin', 'value', 'socioCulture'], minFields: 23 },
  organization: {
    groups: ['basics', 'ideology', 'structure', 'resources', 'history', 'culture', 'memberProfile'],
    minFields: 26,
  },
  rule: {
    groups: ['basics', 'definition', 'mechanism', 'boundaries', 'costs', 'ecologicalImpact', 'cognition', 'origin'],
    minFields: 23,
  },
  visual_motif: {
    groups: ['basics', 'definition', 'sensoryDetails', 'variants', 'narrativeFunction', 'themeMapping', 'designConstraints'],
    minFields: 21,
  },
  lore: {
    groups: ['basics', 'storyBody', 'versionSystem', 'transmission', 'truth', 'impact', 'unsolvedMysteries', 'emotionalAtmosphere'],
    minFields: 19,
  },
  golden_finger: {
    groups: ['basics', 'abilitySystem', 'growthSystem', 'limitations', 'origin', 'worldRelation', 'holderRelation', 'balance'],
    minFields: 32,
  },
};

const COMMON_GROUPS = ['narrative', 'writingCheatSheet', 'secrets', 'worldAndCanon'];
const BASE_FIELDS = ['summary', 'tags', 'sourceRefs', 'firstAppearance'];

// 页面壳键（组件实际消费清单——CR P8 定谳后逐键真实在组件引用，死键即红：saveRejected
// /docs.open 已删（失败反馈真通道 = creative.field.syncFailed toast / docs.openFailed）；
// relationships.readonlyHint / kvDuplicateKey 为 CR P7/P9 新增消费键）。
const SHELL_KEYS = [
  'title',
  'tab.cards',
  'tab.docs',
  'toolbar.newCard',
  'toolbar.searchPlaceholder',
  'filter.all',
  'filter.noMatch',
  ...CARD_TYPES.map((t) => `type.${t}`),
  'type.other',
  'status.draft',
  'status.active',
  'status.deprecated',
  'status.locked',
  'tier.core',
  'tier.micro',
  'tier.unset',
  'tier.defaultBadge',
  'empty.title',
  'empty.ctaAi',
  'empty.ctaManual',
  'selectHint',
  'head.name',
  'head.status',
  'head.tier',
  'other.readonlyHint',
  'docs.loading',
  'docs.empty',
  'docs.openFailed',
  'action.delete',
  'action.deleteConfirm',
  'action.create',
  'action.untitled',
  'addChip',
  'kvAddRow',
  'kvKeyAria',
  'kvValueAria',
  'kvDeleteAria',
  'kvDuplicateKey',
  'chipRemoveAria',
  'relationships.readonlyHint',
  'locked.banner',
  'locked.unlock',
  'fieldUnsupported',
];

/** 组 g 在该类型的字段键集内被覆盖（对象组 → `g-*` 前缀；顶层叶组 → 裸键 === g） */
function groupCovered(keys: string[], g: string): boolean {
  return keys.some((k) => k === g || k.startsWith(`${g}-`));
}

describe('settingPage i18n 齐平（zh/en）', () => {
  it('两 locale 键集完全相等（加键漏一侧即红）', () => {
    // 键树非空守门（防 yaml 解析失败静默过）：全词表量级 ~289 叶键。
    expect(zhEntries.size).toBeGreaterThan(280);
    expect(enEntries.size).toBe(zhEntries.size);
    expect([...zhEntries.keys()].sort()).toEqual([...enEntries.keys()].sort());
  });

  it('所有叶子值均为非空字符串', () => {
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      expect(entries.size).toBeGreaterThan(0);
      for (const [key, value] of entries) {
        expect(typeof value, `${locale} ${key} 值须为字符串（interpolate 契约）`).toBe('string');
        expect(String(value).trim().length, `${locale} ${key} 存在空文案值`).toBeGreaterThan(0);
      }
    }
  });

  it('页面壳键逐键在位（组件实际消费清单——缺键显裸键名）', () => {
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      for (const key of SHELL_KEYS) {
        expect(entries.has(key), `${locale} 缺页面壳键 ${key}（组件会显裸键名）`).toBe(true);
      }
    }
  });

  it('组键全集 = 8 类 *FieldsSchema 顶层键去重 + 4 公共组 + base（权威 creative-fields.ts）', () => {
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      const groupKeys = [...entries.keys()]
        .filter((k) => k.startsWith('group.'))
        .map((k) => k.slice('group.'.length))
        .sort();
      expect(groupKeys, `${locale} 组键全集与 schema 顶层组键漂移`).toEqual([...EXPECTED_GROUP_KEYS].sort());
    }
  });

  it('每类型字段覆盖其全部组（每组 ≥1 键）且达 schema leaf 数下限（宽松防漂移）', () => {
    for (const type of CARD_TYPES) {
      const prefix = `field.${type}.`;
      const keys = [...zhEntries.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      expect(
        keys.length,
        `${type} 字段键数量低于该类 schema leaf 数（${PER_TYPE_EXPECTATION[type].minFields}）`,
      ).toBeGreaterThanOrEqual(PER_TYPE_EXPECTATION[type].minFields);
      for (const g of PER_TYPE_EXPECTATION[type].groups) {
        expect(groupCovered(keys, g), `${type} 组 ${g} 无任何字段键`).toBe(true);
      }
    }
  });

  it('common 4 公共组覆盖 + base 编辑组 4 字段在位', () => {
    const commonKeys = [...zhEntries.keys()]
      .filter((k) => k.startsWith('field.common.'))
      .map((k) => k.slice('field.common.'.length));
    expect(commonKeys.length).toBeGreaterThanOrEqual(12);
    for (const g of COMMON_GROUPS) {
      expect(groupCovered(commonKeys, g), `common 组 ${g} 无字段键`).toBe(true);
    }
    for (const f of BASE_FIELDS) {
      expect(zhEntries.has(`field.base.${f}`), `base 缺字段键 ${f}`).toBe(true);
    }
  });

  it('插值占位完整（deleteConfirm 带 {name}、create/docs.openFailed 带 {type}/{name}、aria 键带 {index}/{item}，两侧）', () => {
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      expect(String(entries.get('action.deleteConfirm')), `${locale} deleteConfirm 丢 {name} 占位`).toContain('{name}');
      expect(String(entries.get('action.create')), `${locale} create 丢 {type} 占位`).toContain('{type}');
      expect(String(entries.get('docs.openFailed')), `${locale} docs.openFailed 丢 {name} 占位`).toContain('{name}');
      expect(String(entries.get('kvKeyAria')), `${locale} kvKeyAria 丢 {index} 占位`).toContain('{index}');
      expect(String(entries.get('kvValueAria')), `${locale} kvValueAria 丢 {index} 占位`).toContain('{index}');
      expect(String(entries.get('kvDeleteAria')), `${locale} kvDeleteAria 丢 {index} 占位`).toContain('{index}');
      expect(String(entries.get('chipRemoveAria')), `${locale} chipRemoveAria 丢 {item} 占位`).toContain('{item}');
    }
  });
});

describe('nav.setting（icon-rail 新钮）', () => {
  it('两 locale 在位非空（yaml 直读）', () => {
    const navZh = yaml.load(navZhRaw) as { nav?: Record<string, unknown> };
    const navEn = yaml.load(navEnRaw) as { nav?: Record<string, unknown> };
    for (const [locale, doc] of [['zh-CN', navZh], ['en-US', navEn]] as const) {
      const val = doc.nav?.setting;
      expect(typeof val, `${locale} nav.setting 缺失`).toBe('string');
      expect(String(val).trim().length, `${locale} nav.setting 不得为空`).toBeGreaterThan(0);
    }
  });

  it('translate 通道可解析（eager glob 加载链真见到新文件）', () => {
    // 缺键回落裸键名（translate fallback 契约）——等于键名即加载链没见到文件。
    expect(translate('zh-CN', 'nav.setting')).not.toBe('nav.setting');
    expect(translate('en-US', 'nav.setting')).not.toBe('nav.setting');
    expect(translate('zh-CN', 'settingPage.title')).not.toBe('settingPage.title');
    expect(translate('en-US', 'settingPage.type.golden_finger')).not.toBe('settingPage.type.golden_finger');
  });
});
