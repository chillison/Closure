import { describe, expect, it } from 'vitest';
import { RunStateStore } from '../src/runtime/runState';
import type { RunSnapshot } from '../src/contracts/run';

// Story 4.3 Step 1 / CR-2（implement.md 1.4）：RunStateStore.getChainSnapshot 读回入口测试。
//
// setChainSnapshot（4.0）只写无读——CR-2 缺口。本测试覆盖 getChainSnapshot 读写对称 + 缺省 undefined，
// 作 runChapterChain resume 读回的地基（design §3.3 / §10 证据表）。
//
// 纯逻辑测（不涉 LLM / generate / dispatchSubagent）——getChainSnapshot 是 RunStateStore 上的纯读方法。

function makeChainSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'run-test-1',
    status: 'completed',
    currentNodeId: null,
    projectPath: '/test/project',
    completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
    pendingNodes: ['multi-review-agent', 'route-agent'],
    artifacts: {
      scene_graph: { nodes: [{ id: 's1' }] },
      chapter_brief: { goal: 'g' },
      'draft.initial': { title: '草稿', text: '正文', wordCount: 100, chapterId: 'ep1' },
    },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
    ...overrides,
  };
}

describe('RunStateStore.getChainSnapshot（Story 4.3 Step 1 / CR-2 resume 读回）', () => {
  it('setChainSnapshot 后 getChainSnapshot 拿回同对象（读写对称）', () => {
    const store = new RunStateStore();
    const sessionId = 'sess-parent-1';
    const snapshot = makeChainSnapshot();

    expect(store.getChainSnapshot(sessionId)).toBeUndefined(); // 未写前 undefined
    store.setChainSnapshot(sessionId, snapshot);

    const readBack = store.getChainSnapshot(sessionId);
    expect(readBack).toBe(snapshot); // 同对象引用（纯读，不拷贝）
    expect(readBack?.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
    expect(readBack?.artifacts['chapter_brief']).toEqual({ goal: 'g' });
  });

  it('未写过 chainSnapshot 的 session → undefined（caller graceful 降级从头跑）', () => {
    const store = new RunStateStore();
    expect(store.getChainSnapshot('never-set')).toBeUndefined();
  });

  it('setChainSnapshot 覆盖后 getChainSnapshot 拿回最新（多次 checkpoint 持久）', () => {
    const store = new RunStateStore();
    const sessionId = 'sess-parent-2';
    const first = makeChainSnapshot({ runId: 'run-1', completedNodes: ['brief-compiler-node'] });
    store.setChainSnapshot(sessionId, first);
    expect(store.getChainSnapshot(sessionId)?.runId).toBe('run-1');

    // 后续 checkpoint（draft 完成后）覆盖
    const second = makeChainSnapshot({
      runId: 'run-1',
      completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
    });
    store.setChainSnapshot(sessionId, second);
    expect(store.getChainSnapshot(sessionId)?.completedNodes).toEqual([
      'brief-compiler-node',
      'draft-writer-agent',
    ]);
  });

  it('chainSnapshot 经 getSnapshot 也可查（RunStateSnapshot.chainSnapshot 字段同一持久）', () => {
    const store = new RunStateStore();
    const sessionId = 'sess-parent-3';
    const snapshot = makeChainSnapshot();
    store.setChainSnapshot(sessionId, snapshot);

    // getChainSnapshot 与 getSnapshot().chainSnapshot 指同一持久（单 source of truth）
    expect(store.getSnapshot(sessionId)?.chainSnapshot).toBe(store.getChainSnapshot(sessionId));
  });

  it('beginRun 保留既有 chainSnapshot（CR-2 跨 turn：resume 是新 turn 新 beginRun，不丢链段状态）', () => {
    // 生产场景：Turn 1 链段 pause 写 chainSnapshot → turn 结束 → Turn 2 resume = 新 turn = 新 beginRun。
    // 若 beginRun 清 chainSnapshot，getChainSnapshot 读 undefined → 降级从头跑（CR-2 闭环跨 turn 断）。
    // beginRun 须与其他生命周期方法（completeRun/failRun/abortRun/markAborted/resumeRun）一致保留之。
    const store = new RunStateStore();
    const sessionId = 'sess-cross-turn';
    const snapshot = makeChainSnapshot({ status: 'paused', currentNodeId: 'draft-writer-agent' });
    store.setChainSnapshot(sessionId, snapshot);
    expect(store.getChainSnapshot(sessionId)).toBe(snapshot);

    // 模拟 Turn 2 开始：leader sendMessage → beginRun 建 running snapshot
    store.beginRun(sessionId);

    // chainSnapshot 须存活（不被 beginRun 清）——resume 读回命中
    expect(store.getChainSnapshot(sessionId)).toBe(snapshot);
    expect(store.getSnapshot(sessionId)?.status).toBe('running');
    expect(store.getSnapshot(sessionId)?.chainSnapshot).toBe(snapshot);
  });
});
