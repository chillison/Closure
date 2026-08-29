import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeAgentLoop, type AgentLoopConfig, type AgentLoopDeps } from '../src/nodes/agent-loop';
import { ContextWindowOverflowError } from '../src/context/contextManager';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { GenerateResult } from '../src/provider/ipc-provider';
import type { SessionMessage, ToolDefinition } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// S4a（task 08-25 design §4.1）：makeAgentLoop pre-gate——writer 自查 / 资料员
// 子循环此前零窗口管理（research C Q1），补同款红线 + 投影溢出判定（无手动位）。
// 窗口/红线经 AgentLoopConfig 注入；压缩作用域 = stablePrefix 之后的对话段，
// 摘要以 <history_summary> 对形态重注入（mirror provider messagesToPayload）。
// 数值锚：1,000 chars ≈ 290 tokens、3,000 chars ≈ 862 tokens（含 4 framing）。
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeTool(id: string): ToolDefinition {
  return {
    id,
    description: `fake tool ${id}`,
    parameters: z.object({ q: z.string().optional() }),
    execute: vi.fn(async () => ({ title: id, output: `${id} ok` })),
  };
}

function makeDeps(generate: GenerateFn, tools: ToolDefinition[]): AgentLoopDeps {
  const byId = new Map(tools.map((t) => [t.id, t]));
  return { generate, resolveTool: (id) => byId.get(id) };
}

function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    toolIds: ['query_story'],
    systemPrompt: 'SYS_PROMPT',
    stablePrefix: [{ id: 'prefix-1', role: 'user', content: '任务卡+设定前缀', createdAt: 1 }],
    stopMarkers: ['<BRIEF_DONE>'],
    maxRounds: 10,
    projectPath: '/proj',
    ...overrides,
  };
}

/**
 * gate 场景的 mock generate：tools 空 = 摘要调用（gateSummarizationGenerate 零工具）。
 * 主调用消息在 mock 内快照拷贝——deps.generate 收到的是 live 数组引用，循环后 push 的
 * assistant 消息会渗进 mock.calls 的记录（mirror loop.contextIntegration 的拷贝模式）。
 */
function makeGateGenerate(summary = '## Summary\n- compacted'): {
  generate: ReturnType<typeof vi.fn<GenerateFn>>;
  mainCalls: SessionMessage[][];
} {
  const mainCalls: SessionMessage[][] = [];
  const generate = vi.fn<GenerateFn>(async (msgs, _system, tools): Promise<GenerateResult> => {
    if (tools.length === 0) {
      return { content: summary, finishReason: 'stop' };
    }
    mainCalls.push([...msgs]);
    return { content: '调查完毕 <BRIEF_DONE>', finishReason: 'stop' };
  });
  return { generate, mainCalls };
}

function makePrior(count: number, charsPer = 3000): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `prior-${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as SessionMessage['role'],
    content: 'x'.repeat(charsPer),
    createdAt: i + 1,
  }));
}

describe('makeAgentLoop pre-gate（S4a 窗口闸门）', () => {
  it('投影溢出触发：压缩对话段 + 摘要对重注入 + stablePrefix 原样保留', async () => {
    // 10×3,000 chars ≈ 8.6K tokens + 预留 32.768K > 窗口 40K → 投影溢出（红线 95%=38K 未到，
    // 隔离触发③）。压缩后保留尾 6（~4.3K）+ 摘要 + 预留 < 40K 塞得下 → 不硬截断不报错。
    const tool = makeFakeTool('query_story');
    const { generate, mainCalls } = makeGateGenerate();
    const run = makeAgentLoop(
      makeDeps(generate, [tool]),
      makeConfig({ contextWindowTokens: 40_000 }),
    );

    const result = await run({ userPrompt: '开始自查', priorMessages: makePrior(10) });

    expect(result.status).toBe('stopped');
    expect(result.content).toContain('<BRIEF_DONE>');
    // 两次 generate：1 次 gate 摘要（零工具）+ 1 次主调用。
    expect(generate).toHaveBeenCalledTimes(2);

    // 主调用消息 = stablePrefix(1) + 摘要对(2) + 保留尾 6 = 9 条；前缀逐字节保留。
    expect(mainCalls).toHaveLength(1);
    const sentMessages = mainCalls[0];
    expect(sentMessages).toHaveLength(9);
    expect(sentMessages[0].id).toBe('prefix-1');
    expect(sentMessages[1].role).toBe('user');
    expect(sentMessages[1].content).toContain('<history_summary');
    expect(sentMessages[1].content).toContain('compacted');
    expect(sentMessages[2].role).toBe('assistant'); // 摘要确认对（mirror provider 注对形态）
    expect(sentMessages[8].content).toBe('开始自查'); // 保留尾含本阶段 user 指令

    // produced（返回值）= 摘要对 + user 指令 + 收束轮，不含被压掉的 priorMessages。
    expect(result.messages.some((m) => m.content.includes('<history_summary'))).toBe(true);
    expect(result.messages.some((m) => m.content === '开始自查')).toBe(true);
    expect(result.messages.some((m) => m.id.startsWith('prior-'))).toBe(false);
  });

  it('红线触发：估算到红线（投影未溢出）同样压缩', async () => {
    // 窗口 100K / 红线 10 → clamp 50 → 触发线 50K；60×3,000 chars ≈ 51.7K 到线；
    // 投影 51.7K + 32.768K < 100K 未溢出——隔离触发②（含 redlinePercent clamp 链路）。
    const tool = makeFakeTool('query_story');
    const { generate, mainCalls } = makeGateGenerate();
    const run = makeAgentLoop(
      makeDeps(generate, [tool]),
      makeConfig({ contextWindowTokens: 100_000, redlinePercent: 10 }),
    );

    const result = await run({ userPrompt: '开始自查', priorMessages: makePrior(60) });

    expect(result.status).toBe('stopped');
    expect(mainCalls).toHaveLength(1);
    const sentMessages = mainCalls[0];
    expect(sentMessages).toHaveLength(9); // 前缀 1 + 摘要对 2 + 保留尾 6
    expect(sentMessages[1].content).toContain('<history_summary');
  });

  it('未触发：缺省 1M 窗口下零压缩零摘要注入（零回归）', async () => {
    const tool = makeFakeTool('query_story');
    const { generate, mainCalls } = makeGateGenerate();
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    const result = await run({ userPrompt: '开始自查', priorMessages: makePrior(10) });

    expect(result.status).toBe('stopped');
    // 只有一次主调用（无摘要调用）；消息 = 前缀 1 + prior 10 + user 1 = 12 原样。
    expect(generate).toHaveBeenCalledTimes(1);
    const sentMessages = mainCalls[0];
    expect(sentMessages).toHaveLength(12);
    expect(sentMessages.some((m) => m.content.includes('<history_summary'))).toBe(false);
    expect(result.messages.every((m) => !m.content.includes('<history_summary'))).toBe(true);
  });

  it('硬截断后仍塞不下 → ContextWindowOverflowError（明确报错，generate 主调用未发生）', async () => {
    // 窗口 20K ≪ 回复预留 32.768K：压缩 + 硬截断后仍投影溢出 → 抛错不静默。
    const tool = makeFakeTool('query_story');
    const { generate, mainCalls } = makeGateGenerate();
    const run = makeAgentLoop(
      makeDeps(generate, [tool]),
      makeConfig({ contextWindowTokens: 20_000 }),
    );

    await expect(
      run({ userPrompt: '开始自查', priorMessages: makePrior(10) }),
    ).rejects.toBeInstanceOf(ContextWindowOverflowError);

    // 只有 gate 的摘要调用发生（1 次），主 generate 未发出（不放行超窗请求）。
    expect(generate).toHaveBeenCalledTimes(1);
    expect(mainCalls).toHaveLength(0);
    const [msgs, , tools] = generate.mock.calls[0];
    expect((tools as ToolDefinition[]).length).toBe(0);
    expect((msgs as SessionMessage[]).length).toBeGreaterThan(0);
  });

  it('CR-013：红线到线但对话段无可压（≤ 保尾 6）→ 不注入摘要对、零摘要调用（空转防御）', async () => {
    // 窗口 100K / 红线 10 → clamp 50 → 触发线 50K；4 条 prior × 45000 chars ≈ 51.4K 到线
    //（红线触发）；投影 51.4K + 32.768K < 100K 未溢出（隔离纯空转形态）。对话段 =
    // 4 prior + 1 user = 5 条 ≤ 保尾 6 → compactedCount 0 → 不重注入新 UUID 摘要对。
    const tool = makeFakeTool('query_story');
    const { generate, mainCalls } = makeGateGenerate();
    const run = makeAgentLoop(
      makeDeps(generate, [tool]),
      makeConfig({ contextWindowTokens: 100_000, redlinePercent: 10 }),
    );

    const result = await run({ userPrompt: '开始自查', priorMessages: makePrior(4, 45_000) });

    expect(result.status).toBe('stopped');
    // 仅一次主调用（compactWithSummarization toCompress 空早退，零摘要 LLM 调用）。
    expect(generate).toHaveBeenCalledTimes(1);
    expect(mainCalls).toHaveLength(1);
    // 消息原样：prefix 1 + prior 4 + user 1 = 6，无摘要对注入（无 UUID churn / 前缀漂移）。
    const sentMessages = mainCalls[0];
    expect(sentMessages).toHaveLength(6);
    expect(sentMessages.some((m) => m.content.includes('<history_summary'))).toBe(false);
    expect(result.messages.every((m) => !m.content.includes('<history_summary'))).toBe(true);
  });
});
