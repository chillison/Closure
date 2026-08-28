// Bundle the Material Symbols icon font locally instead of loading it from the
// Google Fonts CDN. The CDN fails on offline / firewalled devices (e.g. behind
// the GFW), which left icon ligatures showing as raw text ("chevron_right").
// Vite fingerprints and copies the woff2 into the build output.
import 'material-symbols/outlined.css';
import '@desktop-ui/shared/styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@desktop-ui/app/App';
import { ErrorBoundary } from '@desktop-ui/shared/components/ErrorBoundary';
import { installDevErrorRing } from '@desktop-ui/shared/dev/consoleRing';

// R9 Agent 自调试基建：dev 态错误环。renderer 近期错误落 window.__orisonErrors，
// 由 apps/desktop/e2e/src/attach.ts 的 GET /errors 路由读取（AI 附着自查用）。
// 生产构建零字节：define 把 import.meta.env.DEV 替换为 false → 分支消除 → 本模块
// 再无引用点即被 rollup 整包剔除（须先于 createRoot 挂载，早期异常才有记录）。
if (import.meta.env.DEV) {
  installDevErrorRing(window);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
