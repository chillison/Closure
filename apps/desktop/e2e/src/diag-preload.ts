// dogfood R2 #99 诊断：枚举执行上下文 + reload 抓 console（找 preload 死因）。
import { chromium, type ConsoleMessage } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.filter((p) => !p.url().startsWith('devtools://')).pop();
if (!page) throw new Error('no page');
console.log('PAGE', page.url());

const session = await page.context().newCDPSession(page);
const contexts: { id: number; name: string; aux?: unknown }[] = [];
session.on('Runtime.executionContextCreated', (ev: { context: { id: number; name: string; origin?: string } }) => {
  contexts.push({
    id: ev.context.id,
    name: ev.context.name,
    aux: ev.context.origin,
  });
});
await session.send('Runtime.enable');
await new Promise((r) => setTimeout(r, 800));
console.log('CONTEXTS', JSON.stringify(contexts));

const logs: string[] = [];
page.on('console', (m: ConsoleMessage) => {
  logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));

await page.evaluate(() => location.reload());
await page.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 4000));
console.log('CONSOLE_DUMP');
for (const l of logs) console.log(l);
console.log('BRIDGE_AFTER_RELOAD', await page.evaluate(() => typeof (window as { orisonDesktop?: unknown }).orisonDesktop));

// isolated world 里直接问 contextBridge 是否曾执行：尝试在所有 context 里求值
for (const ctx of contexts) {
  try {
    const res = await session.send('Runtime.evaluate', {
      expression: 'typeof contextBridge',
      contextId: ctx.id,
    });
    console.log(`CTX ${ctx.id} (${ctx.name}) contextBridge:`, JSON.stringify(res.result).slice(0, 120));
  } catch (e) {
    console.log(`CTX ${ctx.id} (${ctx.name}) eval failed:`, String(e).slice(0, 120));
  }
}
await browser.close();
process.exit(0);
