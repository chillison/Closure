import { buildCognitionSnapshot, buildPresenceSignal } from './cognition';
import { reduceSubject } from './world-state-reduce';
import type { SceneNode } from './creative-fields';
import type { WorldPatch } from './world-state';

// ── Story 8.4 C1/C2（design §3.2）：同切点不变量对拍器（纯代码核心，Step 9 从测试提升为可导出纯函数）──
//
// 提升动机（implement.md Step 9 断言①「不复制粘贴断言逻辑」）：不变量的对拍逻辑原在
// `tests/as-of-invariants.test.ts` 内部（测试本地函数），400 章压测（shell worldStateScale.test.ts B6）
// 要对合成数据抽切点复跑同一套不变量——两处各写一遍必漂移。提升到 shared src 单源：测试与压测都
// import 本函数；`INVARIANT_LIST`（清单权威源）仍在测试文件（「后续加不变量 = 加测试」的登记处不变）。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：全部是集合包含比较 + min-max/
// reduce 同源对拍——纯代码零语义。不判「认知合理不合理」（归 Reader-Audit L2）。
//
// ⚠️ as-of 截断的调用方契约（mirror cognition.ts 既有契约）：buildCognitionSnapshot 不自带 at——
// 截断在调用方（shell listWorldPatches(at) 的 `s.story_time <= at`）。本函数对入参 patches 再过一次
// `storyTime <= at`（幂等——调用方已截断时零变化；测试传全量时由本函数截断），纯函数面与真 SQL 面
// 共用同一判定。
//
// expected_downstream_consumers:
// - shared tests/as-of-invariants.test.ts：INV-1/2/3 对拍测试（teeth fixture 证各检查非恒真）。
// - shell test/worldStateScale.test.ts B6：400 章合成数据抽切点复跑（真 db 面——patches 经
//   listWorldPatches(at) SQL 截断 + worldSubjects 经 buildWorldSnapshotCheckpointed 收集）。

/**
 * 同切点对拍数据（五源中守卫消费的四源：patches / 场 storyTime 表 / 世界账 subjects）。
 *
 * - patches：**全量或已截断皆可**（内部再过 `storyTime <= at`，幂等）。
 * - sceneById：scene_graph 全场 storyTime 表（INV-2 evidence 场判定）。
 * - worldSubjects：世界账主体 id 集（INV-1——调用方按切点收集，如
 *   `buildWorldSnapshotCheckpointed(PID, at).subjects`，其收集即 `first_seen_story_time <= at`）。
 */
export interface AsOfInvariantData {
  sceneById: ReadonlyMap<string, SceneNode>;
  worldSubjects: ReadonlySet<string>;
  patches: readonly WorldPatch[];
}

/**
 * mirror 调用方截断契约（listWorldPatches(at)：仅保留 storyTime <= at）。
 * at undefined = 全量（最新切点）。
 */
function asOf(patches: readonly WorldPatch[], at: number | undefined): WorldPatch[] {
  return at === undefined ? [...patches] : patches.filter((p) => p.storyTime <= at);
}

/**
 * 同切点不变量对拍器（INV-1/2/3，design §3.2 清单前两条 + presence）——返回违反清单（空 = 全过）。
 *
 * - INV-1：cognition characters ⊆ world subjects（认知账角色必在世界账主体中）。
 * - INV-2：cognitive fact 的 evidence scene 存在于 scene_graph 且其 storyTime ≤ T
 *   （认知证据场不在切点的故事未来）。
 * - INV-3：presence 信号的 presence scene = 世界账该角色在该时刻 reduce 出的 presence_scene，
 *   且 ∈ 该角色截至该时刻登记过的 presence 场集合（投影与账本同源，机制性成立——对拍钉防回归）。
 *
 * 违反条目带 INV id 前缀（消费方断言/呈现可辨识来源）。
 */
export function collectAsOfInvariantViolations(data: AsOfInvariantData, at: number | undefined): string[] {
  const { sceneById, worldSubjects, patches } = data;
  const violations: string[] = [];
  const windowed = asOf(patches, at);

  // INV-1：cognition characters ⊆ world subjects。
  const cognition = buildCognitionSnapshot(windowed);
  for (const c of cognition?.characters ?? []) {
    if (!worldSubjects.has(c.characterSubjectId)) {
      violations.push(`INV-1: cognition 角色 ${c.characterSubjectId} 不在世界账 subjects`);
    }
  }

  // INV-2：cognitive fact 的 evidence scene storyTime ≤ T。at undefined = 最新切点（全量）——
  // 无「故事未来」可比，无违反（mirror 纯测试时代码语义：number > undefined 恒 false）。
  for (const p of windowed) {
    if (p.axis !== 'cognitive' || p.evidenceSceneId === undefined) continue;
    const sc = sceneById.get(p.evidenceSceneId);
    if (sc === undefined) {
      violations.push(`INV-2: fact ${p.path} 的 evidence scene ${p.evidenceSceneId} 不在 scene_graph`);
    } else if (at !== undefined && sc.storyTime > at) {
      violations.push(
        `INV-2: fact ${p.path} 的 evidence scene ${p.evidenceSceneId} storyTime=${sc.storyTime} > T=${at}`,
      );
    }
  }

  // INV-3：presence 信号的 presence scene = 世界账该角色在该时刻 reduce 出的 presence_scene，
  // 且 ∈ 该角色截至该时刻登记过的 presence 场集合。
  const physical = windowed.filter((p) => p.axis === 'physical');
  for (const s of buildPresenceSignal(windowed)) {
    const { state } = reduceSubject(physical, s.characterSubjectId, s.storyTime);
    const reduced = (state as { presence_scene?: unknown }).presence_scene;
    if (reduced !== s.presenceSceneId) {
      violations.push(
        `INV-3: ${s.characterSubjectId} 信号在场场 ${s.presenceSceneId} ≠ 世界账 reduce ${String(reduced)}`,
      );
    }
    const recordedScenes = new Set(
      physical
        .filter((p) => p.subjectId === s.characterSubjectId && p.path === '/presence_scene' && p.storyTime <= s.storyTime)
        .map((p) => p.value),
    );
    if (!recordedScenes.has(s.presenceSceneId)) {
      violations.push(`INV-3: ${s.presenceSceneId} 不在 ${s.characterSubjectId} 的登记 presence 场集合`);
    }
  }

  return violations;
}

/**
 * INV-5 章窗对拍（design §3.2 清单第五条）：章摘要 touched subjects ⊆ 该章窗内 patch 涉及主体。
 *
 * ②关系变化 + ④新实体的主体都必须有本章窗内 patch 背书（常规提取路径登记伴随 patch）——跨章主体
 * 零泄漏。touched 集由调用方从章摘要投影（`relationshipChanges[].subjectId` + `newEntities[].subjectId`），
 * windowPatchSubjects 由调用方从本章归属 slices 的 patches 收集（`listWorldSlices({episodeId})`）。
 */
export function collectChapterWindowViolations(
  touchedSubjects: readonly string[],
  windowPatchSubjects: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  for (const subjectId of touchedSubjects) {
    if (!windowPatchSubjects.has(subjectId)) {
      violations.push(`INV-5: touched subject ${subjectId} 无本章窗内 patch 背书（跨章泄漏）`);
    }
  }
  return violations;
}
