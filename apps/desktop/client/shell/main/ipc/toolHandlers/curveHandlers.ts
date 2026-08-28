/**
 * Story 8.5 R1 curve tool handlers — growth_curve_update / pacing_curve_update
 * （mirror emotionCurveHandlers.ts / assetCardsHandlers.ts，ADR-3 / design §2.1）。
 *
 * growth_curve / pacing_curve 是**设计轨** creative field（作者意图的目标弧，8.5 前生产端断线——
 * 唯一生产入口 = leader 对话引导段（Step 7）经本工具 bounded action 写入）。
 * 弧内容（角色缺什么/想要什么/转折点设计）= LLM 语义创作判断；投影/落盘 = 纯代码机械（ADR-3）。
 *
 * Neither writes to disk directly（mirror emotionCurveHandlers 创作字段写模式）：
 * - growth_curve_update 收 bounded action enum（add_curve / update_curve / remove_curve，by character_id
 *   自然键），经 applyGrowthCurveActions（纯代码投影，add 已存在 = partial merge 防 defaults 覆盖 B1）
 *   → growthCurveFieldSchema revalidate（array canonical，D2——宽容读旧单条/Record 归一为 array）
 *   → autoApply 双落盘：
 *   · autoApply=true（auto 档 leader 自动 authoring，KD1 复用档位）：withProjectLock +
 *     onFieldEdited(source:'agent') 直接落盘（返 applied metadata，非 field_patch）。
 *   · autoApply 缺省/false（suggest 档 leader PatchReview 路径，默认）：返 field_patch envelope
 *     （field:'growth_curve', action:'set', data: fullCurves）→ UI patch-review → syncField →
 *     onFieldEdited(source:'user')。
 * - pacing_curve_update 收 bounded action enum（add_point / update_point / remove_point，by refId），
 *   经 applyPacingCurveActions 投影 → pacingCurveSchema revalidate → autoApply 双落盘（逐字段 mirror
 *   emotion_curve_update——同为 refId+points 扁平曲线；pacing_curve 顶层维持单条，design §2.1）。
 *
 * Trust-boundary defense（interface-contracts / data-flow spec）：LLM 输出经 action schema parse 后投影；
 * 投影再经 field schema revalidate。非法 action shape / 非法投影 surfaced 给 LLM 非持久化。corrupt-project
 * guard（mirror readEmotionCurve）：拒向 fresh empty 数据投影增量编辑——否则 action:'set' 覆盖真实不可读
 * 数据（cross-field pollution）。CR-004：array/Record 形态**逐条 drop-bad-keep-good**——好条目继续作投影
 * 基底（一条坏弧不砖整字段写通道），坏条目 reason 随 handler 返回可见（落盘全量 set 会移除坏条目，须知情）；
 * 全条目坏 / 整体非对象维持 corrupt 拒。CR-008：params null/undefined 头部归一守卫（never-throws）。
 *
 * Crosses processes via the UNIFIED `toolExecution` channel（remoteToolProxy → handleToolExecute → these
 * handlers）。NO dedicated IPC channel / preload / OrisonDesktopApi entry——同 emotion_curve_* / asset_cards_update。
 * agent 侧 builtin（remoteToolProxy 两件）+ toolPolicy.DIFF_TOOLS / UI agentDiffSlice.WRITE_TOOLS 登记
 * 同 commit（B01 三处同步 checklist——toolExecution.ts register 是第 1 处）。
 *
 * Handlers NEVER throw on bad input（mirror「never throws」契约）：malformed param / missing project /
 * repo failure 降级为友好消息，agent runLoop turn 永不收 rejection。
 *
 * ⚠ 区分 storySyncHandlers 的 growth_curve 专属分支（Story 8.5 Step 2）：那是 story-sync 管线
 * （正文→设定反哺 merge 语义）；本文件是**独立设计轨写工具**（leader 对话 bounded action 写通道）。
 */
import type { ToolHandler } from './types';
import {
  applyGrowthCurveActions,
  applyPacingCurveActions,
  growthCurveActionSchema,
  growthCurveFieldSchema,
  growthCurveSchema,
  pacingCurveActionSchema,
  pacingCurveSchema,
  type GrowthCurve,
  type GrowthCurveAction,
  type PacingCurve,
  type PacingCurveAction,
} from '@orison/shared-contracts';
import { withProjectLock } from '../../fs/projectWriteLock';
import { getLogger } from '../../logger';

/**
 * 读 growth_curve（absent/ok/corrupt 三态，mirror readEmotionCurve）。
 *
 * - `absent`：project 加载成功但无 growth_curve 字段（8.5 前生产端断线，字段从未写）。Fresh [] 是增量
 *   编辑的正确基底。
 * - `ok`：字段存在且可读——array/Record 形态**逐条 drop-bad-keep-good**（CR-004：一条坏弧不砖整字段写
 *   通道——好条目是投影基底，坏条目收集 reason 随 handler 返回可见；既有全部坏 / 整体非对象形态 → corrupt）。
 *   旧 yaml 单条宽容归一（D2 zero-data-loss）。
 * - `corrupt`：字段整体形态坏（非对象非数组 / 全条目坏 / loadProject 返 null）→ 拒 staging（防向 fresh []
 *   投影后 action:'set' 覆盖真实不可读数据，cross-field pollution）。
 */
async function readGrowthCurvesField(
  projectDir: string,
): Promise<
  | { status: 'absent'; curves: GrowthCurve[] }
  | { status: 'ok'; curves: GrowthCurve[]; droppedBadCurves: string[] }
  | { status: 'corrupt'; reason: string }
> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, projectDir }, '[growth_curve] loadProject threw');
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  // loadProject null = 整文档 corrupt/missing。不可当 absent-empty：update 会向 fresh [] 投影 →
  // action:'set' overwrite 真实（不可读）数据（cross-field pollution）。拒 + surface。
  if (doc === null) {
    return {
      status: 'corrupt',
      reason:
        '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存角色成长弧的增量编辑',
    };
  }

  const raw = doc.growth_curve;
  if (raw == null) {
    return { status: 'absent', curves: [] };
  }

  // CR-004：array/Record 形态逐条 drop-bad-keep-good（mirror storySyncHandlers growth_curve 分支哲学——
  // 好条目继续服务编辑，坏条目 reason 可见非静默）；全坏 / 整体非对象维持 corrupt 拒（不可向空基底投影
  // 覆盖真实坏数据）。
  const curves: GrowthCurve[] = [];
  const droppedBadCurves: string[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((item, idx) => {
      const parsed = growthCurveSchema.safeParse(item);
      if (parsed.success) curves.push(parsed.data);
      else {
        // reason 携 character_id（有则报）——坏条目可定位（mirror Record 分支的键名可见）。
        const cid = item && typeof item === 'object' && !Array.isArray(item)
          ? (item as { character_id?: unknown }).character_id
          : undefined;
        const who = typeof cid === 'string' && cid.length > 0 ? `（角色 ${cid}）` : '';
        droppedBadCurves.push(`第 ${idx + 1} 条${who}：${parsed.error.issues[0]?.message ?? 'invalid'}`);
      }
    });
  } else if (typeof raw === 'object') {
    // 单条（值内 character_id）→ 包数组；否则 Record 逐值（key 补缺 character_id，值内优先——mirror
    // growthCurveFieldSchema Record 分支同语义）。
    const single = growthCurveSchema.safeParse(raw);
    if (single.success) {
      curves.push(single.data);
    } else {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const candidate =
          value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(value as Record<string, unknown>) }
            : undefined;
        const inValueId = candidate?.character_id;
        const parsed = candidate
          ? growthCurveSchema.safeParse({
              ...candidate,
              ...(typeof inValueId === 'string' && inValueId.length > 0 ? {} : { character_id: key }),
            })
          : undefined;
        if (parsed?.success) curves.push(parsed.data);
        else droppedBadCurves.push(`键 ${key}：${parsed?.error.issues[0]?.message ?? '值非曲线对象'}`);
      }
    }
  } else {
    getLogger().warn({ projectDir }, '[growth_curve] field is malformed (non-object)');
    return {
      status: 'corrupt',
      reason: 'growth_curve 字段形态坏（既非对象也非数组）；为安全起见拒绝暂存角色成长弧的增量编辑',
    };
  }
  if (curves.length === 0 && droppedBadCurves.length > 0) {
    // 全条目坏：无好基底——corrupt 拒（增量编辑会整字段覆盖掉全部坏数据，须先手修）。
    getLogger().warn({ projectDir, badCount: droppedBadCurves.length }, '[growth_curve] all entries schema-invalid');
    return {
      status: 'corrupt',
      reason: `growth_curve 有 ${droppedBadCurves.length} 条坏形态条目且无可读条目；请先在项目设定文件中修复这些条目，再提交增量编辑`,
    };
  }
  if (droppedBadCurves.length > 0) {
    getLogger().warn({ projectDir, badCount: droppedBadCurves.length }, '[growth_curve] some entries schema-invalid (dropped from projection base)');
  }
  return { status: 'ok', curves, droppedBadCurves };
}

/**
 * 投影 GrowthCurve actions 到当前 curves → schema-validated full array（trust-boundary：parse →
 * project → revalidate）。read+project+validate 单源 helper，PatchReview 路径 + autoApply 路径共用。
 *
 * - corrupt on-disk curves（或整文档 corrupt / 全条目坏）→ 拒（不投影到 fresh [] 致 action:'set' overwrite）。
 * - projected schema-invalid（projector drift / 坏 curve）→ 拒（belt-and-suspenders）。
 * - CR-004：好条目 + 坏条目混存时基于好条目投影，坏条目 reasons 透出（droppedBadCurves——handler 输出
 *   可见：落盘为全量 set，坏条目会被移除，须让 LLM/作者知情非静默）。
 */
async function computeProjectedCurves(
  projectDir: string,
  actions: GrowthCurveAction[],
): Promise<
  | { ok: true; curves: GrowthCurve[]; droppedBadCurves: string[] }
  | { ok: false; message: string }
> {
  const readResult = await readGrowthCurvesField(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `角色成长弧更新被拒：${readResult.reason}。请先在项目设定文件中修复或移除损坏的 growth_curve，再重新提交增量编辑。`,
    };
  }
  const current = readResult.curves; // 'absent' -> fresh []; 'ok' -> loaded curves（坏条目已被剔除）
  const droppedBadCurves = readResult.status === 'ok' ? readResult.droppedBadCurves : [];

  const projected = applyGrowthCurveActions(current, actions);

  // Trust-boundary defense：revalidate 投影（canonical array arm）。坏 curve 会在 actionSchema.parse
  // 阶段已拒；此处 belt-and-suspenders + 防 projector drift。
  const validated = growthCurveFieldSchema.safeParse(projected);
  if (!validated.success) {
    return {
      ok: false,
      message: `角色成长弧更新被拒：投影后的曲线数据校验失败（${validated.error.message}）。add_curve 须带 character_id + start_state；patch 须能合并进合法曲线。`,
    };
  }
  return { ok: true, curves: validated.data, droppedBadCurves };
}

/**
 * 坏条目提示文案（CR-004：drop-bad-keep-good 的可见面——落盘是全量 set，坏条目会被移除，LLM/作者须知）。
 * 空列表 → 空串（输出不加噪声段）。
 */
function formatDroppedBadCurves(dropped: readonly string[]): string {
  if (dropped.length === 0) return '';
  const listed = dropped.slice(0, 5).map((d) => `· ${d}`).join('\n');
  const more = dropped.length > 5 ? `\n· …等共 ${dropped.length} 条` : '';
  return (
    `\n⚠ 既有 growth_curve 有 ${dropped.length} 条坏形态条目未读入（本次编辑基于可读条目投影，落盘后这些坏条目将被移除；如需保留请先手动修复项目设定文件）：\n${listed}${more}`
  );
}

/** One line per action for the autoApply landing summary（机械汇编，不判语义，op 与 id 保留原样）。 */
function summarizeGrowthCurveActions(actions: readonly GrowthCurveAction[]): string {
  return actions
    .map((a) => {
      if (a.op === 'add_curve') return `+ 弧 ${a.curve.character_id}（${a.curve.desire ?? 'desire 未设'}）`;
      if (a.op === 'update_curve') {
        const fields = Object.keys(a.patch).join(', ') || '无字段';
        return `~ 弧 ${a.character_id}（${fields}）`;
      }
      return `- 弧 ${a.character_id}`;
    })
    .join('\n');
}

/**
 * growth_curve_update：bounded action enum（add/update/remove curve by character_id 自然键）→ 纯代码投影
 * full array。**两种落盘模式**（mirror arc_ledger_update / asset_cards_update DW-4）：
 *
 * 1. **autoApply=true（auto 档 leader 自动落盘，仅 permissionMode 'auto' 才传——KD1 复用档位）**：
 *    withProjectLock 内 fresh read + project + onFieldEdited(source:'agent') 直接写盘（version bump +
 *    markStaleFields + parse + saveProject 全走既有 onFieldEdited 作用链）。返 applied metadata。
 *    onFieldEdited throw（locked field / save fail）→ graceful error 返（提议不落盘不破 tool）。
 * 2. **autoApply 缺省/false（suggest 档 PatchReview 路径，默认）**：返 field_patch envelope →
 *    UI patch-review → syncField → onFieldEdited(source:'user') 落盘。
 *
 * add_curve 对已存在 character_id 走 partial merge（只合并显式提供字段，不填 defaults 覆盖真实字段——
 * B1 教训，mirror promiseEntryWriteSchema）；update_curve 浅合并 patch（identity 键 character_id 不可改）；
 * remove_curve 幂等。
 */
export const growthCurveUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  // CR-008：宽松 provider / 畸形 arguments 可送达 null/undefined params（IPC 面类型 Record 但线缆无契约）——
  // 头部归一守卫，never-throws 契约（头注释）不被 TypeError 击穿。
  const p = (params ?? {}) as { actions?: unknown; autoApply?: unknown };
  const rawActions = p.actions;
  const actionList = Array.isArray(rawActions) ? rawActions : [];
  const autoApply = p.autoApply === true;

  // P16 mirror：空 action list 是 caller bug——友好 no-op 不产零变更 patch（agent 侧 zod .min(1) 先拒；
  // 此守卫覆盖绕过 schema 的宽松 provider）。
  if (actionList.length === 0) {
    return {
      title: 'growth_curve_update',
      output:
        '角色成长弧更新已跳过：操作列表为空。请至少提供一条操作——add_curve（curve：character_id + start_state 必填，wound_or_lack/desire/need/turning_points/end_state 可选）/ update_curve（character_id + patch）/ remove_curve（character_id）。',
    };
  }

  // Trust-boundary：逐 action 经 discriminated-union schema parse。非法 action shape surfaced 给 LLM
  // （非静默丢/持久化坏 curves）。
  let actions: GrowthCurveAction[];
  try {
    actions = actionList.map((a) => growthCurveActionSchema.parse(a));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'growth_curve_update',
      output:
        `角色成长弧更新被拒：操作格式无效（${reason}）。` +
        '可用操作为 add_curve（curve：character_id + start_state 必填）/ update_curve（character_id + patch）/ remove_curve（character_id）。',
    };
  }

  // ── autoApply 路径：直接落盘（mirror arcLedgerUpdateHandler，withProjectLock 串行化 read-modify-write）──
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeProjectedCurves(projectDir, actions);
        if (!result.ok) {
          return { title: 'growth_curve_update', output: result.message };
        }
        const curves = result.curves;
        // dynamic import local-bff（mirror readGrowthCurvesField，避 shell 静态依赖）。
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'growth_curve', curves, {
          source: 'agent',
          reason: '角色弧生产线自动落盘（auto 档）',
        });
        return {
          title: 'growth_curve_update',
          output:
            `角色成长弧已生效（${actions.length} 项操作 → 调整后共 ${curves.length} 条弧，已写入项目设定）。\n` +
            summarizeGrowthCurveActions(actions) +
            formatDroppedBadCurves(result.droppedBadCurves),
          metadata: {
            ok: true,
            applied: true,
            actionCount: actions.length,
            curveCount: curves.length,
            droppedBadCurveCount: result.droppedBadCurves.length,
            summary: `角色成长弧 · ${actions.length} 项操作已生效（自动应用）`,
          },
        };
      });
    } catch (err) {
      // onFieldEdited throws on locked field（用户锁 growth_curve 拒自动改）/ save failure → graceful
      // （不破 tool；leader 收失败提示可转 suggest 档重发走人审）。
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: reason, projectDir }, '[growth_curve] autoApply landing failed');
      return {
        title: 'growth_curve_update',
        output: `角色成长弧自动生效失败：${reason}。操作已通过校验，但未做任何改动。`,
      };
    }
  }

  // ── PatchReview 路径（默认）：field_patch envelope → UI patch-review → syncField ──
  const result = await computeProjectedCurves(projectDir, actions);
  if (!result.ok) {
    return { title: 'growth_curve_update', output: result.message };
  }
  const projectedCurves = result.curves;

  return {
    title: 'growth_curve_update',
    output:
      `角色成长弧更新已备好：调整后共 ${projectedCurves.length} 条弧。` +
      `请在补丁面板审阅——确认后写入项目设定。` +
      formatDroppedBadCurves(result.droppedBadCurves),
    metadata: {
      type: 'field_patch',
      field: 'growth_curve',
      action: 'set',
      data: projectedCurves,
      droppedBadCurveCount: result.droppedBadCurves.length,
    },
  };
};

// ── pacing_curve_update（逐字段 mirror emotionCurveUpdateHandler——同为 refId+points 扁平曲线）──

type PacingCurveReadResult =
  | { status: 'absent'; curve: PacingCurve }
  | { status: 'ok'; curve: PacingCurve }
  | { status: 'corrupt'; reason: string };

/**
 * 读 pacing_curve（absent/ok/corrupt 三态，mirror readEmotionCurve）。
 *
 * ⚠ pacingCurveSchema.unit required（无 .default）——absent 时 fresh empty curve 须显式给 unit
 * （mirror D-5.1-1 emotion unit:'scene' 决策）：8.5 生产入口是 leader 对话排节奏点，episode_outlines
 * 是规划基底（pacing_beats 挂集纲），故 fresh 基线 unit:'episode'。
 */
async function readPacingCurve(projectDir: string): Promise<PacingCurveReadResult> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, projectDir }, '[pacing_curve] loadProject threw');
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  if (doc === null) {
    return {
      status: 'corrupt',
      reason:
        '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存节奏曲线的增量编辑',
    };
  }

  const raw = doc.pacing_curve;
  if (raw == null) {
    // legit empty：fresh curve（unit:'episode'）是增量编辑正确基底。
    return { status: 'absent', curve: pacingCurveSchema.parse({ unit: 'episode' }) };
  }

  const validated = pacingCurveSchema.safeParse(raw);
  if (!validated.success) {
    getLogger().warn({ projectDir }, '[pacing_curve] field is schema-invalid');
    return { status: 'corrupt', reason: `节奏曲线字段数据校验失败：${validated.error.message}` };
  }
  return { status: 'ok', curve: validated.data };
}

/**
 * 投影 PacingCurve actions → schema-validated full curve（trust-boundary 单源 helper，双路径共用，
 * mirror computeProjectedCurve）。
 */
async function computeProjectedPacingCurve(
  projectDir: string,
  actions: PacingCurveAction[],
): Promise<{ ok: true; curve: PacingCurve } | { ok: false; message: string }> {
  const readResult = await readPacingCurve(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `节奏曲线更新被拒：${readResult.reason}。请先在项目设定文件中修复或移除损坏的 pacing_curve，再重新提交增量编辑。`,
    };
  }
  const current = readResult.curve; // 'absent' -> fresh empty curve; 'ok' -> loaded curve

  const projected = applyPacingCurveActions(current, actions);

  const validated = pacingCurveSchema.safeParse(projected);
  if (!validated.success) {
    return {
      ok: false,
      message: `节奏曲线更新被拒：投影后的曲线数据校验失败（${validated.error.message}）。add/update 须携带完整节奏点（refId + intensity 0-10 必填）。`,
    };
  }
  return { ok: true, curve: validated.data };
}

/**
 * pacing_curve_update：bounded action enum（add/update/remove point by refId）→ 纯代码投影 full curve。
 * **两种落盘模式**（mirror emotion_curve_update DW-4 / arc_ledger_update）：
 *
 * 1. **autoApply=true（auto 档 leader 自动落盘）**：withProjectLock + onFieldEdited(source:'agent')
 *    直接落盘，返 applied metadata。
 * 2. **autoApply 缺省/false（PatchReview 路径，默认）**：返 field_patch envelope（field:'pacing_curve',
 *    action:'set', data: fullCurve）→ UI patch-review → syncField → onFieldEdited(source:'user')。
 *
 * add_point/update_point 按 refId 覆盖或追加（幂等，容错——LLM 可能误判存在性）；remove_point 幂等。
 * unit/target_shape/risks 透传不动（projector 只管 points；unit 变更走 outline 草稿/手编，非本工具域）。
 */
export const pacingCurveUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  // CR-008：params null/undefined 头部归一守卫（mirror growthCurveUpdateHandler，never-throws 契约）。
  const p = (params ?? {}) as { actions?: unknown; autoApply?: unknown };
  const rawActions = p.actions;
  const actionList = Array.isArray(rawActions) ? rawActions : [];
  const autoApply = p.autoApply === true;

  if (actionList.length === 0) {
    return {
      title: 'pacing_curve_update',
      output:
        '节奏曲线更新已跳过：操作列表为空。请至少提供一条操作——add_point / update_point（point：refId + intensity 必填）/ remove_point（refId）。',
    };
  }

  let actions: PacingCurveAction[];
  try {
    actions = actionList.map((a) => pacingCurveActionSchema.parse(a));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'pacing_curve_update',
      output:
        `节奏曲线更新被拒：操作格式无效（${reason}）。` +
        '可用操作为 add_point/update_point（携带完整节奏点：refId + intensity 必填）/ remove_point（携带 refId）。',
    };
  }

  // ── autoApply 路径：直接落盘（withProjectLock 串行化 read-modify-write）──
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeProjectedPacingCurve(projectDir, actions);
        if (!result.ok) {
          return { title: 'pacing_curve_update', output: result.message };
        }
        const curve = result.curve;
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'pacing_curve', curve, {
          source: 'agent',
          reason: '节奏曲线自动落盘（auto 档）',
        });
        return {
          title: 'pacing_curve_update',
          output:
            `节奏曲线已生效（共 ${curve.points.length} 个节奏点，已写入项目设定）。\n` +
            actions.map((a) => (a.op === 'remove_point' ? `- ${a.refId}` : `${a.op} ${a.point.refId}`)).join('\n'),
          metadata: {
            ok: true,
            applied: true,
            pointCount: curve.points.length,
            summary: `节奏曲线 · ${actions.length} 项操作已生效（自动应用）`,
          },
        };
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: reason, projectDir }, '[pacing_curve] autoApply landing failed');
      return {
        title: 'pacing_curve_update',
        output: `节奏曲线自动生效失败：${reason}。操作已通过校验，但未做任何改动。`,
      };
    }
  }

  // ── PatchReview 路径（默认）：field_patch envelope → UI patch-review → syncField ──
  const result = await computeProjectedPacingCurve(projectDir, actions);
  if (!result.ok) {
    return { title: 'pacing_curve_update', output: result.message };
  }
  const projectedCurve = result.curve;

  return {
    title: 'pacing_curve_update',
    output: `节奏曲线更新已备好：调整后共 ${projectedCurve.points.length} 个节奏点。请在补丁面板审阅——确认后写入项目设定。`,
    metadata: {
      type: 'field_patch',
      field: 'pacing_curve',
      action: 'set',
      data: projectedCurve,
    },
  };
};
