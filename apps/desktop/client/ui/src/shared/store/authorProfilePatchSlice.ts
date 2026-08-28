import type { StateCreator } from 'zustand';
import { storage } from './storage';

/**
 * Story 8.6 R4 (design D6 / §3.1): resolved-state registry for
 * author_profile_patch cards — mirror settingMdPatchSlice.
 *
 * The cards themselves are STATELESS renderers over tool-message metadata
 * (mirror SettingMdPatchCard — data lives in the message; the card is a
 * projection, not a copy). Only "this card was accepted / rejected" needs
 * store state, so accept/reject buttons disappear and the header shows the
 * resolved badge. Keyed by the card's stable identity (toolCallId, falling
 * back to a content identity — see AuthorProfilePatchCard.authorProfilePatchCardKey).
 *
 * Resolved value is TWO-VALUED ('applied' | 'rejected', CR-08-16-007 mirror):
 * accept (appended to ~/.orison/author_profile.md via the author-profile:apply
 * IPC) and reject (local discard, never written) share the resolved flag but
 * must NOT share the badge — a rejected note showing "✓ Applied" states the
 * opposite of what happened.
 *
 * No registerProjectReset (deliberate difference from settingMdPatchSlice):
 * the author profile is a machine-level global file — an accept after a
 * project switch appends to the SAME global file, so the "write into the old
 * project" hazard that motivates the setting-md reset does not exist.
 *
 * dogfood R2 #27：**持久化到 localStorage（写穿，mirror imageGenSlice）**。原「不持久化
 * （session-scoped）」的放宽在 #25 钉底后不再成立：重启后 resolved map 清空 → 已应用过的
 * 卡重新钉底待决 → 再点一次接受 = 往全局档案**重复追加同一条**（用户 08-26 实录：14:03
 * 应用 + 14:45 重启后重 accepting，档案双条，已手工去重）。key = toolCallId 全局唯一，
 * map 只增不改写，机器级体积可忽略。
 */
export type AuthorProfilePatchSlice = {
  resolvedAuthorProfilePatches: Record<string, 'applied' | 'rejected'>;
  /** Mark an author-profile note card as handled ('applied' = appended via the accept IPC / 'rejected' = locally discarded). */
  resolveAuthorProfilePatch: (key: string, outcome: 'applied' | 'rejected') => void;
};

export const createAuthorProfilePatchSlice: StateCreator<AuthorProfilePatchSlice, [], [], AuthorProfilePatchSlice> = (set) => ({
  resolvedAuthorProfilePatches: storage.get<Record<string, 'applied' | 'rejected'>>('resolvedAuthorProfilePatches', {}),
  resolveAuthorProfilePatch: (key, outcome) =>
    set((s) => {
      const next = { ...s.resolvedAuthorProfilePatches, [key]: outcome };
      storage.set('resolvedAuthorProfilePatches', next);
      return { resolvedAuthorProfilePatches: next };
    }),
});
