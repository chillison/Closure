import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.6 WP8：dispatch_researcher tool 测试（mirror diagnose-impacts.test.ts 形态）。
//
// 测五块（implement.md WP8 验证门）：
// 1. 派发接线：runAgentWithExplicitSystem('researcher-agent', {brief}, {allowedTools 白名单})
//    被正确调用 + 报告内容回传 leader。
// 2. allowedTools 白名单：exact 数组断言 + 与 registry 注册对齐（白名单 id 全部已注册）
//    + 不含写/派发工具（researcher 只读叶子）。
// 3. 五段 brief 渲染：可选段缺省跳过（不产空段标题）。
// 4. graceful：skillExecutor 缺 / dispatch 抛错 / 空报告 → 友善降级（不假报告）。
// 5. researcher-agent.yaml 契约非降级（system 含研究协议硬规矩 + userTemplate 含 {{brief}}——
//    文件缺失时 loadAgentPrompt 静默降级空串，子 agent 将拿到空任务，须守）。
// ─────────────────────────────────────────────────────────────────────────────

import {
  RESEARCHER_ALLOWED_TOOLS,
  RESEARCHER_ROLE,
  dispatchResearcherTool,
  renderResearchBrief,
} from '../src/tool/dispatch-researcher';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { loadAgentPrompt } from '../src/prompt/agentPrompt';

registerBuiltinTools();

describe('dispatch_researcher tool（Story 3.6 WP8）', () => {
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    runAgentWithExplicitSystem = vi.fn();
    ctx = {
      sessionId: 'leader-1',
      projectPath: '/proj/alpha',
      abort: new AbortController().signal,
      skillExecutor: { runAgentWithExplicitSystem },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('派发接线：以 researcher-agent 角色 + 五段 brief + 白名单调 runAgentWithExplicitSystem，报告回传', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({ content: '# 研究报告\n本次研究依据的简要理解…' });

    const result = await dispatchResearcherTool.execute(
      {
        researchQuestion: '阿米娅的能力设定在不同版本有什么差异',
        creativeContext: '主角金手指选型',
      },
      ctx,
    );

    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const [sessionId, role, vars, options] = runAgentWithExplicitSystem.mock.calls[0]!;
    expect(sessionId).toBe('leader-1');
    expect(role).toBe(RESEARCHER_ROLE);
    expect(role).toBe('researcher-agent');
    expect(vars.brief).toContain('研究问题（要澄清什么）：阿米娅的能力设定在不同版本有什么差异');
    expect(vars.brief).toContain('创作背景（服务什么决定）：主角金手指选型');
    expect(options.allowedTools).toEqual([...RESEARCHER_ALLOWED_TOOLS]);

    expect(result.output).toContain('本次研究依据的简要理解');
    expect(result.metadata).toMatchObject({ ok: true });
  });

  it('五段 brief 渲染：可选段缺省跳过，不产空段标题', () => {
    const full = renderResearchBrief({
      researchQuestion: 'Q',
      creativeContext: 'C',
      knownAndHypotheses: 'K',
      constraints: 'S',
      expectedOutput: 'E',
    });
    expect(full).toContain('创作背景');
    expect(full).toContain('已知与假设');
    expect(full).toContain('约束（原则、采信偏好）');
    expect(full).toContain('期望产出');

    const bare = renderResearchBrief({ researchQuestion: 'Q' });
    expect(bare).toBe('研究问题（要澄清什么）：Q');
    expect(bare).not.toContain('创作背景');

    // 空白段也跳过（LLM 传空串不产空标题行）
    expect(renderResearchBrief({ researchQuestion: 'Q', creativeContext: '   ' })).not.toContain('创作背景');
  });

  it('graceful：skillExecutor 缺 → 友善降级指引直调研究工具', async () => {
    const result = await dispatchResearcherTool.execute({ researchQuestion: 'Q' }, {
      ...ctx,
      skillExecutor: undefined,
    });
    expect(result.output).toContain('不可用');
    expect(result.output).toContain('wiki_search');
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
  });

  it('graceful：dispatch 抛错 → 友善降级（不假报告）', async () => {
    runAgentWithExplicitSystem.mockRejectedValue(new Error('network down'));
    const result = await dispatchResearcherTool.execute({ researchQuestion: 'Q' }, ctx);
    expect(result.output).toContain('派发失败');
    expect(result.output).toContain('network down');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'dispatch-failed' });
  });

  it('graceful：空报告 → 友善降级（不把空串当报告回传）', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({ content: '   ' });
    const result = await dispatchResearcherTool.execute({ researchQuestion: 'Q' }, ctx);
    expect(result.output).toContain('空报告');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'empty-report' });
  });
});

describe('researcher allowedTools 白名单（对齐 + 只读性）', () => {
  it('白名单与 registry 注册对齐（每个 id 都已注册——runChildAgentWithExplicitSystem 按注册过滤）', () => {
    const registered = new Set(registry.all().map((t) => t.id));
    for (const id of RESEARCHER_ALLOWED_TOOLS) {
      expect(registered.has(id), `whitelist id "${id}" must be registered`).toBe(true);
    }
  });

  it('白名单覆盖研究工具面（wiki/web/render/parse/analyze + 项目查询）', () => {
    for (const id of ['wiki_search', 'wiki_read', 'web_search', 'web_fetch', 'render_page', 'parse_document', 'analyze_image', 'query_story', 'query_craft', 'project_meta']) {
      expect(RESEARCHER_ALLOWED_TOOLS).toContain(id);
    }
  });

  it('白名单不含写/危险/派发工具（researcher 是只读叶子执行者）', () => {
    for (const forbidden of ['write_file', 'chapter_write', 'outline_update', 'overview_update', 'git_commit', 'memory_update', 'scene_graph_update', 'spawn_agent', 'dispatch_researcher', 'write_chapter', 'start_batch']) {
      expect(RESEARCHER_ALLOWED_TOOLS).not.toContain(forbidden);
    }
  });
});

describe('researcher-agent.yaml 契约（ADR-4 单契约源）', () => {
  it('加载非降级：system 含研究协议硬规矩 + userTemplate 含 {{brief}} var', async () => {
    const prompt = await loadAgentPrompt('researcher-agent');
    // loadAgentPrompt 文件缺失/损坏静默降级空串——断言非空守「子 agent 拿到空任务」静默失败。
    expect(prompt.system.length).toBeGreaterThan(100);
    expect(prompt.system).toContain('简要理解');
    expect(prompt.system).toContain('多源交叉验证');
    expect(prompt.system).toContain('需要澄清');
    expect(prompt.system).toContain('不自作主张');
    expect(prompt.system).toContain('绝不编造图片内容');
    expect(prompt.userTemplate).toContain('{{brief}}');
  });
});
