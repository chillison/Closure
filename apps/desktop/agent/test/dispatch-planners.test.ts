import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.6 R7（design D10/D11 + GAP-2）：dispatch_story_planner / dispatch_episode_planner
// tool 测试（mirror dispatch-researcher.test.ts 形态 + diagnose-impacts.test.ts 的 temp
// project.yaml 写盘模式）。测五块（implement.md Step 5 验证门）：
// 1. 派发接线：runAgentWithExplicitSystem(role 逐字, vars, {allowedTools 白名单逐字}) 被正确
//    调用 + 草案内容回传 leader。
// 2. vars 组装：结构化字段 JSON 序列化 + patternGuide（derivePatternGuide 单源）+
//    narrativeEnumGuide（formatNarrativeEnumGuide 单源）+ 与 yaml user 模板 var 名逐字对齐
//    （防模板 var 漂移——renderTemplate 缺 var 静默空串）。
// 3. graceful：project.yaml 不可读 / skillExecutor 缺 / dispatch 抛错 / 空返回 → 友善降级
//    （不假成功，leader 转文字路径）。
// 4. allowedTools 白名单：exact 数组断言 + 与 registry 注册对齐 + 不越 owns 契约
//    （episode-planner 不含 scene_graph_update——GAP-1 挂锚归 leader 直改）。
// 5. story-planner-agent.yaml GAP-2 微调句存在（requirement 已含作者确认结论时按结论直接产出）
//    + 两 yaml 契约非降级。
// ─────────────────────────────────────────────────────────────────────────────

import {
  EPISODE_PLANNER_ALLOWED_TOOLS,
  EPISODE_PLANNER_ROLE,
  STORY_PLANNER_ALLOWED_TOOLS,
  STORY_PLANNER_ROLE,
  buildEpisodePlannerVars,
  buildStoryPlannerVars,
  dispatchEpisodePlannerTool,
  dispatchStoryPlannerTool,
} from '../src/tool/dispatch-planners';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { loadAgentPrompt } from '../src/prompt/agentPrompt';

registerBuiltinTools();

/** 从 yaml user 模板提取全部 {{var}} 名（与 buildXxxPlannerVars 键集对齐断言用）。 */
function templateVarsOf(template: string): string[] {
  return [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
}

/** 齐料项目文档（各站全有 + creative_brief 带合法 structure_pattern——patternGuide 非空路径）。
 *  CR-001（8.6 BMad CR）：大纲键按 projectDocumentSchema 真键 `outline_v2`（旧 fixture 用 `outline`
 *  是错键——dispatch 旧代码读它恒 undefined，集纲规划员收空大纲）。 */
const FULL_PROJECT_DOC = {
  meta: { name: 'test-novel' },
  creative_brief: { rawRequirement: '一个末世修真的复仇故事', structure_pattern: 'anchor-single' },
  world_setting: { premise: '灵气复苏后的废土' },
  asset_cards: [{ id: 'c1', type: 'character', name: '阿米娅' }],
  relationship_graph: { nodes: [{ id: 'c1' }], edges: [] },
  outline_v2: { phases: [{ id: 'p1', title: '卷一' }] },
  scene_graph: { nodes: [], lines: [], edges: [] },
  growth_curve: [],
  pacing_curve: [],
  emotion_curve: { points: [] },
};

describe('dispatch_story_planner / dispatch_episode_planner 派发接线', () => {
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;
  let projectPath: string;

  beforeEach(() => {
    runAgentWithExplicitSystem = vi.fn();
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'dispatch-planners-'));
    ctx = {
      sessionId: 'leader-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runAgentWithExplicitSystem },
    };
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.clearAllMocks();
  });

  it('story-planner：role 逐字 + vars 组装（requirement= intent / 结构化 JSON / patternGuide / narrativeEnumGuide）+ 白名单逐字，草案回传', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(FULL_PROJECT_DOC), 'utf8');
    runAgentWithExplicitSystem.mockResolvedValue({ content: '# 大纲草案\n核心冲突：……' });

    const result = await dispatchStoryPlannerTool.execute(
      { intent: '复仇主线，三卷，只产第一卷，核心人物阿米娅' },
      ctx,
    );

    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const [sessionId, role, vars, options] = runAgentWithExplicitSystem.mock.calls[0]!;
    expect(sessionId).toBe('leader-1');
    expect(role).toBe(STORY_PLANNER_ROLE);
    expect(role).toBe('story-planner-agent');

    expect(vars.requirement).toBe('复仇主线，三卷，只产第一卷，核心人物阿米娅');
    expect(vars.world_setting).toBe(JSON.stringify(FULL_PROJECT_DOC.world_setting));
    expect(vars.asset_cards).toBe(JSON.stringify(FULL_PROJECT_DOC.asset_cards));
    expect(vars.relationship_graph).toBe(JSON.stringify(FULL_PROJECT_DOC.relationship_graph));
    // patternGuide 复用 derivePatternGuide 单源（anchor-single seed 的中文名可见）
    expect(vars.patternGuide).toContain('锚点单线');
    // narrativeEnumGuide 复用 formatNarrativeEnumGuide 单源（静态词表恒在）
    expect(vars.narrativeEnumGuide).toContain('叙事枚举词表');
    expect(vars.narrativeEnumGuide).toContain('pacingRole');
    // dogfood R2：craftGuide 复用 STORY_PLANNER_CRAFT_GUIDE 单源（engine/craftGuide.ts——四因说
    // 大纲语法四件检查，恒在零 projectDocument 依赖，mirror narrativeEnumGuide 先例）
    expect(vars.craftGuide).toContain('六步法情节弧');
    expect(vars.craftGuide).toContain('期待感钩子');
    expect(vars.craftGuide).toContain('剧情线咬接');
    expect(vars.craftGuide).toContain('高潮前置规划');

    expect(options.allowedTools).toEqual(['outline_update', 'scene_graph_update']);
    expect(options.allowedTools).toEqual([...STORY_PLANNER_ALLOWED_TOOLS]);

    expect(result.output).toContain('核心冲突：……');
    expect(result.metadata).toMatchObject({ ok: true });
  });

  it('child 事件通道透传（dogfood R2 #3 二段）：ctx 带 emitChildEvent 时进派发 options，缺失时不占位', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(FULL_PROJECT_DOC), 'utf8');
    runAgentWithExplicitSystem.mockResolvedValue({ content: '草案' });
    const emit = vi.fn();

    await dispatchStoryPlannerTool.execute({ intent: 'x' }, { ...ctx, emitChildEvent: emit });
    expect(runAgentWithExplicitSystem.mock.calls[0]![3]!.emitChildEvent).toBe(emit);

    await dispatchEpisodePlannerTool.execute({ intent: 'x' }, ctx);
    expect('emitChildEvent' in runAgentWithExplicitSystem.mock.calls[1]![3]!).toBe(false);
  });

  it('episode-planner：role 逐字 + 8 vars 全量组装 + 白名单逐字，草案回传', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(FULL_PROJECT_DOC), 'utf8');
    runAgentWithExplicitSystem.mockResolvedValue({ content: '# 集纲草案\n第一集：……' });

    const result = await dispatchEpisodePlannerTool.execute(
      { intent: '每卷约 20 集，侧重主线推进' },
      ctx,
    );

    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const [sessionId, role, vars, options] = runAgentWithExplicitSystem.mock.calls[0]!;
    expect(sessionId).toBe('leader-1');
    expect(role).toBe(EPISODE_PLANNER_ROLE);
    expect(role).toBe('episode-planner-agent');

    expect(vars.requirement).toBe('每卷约 20 集，侧重主线推进');
    // CR-001：var 名 `outline` 的源键是 schema 真键 `outline_v2`（var 名 ≠ project.yaml 键名）。
    expect(vars.outline).toBe(JSON.stringify(FULL_PROJECT_DOC.outline_v2));
    expect(vars.scene_graph).toBe(JSON.stringify(FULL_PROJECT_DOC.scene_graph));
    expect(vars.growth_curve).toBe(JSON.stringify(FULL_PROJECT_DOC.growth_curve));
    expect(vars.pacing_curve).toBe(JSON.stringify(FULL_PROJECT_DOC.pacing_curve));
    expect(vars.emotion_curve).toBe(JSON.stringify(FULL_PROJECT_DOC.emotion_curve));
    expect(vars.asset_cards).toBe(JSON.stringify(FULL_PROJECT_DOC.asset_cards));
    expect(vars.relationship_graph).toBe(JSON.stringify(FULL_PROJECT_DOC.relationship_graph));

    // Story 8.7 S9：query_mentions（只读）进白名单——分集安排「每集谁出场」翻出场账。
    expect(options.allowedTools).toEqual(['episode_outlines_update', 'query_mentions']);
    expect(options.allowedTools).toEqual([...EPISODE_PLANNER_ALLOWED_TOOLS]);

    expect(result.output).toContain('第一集：……');
    expect(result.metadata).toMatchObject({ ok: true });
  });

  it('BOM 前缀 project.yaml 照常解析（BOM-strip 防御，mirror loadChainProjectInput）', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), `\uFEFF${JSON.stringify(FULL_PROJECT_DOC)}`, 'utf8');
    runAgentWithExplicitSystem.mockResolvedValue({ content: '草案' });

    const result = await dispatchStoryPlannerTool.execute({ intent: 'I' }, ctx);
    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const [, , vars] = runAgentWithExplicitSystem.mock.calls[0]!;
    expect(vars.world_setting).toBe(JSON.stringify(FULL_PROJECT_DOC.world_setting));
    expect(result.metadata).toMatchObject({ ok: true });
  });

  it('风格卡（B 路 D7）：settings/style.md 存在 → 两 planner 派发 vars 含精简四节；无卡 → 空串不占位', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(FULL_PROJECT_DOC), 'utf8');
    mkdirSync(path.join(projectPath, 'settings'), { recursive: true });
    writeFileSync(
      path.join(projectPath, 'settings', 'style.md'),
      [
        '---', 'id: style', '---', '# 风格卡片', '',
        '## ① 声音画像', '冷静旁观。', '',
        '## ⑧ 情绪手法', '外化身体反应。', '',
        '## ⑪ 期待管理', '章尾悬崖切。', '',
        '## ⑫ 禁则', '不用感叹号。', '',
        '## ⑬ 节选（few-shot）', '', '```text', '节选原文不进精简版。', '```', '',
      ].join('\n'),
      'utf8',
    );
    runAgentWithExplicitSystem.mockResolvedValue({ content: '草案' });

    await dispatchStoryPlannerTool.execute({ intent: 'I' }, ctx);
    const storyVars = runAgentWithExplicitSystem.mock.calls[0]![2] as Record<string, string>;
    // 四节配方命中（D7：声音画像+禁则+情绪手法+期待管理）；few-shot 原文不进。
    expect(storyVars.styleBrief).toContain('## ① 声音画像');
    expect(storyVars.styleBrief).toContain('## ⑫ 禁则');
    expect(storyVars.styleBrief).toContain('## ⑧ 情绪手法');
    expect(storyVars.styleBrief).toContain('## ⑪ 期待管理');
    expect(storyVars.styleBrief).not.toContain('节选原文不进精简版');

    await dispatchEpisodePlannerTool.execute({ intent: 'I' }, ctx);
    const episodeVars = runAgentWithExplicitSystem.mock.calls[1]![2] as Record<string, string>;
    expect(episodeVars.styleBrief).toContain('## ① 声音画像');

    // 无卡项目：空串（不占位）——删除卡后重派。
    rmSync(path.join(projectPath, 'settings', 'style.md'));
    await dispatchStoryPlannerTool.execute({ intent: 'I' }, ctx);
    expect((runAgentWithExplicitSystem.mock.calls[2]![2] as Record<string, string>).styleBrief).toBe('');
  });
});

describe('vars 组装（纯函数 + yaml user 模板 var 对齐守卫）', () => {
  it('story-planner vars 键集与 yaml user 模板逐字对齐（防模板 var 漂移→renderTemplate 静默空串）', async () => {
    const { userTemplate } = await loadAgentPrompt(STORY_PLANNER_ROLE);
    expect(userTemplate.length).toBeGreaterThan(50);
    expect(new Set(templateVarsOf(userTemplate)))
      .toEqual(new Set(Object.keys(buildStoryPlannerVars('x', {}))));
  });

  it('episode-planner vars 键集与 yaml user 模板逐字对齐', async () => {
    const { userTemplate } = await loadAgentPrompt(EPISODE_PLANNER_ROLE);
    expect(userTemplate.length).toBeGreaterThan(50);
    expect(new Set(templateVarsOf(userTemplate)))
      .toEqual(new Set(Object.keys(buildEpisodePlannerVars('x', {}))));
  });

  it('冷启动空项目：缺失字段降级空串，narrativeEnumGuide 恒在，requirement 照传', () => {
    const storyVars = buildStoryPlannerVars('只有一个灵感', {});
    expect(storyVars.requirement).toBe('只有一个灵感');
    expect(storyVars.world_setting).toBe('');
    expect(storyVars.asset_cards).toBe('');
    expect(storyVars.relationship_graph).toBe('');
    // 未选 pattern（structure_pattern 缺省）→ patternGuide 空串 = yaml 四节「按三型推荐」路径
    expect(storyVars.patternGuide).toBe('');
    expect(storyVars.narrativeEnumGuide.length).toBeGreaterThan(0);
    // dogfood R2：craftGuide 恒在（静态常量，冷启动零依赖——同 narrativeEnumGuide）
    expect(storyVars.craftGuide.length).toBeGreaterThan(0);

    const episodeVars = buildEpisodePlannerVars('I', {});
    expect(episodeVars.requirement).toBe('I');
    expect(episodeVars.outline).toBe('');
    expect(episodeVars.scene_graph).toBe('');
    expect(episodeVars.growth_curve).toBe('');
    expect(episodeVars.pacing_curve).toBe('');
    expect(episodeVars.emotion_curve).toBe('');
    expect(episodeVars.asset_cards).toBe('');
    expect(episodeVars.relationship_graph).toBe('');
  });

  it('patternGuide 复用 derivePatternGuide 单源：非法 structure_pattern 视同未选（空指引不抛错）', () => {
    const vars = buildStoryPlannerVars('I', {
      creative_brief: { structure_pattern: 'not-a-real-pattern' },
    });
    expect(vars.patternGuide).toBe('');
  });

  // ── 风格卡片 MVP（B 路 D7）：styleBrief var（buildStyleBrief 单源精简版四节）──

  it('styleBrief：显式传入照供；缺省空串（无卡不占位，恒供 key 防 missing-var warn）', () => {
    const storyVars = buildStoryPlannerVars('I', {}, '风格卡要点内容');
    expect(storyVars.styleBrief).toBe('风格卡要点内容');
    expect(buildStoryPlannerVars('I', {}).styleBrief).toBe('');
    expect(buildEpisodePlannerVars('I', {}).styleBrief).toBe('');
    expect(buildEpisodePlannerVars('I', {}, '四节配方').styleBrief).toBe('四节配方');
  });

  it('dogfood R2：craftGuide 篇幅守预算（≤1200 字，宁精不多——任务约束）+ 四件检查块齐备', async () => {
    const { STORY_PLANNER_CRAFT_GUIDE } = await import('../src/engine/craftGuide');
    expect(STORY_PLANNER_CRAFT_GUIDE.length).toBeLessThanOrEqual(1200);
    expect(STORY_PLANNER_CRAFT_GUIDE).toContain('六步法情节弧');
    expect(STORY_PLANNER_CRAFT_GUIDE).toContain('期待感钩子');
    expect(STORY_PLANNER_CRAFT_GUIDE).toContain('剧情线咬接');
    expect(STORY_PLANNER_CRAFT_GUIDE).toContain('高潮前置规划');
    // 先验非硬规则声明在（作者确认结论优先——防检查单变成 LLM 越权改作者决定的依据）。
    expect(STORY_PLANNER_CRAFT_GUIDE).toContain('以作者为准');
  });
});

describe('graceful（mirror dispatch-researcher 五态降级）', () => {
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;
  let projectPath: string;

  beforeEach(() => {
    runAgentWithExplicitSystem = vi.fn();
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'dispatch-planners-graceful-'));
    ctx = {
      sessionId: 'leader-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runAgentWithExplicitSystem },
    };
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.clearAllMocks();
  });

  it('project.yaml 不可读 → 工具报错 graceful（零派发，leader 转文字路径）', async () => {
    // 不写 project.yaml → readFile 抛
    const result = await dispatchStoryPlannerTool.execute({ intent: 'I' }, ctx);
    expect(result.output).toContain('project.yaml');
    expect(result.output).toContain('outline_update');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'project-unreadable' });
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();

    const result2 = await dispatchEpisodePlannerTool.execute({ intent: 'I' }, ctx);
    expect(result2.metadata).toMatchObject({ ok: false, reason: 'project-unreadable' });
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
  });

  it('malformed yaml → 同 project-unreadable graceful', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), 'world_setting: [unclosed', 'utf8');
    const result = await dispatchStoryPlannerTool.execute({ intent: 'I' }, ctx);
    expect(result.metadata).toMatchObject({ ok: false, reason: 'project-unreadable' });
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
  });

  it('skillExecutor 缺 → 友善降级（不派发）', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(FULL_PROJECT_DOC), 'utf8');
    const result = await dispatchStoryPlannerTool.execute(
      { intent: 'I' },
      { ...ctx, skillExecutor: undefined },
    );
    expect(result.output).toContain('不可用');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'dispatch-unavailable' });
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
  });

  it('dispatch 抛错 → 友善降级（不假成功）', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(FULL_PROJECT_DOC), 'utf8');
    runAgentWithExplicitSystem.mockRejectedValue(new Error('network down'));
    const result = await dispatchStoryPlannerTool.execute({ intent: 'I' }, ctx);
    expect(result.output).toContain('派发失败');
    expect(result.output).toContain('network down');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'dispatch-failed' });
  });

  it('空返回 → 友善降级（不把空串当草案回传）', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(FULL_PROJECT_DOC), 'utf8');
    runAgentWithExplicitSystem.mockResolvedValue({ content: '   ' });
    const result = dispatchEpisodePlannerTool !== undefined
      ? await dispatchEpisodePlannerTool.execute({ intent: 'I' }, ctx)
      : null;
    expect(result?.output).toContain('空草案');
    expect(result?.metadata).toMatchObject({ ok: false, reason: 'empty-output' });
  });
});

describe('allowedTools 白名单（对齐 + owns 契约边界）', () => {
  it('两白名单与 registry 注册对齐（每个 id 都已注册——runChildAgentWithExplicitSystem 按注册过滤）', () => {
    const registered = new Set(registry.all().map((t) => t.id));
    for (const id of [...STORY_PLANNER_ALLOWED_TOOLS, ...EPISODE_PLANNER_ALLOWED_TOOLS]) {
      expect(registered.has(id), `whitelist id "${id}" must be registered`).toBe(true);
    }
  });

  it('story-planner 白名单 = owns 契约两件，不含其他写/派发工具', () => {
    expect(STORY_PLANNER_ALLOWED_TOOLS).toEqual(['outline_update', 'scene_graph_update']);
    for (const forbidden of [
      'write_file', 'chapter_write', 'episode_outlines_update', 'growth_curve_update',
      'pacing_curve_update', 'emotion_curve_update', 'memory_update', 'git_commit',
      'spawn_agent', 'dispatch_researcher', 'write_chapter', 'dispatch_story_planner',
    ]) {
      expect(STORY_PLANNER_ALLOWED_TOOLS).not.toContain(forbidden);
    }
  });

  it('episode-planner 白名单不含 scene_graph_update（场→集挂锚归 leader 直改，GAP-1 修法）+ S9 加只读 query_mentions', () => {
    // Story 8.7 S9：query_mentions（只读）进白名单——分集安排「每集谁出场」，规划员翻得到各角色
    // 最后露面/间隔（读件不越 owns 契约）。
    expect(EPISODE_PLANNER_ALLOWED_TOOLS).toEqual(['episode_outlines_update', 'query_mentions']);
    for (const forbidden of [
      'scene_graph_update', 'outline_update', 'write_file', 'chapter_write',
      'spawn_agent', 'write_chapter', 'dispatch_researcher', 'dispatch_episode_planner',
    ]) {
      expect(EPISODE_PLANNER_ALLOWED_TOOLS).not.toContain(forbidden);
    }
  });

  it('builtin.ts 注册对齐：两工具 id 均已注册', () => {
    expect(registry.get('dispatch_story_planner')?.id).toBe('dispatch_story_planner');
    expect(registry.get('dispatch_episode_planner')?.id).toBe('dispatch_episode_planner');
  });
});

describe('规划 yaml 契约（ADR-4 单契约源 + GAP-2 微调）', () => {
  it('story-planner system 含 GAP-2 微调句：requirement 已给作者确认结论时按结论直接产出', async () => {
    const { system } = await loadAgentPrompt(STORY_PLANNER_ROLE);
    // loadAgentPrompt 文件缺失/损坏静默降级空串——断言非空守「子 agent 拿到空任务」静默失败。
    expect(system.length).toBeGreaterThan(100);
    expect(system).toContain('已给出作者确认的选型结论时，按结论直接产出');
    expect(system).toContain('不要再等待确认');
  });

  it('episode-planner 加载非降级：system 含分集协议硬规矩 + userTemplate 末行指向 episode_outlines_update', async () => {
    const { system, userTemplate } = await loadAgentPrompt(EPISODE_PLANNER_ROLE);
    expect(system.length).toBeGreaterThan(100);
    expect(system).toContain('phase_ref');
    expect(system).toContain('赘集');
    expect(userTemplate).toContain('episode_outlines_update');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8.6 BMad CR patches（CR-001 / CR-006 / CR-010 / CR-016 / CR-018）
// ─────────────────────────────────────────────────────────────────────────────

describe('BMad CR patches — dispatch-planners', () => {
  it('CR-001：episode vars 读 outline_v2 真键——盘上只有旧 `outline` 键时不再误供大纲（旧代码读错键恒空）', () => {
    // 只有 schema 真键 outline_v2 的文档：var outline = 其 JSON 序列化。
    const vars = buildEpisodePlannerVars('I', { outline_v2: { phases: [{ id: 'p1' }] } });
    expect(vars.outline).toBe(JSON.stringify({ phases: [{ id: 'p1' }] }));
    // 旧错键 `outline`（schema 无此键）不再是数据源——存在也不读（防键名漂移回退）。
    const legacyOnly = buildEpisodePlannerVars('I', { outline: { phases: [{ id: 'legacy' }] } });
    expect(legacyOnly.outline).toBe('');
  });

  it('CR-006：intent 纯空白串被 schema 拒（trim 校验——空需求不照派规划员白烧全程）', () => {
    for (const tool of [dispatchStoryPlannerTool, dispatchEpisodePlannerTool]) {
      expect(tool.parameters.safeParse({ intent: '' }).success).toBe(false);
      expect(tool.parameters.safeParse({ intent: '   \n\t ' }).success).toBe(false);
      expect(tool.parameters.safeParse({ intent: '正常意图' }).success).toBe(true);
      // trim transforms：首尾空白被剥后合法（中间空白保留）。
      expect(tool.parameters.parse({ intent: '  带首尾空白  ' }).intent).toBe('带首尾空白');
    }
  });

  it('CR-018：intent 长度上限 8000（LLM 失控超长不直进子 agent prompt）', () => {
    for (const tool of [dispatchStoryPlannerTool, dispatchEpisodePlannerTool]) {
      expect(tool.parameters.safeParse({ intent: 'x'.repeat(8000) }).success).toBe(true);
      expect(tool.parameters.safeParse({ intent: 'x'.repeat(8001) }).success).toBe(false);
    }
  });

  it('CR-010：serializeDocField 每 var cap 20000 字符 + 截断尾标注（大项目不撑爆子 agent prompt）', () => {
    // 构造超 20000 字符的结构化字段（growth_curve JSON 序列化超限）。
    const hugeCurve = Array.from({ length: 1200 }, (_, i) => ({
      character_id: `char-${i}`,
      start_state: '很长的状态描述'.repeat(3),
      turning_points: [],
    }));
    const truncated = buildEpisodePlannerVars('I', { growth_curve: hugeCurve }).growth_curve;
    // 截断保头 20000 + 尾标注；总长 = cap + 标注行（原始形态确实超限的前提由 cap+标注长度隐含）。
    expect(truncated.length).toBe(20000 + '\n…（已截断，仅保留前 20000 字符）'.length);
    expect(truncated.endsWith('…（已截断，仅保留前 20000 字符）')).toBe(true);
    // 未超限字段原样（无标注）。
    const small = buildEpisodePlannerVars('I', { growth_curve: [] });
    expect(small.growth_curve).toBe('[]');
  });

  it('CR-016：projectPath 异常（path.join 同步 throw）走 graceful 不穿出（project-unreadable）', async () => {
    const runAgentWithExplicitSystem = vi.fn();
    const ctx = {
      sessionId: 'leader-1',
      // 非 string projectPath——path.join 抛 ERR_INVALID_ARG_TYPE，须被 try 捕获走 graceful。
      projectPath: undefined as unknown as string,
      abort: new AbortController().signal,
      skillExecutor: { runAgentWithExplicitSystem },
    };
    const result = await dispatchStoryPlannerTool.execute({ intent: 'I' }, ctx);
    expect(result.metadata).toMatchObject({ ok: false, reason: 'project-unreadable' });
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
  });
});
