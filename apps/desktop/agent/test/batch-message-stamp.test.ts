import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 6：消息透传 batchId/batchKind——workflow streamMessage/sendMessage
// 路径给 assistant/tool 消息纯代码盖章（活跃批量存在时；非 LLM 自觉）。session 持久化（jsonl）
// 与流事件 data 同享盖章。
// ─────────────────────────────────────────────────────────────────────────────

async function writeRunningBatch(projectPath: string, sessionId: string) {
  const { saveBatchRuns } = await import('../src/tool/batch-state');
  saveBatchRuns(projectPath, [
    {
      batchId: 'b-stamp',
      createdAt: Date.now(),
      orderedSceneIds: ['s1', 's2'],
      doneSceneIds: [],
      gear: 'smart',
      status: 'running',
      chapterMap: { s1: 'ch-0', s2: 'ch-1' },
      sessionId,
    },
  ]);
}

describe('Story 3.5 — batch message stamping（streamMessage/sendMessage）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-batch-stamp-e2e-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
    vi.resetModules();
  });

  it('活跃批量存在 → assistant 消息盖 batchId=progress（session.messages + 流事件 data）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const generate = vi.fn(async () => ({ content: '走向单通报', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await writeRunningBatch(projectPath, session.id);

    await runtime.streamMessage({
      sessionId: session.id,
      content: '批量推进',
      abortSignal: new AbortController().signal,
      sendEvent: (event) => events.push(event as never),
    });

    // 内存 session 消息盖章（user 消息不盖、assistant 盖 progress）。
    const messages = runtime.getSession(session.id)!.messages;
    const assistant = messages.find((m) => m.role === 'assistant');
    const user = messages.find((m) => m.role === 'user');
    expect(assistant?.batchId).toBe('b-stamp');
    expect(assistant?.batchKind).toBe('progress');
    expect(user?.batchId).toBeUndefined();

    // 流事件 data 透传（UI BatchGroup 数据源）。
    const assistantEvent = events.find((e) => e.type === 'assistant');
    expect(assistantEvent?.data.batchId).toBe('b-stamp');
    expect(assistantEvent?.data.batchKind).toBe('progress');

    // 持久化 jsonl 逐行含盖章（重同步路径 done/cancelAgent 直留 backend 消息 → 字段存活）。
    const { loadMessagesFromFile } = await import('../src/agent/persistence');
    const persisted = loadMessagesFromFile(projectPath, session.id);
    const persistedAssistant = persisted.find((m) => m.role === 'assistant');
    expect(persistedAssistant?.batchId).toBe('b-stamp');
    expect(persistedAssistant?.batchKind).toBe('progress');
  });

  it('无活跃批量 → 消息不盖章（零回归）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async () => ({ content: 'ok', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    await runtime.sendMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
    });

    const assistant = runtime.getSession(session.id)!.messages.find((m) => m.role === 'assistant');
    expect(assistant?.batchId).toBeUndefined();
    expect(assistant?.batchKind).toBeUndefined();
  });

  it('批量 sessionId 不匹配（他 会话）→ 不盖章', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async () => ({ content: 'ok', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await writeRunningBatch(projectPath, 'another-session');

    await runtime.sendMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
    });

    const assistant = runtime.getSession(session.id)!.messages.find((m) => m.role === 'assistant');
    expect(assistant?.batchId).toBeUndefined();
  });
});
