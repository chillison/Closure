import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runLoop, type LoopOptions } from '../src/agent/loop';
import { logger } from '../src/logger';
import type { SessionMessage, StreamDeltaData, ToolDefinition } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 2（design §3.1 / §3.3 / #32B）：runLoop 流式事件与部分落盘。
// 直接调 runLoop + mock generate（第 6 参 onDelta 模拟 provider 流）钉住：
//   1. id 稳定性——delta 事件 messageId == 终帧 assistantMsg id（消除占位→终帧合并漂移）；
//   2. abort / StreamInterruptedError 部分落盘——有累积 → aborted_partial（预分配 id + kind +
//      reasoning，push+onMessage 走落盘管线）；空缓冲照旧丢弃；其他错误不落部分；
//   3. emitDelta 缺省 → generate 第 6 参 undefined（非流式零回归形状）；
//   4. #32B——携带 present_result 调用的 assistant 消息首帧即带 kind（构造点直读 arguments，
//      畸形 arguments 容错）；停止消息不再盖章；盖章与 behaviorMode 无关。
// workflow 装配层（sendEvent/emitChildEvent 转发）另见 workflow-stream-delta.test.ts。
// ─────────────────────────────────────────────────────────────────────────────

function baseOpts(overrides?: Partial<LoopOptions>): LoopOptions {
  return {
    sessionId: 's-delta',
    projectPath: '.',
    messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: Date.now() }],
    systemPrompt: 'sys',
    tools: [],
    maxSteps: 5,
    generate: async () => ({ content: 'ok', finishReason: 'stop' }),
    abort: new AbortController().signal,
    ...overrides,
  };
}

const presentResultTool: ToolDefinition = {
  id: 'present_result',
  description: 'closure 收尾声明',
  parameters: z.object({
    awaiting_intent_confirmation: z.boolean(),
    summary: z.string().optional(),
  }),
  execute: async () => ({ title: 'present_result', output: '已呈现。', metadata: { presentResult: { awaitingIntentConfirmation: true } } }),
};

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): { id: string; name: string; arguments: string } {
  return { id, name, arguments: JSON.stringify(args) };
}

describe('runLoop 流式 delta（dogfood T1 Stage 2 §3.1）', () => {
  it('delta 事件 messageId 与终帧 assistantMsg 同 id；text/reasoning 分道；reasoning 终帧落消息', async () => {
    const deltas: StreamDeltaData[] = [];
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async (_m, _s, _t, _a, _c, onDelta) => {
      onDelta?.({ type: 'reasoning', delta: '思' });
      onDelta?.({ type: 'text', delta: '你好' });
      onDelta?.({ type: 'text', delta: '，世界' });
      return { content: '你好，世界', finishReason: 'stop', reasoning: '思' };
    };

    await runLoop(baseOpts({
      generate,
      emitDelta: (e) => deltas.push(e),
      onMessage: (m) => collected.push(m),
    }));

    expect(deltas.map((d) => [d.channel, d.delta])).toEqual([
      ['reasoning', '思'],
      ['text', '你好'],
      ['text', '，世界'],
    ]);
    // 单次 generate 的全部 delta 共享同一预分配 id。
    expect(new Set(deltas.map((d) => d.messageId)).size).toBe(1);
    const assistant = collected.find((m) => m.role === 'assistant');
    expect(assistant?.id).toBe(deltas[0].messageId);
    expect(assistant?.content).toBe('你好，世界');
    expect(assistant?.reasoning).toBe('思');
  });

  it('emitDelta 缺省 → generate 第 6 参 undefined（非流式调用形状零回归），无 delta 事件', async () => {
    const generate = vi.fn<LoopOptions['generate']>(async () => ({ content: 'ok', finishReason: 'stop' }));

    await runLoop(baseOpts({ generate }));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][5]).toBeUndefined();
  });
});

describe('runLoop abort / StreamInterruptedError 部分落盘（dogfood T1 §3.3）', () => {
  it('generate 中途 abort 且已流出 delta → aborted_partial 落盘（预分配 id + 累积 content + reasoning）', async () => {
    const controller = new AbortController();
    const deltas: StreamDeltaData[] = [];
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async (_m, _s, _t, _a, _c, onDelta) => {
      onDelta?.({ type: 'reasoning', delta: '推' });
      onDelta?.({ type: 'text', delta: '写了一半' });
      const err = new DOMException('Aborted', 'AbortError');
      controller.abort(err);
      throw err;
    };

    await expect(runLoop(baseOpts({
      generate,
      abort: controller.signal,
      emitDelta: (e) => deltas.push(e),
      onMessage: (m) => collected.push(m),
    }))).rejects.toMatchObject({ name: 'AbortError' });

    const assistantMsgs = collected.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    const partial = assistantMsgs[0];
    expect(partial.kind).toBe('aborted_partial');
    expect(partial.content).toBe('写了一半');
    expect(partial.reasoning).toBe('推');
    expect(partial.id).toBe(deltas[0].messageId); // 预分配 id——delta 与落盘部分同 id
  });

  it('late abort（generate 已 resolve、无 toolCalls）且已流出 → aborted_partial 落盘后抛 AbortError', async () => {
    const controller = new AbortController();
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async (_m, _s, _t, _a, _c, onDelta) => {
      onDelta?.({ type: 'text', delta: '半途文本' });
      controller.abort(new DOMException('Aborted', 'AbortError'));
      return { content: '半途文本', finishReason: 'stop' };
    };

    await expect(runLoop(baseOpts({
      generate,
      abort: controller.signal,
      emitDelta: () => {},
      onMessage: (m) => collected.push(m),
    }))).rejects.toMatchObject({ name: 'AbortError' });

    const partial = collected.find((m) => m.role === 'assistant');
    expect(partial?.kind).toBe('aborted_partial');
    expect(partial?.content).toBe('半途文本');
  });

  it('abort 时零累积（无 delta）→ 照旧丢弃，不产 assistant 消息', async () => {
    const controller = new AbortController();
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async () => {
      const err = new DOMException('Aborted', 'AbortError');
      controller.abort(err);
      throw err;
    };

    await expect(runLoop(baseOpts({
      generate,
      abort: controller.signal,
      emitDelta: () => {},
      onMessage: (m) => collected.push(m),
    }))).rejects.toMatchObject({ name: 'AbortError' });

    expect(collected.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('StreamInterruptedError（协议层携带累积）→ aborted_partial 取错误载荷并原样上抛', async () => {
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async (_m, _s, _t, _a, _c, onDelta) => {
      onDelta?.({ type: 'text', delta: '流到一半' });
      const err = new Error('stream died mid-flight') as Error & {
        accumulatedText: string;
        accumulatedReasoning?: string;
      };
      err.name = 'StreamInterruptedError';
      err.accumulatedText = '流到一半';
      err.accumulatedReasoning = '中断前的思考';
      throw err;
    };

    await expect(runLoop(baseOpts({
      generate,
      emitDelta: () => {},
      onMessage: (m) => collected.push(m),
    }))).rejects.toThrow('stream died mid-flight');

    const partial = collected.find((m) => m.role === 'assistant');
    expect(partial?.kind).toBe('aborted_partial');
    expect(partial?.content).toBe('流到一半');
    expect(partial?.reasoning).toBe('中断前的思考');
  });

  it('StreamInterruptedError 零累积 → 不落部分消息（空缓冲照旧丢弃）', async () => {
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async () => {
      const err = new Error('stream died before first token') as Error & { accumulatedText: string };
      err.name = 'StreamInterruptedError';
      err.accumulatedText = '';
      throw err;
    };

    await expect(runLoop(baseOpts({
      generate,
      emitDelta: () => {},
      onMessage: (m) => collected.push(m),
    }))).rejects.toThrow('stream died before first token');

    expect(collected.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('普通错误（非 abort 非 StreamInterrupted）不落部分消息（error 语义不变）', async () => {
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async (_m, _s, _t, _a, _c, onDelta) => {
      onDelta?.({ type: 'text', delta: '有累积也不落' });
      throw new Error('boom');
    };

    await expect(runLoop(baseOpts({
      generate,
      emitDelta: () => {},
      onMessage: (m) => collected.push(m),
    }))).rejects.toThrow('boom');

    expect(collected.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  // ── BMad CR-T1-015：纯思考中断（text 空但 reasoning 已流）不再整体丢弃 ──

  it('CR-T1-015：abort 落在纯思考阶段（text 零累积、reasoning 已流）→ aborted_partial 仍落盘（content 空占位、reasoning 保留）', async () => {
    const controller = new AbortController();
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async (_m, _s, _t, _a, _c, onDelta) => {
      // 深度思考模型常见形态：先流长 reasoning，正文首 token 前被用户打断。
      onDelta?.({ type: 'reasoning', delta: '用户已经看到的思考' });
      const err = new DOMException('Aborted', 'AbortError');
      controller.abort(err);
      throw err;
    };

    await expect(runLoop(baseOpts({
      generate,
      abort: controller.signal,
      emitDelta: () => {},
      onMessage: (m) => collected.push(m),
    }))).rejects.toMatchObject({ name: 'AbortError' });

    const partial = collected.find((m) => m.role === 'assistant');
    expect(partial?.kind).toBe('aborted_partial');
    expect(partial?.content).toBe(''); // text 空——content 空串占位
    expect(partial?.reasoning).toBe('用户已经看到的思考'); // 已见思考不丢（修前：整体丢弃）
  });

  // ── BMad CR-T1-019：部分落盘管线自身抛错只记日志，不顶替原错误上抛 ──

  it('CR-T1-019：onMessage 落盘管线抛错 → error 日志 + 原 abort 错误照常上抛（不被 disk 错误顶替）', async () => {
    const controller = new AbortController();
    const generate: LoopOptions['generate'] = async (_m, _s, _t, _a, _c, onDelta) => {
      onDelta?.({ type: 'text', delta: '半途' });
      const err = new DOMException('Aborted', 'AbortError');
      controller.abort(err);
      throw err;
    };
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    await expect(runLoop(baseOpts({
      generate,
      abort: controller.signal,
      emitDelta: () => {},
      onMessage: () => {
        throw new Error('disk full'); // 落盘管线（addMessage → appendFileSync）抛错
      },
    }))).rejects.toMatchObject({ name: 'AbortError' }); // 原错误不被 'disk full' 顶替

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('runLoop present_result 收尾契约（dogfood R2 #16：intent_restate 盖章已删）', () => {
  it('携带 present_result(awaiting=true) 调用的 assistant 消息照常落盘，不再盖章（R2 #16）', async () => {
    const collected: SessionMessage[] = [];
    let calls = 0;
    const generate: LoopOptions['generate'] = async () => {
      calls++;
      if (calls === 1) {
        return {
          content: '诊断完成，等你决定。',
          toolCalls: [toolCall('c1', 'present_result', { awaiting_intent_confirmation: true })],
          finishReason: 'tool_calls',
        };
      }
      return { content: '等你决定。', finishReason: 'stop' };
    };

    await runLoop(baseOpts({
      tools: [presentResultTool],
      generate,
      onMessage: (m) => collected.push(m),
      behaviorMode: 'plan',
    }));

    const assistantMsgs = collected.filter((m) => m.role === 'assistant');
    // 携带调用的消息照常落盘（终局调用：调完即停，无第二条）。
    expect(assistantMsgs[0].toolCalls?.[0].name).toBe('present_result');
    // R2 #16：快捷按钮删除 → 盖章退役，所有消息 kind 均不产生。
    expect(assistantMsgs[0].kind).toBeUndefined();
  });

  it('awaiting=false → 携带消息不盖 kind（回答完毕型非 restate）', async () => {
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async () => ({
      content: '回答完毕。',
      toolCalls: [toolCall('c1', 'present_result', { awaiting_intent_confirmation: false })],
      finishReason: 'tool_calls',
    });

    await runLoop(baseOpts({
      tools: [presentResultTool],
      generate,
      maxSteps: 1,
      onMessage: (m) => collected.push(m),
      behaviorMode: 'discuss',
    }));

    const assistant = collected.find((m) => m.role === 'assistant');
    expect(assistant?.kind).toBeUndefined();
  });

  it('畸形 arguments（DashScope/Qwen 形态）→ 容错 parse 不炸，消息照常落盘', async () => {
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async () => ({
      content: '收尾。',
      toolCalls: [{ id: 'c1', name: 'present_result', arguments: '{}{"awaiting_intent_confirmation":true}' }],
      finishReason: 'tool_calls',
    });

    await runLoop(baseOpts({
      tools: [presentResultTool],
      generate,
      maxSteps: 1,
      onMessage: (m) => collected.push(m),
      behaviorMode: 'plan',
    }));

    const assistant = collected.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls?.[0]?.name).toBe('present_result');
    expect(assistant?.kind).toBeUndefined();
  });

  it('打回门行为不变：plan 模式漏调仍打回且限 1 次（第二次坏停放行不再打回）', async () => {
    const collected: SessionMessage[] = [];
    let calls = 0;
    const generate: LoopOptions['generate'] = async () => {
      calls++;
      return { content: `第 ${calls} 次停下。`, finishReason: 'stop' };
    };

    await runLoop(baseOpts({
      tools: [presentResultTool],
      generate,
      onMessage: (m) => collected.push(m),
      behaviorMode: 'plan',
    }));

    // 两次 generate：第一次坏停被打回（丢弃不 onMessage），第二次坏停达重试上限 → 放行不再打回。
    expect(calls).toBe(2);
    const assistantMsgs = collected.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].content).toBe('第 2 次停下。');
    expect(assistantMsgs[0].kind).toBeUndefined(); // 无 present_result 调用 → 不盖章
  });

  // ── BMad CR-T1-016：abort-with-toolCalls 终局消息不盖 intent_restate ──

  it('CR-T1-016：abort-with-toolCalls（含 present_result awaiting=true）不盖 kind——持久化对不假装待确认', async () => {
    const controller = new AbortController();
    const collected: SessionMessage[] = [];
    const generate: LoopOptions['generate'] = async () => {
      // generate 已 resolve 但 abort 已触发（late abort）+ 带 toolCalls——走持久化对路径。
      controller.abort(new DOMException('Aborted', 'AbortError'));
      return {
        content: '调了收尾声明但被中断',
        toolCalls: [toolCall('c1', 'present_result', { awaiting_intent_confirmation: true })],
        finishReason: 'tool_calls',
      };
    };

    await expect(runLoop(baseOpts({
      tools: [presentResultTool],
      generate,
      abort: controller.signal,
      onMessage: (m) => collected.push(m),
      behaviorMode: 'plan',
    }))).rejects.toMatchObject({ name: 'AbortError' });

    const assistant = collected.find((m) => m.role === 'assistant');
    // 持久化对语义不变：assistant 带 toolCalls 落盘 + cancelled tool results 成对。
    expect(assistant?.toolCalls?.[0]?.name).toBe('present_result');
    const toolMsg = collected.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('cancelled');
    expect(assistant?.kind).toBeUndefined();
  });
});
