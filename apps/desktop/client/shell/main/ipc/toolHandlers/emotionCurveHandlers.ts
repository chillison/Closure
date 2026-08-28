/**
 * Story 5.2 EmotionCurve tool handlers（mirror infoReleaseHandlers.ts，ADR-3 / conclusions §3.1）。
 *
 * emotion_curve 是**目标轨** creative field（作者意图「打算怎么写」的情绪目标弧，Director per-scene 前向产生）。
 * 实际轨（写后抽实际情绪）在 worldStateHandlers 的 emotional axis（closure_world_state 派生，6.6）。两轨「计划 vs
 * 实际」由 5.3 verify-loop 比对、5.4 Reader-Audit 裁。
 *
 * Neither writes to disk directly（mirror infoReleaseHandlers / sceneGraphHandlers 创作字段写模式）：
 * - emotion_curve_read 返 project.yaml 的 emotion_curve（loadProject single source of truth），可按 sceneId 收窄 points。
 * - emotion_curve_update 收 bounded action enum（add_point / update_point / remove_point），经 applyEmotionCurveActions
 *   （纯代码 by-refId 投影）→ emotionCurveSchema revalidate → autoApply 双落盘：
 *   · autoApply=true（Director 自动 authoring，5.2 mirror 6.3 DW-4）：withProjectLock + onFieldEdited(source:'agent')
 *     直接落盘（返 applied metadata，非 field_patch）。
 *   · autoApply 缺省/false（leader PatchReview / 工作台手 authoring）：返 field_patch envelope（field:'emotion_curve',
 *     action:'set', data: fullCurve）→ UI patch-review → syncField → onFieldEdited(source:'user')。
 *
 * Trust-boundary defense（interface-contracts / data-flow spec）：LLM 输出经 emotionCurveActionSchema parse 后投影；
 * 投影再经 emotionCurveSchema revalidate。非法 action shape / 非法投影 surfaced 给 LLM 非持久化。corrupt-project
 * guard（mirror readInfoReleaseMap / sceneGraphReadHandler）：拒向 fresh empty curve 投影增量编辑——否则 action:'set'
 * 覆盖真实不可读数据（cross-field pollution）。
 *
 * Crosses processes via the UNIFIED `toolExecution` channel（remoteToolProxy → handleToolExecute → these handlers）。
 * NO dedicated IPC channel / preload / OrisonDesktopApi entry——同 scene_graph_* / query_story / info_release_*。
 *
 * Handlers NEVER throw on bad input（mirror worldStateHandlers / sceneGraph / infoReleaseHandlers「never throws」契约）：
 * malformed param / missing project / repo failure 降级为友好消息，agent runLoop turn 永不收 rejection。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：projector = 纯代码机械 by-refId（非语义裁判）；「这个情绪点该不该加 /
 * 情绪值合不合理」归 Director LLM 产 + Reader-Audit 5.4 裁。
 */
import type { ToolHandler } from './types';
import {
  applyEmotionCurveActions,
  emotionCurveActionSchema,
  emotionCurveSchema,
  type EmotionCurve,
  type EmotionCurveAction,
} from '@orison/shared-contracts';
import { withProjectLock } from '../../fs/projectWriteLock';

/**
 * readEmotionCurve result（mirror InfoReleaseReadResult）：区分 legit-empty vs corrupt，免 update handler 向 fresh
 * curve 投影致 action:'set' overwrite 真实（不可读）数据。
 * - `absent`：project 加载成功但无 emotion_curve 字段（新项目 / 字段从未写）。Fresh empty curve 是增量编辑的正确基底。
 * - `ok`：emotion_curve 字段存在且 schema-valid。
 * - `corrupt`：emotion_curve 字段存在但 schema-invalid，或 loadProject 返 null（整文档 corrupt/missing）。拒 staging。
 */
type EmotionCurveReadResult =
  | { status: 'absent'; curve: EmotionCurve }
  | { status: 'ok'; curve: EmotionCurve }
  | { status: 'corrupt'; reason: string };

/**
 * 读 emotion_curve（absent/ok/corrupt 三态，mirror readInfoReleaseMap）。
 *
 * ⚠ emotionCurveSchema.unit required（无 .default，5.1 schema）——absent 时 fresh empty curve 须显式给 unit:'scene'
 * （D-5.1-1：Director per-scene 产 → unit=scene），否则 parse 抛。
 */
async function readEmotionCurve(projectDir: string): Promise<EmotionCurveReadResult> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[emotion_curve] loadProject threw for ${projectDir}: ${reason}`);
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  // loadProject null = 整文档 corrupt/missing。不可当 absent-empty：update handler 会向 fresh curve 投影 →
  // action:'set' overwrite 真实（不可读）数据（cross-field pollution）。拒 + surface。
  if (doc === null) {
    return {
      status: 'corrupt',
      reason:
        '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存情绪目标弧的增量编辑',
    };
  }

  const raw = doc.emotion_curve;
  if (raw == null) {
    // legit empty：project 加载正常但无 emotion_curve 字段。fresh curve（unit:'scene'）是增量编辑正确基底。
    return { status: 'absent', curve: emotionCurveSchema.parse({ unit: 'scene' }) };
  }

  try {
    return { status: 'ok', curve: emotionCurveSchema.parse(raw) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[emotion_curve] emotion_curve field exists but is schema-invalid in ${projectDir}: ${reason}`,
    );
    return { status: 'corrupt', reason: `情绪目标弧字段数据校验失败：${reason}` };
  }
}

/** 非空 string 归一（undefined/null/空串/非 string → undefined）。 */
function optionalNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * emotion_curve_read：读 project.yaml emotion_curve.points，可按 sceneId（refId）收窄。
 * 读工具。Director（5.2）消费 existingEmotionCurve 经 write_chapter vars 传（非此工具，mirror 6.3）；本工具供
 * 工作台 / 未来直查用（6.1 先例 info_release_map_read）。永不抛。
 */
export const emotionCurveReadHandler: ToolHandler = async ({ params, projectDir }) => {
  const sceneId = optionalNonEmptyString(params.sceneId);

  const result = await readEmotionCurve(projectDir);
  if (result.status === 'corrupt') {
    return {
      title: 'emotion_curve_read',
      output: `情绪目标弧无法读取：${result.reason}`,
    };
  }
  // absent（项目无 emotion_curve 字段）→ 当空 points（additive：未填 = 空，非 corrupt）。
  let points = result.curve.points;
  if (sceneId) points = points.filter((p) => p.refId === sceneId);

  if (points.length === 0) {
    return {
      title: 'emotion_curve_read',
      output: sceneId
        ? `未找到匹配的情绪目标点（sceneId=${sceneId}）。`
        : '项目尚未填写情绪目标弧（emotion_curve 为空）。',
      metadata: { ok: true, count: 0, points: [] },
    };
  }
  return {
    title: `emotion_curve_read (${points.length})`,
    output: JSON.stringify({ points }, null, 2),
    metadata: { ok: true, count: points.length, points },
  };
};

/**
 * 投影 EmotionCurve actions 到当前 curve → schema-validated full curve（trust-boundary：parse → project → revalidate）。
 * read+project+validate 单源 helper，leader PatchReview 路径 + Director autoApply 路径共用。
 *
 * - corrupt on-disk curve（或整文档 corrupt）→ 拒（不投影到 fresh curve 致 action:'set' overwrite）。
 * - projected schema-invalid（projector drift / 坏 point）→ 拒（belt-and-suspenders，trust-boundary defense）。
 */
async function computeProjectedCurve(
  projectDir: string,
  actions: EmotionCurveAction[],
): Promise<{ ok: true; curve: EmotionCurve } | { ok: false; message: string }> {
  const readResult = await readEmotionCurve(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `情绪目标弧更新被拒：${readResult.reason}。请先在项目设定文件中修复或移除损坏的 emotion_curve，再重新提交增量编辑。`,
    };
  }
  const current = readResult.curve; // 'absent' -> fresh empty curve; 'ok' -> loaded curve

  const projected = applyEmotionCurveActions(current, actions);

  // Trust-boundary defense：revalidate 投影。applyEmotionCurveActions 纯机械 by-refId，但坏 point（如 add_point 带
  // 缺 refId 的 point 会在 actionSchema.parse 阶段已拒）。safeParse belt-and-suspenders + 防 projector drift。
  const validated = emotionCurveSchema.safeParse(projected);
  if (!validated.success) {
    return {
      ok: false,
      message: `情绪目标弧更新被拒：投影后的曲线数据校验失败（${validated.error.message}）。add/update 须携带完整目标点（refId 必填）。`,
    };
  }
  return { ok: true, curve: validated.data };
}

/**
 * emotion_curve_update：bounded action enum（add/update/remove point）→ 纯代码投影 full curve。**两种落盘模式**
 * （Story 5.2，mirror info_release_map_update DW-4 / promise_ledger_update A1 双落盘模式）：
 *
 * 1. **autoApply=true（Director 自动 authoring 落盘）**：Director 是 leader 侧子 agent（非人决策的自动 authoring），
 *    mirror 6.3 Director / 6.5 emergence autoApply + 6.6 world-state 自动写。handler **直接调** local-bff
 *    `onFieldEdited(source:'agent')` 写盘（version bump in field_metadata + markStaleFields + projectDocumentSchema.parse
 *    + saveProject），经 withProjectLock 串行化（防并发编辑丢更新）。返 `{ok, applied:true, pointCount}` metadata
 *    （非 field_patch envelope）。onFieldEdited throw（locked field / save fail）→ graceful error 返（Director 记
 *    writeError 不破 chain，mirror infoReleaseMapUpdateHandler autoApply graceful）。
 *
 * 2. **autoApply 缺省/false（leader PatchReview 路径，默认）**：返 `{type:'field_patch', field:'emotion_curve',
 *    action:'set', data: fullCurve}` envelope。field_patch → UI patch-review → syncField → onFieldEdited(source:'user')
 *    落盘。leader / 工作台手 authoring 走此路径。
 *
 * LLM 经此工具写 emotion_curve 情绪目标点（AC「LLM 写入并对它负责」，mirror 6.3）。**sync version**
 * （field_metadata[field].version）由 fieldSyncBridge.onFieldEdited 落盘时 bump（sync 真值）。emotion_curve 无 in-data
 * version/updatedBy 字段（mirror emotion_curve 简洁形态，区别于 info_release_map/promise_registry 带 version）。
 */
export const emotionCurveUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  const rawActions = (params as { actions?: unknown }).actions;
  const actionList = Array.isArray(rawActions) ? rawActions : [];
  // Story 5.2 DW-4：Director 调时传 autoApply:true → 自动落盘 creative field（绕开 PatchReview）。
  // leader / 工作台手 authoring 调缺省 false → field_patch envelope 走 UI patch-review。
  const autoApply = (params as { autoApply?: unknown }).autoApply === true;

  // Trust-boundary：逐 action 经 discriminated-union schema parse。非法 action shape surfaced 给 LLM（非静默丢/持久化坏 curve）。
  let actions: EmotionCurveAction[];
  try {
    actions = actionList.map((a) => emotionCurveActionSchema.parse(a));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'emotion_curve_update',
      output:
        `情绪目标弧更新被拒：操作格式无效（${reason}）。` +
        '可用操作为 add_point/update_point（携带完整目标点：refId 必填）/ remove_point（携带 refId）。',
    };
  }

  // ── autoApply 路径：Director 自动落盘（mirror infoReleaseMapUpdateHandler autoApply + 6.5 promiseLedgerHandlers）──
  // 经 withProjectLock 串行化 read-modify-write（read + project + onFieldEdited 一原子单元，防并发编辑丢更新）。
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeProjectedCurve(projectDir, actions);
        if (!result.ok) {
          return { title: 'emotion_curve_update', output: result.message };
        }
        const curve = result.curve;
        // dynamic import local-bff（mirror readEmotionCurve / infoReleaseMapUpdateHandler dynamic import 模式，
        // 避 shell 静态依赖 local-bff）。
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'emotion_curve', curve, {
          source: 'agent',
          reason: 'Director 自动 authoring（5.2，非人决策）',
        });
        return {
          title: 'emotion_curve_update',
          output: `情绪目标弧已生效（共 ${curve.points.length} 个目标点，已写入项目设定）。`,
          metadata: {
            ok: true,
            applied: true,
            pointCount: curve.points.length,
          },
        };
      });
    } catch (err) {
      // onFieldEdited throws on locked field（用户锁 emotion_curve 拒自动改）/ save failure / parse fail →
      // graceful（Director 记 writeError 不破 chain，mirror infoReleaseMapUpdateHandler autoApply graceful）。
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[emotion_curve] autoApply landing failed for ${projectDir}: ${reason}`);
      return {
        title: 'emotion_curve_update',
        output: `情绪目标弧自动生效失败：${reason}。Director 的操作已产出但未落盘（链继续）。`,
      };
    }
  }

  // ── leader PatchReview 路径（默认）：field_patch envelope → UI patch-review → syncField → onFieldEdited ──
  const result = await computeProjectedCurve(projectDir, actions);
  if (!result.ok) {
    return { title: 'emotion_curve_update', output: result.message };
  }
  const projectedCurve = result.curve;

  const pointCount = projectedCurve.points.length;
  return {
    title: 'emotion_curve_update',
    output: `情绪目标弧更新已备好：调整后共 ${pointCount} 个目标点。请在补丁面板审阅——确认后写入项目设定。`,
    metadata: {
      type: 'field_patch',
      field: 'emotion_curve',
      action: 'set',
      data: projectedCurve,
    },
  };
};
