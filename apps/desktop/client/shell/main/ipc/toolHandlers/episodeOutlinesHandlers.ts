/**
 * Story 8.5 R2 episode outlines tool handler — episode_outlines_update
 * （mirror assetCardsHandlers.ts / sceneGraphHandlers.ts，ADR-3 / design §3.2）。
 *
 * episode_outlines 在 8.5 前零生产工具（全仓无写入路径，数据只能来自 legacy intake / 手编 yaml——
 * 8.5 research §3）。本工具建**单一写通道两驱动**（episode-planner agent 主产 + leader 对话直改，
 * mirror scene_graph_update）：LLM 经 bounded action enum（add_episode / update_episode / remove_episode，
 * by id）发编辑，handler 纯代码投影出 full array → autoApply 双档落盘（mirror asset_cards_update）。
 *
 * 集纲切分/phase 挂钩/character_progressions 设计 = LLM 语义（episode-planner）；identity/内容投影 =
 * 纯代码机械 by-id（ADR-3）。index 冲突不机械改写（index 是 LLM 排序决策，projector 只管 identity/内容）。
 *
 * **phase_ref 存在性校验 = warn 透传不拒**（design §3.1 定案，mirror Line.phase_ref 宽容先例）：
 * 硬拒会挡 LLM「先排章后补 phase」的合法顺序（phase 由 story-planner 产，时序上可能晚于集纲）。
 * projected 全量 episode 的 phase_ref 对 outline_v2.phases[].id 集合校验，不在集合内的透传 + warn
 * 消息随 handler 返回（leader 可见，可后续 update_episode 补挂或先产 phase）。大纲缺失/无 phases 时
 * 同样 warn（每条带 phase_ref 的 episode 都悬空）。
 *
 * **remove_episode 入站引用扫描 = warn 透传不拒**（CR-Edge-F1，mirror phase_ref warn 双通道）：删除前
 * 纯代码 id 集合检查该集 id 的下游引用——scene_graph（nodes[].episodeId + presentationSpans[].episodeId）/
 * promise_registry（beats[].episodeId）/ growth_curve（turning_points[].linked_episode_ids，经
 * readGrowthCurves 归一）。有引用 → 删除照常 + warn（output 文字 top5+总数 + metadata.episodeRemovalWarnings）；
 * 无引用 → 静默删。机械 id 比对零语义（该不该删归 LLM，ADR-3）。
 *
 * **同批 add_episode id 重复 = 整批拒**（CR-Blind-F3/Edge-F2）：batch-atomic 语义——同批两条 add_episode
 * 用同一 id，第二条落 projector 会静默跳过（不可达防御），LLM 应显式得知冲突（truthful reason 指向
 * update_episode），与「add 撞磁盘既有 id」同报错面。CR-005：撞盘判定基准 = 本批 remove 投影后的状态——
 * 同批 [remove e1, add e1'] 是合法原子替换序列（update_episode 不能改 id），不拒。
 *
 * Trust-boundary（mirror assetCardsHandlers）：parse → project → projected 全量 safeParse
 * episodeOutlinesSchema。add_episode 重复 id 友好报错（不静默覆盖——同 id 双集在 PatchReview 面板
 * 不可辨）；update_episode 浅合并 patch（identity 键 id 不可改；phase_ref null = 显式清除卷锚，
 * CR-Blind-F1）；remove_episode 幂等跳过。
 * corrupt-project guard：拒向 fresh [] 投影增量编辑（action:'set' 覆盖真实不可读数据防护）。
 *
 * autoApply 双档（mirror asset_cards_update DW-4 / arc_ledger_update）：
 * - autoApply=true（auto 档 leader 自动落盘）：withProjectLock + onFieldEdited(source:'agent') 直接
 *   落盘，返 applied metadata（含 phaseWarnings）。
 * - autoApply 缺省/false（默认）：field_patch envelope（field:'episode_outlines', action:'set',
 *   data: fullEpisodes）→ UI patch-review → syncField → onFieldEdited(source:'user')。
 *
 * Handlers NEVER throw；统一 toolExecution channel（无专用 IPC/preload）。B01 三处同步：shell register
 * （toolExecution.ts，第 1 处）+ agent builtin/toolPolicy（第 2 处）+ UI agentDiffSlice.WRITE_TOOLS（第 3 处）。
 */
import type { ToolHandler } from './types';
import {
  applyEpisodeActions,
  episodeActionSchema,
  episodeOutlinesSchema,
  readGrowthCurves,
  type EpisodeAction,
  type EpisodeOutline,
} from '@orison/shared-contracts';
import { withProjectLock } from '../../fs/projectWriteLock';
import { getLogger } from '../../logger';

type EpisodeOutlinesReadResult =
  | { status: 'absent'; episodes: EpisodeOutline[] }
  | { status: 'ok'; episodes: EpisodeOutline[] }
  | { status: 'corrupt'; reason: string };

/** loadProject 单次读盘（episode 字段 parse / phase ids / remove 引用扫描共用同一 doc，勿重复读盘）。 */
async function loadProjectDoc(projectDir: string): Promise<Record<string, unknown> | null> {
  const { loadProject } = await import('@orison/desktop-local-bff');
  return loadProject(projectDir) as Record<string, unknown> | null;
}

/**
 * 读 episode_outlines（absent/ok/corrupt 三态，mirror readAssetCards）：`absent` = project 加载成功但
 * 无该字段（8.5 前零生产工具，字段常缺——fresh [] 是增量编辑正确基底）；`corrupt` = 字段存在但
 * schema-invalid 或整文档不可读 → 拒增量编辑（防 action:'set' overwrite）。
 */
function parseEpisodeOutlinesField(
  projectDir: string,
  doc: Record<string, unknown> | null,
): EpisodeOutlinesReadResult {
  if (doc === null) {
    return {
      status: 'corrupt',
      reason:
        '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存集纲的增量编辑',
    };
  }

  const raw = doc.episode_outlines;
  if (raw == null) {
    return { status: 'absent', episodes: [] };
  }

  const validated = episodeOutlinesSchema.safeParse(raw);
  if (!validated.success) {
    getLogger().warn({ projectDir }, '[episode_outlines] field is schema-invalid');
    return { status: 'corrupt', reason: `集纲字段数据校验失败：${validated.error.message}` };
  }
  return { status: 'ok', episodes: validated.data };
}

/** phase_ref 存在性警告（leader 可见，design §3.1 warn 不拒）。 */
interface PhaseRefWarning {
  episodeId: string;
  phaseRef: string;
}

/** remove_episode 入站引用警告（CR-Edge-F1，warn 透传不拒）。 */
interface EpisodeRemovalWarning {
  /** 被删且仍有下游引用的集 id。 */
  episodeId: string;
  /** 引用来源描述（每源一条，机械汇编；源内 id 列表 top5 截断）。 */
  references: string[];
}

/**
 * 读 outline_v2.phases[].id 集合（防御性 raw 抽取——outline 缺/形态坏不算 corrupt，phase 校验降级
 * 为「全部悬空 warn」，集纲编辑本体不受大纲可读性牵连）。
 */
function readPhaseIdsFromDoc(doc: Record<string, unknown> | null): Set<string> {
  const ids = new Set<string>();
  const outline = doc?.outline_v2;
  const phases = (outline as { phases?: unknown } | undefined)?.phases;
  if (!Array.isArray(phases)) return ids;
  for (const phase of phases) {
    const id = (phase as { id?: unknown })?.id;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids;
}

/** 单源内 id 列表 top5 折叠文案（`s1、s2、s6、s7 等`）。 */
function foldIdsTop5(ids: readonly string[]): string {
  return ids.slice(0, 5).join('、') + (ids.length > 5 ? ` 等 ${ids.length} 个` : '');
}

/**
 * 扫描集 id 的入站下游引用（CR-Edge-F1，纯代码 id 集合比对零语义）：
 * scene_graph（nodes[].episodeId + presentationSpans[].episodeId）/ promise_registry（beats[].episodeId）/
 * growth_curve（turning_points[].linked_episode_ids，经 readGrowthCurves 归一——Record key 补缺形态也认）。
 * 防御性 raw 抽取（字段缺/形态坏 = 该源零引用，不牵连编辑本体）。
 */
function collectEpisodeRemovalReferences(doc: Record<string, unknown> | null, episodeId: string): string[] {
  if (!doc) return [];
  const sources: string[] = [];

  // scene_graph：场→集挂载（episodeId）+ 场↔章交汇（presentationSpans[].episodeId）。同场双引用只记一次。
  const sceneGraph = doc.scene_graph;
  if (sceneGraph && typeof sceneGraph === 'object') {
    const nodes = (sceneGraph as { nodes?: unknown }).nodes;
    if (Array.isArray(nodes)) {
      const sceneIds: string[] = [];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const n = node as { id?: unknown; episodeId?: unknown; presentationSpans?: unknown };
        const nodeId = typeof n.id === 'string' ? n.id : undefined;
        if (nodeId === undefined) continue;
        const byEpisode = n.episodeId === episodeId;
        const bySpan = Array.isArray(n.presentationSpans)
          ? n.presentationSpans.some((s) => (s as { episodeId?: unknown } | null)?.episodeId === episodeId)
          : false;
        if (byEpisode || bySpan) sceneIds.push(nodeId);
      }
      if (sceneIds.length > 0) sources.push(`scene_graph ${sceneIds.length} 场（${foldIdsTop5(sceneIds)}）`);
    }
  }

  // promise_registry：读者债节拍挂集（beats[].episodeId，按 promiseId 去重——报「哪条 Promise 受影响」）。
  const promiseRegistry = doc.promise_registry;
  if (promiseRegistry && typeof promiseRegistry === 'object') {
    const beats = (promiseRegistry as { beats?: unknown }).beats;
    if (Array.isArray(beats)) {
      const promiseIds: string[] = [];
      for (const beat of beats) {
        if (!beat || typeof beat !== 'object') continue;
        const b = beat as { promiseId?: unknown; episodeId?: unknown };
        if (b.episodeId !== episodeId) continue;
        if (typeof b.promiseId === 'string' && b.promiseId.length > 0 && !promiseIds.includes(b.promiseId)) {
          promiseIds.push(b.promiseId);
        }
      }
      if (promiseIds.length > 0) sources.push(`promise_registry 节拍 ${promiseIds.length} 条 Promise（${foldIdsTop5(promiseIds)}）`);
    }
  }

  // growth_curve：转折点锚集（turning_points[].linked_episode_ids，经 readGrowthCurves 归一含 Record key 补缺）。
  const curves = readGrowthCurves(doc.growth_curve) ?? [];
  const charIds = curves
    .filter((c) =>
      Array.isArray(c.turning_points)
        ? c.turning_points.some((tp) => Array.isArray(tp?.linked_episode_ids) && tp.linked_episode_ids.includes(episodeId))
        : false,
    )
    .map((c) => c.character_id);
  if (charIds.length > 0) sources.push(`growth_curve 转折点 ${charIds.length} 个角色（${foldIdsTop5(charIds)}）`);

  return sources;
}

/**
 * 投影 Episode actions → schema-validated full array + phase_ref 存在性警告 + remove 引用警告
 * （trust-boundary 单源 helper，双路径共用；单次 loadProject 读盘三源共用）。
 *
 * - corrupt on-disk episodes（或整文档 corrupt）→ 拒。
 * - add_episode 重复 id（撞磁盘既有 / 同批重复）→ 友好报错（projector 有跳过 backstop，但 LLM 应显式
 *   得知冲突而非静默无效果）。
 * - projected schema-invalid → 拒（belt-and-suspenders，mirror assetCardsHandlers）。
 * - phase 校验：projected 全量 episode 的 phase_ref 不在 phases[].id 集合 → PhaseRefWarning（透传不拒）。
 * - remove 校验：被删集 id 的入站下游引用（scene_graph / promise_registry / growth_curve）→
 *   EpisodeRemovalWarning（透传不拒，CR-Edge-F1）。
 */
async function computeProjectedEpisodes(
  projectDir: string,
  actions: EpisodeAction[],
): Promise<
  | {
      ok: true;
      episodes: EpisodeOutline[];
      phaseWarnings: PhaseRefWarning[];
      removalWarnings: EpisodeRemovalWarning[];
    }
  | { ok: false; message: string }
> {
  // 单次 loadProject 读盘：episode 字段 parse + phase ids + remove 引用扫描共用同一 doc（勿重复读盘）。
  let doc: Record<string, unknown> | null;
  try {
    doc = await loadProjectDoc(projectDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, projectDir }, '[episode_outlines] loadProject threw');
    return { ok: false, message: `集纲更新被拒：项目设定文件加载失败：${reason}。` };
  }

  const readResult = parseEpisodeOutlinesField(projectDir, doc);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `集纲更新被拒：${readResult.reason}。请先在项目设定文件中修复或移除损坏的 episode_outlines，再重新提交增量编辑。`,
    };
  }
  const current = readResult.episodes; // 'absent' -> fresh []; 'ok' -> loaded episodes

  // add_episode 重复 id 友好报错（mirror assetCardsHandlers add_card——projector 的跳过是不可达防御）。
  // CR-005：判定基准 = **本批 remove 投影后的状态**（先应用同批 remove_episode 再判撞）——同批
  // [remove e1, add e1'] 是合法原子替换序列（update_episode 恰不能改 id，替换 id 必须走 remove+add），
  // 不应被误拒。仅当 id 在投影后仍存在（磁盘既有且本批未删）才拒。
  const removedInBatch = new Set(
    actions.filter((a) => a.op === 'remove_episode').map((a) => a.episodeId),
  );
  for (const action of actions) {
    if (
      action.op === 'add_episode' &&
      current.some((e) => e.id === action.episode.id && !removedInBatch.has(e.id))
    ) {
      return {
        ok: false,
        message:
          `集纲更新被拒：add_episode 的 id "${action.episode.id}" 已存在。` +
          '请改用 update_episode（episodeId + patch）修改它、另选新 id，或先 remove_episode（episodeId）——同一批次内的 remove_episode + add_episode 是合法的 id 替换序列。',
      };
    }
  }

  // 同批 add_episode id 重复 → 整批拒（CR-Blind-F3/Edge-F2，batch-atomic：第二条落 projector 会静默跳过，
  // LLM 应显式得知冲突——truthful reason 指向 update_episode）。
  const addCounts = new Map<string, number>();
  for (const action of actions) {
    if (action.op === 'add_episode') addCounts.set(action.episode.id, (addCounts.get(action.episode.id) ?? 0) + 1);
  }
  for (const [dupId, count] of addCounts) {
    if (count > 1) {
      return {
        ok: false,
        message:
          `集纲更新被拒：同一批次内有 ${count} 条 add_episode 使用了同一 id "${dupId}"` +
          '（未应用任何操作）。请只添加一次，后续改动用 update_episode（episodeId + patch）。',
      };
    }
  }

  const projected = applyEpisodeActions(current, actions);

  const validated = episodeOutlinesSchema.safeParse(projected);
  if (!validated.success) {
    return {
      ok: false,
      message: `集纲更新被拒：投影后的集纲数据校验失败（${validated.error.message}）。add 须携带完整集（id + index + title 必填），update 的 patch 须合法。`,
    };
  }

  // phase_ref 存在性校验（warn 透传不拒，design §3.1）。projected 全量检查——预存悬空锚每次 surfaced
  // 直到补挂/修 typo（warn 稳定幂等，leader 可见可行动）。
  const phaseIds = readPhaseIdsFromDoc(doc);
  const phaseWarnings: PhaseRefWarning[] = [];
  for (const episode of validated.data) {
    if (episode.phase_ref !== undefined && !phaseIds.has(episode.phase_ref)) {
      phaseWarnings.push({ episodeId: episode.id, phaseRef: episode.phase_ref });
    }
  }

  // remove_episode 入站引用扫描（CR-Edge-F1，warn 透传不拒）：仅对真实存在的删除目标告警（幂等 no-op
  // 不告警）；同批多次删同 id 去重一条。
  const removalWarnings: EpisodeRemovalWarning[] = [];
  const warnedRemovalIds = new Set<string>();
  for (const action of actions) {
    if (action.op !== 'remove_episode' || warnedRemovalIds.has(action.episodeId)) continue;
    if (!current.some((e) => e.id === action.episodeId)) continue;
    warnedRemovalIds.add(action.episodeId);
    const references = collectEpisodeRemovalReferences(doc, action.episodeId);
    if (references.length > 0) removalWarnings.push({ episodeId: action.episodeId, references });
  }

  return { ok: true, episodes: validated.data, phaseWarnings, removalWarnings };
}

/** phase 警告文案（零警告 → 空串，输出不加噪声段）。 */
function formatPhaseWarnings(warnings: readonly PhaseRefWarning[]): string {
  if (warnings.length === 0) return '';
  const listed = warnings.slice(0, 5).map((w) => `${w.episodeId}→"${w.phaseRef}"`).join('、');
  const more = warnings.length > 5 ? ` 等 ${warnings.length} 处` : '';
  return (
    `\n⚠ phase_ref 悬空警告（透传不拒，后续补挂）：${listed}${more}。` +
    '这些 phase_ref 不在 outline_v2.phases[].id 集合内——若大纲 phases 尚未建请先产大纲阶段，或用 update_episode 修正引用。'
  );
}

/** remove 引用警告文案（CR-Edge-F1，零警告 → 空串；双通道 mirror phaseWarnings：output + metadata）。 */
function formatEpisodeRemovalWarnings(warnings: readonly EpisodeRemovalWarning[]): string {
  if (warnings.length === 0) return '';
  const listed = warnings.slice(0, 5).map((w) => `${w.episodeId}（${w.references.join('；')}）`).join('、');
  const more = warnings.length > 5 ? ` 等 ${warnings.length} 集` : '';
  return (
    `\n⚠ 集删除引用警告（透传不拒）：${listed}${more} 仍有下游引用，删除后这些引用将悬空——` +
    'scene_graph 场的 episodeId/presentationSpans、promise_registry 节拍、growth_curve 转折点 linked_episode_ids 需随后改指他集或移除。'
  );
}

/** One line per action for the autoApply landing summary（机械汇编，不判语义；op 与 id 保留原样）。 */
function summarizeEpisodeActions(actions: readonly EpisodeAction[]): string {
  return actions
    .map((a) => {
      if (a.op === 'add_episode') return `+ 集 ${a.episode.id}（#${a.episode.index} ${a.episode.title}）`;
      if (a.op === 'update_episode') {
        const fields = Object.keys(a.patch).join(', ') || '无字段';
        return `~ 集 ${a.episodeId}（${fields}）`;
      }
      return `- 集 ${a.episodeId}`;
    })
    .join('\n');
}

/**
 * episode_outlines_update：bounded action enum → 纯代码投影 full episodes → **双档落盘**。
 * 消费者：episode-planner agent（主产者，yaml must 已指明经本工具产出）/ leader 对话直改
 * （补 phase_ref / 改 progression）——单一写通道两驱动。
 */
export const episodeOutlinesUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  // CR-008：params null/undefined 头部归一守卫（mirror curveHandlers，never-throws 契约——头注释自称
  // NEVER throw，裸 (params as …).actions 会以 TypeError 击穿全部友好降级）。
  const p = (params ?? {}) as { actions?: unknown; autoApply?: unknown };
  const rawActions = p.actions;
  const actionList = Array.isArray(rawActions) ? rawActions : [];
  const autoApply = p.autoApply === true;

  // P16 mirror：空 action list 友好 no-op 不产零变更 patch。
  if (actionList.length === 0) {
    return {
      title: 'episode_outlines_update',
      output:
        '集纲更新已跳过：操作列表为空。请至少提供一条操作——add_episode（episode：id + index + title 必填）/ update_episode（episodeId + patch）/ remove_episode（episodeId）。',
    };
  }

  // Trust-boundary：逐 action parse（非法 op / 缺 id 在此拒，surfaced 给 LLM）。
  let actions: EpisodeAction[];
  try {
    actions = actionList.map((a) => episodeActionSchema.parse(a));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'episode_outlines_update',
      output:
        `集纲更新被拒：操作格式无效（${reason}）。` +
        '可用操作为 add_episode（episode：完整集，id + index + title 必填）/ update_episode（episodeId + patch）/ remove_episode（episodeId）。',
    };
  }

  // ── autoApply 路径：直接落盘（withProjectLock 串行化 read-modify-write）──
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeProjectedEpisodes(projectDir, actions);
        if (!result.ok) {
          return { title: 'episode_outlines_update', output: result.message };
        }
        const episodes = result.episodes;
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'episode_outlines', episodes, {
          source: 'agent',
          reason: '集纲编辑自动落盘（auto 档）',
        });
        return {
          title: 'episode_outlines_update',
          output:
            `集纲已生效（${actions.length} 项操作 → 调整后共 ${episodes.length} 集，已写入项目设定）。\n` +
            summarizeEpisodeActions(actions) +
            formatPhaseWarnings(result.phaseWarnings) +
            formatEpisodeRemovalWarnings(result.removalWarnings),
          metadata: {
            ok: true,
            applied: true,
            actionCount: actions.length,
            episodeCount: episodes.length,
            phaseWarnings: result.phaseWarnings,
            episodeRemovalWarnings: result.removalWarnings,
            summary: `集纲 · ${actions.length} 项操作已生效（自动应用）`,
          },
        };
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: reason, projectDir }, '[episode_outlines] autoApply landing failed');
      return {
        title: 'episode_outlines_update',
        output: `集纲自动生效失败：${reason}。操作已通过校验，但未做任何改动。`,
      };
    }
  }

  // ── PatchReview 路径（默认）：field_patch envelope → UI patch-review → syncField ──
  const result = await computeProjectedEpisodes(projectDir, actions);
  if (!result.ok) {
    return { title: 'episode_outlines_update', output: result.message };
  }
  const projectedEpisodes = result.episodes;

  return {
    title: 'episode_outlines_update',
    output:
      `集纲更新已备好：调整后共 ${projectedEpisodes.length} 集。` +
      `请在补丁面板审阅——确认后写入项目设定。` +
      formatPhaseWarnings(result.phaseWarnings) +
      formatEpisodeRemovalWarnings(result.removalWarnings),
    metadata: {
      type: 'field_patch',
      field: 'episode_outlines',
      action: 'set',
      data: projectedEpisodes,
      // warn 透传不拒（design §3.1 / CR-Edge-F1）：metadata 携带供 UI/leader 呈现（无消费者也不影响 patch 本体）。
      phaseWarnings: result.phaseWarnings,
      episodeRemovalWarnings: result.removalWarnings,
    },
  };
};
