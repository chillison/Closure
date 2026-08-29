import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 2：participationGear 全链（mirror behaviorMode）——SessionState 字段 /
// 持久化 meta / setSessionParticipationGear（运行时 enum 校验）/ createSession 缺省与垃圾归一。
// ─────────────────────────────────────────────────────────────────────────────

describe('Story 3.5 — session participation gear', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-gear-'));
  });

  afterEach(async () => {
    const { closeDb, evictSession } = await import('../src/agent/persistence');
    void evictSession;
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('createSession 缺省 smart；loadSession 旧 meta 无字段 → 缺省 smart（零 migration）', async () => {
    const { createSession } = await import('../src/agent/session');
    const session = createSession({ agentName: 'writer', projectPath });
    expect(session.participationGear).toBe('smart');
    expect(session.balancedAskCategories).toBeUndefined();
    expect(session.trustAdjudication).toBeUndefined();
  });

  it('createSession 非枚举垃圾值防御性归一 smart（junk 不落盘）', async () => {
    const { createSession } = await import('../src/agent/session');
    const session = createSession({
      agentName: 'writer',
      projectPath,
      participationGear: 'turbo' as never,
    });
    expect(session.participationGear).toBe('smart');
  });

  it('setSessionParticipationGear：合法值持久化到 meta（balanced 圈类别 + trustAdjudication）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getSession } = await import('../src/agent/session');
    const runtime = createWorkflowRuntime({ generate: vi.fn() });
    const session = runtime.createSession({ agentName: 'writer', projectPath, participationGear: 'steer' });
    expect(session.participationGear).toBe('steer');

    const ok = runtime.setSessionParticipationGear(session.id, 'balanced', {
      balancedAskCategories: ['protagonist_safety', 'direction_turn'],
      trustAdjudication: true,
    });
    expect(ok).toBe(true);
    expect(getSession(session.id)?.participationGear).toBe('balanced');
    expect(getSession(session.id)?.balancedAskCategories).toEqual(['protagonist_safety', 'direction_turn']);
    expect(getSession(session.id)?.trustAdjudication).toBe(true);

    // meta 磁盘持久化（additive optional 字段进 SessionMetaState）。
    const metaRaw = readFileSync(path.join(projectPath, '.orison', 'sessions', `${session.id}.meta.json`), 'utf-8');
    const meta = JSON.parse(metaRaw);
    expect(meta.participationGear).toBe('balanced');
    expect(meta.trustAdjudication).toBe(true);
  });

  it('setSessionParticipationGear：垃圾 gear / 垃圾圈类别 / 非 boolean trust → false（运行时校验双防线）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const runtime = createWorkflowRuntime({ generate: vi.fn() });
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    expect(runtime.setSessionParticipationGear(session.id, 'yolo' as never)).toBe(false);
    expect(
      runtime.setSessionParticipationGear(session.id, 'balanced', {
        balancedAskCategories: ['pacing' as never],
      }),
    ).toBe(false);
    expect(
      runtime.setSessionParticipationGear(session.id, 'hands_off', { trustAdjudication: 'yes' as never }),
    ).toBe(false);
    // 未修改。
    expect(runtime.getSession(session.id)?.participationGear).toBe('smart');
  });

  it('setSessionParticipationGear：session 缺 → false（mirror setSessionBehaviorMode）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const runtime = createWorkflowRuntime({ generate: vi.fn() });
    expect(runtime.setSessionParticipationGear('no-such-session', 'steer')).toBe(false);
  });

  it('loadSession 从磁盘恢复三字段（进程重启 / evict 后）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { evictSession } = await import('../src/agent/session');
    const runtime = createWorkflowRuntime({ generate: vi.fn() });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    runtime.setSessionParticipationGear(session.id, 'hands_off', { trustAdjudication: true });

    // evict 内存缓存后经 runtime.getSession(projectPath) 从磁盘 loadSession 恢复。
    evictSession(session.id);
    const restored = runtime.getSession(session.id, projectPath);
    expect(restored?.participationGear).toBe('hands_off');
    expect(restored?.trustAdjudication).toBe(true);
  });

  it('旧 meta（无三字段）loadSession → 缺省（向后兼容，零 migration）', async () => {
    // 手写一个无 participationGear 的 meta + 空 jsonl（模拟 3.5 之前的会话）。
    const { createSession, evictSession } = await import('../src/agent/session');
    const session = createSession({ agentName: 'writer', projectPath });
    const metaPath = path.join(projectPath, '.orison', 'sessions', `${session.id}.meta.json`);
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    delete meta.participationGear;
    delete meta.balancedAskCategories;
    delete meta.trustAdjudication;
    writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');
    evictSession(session.id);

    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const runtime = createWorkflowRuntime({ generate: vi.fn() });
    expect(runtime.getSession(session.id, projectPath)?.participationGear).toBe('smart');
  });
});
