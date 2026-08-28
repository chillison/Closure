/**
 * Chapter tool handlers — chapter_list, chapter_read, chapter_write
 */
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { assertWithinProject } from '../pathGuard';
import { notifyUI } from '../toolNotify';
import { snapshotToLocalHistory } from '../../fs/localHistory';
import type { ToolHandler } from './types';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { resolveChapterIdForEpisode } from '@orison/shared-contracts';
import { getProject } from '../../db/projectRepository';
import { listChapterSummaries } from '../../db/worldStateRepository';
import { readChapterSource } from '../../db/chapterChunkIndexer';
import { degradeMentionLedgerForChapterFile } from '../../db/mentionLedgerDegrade';
import { getLogger } from '../../logger';

const CHAPTERS_DIR = 'chapters';

// ── Story 8.7 S6（R3/R5）：chapter_list 目录行密度升级（design §4.1）──
//
// 目录行 = `${file}: ${标题}（storyTime 窗）— ${synopsis}`——storyTime 窗 + 章梗概从
// closure_chapter_summary（DERIVED，8.1 六字段摘要 + 8.7 synopsis）读。章文件名（chapterId）→
// episodeId 映射走**既有 canonical 链**（chapter-integration.ts resolveChapterIdForEpisode）：
// episode.index ↔ novel.chapters[].sort_order ↔ sections[0].content_file → 文件名 stem。全链
// graceful：未注册 db / 无摘要 / 映射失败（sort_order 歧义或字符串形态）/ yaml 读失败 →
// 退现状行（标题行），目录永不因增强失败而断。

/** 单章增强信息（closure_chapter_summary 投影；两者皆空 = 该章无增强）。 */
interface ChapterLineEnrichment {
  /** storyTime 窗文案（如 "10-20"）；null = 本章无已提取 events（窗字段全 null）。 */
  storyTimeWindow: string | null;
  /** 一段话梗概（写手出场申报产物）；undefined = 缺申报章不编造（schema 契约）。 */
  synopsis?: string;
}

/** storyTime 窗格式化：闭区间 `${start}-${end}`；单点/半缺退单值；全缺 → null。 */
function formatStoryTimeWindow(start: number | null | undefined, end: number | null | undefined): string | null {
  const s = typeof start === 'number' && Number.isFinite(start) ? start : null;
  const e = typeof end === 'number' && Number.isFinite(end) ? end : null;
  if (s !== null && e !== null) return s === e ? `${s}` : `${s}-${e}`;
  if (e !== null) return `${e}`;
  if (s !== null) return `${s}`;
  return null;
}

/**
 * 目录行拼装（纯函数，测试锚点）：`${file}: ${标题}（storyTime 窗）— ${梗概}`；无增强 → 现状行。
 */
export function composeChapterCatalogLine(
  fileName: string,
  firstLine: string,
  enrich?: ChapterLineEnrichment,
): string {
  const base = `${fileName}: ${firstLine}`;
  if (enrich === undefined) return base;
  const withWindow =
    enrich.storyTimeWindow !== null ? `${base}（storyTime ${enrich.storyTimeWindow}）` : base;
  if (enrich.synopsis === undefined) return withWindow;
  // 窗后紧跟 —（design §4.1 格式 `标题（storyTime 窗）— 梗概`）；无窗时用空格隔开。
  return enrich.storyTimeWindow !== null ? `${withWindow}— ${enrich.synopsis}` : `${base} — ${enrich.synopsis}`;
}

/** content_file（相对路径）→ 章文件 stem（chapters/ 目录 listing 的 key 形态）。 */
function stemOfContentFile(contentFile: string): string {
  const base = path.posix.basename(contentFile.replace(/\\/g, '/'));
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * 章文件 stem → 章摘要增强 的组装（全 graceful，任何失败返空 map 退现状行）：
 * 1. registry projectId（未注册 → 空）；2. 章摘要（空 → 空，省 yaml 读）；
 * 3. loadProject + canonical 映射（episode → chapter → content_file stem）。
 *
 * 映射经 resolveChapterIdForEpisode 单源（CR-4.1-06 多命中防御照继承）；同 stem 双 episode
 * （episode.index 重复等数据歧义）先到先得跳过（目录行显示增强，歧义宁缺毋错）。
 * 读路径零持久化副作用（纯读 project.yaml + closure_chapter_summary）。
 */
async function loadChapterListEnrichment(projectDir: string): Promise<Map<string, ChapterLineEnrichment>> {
  const empty = new Map<string, ChapterLineEnrichment>();
  try {
    const projectId = getProject(path.resolve(projectDir))?.projectId;
    if (!projectId) return empty;

    const summaries = listChapterSummaries(projectId);
    if (summaries.length === 0) return empty;

    const { loadProject } = await import('@orison/desktop-local-bff');
    const doc = (await loadProject(projectDir)) as Record<string, unknown> | null;
    if (doc === null) return empty;

    // 防御性 raw 抽取（direct 字段抽取惯例——组装层不 coupling 全文档 schema）。
    const rawEpisodes = doc.episode_outlines;
    const rawNovel = doc.novel as { chapters?: unknown } | undefined;
    const rawChapters = rawNovel?.chapters;
    if (!Array.isArray(rawEpisodes) || !Array.isArray(rawChapters)) return empty;
    const episodes = rawEpisodes
      .map((ep) => ep as { id?: unknown; index?: unknown })
      .filter((ep): ep is { id: string; index: number } => typeof ep.id === 'string' && typeof ep.index === 'number');
    const chapters = rawChapters
      .map((ch) => ch as { id?: unknown; sort_order?: unknown; sections?: unknown })
      .filter(
        (ch): ch is { id: string; sort_order?: number; sections?: Array<{ content_file?: unknown }> } =>
          typeof ch.id === 'string',
      );

    // episodeId → 章摘要（同 id 多行 last-wins 不发生——PK 唯一；防御取首行）。
    const summaryByEpisode = new Map<string, (typeof summaries)[number]>();
    for (const s of summaries) {
      if (!summaryByEpisode.has(s.episodeId)) summaryByEpisode.set(s.episodeId, s);
    }

    const enrichment = new Map<string, ChapterLineEnrichment>();
    for (const episode of episodes) {
      const chapterId = resolveChapterIdForEpisode(episodes, chapters, episode.id);
      if (chapterId === undefined) continue;
      const chapter = chapters.find((ch) => ch.id === chapterId);
      const contentFile = chapter?.sections?.[0]?.content_file;
      if (typeof contentFile !== 'string' || contentFile.length === 0) continue;
      const stem = stemOfContentFile(contentFile);
      if (stem.length === 0 || enrichment.has(stem)) continue; // 歧义先到先得，宁缺毋错
      const summary = summaryByEpisode.get(episode.id);
      if (summary === undefined) continue;
      enrichment.set(stem, {
        storyTimeWindow: formatStoryTimeWindow(summary.summary?.storyTimeStart, summary.storyTimeEnd),
        ...(typeof summary.summary?.synopsis === 'string' ? { synopsis: summary.summary.synopsis } : {}),
      });
    }
    return enrichment;
  } catch (err) {
    // 增强层永不阻断目录（现状行兜底）；warn 留痕。
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectDir },
      'chapter_list: enrichment failed, falling back to plain lines',
    );
    return empty;
  }
}

/**
 * CR-T2-007（dogfood T2 patch 批，2026-08-25）：chapterId（chapters/*.md 文件名 stem，链上
 * 形如 `ch-0003`）→ 用户可读章序。`ch-\d+` 剥前缀转序数（ch-0003 → 3，用户逐字样例是
 * 「第 3 章」而非「第 ch-0003 章」）；其他形态（手写中文文件名/`ch_1` 下划线等）原样内插
 * ——不猜测序号语义（mirror agent 侧 write-chapter `formatStorySyncChapterLabel` 的
 * CR-08-16-010 纪律：非模板形态不硬套模板）。
 */
function chapterOrdinalLabel(chapterId: string): string {
  const m = /^ch-(\d+)$/.exec(chapterId);
  return m ? String(Number(m[1])) : chapterId;
}

export const chapterListHandler: ToolHandler = async ({ projectDir }) => {
  const dir = path.join(projectDir, CHAPTERS_DIR);
  if (!existsSync(dir)) return { title: 'chapter_list', output: '尚未创建章节目录（还没有任何章节）。', metadata: { count: 0 } };

  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const enrichment = await loadChapterListEnrichment(projectDir);
  const summaries = files.map((f) => {
    const content = readFileSync(path.join(dir, f), 'utf-8');
    const firstLine = (content.split('\n')[0] || f).replace(/^#+\s*/, '');
    // stem = 文件名去 .md（chapter_read/chapter_write 的 chapterId 形态，现状注释）。
    const stem = f.endsWith('.md') ? f.slice(0, -3) : f;
    return composeChapterCatalogLine(f, firstLine, enrichment.get(stem));
  });

  return {
    title: 'chapter_list',
    output: summaries.join('\n'),
    metadata: { count: files.length },
  };
};

export const chapterReadHandler: ToolHandler = async ({ params, projectDir }) => {
  const { chapterId } = params as { chapterId: string };
  const filePath = path.join(projectDir, CHAPTERS_DIR, `${chapterId}.md`);
  assertWithinProject(projectDir, filePath);
  if (!existsSync(filePath)) throw new Error(`未找到章节：${chapterId}`);

  // E6（CR 2026-08-20）：读走 readChapterSource（BOM strip + CRLF→LF 归一）——与 chunk 索引器的
  // 分块基准**同一字符串**。此前裸 readFileSync 使 Windows 外部编辑器写的 CRLF/BOM 章在
  // chapter_read 输出与 chunk charSpan 基准间错位（段级出处锚对不上 LLM 看到的文本）。读取竞态
  //（existsSync 后文件消失）由 undefined 分支兜回同款 not-found 错。
  const content = readChapterSource(projectDir, chapterId);
  if (content === undefined) throw new Error(`未找到章节：${chapterId}`);
  return {
    title: `chapter: ${chapterId}`,
    output: content,
  };
};

export const chapterWriteHandler: ToolHandler = async ({ params, projectDir }) => {
  const { chapterId, content } = params as { chapterId: string; content: string };
  const dir = path.join(projectDir, CHAPTERS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${chapterId}.md`);
  assertWithinProject(projectDir, filePath);

  // Snapshot the pre-write content so suggest-mode "reject" can restore it
  // (the tool writes to disk now; the diff is reviewed afterwards). null marks
  // a brand-new file, which reject should delete rather than blank out.
  const existedBefore = existsSync(filePath);
  const previousContent = existedBefore ? readFileSync(filePath, 'utf-8') : null;

  if (existedBefore) {
    const existing = previousContent as string;
    if (existing === content) {
      const wordCount = content.replace(/\s+/g, '').length;
      return {
        title: `chapter_write: ${chapterId}`,
        output: `第 ${chapterOrdinalLabel(chapterId)} 章内容已是最新（约 ${wordCount} 字），无需改动——可以继续下一章了。`,
        metadata: { wordCount, previousContent, existedBefore },
      };
    }
  }

  // Agent chapter rewrites are the highest-risk overwrite path — snapshot first.
  snapshotToLocalHistory(projectDir, filePath, content);
  atomicWriteFileSync(filePath, content, 'utf-8');
  // Notify both chapter-level listeners (word count) and file-level listeners
  // (open-tab reload). Without file:changed, an editor showing this chapter
  // won't refresh until manually closed and reopened (issue #4). Path is
  // project-relative, matching writeFileHandler's convention.
  notifyUI({ type: 'chapter:changed', projectPath: projectDir, chapterId });
  notifyUI({ type: 'file:changed', projectPath: projectDir, path: `${CHAPTERS_DIR}/${chapterId}.md` });
  // Story 8.7 BMad CR-001：章正文被重写 → mention 账 best-effort 降档（对话侧修订失效语义，
  // design §2.3；永不抛不阻写盘——账失败可下次重收）。幂等：链内 targeted-revision 已降档的章
  // （7.4 splice 落盘经此）再触发为 no-op。
  await degradeMentionLedgerForChapterFile(projectDir, chapterId);
  const wordCount = content.replace(/\s+/g, '').length;
  return {
    title: `chapter_write: ${chapterId}`,
    output: `第 ${chapterOrdinalLabel(chapterId)} 章已写入并保存（约 ${wordCount} 字），可以继续下一章了。`,
    metadata: { wordCount, previousContent, existedBefore },
  };
};

export const rewritePassageHandler: ToolHandler = async ({ params }) => {
  const { chapterId, filePath, originalText, replacement } = params as {
    chapterId?: string; filePath?: string; originalText: string; replacement: string;
  };
  return {
    title: 'rewrite_passage',
    output: `选段改写已备好（约 ${replacement.length} 字）。请等待用户审阅。`,
    metadata: {
      type: 'passage',
      chapterId,
      filePath,
      originalText,
      replacement,
    },
  };
};
