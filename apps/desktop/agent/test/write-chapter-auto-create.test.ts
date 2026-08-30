import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext, ToolResult } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// ════════════════════════════════════════════════════════════════════════════
// dogfood R2 #107 / R1.1：write_chapter no-chapter 链侧自动建章（首章冷启动）。
//
// novel.chapters 出生源 = chapters/*.md 磁盘派生（renderer 闭环）——首章未建时链 accept 的
// chapterId 映射恒 no-chapter，正文悬空于章档案。修法 = 判定过（planAutoCreateChapter 单源：
// no-chapter + 未显式 chapterId + sort_order 0 命中空位 + R1.1d 落位守卫）→ 经 registry
// `chapter_write` builtin 程序化 execute 建章文件（CR-004 splice 同款通道）→ 补产
// chapter_candidate metadata（directChapterId=stem 语义，含 storyDecisions——R1.1c 不降级）。
//
// mock：getSession（控制 permissionMode → 模式门 auto=direct 全文 / suggest=review 骨架）+
// skillExecutor.runChapterChain（mockImplementation 调 options.onAccept 模拟链段 accept 分支
// skip——acceptSkipReason/acceptSkipRunId 闭包捕获路径同产线）+ registry chapter_write fake
// （真写盘到 temp project，验文件形态）。
// ════════════════════════════════════════════════════════════════════════════

vi.mock('../src/agent/session', () => ({
  getSession: vi.fn(),
  // 以下 session 函数 write_chapter 不用，但模块解析需存在（避免 import 出错）。
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
  mockedGetSession.mockReturnValue({
    permissionMode: mode,
    participationGear: 'smart',
    trustAdjudication: false,
  } as SessionState);
}

describe('write_chapter #107 no-chapter 自动建章（R1.1）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;
  /** chapter_write fake 调用记录（params + 写盘验证）。 */
  let chapterWriteCalls: Array<{ chapterId: string; content: string }>;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-107-'));
    runChapterChain = vi.fn();
    chapterWriteCalls = [];
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn() },
    };
    mockedGetSession.mockReset();
    setSessionPermissionMode(undefined); // 默认无 session → 兜底 suggest（review 模式门）
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  /**
   * 写一份 ready 且 novel.chapters 为空（#107 首章冷启动形态）的 project.yaml。
   * overrides 可注入 novel.chapters / episode_outlines 变体（多命中 / 守卫不过用例）。
   */
  function writeProjectYaml(overrides: { novelChapters?: Array<{ id: string; sort_order?: number }>; episodes?: Array<{ id: string; index: number }> } = {}): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: {
        nodes: [
          { id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } },
          { id: 's2', episodeId: 'ep2', storyTime: 1, presentationOrder: { chapter: 1, pos: 0 } },
        ],
        edges: [],
        lines: [],
      },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: overrides.episodes ?? [{ id: 'ep1', index: 0, title: '开篇' }],
      novel: { chapters: overrides.novelChapters ?? [] },
    }), 'utf8');
  }

  /** registry 注册 chapter_write fake：记录调用 + 真写 chapters/<id>.md（验文件形态）。 */
  async function registerFakeChapterWrite(): Promise<void> {
    const { registry } = await import('../src/tool/registry');
    registry.register({
      id: 'chapter_write',
      description: 'test fake',
      parameters: z.object({ chapterId: z.string(), content: z.string() }),
      execute: async (params: { chapterId: string; content: string }): Promise<ToolResult> => {
        chapterWriteCalls.push(params);
        const dir = path.join(projectPath, 'chapters');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `${params.chapterId}.md`), params.content, 'utf8');
        return { title: `chapter_write: ${params.chapterId}`, output: 'written' };
      },
    });
  }

  const DRAFT_TITLE = '挖出来的是什么';
  const DRAFT_TEXT = '正文内容……（采信稿全文）';

  /**
   * runChapterChain mock：调 options.onAccept（模拟链段 accept 分支——真实 project 数据走
   * buildChapterAccept，novel.chapters 空时返 no-chapter skip、闭包捕获 skipReason/runId），
   * 返无 chapter_accept 的 summary（accept 终态 + draftText/draftTitle + deviation 投影）。
   */
  function mockChainNoChapterSkip(runId = 'run_107'): void {
    runChapterChain.mockImplementation(async (
      _sid: string,
      _arts: unknown,
      opts: { onAccept?: (snap: { runId: string; artifacts: Record<string, unknown> }, c: { nowISO: string }) => unknown },
    ) => {
      const fakeSnapshot = {
        runId,
        artifacts: {
          'draft.initial': { title: DRAFT_TITLE, text: DRAFT_TEXT, wordCount: 2876 },
          'route_decision': { decision: 'accept_as_truth', reason: '正文升级', deviation: true },
        },
      };
      const ca = opts.onAccept?.(fakeSnapshot, { nowISO: '2026-08-30T00:00:00.000Z' });
      const summary: RunSnapshotSummary = {
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '正文升级', deviation: true },
        draftTitle: DRAFT_TITLE,
        draftWordCount: 2876,
        draftText: DRAFT_TEXT,
        errors: [],
        // chapter_accept 缺省（onAccept skip 了 no-chapter）。
        ...(ca && typeof ca === 'object' && 'chapterId' in ca ? { chapter_accept: ca as RunSnapshotSummary['chapter_accept'] } : {}),
      };
      return summary;
    });
  }

  const STEM = `第01章-${DRAFT_TITLE}`;
  const FULL_FILE = `---\norder: 0\n---\n\n# ${DRAFT_TITLE}\n\n${DRAFT_TEXT}`;
  const SKELETON_FILE = `---\norder: 0\n---\n\n# ${DRAFT_TITLE}\n`;

  // ── ① direct 车道（auto 档）：全文形态 + 候选 metadata（含 storyDecisions）────────

  it('①auto 档 no-chapter+空位+守卫过 → 建全文文件（frontmatter order+标题+正文）+ field_patch 候选（含 storyDecisions）', async () => {
    writeProjectYaml();
    setSessionPermissionMode('auto');
    mockChainNoChapterSkip();
    await registerFakeChapterWrite();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // 建文件：stem 锚 episode.index（第01章-标题），content = 全文形态（正文=采信稿）。
    expect(chapterWriteCalls).toHaveLength(1);
    expect(chapterWriteCalls[0].chapterId).toBe(STEM);
    expect(chapterWriteCalls[0].content).toBe(FULL_FILE);
    // 真写盘验证（fake 直写 temp project）。
    expect(readFileSync(path.join(projectPath, 'chapters', `${STEM}.md`), 'utf8')).toBe(FULL_FILE);

    // 候选补产：field_patch metadata（directChapterId=stem 语义）。
    expect(result.metadata?.type).toBe('field_patch');
    expect(result.metadata?.field).toBe('chapter_candidate');
    const data = result.metadata?.data as {
      chapterId: string;
      runId: string;
      candidate: { title: string; content: string; wordCount?: number };
      storyDecisions?: unknown[];
    };
    expect(data.chapterId).toBe(STEM);
    expect(data.runId).toBe('run_107'); // onAccept 闭包捕获的链段 runId
    // candidate.content = 完整文件形态（frontmatter 必须随正文走——accept 落盘整体覆盖写防丢 order）。
    expect(data.candidate.content).toBe(FULL_FILE);
    expect(data.candidate.wordCount).toBe(2876);
    // R1.1c 不降级：deviation=true → storyDecisions 补产（buildAcceptStoryDecisions 单源）。
    expect(data.storyDecisions).toHaveLength(1);
    expect((data.storyDecisions![0] as { id: string; source: string }).id).toBe('accept-run_107');
    expect((data.storyDecisions![0] as { source: string }).source).toBe('accept_as_truth');
    // 告知行（R1.4）：自动建章事实透明化 + direct 语义。
    expect(result.output).toContain('已自动建章');
    expect(result.output).toContain(`chapters/${STEM}.md`);
    expect(result.output).toContain('auto 档正文已随文件直落');
  });

  // ── ② review 车道（suggest/readonly）：骨架形态 ────────────────────────────────

  it('②suggest 档（review）→ 骨架章（frontmatter+标题、无正文）；候选 content 仍为完整形态待审', async () => {
    writeProjectYaml();
    setSessionPermissionMode('suggest');
    mockChainNoChapterSkip();
    await registerFakeChapterWrite();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // 建文件：骨架（无正文——review「写内容须人批」语义不破）。
    expect(chapterWriteCalls).toHaveLength(1);
    expect(chapterWriteCalls[0].chapterId).toBe(STEM);
    expect(chapterWriteCalls[0].content).toBe(SKELETON_FILE);
    // 候选照常组装（正文进 PatchReview 人审）。
    expect(result.metadata?.type).toBe('field_patch');
    const data = result.metadata?.data as { chapterId: string; candidate: { content: string } };
    expect(data.chapterId).toBe(STEM);
    expect(data.candidate.content).toBe(FULL_FILE);
    expect(result.output).toContain('骨架章');
  });

  it('②b session 缺（兜底 suggest）→ 同 review 骨架形态', async () => {
    writeProjectYaml();
    setSessionPermissionMode(undefined);
    mockChainNoChapterSkip();
    await registerFakeChapterWrite();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(chapterWriteCalls).toHaveLength(1);
    expect(chapterWriteCalls[0].content).toBe(SKELETON_FILE);
  });

  // ── ③ 多命中不建（歧义维持报错）──────────────────────────────────────────────

  it('③多命中（两章同 sort_order=0）→ 不自动建 + 维持现状告警（describeAcceptSkip no-chapter）', async () => {
    writeProjectYaml({
      novelChapters: [
        { id: 'ch_a', sort_order: 0 },
        { id: 'ch_b', sort_order: 0 },
      ],
    });
    mockChainNoChapterSkip();
    await registerFakeChapterWrite();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(chapterWriteCalls).toHaveLength(0);
    expect(result.metadata?.type).toBeUndefined();
    expect(result.output).toContain('accept 未持久化');
    expect(result.output).toContain('自动建章'); // describeAcceptSkip 新文案如实说明为何没自动建
  });

  // ── ④ 守卫不过不建（order 有洞落位错）────────────────────────────────────────

  it('④落位守卫不过（既有章 sort_order=2 有洞，target=1 插 order:1 落位 0）→ 不建 + 告警', async () => {
    writeProjectYaml({
      episodes: [
        { id: 'ep1', index: 0 },
        { id: 'ep2', index: 1 },
      ],
      novelChapters: [{ id: 'ch_jump', sort_order: 2 }],
    });
    mockChainNoChapterSkip();
    await registerFakeChapterWrite();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(chapterWriteCalls).toHaveLength(0);
    expect(result.output).toContain('accept 未持久化');
    expect(result.output).toContain('落位守卫');
  });

  // ── ⑤ 显式 chapterId 不建（directChapterId 优先解析，无 skip 可补）────────────

  it('⑤显式 chapterId → onAccept 直传优先解析出候选（无 no-chapter skip，无自动建）', async () => {
    writeProjectYaml();
    mockChainNoChapterSkip('run_direct');
    await registerFakeChapterWrite();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterId: 'ch_custom_direct', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // directChapterId 短路映射 → chapter_accept 正常产出（planAutoCreateChapter 的
    // directChapterId 守卫是纯防御层，本形态根本走不到 skip）。
    expect(chapterWriteCalls).toHaveLength(0);
    expect(result.metadata?.type).toBe('field_patch');
    expect((result.metadata?.data as { chapterId: string }).chapterId).toBe('ch_custom_direct');
  });

  // ── ⑥ 幂等重跑（同 stem 第二次不产第二形态）──────────────────────────────────

  it('⑥幂等重跑：同 episode 二次调用（注册未至窗口）→ 同 stem 同内容再写（chapter_write 幂等键稳定）', async () => {
    writeProjectYaml();
    setSessionPermissionMode('auto');
    mockChainNoChapterSkip();
    await registerFakeChapterWrite();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);
    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 两次调用同 stem 同内容（确定性锚 episode.index + 标题——重跑不产第二文件形态）。
    expect(chapterWriteCalls).toHaveLength(2);
    expect(chapterWriteCalls[0]).toEqual(chapterWriteCalls[1]);
    expect(chapterWriteCalls[0].chapterId).toBe(STEM);
  });

  // ── 边界：chapter_write builtin 未注册（registry 空）→ graceful 维持现状告警 ────

  it('chapter_write 未注册（registry 空）→ 不崩 tool，维持现状告警（graceful）', async () => {
    writeProjectYaml();
    mockChainNoChapterSkip();
    // 不 registerFakeChapterWrite（registry 空）。
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(chapterWriteCalls).toHaveLength(0);
    expect(result.metadata?.type).toBeUndefined();
    expect(result.output).toContain('accept 未持久化');
  });
});
