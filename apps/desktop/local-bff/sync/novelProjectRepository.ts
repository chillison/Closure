import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadProject, saveProject } from './localProjectRepository';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import {
  acceptChapterCandidateCore,
  type ChapterCandidate,
  type ChapterIntegrationProject,
  type StoryDecision,
} from '@orison/shared-contracts';

// ── 章节元数据 ──

/**
 * 从 project.yaml 的 novel.chapters 中读取单个章节元数据。
 * 找不到返回 null。
 */
export function loadChapterMetadata(projectPath: string, chapterId: string): Record<string, any> | null {
  const project = loadProject(projectPath);
  if (!project) return null;

  const chapters = (project as any).novel?.chapters;
  if (!chapters || !Array.isArray(chapters)) return null;

  const chapter = chapters.find((ch: any) => ch.id === chapterId);
  return chapter ?? null;
}

// ── 章节正文 (Markdown) ──

/**
 * 读取单个章节第一节的 markdown 正文。
 * 文件不存在返回 null。
 */
export function loadChapterMarkdown(projectPath: string, contentFile: string): string | null {
  const filePath = path.join(projectPath, contentFile);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8');
}

// ── 候选内容接收 ──

// `ChapterCandidate` 类型从 shared-contracts 导入（4.1 Step 4：统一 shape，DRY）。local-bff 既有 export
// 的 ChapterCandidate 别名经 `export type` re-export 保持向后兼容（既有 import 仍可用）。
export type { ChapterCandidate } from '@orison/shared-contracts';

/**
 * 接受章节候选结果：写入 markdown 到第一节 + 更新 project.yaml 章节元数据 + 追加 story_decisions。
 *
 * 4.1 Step 4：项目 mutation 经 shared `acceptChapterCandidateCore`（DRY，与 applyFieldPatches
 * chapter_candidate 分支共用纯逻辑）；本函数包 disk 写盘（mkdir + atomicWrite + saveProject）。
 *
 * layering（data-model.md L31）：project.yaml 受管配置，本函数在 local-bff 层（结构化 IPC 路径）写盘，
 * agent 不直写。链段产 chapter_accept artifact → IPC 入口（closureChainIpc）调本函数持久化。
 *
 * @param storyDecisions  accept 登记 StoryDecision（route=accept_as_truth 偏离计划时；追加到 novel.story_decisions[]）
 */
export function acceptChapterCandidate(
  projectPath: string,
  chapterId: string,
  runId: string,
  candidate: ChapterCandidate,
  storyDecisions?: StoryDecision[],
): void {
  const project = loadProject(projectPath);
  if (!project) {
    throw new Error(`Project not found at ${projectPath}`);
  }

  const nowISO = new Date().toISOString();
  const result = acceptChapterCandidateCore({
    project: project as unknown as ChapterIntegrationProject,
    chapterId,
    runId,
    candidate,
    nowISO,
    storyDecisions,
  });
  if (!result) {
    // core 返 null = novel.chapters / chapter / section 缺失（mirror 4.0 前显式失败姿态）。
    throw new Error(`Chapter ${chapterId} not found or has no sections in project at ${projectPath}`);
  }

  // 写入 markdown 文件（disk 写盘在调用方——core 纯函数不写盘）。
  const mdPath = path.join(projectPath, result.mdPath);
  const mdDir = path.dirname(mdPath);
  if (!existsSync(mdDir)) {
    mkdirSync(mdDir, { recursive: true });
  }
  atomicWriteFileSync(mdPath, result.mdContent, 'utf8');

  // 持久化 project.yaml（章节元数据 + story_decisions 已由 core mutate；调用方 bump meta 版本）。
  const updated = result.updatedProject as unknown as ChapterIntegrationProject;
  updated.meta.version = (updated.meta.version ?? 0) + 1;
  updated.meta.updated_at = nowISO;
  saveProject(projectPath, updated as any);
}
