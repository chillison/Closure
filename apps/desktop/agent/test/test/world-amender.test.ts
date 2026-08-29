import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  amendWorldState,
  type AmendWorldStateContext,
} from '../src/nodes/world-amender';
import { registry } from '../src/tool/registry';
import type { AmendmentRequest, WriteWorldStateRequest } from '@orison/shared-contracts';
import type { ToolDefinition } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.6 Phase C3：状态修补 Agent（world-amender）调度入口测试。
//
// 不测真实 LLM（dogfood 推迟，照 project-dogfood-deferred-after-core-features）。
// 测四块（implement.md Phase E 8）：
// 1. accept（amendmentPatches）→ amend_world_state builtin 落表（source='amendment' 由 handler 强制）。
// 2. reject → 不落表（prose 为裁判权威）。
// 3. dispatch / parse 失败 → graceful null（**不假 accept**）。
// 4. skillExecutor 缺 / builtin 未注册 → graceful skip（不崩）。
//
// 测机械（dispatch + parse + 条件落表），不测裁判质量（LLM 归 dogfood）。
// ─────────────────────────────────────────────────────────────────────────────

/** 合成 AmendmentRequest（leader 发现状态问题）。 */
function makeRequest(): AmendmentRequest {
  return {
    subjectId: 'erina',
    problemDescription: '主角 HP 应为 50 而非 100（受伤未提取）',
    currentState: { hp: 100, location: 'subject://altar-01' },
  };
}

/** 合成 accept 裁决 JSON（amender 子 agent 返形态）。 */
const ACCEPT_JSON = JSON.stringify({
  decision: 'accept',
  reason: '正文明确写了「肩膀中剑流血」，HP 应扣 50，提取器漏提',
  amendmentPatches: [
    {
      subjectId: 'erina',
      path: '/hp',
      op: 'replace',
      value: 50,
      axis: 'physical',
      summary: '修正 HP：肩膀中剑',
    },
  ],
});

/** 合成 reject 裁决 JSON。 */
const REJECT_JSON = JSON.stringify({
  decision: 'reject',
  reason: '正文未提及主角受伤，修补与正文矛盾',
  amendmentPatches: [],
});

/** mock amend_world_state builtin tool（验落表调用 + 参数形态）。 */
function makeAmendTool(): ToolDefinition & { execute: ReturnType<typeof vi.fn> } {
  return {
    id: 'amend_world_state',
    description: 'mock',
    // 测试用 passthrough schema（参数校验非本测试关注——execute mock 不依赖校验）。
    parameters: z.unknown(),
    execute: vi.fn(async () => ({ title: 'amend_world_state', output: 'ok' })),
  };
}

describe('amendWorldState — 状态修补 Agent 调度入口（Story 6.6 Phase C3）', () => {
  let amendTool: ReturnType<typeof makeAmendTool>;

  beforeEach(() => {
    amendTool = makeAmendTool();
    registry.register(amendTool);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 构造 ctx（mock skillExecutor.runAgentWithExplicitSystem 返指定 content）。 */
  function makeCtx(content: string): AmendWorldStateContext {
    return {
      sessionId: 'sess-leader',
      projectPath: '/test/project',
      skillExecutor: {
        runAgentWithExplicitSystem: vi.fn(async () => ({ content })),
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. accept → amend_world_state builtin 落表（source='amendment' 由 handler 强制）
  // ════════════════════════════════════════════════════════════════════════════

  it('accept（amendmentPatches 非空）→ 调 amend_world_state 落表 + persisted=true', async () => {
    const ctx = makeCtx(ACCEPT_JSON);
    const result = await amendWorldState(
      ctx,
      makeRequest(),
      '艾莉娜走进祭坛，一把长剑划过她的肩膀，鲜血流出。',
      { id: 'ep1:5', storyTime: 5, title: '城北遭遇战' },
    );

    expect(result.decision).not.toBeNull();
    expect(result.decision?.decision).toBe('accept');
    expect(result.decision?.reason).toContain('肩膀中剑');
    expect(result.decision?.amendmentPatches).toHaveLength(1);
    expect(result.persisted).toBe(true);
    expect(result.persistError).toBeUndefined();

    // amend_world_state builtin 被调一次（accept + amendmentPatches 非空）
    expect(amendTool.execute).toHaveBeenCalledTimes(1);
    const [req, toolCtx] = amendTool.execute.mock.calls[0] as [WriteWorldStateRequest, { projectPath: string; sessionId: string }];
    // slice 透传（修补锚点切面）
    expect(req.slice).toMatchObject({ id: 'ep1:5', storyTime: 5, title: '城北遭遇战' });
    // patches = decision.amendmentPatches（WorldPatchInput 形态，无 source——source='amendment' 由 handler 强制注入）
    expect(req.patches).toHaveLength(1);
    expect(req.patches[0]).toMatchObject({
      subjectId: 'erina',
      path: '/hp',
      op: 'replace',
      value: 50,
      axis: 'physical',
    });
    expect(req.patches[0]).not.toHaveProperty('source'); // source 不带（handler 强制注入）
    // tool ctx 透传 projectPath / sessionId
    expect(toolCtx.projectPath).toBe('/test/project');
    expect(toolCtx.sessionId).toBe('sess-leader');
  });

  it('runAgentWithExplicitSystem 传 allowedTools=[]（无工具纯判断，mirror adjudicator）', async () => {
    const ctx = makeCtx(ACCEPT_JSON);
    await amendWorldState(ctx, makeRequest(), '正文', { id: 's1', storyTime: 1, title: 't' });
    const dispatchCall = (ctx.skillExecutor!.runAgentWithExplicitSystem as ReturnType<typeof vi.fn>).mock.calls[0];
    // [parentSessionId, role, vars, options]
    expect(dispatchCall[0]).toBe('sess-leader');
    expect(dispatchCall[1]).toBe('world-amender-agent');
    expect(dispatchCall[3]).toMatchObject({ allowedTools: [] });
    // vars 含 amendmentRequest / currentState / proseText
    const vars = dispatchCall[2] as Record<string, string>;
    expect(vars.amendmentRequest).toContain('主角 HP 应为 50');
    expect(vars.proseText).toBe('正文');
    expect(vars.currentState).toContain('hp');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. reject → 不落表（prose 为裁判权威）
  // ════════════════════════════════════════════════════════════════════════════

  it('reject（正文矛盾）→ decision 返 reject + 不调 amend_world_state + persisted=false', async () => {
    const ctx = makeCtx(REJECT_JSON);
    const result = await amendWorldState(
      ctx,
      makeRequest(),
      '艾莉娜走进祭坛，毫发无伤。',
      { id: 'ep1:5', storyTime: 5, title: 't' },
    );

    expect(result.decision?.decision).toBe('reject');
    expect(result.decision?.reason).toContain('矛盾');
    expect(result.persisted).toBe(false);
    // reject 不调 amend_world_state（prose 为裁判权威，不改状态）
    expect(amendTool.execute).not.toHaveBeenCalled();
  });

  it('accept 但 amendmentPatches 空数组 → 不调 builtin（无 patch 可写）', async () => {
    const emptyAccept = JSON.stringify({
      decision: 'accept',
      reason: '一致但无需修补',
      amendmentPatches: [],
    });
    const ctx = makeCtx(emptyAccept);
    const result = await amendWorldState(ctx, makeRequest(), '正文', { id: 's1', storyTime: 1, title: 't' });
    expect(result.decision?.decision).toBe('accept');
    expect(result.persisted).toBe(false);
    expect(amendTool.execute).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. dispatch / parse 失败 → graceful null（**不假 accept**）
  // ════════════════════════════════════════════════════════════════════════════

  it('runAgentWithExplicitSystem 抛错 → graceful null decision（不假 accept）', async () => {
    const ctx: AmendWorldStateContext = {
      sessionId: 'sess-leader',
      projectPath: '/test/project',
      skillExecutor: {
        runAgentWithExplicitSystem: vi.fn(async () => {
          throw new Error('agent timeout');
        }),
      },
    };
    const result = await amendWorldState(ctx, makeRequest(), '正文', { id: 's1', storyTime: 1, title: 't' });
    expect(result.decision).toBeNull();
    expect(result.persisted).toBe(false);
    expect(amendTool.execute).not.toHaveBeenCalled();
  });

  it('amender 返非 JSON / 非法 shape → parseAmendmentDecision null → graceful 不落表', async () => {
    const ctx = makeCtx('totally not json at all');
    const result = await amendWorldState(ctx, makeRequest(), '正文', { id: 's1', storyTime: 1, title: 't' });
    expect(result.decision).toBeNull();
    expect(result.persisted).toBe(false);
    expect(amendTool.execute).not.toHaveBeenCalled();
  });

  it('amender 返缺 decision → parse 失败 → graceful null', async () => {
    const ctx = makeCtx(JSON.stringify({ reason: '无 decision 字段' }));
    const result = await amendWorldState(ctx, makeRequest(), '正文', { id: 's1', storyTime: 1, title: 't' });
    expect(result.decision).toBeNull();
  });

  it('amender 返 ```json 围栏 → parseAmendmentDecision 剥离后 parse 成功', async () => {
    const fenced = `分析结果：\n\`\`\`json\n${ACCEPT_JSON}\n\`\`\``;
    const ctx = makeCtx(fenced);
    const result = await amendWorldState(ctx, makeRequest(), '正文', { id: 's1', storyTime: 1, title: 't' });
    expect(result.decision?.decision).toBe('accept');
    expect(result.persisted).toBe(true);
  });

  it('amendmentPatches 含坏条目（缺 path）→ safeParse 丢弃保留好条目', async () => {
    const withBad = JSON.stringify({
      decision: 'accept',
      reason: '一致',
      amendmentPatches: [
        { subjectId: 'erina', path: '/hp', op: 'replace', value: 50, axis: 'physical' },
        // 坏条目：缺 path
        { subjectId: 'erina', op: 'replace', value: 1 },
        { subjectId: 'erina', path: '/location', op: 'replace', value: 'subject://x', axis: 'physical' },
      ],
    });
    const ctx = makeCtx(withBad);
    const result = await amendWorldState(ctx, makeRequest(), '正文', { id: 's1', storyTime: 1, title: 't' });
    expect(result.decision?.amendmentPatches).toHaveLength(2); // 坏条目丢，2 个好条目
    expect(result.persisted).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. skillExecutor 缺 / builtin 未注册 → graceful skip（不崩）
  // ════════════════════════════════════════════════════════════════════════════

  it('skillExecutor 缺（旧 runtime / mock）→ graceful null decision（不假 accept）', async () => {
    const ctx: AmendWorldStateContext = {
      sessionId: 'sess',
      projectPath: '/p',
      // 无 skillExecutor
    };
    const result = await amendWorldState(ctx, makeRequest(), '正文', { id: 's1', storyTime: 1, title: 't' });
    expect(result.decision).toBeNull();
    expect(result.persisted).toBe(false);
  });

  it('accept 但 amend_world_state builtin 抛错 → persisted=false + persistError 记（不崩）', async () => {
    amendTool.execute = vi.fn(async () => {
      throw new Error('DB connection refused');
    });
    const ctx = makeCtx(ACCEPT_JSON);
    const result = await amendWorldState(ctx, makeRequest(), '正文', { id: 's1', storyTime: 1, title: 't' });
    expect(result.decision?.decision).toBe('accept'); // decision 已 accept
    expect(result.persisted).toBe(false); // 但落表失败
    expect(result.persistError).toContain('DB connection refused');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// parseAmendmentDecision 单元测试（robust 三路径 + 归一，mirror parseAdjudication 测法）
// ════════════════════════════════════════════════════════════════════════════

describe('parseAmendmentDecision（robust parse，Story 6.6 Phase C3）', () => {
  it('裸 JSON → AmendmentDecision', async () => {
    const { parseAmendmentDecision } = await import('@orison/shared-contracts');
    const d = parseAmendmentDecision(ACCEPT_JSON);
    expect(d?.decision).toBe('accept');
    expect(d?.amendmentPatches).toHaveLength(1);
  });

  it('decision 归一：Accept / ACCEPT / accept 均接受', async () => {
    const { parseAmendmentDecision } = await import('@orison/shared-contracts');
    for (const v of ['Accept', 'ACCEPT', 'accept', ' accept ']) {
      const d = parseAmendmentDecision(JSON.stringify({ decision: v, reason: 'r', amendmentPatches: [] }));
      expect(d?.decision).toBe('accept');
    }
    const rej = parseAmendmentDecision(JSON.stringify({ decision: 'Reject', reason: 'r', amendmentPatches: [] }));
    expect(rej?.decision).toBe('reject');
  });

  it('空串 / 非 JSON / 缺 decision → null', async () => {
    const { parseAmendmentDecision } = await import('@orison/shared-contracts');
    expect(parseAmendmentDecision('')).toBeNull();
    expect(parseAmendmentDecision('not json')).toBeNull();
    expect(parseAmendmentDecision(JSON.stringify({ reason: 'r' }))).toBeNull();
  });
});
