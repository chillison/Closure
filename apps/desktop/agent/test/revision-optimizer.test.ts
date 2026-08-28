import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parseRevisionIntent, type RevisionIntent } from '@orison/shared-contracts';
import type { SkillExecutorRef } from '../src/types';
import { dispatchRevisionOptimizer } from '../src/tool/revision-optimizer';

// ─────────────────────────────────────────────────────────────────────────────
// Story 7.1（design §1[2] / §2.2）：revision-optimizer 子 agent —— 改稿意图编译器单测。
// 覆盖：
// - parseRevisionIntent 三路径鲁棒（fenced / brace-match / 整体）mirror parseAdjudication
// - parseRevisionIntent 缺必填 / 畸形 / 空串 → null（graceful，不假信心）
// - parseRevisionIntent schema 守卫（lockedItems / scope / details.min(1)）
// - dispatchRevisionOptimizer：success → RevisionIntent / dispatch error → null / parse fail → null
// - dispatchRevisionOptimizer：allowedTools=['query_story']（D1-c 反向约束）+ auditFindings 空串填空
// - dispatchRevisionOptimizer：skillExecutor 缺 → null（graceful）
// mirror write-chapter-retrieval.test.ts 的 mock skillExecutor 模式。
// ─────────────────────────────────────────────────────────────────────────────

/** 合法 RevisionIntent fixture（revision-optimizer 期望输出形态）。 */
const GOOD_INTENT: RevisionIntent = {
  change: { summary: '把这段战斗节奏改紧张' },
  lockedItems: [
    { field: '角色性格', authority: 'hard', evidence: '「别动角色性格」（用户原话）' },
    { field: '结论', authority: 'soft', evidence: '该场结论是后续伏笔锚点，推断不该动' },
  ],
  rationale: { source: 'user-directive', note: '用户选段指挥精修' },
  provenance: {
    rawUserInstruction: '这段战斗改紧张点，别动角色性格',
    compilerNote: '细化战斗节奏，锁定角色性格硬约束 + 推断结论软锁',
  },
  scope: {
    anchor: {
      quote: '他猛地握紧了拳',
      prefix: '林动看着他，',
      suffix: '，转身离去',
      rangeHint: { from: 120, to: 135 },
    },
    chapterId: 'chapter-2',
  },
};

// ════════════════════════════════════════════════════════════════════════════
// parseRevisionIntent（三路径鲁棒 mirror parseAdjudication）
// ════════════════════════════════════════════════════════════════════════════
describe('parseRevisionIntent（三路径鲁棒解析）', () => {
  it('纯 JSON 对象 → 解析（路径 3 整体 parse）', () => {
    expect(parseRevisionIntent(JSON.stringify(GOOD_INTENT))).toEqual(GOOD_INTENT);
  });

  it('fenced ```json 块 → 解析（路径 1）', () => {
    const content = '```json\n' + JSON.stringify(GOOD_INTENT) + '\n```';
    expect(parseRevisionIntent(content)).toEqual(GOOD_INTENT);
  });

  it('fenced ``` 块（无 json 标签）→ 解析（路径 1）', () => {
    const content = '```\n' + JSON.stringify(GOOD_INTENT) + '\n```';
    expect(parseRevisionIntent(content)).toEqual(GOOD_INTENT);
  });

  it('multi-fence：首个空/坏 fence 跳过，后续 fence 命中（路径 1 multi-fence tolerant）', () => {
    const reasoningFence = '```json\n{"reasoning":"先分析一下选段..."}\n```';
    const finalFence = '```json\n' + JSON.stringify(GOOD_INTENT) + '\n```';
    const content = reasoningFence + '\n\n最终结果：\n' + finalFence;
    expect(parseRevisionIntent(content)).toEqual(GOOD_INTENT);
  });

  it('narration 包裹（含前导/尾随文字）+ brace-match → 解析（路径 2）', () => {
    const content = '编译完成：' + JSON.stringify(GOOD_INTENT) + ' 以上。';
    expect(parseRevisionIntent(content)).toEqual(GOOD_INTENT);
  });

  it('narration 包裹（多行前导文字）+ brace-match → 解析（路径 2）', () => {
    const content = '经分析选段 + 上下文，编译结果如下。\n' + JSON.stringify(GOOD_INTENT) + '\n完毕。';
    expect(parseRevisionIntent(content)).toEqual(GOOD_INTENT);
  });

  it('空字符串 / 空白 / 非 JSON → null（graceful 降级）', () => {
    expect(parseRevisionIntent('')).toBeNull();
    expect(parseRevisionIntent('   ')).toBeNull();
    expect(parseRevisionIntent('这不是 JSON')).toBeNull();
    expect(parseRevisionIntent('{"change":{"summary":"不完整')).toBeNull();
  });

  it('合法 JSON 但 shape 不符（缺必填）→ null', () => {
    expect(parseRevisionIntent(JSON.stringify({ foo: 'bar' }))).toBeNull();
    expect(parseRevisionIntent(JSON.stringify({ change: {} }))).toBeNull();
  });

  it('缺 change → null（硬要求）', () => {
    const { change: _omit, ...rest } = GOOD_INTENT;
    void _omit;
    expect(parseRevisionIntent(JSON.stringify(rest))).toBeNull();
  });

  it('缺 rationale → null（硬要求）', () => {
    const { rationale: _omit, ...rest } = GOOD_INTENT;
    void _omit;
    expect(parseRevisionIntent(JSON.stringify(rest))).toBeNull();
  });

  it('缺 provenance → null（硬要求）', () => {
    const { provenance: _omit, ...rest } = GOOD_INTENT;
    void _omit;
    expect(parseRevisionIntent(JSON.stringify(rest))).toBeNull();
  });

  it('change.summary 空串 → null（硬要求）', () => {
    const bad = { ...GOOD_INTENT, change: { summary: '' } };
    expect(parseRevisionIntent(JSON.stringify(bad))).toBeNull();
  });

  it('rationale.source 非法值 → null', () => {
    const bad = {
      ...GOOD_INTENT,
      rationale: { source: 'auto-trigger', note: 'x' },
    };
    expect(parseRevisionIntent(JSON.stringify(bad))).toBeNull();
  });

  it('lockedItems 空数组合法（无锁定项 = 无硬约束，非阻塞）', () => {
    const intent = { ...GOOD_INTENT, lockedItems: [] };
    expect(parseRevisionIntent(JSON.stringify(intent))?.lockedItems).toEqual([]);
  });

  it('lockedItem authority 非法 → null', () => {
    const bad = {
      ...GOOD_INTENT,
      lockedItems: [{ field: '角色性格', authority: 'strict' }],
    };
    expect(parseRevisionIntent(JSON.stringify(bad))).toBeNull();
  });

  it('details 空 [] → null（.min(1) 拒空，二态契约）', () => {
    const bad = { ...GOOD_INTENT, change: { ...GOOD_INTENT.change, details: [] } };
    expect(parseRevisionIntent(JSON.stringify(bad))).toBeNull();
  });

  it('details ≥1 项合法', () => {
    const intent = {
      ...GOOD_INTENT,
      change: { ...GOOD_INTENT.change, details: ['缩短动作间隙', '提升感官密度'] },
    };
    expect(parseRevisionIntent(JSON.stringify(intent))?.change.details).toEqual([
      '缩短动作间隙',
      '提升感官密度',
    ]);
  });

  it('scope 缺省合法（整章范围）', () => {
    const { scope: _omit, ...rest } = GOOD_INTENT;
    void _omit;
    expect(parseRevisionIntent(JSON.stringify(rest))?.scope).toBeUndefined();
  });

  it('scope.anchor 缺 rangeHint → null（selectionAnchorSchema 守卫）', () => {
    const bad = {
      ...GOOD_INTENT,
      scope: { anchor: { quote: 'q', prefix: 'p', suffix: 's' } },
    };
    expect(parseRevisionIntent(JSON.stringify(bad))).toBeNull();
  });

  it('额外字段容忍（safeParse 默认 strip）', () => {
    const withExtra = { ...GOOD_INTENT, unexpected: 'ignored', change: { ...GOOD_INTENT.change, extra: 1 } };
    const r = parseRevisionIntent(JSON.stringify(withExtra));
    expect(r).toEqual(GOOD_INTENT);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dispatchRevisionOptimizer（mirror dispatchAdjudicator / amendWorldState dispatch pattern）
// ════════════════════════════════════════════════════════════════════════════
describe('dispatchRevisionOptimizer（revision-optimizer 子 agent 派发）', () => {
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: Parameters<typeof dispatchRevisionOptimizer>[0];

  beforeEach(() => {
    runAgentWithExplicitSystem = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      skillExecutor: { runAgentWithExplicitSystem } as unknown as Pick<
        SkillExecutorRef,
        'runAgentWithExplicitSystem'
      >,
    };
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('success：派发 + parse → RevisionIntent（vars + allowedTools 正确）', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({ content: JSON.stringify(GOOD_INTENT) });

    const intent = await dispatchRevisionOptimizer(ctx, {
      selectedPassage: '他猛地握紧了拳',
      userInstruction: '这段战斗改紧张点，别动角色性格',
      chapterContext: '{"goal":"战斗场景"}',
    });

    expect(intent).toEqual(GOOD_INTENT);
    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const call = runAgentWithExplicitSystem.mock.calls[0];
    expect(call[0]).toBe('leader-session-1');
    expect(call[1]).toBe('revision-optimizer-agent');
    expect(call[2]).toEqual({
      selectedPassage: '他猛地握紧了拳',
      userInstruction: '这段战斗改紧张点，别动角色性格',
      chapterContext: '{"goal":"战斗场景"}',
      auditFindings: '',
    });
    // allowedTools=['query_story']（D1-c 反向约束：optimizer 不拿写工具）
    expect(call[3]).toMatchObject({ allowedTools: ['query_story'] });
  });

  it('auditFindings 显式传值 → 进 vars（A trigger 入口）', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({ content: JSON.stringify(GOOD_INTENT) });

    await dispatchRevisionOptimizer(ctx, {
      selectedPassage: '段落',
      userInstruction: '改这段',
      chapterContext: '{}',
      auditFindings: '[{"severity":"warn"}]',
    });

    expect(runAgentWithExplicitSystem.mock.calls[0][2]).toMatchObject({
      auditFindings: '[{"severity":"warn"}]',
    });
  });

  it('fenced JSON → parse 成功（optimizer 常带 ```json 围栏）', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({
      content: '```json\n' + JSON.stringify(GOOD_INTENT) + '\n```',
    });

    const intent = await dispatchRevisionOptimizer(ctx, {
      selectedPassage: 'p',
      userInstruction: 'i',
      chapterContext: '{}',
    });

    expect(intent).toEqual(GOOD_INTENT);
  });

  it('dispatch 抛错 → graceful null（不假信心，不抛）', async () => {
    runAgentWithExplicitSystem.mockRejectedValue(new Error('timeout'));

    const intent = await dispatchRevisionOptimizer(ctx, {
      selectedPassage: 'p',
      userInstruction: 'i',
      chapterContext: '{}',
    });

    expect(intent).toBeNull();
  });

  it('parse 失败（坏 JSON）→ null（不假信心）', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({ content: '这不是 JSON' });

    const intent = await dispatchRevisionOptimizer(ctx, {
      selectedPassage: 'p',
      userInstruction: 'i',
      chapterContext: '{}',
    });

    expect(intent).toBeNull();
  });

  it('parse 部分缺失（缺 rationale）→ null（shape 守卫）', async () => {
    const { rationale: _omit, ...rest } = GOOD_INTENT;
    void _omit;
    runAgentWithExplicitSystem.mockResolvedValue({ content: JSON.stringify(rest) });

    const intent = await dispatchRevisionOptimizer(ctx, {
      selectedPassage: 'p',
      userInstruction: 'i',
      chapterContext: '{}',
    });

    expect(intent).toBeNull();
  });

  it('skillExecutor 缺 → graceful null', async () => {
    const intent = await dispatchRevisionOptimizer(
      { sessionId: 's1' },
      { selectedPassage: 'p', userInstruction: 'i', chapterContext: '{}' },
    );

    expect(intent).toBeNull();
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
  });

  it('runAgentWithExplicitSystem 缺 → graceful null', async () => {
    const intent = await dispatchRevisionOptimizer(
      { sessionId: 's1', skillExecutor: {} } as unknown as Parameters<typeof dispatchRevisionOptimizer>[0],
      { selectedPassage: 'p', userInstruction: 'i', chapterContext: '{}' },
    );

    expect(intent).toBeNull();
  });

  it('abort 信号 + spawnDepth 透传', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({ content: JSON.stringify(GOOD_INTENT) });
    const ac = new AbortController();

    await dispatchRevisionOptimizer(
      { sessionId: 's1', abort: ac.signal, spawnDepth: 2, skillExecutor: ctx.skillExecutor },
      { selectedPassage: 'p', userInstruction: 'i', chapterContext: '{}' },
    );

    expect(runAgentWithExplicitSystem.mock.calls[0][3]).toMatchObject({
      abort: ac.signal,
      spawnDepth: 2,
      allowedTools: ['query_story'],
    });
  });

  it('空 content → null（graceful）', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });

    const intent = await dispatchRevisionOptimizer(ctx, {
      selectedPassage: 'p',
      userInstruction: 'i',
      chapterContext: '{}',
    });

    expect(intent).toBeNull();
  });
});
