/**
 * story_sync_apply tool handler (Story 2.2 WP-E, design §5.5.2).
 *
 * The prose→setting feedback applier. The chain's story-sync-agent node (now a
 * real LLM extractor) emits `story.sync` patches; `summarizeRunSnapshot`
 * forwards them as a final-state deliverable; write_chapter calls this tool at
 * the route final state with `{runId, patches, autoApply?, chapterNote?}`.
 *
 * Dual landing (mirror emotionCurveHandlers DW-4 / settingMdHandlers):
 * - autoApply === true (write_chapter passes it under permissionMode 'auto' AND
 *   route=accept_as_truth OR escalate+放手采信（autoTrustAction='accept'，语义已转
 *   accept）AND patches ≤ cap — the "accept prose as truth" semantic backs the
 *   auto-land, design §5.5.2 safety argument): `withProjectLock` + read fresh +
 *   project + `onFieldEdited(source: 'agent', reason=chapterNote)` per field
 *   (version bump + markStaleFields + projectDocumentSchema.parse + saveProject —
 *   the SAME landing call the emotionCurve/infoRelease/promiseLedger/sceneGraph
 *   autoApply handlers make). asset_cards watchers re-index project.yaml writes
 *   (query_story retrieval).
 * - autoApply absent/false (suggest default): does NOT write. Projects each
 *   patch onto the CURRENT field data and returns per-field `field_patch`
 *   envelopes with FULL replacement data (action:'set' — the PatchReview accept
 *   path persists via syncField → onFieldEdited which REPLACES, so a merge
 *   fragment envelope would clobber the field; full projected data mirrors
 *   assetCardsHandlers' envelope shape). write_chapter attaches them to the
 *   write_chapter result metadata as `storySyncPatches` → UI PatchReview.
 *   Same-field multiple patches aggregate into ONE envelope carrying the
 *   cumulative projection (CR-08-16-004 — intermediate snapshots would render
 *   duplicate review cards whose data is a strict subset of the final).
 *
 * Mechanical gates (story-sync safety semantics, single-sourced where they
 * already exist — never re-implemented):
 * - field must be in `creativeFieldKeys` ('overview' and unknowns dropped);
 *   action must be 'merge'; data must be an object.
 * - promise_registry patches are ALWAYS dropped (CR-E7 track-conflation: the
 *   reader-debt ledger is owned by promise-emergence-node, prompt rule 7 is the
 *   first line, this is the belt).
 * - Cap (auto path ONLY, CR-08-16-103): at most 8 patches LAND per auto-apply
 *   call — the suggest/review path stages everything it is given (human review
 *   is the cap; write_chapter already force-reviews beyond-cap batches), so
 *   the old gate-side truncation DROPPED over-cap patches while the copy
 *   claimed "转人审". Beyond-cap patches on a direct autoApply call are
 *   skipped with a truthful reason.
 * - Optimistic version lock: a patch whose `fieldVersion` (recorded at
 *   extraction time) no longer matches the current `field_metadata` version is
 *   stale (the field was edited mid-run) and is dropped — mirror
 *   `enforcePatchSafety` (`!==`) semantics. Locked fields throw inside
 *   `onFieldEdited` (auto path) and are surfaced per-field (graceful); the
 *   accept path (`applyFieldPatchesWithSkipped`) already skips locked fields +
 *   stale versions for the human-review landing (localProjectRepository.ts
 *   locked-reject + version check) — not re-implemented here.
 * - asset_cards patches NEVER doc-merge (a non-array merge into the array
 *   field would coerce array→object and corrupt it in
 *   applyFieldPatchesWithSkipped's merge branch). They translate to
 *   asset_cards_update's update_card / add_card action form (cardId=data.id +
 *   shallow merge; new ids → add_card so first-appearance entities can be
 *   registered, design §5.5.0) via `applyAssetCardActions` + assetCardsSchema
 *   revalidation (per-element: one bad card drops alone, good ones stay).
 * - growth_curve patches (Story 8.5 D2, array canonical) are the same
 *   array-target story: they translate to by-character_id upserts
 *   (`applyGrowthCurveActions` add_curve partial-merge; current doc value
 *   normalized via growthCurveFieldSchema so legacy single/Record persisted
 *   data keeps merging, zero data loss) + growthCurveFieldSchema revalidation.
 *   CR-Blind-F4: patch.data may be the canonical ARRAY form too (per-entry
 *   extraction, each entry needs its own character_id); single/Record shapes
 *   keep working — the object-data gate opens for this field only.
 * - Other-field merges only apply onto/into plain-object targets (arrays
 *   and scalars are skipped with a reason — episode_outlines array upserts need
 *   per-entry semantics that do not exist yet) and the merged value is
 *   revalidated against the field's own schema (per-field isolation — NOT the
 *   whole projectDocumentSchema, which would couple a merge to unrelated
 *   broken fields, mirror the 组装层 per-element safeParse convention).
 *   CR-006: outline patches carrying schema-unknown keys (e.g. the pre-8.5
 *   draft-key vocab growth_curve / pacing_curve_text) would have those keys
 *   silently zod-stripped — the whole patch is skipped with a visible reason
 *   instead (mirror the growth_curve branch's per-entry skip+reason philosophy).
 */
import {
  applyAssetCardActions,
  applyGrowthCurveActions,
  assetCardsSchema,
  creativeFieldKeys,
  creativeBriefSchema,
  emotionCurveSchema,
  growthCurveFieldSchema,
  growthCurveSchema,
  infoReleaseMapSchema,
  outlineV2Schema,
  pacingCurveSchema,
  relationshipGraphSchema,
  sceneGraphSchema,
  storySyncApplyRequestSchema,
  worldSettingSchema,
  type AssetCard,
  type CreativeFieldKey,
  type FieldPatchEntry,
  type GrowthCurve,
  type GrowthCurveAction,
} from '@orison/shared-contracts';
import { getLogger } from '../../logger';
import { withProjectLock } from '../../fs/projectWriteLock';
import type { ToolHandler } from './types';

/** Max patches per auto-apply LANDING (auto path only; review staging is uncapped — the human is the cap). */
export const STORY_SYNC_PATCH_CAP = 8;

const CREATIVE_SET = new Set<string>(creativeFieldKeys);

/** Type guard: narrows FieldPatchEntry.field (which includes 'overview') to the creative-field subset. */
function isCreativeField(field: string): field is CreativeFieldKey {
  return CREATIVE_SET.has(field);
}

/** A story-sync patch that survived the creative-field gate (field narrowed away from 'overview'). */
export type CreativeFieldPatch = Omit<FieldPatchEntry, 'field'> & { field: CreativeFieldKey };

/** Per-field full replacement data + the version the landing should record (current + 1, mirror UI slice convention). */
export interface StorySyncEnvelope {
  type: 'field_patch';
  field: CreativeFieldKey;
  action: 'set';
  data: unknown;
  fieldVersion: number;
  /** Chapter provenance note (「第 N 章 story-sync 提取」), display + sync-event reason. */
  note?: string;
}

export type StorySyncSkip = { field: string; reason: string };
// CR-T2-010（2026-08-25）：`reason` 是**纯展示字段**——grep 全下游（ui/agent/shell/contracts）
// 无等值匹配消费者（UI 只读 storySyncPatches 形态；write-chapter 的 skippedNote 只取
// `field` 名拼文案；测试断言均为 toContain/Includes 展示文本）。中文化安全；未来消费者
// 须按 field 判别或另立机读码，**不得对 reason 字符串做 === 匹配**。

/** Field → project.yaml doc key (mirror localProjectRepository FIELD_TO_KEY; outline → outline_v2). asset_cards / growth_curve 有专属投影分支（下方），不在本表（array 目标，generic doc-merge 会毁数据）。 */
const FIELD_TO_DOC_KEY: Partial<Record<CreativeFieldKey, string>> = {
  creative_brief: 'creative_brief',
  world_setting: 'world_setting',
  outline: 'outline_v2',
  emotion_curve: 'emotion_curve',
  pacing_curve: 'pacing_curve',
  relationship_graph: 'relationship_graph',
  info_release_map: 'info_release_map',
  scene_graph: 'scene_graph',
};

/**
 * Structural stand-in for a zod schema's safeParse face (shell has no direct zod
 * dependency — the schemas live in shared-contracts; we only call safeParse).
 */
type SafeParseFace = {
  safeParse: (data: unknown) => { success: boolean; data?: unknown; error?: { issues?: Array<{ message?: string }> } };
};

/** Per-field schema belt (merge result must still satisfy the field's own schema; asset_cards / growth_curve handled by dedicated branches). */
const FIELD_SCHEMA: Partial<Record<CreativeFieldKey, SafeParseFace>> = {
  creative_brief: creativeBriefSchema,
  world_setting: worldSettingSchema,
  outline: outlineV2Schema,
  emotion_curve: emotionCurveSchema,
  pacing_curve: pacingCurveSchema,
  relationship_graph: relationshipGraphSchema,
  info_release_map: infoReleaseMapSchema,
  scene_graph: sceneGraphSchema,
};

/** Mechanical gate: whitelist / merge-only / object data (growth_curve also accepts the canonical array, CR-Blind-F4) / promise_registry drop. Never throws. (No cap — CR-08-16-103: the review path stages everything; the cap gates the auto LANDING only.) */
function gateStorySyncPatches(
  patches: FieldPatchEntry[],
): { kept: CreativeFieldPatch[]; skipped: StorySyncSkip[] } {
  const kept: CreativeFieldPatch[] = [];
  const skipped: StorySyncSkip[] = [];
  for (const patch of patches) {
    if (!isCreativeField(patch.field)) {
      skipped.push({ field: String(patch.field), reason: '非创作字段（不在创作字段白名单内）' });
      continue;
    }
    if (patch.field === 'promise_registry') {
      // CR-E7 belt (prompt rule 7 is the first line): the ledger belongs to promise-emergence-node.
      skipped.push({ field: 'promise_registry', reason: 'promise_registry 不走 story-sync（CR-E7 防线，读者债归 promise-emergence-node）' });
      continue;
    }
    if (patch.action !== 'merge') {
      skipped.push({ field: patch.field, reason: `action '${patch.action}' 非 merge（story-sync 只产 merge 补丁）` });
      continue;
    }
    // CR-Blind-F4：growth_curve 例外放行 array data（8.5 canonical 形态，分支内逐条 by-character_id
    // upsert）；其余 field 的 merge 目标是对象，array 拒（doc-merge 会 array→object 毁数据）。
    if (!patch.data || typeof patch.data !== 'object' || (Array.isArray(patch.data) && patch.field !== 'growth_curve')) {
      skipped.push({ field: patch.field, reason: 'data 非对象（merge 补丁 data 须为对象）' });
      continue;
    }
    kept.push({ ...patch, field: patch.field });
  }
  return { kept, skipped };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Current field_metadata version (undefined when the field was never edited). */
function currentVersionOf(doc: Record<string, unknown>, field: string): number | undefined {
  const fm = doc.field_metadata as Record<string, { version?: unknown }> | undefined;
  const version = fm?.[field]?.version;
  return typeof version === 'number' && Number.isFinite(version) ? version : undefined;
}

/**
 * Project the gated patches onto a working doc → per-field envelopes with FULL
 * replacement data (+ extended skipped list). Pure w.r.t. the passed doc (the
 * caller clones). Per-element drop-bad-keep-good (mirror CR-4.1-07).
 */
export function projectStorySyncPatches(
  doc: Record<string, unknown>,
  kept: CreativeFieldPatch[],
  chapterNote: string | undefined,
): { envelopes: StorySyncEnvelope[]; skipped: StorySyncSkip[] } {
  const envelopes: StorySyncEnvelope[] = [];
  const skipped: StorySyncSkip[] = [];
  const note = chapterNote;
  // CR-08-16-004：同 field 多补丁聚合为一张 envelope——投影循环对 doc 是累积合并（第 N 条的 data
  // 已含前 N-1 条），末次结果覆盖早前条目；旧形态把中间快照也 push 进 envelopes，PatchReview 会出
  // 同 field 两张卡（第一张 data 是第二张的严格子集，且 accept 顺序语义含混）。fieldVersion 恒
  // diskVersion+1（投影内磁盘版本不变），覆盖不产生版本歧义。
  const envelopeIndexByField = new Map<string, number>();

  for (const patch of kept) {
    // Optimistic version lock (mirror enforcePatchSafety `!==`): the extraction
    // recorded the version it saw; a mismatch means the field changed mid-run.
    const diskVersion = currentVersionOf(doc, patch.field);
    if (typeof diskVersion === 'number' && patch.fieldVersion !== diskVersion) {
      skipped.push({ field: patch.field, reason: `版本过期（提取时 v${patch.fieldVersion}，当前 v${diskVersion}——字段在提取后被编辑过）` });
      continue;
    }

    if (patch.field === 'asset_cards') {
      // Translate to asset_cards_update's bounded action form (cardId=data.id +
      // shallow merge; unknown id → add_card so first-appearance entities
      // register as new cards). applyAssetCardActions strips identity keys on
      // update; assetCardsSchema revalidation is the trust-boundary belt.
      const data = patch.data as Record<string, unknown>;
      const cardId = typeof data.id === 'string' ? data.id : '';
      if (!cardId) {
        skipped.push({ field: 'asset_cards', reason: '补丁 data 缺 id（asset_cards merge 补丁须携带卡 id；新卡须给完整卡）' });
        continue;
      }
      const cards = Array.isArray(doc.asset_cards) ? (doc.asset_cards as AssetCard[]) : [];
      const exists = cards.some((c) => c && typeof c === 'object' && c.id === cardId);
      const action = exists
        ? { op: 'update_card' as const, cardId, patch: data }
        : { op: 'add_card' as const, card: data as unknown as AssetCard };
      const projected = applyAssetCardActions(cards, [action]);
      const validated = assetCardsSchema.safeParse(projected);
      if (!validated.success) {
        const issue = validated.error.issues[0]?.message ?? 'invalid';
        skipped.push({ field: 'asset_cards', reason: `卡投影 schema 校验失败（${issue}——update 须可合并进既有卡 / add 须是完整卡 id+type+name）` });
        continue;
      }
      doc.asset_cards = validated.data;
      const envelope: StorySyncEnvelope = {
        type: 'field_patch',
        field: 'asset_cards',
        action: 'set',
        data: validated.data,
        fieldVersion: (diskVersion ?? 0) + 1,
        ...(note !== undefined ? { note } : {}),
      };
      const prev = envelopeIndexByField.get('asset_cards');
      if (prev !== undefined) envelopes[prev] = envelope;
      else {
        envelopeIndexByField.set('asset_cards', envelopes.length);
        envelopes.push(envelope);
      }
      continue;
    }

    if (patch.field === 'growth_curve') {
      // Story 8.5 D2：growth_curve array canonical——generic doc-merge 对 array 目标会 coerce 成
      // object 毁数据（mirror asset_cards 分支理由）。merge 语义 = by-character_id upsert：
      // - current（doc 侧，可能是旧 yaml 单条/Record 形态）经 growthCurveFieldSchema 归一（存储
      //   契约层三形态宽容，旧数据不丢）；缺字段（新项目首条弧）→ []。
      // - patch.data（LLM 侧，gate 已保非数组对象）：单条（character_id 身份键）或 Record 多条，
      //   per-entry 预合并到既有完整弧（显式键覆盖，B1：不经预 parse 填 defaults）→ add_curve
      //   partial-merge 落投影；新角色 entry 须完整（character_id + start_state）。
      // - 投影包 try/catch（applyGrowthCurveActions 内 growthCurveSchema.parse 理论可 throw，
      //   never-throws 纪律 belt）+ growthCurveFieldSchema belt（mirror assetCardsSchema revalidation）。
      const currentRaw = doc.growth_curve;
      if (currentRaw !== undefined && !Array.isArray(currentRaw) && !isPlainObject(currentRaw)) {
        skipped.push({ field: 'growth_curve', reason: '目标字段当前值非数组/对象（merge 会破坏既有数据，拒绝）' });
        continue;
      }
      const currentParsed =
        currentRaw === undefined
          ? { success: true as const, data: [] as GrowthCurve[] }
          : growthCurveFieldSchema.safeParse(currentRaw);
      if (!currentParsed.success) {
        const issue = currentParsed.error.issues[0]?.message ?? 'invalid';
        skipped.push({ field: 'growth_curve', reason: `既有 growth_curve 归一失败（${issue}——目标数据形态坏，拒绝合并防覆盖）` });
        continue;
      }
      const currentCurves = currentParsed.data;

      // incoming 提取（「显式提供」语义，B1 关键：**不**走 growthCurveFieldSchema/growthCurveSchema
      // 预 parse——那会为缺省字段填 defaults，partial merge 时 default 值覆盖既有真实字段。raw 键
      // 直取，defaults 只在下方 per-entry 预合并（base=既有完整弧）后由 parse 填充——existing 完整
      // 故 defaults 无处可填，语义 = 只并显式键）：
      // - canonical array（CR-Blind-F4，8.5 存储契约 canonical 写形态）：逐条提取，每条须对象 + 值内
      //   character_id（数组条目无键兜底）；坏条目逐条 skip（drop-bad-keep-good）。
      // - 单条：data.character_id 为身份键；
      // - Record：per-entry（value.character_id 优先，key 补缺），非对象值逐条 skip reason（CR-Edge-F8）。
      const incoming: Array<{ characterId: string; fields: Record<string, unknown> }> = [];
      if (Array.isArray(patch.data)) {
        patch.data.forEach((item, idx) => {
          if (!isPlainObject(item)) {
            skipped.push({ field: 'growth_curve', reason: `growth_curve 数组第 ${idx + 1} 项非对象，跳过该项` });
            return;
          }
          const cid = item.character_id;
          if (typeof cid !== 'string' || cid.length === 0) {
            skipped.push({ field: 'growth_curve', reason: `growth_curve 数组第 ${idx + 1} 项缺 character_id（数组条目无键兜底），跳过该项` });
            return;
          }
          incoming.push({ characterId: cid, fields: item });
        });
        if (incoming.length === 0) {
          skipped.push({
            field: 'growth_curve',
            reason: '补丁 data 为数组但无可用条目（每条须为含 character_id 的曲线对象）',
          });
          continue;
        }
      } else {
        const dataObj = patch.data as Record<string, unknown>;
        if (typeof dataObj.character_id === 'string' && dataObj.character_id.length > 0) {
          incoming.push({ characterId: dataObj.character_id, fields: dataObj });
        } else {
          for (const [key, value] of Object.entries(dataObj)) {
            // CR-Edge-F8：非对象值逐条 skip reason（不再静默 continue——LLM/leader 可见哪条坏、为何坏）。
            if (!isPlainObject(value)) {
              skipped.push({ field: 'growth_curve', reason: `growth_curve Record 键 ${key} 的值非对象，跳过该条` });
              continue;
            }
            const valueCharId = value.character_id;
            const characterId =
              typeof valueCharId === 'string' && valueCharId.length > 0 ? valueCharId : key;
            incoming.push({ characterId, fields: value });
          }
          if (incoming.length === 0) {
            skipped.push({
              field: 'growth_curve',
              reason: '补丁 data 非 growth_curve 可合并形态（须为含 character_id 的曲线对象或其 Record）',
            });
            continue;
          }
        }
      }

      // per-entry 投影（drop-bad-keep-good，mirror CR-4.1-07 per-element 先例）：已有弧 → fragment
      // 预合并到既有完整弧（显式键覆盖，余保留——保留旧 doc-level merge 对 fragment 的容忍）；新角色
      // → 须完整曲线（缺 start_state 等必填 → 该 entry 丢弃 + truthful reason，好 entry 不受牵连）。
      //
      // CR-003：incoming 先按 characterId **批内聚合**（显式键合并，后者覆盖同键）再逐角色预合并 existing——
      // 预合并的 existing 基底是磁盘快照，同批同角色第二条（[{A,desire:X},{A,need:Y}]）若不聚合会回落旧值
      // 重建整条，覆盖第一条的显式字段（desire:X 静默丢）。工具路径 applyGrowthCurveActions 顺序投影本就不丢
      // （add_curve partial-merge 累积），聚合后两通道语义一致。
      const aggregated = new Map<string, Record<string, unknown>>();
      for (const { characterId, fields } of incoming) {
        aggregated.set(characterId, { ...(aggregated.get(characterId) ?? {}), ...fields });
      }
      const actions: GrowthCurveAction[] = [];
      for (const [characterId, fields] of aggregated) {
        const existing = currentCurves.find((c) => c.character_id === characterId);
        const { character_id: _identity, ...fragment } = fields;
        const mergedEntry = growthCurveSchema.safeParse({
          ...(existing ?? {}),
          ...fragment,
          character_id: characterId,
        });
        if (!mergedEntry.success) {
          const issue = mergedEntry.error.issues[0]?.message ?? 'invalid';
          skipped.push({
            field: 'growth_curve',
            reason: `角色 ${characterId} 补丁归一失败（${issue}——新角色弧补丁须带 character_id + start_state，fragment 仅对已有弧角色可合并）`,
          });
          continue;
        }
        actions.push({ op: 'add_curve' as const, curve: mergedEntry.data });
      }
      if (actions.length === 0) continue; // 全 entry 坏 → 已逐条 skip，无 envelope。

      let projected: GrowthCurve[];
      try {
        projected = applyGrowthCurveActions(currentCurves, actions);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push({ field: 'growth_curve', reason: `投影失败（${reason}——新角色弧补丁须带 character_id + start_state）` });
        continue;
      }
      const validated = growthCurveFieldSchema.safeParse(projected);
      if (!validated.success) {
        const issue = validated.error.issues[0]?.message ?? 'invalid';
        skipped.push({ field: 'growth_curve', reason: `投影 schema 校验失败（${issue}）` });
        continue;
      }
      doc.growth_curve = validated.data;
      const envelope: StorySyncEnvelope = {
        type: 'field_patch',
        field: 'growth_curve',
        action: 'set',
        data: validated.data,
        fieldVersion: (diskVersion ?? 0) + 1,
        ...(note !== undefined ? { note } : {}),
      };
      const prev = envelopeIndexByField.get('growth_curve');
      if (prev !== undefined) envelopes[prev] = envelope;
      else {
        envelopeIndexByField.set('growth_curve', envelopes.length);
        envelopes.push(envelope);
      }
      continue;
    }

    // Other creative fields: doc-level object merge onto the CURRENT value.
    const docKey = FIELD_TO_DOC_KEY[patch.field];
    if (!docKey) {
      // episode_outlines (array target) and any unmapped field: per-entry upsert
      // semantics do not exist — refuse rather than corrupt (array→object merge).
      skipped.push({ field: patch.field, reason: '该字段暂不支持 merge 投影（数组/条目字段需 per-entry 语义）' });
      continue;
    }
    const current = doc[docKey];
    if (current !== undefined && !isPlainObject(current)) {
      skipped.push({ field: patch.field, reason: '目标字段当前值非对象（merge 会破坏既有数据，拒绝）' });
      continue;
    }
    const merged = isPlainObject(current) ? { ...current, ...(patch.data as Record<string, unknown>) } : { ...(patch.data as Record<string, unknown>) };
    const schema = FIELD_SCHEMA[patch.field];
    if (schema) {
      const validated = schema.safeParse(merged);
      if (!validated.success) {
        const issue = validated.error?.issues?.[0]?.message ?? 'invalid';
        skipped.push({ field: patch.field, reason: `合并结果 schema 校验失败（${issue}——merge 片段须与既有字段可合并）` });
        continue;
      }
      // CR-006：outline merge 补丁键集 vs revalidate 后键集比对——zod strip 会把 schema 不认识的键
      // 静默蒸发（8.5 改名 growth_curve→arc_design_notes / pacing_curve_text→pacing_design_notes 后，
      // LLM 带旧 vocab 产 outline 补丁时旧草稿文本无声丢失）。可见化：被 strip 的键 → 本条补丁整条
      // 跳过 + truthful reason（与 growth_curve 分支逐条 skip+reason 哲学一致），LLM 得知改用新键名重发。
      if (patch.field === 'outline' && isPlainObject(patch.data)) {
        const parsedKeys = new Set(isPlainObject(validated.data) ? Object.keys(validated.data) : []);
        const stripped = Object.keys(patch.data).filter((k) => !parsedKeys.has(k));
        if (stripped.length > 0) {
          skipped.push({
            field: 'outline',
            reason: `outline 补丁携带 schema 不认识的键（${stripped.join('、')}）——为免这些内容被静默丢弃，本条补丁整条跳过。旧草稿键已改名（growth_curve→arc_design_notes、pacing_curve_text→pacing_design_notes）；请改用 schema 内字段名重发`,
          });
          continue;
        }
      }
    }
    doc[docKey] = merged;
    const envelope: StorySyncEnvelope = {
      type: 'field_patch',
      field: patch.field,
      action: 'set',
      data: merged,
      fieldVersion: (diskVersion ?? 0) + 1,
      ...(note !== undefined ? { note } : {}),
    };
    const prev = envelopeIndexByField.get(patch.field);
    if (prev !== undefined) envelopes[prev] = envelope;
    else {
      envelopeIndexByField.set(patch.field, envelopes.length);
      envelopes.push(envelope);
    }
  }

  return { envelopes, skipped };
}

function describeSkipped(skipped: StorySyncSkip[]): string {
  if (skipped.length === 0) return '';
  return ` 已跳过：${skipped.map((s) => `${s.field}（${s.reason}）`).join('；')}。`;
}

/**
 * story_sync_apply：story-sync 反哺 patches 的落盘/呈报 applier（write_chapter 终态调用，
 * 非 leader 日常创作工具）。autoApply=true 直落；缺省投影产 field_patch envelope 组。
 */
export const storySyncApplyHandler: ToolHandler = async ({ params, projectDir }) => {
  const parsed = storySyncApplyRequestSchema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      title: 'story_sync_apply',
      output:
        `设定同步已中止：请求格式无效（${issue?.path.join('.') ?? '?'}：${issue?.message ?? '未知'}）。` +
        '请提供 runId + 非空 patches 数组（仅 merge 的 FieldPatchEntry[]）+ 可选 autoApply / chapterNote。',
    };
  }
  const { runId, autoApply, chapterNote } = parsed.data;
  const gated = gateStorySyncPatches(parsed.data.patches);
  if (gated.kept.length === 0) {
    return {
      title: 'story_sync_apply',
      output: `设定同步已跳过：没有可采纳的补丁。${describeSkipped(gated.skipped)}`,
      metadata: { ok: true, applied: false, patches: [], skipped: gated.skipped },
    };
  }

  // ── autoApply path: read fresh + project + onFieldEdited per field, all under the project lock ──
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const { loadProject, onFieldEdited } = await import('@orison/desktop-local-bff');
        const project = loadProject(projectDir) as Record<string, unknown> | null;
        if (!project) {
          return {
            title: 'story_sync_apply',
            output: `设定同步已中止：项目设定文件无法读取（可能损坏或缺失）；为安全起见未做任何改动。`,
          };
        }
        const work = structuredClone(project) as Record<string, unknown>;
        // Cap gates the auto LANDING only (CR-08-16-103): write_chapter pre-routes
        // beyond-cap batches to the review path (all staged), so this truncation
        // only bites direct autoApply calls — with a truthful reason (never
        // "转人审" for a patch that was dropped, the old gate's false copy).
        let kept = gated.kept;
        const skipped: StorySyncSkip[] = [...gated.skipped];
        if (kept.length > STORY_SYNC_PATCH_CAP) {
          skipped.push(
            ...kept.slice(STORY_SYNC_PATCH_CAP).map((p) => ({
              field: p.field,
              reason: `超出单次自动落地上限 ${STORY_SYNC_PATCH_CAP} 条——本条未自动落盘（超限批次走缺省人审通道全量呈现）`,
            })),
          );
          kept = kept.slice(0, STORY_SYNC_PATCH_CAP);
        }
        const { envelopes, skipped: projectionSkipped } = projectStorySyncPatches(work, kept, chapterNote);
        skipped.push(...projectionSkipped);
        const landed: string[] = [];
        for (const envelope of envelopes) {
          try {
            onFieldEdited(projectDir, envelope.field, envelope.data, {
              source: 'agent',
              reason: chapterNote ?? 'story-sync 反哺（正文→设定回收）',
            });
            landed.push(envelope.field);
          } catch (err) {
            // Locked field throws here (plus save failures) — per-field graceful,
            // the rest of the batch still lands (mirror emotionCurveHandlers).
            const reason = err instanceof Error ? err.message : String(err);
            getLogger().warn({ err: reason, field: envelope.field, projectDir }, '[story_sync] autoApply landing failed for field');
            skipped.push({ field: envelope.field, reason });
          }
        }
        return {
          title: `story_sync_apply: ${runId}`,
          output:
            `设定反哺已生效（${landed.length} 个字段：${landed.join(', ') || '无'}，已写入项目设定）。` +
            describeSkipped(skipped),
          metadata: {
            ok: true,
            applied: true,
            appliedFields: landed,
            patchCount: landed.length,
            skipped,
            summary: `story-sync 反哺 · ${landed.join(', ') || '无落地字段'}${chapterNote ? ` · ${chapterNote}` : ''}`,
          },
        };
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: reason, projectDir }, '[story_sync] autoApply landing failed');
      return {
        title: 'story_sync_apply',
        output: `设定同步自动生效失败：${reason}。未做任何改动。`,
        metadata: { ok: false, applied: false, skipped: gated.skipped },
      };
    }
  }

  // ── suggest path (default): project only, never write — per-field envelopes for PatchReview ──
  const { loadProject } = await import('@orison/desktop-local-bff');
  let project: Record<string, unknown> | null;
  try {
    project = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, projectDir }, '[story_sync] loadProject threw');
    project = null;
  }
  if (!project) {
    return {
      title: 'story_sync_apply',
      output: `设定同步已中止：项目设定文件无法读取（可能损坏或缺失）。为安全起见未做任何改动，请检查项目文件后再试。`,
    };
  }
  const work = structuredClone(project) as Record<string, unknown>;
  const { envelopes, skipped } = projectStorySyncPatches(work, gated.kept, chapterNote);
  if (envelopes.length === 0) {
    return {
      title: 'story_sync_apply',
      output: `设定同步已跳过：所有补丁在投影阶段被丢弃。${describeSkipped([...gated.skipped, ...skipped])}`,
      metadata: { ok: true, applied: false, patches: [], skipped: [...gated.skipped, ...skipped] },
    };
  }
  return {
    title: `story_sync_apply: ${runId}`,
    output:
      `设定反哺更新已备好（${envelopes.length} 个字段：${envelopes.map((e) => e.field).join(', ')}）。` +
      `请在补丁面板审阅——确认后写入项目设定。${describeSkipped([...gated.skipped, ...skipped])}`,
    metadata: {
      ok: true,
      applied: false,
      patches: envelopes,
      skipped: [...gated.skipped, ...skipped],
      summary: `story-sync 反哺 · ${envelopes.map((e) => e.field).join(', ')}${chapterNote ? ` · ${chapterNote}` : ''}`,
    },
  };
};
