import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// Story 6.3（design §3 段① / D1 / implement.md Step 5）：write_chapter Director 派发 + InfoReleaseMap 合入单测。
// mock skillExecutor.runAgentWithExplicitSystem（role-aware：director 返 entries JSON）+
// runChapterChain -> 验：
// (a) Director 产合法 entries -> initialArtifacts['info_release_map'] 合入（既有 entry 补 directive + 新场追加）；
// (b) Director 抛错 -> graceful（info_release_map 保持 assembled 原样，链段照跑）；
// (c) Director 返空 entries / 非 JSON -> info_release_map 不变；
// (d) skillExecutor 缺 runAgentWithExplicitSystem -> 不调 Director + 链段照跑；
// (e) allowedTools mode-conditional（CR-6：auto -> 含 info_release_map_update / non-auto -> 不含）；
// (f) vars 含 chapterScenes + existingInfoRelease + brief 意图 + autoApplyFlag；
// (g) P1 gate-before-director：brief 未就绪 -> 不派 Director（gate-first 防白烧 Director 算力）。
// (i) CR-4：Director 幻觉 sceneRef（不在 chapterScenes）被丢，不编进 initialArtifacts；
// (j) CR-6：auto mode -> Director autoApply（allowedTools 含写工具，不 surface field_patch）；
//            non-auto mode -> Director no tool-call（allowedTools 不含写工具，write_chapter surface field_patch）。
//
// mock 用 role-aware（director-agent -> entries JSON），断言按 role 过滤定位 Director 调用。
//
// CR-6（D8 mode-conditional autoApply）：mock getSession 控制 leader session.permissionMode（auto/suggest/readonly）->
// autoApplyFlag = (permissionMode === 'auto')。mirror write-chapter-autonomy.test.ts 的 getSession mock 模式。

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

describe('write_chapter tool Director 派发（Story 6.3）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-director-'));
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
    // CR-6：默认 suggest（non-auto）--既有测试 (a/b/c/d/f/g/h) 均跑 non-auto 路径（Director 不调写工具）。
    setSessionPermissionMode('suggest');
  });

  afterEach(() => {
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
    vi.resetModules();
  });

  // project 含 info_release_map（既有 s1 entry 无 directive）+ scene_graph（s1 + s2 两场均 ∈ ep1）。
  // Director 产 s1（既有->补 directive，保留 id/reveal）+ s2（新场->追加 director:s2）。
  function writeReadyProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: {
        nodes: [
          { id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor', outcomeType: '反转' },
          { id: 's2', episodeId: 'ep1', storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        ],
        edges: [],
        lines: [],
      },
      promise_registry: { promises: [], beats: [], version: 0 },
      info_release_map: {
        entries: [
          { id: 'ir1', sceneRef: 's1', episodeId: 'ep1', reveal: ['主角到达'] },
        ],
        version: 2,
      },
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

  const GOOD_DIRECTOR = {
    entries: [
      {
        sceneRef: 's1',
        directive: {
          mode: 'sustain_unknown',
          actions: ['withhold'],
          forbiddenMoves: ['主角提到那封密信'],
          target: '密信内容',
        },
      },
      {
        sceneRef: 's2',
        directive: {
          mode: 'reveal_first',
          actions: ['release'],
          target: '主角到达',
        },
      },
    ],
  };

  // role-aware mock：director-agent -> directorResponse（不干扰 Director 断言）。
  function mockSubAgents(directorResponse: string): void {
    runAgentWithExplicitSystem.mockImplementation((_sid, role) => {
      if (role === 'director-agent') return Promise.resolve({ content: directorResponse });
      return Promise.resolve({ content: '{}' });
    });
  }

  // role-aware mock：director-agent -> reject（测 Director graceful）。
  function mockSubAgentsDirectorError(err: Error): void {
    runAgentWithExplicitSystem.mockImplementation((_sid, role) => {
      if (role === 'director-agent') return Promise.reject(err);
      return Promise.resolve({ content: '{}' });
    });
  }

  /** 取 director-agent 调用的 args（[sessionId, role, vars, options]）。 */
  function directorCall(): unknown[] {
    const call = runAgentWithExplicitSystem.mock.calls.find((c) => c[1] === 'director-agent');
    if (!call) throw new Error('director-agent 未被调用');
    return call;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // a. Director 返合法 entries -> initialArtifacts['info_release_map'] 合入
  // ════════════════════════════════════════════════════════════════════════════

  it('Director 返合法 entries -> 既有 s1 补 directive（保留 id/reveal）+ 新场 s2 追加（director:s2）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(directorCall()).toBeDefined();

    const [, artifacts] = runChapterChain.mock.calls[0];
    const map = artifacts['info_release_map'] as {
      entries: Array<{ id: string; sceneRef: string; episodeId?: string; reveal?: string[]; directive?: { mode: string; actions: string[] } }>;
      version: number;
    };
    expect(map.entries).toHaveLength(2);

    // s1：既有 entry 补 directive（id + reveal 保留）
    const s1 = map.entries.find((e) => e.sceneRef === 's1');
    expect(s1).toBeDefined();
    expect(s1!.id).toBe('ir1'); // 保留既有 id
    expect(s1!.reveal).toEqual(['主角到达']); // 保留既有 reveal
    expect(s1!.directive).toBeDefined();
    expect(s1!.directive!.mode).toBe('sustain_unknown');
    expect(s1!.directive!.actions).toEqual(['withhold']);

    // s2：新场追加（id=director:s2，episodeId=ep1）
    const s2 = map.entries.find((e) => e.sceneRef === 's2');
    expect(s2).toBeDefined();
    expect(s2!.id).toBe('director:s2');
    expect(s2!.episodeId).toBe('ep1');
    expect(s2!.directive!.mode).toBe('reveal_first');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // b. Director 抛错 -> graceful（info_release_map 保持 assembled 原样，链段照跑）
  // ════════════════════════════════════════════════════════════════════════════

  it('Director 抛错 -> info_release_map 保持 assembled 原样（既有 s1 entry 无 directive）+ 链段仍调', async () => {
    writeReadyProject();
    mockSubAgentsDirectorError(new Error('director timeout'));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(directorCall()).toBeDefined();
    expect(runChapterChain).toHaveBeenCalledTimes(1);

    // info_release_map 保持 assembled 原样：仅既有 s1（无 directive）
    const [, artifacts] = runChapterChain.mock.calls[0];
    const map = artifacts['info_release_map'] as {
      entries: Array<{ sceneRef: string; directive?: unknown }>;
    };
    expect(map.entries).toHaveLength(1);
    expect(map.entries[0].sceneRef).toBe('s1');
    expect(map.entries[0].directive).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // c. Director 返空 entries / 非 JSON -> info_release_map 不变
  // ════════════════════════════════════════════════════════════════════════════

  it('Director 返 {"entries":[]} -> info_release_map 保持 assembled 原样（无操控）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify({ entries: [] }));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const [, artifacts] = runChapterChain.mock.calls[0];
    const map = artifacts['info_release_map'] as { entries: unknown[] };
    expect(map.entries).toHaveLength(1); // 既有 s1，未合入新 directive
  });

  it('Director 返非 JSON -> info_release_map 保持 assembled 原样（graceful）', async () => {
    writeReadyProject();
    mockSubAgents('这不是 JSON，我无法产出指令。');
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const [, artifacts] = runChapterChain.mock.calls[0];
    const map = artifacts['info_release_map'] as { entries: unknown[] };
    expect(map.entries).toHaveLength(1); // 既有 s1
  });

  // ════════════════════════════════════════════════════════════════════════════
  // d. skillExecutor 缺 runAgentWithExplicitSystem -> graceful（兼容旧 mock / 无 runtime 路径）
  // ════════════════════════════════════════════════════════════════════════════

  it('skillExecutor 缺 runAgentWithExplicitSystem -> 不调 Director + 链段照跑', async () => {
    writeReadyProject();
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
    // info_release_map 保持 assembled 原样（既有 s1）
    const [, artifacts] = runChapterChain.mock.calls[0];
    const map = artifacts['info_release_map'] as { entries: unknown[] };
    expect(map.entries).toHaveLength(1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // e. CR-6：allowedTools mode-conditional（auto -> 含 info_release_map_update / non-auto -> 不含）
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-6 non-auto mode（suggest）-> allowedTools 不含 info_release_map_update（Director 无写工具）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('suggest');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const call = directorCall();
    const options = call[3] as { allowedTools?: string[] };
    // non-auto：Director 只读 perspective，无写工具（info_release_map_update 不在白名单--硬保证非仅 prompt 软约束）
    expect(options?.allowedTools).toEqual(['query_cognition', 'query_cognition_graph']);
    expect(options?.allowedTools).not.toContain('info_release_map_update');
  });

  it('CR-6 auto mode -> allowedTools 含 info_release_map_update（Director 持久化 autoApply=true）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('auto');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const call = directorCall();
    const options = call[3] as { allowedTools?: string[] };
    // auto：Director 读 perspective + 持久化 directives（info_release_map_update）+ emotion 目标点
    // （emotion_curve_update，Story 5.2），均 autoApply=true（DW-4 自动 authoring）。
    expect(options?.allowedTools).toEqual([
      'query_cognition',
      'query_cognition_graph',
      'info_release_map_update',
      'emotion_curve_update',
    ]);
  });

  it('CR-6 vars 含 autoApplyFlag（true for auto / false for non-auto）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR));
    runChapterChain.mockResolvedValue(SUMMARY_OK);

    // auto mode -> autoApplyFlag=true
    setSessionPermissionMode('auto');
    const { writeChapterTool } = await import('../src/tool/write-chapter');
    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );
    let vars = directorCall()[2] as Record<string, string>;
    expect(vars.autoApplyFlag).toBe('true');

    // non-auto mode -> autoApplyFlag=false
    runAgentWithExplicitSystem.mockClear();
    runChapterChain.mockClear();
    setSessionPermissionMode('suggest');
    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );
    vars = directorCall()[2] as Record<string, string>;
    expect(vars.autoApplyFlag).toBe('false');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // f. vars 渲染：chapterScenes + existingInfoRelease + brief 意图
  // ════════════════════════════════════════════════════════════════════════════

  it('vars 含 chapterScenes（本章 2 场 id+summary）+ existingInfoRelease（既有 entries）+ brief 意图', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      {
        episodeId: 'ep1',
        chapterBrief: {
          goal: '抵达 B 城',
          pov: '第一人称',
          tone: '紧张',
          doNotWrite: '勿提前揭露反派身份',
        },
      },
      ctx,
    );

    const call = directorCall();
    const vars = call[2] as Record<string, string>;
    expect(vars.episodeId).toBe('ep1');
    expect(vars.briefGoal).toBe('抵达 B 城');
    expect(vars.briefParams).toContain('第一人称');
    expect(vars.briefDoNotWrite).toBe('勿提前揭露反派身份');

    // chapterScenes：本章 2 场（s1 + s2），每场含 id + summary
    const scenes = JSON.parse(vars.chapterScenes) as Array<{ id: string; summary: string }>;
    expect(scenes).toHaveLength(2);
    expect(scenes.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    // s1 summary 含 outcome（反转）/role（core-anchor）
    const s1Scene = scenes.find((s) => s.id === 's1');
    expect(s1Scene!.summary).toContain('反转');
    expect(s1Scene!.summary).toContain('core-anchor');

    // existingInfoRelease：既有 1 entry（s1 + reveal）
    const existing = JSON.parse(vars.existingInfoRelease) as Array<{ sceneRef: string; reveal?: string[] }>;
    expect(existing).toHaveLength(1);
    expect(existing[0].sceneRef).toBe('s1');
    expect(existing[0].reveal).toEqual(['主角到达']);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // g. P1 gate-before-director：brief 未就绪 -> 不派 Director + 不跑链段
  // ════════════════════════════════════════════════════════════════════════════

  it('P1 gate-before-director：brief 未就绪（缺 goal）-> 不派 Director + 不跑链段', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    // chapterBrief 缺 goal（其余 ready：scene_graph 2 nodes + settings 渲染非空）-> needs_world_context
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { tone: '紧张' } },
      ctx,
    );

    // 两个子 agent 都不被调（gate 在前，brief 未就绪不派--免烧算力）
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
    // 链段不跑
    expect(runChapterChain).not.toHaveBeenCalled();
    // 返 gate 错误文案
    expect(result.output).toContain('needs_world_context');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // i. CR-4：Director 幻觉 sceneRef（不在 chapterScenes）被丢，不编进 initialArtifacts
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-4：Director 产幻觉 sceneRef（不在本章场景集）-> 被丢，不编进 initialArtifacts.info_release_map', async () => {
    writeReadyProject();
    // Director 产 s1（合法）+ s_hallucinated（幻觉，不在 scene_graph）
    const directorWithHallucination = {
      entries: [
        {
          sceneRef: 's1',
          directive: { mode: 'sustain_unknown', actions: ['withhold'], target: '合法场' },
        },
        {
          sceneRef: 's_hallucinated',
          directive: { mode: 'reveal_first', actions: ['release'], target: '幻觉场' },
        },
      ],
    };
    mockSubAgents(JSON.stringify(directorWithHallucination));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const [, artifacts] = runChapterChain.mock.calls[0];
    const map = artifacts['info_release_map'] as {
      entries: Array<{ id: string; sceneRef: string; directive?: { target?: string } }>;
    };
    // 幻觉 sceneRef 被丢：只剩既有 s1（补 directive）+ Director 产的 s1（合法）。s_hallucinated 不在。
    expect(map.entries.find((e) => e.sceneRef === 's_hallucinated')).toBeUndefined();
    // s1 合法 -> 补 directive（target=合法场）
    const s1 = map.entries.find((e) => e.sceneRef === 's1');
    expect(s1).toBeDefined();
    expect(s1!.directive).toBeDefined();
    expect(s1!.directive!.target).toBe('合法场');
  });

  it('CR-4：Director 全幻觉 sceneRef（无合法场）-> info_release_map 保持 assembled 原样（无 entry 合入）', async () => {
    writeReadyProject();
    const allHallucination = {
      entries: [
        {
          sceneRef: 's_nonexistent_1',
          directive: { mode: 'reveal_first', actions: ['release'], target: '幻觉 1' },
        },
        {
          sceneRef: 's_nonexistent_2',
          directive: { mode: 'sustain_unknown', actions: ['withhold'], target: '幻觉 2' },
        },
      ],
    };
    mockSubAgents(JSON.stringify(allHallucination));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const [, artifacts] = runChapterChain.mock.calls[0];
    const map = artifacts['info_release_map'] as { entries: Array<{ sceneRef: string; directive?: unknown }> };
    // 全幻觉 -> 无 entry 合入 -> 保持 assembled 原样（仅既有 s1 无 directive）
    expect(map.entries).toHaveLength(1);
    expect(map.entries[0].sceneRef).toBe('s1');
    expect(map.entries[0].directive).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // j. CR-6：non-auto mode -> write_chapter surface field_patch metadata（info_release_map）
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-6 non-auto mode -> write_chapter surface metadata.infoReleasePatch（field_patch for PatchReview）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('suggest');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // non-auto mode + Director 产 mergedMap -> surface info_release_map field_patch 供 PatchReview 人审
    const metadata = result.metadata as { infoReleasePatch?: { type: string; field: string; action: string; data: { entries: unknown[] } } };
    expect(metadata.infoReleasePatch).toBeDefined();
    expect(metadata.infoReleasePatch!.type).toBe('field_patch');
    expect(metadata.infoReleasePatch!.field).toBe('info_release_map');
    expect(metadata.infoReleasePatch!.action).toBe('set');
    // mergedMap 含既有 s1（补 directive）+ s2（新场追加）= 2 entries
    expect(metadata.infoReleasePatch!.data.entries).toHaveLength(2);
    // 文案告知用户审阅落盘
    expect(result.output).toContain('信息释放计划');
  });

  it('CR-6 auto mode -> write_chapter 不 surface infoReleasePatch（Director 已持久化 via tool）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('auto');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // auto mode：Director 持久化 via info_release_map_update(autoApply=true) -> write_chapter 不 surface field_patch
    const metadata = result.metadata as { infoReleasePatch?: unknown };
    expect(metadata.infoReleasePatch).toBeUndefined();
  });

  it('CR-6 non-auto mode + Director 返空 entries -> 不 surface infoReleasePatch（无 Director 产出）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify({ entries: [] }));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('suggest');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // Director 返空 -> mergedMap=null -> 不 surface infoReleasePatch
    const metadata = result.metadata as { infoReleasePatch?: unknown };
    expect(metadata.infoReleasePatch).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Story 5.2 emotion 段：Director 产 emotionPoints + emotionTarget -> initialArtifacts 合入
  // ════════════════════════════════════════════════════════════════════════════

  const GOOD_DIRECTOR_WITH_EMOTION = {
    entries: GOOD_DIRECTOR.entries,
    emotionPoints: [
      {
        refId: 's1',
        sceneMood: '压抑',
        characters: [{ characterId: 'char-1', emotion: '恐惧', emotionEnd: '决心', vad: { v: -0.7, a: 0.8, d: -0.3 } }],
      },
      {
        refId: 's2',
        sceneMood: '紧张',
        characters: [{ characterId: 'char-1', emotion: '焦虑' }],
      },
    ],
    emotionTarget: { emotion: '恐惧', emotionEnd: '决心', steer: '先压抑后爆发，恐惧感层层递进' },
  };

  it('5.2：Director 返 emotionPoints + emotionTarget -> initialArtifacts["emotion_curve"] 合入 + director_emotion_target 注入', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR_WITH_EMOTION));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const [, artifacts] = runChapterChain.mock.calls[0];
    // emotion_curve 合入：2 个 per-scene point（s1 + s2）。
    const curve = artifacts['emotion_curve'] as { points: Array<{ refId: string; characters: Array<{ emotion: string }> }> };
    expect(curve.points).toHaveLength(2);
    expect(curve.points.find((p) => p.refId === 's1')!.characters[0].emotion).toBe('恐惧');
    // director_emotion_target 章级目标注入（供 brief-compiler compileEmotionTarget）。
    const target = artifacts['director_emotion_target'] as { emotion?: string; steer?: string };
    expect(target.emotion).toBe('恐惧');
    expect(target.steer).toBe('先压抑后爆发，恐惧感层层递进');
  });

  it('5.2：Director emotion 幻觉 refId（不在 chapterScenes）被丢，不编进 emotion_curve', async () => {
    writeReadyProject();
    const directorWithHallucination = {
      entries: [],
      emotionPoints: [
        { refId: 's1', characters: [{ characterId: 'char-1', emotion: '恐惧' }] }, // 命中
        { refId: 's_hallucinated', characters: [{ characterId: 'char-1', emotion: '愤怒' }] }, // 幻觉
      ],
      emotionTarget: { emotion: '恐惧' },
    };
    mockSubAgents(JSON.stringify(directorWithHallucination));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    const [, artifacts] = runChapterChain.mock.calls[0];
    const curve = artifacts['emotion_curve'] as { points: Array<{ refId: string }> };
    expect(curve.points).toHaveLength(1);
    expect(curve.points[0].refId).toBe('s1'); // 幻觉 s_hallucinated 被丢
  });

  it('5.2 non-auto：Director emotion 段 -> emotionCurvePatch metadata surfaced（人审落盘）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR_WITH_EMOTION));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('suggest'); // non-auto
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    const metadata = result.metadata as { emotionCurvePatch?: { field: string; action: string; data: { points: unknown[] } } };
    expect(metadata.emotionCurvePatch).toBeDefined();
    expect(metadata.emotionCurvePatch!.field).toBe('emotion_curve');
    expect(metadata.emotionCurvePatch!.action).toBe('set');
    expect(metadata.emotionCurvePatch!.data.points).toHaveLength(2);
  });

  it('5.2 auto：Director 已持久化 via emotion_curve_update -> 不 surface emotionCurvePatch', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR_WITH_EMOTION));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('auto'); // auto mode
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    // auto mode Director 调 emotion_curve_update(autoApply=true) 持久化，write_chapter 不 surface field_patch。
    const metadata = result.metadata as { emotionCurvePatch?: unknown };
    expect(metadata.emotionCurvePatch).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Story 7.3：Director 返 atomicEditProposals（结构编辑提议）-> parse/expand/validate 不崩链段
  // 🔑 现 auditFindings ledger 未接（cross-chapter 持久化 defer），Director 实际不产 proposals。
  // 此处直接 mock Director 输出含 atomicEditProposals，验 parse/expand/validate 管道建通 + graceful：
  // (j) Director 返合法 atomicEditProposals -> 链段照跑（completion 不被结构编辑提议打断）；
  // (k) Director 返幻觉 sceneId（不在场景集）的 proposal -> 该 proposal 被丢（mirror CR-inforelease-steer-4）；
  // (l) Director 返全空 atomicEditProposals / 无该段 -> 照常（atomic-edit 段 null，链段照跑）。
  // 落地（apply graph patch）defer 7.4；7.3 只验管道 + graceful。
  // ════════════════════════════════════════════════════════════════════════════

  const GOOD_DIRECTOR_WITH_ATOMIC = {
    entries: [],
    emotionPoints: [],
    emotionTarget: { emotion: '期待' },
    atomicEditProposals: [
      {
        // add_suspense：s1→s2（两场都在 ep1 场景集），合法锚。
        op: { op: 'add_suspense', atSceneId: 's1', resolveTowardsSceneId: 's2' },
        sourceIssueRef: 'no-suspense',
        rationale: '中段太平需悬念钩子',
      },
    ],
  };

  it('7.3 (j)：Director 返合法 atomicEditProposals -> 链段照跑（completion 不被打断）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR_WITH_ATOMIC));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    setSessionPermissionMode('suggest');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(directorCall()).toBeDefined();
    // 链段正常完成（atomic-edit 提议不阻断链段，落地 defer 7.4）。
    expect(result.metadata).toBeDefined();
  });

  it('7.3 (k)：Director 返幻觉 sceneId 的 proposal -> 该 proposal 被丢，链段照跑', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify({
      ...GOOD_DIRECTOR_WITH_ATOMIC,
      atomicEditProposals: [
        // s99 不在场景集（幻觉）-> 被丢。
        { op: { op: 'add_suspense', atSceneId: 's99', resolveTowardsSceneId: 's2' }, rationale: '幻觉' },
        // s1→s2 合法 -> 保留。
        { op: { op: 'add_suspense', atSceneId: 's1', resolveTowardsSceneId: 's2' }, rationale: '合法' },
      ],
    }));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    // 幻觉 proposal 被丢，链段照跑不崩（graceful，mirror CR-inforelease-steer-4）。
    expect(result.metadata).toBeDefined();
    expect(directorCall()).toBeDefined();
  });

  it('7.3 (l)：Director 无 atomicEditProposals 段 / 空数组 -> 照常（atomic-edit 段 null）', async () => {
    writeReadyProject();
    mockSubAgents(JSON.stringify(GOOD_DIRECTOR)); // 无 atomicEditProposals 段
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    // 无 atomic-edit 提议 -> 照常，链段完成。
    expect(result.metadata).toBeDefined();
  });
});
