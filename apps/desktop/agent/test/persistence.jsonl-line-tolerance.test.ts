import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── dogfood T1 Stage 4（design §8 / r3）：JSONL per-line 容错 ──
//
// appendFileSync 非原子——进程崩溃可留半行（流式 abort 高频化放大此风险）。旧行为：
// loadMessagesFromFile 逐行 JSON.parse 任一行坏 → 整体 throw → loadSession 抛 →
// agent:get-session IPC 异常（整个会话打不开）。新行为：坏行 skip + warn（logger.warn），
// 好行照常加载。半行截断还可能 parse 成标量（"12"）——形态守卫（非对象/无 role）同 skip。

describe('JSONL per-line fault tolerance (dogfood T1 Stage 4)', () => {
  let projectPath = '';
  const sessionId = 'jsonl-tolerance-session';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-jsonl-tolerance-'));
    const sessionsDir = path.join(projectPath, '.orison', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmSync(projectPath, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeJsonl(body: string): void {
    writeFileSync(path.join(projectPath, '.orison', 'sessions', `${sessionId}.jsonl`), body, 'utf8');
  }

  it('坏 JSON 行（半行截断）skip 不整体 throw——好行照常加载', async () => {
    const { loadMessagesFromFile } = await import('../src/agent/persistence');
    const warn = vi.spyOn((await import('../src/logger')).logger, 'warn').mockImplementation(() => {});
    writeJsonl([
      JSON.stringify({ id: 'm1', role: 'user', content: '第一条', createdAt: 1 }),
      '{"id":"m2","role":"assistant","content":"半行截断——没写完', // 崩溃残留半行
      JSON.stringify({ id: 'm3', role: 'assistant', content: '第三条', createdAt: 3, reasoning: '思考' }),
    ].join('\n') + '\n');

    const messages = loadMessagesFromFile(projectPath, sessionId);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(messages[1].reasoning).toBe('思考'); // 好行字段（含新 reasoning）不受坏行影响
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('parse 得非对象标量行（形态守卫）skip', async () => {
    const { loadMessagesFromFile } = await import('../src/agent/persistence');
    const warn = vi.spyOn((await import('../src/logger')).logger, 'warn').mockImplementation(() => {});
    writeJsonl([
      '123', // 半行截断恰好 parse 成数字
      JSON.stringify({ id: 'm1', role: 'user', content: '有效行', createdAt: 1 }),
      'null',
    ].join('\n') + '\n');

    const messages = loadMessagesFromFile(projectPath, sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('全部行完好 → 零 warn 零丢失（既有行为不变）', async () => {
    const { loadMessagesFromFile } = await import('../src/agent/persistence');
    const warn = vi.spyOn((await import('../src/logger')).logger, 'warn').mockImplementation(() => {});
    writeJsonl([
      JSON.stringify({ id: 'm1', role: 'user', content: 'a', createdAt: 1 }),
      JSON.stringify({ id: 'm2', role: 'assistant', content: 'b', createdAt: 2 }),
    ].join('\n') + '\n');

    const messages = loadMessagesFromFile(projectPath, sessionId);
    expect(messages).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
