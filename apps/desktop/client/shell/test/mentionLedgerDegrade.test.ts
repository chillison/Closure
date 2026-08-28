import path from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChapterStateSummary } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror mentionLedgerRepository.test.ts).
const TEST_HOME = path.join(process.cwd(), 'test-tmp-mention-degrade');

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
}));

// getProject / loadProject mock（mirror chapterListHandler.test.ts）：mentionLedgerDegrade 只消费这两个
// seam；db 侧（degradeEpisodeMentions 复合 + 播种）走真实现（Electron 真跑锚定 db round-trip）。
const { getProject, loadProject } = vi.hoisted(() => ({
  getProject: vi.fn(),
  loadProject: vi.fn(),
}));
vi.mock('../main/db/projectRepository', () => ({ getProject }));
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

import { closeDb, getDb } from '../main/db/index';
import {
  chapterIdOfChapterFilePath,
  degradeMentionLedgerForChapterFile,
} from '../main/db/mentionLedgerDegrade';
import { queryMentionLedger, upsertEpisodeMentions, type MentionRowInsert } from '../main/db/mentionLedgerRepository';
import { upsertChapterSummary } from '../main/db/worldStateRepository';

// better-sqlite3 ABI gate (mirror mentionLedgerRepository.test.ts): skip under
// plain-Node vitest. Electron-as-Node real-run command (testing-discipline Pattern):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
//     node_modules/vitest/vitest.mjs run test/mentionLedgerDegrade.test.ts
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function clean() {
  closeDb();
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
}

const PID = '00082';
const PROJECT_DIR = path.join(TEST_HOME, 'my-project');

/** canonical 链最小 doc：ep-1(index 0) ↔ ch_001(sort_order 0, content_file chapters/ch_001.md)。 */
const DOC = {
  episode_outlines: [{ id: 'ep-1', index: 0 }],
  novel: {
    chapters: [
      { id: 'ch_001', sort_order: 0, sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/ch_001.md' }] },
    ],
  },
};

function mkSummary(episodeId: string, synopsis?: string): ChapterStateSummary {
  return {
    episodeId,
    episodeIndex: 1,
    storyTimeStart: null,
    storyTimeEnd: null,
    characterEndStates: [],
    oracleDormant: [],
    relationshipChanges: [],
    foreshadowChanges: [],
    newEntities: [],
    openPromises: [],
    nextChapterPayoffs: [],
    truncated: false,
    ...(synopsis !== undefined ? { synopsis } : {}),
  } as ChapterStateSummary;
}

function ins(entryId: string): MentionRowInsert {
  return {
    entryId,
    presence: 'present',
    declared: 1,
    presenceShot: 0,
    coarseHit: 1,
    planLinked: 0,
    coarseCount: 1,
    stateChanged: 0,
    source: 'full',
  };
}

function readSummary(episodeId: string): { synopsis?: string; degradedNote?: string } | undefined {
  const row = getDb()
    .prepare('SELECT summary FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?')
    .get(PID, episodeId) as { summary: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.summary) as { synopsis?: string; degradedNote?: string });
}

describe.skipIf(!sqliteUsable)('mentionLedgerDegrade（Story 8.7 BMad CR-001 方案 A）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  beforeEach(() => {
    vi.clearAllMocks();
    getProject.mockReturnValue({ projectId: PID });
    loadProject.mockReturnValue(DOC);
    // 起点账：ep-1 full 行 + 带梗概摘要（降档断言后每测试重播种）。
    getDb().prepare('DELETE FROM closure_mention WHERE project_id = ?').run(PID);
    getDb().prepare('DELETE FROM closure_mention_signals WHERE project_id = ?').run(PID);
    getDb().prepare('DELETE FROM closure_chapter_summary WHERE project_id = ?').run(PID);
    upsertChapterSummary(PID, {
      episodeId: 'ep-1',
      episodeIndex: 1,
      storyTimeEnd: null,
      summary: mkSummary('ep-1', '两人遇袭。'),
      tokenEstimate: 100,
      truncated: false,
      patchRowidHigh: 0,
    });
    upsertEpisodeMentions(PID, 'ep-1', [ins('card-a')], [
      { kind: 'hard_miss', episodeId: 'ep-1', entryId: 'card-a' },
    ]);
  });

  it('注册项目 + canonical 反向映射命中 → 降档（行 conservative + synopsis 标 stale + 删信号行）', async () => {
    await degradeMentionLedgerForChapterFile(PROJECT_DIR, 'ch_001');

    expect(queryMentionLedger(PID, { episodeId: 'ep-1' })[0]).toMatchObject({
      declared: 0,
      source: 'conservative',
    });
    const summary = readSummary('ep-1')!;
    expect(summary.synopsis).toBe('两人遇袭。'); // 梗概保留（标 stale 非删除）
    expect(summary.degradedNote).toContain('正文已修订');
    const signals = getDb()
      .prepare('SELECT COUNT(*) AS n FROM closure_mention_signals WHERE project_id = ?')
      .get(PID) as { n: number };
    expect(signals.n).toBe(0); // 信号行删除（申报对照系失效）
  });

  it('项目未注册 → 静默 no-op（不降档不抛）', async () => {
    getProject.mockReturnValue(undefined);
    await expect(degradeMentionLedgerForChapterFile(PROJECT_DIR, 'ch_001')).resolves.toBeUndefined();
    expect(loadProject).not.toHaveBeenCalled(); // 未注册短路（不读 yaml）
    expect(queryMentionLedger(PID, { episodeId: 'ep-1' })[0]).toMatchObject({ source: 'full' });
  });

  it('chapterId 无映射（chapters/ch_999 不在 novel.chapters）→ no-op 不猜', async () => {
    await degradeMentionLedgerForChapterFile(PROJECT_DIR, 'ch_999');
    expect(queryMentionLedger(PID, { episodeId: 'ep-1' })[0]).toMatchObject({ source: 'full' });
    expect(readSummary('ep-1')!.degradedNote).toBeUndefined();
  });

  it('loadProject 抛错 → best-effort 吞掉（正文落盘不受阻，账保持待重收）', async () => {
    loadProject.mockImplementation(() => {
      throw new Error('yaml boom');
    });
    await expect(degradeMentionLedgerForChapterFile(PROJECT_DIR, 'ch_001')).resolves.toBeUndefined();
    expect(queryMentionLedger(PID, { episodeId: 'ep-1' })[0]).toMatchObject({ source: 'full' });
  });

  it('幂等：二次降档 no-op（synopsis stale 注不重复追记）', async () => {
    await degradeMentionLedgerForChapterFile(PROJECT_DIR, 'ch_001');
    await degradeMentionLedgerForChapterFile(PROJECT_DIR, 'ch_001');
    expect(readSummary('ep-1')!.degradedNote?.split('正文已修订').length).toBe(2); // 仅一次
  });
});

// ── chapterIdOfChapterFilePath（纯函数：写盘路径 → chapterId 检测，plain vitest 可测）──

describe('chapterIdOfChapterFilePath（chapters/ 目录路径检测）', () => {
  const root = path.join('/', 'p', 'proj');

  it('chapters/<stem>.md → stem（正反斜杠归一）；带 .md 后缀剥离', () => {
    expect(chapterIdOfChapterFilePath(path.join(root, 'chapters', 'ch_001.md'), root)).toBe('ch_001');
    expect(chapterIdOfChapterFilePath(`${root}\\chapters\\ch_002.md`, root)).toBe('ch_002');
  });

  it('非章路径 → undefined（settings/手稿根/子目录/非 md/其他项目根）', () => {
    expect(chapterIdOfChapterFilePath(path.join(root, 'settings', 'magic.md'), root)).toBeUndefined();
    expect(chapterIdOfChapterFilePath(path.join(root, 'chapters', 'draft', 'a.md'), root)).toBeUndefined(); // 子目录非工具层形态
    expect(chapterIdOfChapterFilePath(path.join(root, 'chapters', 'notes.txt'), root)).toBeUndefined();
    expect(chapterIdOfChapterFilePath(path.join('/other', 'chapters', 'a.md'), root)).toBeUndefined();
    expect(chapterIdOfChapterFilePath(path.join(root, 'chapters'), root)).toBeUndefined();
  });
});
