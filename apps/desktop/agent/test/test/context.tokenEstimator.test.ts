import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessagesTokens,
  shouldTriggerCompaction,
  isProjectionOverflow,
  updateCalibrationRatio,
  clampRedlinePercent,
  resolveContextWindowTokens,
  CONTEXT_WINDOW,
  COMPACTION_TRIGGER_RATIO,
  DEFAULT_REDLINE_PERCENT,
  CONTEXT_REPLY_RESERVE_TOKENS,
} from '../src/context/tokenEstimator';
import type { SessionMessage } from '../src/types';

describe('tokenEstimator', () => {
  it('estimates tokens for English text', () => {
    const text = 'Hello world, this is a test.';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(Math.ceil(text.length / 3.5));
  });

  it('estimates tokens for Chinese text', () => {
    const text = '这是一段中文测试文本，用于验证token估算的准确性。';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates message tokens including tool calls', () => {
    const messages: SessionMessage[] = [
      { id: '1', role: 'user', content: 'Read the file', createdAt: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'I will read it.',
        toolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{"path":"src/index.ts"}' }],
        createdAt: 2,
      },
      {
        id: '3',
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc1', toolName: 'read_file', output: 'const x = 1;' }],
        createdAt: 3,
      },
    ];
    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  // dogfood T1 Stage 4（design §6.3 / r3）：reasoning 计入预算——深度思考可与正文等长，
  // 不计会低估 compaction 触发线（summarizer 决策漂移）。
  it('counts reasoning length toward the estimate (compaction budget)', () => {
    const base: SessionMessage[] = [
      { id: '1', role: 'assistant', content: '正文', createdAt: 1 },
    ];
    const withReasoning: SessionMessage[] = [
      { id: '1', role: 'assistant', content: '正文', reasoning: '深度思考'.repeat(200), createdAt: 1 },
    ];
    const baseTokens = estimateMessagesTokens(base);
    const withReasoningTokens = estimateMessagesTokens(withReasoning);
    expect(withReasoningTokens).toBeGreaterThan(baseTokens);
  });

  it('triggers compaction when over threshold', () => {
    // S4a（task 08-25）：缺省红线 0.75 → 95%（用户拍板行为变化）——阈值锚点换
    // DEFAULT_REDLINE_PERCENT；到达即触发（>= 语义，非严格大于）。
    const systemTokens = 1000;
    const messagesTokens = CONTEXT_WINDOW * (DEFAULT_REDLINE_PERCENT / 100); // exactly at threshold
    expect(shouldTriggerCompaction(systemTokens, messagesTokens)).toBe(true);
  });

  it('does not trigger compaction when under threshold', () => {
    const systemTokens = 1000;
    const messagesTokens = 100_000;
    expect(shouldTriggerCompaction(systemTokens, messagesTokens)).toBe(false);
  });

  it('respects calibration ratio', () => {
    const systemTokens = 1000;
    const messagesTokens = 500_000;
    // With ratio 1.0, total = 501,000 < 950,000 (S4a 缺省 95%) → no trigger
    expect(shouldTriggerCompaction(systemTokens, messagesTokens, 1.0)).toBe(false);
    // With ratio 2.0, total = 1,002,000 > 950,000 → trigger
    //（S4a 前阈值 750K，ratio 1.6 即触发；缺省红线抬到 95% 后本例改 2.0——行为变化有因更新）
    expect(shouldTriggerCompaction(systemTokens, messagesTokens, 2.0)).toBe(true);
  });

  it('accepts injected window/redline (S4a parameterized triggers)', () => {
    const systemTokens = 0;
    const messagesTokens = 160_000;
    // 200K 窗口（如 GLM-5.1）× 80% 红线 = 160K → 到达即触发。
    expect(shouldTriggerCompaction(systemTokens, messagesTokens, 1.0, 200_000, 80)).toBe(true);
    // 同估算在 1M 缺省窗口下远未到红线 → 不触发。
    expect(shouldTriggerCompaction(systemTokens, messagesTokens, 1.0)).toBe(false);
  });

  it('detects projection overflow (trigger ③: estimate + reply reserve > window)', () => {
    // 窗口 100K、预留 32,768：估算 68,000 + 32,768 > 100,000 → 溢出。
    expect(isProjectionOverflow(68_000, 1.0, 100_000)).toBe(true);
    // 估算 60,000 + 32,768 < 100,000 → 塞得下。
    expect(isProjectionOverflow(60_000, 1.0, 100_000)).toBe(false);
    expect(CONTEXT_REPLY_RESERVE_TOKENS).toBeGreaterThan(0);
  });

  it('clamps redline percent and resolves window defensively', () => {
    expect(clampRedlinePercent(undefined)).toBe(DEFAULT_REDLINE_PERCENT);
    expect(clampRedlinePercent(Number.NaN)).toBe(DEFAULT_REDLINE_PERCENT);
    expect(clampRedlinePercent(10)).toBe(50);   // 低于下限 → 50
    expect(clampRedlinePercent(150)).toBe(100); // 高于上限 → 100
    expect(clampRedlinePercent(80)).toBe(80);
    expect(resolveContextWindowTokens(undefined)).toBe(CONTEXT_WINDOW);
    expect(resolveContextWindowTokens(-5)).toBe(CONTEXT_WINDOW);
    expect(resolveContextWindowTokens(Number.NaN)).toBe(CONTEXT_WINDOW);
    expect(resolveContextWindowTokens(200_000)).toBe(200_000);
    // 历史锚点：S4 前固定触发线 0.75 保留为导出常量（不再是缺省）。
    expect(COMPACTION_TRIGGER_RATIO).toBe(0.75);
  });

  it('updates calibration ratio with EMA', () => {
    const ratio = updateCalibrationRatio(1.0, 1000, 800);
    // observed = 1000/800 = 1.25
    // new = 1.0 * 0.8 + 1.25 * 0.2 = 0.8 + 0.25 = 1.05
    expect(ratio).toBeCloseTo(1.05, 5);
  });

  it('ignores invalid values in calibration', () => {
    expect(updateCalibrationRatio(1.0, 0, 800)).toBe(1.0);
    expect(updateCalibrationRatio(1.0, 1000, 0)).toBe(1.0);
    expect(updateCalibrationRatio(1.0, -1, 100)).toBe(1.0);
  });
});
