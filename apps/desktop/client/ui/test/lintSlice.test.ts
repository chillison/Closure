import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { createLintSlice, type LintSlice } from '../src/shared/store/lintSlice';
import { runProjectResets } from '../src/shared/store/resetRegistry';
import { useToastStore } from '../src/shared/store/toastStore';
import type { LintFullReport, LintScanFullResult } from '@orison/shared-contracts';

declare global {
  interface Window {
    orisonDesktop: any;
  }
}

type TestState = LintSlice & {
  currentProject: { path?: string } | null;
  resolvedLocale: string;
  reloadFile: (path: string) => Promise<void>;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: { path: 'C:/proj' },
  resolvedLocale: 'en-US',
  reloadFile: vi.fn(async () => undefined),
  ...createLintSlice(...args),
}));

const SAMPLE_REPORT: LintFullReport = {
  chapters: [
    {
      chapterId: 'ch_001',
      issues: [],
      densityIssues: [],
      summary: { total: 0, high: 0, medium: 0, low: 0, visibleChars: 10 },
      upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
    },
  ],
  generatedAt: '2026-08-21T00:00:00.000Z',
  stats: { chapters: 1, total: 0, high: 0, medium: 0, low: 0, densityIssues: 0 },
};

const SAMPLE_SCAN: LintScanFullResult = {
  ok: true,
  report: SAMPLE_REPORT,
  chapterFiles: [{ chapterId: 'ch_001', title: '第一章', filePath: 'C:/proj/chapters/ch_001.md' }],
  fixPatches: [
    {
      chapterId: 'ch_001',
      filePath: 'C:/proj/chapters/ch_001.md',
      ruleId: 'mechanical-zero-width',
      span: { line: 1, column: 3, endLine: 1, endColumn: 3 },
      replacements: [''],
    },
  ],
  // CR-011 批 A 字段：跳章清单透传（UI skipped 摘要行的数据源）。
  skipped: [{ chapterId: 'ch_002', reason: 'not-landed' }],
};

function resetLintState() {
  useTestStore.setState({
    currentProject: { path: 'C:/proj' },
    resolvedLocale: 'en-US',
    lintReport: null,
    lintChapterFiles: [],
    lintSkipped: [],
    lintFixPatches: [],
    lintClassifyResult: null,
    lintModelAvailable: null,
    lintScanning: false,
    lintClassifying: false,
    lintApplying: false,
    lintSeverityFilter: 'all',
    lintSelectedChapterIds: [],
    lintConfirmOpen: false,
    reloadFile: vi.fn(async () => undefined),
  });
}

describe('lintSlice', () => {
  beforeEach(() => {
    resetLintState();
    useToastStore.setState({ toasts: [] });
    (globalThis.window as any) = globalThis.window ?? {};
    (window as any).orisonDesktop = {
      lintScanFull: vi.fn(async () => SAMPLE_SCAN),
      lintClassify: vi.fn(async () => ({ verdicts: [], degraded: false })),
      lintApplyFix: vi.fn(async () => ({ ok: true, results: [{ chapterId: 'ch_001', filePath: 'C:/proj/chapters/ch_001.md', changes: 1, written: true }] })),
      // CR-014：探测下沉 shell 单源——slice 只消费 lintModelProbe 结果。
      lintModelProbe: vi.fn(async () => ({ available: true })),
    };
  });

  it('runLintScan stores report + chapter files + fix patches + skipped, and resets stale verdict/selection', async () => {
    useTestStore.setState({
      lintClassifyResult: { verdicts: [{ ruleId: 'old', truePositiveRatio: 1, note: '' }], degraded: false },
      lintSelectedChapterIds: ['ch_000'],
    });
    await useTestStore.getState().runLintScan();
    const s = useTestStore.getState();
    expect(s.lintReport).toEqual(SAMPLE_REPORT);
    expect(s.lintChapterFiles).toHaveLength(1);
    expect(s.lintFixPatches).toHaveLength(1);
    expect(s.lintSkipped).toEqual([{ chapterId: 'ch_002', reason: 'not-landed' }]); // 批 A 字段透传
    expect(s.lintClassifyResult).toBeNull(); // 旧 verdict 不渗入新报告
    expect(s.lintSelectedChapterIds).toEqual([]);
    expect((window as any).orisonDesktop.lintScanFull).toHaveBeenCalledWith({ projectPath: 'C:/proj' });
  });

  it('runLintScan without a project surfaces an error toast and skips the IPC', async () => {
    useTestStore.setState({ currentProject: null });
    await useTestStore.getState().runLintScan();
    expect((window as any).orisonDesktop.lintScanFull).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].level).toBe('error');
  });

  it('runLintScan maps 模式 A engine-unavailable to an error toast', async () => {
    (window as any).orisonDesktop.lintScanFull = vi.fn(async () => ({
      ok: false,
      error: 'engine-unavailable',
    }));
    await useTestStore.getState().runLintScan();
    expect(useToastStore.getState().toasts[0].level).toBe('error');
    expect(useTestStore.getState().lintScanning).toBe(false);
  });

  it('runLintClassify stores the verdict result; degraded result stored as-is', async () => {
    useTestStore.setState({ lintReport: SAMPLE_REPORT });
    const verdicts = [{ ruleId: 'r1', truePositiveRatio: 0.8, note: '删填充词' }];
    (window as any).orisonDesktop.lintClassify = vi.fn(async () => ({ verdicts, degraded: false }));
    await useTestStore.getState().runLintClassify();
    expect(useTestStore.getState().lintClassifyResult).toEqual({ verdicts, degraded: false });
  });

  it('runLintApplyFix sends only selected chapters patches, reloads written tabs, then rescans', async () => {
    const reloadFile = vi.fn(async () => undefined);
    useTestStore.setState({ lintReport: SAMPLE_REPORT, lintFixPatches: SAMPLE_SCAN.fixPatches, reloadFile });
    useTestStore.getState().toggleLintChapterSelected('ch_001');
    await useTestStore.getState().runLintApplyFix();
    expect((window as any).orisonDesktop.lintApplyFix).toHaveBeenCalledWith({
      projectPath: 'C:/proj',
      patches: SAMPLE_SCAN.fixPatches,
    });
    // CR-005：已写章先 reloadFile（已打开的 tab 重读盘上正文；未打开的章在 fileTabs 内无操作）。
    expect(reloadFile).toHaveBeenCalledWith('C:/proj/chapters/ch_001.md');
    // 正文已变 → 自动重扫刷新报告。
    expect((window as any).orisonDesktop.lintScanFull).toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].level).toBe('success');
  });

  it('runLintApplyFix with empty selection bails with an error toast', async () => {
    useTestStore.setState({ lintReport: SAMPLE_REPORT, lintFixPatches: SAMPLE_SCAN.fixPatches });
    await useTestStore.getState().runLintApplyFix();
    expect((window as any).orisonDesktop.lintApplyFix).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].level).toBe('error');
  });

  it('runLintApplyFix 全部章 written:false（nothing-to-fix）→ 跳过重扫、无成功 toast（CR-018）', async () => {
    (window as any).orisonDesktop.lintApplyFix = vi.fn(async () => ({
      ok: true,
      results: [{ chapterId: 'ch_001', filePath: 'C:/proj/chapters/ch_001.md', changes: 0, written: false, note: 'nothing-to-fix' }],
    }));
    useTestStore.setState({ lintReport: SAMPLE_REPORT, lintFixPatches: SAMPLE_SCAN.fixPatches });
    useTestStore.getState().toggleLintChapterSelected('ch_001');
    await useTestStore.getState().runLintApplyFix();
    expect((window as any).orisonDesktop.lintScanFull).not.toHaveBeenCalled(); // 正文未变——不阻塞重扫
    expect(useToastStore.getState().toasts).toHaveLength(0); // 未写盘不冒充成功
  });

  it('runLintApplyFix ok:false（模式 A 错误）→ 错误 toast 且不重扫（CR-018）', async () => {
    (window as any).orisonDesktop.lintApplyFix = vi.fn(async () => ({
      ok: false,
      error: 'engine-unavailable',
    }));
    useTestStore.setState({ lintReport: SAMPLE_REPORT, lintFixPatches: SAMPLE_SCAN.fixPatches });
    useTestStore.getState().toggleLintChapterSelected('ch_001');
    await useTestStore.getState().runLintApplyFix();
    expect((window as any).orisonDesktop.lintScanFull).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].level).toBe('error');
  });

  it('toggleLintChapterSelected toggles membership', () => {
    useTestStore.getState().toggleLintChapterSelected('ch_001');
    expect(useTestStore.getState().lintSelectedChapterIds).toEqual(['ch_001']);
    useTestStore.getState().toggleLintChapterSelected('ch_001');
    expect(useTestStore.getState().lintSelectedChapterIds).toEqual([]);
  });

  it('probeLintModel 走 shell lint:model-probe 单源（CR-014——review-judge 档解析语义，撤本地启发式）', async () => {
    await useTestStore.getState().probeLintModel();
    expect((window as any).orisonDesktop.lintModelProbe).toHaveBeenCalledTimes(1);
    expect((window as any).orisonDesktop.loadModelConfig).toBeUndefined(); // 不再读 renderer 侧模型配置
    expect(useTestStore.getState().lintModelAvailable).toBe(true);

    (window as any).orisonDesktop.lintModelProbe = vi.fn(async () => ({ available: false }));
    await useTestStore.getState().probeLintModel();
    expect(useTestStore.getState().lintModelAvailable).toBe(false);
  });

  it('probeLintModel 桥不可用/异常 → 保守 false（按钮禁用+提示）', async () => {
    (window as any).orisonDesktop.lintModelProbe = vi.fn(async () => {
      throw new Error('bridge boom');
    });
    await useTestStore.getState().probeLintModel();
    expect(useTestStore.getState().lintModelAvailable).toBe(false);
  });

  it('registerProjectReset clears lint state on project switch', () => {
    useTestStore.setState({
      lintReport: SAMPLE_REPORT,
      lintChapterFiles: SAMPLE_SCAN.chapterFiles,
      lintSkipped: SAMPLE_SCAN.skipped ?? [],
      lintFixPatches: SAMPLE_SCAN.fixPatches,
      lintSelectedChapterIds: ['ch_001'],
      lintConfirmOpen: true,
      lintScanning: true,
    });
    runProjectResets();
    const s = useTestStore.getState();
    expect(s.lintReport).toBeNull();
    expect(s.lintChapterFiles).toEqual([]);
    expect(s.lintSkipped).toEqual([]);
    expect(s.lintFixPatches).toEqual([]);
    expect(s.lintSelectedChapterIds).toEqual([]);
    expect(s.lintConfirmOpen).toBe(false);
    expect(s.lintScanning).toBe(false);
  });
});
