/**
 * Story 6.1 InfoReleaseMap shell handler tests (mirror sceneGraphHandlers.test.ts).
 *
 * Locks the creative-field write pattern (bounded action → field_patch envelope)
 * + corrupt-vs-absent guard + read filter + additive (field-not-yet-written).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadProject / onFieldEdited are imported dynamically inside the handler; mock at top level and
// control per-test via vi.mocked. Default loadProject = a valid project doc with NO info_release_map
// field (absent -> fresh empty map is the correct base). Default onFieldEdited = no-op spy
// （autoApply 路径用，验证落盘调用；非 autoApply 路径不调 onFieldEdited 走 field_patch envelope）。
vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import {
  infoReleaseMapReadHandler,
  infoReleaseMapUpdateHandler,
} from '../main/ipc/toolHandlers/infoReleaseHandlers';

const ctx = (params: Record<string, unknown>, projectDir = '/proj') => ({
  params,
  projectDir,
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

const FULL_ENTRY = {
  id: 'irm-scene5-reveal',
  sceneRef: 's_court',
  episodeId: 'ep1',
  reveal: ['国王的密谋'],
  withhold: ['主角的真实身份'],
};

describe('infoReleaseMapUpdateHandler (Story 6.1)', () => {
  it('合法 add_entry → 投影 schema-valid → 产 field_patch metadata', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await infoReleaseMapUpdateHandler(ctx({ actions: [{ op: 'add_entry', entry: FULL_ENTRY }] }));

    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('info_release_map');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as any;
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({ id: 'irm-scene5-reveal', sceneRef: 's_court' });
  });

  it('absent info_release_map（项目无该字段）→ 当空 map 投影，产 field_patch', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await infoReleaseMapUpdateHandler(ctx({ actions: [{ op: 'add_entry', entry: FULL_ENTRY }] }));
    // absent = legit empty (new project); fresh map is the correct base.
    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
  });

  it('corrupt info_release_map（字段存在但 schema-invalid）→ 拒绝 update + 不产 field_patch', async () => {
    // entries 非 array → infoReleaseMapSchema.parse 抛
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      info_release_map: { entries: 'not-an-array', version: 0 },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await infoReleaseMapUpdateHandler(ctx({ actions: [{ op: 'add_entry', entry: FULL_ENTRY }] }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('校验失败');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loadProject 返 null（整文档 corrupt/missing）→ 拒绝 update（跨字段污染防护）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await infoReleaseMapUpdateHandler(ctx({ actions: [{ op: 'add_entry', entry: FULL_ENTRY }] }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('无法读取');
  });

  it('拒绝非法 op 名（schema 层拦截，非投影层）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await infoReleaseMapUpdateHandler(ctx({ actions: [{ op: 'bogus_op', id: 'x' }] }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('操作格式无效');
  });

  it('拒绝缺 sceneRef 的 partial entry（infoReleaseEntrySchema 层拦截）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await infoReleaseMapUpdateHandler(ctx({
      actions: [{ op: 'add_entry', entry: { id: 'x' } }], // 缺 sceneRef
    }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
  });

  it('update_entry 覆盖同 id（幂等）；remove_entry 删；混合投影正确', async () => {
    const existing = {
      ...ABSENT_DOC,
      info_release_map: {
        entries: [
          { id: 'e1', sceneRef: 's1', reveal: ['旧'] },
          { id: 'e2', sceneRef: 's2' },
        ],
        version: 3,
        updatedBy: 'user',
      },
    };
    vi.mocked(loadProject).mockReturnValue(existing as any);
    const res = await infoReleaseMapUpdateHandler(ctx({
      actions: [
        { op: 'update_entry', entry: { id: 'e1', sceneRef: 's1', reveal: ['新'] } },
        { op: 'remove_entry', entryId: 'e2' },
        { op: 'add_entry', entry: { id: 'e3', sceneRef: 's3' } },
      ],
    }));
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    const ids = data.entries.map((e: any) => e.id);
    expect(ids).toEqual(['e1', 'e3']);
    expect(data.entries.find((e: any) => e.id === 'e1').reveal).toEqual(['新']);
    // version/updatedBy preserved（onFieldEdited bumps version on save，非 projector 职责）
    expect(data.version).toBe(3);
    expect(data.updatedBy).toBe('user');
  });
});

describe('infoReleaseMapReadHandler (Story 6.1)', () => {
  it('读全部 entries（无 filter）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      info_release_map: {
        entries: [
          { id: 'e1', sceneRef: 's1', episodeId: 'ep1' },
          { id: 'e2', sceneRef: 's2', episodeId: 'ep2' },
        ],
        version: 1,
      },
    } as any);
    const res = await infoReleaseMapReadHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: true, count: 2 });
    expect((res.metadata as any).entries).toHaveLength(2);
  });

  it('按 sceneId filter', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      info_release_map: {
        entries: [
          { id: 'e1', sceneRef: 's1', episodeId: 'ep1' },
          { id: 'e2', sceneRef: 's2', episodeId: 'ep1' },
        ],
        version: 1,
      },
    } as any);
    const res = await infoReleaseMapReadHandler(ctx({ sceneId: 's2' }));
    expect(res.metadata).toMatchObject({ ok: true, count: 1 });
    expect((res.metadata as any).entries[0].id).toBe('e2');
  });

  it('按 episodeId filter', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      info_release_map: {
        entries: [
          { id: 'e1', sceneRef: 's1', episodeId: 'ep1' },
          { id: 'e2', sceneRef: 's2', episodeId: 'ep2' },
        ],
        version: 1,
      },
    } as any);
    const res = await infoReleaseMapReadHandler(ctx({ episodeId: 'ep2' }));
    expect(res.metadata).toMatchObject({ ok: true, count: 1 });
    expect((res.metadata as any).entries[0].id).toBe('e2');
  });

  it('absent（项目无 info_release_map）→ 友好空提示 + count 0（additive，非 corrupt）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await infoReleaseMapReadHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: true, count: 0 });
    expect(res.output).toContain('空');
  });

  it('filter 无匹配 → 友好提示 + count 0', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      info_release_map: { entries: [{ id: 'e1', sceneRef: 's1' }], version: 0 },
    } as any);
    const res = await infoReleaseMapReadHandler(ctx({ sceneId: 'nope' }));
    expect(res.metadata).toMatchObject({ ok: true, count: 0 });
    expect(res.output).toContain('未找到');
  });

  it('corrupt info_release_map → 友好不可读提示（永不抛）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      info_release_map: { entries: 'not-an-array', version: 0 },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await infoReleaseMapReadHandler(ctx({}));
    expect(res.output).toContain('无法读取');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loadProject 返 null → 友好不可读提示（永不抛）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await infoReleaseMapReadHandler(ctx({}));
    expect(res.output).toContain('无法读取');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 6.3 R3 Step 7a（DW-4）：Director 自动 authoring autoApply 落盘路径。
//
// Director 是 leader 侧子 agent（非人决策的自动 authoring），传 autoApply:true 让 handler 直接
// onFieldEdited(source:'agent') 落盘 info_release_map creative field（mirror 6.5 promiseLedgerHandlers
// autoApply + 6.6 world-state 自动写，不经 PatchReview）。autoApply 绕开 PatchReview 直接落盘闭环
// （工作台可 review + 后章 idempotency）。
//
// 本 suite 验 shell 侧：handler autoApply=true → onFieldEdited 被调（source='agent'，projected map）→
// 返 {ok, applied:true, entryCount}。autoApply 缺省/false → 6.1 既有 field_patch envelope 行为不变。
// ════════════════════════════════════════════════════════════════════════════

describe('infoReleaseMapUpdateHandler autoApply (Story 6.3 R3 Step 7a — Director 自动 authoring)', () => {
  beforeEach(() => {
    vi.mocked(onFieldEdited).mockClear();
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
  });

  it('DW-4：autoApply=true → 调 onFieldEdited（source=agent，projected map）→ 返 applied metadata（非 field_patch）', async () => {
    const res = await infoReleaseMapUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_entry', entry: FULL_ENTRY }] }),
    );

    // onFieldEdited 被调一次，第一参 projectDir，第二参 'info_release_map'，第三参 projected full map，
    // 第四参 options.source='agent'（Director 自动 authoring，非 'user'）。
    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('info_release_map');
    expect((data as any).entries).toHaveLength(1);
    expect((data as any).entries[0]).toMatchObject({ id: 'irm-scene5-reveal', sceneRef: 's_court' });
    expect((options as { source?: string }).source).toBe('agent');
    expect(typeof (options as { reason?: string }).reason).toBe('string');

    // 返 applied metadata（非 field_patch envelope——DW-4 绕开 PatchReview 直接落盘）。
    expect(res.metadata).toMatchObject({
      ok: true,
      applied: true,
      entryCount: 1,
    });
    expect(res.metadata?.type).toBeUndefined(); // 非 field_patch
    expect(res.output).toContain('已生效');
  });

  it('DW-4：autoApply 缺省 false → 不调 onFieldEdited，走 field_patch envelope（leader PatchReview 路径不变）', async () => {
    // leader / 工作台手 authoring 走 PatchReview（非 Director 自动），autoApply 缺省 false（6.1 既有行为 backward compat）。
    const res = await infoReleaseMapUpdateHandler(
      ctx({ actions: [{ op: 'add_entry', entry: FULL_ENTRY }] }),
    );

    // onFieldEdited 不被调（field_patch envelope → UI patch-review → 后续 syncField 才调 onFieldEdited）。
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.action).toBe('set');
    expect((res.metadata?.data as any).entries).toHaveLength(1);
  });

  it('DW-4：autoApply=true on corrupt info_release_map → 拒绝（不调 onFieldEdited，不 overwrite）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      info_release_map: { entries: 'not-an-array', version: 0 },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await infoReleaseMapUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_entry', entry: FULL_ENTRY }] }),
    );

    // corrupt on-disk → 拒绝投影（不 overwrite real data via fresh-map projection）。
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('校验失败');
    warn.mockRestore();
  });

  it('DW-4 graceful：onFieldEdited 抛错（locked field / save fail）→ 不破 handler，返失败提示（Director 记 writeError）', async () => {
    // Director 落盘遇 locked field（用户锁 info_release_map 拒自动改）→ onFieldEdited throw → handler catch
    // 返失败提示（非 reject），Director 不破 chain（in-memory 链段照跑，仅落盘失败）。
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field info_release_map is locked and cannot be edited');
    });

    const res = await infoReleaseMapUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_entry', entry: FULL_ENTRY }] }),
    );

    expect(onFieldEdited).toHaveBeenCalledTimes(1); // 被调（但抛错）
    expect(res.metadata?.applied).toBeUndefined(); // 未 applied
    expect(res.output).toContain('自动生效失败');
    expect(res.output).toContain('locked');
  });
});
