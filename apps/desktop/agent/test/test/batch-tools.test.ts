import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSession, deleteSession, getSession } from '../src/agent/session';
import { closeDb } from '../src/agent/persistence';
import { batchStatusTool, endBatchTool, startBatchTool, setParticipationGearTool } from '../src/tool/batch-tools';
import { clearActiveBatchStamp, loadBatchRuns, saveBatchRuns, stampBatchOnMessage } from '../src/tool/batch-state';
import type { ToolContext } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 4：leader 批量工具（start_batch / batch_status / end_batch）+
// set_participation_gear。守门（readonly/discuss/单活跃/cap/未指派章）、对账（章正文落盘）、
// 收口（report 盖章切换）。
//
// ⚠️ 全静态 import（无 vi.resetModules）——batch-tools 持 session/batch-state 模块引用，
// resetModules 会造成「工具拿旧模块 map、测试建新模块 session」的实例分裂（getSession undefined
// → 守卫全穿透）。模块级共享态（stamp map）在 afterEach 显式清。
// ─────────────────────────────────────────────────────────────────────────────

function makeToolContext(sessionId: string, projectPath: string): ToolContext {
  return { sessionId, projectPath, abort: new AbortController().signal };
}

function writeProject(projectPath: string, overrides: Record<string, unknown> = {}) {
  writeFileSync(
    path.join(projectPath, 'project.yaml'),
    JSON.stringify({
      name: 'Test',
      scene_graph: {
        nodes: [
          { id: 's1', lineTags: ['main'], episodeId: 'ep0', storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } },
          { id: 's2', lineTags: ['main'], episodeId: 'ep0', storyTime: 2, presentationOrder: { chapter: 0, pos: 1 } },
          { id: 's3', lineTags: ['main'], episodeId: 'ep1', storyTime: 3, presentationOrder: { chapter: 1, pos: 0 }, role: 'core-anchor', storyTimeLabel: '第3日黄昏' },
          { id: 'noEp', lineTags: ['side'], storyTime: 9, presentationOrder: { chapter: 9, pos: 0 } },
        ],
        edges: [
          { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' },
          { id: 'e2', from: 's2', to: 's3', type: 'CAUSAL' },
        ],
        lines: [
          { id: 'main', name: '主线' },
          { id: 'side', name: '支线' },
        ],
        version: 0,
        updatedBy: 'user',
      },
      episode_outlines: [
        { id: 'ep0', index: 0, title: '第0章', summary: '开局', core_event: '相遇' },
        { id: 'ep1', index: 1, title: '第1章' },
      ],
      novel: {
        chapters: [
          { id: 'ch-0', title: 'c0', sort_order: 0, sections: [] },
          { id: 'ch-1', title: 'c1', sort_order: 1, sections: [{ id: 'sec1', title: 's', sort_order: 0, content_file: 'chapters/ch_001.md' }] },
        ],
      },
      creative_brief: { rawRequirement: 'r', commitments: [{ type: 'HE', content: '圆满' }] },
      ...overrides,
    }),
    'utf-8',
  );
}

describe('Story 3.5 — start_batch', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-batch-tools-'));
  });

  afterEach(async () => {
    closeDb(projectPath);
    clearActiveBatchStamp(projectPath);
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
  });

  it('正常启动：拓扑序 3 场（截到锚点 s3）+ 信号卡 + 承诺对照 + 落盘 running + metadata', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const result = await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('批量已启动');
    expect(result.output).toContain('s1');
    expect(result.output).toContain('s3');
    expect(result.output).toContain('锚点=core-anchor');
    expect(result.output).toContain('[HE] 圆满');

    const meta = result.metadata as { type: string; batch: { orderedSceneIds: string[]; status: string; chapterMap: Record<string, string> }; signals: unknown[] };
    expect(meta.type).toBe('batch_started');
    expect(meta.batch.orderedSceneIds).toEqual(['s1', 's2', 's3']);
    expect(meta.batch.status).toBe('running');
    expect(meta.batch.chapterMap['s3']).toBe('ch-1');
    expect(meta.signals).toHaveLength(3);

    // 磁盘落盘。
    const runs = loadBatchRuns(projectPath);
    expect(runs).toHaveLength(1);
    expect(runs![0].status).toBe('running');
    expect(runs![0].sessionId).toBe(session.id);
  });

  it('readonly 权卫：拒绝启动（批量产 patch 无写权）', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'readonly' });
    const result = await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('只读');
  });

  it('discuss 权卫：拒绝启动（讨论模式禁写）', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'suggest', behaviorMode: 'discuss' });
    const result = await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('讨论');
  });

  it('单活跃批量不变式：已有 running → 拒绝（引导 batch_status / end_batch）', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    const second = await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    expect(second.output).toContain('已有活跃批量');
  });

  it('paused 残留挡新批量（project 级非终态守卫，防双活跃）', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    saveBatchRuns(projectPath, [{
      batchId: 'batch-paused-x',
      createdAt: 1,
      updatedAt: 1,
      orderedSceneIds: ['s1', 's2', 's3'],
      doneSceneIds: ['s1'],
      gear: 'smart',
      status: 'paused',
      chapterMap: { s1: 'ch-x', s2: 'ch-x', s3: 'ch-y' },
      sessionId: session.id,
    }]);
    const result = await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('已有活跃批量');
    expect(result.output).toContain('batch-paused-x');
    expect(result.output).toContain('paused');
    // 未新落盘（仍只有那条 paused）。
    expect(loadBatchRuns(projectPath)).toHaveLength(1);
  });

  it('CR-007：他 会话健在的 running 批量挡新 start_batch（project 级单活跃）且对他会话不可操作', async () => {
    writeProject(projectPath);
    const other = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    saveBatchRuns(projectPath, [{
      batchId: 'batch-foreign',
      createdAt: 2,
      updatedAt: 2,
      orderedSceneIds: ['s1'],
      doneSceneIds: [],
      gear: 'smart',
      status: 'running',
      chapterMap: { s1: 'ch-x' },
      sessionId: other.id,
    }]);
    const mine = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    // start_batch 被 project 级守卫挡下，提示到属主会话。
    const start = await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(mine.id, projectPath));
    expect(start.output).toContain('其他会话');
    expect(start.output).toContain('batch-foreign');
    expect(loadBatchRuns(projectPath)).toHaveLength(1); // 未新落盘
    // 他 会话健在 → 本会话 batch_status 不可操作（防误操作），提示防困惑。
    const status = await batchStatusTool.execute({}, makeToolContext(mine.id, projectPath));
    expect(status.output).toContain('其他会话');
    expect(status.output).toContain('batch-foreign');
  });

  it('CR-007：孤儿批量（属主会话已删）本会话可接管——batch_status 可见、end_batch 可收口、之后 start 放行', async () => {
    writeProject(projectPath);
    const gone = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    saveBatchRuns(projectPath, [{
      batchId: 'batch-orphan',
      createdAt: 3,
      updatedAt: 3,
      orderedSceneIds: ['s1'],
      doneSceneIds: [],
      gear: 'smart',
      status: 'running',
      chapterMap: { s1: 'ch-x' },
      sessionId: gone.id,
    }]);
    deleteSession(gone.id);
    const mine = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    // 可见：batch_status 呈现该批量（非「无活跃」）。
    const status = await batchStatusTool.execute({}, makeToolContext(mine.id, projectPath));
    expect(status.output).toContain('batch-orphan');
    // 可收口：end_batch aborted。
    const end = await endBatchTool.execute({ outcome: 'aborted' }, makeToolContext(mine.id, projectPath));
    expect(end.output).toContain('batch-orphan');
    expect(end.output).toContain('中止');
    // 收口后 start_batch 放行（真启动——writeProject 的 main 线可解析）。
    const start = await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(mine.id, projectPath));
    expect(start.output).toContain('批量已启动');
    expect(loadBatchRuns(projectPath)).toHaveLength(2);
  });

  it('无线锚点 → graceful 需澄清（leader 作一次咨询）', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    const result = await startBatchTool.execute({ lineTag: 'side' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('锚点');
    expect(result.output).toContain('澄清');
    // 未落盘。
    expect(loadBatchRuns(projectPath)).toEqual([]);
  });

  it('超 BATCH_SCENE_CAP → 拒绝（预算上限）', async () => {
    // 构 9 场线 + 线尾锚点。
    const doc = {
      name: 'Test',
      scene_graph: {
        nodes: Array.from({ length: 9 }, (_, i) => ({
          id: `g${i}`,
          lineTags: ['main'],
          episodeId: 'ep0',
          storyTime: i + 1,
          presentationOrder: { chapter: 0, pos: i },
          ...(i === 8 ? { role: 'core-anchor' } : {}),
        })),
        edges: Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, from: `g${i}`, to: `g${i + 1}`, type: 'CAUSAL' })),
        lines: [{ id: 'main', name: '主线' }],
        version: 0,
        updatedBy: 'user',
      },
      episode_outlines: [{ id: 'ep0', index: 0, title: '第0章' }],
      novel: { chapters: [{ id: 'ch-0', title: 'c0', sort_order: 0, sections: [] }] },
    };
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf-8');
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    const result = await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('超过上限');
  });

  it('未指派章的场 → graceful「需先指派章」（不静默跳过）', async () => {
    // side 线加一个锚点 + noEp（无 episode）→ plan 含 noEp → unmapped。
    writeProject(projectPath, {
      scene_graph: {
        nodes: [
          { id: 'side-a', lineTags: ['side'], episodeId: 'ep0', storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } },
          { id: 'noEp', lineTags: ['side'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'secondary-anchor' },
        ],
        edges: [{ id: 'e1', from: 'side-a', to: 'noEp', type: 'CAUSAL' }],
        lines: [{ id: 'side', name: '支线' }],
        version: 0,
        updatedBy: 'user',
      },
    });
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    const result = await startBatchTool.execute({ lineTag: 'side' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('需先指派');
    expect(result.output).toContain('noEp');
  });

  it('params.gear 提供时同步会话档位（「切到 X 档跑这条线」语义）', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main', gear: 'hands_off' }, makeToolContext(session.id, projectPath));
    expect(getSession(session.id)?.participationGear).toBe('hands_off');
    expect(loadBatchRuns(projectPath)![0].gear).toBe('hands_off');
  });
});

describe('Story 3.5 — batch_status 对账 + end_batch 收口', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-batch-status-'));
  });

  afterEach(async () => {
    closeDb(projectPath);
    clearActiveBatchStamp(projectPath);
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
  });

  it('无活跃批量 → 告知（不崩）', async () => {
    const result = await batchStatusTool.execute({}, makeToolContext('sess-x', projectPath));
    expect(result.output).toContain('无活跃批量');
  });

  it('对账：章正文已落盘的场标记完成（进度真相源 = project state）+ paused → running 续跑', async () => {
    writeProject(projectPath);
    // ch-1 的 prose 落盘（chapters/ch_001.md）→ s3（挂 ep1→ch-1）对账为完成；s1/s2 挂 ep0→ch-0 无 prose。
    mkdirSync(path.join(projectPath, 'chapters'), { recursive: true });
    writeFileSync(path.join(projectPath, 'chapters', 'ch_001.md'), '# 第一章\n正文', 'utf-8');

    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));

    const result = await batchStatusTool.execute({}, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('1/3 场已完成');
    expect(result.output).toContain('s3');
    expect(result.output).toContain('对账新确认 1 场');

    const meta = result.metadata as { batch: { doneSceneIds: string[]; status: string } };
    expect(meta.batch.doneSceneIds).toEqual(['s3']);
    expect(meta.batch.status).toBe('running');
  });

  it('对账续跑：磁盘 paused 批量 → batch_status 转 running（崩溃恢复语义）', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    // 模拟崩溃：手动把磁盘状态改 paused。
    const runs = loadBatchRuns(projectPath)!;
    runs[0] = { ...runs[0], status: 'paused' };
    saveBatchRuns(projectPath, runs);

    const result = await batchStatusTool.execute({}, makeToolContext(session.id, projectPath));
    expect((result.metadata as { batch: { status: string } }).batch.status).toBe('running');
  });

  it('end_batch(done)：status=done + 剩余进度 + 收尾协议提示', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));

    const result = await endBatchTool.execute({ outcome: 'done' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('收口');
    expect(result.output).toContain('present_result');
    expect((result.metadata as { batch: { status: string } }).batch.status).toBe('done');
    expect(loadBatchRuns(projectPath)![0].status).toBe('done');
  });

  it('end_batch(aborted)：status=aborted + 清盖章', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    const result = await endBatchTool.execute({ outcome: 'aborted' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('中止');
    expect(loadBatchRuns(projectPath)![0].status).toBe('aborted');
    // stamp 清空：后续消息不盖章。
    const msg = { role: 'assistant' };
    stampBatchOnMessage(projectPath, session.id, msg as never);
    expect((msg as { batchId?: string }).batchId).toBeUndefined();
  });

  // ── Story 8.4 Step 4（A8）：批量挂起继续他章——batch_status 剔出待推进 + 呈报；end_batch 报告挂起。──

  /** 把磁盘批量记录的指定场标挂起（mirror write_chapter markSuspendedChapterInBatch 产态）。 */
  function markSuspended(sceneIds: string[]): void {
    const runs = loadBatchRuns(projectPath)!;
    runs[0] = { ...runs[0], suspendedSceneIds: sceneIds };
    saveBatchRuns(projectPath, runs);
  }

  it('挂起场剔出待推进 + 挂起行呈报（s1/s2 挂起 → 剩余只 s3）', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    markSuspended(['s1', 's2']);

    const result = await batchStatusTool.execute({}, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('剩余 1 场');
    expect(result.output).toContain('s3');
    expect(result.output).toContain('挂起 2 场');
    expect(result.output).toContain('s1');
    expect(result.output).toContain('待作者决断');
    // metadata.batch 携挂起场（BatchReportCard 数据源透出）。
    expect((result.metadata as { batch: { suspendedSceneIds?: string[] } }).batch.suspendedSceneIds).toEqual(['s1', 's2']);
  });

  it('全部待推进场挂起 → 不误报「全部场已完成」，提示决断挂起章', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    markSuspended(['s1', 's2', 's3']);

    const result = await batchStatusTool.execute({}, makeToolContext(session.id, projectPath));
    expect(result.output).not.toContain('全部场已完成');
    expect(result.output).toContain('挂起 3 场');
  });

  it('挂起章决断后重写落盘 → 对账转 done（done 优先，不再算挂起）', async () => {
    writeProject(projectPath);
    mkdirSync(path.join(projectPath, 'chapters'), { recursive: true });
    writeFileSync(path.join(projectPath, 'chapters', 'ch_001.md'), '# 第一章\n正文', 'utf-8');
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    markSuspended(['s3']); // s3 挂起后决断重写 → 落盘 → 对账。

    const result = await batchStatusTool.execute({}, makeToolContext(session.id, projectPath));
    expect((result.metadata as { batch: { doneSceneIds: string[] } }).batch.doneSceneIds).toEqual(['s3']);
    expect(result.output).not.toContain('挂起'); // done 场不再算挂起（suspendedActive 过滤 doneSet）
  });

  it('end_batch：挂起未写场进收口报告（批量报告呈现挂起原因通道）', async () => {
    writeProject(projectPath);
    const session = createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    await startBatchTool.execute({ lineTag: 'main' }, makeToolContext(session.id, projectPath));
    markSuspended(['s1', 's2']);

    const result = await endBatchTool.execute({ outcome: 'done' }, makeToolContext(session.id, projectPath));
    expect(result.output).toContain('其中 2 场挂起未写');
    expect(result.output).toContain('s1');
    expect(result.output).toContain('出发核查');
  });
});

describe('Story 3.5 — set_participation_gear（chat 指令调档）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-gear-tool-'));
  });

  afterEach(async () => {
    closeDb(projectPath);
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
  });

  it('设置档位 + 圈类别 + trust（直接字段更新，mid-run 安全）', async () => {
    const session = createSession({ agentName: 'writer', projectPath });
    const result = await setParticipationGearTool.execute(
      { gear: 'balanced', balancedAskCategories: ['direction_turn'], trustAdjudication: true },
      makeToolContext(session.id, projectPath),
    );
    expect(result.output).toContain('balanced');
    expect(getSession(session.id)?.participationGear).toBe('balanced');
    expect(getSession(session.id)?.balancedAskCategories).toEqual(['direction_turn']);
    expect(getSession(session.id)?.trustAdjudication).toBe(true);
    // 持久化。
    const meta = JSON.parse(readFileSync(path.join(projectPath, '.orison', 'sessions', `${session.id}.meta.json`), 'utf-8'));
    expect(meta.participationGear).toBe('balanced');
  });

  it('session 缺 → graceful 告知', async () => {
    const result = await setParticipationGearTool.execute({ gear: 'steer' }, makeToolContext('no-such', projectPath));
    expect(result.output).toContain('会话不存在');
  });
});
