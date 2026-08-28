import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { Collapsible } from '../../shared/components/Collapsible';
import { toolPresentation, toolLabel, toolSummary } from './toolMeta';

type Props = {
  result: { toolId?: string; toolName?: string; output?: string; metadata?: unknown };
};

export function AgentToolCard({ result }: Props) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const imagePaths: string[] =
    result.metadata && typeof result.metadata === 'object' && 'paths' in result.metadata
      ? (result.metadata as { paths: string[] }).paths
      : [];

  // A failed tool surfaces its error as a result whose output starts with
  // "Error:" (see agent loop / tool handlers). Reflect that instead of always
  // showing a green check, so a failure isn't mistaken for success.
  const isError = typeof result.output === 'string' && /^\s*error\b/i.test(result.output);

  const toolId = result.toolName ?? result.toolId ?? '';
  const { icon } = toolPresentation(toolId);
  const label = toolLabel(toolId, t);
  const summary = toolSummary(result);

  // Story 3.5 Step 7: the hand-rolled expand/collapse idiom moved into the
  // shared <Collapsible> — same DOM (the Collapsible IS the card wrapper),
  // same default-collapsed state.
  return (
    <Collapsible
      className={`agent-tool-card${isError ? ' agent-tool-card--error' : ''}`}
      headerClassName="agent-tool-card-header"
      bodyClassName="agent-tool-card-body"
      chevron="end"
      chevronIcons={{ open: 'expand_less', closed: 'expand_more' }}
      chevronClassName="agent-tool-card-chevron"
      header={
        <>
          <span className="material-symbols-outlined agent-tool-card-icon" aria-hidden="true">{icon}</span>
          <span className="agent-tool-card-name">{label}</span>
          {summary && <span className="agent-tool-card-summary" title={summary}>{summary}</span>}
          <span className={`agent-tool-card-status${isError ? ' agent-tool-card-status--error' : ''}`}>
            {isError ? '⚠' : '✓'}
          </span>
        </>
      }
    >
      {imagePaths.map((p) => (
        <img key={p} src={`orison-file:///${p}`} className="agent-tool-card-image" alt="" />
      ))}
      {result.output && <pre className="agent-tool-card-output">{result.output}</pre>}
    </Collapsible>
  );
}
