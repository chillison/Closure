import { type DragEvent, useCallback, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { isProjectRunActive } from '../../shared/store/agentSessionSlice';
import { useI18n } from '../../shared/i18n/useI18n';
import type { NovelChapterMeta } from '../../shared/store/novelChapterSlice';

/**
 * Story 4.1 Step 5（design §3.4）：工作台 leader 触发入口。
 *
 * 章号从 episode.index 派生（creative-fields.ts「章号从 episode.index 派生（非存储键）」
 * / workbenchLayout.ts「章 = episode.index, derived not stored」）——故
 * chapter.sortOrder === episode.index 是本章对应的 episode。
 * 写章链段按 episodeId 触发（write_chapter params.episodeId），用户选章直传 chapterId
 * 绕过映射推断（design §3.3 directChapterId 优先）。
 *
 * 最小形态（不建 E3 横切工作面）：章列表每行加「生成」按钮 → sendAgentMessage（自然语言
 * + episodeId/chapterId 上下文）→ leader runLoop 凭 DEFAULT_ORISON_PROMPT 的 write_chapter
 * 引导调工具。leader 决定何时调 / 传什么 brief（design §3.4）。
 */
function findEpisodeForChapter(
  episodeOutlines: unknown,
  sortOrder: number,
): { id: string; title?: string } | undefined {
  if (!Array.isArray(episodeOutlines)) return undefined;
  for (const ep of episodeOutlines) {
    if (ep && typeof ep === 'object' && 'index' in ep && 'id' in ep) {
      const node = ep as { id: unknown; index: unknown; title?: unknown };
      if (typeof node.id === 'string' && node.index === sortOrder) {
        return { id: node.id, title: typeof node.title === 'string' ? node.title : undefined };
      }
    }
  }
  return undefined;
}

export function ChapterListPanel() {
  const {
    chapters, activeId, selectChapter, moveNovelChapter, resolvedLocale,
    sendAgentMessage, projectRunActive, episodeOutlines,
  } = useAppStore(
    useShallow((s) => ({
      chapters: s.novelChapters,
      activeId: s.activeChapterId,
      selectChapter: s.selectChapter,
      moveNovelChapter: s.moveNovelChapter,
      resolvedLocale: s.resolvedLocale,
      sendAgentMessage: s.sendAgentMessage,
      // dogfood T1 Stage 3（r8 三分）：生成闸是**项目运行**语义（该项目任一会话在跑都禁——
      // D4 同项目单 run，生成会发 agent 消息触发写章链）。
      projectRunActive: isProjectRunActive(s),
      episodeOutlines: s.creativeFields.episode_outlines,
    })),
  );
  const { t } = useI18n(resolvedLocale);

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  const handleGenerate = useCallback(
    (ch: NovelChapterMeta, episode: { id: string; title?: string } | undefined) => {
      // CR-4.1-18：ordinal 兜底（sortOrder undefined → '?'，避免「第 NaN 章」进 sendAgentMessage 文本）。
      // episode 由 render 侧预算并传入；无 episode 时按钮已禁用（write_chapter episodeId 必填，
      // UI 健壮避免 leader 收到无法调工具的消息卡住）。epPart else 分支仅作防御性兜底。
      const ordinal = Number.isFinite(ch.sortOrder) ? ch.sortOrder + 1 : '?';
      const epPart = episode
        ? `（episodeId: ${episode.id}${episode.title ? `「${episode.title}」` : ''}）`
        : `（未在 episode_outlines 找到 index=${ch.sortOrder} 的 episode）`;
      const message = `请生成第 ${ordinal} 章「${ch.title || ch.id}」${epPart}，目标 chapterId: ${ch.id}。请调用 write_chapter 工具触发写章链段。`;
      void sendAgentMessage(message);
    },
    [sendAgentMessage],
  );

  const handleDragStart = useCallback((e: DragEvent, index: number) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: DragEvent, toIndex: number) => {
    e.preventDefault();
    setDragOverIndex(null);
    const fromIndex = dragIndexRef.current;
    if (fromIndex !== null && fromIndex !== toIndex) {
      moveNovelChapter(fromIndex, toIndex);
    }
    dragIndexRef.current = null;
  }, [moveNovelChapter]);

  const handleDragEnd = useCallback(() => {
    setDragOverIndex(null);
    dragIndexRef.current = null;
  }, []);

  if (chapters.length === 0) {
    return (
      <div className="novel-chapter-list-empty">
        <p>{t('novelChapter.emptyList')}</p>
      </div>
    );
  }

  return (
    <ul className="novel-chapter-list" aria-label="Chapter List">
      {chapters.map((ch: NovelChapterMeta, index: number) => {
        const active = ch.id === activeId;
        const isDragOver = dragOverIndex === index;
        // CR-4.1-18：无 episode（章未在 episode_outlines 排出）→ 禁用「生成」按钮（write_chapter
        // episodeId 必填；UI 健壮避免 leader 收到无法调工具的消息卡住。episodeId 保持必填 +
        // readiness gate 不变）。
        const episode = findEpisodeForChapter(episodeOutlines, ch.sortOrder);
        const canGenerate = !projectRunActive && episode !== undefined;
        return (
          <li
            key={ch.id}
            className={`novel-chapter-item${active ? ' novel-chapter-itemActive' : ''}${isDragOver ? ' novel-chapter-item--drag-over' : ''}`}
            data-status={ch.status}
            data-chapter-id={ch.id}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
          >
            <button
              type="button"
              onClick={() => selectChapter(ch.id)}
              className="novel-chapter-button"
            >
              <span className="novel-chapter-title">{ch.title || t('novelChapter.unnamed', { id: ch.id })}</span>
              <span className="novel-chapter-status">{t(`novelChapter.statusValue.${ch.status}`)}</span>
              {ch.summary ? (
                <span className="novel-chapter-summary">{ch.summary}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="novel-chapter-generate-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleGenerate(ch, episode);
              }}
              disabled={!canGenerate}
              title={episode ? t('novelChapter.generateChapter') : t('novelChapter.generateChapterNoEpisode')}
              aria-label={episode ? t('novelChapter.generateChapter') : t('novelChapter.generateChapterNoEpisode')}
            >
              <span className="material-symbols-outlined">auto_awesome</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
