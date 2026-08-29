import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// S4b（task 08-25 design §4.1）：leader 车道窗口/红线注入接线——sendMessage/streamMessage
// 装配处按当前指派模型 limits 现算 contextWindowTokens（resolveModelInfo 单源），红线经
// contextPolicy seam（setContextPolicyProvider，mirror setTaskSlotResolver）现读注入。
// 接线钉法：partial mock contextManager（透传真实 prepareContext + 捕获入参）——
// 「注入漏了」在 runLoop 深处表现为回落缺省（1M/95%），只有入参能钉住。
// ─────────────────────────────────────────────────────────────────────────────

const prepareContextSpy = vi.fn();

vi.mock('../src/context/contextManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/context/contextManager')>();
  return {
    ...actual,
    prepareContext: (input: Parameters<typeof actual.prepareContext>[0]) => {
      prepareContextSpy(input);
      return actual.prepareContext(input);
    },
  };
});

import { createWorkflowRuntime } from '../src/runtime/workflow';
import { setTaskSlotResolver } from '../src/runtime/taskModelRouting';
import { setContextPolicyProvider } from '../src/runtime/contextPolicy';

async function makeRuntime(generate: ReturnType<typeof vi.fn>, projectPath: string) {
  const runtime = createWorkflowRuntime({ generate });
  const session = runtime.createSession({ agentName: 'writer', projectPath });
  return { runtime, session };
}

describe('S4b 接线 — leader 车道窗口/红线注入（sendMessage 装配）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = `C:/test/leader-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    prepareContextSpy.mockClear();
  });

  afterEach(async () => {
    setTaskSlotResolver(undefined);
    setContextPolicyProvider(undefined);
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    vi.resetModules();
  });

  it('dialogue 档指 glm-5.1（registry limits 200K 窗口）+ 红线 80 → prepareContext 实收 204800 / 80', async () => {
    const generate = vi.fn(async (): Promise<{ content: string; finishReason: string }> => ({
      content: 'ok',
      finishReason: 'stop',
    }));
    const { runtime, session } = await makeRuntime(generate, projectPath);
    setTaskSlotResolver((slot) =>
      slot === 'dialogue'
        ? { keyId: 'wire', modelId: 'glm-5.1', thinking: 'high' as const }
        : undefined,
    );
    setContextPolicyProvider(() => ({ redlinePercent: 80 }));

    await runtime.sendMessage({ sessionId: session.id, content: 'hi', abortSignal: new AbortController().signal });

    expect(generate).toHaveBeenCalledTimes(1);
    // 窗口随模型 limits（resolveModelInfo('glm-5.1').limits.contextWindow = 204_800）。
    expect(prepareContextSpy).toHaveBeenCalled();
    const ctxInput = prepareContextSpy.mock.calls[0][0];
    expect(ctxInput.contextWindowTokens).toBe(204_800);
    expect(ctxInput.redlinePercent).toBe(80);
    // CR-008（08-25 BMad CR）：思考 kind 同链注入（registry 单源推导）——
    // prepareContext 消费 THINKING_PROFILES[kind].reasoningRoundTrip 驱动压缩保底区段。
    expect(ctxInput.thinkingKind).toBe('glm-dynamic-basic');
    // 思考策略同轮透传（assignment 整体随档）。
    expect(generate.mock.calls[0][4]?.thinking).toEqual({ level: 'high' });
  });

  it('空档（自动选择）+ 未注入红线 → prepareContext 入参两字段均 undefined（回落 1M / 95% 缺省）', async () => {
    const generate = vi.fn(async (): Promise<{ content: string; finishReason: string }> => ({
      content: 'ok',
      finishReason: 'stop',
    }));
    const { runtime, session } = await makeRuntime(generate, projectPath);

    await runtime.sendMessage({ sessionId: session.id, content: 'hi', abortSignal: new AbortController().signal });

    const ctxInput = prepareContextSpy.mock.calls[0][0];
    expect(ctxInput.contextWindowTokens).toBeUndefined();
    expect(ctxInput.redlinePercent).toBeUndefined();
    expect(ctxInput.thinkingKind).toBeUndefined(); // CR-008：空档无 kind 可推 → 不注入
  });

  it('未知模型（无 registry 条目）→ 无 limits 可查 → 窗口不注入（诚实回落 1M，不猜）', async () => {
    const generate = vi.fn(async (): Promise<{ content: string; finishReason: string }> => ({
      content: 'ok',
      finishReason: 'stop',
    }));
    const { runtime, session } = await makeRuntime(generate, projectPath);
    setTaskSlotResolver((slot) =>
      slot === 'dialogue' ? { keyId: 'wire', modelId: 'mystery-model' } : undefined,
    );

    await runtime.sendMessage({ sessionId: session.id, content: 'hi', abortSignal: new AbortController().signal });

    const ctxInput = prepareContextSpy.mock.calls[0][0];
    expect(ctxInput.contextWindowTokens).toBeUndefined();
    expect(ctxInput.thinkingKind).toBeUndefined(); // CR-008：未知模型无 kind → 不注入
  });
});

describe('S4b 接线 — streamMessage 车道同款注入', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = `C:/test/leader-ctx-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    prepareContextSpy.mockClear();
  });

  afterEach(async () => {
    setTaskSlotResolver(undefined);
    setContextPolicyProvider(undefined);
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    vi.resetModules();
  });

  it('streamMessage 装配同样注入窗口/红线（两车道对称）', async () => {
    const generate = vi.fn(async (): Promise<{ content: string; finishReason: string }> => ({
      content: 'ok',
      finishReason: 'stop',
    }));
    const { runtime, session } = await makeRuntime(generate, projectPath);
    setTaskSlotResolver((slot) =>
      slot === 'dialogue' ? { keyId: 'wire', modelId: 'glm-5.1' } : undefined,
    );
    setContextPolicyProvider(() => ({ redlinePercent: 60 }));

    const events: Array<{ type: string; data: SessionMessage | unknown }> = [];
    await runtime.streamMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
      sendEvent: (event) => events.push(event as { type: string; data: unknown }),
    });

    const ctxInput = prepareContextSpy.mock.calls[0][0];
    expect(ctxInput.contextWindowTokens).toBe(204_800);
    expect(ctxInput.redlinePercent).toBe(60);
  });

  it('CR-008：required 档模型（deepseek-v4）→ thinkingKind 注入（reasoningRoundTrip 消费面接通）', async () => {
    const generate = vi.fn(async (): Promise<{ content: string; finishReason: string }> => ({
      content: 'ok',
      finishReason: 'stop',
    }));
    const { runtime, session } = await makeRuntime(generate, projectPath);
    setTaskSlotResolver((slot) =>
      slot === 'dialogue' ? { keyId: 'wire', modelId: 'deepseek-v4-pro' } : undefined,
    );

    const events: Array<{ type: string; data: SessionMessage | unknown }> = [];
    await runtime.streamMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
      sendEvent: (event) => events.push(event as { type: string; data: unknown }),
    });

    const ctxInput = prepareContextSpy.mock.calls[0][0];
    expect(ctxInput.thinkingKind).toBe('deepseek-v4'); // THINKING_PROFILES 消费面（required 档）
  });
});
