import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story 5.2 EmotionCurve tool handlers（mirror infoReleaseHandlers.test.ts）。
// Locks the creative-field write pattern (bounded action → autoApply dual-mode / field_patch envelope)。
// emotion_curve 是目标轨 creative field（Director per-scene 前向产），区别于 info_release_map：
// - emotionPoint 用 refId（非 id）作识别键；emotion_curve 无 in-data version/updatedBy（field_metadata 管 sync version）。
// - emotionCurveSchema.unit required（无 default）—— absent 时 fresh curve 显式 unit:'scene'（D-5.1-1）。

// loadProject / onFieldEdited 动态 import（handler 内）；top-level mock，per-test vi.mocked 控制。
// Default loadProject = valid project doc 无 emotion_curve 字段（absent -> fresh empty curve 是正确基底）。
vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import {
  emotionCurveReadHandler,
  emotionCurveUpdateHandler,
} from '../main/ipc/toolHandlers/emotionCurveHandlers';

const ctx = (params: Record<string, unknown>, projectDir = '/proj') => ({
  params,
  projectDir,
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

const FULL_POINT = {
  refId: 's_court',
  sceneMood: '压抑',
  characters: [{ characterId: 'char_main', emotion: '恐惧', emotionEnd: '决心', vad: { v: -0.7, a: 0.8, d: -0.3 } }],
};

describe('emotionCurveUpdateHandler (Story 5.2，non-autoApply field_patch 路径)', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    vi.mocked(onFieldEdited).mockClear();
  });

  it('合法 add_point → 投影 schema-valid → 产 field_patch metadata', async () => {
    const res = await emotionCurveUpdateHandler(ctx({ actions: [{ op: 'add_point', point: FULL_POINT }] }));

    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('emotion_curve');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as any;
    expect(data.points).toHaveLength(1);
    expect(data.points[0]).toMatchObject({ refId: 's_court', sceneMood: '压抑' });
    expect(data.unit).toBe('scene'); // absent → fresh curve unit:scene（D-5.1-1）
  });

  it('absent emotion_curve（项目无该字段）→ 当空 curve 投影（fresh unit:scene 基底），产 field_patch', async () => {
    const res = await emotionCurveUpdateHandler(ctx({ actions: [{ op: 'add_point', point: FULL_POINT }] }));
    expect(res.metadata?.type).toBe('field_patch');
    expect((res.metadata?.data as any).points).toHaveLength(1);
  });

  it('corrupt emotion_curve（字段存在但 schema-invalid）→ 拒绝 update + 不产 field_patch', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      emotion_curve: { points: 'not-an-array' },
    } as any);
    const res = await emotionCurveUpdateHandler(ctx({ actions: [{ op: 'add_point', point: FULL_POINT }] }));
    expect(res.metadata?.type).toBeUndefined(); // 非 field_patch
    expect(res.output).toContain('被拒');
  });

  it('loadProject 返 null（整文档 corrupt/missing）→ 拒绝 update（跨字段污染防护）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await emotionCurveUpdateHandler(ctx({ actions: [{ op: 'add_point', point: FULL_POINT }] }));
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('无法读取');
  });

  it('add_point：refId 已存在 → 覆盖（幂等）；update_point 既有覆盖 + 新 refId 追加', async () => {
    const existing = {
      ...ABSENT_DOC,
      emotion_curve: {
        unit: 'scene',
        points: [{ refId: 's_court', sceneMood: '旧氛围', characters: [{ characterId: 'char_main', emotion: '焦虑' }] }],
      },
    };
    vi.mocked(loadProject).mockReturnValue(existing as any);
    const res = await emotionCurveUpdateHandler(
      ctx({
        actions: [
          { op: 'update_point', point: FULL_POINT }, // 既有 s_court 覆盖
          { op: 'add_point', point: { refId: 's_new', characters: [{ characterId: 'char_main', emotion: '愤怒' }] } }, // 新追加
        ],
      }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    expect(data.points).toHaveLength(2);
    const court = data.points.find((p: any) => p.refId === 's_court');
    expect(court.sceneMood).toBe('压抑'); // 覆盖为 FULL_POINT
    expect(data.points.find((p: any) => p.refId === 's_new')).toBeDefined();
  });

  it('remove_point：存在 → 删；不存在 → 幂等跳过', async () => {
    const existing = {
      ...ABSENT_DOC,
      emotion_curve: {
        unit: 'scene',
        points: [
          { refId: 's_court', characters: [{ characterId: 'c1', emotion: '恐惧' }] },
          { refId: 's_other', characters: [{ characterId: 'c1', emotion: '愤怒' }] },
        ],
      },
    };
    vi.mocked(loadProject).mockReturnValue(existing as any);
    const res = await emotionCurveUpdateHandler(
      ctx({
        actions: [
          { op: 'remove_point', refId: 's_court' },
          { op: 'remove_point', refId: '不存在' },
        ],
      }),
    );
    const data = res.metadata?.data as any;
    expect(data.points).toHaveLength(1);
    expect(data.points[0].refId).toBe('s_other');
  });

  it('非法 action shape（缺 point / 缺 refId）→ surfaced 非 persist', async () => {
    const res = await emotionCurveUpdateHandler(ctx({ actions: [{ op: 'add_point' }] })); // 缺 point
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('操作格式无效');
  });
});

describe('emotionCurveReadHandler (Story 5.2)', () => {
  it('读 emotion_curve.points（无 filter）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      emotion_curve: {
        unit: 'scene',
        points: [
          { refId: 's1', characters: [{ characterId: 'c1', emotion: '恐惧' }] },
          { refId: 's2', characters: [{ characterId: 'c1', emotion: '愤怒' }] },
        ],
      },
    } as any);
    const res = await emotionCurveReadHandler(ctx({}));
    expect(res.metadata?.count).toBe(2);
    expect((res.metadata?.points as any[])).toHaveLength(2);
  });

  it('按 sceneId（refId）filter', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      emotion_curve: {
        unit: 'scene',
        points: [
          { refId: 's1', characters: [{ characterId: 'c1', emotion: '恐惧' }] },
          { refId: 's2', characters: [{ characterId: 'c1', emotion: '愤怒' }] },
        ],
      },
    } as any);
    const res = await emotionCurveReadHandler(ctx({ sceneId: 's1' }));
    expect(res.metadata?.count).toBe(1);
    expect((res.metadata?.points as any[])[0].refId).toBe('s1');
  });

  it('absent emotion_curve → 空 points（additive）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await emotionCurveReadHandler(ctx({}));
    expect(res.metadata?.count).toBe(0);
    expect(res.output).toContain('为空');
  });

  it('loadProject 返 null → 友好不可读提示（永不抛）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await emotionCurveReadHandler(ctx({}));
    expect(res.output).toContain('无法读取');
  });
});

// Story 5.2 DW-4：Director 自动 authoring autoApply 落盘路径（mirror infoReleaseMapUpdateHandler autoApply）。
// Director 传 autoApply:true → handler 直接 onFieldEdited(source:'agent') 落盘 emotion_curve（不经 PatchReview）。
describe('emotionCurveUpdateHandler autoApply (Story 5.2 — Director 自动 authoring)', () => {
  beforeEach(() => {
    vi.mocked(onFieldEdited).mockClear();
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
  });

  it('DW-4：autoApply=true → 调 onFieldEdited（source=agent，projected curve）→ 返 applied metadata（非 field_patch）', async () => {
    const res = await emotionCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_point', point: FULL_POINT }] }),
    );

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('emotion_curve');
    expect((data as any).points).toHaveLength(1);
    expect((data as any).points[0]).toMatchObject({ refId: 's_court' });
    expect((options as { source?: string }).source).toBe('agent');
    expect(typeof (options as { reason?: string }).reason).toBe('string');

    expect(res.metadata).toMatchObject({ ok: true, applied: true, pointCount: 1 });
    expect(res.metadata?.type).toBeUndefined(); // 非 field_patch
    expect(res.output).toContain('已生效');
  });

  it('DW-4：autoApply 缺省 false → 不调 onFieldEdited，走 field_patch envelope（leader PatchReview 路径）', async () => {
    const res = await emotionCurveUpdateHandler(
      ctx({ actions: [{ op: 'add_point', point: FULL_POINT }] }),
    );
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.action).toBe('set');
    expect((res.metadata?.data as any).points).toHaveLength(1);
  });

  it('DW-4：autoApply=true on corrupt emotion_curve → 拒绝（不调 onFieldEdited，不 overwrite）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      emotion_curve: { points: 'not-an-array' },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await emotionCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_point', point: FULL_POINT }] }),
    );
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.output).toContain('被拒');
    warn.mockRestore();
  });

  it('DW-4 graceful：onFieldEdited 抛错（locked field / save fail）→ 不破 handler，返失败提示', async () => {
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field emotion_curve is locked and cannot be edited');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await emotionCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'add_point', point: FULL_POINT }] }),
    );
    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    expect(res.metadata?.applied).toBeUndefined();
    expect(res.output).toContain('自动生效失败');
    expect(res.output).toContain('locked');
    warn.mockRestore();
  });
});
