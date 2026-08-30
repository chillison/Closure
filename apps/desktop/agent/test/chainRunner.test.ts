import { describe, expect, it, vi } from 'vitest';
import type { ReusableAgentNodeContract } from '@orison/shared-contracts';
import {
  runChain,
  summarizeRunSnapshot,
  resolveCheckpointStage,
} from '../src/runtime/chainRunner';
import { ChainAbortedError, decideCheckpointPause, deriveCheckpointPolicy } from '../src/contracts/run';
import type {
  ChainNodeDef,
  CheckpointPolicy,
  CheckpointStage,
  RunChainDeps,
  RunChainOptions,
  RunSnapshot,
} from '../src/contracts/run';
import type { AgentNode, NodeResult } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4.1/§4.3 / implement.md 4.4：runChain 驱动器（纯逻辑测，mock 节点 run()）。
//
// 核心断言（dispatch 4.4 列表）：
// 1. artifact 流转顺序（initial → 各节点 producedKey）
// 2. DAG 依赖缺失（requiredArtifactKeys 缺）→ blocked/error
// 3. revision 闭环（auto_revise → 重跑 from→through 切片；计数；cap 超限 → escalate）
// 4. accept_as_truth / escalate_user → 结束
// 5. 三 checkpoint stage 设点（onCheckpoint 被调，正确 stage）
// 6. error artifact（节点 mock 返 {artifact:{error:true}}）→ status='error' + break
// 7. abort（signal 已 abort）→ 抛 ChainAbortedError / checkpoint 保存
//
// 不涉真 generate/LLM——节点 run() 全 mock。GenerateFn 占位（mock 节点不调）。
// ─────────────────────────────────────────────────────────────────────────────

function makeSession(): SessionState {
  return {
    id: 'sess_test',
    agentName: 'test',
    projectPath: '/test/project',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeDeps(signal: AbortSignal = new AbortController().signal): RunChainDeps {
  return {
    generate: vi.fn(async () => ({ content: '', finishReason: 'stop' })),
    sessionContext: makeSession(),
    signal,
  };
}

/** mock 节点：run() 返固定 artifact（或 fn(run) 动态产）。记录调用次数到 calls[id]。 */
function makeNode(
  id: string,
  stateKey: string,
  artifactOrFn: unknown | ((run: RunSnapshot) => unknown),
  calls: Record<string, number>,
  requiredArtifactKeys: string[] = [],
  checkpointStage?: 'brief' | 'draft' | 'verdict',
): ChainNodeDef {
  const contract: ReusableAgentNodeContract | null = {
    nodeId: id,
    displayName: id,
    inputSchemaName: `${id}_in`,
    outputSchemaName: `${id}_out`,
    requiredArtifactKeys,
    producedArtifactKeys: [stateKey],
    sideEffects: [],
  };
  const node: AgentNode = {
    contract,
    async run({ run }): Promise<NodeResult> {
      calls[id] = (calls[id] ?? 0) + 1;
      const artifact =
        typeof artifactOrFn === 'function'
          ? (artifactOrFn as (r: RunSnapshot) => unknown)(run)
          : artifactOrFn;
      return { stateKey, artifact };
    },
  };
  return { id, node, ...(checkpointStage ? { checkpointStage } : {}) };
}

/** route 节点 mock：按 decision 序列依次返（第 n 次调用返 decisions[n-1]）。 */
function makeRouteNode(
  id: string,
  decisions: string[],
  calls: Record<string, number>,
  requiredArtifactKeys: string[] = [],
  checkpointStage?: 'brief' | 'draft' | 'verdict',
): ChainNodeDef {
  const contract: ReusableAgentNodeContract | null = {
    nodeId: id,
    displayName: id,
    inputSchemaName: `${id}_in`,
    outputSchemaName: 'routeDecisionSchema',
    requiredArtifactKeys,
    producedArtifactKeys: ['route_decision'],
    sideEffects: ['call_model'],
  };
  let callIdx = 0;
  const node: AgentNode = {
    contract,
    async run() {
      calls[id] = (calls[id] ?? 0) + 1;
      const decision = decisions[Math.min(callIdx, decisions.length - 1)];
      callIdx += 1;
      return { stateKey: 'route_decision', artifact: { decision, reason: `mock ${decision}` } };
    },
  };
  return { id, node, ...(checkpointStage ? { checkpointStage } : {}) };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. artifact 流转顺序
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — artifact 流转', () => {
  it('initial artifacts → 各节点按序产出 producedKey，下游可读上游 artifact', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', (run) => ({ from: run.artifacts['scene_graph'] }), calls),
      makeNode(
        'draft-writer-agent',
        'draft.initial',
        (run) => ({ title: 't', text: '正文', wordCount: 100, brief: run.artifacts['chapter_brief'] }),
        calls,
      ),
    ];
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: { scene_graph: { nodes: ['s1'] } },
      requirement: 'ep1',
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
    expect((snapshot.artifacts['chapter_brief'] as { from: unknown }).from).toEqual({ nodes: ['s1'] });
    expect((snapshot.artifacts['draft.initial'] as { brief: unknown }).brief).toEqual({ from: { nodes: ['s1'] } });
    expect(snapshot.pendingNodes).toEqual([]);
  });

  it('initialArtifacts 浅拷贝（runChain 不改 opts.initialArtifacts 引用对象）', async () => {
    const initial = { scene_graph: { nodes: ['s1'] } };
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { ok: true }, calls),
    ];
    await runChain({ chain, initialArtifacts: initial, requirement: '' }, makeDeps());
    expect(initial.chapter_brief).toBeUndefined(); // 产物不回流到 opts.initialArtifacts
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. DAG 依赖缺失 → blocked
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — DAG 依赖缺失', () => {
  it('requiredArtifactKeys 缺失 → status=blocked + errors 记录 + break（后续节点不跑）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { ok: true }, calls),
      makeNode(
        'draft-writer-agent',
        'draft.initial',
        { title: 't' },
        calls,
        ['chapter_brief', 'nonexistent_key'], // chapter_brief 有，nonexistent_key 缺
      ),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'pass' }, calls), // 不应跑
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' },
      makeDeps(),
    );

    expect(snapshot.status).toBe('blocked');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node']); // draft-writer 未完成
    expect(snapshot.errors?.some((e) => e.includes('draft-writer-agent') && e.includes('nonexistent_key'))).toBe(true);
    expect(calls['multi-review-agent']).toBeUndefined(); // break 后不跑
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. revision 闭环
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — revision 闭环', () => {
  // 链布局：brief(0) → targeted-revision(1, from) → multi-review(2) → route(3, through)
  // 切片 [from..through] = [1..3]，from<=through ✓（design §4.1 约束）
  function buildRevisionChain(
    routeDecisions: string[],
    calls: Record<string, number>,
  ): ChainNodeDef[] {
    return [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('targeted-revision-agent', 'revision.output', { title: '修订稿' }, calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'revise' }, calls),
      makeRouteNode('route-agent', routeDecisions, calls),
    ];
  }

  it('Story 7.4：auto_revise → break（status=auto_revise_pending）不再 loopFromIdx 裸跑切片（交 leader 驱动 redo）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'accept_as_truth'], calls);
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'targeted-revision-agent', through: 'route-agent', cap: 3 },
    };

    const snapshot = await runChain(opts, makeDeps());

    // auto_revise → break（不再重跑切片）；各节点只跑 1 次（无第二轮 loop）
    expect(snapshot.status).toBe('auto_revise_pending');
    expect(calls['targeted-revision-agent']).toBe(1);
    expect(calls['multi-review-agent']).toBe(1);
    expect(calls['route-agent']).toBe(1);
    // brief 只跑一次（在切片外）
    expect(calls['brief-compiler-node']).toBe(1);
    // routeDecision 携带 auto_revise（leader 据此驱动 redo）
    expect(snapshot.artifacts['route_decision']).toEqual({ decision: 'auto_revise', reason: 'mock auto_revise' });
    // currentNodeId 保留在 route 节点（与 completed/aborted null 区分，pause 同理）
    expect(snapshot.currentNodeId).toBe('route-agent');
  });

  it('Story 7.4：cap=0 → auto_revise 立即 escalate（cap 防御路径；正常 redo 循环 cap 在 leader）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'auto_revise', 'auto_revise'], calls);
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'targeted-revision-agent', through: 'route-agent', cap: 0 },
    };

    const snapshot = await runChain(opts, makeDeps());

    // cap=0：revisionCount=0 < 0 = false → 立即 escalate（cap 防御路径，防死循环）
    expect(snapshot.status).toBe('completed');
    expect(calls['route-agent']).toBe(1);
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('escalate_user');
    expect(snapshot.errors?.some((e) => e.includes('cap') && e.includes('0'))).toBe(true);
  });

  it('Story 4.6 D4（CR-Edge-1）：cap=0 强制 escalate + onAccept → 也调 onAccept 产 chapter_accept（对称 route-LLM escalate）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'auto_revise', 'auto_revise'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: 'cap 后稿' }, runId: snap.runId }),
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'targeted-revision-agent', through: 'route-agent', cap: 0 },
      onAccept,
    };

    const snapshot = await runChain(opts, makeDeps());

    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('escalate_user');
    // CR-Edge-1：cap-exceeded escalate 也调 onAccept（修与 route-LLM escalate 不对称）
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
  });

  it('revisionLoop.from index > through index → 启动抛 config error', async () => {
    const calls: Record<string, number> = {};
    // from='route-agent'(3) > through='targeted-revision-agent'(1) → 违反切片约束
    const chain = buildRevisionChain(['auto_revise'], calls);
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'route-agent', through: 'targeted-revision-agent', cap: 3 },
    };

    await expect(runChain(opts, makeDeps())).rejects.toThrow(/must be <= through index/);
  });

  it('revisionLoop.from / .through 不在 chain → 启动抛 config error', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['accept_as_truth'], calls);
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'nonexistent-from', through: 'route-agent', cap: 3 },
    };

    await expect(runChain(opts, makeDeps())).rejects.toThrow(/not found in chain/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. accept_as_truth / escalate_user → 链段结束
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — route 终止判定', () => {
  it('accept_as_truth → status=completed + 链段结束（无 revisionLoop 时也能正常跑完）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: 'x', wordCount: 1 }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'brief-compiler-node', through: 'route-agent', cap: 3 },
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('completed');
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('accept_as_truth');
  });

  it('无 revisionLoop：跑完所有节点 → status=completed', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls),
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' },
      makeDeps(),
    );

    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. 三 checkpoint stage 设点
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — 三类 checkpoint 设点', () => {
  it('brief-compiler→brief / draft-writer→draft / route-agent→verdict（onCheckpoint 被调 3 次正确 stage）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls, [], 'draft'),
      makeRouteNode('route-agent', ['accept_as_truth'], calls, [], 'verdict'),
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      onCheckpoint,
    };

    await runChain(opts, makeDeps());

    expect(onCheckpoint).toHaveBeenCalledTimes(3);
    expect(onCheckpoint.mock.calls[0][0]).toBe('brief');
    expect(onCheckpoint.mock.calls[1][0]).toBe('draft');
    expect(onCheckpoint.mock.calls[2][0]).toBe('verdict');
  });

  it('非 checkpoint 节点（未声明 checkpointStage）不触发 onCheckpoint（CR-13：显式声明取代子串推断）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', {}, calls, [], 'brief'), // brief
      makeNode('story-sync-agent', 'story.sync', { patches: [] }, calls), // 无 stage（即使 id 不含 checkpoint 关键字）
      makeRouteNode('route-agent', ['accept_as_truth'], calls, [], 'verdict'), // verdict
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    // 只 brief + verdict（story-sync 未声明 checkpointStage）
    expect(onCheckpoint).toHaveBeenCalledTimes(2);
    expect(onCheckpoint.mock.calls.map((c) => c[0])).toEqual(['brief', 'verdict']);
  });

  it('CR-13：id 含子串但未声明 checkpointStage → 不触发（显式声明取代旧 includes 推断，防假触发）', async () => {
    const calls: Record<string, number> = {};
    // 'draft-refiner-node' id 含 'draft' 子串，但未声明 checkpointStage → 不应触发（旧 includes 逻辑会误触发）
    const chain: ChainNodeDef[] = [
      makeNode('draft-refiner-node', 'draft.refined', { ok: true }, calls),
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );
    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it('onCheckpoint 收到当前 RunSnapshot（含已写 artifact，供 Step 5 持久 chainSnapshot）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'G' }, calls, [], 'brief'),
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    const snapshotArg = onCheckpoint.mock.calls[0][1] as RunSnapshot;
    expect(snapshotArg.artifacts['chapter_brief']).toEqual({ goal: 'G' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. error artifact → status=error + break
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — error artifact 检测', () => {
  it('节点返 {artifact:{error:true,...}} → status=error + errors 记录 + break（链段不崩）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode(
        'draft-writer-agent',
        'draft.initial',
        { error: true, nodeId: 'draft-writer-agent', message: 'LLM failed after 2 attempts' },
        calls,
      ),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'pass' }, calls), // 不应跑
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' },
      makeDeps(),
    );

    expect(snapshot.status).toBe('error');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node']);
    expect(snapshot.artifacts['draft.initial']).toMatchObject({ error: true });
    expect(snapshot.errors?.some((e) => e.includes('draft-writer-agent') && e.includes('LLM failed'))).toBe(true);
    expect(calls['multi-review-agent']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6b. CR-6：节点 sync throw（非 abort）→ error artifact + status=error（链段不崩）
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — 节点 throw 防御（CR-6）', () => {
  it('节点 run() throw 非 abort 错 → synthesize error artifact + status=error + break（链段不崩）', async () => {
    const calls: Record<string, number> = {};
    const throwingContract: ReusableAgentNodeContract = {
      nodeId: 'draft-writer-agent',
      displayName: 'draft-writer-agent',
      inputSchemaName: 'in',
      outputSchemaName: 'out',
      requiredArtifactKeys: [],
      producedArtifactKeys: ['draft.initial'],
      sideEffects: [],
    };
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      {
        id: 'draft-writer-agent',
        node: {
          contract: throwingContract,
          async run() {
            throw new Error('sync blow up (e.g. safeParse miss / unexpected)');
          },
        },
      },
      makeNode('multi-review-agent', 'review.latest', { verdict: 'pass' }, calls), // 不应跑
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' },
      makeDeps(),
    );

    expect(snapshot.status).toBe('error');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node']);
    // synthesize error artifact 写到 producedArtifactKeys[0]='draft.initial'
    expect((snapshot.artifacts['draft.initial'] as { error?: boolean }).error).toBe(true);
    expect(snapshot.errors?.some((e) => e.includes('draft-writer-agent') && e.includes('sync blow up'))).toBe(true);
    expect(calls['multi-review-agent']).toBeUndefined(); // break 后不跑
  });

  it('节点 run() throw AbortError → 传播（走 abort 路径，不吞成 error artifact）', async () => {
    const calls: Record<string, number> = {};
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    const chain: ChainNodeDef[] = [
      {
        id: 'brief-compiler-node',
        node: {
          contract: null,
          async run() {
            throw abortErr;
          },
        },
      },
    ];
    await expect(
      runChain({ chain, initialArtifacts: {}, requirement: '' }, makeDeps()),
    ).rejects.toBeInstanceOf(ChainAbortedError);
    // 注：ChainAbortedError.name='AbortError'，runChain 的 isAbortError 判定传播
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. abort → ChainAbortedError + checkpoint 保存
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — abort / resume', () => {
  it('signal 已 abort（预检）→ 抛 ChainAbortedError + status=aborted', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', {}, calls),
    ];
    const controller = new AbortController();
    controller.abort();
    const opts: RunChainOptions = { chain, initialArtifacts: {}, requirement: '' };

    await expect(runChain(opts, makeDeps(controller.signal))).rejects.toBeInstanceOf(ChainAbortedError);
    expect(calls['brief-compiler-node']).toBeUndefined(); // 预检在前，节点未跑
  });

  it('中途 abort（节点触发 controller.abort）→ 下个节点前抛 ChainAbortedError + onCheckpoint 持久', async () => {
    const calls: Record<string, number> = {};
    const controller = new AbortController();
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', {}, calls, [], 'brief'), // 跑完 → brief checkpoint
      makeNode(
        'draft-writer-agent',
        'draft.initial',
        () => {
          controller.abort(); // draft 跑完时触发 abort
          return { title: 't' };
        },
        calls,
        [],
        'draft',
      ),
      makeNode('route-agent', 'route_decision', { decision: 'accept_as_truth' }, calls, [], 'verdict'), // 不应跑
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      onCheckpoint,
    };

    await expect(runChain(opts, makeDeps(controller.signal))).rejects.toBeInstanceOf(ChainAbortedError);
    // draft 跑完→draft checkpoint 触发；abort 在下个节点前检测 → 抛时 lastStage='draft' → onCheckpoint 再调一次（持久）
    expect(calls['route-agent']).toBeUndefined();
    const stages = onCheckpoint.mock.calls.map((c) => c[0]);
    expect(stages).toContain('brief');
    expect(stages[stages.length - 1]).toBe('draft'); // abort 时用 lastCheckpointStage 持久
  });

  it('resumedCompletedNodes：跳过已完成节点（resume 恢复 artifacts+completedNodes）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 'resumed-draft' }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {
        chapter_brief: { goal: 'prior' }, // resume：brief 已跑过，artifact 已在
      },
      requirement: '',
      resumedCompletedNodes: ['brief-compiler-node'],
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('completed');
    expect(calls['brief-compiler-node']).toBeUndefined(); // 跳过
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent', 'route-agent']);
  });

  // Story 4.3 Step 1 / CR-2（implement.md 1.4）：resumedCompletedNodes 扩展——多节点 skip + artifact 恢复
  // （runChapterChain resume 读回 chainSnapshot 后喂本参数的生产路径佐证）。resume 跳过 brief+draft 两个节点，
  // initialArtifacts 含其产出（chapter_brief + draft.initial），后续节点（review/targeted/route）续跑。
  it('resumedCompletedNodes：跳过多个已完成节点 + initialArtifacts 恢复其产出（CR-2 多节点 skip）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 'resumed-draft' }, calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'pass' }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const opts: RunChainOptions = {
      chain,
      // resume：brief + draft 已跑过，其产出 artifact 已在（mirror runChapterChain resume 读回 snap.artifacts）
      initialArtifacts: {
        chapter_brief: { goal: 'prior' },
        'draft.initial': { title: 'resumed-draft', text: '正文', wordCount: 100 },
      },
      requirement: '',
      resumedCompletedNodes: ['brief-compiler-node', 'draft-writer-agent'],
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('completed');
    expect(calls['brief-compiler-node']).toBeUndefined(); // 跳过
    expect(calls['draft-writer-agent']).toBeUndefined(); // 跳过
    expect(calls['multi-review-agent']).toBe(1); // 续跑
    expect(calls['route-agent']).toBe(1); // 续跑
    // completedNodes 含 resumed（前缀）+ 续跑节点
    expect(snapshot.completedNodes).toEqual([
      'brief-compiler-node',
      'draft-writer-agent',
      'multi-review-agent',
      'route-agent',
    ]);
    // artifact 恢复：brief/draft 产出从 initialArtifacts 恢复（未被重跑覆盖）
    expect((snapshot.artifacts['chapter_brief'] as { goal: string }).goal).toBe('prior');
    expect((snapshot.artifacts['draft.initial'] as { title: string }).title).toBe('resumed-draft');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// summarizeRunSnapshot — context isolation
// ════════════════════════════════════════════════════════════════════════════

describe('summarizeRunSnapshot — context isolation（不抽内部 trace）', () => {
  it('抽 status / routeDecision / reviewVerdict / draftTitle/wordCount/text / errors', () => {
    const snapshot: RunSnapshot = {
      runId: 'r1',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'accept_as_truth', reason: '正文升级' },
        'review.latest': { verdict: 'revise', summary: 's', reasons: ['r'] },
        'draft.initial': { title: '第二章', text: '正文内容……', wordCount: 2800 },
        'scene_graph': { nodes: ['s1', 's2'] }, // 内部 trace，不应进 summary
        'chapter_brief': { goal: 'g' }, // 内部 trace
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: ['some warning'],
    };

    const summary = summarizeRunSnapshot(snapshot);

    expect(summary.status).toBe('completed');
    expect(summary.routeDecision).toEqual({ decision: 'accept_as_truth', reason: '正文升级' });
    expect(summary.reviewVerdict).toBe('revise');
    expect(summary.draftTitle).toBe('第二章');
    expect(summary.draftWordCount).toBe(2800);
    // CR-15a：draftText 抽出（prose 是 deliverable，豁免 context isolation）
    expect(summary.draftText).toBe('正文内容……');
    expect(summary.errors).toEqual(['some warning']);
  });

  it('#107 R1.1c：route_decision.deviation=true → summary.routeDecision.deviation=true 投影（补产 storyDecisions 数据源）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-dev',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'accept_as_truth', reason: '角色突然硬气', deviation: true },
        'draft.initial': { text: '正文。' },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    expect(summary.routeDecision).toEqual({
      decision: 'accept_as_truth',
      reason: '角色突然硬气',
      deviation: true,
    });
  });

  it('#107 R1.1c：deviation=false / 缺省 → 投影省略（零噪音，routeDecision 形态与修前一致）', () => {
    for (const deviation of [false, undefined]) {
      const summary = summarizeRunSnapshot({
        runId: 'r-nodev',
        status: 'completed',
        currentNodeId: null,
        projectPath: '/p',
        completedNodes: [],
        pendingNodes: [],
        artifacts: {
          'route_decision': { decision: 'accept_as_truth', reason: '通过', ...(deviation !== undefined ? { deviation } : {}) },
        },
        review: null,
        archive: null,
        delivery: null,
        feedback: null,
      });
      expect(summary.routeDecision).toEqual({ decision: 'accept_as_truth', reason: '通过' });
    }
  });

  it('Story 8.4 Step 3：research_brief.verdict.archive_issues 抽 archiveIssues（坏条目丢好条目留；空/缺零痕迹）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-ammo',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'research_brief': {
          brief: { plan: 'p' },
          briefHash: 'sha256:x',
          verdict: {
            checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
            pass: true,
            gaps: [],
            suggestions: [],
            archive_issues: [
              { card_ref: 'char-lin', problem: '卡片记录的伤臂与第 3 章正文矛盾' },
              { problem: '坏条目（缺 card_ref）' }, // per-element safeParse 拒
            ],
          },
        },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    expect(summary.archiveIssues).toEqual([
      { card_ref: 'char-lin', problem: '卡片记录的伤臂与第 3 章正文矛盾' },
    ]);

    // 无 verdict / 空数组 → 零痕迹（不带空载荷）。
    const empty = summarizeRunSnapshot({
      runId: 'r-ammo2',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: { 'research_brief': { brief: { plan: 'p' }, briefHash: 'sha256:x' } },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    expect(empty.archiveIssues).toBeUndefined();
  });

  it('CR-3：draft.initial 缺 → draftTitle/draftText undefined（revision.output 死 fallback 已删）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r2',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        // 链段不再产 revision.output（targeted-revision overwrite draft.initial，design §4 决断）；
        // 旧 revision.output fallback 已删 → 无 draft artifact 时 draftTitle/draftText 均 undefined。
        'revision.output': { title: '修订版', text: '...', wordCount: 3000 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    expect(summary.draftTitle).toBeUndefined();
    expect(summary.draftText).toBeUndefined();
    expect(summary.draftWordCount).toBeUndefined();
  });

  it('空 artifacts → summary 只剩 status + 空 errors（不抛）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r3',
      status: 'blocked',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {},
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.status).toBe('blocked');
    expect(summary.routeDecision).toBeUndefined();
    expect(summary.reviewVerdict).toBeUndefined();
    expect(summary.draftTitle).toBeUndefined();
    expect(summary.errors).toEqual([]);
  });

  it('不抽内部 trace artifacts（context isolation）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r4',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'scene_graph': { big: 'internal' },
        'settings_context': 'long prefix text',
        'chapter_brief': { goal: 'g' },
        'story.sync': { patches: [] },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    // summary 不含内部 artifact 字段（只有 status/routeDecision/reviewVerdict/draft*/errors）
    const keys = Object.keys(summary);
    expect(keys).not.toContain('scene_graph');
    expect(keys).not.toContain('settings_context');
    expect(summary.draftTitle).toBeUndefined();
    expect(summary.routeDecision).toBeUndefined();
  });

  it('4.1 Step 4：chapter_accept artifact 抽进 summary（deliverable，同 CR-15a draftText 豁免）', () => {
    const chapterAccept = {
      chapterId: 'ch_001',
      candidate: { content: '正文' },
      storyDecisions: [],
      runId: 'r1',
    };
    const summary = summarizeRunSnapshot({
      runId: 'r-ca',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'chapter_accept': chapterAccept,
        'draft.initial': { title: 't', text: '正文', wordCount: 1 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.chapter_accept).toEqual(chapterAccept);
  });

  it('4.1 Step 4：无 chapter_accept artifact → summary.chapter_accept 缺省（key 不出现）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-no-ca',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {},
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.chapter_accept).toBeUndefined();
    expect(Object.keys(summary)).not.toContain('chapter_accept');
  });

  it('Story 4.6：route=escalate_user 时抽 review.latest findings（block+warn，drop info）填 escalateFindings', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-esc',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'escalate_user', reason: '灰区' },
        'review.latest': {
          verdict: 'escalate',
          dimensions: [
            { name: 'consistency', findings: [
              { severity: 'block', quote: '硬气', location: '段1句2', explanation: 'OOC 嫌疑', subClass: 'Characterization.memory' },
              { severity: 'info', quote: '噪声', location: '段1句3', explanation: '可忽略' }, // drop（info 非灰区）
            ] },
            { name: 'narrative-feature', findings: [
              { severity: 'warn', quote: '意象陈腐', location: '段2句1', explanation: '骨架偏 AI' },
            ] },
          ],
        },
        'draft.initial': { title: 't', text: '正文', wordCount: 1 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.escalateFindings).toEqual([
      { severity: 'block', quote: '硬气', location: '段1句2', explanation: 'OOC 嫌疑', subClass: 'Characterization.memory' },
      { severity: 'warn', quote: '意象陈腐', location: '段2句1', explanation: '骨架偏 AI' },
    ]);
  });

  it('Story 8.4 Step 6：findings attribution 三态随 escalateFindings 机械透传（值外字面量丢弃）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-attr',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'escalate_user', reason: '灰区' },
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'consistency',
              findings: [
                {
                  severity: 'block',
                  quote: '守门人对峙没写',
                  location: '段1',
                  explanation: '执行案安排了对峙但正文直接进城',
                  attribution: 'execution_gap',
                },
                {
                  severity: 'warn',
                  quote: '配角行踪矛盾',
                  location: '段2',
                  explanation: '任务卡层就没安排这条线',
                  attribution: 'plan_level',
                },
                {
                  severity: 'warn',
                  quote: '非法归因值',
                  location: '段3',
                  explanation: 'LLM 产了值外字面量',
                  attribution: 'writer_fault',
                },
                {
                  severity: 'warn',
                  quote: '无归因 finding',
                  location: '段4',
                  explanation: '与计划无关不标',
                },
              ],
            },
          ],
        },
        'draft.initial': { title: 't', text: '正文', wordCount: 1 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    // 合法三态透传（裁决器/用户判「正文 vs 计划哪个好」需知问题在哪层）；值外字面量丢弃；无 attribution 保持缺省。
    expect(summary.escalateFindings).toEqual([
      { severity: 'block', quote: '守门人对峙没写', location: '段1', explanation: '执行案安排了对峙但正文直接进城', attribution: 'execution_gap' },
      { severity: 'warn', quote: '配角行踪矛盾', location: '段2', explanation: '任务卡层就没安排这条线', attribution: 'plan_level' },
      { severity: 'warn', quote: '非法归因值', location: '段3', explanation: 'LLM 产了值外字面量' },
      { severity: 'warn', quote: '无归因 finding', location: '段4', explanation: '与计划无关不标' },
    ]);
  });

  it('Story 4.6：非 escalate route → escalateFindings 缺省（即便 review 有 findings 也不抽）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-no-esc',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'accept_as_truth', reason: '升级' },
        'review.latest': {
          verdict: 'pass',
          dimensions: [{ name: 'consistency', findings: [{ severity: 'block', quote: 'q', location: 'l', explanation: 'e' }] }],
        },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.escalateFindings).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. onAccept — accept 分支产 chapter_accept artifact（4.1 Step 4 / CR-15b）
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — onAccept（accept 分支产 chapter_accept，不写盘）', () => {
  it('route=accept_as_truth → 调 onAccept + chapter_accept 写入 artifacts + ctx.nowISO 透传', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(
      (snap: RunSnapshot, ctx: { nowISO: string }) => ({
        chapterId: 'ch_001',
        candidate: { content: String(snap.artifacts['draft.initial']) },
        runId: snap.runId,
        _ctxNowISO: ctx.nowISO,
      }),
    );
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文', wordCount: 1 }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'brief-compiler-node', through: 'route-agent', cap: 3 },
      onAccept,
      nowISO: '2026-08-01T00:00:00.000Z',
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(onAccept).toHaveBeenCalledTimes(1);
    // ctx.nowISO 从 opts.nowISO 透传
    const ctxArg = onAccept.mock.calls[0][1] as { nowISO: string };
    expect(ctxArg.nowISO).toBe('2026-08-01T00:00:00.000Z');
    // chapter_accept 写入 run.artifacts
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({
      chapterId: 'ch_001',
      _ctxNowISO: '2026-08-01T00:00:00.000Z',
    });
  });

  it('Story 4.6 D4 v2：route=escalate_user 无 draft → 仍调 onAccept（去 hasDraftText 门，buildChapterAccept 单源判 draft，CR-Edge-2 修误诊）', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(); // 返 undefined（mock 无返）→ 不产 chapter_accept（模拟 buildChapterAccept 返 skipReason）
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeRouteNode('route-agent', ['escalate_user'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        revisionLoop: { from: 'brief-compiler-node', through: 'route-agent', cap: 3 },
        onAccept,
      },
      makeDeps(),
    );
    // D4 v2：escalate 总调 onAccept（去 hasDraftText 门）——入口层 buildChapterAccept 单源判 draft
    expect(onAccept).toHaveBeenCalledTimes(1);
    // onAccept 返 undefined / skipReason → 不写 chapter_accept
    expect(snapshot.artifacts['chapter_accept']).toBeUndefined();
  });

  it('Story 4.6 D4：route=escalate_user 有 draft → 调 onAccept 产 chapter_accept（候选载荷，PatchReview 作裁决 UI）', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: '正文' }, runId: snap.runId }),
    );
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文', wordCount: 1 }, calls),
      makeRouteNode('route-agent', ['escalate_user'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        revisionLoop: { from: 'brief-compiler-node', through: 'route-agent', cap: 3 },
        onAccept,
      },
      makeDeps(),
    );
    // D4：escalate 有 draft → 调 onAccept 产 chapter_accept（候选载荷，PatchReview accept 才落盘/登记）
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
  });

  it('Story 7.4：route=auto_revise → break（status=auto_revise_pending）不调 onAccept（非终态，交 leader）', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: 'x' }, runId: snap.runId }),
    );
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('targeted-revision-agent', 'draft.initial', { title: 't', text: '正文' }, calls),
      makeRouteNode('route-agent', ['auto_revise', 'accept_as_truth'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        revisionLoop: { from: 'targeted-revision-agent', through: 'route-agent', cap: 3 },
        onAccept,
      },
      makeDeps(),
    );
    // auto_revise → break（status=auto_revise_pending），onAccept 不调（非终态，交 leader 驱动 redo）
    expect(snapshot.status).toBe('auto_revise_pending');
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('onAccept 返 undefined（chapterId 映射失败） → 不写 chapter_accept（accept 持久化阻断）', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(() => undefined);
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文' }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        revisionLoop: { from: 'brief-compiler-node', through: 'route-agent', cap: 3 },
        onAccept,
      },
      makeDeps(),
    );
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toBeUndefined();
  });

  it('onAccept 缺省（4.0 既有链段） → accept 分支正常结束，无 chapter_accept（向后兼容）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文' }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        revisionLoop: { from: 'brief-compiler-node', through: 'route-agent', cap: 3 },
      },
      makeDeps(),
    );
    expect(snapshot.status).toBe('completed');
    expect(snapshot.artifacts['chapter_accept']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Story 4.3 Step 2 — pause 机制（onCheckpoint async 返 {action:'pause'}）
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — Story 4.3 Step 2 pause 机制', () => {
  it('onCheckpoint 返 {action:"pause"} → status=paused + currentNodeId 停该 checkpoint 节点 + break（后续不跑）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文', wordCount: 2 }, calls, [], 'draft'),
      makeRouteNode('route-agent', ['accept_as_truth'], calls, [], 'verdict'), // 不应跑（pause 在 draft 后 break）
    ];
    // draft checkpoint 返 pause（半自动 suggest 模式行为模拟）
    const onCheckpoint = vi.fn(
      async (stage: CheckpointStage) =>
        stage === 'draft' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const opts: RunChainOptions = { chain, initialArtifacts: {}, requirement: '', onCheckpoint };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('paused');
    // currentNodeId 停在 draft checkpoint 节点（不 null，区分 completed/aborted）
    expect(snapshot.currentNodeId).toBe('draft-writer-agent');
    // brief + draft 完成（draft artifact 已写）；route 未跑（pause 后 break）
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
    expect(calls['route-agent']).toBeUndefined();
    // draft artifact 已写（pause 在 checkpoint staging 时触发，artifact 先写后 checkpoint）
    expect((snapshot.artifacts['draft.initial'] as { text: string }).text).toBe('正文');
  });

  it('onCheckpoint 返 {action:"continue"} 全程 → 链段连续跑完（全自动零回归 = 4.0 行为）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls, [], 'draft'),
      makeRouteNode('route-agent', ['accept_as_truth'], calls, [], 'verdict'),
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    // 全程 continue → 跑完（route accept 终止）status=completed，无 pause
    expect(snapshot.status).toBe('completed');
    expect(snapshot.currentNodeId).toBeNull();
    expect(onCheckpoint).toHaveBeenCalledTimes(3); // brief + draft + verdict 三 checkpoint 都触
  });

  it('brief checkpoint pause（微操 readonly 模式：第一个 checkpoint 就停）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls, [], 'draft'), // 不应跑
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'pause' as const }));
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    expect(snapshot.status).toBe('paused');
    expect(snapshot.currentNodeId).toBe('brief-compiler-node');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node']);
    expect(calls['draft-writer-agent']).toBeUndefined();
  });

  it('无 onCheckpoint（缺省）→ 不 pause，连续跑完（向后兼容 4.0 链段无 onCheckpoint 场景）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls, [], 'draft'),
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' }, // 无 onCheckpoint
      makeDeps(),
    );
    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Story 4.3 Step 2 — paused summary（summarizeRunSnapshot + pauseHint）
// ════════════════════════════════════════════════════════════════════════════

describe('summarizeRunSnapshot — Story 4.3 Step 2 paused payload', () => {
  it('status=paused + pauseHint → 抽 pausedStage + draftContent（draft checkpoint）', () => {
    const summary = summarizeRunSnapshot(
      {
        runId: 'r-pause',
        status: 'paused',
        currentNodeId: 'draft-writer-agent',
        projectPath: '/p',
        completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
        pendingNodes: ['route-agent'],
        artifacts: {
          'chapter_brief': { goal: 'g' },
          'draft.initial': { title: '第二章', text: '黄昏的荒野上。', wordCount: 100 },
        },
        review: null,
        archive: null,
        delivery: null,
        feedback: null,
        errors: [],
      },
      { pausedStage: 'draft' },
    );

    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('draft');
    // draftContent 抽正文（review payload，同 CR-15a 豁免 isolation）
    expect(summary.draftContent).toBe('黄昏的荒野上。');
  });

  it('status=paused + pauseHint → 抽 briefContent（brief checkpoint）', () => {
    const brief = { goal: 'G', episodeId: 'ep1', tone: '紧张' };
    const summary = summarizeRunSnapshot(
      {
        runId: 'r-pause-brief',
        status: 'paused',
        currentNodeId: 'brief-compiler-node',
        projectPath: '/p',
        completedNodes: ['brief-compiler-node'],
        pendingNodes: ['draft-writer-agent'],
        artifacts: { chapter_brief: brief },
        review: null,
        archive: null,
        delivery: null,
        feedback: null,
        errors: [],
      },
      { pausedStage: 'brief' },
    );

    expect(summary.pausedStage).toBe('brief');
    expect(summary.briefContent).toEqual(brief);
    // brief checkpoint 时 draft 未产 → draftContent 缺省
    expect(summary.draftContent).toBeUndefined();
  });

  it('pauseHint 缺省（runChapterChain 未传）→ pausedStage undefined（仍抽 draft/brief content 若在）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-pause-nohint',
      status: 'paused',
      currentNodeId: 'draft-writer-agent',
      projectPath: '/p',
      completedNodes: ['draft-writer-agent'],
      pendingNodes: [],
      artifacts: { 'draft.initial': { title: 't', text: '稿', wordCount: 1 } },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    }); // 无 pauseHint

    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBeUndefined();
    expect(summary.draftContent).toBe('稿');
  });

  it('非 paused 状态（completed/aborted 等）→ 不抽 paused payload（零回归）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-completed',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'draft.initial': { title: 't', text: '稿', wordCount: 1 },
        chapter_brief: { goal: 'g' },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });

    expect(summary.status).toBe('completed');
    expect(summary.pausedStage).toBeUndefined();
    expect(summary.draftContent).toBeUndefined();
    expect(summary.briefContent).toBeUndefined();
    // draftText 仍抽（CR-15a 不变）
    expect(summary.draftText).toBe('稿');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. resolveCheckpointStage（runChapterChain 据 currentNodeId 解析 pausedStage 用）
// ════════════════════════════════════════════════════════════════════════════

describe('resolveCheckpointStage — Story 4.3 Step 2', () => {
  it('nodeId 命中 chain 中带 checkpointStage 的节点 → 返其 stage', () => {
    const chain: ChainNodeDef[] = [
      { id: 'brief-compiler-node', node: null as any, checkpointStage: 'brief' },
      { id: 'draft-writer-agent', node: null as any, checkpointStage: 'draft' },
      { id: 'story-sync-agent', node: null as any }, // 无 checkpointStage
      { id: 'route-agent', node: null as any, checkpointStage: 'verdict' },
    ];
    expect(resolveCheckpointStage(chain, 'draft-writer-agent')).toBe('draft');
    expect(resolveCheckpointStage(chain, 'brief-compiler-node')).toBe('brief');
    expect(resolveCheckpointStage(chain, 'route-agent')).toBe('verdict');
  });

  it('nodeId 命中但节点无 checkpointStage → undefined', () => {
    const chain: ChainNodeDef[] = [{ id: 'story-sync-agent', node: null as any }];
    expect(resolveCheckpointStage(chain, 'story-sync-agent')).toBeUndefined();
  });

  it('nodeId 不在 chain / nodeId=null → undefined（defensive）', () => {
    const chain: ChainNodeDef[] = [{ id: 'brief-compiler-node', node: null as any, checkpointStage: 'brief' }];
    expect(resolveCheckpointStage(chain, 'nonexistent')).toBeUndefined();
    expect(resolveCheckpointStage(chain, null)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. deriveCheckpointPolicy（§4 permissionMode → CheckpointPolicy 映射）
// ════════════════════════════════════════════════════════════════════════════

describe('deriveCheckpointPolicy — Story 4.3 §4 映射表', () => {
  it('auto（全权/全自动）→ 无 scheduled pause + auto-trust escalate', () => {
    const policy: CheckpointPolicy = deriveCheckpointPolicy('auto');
    expect(policy.pauseStages).toEqual([]);
    expect(policy.escalateMode).toBe('auto-trust');
  });

  it('suggest（半自动）→ draft checkpoint pause + ask escalate', () => {
    const policy: CheckpointPolicy = deriveCheckpointPolicy('suggest');
    expect(policy.pauseStages).toEqual(['draft']);
    expect(policy.escalateMode).toBe('ask');
  });

  it('readonly（微操/细分）→ brief+draft+verdict 全 checkpoint pause + ask escalate', () => {
    const policy: CheckpointPolicy = deriveCheckpointPolicy('readonly');
    expect(policy.pauseStages).toEqual(['brief', 'draft', 'verdict']);
    expect(policy.escalateMode).toBe('ask');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. CR-08-02-autonomy-modes-001（critical，三 reviewer 独立确认）：verdict checkpoint 时序
//     readonly（微操）模式 verdict pause 抢断 route 终态处理 → silent data loss（accept 候选丢 /
//     revision 改稿丢 / escalate 裁决丢）。修后：through 节点 verdict checkpoint 在「终态处理后」fire；
//     auto_revise loop 不 pause（非终态）；accept/escalate/cap-escalate 先 onAccept 产 chapter_accept 再 pause。
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — CR-08-02-autonomy-modes-001 verdict checkpoint 时序', () => {
  // 链布局：brief(0) → targeted-revision(1, from) → multi-review(2) → route(3, through, verdict)
  function buildRevisionChain(
    routeDecisions: string[],
    calls: Record<string, number>,
  ): ChainNodeDef[] {
    return [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('targeted-revision-agent', 'draft.initial', { title: '修订稿' }, calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'revise' }, calls),
      makeRouteNode('route-agent', routeDecisions, calls, [], 'verdict'),
    ];
  }

  it('route=accept + verdict pauseStages → verdict checkpoint 在 onAccept 后 fire（chapter_accept 先产，pause 时候选已在 artifacts）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['accept_as_truth'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: '正文' }, runId: snap.runId }),
    );
    // verdict pause（模拟 readonly 微操模式 pauseStages 含 verdict）
    const checkpointSnapshots: { stage: CheckpointStage; hasChapterAccept: boolean }[] = [];
    const onCheckpoint = vi.fn(async (stage: CheckpointStage, snap: RunSnapshot) => {
      checkpointSnapshots.push({ stage, hasChapterAccept: !!snap.artifacts['chapter_accept'] });
      return stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const };
    });
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'targeted-revision-agent', through: 'route-agent', cap: 3 },
      onAccept,
      onCheckpoint,
    };

    const snapshot = await runChain(opts, makeDeps());

    // verdict pause 抢断 complete（status='paused'），但 onAccept 已调（终态处理在 pause 前）
    expect(snapshot.status).toBe('paused');
    expect(snapshot.currentNodeId).toBe('route-agent');
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
    // 关键时序断言：verdict checkpoint fire 时 chapter_accept 已在 artifacts（onAccept 先于 verdict pause）
    const verdictCheckpoint = checkpointSnapshots.find((c) => c.stage === 'verdict');
    expect(verdictCheckpoint).toBeDefined();
    expect(verdictCheckpoint!.hasChapterAccept).toBe(true);
  });

  it('Story 7.4：route=auto_revise + verdict pauseStages → break（auto_revise 非终态不 pause；persist-only verdict 调用）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'accept_as_truth'], calls);
    const onCheckpoint = vi.fn(async (stage: CheckpointStage) =>
      stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'targeted-revision-agent', through: 'route-agent', cap: 3 },
      onCheckpoint,
    };

    const snapshot = await runChain(opts, makeDeps());

    // auto_revise → break（status=auto_revise_pending），不在 auto_revise 时 verdict pause（CR-08-02-autonomy-modes-001）
    expect(snapshot.status).toBe('auto_revise_pending');
    expect(snapshot.currentNodeId).toBe('route-agent');
    expect(snapshot.artifacts['route_decision']).toMatchObject({ decision: 'auto_revise' });
    expect(calls['route-agent']).toBe(1); // 1 次 route（auto_revise break，无第二轮 loop）
    expect(calls['targeted-revision-agent']).toBe(1); // 不 loop 重跑
    // verdict checkpoint fire 一次（Story 7.4：persist-only——break 前 persist snapshot 供 redo resume，
    // pause 决策忽略：onCheckpoint 返 pause 但 status 是 auto_revise_pending 非 paused）
    const verdictCalls = onCheckpoint.mock.calls.filter((c) => c[0] === 'verdict');
    expect(verdictCalls).toHaveLength(1);
  });

  it('route=escalate_user + verdict pauseStages → verdict checkpoint 在 escalate 处理后 fire（D4 v2：onAccept 对称调）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['escalate_user'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: '灰区稿' }, runId: snap.runId }),
    );
    const onCheckpoint = vi.fn(async (stage: CheckpointStage) =>
      stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'targeted-revision-agent', through: 'route-agent', cap: 3 },
      onAccept,
      onCheckpoint,
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('paused');
    expect(snapshot.artifacts['route_decision']).toMatchObject({ decision: 'escalate_user' });
    // D4 v2：escalate 也调 onAccept（候选给 PatchReview 裁决），在 verdict pause 前
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
  });

  it('Story 7.4：cap=0 → 强制 escalate → onAccept + verdict checkpoint 对称（cap-escalate 终态处理完整，不 silent drop）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'auto_revise', 'auto_revise'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_cap', candidate: { content: 'cap 后稿' }, runId: snap.runId }),
    );
    const onCheckpoint = vi.fn(async (stage: CheckpointStage) =>
      stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      revisionLoop: { from: 'targeted-revision-agent', through: 'route-agent', cap: 0 },
      onAccept,
      onCheckpoint,
    };

    const snapshot = await runChain(opts, makeDeps());

    // cap=0：auto_revise 立即 cap-exceeded → escalate → onAccept 对称（D4）+ verdict checkpoint（终态处理后）
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('escalate_user');
    expect(snapshot.status).toBe('paused'); // verdict pause（pauseStages 含 verdict）
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_cap' });
    // cap=0 → route 只调 1 次（立即 escalate，无 loop 重跑）
    expect(calls['route-agent']).toBe(1);
  });

  it('resume 正确性：verdict pause（chapter_accept 已产）→ resumedCompletedNodes 含 route → 续跑无剩节点 → complete（候选在）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['accept_as_truth'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: '正文' }, runId: snap.runId }),
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {
        chapter_brief: { goal: 'g' },
        'draft.initial': { title: '修订稿' },
        'review.latest': { verdict: 'pass' },
        route_decision: { decision: 'accept_as_truth', reason: 'mock' },
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文' }, runId: 'r-prior' },
      },
      requirement: '',
      revisionLoop: { from: 'targeted-revision-agent', through: 'route-agent', cap: 3 },
      onAccept,
      resumedCompletedNodes: [
        'brief-compiler-node',
        'targeted-revision-agent',
        'multi-review-agent',
        'route-agent',
      ],
    };

    const snapshot = await runChain(opts, makeDeps());

    // resume-continue：route 在 completedNodes → 前缀跳过 → 链段无剩节点 → complete
    expect(snapshot.status).toBe('completed');
    expect(snapshot.currentNodeId).toBeNull();
    // chapter_accept 从 initialArtifacts 恢复（resume 候选在，无 silent drop）
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
    // 节点全 skip → onAccept 不再调（终态处理在 verdict pause 前已跑）
    expect(onAccept).not.toHaveBeenCalled();
    expect(calls['route-agent']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14. Story 8.4 Step 4（A7/A8）：出发核查挂起 → pause（decideCheckpointPause 单源 + summarize 投影）
//
// 挂起 ≠ 错误：节点产非 error 的 research_brief 结果（携 suspended）→ chainRunner 记 completedNodes +
// fire draft checkpoint → decideCheckpointPause（workflow onCheckpoint 闭包单源调用的纯函数，此处直测
// 同一函数）读 suspended → **全档位 pause（含 auto——结构性矛盾不带病开写）**。恢复 = redo。
// ════════════════════════════════════════════════════════════════════════════

describe('decideCheckpointPause — Story 8.4 Step 4（pause 判定单源）', () => {
  const suspendedSnapshot = (): RunSnapshot => ({
    runId: 'r1',
    status: 'running',
    currentNodeId: 'draft-writer-agent',
    projectPath: '/p',
    completedNodes: [],
    pendingNodes: [],
    artifacts: {
      research_brief: {
        briefHash: 'sha256:x',
        suspended: {
          kind: 'research_contradiction',
          rounds: 1,
          evidence: {
            contradictions: [{ desc: '矛盾', severity: 'contradiction' }],
            deviations: [],
          },
        },
      },
    },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  });

  it('挂起 + auto（pauseStages=[]）→ pause（全档位无例外——A8 核心断言）', () => {
    expect(decideCheckpointPause('draft', suspendedSnapshot(), deriveCheckpointPolicy('auto'))).toEqual({ action: 'pause' });
  });

  it('挂起 + suggest / readonly → pause（与 mode 驱动 pause 同为 pause）', () => {
    expect(decideCheckpointPause('draft', suspendedSnapshot(), deriveCheckpointPolicy('suggest'))).toEqual({ action: 'pause' });
    expect(decideCheckpointPause('draft', suspendedSnapshot(), deriveCheckpointPolicy('readonly'))).toEqual({ action: 'pause' });
  });

  it('挂起 + policy 缺省（4.0 既有 / 无 mode 消费方）→ 仍 pause（suspension 驱动不受 policy 缺省豁免）', () => {
    expect(decideCheckpointPause('draft', suspendedSnapshot(), undefined)).toEqual({ action: 'pause' });
  });

  it('无挂起 + auto → continue（正常 draft checkpoint 全自动零回归）', () => {
    const snap = suspendedSnapshot();
    delete (snap.artifacts['research_brief'] as Record<string, unknown>).suspended;
    expect(decideCheckpointPause('draft', snap, deriveCheckpointPolicy('auto'))).toEqual({ action: 'continue' });
  });

  it('无挂起 + suggest（pauseStages 含 draft）→ pause（mode 驱动路径零回归）', () => {
    const snap = suspendedSnapshot();
    delete (snap.artifacts['research_brief'] as Record<string, unknown>).suspended;
    expect(decideCheckpointPause('draft', snap, deriveCheckpointPolicy('suggest'))).toEqual({ action: 'pause' });
  });

  it('挂起只作用 draft stage（brief/verdict 载荷在场不触发——挂起节点位在 draft）', () => {
    expect(decideCheckpointPause('brief', suspendedSnapshot(), deriveCheckpointPolicy('auto'))).toEqual({ action: 'continue' });
    expect(decideCheckpointPause('verdict', suspendedSnapshot(), deriveCheckpointPolicy('auto'))).toEqual({ action: 'continue' });
  });

  it('Story 7.2 零回归：revision-guard soft-violation → pause（任意 policy）；clean → continue', () => {
    const guardSnap = (verdict: string): RunSnapshot => ({
      ...suspendedSnapshot(),
      artifacts: { revision_guard: { verdict } },
    });
    expect(decideCheckpointPause('revision-guard', guardSnap('soft-violation'), deriveCheckpointPolicy('auto'))).toEqual({ action: 'pause' });
    expect(decideCheckpointPause('revision-guard', guardSnap('clean'), deriveCheckpointPolicy('auto'))).toEqual({ action: 'continue' });
  });
});

describe('summarizeRunSnapshot — Story 8.4 Step 4 挂起载荷投影', () => {
  const suspendedRun = (): RunSnapshot => ({
    runId: 'r1',
    status: 'paused',
    currentNodeId: 'draft-writer-agent',
    projectPath: '/p',
    completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
    pendingNodes: [],
    artifacts: {
      chapter_brief: { goal: 'g' },
      research_brief: {
        briefHash: 'sha256:x',
        suspended: {
          kind: 'research_contradiction',
          rounds: 2,
          evidence: {
            contradictions: [{ desc: '任务卡与第 3 章矛盾', severity: 'contradiction' }],
            deviations: [{ scene_ref: 's1', plan_says: 'P', brief_says: 'B', reason: 'R' }],
          },
        },
      },
    },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  });

  it('paused + research_brief.suspended → summary.researchSuspension（deliverable 豁免 isolation）', () => {
    const summary = summarizeRunSnapshot(suspendedRun(), { pausedStage: 'draft' });
    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('draft');
    expect(summary.researchSuspension).toMatchObject({
      kind: 'research_contradiction',
      rounds: 2,
      evidence: {
        contradictions: [{ desc: '任务卡与第 3 章矛盾', severity: 'contradiction' }],
        deviations: [{ scene_ref: 's1', plan_says: 'P', brief_says: 'B', reason: 'R' }],
      },
    });
  });

  it('verify_exhausted 形态（gaps）照常投影', () => {
    const run = suspendedRun();
    (run.artifacts['research_brief'] as Record<string, unknown>).suspended = {
      kind: 'verify_exhausted',
      rounds: 3,
      gaps: [{ desc: '未核查王五', source_hint: 'query_story 搜「王五」' }],
    };
    const summary = summarizeRunSnapshot(run, { pausedStage: 'draft' });
    expect(summary.researchSuspension).toMatchObject({
      kind: 'verify_exhausted',
      rounds: 3,
      gaps: [{ desc: '未核查王五', source_hint: 'query_story 搜「王五」' }],
    });
  });

  it('非 paused（completed）→ 不抽挂起载荷（零回归）', () => {
    const summary = summarizeRunSnapshot({ ...suspendedRun(), status: 'completed' });
    expect(summary.researchSuspension).toBeUndefined();
  });

  it('paused 但 suspended 形态坏（防御）→ 不设字段，status 仍 paused', () => {
    const run = suspendedRun();
    (run.artifacts['research_brief'] as Record<string, unknown>).suspended = { kind: 'bogus' };
    const summary = summarizeRunSnapshot(run, { pausedStage: 'draft' });
    expect(summary.researchSuspension).toBeUndefined();
    expect(summary.status).toBe('paused');
  });
});

describe('runChain — 出发核查挂起 pause 型节点结果（真链段驱动语义）', () => {
  it('writer 返 research_brief 挂起结果 → 非 error → completedNodes 记录 + draft checkpoint pause（onCheckpoint 用 decideCheckpointPause 单源）+ errors 零计', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      {
        id: 'draft-writer-agent',
        node: {
          contract: null,
          async run({ run }) {
            calls['draft-writer-agent'] = (calls['draft-writer-agent'] ?? 0) + 1;
            // Step 4 形态：pause 型结果（stateKey=research_brief 携 suspended，非 error）。
            run.artifacts['research_brief'] = {
              briefHash: 'sha256:x',
              suspended: { kind: 'research_contradiction', rounds: 1 },
            };
            return { stateKey: 'research_brief', artifact: run.artifacts['research_brief'] };
          },
        },
        checkpointStage: 'draft',
      },
      makeNode('revision-guard-agent', 'draft.initial', { title: '不应到达' }, calls, ['draft.initial']),
    ];
    const onCheckpoint = vi.fn(
      async (stage: CheckpointStage, snap: RunSnapshot) =>
        decideCheckpointPause(stage, snap, deriveCheckpointPolicy('auto')),
    );

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    // 全档位（auto）pause：挂起 ≠ 错误（status=paused 非 error；errors 零计——挂起不进错误账）。
    expect(snapshot.status).toBe('paused');
    expect(snapshot.currentNodeId).toBe('draft-writer-agent');
    expect(snapshot.errors ?? []).toEqual([]);
    expect(snapshot.completedNodes).toContain('draft-writer-agent'); // resume-redo 移除它的前提
    // 下游节点不跑（挂起停链）。
    expect(calls['revision-guard-agent']).toBeUndefined();
    // 摘要投影（pauseHint 经 resolveCheckpointStage 解析，同 runChapterChain 生产路径）。
    const summary = summarizeRunSnapshot(snapshot, {
      pausedStage: resolveCheckpointStage(chain, snapshot.currentNodeId),
    });
    expect(summary.pausedStage).toBe('draft');
    expect(summary.researchSuspension).toMatchObject({ kind: 'research_contradiction', rounds: 1 });
  });
});
