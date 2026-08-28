import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { settingMdActionSchema, type SettingMdAction } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { isProjectRunActive } from '../../shared/store/agentSessionSlice';
import { useI18n } from '../../shared/i18n/useI18n';
import { useToastStore } from '../../shared/store/toastStore';
import { SideBySideDiff } from './SideBySideDiff';
import { toolPresentation, toolLabel } from './toolMeta';

/**
 * Story 2.2 WP-B（design §3 / Step 0 定案）：setting_md_update suggest 档的专用审阅卡。
 *
 * 数据源：tool result metadata `{type:'setting_md_patch', settingId, actions, before,
 * after, summary}`（shell settingMdHandlers 投影，不写盘）。专用分流（mirror chapter_candidate
 * 先例）而非复用 passage/chapter DiffCard——passage accept 有「文件须在 tab 打开否则静默丢」
 * 前置、chapter accept 硬偏置 chapters/（Step 0 核实否决主案）。零「文件须打开」依赖。
 *
 * 呈现：7.5 词级 diff 渲染器（SideBySideDiff 传裸 before/after + readonly，mirror
 * ChapterReviewPanel revision-guard 卡用法）+ accept/reject。accept 调 closure:accept-setting-md
 * IPC——shell 对**当前文件**重放 actions（非写 stale after；文件已变则 ok:false → toast
 * 「文档已变化，请重新提议」，卡保持可操作）。reject 丢弃（suggest 档从未写盘，纯本地）。
 * 状态住 settingMdPatchSlice（resolved map，key = toolCallId 优先）；metadata 是加法——
 * result.output 由本卡逐字保留（mirror ReviewFindingsCard CR-001 保底块）。
 */

export interface SettingMdPatchMeta {
  settingId: string;
  filePath?: string;
  actions: SettingMdAction[];
  before: string;
  after: string;
  summary?: string;
}

type ToolResultLike = { toolCallId?: string; toolId?: string; toolName?: string; output?: string; metadata?: unknown };

/**
 * metadata unknown seam 形态守卫（spec ui/state-management：unknown 值消费前必须守卫，禁裸 as）。
 * type==='setting_md_patch' + settingId string + before/after strings + actions 逐条经
 * settingMdActionSchema 校验才认——**任一条 action 畸形则整体 null**（与「坏条目单独丢」哲学
 * 相反是有意的：accept 会重放全部 actions，静默丢一条 = 悄悄改变补丁语义；畸形 envelope 干脆
 * 不出可操作卡，result.output 文字仍呈现）。envelope 由本产品 shell handler 产出，本守卫只防
 * 消息数据损坏。
 */
export function extractSettingMdPatch(metadata: unknown): SettingMdPatchMeta | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = metadata as {
    type?: unknown; settingId?: unknown; filePath?: unknown; actions?: unknown;
    before?: unknown; after?: unknown; summary?: unknown;
  };
  if (raw.type !== 'setting_md_patch') return null;
  if (typeof raw.settingId !== 'string' || raw.settingId.length === 0) return null;
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) return null;
  if (typeof raw.before !== 'string' || typeof raw.after !== 'string') return null;
  const actions: SettingMdAction[] = [];
  for (const a of raw.actions) {
    const parsed = settingMdActionSchema.safeParse(a);
    if (!parsed.success) return null;
    actions.push(parsed.data);
  }
  return {
    settingId: raw.settingId,
    ...(typeof raw.filePath === 'string' ? { filePath: raw.filePath } : {}),
    actions,
    before: raw.before,
    after: raw.after,
    ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
  };
}

/**
 * 卡片稳定身份：toolCallId 优先（per-call 唯一，mirror DiffCard chapter 匹配）；缺省退化为
 * 内容身份（settingId + 条数 + 首条锚 quote/title）。
 */
export function settingMdPatchCardKey(result: ToolResultLike, meta: SettingMdPatchMeta): string {
  if (result.toolCallId) return `setting-md:${result.toolCallId}`;
  const first = meta.actions[0] as { op?: unknown; anchor?: { quote?: unknown }; title?: unknown } | undefined;
  const identity =
    typeof first?.anchor?.quote === 'string' && first.anchor.quote
      ? first.anchor.quote
      : typeof first?.title === 'string' && first.title
        ? first.title
        : '';
  return `setting-md:${meta.settingId}:${meta.actions.length}:${identity}`;
}

/**
 * dogfood R2 #25：本卡是否已决（mirror AuthorProfilePatchCard 同名助手）——内联抑制
 * 与钉底收集共用同一判定，key 推导不漂移。
 */
export function isSettingMdPatchResolved(
  result: ToolResultLike,
  resolved: Readonly<Record<string, 'applied' | 'rejected'>> | undefined,
): boolean {
  const meta = extractSettingMdPatch(result.metadata);
  if (!meta) return true;
  return resolved?.[settingMdPatchCardKey(result, meta)] !== undefined;
}

/**
 * dogfood R2 #25：扫出未决 setting_md_patch 结果，供 AgentPanel 钉底渲染
 * （mirror PatchReviewPanel 位）；resolved 后回内联原位。
 */
export function pendingSettingMdPatchResults(
  messages: Iterable<{ toolResults?: readonly ToolResultLike[] }> | undefined,
  resolved: Readonly<Record<string, 'applied' | 'rejected'>> | undefined,
): ToolResultLike[] {
  const out: ToolResultLike[] = [];
  for (const m of messages ?? []) {
    for (const r of m.toolResults ?? []) {
      if (extractSettingMdPatch(r.metadata) && !isSettingMdPatchResolved(r, resolved)) out.push(r);
    }
  }
  return out;
}

export function SettingMdPatchCard({ result }: { result: ToolResultLike }) {
  const meta = extractSettingMdPatch(result.metadata);

  const { resolvedLocale, agentLoading, currentProject, resolvedSettingMdPatches, resolveSettingMdPatch } = useAppStore(
    useShallow((s) => ({
      resolvedLocale: s.resolvedLocale,
      // dogfood T1 Stage 3（r8 三分）：accept 闸 =「有 run 在途勿动」（项目运行语义）。
      agentLoading: isProjectRunActive(s),
      currentProject: s.currentProject,
      resolvedSettingMdPatches: s.resolvedSettingMdPatches,
      resolveSettingMdPatch: s.resolveSettingMdPatch,
    })),
  );
  const { t } = useI18n(resolvedLocale);
  const [busy, setBusy] = useState(false);

  if (!meta) return null;
  const key = settingMdPatchCardKey(result, meta);
  // CR-08-16-007：resolved 二值——reject 显「已丢弃」而非「已应用」（拒掉的补丁从未写盘）。
  const resolvedOutcome = resolvedSettingMdPatches[key];
  const isResolved = resolvedOutcome !== undefined;

  const toolId = result.toolName ?? result.toolId ?? '';
  const { icon } = toolPresentation(toolId);
  const toolLabelText = toolLabel(toolId, t);

  const handleAccept = async () => {
    const projectPath = currentProject?.path;
    if (!projectPath || busy) return;
    setBusy(true);
    try {
      const res = await window.orisonDesktop?.acceptSettingMdPatch?.({
        projectPath,
        settingId: meta.settingId,
        actions: meta.actions,
      });
      if (res?.ok) {
        resolveSettingMdPatch(key, 'applied');
      } else {
        // Re-apply failed (file drifted / anchor no longer unique / fs error):
        // keep the card actionable and surface the reason.
        useToastStore
          .getState()
          .showToast(t('agent.settingMd.reapplyFailed', { reason: res?.reason ?? 'unknown' }), 'error');
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      useToastStore.getState().showToast(t('agent.settingMd.reapplyFailed', { reason }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-diff-card">
      <div className="agent-diff-card-header">
        <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
        <span className="agent-diff-card-name">{toolLabelText} · {meta.settingId}</span>
        {resolvedOutcome === 'applied' && <span className="agent-diff-card-status">✓ {t('agent.applied')}</span>}
        {resolvedOutcome === 'rejected' && <span className="agent-diff-card-status">✕ {t('agent.discarded')}</span>}
        {!isResolved && meta.summary && <span className="agent-diff-card-status">{meta.summary}</span>}
      </div>
      <SideBySideDiff
        oldContent={meta.before}
        newContent={meta.after}
        readonly
        fileName={meta.summary ?? `settings/${meta.settingId}.md`}
      />
      {!isResolved && (
        <div className="agent-diff-card-actions">
          <button
            type="button"
            className="agent-diff-btn agent-diff-btn-accept"
            // 3.7 agentLoading 门 mirror：run 进行中禁用 accept（防与 leader 写竞争同文件）。
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
            // CR-08-16-105：reject 也吃 busy 门——accept IPC 在途时点 reject 会「已丢弃」+ 文件随后
            // 仍被写入（徽标与用户行为相反）；busy 窗口内两键互斥，先到先得。
            disabled={busy}
            onClick={() => resolveSettingMdPatch(key, 'rejected')}
          >
            {t('agent.reject')}
          </button>
        </div>
      )}
      {result.output ? <div className="agent-diff-card-body">{result.output}</div> : null}
    </div>
  );
}
