import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, deleteSession } from '../src/agent/session';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 5：buildInteractionModeSegment 批量协议段注入（design §2.2 四档协议表）。
// 经 sendMessage end-to-end 验（generate mock 收 system prompt 断言，mirror stale-fields-segment
// .test.ts 模式）：
// 1. 活跃批量 + 各档位 → 四档协议差异文本。
// 2. 无活跃批量 → 零注入（回归安全）。
// 3. escalate 穿透纪律 + 锚点收尾（各档共有）。
// ─────────────────────────────────────────────────────────────────────────────

async function writeRunningBatch(projectPath: string, gear: string, sessionId?: string) {
  // 直接写 batches.json（绕过 start_batch——本测聚焦 prompt 段注入，非工具行为）。
  const { saveBatchRuns } = await import('../src/tool/batch-state');
  saveBatchRuns(projectPath, [
    {
      batchId: 'b-prompt',
      createdAt: Date.now(),
      lineTag: 'main',
      orderedSceneIds: ['s1', 's2', 's3'],
      doneSceneIds: ['s1'],
      gear: gear as never,
      status: 'running',
      chapterMap: { s1: 'ch-0', s2: 'ch-1', s3: 'ch-1' },
      ...(sessionId ? { sessionId } : {}),
    },
  ]);
}

async function runTurn(projectPath: string, participationGear?: string) {
  const { createWorkflowRuntime } = await import('../src/runtime/workflow');
  const generate = vi.fn(async () => ({ content: 'ok', finishReason: 'stop' }));
  const runtime = createWorkflowRuntime({ generate });
  const session = runtime.createSession({
    agentName: 'writer',
    projectPath,
    ...(participationGear ? { participationGear: participationGear as never } : {}),
  });
  await runtime.sendMessage({
    sessionId: session.id,
    content: 'Continue batch.',
    abortSignal: new AbortController().signal,
  });
  expect(generate).toHaveBeenCalledOnce();
  return { system: generate.mock.calls[0][1] as string, sessionId: session.id };
}

describe('Story 3.5 — batch prompt segment（buildInteractionModeSegment）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-batch-segment-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('smart 档：通报走向单不阻塞 + 判轻重 + 信号卡指引 + 进度（1/3 + 下一场）', async () => {
    await writeRunningBatch(projectPath, 'smart');
    const { system } = await runTurn(projectPath, 'smart');
    expect(system).toContain('批量写作协议');
    expect(system).toContain('参与档位=smart');
    expect(system).toContain('通报走向单');
    expect(system).toContain('判轻重');
    expect(system).toContain('信号卡');
    expect(system).toContain('1/3 场已完成');
    expect(system).toContain('下一场=s2');
  });

  it('steer 档：每场写前都问 + 逐场预告', async () => {
    await writeRunningBatch(projectPath, 'steer');
    const { system } = await runTurn(projectPath, 'steer');
    expect(system).toContain('每场写前都问');
    expect(system).toContain('逐场预告');
    expect(system).not.toContain('参与档位=smart');
  });

  it('balanced 档：走向单等确认 + 圈类别命中才问（默认三项全）', async () => {
    await writeRunningBatch(projectPath, 'balanced');
    const { system } = await runTurn(projectPath, 'balanced');
    expect(system).toContain('走向单必须等作者确认');
    expect(system).toContain('主角生死安危');
    expect(system).toContain('信息差关键抉择');
    expect(system).toContain('方向转弯');
  });

  it('hands_off 档：零问 + trustAdjudication（默认 false=停下问）+ 验收清单', async () => {
    await writeRunningBatch(projectPath, 'hands_off');
    const { system } = await runTurn(projectPath, 'hands_off');
    expect(system).toContain('全程不问');
    expect(system).toContain('trustAdjudication=false');
    expect(system).toContain('diff 验收清单');
  });

  it('各档共有：escalate 穿透纪律（BLOCK 不豁免）+ 锚点收尾（end_batch + present_result + L0 + diagnose_impacts）', async () => {
    await writeRunningBatch(projectPath, 'smart');
    const { system } = await runTurn(projectPath, 'smart');
    expect(system).toContain('硬性打断穿透');
    expect(system).toContain('不豁免 BLOCK');
    expect(system).toContain('end_batch');
    expect(system).toContain('present_result');
    expect(system).toContain('L0 全景');
    expect(system).toContain('diagnose_impacts');
  });

  it('Story 8.4：出发核查挂起纪律（跳过该章继续他章 + 呈作者决断；与 escalate 停整批两纪律并存）', async () => {
    await writeRunningBatch(projectPath, 'smart');
    const { system } = await runTurn(projectPath, 'smart');
    expect(system).toContain('出发核查挂起');
    expect(system).toContain('继续批量推进其他章');
    expect(system).toContain('呈给作者决断');
    // 两纪律并存（escalate 停整批 vs 挂起跳该章）——防挂起被误当 escalate 全停。
    expect(system).toContain('硬性打断穿透');
  });

  it('Story 8.4：挂起场不进「下一场」推进（intro 行跳过挂起场 + 挂起计数呈报）', async () => {
    const { saveBatchRuns } = await import('../src/tool/batch-state');
    saveBatchRuns(projectPath, [
      {
        batchId: 'b-suspended',
        createdAt: Date.now(),
        lineTag: 'main',
        orderedSceneIds: ['s1', 's2', 's3'],
        doneSceneIds: ['s1'],
        suspendedSceneIds: ['s2'], // s2 挂起 → 下一场应为 s3（非 s2）。
        gear: 'smart' as never,
        status: 'running',
        chapterMap: { s1: 'ch-0', s2: 'ch-1', s3: 'ch-1' },
      },
    ]);
    const { system } = await runTurn(projectPath, 'smart');
    expect(system).toContain('下一场=s3');
    expect(system).not.toContain('下一场=s2');
    expect(system).toContain('另有 1 场挂起');
  });

  it('无活跃批量 → 零注入（回归安全）', async () => {
    const { system } = await runTurn(projectPath, 'smart');
    expect(system).not.toContain('批量写作协议');
    expect(system).not.toContain('参与档位');
  });

  it('live 档位优先于批量启动档位（随时调档下一轮生效，design §2.1）', async () => {
    await writeRunningBatch(projectPath, 'smart'); // 启动快照 smart。
    const { system } = await runTurn(projectPath, 'steer'); // 会话 live = steer。
    expect(system).toContain('参与档位=steer');
    expect(system).not.toContain('参与档位=smart');
  });

  it('批量 sessionId 不匹配本会话且属主会话健在 → 不注入（他 会话 的批量）；属主已删（孤儿）→ 注入可接管', async () => {
    const foreign = createSession({ agentName: 'writer', projectPath });
    await writeRunningBatch(projectPath, 'smart', foreign.id);
    const { system } = await runTurn(projectPath, 'smart');
    expect(system).not.toContain('批量写作协议');
    // CR-007 对偶：孤儿批量（属主会话已删）对本会话可见 → 协议注入（可 batch_status 对账接管）。
    deleteSession(foreign.id);
    const { system: afterOrphan } = await runTurn(projectPath, 'smart');
    expect(afterOrphan).toContain('批量写作协议');
  });
});
