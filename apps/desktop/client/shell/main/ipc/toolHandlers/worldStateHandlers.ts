/**
 * Story 6.6 world-state tool handlers (ADR-14 / ADR-3). 5 handlers mirroring
 * `closureHandlers.ts` (`queryStoryHandler`) for the world-state derived index.
 *
 * Each agent tool (agent/src/tool/builtin.ts) crosses processes via the UNIFIED
 * `toolExecution` channel (remoteToolProxy -> handleToolExecute -> these
 * handlers). NO dedicated IPC channel / preload method / OrisonDesktopApi entry
 * — same unified-channel pattern as `query_story` / `query_craft`.
 *
 * projectId is derived from projectDir via `getProject(path.resolve(projectDir))`
 * (5-digit registry id, mirror 2.7/2.3 — NOT meta.id UUID). Handlers delegate to
 * `worldStateRepository` (read: reduce/slice/refs; write: insert slice+patches).
 *
 * Handlers NEVER throw on bad input — a malformed param / missing project /
 * repo failure degrades to a friendly message so the agent runLoop turn never
 * sees a rejection (mirror queryStoryHandler "never throws" contract). A
 * validation/resolve failure is returned as a structured miss; an unexpected
 * throw is caught + surfaced as a friendly error string.
 */
import path from 'node:path';
import {
  QUERY_CHAPTER_SUMMARY_EPISODE_CAP,
  buildCognitionSnapshot,
  buildPresenceSignal,
  buildWorldSnapshotRequestSchema,
  compileCognitionForScene,
  findWorldRefsRequestSchema,
  getCognitionAtTime,
  materializeChapterSummaryRequestSchema,
  queryChapterSummaryRequestSchema,
  queryWorldSliceRequestSchema,
  queryWorldStateRequestSchema,
  writeWorldStateRequestSchema,
  type BuildWorldSnapshotRequest,
  type FindWorldRefsRequest,
  type MaterializeChapterSummaryRequest,
  type QueryChapterSummaryRequest,
  type QueryWorldSliceRequest,
  type QueryWorldStateRequest,
  type SceneNode,
  type WriteWorldStateRequest,
  type WorldPatchInput,
} from '@orison/shared-contracts';
import { getProject } from '../../db/projectRepository';
import {
  buildWorldSnapshotCheckpointed,
  findWorldRefs,
  insertWorldSlice,
  listChapterSummaries,
  listWorldPatches,
  listWorldSlices,
  reduceWorldSubject,
  resolveWorldSubjectIdentity,
} from '../../db/worldStateRepository';
// CR-8（8.1 修复批）：materialize 组装核心自本文件下潜 db/worldStateMaterialize——原放 handler 文件
// 导致 db 层 worldStateBackfill 反向 import ipc 层（分层倒置）。函数签名零变。
import { materializeChapterSummaryCore } from '../../db/worldStateMaterialize';
import { getLogger } from '../../logger';
import type { ToolHandler } from './types';

// ── projectId 解析（mirror queryStoryHandler）──
function resolveProjectId(projectDir: string): string | null {
  // local_fingerprint == path.resolve(projectDir)（ensureProject 约定，closureHandlers 注释）。
  return getProject(path.resolve(projectDir))?.projectId ?? null;
}

function notRegistered(toolId: string) {
  return {
    title: toolId,
    output: '当前项目未注册到数据库，无法访问世界状态。',
    metadata: { ok: false, reason: 'project_not_registered' },
  };
}

function invalidParams(toolId: string, message: string) {
  getLogger().warn({ err: message }, `${toolId}: invalid params`);
  return {
    title: toolId,
    output: `参数无效: ${message}`,
    metadata: { ok: false, reason: 'invalid_params' },
  };
}

// ── 入参 schemas（shared-contracts 单源，mirror closureStoryQuerySchema 模式）──
// shell 包不直接依赖 zod——schemas 落 shared-contracts world-state.ts，handler + agent builtin 共用。
// handler 从 projectDir 解析 projectId（mirror query_story），故入参均不含 projectId。

function formatStateOutput(subjectId: string, state: Record<string, unknown>, issues: unknown[]): string {
  const stateJson = JSON.stringify(state, null, 2);
  if (issues.length === 0) {
    return `## ${subjectId} 当前状态\n\`\`\`json\n${stateJson}\n\`\`\``;
  }
  return `## ${subjectId} 当前状态\n\`\`\`json\n${stateJson}\n\`\`\`\n\n_⚠️ ${issues.length} 条 reduce issue（详见 metadata.issues）_`;
}

// ── handlers ──

/**
 * query_world_state：reduce 一个 subject 在给定虚构时刻的状态（可选 attrs 投影）。读工具。
 * Agent（Writer/leader/Reader-Audit）查「主角现在什么状态」「主角的血量和位置」等。
 */
export const queryWorldStateHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: QueryWorldStateRequest;
  try {
    parsed = queryWorldStateRequestSchema.parse(params);
  } catch (err) {
    return invalidParams('query_world_state', err instanceof Error ? err.message : String(err));
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('query_world_state');

  try {
    const { state, issues } = reduceWorldSubject(projectId, parsed.subjectId, parsed.at, {
      attrs: parsed.attrs,
    });
    return {
      title: `query_world_state: ${parsed.subjectId}`,
      output: formatStateOutput(parsed.subjectId, state, issues),
      metadata: {
        ok: true,
        subjectId: parsed.subjectId,
        at: parsed.at ?? null,
        attrs: parsed.attrs ?? null,
        state,
        issues,
        issueCount: issues.length,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId, subjectId: parsed.subjectId }, 'query_world_state failed');
    return {
      title: 'query_world_state',
      output: `状态查询失败: ${msg}`,
      metadata: { ok: false, reason: 'reduce_failed', error: msg },
    };
  }
};

/**
 * query_world_slice：列出 slices，可选收窄（subjectIds/type/at），可选附 patches。读工具。
 * Agent 查「主角相关切面」「某 type 的 timeline」「最近 10 条切面」等。Mirror NeuroBook slice.list。
 */
export const queryWorldSliceHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: QueryWorldSliceRequest;
  try {
    parsed = queryWorldSliceRequestSchema.parse(params);
  } catch (err) {
    return invalidParams('query_world_slice', err instanceof Error ? err.message : String(err));
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('query_world_slice');

  try {
    const slices = listWorldSlices(projectId, {
      subjectIds: parsed.subjectIds,
      type: parsed.type,
      withPatches: parsed.withPatches,
      at: parsed.at,
      axis: parsed.axis,
    });
    const lines = slices.map(
      (s) =>
        `- [${s.storyTime}] ${s.title}${s.kind ? ` (${s.kind})` : ''}${
          s.summary ? ` — ${s.summary}` : ''
        }${s.patches ? ` · ${s.patches.length} patch(es)` : ''}`,
    );
    const output =
      lines.length > 0
        ? `## 切面 ${parsed.at !== undefined ? `(≤ storyTime ${parsed.at})` : ''}\n${lines.join('\n')}`
        : '未找到匹配的切面。';
    return {
      title: `query_world_slice (${slices.length})`,
      output,
      metadata: { ok: true, count: slices.length, slices },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId }, 'query_world_slice failed');
    return {
      title: 'query_world_slice',
      output: `切面查询失败: ${msg}`,
      metadata: { ok: false, reason: 'list_failed', error: msg },
    };
  }
};

/**
 * find_world_refs：反查指向某 subject 的引用（关系只存一边，反查找谁引用我）。读工具。
 * Mirror NeuroBook findRefs：「这把剑被谁装备」「凤凰阵营有谁」。
 */
export const findWorldRefsHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: FindWorldRefsRequest;
  try {
    parsed = findWorldRefsRequestSchema.parse(params);
  } catch (err) {
    return invalidParams('find_world_refs', err instanceof Error ? err.message : String(err));
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('find_world_refs');

  try {
    const refs = findWorldRefs(projectId, parsed.subjectId);
    const lines = refs.map(
      (r) => `- [${r.storyTime}] ${r.subjectId} @ ${r.path} → ${JSON.stringify(r.value)}`,
    );
    const output =
      lines.length > 0
        ? `## 指向 ${parsed.subjectId} 的引用\n${lines.join('\n')}`
        : `没有发现指向 ${parsed.subjectId} 的引用。`;
    return {
      title: `find_world_refs: ${parsed.subjectId} (${refs.length})`,
      output,
      metadata: { ok: true, subjectId: parsed.subjectId, count: refs.length, refs },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId, subjectId: parsed.subjectId }, 'find_world_refs failed');
    return {
      title: 'find_world_refs',
      output: `引用反查失败: ${msg}`,
      metadata: { ok: false, reason: 'find_refs_failed', error: msg },
    };
  }
};

/**
 * 写入共享逻辑（write_world_events=derived / amend_world_state=amendment）。source 由 handler 强制
 * （防调用方误标）；repo `insertWorldSlice` 注入 id/sliceId/storyTime/source。per-slice idempotent
 * （同 slice.id 旧 patches 先删再插，重提取干净替换——稳定 slice.id 是关键）。
 */
function writeWorldHandler(toolId: string, source: 'derived' | 'amendment'): ToolHandler {
  return async ({ params, projectDir }) => {
    let parsed: WriteWorldStateRequest;
    try {
      parsed = writeWorldStateRequestSchema.parse(params);
    } catch (err) {
      return invalidParams(toolId, err instanceof Error ? err.message : String(err));
    }

    const projectId = resolveProjectId(projectDir);
    if (!projectId) return notRegistered(toolId);

    try {
      // dogfood R2 #91：subject 身份解析（单源 id + 查重复用）——写入前把提取器产的 subjects/patches
      // 的 id 收敛到 canonical/既有主体 id，防同角色新分身（LLM 连字符/前缀变体在此归并）。读路径
      // 不动（查询仍按调用方给 id）。
      const identity = resolveWorldSubjectIdentity(
        projectId,
        parsed.subjects,
        parsed.patches as WorldPatchInput[],
      );
      if (identity.remaps.length > 0) {
        getLogger().info(
          { projectId, toolId, remaps: identity.remaps },
          `${toolId}: subject id remapped to canonical/existing (dogfood R2 #91 identity gate)`,
        );
      }
      insertWorldSlice(projectId, parsed.slice, identity.patches, identity.subjects, source);
      const verb = source === 'derived' ? '派生' : '修补';
      return {
        title: `${toolId}: ${parsed.slice.id}`,
        output: `已写入 ${parsed.patches.length} 条${verb} patch（slice=${parsed.slice.id}, subject 登记数=${parsed.subjects.length}）。`,
        metadata: {
          ok: true,
          sliceId: parsed.slice.id,
          storyTime: parsed.slice.storyTime,
          patchCount: parsed.patches.length,
          subjectCount: parsed.subjects.length,
          source,
          subjectRemaps: identity.remaps,
          subjectReusedCount: identity.reusedCount,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: msg, projectId, toolId, sliceId: parsed.slice.id }, `${toolId} write failed`);
      return {
        title: toolId,
        output: `写入失败: ${msg}`,
        metadata: { ok: false, reason: 'write_failed', error: msg },
      };
    }
  };
}

/** write_world_events：提取器派生 events 写入（source='derived'）。 */
export const writeWorldEventsHandler: ToolHandler = writeWorldHandler('write_world_events', 'derived');

/** amend_world_state：修补 Agent 裁决后写覆盖层（source='amendment'）。 */
export const amendWorldStateHandler: ToolHandler = writeWorldHandler('amend_world_state', 'amendment');

// ── Story 6.1 CognitionGraph 查询（消费认知轴 patches，不建表，ADR-3 / ADR-14 / conclusions §3.6）──
//
// CognitionGraph = per-character `knows_at_time_t` 派生视图（实际轨，正文派生）。6.6 已建轴无关 reduce
// 引擎 + 认知轴提取器 + closure_world_patch.axis='cognitive'；6.1 在其上「升级消费」（world-state.ts:34）：
// 取 patches → 本地 getCognitionAtTime / compileCognitionForScene reduce（复用 reduceSubject，**不重写
// reduce**）。**不建 closure_cognition_* 表**（§3.1「不存当前状态只存变更条目」+ brief-compiler 先例 +
// leanest path）。查询走既有 closure_world_patch（listWorldPatches）。
//
// Mirror queryWorldStateHandler 「never throws」+ toolExecution channel。projectId 从 projectDir 解析。

/** 解析可选整数 storyTime 入参。返回 {value}（含 undefined=未传）或 {error}（类型非法）。 */
function readOptionalStoryTime(
  v: unknown,
  toolId: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return { ok: false, error: `${toolId}: 'at' must be an integer storyTime ordinal` };
  }
  if (v < 0) {
    return { ok: false, error: `${toolId}: 'at' must be non-negative` };
  }
  return { ok: true, value: v };
}

/**
 * query_cognition：查某角色在给定虚构时刻的认知状态（CognitionGraph `knows_at_time_t`）。读工具。
 *
 * 取该 subject 的 patches（subject-filtered db 级更高效）→ getCognitionAtTime 预过滤 cognitive + reduce
 * → 该角色在 t 的认知字典（knows/believes/misunderstands/suspects，value 可含 {objective, reader_perceived}）。
 * at 缺省取最新（全叠加）。供 6.2 KNOWLEDGE_VIOLATION/FORGOTTEN_REVEAL 状态查询 + leader/Writer/Reader-Audit。
 */
export const queryCognitionHandler: ToolHandler = async ({ params, projectDir }) => {
  // characterSubjectId：必填非空 string（角色 subject id，6.6 认知提取器产）。
  const rawSubjectId = params.characterSubjectId;
  if (typeof rawSubjectId !== 'string' || rawSubjectId.length === 0) {
    return invalidParams(
      'query_cognition',
      "'characterSubjectId' is required (non-empty string — the character subject id)",
    );
  }
  const characterSubjectId = rawSubjectId;

  const atParse = readOptionalStoryTime(params.at, 'query_cognition');
  if (!atParse.ok) return invalidParams('query_cognition', atParse.error);
  const at = atParse.value;

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('query_cognition');

  try {
    // subject-filtered patches（db 级过滤更高效）→ getCognitionAtTime 预过滤 cognitive + reduceSubject。
    const patches = listWorldPatches(projectId, characterSubjectId, at);
    const cognition = getCognitionAtTime(patches, characterSubjectId, at);
    const isEmpty = Object.keys(cognition).length === 0;
    const atLabel = at === undefined ? '最新' : `storyTime ${at}`;
    return {
      title: `query_cognition: ${characterSubjectId}`,
      output: isEmpty
        ? `## ${characterSubjectId} 在 ${atLabel} 的认知\n_暂无认知状态数据（该角色在该 storyTime 前无认知轴 patches）。_`
        : `## ${characterSubjectId} 在 ${atLabel} 的认知\n\`\`\`json\n${JSON.stringify(cognition, null, 2)}\n\`\`\``,
      metadata: {
        ok: true,
        characterSubjectId,
        at: at ?? null,
        cognition,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId, characterSubjectId }, 'query_cognition failed');
    return {
      title: 'query_cognition',
      output: `认知查询失败: ${msg}`,
      metadata: { ok: false, reason: 'cognition_query_failed', error: msg },
    };
  }
};

/**
 * query_cognition_graph：查某 storyTime 下所有角色的认知（CognitionGraph per-scene 物化视图）。读工具。
 *
 * compileCognitionForScene 纯函数（复用 reduceSubject）：收集 cognitive patches 涉及的角色逐个 reduce。
 * at 缺省取最新（patches 内最大 storyTime）。**不建 closure_* 表**（§3.1）。供 6.2 一致基底 + 8.1 摘要物化。
 *
 * 注：compileCognitionForScene 仅读 scene.storyTime（per-scene 截断键）。查询以 storyTime 为键（非 sceneId）
 * ——cognition 数据在 closure_world_state（实际轨），查询不必耦合 scene_graph（目标轨 project.yaml）。
 * 故合成最小合法 SceneNode 供纯函数复用；inert 字段（id/presentationOrder/role/lineTags）不影响 reduce 行为。
 */
export const queryCognitionGraphHandler: ToolHandler = async ({ params, projectDir }) => {
  const atParse = readOptionalStoryTime(params.at, 'query_cognition_graph');
  if (!atParse.ok) return invalidParams('query_cognition_graph', atParse.error);
  const at = atParse.value;

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('query_cognition_graph');

  try {
    // at 缺省：先取全部 patches，再算最大 storyTime 作「最新」截断点（compileCognitionForScene 需具体值）。
    const patches = listWorldPatches(projectId, undefined, at);
    let storyTime = at;
    if (storyTime === undefined) {
      let max = -Infinity;
      for (const p of patches) {
        if (typeof p.storyTime === 'number' && p.storyTime > max) max = p.storyTime;
      }
      storyTime = max === -Infinity ? undefined : max;
    }
    if (storyTime === undefined) {
      return {
        title: 'query_cognition_graph',
        output: '暂无认知状态数据（项目无 world-state patches）。',
        metadata: { ok: true, at: null, characterCount: 0, cognition: {} },
      };
    }
    // 合成最小合法 SceneNode（compileCognitionForScene 仅读 storyTime；其余字段 inert 不影响 reduce）。
    const scene: SceneNode = {
      id: '__cognition_graph_query__',
      storyTime,
      presentationOrder: { chapter: 0, pos: 0 },
      role: 'normal',
      lineTags: [],
    };
    const cognition = compileCognitionForScene(scene, patches);
    const characterCount = cognition ? Object.keys(cognition).length : 0;
    return {
      title: `query_cognition_graph (storyTime ${storyTime}, ${characterCount} character(s))`,
      output:
        characterCount > 0
          ? `## storyTime ${storyTime} 的角色认知图\n\`\`\`json\n${JSON.stringify(cognition, null, 2)}\n\`\`\``
          : `storyTime ${storyTime} 前无角色认知数据。`,
      metadata: {
        ok: true,
        at: storyTime,
        characterCount,
        cognition: cognition ?? {},
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId }, 'query_cognition_graph failed');
    return {
      title: 'query_cognition_graph',
      output: `认知图查询失败: ${msg}`,
      metadata: { ok: false, reason: 'cognition_graph_query_failed', error: msg },
    };
  }
};

// ── Story 8.1：checkpoint-backed snapshot 查询 + ChapterStateSummary 查询/物化（design §2/§3/§5/§6）──
//
// 3 handlers mirror 既有 6.6/6.1 handlers（never-throws 三态：invalid_params / project_not_registered /
// repo 抛 → friendly error metadata；unified toolExecution channel，无专用 IPC/preload）。
//
// - build_world_snapshot：state 投影 = checkpoint-backed（buildWorldSnapshotCheckpointed——fold 量与总史
//   规模解耦，IPC 传 snapshot 非全量 patches，design §6 Q4）；cognition/presence 投影 = shell 侧全 fold
//   （listWorldPatches 取回 in-process 折叠——免跨进程传全集，**8.3 S5 起轴预过滤**：cognition 单取
//   cognitive 轴 / presence 双轴 IN，替代全轴拉取后 TS filter；subject 收窄在无 subject 参数的批量
//   投影形态下不可用，轴收窄是本意；per-character checkpoint 化 defer 8.3 §7）。
// - query_chapter_summary：读物化摘要（三选一收窄 + cap 50，防倾倒 mirror slice.list 哲学）。
// - materialize_chapter_summary：组装六字段摘要（assembleChapterStateSummary 纯函数单源）+ 单 WAL 事务
//   落 summary + 机会式 checkpoint（design §2 物化流；链上触发归 chapter-summary-node，Step 4）。
//
// 范式判据（ADR-3）：六字段全部「查询/汇编/确定性计算」over 既有结构化数据（patches/subjects/
// promise_registry）；project.yaml 读取遵守 db-repository.md「组装层 direct 字段抽取 + per-element
// safeParse」Convention（不 full parent schema safeParse——坏条目丢好条目留，缺源 degraded 不阻断）。

/**
 * build_world_snapshot：章节级 world-state 快照（checkpoint-backed）或 cognition/presence 投影。读工具
 * **纯读**（CR-6，8.1 修复批：checkpoint 读取不写库——writeCheckpoint:false，写只走 materialize 机会式）。
 *
 * brief-compiler #6 stateAtT 用 ats 批量（一次 IPC 得本章各场 snapshot）；Reader-Audit 基底用 at 单点
 * （缺省 = 最新）；cognition/presence 投影供 6.2/6.4 消费（fetch 切换归 Step 5）。输出语义与纯函数
 * buildWorldStateSnapshot 等价（Step 5 有 deep-equal 测试锚）。
 */
export const buildWorldSnapshotHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: BuildWorldSnapshotRequest;
  try {
    parsed = buildWorldSnapshotRequestSchema.parse(params);
  } catch (err) {
    return invalidParams(
      'build_world_snapshot',
      err instanceof Error ? err.message : String(err),
    );
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('build_world_snapshot');

  try {
    // cognition / presence 投影：shell 侧全 fold（design §6——免全集 IPC；fold in-process µs-ms 级）。
    // Story 8.3 S5（6.4 E4 axis 传参落地）：取数 SQL 侧轴预过滤——cognition 只消费 cognitive 轴；
    // presence 双轴（cognitive 的 evidenceSceneId × physical 的 presence_scene 对拍）→ IN 单次取两轴。
    // 纯函数内部 axis filter 保留（单源契约「自行 filter」——对已滤输入恒等，行为零变化；agent 侧
    // fallback 路径仍全轴取回自行过滤）。IPC 面零变化（本收窄在 shell 进程内，不增往返）。
    if (parsed.projection === 'cognition' || parsed.projection === 'presence') {
      const patches =
        parsed.projection === 'cognition'
          ? listWorldPatches(projectId, undefined, parsed.at, 'cognitive')
          : listWorldPatches(projectId, undefined, parsed.at, ['cognitive', 'physical']);
      const atLabel = parsed.at === undefined ? '最新' : `storyTime ${parsed.at}`;
      if (parsed.projection === 'cognition') {
        const snapshot = buildCognitionSnapshot(patches, parsed.subjectCap);
        if (snapshot === undefined) {
          return {
            title: 'build_world_snapshot (cognition)',
            output: `暂无认知状态数据（${atLabel} 前无 cognitive patches）。`,
            metadata: {
              ok: true,
              projection: 'cognition',
              at: parsed.at ?? null,
              characterCount: 0,
              snapshot: null,
            },
          };
        }
        return {
          title: `build_world_snapshot (cognition, ${snapshot.characters.length} character(s))`,
          output: `## ${atLabel} 角色认知快照\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\``,
          metadata: {
            ok: true,
            projection: 'cognition',
            at: parsed.at ?? null,
            characterCount: snapshot.characters.length,
            snapshot,
          },
        };
      }
      const signals = buildPresenceSignal(patches);
      return {
        title: `build_world_snapshot (presence, ${signals.length} signal(s))`,
        output:
          signals.length > 0
            ? `## ${atLabel} 在场性预筛信号\n${signals
                .map(
                  (s) =>
                    `- ${s.characterSubjectId} @ storyTime ${s.storyTime}: fact ${s.factPath} 证据场 ${s.evidenceSceneId} ≠ 在场 ${s.presenceSceneId}`,
                )
                .join('\n')}`
            : `无在场性预筛信号（${atLabel}：无 evidenceSceneId cognitive / 无 physical 在场数据 / 无可疑）。`,
        metadata: { ok: true, projection: 'presence', at: parsed.at ?? null, count: signals.length, signals },
      };
    }

    // state 投影（默认）：checkpoint-backed fold，只传 snapshot 不传 patches（IPC 传输 O(snapshot)，design §6）。
    const ats =
      parsed.ats !== undefined ? parsed.ats : parsed.at !== undefined ? [parsed.at] : [undefined];
    const snapshots = ats.map((at) =>
      buildWorldSnapshotCheckpointed(projectId, at, {
        subjectCap: parsed.subjectCap,
        attrs: parsed.attrs,
      }),
    );
    const blocks = snapshots.map((snap) => {
      const head = `## storyTime ${snap.at ?? '最新'} 世界状态快照（${snap.subjects.length} subjects）`;
      if (snap.subjects.length === 0) return `${head}\n_该截断点前无已建立状态。_`;
      return `${head}\n${snap.subjects
        .map(
          (s) =>
            `- ${s.subjectId}: ${JSON.stringify(s.state)}${s.issueCount > 0 ? ` _⚠️ ${s.issueCount} issue(s)_` : ''}`,
        )
        .join('\n')}`;
    });
    return {
      title: `build_world_snapshot (${snapshots.length} snapshot(s))`,
      output: blocks.join('\n\n'),
      metadata: { ok: true, projection: 'state', count: snapshots.length, snapshots },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId }, 'build_world_snapshot failed');
    return {
      title: 'build_world_snapshot',
      output: `快照查询失败: ${msg}`,
      metadata: { ok: false, reason: 'snapshot_failed', error: msg },
    };
  }
};

/**
 * query_chapter_summary：读物化 ChapterStateSummary（三选一收窄：episodeIds 精确集 / fromIndex+toIndex
 * 闭区间，至少其一；单次 ≤ QUERY_CHAPTER_SUMMARY_EPISODE_CAP=50，防倾倒）。读工具。
 *
 * 输出 markdown lines mirror queryWorldSliceHandler（每章一行字段计数 + truncated/degraded 标记 +
 * token 观测）；metadata.summaries 携带完整 ChapterSummaryRecord（消费方按需取字段）。
 */
export const queryChapterSummaryHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: QueryChapterSummaryRequest;
  try {
    parsed = queryChapterSummaryRequestSchema.parse(params);
  } catch (err) {
    return invalidParams('query_chapter_summary', err instanceof Error ? err.message : String(err));
  }

  // 三选一收窄：至少其一（无收窄全倾倒违防倾倒契约）；fromIndex/toIndex 视为成对（单给一端范围无界）。
  // CR-1（8.1 修复批）：hasIds 判 length 非 !== undefined——空数组曾是「已提供」态绕过收窄全表倾倒
  // （schema .min(1) 已闭死主路，此处 belt 双保险——坏条目经非 parse 路径注入时仍拦）。
  const hasIds = (parsed.episodeIds?.length ?? 0) > 0;
  const hasFrom = parsed.fromIndex !== undefined;
  const hasTo = parsed.toIndex !== undefined;
  if (!hasIds && !hasFrom && !hasTo) {
    return invalidParams(
      'query_chapter_summary',
      '需提供 episodeIds 或 fromIndex/toIndex 之一作收窄（至少其一）',
    );
  }
  if (hasFrom !== hasTo) {
    return invalidParams('query_chapter_summary', 'fromIndex 与 toIndex 须成对提供');
  }
  if (hasFrom && hasTo) {
    if ((parsed.fromIndex as number) > (parsed.toIndex as number)) {
      return invalidParams('query_chapter_summary', 'fromIndex 不能大于 toIndex');
    }
    if ((parsed.toIndex as number) - (parsed.fromIndex as number) + 1 > QUERY_CHAPTER_SUMMARY_EPISODE_CAP) {
      return invalidParams(
        'query_chapter_summary',
        `范围过大（${(parsed.toIndex as number) - (parsed.fromIndex as number) + 1} 章）：单次上限 ${QUERY_CHAPTER_SUMMARY_EPISODE_CAP} 章`,
      );
    }
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('query_chapter_summary');

  try {
    const summaries = listChapterSummaries(projectId, {
      episodeIds: parsed.episodeIds,
      fromIndex: parsed.fromIndex,
      toIndex: parsed.toIndex,
    });
    const lines = summaries.map((r) => {
      const s = r.summary;
      const idx = r.episodeIndex !== null ? ` [#${r.episodeIndex}]` : '';
      const flags = [r.truncated ? '已截断' : '', s.degradedNote !== undefined ? `⚠ ${s.degradedNote}` : '']
        .filter(Boolean)
        .join('，');
      return (
        `- ${r.episodeId}${idx} — 终态 ${s.characterEndStates.length} · 休眠 ${s.oracleDormant.length}` +
        ` · 关系 ${s.relationshipChanges.length} · 伏笔 ${s.foreshadowChanges.length}` +
        ` · 新实体 ${s.newEntities.length} · 未决 ${s.openPromises.length}` +
        ` · 下章回收 ${s.nextChapterPayoffs.length}（≈${r.tokenEstimate} tokens${flags ? `；${flags}` : ''}）`
      );
    });
    return {
      title: `query_chapter_summary (${summaries.length})`,
      output:
        lines.length > 0
          ? `## 章节摘要\n${lines.join('\n')}`
          : '未找到匹配的章节摘要（该范围尚未物化——materialize_chapter_summary 触发或 backfill 补建）。',
      metadata: { ok: true, count: summaries.length, summaries },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId }, 'query_chapter_summary failed');
    return {
      title: 'query_chapter_summary',
      output: `章节摘要查询失败: ${msg}`,
      metadata: { ok: false, reason: 'list_failed', error: msg },
    };
  }
};

// ── materialize 组装核心已下潜 db/worldStateMaterialize.ts（CR-8，8.1 修复批）──
// 原实现（project.yaml 三源读取 + beat/slice episode 归类 + materializeChapterSummaryCore）住本
// handler 文件，导致 db 层 worldStateBackfill 反向 import ipc 层（分层倒置）。函数签名零变；本文件
// 只保留 IPC 壳（materializeChapterSummaryHandler），db 组装核心归 db 层供 backfill 复用。

/**
 * materialize_chapter_summary：物化一章的 ChapterStateSummary（六字段 + 机会式 checkpoint），幂等
 * （同 episodeId 重调 upsert 覆盖不累积——链上 leader redo 每轮重物化 = 终轮摘要即终态，design §2）。
 *
 * 链上触发 = chapter-summary-node（promise-emergence 后，Step 4）；backfill 重建（Step 6）复用
 * materializeChapterSummaryCore。source 语义由 handler 固定为「从当前 db + project.yaml 派生」——
 * 调用方只给 episodeId（mirror writeWorldHandler 强制 source 哲学）。
 */
export const materializeChapterSummaryHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: MaterializeChapterSummaryRequest;
  try {
    parsed = materializeChapterSummaryRequestSchema.parse(params);
  } catch (err) {
    return invalidParams(
      'materialize_chapter_summary',
      err instanceof Error ? err.message : String(err),
    );
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('materialize_chapter_summary');

  try {
    const result = await materializeChapterSummaryCore(projectId, projectDir, parsed.episodeId);
    const flags = [
      result.summary.truncated ? '已截断' : '',
      result.summary.degradedNote !== undefined ? `⚠ ${result.summary.degradedNote}` : '',
    ]
      .filter(Boolean)
      .join('，');
    return {
      title: `materialize_chapter_summary: ${parsed.episodeId}`,
      output:
        `已物化章节摘要 ${parsed.episodeId}（token≈${result.tokenEstimate}` +
        `${flags ? `；${flags}` : ''}；checkpoint ${result.checkpointCount} 个）。`,
      metadata: {
        ok: true,
        episodeId: parsed.episodeId,
        tokenEstimate: result.tokenEstimate,
        truncated: result.summary.truncated,
        checkpointCount: result.checkpointCount,
        summary: result.summary,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { err: msg, projectId, episodeId: parsed.episodeId },
      'materialize_chapter_summary failed',
    );
    return {
      title: 'materialize_chapter_summary',
      output: `章节摘要物化失败: ${msg}`,
      metadata: { ok: false, reason: 'materialize_failed', error: msg },
    };
  }
};
