import { z } from 'zod';

// ── Closure KB hybrid retrieval (ADR-3 / VS1 R4) ──
//
// The retrieval module (`apps/desktop/client/shell/main/db/closureRetrieval.ts`)
// fuses a structured pre-filter + FTS5 bm25 + vec0 KNN via Reciprocal Rank
// Fusion (RRF, k=60) into a single SQL query, then returns parent-doc entries.
// EntryHit is the normalized hit; ClosureSearchRequest is the query opts. The
// `queryStory` IPC channel + OrisonDesktopApi method are added in VS1 阶段5
// (agent `query_story` tool) - deliberately NOT defined here (scope fence).

/**
 * A single retrieval hit. `score` is the RRF combined score (higher = better);
 * `ftsRank`/`vecDistance` are exposed for debugging and to signal which arm
 * matched (present iff that arm ran and the doc was in its candidate set).
 * `rerankScore` is present when the shared cross-encoder rerank stage ran
 * (Story 2.1; additive - undefined when rerank was unavailable / skipped).
 *
 * - `ftsRank`: raw FTS5 `rank` (bm25-based; lower = better per fts5 convention).
 * - `vecDistance`: vec0 cosine distance (lower = better; 0 = identical).
 * - `rerankScore`: cross-encoder relevance score (higher = better).
 * - `summaryText`: 一段话简述（条目身份层，frontmatter 策展或索引时生成；Story 8.7 additive
 *   optional）——undefined = 该条目未生成简述（卡类 bodyText 拼料已含身份信息）。
 * - `vectorKind`: 向量命中类别（Story 8.7 双向量分型，additive optional）：'identity' = 身份向量
 *   命中（名字+类型+简述——「它是干什么的」相关）/ 'body' = 全文向量命中（内容语义相关）。
 *   双臂默认齐搜、结果分类合并返回（消费端 LLM 自行分诊）。undefined = vec 臂未参与该 hit
 *   （FTS-only 降级 / identity 臂缺）。开放 string 非 enum——8.3 chunk 向量将扩第三类
 *   （'chunk'，Story 8.3 落地）。
 * - `chapterId` / `chapterIndex` / `charStart` / `charEnd` / `paraStart` / `paraEnd`（Story 8.3
 *   additive optional，二态字段纪律——无值键不出现）：仅章源行（source_kind='chapter'，正文
 *   分块）携带。chapterId/chapterIndex = 所属章与章序（呈现层 JOIN episode_outlines 补章名）；
 *   charStart/charEnd = 章内字符区间（半开 [start, end)）；paraStart/paraEnd = 段落区间（半开，
 *   0 起段落序）——段级出处锚定，直供 8.4 调查简报「第 N 章第 a-b 段」引用。非章源行（卡/
 *   设定散文/章摘要）这些键 undefined（二态：有值=章源，无值=非章源，无第三态）。
 */
export const entryHitSchema = z.object({
  entryId: z.string(),
  projectId: z.string(),
  entryType: z.string(),
  sourceKind: z.string(),
  name: z.string(),
  bodyText: z.string(),
  visibility: z.string(),
  score: z.number(),
  ftsRank: z.number().optional(),
  vecDistance: z.number().optional(),
  rerankScore: z.number().optional(),
  summaryText: z.string().optional(),
  vectorKind: z.string().optional(),
  chapterId: z.string().optional(),
  chapterIndex: z.number().int().optional(),
  charStart: z.number().int().optional(),
  charEnd: z.number().int().optional(),
  paraStart: z.number().int().optional(),
  paraEnd: z.number().int().optional(),
});

export type EntryHit = z.infer<typeof entryHitSchema>;

// ── Story 8.3：正文语义分块契约（chunk 常量 + chunk 形态，design §2.1/§2.2）──
//
// 分块红线（用户钉）：小说正文必须按语义切——段落原子 + 显式转场标记硬边界 + 贪心聚合 +
// 超长段句读递归降级，绝不固定窗口硬切，无 overlap。下列常量是「证据带内惯例锚点」非中文
// 实测值（research/semantic-chunking-survey-2026-08-20.md：叙事块 350-450 token 证据带、
// floor/soft-cap 双参数工程形态）——**dogfood 校准点**：实配 embedding tokenizer 后按真实
// 章节校准；压测（8.3）只证延迟/召回结构，不证分块质量。

/**
 * 贪心聚合目标尺寸（中文字初值）。dogfood 校准点：叙事检索证据带（350-450）的中带取整；
 * 中文字↔token 换算随 tokenizer 而变（Qwen 系约 1 字≈1 token，cl100k 约 0.6-0.7 字/token）。
 */
export const CHUNK_TARGET_CHARS = 400;

/**
 * 单 chunk 上限（中文字）。超过上限的单段触发句读递归降级（中文句末标点。！？…；」』切句
 * 再聚合，句子完整优先，绝不字符硬切）。dogfood 校准点（同上）。
 */
export const CHUNK_MAX_CHARS = 500;

/**
 * 碎块下限（中文字）：聚合尾段低于 floor 时并入前块防碎片（docling/lsfusion undersized-merge
 * 先例）。dogfood 校准点（同上）。
 */
export const CHUNK_FLOOR_CHARS = 50;

/**
 * 章正文分块器（S2 `chunkChapter`）的单个输出 chunk（design §2.1）。与 closure_entry 章源行
 * （source_kind='chapter'）的新列一一对应：index → entry_id 后缀 `#c<n>`，char/para span →
 * char_start/char_end/para_start/para_end 列，text → 组料正身。
 *
 * - `index`：章内 chunk 序（0 起）——entry_id `${projectId}:${chapterId}#c<n>` 的 n。
 * - `paraStart`/`paraEnd`：聚合的段落区间，**半开 [start, end)**，0 起段落序（段落=markdown
 *   空行切分的最小不可分割单位，红线）。
 * - `charStart`/`charEnd`：章全文内字符区间，**半开 [start, end)**（UTF-16 code unit 偏移，
 *   与 JS string 索引一致——slice(charStart, charEnd) 即原文）。chunk 互不重叠、全覆盖、
 *   rebuild 幂等的结构保证。
 * - `text`：该 chunk 的聚合段正文原文（**不含**章梗概 prefix——prefix 只进索引组料 index_text，
 *   返回呈现给原文，mirror「回答 LLM 看原文」）。
 * - `degenerate`（Story 8.3 S2 additive optional，二态纪律）：true = 该 chunk 含字符级硬切——
 *   单句自身超 `CHUNK_MAX_CHARS` 的极窄路（中文句读也切不开），按上限硬切并诚实标注不静默；
 *   其余 chunk 边界一律落在段落/句读边界。undefined = 正常语义边界 chunk（键不出现）。
 */
export const chapterChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  paraStart: z.number().int().nonnegative(),
  paraEnd: z.number().int().nonnegative(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
  text: z.string(),
  degenerate: z.boolean().optional(),
});

export type ChapterChunk = z.infer<typeof chapterChunkSchema>;

/**
 * Query opts for the closure hybrid retrieval. `entryType` is the structured
 * pre-filter (asset_type, e.g. 'character'); `k` is the final result count.
 *
 * This is the INTERNAL / command-bar shape (design §8 downstream interface):
 * the retrieval core is shared by both the human command bar and the AI
 * `query_story` function call. The command bar holds a `projectId` and passes
 * it through; the `query_story` tool does not (it derives projectId from the
 * project dir in the handler), so it uses `closureStoryQuerySchema` instead.
 *
 * - `status` / `visibility`（Story 8.7 R4 additive optional，mirror query_relations 预过滤参数）：
 *   status 物化卡状态（draft/active/deprecated/locked；setting_md/craft 无状态不过滤）；
 *   visibility 值域现状恒 'known'——接口就位，语义随未来读者视角维度扩展。
 */
export const closureSearchRequestSchema = z.object({
  projectId: z.string().min(1),
  query: z.string(),
  entryType: z.string().optional(),
  k: z.number().int().positive().default(10),
  status: z.string().optional(),
  visibility: z.string().optional(),
});

export type ClosureSearchRequest = z.infer<typeof closureSearchRequestSchema>;

/**
 * `query_story` agent tool input (VS1 R5/AC5; CR-08 revives validation).
 *
 * Deliberately has NO `projectId`: the shell handler derives it from the project
 * directory (`getProject(path.resolve(projectDir))`), so the tool surface the
 * LLM sees is just `{ query, entry_type?, status?, visibility?, k? }` (snake_case
 * to match the agent tool params in `builtin.ts`).
 *
 * `k` is CLAMPED to [1, 50] rather than rejected, so a bad LLM param can never
 * produce an unbounded SQLite `LIMIT` (k=-1 → all rows) or an empty result
 * (k=0), and never crashes the tool call (the handler "never throws" contract).
 * 50 is a reasonable cap for the LLM context budget. k omitted → default 10
 * (matches the agent tool description + closureSearchRequestSchema).
 *
 * - `status` / `visibility`（Story 8.7 R4/S6 扩参，mirror catalogEntriesRequestSchema 措辞单源）：
 *   handler 透传 searchClosure opts（S5 已支持预过滤）。describe 就地解释词表（说人话双规则——
 *   agent 读不到 schema 注释，值域含义必须进 describe）。
 */
export const closureStoryQuerySchema = z.object({
  query: z
    .string()
    .default('')
    .describe('自然语言查询，如人物特征、场景设定、情节线索'),
  entry_type: z
    .string()
    .optional()
    .describe('条目类型过滤（如 character/location/rule）；不填则全类型'),
  status: z
    .string()
    .optional()
    .describe('只检索该状态的卡（draft=草稿 / active=定稿在用 / deprecated=已弃用 / locked=锁定禁改）；不填则全状态'),
  visibility: z
    .string()
    .optional()
    .describe('可见性过滤；当前所有条目都是 known，可不填（预留维度）'),
  k: z
    .number()
    .int()
    .default(10)
    .transform((v) => Math.max(1, Math.min(50, v)))
    .describe('返回条目数（默认 10）'),
});

export type ClosureStoryQuery = z.infer<typeof closureStoryQuerySchema>;

// ── Story 6.4 D2：relation 图遍历召回臂（mirror query_story 通用工具）──
//
// query_relations：图遍历召回「结构关联但语义不相似」条目（补 searchClosure 语义盲区）。
// seed→N-hop 递归 CTE 扩展（depth+budget caps 防 token 爆炸，kb-structure-design-research.md:375）。
// mirror query_story 通用工具模式（任何 agent 可调；handler 从 projectDir 解析 projectId，故入参无 projectId）。
//
// 范式判据（ADR-3）：递归 CTE = 纯代码图遍历（查询/汇编），无 LLM/无语义裁判。
// 否决 graph DB / PPR / logic engine（单库 SQLite 递归 CTE 足够，kb-research ctxgraph 先例）。

/**
 * `query_relations` agent tool input（mirror closureStoryQuerySchema）。
 *
 * - `seed_entry_id`：起点 entry（assetCardId，对齐 closure_entry.entry_id）。
 * - `depth`：N-hop 递归深度，CLAMP [1,5]（防递归爆炸 + token 胀）。
 * - `budget`：结果数 cap，CLAMP [1,100]（防 LLM context 胀）。
 * - `relation_type` / `visibility`：可选过滤（词表见 relationTypeSchema；visibility 读者视角）。
 *
 * snake_case 对齐 agent tool params（mirror closureStoryQuerySchema）。clamp 而非 reject（mirror「never throws」）。
 */
export const relationQuerySchema = z.object({
  seed_entry_id: z.string().min(1),
  depth: z.number().int().default(2).transform((v) => Math.max(1, Math.min(5, v))),
  budget: z.number().int().default(20).transform((v) => Math.max(1, Math.min(100, v))),
  relation_type: z.string().optional(),
  visibility: z.enum(['public', 'secret', 'one_sided']).optional(),
});

export type RelationQuery = z.infer<typeof relationQuerySchema>;

/**
 * 单条结构关联命中（mirror EntryHit，但 score 换成结构维度）。
 *
 * - `relationType`：通过哪种关系到达此条目（最后一条边的 relation_type）。
 * - `depth`：距 seed 的跳数（1=直接邻居；>1=多跳）。
 * - `viaPath`：从 seed 到此条目的 entryId 路径（审计/调试 + LLM 理解关联链）。
 *
 * name/bodyText/entryType 经 JOIN closure_entry 取（结构索引不存 body，design §3.1）。
 */
export const relationHitSchema = z.object({
  entryId: z.string(),
  projectId: z.string(),
  entryType: z.string(),
  name: z.string(),
  bodyText: z.string(),
  relationType: z.string(),
  depth: z.number().int(),
  viaPath: z.array(z.string()),
});

export type RelationHit = z.infer<typeof relationHitSchema>;
