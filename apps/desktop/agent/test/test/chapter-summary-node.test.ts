import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RunSnapshot } from '../src/contracts/run';
import { createChapterSummaryNode } from '../src/nodes/chapter-summary-node';

// ── Story 8.1 chapter-summary-node tests（mirror feedback-ledger-node.test.ts 节点测试模式）──
//
// 覆盖 graceful 三态（episodeId 缺 / 工具未注册 / execute 失败 + ok:false）+ 正常物化路径（mock registry
// 工具返 ok:true → artifact 计数断言）。registry mock 用 vi.doMock + fresh import（mirror feedback-ledger
// 测试先例——registry 是模块级单例，doMock 后重 import 节点模块才拿到 mock registry）。

function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'test-run',
    status: 'running',
    currentNodeId: 'chapter-summary-node',
    projectPath: '/test-project',
    completedNodes: [],
    pendingNodes: [],
    artifacts: {},
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    ...overrides,
  };
}

describe('chapter-summary-node (Story 8.1 design §2)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // ── graceful 态 1：episodeId 缺 ──

  it('skips materialization when chapter_brief_input is absent (no episodeId)', async () => {
    const node = createChapterSummaryNode();
    const result = await node.run({
      run: makeRun({ artifacts: { draft: { text: 'x' } } }),
      requirement: '',
    });
    expect(result.stateKey).toBe('chapter_summary_result');
    const artifact = result.artifact as { episodeId: null; ok: boolean; reason: string };
    expect(artifact.episodeId).toBeNull();
    expect(artifact.ok).toBe(false);
    expect(artifact.reason).toBe('no_episodeId');
  });

  it('skips materialization when chapter_brief_input has no episodeId field', async () => {
    const node = createChapterSummaryNode();
    const result = await node.run({
      run: makeRun({ artifacts: { chapter_brief_input: { goal: 'no episodeId here' } } }),
      requirement: '',
    });
    const artifact = result.artifact as { episodeId: null; ok: boolean };
    expect(artifact.episodeId).toBeNull();
    expect(artifact.ok).toBe(false);
  });

  it('rejects non-string / empty episodeId (gross-shape guard)', async () => {
    const node = createChapterSummaryNode();
    const result = await node.run({
      run: makeRun({ artifacts: { chapter_brief_input: { episodeId: 42 } } }),
      requirement: '',
    });
    const artifact = result.artifact as { episodeId: null; ok: boolean };
    expect(artifact.episodeId).toBeNull();
    expect(artifact.ok).toBe(false);
  });

  // ── graceful 态 2：工具未注册（测试环境 registry 空）──

  it('gracefully skips when materialize_chapter_summary tool is not registered', async () => {
    // registry is empty in test env (registerBuiltinTools not called)
    const node = createChapterSummaryNode();
    const result = await node.run({
      run: makeRun({ artifacts: { chapter_brief_input: { episodeId: 'ep1' } } }),
      requirement: '',
    });
    const artifact = result.artifact as { episodeId: string; ok: boolean; reason: string; summary: string };
    expect(artifact.episodeId).toBe('ep1');
    expect(artifact.ok).toBe(false);
    expect(artifact.reason).toBe('tool_not_registered');
    expect(artifact.summary).toContain('tool not registered');
  });

  // ── graceful 态 3：execute 抛错 / ok:false ──

  it('degrades (warn + ok:false artifact) when tool execute throws — chain continues, no {error:true}', async () => {
    vi.doMock('../src/tool/registry', () => ({
      registry: {
        get: (id: string) => {
          if (id !== 'materialize_chapter_summary') return undefined;
          return {
            id,
            description: '',
            parameters: {},
            execute: async () => {
              throw new Error('IPC failure simulated');
            },
          };
        },
      },
    }));

    const { createChapterSummaryNode: createNodeFresh } = await import('../src/nodes/chapter-summary-node');
    const node = createNodeFresh();
    const result = await node.run({
      run: makeRun({ artifacts: { chapter_brief_input: { episodeId: 'ep1' } } }),
      requirement: '',
    });

    // Node did not throw; artifact carries ok:false + execute_failed reason（非 chainRunner isErrorArtifact
    // 终态形态——物化失败是增强降级，链不破，mirror world-merge writeErrors 模式）。
    const artifact = result.artifact as { ok: boolean; reason: string; error?: unknown };
    expect(artifact.ok).toBe(false);
    expect(artifact.reason).toContain('execute_failed');
    expect(artifact.reason).toContain('IPC failure simulated');
    expect((artifact as { error?: unknown }).error).toBeUndefined();
  });

  it('degrades when handler returns ok:false (invalid params / project not registered)', async () => {
    vi.doMock('../src/tool/registry', () => ({
      registry: {
        get: () => ({
          id: 'materialize_chapter_summary',
          description: '',
          parameters: {},
          execute: async () => ({
            title: 'materialize_chapter_summary',
            output: '当前项目未注册到数据库，无法访问世界状态。',
            metadata: { ok: false, reason: 'project_not_registered' },
          }),
        }),
      },
    }));

    const { createChapterSummaryNode: createNodeFresh } = await import('../src/nodes/chapter-summary-node');
    const node = createNodeFresh();
    const result = await node.run({
      run: makeRun({ artifacts: { chapter_brief_input: { episodeId: 'ep1' } } }),
      requirement: '',
    });
    const artifact = result.artifact as { ok: boolean; reason: string };
    expect(artifact.ok).toBe(false);
    expect(artifact.reason).toContain('project_not_registered');
  });

  // ── 正常路径：mock registry 工具返 ok:true → artifact 计数断言 ──

  it('materializes: tool called with {episodeId} + run.projectPath, artifact carries handler counts', async () => {
    const calls: Array<{ params: Record<string, unknown>; projectPath: string }> = [];
    vi.doMock('../src/tool/registry', () => ({
      registry: {
        get: (id: string) => {
          if (id !== 'materialize_chapter_summary') return undefined;
          return {
            id,
            description: '',
            parameters: {},
            execute: async (params: Record<string, unknown>, ctx: { projectPath: string }) => {
              calls.push({ params, projectPath: ctx.projectPath });
              return {
                title: 'materialize_chapter_summary: ep1',
                output: '已物化章节摘要 ep1（token≈480；checkpoint 2 个）。',
                metadata: {
                  ok: true,
                  episodeId: 'ep1',
                  tokenEstimate: 480,
                  truncated: true,
                  checkpointCount: 2,
                  summary: {
                    episodeId: 'ep1',
                    truncated: true,
                    degradedNote: 'promise_registry 缺失：③⑤⑥ 字段降级',
                  },
                },
              };
            },
          };
        },
      },
    }));

    const { createChapterSummaryNode: createNodeFresh } = await import('../src/nodes/chapter-summary-node');
    const node = createNodeFresh();
    const result = await node.run({
      run: makeRun({
        projectPath: '/test-project',
        artifacts: { chapter_brief_input: { episodeId: 'ep1' } },
      }),
      requirement: '',
    });

    // 工具入参 = {episodeId}（materializeChapterSummaryRequestSchema 单源）+ ctx 透传 run.projectPath。
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ episodeId: 'ep1' });
    expect(calls[0].projectPath).toBe('/test-project');

    expect(result.stateKey).toBe('chapter_summary_result');
    const artifact = result.artifact as {
      runId: string;
      episodeId: string;
      ok: boolean;
      tokenEstimate: number;
      truncated: boolean;
      checkpointCount: number;
      degradedNote?: string;
    };
    expect(artifact.runId).toBe('test-run');
    expect(artifact.episodeId).toBe('ep1');
    expect(artifact.ok).toBe(true);
    expect(artifact.tokenEstimate).toBe(480);
    expect(artifact.truncated).toBe(true);
    expect(artifact.checkpointCount).toBe(2);
    expect(artifact.degradedNote).toBe('promise_registry 缺失：③⑤⑥ 字段降级');
  });

  it('ok:true without degradedNote → artifact omits degradedNote (no fabricated note)', async () => {
    vi.doMock('../src/tool/registry', () => ({
      registry: {
        get: () => ({
          id: 'materialize_chapter_summary',
          description: '',
          parameters: {},
          execute: async () => ({
            title: 'ok',
            output: '',
            metadata: {
              ok: true,
              episodeId: 'ep2',
              tokenEstimate: 300,
              truncated: false,
              checkpointCount: 0,
              summary: { episodeId: 'ep2', truncated: false },
            },
          }),
        }),
      },
    }));

    const { createChapterSummaryNode: createNodeFresh } = await import('../src/nodes/chapter-summary-node');
    const node = createNodeFresh();
    const result = await node.run({
      run: makeRun({ artifacts: { chapter_brief_input: { episodeId: 'ep2' } } }),
      requirement: '',
    });
    const artifact = result.artifact as { ok: boolean; degradedNote?: string };
    expect(artifact.ok).toBe(true);
    expect(artifact.degradedNote).toBeUndefined();
  });
});
