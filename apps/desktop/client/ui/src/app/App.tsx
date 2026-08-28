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
  const restoreLastProject = useAppStore((s) => s.restoreLastProject);
  // 08-25 全窗口壁纸（唯一背景层，不分区）：url 空不渲染。08-26 dogfood 拍板：
  // 可选磨砂（--frost 变体 blur 整层——花背景不再和前景文字抢对比度）。
  const wallpaperUrl = useAppStore((s) => s.wallpaperUrl);
  const wallpaperOpacity = useAppStore((s) => s.wallpaperOpacity);
  const wallpaperFrost = useAppStore((s) => s.wallpaperFrost);
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
  }, [loadUserPreferences, loadModelConfig, loadAppVersion, restoreLastProject, subscribeUpdateEvents]);

  return (
    <>
      {wallpaperUrl && (
        <div
          className={wallpaperFrost ? 'app-wallpaper app-wallpaper--frost' : 'app-wallpaper'}
          aria-hidden="true"
          style={{
            backgroundImage: `url("${wallpaperUrl}")`,
            opacity: wallpaperOpacity,
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
