import {
  parseAmendmentDecision,
  type AmendmentDecision,
  type AmendmentRequest,
  type WriteWorldStateRequest,
} from '@orison/shared-contracts';
import type { SkillExecutorRef } from '../types';
import { registry } from '../tool/registry';
import { logger } from '../logger';

// ── Story 6.6 Phase C3：状态修补 Agent 调度入口（design §3 / ADR-3 语义裁判归 LLM）──
//
// amendWorldState = leader 侧调度函数：派发 world-amender-agent 子 agent（allowedTools=[] 纯判断，mirror 4.6
// adjudicator / orchestration-pattern.md）→ parse AmendmentDecision → accept 时调 amend_world_state builtin
// 落表（source='amendment' 由 handler 强制注入）。
//
// 范式判据（ADR-3）：「修补是否该执行」= 语义判断归 LLM（world-amender-agent 读正文 + 当前 reduce 裁判）；
// amendWorldState 本身 = 纯代码机械（dispatch + parse + 条件落表），不做语义裁判。
//
// leader 不直接 write/editPatches——向修补 Agent 发 AmendmentRequest（design §3 / Q1 resolved）。Agent 读正文
// 裁判：修补与正文一致 → accept（产 amendmentPatches source='amendment'）；矛盾 → reject（prose 仍是裁判
// 权威/真相源，ADR-1/ADR-14）。accept 时 amendmentPatches 覆盖层 reduce 叠加在 derived 之上；重跑提取时清零。
//
// 调度模式（mirror dispatchAdjudicator write-chapter.ts:209 + closureChainIpc.ts:128）：
// - runAgentWithExplicitSystem(parentSessionId, 'world-amender-agent', vars, {allowedTools:[]})——无工具纯判断，
//   判「修补是否与正文一致」基于 proseText + currentState + amendmentRequest 已够（查矛盾归 Reader-Audit，
//   已在链段跑过）；无写工具（amendment 落表由本函数机械调 builtin，非子 agent 直接写）。
// - spawn depth：leader→修补 Agent（depth+1）兄弟于 leader→chain（depth+1），非嵌套（同 4.5/4.6）。
//
// graceful 降级（mirror adjudicator D5）：修补 Agent 是增强非硬约束——任何失败（dispatch 抛错 / parse 失败 /
// 方法缺失 / 超时）→ 返 {decision: null, persisted: false}，**不假 accept**（prose 为裁判权威故降级安全，
// 不改状态 = 不引入错误 amendment）。caller 据此告知 leader。
//
// ⚠️ leader 触发点先留 hook（dogfood 推迟真实触发，照 project-dogfood-deferred-after-core-features）：
// 本函数是调度入口基建，leader 工具触发接通（如 leader 发现状态问题调本函数）留后续。当前不挂任何 leader
// tool——仅函数 + 测试，证明调度+落表闭环范式正确。

/** 修补锚点 slice（amendment patches 附着的 storyTime 切面，caller 提供——通常是被修补状态所属 slice）。 */
export interface AmendmentSlice {
  id: string;
  storyTime: number;
  title: string;
}

/** amendWorldState 调度上下文（mirror ToolContext 子集——sessionId/projectPath/abort/spawnDepth/skillExecutor）。 */
export interface AmendWorldStateContext {
  sessionId: string;
  projectPath: string;
  abort?: AbortSignal;
  spawnDepth?: number;
  /** skillExecutor.runAgentWithExplicitSystem——缺失（旧 runtime / mock）→ graceful 返 null decision。 */
  skillExecutor?: Pick<SkillExecutorRef, 'runAgentWithExplicitSystem'>;
}

/** amendWorldState 返回（caller 据此告知 leader / 决定下一步）。 */
export interface AmendWorldStateResult {
  /** 修补裁决（accept/reject + reason + amendmentPatches）；null = dispatch/parse 失败（graceful，不假 accept）。 */
  decision: AmendmentDecision | null;
  /** amendment 是否真落表（accept + amendmentPatches 非空 + builtin 调用成功）。 */
  persisted: boolean;
  /** 落表失败错误（builtin 抛错时记；decision 已 accept 但 persist 失败，caller 据此告知 leader）。 */
  persistError?: string;
}

/**
 * 派发状态修补 Agent + 条件落表 amendment 覆盖层（design §3 / ADR-3）。
 *
 * 流程：
 *  1. skillExecutor 缺 → graceful 返 {decision:null, persisted:false}（不假 accept）。
 *  2. 派发 world-amender-agent（vars：amendmentRequest/currentState/proseText；allowedTools=[] 纯判断）。
 *  3. parseAmendmentDecision（robust 三路径；失败返 null）。
 *  4. decision=null → graceful 返 {decision:null, persisted:false}。
 *  5. decision='reject' → 返 {decision, persisted:false}（不改状态，prose 为裁判权威）。
 *  6. decision='accept' + amendmentPatches 非空 → 调 amend_world_state builtin 落表（source='amendment' 由 handler
 *     强制注入）；builtin 未注册（测试环境）→ warn + skip（persisted:false）。accept 但 amendmentPatches 空 →
 *     persisted:false（无 patch 可写，不调 builtin）。
 *
 * @param ctx       调度上下文（sessionId/skillExecutor/abort/spawnDepth/projectPath）。
 * @param request   修补请求（subjectId + problemDescription + currentState）。
 * @param proseText 章节正文（裁判权威——修补 Agent 据此判修补是否一致）。
 * @param slice     修补锚点切面（amendment patches 附着的 storyTime；caller 提供，如被修补状态所属 slice）。
 * @returns         { decision, persisted, persistError? }——caller 据此告知 leader。
 */
export async function amendWorldState(
  ctx: AmendWorldStateContext,
  request: AmendmentRequest,
  proseText: string,
  slice: AmendmentSlice,
): Promise<AmendWorldStateResult> {
  // skillExecutor 缺（旧 runtime / mock）→ graceful 返 null decision（不假 accept）。
  if (!ctx.skillExecutor?.runAgentWithExplicitSystem) {
    logger.warn(
      { subjectId: request.subjectId },
      'amendWorldState: runAgentWithExplicitSystem unavailable → graceful skip (no silent accept)',
    );
    return { decision: null, persisted: false };
  }

  const vars: Record<string, string> = {
    amendmentRequest: JSON.stringify(request),
    currentState: JSON.stringify(request.currentState ?? {}),
    proseText,
  };

  // 派发 world-amender-agent（allowedTools=[] 纯判断，无工具调用）。
  let content: string;
  try {
    const result = await ctx.skillExecutor.runAgentWithExplicitSystem(
      ctx.sessionId,
      'world-amender-agent',
      vars,
      {
        ...(ctx.abort ? { abort: ctx.abort } : {}),
        ...(ctx.spawnDepth !== undefined ? { spawnDepth: ctx.spawnDepth } : {}),
        allowedTools: [],
      },
    );
    content = result.content;
  } catch (err) {
    // dispatch 抛错（agent 失败 / 超时 / abort）→ graceful 返 null decision（D5，不假 accept）。
    logger.warn(
      { subjectId: request.subjectId, err: err instanceof Error ? err.message : String(err) },
      'amendWorldState: world-amender-agent dispatch failed → graceful skip (no silent accept)',
    );
    return { decision: null, persisted: false };
  }

  const decision = parseAmendmentDecision(content);
  if (!decision) {
    // parse 失败（无合法 JSON / shape 不符）→ graceful 返 null decision（**不假 accept**，prose 为裁判权威安全）。
    logger.warn(
      { subjectId: request.subjectId },
      'amendWorldState: parseAmendmentDecision failed → graceful skip (no silent accept)',
    );
    return { decision: null, persisted: false };
  }

  // reject：不改状态（prose 为裁判权威），返 decision 供 caller 告知 leader。
  if (decision.decision === 'reject' || decision.amendmentPatches.length === 0) {
    return { decision, persisted: false };
  }

  // accept + amendmentPatches 非空 → 调 amend_world_state builtin 落表。
  // builtin 未注册（测试环境 registry 空 / 未 registerBuiltinTools）→ warn + skip（persisted:false，非崩）。
  // 生产路径 registerBuiltinTools 已注册 amend_world_state（builtin.ts）。
  const tool = registry.get('amend_world_state');
  if (!tool) {
    logger.warn(
      { subjectId: request.subjectId, sliceId: slice.id },
      'amendWorldState: amend_world_state tool not registered → skip persist (decision accepted but not persisted)',
    );
    return { decision, persisted: false };
  }

  const writeReq: WriteWorldStateRequest = {
    slice: { id: slice.id, storyTime: slice.storyTime, title: slice.title },
    patches: decision.amendmentPatches,
    subjects: [],
  };
  try {
    await tool.execute(writeReq, {
      projectPath: ctx.projectPath,
      sessionId: ctx.sessionId,
      abort: ctx.abort ?? new AbortController().signal,
    });
    logger.info(
      { subjectId: request.subjectId, sliceId: slice.id, patchCount: decision.amendmentPatches.length },
      'amendWorldState: amendment persisted (source=amendment forced by handler)',
    );
    return { decision, persisted: true };
  } catch (err) {
    // builtin 抛错（DB 连接 / handler 校验失败）→ 非崩，记 persistError 返 caller（decision 已 accept 但未落表）。
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { subjectId: request.subjectId, sliceId: slice.id, err: msg },
      'amendWorldState: amend_world_state persist failed (decision accepted but not persisted)',
    );
    return { decision, persisted: false, persistError: msg };
  }
}
