import { useState, useCallback, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { Tooltip } from '../../shared/components/Tooltip';
import { storage } from '../../shared/store/storage';
import type { AgentMode, AgentBehaviorMode } from '../../shared/store/types';
import type { StructurePattern } from '@orison/shared-contracts';
import type { Attachment } from '../../shared/types/attachment';
import { readAssetsDirectory, type DirEntry } from '../../shared/api/assets';
import { AgentConfirmCard } from './AgentConfirmCard';
import { AgentPassageResolveCard } from './AgentPassageResolveCard';

// Story 3.1 WP2: the existing permission mode (readonly/suggest/auto) is
// relabeled to the autonomy axis (微操/半自动/全权). Values are UNCHANGED for
// back-compat — only the i18n key each option points at changes.
const MODE_KEYS: { value: AgentMode; i18nKey: string }[] = [
  { value: 'readonly', i18nKey: 'agent.modeMicro' },
  { value: 'suggest', i18nKey: 'agent.modeHalfAuto' },
  { value: 'auto', i18nKey: 'agent.modeFull' },
];

// Story 3.1 WP1: behavior mode (normal/discuss/plan) is a SECOND, orthogonal
// axis to the permission mode above. It governs how the leader acts per turn,
// not which tools it may call — hence a separate select.
const BEHAVIOR_MODE_KEYS: { value: AgentBehaviorMode; i18nKey: string }[] = [
  { value: 'normal', i18nKey: 'agent.modeNormal' },
  { value: 'discuss', i18nKey: 'agent.modeDiscuss' },
  { value: 'plan', i18nKey: 'agent.modePlan' },
];

// Story 3.1 WP4: direction-first "结构 pattern" affordance. The 6 precast
// structural skeletons + blank from structurePatternSchema (Story 1.4).
// Selecting one injects it as a file-style reference through the existing
// attachment channel (renderAttachmentsIntoContent renders a pointer block) —
// an OPTIONAL accelerator, natural language stays the primary input.
const PATTERN_OPTIONS: { value: StructurePattern; i18nKey: string }[] = [
  { value: 'anchor-single', i18nKey: 'agent.patternAnchorSingle' },
  { value: 'lotus-converging', i18nKey: 'agent.patternLotusConverging' },
  { value: 'main-sub-dual', i18nKey: 'agent.patternMainSubDual' },
  { value: 'progressive-jigsaw', i18nKey: 'agent.patternProgressiveJigsaw' },
  { value: 'parallel-weak', i18nKey: 'agent.patternParallelWeak' },
  { value: 'triple-interactive', i18nKey: 'agent.patternTripleInteractive' },
  { value: 'blank', i18nKey: 'agent.patternBlank' },
];

const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg)$/i;

/** Flatten the (possibly nested) assets/images tree into relative image paths. */
function flattenAssetImages(entries: DirEntry[]): { name: string; rel: string }[] {
  const out: { name: string; rel: string }[] = [];
  const walk = (items: DirEntry[]) => {
    for (const e of items) {
      if (e.isDir) {
        if (Array.isArray(e.children)) walk(e.children);
        continue;
      }
      if (!IMAGE_RE.test(e.name)) continue;
      const sub = (e.path ?? `/${e.name}`).replace(/^\//, '');
      out.push({ name: e.name, rel: `assets/images/${sub}` });
    }
  };
  walk(entries);
  return out;
}

export function AgentInput() {
  const {
    sendAgentMessage, cancelAgent, activeSessionRunning, sessionSwitching,
    agentMode, setAgentMode,
    agentBehaviorMode, setAgentBehaviorMode,
    resolvedLocale,
    hasToolConfirm, hasPassageResolve,
    chapters, openFiles,
    pendingAttachments, addAttachment, removeAttachment,
    projectPath,
    draftPreset,
    consumeDraft,
    // dogfood R2 #11⑤（findings #11⑤）+ CR-38（dogfood R2 BMad CR）：输入行直出钮——存在
    // streaming 且 content **或 reasoning** 非空的消息时可按（think-first 纯思考期恰是最想
    // 直出的窗口；不可按即不渲染，无 disabled 残影）；点击发跨组件信号拉满流式渐进轨。
    streamRevealAvailable,
    requestStreamReveal,
  } = useAppStore(useShallow((s) => ({
    sendAgentMessage: s.sendAgentMessage,
    cancelAgent: s.cancelAgent,
    // dogfood T1 Stage 3（r8 三分）：输入区是视图语义——视图运行态 + 切换加载态共同禁用。
    activeSessionRunning: s.activeSessionRunning,
    sessionSwitching: s.sessionSwitching,
    agentMode: s.agentMode,
    setAgentMode: s.setAgentMode,
    agentBehaviorMode: s.agentBehaviorMode,
    setAgentBehaviorMode: s.setAgentBehaviorMode,
    // r8 键控：挂载门只看当前视图会话的键（后台会话的卡不漏进前台输入区）。
    hasToolConfirm: s.agentSessionId ? s.pendingToolConfirmBySession[s.agentSessionId] !== undefined : false,
    hasPassageResolve: s.agentSessionId ? s.pendingPassageResolveBySession[s.agentSessionId] !== undefined : false,
    resolvedLocale: s.resolvedLocale,
    chapters: s.novelChapters,
    openFiles: s.openFiles,
    pendingAttachments: s.pendingAttachments,
    addAttachment: s.addAttachment,
    removeAttachment: s.removeAttachment,
    projectPath: s.currentProject?.path,
    draftPreset: s.draftPreset,
    consumeDraft: s.consumeDraft,
    streamRevealAvailable: s.agentMessages.some(
      (m) => m.streaming === true && ((m.content ?? '').length > 0 || (m.reasoning ?? '').length > 0),
    ),
    requestStreamReveal: s.requestStreamReveal,
  })));

  const inputBusy = activeSessionRunning || sessionSwitching;

  const { t } = useI18n(resolvedLocale);
  const [text, setText] = useState('');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [assetImages, setAssetImages] = useState<{ name: string; rel: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  // 用户拖拽放大的输入框高度（dogfood 2026-08-21：原 auto-grow 硬顶 160px 无放大选项；
  // 次日改顶边拖拽条——原生右下角 resize 在底部停靠布局里底边被钉死，拖下反而向上长，
  // 直觉相反）。0 = 未手动设过（维持原 auto-grow 行为）；设过后成为 auto-grow 的下限，
  // 且跨会话持久（storage）。
  const [userInputHeight, setUserInputHeight] = useState<number>(() =>
    storage.get<number>('agentInputHeight', 0),
  );
  const userInputHeightRef = useRef(userInputHeight);
  userInputHeightRef.current = userInputHeight;
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Load asset images lazily when the attach menu opens, so a user can pin a
  // generated/imported image as a `file` reference for the agent. Reuses the
  // file attachment channel — no new IPC/runtime shape needed.
  useEffect(() => {
    if (!showAttachMenu || !projectPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await readAssetsDirectory(`${projectPath}/assets/images`);
        if (!cancelled) setAssetImages(flattenAssetImages(entries));
      } catch {
        if (!cancelled) setAssetImages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [showAttachMenu, projectPath]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // auto-grow 上限 160px（原行为），用户手动高度作为下限，绝对顶 40vh。
    const maxVh = Math.round(window.innerHeight * 0.4);
    const grown = Math.min(el.scrollHeight, 160);
    const target = Math.min(Math.max(grown, userInputHeight), maxVh);
    el.style.height = `${target}px`;
  }, [text, userInputHeight]);

  // 顶边拖拽条（替原生 resize）：往上拖变大、往下拖变小——底部停靠组件的方向直觉。
  const INPUT_HEIGHT_MIN = 40;
  const onResizeHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = textareaRef.current;
    if (!el || inputBusy) return;
    dragStateRef.current = {
      startY: e.clientY,
      startHeight: Math.round(el.getBoundingClientRect().height),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current;
    if (!st) return;
    const maxVh = Math.round(window.innerHeight * 0.4);
    const dy = e.clientY - st.startY; // 向下为正 → 高度减小
    const next = Math.max(INPUT_HEIGHT_MIN, Math.min(st.startHeight - dy, maxVh));
    // dogfood #44：ref 同步在渲染期——pointermove 是连续事件（React 18 异步批处理），
    // pointerup 若先于重渲染到达会持久化过期 ref（重启丢高度实录）。这里同步写 ref，
    // 且拖拽中直接落 storage（小值高频写无害），pointerup 再写一次兜底。
    userInputHeightRef.current = next;
    storage.set('agentInputHeight', next);
    setUserInputHeight(next);
  };
  const onResizeHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    storage.set('agentInputHeight', userInputHeightRef.current);
  };

  useEffect(() => {
    if (!showAttachMenu) return;
    const handler = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setShowAttachMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAttachMenu]);

  // Story 3.7：「应用并补充」预填（insightInteractionSlice.draftPreset）——InsightCard 展开态
  // 把 apply 模板预填进输入框（单击直发的补充形态：用户补完自己发，发送时受既有 agentLoading
  // 门管，预填本身不受限，D11）。消费即清空（consumeDraft）避免重复注入；已有输入时追加
  // 不覆盖（保留用户打到一半的话）。聚焦输入框方便直接续写补充。
  useEffect(() => {
    if (draftPreset === null) return;
    setText((prev) => (prev.trim().length > 0 ? `${prev}\n${draftPreset}` : draftPreset));
    consumeDraft();
    textareaRef.current?.focus();
  }, [draftPreset, consumeDraft]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || inputBusy) return;

    // Attachments are passed structurally by sendAgentMessage; no text flattening.
    setText('');
    sendAgentMessage(trimmed);
  }, [text, inputBusy, sendAgentMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAddAttachment = (att: Attachment) => {
    addAttachment(att);
    setShowAttachMenu(false);
  };

  return (
    <div className="agent-input-area">
      {hasToolConfirm && <AgentConfirmCard />}
      {hasPassageResolve && <AgentPassageResolveCard />}

      {pendingAttachments.length > 0 && (
        <div className="agent-input-attachments">
          {pendingAttachments.map((att) => {
            if (att.type === 'selection') {
              // Render selections as a quoted preview. The quote marks are added
              // by the component and the inner text is what gets truncated, so the
              // opening + closing quotes are always balanced — unlike the old
              // `slice(0,20)` label, which cut dialogue mid-quote.
              const raw = (att.text ?? att.label).replace(/\s+/g, ' ').trim();
              const preview = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
              return (
                <span
                  key={`selection-${att.id}`}
                  className="agent-attachment-chip agent-attachment-chip-quote"
                  title={att.text ?? att.label}
                >
                  <span className="agent-attachment-quote-text">“{preview}”</span>
                  <button type="button" className="agent-attachment-remove" onClick={() => removeAttachment(att.id)}>
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </span>
              );
            }
            return (
              <span key={`${att.type}-${att.id}`} className="agent-attachment-chip">
                <span className="material-symbols-outlined" style={{ fontSize: '0.7rem' }}>
                  {att.type === 'chapter' ? 'description' : 'insert_drive_file'}
                </span>
                {att.label}
                <button type="button" className="agent-attachment-remove" onClick={() => removeAttachment(att.id)}>
                  <span className="material-symbols-outlined">close</span>
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="agent-input-toolbar">
        <div className="agent-input-toolbar-left">
          <button
            type="button"
            className="agent-panel-icon-btn"
            onClick={() => setShowAttachMenu(!showAttachMenu)}
            title={t('agent.attach')}
          >
            <span className="material-symbols-outlined">attach_file</span>
          </button>
          {showAttachMenu && (
            <div className="agent-attach-menu" ref={attachMenuRef}>
              <div className="agent-attach-section-title">{t('agent.attachChapter')}</div>
              {chapters.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  className="agent-attach-item"
                  onClick={() => handleAddAttachment({ type: 'chapter', id: ch.id, label: ch.title || ch.id })}
                >
                  <span className="material-symbols-outlined">description</span>
                  {ch.title || ch.id}
                </button>
              ))}
              {openFiles.length > 0 && (
                <>
                  <div className="agent-attach-section-title">{t('agent.attachFile')}</div>
                  {openFiles.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      className="agent-attach-item"
                      onClick={() => handleAddAttachment({ type: 'file', id: f.path, label: f.name })}
                    >
                      <span className="material-symbols-outlined">insert_drive_file</span>
                      {f.name}
                    </button>
                  ))}
                </>
              )}
              {assetImages.length > 0 && (
                <>
                  <div className="agent-attach-section-title">{t('agent.attachAsset')}</div>
                  {assetImages.map((a) => (
                    <button
                      key={a.rel}
                      type="button"
                      className="agent-attach-item"
                      onClick={() => handleAddAttachment({ type: 'file', id: a.rel, label: a.name })}
                    >
                      <span className="material-symbols-outlined">image</span>
                      {a.name}
                    </button>
                  ))}
                </>
              )}
              {/* Story 3.1 WP4: direction-first pattern affordance. Injects a
                  file-style reference chip; backend renders a pointer block. */}
              <div className="agent-attach-section-title">{t('agent.attachPattern')}</div>
              {PATTERN_OPTIONS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className="agent-attach-item"
                  onClick={() => handleAddAttachment({
                    type: 'file',
                    id: `pattern:${p.value}`,
                    label: `${t('agent.attachPatternLabel')}: ${t(p.i18nKey)}`,
                  })}
                >
                  <span className="material-symbols-outlined">account_tree</span>
                  {t(p.i18nKey)}
                </button>
              ))}
              {/* TODO(Story 3.x): @anchor / clue affordances — defer until a
                  dedicated attachment type (or reuse selection) is wired, to
                  avoid perturbing the existing attachment channel. Natural
                  language remains the primary direction input. */}
            </div>
          )}
        </div>
        <select
          className="agent-input-select"
          value={agentMode}
          onChange={(e) => setAgentMode(e.target.value as AgentMode)}
          disabled={inputBusy}
        >
          {MODE_KEYS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.i18nKey)}</option>
          ))}
        </select>
        {/* dogfood 2026-08-21：档位/模式光看名字看不懂——info 悬停解释。 */}
        <Tooltip label={t('agent.permissionModeHelp')} placement="top" multiline>
          <span className="agent-mode-help material-symbols-outlined" aria-hidden="true">info</span>
        </Tooltip>
        {/* Story 3.1 WP1: behavior mode (normal/discuss/plan), orthogonal to the
            autonomy mode above. Disabled mid-run like the other selects. */}
        <select
          className="agent-input-select"
          value={agentBehaviorMode}
          onChange={(e) => setAgentBehaviorMode(e.target.value as AgentBehaviorMode)}
          disabled={inputBusy}
          title={t('agent.behaviorModeTitle')}
        >
          {BEHAVIOR_MODE_KEYS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.i18nKey)}</option>
          ))}
        </select>
        <Tooltip label={t('agent.behaviorModeHelp')} placement="top" multiline>
          <span className="agent-mode-help material-symbols-outlined" aria-hidden="true">info</span>
        </Tooltip>
      </div>
      <div
        className="agent-input-resize"
        onPointerDown={onResizeHandlePointerDown}
        onPointerMove={onResizeHandlePointerMove}
        onPointerUp={onResizeHandlePointerUp}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('agent.inputResize')}
      />
      <div className="agent-input-row">
        <textarea
          ref={textareaRef}
          className="agent-input-textarea"
          placeholder={t('agent.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={inputBusy}
        />
        {/* dogfood R2 #11⑤（findings #11⑤）+ CR-38：直出小钮——stop 钮左侧，点击拉满流式
            渐进轨（不终止流，与 stop 语义区分）。仅存在 streaming 且 content 或 reasoning
            非空的消息时渲染（不可按即消失，无 disabled 残影）。 */}
        {streamRevealAvailable && (
          <button
            type="button"
            className="agent-input-btn"
            onClick={requestStreamReveal}
            title={t('agent.streamReveal')}
            aria-label={t('agent.streamReveal')}
          >
            <span className="material-symbols-outlined">fast_forward</span>
          </button>
        )}
        {activeSessionRunning ? (
          <button type="button" className="agent-input-btn" onClick={cancelAgent} title={t('agent.stop')}>
            <span className="material-symbols-outlined">stop</span>
          </button>
        ) : (
          <button type="button" className="agent-input-btn" onClick={handleSend} title={t('agent.send')} disabled={!text.trim()}>
            <span className="material-symbols-outlined">send</span>
          </button>
        )}
      </div>
    </div>
  );
}
