import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RunSnapshot } from '../src/contracts/run';
import { createFeedbackLedgerNode } from '../src/nodes/feedback-ledger-node';

// ── Story 7.4 feedback-ledger-node tests（mirror story-sync / emotion-verify-node 节点测试模式）──
//
// 覆盖 AC3 gate：node falsy 守卫（缺 artifact 跳过不崩）+ episodeId 缺跳过 + 工具未注册跳过 + 正常写入。

function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'test-run',
    status: 'running',
    currentNodeId: 'feedback-ledger-node',
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

describe('feedback-ledger-node (Story 7.4 §2.2)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('skips all writes when episodeId is missing (chapter_brief_input absent)', async () => {
    const node = createFeedbackLedgerNode();
    const result = await node.run({
      run: makeRun({
        artifacts: {
          'review.latest': { verdict: 'pass' },
          // chapter_brief_input absent → no episodeId
        },
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('feedback_ledger');
    const artifact = result.artifact as { written: string[]; summary: string; episodeId: null };
    expect(artifact.episodeId).toBeNull();
    expect(artifact.written).toEqual([]);
    expect(artifact.summary).toContain('skip');
  });

  it('skips all writes when chapter_brief_input has no episodeId field', async () => {
    const node = createFeedbackLedgerNode();
    const result = await node.run({
      run: makeRun({
        artifacts: {
          chapter_brief_input: { goal: 'no episodeId here' },
          'review.latest': { verdict: 'pass' },
        },
      }),
      requirement: '',
    });
    const artifact = result.artifact as { written: string[]; episodeId: null };
    expect(artifact.episodeId).toBeNull();
    expect(artifact.written).toEqual([]);
  });

  it('gracefully skips writes when feedback_ledger_write tool is not registered', async () => {
    // registry is empty in test env (registerBuiltinTools not called)
    const node = createFeedbackLedgerNode();
    const result = await node.run({
      run: makeRun({
        artifacts: {
          chapter_brief_input: { episodeId: 'ep1' },
          'review.latest': { verdict: 'pass' },
          'emotion_verify_result': { degraded: false, flags: [] },
        },
      }),
      requirement: '',
    });
    const artifact = result.artifact as { written: string[]; episodeId: string; summary: string };
    expect(artifact.episodeId).toBe('ep1');
    expect(artifact.written).toEqual([]);
    expect(artifact.summary).toContain('tool not registered');
  });

  it('falsy guard: skips missing/non-object artifacts but writes present ones', async () => {
    // Mock registry with a write tool that records calls
    const writeCalls: Array<{ episodeId: string; artifactKey: string; payload: unknown }> = [];
    vi.doMock('../src/tool/registry', () => ({
      registry: {
        get: (id: string) => {
          if (id !== 'feedback_ledger_write') return undefined;
          return {
            id,
            description: '',
            parameters: {},
            execute: async (params: Record<string, unknown>) => {
              writeCalls.push({
                episodeId: params.episodeId as string,
                artifactKey: params.artifactKey as string,
                payload: params.payload,
              });
              return { title: 'ok', output: '' };
            },
          };
        },
      },
    }));

    const { createFeedbackLedgerNode: createNodeFresh } = await import('../src/nodes/feedback-ledger-node');
    const node = createNodeFresh();
    const result = await node.run({
      run: makeRun({
        artifacts: {
          chapter_brief_input: { episodeId: 'ep1' },
          'review.latest': { verdict: 'pass', dimensions: [] },
          // emotion_verify_result missing (falsy → skip)
          'emotion_verify_result': undefined,
          // completeness_verify_result is not an object (array → skip)
          'completeness_verify_result': [],
        },
      }),
      requirement: '',
    });

    // Only review.latest was written (the other two were falsy/non-object)
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].artifactKey).toBe('review.latest');
    expect(writeCalls[0].episodeId).toBe('ep1');

    const artifact = result.artifact as { written: string[] };
    expect(artifact.written).toEqual(['review.latest']);
  });

  it('writes all 3 artifacts when all present and tool registered', async () => {
    const writeCalls: Array<{ artifactKey: string }> = [];
    vi.doMock('../src/tool/registry', () => ({
      registry: {
        get: (id: string) => {
          if (id !== 'feedback_ledger_write') return undefined;
          return {
            id,
            description: '',
            parameters: {},
            execute: async (params: Record<string, unknown>) => {
              writeCalls.push({ artifactKey: params.artifactKey as string });
              return { title: 'ok', output: '' };
            },
          };
        },
      },
    }));

    const { createFeedbackLedgerNode: createNodeFresh } = await import('../src/nodes/feedback-ledger-node');
    const node = createNodeFresh();
    const result = await node.run({
      run: makeRun({
        artifacts: {
          chapter_brief_input: { episodeId: 'ep1' },
          'review.latest': { verdict: 'pass' },
          'emotion_verify_result': { flags: [], degraded: false },
          'completeness_verify_result': { findings: [] },
        },
      }),
      requirement: '',
    });

    expect(writeCalls).toHaveLength(3);
    const keys = writeCalls.map((c) => c.artifactKey).sort();
    expect(keys).toEqual(['completeness_verify_result', 'emotion_verify_result', 'review.latest']);

    const artifact = result.artifact as { written: string[]; summary: string };
    expect(artifact.written).toHaveLength(3);
    expect(artifact.summary).toContain('3/3');
  });

  it('graceful: tool execute failure does not break node (warn + continue)', async () => {
    vi.doMock('../src/tool/registry', () => ({
      registry: {
        get: () => ({
          id: 'feedback_ledger_write',
          description: '',
          parameters: {},
          execute: async () => {
            throw new Error('IPC failure simulated');
          },
        }),
      },
    }));

    const { createFeedbackLedgerNode: createNodeFresh } = await import('../src/nodes/feedback-ledger-node');
    const node = createNodeFresh();
    const result = await node.run({
      run: makeRun({
        artifacts: {
          chapter_brief_input: { episodeId: 'ep1' },
          'review.latest': { verdict: 'pass' },
        },
      }),
      requirement: '',
    });

    // Node did not throw — returned summary with 0 written
    const artifact = result.artifact as { written: string[] };
    expect(artifact.written).toEqual([]);
  });
});
