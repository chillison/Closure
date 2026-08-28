import { describe, expect, it } from 'vitest';
import {
  acceptChapterCandidateCore,
  buildChapterAccept,
  resolveChapterIdForEpisode,
  resolveEpisodeIdForChapter,
  type ChapterAcceptArtifact,
  type ChapterAcceptResult,
  type ChapterIntegrationProject,
  type ChapterAcceptSnapshot,
} from '../src/contracts/chapter-integration';
import type { StoryDecision } from '../src/contracts/story-decision';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.1 Step 4：chapter-integration 共享纯函数测（acceptChapterCandidateCore +
// resolveChapterIdForEpisode + buildChapterAccept）。纯函数无 fs / Date / db → plain vitest。
// ─────────────────────────────────────────────────────────────────────────────

const NOW_ISO = '2026-08-01T00:00:00.000Z';

function makeProject(overrides: Partial<ChapterIntegrationProject> = {}): ChapterIntegrationProject {
  return {
    novel: {
      chapters: [
        {
          id: 'ch_001',
          title: '旧标题',
          sort_order: 0,
          sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }],
          status: 'generating',
          last_run_id: 'run_pre',
        },
        {
          id: 'ch_002',
          title: '第2章',
          sort_order: 1,
          sections: [{ id: 'ch_002_s1', sort_order: 0, content_file: 'chapters/ch_002.md' }],
        },
      ],
      story_decisions: [],
    },
    meta: { version: 5, updated_at: '2026-07-31T00:00:00.000Z' },
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// acceptChapterCandidateCore
// ════════════════════════════════════════════════════════════════════════════

describe('acceptChapterCandidateCore — 项目 mutation 纯逻辑（不写盘）', () => {
  it('更新章节元数据 + 返 mdPath/mdContent/chapterMeta（mirror acceptChapterCandidate 行为）', () => {
    const project = makeProject();
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'run_accept1',
      candidate: { title: '第1章 新标题', content: '夜幕降临。', summary: '新摘要。', wordCount: 42 },
      nowISO: NOW_ISO,
    });

    expect(result).not.toBeNull();
    expect(result!.mdPath).toBe('chapters/ch_001.md');
    expect(result!.mdContent).toBe('夜幕降临。');
    expect(result!.chapterMeta).toMatchObject({
      title: '第1章 新标题',
      summary: '新摘要。',
      summary_source: 'ai',
      word_count: 42,
      status: 'draft',
      last_run_id: 'run_accept1',
      generated_at: NOW_ISO,
    });
    // 章节 meta 在 updatedProject 中已 mutate
    const ch = result!.updatedProject.novel!.chapters!.find((c) => c.id === 'ch_001')!;
    expect(ch.title).toBe('第1章 新标题');
    expect(ch.status).toBe('draft');
    expect(ch.sections![0].word_count).toBe(42);
  });

  it('不动 meta.version / meta.updated_at（调用方 batch 级 bump，避 double-count）', () => {
    const project = makeProject();
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
    })!;
    expect(result.updatedProject.meta.version).toBe(5); // 未递增（调用方 bump）
    expect(result.updatedProject.meta.updated_at).toBe('2026-07-31T00:00:00.000Z'); // 未改
  });

  it('不改入参引用（structuredClone）', () => {
    const project = makeProject();
    const original = JSON.parse(JSON.stringify(project));
    acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: '新内容' },
      nowISO: NOW_ISO,
    });
    expect(JSON.parse(JSON.stringify(project))).toEqual(original); // 入参未变
  });

  it('story_decisions 追加到 novel.story_decisions（create array if absent）', () => {
    const project = makeProject({ novel: { chapters: makeProject().novel!.chapters! } });
    delete (project.novel as { story_decisions?: StoryDecision[] }).story_decisions;
    const decision: StoryDecision = {
      id: 'd1',
      summary: '偏离',
      reason: '正文升级',
      alternatives: [],
      risk: '须校正',
      status: 'decided',
      source: 'accept_as_truth',
      createdAt: NOW_ISO,
    };
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
      storyDecisions: [decision],
    })!;
    expect(result.updatedProject.novel!.story_decisions).toEqual([decision]);
  });

  it('章节不存在 → 返 null（调用方决定 throw 或 skip）', () => {
    const project = makeProject();
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_nonexistent',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
    });
    expect(result).toBeNull();
  });

  it('novel.chapters 缺 → 返 null', () => {
    const result = acceptChapterCandidateCore({
      project: { meta: { version: 0, updated_at: NOW_ISO } },
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
    });
    expect(result).toBeNull();
  });

  it('章节无 sections → 返 null', () => {
    const project = makeProject();
    (project.novel!.chapters![0] as { sections?: unknown }).sections = undefined;
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
    });
    expect(result).toBeNull();
  });

  it('最小 candidate（仅 content）→ 正常 mutation', () => {
    const result = acceptChapterCandidateCore({
      project: makeProject(),
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: '最小内容。' },
      nowISO: NOW_ISO,
    })!;
    expect(result.mdContent).toBe('最小内容。');
    expect(result.chapterMeta.status).toBe('draft');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resolveChapterIdForEpisode
// ════════════════════════════════════════════════════════════════════════════

describe('resolveChapterIdForEpisode — episodeId → chapterId 映射', () => {
  const episodes = [
    { id: 'ep_1', index: 0 },
    { id: 'ep_2', index: 1 },
    { id: 'ep_3', index: 2 },
  ];
  const chapters = [
    { id: 'ch_001', sort_order: 0 },
    { id: 'ch_002', sort_order: 1 },
  ];

  it('episodeId → episode.index → chapters[sort_order===index]（命中）', () => {
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_1')).toBe('ch_001');
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_2')).toBe('ch_002');
  });

  it('directChapterId 优先（绕过映射推断）', () => {
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_1', 'ch_002')).toBe('ch_002');
    // 即使 episodeId 不存在，directChapterId 仍优先返回
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_nonexistent', 'ch_custom')).toBe('ch_custom');
  });

  it('episode 不存在 → undefined', () => {
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_nonexistent')).toBeUndefined();
  });

  it('episode.index 无对应 sort_order 章（章未注册） → undefined', () => {
    // ep_3.index=2，但 chapters 只到 sort_order=1
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_3')).toBeUndefined();
  });

  it('CR-4.1-06：多章 sort_order 重复（映射歧义）→ undefined（accept 阻断，非取首个静默写错章）', () => {
    // chapterSchema.sort_order 无唯一约束；两章共 sort_order=0 时旧 `find` 取首个会静默写错位置。
    const chaptersWithDupSort = [
      { id: 'ch_001', sort_order: 0 },
      { id: 'ch_001b', sort_order: 0 },
    ];
    expect(resolveChapterIdForEpisode(episodes, chaptersWithDupSort, 'ep_1')).toBeUndefined();
  });

  it('episodeOutlines 缺 → undefined（无 directChapterId 时）', () => {
    expect(resolveChapterIdForEpisode(undefined, chapters, 'ep_1')).toBeUndefined();
  });

  it('novelChapters 缺 → undefined（无 directChapterId 时）', () => {
    expect(resolveChapterIdForEpisode(episodes, undefined, 'ep_1')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resolveEpisodeIdForChapter（正向链取反，Story 8.7 BMad CR-001 章落盘降档取反链）
// ════════════════════════════════════════════════════════════════════════════

describe('resolveEpisodeIdForChapter — chapterId → episodeId 映射（反向）', () => {
  const episodes = [
    { id: 'ep_1', index: 0 },
    { id: 'ep_2', index: 1 },
    { id: 'ep_3', index: 2 },
  ];
  const chapters = [
    { id: 'ch_001', sort_order: 0 },
    { id: 'ch_002', sort_order: 1 },
  ];

  it('chapterId → sort_order → episode[index]（命中，与正向互逆）', () => {
    expect(resolveEpisodeIdForChapter(episodes, chapters, 'ch_001')).toBe('ep_1');
    expect(resolveEpisodeIdForChapter(episodes, chapters, 'ch_002')).toBe('ep_2');
  });

  it('chapter 不存在 / sort_order 缺 / 无对应 episode → undefined', () => {
    expect(resolveEpisodeIdForChapter(episodes, chapters, 'ch_nonexistent')).toBeUndefined();
    expect(
      resolveEpisodeIdForChapter(episodes, [{ id: 'ch_nosort' }], 'ch_nosort'),
    ).toBeUndefined();
    // ch_002.sort_order=1 → ep_2 命中；构造有章无 episode 的形态：index 超出 episodes 集。
    expect(
      resolveEpisodeIdForChapter(episodes, [{ id: 'ch_009', sort_order: 9 }], 'ch_009'),
    ).toBeUndefined();
  });

  it('多 episode 同 index（反向歧义）→ undefined（mirror 正向 CR-4.1-06 防御）', () => {
    const dupEpisodes = [
      { id: 'ep_1a', index: 0 },
      { id: 'ep_1b', index: 0 },
    ];
    expect(resolveEpisodeIdForChapter(dupEpisodes, chapters, 'ch_001')).toBeUndefined();
  });

  it('双章共 sort_order → 正向本就 undefined，反向回代校验同判 undefined（正反一致）', () => {
    const dupChapters = [
      { id: 'ch_001', sort_order: 0 },
      { id: 'ch_001b', sort_order: 0 },
    ];
    // 正向 anchor：ep_1 → 两章共 sort_order → undefined。
    expect(resolveChapterIdForEpisode(episodes, dupChapters, 'ep_1')).toBeUndefined();
    // 反向不得单侧放行（镜像错位防线——回代校验拦下）。
    expect(resolveEpisodeIdForChapter(episodes, dupChapters, 'ch_001')).toBeUndefined();
    expect(resolveEpisodeIdForChapter(episodes, dupChapters, 'ch_001b')).toBeUndefined();
  });

  it('episodeOutlines / novelChapters 缺 → undefined', () => {
    expect(resolveEpisodeIdForChapter(undefined, chapters, 'ch_001')).toBeUndefined();
    expect(resolveEpisodeIdForChapter(episodes, undefined, 'ch_001')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildChapterAccept
// ════════════════════════════════════════════════════════════════════════════

describe('buildChapterAccept — 链段 accept 分支产 chapter_accept artifact', () => {
  function makeSnapshot(
    artifacts: ChapterAcceptSnapshot['artifacts'],
    runId = 'run_xyz',
  ): ChapterAcceptSnapshot {
    return { runId, artifacts };
  }

  /**
   * Narrow ChapterAcceptResult → ChapterAcceptArtifact（success case helper）。
   * CR-4.1-08：buildChapterAccept 返 `ChapterAcceptArtifact | ChapterAcceptSkip` 区分式（非旧 `| undefined`），
   * 成功断言前先验「有 chapterId」narrow，让 TS 推导到 ChapterAcceptArtifact。
   */
  function expectArtifact(r: ChapterAcceptResult): ChapterAcceptArtifact {
    expect(r).toBeDefined();
    expect(r && 'chapterId' in r).toBe(true);
    if (!r || !('chapterId' in r)) throw new Error('expected ChapterAcceptArtifact, got ChapterAcceptSkip');
    return r;
  }

  const episodes = [{ id: 'ep_1', index: 0 }];
  const chapters = [{ id: 'ch_001', sort_order: 0 }];

  it('draft + accept + 无 deviation → chapter_accept（无 storyDecisions）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { title: '第1章', text: '正文内容。', wordCount: 100 },
      'route_decision': { decision: 'accept_as_truth', reason: '正文升级', deviation: false },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    }));
    expect(artifact.chapterId).toBe('ch_001');
    expect(artifact.candidate).toEqual({ title: '第1章', content: '正文内容。', wordCount: 100 });
    expect(artifact.storyDecisions).toBeUndefined(); // 无偏离 → 不登记
    expect(artifact.runId).toBe('run_xyz');
  });

  it('deviation=true → 建 decided StoryDecision（source=accept_as_truth, relatedEpisodeId, createdAt=nowISO）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '角色突然硬气', deviation: true },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    }));
    expect(artifact.storyDecisions).toHaveLength(1);
    const decision = artifact.storyDecisions![0];
    expect(decision.status).toBe('decided');
    expect(decision.source).toBe('accept_as_truth');
    expect(decision.relatedEpisodeId).toBe('ep_1');
    expect(decision.createdAt).toBe(NOW_ISO);
    expect(decision.reason).toBe('角色突然硬气');
    expect(decision.id).toBe('accept-run_xyz');
  });

  it('deviation=true + route=escalate_user -> source=escalate_accepted（2.6 CR-Edge-4：保留 escalation 上下文）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'escalate_user', reason: '灰区：正文比计划激进，上发裁决', deviation: true },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    }));
    expect(artifact.storyDecisions).toHaveLength(1);
    const decision = artifact.storyDecisions![0];
    expect(decision.status).toBe('decided');
    expect(decision.source).toBe('escalate_accepted');
    expect(decision.summary).toContain('灰区裁决');
    expect(decision.reason).toBe('灰区：正文比计划激进，上发裁决');
  });

  it('deviation 缺省（route 未输出） → 不登记 StoryDecision', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '通过' },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    }));
    expect(artifact.storyDecisions).toBeUndefined();
  });

  it('CR-4.1-08：chapterId 映射失败（章未注册） → {skipReason:"no-chapter"}（区分失败模式，非旧 undefined）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '通过' },
    });
    const result = buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_nonexistent',
      episodeOutlines: episodes,
      novelChapters: chapters,
    });
    expect(result).toEqual({ skipReason: 'no-chapter' });
  });

  it('directChapterId 优先（绕过映射）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '通过' },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      novelChapters: chapters,
      directChapterId: 'ch_custom',
    }));
    expect(artifact.chapterId).toBe('ch_custom');
  });

  it('CR-4.1-08：draft.initial 缺 / 无 text → {skipReason:"no-draft"}（区分失败模式，非旧 undefined）', () => {
    const snapshot = makeSnapshot({ 'route_decision': { decision: 'accept_as_truth' } });
    const result = buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    });
    expect(result).toEqual({ skipReason: 'no-draft' });
  });

  it('CR-4.1-09：nowISO 缺（空串） → {skipReason:"no-nowiso"}（不产 invalid createdAt 违 z.string().min(1)）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '正文升级', deviation: true },
    });
    const result = buildChapterAccept(snapshot, {
      nowISO: '',
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    });
    // nowISO 缺前置 skip（即使 deviation=true 也不登记 StoryDecision——createdAt 会违 schema）
    expect(result).toEqual({ skipReason: 'no-nowiso' });
  });
});
