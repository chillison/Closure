/**
 * Story 6.5 Promise ledger shell handler tests (mirror infoReleaseHandlers.test.ts).
 *
 * Locks the creative-field write pattern (bounded action → field_patch envelope)
 * + corrupt-vs-absent guard + read filter (beats carry sceneRef) + beat idempotency
 * (natural key) + remove_promise cascade.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadProject / onFieldEdited are imported dynamically inside the handler; mock at top level and
// control per-test via vi.mocked. Default loadProject = a valid project doc with NO promise_registry
// field (absent -> fresh empty registry is the correct base). Default onFieldEdited = no-op spy
// （autoApply 路径用，验证落盘调用；非 autoApply 路径不调 onFieldEdited 走 field_patch envelope）。
vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import {
  promiseLedgerUpdateHandler,
  queryPromiseHandler,
} from '../main/ipc/toolHandlers/promiseLedgerHandlers';

const ctx = (params: Record<string, unknown>, projectDir = '/proj') => ({
  params,
  projectDir,
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

const FULL_PROMISE = {
  id: 'p-kings-justice',
  title: '国王的正义',
  summary: '读者会逐渐发现国王并非表面所示的明君。',
  category: 'setup_payoff',
};

const FULL_BEAT = {
  promiseId: 'p-kings-justice',
  sceneRef: 's_court',
  episodeId: 'ep1',
  kind: 'plant' as const,
  note: '本章只许发烫，不许发光。',
};

describe('promiseLedgerUpdateHandler (Story 6.5)', () => {
  it('合法 add_promise（带 firstBeat）→ 投影 schema-valid → 产 field_patch metadata', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await promiseLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_promise', promise: FULL_PROMISE, firstBeat: FULL_BEAT }] }),
    );

    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('promise_registry');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as any;
    expect(data.promises).toHaveLength(1);
    expect(data.promises[0]).toMatchObject({ id: 'p-kings-justice', title: '国王的正义' });
    // firstBeat 落 beats（projector 按 (promiseId, sceneRef) 自然键生成 id）
    expect(data.beats).toHaveLength(1);
    expect(data.beats[0]).toMatchObject({
      promiseId: 'p-kings-justice',
      sceneRef: 's_court',
      kind: 'plant',
    });
    expect(data.beats[0].id).toBe('p-kings-justice::s_court');
  });

  it('absent promise_registry（项目无该字段）→ 当空 registry 投影，产 field_patch', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await promiseLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_promise', promise: FULL_PROMISE }] }),
    );
    // absent = legit empty (new project); fresh registry is the correct base.
    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect((res.metadata?.data as any).promises).toHaveLength(1);
    expect((res.metadata?.data as any).beats).toHaveLength(0);
  });

  it('corrupt promise_registry（字段存在但 schema-invalid）→ 拒绝 update + 不产 field_patch', async () => {
    // promises 非 array → promiseRegistrySchema.parse 抛
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      promise_registry: { promises: 'not-an-array', beats: [], version: 0 },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await promiseLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_promise', promise: FULL_PROMISE }] }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('校验失败');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loadProject 返 null（整文档 corrupt/missing）→ 拒绝 update（跨字段污染防护）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await promiseLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_promise', promise: FULL_PROMISE }] }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('无法读取');
  });

  it('拒绝非法 type 名（schema 层拦截，非投影层）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await promiseLedgerUpdateHandler(
      ctx({ actions: [{ type: 'bogus_op', id: 'x' }] }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('操作格式无效');
  });

  it('拒绝缺 summary 的 promise（promiseEntrySchema 层拦截）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await promiseLedgerUpdateHandler(
      ctx({
        actions: [{ type: 'add_promise', promise: { id: 'x', title: 'T' } }], // 缺 summary
      }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
  });

  it('add_beat 幂等（同 promiseId+sceneRef 覆盖 kind/note 保留 id）；remove_promise 级联删 beats', async () => {
    const existing = {
      ...ABSENT_DOC,
      promise_registry: {
        promises: [
          { id: 'p1', title: 'P1', summary: 'S1' },
          { id: 'p2', title: 'P2', summary: 'S2' },
        ],
        beats: [
          { id: 'p1::s1', promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
          { id: 'p2-b1', promiseId: 'p2', sceneRef: 's2', kind: 'plant' },
        ],
        version: 3,
        updatedBy: 'user',
      },
    };
    vi.mocked(loadProject).mockReturnValue(existing as any);
    const res = await promiseLedgerUpdateHandler(
      ctx({
        actions: [
          // 幂等：同 (p1, s1) 自然键 → 覆盖 kind=advance，保留既有 id 'p1::s1'
          { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's1', kind: 'advance', note: '推进' } },
          // remove_promise p2 → 级联删 p2 的 beats（p2-b1）
          { type: 'remove_promise', promiseId: 'p2' },
        ],
      }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    // p2 删，只剩 p1
    expect(data.promises.map((p: any) => p.id)).toEqual(['p1']);
    // p2-b1 级联删；p1::s1 保留且 kind 升为 advance（idempotent 覆盖）
    const p1Beat = data.beats.find((b: any) => b.promiseId === 'p1');
    expect(p1Beat.kind).toBe('advance');
    expect(p1Beat.note).toBe('推进');
    expect(p1Beat.id).toBe('p1::s1'); // 既有 id 保留（自然键命中）
    expect(data.beats.find((b: any) => b.promiseId === 'p2')).toBeUndefined();
    // version/updatedBy preserved（onFieldEdited bumps version on save，非 projector 职责）
    expect(data.version).toBe(3);
    expect(data.updatedBy).toBe('user');
  });

  it('update_beat 浅合并 patch（保留 id）；remove_beat 删；混合投影正确', async () => {
    const existing = {
      ...ABSENT_DOC,
      promise_registry: {
        promises: [{ id: 'p1', title: 'P1', summary: 'S1' }],
        beats: [
          { id: 'b1', promiseId: 'p1', sceneRef: 's1', kind: 'plant', note: '旧' },
          { id: 'b2', promiseId: 'p1', sceneRef: 's2', kind: 'advance' },
        ],
        version: 1,
      },
    };
    vi.mocked(loadProject).mockReturnValue(existing as any);
    const res = await promiseLedgerUpdateHandler(
      ctx({
        actions: [
          { type: 'update_beat', beatId: 'b1', patch: { note: '新指示' } }, // kind 保留 plant
          { type: 'remove_beat', beatId: 'b2' },
        ],
      }),
    );
    const data = res.metadata?.data as any;
    expect(data.beats).toHaveLength(1);
    const b1 = data.beats[0];
    expect(b1.id).toBe('b1');
    expect(b1.kind).toBe('plant'); // 浅合并保留既有 kind
    expect(b1.note).toBe('新指示'); // patch 覆盖 note
  });
});

describe('queryPromiseHandler (Story 6.5)', () => {
  it('读全部 promises + beats（无 filter）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      promise_registry: {
        promises: [
          { id: 'p1', title: 'P1', summary: 'S1' },
          { id: 'p2', title: 'P2', summary: 'S2' },
        ],
        beats: [
          { id: 'b1', promiseId: 'p1', sceneRef: 's1', episodeId: 'ep1', kind: 'plant' },
          { id: 'b2', promiseId: 'p2', sceneRef: 's2', episodeId: 'ep2', kind: 'plant' },
        ],
        version: 1,
      },
    } as any);
    const res = await queryPromiseHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: true, promiseCount: 2, beatCount: 2 });
    expect((res.metadata as any).promises).toHaveLength(2);
    expect((res.metadata as any).beats).toHaveLength(2);
  });

  it('按 sceneId filter（命中 beat 所属 promise 一并返回，子集自洽）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      promise_registry: {
        promises: [
          { id: 'p1', title: 'P1', summary: 'S1' },
          { id: 'p2', title: 'P2', summary: 'S2' },
        ],
        beats: [
          { id: 'b1', promiseId: 'p1', sceneRef: 's1', episodeId: 'ep1', kind: 'plant' },
          { id: 'b2', promiseId: 'p2', sceneRef: 's2', episodeId: 'ep1', kind: 'plant' },
        ],
        version: 1,
      },
    } as any);
    const res = await queryPromiseHandler(ctx({ sceneId: 's2' }));
    expect(res.metadata).toMatchObject({ ok: true, promiseCount: 1, beatCount: 1 });
    const meta = res.metadata as any;
    expect(meta.beats[0].id).toBe('b2');
    // 仅返回命中 beat 所属的 p2（p1 无 s2 的 beat，不返回）
    expect(meta.promises.map((p: any) => p.id)).toEqual(['p2']);
  });

  it('按 episodeId filter', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      promise_registry: {
        promises: [
          { id: 'p1', title: 'P1', summary: 'S1' },
          { id: 'p2', title: 'P2', summary: 'S2' },
        ],
        beats: [
          { id: 'b1', promiseId: 'p1', sceneRef: 's1', episodeId: 'ep1', kind: 'plant' },
          { id: 'b2', promiseId: 'p2', sceneRef: 's2', episodeId: 'ep2', kind: 'plant' },
        ],
        version: 1,
      },
    } as any);
    const res = await queryPromiseHandler(ctx({ episodeId: 'ep2' }));
    expect(res.metadata).toMatchObject({ ok: true, promiseCount: 1, beatCount: 1 });
    expect((res.metadata as any).beats[0].id).toBe('b2');
    expect((res.metadata as any).promises[0].id).toBe('p2');
  });

  it('absent（项目无 promise_registry）→ 友好空提示 + count 0（additive，非 corrupt）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await queryPromiseHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: true, promiseCount: 0, beatCount: 0 });
    expect(res.output).toContain('空');
  });

  it('filter 无匹配 → 友好提示 + count 0', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      promise_registry: {
        promises: [{ id: 'p1', title: 'P1', summary: 'S1' }],
        beats: [{ id: 'b1', promiseId: 'p1', sceneRef: 's1', kind: 'plant' }],
        version: 0,
      },
    } as any);
    const res = await queryPromiseHandler(ctx({ sceneId: 'nope' }));
    expect(res.metadata).toMatchObject({ ok: true, promiseCount: 0, beatCount: 0 });
    expect(res.output).toContain('未找到');
  });

  it('corrupt promise_registry → 友好不可读提示（永不抛）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      promise_registry: { promises: 'not-an-array', beats: [], version: 0 },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await queryPromiseHandler(ctx({}));
    expect(res.output).toContain('无法读取');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loadProject 返 null → 友好不可读提示（永不抛）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await queryPromiseHandler(ctx({}));
    expect(res.output).toContain('无法读取');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 6.5 A1（CR-A1 critical，block AC2）：emergence autoApply 落盘路径。
//
// emergence node 是自动链段节点（LLM 从 gap 涌现，非人决策），传 autoApply:true 让 handler 直接
// onFieldEdited(source:'agent') 落盘 promise_registry creative field（mirror 6.6 world-state 自动写
// closure_world_patch，不经 PatchReview）。原 implementation emergence 走 field_patch envelope 但 envelope
// 永不落盘（summarizeRunSnapshot 不提 promise_emergence / WRITE_TOOLS 不含 promise_ledger_update）→
// feature 无效 + AC2 违反。autoApply 绕开 PatchReview 直接落盘闭环。
//
// 本 suite 验 shell 侧：handler autoApply=true → onFieldEdited 被调（source='agent'，projected registry）
// → 返 {ok, applied:true, promiseCount, beatCount}。与 agent 侧 promise-emergence.test.ts「A1 happy path」
// （验 emergence 传 autoApply:true + applied artifact）合围 emergence→落盘 end-to-end 断言。
// ════════════════════════════════════════════════════════════════════════════

describe('promiseLedgerUpdateHandler autoApply (Story 6.5 A1 — emergence 自动落盘)', () => {
  beforeEach(() => {
    vi.mocked(onFieldEdited).mockClear();
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
  });

  it('A1：autoApply=true → 调 onFieldEdited（source=agent，projected registry）→ 返 applied metadata（非 field_patch）', async () => {
    const res = await promiseLedgerUpdateHandler(
      ctx({
        autoApply: true,
        actions: [{ type: 'add_promise', promise: FULL_PROMISE, firstBeat: FULL_BEAT }],
      }),
    );

    // onFieldEdited 被调一次，第一参 projectDir，第二参 'promise_registry'，第三参 projected full registry，
    // 第四参 options.source='agent'（emergence 自动落盘，非 'user'）。
    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('promise_registry');
    expect((data as any).promises).toHaveLength(1);
    expect((data as any).promises[0]).toMatchObject({ id: 'p-kings-justice' });
    expect((data as any).beats).toHaveLength(1);
    expect((options as { source?: string }).source).toBe('agent');
    expect(typeof (options as { reason?: string }).reason).toBe('string');

    // 返 applied metadata（非 field_patch envelope——A1 绕开 PatchReview 直接落盘）。
    expect(res.metadata).toMatchObject({
      ok: true,
      applied: true,
      promiseCount: 1,
      beatCount: 1,
    });
    expect(res.metadata?.type).toBeUndefined(); // 非 field_patch
    expect(res.output).toContain('已生效');
  });

  it('A1：autoApply 缺省 false → 不调 onFieldEdited，走 field_patch envelope（leader PatchReview 路径）', async () => {
    // leader / Director authoring 走 PatchReview（非 emergence 自动），autoApply 缺省 false。
    const res = await promiseLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_promise', promise: FULL_PROMISE }] }),
    );

    // onFieldEdited 不被调（field_patch envelope → UI patch-review → 后续 syncField 才调 onFieldEdited）。
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.action).toBe('set');
    expect((res.metadata?.data as any).promises).toHaveLength(1);
  });

  it('A1：autoApply=true on corrupt promise_registry → 拒绝（不调 onFieldEdited，不 overwrite）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      promise_registry: { promises: 'not-an-array', beats: [], version: 0 },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await promiseLedgerUpdateHandler(
      ctx({ autoApply: true, actions: [{ type: 'add_promise', promise: FULL_PROMISE }] }),
    );

    // corrupt on-disk → 拒绝投影（不 overwrite real data via fresh-registry projection）。
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('校验失败');
    warn.mockRestore();
  });

  it('A1 graceful：onFieldEdited 抛错（locked field / save fail）→ 不破 handler，返失败提示（emergence 记 writeError）', async () => {
    // emergence 落盘遇 locked field（用户锁 promise_registry 拒自动改）→ onFieldEdited throw → handler catch
    // 返失败提示（非 reject），emergence node 记 writeError 不破 chain。
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field promise_registry is locked and cannot be edited');
    });

    const res = await promiseLedgerUpdateHandler(
      ctx({ autoApply: true, actions: [{ type: 'add_promise', promise: FULL_PROMISE }] }),
    );

    expect(onFieldEdited).toHaveBeenCalledTimes(1); // 被调（但抛错）
    expect(res.metadata?.applied).toBeUndefined(); // 未 applied
    expect(res.output).toContain('自动生效失败');
    expect(res.output).toContain('locked');
  });
});
