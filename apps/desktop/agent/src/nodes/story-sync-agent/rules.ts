// Story 6.5（design §10 D10 / R6 / AC7 story-sync 防线）：foreshadow prose 提取**已移除**。
//
// 旧逻辑（FORESHADOW_CUES 词命中 → foreshadow_registry merge patch）随 foreshadow_registry → promise_registry
// 改名 + Promise 涌现走独立 promise-emergence-node（LLM 语义登记，非 prose 机械词提取）而废弃。CR-E7
// track-conflation 防线（mirror 6.1 InfoReleaseMap）：**promise_registry 不进 story-sync prompt/rules**
// （目标轨/读者债不应从正文 prose-extracted；涌现登记是 LLM 语义判断走 promise_ledger_update builtin）。
//
// story-sync-agent 收缩为「LLM patches 透传（defensive，4.0 链段无上游产 llmPatches 但保留 dispatcher）+
// 空 rules 兜底」。rules 路径现无提取规则（foreshadow 已移除 + promise 不走此处）→ 返空 patches。函数
// shape 保留作未来非读者债规则 hook（如 prose → 非 creative-field 派生数据）。
//
// 范式判据（ADR-3）：storySync rules = 纯代码规则节点（词命中 → patch）。现无规则 = 返空（非造假、非抛错）。

export interface StorySyncRuleInput {
  chapterId: string;
  content: string;
  chapterNumber: number;
}

export interface StorySyncRulePatch {
  field: string;
  action: string;
  data: unknown;
  fieldVersion: number;
  generatedBy: string;
}

/**
 * story-sync rules 路径（foreshadow 提取已移除，现返空 patches）。
 *
 * Story 6.5 后无 prose → creative-field 提取规则（promise_registry 走 promise-emergence-node 非此处；
 * foreshadow_registry 已废弃）。返空 patches = 本章无 story-sync 规则提取（story.sync artifact 仍产，
 * patches 为空）。未来若加非读者债规则（如 prose 派生数据），在此扩。
 */
export function deriveStorySyncByRules(_input: StorySyncRuleInput): { patches: StorySyncRulePatch[] } {
  return { patches: [] };
}
