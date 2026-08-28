import { randomUUID } from 'node:crypto';
import { estimateTokens } from './tokenEstimator';

export interface PinnedContextItem {
  id: string;
  type: 'character' | 'worldbuilding' | 'instruction' | 'style' | 'custom';
  label: string;
  content: string;
  priority: number; // 0-100, higher = more important
  createdAt: number;
  source?: 'user' | 'auto';
}

// Closure（Story 2.3）：bumped 50K -> 128K 给设定稳定前缀（core 设定 + 可查指针 +
// 目录）留空间。1M context window / 750K 压缩触发下兼容（留 ~872K 给消息）。
// renderPinnedContext 仍按 priority + 此预算裁剪，是「标多了 core 也撑不爆」的安全网。
const PINNED_CONTEXT_TOKEN_BUDGET = 128_000;

export function createPinnedItem(
  input: Omit<PinnedContextItem, 'id' | 'createdAt'>,
): PinnedContextItem {
  return {
    ...input,
    id: randomUUID(),
    createdAt: Date.now(),
  };
}

export function removePinnedItem(
  items: PinnedContextItem[],
  id: string,
): PinnedContextItem[] {
  return items.filter(item => item.id !== id);
}

export function updatePinnedItem(
  items: PinnedContextItem[],
  id: string,
  updates: Partial<Pick<PinnedContextItem, 'label' | 'content' | 'priority' | 'type'>>,
): PinnedContextItem[] {
  return items.map(item =>
    item.id === id ? { ...item, ...updates } : item,
  );
}

/**
 * Render pinned context items into a single text block for injection into the
 * LLM payload. Items are sorted by priority (highest first) and trimmed to
 * fit within the token budget.
 */
export function renderPinnedContext(items: PinnedContextItem[]): string {
  if (!items || items.length === 0) return '';

  const sorted = [...items].sort((a, b) => b.priority - a.priority);
  const parts: string[] = [];
  let tokensUsed = 0;

  for (const item of sorted) {
    const itemTokens = estimateTokens(item.content) + estimateTokens(item.label) + 20;
    if (tokensUsed + itemTokens > PINNED_CONTEXT_TOKEN_BUDGET) {
      if (parts.length === 0) {
        const availableChars = Math.floor((PINNED_CONTEXT_TOKEN_BUDGET - 20) * 3.5);
        const truncated = item.content.slice(0, availableChars);
        parts.push(`### ${item.label} [${item.type}]\n${truncated}\n[... truncated]`);
      }
      break;
    }
    parts.push(`### ${item.label} [${item.type}]\n${item.content}`);
    tokensUsed += itemTokens;
  }

  return parts.join('\n\n');
}

/**
 * Estimate total tokens consumed by pinned context.
 */
export function estimatePinnedTokens(items: PinnedContextItem[]): number {
  if (!items || items.length === 0) return 0;
  const rendered = renderPinnedContext(items);
  return estimateTokens(rendered);
}
