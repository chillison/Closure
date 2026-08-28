import { describe, expect, it } from 'vitest';
import {
  compileSettingContext,
  formatRetrievedSettings,
  SETTING_CONTEXT_LAYOUT,
  SUFFIX_BODY_EXCERPT_LIMIT,
  type SettingContextAssembly,
  type SettingPrefixInput,
  type EntryHit,
  type CraftHit,
  entryHitSchema,
  craftHitSchema,
  assetCardsSchema,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.3：动态后缀格式化器 + 顶层 compileSettingContext（design §3.3 / §3.4）单测。
// 纯函数（无 fs/db/LLM）-> plain vitest。覆盖：
// - formatRetrievedSettings：story/craft 两 kind / 空 hits / body 截断 + 指针 / entry_type 标注 / 空 body。
// - compileSettingContext：stablePrefix 来自 compileSettingPrefix / dynamicSuffix 拼接 / layout 契约 /
//   无检索时 suffix 空。
// 范式守卫（ADR-5）：本函数只 shaping，不做 retrieval 决策（无「检索什么」逻辑可测，仅测已检索结果 shaping）。
// ─────────────────────────────────────────────────────────────────────────────

/** 构建一个 story 检索 hit（EntryHit，经 schema.parse 得正确类型）。 */
function storyHit(overrides: Partial<Record<string, unknown>> = {}) {
  return entryHitSchema.parse({
    entryId: '00001:char_main',
    projectId: '00001',
    entryType: 'character',
    sourceKind: 'setting_card',
    name: '林动',
    bodyText: '坚韧的少年，背负家族兴衰。',
    visibility: 'known',
    score: 0.8,
    ...overrides,
  });
}

/** 构建一个 craft 检索 hit（CraftHit，经 schema.parse 得正确类型）。 */
function craftHit(overrides: Partial<Record<string, unknown>> = {}) {
  return craftHitSchema.parse({
    craftId: 'shuangdian-catalog',
    craftType: 'shuangdian',
    sourceKind: 'user',
    name: '爽点目录',
    bodyText: 'L1 机制层：先抑后扬 / 物品获得 / 养成 ...',
    score: 0.5,
    ...overrides,
  });
}

/** 最小 SettingPrefixInput（一张 core character 卡 -> stablePrefix 非空：目录 + core 卡项）。 */
function buildMinimalDoc(): SettingPrefixInput {
  return {
    asset_cards: assetCardsSchema.parse([
      { id: 'c1', type: 'character', name: '林动', tier: 'core', summary: '主角' },
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// formatRetrievedSettings
// ─────────────────────────────────────────────────────────────────────────────
describe('formatRetrievedSettings（Story 2.3 动态后缀格式化器）', () => {
  it('story kind：每条 hit -> `### {name} [{entryType}/{sourceKind}]` + body', () => {
    const result = formatRetrievedSettings([storyHit()], 'story');
    expect(result).toContain('### 林动 [character/setting_card]');
    expect(result).toContain('坚韧的少年，背负家族兴衰。');
  });

  it('craft kind：bracket 用 craftType（非 entryType）+ sourceKind', () => {
    const result = formatRetrievedSettings([craftHit()], 'craft');
    expect(result).toContain('### 爽点目录 [shuangdian/user]');
    expect(result).toContain('L1 机制层');
    // craft hit 无 entryType 字段；bracket 应是 craftType，不含 'character' 之类 entryType 值。
    expect(result).not.toContain('[character/');
  });

  it('多条 hit 以空行分隔（blocks join \\n\\n）', () => {
    const result = formatRetrievedSettings(
      [storyHit({ name: '甲' }), storyHit({ entryId: '00001:loc_1', name: '乙', entryType: 'location' })],
      'story',
    );
    expect(result).toContain('### 甲 [character/setting_card]');
    expect(result).toContain('### 乙 [location/setting_card]');
    expect(result).toMatch(/### 甲.*\n\n.*### 乙/s);
  });

  it('空 hits -> 空串（compileSettingContext 据此省略空块）', () => {
    expect(formatRetrievedSettings([], 'story')).toBe('');
    expect(formatRetrievedSettings([], 'craft')).toBe('');
  });

  it('body 过长 -> 截断 + `[...可经 query_story 取全文]` 指针；尾部省略', () => {
    const head = 'a'.repeat(SUFFIX_BODY_EXCERPT_LIMIT);
    const longBody = head + 'TAIL_BEYOND_LIMIT';
    const result = formatRetrievedSettings([storyHit({ bodyText: longBody })], 'story');
    expect(result).toContain('[...可经 query_story 取全文]');
    expect(result).toContain(head); // 截断后的摘录（前 LIMIT 字符）保留
    expect(result).not.toContain('TAIL_BEYOND_LIMIT'); // 超限尾部省略
  });

  it('craft kind body 过长 -> 指针用 query_craft（非 query_story）', () => {
    const longBody = 'b'.repeat(SUFFIX_BODY_EXCERPT_LIMIT + 50);
    const result = formatRetrievedSettings([craftHit({ bodyText: longBody })], 'craft');
    expect(result).toContain('[...可经 query_craft 取全文]');
    expect(result).not.toContain('query_story');
  });

  it('body 短（<= limit）-> 不截断、无指针、全文保留', () => {
    const shortBody = '短设定'.repeat(10);
    expect(shortBody.length).toBeLessThanOrEqual(SUFFIX_BODY_EXCERPT_LIMIT);
    const result = formatRetrievedSettings([storyHit({ bodyText: shortBody })], 'story');
    expect(result).not.toContain('[...可经 query_story 取全文]');
    expect(result).toContain(shortBody);
  });

  it('body 恰好等于 limit -> 不截断（边界 <= limit）', () => {
    const exactBody = 'c'.repeat(SUFFIX_BODY_EXCERPT_LIMIT);
    const result = formatRetrievedSettings([storyHit({ bodyText: exactBody })], 'story');
    expect(result).not.toContain('[...可经 query_story 取全文]');
    expect(result).toContain(exactBody);
  });

  it('空 bodyText -> 仅 header（无 body 行、无指针）', () => {
    const result = formatRetrievedSettings([storyHit({ bodyText: '' })], 'story');
    expect(result).toBe('### 林动 [character/setting_card]');
    expect(result).not.toContain('[...可经 query_story 取全文]');
  });

  it('bracket 标注 sourceKind 区分来源（setting_card / setting_md / asset_card）', () => {
    const result = formatRetrievedSettings(
      [storyHit({ entryId: '00001:md_1', entryType: 'magic_system', sourceKind: 'setting_md', name: '魔法体系' })],
      'story',
    );
    expect(result).toContain('### 魔法体系 [magic_system/setting_md]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compileSettingContext
// ─────────────────────────────────────────────────────────────────────────────
describe('compileSettingContext（Story 2.3 顶层设定上下文汇编）', () => {
  it('stablePrefix 来自 compileSettingPrefix（含设定目录，priority 最高置首）', () => {
    const assembly = compileSettingContext(buildMinimalDoc());
    expect(assembly.stablePrefix.length).toBeGreaterThan(0);
    expect(assembly.stablePrefix[0].label).toBe('设定目录');
    expect(assembly.stablePrefix[0].content).toContain('林动 · character · core');
  });

  it('layout 契约标记 = prefix|breakpoint|suffix（结构契约，非实际 cache 注入）', () => {
    expect(SETTING_CONTEXT_LAYOUT).toBe('prefix|breakpoint|suffix');
    expect(compileSettingContext(buildMinimalDoc()).layout).toBe(SETTING_CONTEXT_LAYOUT);
  });

  it('story + craft 检索结果拼接进 dynamicSuffix', () => {
    const assembly = compileSettingContext(
      buildMinimalDoc(),
      [storyHit()],
      [craftHit()],
    );
    expect(assembly.dynamicSuffix).toContain('### 林动 [character/setting_card]');
    expect(assembly.dynamicSuffix).toContain('### 爽点目录 [shuangdian/user]');
    // story 块在前，craft 块在后，以空行分隔。
    expect(assembly.dynamicSuffix).toMatch(/林动.*\n\n.*爽点目录/s);
  });

  it('仅 story 检索 -> dynamicSuffix 仅含 story 块（无 craft 块）', () => {
    const assembly = compileSettingContext(buildMinimalDoc(), [storyHit()]);
    expect(assembly.dynamicSuffix).toContain('### 林动 [character/setting_card]');
    expect(assembly.dynamicSuffix).not.toContain('爽点目录');
  });

  it('仅 craft 检索 -> dynamicSuffix 仅含 craft 块', () => {
    const assembly = compileSettingContext(buildMinimalDoc(), undefined, [craftHit()]);
    expect(assembly.dynamicSuffix).toContain('### 爽点目录 [shuangdian/user]');
    expect(assembly.dynamicSuffix).not.toContain('林动 [character/');
  });

  it('无检索（hits 均 undefined）-> dynamicSuffix 空串，stablePrefix 仍在', () => {
    const assembly = compileSettingContext(buildMinimalDoc());
    expect(assembly.dynamicSuffix).toBe('');
    expect(assembly.stablePrefix.length).toBeGreaterThan(0);
  });

  it('检索空数组（[]=检索空结果）-> dynamicSuffix 空串（空块省略）', () => {
    const assembly = compileSettingContext(buildMinimalDoc(), [], []);
    expect(assembly.dynamicSuffix).toBe('');
  });

  it('返回结构满足 SettingContextAssembly 形态（三字段齐全）', () => {
    const assembly: SettingContextAssembly = compileSettingContext(
      buildMinimalDoc(),
      [storyHit()],
      [craftHit()],
    );
    expect(Array.isArray(assembly.stablePrefix)).toBe(true);
    expect(typeof assembly.dynamicSuffix).toBe('string');
    expect(assembly.layout).toBe('prefix|breakpoint|suffix');
  });

  it('空 projectDocument + 无检索 -> stablePrefix 空 + dynamicSuffix 空 + layout 契约仍在', () => {
    const assembly = compileSettingContext({});
    expect(assembly.stablePrefix).toEqual([]);
    expect(assembly.dynamicSuffix).toBe('');
    expect(assembly.layout).toBe('prefix|breakpoint|suffix');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 类型层断言：overload 把 kind 与 hit 类型绑定。
// design/implement.md 写 `hits: EntryHit[]`，但 craft hit 是独立 CraftHit 类型（closure-craft-retrieval.ts：
// craftId/craftType，无 projectId/visibility），非 EntryHit。实施按 dispatch 指引用 kind:'craft' 分支
// 处理，并用 overload 把 kind<->hit 类型绑定（编译期防错配）。本函数不执行（无 runtime 副作用）；仅由
// `tsc -p tsconfig.json`（含 tests/）校验 @ts-expect-error--误配 kind/hit 必报编译错。
// ─────────────────────────────────────────────────────────────────────────────
function _assertOverloadTypeSafety() {
  const storyHits: EntryHit[] = [];
  const craftHits: CraftHit[] = [];
  // @ts-expect-error craft hits 不能配 kind:'story'（overload 绑定 kind<->hit 类型，防错配）
  formatRetrievedSettings(craftHits, 'story');
  // @ts-expect-error story hits 不能配 kind:'craft'
  formatRetrievedSettings(storyHits, 'craft');
}
