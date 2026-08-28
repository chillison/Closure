import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { getLintEngine, type LintEngine } from './lintEngine';
import { logger } from '../logger';

// ── C1.2 R6（design §3.3）：post-settle 终稿 lint 账（纯代码记账，ADR-3）──
//
// write_chapter post-settle 钩子族的 lint 账写手（mirror arc-audit post-settle「章结算后机械收尾」
// 家族 + batch-state 磁盘持久先例）：单章重扫终稿 → 落 `{projectPath}/.orison/lint/<chapterId>.json`
// （章级终稿态账，**last-write-wins 覆写幂等**——redo/重写章后重扫刷新，C1.3 诊断报告消费接口）。
//
// 与链段 lint_report（review=agent 桶 L2 软信号，design §3.1-3.2）职能不同：终稿账 = **全量桶**
// （scanText 不过滤，issue 自带 review 字段，消费侧按受众自行投影）持久层。不经链段 artifact
// ——post-settle 独立重扫，避免 redo 中间轮的 lint_report 污染终稿账。
//
// fs seam：agent 工具层 per-project `.orison/` 直写先例 = batch-state.ts（existsSync + mkdirSync
// recursive + shared-contracts atomicWriteFileSync，原子写防半文件）；不碰 project.yaml（受管配置，
// data-flow spec ④）。
//
// graceful：引擎缺位（getLintEngine null——rulesets 装载失败）/ chapterId 或 text 缺位（无结算
// 载荷）/ 写盘异常 → warn + return false（**skip 不破**——lint 账是 DERIVED 派生缓存，缺账可
// full-scan 重建，章结算主流程不受影响）。
//
// expected_downstream_consumers：
// - C1.3 诊断报告：读章级账文件聚合（lintFullReport 聚合形态 mirror lintEngine.aggregateFullReport）。
// - Step 7 shell lintIpc：full-report 聚合与本章账共用 lintChapterLedgerPath 单源路径。

/**
 * 章级账文件路径（单源——post-settle 写手与 C1.3/IPC 读侧共用，防路径漂移）。
 *
 * chapterId 消毒（CR-019 单射性）：chapterId 来自 project.yaml 用户数据，须防
 * ① 逃出 lint 目录（路径分隔符）；② **不同 chapterId 消毒后撞车**（旧实现 `a/b` 与 `a:b`
 * 都 → `a_b`，两章账互相覆盖）；③ Windows 保留设备名（CON/NUL/COM1-9/LPT1-9/AUX/PRN，
 * 大小写不敏感——`CON.json` 在 Win32 仍是设备名不可作文件）。
 *
 * 方案 = percent-encode 全部文件名非法字符（含 `%` 自身——否则字面 `a%2Fb` 会与 `a/b` 的
 * 编码产物撞车）+ 保留名 `%` 前缀守卫（`%` 在正常编码输出中恒被编码为 `%25` 永不裸露 →
 * 前缀不引入新碰撞）。合法字符（含中文/空格/`.`）原样保留——常规 chapterId 文件名可读。
 * 消毒仅影响文件名不影响语义（同 chapterId 稳定同文件名，幂等不破）。
 */
/** Windows 文件名非法字符 + `%` + 控制字符（encode 集合；`%` 入集保单射）。 */
const LEDGER_ILLEGAL_CHARS = /[%\/:*?"<>|\u0000-\u001f]/gu;
/** Windows 保留设备名（大小写不敏感；带扩展名的 `CON.x.json` 同样保留，按首个 `.` 前基名判）。 */
const WINDOWS_RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeChapterIdForLedger(chapterId: string): string {
  const encoded = chapterId.replace(LEDGER_ILLEGAL_CHARS, (ch) =>
    // encodeURIComponent 不编码 `*`（RFC 3986 unreserved mark）——但 `*` 在 Win32 文件名
    // 非法，原样透传会让含 `*` 的 chapterId 产出永远写不成的文件名（EINVAL → skip）。
    // 显式映射 %2A 补上这一枚，保「编码产物恒为合法文件名」的集合语义。
    ch === '*' ? '%2A' : encodeURIComponent(ch),
  );
  const base = encoded.split('.')[0]!;
  return WINDOWS_RESERVED_BASE.test(base) ? `%${encoded}` : encoded;
}

export function lintChapterLedgerPath(projectPath: string, chapterId: string): string {
  const safeId = sanitizeChapterIdForLedger(chapterId);
  return path.join(projectPath, '.orison', 'lint', `${safeId}.json`);
}

/**
 * 单章重扫终稿并落 lint 账（last-write-wins 幂等）。
 *
 * @returns true = 已落盘；false = skip（载荷缺位/引擎缺位/写盘异常——均 warn 不抛，章结算不破）。
 */
export async function writeLintChapterLedger(args: {
  projectPath: string;
  /** 结算章 id（summary.chapter_accept?.chapterId ?? params.chapterId）；缺 → skip（无落账锚）。 */
  chapterId: string | undefined;
  /** 终稿正文（summary.draftText——CR-15a deliverable，链段终态正文）；缺/空 → skip。 */
  text: string | undefined;
  /** 引擎装载器（测试注入 null/坏引擎验降级）；缺省 getLintEngine（进程级单例）。 */
  getEngine?: () => Promise<LintEngine | null>;
}): Promise<boolean> {
  const { projectPath, chapterId, text } = args;
  if (!chapterId || !chapterId.trim()) {
    logger.info({ projectPath }, 'lintLedger: chapterId missing → skip (no settle anchor)');
    return false;
  }
  if (!text || text.length === 0) {
    logger.info({ projectPath, chapterId }, 'lintLedger: draftText missing → skip (no final prose)');
    return false;
  }

  const filePath = lintChapterLedgerPath(projectPath, chapterId);
  try {
    const engine = await (args.getEngine ?? getLintEngine)();
    if (!engine) {
      logger.warn(
        { projectPath, chapterId },
        'lintLedger: lint engine unavailable (rulesets load failed?) → skip (C1.3 可 full-scan 重建)',
      );
      return false;
    }
    // 全量桶（review=all 语义：issue 自带 review 字段；链段 L2 agent 桶投影归消费侧）。
    const report = engine.scanText(text, { chapterId });
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    logger.info(
      { projectPath, chapterId, total: report.summary.total, high: report.summary.high },
      'lintLedger: chapter lint account written (last-write-wins)',
    );
    return true;
  } catch (err) {
    logger.warn(
      {
        projectPath,
        chapterId,
        filePath,
        err: err instanceof Error ? err.message : String(err),
      },
      'lintLedger: write failed → skip (derived cache, chapter settle unaffected)',
    );
    return false;
  }
}
