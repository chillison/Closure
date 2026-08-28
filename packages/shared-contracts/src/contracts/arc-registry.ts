import { z } from 'zod';

// ── Story 8.2：arc_registry 创作字段 + 弧审 schema + 关口/停滞判定纯函数（design §3）──
//
// 弧 = 多种类叙事线程的生命周期（卷弧 = outline phase / 线弧 = scene_graph line / 成长弧 = 角色
// growth curve），一章可属多弧（重叠跨度非切窗）。8.2 长程连贯三件事的契约载体：
// 1. 写时声明（谁判弧闭合）：写手（LLM）写完一章回头看正文，声明各弧节拍（advance/close）——
//    创作意图的载体。既不事后机械推断（锚场/数章数判不了意图，用户修正拍板），也不每章深审（贵）。
// 2. 关口大审（深判聚点）：卷弧闭合时一次通读全卷正文判所有弧 + 产卷摘要（折叠快照，8.1 两级摘要
//    范式的弧级 LLM 通读侧）。
// 3. 停滞触发（纯代码检测）：线弧/成长弧有既往节拍 + 未闭合 + 连续 N 章无新 beat → 该弧专注审。
//
// 范式归属（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md，本文件的头等契约）：
// - 归写手 LLM：弧节拍声明（advance/close 的「意义/意图」判断——本章是否推进/闭合了这条弧，创作
//   意图在写作那一刻的写手视角里，事后机械反推判不了）+ close 的正文 grounding 选择。
// - 归弧审 agent LLM（arc-audit-agent，AGENT-009 owner）：跨弧语义挣得裁判（卷弧完整性/arc-drift/
//   foreshadow-payoff/theme-earning/character-arc/emotion-arc 六维）+ route 三档分类（defect/
//   deviation/gray 是语义判断非规则）+ 卷摘要撰写（两级摘要范式：弧级必须通读正文，非机械折叠）。
// - 归纯代码（本文件）：关口判定（卷弧 close beat 在本章吗——集合查询）/ 停滞检测（无新节拍章数
//   计数）/ span 派生（首末 beat episode index 区间）/ bounded action 投影（applyArcLedgerActions
//   幂等归并）。零语义判断——不判「这条弧写得圆不圆」（归弧审 LLM）。
//
// 存储归属：arc_registry 是 creative field（project.yaml，mirror promise_registry / InfoReleaseMap
// 「LLM 写入并对它负责」惯例），非 closure_* 派生表——beats 是写手声明（LLM-authored 叙事状态，
// 重跑不复现），且伏笔弧已由 promise beats 承载（6.5，8.2 不重复登记）。弧审产物（ArcAuditResult）
// 另住 closure_arc_summary DERIVED 表（可 drop 重跑重建，shell 侧 design §4）。
//
// expected_downstream_consumers:
// - Story 8.2 Step 3（agent）：arc-emergence-node 写时节拍登记（query_arc 读避重复 + arc_ledger_update
//   bounded 写 autoApply）。
// - Story 8.2 Step 4（agent）：write_chapter post-settle 关口判定（detectVolumeClosure 读本章 beats）→
//   arc-audit-agent 大审（deriveArcSpan 定通读区间）+ 停滞触发（detectArcStagnation）。
// - Story 4.4（agent，既有）：completeness-verify-node 上下文升级消费 arcSnapshot（弧摘要折叠注入）。

// ── ArcBeat（写手声明的弧节拍，design §3 原样）──

/**
 * 单条弧节拍。挂 episode（写完一章时声明），非挂 scene——弧推进是章级叙事判断。
 * 幂等：同 (episodeId, arcRef, action) 一 beat（applyArcLedgerActions 处理，重复 set 覆盖）。
 */
export const arcBeatSchema = z.object({
  id: z.string().min(1),
  episodeId: z.string().min(1),
  episodeIndex: z.number().int().nonnegative(),
  /** 弧引用：卷弧 = outline phase id / 线弧 = scene_graph line id / 成长弧 = `growth:<characterId>`。 */
  arcRef: z.string().min(1),
  arcKind: z.enum(['volume', 'line', 'growth']),
  action: z.enum(['advance', 'close']),
  /** 写手视角一句话语义（本章对这条弧做了什么）。 */
  note: z.string().optional(),
  /** 正文原句锚定（close 必填——闭合声明须有 grounding，mirror promise beat grounding 哲学；写入侧 schema 强制）。 */
  grounding: z.string().optional(),
});
export type ArcBeat = z.infer<typeof arcBeatSchema>;

/** arc_registry 创作字段（mirror promiseRegistrySchema：beats + version + updatedBy）。 */
export const arcRegistrySchema = z.object({
  beats: z.array(arcBeatSchema).default([]),
  version: z.number().int().nonnegative().default(0),
  updatedBy: z.enum(['user', 'agent', 'sync']).default('agent'),
});
export type ArcRegistry = z.infer<typeof arcRegistrySchema>;

// ── 弧审产物（arc-audit-agent 大审/专注审输出，design §3 原样）──

/**
 * 单条弧审发现。route 三档分类是弧 agent 的 LLM 语义判断（design §5：defect=明确缺陷→surface /
 * deviation=明确偏离→StoryDecision / gray=灰区→裁决器附弧上下文），非规则硬编码。
 */
export const arcAuditFindingSchema = z.object({
  category: z.enum([
    'volume-arc', // 卷弧完整性（本卷故事讲圆没有）
    'arc-drift', // 弧漂移/停滞
    'foreshadow-payoff', // 伏笔兑现（关口汇总深判，非 6.5 per-chapter 检查）
    'theme-earning', // 主题挣得
    'character-arc', // 角色弧（正文自洽判；growth_curve 设计层地基归 8.5）
    'emotion-arc', // 情绪弧挣得（卷级，5.3/5.4 是 per-chapter 数学/场级）
  ]),
  route: z.enum(['defect', 'deviation', 'gray']),
  /** mirror 4.4 两档 + 扩（stalled = 停滞专注审的典型 verdict）。 */
  verdict: z.enum(['missing', 'under-developed', 'stalled', 'drifted']),
  entityId: z.string().min(1),
  entityLabel: z.string().min(1),
  /** grounding 硬要求（mirror 4.4 / Reader-Audit——发现必须锚定正文）。 */
  quote: z.string().min(1),
  location: z.string().min(1),
  explanation: z.string().min(1),
  /** 给 Director 的重规划参考（{{arcFeedback}} 反哺通道，mirror suggestedFix 哲学）。 */
  suggestedFix: z.string().min(1),
});
export type ArcAuditFinding = z.infer<typeof arcAuditFindingSchema>;

/**
 * 弧审结果（大审双产出：arcSummary 卷摘要 + findings；停滞专注审只产 findings 无摘要——该弧还没完，
 * 摘要无终态语义，design §7）。落 closure_arc_summary（DERIVED）。
 *
 * 永不假 pass（mirror 4.4 AC6 / Reader-Audit R6①）：大审 parse 失败 → degraded=true + findings=[] +
 * degradationNote 标注，不静默。
 */
export const arcAuditResultSchema = z.object({
  arcRef: z.string().min(1),
  arcKind: z.enum(['volume', 'line', 'growth']),
  span: z.object({ fromEpisodeIndex: z.number().int(), toEpisodeIndex: z.number().int() }),
  /**
   * 卷摘要（宽松预算：卷梗概 + per-line 支线段 + 成长弧状态 + 情绪弧观察 + 主题观察 + 遗留钩子）。
   * 两级摘要范式（用户 2026-08-17 拍板）：弧级摘要必须 agent 通读正文撰写（非机械折叠章摘要），
   * 章摘要只作导航地图。optional——停滞专注审无摘要。
   */
  arcSummary: z
    .object({
      synopsis: z.string(),
      lineSections: z
        .array(z.object({ lineId: z.string(), name: z.string(), summary: z.string() }))
        .default([]),
      characterArcs: z
        .array(z.object({ characterId: z.string(), summary: z.string() }))
        .default([]),
      emotionArcObservation: z.string().optional(),
      themeObservation: z.string().optional(),
      /** 遗留钩子（转下卷/下弧）。 */
      openThreads: z.array(z.string()).default([]),
    })
    .optional(),
  findings: z.array(arcAuditFindingSchema).default([]),
  degraded: z.boolean().default(false),
  degradationNote: z.string().optional(),
});
export type ArcAuditResult = z.infer<typeof arcAuditResultSchema>;

// ── 关口/停滞/span 判定纯函数（design §3；零语义判断，ADR-3 ✓）──

/**
 * 停滞检测阈值（design §2：N 默认 10，常量可调）。「每 N 章」在 epics AC 的正确落点 = 此 N
 * （停滞检测阈值），非机械切窗审核。
 */
export const ARC_STAGNATION_CHAPTERS = 10;

/**
 * detectVolumeClosure：本 episode 是否有卷弧 close beat（关口判定，write_chapter post-settle 消费）。
 * 纯函数——集合查询（arcKind='volume' ∧ action='close' ∧ episodeId 匹配），零语义。
 *
 * 幂等登记下同弧同章至多一 close beat；极罕见多卷弧同章闭合时返回 beats 序中首条（caller 可按
 * arcRef 逐弧派发，本函数只回答「本章有没有卷关门」）。
 *
 * @param beats     全量 registry beats（函数自行过滤；调用方无须预过滤）。
 * @param episodeId 本章 episode id。
 * @returns         本章声明的首条卷弧 close beat；无 → undefined（不大审，零成本路径 design §2）。
 */
export function detectVolumeClosure(beats: readonly ArcBeat[], episodeId: string): ArcBeat | undefined {
  return beats.find(
    (b) => b.arcKind === 'volume' && b.action === 'close' && b.episodeId === episodeId,
  );
}

/**
 * deriveArcSpan：某弧的节拍区间（首末 beat 的 episodeIndex，含端点闭区间）。
 * 纯函数——min/max 计算。span 随实际节拍走（非规划 estimated_chapters）——规划漂移自然被吸收
 * （用户「弧跨度以写手声明为准」修正的必然推论，design §2 卷弧 span 自愈）。
 *
 * @param beats   全量 registry beats（函数按 arcRef 过滤；跨弧 beats 混传安全）。
 * @param arcRef  目标弧引用。
 * @returns       {fromEpisodeIndex, toEpisodeIndex}；该弧无任何 beat → undefined（无区间可派生）。
 */
export function deriveArcSpan(
  beats: readonly ArcBeat[],
  arcRef: string,
): { fromEpisodeIndex: number; toEpisodeIndex: number } | undefined {
  let from: number | undefined;
  let to: number | undefined;
  for (const b of beats) {
    if (b.arcRef !== arcRef) continue;
    if (from === undefined || b.episodeIndex < from) from = b.episodeIndex;
    if (to === undefined || b.episodeIndex > to) to = b.episodeIndex;
  }
  return from !== undefined && to !== undefined ? { fromEpisodeIndex: from, toEpisodeIndex: to } : undefined;
}

/** 停滞弧条目（detectArcStagnation 返回；专注审派发输入）。 */
export interface ArcStagnationInfo {
  arcRef: string;
  /** 'line' | 'growth'（volume 弧长跨度属正常，不参与停滞检测）。 */
  arcKind: 'line' | 'growth';
  /** 该弧最后一个 beat 的 episode index。 */
  lastBeatEpisodeIndex: number;
  /** 距当前章的章数差（currentEpisodeIndex - lastBeatEpisodeIndex，恒 > n）。 */
  chaptersSinceLastBeat: number;
  /** 该弧节拍区间（span = deriveArcSpan 单源——专注审通读范围）。 */
  span: { fromEpisodeIndex: number; toEpisodeIndex: number };
}

/**
 * detectArcStagnation：找出停滞弧——有既往节拍 + 无 close beat + 最后 beat 距今 > n 章（design §2）。
 * 纯函数——分组 + 计数，零语义（判「这条弧写得怎么样」归弧审 LLM；本函数只报「多久没动了」）。
 *
 * **只对 arcKind 'line' | 'growth'**：volume 弧天然横跨整卷（首 beat 到 close 数十章属正常），
 * 同一标准误报停滞。growth 弧（`growth:<characterId>`）跨多卷也参与——成长弧连续 10+ 章 zero
 * 推进正是 8.2 要抓的「角色弧停滞」（prd Goal）。
 *
 * 输入契约：beats 是写时声明的实际轨节拍（写完一章登记一次），构造上无未来章 beat；函数不按
 * currentEpisodeIndex 截断（防御性留给 caller 的数据来源——query_arc 读到的就是已落盘 beats）。
 *
 * @param beats               全量 registry beats（函数按 arcRef 分组；调用方无须预过滤）。
 * @param currentEpisodeIndex 当前章 episode index。
 * @param n                   停滞阈值（章），缺省 ARC_STAGNATION_CHAPTERS=10。边界：距 n 章不算停滞，
 *                            超过 n 章才算（lastBeatEpisodeIndex < currentEpisodeIndex - n）。
 * @returns                   停滞弧列表（registry beats 首次出现序；空 = 无停滞弧不派发）。
 */
export function detectArcStagnation(
  beats: readonly ArcBeat[],
  currentEpisodeIndex: number,
  n: number = ARC_STAGNATION_CHAPTERS,
): ArcStagnationInfo[] {
  interface ArcAccum {
    arcRef: string;
    arcKind: 'line' | 'growth';
    lastBeatEpisodeIndex: number;
    closed: boolean;
  }
  const byArc = new Map<string, ArcAccum>();
  for (const b of beats) {
    // volume 弧不参与（长跨度正常）；close beat 的弧在遇到 close 时标 closed。
    if (b.arcKind !== 'line' && b.arcKind !== 'growth') continue;
    let acc = byArc.get(b.arcRef);
    if (acc === undefined) {
      acc = { arcRef: b.arcRef, arcKind: b.arcKind, lastBeatEpisodeIndex: b.episodeIndex, closed: false };
      byArc.set(b.arcRef, acc);
    }
    if (b.episodeIndex > acc.lastBeatEpisodeIndex) acc.lastBeatEpisodeIndex = b.episodeIndex;
    if (b.action === 'close') acc.closed = true;
  }

  const stagnant: ArcStagnationInfo[] = [];
  for (const acc of byArc.values()) {
    if (acc.closed) continue; // 已闭合弧不审停滞（终态）
    const gap = currentEpisodeIndex - acc.lastBeatEpisodeIndex;
    if (gap <= n) continue; // 边界：距 n 章不算（须严格超过）
    const span = deriveArcSpan(beats, acc.arcRef);
    if (span === undefined) continue; // 理论不可达（acc 存在即有 beat）；防御
    stagnant.push({
      arcRef: acc.arcRef,
      arcKind: acc.arcKind,
      lastBeatEpisodeIndex: acc.lastBeatEpisodeIndex,
      chaptersSinceLastBeat: gap,
      span,
    });
  }
  return stagnant;
}

// ── arc_ledger_update bounded action + projector（mirror promiseActionSchema / applyPromiseActions）──
//
// LLM 经 arc_ledger_update 工具发 bounded action，handler 调本纯函数投影出 full registry → field_patch
// envelope（action:'set'）→ UI patch-review → fieldSyncBridge 落盘（leader/PatchReview 路径）；或
// emergence node 传 autoApply=true 直落（source='agent'，mirror promise_ledger_update A1 双档）。
// projector 纯代码机械（ADR-3 ✓）；trust-boundary 校验在 handler（schema parse + projected safeParse）。

/**
 * beat 写入 shape（add_beat.beat 输入）。id 可缺——projector 按 (arcRef, episodeId, action) 自然键
 * `${arcRef}::${episodeId}::${action}` 生成（确定性，无需 crypto）。close 必带 grounding 在此写入侧
 * 强制（superRefine；存储 schema 容忍历史数据，写入门收紧——两 schema 分离，mirror 7.3 zod 顶层
 * refine 教训：refine 挂在被消费的 object schema 本身非外层 union）。
 */
export const arcBeatWriteSchema = arcBeatSchema
  .partial({ id: true })
  .superRefine((b, ctx) => {
    if (b.action === 'close' && (b.grounding === undefined || b.grounding.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['grounding'],
        message: 'close beat 必须带正文原句 grounding（弧闭合声明的锚定，design §2）',
      });
    }
  });
export type ArcBeatWrite = z.infer<typeof arcBeatWriteSchema>;

export const arcLedgerActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_beat'),
    beat: arcBeatWriteSchema,
  }),
]);
export type ArcLedgerAction = z.infer<typeof arcLedgerActionSchema>;
/**
 * ArcLedgerAction 输入类型（defaulted 字段可缺——applyArcLedgerActions 接受此类型，内部 parse 归一）。
 * 调用方（handler / 测试）可传 raw action；projector 是归一化 + 投影的单点（mirror PromiseActionInput）。
 */
export type ArcLedgerActionInput = z.input<typeof arcLedgerActionSchema>;

/**
 * 把 bounded actions 投影到当前 ArcRegistry → 新 full registry。纯函数（无副作用，mirror
 * applyPromiseActions）。
 *
 * - add_beat：幂等——同 (arcRef, episodeId, action) 自然键一 beat，重复 set 覆盖 note/grounding，
 *   保留既有 id（emergence 重跑同章 = 覆盖不累积）；未命中 → 追加（id 缺省按自然键生成）。
 * - version/updatedBy 由 fieldSyncBridge.onFieldEdited 落盘时 bump（非 projector 职责），透传 current
 *   装饰值（mirror promise projector 注释）。
 *
 * @param current  当前 registry（corrupt on-disk 由 handler 先拒——本函数信任输入已合法）。
 * @param actions  bounded actions（defaulted 字段可缺；内部 parse 归一应用 defaults + 自然键 id）。
 */
export function applyArcLedgerActions(
  current: ArcRegistry,
  actions: ArcLedgerActionInput[],
): ArcRegistry {
  let beats = [...current.beats];
  for (const action of actions) {
    switch (action.type) {
      case 'add_beat': {
        beats = upsertArcBeat(beats, normalizeArcBeat(action.beat));
        break;
      }
    }
  }
  return { ...current, beats };
}

/**
 * beat 写入归一：id 缺失时按自然键 `${arcRef}::${episodeId}::${action}` 生成（确定性 + 跨重复声明稳定）。
 * arcRef/episodeId/action 是 arcBeatSchema 必填字段（.partial({id:true}) 仅松 id），故自然键恒可算。
 *
 * export（Story 8.2 Step 3）：arc-emergence-node 覆写 episodeId/episodeIndex 后经此归一（缺 id 的 beat
 * 若不补自然键 id，artifact 透传侧 arcBeatSchema per-element safeParse 会静默丢——id required）。单源
 * 自然键公式，防 node 侧复制漂移。
 */
export function normalizeArcBeat(input: z.input<typeof arcBeatWriteSchema>): ArcBeat {
  const id = input.id ?? `${input.arcRef}::${input.episodeId}::${input.action}`;
  return arcBeatSchema.parse({ ...input, id });
}

/**
 * beat upsert（幂等）：按 id OR (arcRef, episodeId, action) 自然键找既有 beat；找到 → 覆盖
 * note/grounding 等保留既有 id；未找到 → 追加。mirror upsertBeat（promise）自然键幂等哲学——
 * emergence 重跑同章不重复累积。
 */
function upsertArcBeat(beats: ArcBeat[], beat: ArcBeat): ArcBeat[] {
  const idx = beats.findIndex(
    (b) =>
      b.id === beat.id ||
      (b.arcRef === beat.arcRef && b.episodeId === beat.episodeId && b.action === beat.action),
  );
  if (idx >= 0) {
    return beats.map((b, i) => (i === idx ? { ...beat, id: b.id } : b));
  }
  return [...beats, beat];
}

// ── Story 8.2 IPC 请求 schemas（handler 校验 + agent builtin 工具描述共用单源，mirror world-state.ts 段）──

/** query_arc 最近窗 beat 数上限（防倾倒；百万字项目 beats 数千条，读侧加窗 design §7）。 */
export const ARC_QUERY_BEAT_WINDOW = 200;

/** query_arc handler/tool 入参（收窄 episodeId/arcRef，均可缺省 = 全量〔最近窗内〕）。 */
export const queryArcRequestSchema = z.object({
  episodeId: z.string().min(1).optional(),
  arcRef: z.string().min(1).optional(),
});
export type QueryArcRequest = z.infer<typeof queryArcRequestSchema>;

/** arc_ledger_update handler/tool 入参（bounded actions + autoApply 双档，mirror promise_ledger_update）。 */
export const arcLedgerUpdateRequestSchema = z.object({
  actions: z.array(arcLedgerActionSchema),
  autoApply: z.boolean().optional(),
  /**
   * CR-001（8.5 BMad CR）autoApply 自审闸门：LLM 首次带 autoApply:true 调用会在 agent runLoop
   * 被拦截要求自审，重发带 selfReviewConfirmed:true 才执行。链上节点（arc-emergence）程序化
   * registry.execute 直调不经闸门，无需传。入 schema 防 strict provider 按 JSON Schema 拒未知键
   * （zodToJsonSchema 面需含此键，否则重发死循环）；handler 侧 zod strip 容忍多余键。
   */
  selfReviewConfirmed: z.boolean().optional(),
});
export type ArcLedgerUpdateRequest = z.infer<typeof arcLedgerUpdateRequestSchema>;

/** query_arc_summary handler/tool 入参（收窄 arcRef，缺省 = 每弧最新一行）。 */
export const queryArcSummaryRequestSchema = z.object({
  arcRef: z.string().min(1).optional(),
});
export type QueryArcSummaryRequest = z.infer<typeof queryArcSummaryRequestSchema>;

/**
 * record_arc_audit handler/tool 入参（Story 8.2 Step 4）：arc-audit-agent 产物落 closure_arc_summary
 * DERIVED 表。write_chapter post-settle 程序化调用（非 LLM 直接调；autoApply 语义——DERIVED 快照可
 * drop 重建，无人审语义，mirror materialize_chapter_summary 链内写工具定位）。result 的 arcRef/arcKind/
 * span 是机械字段（caller 纯代码派生后覆写，不信 LLM 回显——mirror 7.1 F2 判据），handler 再 schema
 * 校验 + 与 auditKind 冗余列一致性 belt。
 */
export const recordArcAuditRequestSchema = z.object({
  auditKind: z.enum(['closure', 'stagnation']),
  result: arcAuditResultSchema,
});
export type RecordArcAuditRequest = z.infer<typeof recordArcAuditRequestSchema>;
