import { listWorldSlices, resetWorldState } from './worldStateRepository';
import { sendWorldChanged } from '../ipc/worldNotify';
// materialize 组装函数 + episode 归类器自 worldStateMaterialize 复用（CR-8，8.1 修复批：该核心已从
// ipc/toolHandlers/worldStateHandlers 下潜到 db 层——本模块不再反向 import ipc 层；Step 3 特意导出的
// 复用点不变，本模块只做「归类 + 逐 episode 容错循环」，不复制任何汇编逻辑）。
import {
  materializeChapterSummaryCore,
  readKnownEpisodeIds,
  waitForSummaryIndexQueue,
  worldSliceEpisodeId,
} from './worldStateMaterialize';
import { pruneOrphanChapterSummaryEntries } from './chapterSummaryIndexer';
import { getLogger } from '../logger';

// ── Story 3.4（C-A1）：旧章 world-state 补提取 shell 侧 helpers（design §3 / implement.md 1.1）──
//
// backfillWorldState（agent 侧）已实现「对旧章正文跑 extractor + merge + writer」核心，幂等（per-slice
// idempotency，稳定 slice.id 替换不累积）。本模块补 shell 侧两块：
//
// 1. **hasAnyWorldState(projectId)**：诊断前置检查——查项目是否已有 world state slices。涟漪诊断（Phase 2）
//    先调此判断：无 slices 且有旧章正文 → 触发 backfill（design §3「诊断前置检查：若无 world state 则触发」）。
//
// 2. **resetWorldStateForBackfill(projectId)**：resetWorldState 的首个 caller（worldStateRepository.ts:476
//    零生产 caller）。全量 clean backfill 前清 orphan slices（删已删章的残留 derived + amendment）。per-slice
//    idempotency 只保证重跑同 slice.id 替换，不删已删 episode 的 orphan——全量 clean 需 reset 先清。
//    subject 身份保留（resetWorldState 语义：删 patches + slices，保 subject 登记）。
//
// **范式判据（ADR-3）**：纯 db 查询/删除（listWorldSlices 计数 / resetWorldState 删），无语义判断。
//
// **触发接线（TODO Phase 2）**：本模块只提供 helpers；何时调（open-project 全量 / 诊断按需）由 Phase 2
//    ripple-diagnosis 前置检查或 project-open 钩子决定。mirror assetCardsIndexer open-project backfill 模式
//    （asset_cards reindex on save + open），但 world-state backfill 成本高（N 章 × LLM 提取），故 design
//    选「诊断按需」非 open 全量。

/**
 * 项目是否已有 world state slices（诊断前置检查）。
 *
 * 读 closure_world_slice 计数（不取 patches，轻量）。count > 0 = 有实际轨数据（涟漪诊断可查累积状态）。
 * count === 0 = 无数据（旧章未补提取 / 新项目）→ 涟漪诊断 graceful 标 degraded，建议触发 backfill。
 *
 * @param projectId 5 位 registry id（mirror worldStateHandlers.resolveProjectId）
 * @returns         true = 已有 slices；false = 空。
 */
export function hasAnyWorldState(projectId: string): boolean {
  // listWorldSlices 不带 withPatches，只取 slice 行（轻量）。空项目返 []。
  return listWorldSlices(projectId, {}).length > 0;
}

/**
 * 全量 clean backfill 前清 world state（resetWorldState 的首个 caller，C-A1）。
 *
 * 删项目全部 patches（derived + amendment）+ cascade slices，**保留 subject 身份**（subject-lifecycle §6
 * 稳定登记）。design §3 重跑流：resetWorldStateForBackfill → backfillWorldState 重建 derived（amendment
 * 随 reset 清零——修补临时性依附当时派生快照）。
 *
 * 仅清——不重建。重建归 backfillWorldState（agent 侧，caller 接线 Phase 2）。mirror resetWorldState 语义。
 */
export function resetWorldStateForBackfill(projectId: string): void {
  getLogger().info(
    { projectId },
    'resetWorldStateForBackfill: clearing derived + amendment (subjects preserved) before full backfill',
  );
  resetWorldState(projectId);
  // dogfood R2 #92：world:changed 发射（reset 事务提交后——resetWorldState 同步事务，返回即已清）。
  // 发射埋**函数内**而非调用点：本函数是 resetWorldState 的唯一生产 caller 且 Phase 2 接线未定
  // （触发入口未来才挂），埋函数内保证任何未来调用点自动带通知（#77「改了但 UI 不知道」防线）。
  // kind='backfill'（contract worldChangedKindSchema 注释绑定：全量重提取 reset；'reset' 留给未来
  // 非 backfill 语义的 reset 调用来源）。不带 sliceT/subjectIds（全量清空——L2/L3 保守全重拉）。
  // best-effort：sendWorldChanged never throws。
  sendWorldChanged({ projectId, kind: 'backfill' });
}

// ── Story 8.1（Step 6）：ChapterStateSummary 重建 pass（design §8「backfill 扩展」）──
//
// 两条调用语义共用同一引擎（操作本身完全相同——见 rebuildChapterSummaries doc「仅补 summary」段）：
// 1. **重提取后重建**：resetWorldState 已事务内清全 checkpoint + summary（Step 2）→ 重提取落表新
//    slices → 本 pass 对所有有 slices 的 episode 全量重建 summary + 机会式 checkpoint。
// 2. **「仅补 summary」手动刷新**：不 reset、不触发重提取、不动 patch/slice 行——只重算 summary
//    （幂等 upsert 覆盖）。用途：用户改 promise_registry（project.yaml）后手动刷新前情摘要。
//
// 调用入口（无新 IPC 面）：语义 1 经既有 backfill 命令路径（agent WorkflowRuntime.runBackfill，Step 6
// 追加 pass——agent 侧经统一 toolExecution 调 materialize_chapter_summary 工具逐 episode）；本导出函数
// 是两条语义共用的 shell 侧引擎，语义 2 的手动入口直接调它（未来 UI/dogfood 入口同点挂接，零新通道）。
//
// 范式判据（ADR-3）：episode 归类（episode_id 列 + legacy 前缀）+ 逐 episode 调 materialize 组装函数
// （其本身 = 查询/汇编/确定性计算 over 既有结构化数据），零语义判断——与 6.6 merge 机械组装同范式。

/** rebuildChapterSummaries 报告（context isolation——汇总计数 + failed 列表，不灌 per-episode summary 全文）。 */
export interface ChapterSummaryRebuildReport {
  /** 全部 episode 物化成功；false = 有 per-episode 失败（容错已跑完其余，见 failed）。 */
  ok: boolean;
  /** 有 slices 的 episode 数（episode_id 列 + legacy slice.id 前缀归类）。 */
  episodesFound: number;
  /** 成功物化（含幂等覆盖重建）数。 */
  materialized: number;
  /** per-episode 失败明细（warn 继续、最后汇总——单章失败不中断整批，DERIVED 缓存重跑本 pass 即补）。 */
  failed: Array<{ episodeId: string; error: string }>;
}

/**
 * 对项目内**所有有 slices 的 episode** 逐个物化 ChapterStateSummary（+ 机会式 checkpoint），幂等。
 *
 * episode 集合 = slices 的 episode 归类去重（storyTime 升序首现序）：episode_id 列优先，存量行 NULL →
 * slice.id 硬化前缀解析（worldSliceEpisodeId 单源，与 materialize 内部归类一致）；CR-13（8.1 修复批）
 * **幻影前缀排除**——归类出的 episode id 须在 episode_outlines 真实存在才物化（'am-fix:200' 这类修补
 * 标签前缀不造幻影 summary 行；列归属与前缀归属同 gate——backfill 懒补会把可解析前缀写进列，若只 gate
 * 前缀则幻影经列洗白回归）。outlines 源缺失/为空 → 无可物化 episode（记 warn；链上正向物化
 * materialize_chapter_summary {episodeId} 不走本 gate，显式指定不受影响）。storyTime 升序逐章物化让
 * 机会式 checkpoint 链式生效（章 N 的 fold 命中章 N-1 物化时建的 checkpoint）。
 *
 * **「仅补 summary」语义（不动 patches）**：本函数只调 materializeChapterSummaryCore——不 reset、不触发
 * 重提取、不写/删任何 patch/slice 行；物化自身的机会式 checkpoint 写入（幂等 upsert）是物化语义的
 * 一部分（含在两条调用语义中）。取全 episode 重物化而非「缺行/过期才补」——summary 行的 patch_rowid_high
 * 水印只看得见 patch 漂移，看不见 promise_registry（project.yaml）漂移，而 yaml 变更正是手动刷新的主
 * 用例；按水印过滤会漏掉主用例，全量幂等覆盖既简单又对主用例正确（手动刷新是偶发操作，O(episodes ×
 * 汇编) 成本可接受）。
 *
 * per-episode 容错：单章物化抛错 → warn + 记 failed + 继续下一章（不中断整批）。
 *
 * @param projectId 5 位 registry id（mirror worldStateHandlers.resolveProjectId）。
 * @param projectDir 项目目录（materialize 读 project.yaml 三源 + outlines gate 用；与 projectId 同一项目）。
 */
export async function rebuildChapterSummaries(
  projectId: string,
  projectDir: string,
): Promise<ChapterSummaryRebuildReport> {
  const knownEpisodeIds = await readKnownEpisodeIds(projectDir);
  if (knownEpisodeIds.size === 0) {
    getLogger().warn(
      { projectId },
      'rebuildChapterSummaries: episode_outlines 缺失或为空——无可物化 episode（补 outlines 后重跑本 pass）',
    );
  }
  const episodeIds: string[] = [];
  const seen = new Set<string>();
  // listWorldSlices 不带 withPatches（归类只需 slice 行，轻量；materialize 自取全量）。
  for (const slice of listWorldSlices(projectId, {})) {
    const episodeId = worldSliceEpisodeId(slice);
    if (episodeId === undefined || seen.has(episodeId)) continue;
    if (!knownEpisodeIds.has(episodeId)) continue; // CR-13：幻影前缀排除（outlines 存在性 gate）
    seen.add(episodeId);
    episodeIds.push(episodeId);
  }

  getLogger().info(
    { projectId, episodes: episodeIds.length },
    'rebuildChapterSummaries: materializing per-episode chapter summaries (idempotent upsert)',
  );

  let materialized = 0;
  const failed: Array<{ episodeId: string; error: string }> = [];
  for (const episodeId of episodeIds) {
    try {
      await materializeChapterSummaryCore(projectId, projectDir, episodeId);
      materialized += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        { projectId, episodeId, err: msg },
        'rebuildChapterSummaries: episode materialize failed — continuing batch',
      );
      failed.push({ episodeId, error: msg });
    }
  }

  // ── Story 8.3 S3：摘要检索行 orphan 清扫（best-effort）──
  // 循环内每章物化经 materializeChapterSummaryCore 内 hook 重索引摘要检索行 + synopsis 联动
  // chunk（X1 起 fire-and-forget 后台串行链）——**prune 前先排空队列**：清扫要看终态，防 queued
  // 任务在 prune 之后复活刚清掉的行（确定性收口，mirror watcher flush 语义）。本清扫兜「物化集
  // 之外」的 stale 行——级联失效（insertWorldSlice 删 summary 行）/ resetWorldState 清库后未重
  // 物化 episode 的遗留 entry 行。失败只 warn（DERIVED 可重建）。
  await waitForSummaryIndexQueue();
  try {
    const pruned = pruneOrphanChapterSummaryEntries(projectId);
    if (pruned > 0) {
      getLogger().info(
        { projectId, pruned },
        'rebuildChapterSummaries: pruned orphan chapter_summary retrieval entries',
      );
    }
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectId },
      'rebuildChapterSummaries: orphan summary-entry prune failed - continuing',
    );
  }

  return { ok: failed.length === 0, episodesFound: episodeIds.length, materialized, failed };
}
