import {
  parseRevisionIntent,
  type RevisionIntent,
} from '@orison/shared-contracts';
import type { SkillExecutorRef, ToolContext } from '../types';
import { logger } from '../logger';

// ── Story 7.1：revision-optimizer 子 agent —— 改稿意图编译器（design §1[2] / §2.2 / ADR-3）──
//
// revision-optimizer-agent = leader 侧 yaml 子 agent（mirror 4.6 裁决器 / 4.5 retrieval / 6.3 Director）：
// 把作者的粗指令 + 上下文编译成结构化 RevisionIntent（改什么 / 不改什么[硬锁/软锁] / 为什么 / 来源标注）。
// 经用户确认关后下发到 draft-writer 做段落级改稿（B1 e2e，Step 3-5 wire）。
//
// 🔑 范式判据（ADR-3 / creative-vs-mechanical）：意图编译 / 锁定项推断 / 改什么细化归 LLM
// （revision-optimizer yaml prompt）；parse / dispatch / 派发 wiring / 选区锚点捕获归纯代码（本文件）。
//
// 🔑 不进 CONTRACTS[]（leader 侧子 agent，mirror retrieval 4.5 / 裁决器 4.6 / Director 6.3 /
// promise-emergence 6.5 / world-amender 6.6，spec §130 反模式）。spawn depth：leader→revision-optimizer
// （depth+1）兄弟于 leader→chain（depth+1），非嵌套（同 4.5/4.6）。
//
// 工具限制（硬约束，spec §136-141 caller 责任）：allowedTools=['query_story']——带只读查询帮判锁定项
// 背景（查设定/角色/关系/伏笔，mirror retrieval 4.5；收窄到 query_story 拿不到 write_file/git_commit
// 等危险工具）。runLoop + maxSteps 30（非单次 generate——revision-optimizer 可多次 query_story 切不同
// 召回面，mirror retrieval 4.5；异于裁决器无工具单判断）。
//
// graceful 降级（mirror 裁决器 D5 / retrieval D4）：revision-optimizer 是增强非硬约束——任何失败
// （skillExecutor 缺 / dispatch 抛错 / parse 失败 / 超时）→ 返 null，**不假信心**（绝不编造 RevisionIntent
// 填给 draft-writer，那会违保义初衷——错误意图比无意图更害改稿）。caller（write_chapter）据此告知
// leader「意图编译失败，请重述或手改」。
//
// parseRevisionIntent 落 shared-contracts（mirror parseAdjudication 同层——shell IPC + agent 两入口共享，
// DRY 单源）；本文件的 dispatchRevisionOptimizer wrapper 是 **Story 7.4 A-trigger 预建**（leader write_chapter
// tool 在 readiness gate 后调本函数——7.1 B-trigger 走 IPC dispatchRevisionOptimizerForIpc，7.4 A-trigger
// auto_revise findings→intent 走本 wrapper，core 零改复用）。7.1 生产路径不调本 wrapper（非 dead——7.4 消费），
// 保留 + 测试覆盖避 7.4 重写。
//
// expected_downstream_consumers:
// - Story 7.4：A 入口（auto_revise findings→intent）leader write_chapter tool 复用本 wrapper（core 零改，只换 trigger）。
// - Story 7.1 B-trigger：走 IPC dispatchRevisionOptimizerForIpc（closureChainIpc.ts），非本 wrapper。

// ── dispatchRevisionOptimizer（mirror dispatchAdjudicator write-chapter.ts / amendWorldState nodes/world-amender.ts）──

/** revision-optimizer 派发入参（选段 + 粗指令 + 上下文）。 */
export interface RevisionOptimizerInput {
  /** 作者选中的正文段（改稿范围，渲染 `{{selectedPassage}}`）。 */
  selectedPassage: string;
  /** 作者粗指令原文（硬权威来源，渲染 `{{userInstruction}}`，也作 provenance.rawUserInstruction 的 ground truth）。 */
  userInstruction: string;
  /** 本章创作意图（brief LLM 段 JSON，渲染 `{{chapterContext}}`，帮 optimizer 判锁定项背景）。 */
  chapterContext: string;
  /** Reader-Audit 审核发现 JSON（A trigger 入口时非空；B trigger 通常空串，yaml 模板空串填空段）。 */
  auditFindings?: string;
}

/** dispatchRevisionOptimizer 上下文（mirror ToolContext 子集——sessionId/abort/spawnDepth/skillExecutor）。 */
export interface RevisionOptimizerContext {
  sessionId: string;
  abort?: AbortSignal;
  spawnDepth?: number;
  /** R2 #3 二段：leader 工具 ctx 的 child 事件通道（可选——直调/测试不带则不透传）。 */
  emitChildEvent?: ToolContext['emitChildEvent'];
  /** skillExecutor.runAgentWithExplicitSystem——缺失（旧 runtime / mock）→ graceful 返 null。 */
  skillExecutor?: Pick<SkillExecutorRef, 'runAgentWithExplicitSystem'>;
}

/**
 * 派发 revision-optimizer 子 agent + parse RevisionIntent（design §1[2] / §2.2）。
 *
 * 流程：
 *  1. skillExecutor 缺 → graceful 返 null（不假信心）。
 *  2. 派发 revision-optimizer-agent（vars：selectedPassage/userInstruction/chapterContext/auditFindings；
 *     allowedTools=['query_story']——带只读查询帮判锁定项背景，无写工具）。
 *  3. parseRevisionIntent（三路径鲁棒；失败返 null）。
 *  4. parse 成功 → 返 RevisionIntent（caller 呈用户确认关）。
 *  5. 任何失败（dispatch 抛错 / parse 失败）→ 返 null（caller 告知 leader「意图编译失败，请重述或手改」）。
 *
 * 🔑 graceful 不假信心（mirror 裁决器 D5）：绝不编造 RevisionIntent 填给 draft-writer——错误意图比无
 * 意图更害改稿（违保义初衷）。失败时 caller 告知 leader，让用户重述或手改指令（人导演关）。
 *
 * @param ctx   派发上下文（sessionId/skillExecutor/abort/spawnDepth）。
 * @param input 入参（selectedPassage/userInstruction/chapterContext/auditFindings）。
 * @returns      合法 RevisionIntent 或 null（caller graceful 降级 + 告知 leader）。
 */
export async function dispatchRevisionOptimizer(
  ctx: RevisionOptimizerContext,
  input: RevisionOptimizerInput,
): Promise<RevisionIntent | null> {
  // skillExecutor 缺（旧 runtime / mock）→ graceful 返 null（不假信心）。
  if (!ctx.skillExecutor?.runAgentWithExplicitSystem) {
    logger.warn(
      { sessionId: ctx.sessionId },
      'dispatchRevisionOptimizer: runAgentWithExplicitSystem unavailable → graceful skip (no fabricated intent)',
    );
    return null;
  }

  // vars 构建（mirror dispatchAdjudicator vars 抽法）。auditFindings 缺省空串（yaml 模板空串填空段）。
  const vars: Record<string, string> = {
    selectedPassage: input.selectedPassage,
    userInstruction: input.userInstruction,
    chapterContext: input.chapterContext,
    auditFindings: input.auditFindings ?? '',
  };

  // 派发 revision-optimizer-agent（allowedTools=['query_story']——带只读查询帮判锁定项背景）。
  let content: string;
  try {
    const result = await ctx.skillExecutor.runAgentWithExplicitSystem(
      ctx.sessionId,
      'revision-optimizer-agent',
      vars,
      {
        ...(ctx.abort ? { abort: ctx.abort } : {}),
        ...(ctx.spawnDepth !== undefined ? { spawnDepth: ctx.spawnDepth } : {}),
        ...(ctx.emitChildEvent ? { emitChildEvent: ctx.emitChildEvent } : {}), // R2 #3 二段：child 事件透传
        allowedTools: ['query_story'],
      },
    );
    content = result.content;
  } catch (err) {
    // dispatch 抛错（agent 失败 / 超时 / abort）→ graceful 返 null（不假信心）。
    logger.warn(
      {
        sessionId: ctx.sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'dispatchRevisionOptimizer: revision-optimizer-agent dispatch failed → graceful skip (no fabricated intent)',
    );
    return null;
  }

  const intent = parseRevisionIntent(content);
  if (!intent) {
    // parse 失败（无合法 JSON / shape 不符）→ graceful 返 null（**不假信心**——错误意图比无意图更害改稿）。
    logger.warn(
      { sessionId: ctx.sessionId },
      'dispatchRevisionOptimizer: parseRevisionIntent failed → graceful skip (no fabricated intent)',
    );
    return null;
  }

  return intent;
}
