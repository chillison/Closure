import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// Story 7.4 Step 2：write_chapter 读 cross-chapter feedback ledger 填 Director feedback var 单测。
// mirror write-chapter-director.test.ts 模式。mock：
// - skillExecutor.runAgentWithExplicitSystem（director 返 JSON）+ runChapterChain。
// - getSession（permissionMode → autoApplyFlag，默认 suggest non-auto）。
// - registry feedback_ledger_read tool（动态注册，返上一章三 artifact payload）。
// 验：
// (a) 上章 ledger 非空 → Director vars 三字段（auditFindings/emotionVerifyFeedback/completenessFeedback）非空 +
//     格式正确（auditFindings drop info / emotionVerifyFeedback 含 flags+adjustedSetpoints / completenessFeedback 含 suggestedFix）；
// (b) 第一章（episodeId index=0）→ 无上章 → 三 var 空串 + ledger read 不调（index 守卫早返，零回归）；
// (c) feedback_ledger_read 工具未注册（registry 空）→ 三 var 空串 + Director 照常被调（graceful，mirror fetchWorldPatchesViaTool）；
// (d) feedback_ledger_read 抛错 → 三 var 空串 + 链段照跑（graceful 不崩 chain）；
// (e) Director 消费非空 auditFindings → 产 atomicEditProposals + 链段照跑（7.3 管道激活，mirror 7.3 prd AC5）。
//
// registry 单例 + vi.resetModules：每测试动态 import registry（fresh instance）+ 注册 mock tool + 动态 import write-chapter
// （同 instance，mirror fetchWorldPatchesViaTool 测试模式）。

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

describe('write_chapter feedback ledger 读（Story 7.4 Step 2）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-feedback-'));
    runChapterChain = vi.fn();
    runAgentWithExplicitSystem = vi.fn();
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
    setSessionPermissionMode('suggest');
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
    vi.resetModules();
  });

  // 两 episode project（ep1 index 0 / ep2 index 1）+ scene_graph（s1/s2 ∈ ep2）。写 ep2 → 上章 = ep1。
  function writeTwoEpisodeProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: {
        nodes: [
          { id: 's1', episodeId: 'ep2', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor', outcomeType: '反转' },
          { id: 's2', episodeId: 'ep2', storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        ],
        edges: [],
        lines: [],
      },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [
        { id: 'ep1', index: 0, title: '开篇' },
        { id: 'ep2', index: 1, title: '第二章' },
      ],
    }), 'utf8');
  }

  // 单 episode project（ep1 index 0）+ scene_graph（s1 ∈ ep1）。写 ep1 = 第一章。
  function writeSingleEpisodeProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: {
        nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor' }],
        edges: [],
        lines: [],
      },
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

  // 上一章 ep1 三 artifact payload（非空，含 block/warn/info 混合 + flags + findings）。
  const PREV_EP1_ENTRIES = [
    {
      episodeId: 'ep1',
      artifactKey: 'review.latest',
      payload: {
        verdict: 'pass',
        summary: '上章通过',
        dimensions: [
          {
            name: 'narrative-feature',
            findings: [
              { severity: 'warn', quote: '中段太平无悬念', location: '段 3', explanation: '悬念不足', subClass: 'no-suspense' },
              { severity: 'info', quote: 'minor', location: '段 1', explanation: '小问题' }, // info 被 drop
            ],
          },
        ],
      },
      producedAt: '2026-08-12T00:00:00Z',
    },
    {
      episodeId: 'ep1',
      artifactKey: 'emotion_verify_result',
      payload: {
        flags: ['reader_topology_violation'],
        adjustedSetpoints: [{ characterId: 'char-1', setpoint: { v: 0.1, a: 0.2, d: 0.3 }, adjusted: true, fulfilledCount: 1, unfulfilledCount: 0, catharsisHit: false, reason: '兑现 payoff' }],
        degraded: false,
      },
      producedAt: '2026-08-12T00:00:00Z',
    },
    {
      episodeId: 'ep1',
      artifactKey: 'completeness_verify_result',
      payload: {
        findings: [
          { category: 'arc', verdict: 'under-developed', entityId: 'char-1', entityLabel: '主角弧', quote: '还没转折', location: '全章', explanation: '主角弧未推进', suggestedFix: '安排转折点' },
        ],
        summary: '上章完整性问题',
        degraded: false,
      },
      producedAt: '2026-08-12T00:00:00Z',
    },
  ];

  // role-aware mock：director-agent -> directorResponse。
  function mockSubAgents(directorResponse: string): void {
    runAgentWithExplicitSystem.mockImplementation((_sid, role) => {
      if (role === 'director-agent') return Promise.resolve({ content: directorResponse });
      return Promise.resolve({ content: '{}' });
    });
  }

  /** 取 director-agent 调用的 args（[sessionId, role, vars, options]）。 */
  function directorCall(): unknown[] {
    const call = runAgentWithExplicitSystem.mock.calls.find((c) => c[1] === 'director-agent');
    if (!call) throw new Error('director-agent 未被调用');
    return call;
  }

  /** 动态注册 mock feedback_ledger_read tool（返 entries）。mirror fetchWorldPatchesViaTool 测试模式。 */
  async function registerFeedbackReadTool(
    entries: unknown[],
  ): Promise<ReturnType<typeof vi.fn>> {
    const { registry } = await import('../src/tool/registry');
    const execute = vi.fn().mockResolvedValue({
      title: 'feedback_ledger_read: mock',
      output: 'mock',
      metadata: { ok: true, episodeId: 'ep1', count: entries.length, entries },
    });
    registry.register({
      id: 'feedback_ledger_read',
      description: 'mock for test',
      parameters: z.object({}),
      execute,
    });
    return execute;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // a. 上章 ledger 非空 → Director vars 三字段非空 + 格式正确
  // ════════════════════════════════════════════════════════════════════════════

  it('上章 ep1 ledger 非空 → Director vars 三字段非空 + 格式正确（auditFindings drop info / emotion 含 flags / completeness 含 suggestedFix）', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify({ entries: [], emotionPoints: [], emotionTarget: { emotion: '期待' } }));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const vars = directorCall()[2] as Record<string, string>;

    // auditFindings：含 warn finding（info 被 drop），非空 JSON 数组。
    expect(vars.auditFindings.length).toBeGreaterThan(0);
    const auditFindings = JSON.parse(vars.auditFindings) as Array<{ severity: string; subClass?: string; quote: string }>;
    expect(auditFindings).toHaveLength(1); // info 被 drop，只剩 warn
    expect(auditFindings[0].severity).toBe('warn');
    expect(auditFindings[0].subClass).toBe('no-suspense');
    expect(auditFindings[0].quote).toBe('中段太平无悬念');

    // emotionVerifyFeedback：含 flag + adjustedSetpoints + degraded。
    expect(vars.emotionVerifyFeedback.length).toBeGreaterThan(0);
    const emotionFb = JSON.parse(vars.emotionVerifyFeedback) as { flags: string[]; adjustedSetpoints: unknown[]; degraded: boolean };
    expect(emotionFb.flags).toContain('reader_topology_violation');
    expect(emotionFb.adjustedSetpoints).toHaveLength(1);
    expect(emotionFb.degraded).toBe(false);

    // completenessFeedback：含 finding（带 suggestedFix）。
    expect(vars.completenessFeedback.length).toBeGreaterThan(0);
    const completenessFb = JSON.parse(vars.completenessFeedback) as Array<{ suggestedFix: string; category: string }>;
    expect(completenessFb).toHaveLength(1);
    expect(completenessFb[0].suggestedFix).toBe('安排转折点');
    expect(completenessFb[0].category).toBe('arc');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // b. 第一章（episodeId index=0）→ 无上章 → 三 var 空串 + ledger read 不调
  // ════════════════════════════════════════════════════════════════════════════

  it('第一章 ep1（index=0）→ 无上章 → 三 var 空串 + ledger read 不调（index 守卫早返，零回归）', async () => {
    writeSingleEpisodeProject();
    mockSubAgents(JSON.stringify({ entries: [], emotionPoints: [], emotionTarget: { emotion: '期待' } }));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const readSpy = await registerFeedbackReadTool([]);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '开篇' } },
      ctx,
    );

    const vars = directorCall()[2] as Record<string, string>;
    expect(vars.auditFindings).toBe('');
    expect(vars.emotionVerifyFeedback).toBe('');
    expect(vars.completenessFeedback).toBe('');
    // 第一章 index=0 → resolvePrevEpisodeFeedback 早返 undefined（不调 ledger read tool）。
    expect(readSpy).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // c. feedback_ledger_read 未注册（registry 空）→ 三 var 空串 + Director 照常被调
  // ════════════════════════════════════════════════════════════════════════════

  it('feedback_ledger_read 未注册 → 三 var 空串 + Director 照常被调（graceful，mirror fetchWorldPatchesViaTool）', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify({ entries: [], emotionPoints: [], emotionTarget: { emotion: '期待' } }));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    // 不注册 feedback_ledger_read（registry 空）——同 fetchWorldPatchesViaTool 测试环境。
    await import('../src/tool/registry');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const vars = directorCall()[2] as Record<string, string>;
    expect(vars.auditFindings).toBe('');
    expect(vars.emotionVerifyFeedback).toBe('');
    expect(vars.completenessFeedback).toBe('');
    // Director 仍被调用（graceful 不阻断，三 var 空串 Director 照常规划）。
    expect(directorCall()).toBeDefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // d. feedback_ledger_read 抛错 → 三 var 空串 + 链段照跑（graceful 不崩 chain）
  // ════════════════════════════════════════════════════════════════════════════

  it('feedback_ledger_read 抛错 → 三 var 空串 + 链段照跑（graceful，不崩 chain）', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify({ entries: [], emotionPoints: [], emotionTarget: { emotion: '期待' } }));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    // 注册一个抛错的 read tool。
    const { registry } = await import('../src/tool/registry');
    registry.register({
      id: 'feedback_ledger_read',
      description: 'mock throwing',
      parameters: z.object({}),
      execute: async () => { throw new Error('IPC read failed'); },
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const vars = directorCall()[2] as Record<string, string>;
    expect(vars.auditFindings).toBe('');
    expect(vars.emotionVerifyFeedback).toBe('');
    expect(vars.completenessFeedback).toBe('');
    // 链段照跑（Director 仍被调 + runChapterChain 仍调）。
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // e. Director 消费非空 auditFindings → 产 atomicEditProposals + 链段照跑（7.3 管道激活）
  // ════════════════════════════════════════════════════════════════════════════

  it('Director 消费非空 auditFindings → 产 atomicEditProposals + 链段照跑（7.3 管道激活，mirror 7.3 prd AC5）', async () => {
    writeTwoEpisodeProject();
    // Director 收到非空 auditFindings（含 no-suspense）→ 产 atomicEditProposals（add_suspense s1→s2）。
    const directorWithAtomic = {
      entries: [],
      emotionPoints: [],
      emotionTarget: { emotion: '期待' },
      atomicEditProposals: [
        { op: { op: 'add_suspense', atSceneId: 's1', resolveTowardsSceneId: 's2' }, sourceIssueRef: 'no-suspense', rationale: '中段太平需悬念钩子' },
      ],
    };
    mockSubAgents(JSON.stringify(directorWithAtomic));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // Director 收到非空 auditFindings（Step 2 ledger 接通 → 上章 review block+warn findings 到达 Director）。
    const vars = directorCall()[2] as Record<string, string>;
    expect(vars.auditFindings.length).toBeGreaterThan(0);
    const auditFindings = JSON.parse(vars.auditFindings) as Array<{ subClass?: string }>;
    expect(auditFindings.some((f) => f.subClass === 'no-suspense')).toBe(true);
    // Director 产 atomicEditProposals → dispatch parse/expand/validate 管道走通（链段不崩）。
    expect(result.metadata).toBeDefined();
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });
});
