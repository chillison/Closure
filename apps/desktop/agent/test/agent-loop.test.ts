import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  makeAgentLoop,
  ToolLoopFuseError,
  AGENT_LOOP_DEFAULT_MAX_CONSECUTIVE_ERROR_ROUNDS,
  type AgentLoopConfig,
  type AgentLoopDeps,
  type AgentLoopResult,
} from '../src/nodes/agent-loop';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { GenerateResult } from '../src/provider/ipc-provider';
import type { ToolDefinition } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4 Step 1（design §1.1 形态 c / §1.6）：makeAgentLoop 节点内工具循环。
// generate / resolveTool 全注入 fake（mirror llm-node.test.ts 注入模式）。覆盖：
// 正常收束 / 稳定前缀 + 工具回填 / 续阶段 priorMessages / 畸形参数容错（lastBrace 兜底 +
// 彻底失败回错）/ 未知工具回错 / 连续错误中断（+ 成功轮清零）/ 轮数熔断（tool_loop_fuse）/
// turn_end / 缺工具响亮报错 / stopMarker 同轮携工具调用先配对再收束。
// ─────────────────────────────────────────────────────────────────────────────

/** 造 fake 工具（execute spy + zod parameters——mirror builtin 工具形态）。 */
function makeFakeTool(id: string, execute?: ToolDefinition['execute']): ToolDefinition {
  return {
    id,
    description: `fake tool ${id}`,
    parameters: z.object({ q: z.string().optional() }),
    execute:
      execute ??
      vi.fn(async () => ({ title: id, output: `${id} ok` })),
  };
}

/** 造只含一个工具的 deps（resolveTool fake，绕开 builtin registry）。 */
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

/** 带工具调用的 generate 响应。 */
function toolCallRound(calls: Array<{ id: string; name: string; arguments: string }>): GenerateResult {
  return { content: '', toolCalls: calls, finishReason: 'tool_calls' };
}

/** 文本收束响应。 */
function textRound(content: string): GenerateResult {
  return { content, finishReason: 'stop' };
}

describe('makeAgentLoop — 正常收束', () => {
  it('查询轮工具调用 → 回填 → 收束轮含 stopMarker → status=stopped + content', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: '{"q":"林昭"}' }]))
      .mockResolvedValueOnce(textRound('调查完毕，简报如下 <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    const result = await run({ userPrompt: '开始自查' });

    expect(result.status).toBe('stopped');
    expect(result.content).toContain('<BRIEF_DONE>');
    expect(result.rounds).toBe(2);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('result.messages 只含本循环新增消息（user 指令 + assistant + tool），不含 stablePrefix', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: '{}' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    const result = await run({ userPrompt: '开始自查' });

    expect(result.messages).toHaveLength(4); // user + assistant(toolCalls) + tool + 收束 assistant
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toBe('开始自查');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].toolCalls).toHaveLength(1);
    expect(result.messages[2].role).toBe('tool');
    expect(result.messages[3].role).toBe('assistant');
    expect(result.messages[3].content).toContain('<BRIEF_DONE>');
    expect(result.messages.some((m) => m.content === '任务卡+设定前缀')).toBe(false);
  });
});

describe('makeAgentLoop — 稳定前缀与消息序（design §1.2 约定）', () => {
  it('每轮 generate 收到的消息 = stablePrefix → user 指令 → 各轮 assistant/tool（前缀恒在头）', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: '{}' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    await run({ userPrompt: '开始自查' });

    const round1 = generate.mock.calls[0][0];
    expect(round1[0].content).toBe('任务卡+设定前缀'); // 前缀在头
    expect(round1[1].content).toBe('开始自查');

    const round2 = generate.mock.calls[1][0];
    expect(round2[0].content).toBe('任务卡+设定前缀'); // 第二轮前缀逐字节不变（缓存友好）
    expect(round2[1].content).toBe('开始自查');
    expect(round2[2].role).toBe('assistant');
    expect(round2[3].role).toBe('tool');
  });

  it('system 每轮恒定 = config.systemPrompt；tools = 解析出的 ToolDefinition 列表', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: '{}' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    await run({ userPrompt: '开始自查' });

    expect(generate.mock.calls[0][1]).toBe('SYS_PROMPT');
    expect(generate.mock.calls[1][1]).toBe('SYS_PROMPT');
    expect(generate.mock.calls[0][2]).toEqual([tool]);
  });

  it('续阶段：priorMessages 追加在前缀之后（阶段二复用阶段一产出，前缀不重复）', async () => {
    const tool = makeFakeTool('query_story');
    const stage1 = vi.fn<GenerateFn>().mockResolvedValueOnce(textRound('第一阶段产物'));
    const run1 = makeAgentLoop(makeDeps(stage1, [tool]), makeConfig());
    const r1 = await run1({ userPrompt: '阶段一指令' });

    const stage2 = vi.fn<GenerateFn>().mockResolvedValueOnce(textRound('正文 <PROSE_DONE>'));
    const run2 = makeAgentLoop(makeDeps(stage2, [tool]), makeConfig({ stopMarkers: ['<PROSE_DONE>'] }));
    const r2 = await run2({ userPrompt: '许可回执，开始写作', priorMessages: r1.messages });

    expect(r2.status).toBe('stopped');
    const round1 = stage2.mock.calls[0][0];
    expect(round1[0].content).toBe('任务卡+设定前缀'); // stablePrefix 恒定重携（两阶段同一份）
    expect(round1[1].content).toBe('阶段一指令'); // priorMessages[0]（阶段一 user 指令）
    expect(round1[2].content).toBe('第一阶段产物'); // priorMessages[1]（阶段一收束 assistant）
    expect(round1[3].content).toBe('许可回执，开始写作'); // 本阶段 user 指令追加在后
  });

  it('deps.modelRef 透传 generate opts', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>().mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const deps = { ...makeDeps(generate, [tool]), modelRef: { keyId: 'k', modelId: 'm' } };
    const run = makeAgentLoop(deps, makeConfig());

    await run({ userPrompt: 'go' });

    expect(generate.mock.calls[0][4]).toEqual({ modelRef: { keyId: 'k', modelId: 'm' } });
  });
});

describe('makeAgentLoop — 工具调用回填', () => {
  it('工具以解析后的参数执行；tool 消息 toolResults 带 toolCallId/toolName/output', async () => {
    const execute = vi.fn(async () => ({ title: 'q', output: '查询结果：林昭，第 3 章出场' }));
    const tool = makeFakeTool('query_story', execute);
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'call_9', name: 'query_story', arguments: '{"q":"林昭"}' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    const result = await run({ userPrompt: '查' });

    expect(execute).toHaveBeenCalledWith({ q: '林昭' }, expect.objectContaining({ projectPath: '/proj' }));
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.toolResults?.[0]).toEqual({
      toolCallId: 'call_9',
      toolName: 'query_story',
      output: '查询结果：林昭，第 3 章出场',
    });
    // 修正回写：call.arguments 被规范成合法 JSON（防毒历史）
    const assistantMsg = result.messages.find((m) => m.role === 'assistant');
    expect(JSON.parse(assistantMsg!.toolCalls![0].arguments)).toEqual({ q: '林昭' });
  });

  it('execute 抛错 → Error 消息回填，循环不崩并继续', async () => {
    const tool = makeFakeTool('query_story', vi.fn(async () => { throw new Error('db down'); }));
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: '{}' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    const result = await run({ userPrompt: '查' });

    expect(result.status).toBe('stopped');
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('Error: db down');
  });
});

describe('makeAgentLoop — 畸形参数容错（mirror runLoop 兜底链）', () => {
  it('DashScope/Qwen 形态 "{}{...}"：lastBrace 兜底截取后以合法对象执行', async () => {
    const execute = vi.fn(async () => ({ title: 'q', output: 'ok' }));
    const tool = makeFakeTool('query_story', execute);
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: '{}{"q":"当铺"}' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    await run({ userPrompt: '查' });

    expect(execute).toHaveBeenCalledWith({ q: '当铺' }, expect.anything());
  });

  it('参数被嵌套成 JSON 字符串：解包后执行', async () => {
    const execute = vi.fn(async () => ({ title: 'q', output: 'ok' }));
    const tool = makeFakeTool('query_story', execute);
    // 整个 arguments 是一个合法 JSON 字符串，内容才是参数对象（runLoop 同款兼容形态）：
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: '"{\\"q\\":\\"剑\\"}"' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    await run({ userPrompt: '查' });

    expect(execute).toHaveBeenCalledWith({ q: '剑' }, expect.anything());
  });

  it('彻底无法解析（非 JSON）→ Error 消息回填不执行，循环继续不崩', async () => {
    const execute = vi.fn(async () => ({ title: 'q', output: 'ok' }));
    const tool = makeFakeTool('query_story', execute);
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: 'not json at all' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    const result = await run({ userPrompt: '查' });

    expect(execute).not.toHaveBeenCalled();
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('Error: malformed arguments');
    expect(toolMsg?.content).toContain('not json at all');
    expect(result.status).toBe('stopped');
  });

  // ── R2-盲6（2026-08-19）：lastBrace>0 守卫漏「首字符即 { + 尾垃圾」可恢复形态 ──

  it('R2-盲6：首字符即 { + 尾垃圾（\'{"q":"x"} trailing\'，lastIndexOf(\'{\')===0）→ 提取成功不报错', async () => {
    const execute = vi.fn(async () => ({ title: 'q', output: 'ok' }));
    const tool = makeFakeTool('query_story', execute);
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: '{"q":"x"} trailing' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    await run({ userPrompt: '查' });

    // 修复前：lastBrace=0 不满足 >0 → 兜底跳过 → malformed Error（三轮连错触发 consecutive_errors 风险）。
    expect(execute).toHaveBeenCalledWith({ q: 'x' }, expect.anything());
  });

  it('R2-盲6：前导文字 + 嵌套对象（\'前缀 {"outer":{"q":"剑"}}\'）→ 提取完整外层对象（extractJson 主策略）', async () => {
    const execute = vi.fn(async () => ({ title: 'q', output: 'ok' }));
    const tool = makeFakeTool('query_story', execute);
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'query_story', arguments: '前缀 {"outer":{"q":"剑"}} 尾' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    await run({ userPrompt: '查' });

    expect(execute).toHaveBeenCalledWith({ outer: { q: '剑' } }, expect.anything());
  });
});

describe('makeAgentLoop — 未知工具回错', () => {
  it('工具 id 不在 config 工具集 → Error: tool not found 消息回填', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound([{ id: 'c1', name: 'write_file', arguments: '{}' }]))
      .mockResolvedValueOnce(textRound('done <BRIEF_DONE>'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    const result = await run({ userPrompt: '查' });

    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('Error: tool "write_file" not found');
    expect(result.status).toBe('stopped');
  });
});

describe('makeAgentLoop — 连续错误中断（mirror runLoop MAX_CONSECUTIVE_TOOL_ERRORS）', () => {
  it('连续 3 轮全部工具错误 → status=consecutive_errors 中断', async () => {
    const tool = makeFakeTool('query_story', vi.fn(async () => { throw new Error('boom'); }));
    const errRound = () => toolCallRound([{ id: 'c', name: 'query_story', arguments: '{}' }]);
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(errRound())
      .mockResolvedValueOnce(errRound())
      .mockResolvedValueOnce(errRound())
      .mockResolvedValueOnce(textRound('不应到达'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig({ maxRounds: 10 }));

    const result = await run({ userPrompt: '查' });

    expect(result.status).toBe('consecutive_errors');
    expect(generate).toHaveBeenCalledTimes(3);
    expect(AGENT_LOOP_DEFAULT_MAX_CONSECUTIVE_ERROR_ROUNDS).toBe(3);
  });

  it('中间有成功轮 → 计数清零（须再连续 3 轮全错才中断）', async () => {
    const tool = makeFakeTool('query_story');
    const badCall = () => toolCallRound([{ id: 'c', name: 'nope', arguments: '{}' }]);
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(badCall())        // 错 1
      .mockResolvedValueOnce(badCall())        // 错 2
      .mockResolvedValueOnce(toolCallRound([{ id: 'c2', name: 'query_story', arguments: '{}' }])) // 成功 → 清零
      .mockResolvedValueOnce(badCall())        // 错 1（重新计）
      .mockResolvedValueOnce(badCall())        // 错 2
      .mockResolvedValueOnce(badCall())        // 错 3 → 中断
      .mockResolvedValueOnce(textRound('不应到达'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig({ maxRounds: 20 }));

    const result = await run({ userPrompt: '查' });

    expect(result.status).toBe('consecutive_errors');
    expect(generate).toHaveBeenCalledTimes(6);
  });

  it('阈值可参数化（maxConsecutiveErrorRounds=2）', async () => {
    const tool = makeFakeTool('query_story');
    const badCall = () => toolCallRound([{ id: 'c', name: 'nope', arguments: '{}' }]);
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce(badCall())
      .mockResolvedValueOnce(badCall());
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig({ maxConsecutiveErrorRounds: 2 }));

    const result = await run({ userPrompt: '查' });

    expect(result.status).toBe('consecutive_errors');
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe('makeAgentLoop — 轮数熔断（tool_loop_fuse，design §1.6 A9）', () => {
  it('超限抛 ToolLoopFuseError，message 含 tool_loop_fuse；generate 恰好跑满 maxRounds 次', async () => {
    const tool = makeFakeTool('query_story');
    const gen = vi.fn<GenerateFn>().mockImplementation(async () =>
      toolCallRound([{ id: 'c', name: 'query_story', arguments: '{}' }]),
    );
    const run = makeAgentLoop(makeDeps(gen, [tool]), makeConfig({ maxRounds: 3 }));

    await expect(run({ userPrompt: '查' })).rejects.toThrow(ToolLoopFuseError);
    await expect(run({ userPrompt: '查' })).rejects.toThrow(/tool_loop_fuse/);
    // 每次 run 恰好 maxRounds 轮后熔断（两次 run 共 6 次 generate）
    expect(gen).toHaveBeenCalledTimes(6);
  });

  it('熔断错误 message 携带 maxRounds 数值（RunSnapshot 记 reason 用）', () => {
    expect(new ToolLoopFuseError(50).message).toContain('maxRounds=50');
    expect(new ToolLoopFuseError(50).name).toBe('ToolLoopFuseError');
  });

  it('maxRounds 非法（0 / 负数 / 非整数）→ 配置错误响亮拒绝', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>().mockResolvedValue(textRound('x'));
    for (const bad of [0, -1, 1.5]) {
      const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig({ maxRounds: bad }));
      await expect(run({ userPrompt: 'x' })).rejects.toThrow(/maxRounds/);
    }
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('makeAgentLoop — 回合自然结束（无标记）', () => {
  it('无工具调用且未含 stopMarker → status=turn_end（产物裁决归 caller）', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>().mockResolvedValueOnce(textRound('简报 JSON 但没写收束标记'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    const result: AgentLoopResult = await run({ userPrompt: '查' });

    expect(result.status).toBe('turn_end');
    expect(result.content).toContain('简报');
    expect(result.rounds).toBe(1);
  });

  it('stopMarker 同轮携带工具调用 → 先回填工具结果（配对完整）再收束', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce({
        content: '先查一下再收尾 <BRIEF_DONE>',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{}' }],
        finishReason: 'tool_calls',
      });
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig());

    const result = await run({ userPrompt: '查' });

    expect(result.status).toBe('stopped');
    expect(result.messages).toHaveLength(3); // user + assistant + tool（无 dangling toolCalls）
    expect(result.messages[2].role).toBe('tool');
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });
});

describe('makeAgentLoop — 工具集解析（接线防线）', () => {
  it('config.toolIds 解析不到 → 响亮报错列出缺失 id，零 generate', async () => {
    const tool = makeFakeTool('query_story');
    const generate = vi.fn<GenerateFn>().mockResolvedValue(textRound('x'));
    const run = makeAgentLoop(makeDeps(generate, [tool]), makeConfig({ toolIds: ['query_story', 'ghost_tool'] }));

    await expect(run({ userPrompt: 'x' })).rejects.toThrow(/ghost_tool/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('空工具集合法（纯生成收束——资料员核实若无工具调用需求时可用）', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValueOnce(textRound('verdict <DONE>'));
    const run = makeAgentLoop(makeDeps(generate, []), makeConfig({ toolIds: [], stopMarkers: ['<DONE>'] }));

    const result = await run({ userPrompt: '核实' });

    expect(result.status).toBe('stopped');
    expect(generate.mock.calls[0][2]).toEqual([]);
  });
});
