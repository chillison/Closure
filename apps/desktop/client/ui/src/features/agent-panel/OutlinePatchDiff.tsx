import { Fragment, useMemo } from 'react';
import {
  diffOutline,
  diffEpisodes,
  isStructuredDiffable,
  prettyPatchData,
  type CoreFieldKey,
  type PhaseDiff,
  type TurningPointType,
  type TFunction,
} from './outlinePatchDiffModel';

/**
 * dogfood R2 批次 D1：outline / episode_outlines patch 的审查专用结构化 diff 卡
 * （详设第三节 + mockup ui-mockup-draft-review.html Ⓐ卡，用户已认方向）——替掉这两个
 * field 在 PatchReviewPanel 展开区的裸 JSON `<pre>` 对照（「把关面看不到结构等于形同
 * 虚设」的彻底解）。拦截先例形态 mirror SettingMdPatchCard / ReviewFindingsCard
 * （专用卡替换默认呈现位），但落位在展开区：行头/勾选/锁/接受拒绝流程零变化。
 *
 * 纯展示组件：t 经 props 注入（mirror PhaseBlock），不碰 store。语义判断零参与——
 * 只机械渲染 diffOutline / diffEpisodes 的产出（ADR-3）。
 */

type Props = {
  field: 'outline' | 'episode_outlines';
  /** 改前值 = store creativeFields[field]（缺省 undefined = 全新增呈现）。 */
  before: unknown;
  /** 改后值 = patch envelope entry.data（shell 投影后的全量数据）。 */
  after: unknown;
  t: TFunction;
};

/** 顶层文本字段 → 既有 OutlineEditor 同名 i18n 标签（单源，不另造词）。 */
const CORE_LABEL_KEYS: Record<CoreFieldKey, string> = {
  story_type: 'outline.storyType',
  writing_style: 'outline.writingStyle',
  central_conflict: 'outline.centralConflict',
  main_goal: 'outline.mainGoal',
  ending_direction: 'outline.endingDirection',
  characters: 'outline.characters',
  arc_design_notes: 'outline.arcDesignNotes',
  pacing_design_notes: 'outline.pacingDesignNotes',
};

/** 卷内字段 → OutlineEditor 同名标签（PhaseBlock 四件 + 标题 + 预估章节数）。 */
const PHASE_LABEL_KEYS: Record<string, string> = {
  title: 'outline.phaseTitle',
  goal: 'outline.phaseGoal',
  antagonist: 'outline.phaseAntagonist',
  climax: 'outline.phaseClimax',
  hook: 'outline.phaseHook',
  estimated_chapters: 'outline.estimatedChapters',
};

/** 转折点 type 徽章（mockup：core=琥珀 / secondary=蓝 / fork=紫——主题 token 无紫，
 * fork 取 --accent 品牌中性色，token 纪律优先于 mockup 字面色）。 */
const TP_TYPE_CLASS: Record<TurningPointType, string> = {
  'core-anchor': 'outline-diff-tp-type--core',
  'secondary-anchor': 'outline-diff-tp-type--secondary',
  'fork-point': 'outline-diff-tp-type--fork',
};
const TP_TYPE_LABEL_KEYS: Record<TurningPointType, string> = {
  'core-anchor': 'outline.turningPointTypeCore',
  'secondary-anchor': 'outline.turningPointTypeSecondary',
  'fork-point': 'outline.turningPointTypeFork',
};

/** 裸 JSON 回退（零回归路径）：形态不完整 / diff 无可见变化时保信息完整。 */
function RawJsonFallback({ after, t }: { after: unknown; t: TFunction }) {
  return (
    <div className="patch-review-detail-block">
      <span className="patch-review-detail-label">{t('creative.patch.newValue')}</span>
      <pre>{prettyPatchData(after)}</pre>
    </div>
  );
}

function RewriteTag({ kind, t }: { kind: 'added' | 'removed' | 'changed'; t: TFunction }) {
  if (kind === 'added') {
    return <span className="outline-diff-tag">{t('creative.patch.outlineDiff.addedTag')}</span>;
  }
  if (kind === 'removed') {
    return <span className="outline-diff-tag outline-diff-tag--removed">{t('creative.patch.outlineDiff.removedTag')}</span>;
  }
  return <span className="outline-diff-tag">{t('creative.patch.outlineDiff.rewriteTag')}</span>;
}

function PhaseDiffCard({ diff, t }: { diff: PhaseDiff; t: TFunction }) {
  if (diff.kind === 'removed') {
    return (
      <div className="outline-diff-phase outline-diff-phase--removed">
        <div className="outline-diff-phase-title">
          <span className="outline-diff-phase-title-text">{diff.phase.title}</span>
          <RewriteTag kind="removed" t={t} />
        </div>
      </div>
    );
  }
  if (diff.kind === 'added') {
    // 新增卷：阶段卡（title + 四行字段 + 「新」徽章 + 绿色脉冲一次，mockup Ⓐ卡 new-glow）。
    const fields: Array<[string, string]> = [
      ['goal', diff.phase.goal ?? ''],
      ['antagonist', diff.phase.antagonist ?? ''],
      ['climax', diff.phase.climax ?? ''],
      ['hook', diff.phase.hook ?? ''],
    ];
    return (
      <div className="outline-diff-phase outline-diff-phase--new">
        <div className="outline-diff-phase-title">
          <span className="outline-diff-phase-title-text">{diff.phase.title}</span>
          <RewriteTag kind="added" t={t} />
        </div>
        {fields.some(([, v]) => v !== '') && (
          <div className="outline-diff-phase-fields">
            {fields
              .filter(([, v]) => v !== '')
              .map(([key, v]) => (
                <Fragment key={key}>
                  <b>{t(PHASE_LABEL_KEYS[key])}</b>
                  <span>{v}</span>
                </Fragment>
              ))}
          </div>
        )}
      </div>
    );
  }
  // changed：卷卡 + 变化字段行（旧值删除线 → 新值）。
  return (
    <div className="outline-diff-phase outline-diff-phase--changed">
      <div className="outline-diff-phase-title">
        <span className="outline-diff-phase-title-text">{diff.phase.title}</span>
        <RewriteTag kind="changed" t={t} />
      </div>
      <div className="outline-diff-phase-changes">
        {diff.changes.map((c) => (
          <div key={c.key} className="outline-diff-phase-change">
            <span className="outline-diff-phase-change-label">{t(PHASE_LABEL_KEYS[c.key])}</span>
            <div className="outline-diff-value">
              {c.oldText !== '' && <span className="outline-diff-old">{c.oldText}</span>}
              <span className="outline-diff-new">{c.newText !== '' ? c.newText : '—'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutlineDiffView({ before, after, t }: { before: unknown; after: unknown; t: TFunction }) {
  const diff = useMemo(() => diffOutline(before, after), [before, after]);
  const empty =
    diff.core.length === 0
    && diff.phases.length === 0
    && diff.turningPoints.length === 0
    && diff.constraints.length === 0;
  if (empty) {
    // 全量 diff 无可见变化（如仅未覆盖字段微调）→ 裸 JSON 回退保信息完整。
    return <RawJsonFallback after={after} t={t} />;
  }
  return (
    <div className="outline-diff">
      {/* 顶部统计 chips（mockup Ⓐ卡 review-stats）：+N 卷 · +N 转折点 · N 字段改写。 */}
      {(diff.stats.addedPhases > 0 || diff.stats.addedTurningPoints > 0 || diff.stats.coreRewrites > 0) && (
        <div className="outline-diff-stats">
          {diff.stats.addedPhases > 0 && (
            <span className="outline-diff-chip">{t('creative.patch.outlineDiff.statsPhases', { count: diff.stats.addedPhases })}</span>
          )}
          {diff.stats.addedTurningPoints > 0 && (
            <span className="outline-diff-chip">{t('creative.patch.outlineDiff.statsTurningPoints', { count: diff.stats.addedTurningPoints })}</span>
          )}
          {diff.stats.coreRewrites > 0 && (
            <span className="outline-diff-chip outline-diff-chip--muted">{t('creative.patch.outlineDiff.statsRewrites', { count: diff.stats.coreRewrites })}</span>
          )}
        </div>
      )}

      {/* 核心字改写：旧值（muted + 删除线）→ 新值 + 标签。 */}
      {diff.core.length > 0 && (
        <div className="outline-diff-rows">
          {diff.core.map((c) => (
            <div key={c.key} className="outline-diff-row">
              <span className="outline-diff-row-label">{t(CORE_LABEL_KEYS[c.key])}</span>
              <div className="outline-diff-value">
                {c.kind !== 'added' && c.before !== undefined && <span className="outline-diff-old">{c.before}</span>}
                <span className="outline-diff-new">
                  <RewriteTag kind={c.kind} t={t} />
                  {c.after ?? '—'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* phases diff：新增卷 = 阶段卡 + 脉冲；字段变化 = 变化行；删除卷 = 标题删除线卡。 */}
      {diff.phases.length > 0 && (
        <div className="outline-diff-section">
          <span className="outline-diff-section-label">{t('outline.phases')}</span>
          {diff.phases.map((p) => (
            <PhaseDiffCard key={p.phase.id} diff={p} t={t} />
          ))}
        </div>
      )}

      {/* 转折点 diff：added（type 徽章 + label + 新）/ removed（删除线）/ changed（label 旧→新）。 */}
      {diff.turningPoints.length > 0 && (
        <div className="outline-diff-section">
          <span className="outline-diff-section-label">{t('outline.turningPoints')}</span>
          {diff.turningPoints.map((tp, i) => {
            const type = tp.kind === 'removed' ? tp.tp.type : tp.kind === 'added' ? tp.tp.type : tp.after.type;
            return (
              <div key={`${type}-${i}`} className="outline-diff-tp">
                <span className={`outline-diff-tp-type ${TP_TYPE_CLASS[type]}`}>{t(TP_TYPE_LABEL_KEYS[type])}</span>
                {tp.kind === 'changed' ? (
                  <span className="outline-diff-value">
                    {tp.before.label !== tp.after.label && <span className="outline-diff-old">{tp.before.label}</span>}
                    <span className="outline-diff-new">
                      <RewriteTag kind="changed" t={t} />
                      {tp.after.label}
                    </span>
                  </span>
                ) : tp.kind === 'removed' ? (
                  <span className="outline-diff-old">{tp.tp.label}</span>
                ) : (
                  <span className="outline-diff-new">
                    <RewriteTag kind="added" t={t} />
                    {tp.tp.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 约束 constraints：added/removed/changed 一行式。 */}
      {diff.constraints.length > 0 && (
        <div className="outline-diff-section">
          <span className="outline-diff-section-label">{t('outline.constraints')}</span>
          {diff.constraints.map((c, i) => (
            <div key={`${c.kind}-${i}`} className={`outline-diff-constraint outline-diff-constraint--${c.kind}`}>
              {c.kind === 'changed' && <span className="outline-diff-old">{c.before}</span>}
              {c.kind !== 'removed' ? (
                <span>{c.after}</span>
              ) : (
                <span className="outline-diff-old">{c.before}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** episode_outlines patch（R1 简版）：计数 chips + 每集一行式（id + purpose，changed 标黄）。 */
function EpisodeOutlineDiffView({ before, after, t }: { before: unknown; after: unknown; t: TFunction }) {
  const { entries, stats } = useMemo(() => diffEpisodes(before, after), [before, after]);
  if (entries.length === 0) return <RawJsonFallback after={after} t={t} />;
  return (
    <div className="outline-diff">
      <div className="outline-diff-stats">
        {stats.added > 0 && (
          <span className="outline-diff-chip">{t('creative.patch.outlineDiff.statsEpisodesAdded', { count: stats.added })}</span>
        )}
        {stats.changed > 0 && (
          <span className="outline-diff-chip outline-diff-chip--changed">{t('creative.patch.outlineDiff.statsEpisodesChanged', { count: stats.changed })}</span>
        )}
        {stats.removed > 0 && (
          <span className="outline-diff-chip outline-diff-chip--removed">{t('creative.patch.outlineDiff.statsEpisodesRemoved', { count: stats.removed })}</span>
        )}
      </div>
      <div className="outline-diff-ep-list">
        {entries.map((e) => {
          const ep = e.after ?? e.before!;
          return (
            <div key={ep.id} className={`outline-diff-ep outline-diff-ep--${e.kind}`}>
              <span className="outline-diff-ep-id">{ep.id}</span>
              <span className="outline-diff-ep-purpose">
                {ep.purpose ?? ep.summary ?? ep.title}
                {e.kind === 'removed' ? ` · ${t('creative.patch.outlineDiff.removedTag')}` : ''}
              </span>
              {e.kind === 'added' && <RewriteTag kind="added" t={t} />}
              {e.kind === 'changed' && <RewriteTag kind="changed" t={t} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function OutlinePatchDiff({ field, before, after, t }: Props) {
  if (!isStructuredDiffable(field, after)) {
    return <RawJsonFallback after={after} t={t} />;
  }
  if (field === 'episode_outlines') {
    return <EpisodeOutlineDiffView before={before} after={after} t={t} />;
  }
  return <OutlineDiffView before={before} after={after} t={t} />;
}
