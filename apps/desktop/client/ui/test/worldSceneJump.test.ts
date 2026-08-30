/**
 * 跳场景 scene→章映射纯函数测试（dogfood R2 #92，task 08-29-world-state-panel S5；
 * #203 拍板后出口 = openWriting 开该章正文文件 tab）。
 *
 * 映射链（worldSceneJump.ts 头注）：evidenceSceneId → scene_graph 节点 → episodeId ∪
 * presentationSpans[].episodeId 取 episode.index 最小 → novelChapters 中 sortOrder ===
 * index 且**携正文文件**（sections[0].contentFile）→ 目标 = 章元数据本身（面板直喂
 * openWriting）。兜底 presentationOrder.chapter；任一环节断链 / 章未写正文 → null
 * （UI 置灰不崩——置灰口径落在文件可打开性上）。
 *
 * 元素级守卫纪律（spec/ui/state-management）：畸形 creativeFields 注水（节点非对象 /
 * index 非数 / spans 烂条目 / sections 烂条目）不抛、静默降级。
 */
import { describe, expect, it } from 'vitest';
import { makeSceneJumpResolver, resolveSceneChapterTarget } from '../src/features/world-state/worldSceneJump';

/** 轻量章（WorldChapterLike + sections 形态——面板传 NovelChapterMeta，此处结构子集）。 */
function chapter(id: string, sortOrder: number, contentFile?: string) {
  return {
    id,
    sortOrder,
    sections: contentFile === undefined ? [] : [{ id: `${id}-s`, sortOrder: 0, contentFile }],
  };
}

const CHAPTERS = [
  chapter('ch-1', 0, 'chapters/ch-1.md'),
  chapter('ch-13', 12, 'chapters/ch-13.md'),
  { ...chapter('ch-20', 19), sections: [] }, // 章已建但未写正文（无内容文件）
];

describe('resolveSceneChapterTarget（scene→章 三段链）', () => {
  it('单章场：episodeId → episode.index → chapter.sortOrder 命中，目标 = 携正文文件的章元数据', () => {
    const graph = { nodes: [{ id: 's3', episodeId: 'ep1-13', storyTime: 3 }], lines: [], edges: [] };
    const episodes = [{ id: 'ep1-13', index: 12 }];
    expect(
      resolveSceneChapterTarget({ sceneGraph: graph, episodeOutlines: episodes, chapters: CHAPTERS, sceneId: 's3' }),
    ).toEqual({ chapter: CHAPTERS[1] });
  });

  it('跨章场（presentationSpans 多项）取 episode.index 最小的章（首次出现）', () => {
    const graph = {
      nodes: [{ id: 's1', presentationSpans: [{ episodeId: 'ep1-05', pos: 0 }, { episodeId: 'ep1-01', pos: 0 }] }],
      lines: [],
      edges: [],
    };
    const episodes = [
      { id: 'ep1-01', index: 0 },
      { id: 'ep1-05', index: 4 },
    ];
    expect(
      resolveSceneChapterTarget({ sceneGraph: graph, episodeOutlines: episodes, chapters: CHAPTERS, sceneId: 's1' }),
    ).toEqual({ chapter: CHAPTERS[0] });
  });

  it('episode 归属全缺 → 回落 presentationOrder.chapter（阅读起始章 ordinal）', () => {
    const graph = {
      nodes: [{ id: 'sX', presentationOrder: { chapter: 0, pos: 2 }, lineTags: [] }],
      lines: [],
      edges: [],
    };
    expect(
      resolveSceneChapterTarget({ sceneGraph: graph, episodeOutlines: [], chapters: CHAPTERS, sceneId: 'sX' }),
    ).toEqual({ chapter: CHAPTERS[0] });
  });

  it('章未写正文文件（sections 空 / 首节无 contentFile / sections 烂条目）→ null（置灰语义，#203）', () => {
    const graph = { nodes: [{ id: 's20', episodeId: 'ep1-20' }], lines: [], edges: [] };
    const episodes = [{ id: 'ep1-20', index: 19 }];
    // ch-20 章 row 在、但 sections 空（章未建文件）。
    expect(
      resolveSceneChapterTarget({ sceneGraph: graph, episodeOutlines: episodes, chapters: CHAPTERS, sceneId: 's20' }),
    ).toBeNull();
    // sections 首节非对象 / contentFile 非串 / 空串——元素级守卫全降级 null。
    for (const bad of [
      [{ id: 'x', sortOrder: 0 }],
      [{ sortOrder: 0, contentFile: 42 }],
      [{ sortOrder: 0, contentFile: '' }],
    ]) {
      expect(
        resolveSceneChapterTarget({
          sceneGraph: graph,
          episodeOutlines: episodes,
          chapters: [{ id: 'ch-bad', sortOrder: 19, sections: bad as unknown }],
          sceneId: 's20',
        }),
      ).toBeNull();
    }
  });

  it('查不到的环节全部 null：场不在 scene_graph / episode 未排 index / 章未建 / graph 畸形', () => {
    const graph = { nodes: [{ id: 's3', episodeId: 'ep1-13' }], lines: [], edges: [] };
    const episodes = [{ id: 'ep1-13', index: 12 }];

    // 场不存在。
    expect(
      resolveSceneChapterTarget({ sceneGraph: graph, episodeOutlines: episodes, chapters: CHAPTERS, sceneId: 'nope' }),
    ).toBeNull();
    // episode_outlines 缺该 id（章未排）。
    expect(
      resolveSceneChapterTarget({ sceneGraph: graph, episodeOutlines: [], chapters: CHAPTERS, sceneId: 's3' }),
    ).toBeNull();
    // 章列表里没有对应 sortOrder（章未建）。
    expect(
      resolveSceneChapterTarget({
        sceneGraph: graph,
        episodeOutlines: episodes,
        chapters: [chapter('ch-1', 0, 'chapters/ch-1.md')],
        sceneId: 's3',
      }),
    ).toBeNull();
    // scene_graph 整体非形态（unknown seam 畸形注入）。
    expect(
      resolveSceneChapterTarget({ sceneGraph: { nodes: 'x' }, episodeOutlines: episodes, chapters: CHAPTERS, sceneId: 's3' }),
    ).toBeNull();
    expect(
      resolveSceneChapterTarget({ sceneGraph: null, episodeOutlines: episodes, chapters: CHAPTERS, sceneId: 's3' }),
    ).toBeNull();
  });

  it('元素级守卫：节点/集纲/章的畸形条目跳过不抛', () => {
    const graph = {
      nodes: [null, 42, { id: 7 }, { id: 's3', episodeId: 'ep1-13' }, { id: 's4', presentationSpans: [null, { episodeId: 3 }, { episodeId: 'ep1-20' }] }],
      lines: [],
      edges: [],
    };
    const episodes = [null, 'bad', { id: 'ep1-13', index: 'x' }, { id: 'ep1-20', index: 19 }];
    // s3：episodeId 命中但 ep1-13 的 index 非数 → 断链 → null。
    expect(
      resolveSceneChapterTarget({ sceneGraph: graph, episodeOutlines: episodes, chapters: CHAPTERS, sceneId: 's3' }),
    ).toBeNull();
    // s4：spans 烂条目跳过，合法条目 ep1-20 命中——但 ch-20 无正文文件 → 置灰 null。
    expect(
      resolveSceneChapterTarget({ sceneGraph: graph, episodeOutlines: episodes, chapters: CHAPTERS, sceneId: 's4' }),
    ).toBeNull();
    // 同链路换有正文的章列表 → 命中。
    expect(
      resolveSceneChapterTarget({
        sceneGraph: graph,
        episodeOutlines: episodes,
        chapters: [chapter('ch-20b', 19, 'chapters/ch-20b.md')],
        sceneId: 's4',
      }),
    ).toEqual({ chapter: { id: 'ch-20b', sortOrder: 19, sections: [{ id: 'ch-20b-s', sortOrder: 0, contentFile: 'chapters/ch-20b.md' }] } });
  });
});

describe('makeSceneJumpResolver（按 sceneId 记忆化）', () => {
  it('同 sceneId 二次解析走缓存；不同 sceneId 独立结果', () => {
    const graph = { nodes: [{ id: 'a', episodeId: 'ep1-13' }, { id: 'b', episodeId: 'nope' }], lines: [], edges: [] };
    const episodes = [{ id: 'ep1-13', index: 12 }];
    const resolve = makeSceneJumpResolver({ sceneGraph: graph, episodeOutlines: episodes, chapters: CHAPTERS });

    expect(resolve('a')).toEqual({ chapter: CHAPTERS[1] });
    expect(resolve('a')).toEqual({ chapter: CHAPTERS[1] });
    expect(resolve('b')).toBeNull();
    expect(resolve('missing')).toBeNull();
  });
});
