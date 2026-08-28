import { z } from 'zod';
import { promiseRegistrySchema, type PromiseRegistry } from './creative-fields';

// ── Foreshadow migration（Story 6.5：foreshadow_registry → promise_registry 迁移模块）──
//
// self-contained 迁移模块：保留旧 foreshadow schema 作 loadProject 迁移 transform 的输入类型
// （localProjectRepository 就地迁移：parsed.foreshadow_registry → transformForeshadowToPromise →
// delete foreshadow_registry → projectDocumentSchema.parse 前，design §6 / implement.md Phase B）。
//
// foreshadow 已从 creative-fields.ts 退役（creativeFieldKeys/projectDocument 不再注册 foreshadow_registry）；
// 本模块是迁移期遗留，迁移完成后（无旧 project.yaml 含 foreshadow_registry）可整体移除（删不留标记，
// git 历史 + 本文件是审计 trail，feedback-delete-dont-leave-markers）。
//
// 范式判据（ADR-3 / creative-vs-mechanical）：迁移 transform = 纯代码机械映射（status → promise status +
// beats），非语义判断（「这条 foreshadow 是什么 Promise」按固定规则映射，不判叙事意义）。
//
// expected_downstream_consumers:
// - Story 6.5 Phase B：local-bff loadProject 迁移块（import transformForeshadowToPromise）。
// - Story 6.5 Phase A 测试：foreshadow-migration.test.ts 覆盖全 status 组合 + 零删数据。

/** foreshadow 5 态封闭枚举（旧存储态，迁移源——已退役，仅迁移用）。 */
export const foreshadowStatusSchema = z.enum([
  'pending',
  'planted',
  'resolved',
  'partially_resolved',
  'abandoned',
]);

export const foreshadowSourceTypeSchema = z.enum(['manual', 'agent', 'analysis', 'imported']);

export const foreshadowCategorySchema = z.enum([
  'identity',
  'mystery',
  'item',
  'relationship',
  'event',
  'ability',
  'prophecy',
  'motif',
  'world_rule',
  'custom',
]);

export const foreshadowEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  hint_text: z.string().optional(),
  resolution_text: z.string().optional(),
  source_type: foreshadowSourceTypeSchema.default('agent'),
  source_memory_id: z.string().optional(),
  source_analysis_id: z.string().optional(),
  plant_ref: z.string().optional(),
  plant_index: z.number().int().nonnegative().optional(),
  target_resolve_ref: z.string().optional(),
  target_resolve_index: z.number().int().nonnegative().optional(),
  actual_resolve_ref: z.string().optional(),
  actual_resolve_index: z.number().int().nonnegative().optional(),
  status: foreshadowStatusSchema.default('pending'),
  is_long_term: z.boolean().default(false),
  importance: z.number().min(0).max(1).default(0.5),
  strength: z.number().int().min(1).max(10).default(5),
  subtlety: z.number().int().min(1).max(10).default(5),
  urgency: z.number().int().min(0).max(3).default(0),
  related_asset_ids: z.array(z.string()).default([]),
  related_foreshadow_ids: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  category: foreshadowCategorySchema.optional(),
  notes: z.string().optional(),
  resolution_notes: z.string().optional(),
  auto_remind: z.boolean().default(true),
  remind_before_units: z.number().int().min(1).max(20).default(5),
  include_in_context: z.boolean().default(true),
  sourceRefs: z.array(z.string()).default([]),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  planted_at: z.string().datetime().optional(),
  resolved_at: z.string().datetime().optional(),
});

export const foreshadowRegistrySchema = z.object({
  items: z.array(foreshadowEntrySchema).default([]),
  version: z.number().int().nonnegative().default(0),
  updatedBy: z.enum(['user', 'agent', 'sync']).default('agent'),
});

export type ForeshadowEntry = z.infer<typeof foreshadowEntrySchema>;
export type ForeshadowRegistry = z.infer<typeof foreshadowRegistrySchema>;

/**
 * transformForeshadowToPromise 输入 envelope（容错：接受已 parse 的 ForeshadowRegistry 或 raw YAML shape）。
 *
 * E5：per-element safeParse 容错——单个坏 foreshadow 条目（缺 content / status 越界等）不丢全 registry，
 * 坏条目跳过 + console.warn，好条目正常迁移。localProjectRepository 注册表层 safeParse 保留作快速 corrupt 判定，
 * 但 transform 内 per-element 容错（mirror CR-4.1-07 story_decisions per-element 先例）。
 * ForeshadowRegistry（已 parse，items: ForeshadowEntry[]）structurally 满足此 envelope，向后兼容。
 */
export interface ForeshadowMigrationInput {
  items?: unknown;
  version?: unknown;
  updatedBy?: unknown;
}

// ── 迁移 transform（design §6 映射规则）──

/**
 * 把旧 foreshadow_registry 迁移成新 promise_registry（零删数据）。纯函数，无副作用。
 *
 * status 映射（design §6）：
 * - pending/planted → Promise status='open' + plant beat（sceneRef=plant_ref）。
 * - resolved/partially_resolved → Promise status='fulfilled' + plant beat + payoff beat
 *   （sceneRef=actual_resolve_ref ?? target_resolve_ref）。
 * - abandoned → Promise status='abandoned'（plant beat 若 plant_ref 存在则保留，否则无 beat）。
 *
 * 字段映射：
 * - content → summary（向读者许了什么）；title 直映；id 保持。
 * - source_type='migrated_foreshadow' + category='setup_payoff'（foreshadow 是 setup_payoff 子类，epics.md:599）。
 * - tags 迁移 + 追加 `fs:<原 category>`（保留原 foreshadow 分类为 tag，零删数据）。
 * - related_foreshadow_ids → related_promise_ids（id 保持，字段改名）。
 * - hint_text/resolution_text/resolution_notes → notes 拼接（零删数据）。
 * - plant_index/target_resolve_index/actual_resolve_index 丢弃（章序位无法精确转 sceneRef，beat 挂 Scene 定位）。
 * - strength/subtlety/urgency/auto_remind 等调参字段不迁移（importance 已承载重要度；其余无 Promise 等价字段）。
 *
 * beat id 用自然键 `${promiseId}::${sceneRef}`（与 applyPromiseActions normalizeBeat 一致）；同 Scene 内 plant+payoff
 * 同场（plant_ref==resolve_ref 罕见）由 Map 去重——后写 kind（payoff）覆盖前写（plant），符合「同 Scene+Promise 一 beat」
 * 幂等（system.md:199）。beat created_at：plant 用 planted_at，payoff 用 resolved_at ?? planted_at（B4——丢 resolved_at）。
 *
 * E5：per-element safeParse 容错——单个坏条目（缺 content / status 越界等）不丢全 registry：坏条目 console.warn +
 * 跳过，好条目正常迁移（mirror CR-4.1-07 story_decisions per-element 先例）。输入 envelope 容错（ForeshadowMigrationInput），
 * items 非数组视作空；version/updatedBy 越界值 fallback default（输出恒为合法 PromiseRegistry）。
 *
 * 返回值经 promiseRegistrySchema.parse 校验 + 应用 defaults（输出恒为合法 PromiseRegistry）。
 */
export function transformForeshadowToPromise(registry: ForeshadowMigrationInput): PromiseRegistry {
  const promises: PromiseRegistry['promises'] = [];
  const beats: PromiseRegistry['beats'] = [];

  // 容错 envelope：items 非数组时视作空（不 crash）。
  const rawItems = Array.isArray(registry?.items) ? (registry as { items: unknown[] }).items : [];

  for (const rawItem of rawItems) {
    // E5：per-element safeParse——坏条目跳过（console.warn），不丢全 registry。
    // mirror CR-4.1-07 story_decisions per-element 先例（schema defaults 已填——tags/related_* 非 undefined）。
    const parsedItem = foreshadowEntrySchema.safeParse(rawItem);
    if (!parsedItem.success) {
      console.warn(
        '[transformForeshadowToPromise] 跳过损坏的 foreshadow 条目（schema 校验失败，零删好条目）:',
        parsedItem.error.issues,
      );
      continue;
    }
    const item = parsedItem.data;
    const promiseId = item.id;
    const plantRef = item.plant_ref;
    const resolveRef = item.actual_resolve_ref ?? item.target_resolve_ref;

    type BeatSpec = { kind: 'plant' | 'payoff'; sceneRef: string };
    const beatSpecs: BeatSpec[] = [];

    let status: PromiseRegistry['promises'][number]['status'];
    switch (item.status) {
      case 'pending':
      case 'planted':
        status = 'open';
        if (plantRef) beatSpecs.push({ kind: 'plant', sceneRef: plantRef });
        break;
      case 'resolved':
      case 'partially_resolved':
        status = 'fulfilled';
        if (plantRef) beatSpecs.push({ kind: 'plant', sceneRef: plantRef });
        if (resolveRef) beatSpecs.push({ kind: 'payoff', sceneRef: resolveRef });
        break;
      case 'abandoned':
        status = 'abandoned';
        if (plantRef) beatSpecs.push({ kind: 'plant', sceneRef: plantRef });
        break;
    }

    // notes：拼接 foreshadow 文本字段（零删数据——hint/resolution 无 Promise 等价字段，进 notes 保留）。
    const noteParts: string[] = [];
    if (item.notes) noteParts.push(item.notes);
    if (item.hint_text) noteParts.push(`[暗示] ${item.hint_text}`);
    if (item.resolution_text) noteParts.push(`[兑现文本] ${item.resolution_text}`);
    if (item.resolution_notes) noteParts.push(`[兑现备注] ${item.resolution_notes}`);
    const notes = noteParts.length > 0 ? noteParts.join('\n') : undefined;

    // tags：迁移 + 追加原 foreshadow category（零删数据——原分类信息作 tag 保留）。
    const tags = [...item.tags];
    if (item.category) tags.push(`fs:${item.category}`);

    promises.push({
      id: promiseId,
      title: item.title,
      summary: item.content,
      status,
      importance: item.importance,
      category: 'setup_payoff',
      tags,
      source_type: 'migrated_foreshadow',
      related_asset_ids: item.related_asset_ids,
      related_promise_ids: item.related_foreshadow_ids,
      notes,
      autoFulfill: true,
      sourceRefs: item.sourceRefs,
      created_at: item.created_at,
      updated_at: item.updated_at,
    });

    // beat 去重：同 (promiseId, sceneRef) 一 beat（system.md:199）——Map keyed by natural id，后写覆盖前写。
    // B4：payoff beat created_at 用 resolved_at ?? planted_at（plant 用 planted_at）——丢 resolved_at 时间戳。
    const beatMap = new Map<string, PromiseRegistry['beats'][number]>();
    for (const spec of beatSpecs) {
      const beatId = `${promiseId}::${spec.sceneRef}`;
      const createdAt =
        spec.kind === 'payoff' ? (item.resolved_at ?? item.planted_at) : item.planted_at;
      beatMap.set(beatId, {
        id: beatId,
        promiseId,
        sceneRef: spec.sceneRef,
        kind: spec.kind,
        created_at: createdAt,
      });
    }
    for (const beat of beatMap.values()) {
      beats.push(beat);
    }
  }

  // version/updatedBy：从 envelope 容错提取（raw YAML 越界值 → fallback default），保证输出恒为合法 PromiseRegistry。
  const rawVersion = (registry as { version?: unknown })?.version;
  const rawUpdatedBy = (registry as { updatedBy?: unknown })?.updatedBy;
  const version =
    typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion >= 0
      ? rawVersion
      : 0;
  const updatedBy: 'user' | 'agent' | 'sync' =
    rawUpdatedBy === 'user' || rawUpdatedBy === 'agent' || rawUpdatedBy === 'sync'
      ? rawUpdatedBy
      : 'agent';

  return promiseRegistrySchema.parse({
    promises,
    beats,
    version,
    updatedBy,
  });
}
