import type { SessionMessage } from '../types';
import { compactConversationHardCut } from './contextManager';
import { resolveContextWindowTokens } from './tokenEstimator';

// ── 08-25 BMad CR P1（CR-003 / CR-004）：context 溢出 400 的跨缝识别 + 真实窗口提取 +
// hardCut 装配——runLoop 车道（loop.ts 溢出重试）与 makeAgentLoop 车道（agent-loop.ts
// 溢出重试，CR-004 补位）共用的共享 helper。loop.ts 原地实现抽至此（CR-004「复用 loop.ts
// 的实现抽成共享 helper」），消息记账与重试骨架留在各车道（cacheConfig 重建 / 摘要对重注入
// 语义不同，不强行合并）。──
//
// agent 包不依赖 model-protocols（缝是注入的，mirror readStreamInterrupted 的鸭子判定
// 先例）：协议层（model-protocols errors.ts）把 context length/window 族 4xx 标记为
// ProtocolContextOverflowError（稳定 name + `code: 'CONTEXT_OVERFLOW'`），跨缝按
// name/code 识别；报文原文（message + bodyExcerpt）经鸭子读取参与窗口提取。

export function isContextOverflowSeamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'ProtocolContextOverflowError') return true;
  return (err as { code?: unknown }).code === 'CONTEXT_OVERFLOW';
}

/**
 * CR-003（08-25 CR）：从溢出 400 报文提取真实上下文窗口——mirror model-protocols
 * `extractMaxTokensLimit`（anthropicFallbackCap）从报错文本提取上限的形态。厂商报文实例：
 * - OpenAI 系："This model's maximum context length is 16384 tokens. However, you
 *   requested 20000 tokens."（maximum context 后第一个数字 = 窗口）
 * - Anthropic 系："prompt is too long: 20000 tokens > 19500 maximum"（第二个数字 = 窗口）
 * - 泛化兜底："context window is 8192" / "context length ... 8192" 族。
 * 解析不出 → undefined（调用方保持现 fallback：注入窗口 ?? 1M——见 resolveOverflowWindowTokens）。
 */
export function extractContextWindowFromError(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const carried = err as { bodyExcerpt?: unknown };
  const haystack = `${err.message}\n${typeof carried.bodyExcerpt === 'string' ? carried.bodyExcerpt : ''}`;
  if (haystack.length === 0) return undefined;

  const openAiFamily = /maximum context (?:length|window|size)[^\d]*(\d+)/i.exec(haystack);
  if (openAiFamily) return parsePositiveInt(openAiFamily[1]);
  const anthropicFamily = /prompt is too long[^\d]*(\d+)[^\d]+(\d+)\s*(?:tokens\s*)?maximum/i.exec(haystack);
  if (anthropicFamily) return parsePositiveInt(anthropicFamily[2]);
  const generic = /context[_ ]?(?:length|window|size)[^\d]*(\d+)/i.exec(haystack);
  if (generic) return parsePositiveInt(generic[1]);
  return undefined;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * CR-003：溢出重试的 hardCut 预算窗口 = 报文提取值 ?? 注入窗口（防御归一）?? 1M 缺省。
 * 未知小窗模型此前按 1M 假预算剪（切出的尾段对小窗仍超 → 重试同 400）；提取到真实窗口后
 * hardCut 的摘要预算（窗口占比）与保尾收敛到真实约束。提取值失真（过大）的最坏后果 =
 * 重试再溢出原样上抛，与现 fallback 行为等同，不会更糟。
 */
export function resolveOverflowWindowTokens(err: unknown, injectedWindowTokens: number | undefined): number {
  return extractContextWindowFromError(err) ?? resolveContextWindowTokens(injectedWindowTokens);
}

export interface OverflowHardCutInput {
  err: unknown;
  messages: SessionMessage[];
  existingSummary?: string;
  /** 调用方注入的窗口（LoopOptions.contextWindowTokens / AgentLoopConfig.contextWindowTokens）。 */
  injectedWindowTokens?: number;
  /**
   * CR-008（08-25 CR）：reasoningRoundTrip==='required' 档（kimi-k3 / deepseek-v4 族）——
   * hardCut 保尾不得低于保底区段（近段含 reasoning 的消息完整保留，厂商硬回传义务防 400）。
   */
  reasoningRoundTripRequired?: boolean;
}

export interface OverflowHardCutResult {
  messages: SessionMessage[];
  summary: string;
  compactedCount: number;
  /** 实际用于 hardCut 预算的窗口（提取值 ?? 注入 ?? 1M——日志/测试观测面）。 */
  windowTokens: number;
}

/**
 * 溢出重试的确定性 hardCut 装配：CR-003 窗口解析（本文件）+ CR-001 配对守卫 + CR-008
 * 保底区段（均在 compactConversationHardCut 单点）。两个车道共用；调用方各自做消息记账
 * （id 集对齐 / 摘要对重注入）与重试。
 */
export function hardCutForOverflow(input: OverflowHardCutInput): OverflowHardCutResult {
  const windowTokens = resolveOverflowWindowTokens(input.err, input.injectedWindowTokens);
  const hardCut = compactConversationHardCut({
    messages: input.messages,
    ...(input.existingSummary !== undefined ? { existingSummary: input.existingSummary } : {}),
    contextWindowTokens: windowTokens,
    ...(input.reasoningRoundTripRequired ? { reasoningRoundTripRequired: true } : {}),
  });
  return { ...hardCut, windowTokens };
}
