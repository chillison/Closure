import { describe, expect, it, vi } from 'vitest';
import {
  generate,
  setGenerateTextFn,
  type GenerateTextFn,
  type GenerateTextRequest,
  type GenerationDelta,
} from '../src/provider/ipc-provider';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 1（流式缝 / design §2）：GenerateTextFn 加第三参
// callbacks{onDelta} + 返回类型加 reasoning?/usage?（usage 仅类型留缝，零消费）。
// generate() 加 opts.onDelta 透传。本文件钉住三件事：
//   1. 无 onDelta → seam 调用形状与升级前逐字节一致（恰好两参，零回归）；
//   2. 有 onDelta → 第三参 {onDelta} 原引用透传，delta 经闭包直达调用方；
//   3. seam 返回带 reasoning/usage（新 additive 字段）时既有 GenerateResult
//      映射不动（content/toolCalls/finishReason 照旧）。
// 分派逻辑（有回调走流式/无回调走非流式）在 shell 侧 generateTextImpl，
// 由 shell 包 agentIpcStreamDispatch.test.ts 端到端钉住。
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGES: SessionMessage[] = [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }];
const SIGNAL = new AbortController().signal;

function installSeam(impl: GenerateTextFn) {
  const seam = vi.fn<GenerateTextFn>(impl);
  setGenerateTextFn(seam);
  return seam;
}

describe('ipc-provider 流式缝（dogfood T1 Stage 1）', () => {
  it('无 onDelta → seam 恰以两参被调（升级前逐字节一致，零回归）', async () => {
    const seam = installSeam(async (_body: GenerateTextRequest) => ({ text: 'ok', finishReason: 'stop' }));

    const result = await generate(MESSAGES, 'SYS', [], SIGNAL);

    expect(seam).toHaveBeenCalledTimes(1);
    // 恰好两个实参——不传 undefined 占位（旧签名调用形状不变）。
    expect(seam.mock.calls[0].length).toBe(2);
    expect(seam.mock.calls[0][2]).toBeUndefined();
    // 既有映射照旧。
    expect(result).toEqual({ content: 'ok', toolCalls: undefined, finishReason: 'stop' });
  });

  it('有 onDelta → 第三参 {onDelta} 原引用透传，delta 直达调用方回调', async () => {
    const received: GenerationDelta[] = [];
    const onDelta = (d: GenerationDelta) => received.push(d);
    // seam 侧拿到 callbacks 后同步吐两枚 delta（text + reasoning），验证闭包转发链。
    const seam = installSeam(async (_body, _abort, callbacks) => {
      callbacks?.onDelta?.({ type: 'reasoning', delta: '思' });
      callbacks?.onDelta?.({ type: 'text', delta: '正文' });
      return { text: '正文', finishReason: 'stop' };
    });

    const result = await generate(MESSAGES, 'SYS', [], SIGNAL, { onDelta });

    expect(seam).toHaveBeenCalledTimes(1);
    const callbacks = seam.mock.calls[0][2];
    expect(callbacks).toBeDefined();
    expect(callbacks?.onDelta).toBe(onDelta); // 同一函数引用，非包装副本
    expect(received).toEqual([
      { type: 'reasoning', delta: '思' },
      { type: 'text', delta: '正文' },
    ]);
    expect(result.content).toBe('正文');
  });

  it('seam 返回 reasoning/reasoningSignature/usage → 全透传进 GenerateResult（S4b：usage 透出 = 校准环生产激活）', async () => {
    installSeam(async () => ({
      text: '答案',
      toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{"q":"x"}' }],
      finishReason: 'tool_calls',
      reasoning: '推理过程',
      reasoningSignature: 'sig-abc',
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    }));

    const result = await generate(MESSAGES, 'SYS', [], SIGNAL);

    // dogfood T1 Stage 2：generate() 透传 reasoning（#27② 终帧聚合落消息）。
    // S4b（task 08-25）：usage 透出（runLoop 校准环 updateCalibrationRatio 的生产激活开关——
    // 此前仅类型留缝零消费）+ reasoningSignature 透出（Anthropic thinking 块签名，落终帧
    // assistantMsg 供 messagesToPayload 多轮回传）。
    expect(result).toEqual({
      content: '答案',
      toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{"q":"x"}' }],
      finishReason: 'tool_calls',
      reasoning: '推理过程',
      reasoningSignature: 'sig-abc',
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
  });

  it('finishReason 缺省仍回退 stop（缺省语义与升级前一致）', async () => {
    installSeam(async () => ({ text: 'x' }));

    const result = await generate(MESSAGES, 'SYS', [], SIGNAL);
    expect(result.finishReason).toBe('stop');
    expect(result.content).toBe('x');
  });

  // dogfood T1 Stage 4（design §6.3 / r3）：核对钉——历史 assistant 消息携带 reasoning
  //（#27② 持久化字段）时，messagesToPayload **不**把 reasoning 塞回给模型（各协议
  // assistant reasoning 回传格式不一，首期只展示 + 持久化）。经公开 generate 缝行为级断言。
  it('payload 不回传 reasoning——历史消息的 reasoning 字段不进模型请求', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));
    const history: SessionMessage[] = [
      { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: '带思考的回答', reasoning: '深度思考全文', createdAt: 2 },
      { id: 'm3', role: 'user', content: '继续', createdAt: 3 },
    ];

    await generate(history, 'SYS', [], SIGNAL);

    const payloadMessages = seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>;
    const assistantPayload = payloadMessages.find((m) => m.role === 'assistant');
    expect(assistantPayload).toBeDefined();
    expect(assistantPayload?.content).toBe('带思考的回答');
    expect('reasoning' in (assistantPayload ?? {})).toBe(false); // 不回传（r3：各协议格式不一）
  });
});
