import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearActiveBatchStamp,
  findActiveBatchRun,
  loadBatchRuns,
  markBatchStampReport,
  saveBatchRuns,
  setActiveBatchStamp,
  stampBatchOnMessage,
  syncActiveBatchStamp,
  upsertBatchRun,
  BATCH_RECORD_CAP,
} from '../src/tool/batch-state';
import type { BatchRunState } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 3：batches.json 持久（graceful / cap LRU / per-element parse）+
// 消息盖章 registry（活跃/无活跃/report 切换/会话匹配）。
// ─────────────────────────────────────────────────────────────────────────────

function makeBatch(overrides: Partial<BatchRunState> = {}): BatchRunState {
  return {
    batchId: 'b1',
    createdAt: 1000,
    orderedSceneIds: ['s1', 's2'],
    doneSceneIds: [],
    gear: 'smart',
    status: 'running',
    chapterMap: { s1: 'ch-0', s2: 'ch-1' },
    ...overrides,
  };
}

describe('Story 3.5 — batches.json persistence', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-batch-state-'));
  });

  afterEach(() => {
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
  });

  it('文件不存在 → []（合法「从未跑过」）；load 后 save round-trip', () => {
    expect(loadBatchRuns(projectPath)).toEqual([]);
    const batch = makeBatch();
    upsertBatchRun(projectPath, batch);
    const loaded = loadBatchRuns(projectPath);
    expect(loaded).toHaveLength(1);
    expect(loaded![0].batchId).toBe('b1');
    expect(loaded![0].status).toBe('running');
    expect(existsSync(path.join(projectPath, '.orison', 'batches.json'))).toBe(true);
  });

  it('Story 8.4 Step 4：suspendedSceneIds round-trip；旧记录无此字段 → undefined（additive 零 migration）', () => {
    // 新记录带挂起场 → round-trip 保留。
    upsertBatchRun(projectPath, makeBatch({ suspendedSceneIds: ['s1'] }));
    expect(loadBatchRuns(projectPath)![0].suspendedSceneIds).toEqual(['s1']);
    // 旧记录（Story 8.4 前落盘，无字段）→ undefined（视为无挂起，零 migration）。
    const legacy = { ...makeBatch({ batchId: 'b-legacy' }), createdAt: 2000 };
    delete (legacy as Partial<BatchRunState>).suspendedSceneIds;
    saveBatchRuns(projectPath, [makeBatch(), legacy as unknown as BatchRunState]);
    const loaded = loadBatchRuns(projectPath);
    expect(loaded!.find((r) => r.batchId === 'b-legacy')!.suspendedSceneIds).toBeUndefined();
  });

  it('malformed JSON → null + warn（mirror loadStructureIssuesForLeader 防御；删文件即清态）', () => {
    mkdirSync(path.join(projectPath, '.orison'), { recursive: true });
    writeFileSync(path.join(projectPath, '.orison', 'batches.json'), '{not json', 'utf-8');
    expect(loadBatchRuns(projectPath)).toBeNull();
  });

  it('BOM 头容忍（Windows 编辑器写入场景）', () => {
    const batch = makeBatch();
    mkdirSync(path.join(projectPath, '.orison'), { recursive: true });
    writeFileSync(
      path.join(projectPath, '.orison', 'batches.json'),
      '﻿' + JSON.stringify([batch]),
      'utf-8',
    );
    const loaded = loadBatchRuns(projectPath);
    expect(loaded).toHaveLength(1);
    expect(loaded![0].batchId).toBe('b1');
  });

  it('per-element parse：单条畸形只丢该条（drop bad keep good）', () => {
    const good = makeBatch();
    const badGear = { ...makeBatch({ batchId: 'b2' }), gear: 'yolo' };
    mkdirSync(path.join(projectPath, '.orison'), { recursive: true });
    writeFileSync(
      path.join(projectPath, '.orison', 'batches.json'),
      JSON.stringify([good, badGear, { junk: true }]),
      'utf-8',
    );
    const loaded = loadBatchRuns(projectPath);
    expect(loaded).toHaveLength(1);
    expect(loaded![0].batchId).toBe('b1');
  });

  it('cap 10 LRU：save 超量保最新 10 条（createdAt 降序）', () => {
    const runs = Array.from({ length: 15 }, (_, i) => makeBatch({ batchId: `b${i}`, createdAt: i }));
    saveBatchRuns(projectPath, runs);
    const loaded = loadBatchRuns(projectPath);
    expect(loaded).toHaveLength(BATCH_RECORD_CAP);
    // 最新保留（createdAt 5..14），最旧（0..4）被 LRU 清。
    expect(loaded!.map((r) => r.batchId)).toEqual(
      expect.arrayContaining(['b14', 'b13', 'b5']),
    );
    expect(loaded!.some((r) => r.batchId === 'b0')).toBe(false);
  });

  it('upsert 按 batchId 替换（状态推进 doneSceneIds 累加）', () => {
    upsertBatchRun(projectPath, makeBatch());
    upsertBatchRun(projectPath, makeBatch({ doneSceneIds: ['s1'], status: 'paused' }));
    const loaded = loadBatchRuns(projectPath);
    expect(loaded).toHaveLength(1);
    expect(loaded![0].doneSceneIds).toEqual(['s1']);
    expect(loaded![0].status).toBe('paused');
  });

  it('findActiveBatchRun：只认 running + 会话匹配/孤儿可见；paused / done 不算活跃', () => {
    upsertBatchRun(projectPath, makeBatch({ sessionId: 'sess-1', status: 'paused' }));
    expect(findActiveBatchRun(projectPath, 'sess-1')).toBeUndefined();
    upsertBatchRun(projectPath, makeBatch({ sessionId: 'sess-1', status: 'running' }));
    expect(findActiveBatchRun(projectPath, 'sess-1')?.batchId).toBe('b1');
    // CR-007：孤儿可见——'sess-1' 无真实会话（内存/磁盘均无）→ 他 会话（sess-2）可接管（batch_status
    // 对账续跑 / end_batch 收口）。「他 会话 健在 → 不可见」的负例在 batch-tools.test（真 session）覆盖。
    expect(findActiveBatchRun(projectPath, 'sess-2')?.batchId).toBe('b1');
    // 记录无 sessionId（legacy）→ 任意会话命中。
    upsertBatchRun(projectPath, makeBatch({ batchId: 'legacy', createdAt: 2000, sessionId: undefined, status: 'running' }));
    expect(findActiveBatchRun(projectPath, 'sess-2')?.batchId).toBe('legacy');
    // 多 running（数据异常）→ newest 胜。
    expect(findActiveBatchRun(projectPath, 'sess-1')?.batchId).toBe('legacy');
  });
});

describe('Story 3.5 — 消息盖章 registry', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-batch-stamp-'));
  });

  afterEach(() => {
    clearActiveBatchStamp(projectPath);
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
  });

  it('无活跃批量 → 消息不盖章（零回归）', () => {
    const msg = { role: 'assistant', content: 'hi' };
    stampBatchOnMessage(projectPath, 'sess-1', msg as never);
    expect((msg as never as { batchId?: string }).batchId).toBeUndefined();
  });

  it('syncActiveBatchStamp 从磁盘恢复盖章（进程重启场景）+ progress 盖章', () => {
    upsertBatchRun(projectPath, makeBatch({ sessionId: 'sess-1' }));
    const active = syncActiveBatchStamp(projectPath, 'sess-1');
    expect(active?.batchId).toBe('b1');

    const assistantMsg: { role: string; batchId?: string; batchKind?: string } = { role: 'assistant' };
    stampBatchOnMessage(projectPath, 'sess-1', assistantMsg as never);
    expect(assistantMsg.batchId).toBe('b1');
    expect(assistantMsg.batchKind).toBe('progress');

    // tool 消息同样盖章；user 消息不盖。
    const toolMsg: { role: string; batchId?: string } = { role: 'tool' };
    stampBatchOnMessage(projectPath, 'sess-1', toolMsg as never);
    expect(toolMsg.batchId).toBe('b1');
    const userMsg: { role: string; batchId?: string } = { role: 'user' };
    stampBatchOnMessage(projectPath, 'sess-1', userMsg as never);
    expect(userMsg.batchId).toBeUndefined();
  });

  it('会话不匹配（他 会话 的批量）→ 不盖章', () => {
    upsertBatchRun(projectPath, makeBatch({ sessionId: 'sess-1' }));
    syncActiveBatchStamp(projectPath, 'sess-1');
    const other: { role: string; batchId?: string } = { role: 'assistant' };
    stampBatchOnMessage(projectPath, 'sess-2', other as never);
    expect(other.batchId).toBeUndefined();
  });

  it('end_batch(done) → markBatchStampReport：后续消息盖 report（L0 全景渲染源）', () => {
    upsertBatchRun(projectPath, makeBatch({ sessionId: 'sess-1' }));
    syncActiveBatchStamp(projectPath, 'sess-1');
    markBatchStampReport(projectPath, 'b1', 'sess-1');
    const msg: { role: string; batchId?: string; batchKind?: string } = { role: 'assistant' };
    stampBatchOnMessage(projectPath, 'sess-1', msg as never);
    expect(msg.batchId).toBe('b1');
    expect(msg.batchKind).toBe('report');
  });

  it('end_batch(aborted) → clear：不再盖章', () => {
    upsertBatchRun(projectPath, makeBatch({ sessionId: 'sess-1', status: 'aborted' }));
    // 磁盘已无 running → sync 清 stamp（turn 开始时同步即恢复诚实态）。
    syncActiveBatchStamp(projectPath, 'sess-1');
    const msg: { role: string; batchId?: string } = { role: 'assistant' };
    stampBatchOnMessage(projectPath, 'sess-1', msg as never);
    expect(msg.batchId).toBeUndefined();
  });

  it('setActiveBatchStamp mid-turn 生效（start_batch 同 turn 启动 → 后续消息立即盖章）', () => {
    setActiveBatchStamp(projectPath, 'b9', 'sess-1');
    const msg: { role: string; batchId?: string; batchKind?: string } = { role: 'assistant' };
    stampBatchOnMessage(projectPath, 'sess-1', msg as never);
    expect(msg.batchId).toBe('b9');
  });
});
