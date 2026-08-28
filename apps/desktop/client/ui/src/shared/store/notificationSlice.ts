import type { StateCreator } from 'zustand';

export type NotificationItem = {
  id: string;
  /**
   * 去重身份（quarantine-notify，2026-08-27）：同 key 的通知仍在列表中时，后续同 key 的
   * push 被忽略（防重）。用户「清除全部」后视为已读历史，同 key 新事实可再次出现。
   */
  key?: string;
  title: string;
  body?: string;
  icon?: string;
  timestamp: number;
  read: boolean;
};

export type NotificationSlice = {
  notifications: NotificationItem[];
  unreadCount: number;
  notificationPanelOpen: boolean;
  toggleNotificationPanel: () => void;
  pushNotification: (title: string, body?: string, icon?: string, key?: string) => void;
  markAllRead: () => void;
  clearNotifications: () => void;
};

export const createNotificationSlice: StateCreator<NotificationSlice, [], [], NotificationSlice> = (set, get) => ({
  notifications: [],
  unreadCount: 0,
  notificationPanelOpen: false,
  toggleNotificationPanel: () => {
    const opening = !get().notificationPanelOpen;
    if (opening) {
      set({ notificationPanelOpen: true, notifications: get().notifications.map((n) => ({ ...n, read: true })), unreadCount: 0 });
    } else {
      set({ notificationPanelOpen: false });
    }
  },
  pushNotification: (title, body, icon, key) => {
    // key 去重（quarantine-notify AC2 防重）：同 key 通知未清空前不重复追加。
    if (key && get().notifications.some((n) => n.key === key)) return;
    const item: NotificationItem = { id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, key, title, body, icon, timestamp: Date.now(), read: false };
    const next = [item, ...get().notifications].slice(0, 50);
    set({ notifications: next, unreadCount: next.filter((n) => !n.read).length });
  },
  markAllRead: () => set({ notifications: get().notifications.map((n) => ({ ...n, read: true })), unreadCount: 0 }),
  clearNotifications: () => set({ notifications: [], unreadCount: 0 }),
});
