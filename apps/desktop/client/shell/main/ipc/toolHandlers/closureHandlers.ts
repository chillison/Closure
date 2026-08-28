/**
 * Closure KB query tool handler (ADR-3 / VS1 R5/AC5).
 *
 * `query_story` is the AI-side front of the closure hybrid retrieval pipeline
 * (design §2 read-flow). The agent `query_story` tool (agent/src/tool/builtin.ts)
 * crosses processes via the UNIFIED `toolExecution` channel (remoteToolProxy ->
 * handleToolExecute -> this handler). There is NO dedicated `queryStory` IPC
 * channel, NO preload method, NO `OrisonDesktopApi` entry - this mirrors how
 * every other builtin tool works (project_meta, memory_query, ...): one shared
 * tool-execution channel + a Map<toolId, handler>. design.md §3's `queryStory`
 * IPC-channel sketch was over-engineering and is deliberately NOT implemented
 * (the unified channel already exists; adding a parallel IPC path would be a
 * zero-consumer parallel substrate - [[feedback-discover-zero-consumer-assets]]).
 *
 * The handler resolves the db project_id from the project directory, delegates
 * to `searchClosure` (the shared retrieval core, also the human command-bar
 * front), and formats hits as readable Markdown for the Writer LLM. It NEVER
 * throws - a retrieval failure degrades to a friendly message so the agent never
 * sees a rejection (`searchClosure` is already best-effort, but the handler is
 * belt-and-suspenders so a thrown bug here cannot crash the runLoop turn).
 */
import path from 'node:path';
import { closureStoryQuerySchema, relationQuerySchema, type EntryHit, type RelationHit } from '@orison/shared-contracts';
import { getProject } from '../../db/projectRepository';
import { searchClosure } from '../../db/closureRetrieval';
import { searchRelations } from '../../db/relationRetrieval';
import { getLogger } from '../../logger';
import type { ToolHandler } from './types';

/** Max body_text chars rendered per hit (keeps the LLM context bounded). */
const BODY_CAP = 500;

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/**
 * Render retrieval hits as Markdown the Writer LLM can read. Each hit is a block
 * with name + type, the (length-capped) body text, and an inline relevance
 * footer (RRF score, plus vec distance when the vector arm ran). Empty results
 * get a single "no matches" line so the LLM sees an explicit miss rather than an
 * empty tool result.
 *
 * Story 8.3: chapter-source hits (sourceKind='chapter'，正文段落 chunk) render a
 * 段级出处 header instead of the generic name(type) line — `第N章·段k（出处：第N章
 * 第a-b段）`（章号 = chapterIndex+1，段落区间 = paraStart+1-paraEnd〔半开 0 起转 1 起
 * 闭区间〕）。bodyText is the chunk's ORIGINAL prose (回答 LLM 看原文——the synopsis
 * prefix lives only in the index material, never in the returned hit). 章序缺失
 * （索引时 episode 映射失败）→ 出处降级 chapterId 标注；span 字段缺失（病理态）→ 回退
 * 通用渲染。Exported for unit testing.
 */
function renderHitHeader(h: EntryHit): string {
  if (h.sourceKind === 'chapter' && h.chapterId !== undefined && h.paraStart !== undefined && h.paraEnd !== undefined) {
    const chapterLabel = h.chapterIndex !== undefined ? `第${h.chapterIndex + 1}章` : h.chapterId;
    return `## ${h.name}（出处：${chapterLabel} 第${h.paraStart + 1}-${h.paraEnd}段）`;
  }
  return `## ${h.name} (${h.entryType})`;
}

export function formatHitsForLlm(query: string, hits: EntryHit[]): string {
  if (hits.length === 0) {
    return `未找到与 "${query}" 相关的条目。`;
  }
  return hits
    .map((h) => {
      const body = truncate(h.bodyText ?? '', BODY_CAP);
      const relevance = `_相关性: ${h.score.toFixed(4)}${h.vecDistance != null ? ` vec=${h.vecDistance.toFixed(3)}` : ''}_`;
      return `${renderHitHeader(h)}\n${body}\n${relevance}`;
    })
    .join('\n\n');
}

export const queryStoryHandler: ToolHandler = async ({ params, projectDir }) => {
  // CR-08: validate + clamp params via the shared schema (revives the dead
  // raw-cast). `k` is clamped to [1, 50] so a bad LLM param (k=-1 → unlimited
  // LIMIT, k=0 → empty, k=999 → context bloat) can never reach SQL. parse is
  // wrapped because `handleToolExecute` does NOT catch handler throws — a
  // malformed param must degrade to a friendly message, never reject the tool
  // call (the handler "never throws" contract, file header §1).
  let parsed: { query: string; entry_type?: string; status?: string; visibility?: string; k: number };
  try {
    parsed = closureStoryQuerySchema.parse(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg }, 'query_story: invalid params');
    return {
      title: 'query_story',
      output: '检索参数无效，请提供查询文本。',
      metadata: { count: 0, hits: [] },
    };
  }
  const { query, entry_type, status, visibility, k } = parsed;

  // Resolve the db project_id from the project directory. local_fingerprint ==
  // path.resolve(projectDir) (projectIpc.ts ensure-registration enforces
  // `localFingerprint = path.resolve(...)` and `getProject(projectPath)`), so
  // getProject(resolve(dir)) is the canonical projectDir -> projectId lookup.
  const projectId = getProject(path.resolve(projectDir))?.projectId;
  if (!projectId) {
    return {
      title: 'query_story',
      output: '当前项目未注册到数据库，无法检索知识库。',
      metadata: { count: 0, hits: [] },
    };
  }

  if (!query || !query.trim()) {
    return {
      title: 'query_story',
      output: '请提供检索查询。',
      metadata: { count: 0, hits: [] },
    };
  }

  try {
    // Story 8.7 R4 扩参透传：status/visibility 预过滤 opts（searchClosure S5 已支持——
    // FTS/vec 候选集 WHERE 收窄；缺省 undefined = 不过滤，行为与 8.7 前一致）。
    const hits = await searchClosure(projectId, query, {
      entryType: entry_type,
      status,
      visibility,
      k,
    });
    return {
      title: `query_story: ${query.slice(0, 40)}`,
      output: formatHitsForLlm(query, hits),
      metadata: { count: hits.length, hits },
    };
  } catch (err) {
    // Never reject: the agent must see a friendly miss, not a thrown tool error.
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId, query }, 'query_story: retrieval failed');
    return {
      title: 'query_story',
      output: `检索失败: ${msg}`,
      metadata: { count: 0, hits: [], error: msg },
    };
  }
};

// ── Story 6.4 D2：query_relations 图遍历召回臂（mirror query_story，通用工具）──
//
// 图遍历召回「结构关联但语义不相似」条目（补 query_story 语义盲区）。seed→N-hop 递归 CTE
// （relationRetrieval.searchRelations）。mirror queryStoryHandler「never throws」+ toolExecution channel。
// 范式判据：递归 CTE 纯代码；消费者裁判（retrieval/Writer/Reviewer）归各 LLM。

/** Render relation hits as Markdown（mirror formatHitsForLlm，但 relevance 换成结构维度）。 */
export function formatRelationHits(hits: RelationHit[]): string {
  if (hits.length === 0) return '未找到结构关联条目。';
  return hits
    .map((h) => {
      const body = truncate(h.bodyText ?? '', BODY_CAP);
      const rel = `_关系: ${h.relationType} · hop=${h.depth}_`;
      return `## ${h.name} (${h.entryType})\n${body}\n${rel}`;
    })
    .join('\n\n');
}

export const queryRelationsHandler: ToolHandler = async ({ params, projectDir }) => {
  let parsed: {
    seed_entry_id: string;
    depth: number;
    budget: number;
    relation_type?: string;
    visibility?: 'public' | 'secret' | 'one_sided';
  };
  try {
    parsed = relationQuerySchema.parse(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg }, 'query_relations: invalid params');
    return {
      title: 'query_relations',
      output: '检索参数无效，请提供 seed_entry_id（起点条目 id）。',
      metadata: { count: 0, hits: [] },
    };
  }
  const { seed_entry_id, depth, budget, relation_type, visibility } = parsed;

  const projectId = getProject(path.resolve(projectDir))?.projectId;
  if (!projectId) {
    return {
      title: 'query_relations',
      output: '当前项目未注册到数据库，无法检索关系图。',
      metadata: { count: 0, hits: [] },
    };
  }

  try {
    const hits = searchRelations(projectId, seed_entry_id, {
      depth,
      budget,
      relationType: relation_type,
      visibility,
    });
    return {
      title: `query_relations: ${seed_entry_id.slice(0, 32)} (${hits.length})`,
      output: formatRelationHits(hits),
      metadata: { count: hits.length, hits, seedEntryId: seed_entry_id, depth, budget },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectId, seed_entry_id }, 'query_relations: traversal failed');
    return {
      title: 'query_relations',
      output: `关系遍历失败: ${msg}`,
      metadata: { count: 0, hits: [], error: msg },
    };
  }
};
