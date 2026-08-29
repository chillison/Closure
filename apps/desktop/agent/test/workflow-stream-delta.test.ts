import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildStreamEvent, RuntimeStreamEvent } from '../src/types';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 2（design §3.1）：workflow 装配层的 delta 接线——
//   1. leader streamMessage：generate 包装器透传 onDelta → shell 缝流式路径；delta 事件
//      （type:'delta'）先于终帧 assistant 事件且同 messageId；assistant 事件透传 reasoning；
//   2. leader abort：loop 部分落盘的 aborted_partial 消息经既有 onMessage 管线补发 assistant
//      事件（带 kind，在 done 事件前）+ JSONL 落盘（重载后不消失，§3.3）；
//   3. 子 agent（runSubagent → runChildAgent / runAgentWithExplicitSystem → yaml 契约派发）：
//      delta 经 emitChildEvent 以 child 包装（source/role/sessionId/depth）冒泡，内事件
//      type:'delta'，messageId 与 child 终帧 assistant 事件同 id；
//   4. sendMessage 车道不开流（禁忌回归钉：generate opts 无 onDelta）。
// runLoop 纯逻辑（缓冲/id/部分落盘分流）见 loop.streaming.test.ts。
// ─────────────────────────────────────────────────────────────────────────────

type ProviderGenerate = typeof import('../src/provider/ipc-provider').generate;

describe('workflow stream delta 接线（dogfood T1 Stage 2）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-stream-delta-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('leader streamMessage：delta 事件先于终帧 assistant 事件且同 id；assistant 事件透传 reasoning', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const events: RuntimeStreamEvent[] = [];
    const generate = vi.fn<ProviderGenerate>(async (_messages, _system, _tools, _abortSignal, opts) => {
      opts?.onDelta?.({ type: 'reasoning', delta: '思' });
      opts?.onDelta?.({ type: 'text', delta: '正' });
      return { content: '正文', finishReason: 'stop', reasoning: '思' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    await runtime.streamMessage({
      sessionId: session.id,
      content: '写点什么',
      abortSignal: new AbortController().signal,
      sendEvent: (event) => events.push(event),
    });

    const deltaEvents = events.filter((e) => e.type === 'delta');
    expect(deltaEvents).toHaveLength(2);
    expect(deltaEvents.map((e) => (e as { data: { channel: string; delta: string } }).data))
      .toEqual([
        { messageId: expect.any(String), channel: 'reasoning', delta: '思' },
        { messageId: expect.any(String), channel: 'text', delta: '正' },
      ]);

    const assistantEvent = events.find((e) => e.type === 'assistant') as
      | { data: { id: string; content: string; reasoning?: string } }
      | undefined;
    expect(assistantEvent?.data.content).toBe('正文');
    expect(assistantEvent?.data.reasoning).toBe('思');
    // id 稳定性：终帧 assistant 事件 id == delta messageId（占位→终帧替换无漂移）。
    expect(assistantEvent?.data.id).toBe((deltaEvents[0] as { data: { messageId: string } }).data.messageId);
    // delta 先于终帧（流式时序）。
    expect(events.findIndex((e) => e.type === 'delta'))
      .toBeLessThan(events.findIndex((e) => e.type === 'assistant'));
    // 终态消息 reasoning 落 session（持久化 additive）。
    const persisted = runtime.getSession(session.id)!.messages.find((m) => m.role === 'assistant');
    expect(persisted?.reasoning).toBe('思');
  });

  it('leader abort：已流出部分经 onMessage 管线补发 assistant 事件（kind:aborted_partial，done 前）+ JSONL 落盘', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { loadMessagesFromFile } = await import('../src/agent/persistence');
    const events: RuntimeStreamEvent[] = [];
    const controller = new AbortController();
    const generate = vi.fn<ProviderGenerate>(async (_messages, _system, _tools, _abortSignal, opts) => {
      opts?.onDelta?.({ type: 'text', delta: '写了半段' });
      controller.abort(new DOMException('Aborted', 'AbortError'));
      throw new DOMException('Aborted', 'AbortError');
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    await expect(runtime.streamMessage({
      sessionId: session.id,
      content: '长生成',
      abortSignal: controller.signal,
      sendEvent: (event) => events.push(event),
    })).rejects.toMatchObject({ name: 'AbortError' });

    const assistantIdx = events.findIndex((e) => e.type === 'assistant');
    const doneIdx = events.findIndex((e) => e.type === 'done');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    // §3.3：补发的 assistant 事件在 done 事件前，带 kind（UI 直出跳过打字机）。
    expect(assistantIdx).toBeLessThan(doneIdx);
    const assistantEvent = events[assistantIdx] as { data: { kind?: string; content: string } };
    expect(assistantEvent.data.kind).toBe('aborted_partial');
    expect(assistantEvent.data.content).toBe('写了半段');

    // 落盘管线：JSONL 有 aborted_partial（重载后不消失）。
    const persisted = loadMessagesFromFile(projectPath, session.id);
    const partial = persisted.find((m) => m.kind === 'aborted_partial');
    expect(partial?.content).toBe('写了半段');
  });

  it('子 agent runSubagent（runChildAgent 构造点）：delta 以 child 包装冒泡，终帧 assistant 内事件同 id', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn<ProviderGenerate>(async (_messages, _system, _tools, _abortSignal, opts) => {
      opts?.onDelta?.({ type: 'text', delta: '子任务产出' });
      return { content: '子任务完成', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const childEvents: ChildStreamEvent[] = [];
    const result = await runtime.runSubagent(session.id, 'researcher', '查资料', {
      emitChildEvent: (e) => childEvents.push(e),
    });
    expect(result.content).toBe('子任务完成');

    const deltaEvents = childEvents.filter((e) => e.event.type === 'delta');
    expect(deltaEvents).toHaveLength(1);
    const delta = deltaEvents[0];
    expect(delta.source).toBe('subagent');
    expect(delta.role).toBe('researcher');
    expect(delta.depth).toBe(1);
    expect((delta.event as { data: { channel: string; delta: string } }).data).toMatchObject({
      channel: 'text',
      delta: '子任务产出',
    });

    // id 稳定性：child 终帧 assistant 内事件 id == delta messageId，且 sessionId 一致。
    const assistantEvents = childEvents.filter((e) => e.event.type === 'assistant');
    expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
    const finalChild = assistantEvents[assistantEvents.length - 1];
    expect((finalChild.event as { data: { id: string } }).data.id)
      .toBe((delta.event as { data: { messageId: string } }).data.messageId);
    expect(finalChild.sessionId).toBe(delta.sessionId);
  });

  it('yaml 契约派发（runAgentWithExplicitSystem 构造点）：delta 冒泡同款包装', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn<ProviderGenerate>(async (_messages, _system, _tools, _abortSignal, opts) => {
      opts?.onDelta?.({ type: 'reasoning', delta: '裁决思考' });
      return { content: '裁决完成', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const childEvents: ChildStreamEvent[] = [];
    const result = await runtime.runAgentWithExplicitSystem(session.id, 'adjudicator-agent', { question: '正文与计划哪个更好' }, {
      emitChildEvent: (e) => childEvents.push(e),
      allowedTools: [],
    });
    expect(result.content).toBe('裁决完成');

    const deltaEvents = childEvents.filter((e) => e.event.type === 'delta');
    expect(deltaEvents).toHaveLength(1);
    expect(deltaEvents[0].source).toBe('subagent');
    expect(deltaEvents[0].role).toBe('adjudicator-agent');
    expect((deltaEvents[0].event as { data: { channel: string; delta: string } }).data).toMatchObject({
      channel: 'reasoning',
      delta: '裁决思考',
    });
    // 终帧同 id。
    const assistantEvents = childEvents.filter((e) => e.event.type === 'assistant');
    expect((assistantEvents[assistantEvents.length - 1].event as { data: { id: string } }).data.id)
      .toBe((deltaEvents[0].event as { data: { messageId: string } }).data.messageId);
  });

  // BMad CR-T1-017：child 通道 assistant 终帧透传 kind——aborted_partial 在子 agent 面可辨
  //（S5 给 reasoning 修过同型缺口，kind 漏修；PRD AC「标记可辨」无车道限定）。
  it('child 中途 abort（已流 delta）→ 终帧 assistant 内事件带 kind:aborted_partial（含部分正文）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const controller = new AbortController();
    const generate = vi.fn<ProviderGenerate>(async (_messages, _system, _tools, _abortSignal, opts) => {
      opts?.onDelta?.({ type: 'text', delta: '子任务半途' });
      const err = new DOMException('Aborted', 'AbortError');
      controller.abort(err);
      throw err;
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const childEvents: ChildStreamEvent[] = [];
    await expect(runtime.runSubagent(session.id, 'researcher', '查资料', {
      emitChildEvent: (e) => childEvents.push(e),
    })).rejects.toMatchObject({ name: 'AbortError' });

    const assistantEvents = childEvents.filter((e) => e.event.type === 'assistant');
    const partial = assistantEvents.find(
      (e) => (e.event as { data: { kind?: string } }).data.kind === 'aborted_partial',
    );
    expect(partial).toBeDefined(); // 修前：child 终帧不带 kind——子 agent 面无法辨部分落盘标记
    expect((partial!.event as { data: { content: string } }).data.content).toBe('子任务半途');
    // 分组元数据同款（source/role）。
    expect(partial!.source).toBe('subagent');
    expect(partial!.role).toBe('researcher');
  });

  it('sendMessage 车道不开流（禁忌回归钉）：generate opts 无 onDelta', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn<ProviderGenerate>(async (_messages, _system, _tools, _abortSignal, opts) => {
      // sendMessage 无 delta 消费者，缝 opts 不带 onDelta（非流式零回归）。
      expect(opts?.onDelta).toBeUndefined();
      return { content: 'ok', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    await runtime.sendMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
    });

    expect(generate).toHaveBeenCalled();
  });

  // ── dogfood 第二轮 findings #3（子 agent 派发起点零信号）─────────────────────
  // child runLoop 启动前发一次 started 起点事件（三装配点：runChildAgent /
  // runChildAgentWithExplicitSystem / skill executor executePrompt）——派发到首批
  // LLM 输出之间（慢首字节端点可达分钟级）此前零事件，UI 全空窗被误判卡死。
  it('runSubagent：started 先于一切 child 事件（每派发恰一次，同款分组元数据）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: '子任务完成', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const childEvents: ChildStreamEvent[] = [];
    await runtime.runSubagent(session.id, 'researcher', '查资料', {
      emitChildEvent: (e) => childEvents.push(e),
    });

    const startedEvents = childEvents.filter((e) => e.event.type === 'started');
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({
      source: 'subagent',
      role: 'researcher',
      depth: 1,
      event: { type: 'started', data: {} },
    });
    expect(startedEvents[0].sessionId).toEqual(expect.any(String));
    // 起点先于首批输出（assistant 终帧 / delta）——空窗期 UI 已有信号。
    expect(childEvents.findIndex((e) => e.event.type === 'started')).toBe(0);
  });

  it('yaml 契约派发（runAgentWithExplicitSystem）：started 同款先发（planners/researcher 族全走本装配点）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: '裁决完成', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const childEvents: ChildStreamEvent[] = [];
    await runtime.runAgentWithExplicitSystem(session.id, 'adjudicator-agent', { question: '哪个更好' }, {
      emitChildEvent: (e) => childEvents.push(e),
      allowedTools: [],
    });

    const startedEvents = childEvents.filter((e) => e.event.type === 'started');
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({
      source: 'subagent',
      role: 'adjudicator-agent',
      depth: 1,
      event: { type: 'started', data: {} },
    });
    expect(childEvents[0].event.type).toBe('started');
  });

  it('skill executor（executePrompt 装配点）：started 以 source:skill 冒泡', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { SkillRegistry } = await import('../src/skill/runtime/registry');
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: '技能产出', finishReason: 'stop' }));
    const skillRegistry = new SkillRegistry();
    skillRegistry.register({
      format: 'manifest',
      name: 'story-setup',
      description: 'Prepare the story context',
      location: 'I:/skills/story-setup',
      entryPath: 'I:/skills/story-setup/skill.json',
      prompt: 'Prepare the story context.',
      workflowMode: 'workflow',
      assets: { references: [], scripts: [] },
      compiledPlan: {
        entryNodeId: 'instruction',
        nodes: [
          { id: 'instruction', type: 'instruction', content: '先收集设定。' },
          { id: 'finish', type: 'finish' },
        ],
        edges: [],
      },
    });
    const runtime = createWorkflowRuntime({ generate, skillRegistry });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const childEvents: ChildStreamEvent[] = [];
    await runtime.executeSkill('story-setup', {
      sessionId: session.id,
      emitChildEvent: (e) => childEvents.push(e),
    });

    const startedEvents = childEvents.filter((e) => e.event.type === 'started');
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({
      source: 'skill',
      role: 'story-setup',
      event: { type: 'started', data: {} },
    });
    expect(childEvents.findIndex((e) => e.event.type === 'started')).toBe(0);
  });
});
