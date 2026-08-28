import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import {
  batchRunStateSchema,
  type BatchKind,
  type BatchRunState,
} from '@orison/shared-contracts';
import { logger } from '../logger';
import { sessionExistsOnDisk } from '../agent/session';

// ── Story 3.5（design §6 / §5.1）：批量状态磁盘持久 + 消息盖章 registry（纯代码，ADR-3）──
//
// `{projectPath}/.orison/batches.json` —— 单文件 JSON 数组（活跃 + 近期，cap 10 LRU 清）。
// 读写经 shared-contracts fs/atomicWrite（既有）；BOM-strip / malformed → graceful null + warn
// （mirror workflow.ts loadStructureIssuesForLeader 防御）。**per-element safeParse filter**（坏条目
// 单独丢不全丢——mirror revision-guard filterValidFindings / CR-4.1-07 哲学）。
//
// 🔑 进度真相源 = project state（已落盘章节）+ doneSceneIds 交叉校验；batches.json 是导航态非真相源
// （崩了可经 batch_status 对账重导）。
//
// 范式判据（ADR-3）：状态读写 / LRU / 盖章 = 纯代码记账；「批量怎么跑 / 问什么」归 leader LLM（prompt 协议段）。

const BOM_CHAR_CODE = 0xfeff;

/** 单文件最多保留的批量记录数（活跃 + 近期；LRU 清最旧，design §6 cap 10）。 */
export const BATCH_RECORD_CAP = 10;

function batchesFilePath(projectPath: string): string {
  return path.join(projectPath, '.orison', 'batches.json');
}

/**
 * 读批量记录数组（per-element safeParse：坏条目 drop + warn，好条目保留——单条畸形不丢整个文件）。
 *
 * graceful 三态（CR-008 区分）：
 * - 文件不存在 → []（合法「从未跑过批量」，可合法重建/rebuild）；
 * - 损坏（非 JSON / 非数组 / 对象非条目）→ null（caller 据此降级，不崩——删文件即清态，设计 §10 回滚）；
 * - **读错（EBUSY/EPERM 等 IO err）→ null（与损坏同态）**，但本函数返 null 无法区分前两者，
 *   故由 caller 单独判别：`upsertBatchRun`/`saveBatchRuns` 是**工具层**，不应在**读错**时静默用 `?? []`
 *   重建——那会把瞬时 IO 受阻（文件被另进程占 / 短暂权限问题，稍后可读）误判为「无文件」→ 全部记录
 *   无声丢失。**正确处理**在工具层（caller）—— 见 batch-tools start_batch：检测到 `loadBatchRuns===null`
 *   时按「不可写」返回，**拒绝创建新批量**，而非争「读错」与「损坏」之外热覆写文件。
 *
 * 故此处仍返 null（两种失败形态同归 null——区分由工具层在尝试**写**时据 loadResult 返值判定）；
 * 新增的是调用约定的说明：本函数对「不可读」返 null 而非抛错（`工具层 graceful` 降错误时覆盖），且当
 * 读错时返回 null 但文件被保留。
 *
 * 设计根：`loadBatchRuns` 检测「无文件」「损坏」与「不可读」均返不同但同态值，caller 决定是否重建/重试。
 */
export function loadBatchRuns(projectPath: string): BatchRunState[] | null {
  const filePath = batchesFilePath(projectPath);
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    // CR-008：IO 错（EBUSY/EPERM 等瞬时不可读）→ null（caller 工具层拒绝写以防重建丢全部记录）+ warn。
    // **之前实现**返 null，但工具层 `upsertBatchRun`/`saveBatchRuns` 用 `?? []` 静默重建——正是此 bug。
    // 修法把「重建」决策权从纯函数下沉到工具层（batch-tools start_batch 守卫），避免纯函数层无差别「丢弃」。
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), projectPath },
      'batch-state: batches.json unreadable (transient IO error or missing read perms) → null; caller should refuse overwrite',
    );
    return null;
  }
  const bomStripped = raw.charCodeAt(0) === BOM_CHAR_CODE ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bomStripped);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), projectPath },
      'batch-state: batches.json malformed JSON → null + warn (delete file to reset)',
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    logger.warn({ projectPath }, 'batch-state: batches.json not an array → null (delete file to reset)');
    return null;
  }
  // per-element filter（drop bad keep good）。CR-008：per-element parse **在「文件可读但内容畸形」**
  // 的合法重建语境下执行——此处重建是合理的（坏条目单独丢不全丢）。区别于「读错」瞬态。
  const runs: BatchRunState[] = [];
  let dropped = 0;
  for (const entry of parsed) {
    const result = batchRunStateSchema.safeParse(entry);
    if (result.success) {
      runs.push(result.data);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    logger.warn(
      { projectPath, dropped, total: parsed.length },
      'batch-state: dropped malformed batch records (per-element parse)',
    );
  }
  return runs;
}

/**
 * 写批量记录数组（atomicWrite + cap 10 LRU：按 createdAt 降序保最新 BATCH_RECORD_CAP 条）。
 * mkdir .orison（项目可能尚未有该目录——批量先于 session 持久化创建目录的防御）。
 */
export function saveBatchRuns(projectPath: string, runs: BatchRunState[]): void {
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, BATCH_RECORD_CAP);
  const dir = path.join(projectPath, '.orison');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(batchesFilePath(projectPath), JSON.stringify(sorted, null, 2), 'utf-8');
}

/** upsert 单条批量记录（按 batchId 替换或追加）+ LRU cap 落盘。
 * CR-008：**load 失败（null = IO 错 / 损坏文件）不得静默重建 `?? []`**——瞬态不可读（EBUSY/EPERM）
 * 时 `?? []` 会覆盖全部记录。改为拒绝写 + 抛，由工具层（start_batch 守卫）graceful 告知「稍后重试」，
 * 不破坏文件。仅当 load 返回数组（含 `[]`，合法「从未跑过批量」）才正常 upsert。 */
export function upsertBatchRun(projectPath: string, batch: BatchRunState): void {
  const existing = loadBatchRuns(projectPath);
  if (existing === null) {
    // CR-008：瞬态不可读 / 损坏文件——不静默重建（会丢失全部记录 / 覆盖坏文件的可恢复条目）。
    // 抛药让工具层（start_batch 等）捕获并告知用户；不覆盖 batches.json。
    throw new Error('batch-state: batches.json unreadable (transient IO error or corrupted) → refusing upsert to avoid data loss (delete file to reset or retry)');
  }
  const idx = existing.findIndex((r) => r.batchId === batch.batchId);
  if (idx >= 0) {
    existing[idx] = batch;
  } else {
    existing.push(batch);
  }
  saveBatchRuns(projectPath, existing);
}

/**
 * 找项目当前活跃批量（status='running' 且（sessionId 缺 或 匹配本会话）；多条 running 取最新——
 * 单活跃批量是协议约定，多 running 属数据异常，newest 胜出并 warn）。
 *
 * 注（CR-004 订正）：paused 当前无写入路径，**abort/崩溃残留为 running**——batch_status 对账读取
 * running 即承接续跑语义。paused 是未来 abort wiring 预留的中断态；当前 stamp / prompt 段 /
 * start_batch 守卫都不太可能触界，发现 paused 仍挡 start_batch（status 非终态）以防双活跃。
 */
export function findActiveBatchRun(
  projectPath: string,
  sessionId?: string,
): BatchRunState | undefined {
  const runs = loadBatchRuns(projectPath);
  if (!runs) return undefined;
  const candidates = runs.filter(
    (r) =>
      r.status === 'running' &&
      (r.sessionId === undefined ||
        sessionId === undefined ||
        r.sessionId === sessionId ||
        // CR-007：孤儿批量（属主会话内存/磁盘均不存在）对本会话可见——可对账接管续跑/收口；
        // 盖章/prompt 协议随接管会话生效（setActiveBatchStamp 以接管会话 id 记属主）。
        !sessionExistsOnDisk(projectPath, r.sessionId)),
  );
  if (candidates.length > 1) {
    logger.warn(
      { projectPath, count: candidates.length, batchIds: candidates.map((c) => c.batchId) },
      'batch-state: multiple running batches on disk (protocol expects one) → newest wins',
    );
  }
  if (candidates.length === 0) return undefined;
  return candidates.reduce((newest, r) => (r.createdAt > newest.createdAt ? r : newest));
}

// ── 消息盖章 registry（design §5.1：batchId 由运行时纯代码打，非 LLM 自觉）──
//
// in-memory Map<projectPath, stamp>。三种同步源：
// 1. syncActiveBatchStamp（每 turn 开始 buildMainRunConfig / streamMessage 入口调）：读磁盘
//    （崩溃恢复——进程重启后 map 空，磁盘 batches.json 是 durable 源）→ set / clear。
// 2. start_batch / batch_status（resume）：工具执行时直接 set（mid-turn 生效——批量在同 turn 启动，
//    后续消息立即盖章）。
// 3. end_batch：done → 切 kind='report'（同 turn 收尾全景消息盖 report）；aborted → clear。

interface ActiveBatchStamp {
  batchId: string;
  kind: BatchKind;
  /** 启动会话（缺 = 项目内任意会话盖章；对齐 findActiveBatchRun 匹配语义）。 */
  sessionId?: string;
}

const activeStamps = new Map<string, ActiveBatchStamp>();

/** 覆盖当前活跃批量 stamp（无 → clear）。返回同步后的活跃批量（供 prompt 段复用，避免双读）。 */
export function syncActiveBatchStamp(
  projectPath: string,
  sessionId?: string,
): BatchRunState | undefined {
  const active = findActiveBatchRun(projectPath, sessionId);
  if (active) {
    activeStamps.set(projectPath, { batchId: active.batchId, kind: 'progress', ...(active.sessionId ? { sessionId: active.sessionId } : {}) });
  } else {
    // CR-006：else 分支不能无脑清——他 session 的活跃批量不影响本 session 的 sync 结果（find 按 session
    // 过滤返 undefined），但删 stamp 会误清他 session 属主。故仅当本会话是 stamp 属主（或 stamp 无属主 /
    // 本会话缺）才清；他 session 属主保留（他自己的 turn 会读自己的 stamp）。
    const stamp = activeStamps.get(projectPath);
    if (
      !stamp ||
      stamp.sessionId === undefined ||
      sessionId === undefined ||
      stamp.sessionId === sessionId
    ) {
      activeStamps.delete(projectPath);
    }
  }
  return active;
}

/** start_batch / batch_status(resume) 工具 mid-turn 更新 stamp（progress 模式）。 */
export function setActiveBatchStamp(
  projectPath: string,
  batchId: string,
  sessionId?: string,
): void {
  activeStamps.set(projectPath, { batchId, kind: 'progress', ...(sessionId ? { sessionId } : {}) });
}

/** end_batch({outcome:'done'}) 后切换 stamp 到 report 模式（同 turn 收尾消息盖 report，design §5.1）。 */
export function markBatchStampReport(projectPath: string, batchId: string, sessionId?: string): void {
  activeStamps.set(projectPath, { batchId, kind: 'report', ...(sessionId ? { sessionId } : {}) });
}

/** end_batch({outcome:'aborted'}) 清 stamp。CR-006：条件清——仅当 stamp 属主无、或属主匹配本会话才清
 * （他 会话 的 turn/end_batch 不得清属主 stamp——单槽 Map<projectPath, stamp> 按 project 键控，
 * 他 session 的 end_batch(aborted) 不条件查属主会误清活跃批量 stamp）。 */
export function clearActiveBatchStamp(projectPath: string, sessionId?: string): void {
  if (sessionId !== undefined) {
    const stamp = activeStamps.get(projectPath);
    // 属主有且不匹配 → 不清（防他 session 误清属主）。
    if (stamp && stamp.sessionId !== undefined && stamp.sessionId !== sessionId) return;
  }
  activeStamps.delete(projectPath);
}

/**
 * 给消息盖 batchId（同步、内存读——每消息调用，不触盘）。
 *
 * 条件：stamp 存在 + stamp.batchId 匹配（会话级）+ role 为 assistant/tool（user 消息不盖——
 * 用户发言不属于批量产出）。直接 mutate msg（onMessage 回调收到的引用与 result 数组同源，
 * addMessage 持久化与流事件同享盖章结果）。
 */
export function stampBatchOnMessage(
  projectPath: string,
  sessionId: string,
  message: { role: string; batchId?: string; batchKind?: BatchKind },
): void {
  const stamp = activeStamps.get(projectPath);
  if (!stamp) return;
  if (stamp.sessionId !== undefined && stamp.sessionId !== sessionId) return;
  if (message.role !== 'assistant' && message.role !== 'tool') return;
  // 已盖章（理论上不会——每消息一次）不覆盖。
  if (message.batchId !== undefined) return;
  message.batchId = stamp.batchId;
  message.batchKind = stamp.kind;
}
