import { derivePromiseStage } from './creative-fields';
import type { PromiseBeat, PromiseDerivedStage, PromiseEntry } from './creative-fields';
import { estimateTextTokens, TOKEN_ESTIMATE_CHARS_PER_TOKEN } from './compile-report';
import {
  CHARACTER_END_STATES_CAP,
  FORESHADOW_CHANGES_CAP,
  NEW_ENTITIES_CAP,
  NEXT_CHAPTER_PAYOFFS_CAP,
  OPEN_PROMISES_CAP,
  ORACLE_DORMANT_CAP,
  RELATIONSHIP_CHANGES_CAP,
} from './world-state';
import type {
  ChapterStateSummary,
  CharacterEndState,
  ForeshadowChange,
  NewEntity,
  NextChapterPayoff,
  OpenPromiseEntry,
  OracleDormantEntry,
  ReducedState,
  RelationshipChange,
  WorldIssue,
  WorldKind,
  WorldPatch,
  WorldPatchSource,
  WorldStateSnapshot,
  WorldStateSubjectSnapshot,
} from './world-state';

// ── Story 6.6 Phase A：reduce 纯函数（NeuroBook subject-lifecycle §4-§5 / schema-system §2-§3）──
//
// 任意虚构时刻的 subject 状态 = 该时刻前所有 patch 按 storyTime 升序（同 storyTime 同 source 内按原序）、
// 按 kind 叠加出来的结果。截断 at（at 缺省取最新）。reduce 永远只算单个 subject，引用不自动展开。
//
// 范式判据（ADR-3）：reduce 是纯代码确定性计算（查询/汇编/插值/叠加），无 LLM/无 db/无 fs/无副作用。
// 输入 WorldPatch[] + subjectId + at?，输出 { state, issues }——纯函数，同输入恒同输出（可缓存/可并行）。
//
// 严格照 NeuroBook schema-system.md §2 kind 表 + §3 op 语义：
//
//   kind       | op              | reduce 语义
//   -----------|-----------------|-----------------------------------------------------------
//   scalar     | replace         | 后写覆盖前值（绝对值）。
//             | increment       | 当前值（数值）累加；缺基准/非数值 → broken-relative；结果须有限数。
//             | remove          | 删 path。
//   list       | replace         | 整组替换（value 须数组）。
//             | append          | 末尾追加单元素（不支持中间插，补历史插更早 slice）。
//             | remove          | 删 path（不带 value）；list 带 value → invalid-op（拒绝）。
//   collection | replace         | 整组替换（value 须数组）。
//             | append          | 按 stable JSON 值去重追加（已存在则跳过）。
//             | remove          | 不带 value 删 path / 带 value 按 stable JSON 删元素（找不到幂等）。
//   object     | replace         | 子路径 replace（set 嵌套 key）/ 整体 replace（换整个对象）。
//             | remove          | 子路径 remove（删嵌套 key）/ 整体 remove（清空）。
//             | (inc/append)    | invalid-op（object 不接受 increment/append）。
//
// schema 宽松动态不预设字段（NeuroBook §8）：kind 由调用方 kindResolver 声明优先，否则由当前值推断
// （Array→list 默认 / plain object→object / 其余→scalar）。list vs collection 区分需 kindResolver 显式声明
// （NeuroBook：z.array() 默认 list，.unique() 才是 collection）。
//
// 派生 + amendment 两层同算：patches 不分 source 全叠加；同 storyTime 时 derived 先于 amendment（amendment
// 是修正层，应用于 derived 之上——design §3 amendment 覆盖层语义）。reduce 不按 source 过滤；source 区分是
// 表层（重跑提取 derived 重建 / amendment 清零归 Phase B 写入侧，非 reduce 职责）。

/** 调用方声明的 per-path kind（可选）。接收 patch 全 path（如 `/inventory`、`/equipment/weapon`），返该 path 的 kind 或 undefined（fallback 到值推断）。 */
export type WorldKindResolver = (path: string) => WorldKind | undefined;

export interface ReduceSubjectOptions {
  /**
   * 可选 kind 解析器。schema 宽松动态不预设字段——默认由当前值推断（Array→list / object→object / 其余→scalar）。
   * collection 去重/remove-按值 需显式声明（无 schema 时 array 默认 list）。调用方按需 match exact path 或前缀。
   */
  kindResolver?: WorldKindResolver;
}

/** 同 storyTime 时的 source 叠加序：derived (0) 先于 amendment (1)——amendment 是修正覆盖层。 */
const SOURCE_ORDER: Record<WorldPatchSource, number> = { derived: 0, amendment: 1 };

// ── JSON Pointer (RFC 6902) 解析/寻址 ──

/** 解析 JSON Pointer path → 解码后的段数组。`''` → `[]`（root）；非 `/` 开头或非空 → null（非法）。 */
function parsePointer(path: string): string[] | null {
  if (path === '') return [];
  if (!path.startsWith('/')) return null;
  // 以 `/` 切分，丢掉 leading `/` 产生的空串；逐段 ~1→/ / ~0→~ 解码（~1 先，RFC 6902 顺序）。
  return path.split('/').slice(1).map((tok) => unescapeToken(tok));
}

function unescapeToken(tok: string): string {
  return tok.replace(/~1/g, '/').replace(/~0/g, '~');
}

// ── 类型 guard ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── stable JSON（collection 去重 / remove-按值 匹配）──
// 对 plain object key 排序递归——结构相同即匹配（{a:1,b:2} === {b:2,a:1}）。NaN/undefined 等非 JSON
// 值由调用方/提取器自律（NeuroBook：patch value 须严格 JSON）。
function stableJsonStringify(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJsonStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableJsonStringify((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

// ── 状态寻址（嵌套对象，叶由 JSON Pointer 段寻址）──

function getState(root: ReducedState, segments: string[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (isPlainObject(cur)) cur = cur[seg];
    else if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else return undefined;
  }
  return cur;
}

function setState(root: ReducedState, segments: string[], value: unknown): void {
  // root-level replace（segments=[]）：清空根再拷贝（value 须 plain object 才有意义）。
  if (segments.length === 0) {
    for (const k of Object.keys(root)) delete root[k];
    if (isPlainObject(value)) Object.assign(root, value);
    return;
  }
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next: unknown = cur[seg];
    // 中间段缺失/非 object → 建空对象（object 子路径导航；array 索引中间段 Phase A 不建）。
    if (!isPlainObject(next)) {
      const created: Record<string, unknown> = {};
      cur[seg] = created;
      cur = created;
    } else {
      cur = next;
    }
  }
  cur[segments[segments.length - 1]] = value;
}

function deleteState(root: ReducedState, segments: string[]): void {
  if (segments.length === 0) {
    for (const k of Object.keys(root)) delete root[k];
    return;
  }
  let cur: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (isPlainObject(cur)) cur = cur[seg];
    else return; // 中间段不可导航 → 无可删（幂等）。
  }
  if (isPlainObject(cur)) delete cur[segments[segments.length - 1]];
}

// ── kind 解析（resolver 优先，fallback 值推断）──

function resolveKind(
  path: string,
  currentValue: unknown,
  resolver: WorldKindResolver | undefined,
): WorldKind {
  if (resolver) {
    const declared = resolver(path);
    if (declared) return declared;
  }
  // 值推断：Array → list（NeuroBook z.array() 默认）/ plain object → object / 其余 → scalar。
  if (Array.isArray(currentValue)) return 'list';
  if (isPlainObject(currentValue)) return 'object';
  return 'scalar';
}

/**
 * 在 seed 折叠态之上叠加一批 patches（Story 8.1 seeded reduce 原语，checkpoint 路径核心）。纯函数
 * （无 LLM/无 db/无 fs/无副作用）。
 *
 * 等价性（design §3.2）：reduce 是纯折叠——`applyPatches(ckpt.state, window)` ≡ 全量 fold（seed +
 * (ckpt.at, at] 窗 ≡ 全史；排序键不变：storyTime 升序 + derived 先 amendment + 输入序稳定）。issue 语义：
 * 本函数只返**本批 patches** 产生的 issues；seed 侧累计计数由 checkpoint.issueCount 承载（快照 issueCount
 * = ckpt.issueCount + 窗口 issues.length ≡ 全量 fold issues.length）。
 *
 * 防御：① seed 深拷贝（不污染调用方持有的 checkpoint state——cloneReducedState 保 undefined 值键）；
 * ② patches 规范化排序后应用（调用方无需预排序窗口；slice+稳定 sort 不改输入数组）；③ replace/append 存值
 * 深拷贝（不写穿 patch.value——同批 patch 对象可被重复 fold，是 checkpoint 等价性〔同输入恒同输出〕的前提；
 * 单次 fold 的可观察输出不变）。
 *
 * @param seed     起点折叠态（checkpoint state 或 {}）；plain object（ReducedState）。
 * @param patches  待叠加 patches（**不 filter subject / 不截断 at**——调用方负责窗口化；通常为单 subject 的
 *                 storyTime ∈ (ckptAt, at] 窗）。
 * @param options  可选 kindResolver（同 reduceSubject，声明 collection 等需显式 kind 的 path）。
 * @returns        { state: seed+patches 叠加后的折叠态（新对象）, issues: 本批被跳过 patch 的 E issues }。
 */
export function applyPatches(
  seed: ReducedState,
  patches: readonly WorldPatch[],
  options?: ReduceSubjectOptions,
): { state: ReducedState; issues: WorldIssue[] } {
  const state = cloneReducedState(seed) as ReducedState;
  const issues: WorldIssue[] = [];

  // 规范化排序（与 reduceSubject 同键：storyTime 升序 → derived 先 amendment → 输入序稳定）。
  const ordered = patches.slice().sort((a, b) => {
    if (a.storyTime !== b.storyTime) return a.storyTime - b.storyTime;
    return SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  });

  const resolver = options?.kindResolver;

  for (const patch of ordered) {
    const segments = parsePointer(patch.path);
    if (segments === null) {
      issues.push({
        code: 'invalid-op',
        path: patch.path,
        message: `invalid JSON Pointer path (must start with "/" or be empty): ${patch.path}`,
      });
      continue;
    }

    const currentValue = getState(state, segments);
    const kind = resolveKind(patch.path, currentValue, resolver);

    switch (patch.op) {
      case 'replace': {
        // list/collection 整组替换须数组（NeuroBook §2）；scalar/object replace 接任意值（绝对值）。
        if ((kind === 'list' || kind === 'collection') && !Array.isArray(patch.value)) {
          issues.push({
            code: 'invalid-op',
            path: patch.path,
            message: `${kind} replace requires an array value`,
          });
          continue;
        }
        setState(state, segments, cloneReducedState(patch.value));
        break;
      }

      case 'increment': {
        // 数值 scalar 专用。缺基准（undefined）→ broken-relative；存在但非有限数（string/object/array）
        // → invalid-op（op-kind 不匹配）；value 非有限数 → invalid-op；结果须有限数（NeuroBook §3）。
        if (currentValue === undefined) {
          issues.push({
            code: 'broken-relative',
            path: patch.path,
            message: 'increment lacks a base (no prior value at this path)',
          });
          continue;
        }
        if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) {
          issues.push({
            code: 'invalid-op',
            path: patch.path,
            message: 'increment requires a finite numeric base (current value is non-numeric)',
          });
          continue;
        }
        if (typeof patch.value !== 'number' || !Number.isFinite(patch.value)) {
          issues.push({
            code: 'invalid-op',
            path: patch.path,
            message: 'increment requires a finite numeric value',
          });
          continue;
        }
        const result = currentValue + patch.value;
        if (!Number.isFinite(result)) {
          // 溢出 → 非有限数结果（NeuroBook §3 increment 须仍是有限数）。
          issues.push({
            code: 'invalid-op',
            path: patch.path,
            message: 'increment result is not a finite number (overflow)',
          });
          continue;
        }
        setState(state, segments, result);
        break;
      }

      case 'append': {
        // 数组追加（单元素）。缺基准（undefined）→ broken-relative；存在但非数组 → invalid-op。
        if (currentValue === undefined) {
          issues.push({
            code: 'broken-relative',
            path: patch.path,
            message: 'append lacks a base (no prior array at this path — replace with [] first)',
          });
          continue;
        }
        if (!Array.isArray(currentValue)) {
          issues.push({
            code: 'invalid-op',
            path: patch.path,
            message: 'append requires an array base (current value is not an array)',
          });
          continue;
        }
        if (kind === 'collection') {
          // 按 stable JSON 去重追加（已存在则跳过）；存值深拷贝（不写穿 patch.value）。
          const valKey = stableJsonStringify(patch.value);
          if (!currentValue.some((el) => stableJsonStringify(el) === valKey)) {
            currentValue.push(cloneReducedState(patch.value));
          }
        } else {
          // list（含 array 默认推断）：末尾追加，不去重，不中间插；存值深拷贝（不写穿 patch.value）。
          currentValue.push(cloneReducedState(patch.value));
        }
        break;
      }

      case 'remove': {
        if (patch.value === undefined) {
          // 不带 value：删 path（路径不存在幂等）。适用所有 kind。
          deleteState(state, segments);
        } else {
          // 带 value：仅 collection 合法（按 stable JSON 删匹配元素，找不到幂等）。
          // list 带 value 被拒绝（NeuroBook §3）；scalar/object 带 value → invalid-op。
          if (kind !== 'collection' || !Array.isArray(currentValue)) {
            issues.push({
              code: 'invalid-op',
              path: patch.path,
              message: `remove with value requires a collection kind (got ${kind})`,
            });
            continue;
          }
          const valKey = stableJsonStringify(patch.value);
          // 逆序 splice 删所有匹配元素（collection 经 dedup 通常 ≤1，但 replace 可能引入重复，全删）。
          for (let i = currentValue.length - 1; i >= 0; i--) {
            if (stableJsonStringify(currentValue[i]) === valKey) currentValue.splice(i, 1);
          }
        }
        break;
      }

      default: {
        // CR-5：未知 op（schema 校验旁路时——如未经 Zod 的裸 IPC 入参直进 reduce）→ invalid-op issue +
        // 跳过该 patch（不静默吞）。照 NeuroBook 严格 op 全集：合法 op 在 schema 层枚举闭，此处 default 是
        // 防御 fallback，保 reduce 对脏数据鲁棒（worldStateRepository.patchRowToRecord 读表 / 查询工具直传）。
        issues.push({
          code: 'invalid-op',
          path: patch.path,
          message: `unknown op: ${String(patch.op)}`,
        });
        break;
      }
    }
  }

  return { state, issues };
}

/**
 * JSON 值形态深拷贝（Story 8.1：applyPatches seed 防污染）。不用 JSON.parse(JSON.stringify())——那会丢
 * undefined 值键（seed 侧 replace-undefined 写入的键需原样保留，保 seeded ≡ full-fold 严格等价）。
 */
function cloneReducedState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneReducedState);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) out[k] = cloneReducedState(value[k]);
    return out;
  }
  return value;
}

/**
 * reduce 一个 subject 在给定虚构时刻的状态。纯函数（无 LLM/无 db/无 fs/无副作用）。
 *
 * @param patches     全部候选 patch（reduce 自行 filter subjectId + 截断 at；调用方可传多 subject 全集）。
 * @param subjectId   要 reduce 的 subject id。
 * @param at          storyTime 截断点（仅叠加 storyTime <= at 的 patch）；缺省取最新（全叠加）。
 * @param options     可选 kindResolver（声明 collection 等需显式 kind 的 path）。
 * @returns           { state: 嵌套对象（叶由 path 寻址）, issues: 被跳过 patch的 E issue 清单 }。
 *
 * 严格照 NeuroBook schema-system.md §2 kind 表 + §3 op 语义。详见文件头注释。
 * Story 8.1 起主循环体抽为 applyPatches（seeded reduce 原语）；本函数 = 空 state 起 applyPatches 的特例，
 * 公共 API 与行为零变（既有测试零改全绿 = 重构正确性证明）。
 */
export function reduceSubject(
  patches: readonly WorldPatch[],
  subjectId: string,
  at?: number,
  options?: ReduceSubjectOptions,
): { state: ReducedState; issues: WorldIssue[] } {
  // 1. filter subject + 截断 at。
  // 2. 排序归一在 applyPatches 内（storyTime 升序 → derived 先于 amendment → 输入序稳定，同键）。
  const relevant = patches
    .filter((p) => p.subjectId === subjectId)
    .filter((p) => at === undefined || p.storyTime <= at);

  return applyPatches({}, relevant, options);
}

// ── Story 6.6 Phase D：buildWorldStateSnapshot（消费端反哺用章节级快照纯函数）──
//
// brief #6 stateAtT（per scene，Writer 知已建立状态）+ Reader-Audit 一致基底（chapter-level，对照已建立状态
// 找矛盾）共用此构造。从 patches 构造 snapshot：
// 1. filter at 截断（仅 storyTime <= at 的 patches；at undefined = 全叠加）。
// 2. 唯一 subjectId 收集（first-seen 序，按 storyTime 升序排后遍历），cap subjectCap 防全量倾倒（NeuroBook §8）。
// 3. 每 subjectId 调 reduceSubject（同 file 头 reduce 纯函数）→ 可选 attrs 顶层投影 → 收集非空状态。
//
// 范式判据（ADR-3）：snapshot 构造 = 纯代码 reduce（查询/汇编/叠加），无 LLM/无 db/无副作用。落 shared-contracts
// DRY：agent（query_world_slice builtin 取 patches）+ shell（worldStateRepository 取 patches）两入口共用同
// reduce 形态。「消费 snapshot 判是否矛盾」归 Reader-Audit LLM（ADR-3 语义裁判），非纯代码 diff。
//
// 调用方负责取 patches（agent 经 IPC builtin / shell 经 repository），本函数纯消费 patches → snapshot。
// 入参 patches 通常为「项目全集」（buildWorldStateSnapshot 内部 filter at 截断），调用方无须预过滤 storyTime。

/** buildWorldStateSnapshot 选项。 */
export interface BuildWorldStateSnapshotOptions {
  /**
   * 最多收录 subject 数（first-seen 序，防全量倾倒——成熟世界有几百 subject，全 reduce 会胀 prompt context）。
   * 默认 12（覆盖本章典型涉及的核心角色 + 关键物品/地点；超出按首次出现序截断）。
   */
  subjectCap?: number;
  /**
   * 顶层属性投影（NeuroBook §8 attrs 收窄）：只保留 state 顶层 key 在此列表的属性。
   * undefined / 空 = 不投影（返完整 reduced 状态）。schema 宽松动态不预设字段——Phase D 不传 attrs（动态
   * schema 难穷举关键 key，caper-subject 已控 context）；预留参数供未来 schema 稳定后收窄。
   */
  attrs?: string[];
  /** 可选 kind 解析器（透传 reduceSubject，声明 collection 等需显式 kind 的 path）。 */
  kindResolver?: WorldKindResolver;
}

/** 已折叠的 per-subject 条目（reduce 结果；caller 产——本文件纯函数路径或 shell checkpointed reduce 路径）。 */
export interface WorldSubjectReduceEntry {
  subjectId: string;
  state: ReducedState;
  issueCount: number;
}

/**
 * attrs 顶层投影 + drop-empty 单源（Story 8.1 从 buildWorldStateSnapshot 抽出；纯函数与 shell
 * checkpointed 路径共用，防两处漂移——design §3.2）。纯函数。
 *
 * @param entries  已折叠条目（顺序保持——first-seen 序由 caller 保证）。
 * @param attrs    顶层属性白名单；undefined / 空数组 = 不投影（返完整 reduced 状态）。
 * @returns        subjects 数组（空状态 subject 丢弃免噪音；caller 包 {at, subjects} 成 WorldStateSnapshot）。
 */
export function assembleWorldSnapshot(
  entries: readonly WorldSubjectReduceEntry[],
  attrs?: string[],
): WorldStateSubjectSnapshot[] {
  const attrSet = attrs && attrs.length > 0 ? new Set(attrs) : undefined;
  const subjects: WorldStateSubjectSnapshot[] = [];
  for (const entry of entries) {
    const projected: ReducedState = attrSet
      ? Object.fromEntries(Object.entries(entry.state).filter(([k]) => attrSet.has(k)))
      : entry.state;
    // 丢空状态 subject（该 subject 在 at 前无 populated 属性 / attrs 都不命中）——免 snapshot 噪音。
    if (Object.keys(projected).length === 0) continue;
    subjects.push({ subjectId: entry.subjectId, state: projected, issueCount: entry.issueCount });
  }
  return subjects;
}

/**
 * 从 patches 构造章节级 world-state snapshot（Story 6.6 Phase D 消费端反哺用）。纯函数。
 *
 * @param patches  全部候选 patches（reduce 自行 filter at 截断；通常传项目全集）。
 * @param at       storyTime 截断点（仅叠加 storyTime <= at）；undefined = 取最新（全叠加）。
 * @param options  subjectCap / attrs / kindResolver（详见 BuildWorldStateSnapshotOptions）。
 * @returns        WorldStateSnapshot（subjects 按 first-seen 序，cap 后，非空状态；空 = 无已建立状态）。
 *
 * subjects 收录规则：按 storyTime 升序遍历 patches 收集唯一 subjectId（first-seen 序，与叙事出现序一致），
 * cap subjectCap 后截断。每 subjectId reduceSubject 得 state；attrs 投影后 state 为空（该 subject 在 at 前
 * 无 populated 属性 / attrs 都不命中）的丢弃（不收录空状态 subject，免 snapshot 噪音）。
 */
export function buildWorldStateSnapshot(
  patches: readonly WorldPatch[],
  at: number | undefined,
  options?: BuildWorldStateSnapshotOptions,
): WorldStateSnapshot {
  const subjectCap = options?.subjectCap ?? 12;

  // 1. filter at 截断 + 按 storyTime 升序（first-seen 序与叙事出现序一致）。
  const filtered = (at === undefined ? patches : patches.filter((p) => p.storyTime <= at)).slice();
  filtered.sort((a, b) => a.storyTime - b.storyTime);

  // 2. 唯一 subjectId 收集（first-seen 序），cap subjectCap。
  const subjectIds: string[] = [];
  const seen = new Set<string>();
  for (const p of filtered) {
    if (!p.subjectId || seen.has(p.subjectId)) continue;
    seen.add(p.subjectId);
    subjectIds.push(p.subjectId);
    if (subjectIds.length >= subjectCap) break;
  }

  // 3. 每 subjectId reduceSubject → assembleWorldSnapshot 单源投影/过滤（drop-empty + attrs，与 shell
  //    checkpointed 路径共用防漂移，Story 8.1 抽出）。
  const entries: WorldSubjectReduceEntry[] = [];
  for (const subjectId of subjectIds) {
    const { state, issues } = reduceSubject(filtered, subjectId, at, {
      kindResolver: options?.kindResolver,
    });
    entries.push({ subjectId, state, issueCount: issues.length });
  }
  const subjects = assembleWorldSnapshot(entries, options?.attrs);

  return { at, subjects };
}

// ── Story 8.1：ChapterStateSummary 汇编纯函数（design §3.3，六字段全纯代码）──
//
// 输入 = db（slices / patches / subjects）+ project.yaml（promise_registry）取回的**结构化 records**——本函数
// 不碰 db/LLM/fs（caller = shell materialize handler，Step 3 接线）。
//
// 范式判据（ADR-3）：全部「查询/汇编/确定性计算」——活跃判定（episode index 比较）、dormancy 判定（3 章窗无
// patch）、派生态（derivePromiseStage 复用单源）、cap 截断（活跃序，mirror subjectCap 哲学）；**不判「谁重要/
// 什么值得一提」**（salence 语义归 LLM，8.2+ 事；本函数只按出场/活跃度机械取舍）。

/** 摘要汇编的 per-subject 活动输入（caller 从 closure_world_subject + patches〔episode_id 列〕汇出）。 */
export interface ChapterSubjectActivityInput {
  subjectId: string;
  type: string;
  name?: string;
  sourceCardId?: string;
  /** 首次登记 storyTime（closure_world_subject.first_seen_story_time；④ 新实体判定用）。 */
  firstSeenStoryTime: number;
  /**
   * 最后一次 patch 所在 episode index（cast/dormant 判定基准）；null = 无 patch 史——非「曾出场」，
   * ①①b 两处不进（仍可作 ④ 新实体，若 firstSeen ∈ 本章窗）。
   */
  lastActiveEpisodeIndex: number | null;
  /** 最后一次 patch 所在 episode id（dormant 标记回溯锚：需要全量者按此回溯那章摘要）。 */
  lastChangedEpisodeId?: string;
  /** 本章末折叠态（caller 对活跃 cast 成员 checkpointed reduce 产；缺省/空 → drop-empty 不收录）。 */
  endState?: ReducedState;
}

/** assembleChapterStateSummary 输入（全结构化 records，无 db/LLM）。 */
export interface AssembleChapterStateSummaryInput {
  episodeId: string;
  /** 本章 episode index（episode_outlines）；null = 源缺失——cast/dormancy 判定降级 + degradedNote。 */
  episodeIndex: number | null;
  /** 本章 slices storyTime 窗（闭区间 [start, end]）；null = 本章无已提取 events（④ 空、窗字段 null）。 */
  storyTimeStart: number | null;
  storyTimeEnd: number | null;
  /** 全部已知 subjects 的活动输入（①①b④ 数据源）。 */
  subjects: ChapterSubjectActivityInput[];
  /** 本章窗内全部 patches（② 自滤 relational 轴）。 */
  chapterPatches: WorldPatch[];
  /** promise_registry promises；null = 源缺失（③⑤⑥ 降级空 + degradedNote）；[] = 有源无数据。 */
  promises: PromiseEntry[] | null;
  /** 本章之前（episode < N）的 beats（③ from 段派生）。 */
  beatsBefore: PromiseBeat[];
  /** 至本章末（episode <= N）的 beats（③ to 段 + ⑤ 派生态；不含未来 planned beats——目标轨另有归属）。 */
  beatsThrough: PromiseBeat[];
  /** 归属本章的 beats（③ 逐条列举；caller 按 episodeId / 场归属解析）。 */
  chapterBeats: PromiseBeat[];
  /** 落在下一 episode 的 beats（⑥；caller 按 episodeId / 场归属解析）。 */
  beatsNextEpisode: PromiseBeat[];
  /** 下一 episode id；null/undefined = 无下一章解析（⑥ 空）。deadline 比对用。 */
  nextEpisodeId?: string | null;
}

/** assembleChapterStateSummary 输出。 */
export interface AssembleChapterStateSummaryResult {
  summary: ChapterStateSummary;
  /** 观测用 token 估算（字符启发式 ceil(len/3.5)，mirror agent context/tokenEstimator.ts；落 db 列）。 */
  tokenEstimate: number;
}

/** token 估算字符比（混合 CJK/Latin 平均 ~1 token / 3.5 字符；Story 8.4 B1 上提单源 compile-report.ts，此处 alias 保既有导出面）。 */
export const CHAPTER_SUMMARY_CHARS_PER_TOKEN = TOKEN_ESTIMATE_CHARS_PER_TOKEN;

/** 摘要 JSON 的 token 估算（观测用，非精确计数；估算单源委托 estimateTextTokens，Story 8.4 B1）。 */
export function estimateChapterSummaryTokens(summary: ChapterStateSummary): number {
  return estimateTextTokens(JSON.stringify(summary) ?? '');
}

/** 确定性 id 比较（排序 tie-break，无 locale 依赖）。 */
function compareSubjectId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 汇编 ChapterStateSummary（六字段 + Oracle dormancy + cap 截断/truncated 标记）。纯函数。
 *
 * 六字段（design §3.3）：
 * - ① characterEndStates：活跃 cast（本章 N 与前两章 N-1、N-2 内有 patch）本章末终态，最近活跃序 cap 12
 *   （drop-empty；「最近活跃序」= lastActiveEpisodeIndex 降序，tie 按 subjectId 升序保确定性）。
 * - ①b oracleDormant：曾出场但连续 3 章（含本章）无 patch 的 subject 标记（不携终态——「仅增量 diff」落地）；
 *   首章/无 3 章历史时窗口内有多少算多少，不误标 dormant。
 * - ② relationshipChanges：本章 relational 轴 patch 摘录（storyTime 升序）cap 20。
 * - ③ foreshadowChanges：per 本章 beat + derivePromiseStage 前后差（from=本章前 / to=至本章末；dangling
 *   promiseId 机械跳过）。
 * - ④ newEntities：firstSeenStoryTime ∈ [start, end] 的 subjects cap 20（窗 null → 空）。
 * - ⑤ openPromises：status open 且至本章末派生态非 paid_off（registry 序）cap 20。
 * - ⑥ nextChapterPayoffs：beats 落下一 episode + deadlineEpisodeId = 下一 episode（promiseId 去重）cap 15。
 *
 * @param input  结构化 records（见 AssembleChapterStateSummaryInput；caller 负责 db/yaml 取数与 episode 归属解析）。
 * @returns      { summary, tokenEstimate }（truncated = 任一 cap 字段被截断；degradedNote = 源缺失说明）。
 */
export function assembleChapterStateSummary(
  input: AssembleChapterStateSummaryInput,
): AssembleChapterStateSummaryResult {
  const degraded: string[] = [];
  const n = input.episodeIndex;

  // ①/①b cast 分区（dormancy 判定单源在此——活跃 cast = 本章 N 与前两章 N-1、N-2 内有 patch 的 subjects）。
  const active: ChapterSubjectActivityInput[] = [];
  const dormant: ChapterSubjectActivityInput[] = [];
  for (const s of input.subjects) {
    // n null 优先判（Step 3 修：outlines 整档缺失时 lastActiveEpisodeIndex 全 null——「无史」guard 先判会
    // 把已折叠 subject 也挡在降级分支外，违 design §3.2「仅收录 caller 已折叠者」意图）。降级分支只看
    // endState（caller 的折叠决定），不判无史/曾出场、不标 dormant。
    if (n === null) {
      if (s.endState !== undefined) active.push(s);
      continue;
    }
    if (s.lastActiveEpisodeIndex === null) continue; // 无 patch 史 = 非「曾出场」——两处都不进
    if (s.lastActiveEpisodeIndex >= n - 2) active.push(s);
    else dormant.push(s);
  }
  if (
    n === null &&
    (input.subjects.some((s) => s.lastActiveEpisodeIndex !== null) || active.length > 0)
  ) {
    degraded.push('episode_outlines 缺 index：活跃 cast / dormancy 判定降级（仅收录已折叠 subject，不标 dormant）');
  }

  // ① 角色终态：最近活跃序 + drop-empty + cap 12。
  const activeWithState = active
    .slice()
    .sort((a, b) => {
      const av = a.lastActiveEpisodeIndex ?? Number.NEGATIVE_INFINITY;
      const bv = b.lastActiveEpisodeIndex ?? Number.NEGATIVE_INFINITY;
      if (bv !== av) return bv - av;
      return compareSubjectId(a.subjectId, b.subjectId);
    })
    .map((s) => ({ s, state: s.endState ?? {} }))
    .filter(({ state }) => Object.keys(state).length > 0); // drop-empty（免噪音，mirror assembleWorldSnapshot）
  const truncatedCast = activeWithState.length > CHARACTER_END_STATES_CAP;
  const characterEndStates: CharacterEndState[] = activeWithState
    .slice(0, CHARACTER_END_STATES_CAP)
    .map(({ s, state }) => ({
      subjectId: s.subjectId,
      ...(s.name !== undefined ? { name: s.name } : {}),
      type: s.type,
      state,
    }));

  // ①b dormant 标记：最近休眠在前（lastActiveEpisodeIndex 降序）；Story 8.2 回填机械防爆 cap
  //    （ORACLE_DORMANT_CAP=50000，非预算——正常量级零触及零行为变化，详见 world-state.ts 常量注释）。
  const dormantSorted = dormant
    .slice()
    .sort((a, b) => {
      const av = a.lastActiveEpisodeIndex ?? Number.NEGATIVE_INFINITY;
      const bv = b.lastActiveEpisodeIndex ?? Number.NEGATIVE_INFINITY;
      if (bv !== av) return bv - av;
      return compareSubjectId(a.subjectId, b.subjectId);
    });
  const truncatedDormant = dormantSorted.length > ORACLE_DORMANT_CAP;
  const oracleDormant: OracleDormantEntry[] = dormantSorted
    .slice(0, ORACLE_DORMANT_CAP)
    .map((s) => ({
      subjectId: s.subjectId,
      ...(s.name !== undefined ? { name: s.name } : {}),
      ...(s.lastChangedEpisodeId !== undefined ? { lastChangedEpisodeId: s.lastChangedEpisodeId } : {}),
    }));

  // ② 关系温度变化：本章 relational 轴 patch（storyTime 升序，稳定保输入序）+ cap 20。
  const relational = input.chapterPatches
    .filter((p) => p.axis === 'relational')
    .slice()
    .sort((a, b) => a.storyTime - b.storyTime);
  const truncatedRelational = relational.length > RELATIONSHIP_CHANGES_CAP;
  const relationshipChanges: RelationshipChange[] = relational
    .slice(0, RELATIONSHIP_CHANGES_CAP)
    .map((p) => ({
      subjectId: p.subjectId,
      path: p.path,
      // 提取器 LLM 写的自然语言优先；缺省机械回退 op+path（不判语义）。
      summary: p.summary ?? `${p.op} ${p.path}`,
      storyTime: p.storyTime,
    }));

  // ③⑤⑥ promise 侧（源缺失 → 空 + degradedNote）。
  const foreshadowChanges: ForeshadowChange[] = [];
  const openAll: Array<{ p: PromiseEntry; stage: PromiseDerivedStage }> = [];
  const nextPayoffAll: NextChapterPayoff[] = [];
  if (input.promises === null) {
    degraded.push('promise_registry 缺失：伏笔变更 / 未决承诺 / 下章回收降级为空');
  } else {
    const promiseById = new Map(input.promises.map((p) => [p.id, p]));

    // ③ 伏笔状态变更：per 本章 beat（from = 本章前派生 / to = 至本章末派生；两态恒可算，新 Promise from=unplanted）。
    // Story 8.2：per-promise 派生 stage 记忆化——from/to 只依赖 promiseId（beatsBefore/beatsThrough 是
    // 循环不变量），原逐 beat 重算 derivePromiseStage 是 O(beats×beatsThrough)（防爆 cap 防的回归级倾倒
    // 〔50k+ beats〕会先挂 O(n²) 再谈截断）。行为零变（同 promise 同 beats → 同派生 stage），纯机械缓存。
    const stageCache = new Map<string, { from: PromiseDerivedStage; to: PromiseDerivedStage }>();
    for (const beat of input.chapterBeats) {
      const promise = promiseById.get(beat.promiseId);
      if (!promise) continue; // dangling beat（promise 已删/未同步）——机械跳过
      let stages = stageCache.get(promise.id);
      if (stages === undefined) {
        stages = {
          from: derivePromiseStage(promise, input.beatsBefore),
          to: derivePromiseStage(promise, input.beatsThrough),
        };
        stageCache.set(promise.id, stages);
      }
      foreshadowChanges.push({
        promiseId: promise.id,
        title: promise.title,
        stageChange: stages,
        beatKind: beat.kind,
        sceneRef: beat.sceneRef,
      });
    }

    // ⑤ 未决承诺：status open 且至本章末派生态非 paid_off（registry 序，不判重要性）。
    for (const p of input.promises) {
      const stage = derivePromiseStage(p, input.beatsThrough);
      if (p.status === 'open' && stage !== 'paid_off') openAll.push({ p, stage });
    }

    // ⑥ 下章回收清单：beats 落下一 episode（caller 已按 episodeId/场归属解析）+ deadlineEpisodeId = 下一
    //    episode（无 beat 落场也列——deadline 即回收信号）；promiseId 去重（首个 beat 的 note 代表）。
    //    CR-3（8.1 修复批）：准入与 ⑤ 同构——settled promise（status 非 open / 至本章末派生已 paid_off）
    //    不进「下章回收」：fulfilled/abandoned 已了结、已 paid_off 已兑现，向 Writer 谎报回收任务是误导
    //    （原实现只去重不滤态，fulfilled+deadline 命中 / abandoned+beat 命中都会混入）。
    if (input.nextEpisodeId) {
      const payoffDue = (promise: PromiseEntry): boolean =>
        promise.status === 'open' && derivePromiseStage(promise, input.beatsThrough) !== 'paid_off';
      const seen = new Set<string>();
      for (const beat of input.beatsNextEpisode) {
        const promise = promiseById.get(beat.promiseId);
        if (!promise || seen.has(promise.id) || !payoffDue(promise)) continue;
        seen.add(promise.id);
        nextPayoffAll.push({
          promiseId: promise.id,
          title: promise.title,
          ...(beat.note !== undefined ? { note: beat.note } : {}),
        });
      }
      for (const p of input.promises) {
        if (p.deadlineEpisodeId === input.nextEpisodeId && !seen.has(p.id) && payoffDue(p)) {
          seen.add(p.id);
          nextPayoffAll.push({ promiseId: p.id, title: p.title, note: 'deadline 到期' });
        }
      }
    }
  }
  const truncatedOpen = openAll.length > OPEN_PROMISES_CAP;
  const openPromises: OpenPromiseEntry[] = openAll
    .slice(0, OPEN_PROMISES_CAP)
    .map(({ p, stage }) => ({
      promiseId: p.id,
      title: p.title,
      stage,
      ...(p.deadlineEpisodeId !== undefined ? { deadlineEpisodeId: p.deadlineEpisodeId } : {}),
    }));
  const truncatedNext = nextPayoffAll.length > NEXT_CHAPTER_PAYOFFS_CAP;
  const nextChapterPayoffs = nextPayoffAll.slice(0, NEXT_CHAPTER_PAYOFFS_CAP);
  // Story 8.2 回填：foreshadowChanges 机械防爆 cap（FORESHADOW_CHANGES_CAP=50000，非预算——本章 beats
  // 正常量级永不触及；只挡提取器回归级倾倒，详见 world-state.ts 常量注释）。
  const truncatedForeshadow = foreshadowChanges.length > FORESHADOW_CHANGES_CAP;
  const foreshadowCapped = foreshadowChanges.slice(0, FORESHADOW_CHANGES_CAP);

  // ④ 新引入实体：firstSeenStoryTime ∈ [start, end]（窗 null → 空）+ cap 20。
  const windowStart = input.storyTimeStart;
  const windowEnd = input.storyTimeEnd;
  const newAll =
    windowStart === null || windowEnd === null
      ? []
      : input.subjects
          .filter((s) => s.firstSeenStoryTime >= windowStart && s.firstSeenStoryTime <= windowEnd)
          .slice()
          .sort(
            (a, b) => a.firstSeenStoryTime - b.firstSeenStoryTime || compareSubjectId(a.subjectId, b.subjectId),
          );
  const truncatedNew = newAll.length > NEW_ENTITIES_CAP;
  const newEntities: NewEntity[] = newAll.slice(0, NEW_ENTITIES_CAP).map((s) => ({
    subjectId: s.subjectId,
    type: s.type,
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.sourceCardId !== undefined ? { sourceCardId: s.sourceCardId } : {}),
  }));

  const truncated =
    truncatedCast || truncatedRelational || truncatedOpen || truncatedNew || truncatedNext ||
    truncatedDormant || truncatedForeshadow;

  const summary: ChapterStateSummary = {
    episodeId: input.episodeId,
    episodeIndex: n,
    storyTimeStart: input.storyTimeStart,
    storyTimeEnd: input.storyTimeEnd,
    characterEndStates,
    oracleDormant,
    relationshipChanges,
    foreshadowChanges: foreshadowCapped,
    newEntities,
    openPromises,
    nextChapterPayoffs,
    truncated,
    ...(degraded.length > 0 ? { degradedNote: degraded.join('；') } : {}),
  };

  return { summary, tokenEstimate: estimateChapterSummaryTokens(summary) };
}
