// dogfood R2：20s 网络活动探针——看写章链的 LLM 网关请求是否在流（找卡死/静默断流）。
import { chromium } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
const page = browser.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith('devtools://')).pop();
if (!page) throw new Error('no page');

const session = await page.context().newCDPSession(page);
const events: string[] = [];
// 渲染层 fetch 不经这里（LLM 调用在主进程）——但渲染层若也发请求可见；主要看 WebSocket(SSE 不可见)。
session.on('Network.requestWillBeSent', (ev: { request: { url: string; method: string } }) => {
  const u = ev.request.url;
  if (!/\.js|\.css|\.png|\.woff|@vite|node_modules/.test(u)) events.push(`REQ ${ev.request.method} ${u.slice(0, 110)}`);
});
session.on('Network.webSocketCreated', (ev: { url: string }) => events.push(`WS-CREATED ${ev.url.slice(0, 110)}`));
session.on('Network.webSocketFrameSent', () => events.push('WS-SENT'));
session.on('Network.webSocketFrameReceived', () => events.push('WS-RECV'));
await session.send('Network.enable');
await new Promise((r) => setTimeout(r, 20000));
console.log(events.length ? events.slice(0, 40).join('\n') : '(20s 内渲染层零网络事件——LLM 流在主进程，此处不可见)');

// 主进程侧旁证：renderer 到 main 的 IPC 流量（chain-delta 等推事件）经 CDP 不可见，
// 改看 DOM 是否有任何 mutation（流式 caret / 子执行组文本）。
const before = await page.evaluate(() => document.body.innerText.length);
await new Promise((r) => setTimeout(r, 15000));
const after = await page.evaluate(() => document.body.innerText.length);
console.log(`DOM innerText: ${before} -> ${after} (delta ${after - before})`);
await browser.close();
process.exit(0);
