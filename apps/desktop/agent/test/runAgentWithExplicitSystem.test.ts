import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { ToolDefinition } from '../src/types';

// Story 4.5（design §3.3 / implement.md WP3a）：WorkflowRuntime.runAgentWithExplicitSystem 单测。
// mock generate（捕 system + tools + user content）+ 真 dispatchSubagent（建 child session 跑 complete 回调内
// runChildAgentWithExplicitSystem）。验：
// (a) retrieval-agent.yaml system 段真加载（system 含「资料员」等 yaml 标记）；
// (b) allowedTools=['query_story'] 时 generate 收到的 tools 仅 query_story（D1-c 反向约束守门）；
// (c) vars 渲染进 user 段（episodeId/briefGoal 等）；
// (d) 返 {content}（assistant 内容）；
// (e) yaml system 在前 + base runtime system 在后（拼接）。

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

describe('WorkflowRuntime.runAgentWithExplicitSystem（Story 4.5 WP3a）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-run-retrieval-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  async function makeRuntime(generate: ReturnType<typeof vi.fn<GenerateFn>>) {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    return createWorkflowRuntime({ generate });
  }

  async function makeParent(runtime: any) {
    return runtime.createSession({ agentName: 'creative-director', projectPath });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // a + c + d. retrieval yaml system 加载 + vars 渲染 + 返 content
  // ════════════════════════════════════════════════════════════════════════════

  it('retrieval-agent.yaml system 真加载（含「出发核查员」标记）+ vars 渲染进 user + 返 content', async () => {
    // Story 8.4：retrieval-agent.yaml 已转岗核实员（system 标记「出发核查员」；user 段三 var =
    // chapterTask/researchBrief/ammo）。本测试验 runAgentWithExplicitSystem 机制（yaml 真加载 + vars 渲染
    // + 返 content），资料员生产消费走 research-verifier 子循环（writer 节点内），不经此 seam。
    const RETRIEVAL_OUTPUT = JSON.stringify({
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
      pass: true,
      gaps: [],
      suggestions: [],
      archive_issues: [],
    });
    const generate = vi.fn<GenerateFn>(async (msgs, sys) => {
      // a. system 含 retrieval-agent.yaml 标记（证明 loadAgentPrompt('retrieval-agent') 真读 yaml）
      expect(sys).toContain('出发核查员');
      // c. vars 渲染进 user 段（chapterTask + researchBrief + ammo）
      const userContent = msgs[0]?.content ?? '';
      expect(userContent).toContain('ep_cast_1');
      expect(userContent).toContain('抵达 B 城');
      expect(userContent).toContain('林昭左臂旧伤');
      expect(userContent).toContain('char-mei');
      return { content: RETRIEVAL_OUTPUT, finishReason: 'stop' };
    });
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const result = await runtime.runAgentWithExplicitSystem(
      parent.id,
      'retrieval-agent',
      {
        chapterTask: JSON.stringify({ episodeId: 'ep_cast_1', goal: '抵达 B 城' }),
        researchBrief: JSON.stringify({
          plan: '对峙收束',
          entries: [{ ref: 'char-lin', kind: 'asset', key_facts: [{ fact: '林昭左臂旧伤', source: '人物卡' }] }],
          issues: [],
          execution_plan: [],
          deviations: [],
        }),
        ammo: '出场间隔统计：- char-mei：距本章开场 storyTime 差 95',
      },
      { allowedTools: ['query_story'] },
    );

    // d. 返 {content}（context isolation）
    expect(result.content).toBe(RETRIEVAL_OUTPUT);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // b. allowedTools=['query_story'] → generate 收到的 tools 仅 query_story（D1-c 守门）
  // ════════════════════════════════════════════════════════════════════════════

  it('allowedTools=["query_story"] → generate 收到的 tools 仅 query_story（写工具被滤掉）', async () => {
    // 注册内置工具（含 query_story + write_file + git_commit 等），让 registry 非空以验过滤。
    const { registerBuiltinTools } = await import('../src/tool/builtin');
    registerBuiltinTools();

    const generate = vi.fn<GenerateFn>(async (_msgs, _sys, tools: ToolDefinition[]) => {
      // 反向约束守门：allowedTools 白名单下只见 query_story，write_file/git_commit 等危险工具被滤掉。
      const toolIds = tools.map((t) => t.id);
      expect(toolIds).toContain('query_story');
      expect(toolIds).not.toContain('write_file');
      expect(toolIds).not.toContain('git_commit');
      expect(toolIds).not.toContain('chapter_write');
      return { content: '{"ok":true}', finishReason: 'stop' };
    });
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    await runtime.runAgentWithExplicitSystem(
      parent.id,
      'retrieval-agent',
      { chapterTask: '{}', researchBrief: '{}', ammo: '' },
      { allowedTools: ['query_story'] },
    );

    expect(generate).toHaveBeenCalledTimes(1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // e. allowedTools 缺省 → generate 收到更多工具（query_story + 其他读工具；contrast 证 allowedTools 是收窄层）
  // ════════════════════════════════════════════════════════════════════════════
  // 注：runLoop filterToolsForPolicy 会按 session permissionMode（child session 默认 suggest）进一步收窄
  // （suggest 模式禁 write/dangerous 类）。故「全工具」实际是「suggest 模式允许的工具集」——含 query_story
  // + read_file + search 等读工具，但不含 write_file。本测试验 contrast：allowedTools 缺省时可见工具
  // 多于 allowedTools=['query_story'] 时的单一 query_story，证 allowedTools 是 caller 控制的收窄层。

  it('allowedTools 缺省 → generate 收到 query_story + 其他读工具（contrast：多于 allowedTools 收窄后）', async () => {
    const { registerBuiltinTools } = await import('../src/tool/builtin');
    registerBuiltinTools();

    const generate = vi.fn<GenerateFn>(async (_msgs, _sys, tools: ToolDefinition[]) => {
      const toolIds = tools.map((t) => t.id);
      expect(toolIds).toContain('query_story');
      // contrast：allowedTools=['query_story'] 时仅 query_story；缺省时多出其他读工具（如 read_file / search）。
      expect(toolIds.length).toBeGreaterThan(1);
      expect(toolIds).toContain('read_file');
      return { content: '{"ok":true}', finishReason: 'stop' };
    });
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    await runtime.runAgentWithExplicitSystem(
      parent.id,
      'retrieval-agent',
      { chapterTask: '{}', researchBrief: '{}', ammo: '' },
      // 不传 allowedTools
    );

    expect(generate).toHaveBeenCalledTimes(1);
  });
});
