import { z } from 'zod';

// ── Story 8.7 扫描层统一目录契约（design §4.1，R3）──
//
// 实体目录 = 知识库可穷举面（卡 + 设定文档）的薄行目录：先过滤后翻页 + 显式总数 + 独立下钻
// （get_entry）——LLM 不知道自己不知道，采样式检索必漏；目录给「找完整」的穷举入口。
// 目录接口收敛模式（research/web-optimization-survey）：薄行（id/类型/名字/简述行/出场统计）
// + 显式 total 绝不静默截断 + 下钻全文独立入口；全量 dump 反模式。
//
// 范式判据（ADR-3）：目录/翻页/计数 = 纯代码查询汇编；条目该不该用归消费端 LLM。
//
// expected_downstream_consumers:
// - Story 8.7 S6（agent）：catalog_entries / get_entry 两只读工具（remoteToolProxy → shell handler）。
// - Story 8.7 S6b：chapter_list 目录行密度升级消费同模式（标题+storyTime 窗+梗概行）。
// - dogfood：人侧目录 UI（本 story 只做 agent 侧）。

/** catalog_entries 单页行数上限（防 LLM context 胀；显式 total 让翻页可控）。 */
export const CATALOG_ENTRIES_LIMIT_MAX = 100;

/** catalog_entries 单页行数缺省值。 */
export const CATALOG_ENTRIES_LIMIT_DEFAULT = 20;

/**
 * `catalog_entries` 工具/handler 入参（snake_case 对齐 agent tool params，mirror
 * closureStoryQuerySchema；projectId 由 handler 从 projectDir 解析，非参数）。
 * 先过滤（entry_type/status/visibility）后翻页（offset/limit）——过滤后总数见结果的 `total`。
 */
export const catalogEntriesRequestSchema = z.object({
  entry_type: z
    .string()
    .optional()
    .describe('只列该类型的条目（如 character/location/rule）；不填则全部类型'),
  status: z
    .string()
    .optional()
    .describe('只列该状态的卡（draft=草稿 / active=定稿在用 / deprecated=已弃用 / locked=锁定禁改）；不填则全状态'),
  visibility: z
    .string()
    .optional()
    .describe('可见性过滤；当前所有条目都是 known，可不填（预留维度）'),
  offset: z.number().int().nonnegative().optional().describe('跳过前多少条（翻页用；默认 0）'),
  limit: z
    .number()
    .int()
    .positive()
    .max(CATALOG_ENTRIES_LIMIT_MAX)
    .default(CATALOG_ENTRIES_LIMIT_DEFAULT)
    .describe(`本页行数（默认 ${CATALOG_ENTRIES_LIMIT_DEFAULT}，最大 ${CATALOG_ENTRIES_LIMIT_MAX}）`),
});
export type CatalogEntriesRequest = z.infer<typeof catalogEntriesRequestSchema>;

/**
 * 目录薄行（一行一实体：id/类型/名字/简述行/出场统计）。`summaryLine` 是简述的单行截断
 * （≤60 字，handler 侧截断）；出场统计缺省 = 该实体暂无出场账（账未建/未入账），非「从未出场」。
 */
export const catalogRowSchema = z.object({
  /** 实体条目 id（下钻 get_entry 用；检索/关系图/mention 账同锚）。 */
  entryId: z.string().min(1),
  /** 条目类型（character/location/rule/设定散文…，开放 string）。 */
  entryType: z.string().min(1),
  /** 条目名字。 */
  name: z.string().min(1),
  /** 简述行（≤60 字截断的单行版本）；缺省 = 该条目暂无简述。 */
  summaryLine: z.string().optional(),
  /** 出场+提及总章数（mention 账聚合）；缺省 = 暂无出场账。 */
  mentionChapterCount: z.number().int().nonnegative().optional(),
  /** 最后出场/被提及的章 id；缺省 = 暂无出场账。 */
  lastMentionEpisode: z.string().optional(),
});
export type CatalogRow = z.infer<typeof catalogRowSchema>;

/**
 * `catalog_entries` 返回。
 *
 * 🔴 绝不静默截断红线：`total` 是**过滤后总条数**（非本页行数）；`rows` 只含本页
 * （offset 起 limit 条）。`total > offset + rows.length` = 还有更多页，调用方据 total 翻页
 * ——本页短绝不意味「只有这些」。
 */
export const catalogEntriesResultSchema = z.object({
  /** 过滤后总条数（与 offset/limit 无关的完整计数）。 */
  total: z.number().int().nonnegative(),
  /** 本页薄行（offset 起，至多 limit 条）。 */
  rows: z.array(catalogRowSchema),
});
export type CatalogEntriesResult = z.infer<typeof catalogEntriesResultSchema>;

/** `get_entry` 工具/handler 入参（目录行下钻）。 */
export const getEntryRequestSchema = z.object({
  entry_id: z.string().min(1).describe('要查看详情的条目 id（来自实体目录行或检索结果）'),
});
export type GetEntryRequest = z.infer<typeof getEntryRequestSchema>;

/**
 * `get_entry` 返回（单条目下钻：简述 + 全文 + 状态 + 出场统计）。三级变焦的「全文」级——
 * 目录薄行不携 bodyText，要看全文走本入口。
 */
export const getEntryResultSchema = z.object({
  /** 实体条目 id。 */
  entryId: z.string().min(1),
  /** 条目类型（开放 string，同 catalogRow.entryType）。 */
  type: z.string().min(1),
  /** 条目名字。 */
  name: z.string().min(1),
  /** 简述（一段话身份层描述）；缺省 = 未生成简述。 */
  summary: z.string().optional(),
  /** 条目全文（卡拼料 / 设定散文正文）。 */
  bodyText: z.string(),
  /** 卡状态（draft/active/deprecated/locked）；设定散文/参考文档无状态概念 → null。 */
  status: z.string().nullable(),
  /** 可见性（当前恒 'known'，预留维度）。 */
  visibility: z.string(),
  /** 出场统计（mirror catalogRow 同名字段语义；缺省 = 暂无出场账）。 */
  mentionStats: z.object({
    mentionChapterCount: z.number().int().nonnegative().optional(),
    lastMentionEpisode: z.string().optional(),
  }),
});
export type GetEntryResult = z.infer<typeof getEntryResultSchema>;
