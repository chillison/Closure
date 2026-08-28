import { z } from 'zod';
import { creativeFieldKeySchema } from './creative-fields';

/**
 * Patch target. Either a structured creative field, or 'overview' — the
 * project meta subset (name/logline/synopsis/genre/theme/tone) surfaced on
 * the Overview page. 'overview' is intentionally NOT a CreativeFieldKey: it
 * persists to project meta (json + yaml), not the creative-field store.
 */
// 非 creative-field literal（2.6 注）：'overview' 持久化到 project meta（json+yaml）非 creative-field
// store；'chapter_candidate'（2.6 入 union，CR-4.1-15）= 章节候选，UI 路由 applyAgentFieldPatch IPC
// -> acceptChapterCandidateCore（写 chapters/*.md + 章节元数据 + story_decisions），此前 agentSessionSlice
// 强制 cast 的 type-lie 退役；'story_decisions'（2.6）= 创作决策 ADR 更新，data = {actions:[...]}
// 重放语义，applyFieldPatches story_decisions 分支对 fresh 状态应用（写 novel.story_decisions +
// meta.version bump）。
export const patchFieldSchema = z.union([
  creativeFieldKeySchema,
  z.literal('overview'),
  z.literal('chapter_candidate'),
  z.literal('story_decisions'),
]);

export const fieldPatchEntrySchema = z.object({
  field: patchFieldSchema,
  action: z.enum(['set', 'merge', 'delete']),
  data: z.unknown(),
  fieldVersion: z.number().int().nonnegative(),
  generatedBy: z.string().min(1)
});

export const projectFieldPatchSchema = z.object({
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  patches: z.array(fieldPatchEntrySchema)
});

export type ProjectFieldPatch = z.infer<typeof projectFieldPatchSchema>;
export type FieldPatchEntry = z.infer<typeof fieldPatchEntrySchema>;

// ── Story 2.2 WP-E：story_sync_apply 请求 schema ──

/**
 * story_sync_apply 请求体（正文→设定反哺 applier，write_chapter route 终态调用）。
 *
 * 落 shared-contracts（mirror settingMdUpdateRequestSchema 归属）：shell handler
 * （storySyncHandlers，shell 包无 zod 直接依赖——schema 校验面全在 shared）与 agent builtin
 * 工具参数面共享单源，防两入口 shape 漂移。patch 逐条经 fieldPatchEntrySchema（field 白名单
 * 含 'overview'——handler 侧 creative-field 门再收窄，story-sync 永不产 overview）。
 */
export const storySyncApplyRequestSchema = z.object({
  runId: z.string().min(1),
  patches: z.array(fieldPatchEntrySchema).min(1),
  autoApply: z.boolean().optional(),
  chapterNote: z.string().optional(),
});

export type StorySyncApplyRequest = z.infer<typeof storySyncApplyRequestSchema>;
