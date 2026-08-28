import {
  CHECKPOINT_MIN_PATCH_DELTA,
  assembleChapterStateSummary,
  episodeOutlineSchema,
  isSceneInEpisode,
  promiseBeatSchema,
  promiseEntrySchema,
  sceneNodeSchema,
  type ChapterSubjectActivityInput,
  type PromiseBeat,
  type PromiseEntry,
  type ReducedState,
  type SceneNode,
  type WorldSlice,
} from '@orison/shared-contracts';
import { getLogger } from '../logger';
import { reindexChapterSummaryEntry } from './chapterSummaryIndexer';
import {
  backfillWorldSliceEpisodeIds,
  getWorldPatchRowidHigh,
  listWorldSlices,
  listWorldSubjects,
  parseEpisodeIdFromSliceId,
  reduceWorldSubjectCheckpointed,
  upsertChapterSummaryWithCheckpoints,
  type CheckpointedReduceResult,
  type WorldCheckpointInsert,
} from './worldStateRepository';

// ── Story 8.1（Step 3）：ChapterStateSummary 物化核心（design §2/§3.3/§5）──
//
// materialize_chapter_summary 的组装核心：db 单次全扫（slices+patches → 本章窗 / per-episode 归类 /
// per-subject 活动）+ project.yaml 三源（episode_outlines / promise_registry / scene_graph.nodes）
// → assembleChapterStateSummary 纯函数（shared-contracts 单源）→ 单 WAL 事务落 summary + 机会式
// checkpoint。
//
// **归属层（CR-8，8.1 修复批）**：本模块住 db 层（`main/db/`），非 ipc/toolHandlers——原实现放 handler
// 文件导致 db 层 worldStateBackfill 反向 import ipc 层（分层倒置）。IPC 壳（worldStateHandlers 的
// materializeChapterSummaryHandler）与 db 层消费者（worldStateBackfill 的 rebuildChapterSummaries）
// 都从本模块 import，函数签名零变。
//
// 范式判据（ADR-3）：六字段全部「查询/汇编/确定性计算」over 既有 LLM 已产结构化数据（patches/subjects/
// promise_registry）；project.yaml 读取遵守 db-repository.md「组装层 direct 字段抽取 + per-element
// safeParse」Convention（不 full parent schema safeParse——parent 含 required-no-default 字段如
// creativeBrief.rawRequirement，full parse 会因无关字段缺失失败丢全数据）。

/** project.yaml 直读源（direct 抽取 + per-element safeParse，db-repository.md Convention）。 */
interface ChapterProjectSources {
  /** episode_outlines 投影（id/index/title；坏条目丢好条目留）。空数组 = 源缺失。 */
  outlines: Array<{ id: string; index: number; title: string }>;
  /** promise_registry promises；null = 源缺失（③⑤⑥ degraded + degradedNote，design §5）。 */
  promises: PromiseEntry[] | null;
  /** promise_registry beats（per-element safeParse 后）。 */
  beats: PromiseBeat[];
  /** sceneRef → SceneNode（beat 场归属解析；dangling sceneRef 不进 map）。 */
  sceneById: Map<string, SceneNode>;
}

/**
 * 读 materialize 需要的三个 creative field（episode_outlines / promise_registry / scene_graph.nodes）。
 *
 * loader 选 local-bff `loadProject` 单源（mirror promiseLedgerHandlers.readPromiseRegistry /
 * closureChainIpc——含 1.2/1.3/6.5 就地迁移 + 整档 schema 校验，shell 不自带第二套 yaml 读法）；本函数
 * 只做 **direct 字段抽取 + per-element safeParse**（不 full parent schema safeParse——parent 含
 * required-no-default 字段如 creativeBrief.rawRequirement，full parse 会因无关字段缺失失败丢全数据）。
 *
 * 缺源 graceful（design §5）：loadProject 抛/null → 全缺（outlines 空 + promises null）；单 field 缺 →
 * 该 field degraded，不阻断物化（summary 是 DERIVED，db 侧数据照常汇编）。
 */
async function readChapterProjectSources(projectDir: string): Promise<ChapterProjectSources> {
  let doc: Record<string, unknown> | null = null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    // loadProject 正常不抛（corrupt 返 null）；抛是异常。物化是 DERIVED 摘要，降级不阻断。
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectDir }, 'materialize_chapter_summary: loadProject threw');
  }
  if (doc === null) {
    return { outlines: [], promises: null, beats: [], sceneById: new Map() };
  }

  // episode_outlines：direct 抽取 + per-element safeParse。
  const outlinesRaw = doc.episode_outlines;
  const outlines = Array.isArray(outlinesRaw)
    ? outlinesRaw.flatMap((o) => {
        const parsed = episodeOutlineSchema.safeParse(o);
        return parsed.success
          ? [{ id: parsed.data.id, index: parsed.data.index, title: parsed.data.title }]
          : [];
      })
    : [];

  // promise_registry：field 缺 → null（degraded）；有 → per-element safeParse promises/beats。
  const registryRaw = doc.promise_registry;
  let promises: PromiseEntry[] | null = null;
  let beats: PromiseBeat[] = [];
  if (registryRaw && typeof registryRaw === 'object') {
    const r = registryRaw as { promises?: unknown; beats?: unknown };
    promises = Array.isArray(r.promises)
      ? r.promises.flatMap((p) => {
          const parsed = promiseEntrySchema.safeParse(p);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    beats = Array.isArray(r.beats)
      ? r.beats.flatMap((b) => {
          const parsed = promiseBeatSchema.safeParse(b);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }

  // scene_graph.nodes：per-element safeParse → Map（beat 场归属解析用 episodeId/presentationSpans）。
  const sceneNodesRaw = (doc.scene_graph as { nodes?: unknown } | undefined)?.nodes;
  const sceneById = new Map<string, SceneNode>();
  if (Array.isArray(sceneNodesRaw)) {
    for (const node of sceneNodesRaw) {
      const parsed = sceneNodeSchema.safeParse(node);
      if (parsed.success) sceneById.set(parsed.data.id, parsed.data);
    }
  }

  return { outlines, promises, beats, sceneById };
}

/**
 * 读 episode_outlines 的已知 episode id 集（CR-13，8.1 修复批）：rebuildChapterSummaries 的幻影前缀
 * gate 用——slice.id 前缀解析出的 episode id 须在此集内才物化（'am-fix:200' 这类修补标签前缀不造
 * 幻影 summary 行）。源缺失 → 空集（caller 记 warn）。
 */
export async function readKnownEpisodeIds(projectDir: string): Promise<Set<string>> {
  const sources = await readChapterProjectSources(projectDir);
  return new Set(sources.outlines.map((o) => o.id));
}

/** beat 的候选 episode ids（episodeId 直挂 + scene 单挂 + presentationSpans 全展开——M:N 场跨多章）。 */
function beatEpisodeCandidates(beat: PromiseBeat, sceneById: Map<string, SceneNode>): string[] {
  const out: string[] = [];
  if (beat.episodeId !== undefined) out.push(beat.episodeId);
  const scene = sceneById.get(beat.sceneRef);
  if (scene !== undefined) {
    if (scene.episodeId !== undefined) out.push(scene.episodeId);
    for (const span of scene.presentationSpans ?? []) out.push(span.episodeId);
  }
  return out;
}

/**
 * beat 是否归属某 episode：episodeId 直挂 OR scene 命中（isSceneInEpisode 单源——episodeId / spans M:N）。
 * chapterBeats / beatsNextEpisode 的 membership 判定（离散目标 episode 直判）。
 */
function beatInEpisode(
  beat: PromiseBeat,
  episodeId: string,
  sceneById: Map<string, SceneNode>,
): boolean {
  if (beat.episodeId === episodeId) return true;
  const scene = sceneById.get(beat.sceneRef);
  return scene !== undefined && isSceneInEpisode(scene, episodeId);
}

/**
 * beat 的归属 episode index（beatsBefore/beatsThrough 的序判定）：候选 episodes 的**最小** index
 * （多候选 = M:N 跨章场——取最早呈现章：beat 在读者首次见到的场发生；确定性归一）。候选全不可解析
 * （dangling sceneRef 且无 episodeId）→ null（序判定排除该 beat，机械跳过 mirror assemble ③ dangling）。
 */
function beatMinEpisodeIndex(
  beat: PromiseBeat,
  sceneById: Map<string, SceneNode>,
  indexById: Map<string, number>,
): number | null {
  let min: number | null = null;
  for (const epId of beatEpisodeCandidates(beat, sceneById)) {
    const idx = indexById.get(epId);
    if (idx !== undefined && (min === null || idx < min)) min = idx;
  }
  return min;
}

/**
 * slice 的 episode 归属：episode_id 列优先；存量行 NULL → slice.id 硬化前缀解析
 * （parseEpisodeIdFromSliceId 单源：最后一个 `:` 后缀为纯数字才归属，CR-13）。
 *
 * 导出供 `db/worldStateBackfill.ts` 复用（Story 8.1 Step 6）——backfill 的「有 slices 的 episode」归类
 * 与 materialize 内部归类必须同源（同一分类器两处漂移 = 漏物化/错归属）。
 */
export function worldSliceEpisodeId(slice: WorldSlice): string | undefined {
  if (slice.episodeId !== undefined) return slice.episodeId;
  return parseEpisodeIdFromSliceId(slice.id);
}

/** materialize 核心结果（handler 返回 + Step 6 backfill 复用形态）。 */
export interface MaterializeChapterSummaryResult {
  summary: ReturnType<typeof assembleChapterStateSummary>['summary'];
  tokenEstimate: number;
  /** 本次写入的 checkpoint 数（lazy 首建 + 阈值推进）。 */
  checkpointCount: number;
}

/**
 * materialize 核心（handler 主体，导出供 Step 6 backfill「重提取后逐 episode 重建」复用）：
 * db 单次全扫（slices+patches → 本章窗 / per-episode 归类 / per-subject 活动）+ project.yaml 三源
 * → assembleChapterStateSummary 纯函数 → 单 WAL 事务落 summary + 机会式 checkpoint。
 *
 * 全扫选择（vs 前两章各查一次）：dormant 的 lastChangedEpisodeId 回溯锚需要每 subject 的**最后 patch
 * 所属 episode**（可能远早于 N-2），3 次 per-episode 查询盖不住；单次 in-process SQL 扫描（每章一次，
 * 物化是后台写路径）覆盖全部归类需求，一条代码路径。
 *
 * 机会式 checkpoint（design §3.1 增量阈值式）：本章触及 subject 中——miss 路径已被 endState fold 的
 * lazy 首建覆盖（reduceWorldSubjectCheckpointed writeCheckpoint 默认 true）；hit 且折叠增量
 * ≥ CHECKPOINT_MIN_PATCH_DELTA(25) 者推进到本章末（fold 窗上界 = 25/subject）。CR-10：推进行的
 * patchCountFolded 自**命中点**累计（fold.hitPatchCountFolded + 窗内数），不重查 latest 取基数。
 */
export async function materializeChapterSummaryCore(
  projectId: string,
  projectDir: string,
  episodeId: string,
): Promise<MaterializeChapterSummaryResult> {
  // ── 存量行 episode_id 懒补（design §4：一次性 backfill UPDATE，幂等——首跑补齐后常态返 0；
  //    CR-12 EXISTS 守卫使常态零 UPDATE 开销）──
  backfillWorldSliceEpisodeIds(projectId);

  // ── db：单次全扫 ──
  const allSlices = listWorldSlices(projectId, { withPatches: true });

  // ── project.yaml 三源 ──
  const sources = await readChapterProjectSources(projectDir);
  const indexById = new Map(sources.outlines.map((o) => [o.id, o.index]));
  const n = indexById.get(episodeId) ?? null;
  const nextEpisodeId =
    n === null ? null : (sources.outlines.find((o) => o.index === n + 1)?.id ?? null);

  // ── 本章窗 + 本章 patches ──
  const chapterSlices = allSlices.filter((s) => worldSliceEpisodeId(s) === episodeId);
  const storyTimeStart =
    chapterSlices.length > 0 ? chapterSlices[0].storyTime : null;
  const storyTimeEnd =
    chapterSlices.length > 0 ? chapterSlices[chapterSlices.length - 1].storyTime : null;
  const chapterPatches = chapterSlices.flatMap((s) => s.patches ?? []);
  const touched = new Set(chapterPatches.map((p) => p.subjectId));

  // ── per-subject 活动（cast/dormancy 判定 + dormant 回溯锚）──
  interface SubjectActivity {
    lastStoryTime: number;
    lastEpisodeId: string | undefined;
    maxEpisodeIndex: number | null;
  }
  const activity = new Map<string, SubjectActivity>();
  for (const slice of allSlices) {
    const epId = worldSliceEpisodeId(slice);
    const epIndex = epId !== undefined ? (indexById.get(epId) ?? null) : null;
    // CR-4（8.1 修复批）：as-of-N 截断——物化第 N 章时表里可能已有 index > N 的 slices（backfill 先跑
    // 后章提取 / 非线性写作序）。cast/dormancy 判定与 lastChangedEpisodeId 回溯锚都以**本章视角**截断：
    // 未来章数据不进本章活动归类（endState fold 已按 storyTimeEnd 截断，此处补活动侧同界）。
    if (n !== null) {
      if (epIndex !== null) {
        if (epIndex > n) continue;
      } else {
        // episode 归属不可解析（outlines 缺该 episode 等）：有本章窗按 storyTime 截断；无窗（本章无
        // slices）保守不计——无法证明它属于 ≤ N 的过去。
        const withinWindow = storyTimeEnd !== null && slice.storyTime <= storyTimeEnd;
        if (!withinWindow) continue;
      }
    }
    for (const patch of slice.patches ?? []) {
      const cur =
        activity.get(patch.subjectId) ?? {
          lastStoryTime: Number.NEGATIVE_INFINITY,
          lastEpisodeId: undefined,
          maxEpisodeIndex: null,
        };
      // slices 已按 story_time 升序——同 storyTime 取首个（确定性）。
      if (patch.storyTime > cur.lastStoryTime) {
        cur.lastStoryTime = patch.storyTime;
        cur.lastEpisodeId = epId;
      }
      if (epIndex !== null && (cur.maxEpisodeIndex === null || epIndex > cur.maxEpisodeIndex)) {
        cur.maxEpisodeIndex = epIndex;
      }
      activity.set(patch.subjectId, cur);
    }
  }

  // 活跃 cast（assemble ① 的折叠集）：n 已知 = 本章 N 与前两章内有 patch 者；n null（outlines 缺 index）
  // = 仅本章触及者（assemble degraded 分支只收录已折叠 subject，不标 dormant）。
  const activeIds = new Set<string>();
  for (const [subjectId, act] of activity) {
    if (n !== null) {
      if (act.maxEpisodeIndex !== null && act.maxEpisodeIndex >= n - 2) activeIds.add(subjectId);
    } else if (touched.has(subjectId)) {
      activeIds.add(subjectId);
    }
  }

  // endState 折叠（checkpoint-backed；fold 结果留作机会式 checkpoint 判定）。at = 本章末（窗 null = 最新）。
  const foldById = new Map<string, CheckpointedReduceResult>();
  for (const subjectId of activeIds) {
    foldById.set(
      subjectId,
      reduceWorldSubjectCheckpointed(projectId, subjectId, storyTimeEnd ?? undefined),
    );
  }

  // ── assemble 输入：subjects（全量 + 活动注释 + 活跃者终态）──
  const subjectsAll = listWorldSubjects(projectId);
  const subjectInputs: ChapterSubjectActivityInput[] = subjectsAll.map((s) => {
    const act = activity.get(s.id);
    const fold = foldById.get(s.id);
    return {
      subjectId: s.id,
      type: s.type,
      ...(s.name !== undefined ? { name: s.name } : {}),
      ...(s.sourceCardId !== undefined ? { sourceCardId: s.sourceCardId } : {}),
      firstSeenStoryTime: s.firstSeenStoryTime,
      lastActiveEpisodeIndex: act?.maxEpisodeIndex ?? null,
      ...(act?.lastEpisodeId !== undefined ? { lastChangedEpisodeId: act.lastEpisodeId } : {}),
      ...(fold !== undefined ? { endState: fold.state as ReducedState } : {}),
    };
  });

  // ── assemble 输入：beats 四窗（episode 序判 min-index；chapter/next 离散直判）──
  const beatsBefore: PromiseBeat[] = [];
  const beatsThrough: PromiseBeat[] = [];
  const chapterBeats: PromiseBeat[] = [];
  const beatsNextEpisode: PromiseBeat[] = [];
  for (const beat of sources.beats) {
    if (beatInEpisode(beat, episodeId, sources.sceneById)) chapterBeats.push(beat);
    if (nextEpisodeId !== null && beatInEpisode(beat, nextEpisodeId, sources.sceneById)) {
      beatsNextEpisode.push(beat);
    }
    if (n !== null) {
      // n null 时 before/through 边界不可判 → 两窗皆空（③ stage 窗降级，assemble 另记 degradedNote）。
      const minIdx = beatMinEpisodeIndex(beat, sources.sceneById, indexById);
      if (minIdx !== null) {
        if (minIdx < n) beatsBefore.push(beat);
        if (minIdx <= n) beatsThrough.push(beat);
      }
    }
  }

  // ── 汇编（纯函数单源：六字段 + dormancy + cap/truncated/degradedNote）──
  const { summary, tokenEstimate } = assembleChapterStateSummary({
    episodeId,
    episodeIndex: n,
    storyTimeStart,
    storyTimeEnd,
    subjects: subjectInputs,
    chapterPatches,
    promises: sources.promises,
    beatsBefore,
    beatsThrough,
    chapterBeats,
    beatsNextEpisode,
    nextEpisodeId,
  });

  // ── 机会式 checkpoint（design §3.1；miss 首建已被 fold lazy 覆盖，此处只做阈值推进）──
  const checkpointRows: WorldCheckpointInsert[] = [];
  // lazy 首建计数扫全部 fold（active cast 的 miss fold 都会 lazy 建 checkpoint——含本章未触及但近两章
  // 活跃者；与实际写行一致），阈值推进只判本章触及者（增量从「上一 checkpoint 到本章末」，design §3.1）。
  let lazyBuilt = 0;
  for (const fold of foldById.values()) {
    if (!fold.checkpointHit && fold.patchesFolded > 0) lazyBuilt += 1;
  }
  if (storyTimeEnd !== null) {
    for (const subjectId of touched) {
      const fold = foldById.get(subjectId);
      if (fold === undefined) continue; // 理论不可达（touched ⊆ active）；防御
      if (!fold.checkpointHit) continue; // miss 路径：已 lazy 建（上方计数）
      if (fold.patchesFolded >= CHECKPOINT_MIN_PATCH_DELTA) {
        checkpointRows.push({
          subjectId,
          atStoryTime: storyTimeEnd,
          state: fold.state,
          issueCount: fold.issueCount,
          patchRowidHigh: getWorldPatchRowidHigh(projectId, subjectId, storyTimeEnd),
          // CR-10（8.1 修复批）：自**命中点**累计（hitPatchCountFolded + 本窗数）——不重查 latest 取
          // 基数：latest 与命中点不同步时（命中与重查之间有写）会双计窗内数。
          patchCountFolded: (fold.hitPatchCountFolded ?? 0) + fold.patchesFolded,
        });
      }
    }
  }

  // ── 落盘：单 WAL 事务（summary upsert + checkpoint 批；同 episode 重物化 last-wins 幂等，design §2）──
  upsertChapterSummaryWithCheckpoints(
    projectId,
    {
      episodeId,
      episodeIndex: n,
      storyTimeEnd,
      summary,
      tokenEstimate,
      truncated: summary.truncated,
      // 观测水印（非有效性判据——checkpoint 有效性归显式失效 + 水印，design §4）。
      patchRowidHigh: getWorldPatchRowidHigh(projectId),
    },
    checkpointRows,
  );

  // ── Story 8.3 S3：章摘要检索行物化 + synopsis 联动（design §3，best-effort，X1 fire-and-forget）──
  //
  // X1（CR 2026-08-20）：S3 原实现 `await` 串行——物化链（写章 → materialize 循环）被每章一次的
  // 摘要行索引（embed 批调用 + 章文件重读）拖慢（worldStateScale 实测每章 +~52ms，400 章批 7s→21s
  // 级劣化）。**产品不预设 API 并发限制**（2026-08-20 用户裁决——「API 并发纪律」是开发过程的
  // subagent 约束，非产品约束），物化调用方不再等待：检索行索引任务进 module 级 promise 链**串行**
  // 执行（mirror chapterChunkWatcher enqueueWork 形态——批量任务的自然合并，同时避免 400 章循环
  // 瞬时踢出 400 个并发请求）。失败只 warn（摘要行已落库，检索行是 DERIVED，下次物化/watcher/
  // backfill 兜底）。确定性收口（rebuild 尾部 prune 前 / 测试）经 waitForSummaryIndexQueue。
  enqueueSummaryIndexWork(async () => {
    try {
      await reindexChapterSummaryEntry(projectId, projectDir, episodeId);
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectId, episodeId },
        'materialize_chapter_summary: derived summary-entry reindex failed - summary row stands',
      );
    }
  });

  return { summary, tokenEstimate, checkpointCount: lazyBuilt + checkpointRows.length };
}

// ── X1：摘要检索行索引的后台串行任务链（module 级单链——物化循环各章任务自然合并排队）──

let summaryIndexQueue: Promise<void> = Promise.resolve();

function enqueueSummaryIndexWork(task: () => Promise<void>): void {
  // task 自带 try/catch（带 projectId/episodeId 语境 warn），此处 catch 是结构性 belt——链永不
  // reject（一个任务失败不阻断后续任务，也绝不产生 unhandled rejection）。
  summaryIndexQueue = summaryIndexQueue.then(task).catch((err) => {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'materialize_chapter_summary: unexpected summary-entry index queue failure',
    );
  });
}

/**
 * 等待后台摘要检索行队列排空（X1）。消费者：`rebuildChapterSummaries` 尾部 orphan 清扫前
 * （prune 须看终态，防 queued 任务在其后复活刚清掉的行）+ 测试确定性收口。
 */
export function waitForSummaryIndexQueue(): Promise<void> {
  return summaryIndexQueue;
}
