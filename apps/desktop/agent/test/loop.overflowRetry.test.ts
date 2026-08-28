import { describe, expect, it, vi } from 'vitest';
import { runLoop } from '../src/agent/loop';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// S4b（task 08-25 design §4.1 未知模型溢出 400 兜底）：generate 抛协议层标记的
// context 溢出错误（ProtocolContextOverflowError 稳定 name / code=CONTEXT_OVERFLOW——
// agent 包按 name 鸭子判定，mirror readStreamInterrupted 先例）→ 一次确定性快压
// （compactConversationHardCut 保尾 2）后重试一次；再溢出原样上抛。
// ─────────────────────────────────────────────────────────────────────────────

function overflowError(): Error {
  // mirror model-protocols errors.ts ProtocolContextOverflowError 的跨缝形态。
  const err = new Error('This model maximum context length is 8192 tokens, however you requested 20000 tokens');
  err.name = 'ProtocolContextOverflowError';
  return Object.assign(err, { code: 'CONTEXT_OVERFLOW' });
}

const MESSAGES: SessionMessage[] = [
  { id: 'u1', role: 'user', content: '第一问', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: '第一答', createdAt: 2 },
  { id: 'u2', role: 'user', content: '第二问', createdAt: 3 },
];

function makeBaseOptions(generate: ReturnType<typeof vi.fn>) {
  return {
    sessionId: 's-overflow',
    projectPath: '/test',
    messages: MESSAGES,
    systemPrompt: 'SYS',
    tools: [],
    maxSteps: 3,
    generate,
    abort: new AbortController().signal,
  } as const;
}

describe('runLoop 溢出兜底（S4b design §4.1）', () => {
  it('generate 抛溢出标记错误 → 确定性快压一次后重试成功（generate 两调、压缩回调触发）', async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(overflowError())
      .mockResolvedValueOnce({ content: '重试答案', toolCalls: undefined, finishReason: 'stop' });
    const onCompaction = vi.fn();
    const stateUpdates: number[] = [];

    const result = await runLoop({
      ...makeBaseOptions(generate),
      onMessage: () => {},
      onCompaction,
      onContextStateUpdate: (state) => stateUpdates.push(state.compactionCount),
    });

    expect(generate).toHaveBeenCalledTimes(2);
    // 重试答案成为终帧（消息被压掉的中间历史只留保尾区——重试仍见本轮 user 消息）。
    expect(result.at(-1)?.role).toBe('assistant');
    expect(result.at(-1)?.content).toBe('重试答案');
    // 压缩回调 + 状态回写（持久化面 mirror prepareContext 压缩分支）。
    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(stateUpdates.at(-1)).toBeGreaterThan(0);
  });

  it('code=CONTEXT_OVERFLOW 但 name 不同的形态同样识别（belt：code 判据）', async () => {
    const raw = new Error('prompt is too long');
    const generate = vi.fn()
      .mockRejectedValueOnce(Object.assign(raw, { code: 'CONTEXT_OVERFLOW' }))
      .mockResolvedValueOnce({ content: 'ok', toolCalls: undefined, finishReason: 'stop' });

    const result = await runLoop({ ...makeBaseOptions(generate), onMessage: () => {} });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.at(-1)?.content).toBe('ok');
  });

  it('重试仍溢出 → 原样上抛（不无限压缩重试）', async () => {
    const generate = vi.fn().mockRejectedValue(overflowError());

    await expect(
      runLoop({ ...makeBaseOptions(generate), onMessage: () => {} }),
    ).rejects.toMatchObject({ name: 'ProtocolContextOverflowError' });
    expect(generate).toHaveBeenCalledTimes(2); // 初试 + 压缩后重试一次，仅此而已
  });

  it('普通 400（非溢出族）不走快压重试（一次调用即上抛，错误语义不变）', async () => {
    const plain = new Error('invalid request: unknown parameter');
    plain.name = 'ProtocolHttpError';
    const generate = vi.fn().mockRejectedValue(plain);

    await expect(
      runLoop({ ...makeBaseOptions(generate), onMessage: () => {} }),
    ).rejects.toBe(plain);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  // ── 08-25 BMad CR P1（CR-002 / CR-003 / CR-008）──

  it('CR-002：溢出重试携带重建后的 cacheConfig（hardCut 摘要生效，不再传过期摘要）', async () => {
    // 初试 cacheConfig 无摘要（未触发 prepareContext 压缩）；hardCut 后 contextState 已带
    // 摘要 → 重试 generate 的第 5 参必须含被压掉的中段（旧实现沿用 prepared.cacheConfig，
    // 切掉的中段静默丢失）。
    const calls: Array<{ messages: SessionMessage[]; compactedSummary?: string }> = [];
    const generate = vi.fn(
      async (
        msgs: SessionMessage[],
        _system: string,
        _tools: unknown[],
        _abort: AbortSignal,
        cacheConfig?: { compactedSummary?: string },
      ) => {
        calls.push({ messages: [...msgs], compactedSummary: cacheConfig?.compactedSummary });
        if (calls.length === 1) throw overflowError();
        return { content: '重试答案', toolCalls: undefined, finishReason: 'stop' };
      },
    );

    await runLoop({ ...makeBaseOptions(generate), onMessage: () => {} });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(calls[0].compactedSummary).toBeUndefined(); // 初试：无摘要
    // 重试：hardCut 摘要（保尾 2 = [a1,u2]，被压掉的 u1「第一问」进摘要）。
    expect(calls[1].compactedSummary).toContain('第一问');
    expect(calls[1].messages).toHaveLength(2); // hardCut 保尾 2（非 required 档）
  });

  it('CR-003：报文含真实小窗 → hardCut 预算用提取窗口（重试摘要带预算截断标记）', async () => {
    // 报文声明窗口 1000 tokens → 摘要预算 1000×0.25×3.5 = 875 chars；消息 1000 chars/条
    // → join 超预算 → 截断标记（若沿用 1M 假预算则无标记、且对真实小窗剪不动）。
    const err = new Error(
      "This model's maximum context length is 1000 tokens. However, you requested 5000 tokens.",
    );
    err.name = 'ProtocolContextOverflowError';
    Object.assign(err, { code: 'CONTEXT_OVERFLOW' });

    const calls: Array<{ compactedSummary?: string }> = [];
    const generate = vi.fn(
      async (
        _msgs: SessionMessage[],
        _system: string,
        _tools: unknown[],
        _abort: AbortSignal,
        cacheConfig?: { compactedSummary?: string },
      ) => {
        calls.push({ compactedSummary: cacheConfig?.compactedSummary });
        if (calls.length === 1) throw err;
        return { content: 'ok', toolCalls: undefined, finishReason: 'stop' };
      },
    );

    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: 'x'.repeat(1000), createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'y'.repeat(1000), createdAt: 2 },
      { id: 'u2', role: 'user', content: 'z'.repeat(1000), createdAt: 3 },
    ];
    await runLoop({ ...makeBaseOptions(generate), messages, onMessage: () => {} });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(calls[1].compactedSummary).toContain('硬截断摘要中段省略');
  });

  it('CR-008：required 档（kimi-k3）→ 溢出 hardCut 保尾 = 保底区段 6，近段 reasoning 完整', async () => {
    const messages: SessionMessage[] = Array.from({ length: 8 }, (_, i) => ({
      id: `m-${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as SessionMessage['role'],
      content: `消息${i}`,
      createdAt: i + 1,
      ...(i % 2 === 1 ? { reasoning: `思考${i}` } : {}),
    }));
    const retryMessages: SessionMessage[][] = [];
    const generate = vi.fn(
      async (msgs: SessionMessage[]) => {
        retryMessages.push([...msgs]);
        if (retryMessages.length === 1) throw overflowError();
        return { content: 'ok', toolCalls: undefined, finishReason: 'stop' };
      },
    );

    await runLoop({
      ...makeBaseOptions(generate),
      messages,
      onMessage: () => {},
      thinkingKind: 'kimi-k3',
    });

    expect(generate).toHaveBeenCalledTimes(2);
    // 保底区段 6（非保尾 2）：m-2..m-7，assistant 消息的 reasoning 原样在场。
    expect(retryMessages[1]).toHaveLength(6);
    const withReasoning = retryMessages[1].filter((m) => m.reasoning !== undefined);
    expect(withReasoning.map((m) => m.id)).toEqual(['m-3', 'm-5', 'm-7']);
    expect(withReasoning.every((m) => (m.reasoning ?? '').length > 0)).toBe(true);
  });

  it('CR-008 对照：非 required 档（缺省）→ 溢出 hardCut 保尾 2（现行为不变）', async () => {
    const retryMessages: SessionMessage[][] = [];
    const generate = vi.fn(
      async (msgs: SessionMessage[]) => {
        retryMessages.push([...msgs]);
        if (retryMessages.length === 1) throw overflowError();
        return { content: 'ok', toolCalls: undefined, finishReason: 'stop' };
      },
    );

    await runLoop({ ...makeBaseOptions(generate), onMessage: () => {} });

    expect(retryMessages[1]).toHaveLength(2);
  });
});
