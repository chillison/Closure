import { z } from 'zod';

// ── Story 7.4 cross-chapter feedback ledger（design §2 / ADR-3 / orchestration-pattern.md Convention）──
//
// 独立 cross-chapter 反馈 ledger 持久层（非 project.yaml，spec 反模式 orchestration-pattern.md:372 禁止链段
// artifact 进 project.yaml）。把链段 artifact（review.latest / emotion_verify_result / completeness_verify_result）
// 按 episode 写入 DB（closure_feedback_ledger 表），write_chapter chain-start 读上一章填 feedback var。
//
// 一次接通激活 Director 三段（7.3 atomicEditProposals 读 auditFindings / 5.3 情绪调整读 emotionVerifyFeedback /
// 4.4 完整性补缺读 completenessFeedback）。orchestration-pattern.md Convention「管道先建数据后接」：Step 1 建读写
// 通道，Step 2 接 write_chapter 消费。
//
// 🔑 范式判据（ADR-3）：ledger 读写 = 纯代码确定性记账（episode→artifact 持久化机械），不裁判语义。payload
// 存全量 artifact 不强校验内部——ledger 是持久/传输层非校验门（artifact schema 演进不应破 ledger 读旧数据）。
//
// payload 宽松容错策略（design §2.2）：三 artifact_key 的 payload 作 `.passthrough()` 宽松存储——不复用既有
// reviewOutputSchema（在 agent 包非 shared-contracts）/ emotionVerifyResultSchema / completenessVerifyResultSchema
// 作严格校验，而是 `z.record(z.unknown())` 宽松收。原因：① ledger 存全量 artifact 非校验门，内部 schema 演进
// 不应破读旧数据；② reviewOutputSchema 在 agent 包（chapter-nodes.ts）非 shared-contracts，跨包引用破
// module-boundaries；③ 三个 artifact shape 各异且可能演进，统一宽松 record 避免 ledger 耦合 artifact 版本。

/**
 * feedback ledger 支持的链段 artifact key（design §2.2）。
 *
 * - 'review.latest'：Reader-Audit 审核产物（route 判 route_decision + escalateFindings 源）。Director 读作
 *   auditFindings（7.3 atomicEditProposals 输入）。
 * - 'emotion_verify_result'：5.3 emotion-verify-node 产物（情绪偏离 flag + DTW 指纹 + payoff 联动）。Director
 *   读作 emotionVerifyFeedback（5.3 情绪调整输入）。
 * - 'completeness_verify_result'：4.4 completeness-verify-node 产物（cross-arc 缺漏候选 + L2 语义挣得裁判）。
 *   Director 读作 completenessFeedback（4.4 完整性补缺输入）。
 *
 * 扩 key 时同步：repository readPrevEpisodeFeedback 读取列表 + feedback-ledger-node 写入列表。
 */
export const FEEDBACK_LEDGER_ARTIFACT_KEYS = [
  'review.latest',
  'emotion_verify_result',
  'completeness_verify_result',
] as const;

export type FeedbackArtifactKey = (typeof FEEDBACK_LEDGER_ARTIFACT_KEYS)[number];

/**
 * feedback ledger payload schema（宽松容错，design §2.2）。
 *
 * `z.record(z.unknown())` 收任意 JSON 对象——ledger 存全量 artifact 非校验门（artifact 内部 schema 演进不应破
 * 读旧数据）。坏 JSON（非对象如裸字符串/数字）理论不应出现（写入端 serialize JSON.stringify object），但
 * `z.unknown()` 宽松收（deserialize try/catch 先拦，schema 再兜底）。
 */
export const feedbackLedgerPayloadSchema = z.record(z.unknown());

/**
 * feedback_ledger_write 工具入参 schema（agent → toolExecution → handler → repository）。
 *
 * episodeId / artifactKey 必填；payload 是链段 artifact 对象（serialize 前）。projectId 不在入参——handler
 * 从 projectDir 解析（mirror query_story / write_world_events，守 db-repository §2.7 命名空间惯例）。
 */
export const feedbackLedgerWriteRequestSchema = z.object({
  episodeId: z.string().min(1),
  artifactKey: z.enum(FEEDBACK_LEDGER_ARTIFACT_KEYS),
  payload: feedbackLedgerPayloadSchema,
});

/**
 * feedback_ledger_read 工具入参 schema（读单 episode 单 key，或单 episode 全 key）。
 *
 * artifactKey 缺省 → handler 返该 episode 全 key（readFeedbackLedger 不限 key）；artifactKey 指定 → 单 key。
 * 读「上一章」由 caller 传 prevEpisodeId（episodeId 字段）——handler 不做 index-1 推导（caller 知道映射，
 * design §2.2「readPrevEpisodeFeedback 读 episode.index-1 三 key」是 repository 层 helper 非 handler 职责）。
 */
export const feedbackLedgerReadRequestSchema = z.object({
  episodeId: z.string().min(1),
  artifactKey: z.enum(FEEDBACK_LEDGER_ARTIFACT_KEYS).optional(),
});

export type FeedbackLedgerWriteRequest = z.infer<typeof feedbackLedgerWriteRequestSchema>;
export type FeedbackLedgerReadRequest = z.infer<typeof feedbackLedgerReadRequestSchema>;

/**
 * feedback ledger 读回单条记录（repository readFeedbackLedger / readPrevEpisodeFeedback 返）。
 *
 * payload 是 deserialize 后的对象（JSON.parse 还原）；producedAt 是写入时间戳（ISO）。readFeedbackLedger
 * 未命中 → undefined（非 null，mirror getWorldSubject 返 undefined 契约）。
 */
export interface FeedbackLedgerEntry {
  episodeId: string;
  artifactKey: FeedbackArtifactKey;
  /**
   * deserialize 后的 payload 对象。`corruptPayload=true` 时缺省（坏 JSON 不造假对象）。
   * caller 消费前须判 `corruptPayload`（true → warn + 当空处理，不喂下游坏数据）或判 `payload` truthiness。
   */
  payload?: Record<string, unknown>;
  /**
   * BMad CR-011：true = 行 payload 是坏 JSON（deserialize 返 undefined）。旧实现 `?? {}` 折叠空对象掩盖，
   * 调用者无法区分合法空 artifact vs 坏 JSON 行（诊断信息丢失）。现标记 corrupt 让两态可区分。
   */
  corruptPayload?: boolean;
  producedAt: string;
}

// ── serialize / deserialize 纯函数（agent 写入端 + repository 读回端共用同形态单源）──

/**
 * 序列化 payload 对象为 JSON 字符串（repository 写入 TEXT 列）。
 *
 * 纯函数（JSON.stringify 包装）。caller 保证 payload 是合法 JSON 对象（节点端从 run.artifacts 取，shape 由
 * 产者节点保证；repository 端不再校验——db-repository.md「Zod 校验在 IPC 层一次」）。
 */
export function serializeFeedbackPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

/**
 * 反序列化 payload JSON 字符串为对象（repository 读回 TEXT 列）。
 *
 * 纯函数 + 宽松容错（mirror patchRowToRecord CR-E6）：坏 JSON（非 JSON 文本，理论不应出现但手动改库/老化
 * 数据可能）→ try/catch 返 undefined 不崩。caller（handler / repository）见 undefined 自行降级（空串 feedback var，
 * mirror Director graceful「空→忽略该段」）。
 */
export function deserializeFeedbackPayload(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    // 非 plain object（裸字符串/数字/null）→ undefined（payload 契约是 object；坏数据不造假）。
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
