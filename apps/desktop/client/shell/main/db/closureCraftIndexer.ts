import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ResolvedModel } from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import {
  EMBED_DIM,
  floatArrayToBuffer,
  shouldSkipForModelMismatch,
} from './closureIndexer';
import {
  defaultGenerateSummary,
  buildIdentityText,
  resolveDocSummary,
} from './docSummary';
import { resolveEmbeddingModel, resolveSummaryModel } from '../ipc/modelGatewayIpc';
import { parseCraftMd, extractCraftName, deriveCraftId } from './craftMd';
import { listCraftMdFiles } from './craftKbPaths';
import { getLogger } from '../logger';

/**
 * Global craft KB reindex indexer (ADR-3 / Story 2.1). Mirrors `closureIndexer`
 * for the GLOBAL craft reference library. Source of truth = markdown docs under
 * `~/.orison/craft-kb/` (+ bundled seeds); `closure_craft_*` is a DERIVED
 * query/retrieval face that can be dropped + rebuilt from the docs at any time.
 *
 * Differences from closureIndexer: source is a markdown FILE (frontmatter +
 * body), not a `project_assets` row; no `projectId` (global); `craft_type`
 * instead of `entry_type`; no `visibility` (craft docs are all public). The
 * crash-consistency contract (gate G3) is identical: the embed call AND the
 * Story 8.7 summary generate run OUTSIDE any txn, only the closure_craft_*
 * writes are wrapped in a single WAL transaction.
 *
 * Story 8.7 (S4): craft docs are long docs → summary layer (curated /
 * generated one-liner + body-hash fingerprint cache, `docSummary.ts`) + dual
 * vector (#body full text + #identity name+type+summary, design §1.3).
 */

/**
 * Read the current `closure_craft_vec` embedding dimension from the live schema
 * (mirror of `getCurrentVecDim` for the craft table). null when the table is
 * absent (vec extension not loaded, or not yet created).
 */
export function getCurrentCraftVecDim(db: Database.Database): number | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='closure_craft_vec'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql) return null;
  const m = row.sql.match(/float\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

/**
 * Dependency-injection seam (mirrors closureIndexer.ReindexDeps). Tests pass
 * stubs so the DB-integration suite runs (under the Electron ABI) with ZERO
 * network - no real embed / summary endpoint is hit.
 */
export type CraftReindexDeps = {
  /** Resolve the embedding model; null -> FTS-only (pending_embed). Defaults to resolveEmbeddingModel. */
  resolveModel?: () => ResolvedModel | null;
  /** Embed a single body string -> vector. Defaults to a generateEmbeddings wrapper. */
  embed?: (model: ResolvedModel, body: string) => Promise<number[]>;
  /** Resolve the summary model (Story 8.7 §3.1); null -> no LLM summary (graceful).
   *  Defaults to resolveSummaryModel. */
  resolveSummaryModel?: () => ResolvedModel | null;
  /** Generate a one-line summary for a body (Story 8.7 §3.1). Defaults to a
   *  generateText wrapper. */
  generateSummary?: (model: ResolvedModel, body: string) => Promise<string>;
  /** Bypass the content-hash skip (reindexAllCraft on a model/dim swap). Default false. */
  force?: boolean;
};

/**
 * Default embed: one generateEmbeddings call, return the first vector. 30s
 * `AbortSignal.timeout` (mirror closureIndexer.defaultEmbed CR-06).
 */
async function defaultEmbed(model: ResolvedModel, body: string): Promise<number[]> {
  const res = await generateEmbeddings(model, { input: [body] }, { signal: AbortSignal.timeout(30_000) });
  return res.embeddings[0] ?? [];
}

/**
 * Reindex a single craft md doc into the derived `closure_craft_*` index.
 * Idempotent + content-hash aware (unchanged body -> no-op). Best-effort
 * embedding: no model / failure / dim-mismatch -> FTS-only (pending_embed). Never
 * throws on embed failure (logs + degrades); db write errors propagate.
 *
 * @param filePath  absolute path to the craft md doc.
 * @param sourceKind 'bundled' (read-only seed) or 'user' (writable override).
 */
export async function reindexCraftDoc(
  filePath: string,
  sourceKind: 'bundled' | 'user',
  deps: CraftReindexDeps = {},
): Promise<void> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const resolveSummary = deps.resolveSummaryModel ?? resolveSummaryModel;
  const generateSummary = deps.generateSummary ?? defaultGenerateSummary;
  const db = getDb();
  const vecDim = getCurrentCraftVecDim(db);

  // 1. Read + parse the craft md doc (source of truth).
  const fileName = path.basename(filePath);
  const content = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseCraftMd(content);
  const craftId = deriveCraftId(fileName, frontmatter);
  // CR-craft-kb-007: an empty craft_id (`.md` filename + no frontmatter id) is
  // a legal TEXT PK and would collide with every other empty-id doc. The scan
  // path (listCraftMdFiles) already filters these, but a direct reindexCraftDoc
  // call (e.g. a targeted watcher event) must also skip + warn, never index.
  if (!craftId) {
    getLogger().warn(
      { filePath },
      'craft reindex: doc derives to an empty craft_id - skipping (no stable PK)',
    );
    return;
  }
  const craftType = frontmatter.craft_type ?? 'uncategorized';
  const name = extractCraftName(body) ?? craftId;
  const bodyText = body;
  // CR-craft-kb-012: persist frontmatter tags (JSON array) + source (provenance).
  const tagsJson = frontmatter.tags ? JSON.stringify(frontmatter.tags) : null;
  const sourceText = frontmatter.source ?? null;

  // 2. Content hash for diff/skip. CR-craft-kb-005: the hash includes the
  //    FRONTMATTER (id / craft_type / source / tags), not just bodyText, so a
  //    frontmatter-only edit (e.g. reclassifying craft_type) triggers a reindex
  //    instead of silently leaving a stale craft_type in closure_craft_entry.
  //    ⚠️ Story 8.7 S1 correction (design §3.1): this payload is a FIXED field
  //    list (NOT the whole frontmatter), so `summary` must be added EXPLICITLY —
  //    a curated-summary-only edit now reindexes too (the stored summary_text +
  //    identity vector must not go stale).
  const hashPayload = JSON.stringify({
    id: craftId,
    craft_type: craftType,
    source: sourceText,
    tags: frontmatter.tags ?? [],
    summary: frontmatter.summary ?? null,
    body: bodyText,
  });
  const hash = createHash('sha256').update(hashPayload).digest('hex');

  // 3. Content-hash skip: body unchanged AND a vector landed -> FTS fresh, vec
  //    preserved. A pending_embed entry (null hash) is retried. `force`
  //    (reindexAllCraft) bypasses the skip on a model/dim swap.
  const existing = db
    .prepare(
      'SELECT content_hash, summary_text, summary_source, summary_hash FROM closure_craft_entry WHERE craft_id=?',
    )
    .get(craftId) as
    | {
        content_hash: string | null;
        summary_text: string | null;
        summary_source: string | null;
        summary_hash: string | null;
      }
    | undefined;
  if (!deps.force && existing?.content_hash === hash) return;

  // 4. Summary resolution (Story 8.7 §3.1) — ASYNC, OUTSIDE any transaction,
  //    best-effort (mirror the embed call): curated frontmatter value → cached
  //    generated value (body-hash fingerprint) → one LLM generate. No model /
  //    failure → columns empty (retrieval unaffected).
  const summary = await resolveDocSummary({
    curated: frontmatter.summary,
    body: bodyText,
    existing,
    resolveModel: resolveSummary,
    generateSummary,
    logLabel: 'craft reindex',
  });

  // 5. Embeds — body + identity dual vector (Story 8.7 §3.2 / design §1.3; craft
  //    docs are all long docs), ASYNC, OUTSIDE any transaction, best-effort.
  //    Mirror closureIndexer model-consistency gate (CR-02): refuse to embed
  //    under a model that differs from the craft KB's prevailing vector-space
  //    model. 两向量同生共死: a failure of EITHER clears both (pending_embed
  //    semantics unchanged).
  let bodyVec: number[] | null = null;
  let identityVec: number[] | null = null;
  let modelId: string | null = null;
  const model = resolveModel();
  const identityText = buildIdentityText(name, craftType, summary.text);

  let modelMismatch = false;
  if (model && bodyText.trim() && !deps.force) {
    const prevailingRow = db
      .prepare('SELECT model FROM closure_craft_entry WHERE model IS NOT NULL LIMIT 1')
      .get() as { model: string } | undefined;
    const prevailingModel = prevailingRow?.model ?? null;
    if (shouldSkipForModelMismatch(prevailingModel, model.modelId)) {
      modelMismatch = true;
      getLogger().warn(
        { craftId, prevailingModel, resolvedModel: model.modelId },
        'craft reindex: model mismatch (prevailing vs resolved) - FTS-only; run reindexAllCraft to migrate',
      );
    }
  }

  if (model && bodyText.trim() && !modelMismatch) {
    try {
      const bodyArr = await embed(model, bodyText);
      if (vecDim !== null && bodyArr.length === vecDim) {
        bodyVec = bodyArr;
      } else {
        getLogger().warn(
          { craftId, expected: vecDim, got: bodyArr.length, model: model.modelId },
          'craft reindex: body embedding dim mismatch - FTS-only',
        );
      }
      if (bodyVec && identityText.trim()) {
        const idArr = await embed(model, identityText);
        if (vecDim !== null && idArr.length === vecDim) {
          identityVec = idArr;
        } else {
          getLogger().warn(
            { craftId, expected: vecDim, got: idArr.length, model: model.modelId },
            'craft reindex: identity embedding dim mismatch - FTS-only',
          );
          bodyVec = null; // all-or-nothing (同生共死)
        }
      }
      if (bodyVec && identityVec) modelId = model.modelId;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), craftId },
        'craft reindex: embed failed - FTS-only',
      );
      bodyVec = null;
      identityVec = null;
    }
  }

  // 6. Single WAL transaction: closure_craft_entry upsert (trigger syncs
  //    closure_craft_fts) + closure_craft_vec delete-then-insert (both vector
  //    kinds). vec0 gated on the sqlite-vec extension being loaded.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO closure_craft_entry
         (craft_id, craft_type, source_kind, name, body_text, tags, source,
          summary_text, summary_source, summary_hash, content_hash, model, dim, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(craft_id) DO UPDATE SET
         craft_type=excluded.craft_type,
         source_kind=excluded.source_kind,
         name=excluded.name,
         body_text=excluded.body_text,
         tags=excluded.tags,
         source=excluded.source,
         summary_text=excluded.summary_text,
         summary_source=excluded.summary_source,
         summary_hash=excluded.summary_hash,
         content_hash=excluded.content_hash,
         model=excluded.model,
         dim=excluded.dim,
         updated_at=datetime('now')`,
    ).run(
      craftId,
      craftType,
      sourceKind,
      name,
      bodyText,
      tagsJson,
      sourceText,
      summary.text,
      summary.source,
      summary.hash,
      // pending_embed: write the hash ONLY when the full vector set landed
      // (mirror CR-03; dual-vector = both vectors, all-or-nothing).
      bodyVec && identityVec ? hash : null,
      modelId,
      bodyVec && identityVec ? bodyVec.length : null,
    );

    // CR-craft-kb-009: ALWAYS delete the existing closure_craft_vec rows for
    // this craft_id (even when the vectors failed / mismatched), THEN insert
    // only when fresh vectors landed. Without the unconditional delete, a
    // transient embed failure on an EDITED doc would leave a stale vector that
    // KNN-matches OLD content JOINed to the NEW body_text just written above.
    // Story 8.7 §1.3: the delete is by craft_id (ALL vector kinds — #body +
    // #identity), the multi-vector PK is vector_id. Gated on the vec extension
    // so a no-vec build skips cleanly.
    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(craftId);
      if (bodyVec && identityVec) {
        const insertVec = db.prepare(
          `INSERT INTO closure_craft_vec (vector_id, craft_id, craft_type, source_kind, vector_kind, embedding)
           VALUES (?,?,?,?,?,?)`,
        );
        insertVec.run(
          `${craftId}#body`,
          craftId,
          craftType,
          sourceKind,
          'body',
          floatArrayToBuffer(bodyVec),
        );
        insertVec.run(
          `${craftId}#identity`,
          craftId,
          craftType,
          sourceKind,
          'identity',
          floatArrayToBuffer(identityVec),
        );
      }
    }
  })();
}

/**
 * Remove a craft doc's derived index rows. closure_craft_entry delete fires the
 * AFTER DELETE trigger (clears closure_craft_fts); closure_craft_vec delete is
 * gated on the vec extension and removes ALL of the doc's vector kinds (#body +
 * #identity — Story 8.7 multi-vector, WHERE craft_id covers both rows). Single
 * transaction keeps the three faces consistent.
 */
export function reindexCraftDelete(craftId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM closure_craft_entry WHERE craft_id=?').run(craftId);
    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(craftId);
    }
  })();
}

/**
 * Rebuild the ENTIRE craft vector index under the resolved embedding model
 * (mirror of `reindexAll` - Path B model swap). vec0 dim is fixed at CREATE time;
 * a dim change DROPs + reCREATEs `closure_craft_vec`. Re-embeds every craft doc
 * (force=true bypasses the hash skip). Unlike single-doc `reindexCraftDoc`, this
 * REQUIRES a configured embedding model (the user explicitly asked to switch).
 *
 * @returns `reindexed` (success count), `dimChanged`, `newDim` (null when no docs).
 */
export async function reindexAllCraft(
  deps: CraftReindexDeps = {},
): Promise<{ reindexed: number; dimChanged: boolean; newDim: number | null }> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const resolveSummary = deps.resolveSummaryModel ?? resolveSummaryModel;
  const generateSummary = deps.generateSummary ?? defaultGenerateSummary;
  const db = getDb();

  const model = resolveModel();
  if (!model) {
    throw new Error('reindexAllCraft: no embedding model configured - cannot rebuild vector index');
  }

  const files = listCraftMdFiles();
  if (files.length === 0) {
    return { reindexed: 0, dimChanged: false, newDim: null };
  }

  // Probe the new model's dim by embedding the first non-empty body.
  let probeBody = 'probe';
  for (const f of files) {
    try {
      const content = readFileSync(f.filePath, 'utf-8');
      const { body } = parseCraftMd(content);
      if (body.trim()) {
        probeBody = body;
        break;
      }
    } catch {
      // skip unreadable file
    }
  }
  let newDim: number;
  try {
    const probeVec = await embed(model, probeBody);
    newDim = probeVec.length;
  } catch (err) {
    throw new Error(
      `reindexAllCraft: embedding probe failed - cannot determine new model dim: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Dim change -> DROP + reCREATE closure_craft_vec at the new dim. CR-craft-kb-010:
  // ALSO recreate when the vec table is ABSENT while sqlite-vec IS loaded
  // (currentDim===null). Previously the DROP+CREATE branch only ran when
  // `currentDim !== null`, so a missing vec table (e.g. sqlite-vec loaded after
  // the table was never created, or a prior DROP without reCREATE) was never
  // rebuilt -> reindexAllCraft silently completed FTS-only. Recreate at the probe
  // dim so the subsequent per-doc reindex lands vectors.
  //
  // ⚠️ Story 8.7 S4 (implement.md S2 coordination note): the inline CREATE MUST
  // stay field-identical to initSchema's multi-vector DDL (vector_id PK /
  // craft_id / craft_type / source_kind / vector_kind). A stale single-vector
  // CREATE here would flip-flop with the initSchema migration and silently drop
  // all vectors on every rebuild. `getCurrentCraftVecDim`'s float[N] parsing is
  // structure-agnostic (unchanged).
  const currentDim = getCurrentCraftVecDim(db);
  const vecAvailable = isSqliteVecAvailable();
  const dimChanged = vecAvailable && currentDim !== null && newDim !== currentDim;
  const vecMissing = vecAvailable && currentDim === null;
  if (dimChanged || vecMissing) {
    db.exec('DROP TABLE IF EXISTS closure_craft_vec');
    db.exec(
      `CREATE VIRTUAL TABLE closure_craft_vec USING vec0(
        vector_id TEXT PRIMARY KEY,
        craft_id TEXT,
        craft_type TEXT,
        source_kind TEXT,
        vector_kind TEXT,
        embedding float[${newDim}] distance_metric=cosine
      )`,
    );
    getLogger().info(
      { oldDim: currentDim, newDim, reason: vecMissing ? 'missing-recreate' : 'dim-change' },
      'craft reindexAllCraft: closure_craft_vec recreated',
    );
  }

  // Re-embed every craft doc (force=true bypasses the hash skip — body unchanged
  // but the dual vectors must regenerate under the new model; the summary
  // fingerprint cache still suppresses redundant summary LLM calls).
  let reindexed = 0;
  for (const { filePath, sourceKind } of files) {
    try {
      await reindexCraftDoc(filePath, sourceKind, {
        resolveModel: () => model,
        embed,
        resolveSummaryModel: resolveSummary,
        generateSummary,
        force: true,
      });
      reindexed++;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), filePath },
        'craft reindexAllCraft: per-doc reindex failed - continuing',
      );
    }
  }

  return { reindexed, dimChanged, newDim };
}

/**
 * Scan both craft KB dirs (bundled + user, user-priority merge), diff against the
 * indexed set, and incrementally reindex new/changed docs + delete orphans
 * (mirror of the on-save reindex hook, but for the global craft dir). Best-effort:
 * per-doc failures are logged + skipped so one bad doc never aborts the scan.
 * Called fire-and-forget on app startup (never block app launch on a reindex).
 */
export async function scanAndReindexCraftKb(deps?: CraftReindexDeps): Promise<void> {
  const db = getDb();
  const files = listCraftMdFiles();
  const scannedCraftIds = new Set(files.map((f) => f.craftId));

  // Delete orphans: indexed craft_ids no longer present on disk.
  let indexed: Array<{ craft_id: string }>;
  try {
    indexed = db.prepare('SELECT craft_id FROM closure_craft_entry').all() as Array<{ craft_id: string }>;
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'craft KB scan: cannot enumerate indexed docs - skipping orphan cleanup',
    );
    indexed = [];
  }
  for (const { craft_id } of indexed) {
    if (!scannedCraftIds.has(craft_id)) {
      try {
        reindexCraftDelete(craft_id);
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), craftId: craft_id },
          'craft KB scan: orphan delete failed - continuing',
        );
      }
    }
  }

  // Reindex new/changed docs (hash-skip makes unchanged docs a no-op).
  for (const { filePath, sourceKind } of files) {
    try {
      await reindexCraftDoc(filePath, sourceKind, deps);
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), filePath },
        'craft KB scan: reindex failed - continuing',
      );
    }
  }
}

// Re-export EMBED_DIM for craft tests that build unit 1024-dim vectors (mirror
// closureIndexer.EMBED_DIM usage in closureRetrieval.test.ts).
export { EMBED_DIM };
