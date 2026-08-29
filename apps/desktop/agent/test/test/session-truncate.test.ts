import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../src/types';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 从此截断（dogfood 2026-08-21）：truncateSessionFromMessage 内核——纯对话尾巴才放行；
// 含工具痕迹（tool role / toolCalls / toolResults）一律拒（副作用留在世上而历史忘了
// 它 = 分叉 bug 源，用户拍板 SubAgent/工具执行段不可回退）；运行中拒；内存+JSONL 一致。
// ─────────────────────────────────────────────────────────────────────────────

function msg(id: string, role: SessionMessage['role'], extra: Partial<SessionMessage> = {}): SessionMessage {
  return { id, role, content: `c-${id}`, createdAt: Date.now(), ...extra };
}

describe('truncateSessionFromMessage', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-truncate-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
    vi.resetModules();
  });

  function jsonlLines(sessionId: string): number {
    const raw = readFileSync(path.join(projectPath, '.orison', 'sessions', `${sessionId}.jsonl`), 'utf-8');
    return raw.split('\n').filter(Boolean).length;
  }

  it('纯对话尾巴：截断成功，内存+JSONL 同步缩短，返回移除数', async () => {
    const { createSession, addMessage, truncateSessionFromMessage, getSession } = await import('../src/agent/session');
    const session = createSession({ agentName: 'writer', projectPath });
    addMessage(session.id, msg('m1', 'user'));
    addMessage(session.id, msg('m2', 'assistant'));
    addMessage(session.id, msg('m3', 'user'));
    addMessage(session.id, msg('m4', 'assistant'));
    expect(jsonlLines(session.id)).toBe(4);

    const result = truncateSessionFromMessage(session.id, 'm3');
    expect(result).toEqual({ ok: true, removed: 2 });
    const after = getSession(session.id);
    expect(after?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(jsonlLines(session.id)).toBe(2);
  });

  it('从首条截断 → 会话清空（冷启动重来形态）', async () => {
    const { createSession, addMessage, truncateSessionFromMessage, getSession } = await import('../src/agent/session');
    const session = createSession({ agentName: 'writer', projectPath });
    addMessage(session.id, msg('m1', 'user'));
    addMessage(session.id, msg('m2', 'assistant'));

    const result = truncateSessionFromMessage(session.id, 'm1');
    expect(result).toEqual({ ok: true, removed: 2 });
    expect(getSession(session.id)?.messages).toEqual([]);
    expect(jsonlLines(session.id)).toBe(0);
  });

  it('尾巴含 assistant toolCalls → 拒绝 tool-activity，状态原样', async () => {
    const { createSession, addMessage, truncateSessionFromMessage, getSession } = await import('../src/agent/session');
    const session = createSession({ agentName: 'writer', projectPath });
    addMessage(session.id, msg('m1', 'user'));
    addMessage(session.id, msg('m2', 'assistant', { toolCalls: [{ id: 'tc1', name: 'write_chapter', arguments: '{}' }] }));
    addMessage(session.id, msg('m3', 'assistant'));

    const result = truncateSessionFromMessage(session.id, 'm2');
    expect(result).toEqual({ ok: false, reason: 'tool-activity' });
    expect(getSession(session.id)?.messages.length).toBe(3);
    expect(jsonlLines(session.id)).toBe(3);
  });

  it('尾巴含 tool role 消息 → 拒绝（SubAgent/工具执行段不可回退）', async () => {
    const { createSession, addMessage, truncateSessionFromMessage } = await import('../src/agent/session');
    const session = createSession({ agentName: 'writer', projectPath });
    addMessage(session.id, msg('m1', 'user'));
    addMessage(session.id, msg('m2', 'assistant', { toolCalls: [{ id: 'tc1', name: 'spawn_agent', arguments: '{}' }] }));
    addMessage(session.id, msg('m3', 'tool', { toolResults: [{ toolCallId: 'tc1', toolName: 'spawn_agent', output: 'ok' }] }));
    addMessage(session.id, msg('m4', 'assistant'));

    // 从 m2 截（区间含 spawn_agent 的 calls+结果）→ 拒
    expect(truncateSessionFromMessage(session.id, 'm2')).toEqual({ ok: false, reason: 'tool-activity' });
    // 从 m3 截（区间含 tool 结果）→ 拒
    expect(truncateSessionFromMessage(session.id, 'm3')).toEqual({ ok: false, reason: 'tool-activity' });
  });

  it('前缀含工具痕迹但截的是纯对话尾巴 → 放行（保留前缀不动）', async () => {
    const { createSession, addMessage, truncateSessionFromMessage, getSession } = await import('../src/agent/session');
    const session = createSession({ agentName: 'writer', projectPath });
    addMessage(session.id, msg('m1', 'user'));
    addMessage(session.id, msg('m2', 'tool', { toolResults: [{ toolCallId: 'tc1', toolName: 'read_file', output: 'x' }] }));
    addMessage(session.id, msg('m3', 'assistant'));
    addMessage(session.id, msg('m4', 'user'));

    const result = truncateSessionFromMessage(session.id, 'm4');
    expect(result).toEqual({ ok: true, removed: 1 });
    expect(getSession(session.id)?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('运行中会话拒绝（running）', async () => {
    const { createSession, addMessage, updateStatus, truncateSessionFromMessage } = await import('../src/agent/session');
    const session = createSession({ agentName: 'writer', projectPath });
    addMessage(session.id, msg('m1', 'user'));
    updateStatus(session.id, 'running');

    expect(truncateSessionFromMessage(session.id, 'm1')).toEqual({ ok: false, reason: 'running' });
  });

  it('消息不存在 / 会话不存在 → not-found', async () => {
    const { createSession, addMessage, truncateSessionFromMessage } = await import('../src/agent/session');
    const session = createSession({ agentName: 'writer', projectPath });
    addMessage(session.id, msg('m1', 'user'));

    expect(truncateSessionFromMessage(session.id, 'gone')).toEqual({ ok: false, reason: 'not-found' });
    expect(truncateSessionFromMessage('no-such-session', 'm1')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('WorkflowRuntime 缝：runtime.truncateSessionFromMessage 直通内核', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { addMessage, getSession } = await import('../src/agent/session');
    const runtime = createWorkflowRuntime({ generate: vi.fn() });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    addMessage(session.id, msg('m1', 'user'));
    addMessage(session.id, msg('m2', 'assistant'));

    const result = runtime.truncateSessionFromMessage(session.id, 'm2');
    expect(result).toEqual({ ok: true, removed: 1 });
    expect(getSession(session.id)?.messages.map((m) => m.id)).toEqual(['m1']);
  });
});
