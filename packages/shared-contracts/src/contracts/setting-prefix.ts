import { z } from 'zod';
import { projectDocumentSchema } from './project';
import { assetCardSchema, assetCardTypeSchema } from './creative-fields';

// ── Story 2.3 设定喂 LLM 工程：稳定前缀编译器（design §2 / §3.2）──
//
// 纯函数：读 projectDocument 的 creative_brief / world_setting / asset_cards -> 编译成 pinned
// context 稳定前缀项（PinnedPrefixItem[]）。无 fs / db / LLM（design §3.2 / §8）--可 plain vitest 单测。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical）：tier 标注是 LLM 写设定时标的语义
// 判断（这张卡 cross-scene 相关 + 罕变否 = 语义）；本编译器只做纯代码结构提取--读 tier / 按
// CORE_FIELD_SPEC 抽 lean 核心字段 / 生成可查指针（只指不抄）/ 列目录。不判「这张卡重不重要」
// （那是 LLM 标 tier 的事），只据已标 tier + 结构默认汇编。别把 tier 判定写成纯代码 pass/fail。
//
// 落点 shared-contracts（design §5 / §6）：creative-fields schema 在 contracts，PinnedContextItem 在
// agent（context/pinnedContext.ts）。为避跨包循环依赖（agent -> contracts -> agent），编译器 emit 本
// 结构层 PinnedPrefixItem（{label,content,priority,type:'custom'}）；agent 侧薄包装（Epic 4.1 wiring）
// 转 PinnedContextItem（补 id/createdAt/source）。type 固定 'custom'（零侵入 OrisonSpace
// PinnedContextItem type union，design §6）。
//
// 缓存语义（design §2.4）：prefix 是当前核心设定的纯函数；设定改了重算吃一次 cache miss 再重缓存
// （核心设定罕变 -> 多场景命中 -> 值）。无 40K 硬 cap（用户定）；用既有 pinned 128K 预算
// （PINNED_CONTEXT_TOKEN_BUDGET，Story 2.3 已 bump 50K -> 128K）renderPinnedContext 按 priority 裁剪
// --标多了 core 也撑不爆（安全网）。wiring（设定变更 -> 重算 prefix -> updatePinnedItem）归 Epic 4.1。
//
// 动态后缀（design §3.3）：per-scene 微观设定 + craft 经 query_story / query_craft 工具按需拉取
// （ADR-5 tool-call，非 pre-fetch）。本编译器只产稳定前缀；后缀 shaping（formatRetrievedSettings）+
// 顶层布局（compileSettingContext）在 setting-assembly.ts（Step 3）。

type ProjectDocument = z.infer<typeof projectDocumentSchema>;
type AssetCard = z.infer<typeof assetCardSchema>;
type AssetCardType = z.infer<typeof assetCardTypeSchema>;

/**
 * 结构层 prefix 项（mirror agent `PinnedContextItem` 的 `{label,content,priority,type}` 子集）。
 * agent 侧薄包装转 PinnedContextItem（Epic 4.1 wiring）。`type` 固定 `'custom'`（零侵入上游
 * `PinnedContextItem.type` union，design §6）。`priority` 0-100（高 = 前缀靠前；
 * `renderPinnedContext` 降序排列 + 128K 预算裁剪）。
 */
export type PinnedPrefixItem = {
  label: string;
  content: string;
  priority: number;
  type: 'custom';
};

/**
 * `compileSettingPrefix` 输入：ProjectDocument 的 3 个创作字段（编译器只读这些）。完整
 * ProjectDocument（`loadProject` 产出）结构上满足本类型（超集），真实调用方传 loaded doc；
 * 测试传最小 fixture（无需构造无关的 meta / storyboard）。design §3.2 名参 `projectDocument`。
 */
export type SettingPrefixInput = Pick<
  ProjectDocument,
  'creative_brief' | 'world_setting' | 'asset_cards'
>;

// ── CORE_FIELD_SPEC：core 卡各 type 的「静态核心字段」+「省略可查字段」声明式清单（design §2.3）──
//
// 编译器据此：① 抽 lean 核心字段进 prefix（coreFields，跳 nullish）② 生成可查指针
// （queryableFields，只列名 + entry_type 检索提示，不抄内容--design 4.1「不进 brief 的东西->指向」）。
// 可单测 + 可扩展（加字段只改本表）。范式判据：本表是确定性数据（哪个字段属核心 vs 可查 = 设计
// 决定，非语义判断）；tier 标注本身归 LLM。逐卡字段对照 design §2.3 + asset-loader prompt §4.1-§4.8。
type FieldRender = 'text' | 'list';

type FieldSpec = {
  /** prefix 内显示名。 */
  label: string;
  /** 卡上 nested 路径（如 ['desireAndBottomline','coreDesire']）。 */
  path: readonly string[];
  /** text=字符串原样；list=string[] -> 顿号连接。 */
  render: FieldRender;
};

type QueryableField = { label: string };

type TypeFieldSpec = {
  coreFields: readonly FieldSpec[];
  queryableFields: readonly QueryableField[];
};

export const CORE_FIELD_SPEC: Record<AssetCardType, TypeFieldSpec> = {
  character: {
    // 核心=核心欲望起点+核心恐惧+OOC锚点+核心性格（弧演变 -> growth_curve，不进 prefix）。
    coreFields: [
      { label: '核心欲望', path: ['desireAndBottomline', 'coreDesire'], render: 'text' },
      { label: '核心恐惧', path: ['desireAndBottomline', 'coreFear'], render: 'text' },
      { label: 'OOC 锚点', path: ['desireAndBottomline', 'oocAnchors'], render: 'list' },
      { label: '核心性格', path: ['personality', 'coreTraits'], render: 'list' },
    ],
    queryableFields: [
      { label: '表层 vs 内在真相（personality）' },
      { label: '能力与代价（abilities）' },
      { label: '背景事件（background）' },
      { label: '声线行为（voice）' },
    ],
  },
  golden_finger: {
    // 核心=类型+核心能力+能力边界+硬性限制+使用代价（反玛丽苏核心；成长 -> growthSystem 可查）。
    coreFields: [
      { label: '类型', path: ['basics', 'type'], render: 'text' },
      { label: '核心能力', path: ['abilitySystem', 'coreAbility'], render: 'text' },
      { label: '能力边界', path: ['abilitySystem', 'boundaries'], render: 'text' },
      { label: '硬性限制', path: ['limitations', 'hardLimits'], render: 'text' },
      { label: '使用代价', path: ['limitations', 'usageCost'], render: 'text' },
    ],
    queryableFields: [
      { label: '起源（origin）' },
      { label: '成长系统（growthSystem）' },
      { label: '持有者关系（holderRelation）' },
      { label: '平衡设计（balance）' },
    ],
  },
  rule: {
    // 核心=定义+适用边界+漏洞（爽点矿）；机制/代价/认知分布可查（信息差 -> 检索）。
    coreFields: [
      { label: '规则定义', path: ['definition', 'description'], render: 'text' },
      { label: '适用边界', path: ['boundaries', 'applicableBoundary'], render: 'text' },
      { label: '漏洞·灰色地带', path: ['boundaries', 'loopholes'], render: 'list' },
    ],
    queryableFields: [
      { label: '运作机制（mechanism）' },
      { label: '代价后果（costs）' },
      { label: '认知分布（cognition）' },
    ],
  },
  location: {
    // 核心=类型/规模 + 氛围关键词（写作核心）+ 地标（关键身份）；环境详述/生态/历史可查。
    coreFields: [
      { label: '类型', path: ['basics', 'type'], render: 'text' },
      { label: '规模', path: ['basics', 'scale'], render: 'text' },
      { label: '氛围关键词', path: ['environment', 'moodKeywords'], render: 'list' },
      { label: '地标', path: ['landmarks'], render: 'list' },
    ],
    queryableFields: [
      { label: '环境详述（environment）' },
      { label: '生态（ecology）' },
      { label: '历史（history）' },
    ],
  },
  organization: {
    // 核心=类型+核心信条+公众形象+隐藏面目（信息差）+绝对底线（组织级 OOC）；结构/资源/历史/文化可查。
    coreFields: [
      { label: '类型', path: ['basics', 'type'], render: 'text' },
      { label: '核心信条', path: ['ideology', 'coreBelief'], render: 'text' },
      { label: '公众形象', path: ['ideology', 'publicImage'], render: 'text' },
      { label: '隐藏面目', path: ['ideology', 'hiddenFace'], render: 'text' },
      { label: '绝对底线', path: ['ideology', 'bottomLine'], render: 'list' },
    ],
    queryableFields: [
      { label: '结构（structure）' },
      { label: '资源（resources）' },
      { label: '历史（history）' },
      { label: '文化（culture）' },
    ],
  },
  prop: {
    // 核心=类型+核心功能+限制与代价；外观/运作条件/价值/起源/社会文化可查。
    coreFields: [
      { label: '类型', path: ['basics', 'type'], render: 'text' },
      { label: '核心功能', path: ['mechanics', 'coreFunction'], render: 'text' },
      { label: '限制与代价', path: ['mechanics', 'limitations'], render: 'text' },
    ],
    queryableFields: [
      { label: '外观（appearance）' },
      { label: '运作条件（mechanics）' },
      { label: '价值（value）' },
      { label: '起源（origin）' },
      { label: '社会文化（socioCulture）' },
    ],
  },
  visual_motif: {
    // 核心=类型+核心意象+抽象含义+叙事功能；感官细节/变体/主题映射/设计约束可查。
    coreFields: [
      { label: '类型', path: ['basics', 'type'], render: 'text' },
      { label: '核心意象', path: ['definition', 'coreImagery'], render: 'text' },
      { label: '抽象含义', path: ['definition', 'abstractMeaning'], render: 'text' },
      { label: '叙事功能', path: ['narrativeFunction'], render: 'list' },
    ],
    queryableFields: [
      { label: '感官细节（sensoryDetails）' },
      { label: '变体系统（variants）' },
      { label: '主题映射（themeMapping）' },
      { label: '设计约束（designConstraints）' },
    ],
  },
  lore: {
    // 核心=类型+可信度+真相层级+核心元素；故事本体/版本系统/传播/未解之谜可查（信息差最富）。
    coreFields: [
      { label: '类型', path: ['basics', 'type'], render: 'text' },
      { label: '可信度', path: ['basics', 'credibility'], render: 'text' },
      { label: '真相层级', path: ['truth', 'levels'], render: 'text' },
      { label: '核心元素', path: ['storyBody', 'coreElements'], render: 'list' },
    ],
    queryableFields: [
      { label: '故事本体（storyBody）' },
      { label: '版本系统（versionSystem）' },
      { label: '传播生态（transmission）' },
      { label: '未解之谜（unsolvedMysteries）' },
    ],
  },
};

// tier 未标时的结构默认（design §2.4 / implement.md 2.4）：character/golden_finger/rule 默认 core
// （跨场景奠基性设定常见）；location/organization/prop/visual_motif/lore 默认 micro（常 scene-specific）。
// Agent 显式 tier 覆盖此默认。
const DEFAULT_CORE_TYPES: ReadonlySet<AssetCardType> = new Set<AssetCardType>([
  'character',
  'golden_finger',
  'rule',
]);

/** 解析卡的生效 tier：显式标注优先，否则按 type 结构默认。纯函数，导出供单测。 */
export function resolveTier(card: AssetCard): 'core' | 'micro' {
  if (card.tier === 'core' || card.tier === 'micro') return card.tier;
  return DEFAULT_CORE_TYPES.has(card.type) ? 'core' : 'micro';
}

// ── 优先级（renderPinnedContext 降序排列；高 = 前缀靠前）── design §2.4 priority 序。
const PRIORITY = {
  inventory: 100, // 设定目录（头，全景）
  worldSetting: 90, // world_constitution / premise / era
  creativeBrief: 85, // 题材标签 / 承诺 / 力量体系 / 情绪弧 / 爽点偏好
  goldenFinger: 80, // 金手指 core 卡（网文核心设定）
  character: 75, // 主角 core 卡
  rule: 70, // 规则 core 卡
  otherCore: 65, // location/organization/prop/visual_motif/lore 显式标 core 时
} as const;

/** 沿 path 取 nested 值（卡是 discriminatedUnion，此处按 loose 对象走，跳 nullish）。 */
function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** 渲染字段值：text=非空字符串原样；list=string[] 顿号连接。null/空 -> null（跳过）。 */
function renderFieldValue(raw: unknown, render: FieldRender): string | null {
  if (render === 'list') {
    if (Array.isArray(raw)) {
      const items = raw
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim());
      return items.length > 0 ? items.join('、') : null;
    }
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    return null;
  }
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

/** core 卡 type -> 前缀 priority（金手指/主角/规则高；其余 core 卡中）。 */
function priorityForCoreCard(type: AssetCardType): number {
  switch (type) {
    case 'golden_finger':
      return PRIORITY.goldenFinger;
    case 'character':
      return PRIORITY.character;
    case 'rule':
      return PRIORITY.rule;
    default:
      return PRIORITY.otherCore;
  }
}

/** 编译设定目录（inventory）：全卡一行 `name · type · tier`（design §2.3）。无卡 -> null。 */
function buildInventoryItem(cards: readonly AssetCard[]): PinnedPrefixItem | null {
  if (cards.length === 0) return null;
  const lines = cards.map((c) => `- ${c.name} · ${c.type} · ${resolveTier(c)}`);
  const content = [
    '设定资产清单（name · type · tier）：',
    ...lines,
    '（micro 卡仅在此列出，详细经 query_story 工具按需检索；core 卡见下方核心字段。）',
  ].join('\n');
  return { label: '设定目录', content, priority: PRIORITY.inventory, type: 'custom' };
}

/** 编译 creative_brief 顶层核心设定（结构默认进 prefix，跳 nullish/空）。 */
function buildCreativeBriefItem(
  brief: NonNullable<SettingPrefixInput['creative_brief']>,
): PinnedPrefixItem | null {
  const lines: string[] = [];
  const push = (label: string, value: string | undefined | null) => {
    if (value && value.trim()) lines.push(`- ${label}：${value.trim()}`);
  };
  const pushList = (label: string, arr: readonly string[] | undefined) => {
    if (arr && arr.length > 0) lines.push(`- ${label}：${arr.join('、')}`);
  };
  // 既有 loose 字段（back-compat）+ Story 2.4 结构化字段。
  push('题材', brief.genre);
  push('主题', brief.theme);
  push('基调', brief.tone);
  push('受众', brief.audience);
  push('篇幅', brief.length);
  if (brief.structure_pattern) push('情节结构 pattern', brief.structure_pattern);
  pushList('题材标签', brief.genre_tags);
  if (brief.commitments && brief.commitments.length > 0) {
    lines.push(`- 承诺：${brief.commitments.map((c) => `${c.type}（${c.content}）`).join('；')}`);
  }
  push('力量体系类型', brief.power_system_type);
  push('情绪弧模板', brief.emotion_arc_template);
  pushList('爽点偏好', brief.shuangdian_preferences);
  if (lines.length === 0) return null;
  return {
    label: '创作 Brief 核心设定',
    content: lines.join('\n'),
    priority: PRIORITY.creativeBrief,
    type: 'custom',
  };
}

/** 编译 world_setting（world_constitution + premise + era，结构默认进 prefix）。 */
function buildWorldSettingItem(
  ws: NonNullable<SettingPrefixInput['world_setting']>,
): PinnedPrefixItem | null {
  const lines: string[] = [];
  if (ws.premise && ws.premise.trim()) lines.push(`- 世界前提：${ws.premise.trim()}`);
  if (ws.era && ws.era.trim()) lines.push(`- 时代：${ws.era.trim()}`);
  if (ws.world_constitution && ws.world_constitution.length > 0) {
    lines.push(`- 世界承诺（impossible list）：${ws.world_constitution.join('；')}`);
  }
  if (lines.length === 0) return null;
  return { label: '世界设定', content: lines.join('\n'), priority: PRIORITY.worldSetting, type: 'custom' };
}

/**
 * 编译单张 core 卡的 lean 核心字段 + 可查指针（design §2.3）。指针「只指不抄」：列省略字段名 +
 * entry_type 检索提示 + .md prose 提示，告诉 LLM「有这些、可搜」（解决 function-call 找设定问题），
 * 不抄内容（不胀 prefix + 不双真相源漂移）。
 */
function buildCoreCardItem(card: AssetCard): PinnedPrefixItem {
  const spec = CORE_FIELD_SPEC[card.type];
  const lines: string[] = [];
  if (card.summary && card.summary.trim()) lines.push(`概要：${card.summary.trim()}`);
  // base 公共核心身份（narrative，所有卡共享）。
  if (card.narrative) {
    if (card.narrative.storyFunction && card.narrative.storyFunction.trim()) {
      lines.push(`故事功能：${card.narrative.storyFunction.trim()}`);
    }
    if (card.narrative.coreConflict && card.narrative.coreConflict.trim()) {
      lines.push(`核心冲突：${card.narrative.coreConflict.trim()}`);
    }
  }
  // per-type lean 核心字段（跳 nullish）。
  const coreLines: string[] = [];
  for (const f of spec.coreFields) {
    const raw = getPath(card, f.path);
    const value = renderFieldValue(raw, f.render);
    if (value) coreLines.push(`${f.label}：${value}`);
  }
  if (coreLines.length > 0) {
    lines.push('核心字段：', ...coreLines.map((l) => `  - ${l}`));
  }
  // 可查指针（只指不抄）。
  if (spec.queryableFields.length > 0) {
    const names = spec.queryableFields.map((q) => q.label).join('、');
    lines.push(
      `可查详情（按需经 query_story 工具检索，entry_type=${card.type}）：${names}；长 form 设定散文（settings/*.md）亦可经 query_story 检索。`,
    );
  }
  const content = lines.length > 0 ? lines.join('\n') : '（无核心字段；详述经 query_story 工具检索。）';
  return {
    label: `${card.name}（${card.type} 核心设定）`,
    content,
    priority: priorityForCoreCard(card.type),
    type: 'custom',
  };
}

/**
 * 编译设定稳定前缀（design §3.2）。纯函数：读 projectDocument 的 creative_brief / world_setting /
 * asset_cards -> PinnedPrefixItem[]（priority 降序）。core 卡（tier='core' 或结构默认 core）进 lean 核心
 * 字段 + 可查指针；micro 卡（tier='micro' 或结构默认 micro）仅入目录。creative_brief 顶层 +
 * world_setting 结构默认进 prefix。无 40K 硬 cap（pinned 128K 预算裁剪）。
 *
 * tier 未标旧设定 -> 结构默认（character/golden_finger/rule 默认 core，其余默认 micro）。
 *
 * @param projectDocument  loaded ProjectDocument（或其 3 字段子集）；设定变更后重算（design §2.4）。
 * @returns  PinnedPrefixItem[]（priority 降序）；agent 侧薄包装转 PinnedContextItem[]（Epic 4.1）。
 */
export function compileSettingPrefix(projectDocument: SettingPrefixInput): PinnedPrefixItem[] {
  const items: PinnedPrefixItem[] = [];
  const cards = projectDocument.asset_cards ?? [];

  // ① 设定目录（头，全卡一行 name · type · tier）。
  const inventory = buildInventoryItem(cards);
  if (inventory) items.push(inventory);

  // ② world_setting 结构默认（world_constitution / premise / era）。
  if (projectDocument.world_setting) {
    const wsItem = buildWorldSettingItem(projectDocument.world_setting);
    if (wsItem) items.push(wsItem);
  }

  // ③ creative_brief 顶层结构默认（题材标签 / 承诺 / 力量体系 / 情绪弧 / 爽点偏好 + loose 字段）。
  if (projectDocument.creative_brief) {
    const briefItem = buildCreativeBriefItem(projectDocument.creative_brief);
    if (briefItem) items.push(briefItem);
  }

  // ④ core 卡 lean 核心 + 可查指针（micro 卡跳过，仅目录）。
  for (const card of cards) {
    if (resolveTier(card) === 'core') {
      items.push(buildCoreCardItem(card));
    }
  }

  // priority 降序（renderPinnedContext 也会排，但预排让消费者直接可用；sort 稳定保卡内序）。
  items.sort((a, b) => b.priority - a.priority);
  return items;
}
