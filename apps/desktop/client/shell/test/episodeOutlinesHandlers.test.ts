/**
 * Story 8.5 R2 episode outlines shell handler tests（mirror curveHandlers.test.ts /
 * assetCardsHandlers.test.ts）。
 *
 * Locks：bounded-write pattern（add/update/remove_episode → field_patch envelope / autoApply
 * direct persist）+ add 重复 id 友好拒（撞磁盘既有 + **同批重复** CR-Blind-F3/Edge-F2）+
 * corrupt-vs-absent guard + **phase_ref 存在性校验 warn 透传不拒**（design §3.1——悬空引用透传 +
 * 警告随 handler 返回，leader 可见）+ **remove 入站引用扫描 warn 透传不拒**（CR-Edge-F1——
 * scene_graph / promise_registry / growth_curve 三源引用双通道警告）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn: vi.fn() }) }));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import { episodeOutlinesUpdateHandler } from '../main/ipc/toolHandlers/episodeOutlinesHandlers';

const ctx = (params: Record<string, unknown>, projectDir = '/proj') => ({
  params,
  projectDir,
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

/**
 * onFieldEdited 返回类型的最小合法 shape（WorkflowSyncEvent 全 required 字段——mockReturnValue
 * 按函数真实签名全型检查，缺字段是 typecheck error 非 runtime error；mirror curveHandlers.test.ts）。
 */
function onFieldEditedOk() {
  return {
    syncEvent: {
      id: 'evt_test',
      createdAt: '2026-08-18T00:00:00.000Z',
      source: 'agent' as const,
      field: 'episode_outlines' as const,
      fromVersion: 0,
      toVersion: 1,
      reason: 'test',
      affectedFields: [],
    },
    staleFields: [],
    // quarantine-notify：onFieldEdited 返回新增字段（判腐隔离事实），mock 同步真实契约。
    quarantined: null,
  };
}

const OUTLINE_DOC = (phaseIds: string[]) => ({
  ...ABSENT_DOC,
  outline_v2: {
    phases: phaseIds.map((id) => ({ id, title: `卷 ${id}` })),
    major_turning_points: [],
  },
});

const FULL_EPISODE = {
  id: 'ep-10',
  index: 10,
  title: '审判日',
  purpose: '兑现第一卷积累',
  core_event: '开庭对质',
  character_progressions: [{ characterId: 'char-lin', from: '自保沉默', to: '为同伴作证' }],
  phase_ref: 'phase-1',
};

describe('episodeOutlinesUpdateHandler (Story 8.5 R2，non-autoApply field_patch 路径)', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(OUTLINE_DOC(['phase-1']) as any);
    vi.mocked(onFieldEdited).mockReset();
    vi.mocked(onFieldEdited).mockReturnValue(onFieldEditedOk());
  });

  it('合法 add_episode（absent 基底）→ 产 field_patch（field episode_outlines，full array）', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'add_episode', episode: FULL_EPISODE }] }),
    );

    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('episode_outlines');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as any;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 'ep-10', title: '审判日', phase_ref: 'phase-1' });
    expect(data[0].status).toBe('planned'); // default 填充
    // phase_ref 在 phases 集合内 → 零警告。
    expect(res.metadata?.phaseWarnings).toEqual([]);
    expect(res.output).not.toContain('悬空');
  });

  it('phase_ref 悬空（不在 outline_v2.phases[].id 集合）→ **透传不拒**：envelope 照产 + warn 随返回（design §3.1）', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'add_episode', episode: { ...FULL_EPISODE, phase_ref: 'phase-ghost' } }] }),
    );
    // 悬空引用不拒收（LLM 先排章后补 phase 的合法顺序）。
    expect(res.metadata?.type).toBe('field_patch');
    expect((res.metadata?.data as any)[0].phase_ref).toBe('phase-ghost'); // 透传保留
    // warn 消息 leader 可见（output 文案 + metadata.phaseWarnings 双通道）。
    expect(res.output).toContain('悬空');
    expect(res.output).toContain('phase-ghost');
    expect(res.metadata?.phaseWarnings).toEqual([{ episodeId: 'ep-10', phaseRef: 'phase-ghost' }]);
  });

  it('大纲缺失（无 outline_v2）→ 每条带 phase_ref 的 episode 都悬空 warn，仍透传不拒', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'add_episode', episode: { ...FULL_EPISODE, phase_ref: 'phase-any' } }] }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.phaseWarnings).toEqual([{ episodeId: 'ep-10', phaseRef: 'phase-any' }]);
  });

  it('update_episode 浅合并 patch（identity id 不可改）+ patch phase_ref 悬空同样 warn', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...OUTLINE_DOC(['phase-1']),
      episode_outlines: [
        { id: 'ep-3', index: 3, title: '旧集', status: 'planned' },
      ],
    } as any);
    const res = await episodeOutlinesUpdateHandler(
      ctx({
        actions: [
          // patch 携 id 会被 omit strip（identity 不可改）；phase_ref 悬空 → warn。
          { op: 'update_episode', episodeId: 'ep-3', patch: { hook: '新钩子', phase_ref: 'phase-x' } },
        ],
      }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    expect(data).toHaveLength(1);
    expect(data[0].hook).toBe('新钩子');
    expect(data[0].title).toBe('旧集'); // 未提字段保留
    expect(data[0].id).toBe('ep-3'); // identity 保留
    expect(res.metadata?.phaseWarnings).toEqual([{ episodeId: 'ep-3', phaseRef: 'phase-x' }]);
  });

  it('预存悬空 phase_ref：projected 全量检查 → 既有悬空锚也 surfaced（稳定幂等 warn）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...OUTLINE_DOC(['phase-1']),
      episode_outlines: [
        { id: 'ep-old', index: 1, title: '旧集', phase_ref: 'phase-typo', status: 'planned' },
      ],
    } as any);
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'add_episode', episode: FULL_EPISODE }] }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    // 新集（phase-1 命中）不警告；预存 ep-old 悬空锚 surfaced。
    expect(res.metadata?.phaseWarnings).toEqual([{ episodeId: 'ep-old', phaseRef: 'phase-typo' }]);
  });

  it('add_episode 重复 id → 友好报错（不静默覆盖，mirror asset_cards add_card）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...OUTLINE_DOC(['phase-1']),
      episode_outlines: [{ id: 'ep-10', index: 10, title: '既有', status: 'planned' }],
    } as any);
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'add_episode', episode: FULL_EPISODE }] }),
    );
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('已存在');
    expect(res.output).toContain('update_episode');
  });

  // ── CR-005（8.5 BMad CR）：同批 remove+add 同 id = 合法原子替换，不再误整批拒。──

  it('同批 [remove_episode e1, add_episode e1\']（替换 id）→ 合法通过，envelope 携新集', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...OUTLINE_DOC(['phase-1']),
      episode_outlines: [{ id: 'ep-1', index: 1, title: '旧集', status: 'drafted' }],
    } as any);
    const replacement = { ...FULL_EPISODE, id: 'ep-1', index: 1 };
    const res = await episodeOutlinesUpdateHandler(
      ctx({
        actions: [
          { op: 'remove_episode', episodeId: 'ep-1' },
          { op: 'add_episode', episode: replacement },
        ],
      }),
    );
    // 判定基准 = 本批 remove 投影后状态——替换序列不再被「already exists」误拒。
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 'ep-1', title: '审判日', status: 'planned' }); // 新集入列（defaults 填充）
  });

  it('同批 remove 的是别的 id → add 撞盘仍拒（报错文案含同批替换指引）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...OUTLINE_DOC(['phase-1']),
      episode_outlines: [
        { id: 'ep-10', index: 10, title: '既有', status: 'planned' },
        { id: 'ep-other', index: 1, title: '将被删', status: 'planned' },
      ],
    } as any);
    const res = await episodeOutlinesUpdateHandler(
      ctx({
        actions: [
          { op: 'remove_episode', episodeId: 'ep-other' },
          { op: 'add_episode', episode: FULL_EPISODE }, // ep-10 未被本批 remove → 仍撞盘
        ],
      }),
    );
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('已存在');
    expect(res.output).toContain('remove_episode');
    expect(res.output).toContain('同一批次');
  });

  // ── CR-008（8.5 BMad CR）：params null/undefined 头部归一守卫（never-throws 契约）。──

  it('params null / undefined → 友好 skip 不 throw', async () => {
    for (const badParams of [null, undefined]) {
      const res = await episodeOutlinesUpdateHandler(ctx(badParams as any));
      expect(res.output).toContain('已跳过');
      expect(res.output).not.toContain('Error');
      expect(res.metadata).toBeUndefined();
    }
  });

  it('remove_episode 幂等跳过不存在', async () => {
    const res = await episodeOutlinesUpdateHandler(ctx({ actions: [{ op: 'remove_episode', episodeId: 'ghost' }] }));
    expect(res.metadata?.type).toBe('field_patch');
    expect((res.metadata?.data as any[])).toHaveLength(0);
  });

  // ── CR-Edge-F1（8.5 CR）：remove_episode 入站引用扫描 warn 透传不拒（双通道 output + metadata）。──
  it('remove 有引用集 → 照删 + warn 列出三源引用（scene_graph / promise_registry / growth_curve）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...OUTLINE_DOC(['phase-1']),
      episode_outlines: [{ id: 'ep-x', index: 1, title: '被引用集', status: 'planned' }],
      scene_graph: {
        nodes: [
          { id: 's1', storyTime: 1, presentationOrder: { chapter: 1, pos: 0 }, role: 'normal', episodeId: 'ep-x' },
          { id: 's2', storyTime: 2, presentationOrder: { chapter: 1, pos: 1 }, role: 'normal', presentationSpans: [{ episodeId: 'ep-x', pos: 0 }] },
          { id: 's3', storyTime: 3, presentationOrder: { chapter: 2, pos: 0 }, role: 'normal', episodeId: 'ep-other' },
        ],
      },
      promise_registry: {
        beats: [
          { id: 'b1', promiseId: 'p1', sceneRef: 's1', episodeId: 'ep-x', kind: 'plant' },
          { id: 'b2', promiseId: 'p2', sceneRef: 's2', episodeId: 'ep-x', kind: 'advance' },
        ],
      },
      growth_curve: [
        { character_id: 'char-lin', start_state: '起点', turning_points: [{ turning_point: '觉醒', linked_episode_ids: ['ep-x'] }] },
      ],
    } as any);
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'remove_episode', episodeId: 'ep-x' }] }),
    );
    // 透传不拒：envelope 照产（空集 = 删除后状态）。
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.data).toHaveLength(0);
    // 双通道：metadata.episodeRemovalWarnings 携三源 + output 文字 leader 可见。
    const warnings = res.metadata?.episodeRemovalWarnings as Array<{ episodeId: string; references: string[] }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0].episodeId).toBe('ep-x');
    expect(warnings[0].references.join('\n')).toContain('scene_graph 2 场');
    expect(warnings[0].references.join('\n')).toContain('promise_registry');
    expect(warnings[0].references.join('\n')).toContain('growth_curve');
    expect(res.output).toContain('集删除引用警告');
    expect(res.output).toContain('ep-x');
  });

  it('remove 无引用集 → 静默删零警告（不产噪声段）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...OUTLINE_DOC(['phase-1']),
      episode_outlines: [{ id: 'ep-clean', index: 1, title: '无锚集', status: 'planned' }],
      scene_graph: { nodes: [{ id: 's1', storyTime: 1, presentationOrder: { chapter: 1, pos: 0 }, role: 'normal', episodeId: 'ep-other' }] },
    } as any);
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'remove_episode', episodeId: 'ep-clean' }] }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.data).toHaveLength(0);
    expect(res.metadata?.episodeRemovalWarnings).toEqual([]);
    expect(res.output).not.toContain('集删除引用警告');
  });

  it('remove 不存在的集（幂等 no-op）→ 不告警（无删除事实）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...OUTLINE_DOC(['phase-1']),
      scene_graph: { nodes: [{ id: 's1', storyTime: 1, presentationOrder: { chapter: 1, pos: 0 }, role: 'normal', episodeId: 'ep-ghost' }] },
    } as any);
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'remove_episode', episodeId: 'ep-ghost' }] }),
    );
    expect(res.metadata?.episodeRemovalWarnings).toEqual([]);
    expect(res.output).not.toContain('集删除引用警告');
  });

  // ── CR-Blind-F3/Edge-F2（8.5 CR）：同批 add_episode id 重复 → 整批拒 + truthful reason。──
  it('同批两条 add_episode 同 id → 整批拒（batch-atomic），reason 指向 update_episode', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({
        actions: [
          { op: 'add_episode', episode: FULL_EPISODE },
          { op: 'add_episode', episode: { ...FULL_EPISODE, title: '同 id 第二条' } },
        ],
      }),
    );
    expect(res.metadata?.type).toBeUndefined(); // 无 envelope——整批拒
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('同一批次');
    expect(res.output).toContain('ep-10');
    expect(res.output).toContain('update_episode');
  });

  it('同批不同 id 的多条 add_episode → 正常投影（重复检查不误伤）', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({
        actions: [
          { op: 'add_episode', episode: FULL_EPISODE },
          { op: 'add_episode', episode: { ...FULL_EPISODE, id: 'ep-11', index: 11, title: '第二集' } },
        ],
      }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.data).toHaveLength(2);
  });

  it('坏 action（缺 title）→ schema 层拒 + surfaced', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'add_episode', episode: { id: 'e', index: 0 } }] }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('操作格式无效');
  });

  it('空 actions → 友好 no-op（P16 mirror）', async () => {
    const res = await episodeOutlinesUpdateHandler(ctx({ actions: [] }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('已跳过');
  });

  it('corrupt episode_outlines（字段为 string）→ 拒绝 update（防 action:set 覆盖不可读数据）', async () => {
    vi.mocked(loadProject).mockReturnValue({ ...ABSENT_DOC, episode_outlines: 'not-an-array' } as any);
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'add_episode', episode: FULL_EPISODE }] }),
    );
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('被拒');
  });

  it('loadProject 返 null → 拒绝 update（跨字段污染防护）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'add_episode', episode: FULL_EPISODE }] }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('无法读取');
  });
});

describe('episodeOutlinesUpdateHandler autoApply (Story 8.5 — auto 档直落)', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(OUTLINE_DOC(['phase-1']) as any);
    vi.mocked(onFieldEdited).mockReset();
    vi.mocked(onFieldEdited).mockReturnValue(onFieldEditedOk());
  });

  it('autoApply=true → onFieldEdited（episode_outlines，source=agent，full array）→ applied metadata + phaseWarnings', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_episode', episode: { ...FULL_EPISODE, phase_ref: 'phase-ghost' } }] }),
    );

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('episode_outlines');
    expect((data as any[])).toHaveLength(1);
    expect((options as { source?: string }).source).toBe('agent');

    // warn 透传不拒：autoApply 路径同样落盘 + 警告可见。
    expect(res.metadata).toMatchObject({
      ok: true,
      applied: true,
      episodeCount: 1,
      phaseWarnings: [{ episodeId: 'ep-10', phaseRef: 'phase-ghost' }],
    });
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('悬空');
  });

  it('autoApply 缺省 false → 不调 onFieldEdited，走 field_patch envelope', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({ actions: [{ op: 'add_episode', episode: FULL_EPISODE }] }),
    );
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
  });

  it('graceful：onFieldEdited 抛错 → 不破 handler，返失败提示', async () => {
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field episode_outlines is locked and cannot be edited');
    });
    const res = await episodeOutlinesUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_episode', episode: FULL_EPISODE }] }),
    );
    expect(res.metadata?.applied).toBeUndefined();
    expect(res.output).toContain('自动生效失败');
    expect(res.output).toContain('locked');
  });
});
