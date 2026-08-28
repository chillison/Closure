import { z } from 'zod';
import {
  selectScenesForEpisode,
  worldPatchInputSchema,
  worldSubjectId,
  type SceneGraph,
  type WorldPatchAxis,
  type WorldPatchInput,
  type WriteWorldStateRequest,
  type WorldSubject,
} from '@orison/shared-contracts';
import { createLlmNode, type GenerateFn, type LlmNodeDeps } from './llm-node';
import { extractJson } from './extract-json';
import type { ReusableAgentNodeContract } from '@orison/shared-contracts';
import type { AgentNode, NodeResult, NodeRunInput, RunSnapshot } from '../contracts/run';
import {
  mergeWorldEvents,
  type AxisExtraction,
  type ExtractedPatch,
  type ExtractedSubject,
  type MergedWorldWrite,
  type PerAxisEvents,
} from './world-state-merge';
import { logger } from '../logger';

// ── Story 6.6 Phase C1：物理轴提取器 + merge 节点（design §3 / §6 / implement.md Phase C）──
//
// 两节点挂 chapter-chain（draft 后）：
// 1. **world-extractor-agent**（LLM，createLlmNode）：读 draft.initial + scene_graph → 单次 generate →
//    从正文提取该轴 patches（subjectId/path/op/value/summary/grounding）→ 产 `world_events.<axis>` artifact
//    （AxisExtraction：storyTime + title + subjects + patches）。
//    范式判据（ADR-3）：提取 = 语义判断（哪些状态变化发生了 + grounding 锚定）归 LLM；axis 强制注入
//    （提取器单轴专注，patch.axis 不信 LLM，parseOutput 机械覆盖）。
// 2. **world-merge-node**（纯代码）：读 `world_events.*`（5 轴：physical/cognitive/emotional/relational/
//    factional）→ mergeWorldEvents 机械组装 → 逐 write 调 writeWorldEvents 落表（source='derived'，writer
//    调 write_world_events builtin）→ 产 `world_state.events` artifact（writes 摘要）。merge = 非语义对账
//    （ADR-3 纯代码机械组装）。
//
// 照 recording-principles（docs/neuro-book-reference/world-engine/recording-principles.md）：
// - 最少支持当前叙事：只提取会被后续读取依赖的状态变化（prompt 指令编码；不穷举细节行动）。
// - 群体 subject：功能相同的龙套用单一 subject（group:cultist-patrol-01），prompt 指令编码。
// - 按需涌现：有 asset_cards 卡的引用卡 id（sourceCardId），无卡的独立 id；首次提取自动建 subject（merge 赋
//   firstSeenStoryTime）。
//
// 物理串行（design §6 / feedback-api-concurrency-no-parallel）：chainRunner 本便顺序驱动（一次只跑一个 LLM
// 节点），5 轴提取器顺序跑，不引入并发。
//
// 稳定 slice.id（Phase B insertWorldSlice per-slice idempotency 要求）：`${episodeId}:${storyTime}`
// （mergeWorldEvents 产）——重提取同 slice.id 替换其 patches 不累积。
//
// expected_downstream_consumers:
// - Story 6.6 Phase C2：认知/情绪/关系/势力 4 轴提取器（复用 createWorldExtractorNode(axis) + 新 yaml）+
//   merge 节点 requiredArtifactKeys 扩多轴。
// - Story 6.6 Phase D：brief-compiler #6 stateAtT（reduce 反哺）+ Reader-Audit world_state_snapshot 基底
//   （读 closure_world_state，非本 artifact）。

// ════════════════════════════════════════════════════════════════════════════
// 提取器 LLM 输出解析（robust，CR-4.1-07 哲学：坏条目丢弃不全丢）
// ════════════════════════════════════════════════════════════════════════════

/** 提取器产的主体 schema（无 firstSeenStoryTime，merge 跨轴收集时赋）。 */
const extractedSubjectSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().optional(),
  sourceCardId: z.string().optional(),
});

/** patch 核心字段 schema（无 axis——axis 由 createWorldExtractorNode 按轴强制注入）。 */
const extractedPatchCoreSchema = worldPatchInputSchema.omit({ axis: true });

/** 提取器 LLM 输出根 schema（storyTime + title + subjects[] + patches[]）。 */
const extractionRootSchema = z.object({
  storyTime: z.number().int(),
  title: z.string().min(1),
  subjects: z.array(z.unknown()).default([]),
  patches: z.array(z.unknown()).default([]),
});

/** 单轴最多提取 patches 数（程序兜底，防 misbehaving 提取器灌超量 patch 拖累 merge + 写表）。 */
const MAX_PATCHES_PER_AXIS = 100;
/** 单轴最多登记 subjects 数（程序兜底）。 */
const MAX_SUBJECTS_PER_AXIS = 50;

/**
 * 解析提取器 LLM 输出为 AxisExtraction（robust：root parse 失败抛→触发 createLlmNode 重试；
 * patches/subjects 逐条 safeParse 丢坏条目保留好条目）。
 *
 * @param content LLM 返回的原始 content（可能带 ```json 围栏 / 前导文字）。
 * @param axis    本提取器轴（强制注入每条 patch.axis，不信 LLM 标注）。
 * @throws root JSON.parse / shape 校验失败（触发 createLlmNode 重试→兜底 error artifact）。
 * @returns    AxisExtraction（subjects/patches 已 safeParse + cap；全坏条目 → 空数组，非抛）。
 */
export function parseAxisExtraction(content: string, axis: WorldPatchAxis): AxisExtraction {
  const root = extractionRootSchema.parse(JSON.parse(extractJson(content)));

  // 逐条 safeParse subjects（坏条目单独丢，好条目保留——mirror CR-4.1-07 哲学）。
  const subjects: ExtractedSubject[] = [];
  for (const raw of root.subjects) {
    if (subjects.length >= MAX_SUBJECTS_PER_AXIS) break;
    const parsed = extractedSubjectSchema.safeParse(raw);
    if (parsed.success) subjects.push(parsed.data);
  }

  // 逐条 safeParse patches（axis 强制注入；grounding 透传保留——审计用，写表时 merge 剥离）。
  const patches: ExtractedPatch[] = [];
  for (const raw of root.patches) {
    if (patches.length >= MAX_PATCHES_PER_AXIS) break;
    const parsed = extractedPatchCoreSchema.safeParse(raw);
    if (!parsed.success) continue;
    const patch: ExtractedPatch = { ...parsed.data, axis };
    // grounding 透传（非 WorldPatchInput 字段；保留在 artifact 内供审计，merge 写表时剥离）。
    if (raw && typeof raw === 'object' && 'grounding' in raw) {
      const g = (raw as { grounding?: unknown }).grounding;
      if (typeof g === 'string') patch.grounding = g;
    }
    patches.push(patch);
  }

  // dogfood R2 #91：subject ID 单源规范化（五提取器共用本 parse 点）。LLM 产 id 形态不一（裸 slug /
  // `type:` 前缀 / 连字符差异——实证同角色三形态并存）→ 统一收敛 canonical `<type>:<slug>`
  // （worldSubjectId 单源）。有卡主体 id = sourceCardId 原样（对齐目标轨契约，优先于 LLM 产 id）。
  // patch.subjectId 同步改写（本轴 subjects 表内精确映射）；表外 subjectId 留 shell 写入门
  // resolveWorldSubjectIdentity 兜底归一（belt——跨轴连字符变体等此处不可判）。
  const idMap = new Map<string, string>();
  for (const subject of subjects) {
    idMap.set(subject.id, subject.sourceCardId || worldSubjectId(subject.type, subject.id));
  }
  for (const patch of patches) {
    const mapped = idMap.get(patch.subjectId);
    if (mapped !== undefined) patch.subjectId = mapped;
  }
  // 规范化后同轴撞 id（`shen-yan` + `shenyan` 双登记同收敛一 id）→ 合并登记（name/sourceCardId
  // COALESCE 首非空，mirror merge buildSubjects 哲学），避免 artifact 内重复登记。
  const deduped = new Map<string, ExtractedSubject>();
  for (const subject of subjects) {
    const canonical = idMap.get(subject.id) ?? subject.id;
    const existing = deduped.get(canonical);
    if (existing) {
      if (!existing.name && subject.name) existing.name = subject.name;
      if (!existing.sourceCardId && subject.sourceCardId) existing.sourceCardId = subject.sourceCardId;
    } else {
      deduped.set(canonical, { ...subject, id: canonical });
    }
  }
  subjects.length = 0;
  subjects.push(...deduped.values());

  return {
    storyTime: root.storyTime,
    title: root.title,
    patches,
    subjects,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// world-extractor-agent 节点（LLM，createLlmNode 工厂）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 构造提取器节点契约（per-axis；C1 physical）。
 *
 * - requiredArtifactKeys：draft.initial（提取正文）+ scene_graph（storyTime/场上下文）。chapter_brief_input
 *   用于解析 episodeId（slice.id 前缀），但链段总装配它，非 required 不阻塞（task spec required 集）。
 * - producedArtifactKeys：`world_events.<axis>`（AxisExtraction artifact，merge 节点读）。
 */
function extractorContract(axis: WorldPatchAxis): ReusableAgentNodeContract {
  return {
    nodeId: `world-extractor-${axis}`,
    displayName: `World Extractor (${axis}) Node`,
    inputSchemaName: 'worldExtractorInput',
    outputSchemaName: 'axisExtraction',
    requiredArtifactKeys: ['draft.initial', 'scene_graph'],
    producedArtifactKeys: [`world_events.${axis}`],
    sideEffects: ['call_model'],
  };
}

/**
 * 从 chapter_brief_input artifact 解析 episodeId（mirror chapter-nodes resolveEpisodeId）。
 * 链段装配总产 chapter_brief_input 含 episodeId；缺省 → undefined（CR-2：merge 跳过写，不退 'unknown' 前缀）。
 */
function resolveEpisodeId(chapterBriefInput: unknown): string | undefined {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return undefined;
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return undefined;
}

/**
 * 从 scene_graph 本章场取首个 storyTime 数值（CR-E3 failed-extraction 兜底用）。
 *
 * 提取器失败时无 LLM 输出 storyTime，故从 scene_graph 推本章代表 storyTime 作占位（失败 artifact 的 patches/
 * subjects 均空，storyTime 仅占位——CR-E8 跳空组使该值不进 timeline）。scene_graph 缺/场无 storyTime → undefined
 * （caller 退 0）。
 */
function resolveSceneStoryTime(
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
): number | undefined {
  const scenes = selectScenesForEpisode(sceneGraph, episodeId);
  for (const s of scenes) {
    if (typeof s.storyTime === 'number') return s.storyTime;
  }
  return undefined;
}

/** 安全取 artifact record（过滤非对象/数组）。 */
function artifactAsRecord(run: RunSnapshot, key: string): Record<string, unknown> | undefined {
  const raw = run.artifacts[key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function scalarOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * 构造 storyTime 提示串（from scene_graph 本章场的 storyTimeLabel/storyTime）。
 *
 * 提取器 prompt 用 `{{storyTime}}` 注入本章场的故事时间线索，供 LLM 判断 patches 所属 storyTime。
 * 优先 storyTimeLabel（语义标签如「day 3 dusk」）；缺省退 storyTime 数值；全缺 → 占位提示。
 */
function buildStoryTimeHint(sceneGraph: SceneGraph | undefined, episodeId: string | undefined): string {
  const scenes = selectScenesForEpisode(sceneGraph, episodeId);
  if (scenes.length === 0) return '（scene_graph 未提供本章场的故事时间线索）';
  const labels = scenes.map((s) => s.storyTimeLabel).filter((l): l is string => typeof l === 'string' && l.length > 0);
  if (labels.length > 0) return labels.join(' / ');
  const times = scenes
    .map((s) => s.storyTime)
    .filter((t): t is number => typeof t === 'number');
  return times.length > 0 ? `storyTime ${times.join(', ')}` : '（scene_graph 未提供故事时间线索）';
}

/**
 * 构造一个轴的提取器节点（createLlmNode 工厂实例化 + CR-E3 失败 graceful 包一层）。
 *
 * - buildPrompt：抽 draftText/sceneGraph/episodeId/storyTime 四 var（对齐 prompts/event-extractor-<axis>.yaml
 *   的 {{draftText}}/{{sceneGraph}}/{{episodeId}}/{{storyTime}}）。
 * - parseOutput：parseAxisExtraction（robust：root 失败抛→重试；条目逐个 safeParse 丢坏保留好）→
 *   `world_events.<axis>` artifact（AxisExtraction）。
 * - **CR-E3**：createLlmNode 兜底产 error artifact（初试+重试均失败）时，wrapper 不透传 error artifact——
 *   改产空 AxisExtraction（patches/subjects 均空 + 占位 storyTime）。world-state 是**增强非硬约束**，单轴失败
 *   只跳过该轴（merge 跳空组，CR-E8），不破坏 chapter 审查/接受（避 chainRunner isErrorArtifact→break 孤立草率）。
 *   **不改 createLlmNode 通用 fallback**（其他 LLM 节点 draft-writer/review/route 失败仍走 error artifact，
 *   那些是硬约束节点；只 world-extractor override——world-state 增强性质特殊）。AbortError 仍传播（取消语义）。
 *
 * @param axis 本节点提取的轴（physical/cognitive/emotional/relational/factional）。axis 强制注入每条 patch（不信 LLM 标注）。
 * @param deps LLM deps（generate/modelRef/signal，createLlmNode 用）。
 */
export function createWorldExtractorNode(axis: WorldPatchAxis, deps: LlmNodeDeps): AgentNode {
  const innerNode = createLlmNode(
    {
      nodeId: `world-extractor-${axis}`,
      role: `event-extractor-${axis}`,
      contract: extractorContract(axis),
      buildPrompt: (run: RunSnapshot) => {
        const draft = artifactAsRecord(run, 'draft.initial');
        const sceneGraph = run.artifacts['scene_graph'] as SceneGraph | undefined;
        const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
        return {
          draftText: scalarOf(draft?.text),
          sceneGraph: JSON.stringify(selectScenesForEpisode(sceneGraph, episodeId)),
          episodeId: episodeId ?? '（未提供）',
          storyTime: buildStoryTimeHint(sceneGraph, episodeId),
        };
      },
      parseOutput: (content: string) => {
        const extraction = parseAxisExtraction(content, axis);
        return { stateKey: `world_events.${axis}`, artifact: extraction };
      },
    },
    deps,
  );

  // CR-E3：包一层 run——innerNode 返 error artifact 时转空 AxisExtraction（world-state 增强非硬约束，
  // 单轴失败 graceful 跳过，不破 chapter chain）。
  return {
    contract: innerNode.contract,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const result = await innerNode.run(input);
      if (
        result.artifact &&
        typeof result.artifact === 'object' &&
        (result.artifact as { error?: boolean }).error === true
      ) {
        logger.warn(
          { axis, nodeId: `world-extractor-${axis}` },
          'world-extractor: LLM failed after retries → graceful empty AxisExtraction (axis skipped, chapter chain continues)',
        );
        const sceneGraph = input.run.artifacts['scene_graph'] as SceneGraph | undefined;
        const episodeId = resolveEpisodeId(input.run.artifacts['chapter_brief_input']);
        // 占位 storyTime（patches/subjects 空 → CR-E8 跳组，该值不进 timeline；仅满足 AxisExtraction 类型）。
        const storyTime = resolveSceneStoryTime(sceneGraph, episodeId) ?? 0;
        const emptyExtraction: AxisExtraction = {
          storyTime,
          title: `${axis}-extraction-failed`,
          patches: [],
          subjects: [],
        };
        return { stateKey: `world_events.${axis}`, artifact: emptyExtraction };
      }
      return result;
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// world-merge-node 节点（纯代码：merge + 写表）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 世界状态写入器（DI'd；调用方注入——生产环境调 write_world_events builtin 工具，测试注入 mock）。
 *
 * 接受 WriteWorldStateRequest（slice + patches + subjects），返 void/Promise<void>。
 * source 由 handler 强制（write_world_events='derived'），故请求内 patches 不带 source。
 */
export type WorldWriter = (req: WriteWorldStateRequest) => Promise<void> | void;

/** world-merge-node deps（writer DI + abort signal）。 */
export interface WorldMergeNodeDeps {
  /**
   * 可选写入器。缺省 → merge 节点只产 artifact 不落表（graceful，测试用 / 工具未注册时）。
   * 生产环境由 chapter-chain.ts 装配处注入（调 write_world_events builtin）。
   */
  writeWorldEvents?: WorldWriter;
}

/** world-merge-node 产出 artifact（writes 摘要 + 落表结果）。 */
export interface WorldStateEventsArtifact {
  /** 本链段提取 + merge 后的写入集合（sliceId/storyTime/patch 数/subject 数）。 */
  writes: Array<{
    sliceId: string;
    storyTime: number;
    title: string;
    patchCount: number;
    subjectCount: number;
  }>;
  /** 总 patches 数（跨 writes）。 */
  totalPatches: number;
  /** 总 subjects 数（跨 writes）。 */
  totalSubjects: number;
  /** 写入失败的 sliceId + 错误信息（writer 抛错时记；链段不崩，继续下一 write）。 */
  writeErrors: Array<{ sliceId: string; error: string }>;
}

const WORLD_MERGE_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'world-merge-node',
  displayName: 'World State Merge Node',
  inputSchemaName: 'perAxisEvents',
  outputSchemaName: 'worldStateEvents',
  // Story 6.6 Phase C2：5 轴全 required（physical/cognitive/emotional/relational/factional）。
  // 5 轴提取器须全跑完才 merge（机械组装 5 轴 events）。单轴缺失 → merge blocked（缺轴 events 非正常态，
  // 5 轴提取器都挂链段，正常都会产 artifact；只在提取器全失败时 blocked，graceful 由 createLlmNode 兜底
  // error artifact 触发——此时 requiredArtifactKeys 检查在 error artifact 上走 createLlmNode 既定路径）。
  requiredArtifactKeys: [
    'world_events.physical',
    'world_events.cognitive',
    'world_events.emotional',
    'world_events.relational',
    'world_events.factional',
  ],
  producedArtifactKeys: ['world_state.events'],
  // 写 closure_world_state 派生表（DB 副作用）；'persist_artifact' 是枚举内最接近的（无 'write_db' 项）。
  sideEffects: ['persist_artifact'],
};

/**
 * 构造 merge 节点（纯代码：merge + 写表）。
 *
 * run 流程：
 *  1. 读 `world_events.*` artifacts（C1 仅 physical；C2 扩）→ PerAxisEvents。
 *  2. resolve episodeId（slice.id 前缀；缺省 'unknown'）。
 *  3. mergeWorldEvents(perAxis, episodeId) → MergedWorldWrite[]（机械组装：storyTime 窗对齐 + 跨轴引用链接 +
 *     subjects 收集；**非语义对账**）。
 *  4. 逐 write：若 writeWorldEvents 注入 → 调它落表（try/catch 单 write 失败不崩链，记 writeErrors 续跑）；
 *     未注入 → skip 落表（graceful，测试用）。
 *  5. 产 `world_state.events` artifact（writes 摘要 + totalPatches/Subjects + writeErrors）。
 *
 * 范式判据（ADR-3）：merge = 纯代码机械组装（非语义）；写表 = 副作用（writer DI'd）。
 * 不判「这条 patch 该不该写」「merge 对不对」（归提取器 LLM + Reader-Audit）。
 *
 * @param deps writer DI（缺省 → 不落表，只产 artifact）。
 */
export function createWorldMergeNode(deps: WorldMergeNodeDeps): AgentNode {
  const { writeWorldEvents } = deps;
  return {
    contract: WORLD_MERGE_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;

      // Story 6.6 Phase C2：5 轴全读（physical/cognitive/emotional/relational/factional）。各轴 optional——
      // createLlmNode 兜底 error artifact 时该轴 artifact 形态非 AxisExtraction，merge 跳过（undefined）；
      // 正常态 5 轴提取器都产 AxisExtraction。PerAxisEvents 缺省轴 → mergeWorldEvents 跳过该轴。
      const perAxis: PerAxisEvents = {
        physical: run.artifacts['world_events.physical'] as AxisExtraction | undefined,
        cognitive: run.artifacts['world_events.cognitive'] as AxisExtraction | undefined,
        emotional: run.artifacts['world_events.emotional'] as AxisExtraction | undefined,
        relational: run.artifacts['world_events.relational'] as AxisExtraction | undefined,
        factional: run.artifacts['world_events.factional'] as AxisExtraction | undefined,
      };
      const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
      // CR-2：episodeId 缺省 → mergeWorldEvents 返 []（避 'unknown:storyTime' 跨章节 slice.id 撞 → 误替换
      // 他章 patches）。空 writes 不调 writer（graceful）+ warning 日志告知。chapter_brief_input 是链段总装配件，
      // 缺它非正常态（chain 装配 bug 或 brief-compiler 未产 episodeId）——记日志便于排查，链段不崩。
      if (!episodeId) {
        logger.warn(
          'world-merge-node: chapter_brief_input.episodeId missing → skip world-state writes (avoid cross-chapter slice.id collision)',
        );
      }
      const writes = mergeWorldEvents(perAxis, episodeId ?? '');

      const artifact: WorldStateEventsArtifact = {
        writes: [],
        totalPatches: 0,
        totalSubjects: 0,
        writeErrors: [],
      };

      for (const write of writes) {
        const patchCount = write.patches.length;
        const subjectCount = write.subjects.length;
        artifact.writes.push({
          sliceId: write.sliceId,
          storyTime: write.storyTime,
          title: write.title,
          patchCount,
          subjectCount,
        });
        artifact.totalPatches += patchCount;
        artifact.totalSubjects += subjectCount;

        // 写表（writer 未注入 → skip，测试/graceful 用）。
        if (writeWorldEvents) {
          try {
            await writeWorldEvents(toWriteRequest(write));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
              { sliceId: write.sliceId, err: msg },
              'world-merge-node: write_world_events failed for slice (continuing)',
            );
            artifact.writeErrors.push({ sliceId: write.sliceId, error: msg });
          }
        }
      }

      return { stateKey: 'world_state.events', artifact };
    },
  };
}

/** MergedWorldWrite → WriteWorldStateRequest（worldSliceInputSchema 形态：无 projectId，handler 解析注入）。 */
function toWriteRequest(write: MergedWorldWrite): WriteWorldStateRequest {
  const slice: WriteWorldStateRequest['slice'] = {
    id: write.sliceId,
    // Story 8.1：episode 归属显式落列（免 slice.id 前缀解析 magic string，design §4）。
    episodeId: write.episodeId,
    storyTime: write.storyTime,
    title: write.title,
  };
  if (write.kind !== undefined) slice.kind = write.kind;
  if (write.summary !== undefined) slice.summary = write.summary;
  return {
    slice,
    patches: write.patches,
    subjects: write.subjects as WorldSubject[],
  };
}
