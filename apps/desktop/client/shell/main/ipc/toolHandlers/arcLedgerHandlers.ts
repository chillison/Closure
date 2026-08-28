/**
 * Story 8.2 arc ledger tool handlers (design §2 / §5 / ADR-3).
 *
 * Mirrors promiseLedgerHandlers.ts (the creative-field bounded-write pattern) +
 * worldStateHandlers.ts (registry projectId resolution for the DERIVED summary
 * table). Neither write path touches disk directly:
 * - query_arc returns the curated arc_registry from project.yaml (parsed via
 *   local-bff loadProject — single source of truth, shell has no direct yaml
 *   dep), optional episodeId/arcRef filter + nearest-window cap
 *   (ARC_QUERY_BEAT_WINDOW=200 beats — million-word projects carry thousands of
 *   beats, the read side windows, design §7).
 * - arc_ledger_update receives a BOUNDED action enum (add_beat), projects the
 *   actions onto the current arc_registry via applyArcLedgerActions (pure code,
 *   shared-contracts arc-registry.ts), re-validates via arcRegistrySchema, and
 *   returns a `field_patch` metadata envelope with the full projected registry
 *   as `data` (action: 'set'). The UI surfaces the change in the patch-review
 *   flow; acceptance persists via syncField → fieldSyncBridge.onFieldEdited.
 *   autoApply=true (arc-emergence-node, mirror promise A1) bypasses PatchReview
 *   and lands directly via onFieldEdited(source:'agent') under withProjectLock.
 * - query_arc_summary reads closure_arc_summary (DERIVED arc-audit snapshots)
 *   via arcSummaryRepository, optional arcRef filter, default = latest row per
 *   arc (design §4). Never throws on bad rows — corrupt JSON is flagged
 *   corruptPayload (CR-E6 pattern).
 *
 * Trust-boundary defense (interface-contracts / data-flow spec): LLM output is
 * parsed via arcLedgerActionSchema before projection (close beats REQUIRE
 * grounding — enforced at the write schema, shared-contracts arc-registry.ts);
 * the projection is re-validated via arcRegistrySchema. corrupt-project guard
 * (mirror promiseLedgerHandlers): refuse to stage an incremental edit when the
 * on-disk field / whole project is corrupt — projecting onto a fresh empty
 * registry would `action:'set'`-overwrite real unreadable data.
 *
 * Read path uses DIRECT extraction + per-element safeParse (db-repository.md
 * Convention), NOT full-parent safeParse: arc_registry is LLM-authored with an
 * evolving beat shape — one bad beat entry is dropped (console.warn + keep the
 * good ones, mirror CR-4.1-07 / E5 per-element philosophy), it never renders
 * the whole field corrupt/unwritable. Envelope-level breakage (beats non-array)
 * IS corrupt — that is real unreadable data the update path must refuse.
 *
 * arc_registry is a creative field (project.yaml) — write-time LLM declarations
 * (advance/close beats), mirror promise_registry attribution. It is NOT a
 * closure_* derived table. Arc audit snapshots (ArcAuditResult) live in
 * closure_arc_summary (DERIVED), read via query_arc_summary.
 *
 * Crosses processes via the UNIFIED `toolExecution` channel (remoteToolProxy →
 * handleToolExecute → these handlers). NO dedicated IPC channel / preload /
 * OrisonDesktopApi entry — same unified-channel pattern as query_promise /
 * promise_ledger_update / query_world_*.
 *
 * Handlers NEVER throw on bad input (mirror promiseLedgerHandlers「never throws」
 * contract): a malformed param / missing project / repo failure degrades to a
 * friendly message so the agent runLoop turn never sees a rejection.
 *
 * version 注释（mirror promiseLedgerHandlers CR-O1）：in-data arc_registry.version/
 * updatedBy 是装饰字段——sync 真值是 field_metadata[field].version，由
 * fieldSyncBridge.onFieldEdited 落盘时 bump。projector 只管 beats（纯机械），不动
 * version/updatedBy（透传 current 的装饰值，落盘时 onFieldEdited 覆盖）。
 */
import path from 'node:path';
import {
  ARC_QUERY_BEAT_WINDOW,
  applyArcLedgerActions,
  arcLedgerActionSchema,
  arcRegistrySchema,
  arcBeatSchema,
  queryArcRequestSchema,
  queryArcSummaryRequestSchema,
  recordArcAuditRequestSchema,
  type ArcAuditResult,
  type ArcBeat,
  type ArcLedgerAction,
  type ArcRegistry,
} from '@orison/shared-contracts';
import { getProject } from '../../db/projectRepository';
import { listLatestArcSummaries, upsertArcSummary } from '../../db/arcSummaryRepository';
import { withProjectLock } from '../../fs/projectWriteLock';
import { getLogger } from '../../logger';
import type { ToolHandler } from './types';

/**
 * readArcRegistry result (mirror PromiseReadResult): distinguishes legit-empty
 * from corrupt so the update handler never projects onto a fresh registry and
 * `action:'set'` overwrites real (unreadable) data.
 * - `absent`: project loads but has no arc_registry field (new project / field
 *   never written — 8.2 全功能 dormant 直至写手开始登记, design §8). Fresh empty
 *   registry is the correct base for incremental edits (additive — arc_registry
 *   is optional in projectDocumentSchema).
 * - `ok`: arc_registry field present and envelope-readable (beats array parsed;
 *   individual bad beats already dropped per-element with a console.warn).
 * - `corrupt`: arc_registry field present but structurally broken (beats
 *   non-array), OR loadProject returned null (whole project document
 *   corrupt/missing). Refuse to stage.
 */
type ArcReadResult =
  | { status: 'absent'; registry: ArcRegistry }
  | { status: 'ok'; registry: ArcRegistry }
  | { status: 'corrupt'; reason: string };

async function readArcRegistry(projectDir: string): Promise<ArcReadResult> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    // loadProject normally catches + returns null; a throw here is unexpected.
    // Treat as corrupt so we don't silently overwrite via a fresh-registry projection.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[arc_registry] loadProject threw for ${projectDir}: ${reason}`);
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  // loadProject null = whole project document judged corrupt/missing. Must NOT
  // treat arc_registry as absent-empty here: the update handler would project
  // onto a fresh registry and `action:'set'` would overwrite real (unreadable)
  // data on the next save (cross-field pollution). Refuse + surface.
  if (doc === null) {
    return {
      status: 'corrupt',
      reason:
        '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存弧节拍台账的增量编辑',
    };
  }

  const raw = doc.arc_registry;
  if (raw == null) {
    // Legit empty: project loads fine but has no arc_registry field yet.
    return { status: 'absent', registry: arcRegistrySchema.parse({}) };
  }

  // Direct 抽取 + per-element safeParse（db-repository.md Convention，非 full parent safeParse）：
  // envelope 形态坏（beats 非 array）= corrupt（真实不可读数据，update 须拒）；单条坏 beat 丢弃保留
  // 好条目（LLM-authored 演进 shape，1 坏不丢全 registry，mirror CR-4.1-07 / E5）。version/updatedBy 是
  // 装饰字段（onFieldEdited 落盘 bump），tolerant fallback 不判 corrupt。
  if (!isPlainObject(raw)) {
    console.warn(`[arc_registry] arc_registry field is not an object in ${projectDir}`);
    return { status: 'corrupt', reason: 'arc_registry 字段不是对象' };
  }
  const rawBeats = (raw as Record<string, unknown>).beats;
  if (rawBeats != null && !Array.isArray(rawBeats)) {
    console.warn(`[arc_registry] arc_registry.beats is not an array in ${projectDir}`);
    return { status: 'corrupt', reason: 'arc_registry.beats 不是数组' };
  }
  const beats: ArcBeat[] = (Array.isArray(rawBeats) ? rawBeats : []).flatMap((b) => {
    const parsed = arcBeatSchema.safeParse(b);
    if (!parsed.success) {
      console.warn(`[arc_registry] dropping malformed arc beat in ${projectDir}: ${parsed.error.message}`);
      return [];
    }
    return [parsed.data];
  });
  const rawVersion = (raw as Record<string, unknown>).version;
  const rawUpdatedBy = (raw as Record<string, unknown>).updatedBy;
  const registry: ArcRegistry = {
    beats,
    version:
      typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion >= 0
        ? rawVersion
        : 0,
    updatedBy:
      rawUpdatedBy === 'user' || rawUpdatedBy === 'agent' || rawUpdatedBy === 'sync'
        ? rawUpdatedBy
        : 'agent',
  };
  return { status: 'ok', registry };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * query_arc：读 project.yaml arc_registry（写手声明的弧节拍），可按 episodeId/arcRef 收窄
 * （filter 命中的 beat 才返回）+ 最近窗 cap ARC_QUERY_BEAT_WINDOW(200) beats（百万字项目 beats
 * 数千条，读侧加窗防倾倒，design §7）。读工具。arc-emergence-node（避重复登记）/ 停滞检测 /
 * leader 消费。永不抛。
 */
export const queryArcHandler: ToolHandler = async ({ params, projectDir }) => {
  let episodeId: string | undefined;
  let arcRef: string | undefined;
  try {
    const parsed = queryArcRequestSchema.parse(params);
    episodeId = parsed.episodeId;
    arcRef = parsed.arcRef;
  } catch (err) {
    return {
      title: 'query_arc',
      output: `参数无效: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { ok: false, reason: 'invalid_params' },
    };
  }

  const result = await readArcRegistry(projectDir);
  if (result.status === 'corrupt') {
    return {
      title: 'query_arc',
      output: `弧节拍台账无法读取：${result.reason}`,
    };
  }
  // absent（项目无 arc_registry 字段）→ 当空 registry（additive：未填 = 空，非 corrupt）。
  let beats = result.registry.beats;

  if (episodeId !== undefined || arcRef !== undefined) {
    beats = beats.filter((b) => {
      if (episodeId !== undefined && b.episodeId !== episodeId) return false;
      if (arcRef !== undefined && b.arcRef !== arcRef) return false;
      return true;
    });
  }

  // 最近窗 cap：episodeIndex 升序稳定排（tie 保 registry 序）后取尾部 N 条 = 最近 N 条，
  // 呈现按时间正序（最早→最新）。超窗 truncated 标记（截断不静默，mirror truncated 哲学）。
  const sorted = beats.slice().sort((a, b) => a.episodeIndex - b.episodeIndex);
  const truncated = sorted.length > ARC_QUERY_BEAT_WINDOW;
  const windowed = truncated ? sorted.slice(sorted.length - ARC_QUERY_BEAT_WINDOW) : sorted;

  if (windowed.length === 0) {
    const filterDesc = [episodeId ? `episodeId=${episodeId}` : '', arcRef ? `arcRef=${arcRef}` : '']
      .filter(Boolean)
      .join(' / ');
    return {
      title: 'query_arc',
      output: filterDesc
        ? `未找到匹配的弧节拍（filter: ${filterDesc}）。`
        : '项目尚未登记弧节拍（arc_registry 为空——写完一章后写手经 arc_ledger_update 声明推进/闭合）。',
      metadata: { ok: true, beatCount: 0, beats: [], truncated: false },
    };
  }
  return {
    title: `query_arc (${windowed.length} beat(s)${truncated ? `，最近 ${ARC_QUERY_BEAT_WINDOW} 条` : ''})`,
    output: JSON.stringify({ beats: windowed }, null, 2),
    metadata: { ok: true, beatCount: windowed.length, beats: windowed, truncated },
  };
};

/**
 * 投影 ArcLedger actions 到当前 registry → schema-validated full registry（trust-boundary：parse →
 * project → re-validate）。read+project+validate 单源 helper，leader PatchReview 路径 + emergence
 * autoApply 路径共用（mirror computeProjectedRegistry）。
 *
 * - corrupt on-disk registry（或整文档 corrupt）→ 拒绝（不投影到 fresh registry 致 action:'set' overwrite）。
 * - projected schema-invalid（projector drift / 坏 entry）→ 拒绝（belt-and-suspenders）。
 */
async function computeProjectedRegistry(
  projectDir: string,
  actions: ArcLedgerAction[],
): Promise<{ ok: true; registry: ArcRegistry } | { ok: false; message: string }> {
  const readResult = await readArcRegistry(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `弧节拍更新被拒：${readResult.reason}。请先在项目设定文件中修复或移除损坏的 arc_registry，再重新提交增量编辑。`,
    };
  }
  const current = readResult.registry; // 'absent' -> fresh empty registry; 'ok' -> loaded registry

  const projected = applyArcLedgerActions(current, actions);

  // Trust-boundary defense: re-validate the projection (belt-and-suspenders +
  // guards against future projector drift, mirror computeProjectedRegistry).
  const validated = arcRegistrySchema.safeParse(projected);
  if (!validated.success) {
    return {
      ok: false,
      message: `弧节拍更新被拒：投影后的台账数据校验失败（${validated.error.message}）。节拍须完整（episodeId + episodeIndex + arcRef + arcKind + action；close 节拍须带正文引证）。`,
    };
  }
  return { ok: true, registry: validated.data };
}

/**
 * arc_ledger_update：bounded action（add_beat）→ 纯代码投影 full registry。**两种落盘模式**
 * （mirror promise_ledger_update A1 双档）：
 *
 * 1. **autoApply=true（emergence 自动落盘）**：arc-emergence-node 是自动链段节点（写手侧 LLM 写时
 *    声明，非人决策），mirror promise-emergence A1。handler **直接调** local-bff
 *    `onFieldEdited(source:'agent')` 写盘（version bump + markStaleFields + parse + saveProject），
 *    经 withProjectLock 串行化（防并发编辑丢更新）。返 `{ok, applied:true, beatCount}` metadata
 *    （非 field_patch envelope）。onFieldEdited throw（locked field / save fail）→ graceful error
 *    返（emergence 记 writeError 不破链）。
 *
 * 2. **autoApply 缺省/false（leader PatchReview 路径）**：返 `{type:'field_patch', field:'arc_registry',
 *    action:'set', data: fullRegistry}` envelope。field_patch → UI patch-review → syncField →
 *    onFieldEdited（source='user'）落盘 + version bump。leader / 用户 authoring 走此路径。
 */
export const arcLedgerUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  const rawActions = (params as { actions?: unknown }).actions;
  const actionList = Array.isArray(rawActions) ? rawActions : [];
  const autoApply = (params as { autoApply?: unknown }).autoApply === true;

  // Trust-boundary: parse each action through the discriminated-union schema
  // (close beats without grounding fail HERE — arcBeatWriteSchema superRefine).
  // An invalid action shape is surfaced to the LLM via the tool output rather
  // than silently dropping or persisting a malformed registry.
  let actions: ArcLedgerAction[];
  try {
    actions = actionList.map((a) => arcLedgerActionSchema.parse(a));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'arc_ledger_update',
      output:
        `弧节拍更新被拒：操作格式无效（${reason}）。` +
        '可用操作为 add_beat（beat 必填：episodeId + episodeIndex + arcRef + arcKind[volume|line|growth] + ' +
        'action[advance|close]；close 节拍须带正文引证；note 可选）。',
    };
  }

  // ── autoApply 路径：emergence 自动落盘（mirror promise A1，经 withProjectLock 串行化 read-modify-write）──
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeProjectedRegistry(projectDir, actions);
        if (!result.ok) {
          return { title: 'arc_ledger_update', output: result.message };
        }
        const registry = result.registry;
        // dynamic import local-bff（mirror readArcRegistry dynamic import 模式，避 shell 静态依赖）。
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'arc_registry', registry, {
          source: 'agent',
          reason: '弧节拍登记（arc-emergence 写时声明，自动落盘非人决策）',
        });
        return {
          title: 'arc_ledger_update',
          output: `弧节拍已生效（共 ${registry.beats.length} 条，已写入项目设定）。`,
          metadata: {
            ok: true,
            applied: true,
            beatCount: registry.beats.length,
          },
        };
      });
    } catch (err) {
      // onFieldEdited throws on locked field（用户锁 arc_registry 拒自动改）/ save failure / parse fail →
      // graceful（emergence node 记 writeError 不破 chain）。
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[arc_registry] autoApply landing failed for ${projectDir}: ${reason}`);
      return {
        title: 'arc_ledger_update',
        output: `弧节拍自动生效失败：${reason}。涌现登记的操作已产出但未落盘（链继续）。`,
      };
    }
  }

  // ── leader PatchReview 路径（默认）：field_patch envelope → UI patch-review → syncField ──
  const result = await computeProjectedRegistry(projectDir, actions);
  if (!result.ok) {
    return { title: 'arc_ledger_update', output: result.message };
  }
  const projectedRegistry = result.registry;
  return {
    title: 'arc_ledger_update',
    output: `弧节拍更新已备好：调整后共 ${projectedRegistry.beats.length} 条。请在补丁面板审阅——确认后写入项目设定。`,
    metadata: {
      type: 'field_patch',
      field: 'arc_registry',
      action: 'set',
      data: projectedRegistry,
    },
  };
};

/**
 * query_arc_summary：读物化弧审快照（closure_arc_summary，DERIVED——arc-audit-agent 大审/停滞专注审
 * 产物）。收窄 arcRef（缺省 = 每弧最新一行，含 closure/stagnation 两 kind 并列，design §4「查询侧取
 * 最新」）。读工具。write_chapter chain-start 反哺（fetchLatestArcAudit）/ 4.4 arcSnapshot / leader 消费。
 * 永不抛；坏 JSON 行 corruptPayload 标记（CR-E6），不喂下游坏数据。
 */
export const queryArcSummaryHandler: ToolHandler = async ({ params, projectDir }) => {
  let arcRef: string | undefined;
  try {
    arcRef = queryArcSummaryRequestSchema.parse(params).arcRef;
  } catch (err) {
    return {
      title: 'query_arc_summary',
      output: `参数无效: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { ok: false, reason: 'invalid_params' },
    };
  }

  // projectId 从 projectDir 解析（mirror query_chapter_summary / query_world_*，5 位 registry id）。
  const projectId = getProject(path.resolve(projectDir))?.projectId ?? null;
  if (!projectId) {
    return {
      title: 'query_arc_summary',
      output: '当前项目未注册到数据库，无法读取弧审摘要。',
      metadata: { ok: false, reason: 'project_not_registered' },
    };
  }

  try {
    const summaries = listLatestArcSummaries(projectId, arcRef);
    if (summaries.length === 0) {
      return {
        title: 'query_arc_summary',
        output: arcRef
          ? `弧「${arcRef}」尚无已物化的弧审摘要（卷弧闭合大审 / 停滞专注审触发后落 closure_arc_summary）。`
          : '项目尚无已物化的弧审摘要（卷弧闭合大审 / 停滞专注审触发后落 closure_arc_summary）。',
        metadata: { ok: true, count: 0, summaries: [] },
      };
    }
    const lines = summaries.map((r) => {
      const flags = [
        r.corruptPayload === true ? '⚠ result JSON 损坏' : '',
        r.result?.degraded === true ? '⚠ degraded（大审 parse 失败，findings 空非真无发现）' : '',
      ]
        .filter(Boolean)
        .join('，');
      const findingsCount = r.corruptPayload ? '?' : String(r.result?.findings.length ?? 0);
      return (
        `- ${r.arcRef}〔${r.arcKind}/${r.auditKind}〕span #${r.fromEpisodeIndex}-#${r.toEpisodeIndex}` +
        ` — findings ${findingsCount}（≈${r.tokenEstimate} tokens${flags ? `；${flags}` : ''}）`
      );
    });
    return {
      title: `query_arc_summary (${summaries.length})`,
      output: `## 弧审摘要\n${lines.join('\n')}`,
      metadata: { ok: true, count: summaries.length, summaries },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId }, 'query_arc_summary failed');
    return {
      title: 'query_arc_summary',
      output: `弧审摘要查询失败: ${msg}`,
      metadata: { ok: false, reason: 'list_failed', error: msg },
    };
  }
}

/**
 * record_arc_audit：arc-audit-agent 产物（ArcAuditResult）upsert closure_arc_summary DERIVED 表（Story 8.2
 * Step 4，write_chapter post-settle 程序化调用——关口大审/停滞专注审收尾，非 LLM 直接调）。autoApply 语义
 * （无人审：DERIVED 快照可 drop 重跑重建，mirror materialize_chapter_summary 链内写工具定位）。
 *
 * Trust-boundary：recordArcAuditRequestSchema parse（result 内嵌 arcAuditResultSchema 校验）+ 机械字段
 * 一致性 belt（result.arcKind 与 auditKind 匹配——closure 审 = volume 弧 / stagnation 审 = line | growth 弧
 * 〔终审 F2 修：growth 停滞弧诚实标注，不再错标 line〕。不一致拒收防 caller 混列）。tokenEstimate 机械估算
 * （JSON 长度 / 4，mirror closure_chapter_summary 观测口径）。永不抛（mirror 上三 handler never-throws 契约）。
 */
export const recordArcAuditHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: { auditKind: 'closure' | 'stagnation'; result: ArcAuditResult };
  try {
    parsed = recordArcAuditRequestSchema.parse(params);
  } catch (err) {
    return {
      title: 'record_arc_audit',
      output: `参数无效: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { ok: false, reason: 'invalid_params' },
    };
  }
  const { auditKind, result } = parsed;

  // 机械字段 belt：arcKind 与 auditKind 匹配（closure 审 = volume 弧 / stagnation 审 = line|growth 弧）。
  if (
    (auditKind === 'closure' && result.arcKind !== 'volume') ||
    (auditKind === 'stagnation' && result.arcKind !== 'line' && result.arcKind !== 'growth')
  ) {
    return {
      title: 'record_arc_audit',
      output: `弧审记录被拒：auditKind=${auditKind} 与 result.arcKind=${result.arcKind} 不匹配（closure 审对应 volume 弧 / stagnation 审对应 line|growth 弧）。`,
      metadata: { ok: false, reason: 'kind_mismatch' },
    };
  }

  const projectId = getProject(path.resolve(projectDir))?.projectId ?? null;
  if (!projectId) {
    return {
      title: 'record_arc_audit',
      output: '当前项目未注册到数据库，无法记录弧审摘要。',
      metadata: { ok: false, reason: 'project_not_registered' },
    };
  }

  try {
    // 观测 token 估算（机械：JSON 字符长度 / 4 中文混合粗估，mirror 8.1 token_estimate 观测口径）。
    const tokenEstimate = Math.ceil(JSON.stringify(result).length / 4);
    upsertArcSummary(projectId, {
      arcRef: result.arcRef,
      arcKind: result.arcKind,
      auditKind,
      fromEpisodeIndex: result.span.fromEpisodeIndex,
      toEpisodeIndex: result.span.toEpisodeIndex,
      result,
      tokenEstimate,
    });
    return {
      title: 'record_arc_audit',
      output: `弧审摘要已记录（${result.arcRef}〔${result.arcKind}/${auditKind}〕span #${result.span.fromEpisodeIndex}-#${result.span.toEpisodeIndex}，findings ${result.findings.length}${result.degraded ? '，degraded' : ''}）。`,
      metadata: { ok: true, arcRef: result.arcRef, auditKind, findingsCount: result.findings.length },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId, arcRef: result.arcRef }, 'record_arc_audit failed');
    return {
      title: 'record_arc_audit',
      output: `弧审摘要记录失败: ${msg}`,
      metadata: { ok: false, reason: 'upsert_failed', error: msg },
    };
  }
};
