import { z } from 'zod';
import type { LockAuthority } from './revision-intent';
import { lockAuthoritySchema } from './revision-intent';
import type { RevisionGuardL1Report } from './revision-guard-l1';

// ── Story 7.2：meaning-preservation 护栏 artifact（design §1.2，mirror review.latest 链段 artifact）──
//
// revision-guard 节点（chapter-nodes.ts createRevisionGuardNode）产 revision_guard artifact：L2 越界判定
// （verdict + findings[]）+ L1 幅度 report + 改前/改后快照。链段 artifact（非持久化、无 DB migration，
// mirror review.latest precedent）。FR-293 RevisionFinding「语义漂移」类别持久化 defer 7.4/Epic 13。
//
// 🔑 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：漂移裁判（越界没 / 哪类漂移）
// = 语义 = L2 LLM（revision-guard-agent.yaml）。本 schema 只做 shape 守卫 + 机械 verdict 路由
// （clean/soft-violation/hard-violation 决定节点三层处置 = 纯代码 dispatch，封闭 enum 合理）。
//
// 🔑 pattern 自由 string + 策展词表（interface-contracts「语义分类自由值非封闭枚举」+ creative-vs-mechanical）：
// GuardDriftPattern 是 L2 输出的**语义分类**（漂移模式），用 z.string() 自由值 + GUARD_DRIFT_PATTERNS
// 策展词表常量作 prior（注入 L2 prompt 检查清单 + UI 展示），**非封闭 z.enum()**——否则 LLM 写词表外
// 漂移类（如未来新发现的模式）被 schema 拒，违「语义分类归 LLM」。
//
// expected_downstream_consumers:
// - Story 7.2 revision-guard 节点：产 revision_guard artifact，verdict 驱动三层处置（clean splice /
//   soft-violation pause art-mode / hard-violation error）+ onCheckpoint 动态 pause（仅 soft-violation）。
// - Story 7.2 UI（ChapterReviewPanel）：soft-violation pause 时读 findings + beforeText/afterText 展 art-mode 卡。
// - Story 7.5 词级 diff UI：消费 beforeText/afterText（既有字段预留）。
// - Story 7.4 / FR-293（13.5）：漂移发现持久化消费 findings[]（defer 7.4/Epic 13）。

/**
 * 漂移模式策展词表（L2 检查清单 prior + UI 展示，**非 schema 门禁**）。
 *
 * 6 类（用户 AI 润色失误案例提炼，prd「漂移模式」表）：
 * - `semantic-retreat`   语义/动作倒退（研究→拆：观察退回破坏，无视上下文进展）。
 * - `viewpoint-loss`     视角丢失（坐车→开车：主观推断/角色位置换成客观陈述）。
 * - `agency-removal`     角色主体性消除（仍是不说话→依旧死寂：人的状态换成环境）。
 * - `tone-rhythm-cut`    语气/节奏/性格词删除（删语气词/缓冲词/口语节奏）。
 * - `verbal-tic`         AI 口癖注入（万能副词滥用如「死」、A不B 句式如「锁不住」）。
 * - `imagery-downgrade`  意象降级（具体生活经验换成陈词套路）。
 *
 * L2 可写词表外值（未来新漂移模式）——schema 不拒（z.string()），UI 据 pattern 展示（词表内显中文标签，
 * 词表外显原文）。语义分类归 LLM 非 schema 门禁。
 */
export const GUARD_DRIFT_PATTERNS = [
  'semantic-retreat',
  'viewpoint-loss',
  'agency-removal',
  'tone-rhythm-cut',
  'verbal-tic',
  'imagery-downgrade',
] as const;

/** pattern → 中文标签（UI 展示用，词表外值显原文）。 */
export const GUARD_DRIFT_PATTERN_LABELS_ZH: Record<string, string> = {
  'semantic-retreat': '语义/动作倒退',
  'viewpoint-loss': '视角丢失',
  'agency-removal': '角色主体性消除',
  'tone-rhythm-cut': '语气/节奏/性格词删除',
  'verbal-tic': 'AI 口癖注入',
  'imagery-downgrade': '意象降级',
};

/**
 * 作者声音默认 soft 维度（L2 violatedScope 用，**非用户显式 lockedItems**）。
 *
 * prd 修正③：用户写指令时想不到列「别把人的沉默换成环境死寂」。作者声音（语气/视角/节奏/意象/主体性）
 * = 默认 soft 保义维度，护栏默认查（即便用户没列 lockedItems），越界产 soft-violation finding
 * （authority='soft'，violatedScope 取本词表值）。用户显式 lockedItems 的 field 仍是 finding.violatedScope
 * （原样透传，非本词表）。
 */
export const AUTHOR_VOICE_DIMENSIONS = ['tone', 'viewpoint', 'rhythm', 'imagery', 'agency'] as const;

/** L2 越界判定——per-lock / per-作者声音维度。 */
export interface GuardFinding {
  /**
   * 漂移模式类（自由 string，GUARD_DRIFT_PATTERNS 词表作 prior 非门禁）。
   * L2 据 6 类清单逐类判，可写词表外值（未来新模式）。
   */
  pattern: string;
  /**
   * 越界的范围：用户显式 lockedItem 的 field（原样透传，如「角色性格」/「结局」）OR
   * 作者声音维度（AUTHOR_VOICE_DIMENSIONS：tone|viewpoint|rhythm|imagery|agency）。
   */
  violatedScope: string;
  /** 权威：hard（用户显式 lockedItem authority='hard'）/ soft（Agent 推断 lockedItem authority='soft' 或作者声音默认维度）。 */
  authority: LockAuthority;
  /** 逐词对照证据（改前→改后 + 模式命名 explanation，非笼统「有漂移」）。grounding 硬要求。 */
  evidence: {
    before: string;
    after: string;
    explanation: string;
  };
}

/** Zod schema for {@link GuardFinding}. */
export const guardFindingSchema = z.object({
  pattern: z.string().min(1),
  violatedScope: z.string().min(1),
  authority: lockAuthoritySchema,
  evidence: z.object({
    before: z.string(),
    after: z.string(),
    explanation: z.string().min(1),
  }),
});

/**
 * L2 guard verdict（**机械 dispatch 用封闭 enum**——决定节点三层处置 = 纯代码路由，非语义分类）。
 *
 * - `clean`           无越界 → 节点 splice 落 draft.initial（零打扰）。
 * - `soft-violation`  越界 soft 锁（Agent 推断 lockedItem 或作者声音默认维度）→ 不 splice + pause art-mode。
 * - `hard-violation`  越界 hard 锁（用户显式 lockedItem）→ error artifact 强制拦（不可放行）。
 *
 * escalate fallback：L2 parse 失败 → hard-violation（**永不假 clean pass**，design §1.2）。
 */
export const GUARD_VERDICTS = ['clean', 'soft-violation', 'hard-violation'] as const;
export type GuardVerdict = (typeof GUARD_VERDICTS)[number];

/** Zod schema for {@link GuardVerdict}. */
export const guardVerdictSchema = z.enum(GUARD_VERDICTS);

/**
 * revision-guard artifact（revision_guard，mirror review.latest 链段非持久化）。
 *
 * 多形态宽松类型（fields 按形态可有可无——error/skipped 形态不携带全部 verdict-form 字段，故全 optional）：
 * - **verdict 形态**（clean/soft-violation）：verdict + findings[] + l1Report + before/after + summary。
 * - **error 形态**（hard-violation / splice 失败 / draft 缺字段 / L2 失败 fallback）：{error:true, nodeId, message, findings?}——
 *   不带 verdict/l1Report/summary（BMad CR CR-BLIND-002：原 required 是类型谎，error 形态实际不产这些字段）。
 * - **skipped 形态**（整章路径 pass-through）：{verdict:'clean', skipped:true, summary}。
 * - **forceAccepted 形态**（art-mode 放行后 splice）：{verdict:'clean', forceAccepted:true, findings:[原 soft], summary}。
 *
 * findings 空数组合法（clean = 无越界）。consumer 消费前判形态（error? / skipped? / verdict）。
 */
export type RevisionGuardArtifact = {
  /** verdict 形态在（clean/soft-violation）；error 形态可缺（isErrorArtifact 查 error 字段）。 */
  verdict?: GuardVerdict;
  findings?: GuardFinding[];
  /** L1 report（verdict 形态节点填；error/skipped 缺）。 */
  l1Report?: RevisionGuardL1Report;
  /** 改前段落快照（art-mode gate 展示 + 7.5 词级 diff 用）。clean/error/skipped 时可缺。 */
  beforeText?: string;
  /** 改后段落快照（同上）。 */
  afterText?: string;
  summary?: string;
  /** art-mode force-accept 标记（soft-violation 经 guardOverride 放行后 splice，保留原 findings 可观测）。 */
  forceAccepted?: boolean;
  /** skipped 标记（整章路径 pass-through，draft-writer 整章 text 无段落级改稿）。 */
  skipped?: boolean;
  /** error 形态（hard-violation / splice 失败 / draft 缺字段 / L2 失败 fallback）。chainRunner isErrorArtifact 检 {error:true}。 */
  error?: true;
  nodeId?: string;
  message?: string;
};

/**
 * Zod mirror of {@link RevisionGuardArtifact}（revision-guard-agent 输出 JSON 校验 + 节点 shape 守卫）。
 *
 * parseRevisionGuard 用此 schema safeParse 防御 LLM 输出畸形。verdict/findings 是 L2 输出核心；
 * l1Report/beforeText/afterText 由节点填（L2 只产 verdict+findings+summary），parse 容忍其缺失（节点后填）。
 *
 * 🔑 BMad CR CR-EDGE-003（per-element finding parse）：findings 用 `z.array(guardFindingSchema).catch([])`
 * + parse 端逐元素 safeParse 过滤——单条畸形 finding（如 LLM 漏 explanation）**不丢整个 verdict**，
 * 只丢该条保其余（mirror stylometry matchWordbankPerSentence 坏条目单独丢不全丢哲学）。原 z.array 整体
 * safeParse 失败会丢 5 条好 finding + 整个 verdict → hard-violation 升级（一章被单条畸形 finding 硬拦）。
 */
export const revisionGuardArtifactSchema = z.object({
  verdict: guardVerdictSchema,
  findings: z.array(guardFindingSchema).default([]),
  summary: z.string().default(''),
  // L2 输出可不含 l1Report/beforeText/afterText（节点填）；schema 容忍缺失，节点 safeParse 后补。
  l1Report: z.any().optional(),
  beforeText: z.string().optional(),
  afterText: z.string().optional(),
  forceAccepted: z.boolean().optional(),
  skipped: z.boolean().optional(),
});

/**
 * 单条 finding shape 守卫（per-element parse，CR-EDGE-003）。
 *
 * 用 guardFindingSchema.safeParse 逐条校验：合法 → 保留；畸形 → 丢该条保其余。单条畸形 finding
 * 不再升级整个 verdict 为 hard-violation。
 */
export function filterValidFindings(raw: unknown): GuardFinding[] {
  if (!Array.isArray(raw)) return [];
  const valid: GuardFinding[] = [];
  for (const item of raw) {
    const result = guardFindingSchema.safeParse(item);
    if (result.success) valid.push(result.data);
  }
  return valid;
}

// ── parseRevisionGuard（三路径鲁棒解析，mirror parseRevisionIntent / parseAdjudication）──

/**
 * 解析 revision-guard-agent 返回的 guard verdict JSON 串。
 *
 * 三路径鲁棒（mirror parseRevisionIntent shared-contracts 三路径，对象形态）：
 * 1. **扫所有 ```json/``` fenced 块**（global regex，multi-fence tolerant）。
 * 2. **brace-match（first `{` to last `}`）**——无 fence 时的 narration-tolerant fallback。
 * 3. **整体试 parse**（最后兜底——无 fence 单对象）。
 *
 * 任一路径提取到合法对象 → revisionGuardArtifactSchema safeParse（verdict/findings shape 守卫）→
 * RevisionGuardArtifact（verdict+findings+summary）；全失败 → 返 null（caller graceful，escalate fallback
 * → hard-violation，**永不假 clean**，design §1.2）。
 *
 * 🔑 范式判据：parse 只机械提取 + shape 校验（纯代码），「漂移裁判」归 L2 LLM（已在 generate 阶段完成，
 * parse 不重做语义判断）。
 *
 * @param content revision-guard-agent 返的 assistant content（期望是 guard verdict JSON 串）。
 * @returns        {verdict, findings, summary} 或 null（caller graceful → hard-violation fallback）。
 */
export function parseRevisionGuard(
  content: string,
): { verdict: GuardVerdict; findings: GuardFinding[]; summary: string } | null {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return null;

  // 路径 1：fenced 块（multi-fence tolerant）。
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1];
    if (!inner) continue;
    const parsed = tryExtractGuard(inner);
    if (parsed) return parsed;
  }

  // 路径 2：brace-match（first { to last }）。
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryExtractGuard(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }

  // 路径 3：整体试 parse。
  return tryExtractGuard(trimmed);
}

/**
 * 单候选字符串试 JSON.parse + shape 守卫（verdict/summary via schema + findings per-element filter）。
 *
 * 🔑 BMad CR CR-EDGE-003：findings 用 filterValidFindings 逐条 safeParse（drop bad keep good），**不随 schema
 * 整体 safeParse 失败丢**。verdict/summary 仍 schema 校验（核心字段）；findings 单条畸形（LLM 漏 explanation 等）
 * 只丢该条保其余，不升级整个 verdict 为 hard-violation。verdict 缺/非法 → 返 null（caller escalate fallback）。
 */
function tryExtractGuard(
  candidate: string,
): { verdict: GuardVerdict; findings: GuardFinding[]; summary: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  // verdict 必填 + 合法 enum（核心字段，非法 → null caller escalate）。
  const verdictResult = guardVerdictSchema.safeParse(record.verdict);
  if (!verdictResult.success) return null;
  const summary = typeof record.summary === 'string' ? record.summary : '';
  // findings per-element filter（CR-EDGE-003）：单条畸形丢该条保其余，不丢整个 verdict。
  const findings = filterValidFindings(record.findings);
  return { verdict: verdictResult.data, findings, summary };
}

/**
 * 形状守卫：unknown → RevisionGuardArtifact verdict/findings/summary（防御 in-process 构造路径如 7.4 A-trigger）。
 *
 * 仅 shape 校验（schema safeParse），不做语义裁判。落 shared-contracts 供 agent 节点 + shell IPC 共享。
 *
 * @param raw 候选对象（已 parse 出）。
 * @returns   {verdict, findings, summary} 或 undefined（caller 降级 graceful）。
 */
export function coerceRevisionGuard(
  raw: unknown,
): { verdict: GuardVerdict; findings: GuardFinding[]; summary: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const verdictResult = guardVerdictSchema.safeParse(record.verdict);
  if (!verdictResult.success) return undefined;
  const summary = typeof record.summary === 'string' ? record.summary : '';
  // findings per-element filter（CR-EDGE-003，mirror tryExtractGuard）。
  const findings = filterValidFindings(record.findings);
  return { verdict: verdictResult.data, findings, summary };
}
