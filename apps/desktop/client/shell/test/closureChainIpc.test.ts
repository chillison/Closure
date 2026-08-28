import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { allowPath } from '../main/ipc/pathGuard';

// Story 4.0 §4.8 / implement.md 6.3：closure:run-chapter-chain IPC handler 单测。
// mock getAgentRuntime（返 mock runtime）+ local-bff loadProject → 验：handler 组 initialArtifacts +
// 建 stub parent session + 调 runtime.runChapterChain + 返 summary。mirror closureIndexIpc.test.ts 模式。
//
// CR-7（IPC 入口 Zod 校验）/ CR-10（assertSafePath 路径守卫）：handler 入口先 safeParse 再 assertSafePath，
// 故测试 allowPath(TEST_DIR) 授权测试目录（mirror pathGuard.test.ts 模式），并加 Zod reject + 路径越界用例。

const TEST_DIR = path.join(process.cwd(), 'test-tmp-closure-chain-ipc');

const { handle, runChapterChain, runAgentWithExplicitSystem, createSession, loadProject, acceptChapterCandidate, onFieldEdited, clearChainSnapshot, getChainSnapshot, getSession, acquireProjectRun, releaseProjectRun, releaseLease, error: logError, info: logInfo, warn: logWarn, notifyLeaderChainCompleted, runtimeShape } = vi.hoisted(() => ({
  handle: vi.fn(),
  runChapterChain: vi.fn(),
  runAgentWithExplicitSystem: vi.fn(),
  createSession: vi.fn(),
  loadProject: vi.fn(),
  acceptChapterCandidate: vi.fn(),
  onFieldEdited: vi.fn(),
  clearChainSnapshot: vi.fn(),
  getChainSnapshot: vi.fn(),
  getSession: vi.fn(),
  // dogfood R2 #93 追加拍板：resume completed 终态的 leader 回注调用（fire-and-forget 断言面）。
  notifyLeaderChainCompleted: vi.fn(),
  // dogfood T1-S3 D4 闸 + CR 批3：默认放行（{ok:true, release}——handle 式），闸自身的
  // 行为在 projectRunGate.test.ts 单测；此处 mock 只为让 handler 的 import 可解析 +
  // 用例可覆写拒发/断言 finally 经 handle 释放（CR-T1-020 唯一租约 id / CR-T1-021 句柄）。
  acquireProjectRun: vi.fn(),
  releaseProjectRun: vi.fn(),
  releaseLease: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  // dogfood R2 #90：warn 提升为 hoisted mock（parse 失败观测断言用——旧匿名 vi.fn() 测试摸不到）。
  warn: vi.fn(),
  // dogfood R2 #90：mock runtime 形态开关——true 时 getAgentRuntime 返的对象删掉
  // runAgentWithExplicitSystem（测「旧 runtime 无此方法」的 optimizer 不可用分因；默认 false 零影响）。
  runtimeShape: { noExplicitSystem: false },
}));

vi.mock('electron', () => ({
  app: { getPath: (_: string) => TEST_DIR, isPackaged: false },
  ipcMain: { handle },
}));

// mock agentIpc 的 getAgentRuntime → 返 mock runtime（runChapterChain + createSession + runAgentWithExplicitSystem
// + Story 4.3 Step 3：clearChainSnapshot + getChainSnapshot + getSession for resume-chapter-chain handler）
// runAgentWithExplicitSystem 默认返空 content（裁决器/revision-optimizer parse 失败 → graceful 降级用）。
vi.mock('../main/ipc/agentIpc', () => ({
  getAgentRuntime: () => {
    const rt: Record<string, unknown> = {
      runChapterChain,
      createSession,
      runAgentWithExplicitSystem,
      clearChainSnapshot,
      getChainSnapshot,
      getSession,
      // dogfood R2 #93：leader 回注 API（handler 的 defensive typeof 检查目标）。
      notifyLeaderChainCompleted,
    };
    // #90 分因：删方法模拟旧 runtime（dispatchRevisionOptimizerForIpc 的 typeof 检查路径）。
    if (runtimeShape.noExplicitSystem) delete rt.runAgentWithExplicitSystem;
    return rt;
  },
  // T1-S3 D4 + CR 批3：闸经 hoisted mock（默认值在各 describe beforeEach 设——handle 式
  // `{ok:true, release}`；真实实现是每 invoke 唯一租约 id + 引用计账，见 agentIpc.ts）。
  acquireProjectRun,
  releaseProjectRun,
  CHAIN_RUN_LEASE_ID: 'chain-run:closure',
}));

// mock local-bff loadProject + acceptChapterCandidate（4.1 Step 4：IPC 入口持久化经此调；dynamic import）
// + onFieldEdited（Story 2.2 CR-08-16-201：resume 终态 story-sync 消费经 storySyncApplyHandler auto 档调用）
vi.mock('@orison/desktop-local-bff', () => ({ loadProject, acceptChapterCandidate, onFieldEdited }));

vi.mock('../main/logger', () => ({
  getLogger: () => ({ error: logError, info: logInfo, warn: logWarn, debug: vi.fn() }),
}));

import { registerClosureChainIpc } from '../main/ipc/closureChainIpc';
import * as projectWriteLock from '../main/fs/projectWriteLock';

const DOC_FIXTURE = {
  meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
  creative_brief: { genre: '都市奇幻' },
  world_setting: { premise: '灵气复苏都市' },
  asset_cards: [
    {
      id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年',
      narrative: { storyFunction: '主角' },
      desireAndBottomline: { coreDesire: '变强' },
      personality: { coreTraits: ['坚韧'] },
    },
  ],
  scene_graph: {
    nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }],
    edges: [],
    lines: [],
  },
  // Story 6.5：foreshadow_registry → promise_registry（creative field 改名 + 泛化为读者债生命周期账本）。
  promise_registry: { promises: [], beats: [], version: 0 },
};

const SUMMARY_OK = {
  status: 'completed',
  routeDecision: { decision: 'accept_as_truth', reason: '正文升级' },
  reviewVerdict: 'pass',
  draftTitle: '第二章 B 城',
  draftWordCount: 2800,
  errors: [],
  // 4.1 Step 4：chapter_accept（onAccept 产；mock runChapterChain 直接返，绕过 onAccept 闭包）。
  chapter_accept: {
    chapterId: 'ch_001',
    candidate: { title: '第二章 B 城', content: '正文…', wordCount: 2800 },
    runId: 'run_mock',
  },
};

describe('closure:run-chapter-chain handler（Story 4.0 §4.8）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined); // 默认成功 no-op
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined); // 默认无 session → mode 兜底 suggest
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1' });
    // 子 agent（裁决器/revision-optimizer）默认返空 content（parse 失败 → graceful 降级），保持既有测试行为。
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    // T1-S3 D4 + CR 批3：每用例闸默认放行（handle 式）+ 清释放调用计数（finally 释放断言用）。
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    releaseProjectRun.mockClear();
    // CR-10：授权测试目录进 pathGuard allowedRoots（assertSafePath 否则会拒 TEST_DIR）。
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. 正常路径：loadProject → 组 artifacts → stub session → runChapterChain → summary
  // ════════════════════════════════════════════════════════════════════════════

  it('loadProject → 组四 artifact → runChapterChain → 返 summary', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'REACH_B_CITY' },
    });

    // loadProject 被调
    expect(loadProject).toHaveBeenCalledWith(TEST_DIR);

    // stub parent session 创建（dogfood 无 leader session）
    expect(createSession).toHaveBeenCalledTimes(1);
    const sessionInput = createSession.mock.calls[0][0];
    expect(sessionInput.agentName).toBe('chapter-chain-dogfood');
    expect(sessionInput.projectPath).toBe(TEST_DIR);

    // runChapterChain 被调，parentSessionId = stub session id
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [parentId, artifacts, options] = runChapterChain.mock.calls[0];
    expect(parentId).toBe('stub-parent-session-1');
    expect(options.requirement).toBe('ep1');
    // 4.1 Step 4：onAccept 闭包传入（accept 分支产 chapter_accept）
    expect(typeof options.onAccept).toBe('function');

    // 四 artifact key 齐（assembleChapterChainArtifacts 产出）
    expect(artifacts['scene_graph']).toBeDefined();
    expect(artifacts['settings_context']).toBeDefined();
    expect(artifacts['chapter_brief_input']).toEqual({ episodeId: 'ep1', brief: { goal: 'REACH_B_CITY' } });
    // Story 6.5：artifact key 改名 promise_registry（assembleChapterChainArtifacts 产出）。
    expect(artifacts['promise_registry']).toBeDefined();

    // 4.1 Step 4（CR-15b）：summary.chapter_accept → 调 acceptChapterCandidate 持久化（IPC 直接写盘）
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    const [persistPath, persistChapterId, persistRunId, persistCandidate] = acceptChapterCandidate.mock.calls[0];
    expect(persistPath).toBe(TEST_DIR);
    expect(persistChapterId).toBe('ch_001');
    expect(persistRunId).toBe('run_mock');
    expect(persistCandidate).toEqual({ title: '第二章 B 城', content: '正文…', wordCount: 2800 });

    // summary 透传 + dogfood R2 #93 P0-2：direct 档直落成功置 chapterPersisted=true（UI 据此免二次 stage）。
    expect(summary).toEqual({ ...SUMMARY_OK, chapterPersisted: true });

    // T1-S3 D4 + CR-T1-020：闸经 acquire（每 invoke 唯一租约 id `chain-run:closure:<uuid>`），
    // 成功路径 finally 经 handle.release 释放（CR-T1-021 句柄式——不再按 sessionId 二次释放）。
    expect(acquireProjectRun).toHaveBeenCalledWith(TEST_DIR, expect.stringMatching(/^chain-run:closure:/));
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1b. T1-S3 D4 同项目单 run 闸：拒发结构化 summary（机器可读前缀）+ 不跑链；throw 路径 finally 仍释放
  // （闸自身的注册/对账/归一行为在 projectRunGate.test.ts 单测——此处只钉 handler 集成面）
  // ════════════════════════════════════════════════════════════════════════════

  it('T1-S3 D4：同项目占用 → status=error summary 含 project_run_active|heldBy= 前缀 + 不调 loadProject/runChapterChain', async () => {
    acquireProjectRun.mockImplementation(() => ({ ok: false, held: { sessionId: 'sess-other', projectPath: TEST_DIR } }));
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'REACH_B_CITY' },
    });

    expect(summary).toMatchObject({ status: 'error' });
    expect((summary as { errors: string[] }).errors[0]).toBe(`project_run_active|heldBy=sess-other|project=${TEST_DIR}`);
    expect(loadProject).not.toHaveBeenCalled();
    expect(runChapterChain).not.toHaveBeenCalled();
    // 拒发不入闸，无租可释
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it('T1-S3 D4：runChapterChain 抛错（handler catch 路径）→ finally 仍释放闸', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockRejectedValue(new Error('boom'));
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'REACH_B_CITY' },
    });

    expect(summary).toMatchObject({ status: 'error' });
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. CR-7：Zod 校验拒（缺 episodeId / 坏 chapterBrief 类型）→ status=error summary（不抛、不调 loadProject）
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-7：缺 episodeId → Zod safeParse 拒 → status=error summary + 不调 loadProject/runChapterChain', async () => {
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('episodeId'))).toBe(true);
    expect(loadProject).not.toHaveBeenCalled(); // Zod 拒在 loadProject 前
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('CR-7：chapterBrief 坏类型（string 非 object）→ Zod 拒 → status=error summary', async () => {
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: 'not-an-object' as unknown,
    });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('chapterBrief'))).toBe(true);
    expect(loadProject).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. CR-10：projectPath 越界（非 allowedRoots）→ assertSafePath 拒 → status=error summary
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-10：projectPath 越界（非 allowedRoots）→ status=error summary + 不调 loadProject', async () => {
    const handler = chainHandler();
    // 选一个确定不在 allowedRoots 的路径（系统临时目录的随机子目录，非 OrisonSpace 根下）
    const outsidePath = path.join(process.cwd(), 'definitely-not-allowed-' + Date.now());

    const summary = await handler({}, { projectPath: outsidePath, episodeId: 'ep1' });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('projectPath rejected'))).toBe(true);
    expect(loadProject).not.toHaveBeenCalled(); // assertSafePath 在 loadProject 前
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. loadProject 返 null（corrupt/missing）→ status=error summary
  // ════════════════════════════════════════════════════════════════════════════

  it('loadProject 返 null → status=error summary + 不调 runChapterChain', async () => {
    loadProject.mockReturnValue(null);
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1' });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors[0]).toContain('could not be loaded');
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. runChapterChain 抛错 → status=error summary（不抛 IPC rejection）
  // ════════════════════════════════════════════════════════════════════════════

  it('runChapterChain 抛错 → status=error summary（handler catch）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockRejectedValue(new Error('LLM provider timeout'));
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'REACH_B_CITY' },
    });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors[0]).toContain('LLM provider timeout');
    expect(logError).toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. 4.1 §3.2 readiness gate：non-ready brief → status=error summary（不调 runChapterChain）
  // ════════════════════════════════════════════════════════════════════════════

  it('4.1 gate：brief 缺 goal → status=error summary 含 needs_world_context（不调 runChapterChain）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      // chapterBrief 缺 → goal 空 → needs_world_context
    });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('needs_world_context'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('4.1 gate：scene_graph 空且无设定 → status=error summary 含 needs_plot（判定序：plot 优先）', async () => {
    const emptyDoc = {
      meta: DOC_FIXTURE.meta,
      scene_graph: { nodes: [], edges: [], lines: [] },
    };
    loadProject.mockReturnValue(emptyDoc);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'g' },
    });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('needs_plot'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. 4.1 Step 4（CR-15b）：accept 持久化路径
  // ════════════════════════════════════════════════════════════════════════════

  it('4.1 Step 4：chapter_accept 含 storyDecisions → acceptChapterCandidate 第 5 参传 storyDecisions', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    const decision = {
      id: 'accept-run_d', summary: '偏离', reason: '角色硬气', alternatives: [],
      risk: '须校正', status: 'decided' as const, source: 'accept_as_truth' as const,
      relatedEpisodeId: 'ep1', createdAt: '2026-08-01T00:00:00.000Z',
    };
    runChapterChain.mockResolvedValue({
      ...SUMMARY_OK,
      chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文' }, runId: 'run_d', storyDecisions: [decision] },
    });
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    const persistCall = acceptChapterCandidate.mock.calls[0];
    const storyDecisionsArg = persistCall?.[4];
    expect(storyDecisionsArg).toEqual([decision]);
  });

  it('4.1 Step 4：route=accept 但 chapter_accept 缺省（映射失败）→ 不调 acceptChapterCandidate + errors 告知章未注册', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      errors: [],
      // chapter_accept 缺省
    });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { errors: string[] };

    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    expect(summary.errors.some((e) => e.includes('章未在 project.yaml 注册'))).toBe(true);
  });

  it('4.1 Step 4：route=escalate_user → 不调 acceptChapterCandidate（escalate 不持久化）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
      errors: [],
    });
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    expect(acceptChapterCandidate).not.toHaveBeenCalled();
  });

  it('Story 4.6 D4：route=escalate_user 有 chapter_accept（chain D4 产候选）+ findings → IPC 仍不落盘（dogfood 无裁决 UI）+ summary 返 findings', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
      draftText: '正文……',
      escalateFindings: [
        { severity: 'block', quote: '硬气', location: '段1', explanation: 'OOC 嫌疑' },
      ],
      // D4：chain 在 escalate 有 draft 时产 chapter_accept（候选载荷，PatchReview 作裁决 UI——但 dogfood IPC 无 UI）
      chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文' }, runId: 'run_esc' },
      errors: [],
    });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { escalateFindings?: unknown[] };

    // IPC 不落盘 chapter_accept（dogfood 无裁决 UI；裁决器仅 leader write_chapter 路径派）
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    // escalateFindings 在 summary 返回（供调用方/测试断言）
    expect(summary.escalateFindings).toHaveLength(1);
  });

  it('4.1 Step 4：acceptChapterCandidate 抛错 → summary 附加 persist failed error（不吞错）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    acceptChapterCandidate.mockImplementation(() => { throw new Error('disk full'); });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { errors: string[] };

    expect(summary.errors.some((e) => e.includes('chapter persist failed') && e.includes('disk full'))).toBe(true);
    expect(logError).toHaveBeenCalled();
  });

  it('4.1 Step 4：chapterId 直传 → onAccept 闭包用 directChapterId（绕过映射）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    // mock runChapterChain 调 options.onAccept（模拟链段 accept），验 directChapterId 进 chapter_accept
    runChapterChain.mockImplementation(async (_sid: string, _arts: unknown, opts: { onAccept?: (s: unknown, c: { nowISO: string }) => unknown }) => {
      const ca = opts.onAccept?.(
        { runId: 'run_direct', artifacts: { 'draft.initial': { text: '正文' }, 'route_decision': { decision: 'accept_as_truth' } } },
        { nowISO: '2026-08-01T00:00:00.000Z' },
      );
      return { status: 'completed', routeDecision: { decision: 'accept_as_truth', reason: '通过' }, errors: [], chapter_accept: ca as { chapterId: string } };
    });
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterId: 'ch_direct', chapterBrief: { goal: 'g' } });

    const persistChapterId = acceptChapterCandidate.mock.calls[0]?.[1];
    expect(persistChapterId).toBe('ch_direct');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 8. CR-4.1-03：acceptChapterCandidate 经 withProjectLock 串行化（防 dogfood 链 + 工作台 accept 并发丢更新）
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-4.1-03：chapter_accept 持久化经 withProjectLock（与 field:apply-agent-patch 同锁协调）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    // spy 不改真实行为（withProjectLock passthrough），仅观测是否被调用 + projectPath 入参。
    const lockSpy = vi.spyOn(projectWriteLock, 'withProjectLock');
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    // withProjectLock 被调，且第一参 = projectPath（与 field:apply-agent-patch / field:sync 共享 projectDir 键）。
    expect(lockSpy).toHaveBeenCalled();
    const lockCall = lockSpy.mock.calls.find(([dir]) => dir === TEST_DIR);
    expect(lockCall).toBeTruthy();
    // 第二参是 op 回调；执行它应触发 acceptChapterCandidate（验证锁包的是持久化调用）。
    const op = lockCall![1] as () => unknown;
    acceptChapterCandidate.mockClear();
    op();
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    lockSpy.mockRestore();
  });

  it('CR-4.1-03：route=escalate_user（无 chapter_accept）→ withProjectLock 不被持久化路径触发', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
      errors: [],
    });
    const lockSpy = vi.spyOn(projectWriteLock, 'withProjectLock');
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    // 非持久化路径不应触发 withProjectLock（accept 未发生）。
    expect(lockSpy).not.toHaveBeenCalled();
    lockSpy.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 8.4 A10（design §1.8）：#9 建议读取退役回归（IPC 入口）。
// 验：ready run 零 retrieval-agent 派发 + chapter_brief_input.brief 原样直通（无 #9 合并）；
//     gate-first 保留——brief 未就绪零子 agent 派发 + 不跑链段。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:run-chapter-chain handler 无 #9 路径（Story 8.4 A10）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1' });
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('ready run → 零 retrieval-agent 派发 + chapter_brief_input.brief 原样直通（无 suggestedReads）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runAgentWithExplicitSystem.mockResolvedValue({ content: '{}' });
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    // retrieval-agent 零派发（#9 退役——写手自查取代，资料员走 writer 节点内子循环非本入口）
    const retrievalCalls = runAgentWithExplicitSystem.mock.calls.filter((c) => c[1] === 'retrieval-agent');
    expect(retrievalCalls).toHaveLength(0);
    // 链段照跑
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    // chapter_brief_input.brief = IPC 传入 brief 原样（无 #9 合并步骤）
    const [, artifacts] = runChapterChain.mock.calls[0];
    const briefInput = artifacts['chapter_brief_input'] as { brief: Record<string, unknown> };
    expect(briefInput.brief.goal).toBe('g');
    expect('suggestedReads' in briefInput.brief).toBe(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // P1（BMad CR Blind+Edge medium）：gate-first 顺序回归。
  // 子 agent 派发是多步 LLM 调用，non-ready brief 时 gate 阻断会把派发结果整个弃掉，白烧算力。
  // 故 gate 须在派发之前——brief 未就绪时不派任何子 agent。readiness 只看结构信号，gate-first 安全。
  // ════════════════════════════════════════════════════════════════════════════

  it('P1 gate-first：brief 未就绪（缺 goal → needs_world_context）→ 零子 agent 派发 + 不跑链段', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runAgentWithExplicitSystem.mockResolvedValue({ content: '{}' });
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    // 缺 chapterBrief → 缺 goal → needs_world_context（DOC_FIXTURE 有 scene_graph 1 node + settings 非空）
    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('needs_world_context'))).toBe(true);
    // 子 agent 零派发（gate 在前）
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
    // 链段不跑
    expect(runChapterChain).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 4.3 Step 3：closure:run-chapter-chain mode wiring + closure:resume-chapter-chain handler。
// 验：(a) run-chapter-chain 传 mode（deriveCheckpointPolicy from stub parent permissionMode）；
//     (b) 两入口 mode 一致（run + resume 都 derive from session.permissionMode）；
//     (c) resume continue → runChapterChain 收 resume+mode；
//     (d) resume redo → runChapterChain 收 redo:{nodeId:'draft-writer-agent', feedback}；
//     (e) resume abort → clearChainSnapshot + 不跑链段 + 返 aborted；
//     (f) Zod 校验 + 路径守卫。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:run-chapter-chain mode wiring + closure:resume-chapter-chain（Story 4.3 Step 3）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    onFieldEdited.mockReset();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'suggest' });
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function resumeHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('run-chapter-chain 传 mode（deriveCheckpointPolicy from stub parent permissionMode=suggest → pauseStages=["draft"]）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    const options = runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[]; escalateMode: string } };
    // stub parent permissionMode='suggest'（createSession mockReturnValue）→ deriveCheckpointPolicy
    expect(options.mode).toBeDefined();
    expect(options.mode!.pauseStages).toEqual(['draft']);
    expect(options.mode!.escalateMode).toBe('ask');
  });

  it('两入口一致：run + resume 都从 session.permissionMode 推 mode（同 deriveCheckpointPolicy）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    // session.permissionMode='readonly' → 两入口都应得 pauseStages=['brief','draft','verdict']
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'readonly' });
    getSession.mockReturnValue({ permissionMode: 'readonly' });

    const runH = chainHandler();
    await runH({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });
    const runMode = (runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[] } }).mode;

    runChapterChain.mockClear();
    const resumeH = resumeHandler();
    await resumeH({}, { projectPath: TEST_DIR, sessionId: 'stub-parent-session-1', action: 'continue' });
    const resumeMode = (runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[] } }).mode;

    expect(runMode!.pauseStages).toEqual(['brief', 'draft', 'verdict']);
    expect(resumeMode!.pauseStages).toEqual(['brief', 'draft', 'verdict']);
  });

  it('resume continue → runChapterChain 收 resume.fromSnapshot=true + mode（不传 redo）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'continue' });

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [parentId, initialArtifacts, options] = runChapterChain.mock.calls[0];
    expect(parentId).toBe('sess-1');
    // resume 用 snapshot artifacts，caller 传 {} （runChapterChain 内 resumeArtifacts ?? initialArtifacts）
    expect(initialArtifacts).toEqual({});
    expect(options.resume).toEqual({ fromSnapshot: true });
    expect(options.redo).toBeUndefined();
    expect(options.mode).toBeDefined();
    // onAccept 闭包传入（resume-accept 持久化用）
    expect(typeof options.onAccept).toBe('function');
  });

  it('resume redo → runChapterChain 收 redo:{nodeId:"draft-writer-agent", feedback} + resume + mode', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      action: 'redo',
      feedback: '请加强紧张感',
    });

    const options = runChapterChain.mock.calls[0][2] as {
      resume?: unknown;
      redo?: { nodeId: string; feedback?: string };
      mode?: unknown;
    };
    expect(options.resume).toEqual({ fromSnapshot: true });
    expect(options.redo).toEqual({ nodeId: 'draft-writer-agent', feedback: '请加强紧张感' });
    expect(options.mode).toBeDefined();
  });

  it('resume redo 无 feedback → redo.nodeId 传，feedback 缺省（redo directive 仍生效重跑）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'redo' });

    const options = runChapterChain.mock.calls[0][2] as { redo?: { nodeId: string; feedback?: string } };
    expect(options.redo).toEqual({ nodeId: 'draft-writer-agent' });
    expect(options.redo!.feedback).toBeUndefined();
  });

  it('Story 7.2 art-mode：resume redo + guardOverride → redo.nodeId=revision-guard-agent + guardOverride 透传', async () => {
    // soft-violation pause 后作者「强行放行」：redo 重跑 revision-guard（它在 completedNodes），guardOverride
    // 注入 revision_guard_override → guard force-accept splice。redo.nodeId = revision-guard-agent（非 draft-writer）。
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: ['revision-guard-agent'],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      action: 'redo',
      guardOverride: 'force-accept',
    });

    const options = runChapterChain.mock.calls[0][2] as {
      redo?: { nodeId: string; guardOverride?: string };
    };
    expect(options.redo).toEqual({ nodeId: 'revision-guard-agent', guardOverride: 'force-accept' });
  });

  it('resume abort → clearChainSnapshot 调 + 不跑链段 + 返 status=aborted', async () => {
    clearChainSnapshot.mockReturnValue(true);
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'abort' }) as { status: string; errors: string[] };

    expect(clearChainSnapshot).toHaveBeenCalledWith('sess-1');
    expect(runChapterChain).not.toHaveBeenCalled();
    expect(summary.status).toBe('aborted');
  });

  it('resume abort 无既有 chainSnapshot → clearChainSnapshot 返 false + errors 告知', async () => {
    clearChainSnapshot.mockReturnValue(false);
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'abort' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('aborted');
    expect(summary.errors.some((e) => e.includes('no paused chain'))).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CR-005（Edge+Blind major）：resume continue/redo 缺 chainSnapshot → 返明确 error
  // （不调 runChapterChain({})——空 initialArtifacts 致 brief-compiler requiredArtifactKeys 缺 →
  // status='blocked' 非 AC7 宣称的「从头跑」）。snapshot 缺/形态错两路径都覆盖。abort 既有处理不变。
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-005：resume continue 缺 chainSnapshot（getChainSnapshot 返 undefined）→ status=error + 不调 runChapterChain', async () => {
    getChainSnapshot.mockReturnValue(undefined);
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'continue' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('no paused chain to resume'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('CR-005：resume redo 缺 chainSnapshot → status=error + 不调 runChapterChain（redo 同需前置 snapshot）', async () => {
    getChainSnapshot.mockReturnValue(undefined);
    const handler = resumeHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      action: 'redo',
      feedback: '改',
    }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('no paused chain to resume'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('CR-005：resume continue snapshot 形态错（缺 completedNodes）→ status=error + 不调 runChapterChain', async () => {
    // 形态错：有 artifacts 但无 completedNodes（非数组）→ runChapterChain 内部会降级 from-head，IPC 层应先拦。
    getChainSnapshot.mockReturnValue({
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'continue' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('no paused chain to resume'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('resume Zod 拒（缺 sessionId）→ status=error summary + 不调 runChapterChain/clearChainSnapshot', async () => {
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, action: 'continue' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('sessionId'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
    expect(clearChainSnapshot).not.toHaveBeenCalled();
  });

  it('resume Zod 拒（坏 action）→ status=error summary', async () => {
    const handler = resumeHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      action: 'bogus',
    }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('action'))).toBe(true);
  });

  it('resume projectPath 越界 → assertSafePath 拒 → status=error summary', async () => {
    const handler = resumeHandler();
    const outsidePath = path.join(process.cwd(), 'definitely-not-allowed-resume-' + Date.now());

    const summary = await handler({}, { projectPath: outsidePath, sessionId: 'sess-1', action: 'continue' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('projectPath rejected'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('resume continue 续跑返 paused summary（再次 pause）→ 透传（不持久化，无 chapter_accept）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'paused',
      pausedStage: 'verdict',
      errors: [],
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'continue' }) as { status: string; pausedStage?: string };

    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('verdict');
    // paused 无 chapter_accept → 不调 acceptChapterCandidate
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // dogfood R2 #93（P0-2，2026-08-28）：resume 终态 chapter_accept 落盘语义按会话档位分派——
  // suggest/readonly（leader 会话）不直落，envelope 返 UI 进 pendingPatch 人审（mirror write_chapter
  // metadata field_patch 路径）；auto（dogfood stub）保留直落 + chapterPersisted 标记。
  // ════════════════════════════════════════════════════════════════════════════

  /** #93 P0-2 用 fixture：clone 且**剥除 chapterPersisted**——direct 档用例经 handler mutate 共享
   * SUMMARY_OK（flag 粘在 fixture 上），不剥会随 spread 带进 review 档断言串测。 */
  function cleanAcceptSummary(): Record<string, unknown> {
    const { chapterPersisted: _polluted, ...rest } = SUMMARY_OK as Record<string, unknown> & { chapterPersisted?: true };
    void _polluted;
    return { ...rest, chapter_accept: { ...(SUMMARY_OK.chapter_accept as Record<string, unknown>) } };
  }

  it('#93 P0-2：resume 终态 accept + suggest 档（leader 会话）→ 不直落，envelope 返 UI 人审（chapterPersisted 缺省 + 零 degrade 文案）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'suggest' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-suggest', action: 'continue' }) as {
      chapter_accept?: unknown;
      chapterPersisted?: true;
      errors: string[];
    };

    // review 档：不直落（UI pendingPatch accept 后经既有 acceptChapterCandidateCore 收口）。
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    // envelope 仍在 summary（UI stage pendingPatch 的数据源）+ 未落盘标记缺省。
    expect(summary.chapter_accept).toBeDefined();
    expect(summary.chapterPersisted).toBeUndefined();
    // review 档不加「dogfood IPC 无裁决 UI」degrade 文案（UI PatchReview 就是裁决面）。
    expect(summary.errors.some((e) => e.includes('未落盘'))).toBe(false);
  });

  it('#93 P0-2：resume 终态 accept + auto 档（dogfood stub）→ 直落保留 + chapterPersisted=true（UI 免双 stage）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'auto' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-auto', action: 'continue' }) as {
      chapterPersisted?: true;
    };

    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    expect(summary.chapterPersisted).toBe(true);
  });

  it('#93 P0-2 check 补：dogfood stub 会话（agentName=chapter-chain-dogfood）+ suggest 档 → 仍 direct 直落（链卡 resume 钮无 envelope 消费面，review 档= 症状①换道复发）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    // run 入口手输 autonomy='suggest' 建的 stub 会话——链卡 resume 钮（CR-T1-048）走得到的 lane。
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'chapter-chain-dogfood' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-stub-suggest', action: 'continue' }) as {
      chapterPersisted?: true;
    };

    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    expect(summary.chapterPersisted).toBe(true);
  });

  it('#93 P0-2：resume 终态 accept 但无 chapter_accept（章映射失败）→ errors 附 skipReason 文案（review 档也告知，UI toast 消费）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: 'r' },
      errors: [],
    });
    getSession.mockReturnValue({ permissionMode: 'suggest' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-skip', action: 'continue' }) as {
      chapter_accept?: unknown;
      errors: string[];
    };

    expect(summary.chapter_accept).toBeUndefined();
    expect(summary.errors.some((e) => e.includes('accept 未持久化'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood R2 #93 追加拍板（2026-08-28）：resume 续链完成 → 链完成事件回注 leader。
// completed 终态 + leader 会话（非 dogfood stub）→ fire-and-forget 调
// runtime.notifyLeaderChainCompleted（失败不影响既有完成路径——resume summary 照常返 UI）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:resume-chapter-chain 链完成回注 leader（dogfood R2 #93）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    notifyLeaderChainCompleted.mockReset();
    // 默认 settled promise（fire-and-forget 的 Promise.resolve 包裹吃到任何返回形态）。
    notifyLeaderChainCompleted.mockResolvedValue(true);
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    allowPath(TEST_DIR);
  });

  function resumeHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function snapFixture() {
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
  }

  /** #93 P0-2 同款：clone 且剥除 chapterPersisted 污染。 */
  function cleanAcceptSummary(): Record<string, unknown> {
    const { chapterPersisted: _polluted, ...rest } = SUMMARY_OK as Record<string, unknown> & { chapterPersisted?: true };
    void _polluted;
    return { ...rest, chapter_accept: { ...(SUMMARY_OK.chapter_accept as Record<string, unknown>) } };
  }

  it('completed + leader 会话（suggest/review 档）→ 回注一次，payload 投影 summary（envelope 待审标记）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'writer' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-notify-1', action: 'continue' });

    expect(notifyLeaderChainCompleted).toHaveBeenCalledTimes(1);
    const [notifySessionId, payload] = notifyLeaderChainCompleted.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(notifySessionId).toBe('sess-notify-1');
    expect(payload.runId).toBe('run_mock'); // chapter_accept.runId（稳定 run 标识）
    expect(payload.chapterTitle).toBe('第二章 B 城');
    expect(payload.chapterId).toBe('ch_001');
    expect(payload.wordCount).toBe(2800);
    expect(payload.routeDecision).toBe('accept_as_truth');
    expect(payload.routeReason).toBe('正文升级');
    expect(payload.reviewVerdict).toBe('pass');
    // review 档：envelope 在但未落盘 → 待人审标记（chapterPersisted 缺省）。
    expect(payload.acceptPendingReview).toBe(true);
    expect(payload.chapterPersisted).toBeUndefined();
  });

  it('completed + auto 档 leader 会话 → 直落后 payload.chapterPersisted=true；chapterId 直传优先', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'auto', agentName: 'writer' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-notify-2', action: 'continue', chapterId: 'ch_direct' });

    expect(notifyLeaderChainCompleted).toHaveBeenCalledTimes(1);
    const payload = notifyLeaderChainCompleted.mock.calls[0][1] as Record<string, unknown>;
    // auto 档 handler 直落成功置 chapterPersisted（#93 P0-2）→ payload 如实携带。
    expect(payload.chapterPersisted).toBe(true);
    expect(payload.acceptPendingReview).toBeUndefined();
    // input chapterId 直传优先于 chapter_accept.chapterId。
    expect(payload.chapterId).toBe('ch_direct');
  });

  it('dogfood stub 会话（agentName=chapter-chain-dogfood）→ 不回注（无 leader 对话消费面）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'chapter-chain-dogfood' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-stub-notify', action: 'continue' });

    expect(notifyLeaderChainCompleted).not.toHaveBeenCalled();
  });

  it('非 completed 终态（再次 paused）→ 不回注（下一轮 resume 完成时才回注）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({ status: 'paused', pausedStage: 'draft', errors: [] });
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'writer' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-paused-notify', action: 'continue' });

    expect(notifyLeaderChainCompleted).not.toHaveBeenCalled();
  });

  it('回注 payload 的 runId 回退：无 chapter_accept / storySync → 本次唯一 uuid（幂等守卫降级不炸）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'r' },
      errors: [],
    });
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'writer' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-notify-fallback', action: 'continue' });

    expect(notifyLeaderChainCompleted).toHaveBeenCalledTimes(1);
    const payload = notifyLeaderChainCompleted.mock.calls[0][1] as { runId: string; errors?: string[] };
    expect(typeof payload.runId).toBe('string');
    expect(payload.runId.length).toBeGreaterThan(0);
    // escalate 无候选 review 档 → errors 转达（leader 汇报如实）。
    expect(payload.errors).toBeDefined();
  });

  it('回注调用失败（rejected）→ fire-and-forget 隔离：handler 照常返 completed summary', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'writer' });
    snapFixture();
    notifyLeaderChainCompleted.mockReset();
    notifyLeaderChainCompleted.mockRejectedValue(new Error('leader busy'));
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-notify-boom', action: 'continue' });

    // 失败不影响既有完成路径（summary 照常返回；error 哨兵不发）。
    expect(notifyLeaderChainCompleted).toHaveBeenCalledTimes(1);
    expect((summary as { status: string }).status).toBe('completed');
    expect(logError).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 4.3 Step 6：closure:run-chapter-chain / resume-chapter-chain escalate mode-gating
// （auto-trust vs ask，design §3.8）。两入口一致（mirror write_chapter agent 路径）。
// auto-trust（全自动）→ 派裁决器 + 采信 recommendation（accept=落盘 / revise=redo / parse失败=degrade 不假 pass）。
// ask（半自动/微操）→ 4.6 既有 IPC 路径（不派裁决器，degrade 不落盘）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure-chain-ipc escalate mode-gating（Story 4.3 Step 6）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    onFieldEdited.mockReset();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    // auto-trust 默认：stub parent permissionMode='auto' → escalateMode='auto-trust'
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'auto' });
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function resumeHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  const ESCALATE_SUMMARY = {
    status: 'completed',
    routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
    draftText: '正文内容……',
    escalateFindings: [
      { severity: 'block', quote: '林动突然硬气', location: '段1句2', explanation: 'OOC 嫌疑' },
    ],
    chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文…' }, runId: 'run_esc' },
    errors: [],
  };

  /** role-based mock：adjudicator 返 adjudication JSON。 */
  function mockAdjudicator(recommendation: 'accept' | 'revise'): void {
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'adjudicator-agent') {
        return {
          content: JSON.stringify({
            analysis: '硬气是角色弧推进',
            recommendation,
            recommendationReason: recommendation === 'accept' ? '倾向接受' : '倾向改稿',
            options: [
              { label: '改稿', reason: '破坏一致性' },
              { label: '接受为真相', reason: '角色弧推进' },
            ],
          }),
        };
      }
      return { content: '' };
    });
  }

  it('auto-trust + recommendation=accept → acceptChapterCandidate 落盘（复用 4.6 accept 路径真持久化）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    mockAdjudicator('accept');
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { status: string; errors: string[] };

    // auto-trust accept → chapter_accept 真落盘（区别于 4.6 ask 模式 escalate 不落盘）
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    const [persistPath, persistChapterId] = acceptChapterCandidate.mock.calls[0];
    expect(persistPath).toBe(TEST_DIR);
    expect(persistChapterId).toBe('ch_001');
    // 不含 escalate degrade 文案（auto-trust 复用 accept 路径，非 dogfood 无裁决 degrade）
    expect(summary.errors.some((e) => e.includes('chapter_accept 候选未落盘'))).toBe(false);
    // runChapterChain 只调一次（accept 不 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });

  it('auto-trust + recommendation=revise → 触发改稿重跑（runChapterChain 二次调，resume+redo+feedback）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain
      .mockResolvedValueOnce(ESCALATE_SUMMARY)
      .mockResolvedValueOnce({
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '改稿后通过' },
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '改后正文…' }, runId: 'run_redo' },
        errors: [],
      });
    mockAdjudicator('revise');
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { status: string };

    // runChapterChain 二次调（redo，mirror write_chapter agent revise 路径）
    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const redoOpts = runChapterChain.mock.calls[1][2] as {
      resume?: { fromSnapshot?: boolean };
      redo?: { nodeId: string; feedback?: string };
    };
    expect(redoOpts.resume?.fromSnapshot).toBe(true);
    expect(redoOpts.redo?.nodeId).toBe('draft-writer-agent');
    expect(redoOpts.redo?.feedback).toBe('硬气是角色弧推进'); // adjudication.analysis 作 feedback
    // redo 后 accept → acceptChapterCandidate 落盘（redo summary chapter_accept）
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe('completed');
  });

  it('auto-trust + 裁决器 parse 失败 → degrade 不落盘（不假 pass，degrade 4.6 路径）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    // adjudicator 返无法 parse 的内容（parseAdjudication → null）
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'adjudicator-agent') return { content: ' 无法 parse 的裁决器内容 ' };
      return { content: '' };
    });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { errors: string[] };

    // parse 失败 → 不 auto-trust，不落盘（degrade 4.6 路径，**不假 pass**）
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    // degrade 文案（dogfood 无裁决 UI）
    expect(summary.errors.some((e) => e.includes('chapter_accept 候选未落盘'))).toBe(true);
    // runChapterChain 只调一次（parse 失败不 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });

  it('ask 模式（suggest）+ escalate → 4.6 既有 IPC 路径不动（不派裁决器，不落盘，degrade 文案）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    mockAdjudicator('accept');
    // ask 模式：stub parent permissionMode='suggest'
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'suggest' });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { errors: string[] };

    // ask 模式：不派裁决器（adjudicator-agent 调用次数=0，其他子 agent 亦零派发）
    const adjudicatorCall = runAgentWithExplicitSystem.mock.calls.find((c) => c[1] === 'adjudicator-agent');
    expect(adjudicatorCall).toBeUndefined();
    // ask 模式：escalate 不落盘（4.6 既有 degrade，dogfood 无裁决 UI）
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    expect(summary.errors.some((e) => e.includes('chapter_accept 候选未落盘'))).toBe(true);
    // runChapterChain 只调一次（ask 模式不 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });

  it('两入口一致：resume-chapter-chain auto-trust accept 也落盘（mirror run-chapter-chain）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    mockAdjudicator('accept');
    // resume-chapter-chain 用 sessionId 会话 permissionMode='auto'
    getSession.mockReturnValue({ permissionMode: 'auto' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-auto', action: 'continue' });

    // resume 续跑 escalate + auto-trust accept → 落盘（两入口一致，design §3.8）
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    // mode 经 resume 入口也透传 escalateMode='auto-trust'（KD1 + Step 3 wiring）
    const redoOpts = runChapterChain.mock.calls[0][2] as { mode?: { escalateMode?: string } };
    expect(redoOpts.mode?.escalateMode).toBe('auto-trust');
  });

  // ── Story 2.2 WP-E（CR-08-16-201）：resume 终态 story-sync 反哺消费 ──
  // suggest 档链段必在 draft pause → 终态提取只经 resume IPC 回落盘点；不消费 = 缺省档补丁静默丢弃。

  it('resume 终态（accept + suggest 档）→ storySync patches 转 storySyncReview 返 UI（非静默丢弃）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      ...SUMMARY_OK,
      storySync: {
        runId: 'run_mock',
        chapterId: 'ch_001',
        summary: '提取新规则',
        patches: [
          { field: 'world_setting', action: 'merge', data: { newRule: '禁飞区' }, fieldVersion: 0, generatedBy: 'story-sync-agent' },
        ],
      },
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    getSession.mockReturnValue({ permissionMode: 'suggest' });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-suggest', action: 'continue' }) as {
      storySyncReview?: { note: string; patches: Array<{ field: string; generatedBy: string }> };
      storySyncLanded?: unknown;
    };

    // suggest 档 → 投影 envelope 组挂 summary 返 UI 路由 PatchReview（非直落、非静默丢）。
    expect(summary.storySyncLanded).toBeUndefined();
    expect(summary.storySyncReview).toBeDefined();
    // CR-08-16-010：非数字 chapterId 不套「第 N 章」模板。
    expect(summary.storySyncReview!.note).toBe('章节 ch_001 story-sync 提取');
    expect(summary.storySyncReview!.patches).toHaveLength(1);
    expect(summary.storySyncReview!.patches[0].field).toBe('world_setting');
    expect(summary.storySyncReview!.patches[0].generatedBy).toBe('story-sync-agent');
  });

  it('resume 终态（accept + auto 档）→ story_sync_apply 直落 → storySyncLanded + onFieldEdited(source=agent)', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      ...SUMMARY_OK,
      storySync: {
        runId: 'run_mock',
        chapterId: 'ch_001',
        summary: '提取新规则',
        patches: [
          { field: 'world_setting', action: 'merge', data: { newRule: '禁飞区' }, fieldVersion: 0, generatedBy: 'story-sync-agent' },
        ],
      },
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    getSession.mockReturnValue({ permissionMode: 'auto' });
    onFieldEdited.mockClear();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-auto2', action: 'continue' }) as {
      storySyncLanded?: { note: string; fields: string[] };
      storySyncReview?: unknown;
    };

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    expect(onFieldEdited.mock.calls[0][0]).toBe(TEST_DIR);
    expect(onFieldEdited.mock.calls[0][1]).toBe('world_setting');
    expect(summary.storySyncReview).toBeUndefined();
    expect(summary.storySyncLanded?.fields).toEqual(['world_setting']);
  });

  it('resume 再 pause（下一 checkpoint）→ 不消费（等下一轮 resume 终态）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'paused',
      pausedStage: 'verdict',
      errors: [],
      storySync: {
        runId: 'run_mock',
        chapterId: 'ch_001',
        summary: '提取新规则',
        patches: [
          { field: 'world_setting', action: 'merge', data: { newRule: '禁飞区' }, fieldVersion: 0, generatedBy: 'story-sync-agent' },
        ],
      },
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    getSession.mockReturnValue({ permissionMode: 'readonly' });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-ro', action: 'continue' }) as {
      storySyncReview?: unknown;
      storySyncLanded?: unknown;
    };

    expect(summary.storySyncReview).toBeUndefined();
    expect(summary.storySyncLanded).toBeUndefined();
    expect(onFieldEdited).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 7.1 Route 1：closure:compile-revision-intent handler（B trigger 选区指挥精修）
// ════════════════════════════════════════════════════════════════════════════

describe('closure:compile-revision-intent handler（Story 7.1 Route 1）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    // dogfood R2 #90：warn / runtime 形态开关复位（分因观测用例间不串扰）。
    logWarn.mockReset();
    runtimeShape.noExplicitSystem = false;
    createSession.mockReturnValue({ id: 'stub-parent-session-1' });
    allowPath(TEST_DIR);
  });

  function compileHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:compile-revision-intent');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  // BMad CR F2：GOOD_INTENT 不含 scope（LLM 不产 anchor）——scope.anchor 由 IPC buildSelectionAnchor 构造。
  const GOOD_INTENT = {
    change: { summary: '战斗改紧张点' },
    lockedItems: [{ field: '角色性格', authority: 'hard' as const, evidence: '别动角色性格' }],
    rationale: { source: 'user-directive' as const, note: '用户选段指挥' },
    provenance: { rawUserInstruction: '这段战斗改紧张点，别动角色性格', compilerNote: '锁定角色性格' },
  };

  it('revision-optimizer 返合法 RevisionIntent → IPC 构 scope.anchor → 返 { intent }（F2）', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({ content: JSON.stringify(GOOD_INTENT) });
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      selectedPassage: '战斗开始了',
      userInstruction: '这段战斗改紧张点，别动角色性格',
      selectionFrom: 3,
      selectionTo: 8,
      draftText: '前文。战斗开始了。后文。',
    })) as { intent: { change: { summary: string }; scope?: { anchor: { quote: string; prefix: string; suffix: string; rangeHint: { from: number; to: number } } } } | null };

    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const [, role, vars, opts] = runAgentWithExplicitSystem.mock.calls[0];
    expect(role).toBe('revision-optimizer-agent');
    // allowedTools 收窄 query_story（mirror retrieval 4.5 D1-c 反向约束）。
    expect(opts?.allowedTools).toEqual(['query_story']);
    // vars 渲染 selectedPassage + userInstruction。
    expect(vars).toMatchObject({ selectedPassage: '战斗开始了', userInstruction: '这段战斗改紧张点，别动角色性格' });
    expect(result.intent).not.toBeNull();
    expect(result.intent!.change.summary).toBe('战斗改紧张点');
    // F2：IPC 纯代码构 scope.anchor（quote + prefix/suffix 切片 + rangeHint from/to）。
    expect(result.intent!.scope?.anchor.quote).toBe('战斗开始了');
    expect(result.intent!.scope?.anchor.rangeHint).toEqual({ from: 3, to: 8 });
    expect(result.intent!.scope!.anchor.prefix).toContain('前文。'); // slice(3-N, 3)
    expect(result.intent!.scope!.anchor.suffix).toContain('。后文'); // slice(8, 8+N)
  });

  // ── dogfood R2 #90：编译失败分因观测（此前三因混一句「optimizer 不可用 / dispatch 失败 / parse 失败」
  //    + parse 失败 raw 无处可查——用户实碰后无法归因）。三分因 error 文本各一测 + parse 失败 warn 落截断 raw。 ──

  it('#90：runtime 无 runAgentWithExplicitSystem 方法 → 不可用分因文案（不混三因）', async () => {
    runtimeShape.noExplicitSystem = true;
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      selectedPassage: '战斗开始了',
      userInstruction: '改紧张',
      selectionFrom: 0,
      selectionTo: 5,
      draftText: '战斗开始了。后文。',
    })) as { intent: null; error?: string };

    expect(result.intent).toBeNull();
    expect(result.error).toContain('revision-optimizer 不可用');
    // 分因文案不含另两因（不再三因混一句）
    expect(result.error).not.toContain('派发失败');
    expect(result.error).not.toContain('RevisionIntent 结构');
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled(); // 方法缺在 dispatch 前
  });

  it('#90：runAgentWithExplicitSystem 抛错 → dispatch 失败分因文案含 err.message 摘要', async () => {
    runAgentWithExplicitSystem.mockRejectedValue(new Error('LLM provider timeout'));
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      selectedPassage: '战斗开始了',
      userInstruction: '改紧张',
      selectionFrom: 0,
      selectionTo: 5,
      draftText: '战斗开始了。后文。',
    })) as { intent: null; error?: string };

    expect(result.intent).toBeNull();
    expect(result.error).toContain('派发失败');
    expect(result.error).toContain('LLM provider timeout'); // err.message 摘要进文案
    expect(result.error).not.toContain('RevisionIntent 结构'); // 分因不混
  });

  it('#90：optimizer 返超长不合法内容 → parse 失败分因文案（指向日志）+ warn 落截断 raw + contentLength', async () => {
    // 超截断上限（2000）的不合法内容——同测「分类文案」与「raw 截断记日志」两面。
    const badContent = `无法 parse 的内容 ${'x'.repeat(2600)}`;
    runAgentWithExplicitSystem.mockResolvedValue({ content: badContent });
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      selectedPassage: '战斗开始了',
      userInstruction: '改紧张',
      selectionFrom: 0,
      selectionTo: 5,
      draftText: '战斗开始了。后文。',
    })) as { intent: null; error?: string };

    expect(result.intent).toBeNull();
    // 分因文案：输出不符合结构 + 原文长度 + 指向日志（可自诊归因）
    expect(result.error).toContain('不符合 RevisionIntent 结构');
    expect(result.error).toContain(String(badContent.length));
    expect(result.error).toContain('日志');
    expect(result.error).not.toContain('派发失败');
    // 观测面：warn 落截断 raw（≤2000 字防日志分岔）+ contentLength 全长
    expect(logWarn).toHaveBeenCalledTimes(1);
    const payload = logWarn.mock.calls[0][0] as { contentLength: number; raw: string; sessionId: string };
    expect(payload.contentLength).toBe(badContent.length);
    expect(payload.raw).toHaveLength(2000);
    expect(payload.raw.startsWith('无法 parse 的内容 ')).toBe(true); // 截的是头部（保现场）
    expect(payload.sessionId).toBe('sess-1');
  });

  it('Zod 拒（缺 selectedPassage）→ { intent: null, error 含 path }', async () => {
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      userInstruction: '改紧张',
    })) as { intent: null; error?: string };

    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled(); // schema 拒前不派发
    expect(result.intent).toBeNull();
    expect(result.error).toContain('selectedPassage');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood T1 Stage 6（design §4）：链事件透传——registerClosureChainIpc(getWin) 后
// runChapterChain options.emitChainEvent 把 chain-delta / chain-node-done 经
// agent:stream-event 广播（载荷 {...event, sessionId, projectPath}，mirror agentIpc sendEvent）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:run-chapter-chain 链事件透传（dogfood T1 Stage 6）', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    onFieldEdited.mockReset();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'suggest' });
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    allowPath(TEST_DIR);
    send = vi.fn();
  });

  function chainHandlerWithWin(getWin: (() => unknown) | undefined) {
    registerClosureChainIpc(getWin as never);
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function resumeHandlerWithWin(getWin: (() => unknown) | undefined) {
    registerClosureChainIpc(getWin as never);
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('getWin 在 → emitChainEvent 经 agent:stream-event 广播（chain-delta 载荷含 sessionId=stub parent + projectPath）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    // runChapterChain mock：捕获 options.emitChainEvent 并现场发射一条 chain-delta + 一条 node-done。
    runChapterChain.mockImplementation(async (_sid: string, _art: unknown, options: { emitChainEvent?: (e: unknown) => void }) => {
      options.emitChainEvent?.({
        type: 'chain-delta',
        data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', phase: 'writing', messageId: 'm1', delta: '正文片段', seq: 0 },
      });
      options.emitChainEvent?.({ type: 'chain-node-done', data: { nodeId: 'brief-compiler-node', status: 'done' } });
      return SUMMARY_OK;
    });
    const handler = chainHandlerWithWin(() => ({ webContents: { send } }));

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });
    // #93 P0-2：run 入口 direct 档直落成功 → summary 附 chapterPersisted=true。
    expect(summary).toEqual({ ...SUMMARY_OK, chapterPersisted: true });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-delta',
      data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', phase: 'writing', messageId: 'm1', delta: '正文片段', seq: 0 },
      sessionId: 'stub-parent-session-1',
      projectPath: TEST_DIR,
    });
    expect(send).toHaveBeenLastCalledWith('agent:stream-event', {
      type: 'chain-node-done',
      data: { nodeId: 'brief-compiler-node', status: 'done' },
      sessionId: 'stub-parent-session-1',
      projectPath: TEST_DIR,
    });
  });

  it('getWin 缺省（旧调用形态）→ runChapterChain options 不含 emitChainEvent（零事件零回归）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandlerWithWin(undefined);

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    const options = runChapterChain.mock.calls[0][2] as { emitChainEvent?: unknown };
    expect(options.emitChainEvent).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('窗口已关（getWin 返 null）→ 发射不抛（handler 照常返 summary，mirror agentIpc 窗口关闭守卫）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockImplementation(async (_sid: string, _art: unknown, options: { emitChainEvent?: (e: unknown) => void }) => {
      options.emitChainEvent?.({ type: 'chain-delta', data: { nodeId: 'n', role: 'r', messageId: 'm', delta: 'd', seq: 0 } });
      return SUMMARY_OK;
    });
    const handler = chainHandlerWithWin(() => null);

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });
    expect(summary).toEqual({ ...SUMMARY_OK, chapterPersisted: true }); // 不抛——守卫吞掉（#93 直落标记照置）
  });

  it('resume 入口同样透传：emitChainEvent 广播 sessionId = 输入 sessionId（redo 重跑照流）', async () => {
    // resume handler loadProject（onAccept 闭包数据）——缺 doc 会 error 早退。
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockImplementation(async (_sid: string, _art: unknown, options: { emitChainEvent?: (e: unknown) => void }) => {
      options.emitChainEvent?.({ type: 'chain-delta', data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', messageId: 'm2', delta: '改稿片段', seq: 1 } });
      return { ...SUMMARY_OK, status: 'completed' };
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    const handler = resumeHandlerWithWin(() => ({ webContents: { send } }));

    await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-session-9', action: 'redo', feedback: '改紧张' });

    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-delta',
      data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', messageId: 'm2', delta: '改稿片段', seq: 1 },
      sessionId: 'leader-session-9',
      projectPath: TEST_DIR,
    });
  });

  // dogfood T1 check：硬 throw 路径（runChain 外围 infra 失败，非 ChainAbortedError——
  // agent 侧 runChapterChain 只对 abort 补发哨兵）无终态帧且链车道无 done 事件兜底——
  // IPC catch 必须补发 error 哨兵，否则 UI 链卡 + agentRunStates 永久挂 running
  // （isProjectRunActive 全项目闸死）。
  it('run 入口 runChapterChain 硬 throw → 返 error + 补发 error 哨兵终态帧', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockRejectedValue(new Error('dispatch infra failure'));
    const handler = chainHandlerWithWin(() => ({ webContents: { send } }));

    const result = (await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } })) as { status: string };
    expect(result.status).toBe('error');
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-node-done',
      data: { nodeId: '__chain_run__', status: 'error' },
      sessionId: 'stub-parent-session-1',
      projectPath: TEST_DIR,
    });
  });

  it('resume 入口 runChapterChain 硬 throw → 同款 error 哨兵（resume 车道无 done 兜底）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockRejectedValue(new Error('resume infra failure'));
    getChainSnapshot.mockReturnValue({
      completedNodes: ['brief-compiler-node'],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    const handler = resumeHandlerWithWin(() => ({ webContents: { send } }));

    const result = (await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-session-9', action: 'continue' })) as { status: string };
    expect(result.status).toBe('error');
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-node-done',
      data: { nodeId: '__chain_run__', status: 'error' },
      sessionId: 'leader-session-9',
      projectPath: TEST_DIR,
    });
  });

  // dogfood T1 CR-T1-052：resume abort 分支在 emitChainEvent 构造前 return——零链事件会让
  // UI 链卡停在 paused 僵尸态（finalizeChainRun 见 paused 早退，永无终态）。补发 aborted 哨兵。
  it('resume abort（确有 paused 链被清）→ 补发 aborted 哨兵终态帧（UI 链卡出 paused 僵尸态）', async () => {
    clearChainSnapshot.mockReturnValue(true);
    const handler = resumeHandlerWithWin(() => ({ webContents: { send } }));

    const result = await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-session-9', action: 'abort' });
    expect(result).toEqual({ status: 'aborted', errors: [] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-node-done',
      data: { nodeId: '__chain_run__', status: 'aborted' },
      sessionId: 'leader-session-9',
      projectPath: TEST_DIR,
    });
  });

  it('resume abort 无 paused 链（cleared=false）→ 零链事件（不误翻既有链态）', async () => {
    clearChainSnapshot.mockReturnValue(false);
    const handler = resumeHandlerWithWin(() => ({ webContents: { send } }));

    const result = (await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-session-9', action: 'abort' })) as { status: string; errors: string[] };
    expect(result.status).toBe('aborted');
    expect(result.errors).toHaveLength(1); // 'no paused chain to abort' 告知
    expect(send).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 风格卡片 MVP CR-026（08-28 BMad CR auditor#3）：IPC 写章入口 style_context 注入。
// 验：有卡（settings/style.md 存在）→ initialArtifacts['style_context'] 含全量版编译
//     （① 声音画像 + ⑬ fenced 节选），与 leader write_chapter 路径同口径（agent 包
//     readStyleCardBody + buildStyleContext 单源真导入）；无卡 → 不注入该 key（零回归）。
// style_context_brief 恒不注入——planner 派发侧（dispatch-planners）现读现编非链内
// artifact（CR-006 同判）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:run-chapter-chain style_context 注入（风格卡 CR-026）', () => {
  const WITH_STYLE_DIR = path.join(TEST_DIR, 'cr026-with-style');
  const NO_STYLE_DIR = path.join(TEST_DIR, 'cr026-no-style');

  beforeAll(() => {
    mkdirSync(path.join(WITH_STYLE_DIR, 'settings'), { recursive: true });
    writeFileSync(
      path.join(WITH_STYLE_DIR, 'settings', 'style.md'),
      [
        '# 风格卡片',
        '',
        '## ① 声音画像',
        '',
        '叙述者冷静克制，带一点温柔的讽刺；对读者像老友谈天。',
        '',
        '## ⑬ 节选（few-shot 原文范本）',
        '',
        '```text',
        '夜色压下来，他数着窗外的灯。一盏、两盏——第三盏灭了。',
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );
  });
  afterAll(() => {
    rmSync(WITH_STYLE_DIR, { recursive: true, force: true });
    rmSync(NO_STYLE_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1' });
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('CR-026：有卡项目 → initialArtifacts 含 style_context（声音画像 + fenced 节选，同 leader 路径口径）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    await handler({}, { projectPath: WITH_STYLE_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [, artifacts] = runChapterChain.mock.calls[0];
    const styleContext = artifacts['style_context'];
    expect(typeof styleContext).toBe('string');
    expect(styleContext as string).toContain('声音画像');
    expect(styleContext as string).toContain('夜色压下来，他数着窗外的灯');
    // style_context_brief 恒不注入（planner 派发侧现读现编——CR-006）。
    expect('style_context_brief' in artifacts).toBe(false);
  });

  it('CR-026：无卡项目 → 不注入 style_context（IPC 输出与旧版一致，零回归）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    await handler({}, { projectPath: NO_STYLE_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [, artifacts] = runChapterChain.mock.calls[0];
    expect('style_context' in artifacts).toBe(false);
    expect('style_context_brief' in artifacts).toBe(false);
  });
});
