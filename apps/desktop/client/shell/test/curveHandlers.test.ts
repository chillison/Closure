/**
 * Story 8.5 R1 curve shell handler tests — growth_curve_update / pacing_curve_update
 * （mirror arcLedgerHandlers.test.ts / emotionCurveHandlers.test.ts）。
 *
 * Locks the creative-field bounded-write pattern (add/update/remove → field_patch envelope
 * / autoApply direct persist) + corrupt-vs-absent guard + D2 array canonical（宽容读旧单条归一）
 * + B1 partial-merge（add_curve 已存在角色不填 defaults 覆盖）trust boundary。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadProject / onFieldEdited are imported dynamically inside the handler; mock at top level and
// control per-test via vi.mocked. Default loadProject = a valid project doc with NO curve fields
// （absent -> fresh base 是正确基底）。Default onFieldEdited = no-op spy（autoApply 路径用）。
vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn: vi.fn() }) }));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import {
  growthCurveUpdateHandler,
  pacingCurveUpdateHandler,
} from '../main/ipc/toolHandlers/curveHandlers';

const ctx = (params: Record<string, unknown>, projectDir = '/proj') => ({
  params,
  projectDir,
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

/**
 * onFieldEdited 返回类型的最小合法 shape（WorkflowSyncEvent 全 required 字段——mockReturnValue
 * 按函数真实签名全型检查，缺字段是 typecheck error 非 runtime error）。
 */
function onFieldEditedOk() {
  return {
    syncEvent: {
      id: 'evt_test',
      createdAt: '2026-08-18T00:00:00.000Z',
      source: 'agent' as const,
      field: 'growth_curve' as const,
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

const NEW_CURVE = {
  character_id: 'char-lin',
  start_state: '封闭自保，不信任任何人',
  wound_or_lack: '幼年目睹告密者灭门，信任即死亡',
  desire: '查清父亲叛徒污名的真相',
  need: '重新学会信任同伴',
  turning_points: [{ turning_point: '审判日：为同伴作证', linked_episode_ids: ['ep-10'] }],
  end_state: '与同伴并肩走入下一卷',
};

describe('growthCurveUpdateHandler (Story 8.5 R1，non-autoApply field_patch 路径)', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    // mockReset + 显式 mockReturnValue：graceful 测试的 throw 实现**会跨 describe 泄漏**（mockClear
    // 只清 calls 不清 implementation，pacing describe 排在 growth graceful 之后会踩到 throw 残留）。
    vi.mocked(onFieldEdited).mockReset();
    vi.mocked(onFieldEdited).mockReturnValue(onFieldEditedOk());
  });

  it('合法 add_curve（absent 基底）→ 投影 schema-valid → 产 field_patch（field growth_curve，array canonical）', async () => {
    const res = await growthCurveUpdateHandler(ctx({ actions: [{ op: 'add_curve', curve: NEW_CURVE }] }));

    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('growth_curve');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as any;
    expect(Array.isArray(data)).toBe(true); // D2：canonical array（非单条对象）
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ character_id: 'char-lin', desire: '查清父亲叛徒污名的真相' });
  });

  it('add_curve 缺 defaulted 字段 → parse 填 defaults（turning_points/regressions/linked_episode_ids）', async () => {
    const res = await growthCurveUpdateHandler(
      ctx({ actions: [{ op: 'add_curve', curve: { character_id: 'char-2', start_state: '起点' } }] }),
    );
    const data = res.metadata?.data as any;
    expect(data[0].turning_points).toEqual([]);
    expect(data[0].regressions).toEqual([]);
    expect(data[0].linked_episode_ids).toEqual([]);
  });

  it('B1 partial merge：add_curve 已存在 character_id → 只合并显式字段，既有 turning_points 不被空 default 覆盖', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      growth_curve: [
        {
          character_id: 'char-lin',
          start_state: '旧起点',
          turning_points: [{ turning_point: '既有转折', linked_episode_ids: ['ep-3'] }],
          regressions: ['既有倒退'],
          linked_episode_ids: ['ep-1'],
        },
      ],
    } as any);
    // 只显式改 desire——不携 turning_points/regressions（growthCurveWriteSchema optional 不填 default）。
    const res = await growthCurveUpdateHandler(
      ctx({ actions: [{ op: 'add_curve', curve: { character_id: 'char-lin', start_state: '旧起点', desire: '新欲望' } }] }),
    );
    const data = res.metadata?.data as any;
    expect(data).toHaveLength(1);
    expect(data[0].desire).toBe('新欲望');
    expect(data[0].turning_points).toHaveLength(1); // B1：既有转折点保留
    expect(data[0].regressions).toEqual(['既有倒退']);
  });

  it('宽容读旧形态：yaml 单条 growth_curve → 归一 array 后投影（D2 zero-data-loss）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      growth_curve: { character_id: 'char-old', start_state: '旧单条形态' }, // 旧 yaml 单条对象
    } as any);
    const res = await growthCurveUpdateHandler(
      ctx({ actions: [{ op: 'add_curve', curve: { character_id: 'char-new', start_state: '新角色' } }] }),
    );
    const data = res.metadata?.data as any;
    expect(data).toHaveLength(2); // 单条包成数组 + 新增
    expect(data[0].character_id).toBe('char-old');
  });

  it('update_curve 浅合并 patch + identity character_id 不可改（patch 内 character_id 被 omit strip）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      growth_curve: [{ character_id: 'char-lin', start_state: '旧起点', turning_points: [], regressions: [], linked_episode_ids: [] }],
    } as any);
    const res = await growthCurveUpdateHandler(
      // patch schema omit character_id——zod 默认 strip 未知键，注入的 character_id 被剥。
      ctx({ actions: [{ op: 'update_curve', character_id: 'char-lin', patch: { end_state: '新终点' } }] }),
    );
    const data = res.metadata?.data as any;
    expect(data).toHaveLength(1);
    expect(data[0].end_state).toBe('新终点');
    expect(data[0].start_state).toBe('旧起点'); // 未提字段保留
  });

  it('remove_curve 不存在 character_id → 幂等跳过（仍产 envelope，data 不变）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      growth_curve: [{ character_id: 'char-lin', start_state: 's', turning_points: [], regressions: [], linked_episode_ids: [] }],
    } as any);
    const res = await growthCurveUpdateHandler(
      ctx({ actions: [{ op: 'remove_curve', character_id: 'ghost' }] }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    expect((res.metadata?.data as any[])).toHaveLength(1);
  });

  it('坏 action（add_curve 缺 character_id）→ schema 层拒 + surfaced，不产 field_patch', async () => {
    const res = await growthCurveUpdateHandler(
      ctx({ actions: [{ op: 'add_curve', curve: { start_state: '无身份' } }] }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('操作格式无效');
  });

  it('空 actions → 友好 no-op（不产零变更 patch，P16 mirror）', async () => {
    const res = await growthCurveUpdateHandler(ctx({ actions: [] }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('已跳过');
  });

  it('corrupt growth_curve（字段为 string）→ 拒绝 update（防 action:set 覆盖不可读数据）', async () => {
    vi.mocked(loadProject).mockReturnValue({ ...ABSENT_DOC, growth_curve: 'not-an-object' } as any);
    const res = await growthCurveUpdateHandler(ctx({ actions: [{ op: 'add_curve', curve: NEW_CURVE }] }));
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('形态坏');
  });

  it('loadProject 返 null（整文档 corrupt/missing）→ 拒绝 update（跨字段污染防护）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await growthCurveUpdateHandler(ctx({ actions: [{ op: 'add_curve', curve: NEW_CURVE }] }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('无法读取');
  });

  // ── CR-004（8.5 BMad CR）：array/Record 逐条 drop-bad-keep-good——一条坏弧不砖整字段写通道。──

  it('array 混坏条目（1 好 + 1 坏）→ 好弧为基底照常编辑 + 坏条目 reason 可见（不整字段 corrupt 拒）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      growth_curve: [
        { character_id: 'char-good', start_state: '好弧', turning_points: [], regressions: [], linked_episode_ids: [] },
        { character_id: 'char-bad' }, // 缺 start_state → 坏条目
      ],
    } as any);
    const res = await growthCurveUpdateHandler(
      ctx({ actions: [{ op: 'update_curve', character_id: 'char-good', patch: { desire: '新欲望' } }] }),
    );
    // 好弧照常服务编辑（非整字段 corrupt 拒）。
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    expect(data).toHaveLength(1); // 投影只含好弧（坏条目被剔除）
    expect(data[0]).toMatchObject({ character_id: 'char-good', desire: '新欲望' });
    // 坏条目可见性：output 提示 + metadata 计数（落盘全量 set 会移除坏条目，LLM/作者须知）。
    expect(res.output).toContain('1 条坏形态条目未读入');
    expect(res.output).toContain('char-bad');
    expect(res.metadata?.droppedBadCurveCount).toBe(1);
  });

  it('array 全坏条目 → 仍 corrupt 拒（无好基底，防增量编辑整字段覆盖全部坏数据）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      growth_curve: [{ character_id: 'char-bad' }, 'garbage'],
    } as any);
    const res = await growthCurveUpdateHandler(ctx({ actions: [{ op: 'add_curve', curve: NEW_CURVE }] }));
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('2 条坏形态');
  });

  it('Record 混坏值（1 好 + 1 坏）→ 好值保留 + 坏值 reason 可见（key 补缺好值照常读）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      growth_curve: {
        'char-good': { character_id: 'char-good', start_state: '好弧' },
        garbage: 'not-a-curve',
      },
    } as any);
    const res = await growthCurveUpdateHandler(
      ctx({ actions: [{ op: 'add_curve', curve: { character_id: 'char-new', start_state: '新角色' } }] }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    expect(data.map((c: any) => c.character_id)).toEqual(['char-good', 'char-new']);
    expect(res.output).toContain('garbage');
    expect(res.metadata?.droppedBadCurveCount).toBe(1);
  });

  it('autoApply 路径同样透出坏条目提示（droppedBadCurves 随落盘摘要可见）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      growth_curve: [
        { character_id: 'char-good', start_state: '好弧' },
        { character_id: 'char-bad' },
      ],
    } as any);
    const res = await growthCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'update_curve', character_id: 'char-good', patch: { desire: '新' } }] }),
    );
    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    expect(res.metadata?.applied).toBe(true);
    expect(res.output).toContain('1 条坏形态条目未读入');
    expect(res.metadata?.droppedBadCurveCount).toBe(1);
  });

  // ── CR-008（8.5 BMad CR）：params null/undefined 头部归一守卫（never-throws 契约）。──

  it('params null / undefined → 友好 skip 不 throw（畸形 provider arguments 防线）', async () => {
    for (const badParams of [null, undefined]) {
      const res = await growthCurveUpdateHandler(ctx(badParams as any));
      expect(res.output).toContain('已跳过');
      expect(res.output).not.toContain('Error');
      expect(res.metadata).toBeUndefined();
    }
    const resPacing = await pacingCurveUpdateHandler(ctx(null as any));
    expect(resPacing.output).toContain('已跳过');
  });
});

describe('growthCurveUpdateHandler autoApply (Story 8.5 — auto 档直落)', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    vi.mocked(onFieldEdited).mockReset();
    vi.mocked(onFieldEdited).mockReturnValue(onFieldEditedOk());
  });

  it('autoApply=true → 调 onFieldEdited（source=agent，canonical array）→ 返 applied metadata（非 field_patch）', async () => {
    const res = await growthCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_curve', curve: NEW_CURVE }] }),
    );

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('growth_curve');
    expect(Array.isArray(data)).toBe(true);
    expect((data as any[])).toHaveLength(1);
    expect((options as { source?: string }).source).toBe('agent');
    expect(typeof (options as { reason?: string }).reason).toBe('string');

    expect(res.metadata).toMatchObject({ ok: true, applied: true, curveCount: 1 });
    expect(res.metadata?.type).toBeUndefined(); // 非 field_patch
    expect(res.output).toContain('角色成长弧已生效');
    expect(res.output).toContain('已写入项目设定');
  });

  it('autoApply 缺省 false → 不调 onFieldEdited，走 field_patch envelope（suggest 档主路径）', async () => {
    const res = await growthCurveUpdateHandler(ctx({ actions: [{ op: 'add_curve', curve: NEW_CURVE }] }));
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
  });

  it('graceful：onFieldEdited 抛错（locked field / save fail）→ 不破 handler，返失败提示', async () => {
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field growth_curve is locked and cannot be edited');
    });
    const res = await growthCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_curve', curve: NEW_CURVE }] }),
    );
    expect(res.metadata?.applied).toBeUndefined();
    expect(res.output).toContain('自动生效失败');
    expect(res.output).toContain('locked');
  });
});

describe('pacingCurveUpdateHandler (Story 8.5 R1，mirror emotion_curve_update)', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    vi.mocked(onFieldEdited).mockReset();
    vi.mocked(onFieldEdited).mockReturnValue(onFieldEditedOk());
  });

  it('absent 基底 add_point → fresh curve（unit episode）+ 产 field_patch（field pacing_curve）', async () => {
    const res = await pacingCurveUpdateHandler(
      ctx({ actions: [{ op: 'add_point', point: { refId: 'ep-3', intensity: 7, note: '审判日开庭' } }] }),
    );

    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('pacing_curve');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as any;
    expect(data.unit).toBe('episode'); // absent → fresh unit:episode 基线（mirror D-5.1-1 决策）
    expect(data.points).toHaveLength(1);
    expect(data.points[0]).toMatchObject({ refId: 'ep-3', intensity: 7 });
  });

  it('update_point by refId 覆盖既有点（幂等）；remove_point 幂等跳过不存在', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      pacing_curve: {
        unit: 'episode',
        points: [
          { refId: 'ep-3', intensity: 7 },
          { refId: 'ep-4', intensity: 3 },
        ],
        risks: ['连续高潮致麻木'],
      },
    } as any);
    const res = await pacingCurveUpdateHandler(
      ctx({
        actions: [
          { op: 'update_point', point: { refId: 'ep-3', intensity: 9 } },
          { op: 'remove_point', refId: 'ghost' },
        ],
      }),
    );
    const data = res.metadata?.data as any;
    expect(data.points).toHaveLength(2); // remove ghost 幂等跳过
    expect(data.points[0]).toMatchObject({ refId: 'ep-3', intensity: 9 });
    // unit/target_shape/risks 透传不动（projector 只管 points）。
    expect(data.unit).toBe('episode');
    expect(data.risks).toEqual(['连续高潮致麻木']);
  });

  it('坏 point（intensity 超 0-10）→ schema 层拒 + surfaced', async () => {
    const res = await pacingCurveUpdateHandler(
      ctx({ actions: [{ op: 'add_point', point: { refId: 'ep-1', intensity: 11 } }] }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
  });

  it('corrupt pacing_curve → 拒绝 update（不投影到 fresh curve）', async () => {
    vi.mocked(loadProject).mockReturnValue({ ...ABSENT_DOC, pacing_curve: { points: 'nope' } } as any);
    const res = await pacingCurveUpdateHandler(
      ctx({ actions: [{ op: 'add_point', point: { refId: 'ep-1', intensity: 5 } }] }),
    );
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('被拒');
  });

  it('autoApply=true → onFieldEdited（pacing_curve，source=agent）→ applied metadata；缺省不调', async () => {
    const res = await pacingCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_point', point: { refId: 'ep-2', intensity: 6 } }] }),
    );
    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(field).toBe('pacing_curve');
    expect((data as any).points).toHaveLength(1);
    expect((options as { source?: string }).source).toBe('agent');
    expect(res.metadata).toMatchObject({ ok: true, applied: true, pointCount: 1 });
    expect(res.metadata?.type).toBeUndefined();
  });
});
