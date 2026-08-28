import { describe, expect, it } from 'vitest';
import {
  worldPatchOpSchema,
  worldPatchAxisSchema,
  worldPatchSourceSchema,
  worldKindSchema,
  worldSubjectRefSchema,
  worldSubjectSchema,
  worldSliceSchema,
  worldPatchSchema,
  worldIssueCodeSchema,
  amendmentRequestSchema,
  amendmentDecisionSchema,
  buildWorldStateSnapshot,
  createSubjectRef,
  parseSubjectRef,
  reduceSubject,
  type WorldPatch,
  type WorldKindResolver,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.6 Phase A：WorldState 契约 + reduce 纯函数（design §3 / NeuroBook §2-§5）。
// 纯 Zod schema + 纯函数 reduce -> plain vitest（无 fs/db/LLM）。覆盖：
// - schema parse（subject/slice/patch/enums/ref/amendment）+ reject 非法值
// - reduce 4 kind × 4 op 矩阵（严格照 NeuroBook schema-system.md §2 kind 表 + §3 op 语义）
// - increment 缺基准 broken-relative / 非法 op-kind invalid-op
// - 派生 + amendment 两层叠加（amendment 应用于 derived 之上）
// - ref 不解引用 / 截断 at / 多 subject filter
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 valid WorldPatch（schema.parse 兜底 required 字段；value 仅在 !== undefined 时带）。 */
let patchSeq = 0;
function mkPatch(
  over: Pick<WorldPatch, 'subjectId' | 'path' | 'op' | 'storyTime'> &
    Partial<Omit<WorldPatch, 'subjectId' | 'path' | 'op' | 'storyTime'>>,
): WorldPatch {
  return worldPatchSchema.parse({
    id: over.id ?? `p${++patchSeq}`,
    sliceId: over.sliceId ?? 'sl1',
    subjectId: over.subjectId,
    path: over.path,
    op: over.op,
    axis: over.axis ?? 'physical',
    source: over.source ?? 'derived',
    storyTime: over.storyTime,
    ...(over.value !== undefined ? { value: over.value } : {}),
    ...(over.summary ? { summary: over.summary } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// schema parse（契约层）
// ─────────────────────────────────────────────────────────────────────────────

describe('world-state schema parse（契约层基础）', () => {
  it('WorldSubject：required id/type/firstSeenStoryTime + optional name/sourceCardId', () => {
    const r = worldSubjectSchema.parse({
      id: 'erina',
      type: 'character',
      firstSeenStoryTime: 10,
    });
    expect(r.id).toBe('erina');
    expect(r.name).toBeUndefined();
    expect(r.sourceCardId).toBeUndefined();

    const withCard = worldSubjectSchema.parse({
      id: 'char_erina',
      type: 'character',
      name: '艾莉娜',
      sourceCardId: 'card_erina',
      firstSeenStoryTime: 0,
    });
    expect(withCard.sourceCardId).toBe('card_erina');
  });

  it('WorldSubject：缺 id/type/firstSeenStoryTime → reject', () => {
    expect(() => worldSubjectSchema.parse({ type: 'character', firstSeenStoryTime: 0 })).toThrow();
    expect(() => worldSubjectSchema.parse({ id: 'x', firstSeenStoryTime: 0 })).toThrow();
    expect(() => worldSubjectSchema.parse({ id: 'x', type: 'character' })).toThrow();
  });

  it('WorldSlice：required id/projectId/storyTime/title', () => {
    const r = worldSliceSchema.parse({
      id: 'sl1',
      projectId: '00001',
      storyTime: 100,
      title: '城北遭遇战',
    });
    expect(r.kind).toBeUndefined();
    expect(r.summary).toBeUndefined();
    expect(() => worldSliceSchema.parse({ id: 'sl1', projectId: '00001', storyTime: 100 })).toThrow();
  });

  it('WorldPatch：全 required 字段 parse round-trip', () => {
    const p = mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 100, storyTime: 10 });
    expect(p.subjectId).toBe('erina');
    expect(p.path).toBe('/hp');
    expect(p.op).toBe('replace');
    expect(p.value).toBe(100);
    expect(p.axis).toBe('physical');
    expect(p.source).toBe('derived');
  });

  it('WorldPatch：value 可省（普通 remove）/ 可为 null', () => {
    const noValue = mkPatch({ subjectId: 'x', path: '/hp', op: 'remove', storyTime: 0 });
    expect(noValue.value).toBeUndefined();
    const nullValue = mkPatch({ subjectId: 'x', path: '/items', op: 'remove', value: null, storyTime: 0 });
    expect(nullValue.value).toBeNull();
  });

  it('WorldPatch：缺 required → reject', () => {
    expect(() => worldPatchSchema.parse({ id: 'p', sliceId: 's', subjectId: 'x', path: '/hp', op: 'replace', axis: 'physical', source: 'derived' })).toThrow(); // 缺 storyTime
    expect(() => worldPatchSchema.parse({ id: 'p', sliceId: 's', subjectId: 'x', path: '/hp', op: 'replace', source: 'derived', storyTime: 0 })).toThrow(); // 缺 axis
  });
});

describe('world-state enum schema', () => {
  it('worldPatchOpSchema：4 op 全合法', () => {
    for (const op of ['replace', 'increment', 'remove', 'append'] as const) {
      expect(worldPatchOpSchema.parse(op)).toBe(op);
    }
    expect(() => worldPatchOpSchema.parse('upsert')).toThrow();
  });

  it('worldPatchAxisSchema：5 轴全合法', () => {
    for (const axis of ['physical', 'cognitive', 'emotional', 'relational', 'factional'] as const) {
      expect(worldPatchAxisSchema.parse(axis)).toBe(axis);
    }
    expect(() => worldPatchAxisSchema.parse('social')).toThrow();
  });

  it('worldPatchSourceSchema：derived | amendment', () => {
    expect(worldPatchSourceSchema.parse('derived')).toBe('derived');
    expect(worldPatchSourceSchema.parse('amendment')).toBe('amendment');
    expect(() => worldPatchSourceSchema.parse('manual')).toThrow();
  });

  it('worldKindSchema：4 kind 全合法', () => {
    for (const k of ['scalar', 'list', 'collection', 'object'] as const) {
      expect(worldKindSchema.parse(k)).toBe(k);
    }
  });

  it('worldIssueCodeSchema：2 code 全合法', () => {
    expect(worldIssueCodeSchema.parse('broken-relative')).toBe('broken-relative');
    expect(worldIssueCodeSchema.parse('invalid-op')).toBe('invalid-op');
  });
});

describe('subject ref helper（NeuroBook §5/§10）', () => {
  it('createSubjectRef / parseSubjectRef round-trip', () => {
    const ref = createSubjectRef('sword-01');
    expect(ref).toBe('subject://sword-01');
    expect(parseSubjectRef(ref)).toBe('sword-01');
  });

  it('worldSubjectRefSchema：合法 ref pass', () => {
    expect(worldSubjectRefSchema.parse('subject://erina')).toBe('subject://erina');
    expect(worldSubjectRefSchema.parse('subject://cultist-patrol-01')).toBe('subject://cultist-patrol-01');
  });

  it('worldSubjectRefSchema：非法 ref reject（无前缀 / 空 id / 含非法字符）', () => {
    expect(() => worldSubjectRefSchema.parse('item://sword')).toThrow();
    expect(() => worldSubjectRefSchema.parse('subject://')).toThrow();
    expect(() => worldSubjectRefSchema.parse('subject://has space')).toThrow();
  });

  it('parseSubjectRef：非 ref 返 null（不抛）', () => {
    expect(parseSubjectRef('not-a-ref')).toBeNull();
    expect(parseSubjectRef('subject://')).toBeNull();
  });
});

describe('amendment 契约（修补 Agent，design §3）', () => {
  it('AmendmentRequest：required subjectId/problemDescription/currentState', () => {
    const r = amendmentRequestSchema.parse({
      subjectId: 'erina',
      problemDescription: 'HP 应为 50 而非 100',
      currentState: { hp: 100 },
    });
    expect(r.currentState).toEqual({ hp: 100 });
    expect(() =>
      amendmentRequestSchema.parse({ subjectId: 'erina', currentState: {} }),
    ).toThrow();
  });

  it('AmendmentDecision：accept 带 amendmentPatches（WorldPatchInput 形态，无 infra 字段）/ reject 空默认', () => {
    const reject = amendmentDecisionSchema.parse({
      decision: 'reject',
      reason: '与正文矛盾（主角未受伤）',
    });
    expect(reject.amendmentPatches).toEqual([]);

    // amendmentPatches 是 WorldPatchInput 形态（LLM 可产 + amend_world_state handler 可直接消费）——
    // 无 source/id/sliceId/storyTime（infra 字段由 handler 强制注入：source='amendment' 等）。
    const accept = amendmentDecisionSchema.parse({
      decision: 'accept',
      reason: '修补与正文一致',
      amendmentPatches: [
        { subjectId: 'erina', path: '/hp', op: 'replace', value: 50, axis: 'physical', summary: '修正 HP' },
      ],
    });
    expect(accept.decision).toBe('accept');
    expect(accept.amendmentPatches).toHaveLength(1);
    expect(accept.amendmentPatches[0]).toMatchObject({
      subjectId: 'erina',
      path: '/hp',
      op: 'replace',
      value: 50,
      axis: 'physical',
    });
    // source 不在 WorldPatchInput（由 handler 强制注入）——amendmentPatches 不带 source
    expect(accept.amendmentPatches[0]).not.toHaveProperty('source');
    expect(accept.amendmentPatches[0]).not.toHaveProperty('id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reduce：4 kind × 4 op 矩阵（NeuroBook schema-system.md §2 + §3）
// ─────────────────────────────────────────────────────────────────────────────

describe('reduceSubject — scalar kind', () => {
  it('replace：后写覆盖前值（绝对值）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 80, storyTime: 20 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.hp).toBe(80);
    expect(issues).toEqual([]);
  });

  it('increment：基于当前值累加（连续变化用 increment，对插历史稳定）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'increment', value: -30, storyTime: 20 }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'increment', value: -20, storyTime: 30 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.hp).toBe(50);
    expect(issues).toEqual([]);
  });

  it('increment：缺基准（无前置 replace）→ broken-relative，跳过该 patch', () => {
    const patches = [mkPatch({ subjectId: 'h', path: '/hp', op: 'increment', value: -30, storyTime: 10 })];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.hp).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('broken-relative');
    expect(issues[0].path).toBe('/hp');
  });

  it('increment：当前值非数值（string）→ invalid-op（op-kind 不匹配）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/label', op: 'replace', value: 'healthy', storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/label', op: 'increment', value: 1, storyTime: 20 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.label).toBe('healthy');
    expect(issues[0].code).toBe('invalid-op');
  });

  it('increment：value 非数值 → invalid-op', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'increment', value: 'x' as unknown as number, storyTime: 20 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.hp).toBe(100); // 跳过 increment
    expect(issues[0].code).toBe('invalid-op');
  });

  it('remove：删 path（路径不存在幂等，无 issue）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'remove', storyTime: 20 }),
      mkPatch({ subjectId: 'h', path: '/gone', op: 'remove', storyTime: 30 }), // 不存在，幂等
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect('hp' in state).toBe(false);
    expect(issues).toEqual([]);
  });
});

describe('reduceSubject — list kind（默认 array 推断）', () => {
  it('replace 整组 + append 末尾追加（不去重，不中间插）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/events', op: 'replace', value: [{ text: 'a' }], storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/events', op: 'append', value: { text: 'b' }, storyTime: 20 }),
      mkPatch({ subjectId: 'h', path: '/events', op: 'append', value: { text: 'a' }, storyTime: 30 }), // list 不去重
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.events).toEqual([{ text: 'a' }, { text: 'b' }, { text: 'a' }]);
    expect(issues).toEqual([]);
  });

  it('append 缺基准（无前置 replace）→ broken-relative', () => {
    const patches = [mkPatch({ subjectId: 'h', path: '/events', op: 'append', value: { text: 'a' }, storyTime: 10 })];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.events).toBeUndefined();
    expect(issues[0].code).toBe('broken-relative');
  });

  it('append 当前值非数组（scalar）→ invalid-op', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/x', op: 'replace', value: 5, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/x', op: 'append', value: 1, storyTime: 20 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.x).toBe(5);
    expect(issues[0].code).toBe('invalid-op');
  });

  it('remove 不带 value 删整个 list path', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/events', op: 'replace', value: [{ text: 'a' }], storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/events', op: 'remove', storyTime: 20 }),
    ];
    const { state } = reduceSubject(patches, 'h');
    expect('events' in state).toBe(false);
  });

  it('list 带 value remove → invalid-op（拒绝，NeuroBook §3）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/events', op: 'replace', value: [{ text: 'a' }], storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/events', op: 'remove', value: { text: 'a' }, storyTime: 20 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.events).toEqual([{ text: 'a' }]); // 跳过非法 remove
    expect(issues[0].code).toBe('invalid-op');
  });

  it('list replace value 须数组（非数组 → invalid-op）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/events', op: 'replace', value: [{ text: 'a' }], storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/events', op: 'replace', value: 'notarray', storyTime: 20 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.events).toEqual([{ text: 'a' }]); // 跳过非法 replace
    expect(issues[0].code).toBe('invalid-op');
  });
});

describe('reduceSubject — collection kind（需 kindResolver 显式声明）', () => {
  const resolver: WorldKindResolver = (path) => (path === '/inventory' ? 'collection' : undefined);

  it('append 按 stable JSON 去重追加（已存在则跳过）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'replace', value: ['subject://sword'], storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'append', value: 'subject://shield', storyTime: 20 }),
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'append', value: 'subject://sword', storyTime: 30 }), // 去重
    ];
    const { state, issues } = reduceSubject(patches, 'h', undefined, { kindResolver: resolver });
    expect(state.inventory).toEqual(['subject://sword', 'subject://shield']);
    expect(issues).toEqual([]);
  });

  it('append 去重按 stable JSON（对象元素结构相同即匹配）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'replace', value: [{ a: 1, b: 2 }], storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'append', value: { b: 2, a: 1 }, storyTime: 20 }), // 同结构去重
    ];
    const { state } = reduceSubject(patches, 'h', undefined, { kindResolver: resolver });
    expect(state.inventory).toEqual([{ a: 1, b: 2 }]);
  });

  it('remove 带 value 按 stable JSON 删元素（找不到幂等）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'replace', value: ['subject://sword', 'subject://shield'], storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'remove', value: 'subject://sword', storyTime: 20 }),
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'remove', value: 'subject://gone', storyTime: 30 }), // 找不到幂等
    ];
    const { state, issues } = reduceSubject(patches, 'h', undefined, { kindResolver: resolver });
    expect(state.inventory).toEqual(['subject://shield']);
    expect(issues).toEqual([]);
  });

  it('collection replace value 须数组（非数组 → invalid-op）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'replace', value: [], storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'replace', value: 42, storyTime: 20 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h', undefined, { kindResolver: resolver });
    expect(state.inventory).toEqual([]);
    expect(issues[0].code).toBe('invalid-op');
  });

  it('无 resolver 时 array 默认 list（append 不去重——collection 需显式声明）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'replace', value: ['a'], storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/inventory', op: 'append', value: 'a', storyTime: 20 }),
    ];
    const { state } = reduceSubject(patches, 'h'); // 无 resolver
    expect(state.inventory).toEqual(['a', 'a']); // list 不去重
  });
});

describe('reduceSubject — object kind（子路径 + 整体 replace）', () => {
  it('子路径 replace：set 嵌套 key（自动建中间对象）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/equipment/weapon', op: 'replace', value: 'subject://sword', storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/equipment/head', op: 'replace', value: 'subject://helmet', storyTime: 20 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.equipment).toEqual({ weapon: 'subject://sword', head: 'subject://helmet' });
    expect(issues).toEqual([]);
  });

  it('整体 replace：换整个 object', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/equipment', op: 'replace', value: { weapon: 'subject://sword' }, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/equipment', op: 'replace', value: { head: 'subject://helmet' }, storyTime: 20 }),
    ];
    const { state } = reduceSubject(patches, 'h');
    expect(state.equipment).toEqual({ head: 'subject://helmet' });
  });

  it('开放字典 by key（如 /memory/师门）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/memory/师门', op: 'replace', value: { text: '怀疑' }, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/memory/家乡', op: 'replace', value: { text: '怀念' }, storyTime: 20 }),
    ];
    const { state } = reduceSubject(patches, 'h');
    expect(state.memory).toEqual({ 师门: { text: '怀疑' }, 家乡: { text: '怀念' } });
  });

  it('子路径 remove：删嵌套 key', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/equipment/weapon', op: 'replace', value: 'subject://sword', storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/equipment/weapon', op: 'remove', storyTime: 20 }),
    ];
    const { state } = reduceSubject(patches, 'h');
    expect(state.equipment).toEqual({});
  });

  it('object increment → invalid-op（object 不接受 increment）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/equipment', op: 'replace', value: { weapon: 'x' }, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/equipment', op: 'increment', value: 1, storyTime: 20 }),
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.equipment).toEqual({ weapon: 'x' });
    expect(issues[0].code).toBe('invalid-op'); // 基准存在但非数值 → op-kind 不匹配
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reduce：两层（derived + amendment）/ ref / 截断 at / 多 subject
// ─────────────────────────────────────────────────────────────────────────────

describe('reduceSubject — 派生 + amendment 两层叠加', () => {
  it('同 storyTime：amendment 应用于 derived 之上（amendment 覆盖层）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10, source: 'derived' }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 50, storyTime: 10, source: 'amendment' }),
    ];
    const { state } = reduceSubject(patches, 'h');
    expect(state.hp).toBe(50); // amendment 胜
  });

  it('同 storyTime：amendment increment 叠加在 derived replace 之上', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10, source: 'derived' }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'increment', value: -30, storyTime: 10, source: 'amendment' }),
    ];
    const { state } = reduceSubject(patches, 'h');
    expect(state.hp).toBe(70); // amendment 在 derived 之后
  });

  it('不同 storyTime：按 storyTime 升序（amendment 晚 → 后应用）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10, source: 'derived' }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'increment', value: -30, storyTime: 20, source: 'amendment' }),
    ];
    const { state } = reduceSubject(patches, 'h');
    expect(state.hp).toBe(70);
  });

  it('amendment 早于 derived storyTime：derived 仍后应用（storyTime 主序）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 20, source: 'derived' }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 50, storyTime: 10, source: 'amendment' }),
    ];
    const { state } = reduceSubject(patches, 'h');
    expect(state.hp).toBe(100); // derived storyTime 20 晚于 amendment 10 → derived 后应用胜
  });
});

describe('reduceSubject — ref 不解引用 + 截断 at + 多 subject', () => {
  it('ref 返 subject://id 字符串本身（reduce 不自动解引用）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/equipment/weapon', op: 'replace', value: createSubjectRef('sword-01'), storyTime: 10 }),
    ];
    const { state } = reduceSubject(patches, 'h');
    expect(state.equipment).toEqual({ weapon: 'subject://sword-01' }); // 字符串，非嵌套解引用
  });

  it('截断 at：at 早于某 patch 则该 patch 不参与', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 80, storyTime: 20 }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 50, storyTime: 30 }),
    ];
    expect(reduceSubject(patches, 'h', 20).state.hp).toBe(80); // 30 的被截断
    expect(reduceSubject(patches, 'h', 10).state.hp).toBe(100);
    expect(reduceSubject(patches, 'h', 5).state.hp).toBeUndefined(); // 全截断
  });

  it('at 缺省取最新（全叠加）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'increment', value: -30, storyTime: 20 }),
    ];
    expect(reduceSubject(patches, 'h').state.hp).toBe(70);
  });

  it('多 subject：仅叠加目标 subject 的 patch（其它 subject 不影响）', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      mkPatch({ subjectId: 'villain', path: '/hp', op: 'replace', value: 200, storyTime: 10 }),
      mkPatch({ subjectId: 'h', path: '/hp', op: 'increment', value: -30, storyTime: 20 }),
    ];
    expect(reduceSubject(patches, 'h').state.hp).toBe(70);
    expect(reduceSubject(patches, 'villain').state.hp).toBe(200);
  });

  it('空 patch 集 → 空 state + 无 issue', () => {
    const { state, issues } = reduceSubject([], 'h');
    expect(state).toEqual({});
    expect(issues).toEqual([]);
  });

  it('非法 path（非 / 开头）→ invalid-op，跳过', () => {
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      // 直接构造非法 path（schema 仅要求 min(1)，reduce 内 parsePointer 判定）
      {
        ...mkPatch({ subjectId: 'h', path: '/x', op: 'replace', value: 1, storyTime: 20 }),
        path: 'badpath',
      },
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.hp).toBe(100);
    expect(state.x).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('invalid-op');
    expect(issues[0].path).toBe('badpath');
  });

  it('CR-5: 未知 op（schema 校验旁路的裸脏数据）→ default invalid-op，跳过（不静默吞）', () => {
    // 直接构造未知 op（schema 层 enum 闭，但 reduce 可能收到未经 Zod 的裸 IPC/db 数据）。
    const patches = [
      mkPatch({ subjectId: 'h', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      {
        ...mkPatch({ subjectId: 'h', path: '/mana', op: 'replace', value: 50, storyTime: 20 }),
        op: 'teleport' as unknown as WorldPatch['op'],
      },
    ];
    const { state, issues } = reduceSubject(patches, 'h');
    expect(state.hp).toBe(100);
    expect(state.mana).toBeUndefined(); // 未知 op 跳过，不写 state
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('invalid-op');
    expect(issues[0].message).toContain('teleport');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.6 Phase D：buildWorldStateSnapshot（消费端反哺用章节级快照纯函数）。
// 覆盖：at 截断 + first-seen subject 收集 + cap + 非空状态过滤 + attrs 投影 + 多 subject。
// ─────────────────────────────────────────────────────────────────────────────

describe('buildWorldStateSnapshot（Phase D 消费端反哺快照）', () => {
  it('at 截断：仅 reduce storyTime <= at 的 patches，多 subject 各自 reduce', () => {
    const patches = [
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'increment', value: -30, storyTime: 20 }),
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'increment', value: -20, storyTime: 30 }),
      mkPatch({ subjectId: 'sword', path: '/durability', op: 'replace', value: 80, storyTime: 15 }),
    ];
    // at=20：erina hp=70（100-30，30 的 -20 被截断），sword durability=80（15<=20）。
    const snap = buildWorldStateSnapshot(patches, 20);
    expect(snap.at).toBe(20);
    const erina = snap.subjects.find((s) => s.subjectId === 'erina');
    const sword = snap.subjects.find((s) => s.subjectId === 'sword');
    expect(erina?.state.hp).toBe(70);
    expect(sword?.state.durability).toBe(80);
  });

  it('at undefined = 取最新（全叠加）', () => {
    const patches = [
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'increment', value: -50, storyTime: 30 }),
    ];
    const snap = buildWorldStateSnapshot(patches, undefined);
    expect(snap.at).toBeUndefined();
    expect(snap.subjects[0].state.hp).toBe(50);
  });

  it('first-seen 序（按 storyTime 升序出现）+ subjectCap 截断', () => {
    // 4 subject，分别在 storyTime 30/10/20/40 首次出现。cap=2 → 只收前两个 first-seen（10 的 sword + 20 的 villain）。
    const patches = [
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 100, storyTime: 30 }),
      mkPatch({ subjectId: 'sword', path: '/durability', op: 'replace', value: 80, storyTime: 10 }),
      mkPatch({ subjectId: 'villain', path: '/hp', op: 'replace', value: 200, storyTime: 20 }),
      mkPatch({ subjectId: 'faction', path: '/treasury', op: 'replace', value: 1000, storyTime: 40 }),
    ];
    const snap = buildWorldStateSnapshot(patches, undefined, { subjectCap: 2 });
    expect(snap.subjects.map((s) => s.subjectId)).toEqual(['sword', 'villain']);
  });

  it('非空状态过滤：subject 在 at 前无 populated 属性 → 不收录（免 snapshot 噪音）', () => {
    // erina 在 at=5 前无 patch（首 patch storyTime=10）→ 不收录。
    const patches = [
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
    ];
    const snap = buildWorldStateSnapshot(patches, 5);
    expect(snap.subjects).toEqual([]);
  });

  it('attrs 投影：只保留顶层 key 在 attrs 的属性', () => {
    const patches = [
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 70, storyTime: 10 }),
      mkPatch({ subjectId: 'erina', path: '/location', op: 'replace', value: 'subject://altar', storyTime: 10 }),
      mkPatch({ subjectId: 'erina', path: '/memory', op: 'replace', value: 'secret', storyTime: 10 }),
    ];
    const snap = buildWorldStateSnapshot(patches, undefined, { attrs: ['hp', 'location'] });
    expect(snap.subjects[0].state.hp).toBe(70);
    expect(snap.subjects[0].state.location).toBe('subject://altar');
    expect(snap.subjects[0].state.memory).toBeUndefined(); // 不在 attrs → 投影掉
  });

  it('attrs 全不命中 → subject 状态空 → 不收录', () => {
    const patches = [
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 70, storyTime: 10 }),
    ];
    const snap = buildWorldStateSnapshot(patches, undefined, { attrs: ['treasury'] });
    expect(snap.subjects).toEqual([]);
  });

  it('空 patches → 空 snapshot（首章 / 无前章状态）', () => {
    const snap = buildWorldStateSnapshot([], undefined);
    expect(snap.subjects).toEqual([]);
    expect(snap.at).toBeUndefined();
  });

  it('issueCount：reduce 跳过的 patch 计入（broken-relative / invalid-op）', () => {
    const patches = [
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 100, storyTime: 10 }),
      // increment 缺基准（/mana 无前值）→ broken-relative，跳过。
      mkPatch({ subjectId: 'erina', path: '/mana', op: 'increment', value: 10, storyTime: 20 }),
    ];
    const snap = buildWorldStateSnapshot(patches, undefined);
    expect(snap.subjects[0].issueCount).toBe(1);
    expect(snap.subjects[0].state.hp).toBe(100);
    expect(snap.subjects[0].state.mana).toBeUndefined();
  });

  it('派生 + amendment 两层叠加（amendment 应用于 derived 之上）', () => {
    const patches = [
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 100, storyTime: 10, source: 'derived' }),
      // amendment 覆盖：hp 改为 50（修补 Agent 裁决后写的覆盖层）。
      mkPatch({ subjectId: 'erina', path: '/hp', op: 'replace', value: 50, storyTime: 10, source: 'amendment' }),
    ];
    const snap = buildWorldStateSnapshot(patches, undefined);
    expect(snap.subjects[0].state.hp).toBe(50); // amendment 覆盖 derived
  });
});
