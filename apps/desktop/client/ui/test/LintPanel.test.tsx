import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LintFullReport } from '@orison/shared-contracts';
import { LintPanel } from '../src/features/bottom-panel/LintPanel';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';

const tFake = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

function issue(
  ruleId: string,
  level: 'high' | 'medium' | 'low',
  chapterId: string,
  line: number,
): LintFullReport['chapters'][number]['issues'][number] {
  return {
    ruleId,
    namespace: 'ns',
    title: `${ruleId} 标题`,
    level,
    review: 'agent',
    fixability: 'manual',
    chapterId,
    line,
    column: 5,
    endLine: line,
    endColumn: 8,
    match: '填充词',
    context: { before: '前文', current: '填充词', after: '后文' },
  };
}

const REPORT: LintFullReport = {
  chapters: [
    {
      chapterId: 'ch_001',
      issues: [issue('filler.h', 'high', 'ch_001', 3), issue('transition.m', 'medium', 'ch_001', 7)],
      densityIssues: [
        { ruleId: 'cliche-density', chapterId: 'ch_001', line: 1, column: 1, hits: 4, perKilo: 2.5, samples: ['样本一'] },
      ],
      summary: { total: 2, high: 1, medium: 1, low: 0, visibleChars: 100 },
      upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
    },
    {
      chapterId: 'ch_002',
      issues: [issue('opening.l', 'low', 'ch_002', 1)],
      densityIssues: [],
      summary: { total: 1, high: 0, medium: 0, low: 1, visibleChars: 100 },
      upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
    },
  ],
  generatedAt: '2026-08-21T00:00:00.000Z',
  stats: { chapters: 2, total: 3, high: 1, medium: 1, low: 1, densityIssues: 1 },
};

const CHAPTER_FILES = [
  { chapterId: 'ch_001', title: '第一章', filePath: 'C:/proj/chapters/ch_001.md' },
  { chapterId: 'ch_002', title: '第二章', filePath: 'C:/proj/chapters/ch_002.md' },
];

const FIX_PATCHES = [
  {
    chapterId: 'ch_001',
    filePath: 'C:/proj/chapters/ch_001.md',
    ruleId: 'mechanical-zero-width',
    span: { line: 1, column: 3, endLine: 1, endColumn: 3 },
    replacements: [''], // 删除类
  },
  {
    chapterId: 'ch_002',
    filePath: 'C:/proj/chapters/ch_002.md',
    ruleId: 'punctuation.dash.tail',
    span: { line: 2, column: 1, endLine: 2, endColumn: 2 },
    replacements: ['——'],
  },
];

function seedState(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    lintReport: REPORT,
    lintChapterFiles: CHAPTER_FILES,
    lintSkipped: [],
    lintFixPatches: FIX_PATCHES,
    lintClassifyResult: null,
    lintModelAvailable: true,
    lintScanning: false,
    lintClassifying: false,
    lintApplying: false,
    lintSeverityFilter: 'all',
    lintSelectedChapterIds: [],
    lintConfirmOpen: false,
    // ⚠ 无 path：projectSubscription 按路径判切换——带 path 会触发 project reset 清掉
    // 本测试刚 seed 的 lint 状态（mirror kbIndexSettingsPage.test 的 projectId-only fixture）。
    currentProject: { projectId: '00001' },
    resolvedLocale: 'en-US',
    runLintScan: vi.fn(),
    runLintClassify: vi.fn(),
    runLintApplyFix: vi.fn(),
    probeLintModel: vi.fn(async () => undefined),
    setLintSeverityFilter: useAppStore.getState().setLintSeverityFilter,
    toggleLintChapterSelected: useAppStore.getState().toggleLintChapterSelected,
    setLintConfirmOpen: useAppStore.getState().setLintConfirmOpen,
    openFile: vi.fn(),
    ...overrides,
  } as any);
}

describe('LintPanel', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    (globalThis.window as any) = globalThis.window ?? {};
    (window as any).orisonDesktop = {
      readFile: vi.fn(async () => '# 第一章\n\n前文填充词后文。'),
    };
    useToastStore.setState({ toasts: [] });
  });

  it('renders issues across chapters with the total count; density section renders', () => {
    seedState();
    render(<LintPanel t={tFake} />);
    expect(screen.getByText('lint.issuesTitle:{"n":3}')).toBeTruthy();
    // CR-016 后规则 title 挂组头。
    expect(screen.getByText('filler.h 标题')).toBeTruthy();
    expect(screen.getByText('transition.m 标题')).toBeTruthy();
    expect(screen.getByText('opening.l 标题')).toBeTruthy();
    expect(screen.getByText('lint.densityTitle:{"n":1}')).toBeTruthy();
    // 密度行走 i18n（无硬编码中文残留——perKilo 由组件 toFixed(1) 格式化后注入）。
    expect(screen.getByText('lint.densityRow:{"hits":4,"perKilo":"2.5"}')).toBeTruthy();
  });

  it('severity filter narrows the issue list', async () => {
    seedState();
    render(<LintPanel t={tFake} />);
    await userEvent.click(screen.getByRole('button', { name: 'lint.severityHigh' }));
    expect(screen.getByText('lint.issuesTitle:{"n":1}')).toBeTruthy();
    expect(screen.getByText('filler.h 标题')).toBeTruthy();
    expect(screen.queryByText('transition.m 标题')).toBeNull();
    expect(screen.queryByText('opening.l 标题')).toBeNull();
  });

  it('severity 过滤选中态走 aria-pressed（不再 disabled 无朗读）；未命中档 aria-disabled + 点击不激活（CR-022）', async () => {
    seedState();
    const { rerender } = render(<LintPanel t={tFake} />);
    const highBtn = screen.getByRole('button', { name: 'lint.severityHigh' });
    await userEvent.click(highBtn);
    expect(highBtn.getAttribute('aria-pressed')).toBe('true');
    expect((highBtn as HTMLButtonElement).disabled).toBe(false); // 可聚焦可朗读

    // REPORT 中三档各 ≥1 → 全档可激活。改 seed 成仅 high 命中 → medium 档 aria-disabled。
    const onlyHigh: LintFullReport = {
      chapters: [
        {
          chapterId: 'ch_001',
          issues: [issue('filler.h', 'high', 'ch_001', 3)],
          densityIssues: [],
          summary: { total: 1, high: 1, medium: 0, low: 0, visibleChars: 10 },
          upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
        },
      ],
      generatedAt: '2026-08-21T00:00:00.000Z',
      stats: { chapters: 1, total: 1, high: 1, medium: 0, low: 0, densityIssues: 0 },
    };
    seedState({ lintReport: onlyHigh, lintFixPatches: [] });
    rerender(<LintPanel t={tFake} />);
    const mediumBtn = screen.getByRole('button', { name: 'lint.severityMedium' });
    expect(mediumBtn.getAttribute('aria-disabled')).toBe('true');
    expect(mediumBtn.getAttribute('title')).toBe('lint.severityEmpty');
    await userEvent.click(mediumBtn);
    expect(mediumBtn.getAttribute('aria-pressed')).toBe('false'); // 未激活
  });

  it('shows the degraded mark when classify degraded, and disables classify when no model', () => {
    seedState({ lintClassifyResult: { verdicts: [], degraded: true } });
    const { rerender } = render(<LintPanel t={tFake} />);
    expect(screen.getByText('lint.degraded')).toBeTruthy();

    seedState({ lintClassifyResult: null, lintModelAvailable: false });
    rerender(<LintPanel t={tFake} />);
    const classifyBtn = screen.getByRole('button', { name: 'lint.classify' }) as HTMLButtonElement;
    expect(classifyBtn.disabled).toBe(true);
  });

  it('批 A 字段：skipped 摘要 / degraded 章标记 / classify partial 徽标渲染', () => {
    const degradedReport: LintFullReport = {
      ...REPORT,
      chapters: REPORT.chapters.map((c) =>
        c.chapterId === 'ch_002' ? { ...c, degraded: true } : c,
      ),
    };
    seedState({
      lintReport: degradedReport,
      lintSkipped: [
        { chapterId: 'ch_003', reason: 'not-landed' },
        { chapterId: 'ch_004', reason: 'not-landed' },
        { chapterId: 'ch_005', reason: 'multi-section' },
      ],
      lintClassifyResult: {
        verdicts: [{ ruleId: 'filler.h', truePositiveRatio: 0.7, note: '' }],
        degraded: false,
        partial: true,
      },
    });
    render(<LintPanel t={tFake} />);
    // skipped：reason 码 ×计数汇总。
    expect(
      screen.getByText('lint.skippedSummary:{"n":3,"reasons":"not-landed ×2, multi-section"}'),
    ).toBeTruthy();
    // degraded 章：标题列表（第二章）。
    expect(screen.getByText('lint.degradedChapters:{"n":1,"chapters":"第二章"}')).toBeTruthy();
    // classify partial。
    expect(screen.getByText('lint.classifyPartial')).toBeTruthy();
  });

  it('renders fix groups with 删除 label for deletion-class patches', () => {
    seedState();
    render(<LintPanel t={tFake} />);
    // ch_001 组：1 补丁（删除 1）；ch_002 组：1 补丁（删除 0）。
    expect(screen.getAllByText('lint.fixDelete').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('lint.fixReplace')).toBeTruthy();
    expect(screen.getByText('lint.fixPatchCount:{"n":1,"del":1}')).toBeTruthy();
    expect(screen.getByText('lint.fixPatchCount:{"n":1,"del":0}')).toBeTruthy();
  });

  it('fix flow: select chapter → apply opens confirm overlay listing chapters + deletions → confirm calls apply', async () => {
    seedState();
    render(<LintPanel t={tFake} />);

    const applyBtn = screen.getByRole('button', { name: 'lint.applyFix' }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true); // 未勾选禁用

    // 章勾选（checkbox 顺序 = patchesByChapter 插入序：ch_001 在前）。
    const [ch1Check] = screen.getAllByRole('checkbox');
    await userEvent.click(ch1Check!);
    expect(applyBtn.disabled).toBe(false);
    await userEvent.click(applyBtn);

    // 确认弹层：列出将改的章与条数 + 删除类标注。
    expect(screen.getByText('lint.confirmTitle')).toBeTruthy();
    expect(screen.getByText('lint.confirmChapter:{"chapter":"第一章","n":1}')).toBeTruthy();
    expect(screen.queryByText('lint.confirmChapter:{"chapter":"第二章","n":1}')).toBeNull();
    expect(screen.getByText('lint.confirmDeletions:{"n":1}')).toBeTruthy();

    const apply = vi.fn();
    seedState({ lintSelectedChapterIds: ['ch_001'], lintConfirmOpen: true, runLintApplyFix: apply });
    await userEvent.click(screen.getByRole('button', { name: 'lint.confirm' }));
    expect(apply).toHaveBeenCalled();
  });

  it('确认弹层：打开聚焦首控件、Escape 关闭、焦点还原触发按钮、Tab 圈内循环（CR-022）', async () => {
    seedState();
    render(<LintPanel t={tFake} />);
    const [ch1Check] = screen.getAllByRole('checkbox');
    await userEvent.click(ch1Check!);
    const applyBtn = screen.getByRole('button', { name: 'lint.applyFix' });
    await userEvent.click(applyBtn);

    const cancelBtn = screen.getByRole('button', { name: 'lint.cancel' });
    const confirmBtn = screen.getByRole('button', { name: 'lint.confirm' });
    // 打开 → 焦点落弹层首个控件（取消按钮）。
    expect(document.activeElement).toBe(cancelBtn);

    // Shift+Tab 在弹层内循环（首个 → 最后一个）。
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(confirmBtn);

    // Escape 关闭弹层。
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('lint.confirmTitle')).toBeNull();
    // 关闭 → 焦点还原到触发按钮。
    expect(document.activeElement).toBe(applyBtn);
  });

  it('点击 issue 行 → openFile 带 reveal 定位（line/column + 命中原串）（CR-004）', async () => {
    const openFile = vi.fn();
    seedState({ openFile });
    const { container } = render(<LintPanel t={tFake} />);
    const rows = container.querySelectorAll('[data-lint-issue]');
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(openFile).toHaveBeenCalled());
    expect(openFile).toHaveBeenCalledWith(
      'C:/proj/chapters/ch_001.md',
      'ch_001.md',
      expect.any(String),
      { reveal: { line: 3, column: 5, text: '填充词' } },
    );
  });

  it('readFile reject → 错误 toast，不冒泡（CR-015）', async () => {
    (window as any).orisonDesktop.readFile = vi.fn(async () => {
      throw new Error('ipc boom');
    });
    seedState();
    const { container } = render(<LintPanel t={tFake} />);
    fireEvent.click(container.querySelector('[data-lint-issue]')!);
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]).toMatchObject({ level: 'error', message: 'lint.openFailed' });
  });

  it('verdict 徽章挂规则组头——同规则多行只一枚徽章（CR-016）', () => {
    const sameRuleReport: LintFullReport = {
      chapters: [
        {
          chapterId: 'ch_001',
          issues: [issue('filler.h', 'high', 'ch_001', 3), issue('filler.h', 'high', 'ch_001', 9)],
          densityIssues: [],
          summary: { total: 2, high: 2, medium: 0, low: 0, visibleChars: 10 },
          upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
        },
      ],
      generatedAt: '2026-08-21T00:00:00.000Z',
      stats: { chapters: 1, total: 2, high: 2, medium: 0, low: 0, densityIssues: 0 },
    };
    seedState({
      lintReport: sameRuleReport,
      lintFixPatches: [],
      lintClassifyResult: {
        verdicts: [{ ruleId: 'filler.h', truePositiveRatio: 0.75, note: '删填充词' }],
        degraded: false,
      },
    });
    render(<LintPanel t={tFake} />);
    // 组级 verdict 只渲染一枚（挂在组头）。
    expect(screen.getAllByText('lint.verdictBadge:{"ratio":75}').length).toBe(1);
    // 组头带组内计数。
    expect(screen.getByText('lint.groupCount:{"n":2}')).toBeTruthy();
  });

  it('issue 行展示修复建议：替换类「建议改为 X」/ 删除类「建议删除」；无 fix 不渲染（CR-017）', () => {
    const withFix = issue('filler.h', 'high', 'ch_001', 3);
    withFix.fix = { replacements: ['——'] };
    const withDeleteFix = issue('transition.m', 'medium', 'ch_001', 7);
    withDeleteFix.fix = { replacements: [''] };
    const report: LintFullReport = {
      chapters: [
        {
          chapterId: 'ch_001',
          issues: [withFix, withDeleteFix, issue('opening.l', 'low', 'ch_001', 9)],
          densityIssues: [],
          summary: { total: 3, high: 1, medium: 1, low: 1, visibleChars: 10 },
          upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
        },
      ],
      generatedAt: '2026-08-21T00:00:00.000Z',
      stats: { chapters: 1, total: 3, high: 1, medium: 1, low: 1, densityIssues: 0 },
    };
    seedState({ lintReport: report, lintFixPatches: [] });
    render(<LintPanel t={tFake} />);
    expect(screen.getByText('lint.suggestReplace:{"text":"——"}')).toBeTruthy();
    expect(screen.getByText('lint.suggestDelete')).toBeTruthy();
    // 无 fix 的行（opening.l）不渲染建议标记。
    expect(screen.getAllByText(/lint\.suggest/).length).toBe(2);
  });

  it('渲染上限：过滤后超 300 条截断 + 提示（CR-021）', () => {
    const many: LintFullReport['chapters'][number]['issues'] = Array.from({ length: 320 }, (_, i) =>
      issue('filler.h', 'low', 'ch_001', i + 1),
    );
    const report: LintFullReport = {
      chapters: [
        {
          chapterId: 'ch_001',
          issues: many,
          densityIssues: [],
          summary: { total: 320, high: 0, medium: 0, low: 320, visibleChars: 10 },
          upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
        },
      ],
      generatedAt: '2026-08-21T00:00:00.000Z',
      stats: { chapters: 1, total: 320, high: 0, medium: 0, low: 320, densityIssues: 0 },
    };
    seedState({ lintReport: report, lintFixPatches: [] });
    const { container } = render(<LintPanel t={tFake} />);
    // 标题计数仍是全量（320），行渲染截到 300。
    expect(screen.getByText('lint.issuesTitle:{"n":320}')).toBeTruthy();
    expect(container.querySelectorAll('[data-lint-issue]').length).toBe(300);
    expect(screen.getByText('lint.truncated:{"n":320}')).toBeTruthy();
  });
});
