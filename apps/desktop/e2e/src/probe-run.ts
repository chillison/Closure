/**
 * probe-run.ts —— 主会话 CDP 探针 runner（R9 资产）。
 * 从磁盘读 JS 文件原文（绕 bash 命令替换的转义/过滤链），attach 到 dev 实例求值，
 * 打印 JSON。用法：npx tsx src/probe-run.ts <probe.js 绝对/相对路径>
 * （不 import attach.ts——其顶层 main() 会在模块加载时执行。）
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('usage: tsx src/probe-run.ts <probe.js>');
  const js = readFileSync(file, 'utf8');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith('devtools://'));
  if (pages.length !== 1) throw new Error(`expected 1 page, got ${pages.length}: ${pages.map((p) => p.url()).join(', ')}`);
  const value = await pages[0]!.evaluate(js);
  console.log(JSON.stringify(value));
  browser.close();
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('probe failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
