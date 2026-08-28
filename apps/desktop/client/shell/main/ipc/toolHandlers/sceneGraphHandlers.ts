/**
 * Scene-graph tool handlers — scene_graph_read, scene_graph_update (Story 1.3).
 *
 * Mirrors outlineHandlers.ts. Neither writes to disk directly (default path):
 * - scene_graph_read returns the curated scene_graph from project.yaml (parsed via
 *   local-bff loadProject — single source of truth, shell has no direct yaml dep).
 * - scene_graph_update receives a BOUNDED action enum (add/update/remove
 *   scene/edge/line), projects the actions onto the current scene_graph via
 *   applySceneGraphActions (pure code, shared-contracts), and returns a
 *   `field_patch` metadata envelope with the full projected graph as `data`
 *   (action: 'set') — same shape as outline_update. The UI surfaces the change in
 *   the patch-review flow; acceptance persists via syncField. Validation
 *   (CAUSAL DAG / reachability / mesh mapping) runs on the staged graph in the UI
 *   patch-review data channel (design §4), not here.
 *
 * **Story 7.4 autoApply dual-mode**（mirror infoReleaseMapUpdateHandler DW-4 / promiseLedgerHandlers 6.5）：
 * autoApply=true（leader 自动落盘，如 7.4 Director atomic-edit apply）→ handler 直接调
 * local-bff `onFieldEdited(source:'agent')` 写盘（version bump + markStaleFields + saveProject，mirror
 * 用户编辑流但 source='agent'），经 withProjectLock 串行化（防并发编辑丢更新）。返 `{ok, applied:true,
 * data: projectedGraph}` metadata（非 field_patch envelope，data 供 caller 刷新 initialArtifacts）。
 * autoApply 缺省/false → 1.3 既有 field_patch envelope 行为完全不变（backward compat，零回归）。
 *
 * Trust-boundary defense (data-flow spec): LLM output is parsed via
 * sceneGraphActionSchema before projection; the projection is then re-validated
 * via sceneGraphSchema (applySceneGraphActions fills scene/line defaults but
 * cannot fill edge from/to/type or line.name, so a partial add can yield an
 * invalid graph). An invalid projection is surfaced to the LLM rather than
 * persisted.
 */
import type { ToolHandler } from './types';
import {
  applySceneGraphActions,
  expandForkBranch,
  sceneGraphActionSchema,
  sceneGraphSchema,
  type SceneGraph,
  type SceneGraphAction
} from '@orison/shared-contracts';
import { withProjectLock } from '../../fs/projectWriteLock';
import { getLogger } from '../../logger';

/**
 * readSceneGraph result (CR-008/CR-001): distinguishes legit-empty from corrupt
 * so the update handler never projects onto a fresh graph and `action:'set'`
 * overwrites real (unreadable) data.
 * - `absent`: project loads but has no scene_graph field (new project / field
 *   never written). Fresh empty graph is the correct base for incremental edits.
 * - `ok`: scene_graph field present and schema-valid.
 * - `corrupt`: scene_graph field present but schema-invalid, OR loadProject
 *   returned null (whole project document corrupt/missing). Refuse to stage an
 *   incremental edit - surface to the LLM with a log rather than silently
 *   falling back to an empty graph (cross-field pollution guard).
 */
type SceneGraphReadResult =
  | { status: 'absent'; graph: SceneGraph }
  | { status: 'ok'; graph: SceneGraph }
  | { status: 'corrupt'; reason: string };

async function readSceneGraph(projectDir: string): Promise<SceneGraphReadResult> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    // loadProject normally catches + returns null; a throw here is unexpected.
    // Treat as corrupt so we don't silently overwrite via a fresh-graph projection.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[scene_graph] loadProject threw for ${projectDir}: ${reason}`);
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  // loadProject null = whole project document judged corrupt/missing. Must NOT
  // treat scene_graph as absent-empty here: the update handler would project
  // onto a fresh graph and `action:'set'` would overwrite real (unreadable)
  // data on the next save (cross-field pollution). Refuse + surface.
  if (doc === null) {
    return {
      status: 'corrupt',
      reason: '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存场景结构的增量编辑',
    };
  }

  const raw = doc.scene_graph;
  if (raw == null) {
    // Legit empty: project loads fine but has no scene_graph field yet.
    return { status: 'absent', graph: sceneGraphSchema.parse({}) };
  }

  try {
    return { status: 'ok', graph: sceneGraphSchema.parse(raw) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[scene_graph] scene_graph field exists but is schema-invalid in ${projectDir}: ${reason}`);
    return { status: 'corrupt', reason: `场景结构字段数据校验失败：${reason}` };
  }
}

export const sceneGraphReadHandler: ToolHandler = async ({ projectDir }) => {
  const result = await readSceneGraph(projectDir);
  if (result.status === 'absent') {
    return { title: 'scene_graph_read', output: '项目尚未建立场景结构（scene_graph 为空）。' };
  }
  if (result.status === 'corrupt') {
    return { title: 'scene_graph_read', output: `场景结构无法读取：${result.reason}` };
  }
  return { title: 'scene_graph_read', output: JSON.stringify(result.graph, null, 2) };
};

/**
 * 投影 SceneGraph actions（含 fork_branch expander）到当前 graph → schema-validated full graph
 * （trust-boundary：parse → project → re-validate）。read+project+validate 单源 helper，leader PatchReview
 * 路径 + 7.4 autoApply 路径共用（mirror infoReleaseHandlers computeProjectedMap）。
 *
 * - corrupt on-disk graph（或整文档 corrupt）→ 拒绝（不投影到 fresh graph 致 action:'set' overwrite）。
 * - projected schema-invalid（projector drift / 坏 edge/line）→ 拒绝（belt-and-suspenders，trust-boundary defense）。
 * - fork_branch 唯一非机械 op → expandForkBranch 展开成 add_line/add_scene/add_edge 批次喂 projector
 *   （interface-contracts「bounded action enum op 须 projector case 或 pre-projector expander」convention）。
 */
async function computeProjectedGraph(
  projectDir: string,
  actions: SceneGraphAction[],
): Promise<{ ok: true; graph: SceneGraph } | { ok: false; message: string }> {
  // Project actions onto the current graph → full projected graph (design §4).
  // Empty/null current graph is treated as a fresh graph (schema fills defaults).
  // CR-008/CR-001: refuse to stage an incremental edit when the on-disk
  // scene_graph is corrupt (or the whole project failed to load) - projecting
  // onto a fresh empty graph would `action:'set'`-overwrite real unreadable
  // data. absent (legit empty / new project) is the only case where a fresh
  // graph is the correct base.
  const readResult = await readSceneGraph(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `场景结构更新被拒：${readResult.reason}。请先在项目设定文件中修复或移除损坏的 scene_graph，再重新提交增量编辑。`,
    };
  }
  const current = readResult.graph; // 'absent' -> fresh empty graph; 'ok' -> loaded graph

  // fork_branch 是唯一非机械 op（design §2.3 / child3 §4 AGENT-001）：它算 fork-point
  // 下游拷贝集（图遍历 = 纯代码）并 emit add_line/add_scene(带 origin_ref)/add_edge 批次。
  // 这里在投影前展开 → projector（applySceneGraphActions）保持纯机械 by-id 职责不变。
  // 不展开则 fork_branch 落进 projector switch 无此 case → 静默 no-op（landmine）。
  const expandedActions: SceneGraphAction[] = [];
  for (const a of actions) {
    if (a.op === 'fork_branch') {
      expandedActions.push(...expandForkBranch(current, a));
    } else {
      expandedActions.push(a);
    }
  }

  const projected = applySceneGraphActions(current, expandedActions);

  // Trust-boundary defense (interface-contracts / data-flow spec): applySceneGraphActions
  // fills mechanical defaults for scene/line but CANNOT for edges (from/to/type have no
  // sensible default) and not for line.name — so a partial add_edge / add_line action can
  // yield a schema-INVALID projected graph. Validate before returning; an invalid
  // projection is surfaced to the LLM rather than allowed to enter the patch flow
  // (where UI parse would swallow it and persist invalid data → loadProject corrupt backup).
  const validated = sceneGraphSchema.safeParse(projected);
  if (!validated.success) {
    return {
      ok: false,
      message: `场景结构更新被拒：投影后的结构数据校验失败（${validated.error.message}）。add 边须完整（id/from/to/type），add 线须完整（id/name）。`,
    };
  }
  return { ok: true, graph: validated.data };
}

/**
 * scene_graph_update：bounded action enum（add/update/remove scene/edge/line，含 fork_branch expander）
 * → 纯代码投影 full graph。**两种落盘模式**（Story 7.4 / mirror infoReleaseMapUpdateHandler DW-4 /
 * promiseLedgerHandlers 6.5 双落盘模式）：
 *
 * 1. **autoApply=true（leader 自动落盘，如 7.4 Director atomic-edit apply）**：leader 在 write_chapter
 *    日志点调度落盘（非人决策的自动 authoring，mirror 6.5 emergence autoApply + 6.6 world-state 自动写）。
 *    handler **直接调** local-bff `onFieldEdited(source:'agent')` 写盘（version bump + markStaleFields +
 *    projectDocumentSchema.parse + saveProject），经 withProjectLock 串行化（防并发编辑丢更新）。
 *    返 `{ok, applied:true, data: projectedGraph}` metadata（非 field_patch envelope；data 供 caller
 *    write_chapter 刷新 initialArtifacts['scene_graph'] → draft-writer/brief-compiler 消费新 graph 单轮闭环）。
 *    onFieldEdited throw（locked field / save fail）→ graceful error 返（链段不破，mirror promiseLedgerHandlers）。
 *
 * 2. **autoApply 缺省/false（leader PatchReview 路径，默认）**：返 `{type:'field_patch', field:'scene_graph',
 *    action:'set', data: fullGraph}` envelope（1.3 既有行为，backward compat）。field_patch → UI patch-review →
 *    syncField → onFieldEdited（source:'user'）落盘 + version bump。leader / 工作台手 authoring 走此路径（1.3 不变）。
 *
 * LLM 经此工具（或 leader 内部经 registry.get 调）改 scene_graph（AC「LLM 写入并对它负责」）。**sync version**
 * （field_metadata[field].version）由 fieldSyncBridge.onFieldEdited 落盘时 bump（sync 真值）。
 */
export const sceneGraphUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  const rawActions = (params as { actions?: unknown }).actions;
  const actionList = Array.isArray(rawActions) ? rawActions : [];
  // Story 7.4：leader 调时传 autoApply:true → 自动落盘 creative field（绕开 PatchReview，mirror DW-4）。
  // leader / 工作台手 authoring 调缺省 false → field_patch envelope 走 UI patch-review（1.3 既有行为不变）。
  const autoApply = (params as { autoApply?: unknown }).autoApply === true;

  // Trust-boundary: parse each action through the discriminated-union schema.
  // An invalid action shape is surfaced to the LLM via the tool output rather
  // than silently dropping or persisting a malformed graph.
  let actions: SceneGraphAction[];
  try {
    actions = actionList.map((a) => sceneGraphActionSchema.parse(a));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'scene_graph_update',
      output: `场景结构更新被拒：操作格式无效（${reason}）。可用操作为 add_scene/update_scene/remove_scene/add_edge/remove_edge/add_line/update_line/remove_line。`,
    };
  }

  // ── autoApply 路径：leader 自动落盘（mirror 6.5 promiseLedgerHandlers autoApply + 6.3 DW-4 + 6.6 world-state 自动写）──
  // 经 withProjectLock 串行化 read-modify-write（read + project + onFieldEdited 一原子单元，防并发编辑丢更新）。
  // onFieldEdited 内部 loadProject→mutate→save（source='agent'）；lock 保证 read 与 onFieldEdited 内 read 间无并发写。
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeProjectedGraph(projectDir, actions);
        if (!result.ok) {
          return { title: 'scene_graph_update', output: result.message };
        }
        const graph = result.graph;
        // BMad CR-005：空操作短路——actions 空 / 投影后 graph 与 current 相同 → 不调 onFieldEdited（免虚假
        // version bump + markStaleFields）。对比 projected vs current graph（JSON 纯 equality，非浅比较）。
        // current 读自 readSceneGraph（lock 保证 read 与 onFieldEdited 间无并发写）。
        const currentRead = await readSceneGraph(projectDir);
        const currentGraph = currentRead.status === 'ok' ? currentRead.graph : null;
        const isNoChange =
          actions.length === 0 ||
          (currentGraph !== null && JSON.stringify(graph) === JSON.stringify(currentGraph));
        if (isNoChange) {
          return {
            title: 'scene_graph_update',
            output: '场景结构无变化（空操作），未落盘、未更新版本号。',
            metadata: { ok: true, applied: false, reason: 'no_change' },
          };
        }
        // dynamic import local-bff（mirror readSceneGraph / infoReleaseHandlers 的 dynamic import 模式，
        // 避 shell 静态依赖 local-bff）。
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'scene_graph', graph, {
          source: 'agent',
          reason: '7.4 Director atomic-edit 自动落盘（非人决策，leader 调度）',
        });
        const sceneCount = graph.nodes.length;
        const edgeCount = graph.edges.length;
        const lineCount = graph.lines.length;
        return {
          title: 'scene_graph_update',
          output: `场景结构已生效（${sceneCount} 场、${edgeCount} 边、${lineCount} 线，已写入项目设定）。`,
          metadata: {
            ok: true,
            applied: true,
            // data 供 caller（write_chapter）刷新 initialArtifacts['scene_graph'] → draft-writer 消费新 graph 单轮闭环。
            // 区别于 infoReleaseHandlers DW-4（返 entryCount 无 data）：scene_graph caller 需 projected graph 做刷新。
            data: graph,
            sceneCount,
            edgeCount,
            lineCount,
          },
        };
      });
    } catch (err) {
      // onFieldEdited throws on locked field（用户锁 scene_graph 拒自动改）/ save failure / parse fail →
      // graceful（leader 记 warn 不破 chain，mirror promiseLedgerHandlers autoApply graceful）。
      // BMad CR-010：getLogger 结构化日志（含 sessionId/projectId 上下文），非 console.warn。
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        { err: reason, projectDir },
        '[scene_graph] autoApply landing failed',
      );
      return {
        title: 'scene_graph_update',
        output: `场景结构自动生效失败：${reason}。操作已产出但未落盘（链继续）。`,
      };
    }
  }

  // ── leader PatchReview 路径（默认，1.3 既有行为不变）：field_patch envelope → UI patch-review → syncField → onFieldEdited ──
  const result = await computeProjectedGraph(projectDir, actions);
  if (!result.ok) {
    return { title: 'scene_graph_update', output: result.message };
  }
  const projectedGraph = result.graph;

  const sceneCount = projectedGraph.nodes.length;
  const edgeCount = projectedGraph.edges.length;
  const lineCount = projectedGraph.lines.length;
  return {
    title: 'scene_graph_update',
    output: `场景结构更新已备好：${sceneCount} 场、${edgeCount} 边、${lineCount} 线。请在补丁面板审阅——确认后写入项目设定（审阅时会对暂存的结构跑校验）。`,
    metadata: {
      type: 'field_patch',
      field: 'scene_graph',
      action: 'set',
      data: projectedGraph,
    },
  };
};
