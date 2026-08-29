import { describe, expect, it, vi } from 'vitest';
import { backfillWorldState, type BackfillInput, type BackfillDeps } from '../src/nodes/world-state-backfill';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { WriteWorldStateRequest, WorldPatchAxis } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4（C-A1）：旧章 world-state 补提取入口测试。
//
// 不测真实 generateText（LLM 质量非 dogfood 推迟）。测三块（implement.md 1.1 验证门）：
// 1. backfillWorldState：mock generate（返合法 AxisExtraction JSON）→ writer 被调 + 正确 slice.id。
// 2. 幂等：重跑同 episode → 同 slice.id（per-slice idempotency，mergeWorldEvents 稳定 slice.id）。
// 3. graceful：空 prose / 空 episodeId / writer 未注入 / 单轴失败。
// ─────────────────────────────────────────────────────────────────────────────

/** 合成某轴的 LLM 输出 JSON（含 1 subject + 1 patch，足够 merge 产 1 write）。 */
function axisOutput(axis: WorldPatchAxis, storyTime: number): string {
  return JSON.stringify({
    storyTime,
    title: `${axis}-extract`,
    subjects: [{ id: 'erina', type: 'character', name: '艾莉娜', sourceCardId: 'char_erina' }],
    patches: [
      {
        subjectId: 'erina',
        path: '/hp',
        op: 'increment',
        value: -10,
        summary: `${axis} 变化`,
        axis, // 故意标 axis（LLM 误标）—— parseAxisExtraction 强制覆盖为本轴
      },
    ],
  });
}

/** mock generate：对任何轴的 prompt 都返该轴合法输出（storyTime 固定便于 slice.id 稳定）。 */
function makeGenerate(storyTime = 5): GenerateFn {
  return vi.fn().mockImplementation(async (messages, _system, _tools, _abort, _opts) => {
    // 从 prompt 内容推断 axis（event-extractor-<axis> 的 user 段含 axis 上下文；此处简化：按调用次序映射）。
    // 实际 createLlmNode 单次 generate 返 content；axis 强制注入在 parseOutput，故 generate 不需精确按轴。
    // 用 storyTime 固定的通用输出（5 轴同 storyTime → merge 归同 slice）。
    const content = JSON.stringify({
      storyTime,
      title: 'backfill-extract',
      subjects: [{ id: 'erina', type: 'character', name: '艾莉娜', sourceCardId: 'char_erina' }],
      patches: [
        { subjectId: 'erina', path: '/hp', op: 'increment', value: -10, summary: '受伤', axis: 'physical' },
      ],
    });
    return { content, toolCalls: [], usage: null };
  }) as unknown as GenerateFn;
}

/** 记录 writer 调用的 spy（返 void/Promise<void>）。 */
function makeWriterSpy() {
  const calls: WriteWorldStateRequest[] = [];
  const writeWorldEvents = vi.fn().mockImplementation(async (req: WriteWorldStateRequest) => {
    calls.push(req);
  });
  return { writeWorldEvents: writeWorldEvents as BackfillDeps['writeWorldEvents'], calls };
}

describe('backfillWorldState (Story 3.4 C-A1)', () => {
  it('对每章跑 5 轴提取 → writer 以稳定 slice.id 落表', async () => {
    const generate = makeGenerate(5);
    const { writeWorldEvents, calls } = makeWriterSpy();
    const input: BackfillInput = {
      episodes: [
        { episodeId: 'ep1', prose: '艾莉娜走进酒馆，拔剑战斗。' },
        { episodeId: 'ep2', prose: '次日，她离开了小镇。' },
      ],
    };
    const result = await backfillWorldState(input, { generate, writeWorldEvents });

    expect(result.episodesProcessed).toBe(2);
    expect(result.episodesWritten).toBe(2);
    // 每 episode 1 write（5 轴同 storyTime 归同 slice）
    expect(result.totalWrites).toBe(2);
    // writer 被调 2 次（每 episode 1 write）
    expect(writeWorldEvents).toHaveBeenCalledTimes(2);
    // slice.id = `${episodeId}:${storyTime}`（稳定，幂等键）
    expect(calls.map((c) => c.slice.id)).toEqual(['ep1:5', 'ep2:5']);
    // Story 8.1：episode 归属显式落列（写路径透传——merge 产 episodeId，toWriteRequest 落 slice，design §4）
    expect(calls.map((c) => c.slice.episodeId)).toEqual(['ep1', 'ep2']);
    // generate 被调 10 次（2 episode × 5 轴）
    expect(generate).toHaveBeenCalledTimes(10);
  });

  it('幂等：重跑同 episode → 同 slice.id（per-slice idempotency，替换不累积）', async () => {
    const generate = makeGenerate(7);
    const { writeWorldEvents, calls } = makeWriterSpy();
    const input: BackfillInput = {
      episodes: [{ episodeId: 'ep1', prose: '艾莉娜走进酒馆。' }],
    };
    // 第一次跑
    await backfillWorldState(input, { generate, writeWorldEvents });
    // 第二次跑（重跑同 episode）
    await backfillWorldState(input, { generate, writeWorldEvents });

    // 两次产同 slice.id（mergeWorldEvents 稳定 slice.id；insertWorldSlice source='derived' 替换不累积）
    expect(calls.map((c) => c.slice.id)).toEqual(['ep1:7', 'ep1:7']);
    // 每次只 1 write（不因第二次跑累积）
    expect(writeWorldEvents).toHaveBeenCalledTimes(2);
  });

  it('writer 未注入 → 只产 writes 摘要不落表（graceful）', async () => {
    const generate = makeGenerate(3);
    const input: BackfillInput = {
      episodes: [{ episodeId: 'ep1', prose: '艾莉娜走进酒馆。' }],
    };
    const result = await backfillWorldState(input, { generate });
    expect(result.episodesWritten).toBe(1);
    expect(result.totalWrites).toBe(1);
    expect(result.writeErrors).toEqual([]);
    // 不抛、不崩（writer 未注入 graceful，mirror world-merge-node 测试用）
  });

  it('空 episodeId → 跳过该章（CR-2 mirror，避跨章 slice.id 撞）', async () => {
    const generate = makeGenerate(5);
    const { writeWorldEvents } = makeWriterSpy();
    const input: BackfillInput = {
      episodes: [
        { episodeId: '', prose: '有正文但无 episodeId' },
        { episodeId: 'ep2', prose: '正常章' },
      ],
    };
    const result = await backfillWorldState(input, { generate, writeWorldEvents });
    expect(result.episodesProcessed).toBe(2);
    expect(result.episodesWritten).toBe(1); // 只有 ep2 落表
    expect(result.episodes[0].skipped).toBe(true);
    expect(result.episodes[0].reason).toContain('episodeId empty');
    // 空 episodeId 章不跑 5 轮 LLM（提前 skip）→ generate 只为 ep2 调 5 次
    expect(generate).toHaveBeenCalledTimes(5);
    expect(writeWorldEvents).toHaveBeenCalledTimes(1);
  });

  it('writer 抛错 → 记 writeErrors 不崩（mirror world-merge-node 单 write 失败继续）', async () => {
    const generate = makeGenerate(5);
    const writeWorldEvents = vi.fn().mockRejectedValue(new Error('db locked'));
    const input: BackfillInput = {
      episodes: [{ episodeId: 'ep1', prose: '艾莉娜走进酒馆。' }],
    };
    const result = await backfillWorldState(input, { generate, writeWorldEvents });
    expect(result.writeErrors).toHaveLength(1);
    expect(result.writeErrors[0].sliceId).toBe('ep1:5');
    expect(result.writeErrors[0].error).toContain('db locked');
    // episode 仍计为 written（writes 产出了，只是落表失败）
    expect(result.episodesWritten).toBe(1);
    expect(result.totalWrites).toBe(1);
  });

  it('空 episodes 列表 → 零处理（graceful）', async () => {
    const generate = makeGenerate(5);
    const result = await backfillWorldState({ episodes: [] }, { generate });
    expect(result.episodesProcessed).toBe(0);
    expect(result.totalWrites).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('多 episode 顺序处理 + 各自 slice.id 独立（不混章）', async () => {
    const generate = makeGenerate(9);
    const writer = makeWriterSpy();
    const input: BackfillInput = {
      episodes: [
        { episodeId: 'ep-a', prose: '第一章正文。' },
        { episodeId: 'ep-b', prose: '第二章正文。' },
        { episodeId: 'ep-c', prose: '第三章正文。' },
      ],
    };
    const result = await backfillWorldState(input, { generate, writeWorldEvents: writer.writeWorldEvents });
    expect(result.episodesProcessed).toBe(3);
    expect(result.totalWrites).toBe(3);
    expect(writer.calls.map((c) => c.slice.id)).toEqual(['ep-a:9', 'ep-b:9', 'ep-c:9']);
    expect(result.episodes.map((e) => e.episodeId)).toEqual(['ep-a', 'ep-b', 'ep-c']);
  });
});
