/**
 * quarantine-notify（2026-08-27）：工程文件判腐隔离 → 通知中心透明化。
 *
 * 覆盖 AC：
 * - AC1 schema 非法判腐事件 → 通知中心出现一条含备份文件名的通知（zh 与 en locale 各验一次）。
 * - AC2 正常事件零通知；同工程二次事件不重复发（key 去重）；不同工程各发一条。
 * - 文案形态：recovered（抢救成功）/ noBackup（改名失败）变体。
 *
 * 链路测的是 renderer 半段（tool:event 推送 → useToolEvents → pushNotification →
 * NotificationCenter 渲染）；loadProject 半段（判腐 → 返回结构）在 local-bff
 * localProjectRepository.test.ts 钉。shell 半段（handler → notifyUI）类型锁 +
 * projectMetaFirstNode/fieldSyncIpc 既有 wiring 测试覆盖。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToolEvents } from '../src/shared/hooks/useToolEvents';
import { NotificationCenter } from '../src/features/notifications/NotificationCenter';
import { useAppStore } from '../src/shared/store/appStore';

let emit: ((event: Record<string, unknown>) => void) | undefined;

function Harness() {
  useToolEvents();
  return <NotificationCenter />;
}

function quarantineEvent(projectPath: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'project:quarantined',
    projectPath,
    backupPath: `${projectPath}\\project.yaml.corrupt-2026-08-27T13-25-37-123Z`,
    reason: 'meta.name: must be at least 1 character',
    recovered: false,
    ...overrides,
  };
}

beforeEach(() => {
  emit = undefined;
  useAppStore.setState({
    notifications: [],
    unreadCount: 0,
    notificationPanelOpen: false,
    resolvedLocale: 'zh-CN',
  } as any);
  (window as any).orisonDesktop = {
    onToolEvent: (cb: (event: Record<string, unknown>) => void) => {
      emit = cb;
      return () => { emit = undefined; };
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as any).orisonDesktop;
});

function fire(event: Record<string, unknown>): void {
  act(() => {
    emit!(event);
  });
}

function openPanel(): void {
  act(() => {
    useAppStore.setState({ notificationPanelOpen: true } as any);
  });
}

describe('判腐隔离 → 通知中心（quarantine-notify）', () => {
  it('AC1 zh：判腐事件 → 通知中心渲染含备份文件名的通知（空工程重建文案）', () => {
    render(<Harness />);
    expect(emit).toBeDefined();

    fire(quarantineEvent('C:\\proj\\quat-zh'));
    openPanel();

    // 通知中心渲染：标题 + 正文（含备份文件名 + 自愈指引 + 空工程打开）。
    expect(screen.getByText('工程文件无法解析')).toBeTruthy();
    const body = screen.getByText(/project\.yaml\.corrupt-2026-08-27T13-25-37-123Z/).textContent!;
    expect(body).toContain('原文件已备份至：');
    expect(body).toContain('已以空工程打开');
    expect(body).toContain('与工程同目录，可人工恢复');
    // store 侧：一条未读 + warning 图标 + key 去重身份。
    const state = useAppStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].read).toBe(false);
    expect(state.notifications[0].icon).toBe('warning');
    expect(state.notifications[0].key).toBe('project-quarantine:C:/proj/quat-zh');
    expect(state.unreadCount).toBe(1);
  });

  it('AC1 en：判腐事件 → en locale 下英文文案渲染（含备份文件名）', () => {
    act(() => {
      useAppStore.setState({ resolvedLocale: 'en-US' } as any);
    });
    render(<Harness />);

    fire(quarantineEvent('C:\\proj\\quat-en'));
    openPanel();

    expect(screen.getByText('Project file could not be parsed')).toBeTruthy();
    const body = screen.getByText(/project\.yaml\.corrupt-2026-08-27T13-25-37-123Z/).textContent!;
    expect(body).toContain('The original file was backed up as');
    expect(body).toContain('The project was opened empty');
    expect(useAppStore.getState().notifications).toHaveLength(1);
  });

  it('AC2 防重：同工程二次事件不重复发；不同工程各发一条', () => {
    render(<Harness />);

    fire(quarantineEvent('C:\\proj\\quat-dup'));
    fire(quarantineEvent('C:\\proj\\quat-dup'));
    fire(quarantineEvent('C:\\proj\\quat-other'));

    const items = useAppStore.getState().notifications;
    expect(items).toHaveLength(2);
    expect(items.filter((n) => n.key === 'project-quarantine:C:/proj/quat-dup')).toHaveLength(1);
    expect(items.filter((n) => n.key === 'project-quarantine:C:/proj/quat-other')).toHaveLength(1);
  });

  it('AC2 正常加载零通知：非判腐 tool:event 不产生通知', () => {
    render(<Harness />);

    // 其他 tool:event（file:changed）在无 currentProject 时被既有守卫吞掉；
    // 无论如何都不应产生通知中心条目。
    fire({ type: 'file:changed', projectPath: 'C:\\proj\\quat-normal', path: '/chapters/a.md' });

    expect(useAppStore.getState().notifications).toHaveLength(0);
    expect(useAppStore.getState().unreadCount).toBe(0);
  });

  it('recovered 变体：抢救成功 → 「从可抢救数据重建打开」文案（不误称空工程）', () => {
    render(<Harness />);

    fire(quarantineEvent('C:\\proj\\quat-rec', { recovered: true }));
    openPanel();

    const body = screen.getByText(/project\.yaml\.corrupt-/).textContent!;
    expect(body).toContain('已从可抢救数据重建打开');
    expect(body).not.toContain('已以空工程打开');
  });

  it('noBackup 变体：改名失败（backupPath null）→ 拒因文案（不出现「已备份至 null」）', () => {
    render(<Harness />);

    fire(quarantineEvent('C:\\proj\\quat-nobk', { backupPath: null }));

    const item = useAppStore.getState().notifications[0];
    expect(item).toBeTruthy();
    expect(item.body).toContain('自动备份未成功');
    expect(item.body).toContain('meta.name');
    expect(item.body).not.toContain('null');
  });
});
