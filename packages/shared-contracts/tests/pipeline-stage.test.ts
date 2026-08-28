import { describe, expect, it } from 'vitest';
import {
  computePipelineStage,
  pipelineStageFactsSchema,
  type PipelineStageInput,
} from '../src/contracts/pipeline-stage';
import { findArcCoverageGaps } from '../src/contracts/arc-coverage';
import { episodeOutlineSchema, type EpisodeOutline } from '../src/contracts/creative-fields';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.6 R5：computePipelineStage（流程雷达阶段事实单源，design §3.2/D8/D9）。
// 覆盖（implement.md Step 1）：全站空冷启动 / 灵感启发式（兜底串 vs 真灵感）/ 各站有据 /
// writeReadyLikely 组合 / preferencesSet（含 note 情形）/ 坏形态宽容（跳过不抛）+ schema 契约。
//
// 范式红线：只报存在性/计数事实，不判「该不该有/够不够/完成度」（归 leader LLM，ADR-3）。
// ─────────────────────────────────────────────────────────────────────────────

/** 基底：全站空 + rawRequirement === meta.name（创建期项目名兜底串）= 冷启动标准形态。 */
const coldInput = (over: Partial<PipelineStageInput> = {}): PipelineStageInput => ({
  metaName: '测试项目',
  rawRequirement: '测试项目',
  assetCards: undefined,
  worldSetting: undefined,
  outlinePhases: undefined,
  sceneNodes: undefined,
  growthCurveRaw: undefined,
  episodeOutlines: undefined,
  creativePreferences: undefined,
  settingsPresent: false,
  ...over,
});

const episode = (id: string): EpisodeOutline =>
  episodeOutlineSchema.parse({ id, index: 0, title: id });

// ── 冷启动 + 灵感启发式 ──

describe('computePipelineStage：全站空 → 冷启动', () => {
  it('rawRequirement = 项目名兜底串 + 全站空 → coldStart=true / hasInspirationRecorded=false / 计数全 0', () => {
    const facts = computePipelineStage(coldInput());
    expect(facts.coldStart).toBe(true);
    expect(facts.hasInspirationRecorded).toBe(false);
    expect(facts.characterCardCount).toBe(0);
    expect(facts.worldEntryCount).toBe(0);
    expect(facts.hasWorldSetting).toBe(false);
    expect(facts.outlinePhaseCount).toBe(0);
    expect(facts.sceneNodeCount).toBe(0);
    expect(facts.growthCurveCount).toBe(0);
    expect(facts.episodeCount).toBe(0);
    expect(facts.writeReadyLikely).toBe(false);
    expect(facts.preferencesSet).toBe(false);
  });

  it('rawRequirement 空 / undefined / 纯空白 → 无记录（同兜底串语义）', () => {
    for (const raw of [undefined, '', '   ']) {
      const facts = computePipelineStage(coldInput({ rawRequirement: raw }));
      expect(facts.hasInspirationRecorded).toBe(false);
      expect(facts.coldStart).toBe(true);
    }
  });

  it('rawRequirement 非空且 ≠ meta.name → 灵感已记（启发式——真伪终审归 leader）', () => {
    const facts = computePipelineStage(
      coldInput({ rawRequirement: '废土世界里的邮差，靠送信丈量文明的余温' }),
    );
    expect(facts.hasInspirationRecorded).toBe(true);
    // 灵感已记 → 非冷启动（第一问已完成，雷达进 has 态接判型/设定引导）。
    expect(facts.coldStart).toBe(false);
  });

  it('metaName 缺省（无可对照名）+ rawRequirement 非空 → 记为已记', () => {
    const facts = computePipelineStage(coldInput({ metaName: undefined, rawRequirement: '一段灵感' }));
    expect(facts.hasInspirationRecorded).toBe(true);
  });

  it('全站空 + 偏好已问 → coldStart 仍 true（偏好与冷启动正交——编辑冷启动时顺势问偏好）', () => {
    const facts = computePipelineStage(
      coldInput({ creativePreferences: { arc_timing: 'as_you_go' } }),
    );
    expect(facts.coldStart).toBe(true);
    expect(facts.preferencesSet).toBe(true);
  });
});

// ── 各站有据 ──

describe('computePipelineStage：各站里程碑事实', () => {
  it('asset_cards 分类计数：角色卡 vs 世界条目（非 character 全归世界侧）', () => {
    const facts = computePipelineStage(
      coldInput({
        assetCards: [
          { id: 'c1', type: 'character', name: '林晚' },
          { id: 'c2', type: 'character', name: '陈砚' },
          { id: 'l1', type: 'location', name: '雾城' },
          { id: 'r1', type: 'rule', name: '信约' },
          { id: 'g1', type: 'golden_finger', name: '回声筒' },
        ],
      }),
    );
    expect(facts.characterCardCount).toBe(2);
    expect(facts.worldEntryCount).toBe(3);
    expect(facts.coldStart).toBe(false); // 有卡即非冷启动
  });

  it('asset_cards 混坏元素（null / 非对象 / 无 type）跳过不计数', () => {
    const facts = computePipelineStage(
      coldInput({
        assetCards: [null, 'garbage', { id: 'x', name: '无类型' }, { id: 'c1', type: 'character', name: '林晚' }],
      }),
    );
    expect(facts.characterCardCount).toBe(1);
    expect(facts.worldEntryCount).toBe(0);
  });

  it('hasWorldSetting：任一自有字段非空（string trim / 数组）→ true；空对象 / 全空白 / 非对象 → false', () => {
    expect(computePipelineStage(coldInput({ worldSetting: { premise: '大灾变后百年' } })).hasWorldSetting).toBe(true);
    expect(computePipelineStage(coldInput({ worldSetting: { world_constitution: ['绝不复活'] } })).hasWorldSetting).toBe(true);
    expect(computePipelineStage(coldInput({ worldSetting: {} })).hasWorldSetting).toBe(false);
    expect(computePipelineStage(coldInput({ worldSetting: { premise: '   ' } })).hasWorldSetting).toBe(false);
    expect(computePipelineStage(coldInput({ worldSetting: 42 })).hasWorldSetting).toBe(false);
    expect(computePipelineStage(coldInput({ worldSetting: 'a string' })).hasWorldSetting).toBe(false);
  });

  it('outlinePhaseCount / sceneNodeCount：非空对象元素计数（坏元素跳过）', () => {
    const facts = computePipelineStage(
      coldInput({
        outlinePhases: [{ id: 'p1', title: '卷一' }, { id: 'p2', title: '卷二' }, 'garbage', null],
        sceneNodes: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, 42],
      }),
    );
    expect(facts.outlinePhaseCount).toBe(2);
    expect(facts.sceneNodeCount).toBe(3);
  });

  it('CR-015：数组元素不计数（phases/nodes 坏形态为嵌套数组——typeof "object" 但非里程碑条目，不虚高）', () => {
    const facts = computePipelineStage(
      coldInput({
        outlinePhases: [[{ id: 'p1' }], { id: 'p2' }, []],
        sceneNodes: [['s1'], { id: 's2' }, [], 'garbage', null],
      }),
    );
    expect(facts.outlinePhaseCount).toBe(1); // 嵌套数组元素 [{id:'p1'}] 不计，只计真对象 {id:'p2'}
    expect(facts.sceneNodeCount).toBe(1);
  });

  it('growthCurveCount 单源复用 findArcCoverageGaps.totalCurves（去重角色数——一角色一弧，8.5 语义）', () => {
    const growthCurveRaw = [
      { character_id: 'c1', start_state: '落魄' },
      { character_id: 'c1', start_state: '落魄（重复）' },
      { character_id: 'c2', start_state: '隐世' },
    ];
    const episodes = [episode('ep1'), episode('ep2')];
    const facts = computePipelineStage(coldInput({ growthCurveRaw, episodeOutlines: episodes }));
    expect(facts.growthCurveCount).toBe(2); // 去重后 2 角色，非原始 3 条
    expect(facts.growthCurveCount).toBe(findArcCoverageGaps(growthCurveRaw, episodes).totalCurves);
    expect(facts.episodeCount).toBe(2);
  });
});

// ── writeReadyLikely（D9 项目级预判）──

describe('computePipelineStage：writeReadyLikely = 有场 && 有设定锚 && 有集纲', () => {
  const readyBase = (over: Partial<PipelineStageInput> = {}) =>
    coldInput({
      sceneNodes: [{ id: 's1' }],
      settingsPresent: true,
      episodeOutlines: [episode('ep1')],
      ...over,
    });

  it('三条件齐 → true', () => {
    expect(computePipelineStage(readyBase()).writeReadyLikely).toBe(true);
  });

  it('缺任一条件 → false（无场 / 无设定锚 / 无集纲）', () => {
    expect(computePipelineStage(readyBase({ sceneNodes: undefined })).writeReadyLikely).toBe(false);
    expect(computePipelineStage(readyBase({ settingsPresent: false })).writeReadyLikely).toBe(false);
    expect(computePipelineStage(readyBase({ episodeOutlines: undefined })).writeReadyLikely).toBe(false);
  });

  it('多场多集仍 true（计数不设上限——「够不够」归 leader，雷达只报事实）', () => {
    const facts = computePipelineStage(
      readyBase({ sceneNodes: [{ id: 's1' }, { id: 's2' }], episodeOutlines: [episode('ep1'), episode('ep2')] }),
    );
    expect(facts.writeReadyLikely).toBe(true);
  });
});

// ── preferencesSet（走查 GAP-5：note 单独也能表达偏好）──

describe('computePipelineStage：preferencesSet', () => {
  it('任一单轴 → true（四轴逐域独立）', () => {
    for (const prefs of [
      { outline_depth: 'skeleton' as const },
      { arc_timing: 'as_you_go' as const },
      { world_depth: 'shell' as const },
      { character_depth: 'full' as const },
    ]) {
      expect(computePipelineStage(coldInput({ creativePreferences: prefs })).preferencesSet).toBe(true);
    }
  });

  it('note 单独非空白 → true；note 纯空白 → false；空对象 / undefined → false（未问 = 标准档）', () => {
    expect(computePipelineStage(coldInput({ creativePreferences: { note: '节奏慢一点' } })).preferencesSet).toBe(true);
    expect(computePipelineStage(coldInput({ creativePreferences: { note: '   ' } })).preferencesSet).toBe(false);
    expect(computePipelineStage(coldInput({ creativePreferences: {} })).preferencesSet).toBe(false);
    expect(computePipelineStage(coldInput({ creativePreferences: undefined })).preferencesSet).toBe(false);
  });
});

// ── 坏形态宽容（跳过不抛；「存在但坏」由 caller/loader 区分）──

describe('computePipelineStage：坏形态宽容（不抛，归零/归 false）', () => {
  it('各数组字段非数组（caller 传 raw 未 parse 数据）→ 计数 0 不抛', () => {
    const facts = computePipelineStage(
      coldInput({
        assetCards: 'not-an-array' as unknown as readonly unknown[],
        outlinePhases: 42 as unknown as readonly unknown[],
        sceneNodes: { id: 's1' } as unknown as readonly unknown[],
        episodeOutlines: 'garbage' as unknown as readonly EpisodeOutline[],
      }),
    );
    expect(facts.characterCardCount).toBe(0);
    expect(facts.worldEntryCount).toBe(0);
    expect(facts.outlinePhaseCount).toBe(0);
    expect(facts.sceneNodeCount).toBe(0);
    expect(facts.episodeCount).toBe(0);
    // 全站归零 + 无灵感记录 → 冷启动事实如实（数据坏的真态上抛归 loader）。
    expect(facts.coldStart).toBe(true);
  });

  it('growthCurveRaw 坏形态（string / 全坏数组）→ growthCurveCount 0 不抛（findArcCoverageGaps 单源归一）', () => {
    expect(computePipelineStage(coldInput({ growthCurveRaw: 'a string' })).growthCurveCount).toBe(0);
    expect(computePipelineStage(coldInput({ growthCurveRaw: ['garbage', null] })).growthCurveCount).toBe(0);
  });

  it('creativePreferences 非对象（caller 违约传 raw）→ preferencesSet false 不抛', () => {
    expect(
      computePipelineStage(coldInput({ creativePreferences: 'garbage' as unknown as never })).preferencesSet,
    ).toBe(false);
  });

  it('metaName / rawRequirement 非字符串 → 启发式按空处理不抛', () => {
    const facts = computePipelineStage(
      coldInput({ metaName: 42 as unknown as string, rawRequirement: null as unknown as string }),
    );
    expect(facts.hasInspirationRecorded).toBe(false);
  });
});

// ── schema 契约 ──

describe('pipeline-stage schema 契约（输出可被 schema parse）', () => {
  it('混合形态产出全部通过 pipelineStageFactsSchema（输出契约自洽）', () => {
    const facts = computePipelineStage(
      coldInput({
        rawRequirement: '一段真灵感',
        assetCards: [{ id: 'c1', type: 'character', name: '林晚' }],
        worldSetting: { premise: '雾城' },
        outlinePhases: [{ id: 'p1', title: '卷一' }],
        sceneNodes: [{ id: 's1' }],
        growthCurveRaw: [{ character_id: 'c1', start_state: '落魄' }],
        episodeOutlines: [episode('ep1')],
        settingsPresent: true,
        creativePreferences: { note: '骨架先行' },
      }),
    );
    expect(pipelineStageFactsSchema.safeParse(facts).success).toBe(true);
    expect(facts.coldStart).toBe(false);
    expect(facts.writeReadyLikely).toBe(true);
  });

  it('计数负数拒收（契约下界——facts 恒非负）', () => {
    expect(pipelineStageFactsSchema.safeParse({ ...coldInput(), characterCardCount: -1 }).success).toBe(false);
  });
});
