import type { z } from 'zod';
import { defineTool } from './define';
import { executeRemoteTool } from './remote';
import type { ToolDefinition, ToolResult } from '../types';

// ── dogfood R2（task 08-25-dogfood-round2，研究 story-outline-design-vs-impl.md §3.1/§四.4）：
// outline quality gates 三项运行时真验 ──
//
// 背景：CONTRACTS[] story-planner 的 qualityGates 三项（has_central_conflict / has_major_turning_points /
// has_ending_direction，engine/agentContracts.ts）此前只是契约装饰——大纲落盘通道不执行任何 gate，
// 规划器产出薄弱（缺核心冲突/转折点/结局方向）时无兜底、无提示。
//
// 接线位置（为什么在 agent 侧包装层而非 shell handler）：outline_update 的执行 handler 在 shell
// （client/shell/main/ipc/toolHandlers/outlineHandlers.ts），本任务并行约束（A/C 批占 ui，shell 禁改）
// 禁动 shell/ui——故在 agent 注册层把 remoteToolProxy 换成**同 id 委托包装**：execute 先转发注入的
// ExecuteToolFn（转发语义零变——shell 照常产 field_patch envelope），再对**合并后结果大纲**
// （当前现值 ⊕ 载荷，CR-7；error/failure 形结果直返不贴 gates，CR-8）验三项。
// 缺失 → **不阻断**（Warn 级）：议题挂 tool result——output 追加说人话警示段（当轮 LLM（leader /
// story-planner 子 agent）可见，可立即补全重发；tool result 卡在 chat 可见）+ metadata.qualityGateIssues
// 挂在 field_patch envelope 旁（envelope 本体零变——metadata 是 Record<string, unknown>，附加键零迁移，
// UI 现有路由按 type/field/action/data 读、多余键忽略，向后兼容）。
//
// 议题载体形态 mirror shared-contracts SceneGraphIssue（scene-graph-analytics.ts:187：
// code/severity/message/targets/suggestion——scene_graph 的 DAG 校验议题走 patch-review 数据通道的
// 既有形态）。本包内结构镜像（targets.kind 收窄为 'field'、id = outline 字段名），不动 shared-contracts
// 契约（outline patch 无现成 issues 载体；若未来 shell/UI 要消费，可平移 shared 化）。
// severity 恒 'warning'：三项都是「缺失即长篇质量塌陷」而非结构非法——outlineV2Schema 不管空值，
// 真验在此（范式判据：空值检测 = 机械纯代码；「冲突写得够不够好」归 LLM/人审，不在此门）。

/** 与 CONTRACTS[] story-planner qualityGates 一一对应的 gate id。 */
export type OutlineQualityGateCode =
  | 'has_central_conflict'
  | 'has_major_turning_points'
  | 'has_ending_direction';

export interface OutlineQualityGateIssue {
  code: OutlineQualityGateCode;
  severity: 'warning';
  /** 叙事语言表述（读者是作者与 LLM，非字段术语——mirror SceneGraphIssue message 风格）。 */
  message: string;
  /** 缺口指向的 outline 字段（供 UI/后续定位高亮，mirror SceneGraphIssue.targets 的形态）。 */
  targets: { kind: 'field'; id: string }[];
  /** 叙事语言修复建议。 */
  suggestion: string;
}

function isNonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 对 outline 新值验三项 gate（纯函数）：
 * - has_central_conflict：central_conflict trim 后非空；
 * - has_major_turning_points：major_turning_points 非空数组且至少一项 label trim 后非空
 *   （锚点无 label = 读者/作者无法指认的站点，等同未设）；
 * - has_ending_direction：ending_direction trim 后非空。
 *
 * 逐项独立（缺几项报几项）；非 object 输入（null/数组/字符串）三项全报（防御，不抛）。
 */
export function validateOutlineQualityGates(outline: unknown): OutlineQualityGateIssue[] {
  const doc = outline !== null && typeof outline === 'object' && !Array.isArray(outline)
    ? (outline as Record<string, unknown>)
    : {};
  const issues: OutlineQualityGateIssue[] = [];

  if (!isNonEmptyText(doc.central_conflict)) {
    issues.push({
      code: 'has_central_conflict',
      severity: 'warning',
      message: '大纲缺核心冲突——没有贯穿全书的对抗轴，各卷高潮会各打各的，攒不起合力',
      targets: [{ kind: 'field', id: 'central_conflict' }],
      suggestion: '补一句贯穿全书的核心冲突：谁在追求什么、谁在阻止、输赢的赌注是什么（一句话即可，不必展开）',
    });
  }

  const turningPoints = doc.major_turning_points;
  const hasLabeledAnchor = Array.isArray(turningPoints) && turningPoints.some(
    (p) => p !== null && typeof p === 'object' && isNonEmptyText((p as Record<string, unknown>).label),
  );
  if (!hasLabeledAnchor) {
    issues.push({
      code: 'has_major_turning_points',
      severity: 'warning',
      message: '大纲缺主要转折点——长篇没有命运改变的站点，中段会平铺直叙失去引力',
      targets: [{ kind: 'field', id: 'major_turning_points' }],
      suggestion: '至少标一个带简短中文名 label 的锚点（core-anchor 主锚点 = 多线全汇的交汇点，如决战/总揭露；secondary-anchor/fork-point 按需加）',
    });
  }

  if (!isNonEmptyText(doc.ending_direction)) {
    issues.push({
      code: 'has_ending_direction',
      severity: 'warning',
      message: '大纲缺结局方向——长篇没有终点站，中段会失去引力',
      targets: [{ kind: 'field', id: 'ending_direction' }],
      suggestion: '写明结局方向（一句话即可：圆满/悲剧/开放式，落在谁身上、了结什么）',
    });
  }

  return issues;
}

/**
 * 把 gate 议题挂进 tool result（Warn 级，不阻断——envelope 照常生产走人审）：
 * - output 追加「大纲质量提示」段（说人话——LLM 当轮可见可补全重发，chat 工具结果卡可见）；
 * - metadata 附加 qualityGateIssues（field_patch envelope 旁的 additive 键，envelope 本体不动）。
 * 全过 → 原样返回（零开销快路径，同一引用）。
 */
export function attachOutlineQualityGates(result: ToolResult, outline: unknown): ToolResult {
  const issues = validateOutlineQualityGates(outline);
  if (issues.length === 0) return result;
  const lines = issues.map((i) => `- ${i.message}。建议：${i.suggestion}`);
  return {
    ...result,
    output: `${result.output}\n\n大纲质量提示（不阻断——草案仍会呈给作者审阅；以下是长篇大纲的常见缺口，建议趁这次产出补全）：\n${lines.join('\n')}`,
    metadata: { ...(result.metadata ?? {}), qualityGateIssues: issues },
  };
}

/**
 * 读取当前 outline_v2 字段现值（CR-7：agent 侧现值读取通道 = `outline_read` remote 工具，
 * shell handler 返回 output = JSON.stringify(outline)，或空大纲时的中文提示文案）。
 * best-effort：空文案 / 非 JSON / 非 object / 调用抛错 → null——读失败不阻断 update 主路径
 *（CR-1 收紧后载荷本应全量，merge 只是防御层）。
 */
async function readCurrentOutlineBestEffort(
  ctx: { projectPath: string; sessionId: string; abort: AbortSignal },
): Promise<Record<string, unknown> | null> {
  try {
    const result = await executeRemoteTool('outline_read', {}, ctx);
    if (typeof result.output !== 'string' || result.output.trim() === '') return null;
    const parsed: unknown = JSON.parse(result.output);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * outline_update 注册件（dogfood R2）：mirror remoteToolProxy 的转发（同一 executeRemoteTool
 * 单源——shell handler 行为零变），出结果后挂三项 quality gate（见 attachOutlineQualityGates）。
 * id/description/parameters 与 shell toolExecution 契约同步（CR-1 起 schema 已收紧——核心字段
 * 必填，见 builtin.ts outline_update 注册处注释）。
 *
 * CR-7（校验对象 = 合并后结果大纲）：旧实现对 params.outline（增量载荷）直接验三项——载荷未
 * 提及的字段被当缺失，合法部分重规划也吃「缺核心冲突」假警告（训练用户无视质量门）。修法：
 * 取当前 outline 字段现值（readCurrentOutlineBestEffort）与载荷**浅合并**（载荷逐键覆盖）后
 * 再验。CR-1 收紧后核心字段必填、merge 实际退化为直接用载荷——保留 merge 作防御层（载荷漏键
 * 时回落现值）。读取在 update 执行**之后**：outline_update 只产 field_patch envelope 不落盘
 *（envelope 已由 CR-8 判定确认），盘上仍是合并基线；若未来 handler 改为直写，读到的是新值、
 * merged ≈ 载荷，语义同样成立。
 *
 * CR-8（失败结果不贴 gates）：remote 返回 error/failure 形结果（未 stage patch——seam 兜成
 * 错误 result / handler 拒绝等）时直返原样——qualityGateIssues/warn 文本只挂真 field_patch
 * envelope，防「失败也告警」训练用户无视质量门。
 */
export function outlineUpdateWithQualityGates<TParams>(def: {
  id: string;
  description: string;
  parameters: z.ZodType<TParams>;
}): ToolDefinition<TParams> {
  return defineTool({
    ...def,
    async execute(params, ctx) {
      const result = await executeRemoteTool(def.id, params, ctx);
      if ((result.metadata as { type?: string } | undefined)?.type !== 'field_patch') return result;
      const payloadOutline = (params as { outline?: unknown }).outline;
      const currentOutline = await readCurrentOutlineBestEffort(ctx);
      const merged = currentOutline !== null
        && payloadOutline !== null && typeof payloadOutline === 'object' && !Array.isArray(payloadOutline)
        ? { ...currentOutline, ...payloadOutline }
        : payloadOutline;
      return attachOutlineQualityGates(result, merged);
    },
  });
}
