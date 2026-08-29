import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 S3：chapters/ 目录 watcher 单测。索引器 mock（reindexChapter /
// rebuildChapterChunks 捕获调用——本体在 chapterChunkIndexer.test.ts 真跑锚定）；fs.watch +
// debounce + 生命周期 + inflight 串行化走真实实现（真定时器——vi.waitFor 等 debounce 窗）。
// ─────────────────────────────────────────────────────────────────────────────

// macOS FSEvents 按路径合并投递：上一测 rmSync 的删除事件会迟到送达下一测在同一
// 路径上新开的 watcher（公仓 mac CI 首跑实录：非章零触发测收到前测 ch_001/ch_002
// 两笔 reindex）。故 TMP 每测唯一（mkdtemp），从根上消除路径复用的跨测事件串扰。
const tmpBox = vi.hoisted(() => ({ dir: '' }));
let TMP = '';

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => tmpBox.dir,
    isPackaged: false,
  },
}));
const { reindexChapter, rebuildChapterChunks } = vi.hoisted(() => ({
  reindexChapter: vi.fn(
    async (_projectId: string, _projectDir: string, _chapterId: string) => ({
      outcome: 'written',
      chunkCount: 1,
    }),
  ),
  rebuildChapterChunks: vi.fn(
    async (_projectId: string, _projectDir: string) => ({ reindexed: 1, orphaned: 0 }),
  ),
}));
vi.mock('../main/db/chapterChunkIndexer', () => ({ reindexChapter, rebuildChapterChunks }));
vi.mock('../main/db/projectRepository', () => ({
  getProject: vi.fn(() => ({ projectId: '00091' })),
}));

import { allowPath } from '../main/ipc/pathGuard';
import {
  startChapterChunkWatcher,
  stopChapterChunkWatcher,
} from '../main/db/chapterChunkWatcher';

/** 等真实事件循环跑几拍（fs.watch 回调经 libuv——非 faked timer）。 */
const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForCalls(spy: { mock: { calls: unknown[][] } }, n: number, timeoutMs = 5000) {
  const start = Date.now();
  while (spy.mock.calls.length < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${n} calls (got ${spy.mock.calls.length})`);
    }
    await tick(50);
  }
}

function writeChapter(projectDir: string, chapterId: string, content = '正文'): void {
  const dir = path.join(projectDir, 'chapters');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${chapterId}.md`), content, 'utf-8');
}

describe('chapterChunkWatcher（Story 8.3 S3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TMP = tmpBox.dir = mkdtempSync(path.join(os.tmpdir(), 'chapter-chunk-watcher-'));
    allowPath(TMP); // assertSafePath 授权（mirror 生产 project:watch 前的 allowPath）
    stopChapterChunkWatcher();
  });
  afterEach(async () => {
    // libuv Windows fs-event 断言规避（公仓 windows CI threads 池三连实录）：断言
    // `!_wcsnicmp (fs-event.c:72)` 在「事件处理中 close 句柄」时触发——慢 runner 上
    // 事件密集，stop 直接撞上 fs-event 线程在途回调 → C 层 abort 进程（JS 无从捕获；
    // 不删目录后仍复现，故真触发器是 close 竞态非删除）。先等 debounce 窗（500ms）
    // + flush + 余量排空在途事件再关。TMP 每测唯一 mkdtemp（残留 tmpdir 交系统清理）。
    await tick(700);
    stopChapterChunkWatcher();
  });

  it('章文件写事件 → debounce 后 reindexChapter(projectId, projectDir, chapterId)；rebuild 不触发', async () => {
    startChapterChunkWatcher(TMP);
    writeChapter(TMP, 'ch_001');
    await waitForCalls(reindexChapter, 1);
    expect(reindexChapter).toHaveBeenCalledWith('00091', TMP, 'ch_001');
    expect(rebuildChapterChunks).not.toHaveBeenCalled();
  });

  it('debounce 合并：两章连写 → 同一 debounce 窗内零散触发、窗后一次 flush 双章', async () => {
    startChapterChunkWatcher(TMP);
    writeChapter(TMP, 'ch_001');
    writeChapter(TMP, 'ch_002');
    await tick(250); // debounce 窗（500ms）内：尚未 flush
    expect(reindexChapter).not.toHaveBeenCalled();
    await waitForCalls(reindexChapter, 2);
    const ids = reindexChapter.mock.calls.map((c) => c[2]);
    expect(ids.sort()).toEqual(['ch_001', 'ch_002']);
  });

  it('非章路径零触发：settings/*.md 与根级文件不reindex', async () => {
    startChapterChunkWatcher(TMP);
    mkdirSync(path.join(TMP, 'settings'), { recursive: true });
    writeFileSync(path.join(TMP, 'settings', 'magic.md'), '设定', 'utf-8');
    writeFileSync(path.join(TMP, 'notes.md'), '笔记', 'utf-8');
    await tick(900); // 过 debounce 窗 + 余量
    expect(reindexChapter).not.toHaveBeenCalled();
    expect(rebuildChapterChunks).not.toHaveBeenCalled();
  });

  it('子目录章形态（chapters/draft/x.md）不触发', async () => {
    startChapterChunkWatcher(TMP);
    const dir = path.join(TMP, 'chapters', 'draft');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'x.md'), '草稿', 'utf-8');
    await tick(900);
    expect(reindexChapter).not.toHaveBeenCalled();
  });

  it('stop 后不再触发（生命周期）', async () => {
    startChapterChunkWatcher(TMP);
    stopChapterChunkWatcher();
    writeChapter(TMP, 'ch_001');
    await tick(900);
    expect(reindexChapter).not.toHaveBeenCalled();
  });

  it('项目切换 re-point：旧项目事件不再触发', async () => {
    const projectA = path.join(TMP, 'project-a');
    const projectB = path.join(TMP, 'project-b');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    allowPath(projectA);
    allowPath(projectB);
    startChapterChunkWatcher(projectA);
    startChapterChunkWatcher(projectB); // 切换：A 停、B 起
    writeChapter(projectA, 'ch_001');
    writeChapter(projectB, 'ch_002');
    await waitForCalls(reindexChapter, 1);
    expect(reindexChapter).toHaveBeenCalledWith('00091', projectB, 'ch_002');
    expect(reindexChapter.mock.calls.map((c) => c[2])).not.toContain('ch_001'); // A 已停
  });

  it('inflight 串行化：第二个 flush 链在前一个 settle 后（并发 embed 防线）', async () => {
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    reindexChapter.mockImplementation(async (_pid: string, _dir: string, chapterId: string) => {
      order.push(`start:${chapterId}`);
      await new Promise<void>((resolve) => gates.set(chapterId, resolve));
      order.push(`end:${chapterId}`);
      return { outcome: 'written', chunkCount: 1 };
    });

    startChapterChunkWatcher(TMP);
    writeChapter(TMP, 'ch_001');
    await waitForCalls(reindexChapter, 1); // flush1 开跑（挂起）
    writeChapter(TMP, 'ch_002');
    await tick(800); // flush2 debounce 到点 → enqueue（链在 flush1 后，不并发开跑）
    expect(order).toEqual(['start:ch_001']); // 串行化断言：flush2 未偷跑

    gates.get('ch_001')!(); // flush1 settle
    await waitForCalls(reindexChapter, 2);
    expect(order).toEqual(['start:ch_001', 'end:ch_001', 'start:ch_002']);
    gates.get('ch_002')!();
    await tick(50);
    expect(order).toEqual(['start:ch_001', 'end:ch_001', 'start:ch_002', 'end:ch_002']);
  });

  it('索引失败不阻流程：reindexChapter 拒绝 → flush 吞错（warn），后续章照常', async () => {
    let calls = 0;
    reindexChapter.mockImplementation(async (_pid: string, _dir: string, chapterId: string) => {
      calls += 1;
      if (calls === 1) throw new Error('reindex boom');
      return { outcome: 'written', chunkCount: 1 };
    });
    startChapterChunkWatcher(TMP);
    writeChapter(TMP, 'ch_001');
    await waitForCalls(reindexChapter, 1);
    await tick(100); // 让第一轮 work 的拒绝被链吞掉
    writeChapter(TMP, 'ch_002');
    await waitForCalls(reindexChapter, 2); // 后续章照常（未死链）
    expect(reindexChapter.mock.calls[1]![2]).toBe('ch_002');
  });
});
