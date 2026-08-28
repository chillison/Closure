import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted so the mock factory (runs before imports) can reference the stub.
const { loadProject } = vi.hoisted(() => ({
  loadProject: vi.fn(),
}));

// Mock the handler's only dep — loadProject from local-bff. With it mocked, no
// real disk IO / yaml parse happens; the suite runs under plain vitest.
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

import { listStaleFieldsHandler } from '../main/ipc/toolHandlers/projectHandlers';
import { creativeFieldKeys, type CreativeFieldKey } from '@orison/shared-contracts';

function ctx(projectDir = '/proj/alpha') {
  return {
    params: {},
    projectDir,
    sessionId: 's1',
    abort: new AbortController().signal,
  };
}

/** Build a field_metadata stub where the given fields are stale=true. */
function metaWithStale(stale: CreativeFieldKey[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const key of creativeFieldKeys) {
    meta[key] = { version: 1, source: 'user', locked: false, stale: stale.includes(key) };
  }
  return meta;
}

describe('listStaleFieldsHandler (Story 3.4 R1/C-A2)', () => {
  beforeEach(() => {
    loadProject.mockReset();
  });

  it('返回 field_metadata.stale===true 的 CreativeFieldKey[]（候选集，按 enum 序）', async () => {
    loadProject.mockReturnValue({ field_metadata: metaWithStale(['scene_graph', 'asset_cards']) });
    const res = await listStaleFieldsHandler(ctx());
    expect(res.metadata?.ok).toBe(true);
    // 输出按 creativeFieldKeys enum 序（asset_cards idx7 < scene_graph idx11），非输入序
    expect(res.metadata?.staleFields).toEqual(['asset_cards', 'scene_graph']);
    expect(typeof res.output).toBe('string');
    expect(res.output).toContain('scene_graph');
    expect(res.output).toContain('asset_cards');
  });

  it('无 stale 字段 → 空数组 + 「均为最新」文案', async () => {
    loadProject.mockReturnValue({ field_metadata: metaWithStale([]) });
    const res = await listStaleFieldsHandler(ctx());
    expect(res.metadata?.ok).toBe(true);
    expect(res.metadata?.staleFields).toEqual([]);
    expect(res.output).toContain('无 stale');
  });

  it('field_metadata 缺省 → 空候选（无 false positive）', async () => {
    loadProject.mockReturnValue({}); // 无 field_metadata 键
    const res = await listStaleFieldsHandler(ctx());
    expect(res.metadata?.ok).toBe(true);
    expect(res.metadata?.staleFields).toEqual([]);
  });

  it('stale 非布尔（如 undefined / null / 0）不命中（仅 stale===true）', async () => {
    // 只 world_setting 标 true；scene_graph 标 undefined（缺 stale 键）/ emotion_curve 标 false。
    const meta = metaWithStale(['world_setting']);
    (meta.scene_graph as Record<string, unknown>).stale = undefined;
    (meta.emotion_curve as Record<string, unknown>).stale = false;
    loadProject.mockReturnValue({ field_metadata: meta });
    const res = await listStaleFieldsHandler(ctx());
    expect(res.metadata?.staleFields).toEqual(['world_setting']);
  });

  it('loadProject 返 null（project.yaml 缺/corrupt）→ friendly，非 throw', async () => {
    loadProject.mockReturnValue(null);
    const res = await listStaleFieldsHandler(ctx());
    expect(res.metadata?.ok).toBe(false);
    expect(res.metadata?.reason).toBe('project_missing');
    expect(res.metadata?.staleFields).toEqual([]);
  });

  it('loadProject 抛错 → friendly，非 throw（never-throws 契约）', async () => {
    loadProject.mockImplementation(() => {
      throw new Error('IO boom');
    });
    const res = await listStaleFieldsHandler(ctx());
    expect(res.metadata?.ok).toBe(false);
    expect(res.metadata?.reason).toBe('project_load_failed');
    expect(res.metadata?.staleFields).toEqual([]);
  });

  it('候选顺序跟随 creativeFieldKeys（source-of-truth enum 序），非 yaml 写入序', async () => {
    // 故意按乱序传 stale，期望输出按 creativeFieldKeys 声明序。
    const reversed = [...creativeFieldKeys].reverse().slice(0, 4) as CreativeFieldKey[];
    loadProject.mockReturnValue({ field_metadata: metaWithStale(reversed) });
    const res = await listStaleFieldsHandler(ctx());
    const out = res.metadata?.staleFields as CreativeFieldKey[];
    // 输出应按 creativeFieldKeys 序（每个 key 的 index 递增）
    const indexes = out.map((k) => creativeFieldKeys.indexOf(k));
    for (let i = 1; i < indexes.length; i += 1) {
      expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
    }
  });
});
