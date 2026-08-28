import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  applySettingMdActions,
  computeStyleStats,
  normalizeSettingMdContent,
  parseStyleInputMessage,
  renderStyleStatsBlock,
  type SettingMdAction,
} from '@orison/shared-contracts';
import { defineTool } from './define';
import { logger } from '../logger';
import { getSession } from '../agent/session';
import type { SessionState, ToolContext, ToolResult } from '../types';

// ── 风格卡片 MVP（task 08-28-style-card-mvp A 路）：dispatch_style_analyzer leader 派发工具 ──
//
// 「作者提交文风片段 → 风格分析子 agent 产卡草案 → 作者人审采纳」的派发件（design §2）。
// mirror dispatch-planners.ts 全模式：prompts yaml 契约子 agent（runAgentWithExplicitSystem，
// spawn_agent 拿不到 yaml——研究 C 发现 1）+ graceful 降级骨架 + child 事件透传（#3 二段）。
//
// 🔑 原文直传（D4 铁律 + 主会话契约修订 2026-08-28）：**零参数**工具——从当前会话历史**倒序**
// 取最近一条 parseStyleInputMessage 解析成功的 user 消息，机械提取 fragment/notes 逐字传入
// （verbatim 语义不变，Leader 零转述不变）。为什么零参数：消息 id 不进 leader 模型上下文
// （messagesToPayload 只组 role/content），id 参数 leader 永远填不出——与其补 id 回告机制，
// 直接消掉参数改「最近一条结构化提交」引用。重做语义天然成立：作者重提交后最近一条=新片段
// （replace envelope 不变）。一条结构化提交都找不到 → 返回收集引导语（leader 调
// request_style_input 拉对话框规范收集——**无自由文本回退**，直贴场景也走对话框，回退面越小
// 契约越紧）。
//
// 🔑 结构化载荷契约（C 路对话框的提交形态，**单源**在 shared-contracts ipc.ts）：
//   消息 content = 标记行结构（buildStyleInputMessage 构造）：
//     [style-input-fragment]\n<片段正文 verbatim>\n[style-input-notes]\n<备注，可整段省略>
//   本工具**直接 import parseStyleInputMessage 解析**（C 路契约注记明示「勿自行复制格式」——
//   单源防两处漂移）。fragment 逐字节原样（解析端不 trim）。
//
// 🔑 分析者无工具（CR-005 哨兵法）：allowedTools 传**非空哨兵白名单**（['__no_tools__']，
// 不命中任何注册工具）——workflow.ts runChildAgentWithExplicitSystem seam 对空数组回落全工具面
// （家族性既有限制，adjudicator/world-amender 同款，统一修正已记 deferred-work，不在本工具修），
// 空数组是「假禁用」；非空哨兵过 seam 的 length>0 分支后 filter 出**真零工具集**。yaml system
// 「你没有任何工具可用」契约作行为面第二道。
//
// 🔑 产出 = setting_md_patch envelope（settingId='style'，mirror settingMdHandlers suggest 档
// 形态：{type, settingId, filePath, actions, before, after, created, summary}）——UI 按元数据
// type 专用分流进既有 SettingMdPatchCard 词级 diff 人审（accept 走 closure:accept-setting-md
// 对当前文件重放 actions）。**不 autoApply 直写**（dispatch 铁律：永走人审，suggest 档语义）——
// 本工具无 autoApply 参数，classifyTool='diff'（toolPolicy DIFF_TOOLS，readonly 拦 / suggest
// 人审卡）。
//
// 🔑 stats 喂入 + 机械注入（范式判据）：computeStyleStats 纯代码先算（ADR-3 统计 stylometry
// 正当域）→ styleStats var 喂分析者做节奏佐证；卡第②节由本工具**机械注入**渲染块（分析者只写
// 节标题不抄数字——LLM 复述数字可能漂移，注入保证 AC1「落盘卡含统计块」逐字节正确）。
//
// 🔑 不进 CONTRACTS[] 的编排例外说明：本文件是派发工具；style-analyzer-agent 的契约镜像已按
// ADR-4 落 CONTRACTS[]（owns/reads 留空，mirror route-agent——产物是自由 markdown 卡非链段
// state key）。STATE_KEY_MAP / DEFAULT_CHAIN 不动（leader 侧子 agent 非链段节点）。
//
// graceful（mirror dispatch-planners 降级谱）：会话缺失 / 无结构化提交（引导收集）/ 最近提交
// 空片段 / 片段过短或超长（CR-019 上限门）/ skillExecutor 缺 / dispatch 抛错 / 空返回 / 材料不足 /
// 卡文件读不了 → 友善输出 + ok:false reason，绝不假成功、绝不抛穿。

/** style-analyzer 契约文件（prompts/ 下，ADR-4 单契约源；runAgentWithExplicitSystem 按此名加载）。 */
export const STYLE_ANALYZER_ROLE = 'style-analyzer-agent';

/**
 * 分析者工具白名单——**非空哨兵**（CR-005）：seam（workflow.ts runChildAgentWithExplicitSystem）
 * 对空数组回落全工具面，空数组是假禁用；哨兵 id 不匹配任何注册工具，filter 后为真零工具集
 * （无工具纯判断——语义 mirror adjudicator-agent 先例）。导出供测试断言（防未来误加写工具 /
 * 防哨兵被改回空数组重回假禁用）。
 */
export const STYLE_ANALYZER_ALLOWED_TOOLS: readonly string[] = ['__no_tools__'];

/** 风格卡落点：settings/style.md（R1 设定文档族成员，保留 settingId）。 */
export const STYLE_CARD_SETTING_ID = 'style';

/** create_file 的卡标题（作索引显示名兜底；卡自带 # H1 时 ensureTitleHeading 不重复加）。 */
export const STYLE_CARD_TITLE = '风格卡片';

/** 分析者「材料不足」结论行前缀（yaml 契约：不足 300 字只返这一行，不产卡）。 */
export const INSUFFICIENT_MATERIAL_PREFIX = '材料不足';

/**
 * 结构化片段提交的正文不足此字数（非空白字符）时，工具侧直接短路回问（省一次白派发）。
 *
 * 联动点（CR-013——「300」口径多处并存，改值时逐处同步）：UI 前端校验同值
 * `STYLE_INPUT_MIN_CHARS`（client/ui/src/features/agent-panel/StyleInputDialog.tsx）；
 * i18n 文案「至少 300 字 / {count} / 300 字」（client/ui/src/shared/i18n/zh-CN/agent.yaml
 * 的 styleInputHint / styleInputCount / styleInputTooShort 三键）；style-analyzer-agent.yaml
 * 材料预处理「不足 300 字」判定（分析者 belt）；request_style_input / dispatch_style_analyzer
 * 工具描述与回问文案。
 */
export const MIN_FRAGMENT_CHARS = 300;

/**
 * 片段长度上限（CR-019）：非空白字符超此数直接短路回「片段过长」不派发——超大片段撑爆
 * 分析者上下文（⑭ 原文附录全量进卡）且统计无增益；风格分析要的是代表性不是体量。
 */
export const MAX_FRAGMENT_CHARS = 100_000;

// ── 结构化载荷提取（纯机械，D4 verbatim 铁律的核心）──

/** 从用户消息解析出的风格片段载荷（fragment/notes 均 verbatim）。 */
export interface StyleSourcePayload {
  /** 片段正文（verbatim 逐字——不作任何 trim/改写，AC5 断言对象）。 */
  fragment: string;
  /** 作者备注（verbatim；无则空串）。 */
  notes: string;
}

export type StyleSourceExtraction =
  | { ok: true; payload: StyleSourcePayload }
  | {
    ok: false;
    reason: 'session-missing' | 'no-style-input' | 'empty-fragment';
    message: string;
  };

/**
 * 从会话历史机械提取风格片段载荷（D4：非文本引用——Leader 零转述）。
 * 纯机械：倒序扫 user 消息 → 取**最近一条** parseStyleInputMessage 解析成功的消息 → 提取
 * fragment/notes verbatim。一条都没有 → no-style-input 引导语（leader 调 request_style_input
 * 规范收集——无自由文本回退）。最近一条 fragment 为空 → 响亮拒（不静默跳到更旧一条——作者
 * 以为刚提交的会被分析，静默取旧片段是错位分析）。
 */
export function extractStyleSourcePayload(sessionId: string): StyleSourceExtraction {
  const session: SessionState | undefined = getSession(sessionId);
  if (!session) {
    return {
      ok: false,
      reason: 'session-missing',
      message: '当前会话不可用，无法提取文风片段。',
    };
  }
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i]!;
    if (message.role !== 'user') continue;
    const structured = parseStyleInputMessage(message.content);
    if (structured === null) continue;
    if (structured.fragment.trim().length === 0) {
      return {
        ok: false,
        reason: 'empty-fragment',
        message: '作者最近一次提交的片段正文是空的——请作者重新提交（原文必填）。',
      };
    }
    return {
      ok: true,
      payload: { fragment: structured.fragment, notes: structured.notes ?? '' },
    };
  }
  return {
    ok: false,
    reason: 'no-style-input',
    message:
      '本对话里还没有作者提交的文风片段。先用 request_style_input 请作者在弹出的对话框里粘贴想模仿的小说片段'
      + '（至少 300 字，可附备注），作者提交后再调用本工具分析。',
  };
}

// ── vars 组装（纯函数，导出供测试 + yaml user 模板 var 对齐守卫）──

/**
 * style-analyzer yaml user 模板 3 var 组装（{{sourceMaterial}}/{{styleStats}}/{{userNote}}）。
 * sourceMaterial = fragment verbatim（AC5：与用户消息载荷逐字节一致——不 trim 不改写）。
 */
export function buildStyleAnalyzerVars(input: {
  sourceMaterial: string;
  styleStats: string;
  userNote: string;
}): Record<string, string> {
  return {
    sourceMaterial: input.sourceMaterial,
    styleStats: input.styleStats,
    userNote: input.userNote,
  };
}

// ── 统计块机械注入（第②节——分析者只写节标题，数字由代码注入保逐字节正确）──

/** 第②节标题行（容忍 ②/2 与空白/分隔变体）。CR-009：`##` 与编号间**零空白也容忍**（\s*）——
 * 与 B 路 style-card.ts 节解析统一同规则，勿收紧为 \s+。按行匹配（标题行内无换行）。 */
const STATS_HEADING_LINE_RE = /^##\s*[②2][.、)）\s]*机械统计/;

/** 通用 `## ` 节标题行（节边界探测；`# ` 一级与 `### ` 以下不切节）。 */
const SECTION_HEADING_LINE_RE = /^##\s/;

/** 卡头一级标题行（兜底注入位：无任何节标题时插 H1 之后）。 */
const H1_HEADING_LINE_RE = /^#\s/;

/**
 * 逐行扫 fenced 状态找 **fenced 外**首个命中标题行（CR-020：⑬/⑭ 节 fenced 原文里形似
 * `## ② 机械统计` 的行是片段正文不是卡结构，不得当标题）。fenced 开关 = 行首（忽略缩进）
 * ``` 翻转；未闭合 fence 之后的内容保守全视为块内。返回命中行的 [start, end) 字符区间；
 * fenced 外无命中 → undefined。
 */
function findHeadingOutsideFence(
  body: string,
  lineRe: RegExp,
): { start: number; end: number } | undefined {
  let offset = 0;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
    } else if (!inFence) {
      const match = lineRe.exec(line);
      if (match) return { start: offset, end: offset + match[0].length };
    }
    offset += line.length + 1;
  }
  return undefined;
}

/**
 * 把统计块机械注入卡第②节（纯机械投影，防 LLM 复述数字漂移）：
 * - fenced 外找到 `## ② 机械统计` 标题行 → 该节内容（标题到下一 fenced 外 `## ` 节或卡尾）
 *   整段替换为标题 + 统计块。
 * - 标题缺失（分析者违约，CR-020）→ **插在首个节标题之前**（卡头之后、第一节之前）——不落
 *   卡尾（卡尾是⑭原文附录，落尾破 14 节序）；无任何节标题 → 插卡头（# H1）之后；连 H1 都无
 *   → 卡首。
 */
export function injectStyleStatsBlock(cardBody: string, statsBlock: string): string {
  const section = `## ② 机械统计（代码预计算）\n\n${statsBlock}`;
  const match = findHeadingOutsideFence(cardBody, STATS_HEADING_LINE_RE);
  if (!match) {
    const firstSection = findHeadingOutsideFence(cardBody, SECTION_HEADING_LINE_RE);
    if (firstSection) {
      const before = cardBody.slice(0, firstSection.start);
      const after = cardBody.slice(firstSection.start);
      const sep = firstSection.start === 0 || before.endsWith('\n\n')
        ? ''
        : before.endsWith('\n')
          ? '\n'
          : '\n\n';
      return `${before}${sep}${section}\n\n${after}`;
    }
    const h1 = findHeadingOutsideFence(cardBody, H1_HEADING_LINE_RE);
    if (h1) {
      const rest = cardBody.slice(h1.end).replace(/^\n+/, '');
      return `${cardBody.slice(0, h1.end)}\n\n${section}${rest.length > 0 ? `\n\n${rest}` : ''}`;
    }
    return cardBody.length === 0 ? `${section}\n` : `${section}\n\n${cardBody}`;
  }
  const headingEnd = match.end;
  const rest = cardBody.slice(headingEnd);
  const nextHeading = findHeadingOutsideFence(rest, SECTION_HEADING_LINE_RE);
  const sectionEnd = nextHeading ? headingEnd + nextHeading.start : cardBody.length;
  return `${cardBody.slice(0, headingEnd)}\n\n${statsBlock}\n${cardBody.slice(sectionEnd)}`;
}

// ── 既有卡读取 + envelope action 组装（mirror settingMdHandlers suggest 档投影）──

type StyleCardFileRead = { ok: true; content?: string } | { ok: false; reason: string };

/**
 * 读当前 settings/style.md。result-object（CR-08-16-110 语义）：`ok:true` 无 content = 不存在
 * （create_file 合法）；`ok:false` = 存在但读不了（EACCES 等）——绝不把「读不了」当「不存在」。
 */
async function readCurrentStyleCard(projectPath: string): Promise<StyleCardFileRead> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectPath, 'settings', `${STYLE_CARD_SETTING_ID}.md`), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: true };
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err: reason, projectPath }, 'dispatch_style_analyzer: style card read failed');
    return { ok: false, reason };
  }
  return { ok: true, content: raw };
}

/** BOM strip + CRLF→LF——单源 shared-contracts normalizeSettingMdContent（seam 5：与 apply 入口/
 * 消费侧 readStyleCardBody 同一实现，勿复制）。 */
function normalizeStyleCard(content: string): string {
  return normalizeSettingMdContent(content) ?? '';
}

/** 取 frontmatter 关闭栅栏后的正文（无 frontmatter → 整个内容为正文）。 */
function styleCardBody(normalized: string): string {
  const fence = /^---\n[\s\S]*?\n---\n?/.exec(normalized);
  return fence ? normalized.slice(fence[0].length) : normalized;
}

/**
 * 组装配卡 actions（纯函数，导出供测试）：
 * - 无既有卡 → create_file（frontmatter id=style/type=style/source=agent 由 apply 段盖章）。
 * - 有既有卡、空文件/纯空白 → create_file（CR-016：无内容冲突，直接当无卡新建——不再推作者
 *   手动删文件；applySettingMdActions 的 create_file 对空白既有内容放行，同款语义）。
 * - 有既有卡、正文非空白 → replace_span（quote=旧正文归一后逐字——机械锚保证唯一命中）。
 * - 有既有卡、正文空白（只有 frontmatter）→ insert_after（quote=归一后全文，插到文末）。
 */
export function buildStyleCardActions(
  currentRaw: string | undefined,
  cardBody: string,
): { ok: true; actions: SettingMdAction[]; created: boolean } | { ok: false; reason: string } {
  if (currentRaw === undefined) {
    return {
      ok: true,
      created: true,
      actions: [
        {
          op: 'create_file',
          title: STYLE_CARD_TITLE,
          content: cardBody,
          type: 'style',
        },
      ],
    };
  }
  const normalized = normalizeStyleCard(currentRaw);
  if (normalized.trim().length === 0) {
    // CR-016：空文件无内容冲突——当无卡 create_file（覆盖一个空文件没有任何可丢失的内容，
    // whole-file replace 反模式防线针对的是有内容的文档）。
    return {
      ok: true,
      created: true,
      actions: [
        {
          op: 'create_file',
          title: STYLE_CARD_TITLE,
          content: cardBody,
          type: 'style',
        },
      ],
    };
  }
  const body = styleCardBody(normalized);
  if (body.trim().length > 0) {
    return {
      ok: true,
      created: false,
      actions: [{ op: 'replace_span', anchor: { quote: body }, replacement: cardBody }],
    };
  }
  // 正文空白：整文（frontmatter）作锚，卡接在文末。
  const insertion = normalized.endsWith('\n') ? cardBody : `\n${cardBody}`;
  return {
    ok: true,
    created: false,
    actions: [{ op: 'insert_after', anchor: { quote: normalized }, insertion }],
  };
}

// ── tool 本体（defineTool，mirror dispatch-planners execute 结构）──

export const dispatchStyleAnalyzerTool = defineTool({
  id: 'dispatch_style_analyzer',
  description:
    '把作者最近一次提交的文风片段样本交给专门的风格分析师做深度分析：分析师通读原文做九遍扫描'
    + '（叙述者人格、句法节奏、叙事节奏、对话、描写取舍、意象与比喻、情绪手法、信息处理、'
    + '人物呈现与期待管理），产出一张风格卡草案——卡内每条观察都带原文引证和写手可执行的'
    + '模仿指令，并附最能代表这个声音的连续节选与完整原文附录。草案回来呈作者审阅，采纳后'
    + '成为项目的风格卡（settings/style.md），之后写章、精修都会参考它对齐文风；作者换一段'
    + '片段重新提交后再调本工具即可重做（整卡替换）。'
    + '本工具不需要参数：自动取作者在本对话里最近一次提交的文风片段（经风格片段对话框提交的那条，'
    + '系统原样转交分析师，你不需要也不应该转述原文）。'
    + '本对话还没有作者提交过片段时，工具会提示你先收集——用 request_style_input 请作者在弹出的'
    + '对话框里粘贴片段（原文至少 300 字，可附备注），作者提交后再调本工具。'
    + '片段太短时工具或分析师会返回「材料不足」——请作者补一段更长的重新提交。',
  // 零参数（契约修订 2026-08-28）：材料引用 = 最近一条结构化提交（倒序扫），非 LLM 填参——
  // zod 缺省 strip：LLM 幻觉多传的参数被静默剥掉，不炸 schema。
  parameters: z.object({}),
  async execute(_params, ctx): Promise<ToolResult> {
    // ── 1. 机械提取（D4：最近一条结构化提交，倒序扫）──
    const extraction = extractStyleSourcePayload(ctx.sessionId);
    if (!extraction.ok) {
      return { title: 'dispatch_style_analyzer', output: extraction.message, metadata: { ok: false, reason: extraction.reason } };
    }
    const { fragment, notes } = extraction.payload;

    // ── 2. 统计先算（纯代码，喂分析者 + 卡第②节注入源）──
    const stats = computeStyleStats(fragment);
    const statsBlock = renderStyleStatsBlock(stats);

    // 工具侧短路：结构化提交的 fragment 即精确正文，字数已知——不足直接回问省一次派发
    //（<300 是 PRD 口径；分析者 yaml 同判作 belt）。
    if (stats.totalChars < MIN_FRAGMENT_CHARS) {
      return {
        title: 'dispatch_style_analyzer',
        output:
          `材料不足——提交的片段只有 ${stats.totalChars} 字（不足 ${MIN_FRAGMENT_CHARS} 字），分析师无法从中读出稳定的文风习惯。`
          + '请作者补一段更长的连续正文（建议 300 字以上、最好 800 字以上）重新提交，然后再次派发。',
        metadata: { ok: false, reason: 'insufficient-material' },
      };
    }

    // CR-019 上限门：超大片段不派发（⑭ 附录全量进卡会撑爆分析者上下文）——回问请作者精选。
    if (stats.totalChars > MAX_FRAGMENT_CHARS) {
      return {
        title: 'dispatch_style_analyzer',
        output:
          `片段过长——提交的片段有 ${stats.totalChars} 字（上限 ${MAX_FRAGMENT_CHARS} 字），超出风格分析的有效范围。`
          + '风格分析不需要整部作品——请作者精选一段最能代表目标文风的连续正文（建议 800-5000 字）重新提交，然后再次派发。',
        metadata: { ok: false, reason: 'fragment-too-long' },
      };
    }

    // ── 3. 派发分析者 ──
    if (!ctx.skillExecutor?.runAgentWithExplicitSystem) {
      logger.warn({ sessionId: ctx.sessionId }, 'dispatch_style_analyzer: runAgentWithExplicitSystem unavailable → graceful degrade');
      return {
        title: 'dispatch_style_analyzer',
        output: '风格分析派发通道不可用（当前会话未注入子 agent 执行器）。请稍后重试。',
        metadata: { ok: false, reason: 'dispatch-unavailable' },
      };
    }
    const vars = buildStyleAnalyzerVars({ sourceMaterial: fragment, styleStats: statsBlock, userNote: notes });
    let content: string;
    try {
      const result = await ctx.skillExecutor.runAgentWithExplicitSystem(
        ctx.sessionId,
        STYLE_ANALYZER_ROLE,
        vars,
        {
          ...(ctx.abort ? { abort: ctx.abort } : {}),
          ...(ctx.spawnDepth !== undefined ? { spawnDepth: ctx.spawnDepth } : {}),
          // child 事件通道透传（dogfood R2 #3 二段先例）——缺了子 agent 组在 UI 全不可见。
          ...(ctx.emitChildEvent ? { emitChildEvent: ctx.emitChildEvent } : {}),
          allowedTools: [...STYLE_ANALYZER_ALLOWED_TOOLS],
        },
      );
      if (!result.content || !result.content.trim()) {
        return {
          title: 'dispatch_style_analyzer',
          output: '风格分析师返回了空结果（可能被中断或超时）。请重试。',
          metadata: { ok: false, reason: 'empty-output' },
        };
      }
      content = result.content;
    } catch (err) {
      logger.warn(
        { sessionId: ctx.sessionId, err: err instanceof Error ? err.message : String(err) },
        'dispatch_style_analyzer: dispatch failed → graceful degrade',
      );
      return {
        title: 'dispatch_style_analyzer',
        output: `风格分析派发失败（${err instanceof Error ? err.message : String(err)}）。请重试。`,
        metadata: { ok: false, reason: 'dispatch-failed' },
      };
    }

    // ── 4. 材料不足分支（分析者结论透传——leader 回问作者）──
    const trimmed = content.trim();
    if (trimmed.startsWith(INSUFFICIENT_MATERIAL_PREFIX)) {
      return {
        title: 'dispatch_style_analyzer',
        output:
          '材料不足——分析师未产卡。请作者补一段更长的文风片段（建议 300 字以上、最好 800 字以上的连续正文）重新提交后再派发。'
          + `分析师说明：${trimmed}`,
        metadata: { ok: false, reason: 'insufficient-material' },
      };
    }

    // ── 5. 机械注入统计块 + 组装 setting_md_patch envelope（不写盘——人审 accept 才落）──
    const cardBody = injectStyleStatsBlock(trimmed, statsBlock);
    const read = await readCurrentStyleCard(ctx.projectPath);
    if (!read.ok) {
      return {
        title: 'dispatch_style_analyzer',
        output: `风格卡更新被拒：无法读取 settings/${STYLE_CARD_SETTING_ID}.md 的当前内容（${read.reason}）。请检查文件权限后重试。`,
        metadata: { ok: false, reason: 'card-unreadable' },
      };
    }
    const plan = buildStyleCardActions(read.content, cardBody);
    if (!plan.ok) {
      return {
        title: 'dispatch_style_analyzer',
        output: `风格卡更新被拒：${plan.reason}。`,
        metadata: { ok: false, reason: 'card-shape-invalid' },
      };
    }
    const applied = applySettingMdActions(read.content, plan.actions, { settingId: STYLE_CARD_SETTING_ID });
    if (!applied.ok) {
      // 机械锚（代码自取自读）理论不可达；防御分支照实说——永不静默。
      return {
        title: 'dispatch_style_analyzer',
        output: `风格卡更新被拒：草案与当前卡对不上（${applied.reason}）。请重试；若继续失败，请作者检查 settings/${STYLE_CARD_SETTING_ID}.md 是否被手动改动过。`,
        metadata: { ok: false, reason: 'apply-failed' },
      };
    }
    const filePath = path.join(ctx.projectPath, 'settings', `${STYLE_CARD_SETTING_ID}.md`);
    const ops = plan.actions.map((a) => a.op).join('+');
    return {
      title: `dispatch_style_analyzer: ${STYLE_CARD_SETTING_ID}`,
      output:
        `风格卡草案已备好（${plan.created ? '新建风格卡' : '替换既有风格卡'}，settings/${STYLE_CARD_SETTING_ID}.md）。`
        + `请在对话内的对照卡审阅——确认后写入 settings/${STYLE_CARD_SETTING_ID}.md 并同步更新检索；`
        + '拒绝则丢弃草案（未做任何改动），换一段片段重新提交即可重做。',
      metadata: {
        ok: true,
        // setting_md_patch envelope（mirror settingMdHandlers suggest 档形态；UI 按元数据 type
        // 专用分流进 SettingMdPatchCard——accept 重放 actions 落盘，before/after 是 diff 呈现面）。
        type: 'setting_md_patch',
        settingId: STYLE_CARD_SETTING_ID,
        filePath,
        actions: plan.actions,
        // CR-015：before 与 after 同口径归一（normalizeSettingMdContent 单源）——CRLF 存量卡的
        // 人审 diff 不再全线飘红（归一本就是 apply 语义：落盘写 LF，before 呈现同形态）。
        before: read.content !== undefined ? normalizeStyleCard(read.content) : '',
        after: applied.content,
        created: plan.created,
        summary: `settings/${STYLE_CARD_SETTING_ID}.md · ${plan.created ? '新建' : '整卡替换'} · ${ops}`,
      },
    };
  },
});
