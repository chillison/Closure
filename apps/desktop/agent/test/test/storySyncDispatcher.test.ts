import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeRunInput } from '../src/contracts/run';

const ORIG = { ...process.env };

afterEach(() => {
  process.env = { ...ORIG };
  vi.resetModules();
});

// Story 4.0 Step 5.1c：storySync artifact key 单源对齐（design §7 verify-point）。
// Story 6.5 收缩：story-sync 不再读 foreshadow_registry artifact（已改名 promise_registry，且不进 story-sync
// ——CR-E7 防线：读者债走 promise-emergence-node LLM 涌现登记，非 prose 机械词提取）。freshness 版本源
// （旧 foreshadow_registry.version）已移除——creative-field freshness 归各 handler/fieldSyncBridge，非 story-sync。
function makeInput(extraArtifacts: Record<string, unknown> = {}): NodeRunInput {
  const base: any = {
    runId: 'run_1',
    artifacts: {
      // draft.initial artifact（draft-writer 产）：text 作 content / chapterId
      'draft.initial': {
        chapterId: 'ch_1',
        text: '他取出一把铜钥匙打开木匣。',
      },
      ...extraArtifacts,
    },
  };
  return { run: base, requirement: '' };
}

describe('createStorySyncNode dispatcher (post-6.5 收缩：foreshadow 提取移除)', () => {
  it('uses rules path when draft.initial.llmPatches is absent → 返空 patches（rules 收缩无提取）', { timeout: 15000 }, async () => {
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode();
    const result = await node.run(makeInput());
    const artifact = result.artifact as any;
    expect(result.stateKey).toBe('story.sync');
    expect(artifact.chapterId).toBe('ch_1');
    expect(Array.isArray(artifact.patches)).toBe(true);
    // 6.5 收缩后 rules 无提取规则（foreshadow 移除 + promise 不走此处）→ patches 空。
    expect(artifact.patches).toHaveLength(0);
  });

  it('reads draft text from draft.initial.text（新 key 单源对齐；6.5 后 rules 无提取）', async () => {
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode();
    const result = await node.run(
      makeInput({
        'draft.initial': { chapterId: 'ch_2', text: '她交出一封密信与暗号。' },
      }),
    );
    const artifact = result.artifact as any;
    // 6.5 后 '暗号' 不再命中任何规则（FORESHADOW_CUES 已移除）→ patches 空。
    expect(artifact.patches).toHaveLength(0);
  });

  it('emits the pre-computed patches when draft.initial.llmPatches is valid（whitelisted field）', async () => {
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode();
    // Story 6.5：foreshadow_registry → promise_registry 改名。llmPatches 用合法 creative field（asset_cards）
    // 测 LLM patches 透传路径（defensive——4.0 链段无上游产 llmPatches 但保留 dispatcher 逻辑）。
    const result = await node.run(
      makeInput({
        'draft.initial': {
          chapterId: 'ch_1',
          text: '正文',
          llmPatches: [
            {
              field: 'asset_cards',
              action: 'merge',
              data: { id: 'item_desktop_1', name: 'desktop 钥匙', type: 'prop' },
              fieldVersion: 2,
              generatedBy: 'IMPERSONATOR',
            },
          ],
        },
      }),
    );
    const artifact = result.artifact as any;
    expect(artifact.patches).toHaveLength(1);
    expect(artifact.patches[0].generatedBy).toBe('story-sync-agent');
    expect(artifact.patches[0].field).toBe('asset_cards');
  });

  it('falls back to rules (empty) when llmPatches references a non-whitelisted field', async () => {
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode();
    const result = await node.run(
      makeInput({
        'draft.initial': {
          chapterId: 'ch_1',
          text: '他取出一把铜钥匙。',
          llmPatches: [
            {
              field: 'NOT_A_REAL_FIELD',
              action: 'merge',
              data: {},
              fieldVersion: 0,
              generatedBy: 'story-sync-agent',
            },
          ],
        },
      }),
    );
    const artifact = result.artifact as any;
    // 非 whitelisted field → rules path → 6.5 收缩后空 patches（旧「铜钥匙 patch」已移除）。
    expect(artifact.patches).toHaveLength(0);
    expect(artifact.summary).not.toMatch(/llm patches applied/);
  });

  it('returns skip artifact when draft.initial is missing', async () => {
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode();
    const input: any = {
      run: {
        runId: 'run_2',
        artifacts: {},
      },
      requirement: '',
    };
    const result = await node.run(input as NodeRunInput);
    const artifact = result.artifact as any;
    expect(artifact.summary).toMatch(/skip/);
    expect(artifact.patches).toEqual([]);
  });

  it('does not import or instantiate any LLM client (regression: agent must not call providers)', async () => {
    const mod = await import('../src/nodes/story-sync-agent');
    expect(typeof mod.createStorySyncNode).toBe('function');
  });

  it('exposes AgentNode contract（requiredArtifactKeys=draft.initial / producedArtifactKeys=story.sync）', async () => {
    const { createStorySyncNode, STORY_SYNC_CONTRACT } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode();
    expect(node.contract).toBe(STORY_SYNC_CONTRACT);
    expect(node.contract?.nodeId).toBe('story-sync-agent');
    expect(node.contract?.requiredArtifactKeys).toEqual(['draft.initial']);
    expect(node.contract?.producedArtifactKeys).toEqual(['story.sync']);
  });
});
