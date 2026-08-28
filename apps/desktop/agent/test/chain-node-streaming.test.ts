import { mkdtempSync, rmSync } from 'node:fs';
import os from 'os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ResearchBrief } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 6（design §4 / r1）：链节点流式测试。
//
// 覆盖：
// 1. makeAgentLoop onDelta 穿线——deps.onDelta 存在时 generate 收 opts.onDelta + 预分配
//    assistantId（delta 与该轮 assistant 消息同 id）；缺省零事件零回归。
// 2. writer-node 开流甄别（r1）——仅阶段二（写作）generate 轮的 **text** 增量经
//    onNodeDelta 上行（phase='writing'）；阶段一自查 / 阶段 2.5 申报（JSON 产物）与
//    reasoning 增量不转发。
// 3. workflow runChapterChain e2e——emitChainEvent 收 chain-delta（seq 轮次计数）+
//    chain-node-done（每节点边界 + 哨兵终态帧）；同会话第二次 run 同 nodeId seq+1
//    （redo 防混流）；abort → 哨兵 'aborted'。
// 4. chainRunner onNodeDone——节点边界 / error artifact / DAG blocked 三态（chainRunner.test
//    家族外的补充，此处锚 runChapterChain 侧语义）。
// ─────────────────────────────────────────────────────────────────────────────

const VALID_BRIEF: ResearchBrief = {
  plan: '先城门对峙再入城收束',
  entries: [
    {
      ref: 'char-lin',
      kind: 'asset',
      key_facts: [{ fact: '林昭左臂旧伤未愈', source: '人物卡 char-lin' }],
    },
  ],
  issues: [],
  execution_plan: [{ scene_ref: 's_gate', beat_coverage: '对峙节拍', notes: '短句提速' }],
  deviations: [],
};

const VALID_DRAFT = { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800, chapterId: 'ch_2' };

const VALID_DECLARATION = {
  synopsis: '林昭与江白在城门分手后各自遇袭。',
  present: [{ name: '林昭' }],
  mentioned: [],
};

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ════════════════════════════════════════════════════════════════════════════
// 1. makeAgentLoop onDelta 穿线
// ════════════════════════════════════════════════════════════════════════════

describe('makeAgentLoop — onDelta 穿线（dogfood T1 Stage 6）', () => {
  it('deps.onDelta 在 → generate 收 opts.onDelta + 预分配轮 assistantId（delta 与该轮消息同 id）', async () => {
    const { makeAgentLoop } = await import('../src/nodes/agent-loop');
    const seenOpts: Array<{ onDelta?: unknown }> = [];
    const generate = vi.fn(async (_msgs, _sys, _tls, _abort, opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void }) => {
      seenOpts.push(opts ?? {});
      opts?.onDelta?.({ type: 'text', delta: '你好' });
      return { content: `正文<STOP>`, finishReason: 'stop' };
    });
    const deltas: Array<{ messageId: string; channel: string; delta: string }> = [];
    const loop = makeAgentLoop(
      { generate: generate as never, onDelta: (d) => deltas.push(d) },
      {
        toolIds: [],
        systemPrompt: 'sys',
        stablePrefix: [{ id: 'u1', role: 'user', content: '任务卡', createdAt: 0 }],
        stopMarkers: ['<STOP>'],
        maxRounds: 3,
        projectPath: '/test',
      },
    );
    const result = await loop({ userPrompt: '写' });
    expect(result.status).toBe('stopped');
    // generate 收到 onDelta 回调；包装后事件带预分配 id + channel。
    expect(typeof seenOpts[0]?.onDelta).toBe('function');
    expect(deltas).toEqual([{ messageId: expect.any(String), channel: 'text', delta: '你好' }]);
    // 同 id：该轮 assistant 消息复用预分配 id（UI 轮次分段无漂移）。
    const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant?.id).toBe(deltas[0]?.messageId);
  });

  it('deps.onDelta 缺省 → generate 第 5 参不含 onDelta（零回归：不传回调走非流式路径）', async () => {
    const { makeAgentLoop } = await import('../src/nodes/agent-loop');
    const seenOpts: Array<{ onDelta?: unknown }> = [];
    const generate = vi.fn(async (_msgs, _sys, _tls, _abort, opts?: unknown) => {
      seenOpts.push(opts as { onDelta?: unknown });
      return { content: '正文<STOP>', finishReason: 'stop' };
    });
    const loop = makeAgentLoop(
      { generate: generate as never, modelRef: { keyId: 'k', modelId: 'm' } },
      {
        toolIds: [],
        systemPrompt: 'sys',
        stablePrefix: [],
        stopMarkers: ['<STOP>'],
        maxRounds: 3,
        projectPath: '/test',
      },
    );
    await loop({ userPrompt: '写' });
    // modelRef 在但 onDelta 不在 → opts 只含 modelRef（既有调用形态，S1 分派点走非流式）。
    expect(seenOpts[0]).toEqual({ modelRef: { keyId: 'k', modelId: 'm' } });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. writer-node 开流甄别（r1：仅阶段二写作开流）
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — 开流甄别（仅阶段二写作）', () => {
  it('阶段一自查 / 阶段 2.5 申报（JSON）与 reasoning 增量不转发；阶段二 text 增量带 phase=writing 上行', async () => {
    const { createWriterNode, WRITER_READONLY_TOOL_IDS } = await import('../src/nodes/writer-node');
    const { registry } = await import('../src/tool/registry');
    registry.__clearForTest();
    for (const id of WRITER_READONLY_TOOL_IDS) {
      registry.register({
        id,
        description: `fake ${id}`,
        parameters: z.object({}),
        execute: async () => ({ title: id, output: `${id} 结果` }),
      });
    }

    type Phase = 'phase1' | 'phase2' | 'cast';
    const calls: Array<{ phase: Phase; assistantId: string }> = [];
    // generate mock：按最后一条 user 消息的阶段指令路由；每轮主动调 opts.onDelta（模拟
    // provider 流式输出——阶段一/申报也调，验证它们被甄别掉不转发）。
    const generate = vi.fn(async (
      msgs: Array<{ role: string; content: string }>,
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
    ) => {
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      let phase: Phase;
      let content: string;
      if (lastUser.includes('第三步')) {
        phase = 'cast';
        content = `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`;
      } else if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
        phase = 'phase2';
        content = `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`;
      } else {
        phase = 'phase1';
        content = `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`;
      }
      const assistantId = `${phase}-assistant`;
      calls.push({ phase, assistantId });
      if (opts?.onDelta) {
        opts.onDelta({ type: 'text', delta: `[${phase}]` });
        // reasoning 增量同样到达（#27② 协议面）——链事件不转发（载荷无 channel，UI 只呈正文）。
        opts.onDelta({ type: 'reasoning', delta: `[${phase}-think]` });
      }
      return { content, finishReason: 'stop' };
    });

    const deltas: Array<{ phase?: string; messageId: string; delta: string }> = [];
    const node = createWriterNode({
      generate: generate as never,
      archiveIo: {
        async read() { return null; },
        async write() { /* 内存 no-op */ },
      },
      nowISO: () => '2026-08-22T00:00:00Z',
      onNodeDelta: (d) => deltas.push(d),
    });

    const result = await node.run({
      run: {
        runId: 'run_w',
        status: 'running',
        currentNodeId: null,
        projectPath: '/test',
        completedNodes: [],
        pendingNodes: [],
        artifacts: {
          chapter_brief: { goal: '抵达 B 城' },
          chapter_brief_input: { episodeId: 'ep-s6', brief: { goal: '抵达 B 城' } },
          scene_graph: { nodes: [] },
          settings_context: '设定前缀',
        },
        review: null,
        archive: null,
        delivery: null,
        feedback: null,
      },
      requirement: '',
    });

    // 三阶段都被调用（两阶段主路径 + 申报）。
    expect(calls.map((c) => c.phase)).toEqual(['phase1', 'phase2', 'cast']);
    // 正文交付不受流式影响（契约零变）。
    expect(result.stateKey).toBe('draft.initial');
    // 甄别：只有阶段二的 text 增量转发（phase1 / cast / reasoning 全滤掉）。messageId 是
    // makeAgentLoop 预分配的轮 assistantId（真 randomUUID——此处只断言非空字符串）。
    expect(deltas).toEqual([{ phase: 'writing', messageId: expect.any(String), delta: '[phase2]' }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. workflow runChapterChain e2e（seq 轮次 + 节点边界 + 终态帧）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 全链 generate mock：写手按阶段指令（最后一条 user 消息）路由；其余节点按 system 标记
 * （mirror runChapterChain.test.ts makeChainGenerate），写手路径主动调 opts.onDelta 模拟流式。
 */
function makeStreamingChainGenerate(): ReturnType<typeof vi.fn> {
  const route = { decision: 'accept_as_truth', reason: '正文升级' };
  const review = { verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] };
  const extractor = { storyTime: 5, title: '状态切面', subjects: [], patches: [] };
  const completeness = { findings: [], summary: '无缺漏', degraded: false };
  const storySync = { runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' };
  return vi.fn(async (
    msgs: Array<{ role: string; content: string }>,
    sys: string,
    _tls: unknown,
    _abort: AbortSignal,
    opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
  ) => {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
    const s = sys ?? '';
    // 写手三阶段（阶段指令在最后一条 user 消息；判定先于 system 标记——写手 system 无其他标记）。
    if (lastUser.includes('第三步')) {
      return { content: `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
      // 阶段二开流：两段 text delta（模拟 provider 分片）。
      opts?.onDelta?.({ type: 'text', delta: '{"title":"第二章' });
      opts?.onDelta?.({ type: 'text', delta: ' B 城"' });
      return { content: `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('第一步')) {
      return { content: `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
    }
    if (s.includes('路由判决')) return { content: JSON.stringify(route), finishReason: 'stop' };
    if (s.includes('完整性审核')) return { content: JSON.stringify(completeness), finishReason: 'stop' };
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) return { content: JSON.stringify(review), finishReason: 'stop' };
    if (s.includes('状态提取')) return { content: JSON.stringify(extractor), finishReason: 'stop' };
    if (s.includes('story-sync-agent')) return { content: JSON.stringify(storySync), finishReason: 'stop' };
    return { content: '{}', finishReason: 'stop' };
  });
}

describe('WorkflowRuntime.runChapterChain — 链事件（chain-delta / chain-node-done）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-chain-stream-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmSync(projectPath, { recursive: true, force: true });
    const { registry } = await import('../src/tool/registry');
    registry.__clearForTest();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    vi.resetModules();
  });

  async function registerWriterTools() {
    const { WRITER_READONLY_TOOL_IDS } = await import('../src/nodes/writer-node');
    const { registry } = await import('../src/tool/registry');
    for (const id of WRITER_READONLY_TOOL_IDS) {
      registry.register({
        id,
        description: `fake ${id}`,
        parameters: z.object({}),
        execute: async () => ({ title: id, output: `${id} 结果` }),
      });
    }
  }

  function makeInitialArtifacts(): Record<string, unknown> {
    return {
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1' }] },
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'REACH_B_CITY_GOAL', tone: '紧张' } },
      settings_context: 'PREFIX_SETTINGS_TEXT',
      promise_registry: { promises: [], beats: [], version: 0 },
    };
  }

  it('emitChainEvent 收 chain-delta（seq=0、nodeId/role/phase 标注）+ 每节点 chain-node-done + 哨兵终态帧 completed', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeStreamingChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('completed');

    // chain-delta：全部来自 draft-writer 阶段二，seq=0（首 run），phase 标注，delta 分片保序。
    const deltas = events.filter((e) => e.type === 'chain-delta');
    expect(deltas.length).toBe(2);
    for (const d of deltas) {
      expect(d.data.nodeId).toBe('draft-writer-agent');
      expect(d.data.role).toBe('draft-writer-agent');
      expect(d.data.phase).toBe('writing');
      expect(d.data.seq).toBe(0);
    }
    expect(deltas.map((d) => d.data.delta)).toEqual(['{"title":"第二章', ' B 城"']);
    // messageId 携带（轮 assistantId——makeAgentLoop 预分配）。
    expect(typeof deltas[0]?.data.messageId).toBe('string');

    // chain-node-done：每节点边界（含 brief-compiler / draft-writer / route）+ 哨兵终态帧。
    const dones = events.filter((e) => e.type === 'chain-node-done');
    const nodeDones = dones.filter((e) => e.data.nodeId !== '__chain_run__');
    expect(nodeDones.length).toBeGreaterThanOrEqual(3);
    expect(nodeDones[0]?.data).toEqual({ nodeId: 'brief-compiler-node', status: 'done' });
    expect(nodeDones.map((e) => e.data.nodeId)).toContain('draft-writer-agent');
    expect(nodeDones.map((e) => e.data.nodeId)).toContain('route-agent');
    for (const e of nodeDones) expect(e.data.status).toBe('done');
    // 哨兵终态帧在最后（run 终态 completed）。
    expect(dones[dones.length - 1]?.data).toEqual({ nodeId: '__chain_run__', status: 'completed' });
  });

  it('同会话第二次 run：同 nodeId（draft-writer）seq+1——redo 重跑不与旧流混淆（r1 坑）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeStreamingChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const seqs: number[] = [];
    const emitChainEvent = (e: { type: string; data: Record<string, unknown> }) => {
      if (e.type === 'chain-delta') seqs.push(e.data.seq as number);
    };
    await runtime.runChapterChain(parent.id, makeInitialArtifacts(), { emitChainEvent });
    expect(seqs.every((s) => s === 0)).toBe(true);

    // 第二次 run（redo 形态——同 parent 会话重新整链跑；章档案 briefHash 同 → 简报复用，
    // 阶段二照跑照流）。seq 单调 +1（UI 按 (nodeId, seq) 拼接即天然丢弃旧流）。
    seqs.length = 0;
    await runtime.runChapterChain(parent.id, makeInitialArtifacts(), { emitChainEvent });
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.every((s) => s === 1)).toBe(true);
  });

  it('abort（signal 预 abort）→ 哨兵终态帧 aborted（UI 侧「已中断」数据源）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeStreamingChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const abort = new AbortController();
    abort.abort();
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      abort: abort.signal,
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('aborted');
    const dones = events.filter((e) => e.type === 'chain-node-done');
    expect(dones[dones.length - 1]?.data).toEqual({ nodeId: '__chain_run__', status: 'aborted' });
  });

  it('emitChainEvent 缺省 → 零链事件（链段行为零回归）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeStreamingChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });
    // 不传 emitChainEvent——正常完成（既有全部测试路径的形态）。
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts());
    expect(summary.status).toBe('completed');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. chainRunner onNodeDone 三态
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — onNodeDone 节点边界三态（dogfood T1 Stage 6）', () => {
  it('每节点完成 fire (done)；error artifact → (error)；DAG blocked → (blocked)；resume 跳过节点不 fire', async () => {
    const { runChain } = await import('../src/runtime/chainRunner');
    const { randomUUID } = await import('node:crypto');

    const doneCalls: Array<[string, string]> = [];
    const mkNode = (id: string, opts: { artifact?: unknown } = {}) => ({
      id,
      checkpointStage: undefined,
      node: {
        contract: null,
        async run() {
          return { stateKey: id, artifact: opts.artifact ?? { ok: true } };
        },
      },
    });

    // 1) 两节点成功 → 各 fire (done)。
    const calls1: Array<[string, string]> = [];
    const snap1 = await runChain(
      {
        chain: [mkNode('a'), mkNode('b')] as never,
        initialArtifacts: {},
        requirement: '',
        onNodeDone: (nodeId, status) => calls1.push([nodeId, status]),
      },
      {
        generate: (async () => ({ content: '', finishReason: 'stop' })) as never,
        sessionContext: { id: 's', agentName: 'a', projectPath: '/t', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 },
        signal: new AbortController().signal,
      },
    );
    expect(snap1.status).toBe('completed');
    expect(calls1).toEqual([['a', 'done'], ['b', 'done']]);

    // 2) error artifact → 该节点 (error)，后续节点不跑。
    const calls2: Array<[string, string]> = [];
    const snap2 = await runChain(
      {
        chain: [mkNode('a', { artifact: { error: true, nodeId: 'a', message: 'x' } }), mkNode('b')] as never,
        initialArtifacts: {},
        requirement: '',
        onNodeDone: (nodeId, status) => calls2.push([nodeId, status]),
      },
      {
        generate: (async () => ({ content: '', finishReason: 'stop' })) as never,
        sessionContext: { id: 's', agentName: 'a', projectPath: '/t', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 },
        signal: new AbortController().signal,
      },
    );
    expect(snap2.status).toBe('error');
    expect(calls2).toEqual([['a', 'error']]);

    // 3) DAG blocked（requiredArtifactKeys 缺）→ (blocked)。
    const calls3: Array<[string, string]> = [];
    const snap3 = await runChain(
      {
        chain: [{
          id: 'needful',
          node: {
            contract: { requiredArtifactKeys: ['missing_key'], producedArtifactKeys: [] },
            async run() { return { stateKey: 'needful', artifact: {} }; },
          },
        }] as never,
        initialArtifacts: {},
        requirement: '',
        onNodeDone: (nodeId, status) => calls3.push([nodeId, status]),
      },
      {
        generate: (async () => ({ content: '', finishReason: 'stop' })) as never,
        sessionContext: { id: 's', agentName: 'a', projectPath: '/t', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 },
        signal: new AbortController().signal,
      },
    );
    expect(snap3.status).toBe('blocked');
    expect(calls3).toEqual([['needful', 'blocked']]);

    // 4) resume：跳过的 completed 节点不 fire（前一 run 已 fire）。
    const calls4: Array<[string, string]> = [];
    const snap4 = await runChain(
      {
        chain: [mkNode('a'), mkNode('b')] as never,
        initialArtifacts: { a: { ok: true } },
        requirement: '',
        resumedCompletedNodes: ['a'],
        onNodeDone: (nodeId, status) => calls4.push([nodeId, status]),
      },
      {
        generate: (async () => ({ content: '', finishReason: 'stop' })) as never,
        sessionContext: { id: 's', agentName: 'a', projectPath: '/t', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0, _runId: randomUUID() } as never,
        signal: new AbortController().signal,
      },
    );
    expect(snap4.status).toBe('completed');
    expect(calls4).toEqual([['b', 'done']]);
  });
});
