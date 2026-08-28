import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeAgentLoop, estimateSummaryPairTokens, type AgentLoopConfig, type AgentLoopDeps } from '../src/nodes/agent-loop';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionMessage, ToolDefinition } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// 08-25 BMad CR P1：makeAgentLoop 车道溢出重试（CR-004——CONTEXT_OVERFLOW 标记此前
// 穿过三层无人消费，档未配置时 1M 假窗口盲重试到节点失败）+ CR-018 摘要对开销估算。
// 溢出识别/窗口提取/hardCut 装配 = 共享 helper context/overflow.ts（loop 车道同源，
// 单元见 context.overflow.test.ts）；本文件钉 makeAgentLoop 的消息记账形态：
// 压缩作用域 = stablePrefix + 摘要对之后的对话段，hardCut 摘要以摘要对形态重注入
//（本循环 generate 不吃 cacheConfig，摘要必须以消息进上下文）。
// ─────────────────────────────────────────────────────────────────────────────

function overflowError(message: string): Error {
  const err = new Error(message);
  err.name = 'ProtocolContextOverflowError';
  return Object.assign(err, { code: 'CONTEXT_OVERFLOW' });
}

function makeFakeTool(id: string): ToolDefinition {
  return {
    id,
    description: `fake tool ${id}`,
    parameters: z.object({ q: z.string().optional() }),
    execute: vi.fn(async () => ({ title: id, output: `${id} ok` })),
  };
}

function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    toolIds: ['query_story'],
    systemPrompt: 'SYS_PROMPT',
    stablePrefix: [{ id: 'prefix-1', role: 'user', content: '任务卡+设定前缀', createdAt: 1 }],
    stopMarkers: ['<BRIEF_DONE>'],
    maxRounds: 10,
    projectPath: '/proj',
    // 不注入 contextWindowTokens：缺省 1M → pre-gate 恒不触发（隔离溢出重试路径）；
    // 真实窗口从报文提取（CR-003 同款链路）。
    ...overrides,
  };
}

function makeDeps(generate: GenerateFn, tools: ToolDefinition[]): AgentLoopDeps {
  const byId = new Map(tools.map((t) => [t.id, t]));
  return { generate, resolveTool: (id) => byId.get(id) };
}

function makePrior(count: number, charsPer = 3000): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `prior-${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as SessionMessage['role'],
    content: 'x'.repeat(charsPer),
    createdAt: i + 1,
  }));
}

describe('makeAgentLoop 溢出重试（CR-004，08-25 BMad CR）', () => {
  it('generate 抛溢出标记错误 → 对话段 hardCut 一次 + 摘要对重注入 + 重试成功', async () => {
    const tool = makeFakeTool('query_story');
    const mainCalls: SessionMessage[][] = [];
    const generate = vi.fn<GenerateFn>(async (msgs, _system, tools) => {
      if (tools.length === 0) return { content: 'gate summary', finishReason: 'stop' };
      mainCalls.push([...msgs]);
      if (mainCalls.length === 1) {
        // 报文声明小窗 1000 tokens → hardCut 预算用提取值（摘要预算 875 chars）。
        throw overflowError(
          "This model's maximum context length is 1000 tokens. However, you requested 5000 tokens.",
        );
      }
      return { content: '调查完毕 <BRIEF_DONE>', finishReason: 'stop' };
    });

    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());
    const result = await run({ userPrompt: '开始自查', priorMessages: makePrior(10) });

    expect(result.status).toBe('stopped');
    expect(result.content).toContain('<BRIEF_DONE>');
    // 恰两次 generate：初试（溢出）+ hardCut 后重试一次；pre-gate 缺省 1M 未触发（零摘要调用）。
    expect(generate).toHaveBeenCalledTimes(2);

    // 重试消息 = stablePrefix(1) + 摘要对(2) + hardCut 保尾 2 = 5；前缀逐字节保留。
    const retry = mainCalls[1];
    expect(retry).toHaveLength(5);
    expect(retry[0].id).toBe('prefix-1');
    expect(retry[1].content).toContain('<history_summary');
    // 小窗预算生效：被压 8 条 × 3000 chars join ≫ 875 chars → 截断标记进摘要。
    expect(retry[1].content).toContain('硬截断摘要中段省略');
    expect(retry[2].role).toBe('assistant'); // 摘要确认对
  });

  it('重试仍溢出 → 原样上抛（仅一次重试，不无限压缩）', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>(async (_msgs, _system, tools) => {
      if (tools.length === 0) return { content: 'gate summary', finishReason: 'stop' };
      throw overflowError('maximum context length is 100 tokens, however you requested 5000');
    });

    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());
    await expect(
      run({ userPrompt: '开始自查', priorMessages: makePrior(10) }),
    ).rejects.toMatchObject({ name: 'ProtocolContextOverflowError' });
    expect(generate).toHaveBeenCalledTimes(2); // 初试 + hardCut 后重试一次，仅此而已
  });

  it('非溢出错误直接上抛（不走 hardCut 重试，错误语义不变）', async () => {
    const tool = makeFakeTool('query_story');
    const plain = new Error('invalid request: unknown parameter');
    const generate = vi.fn<GenerateFn>(async (_msgs, _system, tools) => {
      if (tools.length === 0) return { content: 'gate summary', finishReason: 'stop' };
      throw plain;
    });

    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());
    await expect(
      run({ userPrompt: '开始自查', priorMessages: makePrior(10) }),
    ).rejects.toBe(plain);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('CR-008：deps.modelRef 指向 required 档（deepseek-v4）→ 溢出 hardCut 保底区段 6', async () => {
    const tool = makeFakeTool('query_story');
    const mainCalls: SessionMessage[][] = [];
    const generate = vi.fn<GenerateFn>(async (msgs, _system, tools) => {
      if (tools.length === 0) return { content: 'gate summary', finishReason: 'stop' };
      mainCalls.push([...msgs]);
      if (mainCalls.length === 1) {
        throw overflowError('maximum context length is 1000 tokens, however you requested 5000');
      }
      return { content: '调查完毕 <BRIEF_DONE>', finishReason: 'stop' };
    });

    const run = makeAgentLoop(
      { generate, resolveTool: (id) => (id === 'query_story' ? tool : undefined), modelRef: { keyId: 'k1', modelId: 'deepseek-v4-pro' } },
      makeConfig(),
    );
    // 12 条 prior：非 required 保尾 2，required（deepseek-v4 reasoningRoundTrip='required'）
    // → 保底区段 6。重试消息 = prefix(1) + 摘要对(2) + 6 = 9。
    await run({ userPrompt: '开始自查', priorMessages: makePrior(12) });

    expect(mainCalls[1]).toHaveLength(9);
  });
});

describe('estimateSummaryPairTokens（CR-018 摘要对开销同源估算）', () => {
  it('正的固定开销（wrapper + 确认消息 + framing）且随摘要规模增长', () => {
    const empty = estimateSummaryPairTokens(undefined);
    const withSummary = estimateSummaryPairTokens('x'.repeat(3500)); // ≈ 1000 tokens
    expect(empty).toBeGreaterThan(0);
    expect(withSummary).toBeGreaterThan(empty + 900);
    // 空摘要时也计 wrapper/确认/framing——首次注入前 targetTokens 同样扣减。
    expect(estimateSummaryPairTokens('')).toBe(empty);
  });
});
