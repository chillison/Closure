import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveChaptersFromDisk } from '../src/shared/store/chapterDiskDerivation';
import type { FileTreeEntry } from '@orison/shared-contracts';

/**
 * dogfood R2 #107 / R1.1：磁盘派生排序提取至 shared-contracts `chapter-ordering.ts`
 * 后的行为回归（提取正确性的 ui 侧证明——与 shared-contracts chapter-ordering.test.ts
 * 共同构成等价性对拍：本套走真实 deriveChaptersFromDisk 全链（frontmatter 解析 →
 * 共享排序 → sortOrder 位置赋值 → 元数据合并），那套锁纯函数规则本身）。
 *
 * 锁定契约（提取前 sortDiskChapters 语义）：
 * - sort_order = 排序后位置非 order 原值（order 0,2,5 → 位置 0,1,2）；
 * - hasExplicitOrder 全局开关：任一文件带 order → 全体按 order、缺序垫底；
 * - 全无 order → 文件名自然序（numeric collation）；
 * - id = 文件名去 .md；title = 正文首个 `# ` 标题（fallback id）。
 */
function makeTree(files: Array<{ name: string; content: string }>): FileTreeEntry[] {
  return [
    {
      name: 'chapters',
      path: '/chapters',
      isDir: true,
      children: files.map((f) => ({
        name: f.name,
        path: `/chapters/${f.name}`,
        isDir: false,
      })),
    },
  ];
}

function mockApi(files: Array<{ name: string; content: string }>): void {
  (window as any).orisonDesktop = {
    readDirectory: vi.fn(async () => makeTree(files)),
    readFile: vi.fn(async (fullPath: string) =>
      files.find((f) => fullPath.endsWith(`/${f.name}`))?.content ?? null,
    ),
  };
}

function ids(chapters: Awaited<ReturnType<typeof deriveChaptersFromDisk>>): string[] {
  return chapters.map((ch) => ch.id);
}

function sortOrders(chapters: Awaited<ReturnType<typeof deriveChaptersFromDisk>>): number[] {
  return chapters.map((ch) => ch.sortOrder);
}

afterEach(() => {
  delete (window as any).orisonDesktop;
  vi.restoreAllMocks();
});

describe('deriveChaptersFromDisk — 排序契约（chapter-ordering 单源提取后回归）', () => {
  it('顺序密集 order 0,1,2 → 位置===order', async () => {
    mockApi([
      { name: '第02章-夜行.md', content: '---\norder: 1\n---\n\n# 夜行\n\n正文。' },
      { name: '第01章-挖出来的是什么.md', content: '---\norder: 0\n---\n\n# 挖出来的是什么\n\n正文。' },
      { name: '第03章-回声.md', content: '---\norder: 2\n---\n\n# 回声\n\n正文。' },
    ]);
    const chapters = await deriveChaptersFromDisk('/proj');
    expect(ids(chapters)).toEqual(['第01章-挖出来的是什么', '第02章-夜行', '第03章-回声']);
    expect(sortOrders(chapters)).toEqual([0, 1, 2]);
    expect(chapters[0].title).toBe('挖出来的是什么'); // 正文首个 # 标题
  });

  it('order 有洞 0,2,5 → 位置压缩为 0,1,2（sort_order 位置语义——R1.1d 守卫的根）', async () => {
    mockApi([
      { name: 'h5.md', content: '---\norder: 5\n---\n\n# 五\n' },
      { name: 'h0.md', content: '---\norder: 0\n---\n\n# 零\n' },
      { name: 'h2.md', content: '---\norder: 2\n---\n\n# 二\n' },
    ]);
    const chapters = await deriveChaptersFromDisk('/proj');
    expect(ids(chapters)).toEqual(['h0', 'h2', 'h5']);
    expect(sortOrders(chapters)).toEqual([0, 1, 2]);
  });

  it('混排：带 order 章在前、裸文件（无 frontmatter）垫底按文件名序', async () => {
    mockApi([
      { name: '裸章-b.md', content: '# 乙\n\n无 frontmatter 正文。' },
      { name: '第01章.md', content: '---\norder: 0\n---\n\n# 一\n' },
      { name: '裸章-a.md', content: '# 甲\n\n无 frontmatter 正文。' },
    ]);
    const chapters = await deriveChaptersFromDisk('/proj');
    expect(ids(chapters)).toEqual(['第01章', '裸章-a', '裸章-b']);
    expect(sortOrders(chapters)).toEqual([0, 1, 2]);
    // 裸文件 title fallback id（正文 # 标题仍优先——此处两裸章带 # 标题故取标题）。
    expect(chapters[1].title).toBe('甲');
  });

  it('全裸集 → 文件名自然序（numeric collation：第2章 < 第9章 < 第10章）', async () => {
    mockApi([
      { name: '第10章.md', content: '第10章正文（无标题）。' },
      { name: '第2章.md', content: '第2章正文（无标题）。' },
      { name: '第9章.md', content: '第9章正文（无标题）。' },
    ]);
    const chapters = await deriveChaptersFromDisk('/proj');
    expect(ids(chapters)).toEqual(['第2章', '第9章', '第10章']);
    expect(sortOrders(chapters)).toEqual([0, 1, 2]);
    expect(chapters[0].title).toBe('第2章'); // 无 # 标题 → fallback id
  });

  it('同 order 平分 → 文件名决胜', async () => {
    mockApi([
      { name: '第2章-c.md', content: '---\norder: 2\n---\n\n# 丙\n' },
      { name: '第2章-a.md', content: '---\norder: 2\n---\n\n# 甲a\n' },
      { name: '第2章-b.md', content: '---\norder: 2\n---\n\n# 乙b\n' },
    ]);
    const chapters = await deriveChaptersFromDisk('/proj');
    expect(ids(chapters)).toEqual(['第2章-a', '第2章-b', '第2章-c']);
    expect(sortOrders(chapters)).toEqual([0, 1, 2]);
  });

  it('已有章元数据按 id 合并保留（title/status/summary 不被盘派生覆盖）', async () => {
    mockApi([
      { name: '第1章.md', content: '---\norder: 0\n---\n\n# 盘上标题\n' },
      { name: '第2章.md', content: '---\norder: 1\n---\n\n# 新章\n' },
    ]);
    const existing = [
      {
        id: '第1章',
        title: '用户标题',
        sortOrder: 0,
        status: 'final' as const,
        summary: '已有摘要',
        summarySource: 'user' as const,
        sections: [{ id: '第1章_main', sortOrder: 0, contentFile: 'chapters/第1章.md', wordCount: 99 }],
      },
    ];
    const chapters = await deriveChaptersFromDisk('/proj', existing);
    expect(chapters[0]).toMatchObject({
      id: '第1章',
      title: '用户标题',
      status: 'final',
      summary: '已有摘要',
      sections: [{ contentFile: 'chapters/第1章.md' }],
    });
    expect(chapters[1]).toMatchObject({ id: '第2章', title: '新章', status: 'draft' });
  });

  it('chapters 目录不存在 → []（空项目态，#107 首章场景的起点）', async () => {
    (window as any).orisonDesktop = {
      readDirectory: vi.fn(async () => []),
      readFile: vi.fn(async () => null),
    };
    expect(await deriveChaptersFromDisk('/proj', [
      { id: '旧章', title: 'T', sortOrder: 0, status: 'draft', sections: [] },
    ] as any)).toEqual([]);
  });
});
