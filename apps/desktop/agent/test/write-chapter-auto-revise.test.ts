import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// Story 7.4 Step 5：auto_revise leader 驱动 redo 闭环集成测试（design §1.3 候选④）。
//
// 验 writeChapterTool.execute 新增 auto_revise 循环：
// a) auto mode + auto_revise → dispatchRevisionOptimizer 编译 intent + redo 闭环四节点（loopNodes）→ 再 accept 终态
// b) auto mode + auto_revise 持续 → cap=3 超限 → escalate（leader cap 兜底）
// c) auto mode + auto_revise + revision-optimizer 失败 → escalate（graceful 不假信心）
// d) accept_as_truth → 终态零回归（不触发 redo 循环）
// e) escalate_user → 终态零回归（不触发 redo 循环）
// f) non-auto mode（suggest/readonly）+ auto_revise → surface（不进 redo 循环，defer dogfood）
//
// mock skillExecutor.runChapterChain（控制 summary 返值）+ runAgentWithExplicitSystem（role-aware：
// director 返空 entries / revision-optimizer 返 intent JSON）。

vi.mock('../src/agent/session', () => ({
  getSession: vi.fn(),
  loadSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  loadSessionMeta: vi.fn(),
}));

import { getSession } from '../src/agent/session';

const mockedGetSession = vi.mocked(getSession);

function setSessionPermissionMode(mode: 'readonly' | 'suggest' | 'auto' | undefined): void {
  if (mode === undefined) {
    mockedGetSession.mockReturnValue(undefined);
    return;
  }
  mockedGetSession.mockReturnValue({ permissionMode: mode } as SessionState);
}

/** mock RevisionIntent（revision-optimizer 产，parseRevisionIntent 可解析的 JSON 串）。 */
const MOCK_INTENT_JSON = JSON.stringify({
  change: { summary: '补强主角动机（据 Reader-Audit finding）' },
  lockedItems: [],
  rationale: { source: 'audit-finding', note: 'auto_revise route decision' },
  provenance: {
    rawUserInstruction: '据 Reader-Audit 审核发现修订本章明确缺陷',
    compilerNote: 'A-trigger auto_revise',
  },
});

const FINDINGS = [
  {
    severity: 'warn',
    quote: '主角突然决定进城',
    location: '句3',
    explanation: '前文未铺垫进城动机',
  },
];

describe('write_chapter tool Story 7.4 auto_revise leader redo 闭环', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let revisionOptimizerContent: string;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-autorevise-'));
    runChapterChain = vi.fn();
    revisionOptimizerContent = MOCK_INTENT_JSON; // 默认返合法 intent；test c 覆写
    // role-aware mock：director 空 entries / revision-optimizer 读 revisionOptimizerContent 变量。
    runAgentWithExplicitSystem = vi.fn(async (_sid: string, role: string) => {
      if (role === 'director-agent') {
        return { content: JSON.stringify({ infoRelease: [], emotion: { points: [] }, atomicEdits: null }) };
      }
      if (role === 'revision-optimizer-agent') {
        return { content: revisionOptimizerContent };
      }
      return { content: '{}' };
    });
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn(), runAgentWithExplicitSystem },
    };
    mockedGetSession.mockReset();
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
    vi.resetModules();
  });

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

  /** auto_revise_pending summary factory（fresh object per call——防 test 间 mutation 泄漏，mirror SUMMARY_ACCEPT/ESCALATE）。 */
  function makeAutoReviseSummary(): RunSnapshotSummary {
    return {
      status: 'auto_revise_pending',
      routeDecision: { decision: 'auto_revise', reason: '明确缺陷需修订' },
      draftText: '正文内容',
      autoReviseFindings: FINDINGS,
      errors: [],
    };
  }

  /** fresh summary factory（writeChapterTool 可能 mutate summary.routeDecision on cap-exceeded → shared const 被
   *  污染致后继 test 假阳；factory 返 fresh object 每次）。 */
  function makeAcceptSummary(): RunSnapshotSummary {
    return {
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '修订后达标' },
      errors: [],
    };
  }

  function makeEscalateSummary(): RunSnapshotSummary {
    return {
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: '灰区难断' },
      errors: [],
    };
  }

  /** count revision-optimizer-agent calls only（排除 retrieval/director）。 */
  function countRevisionOptimizerCalls(): number {
    return runAgentWithExplicitSystem.mock.calls.filter((c) => c[1] === 'revision-optimizer-agent').length;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // a) auto mode + auto_revise → dispatchRevisionOptimizer + redo 四节点 → accept
  // ════════════════════════════════════════════════════════════════════════════

  it('auto mode + auto_revise → revision-optimizer 编译 intent + redo 四节点 loopNodes → 第二次 accept 终态', async () => {
    writeReadyProject();
    setSessionPermissionMode('auto');
    // 首次 chain 返 auto_revise_pending；redo 后返 accept。
    runChapterChain
      .mockResolvedValueOnce(makeAutoReviseSummary())
      .mockResolvedValueOnce(makeAcceptSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // runChapterChain 被调 2 次（首次 auto_revise + redo accept）
    expect(runChapterChain).toHaveBeenCalledTimes(2);

    // revision-optimizer 被调 1 次（A-trigger，role='revision-optimizer-agent'）
    expect(countRevisionOptimizerCalls()).toBe(1);
    const optimizerCall = runAgentWithExplicitSystem.mock.calls.find((c) => c[1] === 'revision-optimizer-agent');
    expect(optimizerCall).toBeDefined();
    // allowedTools=['query_story']（D1-c 反向约束）
    expect(optimizerCall![3]).toMatchObject({ allowedTools: ['query_story'] });

    // 第二次调用（redo）含 loopNodes 四节点 + revisionIntent + resume
    const redoOptions = runChapterChain.mock.calls[1][2] as {
      resume?: { fromSnapshot?: boolean };
      redo?: { nodeId: string; revisionIntent?: unknown; loopNodes?: string[] };
    };
    expect(redoOptions.resume).toEqual({ fromSnapshot: true });
    expect(redoOptions.redo).toBeDefined();
    expect(redoOptions.redo!.nodeId).toBe('draft-writer-agent');
    expect(redoOptions.redo!.loopNodes).toEqual([
      'draft-writer-agent',
      'revision-guard-agent',
      'multi-review-agent',
      'route-agent',
    ]);
    expect(redoOptions.redo!.revisionIntent).toBeDefined();

    // 最终 summary 是 accept（redo 后终态）
    const metadata = result.metadata as { summary?: RunSnapshotSummary };
    expect(metadata.summary?.routeDecision?.decision).toBe('accept_as_truth');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // b) auto mode + auto_revise 持续 → cap=3 超限 → escalate
  // ════════════════════════════════════════════════════════════════════════════

  it('auto mode + auto_revise 持续 → leader cap=3 超限 → 强制 escalate', async () => {
    writeReadyProject();
    setSessionPermissionMode('auto');
    // 每次都返 auto_revise_pending（持续不收敛）
    runChapterChain.mockResolvedValue(makeAutoReviseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // runChapterChain 被调 4 次（首次 + 3 次 redo = cap=3），第 4 次后 cap 超限 escalate
    expect(runChapterChain).toHaveBeenCalledTimes(4);
    // revision-optimizer 被调 3 次（3 次 redo 各编译一次 intent）
    expect(countRevisionOptimizerCalls()).toBe(3);

    // 最终 routeDecision 被 leader 覆写为 escalate_user（cap 超限）
    const metadata = result.metadata as { summary?: RunSnapshotSummary };
    expect(metadata.summary?.routeDecision?.decision).toBe('escalate_user');
    expect(metadata.summary?.routeDecision?.reason).toContain('cap');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // b2) BMad CR-008：auto mode + auto_revise 但 autoReviseFindings 空 → escalate（不编译无意义 intent）
  // ════════════════════════════════════════════════════════════════════════════

  it('BMad CR-008：auto_revise 但 autoReviseFindings undefined → 强制 escalate（不编译无意义 intent）', async () => {
    writeReadyProject();
    setSessionPermissionMode('auto');
    // auto_revise_pending 但 autoReviseFindings 缺省（undefined）——模拟 review 全 info finding（无 block/warn）。
    runChapterChain.mockResolvedValueOnce({
      status: 'auto_revise_pending',
      routeDecision: { decision: 'auto_revise', reason: '明确缺陷' },
      draftText: '正文',
      // autoReviseFindings 缺省（route 误判：无 block/warn finding 不该 auto_revise）。
      errors: [],
    } as RunSnapshotSummary);

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 不编译 intent（revision-optimizer 不调），无 redo（runChapterChain 只调 1 次）。
    expect(countRevisionOptimizerCalls()).toBe(0);
    expect(runChapterChain).toHaveBeenCalledTimes(1);

    // 强制 escalate（route 判分存疑，人裁决）。
    const metadata = result.metadata as { summary?: RunSnapshotSummary };
    expect(metadata.summary?.routeDecision?.decision).toBe('escalate_user');
    expect(metadata.summary?.routeDecision?.reason).toContain('block/warn');
  });

  it('BMad CR-008：auto_revise 但 autoReviseFindings 空数组 [] → 强制 escalate', async () => {
    writeReadyProject();
    setSessionPermissionMode('auto');
    // auto_revise_pending 但 autoReviseFindings=[]（空数组，同 undefined 语义）。
    runChapterChain.mockResolvedValueOnce({
      status: 'auto_revise_pending',
      routeDecision: { decision: 'auto_revise', reason: '明确缺陷' },
      draftText: '正文',
      autoReviseFindings: [], // 空数组（review 全 info finding 抽后为空）
      errors: [],
    } as RunSnapshotSummary);

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(countRevisionOptimizerCalls()).toBe(0);
    expect(runChapterChain).toHaveBeenCalledTimes(1);

    const metadata = result.metadata as { summary?: RunSnapshotSummary };
    expect(metadata.summary?.routeDecision?.decision).toBe('escalate_user');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // c) auto mode + auto_revise + revision-optimizer 失败 → escalate（graceful 不假信心）
  // ════════════════════════════════════════════════════════════════════════════
  // c) auto mode + auto_revise + revision-optimizer 失败 → escalate（graceful 不假信心）
  // ════════════════════════════════════════════════════════════════════════════

  it('auto mode + auto_revise + revision-optimizer 返 null（parse 失败）→ graceful escalate', async () => {
    writeReadyProject();
    setSessionPermissionMode('auto');
    runChapterChain.mockResolvedValueOnce(makeAutoReviseSummary());
    // revision-optimizer 返非 JSON（parseRevisionIntent 返 null → dispatchRevisionOptimizer 返 null）
    revisionOptimizerContent = 'not valid json';

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // runChapterChain 只调 1 次（无 redo——intent 编译失败不进 redo 循环）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(countRevisionOptimizerCalls()).toBe(1);

    // escalate（revision-optimizer 编译失败）
    const metadata = result.metadata as { summary?: RunSnapshotSummary };
    expect(metadata.summary?.routeDecision?.decision).toBe('escalate_user');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // d) accept_as_truth → 终态零回归（不触发 redo 循环）
  // ════════════════════════════════════════════════════════════════════════════

  it('accept_as_truth → 终态零回归（不触发 redo 循环 / 不调 revision-optimizer）', async () => {
    writeReadyProject();
    setSessionPermissionMode('auto');
    runChapterChain.mockResolvedValue(makeAcceptSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(countRevisionOptimizerCalls()).toBe(0);

    const metadata = result.metadata as { summary?: RunSnapshotSummary };
    expect(metadata.summary?.routeDecision?.decision).toBe('accept_as_truth');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // e) escalate_user → 终态零回归（不触发 redo 循环）
  // ════════════════════════════════════════════════════════════════════════════

  it('escalate_user → 终态零回归（不触发 auto_revise redo 循环）', async () => {
    writeReadyProject();
    setSessionPermissionMode('auto');
    runChapterChain.mockResolvedValue(makeEscalateSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(countRevisionOptimizerCalls()).toBe(0);

    const metadata = result.metadata as { summary?: RunSnapshotSummary };
    expect(metadata.summary?.routeDecision?.decision).toBe('escalate_user');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // f) non-auto mode + auto_revise → surface（不进 redo 循环）
  // ════════════════════════════════════════════════════════════════════════════

  it('suggest mode + auto_revise → surface findings（不进 redo 循环，RevisionIntent 人确认关 defer dogfood）', async () => {
    writeReadyProject();
    setSessionPermissionMode('suggest'); // escalateMode='ask' → non-auto
    runChapterChain.mockResolvedValue(makeAutoReviseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // non-auto → 不进 redo 循环（runChapterChain 只调 1 次 / revision-optimizer 不调）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(countRevisionOptimizerCalls()).toBe(0);

    // surface：output 含 auto_revise + findings 文案
    const outputText = typeof result.output === 'string' ? result.output : '';
    expect(outputText).toContain('auto_revise');
    expect(outputText).toContain('主角突然决定进城'); // finding quote 在文案中
  });
});
