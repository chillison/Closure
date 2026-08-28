import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import type { AgentMessage } from '../../shared/store/agentSlice';
import { AgentMessageItem } from './AgentMessageItem';
import { ChildExecutionGroup } from './ChildExecutionGroup';
import { Collapsible } from '../../shared/components/Collapsible';
import { groupChildTags } from './messageGrouping';
import { batchProgressFrom, latestBatchMeta } from './batchMeta';
import { gearLabelKey } from './gearMeta';

type Props = {
  batchId: string;
  messages: AgentMessage[];
  /** The group contains the stream's last message (tail-reveal gating). */
  isLastOverall: boolean;
  agentLoading: boolean;
  /** dogfood R2 #9：全流已落地 toolCallId 集（AgentMessages 单源计算传入）——调用徽标去重。 */
  resolvedToolCallIds?: ReadonlySet<string>;
};

/**
 * Story 3.5 Step 8 (design §5.2): consecutive same-batchId progress messages,
 * collapsed by default (kills the batch fire-hose). Header = mechanical
 * progress row (n/N scenes · current scene id · gear badge) derived from the
 * most recent batch tool-result metadata in the group — no metadata → degrade
 * to a message count (no invented N). Body nests the existing render paths
 * (AgentMessageItem / ChildExecutionGroup) — nothing is re-implemented.
 *
 * Folded state lives in panelsSlice (`agentBatchExpanded`, project-scoped,
 * cleared by registerProjectReset) — the grouping itself stays pure derived
 * state over the message stream (no new store source of truth).
 */
export function BatchGroup({ batchId, messages, isLastOverall, agentLoading, resolvedToolCallIds }: Props) {
  const { resolvedLocale, expanded, setAgentBatchExpanded } = useAppStore(useShallow((s) => ({
    resolvedLocale: s.resolvedLocale,
    expanded: s.agentBatchExpanded[batchId] ?? false,
    setAgentBatchExpanded: s.setAgentBatchExpanded,
  })));
  const { t } = useI18n(resolvedLocale);

  const inner = useMemo(() => groupChildTags(messages), [messages]);
  const progress = useMemo(() => {
    const meta = latestBatchMeta(messages);
    return meta ? batchProgressFrom(meta) : null;
  }, [messages]);

  const tail = messages[messages.length - 1];

  // Consultation visibility (AC1): the leader stops mid-batch by ending its
  // turn with a question (turn break). That stop message is the group's tail —
  // when the leader is NOT streaming, reveal it below the collapsed group so
  // the author can actually read and answer it. While streaming the progress
  // row alone is shown (that's the anti-fire-hose point). When expanded the
  // tail already renders inside the body — no duplicate.
  const revealTail = !expanded && isLastOverall && !agentLoading && tail !== undefined;

  return (
    <>
      <Collapsible
        open={expanded}
        onToggle={(next) => setAgentBatchExpanded(batchId, next)}
        className="agent-batch-group"
        headerClassName="agent-batch-group-header"
        bodyClassName="agent-batch-group-body"
        chevron="start"
        chevronIcons={{ open: 'expand_more', closed: 'chevron_right' }}
        chevronClassName="agent-batch-group-chevron"
        header={
          <>
            <span className="material-symbols-outlined agent-batch-group-icon" aria-hidden="true">stacks</span>
            <span className="agent-batch-group-title">{t('agent.batchGroupTitle')}</span>
            {progress ? (
              <>
                <span className="agent-batch-group-progress">
                  {t('agent.batchProgressScenes', { done: progress.done, total: progress.total })}
                </span>
                {progress.currentSceneId !== undefined && (
                  <span className="agent-batch-group-scene" title={progress.currentSceneId}>
                    {t('agent.batchCurrentScene', { scene: progress.currentSceneId })}
                  </span>
                )}
                <span className="agent-batch-group-gear">{t(gearLabelKey(progress.gear))}</span>
              </>
            ) : (
              <span className="agent-batch-group-progress">
                {t('agent.batchMessagesCount', { count: messages.length })}
              </span>
            )}
            <span className="agent-batch-group-count">{messages.length}</span>
          </>
        }
      >
        {inner.map((group, gi) =>
          group.type === 'single' ? (
            <AgentMessageItem
              key={group.message.id}
              message={group.message}
              isLatest={isLastOverall && group.message === tail}
              resolvedToolCallIds={resolvedToolCallIds}
            />
          ) : (
            <ChildExecutionGroup
              key={`child-${gi}-${group.source}-${group.role}`}
              source={group.source}
              role={group.role}
              depth={group.depth}
              messages={group.messages}
              resolvedToolCallIds={resolvedToolCallIds}
              isLatestGroup={isLastOverall && group.messages[group.messages.length - 1] === tail}
            />
          ),
        )}
      </Collapsible>
      {revealTail && tail && <AgentMessageItem message={tail} isLatest resolvedToolCallIds={resolvedToolCallIds} />}
    </>
  );
}
