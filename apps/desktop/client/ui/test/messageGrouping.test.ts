import { describe, expect, it } from 'vitest';
import {
  groupChildTags,
  groupMessages,
  isSyntheticUserContent,
  lastReportMessageByBatch,
  lastRetryableUserContent,
} from '../src/features/agent-panel/messageGrouping';
import type { AgentMessage } from '../src/shared/store/agentSlice';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 8：消息流分组纯函数。
// - batchId 契约字段分组（非文本正则——3.3 反模式），连续同 batchId 成组；
// - report（收尾 L0）消息不进组（组默认折叠而 L0 必须可见）；
// - 无 batchId 旧消息 → 扁平 single（向后兼容不破）；
// - child 标签分组（既有 3.3 债）在非批量 run 上行为不变。
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
function msg(partial: Partial<AgentMessage> & { role: AgentMessage['role'] }): AgentMessage {
  seq += 1;
  return { id: `m${seq}`, content: '', createdAt: seq, ...partial } as AgentMessage;
}

function batchMsg(content: string, batchId: string, batchKind: 'progress' | 'report' = 'progress') {
  return msg({ role: batchKind === 'report' ? 'assistant' : 'assistant', content, batchId, batchKind });
}

describe('Story 3.5 — groupMessages（batchId 契约字段分组）', () => {
  it('连续同 batchId 消息 → 单个 batch 组；无 batchId 消息 → 扁平 single', () => {
    const groups = groupMessages([
      msg({ role: 'user', content: '批量推进' }),
      batchMsg('通报', 'b-1'),
      msg({ role: 'tool', content: '', batchId: 'b-1', batchKind: 'progress' }),
      msg({ role: 'assistant', content: '收尾', batchId: 'b-2', batchKind: 'progress' }),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe('single');
    expect(groups[1].type).toBe('batch');
    expect(groups[1]).toMatchObject({ type: 'batch', batchId: 'b-1' });
    expect(groups[1].type === 'batch' && groups[1].messages).toHaveLength(2);
    expect(groups[2]).toMatchObject({ type: 'batch', batchId: 'b-2' });
  });

  it('同 batchId 被无 batchId 消息隔断 → 两个组（连续语义，不跨隔断合并）', () => {
    const groups = groupMessages([
      batchMsg('q1', 'b-1'),
      msg({ role: 'user', content: '答' }),
      batchMsg('q2', 'b-1'),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.filter((g) => g.type === 'batch')).toHaveLength(2);
  });

  it('report（batchKind=report）消息不进组 → single（L0 收尾全景须可见）', () => {
    const groups = groupMessages([
      batchMsg('过程', 'b-1'),
      batchMsg('L0 全景', 'b-1', 'report'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ type: 'batch', batchId: 'b-1' });
    expect(groups[1].type).toBe('single');
    expect(groups[1].type === 'single' && groups[1].message.batchKind).toBe('report');
  });

  it('旧会话消息（无 batchId/无 batchKind）→ 全扁平，行为与 3.5 之前一致', () => {
    const groups = groupMessages([
      msg({ role: 'user', content: 'hi' }),
      msg({ role: 'assistant', content: 'hello' }),
      msg({ role: 'tool', content: '', toolResults: [] }),
    ]);
    expect(groups.every((g) => g.type === 'single')).toBe(true);
    expect(groups).toHaveLength(3);
  });

  it('child 标签分组（3.3 既有债）在非批量 run 上不回归', () => {
    const groups = groupMessages([
      msg({ role: 'assistant', content: '[skill:story:d1] step one' }),
      msg({ role: 'tool', content: '[skill:story]', toolResults: [] }),
      msg({ role: 'assistant', content: '[skill:story:d1] step two' }),
    ]);
    // parseChildTag 匹配 source/role/depth 全等的连续消息成组。
    expect(groups.some((g) => g.type === 'child-group')).toBe(true);
  });

  it('不同 batchId 相邻 → 各自成组（不混并）', () => {
    const groups = groupMessages([
      batchMsg('a', 'b-1'),
      batchMsg('b', 'b-2'),
      batchMsg('c', 'b-1'),
    ]);
    expect(groups.map((g) => (g.type === 'batch' ? g.batchId : g.type))).toEqual(['b-1', 'b-2', 'b-1']);
  });
});

describe('Story 3.5 — groupChildTags（batch 组 body 内嵌渲染路径）', () => {
  it('child 标签连续消息成组；单条不成组', () => {
    const groups = groupChildTags([
      msg({ role: 'assistant', content: '[subagent:writer] thinking' }),
      msg({ role: 'tool', content: '[subagent:writer]', toolResults: [] }),
      msg({ role: 'assistant', content: 'plain' }),
    ]);
    expect(groups[0].type).toBe('child-group');
    expect(groups[1].type).toBe('single');
  });
});

describe('Story 3.5 — lastReportMessageByBatch（report 卡唯一挂卡点）', () => {
  it('end_batch 翻章后同 turn 的 tool 结果 + 中间 assistant 文本均带 report → 只取最后一条 assistant report', () => {
    // 真实时序：end_batch 工具执行中翻章 → 其 tool 结果消息、后续带工具调用的
    // assistant 中间文本、最终 L0 全景都盖 report。挂卡点须唯一（最后一条）。
    const toolReport = msg({ role: 'tool', content: '', batchId: 'b-1', batchKind: 'report' });
    const midAssistant = msg({ role: 'assistant', content: '收尾声明（带 present_result 调用）', batchId: 'b-1', batchKind: 'report' });
    const l0 = msg({ role: 'assistant', content: 'L0 全景', batchId: 'b-1', batchKind: 'report' });
    const map = lastReportMessageByBatch([toolReport, midAssistant, l0]);

    expect(map.get('b-1')).toBe(l0.id);
  });

  it('report tool 消息不作为挂卡点（role 过滤）；多批量各自取末条', () => {
    const b1L0 = msg({ role: 'assistant', content: 'L0-1', batchId: 'b-1', batchKind: 'report' });
    const b2Early = msg({ role: 'assistant', content: 'b2 中间', batchId: 'b-2', batchKind: 'report' });
    const b2L0 = msg({ role: 'assistant', content: 'L0-2', batchId: 'b-2', batchKind: 'report' });
    const onlyToolReport = msg({ role: 'tool', content: '', batchId: 'b-3', batchKind: 'report' });
    const map = lastReportMessageByBatch([b1L0, b2Early, b2L0, onlyToolReport]);

    expect(map.get('b-1')).toBe(b1L0.id);
    expect(map.get('b-2')).toBe(b2L0.id);
    expect(map.has('b-3')).toBe(false); // 纯 tool report 批量无挂卡点
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 CR-T1-041：重试钮载荷过滤 runtime 合成 user 消息。
// length 续写注入的 'Continue from where you left off...' / present_result 打回提醒
// 经 done 对账 fetch 入 store——重试钮重发内部指令 = 用户答非所问；扫尾取更早真人消息。
// ─────────────────────────────────────────────────────────────────────────────

describe('CR-T1-041 — lastRetryableUserContent（重试钮跳过合成指令）', () => {
  it('末条 user 是合成 length 续写指令 → 跳过取更早真人消息', () => {
    const content = lastRetryableUserContent([
      msg({ role: 'user', content: '写第三章' }),
      msg({ role: 'assistant', content: '（写了一半超长截断）' }),
      msg({ role: 'user', content: 'Continue from where you left off. Execute the next step using the appropriate tool.' }),
      msg({ role: 'assistant', content: '（继续写又截断）' }),
      msg({ role: 'user', content: 'Continue from where you left off. Execute the next step using the appropriate tool.' }),
    ]);
    expect(content).toBe('写第三章');
  });

  it('present_result 打回提醒（不发 UI 事件但随对账入 store）同样跳过', () => {
    const content = lastRetryableUserContent([
      msg({ role: 'user', content: '讨论一下大纲' }),
      msg({ role: 'assistant', content: '（漏调 present_result 被打回）' }),
      msg({ role: 'user', content: '你停下来向用户呈现结果前，必须先调用 present_result 工具声明这次停是否在等用户确认意图（awaiting_intent_confirmation 参数）。请重新呈现并用 present_result 收尾。' }),
    ]);
    expect(content).toBe('讨论一下大纲');
  });

  it('末条 user 是真人消息 → 照取（零回归）；无真人 user → null', () => {
    expect(lastRetryableUserContent([
      msg({ role: 'user', content: '正常指令' }),
      msg({ role: 'assistant', content: '答' }),
    ])).toBe('正常指令');

    expect(lastRetryableUserContent([
      msg({ role: 'user', content: 'Continue from where you left off. Execute the next step using the appropriate tool.' }),
    ])).toBeNull();
    expect(lastRetryableUserContent([])).toBeNull();
  });

  it('isSyntheticUserContent 前缀匹配（空/前缀未完整到达的短前缀不误判）', () => {
    expect(isSyntheticUserContent('Continue from where you left off. 任意后续')).toBe(true);
    expect(isSyntheticUserContent('Continue from')).toBe(false); // 前缀须完整
    expect(isSyntheticUserContent('')).toBe(false);
    expect(isSyntheticUserContent(undefined)).toBe(false);
  });
});
