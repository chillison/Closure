import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 风格卡片 MVP（task 08-28-style-card-mvp B 路）消费侧装配纯函数测试。
//
// 卡内容模型 14 节 v3 对齐 A 路 style-analyzer-agent.yaml 契约（节标题 `## ① 声音画像` 形态，
// ⑬ 节选 fenced ```text 包裹）。测四态（implement.md Step 5）：
// 1. 有卡全量：style_context = ①-⑫ 节全量（CR-003 拍板 3a：⑫ 禁则纳入）+ 节选块；不含 ⑭ 原文附录。
// 2. 节选超 cap：截断 + 尾注（cap 2000 常量，D2；CR-024 代理对守卫——cap 边界劈半 emoji 退位）。
// 3. fenced 缺失：回落 mainParts（①-⑫ 拼接）截断（+ 说明行，不崩链；CR-010——⑭/卡头不混入）。
// 4. 无卡：buildStyleContext/buildStyleBrief → ''（caller 不注入 artifact，AC3 零回归）。
// 另：brief 四节配方（D7：声音画像+禁则+情绪手法+期待管理；缺节省略）+ 节切 fenced 感知
// （CR-008）+ 标题零空白容忍（CR-009）+ 文件读取归一。
// ─────────────────────────────────────────────────────────────────────────────

import {
  STYLE_CARD_EXCERPT_CAP,
  buildStyleBrief,
  buildStyleContext,
  extractFewShotExcerpt,
  parseStyleSections,
  readStyleCardBody,
  type StyleCardSection,
} from '../src/tool/style-card';
import { buildStyleCardActions, injectStyleStatsBlock } from '../src/tool/dispatch-style-analyzer';
import { applySettingMdActions } from '@orison/shared-contracts';

/** 完整 14 节卡 fixture（宁缺毋滥全节在场形态；节选文本可注入）。 */
function fullCard(excerptText: string, appendixText = '完整原文附录正文……'): string {
  return [
    '# 风格卡片',
    '',
    '> 本卡管「像谁」（正面画像）；llmlint 管「不像 AI」（负面清单）——两者互补。',
    '',
    '## ① 声音画像',
    '叙述者冷静旁观，对人物带一点悲悯。',
    '- 引证：「他没说话。」',
    '- 手法：零修饰短句收束',
    '- 模仿：多用短句收住情绪段',
    '',
    '## ② 机械统计（代码预计算）',
    '',
    '句长中位数：18 字；对话行占比：34%',
    '',
    '## ③ 句法与文字节奏',
    '长短交替呼吸，逗号切分气流。',
    '',
    '## ④ 叙事节奏',
    '场景硬切，喘息段短。',
    '',
    '## ⑤ 对话',
    '动作代标签，潜台词密。',
    '',
    '## ⑥ 描写的取舍',
    '一个精确细节胜过铺满一片。',
    '',
    '## ⑦ 意象与比喻思维',
    '喻体取自农事与天气。',
    '',
    '## ⑧ 情绪手法',
    '情绪外化为身体反应，落点在动作后。',
    '',
    '## ⑨ 信息处理',
    '读者先知，人物后知。',
    '',
    '## ⑩ 人物呈现法',
    '行动立人，心理独白少。',
    '',
    '## ⑪ 期待管理',
    '章尾悬崖切。',
    '',
    '## ⑫ 禁则',
    '不用感叹号；不写心理报告式说明。',
    '',
    '## ⑬ 节选（few-shot）',
    '',
    '```text',
    excerptText,
    '```',
    '',
    '## ⑭ 原文附录',
    '',
    '```text',
    appendixText,
    '```',
    '',
  ].join('\n');
}

/** 短节选（< cap）。 */
const SHORT_EXCERPT = '他推门进来，风先到。桌上的茶凉了半盏，他没有喝，只是站着看了一会儿，然后转身走了。';

describe('style-card：buildStyleContext（全量版四态）', () => {
  it('有卡全量：intro + ①-⑫ 节全量（CR-003 含⑫禁则）+ 节选 fenced 块；不含 ⑭ 原文附录', () => {
    const context = buildStyleContext(fullCard(SHORT_EXCERPT, '附录原文不应出现'));
    // 开场说明在场（写作本位口吻）。
    expect(context).toContain('模仿的文风');
    // ①-⑫ 各节标题 + 内容在场（含 ② 机械统计 + ⑫ 禁则——CR-003 拍板 3a 纳入全量版）。
    for (const heading of ['① 声音画像', '② 机械统计', '③ 句法与文字节奏', '④ 叙事节奏', '⑤ 对话',
      '⑥ 描写的取舍', '⑦ 意象与比喻思维', '⑧ 情绪手法', '⑨ 信息处理', '⑩ 人物呈现法', '⑪ 期待管理', '⑫ 禁则']) {
      expect(context).toContain(`## ${heading}`);
    }
    expect(context).toContain('零修饰短句收束');
    expect(context).toContain('句长中位数：18 字');
    // CR-003：禁则正文进写手上下文（写手同受负面清单约束——原 not.toContain 断言反转）。
    expect(context).toContain('不用感叹号');
    // 节选：独立块标题 + fenced 原文逐字。
    expect(context).toContain('## ⑬ 节选（few-shot 原文范本）');
    expect(context).toContain('```text');
    expect(context).toContain(SHORT_EXCERPT);
    // ⑭ 附录留卡内不进每章注入。
    expect(context).not.toContain('附录原文不应出现');
    expect(context).not.toContain('## ⑭ 原文附录');
  });

  it('节选超 cap：截断至 2000 字 + 尾注一行', () => {
    const longExcerpt = '句子片段持续输出。'.repeat(700); // 8 字 × 700 = 5600 > 2000
    expect(longExcerpt.length).toBeGreaterThan(STYLE_CARD_EXCERPT_CAP);
    const context = buildStyleContext(fullCard(longExcerpt));
    expect(context).toContain('此处截断');
    // fenced 块内节选主体 ≤ cap（尾注一行除外——截断保头 + 一行注记）。
    const fenced = /```text\n([\s\S]*?)\n```/.exec(context);
    expect(fenced).not.toBeNull();
    const inner = fenced![1]!;
    expect(inner.length).toBeLessThanOrEqual(STYLE_CARD_EXCERPT_CAP + 50); // 主体 2000 + 尾注一行余量
    expect(inner.startsWith('句子片段持续输出')).toBe(true);
  });

  it('CR-024：cap 边界劈半代理对（emoji）时回退一个码元——截断段尾不产孤儿高代理', () => {
    // 1999 个 'x' + 10 个 😀（每个 2 码元）：length = 2019 > 2000，且 slice(0,2000) 恰以第一个
    // emoji 的高代理收尾（低代理被切掉）——不守卫会留孤儿高代理（乱码源）。
    const emojiExcerpt = 'x'.repeat(1999) + '😀'.repeat(10);
    expect(emojiExcerpt.length).toBe(2019);
    const context = buildStyleContext(fullCard(emojiExcerpt));
    const fenced = /```text\n([\s\S]*?)\n```/.exec(context);
    expect(fenced).not.toBeNull();
    const inner = fenced![1]!;
    // 尾注一行剥离后的主体：末码元是 'x'（回退守卫生效），非孤儿高代理（0xD800-0xDBFF）。
    const body = inner.split('\n')[0]!;
    expect(body.length).toBe(1999);
    const lastCode = body.charCodeAt(body.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    expect(body.endsWith('x')).toBe(true);
    expect(context).toContain('此处截断');
  });

  it('fenced 缺失（⑬ 节无代码块）：回落 mainParts（①-⑫）截断 + 说明行；⑭/卡头不混入（CR-010）', () => {
    const brokenCard = fullCard(SHORT_EXCERPT, '附录原文不应出现').replace(/```text\n[\s\S]*?```\n\n## ⑭/, '（节选原文被手删了）\n\n## ⑭');
    const context = buildStyleContext(brokenCard);
    // 回落说明行在场（诚实告知供给形态变化）。
    expect(context).toContain('未找到节选原文块');
    expect(context).toContain('已退回要点全文截断供给');
    // CR-010：回落只截 mainParts 拼接——卡头 H1 / ⑬ 废节壳 / ⑭ 附录不进写手上下文。
    expect(context).not.toContain('# 风格卡片');
    expect(context).not.toContain('附录原文不应出现');
    expect(context).not.toContain('## ⑭ 原文附录');
    // ①-⑫ 要点在场（含 ⑫ 禁则——CR-003 后 mainParts 含⑫）。
    expect(context).toContain('## ① 声音画像');
    expect(context).toContain('不用感叹号');
    // 无 fenced 节选块。
    expect(context).not.toContain('## ⑬ 节选（few-shot 原文范本）');
  });

  it('fenced 缺失 + 要点超 cap：mainParts 截断至 cap + 截断尾注（⑭ 长附录不参与截断段）', () => {
    // 长 content 放进 ① 节（mainParts 之内）——若回落仍灌整卡，⑭ 附录与卡尾长文会混进截断段。
    const bigFirst = fullCard(SHORT_EXCERPT, `${'附录长文不应出现。'.repeat(400)}`).replace(
      '叙述者冷静旁观，对人物带一点悲悯。',
      `叙述者冷静旁观。${'手加的长内容。'.repeat(600)}`,
    );
    const brokenCard = bigFirst.replace(/```text\n[\s\S]*?```\n\n## ⑭/, '（节选原文被手删了）\n\n## ⑭');
    const context = buildStyleContext(brokenCard);
    expect(context).toContain('未找到节选原文块');
    expect(context).toContain('风格卡要点超 2000 字上限');
    // 供给主体有界（intro + 截断要点 + 两行注记）。
    expect(context.length).toBeLessThanOrEqual(STYLE_CARD_EXCERPT_CAP + 400);
    // ⑭ 附录不混入（整卡回落时的越界内容——现在被 mainParts 边界挡住）。
    expect(context).not.toContain('附录长文不应出现');
  });

  it('fenced 缺失 + 要点全缺（无可识别节）→ 空串零注入（不产 intro 空壳，CR-010）', () => {
    const unrecognizable = ['# 风格卡片', '', '> 只有卡头与自由文本，没有任何可识别节。', ''].join('\n');
    expect(buildStyleContext(unrecognizable)).toBe('');
  });

  it('空卡体 → 空串（caller 不注入 artifact）', () => {
    expect(buildStyleContext('')).toBe('');
    expect(buildStyleContext('   \n  ')).toBe('');
  });
});

describe('style-card：buildStyleBrief（精简版四节配方，D7）', () => {
  it('四节全命中：声音画像+禁则+情绪手法+期待管理；无 few-shot 原文与文字层细节', () => {
    const brief = buildStyleBrief(fullCard(SHORT_EXCERPT));
    for (const heading of ['## ① 声音画像', '## ⑫ 禁则', '## ⑧ 情绪手法', '## ⑪ 期待管理']) {
      expect(brief).toContain(heading);
    }
    // 文字层细节与 few-shot 原文不进精简版。
    expect(brief).not.toContain('## ③ 句法与文字节奏');
    expect(brief).not.toContain('## ⑤ 对话');
    expect(brief).not.toContain('```text');
    expect(brief).not.toContain(SHORT_EXCERPT);
    expect(brief).not.toContain('原文附录');
  });

  it('缺节省略（宁缺毋滥同款）：卡只有 ① → brief 只含声音画像', () => {
    const partial = ['# 风格卡片', '', '## ① 声音画像', '冷静旁观。', '', '## ③ 句法与文字节奏', '长短交替。', ''].join('\n');
    const brief = buildStyleBrief(partial);
    expect(brief).toContain('## ① 声音画像');
    expect(brief).toContain('冷静旁观。');
    expect(brief).not.toContain('禁则');
    expect(brief).not.toContain('句法');
  });

  it('四节全缺 → 空串（不注入/不占位）', () => {
    const partial = ['# 风格卡片', '', '## ③ 句法与文字节奏', '长短交替。', ''].join('\n');
    expect(buildStyleBrief(partial)).toBe('');
    expect(buildStyleBrief('')).toBe('');
  });
});

describe('style-card：节解析与节选提取（纯机械）', () => {
  it('parseStyleSections：14 节逐一切出（卡头 H1 与引言不进节）+ 编号变体容忍', () => {
    const sections = parseStyleSections(fullCard(SHORT_EXCERPT));
    const keys = sections.map((s: StyleCardSection) => s.key);
    expect(keys).toEqual([
      'voice', 'stats', 'syntax', 'narrative', 'dialogue', 'description', 'imagery',
      'emotion', 'info', 'character', 'expectation', 'prohibitions', 'excerpt', 'appendix',
    ]);
    // 未识别节保留（key=null），不误删作者手加的节。
    const withCustom = `${fullCard(SHORT_EXCERPT)}\n## 附：自定义节\n内容。\n`;
    const parsed = parseStyleSections(withCustom);
    expect(parsed.some((s: StyleCardSection) => s.key === null && s.heading.includes('自定义节'))).toBe(true);
    // 手改编号变体（阿拉伯数字/无分隔）照常命中。
    const renumbered = ['# 风格卡片', '', '## 1. 声音画像', '内容。', ''].join('\n');
    expect(parseStyleSections(renumbered)[0]!.key).toBe('voice');
  });

  it('CR-009：标题零空白容忍（`##①声音画像` 无空格形态命中——与 A 路 STATS_HEADING_RE \\s* 同语义）；`### ` 仍不切节', () => {
    const noSpace = ['# 风格卡片', '', '##①声音画像', '内容一。', '## ⑫ 禁则', '不用感叹号。', ''].join('\n');
    const sections = parseStyleSections(noSpace);
    expect(sections.map((s: StyleCardSection) => s.key)).toEqual(['voice', 'prohibitions']);
    // 放宽为 \s* 后 `### ` 及以下不得误切节（(?!#) 前瞻）——手编卡的三级子标题留在所属节内。
    const withSub = ['# 风格卡片', '', '## ① 声音画像', '正文。', '### 子标题', '子标题内容。', ''].join('\n');
    const sub = parseStyleSections(withSub);
    expect(sub).toHaveLength(1);
    expect(sub[0]!.key).toBe('voice');
    expect(sub[0]!.content).toContain('### 子标题');
    expect(sub[0]!.content).toContain('子标题内容。');
  });

  it('CR-008：fenced 围栏内 `## ` 行不切节（⑬/⑭ 内嵌小说原文含章节标记不误切）+ 围栏行留节内容', () => {
    const card = [
      '# 风格卡片', '',
      '## ① 声音画像', '冷静旁观。', '',
      '## ⑬ 节选（few-shot）', '',
      '```text',
      '正文开头。',
      '## 第十二章 旧宅',
      '他推门进来，风先到。',
      '```',
      '',
      '## ⑭ 原文附录', '',
      '```text',
      '## 第一章',
      '附录正文。',
      '```',
      '',
    ].join('\n');
    const sections = parseStyleSections(card);
    // 无围栏感知时 `## 第十二章`/`## 第一章` 会各切成假节——现在 14 节模型只切真标题。
    expect(sections.map((s: StyleCardSection) => s.key)).toEqual(['voice', 'excerpt', 'appendix']);
    // ⑬ 节选 fenced 内容逐字提取（内嵌 `## ` 行原样保留——few-shot 完整性）。
    const excerpt = extractFewShotExcerpt(sections.find((s: StyleCardSection) => s.key === 'excerpt'));
    expect(excerpt).toBe('正文开头。\n## 第十二章 旧宅\n他推门进来，风先到。');
    // 全量版消费端不产假节：完整节选（含内嵌 ## 行）原样进 fenced 块——被误切时此处会缺尾巴。
    const context = buildStyleContext(card);
    expect(context).toContain('正文开头。\n## 第十二章 旧宅\n他推门进来，风先到。');
  });

  it('extractFewShotExcerpt：fenced 内容逐字提取（含语言标注容忍）；无块/空块 → undefined', () => {
    const sections = parseStyleSections(fullCard(SHORT_EXCERPT));
    const excerpt = extractFewShotExcerpt(sections.find((s: StyleCardSection) => s.key === 'excerpt'));
    expect(excerpt).toBe(SHORT_EXCERPT);
    expect(extractFewShotExcerpt(undefined)).toBeUndefined();
    const noFence = parseStyleSections(['## ⑬ 节选（few-shot）', '直接裸文本没有围栏。', ''].join('\n'))[0]!;
    expect(extractFewShotExcerpt(noFence)).toBeUndefined();
    const emptyFence = parseStyleSections(['## ⑬ 节选（few-shot）', '```text', '   ', '```', ''].join('\n'))[0]!;
    expect(extractFewShotExcerpt(emptyFence)).toBeUndefined();
  });
});

describe('style-card：readStyleCardBody（文件读取归一）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-style-card-'));
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  function writeStyleCard(content: string): void {
    mkdirSync(path.join(projectPath, 'settings'), { recursive: true });
    writeFileSync(path.join(projectPath, 'settings', 'style.md'), content, 'utf8');
  }

  it('无卡（文件不存在）→ undefined（零回归常态路径）', async () => {
    expect(await readStyleCardBody(projectPath)).toBeUndefined();
  });

  it('frontmatter 剥离 + BOM strip + CRLF→LF 归一', async () => {
    const body = fullCard(SHORT_EXCERPT);
    writeStyleCard(`\uFEFF---\nid: style\ntype: style\r\n---\r\n${body.replace(/\n/g, '\r\n')}`);
    const read = await readStyleCardBody(projectPath);
    expect(read).toBeDefined();
    expect(read).not.toContain('---'); // frontmatter 已剥
    expect(read).not.toContain('\r');
    expect(read).toContain('## ① 声音画像');
    // 归一后可直接进两路编译。
    expect(buildStyleContext(read!)).toContain(SHORT_EXCERPT);
  });

  it('卡体空白（只有 frontmatter / 全空白）→ undefined', async () => {
    writeStyleCard('---\nid: style\n---\n');
    expect(await readStyleCardBody(projectPath)).toBeUndefined();
    writeStyleCard('   \n\t\n');
    expect(await readStyleCardBody(projectPath)).toBeUndefined();
  });

  it('无 frontmatter 裸卡照常读（手写形态）', async () => {
    writeStyleCard(fullCard(SHORT_EXCERPT));
    const read = await readStyleCardBody(projectPath);
    expect(read).toContain('# 风格卡片');
    expect(read).toContain('## ① 声音画像');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A↔B 跨路接缝契约测试（trellis-check 2026-08-28）：A/B/C 三路并行实施各自单路验证过，
// 但接缝从未被验证——此处把 A 的 yaml 契约（节标题**从实文件提取**，非手抄）作为唯一事实源，
// 构造样例卡跑 B 的两个纯函数 + A 的统计注入 + envelope→apply（accept 落盘模拟）→B 读回编译
// 全链，钉死三条 seam：
// - seam 1：A yaml 产出的节标题格式 ↔ B SECTION_DEFS 节名匹配逐字兼容（含 ⑬ fenced 节选提取）。
// - seam 2：A「②节只写标题、统计块由 injectStyleStatsBlock 机械注入」与 yaml 契约互认，且注入后
//   的 ② 节仍被 B 解析为 stats 节并进全量版。
// - seam 5：envelope（settingId='style'）→ applySettingMdActions（accept 重放同核）落盘 → B
//   readStyleCardBody 读回（含 BOM+CRLF 盘上最坏形态）→ 两路编译全通——文件名/路径/归一单口径。
// ─────────────────────────────────────────────────────────────────────────────

/** 从 A 的 yaml 实文件提取第三步列出的 14 节标题（节标题契约唯一事实源；漂移即红）。 */
function yamlSectionHeadings(): string[] {
  const raw = readFileSync(
    path.join(__dirname, '..', 'prompts', 'style-analyzer-agent.yaml'),
    'utf8',
  );
  return [...raw.matchAll(/^ +- `## (.+?)`/gm)].map((m) => m[1]!);
}

/** 按 A yaml 契约构造样例卡：全部节标题从 yaml 提取；② 只写标题（统计由系统注入）、
 * ⑬/⑭ fenced 块、其余节各一行内容（宁缺毋滥形态由其他 describe 覆盖，此处测全节形态）。 */
function contractSampleCard(excerptText: string): string {
  const parts: string[] = ['# 风格卡片', '', '> 本卡管「像谁」（正面画像）；llmlint 管「不像 AI」（负面清单）——两者互补。', ''];
  for (const heading of yamlSectionHeadings()) {
    parts.push(`## ${heading}`);
    if (heading.startsWith('②')) continue; // 契约：分析者只写标题，统计块由系统机械注入。
    if (heading.startsWith('⑬')) {
      parts.push('', '```text', excerptText, '```', '');
      continue;
    }
    if (heading.startsWith('⑭')) {
      parts.push('', '```text', `${excerptText}（完整原文附录）`, '```', '');
      continue;
    }
    parts.push('', `「引证」· ${heading} 的观察内容。`, '');
  }
  return parts.join('\n');
}

describe('A↔B 跨路接缝：yaml 契约样例卡 → 统计注入 → envelope → 落盘 → 消费编译', () => {
  const SEAM_EXCERPT = '风从街口灌进来，他缩了缩脖子，没有回头。灯影在墙上晃了两晃，像有人跟在身后，其实没有。';
  const SEAM_STATS = '- 字数（非空白字符）：951｜句长分布：短句（≤10字） 61.5%';

  it('seam 1：yaml 实文件提得出 14 节标题，B parseStyleSections 逐节全中（无未识别节）', () => {
    const headings = yamlSectionHeadings();
    // 提取面 sanity：14 条、编号 ①→⑭ 序与 yaml 第三步一致（漂移即红——这是接缝的事实源断言）。
    expect(headings).toEqual([
      '① 声音画像', '② 机械统计', '③ 句法与文字节奏', '④ 叙事节奏', '⑤ 对话',
      '⑥ 描写的取舍', '⑦ 意象与比喻思维', '⑧ 情绪手法', '⑨ 信息处理', '⑩ 人物呈现法',
      '⑪ 期待管理', '⑫ 禁则', '⑬ 节选（few-shot）', '⑭ 原文附录',
    ]);
    const sections = parseStyleSections(contractSampleCard(SEAM_EXCERPT));
    expect(sections.map((s: StyleCardSection) => s.key)).toEqual([
      'voice', 'stats', 'syntax', 'narrative', 'dialogue', 'description', 'imagery',
      'emotion', 'info', 'character', 'expectation', 'prohibitions', 'excerpt', 'appendix',
    ]);
    // ⑬ fenced 节选提取逐字成功（seam 1 的 fenced 约定——yaml ```text 包裹 ↔ B extractFewShotExcerpt）。
    expect(extractFewShotExcerpt(sections.find((s: StyleCardSection) => s.key === 'excerpt'))).toBe(SEAM_EXCERPT);
  });

  it('seam 1/2：brief 四节全中 + 无 few-shot；统计注入后的 ② 节仍解析为 stats 并进全量版', () => {
    const card = contractSampleCard(SEAM_EXCERPT);
    // brief：D7 四节配方按 yaml 标题命中；few-shot 原文与附录不进。
    const brief = buildStyleBrief(card);
    for (const heading of ['① 声音画像', '⑫ 禁则', '⑧ 情绪手法', '⑪ 期待管理']) {
      expect(brief).toContain(`## ${heading}`);
    }
    expect(brief).not.toContain(SEAM_EXCERPT);

    // seam 2：A 注入统计块（yaml 契约「② 只写标题」）后，B 侧仍认 stats 节、统计进全量版。
    const injected = injectStyleStatsBlock(card, SEAM_STATS);
    expect(injected).toContain(`## ② 机械统计\n\n${SEAM_STATS}`);
    const context = buildStyleContext(injected);
    expect(context).toContain(SEAM_STATS);
    for (const heading of ['① 声音画像', '⑪ 期待管理']) {
      expect(context).toContain(`## ${heading}`);
    }
    expect(context).toContain(SEAM_EXCERPT);
    expect(context).not.toContain('完整原文附录');
  });

  it('seam 5 全链：envelope create → apply 落盘（accept 同核）→ BOM+CRLF 盘上形态读回 → 两路编译含统计块与节选', async () => {
    const projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-style-seam-'));
    try {
      const cardBody = injectStyleStatsBlock(contractSampleCard(SEAM_EXCERPT), SEAM_STATS);
      // A 侧 envelope 组装（create 路径——无既有卡）。
      const plan = buildStyleCardActions(undefined, cardBody);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      // accept 重放同核：applySettingMdActions 盖 frontmatter（id/type/source）。
      const applied = applySettingMdActions(undefined, plan.actions, { settingId: 'style' });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(applied.content).toContain("type: 'style'");
      expect(applied.content).toContain(SEAM_STATS);

      // 盘上最坏形态：BOM 前缀 + 全 CRLF（Windows 手编）——B 读回必须归一并剥 frontmatter。
      mkdirSync(path.join(projectPath, 'settings'), { recursive: true });
      writeFileSync(
        path.join(projectPath, 'settings', 'style.md'),
        `\uFEFF${applied.content.replace(/\n/g, '\r\n')}`,
        'utf8',
      );
      const body = await readStyleCardBody(projectPath);
      expect(body).toBeDefined();
      expect(body).not.toContain('\r');
      expect(body).not.toContain('---');
      // 读回后两路编译全通：统计块 + 节选（全量版）与四节配方（brief）都在场。
      const context = buildStyleContext(body!);
      expect(context).toContain(SEAM_STATS);
      expect(context).toContain(SEAM_EXCERPT);
      const brief = buildStyleBrief(body!);
      for (const heading of ['① 声音画像', '⑫ 禁则', '⑧ 情绪手法', '⑪ 期待管理']) {
        expect(brief).toContain(`## ${heading}`);
      }
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
