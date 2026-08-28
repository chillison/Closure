/**
 * attach.ts —— 附着式驱动（drive.ts 的 attach 形态）。
 *
 * 目标 =「用户正在看的那个 dev 实例」：shell 主进程在未打包时经
 * appendSwitch('remote-debugging-port') 常开 CDP 口（ORISON_CDP_PORT 可换，
 * 默认 9222，非法值回落 9222——shell 侧同款校验）。本脚本一次性 connectOverCDP、
 * 执行**单条**与 dispatchRoute 相同的操作路由、打印 JSON 后退出——由 Claude 主会话
 * 按需反复调用，无常驻进程。与 drive.ts 的差别：不 launch 自己的实例，也不响应
 * /close（附着模式绝不能杀用户的 app；/close 在此被显式拒绝）。
 *
 * 附着页选择：预期 dev 实例只有**一个**真实页面（主窗口）。单候选 = 直接附着
 * （末位即唯一）；多候选属于歧义态（用户开了第二窗口/实验面），静默挑末位会把
 * 驱动/截图打错目标——抛 ambiguous 错误并列出候选 URL，让操作者先关多余窗口或
 * 跑 `list` 自查（BMad CR 组4）。devtools:// 目标恒跳过；无可附页面 → 可读报错
 * （app 未起 / 口未开 / 还在启动）。
 *
 * 用法：
 *   tsx src/attach.ts list                                   # 列出可附着的页面（连通性自检）
 *   tsx src/attach.ts eval '<js>'                            # 页内求值（如 eval 'location.href'）
 *   tsx src/attach.ts '{"route":"POST /switch-page","body":{"page":"structure"}}'
 *   tsx src/attach.ts '{"route":"POST /snapshot","body":{"step":"structure-top"}}'
 *   tsx src/attach.ts '{"route":"GET /read","query":{"selector":"css:.workbench"}}'
 *   tsx src/attach.ts '{"route":"POST /wait","body":{"selector":"[data-workbench]"}}'
 *   tsx src/attach.ts '{"route":"GET /errors"}'              # 读 renderer 错误环（R9：仅 dev 构建有）
 *   tsx src/attach.ts '{"route":"GET /errors","query":{"clear":"1"}}'  # 读取并清空（读取即清）
 *   tsx src/attach.ts '{"port":9223,"route":"POST /snapshot"}'   # 非默认口
 *
 * 连接自愈：connectOverCDP 失败（超时/拒连）自动重试一次（间隔 1.5s）；仍失败时
 * 报错自带端口诊断一行文案（是否在监听的判断提示，不做进程探测）。
 *
 * 错误环说明：window.__orisonErrors 由渲染入口 shell/renderer/main.tsx 在
 * import.meta.env.DEV 分支挂载（实现见 @desktop-ui/shared/dev/consoleRing），
 * 生产打包零字节不存在——本路由对未挂载页返回 entries:[] 并附 hint 字段。
 *
 * 产物落盘与 drive 模式同一约定：docs/tests/<YYYY-MM-DD>-<story>/（gitignored）。
 */
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import { artifactsDirFor, screenshot, writeLog } from './artifacts.js';
import { activeTaskStorySlug } from './checklist/parse.js';
import { dispatchRoute, type DriveContext } from './drive.js';

interface AttachRequest {
  route: string;
  body?: unknown;
  query?: Record<string, string>;
  port?: number;
}

const CDP_DEFAULT_PORT = 9222;
/** connectOverCDP 兜底超时：口未开时 Chromium 默认等 30s+ 才失败——8s 内给可读报错。 */
const CONNECT_TIMEOUT_MS = 8000;
/** 连接失败自动重试次数（含首试；重试只覆盖建连阶段，附着后的歧义/无页错误不重试）。 */
const CONNECT_MAX_ATTEMPTS = 2;
/** 重试间隔。 */
const CONNECT_RETRY_DELAY_MS = 1500;
/**
 * renderer 错误环在 window 上的键名——消费侧镜像常量。
 * 单源：@desktop-ui/shared/dev/consoleRing.ts（ERROR_RING_WINDOW_KEY）；改动须两处同步。
 */
const ERRORS_WINDOW_KEY = '__orisonErrors';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按最后一次错误类别给出「是否在监听」的一行诊断文案（仅文本提示，不做进程探测）。 */
function cdpDiagnosticHint(lastMessage: string, port: number): string {
  if (/refused|econnrefused|fetch failed|net::err/i.test(lastMessage)) {
    return `nothing answered on http://127.0.0.1:${port} — nothing is listening yet: `
      + 'start the dev app (ORISON_CDP_PORT != 0) and wait for its window to appear.';
  }
  if (/timeout|timed out/i.test(lastMessage)) {
    return `the endpoint accepted a connection but the CDP handshake did not complete in time — `
      + `:${port} is likely still booting or busy; retry once the app window is up.`;
  }
  return 'confirm the dev app is running with its remote-debugging port open (ORISON_CDP_PORT != 0).';
}

/** connectOverCDP 带一次自动重试（间隔 CONNECT_RETRY_DELAY_MS）；两次均败则报错附带端口诊断。 */
async function connectWithRetry(port: number) {
  let lastMessage = '';
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (attempt < CONNECT_MAX_ATTEMPTS) await delay(CONNECT_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `connectOverCDP failed on :${port} after ${CONNECT_MAX_ATTEMPTS} attempts`
    + ` (${CONNECT_RETRY_DELAY_MS}ms apart). Last error: ${lastMessage}. ${cdpDiagnosticHint(lastMessage, port)}`,
  );
}

/** ORISON_CDP_PORT / 显式 port 数值校验：十进制数字串且落在 1–65535；否则可读报错
 * （'0' 在 shell 侧是显式关闭语义——附着侧拿到 0 即端口没开，同样按非法处理提示）。 */
export function resolveCdpPort(raw: string | undefined): number {
  const value = raw?.trim() ?? '';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(
      `invalid ORISON_CDP_PORT value "${raw ?? ''}" — expected a decimal number 1-65535 `
      + `(the shell treats "0" as "CDP disabled"; start the dev app without ORISON_CDP_PORT=0)`,
    );
  }
  return Number(value);
}

/**
 * Attach to the dev app's single real page over CDP. Devtools targets are
 * skipped; throws a readable error when nothing is attachable (app not
 * running / port not open / still booting) and an ambiguity error when more
 * than one candidate exists (pick-the-last would silently target a window the
 * user may not be looking at — see file header). Single-candidate case takes
 * that page directly (candidates[length-1] = 最后创建的窗口，dev 常态下即唯一主窗)。
 */
export async function attachLastPage(cdpPort: number) {
  // 建连失败自动重试一次（超时/拒连同权），两次均败报可读端口诊断。
  const browser = await connectWithRetry(cdpPort);
  const pages = browser.contexts().flatMap((c) => c.pages());
  const candidates = pages.filter((p) => !p.url().startsWith('devtools://'));
  if (candidates.length === 0) {
    throw new Error(
      `no attachable page on :${cdpPort} (${pages.length} total). Is the dev app running?`,
    );
  }
  // 多页附着歧义防御（BMad CR 组4）：列出候选 URL，操作者关掉多余的再试或先跑 list。
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous attach on :${cdpPort} — ${candidates.length} non-devtools pages:\n`
      + candidates.map((p) => `  - ${p.url()}`).join('\n')
      + `\nrun \`tsx src/attach.ts list\` to inspect; close extra windows and retry.`,
    );
  }
  return { browser, page: candidates[candidates.length - 1]! };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: tsx src/attach.ts list | eval \'<js>\' | <json request>');
    process.exit(1);
  }

  const envPort = resolveCdpPort(process.env.ORISON_CDP_PORT ?? String(CDP_DEFAULT_PORT));
  const cdpPort =
    arg === 'list' ? envPort : (() => {
      try {
        const parsed = JSON.parse(arg) as AttachRequest;
        return parsed.port ?? envPort;
      } catch {
        return envPort;
      }
    })();

  const { browser, page } = await attachLastPage(cdpPort);

  if (arg === 'list') {
    for (const p of browser.contexts().flatMap((c) => c.pages())) {
      console.log(JSON.stringify({ url: p.url() }));
    }
    return;
  }

  if (arg === 'eval') {
    const value = await page.evaluate(process.argv[3] ?? '1+1');
    console.log(JSON.stringify(value));
    return;
  }

  const req = JSON.parse(arg) as AttachRequest;
  if (req.route === 'POST /close') {
    console.log(
      JSON.stringify({
        ok: false,
        error: 'refused: attach mode never closes the user\'s running app',
      }),
    );
    return;
  }

  const query = new URLSearchParams(req.query ?? {});
  const { method, pathname } = parseRoute(req.route);

  // R9：GET /errors —— 读 renderer 错误环（dev 构建才有），?clear=1 读取即清。
  // 不占用 drive 路由表（attach 自有路由，drive 模式不感知本环）。
  // verb 门禁：「读取即清」是有副作用语义的读路由——非 GET verb（如手滑写
  // POST /errors）必须显式报错，不能静默执行读取/清空路径。
  if (pathname === '/errors') {
    if (method !== 'GET') {
      throw new Error(
        `/errors is GET-only (got ${method}) — use {"route":"GET /errors"} or bare "/errors"`,
      );
    }
    const clear = query.get('clear') === '1';
    const snapshot = await snapshotErrorRing(page, clear);
    console.log(JSON.stringify(errorRingResult(snapshot, clear)));
    return;
  }

  const story = activeTaskStorySlug() ?? 'manual';
  const ctx: DriveContext = {
    window: page,
    artifactsDir: artifactsDirFor(story),
    screenshotFn: screenshot,
    logFn: writeLog,
  };

  const result = await dispatchRoute(method, pathname, query, req.body ?? {}, ctx);
  console.log(JSON.stringify(result));
}

/** "POST /snapshot" -> POST + /snapshot；裸路径亦接受（/read、/errors 默认 GET，余 POST）。 */
function parseRoute(route: string): { method: string; pathname: string } {
  const m = route.trim().match(/^(GET|POST)\s+(\/\S+)$/);
  if (m) return { method: m[1]!, pathname: m[2]! };
  const path = route.startsWith('/') ? route : `/${route}`;
  return { method: path === '/read' || path === '/errors' ? 'GET' : 'POST', pathname: path };
}

interface ErrorRingSnapshot {
  installed: boolean;
  entries: unknown[];
}

/**
 * 读取 renderer 错误环（window.__orisonErrors）。未挂载（生产构建/早于本功能的
 * 会话）返回 installed:false；clear=true 时先快照再原地清空——对暴露数组做
 * length=0，捕获侧继续持有同一引用，清空后新错误照常入环。
 */
async function snapshotErrorRing(page: Page, clear: boolean): Promise<ErrorRingSnapshot> {
  return page.evaluate(
    ({ key, clear: doClear }) => {
      const raw = (window as unknown as Record<string, unknown>)[key];
      if (!Array.isArray(raw)) return { installed: false as const, entries: [] };
      const entries = raw.map((entry) =>
        entry && typeof entry === 'object' ? { ...(entry as Record<string, unknown>) } : entry,
      );
      if (doClear) (raw as unknown[]).length = 0;
      return { installed: true as const, entries };
    },
    { key: ERRORS_WINDOW_KEY, clear },
  );
}

/** /errors 输出装配：不存在则附 hint 说明为何为空。 */
function errorRingResult(snapshot: ErrorRingSnapshot, cleared: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ok: true,
    count: snapshot.entries.length,
    cleared,
    entries: snapshot.entries,
  };
  if (!snapshot.installed) {
    out.hint =
      `window.${ERRORS_WINDOW_KEY} not found on this page — the error ring mounts only in dev builds `
      + '(import.meta.env.DEV branch of client/shell/renderer/main.tsx). '
      + 'If the app was booted before this feature landed, restart the dev app.';
  }
  return out;
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('attach failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
