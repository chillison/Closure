import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { formatNarrativeEnumGuide } from '@orison/shared-contracts';
import { defineTool } from './define';
import { logger } from '../logger';
// eslint-disable-next-line no-restricted-imports -- 已读：engine=OrisonSpace 历史目录；contextBuilder 的 derivePatternGuide 是 pattern 派生单源，planner 上下文装配既有复用（8.6 起在用），无链段接线面。
import { derivePatternGuide } from '../engine/contextBuilder';
// eslint-disable-next-line no-restricted-imports -- 已读：同上；craftGuide 是 story-planner 方法论常量单源（纯常量模块，无节点耦合）。
import { STORY_PLANNER_CRAFT_GUIDE } from '../engine/craftGuide';
import { buildStyleBrief, readStyleCardBody } from './style-card';
import type { ToolContext } from '../types';

// ── Story 8.6 R7（design D10/D11 + GAP-2）：冷启动规划派发两工具（local tool）──
//
// 冷启动「骨架共创 → 派发产草案 → 呈现人审」三段式（P2 拍板）的派发件：leader 与作者把故事
// 骨架聊定后，经这两工具把骨架交给后台规划子 agent——story-planner 产总大纲 + 多线场景结构
// 草案、episode-planner 产集纲草案。子 agent 经各自写工具（outline_update / scene_graph_update /
// episode_outlines_update）产出，写工具照走档位过滤 + 人审闸门（suggest 档产 patch 回流
// PatchReview；auto 档 autoApply 自审闸门照拦）——零权限豁免。
//
// 🔑 为什么是 local tool + runAgentWithExplicitSystem 而非 spawn_agent（研究 C 发现 1）：spawn_agent
// 泛型路径读 `.md` agent 定义，拿不到 `prompts/<role>.yaml`（ADR-4 单契约源 system + userTemplate）；
// 派 yaml 契约 agent 须走 runAgentWithExplicitSystem（mirror dispatch_researcher / diagnose_impacts /
// write_chapter 子 agent 先例）。vars 由本工具从 project.yaml 组装（结构化字段 JSON 序列化 +
// patternGuide/narrativeEnumGuide 复用既有单源函数），intent（leader 与作者聊定的骨架）作 requirement。
//
// 🔑 工具面白名单（硬约束，spec orchestration-pattern「caller 必传 allowedTools」）：
// story-planner = owns 契约两件（outline_update + scene_graph_update）；episode-planner =
// episode_outlines_update（**不扩 scene_graph_update**——场→集挂锚归 leader 直改 scene_graph_update，
// design GAP-1 修法，扩权越 owns 契约）。白名单外的写工具/派发工具子 agent 一律不可见。
//
// 🔑 classifyTool 不进 WRITE/DIFF（默认 read 编排类，design D11）：工具本体只读 project.yaml +
// 派发，不写任何持久化状态；真正的写动作在子 agent 的 gated 写工具里过闸——mirror write_chapter
// （编排本体不拦）/ dispatch_researcher（编排类默认读）。
//
// 🔑 不进 CONTRACTS[]（leader 侧工具子 agent 派发件，mirror dispatch_researcher / retrieval）。
// spawn depth：leader→planner（depth+1）兄弟于 leader→chain。
//
// graceful（mirror dispatch_researcher / diagnose_impacts）：skillExecutor 缺（旧 runtime / mock）/
// project.yaml 不可读 / dispatch 抛错 / 空返回 → 友善降级消息（leader 转文字共创路径），绝不假成功。
//
// expected_downstream_consumers:
// - buildInteractionModeSegment 管线能力段（8.6 Step 4）：派发协议（何时派 / intent 携带作者
//   已确认的选型结论 + 范围随偏好；readonly 档不派发——GAP-4，子 agent 写工具全被滤）。
// - prompts/story-planner-agent.yaml 三型段微调（GAP-2）：requirement 已含作者确认的选型结论时
//   按结论直接产出——后台子 agent 无法与作者对话，不补则停等死路。

/** story-planner 契约文件（prompts/ 下，ADR-4 单契约源；runAgentWithExplicitSystem 按此名加载）。 */
export const STORY_PLANNER_ROLE = 'story-planner-agent';

/** episode-planner 契约文件（同上）。 */
export const EPISODE_PLANNER_ROLE = 'episode-planner-agent';

/**
 * story-planner 子 agent 可见工具白名单 = owns 契约两件（outline + scene_graph）。导出供测试
 * 断言（白名单 id 全部已注册 + 不越 owns 契约）。
 */
export const STORY_PLANNER_ALLOWED_TOOLS: readonly string[] = [
  'outline_update',
  'scene_graph_update',
];

/**
 * episode-planner 子 agent 可见工具白名单 = episode_outlines_update（owns 契约）+ query_mentions（读）。
 * **不含** scene_graph_update——场→集挂锚（scene.episodeId/presentationSpans 挂在场上）归 leader 直改
 * scene_graph_update（design GAP-1 修法：story-planner 产场时 episodes 尚不存在、
 * episode-planner owns 只有 episode_outlines、episodeOutlineSchema 无场引用）。
 *
 * Story 8.7 S9：加 query_mentions（只读）——分集要安排「每集谁出场」，出场账让规划员翻得到各角色
 * 最后在哪章露面/隔了多久（gap_stats 视图），避免把快被读者遗忘的角色继续晾着或把刚下场的人立刻
 * 再排上来。读工具不越 owns 契约（mirror 白名单只读件先例）。
 */
export const EPISODE_PLANNER_ALLOWED_TOOLS: readonly string[] = [
  'episode_outlines_update',
  'query_mentions',
];

// ── project.yaml 读取（mirror write-chapter.ts loadChainProjectInput 防御段）──
//
// BOM-strip + readFile/yaml.load 失败 → warn + null（tool 报错给 leader 而非崩，mirror
// loadChainProjectInput「degrade, don't drop」）。非 object 形态 → null（同源静默）。
// 两派发工具共用本 reader（单源，不复制防御逻辑）。

const BOM_CHAR_CODE = 0xfeff;

async function readProjectYamlDocument(
  projectPath: string,
  toolId: string,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    // CR-016（8.6 BMad CR）：path.join 一并入 try——projectPath 异常时 join 同步 throw 也要走
    // graceful（报错给 leader），不能穿出 graceful 骨架。
    raw = await readFile(path.join(projectPath, 'project.yaml'), 'utf8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), projectPath }, `${toolId}: project.yaml unreadable`);
    return null;
  }

  const bomStripped = raw.charCodeAt(0) === BOM_CHAR_CODE ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = yaml.load(bomStripped);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), projectPath }, `${toolId}: project.yaml malformed yaml`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

// CR-010（8.6 BMad CR）：每 var 字符 cap——大项目结构化字段（几千卡/几百场的 JSON 序列化）不设上限
// 会把子 agent prompt 撑爆；超限截断保头 + 尾标注。截断后不再是合法 JSON，但 var 是供规划员**阅读**的
// 项目现状资料非 parse 载荷（yaml user 模板直接渲染进 prompt），预算保护优先。
const DOC_FIELD_VAR_MAX_CHARS = 20000;
const DOC_FIELD_TRUNCATION_NOTE = '\n…（已截断，仅保留前 20000 字符）';

/** 结构化字段 → var 串（JSON 序列化，mirror write-chapter 子 agent vars 组装惯例）；缺失 → 空串。
 * CR-010：超 20000 字符截断 + 尾标注（见上）。 */
function serializeDocField(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = JSON.stringify(value);
  if (!s) return '';
  if (s.length <= DOC_FIELD_VAR_MAX_CHARS) return s;
  return `${s.slice(0, DOC_FIELD_VAR_MAX_CHARS)}${DOC_FIELD_TRUNCATION_NOTE}`;
}

// ── vars 组装（纯函数，导出供测试断言 + yaml 模板 var 对齐守卫）──

/**
 * story-planner yaml user 模板 8 var 组装（{{requirement}}/{{world_setting}}/{{asset_cards}}/
 * {{relationship_graph}}/{{patternGuide}}/{{narrativeEnumGuide}}/{{craftGuide}}/{{styleBrief}}）。
 * patternGuide = derivePatternGuide 单源（contextBuilder，Story 1.4 既有派生——blank/缺省/非法 →
 * 空串 = yaml 四节「指引为空则按三型推荐」路径）；narrativeEnumGuide = formatNarrativeEnumGuide
 * 单源（shared-contracts 静态词表，恒在零 projectDocument 依赖）。
 *
 * dogfood R2：craftGuide = STORY_PLANNER_CRAFT_GUIDE 单源（engine/craftGuide.ts——四因说大纲
 * 语法四件检查：六步法情节弧闭环/期待感钩子换型/剧情线咬接/高潮前置规划。常量恒在，mirror
 * narrativeEnumGuide 先例；素材出处与精简取舍见该模块头注）。
 *
 * 风格卡片 MVP（B 路 D7）：styleBrief = 风格卡精简版（声音画像+禁则+情绪手法+期待管理四节，
 * buildStyleBrief 单源）——规划期就要对齐的四件（大纲节拍与场景选择据此同构），不带 few-shot
 * 原文与文字层细节。缺省 ''（无卡不占位；恒供 key 防 renderTemplate missing-var warn——空串是
 * 合法替换，语义同「undefined 不占位」）。
 */
export function buildStoryPlannerVars(
  intent: string,
  projectDoc: Record<string, unknown>,
  styleBrief = '',
): Record<string, string> {
  return {
    requirement: intent,
    world_setting: serializeDocField(projectDoc.world_setting),
    asset_cards: serializeDocField(projectDoc.asset_cards),
    relationship_graph: serializeDocField(projectDoc.relationship_graph),
    patternGuide: derivePatternGuide(projectDoc) ?? '',
    narrativeEnumGuide: formatNarrativeEnumGuide(),
    craftGuide: STORY_PLANNER_CRAFT_GUIDE,
    styleBrief,
  };
}

/**
 * episode-planner yaml user 模板 9 var 组装（{{requirement}}/{{outline}}/{{scene_graph}}/
 * {{growth_curve}}/{{pacing_curve}}/{{emotion_curve}}/{{asset_cards}}/{{relationship_graph}}/
 * {{styleBrief}}）。var 名与 yaml user 模板逐字对齐（模板无 {{world_setting}}——契约
 * inputs.from_state 列了 world_setting 但 user 模板未渲染，pre-existing 模板形态，本工具照模板供
 * var 不扩）。
 *
 * CR-001（8.6 BMad CR HIGH）：**var 名 ≠ project.yaml 键名**——var `outline` 的源键是
 * `outline_v2`（projectDocumentSchema 真键，project.ts；旧代码读 `projectDoc.outline` 恒
 * undefined，集纲规划员永远收空大纲）。其余 8 var 源键已逐一对照 schema 核实无错配
 * （scene_graph/growth_curve/pacing_curve/emotion_curve/asset_cards/relationship_graph）。
 *
 * 风格卡片 MVP（B 路 D7）：styleBrief 同 story-planner（buildStyleBrief 单源精简版四节；缺省 ''
 * = 无卡不占位，恒供 key 防 missing-var warn）。
 */
export function buildEpisodePlannerVars(
  intent: string,
  projectDoc: Record<string, unknown>,
  styleBrief = '',
): Record<string, string> {
  return {
    requirement: intent,
    outline: serializeDocField(projectDoc.outline_v2),
    scene_graph: serializeDocField(projectDoc.scene_graph),
    growth_curve: serializeDocField(projectDoc.growth_curve),
    pacing_curve: serializeDocField(projectDoc.pacing_curve),
    emotion_curve: serializeDocField(projectDoc.emotion_curve),
    asset_cards: serializeDocField(projectDoc.asset_cards),
    relationship_graph: serializeDocField(projectDoc.relationship_graph),
    styleBrief,
  };
}

// ── 共用派发核（两工具共享 graceful 骨架，mirror dispatch-researcher execute 结构）──

interface PlannerDispatchPlan {
  toolId: string;
  role: string;
  allowedTools: readonly string[];
  buildVars: (intent: string, projectDoc: Record<string, unknown>, styleBrief: string) => Record<string, string>;
  /** 转文字路径提示（graceful 消息尾部——派发不可行/失败时 leader 可走的替代共创路径）。 */
  fallbackHint: string;
}

async function executePlannerDispatch(
  params: { intent: string },
  ctx: ToolContext,
  plan: PlannerDispatchPlan,
) {
  if (!ctx.skillExecutor?.runAgentWithExplicitSystem) {
    logger.warn(
      { sessionId: ctx.sessionId },
      `${plan.toolId}: runAgentWithExplicitSystem unavailable → graceful degrade`,
    );
    return {
      title: plan.toolId,
      output: `规划员派发通道不可用（当前会话未注入子 agent 执行器）。可${plan.fallbackHint}。`,
      metadata: { ok: false, reason: 'dispatch-unavailable' },
    };
  }

  // project.yaml 不可读 → 工具报错 graceful（design §3.4：leader 转文字路径，不崩不假成功）。
  const projectDoc = await readProjectYamlDocument(ctx.projectPath, plan.toolId);
  if (!projectDoc) {
    return {
      title: plan.toolId,
      output: `项目文件（project.yaml）读取失败，无法为规划员准备项目现状资料。可${plan.fallbackHint}。`,
      metadata: { ok: false, reason: 'project-unreadable' },
    };
  }

  // 风格卡片 MVP（B 路 D7）：settings/style.md → 精简版风格要点（声音画像+禁则+情绪手法+期待管理）
  // 注入规划派发 vars——规划期就要对齐的四件（大纲节拍与场景选择据此同构）。无卡/读失败 → ''
  // （readStyleCardBody graceful 降级，mirror dispatch 降级谱——风格卡纯增益，绝不阻断派发）。
  const styleCardBody = await readStyleCardBody(ctx.projectPath);
  const styleBrief = styleCardBody ? buildStyleBrief(styleCardBody) : '';

  const vars = plan.buildVars(params.intent, projectDoc, styleBrief);
  try {
    const result = await ctx.skillExecutor.runAgentWithExplicitSystem(
      ctx.sessionId,
      plan.role,
      vars,
      {
        ...(ctx.abort ? { abort: ctx.abort } : {}),
        ...(ctx.spawnDepth !== undefined ? { spawnDepth: ctx.spawnDepth } : {}),
        // dogfood R2 #3 二段：leader 工具派发族透传 child 事件通道——缺了则 started/delta/
        // 终帧全不上浮（子 agent 组在 UI 全不可见，本 finding 真根因之一）。
        ...(ctx.emitChildEvent ? { emitChildEvent: ctx.emitChildEvent } : {}),
        allowedTools: [...plan.allowedTools],
      },
    );
    if (!result.content || !result.content.trim()) {
      return {
        title: plan.toolId,
        output: `规划员返回了空草案（可能被中断或超时）。请重试，或${plan.fallbackHint}。`,
        metadata: { ok: false, reason: 'empty-output' },
      };
    }
    return {
      title: plan.toolId,
      output: result.content,
      metadata: { ok: true },
    };
  } catch (err) {
    logger.warn(
      { sessionId: ctx.sessionId, err: err instanceof Error ? err.message : String(err) },
      `${plan.toolId}: dispatch failed → graceful degrade`,
    );
    return {
      title: plan.toolId,
      output: `规划员派发失败（${err instanceof Error ? err.message : String(err)}）。请重试，或${plan.fallbackHint}。`,
      metadata: { ok: false, reason: 'dispatch-failed' },
    };
  }
}

// ── dispatch_story_planner / dispatch_episode_planner tool（defineTool，mirror dispatchResearcherTool）──

const STORY_PLANNER_FALLBACK_HINT =
  '改在对话里直接用 outline_update / scene_graph_update 工具与作者共创大纲和场景结构';

export const dispatchStoryPlannerTool = defineTool({
  id: 'dispatch_story_planner',
  description:
    '把已经和作者聊定的故事骨架交给专门的大纲规划员：产出完整的总大纲草案（核心冲突、主要转折点、'
    + '结局方向、分卷阶段——每卷含阶段目标/主要阻力/阶段高潮/卷末钩子）和多线场景结构草案（叙事线、'
    + '因果链、锚点场），回来呈给作者阅读采纳。'
    + 'intent 里要写全你们聊定的内容：作者确认过的整体结构选型结论、主线走向、分几卷、核心人物、'
    + '本次产出范围（例如只规划第一卷，或全书全量）、作者的其他特殊要求。'
    + '骨架还没聊定（结构选型未获作者确认）时先继续对话共创，不要派发。',
  parameters: z.object({
    // CR-006（trim 校验——纯空白串过 min(1) 会照派规划员白烧全程）+ CR-018（长度上限——LLM 失控
    // 超长 intent 直进子 agent prompt）。trim 后 1..8000。
    intent: z.string().trim().min(1).max(8000).describe(
      '已和作者聊定的骨架与要求，写全：作者确认过的整体结构选型结论、主线、分几卷（卷=大纲阶段）、'
      + '核心人物、本次产出范围（只产第一卷 / 全书全量）、作者特殊要求',
    ),
  }),
  async execute(params, ctx) {
    return executePlannerDispatch(params, ctx, {
      toolId: 'dispatch_story_planner',
      role: STORY_PLANNER_ROLE,
      allowedTools: STORY_PLANNER_ALLOWED_TOOLS,
      buildVars: buildStoryPlannerVars,
      fallbackHint: STORY_PLANNER_FALLBACK_HINT,
    });
  },
});

const EPISODE_PLANNER_FALLBACK_HINT =
  '改在对话里直接用 episode_outlines_update 工具与作者共创集纲';

export const dispatchEpisodePlannerTool = defineTool({
  id: 'dispatch_episode_planner',
  description:
    '把大纲交给专门的分集规划员：产出集纲草案回来呈给作者阅读采纳。集纲是介于大纲与正文之间的'
    + '分集规划（一集约一章的剧情单元），每集含目的、摘要、核心事件、角色进展、情绪与节奏节拍、'
    + '伏笔与回收、章末钩子，并对齐成长曲线的转折点、挂到大纲的分卷阶段上。'
    + 'intent 里写清作者对这次分集的要求：如每卷大致集数、侧重哪条线、节奏偏好、特殊约束；'
    + '大纲、场景结构、三类曲线、设定卡等项目现状资料系统会自动附带给规划员。',
  parameters: z.object({
    // CR-006 + CR-018：同上——trim 非空 + 8000 上限。
    intent: z.string().trim().min(1).max(8000).describe(
      '作者对这次分集的要求：如每卷大致集数、侧重哪条线、节奏偏好、特殊约束',
    ),
  }),
  async execute(params, ctx) {
    return executePlannerDispatch(params, ctx, {
      toolId: 'dispatch_episode_planner',
      role: EPISODE_PLANNER_ROLE,
      allowedTools: EPISODE_PLANNER_ALLOWED_TOOLS,
      buildVars: buildEpisodePlannerVars,
      fallbackHint: EPISODE_PLANNER_FALLBACK_HINT,
    });
  },
});
