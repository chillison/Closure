import {
  BUILD_WORLD_SNAPSHOT_ATS_MAX,
  buildWorldStateSnapshot,
  buildCognitionSnapshot,
  buildPresenceSignal,
  type CognitionSnapshot,
  type PresenceSignal,
  type WorldPatch,
  type WorldStateSnapshot,
} from '@orison/shared-contracts';
import { registry } from '../tool/registry';
import type { ToolDefinition } from '../types';
import { logger } from '../logger';

// ── Story 6.6 Phase D：world-state 查询 helper（消费端反哺用，经 registry builtin 工具）──
//
// brief-compiler #6 stateAtT（per scene）+ Reader-Audit world_state_snapshot 基底（chapter-level）共用此
// fetch 路径。经 registry builtin（remoteToolProxy → toolExecution IPC → shell worldStateHandlers），非直接
// db（agent 包无 db 访问；mirror write_world_events WorldWriter 模式，chapter-chain.ts 注入）。
//
// ── Story 8.1 Step 5：4 helper 切 checkpoint-backed（design §6 Q4 定案，等价重构）──
//
// - state 投影（brief #6 批量 ats / Reader-Audit 基底单点）：走 `build_world_snapshot` builtin——shell 侧
//   checkpoint-seeded fold（buildWorldSnapshotCheckpointed），**IPC 传 snapshot 非全量 patches**（传输从
//   O(总 patches) 降为 O(snapshot)，百万字规模有界化，conclusions §3.1）。
// - cognition / presence 投影：走 `build_world_snapshot {projection}`——shell 侧 listWorldPatches 全量取回
//   in-process 投影（免跨进程传全集；per-character checkpoint 化 defer 8.3，design §7）。
// - `fetchWorldPatchesViaTool` **保留不删**：① build_world_snapshot 未注册时的 graceful fallback（旧 shell /
//   既有测试只 mock query_world_slice——签名与语义零变）；② 全 patches 消费者主路径（emotion-verify-node /
//   promise-emergence-node 需 patch 全集，snapshot 投影不适用）；③ Step 7 观测对照（全 fold 基线）。
//
// 范式判据（ADR-3）：fetch = 副作用（IPC 调用，读 db）；reduce/投影 = 纯代码（shell 侧 checkpointed fold
// 或 fallback 路径的 shared-contracts 纯函数）。本文件只做「取」（副作用）+「形态归一」（subjects 空 →
// undefined），不判语义。
//
// graceful 契约（逐字保持，caller 既有降级路径零改）：
// - build_world_snapshot **未注册**（测试环境 registry 空 / 旧 shell）→ 走 fetchWorldPatchesViaTool 旧路径
//   （该工具也未注册 → undefined）。**已注册但调用失败（IPC 抛 / ok:false 结构化 miss）→ undefined**，不再
//   二次尝试旧路径（失败场景双倍 IPC 无益；ok:false 如 project 未注册，旧路径同样 undefined）。
// - 无数据（该 at 前 subjects 空 / 无 cognitive patches / 无 presence 信号）→ undefined（首章 / 早期 storyTime，
//   不造假）。
//
// ⚠️ 不动 settings_context / pinned context（route A，状态反哺只走 brief #6 + Reader-Audit 基底）。
//
// expected_downstream_consumers:
// - brief-compiler-node.compilePlotPoints：fetchWorldStateSnapshotsViaTool 一次批量 IPC 得本章各场 snapshot
//   → 按场 storyTime 贴回 plotPoints[].stateAtT（同 storyTime 场共享同一 snapshot）。
// - write_chapter tool / closureChainIpc（shell 直调 worldStateRepository）：fetchWorldStateSnapshotViaTool
//   → initialArtifacts['world_state_snapshot'] → Reader-Audit buildPrompt worldStateContext var。
// - write_chapter tool：fetchCognitionSnapshotViaTool / fetchPresenceSignalViaTool → cognition_snapshot /
//   presence_signal artifacts（6.2 / 6.4 数据源）。
// - emotion-verify-node / promise-emergence-node：fetchWorldPatchesViaTool（patch 全集，非 snapshot）。

/**
 * 经 query_world_slice builtin 工具取项目全部 patches（含 storyTime 反范式字段，供 reduce 排序/截断）。
 *
 * 单次 IPC 取项目全集 slices（withPatches:true），展平成 WorldPatch[]。reduce 端（buildWorldStateSnapshot /
 * reduceSubject）自行 filter at 截断——调用方无须预过滤 storyTime（一次取 + 多次本地 reduce，DRY + 控 IPC）。
 *
 * Story 8.1 Step 5 后定位（保留不删）：build_world_snapshot 未注册时的 fallback + 全 patches 消费者主路径
 * （emotion-verify-node / promise-emergence-node）+ Step 7 观测对照基线。
 *
 * @param projectPath  项目路径（handler 从此解析 projectId，mirror query_story）。
 * @returns            全部 patches（空数组 = 项目无 events；undefined = 工具未注册/调用失败）。
 */
export async function fetchWorldPatchesViaTool(projectPath: string): Promise<WorldPatch[] | undefined> {
  const tool = registry.get('query_world_slice');
  if (!tool) {
    // 测试环境 registry 空 / 未 registerBuiltinTools → graceful undefined（caller 据此降级，不造假）。
    return undefined;
  }
  try {
    const result = await tool.execute(
      // 全集取：无 subjectIds/type/at 过滤，withPatches:true 附 patches（reduce 端 filter at 截断）。
      { withPatches: true },
      {
        // query_world_slice handler 仅用 projectDir（resolveProjectId），sessionId 走 toolExecution 通道不读；
        // 节点无 sessionId（chain node 不持 session 引用），传 runId/空串 placeholder（handler 忽略）。
        sessionId: '',
        projectPath,
        abort: new AbortController().signal,
      },
    );
    const slices = (result.metadata as { slices?: unknown } | undefined)?.slices;
    if (!Array.isArray(slices)) return undefined;
    const patches: WorldPatch[] = [];
    for (const s of slices) {
      if (!s || typeof s !== 'object') continue;
      const slicePatches = (s as { patches?: unknown }).patches;
      if (!Array.isArray(slicePatches)) continue;
      for (const p of slicePatches) {
        // 逐条校验最小 shape（CR-5：storyTime/op/axis/source/subjectId/path 类型齐才可用于 reduce；
        // 坏条目丢弃——缺 op 的 patch 进 reduceSubject 会走 default invalid-op，与其事后 issue 不如入口丢弃）。
        if (
          p &&
          typeof p === 'object' &&
          typeof (p as { storyTime?: unknown }).storyTime === 'number' &&
          typeof (p as { subjectId?: unknown }).subjectId === 'string' &&
          typeof (p as { path?: unknown }).path === 'string' &&
          typeof (p as { op?: unknown }).op === 'string' &&
          typeof (p as { axis?: unknown }).axis === 'string' &&
          typeof (p as { source?: unknown }).source === 'string'
        ) {
          patches.push(p as WorldPatch);
        }
      }
    }
    return patches;
  } catch (err) {
    // IPC 失败 / project 未注册 / handler 抛 → graceful undefined（caller 降级，不崩链）。
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'fetchWorldPatchesViaTool: query_world_slice failed → graceful undefined',
    );
    return undefined;
  }
}

// ── Story 8.1 Step 5：build_world_snapshot 工具路径共用内部 helper ──

/** tool.execute 共用 ctx（mirror fetchWorldPatchesViaTool：sessionId 空串 placeholder，handler 只读 projectDir）。 */
function makeToolContext(projectPath: string) {
  return {
    sessionId: '',
    projectPath,
    abort: new AbortController().signal,
  };
}

/**
 * 执行 build_world_snapshot 并取 metadata。**已注册但失败 → undefined（不再 fallback 旧路径）**：
 * 抛错（IPC 失败）/ ok:false（handler never-throw 结构化 miss：invalid_params / project_not_registered /
 * repo 抛 friendly error）/ metadata 坏形态 → undefined（graceful，caller 降级，不造假、不崩链）。
 */
async function executeBuildWorldSnapshotTool(
  tool: ToolDefinition,
  projectPath: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await tool.execute(params, makeToolContext(projectPath));
    const meta = (result as { metadata?: unknown } | undefined)?.metadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
    if ((meta as { ok?: unknown }).ok !== true) {
      const reason = (meta as { reason?: unknown }).reason;
      logger.warn(
        { projectPath, reason: typeof reason === 'string' ? reason : 'unknown' },
        'build_world_snapshot ok:false → graceful undefined',
      );
      return undefined;
    }
    return meta as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'build_world_snapshot execute failed → graceful undefined',
    );
    return undefined;
  }
}

/** WorldStateSnapshot 最小形态守卫（IPC 边界防御，mirror CR-5 逐条守性哲学）。 */
function isWorldStateSnapshotShape(v: unknown): v is WorldStateSnapshot {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as WorldStateSnapshot).subjects)
  );
}

/** CognitionSnapshot 最小形态守卫（handler 空数据形态 snapshot:null → 不命中 → undefined；空 characters
 *  同 undefined——buildCognitionSnapshot 纯函数从不产空 characters，防御上游形态漂移）。 */
function isCognitionSnapshotShape(v: unknown): v is CognitionSnapshot {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as CognitionSnapshot).characters) &&
    (v as CognitionSnapshot).characters.length > 0
  );
}

/**
 * PresenceSignal 逐元素形态守卫（CR-9，8.1 修复批；mirror CR-5 逐条守性哲学——与 state/cognition 两
 * 兄弟路径的守卫族对齐）：IPC 边界坏元素丢弃（缺关键标量字段的条目进 Reader-Audit info-gap 消费端
 * 只会 undefined 崩读或假数据），好元素保留；全坏 / 空 → undefined。
 */
function isPresenceSignalShape(v: unknown): v is PresenceSignal {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as PresenceSignal).characterSubjectId === 'string' &&
    typeof (v as PresenceSignal).factPath === 'string' &&
    typeof (v as PresenceSignal).evidenceSceneId === 'string' &&
    typeof (v as PresenceSignal).presenceSceneId === 'string' &&
    typeof (v as PresenceSignal).storyTime === 'number'
  );
}

/**
 * 经 build_world_snapshot builtin **批量**取 state 投影 snapshots（Story 8.1 Step 5 新增，brief #6 主路径）。
 *
 * 一次 IPC `{ats, projection:'state'}` 得 per-at snapshot 数组——shell 侧 checkpoint-backed fold，只传
 * snapshot 不传 patches（design §6）。ats 超 `BUILD_WORLD_SNAPSHOT_ATS_MAX`(32) 自动分批（chapter 场数 >
 * 32 唯一 storyTime 时多次 IPC，语义等价——单请求超限被 schema 拒 = 全 undefined，非等价）。
 *
 * 逐项归一（mirror 旧 compileSceneStateAtT 语义）：某 at subjects 空（该 storyTime 前无 populated 状态）→
 * 该项 undefined；调用方（brief-compiler）按 storyTime 贴回，undefined 项 → stateAtT undefined。
 *
 * graceful：工具未注册 → **fallback 旧路径**（fetchWorldPatchesViaTool 全集 + 本地 buildWorldStateSnapshot
 * fold——与 8.1 前行为逐字一致，既有测试零改）；已注册但失败（抛 / ok:false）→ 整体 undefined。
 *
 * @param projectPath  项目路径。
 * @param ats          storyTime 截断点数组（去重由 caller 负责——同 storyTime 场共享同 snapshot）。
 * @param opts         subjectCap / attrs（透传 handler → buildWorldSnapshotCheckpointed，同旧 opts 语义）。
 * @returns            与 ats 等长对齐的数组（项 = snapshot | undefined）；undefined = 工具不可用/失败/无数据
 *                     （整体降级，caller 全部 stateAtT undefined）。
 */
export async function fetchWorldStateSnapshotsViaTool(
  projectPath: string,
  ats: number[],
  opts?: { subjectCap?: number; attrs?: string[] },
): Promise<(WorldStateSnapshot | undefined)[] | undefined> {
  if (ats.length === 0) return [];

  const tool = registry.get('build_world_snapshot');
  if (!tool) {
    // fallback：旧路径（fetchWorldPatchesViaTool 全集 + 本地纯函数 fold）——build_world_snapshot 未注册
    // （旧 shell / 既有测试只 mock query_world_slice）。输出语义与 8.1 前逐字一致（等价性测试右侧锚）。
    const patches = await fetchWorldPatchesViaTool(projectPath);
    if (!patches || patches.length === 0) return undefined;
    return ats.map((at) => {
      const snapshot = buildWorldStateSnapshot(patches, at, opts ?? {});
      return snapshot.subjects.length > 0 ? snapshot : undefined;
    });
  }

  const out: (WorldStateSnapshot | undefined)[] = [];
  for (let i = 0; i < ats.length; i += BUILD_WORLD_SNAPSHOT_ATS_MAX) {
    const chunk = ats.slice(i, i + BUILD_WORLD_SNAPSHOT_ATS_MAX);
    const meta = await executeBuildWorldSnapshotTool(tool, projectPath, {
      ats: chunk,
      projection: 'state',
      ...(opts?.subjectCap !== undefined ? { subjectCap: opts.subjectCap } : {}),
      ...(opts?.attrs !== undefined ? { attrs: opts.attrs } : {}),
    });
    // 任一批失败（抛 / ok:false）→ 整体 undefined（graceful 契约——与旧路径「取数失败 → worldPatches
    // undefined → stateAtT 全 undefined」消费面等价，且不静默吞半批）。
    if (meta === undefined) return undefined;
    const snapshots = Array.isArray(meta.snapshots) ? meta.snapshots : [];
    // 与 chunk 等长对齐（metadata 形态异常时缺项 → undefined，不崩批、不错位）。
    for (let j = 0; j < chunk.length; j++) {
      const s = snapshots[j];
      out.push(isWorldStateSnapshotShape(s) && s.subjects.length > 0 ? s : undefined);
    }
  }
  return out;
}

/**
 * 经 build_world_snapshot builtin 取 state 投影 snapshot（Reader-Audit 一致基底用，单点）。
 *
 * 调用方：write_chapter tool（agent 入口，chain 前取 snapshot 注入 initialArtifacts）。snapshot 在 chain
 * 启动前捕获——此时 closure_world_state 仅含**前章** events（本章提取器尚未跑），故 snapshot 自然反映
 * 「已建立状态」基底（无本章 draft 的循环自证，落地公理）。
 *
 * Story 8.1 Step 5：内部切 `build_world_snapshot {at, projection:'state'}`（shell checkpoint-backed fold）；
 * **签名与返回契约零变**（caller write_chapter.ts 零改）。工具未注册 → fallback 旧路径（全集 + 本地 fold）。
 *
 * @param projectPath  项目路径。
 * @param at           storyTime 截断点（通常 undefined = 全部前章状态；或本章首场 storyTime-1 严格 prior）。
 * @param opts         subjectCap / attrs（透传 handler，同旧 buildWorldStateSnapshot opts）。
 * @returns            snapshot（subjects 非空）；undefined = 工具未注册/失败/无数据（graceful）。
 */
export async function fetchWorldStateSnapshotViaTool(
  projectPath: string,
  at?: number,
  opts?: { subjectCap?: number; attrs?: string[] },
): Promise<WorldStateSnapshot | undefined> {
  const tool = registry.get('build_world_snapshot');
  if (tool) {
    const meta = await executeBuildWorldSnapshotTool(tool, projectPath, {
      projection: 'state',
      ...(at !== undefined ? { at } : {}),
      ...(opts?.subjectCap !== undefined ? { subjectCap: opts.subjectCap } : {}),
      ...(opts?.attrs !== undefined ? { attrs: opts.attrs } : {}),
    });
    if (meta !== undefined) {
      const snapshots = Array.isArray(meta.snapshots) ? meta.snapshots : [];
      const snap = snapshots[0];
      // subjects 空（at 截断点无 populated 状态）→ undefined（caller 据此不注入 artifact，Reader-Audit graceful）。
      if (isWorldStateSnapshotShape(snap) && snap.subjects.length > 0) return snap;
    }
    return undefined;
  }

  // fallback：旧路径（签名与返回契约零变——8.1 前行为的逐字保留）。
  const patches = await fetchWorldPatchesViaTool(projectPath);
  if (!patches || patches.length === 0) return undefined;
  const snapshot = buildWorldStateSnapshot(patches, at, opts ?? {});
  if (snapshot.subjects.length === 0) return undefined;
  return snapshot;
}

// ── Story 6.2：cognition_snapshot 查询 helper（Reader-Audit 认知状态机维数据源，mirror world-state snapshot）──
//
// Reader-Audit 落地检查（KNOWLEDGE_VIOLATION / FORGOTTEN_REVEAL）的数据源。6.2 原路径 = fetchWorldPatchesViaTool
// （经 query_world_slice builtin 取全集 patches）→ buildCognitionSnapshot（shared-contracts 纯函数：filter
// cognitive + per-character reduceSubject + projectBeliefStatus 投影）。非 6.1 `query_cognition_graph`
// （per-scene 物化 builtin）——本路径需全集 patches 做 BeliefStatus 投影，故选全量取回。
//
// **Story 8.1 Step 5**：主路径切 `build_world_snapshot {projection:'cognition'}`——shell 侧 listWorldPatches
// 全量取回 in-process 投影（免跨进程传全集，design §6；per-character checkpoint 化 defer 8.3 §7）。
// **签名与返回契约零变**。工具未注册 → fallback 旧路径（全集 + 本地纯函数投影）。
//
// 范式判据（ADR-3）：fetch = 副作用（IPC 调用，读 db）；projectBeliefStatus 投影 = 纯代码（结构 key→status
// 映射，无语义裁判）；违规「是否真表现知情」归 L2（Reader-Audit buildPrompt cognitionContext 段）。
//
// graceful（逐字保持）：
// - 工具全未注册（测试环境 registry 空 / 未 registerBuiltinTools）→ undefined（Reader-Audit cognitionContext 空段）。
// - 工具调用抛错（IPC 失败 / project 未注册 / handler 抛）→ undefined（不造假、不崩链）。
// - 无 cognitive patches / 全角色空认知 → undefined（首章 / 前章无认知提取，不造假）。
//
// ⚠️ 不在 Reader-Audit requiredArtifactKeys（optional 消费，mirror world_state_snapshot/promise_registry 哲学）。
//
// expected_downstream_consumers:
// - write_chapter tool（agent 入口）：chain 启动前取 cognition_snapshot 注入 initialArtifacts['cognition_snapshot']
//   → Reader-Audit buildPrompt cognitionContext var。

/**
 * 经 build_world_snapshot {projection:'cognition'} 取 CognitionSnapshot（Reader-Audit 认知状态机维数据源）。
 *
 * 调用方：write_chapter tool（agent 入口，chain 前取 cognition_snapshot 注入 initialArtifacts）。snapshot 在 chain
 * 启动前捕获——此时 closure_world_state 仅含**前章** events（本章认知提取器在 draft 后跑），故 snapshot 自然反映
 * 「截至本章前的角色认知状态」（前章累积 believes_true 等），L2 对照本章 draft 判 FORGOTTEN_REVEAL 无循环自证。
 *
 * @param projectPath  项目路径。
 * @returns            cognition snapshot（characters 非空）；undefined = 工具未注册/失败/无 cognitive patches（graceful）。
 */
export async function fetchCognitionSnapshotViaTool(
  projectPath: string,
): Promise<CognitionSnapshot | undefined> {
  // CR-004：try/catch 兜底 mirror IPC 路径 fetchCognitionSnapshotForIpc 容错韧性——fetch 内部已 graceful，但
  // buildCognitionSnapshot→reduceSubject 在畸形 patch 上理论可抛；agent 路径无兜底会从 writeChapterTool
  // 顶层传播中断写章链，违注释承诺「不崩链」。
  try {
    const tool = registry.get('build_world_snapshot');
    if (tool) {
      const meta = await executeBuildWorldSnapshotTool(tool, projectPath, { projection: 'cognition' });
      // handler 空数据形态 {ok:true, snapshot:null} → undefined（不注入，Reader-Audit 降级空段）。
      if (meta !== undefined && isCognitionSnapshotShape(meta.snapshot)) {
        return meta.snapshot;
      }
      return undefined;
    }
    // fallback：旧路径（8.1 前行为的逐字保留——全集 patches + 本地纯函数投影）。
    const patches = await fetchWorldPatchesViaTool(projectPath);
    if (!patches || patches.length === 0) return undefined;
    return buildCognitionSnapshot(patches);
  } catch (err) {
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'fetchCognitionSnapshotViaTool: cognition snapshot build failed → graceful undefined',
    );
    return undefined;
  }
}

// ── Story 6.4 D1（6.2 DW-1）：presence_signal 查询 helper（在场性预筛信号，mirror cognition_snapshot）──
//
// Reader-Audit info-gap 维在场性预筛的数据源。buildPresenceSignal（shared-contracts 纯函数：filter cognitive
// with evidenceSceneId + reduce physical presence_scene → 比对产「A 表现知情但不在 fact 揭露场」信号）。
//
// **Story 8.1 Step 5**：主路径切 `build_world_snapshot {projection:'presence'}`（shell 侧 in-process 投影，
// mirror cognition）；**签名与返回契约零变**。工具未注册 → fallback 旧路径。
//
// graceful：工具未注册/失败/无 evidenceSceneId cognitive/无 physical presence → undefined（不注入，info-gap
// 降级为 6.2 既有纯语义判路径，零回归）。范式判据：reduce + 结构比对纯代码；违规裁判归 L2。

/**
 * 经 build_world_snapshot {projection:'presence'} 取在场性预筛信号（Reader-Audit info-gap 在场预筛数据源）。
 *
 * 调用方：write_chapter tool（chain 前取 presence_signal 注入 initialArtifacts['presence_signal']）。
 *
 * @param projectPath  项目路径。
 * @returns            信号列表（非空）；undefined = 工具未注册/失败/无可疑信号（graceful，不注入）。
 */
export async function fetchPresenceSignalViaTool(
  projectPath: string,
): Promise<PresenceSignal[] | undefined> {
  try {
    const tool = registry.get('build_world_snapshot');
    if (tool) {
      const meta = await executeBuildWorldSnapshotTool(tool, projectPath, { projection: 'presence' });
      if (meta !== undefined) {
        // CR-9：逐元素守卫（mirror cognition 守卫族）——坏元素丢弃好元素保留；全坏/空 → undefined。
        const signals = (Array.isArray(meta.signals) ? meta.signals : []).filter(isPresenceSignalShape);
        return signals.length > 0 ? signals : undefined;
      }
      return undefined;
    }
    // fallback：旧路径（8.1 前行为的逐字保留）。
    const patches = await fetchWorldPatchesViaTool(projectPath);
    if (!patches || patches.length === 0) return undefined;
    const signals = buildPresenceSignal(patches);
    return signals.length > 0 ? signals : undefined;
  } catch (err) {
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'fetchPresenceSignalViaTool: presence signal build failed → graceful undefined',
    );
    return undefined;
  }
}
