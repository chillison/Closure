import { create } from 'zustand';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export type ToastItem = {
  id: string;
  message: string;
  level: ToastLevel;
  duration: number;
  /**
   * dogfood T1 Stage 3（D4 同项目单 run 闸）：可选行内动作（如「跳转到运行中会话」）。
   * additive——既有调用（3 参）零改动；带动作的 toast 点击动作钮不冒泡 dismiss（动作
   * 即意图，误关烦人），点消息体仍 dismiss。
   */
  action?: { label: string; onClick: () => void };
};

const DEFAULT_DURATIONS: Record<ToastLevel, number> = {
  success: 2000,
  info: 3000,
  warning: 4000,
  error: 5000,
};

type ToastState = {
  toasts: ToastItem[];
  showToast: (message: string, level?: ToastLevel, duration?: number, action?: ToastItem['action']) => void;
  dismissToast: (id: string) => void;
};

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  showToast: (message, level = 'info', duration?, action?) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const ms = duration ?? DEFAULT_DURATIONS[level];
    const item: ToastItem = { id, message, level, duration: ms, ...(action ? { action } : {}) };
    set((s) => ({ toasts: [...s.toasts.slice(-2), item] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, ms);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
