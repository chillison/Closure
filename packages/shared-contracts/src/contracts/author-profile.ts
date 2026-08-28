// ── 作者档案（Story 8.6 R4，design D5/D6）──
//
// 作者档案 = `~/.orison/author_profile.md` 自由 markdown（dated entries 追加式，机器级跨项目文件——
// **非 creative field**，不进 project.yaml/field_metadata 体系）。写通道 `author_profile_update`
// （shell handler，Step 2/3）：autoApply=true 直接追加落盘；缺省（suggest 档）产**专用 envelope**
// `author_profile_patch`（非 field_patch——PatchReviewPanel 的 patchFieldSchema 装不下机器级文件，
// mirror 2.2 setting_md_patch 专用分流先例）→ UI 专用卡片（词级 diff 复用 7.5 渲染器）→ accept 走
// 专用 IPC `author-profile:apply`（本文件的 applyAuthorProfileNoteInputSchema）。
//
// append 语义（防覆盖作者手改）：accept 时 shell **重新追加**当前 note（带新日期戳），永不落盘
// proposal 时的 stale `after` 快照——档案在提议与采纳之间可能被作者手改，重放 note（本地化追加）
// 不会覆写任何既有内容（mirror setting_md「accept 重放 actions 非写 stale after」同哲学）。
import { z } from 'zod';

// ── accept-side IPC contract (author-profile:apply) ──

export const applyAuthorProfileNoteInputSchema = z.object({
  /** 要追加的观察笔记原文（handler 落盘时加日期戳标题，一条一个 `## YYYY-MM-DD HH:mm` 段）。
   *  CR-018（8.6 BMad CR）：长度上限 4000——与 agent 工具参数 schema 同步（LLM 失控超长直进机器级档案）。 */
  note: z.string().min(1).max(4000),
});
export type ApplyAuthorProfileNoteInput = z.infer<typeof applyAuthorProfileNoteInputSchema>;

/**
 * Result of appending an author-profile note (accept IPC / autoApply landing).
 * `ok:false.reason` is user-facing (toast) — keep it actionable（模式 A structured error，
 * mirror AcceptSettingMdResult）。
 */
export type ApplyAuthorProfileNoteResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: string };

// ── suggest-tier envelope（author_profile_patch，UI 专用分流消费——Step 5）──

/**
 * `author_profile_update` suggest 档 tool result 的 metadata 形态。`before`/`after` 是
 * **展示面**（档案尾部末 1 条 entry / 追加后尾部预览），非 accept 载荷——accept 走
 * `note` 重新追加（见文件头 append 语义），mirror setting_md_patch 的 before/after 定位。
 */
export interface AuthorProfilePatchMetadata {
  type: 'author_profile_patch';
  /** accept 载荷：要追加的笔记原文（IPC `author-profile:apply` 的 note 入参）。 */
  note: string;
  /** 现档案尾部末 1 条 entry（无则空串）——diff 卡左侧上下文。 */
  before: string;
  /** 追加后尾部预览（before entry + 新 entry）——diff 卡右侧。 */
  after: string;
  /** 档案文件路径（展示用）。 */
  filePath: string;
}
