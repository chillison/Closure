/**
 * C1.2 Lint tab 面板（design §6 / D9 最小面）：全稿扫描触发 + issue 列表（severity 过滤 +
 * 点击打开章文件并定位）+ LLM 语境判断（未配置模型禁用+提示）+ 机械修复勾选（章粒度）→ 确认
 * 弹层（列章与条数；删除类补丁标「删除」而非「替换」）→ apply-fix → 自动重扫。
 *
 * CR 批 B（2026-08-21）落点：
 * - CR-004 点击 issue → openFile 带 reveal（line/column + 命中原串）——编辑器消费定位；
 * - CR-014 模型探测走 shell `lint:model-probe` 单源（窗口重聚焦重探，防设置变更后陈旧）；
 * - CR-015 readFile reject → 错误 toast（不再 unhandled rejection）；
 * - CR-016 verdict（真阳比例）徽章挂**规则组头**（classify 本就是按规则组判的），行内不再重复；
 * - CR-017 issue 行展示规则自带修复建议（替换→「建议改为 X」/删除→「建议删除」）；
 * - CR-021 列表渲染上限 300 行 + 截断提示（severity 过滤先行，上限作用于过滤后；完整虚拟化归 C1.3）；
 * - CR-022 确认弹层 Escape 关闭 + 焦点圈（开聚焦首控件 / Tab 圈内循环 / 关还原触发控件），
 *   severity 过滤 aria-pressed 表达选中态（不再 disabled 无朗读；未命中档 aria-disabled + 说明）；
 * - 批 A 字段消费：skipped 摘要行 / degraded 章标记 / classify partial 标记。
 *
 * 完整报告工作流（筛选/排序/导出/诊断聚合）= C1.3，本面板只做能跑通「扫描 → 查看 → 修复」
 * 闭环的最小面。样式走 inline（SearchPanel 先例）；i18n 经 `t` prop 注入（BottomPanel 传入，
 * mirror KbIndexSettingsPage 约定）。
 *
 * 范式判据呈现：静态命中 ≠ 定罪——verdict 徽标（真阳比例）只在语境判断完成后出现且挂在
 * 规则组头，明确来自 LLM 通道（classifyResult），静态行本身不带语义结论。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { readFile } from '../../shared/api/filesystem';
import { formatTime } from './utils';
import type { LintFixPatch, LintIssue, LintLevel } from '@orison/shared-contracts';

type Props = { t: (key: string, vars?: Record<string, string | number>) => string };

const LEVEL_COLORS: Record<LintLevel, string> = {
  high: 'var(--danger, #e06c75)',
  medium: 'var(--warning, #e5c07b)',
  low: 'var(--outline, #9aa0a6)',
};

/** CR-021：渲染上限（行级 DOM 节点——千级命中直渲染会卡；完整虚拟化归 C1.3 报告面）。 */
const MAX_RENDERED_ISSUES = 300;

/** 删除类补丁判定（replacements=[''] = 确定性删除命中文字；上游 fix.ts 空 replacement 语义）。 */
function isDeletionPatch(patch: LintFixPatch): boolean {
  return patch.replacements[0] === '';
}

export function LintPanel({ t }: Props) {
  const {
    lintReport,
    lintChapterFiles,
    lintSkipped,
    lintFixPatches,
    lintClassifyResult,
    lintModelAvailable,
    lintScanning,
    lintClassifying,
    lintApplying,
    lintSeverityFilter,
    lintSelectedChapterIds,
    lintConfirmOpen,
    runLintScan,
    runLintClassify,
    runLintApplyFix,
    probeLintModel,
    setLintSeverityFilter,
    toggleLintChapterSelected,
    setLintConfirmOpen,
    openFile,
    currentProject,
    resolvedLocale,
  } = useAppStore(
    useShallow((s) => ({
      lintReport: s.lintReport,
      lintChapterFiles: s.lintChapterFiles,
      lintSkipped: s.lintSkipped,
      lintFixPatches: s.lintFixPatches,
      lintClassifyResult: s.lintClassifyResult,
      lintModelAvailable: s.lintModelAvailable,
      lintScanning: s.lintScanning,
      lintClassifying: s.lintClassifying,
      lintApplying: s.lintApplying,
      lintSeverityFilter: s.lintSeverityFilter,
      lintSelectedChapterIds: s.lintSelectedChapterIds,
      lintConfirmOpen: s.lintConfirmOpen,
      runLintScan: s.runLintScan,
      runLintClassify: s.runLintClassify,
      runLintApplyFix: s.runLintApplyFix,
      probeLintModel: s.probeLintModel,
      setLintSeverityFilter: s.setLintSeverityFilter,
      toggleLintChapterSelected: s.toggleLintChapterSelected,
      setLintConfirmOpen: s.setLintConfirmOpen,
      openFile: s.openFile,
      currentProject: s.currentProject,
      resolvedLocale: s.resolvedLocale,
    })),
  );

  // 面板挂载后探测一次模型可用性（语境判断按钮禁用判定；CR-014：shell 单源纯配置探测）。
  useEffect(() => {
    void probeLintModel();
  }, [probeLintModel]);

  // CR-014：模型设置变更后旧探测会陈旧——窗口重聚焦时重探（用户从设置页回来的最短路径）。
  useEffect(() => {
    const onFocus = () => {
      void probeLintModel();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [probeLintModel]);

  // ── CR-022：确认弹层焦点圈（open → 记录触发控件 + 聚焦首控件；close/unmount → 还原焦点）──
  const confirmDialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!lintConfirmOpen) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = confirmDialogRef.current;
    dialog
      ?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
    return () => {
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, [lintConfirmOpen]);

  /** CR-022：Escape 关闭 + Tab 焦点圈在弹层内（首尾循环）。 */
  const handleConfirmKeyDown = (e: React.KeyboardEvent) => {
    const dialog = confirmDialogRef.current;
    if (!dialog) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      setLintConfirmOpen(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialog.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  const chapterById = useMemo(
    () => new Map(lintChapterFiles.map((cf) => [cf.chapterId, cf])),
    [lintChapterFiles],
  );
  const verdictByRuleId = useMemo(
    () =>
      new Map(
        (lintClassifyResult && !lintClassifyResult.degraded ? lintClassifyResult.verdicts : []).map(
          (v) => [v.ruleId, v],
        ),
      ),
    [lintClassifyResult],
  );

  const allIssues = useMemo(
    () => (lintReport ? lintReport.chapters.flatMap((c) => c.issues) : []),
    [lintReport],
  );
  const densityIssues = useMemo(
    () => (lintReport ? lintReport.chapters.flatMap((c) => c.densityIssues) : []),
    [lintReport],
  );
  const filteredIssues = useMemo(
    () =>
      lintSeverityFilter === 'all'
        ? allIssues
        : allIssues.filter((issue) => issue.level === lintSeverityFilter),
    [allIssues, lintSeverityFilter],
  );

  // CR-021：severity 过滤先行 → 截断到渲染上限 → 分组（上限作用于过滤后的最终行集）。
  const cappedIssues = useMemo(
    () => filteredIssues.slice(0, MAX_RENDERED_ISSUES),
    [filteredIssues],
  );
  const issueGroups = useMemo(() => {
    const groups: Array<{ ruleId: string; title: string; issues: LintIssue[] }> = [];
    const byRule = new Map<string, (typeof groups)[number]>();
    for (const issue of cappedIssues) {
      let group = byRule.get(issue.ruleId);
      if (!group) {
        group = { ruleId: issue.ruleId, title: issue.title, issues: [] };
        byRule.set(issue.ruleId, group);
        groups.push(group);
      }
      group.issues.push(issue);
    }
    return groups;
  }, [cappedIssues]);

  /** severity 档命中数（aria-disabled 判定——未命中档保持可见可聚焦 + 说明）。 */
  const levelCounts = useMemo(() => {
    const counts: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 };
    for (const issue of allIssues) counts[issue.level] += 1;
    return counts;
  }, [allIssues]);

  /** skipped 摘要（reason 稳定码 ×计数；批 A CR-011 字段消费）。 */
  const skippedReasonSummary = useMemo(() => {
    const byReason = new Map<string, number>();
    for (const s of lintSkipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    return [...byReason.entries()].map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason)).join(', ');
  }, [lintSkipped]);

  /** 降级章标题（批 A CR-007 字段消费——degraded 章零 issue，以状态行呈现而非列表章头）。 */
  const degradedChapterTitles = useMemo(
    () =>
      lintReport
        ? lintReport.chapters
            .filter((c) => c.degraded)
            .map((c) => chapterById.get(c.chapterId)?.title ?? c.chapterId)
        : [],
    [lintReport, chapterById],
  );

  // 修复补丁按章分组（应用单位 = 章；确认弹层列章与条数）。
  const patchesByChapter = useMemo(() => {
    const groups = new Map<string, LintFixPatch[]>();
    for (const patch of lintFixPatches) {
      const bucket = groups.get(patch.chapterId);
      if (bucket) bucket.push(patch);
      else groups.set(patch.chapterId, [patch]);
    }
    return [...groups.entries()];
  }, [lintFixPatches]);

  const selectedChapters = useMemo(
    () => patchesByChapter.filter(([chapterId]) => lintSelectedChapterIds.includes(chapterId)),
    [patchesByChapter, lintSelectedChapterIds],
  );

  const classifyDisabledReason = !lintReport
    ? t('lint.classifyDisabledNoReport')
    : lintModelAvailable === false
      ? t('lint.classifyDisabledNoModel')
      : null;

  const handleIssueClick = async (issue: LintIssue) => {
    const chapter = chapterById.get(issue.chapterId);
    if (!chapter) return;
    try {
      const content = await readFile(chapter.filePath);
      if (content == null) {
        useToastStore.getState().showToast(t('lint.openFailed'), 'error');
        return;
      }
      const name = chapter.filePath.split(/[/\\]/).pop() || chapter.filePath;
      // CR-004：带定位打开——lint span 语义 1-based 码点行列 + 命中原串（编辑器按文本精确定位，
      // 未命中降级行号近似滚动到段落）。
      openFile(chapter.filePath, name, content, {
        reveal: { line: issue.line, column: issue.column, text: issue.match },
      });
    } catch {
      // CR-015：readFile reject（IPC 异常等）——错误 toast，不再向上冒泡。
      useToastStore.getState().showToast(t('lint.openFailed'), 'error');
    }
  };

  const severityButton = (key: 'all' | 'high' | 'medium' | 'low', labelKey: string) => {
    const empty = key !== 'all' && levelCounts[key] === 0;
    return (
      <button
        key={key}
        type="button"
        data-severity={key}
        // CR-022：选中态用 aria-pressed 表达（原 disabled 无朗读）；未命中档保持可见可聚焦，
        // aria-disabled + title 说明（点击不激活）。
        aria-pressed={lintSeverityFilter === key}
        aria-disabled={empty || undefined}
        title={empty ? t('lint.severityEmpty') : undefined}
        onClick={() => {
          if (!empty) setLintSeverityFilter(key);
        }}
        style={{
          padding: '2px 10px',
          fontSize: 12,
          border: '1px solid var(--border, #444)',
          borderRadius: 4,
          background: lintSeverityFilter === key ? 'var(--surface-variant, #2a2a2a)' : 'transparent',
          color: 'inherit',
          cursor: empty ? 'default' : 'pointer',
        }}
      >
        {t(labelKey)}
      </button>
    );
  };

  return (
    <div
      className="lint-panel"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', position: 'relative', fontSize: 12 }}
      role="region"
      aria-label={t('bottomPanel.lint')}
    >
      <div
        className="lint-toolbar"
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border, #333)', flexWrap: 'wrap' }}
      >
        <button
          type="button"
          onClick={() => void runLintScan()}
          disabled={lintScanning || !currentProject}
          style={{ padding: '3px 12px', cursor: lintScanning ? 'default' : 'pointer' }}
        >
          {lintScanning ? t('lint.scanning') : t('lint.scan')}
        </button>
        <button
          type="button"
          onClick={() => void runLintClassify()}
          disabled={lintClassifying || classifyDisabledReason !== null}
          title={classifyDisabledReason ?? ''}
          style={{ padding: '3px 12px', cursor: lintClassifying || classifyDisabledReason ? 'default' : 'pointer' }}
        >
          {lintClassifying ? t('lint.classifying') : t('lint.classify')}
        </button>
        <div style={{ display: 'flex', gap: 4 }} role="group" aria-label={t('lint.severityAll')}>
          {severityButton('all', 'lint.severityAll')}
          {severityButton('high', 'lint.severityHigh')}
          {severityButton('medium', 'lint.severityMedium')}
          {severityButton('low', 'lint.severityLow')}
        </div>
        {lintReport ? (
          <span style={{ opacity: 0.6 }}>
            {t('lint.reportAt', { time: formatTime(lintReport.generatedAt, resolvedLocale) })}
          </span>
        ) : null}
        {lintClassifyResult?.degraded ? (
          <span data-lint-degraded style={{ color: 'var(--warning, #e5c07b)' }}>
            {t('lint.degraded')}
          </span>
        ) : null}
        {lintClassifyResult?.partial ? (
          <span data-lint-partial style={{ color: 'var(--warning, #e5c07b)' }}>
            {t('lint.classifyPartial')}
          </span>
        ) : null}
      </div>

      {!lintReport ? (
        <div style={{ padding: 12, opacity: 0.6 }}>
          {currentProject ? t('lint.emptyReport') : t('lint.noProject')}
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto' }}>
          {/* 批 A 字段：跳章摘要（CR-011——跳章不再静默）+ 降级章标记（CR-007——issues 空 ≠ 干净章）。 */}
          {lintSkipped.length > 0 ? (
            <div data-lint-skipped style={{ padding: '3px 10px', color: 'var(--warning, #e5c07b)' }}>
              {t('lint.skippedSummary', { n: lintSkipped.length, reasons: skippedReasonSummary })}
            </div>
          ) : null}
          {degradedChapterTitles.length > 0 ? (
            <div data-lint-degraded-chapters style={{ padding: '3px 10px', color: 'var(--warning, #e5c07b)' }}>
              {t('lint.degradedChapters', {
                n: degradedChapterTitles.length,
                chapters: degradedChapterTitles.join('、'),
              })}
            </div>
          ) : null}

          <div style={{ padding: '6px 10px', fontWeight: 600 }}>
            {t('lint.issuesTitle', { n: filteredIssues.length })}
          </div>
          {issueGroups.map((group) => {
            // CR-016：verdict 挂规则组头（classify 本就按规则组聚合判定——组内逐行重复徽章是
            // 把组级结论伪装成行级结论）。
            const verdict = verdictByRuleId.get(group.ruleId);
            return (
              <div key={group.ruleId}>
                <div
                  data-lint-rule-group={group.ruleId}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    padding: '4px 10px',
                    fontWeight: 600,
                    background: 'var(--surface-variant, transparent)',
                    position: 'sticky',
                    top: 0,
                  }}
                >
                  <span style={{ minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {group.title}
                  </span>
                  <span style={{ flexShrink: 0, opacity: 0.5 }}>
                    {t('lint.groupCount', { n: group.issues.length })}
                  </span>
                  {verdict ? (
                    <span
                      data-lint-verdict
                      title={verdict.note}
                      style={{ flexShrink: 0, opacity: 0.85, color: verdict.truePositiveRatio >= 0.5 ? 'var(--danger, #e06c75)' : 'inherit' }}
                    >
                      {t('lint.verdictBadge', { ratio: Math.round(verdict.truePositiveRatio * 100) })}
                    </span>
                  ) : null}
                </div>
                {group.issues.map((issue, index) => {
                  const chapter = chapterById.get(issue.chapterId);
                  return (
                    <div
                      key={`${issue.chapterId}:${issue.ruleId}:${issue.line}:${issue.column}:${index}`}
                      data-lint-issue={issue.level}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 8,
                        padding: '3px 10px 3px 18px',
                        borderBottom: '1px solid var(--border-subtle, transparent)',
                        cursor: chapter ? 'pointer' : 'default',
                      }}
                      onClick={() => void handleIssueClick(issue)}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: LEVEL_COLORS[issue.level],
                          alignSelf: 'center',
                        }}
                      />
                      <span style={{ flexShrink: 0, opacity: 0.6 }}>
                        {t('lint.locate', {
                          chapter: chapter?.title ?? issue.chapterId,
                          line: issue.line,
                        })}
                        :{issue.column}
                      </span>
                      {issue.fix && issue.fix.replacements.length > 0 ? (
                        // CR-017：规则自带修复建议（R4「语义类只展示建议」的数据面落地）。
                        // replacements[0]==='' = 删除语义（mirror isDeletionPatch）。
                        <span
                          data-lint-suggest={issue.fix.replacements[0] === '' ? 'delete' : 'replace'}
                          style={{ flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--accent, #61afef)' }}
                        >
                          {issue.fix.replacements[0] === ''
                            ? t('lint.suggestDelete')
                            : t('lint.suggestReplace', { text: issue.fix.replacements[0] })}
                        </span>
                      ) : null}
                      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.75 }}>
                        {issue.context.before}
                        <mark style={{ background: 'transparent', color: 'inherit', fontWeight: 600 }}>
                          {issue.context.current}
                        </mark>
                        {issue.context.after}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {filteredIssues.length > MAX_RENDERED_ISSUES ? (
            // CR-021：截断提示（完整筛选/导出归 C1.3 诊断报告面）。
            <div data-lint-truncated style={{ padding: '6px 10px', opacity: 0.7 }}>
              {t('lint.truncated', { n: filteredIssues.length })}
            </div>
          ) : null}

          {densityIssues.length > 0 ? (
            <>
              <div style={{ padding: '6px 10px', fontWeight: 600 }}>
                {t('lint.densityTitle', { n: densityIssues.length })}
              </div>
              {densityIssues.map((density, index) => (
                <div
                  key={`${density.chapterId}:${density.ruleId}:${index}`}
                  style={{ display: 'flex', gap: 8, padding: '3px 10px', opacity: 0.75 }}
                >
                  <span style={{ fontWeight: 500 }}>{density.ruleId}</span>
                  <span>
                    {t('lint.densityRow', {
                      hits: density.hits,
                      perKilo: density.perKilo.toFixed(1),
                    })}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {density.samples[0] ?? ''}
                  </span>
                </div>
              ))}
            </>
          ) : null}

          {/* ── 机械修复区（fixability:auto；确认流 = R4「不静默改稿」）── */}
          <div style={{ padding: '6px 10px', fontWeight: 600, marginTop: 6 }}>
            {t('lint.fixesTitle')}
          </div>
          {patchesByChapter.length === 0 ? (
            <div style={{ padding: '2px 10px 10px', opacity: 0.6 }}>{t('lint.noFixes')}</div>
          ) : (
            <>
              {patchesByChapter.map(([chapterId, patches]) => {
                const chapter = chapterById.get(chapterId);
                const deletions = patches.filter(isDeletionPatch).length;
                const checked = lintSelectedChapterIds.includes(chapterId);
                return (
                  <div key={chapterId} style={{ padding: '2px 10px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleLintChapterSelected(chapterId)}
                        data-lint-chapter-check={chapterId}
                      />
                      <span style={{ fontWeight: 500 }}>{chapter?.title ?? chapterId}</span>
                      <span style={{ opacity: 0.6 }}>
                        {t('lint.fixPatchCount', { n: patches.length, del: deletions })}
                      </span>
                    </label>
                    {patches.map((patch, index) => (
                      <div
                        key={`${patch.ruleId}:${patch.span.line}:${patch.span.column}:${index}`}
                        style={{ display: 'flex', gap: 8, padding: '1px 0 1px 24px', opacity: 0.7 }}
                      >
                        <span
                          data-lint-fix-kind={isDeletionPatch(patch) ? 'delete' : 'replace'}
                          style={{
                            flexShrink: 0,
                            color: isDeletionPatch(patch) ? 'var(--danger, #e06c75)' : 'inherit',
                          }}
                        >
                          {isDeletionPatch(patch) ? t('lint.fixDelete') : t('lint.fixReplace')}
                        </span>
                        <span>{patch.ruleId}</span>
                        <span style={{ opacity: 0.6 }}>
                          L{patch.span.line}:C{patch.span.column}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
              <div style={{ padding: '8px 10px' }}>
                <button
                  type="button"
                  onClick={() => setLintConfirmOpen(true)}
                  disabled={lintApplying || selectedChapters.length === 0}
                  style={{ padding: '3px 12px' }}
                >
                  {t('lint.applyFix')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── 应用确认弹层（面板局部 overlay；列出将改的章与条数 + 删除类标注）── */}
      {lintConfirmOpen ? (
        <div
          data-lint-confirm
          style={{
            position: 'absolute',
            inset: 0,
            background: 'var(--scrim, rgba(0,0,0,0.45))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
          }}
          onKeyDown={handleConfirmKeyDown}
        >
          <div
            ref={confirmDialogRef}
            style={{
              background: 'var(--surface, #1e1e1e)',
              border: '1px solid var(--border, #444)',
              borderRadius: 8,
              padding: 16,
              minWidth: 320,
              maxWidth: '80%',
            }}
            role="dialog"
            aria-modal="true"
            aria-label={t('lint.confirmTitle')}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('lint.confirmTitle')}</div>
            <div style={{ marginBottom: 8, opacity: 0.8 }}>{t('lint.confirmBody')}</div>
            {selectedChapters.map(([chapterId, patches]) => {
              const chapter = chapterById.get(chapterId);
              const deletions = patches.filter(isDeletionPatch).length;
              return (
                <div key={chapterId} data-lint-confirm-chapter={chapterId} style={{ padding: '2px 0' }}>
                  <span>
                    {t('lint.confirmChapter', {
                      chapter: chapter?.title ?? chapterId,
                      n: patches.length,
                    })}
                  </span>
                  {deletions > 0 ? (
                    <span style={{ color: 'var(--danger, #e06c75)' }}>
                      {t('lint.confirmDeletions', { n: deletions })}
                    </span>
                  ) : null}
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" onClick={() => setLintConfirmOpen(false)}>
                {t('lint.cancel')}
              </button>
              <button
                type="button"
                data-lint-confirm-apply
                disabled={lintApplying}
                onClick={() => void runLintApplyFix()}
              >
                {lintApplying ? t('lint.applying') : t('lint.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
