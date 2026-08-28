import { describe, it, expect, vi } from 'vitest';
import { runLoop } from '../src/agent/loop';
import { appendToolDescriptions } from '../src/prompt/render';
import { estimateTokens, estimateMessagesTokens } from '../src/context/tokenEstimator';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// S4a（task 08-25 design §4.2）：校准环接线——runLoop 消费 generate 返回的
// usage.promptTokens，对「本请求实际发出的估算」（system + pinned + summary +
// messages，与 prepareContext 触发判定同一口径）跑 updateCalibrationRatio EMA
//（0.8 旧 + 0.2 观测，系数不动；此前零生产调用方——spec context-management.md:26
// 设计意图落地）。ipc-provider GenerateResult 尚未透出 usage（S4b 地盘），生产路径
// 待透出后自动激活；本测试以 mock generate 钉接收面行为。
// ─────────────────────────────────────────────────────────────────────────────

function makeMessages(): SessionMessage[] {
  return [
    { id: 'u1', role: 'user', content: 'x'.repeat(700), createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'y'.repeat(700), createdAt: 2 },
  ];
}

const SYSTEM_PROMPT = 'System';

describe('runLoop 校准环接线（S4a）', () => {
  it('generate 返回 usage.promptTokens → EMA 更新校准比并回调 onContextStateUpdate', async () => {
    const messages = makeMessages();
    // 估算口径 = 实际发出载荷（appendToolDescriptions 后的 system + messages）。
    const expectedEstimate =
      estimateTokens(appendToolDescriptions(SYSTEM_PROMPT, [])) + estimateMessagesTokens(messages);
    const actualPromptTokens = expectedEstimate * 2; // 实测是估算的 2 倍（低估场景）
    const expectedRatio = 1.0 * 0.8 + 2.0 * 0.2; // = 1.2

    const states: Array<{ tokenCalibrationRatio: number }> = [];
    await runLoop({
      sessionId: 's-cal',
      projectPath: '/test',
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 3,
      generate: vi.fn(async () => ({
        content: 'Response',
        toolCalls: undefined,
        finishReason: 'stop',
        usage: { promptTokens: actualPromptTokens },
      })),
      onMessage: () => {},
      abort: new AbortController().signal,
      onContextStateUpdate: (state) => states.push({ tokenCalibrationRatio: state.tokenCalibrationRatio }),
    });

    expect(actualPromptTokens).toBeGreaterThan(expectedEstimate); // 前置：确为低估
    expect(states).toHaveLength(1);
    expect(states[0].tokenCalibrationRatio).toBeCloseTo(expectedRatio, 8);
  });

  it('generate 不返回 usage → 校准不触发（零行为变化）', async () => {
    const states: Array<{ tokenCalibrationRatio: number }> = [];
    await runLoop({
      sessionId: 's-nocal',
      projectPath: '/test',
      messages: makeMessages(),
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 3,
      generate: vi.fn(async () => ({
        content: 'Response',
        toolCalls: undefined,
        finishReason: 'stop',
      })),
      onMessage: () => {},
      abort: new AbortController().signal,
      onContextStateUpdate: (state) => states.push({ tokenCalibrationRatio: state.tokenCalibrationRatio }),
    });

    // 无压缩 + 无 usage → onContextStateUpdate 零调用（校准比保持 1.0 缺省）。
    expect(states).toHaveLength(0);
  });

  it('usage.promptTokens 非正数/缺字段 → 不更新（updateCalibrationRatio 防御语义透传）', async () => {
    const states: Array<{ tokenCalibrationRatio: number }> = [];
    await runLoop({
      sessionId: 's-badusage',
      projectPath: '/test',
      messages: makeMessages(),
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 3,
      generate: vi.fn(async () => ({
        content: 'Response',
        toolCalls: undefined,
        finishReason: 'stop',
        usage: { promptTokens: 0 },
      })),
      onMessage: () => {},
      abort: new AbortController().signal,
      onContextStateUpdate: (state) => states.push({ tokenCalibrationRatio: state.tokenCalibrationRatio }),
    });

    expect(states).toHaveLength(0);
  });
});
