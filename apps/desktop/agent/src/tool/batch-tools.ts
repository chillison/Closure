import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import {
  emotionCurveSchema,
  episodeOutlinesSchema,
  infoReleaseMapSchema,
  novelSchema,
  BALANCED_ASK_CATEGORIES_DEFAULT,
  participationGearSchema,
  promiseRegistrySchema,
  sceneGraphSchema,
  transformForeshadowToPromise,
  type EmotionCurve,
  type InfoReleaseMap,
  type PromiseRegistry,
  type SceneGraph,
  type SceneWeightSignal,
} from '@orison/shared-contracts';
import { defineTool } from './define';
import { logger } from '../logger';
import type { ToolContext } from '../types';
import { getSession, sessionExistsOnDisk, updateSessionParticipationGear } from '../agent/session';
import { fetchWorldPatchesViaTool } from '../nodes/world-state-query';
import {
  clearActiveBatchStamp,
  loadBatchRuns,
  markBatchStampReport,
  setActiveBatchStamp,
  upsertBatchRun,
} from './batch-state';
import {
  BATCH_SCENE_CAP,
  groupScenesByChapter,
  resolveBatchScenePlan,
  sceneDisplayName,
} from './batch-planning';
import { assembleSceneWeightSignals, extractGenreCommitments } from './batch-signals';

// ── Story 3.5（design §1 / §6）：leader 批量工具 ×3 + 档位 chat 入口 ×1 ──
//
// 批量编排 = leader 驱动（ADR-17 orchestrator 职责内，**非独立 driver 进程**——design §1 拒选）：
// start_batch 纯代码解析有序场列表 + 每场信号卡 + 落盘批量状态；leader 按 prompt 批量协议段逐场判轻重
// （重点场 turn break 问 / 非重点调既有 write_chapter）；咨询点 = runLoop 自然 break（无新暂停原语）；
// 崩溃/abort 恢复 = batch_status 与 project state 对账续跑。
//
// 🔑 范式判据（ADR-3 / R7 红线）：场列表解析 / 信号汇编 / 进度记账 / 状态读写 = 纯代码（本文件）；
// 判轻重 / 问什么 / 走向单 / L0 全景文本 = leader LLM（prompt 协议段，workflow.ts buildInteractionModeSegment）。
//
// 注册模式 mirror writeChapterTool / diagnoseImpactsTool（local tool + builtin.ts 注册，不走 remoteToolProxy）。
// classifyTool 默认 'read'（toolPolicy 不在 WRITE_TOOLS/DIFF_TOOLS）→ readonly/suggest/auto 全可见；
// **readonly / discuss 权卫在 start_batch 工具内**（批量产 patch 需写权 / discuss 模式禁写）。
//
// expected_downstream_consumers:
// - Story 3.5 Step 8（UI）：start_batch/batch_status metadata.signals + batch = BatchGroup/BatchReportCard 数据源。
// - Story 4.6：链内 escalate_user/BLOCK 到达 → write_chapter 返回 escalate findings → prompt 批量段
//   「escalate 穿透纪律」约束 leader 必停（协议层，非本文件）。

const BOM_CHAR_CODE = 0xfeff;

/** 章正文落盘检查所需的最小 chapter 结构（novel.chapters[] 元素满足——ResolvableChapter 无 sections，本地结构 typing）。 */
interface LandableChapter {
  id: string;
  sections?: Array<{ content_file?: string }>;
}

/** episode_outlines 完整条目（信号汇编丰富度计数需全字段；groupScenesByChapter 消费其 id/index 子集）。 */
type BatchEpisodeOutline = z.infer<(typeof episodeOutlinesSchema)>[number];

/** project.yaml 批量工具所需子集（mirror diagnose-impacts loadDiagnoseProjectInput 防御哲学）。 */
interface BatchProjectInput {
  sceneGraph: SceneGraph | undefined;
  episodeOutlines: BatchEpisodeOutline[];
  novelChapters: LandableChapter[];
  promiseRegistry?: PromiseRegistry;
  emotionCurve?: EmotionCurve;
  infoReleaseMap?: InfoReleaseMap;
  creativeBrief?: { commitments?: Array<{ type: string; content: string }> };
}

async function loadBatchProjectInput(projectPath: string): Promise<BatchProjectInput | null> {
  const filePath = path.join(projectPath, 'project.yaml');
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), projectPath }, 'batch tools: project.yaml unreadable');
    return null;
  }
  const bomStripped = raw.charCodeAt(0) === BOM_CHAR_CODE ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = yaml.load(bomStripped);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), projectPath }, 'batch tools: project.yaml malformed yaml');
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  // scene_graph：safeParse 降级 undefined（graceful，非崩）。
  let sceneGraph: SceneGraph | undefined;
  if (obj.scene_graph && typeof obj.scene_graph === 'object') {
    const sgResult = sceneGraphSchema.safeParse(obj.scene_graph);
    if (sgResult.success) {
      sceneGraph = sgResult.data;
    } else {
      logger.warn({ err: sgResult.error.message, projectPath }, 'batch tools: scene_graph safeParse failed');
    }
  }

  // episode_outlines / novel.chapters：sub-schema safeParse（mirror runBackfill BMad CR Fix 3——裸 yaml.load
  // 的 index 缺省 / sort_order 字符串坑由 typed parse 消）。失败 → 空集（章分组对账降级）。
  const episodeOutlinesParse = episodeOutlinesSchema.safeParse(obj.episode_outlines);
  const episodeOutlines: BatchEpisodeOutline[] = episodeOutlinesParse.success ? episodeOutlinesParse.data : [];
  const novelParse = novelSchema.safeParse(obj.novel);
  const novelChapters: LandableChapter[] = novelParse.success ? novelParse.data.chapters : [];

  // promise_registry（foreshadow fallback mirror write-chapter loadChainProjectInput B3 fix）。
  let promiseRegistry: PromiseRegistry | undefined;
  if (obj.promise_registry && typeof obj.promise_registry === 'object') {
    const pr = promiseRegistrySchema.safeParse(obj.promise_registry);
    if (pr.success) promiseRegistry = pr.data;
  } else if (obj.foreshadow_registry && typeof obj.foreshadow_registry === 'object') {
    try {
      promiseRegistry = transformForeshadowToPromise(obj.foreshadow_registry as Parameters<typeof transformForeshadowToPromise>[0]);
    } catch {
      promiseRegistry = undefined; // graceful：坏 foreshadow 数据不阻批量（信号降级空 beats）
    }
  }

  // emotion_curve / info_release_map / creative_brief：safeParse 降级。
  const emptyInput: BatchProjectInput = {
    sceneGraph,
    episodeOutlines,
    novelChapters,
  };
  const result: BatchProjectInput = { ...emptyInput };
  if (obj.emotion_curve && typeof obj.emotion_curve === 'object') {
    const ec = emotionCurveSchema.safeParse(obj.emotion_curve);
    if (ec.success) result.emotionCurve = ec.data;
  }
  if (obj.info_release_map && typeof obj.info_release_map === 'object') {
    const ir = infoReleaseMapSchema.safeParse(obj.info_release_map);
    if (ir.success) result.infoReleaseMap = ir.data;
  }
  if (obj.creative_brief && typeof obj.creative_brief === 'object') {
    result.creativeBrief = obj.creative_brief as BatchProjectInput['creativeBrief'];
  }
  return result;
}

/**
 * 章正文是否已落盘（batch_status 对账——进度真相源 = project state，design §6）。
 * CR-013：任一 section content_file 落盘即算 landed（原先只看 sections[0]——多 section 存量数据
 * 下 sections[0] 失效而后续 section 仍落盘时误判未落盘 → 重复写章）。路径穿越防御保留（per-section）。
 */
function chapterProseLanded(projectPath: string, chapters: readonly LandableChapter[], chapterId: string): boolean {
  const chapter = chapters.find((ch) => ch.id === chapterId);
  if (!chapter?.sections?.length) return false;
  const resolvedProject = path.resolve(projectPath);
  for (const section of chapter.sections) {
    const contentFile = typeof section?.content_file === 'string' ? section.content_file : undefined;
    if (!contentFile || contentFile.length === 0) continue;
    const resolvedContent = path.resolve(resolvedProject, contentFile);
    const withinProject =
      resolvedContent === resolvedProject || resolvedContent.startsWith(resolvedProject + path.sep);
    if (!withinProject) {
      logger.warn({ projectPath, contentFile, chapterId }, 'batch tools: content_file escapes project dir → treat this section as not landed');
      continue;
    }
    if (existsSync(resolvedContent)) return true; // 任一 section 落盘 → chapter landed（CR-013）
  }
  return false;
}

/** 每场信号摘要（output 文本——leader LLM 消费的 L1 信号卡，判轻重的底料）。 */
function formatSignalDigest(signal: SceneWeightSignal, graph: SceneGraph | undefined): string {
  const parts: string[] = [];
  if (signal.anchorType) parts.push(`锚点=${signal.anchorType}`);
  parts.push(`因果边=${signal.causalEdgeCount}`);
  if (signal.outcomeType) parts.push(`结果=${signal.outcomeType}`);
  if (signal.pacingRole) parts.push(`张弛=${signal.pacingRole}`);
  if (signal.promiseBeats.length > 0) {
    parts.push(`Promise节拍=${signal.promiseBeats.map((b) => `${b.kind}:${b.promiseTitle ?? b.promiseId}`).join('/')}`);
  }
  if (signal.promiseDueTitles.length > 0) {
    parts.push(`Promise到期=${signal.promiseDueTitles.join('/')}`);
  }
  if (signal.emotion) {
    const mood = signal.emotion.sceneMood ?? '-';
    parts.push(`情绪目标=${mood}(${signal.emotion.characters.length}角色)`);
  }
  if (signal.infoRelease) {
    const modes = signal.infoRelease.modes.length > 0 ? signal.infoRelease.modes.join('/') : '-';
    parts.push(`信息释放=${signal.infoRelease.entryCount}条[${modes}]`);
  }
  if (signal.worldStateSubjects.length > 0) {
    parts.push(`world-state在场=${signal.worldStateSubjects.map((s) => s.subjectId).join('/')}`);
  }
  parts.push(`大纲=${signal.outlineRichness}`);
  const linesLabel = signal.lineTags.length > 0 ? `线=${signal.lineTags.join('/')}` : '';
  return `  · ${signal.sceneId}「${sceneDisplayName(graph?.nodes.find((n) => n.id === signal.sceneId))}」` +
    `${signal.chapterId ? ` → 第${signal.chapterId}章` : '（未指派章）'}${linesLabel ? ` ${linesLabel}` : ''}\n    ${parts.join('；')}`;
}

// ════════════════════════════════════════════════════════════════════════════
// start_batch
// ════════════════════════════════════════════════════════════════════════════

const startBatchParams = z.object({
  lineTag: z.string().min(1).optional().describe('沿哪条线批量（Line.id）——解析「到下一 typed 锚点（含）」的有序场列表'),
  targetAnchorSceneId: z.string().min(1).optional().describe('显式目标锚点场（SceneNode.id）——批量截到此场（含）'),
  sceneIds: z.array(z.string().min(1)).min(1).optional().describe('显式场列表（全控边界；顺序仍解析为因果拓扑序）'),
  gear: participationGearSchema.optional().describe('本批量参与档位（缺省用会话当前档位；提供则同步更新会话档位）'),
}).refine((p) => Boolean(p.lineTag || p.targetAnchorSceneId || p.sceneIds), {
  message: 'lineTag / targetAnchorSceneId / sceneIds 至少提供一个',
});

export const startBatchTool = defineTool({
  id: 'start_batch',
  description:
    '启动批量写作（线/幕级，leader 驱动）：纯代码解析有序场列表（因果拓扑序，截到下一 typed 锚点含）+ ' +
    '每场权重信号卡（L1 机械事实：锚点/Promise 节拍/情绪目标/信息释放/world-state 在场/大纲丰富度）+ ' +
    '场→章分组 + 守门（BATCH_SCENE_CAP）+ 批量状态落盘（.orison/batches.json，可恢复续跑）。' +
    '返回计划 + 信号卡后，你（leader）按系统提示词里的批量协议段执行：通报走向单、逐场判轻重' +
    '（重点场停下问创作选择 / 非重点场调 write_chapter）、escalate 必停、锚点收尾调 end_batch。',
  parameters: startBatchParams,
  async execute(params, ctx) {
    // ── 权卫（design §6：readonly 批量产 patch 无写权；discuss 模式禁写）──
    const session = getSession(ctx.sessionId);
    const permissionMode = session?.permissionMode ?? 'suggest';
    const behaviorMode = session?.behaviorMode ?? 'normal';
    if (permissionMode === 'readonly') {
      return {
        title: 'start_batch',
        output: '当前会话是只读（微操）模式，批量写作需要写权限（产章节候选 patch）。请作者切到建议/自动模式后再启动批量。',
      };
    }
    if (behaviorMode === 'discuss') {
      return {
        title: 'start_batch',
        output: '当前会话是讨论（discuss）行为模式——本轮只对话不写作，不能启动批量。请先切回 normal/plan 模式。',
      };
    }

    // ── 单活跃批量不变式（CR-007：project 级，非 session 级）──
    // 单活跃是 project 级协议约定：会话 B 不得在另一会话的 running/paused 未收口时开第二条
    // （旧 running 对属主永久堵死 + chapterMap 可交叠双写）。他 会话 健在 → 提示到该会话操作；
    // 孤儿（属主会话已删）→ 本会话可经 batch_status / end_batch 接管收口（两者过滤同含孤儿可见性）。
    const nonTerminalRuns = (loadBatchRuns(ctx.projectPath) ?? [])
      .filter((r) => r.status === 'running' || r.status === 'paused')
      .sort((a, b) => b.createdAt - a.createdAt);
    if (nonTerminalRuns.length > 0) {
      const r = nonTerminalRuns[0];
      const foreignAlive =
        r.sessionId !== undefined && r.sessionId !== ctx.sessionId && sessionExistsOnDisk(ctx.projectPath, r.sessionId);
      const guardOutput = foreignAlive
        ? `已有批量正在其他会话进行（batchId=${r.batchId}，status=${r.status}，${r.doneSceneIds.length}/${r.orderedSceneIds.length} 场）。到该会话继续或收口后再开新批量。`
        : r.sessionId !== undefined && r.sessionId !== ctx.sessionId
          ? `存在未收口的遗留批量（batchId=${r.batchId}，status=${r.status}，其所属会话已不存在）。本会话可调 batch_status 对账接管续跑，或 end_batch({outcome:"aborted"}) 收口后再开新批量。`
          : `已有活跃批量（batchId=${r.batchId}，${r.doneSceneIds.length}/${r.orderedSceneIds.length} 场，status=${r.status}）。先用 batch_status 对账续跑，或 end_batch 收口后再开新批量。`;
      return { title: 'start_batch', output: guardOutput };
    }

    // ── project 数据 ──
    const project = await loadBatchProjectInput(ctx.projectPath);
    if (!project) {
      return { title: 'start_batch', output: `Cannot start batch: project.yaml at ${ctx.projectPath} is missing or unreadable.` };
    }
    if (!project.sceneGraph) {
      return { title: 'start_batch', output: 'project.yaml 无有效 scene_graph（缺失或 schema 解析失败），无法解析批量场列表。' };
    }

    // ── 场列表解析（纯代码，graceful failure 给 leader 作一次咨询）──
    const plan = resolveBatchScenePlan({
      sceneGraph: project.sceneGraph,
      ...(params.lineTag ? { lineTag: params.lineTag } : {}),
      ...(params.targetAnchorSceneId ? { targetAnchorSceneId: params.targetAnchorSceneId } : {}),
      ...(params.sceneIds ? { sceneIds: params.sceneIds } : {}),
    });
    if (!plan.ok) {
      return { title: 'start_batch', output: `批量边界无法机械解析（${plan.reason}）：${plan.detail}\n请与作者澄清批量边界后重试。` };
    }

    // ── BATCH_SCENE_CAP 守门（design §6 预算上限）──
    if (plan.orderedSceneIds.length > BATCH_SCENE_CAP) {
      return {
        title: 'start_batch',
        output: `批量场数 ${plan.orderedSceneIds.length} 超过上限 ${BATCH_SCENE_CAP}。请换更近的锚点（targetAnchorSceneId）或显式传 sceneIds 缩小范围。`,
      };
    }

    // ── 场→章分组（无章映射 graceful 上报「需先指派章」）──
    const grouping = groupScenesByChapter(
      project.sceneGraph,
      plan.orderedSceneIds,
      project.episodeOutlines,
      project.novelChapters,
    );
    if (grouping.unmappedSceneIds.length > 0) {
      return {
        title: 'start_batch',
        output:
          `以下场未指派承载章（episodeId / presentationSpans 缺失或对应章未注册），批量前需先指派：\n` +
          grouping.unmappedSceneIds.map((id) => `  · ${id}「${sceneDisplayName(project.sceneGraph!.nodes.find((n) => n.id === id))}」`).join('\n') +
          `\n可调 scene_graph_update 为这些场指派 episode（走 PatchReview 人审）。`,
      };
    }

    // ── 信号汇编（L1 纯代码；world-state patches 取数 graceful）──
    // CR-018：fetchWorldPatchesViaTool 外层加 try/catch——agent 内部 helper 有 try/catch 返 undefined，
    // 但再加一层防内部重构/未来抛错（违自身 graceful 声明）炸掉整个 start_batch：降级 null + 不触工具。
    let patches: Awaited<ReturnType<typeof fetchWorldPatchesViaTool>> = undefined;
    try {
      patches = await fetchWorldPatchesViaTool(ctx.projectPath);
    } catch (err) {
      logger.warn(
        { projectPath: ctx.projectPath, err: err instanceof Error ? err.message : String(err) },
        'start_batch: fetchWorldPatchesViaTool threw unexpectedly → graceful null (world-state signals degrade)',
      );
      patches = undefined;
    }
    const worldStatePatchCounts = new Map<string, number>();
    if (patches) {
      for (const p of patches) {
        worldStatePatchCounts.set(p.subjectId, (worldStatePatchCounts.get(p.subjectId) ?? 0) + 1);
      }
    }
    const signals = assembleSceneWeightSignals(
      {
        sceneGraph: project.sceneGraph,
        episodeOutlines: project.episodeOutlines,
        ...(project.promiseRegistry ? { promiseRegistry: project.promiseRegistry } : {}),
        ...(project.emotionCurve ? { emotionCurve: project.emotionCurve } : {}),
        ...(project.infoReleaseMap ? { infoReleaseMap: project.infoReleaseMap } : {}),
        worldStatePatchCounts,
      },
      plan.orderedSceneIds,
      grouping.chapterMap,
    );
    const genreCommitments = extractGenreCommitments(project.creativeBrief);

    // ── 档位（params.gear 提供则同步会话——「切到 X 档跑这条线」语义）──
    const gear = params.gear ?? session?.participationGear ?? 'smart';
    if (params.gear && session) {
      updateSessionParticipationGear(ctx.sessionId, params.gear);
    }

    // ── 落盘 + 盖章 registry（mid-turn 生效）──
    const now = Date.now();
    const batch = {
      batchId: `batch-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
      ...(plan.lineTag ? { lineTag: plan.lineTag } : {}),
      ...(plan.targetAnchorSceneId ? { targetAnchorSceneId: plan.targetAnchorSceneId } : {}),
      orderedSceneIds: plan.orderedSceneIds,
      doneSceneIds: [] as string[],
      gear,
      status: 'running' as const,
      chapterMap: grouping.chapterMap,
      sessionId: ctx.sessionId,
    };
    upsertBatchRun(ctx.projectPath, batch);
    setActiveBatchStamp(ctx.projectPath, batch.batchId, ctx.sessionId);

    // ── output（leader 消费：计划 + 信号卡 + 承诺对照底料）──
    const chapterCount = new Set(Object.values(grouping.chapterMap)).size;
    const lines: string[] = [
      `批量已启动（batchId=${batch.batchId}，档位=${gear}，${plan.orderedSceneIds.length} 场 / ${chapterCount} 章` +
        `${plan.targetAnchorSceneId ? `，目标锚点=${plan.targetAnchorSceneId}` : ''}）：`,
      '有序场列表（因果拓扑序）+ 每场权重信号卡（L1 机械事实——判轻重归你，对照题材承诺与作者意图）：',
      ...signals.map((s) => formatSignalDigest(s, project.sceneGraph)),
    ];
    if (genreCommitments.length > 0) {
      lines.push('题材承诺（GenreContract，判「同信号在这个题材里算多重」的对照底料）：');
      for (const c of genreCommitments) {
        lines.push(`  · [${c.type}] ${c.content}`);
      }
    } else {
      lines.push('题材承诺：本项目 creative_brief.commitments 为空（无承诺底料，判轻重靠上下文与作者意图）。');
    }
    lines.push(
      '下一步按你系统提示词中的「批量写作协议」执行：先向作者通报走向单（本档位是否等确认见协议），' +
        '然后逐场判轻重推进；每写完一章/一场用 batch_status 对账；到锚点或全部完成调 end_batch({outcome:"done"}) 收尾。',
    );

    return {
      title: `start_batch: ${plan.lineTag ?? plan.targetAnchorSceneId ?? `${plan.orderedSceneIds.length} scenes`}`,
      output: lines.join('\n'),
      metadata: {
        type: 'batch_started',
        batch,
        signals,
        ...(genreCommitments.length > 0 ? { genreCommitments } : {}),
      },
    };
  },
});

// ════════════════════════════════════════════════════════════════════════════
// batch_status
// ════════════════════════════════════════════════════════════════════════════

export const batchStatusTool = defineTool({
  id: 'batch_status',
  description:
    '查询/恢复批量状态：读 .orison/batches.json 活跃批量 + 与 project state 对账（章正文已落盘的场标记完成）' +
    '+ 刷新剩余场权重信号卡。崩溃/abort/咨询后说「继续」时先调本工具重导进度再续跑（paused → running）。',
  parameters: z.object({}),
  async execute(_params, ctx) {
    // 非终态批量（running / paused——paused = 崩溃/中断残留，对账即续跑语义）。
    const runs = loadBatchRuns(ctx.projectPath);
    const nonTerminal = (runs ?? [])
      .filter((r) => (r.status === 'running' || r.status === 'paused') && ownedOrOrphan(r, ctx))
      .sort((a, b) => b.createdAt - a.createdAt);
    if (nonTerminal.length === 0) {
      // CR-007：本会话无可见批量，但 project 级可能有他 会话 running（不可见防误操作）——提示防困惑
      // （与 start_batch 的 project 级守卫口径闭环）。
      const foreignAliveRun = (runs ?? []).find(
        (r) =>
          r.status === 'running' &&
          r.sessionId !== undefined &&
          r.sessionId !== ctx.sessionId &&
          sessionExistsOnDisk(ctx.projectPath, r.sessionId),
      );
      if (foreignAliveRun) {
        return { title: 'batch_status', output: `本会话无活跃批量；有批量正在其他会话进行（batchId=${foreignAliveRun.batchId}）——到该会话操作。` };
      }
      return { title: 'batch_status', output: '当前无活跃批量（无 running/paused 记录）。要开新批量用 start_batch。' };
    }
    let batch = nonTerminal[0];

    const project = await loadBatchProjectInput(ctx.projectPath);
    if (!project) {
      return { title: 'batch_status', output: `project.yaml 不可读（${ctx.projectPath}），无法对账；批量状态：${batch.doneSceneIds.length}/${batch.orderedSceneIds.length} 场（disk 记录，未对账）。` };
    }

    // ── 对账：章正文已落盘的场 → done（进度真相源 = project state，design §6）──
    const doneSet = new Set(batch.doneSceneIds);
    const newlyDone: string[] = [];
    for (const sceneId of batch.orderedSceneIds) {
      if (doneSet.has(sceneId)) continue;
      const chapterId = batch.chapterMap[sceneId];
      if (chapterId && chapterProseLanded(ctx.projectPath, project.novelChapters, chapterId)) {
        doneSet.add(sceneId);
        newlyDone.push(sceneId);
      }
    }
    const statusChanged = newlyDone.length > 0 || batch.status === 'paused';
    if (statusChanged) {
      batch = {
        ...batch,
        // 保持 orderedSceneIds 序（导航态稳定）。
        doneSceneIds: batch.orderedSceneIds.filter((id) => doneSet.has(id)),
        status: 'running',
        updatedAt: Date.now(),
      };
      upsertBatchRun(ctx.projectPath, batch);
    }
    setActiveBatchStamp(ctx.projectPath, batch.batchId, ctx.sessionId);

    // ── 剩余场信号刷新 + worldStatePatchCounts ──
    // CR-012：同 start_batch fetch+传 worldStatePatchCounts（主角安危底料），否则续跑/恢复场景恒缺
    // world-state 在场信号（worldStateSubjects[] 恒空——安危判定结构底料丢失）。
    // Story 8.4 Step 4（A8 批量挂起继续他章）：挂起场（出发核查矛盾/超限被跳过）剔出待推进——批量继续
    // 他章；已落盘的挂起章（决断后重写落盘 → 对账转 done）不再算挂起（done 优先）。
    const suspendedActive = (batch.suspendedSceneIds ?? []).filter((id) => !doneSet.has(id));
    const remaining = batch.orderedSceneIds.filter((id) => !doneSet.has(id) && !suspendedActive.includes(id));
    let worldPatches: Awaited<ReturnType<typeof fetchWorldPatchesViaTool>> = undefined;
    try {
      worldPatches = await fetchWorldPatchesViaTool(ctx.projectPath);
    } catch (err) {
      logger.warn(
        { projectPath: ctx.projectPath, err: err instanceof Error ? err.message : String(err) },
        'batch_status: fetchWorldPatchesViaTool threw → graceful null (like start_batch CR-018 guard)',
      );
      worldPatches = undefined;
    }
    const statusWorldPatchCounts = new Map<string, number>();
    if (worldPatches) {
      for (const p of worldPatches) {
        statusWorldPatchCounts.set(p.subjectId, (statusWorldPatchCounts.get(p.subjectId) ?? 0) + 1);
      }
    }
    const signals = remaining.length > 0 && project.sceneGraph
      ? assembleSceneWeightSignals(
        {
          sceneGraph: project.sceneGraph,
          episodeOutlines: project.episodeOutlines,
          ...(project.promiseRegistry ? { promiseRegistry: project.promiseRegistry } : {}),
          ...(project.emotionCurve ? { emotionCurve: project.emotionCurve } : {}),
          ...(project.infoReleaseMap ? { infoReleaseMap: project.infoReleaseMap } : {}),
          worldStatePatchCounts: statusWorldPatchCounts,
        },
        remaining,
        batch.chapterMap,
      )
      : [];

    const lines: string[] = [
      `批量状态（batchId=${batch.batchId}，启动档位=${batch.gear}${liveGearSuffix(ctx, batch.gear)}）：${batch.doneSceneIds.length}/${batch.orderedSceneIds.length} 场已完成` +
        `${newlyDone.length > 0 ? `（对账新确认 ${newlyDone.length} 场：${newlyDone.join(', ')}）` : ''}。`,
    ];
    if (remaining.length === 0 && suspendedActive.length === 0) {
      lines.push('全部场已完成——请调 end_batch({outcome:"done"}) 收口，然后按协议收尾（present_result + L0 全景 + 验收项 + stale 引导）。');
    } else {
      if (remaining.length > 0) {
        lines.push(`剩余 ${remaining.length} 场：`);
        for (const s of signals) {
          lines.push(formatSignalDigest(s, project.sceneGraph));
        }
        lines.push('续跑：逐场判轻重（重点场停下问 / 非重点调 write_chapter 带 chapterId）——协议见系统提示词批量段。');
      }
      // Story 8.4 Step 4：挂起章呈报（batch 报告呈现挂起原因的 status 侧；L0 全景在 end_batch 收尾）。
      if (suspendedActive.length > 0) {
        lines.push(
          `挂起 ${suspendedActive.length} 场（出发核查矛盾/超限被跳过，批量继续他章）：${suspendedActive.join(', ')}——待作者决断（改任务卡/改设定/维持原案）后重调 write_chapter 重写该章。`,
        );
      }
    }

    return {
      title: `batch_status: ${batch.batchId}`,
      output: lines.join('\n'),
      metadata: {
        type: 'batch_status',
        batch,
        signals,
        ...(newlyDone.length > 0 ? { newlyDoneSceneIds: newlyDone } : {}),
      },
    };
  },
});

/**
 * CR-007：非终态批量对本会话的可见性。属主匹配 / legacy 无属主 / 孤儿（属主会话已删——可接管收口）
 * 可见；仅「他 会话 健在」不可见（防误操作他人活跃批量——start_batch 守卫以 project 级口径提示到
 * 该会话操作）。与 batch-state findActiveBatchRun 的孤儿可见性同语义（盖章/协议随接管会话生效）。
 */
function ownedOrOrphan(run: { sessionId?: string }, ctx: ToolContext): boolean {
  if (run.sessionId === undefined || run.sessionId === ctx.sessionId) return true;
  return !sessionExistsOnDisk(ctx.projectPath, run.sessionId);
}

/** live 档位与启动档位不同时标注「，会话当前档位=X（已切档）」——随时调档的可见性（R3/AC3）。 */
function liveGearSuffix(ctx: ToolContext, batchGear: string): string {
  const live = getSession(ctx.sessionId)?.participationGear;
  return live !== undefined && live !== batchGear ? `，会话当前档位=${live}（已切档）` : '';
}

// ════════════════════════════════════════════════════════════════════════════
// end_batch
// ════════════════════════════════════════════════════════════════════════════

export const endBatchTool = defineTool({
  id: 'end_batch',
  description:
    '收口批量（到锚点 / 全部完成 → outcome:"done"；作者中止 → outcome:"aborted"）。done 后同 turn 的收尾全景消息' +
    '会被标为批量 report（UI 渐进披露渲染源）。收尾协议（present_result + L0 全景 + 待验收项 + stale 引导 ' +
    'diagnose_impacts）见系统提示词批量段。',
  parameters: z.object({
    outcome: z.enum(['done', 'aborted']).describe('done=到锚点/全部完成收口；aborted=作者中止放弃'),
  }),
  async execute(params, ctx) {
    const runs = loadBatchRuns(ctx.projectPath);
    const nonTerminal = (runs ?? [])
      .filter((r) => (r.status === 'running' || r.status === 'paused') && ownedOrOrphan(r, ctx))
      .sort((a, b) => b.createdAt - a.createdAt);
    if (nonTerminal.length === 0) {
      return { title: 'end_batch', output: '当前无活跃批量可收口。' };
    }
    const batch = {
      ...nonTerminal[0],
      status: params.outcome === 'done' ? ('done' as const) : ('aborted' as const),
      updatedAt: Date.now(),
    };
    upsertBatchRun(ctx.projectPath, batch);

    const lines: string[] = [
      `批量已${params.outcome === 'done' ? '收口（done）' : '中止（aborted）'}（batchId=${batch.batchId}，完成 ${batch.doneSceneIds.length}/${batch.orderedSceneIds.length} 场）。`,
    ];
    // Story 8.4 Step 4（A8）：批量报告呈现挂起章（未写非完成——L0 全景逐章 verdict 时挂起章单列，
    // 不混入已完成计数；metadata.batch.suspendedSceneIds 随 BatchReportCard 数据源透出）。
    const suspendedLeft = (batch.suspendedSceneIds ?? []).filter(
      (id) => !batch.doneSceneIds.includes(id),
    );
    if (suspendedLeft.length > 0) {
      lines.push(
        `其中 ${suspendedLeft.length} 场挂起未写（出发核查矛盾/超限，等待作者决断后重写该章）：${suspendedLeft.join(', ')}。`,
      );
    }
    if (params.outcome === 'done') {
      // report 盖章：同 turn 收尾全景消息（L0）标 batchKind='report'（design §5.1）。
      markBatchStampReport(ctx.projectPath, batch.batchId, batch.sessionId);
      lines.push('接下来按收尾协议执行：present_result 收尾 + L0 全景（各章 verdict 一行式）+ 待验收项清单 + 若批量写作产生了 stale 字段，引导作者调 diagnose_impacts。');
    } else {
      clearActiveBatchStamp(ctx.projectPath);
    }
    return { title: `end_batch: ${batch.batchId}`, output: lines.join('\n'), metadata: { type: 'batch_ended', batch } };
  },
});

// ════════════════════════════════════════════════════════════════════════════
// set_participation_gear（chat 指令调档入口，design §2.1 三入口之一）
// ════════════════════════════════════════════════════════════════════════════

const setParticipationGearParams = z.object({
  gear: participationGearSchema.describe('目标档位：smart（智能判轻重）/ steer（每场写前问）/ balanced（走向单等确认+圈类别命中问）/ hands_off（零问+验收清单）'),
  balancedAskCategories: z.array(z.enum(['protagonist_safety', 'information_gap', 'direction_turn'])).min(1).optional()
    .describe('balanced 档圈定的必问类别（缺省三项全；仅在需要收窄时提供）'),
  trustAdjudication: z.boolean().optional().describe('hands_off 档灰区处置：false=仍停下问（安全默认）/ true=信任裁决器初审继续。BLOCK 硬违规任何配置都不豁免。'),
});

export const setParticipationGearTool = defineTool({
  id: 'set_participation_gear',
  description:
    '设置本会话参与档位（作者在对话里说「切到掌舵档」「放手跑」等时调）。Session 级持久化；批量中途切档下一场生效' +
    '（不回改已写场）。批量协议段（各档问什么/何时问）在下一轮系统提示词中生效。',
  parameters: setParticipationGearParams,
  async execute(params, ctx) {
    // 须先 getSession 用于最终文案——CR-014：additive setter 保留旧键，生效值非 = params，须读写入后
    // 的 session 实际值（未传 balancedAskCategories/trustAdjudication 时 params 是 undefined 不应谎报 false / 默认）。
    const session = getSession(ctx.sessionId);
    if (!session) {
      return { title: 'set_participation_gear', output: '会话不存在，无法设置档位。' };
    }
    // 直接字段更新（非 setSessionParticipationGear 的 running 拒绝路径——chat 工具天然在运行中调用；
    // gear 消费点在 prompt 构建/下场判轻重，mid-run 写入安全且正是「下一场生效」语义，design §2.1）。
    updateSessionParticipationGear(ctx.sessionId, params.gear, {
      ...(params.balancedAskCategories ? { balancedAskCategories: params.balancedAskCategories } : {}),
      ...(params.trustAdjudication !== undefined ? { trustAdjudication: params.trustAdjudication } : {}),
    });
    // CR-014：文案读 **生效值**（getSession 再取——zod 已校验 params，但 additive setter 对未传键
    // 保留旧 session 值，故实际 trust / cats 须从 session 读而非 params）。如未显式传 cats → 兜底默认三项；
    // 理论在 balanced 下不会出现 missing（旧 session 仍负向但兜底健康）。
    const liveSession = getSession(ctx.sessionId);
    const liveGear = liveSession?.participationGear ?? params.gear;
    const liveCats = liveSession?.balancedAskCategories ?? BALANCED_ASK_CATEGORIES_DEFAULT;
    const liveTrust = liveSession?.trustAdjudication ?? false;
    return {
      title: `set_participation_gear: ${liveGear}`,
      output:
        `参与档位已设置为 ${liveGear}（下一轮/下一场生效）。` +
        (liveGear === 'balanced' ? `balanced 圈定必问类别：${liveCats.join(' / ')}。` : '') +
        (liveGear === 'hands_off' ? `灰区处置 trustAdjudication=${liveTrust}${liveTrust ? '（信裁决器初审；BLOCK 硬违规仍必停）' : '（仍停下问，安全默认）'}。` : '') +
        '请向作者确认已切换。',
    };
  },
});
