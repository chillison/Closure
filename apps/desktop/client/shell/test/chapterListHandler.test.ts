import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted stubs（mirror worldStateHandlers.test.ts）：repo + project.yaml 全 mock——
// 真实映射链（resolveChapterIdForEpisode）来自 @orison/shared-contracts（真实现，不 mock），
// 测试喂合成 doc 走真 canonical 映射。
const { getProject, listChapterSummaries, loadProject, warn } = vi.hoisted(() => ({
  getProject: vi.fn(),
  listChapterSummaries: vi.fn(),
  loadProject: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: (_: string) => '/tmp', isPackaged: false },
}));
vi.mock('../main/db/projectRepository', () => ({ getProject }));
vi.mock('../main/db/worldStateRepository', () => ({ listChapterSummaries }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn }) }));
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

import { chapterListHandler, composeChapterCatalogLine } from '../main/ipc/toolHandlers/chapterHandlers';

const TMP = path.join(process.cwd(), 'test-tmp-chapter-list');

function writeChapter(fileName: string, firstLine: string): void {
  writeFileSync(path.join(TMP, 'chapters', fileName), `${firstLine}\n\n正文…`, 'utf-8');
}

function summaryRecord(
  episodeId: string,
  storyTimeStart: number | null,
  storyTimeEnd: number | null,
  synopsis?: string,
) {
  return {
    episodeId,
    episodeIndex: null,
    storyTimeEnd,
    summary: {
      episodeId,
      episodeIndex: null,
      storyTimeStart,
      storyTimeEnd,
      ...(synopsis !== undefined ? { synopsis } : {}),
      characterEndStates: [],
      oracleDormant: [],
      relationshipChanges: [],
      foreshadowChanges: [],
      newEntities: [],
      openPromises: [],
      nextChapterPayoffs: [],
      truncated: false,
    },
    tokenEstimate: 100,
    truncated: false,
    patchRowidHigh: 0,
    updatedAt: '2026-08-19 00:00:00',
  };
}

function ctx(projectDir = TMP) {
  return { params: {}, projectDir, sessionId: 's1', abort: new AbortController().signal };
}

describe('composeChapterCatalogLine（纯函数拼行）', () => {
  it('无增强 → 现状行；窗/梗概逐级叠加；单点窗退单值', () => {
    expect(composeChapterCatalogLine('ch_001.md', '第一章 初雪')).toBe('ch_001.md: 第一章 初雪');
    expect(
      composeChapterCatalogLine('ch_001.md', '第一章 初雪', { storyTimeWindow: '10-20' }),
    ).toBe('ch_001.md: 第一章 初雪（storyTime 10-20）');
    expect(
      composeChapterCatalogLine('ch_001.md', '第一章 初雪', { storyTimeWindow: '10-20', synopsis: '初入宗门' }),
    ).toBe('ch_001.md: 第一章 初雪（storyTime 10-20）— 初入宗门');
    expect(
      composeChapterCatalogLine('ch_001.md', '第一章 初雪', { storyTimeWindow: null, synopsis: '初入宗门' }),
    ).toBe('ch_001.md: 第一章 初雪 — 初入宗门');
    expect(
      composeChapterCatalogLine('ch_001.md', '第一章 初雪', { storyTimeWindow: '21' }),
    ).toBe('ch_001.md: 第一章 初雪（storyTime 21）');
  });
});

describe('chapterListHandler 目录行密度升级（Story 8.7 S6：storyTime 窗 + 梗概）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    mkdirSync(path.join(TMP, 'chapters'), { recursive: true });
    writeChapter('ch_001.md', '# 第一章 初雪');
    writeChapter('ch_002.md', '# 第二章');
    writeChapter('ch_999.md', '# 手写的旧稿');
    getProject.mockReturnValue({ projectId: '00001' });
  });
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  function mockDoc(episodes: unknown, chapters: unknown): void {
    loadProject.mockResolvedValue({ episode_outlines: episodes, novel: { chapters } });
  }

  it('canonical 映射拼行：episode.index ↔ sort_order ↔ content_file → 窗 + 梗概', async () => {
    mockDoc(
      [
        { id: 'ep-1', index: 0 },
        { id: 'ep-2', index: 1 },
      ],
      [
        {
          id: 'ch_001',
          sort_order: 0,
          sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/ch_001.md' }],
        },
        {
          id: 'ch_002',
          sort_order: 1,
          sections: [{ id: 's2', sort_order: 0, content_file: 'chapters/ch_002.md' }],
        },
      ],
    );
    listChapterSummaries.mockReturnValue([
      summaryRecord('ep-1', 10, 20, '初入宗门，夜雪封山'),
      summaryRecord('ep-2', 21, null), // 窗终点缺 → 单值；无梗概 → 不编造
    ]);

    const res = await chapterListHandler(ctx());

    const lines = res.output.split('\n');
    expect(lines[0]).toBe('ch_001.md: 第一章 初雪（storyTime 10-20）— 初入宗门，夜雪封山');
    expect(lines[1]).toBe('ch_002.md: 第二章（storyTime 21）');
    // 未注册章（无 episode 映射）→ 现状行。
    expect(lines[2]).toBe('ch_999.md: 手写的旧稿');
    expect(res.metadata).toMatchObject({ count: 3 });
  });

  it('graceful 阶梯：未注册 db / 无摘要 / doc 缺字段 / loadProject null / 抛错 → 全退现状行', async () => {
    writeChapter('a.md', '# 甲');
    const plain = ['a.md: 甲', 'ch_001.md: 第一章 初雪', 'ch_002.md: 第二章', 'ch_999.md: 手写的旧稿'];

    // 1) 未注册 db。
    getProject.mockReturnValue(undefined);
    expect((await chapterListHandler(ctx())).output.split('\n')).toEqual(plain);
    expect(loadProject).not.toHaveBeenCalled();

    // 2) 已注册但章摘要空（省 yaml 读）。
    getProject.mockReturnValue({ projectId: '00001' });
    listChapterSummaries.mockReturnValue([]);
    expect((await chapterListHandler(ctx())).output.split('\n')).toEqual(plain);
    expect(loadProject).not.toHaveBeenCalled();

    // 3) 有摘要但 doc 缺 episode_outlines / novel.chapters。
    listChapterSummaries.mockReturnValue([summaryRecord('ep-1', 10, 20, '梗概')]);
    mockDoc(undefined, undefined);
    expect((await chapterListHandler(ctx())).output.split('\n')).toEqual(plain);
    mockDoc([{ id: 'ep-1', index: 0 }], undefined);
    expect((await chapterListHandler(ctx())).output.split('\n')).toEqual(plain);

    // 4) loadProject null（项目 yaml 不可读）。
    loadProject.mockResolvedValue(null);
    expect((await chapterListHandler(ctx())).output.split('\n')).toEqual(plain);

    // 5) loadProject 抛错 → warn + 现状行（目录永不因增强失败而断）。
    loadProject.mockRejectedValue(new Error('yaml boom'));
    const res = await chapterListHandler(ctx());
    expect(res.output.split('\n')).toEqual(plain);
    expect(warn).toHaveBeenCalled();
  });

  it('映射歧义（两章共 sort_order）→ 该 episode 无增强（CR-4.1-06 防御照继承，宁缺毋错）', async () => {
    mockDoc(
      [{ id: 'ep-1', index: 0 }],
      [
        {
          id: 'ch_001',
          sort_order: 0,
          sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/ch_001.md' }],
        },
        {
          id: 'ch_002',
          sort_order: 0, // 歧义：两章同 sort_order
          sections: [{ id: 's2', sort_order: 0, content_file: 'chapters/ch_002.md' }],
        },
      ],
    );
    listChapterSummaries.mockReturnValue([summaryRecord('ep-1', 10, 20, '梗概')]);

    const res = await chapterListHandler(ctx());

    expect(res.output).not.toContain('storyTime');
    expect(res.output.split('\n')[0]).toBe('ch_001.md: 第一章 初雪');
  });

  it('chapters 目录不存在 → 现状 miss 文案', async () => {
    rmSync(path.join(TMP, 'chapters'), { recursive: true, force: true });
    const res = await chapterListHandler(ctx());
    expect(res.output).toBe('尚未创建章节目录（还没有任何章节）。');
    expect(res.metadata).toMatchObject({ count: 0 });
  });
});
