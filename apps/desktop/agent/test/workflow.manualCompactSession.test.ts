import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowRuntime } from '../src/runtime/workflow';
import { RunStateStore } from '../src/runtime/runState';
import { getSession, addMessage } from '../src/agent/session';
import { closeDb, overwriteMessagesFile } from '../src/agent/persistence';
import type { SessionMessage, RuntimeStreamEvent } from '../src/types';

// CR-014（08-25 BMad CR）：persistence 部分 mock——overwriteMessagesFile 可控抛错（其余
// 真实，addMessage 的 JSONL 追加路径不受影响）。
vi.mock('../src/agent/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/persistence')>();
  return { ...actual, overwriteMessagesFile: vi.fn(actual.overwriteMessagesFile) };
});

// ─────────────────────────────────────────────────────────────────────────────
// S4a（task 08-25 design §3.2 / §4.1，PRD 拍板 4-D 触发①手动）：WorkflowRuntime
// .manualCompactSession 门面——空闲语义（载入会话消息 + ContextState →
// compactWithSummarization（复用 dialogue 档 generate 注入）→ 整体重写 JSONL +
// 更新 meta → 经 onRuntimeEvent 发 compaction 事件）；不存在/运行中/无可压 → false。
// seam 钉死：shell `agent:compact-session` IPC 以 runtime.manualCompactSession?
// (sessionId) 防御式调用（签名勿偏离——legacy compactSession 是 continuation
// 快照的确定性压缩，语义不同勿混）。
// ─────────────────────────────────────────────────────────────────────────────

function makeMessages(count: number, charsPer = 1000): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as SessionMessage['role'],
    content: `消息 ${i}：` + 'x'.repeat(charsPer),
    createdAt: Date.now() + i,
  }));
}

describe('WorkflowRuntime.manualCompactSession（S4a 手动压缩）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-manual-compact-'));
  });

  afterEach(() => {
    closeDb(projectPath);
    rmSync(projectPath, { recursive: true, force: true });
  });

  function makeRuntime(overrides?: { onRuntimeEvent?: (sessionId: string, event: RuntimeStreamEvent) => void }) {
    // mock 保持自身类型（断言 .mock 用，参数形态齐全供解构）；直接注入——返回形态结构
    // 满足 GenerateResult（content + finishReason，可选字段缺省）。
    const generate = vi.fn(
      async (_messages: SessionMessage[], _system: string, _tools: unknown[]) => ({
        content: '## Summary\n- 手动压缩摘要',
        finishReason: 'stop',
      }),
    );
    const runtime = createWorkflowRuntime({
      generate,
      runState: new RunStateStore(),
      ...(overrides?.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
    });
    return { generate, runtime };
  }

  /**
   * 建会话并灌消息。⚠️ runtime.createSession 门面不转发 messages 入参（CreateSessionInput
   * 无该字段——消息只能经 addMessage 落进内存 + JSONL），用 session.ts 的 addMessage 灌
   *（与 streamMessage/sendMessage 车道的真实入消息路径一致）。
   */
  function seedSession(
    runtime: ReturnType<typeof createWorkflowRuntime>,
    count: number,
    status?: 'running',
    charsPer?: number,
  ): { id: string } {
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    for (const msg of makeMessages(count, charsPer)) {
      addMessage(session.id, msg);
    }
    if (status === 'running') {
      getSession(session.id)!.status = 'running'; // live 引用直置（与 streamMessage 运行态同对象）
    }
    return { id: session.id };
  }

  it('成功路径：压缩 + JSONL 重写 + meta 更新 + compaction 事件', async () => {
    const onRuntimeEvent = vi.fn();
    const { generate, runtime } = makeRuntime({ onRuntimeEvent });
    const session = seedSession(runtime, 12);

    const ok = await runtime.manualCompactSession(session.id);

    expect(ok).toBe(true);
    // 内存 session：保留尾 6 + ContextState 回写。
    const updated = getSession(session.id)!;
    expect(updated.messages).toHaveLength(6);
    expect(updated.contextState?.compactedSummary).toContain('手动压缩摘要');
    expect(updated.contextState?.compactionCount).toBe(1);
    expect(updated.contextState?.totalCompactedMessages).toBe(6);
    // JSONL 整体重写为保留尾。
    const jsonl = readFileSync(
      path.join(projectPath, '.orison', 'sessions', `${session.id}.jsonl`),
      'utf-8',
    ).trim().split('\n');
    expect(jsonl).toHaveLength(6);
    // meta 持久化（跨会话恢复 compactedSummary / compactionCount）。
    const meta = JSON.parse(readFileSync(
      path.join(projectPath, '.orison', 'sessions', `${session.id}.meta.json`),
      'utf-8',
    )) as { contextState?: { compactedSummary?: string } };
    expect(meta.contextState?.compactedSummary).toContain('手动压缩摘要');
    // compaction 运行时事件（streamMessage onCompaction 同载荷形态）。
    expect(onRuntimeEvent).toHaveBeenCalledWith(session.id, {
      type: 'compaction',
      data: { compactedCount: 6 },
    });
    // 摘要 generate 恰一次（复用注入的 generate，无工具）。
    expect(generate).toHaveBeenCalledTimes(1);
    const [msgs, , tools] = generate.mock.calls[0];
    expect(tools).toHaveLength(0);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('会话不存在（不在内存 LRU）→ false', async () => {
    const { runtime } = makeRuntime();
    await expect(runtime.manualCompactSession('no-such-session')).resolves.toBe(false);
  });

  it('无可压内容（消息 ≤ 保尾区）→ false', async () => {
    const { generate, runtime } = makeRuntime();
    const session = seedSession(runtime, 3);

    await expect(runtime.manualCompactSession(session.id)).resolves.toBe(false);
    expect(getSession(session.id)!.messages).toHaveLength(3); // 原样未动
    expect(generate).not.toHaveBeenCalled();
  });

  it('会话运行中 → false（空闲语义：与 runLoop 并发改消息竞态）', async () => {
    const { runtime } = makeRuntime();
    const session = seedSession(runtime, 12, 'running');

    await expect(runtime.manualCompactSession(session.id)).resolves.toBe(false);
    expect(getSession(session.id)!.messages).toHaveLength(12); // 原样未动
  });

  it('onRuntimeEvent 缺省不接线 → 静默成功（boolean 即操作反馈）', async () => {
    const { runtime } = makeRuntime();
    const session = seedSession(runtime, 12);
    await expect(runtime.manualCompactSession(session.id)).resolves.toBe(true);
  });

  // ── 08-25 BMad CR P1：CR-005（窗口参数化两态）/ CR-014（持久化回滚）/ CR-015（mutation 前重查）──

  it('CR-005 态一：注入小窗（windowTokens 5000）→ 压后投影仍溢出 → 硬截断升级（保留 < 6）仍 true', async () => {
    const onRuntimeEvent = vi.fn();
    const { runtime } = makeRuntime({ onRuntimeEvent });
    const session = seedSession(runtime, 12, undefined, 2000);

    // 12 条 × 2000 chars（~578 tokens/条）：LLM 压缩保留 6（~3.5K）+ 摘要 ≈ 3.5K +
    // 预留 32.768K > 5000 → 升级硬截断保尾 2（~1.2K）；硬截断后仍超（窗口 < 回复预留）
    // → warn 但仍返回 true（模式 A：压缩已发生，剩余溢出归运行时三触发兜底）。
    const ok = await runtime.manualCompactSession(session.id, { windowTokens: 5000 });

    expect(ok).toBe(true);
    const updated = getSession(session.id)!;
    expect(updated.messages).toHaveLength(2); // 硬截断保尾 2
    // 摘要按窗口 25% 预算截断（5000×0.25×3.5 = 4375 chars < join 4×2012 chars）。
    expect(updated.contextState?.compactedSummary).toContain('硬截断摘要中段省略');
    expect(updated.contextState?.totalCompactedMessages).toBe(10); // 12 - 2（实际保留差）
    expect(onRuntimeEvent).toHaveBeenCalledWith(session.id, {
      type: 'compaction',
      data: { compactedCount: 10 },
    });
  });

  it('CR-005 态二：注入大窗（windowTokens 1M）→ 塞得下不升级（保留 6，与缺省同形）', async () => {
    const { runtime } = makeRuntime();
    const session = seedSession(runtime, 12);

    const ok = await runtime.manualCompactSession(session.id, { windowTokens: 1_000_000 });

    expect(ok).toBe(true);
    expect(getSession(session.id)!.messages).toHaveLength(6); // 无升级（非 required 档保尾语义同 LLM 路径）
    expect(getSession(session.id)!.contextState?.totalCompactedMessages).toBe(6);
  });

  it('CR-005 缺省：不传 opts → target 回落现值、零升级（现行为）', async () => {
    const { runtime } = makeRuntime();
    const session = seedSession(runtime, 12);

    await expect(runtime.manualCompactSession(session.id, undefined)).resolves.toBe(true);
    expect(getSession(session.id)!.messages).toHaveLength(6);
  });

  it('CR-014：持久化失败（JSONL 重写抛错）→ 内存态回滚 + false（不留「内存压了盘上满」半提交）', async () => {
    const { runtime } = makeRuntime();
    const session = seedSession(runtime, 12);
    const jsonlPath = path.join(projectPath, '.orison', 'sessions', `${session.id}.jsonl`);
    const jsonlBefore = readFileSync(jsonlPath, 'utf-8');

    vi.mocked(overwriteMessagesFile).mockImplementationOnce(() => {
      throw new Error('EIO: disk full');
    });

    await expect(runtime.manualCompactSession(session.id)).resolves.toBe(false);

    // 内存回滚：消息 12 条原样、contextState 未写、updatedAt 未动。
    const restored = getSession(session.id)!;
    expect(restored.messages).toHaveLength(12);
    expect(restored.contextState?.compactionCount ?? 0).toBe(0);
    // 盘上 JSONL 未被半写。
    expect(readFileSync(jsonlPath, 'utf-8')).toBe(jsonlBefore);
  });

  it('CR-015：摘要 await 期间 run 启动（status→running）→ mutation 前重查拒绝（false，消息原样）', async () => {
    let sessionId = '';
    const generate = vi.fn(async () => {
      // 摘要返回前 run 启动（外层 D4 租约挡的是 IPC 面，runtime 内部启动不经租约）。
      getSession(sessionId)!.status = 'running';
      return { content: '## Summary\n- 手动压缩摘要', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate, runState: new RunStateStore() });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    sessionId = session.id;
    for (const msg of makeMessages(12)) {
      addMessage(session.id, msg);
    }

    await expect(runtime.manualCompactSession(session.id)).resolves.toBe(false);
    expect(getSession(session.id)!.messages).toHaveLength(12); // 原样未动（无 clobber）
    expect(generate).toHaveBeenCalledTimes(1); // 摘要调用已发生（竞态窗口内），但 mutation 被拒
  });
});
