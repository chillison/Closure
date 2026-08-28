import { z } from 'zod';

// ── Story 8.7 写手出场申报契约（design §2.1，R1 主通道 + R5 章梗概）──
//
// 写手写完一章后，在同一对话循环内顺手交的结构化人物表申报：本章谁登场、谁被提及、
// 新称呼归属谁、外加一段话梗概。这是写手对自己刚写正文的自报——生成者对自己产物的申报
// （LLM 语义），不是检测；漏报由纯代码对拍通道兜底（mention 账合并，closure-mention.ts）。
//
// 收束标记：写手输出正文后，申报轮指令要求输出申报 JSON 并以 CAST_DECLARATION_STOP_MARKER
// 结尾（mirror 写手循环既有 `<DRAFT_READY>` 收束形态）——parse 层据标记截取申报段。
//
// parse 失败 graceful（增强层非必需层）：两试失败 → 无申报，落保守账（纯代码通道），正文交付
// 不受阻——mirror 简报降级哲学。产物 artifact key = `cast_declaration`（链段内流转）。
//
// expected_downstream_consumers:
// - Story 8.7 S7（agent writer-node）：阶段 2.5 申报轮（指令 + 收束标记 + parse 两试）。
// - Story 8.7 S8（mention-ledger-node）：名字解析（申报名字→卡）+ 合并取最高态 + synopsis 递入章摘要。
// - Story 8.7 S8b：别名回填建议（present[].card / mentioned[].belongsTo 中不在卡 aliases 的称呼）。

/** 申报段收束标记：申报 JSON 输出完毕后跟此标记（parse 层据此截取，mirror `<DRAFT_READY>` 形态）。 */
export const CAST_DECLARATION_STOP_MARKER = '<CAST_DECLARATION_READY>';

/** 登场条目：本章正式出场的人/实体。`card` = 归属卡名或 id（名字是既有卡的常见别名/绰号时填，供解析归属）。 */
export const castPresentEntrySchema = z.object({
  /** 正文里使用的名字（可用称呼/绰号，不必是卡名）。 */
  name: z.string().min(1),
  /** 该名字归属哪张实体卡（卡名或 id）；正文用了新绰号时必填（否则进新面孔池走议题链）。 */
  card: z.string().min(1).optional(),
});
export type CastPresentEntry = z.infer<typeof castPresentEntrySchema>;

/** 被提及条目：本章只在对话/叙述里被提到（本人没露面）。 */
export const castMentionedEntrySchema = z.object({
  /** 被提到的名字。 */
  name: z.string().min(1),
  /** 新称呼的归属（如「三师叔」→李玄）；既有卡名可不填。 */
  belongsTo: z.string().min(1).optional(),
});
export type CastMentionedEntry = z.infer<typeof castMentionedEntrySchema>;

/**
 * 写手申报产物（写完一章后同对话交的人物表 + 梗概，design §2.1）。
 *
 * 两数组可为空（纯环境章/无提及章合法）；`synopsis` 必填非空——申报轮指令要求一段话梗概，
 * 空梗概视作申报不完整（schema 拒收 → 两试后 graceful 降级保守账，不阻塞正文）。
 */
export const castDeclarationSchema = z.object({
  /** 本章一段话梗概（写给刚读完本章的读者听的那种——章目录行/导航消费）。trim + 非空：
   *  空梗概视作申报不完整（schema 拒收 → 两试后 graceful 降级保守账，不阻塞正文）。 */
  synopsis: z.string().trim().min(1),
  /** 本章登场名单。 */
  present: z.array(castPresentEntrySchema),
  /** 本章被提及名单。 */
  mentioned: z.array(castMentionedEntrySchema),
});
export type CastDeclaration = z.infer<typeof castDeclarationSchema>;
