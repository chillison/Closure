import { z } from 'zod';
import type { EntryHit } from './closure-retrieval';

// ── Story 8.3 S8（G 块）：fiction eval 集——查询集 schema + 容错解析 + 打分纯函数（design §6b，
// KB README §5.4/§10 必做项 1「最大证据缺口」）──
//
// 定位（KB README 既有结论的框架落地）：公开 benchmark（CMTEB 等）是通用事实 QA，叙事散文是不同
// 分布——「别让 benchmark 替你选模型，用真实章节分块 + 作者查询建小 eval 集」。压测（S6）证延迟/
// 召回**结构**；本文件给证**质量**的框架：作者口吻的查询 + 期望命中（人工标注 / dogfood 从实际使用
// 沉淀），跑真实检索（shell 侧 retrievalEval.ts runner）后打 recall@k / MRR。**本站只交付框架 +
// 合成 smoke；eval 集内容与真实结论归作者 / dogfood 填**（无数据窗口边界维持）。
//
// 范式边界（ADR-3）：eval 集**内容**（哪些查询、什么算命中）是语义判断归作者/dogfood——纯代码只做
// schema 容忍 + 确定性打分（查询/汇编，零语义裁判）。
//
// 存放约定：per-project `evals/*.yaml`（随稿自然进 iso-git 版本管理，mirror settings/*.md 先例）。
// yaml 文本读取（js-yaml，evalSetFromYaml）住 shell 侧 runner——shared-contracts 保持 zod-only 纯
// 契约（renderer 经 barrel 拉包，不引入运行时 yaml 解析依赖，mirror model-registry「避免 renderer
// 运行时 yaml」注记）；本文件的 evalSetFromCases 是 per-element 容错**单源**，两侧共用。

/** 打分与 runner 的缺省 k（top-k 内命中算 recall；小 eval 集人工标注的量级锚点，非硬性）。 */
export const EVAL_DEFAULT_K = 5;

/**
 * 单条期望命中（any-of：一条查询可列多个可接受答案，命中任一即算找到）。
 *
 * 说人话示例：你问「临上次哭是哪一章」，答案可以是第 12 章的某段正文（给 `chapterId`），也可以
 * 是那张人物卡（给 `entryId`）——两个都列上，检索找到其中之一就算命中。
 *
 * - `entryId`：期望命中的条目 id（closure_entry 的 entry_id：卡 id / `${projectId}:${settingId}`
 *   设定散文 / `${projectId}:${episodeId}#summary` 章摘要行 / `${projectId}:${chapterId}#c<n>`
 *   正文段）。**条目级锚**——精确到行。
 * - `chapterId`：期望命中该章正文（**章级锚**——该章任一 chunk 命中即算；适合「答案在这一章但
 *   不知道具体哪段」的标注，比 entryId 宽）。
 * - `charSpan`：可选的章内字符区间 `[起, 止)`（半开，UTF-16 code unit，与章文件字符串索引一致）。
 *   给了且与命中 chunk 的区间有交集 → 该 case 记 `spanBonus`（段级精确的**加分项**，不作命中门槛
 *   ——段边界随分块参数变，门槛级依赖会让标注过早腐烂）。
 *
 * 至少给 entryId 或 chapterId 之一（charSpan 是加分项，不能单独作锚）。
 */
export const evalExpectedSchema = z
  .object({
    // trim：作者手写 yaml 的首尾空格静默归一（mirror settingMd normalizeFrontmatter 惯例），
    // 归一后 min(1) 连带挡住纯空白 id。
    entryId: z.string().trim().min(1).optional(),
    chapterId: z.string().trim().min(1).optional(),
    charSpan: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .refine(([start, end]) => start < end, { message: 'charSpan 须 [起, 止) 且 起 < 止' })
      .optional(),
  })
  .refine((o) => o.entryId !== undefined || o.chapterId !== undefined, {
    message: 'expected 至少给 entryId 或 chapterId 之一（charSpan 是加分项，不能单独作锚）',
  });

export type EvalExpected = z.infer<typeof evalExpectedSchema>;

/**
 * 单条评估 case：一条「作者口吻」的查询 + 期望命中。
 *
 * 怎么写——完整可照抄示例（存 `<project>/evals/retrieval.yaml`）：
 *
 * ```yaml
 * cases:
 *   - id: lin-cry-chapter            # 唯一 id（同一次评估内不得重复）
 *     query: 临上次哭是哪一章         # 你自己会怎么问就怎么写（作者口吻，非关键词堆砌）
 *     expected:                      # 期望命中（至少一条；命中任一即算找到）
 *       - chapterId: ch_012          # 章级锚：第 12 章任一正文段命中即算
 *         charSpan: [1200, 1680]     # 可选加分项：章内字符区间（半开），段级精确时记 spanBonus
 *       - entryId: 00042:ep-012#summary  # 也可接受该章摘要行（条目级锚，answer-in-summary 查询）
 *     note: 第12章雨夜对峙——按剧情查正文的代表查询
 * ```
 *
 * - `query`：作者口吻查询（例：「某人物上次哭」「之前哪里写过当铺」）——eval 要测的就是这类
 *   「按意思找」的真实用法，不是关键词精确匹配（那是 FTS 的下限）。
 * - `expected`：人工标注或 dogfood 沉淀的期望命中（any-of）。
 * - `note`：给作者自己看的备注（这条查询代表什么场景；不进打分）。
 */
export const evalCaseSchema = z.object({
  id: z.string().trim().min(1),
  query: z.string().trim().min(1),
  expected: z.array(evalExpectedSchema).min(1),
  note: z.string().optional(),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

/** 评估集严格 schema（程序化构造/校验用；yaml 落盘侧走 evalSetFromCases 容错路径，非本 schema）。 */
export const evalSetSchema = z.object({ cases: z.array(evalCaseSchema) });

export type EvalSet = z.infer<typeof evalSetSchema>;

/**
 * 容错解析已 load 的评估集对象（per-element safeParse **单源**，yaml/直构两侧共用）。
 *
 * 容错语义（mirror foreshadow-migration E5 / story_decisions CR-4.1-07 惯例）：单个坏条目（缺
 * id/query、expected 空、期望既无 entryId 又无 chapterId 等）console.warn + 跳过，**不丢全集**——
 * 评估集是作者手写 yaml，一条手滑不该让整个评估跑不起来。返回 `skipped` 供报告反馈作者修档。
 * 坏的是集合结构（raw 非对象 / cases 非数组）→ warn + 空集（caller 按「未建评估集」graceful 处理）。
 */
export function evalSetFromCases(raw: unknown): { cases: EvalCase[]; skipped: number } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    // B6（CR 2026-08-20）：补 warn 对齐 JSDoc「warn + 空集」契约——根非对象（yaml 顶层是字符串/
    // 数组/空）此前静默空集，作者写错档零反馈。
    console.warn('[retrieval-eval] 评估集根不是对象（期望形如 { cases: [...] }），按空集处理');
    return { cases: [], skipped: 0 };
  }
  const rawCases = (raw as { cases?: unknown }).cases;
  if (!Array.isArray(rawCases)) {
    console.warn('[retrieval-eval] 评估集缺 cases 数组（期望形如 { cases: [...] }）');
    return { cases: [], skipped: 0 };
  }
  const cases: EvalCase[] = [];
  let skipped = 0;
  for (const element of rawCases) {
    const parsed = evalCaseSchema.safeParse(element);
    if (parsed.success) {
      cases.push(parsed.data);
    } else {
      skipped += 1;
      console.warn(
        `[retrieval-eval] 跳过坏评估条目（${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
          .join('；')}）：${JSON.stringify(element)}`,
      );
    }
  }
  return { cases, skipped };
}

/** 单 case 打分结果（二态纪律：miss 时 firstRank/matchedExpected 键不出现）。 */
export interface EvalCaseScore {
  caseId: string;
  /** top-k 内命中任一期望 → true。 */
  hit: boolean;
  /** 首个命中排名（1-based；miss 时缺省）。 */
  firstRank?: number;
  /** 首个命中所匹配的那条期望（多期望时 = 实际兑现的那条，作者核对用）。 */
  matchedExpected?: EvalExpected;
  /** 加分项：首个命中与期望 charSpan 有区间交集（双方都带区间时才计算，否则缺省）。 */
  spanBonus?: boolean;
}

/** 打分汇总（recall@k / MRR + per-case 明细）。 */
export interface EvalScoreSummary {
  /** recall@k：top-k 内找到期望命中的查询比例（0-1；零 case → 0）。 */
  recallAtK: number;
  /** MRR：每 case 首个命中排名倒数的平均（miss 贡献 0；零 case → 0）。 */
  mrr: number;
  /** 与入参 cases 同序（runner 按下标对齐依赖此约定）。 */
  perCase: EvalCaseScore[];
}

/**
 * 打分（纯函数，零 IO 零依赖）。
 *
 * 指标的白话定义：
 * - **recall@k（召回率）**：有多少比例的查询在前 k 条结果里**找到**了期望命中（4 条查询找到 3 条
 *   = 0.75）。找得到是底线。
 * - **MRR（平均倒数排名）**：期望答案排得越靠前分越高——第 1 名 1 分、第 2 名 0.5、第 3 名
 *   0.33……没找到 0 分，全部查询取平均。排得前 = 作者翻得少 = 上下文预算省。
 *
 * 命中判定：检索结果的 `entryId` 与期望的 entryId 相同，**或**（仅章源命中携带的）`chapterId` 与
 * 期望的 chapterId 相同——卡/设定/摘要行无章锚，天然只走 entryId 判定。charSpan 只产生 `spanBonus`
 * 加分记录（区间交集非空），不影响 hit / recall / MRR。
 *
 * @param cases 评估集（case id 须唯一——hitsByQuery 按 id 取结果；去重归 runner）。
 * @param hitsByQuery 按 case id 索引的检索结果（searchClosure 输出；缺项按零结果 = miss 处理）。
 * @param k 只看每 case 前 k 条（缺省 5；非正值按 1 兜底——防御手滑参数，不让打分静默全 miss）。
 */
export function scoreEvalCases(
  cases: readonly EvalCase[],
  hitsByQuery: ReadonlyMap<string, readonly EntryHit[]>,
  k: number = EVAL_DEFAULT_K,
): EvalScoreSummary {
  const effectiveK = Math.max(1, k);
  const perCase: EvalCaseScore[] = [];
  let hitCount = 0;
  let reciprocalSum = 0;

  for (const evalCase of cases) {
    const ranked = (hitsByQuery.get(evalCase.id) ?? []).slice(0, effectiveK);
    let firstRank: number | undefined;
    let matchedExpected: EvalExpected | undefined;
    let spanBonus: boolean | undefined;
    for (let i = 0; i < ranked.length; i++) {
      const hit = ranked[i]!;
      const expected = evalCase.expected.find((e) => hitMatchesExpected(hit, e));
      if (expected !== undefined) {
        firstRank = i + 1;
        matchedExpected = expected;
        spanBonus = spanBonusOf(hit, expected);
        break;
      }
    }
    if (firstRank !== undefined && matchedExpected !== undefined) {
      hitCount += 1;
      reciprocalSum += 1 / firstRank;
      perCase.push(
        spanBonus !== undefined
          ? { caseId: evalCase.id, hit: true, firstRank, matchedExpected, spanBonus }
          : { caseId: evalCase.id, hit: true, firstRank, matchedExpected },
      );
    } else {
      perCase.push({ caseId: evalCase.id, hit: false });
    }
  }

  const n = cases.length;
  return {
    recallAtK: n === 0 ? 0 : hitCount / n,
    mrr: n === 0 ? 0 : reciprocalSum / n,
    perCase,
  };
}

/** entryId 精确同或章源 chapterId 同（期望缺该维度时对应判定自动跳过）。 */
function hitMatchesExpected(hit: EntryHit, expected: EvalExpected): boolean {
  if (expected.entryId !== undefined && hit.entryId === expected.entryId) return true;
  if (expected.chapterId !== undefined && hit.chapterId === expected.chapterId) return true;
  return false;
}

/** charSpan 交集（半开区间）：期望带 charSpan 且命中是章源（有区间）才可算，否则 undefined。 */
function spanBonusOf(hit: EntryHit, expected: EvalExpected): boolean | undefined {
  if (expected.charSpan === undefined) return undefined;
  if (hit.charStart === undefined || hit.charEnd === undefined) return undefined;
  const [start, end] = expected.charSpan;
  return hit.charStart < end && start < hit.charEnd;
}
