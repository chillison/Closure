import {
  batchRunStateSchema,
  type BatchRunState,
  type ParticipationGear,
} from '@orison/shared-contracts';
import type { AgentMessage } from '../../shared/store/agentSlice';
import { toolSummary } from './toolMeta';

/**
 * Story 3.5 Step 8: mechanical derivation of batch UI data from tool-result
 * metadata (start_batch / batch_status / end_batch).
 *
 * 🔑 范式红线（design §7）：本文件只做**机械派生**——进度计数 / 场 id 投影 /
 * 工具行提取（mirror toolSummary）。判轻重 / 摘要语义 / 走向单文本永远不在这层
 * 产生（UI 零 LLM 语义判断）。无结构化 metadata 时降级（消息计数 / 无行），
 * 不编造。
 *
 * `toolResults[].metadata` 是 unknown seam（state-management spec：形态守卫），
 * 经 batchRunStateSchema.safeParse 校验——坏 metadata 丢弃该条，不崩渲染。
 */

const BATCH_META_TYPES = ['batch_started', 'batch_status', 'batch_ended'] as const;
export type BatchMetaKind = (typeof BATCH_META_TYPES)[number];

export type ParsedBatchMeta = { kind: BatchMetaKind; batch: BatchRunState };

/** Parse one batch tool-result metadata entry; null when malformed/absent. */
export function parseBatchToolMetadata(metadata: unknown): ParsedBatchMeta | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const type = (metadata as { type?: unknown }).type;
  if (typeof type !== 'string' || !(BATCH_META_TYPES as readonly string[]).includes(type)) return null;
  const parsed = batchRunStateSchema.safeParse((metadata as { batch?: unknown }).batch);
  if (!parsed.success) return null;
  return { kind: type as BatchMetaKind, batch: parsed.data };
}

/**
 * Most recent batch tool-result metadata in document order (later results
 * carry fresher progress — batch_status reconciles doneSceneIds, batch_ended
 * carries the terminal status). Scans the given messages; callers pass either
 * a batch group's slice or the whole stream.
 */
export function latestBatchMeta(messages: AgentMessage[]): ParsedBatchMeta | null {
  let found: ParsedBatchMeta | null = null;
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const result of m.toolResults ?? []) {
      const parsed = parseBatchToolMetadata(result.metadata);
      if (parsed) found = parsed;
    }
  }
  return found;
}

/**
 * Active batch for the AgentPanel banner: the latest batch metadata is
 * non-terminal (running / paused). Terminal (done / aborted) or absent → null
 * (banner hidden).
 */
export function findActiveBatch(messages: AgentMessage[]): ParsedBatchMeta | null {
  const meta = latestBatchMeta(messages);
  if (!meta) return null;
  return meta.batch.status === 'running' || meta.batch.status === 'paused' ? meta : null;
}

/** Progress row projection (mechanical counts + next scene id). */
export type BatchProgress = {
  done: number;
  total: number;
  /** First not-yet-done scene in topo order (the scene the leader is on). */
  currentSceneId?: string;
  /** Gear snapshot recorded at batch start (batch.gear, not live session gear). */
  gear: ParticipationGear;
};

export function batchProgressFrom(meta: ParsedBatchMeta): BatchProgress {
  const { batch } = meta;
  const done = batch.doneSceneIds.length;
  const total = batch.orderedSceneIds.length;
  // First not-done in topo order（mirror workflow.ts 协议段的 find 语义）——doneSceneIds
  // 不保证是 orderedSceneIds 的前缀（leader 可跳场/乱章落盘），按 done 长度取下标会在
  // 非前缀时指错当前场。
  const doneSet = new Set(batch.doneSceneIds);
  const next = batch.orderedSceneIds.find((id) => !doneSet.has(id));
  return { done, total, gear: batch.gear, ...(next !== undefined ? { currentSceneId: next } : {}) };
}

/** One-line row for `<BatchReportCard>` (L1): tool label source + mechanical summary. */
export type BatchToolRow = {
  key: string;
  toolId: string;
  summary?: string;
  output?: string;
  isError: boolean;
};

// CR-019：isError 判定加中文文案（write_chapter 等中文错误/失败/警告文案漏标红）。
// 既有英文 `^\s*error/i` 前缀；新增 includes「错误」「失败」「Error:」（大小写不敏感）。
// mirror AgentMessages.renderError 既有 i18n 解析思路（renderError 是 i18n key 解析非错误判定，不复用函数但同源「中英双覆盖」思路）。
const ERROR_SNIPPETS = ['错误', '失败'];
function isErrorOutput(output: string | undefined): boolean {
  if (typeof output !== 'string') return false;
  if (/^\s*error/i.test(output)) return true;
  if (ERROR_SNIPPETS.some((s) => output.includes(s))) return true;
  if (/error\s*[:：]/i.test(output)) return true;
  return false;
}

/**
 * Collect the batch's tool messages into report rows (L1). Pure mechanical:
 * tool id + toolSummary projection + raw output reference. No chapter-title
 * invention — when metadata carries a chapterId/fileName, toolSummary surfaces
 * it; otherwise the row degrades to the tool label alone.
 */
export function collectBatchToolRows(messages: AgentMessage[], batchId: string): BatchToolRow[] {
  const rows: BatchToolRow[] = [];
  for (const m of messages) {
    if (m.role !== 'tool' || m.batchId !== batchId) continue;
    (m.toolResults ?? []).forEach((result, i) => {
      const output = typeof result.output === 'string' ? result.output : undefined;
      rows.push({
        key: `${m.id}:${i}`,
        toolId: result.toolName ?? result.toolId ?? '',
        summary: toolSummary(result),
        output,
        isError: isErrorOutput(output),
      });
    });
  }
  return rows;
}

/**
 * Code-point-safe truncation (agent-panel.md Convention: 中文文本处理用码点
 * 迭代 `[...str]`，非码元索引——代理对 / CJK 扩展区不可拆半)。
 */
export function truncateByCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}
