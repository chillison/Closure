/**
 * Closure KB index management IPC (Story 2.7 B段, design §3 B1). Mirrors
 * `closureCraftIpc.ts` (模式 A 错误处理) for the two story-2.7 management
 * channels consumed by the「知识库索引」settings page:
 *
 * - `closure:index-status`: read-only derived-index counters. craft (global) +
 *   the current project's story (project_assets `source_kind='asset_card'` +
 *   asset_cards `source_kind='setting_card'` + setting_md `source_kind='setting_md'`
 *   , Story 2.3 long-form prose + chapter `source_kind='chapter'` body chunks +
 *   chapter_summary `source_kind='chapter_summary'`, Story 8.3) counts, with
 *   pending_embed + model provenance. NEVER
 *   throws (mirror closureCraftIpc): a db error / missing table returns zero
 *   counts + a log so the settings page always renders.
 * - `closure:rebuild-story-index`: manual full rebuild of the current project's
 *   story derived index — `reindexAll(projectId)` (project_assets) +
 *   `reindexAssetCards(projectPath, {force:true})` (asset_cards) +
 *   `reindexAllSettingMd(projectPath, {force:true})` (long-form setting prose,
 *   Story 2.3) + `rebuildChapterChunks(projectId, projectPath, {force:true})`
 *   (chapter body chunks) + per-episode `reindexChapterSummaryEntry`
 *   (chapter_summary rows; Story 8.3 E1 — the entry_vec structure/dim DROP
 *   recovery surface now covers all five story source kinds). Complementary
 *   to the watcher + the model-swap sweep (reindexAllForChangedModel).
 *   Returns a typed `StoryRebuildResult`; the no-embedding-model /
 *   no-project-path states are expected user conditions reported as
 *   `{ ok:false, error }` rather than thrown IPC rejections (模式 A —
 *   ipc-handlers spec).
 *
 * 范式判据 (ADR-3): counting + rebuild orchestration = pure code (SQL / embed
 * call wiring), NOT semantic judgment. The craft rebuild IPC (`closure:rebuild-
 * craft-kb`, registered in closureCraftIpc) is the orphan 2.1 finally gets a UI
 * button for — the page calls `rebuildCraftKb()` directly via preload, no new
 * handler here.
 */
import { ipcMain } from 'electron';
import type { IndexStatus, StoryRebuildResult } from '@orison/shared-contracts';
import { isVectorArmDegraded } from '@orison/shared-contracts';
import { reindexAll } from '../db/closureIndexer';
import { reindexAssetCards, ASSET_CARD_SOURCE_KIND } from '../db/assetCardsIndexer';
import { reindexAllSettingMd, SETTING_MD_SOURCE_KIND } from '../db/settingMdIndexer';
import { CHAPTER_SOURCE_KIND, rebuildChapterChunks } from '../db/chapterChunkIndexer';
import {
  CHAPTER_SUMMARY_SOURCE_KIND,
  reindexChapterSummaryEntry,
} from '../db/chapterSummaryIndexer';
import { getProjectById } from '../db/projectRepository';
import { listChapterSummaries } from '../db/worldStateRepository';
import { isSqliteVecAvailable } from '../db/sqliteVecLoader';
import { isEmbeddingSweepInflight } from '../db/embeddingSweepGate';
import { getDb } from '../db';
import { getLogger } from '../logger';
import { resolveEmbeddingModel } from './modelGatewayIpc';

/**
 * `source_kind` for OrisonSpace file assets (project_assets rows). This is the
 * `closure_entry.source_kind` schema DEFAULT (db/index.ts `CREATE TABLE`), kept
 * as a named const here so the index-status `projectAssets` vs `assetCards` split
 * reads as data, not magic strings. The asset_cards counterpart
 * (`'setting_card'`) is imported from assetCardsIndexer (single source of truth).
 */
const PROJECT_ASSET_SOURCE_KIND = 'asset_card';

/** Count + pending + model-provenance for one derived-index face. Mirror the
 *  craft / story three-tuple. pending = rows with `content_hash IS NULL` (FTS
 *  indexed, vector pending — offline / no-model / failed-embed degradation). */
type FaceStatus = { count: number; pending: number; model: string | null };

/**
 * Best-effort row counter. `whereBody` is the WHERE clause body (without the
 * keyword); pass `'1=1'` for an unfiltered face (craft). `params` bind the
 * body's placeholders. Any db error (table missing on a fresh install, db
 * unavailable) → zero counts + log so the settings page always renders (never
 * throws — mirror closureCraftIpc).
 */
function readFaceStatus(table: string, whereBody: string, params: unknown[]): FaceStatus {
  try {
    const db = getDb();
    const countRow = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${whereBody}`)
      .get(...params) as { n: number } | undefined;
    const pendingRow = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${whereBody} AND content_hash IS NULL`)
      .get(...params) as { n: number } | undefined;
    const modelRow = db
      .prepare(`SELECT model FROM ${table} WHERE ${whereBody} AND model IS NOT NULL LIMIT 1`)
      .get(...params) as { model: string } | undefined;
    return {
      count: Number(countRow?.n ?? 0),
      pending: Number(pendingRow?.n ?? 0),
      model: modelRow?.model ?? null,
    };
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), table },
      'closure index-status: read failed — returning zero counts',
    );
    return { count: 0, pending: 0, model: null };
  }
}

/**
 * DISTINCT 存量 provenance 模型列表（dogfood #39 T2 C2）。`readFaceStatus` 的 `model` 只取
 * LIMIT 1 的首个——五源回退链可能掩盖混合态（某源已迁新模型、某源仍是旧模型）；degraded
 * 判定须看全量 DISTINCT。任何 db 错（表缺失）→ 空数组（无存量 = 无 mismatch 信号）。
 */
function readDistinctModels(table: string, whereBody: string, params: unknown[]): string[] {
  try {
    const rows = getDb()
      .prepare(`SELECT DISTINCT model FROM ${table} WHERE ${whereBody} AND model IS NOT NULL`)
      .all(...params) as Array<{ model: string }>;
    return rows.map((r) => r.model);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), table },
      'closure index-status: distinct-model read failed — treating as none',
    );
    return [];
  }
}

export function registerClosureIndexIpc(): void {
  ipcMain.handle('closure:index-status', async (_, input: { projectId?: string }): Promise<IndexStatus> => {
    // dogfood #39（T2 C2）：配置面模型 + 各 scope 的 DISTINCT 存量模型 + pending →
    // isVectorArmDegraded 判 degraded（与启动 reconcile db/embeddingIndexReconcile.ts
    // 同一谓词同一语义——自动触发与 UI 信号判定单源，UI 只渲染不推导）。
    // resolveEmbeddingModel 读本地小文件，status 轮询（重建中 2s）频率下成本可忽略。
    //
    // CR-T2-004（2026-08-25）：NEVER-throws 契约两处防御——
    // ① resolveEmbeddingModel 的「NEVER throws」承诺不覆盖 readModelConfigFromDisk 的
    //   fs 异常（readdirSync EACCES/锁）——包 try/catch，解析失败按未配置上报（页面恒渲染）；
    // ② sqlite-vec 不可用（打包回归/扩展加载失败）= 结构性无向量臂——pending 是常态且
    //   重建不可治，degraded 恒 false（否则永久降级横幅指引用户去点修不好的重建；
    //   mirror embeddingIndexReconcile 的同款前置判断）。
    let configuredModelId: string | null = null;
    try {
      configuredModelId = resolveEmbeddingModel()?.modelId ?? null;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'closure index-status: embedding model resolve failed - reporting as unconfigured',
      );
    }
    const vecArmAvailable = isSqliteVecAvailable();
    // CR-T2-006：DISTINCT 存量模型随状态面 additive 透出（UI 不再用 LIMIT 1 回退链本地
    // 重算 mismatch——混合态「存量含多模型版本」有因可陈）。CR-T2-014：sweepInflight 并入
    // 状态面（UI 并进「重建中」防横幅闪）。
    const craftFace = readFaceStatus('closure_craft_entry', '1=1', []);
    const craftStoredModels = readDistinctModels('closure_craft_entry', '1=1', []);
    const craft = {
      ...craftFace,
      degraded:
        vecArmAvailable &&
        isVectorArmDegraded({
          configuredModelId,
          pending: craftFace.pending,
          storedModels: craftStoredModels,
        }),
      storedModels: craftStoredModels,
    };
    const projectId = input?.projectId ?? null;
    if (!projectId) {
      return {
        embeddingConfiguredModelId: configuredModelId,
        sweepInflight: isEmbeddingSweepInflight(),
        craft,
        story: {
          projectId: null,
          projectAssets: 0,
          assetCards: 0,
          settingMd: 0,
          chapterChunks: 0,
          chapterSummaries: 0,
          pending: 0,
          model: null,
          degraded: false,
          storedModels: [],
        },
      };
    }
    // project_assets (`'asset_card'`) vs asset_cards (`'setting_card'`) vs setting_md
    // (`'setting_md'`, Story 2.3 long-form prose) vs chapter (`'chapter'`, Story 8.3
    // body chunks) vs chapter_summary (`'chapter_summary'`, Story 8.3) counts are
    // scoped by project_id + source_kind; source_kind is bound as a param (the
    // literals are trusted internal constants, but param-binding keeps the SQL
    // uniform). readFaceStatus appends the pending/model predicates.
    const pa = readFaceStatus(
      'closure_entry',
      'project_id=? AND source_kind=?',
      [projectId, PROJECT_ASSET_SOURCE_KIND],
    );
    const ac = readFaceStatus(
      'closure_entry',
      'project_id=? AND source_kind=?',
      [projectId, ASSET_CARD_SOURCE_KIND],
    );
    const sm = readFaceStatus(
      'closure_entry',
      'project_id=? AND source_kind=?',
      [projectId, SETTING_MD_SOURCE_KIND],
    );
    const ch = readFaceStatus(
      'closure_entry',
      'project_id=? AND source_kind=?',
      [projectId, CHAPTER_SOURCE_KIND],
    );
    const cs = readFaceStatus(
      'closure_entry',
      'project_id=? AND source_kind=?',
      [projectId, CHAPTER_SUMMARY_SOURCE_KIND],
    );
    const storyPending = pa.pending + ac.pending + sm.pending + ch.pending + cs.pending;
    const storyStoredModels = readDistinctModels('closure_entry', 'project_id=?', [projectId]);
    return {
      embeddingConfiguredModelId: configuredModelId,
      sweepInflight: isEmbeddingSweepInflight(),
      craft,
      story: {
        projectId,
        projectAssets: pa.count,
        assetCards: ac.count,
        settingMd: sm.count,
        chapterChunks: ch.count,
        chapterSummaries: cs.count,
        // pending across ALL FIVE story source kinds (a story-level pending total).
        pending: storyPending,
        // model provenance: project_assets rows are the canonical story face, so
        // prefer its model; fall back down the chain when only later faces are
        // indexed (a pure-setting-prose project has no project_assets rows).
        model: pa.model ?? ac.model ?? sm.model ?? ch.model ?? cs.model,
        degraded:
          vecArmAvailable &&
          isVectorArmDegraded({
            configuredModelId,
            pending: storyPending,
            storedModels: storyStoredModels,
          }),
        storedModels: storyStoredModels,
      },
    };
  });

  ipcMain.handle(
    'closure:rebuild-story-index',
    async (_, input: { projectId: string }): Promise<StoryRebuildResult> => {
      // CR-T2-005：与在途 embedding 重建扫互斥（启动 reconcile / save-model 迁移扫）——
      // 并发重嵌竞争 entry_vec 的 DROP+重建。选「拒绝 + 模式 A error code」而非排队等待
      // （UI toast 提示稍后重试，扫完成后状态面自动翻绿）。craft 重建（closure:rebuild-
      // craft-kb）不在本闸面：其独立 vec0 表（closure_craft_vec）无 entry_vec 竞争面。
      if (isEmbeddingSweepInflight()) {
        getLogger().warn('closure rebuild-story-index: rejected - embedding sweep in flight');
        return { ok: false, error: 'sweep-in-progress' };
      }
      const projectId = input?.projectId;
      const projectPath = projectId ? getProjectById(projectId)?.path : undefined;
      if (!projectPath) {
        getLogger().warn({ projectId }, 'closure rebuild-story-index: no project path for projectId');
        return { ok: false, error: 'no-project-path' };
      }
      try {
        // reindexAll throws on a missing embedding model (expected user state)
        // and on an embed-probe failure (operation-failed). It also DROPs+
        // reCREATEs entry_vec on a dim change (global event) — same path the
        // model-swap sweep uses. asset_cards share the per-project vec0 space,
        // so they are re-embedded under the same resolved model right after.
        const assetResult = await reindexAll(projectId);
        const cardResult = await reindexAssetCards(projectPath, { force: true });
        // Story 2.3: re-embed long-form setting prose (settings/*.md) under the
        // same resolved model. reindexAll above throws on a missing model, so this
        // is only reached when a model IS configured; reindexAllSettingMd shares
        // the project's entry_vec (idempotent ensureEntryVecDim no-ops when the
        // dim already matches reindexAll's probe).
        const settingResult = await reindexAllSettingMd(projectPath, { force: true });
        // Story 8.3 E1（CR 2026-08-20）：恢复面扩章源——entry_vec 结构/dim DROP 重建（启动迁移或
        // reindexAll 的 dim change）会全项目丢向量，reindexAll 只重嵌 project_assets；章源（chunk
        // 行 + 章摘要行）不在其恢复面 = 章向量永久丢失直到该章真实变更（迁移点已同步清 content_hash
        // = pending_embed，本面补上重嵌路径）。
        // - chunk：rebuildChapterChunks force 全量重扫（未变章也重嵌——手动重建按钮语义）。
        // - 章摘要：逐 live summary episode 重索引（**无 force**——E1 迁移后 hash 已 NULL 必重嵌；
        //   无迁移的手动重建下未变摘要 hash-skip 零成本，且其 synopsis 联动对刚 force 重建过的
        //   章必然 hash-skip，不产生双份 embed）。
        const chapterResult = await rebuildChapterChunks(projectId, projectPath, { force: true });
        let summaryReindexed = 0;
        for (const { episodeId } of listChapterSummaries(projectId)) {
          try {
            await reindexChapterSummaryEntry(projectId, projectPath, episodeId);
            summaryReindexed += 1;
          } catch (err) {
            getLogger().warn(
              { err: err instanceof Error ? err.message : String(err), projectId, episodeId },
              'closure rebuild-story-index: chapter_summary entry reindex failed - continuing',
            );
          }
        }
        getLogger().info(
          {
            projectId,
            projectAssets: assetResult.reindexed,
            assetCards: cardResult.reindexed,
            settingMd: settingResult.reindexed,
            chapterChunks: chapterResult.reindexed,
            chapterSummaries: summaryReindexed,
            orphaned: cardResult.orphaned + settingResult.orphaned + chapterResult.orphaned,
            dimChanged: assetResult.dimChanged,
            newDim: assetResult.newDim,
          },
          'closure rebuild-story-index: succeeded',
        );
        return {
          ok: true,
          reindexed:
            assetResult.reindexed +
            cardResult.reindexed +
            settingResult.reindexed +
            chapterResult.reindexed +
            summaryReindexed,
          dimChanged: assetResult.dimChanged,
          newDim: assetResult.newDim,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Match the stable error thrown by reindexAll on a missing model.
        const error: 'no-embedding-model' | 'operation-failed' = /no embedding model configured/i.test(msg)
          ? 'no-embedding-model'
          : 'operation-failed';
        getLogger().warn({ err: msg, projectId }, 'closure rebuild-story-index: failed');
        return { ok: false, error };
      }
    },
  );
}
