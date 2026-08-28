import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { collectBatchToolRows, truncateByCodePoints } from './batchMeta';
import { toolPresentation, toolLabel } from './toolMeta';

type Props = {
  batchId: string;
  /** Full message stream — the card filters to this batchId mechanically. */
  messages: Parameters<typeof collectBatchToolRows>[0];
};

/** L2 preview length (code points) before the L3 full-text affordance kicks in. */
const ROW_OUTPUT_PREVIEW = 600;

/**
 * Story 3.5 Step 8 (design §5.2): progressive disclosure for the anchor-closing
 * report message (`batchKind === 'report'`).
 *
 * - L0 = the leader's closing message text itself — rendered by AgentMessageItem
 *   above this card (semantic, LLM-produced; the card adds nothing on top).
 * - L1 = one row per tool result in the batch (write_chapter rows surface their
 *   chapterId/fileName via toolSummary). Pure mechanical extraction — mirror
 *   toolSummary(), zero LLM/semantic judgment in the UI.
 * - L2 = expand a row → that tool result's output, truncated.
 * - L3 = expand again → raw full output. (The batch group body renders the same
 *   output through the existing AgentToolCard path when expanded.)
 *
 * No structured metadata → rows degrade to the bare tool list (label + count
 * line via toolSummary fallback); nothing is fabricated.
 */
export function BatchReportCard({ batchId, messages }: Props) {
  const { resolvedLocale } = useAppStore(useShallow((s) => ({ resolvedLocale: s.resolvedLocale })));
  const { t } = useI18n(resolvedLocale);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [fullRow, setFullRow] = useState<string | null>(null);

  const rows = useMemo(() => collectBatchToolRows(messages, batchId), [messages, batchId]);

  if (rows.length === 0) {
    return (
      <div className="agent-batch-report">
        <div className="agent-batch-report-title">{t('agent.batchReportTitle')}</div>
        <div className="agent-batch-report-empty">{t('agent.batchReportNoRows')}</div>
      </div>
    );
  }

  return (
    <div className="agent-batch-report">
      <div className="agent-batch-report-title">{t('agent.batchReportTitle')}</div>
      {rows.map((row) => {
        const open = openRow === row.key;
        const full = fullRow === row.key;
        const preview = row.output !== undefined && Array.from(row.output).length > ROW_OUTPUT_PREVIEW;
        const { icon } = toolPresentation(row.toolId);
        return (
          <div key={row.key} className={`agent-batch-report-row${row.isError ? ' agent-batch-report-row--error' : ''}`}>
            <button
              type="button"
              className="agent-batch-report-row-header"
              onClick={() => {
                setOpenRow(open ? null : row.key);
                if (open) setFullRow(null);
              }}
              aria-expanded={open}
            >
              <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
              <span className="agent-batch-report-row-label">{toolLabel(row.toolId, t)}</span>
              {row.summary && (
                <span className="agent-batch-report-row-summary" title={row.summary}>{row.summary}</span>
              )}
              <span className={`agent-batch-report-row-status${row.isError ? ' agent-batch-report-row-status--error' : ''}`}>
                {row.isError ? '⚠' : '✓'}
              </span>
              <span className="material-symbols-outlined agent-batch-report-row-chevron" aria-hidden="true">
                {open ? 'expand_less' : 'expand_more'}
              </span>
            </button>
            {open && row.output && (
              <div className="agent-batch-report-row-output">
                <pre className="agent-batch-report-pre">
                  {full ? row.output : truncateByCodePoints(row.output, ROW_OUTPUT_PREVIEW)}
                </pre>
                {preview && (
                  <button
                    type="button"
                    className="agent-batch-report-full-btn"
                    onClick={() => setFullRow(full ? null : row.key)}
                  >
                    {full ? t('agent.batchReportCollapse') : t('agent.batchReportExpandFull')}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
