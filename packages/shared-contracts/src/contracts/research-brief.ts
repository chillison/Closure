import { z } from 'zod';

// ── Story 8.4 写手记忆供给体系：调查简报 / 核实判定 / 热层编译报告三契约（design §1.4/§1.5/§2.1）──
//
// 范式归属（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：本文件三 schema = **结构契约**
// （Zod，字段名 snake_case 承 agentPolicy.fieldNameCase）。researchBrief / verificationVerdict 的
// **填写归 LLM**（写手自查产简报、资料员核实产判定——「查什么 / 核实什么 / 缺什么」是语义判断，
// schema 不编码）；schema 只把两条结构红线钉死在 parse 边界：
//
// ① **出处锚定强制**：entries[].key_facts[].source 非空强制（trim 后 ≥1 字符）——无出处的关键事实
//   拒收（design §1.4「无 source 的 keyFact 编译期拒收」；防简报变形式主义——乱填 fact 无 source
//   无法复核，prd §6 风险表「出处强制字段 + 资料员抽查出处真伪」的第一道线）。
// ② **执行案零大纲正文**：execution_plan 只有 scene_ref（引用 scene_graph 场 id）+ beat_coverage +
//   notes 自由文本，**schema 无「大纲正文」字段——复制无处可放**（双真相源红线，design §1.4：执行案
//   引用既有大纲不复制；对拍大纲走 scene_ref join，大纲正文唯一源在 scene_graph/outline）。zod 默认
//   strip 未声明字段——LLM 硬塞的大纲正文字段在 parse 处剥除，物理不可能随简报落进章档案（测试钉死）。
//   防复制三道线：本 schema 无字段可放（结构线）+ Step 2 prompt 措辞「引用场编号不复制」（指令线）+
//   资料员核实 / Reader-Audit 归因对照（语义线）。notes 是自由文本字段，「这段自由文本是不是抄的
//   大纲」schema 判不了——语义判断归 LLM（范式判据），不在此编码。
//
// compileReport 例外：**纯代码产物**（brief-compiler 产侧 + estimatePinnedTokens 复用，Step 7 B 段）——
// token 度量 / 汇总 / 降级记账是机械数学，非 LLM 填写。报告经链段 `compile_report` **伴生 artifact**
// 携带（Step 7 勘察定案：chapter_brief 是 chapterBriefSchema 单形态 artifact，内嵌字段会被下次 parse
// 剥除 + 污染 briefHash 指纹——伴生 artifact mirror 7.2 revision_guard 先例），不单独 IPC。
//
// 三件同文件（design §4「三文件或合一 research-brief.ts」取合一——同一 story 的契约族，消费链互相咬合）。
//
// expected_downstream_consumers:
// - Story 8.4 Step 2（A1-A3 写手 agent 化）：draft-writer 节点自查阶段收束产出 parse 用
//   researchBriefSchema（简报 = 阶段一收束标记产物）；briefHash 失效/复用判定（design §1.6 D2）
//   以 chapter_brief 内容指纹比对，落装配点。
// - Story 8.4 Step 3（A4-A6 资料员转岗核实）：核实子循环产出 parse 用 verificationVerdictSchema；
//   许可 = checklist 四判定全过（机械可审计；pass↔checklist 一致性 refine 钉死——非主观满足感）；
//   suggestions 不进 pass 计算（AC-3 测试钉死）。
// - Story 8.4 Step 4（A7/A8 矛盾暂停与挂起）：issues 含 contradiction / deviations 非空 /
//   escalate=true / 核实回合耗尽 → researchSuspensionSchema 载荷（RunSnapshot
//   artifacts['research_brief'].suspended → summary.researchSuspension）+ 全档位暂停（含全自动）。
// - Story 8.4 Step 6（A3 存档 / A11 审核对照）：简报+verdict+许可 写章档案（.orison/ 章产物目录，
//   章 id 索引）；Reader-Audit {{researchBrief}} optional var 消费 execution_plan 做三态归因
//   （execution_gap / planning_blind / plan_level）；缺简报降级零回归。
// - Story 8.4 Step 7（B1/B2 热层度量+降级梯）：brief-compiler 产 compileReport 随 chapter_brief
//   artifact 携带（不单独 IPC）；装配点（assembleChapterChainArtifacts / write_chapter 汇合处）汇总
//   两编译点（settings_context 侧 + chapter_brief 侧）判总额（design §2.1 D3——两编译点不各自判总额）
//   + 三级降级梯（L0-L3，铁律集永不裁）。

// ── 调查简报（design §1.4）：写手自查阶段的收束产物 ──
//
// 简报 = 调查 + 引用 + 写作执行案（prd 拍板 9）：查过条目带出处、发现的问题、本章场景级落实规划
// （引用大纲场编号不复制）、写前偏离亮牌（反馈闭环从写后打回前移到写前亮牌）。
//
// 三层审计链的中间层（prd 拍板 10）：计划（大纲）→ **意图（执行案）** → 事实（正文+章摘要）。
// 简报执行案不当章描述——章摘要（as-built，从实际正文提取）是唯一「发生了什么」；执行案是
// 「当时打算怎么写」（意图档案）。

/** 简报条目种类：查过什么类型的材料（asset 卡 / 原文章节 / 场 / 伏笔账 / 章·弧摘要）。 */
export const researchBriefEntryKindSchema = z.enum(['asset', 'chapter', 'scene', 'promise', 'summary']);
export type ResearchBriefEntryKind = z.infer<typeof researchBriefEntryKindSchema>;

/**
 * 关键事实 + 出处锚定。source = 第几章 / 哪张卡 / 哪个摘要等可复核出处描述（非空强制——
 * 资料员核实判定 ②「关键事实是否带出处」的机械前置线：空串在此拒收，出处**真伪**抽查归 LLM）。
 */
export const researchBriefKeyFactSchema = z.object({
  fact: z.string().min(1),
  source: z.string().trim().min(1),
});
export type ResearchBriefKeyFact = z.infer<typeof researchBriefKeyFactSchema>;

/** 查过条目：ref = 条目 id / 卡 id / 章号等引用（引用不复制——内容靠 key_facts 摘录 + source 回查）。 */
export const researchBriefEntrySchema = z.object({
  ref: z.string().min(1),
  kind: researchBriefEntryKindSchema,
  key_facts: z.array(researchBriefKeyFactSchema).min(1),
});
export type ResearchBriefEntry = z.infer<typeof researchBriefEntrySchema>;

/** 发现的问题。severity=contradiction → 触发 Step 4 暂停链（design §1.4/§1.7）。 */
export const researchBriefIssueSchema = z.object({
  desc: z.string().min(1),
  severity: z.enum(['info', 'warn', 'contradiction']),
});
export type ResearchBriefIssue = z.infer<typeof researchBriefIssueSchema>;

/**
 * 写作执行案（本章场景级落实规划）——**零大纲正文字段**（双真相源红线，见文件头 ②）：
 * - scene_ref：场 id（引用 scene_graph，对拍大纲用——join 回大纲，不内嵌）。
 * - beat_coverage：该场节拍覆盖标注（本章 Promise/剧情节拍落在这场的标注）。
 * - notes：节奏 / 实体用法 / 落笔要点自由文本（本章特有意图，非大纲复述）。
 */
export const researchBriefExecutionPlanSchema = z.object({
  scene_ref: z.string().min(1),
  beat_coverage: z.string(),
  notes: z.string().optional(),
});
export type ResearchBriefExecutionPlan = z.infer<typeof researchBriefExecutionPlanSchema>;

/** 写前偏离亮牌：写手自查后认为需偏离大纲/任务卡处（→ 资料员核实升级，design §1.4/§1.5）。 */
export const researchBriefDeviationSchema = z.object({
  scene_ref: z.string().min(1),
  plan_says: z.string().min(1),
  brief_says: z.string().min(1),
  reason: z.string().min(1),
});
export type ResearchBriefDeviation = z.infer<typeof researchBriefDeviationSchema>;

export const researchBriefSchema = z.object({
  /** 查过条目（含出处锚定的关键事实）。空 [] 结构合法（查无可记）——「查得够不够」归资料员核实判定 ①。 */
  entries: z.array(researchBriefEntrySchema),
  /** 发现的问题（contradiction → Step 4 暂停链）。空 [] = 无问题。 */
  issues: z.array(researchBriefIssueSchema),
  /** 写作执行案（引用场编号不复制大纲）。空 [] 结构合法——覆盖充分性归核实判定。 */
  execution_plan: z.array(researchBriefExecutionPlanSchema),
  /** 写前偏离亮牌。空 [] = 无偏离（正常态）。 */
  deviations: z.array(researchBriefDeviationSchema),
  /** 本章写作要点总述（意图档案头——「当时打算怎么写」的一句话总纲）。 */
  plan: z.string().min(1),
});
export type ResearchBrief = z.infer<typeof researchBriefSchema>;

// ── 资料员核实判定（design §1.5）：核实子循环的收束产物 ──
//
// 转岗后的 retrieval agent（agent id 保留不改，Step 3 prompt 重写承载语义）在独立上下文核实简报
// 产出。**许可 = 四判定清单全过（机械可审计，非主观满足感）**——pass 与 checklist 的一致性由
// refine 钉死：checklist 全 true 才许 pass=true，任一 false 则 pass 必须 false。资料员不能凭
// 「感觉不行」压下全过的核查（主观满足感），也不能凭「感觉可以」放过未过的项（越权放水）。
// escalate 与 pass 正交（deviations 非空 / contradiction 时 escalate=true 进暂停链——核查本身
// 可以全过仍需用户决断偏离）。

/** 四判定清单（prd A4）：①实体/场核查记录齐全 ②关键事实带出处 ③缺漏清单清空 ④无未上报矛盾。 */
export const verificationChecklistSchema = z.object({
  entities_checked: z.boolean(),
  sources_grounded: z.boolean(),
  gaps_cleared: z.boolean(),
  contradictions_zero: z.boolean(),
});
export type VerificationChecklist = z.infer<typeof verificationChecklistSchema>;

/** 缺漏项：只给「缺什么 + 出处线索」，零内容直塞（一手原则——写手自己补查，资料员不代查塞货）。 */
export const verificationGapSchema = z.object({
  desc: z.string().min(1),
  source_hint: z.string().min(1),
});
export type VerificationGap = z.infer<typeof verificationGapSchema>;

/** 叙事建议（软输入）：text = 建议内容；basis = 机械弹药依据（出场间隔统计 / 弧停滞信号）。不进 pass 计算。 */
export const verificationSuggestionSchema = z.object({
  text: z.string().min(1),
  basis: z.string().min(1),
});
export type VerificationSuggestion = z.infer<typeof verificationSuggestionSchema>;

/** 档案议题：设定卡过时/矛盾 → 走既有校验议题通道（3.3 模式），资料员无档案写权限。 */
export const archiveIssueSchema = z.object({
  card_ref: z.string().min(1),
  problem: z.string().min(1),
});
export type ArchiveIssue = z.infer<typeof archiveIssueSchema>;

export const verificationVerdictSchema = z
  .object({
    checklist: verificationChecklistSchema,
    /** 许可：四判定全过才 true（refine ①钉死与 checklist 一致——许可锁在清单结构里，非主观满足感）。 */
    pass: z.boolean(),
    /**
     * 缺漏清单。与 pass 的内容一致性由 refine ②③**双向**钉死：pass=true 须为空（②——gaps_cleared 与
     * gaps 内容不得矛盾）；pass=false 须非空（③——CR-004 补反向红线：未过许可必须给出「缺什么」，否则
     * 补查循环拿空清单空转三轮 + verify_exhausted 挂起文案无据可陈）。escalate 不豁免③——pass=false 的
     * escalate verdict（如 contradictions_zero=false）同样须携 gaps（矛盾本身即待决事项，可作一条 gap 记）。
     */
    gaps: z.array(verificationGapSchema),
    /** 叙事建议（软输入，不进 pass 计算——AC-3：建议存在与否许可结果不变）。 */
    suggestions: z.array(verificationSuggestionSchema),
    /** 档案议题（进校验议题通道，不直改档案）。 */
    archive_issues: z.array(archiveIssueSchema),
    /** 矛盾/偏离升级标记（design §1.5：deviations 非空或 issues 含 contradiction → true，进 Step 4 暂停链）。 */
    escalate: z.boolean().optional(),
  })
  .refine((v) => v.pass === (v.checklist.entities_checked && v.checklist.sources_grounded && v.checklist.gaps_cleared && v.checklist.contradictions_zero), {
    message: 'pass 与 checklist 四判定不一致（许可=清单全过，非主观满足感）',
    path: ['pass'],
  })
  .refine((v) => !v.pass || v.gaps.length === 0, {
    message: 'pass=true 但缺漏清单非空（gaps_cleared 与 gaps 内容矛盾）',
    path: ['gaps'],
  })
  .refine((v) => v.pass || v.gaps.length > 0, {
    message: 'pass=false 但缺漏清单为空（未过许可必须给出缺什么——空清单会让补查回合无从下手）',
    path: ['gaps'],
  });
export type VerificationVerdict = z.infer<typeof verificationVerdictSchema>;

// ── 出发核查挂起载荷（design §1.7 矛盾暂停，Story 8.4 Step 4 / A7/A8）──
//
// 写手/核实员任一 escalate（简报 contradiction / deviations 非空 / verdict.escalate=true）或核实回合
// 耗尽（≤3 轮末仍非 pass）→ 该章挂起：**全档位暂停（含全自动——结构性问题不带病开写，mirror 3.5
// 「BLOCK 永不采信」哲学），leader 核实 → 用户决断（改任务卡/改设定/维持原案）后恢复**。
//
// 挂起 ≠ 错误：链段 status='paused'（非 error），RunSnapshot errors 不计——恢复路径 = redo 重跑该章
// （决断后任务卡/设定变了 briefHash 变 / 维持原案 hash 同但简报 verified=false → 都重查，D2 判定
// 单源在 writer-node 章档案）。载荷挂在链段 artifacts['research_brief'].suspended，经 summarize
// 投影为 summary.researchSuspension（deliverable 豁免 context isolation——用户决断所需证据，
// mirror escalateFindings）。
//
// 范式判据（ADR-3）：挂起**触发**是机械判定（severity 枚举 / deviations 长度 / 回合计数——纯代码）；
// 矛盾**内容**的真伪与决断归人（leader 核实 + 用户裁决）。schema 只钉载荷结构。

/**
 * 出发核查挂起载荷。两族 kind：
 * - `verify_exhausted`：核实回合耗尽（WRITER_MAX_VERIFY_ROUNDS 末仍非 pass）仍缺漏——gaps 携末轮清单。
 * - `research_contradiction`：任务卡与资料矛盾 / 写前偏离升级——evidence 携简报机械证据
 *   （contradiction issues + deviations）+ 可选 verdict（机械 belt 拦下时无 LLM verdict）。
 */
export const researchSuspensionSchema = z.object({
  kind: z.enum(['verify_exhausted', 'research_contradiction']),
  /** 已消耗核实回合数（含触发挂起的这轮）。 */
  rounds: z.number().int().nonnegative(),
  /** verify_exhausted：未清空的缺漏清单；research_contradiction：缺省。 */
  gaps: z.array(verificationGapSchema).optional(),
  /** research_contradiction：机械证据（简报 contradiction issues / deviations；verdict 可缺——belt 拦下无 LLM verdict 时）；verify_exhausted：缺省。 */
  evidence: z
    .object({
      contradictions: z.array(researchBriefIssueSchema),
      deviations: z.array(researchBriefDeviationSchema),
      verdict: verificationVerdictSchema.optional(),
    })
    .optional(),
});
export type ResearchSuspension = z.infer<typeof researchSuspensionSchema>;

// ── 热层编译报告（design §2.1）：B 段度量，纯代码产物 ──
//
// brief-compiler 产侧（chapter_brief 十段）+ settings_context 侧（复用 estimatePinnedTokens）各自
// 产 segment 报告；总额判定与降级动作统一落装配点（D3 汇总点——brief-compiler 节点，链内两编译点
// 汇合处）——两编译点不各自判总额（防各判各的漏加）。报告经 `compile_report` 伴生 artifact 携带
// （Step 7 定案，见文件头 compileReport 段）+ summarize 透出。阈值语义：TH_* = 机械异常量级（bug 保险丝），
// 正常写作永不触发（无质量性硬 cap，用户两次拍板）。

/** 编译段 token 估算项（name = 段名，如任务卡各段 / 设定前缀各段）。 */
export const compileReportSegmentSchema = z.object({
  name: z.string().min(1),
  token_estimate: z.number().int().min(0),
});
export type CompileReportSegment = z.infer<typeof compileReportSegmentSchema>;

/** 降级记录：哪个段被降级 + 采取了什么动作（L1 缩档 / L2 移出改可查指针）。 */
export const compileReportDegradedSchema = z.object({
  segment: z.string().min(1),
  action: z.string().min(1),
});
export type CompileReportDegraded = z.infer<typeof compileReportDegradedSchema>;

export const compileReportSchema = z.object({
  /** 各编译段估算明细（≥1——报告存在即有段；空报告无意义）。 */
  segments: z.array(compileReportSegmentSchema).min(1),
  /** 总 token 估算（装配点汇总两编译点后的总额判定输入）。 */
  total: z.number().int().min(0),
  /**
   * 降级动作记录。二态（mirror gap_whitelist 论证）：缺失 = 未降级（默认，L0 正常）；
   * ≥1 = 有降级动作；空 [] 第三态无意义 → .min(1) 拒收。
   */
  degraded: z.array(compileReportDegradedSchema).min(1).optional(),
  /** 降级后仍超载（L3 复杂场景——标记进编译报告 + leader 注入段，建议拆章，人裁不静默）。 */
  overloaded: z.boolean(),
});
export type CompileReport = z.infer<typeof compileReportSchema>;
