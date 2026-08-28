import { useAppStore } from '../../shared/store/appStore';
import { isProjectRunActive } from '../../shared/store/agentSessionSlice';
import { useI18n } from '../../shared/i18n/useI18n';
import type { AgentMessage } from '../../shared/store/agentSlice';
import { insightDismissKey } from '../../shared/store/insightInteractionSlice';
import { InsightCard, toInsightSeverity } from './InsightCard';
import { toolPresentation, toolLabel } from './toolMeta';

/**
 * Story 3.7 #2（design D5/D5b）：Reader-Audit findings 结构化卡组。
 *
 * 数据源：write_chapter tool result metadata.findings（agent 侧 write-chapter.ts additive 透传，
 * `{ source:'reader-audit', route, chapterId?, items: EscalateFinding[] }`）。leader 文字呈现
 * 保留不动（metadata 是加法）；本卡组挂在 tool 消息上，AgentMessageItem tool 分支 findings 档
 * **平铺替换**该 result 的默认呈现位（D5 设计定案——双卡堆叠冗余）。
 *
 * 卡组头 = 工具名小字（tool 元信息保留）+ route badge +（stale 时）新鲜度 badge；
 * per-finding = InsightCard（title=explanation / severity 归一 block→error, warn→warning /
 * dimension=subClass / grounding={quote, location} 折叠紧凑行 + 展开完整）。
 *
 * 「应用」双形态（D3）：单击直发对话改稿指令（auto_revise surface「可告知我如何修改」既有语义
 * 的按钮化）；展开态「应用并补充」presetDraft 预填输入框不直发。apply 受 agentLoading（D11）+
 * 新鲜度（D5b）双门禁用；忽略不受 agentLoading 限（纯本地 UI），但 stale 时全组禁用。
 */

/** source 身份 = InsightCard 的 source i18n key（locale 无关——dismissed 全局共享，键不得随语言切换漂移）。 */
const SOURCE_KEY = 'agent.insight.sourceReaderAudit';

/** 单条 finding（EscalateFinding 经 unknown seam 的形态守卫视图；explanation 为卡 title 必填）。 */
export interface ReaderAuditFindingView {
  subClass?: string;
  severity?: string;
  quote: string;
  location: string;
  explanation: string;
}

export interface ReaderAuditFindingsMeta {
  source: 'reader-audit';
  route: string;
  chapterId?: string;
  items: ReaderAuditFindingView[];
}

type ToolResultLike = { toolId?: string; toolName?: string; output?: string; metadata?: unknown };

/**
 * metadata unknown seam 形态守卫（spec ui/state-management：unknown 值消费前必须守卫，禁裸 as）。
 * source==='reader-audit' 且 items 是数组才认；条目级 explanation（title）非 string 的丢弃
 * （quote/location 容缺省为 ''——不造数据，grounding 缺失时卡片自然降级）。**items 空也返回 meta**
 * （D5b：空审核结果仍作同章新鲜度锚点，渲染层自行判 items.length===0 不出卡组）。
 */
export function extractReaderAuditFindings(metadata: unknown): ReaderAuditFindingsMeta | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const findings = (metadata as { findings?: unknown }).findings;
  if (!findings || typeof findings !== 'object') return null;
  const raw = findings as { source?: unknown; route?: unknown; chapterId?: unknown; items?: unknown };
  if (raw.source !== 'reader-audit' || !Array.isArray(raw.items)) return null;
  const items: ReaderAuditFindingView[] = [];
  for (const item of raw.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const f = item as {
      subClass?: unknown; severity?: unknown; quote?: unknown; location?: unknown; explanation?: unknown;
    };
    // CR-005：空串 explanation 同样丢弃（空标题卡 + 空 title 的 dismiss 键互相碰撞——忽略一条隐掉全部）。
    if (typeof f.explanation !== 'string' || f.explanation.length === 0) continue;
    items.push({
      ...(typeof f.subClass === 'string' ? { subClass: f.subClass } : {}),
      ...(typeof f.severity === 'string' ? { severity: f.severity } : {}),
      quote: typeof f.quote === 'string' ? f.quote : '',
      location: typeof f.location === 'string' ? f.location : '',
      explanation: f.explanation,
    });
  }
  return {
    source: 'reader-audit',
    route: typeof raw.route === 'string' ? raw.route : '',
    ...(typeof raw.chapterId === 'string' ? { chapterId: raw.chapterId } : {}),
    items,
  };
}

/**
 * D5b 新鲜度门（纯函数）：消息列表里同 chapterId 的 reader-audit findings 卡，**最新一条**所在
 * 消息才是可操作锚点。向后扫全部消息取最后命中者（空 items 的 findings metadata 同样计入锚点——
 * 后续空审核结果 = 已再审过，旧卡同样降级）；本消息非锚点 → stale。无 chapterId 的卡不参与
 * 判定（调用方视作最新可操作）。
 */
export function isLatestFindingsForChapter(
  messages: AgentMessage[],
  messageId: string,
  chapterId: string,
): boolean {
  let latestId: string | null = null;
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const r of m.toolResults ?? []) {
      const f = extractReaderAuditFindings(r.metadata);
      if (f && f.chapterId === chapterId) {
        latestId = m.id;
        break;
      }
    }
  }
  return latestId === messageId;
}

type Props = {
  /** 所属 tool 消息 id（D5b 新鲜度判定定位自身在消息列表中的位置）。 */
  messageId: string;
  result: ToolResultLike;
};

export function ReviewFindingsCard({ messageId, result }: Props) {
  const meta = extractReaderAuditFindings(result.metadata);

  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  // dogfood T1 Stage 3（r8 三分）：apply 闸是「有 run 在途勿动」语义——该项目任一会话在跑
  // 都禁（防与 leader 后续写竞争），读 isProjectRunActive 非视图运行态。
  const agentLoading = useAppStore((s) => isProjectRunActive(s));
  const dismissed = useAppStore((s) => s.dismissed);
  const sendAgentMessage = useAppStore((s) => s.sendAgentMessage);
  const dismissInsight = useAppStore((s) => s.dismissInsight);
  const presetDraft = useAppStore((s) => s.presetDraft);
  // D5b：selector 产出 boolean——只在 staleness 翻转时重渲染（不随无关消息 append 重渲）。
  const stale = useAppStore((s) =>
    meta?.chapterId ? !isLatestFindingsForChapter(s.agentMessages, messageId, meta.chapterId) : false,
  );

  // items 空 → 不渲染卡组（leader 文字已传达）——锚点作用在 extract/isLatest 层已履行。
  if (!meta || meta.items.length === 0) return null;

  // CR-002：key 用稳定身份（dismissKey + 全列表 origIdx 后缀）——忽略重过滤后索引左移不串展开态；
  // origIdx 取自 filter 前的全列表位置，同 key 重复条目（畸形数据）也不撞键。
  const visibleFindings = meta.items
    .map((f, idx) => ({ f, idx }))
    .filter(({ f }) => !dismissed[insightDismissKey(SOURCE_KEY, f.explanation, f.quote)]);
  if (visibleFindings.length === 0) return null;

  const toolId = result.toolName ?? result.toolId ?? '';
  const { icon } = toolPresentation(toolId);
  const toolLabelText = toolLabel(toolId, t);
  const routeLabel = meta.route === 'auto_revise'
    ? t('agent.insight.routeAutoRevise')
    : meta.route === 'escalate_user'
      ? t('agent.insight.routeEscalate')
      : meta.route;

  return (
    <div className={`review-findings-card${stale ? ' review-findings-card--stale' : ''}`}>
      <div className="review-findings-card-header">
        <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
        <span className="review-findings-card-tool">{toolLabelText}</span>
        {/* CR-006：route 非法/空串归一为 '' 时不渲染空胶囊 badge。 */}
        {routeLabel ? <span className="review-findings-card-route">{routeLabel}</span> : null}
        {stale ? (
          <span className="review-findings-card-stale">{t('agent.insight.staleBadge')}</span>
        ) : null}
      </div>
      <ul className="review-findings-card-list">
        {visibleFindings.map(({ f, idx }) => (
          <li key={`${insightDismissKey(SOURCE_KEY, f.explanation, f.quote)}#${idx}`}>
            <InsightCard
              title={f.explanation}
              severity={toInsightSeverity(f.severity)}
              source={SOURCE_KEY}
              dimension={f.subClass}
              grounding={f.quote || f.location
                ? { ...(f.quote ? { quote: f.quote } : {}), ...(f.location ? { location: f.location } : {}) }
                : undefined}
              onApply={() => {
                void sendAgentMessage(
                  t('agent.insight.applyFindingPrompt', { quote: f.quote, explanation: f.explanation }),
                );
              }}
              onIgnore={() => dismissInsight(insightDismissKey(SOURCE_KEY, f.explanation, f.quote))}
              applyDisabled={agentLoading || stale}
              ignoreDisabled={stale}
            >
              <div className="insight-card-child-actions">
                {/* D3「应用并补充」：预填输入框不直发；stale 时随全组禁用，agentLoading 不限（D11）。 */}
                <button
                  type="button"
                  className="insight-card-btn insight-card-btn--apply"
                  disabled={stale}
                  onClick={() => {
                    presetDraft(
                      t('agent.insight.applyFindingPreset', { quote: f.quote, explanation: f.explanation }),
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
      {/* CR-001（HIGH）：完整审核原文保留确定性呈现位——裁决器分析/倾向/选项、BLOCK 硬违规警示、
          放手采信失败告知、「可告知我如何修改」指引只在 result.output 里（不在 metadata.findings），
          卡片化替换 DiffCard 呈现位时不可吞掉。mirror DiffCard 卡体（agent-diff-card-body 的
          pre-wrap 先例）：卡 = 结构化摘要（metadata.findings），本块 = 逐字原文保底，非双源。 */}
      {result.output ? (
        <div className="review-findings-card-output">{result.output}</div>
      ) : null}
    </div>
  );
}
