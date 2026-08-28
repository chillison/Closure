// ── Story 2.2 WP-C: setting coverage gap detection (B-axis pure-code half, design §4) ──
//
// Structural cross-check between scene_graph (what scenes say they involve) and
// asset_cards (what setting cards exist). Two gap kinds, both mechanical facts:
// - dangling_ref (warning): scene.assetRefs names an id that matches no asset card.
// - scene_no_refs (info): a scene carries no assetRefs at all — a weak structural
//   signal ("could annotate refs"), NOT a setting debt (design §4: fixing it goes
//   through scene_graph_update and does not count against the setting layer).
//
// Paradigm red line (ADR-3 / .trellis/spec/core/creative-vs-mechanical.md): this
// module only reports structural gaps (set-existence checks over ids). It never
// judges "is this scene's setting sufficient / good" — that is semantic and belongs
// to the leader LLM conversation (WP-A guidance segment). No vocab matching, no
// scoring, no false-confidence gate.
//
// Mirrors findDanglingLineTags / findDanglingEdgeEndpoints (reference-integrity
// checks in scene-graph-analytics.ts) and consumes scene.assetRefs per the `?? []`
// convention documented at creative-fields.ts (Story 3.4 D6). assetRefs filling
// itself is LLM-side ("which cards does this scene involve" is semantic); pre-3.4
// projects simply have undefined assetRefs and surface as scene_no_refs info —
// degraded truthfully, not guessed.
//
// Report shape decision — one gap per dangling card id, sceneIds aggregates all
// referencing scenes: the consumers are the leader injection segment (lists top-N
// gaps, design §4) and the write_chapter readiness gate message (filters to this
// chapter's scenes). One missing card = one actionable fix (create the card once);
// per-scene entries would flood the top-N list with N items sharing a single fix
// and crowd out other distinct gaps. sceneIds keeps the full mechanical fact, so
// chapter-scene filtering and scene-anchored phrasing still work — no information
// lost vs per-scene reporting.
//
// expected_downstream_consumers:
// - Story 2.2 WP-A: loadSettingCoverageForLeader (workflow.ts) → three-state
//   coverage segment in buildInteractionModeSegment (mirror 3.3 structure health).
// - Story 2.2 WP-D: write_chapter readiness gate interception message (filter to
//   this chapter's scenes, append as warning annotation — same single source).

import { z } from 'zod';
import type { AssetCard, EpisodeOutline, SceneGraph } from './creative-fields';

/** Max scene ids embedded in a gap message before folding to "等 N 场" (display only; sceneIds keeps all). */
const MESSAGE_SCENE_CAP = 5;

// ── gap schema ──

export const settingCoverageGapSchema = z.object({
  /** 'dangling_ref' = scene references a non-existent card (warning); 'scene_no_refs' = scene carries no assetRefs (info). */
  kind: z.enum(['dangling_ref', 'scene_no_refs']),
  /**
   * Scenes involved, in scene_graph node order. dangling_ref: every scene that
   * references the missing card (aggregated per card id — see header). scene_no_refs:
   * the single scene without refs.
   */
  sceneIds: z.array(z.string().min(1)).min(1),
  /** The dangling asset_card id (dangling_ref only; undefined for scene_no_refs). */
  ref: z.string().min(1).optional(),
  /** warning = actionable gap (missing card); info = weak structural signal. No 'error' tier by design (prd R4). */
  severity: z.enum(['warning', 'info']),
  /** Narrative-language message (mirror SceneGraphIssue message style); embeds card id + scene ids. */
  message: z.string().min(1),
});

export type SettingCoverageGap = z.infer<typeof settingCoverageGapSchema>;

// ── pure function ──

/**
 * Detect structural setting-coverage gaps between scene_graph and asset_cards.
 * Pure function — id set-existence checks only, zero semantic judgement.
 *
 * Semantics:
 * - dangling_ref (warning): one gap per distinct card id referenced via
 *   scene.assetRefs that matches no card; sceneIds collects all referencing scenes
 *   (deduped within a scene, ordered by first occurrence in graph node order).
 * - scene_no_refs (info): one gap per scene whose assetRefs is missing or empty.
 *   Every scene in scene_graph is "planned" by definition (SceneNode carries no
 *   written/planned status), so all ref-less scenes qualify.
 * - Output order is deterministic: dangling_ref gaps first (ordered by first
 *   referencing scene), then scene_no_refs gaps (graph node order). Consumers
 *   truncating to top-N get stable results.
 *
 * Graceful: sceneGraph undefined / no nodes → [] (nothing to check); assetCards
 * undefined / empty → every referenced id dangles (mechanical truth: with no cards,
 * refs have nothing to resolve to). Genuinely-unavailable data is handled upstream
 * by the caller (mirror loadStructureIssuesForLeader three-state defense).
 *
 * @param sceneGraph parsed SceneGraph (structure query source; undefined → [])
 * @param assetCards  parsed asset_cards (existence check source; undefined → treated as [])
 */
export function findSettingCoverageGaps(
  sceneGraph: SceneGraph | undefined,
  assetCards: readonly AssetCard[] | undefined,
): SettingCoverageGap[] {
  if (!sceneGraph || sceneGraph.nodes.length === 0) return [];

  const cardIds = new Set((assetCards ?? []).map((c) => c.id));

  // Pass 1: walk nodes in graph order; aggregate dangling refs per card id
  // (Map insertion order = first referencing scene) and collect ref-less scenes.
  const danglingByRef = new Map<string, string[]>();
  const noRefScenes: string[] = [];
  for (const node of sceneGraph.nodes) {
    const refs = node.assetRefs ?? [];
    if (refs.length === 0) {
      noRefScenes.push(node.id);
      continue;
    }
    const seenInScene = new Set<string>(); // same dangling ref repeated within one scene = one mention
    for (const ref of refs) {
      if (cardIds.has(ref) || seenInScene.has(ref)) continue;
      seenInScene.add(ref);
      const scenes = danglingByRef.get(ref);
      if (scenes) scenes.push(node.id);
      else danglingByRef.set(ref, [node.id]);
    }
  }

  const gaps: SettingCoverageGap[] = [];
  for (const [ref, sceneIds] of danglingByRef) {
    gaps.push({
      kind: 'dangling_ref',
      sceneIds,
      ref,
      severity: 'warning',
      message: `场景「${formatSceneIds(sceneIds)}」引用的设定卡「${ref}」不存在，需要补建这张卡或修正引用。`,
    });
  }
  for (const sceneId of noRefScenes) {
    gaps.push({
      kind: 'scene_no_refs',
      sceneIds: [sceneId],
      severity: 'info',
      message: `场景「${sceneId}」还没有标注涉及的设定卡（assetRefs 缺省或为空）。`,
    });
  }
  return gaps;
}

/** Join scene ids for a message, folding beyond MESSAGE_SCENE_CAP to keep messages readable (data stays complete in sceneIds). */
function formatSceneIds(sceneIds: readonly string[]): string {
  if (sceneIds.length <= MESSAGE_SCENE_CAP) return sceneIds.join('、');
  return `${sceneIds.slice(0, MESSAGE_SCENE_CAP).join('、')} 等 ${sceneIds.length} 场`;
}

// ── dogfood R2 #21（08-26 用户拍板 A+B）：出场人物零卡检测（机械计数/存在性，非语义）──
//
// 背景：「轻装上阵」档位下 leader 合理跳过设定卡建设（档位语义授权），而 coverage 闸只查
// 「引用了但没有」（dangling_ref）——场景不标 assetRefs 就零信号 → write_chapter 静默开写，
// 写手设定供给（compileSettingPrefix 的 core 角色卡）为空，人物刻画全凭集纲/大纲转述。
// 补两个纯机械信号（文案由消费点拼——leader 注入段与 write_chapter 附注语气不同）：
// - countCharacterCards：全库 character 卡计数（0 = 「项目还没有任何角色卡」事实）。
// - findUnanchoredCharacterProgressions：episode.character_progressions 声明的人物无对应卡
//   （id 存在性检查，与 dangling_ref 同型——只是引用源从 scene.assetRefs 换成集纲人物段）。

/** 全库 character 卡计数（0 = 零角色卡——写手设定供给里将没有人物卡的机械事实）。 */
export function countCharacterCards(assetCards: readonly AssetCard[] | undefined): number {
  return (assetCards ?? []).filter((c) => c.type === 'character').length;
}

/**
 * episode.character_progressions 声明的人物没有对应设定卡（id 存在性检查）。
 * 返回去重保序的 characterId 列表（空数组 = 无悬空）。progressions 缺省/空 → []（机械上
 * 没有声明就没有悬空——「这集其实有谁出场」是语义判断，不在此）。
 */
export function findUnanchoredCharacterProgressions(
  episode: Pick<EpisodeOutline, 'character_progressions'> | undefined,
  assetCards: readonly AssetCard[] | undefined,
): string[] {
  if (!episode) return [];
  const cardIds = new Set((assetCards ?? []).map((c) => c.id));
  const out: string[] = [];
  for (const p of episode.character_progressions ?? []) {
    if (!cardIds.has(p.characterId) && !out.includes(p.characterId)) out.push(p.characterId);
  }
  return out;
}
