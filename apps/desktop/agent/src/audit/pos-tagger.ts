// Chinese POS tagger — @node-rs/jieba native binding wrapper (Story 4.2 Step 1).
//
// 范式判据 (ADR-3 / .trellis/spec/core/creative-vs-mechanical.md): POS tagging is
// deterministic tokenization (DAG + HMM) + lexicon-based tag lookup — a pure-code
// utility, NOT semantic judgement. The tagger never decides "is this sentence good
// / bad / contradictory / AI-flavored" — that is L2 LLM (createReaderAuditNode,
// Step 5). This wrapper only produces {token,pos}[] for the L1 stylometry layer
// (Step 2, shared-contracts/stylometry.ts) to compute POS-gram skeleton repetition
// + CR:PoS compression signals.
//
// Native binding: @node-rs/jieba 2.0.1 (NAPI-RS, pre-built platform binaries).
// Unlike better-sqlite3 (node-gyp native addon, needs electron-rebuild for
// Electron's V8 ABI), NAPI-RS binaries are ABI-stable via Node-API and load in
// Electron WITHOUT rebuild. Packaging is handled by electron-builder's
// `asarUnpack: ["**/*.node"]` glob (same mechanism as @photostructure/sqlite-vec),
// so the platform .node file is unpacked from the asar and loadable at runtime.
// Verified: pnpm rebuild:native (electron-rebuild better-sqlite3) still passes with
// @node-rs/jieba present — the two native modules coexist without conflict.
//
// Why the wrapper lives in @orison/desktop-agent (not shared-contracts):
// shared-contracts carries no native runtime deps (only zod). The native binding
// must live in a package that participates in electron-rebuild / packaging, so it
// rides alongside better-sqlite3 in the agent (which the shell pulls into Electron).
// The contract TYPE (PosTag / TagChineseFn) lives in shared-contracts/stylometry.ts
// and is imported here as a type-only dep (erased at runtime — no native cycle).
//
// Graceful degradation (same pattern as agent/persistence.ts better-sqlite3 load):
// if the native binding fails to load at runtime (unsupported arch / packaging
// glitch), isPosTaggerAvailable() returns false and tagChinese() returns []. Step 2
// L1 checks isPosTaggerAvailable() and skips POS-gram/CR:PoS when false (design §10
// rollback: the other 7 non-POS signals still run). Reader-Audit degrades gracefully
// — losing POS signals costs detection quality but never crashes the chain.

import { createRequire } from 'node:module';
import type { PosTag, TagChineseFn } from '@orison/shared-contracts';

// Minimal structural types for the @node-rs/jieba API surface we consume.
// (Avoids importing the generated .d.ts which pulls @ts-nocheck auto-gen noise.)
interface JiebaTagger {
  /** Tag the input text; returns word + POS tag per segmented token. `hmm` enables HMM for OOV (names, neologisms). */
  tag(text: string, hmm?: boolean): Array<{ word: string; tag: string }>;
}
interface JiebaCtor {
  /** Create a Jieba instance with the default dict loaded (required for word-level segmentation + proper POS tags). */
  withDict(dict: Uint8Array): JiebaTagger;
}
interface JiebaModule {
  Jieba: JiebaCtor;
}
interface DictModule {
  dict: Uint8Array;
}

// Lazy-loaded singleton — dict parse (~5MB) is non-trivial, so we construct one
// Jieba instance per process and reuse. `loadAttempted` guarantees the binding
// load is attempted at most once (failures don't retry every call).
let jiebaInstance: JiebaTagger | null = null;
let loadAttempted = false;
let loadAvailable = false;

/**
 * Load (and cache) the Jieba singleton with the default dict.
 *
 * Idempotent: subsequent calls return the cached instance (or null if the first
 * attempt failed). Returns null on any failure — callers must handle null.
 */
function loadJieba(): JiebaTagger | null {
  if (loadAttempted) return jiebaInstance;
  loadAttempted = true;
  try {
    const require = createRequire(import.meta.url);
    const { Jieba } = require('@node-rs/jieba') as JiebaModule;
    const { dict } = require('@node-rs/jieba/dict') as DictModule;
    // Jieba() (no-arg ctor) creates an instance with an EMPTY dict — segmentation
    // degrades to per-character + every tag is 'x'. withDict(dict) loads the
    // default dictionary so segmentation is word-level and POS tags are real.
    jiebaInstance = Jieba.withDict(dict);
    loadAvailable = true;
    return jiebaInstance;
  } catch {
    // Native binding unavailable (missing platform binary / arch mismatch /
    // packaging issue). Degrade: POS signals skipped by Step 2 L1 per contract.
    jiebaInstance = null;
    loadAvailable = false;
    return null;
  }
}

/**
 * Whether a POS tagger native binding is available in this process.
 *
 * Step 2's L1 layer checks this before computing POS-gram / CR:PoS signals; when
 * false, those two POS-dependent signals are skipped (design §10 rollback) and the
 * other 7 non-POS signals (sentence-length variance, lexical diversity, cliché
 * ratio, crutch/filter density, punctuation rhythm, CR-words, storyTime fold)
 * still run.
 *
 * Calling this triggers the one-time binding load (dict parse) on the first call;
 * subsequent calls are O(1).
 */
export function isPosTaggerAvailable(): boolean {
  if (!loadAttempted) loadJieba();
  return loadAvailable;
}

/**
 * Chinese POS tagging — @node-rs/jieba native binding (Story 4.2 Step 1).
 *
 * Deterministic tokenization (DAG + HMM for OOV) + lexicon POS tagging (ICTCLAS
 * tagset — Chinese Penn Treebank family: n/v/a/d/r/p/u/x/f/s/z/t/m/q/c/uj/ul/nr/ns/...).
 * Pure-code utility, NOT semantic judgement (ADR-3): produces {token,pos}[] only.
 *
 * Maps jieba's {word, tag} → our contract {token, pos} naming (token is the
 * standard tokenization term; pos is the standard POS term — clearer than jieba's
 * field names for downstream stylometry consumers).
 *
 * Degradation: native binding unavailable → returns [] (Step 2 L1 skips
 * POS-dependent signals per isPosTaggerAvailable(), never crashes the chain).
 *
 * @param text Chinese prose (e.g. draft.initial.text, or a sub-segment)
 * @returns    {token, pos}[] in segmentation order; empty/whitespace input → [];
 *             binding unavailable → []
 */
export const tagChinese: TagChineseFn = (text: string): PosTag[] => {
  if (!text) return [];
  const jieba = loadJieba();
  if (!jieba) return [];
  // hmm=true enables HMM for OOV words (character names, neologisms) — default
  // jieba behavior, produces better segmentation for prose than hmm=false.
  //
  // E1（CR patch, belt-and-suspenders）：loadJieba 已包加载期错误，但运行时 tag() 抛错（native panic /
  // encoding glitch）会直穿。包 try/catch → 返 [] 降级（never crashes the chain）。chain-nodes E1 外层
  // computeL1SignalReport try/catch 是第二道防线；此处是 tagger 内部第三道。
  try {
    return jieba.tag(text, true).map(({ word, tag }) => ({ token: word, pos: tag }));
  } catch {
    return [];
  }
};
