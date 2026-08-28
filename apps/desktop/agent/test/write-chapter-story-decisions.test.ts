import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.6：write_chapter Director 决策登记段接线单测（mirror write-chapter-director.test.ts
// harness + write-chapter-atomic-edit.test.ts 的 mock tool 注册模式）。
// mock skillExecutor.runAgentWithExplicitSystem（role-aware）+ registry story_decisions_update
// （mock 落盘 / field_patch envelope）+ runChapterChain -> 验：
// (a) non-auto mode + Director 产 storyDecisions → story_decisions_update(autoApply=false) 被调
//     + metadata.storyDecisionsPatch surface（PatchReview 人审）；
// (b) auto mode → autoApply=true 被调 + applied 响应消费 + 不 surface patch；
// (c) Director 无 storyDecisions → 工具不调（零回归）；
// (d) 工具未注册（registry 无）→ graceful skip，链照跑；
// (e) Director vars 含 existingDecisions（既有决策投影，idempotent 参考）；
// (f) 既有 id 被 parse 过滤（Director 重复登记不进 actions）。
// ─────────────────────────────────────────────────────────────────────────────

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

describe('write_chapter Director 决策登记段（Story 2.6）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-story-decisions-'));
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

  function writeReadyProject(existingDecisions?: unknown[]): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻' },
      world_setting: { premise: '灵气复苏都市' },
      scene_graph: {
        nodes: [
          { id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor' },
        ],
        edges: [],
        lines: [],
      },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
      ...(existingDecisions ? { novel: { chapters: [], story_decisions: existingDecisions } } : {}),
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

  const DIRECTOR_WITH_DECISIONS = {
    entries: [],
    emotionPoints: [],
    emotionTarget: { emotion: '期待' },
    atomicEditProposals: [],
    storyDecisions: [
      {
        id: 'director-betrayal-arc',
        summary: '女主第 5 章起真背叛主角团',
        reason: '妹妹被挟持，背叛被迫且有底层动机',
        risk: '铺垫不足则读者恨她弃书',
        status: 'decided',
        landingState: '第 5 章起对主角团态度转冷',
        source: 'user', // 故意自报 user——parse 层强制 director
      },
    ],
  };

  function mockSubAgents(directorResponse: unknown): void {
    runAgentWithExplicitSystem.mockImplementation((_sid, role) => {
      if (role === 'director-agent') return Promise.resolve({ content: JSON.stringify(directorResponse) });
      return Promise.resolve({ content: '{}' });
    });
  }

  /** 动态注册 mock story_decisions_update tool（mirror atomic-edit test 注册模式）。 */
  async function registerStoryDecisionsUpdateTool(): Promise<ReturnType<typeof vi.fn>> {
    const { registry } = await import('../src/tool/registry');
    const execute = vi.fn().mockImplementation(async (params: { autoApply?: boolean; actions?: unknown[] }) => {
      if (params.autoApply) {
        return { title: 'story_decisions_update: mock', output: '已落盘', metadata: { ok: true, applied: true, actionCount: params.actions?.length ?? 0 } };
      }
      return {
        title: 'story_decisions_update: mock',
        output: '已准备',
        metadata: { type: 'field_patch', field: 'story_decisions', action: 'set', data: { actions: params.actions } },
      };
    });
    registry.register({ id: 'story_decisions_update', description: 'mock for test', parameters: z.object({}), execute });
    return execute;
  }

  function directorVars(): Record<string, string> {
    const call = runAgentWithExplicitSystem.mock.calls.find((c) => c[1] === 'director-agent');
    if (!call) throw new Error('director-agent 未被调用');
    return call[2] as Record<string, string>;
  }

  it('(a) non-auto：story_decisions_update(autoApply=false) 被调 + source 强制 director + metadata.storyDecisionsPatch surface', async () => {
    writeReadyProject();
    mockSubAgents(DIRECTOR_WITH_DECISIONS);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const execute = await registerStoryDecisionsUpdateTool();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const res = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    expect(execute).toHaveBeenCalledTimes(1);
    const params = execute.mock.calls[0][0] as { autoApply?: boolean; actions: Array<{ op: string; decision: { source: string; id: string } }> };
    expect(params.autoApply).toBeFalsy();
    expect(params.actions).toHaveLength(1);
    expect(params.actions[0].op).toBe('register');
    expect(params.actions[0].decision.source).toBe('director'); // 信任边界：强制
    const patch = (res.metadata as Record<string, unknown>).storyDecisionsPatch as { field: string; data: { actions: unknown[] } };
    expect(patch).toBeDefined();
    expect(patch.field).toBe('story_decisions');
    expect(patch.data.actions).toHaveLength(1);
    expect(res.output).toContain('导演创作决策');
  });

  it('(b) auto：autoApply=true 被调 + applied 响应 + 不 surface patch', async () => {
    writeReadyProject();
    setSessionPermissionMode('auto');
    mockSubAgents(DIRECTOR_WITH_DECISIONS);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const execute = await registerStoryDecisionsUpdateTool();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const res = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    const params = execute.mock.calls[0][0] as { autoApply?: boolean };
    expect(params.autoApply).toBe(true);
    expect((res.metadata as Record<string, unknown>).storyDecisionsPatch).toBeUndefined();
  });

  it('(c) Director 无 storyDecisions → 工具不调（零回归）', async () => {
    writeReadyProject();
    mockSubAgents({ entries: [], emotionPoints: [], emotionTarget: { emotion: '平静' }, atomicEditProposals: [] });
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const execute = await registerStoryDecisionsUpdateTool();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const res = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);
    expect(execute).not.toHaveBeenCalled();
    expect((res.metadata as Record<string, unknown>).storyDecisionsPatch).toBeUndefined();
  });

  it('(d) 工具未注册 → graceful skip，链照跑不崩', async () => {
    writeReadyProject();
    mockSubAgents(DIRECTOR_WITH_DECISIONS);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    // 不注册 story_decisions_update。
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const res = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);
    expect(res.output).not.toContain('Chapter chain failed');
  });

  it('(e) Director vars 含 existingDecisions 投影（既有决策 idempotent 参考）', async () => {
    writeReadyProject([
      { id: 'director-betrayal-arc', summary: '既有同 id 决策', reason: 'r', risk: 'k', status: 'decided', source: 'director', createdAt: '2026-08-01T00:00:00Z' },
    ]);
    mockSubAgents(DIRECTOR_WITH_DECISIONS);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    await registerStoryDecisionsUpdateTool();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    const vars = directorVars();
    expect(vars.existingDecisions).toBeDefined();
    const existing = JSON.parse(vars.existingDecisions) as Array<{ id: string; status: string }>;
    expect(existing).toHaveLength(1);
    expect(existing[0].id).toBe('director-betrayal-arc');
  });

  it('(f) 既有 id 被 parse 过滤 → 工具收到的 actions 为空则不调（idempotent）', async () => {
    writeReadyProject([
      { id: 'director-betrayal-arc', summary: '既有同 id 决策', reason: 'r', risk: 'k', status: 'decided', source: 'director', createdAt: '2026-08-01T00:00:00Z' },
    ]);
    mockSubAgents(DIRECTOR_WITH_DECISIONS); // storyDecisions 只含同 id 一条 → 全被滤
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const execute = await registerStoryDecisionsUpdateTool();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const res = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);
    expect(execute).not.toHaveBeenCalled(); // 滤空 → 不落盘
    expect((res.metadata as Record<string, unknown>).storyDecisionsPatch).toBeUndefined();
  });

  it('(g) 守卫拒（handler 正常返回 ok:false 非 throw，CR-E01）→ 不静默吞：output 告知未落盘', async () => {
    writeReadyProject();
    mockSubAgents(DIRECTOR_WITH_DECISIONS);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    // 注册返 guard-rejection 的 mock（metadata 无 type/applied——两个消费 branch 都不进）。
    const { registry } = await import('../src/tool/registry');
    const execute = vi.fn().mockImplementation(async () => ({
      title: 'story_decisions_update: mock',
      output: "story_decisions_update rejected by guard: 决策 'x' 不允许 decided->decided。",
      metadata: { ok: false, applied: false },
    }));
    registry.register({ id: 'story_decisions_update', description: 'mock for test', parameters: z.object({}), execute });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const res = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    expect(execute).toHaveBeenCalledTimes(1);
    expect((res.metadata as Record<string, unknown>).storyDecisionsPatch).toBeUndefined();
    // decisionNote surface：决策 vanishing 无痕迹 = 反留痕目标本身。
    expect(res.output).toContain('导演创作决策登记未落盘');
    expect(res.output).toContain('rejected by guard');
  });

  it('(h) readonly 档（CR-E04）→ 不调工具不 stage envelope，output 文字建议', async () => {
    writeReadyProject();
    setSessionPermissionMode('readonly');
    mockSubAgents(DIRECTOR_WITH_DECISIONS);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const execute = await registerStoryDecisionsUpdateTool();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const res = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    // 程序化 execute 绕过 toolPolicy readonly 门 → 此处必须自守（mirror story-sync R6 文字降级）。
    expect(execute).not.toHaveBeenCalled();
    expect((res.metadata as Record<string, unknown>).storyDecisionsPatch).toBeUndefined();
    expect(res.output).toContain('readonly 档只呈现不落盘');
    expect(res.output).toContain('director-betrayal-arc'); // 文字建议含决策摘要（非黑盒丢弃）
  });

  it('(i) 裁决器 existingDecisions 排终态 + cap（CR-A02：superseded/dropped 不进，decided 8 + open 4）', async () => {
    // 9 decided + 5 open + 2 终态：decided 取 newest 8、open 取 newest 4、终态全不进。
    const seed: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 9; i++) {
      seed.push({ id: `dec-${i}`, summary: `决策 ${i}`, reason: 'r', risk: 'k', status: 'decided', source: 'director', createdAt: `2026-08-0${i + 1}T00:00:00Z` });
    }
    for (let i = 0; i < 5; i++) {
      seed.push({ id: `open-${i}`, summary: `悬置 ${i}`, reason: 'r', risk: 'k', status: 'open', source: 'director', createdAt: `2026-08-1${i}T00:00:00Z` });
    }
    seed.push({ id: 'sup-1', summary: '被取代', reason: 'r', risk: 'k', status: 'superseded', supersededBy: 'dec-0', source: 'director', createdAt: '2026-08-02T00:00:00Z' });
    seed.push({ id: 'drop-1', summary: '已放弃', reason: 'r', risk: 'k', status: 'dropped', source: 'director', createdAt: '2026-08-02T00:00:00Z' });
    writeReadyProject(seed);
    mockSubAgents(DIRECTOR_WITH_DECISIONS);
    // escalate_user 触发 dispatchAdjudicator。
    runChapterChain.mockResolvedValue({ ...SUMMARY_OK, routeDecision: { decision: 'escalate_user', reason: '灰区' } });
    await registerStoryDecisionsUpdateTool();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    const call = runAgentWithExplicitSystem.mock.calls.find((c) => c[1] === 'adjudicator-agent');
    expect(call).toBeDefined();
    const vars = call![2] as Record<string, string>;
    const existing = JSON.parse(vars.existingDecisions) as Array<{ id: string; status: string }>;
    expect(existing).toHaveLength(12); // 8 decided + 4 open
    expect(existing.filter((d) => d.status === 'decided')).toHaveLength(8);
    expect(existing.filter((d) => d.status === 'open')).toHaveLength(4);
    expect(existing.some((d) => d.id === 'sup-1' || d.id === 'drop-1')).toBe(false); // 终态不进
    expect(existing.some((d) => d.id === 'dec-0')).toBe(false); // decided newestFirst 取 8：dec-0 最旧被截
    expect(existing.some((d) => d.id === 'open-4')).toBe(true); // open 最新保留
  });
});
