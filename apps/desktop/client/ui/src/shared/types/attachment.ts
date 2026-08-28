/**
 * Re-export shim: attachment / selection contract types 已迁 shared-contracts 作跨包类型源
 * （Story 7.1——RevisionIntent.scope.anchor 复用 SelectionAnchor，须 shared-contracts 持有）。
 *
 * 历史源：本文件原是 UI 内 attachment 类型定义；7.1 迁 `packages/shared-contracts/src/contracts/attachment.ts`
 * 后改为 re-export 保持所有现有 UI import 路径不变（`from '../../shared/types/attachment'`）。
 *
 * agent 侧 `MessageSelectionAnchor` / `MessageAttachment` 仍是 mirror（`apps/desktop/agent/src/runtime/workflow.ts`），
 * 7.1 未统一（minimize blast radius；未来 cleanup 候选）。
 */
export type {
  SelectionAnchor,
  SelectionAttachment,
  ChapterAttachment,
  FileAttachment,
  Attachment,
} from '@orison/shared-contracts';
export { selectionAnchorSchema } from '@orison/shared-contracts';
