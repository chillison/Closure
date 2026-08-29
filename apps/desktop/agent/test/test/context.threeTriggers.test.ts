import { describe, it, expect, vi } from 'vitest';
import {
  prepareContext,
  createDefaultContextState,
  compactConversationHardCut,
  ContextWindowOverflowError,
} from '../src/context/contextManager';
import { CONTEXT_REPLY_RESERVE_TOKENS } from '../src/context/tokenEstimator';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// S4a（task 08-25 design §4.1，PRD 拍板 4-D）：prepareContext 三触发——注入窗口/红线。
// ① 手动不在本函数（workflow.manualCompactSession 门面，另见 workflow 测试）；
// ② 红线：估算 ≥ 窗口 × redlinePercent（缺省 95%）；
// ③ 顶满：投影溢出（估算 + 回复预留 > 窗口）强制压 → 压后仍溢出 → compactConversation
//    硬截断（保尾 2）→ 再溢出明确报错（ContextWindowOverflowError，不静默）。
// 阈值全部经 ContextManagerInput 注入（不依赖 1M 巨窗造数据）。
// ─────────────────────────────────────────────────────────────────────────────

function makeMessages(count: number, charsPer = 1000): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as SessionMessage['role'],
    content: 'x'.repeat(charsPer),
    createdAt: Date.now() + i,
  }));
}

describe('prepareContext 三触发（S4a 注入窗口/红线）', () => {
  it('未到红线且塞得下 → 不压缩（消息原样、零 LLM 调用）', async () => {
    const messages = makeMessages(10);
    const generate = vi.fn();
    const result = await prepareContext({
      systemPrompt: 'System',
      messages,
      contextState: createDefaultContextState(),
      generate,
      abort: new AbortController().signal,
    });

    expect(result.compactionOccurred).toBe(false);
    expect(result.messages).toBe(messages); // 引用不变 = 思考历史等完整保留（拍板 6）
    expect(generate).not.toHaveBeenCalled();
  });

  it('触发② 红线：到达注入红线（含 reasoning 计入估算）→ LLM 压缩', async () => {
    // 窗口 100K / 红线 50% → 触发线 50K；175 条 × ~290 tokens ≈ 50.75K 到线，
    // 投影（50.75K + 32.768K 预留 < 100K）未溢出——隔离纯红线触发。
    const messages = makeMessages(175);
    // 思考历史计入预算：给部分消息挂 reasoning，拍板 6「未到红线不压 = 思考保留」的估算基础。
    messages[0] = { ...messages[0], reasoning: '深度思考'.repeat(50) };

    const generate = vi.fn(async () => ({ content: '## Summary\n- compacted' }));
    const result = await prepareContext({
      systemPrompt: 'System',
      messages,
      contextState: createDefaultContextState(),
      generate,
      abort: new AbortController().signal,
      contextWindowTokens: 100_000,
      redlinePercent: 50,
    });

    expect(result.compactionOccurred).toBe(true);
    expect(result.messages.length).toBe(6); // 保尾 6（机制不变）
    expect(result.compactedCount).toBe(messages.length - 6);
    expect(result.cacheConfig.compactedSummary).toContain('compacted');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('触发③ 顶满：投影溢出强制压（红线未到也压）→ 压后塞得下即止（不硬截断）', async () => {
    // 窗口 40K：40 条 × ~576 tokens ≈ 23K < 红线 95%（38K）不触发；但 23K + 32.768K 预留
    // > 40K → 投影溢出强制压。压后保留尾 6（~3.5K）+ 摘要 + 预留 < 40K 塞得下。
    const messages = makeMessages(40, 2000);
    const generate = vi.fn(async () => ({ content: '## Summary\n- compacted' }));
    const result = await prepareContext({
      systemPrompt: 'System',
      messages,
      contextState: createDefaultContextState(),
      generate,
      abort: new AbortController().signal,
      contextWindowTokens: 40_000,
    });

    expect(result.compactionOccurred).toBe(true);
    expect(result.messages.length).toBe(6);
    expect(result.messages.every((m) => !m.content.includes('history_summary'))).toBe(true); // cacheConfig 车道：摘要不进消息
  });

  it('触发③ 升级：LLM 压缩后投影仍溢出 → compactConversation 硬截断（保尾 2）且不报错', async () => {
    // 窗口 80K：10 条消息，后 6 条各 ~32K chars（~9.17K tokens）——LLM 压缩保尾 6 后
    // ~55K + 32.768K 预留 > 80K 仍溢出 → 硬截断保尾 2（~18.3K）+ 摘要 cap（窗口 25% = 20K）
    // → ~38.3K + 32.768K < 80K 塞得下（预期不抛）。
    const smallHeads = makeMessages(4, 100);
    const bigTails = makeMessages(6, 32_000);
    const messages = [...smallHeads, ...bigTails];
    const generate = vi.fn(async () => ({ content: '## Summary\n- compacted' }));

    const result = await prepareContext({
      systemPrompt: 'System',
      messages,
      contextState: createDefaultContextState(),
      generate,
      abort: new AbortController().signal,
      contextWindowTokens: 80_000,
    });

    expect(result.compactionOccurred).toBe(true);
    expect(result.messages.length).toBe(2); // 硬截断保尾 2
    expect(result.compactedCount).toBe(messages.length - 2);
    // 硬截断摘要按窗口 25% 预算截断（确定性 join 6×32K chars 远超预算 → 带省略标记）。
    expect(result.cacheConfig.compactedSummary).toContain('硬截断摘要中段省略');
  });

  it('触发③ 终段：硬截断后仍塞不下 → ContextWindowOverflowError（含估算/窗口值，不静默）', async () => {
    // 窗口 30K ≪ 回复预留 32.768K：任何内容都投影溢出——硬截断后仍溢出 → 明确报错。
    const messages = makeMessages(40, 2000);
    const generate = vi.fn(async () => ({ content: '## Summary\n- compacted' }));

    const attempt = prepareContext({
      systemPrompt: 'System',
      messages,
      contextState: createDefaultContextState(),
      generate,
      abort: new AbortController().signal,
      contextWindowTokens: 30_000,
    });

    await expect(attempt).rejects.toBeInstanceOf(ContextWindowOverflowError);
    await expect(attempt).rejects.toThrow(/手动压缩|更大上下文窗口/);
    await expect(attempt).rejects.toThrow(/30000/); // 消息含窗口值
  });

  it('触发② LLM 摘要全失败 → summarizer 三级兜底产确定性摘要（压缩机制不改，压缩仍完成）', async () => {
    const messages = makeMessages(175);
    const generate = vi.fn(async () => {
      throw new Error('summarizer LLM down');
    });
    const result = await prepareContext({
      systemPrompt: 'System',
      messages,
      contextState: createDefaultContextState(),
      generate,
      abort: new AbortController().signal,
      contextWindowTokens: 100_000,
      redlinePercent: 50,
    });

    // compactWithSummarization 内部三级兜底（segmented → hard truncate）吞掉 LLM 失败——
    // 压缩照常完成，保尾 6 不变（机制不动，S4a 只改触发条件与窗口来源）。
    expect(result.compactionOccurred).toBe(true);
    expect(result.messages.length).toBe(6);
    expect(typeof result.cacheConfig.compactedSummary).toBe('string');
  });

  it('红线未到 + 投影未溢出：高红线不触发（红线语义=用户可调迟触发）', async () => {
    // 同估算量，红线 100 → 触发线 100K：23K 远未到且投影塞得下（23K + 32.768K < 100K）。
    const messages = makeMessages(40, 2000);
    const generate = vi.fn();
    const result = await prepareContext({
      systemPrompt: 'System',
      messages,
      contextState: createDefaultContextState(),
      generate,
      abort: new AbortController().signal,
      contextWindowTokens: 100_000,
      redlinePercent: 100,
    });

    expect(result.compactionOccurred).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('compactConversationHardCut（S4a 硬截断兜底单元）', () => {
  it('保尾切分 + 摘要合并 + 窗口预算截断', () => {
    const messages = makeMessages(10, 1000);
    const result = compactConversationHardCut({
      messages,
      existingSummary: '旧摘要',
      contextWindowTokens: 80_000,
    });

    expect(result.messages).toHaveLength(2); // 保尾 2
    expect(result.messages[0].id).toBe('msg-8');
    expect(result.messages[1].id).toBe('msg-9');
    expect(result.compactedCount).toBe(8);
    expect(result.summary).toContain('旧摘要');
    expect(result.summary).toContain('user: '); // role:content join 形态
    // 10×1000 chars ≈ 10K chars < 预算（80K×0.25×3.5 = 70K chars）→ 不截断
    expect(result.summary).not.toContain('硬截断摘要中段省略');
  });

  it('摘要超预算 → 保头尾省中段', () => {
    const messages = makeMessages(10, 30_000); // join ≈ 300K chars ≫ 预算
    const result = compactConversationHardCut({
      messages,
      contextWindowTokens: 10_000, // 预算 10K×0.25×3.5 = 8.75K chars
    });
    expect(result.summary).toContain('硬截断摘要中段省略');
    expect(result.summary.length).toBeLessThan(10_000);
  });
});

// ── 08-25 BMad CR P1（CR-001 配对守卫 / CR-008 required 保底区段 / CR-013 空转防御）──

/** 无孤儿断言：尾段内每条 tool 消息的 toolCallId 都有尾段内 assistant(toolCalls) 配对。 */
function hasNoOrphanTool(msgs: SessionMessage[]): boolean {
  const callIds = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const c of m.toolCalls) callIds.add(c.id);
    }
  }
  return msgs.every(
    (m) => m.role !== 'tool' || (m.toolResults ?? []).every((tr) => callIds.has(tr.toolCallId)),
  );
}

describe('compactConversationHardCut CR-001 配对守卫（08-25 BMad CR）', () => {
  it('保尾 2 盲切恰好落在 assistant(toolCalls) 与其 tool 之间 → 切点前收紧含其 assistant（尾段无孤儿 tool）', () => {
    // 历史 [..., assistant(toolCalls), tool, user]：旧盲切尾 = [tool, user]（孤儿 tool）。
    const messages: SessionMessage[] = [
      ...makeMessages(3, 100),
      {
        id: 'a-caller',
        role: 'assistant',
        content: '要查设定',
        toolCalls: [{ id: 'call-1', name: 'query_story', arguments: '{"q":"主角"}' }],
        createdAt: 4,
      },
      {
        id: 't-orphan-would-be',
        role: 'tool',
        content: '查询结果',
        toolResults: [{ toolCallId: 'call-1', toolName: 'query_story', output: '查询结果' }],
        createdAt: 5,
      },
      { id: 'u-last', role: 'user', content: '继续', createdAt: 6 },
    ];

    const result = compactConversationHardCut({ messages, contextWindowTokens: 80_000 });

    // 守卫后尾段含配对 assistant（mirror summarizer.ts:73-76 的 splitIndex 回退）。
    expect(result.messages.map((m) => m.id)).toEqual(['a-caller', 't-orphan-would-be', 'u-last']);
    expect(hasNoOrphanTool(result.messages)).toBe(true);
    expect(result.compactedCount).toBe(3);
    // 被收紧进压缩侧的仍是前 3 条泛化消息（role:content join 形态）。
    expect(result.summary).toContain('user: ');
  });

  it('连续多条 tool 消息（一次 assistant 多调用）→ 全部随配对 assistant 入尾段', () => {
    const messages: SessionMessage[] = [
      ...makeMessages(3, 100),
      {
        id: 'a-multi',
        role: 'assistant',
        content: '并行查询',
        toolCalls: [
          { id: 'c1', name: 'query_story', arguments: '{}' },
          { id: 'c2', name: 'query_craft', arguments: '{}' },
        ],
        createdAt: 4,
      },
      { id: 't-1', role: 'tool', content: 'r1', toolResults: [{ toolCallId: 'c1', toolName: 'query_story', output: 'r1' }], createdAt: 5 },
      { id: 't-2', role: 'tool', content: 'r2', toolResults: [{ toolCallId: 'c2', toolName: 'query_craft', output: 'r2' }], createdAt: 6 },
      { id: 'u-last', role: 'user', content: '继续', createdAt: 7 },
    ];

    const result = compactConversationHardCut({ messages, contextWindowTokens: 80_000 });

    expect(result.messages.map((m) => m.id)).toEqual(['a-multi', 't-1', 't-2', 'u-last']);
    expect(hasNoOrphanTool(result.messages)).toBe(true);
  });

  it('尾段末尾 dangling assistant(toolCalls)（无 tool 回填）→ 并入压缩侧（不留未回填调用给下一请求）', () => {
    const messages: SessionMessage[] = [
      ...makeMessages(3, 100),
      { id: 'u-1', role: 'user', content: '继续', createdAt: 4 },
      {
        id: 'a-dangling',
        role: 'assistant',
        content: '调用中',
        toolCalls: [{ id: 'c9', name: 'query_story', arguments: '{}' }],
        createdAt: 5,
      },
    ];

    const result = compactConversationHardCut({ messages, contextWindowTokens: 80_000 });

    // dangling assistant 并入摘要（内容可追溯），尾段不带未回填 toolCalls。
    expect(result.messages.map((m) => m.id)).toEqual(['u-1']);
    expect(result.summary).toContain('调用中');
    expect(result.compactedCount).toBe(4);
    expect(hasNoOrphanTool(result.messages)).toBe(true);
  });
});

describe('compactConversationHardCut / prepareContext CR-008 required 保底区段（08-25 BMad CR）', () => {
  it('hardCut 单元：reasoningRoundTripRequired → 保尾下限 = 保底区段 6（非 2），近段 reasoning 完整保留', () => {
    const messages = makeMessages(10, 100).map((m, i) =>
      m.role === 'assistant' ? { ...m, reasoning: `思考-${m.id}` } : m,
    );

    const result = compactConversationHardCut({
      messages,
      contextWindowTokens: 80_000,
      reasoningRoundTripRequired: true,
    });

    expect(result.messages).toHaveLength(6); // 保底区段（保尾 2 抬到 6）
    const retainedReasoning = result.messages.filter((m) => m.reasoning);
    expect(retainedReasoning).toHaveLength(3); // 尾段 3 条 assistant 的 reasoning 原样在场
    expect(retainedReasoning.map((m) => m.reasoning)).toEqual(['思考-msg-5', '思考-msg-7', '思考-msg-9']);
    // 对照组（同输入非 required）：保尾 2，第 7 位（距尾 3）的 reasoning 被切掉。
    const plain = compactConversationHardCut({ messages, contextWindowTokens: 80_000 });
    expect(plain.messages).toHaveLength(2);
    expect(plain.messages.some((m) => m.id === 'msg-7')).toBe(false);
  });

  it('prepareContext LLM 路径：required 档（deepseek-v4）红线压缩 → 保尾区段完整保留（近段 reasoning 不丢）', async () => {
    // 窗口 100K / 红线 50%（同触发②用例数值）：压缩本身保尾 6——测试钉「required 档近段
    // 消息仍含近段 reasoning」的不变量（region 完整性，防未来回归）。
    const messages = makeMessages(175).map((m) =>
      m.role === 'assistant' ? { ...m, reasoning: `思考-${m.id}` } : m,
    );
    const generate = vi.fn(async () => ({ content: '## Summary\n- compacted' }));

    const result = await prepareContext({
      systemPrompt: 'System',
      messages,
      contextState: createDefaultContextState(),
      generate,
      abort: new AbortController().signal,
      contextWindowTokens: 100_000,
      redlinePercent: 50,
      thinkingKind: 'deepseek-v4',
    });

    expect(result.compactionOccurred).toBe(true);
    expect(result.messages).toHaveLength(6);
    const retainedReasoning = result.messages.filter((m) => m.reasoning);
    expect(retainedReasoning.map((m) => m.id)).toEqual(['msg-169', 'msg-171', 'msg-173']);
    expect(retainedReasoning.every((m) => typeof m.reasoning === 'string' && m.reasoning.length > 0)).toBe(true);
  });

  it('prepareContext 升级路径：required 档（kimi-k3）投影溢出 → 硬截断保底区段 6（非 2）且不误报溢出', async () => {
    // 窗口 200K：既有摘要 400K chars（~114.3K tokens）+ 6 条大尾（64166 chars ≈ 18.3K
    // tokens/条 → 110K）→ 投影 224K + 预留 32.768K > 200K 强制触发；LLM 摘要 mock 210K
    // chars（60K tokens）→ 压后 170K + 32.768K 仍溢出 → 升级硬截断；required 保尾 6
    //（非 2）+ 摘要截到窗口 25% 预算（175K chars ≈ 50K tokens）→ 160K + 32.768K ≤ 200K
    // 塞得下（不抛 ContextWindowOverflowError）。
    const heads = makeMessages(4, 100);
    const tails = makeMessages(6, 64_166).map((m) =>
      m.role === 'assistant' ? { ...m, reasoning: `思考-${m.id}` } : m,
    );
    const messages = [...heads, ...tails];
    const contextState = {
      ...createDefaultContextState(),
      compactedSummary: 'X'.repeat(400_000),
    };
    const generate = vi.fn(async () => ({ content: 'S'.repeat(210_000) }));

    const result = await prepareContext({
      systemPrompt: 'System',
      messages,
      contextState,
      generate,
      abort: new AbortController().signal,
      contextWindowTokens: 200_000,
      thinkingKind: 'kimi-k3',
    });

    expect(result.compactionOccurred).toBe(true);
    expect(result.messages).toHaveLength(6); // 保底区段（保尾 2 被抬到 6）
    expect(result.messages.filter((m) => m.reasoning)).toHaveLength(3); // 近段 reasoning 完整
    expect(result.cacheConfig.compactedSummary).toContain('硬截断摘要中段省略'); // 小预算截断生效
  });
});

describe('prepareContext CR-013 空转防御（08-25 BMad CR）', () => {
  it('红线到线但无可压内容（消息 ≤ 保尾区）→ 不改写状态、不触发压缩、按未压缩返回', async () => {
    // 窗口 100K / 红线 50% → 触发线 50K；5 条 × 36000 chars ≈ 51.4K 到线（红线触发）；
    // 投影 51.4K + 32.768K < 100K 未溢出（隔离纯红线空转形态——overhead 自身过线的稳态）。
    const messages = makeMessages(5, 36_000);
    const state = createDefaultContextState();
    const generate = vi.fn(async () => ({ content: '## Summary' }));

    const result = await prepareContext({
      systemPrompt: 'System',
      messages,
      contextState: state,
      generate,
      abort: new AbortController().signal,
      contextWindowTokens: 100_000,
      redlinePercent: 50,
    });

    // CR-013：compactedCount 0 且非投影溢出 → 跳过状态改写与压缩调用。
    expect(result.compactionOccurred).toBe(false);
    expect(result.compactedCount).toBe(0);
    expect(result.contextState).toBe(state); // 原引用 = compactionCount/lastCompactionAt 未动
    expect(result.messages).toBe(messages); // 原引用 = 思考历史完整保留
    expect(generate).not.toHaveBeenCalled(); // 空转不烧摘要调用（toCompress 空本就不该调）
  });
});

describe('回复预留常量（触发③ 判定基线）', () => {
  it('预留为正且量级 = 32K 护栏尺度', () => {
    expect(CONTEXT_REPLY_RESERVE_TOKENS).toBe(32_768);
  });
});
