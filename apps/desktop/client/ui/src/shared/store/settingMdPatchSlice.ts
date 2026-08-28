import type { StateCreator } from 'zustand';
import { storage } from './storage';

/**
 * Story 2.2 WP-B: resolved-state registry for setting_md_patch cards.
 *
 * The cards themselves are STATELESS renderers over tool-message metadata
 * (mirror ReviewFindingsCard — data lives in the message; the card is a
 * projection, not a copy). Only "this card was accepted / rejected" needs
 * store state, so accept/reject buttons disappear and the header shows the
 * resolved badge. Keyed by the card's stable identity (toolCallId, falling
 * back to a content identity — see SettingMdPatchCard.settingMdPatchCardKey).
 *
 * CR-08-16-007: the resolved value is TWO-VALUED ('applied' | 'rejected') —
 * accept (landed on disk) and reject (local discard, never written) share the
 * resolved flag but must NOT share the badge: a rejected patch showing
 * "✓ Applied" states the opposite of what happened.
 *
 * Not persisted (session-scoped, mirror insightInteractionSlice.dismissed):
 * after a session switch historical cards render resolved-free — accepting
 * again is harmless because the IPC re-applies against the CURRENT file.
 *
 * dogfood R2 #27：**持久化到 localStorage（写穿）+ 项目切换 reset 退役**。原「不持久化
 * + registerProjectReset」组合在 #25 钉底后有两处伤：① 重启后 map 清空 → 已处理卡重新
 * 钉底待决（author_profile 族已实录重复追加）；② 切项目清 map → 切回来重问。reset 退役
 * 安全性：key = toolCallId 全局唯一（session uuid 全局），跨项目无碰撞；卡只随**当前视图**
 * 的消息渲染（切项目即整面换掉，旧项目卡不存留），accept 又只对 currentProject 发 IPC
 * ——「切项目后经旧卡写进旧项目」的通路本来就不存在，reset 是多余防御且与持久化互斥
 * （清内存不清 storage，回到项目重问）。
 */
export type SettingMdPatchSlice = {
  resolvedSettingMdPatches: Record<string, 'applied' | 'rejected'>;
  /** Mark a setting-md patch card as handled ('applied' = landed via accept IPC / 'rejected' = locally discarded). */
  resolveSettingMdPatch: (key: string, outcome: 'applied' | 'rejected') => void;
};

export const createSettingMdPatchSlice: StateCreator<SettingMdPatchSlice, [], [], SettingMdPatchSlice> = (set) => ({
  resolvedSettingMdPatches: storage.get<Record<string, 'applied' | 'rejected'>>('resolvedSettingMdPatches', {}),
  resolveSettingMdPatch: (key, outcome) =>
    set((s) => {
      const next = { ...s.resolvedSettingMdPatches, [key]: outcome };
      storage.set('resolvedSettingMdPatches', next);
      return { resolvedSettingMdPatches: next };
    }),
});
