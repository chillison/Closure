import { describe, expect, it, vi } from 'vitest';
import {
  createWorldExtractorNode,
  createWorldMergeNode,
  parseAxisExtraction,
  type WorldWriter,
  type WorldStateEventsArtifact,
} from '../src/nodes/world-extractor-node';
import { mergeWorldEvents, type AxisExtraction, type PerAxisEvents } from '../src/nodes/world-state-merge';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { RunSnapshot } from '../src/contracts/run';
import type { WriteWorldStateRequest } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.6 Phase C1：world-extractor 节点 + merge 纯函数 + merge 节点测试。
//
// 不测真实 generateText（LLM 质量非 dogfood 推迟，照 project-dogfood-deferred-after-core-features）。
// 测三块（implement.md Phase E 5）：
// 1. parseAxisExtraction：合成 LLM JSON 输出 → AxisExtraction（含坏条目丢弃 + axis 强制 + cap）。
// 2. mergeWorldEvents：纯函数（多轴合并 + subjects 收集 + 跨轴 ref + 稳定 slice.id）。
// 3. 节点契约 + run 行为（extractor mock generate / merge mock writer）。
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_world',
    status: 'running',
    currentNodeId: null,
    projectPath: '/test/project',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}

// 合成物理轴提取器 LLM 输出（含坏条目测 safeParse 丢弃）。
const PHYSICAL_LLM_OUTPUT = {
  storyTime: 5,
  title: '城北遭遇战',
  subjects: [
    { id: 'erina', type: 'character', name: '艾莉娜', sourceCardId: 'char_erina' },
    // 坏条目：缺 type → safeParse 丢
    { id: 'bad-no-type', name: '坏主体' },
    { id: 'sword-01', type: 'item', name: '旧剑' },
  ],
  patches: [
    {
      subjectId: 'erina',
      path: '/hp',
      op: 'increment',
      value: -30,
      summary: '受伤',
      grounding: '一把长剑划过她的肩膀',
      // axis 故意写错（LLM 误标）—— parseAxisExtraction 应强制覆盖为 'physical'
      axis: 'emotional',
    },
    {
      subjectId: 'erina',
      path: '/inventory',
      op: 'append',
      value: 'subject://sword-01',
      summary: '获得旧剑',
      grounding: '她弯腰捡起那把剑',
    },
    // 坏条目：缺 path → safeParse 丢
    { subjectId: 'erina', op: 'replace', value: 100 },
    // 坏条目：op 非法 → safeParse 丢
    { subjectId: 'erina', path: '/hp', op: 'teleport', value: 1 },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 1. parseAxisExtraction（合成 LLM JSON → AxisExtraction）
// ════════════════════════════════════════════════════════════════════════════

describe('parseAxisExtraction', () => {
  it('裸 JSON → AxisExtraction（坏条目丢弃，好条目保留）', () => {
    const ext = parseAxisExtraction(JSON.stringify(PHYSICAL_LLM_OUTPUT), 'physical');
    expect(ext.storyTime).toBe(5);
    expect(ext.title).toBe('城北遭遇战');
    // 坏主体（缺 type）丢；好主体 2 个。id 已走 #91 单源规范化：有卡主体 id=卡 id（char_erina）、
    // 无卡主体 canonical `<type>:<slug>`（item:sword-01）。
    expect(ext.subjects).toHaveLength(2);
    expect(ext.subjects.map((s) => s.id)).toEqual(['char_erina', 'item:sword-01']);
    // 坏 patch（缺 path / 非法 op）丢；好 patch 2 个
    expect(ext.patches).toHaveLength(2);
    // patch.subjectId 同步改写到规范化 id
    expect(ext.patches.map((p) => p.subjectId)).toEqual(['char_erina', 'char_erina']);
  });

  it('axis 强制注入（不信 LLM 标注——LLM 写 emotional 被覆盖为 physical）', () => {
    const ext = parseAxisExtraction(JSON.stringify(PHYSICAL_LLM_OUTPUT), 'physical');
    for (const patch of ext.patches) {
      expect(patch.axis).toBe('physical');
    }
  });

  it('grounding 透传保留（审计用，写表时由 merge 剥离）', () => {
    const ext = parseAxisExtraction(JSON.stringify(PHYSICAL_LLM_OUTPUT), 'physical');
    expect(ext.patches[0].grounding).toBe('一把长剑划过她的肩膀');
    expect(ext.patches[1].grounding).toBe('她弯腰捡起那把剑');
  });

  it('Story 5.2：emotional axis VAD-shape value 透传（语义 /mood 一等 + 可选 vad 投影，z.unknown() passthrough）', () => {
    // 5.2 emotional 提取器产语义态 + 可选 VAD 投影（mirror vadTripleSchema -1..1）。patch value 是自由 JSON
    // （worldPatchInputSchema.value: z.unknown()），parseAxisExtraction 透传不校验 VAD shape（schema 层不背语义，
    // VAD 范围校验归消费侧）。本测验证 emotional 维 value 带可选 vad 形态原样透传。
    const emotionalOutput = {
      storyTime: 3,
      title: '恐惧爆发',
      subjects: [{ id: 'char-1', type: 'character', name: '主角' }],
      patches: [
        {
          subjectId: 'char-1',
          path: '/mood',
          op: 'replace',
          value: { objective: '恐惧', reader_perceived: '镇定', vad: { v: -0.7, a: 0.8, d: -0.3 } },
          summary: '主角内心恐惧表面镇定',
          grounding: '她手心冒汗，面色却平静如常。',
        },
      ],
    };
    const ext = parseAxisExtraction(JSON.stringify(emotionalOutput), 'emotional');
    expect(ext.patches).toHaveLength(1);
    expect(ext.patches[0].axis).toBe('emotional'); // axis 强制注入 emotional
    const value = ext.patches[0].value as { objective: string; vad: { v: number; a: number; d: number } };
    expect(value.objective).toBe('恐惧'); // 语义 /mood 一等
    expect(value.vad).toEqual({ v: -0.7, a: 0.8, d: -0.3 }); // 可选 vad 投影透传
  });

  it('```json 围栏 + 前导文字 → extractJson 剥离后 parse 成功', () => {
    const fenced = `这是提取结果：\n\`\`\`json\n${JSON.stringify(PHYSICAL_LLM_OUTPUT)}\n\`\`\``;
    const ext = parseAxisExtraction(fenced, 'physical');
    expect(ext.storyTime).toBe(5);
    expect(ext.patches).toHaveLength(2);
  });

  it('root 非 JSON → 抛（触发 createLlmNode 重试/兜底）', () => {
    expect(() => parseAxisExtraction('not json at all', 'physical')).toThrow();
  });

  it('root 缺 storyTime → 抛（root shape 校验失败）', () => {
    const badRoot = JSON.stringify({ title: '无 storyTime', subjects: [], patches: [] });
    expect(() => parseAxisExtraction(badRoot, 'physical')).toThrow();
  });

  it('root subjects/patches 缺省 → 空数组（graceful，非抛）', () => {
    const minimal = JSON.stringify({ storyTime: 1, title: '空切面' });
    const ext = parseAxisExtraction(minimal, 'physical');
    expect(ext.subjects).toEqual([]);
    expect(ext.patches).toEqual([]);
  });

  it('cap：patches 超 MAX_PATCHES_PER_AXIS 截断（程序兜底，防 misbehaving 提取器）', () => {
    const many = {
      storyTime: 1,
      title: 't',
      subjects: [],
      patches: Array.from({ length: 150 }, (_, i) => ({
        subjectId: 'erina',
        path: `/p${i}`,
        op: 'replace',
        value: i,
      })),
    };
    const ext = parseAxisExtraction(JSON.stringify(many), 'physical');
    expect(ext.patches.length).toBeLessThanOrEqual(100);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. mergeWorldEvents（纯函数：多轴合并 + subjects 收集 + 跨轴 ref + 稳定 slice.id）
// ════════════════════════════════════════════════════════════════════════════

describe('mergeWorldEvents', () => {
  it('空输入 → []（无 writes）', () => {
    expect(mergeWorldEvents({}, 'ep1')).toEqual([]);
  });

  it('单轴（physical）→ 一个 write，稳定 slice.id = `${episodeId}:${storyTime}`', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 5,
        title: '城北遭遇战',
        patches: [
          { subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical', summary: '受伤' },
        ],
        subjects: [{ id: 'erina', type: 'character', name: '艾莉娜', sourceCardId: 'char_erina' }],
      },
    };
    const writes = mergeWorldEvents(perAxis, 'ep1');
    expect(writes).toHaveLength(1);
    expect(writes[0].sliceId).toBe('ep1:5');
    expect(writes[0].storyTime).toBe(5);
    expect(writes[0].title).toBe('城北遭遇战');
    expect(writes[0].patches).toHaveLength(1);
    // firstSeenStoryTime 由 merge 赋（= 该 storyTime）
    expect(writes[0].subjects[0]).toMatchObject({ id: 'erina', firstSeenStoryTime: 5 });
  });

  it('grounding 剥离（写表的 WorldPatchInput 无 grounding 字段）', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 5,
        title: 't',
        patches: [
          {
            subjectId: 'erina',
            path: '/hp',
            op: 'increment',
            value: -30,
            axis: 'physical',
            summary: '受伤',
            grounding: '正文原文',
          },
        ],
        subjects: [{ id: 'erina', type: 'character' }],
      },
    };
    const writes = mergeWorldEvents(perAxis, 'ep1');
    expect(writes[0].patches[0]).not.toHaveProperty('grounding');
    expect(writes[0].patches[0]).toMatchObject({ subjectId: 'erina', path: '/hp', op: 'increment', value: -30 });
  });

  it('多轴同 storyTime → 归同 slice（patches 合并 + subjects 跨轴去重 COALESCE）', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 5,
        title: '遭遇战',
        patches: [
          { subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical', summary: '受伤' },
        ],
        subjects: [{ id: 'erina', type: 'character', name: '艾莉娜' }],
      },
      emotional: {
        storyTime: 5,
        title: '情绪波动',
        patches: [
          { subjectId: 'erina', path: '/mood', op: 'replace', value: '恐惧', axis: 'emotional', summary: '害怕' },
        ],
        // 同 id 主体，sourceCardId 补（COALESCE：physical 的 name 不被空值 clobber）
        subjects: [{ id: 'erina', type: 'character', sourceCardId: 'char_erina' }],
      },
    };
    const writes = mergeWorldEvents(perAxis, 'ep1');
    // 同 storyTime → 一个 slice
    expect(writes).toHaveLength(1);
    expect(writes[0].sliceId).toBe('ep1:5');
    // patches 跨轴合并
    expect(writes[0].patches).toHaveLength(2);
    // subjects 跨轴去重（erina 合并，name + sourceCardId COALESCE）
    expect(writes[0].subjects).toHaveLength(1);
    expect(writes[0].subjects[0]).toMatchObject({
      id: 'erina',
      name: '艾莉娜',
      sourceCardId: 'char_erina',
    });
  });

  it('多轴不同 storyTime → 多个 write（按 storyTime 升序）', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 10,
        title: '晚',
        patches: [{ subjectId: 'a', path: '/x', op: 'replace', value: 1, axis: 'physical' }],
        subjects: [{ id: 'a', type: 'character' }],
      },
      cognitive: {
        storyTime: 3,
        title: '早',
        patches: [{ subjectId: 'a', path: '/y', op: 'replace', value: 2, axis: 'cognitive' }],
        subjects: [{ id: 'a', type: 'character' }],
      },
    };
    const writes = mergeWorldEvents(perAxis, 'ep1');
    expect(writes).toHaveLength(2);
    // 升序：storyTime 3 在前
    expect(writes[0].storyTime).toBe(3);
    expect(writes[1].storyTime).toBe(10);
  });

  it('跨轴引用链接：patch value 含 subject://ref 且 ref 主体未登记 → 补 stub（type=entity）', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 5,
        title: 't',
        patches: [
          {
            subjectId: 'erina',
            path: '/equipment/weapon',
            op: 'replace',
            value: 'subject://sword-01',
            axis: 'physical',
          },
        ],
        // sword-01 未在 subjects 登记（提取器漏登记）
        subjects: [{ id: 'erina', type: 'character' }],
      },
    };
    const writes = mergeWorldEvents(perAxis, 'ep1');
    const subjectIds = writes[0].subjects.map((s) => s.id);
    expect(subjectIds).toContain('sword-01');
    const sword = writes[0].subjects.find((s) => s.id === 'sword-01')!;
    expect(sword.type).toBe('entity');
    expect(sword.firstSeenStoryTime).toBe(5);
  });

  it('CR-2: episodeId 缺省 → 返 []（不退 unknown 前缀，避跨章节 slice.id 撞）', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 7,
        title: 't',
        patches: [{ subjectId: 'a', path: '/x', op: 'replace', value: 1, axis: 'physical' }],
        subjects: [{ id: 'a', type: 'character' }],
      },
    };
    // episodeId 空串 → 返 []（不写；caller createWorldMergeNode 不调 writer）。
    expect(mergeWorldEvents(perAxis, '')).toEqual([]);
  });

  it('CR-E8: 组 patches 全空 → 跳过该组（不产 write，违 NeuroBook §3 无 patch 不存切面）', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 5,
        title: '空提取',
        patches: [],
        subjects: [{ id: 'a', type: 'character', name: '某主体' }],
      },
    };
    // patches 全空 → 该 storyTime 组跳过（即使有 subjects 登记也不写空 slice）。
    expect(mergeWorldEvents(perAxis, 'ep1')).toEqual([]);
  });

  it('CR-E8: 多轴同 storyTime 其中一轴空 patches → 该组仍有他轴 patches 不跳过', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 5,
        title: '有 patch',
        patches: [{ subjectId: 'a', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
        subjects: [{ id: 'a', type: 'character' }],
      },
      emotional: {
        storyTime: 5,
        title: '空 patch',
        patches: [],
        subjects: [{ id: 'a', type: 'character', sourceCardId: 'char_a' }],
      },
    };
    const writes = mergeWorldEvents(perAxis, 'ep1');
    // 同 storyTime 一组：physical 有 patches → 不跳过；emotional 空 patches 贡献 subjects（sourceCardId COALESCE）。
    expect(writes).toHaveLength(1);
    expect(writes[0].patches).toHaveLength(1);
    expect(writes[0].subjects[0]).toMatchObject({ id: 'a', sourceCardId: 'char_a' });
  });

  it('CR-8: patch value 含多个 subject:// ref → 所有缺失主体登记（非首个）', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 5,
        title: '多 ref 装备',
        patches: [
          {
            subjectId: 'erina',
            path: '/equipment',
            op: 'replace',
            // value 含 3 个 subject:// ref（weapon + ring + armor）
            value: {
              weapon: 'subject://sword-01',
              ring: 'subject://ring-01',
              armor: 'subject://armor-01',
            },
            axis: 'physical',
          },
        ],
        // 只有 erina 登记，3 个 ref 主体都未登记
        subjects: [{ id: 'erina', type: 'character' }],
      },
    };
    const writes = mergeWorldEvents(perAxis, 'ep1');
    const subjectIds = writes[0].subjects.map((s) => s.id);
    // CR-8：所有 3 个 ref 主体都补 stub（非只首个）。
    expect(subjectIds).toEqual(['erina', 'sword-01', 'ring-01', 'armor-01']);
    const stubs = writes[0].subjects.filter((s) => s.id !== 'erina');
    expect(stubs.every((s) => s.type === 'entity')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. createWorldExtractorNode（节点契约 + run 行为，mock generate）
// ════════════════════════════════════════════════════════════════════════════

describe('createWorldExtractorNode', () => {
  it('契约：requiredArtifactKeys=[draft.initial, scene_graph]，produced=[world_events.physical]', () => {
    const node = createWorldExtractorNode('physical', { generate: vi.fn() });
    expect(node.contract?.nodeId).toBe('world-extractor-physical');
    expect(node.contract?.requiredArtifactKeys).toEqual(['draft.initial', 'scene_graph']);
    expect(node.contract?.producedArtifactKeys).toEqual(['world_events.physical']);
    expect(node.contract?.sideEffects).toContain('call_model');
  });

  it('run：mock generate 返合成 JSON → 产 world_events.physical artifact（AxisExtraction）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify(PHYSICAL_LLM_OUTPUT),
      finishReason: 'stop',
    }));
    const node = createWorldExtractorNode('physical', { generate });
    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: '艾莉娜走进城北...' },
        scene_graph: { nodes: [], edges: [], lines: [] },
        chapter_brief_input: { episodeId: 'ep1', brief: {} },
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('world_events.physical');
    const ext = result.artifact as AxisExtraction;
    expect(ext.storyTime).toBe(5);
    expect(ext.patches).toHaveLength(2);
    // axis 强制 physical
    expect(ext.patches.every((p) => p.axis === 'physical')).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('CR-E3: generate 返畸形 JSON 两次 → 不产 error artifact，改产空 AxisExtraction（graceful，链段不破）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: 'totally not json', finishReason: 'stop' }));
    const node = createWorldExtractorNode('physical', { generate });
    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: 'x' },
        scene_graph: { nodes: [], edges: [], lines: [] },
      }),
      requirement: '',
    });
    // CR-E3：createLlmNode 兜底 error artifact 被 wrapper 转为空 AxisExtraction（world-state 增强非硬约束，
    // 单轴失败 graceful 跳过，不破 chapter chain——避 chainRunner isErrorArtifact→break）。
    expect(result.stateKey).toBe('world_events.physical');
    const ext = result.artifact as AxisExtraction;
    expect((ext as { error?: boolean }).error).toBeFalsy();
    expect(ext.patches).toEqual([]);
    expect(ext.subjects).toEqual([]);
    expect(ext.title).toBe('physical-extraction-failed');
    // generate 仍重试两次（createLlmNode 重试机制不变，只 wrapper 改 fallback 形态）。
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. createWorldMergeNode（节点契约 + run 行为，mock writer）
// ════════════════════════════════════════════════════════════════════════════

describe('createWorldMergeNode', () => {
  it('契约：required=5 轴 world_events，produced=[world_state.events]', () => {
    const node = createWorldMergeNode({});
    expect(node.contract?.nodeId).toBe('world-merge-node');
    expect(node.contract?.requiredArtifactKeys).toEqual([
      'world_events.physical',
      'world_events.cognitive',
      'world_events.emotional',
      'world_events.relational',
      'world_events.factional',
    ]);
    expect(node.contract?.producedArtifactKeys).toEqual(['world_state.events']);
  });

  it('run：读 world_events.physical → merge → 调 writer 落表 → 产 world_state.events artifact', async () => {
    const writer = vi.fn<WorldWriter>(async () => {});
    const node = createWorldMergeNode({ writeWorldEvents: writer });
    const physical: AxisExtraction = {
      storyTime: 5,
      title: '城北遭遇战',
      patches: [
        { subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical', summary: '受伤' },
      ],
      subjects: [{ id: 'erina', type: 'character', name: '艾莉娜' }],
    };
    const result = await node.run({
      run: makeRun({
        'world_events.physical': physical,
        chapter_brief_input: { episodeId: 'ep1', brief: {} },
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('world_state.events');
    // writer 被调一次（一个 slice）
    expect(writer).toHaveBeenCalledTimes(1);
    // writer 收到的 req 形态校验
    const req = writer.mock.calls[0][0] as WriteWorldStateRequest;
    expect(req.slice.id).toBe('ep1:5');
    expect(req.slice.storyTime).toBe(5);
    expect(req.patches).toHaveLength(1);
    expect(req.subjects[0]).toMatchObject({ id: 'erina', name: '艾莉娜', firstSeenStoryTime: 5 });
    // artifact 摘要
    const art = result.artifact as WorldStateEventsArtifact;
    expect(art.totalPatches).toBe(1);
    expect(art.totalSubjects).toBe(1);
    expect(art.writes[0]).toMatchObject({ sliceId: 'ep1:5', patchCount: 1, subjectCount: 1 });
    expect(art.writeErrors).toEqual([]);
  });

  it('run：writer 未注入 → skip 落表，仍产 artifact（graceful，测试/工具未注册用）', async () => {
    const node = createWorldMergeNode({});
    const result = await node.run({
      run: makeRun({
        'world_events.physical': {
          storyTime: 5,
          title: 't',
          patches: [{ subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical' }],
          subjects: [{ id: 'erina', type: 'character' }],
        },
        chapter_brief_input: { episodeId: 'ep1', brief: {} },
      }),
      requirement: '',
    });
    const art = result.artifact as WorldStateEventsArtifact;
    expect(art.writes).toHaveLength(1);
    expect(art.totalPatches).toBe(1);
  });

  it('run：writer 抛错 → 记 writeErrors，链段不崩（continue 下一个 write）', async () => {
    const writer = vi.fn<WorldWriter>(async () => {
      throw new Error('DB connection refused');
    });
    const node = createWorldMergeNode({ writeWorldEvents: writer });
    const result = await node.run({
      run: makeRun({
        'world_events.physical': {
          storyTime: 5,
          title: 't',
          patches: [{ subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical' }],
          subjects: [{ id: 'erina', type: 'character' }],
        },
        chapter_brief_input: { episodeId: 'ep1', brief: {} },
      }),
      requirement: '',
    });
    const art = result.artifact as WorldStateEventsArtifact;
    expect(art.writeErrors).toHaveLength(1);
    expect(art.writeErrors[0].sliceId).toBe('ep1:5');
    expect(art.writeErrors[0].error).toContain('DB connection refused');
    // 非 error artifact（节点产出正常 artifact，错误在 writeErrors 内）
    expect((result.artifact as { error?: boolean }).error).toBeFalsy();
  });

  it('CR-2: 缺 chapter_brief_input → episodeId 缺省，writer 不被调（不写，避跨章节 slice.id 撞）', async () => {
    const writer = vi.fn<WorldWriter>(async () => {});
    const node = createWorldMergeNode({ writeWorldEvents: writer });
    const result = await node.run({
      run: makeRun({
        'world_events.physical': {
          storyTime: 9,
          title: 't',
          patches: [{ subjectId: 'a', path: '/x', op: 'replace', value: 1, axis: 'physical' }],
          subjects: [{ id: 'a', type: 'character' }],
        },
        // 无 chapter_brief_input → episodeId undefined → mergeWorldEvents 返 [] → writer 不调
      }),
      requirement: '',
    });
    expect(writer).not.toHaveBeenCalled();
    const art = result.artifact as WorldStateEventsArtifact;
    expect(art.writes).toEqual([]);
    expect(art.totalPatches).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Story 6.6 Phase C2：4 新轴（cognitive/emotional/relational/factional）parseOutput + 节点契约
// ════════════════════════════════════════════════════════════════════════════

describe('createWorldExtractorNode — 4 新轴（C2）', () => {
  // 各轴契约 + producedArtifactKey + axis 强制注入（parseAxisExtraction 复用，axis 参数化）。
  const newAxes = ['cognitive', 'emotional', 'relational', 'factional'] as const;

  for (const axis of newAxes) {
    it(`契约：axis=${axis} → nodeId/producedArtifactKeys/sideEffects 对齐`, () => {
      const node = createWorldExtractorNode(axis, { generate: vi.fn() });
      expect(node.contract?.nodeId).toBe(`world-extractor-${axis}`);
      expect(node.contract?.requiredArtifactKeys).toEqual(['draft.initial', 'scene_graph']);
      expect(node.contract?.producedArtifactKeys).toEqual([`world_events.${axis}`]);
      expect(node.contract?.sideEffects).toContain('call_model');
    });

    it(`parseAxisExtraction：axis=${axis} 强制注入（不信 LLM 标注）`, () => {
      const llmOutput = {
        storyTime: 3,
        title: `${axis} 切面`,
        subjects: [{ id: 'subj-1', type: 'character', name: '某主体' }],
        // axis 故意写错（LLM 误标 'physical'）—— parseAxisExtraction 应强制覆盖为本轴
        patches: [
          { subjectId: 'subj-1', path: '/x', op: 'replace', value: 'v', axis: 'physical' },
        ],
      };
      const ext = parseAxisExtraction(JSON.stringify(llmOutput), axis);
      expect(ext.patches).toHaveLength(1);
      expect(ext.patches[0].axis).toBe(axis);
    });
  }

  it('relational 轴：objective + reader_perceived 分层 value 结构透传（merge 不消解分层）', () => {
    const layered = {
      storyTime: 5,
      title: '暗中结盟',
      subjects: [
        { id: 'erina', type: 'character', name: '艾莉娜' },
        { id: 'kael', type: 'character', name: '凯尔' },
      ],
      patches: [
        {
          subjectId: 'erina',
          path: '/relationship/kael',
          op: 'replace',
          value: { objective: '盟友', reader_perceived: '敌人' },
          summary: '表面敌对实则结盟',
        },
      ],
    };
    const ext = parseAxisExtraction(JSON.stringify(layered), 'relational');
    expect(ext.patches).toHaveLength(1);
    // 分层 value 原样透传（parseAxisExtraction 不解构 value）
    expect(ext.patches[0].value).toEqual({ objective: '盟友', reader_perceived: '敌人' });
  });

  it('factional 轴：increment op（国库 +1000）+ organization subject', () => {
    const factional = {
      storyTime: 7,
      title: '凤凰王国扩充',
      subjects: [{ id: 'faction:phoenix', type: 'organization', name: '凤凰王国', sourceCardId: 'org_phoenix' }],
      patches: [
        { subjectId: 'faction:phoenix', path: '/treasury', op: 'increment', value: 1000, summary: '国库增收' },
      ],
    };
    const ext = parseAxisExtraction(JSON.stringify(factional), 'factional');
    expect(ext.patches[0]).toMatchObject({ op: 'increment', value: 1000, axis: 'factional' });
    // #91：有卡主体 id = 卡 id 原样（对齐目标轨，优先于 LLM 产 id）；patch.subjectId 同步改写。
    expect(ext.subjects[0]).toMatchObject({ id: 'org_phoenix', type: 'organization', sourceCardId: 'org_phoenix' });
    expect(ext.patches[0].subjectId).toBe('org_phoenix');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood R2 #91：subject ID 单源规范化（五提取器共用 parseAxisExtraction 单点）
// ════════════════════════════════════════════════════════════════════════════

describe('parseAxisExtraction — subject ID 单源规范化（#91）', () => {
  it('三形态并存收敛：裸 slug / type 前缀 / 连字符变体 → canonical `<type>:<slug>`', () => {
    // mirror project 00004 实证形态（shen-yan 三分身）；本轴内两变体登记 + 引用都收敛。
    const llmOutput = {
      storyTime: 1,
      title: '舱内苏醒',
      subjects: [
        { id: 'shen-yan', type: 'character', name: '沈砚' },
        { id: 'character:shenyan', type: 'character' }, // 同角色连字符变体（双登记）
      ],
      patches: [
        { subjectId: 'shen-yan', path: '/mood', op: 'replace', value: '警惕', summary: '苏醒警惕' },
        { subjectId: 'character:shenyan', path: '/presence_scene', op: 'replace', value: 'scene-1', summary: '在场' },
      ],
    };
    const ext = parseAxisExtraction(JSON.stringify(llmOutput), 'emotional');
    // shen-yan → character:shen-yan（canonical）；character:shenyan slug 段 'shenyan' 无连字符——
    // canonical 化不增删连字符（位置不可机械推断），两登记 id 不同：agent 层保形态规范，
    // 连字符变体的跨轴/跨章归并由 shell 写入门 matchKey 兜底（resolveWorldSubjectIdentity）。
    expect(ext.subjects.map((s) => s.id)).toEqual(['character:shen-yan', 'character:shenyan']);
    expect(ext.patches.map((p) => p.subjectId)).toEqual(['character:shen-yan', 'character:shenyan']);
  });

  it('同轴撞 canonical id（`shen-yan` + `character:shen-yan` 双登记）→ 登记合并（name COALESCE）', () => {
    const llmOutput = {
      storyTime: 2,
      title: '双重登记',
      subjects: [
        { id: 'shen-yan', type: 'character', name: '沈砚' },
        { id: 'character:shen-yan', type: 'character' }, // 同 id 变体——canonical 后撞 id
      ],
      patches: [{ subjectId: 'character:shen-yan', path: '/hp', op: 'replace', value: 100 }],
    };
    const ext = parseAxisExtraction(JSON.stringify(llmOutput), 'physical');
    expect(ext.subjects).toHaveLength(1);
    expect(ext.subjects[0]).toMatchObject({ id: 'character:shen-yan', name: '沈砚' });
    expect(ext.patches[0].subjectId).toBe('character:shen-yan');
  });

  it('大小写 / 空白 / 前缀叠折形态收敛', () => {
    const llmOutput = {
      storyTime: 3,
      title: '形态噪声',
      subjects: [
        { id: 'Xiao Guan', type: 'character', name: '小关' },   // 空白 + 大写
        { id: 'group:archaeology-team', type: 'group', name: '考古队' }, // 已规范（幂等）
      ],
      patches: [
        { subjectId: 'Xiao Guan', path: '/location', op: 'replace', value: 'subject://group:archaeology-team' },
      ],
    };
    const ext = parseAxisExtraction(JSON.stringify(llmOutput), 'physical');
    expect(ext.subjects.map((s) => s.id)).toEqual(['character:xiao-guan', 'group:archaeology-team']);
    expect(ext.patches[0].subjectId).toBe('character:xiao-guan');
    // ⚠️ patch.value 内 subject:// ref 不在 agent 层改写（无 type 语境 + 属 shell 写入门职责）——原样透传。
    expect(ext.patches[0].value).toBe('subject://group:archaeology-team');
  });

  it('表外 subjectId（不在 subjects 登记内）原样保留——shell 写入门兜底归一', () => {
    const llmOutput = {
      storyTime: 4,
      title: '表外引用',
      subjects: [{ id: 'erina', type: 'character', name: '艾莉娜' }],
      patches: [{ subjectId: 'kael', path: '/allies', op: 'append', value: 'subject://erina' }],
    };
    const ext = parseAxisExtraction(JSON.stringify(llmOutput), 'relational');
    // kael 不在本轴 subjects 表内——agent 层无 type 语境不可判，留 shell 写入门归一（belt）
    expect(ext.patches[0].subjectId).toBe('kael');
    expect(ext.subjects[0].id).toBe('character:erina');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Story 6.6 Phase C2：mergeWorldEvents 5 轴合并（多轴同 storyTime 归同 slice）
// ════════════════════════════════════════════════════════════════════════════

describe('mergeWorldEvents — 5 轴合并（C2）', () => {
  it('5 轴同 storyTime → 归同 slice（patches 跨 5 轴合并 + subjects 跨轴去重）', () => {
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 5,
        title: '物理',
        patches: [{ subjectId: 'erina', path: '/hp', op: 'increment', value: -10, axis: 'physical', summary: '受伤' }],
        subjects: [{ id: 'erina', type: 'character', name: '艾莉娜' }],
      },
      cognitive: {
        storyTime: 5,
        title: '认知',
        patches: [{ subjectId: 'erina', path: '/suspects/kael', op: 'replace', value: '叛徒', axis: 'cognitive', summary: '起疑' }],
        subjects: [{ id: 'erina', type: 'character' }],
      },
      emotional: {
        storyTime: 5,
        title: '情绪',
        patches: [{ subjectId: 'erina', path: '/mood', op: 'replace', value: '愤怒', axis: 'emotional', summary: '怒' }],
        subjects: [],
      },
      relational: {
        storyTime: 5,
        title: '关系',
        patches: [{
          subjectId: 'erina',
          path: '/relationship/kael',
          op: 'replace',
          value: { objective: '盟友', reader_perceived: '敌人' },
          axis: 'relational',
          summary: '暗中结盟',
        }],
        subjects: [{ id: 'kael', type: 'character', name: '凯尔' }],
      },
      factional: {
        storyTime: 5,
        title: '势力',
        patches: [{ subjectId: 'faction:phoenix', path: '/treasury', op: 'increment', value: 500, axis: 'factional', summary: '国库增' }],
        subjects: [{ id: 'faction:phoenix', type: 'organization', name: '凤凰王国' }],
      },
    };
    const writes = mergeWorldEvents(perAxis, 'ep1');
    // 5 轴同 storyTime → 一个 slice
    expect(writes).toHaveLength(1);
    expect(writes[0].sliceId).toBe('ep1:5');
    // 5 轴 patches 合并到一个 slice
    expect(writes[0].patches).toHaveLength(5);
    // patches 的 axis 覆盖 5 轴
    const axes = writes[0].patches.map((p) => p.axis);
    expect(new Set(axes)).toEqual(new Set(['physical', 'cognitive', 'emotional', 'relational', 'factional']));
    // subjects 跨轴去重（erina 出现在 physical+cognitive → 合一；kael + faction:phoenix 独立）
    const subjectIds = writes[0].subjects.map((s) => s.id);
    expect(subjectIds).toEqual(['erina', 'kael', 'faction:phoenix']);
    // erina 合并后 name 保留（COALESCE）
    const erina = writes[0].subjects.find((s) => s.id === 'erina')!;
    expect(erina.name).toBe('艾莉娜');
    // objective/reader_perceived 分层 value 不被消解（原样保留）
    const relPatch = writes[0].patches.find((p) => p.axis === 'relational')!;
    expect(relPatch.value).toEqual({ objective: '盟友', reader_perceived: '敌人' });
  });

  it('5 轴不同 storyTime → 多个 write（按 storyTime 升序，同 storyTime 合并）', () => {
    const mkAxisPatches = (axis: string) => [
      { subjectId: 'a', path: `/${axis}`, op: 'replace', value: 1, axis },
    ];
    const perAxis: PerAxisEvents = {
      physical: {
        storyTime: 10,
        title: '晚物理',
        patches: mkAxisPatches('physical'),
        subjects: [{ id: 'a', type: 'character' }],
      },
      cognitive: {
        storyTime: 3,
        title: '早认知',
        patches: mkAxisPatches('cognitive'),
        subjects: [{ id: 'a', type: 'character' }],
      },
      emotional: { storyTime: 7, title: '中情绪', patches: mkAxisPatches('emotional'), subjects: [] },
      relational: { storyTime: 7, title: '中关系', patches: mkAxisPatches('relational'), subjects: [] },
      factional: { storyTime: 1, title: '最早势力', patches: mkAxisPatches('factional'), subjects: [] },
    };
    const writes = mergeWorldEvents(perAxis, 'ep1');
    // 不同 storyTime: 1, 3, 7, 10 → 4 个 write（emotional+relational 同 7 合并）。每轴有 patches 故不跳过（CR-E8）。
    expect(writes).toHaveLength(4);
    expect(writes.map((w) => w.storyTime)).toEqual([1, 3, 7, 10]);
    // emotional+relational 同 7 → 一个 write，patches 合并
    const st7 = writes.find((w) => w.storyTime === 7)!;
    expect(st7.patches).toHaveLength(2);
  });

  it('createWorldMergeNode run：5 轴 events 全注入 → merge 产 artifact（mock writer 落表）', async () => {
    const writer = vi.fn<WorldWriter>(async () => {});
    const node = createWorldMergeNode({ writeWorldEvents: writer });
    const mkAxis = (axis: string, storyTime: number): AxisExtraction => ({
      storyTime,
      title: `${axis} 切面`,
      patches: [{ subjectId: 'erina', path: `/${axis}`, op: 'replace', value: 'v', axis, summary: `${axis} 变化` }],
      subjects: [{ id: 'erina', type: 'character', name: '艾莉娜' }],
    });
    const result = await node.run({
      run: makeRun({
        'world_events.physical': mkAxis('physical', 5),
        'world_events.cognitive': mkAxis('cognitive', 5),
        'world_events.emotional': mkAxis('emotional', 5),
        'world_events.relational': mkAxis('relational', 5),
        'world_events.factional': mkAxis('factional', 5),
        chapter_brief_input: { episodeId: 'ep1', brief: {} },
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('world_state.events');
    // 5 轴同 storyTime → 一个 write（writer 被调一次）
    expect(writer).toHaveBeenCalledTimes(1);
    const art = result.artifact as WorldStateEventsArtifact;
    expect(art.totalPatches).toBe(5);
    expect(art.writes[0].sliceId).toBe('ep1:5');
    expect(art.writes[0].patchCount).toBe(5);
  });
});
