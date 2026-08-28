import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { isProjectRunActive } from '../../shared/store/agentSessionSlice';
import { useI18n } from '../../shared/i18n/useI18n';
// Story 3.3 线 A 起复用 ValidationOverlay 的 severity 汇总（同包跨 feature import，无循环——
// structure 不依赖 agent-panel）。summarizeIssues 是纯函数（issues → counts/worst/title）。
import { summarizeIssues } from '../structure/ValidationOverlay';
import { InsightCard, insightCodeLabel } from './InsightCard';
import { insightDismissKey } from '../../shared/store/insightInteractionSlice';

/**
 * Story 3.7 #1（design D4）：3.3 线 A 议题区从 PatchReviewPanel 内联 IIFE extract 成独立组件。
 *
 * 数据与守卫：store 直连 `pendingPatchIssues`（creativeFieldsSlice setPendingPatch 时跑
 * validateSceneGraph 产 issues——1.3 数据通道），自守卫 length===0 / 全部已忽略 → return null。
 * PatchReviewPanel 原位挂载（保留其外层 gate 结构）。
 *
 * per-issue 换 InsightCard（统一洞察卡范式）：
 * - title = issue.message verbatim（ValidationOverlay 既有约定：叙事语言不 rephrase）；
 *   severity 三档原样；dimension = insightCodeLabel(issue.code)（词表外显原文）。
 * - **onApply = 发对话消息**（#7 intent_restate 先例）——leader 调 scene_graph_update 产修复
 *   patch → 同 run merge 进 pendingPatch（CR-013 既有）→ PatchReviewPanel 人审。**零新执行链**
 *   （epics「只包 UI 统一壳，不移功能」）。apply 按钮随 agentLoading 禁用（D11——
 *   sendAgentMessage turn 运行中静默 no-op，禁用防点击假死）。
 * - 展开态 children = suggestion（→ 前缀既有呈现）+ targets 列表 + 「在时间线修复」（3.3 原逻辑
 *   per-issue 保留，零功能损失）+「应用并补充」（presetDraft 预填输入框不直发，D3）。
 * - onIgnore = dismissInsight（D3 会话内隐藏；忽略不受 agentLoading 限——纯本地 UI）。
 *
 * 汇总头纪律：计数 badge / summarizeIssues 反映**数据真相**（校验结果原样，已忽略条目不排除——
 * 忽略只隐卡片非改校验结果）；全部忽略 → 组件整体 null。
 *
 * 行为不变项：error 级不阻断 accept + art-mode override（creativeFieldsSlice）不在本组件。
 */

/** source 身份 = InsightCard 的 source i18n key（locale 无关——dismissed 全局共享，键不得随语言切换漂移）。 */
const SOURCE_KEY = 'agent.insight.sourceStructure';

// 键控选择器稳定空值（r8：防 useShallow 新引用全量重渲）。
const EMPTY_PATCH_ISSUES: never[] = [];

export function PatchReviewIssues() {
  const {
    pendingPatchIssues,
    dismissed,
    agentLoading,
    sendAgentMessage,
    dismissInsight,
    presetDraft,
    // Story 3.3 线 A：跳时间线修复——setActivePage 切到 structure 页，setFocusIssueTargets
    // 让时间线聚焦对应场景格（复用既有 indexIssuesByTarget 映射）。
    setActivePage,
    setFocusIssueTargets,
    resolvedLocale,
  } = useAppStore(useShallow((s) => ({
    pendingPatchIssues: (s.agentSessionId ? s.pendingPatchBySession[s.agentSessionId]?.issues : undefined) ?? EMPTY_PATCH_ISSUES,
    dismissed: s.dismissed,
    // dogfood T1 Stage 3（r8 三分）：apply 闸 =「有 run 在途勿动」（项目运行语义）。
    agentLoading: isProjectRunActive(s),
    sendAgentMessage: s.sendAgentMessage,
    dismissInsight: s.dismissInsight,
    presetDraft: s.presetDraft,
    setActivePage: s.setActivePage,
    setFocusIssueTargets: s.setFocusIssueTargets,
    resolvedLocale: s.resolvedLocale,
  })));

  const { t } = useI18n(resolvedLocale);

  if (pendingPatchIssues.length === 0) return null;

  // 汇总头 = 数据真相（summarizeIssues 语义：校验结果原样，含 info——BMad CR Blind-003 约定）。
  const summary = summarizeIssues(pendingPatchIssues);

  // 忽略 = 会话内隐藏该条卡片（D3 全局 dismissed，跨面同步）；已忽略条目不影响上方汇总计数。
  // CR-002：key 用稳定身份（dismissKey + 全列表 origIdx 后缀）——忽略重过滤后索引左移不串展开态。
  const visibleIssues = pendingPatchIssues
    .map((issue, idx) => ({ issue, idx }))
    .filter(({ issue }) => !dismissed[insightDismissKey(SOURCE_KEY, issue.message)]);
  if (visibleIssues.length === 0) return null;

  return (
    <div className="patch-review-issues-section" aria-label={t('agent.patchIssuesTitle')}>
      <div className="patch-review-issues-header">
        <strong>{t('agent.patchIssuesTitle')}</strong>
        <span className="patch-review-issues-counts">
          {summary.counts.error > 0 && (
            <span
              className="patch-review-severity-count patch-review-severity-count--error"
              data-validation-severity="error"
            >
              {summary.counts.error}
            </span>
          )}
          {summary.counts.warning > 0 && (
            <span
              className="patch-review-severity-count patch-review-severity-count--warning"
              data-validation-severity="warning"
            >
              {summary.counts.warning}
            </span>
          )}
          {summary.counts.info > 0 && (
            <span
              className="patch-review-severity-count patch-review-severity-count--info"
              data-validation-severity="info"
            >
              {summary.counts.info}
            </span>
          )}
        </span>
      </div>
      <ul className="patch-review-issues-list">
        {visibleIssues.map(({ issue, idx }) => (
          <li key={`${insightDismissKey(SOURCE_KEY, issue.message)}#${idx}`}>
            <InsightCard
              title={issue.message}
              severity={issue.severity}
              source={SOURCE_KEY}
              dimension={insightCodeLabel(issue.code, t)}
              onApply={() => {
                void sendAgentMessage(
                  issue.suggestion
                    ? t('agent.insight.applyFixPromptWithSuggestion', { message: issue.message, suggestion: issue.suggestion })
                    : t('agent.insight.applyFixPrompt', { message: issue.message }),
                );
              }}
              onIgnore={() => dismissInsight(insightDismissKey(SOURCE_KEY, issue.message))}
              applyDisabled={agentLoading}
            >
              {issue.suggestion ? (
                <div className="patch-review-issue-suggestion">→ {issue.suggestion}</div>
              ) : null}
              {issue.targets.length > 0 && (
                <div className="patch-review-issue-targets">
                  <span>{t('agent.insight.targetsLabel')}</span>
                  {issue.targets.map((tg, j) => (
                    <span key={`${tg.kind}-${tg.id}-${j}`} className="patch-review-issue-target">
                      {tg.kind}:{tg.id}
                    </span>
                  ))}
                </div>
              )}
              <div className="insight-card-child-actions">
                {/* 3.3「在时间线修复」原逻辑保留（per-issue targets 聚焦对应场景格）。CR-010：导航
                  动作用 --secondary 描边类，非 --ignore 语义类。 */}
                <button
                  type="button"
                  className="insight-card-btn insight-card-btn--secondary"
                  onClick={() => {
                    setFocusIssueTargets(issue.targets);
                    setActivePage('structure');
                  }}
                >
                  {t('agent.patchIssuesFixInTimeline')}
                </button>
                {/* D3「应用并补充」：预填输入框不直发（用户补完自己发）；预填不受 agentLoading 限。 */}
                <button
                  type="button"
                  className="insight-card-btn insight-card-btn--apply"
                  onClick={() => {
                    presetDraft(
                      issue.suggestion
                        ? t('agent.insight.applyFixPresetWithSuggestion', { message: issue.message, suggestion: issue.suggestion })
                        : t('agent.insight.applyFixPreset', { message: issue.message }),
                    );
                  }}
                >
                  {t('agent.insight.applyAndSupplement')}
                </button>
              </div>
            </InsightCard>
          </li>
        ))}
      </ul>
    </div>
  );
}
