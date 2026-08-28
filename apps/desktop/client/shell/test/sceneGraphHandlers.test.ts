/**
 * Scene-graph shell handler trust-boundary regression (Story 1.3).
 *
 * Locks two Fixes:
 * 1. applySceneGraphActions fills scene/line defaults but NOT edge
 *    from/to/type or line.name, so a partial add can project a schema-INVALID
 *    graph. The handler must validate the projection and surface a rejection to
 *    the LLM rather than emit a field_patch that would flow through UI's
 *    swallow-catch and persist invalid data (loadProject corrupt-backup trap per
 *    interface-contracts).
 * 2. CR-008/CR-001: readSceneGraph distinguishes absent (legit empty, fresh
 *    graph OK) from corrupt (schema-invalid scene_graph OR loadProject null =
 *    whole project corrupt). A corrupt on-disk scene_graph must NOT be silently
 *    treated as an empty graph, or `action:'set'` would overwrite real
 *    unreadable data (cross-field pollution). The update handler refuses + logs.
 */
import { describe, expect, it, vi } from 'vitest';

// loadProject / onFieldEdited are imported dynamically inside the handler; mock at top level and
// control per-test via vi.mocked. Default loadProject = a valid project doc with NO scene_graph
// field (absent -> fresh empty graph is the correct base). Default onFieldEdited = no-op spy
// （7.4 autoApply 路径用，验证落盘调用；非 autoApply 路径不调 onFieldEdited 走 field_patch envelope）。
vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import { sceneGraphUpdateHandler, sceneGraphReadHandler } from '../main/ipc/toolHandlers/sceneGraphHandlers';

const ctx = (actions: unknown, extra: Record<string, unknown> = {}) => ({
  params: { actions, ...extra },
  projectDir: '/proj',
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

describe('sceneGraphUpdateHandler trust-boundary (Story 1.3)', () => {
  it('拒绝会投影出非法 graph 的 partial edge（缺 type）-- 不产 field_patch', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'add_edge', edge: { id: 'e1', from: 's1', to: 's2' } } // 缺 type
    ]));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
  });

  it('拒绝缺 name 的 partial line -- 不产 field_patch', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'add_line', line: { id: 'l1' } } // 缺 name
    ]));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
  });

  it('合法全量 add -> 投影 schema-valid -> 产 field_patch metadata', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } },
      { op: 'add_scene', scene: { id: 's2', lineTags: ['l1'] } },
      { op: 'add_line', line: { id: 'l1', name: '主线', convergence_target: 's2' } },
      { op: 'add_edge', edge: { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' } }
    ]));
    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('scene_graph');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as any;
    expect(data.nodes).toHaveLength(2);
    expect(data.edges).toHaveLength(1);
    expect(data.lines).toHaveLength(1);
  });

  it('拒绝非法 op 名（schema 层拦截，非投影层）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'bogus_op', id: 'x' }
    ]));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
  });
});

describe('sceneGraphUpdateHandler corrupt vs absent (CR-008/CR-001)', () => {
  it('absent scene_graph（项目无 scene_graph 字段）-> 当空图投影，产 field_patch', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } },
      { op: 'add_line', line: { id: 'l1', name: '主线', convergence_target: 's1' } },
    ]));
    // absent = legit empty (new project); fresh graph is the correct base.
    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
  });

  it('corrupt scene_graph（字段存在但 schema-invalid）-> 拒绝 update + 不产 field_patch', async () => {
    // edge missing required `from` -> sceneGraphSchema.parse throws
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      scene_graph: { nodes: [], edges: [{ id: 'e1', to: 's2', type: 'CAUSAL' }], lines: [] },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } },
    ]));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('校验失败');
    // not silently swallowed - logged for observability
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loadProject 返 null（整文档 corrupt/missing）-> 拒绝 update（跨字段污染防护）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } },
    ]));
    // Must NOT treat as absent-empty: projecting onto a fresh graph would
    // `action:'set'`-overwrite real unreadable data on the next save.
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('无法读取');
  });

  it('sceneGraphReadHandler: absent -> 提示空；corrupt -> 提示不可读', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const absentRes = await sceneGraphReadHandler({ projectDir: '/proj', params: {}, sessionId: 's1', abort: new AbortController().signal });
    expect(absentRes.output).toContain('项目尚未建立场景结构');

    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      scene_graph: { nodes: 'not-an-array', edges: [], lines: [] },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const corruptRes = await sceneGraphReadHandler({ projectDir: '/proj', params: {}, sessionId: 's1', abort: new AbortController().signal });
    expect(corruptRes.output).toContain('无法读取');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('sceneGraphUpdateHandler fork_branch wiring (Story 1.7)', () => {
  // canon 主线：p(fork-point) -> a -> b；fork_branch 应把 a,b 拷成 if-branch 拷贝。
  const CANON = {
    ...ABSENT_DOC,
    scene_graph: {
      nodes: [
        { id: 'p', lineTags: ['main'], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'fork-point' },
        { id: 'a', lineTags: ['main'], storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        { id: 'b', lineTags: ['main'], storyTime: 2, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
      ],
      edges: [
        { id: 'e1', from: 'p', to: 'a', type: 'CAUSAL' },
        { id: 'e2', from: 'a', to: 'b', type: 'CAUSAL' },
      ],
      lines: [{ id: 'main', name: '主线', is_main_thread: true }],
    },
  };

  it('fork_branch 经 expander→projector 展开成 if-branch 拷贝（origin_ref + lineTag），canon 原节点不动', async () => {
    vi.mocked(loadProject).mockReturnValue(CANON as any);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'fork_branch', fork_from_scene_id: 'p', branch_line_id: 'if1', branch_line_name: 'IF 分支' },
    ]));
    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    // if-branch Line 建
    const ifLine = data.lines.find((l: any) => l.id === 'if1');
    expect(ifLine?.topology_role).toBe('if-branch');
    // 下游 a,b 拷贝（origin_ref 指向 canon 源，lineTag 含 if1）
    const aCopy = data.nodes.find((n: any) => n.origin_ref === 'a');
    const bCopy = data.nodes.find((n: any) => n.origin_ref === 'b');
    expect(aCopy).toBeDefined();
    expect(bCopy).toBeDefined();
    expect(aCopy.lineTags).toContain('if1');
    // fork-point P 不拷（canon 原点，非下游）
    expect(data.nodes.find((n: any) => n.origin_ref === 'p')).toBeUndefined();
    // canon 原节点仍全在（独立 ID = 写保护）
    const canonIds = data.nodes.filter((n: any) => !n.origin_ref).map((n: any) => n.id);
    expect(canonIds).toEqual(expect.arrayContaining(['p', 'a', 'b']));
  });

  it('混合 fork_branch + 既有 op：fork 展开 + add 同批投影', async () => {
    vi.mocked(loadProject).mockReturnValue(CANON as any);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'fork_branch', fork_from_scene_id: 'p', branch_line_id: 'if1', branch_line_name: 'IF' },
      { op: 'add_scene', scene: { id: 'extra', lineTags: ['if1'] } },
    ]));
    const data = res.metadata?.data as any;
    expect(data.nodes.find((n: any) => n.id === 'extra')).toBeDefined();
    expect(data.nodes.find((n: any) => n.origin_ref === 'a')).toBeDefined();
  });
});

describe('sceneGraphUpdateHandler presentationSpans transparency (Story 1.8)', () => {
  // 载入既有合法 scene_graph（含单节点 s1），update_scene 携带 presentationSpans 应原样透传。
  const DOC_WITH_SCENE = {
    ...ABSENT_DOC,
    scene_graph: {
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' }
      ],
      edges: [],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }]
    },
  };

  it('update_scene 携带 presentationSpans → 投影 schema-valid + metadata.data 含 spans（透传，§R4）', async () => {
    vi.mocked(loadProject).mockReturnValue(DOC_WITH_SCENE as any);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'update_scene', scene: { id: 's1', presentationSpans: [
        { episodeId: 'ep_1', pos: 0 }, { episodeId: 'ep_2', pos: 1 }
      ] } }
    ]));
    // metadata 存在 = handler 内 sceneGraphSchema.safeParse(projected) 通过（投影 schema-valid）
    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    const node = data.nodes.find((n: any) => n.id === 's1');
    expect(node.presentationSpans).toEqual([
      { episodeId: 'ep_1', pos: 0 },
      { episodeId: 'ep_2', pos: 1 }
    ]);
  });

  it('add_scene 携带 presentationSpans → 透传到投影 graph', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await sceneGraphUpdateHandler(ctx([
      { op: 'add_scene', scene: { id: 's_court', lineTags: ['l1'], presentationSpans: [
        { episodeId: 'ep_1', pos: 0 }, { episodeId: 'ep_2', pos: 0 }
      ] } },
      { op: 'add_line', line: { id: 'l1', name: '主线' } }
    ]));
    expect(res.metadata).toBeDefined();
    const data = res.metadata?.data as any;
    const node = data.nodes.find((n: any) => n.id === 's_court');
    expect(node.presentationSpans).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 7.4：scene_graph_update autoApply 双落盘模式（mirror infoReleaseMapUpdateHandler DW-4 /
// promiseLedgerHandlers 6.5）。leader 在 write_chapter 日志点调度 Director atomic-edit apply →
// handler autoApply=true 直接 onFieldEdited(source:'agent') 落盘（绕开 PatchReview）。autoApply 缺省/false
// → 1.3 既有 field_patch envelope 行为不变（零回归）。
// ════════════════════════════════════════════════════════════════════════════

import { beforeEach } from 'vitest';

describe('sceneGraphUpdateHandler autoApply (Story 7.4 — Director atomic-edit leader 落盘)', () => {
  beforeEach(() => {
    vi.mocked(onFieldEdited).mockClear();
    vi.mocked(onFieldEdited).mockReturnValue({ syncEvent: { id: 'evt' }, staleFields: [] } as any);
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
  });

  it('autoApply=true → 调 onFieldEdited（source=agent，projected graph）→ 返 applied metadata（非 field_patch）+ data 供刷新', async () => {
    const res = await sceneGraphUpdateHandler(
      ctx([
        { op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } },
        { op: 'add_line', line: { id: 'l1', name: '主线' } },
      ], { autoApply: true }),
    );

    // onFieldEdited 被调一次，第一参 projectDir，第二参 'scene_graph'，第三参 projected full graph，
    // 第四参 options.source='agent'（leader 自动落盘，非 'user'）。
    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('scene_graph');
    expect((data as any).nodes).toHaveLength(1);
    expect((options as { source?: string }).source).toBe('agent');
    expect(typeof (options as { reason?: string }).reason).toBe('string');

    // 返 applied metadata（非 field_patch envelope——绕开 PatchReview 直接落盘）。
    expect(res.metadata).toMatchObject({
      ok: true,
      applied: true,
      sceneCount: 1,
    });
    expect(res.metadata?.type).toBeUndefined(); // 非 field_patch
    // data 供 caller（write_chapter）刷新 initialArtifacts['scene_graph']。
    expect((res.metadata?.data as any).nodes).toHaveLength(1);
    expect(res.output).toContain('已生效');
  });

  it('autoApply 缺省 false → 不调 onFieldEdited，走 field_patch envelope（leader PatchReview 路径不变）', async () => {
    // leader / 工作台手 authoring 走 PatchReview，autoApply 缺省 false（1.3 既有行为 backward compat）。
    const res = await sceneGraphUpdateHandler(
      ctx([
        { op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } },
        { op: 'add_line', line: { id: 'l1', name: '主线' } },
      ]),
    );

    // onFieldEdited 不被调（field_patch envelope → UI patch-review → 后续 syncField 才调 onFieldEdited）。
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.action).toBe('set');
    expect((res.metadata?.data as any).nodes).toHaveLength(1);
  });

  it('autoApply 显式 false → 同缺省（field_patch envelope，零回归）', async () => {
    const res = await sceneGraphUpdateHandler(
      ctx([
        { op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } },
        { op: 'add_line', line: { id: 'l1', name: '主线' } },
      ], { autoApply: false }),
    );
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
  });

  it('BMad CR-005：autoApply=true + 空 actions → 不调 onFieldEdited（免虚假 version bump），返 applied:false reason:no_change', async () => {
    // 空 actions（computeProjectedGraph 返不变 graph）→ 不调 onFieldEdited（免虚假 version bump + markStaleFields）。
    const res = await sceneGraphUpdateHandler(ctx([], { autoApply: true }));
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata).toMatchObject({ ok: true, applied: false, reason: 'no_change' });
    expect(res.metadata?.type).toBeUndefined(); // 非 field_patch envelope
  });

  it('autoApply=true on corrupt scene_graph → 拒绝（不调 onFieldEdited，不 overwrite）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      scene_graph: { nodes: [], edges: [{ id: 'e1', to: 's2', type: 'CAUSAL' }], lines: [] },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await sceneGraphUpdateHandler(
      ctx([{ op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } }], { autoApply: true }),
    );

    // corrupt on-disk → 拒绝投影（不 overwrite real data via fresh-graph projection）。
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('校验失败');
    warn.mockRestore();
  });

  it('autoApply=true 投影非法 graph（partial edge 缺 type）→ 拒绝（不调 onFieldEdited）', async () => {
    const res = await sceneGraphUpdateHandler(
      ctx([{ op: 'add_edge', edge: { id: 'e1', from: 's1', to: 's2' } }], { autoApply: true }),
    );
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.output).toContain('被拒');
  });

  it('graceful：onFieldEdited 抛错（locked field / save fail）→ 不破 handler，返失败提示（链段不破）', async () => {
    // 落盘遇 locked field（用户锁 scene_graph 拒自动改）→ onFieldEdited throw → handler catch
    // 返失败提示（非 reject），leader 不破 chain（in-memory 链段照跑，仅落盘失败）。
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field scene_graph is locked and cannot be edited');
    });

    const res = await sceneGraphUpdateHandler(
      ctx([
        { op: 'add_scene', scene: { id: 's1', lineTags: ['l1'] } },
        { op: 'add_line', line: { id: 'l1', name: '主线' } },
      ], { autoApply: true }),
    );

    expect(onFieldEdited).toHaveBeenCalledTimes(1); // 被调（但抛错）
    expect(res.metadata?.applied).toBeUndefined(); // 未 applied
    expect(res.output).toContain('自动生效失败');
    expect(res.output).toContain('locked');
  });
});
