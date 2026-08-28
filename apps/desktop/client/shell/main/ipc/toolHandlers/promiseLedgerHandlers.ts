/**
 * Story 6.5 Promise ledger tool handlers (ADR-3 / ADR-14 / design §2 / §5 方案 C).
 *
 * Mirrors infoReleaseHandlers.ts (the creative-field write pattern). Neither
 * writes to disk directly:
 * - query_promise returns the curated promise_registry from project.yaml
 *   (parsed via local-bff loadProject — single source of truth, shell has no
 *   direct yaml dep), optional sceneId/episodeId filter (beats carry sceneRef).
 * - promise_ledger_update receives a BOUNDED action enum (add_promise /
 *   add_beat / update_beat / remove_promise / remove_beat), projects the actions
 *   onto the current promise_registry via applyPromiseActions (pure code,
 *   shared-contracts), re-validates via promiseRegistrySchema, and returns a
 *   `field_patch` metadata envelope with the full projected registry as `data`
 *   (action: 'set'). The UI surfaces the change in the patch-review flow;
 *   acceptance persists via syncField → fieldSyncBridge.onFieldEdited (version
 *   bump + stale propagate).
 *
 * Trust-boundary defense (interface-contracts / data-flow spec): LLM output is
 * parsed via promiseActionSchema before projection; the projection is re-
 * validated via promiseRegistrySchema. An invalid action shape / invalid
 * projection is surfaced to the LLM rather than persisted. corrupt-project guard
 * (mirror sceneGraphReadHandler / infoReleaseHandlers): refuse to stage an
 * incremental edit when the on-disk field / whole project is corrupt —
 * projecting onto a fresh empty registry would `action:'set'`-overwrite real
 * unreadable data (cross-field pollution).
 *
 * Promise ledger is a creative field (project.yaml promise_registry) that spans
 * BOTH tracks (design §5 方案 C / NeuroBook PromiseBeat planned/factual dual
 * state): target-track = the Promise debt itself + planned beats (author /
 * Director intent); actual-track = factual beats (prose-actual after Scene
 * written). It is NOT a closure_* derived table. Emergence registration is
 * driven by the actual track (promise-emergence-node, Phase D) but persisted
 * here as creative field — mirror InfoReleaseMap 「LLM 写入并对它负责」 mode.
 *
 * Crosses processes via the UNIFIED `toolExecution` channel (remoteToolProxy →
 * handleToolExecute → these handlers). NO dedicated IPC channel / preload /
 * OrisonDesktopApi entry — same unified-channel pattern as scene_graph_* /
 * info_release_map_* / query_world_*.
 *
 * Handlers NEVER throw on bad input (mirror worldStateHandlers / sceneGraph /
 * infoReleaseHandlers 「never throws」 contract): a malformed param / missing
 * project / repo failure degrades to a friendly message so the agent runLoop
 * turn never sees a rejection.
 *
 * version 注释（mirror infoReleaseHandlers :159-161 + 6.1 CR-O1）：in-data
 * promise_registry.version/updatedBy 是装饰字段——sync 真值是
 * field_metadata[field].version，由 fieldSyncBridge.onFieldEdited 落盘时 bump。
 * projector 只管 promises/beats（纯机械），不动 version/updatedBy（透传 current
 * 的装饰值，落盘时 onFieldEdited 覆盖）。
 *
 * ⚠ snapshot fetch（fetchPromiseLedgerSnapshotForIpc）不在本 Phase（归 Phase D：
 * Reader-Audit 接入时判断 chapter-chain artifact 流是否已覆盖，design §8.1）。
 * 本文件只做写/读 handler + toolExecution 注册。
 */
import type { ToolHandler } from './types';
import {
  applyPromiseActions,
  promiseActionSchema,
  promiseRegistrySchema,
  type PromiseAction,
  type PromiseRegistry,
} from '@orison/shared-contracts';
import { withProjectLock } from '../../fs/projectWriteLock';

/**
 * readPromiseRegistry result (mirror InfoReleaseReadResult): distinguishes
 * legit-empty from corrupt so the update handler never projects onto a fresh
 * registry and `action:'set'` overwrites real (unreadable) data.
 * - `absent`: project loads but has no promise_registry field (new project /
 *   field never written). Fresh empty registry is the correct base for
 *   incremental edits (additive — promise_registry is optional in
 *   projectDocumentSchema).
 * - `ok`: promise_registry field present and schema-valid.
 * - `corrupt`: promise_registry field present but schema-invalid, OR loadProject
 *   returned null (whole project document corrupt/missing). Refuse to stage.
 */
type PromiseReadResult =
  | { status: 'absent'; registry: PromiseRegistry }
  | { status: 'ok'; registry: PromiseRegistry }
  | { status: 'corrupt'; reason: string };

async function readPromiseRegistry(projectDir: string): Promise<PromiseReadResult> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    // loadProject normally catches + returns null; a throw here is unexpected.
    // Treat as corrupt so we don't silently overwrite via a fresh-registry projection.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[promise_registry] loadProject threw for ${projectDir}: ${reason}`);
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  // loadProject null = whole project document judged corrupt/missing. Must NOT
  // treat promise_registry as absent-empty here: the update handler would project
  // onto a fresh registry and `action:'set'` would overwrite real (unreadable)
  // data on the next save (cross-field pollution). Refuse + surface.
  if (doc === null) {
    return {
      status: 'corrupt',
      reason:
        '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存 Promise 台账的增量编辑',
    };
  }

  const raw = doc.promise_registry;
  if (raw == null) {
    // Legit empty: project loads fine but has no promise_registry field yet.
    return { status: 'absent', registry: promiseRegistrySchema.parse({}) };
  }

  try {
    return { status: 'ok', registry: promiseRegistrySchema.parse(raw) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[promise_registry] promise_registry field exists but is schema-invalid in ${projectDir}: ${reason}`,
    );
    return { status: 'corrupt', reason: `Promise 台账字段数据校验失败：${reason}` };
  }
}

/** 非空 string 归一（undefined/null/空串/非 string → undefined）。 */
function optionalNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * query_promise：读 project.yaml promise_registry（promises + beats），可按 sceneId/episodeId
 * 收窄（beats 携带 sceneRef/episodeId；filter 命中的 beat 所属 promise 一并返回，子集自洽）。
 * 读工具。promise-emergence-node（Phase D，避重复登记）/ 4.4 cross-arc 完整性 / leader 消费。
 * 永不抛。
 */
export const queryPromiseHandler: ToolHandler = async ({ params, projectDir }) => {
  const sceneId = optionalNonEmptyString(params.sceneId);
  const episodeId = optionalNonEmptyString(params.episodeId);

  const result = await readPromiseRegistry(projectDir);
  if (result.status === 'corrupt') {
    return {
      title: 'query_promise',
      output: `Promise 台账无法读取：${result.reason}`,
    };
  }
  // absent（项目无 promise_registry 字段）→ 当空 registry（additive：未填 = 空，非 corrupt）。
  let promises = result.registry.promises;
  let beats = result.registry.beats;

  if (sceneId || episodeId) {
    const filteredBeats = beats.filter((b) => {
      if (sceneId !== undefined && b.sceneRef !== sceneId) return false;
      if (episodeId !== undefined && b.episodeId !== episodeId) return false;
      return true;
    });
    // 子集自洽：只返回命中的 beat 所属的 promise（无 beat 的 promise 不挂具体场，
    // 不属于某 scene/episode 的「活跃 Promise」，filter 时排除）。
    const ownerIds = new Set(filteredBeats.map((b) => b.promiseId));
    promises = promises.filter((p) => ownerIds.has(p.id));
    beats = filteredBeats;
  }

  if (promises.length === 0 && beats.length === 0) {
    const filterDesc = [
      sceneId ? `sceneId=${sceneId}` : '',
      episodeId ? `episodeId=${episodeId}` : '',
    ]
      .filter(Boolean)
      .join(' / ');
    return {
      title: 'query_promise',
      output: filterDesc
        ? `未找到匹配的 Promise（filter: ${filterDesc}）。`
        : '项目尚未登记 Promise（promise_registry 为空）。',
      metadata: { ok: true, promiseCount: 0, beatCount: 0, promises: [], beats: [] },
    };
  }
  return {
    title: `query_promise (${promises.length} promise(s), ${beats.length} beat(s))`,
    output: JSON.stringify({ promises, beats }, null, 2),
    metadata: { ok: true, promiseCount: promises.length, beatCount: beats.length, promises, beats },
  };
};

/**
 * 投影 Promise actions 到当前 registry → schema-validated full registry（trust-boundary：parse → project →
 * re-validate）。read+project+validate 单源 helper，leader PatchReview 路径 + emergence autoApply 路径共用。
 *
 * - corrupt on-disk registry（或整文档 corrupt）→ 拒绝（不投影到 fresh registry 致 action:'set' overwrite）。
 * - projected schema-invalid（projector drift / 坏 entry）→ 拒绝（belt-and-suspenders，trust-boundary defense）。
 */
async function computeProjectedRegistry(
  projectDir: string,
  actions: PromiseAction[],
): Promise<{ ok: true; registry: PromiseRegistry } | { ok: false; message: string }> {
  // Project actions onto the current registry → full projected registry (mirror
  // sceneGraphUpdateHandler / infoReleaseMapUpdateHandler). CR-corrupt: refuse
  // to stage an incremental edit when the on-disk promise_registry is corrupt
  // (or the whole project failed to load) — projecting onto a fresh empty
  // registry would `action:'set'`-overwrite real unreadable data. absent (legit
  // empty / new project) is the only case where a fresh registry is correct.
  const readResult = await readPromiseRegistry(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `Promise 台账更新被拒：${readResult.reason}。请先在项目设定文件中修复或移除损坏的 promise_registry，再重新提交增量编辑。`,
    };
  }
  const current = readResult.registry; // 'absent' -> fresh empty registry; 'ok' -> loaded registry

  const projected = applyPromiseActions(current, actions);

  // Trust-boundary defense: re-validate the projection. applyPromiseActions is
  // pure mechanical by-id + natural-key beat merge, but a malformed entry (e.g.
  // add_promise carrying a promise missing required summary would already fail
  // promiseActionSchema.parse above). The safeParse here is belt-and-suspenders
  // + guards against future projector drift.
  const validated = promiseRegistrySchema.safeParse(projected);
  if (!validated.success) {
    return {
      ok: false,
      message: `Promise 台账更新被拒：投影后的台账数据校验失败（${validated.error.message}）。Promise 须完整（id + title + summary），节拍须完整（promiseId + sceneRef + kind）。`,
    };
  }
  return { ok: true, registry: validated.data };
}

/**
 * promise_ledger_update：bounded action enum（add_promise/add_beat/update_beat/remove_promise/
 * remove_beat）→ 纯代码投影 full registry。**两种落盘模式**（A1 fix / design §3.3）：
 *
 * 1. **autoApply=true（emergence 自动落盘）**：emergence 是自动链段节点（LLM 从 gap 涌现，非人决策），
 *    mirror 6.6 world-state 自动写 closure_world_patch（不经 PatchReview）。Promise 是实际轨（factual beats），
 *    应自动落盘 creative field。handler **直接调** local-bff `onFieldEdited(source:'agent')` 写盘（version bump
 *    + markStaleFields + projectDocumentSchema.parse + saveProject，mirror 用户编辑流但 source='agent'），
 *    经 withProjectLock 串行化（防并发编辑丢更新，mirror fieldSyncIpc / closureChainIpc accept 路径）。
 *    返 `{ok, applied:true, promiseCount, beatCount}` metadata（非 field_patch envelope）。onFieldEdited throw
 *    （locked field / save fail）→ graceful error 返（emergence 记 writeError 不破 chain，mirror node graceful）。
 *
 * 2. **autoApply 缺省/false（leader PatchReview 路径）**：返 `{type:'field_patch', field:'promise_registry',
 *    action:'set', data: fullRegistry}` envelope（当前既有行为）。field_patch → UI patch-review → syncField →
 *    onFieldEdited（source='user'）落盘 + version bump。leader / Director authoring Promise 走此路径。
 *
 * LLM 经此工具登记/推进 Promise（AC「涌现登记由实际轨提取驱动 + Promise ledger 创意字段写入」）。
 * **sync version**（field_metadata[field].version）由 fieldSyncBridge.onFieldEdited 落盘时 bump
 * （sync 真值）；in-data promise_registry.version/updatedBy 为既有装饰字段（mirror foreshadow_registry +
 * InfoReleaseMap，非 sync 真值——CR-O1）。projector 只管 promises/beats（纯机械 by-id + 自然键 beat 归并）。
 *
 * 🔑 A1（CR-A1 critical，block AC2）：原实现 emergence 走 field_patch envelope，但 summarizeRunSnapshot 不提
 * promise_emergence / write_chapter metadata 只记 chapter_candidate field_patch / UI WRITE_TOOLS 不含
 * promise_ledger_update → emergence 产的 Promise 永不落盘（feature 无效 + AC2 违反）。autoApply 模式绕开
 * PatchReview 直接落盘，emergence 自动画上闭环（mirror 6.6 world-state 自动写）。
 */
export const promiseLedgerUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  const rawActions = (params as { actions?: unknown }).actions;
  const actionList = Array.isArray(rawActions) ? rawActions : [];
  // A1：emergence node 调时传 autoApply:true → 自动落盘 creative field（绕开 PatchReview）。
  // leader / Director 调缺省 false → field_patch envelope 走 UI patch-review。
  const autoApply = (params as { autoApply?: unknown }).autoApply === true;

  // Trust-boundary: parse each action through the discriminated-union schema.
  // An invalid action shape is surfaced to the LLM via the tool output rather
  // than silently dropping or persisting a malformed registry.
  let actions: PromiseAction[];
  try {
    actions = actionList.map((a) => promiseActionSchema.parse(a));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'promise_ledger_update',
      output:
        `Promise 台账更新被拒：操作格式无效（${reason}）。` +
        '可用操作为 add_promise（promise 必填：id + title + summary；firstBeat 可选）/ ' +
        'add_beat（beat：promiseId + sceneRef + kind）/ update_beat（beatId + patch）/ ' +
        'remove_promise（promiseId）/ remove_beat（beatId）。',
    };
  }

  // ── autoApply 路径：emergence 自动落盘（mirror 6.6 world-state 自动写 closure_world_patch）──
  // 经 withProjectLock 串行化 read-modify-write（read + project + onFieldEdited 一原子单元，防并发编辑丢更新）。
  // onFieldEdited 内部 loadProject→mutate→save（source='agent'）；lock 保证 read 与 onFieldEdited 内 read 间无并发写。
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeProjectedRegistry(projectDir, actions);
        if (!result.ok) {
          return { title: 'promise_ledger_update', output: result.message };
        }
        const registry = result.registry;
        // dynamic import local-bff（mirror readPromiseHandlers 的 dynamic import 模式，避 shell 静态依赖 local-bff）。
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'promise_registry', registry, {
          source: 'agent',
          reason: 'Promise 涌现登记（emergence node 自动落盘，非人决策）',
        });
        return {
          title: 'promise_ledger_update',
          output: `Promise 台账已生效（${registry.promises.length} 条 Promise、${registry.beats.length} 条节拍，已写入项目设定）。`,
          metadata: {
            ok: true,
            applied: true,
            promiseCount: registry.promises.length,
            beatCount: registry.beats.length,
          },
        };
      });
    } catch (err) {
      // onFieldEdited throws on locked field（用户锁 promise_registry 拒自动改）/ save failure / parse fail →
      // graceful（emergence node 记 writeError 不破 chain，mirror writePromiseActions graceful）。
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[promise_registry] autoApply landing failed for ${projectDir}: ${reason}`);
      return {
        title: 'promise_ledger_update',
        output: `Promise 台账自动生效失败：${reason}。涌现登记的操作已产出但未落盘（链继续）。`,
      };
    }
  }

  // ── leader PatchReview 路径（默认）：field_patch envelope → UI patch-review → syncField → onFieldEdited ──
  const result = await computeProjectedRegistry(projectDir, actions);
  if (!result.ok) {
    return { title: 'promise_ledger_update', output: result.message };
  }
  const projectedRegistry = result.registry;
  const promiseCount = projectedRegistry.promises.length;
  const beatCount = projectedRegistry.beats.length;
  return {
    title: 'promise_ledger_update',
    output: `Promise 台账更新已备好：调整后共 ${promiseCount} 条 Promise、${beatCount} 条节拍。请在补丁面板审阅——确认后写入项目设定。`,
    metadata: {
      type: 'field_patch',
      field: 'promise_registry',
      action: 'set',
      data: projectedRegistry,
    },
  };
};
