import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── S5 退役门（拍板 #5）：旧会话 meta 的 modelRef 字段读时容忍 ──
//
// 会话模型机制退役后 SessionState/SessionMetaState 均无 modelRef，但磁盘上仍存在
// 退役前落盘的 `<sessionId>.meta.json`（含 modelRef 字段）。loadSessionMeta 是裸
// JSON.parse + 类型断言（多余字段天然忽略），loadSession 不读该字段——旧会话必须
// 可正常打开；且下一次 persistSession 落盘的 meta 不再含该字段（停写）。

describe('session meta legacy modelRef tolerance (S5 retirement gate)', () => {
  let projectPath = '';
  const sessionId = 'legacy-model-session';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-session-meta-tolerance-'));
    const sessionsDir = path.join(projectPath, '.orison', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    // 退役前形态的 meta：含 modelRef（其余字段 mirror persistSessionMeta 产出）。
    writeFileSync(path.join(sessionsDir, `${sessionId}.meta.json`), JSON.stringify({
      id: sessionId,
      agentName: 'writer',
      projectPath,
      status: 'idle',
      permissionMode: 'suggest',
      modelRef: { keyId: 'key_001', modelId: 'gpt-4o' },
      children: [],
      createdAt: 1,
      updatedAt: 2,
    }, null, 2), 'utf8');
    writeFileSync(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ id: 'm1', role: 'user', content: '旧会话第一条', createdAt: 1 })}\n`,
      'utf8',
    );
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmSync(projectPath, { recursive: true, force: true });
    vi.resetModules();
  });

  it('旧 meta 含 modelRef → loadSession 正常打开、字段被忽略', async () => {
    const { loadSession } = await import('../src/agent/session');
    const session = loadSession(sessionId, projectPath);

    expect(session).toBeDefined();
    expect(session?.agentName).toBe('writer');
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0]?.content).toBe('旧会话第一条');
    // 字段被忽略：加载出的 session 上不存在 modelRef（退役后 SessionState 无此字段）。
    expect(session && 'modelRef' in session).toBe(false);
  });

  it('再次持久化 → meta 停写 modelRef（旧字段被剥离）', async () => {
    const { loadSession } = await import('../src/agent/session');
    const { persistSession } = await import('../src/agent/persistence');
    const session = loadSession(sessionId, projectPath);
    expect(session).toBeDefined();

    persistSession(session!);
    const metaPath = path.join(projectPath, '.orison', 'sessions', `${sessionId}.meta.json`);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    expect('modelRef' in meta).toBe(false);
  });
});
