import { useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';

/**
 * Story 3.7：InsightCard 统一洞察卡（design D2）。
 *
 * 「审核洞察可操作化」的统一展示壳——结构校验议题（#1 PatchReviewIssues）、Reader-Audit
 * findings（#2 ReviewFindingsCard）、revision-guard findings（#4）共用。折叠态 = severity
 * 色条 + ≤2 行 title + 紧凑 grounding 行（quote 有才显，WP0 controller 修正）+ 来源/维度 badge
 * + 应用/忽略/展开；展开态 = title 全文 + grounding 完整 + children。
 *
 * 契约纪律（design D2 定案）：
 * - **纯受控展示组件**：props 传入（BatchReportCard 先例），零数据/执行 store 直连
 *   （resolvedLocale 仅作 i18n seam，与 BatchReportCard 同），零内部执行状态——
 *   onApply/onIgnore 由接入方注入，「应用」只映射既有闭环（对话 sendAgentMessage /
 *   applySelectedPatches / reviewRedo / forceAcceptGuard），本组件不新建执行链
 *   （spec ui/agent-panel「只包 UI 统一壳，不移功能」）。
 * - **字段宽容降级**：无 severity → 中性（无修饰 class）；无 grounding → 隐区块；
 *   无 onApply/onIgnore → 隐对应按钮（不造数据）。severity 入参两族归一（toInsightSeverity）。
 * - 不新建聚合面板：卡片只嵌接入方自己的呈现位（spec 禁令）。
 */

/** canonical 三档 severity（R6 归一目标；两族 schema 原样不改，UI 层映射）。 */
export type InsightSeverity = 'error' | 'warning' | 'info';

/** grounding（证据锚定）：quote/location（#2 finding）或 before/after（#4 evidence）。 */
export interface InsightGrounding {
  quote?: string;
  location?: string;
  before?: string;
  after?: string;
}

export interface InsightCardProps {
  /** ≤2 行折叠态主文本（issue.message / finding.explanation / pattern 标签）。 */
  title: string;
  /** 缺 → 中性（无 severity 修饰 class）。 */
  severity?: InsightSeverity;
  /** 来源 badge 的 i18n key（agent.insight.sourceStructure 等）。 */
  source: string;
  /** 维度 badge（展示串；issue.code 经 insightCodeLabel 归一后传入）。 */
  dimension?: string;
  /** 缺 → 隐 grounding 区块。 */
  grounding?: InsightGrounding;
  /** 缺 → 隐「应用」按钮（降级纯展示卡，#4 per-finding 即此）。 */
  onApply?: () => void;
  /** 覆盖应用按钮文案的 i18n key（缺 → agent.insight.apply）。 */
  applyLabel?: string;
  /** 缺 → 隐「忽略」按钮。 */
  onIgnore?: () => void;
  /** 展开态内容（#1 targets+跳时间线 / #4 violatedScope+explanation / 「应用并补充」按钮）。 */
  children?: ReactNode;
  /** 初始展开（默认折叠）。 */
  defaultExpanded?: boolean;
  /**
   * 应用按钮禁用（D11：接入方传 store 的 agentLoading——sendAgentMessage 在 turn 运行中
   * 静默 no-op，按钮必须显式禁用防「点击假死」；intent_restate 先例）。纯受控 prop，
   * 非内部执行状态——D2「无 busy 内部状态」定案不破。
   */
  applyDisabled?: boolean;
  /**
   * 忽略按钮禁用（D5b：#2 ReviewFindingsCard 同章旧卡降级时**全组按钮**禁用——忽略是纯本地
   * UI 不受 agentLoading 限，但 stale 语义下「忽略旧卡」与「应用旧卡」同样应锁）。纯受控 prop，
   * mirror applyDisabled（WP1 已裁决实施期可补受控禁用位）。
   */
  ignoreDisabled?: boolean;
}

/**
 * severity 两族归一（R6，纯函数）：
 * - 结构 issue 三档 `error|warning|info` → 原样；
 * - Reader-Audit finding 二档 `block|warn` → `error`/`warning`；
 * - 缺/未知 → undefined（中性渲染）。不改既有两族 schema。
 */
export function toInsightSeverity(raw: string | undefined): InsightSeverity | undefined {
  if (raw === 'error' || raw === 'warning' || raw === 'info') return raw;
  if (raw === 'block') return 'error';
  if (raw === 'warn') return 'warning';
  return undefined;
}

/**
 * 结构 issue code → 维度 badge 文案。词表内（agent.insight.code.*，11 个
 * validateSceneGraph code）显标签，词表外显原文（mirror GUARD_DRIFT_PATTERN_LABELS /
 * toolLabel 先例——t 缺译返 key 本身，据此判词表外）。
 */
export function insightCodeLabel(code: string, t: (key: string) => string): string {
  const key = `agent.insight.code.${code}`;
  const label = t(key);
  return label === key ? code : label;
}

export function InsightCard({
  title,
  severity,
  source,
  dimension,
  grounding,
  onApply,
  applyLabel,
  onIgnore,
  children,
  defaultExpanded = false,
  applyDisabled = false,
  ignoreDisabled = false,
}: InsightCardProps) {
  const { resolvedLocale } = useAppStore(useShallow((s) => ({ resolvedLocale: s.resolvedLocale })));
  const { t } = useI18n(resolvedLocale);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const hasQuote = Boolean(grounding?.quote);
  const hasBeforeAfter = Boolean(grounding?.before || grounding?.after);

  return (
    <div
      className={`insight-card${severity ? ` insight-card--${severity}` : ''}`}
      data-insight-severity={severity ?? 'none'}
    >
      <div className="insight-card-main">
        {/* 折叠态 line-clamp:2（CSS）；展开态全文（clamp class 移除）。 */}
        <div className={`insight-card-title${expanded ? '' : ' insight-card-title--clamped'}`}>{title}</div>
        {/* 折叠态紧凑 grounding 行（WP0 controller 修正）：quote+location 单行 line-clamp:1——
            证据就在卡上（prd R1/epics 组件规格）；仅 quote 存在时显示（无 quote 隐藏——结构 issue
            无引用不造数据）；before/after 体积大仍仅展开态。title 属性带全文供 hover。 */}
        {!expanded && hasQuote ? (
          <div
            className="insight-card-grounding insight-card-grounding--compact"
            title={`${grounding!.quote}${grounding!.location ? `（${grounding!.location}）` : ''}`}
          >
            <span className="insight-card-grounding-quote">“{grounding!.quote}”</span>
            {grounding!.location ? (
              <span className="insight-card-grounding-location">（{grounding!.location}）</span>
            ) : null}
          </div>
        ) : null}
        <div className="insight-card-meta">
          <span className="insight-card-badges">
            <span className="insight-card-badge insight-card-badge--source">{t(source)}</span>
            {dimension ? (
              <span className="insight-card-badge insight-card-badge--dimension">{dimension}</span>
            ) : null}
          </span>
          <span className="insight-card-actions">
            {onApply ? (
              <button
                type="button"
                className="insight-card-btn insight-card-btn--apply"
                onClick={onApply}
                disabled={applyDisabled}
              >
                {t(applyLabel ?? 'agent.insight.apply')}
              </button>
            ) : null}
            {onIgnore ? (
              <button
                type="button"
                className="insight-card-btn insight-card-btn--ignore"
                onClick={onIgnore}
                disabled={ignoreDisabled}
              >
                {t('agent.insight.ignore')}
              </button>
            ) : null}
            <button
              type="button"
              className="insight-card-btn insight-card-btn--expand"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              {expanded ? t('agent.insight.collapse') : t('agent.insight.expand')}
            </button>
          </span>
        </div>
      </div>
      {expanded ? (
        <div className="insight-card-body">
          {hasQuote ? (
            <div className="insight-card-grounding insight-card-grounding--quote">
              <span className="insight-card-grounding-quote">“{grounding!.quote}”</span>
              {grounding!.location ? (
                <span className="insight-card-grounding-location">（{grounding!.location}）</span>
              ) : null}
            </div>
          ) : null}
          {hasBeforeAfter ? (
            /* before→after 箭头（mirror ChapterReviewPanel guard evidence 渲染语言）。 */
            <div className="insight-card-grounding insight-card-grounding--beforeafter">
              {grounding!.before ? (
                <span className="insight-card-grounding-before">{grounding!.before}</span>
              ) : null}
              {grounding!.before && grounding!.after ? (
                <span className="insight-card-grounding-arrow"> → </span>
              ) : null}
              {grounding!.after ? (
                <span className="insight-card-grounding-after">{grounding!.after}</span>
              ) : null}
            </div>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
