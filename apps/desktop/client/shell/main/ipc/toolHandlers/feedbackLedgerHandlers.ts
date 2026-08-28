/**
 * Story 7.4 cross-chapter feedback ledger tool handlers (design §2.2 / ADR-3).
 *
 * 2 handlers mirroring `worldStateHandlers.ts` for the cross-chapter feedback ledger
 * persistence layer. Each agent tool (agent/src/nodes/feedback-ledger-node.ts) crosses
 * processes via the UNIFIED `toolExecution` channel (remoteToolProxy → handleToolExecute →
 * these handlers). NO dedicated IPC channel / preload method / OrisonDesktopApi entry —
 * same unified-channel pattern as `query_world_state` / `query_story`.
 *
 * projectId is derived from projectDir via `getProject(path.resolve(projectDir))?.projectId`
 * (5-digit registry id, mirror 2.7/2.3/6.6 — NOT meta.id UUID, db-repository §2.7 namespace
 * convention). Handlers delegate to `feedbackLedgerRepository` (write: upsert; read: single
 * entry or all entries for an episode).
 *
 * Handlers NEVER throw on bad input — a malformed param / missing project / repo failure
 * degrades to a friendly message so the agent runLoop turn never sees a rejection (mirror
 * queryWorldStateHandler "never throws" contract). feedback ledger is an enhancement layer
 * (mirror 6.6 world-state enhancement philosophy): write/read failures never break the chain.
 */
import path from 'node:path';
import {
  feedbackLedgerReadRequestSchema,
  feedbackLedgerWriteRequestSchema,
} from '@orison/shared-contracts';
import { getProject } from '../../db/projectRepository';
import { readEpisodeFeedback, readFeedbackLedger, upsertFeedbackLedger } from '../../db/feedbackLedgerRepository';
import { getLogger } from '../../logger';
import type { ToolHandler } from './types';

// ── projectId 解析（mirror queryWorldStateHandler / worldStateHandlers）──
function resolveProjectId(projectDir: string): string | null {
  // local_fingerprint == path.resolve(projectDir)（ensureProject 约定，closureHandlers 注释）。
  return getProject(path.resolve(projectDir))?.projectId ?? null;
}

function notRegistered(toolId: string) {
  return {
    title: toolId,
    output: '当前项目未注册到数据库，无法访问反馈账本。',
    metadata: { ok: false, reason: 'project_not_registered' },
  };
}

function invalidParams(toolId: string, message: string) {
  getLogger().warn({ err: message }, `${toolId}: invalid params`);
  return {
    title: toolId,
    output: `参数无效: ${message}`,
    metadata: { ok: false, reason: 'invalid_params' },
  };
}

// ── handlers ──

/**
 * feedback_ledger_write：写入一条 cross-chapter feedback ledger 记录（upsert，composite PK）。
 *
 * Agent feedback-ledger-node（链尾，completeness-verify 后）读 run.artifacts 三 key（review.latest /
 * emotion_verify_result / completeness_verify_result）→ 经本 handler 写 ledger。同 episode 同 key 重跑覆盖。
 * write_chapter 下一章 chain-start 读上一章 ledger 填 feedback var（Step 2 接通）。
 */
export const feedbackLedgerWriteHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: ReturnType<typeof feedbackLedgerWriteRequestSchema.parse>;
  try {
    parsed = feedbackLedgerWriteRequestSchema.parse(params);
  } catch (err) {
    return invalidParams(
      'feedback_ledger_write',
      err instanceof Error ? err.message : String(err),
    );
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('feedback_ledger_write');

  try {
    upsertFeedbackLedger(projectId, parsed.episodeId, parsed.artifactKey, parsed.payload);
    return {
      title: `feedback_ledger_write: ${parsed.episodeId}/${parsed.artifactKey}`,
      output: `已写入反馈账本（episode=${parsed.episodeId}, key=${parsed.artifactKey}）。`,
      metadata: {
        ok: true,
        episodeId: parsed.episodeId,
        artifactKey: parsed.artifactKey,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { err: msg, projectId, episodeId: parsed.episodeId, artifactKey: parsed.artifactKey },
      'feedback_ledger_write failed',
    );
    return {
      title: 'feedback_ledger_write',
      output: `反馈账本写入失败: ${msg}`,
      metadata: { ok: false, reason: 'write_failed', error: msg },
    };
  }
};

/**
 * feedback_ledger_read：读 feedback ledger（单 key 或单 episode 全 key）。
 *
 * write_chapter chain-start 读上一章三 artifact 填 feedback var（auditFindings /
 * emotionVerifyFeedback / completenessFeedback）。artifactKey 指定 → 单条；缺省 → 该 episode 全 key 数组。
 *
 * read 永不抛：未注册 / 无记录 / repo 失败 → 友好消息（mirror queryWorldStateHandler）。无记录是常态
 * （第一章 / 新项目）→ ok:true + count:0（caller 见空降级空串 feedback var，mirror Director graceful）。
 */
export const feedbackLedgerReadHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: ReturnType<typeof feedbackLedgerReadRequestSchema.parse>;
  try {
    parsed = feedbackLedgerReadRequestSchema.parse(params);
  } catch (err) {
    return invalidParams(
      'feedback_ledger_read',
      err instanceof Error ? err.message : String(err),
    );
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('feedback_ledger_read');

  try {
    // artifactKey 指定 → 单条；缺省 → 该 episode 全 key 数组。
    if (parsed.artifactKey) {
      const entry = readFeedbackLedger(projectId, parsed.episodeId, parsed.artifactKey);
      if (!entry) {
        return {
          title: `feedback_ledger_read: ${parsed.episodeId}/${parsed.artifactKey}`,
          output: `未找到反馈账本记录（episode=${parsed.episodeId}, key=${parsed.artifactKey}）。`,
          metadata: { ok: true, episodeId: parsed.episodeId, artifactKey: parsed.artifactKey, entry: null },
        };
      }
      return {
        title: `feedback_ledger_read: ${parsed.episodeId}/${parsed.artifactKey}`,
        output: `## ${parsed.episodeId}/${parsed.artifactKey}\n\`\`\`json\n${JSON.stringify(entry.payload ?? null, null, 2)}\n\`\`\``,
        metadata: { ok: true, episodeId: parsed.episodeId, artifactKey: parsed.artifactKey, entry },
      };
    }
    const entries = readEpisodeFeedback(projectId, parsed.episodeId);
    return {
      title: `feedback_ledger_read: ${parsed.episodeId} (${entries.length})`,
      output:
        entries.length > 0
          ? `## ${parsed.episodeId} 反馈账本\n${entries.map((e) => `- ${e.artifactKey}（${e.producedAt}）`).join('\n')}`
          : `未找到反馈账本记录（episode=${parsed.episodeId}）。`,
      metadata: { ok: true, episodeId: parsed.episodeId, count: entries.length, entries },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { err: msg, projectId, episodeId: parsed.episodeId },
      'feedback_ledger_read failed',
    );
    return {
      title: 'feedback_ledger_read',
      output: `反馈账本读取失败: ${msg}`,
      metadata: { ok: false, reason: 'read_failed', error: msg },
    };
  }
};
