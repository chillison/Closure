/**
 * real-input.ts —— 真鼠标输入复现器（T16 取证资产）。
 * Playwright mouse.* 走 CDP Input 域 = 与用户物理鼠标同一输入管线（合成 DOM 事件
 * 测不出的原生路径——HTML5 原生拖拽起手阈值/原生 pointer 坐标族）。
 * 用法：npx tsx src/real-input.ts <scene> —— scene 见 switch。
 */
import { chromium } from '@playwright/test';

async function main(): Promise<void> {
  const scene = process.argv[2] ?? 'help';
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith('devtools://'));
  if (pages.length !== 1) throw new Error(`expected 1 page, got ${pages.length}`);
  const page = pages[0]!;
  const mouse = page.mouse;
  const center = async (sel: string) => {
    const el = page.locator(sel).first();
    await el.waitFor({ state: 'visible', timeout: 5000 });
    const box = await el.boundingBox();
    if (!box) throw new Error(`no box for ${sel}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height };
  };
  const readState = () =>
    page.evaluate(() => {
      const chips = [...document.querySelectorAll('.workbench-chip[data-line-id="line-main"]')]
        .filter((c) => !c.className.includes('--pending'))
        .map((c) => ({
          id: c.getAttribute('data-node-id'),
          ch: c.closest('.workbench-slot')?.getAttribute('data-chapter'),
          ri: c.getAttribute('data-read-index'),
          span: c.className.includes('--span'),
        }));
      return chips;
    });

  if (scene === 'help') {
    console.log(JSON.stringify({ scenes: ['resize-s4', 'drag-s6-fwd', 'drag-s6-back'] }));
    return;
  }

  if (scene === 'resize-s4') {
    // 真鼠标右把手拉宽：s4（单章 ch3）右缘拖 2 格。
    const handle = await center('.workbench-chip[data-node-id="s4"][data-line-id="line-main"] .workbench-chip-handle--right');
    const t5 = await center('.workbench-slot[data-chapter="5"][data-slot-line="line-main"]');
    await mouse.move(handle.x, handle.y);
    await mouse.down();
    await mouse.move(t5.x, handle.y, { steps: 12 });
    await page.waitForTimeout(250);
    const mid = await page.evaluate(() => {
      const c = document.querySelector<HTMLElement>('.workbench-chip[data-node-id="s4"][data-line-id="line-main"]');
      return { resizing: c?.className.includes('--resizing'), w: c?.style.width, re: c?.getAttribute('data-resize-end') };
    });
    await mouse.up();
    await page.waitForTimeout(600);
    console.log(JSON.stringify({ mid, after: await readState() }));
    return;
  }

  if (scene === 'drag-s6-fwd' || scene === 'drag-s6-back') {
    const fwd = scene === 'drag-s6-fwd';
    const from = await center(
      fwd
        ? '.workbench-chip[data-node-id="s6"][data-line-id="line-main"]'
        : '.workbench-chip[data-node-id="s6"][data-line-id="line-main"]',
    );
    const target = await center(
      fwd
        ? '.workbench-slot[data-chapter="6"][data-slot-line="line-main"]'
        : '.workbench-slot[data-chapter="5"][data-slot-line="line-main"]',
    );
    await mouse.move(from.x, from.y);
    await mouse.down();
    // HTML5 原生拖拽：先小位移过阈值起手，再大步移到目标。
    await mouse.move(from.x + 18, from.y + 4, { steps: 4 });
    await page.waitForTimeout(120);
    await mouse.move(target.x, target.y - 8, { steps: 10 });
    await page.waitForTimeout(200);
    const over = await page.evaluate((pt) => {
      const els = document.elementsFromPoint(pt.x, pt.y);
      return { top: els[0]?.getAttribute('class') ?? els[0]?.tagName, isSlot: !!els[0]?.closest?.('.workbench-slot') };
    }, target);
    await mouse.up();
    await page.waitForTimeout(600);
    console.log(JSON.stringify({ scene, over, after: await readState() }));
    return;
  }

  if (scene === 'drag-wide-s10') {
    // T16b 位移式平移：s10（宽卡 [6..7]，锚列 6）真鼠标拖到下一格（col7）。
    // 预期：shift=+1 → [7..8]，锚列随移 ch7。用户真机红的原形态。
    const from = await center('.workbench-chip[data-node-id="s10"][data-line-id="line-main"]');
    const target = await center('.workbench-slot[data-chapter="7"][data-slot-line="line-main"]');
    await mouse.move(from.x, from.y);
    await mouse.down();
    await mouse.move(from.x + 18, from.y + 4, { steps: 4 });
    await page.waitForTimeout(120);
    await mouse.move(target.x, target.y - 8, { steps: 10 });
    await page.waitForTimeout(200);
    await mouse.up();
    await page.waitForTimeout(700);
    const s10 = await page.evaluate(() => {
      const c = document.querySelector('.workbench-chip[data-node-id="s10"][data-line-id="line-main"]');
      return { ch: c?.closest('.workbench-slot')?.getAttribute('data-chapter'), w: c ? Math.round(c.getBoundingClientRect().width) : null, span: c?.className.includes('--span') };
    });
    console.log(JSON.stringify({ scene, s10, after: await readState() }));
    return;
  }

  if (scene === 'resize-hold-s6' || scene === 'resize-release-s6' || scene === 'resize-shrink-s6') {
    // T16a 手术中/抬手后连续性：s6（单章 ch5）右把手拖到目标列（argv[3]，缺省 6）。
    // hold=保持手势存活供截图；release=在目标列抬手（真提交）；shrink=拖回 col5
    // 抬手（归单章）。
    const targetCol = Number(process.argv[3] ?? '6');
    const handle = await center('.workbench-chip[data-node-id="s6"][data-line-id="line-main"] .workbench-chip-handle--right');
    const t = await center(scene === 'resize-shrink-s6'
      ? '.workbench-slot[data-chapter="5"][data-slot-line="line-main"]'
      : `.workbench-slot[data-chapter="${targetCol}"][data-slot-line="line-main"]`);
    if (scene === 'resize-shrink-s6') {
      // shrink 起点：先按住（此时 s6 已是 [5..6] 宽卡）
      await mouse.move(handle.x, handle.y);
      await mouse.down();
      await mouse.move(t.x, handle.y, { steps: 10 });
      await page.waitForTimeout(250);
      await mouse.up();
      await page.waitForTimeout(600);
      const s6 = await page.evaluate(() => {
        const c = document.querySelector('.workbench-chip[data-node-id="s6"][data-line-id="line-main"]');
        return { ch: c?.closest('.workbench-slot')?.getAttribute('data-chapter'), span: c?.className.includes('--span'), w: c ? Math.round(c.getBoundingClientRect().width) : null };
      });
      console.log(JSON.stringify({ scene, s6 }));
      return;
    }
    await mouse.move(handle.x, handle.y);
    await mouse.down();
    await mouse.move(t.x, handle.y, { steps: 12 });
    await page.waitForTimeout(300);
    const mid = await page.evaluate(() => {
      const c = document.querySelector<HTMLElement>('.workbench-chip[data-node-id="s6"][data-line-id="line-main"]');
      return { resizing: c?.className.includes('--resizing'), w: c?.style.width, de: c?.getAttribute('data-resize-end') };
    });
    if (scene === 'resize-hold-s6') {
      console.log(JSON.stringify({ scene, mid }));
      return; // 手势保持存活，供外部截图
    }
    await mouse.up();
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => {
      const c = document.querySelector<HTMLElement>('.workbench-chip[data-node-id="s6"][data-line-id="line-main"]');
      return { resizing: c?.className.includes('--resizing'), span: c?.className.includes('--span'), w: c ? Math.round(c.getBoundingClientRect().width) : null, inline: c?.style.width };
    });
    console.log(JSON.stringify({ scene, mid, after }));
    return;
  }

  if (scene === 'hover-hold-s5') {
    // T17 hover 揭示帧：真鼠标停在 s5 chip 上不动，供截图；结束时移开。
    const on = await center('.workbench-chip[data-node-id="s5"][data-line-id="line-main"]');
    await mouse.move(on.x, on.y);
    await page.waitForTimeout(400);
    const arcs = await page.evaluate(() => document.querySelectorAll('.assoc-layer path, .assoc-layer line').length);
    console.log(JSON.stringify({ scene, arcs }));
    await page.waitForTimeout(1500); // 截图窗口
    await mouse.move(on.x + 400, on.y + 200);
    return;
  }

  if (scene === 'drag-wide-back') {
    // T16b 反向腿：s10 现锚 ch7 [7..8]，拖回 col6 → shift=-1 → [6..7] 复原。
    const from = await center('.workbench-chip[data-node-id="s10"][data-line-id="line-main"]');
    const target = await center('.workbench-slot[data-chapter="6"][data-slot-line="line-main"]');
    await mouse.move(from.x, from.y);
    await mouse.down();
    await mouse.move(from.x - 18, from.y + 4, { steps: 4 });
    await page.waitForTimeout(120);
    await mouse.move(target.x, target.y - 8, { steps: 10 });
    await page.waitForTimeout(200);
    await mouse.up();
    await page.waitForTimeout(700);
    const s10 = await page.evaluate(() => {
      const c = document.querySelector('.workbench-chip[data-node-id="s10"][data-line-id="line-main"]');
      return { ch: c?.closest('.workbench-slot')?.getAttribute('data-chapter'), w: c ? Math.round(c.getBoundingClientRect().width) : null };
    });
    console.log(JSON.stringify({ scene, s10 }));
    return;
  }

  if (scene === 'hover-chip') {
    // T17 锚弧 hover 揭示：真鼠标悬停 s5 chip（保持不动），供截图与弧计数读取。
    const on = await center('.workbench-chip[data-node-id="s5"][data-line-id="line-main"]');
    await mouse.move(on.x, on.y);
    await page.waitForTimeout(400);
    const during = await page.evaluate(() => document.querySelectorAll('.assoc-layer path, .assoc-layer line').length);
    await mouse.move(on.x + 400, on.y + 200);
    await page.waitForTimeout(300);
    const afterOff = await page.evaluate(() => document.querySelectorAll('.assoc-layer path, .assoc-layer line').length);
    console.log(JSON.stringify({ scene, arcsDuringHover: during, arcsAfterMoveAway: afterOff }));
    return;
  }

  throw new Error(`unknown scene ${scene}`);
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('real-input failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
