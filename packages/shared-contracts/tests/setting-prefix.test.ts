import { describe, expect, it } from 'vitest';
import {
  compileSettingPrefix,
  resolveTier,
  CORE_FIELD_SPEC,
  type PinnedPrefixItem,
  type SettingPrefixInput,
  assetCardTypeSchema,
  assetCardsSchema,
  creativeBriefSchema,
  worldSettingSchema,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.3：设定稳定前缀编译器（compileSettingPrefix）单测。
// 纯函数（无 fs/db/LLM）-> plain vitest。覆盖 design §2.3/§3.2 + implement.md 2.5：
// 设定目录含全卡 / core 卡含 lean 核心+指针 / micro 卡仅目录 / 跳 nullish /
// tier 未标走结构默认 / priority 序 / 指针含 entry_type 提示。
// ─────────────────────────────────────────────────────────────────────────────

/** 构建一个全字段 ProjectDocument-like fixture（经 schema.parse 得正确 output 类型 + defaults）。 */
function buildFixture(): SettingPrefixInput {
  const cards = assetCardsSchema.parse([
    {
      id: 'char_main', type: 'character', name: '林动', tier: 'core', summary: '坚韧的少年',
      desireAndBottomline: { coreDesire: '变强保护家人', coreFear: '无力感', oocAnchors: ['绝不背叛朋友'] },
      personality: { coreTraits: ['坚韧', '机敏'] },
      abilities: { core: ['吞噬祖符'] }, // queryable -> 不应进 core 内容
      narrative: { storyFunction: '主角', coreConflict: '平凡vs非凡' },
    },
    {
      id: 'gf_1', type: 'golden_finger', name: '吞噬祖符', tier: 'core',
      basics: { type: '器物型' },
      abilitySystem: { coreAbility: '吞噬万物能量', boundaries: '不能吞噬有主意志的生灵' },
      limitations: { hardLimits: '不能突破天道上限', usageCost: '反噬精神力' },
      growthSystem: { mode: '吞噬积累' }, // queryable -> 不应进 core 内容
    },
    {
      // 无 tier -> location 结构默认 micro（仅目录，无 own item）。
      id: 'loc_1', type: 'location', name: '雷冲秘境',
      environment: { moodKeywords: ['压抑', '危险'] },
      landmarks: ['雷池'],
    },
    {
      // 无 tier -> rule 结构默认 core（有 own item）。
      id: 'rule_1', type: 'rule', name: '雷劫定律',
      definition: { description: '突破境界必引天劫' },
      boundaries: { loopholes: ['散仙无劫'] },
    },
    {
      // 显式 tier='core' 覆盖 location 默认 micro（有 own item）。
      id: 'loc_core', type: 'location', name: '暗城', tier: 'core',
      environment: { moodKeywords: ['阴冷'] },
    },
  ]);
  return {
    creative_brief: creativeBriefSchema.parse({
      rawRequirement: '写一个修真故事',
      genre: '玄幻', audience: '男频', length: '长篇',
      structure_pattern: 'anchor-single',
      genre_tags: ['玄幻', '爽文'],
      commitments: [{ type: 'HE', content: '主角终成大道' }],
      power_system_type: '修炼',
      emotion_arc_template: '先抑后扬',
      shuangdian_preferences: ['打脸'],
    }),
    world_setting: worldSettingSchema.parse({
      premise: '高魔世界', era: '太古',
      world_constitution: ['绝无时间旅行', '死者不能复生'],
    }),
    asset_cards: cards,
  };
}

function findItem(items: PinnedPrefixItem[], labelSubstring: string): PinnedPrefixItem | undefined {
  return items.find((i) => i.label.includes(labelSubstring));
}

describe('compileSettingPrefix（Story 2.3 设定稳定前缀编译器）', () => {
  it('空 projectDocument（无创作字段）-> 空前缀', () => {
    expect(compileSettingPrefix({})).toEqual([]);
    expect(compileSettingPrefix({ asset_cards: [] })).toEqual([]);
  });

  it('设定目录（inventory）置头 + 含全部卡（name · type · tier）', () => {
    const items = compileSettingPrefix(buildFixture());
    // priority 最高 -> 排序后置首。
    expect(items[0].label).toBe('设定目录');
    const inv = items[0].content;
    expect(inv).toContain('林动 · character · core');
    expect(inv).toContain('吞噬祖符 · golden_finger · core');
    expect(inv).toContain('雷冲秘境 · location · micro'); // 默认 micro
    expect(inv).toContain('雷劫定律 · rule · core'); // 默认 core
    expect(inv).toContain('暗城 · location · core'); // 显式 core 覆盖
  });

  it('creative_brief 顶层结构字段进前缀（跳 nullish/空）', () => {
    const items = compileSettingPrefix(buildFixture());
    const brief = findItem(items, '创作 Brief 核心设定');
    expect(brief).toBeDefined();
    const c = brief!.content;
    expect(c).toContain('题材：玄幻');
    expect(c).toContain('受众：男频');
    expect(c).toContain('篇幅：长篇');
    expect(c).toContain('情节结构 pattern：anchor-single');
    expect(c).toContain('题材标签：玄幻、爽文');
    expect(c).toContain('承诺：HE（主角终成大道）');
    expect(c).toContain('力量体系类型：修炼');
    expect(c).toContain('情绪弧模板：先抑后扬');
    expect(c).toContain('爽点偏好：打脸');
  });

  it('world_setting（world_constitution + premise + era）进前缀', () => {
    const items = compileSettingPrefix(buildFixture());
    const ws = findItem(items, '世界设定');
    expect(ws).toBeDefined();
    const c = ws!.content;
    expect(c).toContain('世界前提：高魔世界');
    expect(c).toContain('时代：太古');
    expect(c).toContain('世界承诺（impossible list）：绝无时间旅行；死者不能复生');
  });

  it('core 卡含 lean 核心字段 + 可查指针（只指不抄，含 entry_type 提示）', () => {
    const items = compileSettingPrefix(buildFixture());
    const charItem = findItem(items, '林动（character 核心设定）');
    expect(charItem).toBeDefined();
    const c = charItem!.content;
    // lean 核心字段（结构提取）。
    expect(c).toContain('概要：坚韧的少年');
    expect(c).toContain('故事功能：主角');
    expect(c).toContain('核心冲突：平凡vs非凡');
    expect(c).toContain('核心欲望：变强保护家人');
    expect(c).toContain('核心恐惧：无力感');
    expect(c).toContain('OOC 锚点：绝不背叛朋友');
    expect(c).toContain('核心性格：坚韧、机敏');
    // 可查指针含 entry_type 提示 + queryable 字段名（只指不抄）。
    expect(c).toContain('entry_type=character');
    expect(c).toContain('能力与代价（abilities）');
    // queryable 字段值不抄进前缀（abilities.core 值「吞噬祖符」是 queryable 详述）。
    expect(c).not.toContain('能力详述'); // abilities 内容未抄
  });

  it('golden_finger core 卡：核心字段 + 指针 entry_type=golden_finger；growthSystem 值不抄', () => {
    const items = compileSettingPrefix(buildFixture());
    const gf = findItem(items, '吞噬祖符（golden_finger 核心设定）');
    expect(gf).toBeDefined();
    const c = gf!.content;
    expect(c).toContain('类型：器物型');
    expect(c).toContain('核心能力：吞噬万物能量');
    expect(c).toContain('能力边界：不能吞噬有主意志的生灵');
    expect(c).toContain('硬性限制：不能突破天道上限');
    expect(c).toContain('使用代价：反噬精神力');
    expect(c).toContain('entry_type=golden_finger');
    expect(c).toContain('成长系统（growthSystem）'); // 指针列名
    expect(c).not.toContain('吞噬积累'); // growthSystem.mode 值不抄
  });

  it('micro 卡（tier=micro 或默认 micro）仅入目录，无 own 前缀项', () => {
    const items = compileSettingPrefix(buildFixture());
    // 雷冲秘境（location 默认 micro）-> 无 own item。
    expect(findItem(items, '雷冲秘境（location')).toBeUndefined();
    // 暗城（location 显式 core）-> 有 own item（覆盖默认）。
    expect(findItem(items, '暗城（location 核心设定）')).toBeDefined();
  });

  it('rule 卡 tier 未标 -> 结构默认 core -> 有 own 前缀项 + 核心字段', () => {
    const items = compileSettingPrefix(buildFixture());
    const rule = findItem(items, '雷劫定律（rule 核心设定）');
    expect(rule).toBeDefined();
    const c = rule!.content;
    expect(c).toContain('规则定义：突破境界必引天劫');
    expect(c).toContain('漏洞·灰色地带：散仙无劫');
    expect(c).toContain('entry_type=rule');
  });

  it('返回项按 priority 降序排列', () => {
    const items = compileSettingPrefix(buildFixture());
    for (let i = 0; i < items.length - 1; i++) {
      expect(items[i].priority).toBeGreaterThanOrEqual(items[i + 1].priority);
    }
    // 设定目录 priority 最高（100）。
    expect(items[0].priority).toBe(100);
  });

  it('所有 PinnedPrefixItem type 固定 custom（零侵入 OrisonSpace type union）', () => {
    const items = compileSettingPrefix(buildFixture());
    expect(items.every((i) => i.type === 'custom')).toBe(true);
  });

  it('跳 nullish：core 卡缺核心字段时该项不列对应行（但仍 emit 项 + 指针）', () => {
    const items = compileSettingPrefix({
      asset_cards: assetCardsSchema.parse([
        // character 默认 core，但无 desireAndBottomline / personality -> 无核心字段行。
        { id: 'c_min', type: 'character', name: '匿名角色' },
      ]),
    });
    const item = findItem(items, '匿名角色（character 核心设定）');
    expect(item).toBeDefined();
    expect(item!.content).not.toContain('核心字段：');
    // 仍含指针（告诉 LLM 有 queryable 详述可搜）。
    expect(item!.content).toContain('entry_type=character');
    // 目录仍含该卡。
    expect(items[0].content).toContain('匿名角色 · character · core');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveTier（tier 显式标注优先 + 结构默认）
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveTier（tier 显式优先 + 结构默认）', () => {
  it('显式 tier 优先于结构默认', () => {
    const [locCore] = assetCardsSchema.parse([{ id: 'l', type: 'location', name: 'L', tier: 'core' }]);
    expect(resolveTier(locCore)).toBe('core'); // location 默认 micro，显式 core 覆盖
    const [charMicro] = assetCardsSchema.parse([{ id: 'c', type: 'character', name: 'C', tier: 'micro' }]);
    expect(resolveTier(charMicro)).toBe('micro'); // character 默认 core，显式 micro 覆盖
  });

  it('tier 未标 -> 按 type 结构默认（character/golden_finger/rule=core，其余=micro）', () => {
    const coreDefaults = ['character', 'golden_finger', 'rule'] as const;
    const microDefaults = ['location', 'organization', 'prop', 'visual_motif', 'lore'] as const;
    for (const t of coreDefaults) {
      const [card] = assetCardsSchema.parse([{ id: 'x', type: t, name: 'N' }]);
      expect(resolveTier(card), `${t} 默认应 core`).toBe('core');
    }
    for (const t of microDefaults) {
      const [card] = assetCardsSchema.parse([{ id: 'x', type: t, name: 'N' }]);
      expect(resolveTier(card), `${t} 默认应 micro`).toBe('micro');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORE_FIELD_SPEC：8 类全覆盖（exhaustive）+ coreField 路径可解析（防 path 漂移）
// ─────────────────────────────────────────────────────────────────────────────
describe('CORE_FIELD_SPEC（声明式核心/可查字段清单）', () => {
  it('8 类 type 全覆盖（exhaustive，Record<AssetCardType,_> 编译期保证 + 运行期复核）', () => {
    for (const t of assetCardTypeSchema.options) {
      expect(CORE_FIELD_SPEC[t], `${t} 缺 CORE_FIELD_SPEC 条目`).toBeDefined();
      expect(CORE_FIELD_SPEC[t].coreFields.length).toBeGreaterThan(0);
      expect(CORE_FIELD_SPEC[t].queryableFields.length).toBeGreaterThan(0);
    }
  });

  it('每类 coreField 路径在满字段卡上可解析（防 path 字符串与 schema 漂移）', () => {
    // 每类一张 coreFields 父路径全填的卡（经 schema.parse 校验形态合法）。
    const fullCards = assetCardsSchema.parse([
      { id: 'c', type: 'character', name: 'C',
        desireAndBottomline: { coreDesire: 'd', coreFear: 'f', oocAnchors: ['a'] },
        personality: { coreTraits: ['t'] } },
      { id: 'g', type: 'golden_finger', name: 'G',
        basics: { type: '器物型' },
        abilitySystem: { coreAbility: 'ca', boundaries: 'b' },
        limitations: { hardLimits: 'h', usageCost: 'u' } },
      { id: 'r', type: 'rule', name: 'R',
        definition: { description: 'desc' },
        boundaries: { applicableBoundary: 'ab', loopholes: ['l'] } },
      { id: 'l', type: 'location', name: 'L',
        basics: { type: '秘境', scale: '大' },
        environment: { moodKeywords: ['m'] },
        landmarks: ['lm'] },
      { id: 'o', type: 'organization', name: 'O',
        basics: { type: '学术' },
        ideology: { coreBelief: 'cb', publicImage: 'pi', hiddenFace: 'hf', bottomLine: ['bl'] } },
      { id: 'p', type: 'prop', name: 'P',
        basics: { type: '武器' },
        mechanics: { coreFunction: 'cf', limitations: 'lim' } },
      { id: 'v', type: 'visual_motif', name: 'V',
        basics: { type: '视觉' },
        definition: { coreImagery: 'ci', abstractMeaning: 'am' },
        narrativeFunction: ['nf'] },
      { id: 'lo', type: 'lore', name: 'LO',
        basics: { type: '创世神话', credibility: '半信半疑' },
        truth: { levels: 'lv' },
        storyBody: { coreElements: ['ce'] } },
    ]);
    for (const card of fullCards) {
      const spec = CORE_FIELD_SPEC[card.type];
      for (const f of spec.coreFields) {
        // 路径必须在满字段卡上解析到非空值（防 path 写错指向不存在的字段）。
        let cur: unknown = card;
        for (const key of f.path) {
          cur = cur == null || typeof cur !== 'object' ? undefined : (cur as Record<string, unknown>)[key];
        }
        expect(cur, `${card.type} coreField ${f.label} (${f.path.join('.')}) 路径未解析`).not.toBeUndefined();
      }
    }
  });
});
