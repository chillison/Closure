import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import {
  buildWorldStateSnapshot,
  creativeFieldKeys,
  formatImpactTypeVocab,
  parseRippleImpacts,
  sceneGraphSchema,
  scenesByAssetRef,
  scenesByLine,
  linesByAssetRef,
  type CreativeFieldKey,
  type RippleImpactFinding,
  type RippleImpactResult,
  type SceneGraph,
  type WorldStateSnapshot,
} from '@orison/shared-contracts';
import { defineTool } from './define';
import { logger } from '../logger';
import type { SkillExecutorRef } from '../types';
import type { ToolContext } from '../types';
import { fetchWorldPatchesViaTool } from '../nodes/world-state-query';

// ── Story 3.4 Phase 2：涟漪语义诊断 leader tool（design §2.2-§2.3 / implement.md 2.1-2.4）──
//
// 作者改一处创作数据 → producer 侧 BFS 标下游 stale → leader 调本 tool 诊断实际影响。
// tool = 编排层（mirror write_chapter）：L1 纯代码候选缩小 + world-state 取数 → L2 LLM 语义裁判
// （dispatch ripple-diagnosis-agent 子 agent）→ 返回 ripple-impact findings 给 leader 呈现/导演。
//
// 🔑 范式判据（ADR-3 / creative-vs-mechanical.md §Story 3.4）：
// - L1 候选缩小（stale 读 + reverse-ref + world-state snapshot 取数）= 纯代码（本文件内）。
// - 「实际受影响 + 影响类型」= LLM 语义（ripple-diagnosis-agent yaml 子 agent，经 runAgentWithExplicitSystem）。
// - finding = LLM 产；parse/汇编/降级 = 纯代码。
//
// 🔑 不进 CONTRACTS[]（leader 侧子 agent + tool，mirror write_chapter / retrieval / adjudicator）。
// spawn depth：leader→ripple-diagnosis-agent（depth+1）兄弟于 leader→chain（depth+1），非嵌套。
//
// 工具限制（硬约束，spec agent-tools.md / orchestration-pattern.md §leader 侧工具子 agent）：
// allowedTools=['query_world_state']——L2 可查 world state 辅助判断（mirror revision-optimizer
// allowedTools=['query_story']），无写工具（无副作用风险）。
//
// graceful（mirror completeness-verify-node + adjudicator D5）：
// - 无 stale 字段 → 友善告知「所有字段均为最新」，不跑 L1/L2。
// - 无候选场（reverse-ref 空 / scene_graph 空）→ 告知「无可诊断候选」。
// - 无 world state events（旧章未 backfill）→ degraded findings（AC6 永不假 pass，非静默跳过）。
// - L2 dispatch 失败 / parse 失败 → findings=[] + degraded=true + summary 标失败。
// - skillExecutor 缺（旧 runtime / mock）→ graceful 告知 leader。
//
// expected_downstream_consumers:
// - Story 3.4 Phase 3：loadRippleImpactsForLeader 读 metadata.findings → leader prompt 注入。
// - Story 3.7 InsightCard：metadata.findings = InsightCard 数据源。

const BOM_CHAR_CODE = 0xfeff;

// ── stale 字段描述（L2 changeDiff var 用，帮 LLM 理解各字段代表什么数据）──
const FIELD_DESCRIPTIONS: Record<string, string> = {
  creative_brief: '创作概要（题材/主题/基调/结构 pattern/禁忌/约束）',
  world_setting: '世界设定（前提/时代/世界宪法/基调规则/开放问题）',
  outline: '大纲（主线/核心冲突/重大转折点/结局方向）',
  episode_outlines: '集纲（分集大纲/伏笔登记/分弧结构）',
  growth_curve: '角色成长弧（伤口/欲望/需要/转折点/终点状态）',
  pacing_curve: '节奏曲线（张弛节奏设计）',
  emotion_curve: '情绪目标弧（per-scene 目标情绪/情绪动态/VAD）',
  asset_cards: '设定卡片（角色/地点/道具/组织/规则/视觉母题/传说/金手指）',
  relationship_graph: '关系图（角色间关系节点+边/关系类型/可见性）',
  promise_registry: 'Promise 登记簿（伏笔 plant/payoff/承诺/兑现态）',
  info_release_map: '信息释放图（透露/隐瞒策略/信息操控指令）',
  scene_graph: '场景图（场节点/边/线/结构角色/时间戳）',
};

// 可经 reverse-ref 缩小的 stale 字段（design §2.2）：
// asset_cards 改动 → scenesByAssetRef + linesByAssetRef(+scenesByLine) 缩小到涉及该卡的场。
// 其他字段（world_setting/outline/relationship_graph/...）→ 缩不到具体场，全图场为候选（D2 trade-off，
// 诚实归 LLM）。
// BMad CR Fix 5（E9 NARROWABLE）：删 relationship_graph——无关系反查原语（scenesByAssetRef/linesByAssetRef
// 经 scene.assetRefs / Line.thread_ref，皆 asset_card id 空间；relationship_graph 节点未接入 reverse-ref），
// 保留是浪费 L2 narrowed=true（narrowed 分支跑但无缩小效果，assetCardIds 空 → 零候选 → 假「无可诊断」）。
const NARROWABLE_STALE_FIELDS = new Set<CreativeFieldKey>(['asset_cards']);

/** 单候选场诊断报告（喂 L2 prompt 的 candidateScenes var 元素）。 */
interface CandidateSceneReport {
  sceneId: string;
  episodeId?: string;
  storyTime: number;
  storyTimeLabel?: string;
  role?: string;
  outcomeType?: string;
  pacingRole?: string;
  lineTags: string[];
  assetRefs: string[];
  /** 截至本场 storyTime 的 world state 累积状态（JSON 串）；无数据 = '无'。 */
  worldStateSummary: string;
  /** true = 该场无 world state events（snapshot 空），L2 应产 no-events finding。 */
  degraded: boolean;
}

/** 单候选线诊断报告（喂 L2 prompt）。 */
interface CandidateLineReport {
  lineId: string;
  name?: string;
  topology_role?: string;
  thread_ref?: string;
  mice_type?: string;
}

/** L1 候选缩小 + world-state 取数结果。 */
interface L1CandidateResult {
  scenes: CandidateSceneReport[];
  lines: CandidateLineReport[];
  /** true = 缩小到子集（仅 narrowable stale）；false = 全图候选（含非 narrowable stale）。 */
  narrowed: boolean;
  /** true = 项目无 world state events（fetchWorldPatchesViaTool 返空/undefined）。 */
  noWorldState: boolean;
  /** true = 项目有旧章正文但无 world state（backfill 需求信号，2.4）。 */
  backfillNeeded: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// project.yaml 读取（mirror write-chapter.ts loadChainProjectInput）
// ════════════════════════════════════════════════════════════════════════════

/** diagnose_impacts 需的 project.yaml 子集。 */
interface DiagnoseProjectInput {
  fieldMetadata: Record<string, { stale?: unknown } | undefined>;
  sceneGraph: SceneGraph | undefined;
  /** asset_card id 集合（raw array，仅取 id 字段做 reverse-ref seed）。 */
  assetCardIds: string[];
  /** novel.chapters（判断是否有旧章正文，backfill precheck 用）。 */
  hasChapters: boolean;
}

/**
 * 读 project.yaml 并解析为 diagnose_impacts 所需字段（agent 直读，mirror write_chapter）。
 *
 * 防御（mirror write-chapter.ts loadChainProjectInput）：BOM-strip + malformed yaml → null。
 * scene_graph safeParse 降级 undefined（graceful，非崩）。
 */
async function loadDiagnoseProjectInput(projectPath: string): Promise<DiagnoseProjectInput | null> {
  const filePath = path.join(projectPath, 'project.yaml');
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), projectPath }, 'diagnose_impacts: project.yaml unreadable');
    return null;
  }

  const bomStripped = raw.charCodeAt(0) === BOM_CHAR_CODE ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = yaml.load(bomStripped);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), projectPath }, 'diagnose_impacts: project.yaml malformed yaml');
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;

  // field_metadata：读 stale 标记（候选源）。非 object → 空 map。
  const fmRaw = obj.field_metadata;
  const fieldMetadata: Record<string, { stale?: unknown } | undefined> =
    fmRaw && typeof fmRaw === 'object' && !Array.isArray(fmRaw)
      ? (fmRaw as Record<string, Record<string, unknown>>)
      : {};

  // scene_graph：safeParse 降级 undefined（mirror write_chapter 透传 assemble 内 safeParse 哲学，
  // 但本 tool 无 assemble——直接 safeParse 拿 typed SceneGraph 供 reverse-ref 用）。
  let sceneGraph: SceneGraph | undefined;
  if (obj.scene_graph && typeof obj.scene_graph === 'object') {
    const sgResult = sceneGraphSchema.safeParse(obj.scene_graph);
    if (sgResult.success) {
      sceneGraph = sgResult.data;
    } else {
      logger.warn(
        { err: sgResult.error.message, projectPath },
        'diagnose_impacts: scene_graph safeParse failed → treat as empty graph',
      );
    }
  }

  // asset_card ids：reverse-ref seed。只取 id 字段（mirror WorldSubject.sourceCardId 同 id 空间）。
  const assetCardIds: string[] = [];
  if (Array.isArray(obj.asset_cards)) {
    for (const card of obj.asset_cards) {
      if (card && typeof card === 'object' && !Array.isArray(card)) {
        const c = card as { id?: unknown };
        if (typeof c.id === 'string' && c.id.length > 0) {
          assetCardIds.push(c.id);
        }
      }
    }
  }

  // novel.chapters：backfill precheck（2.4）——判断是否有旧章正文。
  let hasChapters = false;
  if (obj.novel && typeof obj.novel === 'object' && !Array.isArray(obj.novel)) {
    const novel = obj.novel as { chapters?: unknown };
    if (Array.isArray(novel.chapters) && novel.chapters.length > 0) {
      hasChapters = true;
    }
  }

  return { fieldMetadata, sceneGraph, assetCardIds, hasChapters };
}

// ════════════════════════════════════════════════════════════════════════════
// L1 候选缩小 + world-state 取数（纯代码，design §2.2）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 读 stale 字段（mirror listStaleFieldsHandler 逻辑，field_metadata[*].stale===true）。
 *
 * 纯代码磁盘查询（ADR-3）。按 creativeFieldKeys enum 序保序（非 Object.entries 依赖 yaml 写入序）。
 */
function findStaleFields(fieldMetadata: Record<string, { stale?: unknown } | undefined>): CreativeFieldKey[] {
  return creativeFieldKeys.filter((key) => fieldMetadata[key]?.stale === true);
}

/**
 * L1 候选缩小 + world-state 取数（design §2.2 / implement.md 2.1 L1）。
 *
 * 流程：
 *  1. stale 字段含非 narrowable → 全图场候选（D2 trade-off）；仅 narrowable → reverse-ref 缩小。
 *  2. fetchWorldPatchesViaTool 一次取全集 patches（mirror brief-compiler 模式）。
 *  3. 每候选场 buildWorldStateSnapshot(patches, scene.storyTime) → 累积状态。
 *  4. 无 patches（项目无 world state）→ 全场 degraded + backfill precheck。
 *
 * 范式判据（ADR-3）：reverse-ref + snapshot reduce = 纯代码；实际受影响判归 L2。
 */
async function buildCandidateReport(
  staleFields: CreativeFieldKey[],
  input: DiagnoseProjectInput,
  projectPath: string,
): Promise<L1CandidateResult> {
  const { sceneGraph, assetCardIds, hasChapters } = input;

  // 判断缩小 vs 全图（design §2.2 / D2）。
  const hasNonNarrowable = staleFields.some((f) => !NARROWABLE_STALE_FIELDS.has(f));
  const narrowed = !hasNonNarrowable && staleFields.length > 0;

  // 收集候选 scene ids（缩小：reverse-ref；全图：所有 nodes）。
  const candidateSceneIds = new Set<string>();
  const candidateLineIds = new Set<string>();

  if (!sceneGraph) {
    // 无 scene_graph → 无候选场（graceful，caller 据此告知 leader）。
    return { scenes: [], lines: [], narrowed, noWorldState: false, backfillNeeded: false };
  }

  if (narrowed) {
    // 仅 narrowable stale → reverse-ref 缩小（scenesByAssetRef + linesByAssetRef per asset_card id）。
    // BMad CR Fix 5（E9 scenesByLine 零消费）：linesByAssetRef 拿到锚定该 asset 的线后，再经
    // scenesByLine 收集线上所有场（含未直接 ref 该 asset 的场）覆 candidateSceneIds——消漏报
    // （线上场虽未直接 ref 该 asset，但同线结构受 asset 变更影响，应进候选归 L2 判）。
    for (const assetId of assetCardIds) {
      for (const s of scenesByAssetRef(sceneGraph, assetId)) candidateSceneIds.add(s.id);
      for (const l of linesByAssetRef(sceneGraph, assetId)) {
        candidateLineIds.add(l.id);
        for (const sl of scenesByLine(sceneGraph, l.id)) candidateSceneIds.add(sl.id);
      }
    }
  } else {
    // 含非 narrowable stale（world_setting/outline/...）→ 全图候选（D2 trade-off，全压 L2）。
    for (const node of sceneGraph.nodes) candidateSceneIds.add(node.id);
  }

  // 无候选场（assetRefs 全未填 + 仅 narrowable stale → 空集 / scene_graph 无 nodes）。
  if (candidateSceneIds.size === 0 && candidateLineIds.size === 0) {
    return { scenes: [], lines: [], narrowed, noWorldState: false, backfillNeeded: false };
  }

  // world-state 一次取（mirror fetchWorldPatchesViaTool「取一次 reduce N 次」DRY 模式）。
  const patches = await fetchWorldPatchesViaTool(projectPath);
  const noWorldState = !patches || patches.length === 0;

  // backfill precheck（2.4）：无 world state + 有旧章 → 建议补提取。
  // ⚠️ 实际 backfill 执行（跑 extractor）需 generate fn + prose 读取，跨 agent/shell 边界——
  // 本 tool 层无 generate 注入（defineTool execute 不收 generate），故只检测 + 标信号，
  // 执行归 TODO（design §3 / world-state-backfill.ts:35-49 注释已标 Phase 2 接线）。
  const backfillNeeded = noWorldState && hasChapters;

  // 构建候选场报告（per-scene structure + world state snapshot）。
  const scenes: CandidateSceneReport[] = [];
  for (const node of sceneGraph.nodes) {
    if (!candidateSceneIds.has(node.id)) continue;
    const storyTime = typeof node.storyTime === 'number' ? node.storyTime : 0;

    // buildWorldStateSnapshot at storyTime（纯函数 reduce，mirror brief-compiler stateAtT）。
    let worldStateSummary = '无';
    let degraded = false;
    if (!noWorldState && patches) {
      const snapshot: WorldStateSnapshot = buildWorldStateSnapshot(patches, storyTime, { subjectCap: 8 });
      if (snapshot.subjects.length > 0) {
        // 紧凑 JSON：subjectId + 关键属性（mirror brief-compiler stateAtT 紧凑形态）。
        worldStateSummary = JSON.stringify(
          snapshot.subjects.map((s) => ({ subject: s.subjectId, state: s.state, issues: s.issueCount })),
        );
      } else {
        // 该 storyTime 截断点无 populated 状态 → degraded（mirror fetchWorldStateSnapshotViaTool 空→undefined）。
        degraded = true;
      }
    } else {
      // 项目无 world state → 全 degraded。
      degraded = true;
    }

    scenes.push({
      sceneId: node.id,
      ...(node.episodeId ? { episodeId: node.episodeId } : {}),
      storyTime,
      ...(node.storyTimeLabel ? { storyTimeLabel: node.storyTimeLabel } : {}),
      ...(node.role ? { role: node.role } : {}),
      ...(node.outcomeType ? { outcomeType: node.outcomeType } : {}),
      ...(node.pacingRole ? { pacingRole: node.pacingRole } : {}),
      lineTags: node.lineTags,
      assetRefs: node.assetRefs ?? [],
      worldStateSummary,
      degraded,
    });
  }

  // 候选线报告（结构 digest，mirror SceneLineDigest）。
  const lines: CandidateLineReport[] = [];
  if (candidateLineIds.size > 0) {
    for (const line of sceneGraph.lines) {
      if (!candidateLineIds.has(line.id)) continue;
      lines.push({
        lineId: line.id,
        ...(line.name ? { name: line.name } : {}),
        ...(line.topology_role ? { topology_role: line.topology_role } : {}),
        ...(line.thread_ref ? { thread_ref: line.thread_ref } : {}),
        ...(line.mice_type ? { mice_type: line.mice_type } : {}),
      });
    }
  }

  return { scenes, lines, narrowed, noWorldState, backfillNeeded };
}

/** 渲染 staleFields 为 L2 changeDiff var（字段名 + 描述，帮 LLM 理解改动性质）。 */
function renderChangeDiff(staleFields: CreativeFieldKey[]): string {
  return staleFields
    .map((f) => `- ${f}：${FIELD_DESCRIPTIONS[f] ?? '创作数据字段'}`)
    .join('\n');
}

/** 渲染 candidateScenes 为 L2 var（JSON 串）。 */
function renderCandidateScenes(scenes: CandidateSceneReport[], lines: CandidateLineReport[]): string {
  return JSON.stringify({ scenes, lines });
}

// ════════════════════════════════════════════════════════════════════════════
// L2 dispatch（mirror dispatchRevisionOptimizer / dispatchAdjudicator）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 派发 ripple-diagnosis-agent 子 agent + parse findings（design §2.3 / mirror dispatchRevisionOptimizer）。
 *
 * 流程：
 *  1. skillExecutor 缺 → graceful 返 null（不假信心，mirror dispatchRevisionOptimizer）。
 *  2. 派发 ripple-diagnosis-agent（vars：staleFields/changeDiff/candidateScenes/impactTypeVocab；
 *     allowedTools=['query_world_state']——带只读查询辅助判断，无写工具）。
 *  3. parseRippleImpacts（三路径鲁棒；失败返 null）。
 *  4. parse 成功 → 返 RippleImpactResult（caller 呈 leader）。
 *  5. 任何失败 → 返 null（caller graceful 降级 degraded findings）。
 *
 * 🔑 graceful 不假信心（mirror 裁决器 D5 / completeness-verify AC6）：绝不编造 findings——
 * 失败时 caller 产 degraded findings（标「诊断失败需人工」），非假 pass。
 */
export async function dispatchRippleDiagnosis(
  ctx: {
    sessionId: string;
    abort?: AbortSignal;
    spawnDepth?: number;
    /** R2 #3 二段：leader 工具 ctx 的 child 事件通道（可选——直调/测试不带则不透传）。 */
    emitChildEvent?: ToolContext['emitChildEvent'];
    skillExecutor?: Pick<SkillExecutorRef, 'runAgentWithExplicitSystem'>;
  },
  vars: {
    staleFields: string;
    changeDiff: string;
    candidateScenes: string;
  },
): Promise<RippleImpactResult | null> {
  if (!ctx.skillExecutor?.runAgentWithExplicitSystem) {
    logger.warn(
      { sessionId: ctx.sessionId },
      'dispatchRippleDiagnosis: runAgentWithExplicitSystem unavailable → graceful skip (no fabricated findings)',
    );
    return null;
  }

  // vars 加 impactTypeVocab（词表先验注入 prompt，mirror QUERY_CRAFT_DESCRIPTION 词表注入）。
  const fullVars: Record<string, string> = {
    ...vars,
    impactTypeVocab: formatImpactTypeVocab(),
  };

  let content: string;
  try {
    const result = await ctx.skillExecutor.runAgentWithExplicitSystem(
      ctx.sessionId,
      'ripple-diagnosis-agent',
      fullVars,
      {
        ...(ctx.abort ? { abort: ctx.abort } : {}),
        ...(ctx.spawnDepth !== undefined ? { spawnDepth: ctx.spawnDepth } : {}),
        ...(ctx.emitChildEvent ? { emitChildEvent: ctx.emitChildEvent } : {}), // R2 #3 二段：child 事件透传
        allowedTools: ['query_world_state'],
      },
    );
    content = result.content;
  } catch (err) {
    logger.warn(
      { sessionId: ctx.sessionId, err: err instanceof Error ? err.message : String(err) },
      'dispatchRippleDiagnosis: ripple-diagnosis-agent dispatch failed → graceful skip (no fabricated findings)',
    );
    return null;
  }

  const parsed = parseRippleImpacts(content);
  if (!parsed) {
    logger.warn(
      { sessionId: ctx.sessionId },
      'dispatchRippleDiagnosis: parseRippleImpacts failed → graceful skip (no fabricated findings)',
    );
    return null;
  }
  return parsed;
}

// ════════════════════════════════════════════════════════════════════════════
// graceful degraded findings（无 world state / L2 失败时 L1 纯代码产，mirror completeness-verify AC6）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 为 degraded 候选场产 no-events finding（graceful，design §2.3 / AC6 永不假 pass）。
 *
 * 无 world state events 的场无法判实际冲突 → 标 degraded finding 告知作者「需补提取 / 人工核」，
 * **非静默跳过**（守 100% 无误报无漏报的「不漏报」侧）。
 */
function buildDegradedFindings(scenes: CandidateSceneReport[], backfillNeeded: boolean): RippleImpactFinding[] {
  return scenes
    .filter((s) => s.degraded)
    .map((s) => ({
      code: 'no-events',
      severity: 'warning' as const,
      impactType: 'no-events',
      message: `场 ${s.sceneId} 无 world state 实际轨数据，无法诊断实际冲突（${
        backfillNeeded ? '旧章未补提取' : '该 storyTime 前无 events'
      }）。建议补提取后重诊或人工核对。`,
      targets: [{ kind: 'scene' as const, id: s.sceneId }],
      suggestion: backfillNeeded
        ? '项目有旧章但无 world state 数据——先补提取旧章 world state（diagnose_impacts 前置 backfill），再重新诊断。'
        : '该场 storyTime 前无已提取的 world events——人工核对该场是否受改动影响。',
      degraded: true,
    }));
}

// ════════════════════════════════════════════════════════════════════════════
// diagnose_impacts tool（defineTool，mirror writeChapterTool）
// ════════════════════════════════════════════════════════════════════════════

const diagnoseImpactsParams = z.object({});

export const diagnoseImpactsTool = defineTool({
  id: 'diagnose_impacts',
  description:
    '诊断作者改动对下游的实际影响（涟漪语义诊断）。读 stale 字段 → 纯代码缩小候选场 → LLM 裁判「实际受影响 + 影响类型」' +
    '（查 world state 累积状态 + scene 结构，不读正文）。返回 ripple-impact findings（severity/impactType/targets/suggestion）。' +
    '找到了不是替你修了——finding 是诊断结果，作者导演如何传播。无 world state 的场标 degraded（建议补提取）。',
  parameters: diagnoseImpactsParams,
  async execute(_params, ctx) {
    // ── 1. 读 project.yaml（mirror write_chapter loadChainProjectInput）──
    const input = await loadDiagnoseProjectInput(ctx.projectPath);
    if (!input) {
      return {
        title: 'diagnose_impacts',
        output: `无法读取 project.yaml（${ctx.projectPath} 缺失或不可读），无法诊断。`,
      };
    }

    // ── 2. L1a：读 stale 字段（候选源）──
    const staleFields = findStaleFields(input.fieldMetadata);
    if (staleFields.length === 0) {
      return {
        title: 'diagnose_impacts',
        output: '当前无 stale 字段（所有创作字段均为最新），无需涟漪诊断。',
        metadata: { ok: true, findings: [], degraded: false, staleFields: [] },
      };
    }

    // ── 3. L1b：候选缩小 + world-state 取数（纯代码）──
    let candidates = await buildCandidateReport(staleFields, input, ctx.projectPath);

    // 无候选场（scene_graph 空 / reverse-ref 空集）→ 告知 leader。
    if (candidates.scenes.length === 0 && candidates.lines.length === 0) {
      return {
        title: 'diagnose_impacts',
        output:
          `stale 字段（${staleFields.join(', ')}）无可缩小的候选场` +
          (candidates.narrowed
            ? '（仅设定类 stale 但 scene.assetRefs 未填——填 assetRefs 后可缩小诊断）'
            : '（scene_graph 为空）') +
          '。',
        metadata: { ok: true, findings: [], degraded: false, staleFields },
      };
    }

    // ── 3.5 backfill 执行（3.4 收尾 / design §3「诊断前置检查：若无 world state 则触发 backfill」）──
    // 无 world state + 有旧章 → ctx.skillExecutor.runBackfill 触发补提取 → 成功后重新 buildCandidateReport
    // （现在有 world state 数据，候选场不再全 degraded）→ 继续 L2。守 feedback-api-concurrency-no-parallel
    // （backfill 内部已串行）。hasAnyWorldState 门控只在无 world state 时触发（backfillNeeded = noWorldState
    // && hasChapters），故只调一次。
    let backfillExecuted = false;
    if (candidates.backfillNeeded && ctx.skillExecutor?.runBackfill) {
      logger.info(
        { projectPath: ctx.projectPath, staleFields },
        'diagnose_impacts: project has chapters but no world state → triggering runBackfill before L2',
      );
      try {
        const backfillResult = await ctx.skillExecutor.runBackfill(
          ctx.sessionId,
          ctx.abort ? { abort: ctx.abort } : undefined,
        );
        // BMad CR Fix 1（E1 静默假成功）：成功判定从只看 `ok` 收紧为 `ok && !degraded && !reason`。
        // runBackfill 现在在 writeErrors / cap 截断 / 无落表 时返 degraded/reason（即便 ok:true）。
        // degraded/reason/!ok 均表示 backfill 未全生效 → **不报成功**，走 degrade 路径（告知作者
        // backfill 部分失败/未生效，候选场仍 degraded）。fresh 读 success 文案只在真成功时输出。
        const backfillSucceeded = backfillResult.ok && !backfillResult.degraded && !backfillResult.reason;
        if (backfillSucceeded) {
          backfillExecuted = true;
          // backfill 成功 → 重新跑 buildCandidateReport（重取 world patches，现在有数据了）。
          candidates = await buildCandidateReport(staleFields, input, ctx.projectPath);
          logger.info(
            {
              projectPath: ctx.projectPath,
              episodesWritten: backfillResult.episodesWritten,
              totalPatches: backfillResult.totalPatches,
            },
            'diagnose_impacts: backfill succeeded → re-ran buildCandidateReport with fresh world state',
          );
        } else {
          logger.warn(
            {
              projectPath: ctx.projectPath,
              ok: backfillResult.ok,
              degraded: backfillResult.degraded,
              reason: backfillResult.reason,
            },
            'diagnose_impacts: backfill did not fully succeed (degraded/reason/!ok) → keeping degrade path',
          );
        }
      } catch (err) {
        logger.warn(
          { projectPath: ctx.projectPath, err: err instanceof Error ? err.message : String(err) },
          'diagnose_impacts: runBackfill threw → keeping degrade path (degraded findings)',
        );
      }
    }

    // ── 4. L2：派发 ripple-diagnosis-agent（语义裁判）──
    const result = await dispatchRippleDiagnosis(
      ctx,
      {
        staleFields: staleFields.join(', '),
        changeDiff: renderChangeDiff(staleFields),
        candidateScenes: renderCandidateScenes(candidates.scenes, candidates.lines),
      },
    );

    // ── 5. 结果汇总 + graceful fallback（mirror completeness-verify-node AC6）──
    let findings: RippleImpactFinding[];
    let summary: string;
    let degraded: boolean;
    let degradationNote: string | undefined;

    if (result) {
      // L2 成功 → 用 L2 findings + 补 L1 degraded（no-events 场若 L2 漏标，L1 补）。
      // L2 已按 prompt 产 no-events finding for degraded scenes；但若 L2 漏标，L1 补齐（守不漏报）。
      findings = result.findings;
      summary = result.summary;
      degraded = result.degraded;
      degradationNote = result.degradationNote;

      // L1 补漏：degraded 场无对应 no-events finding → 补（mirror revision-guard filterValidFindings 补漏哲学）。
      const l2DegradedSceneIds = new Set(
        findings
          .filter((f) => f.code === 'no-events')
          .flatMap((f) => f.targets.filter((t) => t.kind === 'scene').map((t) => t.id)),
      );
      const l1Degraded = buildDegradedFindings(candidates.scenes, candidates.backfillNeeded);
      for (const f of l1Degraded) {
        if (!l2DegradedSceneIds.has(f.targets[0].id)) {
          findings.push(f);
          degraded = true;
        }
      }
    } else {
      // L2 失败（dispatch/parse 失败 / skillExecutor 缺）→ L1 纯代码产 degraded findings（AC6 永不假 pass）。
      findings = buildDegradedFindings(candidates.scenes, candidates.backfillNeeded);
      summary = candidates.backfillNeeded
        ? '涟漪诊断未能完成（L2 不可用 / 失败），且项目无 world state 数据——所有候选场标 degraded。建议补提取 world state 后重诊。'
        : '涟漪诊断未能完成（L2 不可用 / 失败）——候选场标 degraded，建议人工核对或重试。';
      degraded = true;
      degradationNote = 'L2 ripple-diagnosis-agent dispatch/parse failed → L1 degraded fallback (AC6)';
    }

    // backfill 信号进 summary（2.4 告知作者）。
    if (candidates.backfillNeeded && !degradationNote?.includes('backfill')) {
      degradationNote = (degradationNote ?? '') + ' 项目有旧章但无 world state 数据（backfill needed）。';
    }

    // ── 6. 呈 leader（output 文字 + metadata findings）──
    // top-N 不截断（呈现层 Phase 3 loadRippleImpactsForLeader 截断；tool 层全给）。
    const errorCount = findings.filter((f) => f.severity === 'error').length;
    const warnCount = findings.filter((f) => f.severity === 'warning').length;
    const degradedCount = findings.filter((f) => f.degraded).length;
    const outputLines = [
      `涟漪诊断完成：${staleFields.length} 个 stale 字段 → ${candidates.scenes.length} 候选场 → ${findings.length} findings`,
      `（${errorCount} error / ${warnCount} warning${degradedCount > 0 ? ` / ${degradedCount} degraded` : ''}）。`,
      summary,
    ];
    if (candidates.backfillNeeded) {
      outputLines.push('⚠️ 项目有旧章但无 world state 数据——建议先补提取（backfill）以启用完整诊断。');
    } else if (backfillExecuted) {
      outputLines.push('✓ 已自动补提取旧章 world state 数据——诊断基于完整实际轨数据。');
    }

    return {
      title: 'diagnose_impacts',
      output: outputLines.join('\n'),
      metadata: { ok: true, findings, summary, degraded, staleFields, ...(degradationNote ? { degradationNote } : {}) },
    };
  },
});
