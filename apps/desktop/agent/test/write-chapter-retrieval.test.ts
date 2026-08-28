import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';

// Story 8.4 A10（design §1.8）：#9 建议读取退役——write_chapter 不再派 retrieval 子 agent、不再合并
// suggestedReads 进 brief。写手自查（writer-node 工具循环）覆盖原 #9 功能面。本文件是「无 #9 路径」
// 断言：①retrieval-agent role 零派发（Director 照常，role-aware mock 隔离）；②leader brief 原样直通
// assemble（chapter_brief_input.brief 无 #9 合并步骤）；③gate-first 保留——brief 未就绪零子 agent 派发。
// mirror write-chapter-tool.test.ts 的 ToolContext mock 模式。

describe('write_chapter tool 无 #9 路径（Story 8.4 A10 退役回归）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-retrieval-'));
    runChapterChain = vi.fn();
    // role-aware mock：director-agent → 空 entries（不干扰零派发断言）；retrieval-agent 若被错误派发
    // 会返回可解析 JSON——断言用调用计数抓（任何 retrieval-agent 调用都属违规）。
    runAgentWithExplicitSystem = vi.fn(async (_sid: string, role: string) => {
      if (role === 'director-agent') return { content: JSON.stringify({ entries: [] }) };
      return { content: '{}' };
    });
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: {
        runChapterChain,
        runAgentWithExplicitSystem,
        runSubagent: vi.fn(),
        executeSkillByName: vi.fn(),
      },
    };
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
    vi.resetModules();
  });

  /** retrieval-agent 调用次数（filter by role，隔离 Director 附加调用）。 */
  function retrievalCallCount(): number {
    return runAgentWithExplicitSystem.mock.calls.filter((c) => c[1] === 'retrieval-agent').length;
  }

  function writeReadyProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }], edges: [], lines: [] },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
    }), 'utf8');
  }

  const SUMMARY_OK: RunSnapshotSummary = {
    status: 'completed',
    routeDecision: { decision: 'accept_as_truth', reason: '通过' },
    reviewVerdict: 'pass',
    draftTitle: '第二章',
    draftWordCount: 2000,
    errors: [],
  };

  // ════════════════════════════════════════════════════════════════════════════
  // a. retrieval-agent 零派发 + leader brief 原样直通（无 #9 合并步骤）
  // ════════════════════════════════════════════════════════════════════════════

  it('write_chapter 不派 retrieval-agent；chapter_brief_input.brief = leader brief 原样（无 #9）', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // retrieval-agent 零派发（#9 退役——写手自查取代，资料员核实走 writer 节点内子循环）
    expect(retrievalCallCount()).toBe(0);
    // 链段照跑（Director 照常派发不受影响）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    // leader brief 原样直通 assemble（chapter_brief_input.brief 即 leader 传的 brief）
    const [, artifacts] = runChapterChain.mock.calls[0];
    const briefInput = artifacts['chapter_brief_input'] as { episodeId: string; brief: Record<string, unknown> };
    expect(briefInput.episodeId).toBe('ep1');
    expect(briefInput.brief.goal).toBe('抵达 B 城');
    expect('suggestedReads' in briefInput.brief).toBe(false);
  });

  it('skillExecutor 缺 runAgentWithExplicitSystem → 链段照跑（#9 拆除后无 retrieval 兜底分支差异）', async () => {
    writeReadyProject();
    // ctx.skillExecutor 不含 runAgentWithExplicitSystem（旧 runtime 兼容路径）
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: {
        runChapterChain,
        runSubagent: vi.fn(),
        executeSkillByName: vi.fn(),
      },
    };
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [, artifacts] = runChapterChain.mock.calls[0];
    const briefInput = artifacts['chapter_brief_input'] as { brief: Record<string, unknown> };
    expect('suggestedReads' in briefInput.brief).toBe(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // b. P1（BMad CR Blind+Edge medium）gate-first 保留：brief 未就绪 → 零子 agent 派发 + 不跑链段
  // ════════════════════════════════════════════════════════════════════════════

  it('P1 gate-first：brief 未就绪（缺 goal → needs_world_context）→ 零子 agent 派发 + 不跑链段', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    // chapterBrief 缺 goal（其余 ready：scene_graph 1 node + settings 渲染非空）→ needs_world_context
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { tone: '紧张' } },
      ctx,
    );

    // 子 agent 零派发（gate 在前，brief 未就绪不派 Director 等——免烧多步 LLM 算力）
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
    // 链段不跑
    expect(runChapterChain).not.toHaveBeenCalled();
    // 返 gate 错误文案（needs_world_context）
    expect(result.output).toContain('needs_world_context');
  });
});
