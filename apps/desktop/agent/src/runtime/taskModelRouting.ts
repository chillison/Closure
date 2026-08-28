import type { ModelRef, SlotAssignment, TaskModelSlot, ThinkingControl, ThinkingKind } from '@orison/shared-contracts';
import { resolveModelInfo } from '@orison/shared-contracts';

/**
 * Maps a task-routing slot to its configured assignment (model ref + optional
 * thinking policy, S1 slotAssignmentSchema). Returns undefined for an
 * unconfigured slot — the caller passes the `.modelRef` on as the provider
 * default sentinel and shell resolveModel auto-picks (the pre-routing
 * behavior); the thinking policy rides the assignment as a whole (design §1.2:
 * never a selfcheck model + draft thinking-policy hybrid).
 *
 * 注：S1 落地的 slotAssignmentSchema 是 `modelRefSchema.extend({...})` 的**平铺**形态
 *（keyId/modelId 在顶层，无 .modelRef 嵌套）——取窄引用走 assignmentModelRef 单源，
 * 不各处手写 { keyId, modelId } 投影。
 */
export type TaskSlotResolver = (slot: TaskModelSlot) => SlotAssignment | undefined;

// Injection seam (mirror of provider setGenerateTextFn): the agent runtime
// never reads disk config itself (ADR-2 all-injection boundary) — the shell
// injects a resolver backed by a fresh read of the task-models sidecar per
// call, so slot changes take effect on the next turn / next chain assembly
// without a restart.
let _resolver: TaskSlotResolver | undefined;

export function setTaskSlotResolver(fn: TaskSlotResolver | undefined): void {
  _resolver = fn;
}

/**
 * Narrow the flat SlotAssignment to the ModelRef pair for generate
 * opts.modelRef / llmDeps.modelRef（不把 thinking/thinkingCustom 键渗进 IPC
 * ref 载荷——shell 只读 keyId/modelId，但保持 wire 体字节干净）。
 */
export function assignmentModelRef(assignment: SlotAssignment | undefined): ModelRef | undefined {
  if (!assignment) return undefined;
  return { keyId: assignment.keyId, modelId: assignment.modelId };
}

/**
 * S4c（task 08-25 design §4.1）：assignment → 上下文窗口 token 数（registry limits 单源，
 * basename 二轮同带）。未配置 / 未知模型（无 limits）→ undefined——调用方诚实回落缺省
 *（runLoop / makeAgentLoop 的 S4a 接收面均 1M），不猜窗口。
 */
export function assignmentContextWindowTokens(assignment: SlotAssignment | undefined): number | undefined {
  if (!assignment) return undefined;
  return resolveModelInfo(assignment.modelId).limits?.contextWindow;
}

/**
 * CR-008（08-25 BMad CR）：assignment → 模型思考 kind（registry 单源，basename 二轮同带）。
 * leader 车道 send 装配时注入 LoopOptions.thinkingKind——required 档
 * （reasoningRoundTrip==='required'，kimi-k3 / deepseek-v4 族）驱动压缩升级路径的保底区段。
 * 未配置 / 未知模型 → undefined（无 required 义务，现行为）。
 */
export function assignmentThinkingKind(assignment: SlotAssignment | undefined): ThinkingKind | undefined {
  if (!assignment) return undefined;
  return resolveModelInfo(assignment.modelId).thinking;
}

/**
 * Resolve the assignment for a task slot. No resolver injected, or the slot is
 * unconfigured → undefined → the caller passes `.modelRef` on as the provider
 * default sentinel and shell resolveModel auto-picks. That is byte-identical to
 * the pre-routing "empty model selector" path — which also means "wiring
 * missing" and "user didn't configure" are indistinguishable here, so the
 * wiring tests must assert the modelRef that generate actually receives
 * (design §7 red line).
 */
export function resolveTaskModel(slot: TaskModelSlot): SlotAssignment | undefined {
  return _resolver?.(slot);
}

/**
 * Slot resolution for the yaml-contract dispatch single point
 * (workflow.ts runChildAgentWithExplicitSystem). Unknown names route nothing —
 * see the YAML_AGENT_SLOT contract below.
 */
export function resolveTaskModelForAgent(agentName: string): SlotAssignment | undefined {
  // Object.hasOwn guards the prototype-key lookup hole: a name like 'toString'
  // or '__proto__' must hit "not registered", never an inherited property.
  if (!Object.hasOwn(YAML_AGENT_SLOT, agentName)) return undefined;
  return resolveTaskModel(YAML_AGENT_SLOT[agentName]);
}

/**
 * S4b（task 08-25 design §1.2）：assignment → 请求位 ThinkingControl 归一。
 * - `thinkingCustom` 有值 → `{level:'custom', custom}`（design §1.2「有值即 custom」，custom 优先）
 * - `thinking` 有值且非 'auto' → `{level}`（'auto' = 显式自动 = 不注入，与缺省同义）
 * - 都无 / undefined assignment → undefined（不传 = auto，字节级零变化）
 */
export function assignmentThinkingControl(
  assignment: SlotAssignment | undefined,
): ThinkingControl | undefined {
  if (!assignment) return undefined;
  if (assignment.thinkingCustom) return { level: 'custom', custom: assignment.thinkingCustom };
  if (assignment.thinking && assignment.thinking !== 'auto') return { level: assignment.thinking };
  return undefined;
}

/**
 * Slot lookup for the yaml-contract sub-agent dispatch single point
 * (workflow.ts runAgentWithExplicitSystem): adjudicator / arc-audit are
 * semantic judges → 'review-judge'; the planner / director / researcher /
 * optimizer / diagnosis dispatch family → 'dispatch'.
 *
 * Unknown agent names are deliberately NOT mapped — `YAML_AGENT_SLOT[name]`
 * yields undefined for them and resolveTaskModelForAgent returns undefined
 * (auto-pick), so a newly added yaml agent cannot silently inherit a wrong
 * slot; it must be registered here once its task semantics are decided.
 */
export const YAML_AGENT_SLOT: Readonly<Record<string, TaskModelSlot>> = {
  'story-planner-agent': 'dispatch',
  'episode-planner-agent': 'dispatch',
  'director-agent': 'dispatch',
  'researcher-agent': 'dispatch',
  'revision-optimizer-agent': 'dispatch',
  'ripple-diagnosis-agent': 'dispatch',
  'adjudicator-agent': 'review-judge',
  'arc-audit-agent': 'review-judge',
  // 读正文裁判世界状态修补一致性（nodes/world-amender.ts）——语义裁判族；
  // 当前无 leader tool 挂载（无活调用面），入表防未来接线时静默落自动选择。
  'world-amender-agent': 'review-judge',
  // 风格卡分析者（08-28 style-card-mvp A 路）——语义质量档：九遍扫描深分析，质量敏感。
  'style-analyzer-agent': 'review-judge',
};
