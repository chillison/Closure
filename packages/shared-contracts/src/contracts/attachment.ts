import { z } from 'zod';

// ── 选段契约（UI ↔ agent 「选段 → AI 评阅 → 回写」标准契约）──
//
// 历史轨迹：原 `apps/desktop/client/ui/src/shared/types/attachment.ts` 为 UI 侧源；agent 侧
// `apps/desktop/agent/src/runtime/workflow.ts` 镜像 `MessageSelectionAnchor` / `MessageAttachment`
// （手动 keep-in-sync）。Story 7.1 落 shared-contracts 作跨包类型源（mirror shared-contracts 是
// 跨包类型源头的惯例）：RevisionIntent.scope.anchor 须复用 SelectionAnchor（design §2.1 不重定义），
// 其消费者跨 shared-contracts（revision-intent.ts）/ ui（编辑器选区）/ agent（未来直读）。
//
// agent 侧 MessageSelectionAnchor / MessageAttachment 暂保留为 mirror（7.1 不动 agent 运行时契约，
// minimize blast radius；未来统一为共享类型是 cleanup 候选非本 story scope）。
//
// 零 migration：纯 additive（UI 侧 attachment.ts 改为 re-export shim 保持所有现有 import 路径不变）。

/**
 * Locates a selected passage so it can be re-found in the latest manuscript text
 * even after edits drift the original offsets.
 * - `quote`: the exact selected text (primary relocation key)
 * - `prefix` / `suffix`: surrounding context used to disambiguate duplicate quotes
 * - `rangeHint`: character offsets at capture time (best-effort, may be stale)
 */
export interface SelectionAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  rangeHint: { from: number; to: number };
}

/** Zod mirror of {@link SelectionAnchor}（RevisionIntent.scope.anchor schema 引用）。 */
// BMad CR F8：quote 加 .min(1)——空 quote 永远 locate-failed（findExactOccurrenceRanges 空串返 []），
// 在 schema 层拦（mirror lockedItemSchema.field .min(1)）。prefix/suffix 留空合法（边界选区无前/后文）。
export const selectionAnchorSchema = z.object({
  quote: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
  rangeHint: z.object({
    from: z.number().int(),
    to: z.number().int(),
  }),
});

/**
 * A passage selected in the editor, carried as a structured attachment with its
 * provenance (chapter or file) and anchor.
 */
export interface SelectionAttachment {
  type: 'selection';
  id: string;
  label: string;
  text: string;
  sourceType: 'chapter' | 'file';
  chapterId?: string;
  filePath?: string;
  anchor: SelectionAnchor;
}

/** Lightweight pointer to a whole chapter. */
export interface ChapterAttachment {
  type: 'chapter';
  id: string;
  label: string;
}

/** Lightweight pointer to a whole open file. */
export interface FileAttachment {
  type: 'file';
  id: string;
  label: string;
}

/** Any attachment that can be pinned to a message. */
export type Attachment = ChapterAttachment | FileAttachment | SelectionAttachment;
