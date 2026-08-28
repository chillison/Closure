import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  EVAL_DEFAULT_K,
  evalSetFromCases,
  scoreEvalCases,
  type EntryHit,
  type EvalCase,
  type EvalCaseScore,
} from '@orison/shared-contracts';
import { searchClosure, type RetrievalDeps } from './closureRetrieval';
import { getLogger } from '../logger';

// ── Story 8.3 S8（G 块）：fiction eval runner（design §6b，KB README §5.4/§10 必做项 1）──
//
// 压测（S6）证检索管线的延迟/召回**结构**；本 runner 证**质量**：扫 per-project `evals/*.yaml`
// （作者口吻查询 + 期望命中，schema/打分见 shared-contracts retrieval-eval.ts）→ 逐 case 跑真实
// searchClosure → scoreEvalCases 打 recall@k / MRR → 结构化报告 + console 摘要。
//
// 边界（prd Requirement 10）：本站交付框架 + 合成 smoke，**不产真实结论**——eval 集内容归作者/
// dogfood 填（哪些查询、什么算命中是语义判断，ADR-3 归人；框架 = 纯代码）。**不建 IPC/UI**
// （dogfood defer 同族）——函数级出口即调用面（测试 + 未来一行 IPC 接入）。
//
// DI seam 透传（mirror searchClosure.RetrievalDeps）：测试注入 stub → 零网络 smoke；生产 omit
// deps → 真实 embed/rerank 云端端点（dogfood 用，检索管线本体零改动——本模块只消费）。

/** 评估集目录名（per-project `evals/`，随稿自然进 iso-git 版本管理——mirror settings/ 先例）。 */
export const EVAL_DIR_NAME = 'evals';

/**
 * 解析一个评估集 yaml 文本：js-yaml load + shared `evalSetFromCases`（per-element 容错单源——
 * 坏条目 console.warn + skipped 计数，不丢全集）。
 *
 * 整文件级坏（yaml 语法错）→ null，caller 连文件路径一起 warn + 计入 skippedFiles。BOM 容忍
 * （Windows 编辑器常带 U+FEFF，mirror settingMd 读取惯例）。
 */
export function evalSetFromYaml(text: string): { cases: EvalCase[]; skipped: number } | null {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return evalSetFromCases(yaml.load(stripped));
  } catch {
    return null;
  }
}

/**
 * 递归枚举 `<projectDir>/evals/` 下的 `*.yaml` / `*.yml`（深度优先 + 全路径排序，确定性）。
 * 目录缺失/不可读 → []（never throw——「未建评估集」是 graceful 分支不是错误，mirror
 * listSettingMdFiles）。子目录递归：评估集可按主题分档（evals/plot/*.yaml），与 settings/ 家族
 * 行为一致，免得分档文件被静默忽略。
 */
export function listEvalFiles(projectDir: string): string[] {
  return listYamlFilesIn(path.join(projectDir, EVAL_DIR_NAME)).sort();
}

function listYamlFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), dir },
      'retrieval eval: cannot read evals directory - skipping',
    );
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      // stat 失败（断链/竞态）——跳过该条目。
      continue;
    }
    if (isDir) out.push(...listYamlFilesIn(full));
    else if (isFile && /\.ya?ml$/i.test(entry)) out.push(full);
  }
  return out;
}

/** 检索命中轻量摘要（per-case 诊断用——「为什么没找到」看最近几条返回的是什么）。 */
export interface EvalHitDigest {
  entryId: string;
  name: string;
  entryType: string;
  sourceKind: string;
  chapterId?: string;
  score: number;
}

/** 单 case 报告明细（EvalCaseScore + 查询回显 + top 命中摘要）。 */
export interface RetrievalEvalCaseDetail extends EvalCaseScore {
  query: string;
  note?: string;
  /** 前几条返回的轻量摘要（条数 = topHitsShown，缺省 3；miss 时看这个找原因）。 */
  topHits: EvalHitDigest[];
}

/** 一次评估运行的结构化结果（caller 渲染用；console 摘要由 runner 自己打）。 */
export interface RetrievalEvalRunDetails {
  k: number;
  /** 实际供出 case 的 yaml 文件（相对 projectDir 路径，排序确定性）。 */
  files: string[];
  caseCount: number;
  /** 解析时跳过的坏条目数（含跨文件重复 id；作者修 yaml 的反馈面）。 */
  skippedCases: number;
  /** 整文件级失败数（yaml 语法坏 / 不可读）。 */
  skippedFiles: number;
  recallAtK: number;
  mrr: number;
  /** 与评估集 cases 同序。 */
  perCase: RetrievalEvalCaseDetail[];
}

/**
 * 评估报告：跑过（run 明细）或「未建评估集」（目录缺失 / 解析后零有效 case——graceful 非错误，
 * 明确告知怎么建）。runner 全程 best-effort（单文件坏不阻整跑），无 error 态。
 */
export type RetrievalEvalReport =
  | { ok: true; ran: true; run: RetrievalEvalRunDetails }
  | {
      ok: true;
      ran: false;
      reason: 'no-eval-set';
      filesFound: number;
      skippedCases: number;
      skippedFiles: number;
    };

function digest(hit: EntryHit): EvalHitDigest {
  return {
    entryId: hit.entryId,
    name: hit.name,
    entryType: hit.entryType,
    sourceKind: hit.sourceKind,
    ...(hit.chapterId !== undefined ? { chapterId: hit.chapterId } : {}),
    score: hit.score,
  };
}

/**
 * 跑一次检索评估：扫 `evals/*.yaml` → 逐 case `searchClosure`（DI seam 透传，串行——API 并发
 * 纪律）→ `scoreEvalCases` → 报告（结构化返回 + console 摘要/per-case 详情行）。
 *
 * 怎么建评估集（作者面）：在项目里建 `evals/retrieval.yaml`，写法照抄 shared-contracts
 * `retrieval-eval.ts` 注释里的完整示例（cases: [{ id, query, expected, note }]）。评估集随稿
 * 进 iso-git 版本管理；dogfood 期间从实际使用沉淀新 case 即持续扩充。
 *
 * @param projectId registry 5 位 projectId（searchClosure 检索域）。
 * @param projectDir 项目目录（`evals/` 在其下）。
 * @param opts k（每 case 取前 k 条计分，缺省 5）/ topHitsShown（per-case 报告截取条数，缺省 3）。
 * @param deps searchClosure 的 DI seam：注入 stub embed/rerank → 零网络（测试）；omit → 真实
 *   云端端点（dogfood）。检索管线本体零改动。
 */
export async function runRetrievalEval(
  projectId: string,
  projectDir: string,
  opts: { k?: number; topHitsShown?: number } = {},
  deps?: RetrievalDeps,
): Promise<RetrievalEvalReport> {
  const k = opts.k ?? EVAL_DEFAULT_K;
  const topHitsShown = opts.topHitsShown ?? 3;

  // 1. 扫文件 + 容错解析（坏条目/坏文件计数反馈作者；跨文件重复 id 去重保后进先不覆盖）。
  const files = listEvalFiles(projectDir);
  const cases: EvalCase[] = [];
  const usedFiles: string[] = [];
  const seenIds = new Set<string>();
  let skippedCases = 0;
  let skippedFiles = 0;
  for (const filePath of files) {
    let text: string | null = null;
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), filePath },
        'retrieval eval: cannot read eval file - skipping file',
      );
    }
    const parsed = text === null ? null : evalSetFromYaml(text);
    if (parsed === null) {
      skippedFiles += 1;
      getLogger().warn(
        { filePath },
        'retrieval eval: eval file is not valid yaml - skipping file',
      );
      continue;
    }
    skippedCases += parsed.skipped;
    // 文件入列条件 = 它供出了 ≥1 个实际参评的 case（全被去重跳过的文件不计——files 语义是
    // 「本次评估的 case 来源」，非「扫到过的文件」）。
    let suppliedAny = false;
    for (const evalCase of parsed.cases) {
      if (seenIds.has(evalCase.id)) {
        skippedCases += 1;
        getLogger().warn(
          { caseId: evalCase.id, filePath },
          'retrieval eval: duplicate case id across files - keeping the first, skipping this one',
        );
        continue;
      }
      seenIds.add(evalCase.id);
      cases.push(evalCase);
      if (!suppliedAny) {
        suppliedAny = true;
        usedFiles.push(path.relative(projectDir, filePath));
      }
    }
  }

  // 2. 空集 graceful：未建评估集是常态（新项目），明确告知怎么建，非错误。
  if (cases.length === 0) {
    console.log(
      `[retrieval-eval] 未建评估集：${path.join(projectDir, EVAL_DIR_NAME)} 下没有可用 case` +
        `（找到 ${files.length} 个文件，坏条目 ${skippedCases}、坏文件 ${skippedFiles}）。` +
        `建一个 evals/retrieval.yaml（写法照抄 shared-contracts retrieval-eval.ts 注释里的完整示例）再跑。`,
    );
    return {
      ok: true,
      ran: false,
      reason: 'no-eval-set',
      filesFound: files.length,
      skippedCases,
      skippedFiles,
    };
  }

  // 3. 逐 case 跑真实检索（串行——API 并发纪律；DI seam 透传）+ 打分。
  const hitsByQuery = new Map<string, EntryHit[]>();
  for (const evalCase of cases) {
    hitsByQuery.set(evalCase.id, await searchClosure(projectId, evalCase.query, { k }, deps));
  }
  const summary = scoreEvalCases(cases, hitsByQuery, k);
  // scoreEvalCases 的 perCase 与 cases 同序（契约注释钉死），按下标对齐。
  const perCase: RetrievalEvalCaseDetail[] = cases.map((evalCase, i) => {
    const score = summary.perCase[i]!;
    return {
      ...score,
      query: evalCase.query,
      ...(evalCase.note !== undefined ? { note: evalCase.note } : {}),
      topHits: (hitsByQuery.get(evalCase.id) ?? []).slice(0, topHitsShown).map(digest),
    };
  });

  // 4. console 摘要 + per-case 详情（结构化返回值供 caller 渲染；这里给 dogfood 直读的行）。
  console.log(
    `[retrieval-eval] ${cases.length} cases（${usedFiles.length} 个文件，跳过坏条目 ${skippedCases}、坏文件 ${skippedFiles}）：` +
      `recall@${k}=${(summary.recallAtK * 100).toFixed(1)}%, MRR=${summary.mrr.toFixed(3)}`,
  );
  for (const detail of perCase) {
    if (detail.hit) {
      console.log(
        `[retrieval-eval]   [hit] rank ${detail.firstRank} · ${detail.caseId}「${detail.query}」` +
          (detail.spanBonus === true ? '（段级区间加分）' : ''),
      );
    } else {
      const first = detail.topHits[0];
      const nearest =
        first === undefined ? '无任何结果' : `最近一条：${first.name}（${first.entryType}）`;
      console.log(`[retrieval-eval]   [miss] ${detail.caseId}「${detail.query}」→ ${nearest}`);
    }
  }

  return {
    ok: true,
    ran: true,
    run: {
      k,
      files: usedFiles,
      caseCount: cases.length,
      skippedCases,
      skippedFiles,
      recallAtK: summary.recallAtK,
      mrr: summary.mrr,
      perCase,
    },
  };
}
