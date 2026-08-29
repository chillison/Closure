import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.7 BMad CR-001：章正文写盘点 → mention 账降档 hook 的接线测试。
//
// degradeMentionLedgerForChapterFile 本体（registry 解析 + canonical 反向映射 + 复合降档）的 db
// round-trip 在 mentionLedgerDegrade.test.ts（Electron 真跑）锚定；此处只锚「落盘点真的调了 hook、
// 参数正确、非章路径零触发」——vi.mock degrade 模块捕获调用（wiring 测试，无 db 依赖）。
// ─────────────────────────────────────────────────────────────────────────────

const { degradeMentionLedgerForChapterFile, notifyUI } = vi.hoisted(() => ({
  degradeMentionLedgerForChapterFile: vi.fn(async () => undefined),
  notifyUI: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: (_: string) => '/tmp', isPackaged: false },
}));
// 部分 mock：降档本体 fake（无 db 依赖）；chapterIdOfChapterFilePath 走真实现（wiring 测试同时锚
// 路径检测——chapters/<stem>.md 命中 / 非章路径零触发是接线正确性的组成面）。
vi.mock('../main/db/mentionLedgerDegrade', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../main/db/mentionLedgerDegrade')>()),
  degradeMentionLedgerForChapterFile,
}));
vi.mock('../main/ipc/toolNotify', () => ({ notifyUI }));

import { chapterWriteHandler } from '../main/ipc/toolHandlers/chapterHandlers';
import { writeFileHandler } from '../main/ipc/toolHandlers/fileHandlers';

const TMP = path.join(process.cwd(), 'test-tmp-chapter-degrade-wiring');

function ctx(projectDir = TMP) {
  return { params: {}, projectDir, sessionId: 's1', abort: new AbortController().signal };
}

describe('章落盘点 → mention 降档 hook 接线（Story 8.7 BMad CR-001）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmBestEffort(TMP);
    mkdirSync(path.join(TMP, 'chapters'), { recursive: true });
  });
  afterEach(() => {
    rmBestEffort(TMP);
  });

  it('chapter_write 落盘（内容有变）→ degrade hook 收 (projectDir, chapterId)', async () => {
    const res = await chapterWriteHandler({
      ...ctx(),
      params: { chapterId: 'ch_001', content: '# 第一章\n\n正文。' },
    });
    expect(res.metadata).toMatchObject({ wordCount: expect.any(Number) });
    expect(degradeMentionLedgerForChapterFile).toHaveBeenCalledTimes(1);
    expect(degradeMentionLedgerForChapterFile).toHaveBeenCalledWith(TMP, 'ch_001');
  });

  it('chapter_write 内容未变（early return 不落盘）→ 不触发降档（无修订无失效）', async () => {
    // 首写（新文件）+ 同内容重写 → 第二次走 already-up-to-date 分支，hook 只在真正写盘后触发。
    await chapterWriteHandler({ ...ctx(), params: { chapterId: 'ch_001', content: '同内容' } });
    expect(degradeMentionLedgerForChapterFile).toHaveBeenCalledTimes(1);
    await chapterWriteHandler({ ...ctx(), params: { chapterId: 'ch_001', content: '同内容' } });
    expect(degradeMentionLedgerForChapterFile).toHaveBeenCalledTimes(1); // 未再触发
  });

  it('write_file 写 chapters/<stem>.md → hook 触发（stem = chapterId）；写 settings/ 非章路径 → 零触发', async () => {
    await writeFileHandler({ ...ctx(), params: { filePath: 'chapters/ch_002.md', content: '正文' } });
    expect(degradeMentionLedgerForChapterFile).toHaveBeenCalledTimes(1);
    expect(degradeMentionLedgerForChapterFile).toHaveBeenCalledWith(TMP, 'ch_002');

    await writeFileHandler({ ...ctx(), params: { filePath: 'settings/magic.md', content: '设定' } });
    await writeFileHandler({ ...ctx(), params: { filePath: 'notes.md', content: '笔记' } });
    expect(degradeMentionLedgerForChapterFile).toHaveBeenCalledTimes(1); // 非章路径零触发
  });

  // CR-T2-007（dogfood T2 patch 批，2026-08-25）：章序渲染剥 ch- 前缀——用户逐字样例是
  // 「第 3 章」，非「第 ch-0003 章」；非 ch-\d+ 形态回退原样内插（不硬套模板猜序号）。
  it('chapter_write 叙述章序剥 ch- 前缀（写入/已是最新两分支）；非 ch-\\d+ 形态回退原样', async () => {
    const res = await chapterWriteHandler({
      ...ctx(),
      params: { chapterId: 'ch-0003', content: '# 第三章\n\n正文。' },
    });
    expect(res.output).toContain('第 3 章已写入并保存');
    expect(res.output).not.toContain('ch-0003'); // 原始 id 不再进用户叙述

    // 同内容重跑 → up-to-date 分支同款渲染。
    const again = await chapterWriteHandler({
      ...ctx(),
      params: { chapterId: 'ch-0003', content: '# 第三章\n\n正文。' },
    });
    expect(again.output).toContain('第 3 章内容已是最新');

    // 非 ch-\d+ 形态（下划线/手写名）→ 原样内插。
    const underscore = await chapterWriteHandler({
      ...ctx(),
      params: { chapterId: 'ch_001', content: '正文' },
    });
    expect(underscore.output).toContain('第 ch_001 章');
    const titled = await chapterWriteHandler({
      ...ctx(),
      params: { chapterId: '序章', content: '楔子' },
    });
    expect(titled.output).toContain('第 序章 章');
  });
});
