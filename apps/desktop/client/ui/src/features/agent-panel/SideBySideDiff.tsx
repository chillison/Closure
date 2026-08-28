import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import type { PendingDiff } from '../../shared/store/agentSlice';
import { diffLineWords } from '../../shared/diff/wordDiff';
import type { TokenDiff } from '../../shared/diff/wordDiff';

type DiffLine = { type: 'same' | 'add' | 'remove'; left: string; right: string; lineLeft: number; lineRight: number };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: DiffLine[] = [];
  let i = 0, j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({ type: 'same', left: oldLines[i], right: newLines[j], lineLeft: i + 1, lineRight: j + 1 });
      i++; j++;
    } else {
      // Simple greedy: look ahead for a match
      let foundI = -1, foundJ = -1;
      for (let lookahead = 1; lookahead < 10; lookahead++) {
        if (i + lookahead < oldLines.length && oldLines[i + lookahead] === newLines[j]) { foundI = i + lookahead; break; }
        if (j + lookahead < newLines.length && oldLines[i] === newLines[j + lookahead]) { foundJ = j + lookahead; break; }
      }
      if (foundI > 0) {
        while (i < foundI) { result.push({ type: 'remove', left: oldLines[i], right: '', lineLeft: i + 1, lineRight: 0 }); i++; }
      } else if (foundJ > 0) {
        while (j < foundJ) { result.push({ type: 'add', left: '', right: newLines[j], lineLeft: 0, lineRight: j + 1 }); j++; }
      } else {
        if (i < oldLines.length) { result.push({ type: 'remove', left: oldLines[i], right: '', lineLeft: i + 1, lineRight: 0 }); i++; }
        if (j < newLines.length) { result.push({ type: 'add', left: '', right: newLines[j], lineLeft: 0, lineRight: j + 1 }); j++; }
      }
    }
  }
  return result;
}

/**
 * 把行级 DiffLine[] 配对成 hunk 行对（用于词级内嵌）：相邻的 remove 块与 add 块逐行配对。
 * 行数不等时多出行不配对（整行红/绿，不做词级 highlight）。
 *
 * 返回每行附带 `pairedWith`：paired = 与之成词级 diff 的对侧文本（undefined = 不配对，整行渲染）。
 */
function pairChangedLines(lines: DiffLine[]): {
  leftPair: Map<number, string>;   // leftIdx（在 lines 里的索引）→ 对侧 right 文本
  rightPair: Map<number, string>;  // rightIdx → 对侧 left 文本
} {
  const leftPair = new Map<number, string>();
  const rightPair = new Map<number, string>();
  let k = 0;
  while (k < lines.length) {
    // 收集连续 remove 块
    if (lines[k].type === 'remove') {
      const removeStart = k;
      while (k < lines.length && lines[k].type === 'remove') k++;
      const removeEnd = k;
      // 紧随的 add 块
      if (k < lines.length && lines[k].type === 'add') {
        const addStart = k;
        while (k < lines.length && lines[k].type === 'add') k++;
        const addEnd = k;
        // 逐行配对（removeEnd-removeStart 行 vs addEnd-addStart 行，取较短）
        const pairCount = Math.min(removeEnd - removeStart, addEnd - addStart);
        for (let p = 0; p < pairCount; p++) {
          leftPair.set(removeStart + p, lines[addStart + p].right);
          rightPair.set(addStart + p, lines[removeStart + p].left);
        }
      }
    } else {
      k++;
    }
  }
  return { leftPair, rightPair };
}

type Props = {
  /** DiffCard 传（chapter/passage 写）；revision-guard 卡不传（裸 before/after + readonly）。 */
  diff?: PendingDiff;
  /** 改前文本（既有必填）。 */
  oldContent: string;
  /** 改后文本。缺省时从 diff 推导（既有行为，DiffCard 向后兼容零改）。 */
  newContent?: string;
  /** 关闭回调（DiffCard 展开/折叠用）。readonly 模式可不传。 */
  onClose?: () => void;
  /** 只读模式（revision-guard 卡）：隐藏 Accept All/Reject All/close 按钮 + gutter。 */
  readonly?: boolean;
  /** 文件名标签。缺省时从 diff 推导。 */
  fileName?: string;
  /** 左列头标签（缺省 agent.original）。BMad CR Blind-004：revision-guard 卡传「改前（你的原稿）」。 */
  leftLabel?: string;
  /** 右列头标签（缺省 agent.modified）。revision-guard 卡传「改后（AI 改的）」。 */
  rightLabel?: string;
};

type ViewMode = 'split' | 'unified';

/**
 * 体量门（dogfood R2 2026-08-28 真机实测：108KB 风格卡 create_file → 两三千行 ×
 * 双列 DOM 的初始挂载与 accept 重协调各秒级卡顿）。超过阈值不做逐行词级对比，改
 * 体量摘要 + 纯文本预览——implement.md 风险面预案「大体量词级 diff 降级」的落地。
 * 阈值取 40K 字符：常规章稿/节选远在其下照常词级；超限场景（风格卡⑭原文附录等
 * 归档性内容）词级对比本就无阅读价值。文件写入不受影响（原文原样，零截断）。
 */
const LARGE_DIFF_TOTAL_CHARS = 40_000;
/** 折叠态纯文本预览的行数上限（预览可读即可，非完整展示）。 */
const FOLDED_PREVIEW_LINES = 40;

/**
 * Side-by-side / unified 词级 diff 渲染器（Story 7.5）。
 *
 * 两层 diff（GitHub 范式）：行级 computeDiff（贪心，既有）定 changed 行 → 词级 diffLineWords
 * （LCS，新增）在成对 changed 行内画红绿词块。
 *
 * 两消费者共用（design §3）：
 * - DiffCard（passage/chapter 写）：传 diff + oldContent + onClose，整 diff 级 accept/reject。
 * - ChapterReviewPanel revision-guard 卡：传 oldContent=beforeText + newContent=afterText + readonly，
 *   纯展示（force-accept/abort 在卡级别，非 diff 内）。
 *
 * 🔑 Story 7.5 R4：per-line accept/reject 假按钮已清除（OrisonSpace fork 遗留半成品：注释声称
 * per-line override 但 handleAcceptAll 应用整个 diff，15 个月未兑现，误导作者）。accept/reject
 * 现如实表达为整 diff 级（Accept All / Reject All）。微调编辑不在 diff 内（留给人改稿的地方）。
 */
export function SideBySideDiff({ diff, oldContent, newContent, onClose, readonly, fileName, leftLabel, rightLabel }: Props) {
  const { sessionId, acceptDiff, rejectDiff, resolvedLocale } = useAppStore(useShallow((s) => ({
    // dogfood T1 Stage 3（r8 键控）：accept/reject 按当前视图会话的 diff 键（diff 本身也来自视图会话）。
    sessionId: s.agentSessionId,
    acceptDiff: s.acceptDiff,
    rejectDiff: s.rejectDiff,
    resolvedLocale: s.resolvedLocale,
  })));
  const { t } = useI18n(resolvedLocale);
  // newContent：传了用传的（revision-guard 裸 afterText）；否则从 diff 推导（既有行为，DiffCard 零改）。
  const resolvedNew = newContent ?? (diff ? (diff.kind === 'chapter' ? diff.content : diff.replacement) : '');
  const resolvedFileName = fileName
    ?? (diff ? (diff.kind === 'chapter' ? diff.fileName : (diff.filePath ?? diff.chapterId ?? 'passage')) : '');
  const lines = useMemo(() => computeDiff(oldContent, resolvedNew), [oldContent, resolvedNew]);
  const { leftPair, rightPair } = useMemo(() => pairChangedLines(lines), [lines]);

  // 🔑 BMad CR Blind-003 / Edge-004：词级 diff 必须 memo。原 inline 写在 JSX .map 内，每次 re-render
  // 重算所有成对行 + split 左右各算一次（2× 冗余）。现一次性算成对行的 TokenDiff[] 缓存（split 左/右
  // 与 unified 共用同一对 old/new 串结果）。key 用对侧文本（左侧 remove 行 = l.left vs 对侧 right；
  // 右侧 add 行 = 对侧 left vs l.right）。
  const leftWordDiffs = useMemo(() => {
    const m = new Map<number, TokenDiff[]>();
    for (const [idx, pairedRight] of leftPair) {
      const line = lines[idx];
      if (line) m.set(idx, diffLineWords(line.left, pairedRight));
    }
    return m;
  }, [lines, leftPair]);
  const rightWordDiffs = useMemo(() => {
    const m = new Map<number, TokenDiff[]>();
    for (const [idx, pairedLeft] of rightPair) {
      const line = lines[idx];
      if (line) m.set(idx, diffLineWords(pairedLeft, line.right));
    }
    return m;
  }, [lines, rightPair]);

  const [viewMode, setViewMode] = useState<ViewMode>('split');

  const handleAcceptAll = () => { if (diff && sessionId) acceptDiff(sessionId, diff.id); };
  const handleRejectAll = () => { if (diff && sessionId) { rejectDiff(sessionId, diff.id); onClose?.(); } };

  const resolvedLeftLabel = leftLabel ?? (t('agent.original') || 'Original');
  const resolvedRightLabel = rightLabel ?? (t('agent.modified') || 'Modified');

  // 体量门：超限走折叠视图（摘要 + 预览），不渲染逐行对比表。
  if (oldContent.length + resolvedNew.length > LARGE_DIFF_TOTAL_CHARS) {
    const addedLines = Math.max(resolvedNew.split('\n').length - 1, 0);
    const removedLines = Math.max(oldContent.split('\n').length - 1, 0);
    const preview = resolvedNew.split('\n').slice(0, FOLDED_PREVIEW_LINES).join('\n');
    return (
      <div className="diff-side-by-side" data-large-diff-folded="true">
        <div className="diff-sbs-header">
          <span className="diff-sbs-filename">{resolvedFileName}</span>
          <div className="diff-sbs-actions">
            <span className="diff-sbs-folded-note">{t('agent.diffFoldedTitle')}</span>
          </div>
        </div>
        <div className="diff-sbs-folded-stats">
          {t('agent.diffFoldedStats', { added: addedLines, removed: removedLines, total: resolvedNew.length })}
        </div>
        <pre className="diff-sbs-folded-preview">{preview}</pre>
        <div className="diff-sbs-folded-hint">{t('agent.diffFoldedHint')}</div>
      </div>
    );
  }

  return (
    <div className="diff-side-by-side">
      <div className="diff-sbs-header">
        <span className="diff-sbs-filename">{resolvedFileName}</span>
        <div className="diff-sbs-actions">
          {/* 视图切换（split ↔ unified），readonly 模式也可用。 */}
          <button
            type="button"
            className="diff-sbs-btn diff-sbs-view-toggle"
            onClick={() => setViewMode((m) => (m === 'split' ? 'unified' : 'split'))}
            title={viewMode === 'split' ? t('agent.diffViewUnified') : t('agent.diffViewSplit')}
            aria-label={viewMode === 'split' ? t('agent.diffViewUnified') : t('agent.diffViewSplit')}
          >
            <span className="material-symbols-outlined">{viewMode === 'split' ? 'view_stream' : 'compare'}</span>
          </button>
          {!readonly && (
            <>
              <button type="button" className="diff-sbs-btn diff-sbs-btn--accept" onClick={handleAcceptAll}>
                {t('agent.acceptAll')}
              </button>
              <button type="button" className="diff-sbs-btn diff-sbs-btn--reject" onClick={handleRejectAll}>
                {t('agent.rejectAll')}
              </button>
            </>
          )}
          {onClose && (
            <button type="button" className="diff-sbs-btn" onClick={onClose}>
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>
      </div>

      {viewMode === 'split' ? (
        // 🔑 BMad CR Blind-001：split 视图必须用 CSS grid 按行渲染（每 DiffLine 一行，左右 cell 同一 grid row），
        // 让浏览器同步行高。原两列独立 flex map + pre-wrap 换行致 remove 行左列长文本换 3 行、右列空 1 行 →
        // 阶梯错位（每个 changed 行对侧恒空串，中文长段落核心场景必触发）。grid row 内左右 cell 等高对齐。
        <div className="diff-sbs-grid">
          <div className="diff-sbs-col-header">{resolvedLeftLabel}</div>
          <div className="diff-sbs-col-header">{resolvedRightLabel}</div>
          {/* dogfood 2026-08-21 修：行优先 auto-placement 下**左右 cell 必须相邻成对**进
              DOM，同一 DiffLine 才会落进同一 grid row。此前先渲染全部左列再渲染全部右列，
              grid 把左格两两排进同一行、右格整段堆到下方——split 视图整体错乱（左列 8,10,12…
              右列 9,11,13… 交错即其指纹）。Fragment 不产 DOM，仅保 pair 邻接 + key。 */}
          {lines.map((l, idx) => (
            <Fragment key={idx}>
              <div className={`diff-sbs-cell diff-sbs-cell--${l.type}`}>
                <span className="diff-sbs-ln">{l.lineLeft || ''}</span>
                <span className="diff-sbs-text">
                  {l.type === 'remove' && leftWordDiffs.has(idx)
                    ? renderWordDiff(leftWordDiffs.get(idx) ?? [], 'left')
                    : l.left}
                </span>
              </div>
              <div className={`diff-sbs-cell diff-sbs-cell--${l.type}`}>
                <span className="diff-sbs-ln">{l.lineRight || ''}</span>
                <span className="diff-sbs-text">
                  {l.type === 'add' && rightWordDiffs.has(idx)
                    ? renderWordDiff(rightWordDiffs.get(idx) ?? [], 'right')
                    : l.right}
                </span>
              </div>
            </Fragment>
          ))}
        </div>
      ) : (
        <div className="diff-unified-body">
          {lines.map((l, idx) => {
            const sign = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ';
            const wordDiff = l.type === 'remove'
              ? leftWordDiffs.get(idx)
              : l.type === 'add'
                ? rightWordDiffs.get(idx)
                : undefined;
            return (
              <div key={idx} className={`diff-unified-line diff-unified-line--${l.type}`}>
                <span className="diff-unified-sign">{sign}</span>
                <span className="diff-unified-text">
                  {wordDiff
                    ? renderWordDiff(wordDiff, l.type === 'remove' ? 'left' : 'right')
                    : l.left || l.right}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 渲染词级 diff 段为 span 序列（GitHub 式行内红绿 highlight）。
 * - side='left'（remove 行）：渲染 equal + remove（删除词红），add 段不显示（add 在右列）。
 * - side='right'（add 行）：渲染 equal + add（新增词绿），remove 段不显示。
 * 这样左右列拼起来是完整对照，单列看各自的红/绿。
 *
 * space 类的 add/remove 染色弱化（空格差异不画 highlight，避免视觉噪声）。
 */
function renderWordDiff(tokenDiffs: TokenDiff[], side: 'left' | 'right'): ReactNode {
  return tokenDiffs.map((td, i) => {
    const showAs =
      td.kind === 'equal' ? 'equal'
        : td.kind === 'remove' ? (side === 'left' ? 'remove' : 'skip')
          : /* add */ (side === 'right' ? 'add' : 'skip');
    if (showAs === 'skip') return null;
    // space 的 remove/add 不染色（空格差异纯文本显示）。
    if ((showAs === 'add' || showAs === 'remove') && td.token.kind === 'space') {
      return <span key={i}>{td.token.text}</span>;
    }
    if (showAs === 'equal') return <span key={i}>{td.token.text}</span>;
    return (
      <span key={i} className={showAs === 'add' ? 'diff-word--add' : 'diff-word--remove'}>
        {td.token.text}
      </span>
    );
  });
}
