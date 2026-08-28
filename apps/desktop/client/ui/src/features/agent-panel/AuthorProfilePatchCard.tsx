import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { isProjectRunActive } from '../../shared/store/agentSessionSlice';
import { useI18n } from '../../shared/i18n/useI18n';
import { useToastStore } from '../../shared/store/toastStore';
import { SideBySideDiff } from './SideBySideDiff';
import { toolPresentation } from './toolMeta';

/**
 * Story 8.6 R4（design D6 / §3.1）：author_profile_update suggest 档的专用审阅卡
 * ——mirror SettingMdPatchCard（2.2 专用分流先例）。
 *
 * 数据源：tool result metadata `{type:'author_profile_patch', note, before, after,
 * filePath}`（shell authorProfileHandlers 投影，不写盘）。专用分流而非 generic
 * field_patch/PatchReviewPanel——档案是机器级文件（~/.orison/author_profile.md）非
 * creative field，patchFieldSchema 装不下；也非 chapter/passage DiffCard（无锚定位语义）。
 *
 * 呈现：说人话标题（「编辑想记一笔关于你的观察」）+ note 原文 + 7.5 词级 diff 渲染器
 * （SideBySideDiff 裸 before/after + readonly，mirror SettingMdPatchCard 用法）+
 * accept/reject。accept 调 author-profile:apply IPC——shell 对**当前档案**重新追加 note
 * （永不写 stale after 快照；档案在提议与采纳之间被作者手改不受影响）。reject 纯本地丢弃
 * （suggest 档从未写盘）。状态住 authorProfilePatchSlice（resolved 二值 map，key =
 * toolCallId 优先）；metadata 是加法——result.output 由本卡逐字保留（CR-001 保底块 mirror）。
 */

export interface AuthorProfilePatchMeta {
  note: string;
  before: string;
  after: string;
  filePath?: string;
}

type ToolResultLike = { toolCallId?: string; toolId?: string; toolName?: string; output?: string; metadata?: unknown };

/**
 * metadata unknown seam 形态守卫（spec ui/state-management：unknown 值消费前必须守卫，禁裸 as）。
 * type==='author_profile_patch' + note 非空 string + before/after strings 才认；filePath 可选
 * string（展示用）。envelope 由本产品 shell handler 产出，本守卫只防消息数据损坏。
 */
export function extractAuthorProfilePatch(metadata: unknown): AuthorProfilePatchMeta | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = metadata as {
    type?: unknown; note?: unknown; before?: unknown; after?: unknown; filePath?: unknown;
  };
  if (raw.type !== 'author_profile_patch') return null;
  if (typeof raw.note !== 'string' || raw.note.trim().length === 0) return null;
  if (typeof raw.before !== 'string' || typeof raw.after !== 'string') return null;
  return {
    note: raw.note,
    before: raw.before,
    after: raw.after,
    ...(typeof raw.filePath === 'string' ? { filePath: raw.filePath } : {}),
  };
}

/**
 * 卡片稳定身份：toolCallId 优先（per-call 唯一，mirror SettingMdPatchCard）；缺省退化为
 * 内容身份（note 前 60 字 + before 长度——同 note 重复提议仍各得其所）。
 */
export function authorProfilePatchCardKey(result: ToolResultLike, meta: AuthorProfilePatchMeta): string {
  if (result.toolCallId) return `author-profile:${result.toolCallId}`;
  const noteIdentity = meta.note.slice(0, 60);
  return `author-profile:${noteIdentity}:${meta.before.length}`;
}

/**
 * dogfood R2 #25：本卡是否已决（resolved map 有 key）。非 author_profile_patch 结果
 * 恒 true（不属本族，调用方按各自族处理）——供 AgentMessageItem 内联抑制与 AgentPanel
 * 钉底收集共用同一判定，避免两处 key 推导漂移。
 */
export function isAuthorProfilePatchResolved(
  result: ToolResultLike,
  resolved: Readonly<Record<string, 'applied' | 'rejected'>> | undefined,
): boolean {
  const meta = extractAuthorProfilePatch(result.metadata);
  if (!meta) return true;
  return resolved?.[authorProfilePatchCardKey(result, meta)] !== undefined;
}

/**
 * dogfood R2 #25：从会话消息扫出**未决** author_profile_patch 结果——AgentPanel 在
 * 消息滚动区外钉底渲染（mirror PatchReviewPanel 位），resolved 后由内联原位接管。
 */
export function pendingAuthorProfilePatchResults(
  messages: Iterable<{ toolResults?: readonly ToolResultLike[] }> | undefined,
  resolved: Readonly<Record<string, 'applied' | 'rejected'>> | undefined,
): ToolResultLike[] {
  const out: ToolResultLike[] = [];
  for (const m of messages ?? []) {
    for (const r of m.toolResults ?? []) {
      if (extractAuthorProfilePatch(r.metadata) && !isAuthorProfilePatchResolved(r, resolved)) out.push(r);
    }
  }
  return out;
}

export function AuthorProfilePatchCard({ result }: { result: ToolResultLike }) {
  const meta = extractAuthorProfilePatch(result.metadata);

  const { resolvedLocale, agentLoading, resolvedAuthorProfilePatches, resolveAuthorProfilePatch } = useAppStore(
    useShallow((s) => ({
      resolvedLocale: s.resolvedLocale,
      // dogfood T1 Stage 3（r8 三分）：accept 闸 =「有 run 在途勿动」（项目运行语义）。
      agentLoading: isProjectRunActive(s),
      resolvedAuthorProfilePatches: s.resolvedAuthorProfilePatches,
      resolveAuthorProfilePatch: s.resolveAuthorProfilePatch,
    })),
  );
  const { t } = useI18n(resolvedLocale);
  const [busy, setBusy] = useState(false);

  if (!meta) return null;
  const key = authorProfilePatchCardKey(result, meta);
  // resolved 二值（CR-08-16-007 mirror）——reject 显「已丢弃」而非「已应用」。
  const resolvedOutcome = resolvedAuthorProfilePatches[key];
  const isResolved = resolvedOutcome !== undefined;

  const toolId = result.toolName ?? result.toolId ?? '';
  const { icon } = toolPresentation(toolId);

  const handleAccept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await window.orisonDesktop?.applyAuthorProfileNote?.({ note: meta.note });
      if (res?.ok) {
        resolveAuthorProfilePatch(key, 'applied');
      } else {
        // Append failed (fs error): keep the card actionable and surface the reason.
        useToastStore
          .getState()
          .showToast(t('agent.authorProfile.applyFailed', { reason: res?.reason ?? 'unknown' }), 'error');
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      useToastStore.getState().showToast(t('agent.authorProfile.applyFailed', { reason }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-diff-card">
      <div className="agent-diff-card-header">
        <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
        <span className="agent-diff-card-name">{t('agent.authorProfile.cardTitle')}</span>
        {resolvedOutcome === 'applied' && <span className="agent-diff-card-status">✓ {t('agent.applied')}</span>}
        {resolvedOutcome === 'rejected' && <span className="agent-diff-card-status">✕ {t('agent.discarded')}</span>}
      </div>
      <div className="agent-author-profile-note-block">
        <span className="agent-author-profile-note-label">{t('agent.authorProfile.noteLabel')}</span>
        <p className="agent-author-profile-note">{meta.note}</p>
      </div>
      <SideBySideDiff
        oldContent={meta.before}
        newContent={meta.after}
        readonly
        fileName={meta.filePath ?? t('agent.authorProfile.fileName')}
      />
      {!isResolved && (
        <div className="agent-diff-card-actions">
          <button
            type="button"
            className="agent-diff-btn agent-diff-btn-accept"
            // 3.7 agentLoading 门 mirror：run 进行中禁用 accept（防与 leader 后续写竞争）。
            // busy = 本卡 IPC 在途。
            disabled={agentLoading || busy}
            onClick={() => {
              void handleAccept();
            }}
          >
            {t('agent.accept')}
          </button>
          <button
            type="button"
            className="agent-diff-btn agent-diff-btn-reject"
            // CR-08-16-105 mirror：reject 也吃 busy 门——accept IPC 在途时点 reject 会「已丢弃」+
            // 档案随后仍被写入（徽标与用户行为相反）；busy 窗口内两键互斥，先到先得。
            disabled={busy}
            onClick={() => resolveAuthorProfilePatch(key, 'rejected')}
          >
            {t('agent.reject')}
          </button>
        </div>
      )}
      {result.output ? <div className="agent-diff-card-body">{result.output}</div> : null}
    </div>
  );
}
