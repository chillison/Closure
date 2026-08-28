import { z } from 'zod';
import { isSceneInEpisode } from './scene-graph-analytics';
import type { SceneGraph } from './creative-fields';

// ── Story 8.4 C2（design §3.3）：提取器 storyTime 漂移守卫（纯代码核心）──
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：本文件是**集合比较 + min-max 窗判定**
// 的纯代码——「本章提取 slices 的 storyTime 是否落在本章场 storyTime 窗内」是结构比对，零语义判断。
// 不判「这个 storyTime 合不合理 / 该不该改」（归人：leader/用户核对 scene_graph 或重提取），只产
// warning 信号（**零阻断**——守卫是漂移检测非门禁，design §3.3）。
//
// 守卫依据：提取器 prompt 本就以本章场 storyTime 为提示（world-extractor-node buildStoryTimeHint）——
// 落在窗外 = 提取器偏离了提示源，是漂移信号（提取误差 / scene_graph 过时 / 跨章事件误归属三态，
// 机械层不区分，人核对）。
//
// **容差初值 = 0（严格窗内）标「校准点 dogfood」**（design §3.3 / deferred-work 记档）：等故事时的
// 前后场共享 storyTime、提取器对齐粒度等真实写作噪声是否存在，dogfood 观测后再放宽。
//
// expected_downstream_consumers:
// - Story 8.4 Step 9：agent `nodes/storytime-drift-node.ts`（chapter-summary 链位旁守卫步骤，读
//   `world_state.events` artifact 的 writes[].storyTime）→ summarizeRunSnapshot driftWarnings 透出 →
//   write_chapter output 呈现（3.3 校验议题进 chat 同通道——tool result → leader 主动提 + 对话解决）。
// - dogfood：容差校准（deferred-work 记档）。

/**
 * storyTime 漂移 warning（机器产 artifact，camelCase mirror ArcBeat / WorldStateEventsArtifact 约定）。
 *
 * - sliceId：漂移的提取切面 id（`${episodeId}:${storyTime}`，merge 稳定 id）。
 * - direction：漂移方向——before = 早于本章场窗下界 / after = 晚于上界。
 * - windowMin/windowMax：本章场 storyTime 窗 [min, max]（比对基准，呈现给人核对用）。
 */
export const storyTimeDriftWarningSchema = z.object({
  sliceId: z.string().min(1),
  storyTime: z.number().int(),
  direction: z.enum(['before', 'after']),
  windowMin: z.number().int(),
  windowMax: z.number().int(),
});
export type StoryTimeDriftWarning = z.infer<typeof storyTimeDriftWarningSchema>;

/**
 * 漂移容差（**校准点 dogfood**，design §3.3）：窗判定放宽量——storyTime 落在
 * [min - tolerance, max + tolerance] 外才报。初值 0 = 严格窗内（提取器以场 storyTime 为提示，
 * 窗外即漂移信号）；dogfood 观测真实写作噪声后校准。
 */
export const STORYTIME_DRIFT_TOLERANCE = 0;

/** 守卫输入的最小 slice 投影（sliceId + storyTime——world-merge artifact writes[] 的子集形态）。 */
export interface SliceStoryTimeEntry {
  sliceId: string;
  storyTime: number;
}

/**
 * 本章场 storyTime 窗 [min, max]（`isSceneInEpisode` 单源归属判定 + min-max 归约）。
 * 窗不可算（sceneGraph / episodeId 缺 / 本章无归属场）→ undefined。守卫与呈现侧共用（单源）。
 */
export function computeChapterSceneWindow(
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
): { min: number; max: number } | undefined {
  if (!sceneGraph || !episodeId) return undefined;
  let min: number | undefined;
  let max: number | undefined;
  for (const node of sceneGraph.nodes) {
    if (!isSceneInEpisode(node, episodeId)) continue;
    if (min === undefined || node.storyTime < min) min = node.storyTime;
    if (max === undefined || node.storyTime > max) max = node.storyTime;
  }
  if (min === undefined || max === undefined) return undefined;
  return { min, max };
}

/**
 * 提取器 storyTime 漂移守卫（design §3.3，纯代码零语义）。
 *
 * 比对：本章场（`isSceneInEpisode` 单源归属——episodeId 直挂 OR presentationSpans M:N）的
 * storyTime [min, max] 窗 vs 本章提取 slices 的 storyTime——窗外（按 tolerance 放宽后）→ warning。
 *
 * 零噪音边界（AC-11「不错位零噪音」）：
 * - sceneGraph / episodeId 缺 → []（无比对基准——测试环境 / bypass 路径）。
 * - 本章 episode 无归属场 → []（窗不可算。scene_graph 空是数据缺失非漂移——提取器当时也拿不到
 *   storyTime 提示，报窗即噪声）。
 * - 无 slices（本章零提取——CR-E8 空组跳过 / 全轴提取失败 graceful）→ []。
 * - 全部落在窗内 → []。
 *
 * @param sceneGraph scene_graph artifact（结构查询源）
 * @param episodeId  本章 episode id（场归属判定）
 * @param slices     本章提取 slices 的 {sliceId, storyTime}（world-merge `world_state.events`.writes）
 * @param tolerance  窗放宽量（缺省 STRICT 0；**校准点 dogfood**）
 * @returns          漂移 warning 列表（空 = 无漂移；非空零阻断，消费方进校验议题通道）
 */
export function detectStoryTimeDrift(
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
  slices: readonly SliceStoryTimeEntry[],
  tolerance: number = STORYTIME_DRIFT_TOLERANCE,
): StoryTimeDriftWarning[] {
  const window = computeChapterSceneWindow(sceneGraph, episodeId);
  if (window === undefined) return [];
  const { min: windowMin, max: windowMax } = window;

  const warnings: StoryTimeDriftWarning[] = [];
  for (const slice of slices) {
    if (slice.storyTime < windowMin - tolerance) {
      warnings.push({
        sliceId: slice.sliceId,
        storyTime: slice.storyTime,
        direction: 'before',
        windowMin,
        windowMax,
      });
    } else if (slice.storyTime > windowMax + tolerance) {
      warnings.push({
        sliceId: slice.sliceId,
        storyTime: slice.storyTime,
        direction: 'after',
        windowMin,
        windowMax,
      });
    }
  }
  return warnings;
}
