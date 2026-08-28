import type { StateCreator } from 'zustand';
import { registerProjectReset } from './resetRegistry';

/**
 * 风格卡片 MVP（08-28 C 路）：风格片段对话框的 pending 状态 + 草稿。
 *
 * 链路：leader `request_style_input` 工具 → shell notifyUI（tool:event）→
 * useToolEvents（过 current-project 匹配守卫）→ requestStyleInput 置 pending →
 * App 层挂载 StyleInputDialog。作者提交（sendAgentMessage 结构化标记行消息）或
 * 取消 → clearStyleInput。
 *
 * - **幂等**：已弹开时重复请求不重置（防 leader 重试请求把作者打了一半的草稿提示语
 *   一起换掉）——首个 prompt 保留。
 * - **项目隔离**：pendingStyleInput 是项目作用域 UI 态——提交走当前项目会话的
 *   sendAgentMessage，切项目若不清会把旧项目的对话框提交进新项目（registerProjectReset）。
 * - 不持久化（会话级内存态）：重启丢 pending 无害——对话框没了，对话再触发即可。
 * - **草稿跨隐藏存活**（CR-012，08-28 BMad CR）：cancel/overlay/Esc 只隐藏对话框
 *   （clearStyleInput 清 pending，**不清草稿**）——草稿在 slice 持有，组件卸载不丢；
 *   重开对话框（leader 再请求）草稿还原。清草稿仅两处：提交**发送确认成功后** +
 *   切项目（草稿同 pending 是项目作用域——旧项目打到一半的片段不该漂进新项目）。
 */
export type StyleInputDialogRequest = {
  /** leader 经 request_style_input 传来的可选提示语（显示在对话框顶部）。 */
  prompt?: string;
};

/** 对话框草稿（fragment/notes 双字段；CR-012 起由 slice 持有以跨隐藏存活）。 */
export type StyleInputDraft = {
  fragment: string;
  notes: string;
};

const EMPTY_DRAFT: StyleInputDraft = { fragment: '', notes: '' };

export type StyleInputSlice = {
  /** null = 无待处理请求；非 null = 风格片段对话框弹出（App 层条件挂载）。 */
  pendingStyleInput: StyleInputDialogRequest | null;
  /** 对话框草稿（cancel 只隐藏不清——重开还原；成功提交/切项目才清）。 */
  styleInputDraft: StyleInputDraft;
  /** 弹出对话框（幂等：已弹开时重复请求不重置，草稿也不动）。 */
  requestStyleInput: (prompt?: string) => void;
  /** 隐藏对话框（取消/提交成功后清 pending）。**不清草稿**（CR-012）。 */
  clearStyleInput: () => void;
  /** 草稿写穿（textarea onChange——组件卸载不丢的唯一保障）。 */
  setStyleInputDraft: (patch: Partial<StyleInputDraft>) => void;
  /** 清草稿（提交发送确认成功后调用；切项目也走这里）。 */
  clearStyleInputDraft: () => void;
};

export const createStyleInputSlice: StateCreator<StyleInputSlice, [], [], StyleInputSlice> = (set) => {
  // 切项目清空：pending 对话框只对发起它的项目有效（提交面是当前项目会话）；
  // 草稿同清（CR-012 项目隔离——片段是作者为特定项目准备的）。
  registerProjectReset(() => {
    set({ pendingStyleInput: null, styleInputDraft: EMPTY_DRAFT });
  });

  return {
    pendingStyleInput: null,
    styleInputDraft: EMPTY_DRAFT,

    requestStyleInput(prompt) {
      set((s) => (s.pendingStyleInput ? s : { pendingStyleInput: { prompt } }));
    },

    clearStyleInput() {
      set({ pendingStyleInput: null });
    },

    setStyleInputDraft(patch) {
      set((s) => ({ styleInputDraft: { ...s.styleInputDraft, ...patch } }));
    },

    clearStyleInputDraft() {
      set({ styleInputDraft: EMPTY_DRAFT });
    },
  };
};
