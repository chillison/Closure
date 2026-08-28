import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { Collapsible } from '../../shared/components/Collapsible';

/**
 * dogfood R2 #81（findings #81，2026-08-28）：链内结构化指令 JSON 折叠卡。
 *
 * 导演（director-agent）按输出契约（prompts/director-agent.yaml「输出契约（纯 JSON）」）
 * 把五段指令（entries / emotionPoints / emotionTarget / atomicEditProposals / storyDecisions）
 * 作为 child 的**最终 assistant 正文**整段输出——这是给机器消费的链内产出（write_chapter
 * 解析编译进写手上下文），却被 child 消息渲染路径当人读正文裸奔（#12 DispatchDraftCard
 * 同族：链内结构化产出缺「拦截 → 专用呈现」层）。本模块在 **UI 渲染层拦截**（agent 数据/
 * 机器通道零改动，mirror #12 拦截先例）：child 消息正文整体形态命中「链产出键族 JSON」时
 * 渲染折叠小卡，不进正文通道。
 */

/**
 * 链产出键族（显式清单——director-agent.yaml 输出契约五段）。
 * 判据 = 整体可 JSON.parse ∧ 顶层对象 ∧ 含键族至少一键：**纯代码形态判断，不判语义**；
 * 键族外 JSON / 普通散文照旧正文渲染（零误伤）。新链 agent 输出契约加键时同步此清单。
 */
const CHAIN_DIRECTIVE_KEYS: readonly string[] = [
  'entries',
  'emotionPoints',
  'emotionTarget',
  'atomicEditProposals',
  'storyDecisions',
];

/** 数组段（标题计数口径——emotionTarget 是章级单对象，不计条）。 */
const CHAIN_DIRECTIVE_COUNT_KEYS: readonly string[] = [
  'entries',
  'emotionPoints',
  'atomicEditProposals',
  'storyDecisions',
];

export type ChainDirectivePayload = {
  /** 原文 verbatim（展开查看用——不重序列化，保真机器通道原文）。 */
  raw: string;
  /** 四数组段条数和（entries + emotionPoints + atomicEditProposals + storyDecisions）。 */
  itemCount: number;
};

/**
 * child 正文整体形态判定（#81）。null = 非链指令形态，照旧正文渲染。
 *
 * - 整体形态门：bare JSON 对象，或**整条**被单个 ```json fence 包裹（LLM 偶发围栏——
 *   agent 侧 extractJson 同族形态容忍）。前导叙述 + JSON 混合形态不认——那仍是人读
 *   正文，折叠会吃掉叙述。
 * - 流式兼容：不完整 JSON（无闭合 }）parse 失败 → 返 null 照旧正文流式，终帧完整后
 *   自然收敛成卡。
 */
export function parseChainDirectiveJson(content: string): ChainDirectivePayload | null {
  const raw = (content ?? '').trim();
  if (!raw) return null;
  let candidate = raw;
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) candidate = fence[1].trim();
  if (!candidate.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!CHAIN_DIRECTIVE_KEYS.some((k) => k in obj)) return null;
  let itemCount = 0;
  for (const key of CHAIN_DIRECTIVE_COUNT_KEYS) {
    const v = obj[key];
    if (Array.isArray(v)) itemCount += v.length;
  }
  return { raw, itemCount };
}

/**
 * 折叠小卡：**默认折叠**（对照 DispatchDraftCard 默认展开——那是给人审的交付物，这是
 * 机器内部产出，人读价值在「已产出 · N 条」事实 + 需要时的原文抽查）。header = 标题
 * 计数（i18n），body = JSON 原文 verbatim（pre-wrap 内滚，不 MD 渲染——机器通道原文）。
 */
export function ChainDirectiveCard({ payload }: { payload: ChainDirectivePayload }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  return (
    <Collapsible
      className="agent-chain-directive"
      headerClassName="agent-chain-directive-header"
      bodyClassName="agent-chain-directive-body"
      chevron="end"
      chevronIcons={{ open: 'expand_less', closed: 'expand_more' }}
      chevronClassName="agent-chain-directive-chevron"
      header={
        <>
          <span className="material-symbols-outlined agent-chain-directive-icon" aria-hidden="true">data_object</span>
          <span className="agent-chain-directive-title">
            {t('agent.chainDirectiveTitle', { count: payload.itemCount })}
          </span>
        </>
      }
    >
      <pre className="agent-chain-directive-json">{payload.raw}</pre>
    </Collapsible>
  );
}
