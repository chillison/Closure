/**
 * creative_brief_update shell handler tests (Story 8.6 R2, design D2 / §3.1).
 *
 * Mirror assetCardsHandlers.test.ts / curveHandlers.test.ts：partial merge 语义
 * （undefined 不覆盖 / rawRequirement 保真与 '' 兜底 / defaults 补齐）、safeParse 拒坏值
 * （本次 updates 坏值 vs 盘上既有坏数据两态）、field_patch envelope 形态、autoApply 双档
 * （onFieldEdited 直落 vs envelope 人审）+ locked 拒降级（提议不丢）、genre-contract 领地
 * 字段忽略 + 路由提示（防双写通道）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadProject / onFieldEdited are imported dynamically inside the handler; mock
// at top level and control per-test via vi.mocked. Default loadProject = a valid
// project doc with NO creative_brief field（absent → rawRequirement:'' 兜底是正确基底）；
// default onFieldEdited = a successful agent landing（autoApply 档）。
vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn: vi.fn() }) }));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import { creativeBriefUpdateHandler } from '../main/ipc/toolHandlers/creativeBriefHandlers';

const ctx = (params: Record<string, unknown>) => ({
  params,
  projectDir: '/proj',
  sessionId: 's1',
  abort: new AbortController().signal,
});

/** Full-params variant（autoApply 档测试用）. */
const ctxParams = (params: Record<string, unknown>) => ({
  params,
  projectDir: '/proj',
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

const EXISTING_BRIEF = {
  rawRequirement: '一个群岛世界的复仇故事',
  genre: '奇幻',
  tone: '冷峻',
};

describe('creativeBriefUpdateHandler partial merge（suggest 档 field_patch 路径）', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    // mockReset restores the vi.fn(impl) factory default（成功 agent landing）——
    // 前一测试的 throwing mockImplementation 不得泄漏。
    vi.mocked(onFieldEdited).mockReset();
  });

  it('params null / undefined → 友好 skip 不 throw（CR-008 never-throws 头部归一守卫）', async () => {
    for (const badParams of [null, undefined]) {
      const res = await creativeBriefUpdateHandler({
        params: badParams as any,
        projectDir: '/proj',
        sessionId: 's1',
        abort: new AbortController().signal,
      });
      expect(res.output).toContain('已跳过');
      expect(res.metadata).toBeUndefined();
    }
  });

  it('absent creative_brief（新项目）→ rawRequirement "" 兜底起步 + defaults 补齐，产 field_patch envelope', async () => {
    const res = await creativeBriefUpdateHandler(ctx({
      updates: { rawRequirement: '我想写一个关于记忆商人的故事', tone: '温柔而哀伤' },
    }));
    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('creative_brief');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as Record<string, unknown>;
    expect(data.rawRequirement).toBe('我想写一个关于记忆商人的故事');
    expect(data.tone).toBe('温柔而哀伤');
    // schema defaults 补齐（envelope data 是 schema-validated 输出）。
    expect(data.taboos).toEqual([]);
    expect(data.userConstraints).toEqual([]);
    expect(data.genre_tags).toEqual([]);
  });

  it('undefined 字段不覆盖——updates 只给 tone 时既有 genre / rawRequirement 原样保留', async () => {
    vi.mocked(loadProject).mockReturnValue({ ...ABSENT_DOC, creative_brief: EXISTING_BRIEF } as any);
    const res = await creativeBriefUpdateHandler(ctx({ updates: { tone: '热血' } }));
    const data = res.metadata?.data as Record<string, unknown>;
    expect(data.tone).toBe('热血');
    expect(data.genre).toBe('奇幻');
    expect(data.rawRequirement).toBe('一个群岛世界的复仇故事');
  });

  it('CR-005：trim 后空串视为未提供——rawRequirement/theme 空串不清空既有值（防静默丢灵感原文）', async () => {
    vi.mocked(loadProject).mockReturnValue({ ...ABSENT_DOC, creative_brief: EXISTING_BRIEF } as any);
    const res = await creativeBriefUpdateHandler(ctx({
      updates: { rawRequirement: '', theme: '   ', tone: '热血' },
    }));
    const data = res.metadata?.data as Record<string, unknown>;
    // 空串 / 纯空白串不覆盖（视为未提供）——灵感原文与既有 theme 保留。
    expect(data.rawRequirement).toBe('一个群岛世界的复仇故事');
    expect(data.theme).toBeUndefined();
    expect(data.tone).toBe('热血');
  });

  it('CR-005 数组语义不变：显式 [] = 合法清空列表（taboos 清空保留，非空数组照常覆盖）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_brief: { ...EXISTING_BRIEF, taboos: ['虐主'], userConstraints: ['每章 3000 字'] },
    } as any);
    const res = await creativeBriefUpdateHandler(ctx({ updates: { taboos: [], userConstraints: ['每章 5000 字'] } }));
    const data = res.metadata?.data as Record<string, unknown>;
    expect(data.taboos).toEqual([]); // 显式空数组 = intentional clear（CR-005 只拦空**串**）
    expect(data.userConstraints).toEqual(['每章 5000 字']);
  });

  it('既有 rawRequirement 非 string（手改坏形态）→ 兜底 "" 不吞异常值进 required 字段', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_brief: { rawRequirement: 42, genre: '科幻' },
    } as any);
    const res = await creativeBriefUpdateHandler(ctx({ updates: { tone: '紧张' } }));
    const data = res.metadata?.data as Record<string, unknown>;
    expect(data.rawRequirement).toBe('');
    expect(data.genre).toBe('科幻');
  });

  it('genre-contract 领地字段（genre_tags/commitments/world_constitution）不进本工具——忽略 + 路由提示', async () => {
    // 只有领地字段 = 无可更新字段 → skip + 提示走 genre_contract_update。
    const res = await creativeBriefUpdateHandler(ctx({ updates: { genre_tags: ['仙侠'] } }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('已跳过');
    expect(res.output).toContain('genre_contract_update');

    // 混入合法字段 → 合法字段照常 merge，领地字段被忽略且输出有路由提示。
    const res2 = await creativeBriefUpdateHandler(ctx({
      updates: { tone: '轻松', commitments: [{ type: 'HE', content: '大团圆' }] },
    }));
    const data = res2.metadata?.data as Record<string, unknown>;
    expect(data.tone).toBe('轻松');
    expect(data.commitments).toEqual([]); // 领地字段未被写入（schema default []）
    expect(res2.output).toContain('genre_contract_update');
  });

  it('updates 空对象 / 非 updates 键 → 友好 skip 不产零变更 patch（P16 mirror）', async () => {
    for (const params of [{ updates: {} }, { foo: 1 }, {}]) {
      const res = await creativeBriefUpdateHandler(ctx(params));
      expect(res.metadata).toBeUndefined();
      expect(res.output).toContain('已跳过');
    }
  });

  it('本次 updates 坏值（taboos 非数组 / structure_pattern 非法枚举）→ safeParse 拒 + 指认 this update', async () => {
    const res1 = await creativeBriefUpdateHandler(ctx({ updates: { taboos: 42 } }));
    expect(res1.metadata).toBeUndefined();
    expect(res1.output).toContain('被拒');
    expect(res1.output).toContain('本次更新');

    const res2 = await creativeBriefUpdateHandler(ctx({ updates: { structure_pattern: 'bogus-pattern' } }));
    expect(res2.metadata).toBeUndefined();
    expect(res2.output).toContain('被拒');
    expect(res2.output).toContain('本次更新');
  });

  it('盘上既有坏数据（genre_tags 坏形态）→ safeParse 拒 + 指认 on disk（须先手修项目设定文件）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      creative_brief: { rawRequirement: 'x', genre_tags: 'not-an-array' },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await creativeBriefUpdateHandler(ctx({ updates: { tone: '紧张' } }));
    warn.mockRestore();
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('请先修复项目设定文件');
  });

  it('creative_brief 字段整体非对象 → corrupt 拒（不向空基底 merge 覆盖真实不可读数据）', async () => {
    vi.mocked(loadProject).mockReturnValue({ ...ABSENT_DOC, creative_brief: 'garbage' } as any);
    const res = await creativeBriefUpdateHandler(ctx({ updates: { tone: '紧张' } }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('形态坏');
  });

  it('loadProject 返 null（整文档 corrupt/missing）→ 拒', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await creativeBriefUpdateHandler(ctx({ updates: { tone: '紧张' } }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('无法读取');
  });

  it('suggest 档不落盘——onFieldEdited 零调用 + 输出说人话（呈给作者采纳句式）', async () => {
    const res = await creativeBriefUpdateHandler(ctx({ updates: { tone: '热血' } }));
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.output).toContain('由作者决定是否采纳');
  });
});

// ── autoApply 双档（mirror assetCardsHandlers WP-D）──
describe('creativeBriefUpdateHandler autoApply 双档', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue({ ...ABSENT_DOC, creative_brief: EXISTING_BRIEF } as any);
    vi.mocked(onFieldEdited).mockReset();
  });

  it('autoApply=true → onFieldEdited(source=agent) 落盘 merged 全量 → 返 applied metadata + 字段摘要', async () => {
    const res = await creativeBriefUpdateHandler(ctxParams({
      autoApply: true,
      updates: { rawRequirement: '记忆商人新灵感', genre: '都市异能' },
    }));

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('creative_brief');
    expect(options).toEqual({ source: 'agent', reason: '创作简报更新（auto 档）' });
    // 落盘的是 merged 全量（updates 覆盖 + 既有保留）。
    expect(data).toMatchObject({
      rawRequirement: '记忆商人新灵感',
      genre: '都市异能',
      tone: '冷峻',
    });

    // applied metadata（非 field_patch envelope）。
    expect(res.metadata?.type).toBeUndefined();
    expect(res.metadata).toMatchObject({ ok: true, applied: true });
    expect(res.output).toContain('已直接生效');
    expect(res.output).toContain('rawRequirement');
  });

  it('locked field 拒（onFieldEdited throw）→ 降级 field_patch envelope + 说明（提议不丢，人审）', async () => {
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field creative_brief is locked and cannot be edited');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await creativeBriefUpdateHandler(ctxParams({
      autoApply: true,
      updates: { tone: '热血' },
    }));
    warn.mockRestore();

    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('creative_brief');
    expect(res.metadata?.action).toBe('set');
    expect((res.metadata?.data as Record<string, unknown>).tone).toBe('热血');
    // 降级说明：拒因 + 不丢提议 + 呈作者裁决（说人话）。
    expect(res.output).toContain('自动生效被拒');
    expect(res.output).toContain('没有丢失');
    expect(res.output).toContain('由作者决定是否采纳');
  });

  it('autoApply=true + 计算失败（loadProject null）→ 拒绝消息原样返回，不落盘不降级 envelope', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await creativeBriefUpdateHandler(ctxParams({ autoApply: true, updates: { tone: 'x' } }));
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('无法读取');
  });

  it('显式 autoApply=false → envelope 路径不变 + 不落盘（backward compat 显式档）', async () => {
    const res = await creativeBriefUpdateHandler(ctxParams({ autoApply: false, updates: { tone: '热血' } }));
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('creative_brief');
  });
});
