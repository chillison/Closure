import { z } from 'zod';

// ── Story 2.7 索引管理面 IPC 契约（A1 类型声明；handler 留 B 段）──
//
// `closure:index-status` 返 craft（全局）+ 当前项目 story（project_assets 来源
// `source_kind='asset_card'` + 设定卡来源 `source_kind='setting_card'` + 长 form 设定散文
// 来源 `source_kind='setting_md'`，Story 2.3）的派生索引计数 / pending_embed / model，供
// 「知识库索引」管理页展示。
// `closure:rebuild-story-index` 触发 reindexAll（project_assets）+ reindexAssetCards
// （asset_cards）+ reindexAllSettingMd（setting_md，Story 2.3；GAP2 model-swap 之外的手动
// 全量重建入口）。
//
// 范式判据 (ADR-3)：索引计数 / rebuild = 纯代码（查询 / embed 调用），非语义判断。
// source_kind 来源区分：`'asset_card'` = OrisonSpace 文件型资产（project_assets 表），
// `'setting_card'` = Closure 设定卡（project.yaml asset_cards 字段，Story 2.7），
// `'setting_md'` = Closure 长 form 设定散文（`<project>/settings/*.md`，Story 2.3）。
// `'chapter'` = 章正文 chunk 行 / `'chapter_summary'` = 章摘要行（Story 8.3，正文段落 +
// 章梗概进检索索引——chapters/*.md 与 closure_chapter_summary 的派生检索面）。五者
// 同住 closure_entry / entry_vec（单库 JOIN），source_kind 是来源区分机制（检索端不按
// source_kind 过滤，VS1 design §8 预留）；目录面（catalog_entries/get_entry）排除
// chapter/chapter_summary 两类（段行/摘要行不是实体）。

/**
 * 派生索引状态（craft 全局 + story 当前项目）。mirror closure-retrieval / craft-retrieval
 * 的「count + pending_embed + model」三连。pending = content_hash IS NULL 的行数（FTS
 * 已索引但向量待补，离线 / 无 model / embed 失败降级路径留的待办）。
 *
 * dogfood #39（T2 C2，2026-08-25）：新增 `embeddingConfiguredModelId`（顶层）+ craft/story
 * 各自的 `degraded`——此前状态面只描述存量（pending/model），配置面只在模型设置页，索引页
 * 无从区分「未配置（预期 FTS-only）」与「已配置但降级」（换模型重建失败后的静默 FTS-only，
 * 只有 dev 日志知道）。degraded 由 shell 用 {@link isVectorArmDegraded} 判定（与启动
 * reconcile 同一谓词同一语义——判定单源，UI 只渲染不推导）。
 *
 * CR-T2-006/014（2026-08-25，additive）：`craft/story` 各加 `storedModels`（存量 DISTINCT
 * provenance 模型列表——mismatch 推导归 shell，UI 不再用五源 LIMIT 1 回退链本地重算，混合态
 * 「存量含多模型版本」有因可陈）；顶层加 `sweepInflight`（启动/换模型重建扫在途——UI 并入
 * 「重建中」面防降级横幅随 2s 轮询闪进闪出）。二者 optional：旧 shell/测试 fixture 不带也合法。
 */
export const indexStatusSchema = z.object({
  /** 当前解析到的 embedding 模型 id（resolveEmbeddingModel().modelId；null = 未配置）。 */
  embeddingConfiguredModelId: z.string().nullable(),
  /** CR-T2-014：embedding 重建扫在途（启动 reconcile / save-model 迁移）。additive optional。 */
  sweepInflight: z.boolean().optional(),
  craft: z.object({
    count: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    model: z.string().nullable(),
    /** 向量臂降级（craft scope 的 isVectorArmDegraded 判定）。 */
    degraded: z.boolean(),
    /** CR-T2-006：存量 DISTINCT provenance 模型（shell 判定面，additive optional）。 */
    storedModels: z.array(z.string()).optional(),
  }),
  story: z.object({
    /** 当前项目 projectId；无项目打开时为 null（story 计数归零）。 */
    projectId: z.string().nullable(),
    /** project_assets 来源（source_kind='asset_card'）行数。 */
    projectAssets: z.number().int().nonnegative(),
    /** asset_cards 来源（source_kind='setting_card'）行数。 */
    assetCards: z.number().int().nonnegative(),
    /** setting_md 来源（source_kind='setting_md'，长 form 设定散文 settings/*.md）行数。Story 2.3。 */
    settingMd: z.number().int().nonnegative(),
    /**
     * 章正文 chunk 行（source_kind='chapter'，一行一 chunk）行数。Story 8.3——正文段落
     * 进检索索引；计数 = 全章 chunk 总和（一章典型 2-8 块）。
     */
    chapterChunks: z.number().int().nonnegative(),
    /** 章摘要行（source_kind='chapter_summary'，一行一章）行数。Story 8.3。 */
    chapterSummaries: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    model: z.string().nullable(),
    /** 向量臂降级（story scope 的 isVectorArmDegraded 判定；无项目时恒 false）。 */
    degraded: z.boolean(),
    /** CR-T2-006：存量 DISTINCT provenance 模型（project 维度全五源；shell 判定面，additive optional）。 */
    storedModels: z.array(z.string()).optional(),
  }),
});

export type IndexStatus = z.infer<typeof indexStatusSchema>;

/**
 * `closure:rebuild-story-index` 结果（mirror `CraftRebuildResult`，模式 A — ipc-handlers
 * spec：expected 用户失败走 `{ ok:false, error }`，不 throw IPC rejection）。
 *
 * - `no-embedding-model`：未配置 embedding model（reindexAll 要求 model，非可选降级）。
 * - `no-project-path`：projectId 在 projects 表查不到 path（注册库与文件失配）。
 * - `operation-failed`：reindex 过程异常（embed probe 失败 / db 写错等）。
 * - `sweep-in-progress`（CR-T2-005，2026-08-25）：后台 embedding 重建扫在途（启动 reconcile
 *   / save-model 迁移）——并发重嵌会竞争 entry_vec 的 DROP/重建，拒绝并提示稍后重试。
 */
export type StoryRebuildResult =
  | { ok: true; reindexed: number; dimChanged: boolean; newDim: number | null }
  | { ok: false; error: 'no-embedding-model' | 'no-project-path' | 'operation-failed' | 'sweep-in-progress' };

/**
 * dogfood #39（T2 Batch C，2026-08-25）——向量臂降级判定（纯谓词，shell 两处消费的单源）。
 *
 * 「降级」= 已配置 embedding 模型的前提下，派生向量索引无法在该模型下正常服务：
 * - `pending > 0`：存在 content_hash IS NULL 的行（FTS 已索引、向量待补）——失败重建的
 *   余波 / 离线写盘 / 维度重建清 hash 的中间态（台账 #39 实录形态：重建扫失败后全卡/
 *   全文档改写为 pending，provenance 归 NULL）。未配置模型时 pending 是**预期态**
 *   （FTS-only 是设计内降级路径），不算 degraded。
 * - `storedModels` 含与配置不同的模型：存量向量在别的几何空间（研究
 *   `embedding-model-swap-compatibility-2026-07-23.md` §2.4——不同模型即使同维也不同
 *   空间），对当前模型无意义——须 force 全量重嵌。
 *
 * 消费端（同一判定、两个 scope 粒度）：
 * - shell 启动 reconcile（`db/embeddingIndexReconcile.ts`）：全库 pending + DISTINCT
 *   model → 决定是否自动重跑重建扫（及 force 与否）。
 * - `closure:index-status`（`ipc/closureIndexIpc.ts`）：craft / story 各自 scope →
 *   状态面 `degraded` 字段，KB 索引页据此显示降级横幅。
 *
 * 范式判据 (ADR-3)：纯机械比对（计数 + 字符串相等），零语义判断。
 */
export function isVectorArmDegraded(check: {
  configuredModelId: string | null;
  pending: number;
  storedModels: ReadonlyArray<string>;
}): boolean {
  if (check.configuredModelId === null) return false;
  if (check.pending > 0) return true;
  return check.storedModels.some((m) => m !== check.configuredModelId);
}
