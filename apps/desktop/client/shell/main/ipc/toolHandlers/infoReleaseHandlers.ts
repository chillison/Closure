/**
 * Story 6.1 InfoReleaseMap tool handlers (ADR-3 / ADR-14 / conclusions §3.1).
 *
 * Mirrors sceneGraphHandlers.ts (the creative-field write pattern). Neither
 * writes to disk directly:
 * - info_release_map_read returns the curated info_release_map from project.yaml
 *   (parsed via local-bff loadProject — single source of truth, shell has no
 *   direct yaml dep), optional sceneId/episodeId filter.
 * - info_release_map_update receives a BOUNDED action enum (add_entry /
 *   update_entry / remove_entry), projects the actions onto the current
 *   info_release_map via applyInfoReleaseActions (pure code, shared-contracts),
 *   re-validates via infoReleaseMapSchema, and returns a `field_patch` metadata
 *   envelope with the full projected map as `data` (action: 'set'). The UI
 *   surfaces the change in the patch-review flow; acceptance persists via
 *   syncField → fieldSyncBridge.onFieldEdited (version bump + stale propagate).
 *   **Story 6.3 DW-4 dual mode** (mirror promise_ledger_update A1): autoApply=true
 *   (Director 自动 authoring) → handler calls onFieldEdited(source:'agent') directly
 *   via withProjectLock, bypassing PatchReview (返 applied metadata, 非 field_patch).
 *   autoApply 缺省/false → 6.1 既有 field_patch envelope 行为不变（backward compat）。
 *
 * Trust-boundary defense (interface-contracts / data-flow spec): LLM output is
 * parsed via infoReleaseActionSchema before projection; the projection is re-
 * validated via infoReleaseMapSchema. An invalid action shape / invalid
 * projection is surfaced to the LLM rather than persisted. corrupt-project guard
 * (mirror sceneGraphReadHandler): refuse to stage an incremental edit when the
 * on-disk field / whole project is corrupt — projecting onto a fresh empty map
 * would `action:'set'`-overwrite real unreadable data (cross-field pollution).
 *
 * InfoReleaseMap is the TARGET-TRACK creative field (author-intent 「打算怎么写」,
 * conclusions §3.1「前置计划」) — NOT a derived index. CognitionGraph (actual-
 * track, prose-derived) lives in worldStateHandlers (query_cognition /
 * query_cognition_graph). The two form the 「计划 vs 实际」 dual-track that
 * Reader-Audit reconciles (6.2).
 *
 * Crosses processes via the UNIFIED `toolExecution` channel (remoteToolProxy →
 * handleToolExecute → these handlers). NO dedicated IPC channel / preload /
 * OrisonDesktopApi entry — same unified-channel pattern as scene_graph_* /
 * query_story / query_world_*.
 *
 * Handlers NEVER throw on bad input (mirror worldStateHandlers / sceneGraph
 * 「never throws」contract): a malformed param / missing project / repo failure
 * degrades to a friendly message so the agent runLoop turn never sees a rejection.
 */
import type { ToolHandler } from './types';
import {
  applyInfoReleaseActions,
  infoReleaseActionSchema,
  infoReleaseMapSchema,
  type InfoReleaseAction,
  type InfoReleaseMap,
} from '@orison/shared-contracts';
import { withProjectLock } from '../../fs/projectWriteLock';

/**
 * readInfoReleaseMap result (mirror SceneGraphReadResult): distinguishes legit-
 * empty from corrupt so the update handler never projects onto a fresh map and
 * `action:'set'` overwrites real (unreadable) data.
 * - `absent`: project loads but has no info_release_map field (new project /
 *   field never written). Fresh empty map is the correct base for incremental
 *   edits (additive — info_release_map is optional in projectDocumentSchema).
 * - `ok`: info_release_map field present and schema-valid.
 * - `corrupt`: info_release_map field present but schema-invalid, OR loadProject
 *   returned null (whole project document corrupt/missing). Refuse to stage.
 */
type InfoReleaseReadResult =
  | { status: 'absent'; map: InfoReleaseMap }
  | { status: 'ok'; map: InfoReleaseMap }
  | { status: 'corrupt'; reason: string };

async function readInfoReleaseMap(projectDir: string): Promise<InfoReleaseReadResult> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    // loadProject normally catches + returns null; a throw here is unexpected.
    // Treat as corrupt so we don't silently overwrite via a fresh-map projection.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[info_release_map] loadProject threw for ${projectDir}: ${reason}`);
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  // loadProject null = whole project document judged corrupt/missing. Must NOT
  // treat info_release_map as absent-empty here: the update handler would project
  // onto a fresh map and `action:'set'` would overwrite real (unreadable) data
  // on the next save (cross-field pollution). Refuse + surface.
  if (doc === null) {
    return {
      status: 'corrupt',
      reason:
        '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存信息释放计划的增量编辑',
    };
  }

  const raw = doc.info_release_map;
  if (raw == null) {
    // Legit empty: project loads fine but has no info_release_map field yet.
    return { status: 'absent', map: infoReleaseMapSchema.parse({}) };
  }

  try {
    return { status: 'ok', map: infoReleaseMapSchema.parse(raw) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[info_release_map] info_release_map field exists but is schema-invalid in ${projectDir}: ${reason}`,
    );
    return { status: 'corrupt', reason: `信息释放计划字段数据校验失败：${reason}` };
  }
}

/** 非空 string 归一（undefined/null/空串/非 string → undefined）。 */
function optionalNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * info_release_map_read：读 project.yaml info_release_map.entries，可按 sceneId/episodeId 收窄。
 * 读工具。Director（6.3）消费；6.1 只提供查询能力（Director 接线归 6.3）。永不抛。
 */
export const infoReleaseMapReadHandler: ToolHandler = async ({ params, projectDir }) => {
  const sceneId = optionalNonEmptyString(params.sceneId);
  const episodeId = optionalNonEmptyString(params.episodeId);

  const result = await readInfoReleaseMap(projectDir);
  if (result.status === 'corrupt') {
    return {
      title: 'info_release_map_read',
      output: `信息释放计划无法读取：${result.reason}`,
    };
  }
  // absent（项目无 info_release_map 字段）→ 当空 entries（additive：未填 = 空，非 corrupt）。
  let entries = result.map.entries;
  if (sceneId) entries = entries.filter((e) => e.sceneRef === sceneId);
  if (episodeId) entries = entries.filter((e) => e.episodeId === episodeId);

  if (entries.length === 0) {
    const filterDesc = [
      sceneId ? `sceneId=${sceneId}` : '',
      episodeId ? `episodeId=${episodeId}` : '',
    ]
      .filter(Boolean)
      .join(' / ');
    return {
      title: 'info_release_map_read',
      output: filterDesc
        ? `未找到匹配的信息释放计划条目（filter: ${filterDesc}）。`
        : '项目尚未填写信息释放计划（info_release_map 为空）。',
      metadata: { ok: true, count: 0, entries: [] },
    };
  }
  return {
    title: `info_release_map_read (${entries.length})`,
    output: JSON.stringify({ entries }, null, 2),
    metadata: { ok: true, count: entries.length, entries },
  };
};

/**
 * 投影 InfoRelease actions 到当前 map → schema-validated full map（trust-boundary：parse → project →
 * re-validate）。read+project+validate 单源 helper，leader PatchReview 路径 + Director autoApply 路径共用。
 *
 * - corrupt on-disk map（或整文档 corrupt）→ 拒绝（不投影到 fresh map 致 action:'set' overwrite）。
 * - projected schema-invalid（projector drift / 坏 entry）→ 拒绝（belt-and-suspenders，trust-boundary defense）。
 */
async function computeProjectedMap(
  projectDir: string,
  actions: InfoReleaseAction[],
): Promise<{ ok: true; map: InfoReleaseMap } | { ok: false; message: string }> {
  // Project actions onto the current map → full projected map (mirror sceneGraphUpdateHandler).
  // CR-corrupt: refuse to stage an incremental edit when the on-disk
  // info_release_map is corrupt (or the whole project failed to load) — projecting
  // onto a fresh empty map would `action:'set'`-overwrite real unreadable data.
  // absent (legit empty / new project) is the only case where a fresh map is correct.
  const readResult = await readInfoReleaseMap(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `信息释放计划更新被拒：${readResult.reason}。请先在项目设定文件中修复或移除损坏的 info_release_map，再重新提交增量编辑。`,
    };
  }
  const current = readResult.map; // 'absent' -> fresh empty map; 'ok' -> loaded map

  const projected = applyInfoReleaseActions(current, actions);

  // Trust-boundary defense: re-validate the projection. applyInfoReleaseActions is
  // pure mechanical by-id, but a malformed entry (e.g. add_entry carrying an entry
  // missing required sceneRef would already fail infoReleaseActionSchema.parse above).
  // The safeParse here is belt-and-suspenders + guards against future projector drift.
  const validated = infoReleaseMapSchema.safeParse(projected);
  if (!validated.success) {
    return {
      ok: false,
      message: `信息释放计划更新被拒：投影后的计划数据校验失败（${validated.error.message}）。add/update 须携带完整条目（id + sceneRef 必填）。`,
    };
  }
  return { ok: true, map: validated.data };
}

/**
 * info_release_map_update：bounded action enum（add/update/remove entry）→ 纯代码投影 full map。**两种落盘模式**
 * （Story 6.3 DW-4 / mirror promise_ledger_update A1 双落盘模式）：
 *
 * 1. **autoApply=true（Director 自动 authoring 落盘）**：Director 是 leader 侧子 agent（非人决策的自动 authoring），
 *    mirror 6.5 emergence autoApply + 6.6 world-state 自动写。handler **直接调** local-bff `onFieldEdited(source:'agent')`
 *    写盘（version bump + markStaleFields + projectDocumentSchema.parse + saveProject，mirror 用户编辑流但 source='agent'），
 *    经 withProjectLock 串行化（防并发编辑丢更新，mirror fieldSyncIpc / closureChainIpc accept 路径 / promiseLedgerHandlers）。
 *    返 `{ok, applied:true, entryCount}` metadata（非 field_patch envelope）。onFieldEdited throw（locked field / save fail）
 *    → graceful error 返（Director 记 writeError 不破 chain，mirror promiseLedgerHandlers autoApply graceful）。
 *
 * 2. **autoApply 缺省/false（leader PatchReview 路径，默认）**：返 `{type:'field_patch', field:'info_release_map',
 *    action:'set', data: fullMap}` envelope（6.1 既有行为，backward compat）。field_patch → UI patch-review → syncField →
 *    onFieldEdited（source:'user'）落盘 + version bump。leader / 工作台手 authoring 走此路径（6.1 不变）。
 *
 * LLM 经此工具写 InfoReleaseMap 条目（AC「LLM 写入并对它负责」）。**sync version**（field_metadata[field].version）
 * 由 fieldSyncBridge.onFieldEdited 落盘时 bump（sync 真值）；in-data info_release_map.version/updatedBy 为
 * 既有装饰字段（mirror foreshadow_registry，非 sync 真值——CR-O1）。projector 只管 entries（纯机械 by-id）。
 */
export const infoReleaseMapUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  const rawActions = (params as { actions?: unknown }).actions;
  const actionList = Array.isArray(rawActions) ? rawActions : [];
  // Story 6.3 DW-4：Director 调时传 autoApply:true → 自动落盘 creative field（绕开 PatchReview）。
  // leader / 工作台手 authoring 调缺省 false → field_patch envelope 走 UI patch-review（6.1 既有行为不变）。
  const autoApply = (params as { autoApply?: unknown }).autoApply === true;

  // Trust-boundary: parse each action through the discriminated-union schema.
  // An invalid action shape is surfaced to the LLM via the tool output rather
  // than silently dropping or persisting a malformed map.
  let actions: InfoReleaseAction[];
  try {
    actions = actionList.map((a) => infoReleaseActionSchema.parse(a));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'info_release_map_update',
      output:
        `信息释放计划更新被拒：操作格式无效（${reason}）。` +
        '可用操作为 add_entry/update_entry（携带完整条目：id + sceneRef 必填）/ remove_entry（携带 entryId）。',
    };
  }

  // ── autoApply 路径：Director 自动落盘（mirror 6.5 promiseLedgerHandlers autoApply + 6.6 world-state 自动写）──
  // 经 withProjectLock 串行化 read-modify-write（read + project + onFieldEdited 一原子单元，防并发编辑丢更新）。
  // onFieldEdited 内部 loadProject→mutate→save（source='agent'）；lock 保证 read 与 onFieldEdited 内 read 间无并发写。
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeProjectedMap(projectDir, actions);
        if (!result.ok) {
          return { title: 'info_release_map_update', output: result.message };
        }
        const map = result.map;
        // dynamic import local-bff（mirror readInfoReleaseMap / promiseLedgerHandlers 的 dynamic import 模式，
        // 避 shell 静态依赖 local-bff）。
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'info_release_map', map, {
          source: 'agent',
          reason: 'Director 自动 authoring（6.3，非人决策）',
        });
        return {
          title: 'info_release_map_update',
          output: `信息释放计划已生效（共 ${map.entries.length} 条，已写入项目设定）。`,
          metadata: {
            ok: true,
            applied: true,
            entryCount: map.entries.length,
          },
        };
      });
    } catch (err) {
      // onFieldEdited throws on locked field（用户锁 info_release_map 拒自动改）/ save failure / parse fail →
      // graceful（Director 记 writeError 不破 chain，mirror promiseLedgerHandlers autoApply graceful）。
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[info_release_map] autoApply landing failed for ${projectDir}: ${reason}`);
      return {
        title: 'info_release_map_update',
        output: `信息释放计划自动生效失败：${reason}。Director 的操作已产出但未落盘（链继续）。`,
      };
    }
  }

  // ── leader PatchReview 路径（默认，6.1 既有行为不变）：field_patch envelope → UI patch-review → syncField → onFieldEdited ──
  const result = await computeProjectedMap(projectDir, actions);
  if (!result.ok) {
    return { title: 'info_release_map_update', output: result.message };
  }
  const projectedMap = result.map;

  const entryCount = projectedMap.entries.length;
  return {
    title: 'info_release_map_update',
    output: `信息释放计划更新已备好：调整后共 ${entryCount} 条。请在补丁面板审阅——确认后写入项目设定。`,
    metadata: {
      type: 'field_patch',
      field: 'info_release_map',
      action: 'set',
      data: projectedMap,
    },
  };
};
