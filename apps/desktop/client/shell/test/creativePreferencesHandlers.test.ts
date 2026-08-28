/**
 * creative_preferences_update shell handler tests (Story 8.6 R3, design D3/D4 / §3.1).
 *
 * Mirror creativeBriefHandlers.test.ts：四轴 partial merge（undefined 轴不覆盖——只改问到的
 * 轴）、field_patch envelope 形态（field creative_preferences 走 generic PatchReview 链）、
 * safeParse 拒非法档位值（本次 vs 盘上两态）、autoApply 双档 + locked 降级。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn: vi.fn() }) }));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import { creativePreferencesUpdateHandler } from '../main/ipc/toolHandlers/creativePreferencesHandlers';

const ctx = (params: Record<string, unknown>) => ({
  params,
  projectDir: '/proj',
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

describe('creativePreferencesUpdateHandler 四轴 partial merge（suggest 档）', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    vi.mocked(onFieldEdited).mockReset();
  });

  it('absent creative_preferences（未问 = 标准档）→ 单轴更新起步，envelope 只含该轴', async () => {
    const res = await creativePreferencesUpdateHandler(ctx({ updates: { outline_depth: 'skeleton' } }));
    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('creative_preferences');
    expect(res.metadata?.action).toBe('set');
    expect(res.metadata?.data).toEqual({ outline_depth: 'skeleton' });
  });

  it('四轮 partial merge——每轮只问一域，既有轴累积保留（undefined 不覆盖）', async () => {
    // Round 1：问大纲细度（absent 起步）。
    const r1 = await creativePreferencesUpdateHandler(ctx({ updates: { outline_depth: 'skeleton' } }));
    expect(r1.metadata?.data).toEqual({ outline_depth: 'skeleton' });

    // Round 2：问弧线时序——盘上已有 outline_depth（mock 模拟 Round 1 落盘后的状态）。
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_preferences: { outline_depth: 'skeleton' },
    } as any);
    const r2 = await creativePreferencesUpdateHandler(ctx({ updates: { arc_timing: 'as_you_go' } }));
    expect(r2.metadata?.data).toEqual({ outline_depth: 'skeleton', arc_timing: 'as_you_go' });

    // Round 3：问世界深度。
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_preferences: { outline_depth: 'skeleton', arc_timing: 'as_you_go' },
    } as any);
    const r3 = await creativePreferencesUpdateHandler(ctx({ updates: { world_depth: 'shell' } }));
    expect(r3.metadata?.data).toEqual({
      outline_depth: 'skeleton',
      arc_timing: 'as_you_go',
      world_depth: 'shell',
    });

    // Round 4：问人物深度 + 备注——五字段全量，既有四值不动。
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_preferences: { outline_depth: 'skeleton', arc_timing: 'as_you_go', world_depth: 'shell' },
    } as any);
    const r4 = await creativePreferencesUpdateHandler(ctx({
      updates: { character_depth: 'framework', note: '世界设定型作者，先建世界后排大纲' },
    }));
    expect(r4.metadata?.data).toEqual({
      outline_depth: 'skeleton',
      arc_timing: 'as_you_go',
      world_depth: 'shell',
      character_depth: 'framework',
      note: '世界设定型作者，先建世界后排大纲',
    });
  });

  it('改某一轴不触碰其他轴——note 更新时四轴原样', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_preferences: {
        outline_depth: 'chapter',
        arc_timing: 'upfront',
        world_depth: 'upfront',
        character_depth: 'full',
      },
    } as any);
    const res = await creativePreferencesUpdateHandler(ctx({ updates: { note: '全填型作者' } }));
    expect(res.metadata?.data).toEqual({
      outline_depth: 'chapter',
      arc_timing: 'upfront',
      world_depth: 'upfront',
      character_depth: 'full',
      note: '全填型作者',
    });
  });

  it('CR-005：note 空串（trim 后空白）视为未提供——不清空既有备注（mirror creativeBriefHandlers 同修）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_preferences: { outline_depth: 'skeleton', note: '节奏慢一点' },
    } as any);
    const res = await creativePreferencesUpdateHandler(ctx({ updates: { note: '   ', arc_timing: 'as_you_go' } }));
    expect(res.metadata?.data).toEqual({
      outline_depth: 'skeleton',
      arc_timing: 'as_you_go',
      note: '节奏慢一点', // 空串不覆盖
    });
  });

  it('非法档位值 → safeParse 拒 + 指认 this update（四轴取值须为档位枚举）', async () => {
    const res = await creativePreferencesUpdateHandler(ctx({ updates: { outline_depth: 'super-deep' } }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('本次更新');
  });

  it('CR-018：note 超长（>4000）→ safeParse 拒 + 指认 this update（schema 层拦 LLM 失控超长）', async () => {
    const res = await creativePreferencesUpdateHandler(ctx({ updates: { note: 'x'.repeat(4001) } }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('本次更新');
  });

  it('盘上既有坏数据（arc_timing 坏值）→ 拒 + 指认 on disk', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_preferences: { arc_timing: 'whenever' },
    } as any);
    const res = await creativePreferencesUpdateHandler(ctx({ updates: { outline_depth: 'volume' } }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('请先修复项目设定文件');
  });

  it('updates 空对象 / params null → 友好 skip 不产零变更 patch（P16 + CR-008）', async () => {
    const res1 = await creativePreferencesUpdateHandler(ctx({ updates: {} }));
    expect(res1.metadata).toBeUndefined();
    expect(res1.output).toContain('已跳过');

    const res2 = await creativePreferencesUpdateHandler({
      params: null as any,
      projectDir: '/proj',
      sessionId: 's1',
      abort: new AbortController().signal,
    });
    expect(res2.output).toContain('已跳过');
  });

  it('suggest 档不落盘 + 输出说人话（呈给作者采纳句式）', async () => {
    const res = await creativePreferencesUpdateHandler(ctx({ updates: { arc_timing: 'upfront' } }));
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.output).toContain('由作者决定是否采纳');
  });

  it('loadProject 返 null → 拒（不向空基底 merge 覆盖真实不可读数据）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await creativePreferencesUpdateHandler(ctx({ updates: { arc_timing: 'upfront' } }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('无法读取');
  });
});

describe('creativePreferencesUpdateHandler autoApply 双档', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_preferences: { outline_depth: 'skeleton' },
    } as any);
    vi.mocked(onFieldEdited).mockReset();
  });

  it('autoApply=true → onFieldEdited(source=agent) 落盘 merged → 返 applied metadata + 轴摘要', async () => {
    const res = await creativePreferencesUpdateHandler(ctx({
      autoApply: true,
      updates: { arc_timing: 'as_you_go' },
    }));

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('creative_preferences');
    expect(options).toEqual({ source: 'agent', reason: '创作偏好更新（auto 档）' });
    expect(data).toEqual({ outline_depth: 'skeleton', arc_timing: 'as_you_go' });

    expect(res.metadata?.type).toBeUndefined();
    expect(res.metadata).toMatchObject({ ok: true, applied: true });
    expect(res.output).toContain('已直接生效');
    expect(res.output).toContain('arc_timing');
  });

  it('locked field 拒 → 降级 field_patch envelope + 说明（提议不丢）', async () => {
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field creative_preferences is locked and cannot be edited');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await creativePreferencesUpdateHandler(ctx({
      autoApply: true,
      updates: { world_depth: 'upfront' },
    }));
    warn.mockRestore();

    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('creative_preferences');
    expect(res.metadata?.action).toBe('set');
    expect(res.metadata?.data).toEqual({ outline_depth: 'skeleton', world_depth: 'upfront' });
    expect(res.output).toContain('自动生效被拒');
    expect(res.output).toContain('没有丢失');
  });

  it('显式 autoApply=false → envelope 路径 + 不落盘', async () => {
    const res = await creativePreferencesUpdateHandler(ctx({ autoApply: false, updates: { note: 'x' } }));
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('creative_preferences');
  });
});
