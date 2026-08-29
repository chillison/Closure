import { describe, expect, it } from 'vitest';
import {
  extractContextWindowFromError,
  resolveOverflowWindowTokens,
  hardCutForOverflow,
  isContextOverflowSeamError,
} from '../src/context/overflow';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// 08-25 BMad CR P1：context/overflow.ts 共享 helper 单元——CR-003 报文提取真实窗口
//（mirror anthropicFallbackCap 形态）+ 提取值 ?? 注入窗口 ?? 1M 解析序 + CR-004
// hardCutForOverflow 装配透传。跨缝识别（isContextOverflowSeamError）行为由
// loop.overflowRetry.test.ts 的集成用例同钉。
// ─────────────────────────────────────────────────────────────────────────────

function overflowError(message: string): Error {
  const err = new Error(message);
  err.name = 'ProtocolContextOverflowError';
  return Object.assign(err, { code: 'CONTEXT_OVERFLOW' });
}

function makeMessages(count: number, charsPer = 1000): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as SessionMessage['role'],
    content: 'x'.repeat(charsPer),
    createdAt: i + 1,
  }));
}

describe('extractContextWindowFromError（CR-003 报文提取）', () => {
  it('OpenAI 系报文："maximum context length is 16384 tokens, however ..." → 16384', () => {
    const err = overflowError(
      "This model's maximum context length is 16384 tokens. However, you requested 20000 tokens.",
    );
    expect(extractContextWindowFromError(err)).toBe(16384);
  });

  it('Anthropic 系报文："prompt is too long: 20000 tokens > 19500 maximum" → 第二数字（窗口）', () => {
    const err = overflowError('prompt is too long: 20000 tokens > 19500 maximum');
    expect(extractContextWindowFromError(err)).toBe(19500);
  });

  it('泛化形态："context window is 8192" → 8192（bodyExcerpt 同参与提取）', () => {
    const err = overflowError('request rejected');
    Object.assign(err, { bodyExcerpt: 'context window is 8192 tokens' });
    expect(extractContextWindowFromError(err)).toBe(8192);
  });

  it('解析不出 → undefined（调用方保持现 fallback）', () => {
    expect(extractContextWindowFromError(overflowError('prompt is too long'))).toBeUndefined();
    expect(extractContextWindowFromError(new Error('generic error'))).toBeUndefined();
    expect(extractContextWindowFromError('not an error')).toBeUndefined();
  });

  it('bodyExcerpt 非字符串形态不参与提取（防御，不抛）', () => {
    const err = overflowError('maximum context length is 4096 tokens');
    Object.assign(err, { bodyExcerpt: { json: true } });
    expect(extractContextWindowFromError(err)).toBe(4096);
  });
});

describe('resolveOverflowWindowTokens（CR-003 解析序：提取值 ?? 注入窗口 ?? 1M）', () => {
  it('报文提取值优先于注入窗口（真实窗口权威）', () => {
    expect(resolveOverflowWindowTokens(overflowError('maximum context length is 1000 tokens'), 1_000_000)).toBe(1000);
  });

  it('解析不出 → 注入窗口', () => {
    expect(resolveOverflowWindowTokens(overflowError('unparseable'), 204_800)).toBe(204_800);
  });

  it('解析不出且无注入 → 1M 缺省；无效注入同归一', () => {
    expect(resolveOverflowWindowTokens(overflowError('unparseable'), undefined)).toBe(1_000_000);
    expect(resolveOverflowWindowTokens(overflowError('unparseable'), -5)).toBe(1_000_000);
  });
});

describe('hardCutForOverflow（CR-004 共享装配）', () => {
  it('返回 hardCut 结果 + 实际生效窗口（透传 compactConversationHardCut + 窗口解析）', () => {
    const messages = makeMessages(6);
    const result = hardCutForOverflow({
      err: overflowError('maximum context length is 1000 tokens'),
      messages,
      injectedWindowTokens: 1_000_000,
    });
    // 窗口取报文提取值 1000（非注入 1M）；保尾 2（非 required 档）。
    expect(result.windowTokens).toBe(1000);
    expect(result.messages).toHaveLength(2);
    expect(result.compactedCount).toBe(4);
    // 小窗预算生效：6×1000 chars join ≈ 6K chars > 预算 1000×0.25×3.5 = 875 chars → 截断标记。
    expect(result.summary).toContain('硬截断摘要中段省略');
  });

  it('识别谓词：name / code 双判据（跨缝鸭子形态）', () => {
    expect(isContextOverflowSeamError(overflowError('x'))).toBe(true);
    expect(isContextOverflowSeamError(Object.assign(new Error('prompt is too long'), { code: 'CONTEXT_OVERFLOW' }))).toBe(true);
    expect(isContextOverflowSeamError(new Error('invalid request'))).toBe(false);
    expect(isContextOverflowSeamError('not an error')).toBe(false);
  });
});
