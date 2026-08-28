import { compileSettingPrefix, type PinnedPrefixItem, type SettingPrefixInput } from './setting-prefix';
import type { EntryHit } from './closure-retrieval';
import type { CraftHit } from './closure-craft-retrieval';

// ── Story 2.3 设定喂 LLM 工程：动态后缀格式化器 + 顶层 compileSettingContext（design §3.3 / §3.4）──
//
// 范式判据（ADR-5 / .trellis/spec/core/creative-vs-mechanical）：本文件只做 **shaping**（把已检索
// 结果格式化成动态后缀布局块），**不做 retrieval 决策**（检索什么）。ADR-5 已决断动态后缀 = Writer
// tool-call 按需拉取（query_story / query_craft 工具，非 pre-fetch）；本函数只 shaping Writer 已
// tool-call 拉回的 EntryHit[] / CraftHit[]，不决定检索策略。别把「检索什么」逻辑写进这里。
//
// 纯函数（无 fs / db / LLM）-> 可 plain vitest 单测。落点 shared-contracts（design §5 / §6）：复用
// closure-retrieval 的 EntryHit + closure-craft-retrieval 的 CraftHit（**不重定义**，避类型漂移）+
// setting-prefix 的 compileSettingPrefix / PinnedPrefixItem（Step 2）。
//
// craft hit 是 **独立类型 CraftHit**（closure-craft-retrieval.ts：craftId/craftType，无 projectId/
// visibility），非 EntryHit。design/implement.md 写 `hits: EntryHit[]` 是 craft 未分立前的简化写法；
// 实施时按 dispatch 指引「craft hit 有独立类型 -> 用 kind:'craft' 分支处理」。这里用 **函数 overload**
// 把 kind 与 hit 类型绑定（kind:'story' -> EntryHit[]，kind:'craft' -> CraftHit[]），两类型均复用不重
// 定义，且编译期防 kind/hit 错配（传 craftHits 给 kind:'story' = type error）。
//
// layout 是 **结构契约标记**（design §3.3/§3.4：stable-prefix -> cache breakpoint -> dynamic-suffix），
// 供 Epic 4.1 消费；**非**实际 prompt cache breakpoint 注入（breakpoint 实际注入 / provider
// cache_control wiring = Epic C3，AC 明确 defer）。本 story 拥有汇编布局（质量层），caching 机制 defer。

/**
 * 动态后缀单条 hit 正文摘录上限（design §3.3 shaping）。body 超此 -> 截断 + 「可经 query_* 取全文」
 * 指针（ADR-5 tool-call 按需拉取：摘录入后缀，全文经再次 query_story / query_craft 取）。design 未钉
 * 具体数值；1000 字符兼顾「传达设定要义」+「bound 后缀」（k 上限 50 时最坏 ~50K 字符 ~14K token，
 * 可接受）。导出供单测 + 调用方知摘录规模。
 */
export const SUFFIX_BODY_EXCERPT_LIMIT = 1000;

/**
 * 结构布局契约标记（design §3.3 / §3.4）：stable-prefix -> cache breakpoint -> dynamic-suffix。
 * **非**实际 prompt cache breakpoint 注入（breakpoint 实际注入 / provider cache_control wiring =
 * Epic C3，AC 明确 defer）；本字段是「布局契约」文档化标记，供 Epic 4.1 消费（4.1 据 layout 契约把
 * stablePrefix 注 session.pinnedContext + 在 breakpoint 后注入 dynamicSuffix）。
 */
export const SETTING_CONTEXT_LAYOUT = 'prefix|breakpoint|suffix' as const;

/** 布局契约标记类型（= SETTING_CONTEXT_LAYOUT 字面量）。 */
export type SettingContextLayout = typeof SETTING_CONTEXT_LAYOUT;

/**
 * `compileSettingContext` 顶层汇编结果（design §3.4）。
 *
 * - `stablePrefix`：稳定前缀（核心设定，cacheable）-- `compileSettingPrefix` 产出；agent 侧薄包装转
 *   `PinnedContextItem[]`（Epic 4.1 wiring）。
 * - `dynamicSuffix`：动态后缀（per-scene 检索结果 shaping）-- story + craft 拼接，空则省；breakpoint
 *   后注入（C3 wiring）。
 * - `layout`：布局契约标记（非实际 cache breakpoint 注入；C3）。
 */
export type SettingContextAssembly = {
  stablePrefix: PinnedPrefixItem[];
  dynamicSuffix: string;
  layout: SettingContextLayout;
};

/** kind -> 检索工具名（截断指针「可经 query_* 取全文」标记用）。 */
const TOOL_BY_KIND = {
  story: 'query_story',
  craft: 'query_craft',
} as const;

/**
 * 截断 body：超 `SUFFIX_BODY_EXCERPT_LIMIT` -> 截断 + 「可经 query_* 取全文」指针（kind 决定工具名）；
 * 否则原样返回。空 body -> ''（调用方据空省略 body 行）。
 */
function excerptBody(bodyText: string, kind: 'story' | 'craft'): string {
  if (bodyText.length <= SUFFIX_BODY_EXCERPT_LIMIT) return bodyText;
  const tool = TOOL_BY_KIND[kind];
  return `${bodyText.slice(0, SUFFIX_BODY_EXCERPT_LIMIT)}\n[...可经 ${tool} 取全文]`;
}

/**
 * 把 query_story / query_craft 的检索结果格式化成动态后缀布局块（design §3.3）。**只 shaping 已检索
 * 结果，不做 retrieval 决策**（ADR-5：动态后缀 = Writer tool-call 按需拉取，非 pre-fetch；本函数不决
 * 定「检索什么」）。
 *
 * 每条 hit -> `### {name} [{type}/{sourceKind}]` + body 摘录（过长截断 + 「可经 query_* 取全文」指针；
 * body 为空则只留 header）。空 hits -> ''（`compileSettingContext` 据此省略空块）。
 *
 * - `kind: 'story'` 接 `EntryHit[]`（query_story，项目设定；bracket 用 `entryType`）。
 * - `kind: 'craft'` 接 `CraftHit[]`（query_craft，全局 craft 参考；bracket 用 `craftType`）。
 *
 * 两类型字段名异（entryType vs craftType；EntryHit 有 projectId/visibility，CraftHit 无），故用 overload
 * 把 kind 与 hit 类型绑定（避 kind/hit 错配；两类型均复用，不重定义）。
 */
export function formatRetrievedSettings(hits: EntryHit[], kind: 'story'): string;
export function formatRetrievedSettings(hits: CraftHit[], kind: 'craft'): string;
export function formatRetrievedSettings(hits: EntryHit[] | CraftHit[], kind: 'story' | 'craft'): string {
  if (hits.length === 0) return '';
  const blocks = hits.map((hit) => {
    // name / sourceKind / bodyText 两类型共有，直接读；type 标签字段异（entryType vs craftType）按 kind 取。
    const typeLabel = kind === 'story' ? (hit as EntryHit).entryType : (hit as CraftHit).craftType;
    const header = `### ${hit.name} [${typeLabel}/${hit.sourceKind}]`;
    const body = excerptBody(hit.bodyText, kind);
    return body ? `${header}\n${body}` : header;
  });
  return blocks.join('\n\n');
}

/**
 * 顶层设定上下文汇编（design §3.4）：组合稳定前缀（`compileSettingPrefix`）+ 动态后缀
 * （`formatRetrievedSettings` story + craft 拼接，空则省）+ 布局契约标记。纯函数（无 fs / db / LLM）。
 *
 * 供 Epic 4.1 消费：4.1 把 `stablePrefix` 注 `session.pinnedContext`（agent 侧薄包装转
 * `PinnedContextItem[]`）+ `dynamicSuffix` 作 tool-call 结果 shaping + 按 `layout` 契约在 breakpoint
 * 后注入后缀（breakpoint 实际注入 = Epic C3）。
 *
 * @param projectDocument     loaded ProjectDocument（或其 3 字段子集 `SettingPrefixInput`）；稳定前缀源。
 * @param retrievedStoryHits  query_story 检索结果（`undefined` = 未检索 -> 省；`[]` = 检索空 -> 省）。
 * @param retrievedCraftHits  query_craft 检索结果（同上）。
 * @returns  `SettingContextAssembly`（stablePrefix + dynamicSuffix + layout 契约标记）。
 */
export function compileSettingContext(
  projectDocument: SettingPrefixInput,
  retrievedStoryHits?: EntryHit[],
  retrievedCraftHits?: CraftHit[],
): SettingContextAssembly {
  const stablePrefix = compileSettingPrefix(projectDocument);
  const storySuffix = retrievedStoryHits ? formatRetrievedSettings(retrievedStoryHits, 'story') : '';
  const craftSuffix = retrievedCraftHits ? formatRetrievedSettings(retrievedCraftHits, 'craft') : '';
  const dynamicSuffix = [storySuffix, craftSuffix].filter((s) => s.length > 0).join('\n\n');
  return { stablePrefix, dynamicSuffix, layout: SETTING_CONTEXT_LAYOUT };
}
