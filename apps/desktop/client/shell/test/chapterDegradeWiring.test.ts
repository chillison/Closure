import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// ─────────────────────────────────────────────────────────────────────────────
// #107 check 批补缝：chapter_write body-only 覆写保序——#107 后章文件 frontmatter `order:`
// 是磁盘派生排序键（登记载体），而 body-only 写入方（auto_revise splice / targeted-revision
// 正文）整体覆盖会把已注册章的 order 物理删掉 → 派生重排错位。修法 = 旧文件有 frontmatter 且
// 新内容无 → 旧块回拼（shared-contracts preserveChapterFrontmatter；与 local-bff accept 两写点
// 同一 invariant）。历史 body-only 章零行为变化。
// ─────────────────────────────────────────────────────────────────────────────

describe('chapter_write 覆写保序（#107 check 批）', () => {
  const chapterPath = () => path.join(TMP, 'chapters', '第01章-旧章.md');

  beforeEach(() => {
    vi.clearAllMocks();
    rmBestEffort(TMP);
    mkdirSync(path.join(TMP, 'chapters'), { recursive: true });
  });
  afterEach(() => {
    rmBestEffort(TMP);
  });

  it('旧文件带 frontmatter + body-only 新内容 → order 保留（正文替换，不早退）', async () => {
    writeFileSync(chapterPath(), '---\norder: 0\n---\n\n# 旧章\n\n旧正文。', 'utf8');
    const res = await chapterWriteHandler({
      ...ctx(),
      params: { chapterId: '第01章-旧章', content: '# 新标题\n\n改稿正文。' },
    });
    expect(res.output).toContain('已写入并保存');
    expect(readFileSync(chapterPath(), 'utf8')).toBe('---\norder: 0\n---\n# 新标题\n\n改稿正文。');
  });

  it('全形态内容（自带 frontmatter，#107 自动建章同款）→ 原样写入不双拼', async () => {
    writeFileSync(chapterPath(), '---\norder: 0\n---\n\n# 旧章\n\n旧正文。', 'utf8');
    const fullForm = '---\norder: 0\n---\n\n# 新章\n\n新正文。';
    await chapterWriteHandler({ ...ctx(), params: { chapterId: '第01章-旧章', content: fullForm } });
    expect(readFileSync(chapterPath(), 'utf8')).toBe(fullForm);
  });

  it('body-only 重写后再以「同 body」重写 → 幂等早退（effective 与盘上一致）', async () => {
    writeFileSync(chapterPath(), '---\norder: 0\n---\n\n# 旧章\n\n旧正文。', 'utf8');
    await chapterWriteHandler({
      ...ctx(),
      params: { chapterId: '第01章-旧章', content: '# 新标题\n\n改稿正文。' },
    });
    expect(degradeMentionLedgerForChapterFile).toHaveBeenCalledTimes(1);
    // 同 body-only 内容重写：回拼后与盘上 effective 相同 → up-to-date 早退（不再触发降档）。
    const again = await chapterWriteHandler({
      ...ctx(),
      params: { chapterId: '第01章-旧章', content: '# 新标题\n\n改稿正文。' },
    });
    expect(again.output).toContain('内容已是最新');
    expect(degradeMentionLedgerForChapterFile).toHaveBeenCalledTimes(1);
  });

  it('历史 body-only 章（无 frontmatter）→ 零行为变化（原样写入）', async () => {
    writeFileSync(chapterPath(), '# 旧章\n\n旧正文。', 'utf8');
    await chapterWriteHandler({
      ...ctx(),
      params: { chapterId: '第01章-旧章', content: '# 新标题\n\n新正文。' },
    });
    expect(readFileSync(chapterPath(), 'utf8')).toBe('# 新标题\n\n新正文。');
  });
});
