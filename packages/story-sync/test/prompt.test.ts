import { describe, expect, it } from 'vitest';
import { buildStorySyncMessages } from '../src/prompt';

describe('buildStorySyncMessages', () => {
  it('returns a system message and a user message', () => {
    const messages = buildStorySyncMessages({
      runId: 'r1',
      chapterId: 'c1',
      candidate: { content: '...' },
      context: {},
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes the chapter candidate in the user payload', () => {
    const messages = buildStorySyncMessages({
      runId: 'r1',
      chapterId: 'c1',
      candidate: { content: '一把铜钥匙' },
      context: { chapterNumber: 7 },
    });
    expect(messages[1].content).toContain('铜钥匙');
    expect(messages[1].content).toContain('"chapterNumber": 7');
  });

  it('keeps system prompt stable so adapter snapshot tests in callers stay green', () => {
    const a = buildStorySyncMessages({ runId: 'r', chapterId: 'c', candidate: {}, context: {} });
    const b = buildStorySyncMessages({ runId: 'r', chapterId: 'c', candidate: {}, context: {} });
    expect(a[0].content).toBe(b[0].content);
  });

  // Story 6.5（design §10 D10 / AC7 / CR-E7 防线）：story-sync 不提取 promise_registry——Promise 涌现登记
  // 走独立 promise-emergence-node（LLM 语义判定 perspective gap），非 prose 机械词提取（track-conflation 防线，
  // mirror 6.1 InfoReleaseMap）。prompt 的 field enum 不列 promise_registry + 明文禁止提取。
  it('Story 6.5 防线：field enum 不列 promise_registry / foreshadow_registry（旧名已移除）', () => {
    const messages = buildStorySyncMessages({ runId: 'r', chapterId: 'c', candidate: {}, context: {} });
    // Story 3.6 vision seam 后 user content 是 string|parts 联合——按 role 收窄拿 string。
    const systemMsg = messages[0];
    const system = systemMsg.role === 'system' ? systemMsg.content : '';
    // field enum 行（"field": "a" | "b" | ...）不应列 promise_registry（读者债走涌现节点非 story-sync）。
    // 抽 field enum 行（含 `"field":` 的行）单独断言——prohibition 规则文本本身会提及 promise_registry。
    const fieldEnumLine = system.split('\n').find((l) => l.includes('"field":')) ?? '';
    expect(fieldEnumLine).not.toContain('promise_registry');
    // 旧 foreshadow_registry 已改名，全 prompt 不应出现（既不在 enum 也不在规则——彻底移除）。
    expect(system).not.toContain('foreshadow_registry');
    // CR-08-16-106：episode_outlines 移出枚举——上游规划数组字段，prose→大纲回收非 story-sync
    // 职域，投影层（FIELD_TO_DOC_KEY 无映射）必拒；枚举广告它会浪费提取预算。
    expect(fieldEnumLine).not.toContain('episode_outlines');
  });

  it('Story 6.5 防线：system prompt 明文禁止 promise_registry 提取（指向 promise-emergence-node）', () => {
    const messages = buildStorySyncMessages({ runId: 'r', chapterId: 'c', candidate: {}, context: {} });
    const system = messages[0].content;
    // 明文告知 LLM：promise_registry 不从此处提取（走 promise-emergence-node）。
    expect(system).toContain('promise-emergence-node');
    expect(system).toContain('不得从此处提取');
  });

  // ── Story 2.2 WP-E 防线 0（track-conflation，design §5.5.0）：状态变化禁提取归 world_state 五轴；
  //    卡只收结构性设定（新实体登记/规则确立/定义性变化）。防双真相源漂移（6.6 五轴已管状态）。──

  it('Story 2.2 防线：状态变化明文禁止提取并指向 world_state 五轴（track-conflation）', () => {
    const messages = buildStorySyncMessages({ runId: 'r', chapterId: 'c', candidate: {}, context: {} });
    const system = messages[0].content;
    expect(system).toContain('状态变化');
    expect(system).toContain('禁止提取');
    expect(system).toContain('world_state');
    expect(system).toContain('双真相源漂移');
  });

  it('Story 2.2 防线：卡只收结构性设定（新实体登记/规则确立/定义性变化）', () => {
    const messages = buildStorySyncMessages({ runId: 'r', chapterId: 'c', candidate: {}, context: {} });
    const system = messages[0].content;
    expect(system).toContain('结构性设定');
    expect(system).toContain('新实体首次登记');
    expect(system).toContain('规则确立');
    expect(system).toContain('定义性变化');
  });

  it('Story 2.2 防线：relationship_graph 只收结构性关系，温度变化归 world_state 关系轴', () => {
    const messages = buildStorySyncMessages({ runId: 'r', chapterId: 'c', candidate: {}, context: {} });
    const system = messages[0].content;
    expect(system).toContain('relationship_graph');
    expect(system).toContain('结构性关系');
    expect(system).toContain('关系轴');
  });

  it('Story 2.2 WP-E：context.fieldVersions 透传进 user payload（规则 4 版本回显的数据源）', () => {
    const messages = buildStorySyncMessages({
      runId: 'r',
      chapterId: 'c',
      candidate: {},
      context: { fieldVersions: { asset_cards: 3, world_setting: 1 } },
    });
    expect(messages[1].content).toContain('"fieldVersions"');
    expect(messages[1].content).toContain('"asset_cards": 3');
    // 缺省不传 → key 整体省略（非空串/空对象占位）。
    const withoutVersions = buildStorySyncMessages({ runId: 'r', chapterId: 'c', candidate: {}, context: {} });
    expect(withoutVersions[1].content).not.toContain('"fieldVersions"');
  });
});
