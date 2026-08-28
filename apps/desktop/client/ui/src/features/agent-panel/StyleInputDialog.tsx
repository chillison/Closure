import { useCallback, useRef, useState } from 'react';
import { buildStyleInputMessage } from '@orison/shared-contracts';
import { useDialogA11y } from '../../shared/hooks/useDialogA11y';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';

/**
 * 风格片段对话框（风格卡片 MVP，08-28 C 路）。
 *
 * leader `request_style_input` 工具 → tool:event `style_input_requested` →
 * useToolEvents → styleInputSlice.pendingStyleInput → App 层条件挂载本组件。
 *
 * 提交：fragment/notes 以标记行结构化为一条 user message（buildStyleInputMessage，
 * shared-contracts 单源——按 sourceMessageId 机械提取原文的消费端对齐 parseStyleInputMessage），
 * 经 sendAgentMessage 发送。提交期间 run 在途（leader 还在收尾回复）→ 禁提交防
 * sendAgentMessage 静默早退丢消息（跑完自动解禁）。
 *
 * 草稿保命两闸（CR-012，08-28 BMad CR）：
 * - **cancel/overlay/Esc 只隐藏不清草稿**——fragment/notes 持有在 styleInputSlice（写穿），
 *   组件卸载不丢，重开对话框草稿还原；清草稿仅「发送确认成功后」与切项目两处。
 * - **发送失败恢复**——sendAgentMessage 返 false（无项目 / run 竞态在途 / 同项目他 run
 *   占用 / 会话创建失败）→ 对话框保持打开、草稿保留，不静默丢（占用 toast 由 send 侧既有
 *   面呈现）。发送确认成功（true）才关对话框清草稿。
 *
 * 形态 mirror ImageEditDialog：overlay 点击取消 / Esc 取消（useDialogA11y）/ 对话框
 * stopPropagation。handleCancel 用 useCallback 钉稳身份——useDialogA11y 的 effect 以
 * onClose 为依赖，每次渲染变身份会在打字时反复 el.focus() 抢走 textarea 焦点。
 */

/**
 * 片段最少字数（非空白字符，码点口径）。
 *
 * ⚠️ 值联动点（CR-013 五处漂移台账——改这里必须同步四处，agent 侧抽 shared 常量归另一批）：
 * - agent `tool/dispatch-style-analyzer.ts` `MIN_FRAGMENT_CHARS`（工具侧 300 字短路门，同值同口径）；
 * - agent `tool/builtin.ts` request_style_input / dispatch_style_analyzer 工具描述里的「至少 300 字」；
 * - i18n `agent.yaml` `styleInputHint` / `styleInputTooShort` / `styleInputCount`（"{count} / 300 字"）文案；
 * - 分析者 `prompts/style-analyzer-agent.yaml` 材料不足判据。
 * 计数口径与工具侧 computeStyleStats.totalChars 对齐：非空白字符按**码点**计（for-of 语义），
 * 非 UTF-16 length——emoji/扩展平面字符算 1 不算 2（CR-014）。
 */
export const STYLE_INPUT_MIN_CHARS = 300;

export function StyleInputDialog() {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [markerError, setMarkerError] = useState(false);

  const pending = useAppStore((s) => s.pendingStyleInput);
  const draft = useAppStore((s) => s.styleInputDraft);
  const activeSessionRunning = useAppStore((s) => s.activeSessionRunning);
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const clearStyleInput = useAppStore((s) => s.clearStyleInput);
  const setStyleInputDraft = useAppStore((s) => s.setStyleInputDraft);
  const clearStyleInputDraft = useAppStore((s) => s.clearStyleInputDraft);
  const { t } = useI18n(resolvedLocale);

  const handleCancel = useCallback(() => {
    // CR-012：只隐藏不清草稿——草稿在 slice 存活，重开还原。
    clearStyleInput();
  }, [clearStyleInput]);
  useDialogA11y(dialogRef, handleCancel);

  const trimmedFragment = draft.fragment.trim();
  // 字数口径与工具侧 300 字门对齐（dispatch_style_analyzer 短路门 = computeStyleStats.totalChars
  // 非空白字符）——若前端按含空白 length 放行，多换行片段会在边界处「前端过、工具判材料不足」错位。
  // 码点计数（[...str]）对齐工具侧 for-of 语义：emoji/扩展平面字符 1 个字非 2（CR-014——
  // UTF-16 length 会把它们劈成代理对计 2，边界处前端多算、放行了工具侧判不足的片段）。
  const fragmentCount = [...trimmedFragment.replace(/\s/g, '')].length;
  const tooShort = fragmentCount > 0 && fragmentCount < STYLE_INPUT_MIN_CHARS;
  const canSubmit = fragmentCount >= STYLE_INPUT_MIN_CHARS && !activeSessionRunning && !markerError;

  async function handleSubmit() {
    if (!canSubmit) return;
    let message: string;
    try {
      message = buildStyleInputMessage(trimmedFragment, draft.notes.trim() || undefined);
    } catch {
      // fragment/notes 含保留标记行——响亮提示，不静默坏解析（不关对话框）。
      setMarkerError(true);
      return;
    }
    // 发送确认成功才关（CR-012）：false = 早退未发（run 竞态在途 / 他 run 占用等）——
    // 对话框保持打开、草稿保留（非静默丢；失败提示由 send 侧既有 toast/error 面呈现）。
    const sent = await useAppStore.getState().sendAgentMessage(message);
    if (!sent) return;
    clearStyleInputDraft();
    clearStyleInput();
  }

  return (
    <div className="style-input-overlay" role="dialog" aria-modal="true" aria-label={t('agent.styleInputTitle')} onClick={handleCancel}>
      <div className="style-input-dialog" ref={dialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <header className="style-input-dialog-header">
          <h2>{t('agent.styleInputTitle')}</h2>
          <button type="button" className="style-input-dialog-close" aria-label={t('agent.cancel')} onClick={handleCancel}>
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </header>
        {pending?.prompt
          ? <p className="style-input-dialog-prompt">{pending.prompt}</p>
          : <p className="style-input-dialog-prompt">{t('agent.styleInputHint')}</p>}
        <div className="style-input-dialog-body">
          <div className="style-input-dialog-field">
            <label htmlFor="style-input-fragment">{t('agent.styleInputFragmentLabel')}</label>
            <textarea
              id="style-input-fragment"
              value={draft.fragment}
              rows={12}
              placeholder={t('agent.styleInputFragmentPlaceholder')}
              onChange={(event) => {
                setStyleInputDraft({ fragment: event.target.value });
                if (markerError) setMarkerError(false);
              }}
            />
            <div className="style-input-dialog-meta">
              <span className="style-input-dialog-count">{t('agent.styleInputCount', { count: fragmentCount })}</span>
              {tooShort && <span className="style-input-dialog-warn">{t('agent.styleInputTooShort')}</span>}
            </div>
          </div>
          <div className="style-input-dialog-field">
            <label htmlFor="style-input-notes">{t('agent.styleInputNotesLabel')}</label>
            <textarea
              id="style-input-notes"
              value={draft.notes}
              rows={2}
              placeholder={t('agent.styleInputNotesPlaceholder')}
              onChange={(event) => {
                setStyleInputDraft({ notes: event.target.value });
                if (markerError) setMarkerError(false);
              }}
            />
          </div>
          {markerError && (
            <div className="style-input-dialog-error" role="alert">{t('agent.styleInputMarkerError')}</div>
          )}
        </div>
        <footer className="style-input-dialog-footer">
          <span className="style-input-dialog-busy">
            {activeSessionRunning ? t('agent.styleInputBusy') : ''}
          </span>
          <button type="button" onClick={handleCancel}>{t('agent.cancel')}</button>
          <button type="button" className="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {t('agent.styleInputSubmit')}
          </button>
        </footer>
      </div>
    </div>
  );
}
