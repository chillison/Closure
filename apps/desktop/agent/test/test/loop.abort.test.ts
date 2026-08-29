import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runLoop } from '../src/agent/loop';
import type { SessionMessage, ToolCall, ToolDefinition } from '../src/types';

/**
 * Regression: stopping a run after the assistant emitted tool_calls but before
 * the tools execute must NOT leave the assistant turn with unmatched tool_calls.
 * Otherwise the next request fails with "Tool result is missing for tool call".
 */
describe('runLoop abort pairing', () => {
  const echoTool: ToolDefinition = {
    id: 'echo',
    description: 'echo',
    parameters: z.object({}),
    execute: async () => ({ title: 'echo', output: 'ran' }),
  };

  function toolCall(id: string): ToolCall {
    return { id, name: 'echo', arguments: '{}' };
  }

  it('synthesizes cancelled tool results for every pending call when aborted before execution', async () => {
    const controller = new AbortController();
    const collected: SessionMessage[] = [];

    await expect(
      runLoop({
        sessionId: 's1',
        projectPath: '.',
        messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: Date.now() }],
        systemPrompt: 'sys',
        tools: [echoTool],
        maxSteps: 5,
        // Abort right after the assistant turn (with tool_calls) is produced,
        // mirroring a user pressing stop while tools are queued to run.
        generate: async () => {
          controller.abort(new DOMException('Aborted', 'AbortError'));
          return {
            content: 'calling tools',
            toolCalls: [toolCall('call_a'), toolCall('call_b')],
            finishReason: 'tool_calls',
          };
        },
        onMessage: (m) => collected.push(m),
        abort: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const assistant = collected.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls?.map((c) => c.id)).toEqual(['call_a', 'call_b']);

    // Every tool_call id must have a paired tool result, even though none ran.
    const resultIds = collected
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.toolResults ?? [])
      .map((r) => r.toolCallId);
    expect(resultIds).toEqual(['call_a', 'call_b']);
  });

  it('persists completed tool results when abort lands inside the tool execution window (dogfood R2 findings #4)', async () => {
    const controller = new AbortController();
    const collected: SessionMessage[] = [];

    // Abort fires while the tool is executing; the tool still completes gracefully
    // (dispatch-family degrade shape: a real result resolves out of Promise.all).
    const slowTool: ToolDefinition = {
      id: 'slow',
      description: 'slow',
      parameters: z.object({}),
      execute: async () => {
        controller.abort(new DOMException('Aborted', 'AbortError'));
        return { title: 'slow', output: 'degraded result' };
      },
    };

    let generateCalls = 0;
    await expect(
      runLoop({
        sessionId: 's3',
        projectPath: '.',
        messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: Date.now() }],
        systemPrompt: 'sys',
        tools: [slowTool],
        maxSteps: 5,
        generate: async () => {
          generateCalls++;
          return {
            content: 'calling tools',
            toolCalls: [{ id: 'call_w', name: 'slow', arguments: '{}' }],
            finishReason: 'tool_calls',
          };
        },
        onMessage: (m) => collected.push(m),
        abort: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Run must terminate on the abort (no second generate round).
    expect(generateCalls).toBe(1);

    // The completed tool result must be persisted (paired with the assistant
    // tool_call turn), not discarded — otherwise the session is left with a
    // dangling toolCall that poisons every later request
    // (ai-sdk AI_MissingToolResultsError).
    const toolMsg = collected.find((m) => m.role === 'tool');
    expect(toolMsg?.toolResults?.[0]).toMatchObject({ toolCallId: 'call_w', output: 'degraded result' });

    const assistant = collected.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls?.map((c) => c.id)).toEqual(['call_w']);
  });

  it('runs tools and pairs real results when not aborted', async () => {
    const collected: SessionMessage[] = [];
    let calls = 0;

    await runLoop({
      sessionId: 's2',
      projectPath: '.',
      messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [echoTool],
      maxSteps: 5,
      generate: async () => {
        calls++;
        if (calls === 1) {
          return { content: 'calling', toolCalls: [toolCall('call_a')], finishReason: 'tool_calls' };
        }
        return { content: 'done', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
    });

    const toolMsg = collected.find((m) => m.role === 'tool');
    expect(toolMsg?.toolResults?.[0]).toMatchObject({ toolCallId: 'call_a', output: 'ran' });
  });
});
