/**
 * FIELD_SPEC ↔ Zod schema 双向对拍（task 08-30-asset-cards-visualization A2 波，design §4
 * 「防漂移对拍测试（双向）」；方法参照 spec/core/interface-contracts.md 契约对拍纪律——
 * 两份手工维护的真相源（schema 与表单规格）必须有机器对拍守死，加字段漏登记即红）。
 *
 * - 正向：FIELD_SPEC 每类每条 path 逐段 walk 对应 discriminatedUnion variant 的 shape，
 *   必须存在且叶类型与 control 匹配（string→text/textarea/select、string[]、number、boolean）。
 * - 反向：每类 schema 可编辑叶字段（排除 base 结构键 + 4 公共组键——公共/base 在专门段
 *   统一对拍）必须出现在 FIELD_SPEC；object 数组叶必须登记进 SKIP_OBJECT_ARRAYS。
 * - SKIP 清单防「假跳过」：清单内每项必须真实存在于 schema 且叶确为 object[]。
 * - 公共组 / base 组全覆盖；vocabKey 有效；无重复 path/组键；kv 保留位不出现在条目。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assetCardSchema,
  narrativeSchema,
  secretsSchema,
  worldAndCanonSchema,
  writingCheatSheetSchema,
} from '@orison/shared-contracts';
import {
  FIELD_SPEC,
  SKIP_OBJECT_ARRAYS,
  VOCAB_REGISTRY,
  displayGroups,
  groupLabelFor,
  isMainGroup,
  labelFor,
  objectArrayPlaceholders,
  vocabFor,
} from '../src/features/setting/fieldSpec';
import type { FieldControl } from '../src/features/setting/fieldSpec';

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

// ── Zod walk 工具（unwrap optional/nullish → object 递归 / array 与原语为叶）──

function unwrap(s: z.ZodTypeAny): z.ZodTypeAny {
  let cur = s;
  for (;;) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) {
      cur = cur.unwrap();
    } else if (cur instanceof z.ZodDefault) {
      // tags/sourceRefs 等带 .default([]) 的字段（ZodDefault 无 unwrap，用 removeDefault）
      cur = cur.removeDefault();
    } else {
      return cur;
    }
  }
}

type LeafKind = 'string' | 'number' | 'boolean' | 'string[]' | 'object[]' | 'object' | 'other';

function leafKind(s: z.ZodTypeAny): LeafKind {
  const t = unwrap(s);
  if (t instanceof z.ZodString) return 'string';
  if (t instanceof z.ZodNumber) return 'number';
  if (t instanceof z.ZodBoolean) return 'boolean';
  if (t instanceof z.ZodArray) {
    const el = leafKind(t.element);
    if (el === 'string') return 'string[]';
    if (el === 'object') return 'object[]';
    return 'other';
  }
  if (t instanceof z.ZodObject) return 'object';
  return 'other';
}

interface Leaf {
  path: string;
  kind: LeafKind;
}

function collectLeaves(shape: Record<string, z.ZodTypeAny>, prefix = ''): Leaf[] {
  const out: Leaf[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const t = unwrap(schema);
    if (t instanceof z.ZodObject) {
      out.push(...collectLeaves(t.shape, path));
    } else {
      out.push({ path, kind: leafKind(schema) });
    }
  }
  return out;
}

/** 点路径逐段 walk shape；不存在 / 中途非 object → undefined。 */
function walkLeaf(shape: Record<string, z.ZodTypeAny>, path: string): Leaf | undefined {
  const segs = path.split('.');
  let curShape = shape;
  let schema: z.ZodTypeAny | undefined;
  for (let i = 0; i < segs.length; i++) {
    schema = curShape[segs[i]];
    if (!schema) return undefined;
    if (i < segs.length - 1) {
      const t = unwrap(schema);
      if (!(t instanceof z.ZodObject)) return undefined;
      curShape = t.shape;
    }
  }
  return schema ? { path, kind: leafKind(schema) } : undefined;
}

// ── variant shape 提取（discriminatedUnion options → type literal → shape）──

const variantShapes: Record<string, Record<string, z.ZodTypeAny>> = {};
{
  const options = (assetCardSchema as unknown as { options: readonly z.ZodObject<z.ZodRawShape>[] })
    .options;
  for (const variant of options) {
    const typeField = unwrap(variant.shape.type);
    if (typeField instanceof z.ZodLiteral) {
      variantShapes[typeField.value as string] = variant.shape as Record<string, z.ZodTypeAny>;
    }
  }
}

// base 结构键（卡头/单独渲染，不进 spec——见 fieldSpec.ts 头注）+ 4 公共组键（专门段对拍）。
const EXCLUDED_TOP_KEYS = new Set([
  'id',
  'type',
  'name',
  'status',
  'tier',
  'tags',
  'details',
  'relationships',
  'summary',
  'sourceRefs',
  'firstAppearance',
  'narrative',
  'writingCheatSheet',
  'secrets',
  'worldAndCanon',
]);

const CONTROL_KIND: Record<Exclude<FieldControl, 'kv'>, readonly LeafKind[]> = {
  text: ['string'],
  textarea: ['string'],
  select: ['string'],
  'string[]': ['string[]'],
  number: ['number'],
  boolean: ['boolean'],
};

function specEntries(type: string) {
  return FIELD_SPEC[type as keyof typeof FIELD_SPEC].groups.flatMap((g) => [...g.fields]);
}
function specPaths(type: string): string[] {
  return specEntries(type).map((f) => f.path);
}

describe('FIELD_SPEC ↔ schema 双向对拍', () => {
  it('discriminatedUnion 8 variant 全部提取到 shape', () => {
    expect(Object.keys(variantShapes).sort()).toEqual([...CARD_TYPES].sort());
  });

  it('正向：每条 spec path walk variant shape 存在，叶类型与 control 匹配', () => {
    for (const type of CARD_TYPES) {
      const shape = variantShapes[type];
      for (const entry of specEntries(type)) {
        const leaf = walkLeaf(shape, entry.path);
        expect(leaf, `${type} spec path 不存在于 schema: ${entry.path}`).toBeDefined();
        if (!leaf) continue;
        if (entry.control === 'kv') continue; // kv 保留位另有专测
        const allowed = CONTROL_KIND[entry.control];
        expect(
          allowed.includes(leaf.kind),
          `${type} ${entry.path} control=${entry.control} 与 schema 叶 ${leaf.kind} 不匹配`,
        ).toBe(true);
      }
    }
  });

  it('反向：每类 per-type schema 叶字段全覆盖（schema → spec）', () => {
    for (const type of CARD_TYPES) {
      const paths = new Set(specPaths(type));
      const skip = new Set(SKIP_OBJECT_ARRAYS[type]);
      const perTypeLeaves = collectLeaves(variantShapes[type]).filter(
        (leaf) => !EXCLUDED_TOP_KEYS.has(leaf.path.split('.')[0]),
      );
      expect(perTypeLeaves.length, `${type} per-type 叶不应为空（schema 解析异常）`).toBeGreaterThan(0);
      for (const leaf of perTypeLeaves) {
        if (leaf.kind === 'object[]') {
          expect(
            skip.has(leaf.path),
            `${type} object 数组叶 ${leaf.path} 未登记进 SKIP_OBJECT_ARRAYS（无安全控件）`,
          ).toBe(true);
          continue;
        }
        expect(
          paths.has(leaf.path),
          `${type} schema 字段 ${leaf.path}（${leaf.kind}）漏进 FIELD_SPEC`,
        ).toBe(true);
      }
    }
  });

  it('反向补充：per-type 叶无未知形态（新叶类型出现即红，逼控件决策）', () => {
    const KNOWN: readonly LeafKind[] = ['string', 'number', 'boolean', 'string[]', 'object[]'];
    for (const type of CARD_TYPES) {
      const perTypeLeaves = collectLeaves(variantShapes[type]).filter(
        (leaf) => !EXCLUDED_TOP_KEYS.has(leaf.path.split('.')[0]),
      );
      for (const leaf of perTypeLeaves) {
        expect(KNOWN.includes(leaf.kind), `${type} ${leaf.path} 出现未决策叶形态 ${leaf.kind}`).toBe(true);
      }
    }
  });

  it('SKIP_OBJECT_ARRAYS 防假跳过：清单内每项真实存在于 schema 且叶为 object[]', () => {
    for (const type of CARD_TYPES) {
      for (const path of SKIP_OBJECT_ARRAYS[type]) {
        const leaf = walkLeaf(variantShapes[type], path);
        expect(leaf, `${type} SKIP 路径不存在于 schema（假跳过）: ${path}`).toBeDefined();
        expect(leaf?.kind, `${type} SKIP 路径 ${path} 叶不是 object[]（应进 spec）`).toBe('object[]');
      }
    }
  });

  it('spec 条目与 SKIP 清单不重叠', () => {
    for (const type of CARD_TYPES) {
      const skip = new Set(SKIP_OBJECT_ARRAYS[type]);
      for (const path of specPaths(type)) {
        expect(skip.has(path), `${type} ${path} 同时在 spec 与 SKIP`).toBe(false);
      }
    }
  });

  describe('公共组对拍（4 sub-schema 双向全覆盖）', () => {
    const COMMON_SUBSCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
      narrative: narrativeSchema,
      writingCheatSheet: writingCheatSheetSchema,
      secrets: secretsSchema,
      worldAndCanon: worldAndCanonSchema,
    };

    for (const type of CARD_TYPES) {
      it(`${type}：4 公共组条目与 sub-schema 叶集双向相等且叶类型匹配`, () => {
        const groups = FIELD_SPEC[type].groups;
        // 公共组恰各一份
        for (const name of Object.keys(COMMON_SUBSCHEMAS)) {
          const found = groups.filter((g) => g.key === name);
          expect(found.length, `${type} 公共组 ${name} 应恰一份`).toBe(1);
        }
        for (const [name, sub] of Object.entries(COMMON_SUBSCHEMAS)) {
          const group = groups.find((g) => g.key === name)!;
          const schemaLeaves = collectLeaves(sub.shape as Record<string, z.ZodTypeAny>);
          const schemaPaths = schemaLeaves.map((l) => l.path).sort();
          const specPathsStripped = group.fields.map((f) => f.path.slice(name.length + 1)).sort();
          expect(specPathsStripped, `${type}.${name} spec 与 sub-schema 叶集不相等`).toEqual(schemaPaths);
          // 叶类型逐条匹配（walk sub-schema shape）
          for (const entry of group.fields) {
            const leaf = walkLeaf(sub.shape as Record<string, z.ZodTypeAny>, entry.path.slice(name.length + 1));
            expect(leaf, `${type}.${entry.path} 在 ${name} sub-schema 中不存在`).toBeDefined();
            if (leaf && entry.control !== 'kv') {
              expect(CONTROL_KIND[entry.control].includes(leaf.kind), `${type}.${entry.path} control 与叶不匹配`).toBe(true);
            }
          }
        }
      });
    }
  });

  describe('base 编辑组对拍', () => {
    it('每类 base 组恰一份，4 键齐全（summary/tags/sourceRefs/firstAppearance）', () => {
      const expected = ['firstAppearance', 'sourceRefs', 'summary', 'tags'].sort();
      for (const type of CARD_TYPES) {
        const baseGroups = FIELD_SPEC[type].groups.filter((g) => g.key === 'base');
        expect(baseGroups.length).toBe(1);
        expect(baseGroups[0].fields.map((f) => f.path).sort()).toEqual(expected);
      }
    });
  });

  it('vocabKey 全部命中词表 registry（非空实值）', () => {
    expect(Object.keys(VOCAB_REGISTRY).length).toBe(9);
    for (const type of CARD_TYPES) {
      for (const entry of specEntries(type)) {
        if (entry.vocabKey) {
          expect(vocabFor(entry.vocabKey).length, `${type} ${entry.path} 词表 ${entry.vocabKey} 为空`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('无重复 path / 组 key 唯一 / kv 保留位不出现于条目', () => {
    for (const type of CARD_TYPES) {
      const groups = FIELD_SPEC[type].groups;
      const groupKeys = groups.map((g) => g.key);
      expect(new Set(groupKeys).size, `${type} 组 key 重复`).toBe(groupKeys.length);
      const paths = specPaths(type);
      expect(new Set(paths).size, `${type} 字段 path 重复`).toBe(paths.length);
      for (const entry of specEntries(type)) {
        expect(entry.control === 'kv', `${type} ${entry.path} 用了 kv 保留位（details 由内置 KvTable 渲染）`).toBe(false);
      }
    }
  });

  it('主显组判定：每类至少 1 个；secrets 恒主显（mockup 定稿）；显示序主显全在前', () => {
    for (const type of CARD_TYPES) {
      const mains = FIELD_SPEC[type].groups.filter((g) => isMainGroup(type, g.key));
      expect(mains.length, `${type} 无主显组`).toBeGreaterThan(0);
      expect(isMainGroup(type, 'secrets')).toBe(true);
      // displayGroups（显示序单一出口）：主显连续在前，且主显间保持 spec 声明相对序
      const display = displayGroups(type);
      const mainFlags = display.map((g) => isMainGroup(type, g.key));
      const firstSecondary = mainFlags.indexOf(false);
      if (firstSecondary !== -1) {
        expect(
          mainFlags.slice(firstSecondary).every((f) => !f),
          `${type} 显示序主显组未排在次显组之前`,
        ).toBe(true);
      }
      const displayMains = display.filter((g) => isMainGroup(type, g.key));
      expect(displayMains.map((g) => g.key)).toEqual(mains.map((g) => g.key));
      expect(display.length).toBe(FIELD_SPEC[type].groups.length);
    }
  });

  it('labelFor / groupLabelFor 回落：path 末段驼峰转空格', () => {
    expect(labelFor('character', 'personality.coreTraits')).toBe('Core Traits');
    expect(labelFor('character', 'writingCheatSheet.vocabulary.forbidden')).toBe('Forbidden');
    expect(labelFor('character', 'name')).toBe('Name');
    expect(groupLabelFor('desireAndBottomline')).toBe('Desire And Bottomline');
  });

  it('objectArrayPlaceholders：空清单 → 各类返回空', () => {
    for (const type of CARD_TYPES) {
      const card = { id: 'x', type, name: 'n' } as unknown as Parameters<typeof objectArrayPlaceholders>[0];
      expect(objectArrayPlaceholders(card)).toEqual([]);
    }
  });
});
