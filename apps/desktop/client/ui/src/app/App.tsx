import { useEffect } from 'react';
import { useAppStore } from '../shared/store/appStore';
import { TopBar } from '../features/top-bar/TopBar';
import { ProjectsPage } from '../pages/projects/ProjectsPage';
import { WorkspacePage } from '../pages/workspace/WorkspacePage';
import { CommandPalette } from '../features/command-palette/CommandPalette';
import { Toast } from '../shared/components/Toast';
import { ConfirmDialog } from '../shared/components/ConfirmDialog';
import { useToolEvents } from '../shared/hooks/useToolEvents';
import { useCloseGuard } from '../shared/hooks/useCloseGuard';
import { StyleInputDialog } from '../features/agent-panel/StyleInputDialog';

export function App() {
  const currentProject = useAppStore((s) => s.currentProject);
  const loadUserPreferences = useAppStore((s) => s.loadUserPreferences);
  const loadModelConfig = useAppStore((s) => s.loadModelConfig);
  const loadAppVersion = useAppStore((s) => s.loadAppVersion);
  const subscribeUpdateEvents = useAppStore((s) => s.subscribeUpdateEvents);
  // 世界状态面板（#92）：world:changed 事件订阅与 update 事件同组织——App 引导期一次挂。
  const subscribeWorldEvents = useAppStore((s) => s.subscribeWorldEvents);
  const restoreLastProject = useAppStore((s) => s.restoreLastProject);
  // #92 事件门控配套：面板可见性通知——worldStateSlice 的事件响应以 activeSidebarPanel
  // === 'world' 门控（面板关闭不重拉），关→开边沿由 onWorldPanelVisibility force 重拉
  // 当前视图作读侧补偿（面板关闭期间被门控丢弃的 world:changed 事件兜底）。
  const activeSidebarPanel = useAppStore((s) => s.activeSidebarPanel);
  const onWorldPanelVisibility = useAppStore((s) => s.onWorldPanelVisibility);
  const worldPanelVisible = activeSidebarPanel === 'world';
  // 08-25 全窗口壁纸（唯一背景层，不分区）：url 空不渲染。08-29 滑杆化：可调磨砂
  // （wallpaperFrostBlur 0–50px 打壁纸层自身；0 = 关，层不带 filter/transform）。
  const wallpaperUrl = useAppStore((s) => s.wallpaperUrl);
  const wallpaperOpacity = useAppStore((s) => s.wallpaperOpacity);
  const wallpaperFrostBlur = useAppStore((s) => s.wallpaperFrostBlur);
  // 风格卡片 MVP（08-28 C 路）：leader request_style_input → 风格片段对话框（App 级 modal
  // overlay，与 ConfirmDialog 同层；勿挂 AgentMessageItem——它随消息流滚动/被顶出视野）。
  const pendingStyleInput = useAppStore((s) => s.pendingStyleInput);

  useToolEvents();
  useCloseGuard();

  useEffect(() => {
    void loadUserPreferences();
    void loadModelConfig();
    void loadAppVersion();
    restoreLastProject();
    subscribeUpdateEvents();
    subscribeWorldEvents();
  }, [loadUserPreferences, loadModelConfig, loadAppVersion, restoreLastProject, subscribeUpdateEvents, subscribeWorldEvents]);

  useEffect(() => {
    onWorldPanelVisibility(worldPanelVisible);
  }, [worldPanelVisible, onWorldPanelVisibility]);

  return (
    <>
      {wallpaperUrl && (
        <div
          className="app-wallpaper"
          aria-hidden="true"
          style={{
            backgroundImage: `url("${wallpaperUrl}")`,
            opacity: wallpaperOpacity,
            // 08-29 磨砂滑杆化：>0 时内联施加（旧 --frost 固定类退役——强度连续
            // 可调，类切换无法表达）；过扫随 blur 联动 scale(1 + N/400)，N=20 时
            // =1.05 与旧固定磨砂严格一致（不过扫 blur 会把层外虚空采样进边缘，
            // 四周出一圈发虚的暗边）。=0 时不带 filter/transform。
            ...(wallpaperFrostBlur > 0
              ? {
                  filter: `blur(${wallpaperFrostBlur}px)`,
                  transform: `scale(${1 + wallpaperFrostBlur / 400})`,
                }
              : null),
          }}
        />
      )}
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <TopBar />
      {!currentProject ? <ProjectsPage /> : <WorkspacePage />}
      <CommandPalette />
      <Toast />
      <ConfirmDialog />
      {pendingStyleInput !== null && <StyleInputDialog />}
    </>
  );
}
