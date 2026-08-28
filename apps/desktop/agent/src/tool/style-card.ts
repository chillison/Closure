import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSettingMdContent } from '@orison/shared-contracts';
import { logger } from '../logger';

// ── 风格卡片 MVP（task 08-28-style-card-mvp B 路）：消费侧装配纯函数 ──
//
// 载体 = settings/style.md（设定文档族成员，A 路分析者产卡 + 人审落盘；卡内容模型 14 节 v3
// 见 design §1——节标题由 style-analyzer-agent.yaml 契约固定为 `## ① 声音画像` 形态）。本模块
// 只做**消费侧**的两路编译（design §3 注入面矩阵，D7 拍板）：
//
// - `style_context`（全量版，写手/精修/writer-selfcheck 消费）：①-⑫ 节全量（⑫ 禁则 CR-003 拍板 3a
//   纳入——写手/精修同受负面清单约束）+ ⑬ 节 fenced 原文节选（**cap 2000 字常量**，D2——卡内仍存
//   完整原文，有界的只是注入量）。fenced 块缺失/提取失败 → 回落 mainParts（①-⑫ 拼接）截断至 cap
//   （CR-010——⑭ 附录与卡头不混入写手上下文；不崩链，R5）。
// - `style_context_brief`（精简版，两 planner 派发消费）：声音画像 + 禁则 + 情绪手法 + 期待管理
//   四节要点（规划期就要对齐的四件，D7）——不带 few-shot 原文与文字层细节；某节缺失就省略该节
//   （宁缺毋滥同款纪律——分析者对证据不足的节整节省略，消费侧不编造）。
//
// 范式判据（ADR-3）：节定位（标题匹配）/fenced 块提取/截断 = 纯代码机械（查询/汇编）；「挑哪段
// 做节选」「各节写什么模仿指令」归分析者 LLM（A 路）——消费端只做机械提取 + cap。
//
// 落点 src/tool/（write-chapter.ts 邻近，implement.md「提取/截断逻辑写成纯函数，同文件或邻近，
// 不开新包」）；write-chapter.ts（链段装配）与 dispatch-planners.ts（规划派发 vars）两处消费。
//
// expected_downstream_consumers:
// - write-chapter.ts execute：readStyleCardBody → buildStyleContext → post-assemble 注入
//   initialArtifacts['style_context']（mirror world_state_snapshot optional 注入模式；无卡零 artifact，
//   AC3 零回归。CR-006 后不再产 style_context_brief——精简版走 dispatch-planners 现读现编）。
// - dispatch-planners.ts executePlannerDispatch：readStyleCardBody → buildStyleBrief → 两 planner
//   runAgentWithExplicitSystem vars `styleBrief`。

/** 节选注入上限（D2 拍板：要点全量 + 节选有界，cap 2000 字常量；导出供测试断言）。 */
export const STYLE_CARD_EXCERPT_CAP = 2000;

/** 风格卡落点文件名（与 A 路 dispatch-style-analyzer STYLE_CARD_SETTING_ID 同源约定）。 */
const STYLE_CARD_FILE = path.join('settings', 'style.md');

/** 节选超 cap 截断时的尾注（一行，写手知道范本被截断）。 */
const EXCERPT_TRUNCATION_NOTE = '\n……（节选超 2000 字上限，此处截断）';

/** 回落（要点全文）超 cap 截断时的尾注（CR-010：回落只截 mainParts 非⑭混入的整卡）。 */
const FALLBACK_TRUNCATION_NOTE = '\n……（风格卡要点超 2000 字上限，此处截断）';

/** style_context 开场说明（写作本位口吻——告诉写手这是什么、怎么用；无实现词汇）。 */
const STYLE_CONTEXT_INTRO =
  '以下是本项目的风格卡——作者选定要模仿的文风。写作时按各节的模仿指令执行；末尾的节选是原文范本，句法与声音以它为准。';

/** fenced 提取失败回落要点全文时的说明（诚实告知供给形态变化，不静默）。 */
const FALLBACK_NOTE = '\n（风格卡中未找到节选原文块，已退回要点全文截断供给）';

// ── 节定义与解析（节标题匹配，tolerant mirror A 路 STATS_HEADING_RE 的 ①/数字 变体容错）──

/** 14 节 v3 语义键（design §1 节号语义；匹配按节名文本，容忍编号/分隔符变体与手改）。 */
export type StyleSectionKey =
  | 'voice' // ① 声音画像
  | 'stats' // ② 机械统计
  | 'syntax' // ③ 句法与文字节奏
  | 'narrative' // ④ 叙事节奏
  | 'dialogue' // ⑤ 对话
  | 'description' // ⑥ 描写的取舍
  | 'imagery' // ⑦ 意象与比喻思维
  | 'emotion' // ⑧ 情绪手法
  | 'info' // ⑨ 信息处理
  | 'character' // ⑩ 人物呈现法
  | 'expectation' // ⑪ 期待管理
  | 'prohibitions' // ⑫ 禁则
  | 'excerpt' // ⑬ 节选（few-shot）
  | 'appendix'; // ⑭ 原文附录

interface StyleSectionDef {
  key: StyleSectionKey;
  /** 节名匹配正则（对标题行文本匹配，非整卡正文）。 */
  re: RegExp;
}

/** 节定义表（按卡内顺序 ①→⑭；匹配按节名——编号变体（①/1/无编号）天然容忍）。 */
const SECTION_DEFS: readonly StyleSectionDef[] = [
  { key: 'voice', re: /声音画像/ },
  { key: 'stats', re: /机械统计/ },
  { key: 'syntax', re: /句法与文字节奏|句法与节奏|文字节奏/ },
  { key: 'narrative', re: /叙事节奏/ },
  { key: 'dialogue', re: /对话/ },
  { key: 'description', re: /描写的取舍|描写.*取舍/ },
  { key: 'imagery', re: /意象与比喻|意象.*比喻|比喻思维/ },
  { key: 'emotion', re: /情绪手法/ },
  { key: 'info', re: /信息处理/ },
  { key: 'character', re: /人物呈现/ },
  { key: 'expectation', re: /期待管理/ },
  { key: 'prohibitions', re: /禁则/ },
  { key: 'excerpt', re: /节选/ },
  { key: 'appendix', re: /原文附录|附录/ },
];

/** 解析出的单节（heading 原行 + 内容至下一 `## ` 节或卡尾；key=null = 未识别节）。 */
export interface StyleCardSection {
  heading: string;
  content: string;
  key: StyleSectionKey | null;
}

/**
 * `## ` 节标题行（markdown 二级标题；`# ` 一级与 `### ` 以下不切节）。
 * CR-009（A/B 容差统一）：`##` 后**零空白容忍**（`\s*`——与 A 路 STATS_HEADING_RE 同语义，
 * `##②声音画像` 无空格形态也命中）；`(?!#)` 排除 `### ` 及以下（`\s*` 放宽后防三级标题误切节）。
 */
const HEADING_LINE_RE = /^##(?!#)\s*(.+?)\s*$/;

/** 按节名匹配语义键（首个命中的 def；未识别 → null——保留原节不误删，仅不参与定向编译）。 */
function matchSectionKey(headingText: string): StyleSectionKey | null {
  for (const def of SECTION_DEFS) {
    if (def.re.test(headingText)) return def.key;
  }
  return null;
}

/**
 * 把风格卡正文切成节序列（纯函数）。逐行扫 `## ` 标题切节；卡头（`# 风格卡片` H1 + 分工注记）
 * 落在首节 heading 之前，不进任何节（brief/full 编译都不带卡头）。未识别标题的节保留（key=null）
 * ——消费侧按 key 定向取节，未识别节自然不进两路输出，不误删作者手加的节。
 *
 * CR-008（fenced 感知）：``` 围栏内的行**不切节**——⑬ 节选/⑭ 附录内嵌的小说原文常含 `## 第X章`
 * 类行，无围栏感知时会把原文误切成新节（节选/附录内容被腰斩 + 假节混入解析）。围栏行自身
 * （```text 开 / ``` 合）仍属当前节内容（extractFewShotExcerpt 靠节内容里的 ``` 定位块）。
 */
export function parseStyleSections(body: string): StyleCardSection[] {
  const lines = body.split('\n');
  const sections: StyleCardSection[] = [];
  let current: StyleCardSection | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (current) current.content += current.content.length > 0 ? `\n${line}` : line;
      continue;
    }
    // 围栏内一律作正文（`## ` 行不切节）；围栏外照常识别标题。
    const match = inFence ? null : HEADING_LINE_RE.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { heading: line, content: '', key: matchSectionKey(match[1] ?? '') };
    } else if (current) {
      current.content += current.content.length > 0 ? `\n${line}` : line;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** 定位单节（按语义键；缺 → undefined——宁缺毋滥，缺节省略不编造）。 */
function findSection(sections: readonly StyleCardSection[], key: StyleSectionKey): StyleCardSection | undefined {
  return sections.find((s) => s.key === key);
}

/** 节原文形态（heading + content，卡内逐字）。 */
function sectionText(section: StyleCardSection): string {
  return section.content.trim().length > 0 ? `${section.heading}\n${section.content.trim()}` : section.heading;
}

/** ⑬ 节内第一个 fenced 代码块内容（分析者契约：800-2000 字连续原文以 ```text 包裹）。 */
export function extractFewShotExcerpt(excerptSection: StyleCardSection | undefined): string | undefined {
  if (!excerptSection) return undefined;
  const match = /```[^\n]*\n([\s\S]*?)```/.exec(excerptSection.content);
  if (!match || !match[1]) return undefined;
  const inner = match[1].replace(/\n$/, '');
  return inner.trim().length > 0 ? inner : undefined;
}

/**
 * 截断保头 + 尾注（超 cap 时；未超原样返回）。
 * CR-024（代理对守卫）：cap 边界恰落在 UTF-16 代理对中间（截断段末位是高代理、搭档低代理被切掉）
 * 时回退一个码元再接尾注——不产孤儿代理（下游 prompt 渲染 / 词级 diff 乱码）；mirror author-profile
 * 截断 CR-011 退位法。
 */
function truncateWithNote(text: string, cap: number, note: string): string {
  if (text.length <= cap) return text;
  let end = cap;
  if (/[\uD800-\uDBFF]$/.test(text.slice(0, end))) end -= 1;
  return `${text.slice(0, end)}${note}`;
}

/** 全量版收录的语义键（CR-003 拍板 3a：①-⑫ 节全量——⑫ 禁则纳入，写手/精修同受负面清单约束；
 * ⑬ 节选走独立 fenced 块；⑭ 附录留卡内不进每章注入）。 */
const FULL_CONTEXT_KEYS: readonly StyleSectionKey[] = [
  'voice', 'stats', 'syntax', 'narrative', 'dialogue', 'description', 'imagery',
  'emotion', 'info', 'character', 'expectation', 'prohibitions',
];

/**
 * 编译 `style_context`（全量版，写手/精修/selfcheck 消费；纯函数）。
 *
 * 正常路径：intro + ①-⑫ 节全量（卡内序、逐字——含 ② 机械统计块 + ⑫ 禁则，CR-003）+ ⑬ 节
 * fenced 节选（cap 2000，超限截断 + 尾注）。fenced 块缺失/提取失败 → 回落 mainParts（①-⑫ 拼接）
 * 截断至 cap + 说明行（CR-010：只截要点拼接而非整卡——卡头 H1/⑬ 废节壳/⑭ 原文附录不混入写手
 * 上下文；不崩链——卡可能被手改，消费侧 graceful，R5）。空卡体 / 回落时要点全缺 → ''（caller
 * 不注入 artifact）。
 */
export function buildStyleContext(cardBody: string): string {
  const body = cardBody.trim();
  if (body.length === 0) return '';
  const sections = parseStyleSections(body);

  // ①-⑫ 节全量（卡内序；缺节自然缺席——宁缺毋滥的卡是常态）。
  const mainParts = sections
    .filter((s) => s.key !== null && FULL_CONTEXT_KEYS.includes(s.key))
    .map(sectionText);

  // ⑬ 节 fenced 节选；提取失败 → 回落 mainParts 截断（fenced 缺失/节缺失/块空 同归一路径）。
  const excerpt = extractFewShotExcerpt(findSection(sections, 'excerpt'));
  if (excerpt === undefined) {
    // CR-010：要点也全缺（无任何可识别节 + 无节选）→ 无从编译，返 '' 让 caller 零注入
    //（不产「intro + 说明行」的空壳上下文）。
    if (mainParts.length === 0) return '';
    const truncated = truncateWithNote(mainParts.join('\n\n'), STYLE_CARD_EXCERPT_CAP, FALLBACK_TRUNCATION_NOTE);
    return `${STYLE_CONTEXT_INTRO}\n\n${truncated}${FALLBACK_NOTE}`;
  }

  const cappedExcerpt = truncateWithNote(excerpt, STYLE_CARD_EXCERPT_CAP, EXCERPT_TRUNCATION_NOTE);
  const excerptBlock = ['## ⑬ 节选（few-shot 原文范本）', '', '```text', cappedExcerpt, '```'].join('\n');
  return [STYLE_CONTEXT_INTRO, ...mainParts, excerptBlock].join('\n\n');
}

/** 精简版收录的语义键（D7 拍板顺序：声音画像 + 禁则 + 情绪手法 + 期待管理——规划期对齐四件）。 */
const BRIEF_SECTION_KEYS: readonly StyleSectionKey[] = ['voice', 'prohibitions', 'emotion', 'expectation'];

/**
 * 编译 `style_context_brief`（精简版，两 planner 派发消费；纯函数）。
 *
 * 四节要点按 D7 顺序（声音画像+禁则+情绪手法+期待管理），无 few-shot 原文与文字层细节；
 * 某节缺失就省略该节（宁缺毋滥同款纪律）；四节全缺 → ''（caller 不注入/不占位）。
 */
export function buildStyleBrief(cardBody: string): string {
  const body = cardBody.trim();
  if (body.length === 0) return '';
  const sections = parseStyleSections(body);
  const parts: string[] = [];
  for (const key of BRIEF_SECTION_KEYS) {
    const section = findSection(sections, key);
    if (section) parts.push(sectionText(section));
  }
  return parts.join('\n\n');
}

// ── 文件读取（mirror write-chapter.ts loadChainProjectInput / dispatch-style-analyzer readCurrentStyleCard 防御）──

/** BOM strip + CRLF→LF——单源 shared-contracts normalizeSettingMdContent（seam 5：与 A 路
 * readCurrentStyleCard / applySettingMdActions 入口同一实现，勿复制）。 */
function normalizeCardContent(content: string): string {
  return normalizeSettingMdContent(content) ?? '';
}

/** 取 frontmatter 关闭栅栏后的正文（无 frontmatter → 整个内容为正文；mirror A 路 styleCardBody）。 */
function stripFrontmatter(normalized: string): string {
  const fence = /^---\n[\s\S]*?\n---\n?/.exec(normalized);
  return fence ? normalized.slice(fence[0].length) : normalized;
}

/**
 * 读项目风格卡正文（settings/style.md）。返回归一后卡体（BOM/CRLF 归一 + frontmatter 剥离）；
 * undefined = 无卡（文件不存在）/ 卡体空白 / 读失败（消费侧只读不写——读失败 graceful 降级
 * undefined + warn，不崩链不阻断写章，mirror「风格卡纯增益不阻塞」design §3）。
 */
export async function readStyleCardBody(projectPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectPath, STYLE_CARD_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; // 无卡 = 正常态（零回归路径）
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), projectPath },
      'style-card: settings/style.md 读失败 → 按“无卡”降级（本轮不注入风格上下文）',
    );
    return undefined;
  }
  const body = stripFrontmatter(normalizeCardContent(raw));
  return body.trim().length > 0 ? body : undefined;
}
