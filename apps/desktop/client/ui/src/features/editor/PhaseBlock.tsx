import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { outlinePhaseSchema, EpisodeOutline } from '@orison/shared-contracts';
import type { EpisodeUpdatePatch } from './outlinePanelModel';

type OutlinePhase = z.infer<typeof outlinePhaseSchema>;

/**
 * 集纲最小表单的可编辑文本字段（语义字段——作者直写主权，AI 只是加速器）。
 * title 是 CR-27 补的：手动 add_episode 需要可改名（AI 可写 title，用户也得能写——双通道）。
 */
type EpisodeDraft = { title: string; purpose: string; summary: string; core_event: string; hook: string };
const EMPTY_DRAFT: EpisodeDraft = { title: '', purpose: '', summary: '', core_event: '', hook: '' };

const EPISODE_DEBOUNCE_MS = 500;

type Props = {
  phase: OutlinePhase;
  index: number;
  /** OE-3（批次 C）：默认展开卷（活跃卷优先、无记录首卷兜底）——由父层控制。 */
  defaultOpen?: boolean;
  /** OE-2（批次 C）：本卷「实际 N 场」（scene_graph 按 line.phase_ref 计数），0 = 不显示。 */
  sceneCount?: number;
  /** OE-2（批次 C）：挂在本卷下的集纲（phase_ref 已过滤，只读列表 + 最小编辑表单）。 */
  episodes?: EpisodeOutline[];
  /** OE-3（批次 C）：左侧导航点击后的 2s 短暂高亮。 */
  pulse?: boolean;
  /** AI 对话入口禁用态（项目运行中——sendAgentMessage 会静默 no-op，禁用防点击假死）。 */
  aiDisabled?: boolean;
  /**
   * CR-9（dogfood R2）：outline 字段锁定——语义字段「让 AI 打磨」的产出走 outline_update
   * 落盘，锁定时整轮 agent 产出会被跳过，故入口提前禁用（mirror 状态条锁语义，非门卫）。
   */
  outlineLocked?: boolean;
  /**
   * CR-9（dogfood R2）：episode_outlines 字段锁定——编辑/增/删/AI 细化的写入都会被锁挡，
   * 入口全部禁用 + tooltip 提示（人解锁后仍可自由直写——作者主权不受锁约束的是 AI 侧）。
   */
  episodesLocked?: boolean;
  onUpdate: (id: string, patch: Partial<OutlinePhase>) => void;
  onRemove: (id: string) => void;
  /** 集纲写通道：applyEpisodeActions('update_episode') 投影 → updateField('episode_outlines')。 */
  onUpdateEpisode?: (episodeId: string, patch: EpisodeUpdatePatch) => void;
  /** CR-27：手动 add_episode（走 applyEpisodeActions 同一投影器，父层处理写入）。 */
  onAddEpisode?: (phaseId: string) => void;
  /** CR-27：手动 remove_episode（父层 requestConfirm 确认后走 applyEpisodeActions）。 */
  onRemoveEpisode?: (episode: EpisodeOutline) => void;
  /** 「让 AI 细化本卷集纲」→ sendAgentMessage（对话路径派发分集规划员）。 */
  onRefineEpisodes?: (phaseTitle: string) => void;
  /** 语义字段「让 AI 打磨」→ sendAgentMessage（预填当前值）。 */
  onPolishField?: (fieldLabel: string, value: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

export function PhaseBlock({
  phase,
  index,
  defaultOpen = false,
  sceneCount = 0,
  episodes = [],
  pulse = false,
  aiDisabled = false,
  outlineLocked = false,
  episodesLocked = false,
  onUpdate,
  onRemove,
  onUpdateEpisode,
  onAddEpisode,
  onRemoveEpisode,
  onRefineEpisodes,
  onPolishField,
  onDragStart,
  onDragOver,
  onDragEnd,
  t,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const titleRef = useRef<HTMLInputElement>(null);
  const chapters = phase.estimated_chapters ?? 0;

  // ── OE-2（批次 C）集纲最小编辑表单：本地草稿 + 500ms debounce →
  // applyEpisodeActions('update_episode') 投影（父层）→ updateField('episode_outlines')。
  // 作者主权：直写不走 chat；undo/持久化白拿 updateField（mirror OutlineEditor 自身模式）。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EpisodeDraft>(EMPTY_DRAFT);
  const episodeDirtyRef = useRef(false);
  const episodeDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // render 期同步最新编辑载荷（mirror OutlineEditor latestRef 模式），flush 时读它——
  // 避免 setState 闭包外的 stale draft 丢失末次输入。
  const episodeEditRef = useRef<{ id: string; patch: EpisodeUpdatePatch } | null>(null);
  episodeEditRef.current = editingId
    ? {
        id: editingId,
        // title 空串不进 patch（episodeOutlineSchema title.min(1)——空 = 不改，保留旧题；
        // 清空标题无合法存储态）。其余文本字段空串是合法值，照写。
        patch: {
          ...(draft.title.trim() ? { title: draft.title } : {}),
          purpose: draft.purpose,
          summary: draft.summary,
          core_event: draft.core_event,
          hook: draft.hook,
        },
      }
    : null;

  const flushEpisodeEdit = () => {
    if (!episodeDirtyRef.current) return;
    episodeDirtyRef.current = false;
    const entry = episodeEditRef.current;
    if (entry) onUpdateEpisode?.(entry.id, entry.patch);
  };
  const flushEpisodeRef = useRef(flushEpisodeEdit);
  flushEpisodeRef.current = flushEpisodeEdit;

  const cancelEpisodeTimer = () => {
    if (episodeDebounceRef.current) {
      clearTimeout(episodeDebounceRef.current);
      episodeDebounceRef.current = undefined;
    }
  };

  useEffect(() => () => {
    cancelEpisodeTimer();
    flushEpisodeRef.current();
  }, []);

  const openEpisodeEdit = (ep: EpisodeOutline) => {
    // 切换编辑对象前先冲刷上一个草稿的 pending 写。
    cancelEpisodeTimer();
    flushEpisodeRef.current();
    setEditingId(ep.id);
    setDraft({
      title: ep.title ?? '',
      purpose: ep.purpose ?? '',
      summary: ep.summary ?? '',
      core_event: ep.core_event ?? '',
      hook: ep.hook ?? '',
    });
    episodeDirtyRef.current = false;
  };

  const closeEpisodeEdit = () => {
    // 收起前冲刷 pending 写（editingId 置 null 后 episodeEditRef 变 null，晚到的 timer 会丢写）。
    cancelEpisodeTimer();
    flushEpisodeRef.current();
    setEditingId(null);
  };

  const handleEpisodeField = (key: keyof EpisodeDraft, value: string) => {
    episodeDirtyRef.current = true;
    setDraft((prev) =>
      key === 'title' ? { ...prev, title: value }
      : key === 'purpose' ? { ...prev, purpose: value }
      : key === 'summary' ? { ...prev, summary: value }
      : key === 'core_event' ? { ...prev, core_event: value }
      : { ...prev, hook: value }
    );
    cancelEpisodeTimer();
    episodeDebounceRef.current = setTimeout(() => flushEpisodeRef.current(), EPISODE_DEBOUNCE_MS);
  };

  /** 语义字段「让 AI 打磨」小钮（hover 显；机械字段不加——范式判据表单化）。
   *  CR-9：outline 锁定时禁用 + 锁因 tooltip（AI 产出走 outline_update 会被锁跳过）。 */
  const polishBtn = (label: string, value: string) =>
    onPolishField ? (
      <button
        type="button"
        className={`outline-ai-polish${outlineLocked ? ' is-locked' : ''}`}
        disabled={aiDisabled || outlineLocked}
        onClick={() => onPolishField(label, value)}
        title={outlineLocked ? t('outline.lockedAiHint') : t('outline.aiPolish')}
        aria-label={`${t('outline.aiPolish')}: ${label}`}
      >
        <span className="material-symbols-outlined">auto_awesome</span>
      </button>
    ) : null;

  const handleTitleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    titleRef.current?.focus();
  };

  return (
    <div
      id={`outline-anchor-phase-${phase.id}`}
      className={`outline-phase${open ? ' is-open' : ''}${pulse ? ' outline-pulse' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <div className="outline-phase-header" onClick={() => setOpen((v) => !v)}>
        <span className="outline-drag-handle material-symbols-outlined" onMouseDown={(e) => e.stopPropagation()}>
          drag_indicator
        </span>
        <span className="outline-phase-chevron material-symbols-outlined">
          chevron_right
        </span>
        <span className="outline-phase-index">{index + 1}</span>
        <input
          ref={titleRef}
          className="outline-phase-title"
          value={phase.title}
          onChange={(e) => onUpdate(phase.id, { title: e.target.value })}
          onClick={handleTitleClick}
          placeholder={t('outline.phaseTitle')}
        />
        {chapters > 0 && (
          <span className="outline-phase-chapters">
            <span className="material-symbols-outlined">menu_book</span>
            {chapters}
          </span>
        )}
        {sceneCount > 0 && (
          <span className="outline-phase-scenes" title={t('outline.actualScenes', { count: sceneCount })}>
            <span className="material-symbols-outlined">movie</span>
            {t('outline.actualScenes', { count: sceneCount })}
          </span>
        )}
      </div>

      {open && (
        <div className="outline-phase-body">
          <div className="outline-phase-property">
            <span className="outline-phase-property-label">{t('outline.phaseGoal')}</span>
            <input
              className="outline-phase-property-value"
              value={phase.goal ?? ''}
              onChange={(e) => onUpdate(phase.id, { goal: e.target.value })}
              placeholder="—"
            />
            {polishBtn(t('outline.phaseGoal'), phase.goal ?? '')}
          </div>
          <div className="outline-phase-property">
            <span className="outline-phase-property-label">{t('outline.phaseAntagonist')}</span>
            <input
              className="outline-phase-property-value"
              value={phase.antagonist ?? ''}
              onChange={(e) => onUpdate(phase.id, { antagonist: e.target.value })}
              placeholder="—"
            />
            {polishBtn(t('outline.phaseAntagonist'), phase.antagonist ?? '')}
          </div>
          <div className="outline-phase-property">
            <span className="outline-phase-property-label">{t('outline.phaseClimax')}</span>
            <input
              className="outline-phase-property-value"
              value={phase.climax ?? ''}
              onChange={(e) => onUpdate(phase.id, { climax: e.target.value })}
              placeholder="—"
            />
            {polishBtn(t('outline.phaseClimax'), phase.climax ?? '')}
          </div>
          <div className="outline-phase-property">
            <span className="outline-phase-property-label">{t('outline.phaseHook')}</span>
            <input
              className="outline-phase-property-value"
              value={phase.hook ?? ''}
              onChange={(e) => onUpdate(phase.id, { hook: e.target.value })}
              placeholder="—"
            />
            {polishBtn(t('outline.phaseHook'), phase.hook ?? '')}
          </div>
          <div className="outline-phase-property">
            <span className="outline-phase-property-label">{t('outline.estimatedChapters')}</span>
            <input
              className="outline-phase-property-value"
              type="number"
              min={0}
              value={phase.estimated_chapters ?? ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') { onUpdate(phase.id, { estimated_chapters: undefined }); return; }
                const n = Math.max(0, Math.floor(Number(raw)));
                onUpdate(phase.id, { estimated_chapters: Number.isFinite(n) ? n : undefined });
              }}
              placeholder="—"
            />
          </div>
          <div className="outline-phase-actions">
            <button type="button" className="outline-remove-action" onClick={() => onRemove(phase.id)}>
              <span className="material-symbols-outlined">delete</span>
              {t('outline.removePhase')}
            </button>
          </div>

          {/* ── OE-2（批次 C）本卷集纲：只读一行式 + 每集最小编辑表单 + AI 细化 CTA ──
              CR-27（dogfood R2）：补手动增/删手势（双通道铁律——AI 工具 episode_outlines_update
              已有 add/remove_episode，此处补手动通道，同一 applyEpisodeActions 投影器）。── */}
          {(episodes.length > 0 || onRefineEpisodes || onAddEpisode) && (
            <div className="outline-ep-sub">
              {episodes.length > 0 ? (
                <>
                  <div className="outline-ep-header">
                    <span>{t('outline.phaseEpisodes')}</span>
                    <span className="outline-ep-count">{t('outline.episodeCount', { count: episodes.length })}</span>
                    {onAddEpisode && (
                      <button
                        type="button"
                        className="outline-ep-add"
                        disabled={episodesLocked}
                        onClick={() => onAddEpisode(phase.id)}
                        title={episodesLocked ? t('outline.episodesLockedHint') : t('outline.addEpisode')}
                      >
                        <span className="material-symbols-outlined">add</span>
                        {t('outline.addEpisode')}
                      </button>
                    )}
                  </div>
                  <div className="outline-ep-list">
                    {episodes.map((ep) => (
                      <div key={ep.id}>
                        <div className="outline-ep-item">
                          {/* CR-22：index 缺失兜底 0（排序侧 (a.index||0) 有守卫、显示侧此前没有 → ENaN）。 */}
                          <span className="outline-ep-id">E{(ep.index ?? 0) + 1}</span>
                          <span className="outline-ep-title">{ep.title}</span>
                          {(ep.purpose || ep.summary) && (
                            <span className="outline-ep-desc">{ep.purpose || ep.summary}</span>
                          )}
                          {onUpdateEpisode && (
                            <button
                              type="button"
                              className="outline-ep-edit"
                              disabled={episodesLocked}
                              onClick={() => (editingId === ep.id ? closeEpisodeEdit() : openEpisodeEdit(ep))}
                              title={episodesLocked ? t('outline.episodesLockedHint') : t('outline.editEpisode')}
                            >
                              {editingId === ep.id ? t('outline.episodeFormClose') : t('outline.editEpisode')}
                            </button>
                          )}
                          {onRemoveEpisode && (
                            <button
                              type="button"
                              className="outline-ep-remove"
                              disabled={episodesLocked}
                              onClick={() => onRemoveEpisode(ep)}
                              title={episodesLocked ? t('outline.episodesLockedHint') : t('outline.removeEpisode')}
                              aria-label={t('outline.removeEpisode')}
                            >
                              <span className="material-symbols-outlined">close</span>
                            </button>
                          )}
                        </div>
                        {editingId === ep.id && (
                          <div className="outline-ep-form">
                            <div className="outline-ep-form-row">
                              <label className="outline-ep-form-label">{t('outline.episodeTitle')}</label>
                              <input
                                className="outline-ep-form-input"
                                value={draft.title}
                                onChange={(e) => handleEpisodeField('title', e.target.value)}
                                placeholder={t('outline.turningPointPlaceholder')}
                              />
                            </div>
                            <div className="outline-ep-form-row">
                              <label className="outline-ep-form-label">{t('outline.episodePurpose')}</label>
                              <textarea
                                className="outline-ep-form-input"
                                rows={2}
                                value={draft.purpose}
                                onChange={(e) => handleEpisodeField('purpose', e.target.value)}
                              />
                            </div>
                            <div className="outline-ep-form-row">
                              <label className="outline-ep-form-label">{t('outline.episodeSummary')}</label>
                              <textarea
                                className="outline-ep-form-input"
                                rows={2}
                                value={draft.summary}
                                onChange={(e) => handleEpisodeField('summary', e.target.value)}
                              />
                            </div>
                            <div className="outline-ep-form-row">
                              <label className="outline-ep-form-label">{t('outline.episodeCoreEvent')}</label>
                              <textarea
                                className="outline-ep-form-input"
                                rows={2}
                                value={draft.core_event}
                                onChange={(e) => handleEpisodeField('core_event', e.target.value)}
                              />
                            </div>
                            <div className="outline-ep-form-row">
                              <label className="outline-ep-form-label">{t('outline.episodeHook')}</label>
                              <input
                                className="outline-ep-form-input"
                                value={draft.hook}
                                onChange={(e) => handleEpisodeField('hook', e.target.value)}
                              />
                            </div>
                            <button type="button" className="outline-ep-form-close" onClick={closeEpisodeEdit}>
                              {t('outline.episodeFormClose')}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <span className="outline-ep-empty">{t('outline.episodesEmpty')}</span>
              )}
              {onAddEpisode && episodes.length === 0 && (
                <button
                  type="button"
                  className="outline-ep-add"
                  disabled={episodesLocked}
                  onClick={() => onAddEpisode(phase.id)}
                  title={episodesLocked ? t('outline.episodesLockedHint') : t('outline.addEpisode')}
                >
                  <span className="material-symbols-outlined">add</span>
                  {t('outline.addEpisode')}
                </button>
              )}
              {onRefineEpisodes && (
                <button
                  type="button"
                  className="outline-ep-refine"
                  disabled={aiDisabled || episodesLocked}
                  onClick={() => onRefineEpisodes(phase.title)}
                  title={episodesLocked ? t('outline.episodesLockedHint') : undefined}
                >
                  <span className="material-symbols-outlined">auto_awesome</span>
                  {t('outline.refineEpisodes')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
