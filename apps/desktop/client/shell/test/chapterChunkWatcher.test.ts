import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 S3：chapters/ 目录 watcher 单测。索引器 mock（reindexChapter /
// rebuildChapterChunks 捕获调用——本体在 chapterChunkIndexer.test.ts 真跑锚定）；
// watcher 事件源经 watchFactory 注入缝合成（setWatchFactory fake，测试 emit 合成
// 事件驱动）——debounce + 过滤 + 生命周期 + inflight 串行化走真实实现（真定时器
// ——waitFor 等 debounce 窗）。
// ─────────────────────────────────────────────────────────────────────────────

// TMP 每测唯一（mkdtemp，残留 tmpdir 交系统清理）——沿用既有形态。
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
import { setWatchFactory, type WatchFn } from '../main/fs/watchFactory';

// ── fake watch 源（注入缝）：捕获 watcher 注册的回调，测试合成事件驱动 ──

interface FakeHandle {
  cb: (event: string, filename: string | null) => void;
  closed: boolean;
}
const fakeWatches: { dir: string; handle: FakeHandle }[] = [];

const fakeWatchFn: WatchFn = (dir, cb) => {
  const handle: FakeHandle = { cb, closed: false };
  fakeWatches.push({ dir, handle });
  return {
    close() {
      handle.closed = true;
    },
    on() {
      // fake 源不产 error 事件——error listener 仅保 DirWatcher 结构契约。
    },
  };
};

/**
 * 合成一次 libuv 投递：调该目录最新未 close 句柄的回调。closed 句柄静默丢弃
 * （mirror 生产 close 语义——stop / 项目切换后旧句柄不再有事件）。目录从未注册
 * 任何句柄 → throw（CR-010：防负向断言空洞——目录拼错/时序错时 emit 静默空过，
 * 「未触发」断言就成了假绿）。
 */
function emitWatchEvent(dir: string, filename: string | null): void {
  let sawClosedHandle = false;
  for (let i = fakeWatches.length - 1; i >= 0; i -= 1) {
    const w = fakeWatches[i]!;
    if (path.resolve(w.dir) !== path.resolve(dir)) continue;
    if (w.handle.closed) {
      sawClosedHandle = true;
      continue;
    }
    w.handle.cb('change', filename);
    return;
  }
  if (!sawClosedHandle) {
    throw new Error(
      `emitWatchEvent: 目录从未注册活句柄（${dir}）——先 startChapterChunkWatcher 再 emit；目录拼错或时序错，负向断言疑似空洞`,
    );
  }
}

/** 等真实事件循环跑几拍（debounce 是真定时器，非 faked timer）。 */
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

// libuv windows CI 断言问题已由 watchFactory 注入缝根除（08-29 R3）——事件合成，无真句柄。
describe('chapterChunkWatcher（Story 8.3 S3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认实现每测重挂（clearAllMocks 不清 implementation，防上测 mockImplementation 泄漏）。
    reindexChapter.mockImplementation(async () => ({ outcome: 'written', chunkCount: 1 }));
    rebuildChapterChunks.mockImplementation(async () => ({ reindexed: 1, orphaned: 0 }));
    TMP = tmpBox.dir = mkdtempSync(path.join(os.tmpdir(), 'chapter-chunk-watcher-'));
    allowPath(TMP); // assertSafePath 授权（mirror 生产 project:watch 前的 allowPath）
    stopChapterChunkWatcher();
    fakeWatches.length = 0;
    setWatchFactory(fakeWatchFn);
  });
  afterEach(() => {
    // 合成事件源无在途竞态（R3 前真 fs.watch 的 libuv close 竞态排空 tick 已无必要）。
    stopChapterChunkWatcher();
    setWatchFactory(null);
    fakeWatches.length = 0;
  });

  it('章文件事件 → debounce 后 reindexChapter(projectId, projectDir, chapterId)；rebuild 不触发', async () => {
    startChapterChunkWatcher(TMP);
    emitWatchEvent(TMP, 'chapters/ch_001.md');
    await waitForCalls(reindexChapter, 1);
    expect(reindexChapter).toHaveBeenCalledWith('00091', TMP, 'ch_001');
    expect(rebuildChapterChunks).not.toHaveBeenCalled();
  });

  it('debounce 合并：两章连发 → 同一 debounce 窗内零散触发、窗后一次 flush 双章', async () => {
    startChapterChunkWatcher(TMP);
    emitWatchEvent(TMP, 'chapters/ch_001.md');
    emitWatchEvent(TMP, 'chapters/ch_002.md');
    await tick(250); // debounce 窗（500ms）内：尚未 flush
    expect(reindexChapter).not.toHaveBeenCalled();
    await waitForCalls(reindexChapter, 2);
    const ids = reindexChapter.mock.calls.map((c) => c[2]);
    expect(ids.sort()).toEqual(['ch_001', 'ch_002']);
  });

  it('filename 不可用（null，rename 类平台省略）→ 保守全量 rebuild（宁多扫不漏索引）', async () => {
    startChapterChunkWatcher(TMP);
    emitWatchEvent(TMP, null);
    await waitForCalls(rebuildChapterChunks, 1);
    expect(rebuildChapterChunks).toHaveBeenCalledWith('00091', TMP);
    expect(reindexChapter).not.toHaveBeenCalled();
  });

  it('非章路径零触发：settings/*.md 与根级文件不reindex', async () => {
    startChapterChunkWatcher(TMP);
    emitWatchEvent(TMP, 'settings/magic.md');
    emitWatchEvent(TMP, 'notes.md');
    await tick(900); // 过 debounce 窗 + 余量
    expect(reindexChapter).not.toHaveBeenCalled();
    expect(rebuildChapterChunks).not.toHaveBeenCalled();
  });

  it('子目录章形态（chapters/draft/x.md）不触发', async () => {
    startChapterChunkWatcher(TMP);
    emitWatchEvent(TMP, 'chapters/draft/x.md');
    await tick(900);
    expect(reindexChapter).not.toHaveBeenCalled();
  });

  it('stop 后不再触发（生命周期）', async () => {
    startChapterChunkWatcher(TMP);
    stopChapterChunkWatcher();
    emitWatchEvent(TMP, 'chapters/ch_001.md');
    await tick(900);
    expect(reindexChapter).not.toHaveBeenCalled();
  });

  it('项目切换 re-point：旧项目事件不再触发', async () => {
    const projectA = path.join(TMP, 'project-a');
    const projectB = path.join(TMP, 'project-b');
    allowPath(projectA);
    allowPath(projectB);
    startChapterChunkWatcher(projectA);
    startChapterChunkWatcher(projectB); // 切换：A 停（句柄 closed，事件不再投递）、B 起
    emitWatchEvent(projectA, 'chapters/ch_001.md');
    emitWatchEvent(projectB, 'chapters/ch_002.md');
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
    emitWatchEvent(TMP, 'chapters/ch_001.md');
    await waitForCalls(reindexChapter, 1); // flush1 开跑（挂起）
    emitWatchEvent(TMP, 'chapters/ch_002.md');
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
    emitWatchEvent(TMP, 'chapters/ch_001.md');
    await waitForCalls(reindexChapter, 1);
    await tick(100); // 让第一轮 work 的拒绝被链吞掉
    emitWatchEvent(TMP, 'chapters/ch_002.md');
    await waitForCalls(reindexChapter, 2); // 后续章照常（未死链）
    expect(reindexChapter.mock.calls[1]![2]).toBe('ch_002');
  });
});
