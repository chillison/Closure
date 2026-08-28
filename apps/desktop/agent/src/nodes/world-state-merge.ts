import {
  createSubjectRef,
  parseSubjectRef,
  type WorldPatchInput,
  type WorldSubject,
} from '@orison/shared-contracts';

// ── Story 6.6 Phase C1：世界状态 merge 纯函数（design §3 / ADR-3 纯代码机械组装）──
//
// mergeWorldEvents = 把 5 轴提取器的输出**机械组装**成可写入的 slice + patches + subjects（**非语义对账**）。
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical）：merge 只做查询/汇编/去重/链接——
//   - storyTime 窗对齐：同 storyTime 跨轴 patches 归同 slice。
//   - 跨轴引用链接：扫描 patch value 内 `subject://` ref，确保被引用的主体登记。
//   - 收集涉及 subjects：首次提取建主体，firstSeenStoryTime = 该主体出现的最早 storyTime。
//   - 保留 objective/reader_perceived 分层不消解（分层由 patch value 结构承载，merge 不合并 value）。
// 不判「这条 patch 对不对」「主体重不重要」（归提取器 LLM + Reader-Audit）。
//
// C1 仅 physical 轴（perAxis.physical）；接口接受多轴（C2 扩 cognitive/emotional/relational/factional）。
// 单轴时 mergeWorldEvents 退化为直通（一个 AxisExtraction → 一个 MergedWorldWrite），逻辑同多轴。
//
// 稳定 slice.id = `${episodeId}:${storyTime}`（per-slice idempotency，Phase B insertWorldSlice 要求：
// 重提取同 slice.id 时替换其 patches 不累积）。跨轴同 storyTime 共享一个 slice.id → patches 合并写入。

// ── 提取器输出类型（提取器 LLM 产；subjects 无 firstSeenStoryTime——merge 按 storyTime 赋）──

/**
 * 提取器产的主体登记（无 firstSeenStoryTime，merge 跨轴收集时赋最早 storyTime）。
 *
 * 有 asset_cards 卡的主体 sourceCardId 引用卡 id（对齐目标轨，引用不复制静态字段，asset-card-model.md
 * 静态/动态边界）；无卡的（群体/世界/任务）sourceCardId 缺省。
 */
export interface ExtractedSubject {
  id: string;
  type: string;
  name?: string;
  sourceCardId?: string;
}

/**
 * 提取器产的 patch（WorldPatchInput + grounding 正文锚定）。
 *
 * grounding = 正文原文引用（审计/追溯用）；**写表时丢弃**（WorldPatchInput 无此字段，DB 不存）。
 * 故 merge 输出的 MergedWorldWrite.patches 为 WorldPatchInput[]（grounding 剥离）。
 */
export interface ExtractedPatch extends WorldPatchInput {
  /** 正文原文引用锚定（审计用；写表时丢弃，WorldPatchInput schema 无此字段）。 */
  grounding?: string;
}

/**
 * 单轴提取输出（提取器 LLM 产一个 AxisExtraction per axis）。
 *
 * - storyTime：本章事件的主故事时间（C1 单 storyTime per axis per 章；C2 多轴可能各异，merge 按 storyTime 对齐）。
 * - title：该切面的简短标题。
 * - patches：该轴提取的变更（无 storyTime——storyTime 由所属 slice 承载；带 grounding 审计锚）。
 * - subjects：该轴涉及的主体（首次出现登记；firstSeenStoryTime 由 merge 赋）。
 */
export interface AxisExtraction {
  storyTime: number;
  title: string;
  patches: ExtractedPatch[];
  subjects: ExtractedSubject[];
}

/**
 * 5 轴提取集合（C1 仅 physical；C2 扩其余 4 轴）。
 *
 * 每轴 optional——未跑的轴缺省（merge 跳过）。C1 只有 physical 非空。
 */
export interface PerAxisEvents {
  physical?: AxisExtraction;
  cognitive?: AxisExtraction;
  emotional?: AxisExtraction;
  relational?: AxisExtraction;
  factional?: AxisExtraction;
}

/**
 * 一个 storyTime 的合并写入（slice 元信息 + patches + subjects，供 write_world_events 落表）。
 *
 * - sliceId：稳定 id = `${episodeId}:${storyTime}`（per-slice idempotency）。
 * - episodeId：Story 8.1 落 `closure_world_slice.episode_id` 列（显式归属锚，免 slice.id 前缀解析
 *   magic string——per-episode 查询 / ChapterStateSummary 物化用，design §4「写路径 insertWorldSlice 落列」）。
 * - patches：该 storyTime 下跨轴合并的 WorldPatchInput[]（grounding 已剥离）。
 * - subjects：该 storyTime 涉及的 WorldSubject[]（firstSeenStoryTime = 该 storyTime；跨轴去重 + COALESCE）。
 */
export interface MergedWorldWrite {
  sliceId: string;
  episodeId: string;
  storyTime: number;
  title: string;
  kind?: string;
  summary?: string;
  patches: WorldPatchInput[];
  subjects: WorldSubject[];
}

/**
 * mergeWorldEvents：纯代码机械组装 5 轴提取输出为可写入的 slice 集合（**非语义对账**，ADR-3）。
 *
 * 步骤：
 *  1. 收集所有非空 AxisExtraction（C1 仅 physical）。
 *  2. **storyTime 窗对齐**：按 storyTime 分组（Map），同 storyTime 跨轴 patches + subjects 归同组。
 *  3. **跨轴引用链接**：扫每组 patches value 内 `subject://` ref；被引用的主体若不在该组 subjects 内，补登记
 *     （type 推断为 'entity' 泛型——merge 不臆测 type，仅保证 ref 目标有主体行；提取器应已主动登记，此处兜底）。
 *  4. **subjects 收集**：组内 subjects 跨轴去重（同 id 合并，name/sourceCardId 取 COALESCE 首次非空）+
 *     firstSeenStoryTime = 该组 storyTime（主体在该 storyTime 首次出现）。
 *  5. **稳定 slice.id** = `${episodeId}:${storyTime}`；title 取该组首个 AxisExtraction.title（机械，非语义挑选）。
 *  6. 按 storyTime 升序返回 MergedWorldWrite[]（调用方逐个 write_world_events 落表）。
 *
 * 不消解 objective/reader_perceived 分层：patch value 结构原样保留（如 {objective:...,reader_perceived:...}
 * 对象 value 直传，merge 不拍平/不合并——分层由提取器在 value 结构内表达，reduce 时按 path 寻址）。
 *
 * **CR-2**：episodeId 缺省（空串）→ 返 []（不写）。避 slice.id 退 'unknown:storyTime' 跨章节撞（多章都用
 * 'unknown' 前缀致同 storyTime 的 slice.id 撞 → per-slice idempotency 误替换他章 patches）。caller
 * （createWorldMergeNode）空 writes 不调 write_world_events（graceful）+ warning 日志。
 *
 * **CR-E8**：组 patches 全空 → 跳过该组（不产 MergedWorldWrite）。NeuroBook subject-lifecycle §3「不存在
 * 没有 patch 的切面」——空 patches 不写 slice（避空 slice 行 + 无意义 subject 登记）。
 *
 * @param perAxis   5 轴提取集合（C1 仅 physical 非空）。
 * @param episodeId 本章 episode id（稳定 slice.id 前缀；空串/缺省 → 返 []，不写）。
 * @returns         MergedWorldWrite[]（按 storyTime 升序；空输入/缺 episodeId/全空 patches → []）。
 */
export function mergeWorldEvents(perAxis: PerAxisEvents, episodeId: string): MergedWorldWrite[] {
  // CR-2：episodeId 缺省不写（避 'unknown:storyTime' 跨章节 slice.id 撞 → 误替换他章 patches）。
  if (!episodeId) return [];

  const extractions = collectExtractions(perAxis);
  if (extractions.length === 0) return [];

  // 按 storyTime 分组（Map 保插入序；同 storyTime 跨轴归同组）。
  // 每组聚合：title（首个非空）+ patches（跨轴 concat）+ subjectStubs（跨轴 concat，去重在 buildSubjects）。
  const groups = new Map<number, { storyTime: number; title: string; patches: ExtractedPatch[]; subjectStubs: ExtractedSubject[] }>();
  for (const ext of extractions) {
    const existing = groups.get(ext.storyTime);
    if (existing) {
      existing.patches.push(...ext.patches);
      existing.subjectStubs.push(...ext.subjects);
      // title 取首个非空（机械，非语义挑选）；已存在则保留首个。
      if (!existing.title && ext.title) existing.title = ext.title;
    } else {
      groups.set(ext.storyTime, {
        storyTime: ext.storyTime,
        title: ext.title,
        patches: [...ext.patches],
        subjectStubs: [...ext.subjects],
      });
    }
  }

  const writes: MergedWorldWrite[] = [];
  for (const group of groups.values()) {
    // CR-E8：组 patches 全空 → 跳过（NeuroBook subject-lifecycle §3「不存在没有 patch 的切面」；
    // 空 patches 不写 slice + 不登记 subjects——纯空提取轴不污染 timeline）。
    if (group.patches.length === 0) continue;

    const subjects = buildSubjects(group.subjectStubs, group.storyTime);
    // 跨轴引用链接：扫 patches value 内 subject:// ref，补登记缺失主体（兜底；提取器应已登记）。
    linkReferencedSubjects(group.patches, subjects, group.storyTime);

    writes.push({
      sliceId: `${episodeId}:${group.storyTime}`,
      episodeId,
      storyTime: group.storyTime,
      title: group.title || `storyTime ${group.storyTime}`,
      patches: group.patches.map(toWorldPatchInput),
      subjects,
    });
  }

  // 按 storyTime 升序（稳定排序，JS sort 稳定）。
  writes.sort((a, b) => a.storyTime - b.storyTime);
  return writes;
}

// ── helpers ──

/** 收集 PerAxisEvents 中所有非空 AxisExtraction（保留轴序：physical→cognitive→emotional→relational→factional）。 */
function collectExtractions(perAxis: PerAxisEvents): AxisExtraction[] {
  const out: AxisExtraction[] = [];
  // 轴序固定（保 storyTime 分组内 patches 跨轴顺序稳定，便于 reduce 同 storyTime 同 source 内按原序）。
  const axes: readonly (keyof PerAxisEvents)[] = [
    'physical',
    'cognitive',
    'emotional',
    'relational',
    'factional',
  ];
  for (const axis of axes) {
    const ext = perAxis[axis];
    if (ext) out.push(ext);
  }
  return out;
}

/**
 * 跨轴去重 + COALESCE 主体，赋 firstSeenStoryTime。
 *
 * 同 id 主体合并：name/sourceCardId 取 COALESCE 首次非空（C1 单轴无重复，多轴时跨轴同名主体合并）。
 * type 取首次出现值（同 id 主体 type 应稳定；若跨轴不一致取首个，不臆测）。
 */
function buildSubjects(stubs: ExtractedSubject[], storyTime: number): WorldSubject[] {
  const byId = new Map<string, WorldSubject>();
  for (const stub of stubs) {
    const existing = byId.get(stub.id);
    if (existing) {
      // COALESCE：name / sourceCardId 首次非空优先（不 clobber 已有非空值）。
      if (!existing.name && stub.name) existing.name = stub.name;
      if (!existing.sourceCardId && stub.sourceCardId) existing.sourceCardId = stub.sourceCardId;
    } else {
      const subject: WorldSubject = {
        id: stub.id,
        type: stub.type,
        firstSeenStoryTime: storyTime,
      };
      if (stub.name !== undefined) subject.name = stub.name;
      if (stub.sourceCardId !== undefined) subject.sourceCardId = stub.sourceCardId;
      byId.set(stub.id, subject);
    }
  }
  return [...byId.values()];
}

/**
 * 扫 patches value 内 `subject://<id>` ref；被引用主体不在 subjects 内则补登记（type='entity' 泛型兜底）。
 *
 * 跨轴引用链接（design §3）：如 physical 轴 /equipment/weapon = "subject://sword-01"，sword-01 须有主体行。
 * 提取器应已主动登记（physical 轴产 sword-01 subject）；此处是兜底（提取器漏登记时补 stub，避悬空 ref）。
 * type='entity' 是泛型——merge 不臆测被引用主体的精确 type（人物/物品/地点），由后续提取或修补 Agent 细化。
 *
 * CR-8：扫**所有** ref（非首个）——value 可能含多个 ref（如 {weapon:"subject://sword-01", accessory:"subject://ring-01"}
 * 或数组 ["subject://a","subject://b"]），所有被引用主体都须登记，否则除首个外的 ref 悬空。
 */
function linkReferencedSubjects(
  patches: ExtractedPatch[],
  subjects: WorldSubject[],
  storyTime: number,
): void {
  const ids = new Set(subjects.map((s) => s.id));
  for (const patch of patches) {
    const refIds = extractSubjectRefIds(patch.value);
    for (const refId of refIds) {
      if (!ids.has(refId)) {
        subjects.push({
          id: refId,
          type: 'entity',
          firstSeenStoryTime: storyTime,
        });
        ids.add(refId);
      }
    }
  }
}

/**
 * 从 patch value 抽**所有** `subject://<id>` 引用的目标 id（CR-8：非首个，全量）。
 *
 * value 可能是：直接 ref 串（"subject://sword-01"）/ 对象（{objective:..., reader_perceived:...}，含多 ref）
 * / 数组（["subject://a","subject://b"]）。递归扫，收集所有遇到的 subject:// ref 的 id（去重由 caller ids Set 处理）。
 * 非 ref value（数值/普通串/无 subject://）→ 空数组。
 */
function extractSubjectRefIds(value: unknown): string[] {
  const ids: string[] = [];
  collectSubjectRefIds(value, ids);
  return ids;
}

/** 递归收集 value 内所有 subject:// ref id 到 out 数组（extractSubjectRefIds 的递归实现）。 */
function collectSubjectRefIds(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const id = parseSubjectRef(value);
    if (id) out.push(id);
    return;
  }
  if (Array.isArray(value)) {
    for (const el of value) collectSubjectRefIds(el, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectSubjectRefIds(v, out);
  }
}

/** ExtractedPatch → WorldPatchInput（剥离 grounding，保留 WorldPatchInput 全字段）。 */
function toWorldPatchInput(patch: ExtractedPatch): WorldPatchInput {
  const out: WorldPatchInput = {
    subjectId: patch.subjectId,
    path: patch.path,
    op: patch.op,
    axis: patch.axis,
  };
  if (patch.value !== undefined) out.value = patch.value;
  if (patch.summary !== undefined) out.summary = patch.summary;
  // grounding 刻意不传（WorldPatchInput schema 无此字段，DB 不存；审计用，留在提取器 artifact 内）。
  return out;
}

// 重新导出 createSubjectRef 便利（调用方可直接构造引用串，merge 模块单源）。
export { createSubjectRef };
