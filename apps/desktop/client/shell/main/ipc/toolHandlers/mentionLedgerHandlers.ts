/**
 * Story 8.7 S8 mention ledger write handlers（design §2.2/§2.3，ADR-3）。
 *
 * 2 chain-internal write handlers（mirror worldStateHandlers.materializeChapterSummaryHandler 定位——
 * 由链段节点经 registry 直调触发，非 LLM 主动调用面）：
 * - `record_episode_mentions`：mention-ledger-node 调用——四通道汇账（申报/在场/粗筛/计划）+
 *   synopsis 回填（组装核心 mentionLedgerMaterialize.recordEpisodeMentionsCore）。
 * - `degrade_episode_mentions`：targeted-revision 落盘后降档（mention 行翻保守档 + synopsis 标 stale，
 *   mentionLedgerRepository.degradeEpisodeMentions 复合）。
 *
 * Each agent tool (agent/src/tool/builtin.ts) crosses processes via the UNIFIED `toolExecution`
 * channel (remoteToolProxy -> handleToolExecute -> these handlers). NO dedicated IPC channel.
 *
 * projectId is derived from projectDir via `getProject(path.resolve(projectDir))`（mirror
 * catalogHandlers / worldStateHandlers）. Handlers NEVER throw on bad input（mirror
 * 「never throws」契约——malformed param / missing project / repo failure 降级为友好 miss，
 * 链段节点据 metadata.ok 降级不破链）。
 *
 * 🔴 与读工具零持久化副作用 Convention 的关系（agent-tools.md，Story 8.1）：本二件是**链上写节点**
 * 触发的写路径（mirror materialize_chapter_summary / write_world_events 定位），非 read 分类工具的
 * 顺手缓存——BMad CR-002 起 toolPolicy WRITE_TOOLS 显式收录（classifyTool='write'，readonly/suggest
 * 档 LLM 直调被拦），链内 registry.execute 直调不经 filterToolsForPolicy 照旧可达（调用来源判据）。
 *
 * 范式判据（ADR-3）：汇账/降档全在 shared 纯函数 + repository（db 读写）；handler 只做参数校验 +
 * 取数组装 + 结果渲染，零语义判断。
 */
import path from 'node:path';
import {
  degradeEpisodeMentionsRequestSchema,
  recordEpisodeMentionsRequestSchema,
  type DegradeEpisodeMentionsRequest,
  type RecordEpisodeMentionsRequest,
} from '@orison/shared-contracts';
import { getProject } from '../../db/projectRepository';
import { degradeEpisodeMentions } from '../../db/mentionLedgerRepository';
import { recordEpisodeMentionsCore } from '../../db/mentionLedgerMaterialize';
import { getLogger } from '../../logger';
import type { ToolHandler } from './types';

// ── projectId 解析（mirror catalogHandlers / worldStateHandlers）──
function resolveProjectId(projectDir: string): string | null {
  // local_fingerprint == path.resolve(projectDir)（ensureProject 约定，closureHandlers 注释）。
  return getProject(path.resolve(projectDir))?.projectId ?? null;
}

function notRegistered(toolId: string) {
  return {
    title: toolId,
    output: '当前项目未注册到数据库，无法访问出场账。',
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

/**
 * 信号计数（handler 输出可读摘要用——五类各一计，信号明细走 metadata 供节点产 artifact）。
 */
function countSignals(signals: { kind: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of signals) out[s.kind] = (out[s.kind] ?? 0) + 1;
  return out;
}

/**
 * record_episode_mentions：一章出场账汇账写入（per-episode 全量替换幂等——同章重收整体覆盖）。
 * 调用方（mention-ledger-node）只传链内 artifact 投影；db/project.yaml 侧数据由核心自取。
 */
export const recordEpisodeMentionsHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: RecordEpisodeMentionsRequest;
  try {
    parsed = recordEpisodeMentionsRequestSchema.parse(params);
  } catch (err) {
    return invalidParams('record_episode_mentions', err instanceof Error ? err.message : String(err));
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('record_episode_mentions');

  try {
    const result = await recordEpisodeMentionsCore(projectId, projectDir, parsed.episodeId, {
      ...(parsed.declaration !== undefined ? { declaration: parsed.declaration } : {}),
      draftText: parsed.draftText,
      ...(parsed.plannedAssetRefs !== undefined ? { plannedAssetRefs: parsed.plannedAssetRefs } : {}),
    });
    const synopsisLabel =
      result.synopsis === 'applied'
        ? '梗概已写入章摘要'
        : result.synopsis === 'no_summary_row'
          ? '章摘要行缺失，梗概未写入'
          : result.synopsis === 'skipped'
            ? '章摘要为空，梗概未写入'
            : '无申报，梗概不写入';
    const degradeLabel =
      result.degradedReasons.length > 0 ? `；⚠ ${result.degradedReasons.join('；')}` : '';
    return {
      title: `record_episode_mentions: ${parsed.episodeId}`,
      output:
        `已登记 ${parsed.episodeId} 出场账 ${result.rowCount} 条（${parsed.declaration !== undefined ? '含写手申报' : '保守账（无申报）'}；${synopsisLabel}${degradeLabel}）。`,
      metadata: {
        ok: true,
        episodeId: parsed.episodeId,
        rowCount: result.rowCount,
        signals: result.signals,
        signalCounts: countSignals(result.signals),
        synopsis: result.synopsis,
        degradedReasons: result.degradedReasons,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { err: msg, projectId, episodeId: parsed.episodeId },
      'record_episode_mentions failed',
    );
    return {
      title: 'record_episode_mentions',
      output: `出场账登记失败: ${msg}`,
      metadata: { ok: false, reason: 'record_failed', error: msg },
    };
  }
};

/**
 * degrade_episode_mentions：章正文修订后降档（declared 清位 + source 翻保守档 + synopsis 标 stale，
 * 幂等）。链内 targeted-revision 落盘后触发；对话侧章落盘点（chapter_write / write_file / 编辑器
 * 写盘）的降档走 db/mentionLedgerDegrade 同 repository 复合（BMad CR-001 方案 A，不经本 handler）。
 */
export const degradeEpisodeMentionsHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: DegradeEpisodeMentionsRequest;
  try {
    parsed = degradeEpisodeMentionsRequestSchema.parse(params);
  } catch (err) {
    return invalidParams('degrade_episode_mentions', err instanceof Error ? err.message : String(err));
  }

  const projectId = resolveProjectId(projectDir);
  if (!projectId) return notRegistered('degrade_episode_mentions');

  try {
    const result = degradeEpisodeMentions(projectId, parsed.episodeId);
    return {
      title: `degrade_episode_mentions: ${parsed.episodeId}`,
      output:
        `已将 ${parsed.episodeId} 出场账降为保守档（${result.changedRows} 行；申报通道清位，机械通道保留）` +
        `${result.synopsisMarked ? '；章梗概已标注可能过时' : ''}。`,
      metadata: {
        ok: true,
        episodeId: parsed.episodeId,
        changedRows: result.changedRows,
        synopsisMarked: result.synopsisMarked,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { err: msg, projectId, episodeId: parsed.episodeId },
      'degrade_episode_mentions failed',
    );
    return {
      title: 'degrade_episode_mentions',
      output: `出场账降档失败: ${msg}`,
      metadata: { ok: false, reason: 'degrade_failed', error: msg },
    };
  }
};
