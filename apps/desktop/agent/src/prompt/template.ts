import { logger } from '../logger';

// ── Story 4.0 写章战术链段：yaml user 段 {{var}} 模板渲染（design §4.5 / implement.md 1.2）──
//
// OrisonSpace `prompt/render.ts` 的 buildSystemPrompt 只做字符串拼接，无模板渲染——yaml prompts
// 的 `{{chapterTask}}` / `{{storyPlan}}` 等 user 段占位空转（spec 自述）。本函数首次消费 yaml user
// 段 `{{var}}`（AC「yaml `{{var}}` 首次被消费」），让 LLM 节点（createLlmNode，Step 2）能注入上游
// artifact 编译的 vars。
//
// 范围（design §4.5）：yaml 仅用 `{{var}}`（无 mustache section `{{#}}`/`{{^}}`/`{{/}}`），简单正则
// 替换即可——不做完整 mustache。若未来 yaml 需要 section，再扩（落地公理：先证需求）。
//
// 落点 `prompt/template.ts`（与 render.ts 同目录，design §4.5）。纯函数（无 fs/db/LLM）——可 plain
// vitest 单测。
//
// expected_downstream_consumers:
// - Story 4.0 Step 2：createLlmNode.run() = buildPrompt(run) → renderTemplate(userTemplate, vars) →
//   runSubagent(role, renderedPrompt)。
// - 所有未来 yaml-consuming 节点（retrieval 4.5 / 灰区裁决器 4.6 / 等）。

/**
 * yaml user 段 `{{var}}` 占位 → vars[key] 替换。
 *
 * - 命中 var：替换为 `vars[key]`（provided 空串合法替换，不 warn）。
 * - missing var（vars 无该 key）：替换为空串 + `logger.warn`——便于 debug（节点 buildPrompt 漏传
 *   var 时 prompt 会出现空 `{}`，早暴露而非静默产畸形 prompt 调用 LLM）。
 * - `{{ key }}`（带空格）不替换——`\w+` 不匹配空格。yaml 约定无空格（design §4.5 信实）。
 *
 * @param template  yaml user 段原文（含 `{{var}}` 占位）
 * @param vars      buildPrompt 从 run.artifacts 抽出的 vars
 * @returns  渲染后的 prompt（所有 `{{var}}` 替换为值或空串，不残留字面 `{{...}}`）
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key] ?? '';
    }
    logger.warn({ key }, 'renderTemplate: missing var replaced with empty string');
    return '';
  });
}
