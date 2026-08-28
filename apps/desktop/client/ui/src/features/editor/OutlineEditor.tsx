import { useState, useEffect, useRef, useCallback } from 'react';
import type { z } from 'zod';
import type { outlineV2Schema, outlinePhaseSchema, majorTurningPointSchema, fieldMetadataSchema, EpisodeOutline } from '@orison/shared-contracts';
import { TiptapEditor } from './TiptapEditor';
import { PhaseBlock } from './PhaseBlock';
import { OutlineToggle } from './OutlineToggle';
import {
  countPhaseScenes,
  episodesForPhase,
  projectEpisodeUpdate,
  projectEpisodeAdd,
  projectEpisodeRemove,
  anchorScenesForTurningPoints,
  recordActivePhase,
  getRecordedActivePhase,
  latestChangedPhaseId,
  latestChangedEpisodePhase,
  type EpisodeUpdatePatch,
} from './outlinePanelModel';
import { isProjectRunActive } from '../../shared/store/agentSessionSlice';
import { useConfirmStore } from '../../shared/store/confirmStore';
import { Skeleton } from '../../shared/components/Skeleton';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { randomUUID } from '../../shared/util/id';

type OutlineV2 = z.infer<typeof outlineV2Schema>;
type OutlinePhase = z.infer<typeof outlinePhaseSchema>;
type MajorTurningPoint = z.infer<typeof majorTurningPointSchema>;
type TurningPointType = MajorTurningPoint['type'];
type FieldMetadata = z.infer<typeof fieldMetadataSchema>;

const TURNING_POINT_TYPES: TurningPointType[] = ['core-anchor', 'secondary-anchor', 'fork-point'];

// The constraints list persists as string[] in the outline schema, but the UI
// needs a stable key per row: index-based keys make React reuse the wrong DOM
// node during drag-reorder, stealing input focus/values. So the internal working
// model carries a stable id and we serialize to/from string[] only at the store
// boundary. Turning points (Story 1.2) carry typed {type,label,description?}
// and likewise need a stable id; empty-label rows are dropped on serialize to
// satisfy label.min(1).
type KeyedItem = { id: string; text: string };
const toKeyed = (list: string[]): KeyedItem[] => list.map((text) => ({ id: randomUUID(), text }));
const toStrings = (list: KeyedItem[]): string[] => list.map((it) => it.text);

type KeyedTurningPoint = { id: string; type: TurningPointType; label: string; description: string };
const toKeyedTurningPoints = (list: MajorTurningPoint[] | undefined): KeyedTurningPoint[] =>
  (list ?? []).map((tp) => ({
    id: randomUUID(),
    type: tp.type,
    label: tp.label,
    description: tp.description ?? ''
  }));
const toTurningPoints = (list: KeyedTurningPoint[]): MajorTurningPoint[] =>
  list
    .filter((tp) => tp.label.trim() !== '')
    .map((tp) => ({
      type: tp.type,
      label: tp.label,
      ...(tp.description.trim() ? { description: tp.description } : {})
    }));

const DEBOUNCE_MS = 500;

/** OE-1（批次 C）：fieldMetadata.source → i18n 键（「上次修改」来源显示）。 */
const SOURCE_LABEL_KEYS: Record<FieldMetadata['source'], string> = {
  user: 'creative.field.sourceUser',
  agent: 'creative.field.sourceAgent',
  imported: 'creative.field.sourceImported',
  sync: 'creative.field.sourceSync',
};

/** OE-3（批次 C）：>3 卷才出左侧 sticky 导航。 */
const NAV_MIN_PHASES = 3;
/** OE-3（批次 C）：导航命中后的高亮时长（CSS animation 同步 2s）。 */
const NAV_PULSE_MS = 2000;

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function useDragReorder<T>(items: T[], setItems: (items: T[]) => void, onEdit: () => void) {
  const dragIdx = useRef<number | null>(null);

  const onDragStart = (i: number) => (e: React.DragEvent) => {
    dragIdx.current = i;
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === i) return;
    const next = [...items];
    const [moved] = next.splice(dragIdx.current, 1);
    next.splice(i, 0, moved);
    dragIdx.current = i;
    onEdit();
    setItems(next);
  };

  const onDragEnd = () => { dragIdx.current = null; };

  return { onDragStart, onDragOver, onDragEnd };
}

export function OutlineEditor() {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const storeOutline = useAppStore((s) => s.creativeFields.outline) as OutlineV2 | undefined;
  const projectDocumentHydrated = useAppStore((s) => s.projectDocumentHydrated);
  const updateField = useAppStore((s) => s.updateField);
  // Story 3.1 WP5: field-lock UI for the outline. Locking prevents agent patches
  // from overwriting the author's outline (locked fields are skipped + surfaced).
  const outlineLocked = useAppStore((s) => s.fieldMetadata.outline?.locked ?? false);
  const toggleFieldLock = useAppStore((s) => s.toggleFieldLock);
  // ── OE-1（批次 C）状态条数据：version/source/stale 全在 fieldMetadata，
  // undo/redo 接既有 fieldUndoStack 通道（canUndoField/canRedoField 禁用态）。──
  const outlineMeta = useAppStore((s) => s.fieldMetadata.outline);
  const undoField = useAppStore((s) => s.undoField);
  const redoField = useAppStore((s) => s.redoField);
  const canUndo = useAppStore((s) => s.canUndoField());
  const canRedo = useAppStore((s) => s.canRedoField());
  // ── OE-2（批次 C）跨字段只读消费：scene_graph 数「实际 N 场」、episode_outlines 挂卷内集纲。
  // 本面板不写这两个字段的结构（集纲编辑只经 applyEpisodeActions 投影 updateField）。──
  const sceneGraph = useAppStore((s) => s.creativeFields.scene_graph);
  const episodeOutlines = useAppStore((s) => s.creativeFields.episode_outlines);
  // ── CR-9（dogfood R2）：AI 打磨/细化入口的字段锁。锁语义 mirror 状态条（Story 3.1 WP5：
  // locked 字段的 agent patch 被跳过 + 透出）——AI 产出入锁定字段 = 整轮 agent 白烧，
  // 入口提前禁用 + 锁因 tooltip。人解锁后仍可自由直写（作者主权；锁约束的是 AI 侧）。──
  const episodesLocked = useAppStore((s) => s.fieldMetadata.episode_outlines?.locked ?? false);
  // ── CR-26（OE-4）：转折点 chip 跳时间线——复用现有 one-shot 聚焦通道 focusIssueTargets
  //（NarrativeTimelinePanel 消费：selectedNodeId + scrollIntoView）+ setActivePage 切页，
  // mirror PatchReviewIssues「在时间线修复」双动作先例，零新 store 键。──
  const setActivePage = useAppStore((s) => s.setActivePage);
  const setFocusIssueTargets = useAppStore((s) => s.setFocusIssueTargets);
  // 语义建议入口（让 AI 打磨 / 细化集纲）→ 对话路径派发；运行中禁用防点击假死。
  const sendAgentMessage = useAppStore((s) => s.sendAgentMessage);
  const aiDisabled = useAppStore((s) => isProjectRunActive(s));
  // ── OE-5（批次 D）one-shot 跳转定位通道：PatchReviewPanel 接受落盘后 toast「到大纲面板
  // 查看」写入（mirror focusIssueTargets / FileRevealRequest 双先例），本面板消费后清空。──
  const outlineFocusTarget = useAppStore((s) => s.outlineFocusTarget);
  const clearOutlineFocusTarget = useAppStore((s) => s.clearOutlineFocusTarget);

  // ── OE-3（批次 C）卷锚点导航：scrollIntoView + 2s 短暂高亮。──
  const [pulseTarget, setPulseTarget] = useState<string | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
  }, []);

  // ── CR-29（OE-3）：「活跃 = 最近 agent/user 编辑过的 phase，无记录则首卷」。记录本体在
  // outlinePanelModel 模块级（本组件页切换即卸载，本地 state 活不过重挂；defaultOpen 恰恰
  // 要在下次挂载时生效）；此处持镜像 state 驱动渲染。baseline ref 用于「外部变更 diff」——
  // 首次 hydration（baseline 尚无）不算编辑记录，回退首卷。──
  const [activePhaseId, setActivePhaseId] = useState<string | null>(getRecordedActivePhase());
  const trackActivePhase = useCallback((id: string) => {
    recordActivePhase(id);
    setActivePhaseId(id);
  }, []);
  const appliedOutlineRef = useRef<OutlineV2 | undefined>(undefined);
  const appliedEpisodesRef = useRef<unknown>(undefined);

  const [storyType, setStoryType] = useState('');
  const [writingStyle, setWritingStyle] = useState('');
  const [mainGoal, setMainGoal] = useState('');
  const [centralConflict, setCentralConflict] = useState('');
  const [endingDirection, setEndingDirection] = useState('');
  const [phases, setPhases] = useState<OutlinePhase[]>([]);
  const [characters, setCharacters] = useState('');
  // Story 8.5（design §7 D3）：outline_v2 假字段重命名——growth_curve→arc_design_notes /
  // pacing_curve_text→pacing_design_notes。这两个是自由草稿位（Tiptap 自由文本），与顶层结构化
  // creative field growth_curve/pacing_curve（真曲线）同名不同物，改名消歧。
  const [arcDesignNotes, setArcDesignNotes] = useState('');
  const [pacingDesignNotes, setPacingDesignNotes] = useState('');
  const [turningPoints, setTurningPoints] = useState<KeyedTurningPoint[]>([]);
  const [constraints, setConstraints] = useState<KeyedItem[]>([]);

  const userEditedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastWrittenRef = useRef<OutlineV2 | undefined>(undefined);

  const buildOutline = (): OutlineV2 => ({
    story_type: storyType || undefined,
    writing_style: writingStyle || undefined,
    main_goal: mainGoal || undefined,
    central_conflict: centralConflict || undefined,
    ending_direction: endingDirection || undefined,
    phases,
    characters: characters || undefined,
    arc_design_notes: arcDesignNotes || undefined,
    pacing_design_notes: pacingDesignNotes || undefined,
    major_turning_points: toTurningPoints(turningPoints),
    constraints: toStrings(constraints),
  });
  const latestRef = useRef<OutlineV2>(buildOutline());
  latestRef.current = buildOutline();

  const flush = () => {
    if (!userEditedRef.current || !projectDocumentHydrated) return;
    const next = latestRef.current;
    lastWrittenRef.current = next;
    userEditedRef.current = false;
    updateField('outline', next);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (storeOutline && storeOutline === lastWrittenRef.current) return;
    userEditedRef.current = false;
    if (!storeOutline) return;
    // CR-29：外部变更（agent patch 落盘 / undo / redo / 文件同步）→ diff 出被改卷记为活跃。
    // 自己的 flush 回声已被上方 lastWrittenRef 早退挡掉（用户路径在 updatePhase 侧就地记录）。
    if (appliedOutlineRef.current) {
      const changed = latestChangedPhaseId(appliedOutlineRef.current.phases, storeOutline.phases);
      if (changed) trackActivePhase(changed);
    }
    appliedOutlineRef.current = storeOutline;
    setStoryType(storeOutline.story_type ?? '');
    setWritingStyle(storeOutline.writing_style ?? '');
    setMainGoal(storeOutline.main_goal ?? '');
    setCentralConflict(storeOutline.central_conflict ?? '');
    setEndingDirection(storeOutline.ending_direction ?? '');
    setPhases(storeOutline.phases ?? []);
    setCharacters(storeOutline.characters ?? '');
    setArcDesignNotes(storeOutline.arc_design_notes ?? '');
    setPacingDesignNotes(storeOutline.pacing_design_notes ?? '');
    setTurningPoints(toKeyedTurningPoints(storeOutline.major_turning_points));
    setConstraints(toKeyed(storeOutline.constraints ?? []));
  }, [storeOutline, trackActivePhase]);

  // CR-29：episode_outlines 外部变更（agent 落盘 / undo / redo）→ 被改集所在卷记为活跃。
  // 用户编辑表单的写入经 updateField 回声同走此 diff，一条机制覆盖双通道。
  useEffect(() => {
    if (appliedEpisodesRef.current !== undefined) {
      const phase = latestChangedEpisodePhase(appliedEpisodesRef.current, episodeOutlines);
      if (phase) trackActivePhase(phase);
    }
    appliedEpisodesRef.current = episodeOutlines;
  }, [episodeOutlines, trackActivePhase]);

  const markEdited = () => {
    userEditedRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => flushRef.current(), DEBOUNCE_MS);
  };

  useEffect(() => () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
    flushRef.current();
  }, []);

  if (!projectDocumentHydrated) return <Skeleton />;

  const addPhase = () => {
    markEdited();
    setPhases([...phases, { id: genId(), title: t('outline.newPhase') }]);
  };

  const updatePhase = (id: string, patch: Partial<OutlinePhase>) => {
    markEdited();
    trackActivePhase(id); // CR-29：用户编辑的卷 = 活跃卷
    setPhases(phases.map((p) => p.id === id ? { ...p, ...patch } : p));
  };

  const removePhase = (id: string) => {
    markEdited();
    setPhases(phases.filter((p) => p.id !== id));
  };

  const addTurningPoint = () => { markEdited(); setTurningPoints([...turningPoints, { id: randomUUID(), type: 'core-anchor', label: '', description: '' }]); };
  const updateTurningPoint = (i: number, patch: Partial<KeyedTurningPoint>) => { markEdited(); setTurningPoints(turningPoints.map((tp, idx) => idx === i ? { ...tp, ...patch } : tp)); };
  const removeTurningPoint = (i: number) => { markEdited(); setTurningPoints(turningPoints.filter((_, idx) => idx !== i)); };

  const addConstraint = () => { markEdited(); setConstraints([...constraints, { id: randomUUID(), text: '' }]); };
  const updateConstraint = (i: number, v: string) => { markEdited(); setConstraints(constraints.map((c, idx) => idx === i ? { ...c, text: v } : c)); };
  const removeConstraint = (i: number) => { markEdited(); setConstraints(constraints.filter((_, idx) => idx !== i)); };

  // ── OE-2（批次 C）集纲写通道：applyEpisodeActions('update_episode') 投影（与 agent
  // episode_outlines_update 工具同一投影器）→ updateField('episode_outlines')——作者主权直写，
  // 不走 chat；undo/持久化白拿。getState 取最新值避免闭包 stale。
  // CR-15：current 真畸形非数组时投影器返回 null → no-op（不覆写在库数据；null/undefined
  // 容忍 coerce 成 []，是「字段尚未建」的合法首写路径）。──
  const handleUpdateEpisode = useCallback((episodeId: string, patch: EpisodeUpdatePatch) => {
    const current = useAppStore.getState().creativeFields.episode_outlines;
    const next = projectEpisodeUpdate(current, episodeId, patch);
    if (next === null) return;
    updateField('episode_outlines', next);
  }, [updateField]);

  // ── CR-27（dogfood R2 批次 C 补完）：集纲手动增/删（双通道铁律——与 AI 工具同走
  // applyEpisodeActions 投影器）。删除走全局 requestConfirm 确认（mirror 场景删除先例）；
  // 确认是异步的，await 后重读 current 防中途变更。──
  const handleAddEpisode = useCallback((phaseId: string) => {
    const current = useAppStore.getState().creativeFields.episode_outlines;
    const next = projectEpisodeAdd(current, phaseId, t('outline.newEpisodeTitle'));
    if (next === null) return;
    updateField('episode_outlines', next);
  }, [updateField, t]);

  const handleRemoveEpisode = useCallback(async (episode: EpisodeOutline) => {
    const confirmed = await useConfirmStore.getState().requestConfirm({
      title: t('outline.removeEpisodeConfirmTitle'),
      message: t('outline.removeEpisodeConfirm', { title: episode.title }),
      variant: 'danger',
      confirmLabel: t('outline.removeEpisode'),
    });
    if (!confirmed) return;
    const current = useAppStore.getState().creativeFields.episode_outlines;
    const next = projectEpisodeRemove(current, episode.id);
    if (next === null) return;
    updateField('episode_outlines', next);
  }, [updateField, t]);

  // ── OE-2（批次 C）AI 细化本卷集纲：对话路径派发分集规划员（保持既有集已敲定事件不变）。──
  const handleRefineEpisodes = useCallback((phaseTitle: string) => {
    void sendAgentMessage(t('outline.refineEpisodesMessage', { phase: phaseTitle }));
  }, [sendAgentMessage, t]);

  // ── OE-2.3（批次 C）语义字段「让 AI 打磨」：预填字段名 + 当前值，AI 产出走 outline_update
  // 落盘（patch 审查把关）；建议入口是加速器不是门卫——人仍可直写。──
  const handlePolishField = useCallback((fieldLabel: string, value: string) => {
    void sendAgentMessage(t('outline.polishFieldMessage', { field: fieldLabel, value }));
  }, [sendAgentMessage, t]);

  // ── CR-26（OE-4）转折点关联跳转：已挂场景 chip → 切 structure 页 + one-shot 聚焦该场景
  //（focusIssueTargets 消费端顺带开 validation overlay——复用现有通道的既有副作用，可接受）；
  // 未挂 ghost「到时间线挂」→ 仅切页（挂载动作 = 时间线右键改 role，SP-1 已给）。──
  const jumpToScene = useCallback((sceneId: string) => {
    setFocusIssueTargets([{ kind: 'node', id: sceneId }]);
    setActivePage('structure');
  }, [setFocusIssueTargets, setActivePage]);

  const jumpToTimeline = useCallback(() => {
    setActivePage('structure');
  }, [setActivePage]);

  // ── OE-3（批次 C）导航命中：滚动 + 2s 高亮。──
  const scrollToAnchor = useCallback((key: string) => {
    document.getElementById(`outline-anchor-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPulseTarget(key);
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = setTimeout(() => setPulseTarget(null), NAV_PULSE_MS);
  }, []);

  // ── OE-5（批次 D）跳转定位通道消费：one-shot outlineFocusTarget → 复用 OE-3
  // scrollToAnchor（scrollIntoView + 2s pulse）→ clear。**clear-on-success 而非进 effect
  // 即清**：本面板初挂载时本地 phases 尚空（storeOutline 同步 effect 先跑但 setState 要
  // 下一轮渲染才可见——「数据已到、DOM 未到」窗口立即清会丢跳转），phase 目标等目标卷卡
  // 渲染出来才消费；store 数据已到而 id 仍不在（目标被并发编辑删掉）→ 丢弃清空防死等。
  // StrictMode 双跑 = 同锚点重复滚动 + pulse 重置 + 幂等 clear，无害（mirror NTP
  // focusIssueTargets 消费先例 NarrativeTimelinePanel.tsx:231-245 的「定位后清空」模式）。──
  useEffect(() => {
    if (!outlineFocusTarget) return;
    if (outlineFocusTarget.section === 'phase') {
      if (!outlineFocusTarget.id) {
        clearOutlineFocusTarget(); // 防御：phase 目标缺 id 无从定位，直接清
        return;
      }
      if (!phases.some((p) => p.id === outlineFocusTarget.id)) {
        const storePhases = storeOutline?.phases ?? [];
        if (!storePhases.some((p) => p.id === outlineFocusTarget.id)) {
          clearOutlineFocusTarget();
        }
        return; // 数据未同步到本地态 → 等 phases 依赖重试
      }
      scrollToAnchor(`phase-${outlineFocusTarget.id}`);
    } else {
      scrollToAnchor(outlineFocusTarget.section === 'turningPoints' ? 'turning-points' : 'core');
    }
    clearOutlineFocusTarget();
  }, [outlineFocusTarget, phases, storeOutline, scrollToAnchor, clearOutlineFocusTarget]);

  const phaseDrag = useDragReorder(phases, setPhases, markEdited);
  const tpDrag = useDragReorder(turningPoints, setTurningPoints, markEdited);
  const cDrag = useDragReorder(constraints, setConstraints, markEdited);

  // ── OE-3（批次 C）规模化：>3 卷出左侧 sticky 卷锚点导航；否则维持原单列流。──
  const showNav = phases.length > NAV_MIN_PHASES;

  // ── CR-29（OE-3）：活跃卷归一化——记录指向已删除/异项目卷时回退首卷兜底。──
  const effectiveActivePhaseId = activePhaseId && phases.some((p) => p.id === activePhaseId)
    ? activePhaseId
    : null;

  // ── CR-26（OE-4）：转折点 ↔ 锚点场景配对（确定性：同类第 n 个配第 n 个；fork-point 不参与）。──
  const tpAnchors = anchorScenesForTurningPoints(turningPoints.map((tp) => tp.type), sceneGraph);

  const content = (
    <>
      {/* ── OE-1（批次 C）字段状态条：锁 · v{version} · 上次修改来源 · 撤销/重做 · stale 徽章 ──
          Story 3.1 WP5: A locked outline rejects agent patches (skipped + surfaced)
          and user edits throw at the persistence layer. */}
      <div className="outline-field-toolbar">
        <button
          type="button"
          className={`outline-lock-btn${outlineLocked ? ' is-locked' : ''}`}
          onClick={() => toggleFieldLock('outline')}
          title={t(outlineLocked ? 'creative.field.unlock' : 'creative.field.lock')}
          aria-label={t(outlineLocked ? 'creative.field.unlock' : 'creative.field.lock')}
          aria-pressed={outlineLocked}
        >
          <span className="material-symbols-outlined">{outlineLocked ? 'lock' : 'lock_open'}</span>
          <span className="outline-lock-label">{t(outlineLocked ? 'creative.field.locked' : 'creative.field.unlocked')}</span>
        </button>
        {outlineMeta && (
          <>
            <span className="outline-status-version">{t('creative.field.version', { v: outlineMeta.version })}</span>
            <span className="outline-status-source">
              {t('creative.field.lastModified', { source: t(SOURCE_LABEL_KEYS[outlineMeta.source] ?? 'creative.field.sourceUser') })}
            </span>
          </>
        )}
        <span className="outline-status-actions">
          <button
            type="button"
            className="outline-status-btn"
            onClick={() => undoField()}
            disabled={!canUndo}
            title={t('creative.field.undo')}
            aria-label={t('creative.field.undo')}
          >
            <span className="material-symbols-outlined">undo</span>
          </button>
          <button
            type="button"
            className="outline-status-btn"
            onClick={() => redoField()}
            disabled={!canRedo}
            title={t('creative.field.redo')}
            aria-label={t('creative.field.redo')}
          >
            <span className="material-symbols-outlined">redo</span>
          </button>
        </span>
        {outlineMeta?.stale && (
          <span className="outline-stale-badge" role="status">
            <span className="material-symbols-outlined">warning</span>
            {t('creative.field.stale')}
          </span>
        )}
      </div>
      {/* ── Story Core ── */}
      {/* OE-5（批次 D）：core 区锚点 + pulse（outlineFocusTarget {section:'core'} 的落点——
          PatchReviewPanel 落盘无新增卷时的回退焦点）。 */}
      <section
        id="outline-anchor-core"
        className={`outline-core${pulseTarget === 'core' ? ' outline-pulse' : ''}`}
      >
        <h2 className="outline-heading">{t('outline.storyCore')}</h2>

        <div className="outline-tag-row">
          <span className="outline-tag-label">{t('outline.storyType')}</span>
          <input className="outline-tag-input" value={storyType} onChange={(e) => { markEdited(); setStoryType(e.target.value); }} placeholder={t('outline.storyTypePlaceholder')} />
          <span className="outline-tag-label">{t('outline.writingStyle')}</span>
          <input className="outline-tag-input" value={writingStyle} onChange={(e) => { markEdited(); setWritingStyle(e.target.value); }} placeholder={t('outline.writingStylePlaceholder')} />
        </div>

        <div className="outline-core-field">
          <div className="outline-core-label-row">
            <label className="outline-core-label">{t('outline.centralConflict')}</label>
            <button
              type="button"
              className={`outline-ai-polish${outlineLocked ? ' is-locked' : ''}`}
              disabled={aiDisabled || outlineLocked}
              onClick={() => handlePolishField(t('outline.centralConflict'), centralConflict)}
              title={outlineLocked ? t('outline.lockedAiHint') : t('outline.aiPolish')}
              aria-label={`${t('outline.aiPolish')}: ${t('outline.centralConflict')}`}
            >
              <span className="material-symbols-outlined">auto_awesome</span>
            </button>
          </div>
          <textarea className="outline-input outline-core-textarea" value={centralConflict} onChange={(e) => { markEdited(); setCentralConflict(e.target.value); }} placeholder={t('outline.centralConflictPlaceholder')} rows={2} />
        </div>

        <div className="outline-core-field">
          <div className="outline-core-label-row">
            <label className="outline-core-label">{t('outline.mainGoal')}</label>
            <button
              type="button"
              className={`outline-ai-polish${outlineLocked ? ' is-locked' : ''}`}
              disabled={aiDisabled || outlineLocked}
              onClick={() => handlePolishField(t('outline.mainGoal'), mainGoal)}
              title={outlineLocked ? t('outline.lockedAiHint') : t('outline.aiPolish')}
              aria-label={`${t('outline.aiPolish')}: ${t('outline.mainGoal')}`}
            >
              <span className="material-symbols-outlined">auto_awesome</span>
            </button>
          </div>
          <textarea className="outline-input outline-core-textarea" value={mainGoal} onChange={(e) => { markEdited(); setMainGoal(e.target.value); }} placeholder={t('outline.mainGoalPlaceholder')} rows={2} />
        </div>

        <div className="outline-core-field">
          <div className="outline-core-label-row">
            <label className="outline-core-label">{t('outline.endingDirection')}</label>
            <button
              type="button"
              className={`outline-ai-polish${outlineLocked ? ' is-locked' : ''}`}
              disabled={aiDisabled || outlineLocked}
              onClick={() => handlePolishField(t('outline.endingDirection'), endingDirection)}
              title={outlineLocked ? t('outline.lockedAiHint') : t('outline.aiPolish')}
              aria-label={`${t('outline.aiPolish')}: ${t('outline.endingDirection')}`}
            >
              <span className="material-symbols-outlined">auto_awesome</span>
            </button>
          </div>
          <textarea className="outline-input outline-core-textarea" value={endingDirection} onChange={(e) => { markEdited(); setEndingDirection(e.target.value); }} placeholder={t('outline.endingDirectionPlaceholder')} rows={2} />
        </div>
      </section>

      <hr className="outline-divider" />

      {/* ── Phases ── */}
      <section className="outline-phases">
        <div className="outline-phases-header">
          <h2 className="outline-heading">{t('outline.phases')}</h2>
        </div>

        {phases.map((phase, i) => (
          <PhaseBlock
            key={phase.id}
            phase={phase}
            index={i}
            /* OE-3 / CR-29：活跃卷（最近 agent/user 编辑过）默认展开，无记录则首卷兜底 */
            defaultOpen={effectiveActivePhaseId ? phase.id === effectiveActivePhaseId : i === 0}
            sceneCount={countPhaseScenes(sceneGraph, phase.id)}
            episodes={episodesForPhase(episodeOutlines, phase.id)}
            pulse={pulseTarget === `phase-${phase.id}`}
            aiDisabled={aiDisabled}
            outlineLocked={outlineLocked}
            episodesLocked={episodesLocked}
            onUpdate={updatePhase}
            onRemove={removePhase}
            onUpdateEpisode={handleUpdateEpisode}
            onAddEpisode={handleAddEpisode}
            onRemoveEpisode={handleRemoveEpisode}
            onRefineEpisodes={handleRefineEpisodes}
            onPolishField={handlePolishField}
            onDragStart={phaseDrag.onDragStart(i)}
            onDragOver={phaseDrag.onDragOver(i)}
            onDragEnd={phaseDrag.onDragEnd}
            t={t}
          />
        ))}

        <button type="button" className="outline-add-block" onClick={addPhase}>
          <span className="material-symbols-outlined">add</span>
          {t('outline.addPhase')}
        </button>
      </section>

      <hr className="outline-divider" />

      {/* ── Auxiliary ── */}
      <section
        id="outline-anchor-notes"
        className={`outline-auxiliary${pulseTarget === 'notes' ? ' outline-pulse' : ''}`}
      >
        <h2 className="outline-heading">{t('outline.auxiliary')}</h2>
        {/* 08-26 用户拍板：显性化草稿位边界——此处是速记，正式设定资产（进检索 + 喂给
            写手）走设定卡（asset_cards），防双真相源误解。 */}
        <p className="outline-auxiliary-hint">{t('outline.auxiliaryHint')}</p>

        <OutlineToggle title={t('outline.characters')}>
          <TiptapEditor content={characters} placeholder={t('outline.charactersPlaceholder')} onChange={(v) => { markEdited(); setCharacters(v); }} format="markdown" />
        </OutlineToggle>

        <OutlineToggle title={t('outline.arcDesignNotes')}>
          <TiptapEditor content={arcDesignNotes} placeholder={t('outline.arcDesignNotesPlaceholder')} onChange={(v) => { markEdited(); setArcDesignNotes(v); }} format="markdown" />
        </OutlineToggle>

        <OutlineToggle title={t('outline.pacingDesignNotes')}>
          <TiptapEditor content={pacingDesignNotes} placeholder={t('outline.pacingDesignNotesPlaceholder')} onChange={(v) => { markEdited(); setPacingDesignNotes(v); }} format="markdown" />
        </OutlineToggle>

        <div
          id="outline-anchor-turning-points"
          className={pulseTarget === 'turning-points' ? 'outline-pulse' : undefined}
        >
          <OutlineToggle title={t('outline.turningPoints')} onAdd={addTurningPoint}>
          <div className="outline-list">
            {turningPoints.map((tp, i) => {
              const anchor = tpAnchors[i];
              return (
              <div key={tp.id} className="outline-list-item outline-turning-point" draggable onDragStart={tpDrag.onDragStart(i)} onDragOver={tpDrag.onDragOver(i)} onDragEnd={tpDrag.onDragEnd}>
                <span className="outline-list-drag material-symbols-outlined">drag_indicator</span>
                <select
                  className="outline-turning-point-type"
                  value={tp.type}
                  onChange={(e) => updateTurningPoint(i, { type: e.target.value as TurningPointType })}
                  aria-label={t('outline.turningPointType')}
                >
                  {TURNING_POINT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type === 'core-anchor' && t('outline.turningPointTypeCore')}
                      {type === 'secondary-anchor' && t('outline.turningPointTypeSecondary')}
                      {type === 'fork-point' && t('outline.turningPointTypeFork')}
                    </option>
                  ))}
                </select>
                <input className="outline-list-input" value={tp.label} onChange={(e) => updateTurningPoint(i, { label: e.target.value })} placeholder={t('outline.turningPointPlaceholder')} />
                <input className="outline-list-input outline-turning-point-desc" value={tp.description} onChange={(e) => updateTurningPoint(i, { description: e.target.value })} placeholder={t('outline.turningPointDescriptionPlaceholder')} />
                {/* ── CR-26（OE-4）转折点关联：已挂场景 chip（点击跳时间线定位）/ 未挂 ghost
                    （到时间线挂）；fork-point 不关联场景（IF 分叉语义）。── */}
                {anchor ? (
                  <button
                    type="button"
                    className="outline-tp-anchor-chip"
                    onClick={() => jumpToScene(anchor.id)}
                    title={t('outline.tpAnchorChipTitle', { id: anchor.id })}
                  >
                    <span className="material-symbols-outlined">near_me</span>
                    {t('outline.tpAnchorChip', { id: anchor.title ?? anchor.id })}
                  </button>
                ) : tp.type !== 'fork-point' ? (
                  <span className="outline-tp-anchor-ghost" title={t('outline.tpGoTimelineTitle')}>
                    <span className="outline-tp-anchor-ghost-label">{t('outline.tpUnanchored')}</span>
                    <button type="button" className="outline-tp-go-timeline" onClick={jumpToTimeline}>
                      {t('outline.tpGoTimeline')}
                    </button>
                  </span>
                ) : null}
                <button type="button" className="outline-list-remove" onClick={() => removeTurningPoint(i)}>
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              );
            })}
          </div>
          </OutlineToggle>
        </div>

        <OutlineToggle title={t('outline.constraints')} onAdd={addConstraint}>
          <div className="outline-list">
            {constraints.map((c, i) => (
              <div key={c.id} className="outline-list-item" draggable onDragStart={cDrag.onDragStart(i)} onDragOver={cDrag.onDragOver(i)} onDragEnd={cDrag.onDragEnd}>
                <span className="outline-list-drag material-symbols-outlined">drag_indicator</span>
                <input className="outline-list-input" value={c.text} onChange={(e) => updateConstraint(i, e.target.value)} placeholder={t('outline.constraintPlaceholder')} />
                <button type="button" className="outline-list-remove" onClick={() => removeConstraint(i)}>
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            ))}
          </div>
        </OutlineToggle>
      </section>
    </>
  );

  return (
    <div className={`outline-editor${showNav ? ' has-nav' : ''}`}>
      {showNav ? (
        <div className="outline-layout">
          <nav className="outline-nav" aria-label={t('outline.navLabel')}>
            <span className="outline-nav-title">{t('outline.phases')}</span>
            {phases.map((phase, i) => (
              <button
                key={phase.id}
                type="button"
                className="outline-nav-link"
                onClick={() => scrollToAnchor(`phase-${phase.id}`)}
                title={phase.title}
              >
                {i + 1}. {phase.title}
              </button>
            ))}
            <span className="outline-nav-title">{t('outline.navOther')}</span>
            <button type="button" className="outline-nav-link" onClick={() => scrollToAnchor('turning-points')}>
              {t('outline.navTurningPoints')}
            </button>
            <button type="button" className="outline-nav-link" onClick={() => scrollToAnchor('notes')}>
              {t('outline.navNotes')}
            </button>
          </nav>
          <div className="outline-layout-main">{content}</div>
        </div>
      ) : (
        content
      )}
    </div>
  );
}
