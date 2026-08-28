import { useMemo } from 'react';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { Collapsible } from '../../shared/components/Collapsible';
import { toolPresentation, toolLabel } from './toolMeta';
import { renderMarkdown } from './markdown';

type ToolResultLike = { toolId?: string; toolName?: string; output?: string; metadata?: unknown };

/**
 * dogfood R2 #12（findings #12，2026-08-25）：拦截的三个派发工具 → 产出类型徽标 i18n key。
 * 规划师跑完自称「草案已经给出」但草案两个落点都不可见（组完成自动收起 + 工具卡默认折叠
 * 裸 pre 无 MD）——本卡让整段草案作为**交付物**直接可见。
 */
const DRAFT_BADGE_KEYS: Record<string, string> = {
  dispatch_story_planner: 'agent.draftBadgeOutline',
  dispatch_episode_planner: 'agent.draftBadgeEpisode',
  dispatch_researcher: 'agent.draftBadgeResearch',
};

/**
 * 派发产出拦截判定（mirror findings/settingMd 拦截先例，AgentMessageItem tool 分支最先判）：
 * toolName ∈ 三派发工具 **且** metadata.ok === true（unknown seam 守卫，禁裸 as 信任）。
 * ok:false（错误/空草案/降级提示）不拦截——照走 AgentToolCard，不能被误当草案。
 */
export function dispatchDraftBadgeKey(result: ToolResultLike): string | null {
  const badgeKey = DRAFT_BADGE_KEYS[result.toolName ?? result.toolId ?? ''];
  if (!badgeKey) return null;
  if (!result.metadata || typeof result.metadata !== 'object') return null;
  return (result.metadata as { ok?: unknown }).ok === true ? badgeKey : null;
}

/**
 * 子代理产出卡：**默认展开**（Collapsible defaultOpen，用户可收起）+ header = toolMeta
 * icon + 既有 toolLabel + 产出类型徽标；body = renderMarkdown(output)（DOMPurify 安全
 * 先例同 renderMarkdown）+ max-height 内滚。视觉上比工具卡更「产出物」——accent 左缘条
 * （mirror .agent-reasoning::before 的做法，但语义是交付物，取实色 accent 同
 * .agent-batch-group 先例）。
 */
export function DispatchDraftCard({ result }: { result: ToolResultLike }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  // dogfood R2 批次 D1：大纲草案卡 footer「到大纲面板查看 →」次级钮（详设第三节断层①）。
  const setActivePage = useAppStore((s) => s.setActivePage);
  const toolId = result.toolName ?? result.toolId ?? '';
  const { icon } = toolPresentation(toolId);
  const label = toolLabel(toolId, t);
  const badgeKey = dispatchDraftBadgeKey(result) ?? 'agent.draftBadgeOutline';
  const html = useMemo(() => renderMarkdown(result.output ?? ''), [result.output]);

  return (
    <Collapsible
      defaultOpen
      className="agent-dispatch-draft"
      headerClassName="agent-dispatch-draft-header"
      bodyClassName="agent-dispatch-draft-body"
      chevron="end"
      chevronIcons={{ open: 'expand_less', closed: 'expand_more' }}
      chevronClassName="agent-dispatch-draft-chevron"
      header={
        <>
          <span className="material-symbols-outlined agent-dispatch-draft-icon" aria-hidden="true">{icon}</span>
          <span className="agent-dispatch-draft-name">{label}</span>
          <span className="agent-dispatch-draft-badge">{t(badgeKey)}</span>
        </>
      }
    >
      <div
        className="agent-dispatch-draft-md agent-msg-md"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {/* ── D1（批次 D）：dispatch_story_planner 类草案卡 footer 跳转。**不带
          outlineFocusTarget 焦点**——草案期结构可能还没落（落盘位在 patch 审查，
          草案只是可读文档），带焦点会跳到一个不存在的新增卷锚点。── */}
      {toolId === 'dispatch_story_planner' && (
        <div className="agent-dispatch-draft-footer">
          <button
            type="button"
            className="agent-dispatch-draft-jump"
            onClick={() => setActivePage('outline')}
          >
            {t('agent.patchGoToOutline')}
          </button>
        </div>
      )}
    </Collapsible>
  );
}
