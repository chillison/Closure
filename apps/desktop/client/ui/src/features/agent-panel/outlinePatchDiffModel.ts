/**
 * dogfood R2 批次 D1（详设第三节 · 断层①「草案冒结构接通」）：outline / episode_outlines
 * patch 的结构化 diff 纯模型。ADR-3 范式判据：by-id/按位 identity 配对与内容比对是机械
 * 投影，归纯代码；「这段大纲好不好」的语义判断零参与。
 *
 * 数据源（改前值可得性结论）：patch envelope 的 entry.data 是 **schema 必填收紧（CR-1 B
 * 方案）后过校验的全量** outline_v2 / episode 数组——shell handler 不做投影（直通），全量
 * 性由 agent 侧 schema 必填保证（mirror scene_graph「entry.data IS the staged graph」语义，
 * 见 creativeFieldsSlice setPendingPatch 注释）；改前值 = store
 * creativeFields[field]（与 PatchReviewPanel 的 currentValue 同源）——before/after 双边
 * 可得，无需「单边渲染新值」降级路径。
 *
 * unknown 边界：patch.data 类型是 unknown（zod 校验在 shell 信任边界），本模型全防御
 * shape-guard（mirror NarrativeTimelinePanel isSceneGraphLike 先例）——残缺形态逐项跳过
 * 不抛，宁可少显示不炸审查卡。
 */

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

/** Verbatim 从 PatchReviewPanel 迁来（结构化 diff 的裸 JSON 回退路径共用），零行为变化。 */
export function prettyPatchData(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    return String(data);
  }
}

// ── shape guards（unknown → 受窄形态；非法项跳过非抛） ──

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export type PhaseLike = {
  id: string;
  title: string;
  goal?: string;
  antagonist?: string;
  climax?: string;
  hook?: string;
  estimated_chapters?: number;
};

function asPhases(v: unknown): PhaseLike[] {
  if (!Array.isArray(v)) return [];
  const out: PhaseLike[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    const id = asStr(rec?.id);
    const title = asStr(rec?.title);
    if (!rec || !id || !title) continue; // 残缺卷跳过（shell zod 已校验，此处兜底）
    out.push({
      id,
      title,
      goal: asStr(rec.goal),
      antagonist: asStr(rec.antagonist),
      climax: asStr(rec.climax),
      hook: asStr(rec.hook),
      estimated_chapters: asNum(rec.estimated_chapters),
    });
  }
  return out;
}

const TURNING_POINT_TYPES = ['core-anchor', 'secondary-anchor', 'fork-point'] as const;
export type TurningPointType = (typeof TURNING_POINT_TYPES)[number];
export type TurningPointLike = { type: TurningPointType; label: string; description?: string };

function asTurningPoints(v: unknown): TurningPointLike[] {
  if (!Array.isArray(v)) return [];
  const out: TurningPointLike[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    const type = asStr(rec?.type);
    const label = asStr(rec?.label);
    if (!rec || !type || !TURNING_POINT_TYPES.includes(type as TurningPointType) || !label) continue;
    out.push({ type: type as TurningPointType, label, description: asStr(rec.description) });
  }
  return out;
}

function asStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string');
}

export type EpisodeLike = {
  id: string;
  index: number;
  title: string;
  purpose?: string;
  summary?: string;
  hook?: string;
};

function asEpisodes(v: unknown): EpisodeLike[] {
  if (!Array.isArray(v)) return [];
  const out: EpisodeLike[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    const id = asStr(rec?.id);
    const title = asStr(rec?.title);
    if (!rec || !id || !title) continue;
    out.push({
      id,
      index: asNum(rec.index) ?? 0,
      title,
      purpose: asStr(rec.purpose),
      summary: asStr(rec.summary),
      hook: asStr(rec.hook),
    });
  }
  return out;
}

// ── outline diff ──

/** 顶层文本字段（全部 optional string）：核心三件 + 自由文本位，统一「改写行」渲染。 */
export type CoreFieldKey =
  | 'story_type'
  | 'writing_style'
  | 'central_conflict'
  | 'main_goal'
  | 'ending_direction'
  | 'characters'
  | 'arc_design_notes'
  | 'pacing_design_notes';

const CORE_FIELD_KEYS: CoreFieldKey[] = [
  'story_type',
  'writing_style',
  'central_conflict',
  'main_goal',
  'ending_direction',
  'characters',
  'arc_design_notes',
  'pacing_design_notes',
];

export type CoreFieldDiff = {
  key: CoreFieldKey;
  kind: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
};

export type PhaseFieldKey = 'title' | 'goal' | 'antagonist' | 'climax' | 'hook' | 'estimated_chapters';
const PHASE_FIELD_KEYS: PhaseFieldKey[] = ['title', 'goal', 'antagonist', 'climax', 'hook', 'estimated_chapters'];

export type PhaseFieldChange = { key: PhaseFieldKey; oldText: string; newText: string };

export type PhaseDiff =
  | { kind: 'added'; phase: PhaseLike }
  | { kind: 'removed'; phase: PhaseLike }
  | { kind: 'changed'; phase: PhaseLike; changes: PhaseFieldChange[] };

/**
 * 转折点 schema 无 id（majorTurningPointSchema 只有 type/label/description）——identity 用
 * 位置配对：同位不同 = changed（label 旧→新的改写行即任务所述形态），尾差 = added/removed。
 * 中段插入会级联显示 changed——V1 边界：无 id 无从精确对齐，按位配对是最诚实的机械事实。
 */
export type TurningPointDiff =
  | { kind: 'added'; tp: TurningPointLike }
  | { kind: 'removed'; tp: TurningPointLike }
  | { kind: 'changed'; before: TurningPointLike; after: TurningPointLike };

export type ConstraintDiff = { kind: 'added' | 'removed' | 'changed'; before?: string; after?: string };

export type OutlineDiff = {
  core: CoreFieldDiff[];
  phases: PhaseDiff[];
  turningPoints: TurningPointDiff[];
  constraints: ConstraintDiff[];
  stats: { addedPhases: number; addedTurningPoints: number; coreRewrites: number };
};

const phaseText = (p: PhaseLike, key: PhaseFieldKey): string => {
  const v = p[key];
  return v === undefined || v === '' ? '' : String(v);
};

function diffPhases(before: PhaseLike[], after: PhaseLike[]): PhaseDiff[] {
  const beforeById = new Map(before.map((p) => [p.id, p]));
  const afterIds = new Set(after.map((p) => p.id));
  const result: PhaseDiff[] = [];
  // 顺序按 after（新大纲的卷序即作者将看到的序）；删除卷排尾部。
  for (const p of after) {
    const old = beforeById.get(p.id);
    if (!old) {
      result.push({ kind: 'added', phase: p });
      continue;
    }
    const changes: PhaseFieldChange[] = [];
    for (const key of PHASE_FIELD_KEYS) {
      const oldText = phaseText(old, key);
      const newText = phaseText(p, key);
      if (oldText !== newText) changes.push({ key, oldText, newText });
    }
    if (changes.length > 0) result.push({ kind: 'changed', phase: p, changes });
  }
  for (const p of before) {
    if (!afterIds.has(p.id)) result.push({ kind: 'removed', phase: p });
  }
  return result;
}

function diffTurningPoints(before: TurningPointLike[], after: TurningPointLike[]): TurningPointDiff[] {
  const result: TurningPointDiff[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const b = before[i];
    const a = after[i];
    if (!b) { result.push({ kind: 'added', tp: a! }); continue; }
    if (!a) { result.push({ kind: 'removed', tp: b }); continue; }
    if (b.type !== a.type || b.label !== a.label || b.description !== a.description) {
      result.push({ kind: 'changed', before: b, after: a });
    }
  }
  return result;
}

function diffConstraints(before: string[], after: string[]): ConstraintDiff[] {
  const result: ConstraintDiff[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const b = before[i];
    const a = after[i];
    if (b === undefined) { result.push({ kind: 'added', after: a }); continue; }
    if (a === undefined) { result.push({ kind: 'removed', before: b }); continue; }
    if (b !== a) result.push({ kind: 'changed', before: b, after: a });
  }
  return result;
}

function diffCore(beforeRec: Record<string, unknown> | null, afterRec: Record<string, unknown>): CoreFieldDiff[] {
  const out: CoreFieldDiff[] = [];
  for (const key of CORE_FIELD_KEYS) {
    const b = asStr(beforeRec?.[key]);
    const a = asStr(afterRec[key]);
    if (b === a) continue;
    out.push({ key, before: b, after: a, kind: b === undefined ? 'added' : a === undefined ? 'removed' : 'changed' });
  }
  return out;
}

export function diffOutline(before: unknown, after: unknown): OutlineDiff {
  const beforeRec = asRecord(before);
  const afterRec = asRecord(after) ?? {};
  const core = diffCore(beforeRec, afterRec);
  const phases = diffPhases(asPhases(beforeRec?.phases), asPhases(afterRec.phases));
  const turningPoints = diffTurningPoints(
    asTurningPoints(beforeRec?.major_turning_points),
    asTurningPoints(afterRec.major_turning_points),
  );
  const constraints = diffConstraints(asStrings(beforeRec?.constraints), asStrings(afterRec.constraints));
  return {
    core,
    phases,
    turningPoints,
    constraints,
    stats: {
      addedPhases: phases.filter((p) => p.kind === 'added').length,
      addedTurningPoints: turningPoints.filter((tp) => tp.kind === 'added').length,
      coreRewrites: core.length,
    },
  };
}

/**
 * PatchReviewPanel 落盘跳转目标（D1）：首个新增卷 id（after 中首个 before 没有的卷）。
 * 无新增卷 → null（调用方回退 core 区）。before/after 形态残缺 → 同样 null，机械降级。
 */
export function firstAddedPhaseId(before: unknown, after: unknown): string | null {
  const beforeIds = new Set(asPhases(asRecord(before)?.phases).map((p) => p.id));
  for (const p of asPhases(asRecord(after)?.phases)) {
    if (!beforeIds.has(p.id)) return p.id;
  }
  return null;
}

// ── episode_outlines diff（R1 简版，任务边界）──
// 按 id diff 出 added/removed/changed 计数 + 一行式（id + purpose），不做字段级卡——
// episode 字段深（character_progressions/emotional_beats 等数组级 diff）是 V1 边界外；
// changed 以「任一展示字段（index/title/purpose/summary/hook）变化」判。

export type EpisodeDiffEntry = { kind: 'added' | 'removed' | 'changed'; before?: EpisodeLike; after?: EpisodeLike };
export type EpisodeDiff = { entries: EpisodeDiffEntry[]; stats: { added: number; removed: number; changed: number } };

function episodeChanged(before: EpisodeLike, after: EpisodeLike): boolean {
  return (
    before.index !== after.index
    || before.title !== after.title
    || before.purpose !== after.purpose
    || before.summary !== after.summary
    || before.hook !== after.hook
  );
}

export function diffEpisodes(before: unknown, after: unknown): EpisodeDiff {
  const beforeArr = asEpisodes(before);
  const afterArr = asEpisodes(after);
  const beforeById = new Map(beforeArr.map((e) => [e.id, e]));
  const afterIds = new Set(afterArr.map((e) => e.id));
  const entries: EpisodeDiffEntry[] = [];
  for (const e of afterArr) {
    const old = beforeById.get(e.id);
    if (!old) { entries.push({ kind: 'added', after: e }); continue; }
    if (episodeChanged(old, e)) entries.push({ kind: 'changed', before: old, after: e });
  }
  for (const e of beforeArr) {
    if (!afterIds.has(e.id)) entries.push({ kind: 'removed', before: e });
  }
  return {
    entries,
    stats: {
      added: entries.filter((e) => e.kind === 'added').length,
      removed: entries.filter((e) => e.kind === 'removed').length,
      changed: entries.filter((e) => e.kind === 'changed').length,
    },
  };
}

// ── 拦截判定（PatchReviewPanel 接线用）──

/**
 * 结构化 diff 拦截门：outline 需要 object envelope（schema 必填收紧后过校验的载荷即全量，
 * shell handler 不做投影——CR-1），episode_outlines 需要数组。action 门在调用方：仅
 * `=== 'set'` 进结构化 diff——merge 是部分载荷，未提及的 phase/episode 会被 diff 成整片
 * 红删（CR-6），与 delete / 形态不完整一起照旧裸 JSON 回退。
 */
export function isStructuredDiffable(field: string, after: unknown): boolean {
  if (field === 'outline') return asRecord(after) !== null;
  if (field === 'episode_outlines') return Array.isArray(after);
  return false;
}
