/**
 * Story 2.5 genre_contract_update shell handler tests (mirror infoReleaseHandlers.test.ts).
 *
 * Locks：creative-field write pattern（GenreContract 三字段 → field_patch envelope）+ corrupt refuse +
 * rawRequirement 保底 + worldConstitutionPatch sub-field piggyback + **BMad CR-003 all-garbage 不 stage**
 * （coerceStringArray/coerceCommitments 区分「显式 [] = clear」vs「全垃圾 = 不 stage」防误清空既有字段）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, creative_brief: { rawRequirement: '写仙侠' }, world_setting: { premise: '修真界' } })),
}));

import { loadProject } from '@orison/desktop-local-bff';
import { genreContractUpdateHandler } from '../main/ipc/toolHandlers/genreContractHandlers';

const ctx = (params: Record<string, unknown>, projectDir = '/proj') => ({
  params,
  projectDir,
  sessionId: 's1',
  abort: new AbortController().signal,
});

const BASE_DOC = {
  meta: { name: 'P' },
  creative_brief: { rawRequirement: '写一部仙侠', genre_tags: ['仙侠', '都市'], commitments: [{ type: 'HE', content: '大团圆' }] },
  world_setting: { premise: '修真界', world_constitution: ['无现代科技'] },
};

describe('genreContractUpdateHandler (Story 2.5)', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(BASE_DOC as any);
  });

  it('合法 genre_tags + commitments + world_constitution → 产 creative_brief field_patch + worldConstitutionPatch sub-field', async () => {
    const res = await genreContractUpdateHandler(ctx({
      genre_tags: ['仙侠', '爽文'],
      commitments: [{ type: 'HE', content: '主角终成大道' }],
      world_constitution: ['死者不能复生'],
    }));
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('creative_brief');
    const data = res.metadata?.data as any;
    expect(data.genre_tags).toEqual(['仙侠', '爽文']);
    expect(data.commitments).toEqual([{ type: 'HE', content: '主角终成大道' }]);
    // rawRequirement 保底（required 字段，保留既有）。
    expect(data.rawRequirement).toBe('写一部仙侠');
    // world_constitution ride as sub-field。
    expect(res.metadata?.worldConstitutionPatch).toBeDefined();
    expect((res.metadata?.worldConstitutionPatch as any).field).toBe('world_setting');
    expect((res.metadata?.worldConstitutionPatch as any).data.world_constitution).toEqual(['死者不能复生']);
    // world_setting 既有 premise 保留（spread merge）。
    expect((res.metadata?.worldConstitutionPatch as any).data.premise).toBe('修真界');
  });

  it('BMad CR-003：genre_tags 全垃圾（非字符串/空串）→ coerceStringArray 返 undefined → 不 stage（不误清空既有标签）', async () => {
    const res = await genreContractUpdateHandler(ctx({ genre_tags: ['', 42, null] }));
    // 全垃圾 = undefined → hasCreativeBriefFields=false → no-op（既有 ['仙侠','都市'] 不被清空）。
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('没有可更新的内容');
  });

  it('BMad CR-003：commitments 全垃圾（缺 content / 非对象）→ 不 stage（不误清空既有 commitments）', async () => {
    const res = await genreContractUpdateHandler(ctx({ commitments: [{ type: 'HE', content: '' }, 'not-an-object'] }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('没有可更新的内容');
  });

  it('BMad CR-003：显式空数组 genre_tags:[] → coerceStringArray 返 [] → stage 清空（intentional clear）', async () => {
    const res = await genreContractUpdateHandler(ctx({ genre_tags: [] }));
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('creative_brief');
    expect((res.metadata?.data as any).genre_tags).toEqual([]);
  });

  it('仅 world_constitution → 主 envelope = world_setting（无 creative_brief field_patch）', async () => {
    const res = await genreContractUpdateHandler(ctx({ world_constitution: ['绝无时间旅行'] }));
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('world_setting');
    expect((res.metadata?.data as any).world_constitution).toEqual(['绝无时间旅行']);
    expect(res.metadata?.worldConstitutionPatch).toBeUndefined();
  });

  it('corrupt project（loadProject 返 null）→ refuse to stage（trust-boundary defense）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await genreContractUpdateHandler(ctx({ genre_tags: ['仙侠'] }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
  });

  it('三字段全缺（no-op）→ 不 stage', async () => {
    const res = await genreContractUpdateHandler(ctx({}));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('没有可更新的内容');
  });
});
