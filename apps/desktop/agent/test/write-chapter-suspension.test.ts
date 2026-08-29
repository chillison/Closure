import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4 Step 4（A7/A8）：write_chapter 挂起呈现 + 批量挂起标记（deliverable 2/4）。
// mock skillExecutor.runChapterChain 返 paused + researchSuspension summary —— 验：
// ① 挂起文案（明细 + 建议动作：改任务卡/改设定/维持原案→redo）；② chapter_review metadata
// （resumeOptions 无 continue + researchSuspension 载荷）；③ 批量 suspendedSceneIds 标记（幂等）。
// mirror write-chapter-tool.test.ts 的 ToolContext mock 模式。
// ─────────────────────────────────────────────────────────────────────────────

describe('write_chapter — Story 8.4 Step 4 出发核查挂起呈现', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-wc-suspension-'));
    runChapterChain = vi.fn();
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
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  function writeProjectYaml(): void {
    const doc = {
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市', '奇幻'] },
      world_setting: { premise: '灵气复苏的现代都市' },
      asset_cards: [],
      scene_graph: {
        nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }],
        edges: [],
        lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }],
      },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
    };
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
  }

  function pausedSummary(
    researchSuspension: NonNullable<RunSnapshotSummary['researchSuspension']>,
  ): RunSnapshotSummary {
    return { status: 'paused', pausedStage: 'draft', researchSuspension, errors: [] };
  }

  const CONTRADICTION_SUSPENSION = {
    kind: 'research_contradiction' as const,
    rounds: 1,
    evidence: {
      contradictions: [{ desc: '任务卡说林昭右臂伤，第 3 章正文是左臂', severity: 'contradiction' as const }],
      deviations: [
        { scene_ref: 's_gate', plan_says: '对峙不接触', brief_says: '正面交锋', reason: '情绪弧需要落点' },
      ],
    },
  };

  const EXHAUSTED_SUSPENSION = {
    kind: 'verify_exhausted' as const,
    rounds: 3,
    gaps: [{ desc: '未核查配角王五的行踪', source_hint: 'query_story 搜「王五」' }],
  };

  // ════════════════════════════════════════════════════════════════════════
  // 1. 挂起文案 + metadata（deliverable 2：工具结果文案即上报通道）
  // ════════════════════════════════════════════════════════════════════════

  it('research_contradiction：文案含挂起头 + 矛盾/偏离明细 + 三决断动作；metadata resumeOptions 无 continue + 载荷', async () => {
    writeProjectYaml();
    runChapterChain.mockResolvedValue(pausedSummary(CONTRADICTION_SUSPENSION));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城', tone: '紧张' }, chapterId: 'ch_1' },
      ctx,
    );

    // 挂起头 + 明细（矛盾 desc / 偏离 对照——leader 可读，呈作者决断）。
    expect(result.output).toContain('本章挂起');
    expect(result.output).toContain('任务卡与资料矛盾'); // 头行说人话（research_contradiction 族）
    expect(result.output).toContain('任务卡说林昭右臂伤，第 3 章正文是左臂');
    expect(result.output).toContain('s_gate');
    expect(result.output).toContain('正面交锋');
    // 建议动作三决断 + 恢复 = 重写（redo）非续写。
    expect(result.output).toContain('改任务卡');
    expect(result.output).toContain('改设定');
    expect(result.output).toContain('维持原案');
    expect(result.output).toContain('不可直接续写');
    expect(result.output).not.toContain('继续写（continue）'); // 通用 pause 文案不出现（continue 对挂起非法）

    // metadata：chapter_review + 挂起载荷 + resumeOptions=['redo','abort']（无 continue）。
    expect(result.metadata?.type).toBe('chapter_review');
    expect(result.metadata?.stage).toBe('draft');
    expect(result.metadata?.researchSuspension).toEqual(CONTRADICTION_SUSPENSION);
    expect(result.metadata?.resumeOptions).toEqual(['redo', 'abort']);
    expect(result.metadata?.type).not.toBe('field_patch');
  });

  it('verify_exhausted：缺漏清单明细入文案（三轮未过形态）', async () => {
    writeProjectYaml();
    runChapterChain.mockResolvedValue(pausedSummary(EXHAUSTED_SUSPENSION));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(result.output).toContain('本章挂起');
    expect(result.output).toContain('3 轮仍未通过');
    expect(result.output).toContain('未核查配角王五的行踪');
    expect(result.output).toContain('query_story 搜「王五」');
    expect(result.metadata?.resumeOptions).toEqual(['redo', 'abort']);
  });

  it('普通 paused（无挂起载荷）→ 通用 pause 文案 + resumeOptions 三档（零回归）', async () => {
    writeProjectYaml();
    runChapterChain.mockResolvedValue({ status: 'paused', pausedStage: 'draft', draftContent: '正文', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(result.output).toContain('checkpoint 暂停');
    expect(result.output).toContain('继续写（continue）');
    expect(result.metadata?.resumeOptions).toEqual(['continue', 'redo', 'abort']);
    expect(result.metadata?.researchSuspension).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════════════
  // 2. 批量挂起标记（deliverable 4：挂起章进 batch 状态，批量继续他章）
  // ════════════════════════════════════════════════════════════════════════

  async function writeRunningBatch(suspendedSceneIds?: string[]): Promise<void> {
    const { saveBatchRuns } = await import('../src/tool/batch-state');
    saveBatchRuns(projectPath, [
      {
        batchId: 'b-1',
        createdAt: Date.now(),
        lineTag: 'main',
        orderedSceneIds: ['s1', 's2', 's3'],
        doneSceneIds: [],
        ...(suspendedSceneIds ? { suspendedSceneIds } : {}),
        gear: 'smart' as const,
        status: 'running' as const,
        chapterMap: { s1: 'ch_1', s2: 'ch_1', s3: 'ch_2' },
        sessionId: ctx.sessionId,
      },
    ]);
  }

  function readBatch(): { suspendedSceneIds?: string[] } {
    return JSON.parse(readFileSync(path.join(projectPath, '.orison', 'batches.json'), 'utf-8'))[0];
  }

  it('活跃批量 + 挂起章（chapterId 命中 chapterMap）→ 该章全部场标 suspendedSceneIds + 文案行', async () => {
    writeProjectYaml();
    await writeRunningBatch();
    runChapterChain.mockResolvedValue(pausedSummary(CONTRADICTION_SUSPENSION));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' }, chapterId: 'ch_1' },
      ctx,
    );

    // ch_1 的两场（s1/s2）标挂起；他章场（s3）不动。
    expect(readBatch().suspendedSceneIds).toEqual(['s1', 's2']);
    expect(result.output).toContain('批量标记');
    expect(result.output).toContain('批量继续其他章');
  });

  it('幂等：重复挂起同一章不重复写（batches.json 不变）', async () => {
    writeProjectYaml();
    await writeRunningBatch(['s1', 's2']);
    runChapterChain.mockResolvedValue(pausedSummary(CONTRADICTION_SUSPENSION));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' }, chapterId: 'ch_1' },
      ctx,
    );

    expect(readBatch().suspendedSceneIds).toEqual(['s1', 's2']); // 无重复
    expect(result.output).not.toContain('批量标记'); // 已标 → 零痕迹（不添行）
  });

  it('无活跃批量（单章直写）→ 零标记零文案（挂起呈现照常）', async () => {
    writeProjectYaml(); // 无 batches.json
    runChapterChain.mockResolvedValue(pausedSummary(CONTRADICTION_SUSPENSION));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' }, chapterId: 'ch_1' },
      ctx,
    );

    expect(result.output).toContain('本章挂起'); // 呈现照常
    expect(result.output).not.toContain('批量标记');
  });

  it('挂起章不在批量 chapterMap（chapterId 未命中）→ 零标记（不误标他章）', async () => {
    writeProjectYaml();
    await writeRunningBatch();
    runChapterChain.mockResolvedValue(pausedSummary(CONTRADICTION_SUSPENSION));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' }, chapterId: 'ch_9' }, // 不在批量内
      ctx,
    );

    expect(readBatch().suspendedSceneIds).toBeUndefined();
  });
});
