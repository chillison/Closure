import type { StateCreator } from 'zustand';
import { registerProjectReset } from './resetRegistry';

/**
 * Story 3.7 D3：洞察卡交互的会话级状态——忽略集合 + 「应用并补充」预填。
 *
 * - **忽略 = 会话内隐藏**（用户拍板）：dismissed 不持久化、不建 ledger（3.3「不建状态机」
 *   决议）；真解决由数据自然反映（重算后 issue/finding 消失 = 卡片自然不渲染），dismissed
 *   里的陈旧 key 无害（会话结束随 store 丢弃）。
 * - **全局共享**（单一 store）：同 key 在任何表面忽略处处隐藏（跨面忽略天然同步），
 *   且 session 重同步（done 路径 refetch 重建消息列表）不丢——故进 zustand 而非组件
 *   local state（否则「忽略后复活」假 bug）。
 * - **draftPreset**：「应用并补充」预填输入框不直发（用户补完自己发，sendAgentMessage
 *   由 AgentInput 消费后触发）；AgentInput 消费即 consumeDraft 清空，避免重复注入。
 * - **项目隔离**：registerProjectReset 清两项（spec ui/state-management 硬约束——
 *   旧项目的忽略记录/预填草稿不得泄漏进新项目）。
 */
export type InsightInteractionSlice = {
  /** 会话级忽略集合。键 = insightDismissKey(source, title, quote)。 */
  dismissed: Record<string, true>;
  /** 「应用并补充」预填草稿（一次性：AgentInput 消费即清空）。 */
  draftPreset: string | null;
  dismissInsight: (key: string) => void;
  clearAll: () => void;
  presetDraft: (text: string) => void;
  consumeDraft: () => string | null;
};

/**
 * 洞察身份键（D3）：议题/finding 无稳定 id，key = source + title + (quote||'') 简单拼接。
 * 不用 hash（可读性优先，量级小无碰撞顾虑）；同文本同议题视作同条正是期望语义
 * （重算产的相同 issue 在任何表面共享同一忽略记录）。
 */
export function insightDismissKey(source: string, title: string, quote?: string): string {
  return `${source}\n${title}\n${quote ?? ''}`;
}

export const createInsightInteractionSlice: StateCreator<InsightInteractionSlice, [], [], InsightInteractionSlice> = (set, get) => {
  // 切项目清空：dismissed/draftPreset 均为会话级内存态（不持久化 → 无 storage 复活路径）。
  registerProjectReset(() => {
    set({ dismissed: {}, draftPreset: null });
  });

  return {
    dismissed: {},
    draftPreset: null,

    dismissInsight(key) {
      set((s) => ({ dismissed: { ...s.dismissed, [key]: true } }));
    },

    clearAll() {
      set({ dismissed: {} });
    },

    presetDraft(text) {
      set({ draftPreset: text });
    },

    consumeDraft() {
      const preset = get().draftPreset;
      if (preset !== null) set({ draftPreset: null });
      return preset;
    },
  };
};
