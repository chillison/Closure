import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { reduceSubject } from '@orison/shared-contracts';
import type {
  WorldAnchorRow,
  WorldIssue,
  WorldPatch,
  WorldPatchAxis,
  WorldSliceDetail,
  WorldSubjectDetail,
  WorldSubjectRow,
} from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { Skeleton } from '../../shared/components/Skeleton';
import type { NovelChapterMeta } from '../../shared/store/novelChapterSlice';
import { openWriting } from '../editor/openWriting';
import { WORLD_AXES, type WorldAxisToggles } from '../../shared/store/worldStateSlice';
import { WorldPatchValue, buildSnapshotEntries } from './worldPatchValue';
import { makeSceneJumpResolver, type WorldSceneChapterTarget } from './worldSceneJump';
import { useWindowedRows } from './useWindowedRows';

/**
 * 世界状态面板（dogfood R2 #92，task 08-29-world-state-panel S3-S6）。
 *
 * 形态权威：task research/mockup-world-state-panel-v3.html（用户拍板）。三级缩放全量落地：
 * - L1 世界总览（时点脊柱 + 活跃主体条 + 三态）；
 * - L2 时点切片（轴 chips 计数过滤 / 场景摘要行 / 跨主体分组 + 组头直达 L3 + 变更行展开
 *   完整 value 三分支渲染）；
 * - L3 主体脊柱（回放切线行 + 此刻快照内联块 + 路径钻取条 + 更晚折叠灰条 + issues 徽标 +
 *   跳场景钮（#203 拍板：openWriting 开该章正文文件 tab，查不到映射/章未写置灰）+ 面包屑）。
 *
 * 交互纪律（design「交互质量不变式」）：
 * - 过滤/钻取/切线/层级切换**纯本地零 IPC**（数据已在手）——L3 切线快照 = reduceSubject
 *   （shared-contracts 纯函数单源）对手上全史 patches 重折叠，与 shell checkpoint 折叠同
 *   语义同结果，不为切线发任何请求。IPC 拉取仅三种时机：进视图（本文件导航 effect +
 *   slice 的 loadWorldDataForView）/ world:changed（slice 订阅）/ 手动刷新（retry/force）。
 * - L2 chrome 纪律（#202）：面包屑/chips 计数/摘要行恒取 **overview 锚点行按 viewT 查**
 *   （overview 在手 IPC）——detail 缓存 T 不匹配当前 viewT 时旧 anchor 不消费（旧 label 配
 *   新 t 的 stale chrome），正文走骨架/错误块独立三态。
 * - 未知轴防御（#10/#110/#205）：轴过滤按 `axisOn[axis] !== false`（未知轴默认显示，不静默
 *   滤掉）；L3 本地计数 `?? 0` 容错（不产 NaN chip）。
 * - 交互状态全在 worldStateSlice（zustand，过刷新存活）；搜索词/折叠态/变更行展开/快照块
 *   展开是纯渲染 affordance，留组件局部 state（刷新不保——mockup 同语义）。
 * - 长列表窗口化（简版模型估高，见 useWindowedRows 头注）：主体选择区 + L1 时点脊柱 +
 *   L2 组块 + L3 脊柱锚点块；滚动区独立容器（chrome 固定其上，规避 sticky 前提族）。
 */

/** i18n 译者面（useI18n.t 的结构类型——子组件 prop 传递用）。 */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 轴→计数全键 total record 的零值（契约：缺轴计 0——chips 灰显由数据承载）。 */
const ZERO_AXIS_COUNTS: Record<WorldPatchAxis, number> = {
  physical: 0,
  cognitive: 0,
  emotional: 0,
  relational: 0,
  factional: 0,
};

/** 窗口化行高模型估计（px）——保守偏大吸收换行方差，配合 overscan 兜住可见区。 */
const PICKER_ROW_EST = 30;
const GROUP_HEAD_EST = 36;
const ANCHOR_HEAD_EST = 40;
const PATCH_ROW_EST = 48;
/** L1 锚点行估高（head 行 + meta 行 + 双侧 padding；活跃条是常数偏移，overscan 吸收）。 */
const L1_ANCHOR_ROW_EST = 48;

// 模块级空数组：overview 未装时的稳定引用（useMemo dep 不逐渲染翻新）。
const EMPTY_SUBJECTS: WorldSubjectRow[] = [];

// 模块级空 patches：detail 未就绪时的稳定引用（L3 派生 memo 的 dep 不逐渲染翻新）。
const EMPTY_PATCHES: readonly WorldPatch[] = [];

/** 主体开放 type 中的已知展示名键（未知 type 回落原字符串——subject type 无枚举）。 */
const KNOWN_SUBJECT_TYPES = ['character', 'group', 'item', 'faction', 'quest', 'entity'] as const;

function subjectTypeLabel(type: string, t: Translate): string {
  return (KNOWN_SUBJECT_TYPES as readonly string[]).includes(type)
    ? t(`worldState.typeLabels.${type}`)
    : type;
}

function axisLabel(axis: string, t: Translate): string {
  return t(`worldState.axisLabels.${axis}`);
}

/** 主体显示名（name 缺省回落 id——无卡锚主体常态）。 */
function subjectDisplayName(subject: WorldSubjectRow): string {
  return subject.name && subject.name.length > 0 ? subject.name : subject.id;
}

/** id 去掉 `type:` 前缀的 slug 段（mockup 主体行 id 副标形态）。 */
function subjectSlug(subject: WorldSubjectRow): string {
  const idx = subject.id.indexOf(':');
  return idx >= 0 ? subject.id.slice(idx + 1) : subject.id;
}

type SubjectGroup = {
  type: string;
  label: string;
  rows: WorldSubjectRow[];
};

/**
 * 主体选择区分组投影（纯函数）：搜索词即时过滤（name/id 不区分大小写包含）→ type
 * 分组（组序 = subjects 数组首遇序，稳定）→ 组内 lastStoryTime 降序（null = 登记
 * 未写沉底，契约注释「主体选择区沉底呈现」）。
 */
export function groupSubjects(subjects: WorldSubjectRow[], search: string, t: Translate): SubjectGroup[] {
  const q = search.trim().toLowerCase();
  const groups = new Map<string, WorldSubjectRow[]>();
  for (const s of subjects) {
    if (q) {
      const name = subjectDisplayName(s).toLowerCase();
      if (!name.includes(q) && !s.id.toLowerCase().includes(q)) continue;
    }
    const list = groups.get(s.type) ?? [];
    list.push(s);
    groups.set(s.type, list);
  }
  const result: SubjectGroup[] = [];
  for (const [type, rows] of groups) {
    rows.sort((a, b) => {
      // null 沉底（无任何变更的主体排在组末）；数值降序 = 最近活跃优先。
      if (a.lastStoryTime === null) return 1;
      if (b.lastStoryTime === null) return -1;
      return b.lastStoryTime - a.lastStoryTime;
    });
    result.push({ type, label: subjectTypeLabel(type, t), rows });
  }
  return result;
}

/**
 * 活跃主体条投影（纯函数）：lastStoryTime 落在最新时点前一格窗口内的主体，最近
 * 优先，至多 6 枚（mockup v3 语义）。latestT null（空库）时无活跃条。
 */
export function pickActiveSubjects(subjects: WorldSubjectRow[], latestT: number | null): WorldSubjectRow[] {
  if (latestT === null) return [];
  return subjects
    .filter((s) => s.lastStoryTime !== null && s.lastStoryTime >= latestT - 1 && s.lastStoryTime <= latestT)
    .sort((a, b) => (b.lastStoryTime ?? 0) - (a.lastStoryTime ?? 0))
    .slice(0, 6);
}

function AxisDots({ axes, t }: { axes: readonly string[]; t: Translate }) {
  return (
    <span className="world-axis-dots" aria-hidden="true">
      {axes.slice(0, 3).map((axis) => (
        <span key={axis} className={`world-axis-dot world-axis-dot--${axis}`} title={axisLabel(axis, t)} />
      ))}
    </span>
  );
}

/** 面包屑（L2/L3 顶部；root 与返回钮同效——mockup crumbs 形态）。 */
function WorldCrumbs({ current, onBack, t }: { current: string; onBack: () => void; t: Translate }) {
  return (
    <div className="world-crumbs">
      <span className="world-crumbs-trail">
        <button type="button" className="world-crumbs-root" onClick={onBack}>
          {t('worldState.crumbsWorld')}
        </button>
        <span className="world-crumbs-sep" aria-hidden="true">›</span>
        <span className="world-crumbs-current">{current}</span>
      </span>
      <button type="button" className="world-crumbs-back" onClick={onBack}>
        {t('worldState.backToOverview')}
      </button>
    </div>
  );
}

/** 轴 chips 行（L2/L3 共用）：计数来自数据（L2 = anchor.axisCounts 服务端聚合 / L3 = 本地全史现算），缺轴 0 灰显仍可点。 */
function WorldAxisChips({ axisCounts, axisOn, onToggle, t }: {
  axisCounts: Record<WorldPatchAxis, number>;
  axisOn: WorldAxisToggles;
  onToggle: (axis: WorldPatchAxis) => void;
  t: Translate;
}) {
  return (
    <div className="world-chips-row" role="group" aria-label={t('worldState.axesFilterLabel')}>
      {WORLD_AXES.map((axis) => {
        const count = axisCounts[axis] ?? 0;
        const label = axisLabel(axis, t);
        return (
          <button
            key={axis}
            type="button"
            className={`world-axis-chip${axisOn[axis] ? ' is-on' : ''}${count === 0 ? ' is-empty' : ''}`}
            onClick={() => onToggle(axis)}
            aria-pressed={axisOn[axis]}
            title={label}
          >
            <span className={`world-axis-dot world-axis-dot--${axis}`} aria-hidden="true" />
            <span className="world-axis-chip-label">{label}</span>
            <span className="world-axis-chip-count">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 跳场景目标类型（面板面：章 = novelChapters 元数据，openWriting 直消费）。 */
type SceneJumpTarget = WorldSceneChapterTarget<NovelChapterMeta>;
type ResolveSceneChapter = (sceneId: string) => SceneJumpTarget | null;
type JumpSceneHandler = (target: SceneJumpTarget) => void;

/** 变更行（L2/L3 共用形态）：轴色点 + path + op + 摘要，点头部展开完整 value（三分支）；issues 徽标 / 跳场景钮（evidenceSceneId 有值才显，查不到章或章未写正文置灰）。 */
function WorldPatchRow({ patch, open, onToggle, issue, t, layerLabel, resolveSubjectName, onSubjectClick, resolveSceneChapter, onJumpScene }: {
  patch: WorldPatch;
  open: boolean;
  onToggle: () => void;
  issue: WorldIssue | undefined;
  t: Translate;
  layerLabel: (key: string) => string;
  resolveSubjectName: (subjectId: string) => string | undefined;
  onSubjectClick: (subjectId: string) => void;
  resolveSceneChapter: ResolveSceneChapter;
  onJumpScene: JumpSceneHandler;
}) {
  const jumpTarget = patch.evidenceSceneId !== undefined
    ? resolveSceneChapter(patch.evidenceSceneId)
    : null;
  return (
    <div className={`world-patch${open ? ' is-open' : ''}`}>
      <div className="world-patch-line">
        <span
          className={`world-axis-dot world-axis-dot--${patch.axis}`}
          title={axisLabel(patch.axis, t)}
          aria-hidden="true"
        />
        <button type="button" className="world-patch-head" onClick={onToggle} aria-expanded={open}>
          <span className="world-patch-path">
            <span className="world-patch-caret" aria-hidden="true">▶</span>
            {patch.path}
            <span className="world-patch-op">{patch.op}</span>
          </span>
          {patch.summary && <span className="world-patch-summary">{patch.summary}</span>}
          {issue && (
            <span className="world-issue-badge" title={issue.message}>
              {t(`worldState.issueLabels.${issue.code}`)}
            </span>
          )}
        </button>
        {patch.evidenceSceneId !== undefined && (
          <button
            type="button"
            className="world-jump-btn"
            disabled={jumpTarget === null}
            title={jumpTarget === null ? t('worldState.jumpToSceneNoChapter') : t('worldState.jumpToScene')}
            onClick={jumpTarget !== null ? () => onJumpScene(jumpTarget) : undefined}
          >
            {t('worldState.jumpToScene')}
          </button>
        )}
      </div>
      {open && (
        <div className="world-patch-value">
          <WorldPatchValue
            value={patch.value}
            layerLabel={layerLabel}
            resolveSubjectName={resolveSubjectName}
            onSubjectClick={onSubjectClick}
          />
        </div>
      )}
    </div>
  );
}

/** 有旧数据时的刷新失败细条（不遮数据——事件重拉失败兜底可见）。 */
function WorldErrorStrip({ error, onRetry, t }: { error: string; onRetry: () => void; t: Translate }) {
  return (
    <div className="world-error-strip" role="alert">
      <span>{error}</span>
      <button type="button" className="world-error-retry" onClick={onRetry}>
        {t('worldState.retry')}
      </button>
    </div>
  );
}

// ── L2 时点切片 ──

function WorldSliceView(props: {
  viewT: number;
  anchor: WorldAnchorRow | null;
  detail: WorldSliceDetail | null;
  ready: boolean;
  error: string | null;
  axisOn: WorldAxisToggles;
  onToggleAxis: (axis: WorldPatchAxis) => void;
  onEnterSubject: (subjectId: string) => void;
  onBack: () => void;
  onRetry: () => void;
  t: Translate;
  layerLabel: (key: string) => string;
  resolveSubjectName: (subjectId: string) => string | undefined;
  resolveSceneChapter: ResolveSceneChapter;
  onJumpScene: JumpSceneHandler;
}) {
  const {
    viewT, anchor, detail, ready, error, axisOn, onToggleAxis, onEnterSubject, onBack, onRetry,
    t, layerLabel, resolveSubjectName, resolveSceneChapter, onJumpScene,
  } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [toggledIds, setToggledIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => {
    setToggledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 轴过滤纯本地（mockup：分组从过滤后变更重建——全过滤空的组不渲染）。`!== false`：
  // 未知轴默认显示（#10/#205——axisOn 只登记五轴，契约外/未来扩展轴不静默滤掉）。
  const visibleGroups = useMemo(() => {
    if (!detail) return [];
    return detail.groups
      .map((g) => ({ subject: g.subject, patches: g.patches.filter((p) => axisOn[p.axis] !== false) }))
      .filter((g) => g.patches.length > 0);
  }, [detail, axisOn]);

  const rowEstimates = useMemo(
    () => visibleGroups.map((g) => GROUP_HEAD_EST + g.patches.length * PATCH_ROW_EST),
    [visibleGroups],
  );
  const win = useWindowedRows({ containerRef: scrollRef, rowCount: visibleGroups.length, rowEstimates });
  const windowedGroups = visibleGroups.slice(win.startIndex, win.endIndex + 1);

  const current = anchor?.label ? `${anchor.label}（t=${viewT}）` : `t=${viewT}`;

  const renderBody = () => {
    if (!ready && error) {
      return (
        <div className="world-state-block">
          <span className="material-symbols-outlined" aria-hidden="true">cloud_off</span>
          <span className="world-state-title">{t('worldState.errorTitle')}</span>
          <span className="world-state-desc">{error}</span>
          <button type="button" className="world-retry-btn" onClick={onRetry}>
            {t('worldState.retry')}
          </button>
        </div>
      );
    }
    if (!ready || detail === null) {
      return (
        <div className="world-loading" role="status" aria-busy="true" aria-label={t('worldState.loading')}>
          <Skeleton width="60%" height="0.8rem" />
          <Skeleton width="90%" height="0.8rem" />
          <Skeleton width="70%" height="0.8rem" />
          <Skeleton width="80%" height="0.8rem" />
        </div>
      );
    }
    if (detail.groups.length === 0) {
      return (
        <div className="world-state-block">
          <span className="world-state-desc">{t('worldState.sliceNoChanges')}</span>
        </div>
      );
    }
    if (visibleGroups.length === 0) {
      return (
        <div className="world-state-block">
          <span className="world-state-desc">{t('worldState.axisFilteredEmpty')}</span>
        </div>
      );
    }
    return (
      <div className="world-spine-scroll" ref={scrollRef} onScroll={win.onScroll}>
        {win.virtualized && <div className="world-scroll-pad" style={{ height: win.padTop }} aria-hidden="true" />}
        {windowedGroups.map((g) => (
          <div className="world-sgrp" key={g.subject.id}>
            <button type="button" className="world-sgrp-head" onClick={() => onEnterSubject(g.subject.id)}>
              <AxisDots axes={g.subject.axes} t={t} />
              <span className="world-sgrp-name">{subjectDisplayName(g.subject)}</span>
              <span className="world-sgrp-count">
                {t('worldState.groupPatchesCount', { count: g.patches.length })} · {t('worldState.enterSubject')}
              </span>
            </button>
            {g.patches.map((p) => (
              <WorldPatchRow
                key={p.id}
                patch={p}
                open={toggledIds.has(p.id)}
                onToggle={() => toggle(p.id)}
                issue={undefined}
                t={t}
                layerLabel={layerLabel}
                resolveSubjectName={resolveSubjectName}
                onSubjectClick={onEnterSubject}
                resolveSceneChapter={resolveSceneChapter}
                onJumpScene={onJumpScene}
              />
            ))}
          </div>
        ))}
        {win.virtualized && <div className="world-scroll-pad" style={{ height: win.padBottom }} aria-hidden="true" />}
      </div>
    );
  };

  return (
    <>
      <WorldCrumbs current={current} onBack={onBack} t={t} />
      {error !== null && ready && <WorldErrorStrip error={error} onRetry={onRetry} t={t} />}
      <WorldAxisChips
        axisCounts={anchor?.axisCounts ?? ZERO_AXIS_COUNTS}
        axisOn={axisOn}
        onToggle={onToggleAxis}
        t={t}
      />
      {anchor !== null && (
        <div className="world-slice-summary">
          {anchor.title && <span>{t('worldState.sceneTitle', { title: anchor.title })}</span>}
          {anchor.epRange && <span className="world-anchor-eps">{anchor.epRange}</span>}
          <span>
            {t('worldState.sliceSummary', { subjects: anchor.subjectCount, patches: anchor.patchCount })}
          </span>
        </div>
      )}
      {renderBody()}
    </>
  );
}

// ── L3 主体脊柱 ──

function WorldSubjectView(props: {
  subjectId: string;
  subjectName: string;
  detail: WorldSubjectDetail | null;
  ready: boolean;
  error: string | null;
  asOfT: number | null;
  pathFilter: string | null;
  axisOn: WorldAxisToggles;
  anchors: readonly WorldAnchorRow[];
  onToggleAxis: (axis: WorldPatchAxis) => void;
  onEnterSubject: (subjectId: string) => void;
  onEnterSlice: (t: number) => void;
  onBack: () => void;
  onRetry: () => void;
  onSetAsOf: (t: number | null) => void;
  onSetPathFilter: (path: string | null) => void;
  t: Translate;
  layerLabel: (key: string) => string;
  resolveSubjectName: (subjectId: string) => string | undefined;
  resolveSceneChapter: ResolveSceneChapter;
  onJumpScene: JumpSceneHandler;
}) {
  const {
    subjectId, subjectName, detail, ready, error, asOfT, pathFilter, axisOn, anchors,
    onToggleAxis, onEnterSubject, onEnterSlice, onBack, onRetry, onSetAsOf, onSetPathFilter,
    t, layerLabel, resolveSubjectName, resolveSceneChapter, onJumpScene,
  } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [toggledIds, setToggledIds] = useState<ReadonlySet<string>>(() => new Set());
  const [snapOpen, setSnapOpen] = useState(true);
  const toggle = (id: string) => {
    setToggledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 全史 patches 在手（契约注释：轴过滤/path 钻取/切线快照全部 UI 本地做）。
  const patches: readonly WorldPatch[] = useMemo(
    () => (ready && detail ? detail.patches : EMPTY_PATCHES),
    [ready, detail],
  );

  // 本地轴计数（#205 容错）：未知轴键 `?? 0` 起步（axisOn/ZERO 只登记五轴——契约当前闭枚举，
  // 此处防御 mock 注水/未来扩轴不产 NaN）；chips 只遍历五轴，未知轴不造 chip。
  const axisCounts = useMemo(() => {
    const counts: Record<string, number> = { ...ZERO_AXIS_COUNTS };
    for (const p of patches) counts[p.axis] = (counts[p.axis] ?? 0) + 1;
    return counts;
  }, [patches]);

  // `!== false`：未知轴默认显示（#10/#110——同 L2 过滤口径）。
  const axisFiltered = useMemo(
    () => patches.filter((p) => axisOn[p.axis] !== false),
    [patches, axisOn],
  );

  // 路径钻取：精确命中或子路径（mockup startsWith(path + '/') 同形）。
  const visiblePatches = useMemo(() => {
    if (pathFilter === null) return axisFiltered;
    return axisFiltered.filter((p) => p.path === pathFilter || p.path.startsWith(`${pathFilter}/`));
  }, [axisFiltered, pathFilter]);

  // 更晚折叠计数（mockup：轴过滤后口径，不含路径钻取——钻取是行内再过滤）。
  const laterCount = useMemo(
    () => (asOfT === null ? 0 : axisFiltered.filter((p) => p.storyTime > asOfT).length),
    [axisFiltered, asOfT],
  );

  // 切线快照 = 手上全史本地重折叠（reduceSubject 是 shared-contracts 纯函数单源，与 shell
  // checkpoint 折叠同语义同结果）——design 交互不变式 1「切线纯本地零 IPC」的落点。
  const snapshot = useMemo(
    () => reduceSubject(patches, subjectId, asOfT ?? undefined),
    [patches, subjectId, asOfT],
  );
  // 快照 kv 键 = 折叠窗内出现过的 patch path（与钻取过滤同一寻址空间，见
  // buildSnapshotEntries 注释）。
  const snapshotEntries = useMemo(
    () => buildSnapshotEntries(patches, asOfT, snapshot.state),
    [patches, asOfT, snapshot],
  );
  const issuesByPath = useMemo(() => {
    const map = new Map<string, WorldIssue>();
    for (const issue of snapshot.issues) map.set(issue.path, issue);
    return map;
  }, [snapshot]);

  const anchorInfoByT = useMemo(() => new Map(anchors.map((a) => [a.t, a])), [anchors]);

  const blocks = useMemo(() => {
    const byT = new Map<number, WorldPatch[]>();
    for (const p of visiblePatches) {
      if (asOfT !== null && p.storyTime > asOfT) continue;
      const list = byT.get(p.storyTime);
      if (list) list.push(p);
      else byT.set(p.storyTime, [p]);
    }
    // 现在在上（t 降序）；锚点 label/epRange 取 overview 在手行，缺失时裸 t 行兜底。
    return [...byT.keys()].sort((a, b) => b - a).map((t) => ({
      t,
      anchor: anchorInfoByT.get(t) ?? null,
      patches: byT.get(t)!,
    }));
  }, [visiblePatches, asOfT, anchorInfoByT]);

  const rowEstimates = useMemo(
    () => blocks.map((b) => ANCHOR_HEAD_EST + b.patches.length * PATCH_ROW_EST),
    [blocks],
  );
  const win = useWindowedRows({ containerRef: scrollRef, rowCount: blocks.length, rowEstimates });
  const windowedBlocks = blocks.slice(win.startIndex, win.endIndex + 1);

  const asOfAnchor = asOfT === null ? null : anchorInfoByT.get(asOfT) ?? null;
  // 切线行目标文案（单键内插——冒号随 locale 文案走，不拼裸字面）。
  const asOfLabel = asOfT === null
    ? t('worldState.replayTargetNow')
    : t('worldState.replayTargetAt', {
      target: asOfAnchor?.label
        ? t('worldState.replayTargetLabel', { label: asOfAnchor.label, t: asOfT })
        : t('worldState.replayTargetBare', { t: asOfT }),
    });

  const renderBody = () => {
    if (!ready && error) {
      return (
        <div className="world-state-block">
          <span className="material-symbols-outlined" aria-hidden="true">cloud_off</span>
          <span className="world-state-title">{t('worldState.errorTitle')}</span>
          <span className="world-state-desc">{error}</span>
          <button type="button" className="world-retry-btn" onClick={onRetry}>
            {t('worldState.retry')}
          </button>
        </div>
      );
    }
    if (!ready) {
      return (
        <div className="world-loading" role="status" aria-busy="true" aria-label={t('worldState.loading')}>
          <Skeleton width="55%" height="0.8rem" />
          <Skeleton width="85%" height="0.8rem" />
          <Skeleton width="70%" height="0.8rem" />
          <Skeleton width="80%" height="0.8rem" />
        </div>
      );
    }
    if (patches.length === 0) {
      return (
        <div className="world-state-block">
          <span className="material-symbols-outlined" aria-hidden="true">public</span>
          <span className="world-state-desc">{t('worldState.subjectNoChanges')}</span>
        </div>
      );
    }
    // 过滤空分支（#103）：主体有变更但全被本地过滤掉（轴全关 / 路径钻取无命中）——区别于
    // 上面的空库态，提示可解除（开 chips / 清钻取即恢复）。as-of 折叠不进此分支（更晚变更
    // 由灰条承载，visiblePatches 仍非空）。
    if (visiblePatches.length === 0) {
      return (
        <div className="world-state-block">
          <span className="material-symbols-outlined" aria-hidden="true">filter_alt_off</span>
          <span className="world-state-desc">{t('worldState.axisFilteredEmpty')}</span>
        </div>
      );
    }
    return (
      <div className="world-spine-scroll" ref={scrollRef} onScroll={win.onScroll}>
        {win.virtualized && <div className="world-scroll-pad" style={{ height: win.padTop }} aria-hidden="true" />}
        {windowedBlocks.map((b) => (
          <div className="world-anchor" key={b.t}>
            <button
              type="button"
              className="world-anchor-dot"
              onClick={() => onSetAsOf(b.t)}
              title={t('worldState.cutHere')}
              aria-label={t('worldState.cutHereAt', { t: b.t })}
            />
            <div className="world-anchor-line">
              <button type="button" className="world-anchor-linehead" onClick={() => onEnterSlice(b.t)}>
                <span className="world-anchor-t">t={b.t}</span>
                {b.anchor?.label && <span className="world-anchor-label">{b.anchor.label}</span>}
                {b.anchor?.epRange && <span className="world-anchor-eps">{b.anchor.epRange}</span>}
              </button>
              <button type="button" className="world-anchor-scissor" onClick={() => onSetAsOf(b.t)}>
                {t('worldState.cutHere')}
              </button>
            </div>
            {b.patches.map((p, i) => {
              // 钻取态首条自动展开（mockup：pathFilter 下每组第一条 open）；再点可手动收起
              // ——autoOpen XOR 显式翻转，两方向都可逆。
              const autoOpen = pathFilter !== null && i === 0;
              const open = autoOpen !== toggledIds.has(p.id);
              return (
                <WorldPatchRow
                  key={p.id}
                  patch={p}
                  open={open}
                  onToggle={() => toggle(p.id)}
                  issue={issuesByPath.get(p.path)}
                  t={t}
                  layerLabel={layerLabel}
                  resolveSubjectName={resolveSubjectName}
                  onSubjectClick={onEnterSubject}
                  resolveSceneChapter={resolveSceneChapter}
                  onJumpScene={onJumpScene}
                />
              );
            })}
          </div>
        ))}
        {win.virtualized && <div className="world-scroll-pad" style={{ height: win.padBottom }} aria-hidden="true" />}
      </div>
    );
  };

  return (
    <>
      <WorldCrumbs current={subjectName} onBack={onBack} t={t} />
      {error !== null && ready && <WorldErrorStrip error={error} onRetry={onRetry} t={t} />}
      <WorldAxisChips axisCounts={axisCounts} axisOn={axisOn} onToggle={onToggleAxis} t={t} />
      <button
        type="button"
        className="world-cut-row"
        onClick={() => onSetAsOf(null)}
        title={asOfT === null ? t('worldState.replayHint') : t('worldState.replayBackHint')}
      >
        <span className="world-cut-label">{asOfLabel}</span>
        <span className="world-cut-hint">
          {asOfT === null ? t('worldState.replayHint') : t('worldState.replayBackHint')}
        </span>
      </button>
      <div className={`world-snapshot${snapOpen ? ' is-open' : ''}`}>
        <button
          type="button"
          className="world-snapshot-head"
          onClick={() => setSnapOpen((v) => !v)}
          aria-expanded={snapOpen}
        >
          <span className="material-symbols-outlined world-caret" aria-hidden="true">expand_more</span>
          <span className="world-snapshot-title">
            {t('worldState.snapshotTitle')}
            <b>
              {asOfT === null
                ? t('worldState.snapshotScopeLatest')
                : t('worldState.snapshotScopeAt', { t: asOfT })}
            </b>
          </span>
          <span className="world-snapshot-count">
            {t('worldState.snapshotCount', { count: snapshotEntries.length })}
          </span>
          <span className="world-snapshot-hint">{t('worldState.snapshotDrillHint')}</span>
        </button>
        {snapOpen && (snapshotEntries.length === 0 ? (
          <div className="world-snapshot-empty">{t('worldState.snapshotEmpty')}</div>
        ) : (
          <div className="world-snapshot-body">
            {snapshotEntries.map((entry) => (
              <div className="world-kv" key={entry.pointer}>
                <button
                  type="button"
                  className="world-kv-key"
                  title={t('worldState.snapshotDrillHint')}
                  onClick={() => onSetPathFilter(entry.pointer)}
                >
                  {entry.displayKey}
                </button>
                <span className="world-kv-value">
                  <WorldPatchValue
                    value={entry.value}
                    layerLabel={layerLabel}
                    resolveSubjectName={resolveSubjectName}
                    onSubjectClick={onEnterSubject}
                  />
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {pathFilter !== null && (
        <div className="world-pathfilter">
          <span>{t('worldState.pathDrillLabel')}</span>
          <code>{pathFilter}</code>
          <span className="world-pathfilter-hint">{t('worldState.pathDrillHint')}</span>
          <button type="button" className="world-pathfilter-clear" onClick={() => onSetPathFilter(null)}>
            {t('worldState.clearPathFilter')}
          </button>
        </div>
      )}
      {laterCount > 0 && (
        <button type="button" className="world-later-folded" onClick={() => onSetAsOf(null)}>
          {t('worldState.laterFolded', { count: laterCount })}
        </button>
      )}
      {renderBody()}
    </>
  );
}

// ── 面板 ──

export function WorldStatePanel() {
  const {
    currentProject,
    resolvedLocale,
    worldView,
    worldOverview,
    worldOverviewLoading,
    worldOverviewError,
    worldSliceDetail,
    worldSliceDetailT,
    worldSliceDetailError,
    worldSubjectDetail,
    worldSubjectDetailSubjectId,
    worldSubjectDetailError,
    goWorldOverview,
    goWorldSlice,
    goWorldSubject,
    setWorldAsOf,
    setWorldPathFilter,
    toggleWorldAxis,
    loadWorldDataForView,
    loadWorldOverview,
    loadWorldSliceDetail,
    loadWorldSubjectDetail,
    sceneGraph,
    episodeOutlines,
    novelChapters,
  } = useAppStore(useShallow((s) => ({
    currentProject: s.currentProject,
    resolvedLocale: s.resolvedLocale,
    worldView: s.worldView,
    worldOverview: s.worldOverview,
    worldOverviewLoading: s.worldOverviewLoading,
    worldOverviewError: s.worldOverviewError,
    worldSliceDetail: s.worldSliceDetail,
    worldSliceDetailT: s.worldSliceDetailT,
    worldSliceDetailError: s.worldSliceDetailError,
    worldSubjectDetail: s.worldSubjectDetail,
    worldSubjectDetailSubjectId: s.worldSubjectDetailSubjectId,
    worldSubjectDetailError: s.worldSubjectDetailError,
    goWorldOverview: s.goWorldOverview,
    goWorldSlice: s.goWorldSlice,
    goWorldSubject: s.goWorldSubject,
    setWorldAsOf: s.setWorldAsOf,
    setWorldPathFilter: s.setWorldPathFilter,
    toggleWorldAxis: s.toggleWorldAxis,
    loadWorldDataForView: s.loadWorldDataForView,
    loadWorldOverview: s.loadWorldOverview,
    loadWorldSliceDetail: s.loadWorldSliceDetail,
    loadWorldSubjectDetail: s.loadWorldSubjectDetail,
    sceneGraph: s.creativeFields.scene_graph,
    episodeOutlines: s.creativeFields.episode_outlines,
    novelChapters: s.novelChapters,
  })));

  const { t } = useI18n(resolvedLocale);

  // 纯渲染 affordance（刷新不保）：搜索词 / 选择区与分组折叠态。
  const [search, setSearch] = useState('');
  const [pickerCollapsed, setPickerCollapsed] = useState(false);
  const [collapsedTypes, setCollapsedTypes] = useState<ReadonlySet<string>>(() => new Set());

  const projectPath = currentProject?.path ?? null;

  // 打开即拉 + 项目切换换向（reset 清缓存后此处重进水合/重拉）。loadWorldDataForView
  // 幂等（加载中/已装跳过），StrictMode 双调无副作用。
  useEffect(() => {
    loadWorldDataForView();
  }, [projectPath, loadWorldDataForView]);

  // 导航驱动的按视图拉数（design 交互不变式 2——「进视图」是三种 IPC 时机之一：导航
  // action 本身零 IPC，数据缺口由此处补拉；slice 内部幂等守卫防重复/防 StrictMode 双拉）。
  const view = worldView.view;
  const viewT = worldView.viewT;
  const selectedSubjectId = worldView.selectedSubjectId;
  const asOfT = worldView.asOfT;
  useEffect(() => {
    if (view !== 'slice' || viewT === null) return;
    void loadWorldSliceDetail(viewT);
  }, [view, viewT, loadWorldSliceDetail]);
  useEffect(() => {
    if (view !== 'subject' || selectedSubjectId === null) return;
    void loadWorldSubjectDetail(selectedSubjectId);
    // asOfT 特意不进 deps：切线 = 本地 reduceSubject 重折叠（交互不变式 1），不因切线
    // 重拉——subject-detail 契约已无 at 参（CR #4：shell 侧 reduce 死开销砍除，本地折叠唯一态）。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 切线零 IPC
  }, [view, selectedSubjectId, loadWorldSubjectDetail]);

  const subjects = useMemo(
    () => worldOverview?.subjects ?? EMPTY_SUBJECTS,
    [worldOverview?.subjects],
  );
  const groups = useMemo(() => groupSubjects(subjects, search, t), [subjects, search, t]);
  const activeChips = useMemo(
    () => pickActiveSubjects(subjects, worldOverview?.latestT ?? null),
    [subjects, worldOverview?.latestT],
  );
  // 契约：anchors 数据层升序；脊柱降序渲染（现在在上）。拷贝后排序，不动 store 引用。
  const anchorsDesc = useMemo(
    () => [...(worldOverview?.anchors ?? [])].sort((a, b) => b.t - a.t),
    [worldOverview?.anchors],
  );
  // L1 脊柱窗口化（design 交互不变式 4「主体列表与脊柱长列表虚拟滚动」——几百时点不卡；
  // 滚动容器 = .world-spine 本体（L1 视图自身滚动；is-stacked 视图该元素不滚，钩子空转无害）。
  const l1ScrollRef = useRef<HTMLDivElement | null>(null);
  const l1Win = useWindowedRows({
    containerRef: l1ScrollRef,
    rowCount: anchorsDesc.length,
    rowEstimates: L1_ANCHOR_ROW_EST,
  });
  const windowedAnchors = anchorsDesc.slice(l1Win.startIndex, l1Win.endIndex + 1);

  const subjectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of subjects) map.set(s.id, subjectDisplayName(s));
    return map;
  }, [subjects]);
  const resolveSubjectName = useCallback(
    (subjectId: string) => subjectNameById.get(subjectId),
    [subjectNameById],
  );
  // 已知分层键（objective/reader_perceived/vad）走 i18n；开放字典未知键回落原键（认知
  // topic 是中文自由短语——数据非文案；t 缺键回落裸键名的特性当探针）。
  const layerLabel = useCallback((key: string) => {
    const i18nKey = `worldState.valueLayers.${key}`;
    const label = t(i18nKey);
    return label === i18nKey ? key : label;
  }, [t]);

  // 跳场景映射（现成数据源三段链：scene_graph → episode_outlines → novelChapters，
  // 见 worldSceneJump.ts 头注）；解析器按 sceneId 记忆化。
  const sceneJump = useMemo(
    () => makeSceneJumpResolver({ sceneGraph, episodeOutlines, chapters: novelChapters }),
    [sceneGraph, episodeOutlines, novelChapters],
  );
  // #203 拍板「开章文件 tab」：跳转出口 = openWriting（OverviewPage「继续写作」/SideNav 写作
  // 入口同款 readFile + openFile 流）；章未写正文的目标已在解析器前置置灰，不落大纲页 fallback。
  const handleJumpScene = useCallback(
    (target: SceneJumpTarget) => {
      void openWriting(target.chapter);
    },
    [],
  );

  // 主体选择区窗口化行（组头 + 主体行拍平；折叠组的行直接不进列表）。
  type PickerRow =
    | { kind: 'head'; group: SubjectGroup }
    | { kind: 'subject'; subject: WorldSubjectRow };
  const pickerRows = useMemo<PickerRow[]>(() => {
    const rows: PickerRow[] = [];
    for (const group of groups) {
      rows.push({ kind: 'head', group });
      if (!collapsedTypes.has(group.type)) {
        for (const subject of group.rows) rows.push({ kind: 'subject', subject });
      }
    }
    return rows;
  }, [groups, collapsedTypes]);
  const pickerScrollRef = useRef<HTMLDivElement | null>(null);
  const pickerWin = useWindowedRows({
    containerRef: pickerScrollRef,
    rowCount: pickerRows.length,
    rowEstimates: PICKER_ROW_EST,
  });
  const windowedPickerRows = pickerRows.slice(pickerWin.startIndex, pickerWin.endIndex + 1);

  // 新时点滑入（mockup .fresh）：重拉后出现的新 t 标记一次性入场动画。首挂（含
  // StrictMode 二跑——refs 保留）不标，只对「运行中出现」的时点生效。
  const prevAnchorTsRef = useRef<ReadonlySet<number> | null>(null);
  const [freshT, setFreshT] = useState<number | null>(null);
  // 跨项目防误触（#106）：项目切换清上一项目的锚点基线——refs 跨项目保活，旧 t 集会把新
  // 项目首组锚点全判成「新」触发滑入。声明序在下方对账 effect **之前**：同 commit 双变更
  // （reset 清 overview + 新 overview 落地）时先清基线再对账。
  useEffect(() => {
    prevAnchorTsRef.current = null;
    setFreshT(null);
  }, [projectPath]);
  useEffect(() => {
    const ts = new Set((worldOverview?.anchors ?? []).map((a) => a.t));
    const prev = prevAnchorTsRef.current;
    if (prev !== null && prev.size > 0) {
      let newest: number | null = null;
      for (const t of ts) {
        if (!prev.has(t) && (newest === null || t > newest)) newest = t;
      }
      setFreshT(newest);
    }
    prevAnchorTsRef.current = ts;
  }, [worldOverview?.anchors]);

  if (!currentProject) {
    return (
      <div className="world-panel">
        <div className="world-state-block">
          <span className="material-symbols-outlined" aria-hidden="true">public</span>
          <p className="world-state-desc">{t('worldState.noProject')}</p>
        </div>
      </div>
    );
  }

  const toggleType = (type: string) => {
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const selectedSubject = view === 'subject' && selectedSubjectId !== null
    ? subjects.find((s) => s.id === selectedSubjectId) ?? null
    : null;

  // #202 stale chrome 防御：detail 只在 `worldSliceDetailT === viewT` 时消费——导航到新时点
  // 而新 detail 在途时，旧缓存（别的 t 的 anchor/组）不再配新 viewT 渲染（旧 label 配新 t /
  // 旧组闪现）。L2 chrome（面包屑/chips 计数/摘要行）恒取 overview 锚点行按 viewT 查
  // （overview 在手 IPC，与 viewT 恒同源）；加载失败走错误块独立显示，不吃旧数据。
  const sliceDetailCurrent = worldSliceDetailT === viewT ? worldSliceDetail : null;
  const sliceReady = sliceDetailCurrent !== null;
  const subjectReady = worldSubjectDetail !== null && worldSubjectDetailSubjectId === selectedSubjectId;
  const sliceAnchor = viewT !== null
    ? worldOverview?.anchors.find((a) => a.t === viewT) ?? null
    : null;

  const renderAnchorRow = (anchor: WorldAnchorRow) => {
    const presentAxes = WORLD_AXES.filter((axis) => (anchor.axisCounts[axis] ?? 0) > 0);
    return (
      <div key={anchor.t} className={`world-anchor${anchor.t === freshT ? ' is-fresh' : ''}`}>
        <button
          type="button"
          className="world-anchor-row"
          onClick={() => goWorldSlice(anchor.t)}
          aria-label={t('worldState.anchorActivity', { subjects: anchor.subjectCount, patches: anchor.patchCount })}
        >
          <span className="world-anchor-head">
            <span className="world-anchor-t">t={anchor.t}</span>
            {anchor.label && <span className="world-anchor-label">{anchor.label}</span>}
            {anchor.epRange && <span className="world-anchor-eps">{anchor.epRange}</span>}
            <span className="world-anchor-activity">
              {t('worldState.anchorActivity', { subjects: anchor.subjectCount, patches: anchor.patchCount })}
            </span>
          </span>
          {(presentAxes.length > 0 || anchor.title) && (
            <span className="world-anchor-meta">
              {presentAxes.map((axis) => (
                <span
                  key={axis}
                  className={`world-axis-dot world-axis-dot--${axis}`}
                  title={`${axisLabel(axis, t)} ${anchor.axisCounts[axis]}`}
                />
              ))}
              {anchor.title && <span className="world-anchor-title">「{anchor.title}」</span>}
            </span>
          )}
        </button>
      </div>
    );
  };

  const renderSpine = () => {
    if (view === 'overview') {
      // 三态优先（S4 逻辑照搬，只对 overview 视图生效——L2/L3 有各自三态，overview 加载
      // 中不遮它们）：加载骨架 / 错误重试 / 空态（latestT null = 尚无任何提取数据——空库
      // 判定键在契约，非 UI 各自约定）。
      if (worldOverviewLoading && !worldOverview) {
        return (
          <div className="world-loading" role="status" aria-busy="true" aria-label={t('worldState.loading')}>
            <Skeleton width="70%" height="0.8rem" />
            <Skeleton width="90%" height="0.8rem" />
            <Skeleton width="55%" height="0.8rem" />
            <Skeleton width="85%" height="0.8rem" />
          </div>
        );
      }
      if (worldOverviewError && !worldOverview) {
        return (
          <div className="world-state-block">
            <span className="material-symbols-outlined" aria-hidden="true">cloud_off</span>
            <span className="world-state-title">{t('worldState.errorTitle')}</span>
            <span className="world-state-desc">{worldOverviewError}</span>
            <button type="button" className="world-retry-btn" onClick={() => { void loadWorldOverview(true); }}>
              {t('worldState.retry')}
            </button>
          </div>
        );
      }
      if (!worldOverview || worldOverview.latestT === null) {
        return (
          <div className="world-state-block">
            <span className="material-symbols-outlined" aria-hidden="true">public</span>
            <span className="world-state-title">{t('worldState.emptyTitle')}</span>
            <span className="world-state-desc">{t('worldState.emptyDescription')}</span>
          </div>
        );
      }
      return (
        <>
          {activeChips.length > 0 && (
            <div className="world-active-strip">
              <span className="world-active-label">{t('worldState.activeStripLabel')}</span>
              {activeChips.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="world-chip"
                  onClick={() => goWorldSubject(s.id)}
                >
                  {subjectDisplayName(s)}
                </button>
              ))}
            </div>
          )}
          {anchorsDesc.length > 0 && l1Win.virtualized && (
            <div className="world-scroll-pad" style={{ height: l1Win.padTop }} aria-hidden="true" />
          )}
          {windowedAnchors.map(renderAnchorRow)}
          {anchorsDesc.length > 0 && l1Win.virtualized && (
            <div className="world-scroll-pad" style={{ height: l1Win.padBottom }} aria-hidden="true" />
          )}
        </>
      );
    }

    if (view === 'slice') {
      return (
        <WorldSliceView
          viewT={viewT ?? 0}
          anchor={sliceAnchor}
          detail={sliceDetailCurrent}
          ready={sliceReady}
          error={worldSliceDetailError}
          axisOn={worldView.axisOn}
          onToggleAxis={toggleWorldAxis}
          onEnterSubject={goWorldSubject}
          onBack={goWorldOverview}
          onRetry={() => {
            if (viewT !== null) void loadWorldSliceDetail(viewT, true);
          }}
          t={t}
          layerLabel={layerLabel}
          resolveSubjectName={resolveSubjectName}
          resolveSceneChapter={sceneJump}
          onJumpScene={handleJumpScene}
        />
      );
    }

    return (
      <WorldSubjectView
        subjectId={selectedSubjectId ?? ''}
        subjectName={selectedSubject ? subjectDisplayName(selectedSubject) : selectedSubjectId ?? ''}
        detail={worldSubjectDetail}
        ready={subjectReady}
        error={worldSubjectDetailError}
        asOfT={asOfT}
        pathFilter={worldView.pathFilter}
        axisOn={worldView.axisOn}
        anchors={anchorsDesc}
        onToggleAxis={toggleWorldAxis}
        onEnterSubject={goWorldSubject}
        onEnterSlice={goWorldSlice}
        onBack={goWorldOverview}
        onRetry={() => {
          if (selectedSubjectId !== null) {
            void loadWorldSubjectDetail(selectedSubjectId, true);
          }
        }}
        onSetAsOf={setWorldAsOf}
        onSetPathFilter={setWorldPathFilter}
        t={t}
        layerLabel={layerLabel}
        resolveSubjectName={resolveSubjectName}
        resolveSceneChapter={sceneJump}
        onJumpScene={handleJumpScene}
      />
    );
  };

  return (
    <div className="world-panel">
      <div className="world-head">
        <div className="world-title-row">
          <span className="world-title">{t('worldState.title')}</span>
          <span className="world-counts">
            {t('worldState.totalCounts', {
              subjects: worldOverview?.subjects.length ?? 0,
              patches: worldOverview?.patchTotal ?? 0,
              anchors: worldOverview?.anchors.length ?? 0,
            })}
          </span>
          <span className="world-head-actions">
            <button
              type="button"
              className="world-icon-btn"
              onClick={() => { void loadWorldOverview(true); }}
              aria-label={t('worldState.refresh')}
              title={t('worldState.refresh')}
              disabled={worldOverviewLoading}
            >
              <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
            </button>
          </span>
        </div>
        <div className="world-search">
          <span className="material-symbols-outlined" aria-hidden="true">search</span>
          <input
            type="text"
            value={search}
            placeholder={t('worldState.searchPlaceholder')}
            aria-label={t('worldState.searchPlaceholder')}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {worldOverview?.extracting && (
        <div className="world-live-bar" role="status">
          <span className="world-pulse" />
          <span>{t('worldState.extracting')}</span>
        </div>
      )}

      <section className={`world-picker${pickerCollapsed ? ' is-collapsed' : ''}`} aria-label={t('worldState.subjectsSection')}>
        <button
          type="button"
          className="world-picker-head"
          onClick={() => setPickerCollapsed(!pickerCollapsed)}
          aria-expanded={!pickerCollapsed}
        >
          <span className="material-symbols-outlined world-caret" aria-hidden="true">expand_more</span>
          <span>{t('worldState.subjectsSection')}</span>
          <span className="world-picker-count">{t('worldState.subjectCount', { count: subjects.length })}</span>
        </button>
        <div
          className="world-picker-body"
          ref={pickerScrollRef}
          onScroll={pickerWin.onScroll}
        >
          {pickerWin.virtualized && (
            <div className="world-scroll-pad" style={{ height: pickerWin.padTop }} aria-hidden="true" />
          )}
          {windowedPickerRows.map((row) => row.kind === 'head' ? (
            <button
              key={`head-${row.group.type}`}
              type="button"
              className={`world-group-head${collapsedTypes.has(row.group.type) ? ' is-collapsed' : ''}`}
              onClick={() => toggleType(row.group.type)}
              aria-expanded={!collapsedTypes.has(row.group.type)}
            >
              <span className="material-symbols-outlined world-caret" aria-hidden="true">expand_more</span>
              <span>{row.group.label}</span>
              <span className="world-group-count">{row.group.rows.length}</span>
            </button>
          ) : (
            <button
              key={row.subject.id}
              type="button"
              className={`world-subject-row${view === 'subject' && selectedSubjectId === row.subject.id ? ' is-selected' : ''}`}
              onClick={() => goWorldSubject(row.subject.id)}
            >
              <AxisDots axes={row.subject.axes} t={t} />
              <span className="world-subject-name">
                {subjectDisplayName(row.subject)}
                <span className="world-subject-id">{subjectSlug(row.subject)}</span>
              </span>
              <span className="world-subject-last">
                {row.subject.lastStoryTime !== null
                  ? t('worldState.lastChangeAt', { t: row.subject.lastStoryTime })
                  : t('worldState.neverWritten')}
              </span>
            </button>
          ))}
          {pickerWin.virtualized && (
            <div className="world-scroll-pad" style={{ height: pickerWin.padBottom }} aria-hidden="true" />
          )}
          {groups.length === 0 && (
            <div className="world-subject-last" style={{ padding: 'var(--space-xs) var(--space-sm)' }}>
              {t('worldState.noMatch')}
            </div>
          )}
        </div>
      </section>

      <div
        className={`world-spine${view === 'overview' ? '' : ' is-stacked'}`}
        ref={l1ScrollRef}
        onScroll={l1Win.onScroll}
      >
        {renderSpine()}
      </div>
    </div>
  );
}
