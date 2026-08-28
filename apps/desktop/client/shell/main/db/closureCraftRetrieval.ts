import type { CraftHit, ResolvedModel } from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import { floatArrayToBuffer } from './closureIndexer';
import { getCurrentCraftVecDim } from './closureCraftIndexer';
import {
  RRF_K,
  sanitizeFtsTerm,
  shouldRetryFtsOnly,
  type RetrievalDeps,
} from './closureRetrieval';
import { rerankCandidates } from './closureRerank';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import { getLogger } from '../logger';

/**
 * Global craft KB hybrid retrieval (ADR-3 / Story 2.1). Mirrors `searchClosure`
 * for the GLOBAL craft reference library (`closure_craft_*` derived index).
 *
 * Fuses a structured pre-filter + FTS5 bm25 + vec0 KNN via RRF (k=60), then
 * returns parent-doc craft entries. KEY DIFFERENCE from searchClosure: NO
 * `projectId` (the craft KB is cross-project). vec0 has no `project_id` partition
 * key, so the craft_type filter is the only structured pre-filter. Table names are
 * closure_craft_entry / closure_craft_fts / closure_craft_vec; `craft_type` stands
 * in for `entry_type`.
 *
 * Reuses the PURE helpers from closureRetrieval (`sanitizeFtsTerm` /
 * `computeRrfScore` / `shouldRetryFtsOnly` / `RRF_K`) - they have no project
 * coupling. `buildCraftRrfQuery` is the craft variant of `buildRrfQuery` with the
 * project filter dropped.
 *
 * Offline / best-effort degradation (mirror searchClosure): no embedding model /
 * vec unloaded / dim mismatch / endpoint failure -> vec arm skipped, query
 * degrades to FTS5 + structured + RRF. The shared rerank stage (rerankCandidates)
 * runs after RRF; rerank unavailable -> RRF top-k.
 *
 * Story 8.7 dual-vector (design §3.2, craft mirror): craft docs are ALL long
 * docs, so every doc carries #body + #identity vectors. The vec arm runs KNN
 * over ALL closure_craft_vec rows (kind never filtered), dedupes to each doc's
 * best row, and surfaces that row's vector_kind as the hit's `vectorKind` +
 * `summary_text` as `summaryText`. NO status/visibility pre-filter here: the
 * craft table has no such columns (craft docs are all public, no card status).
 */

type CraftRow = {
  craft_id: string;
  craft_type: string;
  source_kind: string;
  name: string;
  body_text: string;
  /** Story 8.7: doc-level one-liner summary (curated / generated; NULL = none). */
  summary_text: string | null;
  /** Story 8.7: vector_kind of the hit row ('body' | 'identity'; NULL = vec arm did not surface this hit). */
  vector_kind: string | null;
  score: number;
  fts_rank: number | null;
  vec_distance: number | null;
};

function rowToCraftHit(r: CraftRow): CraftHit {
  return {
    craftId: r.craft_id,
    craftType: r.craft_type,
    sourceKind: r.source_kind,
    name: r.name,
    bodyText: r.body_text,
    score: r.score,
    ftsRank: r.fts_rank ?? undefined,
    vecDistance: r.vec_distance ?? undefined,
    // Story 8.7: summary is doc-level (present on every arm's SELECT); the
    // vector kind is only set when the vec arm surfaced this hit.
    summaryText: r.summary_text ?? undefined,
    vectorKind: r.vector_kind ?? undefined,
  };
}

type QueryPlan = { hasVec: boolean; hasFts: boolean };

/**
 * Assemble the craft RRF SQL + positional params for the four arm-combinations.
 * Mirrors `buildRrfQuery` with the `project_id` filter dropped (global scope) and
 * table/column names swapped. vec0 metadata `WHERE` supports only `= != > >= < <=`
 * (no IN/LIKE), so `craft_type = ?` is pushed inside vec0 AND applied in the final
 * closure_craft_entry filter (belt-and-suspenders, same as searchClosure).
 */
function buildCraftRrfQuery(args: {
  craftType?: string;
  k: number; // final LIMIT (candidateLimit = max(k, topN) so rerank has a pool)
  topN: number;
  qVec: Buffer | null;
  ftsTerm: string | null;
  vecArm: boolean;
}): { sql: string; params: unknown[]; plan: QueryPlan } {
  const { craftType, k, topN, qVec, ftsTerm, vecArm } = args;
  const hasVec = qVec !== null && vecArm;
  const hasFts = ftsTerm !== null;
  const vecCt = craftType ? ' AND craft_type = ?' : ''; // inside vec0
  const vecCtParams = craftType ? [craftType] : [];
  const whereCt = craftType ? 'WHERE c.craft_type = ?' : ''; // final filter (no project_id)
  // Story 8.7 dual-vector (mirror searchClosure): vec0 `k` counts VECTOR ROWS and
  // every craft doc occupies two (#body + #identity), so the row budget is
  // doubled to hold the distinct-doc pool at topN after the per-doc dedupe.
  const vecK = topN * 2;
  // Dual-vector KNN CTE chain (mirror searchClosure's vecCtes, minus the
  // project_id partition): KNN over ALL rows -> best row per doc (that row's
  // vector_kind becomes the hit's kind) -> rn over the deduped set (one doc =
  // one vec rank, so RRF fusion stays per-doc). `vec_rows` is MATERIALIZED to
  // isolate the vec0 KNN scan - vec0 rejects a KNN query with more than one
  // ORDER BY or an ORDER BY on a non-distance column, and flattening would push
  // the dedupe's GROUP BY / window ORDER BY into the vtab scan. The min()
  // bare-column rule carries the nearest row's vector_kind (ties -> arbitrary
  // one of the equally-near rows). See searchClosure for the full rationale.
  const vecCtes = `
          vec_rows AS MATERIALIZED (
            SELECT craft_id, vector_kind, distance
            FROM closure_craft_vec
            WHERE embedding MATCH ? AND k = ?${vecCt}
          ),
          vec_best AS (
            SELECT craft_id, vector_kind, min(distance) AS distance
            FROM vec_rows
            GROUP BY craft_id
          ),
          vec_matches AS (
            SELECT craft_id, vector_kind, distance,
                   row_number() OVER (ORDER BY distance) AS rn
            FROM vec_best
          )`;

  // Case 4: structured-only (no vector + empty/unsanitizable query).
  if (!hasVec && !hasFts) {
    return {
      sql: `SELECT c.craft_id AS craft_id, c.craft_type AS craft_type, c.source_kind AS source_kind,
                   c.name AS name, c.body_text AS body_text, c.summary_text AS summary_text,
                   NULL AS vector_kind, 0 AS score, NULL AS fts_rank, NULL AS vec_distance
            FROM closure_craft_entry c
            ${craftType ? 'WHERE c.craft_type = ?' : ''}
            ORDER BY c.updated_at DESC
            LIMIT ?`,
      params: craftType ? [craftType, k] : [k],
      plan: { hasVec: false, hasFts: false },
    };
  }

  // Case 2: FTS-only (vector arm skipped).
  if (hasFts && !hasVec) {
    return {
      sql: `WITH fts_matches AS (
              SELECT craft_id, row_number() OVER (ORDER BY rank) AS rn, rank
              FROM closure_craft_fts
              WHERE closure_craft_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            )
            SELECT c.craft_id AS craft_id, c.craft_type AS craft_type, c.source_kind AS source_kind,
                   c.name AS name, c.body_text AS body_text, c.summary_text AS summary_text,
                   NULL AS vector_kind,
                   coalesce(1.0 / (${RRF_K} + f.rn), 0) AS score,
                   f.rank AS fts_rank, NULL AS vec_distance
            FROM fts_matches f
            JOIN closure_craft_entry c ON c.craft_id = f.craft_id
            ${whereCt}
            ORDER BY score DESC
            LIMIT ?`,
      params: craftType ? [ftsTerm, topN, craftType, k] : [ftsTerm, topN, k],
      plan: { hasVec: false, hasFts: true },
    };
  }

  // Case 3: vec-only (query sanitized to empty FTS term).
  if (hasVec && !hasFts) {
    return {
      sql: `WITH${vecCtes}
            SELECT c.craft_id AS craft_id, c.craft_type AS craft_type, c.source_kind AS source_kind,
                   c.name AS name, c.body_text AS body_text, c.summary_text AS summary_text,
                   v.vector_kind AS vector_kind,
                   coalesce(1.0 / (${RRF_K} + v.rn), 0) AS score,
                   NULL AS fts_rank, v.distance AS vec_distance
            FROM vec_matches v
            JOIN closure_craft_entry c ON c.craft_id = v.craft_id
            ${whereCt}
            ORDER BY score DESC
            LIMIT ?`,
      params: [qVec, vecK, ...vecCtParams, ...(craftType ? [craftType] : []), k],
      plan: { hasVec: true, hasFts: false },
    };
  }

  // Case 1: both arms - FULL OUTER JOIN fusion.
  return {
    sql: `WITH${vecCtes},
          fts_matches AS (
            SELECT craft_id, row_number() OVER (ORDER BY rank) AS rn, rank
            FROM closure_craft_fts
            WHERE closure_craft_fts MATCH ?
            ORDER BY rank
            LIMIT ?
          )
          SELECT c.craft_id AS craft_id, c.craft_type AS craft_type, c.source_kind AS source_kind,
                 c.name AS name, c.body_text AS body_text, c.summary_text AS summary_text,
                 v.vector_kind AS vector_kind,
                 (coalesce(1.0 / (${RRF_K} + f.rn), 0) + coalesce(1.0 / (${RRF_K} + v.rn), 0)) AS score,
                 f.rank AS fts_rank, v.distance AS vec_distance
          FROM fts_matches f
          FULL OUTER JOIN vec_matches v ON v.craft_id = f.craft_id
          JOIN closure_craft_entry c ON c.craft_id = coalesce(f.craft_id, v.craft_id)
          ${whereCt}
          ORDER BY score DESC
          LIMIT ?`,
    params: [qVec, vecK, ...vecCtParams, ftsTerm, topN, ...(craftType ? [craftType] : []), k],
    plan: { hasVec: true, hasFts: true },
  };
}

/**
 * Default embed for the craft query vector (mirror searchClosure.defaultEmbed).
 * 30s timeout guards a hung endpoint.
 */
async function defaultEmbed(model: ResolvedModel, text: string): Promise<number[]> {
  const res = await generateEmbeddings(
    model,
    { input: [text] },
    { signal: AbortSignal.timeout(30_000) },
  );
  return res.embeddings[0] ?? [];
}

/**
 * Run a hybrid retrieval against the global craft KB derived index. Mirrors
 * `searchClosure` minus the projectId scope.
 *
 * @param query free-text query (embedded for the vector arm; sanitized + phrase-
 *   quoted for the FTS arm).
 * @param opts craftType (structured pre-filter), k (final result count, default
 *   10), topN (per-arm candidate depth fed into RRF, default 20).
 * @param deps DI seam for tests (stubbed embed/resolveModel/rerank -> zero network).
 * @returns ranked CraftHit[] (empty on best-effort failure - never throws).
 */
export async function searchCraft(
  query: string,
  opts?: { craftType?: string; k?: number; topN?: number },
  deps?: RetrievalDeps,
): Promise<CraftHit[]> {
  const k = opts?.k ?? 10;
  const topN = opts?.topN ?? 20;
  const candidateLimit = Math.max(k, topN);
  const craftType = opts?.craftType;
  const resolveModel = deps?.resolveModel ?? resolveEmbeddingModel;
  const embed = deps?.embed ?? defaultEmbed;
  const db = getDb();
  const vecDim = getCurrentCraftVecDim(db);

  // 1. Embed the query (best-effort). qVec stays null on no model / vec unloaded /
  //    blank query / endpoint failure / dim mismatch -> vector arm skipped.
  let qVec: Buffer | null = null;
  const vecArm = isSqliteVecAvailable();
  const model = resolveModel();
  if (model && vecArm && query.trim()) {
    try {
      const vecArr = await embed(model, query);
      if (vecDim !== null && vecArr.length === vecDim) {
        qVec = floatArrayToBuffer(vecArr);
      } else {
        getLogger().warn(
          { expected: vecDim, got: vecArr.length, model: model.modelId },
          'craft retrieval: query embedding dim mismatch - skipping vector arm',
        );
      }
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'craft retrieval: query embed failed - skipping vector arm',
      );
    }
  }

  // 2. Sanitize the FTS query.
  const ftsTerm = sanitizeFtsTerm(query);

  // 3. Build + run the conditional RRF query (CR-04 retry FTS-only on vec runtime throw).
  const runQuery = (qVecOverride: Buffer | null): CraftHit[] => {
    const { sql, params } = buildCraftRrfQuery({
      craftType,
      k: candidateLimit,
      // CR-craft-kb-006: per-arm CTE LIMIT + vec0 `k=?` take `topN`; bump to
      // `candidateLimit` so k in [21, 50] is satisfiable in single-arm mode
      // (previously capped at 20). Mirror searchClosure.
      topN: candidateLimit,
      qVec: qVecOverride,
      ftsTerm,
      vecArm,
    });
    const rows = db.prepare(sql).all(...params) as CraftRow[];
    return rows.map(rowToCraftHit);
  };

  try {
    const hits = runQuery(qVec);
    // Shared cross-encoder rerank stage (Story 2.1): RRF topN -> rerank -> top-k.
    // rerank unavailable -> degrade to RRF top-k (slice(0, k)).
    return await rerankCandidates(query, hits, k, {
      resolveModel: deps?.resolveRerankModel,
      rerank: deps?.rerank,
    });
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), craftType },
      'craft retrieval: hybrid query failed',
    );
    if (shouldRetryFtsOnly(qVec !== null && vecArm, ftsTerm)) {
      try {
        getLogger().warn(
          { craftType },
          'craft retrieval: retrying FTS-only (vec arm dropped)',
        );
        const retryHits = runQuery(null);
        return await rerankCandidates(query, retryHits, k, {
          resolveModel: deps?.resolveRerankModel,
          rerank: deps?.rerank,
        });
      } catch (err2) {
        getLogger().warn(
          { err: err2 instanceof Error ? err2.message : String(err2), craftType },
          'craft retrieval: FTS-only retry also failed - returning empty',
        );
      }
    }
    return [];
  }
}
