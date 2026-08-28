// ── Story 3.4：ripple-impact finding schema（涟漪语义诊断产出，design §2.3 / §4）──
//
// 作者改一处创作数据 → stale 攒着 → leader 调 diagnose_impacts tool → L1 纯代码缩小候选 +
// world-state 取数 → L2 LLM 语义裁判「实际受影响 + 影响类型」→ 产 RippleImpactFinding[]。
//
// mirror SceneGraphIssue（scene-graph-analytics.ts:187）形态（code/severity/message/targets/suggestion）
// + 加 impactType（开放 string + 词表先验非门禁，mirror outcomeType 范式，interface-contracts.md「语义分类字段
// 用自由值 + 策展词表先验」Convention）+ degraded 标记（无 world-state events 的候选场 graceful 降级）。
//
// 🔑 范式判据（ADR-3 / creative-vs-mechanical.md）：
// - L1 候选缩小（reverse-ref / world-state snapshot 取数）= 纯代码（diagnose-impacts tool 内）。
// - 「实际受影响 + 影响类型 + 怎么修」= LLM 语义（ripple-diagnosis-agent yaml 子 agent）。
// - finding 是 LLM 产（语义裁判结果）；parseRippleImpacts 只机械提取 + shape 校验（纯代码，非语义）。
//
// expected_downstream_consumers:
// - Story 3.4 Phase 3：loadRippleImpactsForLeader 读 finding → buildInteractionModeSegment 注入 leader prompt。
// - Story 3.7 InsightCard：ripple-impact finding（severity+impactType+targets+suggestion）= InsightCard
//   「应用此建议」的数据源（design §8 预留 finding schema 稳定）。

import { z } from 'zod';

// ── impactType 策展词表（先验非门禁，mirror outcomeType / CRAFT_TYPE_VOCAB 范式）──
//
// L2 LLM 判「实际受影响的影响类型」时参考此词表抬上限 + 作 UI 补全先验，但**不门禁**——
// LLM 可写词表外值（零 migration 自定义新类，interface-contracts.md Convention）。
// 纯代码不可按 impactType 词库命中判影响（假信心门，ADR-3）；impactType 是 LLM 语义裁判产出。

export const IMPACT_TYPE_VOCAB = [
  { value: 'conflict', gloss: '冲突：改动与既有正文/状态直接矛盾（如角色已死但后文活着）' },
  { value: 'contradiction', gloss: '矛盾：改动与设定/结构字段不自洽（如能力上限被改但已有超越场景）' },
  { value: 'stale-derivative', gloss: '过时派生：改动让下游派生数据失效（如规则改了但依赖它的场景未更新）' },
  { value: 'opportunity', gloss: '机会：改动创造了新的创作可能（如新设定可丰富后续场景）' },
  { value: 'no-impact', gloss: '无影响：改动经诊断不影响该候选场（L2 判实际无冲突）' },
  { value: 'no-events', gloss: '无实际轨数据：该场无 world state events，无法诊断实际影响（degraded）' },
] as const;

/** 格式化 impactType 词表为 prompt 注入串（mirror formatCraftTypeVocab）。 */
export function formatImpactTypeVocab(): string {
  return IMPACT_TYPE_VOCAB.map((e) => `- ${e.value}：${e.gloss}`).join('\n');
}

// ── finding schema ──

export const rippleImpactTargetSchema = z.object({
  /** 受影响目标类型：scene（场）/ line（线）/ field（创作字段，非场级影响时用）。 */
  kind: z.enum(['scene', 'line', 'field']),
  /** 目标 id（scene id / line id / CreativeFieldKey）。 */
  id: z.string().min(1),
});

export const rippleImpactFindingSchema = z.object({
  /** 机器 code（如 'stale-derivative' | 'conflict' | 'no-events'），作 UI 路由 / 统计 key。 */
  code: z.string().min(1),
  /** 严重度（mirror IssueSeverity）：error=必须处理 / warning=建议处理 / info=知晓即可。 */
  severity: z.enum(['error', 'warning', 'info']),
  /**
   * 影响类型（开放 string + IMPACT_TYPE_VOCAB 词表先验非门禁，mirror outcomeType 范式）。
   * LLM 语义裁判产出——纯代码不可按词库命中判影响（假信心门）。
   */
  impactType: z.string().min(1),
  /** 叙事语言表述（非内部术语）。告知作者「这场实际受什么影响」。 */
  message: z.string().min(1),
  /** 牵涉的目标（场/线/字段）。 */
  targets: z.array(rippleImpactTargetSchema).min(1),
  /** 可选修复建议（叙事语言，非「替你修了」——design「找到了不是替你修了」）。 */
  suggestion: z.string().optional(),
  /** true = 该 finding 因数据缺失降级产出（无 world-state events / L2 parse 失败），非语义裁判结论。 */
  degraded: z.boolean().optional(),
});

export const rippleImpactResultSchema = z.object({
  /** L2 语义裁判产出的 finding 数组（可能含 degraded finding）。空 = 无实际影响（L2 判均无冲突）。 */
  findings: z.array(rippleImpactFindingSchema),
  /** 一句话概括主要影响（leader 文字提用）。 */
  summary: z.string(),
  /** true = 部分/全部候选场因数据缺失降级（无 world-state events / L2 parse 失败）。 */
  degraded: z.boolean(),
  /** 降级原因说明（degraded=true 时填）。 */
  degradationNote: z.string().optional(),
});

export type RippleImpactTarget = z.infer<typeof rippleImpactTargetSchema>;
export type RippleImpactFinding = z.infer<typeof rippleImpactFindingSchema>;
export type RippleImpactResult = z.infer<typeof rippleImpactResultSchema>;

// ── parseRippleImpacts（三路径鲁棒解析，mirror parseAdjudication 对象形态）──
//
// ripple-diagnosis-agent 子 agent runLoop 后返 assistant content —— 期望是
// {"findings":[...], "summary":"...", "degraded":<bool>, "degradationNote":"..."} 形态的 JSON
// （prompts/ripple-diagnosis-agent.yaml 输出契约）。但真实 LLM 常带 ```json 围栏 / 前导自然语言 /
// 多块围栏 → 裸 JSON.parse 抛。本 helper 做 robust 抽取（mirror parseAdjudication P2：multi-fence +
// brace-match + bare 三路径，避单 fence regex 漏多块围栏场景）。
//
// 范式判据：parse = 纯代码机械提取 + shape 校验（非语义）；finding 内容 = LLM 语义产出。

/**
 * parse ripple-diagnosis-agent 返回为 RippleImpactResult（mirror parseAdjudication 三路径）。
 *
 * 三路径鲁棒：① fenced 块（multi-fence tolerant）② first{..last} brace-match ③ 整体 parse。
 * 任一路径提取到合法 RippleImpactResult 即返；失败返 null（caller graceful 降级——findings=[] + degraded=true，
 * mirror completeness-verify-node AC6 永不假 pass）。
 *
 * 合法性硬要求：summary 非空 + findings 是数组（可空）+ degraded 是 boolean。
 * findings 逐条 shape 校验——单条畸形 finding 丢弃保其余（mirror revision-guard filterValidFindings
 * 「坏条目单独丢不全丢」哲学）。
 */
export function parseRippleImpacts(content: string): RippleImpactResult | null {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return null;

  // 路径 1：fenced 块（multi-fence tolerant）。
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1];
    if (!inner) continue;
    const parsed = tryParseRippleImpacts(inner);
    if (parsed) return parsed;
  }

  // 路径 2：brace-match（first { to last }）。
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryParseRippleImpacts(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }

  // 路径 3：整体试 parse（无 fence 单对象）。
  const whole = tryParseRippleImpacts(trimmed);
  if (whole) return whole;

  return null;
}

/** 单候选字符串试 parse + shape 校验为 RippleImpactResult（失败返 null）。 */
function tryParseRippleImpacts(candidate: string): RippleImpactResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (!summary) return null; // 硬要求：summary 非空

  const degraded = typeof o.degraded === 'boolean' ? o.degraded : false;
  const degradationNote = typeof o.degradationNote === 'string' ? o.degradationNote.trim() : undefined;

  // findings 逐条 shape 校验——单条畸形丢弃保其余（mirror revision-guard filterValidFindings）。
  const findingsRaw = Array.isArray(o.findings) ? o.findings : [];
  const findings: RippleImpactFinding[] = [];
  for (const f of findingsRaw) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const fe = f as Record<string, unknown>;
    const code = typeof fe.code === 'string' ? fe.code.trim() : '';
    const severityRaw = typeof fe.severity === 'string' ? fe.severity.trim() : '';
    const severity = severityRaw === 'error' || severityRaw === 'warning' || severityRaw === 'info' ? severityRaw : null;
    const impactType = typeof fe.impactType === 'string' ? fe.impactType.trim() : '';
    const message = typeof fe.message === 'string' ? fe.message.trim() : '';
    if (!code || !severity || !impactType || !message) continue; // 硬要求字段齐

    // targets 逐条校验（mirror rippleImpactTargetSchema）。
    const targetsRaw = Array.isArray(fe.targets) ? fe.targets : [];
    const targets: RippleImpactTarget[] = [];
    for (const t of targetsRaw) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
      const te = t as Record<string, unknown>;
      const kindRaw = typeof te.kind === 'string' ? te.kind.trim() : '';
      const kind = kindRaw === 'scene' || kindRaw === 'line' || kindRaw === 'field' ? kindRaw : null;
      const id = typeof te.id === 'string' ? te.id.trim() : '';
      if (!kind || !id) continue;
      targets.push({ kind, id });
    }
    if (targets.length === 0) continue; // 硬要求：≥1 target

    const suggestion = typeof fe.suggestion === 'string' ? fe.suggestion.trim() : undefined;
    const fDegraded = typeof fe.degraded === 'boolean' ? fe.degraded : undefined;

    findings.push({
      code,
      severity,
      impactType,
      message,
      targets,
      ...(suggestion !== undefined && suggestion.length > 0 ? { suggestion } : {}),
      ...(fDegraded !== undefined ? { degraded: fDegraded } : {}),
    });
  }

  return {
    findings,
    summary,
    degraded,
    ...(degradationNote !== undefined && degradationNote.length > 0 ? { degradationNote } : {}),
  };
}
