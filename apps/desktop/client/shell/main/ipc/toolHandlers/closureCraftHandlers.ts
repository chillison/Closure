/**
 * Craft KB query tool handler (ADR-3 / Story 2.1). Mirrors `closureHandlers.ts`
 * (`queryStoryHandler`) for the GLOBAL craft reference library.
 *
 * `query_craft` is the AI-side front of the craft hybrid retrieval pipeline. The
 * agent `query_craft` tool (agent/src/tool/builtin.ts) crosses processes via the
 * UNIFIED `toolExecution` channel (remoteToolProxy -> handleToolExecute -> this
 * handler). There is NO dedicated IPC channel, NO preload method, NO
 * `OrisonDesktopApi` entry - same unified-channel pattern as `query_story`.
 *
 * KEY DIFFERENCE from queryStoryHandler: the craft KB is GLOBAL, so this handler
 * does NOT resolve a projectId from the project dir and does NOT scope the query.
 * It delegates straight to `searchCraft` (the shared craft retrieval core) and
 * formats hits as readable Markdown for the Writer LLM. NEVER throws - a retrieval
 * failure degrades to a friendly message so the agent never sees a rejection.
 */
import { closureCraftQuerySchema, type CraftHit } from '@orison/shared-contracts';
import { searchCraft } from '../../db/closureCraftRetrieval';
import { getLogger } from '../../logger';
import type { ToolHandler } from './types';

/** Max body_text chars rendered per hit (keeps the LLM context bounded). */
const BODY_CAP = 800;

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/**
 * Render craft retrieval hits as Markdown the Writer LLM can read. Each hit is a
 * block with name + craft_type, the (length-capped) body text, and an inline
 * relevance footer (RRF score, plus vec distance when the vector arm ran, plus
 * rerank score when the rerank stage ran). Empty results get a single "no
 * matches" line. Exported for unit testing.
 */
export function formatCraftHitsForLlm(query: string, hits: CraftHit[]): string {
  if (hits.length === 0) {
    return `未找到与 "${query}" 相关的 craft 文档。`;
  }
  return hits
    .map((h) => {
      const body = truncate(h.bodyText ?? '', BODY_CAP);
      const segments = [`_相关性: ${h.score.toFixed(4)}`];
      if (h.vecDistance != null) segments.push(`vec=${h.vecDistance.toFixed(3)}`);
      if (h.rerankScore != null) segments.push(`rerank=${h.rerankScore.toFixed(3)}`);
      const relevance = segments.join(' ') + '_';
      return `## ${h.name} (${h.craftType})\n${body}\n${relevance}`;
    })
    .join('\n\n');
}

export const queryCraftHandler: ToolHandler = async ({ params }) => {
  // Validate + clamp params (mirror queryStoryHandler CR-08). `k` clamped to
  // [1, 50] so a bad LLM param can never reach SQL. parse is wrapped because
  // handleToolExecute does NOT catch handler throws - a malformed param must
  // degrade to a friendly message (the handler "never throws" contract).
  let parsed: { query: string; craft_type?: string; k: number };
  try {
    parsed = closureCraftQuerySchema.parse(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg }, 'query_craft: invalid params');
    return {
      title: 'query_craft',
      output: '检索参数无效，请提供查询文本。',
      metadata: { count: 0, hits: [] },
    };
  }
  const { query, craft_type, k } = parsed;

  if (!query || !query.trim()) {
    return {
      title: 'query_craft',
      output: '请提供检索查询。',
      metadata: { count: 0, hits: [] },
    };
  }

  try {
    const hits = await searchCraft(query, { craftType: craft_type, k });
    return {
      title: `query_craft: ${query.slice(0, 40)}`,
      output: formatCraftHitsForLlm(query, hits),
      metadata: { count: hits.length, hits },
    };
  } catch (err) {
    // Never reject: the agent must see a friendly miss, not a thrown tool error.
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, query }, 'query_craft: retrieval failed');
    return {
      title: 'query_craft',
      output: `检索失败: ${msg}`,
      metadata: { count: 0, hits: [], error: msg },
    };
  }
};
