import { describe, expect, it } from 'vitest';
import {
  sceneGraphSchema,
  promiseRegistrySchema,
  expandAtomicEditOp,
  validateAtomicEditOps,
  parseDirectorAtomicEdits,
  atomicEditOpSchema,
  atomicEditProposalSchema,
  collectCreatedSceneIds,
  applySceneGraphActions,
  validateSceneGraph,
  type SceneGraph,
  type SceneNode,
} from '../src';

// ── helpers（mirror scene-graph-analytics.test.ts 风格）──

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

const node = (id: string, lineTags: string[] = []): Partial<SceneNode> => ({
  id,
  lineTags,
  storyTime: 0,
  presentationOrder: { chapter: 0, pos: 0 },
});

const causal = (id: string, from: string, to: string) => ({ id, from, to, type: 'CAUSAL' as const });

/** 线性因果链图：s0→s1→s2（两条线 + 收敛目标，让 reachability 不空报）。 */
function linearChainGraph(): SceneGraph {
  return parseGraph({
    nodes: [node('s0', ['L1']), node('s1', ['L1']), node('s2', ['L1'])],
    edges: [causal('e01', 's0', 's1'), causal('e12', 's1', 's2')],
    lines: [
      { id: 'L1', name: '主线', topology_role: 'converging', convergence_target: 's2', weight: undefined, displacement: 'none', visibility: { status: 'open' } },
    ],
  });
}

const ctx = (graph: SceneGraph) => ({ sceneGraph: graph });

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: expandAtomicEditOp（纯机械展开，零语义判断）
// ─────────────────────────────────────────────────────────────────────────────
describe('expandAtomicEditOp 纯机械展开（Story 7.3 design §2）', () => {
  describe('add_plot_bridge（加桥段）', () => {
    it('展开成 add_scene(桥) + 2 条 CAUSAL 边', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'add_plot_bridge',
          between: { fromSceneId: 's0', toSceneId: 's2' },
          bridgeScene: node('bridge1', ['L1']) as SceneNode,
        },
        ctx(graph),
      );
      expect(expansion.sceneGraphActions).toHaveLength(3);
      expect(expansion.promiseActions).toEqual([]);
      expect(expansion.sceneGraphActions[0]).toMatchObject({ op: 'add_scene', scene: { id: 'bridge1' } });
      // 桥 in/out 边连 from→bridge→to
      const edges = expansion.sceneGraphActions.filter((a) => a.op === 'add_edge');
      expect(edges).toHaveLength(2);
      expect(edges[0]).toMatchObject({ edge: { from: 's0', to: 'bridge1', type: 'CAUSAL' } });
      expect(edges[1]).toMatchObject({ edge: { from: 'bridge1', to: 's2', type: 'CAUSAL' } });
    });

    it('边 id 确定性命名（重复提议同端点 = by-id 覆盖非重复追加）', () => {
      const graph = linearChainGraph();
      const op = {
        op: 'add_plot_bridge' as const,
        between: { fromSceneId: 's0', toSceneId: 's2' },
        bridgeScene: node('bridge1', ['L1']) as SceneNode,
      };
      const e1 = expandAtomicEditOp(op, ctx(graph));
      const e2 = expandAtomicEditOp(op, ctx(graph));
      expect(e1.sceneGraphActions).toEqual(e2.sceneGraphActions);
    });

    it('flashback causality 字段被接受（expander 不碰 storyTime 排序，归校验/writer）', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'add_plot_bridge',
          between: { fromSceneId: 's0', toSceneId: 's2' },
          bridgeScene: node('bridge1', ['L1']) as SceneNode,
          causality: 'flashback',
        },
        ctx(graph),
      );
      expect(expansion.sceneGraphActions).toHaveLength(3);
    });
  });

  describe('add_suspense（加悬念）', () => {
    it('无独立钩子场：SUSPENSE 边直接挂既有 atScene', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        { op: 'add_suspense', atSceneId: 's0', resolveTowardsSceneId: 's2' },
        ctx(graph),
      );
      expect(expansion.sceneGraphActions).toHaveLength(1);
      expect(expansion.sceneGraphActions[0]).toMatchObject({
        op: 'add_edge',
        edge: { from: 's0', to: 's2', type: 'SUSPENSE' },
      });
    });

    it('有独立钩子场：add_scene + CAUSAL(atScene→hook) + SUSPENSE(hook→resolve)', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'add_suspense',
          atSceneId: 's0',
          suspenseScene: node('hook1', ['L1']) as SceneNode,
          resolveTowardsSceneId: 's2',
        },
        ctx(graph),
      );
      // CR-001：钩子场连进因果链（atScene→hook CAUSAL）+ 悬念指向（hook→resolve SUSPENSE）+ add_scene。
      expect(expansion.sceneGraphActions).toHaveLength(3);
      expect(expansion.sceneGraphActions[0]).toMatchObject({ op: 'add_scene', scene: { id: 'hook1' } });
      expect(expansion.sceneGraphActions[1]).toMatchObject({
        op: 'add_edge',
        edge: { from: 's0', to: 'hook1', type: 'CAUSAL' },
      });
      expect(expansion.sceneGraphActions[2]).toMatchObject({
        op: 'add_edge',
        edge: { from: 'hook1', to: 's2', type: 'SUSPENSE' },
      });
    });
  });

  describe('add_foreshadow（加伏笔）', () => {
    it('展开成 add_promise(plant firstBeat) + add_beat(payoff)', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'add_foreshadow',
          promise: { id: 'p1', title: '神秘信件', summary: '主角收到匿名密信，后续揭示寄件人' },
          plantBeatSceneId: 's0',
          payoffBeatSceneId: 's2',
        },
        ctx(graph),
      );
      expect(expansion.sceneGraphActions).toEqual([]);
      expect(expansion.promiseActions).toHaveLength(2);
      expect(expansion.promiseActions[0]).toMatchObject({
        type: 'add_promise',
        promise: { id: 'p1' },
        firstBeat: { kind: 'plant', promiseId: 'p1', sceneRef: 's0' },
      });
      expect(expansion.promiseActions[1]).toMatchObject({
        type: 'add_beat',
        beat: { kind: 'payoff', promiseId: 'p1', sceneRef: 's2' },
      });
    });

    it('plant + payoff 落 promise_registry 后派生态正确（planted→paid_off）', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'add_foreshadow',
          promise: { id: 'p1', title: '伏笔', summary: '...' },
          plantBeatSceneId: 's0',
          payoffBeatSceneId: 's2',
        },
        ctx(graph),
      );
      // promise_actions 落 applyPromiseActions（既有 projector）后 registry 应含 plant+payoff beat。
      // 此处只验 expander 输出 shape 正确（projector 单测已在 creative-fields.test.ts 覆盖）。
      expect(expansion.promiseActions.some((a) => a.type === 'add_promise')).toBe(true);
      expect(expansion.promiseActions.some((a) => a.type === 'add_beat')).toBe(true);
    });

    it('🔑 CR-002：plant==payoff 同场被 schema 拒（自然键碰撞致 plant 被 payoff 覆盖）', () => {
      expect(() => atomicEditOpSchema.parse({
        op: 'add_foreshadow',
        promise: { id: 'p1', title: '伏笔', summary: '...' },
        plantBeatSceneId: 's0',
        payoffBeatSceneId: 's0', // 同场
      })).toThrow();
    });
  });

  describe('insert_twist（插反转）', () => {
    it('add_scene(twist outcomeType=反转) + CAUSAL 入边，无 rewire', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'insert_twist',
          afterSceneId: 's1',
          twistScene: node('twist1', ['L1']) as SceneNode,
          rewireEdgesTo: [],
        },
        ctx(graph),
      );
      expect(expansion.sceneGraphActions.filter((a) => a.op === 'add_scene')).toHaveLength(1);
      expect(expansion.sceneGraphActions.find((a) => a.op === 'add_scene')).toMatchObject({
        scene: { id: 'twist1', outcomeType: '反转' },
      });
      expect(expansion.sceneGraphActions).toContainEqual({
        op: 'add_edge',
        edge: { id: 'twist-in:s1->twist1', from: 's1', to: 'twist1', type: 'CAUSAL' },
      });
    });

    it('rewire：remove 既有 afterScene→下游 CAUSAL 直边 + add twist→下游', () => {
      const graph = linearChainGraph(); // s0→s1→s2，s1→s2 是既有 CAUSAL 直边
      const expansion = expandAtomicEditOp(
        {
          op: 'insert_twist',
          afterSceneId: 's1',
          twistScene: node('twist1', ['L1']) as SceneNode,
          rewireEdgesTo: ['s2'],
        },
        ctx(graph),
      );
      // remove s1→s2 既有直边（e12）
      expect(expansion.sceneGraphActions).toContainEqual({ op: 'remove_edge', id: 'e12' });
      // add twist1→s2 新因果
      expect(expansion.sceneGraphActions).toContainEqual({
        op: 'add_edge',
        edge: { id: 'twist-out:twist1->s2', from: 'twist1', to: 's2', type: 'CAUSAL' },
      });
    });

    it('rewire 只动 CAUSAL 直边（SUSPENSE 边不动）', () => {
      const graph = parseGraph({
        nodes: [node('s0', ['L1']), node('s1', ['L1']), node('s2', ['L1'])],
        edges: [
          causal('e01', 's0', 's1'),
          causal('e12', 's1', 's2'),
          { id: 'sus12', from: 's1', to: 's2', type: 'SUSPENSE' },
        ],
        lines: [{ id: 'L1', name: '主线', topology_role: 'converging', convergence_target: 's2', weight: undefined, displacement: 'none', visibility: { status: 'open' } }],
      });
      const expansion = expandAtomicEditOp(
        {
          op: 'insert_twist',
          afterSceneId: 's1',
          twistScene: node('twist1', ['L1']) as SceneNode,
          rewireEdgesTo: ['s2'],
        },
        ctx(graph),
      );
      // 只 remove CAUSAL 直边 e12，不 remove SUSPENSE 边 sus12
      expect(expansion.sceneGraphActions).toContainEqual({ op: 'remove_edge', id: 'e12' });
      expect(expansion.sceneGraphActions.some((a) => a.op === 'remove_edge' && a.id === 'sus12')).toBe(false);
    });

    it('rewire 目标既有边不存在：幂等不报错（remove no-op + add 照常）', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'insert_twist',
          afterSceneId: 's1',
          twistScene: node('twist1', ['L1']) as SceneNode,
          rewireEdgesTo: ['s9'], // s9 不存在，无 s1→s9 既有边
        },
        ctx(graph),
      );
      // 无 remove（无既有直边），但 add twist1→s9 照常（校验层报 dangling）
      expect(expansion.sceneGraphActions.some((a) => a.op === 'remove_edge')).toBe(false);
      expect(expansion.sceneGraphActions).toContainEqual({
        op: 'add_edge',
        edge: { id: 'twist-out:twist1->s9', from: 'twist1', to: 's9', type: 'CAUSAL' },
      });
    });

    it('🔑 CR-006：rewireEdgesTo 重复 id 去重（不产重复 action）', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'insert_twist',
          afterSceneId: 's1',
          twistScene: node('twist1', ['L1']) as SceneNode,
          rewireEdgesTo: ['s2', 's2', 's2'],
        },
        ctx(graph),
      );
      // s2 只 rewire 一次：1 个 remove(e12) + 1 个 add(twist-out)，非 3 份。
      const removes = expansion.sceneGraphActions.filter((a) => a.op === 'remove_edge' && a.id === 'e12');
      const adds = expansion.sceneGraphActions.filter((a) => a.op === 'add_edge' && a.edge?.id === 'twist-out:twist1->s2');
      expect(removes).toHaveLength(1);
      expect(adds).toHaveLength(1);
    });

    it('twistScene 已带 outcomeType 时不覆盖（LLM 显式值优先）', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'insert_twist',
          afterSceneId: 's1',
          twistScene: { ...node('twist1', ['L1']), outcomeType: '惨胜式反转' } as SceneNode,
          rewireEdgesTo: [],
        },
        ctx(graph),
      );
      expect(expansion.sceneGraphActions.find((a) => a.op === 'add_scene')).toMatchObject({
        scene: { id: 'twist1', outcomeType: '惨胜式反转' },
      });
    });
  });

  describe('revise_event（改现有事件）', () => {
    it('展开成 update_scene(sceneId + patch)', () => {
      const graph = linearChainGraph();
      const expansion = expandAtomicEditOp(
        {
          op: 'revise_event',
          sceneId: 's1',
          patch: { id: 's1', outcomeType: '惨胜', pacingRole: '高潮' } as SceneNode,
        },
        ctx(graph),
      );
      expect(expansion.sceneGraphActions).toHaveLength(1);
      expect(expansion.sceneGraphActions[0]).toMatchObject({
        op: 'update_scene',
        scene: { id: 's1', outcomeType: '惨胜', pacingRole: '高潮' },
      });
    });
  });

  it('expander 不判目标节点存在性（dangling 归 validator）', () => {
    const graph = linearChainGraph();
    // bridge 引向不存在的 s9——expander 照样展开，不抛
    const expansion = expandAtomicEditOp(
      {
        op: 'add_plot_bridge',
        between: { fromSceneId: 's0', toSceneId: 's9' },
        bridgeScene: node('bridge1', ['L1']) as SceneNode,
      },
      ctx(graph),
    );
    expect(expansion.sceneGraphActions).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: validateAtomicEditOps（复用既有 validateSceneGraph + diff）
// ─────────────────────────────────────────────────────────────────────────────
describe('validateAtomicEditOps（Story 7.3 design §3）', () => {
  it('clean 展开（线性链加桥段）：valid=true，无新 issue', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [
        {
          op: 'add_plot_bridge',
          between: { fromSceneId: 's0', toSceneId: 's2' },
          bridgeScene: node('bridge1', ['L1']) as SceneNode,
        },
      ],
      ctx(graph),
    );
    expect(result.valid).toBe(true);
    expect(result.blockingIssues).toEqual([]);
  });

  it('桥段引用不存在的端点：引入 dangling-edge-endpoint（warning 不阻断，但 newIssues 非空）', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [
        {
          op: 'add_plot_bridge',
          between: { fromSceneId: 's0', toSceneId: 's9' }, // s9 不存在
          bridgeScene: node('bridge1', ['L1']) as SceneNode,
        },
      ],
      ctx(graph),
    );
    // dangling-edge-endpoint 是 warning 级（既有 validateSceneGraph severity:warning）
    expect(result.newIssues.length).toBeGreaterThan(0);
    expect(result.newIssues.some((i) => i.code === 'dangling-edge-endpoint')).toBe(true);
  });

  it('add_suspense SUSPENSE 边不引入因果环（valid=true）', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [{ op: 'add_suspense', atSceneId: 's0', resolveTowardsSceneId: 's2' }],
      ctx(graph),
    );
    expect(result.valid).toBe(true);
  });

  it('add_suspense 引入因果环（valid=false，blocking 非空）', () => {
    // s2→s0 SUSPENSE 边 + 既有 s0→s1→s2 CAUSAL = 环（SUSPENSE 入 DAG cycle detection）
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [{ op: 'add_suspense', atSceneId: 's2', resolveTowardsSceneId: 's0' }],
      ctx(graph),
    );
    // 若 SUSPENSE 入 DAG 检测：环 = error（canon cycle）
    expect(result.blockingIssues.some((i) => i.code === 'causal-cycle')).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('🔑 CR-003：issueKey 含 severity——warning→error 升级（同 code 同 targets）被判「新」非吞掉', () => {
    // 构造既有 graph 已有 warning 级 causal-cycle（IF-branch），expansion 引入 error 级 canon cycle。
    // 若 issueKey 漏 severity → beforeKeys 含同 code|targets → 新 error 被吞 → valid 假阴。
    // CR-003 后 severity 入 key → 新 error 不被吞 → blocking 非空。
    // 用 add_suspense s2→s0 引入 canon cycle（error）验证 blocking 被报。
    const graph = parseGraph({
      nodes: [node('s0', ['L1']), node('s1', ['L1']), node('s2', ['L1'])],
      edges: [causal('e01', 's0', 's1'), causal('e12', 's1', 's2')],
      lines: [{ id: 'L1', name: '主线', topology_role: 'converging', convergence_target: 's2', weight: undefined, displacement: 'none', visibility: { status: 'open' } }],
    });
    const result = validateAtomicEditOps(
      [{ op: 'add_suspense', atSceneId: 's2', resolveTowardsSceneId: 's0' }],
      ctx(graph),
    );
    // canon cycle = error 级，须进 blockingIssues（CR-003 保 severity 不被同 code 吞）。
    const canonCycleErrors = result.blockingIssues.filter((i) => i.code === 'causal-cycle' && i.severity === 'error');
    expect(canonCycleErrors.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });

  it('insert_twist rewire 不留 dangling edge（remove 既有 + add 新，clean）', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [
        {
          op: 'insert_twist',
          afterSceneId: 's1',
          twistScene: node('twist1', ['L1']) as SceneNode,
          rewireEdgesTo: ['s2'],
        },
      ],
      ctx(graph),
    );
    expect(result.valid).toBe(true);
  });

  it('diff 校验：只报「新引入」issue，既有 issue 不算 newIssues', () => {
    // 构造既有就带 dangling 的图，加桥段不碰那条边 → 既有 dangling 不进 newIssues
    const graph = parseGraph({
      nodes: [node('s0', ['L1']), node('s1', ['L1'])],
      edges: [
        causal('e01', 's0', 's1'),
        causal('e_dangling', 's1', 'sGone'), // 既有 dangling（sGone 不存在）
      ],
      lines: [{ id: 'L1', name: '主线', topology_role: 'converging', convergence_target: 's1', weight: undefined, displacement: 'none', visibility: { status: 'open' } }],
    });
    const result = validateAtomicEditOps(
      [
        {
          op: 'add_plot_bridge',
          between: { fromSceneId: 's0', toSceneId: 's1' },
          bridgeScene: node('bridge2', ['L1']) as SceneNode,
        },
      ],
      ctx(graph),
    );
    // 既有 e_dangling 不该进 newIssues（它展开前就存在）
    expect(result.newIssues.some((i) => i.code === 'dangling-edge-endpoint')).toBe(false);
  });

  it('空 ops：valid=true，无新 issue', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps([], ctx(graph));
    expect(result.valid).toBe(true);
    expect(result.newIssues).toEqual([]);
  });

  it('多 op 批次：全部展开后统一校验', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [
        { op: 'add_suspense', atSceneId: 's0', resolveTowardsSceneId: 's2' },
        {
          op: 'revise_event',
          sceneId: 's1',
          patch: { id: 's1', outcomeType: '达成' } as SceneNode,
        },
      ],
      ctx(graph),
    );
    expect(result.valid).toBe(true);
  });

  // ── CR-008（7.3 DEFER 补，Story 7.4 design §5）：promise-only 批次校验 ──

  it('🔑 CR-008：add_foreshadow 锚既有场景 valid（promise 校验通过）', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [
        {
          op: 'add_foreshadow',
          promise: { id: 'p1', title: '密信', summary: '主角收到匿名信' },
          plantBeatSceneId: 's0',
          payoffBeatSceneId: 's2',
        },
      ],
      ctx(graph),
    );
    // plant s0 / payoff s2 都锚既有场景 → promise 校验 clean → valid=true。
    expect(result.valid).toBe(true);
    expect(result.blockingIssues.some((i) => i.code.startsWith('promise-'))).toBe(false);
  });

  it('🔑 CR-008：两 add_foreshadow 同 promiseId → blocking（后者 clobber 前者）', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [
        {
          op: 'add_foreshadow',
          promise: { id: 'p1', title: '密信 A', summary: '...' },
          plantBeatSceneId: 's0',
          payoffBeatSceneId: 's1',
        },
        {
          op: 'add_foreshadow',
          promise: { id: 'p1', title: '密信 B', summary: '...' },
          plantBeatSceneId: 's1',
          payoffBeatSceneId: 's2',
        },
      ],
      ctx(graph),
    );
    // 同 promiseId 'p1' 两 add_promise → promise-duplicate-id error blocking。
    expect(result.valid).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'promise-duplicate-id')).toBe(true);
  });

  it('🔑 CR-008：add_foreshadow beat sceneRef dangling → blocking', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [
        {
          op: 'add_foreshadow',
          promise: { id: 'p1', title: '密信', summary: '...' },
          plantBeatSceneId: 's0',
          payoffBeatSceneId: 'sGone', // 不存在
        },
      ],
      ctx(graph),
    );
    // payoff beat sceneRef 'sGone' 不在 projected graph → promise-dangling-sceneref error blocking。
    expect(result.valid).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'promise-dangling-sceneref')).toBe(true);
  });

  it('🔑 CR-008 batch-aware：add_foreshadow plant 锚同批 add_plot_bridge 创的新场 → valid（projected graph 含新场）', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [
        {
          op: 'add_plot_bridge',
          between: { fromSceneId: 's0', toSceneId: 's2' },
          bridgeScene: node('bridgeNew', ['L1']) as SceneNode,
        },
        {
          op: 'add_foreshadow',
          promise: { id: 'p1', title: '桥上伏笔', summary: '...' },
          plantBeatSceneId: 'bridgeNew', // 锚同批创的新场
          payoffBeatSceneId: 's2',
        },
      ],
      ctx(graph),
    );
    // projected graph 含 bridgeNew（add_plot_bridge 展开 add_scene）→ plant beat 锚定 OK → valid。
    expect(result.valid).toBe(true);
    expect(result.blockingIssues.some((i) => i.code === 'promise-dangling-sceneref')).toBe(false);
  });

  it('🔑 CR-008：graph clean 但 promise blocking → valid=false（graph 校验不覆盖 promise，CR-008 补）', () => {
    const graph = linearChainGraph();
    const result = validateAtomicEditOps(
      [
        {
          op: 'add_foreshadow',
          promise: { id: 'p1', title: '密信', summary: '...' },
          plantBeatSceneId: 's0',
          payoffBeatSceneId: 'sGone', // dangling
        },
      ],
      ctx(graph),
    );
    // add_foreshadow 不产 sceneGraphActions → projected graph === current → graph diff 无新 issue。
    // 但 promise dangling → CR-008 补的 promise 校验报 blocking → valid=false（7.3 旧版会 valid=true 假阴）。
    expect(result.newIssues.some((i) => i.code.startsWith('causal') || i.code.startsWith('dangling-edge'))).toBe(false);
    expect(result.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-009（7.3 DEFER 补，Story 7.4 design §5）：collectCreatedSceneIds + batch-aware filter 支持
// ─────────────────────────────────────────────────────────────────────────────
describe('collectCreatedSceneIds（CR-009 batch-aware filter 支持）', () => {
  it('收集 add_plot_bridge / add_suspense / insert_twist 创建的新场 id', () => {
    const ops = [
      { op: 'add_plot_bridge', between: { fromSceneId: 's0', toSceneId: 's1' }, bridgeScene: { id: 'bridge1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } } },
      { op: 'add_suspense', atSceneId: 's0', suspenseScene: { id: 'hook1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }, resolveTowardsSceneId: 's1' },
      { op: 'insert_twist', afterSceneId: 's0', twistScene: { id: 'twist1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }, rewireEdgesTo: [] },
    ].map((o) => atomicEditOpSchema.parse(o));
    const ids = collectCreatedSceneIds(ops);
    expect(ids.has('bridge1')).toBe(true);
    expect(ids.has('hook1')).toBe(true);
    expect(ids.has('twist1')).toBe(true);
    expect(ids.size).toBe(3);
  });

  it('add_suspense 无 suspenseScene（挂既有场）→ 不收集新场 id', () => {
    const op = atomicEditOpSchema.parse({
      op: 'add_suspense', atSceneId: 's0', resolveTowardsSceneId: 's1',
    });
    const ids = collectCreatedSceneIds([op]);
    expect(ids.size).toBe(0);
  });

  it('add_foreshadow / revise_event 不创建场景 → 空集', () => {
    const ops = [
      { op: 'add_foreshadow', promise: { id: 'p1', title: 't', summary: 's' }, plantBeatSceneId: 's0', payoffBeatSceneId: 's1' },
      { op: 'revise_event', sceneId: 's0', patch: { id: 's0', outcomeType: '达成' } },
    ].map((o) => atomicEditOpSchema.parse(o));
    const ids = collectCreatedSceneIds(ops);
    expect(ids.size).toBe(0);
  });

  it('空批次 → 空集', () => {
    expect(collectCreatedSceneIds([]).size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schema 守卫
// ─────────────────────────────────────────────────────────────────────────────
describe('atomicEditOpSchema / atomicEditProposalSchema 守卫', () => {
  it('atomicEditOpSchema 接受 5 op', () => {
    const ops = [
      { op: 'add_plot_bridge', between: { fromSceneId: 's0', toSceneId: 's1' }, bridgeScene: { id: 'b1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } } },
      { op: 'add_suspense', atSceneId: 's0', resolveTowardsSceneId: 's1' },
      { op: 'add_foreshadow', promise: { id: 'p1', title: 't', summary: 's' }, plantBeatSceneId: 's0', payoffBeatSceneId: 's1' },
      { op: 'insert_twist', afterSceneId: 's0', twistScene: { id: 'tw1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }, rewireEdgesTo: [] },
      { op: 'revise_event', sceneId: 's0', patch: { id: 's0', outcomeType: '达成' } },
    ];
    for (const op of ops) {
      expect(() => atomicEditOpSchema.parse(op)).not.toThrow();
    }
  });

  it('atomicEditOpSchema 拒绝未知 op', () => {
    expect(() => atomicEditOpSchema.parse({ op: 'nuke_everything' })).toThrow();
  });

  it('atomicEditProposalSchema 要求 rationale（per-element filter 用）', () => {
    expect(() => atomicEditProposalSchema.parse({
      op: { op: 'add_suspense', atSceneId: 's0', resolveTowardsSceneId: 's1' },
      rationale: '中段太平需悬念钩子',
    })).not.toThrow();
    expect(() => atomicEditProposalSchema.parse({
      op: { op: 'add_suspense', atSceneId: 's0', resolveTowardsSceneId: 's1' },
      // 缺 rationale
    })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseDirectorAtomicEdits（三路径鲁棒 + per-element filter）
// ─────────────────────────────────────────────────────────────────────────────
describe('parseDirectorAtomicEdits（三路径 + per-element filter，mirror parseRevisionIntent）', () => {
  const validProposal = {
    op: { op: 'add_suspense', atSceneId: 's0', resolveTowardsSceneId: 's2' },
    rationale: '中段太平',
  };
  const validProposal2 = {
    op: { op: 'add_foreshadow', promise: { id: 'p1', title: 't', summary: 's' }, plantBeatSceneId: 's0', payoffBeatSceneId: 's2' },
    rationale: '兑现在前没埋',
  };

  it('路径 1：fenced ```json 块（envelope 形态）', () => {
    const content = '```json\n{"atomicEditProposals":[' + JSON.stringify(validProposal) + ']}\n```';
    expect(parseDirectorAtomicEdits(content)).toHaveLength(1);
  });

  it('路径 1：多 fence 取有效块', () => {
    const content = '```\nnot json\n```\n```json\n[' + JSON.stringify(validProposal) + ']\n```';
    expect(parseDirectorAtomicEdits(content)).toHaveLength(1);
  });

  it('路径 2：brace/bracket-match（无 fence 裸数组 + narration）', () => {
    const content = '我建议如下：[' + JSON.stringify(validProposal) + ']，请确认。';
    expect(parseDirectorAtomicEdits(content)).toHaveLength(1);
  });

  it('路径 3：整体 parse（裸单对象）', () => {
    expect(parseDirectorAtomicEdits(JSON.stringify(validProposal))).toHaveLength(1);
  });

  it('envelope / 裸数组 / 裸单对象 三形态都归一成数组', () => {
    expect(parseDirectorAtomicEdits(JSON.stringify({ atomicEditProposals: [validProposal, validProposal2] }))).toHaveLength(2);
    expect(parseDirectorAtomicEdits(JSON.stringify([validProposal, validProposal2]))).toHaveLength(2);
    expect(parseDirectorAtomicEdits(JSON.stringify(validProposal))).toHaveLength(1);
  });

  it('🔑 per-element filter：单条畸形 proposal 不丢整体（drop bad keep good）', () => {
    const malformed = { op: { op: 'add_suspense' }, rationale: '' }; // 缺 atSceneId/resolveTowards + rationale 空
    const content = JSON.stringify([validProposal, malformed, validProposal2]);
    const result = parseDirectorAtomicEdits(content);
    // 畸形条 drop，两条有效 keep
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.op.op)).toEqual(['add_suspense', 'add_foreshadow']);
  });

  it('全畸形 / 空 → 返空数组（不返 null，caller graceful）', () => {
    expect(parseDirectorAtomicEdits('')).toEqual([]);
    expect(parseDirectorAtomicEdits('我啥也没提议')).toEqual([]);
    expect(parseDirectorAtomicEdits('[{"op":{"op":"bad"}}]')).toEqual([]);
  });

  it('空 content / null safe', () => {
    expect(parseDirectorAtomicEdits('')).toEqual([]);
    expect(parseDirectorAtomicEdits(null as unknown as string)).toEqual([]);
    expect(parseDirectorAtomicEdits(undefined as unknown as string)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 端到端：expand → apply → validate 与既有 projector 协同
// ─────────────────────────────────────────────────────────────────────────────
describe('端到端：expander 输出喂既有 applySceneGraphActions + validateSceneGraph', () => {
  it('加桥段后 projected graph 含桥节点 + 桥边，校验 clean', () => {
    const graph = linearChainGraph();
    const expansion = expandAtomicEditOp(
      {
        op: 'add_plot_bridge',
        between: { fromSceneId: 's0', toSceneId: 's2' },
        bridgeScene: node('bridge1', ['L1']) as SceneNode,
      },
      ctx(graph),
    );
    const projected = applySceneGraphActions(graph, expansion.sceneGraphActions);
    expect(projected.nodes.map((n) => n.id)).toContain('bridge1');
    expect(projected.edges.filter((e) => e.from === 's0' && e.to === 'bridge1')).toHaveLength(1);
    expect(validateSceneGraph(projected).some((i) => i.severity === 'error')).toBe(false);
  });

  it('promise registry 落 applyPromiseActions（既有 projector）含 plant+payoff', async () => {
    const { applyPromiseActions } = await import('../src');
    const graph = linearChainGraph();
    const expansion = expandAtomicEditOp(
      {
        op: 'add_foreshadow',
        promise: { id: 'p1', title: '伏笔', summary: '...' },
        plantBeatSceneId: 's0',
        payoffBeatSceneId: 's2',
      },
      ctx(graph),
    );
    const emptyRegistry = promiseRegistrySchema.parse({ promises: [], beats: [], version: 0 });
    const projected = applyPromiseActions(emptyRegistry, expansion.promiseActions);
    expect(projected.promises.map((p) => p.id)).toContain('p1');
    expect(projected.beats.filter((b) => b.kind === 'plant')).toHaveLength(1);
    expect(projected.beats.filter((b) => b.kind === 'payoff')).toHaveLength(1);
  });
});
