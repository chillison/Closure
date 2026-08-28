// Anti-slop wordbanks — cliché / crutch / filter 中文词库（Story 4.2 Step 3）。
//
// 源 R3 §3.4（technical-consistency-and-slop-detection-research-2026-07-14.md）：
// - qu-ai-wei `patterns.md` 51 条中文 AI 腔黑名单（A–I 九大类）——本文件取叙事相关的策展 starter。
// - 中文 AI 连接词（翻译腔：然而/不仅如此/值得注意的是/不可否认/随着…的不断发展）。
// - 叙事套话（不由得一愣/眉头紧锁/深吸一口气/嘴角微微上扬——R3 §3.4 老编辑 5 辨识点 + 马良 40+）。
// - crutch 四类（R3 §6.1：intensifier/hedging/filler/narrative）。
// - filter（R3 §6.1 POV 漂移信号：see/hear/think/feel/notice → 看见/听到/想/感觉/注意到）。
//
// 零消费者资产发现纪律（memory feedback-discover-zero-consumer-assets）：先 grep 既有 craft KB
// （packages/shared-contracts/src/contracts/craft-type-vocab.ts 8 类：爽点/金手指/playbook/桥段/
// 节奏/力量体系/pattern/角色设计）核实——**无 AI 腔 / cliché / slop 类**（craft KB 是正向写作技法参考库，
// 非负向检测词库）。故新建本词库（零消费者核实通过：grep cliche|套话|口癖|泔水|slop|AI腔 命中的是本 task
// 文档 + spec + 本文件自身，无既有可复用数据条目）。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：词库是**确定性数据**（字符串数组），
// 命中是**机械子串匹配**（不理解意义）。"这段是否真 slop / 套话是否挣得位置（语境例外）"归 Step 5 L2 LLM
// 判定。本词库**不门禁**（不直接产 BLOCK）——仅作 L1 软信号 flag 的命中证据，喂 L2 聚焦（design §4）。
// 同 craft-type-vocab 哲学：词库是策展先验非封闭枚举，可超出（用户/项目可扩展）。
//
// 落 shared-contracts（同 stylometry.ts 包，design §4：词库是纯数据无 native）。命中算法 + density 计算
// 在 stylometry.ts `computeL1SignalReport`（消费本词库）。
//
// **Starter 集，可扩**：R3 §3.4 qu-ai-wei 51 条全文穷举 defer（本文件策展叙事高频子集 ~40 条 cliché +
// crutch 四类各 ~9 + filter ~15）。项目可在落点后扩充或挪至 craft KB 资源（design §4「可查 craft KB 是否
// 已有 AI 腔条目复用」——核实无后本文件是 single source）。
//
// **匹配形态约定**：所有条目均为 ≥2 字符的词/短语（无单字），使子串匹配可靠（单字如「想」会误命中
// 「想法/理想」，故用其多字形态「想到/想要」）。stylometry.ts 用 RegExp alternation 一次扫全 bank。
//
// expected_downstream_consumers:
// - Story 4.2 Step 2 `computeL1SignalReport`（stylometry.ts）：cliche_ratio / crutch_word_density /
//   filter_word_density 三信号消费本词库。
// - 未来 per-author baseline（R3 §6.4 近端增强）：词表 + 作者 baseline 阈值校准。

/**
 * RegExp 特殊字符转义（wordbank 条目含「…」等时安全）。
 * 非语义判断——纯机械字符串处理（与 scene-graph-analytics 同范式）。
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── cliché 词库（叙事套话 + AI 翻译腔连接词 + 华丽套话意象）──
// 源 R3 §3.4（qu-ai-wei A 结构套话/B AI 高频词/E 华丽意象 + 老编辑/马良叙事套话）。
// 命中 = 正文出现该短语（子串匹配）。density = 命中数 / token 估计（stylometry.ts 算）。
//
// 分类（仅作可读性注释，命中时不区分类别——cliche_ratio 是合计软信号；L2 LLM 看证据判）：
// - 叙事微表情套话（"不由得一愣"级 stock micro-expression）
// - AI 翻译腔连接词（"然而/不仅如此"——小说叙述重载即翻译腔）
// - 华丽套话意象（"璀璨/熠熠生辉"——R3 §3.4③ 意象降级）
// - 假坦诚/空枢纽句钩子（"值得注意的是"级）
export const CLICHE_PHRASES_ZH: readonly string[] = [
  // 叙事微表情套话（R3 §3.4 老编辑 + 马良叙事套话）
  '不由得一愣',
  '不由得愣',
  '不由自主',
  '眉头紧锁',
  '深吸一口气',
  '长舒一口气',
  '倒吸一口凉气',
  '嘴角微微上扬',
  '嘴角勾起',
  '眼眸闪过一丝',
  '眼中闪过一丝',
  '眸光一冷',
  '脸色一变',
  '心中一紧',
  '若有所思',
  '暗自庆幸',
  '不由分说',
  '话音刚落',
  '就在这时',
  '突然之间',
  // AI 翻译腔连接词（R3 §3.4 qu-ai-wei A 结构套话 + B AI 高频词翻译腔）
  '然而',
  '不仅如此',
  '值得注意的是',
  '不可否认',
  '毋庸置疑',
  '与此同时',
  '随着',
  '换言之',
  '总而言之',
  '综上所述',
  // 华丽套话意象（R3 §3.4 qu-ai-wei E + ③ 意象降级）
  '璀璨',
  '熠熠生辉',
  '绽放光芒',
  '散发光芒',
  '油然而生',
  '华章',
  // 假坦诚 / 套话开场（R3 §3.4 qu-ai-wei I）
  '不禁让人',
  '令人不禁',
];

// ── crutch 词库（4 类：intensifier / hedging / filler / narrative-action-lag）──
// 源 R3 §6.1 crutch 四类 + §3.3 ①"死"万能副词 + ⑤ action-lag（began to/started to/decided to）。
// 命中 = 正文出现该词。density = 命中数 / token 估计。分类保留（便于 L2 证据标注哪类 crutch）。
//
// intensifier：强度副词滥用（"非常/极其"——R3 §3.3① 万能副词）
// hedging：模糊限制（"似乎/也许"——削弱决断）
// filler：填充冗余（"其实/基本上"——可删词，R3 §3.3⑥ 删冗余）
// narrative：叙事 action-lag（"开始/终于/突然"——R3 §3.3⑤ 主体性丢失，被动/被叙述推）
export const CRUTCH_INTENSIFIER_ZH: readonly string[] = [
  '非常', '极其', '极为', '尤为', '十分', '特别', '真的', '相当', '格外', '万分',
];

export const CRUTCH_HEDGING_ZH: readonly string[] = [
  '似乎', '也许', '或许', '可能', '大概', '仿佛', '差不多', '好像', '约莫',
];

export const CRUTCH_FILLER_ZH: readonly string[] = [
  // B8（CR patch）：删 '总而言之'——已同在 CLICHE_PHRASES_ZH（AI 翻译腔腐朽），跨 bank 双计 clean dup。
  '其实', '基本上', '总的来说', '事实上', '实际上', '不管怎样', '反正', '话说回来',
];

export const CRUTCH_NARRATIVE_ZH: readonly string[] = [
  // B8（CR patch）：'突然' 是 '突然之间'（CLICHE_PHRASES_ZH）的子串——跨 bank 双计（cliche + crutch 各命中一次）。
  // 保留 '突然'：R3 §6.1 narrative action-lag 合法 crutch 信号（太常见不宜删），跨 bank 冗余可接受（软信号 L2 复判）。
  '开始', '终于', '突然', '忽然', '渐渐地', '慢慢地', '不知不觉', '于是', '然后',
];

/**
 * crutch 全量词库（4 类合集）+ per-category 索引（便于 density 合计 + 证据分类标注）。
 * 确定性数据组装，零 LLM、零语义判断。
 */
export interface CrutchWordbank {
  intensifier: readonly string[];
  hedging: readonly string[];
  filler: readonly string[];
  narrative: readonly string[];
  /** 全类合集（去重保序）—— density 合计用。 */
  all: readonly string[];
}

const CRUTCH_ALL_ZH: readonly string[] = Array.from(
  new Set([
    ...CRUTCH_INTENSIFIER_ZH,
    ...CRUTCH_HEDGING_ZH,
    ...CRUTCH_FILLER_ZH,
    ...CRUTCH_NARRATIVE_ZH,
  ]),
);

export const CRUTCH_WORDS_ZH: CrutchWordbank = {
  intensifier: CRUTCH_INTENSIFIER_ZH,
  hedging: CRUTCH_HEDGING_ZH,
  filler: CRUTCH_FILLER_ZH,
  narrative: CRUTCH_NARRATIVE_ZH,
  all: CRUTCH_ALL_ZH,
};

// ── filter 词库（POV 漂移信号：see/hear/think/feel/notice 中文化）──
// 源 R3 §6.1 filter_word_density + §3.3④ POV 丢失（Deep POV 的 see/hear/think/feel/notice 频率）。
// 这些是「叙述者介入」标记（"他看到X" vs Deep POV 直接呈现 X）。density 高 = POV 漂移软信号。
// 单字「想」误命中风险（想法/理想），故用多字形态（想到/想要不在内——「想要」是欲望非 filter）。
//
// 命中 = 正文出现该词（子串）。density = 命中数 / token 估计。
export const FILTER_WORDS_ZH: readonly string[] = [
  '看到',
  '看见',
  '望见',
  '瞥见',
  '听到',
  '听见',
  '想到',
  '感觉',
  '感到',
  '感觉到',
  '注意到',
  '发觉',
  '发现',
  '明白',
  '意识到',
  '察觉',
  '察觉到',
];
