import type { GenerationMessage } from '@orison/shared-contracts';

export type StorySyncPromptInput = {
  runId: string;
  chapterId: string;
  candidate: Record<string, unknown>;
  context: Record<string, unknown>;
};

const STORY_SYNC_SYSTEM_PROMPT = `你是 story-sync-agent，负责从已生成章节中提取需要同步回项目创作字段的"最小安全补丁"。

你必须只输出 JSON，不要输出 Markdown、解释或代码块。
输出 JSON 结构必须是：
{
  "runId": string,
  "chapterId": string,
  "patches": [
    {
      "field": "asset_cards" | "relationship_graph" | "world_setting" | "outline" | "growth_curve" | "pacing_curve" | "emotion_curve" | "creative_brief" | "scene_graph",
      "action": "merge",
      "data": object,
      "fieldVersion": number,
      "generatedBy": "story-sync-agent"
    }
  ],
  "summary": string
}

规则：
1. 只生成有明确章节证据支持的补丁；不确定则 patches=[]。
2. 只使用 action="merge"，不要 set/delete，避免覆盖 locked 内容。
3. 只能使用上方枚举的字段（episode_outlines 不在其中——情节大纲是上游规划数组字段，prose→大纲回收非 story-sync 职域，产出会被投影层拒绝）。
4. fieldVersion 必须使用上下文中对应字段的当前 version；找不到则使用 0。
5. 优先提取道具、身份线索、关系变化；不要改写章节正文。
6. data 必须是可 merge 的对象。
7. promise_registry（读者债账本）不得从此处提取——Promise 涌现登记走独立的 promise-emergence-node（LLM 语义判定 perspective gap → 登记），非 prose 机械词提取（track-conflation 防线）。
8. 状态变化（等级提升/伤势/位置/情绪/关系温度）**禁止提取**——它们归世界状态引擎五轴（world_state 事件溯源）管，此处再收录 = 双真相源漂移。卡只收**结构性设定**：新实体首次登记（新势力/新角色/新道具出场/建筑首次登场 → 建卡）、规则确立（金手指新规则/世界新规则首次明确）、定义性变化（既有卡所述定义被正文改写）。relationship_graph 同理只收结构性关系（新阵营对立/同盟确立），关系温度变化归 world_state 关系轴。`;

/**
 * The story-sync system prompt, exported for the agent-side chain node
 * (Story 2.2 WP-E) which passes it as the `system` argument of the injected
 * `generate` fn while reusing `buildStorySyncMessages` for the user payload.
 * Single source — never inline a copy.
 */
export const SYSTEM_PROMPT = STORY_SYNC_SYSTEM_PROMPT;

export function buildStorySyncMessages(input: StorySyncPromptInput): GenerationMessage[] {
  const ctx = (input.context ?? {}) as Record<string, unknown>;
  const userPayload = {
    task: 'derive story sync patches from chapter candidate',
    output: 'JSON only',
    runId: input.runId,
    chapterId: input.chapterId,
    candidate: input.candidate,
    context: {
      chapterId: ctx.chapterId,
      chapterNumber: ctx.chapterNumber,
      novelTitle: ctx.novelTitle,
      creativeBrief: ctx.creativeBrief,
      worldSetting: ctx.worldSetting,
      assetCards: ctx.assetCards,
      relationshipGraph: ctx.relationshipGraph,
      episodeOutlines: ctx.episodeOutlines,
      growthCurve: ctx.growthCurve,
      pacingCurve: ctx.pacingCurve,
      emotionCurve: ctx.emotionCurve,
      // Story 2.2 WP-E: current per-field versions (from field_metadata). Rule 4
      // tells the LLM to echo these in patch.fieldVersion; `enforcePatchSafety`
      // drops patches whose echoed version went stale mid-run. Missing → key is
      // omitted by JSON.stringify and rule 4's "找不到则使用 0" applies.
      ...(ctx.fieldVersions !== undefined ? { fieldVersions: ctx.fieldVersions } : {}),
    },
  };

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(userPayload, null, 2) },
  ];
}
