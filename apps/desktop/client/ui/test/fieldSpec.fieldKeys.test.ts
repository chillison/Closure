/**
 * FIELD_SPEC → settingPage.yaml 逐字段键对拍（task 08-30-asset-cards-visualization B 波，
 * dispatch 契约 3）。
 *
 * A3 波的 settingPageI18n.test.ts 只守**组级**覆盖 + 数量下限（宽松防漂移）；本测试补
 * **字段级**逐键对拍——fieldI18nKey 的命名空间路由（4 公共组 → field.common.*、base 编辑
 * 组 → field.base.*、其余按真实 type）任何一侧漂移（spec 加字段漏 yaml / yaml 键名拼错 /
 * 路由错层）在此红。标签出口传 t 走 translate 后，缺键 = 界面显裸键名（AC7 违约），必须
 * 机器守死（spec/core/interface-contracts 契约对拍纪律）。
 *
 * 直读 yaml 原文（?raw + js-yaml）探测完整键树——translate 缺键回落键名只能 probe 式
 * 探测，逐键对拍需要键集源头（settingPageI18n 同注记）。
 */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import zhRaw from '../src/shared/i18n/zh-CN/settingPage.yaml?raw';
import enRaw from '../src/shared/i18n/en-US/settingPage.yaml?raw';
import { translate } from '../src/shared/i18n/useI18n';
import {
  FIELD_SPEC,
  fieldI18nKey,
  groupI18nKey,
  groupLabelFor,
  labelFor,
  statusI18nKey,
  statusLabelFor,
  tierI18nKey,
  tierLabelFor,
  typeI18nKey,
  typeLabelFor,
} from '../src/features/setting/fieldSpec';

function flatten(node: unknown, prefix: string, out: Map<string, unknown>): void {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') flatten(value, path, out);
      else out.set(path, value);
    }
  }
}

const zhEntries = new Map<string, unknown>();
const enEntries = new Map<string, unknown>();
{
  // 从整档展平（键含 settingPage. 前缀——与派生键形一致）；文档根键 = settingPage。
  const zhDoc = yaml.load(zhRaw) as Record<string, unknown>;
  const enDoc = yaml.load(enRaw) as Record<string, unknown>;
  flatten(zhDoc, '', zhEntries);
  flatten(enDoc, '', enEntries);
}

const CARD_TYPES = Object.keys(FIELD_SPEC) as Array<keyof typeof FIELD_SPEC>;

describe('fieldSpec → yaml 逐字段键对拍（B 波契约 3）', () => {
  it('每类型每条字段 path 派生键在 zh/en 双侧在位且非空（含 common/base 命名空间路由）', () => {
    for (const type of CARD_TYPES) {
      for (const group of FIELD_SPEC[type].groups) {
        for (const entry of group.fields) {
          const key = fieldI18nKey(type, entry.path);
          for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
            expect(entries.has(key), `${locale} 缺字段键 ${key}（${type} ${entry.path}）`).toBe(true);
            const val = entries.get(key);
            expect(typeof val, `${locale} ${key} 值须为字符串`).toBe('string');
            expect(String(val).trim().length, `${locale} ${key} 文案为空`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('每类型每分组 key 派生键在 zh/en 双侧在位且非空', () => {
    for (const type of CARD_TYPES) {
      for (const group of FIELD_SPEC[type].groups) {
        const key = groupI18nKey(group.key);
        for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
          expect(entries.has(key), `${locale} 缺组键 ${key}（${type}）`).toBe(true);
          expect(String(entries.get(key)).trim().length, `${locale} ${key} 文案为空`).toBeGreaterThan(0);
        }
      }
    }
    // CardForm 内置 details 组（不在 FIELD_SPEC 条目内，组标题键独立消费）。
    expect(zhEntries.has(groupI18nKey('details'))).toBe(true);
    expect(enEntries.has(groupI18nKey('details'))).toBe(true);
  });

  it('命名空间路由：公共组字段 → field.common.*、base 字段 → field.base.*、per-type → 真实 type', () => {
    // 公共组（character 上样例——全 8 类同键）
    expect(fieldI18nKey('character', 'narrative.storyFunction')).toBe('settingPage.field.common.narrative-storyFunction');
    expect(fieldI18nKey('character', 'writingCheatSheet.vocabulary.forbidden')).toBe('settingPage.field.common.writingCheatSheet-vocabulary-forbidden');
    expect(fieldI18nKey('character', 'secrets.surface')).toBe('settingPage.field.common.secrets-surface');
    expect(fieldI18nKey('lore', 'worldAndCanon.canonAnchors')).toBe('settingPage.field.common.worldAndCanon-canonAnchors');
    // base 编辑组（点路径无嵌套，短横连接为 no-op）
    expect(fieldI18nKey('golden_finger', 'summary')).toBe('settingPage.field.base.summary');
    expect(fieldI18nKey('prop', 'firstAppearance')).toBe('settingPage.field.base.firstAppearance');
    // per-type 照实（含嵌套点路径）
    expect(fieldI18nKey('character', 'personality.coreTraits')).toBe('settingPage.field.character.personality-coreTraits');
    expect(fieldI18nKey('golden_finger', 'basics.essence')).toBe('settingPage.field.golden_finger.basics-essence');
    // 陷阱样例：lore 自有 truth 组（信息差核心）走 per-type 命名空间，不与公共组混淆
    expect(fieldI18nKey('lore', 'truth.levels')).toBe('settingPage.field.lore.truth-levels');
    expect(zhEntries.has('settingPage.field.lore.truth-levels')).toBe(true);
  });

  it('类型/状态/层级枚举键双侧在位', () => {
    for (const type of CARD_TYPES) {
      expect(zhEntries.has(typeI18nKey(type))).toBe(true);
      expect(enEntries.has(typeI18nKey(type))).toBe(true);
    }
    for (const status of ['draft', 'active', 'deprecated', 'locked'] as const) {
      expect(zhEntries.has(statusI18nKey(status))).toBe(true);
      expect(enEntries.has(statusI18nKey(status))).toBe(true);
    }
    for (const tier of ['core', 'micro'] as const) {
      expect(zhEntries.has(tierI18nKey(tier))).toBe(true);
      expect(enEntries.has(tierI18nKey(tier))).toBe(true);
    }
  });

  it('zh 实场渲染冒烟：传真 t 后标签非键名（labelFor/groupLabelFor/typeLabelFor 走 translate）', () => {
    // translate 通道（useI18n 模块级非 hook 面）：真渲染链 = labelFor(type, path, t)。
    const t = (key: string) => translate('zh-CN', key);
    // labelFor 经 t 路由（真渲染链）——核心断言：非键名、非英文 path 回落（AC7）。
    expect(labelFor('character', 'personality.coreTraits', t)).toBe('核心性格');
    expect(labelFor('character', 'secrets.surface', t)).toBe('表面');
    expect(labelFor('golden_finger', 'summary', t)).toBe('摘要');
    expect(groupLabelFor('secrets', t)).toBe('秘密');
    expect(typeLabelFor('golden_finger', t)).toBe('金手指');
    expect(statusLabelFor('deprecated', t)).toBe('废弃');
    expect(tierLabelFor('micro', t)).toBe('次要');
  });
});
