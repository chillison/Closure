import { z } from 'zod';
import { selectionAnchorSchema } from './attachment';
import type { SelectionAnchor } from './attachment';

// ── Story 7.1：RevisionIntent — 结构化改稿意图（child4 §1.2-1.4 / design §2.1 / ADR-3 / ADR-4）──
//
// 给 AI 改稿一个**结构化意图**：改什么 / 不改什么（锁定项 硬锁/软锁）/ 为什么 / 来源标注。
// 由专门 Agent（revision-optimizer-agent）从粗指令 + 上下文编译、用户确认后下发，替代裸改稿。
// 补 charter 级「人导演 LLM 主笔」保义底线（AI 改稿不漂作者语义）。
//
// 三 trigger 共享（design §0）：
// - B 选区指挥精修（7.1 e2e）：ChapterReviewPanel draft checkpoint pause → 用户选段 + 自然语言指令。
// - A auto_revise findings→intent（7.4 复用）：Reader-Audit findings 触发 → 同 core（schema + optimizer + 下发格式）。
// - C redo 反馈升级（defer）：自由文本升级路径，B1 选区精修是更优形态。
//
// 🔑 范式判据（ADR-3 / creative-vs-mechanical）：意图编译 / 锁定项推断（"别动性格"→硬锁）/ 改什么细化
// 归 LLM（revision-optimizer yaml prompt）；schema 定义 / parse / 派发 wiring / 选区锚点捕获归纯代码。
//
// 🔑 三层权威（child4 §1.4 + ADR-4 traceableSourceRefs）：provenance 标注哪些是用户硬决定、哪些 AI 理解；
// lockedItems 分硬锁（用户原话）/ 软锁（优化 Agent 推断，标「LLM 理解」）。下发到 draft-writer 同时拿
// 两层（用户原话硬 + 编译软标 LLM 理解），让 LLM 有判断空间不被锁死（design §2.3）。
//
// 链段 artifact（非持久 creative field）—— 无 DB migration（design §2.1 向下兼容）。7.4 闭环落 FR-293
// RevisionFinding 时再议持久化（prd Out of Scope）。
//
// expected_downstream_consumers:
// - Story 7.2 meaning-preservation 护栏：消费 lockedItems（硬锁/软锁）做范围偏离检测（L1 廉价信号 + L2 AI 裁判）。
// - Story 7.4 修订流闭环：A 入口（auto_revise findings→intent）直接消费 7.1 core（schema + revision-optimizer
//   + 下发格式零改复用，只换 trigger）。
// - Story 7.5 词级 diff：B1 改稿结果段落级 accept/reject 的 diff UI 升级。
// - Story 7.1 Step 3-5：draft-writer 段落级 directive 消费 + redo 机制扩展（IPC schema 加 optional 字段）。
// - Story 7.4 §1.6 structuralEdit：结构编辑（atomic-edit）触发的 prose 重生成经 revision-guard 时，标
//   structuralEdit=true 让护栏 L2 放行故意结构改动（只查顺手越界改锁定项）。本 flag 由 7.4 环 B（Director
//   atomic-edit 落盘后 prose 重生成）+ 7.4 Step 5 环 A（auto_revise 段落级结构改稿）注入。

/**
 * 锁定项权威分层（child4 §1.4 三层权威）。
 *
 * - **hard**：用户原话明的锁定项（「别动角色性格」= 硬锁角色性格）。来自 `provenance.rawUserInstruction`
 *   的显式锁定语义。护栏（7.2）越界硬锁 → 强制拒绝/标记。
 * - **soft**：优化 Agent 推断的锁定项（「也别动结论」未在用户原话中明说，但 Agent 推断大概率不该动）。
 *   标「LLM 理解，非用户原话」。护栏越界软锁 → 软警告（用户可放行）。
 */
export const LOCK_AUTHORITIES = ['hard', 'soft'] as const;
export type LockAuthority = (typeof LOCK_AUTHORITIES)[number];

/** Zod schema for {@link LockAuthority}. */
export const lockAuthoritySchema = z.enum(LOCK_AUTHORITIES);

/**
 * 锁定项（不改什么）—— 7.2 护栏直接消费。
 *
 * @property field     锁定对象语义描述（自由 string，非封闭枚举——"角色性格"/"结论"/"伏笔状态"/"作者声音" 等，
 *                     范式判据：分类归 LLM，不预设词表门禁）。
 * @property authority 权威分层（hard=用户原话 / soft=Agent 推断）。
 * @property evidence  依据：hard 时填用户原话片段（来自 rawUserInstruction 的相关切片）；
 *                     soft 时填 Agent 推断依据（为什么推断此项该锁）。
 */
export interface LockedItem {
  field: string;
  authority: LockAuthority;
  evidence?: string;
}

/** Zod schema for {@link LockedItem}. */
export const lockedItemSchema = z.object({
  field: z.string().min(1),
  authority: lockAuthoritySchema,
  evidence: z.string().optional(),
});

/**
 * 触发来源（为什么改）。三 trigger 共享 RevisionIntent 的 trigger 区分：
 * - `user-directive`：B 入口（选区指挥精修，用户主动发起）。
 * - `audit-finding`：A 入口（auto_revise findings 触发，7.4 复用）。
 * - `redo-feedback`：C 入口（redo 反馈升级，defer）。
 */
export const REVISION_INTENT_SOURCES = ['user-directive', 'audit-finding', 'redo-feedback'] as const;
export type RevisionIntentSource = (typeof REVISION_INTENT_SOURCES)[number];

/** Zod schema for {@link RevisionIntentSource}. */
export const revisionIntentSourceSchema = z.enum(REVISION_INTENT_SOURCES);

/**
 * 改稿意图结构（child4 §1.3 重法 + design §2.1）。
 *
 * @property change       改什么（用户主目标 + 优化 Agent 细化）。
 * @property lockedItems  不改什么（锁定项，硬锁/软锁权威分层）—— 7.2 护栏直接消费。
 * @property rationale    为什么改（触发来源 + 原因描述）。
 * @property provenance   来源标注（哪些用户硬决定 / 哪些 AI 理解，三层权威 traceable）。
 * @property scope        选区范围（B 触发入口）；缺省 = 整章范围（C/A 入口可能不带选区）。
 */
export interface RevisionIntent {
  /** 改什么：要改的目标（用户主目标 + 优化 Agent 细化）。 */
  change: {
    /** 一句话改稿目标（用户主目标的精炼，硬要求）。 */
    summary: string;
    /** 细化（优化 Agent 推断的子目标，标软）；缺省 = 无细化。 */
    details?: string[];
  };
  /** 不改什么（锁定项）——7.2 护栏直接消费。空数组合法（用户/Agent 未标识锁定项）。 */
  lockedItems: LockedItem[];
  /** 为什么改：触发来源。 */
  rationale: {
    source: RevisionIntentSource;
    /** 触发原因描述（来自 rawUserInstruction 上下文 / audit findings 引用）。 */
    note: string;
  };
  /** 来源标注：哪些用户硬决定、哪些 AI 理解（三层权威 traceable）。 */
  provenance: {
    /** 用户原始指令原文（硬——下发到 draft-writer 时作为用户原话层）。 */
    rawUserInstruction: string;
    /** 优化 Agent 编译说明（标「LLM 理解，非用户原话」——下发到 draft-writer 时作为编译层）。 */
    compilerNote: string;
  };
  /** 选区范围（B 触发入口）——段落级改稿定位；缺省 = 整章范围。 */
  scope?: {
    /** 选区锚点（既有契约 attachment.ts，quote/prefix/suffix/rangeHint）。 */
    anchor: SelectionAnchor;
    /** 章节归属（可选——caller 上下文已有，缺省按 parent context 推）。 */
    chapterId?: string;
  };
  /**
   * Story 7.4 §1.6：本次 prose 重生成是否由结构编辑（Director atomic-edit 落 scene_graph）触发。
   *
   * - `undefined/false`（默认，保守）：正常护栏行为——revision-guard L2 6 类全查 + 作者声音默认 soft 维度全保。
   *   零回归：B-trigger 段落精修 / 无 atomic-edit 的 auto_revise / 首写整章路径均不带此 flag。
   * - `true`：标「结构操作允许范围」——revision-guard L2 对**故意的结构改动**放行（语义倒退/视角丢失等
   *   对结构编辑本身的改动不报），**只查顺手越界改锁定项**（voice/结论/角色性格）。mirror child1 故意 gap
   *   白名单思路（§1.6 structural-edit relaxation）。放行规则归 LLM prompt（revision-guard-agent.yaml
   *   结构性改稿判定段），非纯代码规则匹配（ADR-3）。
   *
   * 注：环 B（整章重写，无 scope.anchor）时 revision-guard 仍走整章 skip 路径（无 before/after 可比），
   * flag 仅作数据通道标记；段落级结构改稿（Step 5 auto_revise，scope.anchor + structuralEdit=true）时
   * L2 真跑放行码。
   */
  structuralEdit?: boolean;
}

/**
 * Zod mirror of {@link RevisionIntent}（revision-optimizer-agent 输出 JSON 校验 + 下游消费 shape 守卫）。
 *
 * strict TS 全栈——parseRevisionIntent 用此 schema safeParse 防御 LLM 输出畸形。
 * lockedItems 空数组合法（用户/Agent 未标识锁定项 = 无硬约束，非阻塞）。details 用 `.min(1)` 拒空 `[]`
 * （interface-contracts.md「optional 数组二态契约」：缺失=无细化 OR ≥1=有细化，空 `[]` 无意义）。
 */
export const revisionIntentSchema = z.object({
  change: z.object({
    summary: z.string().min(1),
    details: z.array(z.string().min(1)).min(1).optional(),
  }),
  lockedItems: z.array(lockedItemSchema),
  rationale: z.object({
    source: revisionIntentSourceSchema,
    note: z.string(),
  }),
  provenance: z.object({
    rawUserInstruction: z.string(),
    compilerNote: z.string(),
  }),
  scope: z
    .object({
      anchor: selectionAnchorSchema,
      chapterId: z.string().optional(),
    })
    .optional(),
  // Story 7.4 §1.6：结构编辑触发标记（详见 RevisionIntent.structuralEdit docstring）。
  structuralEdit: z.boolean().optional(),
});

/**
 * 解析 RevisionIntent JSON 字符串（shape 守卫 + 归一）。
 *
 * **仅做 shape 校验**（schema safeParse），**不做语义裁判**（意图编译归 LLM revision-optimizer）。
 * 落 shared-contracts 供 parseRevisionIntent（agent 包）三路径鲁棒抽取后调本函数做最终 shape 守卫。
 *
 * @param raw 候选对象（已从 JSON 字符串 parse 出；调用方做 robust 抽取）。
 * @returns   合法 RevisionIntent 或 undefined（caller 降级 graceful）。
 */
export function coerceRevisionIntent(raw: unknown): RevisionIntent | undefined {
  const result = revisionIntentSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

// ── parseRevisionIntent（三路径鲁棒解析，mirror parseAdjudication 对象形态）──
//
// 落 shared-contracts（mirror parseAdjudication 同处 chapter-chain-artifacts.ts：shell IPC + agent 两入口
// 都需 parseRevisionIntent，故共享层持有；agent dispatchRevisionOptimizer wrapper + shell IPC dispatch 各自调它）。

/**
 * 解析 revision-optimizer-agent 返回的 RevisionIntent JSON 串。
 *
 * 三路径鲁棒（mirror `parseAdjudication` shared-contracts 三路径，对象形态——对象非数组）：
 * 1. **扫所有 ```json/``` fenced 块**（global regex，multi-fence tolerant）。
 * 2. **brace-match（first `{` to last `}`）**——无 fence 时的 narration-tolerant fallback。
 * 3. **整体试 parse**（最后兜底——无 fence 单对象）。
 *
 * 任一路径提取到合法对象 → coerceRevisionIntent（shape 守卫）→ RevisionIntent；全失败 → 返 null。
 *
 * 🔑 范式判据：parse 只机械提取 + shape 校验（纯代码），「意图编译」归 LLM optimizer（已在 dispatch
 * 阶段完成，parse 不重做语义判断）。
 *
 * @param content revision-optimizer-agent 返的 assistant content（期望是 RevisionIntent JSON 串）。
 * @returns        合法 RevisionIntent 或 null（caller graceful 降级）。
 */
export function parseRevisionIntent(content: string): RevisionIntent | null {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return null;

  // 路径 1：fenced 块（multi-fence tolerant）。
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1];
    if (!inner) continue;
    const parsed = tryExtractRevisionIntent(inner);
    if (parsed) return parsed;
  }

  // 路径 2：brace-match（first { to last }）。
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryExtractRevisionIntent(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }

  // 路径 3：整体试 parse。
  return tryExtractRevisionIntent(trimmed);
}

/** 单候选字符串试 JSON.parse + coerceRevisionIntent（shape 守卫）；失败返 null。 */
function tryExtractRevisionIntent(candidate: string): RevisionIntent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  return coerceRevisionIntent(obj) ?? null;
}
