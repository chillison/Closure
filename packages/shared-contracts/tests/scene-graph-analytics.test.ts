import { describe, expect, it } from 'vitest';
import {
  sceneGraphSchema,
  sceneEdgeSchema,
  detectCausalCycle,
  checkReachability,
  checkMeshMapping,
  findIsolatedNodes,
  getValidationProfile,
  validateSceneGraph,
  applySceneGraphActions,
  expandForkBranch,
  canonDiff,
  isSceneInEpisode,
  selectScenesForEpisode,
  scenesByAssetRef,
  scenesByLine,
  linesByAssetRef,
  type SceneGraph,
  type SceneNode,
  type LineTopologyRole
} from '../src';

// ── helpers ──
function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

const node = (id: string, lineTags: string[] = []) => ({
  id,
  lineTags,
  storyTime: 0,
  presentationOrder: { chapter: 0, pos: 0 }
});

const causal = (id: string, from: string, to: string) => ({ id, from, to, type: 'CAUSAL' as const });
const suspense = (id: string, from: string, to: string) => ({ id, from, to, type: 'SUSPENSE' as const });

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 回归：edge 收口（design §6 / D1）
// ─────────────────────────────────────────────────────────────────────────────
describe('sceneEdgeTypeSchema 边收口（Story 1.3 §6）', () => {
  it('接受 CAUSAL / SUSPENSE', () => {
    expect(sceneEdgeSchema.parse({ id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' }).type).toBe('CAUSAL');
    expect(sceneEdgeSchema.parse({ id: 'e2', from: 's1', to: 's2', type: 'SUSPENSE' }).type).toBe('SUSPENSE');
  });

  it('拒绝已裁类型 FORESHADOW / REVERSAL / SHARED-MOTIF / WORLD-COUPLING', () => {
    for (const type of ['FORESHADOW', 'REVERSAL', 'SHARED-MOTIF', 'WORLD-COUPLING']) {
      expect(() => sceneEdgeSchema.parse({ id: 'e1', from: 's1', to: 's2', type })).toThrow();
    }
  });

  it('art_overrides 默认空数组', () => {
    expect(parseGraph({}).art_overrides).toEqual([]);
  });

  it('art_overrides 接受 check + 可选 scope / reason', () => {
    const g = parseGraph({
      art_overrides: [
        { check: 'causal-cycle' },
        { check: 'unreachable-line', scope: 's3', reason: '林奇式故意断链' }
      ]
    });
    expect(g.art_overrides).toHaveLength(2);
    expect(g.art_overrides[1].scope).toBe('s3');
  });

  it('art_overrides 拒绝空 check', () => {
    expect(() => parseGraph({ art_overrides: [{ check: '' }] })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2b：detectCausalCycle（design §3.1）
// ─────────────────────────────────────────────────────────────────────────────
describe('detectCausalCycle（CAUSAL+SUSPENSE 前向边 DAG 无环，§3.1）', () => {
  it('空 graph 无 issue', () => {
    expect(detectCausalCycle(parseGraph({}))).toEqual([]);
  });

  it('无环因果链通过', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2'), node('s3')],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's3')]
    });
    expect(detectCausalCycle(g)).toEqual([]);
  });

  it('CAUSAL 环 → error', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's1')]
    });
    const issues = detectCausalCycle(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('causal-cycle');
    expect(issues[0].severity).toBe('error');
    const ids = issues[0].targets.map((t) => t.id).sort();
    expect(ids).toEqual(['s1', 's2']);
    expect(issues[0].targets.every((t) => t.kind === 'node')).toBe(true);
  });

  it('SUSPENSE 环 → error（SUSPENSE 也进 DAG）', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [suspense('e1', 's1', 's2'), suspense('e2', 's2', 's1')]
    });
    expect(detectCausalCycle(g)).toHaveLength(1);
    expect(detectCausalCycle(g)[0].code).toBe('causal-cycle');
  });

  it('CAUSAL + SUSPENSE 混合环 → error', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2'), suspense('e2', 's2', 's1')]
    });
    expect(detectCausalCycle(g)).toHaveLength(1);
  });

  it('自环 → error（单节点环）', () => {
    const g = parseGraph({
      nodes: [node('s1')],
      edges: [causal('e1', 's1', 's1')]
    });
    const issues = detectCausalCycle(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].targets.map((t) => t.id)).toEqual(['s1']);
  });

  it('两个独立环 → 2 个 issue', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2'), node('s3'), node('s4')],
      edges: [
        causal('e1', 's1', 's2'), causal('e2', 's2', 's1'),
        causal('e3', 's3', 's4'), causal('e4', 's4', 's3')
      ]
    });
    expect(detectCausalCycle(g)).toHaveLength(2);
  });

  it('叙事语言 message（非图论术语）', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's1')]
    });
    const msg = detectCausalCycle(g)[0].message;
    expect(msg).not.toContain('DAG');
    expect(msg).not.toContain('cycle');
    expect(msg.length).toBeGreaterThan(0);
    expect(typeof detectCausalCycle(g)[0].suggestion).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2c：checkReachability（design §3.2）
// ─────────────────────────────────────────────────────────────────────────────
describe('checkReachability（Type1 converging 多根可达，§3.2）', () => {
  it('无 converging 线时 no-op', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2')]
    });
    expect(checkReachability(g)).toEqual([]);
  });

  it('converging 线所有节点可达 target → 无 issue', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1']), node('s2', ['l1']), node('s3', ['l1'])],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's3')],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', convergence_target: 's3' }]
    });
    expect(checkReachability(g)).toEqual([]);
  });

  it('多根（多源）各可达 target → 无 issue', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1']), node('s2', ['l1']), node('t', ['l1'])],
      edges: [causal('e1', 's1', 't'), causal('e2', 's2', 't')],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', convergence_target: 't' }]
    });
    expect(checkReachability(g)).toEqual([]);
  });

  it('converging 线节点不可达 target → warning unreachable-line', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1']), node('s2', ['l1']), node('s3', ['l1']), node('t', ['l1'])],
      // s1/s2 可达 t，s3 无路径接不上 t
      edges: [causal('e1', 's1', 't'), causal('e2', 's2', 't')],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', convergence_target: 't' }]
    });
    const issues = checkReachability(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('unreachable-line');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].targets.map((t) => t.id)).toEqual(['s3']);
    expect(issues[0].message).toContain('主线');
  });

  it('offline / if-branch / side 线豁免（即使结构上不可达也不报）', () => {
    for (const role of ['offline', 'if-branch', 'side'] as const) {
      const g = parseGraph({
        nodes: [node('s1', ['l1']), node('s2', ['l1'])],
        // s1 接不上 s2
        edges: [],
        lines: [{ id: 'l1', name: '线', topology_role: role, convergence_target: 's2' }]
      });
      expect(checkReachability(g)).toEqual([]);
    }
  });

  it('converging 线无 convergence_target → warning missing-convergence-target', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1']), node('s2', ['l1'])],
      edges: [],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }]
    });
    const issues = checkReachability(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('missing-convergence-target');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].targets).toEqual([{ kind: 'line', id: 'l1' }]);
    expect(issues[0].message).toContain('主线');
  });

  it('converging 线无节点不校验', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2')],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', convergence_target: 's2' }]
    });
    expect(checkReachability(g)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2d：checkMeshMapping（design §3.3）
// ─────────────────────────────────────────────────────────────────────────────
describe('checkMeshMapping（Type2 parallel-worldview 映射存在性，§3.3）', () => {
  it('无 parallel-worldview 线时 no-op', () => {
    const g = parseGraph({
      nodes: [],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }]
    });
    expect(checkMeshMapping(g)).toEqual([]);
  });

  it('parallel-worldview 线有 worldEventRef → 无 issue', () => {
    const g = parseGraph({
      lines: [{ id: 'l1', name: '网状线', topology_role: 'parallel-worldview', worldEventRef: 'event_a' }]
    });
    expect(checkMeshMapping(g)).toEqual([]);
  });

  it('parallel-worldview 线有 themeRef → 无 issue', () => {
    const g = parseGraph({
      lines: [{ id: 'l1', name: '网状线', topology_role: 'parallel-worldview', themeRef: 'theme_red' }]
    });
    expect(checkMeshMapping(g)).toEqual([]);
  });

  it('parallel-worldview 线既无 worldEventRef 也无 themeRef → warning missing-mesh-mapping', () => {
    const g = parseGraph({
      lines: [{ id: 'l1', name: '孤儿网状线', topology_role: 'parallel-worldview' }]
    });
    const issues = checkMeshMapping(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('missing-mesh-mapping');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].targets).toEqual([{ kind: 'line', id: 'l1' }]);
    expect(issues[0].message).toContain('孤儿网状线');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2e：getValidationProfile（design §3.4，1.2 声明 1.3 实现）
// ─────────────────────────────────────────────────────────────────────────────
describe('getValidationProfile（topology_role → profile dispatch，§3.4）', () => {
  const cases: Array<{ role: LineTopologyRole; mainline: boolean; mesh: boolean; exempt: boolean }> = [
    { role: 'converging', mainline: true, mesh: false, exempt: false },
    { role: 'parallel-worldview', mainline: false, mesh: true, exempt: false },
    { role: 'offline', mainline: false, mesh: false, exempt: true },
    { role: 'if-branch', mainline: false, mesh: false, exempt: true },
    { role: 'side', mainline: false, mesh: false, exempt: true }
  ];

  it('5 型 topology_role 各自 profile 正确', () => {
    for (const c of cases) {
      const p = getValidationProfile(c.role);
      expect(p.mainlineReachability).toBe(c.mainline);
      expect(p.meshMapping).toBe(c.mesh);
      expect(p.exempt).toBe(c.exempt);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2f / 3e / 3f：validateSceneGraph 编排 + art_overrides + 1.2 回归
// ─────────────────────────────────────────────────────────────────────────────
describe('validateSceneGraph（编排 + art_overrides 降级 + dangling 回归，§3.5/§5）', () => {
  it('空 graph 无 issue', () => {
    expect(validateSceneGraph(parseGraph({}))).toEqual([]);
  });

  it('汇总因果环 + 不可达 + 缺映射 + dangling（多类 issue 共存）', () => {
    const g = parseGraph({
      nodes: [
        node('s1', ['l_main']), node('s2', ['l_main']),   // 环 + 主线
        node('s3', ['l_main']),                             // 不可达 target
        node('sX', ['ghost'])                              // dangling tag
      ],
      edges: [
        causal('e1', 's1', 's2'), causal('e2', 's2', 's1')  // s1↔s2 环
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', convergence_target: 's3' },
        { id: 'l_mesh', name: '网状线', topology_role: 'parallel-worldview' } // 缺映射
      ]
    });
    const issues = validateSceneGraph(g);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('causal-cycle');
    expect(codes).toContain('unreachable-line');
    expect(codes).toContain('missing-mesh-mapping');
    expect(codes).toContain('dangling-line-tag');
    // 因果环 = error，其余按设计 warning
    expect(issues.find((i) => i.code === 'causal-cycle')!.severity).toBe('error');
    expect(issues.find((i) => i.code === 'unreachable-line')!.severity).toBe('warning');
    expect(issues.find((i) => i.code === 'missing-mesh-mapping')!.severity).toBe('warning');
    expect(issues.find((i) => i.code === 'dangling-line-tag')!.severity).toBe('warning');
  });

  it('findDanglingLineTags 经 validateSceneGraph 结构化为 dangling-line-tag issue（1.2 回归）', () => {
    // 08-26 批 5：+s0 与 e0→s1 让 s1 非孤立（isolated-node 新规则不混入本断言）。
    const g = parseGraph({
      nodes: [node('s0', ['l1']), node('s1', ['l1', 'ghost'])],
      edges: [causal('e0', 's0', 's1')],
      lines: [{ id: 'l1', name: '主线', convergence_target: 's1' }]
    });
    const issues = validateSceneGraph(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('dangling-line-tag');
    expect(issues[0].targets).toEqual([{ kind: 'node', id: 's1' }]);
  });

  it('art_overrides 无 scope → 命中 check 全降级 info', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's1')],
      art_overrides: [{ check: 'causal-cycle', reason: '林奇式故意环' }]
    });
    const issues = validateSceneGraph(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
  });

  it('art_overrides 有 scope → 仅命中 target.id 的 issue 降级，其它同 code 保留 error', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2'), node('s3'), node('s4')],
      edges: [
        causal('e1', 's1', 's2'), causal('e2', 's2', 's1'),   // 环 A：s1,s2
        causal('e3', 's3', 's4'), causal('e4', 's4', 's3')    // 环 B：s3,s4
      ],
      art_overrides: [{ check: 'causal-cycle', scope: 's1,s2' }]
    });
    const issues = validateSceneGraph(g);
    const cycleA = issues.find((i) => i.targets.some((t) => t.id === 's1'));
    const cycleB = issues.find((i) => i.targets.some((t) => t.id === 's3'));
    expect(cycleA?.severity).toBe('info');
    expect(cycleB?.severity).toBe('error');
  });

  it('art_overrides 不命中的 check 不影响', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's1')],
      art_overrides: [{ check: 'unreachable-line' }] // 不匹配因果环
    });
    const issues = validateSceneGraph(g);
    expect(issues[0].severity).toBe('error');
  });

  it('校验全部确定性（同输入同输出）— 同图跑两次 issue 列表深相等', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1']), node('s2', ['l1']), node('s3', ['l1'])],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's3')],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', convergence_target: 's3' }]
    });
    expect(validateSceneGraph(g)).toEqual(validateSceneGraph(g));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: applySceneGraphActions edit-path projection (design §1.2 / §4)
// ─────────────────────────────────────────────────────────────────────────────
describe('applySceneGraphActions edit-path 投影（Story 1.3 §1.2）', () => {
  it('add_scene 新增（partial 填机械默认，结果 schema-valid）', () => {
    const g = parseGraph({});
    const out = applySceneGraphActions(g, [
      { op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } }
    ]);
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0]).toMatchObject({
      id: 's1',
      lineTags: ['l1'],
      storyTime: 0,
      role: 'normal',
      presentationOrder: { chapter: 0, pos: 0 }
    });
    // 投影后整体仍 schema-valid（落盘 reload 不 corrupt）
    expect(() => sceneGraphSchema.parse(out)).not.toThrow();
  });

  it('add_scene 已存在 id = 浅合并（不丢既有字段）', () => {
    const g = parseGraph({
      nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 5, presentationOrder: { chapter: 2, pos: 1 }, role: 'normal' }]
    });
    const out = applySceneGraphActions(g, [
      { op: 'add_scene', scene: { id: 's1', role: 'core-anchor' } }
    ]);
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0]).toMatchObject({ id: 's1', storyTime: 5, presentationOrder: { chapter: 2, pos: 1 }, role: 'core-anchor', lineTags: ['l1'] });
  });

  it('update_scene 浅合并 partial；update 不存在 id = no-op', () => {
    const g = parseGraph({
      nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 3, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' }]
    });
    const out = applySceneGraphActions(g, [
      { op: 'update_scene', scene: { id: 's1', storyTime: 9 } },
      { op: 'update_scene', scene: { id: 'ghost', storyTime: 1 } }
    ]);
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].storyTime).toBe(9);
    expect(out.nodes[0].lineTags).toEqual(['l1']);
  });

  it('remove_scene 按 id 过滤；不存在 no-op；不级联（残留 edge 保留）', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2')]
    });
    const out = applySceneGraphActions(g, [
      { op: 'remove_scene', id: 's1' },
      { op: 'remove_scene', id: 'ghost' }
    ]);
    expect(out.nodes.map((n) => n.id)).toEqual(['s2']);
    // 残留 edge 保留（机械、不级联——校验层暴露）
    expect(out.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('add_edge 新增 / 已存在合并；remove_edge 过滤', () => {
    const g = parseGraph({ nodes: [node('s1'), node('s2')], edges: [causal('e1', 's1', 's2')] });
    const out = applySceneGraphActions(g, [
      { op: 'add_edge', edge: { id: 'e2', from: 's2', to: 's1', type: 'SUSPENSE' } },
      { op: 'add_edge', edge: { id: 'e1', type: 'SUSPENSE' } },
      { op: 'remove_edge', id: 'e2' }
    ]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].id).toBe('e1');
    expect(out.edges[0].type).toBe('SUSPENSE');
  });

  it('add_line 新增（partial 填默认 topology_role/displacement/visibility）', () => {
    const g = parseGraph({});
    const out = applySceneGraphActions(g, [
      { op: 'add_line', line: { id: 'l1', name: '主线', convergence_target: 's1' } }
    ]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatchObject({
      id: 'l1', name: '主线', topology_role: 'converging',
      displacement: 'none', visibility: { status: 'open' }, convergence_target: 's1'
    });
    expect(() => sceneGraphSchema.parse(out)).not.toThrow();
  });

  it('update_line 浅合并；remove_line 过滤', () => {
    const g = parseGraph({
      lines: [
        { id: 'l1', name: '主线', topology_role: 'converging', displacement: 'none', visibility: { status: 'open' } },
        { id: 'l2', name: '支线', topology_role: 'side', displacement: 'none', visibility: { status: 'open' } }
      ]
    });
    const out = applySceneGraphActions(g, [
      { op: 'update_line', line: { id: 'l1', topology_role: 'parallel-worldview' } },
      { op: 'remove_line', id: 'l2' }
    ]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].id).toBe('l1');
    expect(out.lines[0].topology_role).toBe('parallel-worldview');
    expect(out.lines[0].name).toBe('主线');
  });

  it('多 action 序列：投影后跑 validateSceneGraph 形成闭环（环被检出）', () => {
    const g = parseGraph({});
    const out = applySceneGraphActions(g, [
      { op: 'add_scene', scene: { id: 's1', storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } } },
      { op: 'add_scene', scene: { id: 's2', storyTime: 2, presentationOrder: { chapter: 0, pos: 1 } } },
      { op: 'add_edge', edge: { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' } },
      { op: 'add_edge', edge: { id: 'e2', from: 's2', to: 's1', type: 'CAUSAL' } } // 环
    ]);
    const issues = validateSceneGraph(out);
    expect(issues.some((i) => i.code === 'causal-cycle' && i.severity === 'error')).toBe(true);
  });

  it('保留既有 art_overrides / version / updatedBy（非 nodes/edges/lines 字段）', () => {
    const g = parseGraph({
      nodes: [node('s1')],
      art_overrides: [{ check: 'causal-cycle' }],
      version: 7,
      updatedBy: 'user'
    });
    const out = applySceneGraphActions(g, [{ op: 'remove_scene', id: 'nope' }]);
    expect(out.art_overrides).toEqual([{ check: 'causal-cycle' }]);
    expect(out.version).toBe(7);
    expect(out.updatedBy).toBe('user');
  });

  it('空 actions 返回结构相等的新对象（不变动原 graph）', () => {
    const g = parseGraph({ nodes: [node('s1')] });
    const out = applySceneGraphActions(g, []);
    expect(out.nodes).toEqual(g.nodes);
    expect(out).not.toBe(g); // 新对象（不可变）
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-010/CR-016: edge/target 引用完整性 + remove_scene 不级联残留暴露
// ─────────────────────────────────────────────────────────────────────────────
describe('dangling-edge-endpoint + dangling-convergence-target（CR-010/CR-016）', () => {
  it('edge.from/to 指向不存在 node -> warning dangling-edge-endpoint', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [
        causal('e1', 's1', 's2'),
        causal('e2', 's1', 'ghost'),   // ghost 不存在
        causal('e3', 'phantom', 's2'), // phantom 不存在
      ]
    });
    const issues = validateSceneGraph(g);
    const dangling = issues.filter((i) => i.code === 'dangling-edge-endpoint');
    expect(dangling).toHaveLength(2);
    expect(dangling.every((i) => i.severity === 'warning')).toBe(true);
    expect(dangling.some((i) => i.targets[0].id === 'e2')).toBe(true);
    expect(dangling.some((i) => i.targets[0].id === 'e3')).toBe(true);
    expect(dangling.every((i) => i.targets[0].kind === 'edge')).toBe(true);
  });

  it('remove_scene 不级联 -> 残留 edge 由 dangling-edge-endpoint 暴露', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2')]
    });
    // 模拟 remove_scene s1 后：node 没了但 edge 还在（不级联，design 选择）
    const after = applySceneGraphActions(g, [{ op: 'remove_scene', id: 's1' }]);
    const issues = validateSceneGraph(after);
    const dangling = issues.filter((i) => i.code === 'dangling-edge-endpoint');
    expect(dangling).toHaveLength(1);
    expect(dangling[0].targets[0].id).toBe('e1');
  });

  it('converging 线 convergence_target 指向不存在 node -> warning dangling-convergence-target（非 unreachable-line）', () => {
    const g = parseGraph({
      nodes: [node('s1', ['l1']), node('s2', ['l1'])],
      edges: [causal('e1', 's1', 's2')],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', convergence_target: 'gone' }]
    });
    const issues = checkReachability(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('dangling-convergence-target');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].targets).toEqual([{ kind: 'line', id: 'l1' }]);
    // 区别于 unreachable-line：target 本身不存在，不是链断
    expect(issues.some((i) => i.code === 'unreachable-line')).toBe(false);
  });

  it('edge 端点全解析到 node -> 无 dangling-edge-endpoint', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2')]
    });
    expect(validateSceneGraph(g).some((i) => i.code === 'dangling-edge-endpoint')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 08-26 结构页重构 批 5（dogfood R2 #34）：isolated-node —— 无任何连边的节点 → info
// （孤立 ≠ 错，草稿合法；无线可数 = 结构判定非语义，ADR-3 纯代码）
// ─────────────────────────────────────────────────────────────────────────────
describe('isolated-node（#34：无连边节点 → info 提示）', () => {
  it('无任何连边的节点 -> info isolated-node（node target + 叙事语言 message）', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2')],
    });
    // +s_lone 无边 -> 孤立。
    const g2 = applySceneGraphActions(g, [{ op: 'add_scene', scene: { id: 's_lone' } }]);
    const issues = validateSceneGraph(g2).filter((i) => i.code === 'isolated-node');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    expect(issues[0].targets).toEqual([{ kind: 'node', id: 's_lone' }]);
    expect(issues[0].message).toContain('s_lone');
    expect(issues[0].suggestion).toBeTruthy();
  });

  it('连通节点不受扰（from 或 to 任一触及即非孤立）', () => {
    const g = parseGraph({
      // s_src 仅有出边、s_end 仅有入边、s_both 两向、s_mid 中继——全触及。
      nodes: [node('s_src'), node('s_mid'), node('s_end'), node('s_both')],
      edges: [
        causal('e0', 's_src', 's_mid'),
        causal('e1', 's_mid', 's_end'),
        causal('e2', 's_end', 's_both'),
      ]
    });
    expect(validateSceneGraph(g).some((i) => i.code === 'isolated-node')).toBe(false);
  });

  it('孤立是 info 非 warning/error——不进 blocking 语义（草稿合法）', () => {
    const g = parseGraph({ nodes: [node('solo'), node('solo2')], edges: [] });
    const issues = validateSceneGraph(g);
    expect(issues.every((i) => i.code === 'isolated-node')).toBe(true);
    expect(issues.every((i) => i.severity === 'info')).toBe(true);
    expect(issues).toHaveLength(2);
  });

  it('findIsolatedNodes 纯函数：空图/全连通返空', () => {
    expect(findIsolatedNodes(parseGraph({}))).toEqual([]);
    const connected = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2')]
    });
    expect(findIsolatedNodes(connected)).toEqual([]);
  });

  // ── BMad CR 组4：重复 node id 去重 + 消息可读名（title ?? id）──

  it('重复 node id 的损坏图 → isolated-node 同 id 只报一次（seenIds 去重）', () => {
    // schema 不强制 nodes[].id 唯一（手编 yaml/同步冲突可产）——旧实现逐条同 id
    // 报两遍（角标计数虚高 + prompt 注入同质行）。
    const g = parseGraph({
      nodes: [node('dup'), { ...node('dup'), title: '第二次出现的同名节点' }, node('other')],
      edges: [],
    });
    const issues = validateSceneGraph(g).filter((i) => i.code === 'isolated-node');
    expect(issues).toHaveLength(2); // dup 一条 + other 一条，不是三条
    expect(issues[0]!.targets).toEqual([{ kind: 'node', id: 'dup' }]);
    expect(issues[1]!.targets).toEqual([{ kind: 'node', id: 'other' }]);
  });

  it('isolated-node message 用 title ?? id（author 可读名优先；无标题回退 id）', () => {
    const g = parseGraph({
      nodes: [{ ...node('s_t'), title: '深夜的访客' }, node('s_raw')],
      edges: [],
    });
    const issues = validateSceneGraph(g).filter((i) => i.code === 'isolated-node');
    expect(issues.find((i) => i.targets[0]!.id === 's_t')!.message).toContain('深夜的访客');
    // 无标题节点回退 id（既有行为不回退——断言锚保持）。
    expect(issues.find((i) => i.targets[0]!.id === 's_raw')!.message).toContain('s_raw');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-011/CR-005: detectCausalCycle 显式栈迭代（深链不溢出）
// ─────────────────────────────────────────────────────────────────────────────
describe('detectCausalCycle 深链不溢出（CR-011/CR-005，显式栈迭代）', () => {
  it('5000 节点线性 CAUSAL 链不栈溢出 + 正确判无环', () => {
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 5000; i++) {
      nodes.push(node(`s${i}`));
      if (i > 0) edges.push(causal(`e${i}`, `s${i - 1}`, `s${i}`));
    }
    const g = parseGraph({ nodes, edges });
    // 递归实现会栈溢出 -> 被上游 catch 吞掉漏报；显式栈迭代正常返回空。
    expect(detectCausalCycle(g)).toEqual([]);
  });

  it('深链末端含环仍正确报环', () => {
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 5000; i++) {
      nodes.push(node(`s${i}`));
      if (i > 0) edges.push(causal(`e${i}`, `s${i - 1}`, `s${i}`));
    }
    // 末端绕回开头形成环
    edges.push(causal('e_cycle', 's4999', 's0'));
    const g = parseGraph({ nodes, edges });
    const issues = detectCausalCycle(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('causal-cycle');
    expect(issues[0].severity).toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-012: art_overrides 按 target 集合实例级匹配（共享 node 不连带静音）
// ─────────────────────────────────────────────────────────────────────────────
describe('art_overrides 整 target 集合匹配（CR-012）', () => {
  it('两个同 code issue 共享某 node -> override 一个不连带静音另一个', () => {
    // 环 A: s1<->s2；环 B: s1<->s3（共享 s1，但结构不同）
    const g = parseGraph({
      nodes: [node('s1'), node('s2'), node('s3')],
      edges: [
        causal('e1', 's1', 's2'), causal('e2', 's2', 's1'),   // 环 A：s1,s2
        causal('e3', 's1', 's3'), causal('e4', 's3', 's1')    // 环 B：s1,s3
      ],
      // scope = 环 A 整 target 集合签名 's1,s2'，只豁免环 A
      art_overrides: [{ check: 'causal-cycle', scope: 's1,s2' }]
    });
    const issues = validateSceneGraph(g);
    const cycleA = issues.find((i) => i.targets.some((t) => t.id === 's2') && i.targets.some((t) => t.id === 's1'));
    const cycleB = issues.find((i) => i.targets.some((t) => t.id === 's3'));
    expect(cycleA?.severity).toBe('info');   // 命中 override
    expect(cycleB?.severity).toBe('error');  // 共享 s1 但 target 集合不同 -> 不连带静音
  });

  it('art_overrides 无 scope -> 命中 check 全降级（语义不变）', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's1')],
      art_overrides: [{ check: 'causal-cycle' }]
    });
    expect(validateSceneGraph(g)[0].severity).toBe('info');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.7 Step 2: expandForkBranch（纯代码 fork expander，design §2.3）
// ─────────────────────────────────────────────────────────────────────────────
describe('expandForkBranch（IF branch fork expander，Story 1.7 §2.3）', () => {
  // 主线 fixture：P(fork-point) → N2 → N3，is_main_thread
  function mainThreadGraph(): SceneGraph {
    return parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'N3', lineTags: ['l_main'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
      ],
      edges: [
        causal('e_P_N2', 'P', 'N2'),
        causal('e_N2_N3', 'N2', 'N3'),
      ],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
  }

  const forkAction = {
    op: 'fork_branch' as const,
    fork_from_scene_id: 'P',
    branch_line_id: 'br_a',
    branch_line_name: 'IF：主角接受'
  };

  it('拷贝 P 之后同主线节点（N2, N3），不含 P 自身', () => {
    const actions = expandForkBranch(mainThreadGraph(), forkAction);
    const addScene = actions.filter((a) => a.op === 'add_scene');
    const copyIds = addScene.map((a) => (a as { scene: { id: string } }).scene.id).sort();
    expect(copyIds).toEqual(['N2__br_a', 'N3__br_a']);
  });

  it('origin_ref 指向 canon 源', () => {
    const actions = expandForkBranch(mainThreadGraph(), forkAction);
    const n2Copy = actions.find(
      (a) => a.op === 'add_scene' && (a as { scene: { id: string } }).scene.id === 'N2__br_a'
    ) as { scene: { origin_ref?: string } } | undefined;
    expect(n2Copy?.scene.origin_ref).toBe('N2');
  });

  it('拷贝节点 lineTags = [branch_line_id] + role 降级 normal', () => {
    const actions = expandForkBranch(mainThreadGraph(), forkAction);
    const n2Copy = actions.find(
      (a) => a.op === 'add_scene' && (a as { scene: { id: string } }).scene.id === 'N2__br_a'
    ) as { scene: { lineTags?: string[]; role?: string } } | undefined;
    expect(n2Copy?.scene.lineTags).toEqual(['br_a']);
    expect(n2Copy?.scene.role).toBe('normal');
  });

  it('ID 确定性：${canonId}__${branchLineId}', () => {
    const actions = expandForkBranch(mainThreadGraph(), forkAction);
    const ids = actions.filter((a) => a.op === 'add_scene').map((a) => (a as { scene: { id: string } }).scene.id);
    expect(ids).toContain('N2__br_a');
    expect(ids).toContain('N3__br_a');
    // 同输入再跑一次 → 完全一致（确定性，可重生/可追溯）
    expect(expandForkBranch(mainThreadGraph(), forkAction)).toEqual(actions);
  });

  it('下游集内部边重映到拷贝 id（N2__br_a → N3__br_a）', () => {
    const actions = expandForkBranch(mainThreadGraph(), forkAction);
    const inner = actions.find(
      (a) => a.op === 'add_edge' &&
        (a as { edge: { from: string; to: string } }).edge.from === 'N2__br_a' &&
        (a as { edge: { to: string } }).edge.to === 'N3__br_a'
    ) as { edge: { type: string } } | undefined;
    expect(inner).toBeDefined();
    expect(inner?.edge.type).toBe('CAUSAL');
  });

  it('fork 入边：P(canon) → 首 branch 拷贝', () => {
    const actions = expandForkBranch(mainThreadGraph(), forkAction);
    const forkInEdge = actions.find(
      (a) => a.op === 'add_edge' &&
        (a as { edge: { from: string; to: string } }).edge.from === 'P' &&
        (a as { edge: { to: string } }).edge.to === 'N2__br_a'
    ) as { edge: { type: string } } | undefined;
    expect(forkInEdge).toBeDefined();
    expect(forkInEdge?.edge.type).toBe('CAUSAL');
  });

  it('add_line：branch_line_id + topology_role if-branch + name', () => {
    const actions = expandForkBranch(mainThreadGraph(), forkAction);
    const addLine = actions.find((a) => a.op === 'add_line') as { line: { id: string; name?: string; topology_role?: string } } | undefined;
    expect(addLine?.line.id).toBe('br_a');
    expect(addLine?.line.name).toBe('IF：主角接受');
    expect(addLine?.line.topology_role).toBe('if-branch');
  });

  it('branch_line_name 缺省 → 用 branch_line_id 作 name', () => {
    const actions = expandForkBranch(mainThreadGraph(), {
      op: 'fork_branch',
      fork_from_scene_id: 'P',
      branch_line_id: 'br_a'
    });
    const addLine = actions.find((a) => a.op === 'add_line') as { line: { name?: string } } | undefined;
    expect(addLine?.line.name).toBe('br_a');
  });

  it('群像退化：无 is_main_thread → fork-point 所在 Line 节点仍拷贝', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_a'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_a'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      ],
      edges: [causal('e1', 'P', 'N2')],
      lines: [{ id: 'l_a', name: '线A', topology_role: 'converging' }]  // 无 is_main_thread
    });
    const actions = expandForkBranch(g, forkAction);
    const copyIds = actions.filter((a) => a.op === 'add_scene').map((a) => (a as { scene: { id: string } }).scene.id);
    expect(copyIds).toContain('N2__br_a');
  });

  it('空下游：P 无后续 → 仅 add_line（空 branch 合法）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
      ],
      edges: [],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, forkAction);
    expect(actions.filter((a) => a.op === 'add_scene')).toHaveLength(0);
    expect(actions.filter((a) => a.op === 'add_line')).toHaveLength(1);
    expect(actions.filter((a) => a.op === 'add_edge')).toHaveLength(0);
  });

  it('fork-point 不存在 → 仍声明 add_line（空 branch），校验层报 fork-point 非法', () => {
    const g = parseGraph({
      nodes: [],
      edges: [],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, forkAction);
    expect(actions).toHaveLength(1);
    expect(actions[0].op).toBe('add_line');
  });

  it('expander 输出经 applySceneGraphActions 投影后 graph schema-valid', () => {
    const g = mainThreadGraph();
    const actions = expandForkBranch(g, forkAction);
    const projected = applySceneGraphActions(g, actions);
    expect(() => sceneGraphSchema.parse(projected)).not.toThrow();
    // 拷贝节点确实落盘
    expect(projected.nodes.map((n) => n.id)).toContain('N2__br_a');
    expect(projected.lines.map((l) => l.id)).toContain('br_a');
  });

  it('fork-point 之后的非主线节点不拷贝（限 main-thread 子图）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'SIDE', lineTags: ['l_side'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
      ],
      edges: [
        causal('e1', 'P', 'N2'),
        causal('e2', 'N2', 'SIDE'),  // SIDE 不在主线 → 不拷贝
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '旁线', topology_role: 'side' }
      ]
    });
    const actions = expandForkBranch(g, forkAction);
    const copyIds = actions.filter((a) => a.op === 'add_scene').map((a) => (a as { scene: { id: string } }).scene.id);
    expect(copyIds).toContain('N2__br_a');
    expect(copyIds).not.toContain('SIDE__br_a');
  });

  it('SUSPENSE 前向边也进 fork 拷贝（同 CAUSAL）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      ],
      edges: [suspense('e1', 'P', 'N2')],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, forkAction);
    const forkEdge = actions.find(
      (a) => a.op === 'add_edge' &&
        (a as { edge: { from: string } }).edge.from === 'P'
    ) as { edge: { type: string } } | undefined;
    expect(forkEdge?.edge.type).toBe('SUSPENSE');
  });

  it('canon 节点不被改动（独立 ID = 写保护）', () => {
    const g = mainThreadGraph();
    const before = JSON.parse(JSON.stringify(g));
    const actions = expandForkBranch(g, forkAction);
    // expander 只产出 actions，不原地改 graph
    expect(g).toEqual(before);
    // canon 节点 id 在 actions 里只作为 origin_ref / edge.from 出现，无 update_scene 触及 canon id
    const touchesCanon = actions.filter(
      (a) => (a.op === 'update_scene' || a.op === 'remove_scene') && (a as { id?: string }).id !== undefined
    );
    expect(touchesCanon).toHaveLength(0);
  });

  // ── Story 1.8：branch 拷贝继承 canon 的 presentationSpans（跨章发布交汇） ──
  it('Story 1.8：branch 拷贝继承 canon 的 presentationSpans；canon 无 spans 则拷贝也不带', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        {
          id: 'N2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal',
          presentationSpans: [{ episodeId: 'ep_a', pos: 0 }, { episodeId: 'ep_b', pos: 1 }]
        },
        { id: 'N3', lineTags: ['l_main'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
      ],
      edges: [causal('e_P_N2', 'P', 'N2'), causal('e_N2_N3', 'N2', 'N3')],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, forkAction);
    const n2Copy = actions.find(
      (a) => a.op === 'add_scene' && (a as { scene: { id: string } }).scene.id === 'N2__br_a'
    ) as { scene: { presentationSpans?: { episodeId: string; pos: number }[] } } | undefined;
    // canon N2 有 spans → 拷贝继承
    expect(n2Copy?.scene.presentationSpans).toEqual([
      { episodeId: 'ep_a', pos: 0 },
      { episodeId: 'ep_b', pos: 1 }
    ]);
    // canon N3 无 spans → 拷贝也不带（undefined = 单章场 = 1.1 行为）
    const n3Copy = actions.find(
      (a) => a.op === 'add_scene' && (a as { scene: { id: string } }).scene.id === 'N3__br_a'
    ) as { scene: { presentationSpans?: unknown } } | undefined;
    expect(n3Copy?.scene.presentationSpans).toBeUndefined();

    // 投影后 graph 仍 schema-valid（spans 继承不破坏投影）
    const projected = applySceneGraphActions(g, actions);
    expect(() => sceneGraphSchema.parse(projected)).not.toThrow();
  });

  // ── Story 1.9：branch 拷贝继承 canon 的 outcomeType/pacingRole（场结果/张弛角色） ──
  it('Story 1.9：branch 拷贝继承 canon 的 outcomeType/pacingRole；canon 无则拷贝也不带', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        {
          id: 'N2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal',
          outcomeType: '惨胜', pacingRole: '高潮'
        },
        { id: 'N3', lineTags: ['l_main'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
      ],
      edges: [causal('e_P_N2', 'P', 'N2'), causal('e_N2_N3', 'N2', 'N3')],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, forkAction);
    const n2Copy = actions.find(
      (a) => a.op === 'add_scene' && (a as { scene: { id: string } }).scene.id === 'N2__br_a'
    ) as { scene: { outcomeType?: string; pacingRole?: string } } | undefined;
    // canon N2 带两字段 → 拷贝继承
    expect(n2Copy?.scene.outcomeType).toBe('惨胜');
    expect(n2Copy?.scene.pacingRole).toBe('高潮');
    // canon N3 无两字段 → 拷贝也不带（undefined）
    const n3Copy = actions.find(
      (a) => a.op === 'add_scene' && (a as { scene: { id: string } }).scene.id === 'N3__br_a'
    ) as { scene: { outcomeType?: string; pacingRole?: string } } | undefined;
    expect(n3Copy?.scene.outcomeType).toBeUndefined();
    expect(n3Copy?.scene.pacingRole).toBeUndefined();

    // 投影后 graph 仍 schema-valid（继承不破坏投影）
    const projected = applySceneGraphActions(g, actions);
    expect(() => sceneGraphSchema.parse(projected)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.7 Step 3: canonDiff（纯代码结构 diff，design §2.4）
// ─────────────────────────────────────────────────────────────────────────────
describe('canonDiff（branch vs canon post-fork 结构 diff，Story 1.7 §2.4）', () => {
  // 已 fork 的完整 graph：canon P→N2→N3 + branch br_a 拷贝 + fork in-edge + branch 内部边
  function forkedGraph(): SceneGraph {
    return parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'N3', lineTags: ['l_main'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
        { id: 'N2__br_a', lineTags: ['br_a'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'N2' },
        { id: 'N3__br_a', lineTags: ['br_a'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', origin_ref: 'N3' },
      ],
      edges: [
        causal('e_P_N2', 'P', 'N2'),
        causal('e_N2_N3', 'N2', 'N3'),
        causal('fork_in', 'P', 'N2__br_a'),
        causal('e_N2_N3__br_a', 'N2__br_a', 'N3__br_a'),
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br_a', name: 'IF分支', topology_role: 'if-branch' }
      ]
    });
  }

  it('fresh fork（拷贝全同 canon）→ same 含全部拷贝，added/removed/changed 空', () => {
    const diff = canonDiff(forkedGraph(), 'br_a');
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.same.map((n) => n.id).sort()).toEqual(['N2__br_a', 'N3__br_a']);
  });

  it('fresh fork 的边全同 → edges.added/removed/changed 全空', () => {
    const diff = canonDiff(forkedGraph(), 'br_a');
    expect(diff.edges.added).toHaveLength(0);
    expect(diff.edges.removed).toHaveLength(0);
    expect(diff.edges.changed).toHaveLength(0);
  });

  it('changed：拷贝 storyTime 改了 → changed 含 {branch, canon} 对', () => {
    const g = forkedGraph();
    const n2Copy = g.nodes.find((n) => n.id === 'N2__br_a')!;
    n2Copy.storyTime = 99; // 作者改了 branch 拷贝的叙事时间
    const diff = canonDiff(g, 'br_a');
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].branch.id).toBe('N2__br_a');
    expect(diff.changed[0].canon.id).toBe('N2');
    expect(diff.same.map((n) => n.id)).toEqual(['N3__br_a']);
  });

  it('changed：role 改了（作者升 branch 拷贝为锚点）→ changed', () => {
    const g = forkedGraph();
    const n2Copy = g.nodes.find((n) => n.id === 'N2__br_a')!;
    n2Copy.role = 'core-anchor';
    const diff = canonDiff(g, 'br_a');
    expect(diff.changed.some((c) => c.branch.id === 'N2__br_a')).toBe(true);
  });

  it('added：branch 独有节点（origin_ref 缺省）→ added', () => {
    const g = forkedGraph();
    g.nodes.push({ id: 'NEW__br_a', lineTags: ['br_a'], storyTime: 4, presentationOrder: { chapter: 0, pos: 3 }, role: 'normal' });
    const diff = canonDiff(g, 'br_a');
    expect(diff.added.map((n) => n.id)).toEqual(['NEW__br_a']);
  });

  it('removed：canon 下游节点无对应拷贝（删 N3__br_a）→ removed 含 N3', () => {
    const g = forkedGraph();
    g.nodes = g.nodes.filter((n) => n.id !== 'N3__br_a');
    g.edges = g.edges.filter((e) => e.id !== 'e_N2_N3__br_a');
    const diff = canonDiff(g, 'br_a');
    expect(diff.removed.map((n) => n.id)).toEqual(['N3']);
  });

  it('origin_ref 悬空（canon 源已删）→ branch 拷贝落 added（无现行 canon 对应）', () => {
    const g = forkedGraph();
    // canon N2 被删，但 branch N2__br_a 还指向它
    g.nodes = g.nodes.filter((n) => n.id !== 'N2');
    const diff = canonDiff(g, 'br_a');
    expect(diff.added.map((n) => n.id)).toContain('N2__br_a');
  });

  it('edges.added：branch 内部新增边（canon 无对应）→ edges.added', () => {
    const g = forkedGraph();
    g.edges.push({ id: 'new_branch_edge', from: 'N3__br_a', to: 'N2__br_a', type: 'CAUSAL' });
    const diff = canonDiff(g, 'br_a');
    expect(diff.edges.added.map((e) => e.id)).toContain('new_branch_edge');
  });

  it('edges.removed：canon post-fork 边无 branch 对应（删 branch 内部边）→ edges.removed', () => {
    const g = forkedGraph();
    g.edges = g.edges.filter((e) => e.id !== 'e_N2_N3__br_a');
    const diff = canonDiff(g, 'br_a');
    expect(diff.edges.removed.map((e) => e.id)).toEqual(['e_N2_N3']);
  });

  it('edges.changed：branch 边 type 改（CAUSAL→SUSPENSE）→ edges.changed', () => {
    const g = forkedGraph();
    const branchEdge = g.edges.find((e) => e.id === 'e_N2_N3__br_a')!;
    branchEdge.type = 'SUSPENSE';
    const diff = canonDiff(g, 'br_a');
    expect(diff.edges.changed).toHaveLength(1);
    expect(diff.edges.changed[0].branch.id).toBe('e_N2_N3__br_a');
    expect(diff.edges.changed[0].canon.id).toBe('e_N2_N3');
    expect(diff.edges.changed[0].branch.type).toBe('SUSPENSE');
    expect(diff.edges.changed[0].canon.type).toBe('CAUSAL');
  });

  it('确定性：同输入同输出（纯函数，可重复）', () => {
    const g = forkedGraph();
    expect(canonDiff(g, 'br_a')).toEqual(canonDiff(g, 'br_a'));
  });

  it('branch 不存在（无 if-branch 线 / 无拷贝）→ 全空 delta（防御性，不崩）', () => {
    const g = parseGraph({
      nodes: [{ id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' }],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const diff = canonDiff(g, 'nonexistent_branch');
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.same).toEqual([]);
    expect(diff.edges.added).toEqual([]);
    expect(diff.edges.removed).toEqual([]);
    expect(diff.edges.changed).toEqual([]);
  });

  it('canonDiff 签名稳定（返回 CanonDiff 结构，调用方不耦合内部顺序）', () => {
    const diff = canonDiff(forkedGraph(), 'br_a');
    expect(diff).toHaveProperty('added');
    expect(diff).toHaveProperty('removed');
    expect(diff).toHaveProperty('changed');
    expect(diff).toHaveProperty('same');
    expect(diff).toHaveProperty('edges');
    expect(diff.edges).toHaveProperty('added');
    expect(diff.edges).toHaveProperty('removed');
    expect(diff.edges).toHaveProperty('changed');
  });

  // ── Story 1.8：presentationSpans 进 canonDiff「changed」判定（shallowNodeEqual） ──
  it('Story 1.8：branch 与 canon 的 presentationSpans 同 → same；改了 → changed', () => {
    const g = forkedGraph();
    const canonN2 = g.nodes.find((n) => n.id === 'N2')!;
    const branchN2 = g.nodes.find((n) => n.id === 'N2__br_a')!;
    const spans = [{ episodeId: 'ep_1', pos: 0 }, { episodeId: 'ep_2', pos: 1 }];

    // canon 与 branch 都带相同 spans → 仍 same（shallowNodeEqual 视全同）
    canonN2.presentationSpans = spans;
    branchN2.presentationSpans = spans;
    let diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');
    expect(diff.changed).toHaveLength(0);

    // branch 改 spans（删一项）→ changed（spans 变 = 分叉后发布编排变了）
    branchN2.presentationSpans = [{ episodeId: 'ep_1', pos: 0 }];
    diff = canonDiff(g, 'br_a');
    expect(diff.changed.some((c) => c.branch.id === 'N2__br_a')).toBe(true);
    expect(diff.same.map((n) => n.id)).not.toContain('N2__br_a');

    // canon 无 spans + branch 无 spans → same（undefined 归一 [] 相等，向后兼容 1.1 节点）
    canonN2.presentationSpans = undefined;
    branchN2.presentationSpans = undefined;
    diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');
  });

  // ── Story 1.9：outcomeType/pacingRole 进 canonDiff「changed」判定（shallowNodeEqual） ──
  it('Story 1.9：branch 与 canon 的 outcomeType/pacingRole 改了 → changed', () => {
    const g = forkedGraph();
    const canonN2 = g.nodes.find((n) => n.id === 'N2')!;
    const branchN2 = g.nodes.find((n) => n.id === 'N2__br_a')!;

    // canon 与 branch 都带相同 outcomeType/pacingRole → 仍 same
    canonN2.outcomeType = '惨胜';
    branchN2.outcomeType = '惨胜';
    canonN2.pacingRole = '高潮';
    branchN2.pacingRole = '高潮';
    let diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');
    expect(diff.changed).toHaveLength(0);

    // branch 改 outcomeType → changed（场结果改了 = 分叉后变了）
    branchN2.outcomeType = '反转';
    diff = canonDiff(g, 'br_a');
    expect(diff.changed.some((c) => c.branch.id === 'N2__br_a')).toBe(true);
    expect(diff.same.map((n) => n.id)).not.toContain('N2__br_a');

    // 还原 outcomeType，改 pacingRole → changed（张弛角色改了）
    branchN2.outcomeType = '惨胜';
    branchN2.pacingRole = '喘息';
    diff = canonDiff(g, 'br_a');
    expect(diff.changed.some((c) => c.branch.id === 'N2__br_a')).toBe(true);

    // 两字段都还原成相同 → 回到 same
    branchN2.pacingRole = '高潮';
    diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');

    // canon 无 + branch 无 → same（undefined === undefined，向后兼容 1.8 之前的节点）
    canonN2.outcomeType = undefined;
    branchN2.outcomeType = undefined;
    canonN2.pacingRole = undefined;
    branchN2.pacingRole = undefined;
    diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');

    // BMad CR EDGE-1/EDGE-2：'' 与 undefined 同为「未设」，`?? ''` 归一 → same（免假 changed 噪声）
    canonN2.outcomeType = '';
    branchN2.outcomeType = undefined;
    canonN2.pacingRole = undefined;
    branchN2.pacingRole = '';
    diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');
    expect(diff.changed).toHaveLength(0);

    // 反向同（canon undefined / branch ''）→ same
    canonN2.outcomeType = undefined;
    branchN2.outcomeType = '';
    diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');

    // 但实值差异仍报 changed（'达成' vs '' = branch 把结果清空了 = 分叉后变了）
    canonN2.outcomeType = '达成';
    branchN2.outcomeType = '';
    diff = canonDiff(g, 'br_a');
    expect(diff.changed.some((c) => c.branch.id === 'N2__br_a')).toBe(true);
  });

  // ── dogfood R2 批次0：title/summary 进 canonDiff「changed」判定（shallowNodeEqual） ──
  it('dogfood R2 批次0：branch 与 canon 的 title/summary 改了 → changed', () => {
    const g = forkedGraph();
    const canonN2 = g.nodes.find((n) => n.id === 'N2')!;
    const branchN2 = g.nodes.find((n) => n.id === 'N2__br_a')!;

    // canon 与 branch 都带相同 title/summary → 仍 same
    canonN2.title = '客栈初遇';
    branchN2.title = '客栈初遇';
    canonN2.summary = '主角与宿敌初次交手。';
    branchN2.summary = '主角与宿敌初次交手。';
    let diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');
    expect(diff.changed).toHaveLength(0);

    // branch 改 title → changed（场景改名 = 分叉后变了）
    branchN2.title = '雨夜重逢';
    diff = canonDiff(g, 'br_a');
    expect(diff.changed.some((c) => c.branch.id === 'N2__br_a')).toBe(true);
    expect(diff.same.map((n) => n.id)).not.toContain('N2__br_a');

    // 还原 title，改 summary → changed（摘要重写 = 分叉后变了）
    branchN2.title = '客栈初遇';
    branchN2.summary = '改写后的摘要。';
    diff = canonDiff(g, 'br_a');
    expect(diff.changed.some((c) => c.branch.id === 'N2__br_a')).toBe(true);

    // 两字段都还原成相同 → 回到 same；双侧缺省 undefined → same（零 migration 向后兼容）
    branchN2.summary = '主角与宿敌初次交手。';
    diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');
    canonN2.title = undefined;
    branchN2.title = undefined;
    canonN2.summary = undefined;
    branchN2.summary = undefined;
    diff = canonDiff(g, 'br_a');
    expect(diff.same.map((n) => n.id)).toContain('N2__br_a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.7 Step 4: detectCausalCycle branch-aware（design §3.1）
// ─────────────────────────────────────────────────────────────────────────────
describe('detectCausalCycle branch-aware（Story 1.7 §3.1）', () => {
  // ── 回归：无 branch 时与原实现完全等价 ──
  it('回归：无 branch canon 环仍报 error（severity/targets 不变）', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2')],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's1')]
    });
    const issues = detectCausalCycle(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('causal-cycle');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].targets.map((t) => t.id).sort()).toEqual(['s1', 's2']);
  });

  it('回归：无 branch 无环 → 空 issue 列表', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2'), node('s3')],
      edges: [causal('e1', 's1', 's2'), causal('e2', 's2', 's3')]
    });
    expect(detectCausalCycle(g)).toEqual([]);
  });

  it('回归：两个独立 canon 环 → 2 个 error issue（数量不变）', () => {
    const g = parseGraph({
      nodes: [node('s1'), node('s2'), node('s3'), node('s4')],
      edges: [
        causal('e1', 's1', 's2'), causal('e2', 's2', 's1'),
        causal('e3', 's3', 's4'), causal('e4', 's4', 's3')
      ]
    });
    const issues = detectCausalCycle(g);
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
  });

  // ── branch-aware 新行为 ──
  it('canon 不因 branch 报假环：全图含环但 canon 子图无环 → canon 不报 error', () => {
    // canon: A→B（无环）。branch: A→B__br(fork in) + B__br→A(merge-back)。
    // 全图 A→B__br→A 成环，但 canon 子图（仅 A→B）无环 → canon 不报 error。
    const g = parseGraph({
      nodes: [
        { id: 'A', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'B', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'B__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'B' },
      ],
      edges: [
        causal('e_ab', 'A', 'B'),
        causal('fork_in', 'A', 'B__br'),
        causal('merge_back', 'B__br', 'A'),
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br', name: 'IF', topology_role: 'if-branch' }
      ]
    });
    const issues = detectCausalCycle(g);
    // canon 边（A→B）无环 → 无 error（不因 branch 假环）
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    // branch 边（A→B__br→A）成环 → warning（per-branch cycle）
    const branchCycles = issues.filter((i) => i.severity === 'warning' && i.code === 'causal-cycle');
    expect(branchCycles.length).toBeGreaterThanOrEqual(1);
  });

  it('per-branch cycle 检出：branch 内部环 → warning', () => {
    // branch: X__br→Y__br→X__br（内部环）
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'X__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'X' },
        { id: 'Y__br', lineTags: ['br'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', origin_ref: 'Y' },
      ],
      edges: [
        causal('e1', 'P', 'X__br'),
        causal('e2', 'X__br', 'Y__br'),
        causal('e3', 'Y__br', 'X__br'),
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br', name: 'IF', topology_role: 'if-branch' }
      ]
    });
    const issues = detectCausalCycle(g);
    const branchCycles = issues.filter((i) => i.severity === 'warning' && i.code === 'causal-cycle');
    expect(branchCycles).toHaveLength(1);
    expect(branchCycles[0].targets.map((t) => t.id).sort()).toEqual(['X__br', 'Y__br']);
  });

  it('canon 环 + branch 环共存 → canon 报 error、branch 报 warning（各报各的）', () => {
    const g = parseGraph({
      nodes: [
        { id: 's1', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' },
        { id: 's2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'B1__br', lineTags: ['br'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', origin_ref: 'B1' },
        { id: 'B2__br', lineTags: ['br'], storyTime: 4, presentationOrder: { chapter: 0, pos: 3 }, role: 'normal', origin_ref: 'B2' },
      ],
      edges: [
        causal('ec1', 's1', 's2'), causal('ec2', 's2', 's1'),           // canon cycle
        causal('eb1', 'B1__br', 'B2__br'), causal('eb2', 'B2__br', 'B1__br'),  // branch cycle
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br', name: 'IF', topology_role: 'if-branch' }
      ]
    });
    const issues = detectCausalCycle(g);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(1);
    expect(issues.filter((i) => i.severity === 'warning')).toHaveLength(1);
  });

  it('多 branch 各自独立环检测（branch A 环、branch B 无环）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'A1__br1', lineTags: ['br1'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'A1' },
        { id: 'A2__br1', lineTags: ['br1'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', origin_ref: 'A2' },
        { id: 'B1__br2', lineTags: ['br2'], storyTime: 2, presentationOrder: { chapter: 1, pos: 1 }, role: 'normal', origin_ref: 'B1' },
        { id: 'B2__br2', lineTags: ['br2'], storyTime: 3, presentationOrder: { chapter: 1, pos: 2 }, role: 'normal', origin_ref: 'B2' },
      ],
      edges: [
        causal('f1', 'P', 'A1__br1'),
        causal('a1', 'A1__br1', 'A2__br1'), causal('a2', 'A2__br1', 'A1__br1'),  // br1 cycle
        causal('f2', 'P', 'B1__br2'),
        causal('b1', 'B1__br2', 'B2__br2'),  // br2 无环（链）
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br1', name: 'IF1', topology_role: 'if-branch' },
        { id: 'br2', name: 'IF2', topology_role: 'if-branch' }
      ]
    });
    const issues = detectCausalCycle(g);
    const warnings = issues.filter((i) => i.severity === 'warning');
    expect(warnings).toHaveLength(1);  // 仅 br1 环
    expect(warnings[0].targets.map((t) => t.id).sort()).toEqual(['A1__br1', 'A2__br1']);
  });

  it('branch cycle message 用叙事语言（非图论术语）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'X__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'X' },
        { id: 'Y__br', lineTags: ['br'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', origin_ref: 'Y' },
      ],
      edges: [
        causal('e1', 'P', 'X__br'),
        causal('e2', 'X__br', 'Y__br'),
        causal('e3', 'Y__br', 'X__br'),
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br', name: 'IF', topology_role: 'if-branch' }
      ]
    });
    const branchCycle = detectCausalCycle(g).find((i) => i.severity === 'warning')!;
    expect(branchCycle.message).not.toContain('DAG');
    expect(branchCycle.message).not.toContain('cycle');
    expect(branchCycle.message.length).toBeGreaterThan(0);
    expect(typeof branchCycle.suggestion).toBe('string');
  });

  it('无环 branch（正常 IF 分支）→ 不报任何 cycle issue', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'N2' },
        { id: 'N3__br', lineTags: ['br'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', origin_ref: 'N3' },
      ],
      edges: [
        causal('e_p', 'P', 'N2__br'),
        causal('e_in', 'N2__br', 'N3__br'),
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br', name: 'IF', topology_role: 'if-branch' }
      ]
    });
    expect(detectCausalCycle(g)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.7 Step 5: if-branch 自校验 + side stub（design §3.2 / §3.3）
// ─────────────────────────────────────────────────────────────────────────────
describe('validateSceneGraph if-branch 自校验（Story 1.7 §3.2，warning 级）', () => {
  // 仅看 if-branch 自校验相关 issue
  const ifBranchIssues = (g: SceneGraph) =>
    validateSceneGraph(g).filter((i) => i.code.startsWith('if-branch'));

  it('合法 if-branch（fork-point 角色 + 拷贝可达）→ 无 if-branch-* issue', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'N2__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'N2' },
      ],
      edges: [
        causal('e_pn', 'P', 'N2'),
        causal('fork_in', 'P', 'N2__br'),
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, convergence_target: 'N2' },
        { id: 'br', name: 'IF', topology_role: 'if-branch' }
      ]
    });
    expect(ifBranchIssues(g)).toEqual([]);
  });

  it('fork-point 缺失（无 canon 节点连入 branch）→ warning if-branch-missing-fork-point', () => {
    const g = parseGraph({
      nodes: [
        // 无 origin_ref：这条 branch 是孤儿，无任何 canon→branch 边连入（来源不明）。
        { id: 'N2__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      ],
      edges: [],
      lines: [{ id: 'br', name: '孤儿 IF', topology_role: 'if-branch' }]
    });
    const issues = ifBranchIssues(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('if-branch-missing-fork-point');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].targets).toEqual([{ kind: 'line', id: 'br' }]);
  });

  it('fork-point 角色非 fork-point（canon 源是 normal）→ warning if-branch-fork-point-role', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' },
        // 无 origin_ref：本测试聚焦 fork-point 角色检测（P 经 fork_in 边连入），非来源追溯。
        { id: 'N2__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      ],
      edges: [causal('fork_in', 'P', 'N2__br')],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br', name: 'IF', topology_role: 'if-branch' }
      ]
    });
    const issues = ifBranchIssues(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('if-branch-fork-point-role');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].targets).toEqual([{ kind: 'node', id: 'P' }]);
  });

  it('孤儿 branch 节点（从 fork-point 不可达）→ warning if-branch-orphan', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        // 无 origin_ref：本测试聚焦可达性（N2__br 经 fork_in 可达、ORPHAN__br 不可达），非来源追溯。
        { id: 'N2__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'ORPHAN__br', lineTags: ['br'], storyTime: 5, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
      ],
      edges: [causal('fork_in', 'P', 'N2__br')],  // ORPHAN__br 无入边
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br', name: 'IF', topology_role: 'if-branch' }
      ]
    });
    const issues = ifBranchIssues(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('if-branch-orphan');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].targets).toEqual([{ kind: 'node', id: 'ORPHAN__br' }]);
  });

  it('if-branch issue message 用叙事语言（非图论术语）', () => {
    const g = parseGraph({
      nodes: [
        // 无 origin_ref：本测试聚焦 issue message 叙事语言（任何 if-branch-* issue 均可）。
        { id: 'N2__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      ],
      edges: [],
      lines: [{ id: 'br', name: '迷路 IF', topology_role: 'if-branch' }]
    });
    const issue = ifBranchIssues(g)[0];
    expect(issue.message).not.toContain('DAG');
    expect(issue.message).not.toContain('cycle');
    expect(issue.message).not.toContain('topology');
    expect(issue.message).toContain('迷路 IF');  // 引用 line name（叙事语言）
    expect(typeof issue.suggestion).toBe('string');
  });

  it('branch 内部环经 validateSceneGraph 报 warning（detectCausalCycle per-branch）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        // canon X, Y 存在 → origin_ref 不悬空（本测试聚焦 branch cycle，非 dangling-origin）。
        { id: 'X', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'Y', lineTags: ['l_main'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
        { id: 'X__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'X' },
        { id: 'Y__br', lineTags: ['br'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', origin_ref: 'Y' },
      ],
      edges: [
        causal('e1', 'P', 'X__br'),
        causal('e2', 'X__br', 'Y__br'),
        causal('e3', 'Y__br', 'X__br'),
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br', name: 'IF', topology_role: 'if-branch' }
      ]
    });
    const cycleIssue = validateSceneGraph(g).find(
      (i) => i.code === 'causal-cycle' && i.severity === 'warning'
    );
    expect(cycleIssue).toBeDefined();
  });

  it('side 线（番外）不触发 if-branch 自校验（无 fork/origin_ref 要求，stub）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'SIDE1', lineTags: ['l_side'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' },
      ],
      edges: [],
      lines: [{ id: 'l_side', name: '番外', topology_role: 'side' }]
    });
    // side 线无 fork-point / origin_ref / 自校验要求 → 无 if-branch-* issue
    expect(ifBranchIssues(g)).toEqual([]);
  });

  it('空 if-branch 线（无节点）不校验（不报 missing-fork-point）', () => {
    const g = parseGraph({
      nodes: [],
      lines: [{ id: 'br', name: '空 IF', topology_role: 'if-branch' }]
    });
    expect(ifBranchIssues(g)).toEqual([]);
  });

  it('origin_ref 悬空（canon 源被删）→ warning if-branch-dangling-origin（design §2.4）', () => {
    // fork_point P 仍在、N3 拷贝指向现存 canon N3；仅 N2 被删 → N2__br origin_ref 悬空。
    // 此时 fork-point 仍合法（P→N2__br 边在），可达性也通（N2__br→N3__br），但来源追溯断了。
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N3', lineTags: ['l_main'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
        { id: 'N2__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'N2' },
        { id: 'N3__br', lineTags: ['br'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', origin_ref: 'N3' },
      ],
      edges: [
        causal('fork_in', 'P', 'N2__br'),
        causal('inner', 'N2__br', 'N3__br'),
      ],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br', name: '断源 IF', topology_role: 'if-branch' }
      ]
    });
    const issues = ifBranchIssues(g);
    // 仅悬空 origin_ref 报警；fork-point 合法 + 无孤儿 → 不报其他 if-branch-* issue
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('if-branch-dangling-origin');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].targets).toEqual([{ kind: 'node', id: 'N2__br' }]);
    // 不误报 N3__br（其 origin_ref 'N3' 仍存在）
    expect(issues[0].message).not.toContain('N3__br');
  });

  it('origin_ref 指向现存 canon → 不报 dangling-origin（合法 branch 拷贝）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'N2__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', origin_ref: 'N2' },
      ],
      edges: [causal('fork_in', 'P', 'N2__br')],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, convergence_target: 'N2' },
        { id: 'br', name: '合法 IF', topology_role: 'if-branch' }
      ]
    });
    expect(ifBranchIssues(g)).toEqual([]);
  });

  it('art_overrides 可降级 if-branch issue（复用既有 override 管线）', () => {
    const g = parseGraph({
      nodes: [
        // 无 origin_ref：本测试聚焦 override 降级 missing-fork-point（非来源追溯）。
        { id: 'N2__br', lineTags: ['br'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      ],
      edges: [],
      lines: [{ id: 'br', name: '孤儿 IF', topology_role: 'if-branch' }],
      art_overrides: [{ check: 'if-branch-missing-fork-point' }]
    });
    const issue = validateSceneGraph(g).find((i) => i.code === 'if-branch-missing-fork-point');
    expect(issue?.severity).toBe('info');  // 被 override 降级
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BMad CR (Phase 2.3) architecture fixes:
// CR-01 (medium 正确性) + CR-05 (helper 抽取) + CR-02 (perf 复用) + CR-04 (安全)
// ─────────────────────────────────────────────────────────────────────────────
describe('BMad CR architecture fixes（CR-01 reachability+bridge / CR-04 collision）', () => {
  // 取 add_scene action 的 scene.id
  const sceneIdOf = (a: { op: string; scene?: { id?: string } }): string | undefined =>
    a.op === 'add_scene' ? a.scene?.id : undefined;
  // 取 add_edge action 的 {from, to, type}
  const edgeOf = (a: { op: string; edge?: { from?: string; to?: string; type?: string } }):
    { from: string; to: string; type: string } | undefined =>
    a.op === 'add_edge' && a.edge?.from && a.edge?.to && a.edge?.type
      ? { from: a.edge.from, to: a.edge.to, type: a.edge.type }
      : undefined;

  // CR-01 核心：canon P(t1,role:fork-point)→X(t1)→Y(t2) 全主线，fork at P
  // 旧 storyTime>P proxy 破裂：X 等故事时不拷、Y 拷贝，Y' 无入边 → orphan/missing-fork-point 假阳性。
  // 修正：下游集改 causal-reachability（前向 BFS、丢 storyTime 过滤）+ 无 branch 内部前驱的拷贝补 P→N' 桥接边。
  it('CR-01: 等故事时 canon P(t1)→X(t1)→Y(t2) fork 后 X\',Y\' 均拷贝 + P→X\' 桥接 + X\'→Y\' 内部边（无 orphan）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'X', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'Y', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
      ],
      edges: [
        causal('e_P_X', 'P', 'X'),
        causal('e_X_Y', 'X', 'Y'),
      ],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, {
      op: 'fork_branch', fork_from_scene_id: 'P', branch_line_id: 'br_a', branch_line_name: 'IF'
    });
    const addScene = actions.map(sceneIdOf).filter((id): id is string => !!id).sort();
    // X 和 Y 都拷贝（X 等故事时，但 causally 在 P 之后 → 必须拷）
    expect(addScene).toEqual(['X__br_a', 'Y__br_a']);

    // P→X' 桥接边（X 无 branch 内部前驱：canon 前驱是 P，不在 downstream）
    const bridge = actions.map(edgeOf).find((e) => e?.from === 'P' && e?.to === 'X__br_a');
    expect(bridge).toBeDefined();
    expect(bridge?.type).toBe('CAUSAL');

    // X'→Y' branch-internal 边（X、Y 都在 downstream）
    const internal = actions.map(edgeOf).find((e) => e?.from === 'X__br_a' && e?.to === 'Y__br_a');
    expect(internal).toBeDefined();

    // Y' 不该有 P→Y' 桥接（Y 已有 branch-internal 前驱 X'，不需桥接）
    const noBridgeY = actions.map(edgeOf).find((e) => e?.from === 'P' && e?.to === 'Y__br_a');
    expect(noBridgeY).toBeUndefined();

    // 投影后校验：无 orphan / missing-fork-point 假阳性
    const projected = applySceneGraphActions(g, actions);
    const ifBranchIssues = validateSceneGraph(projected).filter((i) => i.code.startsWith('if-branch'));
    expect(ifBranchIssues).toEqual([]);
  });

  // CR-01 桥接 type：canon P→N 直边为 SUSPENSE → 桥接边用 SUSPENSE（无 canon 直边才 fallback CAUSAL）
  it('CR-01: 桥接边 type 取 canon P→N 直边 type（SUSPENSE 直边 → SUSPENSE 桥接）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      ],
      edges: [suspense('e_P_N2', 'P', 'N2')],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, {
      op: 'fork_branch', fork_from_scene_id: 'P', branch_line_id: 'br_a'
    });
    const bridge = actions.map(edgeOf).find((e) => e?.from === 'P' && e?.to === 'N2__br_a');
    expect(bridge?.type).toBe('SUSPENSE');
  });

  // CR-01 回归：严格递增 storyTime 仍正确（原行为不破）
  it('CR-01 回归：canon P(t1)→A(t2)→B(t3) 严格递增 fork 后 A\',B\' 拷贝 + P→A\' + A\'→B\'', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'A', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'B', lineTags: ['l_main'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
      ],
      edges: [causal('e_P_A', 'P', 'A'), causal('e_A_B', 'A', 'B')],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, {
      op: 'fork_branch', fork_from_scene_id: 'P', branch_line_id: 'br_a', branch_line_name: 'IF'
    });
    const addScene = actions.map(sceneIdOf).filter((id): id is string => !!id).sort();
    expect(addScene).toEqual(['A__br_a', 'B__br_a']);
    const bridge = actions.map(edgeOf).find((e) => e?.from === 'P' && e?.to === 'A__br_a');
    expect(bridge).toBeDefined();
    const internal = actions.map(edgeOf).find((e) => e?.from === 'A__br_a' && e?.to === 'B__br_a');
    expect(internal).toBeDefined();
    // 严格递增时 B 已有内部前驱 A' → 不该有 P→B' 桥接
    const noBridgeB = actions.map(edgeOf).find((e) => e?.from === 'P' && e?.to === 'B__br_a');
    expect(noBridgeB).toBeUndefined();
  });

  // CR-01 fan-out 保留：canon P→X, P→Y（双 direct downstream，无交叉）→ 桥接保 fan-out（P→X' + P→Y'）
  it('CR-01 fan-out：canon P→X + P→Y（X,Y 均无 branch 内部前驱）→ 双桥接 P→X\' + P→Y\'', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'X', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'Y', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
      ],
      edges: [
        causal('e_P_X', 'P', 'X'),
        causal('e_P_Y', 'P', 'Y'),
      ],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, {
      op: 'fork_branch', fork_from_scene_id: 'P', branch_line_id: 'br_a'
    });
    const bridges = actions.map(edgeOf).filter((e) => e?.from === 'P');
    expect(bridges).toHaveLength(2);
    expect(bridges.some((e) => e?.to === 'X__br_a')).toBe(true);
    expect(bridges.some((e) => e?.to === 'Y__br_a')).toBe(true);
  });

  // CR-04: branch_line_id 与既有非 if-branch 线碰撞 → 跳过 add_line（不覆盖 topology_role）
  it('CR-04: branch_line_id 碰撞既有 converging 线 → 跳过 add_line，topology_role 不被改写为 if-branch', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_conv'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_conv'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      ],
      edges: [causal('e1', 'P', 'N2')],
      lines: [{ id: 'l_conv', name: '收敛主线', topology_role: 'converging', is_main_thread: true }]
    });
    const actions = expandForkBranch(g, {
      op: 'fork_branch', fork_from_scene_id: 'P', branch_line_id: 'l_conv', branch_line_name: '不应覆盖'
    });
    // 不发 add_line（避免覆盖既有 converging 线身份）
    expect(actions.filter((a) => a.op === 'add_line')).toHaveLength(0);
    // 仍发 scene 拷贝（branch 节点 lineTags 指 l_conv，让既有线事实上承载 branch 节点）
    expect(actions.some((a) => a.op === 'add_scene')).toBe(true);

    // 投影后既有线 topology_role 仍为 converging（未被改写）
    const projected = applySceneGraphActions(g, actions);
    const line = projected.lines.find((l) => l.id === 'l_conv')!;
    expect(line.topology_role).toBe('converging');
  });

  // CR-04 边界：branch_line_id 已是 if-branch → add_line 正常发（幂等更新 name）
  it('CR-04 边界：branch_line_id 已是 if-branch → add_line 正常发（幂等）', () => {
    const g = parseGraph({
      nodes: [
        { id: 'P', lineTags: ['l_main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'N2', lineTags: ['l_main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      ],
      edges: [causal('e1', 'P', 'N2')],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'br_a', name: '旧 IF', topology_role: 'if-branch' }
      ]
    });
    const actions = expandForkBranch(g, {
      op: 'fork_branch', fork_from_scene_id: 'P', branch_line_id: 'br_a', branch_line_name: '新 IF 名'
    });
    const addLine = actions.find((a) => a.op === 'add_line') as { line: { name?: string } } | undefined;
    expect(addLine).toBeDefined();  // 已是 if-branch，仍发 add_line（幂等更新）
    expect(addLine?.line.name).toBe('新 IF 名');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.1 §3.1：scene 精选（按 episode 取本章相关 scene 结构摘要）。
// isSceneInEpisode（单源匹配 helper，DRY）+ selectScenesForEpisode（结构面投影，承接 1.6 deferred）。
// 范式判据（ADR-3）：纯结构查询（id 相等比较 + 字段投影），不进 closure_*（1.6 决议）。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 valid SceneNode（schema.parse 填默认，避免漏 required 字段）。 */
function scene4(partial: Record<string, unknown>): SceneNode {
  return sceneGraphSchema.parse({
    nodes: [{ id: 'x', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, ...partial }],
  }).nodes[0];
}

describe('isSceneInEpisode（Story 1.8 M:N 单源匹配 helper）', () => {
  it('episodeId 直挂命中（单章场，1.1 行为）', () => {
    expect(isSceneInEpisode(scene4({ id: 's1', episodeId: 'ep1' }), 'ep1')).toBe(true);
  });

  it('episodeId 直挂不命中其它 episode', () => {
    expect(isSceneInEpisode(scene4({ id: 's1', episodeId: 'ep1' }), 'ep2')).toBe(false);
  });

  it('presentationSpans M:N 命中（跨章场含目标 episode，1.8）', () => {
    const n = scene4({
      id: 's1',
      presentationSpans: [{ episodeId: 'ep1', pos: 0 }, { episodeId: 'ep2', pos: 0 }],
    });
    expect(isSceneInEpisode(n, 'ep1')).toBe(true);
    expect(isSceneInEpisode(n, 'ep2')).toBe(true);
    expect(isSceneInEpisode(n, 'ep3')).toBe(false);
  });

  it('无 episodeId 无 spans → 不命中任何 episode', () => {
    const n = scene4({ id: 's1' }); // 既无 episodeId 也无 presentationSpans
    expect(isSceneInEpisode(n, 'ep1')).toBe(false);
  });

  it('与原 brief-compiler sceneMatchesEpisode / chapter-brief episodeHasScenes 同形（DRY 回归）', () => {
    // 直挂 + spans 共存：直挂优先（短路 true）
    const n = scene4({
      id: 's1',
      episodeId: 'ep1',
      presentationSpans: [{ episodeId: 'ep2', pos: 0 }],
    });
    expect(isSceneInEpisode(n, 'ep1')).toBe(true); // 直挂命中
    expect(isSceneInEpisode(n, 'ep2')).toBe(true); // spans 命中
  });
});

describe('selectScenesForEpisode（Story 4.1 §3.1 scene 精选，结构面投影）', () => {
  // 7 场覆盖矩阵（mirror brief-compiler-node test 矩阵）：
  // - s_direct：episodeId=ep2 直挂（单章场）
  // - s_span_hit：spans=[ep1,ep2] → M:N 命中 ep2
  // - s_span_only：spans=[ep2] → M:N 命中 ep2（单 episode spans）
  // - s_other：episodeId=ep1 → 不命中 ep2
  // - s_span_miss：spans=[ep1,ep3] → 不命中 ep2
  function buildGraph(): SceneGraph {
    return parseGraph({
      nodes: [
        { id: 's_direct', episodeId: 'ep2', storyTime: 0, presentationOrder: { chapter: 1, pos: 0 }, role: 'core-anchor', lineTags: ['l_main'], outcomeType: '惨胜', pacingRole: '高潮', actRef: 'act1' },
        { id: 's_span_hit', storyTime: 1, presentationOrder: { chapter: 1, pos: 1 }, role: 'normal', lineTags: ['l_side'], presentationSpans: [{ episodeId: 'ep1', pos: 0 }, { episodeId: 'ep2', pos: 0 }] },
        { id: 's_span_only', storyTime: 2, presentationOrder: { chapter: 1, pos: 2 }, role: 'normal', presentationSpans: [{ episodeId: 'ep2', pos: 0 }] },
        { id: 's_other', episodeId: 'ep1', storyTime: 3, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' },
        { id: 's_span_miss', storyTime: 4, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', presentationSpans: [{ episodeId: 'ep1', pos: 0 }, { episodeId: 'ep3', pos: 0 }] },
      ],
      edges: [],
      lines: [],
    });
  }

  it('M:N 命中：episodeId 直挂 + presentationSpans（跨章 + 单 episode spans）', () => {
    const result = selectScenesForEpisode(buildGraph(), 'ep2');
    const ids = result.map((d) => d.id);
    // 命中 s_direct（直挂）+ s_span_hit（spans 含 ep2）+ s_span_only（spans=[ep2]）
    expect(ids).toEqual(['s_direct', 's_span_hit', 's_span_only']);
  });

  it('排除不命中场（其它 episode 直挂 / spans 不含目标）', () => {
    const result = selectScenesForEpisode(buildGraph(), 'ep2');
    const ids = result.map((d) => d.id);
    expect(ids).not.toContain('s_other');
    expect(ids).not.toContain('s_span_miss');
  });

  it('结构面抽取：含期望结构字段（id/role/lineTags/storyTime/presentationOrder/episodeId/outcomeType/pacingRole/actRef）', () => {
    const result = selectScenesForEpisode(buildGraph(), 'ep2');
    const direct = result.find((d) => d.id === 's_direct')!;
    expect(direct.role).toBe('core-anchor');
    expect(direct.lineTags).toEqual(['l_main']);
    expect(direct.storyTime).toBe(0);
    expect(direct.presentationOrder).toEqual({ chapter: 1, pos: 0 });
    expect(direct.episodeId).toBe('ep2');
    expect(direct.outcomeType).toBe('惨胜');
    expect(direct.pacingRole).toBe('高潮');
    expect(direct.actRef).toBe('act1');
  });

  it('结构面抽取：presentationSpans 透传（M:N 跨章场保留发布 spans）', () => {
    const result = selectScenesForEpisode(buildGraph(), 'ep2');
    const spanHit = result.find((d) => d.id === 's_span_hit')!;
    expect(spanHit.presentationSpans).toEqual([
      { episodeId: 'ep1', pos: 0 },
      { episodeId: 'ep2', pos: 0 },
    ]);
    // 直挂场无 spans → presentationSpans undefined
    const direct = result.find((d) => d.id === 's_direct')!;
    expect(direct.presentationSpans).toBeUndefined();
  });

  it('不含正文 / 不含全量 dump：digest 无 origin_ref / 无 edges / 无 lines / 无 art_overrides 等字段', () => {
    const result = selectScenesForEpisode(buildGraph(), 'ep2');
    for (const d of result) {
      // digest 字段子集——不含 origin_ref（IF branch 拷贝指针）
      expect('origin_ref' in d).toBe(false);
      // 不含 edges/lines/art_overrides/version/updatedBy（全量 dump 字段）
      expect('edges' in d).toBe(false);
      expect('lines' in d).toBe(false);
      expect('art_overrides' in d).toBe(false);
    }
  });

  it('空 graph（nodes=[]）→ []', () => {
    expect(selectScenesForEpisode(parseGraph({}), 'ep1')).toEqual([]);
  });

  it('graph undefined → []', () => {
    expect(selectScenesForEpisode(undefined, 'ep1')).toEqual([]);
  });

  it('episodeId undefined → []（graceful，无匹配）', () => {
    expect(selectScenesForEpisode(buildGraph(), undefined)).toEqual([]);
  });

  it('episodeId 为空串 → []（防误匹配空 episodeId）', () => {
    expect(selectScenesForEpisode(buildGraph(), '')).toEqual([]);
  });

  it('保留 graph.nodes 原序（命中场按原序输出，非重排）', () => {
    const result = selectScenesForEpisode(buildGraph(), 'ep2');
    expect(result.map((d) => d.id)).toEqual(['s_direct', 's_span_hit', 's_span_only']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4 reverse-ref 原语（C-A7/D2，涟漪诊断候选缩小）
// ─────────────────────────────────────────────────────────────────────────────
describe('reverse-ref 原语（scenesByAssetRef / scenesByLine / linesByAssetRef）', () => {
  function buildReverseRefGraph(): SceneGraph {
    return parseGraph({
      nodes: [
        { id: 's_a', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor', lineTags: ['l_main'], assetRefs: ['char_erina', 'loc_tavern'] },
        { id: 's_b', storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', lineTags: ['l_side'], assetRefs: ['char_erina'] },
        { id: 's_c', storyTime: 2, presentationOrder: { chapter: 1, pos: 0 }, role: 'normal', lineTags: ['l_main', 'l_side'] },
        { id: 's_d', storyTime: 3, presentationOrder: { chapter: 1, pos: 1 }, role: 'normal', lineTags: [], assetRefs: ['prop_sword'] },
      ],
      edges: [],
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', thread_ref: 'char_erina' },
        { id: 'l_side', name: '副线', topology_role: 'parallel-worldview', thread_ref: 'loc_tavern' },
        { id: 'l_float', name: '浮线', topology_role: 'converging' },
      ],
    });
  }

  // ── scenesByAssetRef ──
  it('scenesByAssetRef：命中含该 assetId 的场（多场+投影）', () => {
    const result = scenesByAssetRef(buildReverseRefGraph(), 'char_erina');
    expect(result.map((d) => d.id)).toEqual(['s_a', 's_b']);
    // 投影为 SceneStructureDigest（含结构字段，非全量 dump）
    expect(result[0]).toEqual({
      id: 's_a', role: 'core-anchor', lineTags: ['l_main'], storyTime: 0, storyTimeLabel: undefined,
      presentationOrder: { chapter: 0, pos: 0 }, presentationSpans: undefined, episodeId: undefined,
      outcomeType: undefined, pacingRole: undefined, actRef: undefined,
    });
  });

  it('scenesByAssetRef：无命中的 assetId → []', () => {
    expect(scenesByAssetRef(buildReverseRefGraph(), 'nope').map((d) => d.id)).toEqual([]);
  });

  it('scenesByAssetRef：assetRefs 缺省的场不被命中（无 false positive）', () => {
    // s_c 无 assetRefs → 任何 assetId 都不该命中它
    const result = scenesByAssetRef(buildReverseRefGraph(), 'char_erina');
    expect(result.map((d) => d.id)).not.toContain('s_c');
  });

  // ── scenesByLine ──
  it('scenesByLine：命中该线上的所有场（lineTags 含 lineId）', () => {
    expect(scenesByLine(buildReverseRefGraph(), 'l_main').map((d) => d.id)).toEqual(['s_a', 's_c']);
    expect(scenesByLine(buildReverseRefGraph(), 'l_side').map((d) => d.id)).toEqual(['s_b', 's_c']);
  });

  it('scenesByLine：场属多线（lineTags 含多 lineId）被每条线命中', () => {
    // s_c 同时在 l_main + l_side
    const mainScenes = scenesByLine(buildReverseRefGraph(), 'l_main').map((d) => d.id);
    const sideScenes = scenesByLine(buildReverseRefGraph(), 'l_side').map((d) => d.id);
    expect(mainScenes).toContain('s_c');
    expect(sideScenes).toContain('s_c');
  });

  it('scenesByLine：无线 tag 的场不被命中', () => {
    // s_d lineTags=[] → 不被任何线命中
    expect(scenesByLine(buildReverseRefGraph(), 'l_main').map((d) => d.id)).not.toContain('s_d');
    expect(scenesByLine(buildReverseRefGraph(), 'l_side').map((d) => d.id)).not.toContain('s_d');
  });

  // ── linesByAssetRef ──
  it('linesByAssetRef：命中 thread_ref 锚定该 assetId 的线', () => {
    const result = linesByAssetRef(buildReverseRefGraph(), 'char_erina');
    expect(result.map((l) => l.id)).toEqual(['l_main']);
    // 投影为 SceneLineDigest（结构子集）
    expect(result[0]).toEqual({
      id: 'l_main', name: '主线', topology_role: 'converging',
      thread_ref: 'char_erina', convergence_target: undefined, mice_type: undefined,
    });
  });

  it('linesByAssetRef：无 thread_ref 的线（floating）不被命中', () => {
    // l_float 无 thread_ref → 不被任何 assetId 命中
    expect(linesByAssetRef(buildReverseRefGraph(), 'char_erina').map((l) => l.id)).not.toContain('l_float');
    expect(linesByAssetRef(buildReverseRefGraph(), 'loc_tavern').map((l) => l.id)).toEqual(['l_side']);
  });

  // ── graceful（缺省入参 → []）──
  it('graph undefined → []（三函数一致 graceful）', () => {
    expect(scenesByAssetRef(undefined, 'x')).toEqual([]);
    expect(scenesByLine(undefined, 'x')).toEqual([]);
    expect(linesByAssetRef(undefined, 'x')).toEqual([]);
  });

  it('id undefined → []（三函数一致 graceful，防误匹配）', () => {
    expect(scenesByAssetRef(buildReverseRefGraph(), undefined)).toEqual([]);
    expect(scenesByLine(buildReverseRefGraph(), undefined)).toEqual([]);
    expect(linesByAssetRef(buildReverseRefGraph(), undefined)).toEqual([]);
  });

  it('保留原序（命中按 graph.nodes / graph.lines 原序输出，非重排）', () => {
    const byAsset = scenesByAssetRef(buildReverseRefGraph(), 'char_erina').map((d) => d.id);
    expect(byAsset).toEqual(['s_a', 's_b']); // s_a 在 s_b 前（nodes 原序）
    const byLine = scenesByLine(buildReverseRefGraph(), 'l_main').map((d) => d.id);
    expect(byLine).toEqual(['s_a', 's_c']);
  });
});
