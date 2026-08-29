import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeRunInput } from '../src/contracts/run';
import type { GenerateFn } from '../src/nodes/llm-node';

// Story 2.2 WP-E：story-sync-agent 节点真跑 LLM 提取单测（激活空转件，design §5.5.1）。
// mirror world-extractor 注入 generate + graceful catch 形态。验：
// (a) LLM 成功 → story.sync artifact 携 LLM patches（safety 已在 parse 内执行：generatedBy 强制）；
// (b) generate 收到 candidate 正文 + context（fieldVersions 从 project.yaml field_metadata 读出）；
// (c) promise_registry patch 被 CR-E7 belt 机械过滤（parser 白名单不拦，节点兜底）；
// (d) LLM fail（generate 抛）→ graceful 降级 rules 兜底（空 patches），链不破不抛；
// (e) parse fail（非 JSON）→ 同 graceful 空；
// (f) project.yaml 损坏 → context 降级 {}，generate 照常被调（提取不因 context 缺失而破）；
// (g) loadStorySyncContext：字段抽取 + fieldVersions；文件缺 → null。
// 零回归（无 deps 走 dispatcher 路径）既有 storySyncDispatcher.test.ts 覆盖，此处不重复。

function makeInput(extraArtifacts: Record<string, unknown> = {}): NodeRunInput {
  const base: any = {
    runId: 'run_1',
    artifacts: {
      'draft.initial': { chapterId: 'ch_1', text: '天机阁的守阁人首次现身，亮出玄铁令牌。' },
      'chapter_brief_input': { episodeId: 'ep1', brief: {} },
      ...extraArtifacts,
    },
  };
  return { run: base, requirement: 'ep1' };
}

function writeProject(dir: string, fields: Record<string, unknown> = {}): void {
  writeFileSync(path.join(dir, 'project.yaml'), JSON.stringify({
    meta: { id: 'p1', name: '测试小说', type: 'novel', version: 1, created_at: '2026-08-16T00:00:00Z', updated_at: '2026-08-16T00:00:00Z' },
    name: '测试小说',
    creative_brief: { genre: '都市奇幻', rawRequirement: 'r' },
    world_setting: { premise: '灵气复苏' },
    asset_cards: [{ id: 'card-1', type: 'prop', name: '玄铁令' }],
    relationship_graph: { nodes: [], edges: [], lines: [] },
    episode_outlines: [{ id: 'ep1', index: 3, title: '第四章' }],
    field_metadata: {
      asset_cards: { version: 2, source: 'user', locked: false, dependsOn: [], stale: false },
    },
    ...fields,
  }), 'utf8');
}

function validLlmJson(patches: unknown[]): string {
  return JSON.stringify({ runId: 'IGNORED', chapterId: 'IGNORED', summary: '提取新实体', patches });
}

describe('story-sync-agent LLM 提取（Story 2.2 WP-E）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-story-sync-llm-'));
    writeProject(projectPath);
  });

  afterEach(() => {
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
    vi.resetModules();
  });

  it('LLM 成功 → story.sync 携 patches（generatedBy 强制 / chapterId 取 draft）', async () => {
    const generate = vi.fn(async () => ({
      content: validLlmJson([
        { field: 'asset_cards', action: 'merge', data: { id: 'card-2', type: 'faction', name: '天机阁' }, fieldVersion: 2, generatedBy: 'IMPERSONATOR' },
      ]),
      finishReason: 'stop',
    }));
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode({ llm: { generate: generate as unknown as GenerateFn }, projectPath });

    const result = await node.run(makeInput());
    expect(result.stateKey).toBe('story.sync');
    const artifact = result.artifact as any;
    expect(artifact.patches).toHaveLength(1);
    expect(artifact.patches[0].generatedBy).toBe('story-sync-agent'); // safety 强制
    expect(artifact.chapterId).toBe('ch_1');
    expect(artifact.summary).toBe('提取新实体');
  });

  it('generate 收到 candidate 正文 + system prompt + context（fieldVersions 从 field_metadata 读出）', async () => {
    const generate = vi.fn(async () => ({ content: validLlmJson([]), finishReason: 'stop' }));
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode({ llm: { generate: generate as unknown as GenerateFn }, projectPath });

    await node.run(makeInput());
    expect(generate).toHaveBeenCalledTimes(1);
    const [messages, system] = generate.mock.calls[0];
    const userContent = (messages as Array<{ content: string }>)[0].content;
    expect(userContent).toContain('天机阁的守阁人首次现身'); // candidate 正文进 prompt
    expect(userContent).toContain('"fieldVersions"'); // rule 4 版本回显源
    expect(userContent).toContain('"asset_cards": 2');
    expect(userContent).toContain('"assetCards"'); // asset_cards 进 context（卡名「玄铁令」在数组内）
    expect(system).toContain('story-sync-agent'); // SYSTEM_PROMPT 单源
  });

  it('promise_registry patch 被 CR-E7 belt 过滤（parser 白名单不拦，节点兜底丢）', async () => {
    const generate = vi.fn(async () => ({
      content: validLlmJson([
        { field: 'promise_registry', action: 'merge', data: { promises: [] }, fieldVersion: 0, generatedBy: 'story-sync-agent' },
        { field: 'world_setting', action: 'merge', data: { premise: '灵气复苏（修订）' }, fieldVersion: 0, generatedBy: 'story-sync-agent' },
      ]),
      finishReason: 'stop',
    }));
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode({ llm: { generate: generate as unknown as GenerateFn }, projectPath });

    const result = await node.run(makeInput());
    const artifact = result.artifact as any;
    expect(artifact.patches).toHaveLength(1);
    expect(artifact.patches[0].field).toBe('world_setting');
  });

  it('LLM fail（generate 抛）→ graceful 降级 rules 兜底（空 patches），不抛', async () => {
    const generate = vi.fn(async () => { throw new Error('provider 502'); });
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode({ llm: { generate: generate as unknown as GenerateFn }, projectPath });

    const result = await node.run(makeInput());
    const artifact = result.artifact as any;
    expect(artifact.patches).toEqual([]); // rules 兜底空
    expect(artifact.summary).toMatch(/rules/);
  });

  it('parse fail（非 JSON 输出）→ graceful 空 patches', async () => {
    const generate = vi.fn(async () => ({ content: '抱歉我无法输出 JSON', finishReason: 'stop' }));
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode({ llm: { generate: generate as unknown as GenerateFn }, projectPath });

    const result = await node.run(makeInput());
    const artifact = result.artifact as any;
    expect(artifact.patches).toEqual([]);
  });

  it('project.yaml 损坏 → context 降级 {}，generate 照常被调（提取不因 context 缺失而破）', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), ':\n  - [broken', 'utf8');
    const generate = vi.fn(async () => ({ content: validLlmJson([]), finishReason: 'stop' }));
    const { createStorySyncNode } = await import('../src/nodes/story-sync-agent');
    const node = createStorySyncNode({ llm: { generate: generate as unknown as GenerateFn }, projectPath });

    const result = await node.run(makeInput());
    expect(generate).toHaveBeenCalledTimes(1);
    const userContent = (generate.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    // context 降级 {} → fieldVersions 空 map（无版本锁，rule 4「找不到用 0」语义），设定参照字段整体缺省。
    expect(userContent).toContain('"fieldVersions": {}');
    expect(userContent).not.toContain('"assetCards"');
    const artifact = result.artifact as any;
    expect(artifact.patches).toEqual([]);
  });
});

describe('loadStorySyncContext（Story 2.2 WP-E context 组装）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-story-sync-ctx-'));
  });

  afterEach(() => {
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
    vi.resetModules();
  });

  it('抽设定字段 + episode index（chapterNumber）+ fieldVersions', async () => {
    writeProject(projectPath);
    const { loadStorySyncContext } = await import('../src/nodes/story-sync-agent');
    const ctx = await loadStorySyncContext(projectPath, 'ep1');
    expect(ctx).not.toBeNull();
    expect(ctx!.fieldVersions).toEqual({ asset_cards: 2 });
    expect(ctx!.chapterNumber).toBe(3); // episode_outlines 真实查找（index 字段）
    expect(ctx!.novelTitle).toBe('测试小说');
    expect(Array.isArray(ctx!.assetCards)).toBe(true);
    expect(ctx!.relationshipGraph).toBeDefined();
  });

  it('project.yaml 缺失 → null（graceful）', async () => {
    const { loadStorySyncContext } = await import('../src/nodes/story-sync-agent');
    const ctx = await loadStorySyncContext(projectPath, 'ep1');
    expect(ctx).toBeNull();
  });

  it('projectPath 缺省 → null（节点降级空 context）', async () => {
    const { loadStorySyncContext } = await import('../src/nodes/story-sync-agent');
    expect(await loadStorySyncContext(undefined, 'ep1')).toBeNull();
  });
});
