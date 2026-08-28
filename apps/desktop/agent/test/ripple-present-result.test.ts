import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runLoop } from '../src/agent/loop';
import type { SessionMessage, ToolCall, ToolDefinition } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4 Phase 5.1：涟漪流程收尾 present_result 复用验证（零新建）。
//
// Phase 5.1 验证 3.3 线 D「present_result 收尾契约 + runLoop 停下校验」对涟漪流程生效——
// leader 调 diagnose_impacts 拿 findings 后，plan/discuss 模式停下前必须调 present_result 收尾。
//
// dogfood R2 #16（2026-08-26）：intent_restate 盖章删除（UI 快捷按钮移除后零消费者）。
// 本文件按新语义断言（收尾契约本身保留）：kind 不再产生，携带消息 toBeUndefined。
// 1. plan 模式：调 diagnose_impacts → 调 present_result(awaiting=true) → 停下 → 不打回。
// 2. plan 模式：调 diagnose_impacts → 停下没调 present_result → 打回一次重跑后调 present_result。
// 3. discuss 模式：调 present_result(awaiting=false) → 停下不打回。
// 4. normal 模式：调 diagnose_impacts → 停下没调 present_result → 不打回（normal/auto 不强制）。
// 5. plan 模式：diagnose_impacts → present_result → 再调工具 → 停下不打回（中途调工具不误伤）。
//
// 测试方法：直接调 runLoop + mock diagnose_impacts / present_result 工具 + mock generate 控制轮次。
// 🔑 关键：toolCalls 非空时 loop 继续不进 stop 分支；调 present_result 是 toolCalls 形式 → loop 继续到
// 下一次 generate 才停下。故测「调 present_result 收尾」须有「调 tool + 再 generate 停下」两步。
// ─────────────────────────────────────────────────────────────────────────────

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

describe('Story 3.4 Phase 5.1 — 涟漪流程收尾 present_result 复用（零新建，验证既有对涟漪生效）', () => {
  const diagnoseImpactsTool: ToolDefinition = {
    id: 'diagnose_impacts',
    description: 'ripple diagnosis',
    parameters: z.object({}),
    execute: async () => ({
      title: 'diagnose_impacts',
      output: '涟漪诊断完成：1 stale → 2 findings。',
      metadata: {
        ok: true,
        findings: [
          {
            code: 'stale-derivative',
            severity: 'warning',
            impactType: 'stale-derivative',
            message: '场 s1 派生数据失效',
            targets: [{ kind: 'scene', id: 's1' }],
          },
        ],
        summary: '1 个场需重派生',
        degraded: false,
        staleFields: ['scene_graph'],
      },
    }),
  };

  const presentResultTool: ToolDefinition = {
    id: 'present_result',
    description: 'closure 收尾声明',
    parameters: z.object({
      awaiting_intent_confirmation: z.boolean(),
      summary: z.string().optional(),
    }),
    execute: async (params) => ({
      title: 'present_result',
      output: '已呈现。',
      metadata: {
        presentResult: {
          awaitingIntentConfirmation: (params as { awaiting_intent_confirmation: boolean }).awaiting_intent_confirmation,
        },
      },
    }),
  };

  it('plan 模式：diagnose_impacts → present_result(awaiting=true) → 停下不打回', async () => {
    const collected: SessionMessage[] = [];
    let calls = 0;

    await runLoop({
      sessionId: 's1',
      projectPath: '.',
      messages: [{ id: 'u1', role: 'user', content: '检查改动影响', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [diagnoseImpactsTool, presentResultTool],
      maxSteps: 6,
      generate: async () => {
        calls++;
        if (calls === 1) {
          // 第 1 轮：调 diagnose_impacts。
          return { content: '我来诊断改动影响', toolCalls: [toolCall('c1', 'diagnose_impacts')], finishReason: 'tool_calls' };
        }
        if (calls === 2) {
          // 第 2 轮：调 present_result(awaiting=true)。
          return {
            content: '诊断完成，2 findings。等作者导演如何传播。',
            toolCalls: [toolCall('c2', 'present_result', { awaiting_intent_confirmation: true, summary: '涟漪诊断完成' })],
            finishReason: 'tool_calls',
          };
        }
        // 第 3 轮：停下（无 toolCalls）。调过 present_result → 不打回。
        return { content: '等你决定。', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
      behaviorMode: 'plan',
    });

    // 3 轮 generate（diagnose + present_result + 停下），无打回重跑。
    expect(calls).toBe(3);

    // R2 #16：盖章删除——携带 present_result 调用的消息与停止消息均无 kind。
    const assistantMsgs = collected.filter((m) => m.role === 'assistant');
    const carrying = assistantMsgs.find((m) => m.toolCalls?.some((c) => c.name === 'present_result'));
    expect(carrying?.kind).toBeUndefined();
    expect(assistantMsgs[assistantMsgs.length - 1].kind).toBeUndefined();
  });

  it('plan 模式：diagnose_impacts → 停下没调 present_result → 打回一次重跑后调 present_result', async () => {
    const collected: SessionMessage[] = [];
    let calls = 0;

    await runLoop({
      sessionId: 's2',
      projectPath: '.',
      messages: [{ id: 'u1', role: 'user', content: '检查改动影响', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [diagnoseImpactsTool, presentResultTool],
      maxSteps: 6,
      generate: async () => {
        calls++;
        if (calls === 1) {
          // 第 1 轮：调 diagnose_impacts。
          return { content: '我来诊断', toolCalls: [toolCall('c1', 'diagnose_impacts')], finishReason: 'tool_calls' };
        }
        if (calls === 2) {
          // 第 2 轮：直接停下没调 present_result → 打回（plan 模式 + !calledPresentResult + retry<1 + steps<max）。
          return { content: '诊断完了。', toolCalls: undefined, finishReason: 'stop' };
        }
        if (calls === 3) {
          // 第 3 轮（打回后重跑）：调 present_result 收尾。
          return {
            content: '重呈：诊断完成。',
            toolCalls: [toolCall('c2', 'present_result', { awaiting_intent_confirmation: true })],
            finishReason: 'tool_calls',
          };
        }
        // 第 4 轮：停下（调过 present_result → 不再打回）。
        return { content: '等你决定。', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
      behaviorMode: 'plan',
    });

    // 4 轮 generate（diagnose + 停下被打回 + 重呈 present_result + 停下）。
    expect(calls).toBe(4);

    // R2 #16：盖章删除——重呈的携带消息与停止消息均无 kind。
    const assistantMsgs = collected.filter((m) => m.role === 'assistant');
    const carrying = assistantMsgs.find((m) => m.toolCalls?.some((c) => c.name === 'present_result'));
    expect(carrying?.kind).toBeUndefined();
    expect(assistantMsgs[assistantMsgs.length - 1].kind).toBeUndefined();
  });

  it('discuss 模式：diagnose_impacts → present_result(awaiting=false) → 停下不打回 + kind 无（非 restate）', async () => {
    const collected: SessionMessage[] = [];
    let calls = 0;

    await runLoop({
      sessionId: 's3',
      projectPath: '.',
      messages: [{ id: 'u1', role: 'user', content: '检查改动影响', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [diagnoseImpactsTool, presentResultTool],
      maxSteps: 6,
      generate: async () => {
        calls++;
        if (calls === 1) {
          return { content: '诊断', toolCalls: [toolCall('c1', 'diagnose_impacts')], finishReason: 'tool_calls' };
        }
        if (calls === 2) {
          // present_result(awaiting=false) → 非 restate（回答完毕型）。
          return {
            content: '回答完毕。',
            toolCalls: [toolCall('c2', 'present_result', { awaiting_intent_confirmation: false })],
            finishReason: 'tool_calls',
          };
        }
        return { content: '停。', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
      behaviorMode: 'discuss',
    });

    expect(calls).toBe(3); // 无打回（调过 present_result）。
    // R2 #16：盖章删除——携带消息与停止消息均无 kind。
    const assistantMsgs = collected.filter((m) => m.role === 'assistant');
    const carrying = assistantMsgs.find((m) => m.toolCalls?.some((c) => c.name === 'present_result'));
    expect(carrying?.kind).toBeUndefined();
    expect(assistantMsgs[assistantMsgs.length - 1].kind).toBeUndefined();
  });

  it('normal 模式：diagnose_impacts → 停下没调 present_result → 不打回（normal/auto 不强制）', async () => {
    const collected: SessionMessage[] = [];
    let calls = 0;

    await runLoop({
      sessionId: 's4',
      projectPath: '.',
      messages: [{ id: 'u1', role: 'user', content: '检查改动影响', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [diagnoseImpactsTool, presentResultTool],
      maxSteps: 5,
      generate: async () => {
        calls++;
        if (calls === 1) {
          return { content: '诊断', toolCalls: [toolCall('c1', 'diagnose_impacts')], finishReason: 'tool_calls' };
        }
        // 第 2 轮：直接停下没调 present_result。normal 模式不强制 → 不打回。
        return { content: '诊断完了。', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
      behaviorMode: 'normal',
    });

    // 2 轮 generate（normal 模式不打回，停下直接结束）。
    expect(calls).toBe(2);
    // 无 present_result 调用 → 全部 assistant 消息无 kind。
    const assistantMsgs = collected.filter((m) => m.role === 'assistant');
    for (const m of assistantMsgs) {
      expect(m.kind).toBeUndefined();
    }
  });

  it('plan 模式：diagnose_impacts → present_result(awaiting=true) → 再调工具 → 停下不打回（中途调工具不误伤）', async () => {
    // 验证「判断只在停下时做」约束——present_result 后继续调工具不触发打回（toolCalls 非空不进 stop 分支）。
    const collected: SessionMessage[] = [];
    let calls = 0;

    await runLoop({
      sessionId: 's5',
      projectPath: '.',
      messages: [{ id: 'u1', role: 'user', content: '检查并修复', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [diagnoseImpactsTool, presentResultTool],
      maxSteps: 7,
      generate: async () => {
        calls++;
        if (calls === 1) {
          return { content: '先诊断', toolCalls: [toolCall('c1', 'diagnose_impacts')], finishReason: 'tool_calls' };
        }
        if (calls === 2) {
          // 中途调 present_result（还会继续调工具，非停下）。
          return {
            content: '中期汇报',
            toolCalls: [toolCall('c2', 'present_result', { awaiting_intent_confirmation: true })],
            finishReason: 'tool_calls',
          };
        }
        if (calls === 3) {
          // 继续调工具（再次诊断）。present_result 已调过，loop 继续不进 stop 分支。
          return { content: '再诊断', toolCalls: [toolCall('c3', 'diagnose_impacts')], finishReason: 'tool_calls' };
        }
        // 第 4 轮：停下（调过 present_result → 不再打回）。
        return { content: '完成', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
      behaviorMode: 'plan',
    });

    // 4 轮 generate（诊断 + 中期 present_result + 再诊断 + 停下）。中途 toolCalls 不触发打回。
    expect(calls).toBe(4);
    // R2 #16：盖章删除——中期携带 present_result 的消息与停止消息均无 kind。
    const assistantMsgs = collected.filter((m) => m.role === 'assistant');
    const carrying = assistantMsgs.find((m) => m.toolCalls?.some((c) => c.name === 'present_result'));
    expect(carrying?.kind).toBeUndefined();
    expect(assistantMsgs[assistantMsgs.length - 1].kind).toBeUndefined();
  });
});
