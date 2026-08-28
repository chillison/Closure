import {
  arcBeatSchema,
  arcLedgerActionSchema,
  normalizeArcBeat,
  type ArcBeat,
  type ArcLedgerAction,
  type ReusableAgentNodeContract,
  type SceneGraph,
} from '@orison/shared-contracts';
import type { AgentNode, NodeResult, NodeRunInput, RunSnapshot } from '../contracts/run';
import { createLlmNode, type LlmNodeDeps } from './llm-node';
import { extractJson } from './extract-json';
import { registry } from '../tool/registry';
import { logger } from '../logger';

// ── Story 8.2 写时弧节拍登记节点（design §2 / §3 / ADR-3，mirror promise-emergence-node 结构）──
//
// 挂 chapter-chain 的 `promise-emergence-node` 后、`chapter-summary-node` 前（revision 闭环外，跑一次）。
// 读刚写正文（draft.initial，grounding 权威）+ scene_graph lines（含 mice_type/convergence_target/visibility）
// + outline phases（卷弧候选）+ 本章 brief（导演安排的收束意图，对照判实际）+ 既有 beats（query_arc 避重复）
// → LLM 判「哪些线弧/卷弧本章推进（advance）/闭合（close）+ 成长弧推进」→ 经 arc_ledger_update builtin
// （autoApply=true，mirror promise A1）写 arc_registry creative field + 产 arc_emergence artifact（本章 beats，
// 链段 summary 透传给 write_chapter post-settle 关口判定/停滞检测）。
//
// 🔑 范式红线（ADR-3 / creative-vs-mechanical，8.2 用户拍板定案）：节点内**两段分工**——
// - **段 1 纯代码**：候选清单抽取（lines/phases/character cards 结构投影）+ 既有 beats 取回 + episode
//   定位（episodeId/episodeIndex 解析——beat 的机械字段，LLM 产也不信，写入前纯代码覆写，mirror 7.1 F2
//   「LLM 拿不到的坐标字段归纯代码」判据）。**不判「这条弧推没推进」**（归 LLM 段）。
// - **段 2 LLM**（arc-emergence-agent.yaml）：弧节拍声明（advance/close 的「意义/意图」判断——创作意图
//   在写作那一刻的写手视角里，事后机械反推判不了，用户修正定案）+ close 的正文 grounding 选择。
//   伏笔弧不在此（归 promise_registry，6.5 涌现节点）——两判断认知任务不同（读者债 vs 叙事结构闭合，
//   design §7 trade-off）。
//
// graceful 三路（mirror promise-emergence CR-E3）：LLM parse 失败 / builtin 未注册 / 零 beats → 空 beats
// artifact + warning，**不破 chain**（登记缺失 = 本章弧无节拍，停滞检测兜底可见，非致命）。
//
// 链段节点（非 CONTRACTS[] 子 agent）：mirror promise-emergence-node / chapter-summary-node 先例——
// 经 createChapterChainNodes 装配，不进 agentContracts.ts CONTRACTS[]（orchestration-pattern.md 约定）。
//
// expected_downstream_consumers:
// - Story 8.2 Step 4（write_chapter post-settle）：summarizeRunSnapshot 透传本章 beats
//   （summary.arcEmergenceBeats）→ detectVolumeClosure 关口判定（卷弧 close → 派 arc-audit-agent 大审）
//   + detectArcStagnation 停滞触发（全量 beats 经 query_arc）。
// - Story 8.2：arc_registry creative field 消费（query_arc / 弧审 span 派生）。

/** 节点产出 artifact key（本章 beats + 计数，链段 summary 透传 arcEmergenceBeats 消费）。 */
const ARC_EMERGENCE_KEY = 'arc_emergence';

const ARC_EMERGENCE_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'arc-emergence-node',
  displayName: 'Arc Emergence Node',
  inputSchemaName: 'arcEmergenceInput',
  outputSchemaName: 'arcEmergence',
  // draft.initial（正文 grounding 权威）/ scene_graph（lines 候选）。episode_outlines / outline_phases /
  // asset_cards optional（缺 → 对应候选空 + graceful，不阻断链）。
  requiredArtifactKeys: ['draft.initial', 'scene_graph'],
  producedArtifactKeys: [ARC_EMERGENCE_KEY],
  // 经 arc_ledger_update builtin 写 arc_registry creative field（autoApply 直落，mirror promise A1）。
  sideEffects: ['persist_artifact'],
};

/** arc_emergence 节点产出 artifact（本章 beats + 观测计数，summary.arcEmergenceBeats 抽 beats）。 */
export interface ArcEmergenceArtifact {
  /** 本章登记的弧节拍（LLM 判定 + 纯代码覆写 episodeId/episodeIndex 后；空 = 本章无节拍）。 */
  beats: ArcBeat[];
  /** 段 1 抽取的候选计数（线/卷/成长——观测用）。 */
  lineCandidates: number;
  volumeCandidates: number;
  growthCandidates: number;
  /** LLM 产出且过 safeParse 的 beat 数（写入侧口径；与 beats 等长）。 */
  beatsProduced: number;
  /** 跳过原因（无正文 / 无候选 / 无 episodeId / LLM 失败 / 零 beats 时填，graceful）。 */
  skipped?: string;
  /** arc_ledger_update autoApply 落盘成功（mirror promise A1 applied）。 */
  applied?: boolean;
  /** builtin 返的 metadata（审计用）。 */
  fieldPatch?: unknown;
  /** 写入失败原因（builtin 未注册 / 抛错 / locked field；节点不破 chain，记 warning）。 */
  writeError?: string;
}

/** 安全取 artifact record（过滤非对象/数组，mirror promise-emergence-node artifactAsRecord）。 */
function artifactAsRecord(run: RunSnapshot, key: string): Record<string, unknown> | undefined {
  const raw = run.artifacts[key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function scalarOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 从 chapter_brief_input artifact 解析 episodeId（mirror promise-emergence-node resolveEpisodeId）。 */
function resolveEpisodeId(chapterBriefInput: unknown): string | undefined {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return undefined;
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return undefined;
}

/**
 * 从 episode_outlines artifact 解析本章 episodeIndex（beat 机械字段，纯代码定位非 LLM 产）。
 * 真实存在查找 by id（非数组位置假设，mirror completeness-verify-node deriveWrittenEpisodeIds 哲学）。
 * outlines 缺 / 本章不在 outlines / index 非数 → undefined（caller graceful）。
 *
 * Story 8.4 Step 3 export：research-verifier（资料员核实弹药——弧停滞信号需 currentEpisodeIndex）
 * 复用同源解析，防节点间 episodeIndex 派生漂移。
 */
export function resolveEpisodeIndex(episodeOutlines: unknown, episodeId: string): number | undefined {
  if (!Array.isArray(episodeOutlines)) return undefined;
  for (const ep of episodeOutlines) {
    if (!ep || typeof ep !== 'object') continue;
    const e = ep as { id?: unknown; index?: unknown };
    if (e.id !== episodeId) continue;
    if (typeof e.index !== 'number' || !Number.isFinite(e.index) || e.index < 0) return undefined;
    return e.index;
  }
  return undefined;
}

/** 线弧候选（段 1 纯代码投影，喂 LLM 对号）。 */
export interface LineArcCandidate {
  id: string;
  name: string;
  mice_type?: string;
  visibilityStatus?: string;
  visibilityTarget?: string;
  convergence_target?: string;
  phase_ref?: string;
  is_main_thread?: boolean;
}

/**
 * 从 scene_graph.lines 抽线弧候选清单（纯代码结构投影，非语义判断）。逐条守性（id/name 非空串），
 * 坏条目跳过。visibility（discriminated union）投影为 status + target 两标量。
 */
export function extractLineArcCandidates(sceneGraph: SceneGraph | undefined): LineArcCandidate[] {
  const out: LineArcCandidate[] = [];
  for (const line of sceneGraph?.lines ?? []) {
    if (!line || typeof line !== 'object') continue;
    if (typeof line.id !== 'string' || line.id.length === 0) continue;
    if (typeof line.name !== 'string' || line.name.length === 0) continue;
    const candidate: LineArcCandidate = { id: line.id, name: line.name };
    if (typeof line.mice_type === 'string' && line.mice_type.length > 0) candidate.mice_type = line.mice_type;
    if (line.visibility && typeof line.visibility === 'object') {
      const vis = line.visibility as { status?: unknown; target?: unknown };
      if (typeof vis.status === 'string') candidate.visibilityStatus = vis.status;
      if (typeof vis.target === 'string') candidate.visibilityTarget = vis.target;
    }
    if (typeof line.convergence_target === 'string') candidate.convergence_target = line.convergence_target;
    if (typeof line.phase_ref === 'string') candidate.phase_ref = line.phase_ref;
    if (typeof line.is_main_thread === 'boolean') candidate.is_main_thread = line.is_main_thread;
    out.push(candidate);
  }
  return out;
}

/** 卷弧候选（outline phase 投影，喂 LLM 对号）。 */
export interface VolumeArcCandidate {
  id: string;
  title: string;
  goal?: string;
  antagonist?: string;
  climax?: string;
  hook?: string;
}

/**
 * 从 outline_phases artifact（write_chapter caller-fetch 注入）抽卷弧候选。逐条守性（id/title 非空串），
 * 坏条目跳过。artifact 缺 → 空数组（卷弧候选降级，线弧/成长弧照常，graceful）。
 */
export function extractVolumeArcCandidates(outlinePhases: unknown): VolumeArcCandidate[] {
  if (!Array.isArray(outlinePhases)) return [];
  const out: VolumeArcCandidate[] = [];
  for (const p of outlinePhases) {
    if (!p || typeof p !== 'object') continue;
    const phase = p as Record<string, unknown>;
    if (typeof phase.id !== 'string' || phase.id.length === 0) continue;
    if (typeof phase.title !== 'string' || phase.title.length === 0) continue;
    const candidate: VolumeArcCandidate = { id: phase.id, title: phase.title };
    for (const key of ['goal', 'antagonist', 'climax', 'hook'] as const) {
      const v = phase[key];
      if (typeof v === 'string' && v.length > 0) candidate[key] = v;
    }
    out.push(candidate);
  }
  return out;
}

/** 成长弧候选（角色卡投影：arcRef = `growth:<characterId>`）。 */
export interface GrowthArcCandidate {
  characterId: string;
  name: string;
}

/**
 * 从 asset_cards artifact 抽成长弧候选（type='character' 卡）。逐条守性（id 非空），坏条目跳过。
 * artifact 缺 → 空数组（成长弧候选降级，graceful——asset_cards 由 write_chapter 为 emotion-verify 注入，
 * 同源复用）。纯代码过滤投影，非语义判断。
 */
export function extractGrowthArcCandidates(assetCards: unknown): GrowthArcCandidate[] {
  if (!Array.isArray(assetCards)) return [];
  const out: GrowthArcCandidate[] = [];
  for (const c of assetCards) {
    if (!c || typeof c !== 'object') continue;
    const card = c as { type?: unknown; id?: unknown; name?: unknown };
    if (card.type !== 'character') continue;
    if (typeof card.id !== 'string' || card.id.length === 0) continue;
    out.push({ characterId: card.id, name: typeof card.name === 'string' ? card.name : card.id });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 段 2 LLM 输出解析（robust，mirror parsePromiseEmergenceOutput：坏条目丢弃不全丢）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 解析 LLM 弧节拍登记输出为 ArcLedgerAction[]（robust：root JSON.parse 失败抛→触发重试；逐条
 * safeParse 丢坏保留好——close 无 grounding 在 arcBeatWriteSchema superRefine 处拒，shared-contracts）。
 *
 * 接受 `{ actions: [...] }`（prompt 约定形态）或裸 `[...]`（LLM 偶发直返数组），mirror
 * parsePromiseEmergenceOutput 哲学。
 *
 * @param content LLM 返回原始 content（可能带 ```json 围栏 / 前导文字 / 裸数组）。
 * @throws root JSON.parse 失败（触发 createLlmNode 重试→兜底 error artifact）。
 * @returns    ArcLedgerAction[]（全坏条目 → 空数组，非抛——caller 据长度判是否写盘）。
 */
export function parseArcEmergenceOutput(content: string): ArcLedgerAction[] {
  const trimmed = content.trim();
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    root = JSON.parse(extractJson(content));
  }

  let rawActions: unknown[];
  if (Array.isArray(root)) {
    rawActions = root;
  } else if (root && typeof root === 'object' && 'actions' in root) {
    const obj = root as { actions?: unknown };
    rawActions = Array.isArray(obj.actions) ? obj.actions : [];
  } else {
    rawActions = [];
  }

  const actions: ArcLedgerAction[] = [];
  for (const raw of rawActions) {
    const result = arcLedgerActionSchema.safeParse(raw);
    if (result.success) actions.push(result.data);
  }
  return actions;
}

// ════════════════════════════════════════════════════════════════════════════
// builtin 工具调用 helper（mirror promise-emergence-node fetchExistingPromises / writePromiseActions）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 经 query_arc builtin 取既有弧节拍（最近窗，避重复登记）。graceful：工具未注册/失败/形态坏 → undefined
 * （LLM 段收空既有列表 + warning）。
 *
 * Story 8.4 Step 3 export：research-verifier（资料员核实弹药——弧停滞信号）复用同一取数路径，
 * 单源防与 emergence / post-settle 两消费点的 beats 视图漂移。
 */
export async function fetchExistingArcBeats(projectPath: string): Promise<ArcBeat[] | undefined> {
  const tool = registry.get('query_arc');
  if (!tool) return undefined;
  try {
    const result = await tool.execute(
      {},
      {
        projectPath,
        // query_arc handler 仅用 projectDir（readArcRegistry），sessionId 走 toolExecution 通道不读；
        // 节点无 sessionId（chain node 不持 session 引用），传空串 placeholder（mirror fetchExistingPromises）。
        sessionId: '',
        abort: new AbortController().signal,
      },
    );
    const meta = result.metadata as { beats?: unknown } | undefined;
    if (!meta || !Array.isArray(meta.beats)) return undefined;
    // 逐条守性（坏条目丢好条目留，mirror query handler per-element 哲学）。
    return meta.beats.flatMap((b) => {
      const parsed = arcBeatSchema.safeParse(b);
      return parsed.success ? [parsed.data] : [];
    });
  } catch (err) {
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'arc-emergence-node: query_arc failed → graceful undefined (LLM 段收空既有列表)',
    );
    return undefined;
  }
}

/**
 * 经 arc_ledger_update builtin 写入弧节拍（**autoApply=true**，mirror promise A1 critical）：emergence 是
 * 自动链段节点（写手侧 LLM 写时声明，非人决策）→ handler 直接 onFieldEdited(source:'agent') 落盘
 * arc_registry creative field（绕开 PatchReview）。graceful：工具未注册/失败 → 记 writeError，不破 chain。
 *
 * @returns { applied, fieldPatch } 成功 / { error } 失败 / undefined = 工具未注册。
 */
async function writeArcLedgerActions(
  beats: ArcBeat[],
  projectPath: string,
): Promise<{ applied?: boolean; fieldPatch?: unknown; error?: string } | undefined> {
  const tool = registry.get('arc_ledger_update');
  if (!tool) {
    logger.warn(
      'arc-emergence-node: arc_ledger_update tool not registered → skip write (emergence still produces artifact)',
    );
    return { error: 'arc_ledger_update tool not registered' };
  }
  try {
    const result = await tool.execute(
      { actions: beats.map((beat) => ({ type: 'add_beat', beat })), autoApply: true },
      {
        projectPath,
        sessionId: '',
        abort: new AbortController().signal,
      },
    );
    const meta = result.metadata as { applied?: boolean } | undefined;
    return { applied: meta?.applied === true, fieldPatch: result.metadata };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { projectPath, err: msg },
      'arc-emergence-node: arc_ledger_update failed → graceful skip (beats produced but not persisted)',
    );
    return { error: msg };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// arc-emergence-node 节点（段 1 纯代码 → 段 2 LLM → 写入 builtin）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 构造弧节拍登记节点（段 1 纯代码取输入 → 段 2 LLM 声明 → 写入 builtin，design §2）。
 *
 * run 流程：
 *  1. **段 1 纯代码**：episode 定位（episodeId/episodeIndex）+ 候选抽取（lines/phases/character cards）
 *     + fetchExistingArcBeats（query_arc，避重复）。episodeId 缺 / draftText 空 / 三类候选全空 →
 *     空 artifact + skipped reason（graceful 跳 LLM 调用省成本）。
 *  2. **段 2 LLM**（createLlmNode，arc-emergence-agent.yaml）：候选清单 + 既有 beats + brief + draftText
 *     注入 → 单次 generate（+ 重试）→ parseArcEmergenceOutput → actions。LLM 失败（初试+重试）→
 *     空 artifact + skipped reason（graceful 不破 chain）。
 *  3. **写入**：episodeId/episodeIndex 纯代码覆写（LLM 产也不信坐标字段，mirror 7.1 F2 判据）→
 *     writeArcLedgerActions（arc_ledger_update autoApply=true）。builtin 未注册/失败 → 记 writeError
 *     不破 chain。零合法 beats → 空 artifact + skipped（LLM 判本章无弧推进，非失败）。
 *
 * 闭包传段 1 输出给 buildPrompt（mirror promise-emergence：outer run await 完 stash，inner sync 读）。
 *
 * @param deps LLM deps（generate/modelRef/signal，createLlmNode 用）。
 */
export function createArcEmergenceNode(deps: LlmNodeDeps): AgentNode {
  // 段 1 输出 stash（outer run 设置，inner buildPrompt 读取）。链段顺序驱动，无并发 race。
  let stashedLines: LineArcCandidate[] = [];
  let stashedPhases: VolumeArcCandidate[] = [];
  let stashedGrowth: GrowthArcCandidate[] = [];
  let stashedExisting: ArcBeat[] | undefined;
  let stashedEpisodeId = '';
  let stashedEpisodeIndex = 0;

  const innerNode = createLlmNode(
    {
      nodeId: 'arc-emergence-node',
      role: 'arc-emergence-agent',
      contract: ARC_EMERGENCE_CONTRACT,
      buildPrompt: (run: RunSnapshot) => {
        const draft = artifactAsRecord(run, 'draft.initial');
        const briefInput = artifactAsRecord(run, 'chapter_brief_input');
        const brief = briefInput?.brief;
        return {
          episodeId: stashedEpisodeId,
          episodeIndex: String(stashedEpisodeIndex),
          lineArcs: JSON.stringify(stashedLines),
          volumeArcs: JSON.stringify(stashedPhases),
          growthArcs: JSON.stringify(stashedGrowth),
          existingBeats: JSON.stringify(stashedExisting ?? []),
          chapterBrief: brief !== undefined ? JSON.stringify(brief) : '',
          draftText: scalarOf(draft?.text),
        };
      },
      parseOutput: (content: string) => {
        const actions = parseArcEmergenceOutput(content);
        // 返中间 artifact（__raw 标记）；outer wrapper 覆写 episode 字段 + 调 builtin 后产最终 artifact。
        return { stateKey: ARC_EMERGENCE_KEY, artifact: { __raw: true, actions } };
      },
    },
    deps,
  );

  return {
    contract: ARC_EMERGENCE_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;

      // ── 段 1 纯代码：episode 定位 + 候选抽取 + 既有 beats ──
      const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
      if (!episodeId) {
        // beat 必须挂 episode（章级叙事判断）；无 episode 关联无法登记（mirror chapter-summary-node skip）。
        logger.warn(
          { projectPath: run.projectPath },
          'arc-emergence-node: episodeId missing → skip arc beat declaration (beats require episode association)',
        );
        return emptyEmergenceArtifact(0, 0, 0, 'no episodeId (chapter_brief_input lacks episode association)');
      }
      const episodeIndex = resolveEpisodeIndex(run.artifacts['episode_outlines'], episodeId);
      if (episodeIndex === undefined) {
        logger.warn(
          { episodeId, projectPath: run.projectPath },
          'arc-emergence-node: episodeIndex unresolvable → skip (beats carry episodeIndex as mechanical field)',
        );
        return emptyEmergenceArtifact(0, 0, 0, 'no episodeIndex (episode not found in episode_outlines or index missing)');
      }
      const draft = artifactAsRecord(run, 'draft.initial');
      const draftText = scalarOf(draft?.text);
      if (draftText.trim().length === 0) {
        return emptyEmergenceArtifact(0, 0, 0, 'no draft text (grounding authority missing)');
      }

      const sceneGraph = run.artifacts['scene_graph'] as SceneGraph | undefined;
      const lines = extractLineArcCandidates(sceneGraph);
      const phases = extractVolumeArcCandidates(run.artifacts['outline_phases']);
      const growth = extractGrowthArcCandidates(run.artifacts['asset_cards']);
      if (lines.length === 0 && phases.length === 0 && growth.length === 0) {
        // 无任何弧候选（无 lines + 无 phases + 无角色卡）→ LLM 无 arcRef 可对号，跳过省成本
        // （8.2 全功能 dormant：无候选项目的弧系统空转，零回归）。
        return emptyEmergenceArtifact(0, 0, 0, 'no arc candidates (no lines/phases/character cards in scope)');
      }
      stashedLines = lines;
      stashedPhases = phases;
      stashedGrowth = growth;
      stashedEpisodeId = episodeId;
      stashedEpisodeIndex = episodeIndex;

      // ── 取既有 beats（避重复登记）──
      stashedExisting = await fetchExistingArcBeats(run.projectPath);

      // ── 段 2 LLM：弧节拍声明（advance/close 语义判断）──
      const innerResult = await innerNode.run(input);
      if (
        innerResult.artifact &&
        typeof innerResult.artifact === 'object' &&
        (innerResult.artifact as { error?: boolean }).error === true
      ) {
        // createLlmNode 兜底 error artifact（LLM 初试+重试均失败）→ graceful 转空 beats（不破 chain）。
        logger.warn(
          { nodeId: 'arc-emergence-node' },
          'arc-emergence-node: LLM failed after retries → graceful empty beats (chain continues)',
        );
        return emptyEmergenceArtifact(
          lines.length,
          phases.length,
          growth.length,
          'LLM arc emergence failed after retries',
        );
      }
      const rawArtifact = innerResult.artifact as { __raw?: boolean; actions?: ArcLedgerAction[] } | undefined;
      const actions = rawArtifact?.actions ?? [];
      if (actions.length === 0) {
        // LLM 判本章无弧推进（或产物全被 safeParse 丢）——非失败，graceful 跳过写盘。
        return emptyEmergenceArtifact(
          lines.length,
          phases.length,
          growth.length,
          'LLM produced no valid arc actions (no arc advanced/closed this chapter)',
        );
      }

      // ── episode 字段纯代码覆写（mirror 7.1 F2：坐标类机械字段 LLM 产也不信）+ 自然键 id 归一（缺 id
      // 的 beat 若不补，artifact 透传侧 arcBeatSchema per-element safeParse 会静默丢——id required）──
      const beats: ArcBeat[] = actions.map((action) =>
        normalizeArcBeat({ ...action.beat, episodeId, episodeIndex }),
      );
      const writeResult = await writeArcLedgerActions(beats, run.projectPath);

      const artifact: ArcEmergenceArtifact = {
        beats,
        lineCandidates: lines.length,
        volumeCandidates: phases.length,
        growthCandidates: growth.length,
        beatsProduced: beats.length,
      };
      if (writeResult?.applied === true) artifact.applied = true;
      if (writeResult?.fieldPatch !== undefined) artifact.fieldPatch = writeResult.fieldPatch;
      if (writeResult?.error !== undefined) artifact.writeError = writeResult.error;
      return { stateKey: ARC_EMERGENCE_KEY, artifact };
    },
  };
}

/** 构造空 emergence artifact（graceful 不破 chain）。 */
function emptyEmergenceArtifact(
  lineCandidates: number,
  volumeCandidates: number,
  growthCandidates: number,
  reason: string,
): NodeResult {
  return {
    stateKey: ARC_EMERGENCE_KEY,
    artifact: {
      beats: [],
      lineCandidates,
      volumeCandidates,
      growthCandidates,
      beatsProduced: 0,
      skipped: reason,
    } satisfies ArcEmergenceArtifact,
  };
}
