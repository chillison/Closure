import { z } from 'zod';
import {
  episodeOutlinesSchema,
  type EmotionCurve,
  type InfoReleaseMap,
  type PromiseRegistry,
  type SceneGraph,
  type SceneNode,
  type SceneWeightSignal,
} from '@orison/shared-contracts';
import { resolveSceneEpisodeCandidates } from './batch-planning';

/** episode_outlines 完整条目（丰富度计数需 summary/beats 等全字段——ResolvableEpisode 只有 id/index）。 */
type EpisodeSignalOutline = z.infer<(typeof episodeOutlinesSchema)>[number];

// ── Story 3.5（design §3.1）：SceneWeightSignal L1 信号汇编（纯代码，ADR-3 R7 红线）──
//
// 每场产一张**机械事实卡**：结构信号（anchorType / 因果边密度 / outcomeType / pacingRole）+
// Promise 节拍（beats sceneRef 匹配 + deadline 逾期机械匹配）+ 情绪峰（emotion_curve point 投影）+
// 信息释放点（InfoReleaseMap entry 计数与模式）+ world-state 在场主体（assetRefs ∩ 有历史的主体，
// 安危判定的结构底料）+ 大纲丰富度（字段完整度三档计数）。
//
// 🔑 范式红线（design §7 自检表）：**零语义判断**——无重要性分值、无「该不该问」规则、「同信号在这个
// 题材里算多重」归 leader LLM 对照 GenreContract commitments 判（R3 题材感知）。词库命中→极性加权→
// pass/fail 是假信心门（AGENT-001），此处只做存在性 / 计数 / 结构投影。
//
// 题材承诺（GenreContract commitments）是**项目级**信号（供 LLM 对照，不 per-scene）——由 caller
// （batch-tools）单独抽取随信号卡一并返回。

/** 信号汇编数据源（caller 从 project.yaml / world-state 查询聚齐）。 */
export interface BatchSignalSources {
  sceneGraph: SceneGraph;
  episodeOutlines?: readonly EpisodeSignalOutline[];
  promiseRegistry?: PromiseRegistry;
  emotionCurve?: EmotionCurve;
  infoReleaseMap?: InfoReleaseMap;
  /**
   * 有 world-state 历史的 subject → patch 计数（fetchWorldPatchesViaTool 聚合，纯 id 匹配底料）。
   * 缺（工具未注册 / 无数据）→ 全场 worldStateSubjects=[]（graceful，不造假）。
   */
  worldStatePatchCounts?: ReadonlyMap<string, number>;
}

/** typed 锚点角色（mirror batch-planning ANCHOR_ROLES——本地 Set，避免跨模块私有导出耦合）。 */
const ANCHOR_ROLES = new Set(['core-anchor', 'secondary-anchor', 'fork-point']);

/** 前向边类型（CAUSAL + SUSPENSE，mirror scene-graph-analytics FORWARD_EDGE_TYPES）。 */
const FORWARD_EDGE_TYPES = new Set(['CAUSAL', 'SUSPENSE']);

/** 大纲丰富度阈值（机械完整度计数，design §3.1「本场 beat/细节字段完整度」的 bucketing）。 */
const RICH_EPISODE_SIGNAL_MIN = 5;
const RICH_SCENE_DETAIL_MIN = 2;

/**
 * 解析本场 episodeId（供丰富度 / Promise 逾期用），CR-016 统一优先级：
 * - 调 batch-planning.resolveSceneEpisodeCandidates（interface-contracts helper 复用先于重造）。
 * - 取候选按 episode.index 升序后的首个（min index——最早承载 episode，与 groupScenesByChapter 一致）。
 */
function resolveSceneEpisode(
  node: SceneNode,
  outlineById: Map<string, EpisodeSignalOutline>,
): string | undefined {
  const candidates = resolveSceneEpisodeCandidates(node);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const sorted = [...candidates].sort((a, b) => {
    const ai = typeof outlineById.get(a)?.index === 'number' ? outlineById.get(a)!.index : Number.MAX_SAFE_INTEGER;
    const bi = typeof outlineById.get(b)?.index === 'number' ? outlineById.get(b)!.index : Number.MAX_SAFE_INTEGER;
    return (ai as number) - (bi as number);
  });
  return sorted[0];
}

/**
 * 汇编每场权重信号卡（纯函数）。
 *
 * @param sources   数据源（sceneIds 外的字段全 optional——缺失 → 对应信号缺省 / outlineRichness 降级）。
 * @param sceneIds  有序场列表（batch plan 产物）。
 * @param chapterMap 场→章映射（chapterId 信号；无映射场 chapterId 缺省）。
 */
export function assembleSceneWeightSignals(
  sources: BatchSignalSources,
  sceneIds: readonly string[],
  chapterMap?: Readonly<Record<string, string>>,
): SceneWeightSignal[] {
  const { sceneGraph, episodeOutlines, promiseRegistry, emotionCurve, infoReleaseMap, worldStatePatchCounts } = sources;
  const nodeById = new Map(sceneGraph.nodes.map((n) => [n.id, n]));

  // 每 episode 的 outline 信号计数（rich 判定底料；per-episode 算一次复用）。
  const episodeSignalCount = new Map<string, number>();
  for (const ep of episodeOutlines ?? []) {
    let count = 0;
    if (ep.summary && ep.summary.trim().length > 0) count++;
    if (ep.purpose && ep.purpose.trim().length > 0) count++;
    if (ep.core_event && ep.core_event.trim().length > 0) count++;
    if (ep.hook && ep.hook.trim().length > 0) count++;
    if (ep.emotional_beats.length > 0) count++;
    if (ep.pacing_beats.length > 0) count++;
    if (ep.foreshadowing.length > 0) count++;
    if (ep.payoffs.length > 0) count++;
    if (ep.character_progressions.length > 0) count++;
    episodeSignalCount.set(ep.id, count);
  }
  const outlineById = new Map((episodeOutlines ?? []).map((e) => [e.id, e]));

  // promise 标题索引（beats 展开用）。
  const promiseTitleById = new Map((promiseRegistry?.promises ?? []).map((p) => [p.id, p.title]));
  const openPromises = (promiseRegistry?.promises ?? []).filter((p) => p.status === 'open');

  // 前向边计数（in + out）预聚合。
  const causalEdgeCount = new Map<string, number>();
  for (const id of sceneIds) causalEdgeCount.set(id, 0);
  for (const edge of sceneGraph.edges) {
    if (!FORWARD_EDGE_TYPES.has(edge.type)) continue;
    if (causalEdgeCount.has(edge.from)) causalEdgeCount.set(edge.from, (causalEdgeCount.get(edge.from) ?? 0) + 1);
    if (causalEdgeCount.has(edge.to)) causalEdgeCount.set(edge.to, (causalEdgeCount.get(edge.to) ?? 0) + 1);
  }

  const signals: SceneWeightSignal[] = [];
  for (const sceneId of sceneIds) {
    const node = nodeById.get(sceneId);
    if (!node) continue; // 防御（plan 已校验存在性）

    // ── 结构信号 ──
    // anchorType：typed 锚点是结构事实（role enum 非 normal）。
    const anchorType = ANCHOR_ROLES.has(node.role)
      ? (node.role as 'core-anchor' | 'secondary-anchor' | 'fork-point')
      : undefined;

    // 场 episode（丰富度判定 + promise 逾期匹配用）：直挂优先，次选首个 span（CR-016 统一优先级——
    // spans 优先于直挂，空 presentationSpans:[] 回退 episodeId；下同 batch-planning resolveSceneEpisode）。
    const sceneEpisodeId = resolveSceneEpisode(node, outlineById);

    // ── Promise 节拍（beats sceneRef 机械匹配 + open Promise deadlineEpisodeId 逾期匹配）──
    const promiseBeats = (promiseRegistry?.beats ?? [])
      .filter((b) => b.sceneRef === sceneId)
      .map((b) => ({
        promiseId: b.promiseId,
        kind: b.kind,
        ...(promiseTitleById.get(b.promiseId) ? { promiseTitle: promiseTitleById.get(b.promiseId)! } : {}),
      }));
    // CR-015：契约称「截至本场已逾期的 open Promise」——按 episode index 比较（deadline 的 episode index
    // <= 本场 episode index 即逾期累积），不再 deadlineEpisodeId 全等（只命中「恰好到期」场——累积逾
    // 期永远不触发，most common 形态会漏）。无 episode outine index（数据缺）→ 全等匹配（graceful）。
    const sceneEpisodeIndex = sceneEpisodeId ? outlineById.get(sceneEpisodeId)?.index : undefined;
    const promiseDueTitles = sceneEpisodeId
      ? openPromises
        .filter((p) => {
          if (!p.deadlineEpisodeId) return false;
          const deadlineIdx = outlineById.get(p.deadlineEpisodeId)?.index;
          // 类型卫生：deadlineEpisodeId 未必在 episodeOutlines 中（旧项目可只挂 epId 缺 outline）→ 全等匹配兜底。
          if (typeof deadlineIdx !== 'number' || typeof sceneEpisodeIndex !== 'number') {
            return p.deadlineEpisodeId === sceneEpisodeId;
          }
          return deadlineIdx <= sceneEpisodeIndex;
        })
        .map((p) => p.title)
      : [];

    // ── 情绪峰（emotion_curve point 投影：语义词 + 可选 VAD + per-character 目标）──
    const emotionPoint = emotionCurve?.points.find((p) => p.refId === sceneId);
    const emotion = emotionPoint
      ? {
          ...(emotionPoint.sceneMood ? { sceneMood: emotionPoint.sceneMood } : {}),
          ...(emotionPoint.sceneVad !== undefined && emotionPoint.sceneVad !== null
            ? { sceneVad: emotionPoint.sceneVad }
            : {}),
          characters: emotionPoint.characters.map((c) => ({
            characterId: c.characterId,
            emotion: c.emotion,
            ...(c.emotionEnd ? { emotionEnd: c.emotionEnd } : {}),
          })),
        }
      : undefined;

    // ── 信息释放点（entry 计数 + directive 模式列举 + reveal/withhold 计数）──
    const releaseEntries = (infoReleaseMap?.entries ?? []).filter((e) => e.sceneRef === sceneId);
    const infoRelease = releaseEntries.length > 0
      ? {
          entryCount: releaseEntries.length,
          modes: [
            ...new Set(
              releaseEntries.flatMap((e) => (typeof e.directive?.mode === 'string' ? [e.directive.mode as string] : [])),
            ),
          ],
          revealCount: releaseEntries.reduce((sum, e) => sum + (e.reveal?.length ?? 0), 0),
          withholdCount: releaseEntries.reduce((sum, e) => sum + (e.withhold?.length ?? 0), 0),
        }
      : undefined;

    // ── world-state 在场主体（assetRefs ∩ 有 patch 历史的 subject，纯 id 匹配）──
    const worldStateSubjects = (node.assetRefs ?? [])
      .filter((assetId) => (worldStatePatchCounts?.get(assetId) ?? 0) > 0)
      .map((assetId) => ({ subjectId: assetId, patchCount: worldStatePatchCounts!.get(assetId)! }));

    // ── 大纲丰富度（episode 字段信号数 + 场细节字段数 → 三档机械计数）──
    const sceneDetailCount =
      (node.storyTimeLabel && node.storyTimeLabel.length > 0 ? 1 : 0) +
      (node.outcomeType && node.outcomeType.length > 0 ? 1 : 0) +
      (node.pacingRole && node.pacingRole.length > 0 ? 1 : 0) +
      ((node.assetRefs ?? []).length > 0 ? 1 : 0);
    const episodeCount = sceneEpisodeId ? episodeSignalCount.get(sceneEpisodeId) : undefined;
    const hasOutline = sceneEpisodeId !== undefined && outlineById.has(sceneEpisodeId);
    const outlineRichness: SceneWeightSignal['outlineRichness'] = !hasOutline
      ? 'none'
      : (episodeCount ?? 0) >= RICH_EPISODE_SIGNAL_MIN && sceneDetailCount >= RICH_SCENE_DETAIL_MIN
        ? 'rich'
        : 'sparse';

    signals.push({
      sceneId,
      ...(chapterMap?.[sceneId] ? { chapterId: chapterMap[sceneId] } : {}),
      storyTime: node.storyTime,
      ...(node.storyTimeLabel ? { storyTimeLabel: node.storyTimeLabel } : {}),
      role: node.role,
      ...(anchorType ? { anchorType } : {}),
      lineTags: node.lineTags,
      ...(node.outcomeType ? { outcomeType: node.outcomeType } : {}),
      ...(node.pacingRole ? { pacingRole: node.pacingRole } : {}),
      causalEdgeCount: causalEdgeCount.get(sceneId) ?? 0,
      promiseBeats,
      promiseDueTitles,
      ...(emotion ? { emotion } : {}),
      ...(infoRelease ? { infoRelease } : {}),
      worldStateSubjects,
      outlineRichness,
    });
  }
  return signals;
}

/** GenreContract 承诺抽取（项目级，供 leader 对照「同信号在这个题材里算多重」——R3 题材感知）。 */
export function extractGenreCommitments(
  creativeBrief: { commitments?: Array<{ type: string; content: string }> } | undefined,
): Array<{ type: string; content: string }> {
  return (creativeBrief?.commitments ?? []).filter(
    (c) => c && typeof c.type === 'string' && c.type.length > 0 && typeof c.content === 'string' && c.content.length > 0,
  );
}
