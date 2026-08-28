/**
 * Story 4.3 Step 4（design §3.6 / §5）：chapterReviewSlice 行为测。
 * Story 7.1 B1（design §4.2）：选区指挥精修扩展（compileIntent / confirmRedoWithIntent / B1 state）测。
 *
 * 覆盖：
 * - setPausedReview：metadata 落 state。
 * - 三动作（continue/redo/abort）调 shared/api resumeChapterChain（→ closure:resume-chapter-chain IPC）
 *   + 据返回 summary 和解 pausedReview（completed/aborted → clear；paused → 更新下一 checkpoint 载荷；error → clear + 不静默）。
 * - registerProjectReset：项目切换清 pausedReview（跨项目不泄漏，[[state-management]] 硬约束）。
 * - Story 7.1 B1：compileIntent 调 compileRevisionIntent IPC + 和解（intent 非空 → compiledIntent；
 *   null/error → intentCompileError）；confirmRedoWithIntent 调 resume redo + revisionIntent 透传 + 清 B1 state；
 *   setReviewSelection / clearCompiledIntent；项目隔离 reset 清 B1 state。
 *
 * 范式判据：slice 只路由 metadata + 派发机械控制信号；resume 结果和解除纯代码确定性。
 *
 * 测试照 ui/testing.md seam-mock 约定：只组合被测 slice + 必要 deps + vi.mock shared/api/agent
 * （slice 经分层约束不直连 window，照 writeChapterTrigger 模式 vi.mock）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { createChapterReviewSlice, type ChapterReviewSlice } from '../src/shared/store/chapterReviewSlice';
import { runProjectResets } from '../src/shared/store/resetRegistry';
import { __clearAgentEventTracks, rememberSessionProject } from '../src/shared/store/agentEvents';
import { useToastStore } from '../src/shared/store/toastStore';
import type {
  ChapterReviewMetadata,
  CompileRevisionIntentResult,
  RevisionIntent,
  RunChapterChainSummary,
} from '@orison/shared-contracts';

// Mock the agent api module（slice 经 shared/api 分层约束，不直连 window——照 writeChapterTrigger 模式 vi.mock）。
const apiMocks = vi.hoisted(() => ({
  resumeChapterChain: vi.fn(async () => ({ status: 'completed', errors: [] }) as RunChapterChainSummary),
  compileRevisionIntent: vi.fn(async () => ({ intent: null }) as CompileRevisionIntentResult),
}));
vi.mock('../src/shared/api/agent', () => apiMocks);

declare global {
  interface Window {
    orisonDesktop: any;
  }
}

type TestState = ChapterReviewSlice & {
  currentProject: { path?: string } | null;
  agentSessionId: string | null;
  resolvedLocale: string;
  /** dogfood T1 CR-T1-027：busy 拒绝 toast 的一键跳转（占用者会话）。 */
  switchAgentSession: (sessionId: string) => Promise<void>;
  setPendingPatch: (sessionId: string, patch: import('@orison/shared-contracts').ProjectFieldPatch | null) => void;
};

const pendingPatchSpy = vi.fn();
const switchAgentSessionSpy = vi.fn(async () => {});

const useTestStore = create<TestState>()((...a) => ({
  ...createChapterReviewSlice(...a),
  currentProject: { path: '/proj' },
  agentSessionId: 'session-1',
  resolvedLocale: 'en-US',
  switchAgentSession: switchAgentSessionSpy,
  setPendingPatch: pendingPatchSpy,
}));

const draftMeta: ChapterReviewMetadata = {
  type: 'chapter_review',
  stage: 'draft',
  chapterId: 'ch_001',
  draftContent: '第一章草稿正文…',
  resumeOptions: ['continue', 'redo', 'abort'],
};

function makeSummary(overrides: Partial<RunChapterChainSummary> = {}): RunChapterChainSummary {
  return { status: 'completed', errors: [], ...overrides };
}

const SAMPLE_INTENT: RevisionIntent = {
  change: { summary: '把战斗节奏改紧张' },
  lockedItems: [
    { field: '角色性格', authority: 'hard', evidence: '别动角色性格' },
    { field: '结论', authority: 'soft' },
  ],
  rationale: { source: 'user-directive', note: '用户选段指挥精修' },
  provenance: {
    rawUserInstruction: '这段战斗改紧张点，别动角色性格',
    compilerNote: '锁定角色性格',
  },
  scope: {
    anchor: { quote: '战斗开始了', prefix: '前文。', suffix: '。后文', rangeHint: { from: 3, to: 8 } },
    chapterId: 'ch_001',
  },
};

beforeEach(() => {
  __clearAgentEventTracks(); // CR-T1-025 用例间隔离（rememberSessionProject 模块级 Map）
  apiMocks.resumeChapterChain.mockReset();
  apiMocks.resumeChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
  apiMocks.compileRevisionIntent.mockReset();
  apiMocks.compileRevisionIntent.mockResolvedValue({ intent: null });
  pendingPatchSpy.mockReset();
  switchAgentSessionSpy.mockReset();
  useToastStore.setState({ toasts: [] });
  useTestStore.setState({
    pausedReviewBySession: {},
    reviewResuming: false,
    reviewSelection: null,
    compiledIntent: null,
    intentCompiling: false,
    intentCompileError: null,
    currentProject: { path: '/proj' },
    agentSessionId: 'session-1',
    resolvedLocale: 'en-US',
  });
});

describe('chapterReviewSlice — setPausedReview', () => {
  it('落 metadata 到 pausedReview', () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toEqual(draftMeta);
  });

  it('null 清空 pausedReview', () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.getState().setPausedReview('session-1', null);
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });
});

describe('chapterReviewSlice — reviewContinue', () => {
  it('调 resumeChapterChain IPC（action=continue + projectPath + sessionId + chapterId 透传）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewContinue();

    expect(apiMocks.resumeChapterChain).toHaveBeenCalledTimes(1);
    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      projectPath: '/proj',
      sessionId: 'session-1',
      chapterId: 'ch_001',
      action: 'continue',
    });
    // completed → 清 pausedReview。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(useTestStore.getState().reviewResuming).toBe(false);
  });

  it('completed summary → 清 pausedReview（panel 卸载）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewContinue();

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });

  it('aborted summary → 清 pausedReview', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewContinue();

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });

  it('paused summary → 更新 pausedReview 渲染下一 checkpoint 载荷（chapterId 保留透传）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    // continue 后链段跑 review→route→verdict checkpoint 又停（半自动 verdict pause）。
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'paused', pausedStage: 'verdict' }),
    );

    await useTestStore.getState().reviewContinue();

    const next = (useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null);
    expect(next).not.toBeNull();
    expect(next?.stage).toBe('verdict');
    // chapterId 保留透传（resume summary 不回传；前一轮的避免丢失追踪）。
    expect(next?.chapterId).toBe('ch_001');
    expect(next?.resumeOptions).toEqual(['continue', 'redo', 'abort']);
  });

  it('error summary → 清 pausedReview（不静默，不抛）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'error', errors: ['loadProject failed: boom'] }),
    );

    await useTestStore.getState().reviewContinue();

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(useTestStore.getState().reviewResuming).toBe(false);
  });

  it('IPC throw → 清 pausedReview + 不抛（graceful，留死面板是 bug）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockRejectedValue(new Error('IPC 下线'));

    await expect(useTestStore.getState().reviewContinue()).resolves.toBeUndefined();

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(useTestStore.getState().reviewResuming).toBe(false);
  });

  it('无 project / sessionId → no-op（不调 IPC）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.setState({ currentProject: null });

    await useTestStore.getState().reviewContinue();

    expect(apiMocks.resumeChapterChain).not.toHaveBeenCalled();
  });
});

describe('chapterReviewSlice — reviewRedo', () => {
  it('调 IPC（action=redo + feedback 透传，仅 redo 带 feedback）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'paused', pausedStage: 'draft' }));

    await useTestStore.getState().reviewRedo('把开头改得更紧张');

    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      action: 'redo',
      feedback: '把开头改得更紧张',
    });
  });

  it('空 feedback → 不传 feedback 字段（redo 无指令重跑合法）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);

    await useTestStore.getState().reviewRedo(undefined);

    const call = apiMocks.resumeChapterChain.mock.calls[0][0];
    expect(call.action).toBe('redo');
    expect(call.feedback).toBeUndefined();
  });

  it('redo 后再 paused（draft 重跑完又停 draft checkpoint）→ 更新 pausedReview', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'paused', pausedStage: 'draft', draftContent: '改后的草稿…' }),
    );

    await useTestStore.getState().reviewRedo('改');

    const next = (useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null);
    expect(next?.stage).toBe('draft');
    expect(next?.draftContent).toBe('改后的草稿…');
  });
});

describe('chapterReviewSlice — reviewAbort', () => {
  it('调 IPC（action=abort，不带 feedback）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewAbort();

    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      action: 'abort',
    });
    expect(apiMocks.resumeChapterChain.mock.calls[0][0].feedback).toBeUndefined();
    // aborted → 清 pausedReview。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });
});

describe('chapterReviewSlice — CR-004 store guard（程序化双触发单 IPC）', () => {
  it('reviewResuming=true 时再调 reviewContinue → no-op（不二次调 IPC，防快捷键/双 Enter 竞态）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    // 模拟首 IPC 在 flight：store guard 读 reviewResuming=true 直接 return。
    useTestStore.setState({ reviewResuming: true });
    apiMocks.resumeChapterChain.mockClear();

    await useTestStore.getState().reviewContinue();

    // guard 挡住：不调 IPC，不改 reviewResuming（保持 true，由首 IPC 释放）。
    expect(apiMocks.resumeChapterChain).not.toHaveBeenCalled();
    expect(useTestStore.getState().reviewResuming).toBe(true);
  });

  it('两动作并发触发（reviewContinue + reviewRedo 同步连调，首 IPC 未 set 重渲染前）→ 仅首调 IPC', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    // 同步连调两次（不经 await），模拟快捷键/双 Enter 在 React 重渲染前竞态。
    const p1 = useTestStore.getState().reviewContinue();
    const p2 = useTestStore.getState().reviewRedo('改');
    await Promise.all([p1, p2]);

    // store guard：第二次调用时 reviewResuming 已被首次 set=true → return → 单 IPC。
    expect(apiMocks.resumeChapterChain).toHaveBeenCalledTimes(1);
  });
});

describe('chapterReviewSlice — CR-002 项目切换 mid-resume 丢弃老结果', () => {
  /** deferred：控制 IPC resolve/reject 时序，模拟 await 期间切项目。 */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('await 期间切项目 → IPC 返 paused summary 不写回新项目 pausedReview（丢弃 + 释放 guard）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const { promise, resolve } = deferred<RunChapterChainSummary>();
    apiMocks.resumeChapterChain.mockReturnValue(promise);

    const inflight = useTestStore.getState().reviewContinue();
    // IPC 在 flight 时切项目（registerProjectReset 清了 pausedReview + currentProject 变更）。
    useTestStore.setState({ pausedReviewBySession: {}, currentProject: { path: '/other-proj' } });

    // resolve 老 IPC（返 paused summary——若不复核会写回新项目 pausedReview）。
    resolve(makeSummary({ status: 'paused', pausedStage: 'verdict' }));
    await inflight;

    // CR-002：老结果丢弃——新项目不该见老链段 pausedReview。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    // guard 释放。
    expect(useTestStore.getState().reviewResuming).toBe(false);
  });

  it('await 期间切项目 → IPC 返 error summary 不 toast 老 project 错误到新项目', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const { promise, resolve } = deferred<RunChapterChainSummary>();
    apiMocks.resumeChapterChain.mockReturnValue(promise);
    const toastSpy = vi.spyOn(useToastStore.getState(), 'showToast');

    const inflight = useTestStore.getState().reviewContinue();
    useTestStore.setState({ pausedReviewBySession: {}, currentProject: { path: '/other-proj' } });
    resolve(makeSummary({ status: 'error', errors: ['老项目崩了'] }));
    await inflight;

    // CR-002：error 也不 toast 到新项目（静默丢弃）。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(useTestStore.getState().reviewResuming).toBe(false);
    expect(toastSpy).not.toHaveBeenCalled();
    toastSpy.mockRestore();
  });

  it('await 期间切项目 → IPC throw 也不 toast（静默丢弃，不污染新项目）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const { promise, reject } = deferred<RunChapterChainSummary>();
    apiMocks.resumeChapterChain.mockReturnValue(promise);
    const toastSpy = vi.spyOn(useToastStore.getState(), 'showToast');

    const inflight = useTestStore.getState().reviewContinue();
    useTestStore.setState({ pausedReviewBySession: {}, currentProject: { path: '/other-proj' } });
    reject(new Error('IPC 下线'));
    await inflight;

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(useTestStore.getState().reviewResuming).toBe(false);
    expect(toastSpy).not.toHaveBeenCalled();
    toastSpy.mockRestore();
  });

  it('未切项目（await 前后同 path）→ paused summary 正常写回（CR-002 不误伤 happy path）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'paused', pausedStage: 'verdict' }));

    await useTestStore.getState().reviewContinue();

    // 同项目 → paused summary 正常更新 pausedReview（happy path 不丢）。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).not.toBeNull();
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)?.stage).toBe('verdict');
  });
});

describe('chapterReviewSlice — 项目隔离 reset', () => {
  it('runProjectResets 清无归属的 pausedReview 残键（跨项目不泄漏）', () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).not.toBeNull();

    runProjectResets();

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(useTestStore.getState().reviewResuming).toBe(false);
  });

  // dogfood T1 CR-T1-025：「等待用户」挂起键按定义不再产事件——项目重置销毁 = 切回后审阅面板
  // 永久丢（主进程 run 死等只能 abort 救）。有归属（agentEvents 登记）的键跨项目存活；
  // 渲染面按 sessionId 键控隔离（ChapterReviewPanel 只读视图会话的键），不靠删除。
  it('CR-T1-025：有归属的挂起键跨项目存活（切回再现）——离开项目不再销毁', () => {
    rememberSessionProject('session-attr', '/proj-a');
    useTestStore.getState().setPausedReview('session-attr', draftMeta);

    // 切到别的项目（reset 时 currentProject 已是新项目）。
    useTestStore.setState({ currentProject: { path: '/proj-b' } });
    runProjectResets();

    expect(useTestStore.getState().pausedReviewBySession['session-attr']).toBeDefined();
    // 渲染面按 sessionId 键控隔离（ChapterReviewPanel 只读视图会话的键），不靠删除。
  });

  it('runProjectResets 清 Story 7.1 B1 state（reviewSelection / compiledIntent / compileError）', () => {
    useTestStore.setState({
      reviewSelection: { text: '战斗开始了', from: 0, to: 5 },
      compiledIntent: SAMPLE_INTENT,
      intentCompileError: 'boom',
      intentCompiling: true,
    });
    runProjectResets();

    expect(useTestStore.getState().reviewSelection).toBeNull();
    expect(useTestStore.getState().compiledIntent).toBeNull();
    expect(useTestStore.getState().intentCompileError).toBeNull();
    expect(useTestStore.getState().intentCompiling).toBe(false);
  });
});

// ── Story 7.1 B1：compileIntent / confirmRedoWithIntent / B1 state ──

describe('chapterReviewSlice — setReviewSelection', () => {
  it('落 SelectionInfo 到 reviewSelection', () => {
    useTestStore.getState().setReviewSelection({ text: '战斗开始了', from: 0, to: 5 });
    expect(useTestStore.getState().reviewSelection).toEqual({ text: '战斗开始了', from: 0, to: 5 });
  });

  it('null 清空 reviewSelection', () => {
    useTestStore.getState().setReviewSelection({ text: '战斗开始了', from: 0, to: 5 });
    useTestStore.getState().setReviewSelection(null);
    expect(useTestStore.getState().reviewSelection).toBeNull();
  });
});

describe('chapterReviewSlice — compileIntent', () => {
  it('调 compileRevisionIntent IPC（selectedPassage + userInstruction + chapterContext 透传）', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: SAMPLE_INTENT });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。', '{"goal":"x"}');

    expect(apiMocks.compileRevisionIntent).toHaveBeenCalledTimes(1);
    expect(apiMocks.compileRevisionIntent.mock.calls[0][0]).toMatchObject({
      projectPath: '/proj',
      sessionId: 'session-1',
      selectedPassage: '战斗开始了',
      userInstruction: '改紧张点',
      chapterContext: '{"goal":"x"}',
    });
  });

  it('IPC 不传 chapterContext（缺省 undefined）', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: SAMPLE_INTENT });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    const call = apiMocks.compileRevisionIntent.mock.calls[0][0];
    expect(call.chapterContext).toBeUndefined();
  });

  it('返 intent 非空 → 落 compiledIntent + 清 error + intentCompiling=false', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: SAMPLE_INTENT });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(useTestStore.getState().compiledIntent).toEqual(SAMPLE_INTENT);
    expect(useTestStore.getState().intentCompileError).toBeNull();
    expect(useTestStore.getState().intentCompiling).toBe(false);
  });

  it('返 intent=null + error → 落 intentCompileError（graceful，不假信心不静默）', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: null, error: 'optimizer timeout' });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(useTestStore.getState().compiledIntent).toBeNull();
    expect(useTestStore.getState().intentCompileError).toBe('optimizer timeout');
    expect(useTestStore.getState().intentCompiling).toBe(false);
  });

  it('返 intent=null 无 error → 用默认兜底文案（不静默）', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: null });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(useTestStore.getState().compiledIntent).toBeNull();
    expect(useTestStore.getState().intentCompileError).toBeTruthy();
    expect(useTestStore.getState().intentCompileError).not.toBe('');
  });

  it('IPC throw → 落 intentCompileError（graceful，不抛）', async () => {
    apiMocks.compileRevisionIntent.mockRejectedValue(new Error('IPC 下线'));

    await expect(
      useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。'),
    ).resolves.toBeUndefined();

    expect(useTestStore.getState().compiledIntent).toBeNull();
    expect(useTestStore.getState().intentCompileError).toBe('IPC 下线');
    expect(useTestStore.getState().intentCompiling).toBe(false);
  });

  it('intentCompiling=true 时再调 → no-op（防双触发）', async () => {
    useTestStore.setState({ intentCompiling: true });
    apiMocks.compileRevisionIntent.mockClear();

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(apiMocks.compileRevisionIntent).not.toHaveBeenCalled();
  });

  it('无 project / sessionId → no-op', async () => {
    useTestStore.setState({ currentProject: null });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(apiMocks.compileRevisionIntent).not.toHaveBeenCalled();
  });

  it('await 期间切项目 → IPC 返 intent 不写回新项目 compiledIntent（丢弃 + 释放 guard）', async () => {
    /** deferred：控制 IPC resolve 时序，模拟 await 期间切项目。 */
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }
    const { promise, resolve } = deferred<CompileRevisionIntentResult>();
    apiMocks.compileRevisionIntent.mockReturnValue(promise);

    const inflight = useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');
    useTestStore.setState({ currentProject: { path: '/other-proj' } });
    resolve({ intent: SAMPLE_INTENT });
    await inflight;

    // CR-002 同款：老结果丢弃——新项目不该见老 compiledIntent。
    expect(useTestStore.getState().compiledIntent).toBeNull();
    expect(useTestStore.getState().intentCompiling).toBe(false);
  });
});

describe('chapterReviewSlice — confirmRedoWithIntent', () => {
  it('调 resumeChapterChain IPC（action=redo + revisionIntent 透传 + 清 B1 state）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.setState({
      reviewSelection: { text: '战斗开始了', from: 0, to: 5 },
      compiledIntent: SAMPLE_INTENT,
      intentCompileError: 'stale error',
    });
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    expect(apiMocks.resumeChapterChain).toHaveBeenCalledTimes(1);
    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      projectPath: '/proj',
      sessionId: 'session-1',
      chapterId: 'ch_001',
      action: 'redo',
      revisionIntent: SAMPLE_INTENT,
    });
    // B1 state 清空。
    expect(useTestStore.getState().compiledIntent).toBeNull();
    expect(useTestStore.getState().reviewSelection).toBeNull();
    expect(useTestStore.getState().intentCompileError).toBeNull();
  });

  it('不传 feedback（intent 单独触发，C-trigger feedback 路径不混）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    expect(apiMocks.resumeChapterChain.mock.calls[0][0].feedback).toBeUndefined();
    expect(apiMocks.resumeChapterChain.mock.calls[0][0].revisionIntent).toEqual(SAMPLE_INTENT);
  });

  it('paused summary → 更新 pausedReview（链段在下一 checkpoint 又停，B1 state 已清）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.setState({
      compiledIntent: SAMPLE_INTENT,
    });
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'paused', pausedStage: 'draft', draftContent: '改后正文…' }),
    );

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    const next = (useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null);
    expect(next?.stage).toBe('draft');
    expect(next?.draftContent).toBe('改后正文…');
    // B1 state 已清（避免下一 checkpoint 残留旧 intent card）。
    expect(useTestStore.getState().compiledIntent).toBeNull();
    expect(useTestStore.getState().reviewResuming).toBe(false);
  });

  it('completed summary → 清 pausedReview', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });

  it('reviewResuming=true 时再调 → no-op（防重入）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.setState({ reviewResuming: true });
    apiMocks.resumeChapterChain.mockClear();

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    expect(apiMocks.resumeChapterChain).not.toHaveBeenCalled();
  });
});

describe('chapterReviewSlice — clearCompiledIntent', () => {
  it('清 compiledIntent + intentCompileError', () => {
    useTestStore.setState({
      compiledIntent: SAMPLE_INTENT,
      intentCompileError: 'stale',
    });

    useTestStore.getState().clearCompiledIntent();

    expect(useTestStore.getState().compiledIntent).toBeNull();
    expect(useTestStore.getState().intentCompileError).toBeNull();
  });
});

// ── Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺路由（shell applyStorySyncOnResume 产出消费）──

// ═══════════════════════════════════════════════════════════════════════════
// dogfood R2 #93（P0-2/P0-3，2026-08-28）：resume 终态 chapter_accept envelope 路由 + 完成回报。
// resume 车道跑在 leader 工具调用生命周期外——write_chapter 的 metadata field_patch 通道走不到，
// envelope 只能经 resume summary 返 UI（shell review 档不直落）。此处 mirror agentEvents 的
// field_patch 路由形态（field/action/data 与 write-chapter.ts metadata 组装逐字段对齐）。
// ═══════════════════════════════════════════════════════════════════════════

describe('chapterReviewSlice — #93 P0-2/P0-3 resume 终态 chapter_accept envelope 路由', () => {
  const ACCEPT = {
    chapterId: 'ch_001',
    candidate: { title: '第二章 B 城', content: '正文…', wordCount: 2800 },
    runId: 'run_mock',
  };

  it('completed + chapter_accept + 未直落 → setPendingPatch（chapter_candidate entry，mirror leader metadata 形态）+ 完成 toast', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      draftTitle: '第二章 B 城',
      draftWordCount: 2800,
      routeDecision: { decision: 'accept_as_truth', reason: '正文升级' },
      chapter_accept: ACCEPT,
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).toHaveBeenCalledTimes(1);
    const [sid, patch] = pendingPatchSpy.mock.calls[0] as [string, import('@orison/shared-contracts').ProjectFieldPatch];
    expect(sid).toBe('session-1');
    expect(patch.runId).toBe('session-1');
    expect(patch.patches).toHaveLength(1);
    expect(patch.patches[0].field).toBe('chapter_candidate');
    expect(patch.patches[0].action).toBe('set');
    expect(patch.patches[0].generatedBy).toBe('write_chapter');
    expect(patch.patches[0].data).toMatchObject({ chapterId: 'ch_001', runId: 'run_mock' });
    // P0-3 完成回报：toast 含标题 + 字数 + 下一步动作（去审阅）。
    const toastText = String(showToast.mock.calls[0][0]);
    expect(toastText).toContain('写章完成');
    expect(toastText).toContain('第二章 B 城');
    expect(toastText).toContain('2800');
    expect(toastText).toContain('待审阅');
    showToast.mockRestore();
  });

  it('completed + escalate 路由 + chapter_accept → 同样 stage + 灰区裁决 toast（PatchReview accept=接受为真相）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      routeDecision: { decision: 'escalate_user', reason: '灰区' },
      chapter_accept: ACCEPT,
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).toHaveBeenCalledTimes(1);
    expect(String(showToast.mock.calls[0][0])).toContain('灰区裁决');
    showToast.mockRestore();
  });

  it('completed + chapterPersisted（auto 档 shell 已直落）→ 不 stage（防双写）+ 落盘 toast', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      draftTitle: '第二章 B 城',
      routeDecision: { decision: 'accept_as_truth', reason: 'r' },
      chapter_accept: ACCEPT,
      chapterPersisted: true,
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    const toastText = String(showToast.mock.calls[0][0]);
    expect(toastText).toContain('写章完成');
    expect(toastText).toContain('已直接落盘');
    showToast.mockRestore();
  });

  it('completed + accept 路由但无 envelope（章映射失败 skip）→ 不 stage + error toast 透传 errors（不静默）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      routeDecision: { decision: 'accept_as_truth', reason: 'r' },
      errors: ['accept 未持久化——章未在 project.yaml 注册或映射歧义'],
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    const toastText = String(showToast.mock.calls[0][0]);
    expect(toastText).toContain('未生成章节候选');
    expect(toastText).toContain('accept 未持久化');
    showToast.mockRestore();
  });

  it('completed + escalate 路由但无 envelope（灰区无候选——shell review 档 errors 文案）→ 不 stage + error toast 消费（check 补：escalate 分支不静默）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      routeDecision: { decision: 'escalate_user', reason: '灰区' },
      errors: ['灰区上发：无章节候选（章未在 project.yaml 注册或映射歧义）——无法落盘，请在对话中裁决处理'],
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    const toastText = String(showToast.mock.calls[0][0]);
    expect(toastText).toContain('未生成章节候选');
    expect(toastText).toContain('灰区上发');
    expect(toastText).toContain('请在对话中裁决处理');
    showToast.mockRestore();
  });

  it('aborted → 无 envelope 路由零动作（弃链段无候选可审）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    showToast.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dogfood R2 #83/#84（2026-08-28）：挂起 pause 载荷透传——resume 后再挂起时 metadataFromPausedSummary
// 须带 researchSuspension + resumeOptions=['redo','abort']（无 continue：挂起无正文可续，continue 是
// 死循环入口）。
// ═══════════════════════════════════════════════════════════════════════════

describe('chapterReviewSlice — #83/#84 挂起 pause 载荷透传（metadataFromPausedSummary）', () => {
  it('paused summary 带 researchSuspension → meta 透传挂起载荷 + resumeOptions 无 continue', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'paused',
      pausedStage: 'draft',
      researchSuspension: {
        kind: 'research_contradiction',
        rounds: 1,
        evidence: {
          contradictions: [{ desc: '爽点底线 vs 女主第一章未登场', severity: 'contradiction' }],
          deviations: [],
        },
      },
    }));

    await useTestStore.getState().reviewContinue();

    const next = useTestStore.getState().pausedReviewBySession['session-1'];
    expect(next).not.toBeNull();
    expect(next?.researchSuspension?.kind).toBe('research_contradiction');
    expect(next?.researchSuspension?.evidence?.contradictions).toHaveLength(1);
    // 挂起恢复只有 redo（无 continue）——#84 死循环入口封死。
    expect(next?.resumeOptions).toEqual(['redo', 'abort']);
  });

  it('paused summary 无挂起载荷（真 draft checkpoint）→ 三钮照旧（零回归）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'paused', pausedStage: 'draft', draftContent: '改后的草稿…' }),
    );

    await useTestStore.getState().reviewContinue();

    const next = useTestStore.getState().pausedReviewBySession['session-1'];
    expect(next?.researchSuspension).toBeUndefined();
    expect(next?.resumeOptions).toEqual(['continue', 'redo', 'abort']);
  });
});

describe('chapterReviewSlice — resume 终态反哺路由（storySyncReview / storySyncLanded）', () => {
  it('storySyncReview（suggest 人审档）→ setPendingPatch 进 PatchReview + info toast（非静默）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      storySyncReview: {
        note: '章节 ch_001 story-sync 提取',
        patches: [
          { field: 'world_setting', action: 'set', data: { premise: 'x' }, fieldVersion: 1, generatedBy: 'story-sync-agent' },
        ],
      },
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).toHaveBeenCalledTimes(1);
    const patch = pendingPatchSpy.mock.calls[0][1]!;
    expect(patch.patches).toHaveLength(1);
    expect(patch.patches[0].field).toBe('world_setting');
    expect(patch.patches[0].generatedBy).toBe('story-sync-agent');
    expect(String(showToast.mock.calls[0][0])).toContain('待审阅');
  });

  it('storySyncLanded（auto 直落档）→ success toast，不 stage patch', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      storySyncLanded: { note: '章节 ch_001 story-sync 提取', fields: ['world_setting', 'asset_cards'] },
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    expect(String(showToast.mock.calls[0][0])).toContain('已自动落盘');
    expect(String(showToast.mock.calls[0][0])).toContain('world_setting');
  });

  it('无反哺载荷（缺省）→ 零动作（无 stage 无 toast）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// dogfood T1 CR-T1-027：链 IPC busy 拒绝（机器串）消费——project_run_active / chain_run_active
// 前缀解析为人话 + 跳转；pausedReview 保留（run 未启动，busy run 结束后可重试——旧实现
// join(';') 透出机器串 + 误清面板丢 resume 能力）。
// ═════════════════════════════════════════════════════════════════════════════
describe('chapterReviewSlice — CR-T1-027 busy 拒绝（机器串解析）', () => {
  it('project_run_active → pausedReview 保留 + reviewResuming 复位 + busy toast 带跳转（占用会话）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'error',
      errors: ['project_run_active|heldBy=sess-other|project=/proj'],
    }));
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    await useTestStore.getState().reviewContinue();

    // 面板保留（busy run 未动 chainSnapshot——结束后可重试），不透出机器串。
    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(useTestStore.getState().reviewResuming).toBe(false);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(String(showToast.mock.calls[0][0])).not.toContain('project_run_active');
    const action = showToast.mock.calls[0][3] as { label: string; onClick: () => void } | undefined;
    expect(action?.label).toBeTruthy(); // 一键跳转钮（与 chat 路径同款体验）
    action?.onClick();
    expect(switchAgentSessionSpy).toHaveBeenCalledWith('sess-other');
    showToast.mockRestore();
  });

  it('chain_run_active（agent 层链守卫，批2 前缀）→ pausedReview 保留 + 提示等待（无跳转钮）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'error',
      errors: ['chain_run_active|heldBy=sess-leader'],
    }));
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    await useTestStore.getState().reviewContinue();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(useTestStore.getState().reviewResuming).toBe(false);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(String(showToast.mock.calls[0][0])).not.toContain('chain_run_active');
    expect(showToast.mock.calls[0][3]).toBeUndefined(); // 链在跑——跳过去也只能等，无跳转钮
    expect(switchAgentSessionSpy).not.toHaveBeenCalled();
    showToast.mockRestore();
  });

  it('占用者为链租约 id（chain-run:closure:*）→ 换文案无跳转（CR-T1-030——stub 会话不可跳）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'error',
      errors: ['project_run_active|heldBy=chain-run:closure:9f0e|project=/proj'],
    }));
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    await useTestStore.getState().reviewContinue();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][3]).toBeUndefined(); // 无跳转
    expect(switchAgentSessionSpy).not.toHaveBeenCalled();
    showToast.mockRestore();
  });

  it('非 busy error（无前缀）→ 既有行为不变：清 pausedReview + 通用失败 toast', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'error',
      errors: ['chapter chain failed: boom'],
    }));
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    await useTestStore.getState().reviewContinue();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeUndefined();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(String(showToast.mock.calls[0][0])).toContain('boom');
    showToast.mockRestore();
  });
});
