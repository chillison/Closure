import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted so the mock factory (runs before imports) can reference the stubs.
const { loadProject, saveProject } = vi.hoisted(() => ({
  loadProject: vi.fn(),
  saveProject: vi.fn(),
}));

// Mock the handler's deps — loadProject / saveProject from local-bff + notifyUI.
// With them mocked, no real disk IO / yaml parse happens; the suite runs under plain vitest.
vi.mock('@orison/desktop-local-bff', () => ({ loadProject, saveProject }));

// notifyUI 需 mock 避免 BrowserWindow.getAllWindows() 在 test env 抛。
vi.mock('../main/ipc/toolNotify', () => ({ notifyUI: vi.fn() }));

import { dismissStaleFieldsHandler } from '../main/ipc/toolHandlers/projectHandlers';
import { creativeFieldKeys, type CreativeFieldKey } from '@orison/shared-contracts';

function ctx(fields: CreativeFieldKey[], projectDir = '/proj/alpha') {
  return {
    params: { fields },
    projectDir,
    sessionId: 's1',
    abort: new AbortController().signal,
  };
}

/** Build a field_metadata stub where the given fields are stale=true + version/source/locked defaults. */
function metaWithStale(stale: CreativeFieldKey[], locked: CreativeFieldKey[] = []): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const key of creativeFieldKeys) {
    meta[key] = {
      version: 1,
      source: 'user',
      locked: locked.includes(key),
      stale: stale.includes(key),
      dependsOn: [],
    };
  }
  return meta;
}

describe('dismissStaleFieldsHandler (Story 3.4 Phase 4.2)', () => {
  beforeEach(() => {
    loadProject.mockReset();
    saveProject.mockReset();
  });

  it('清除指定 stale 字段 → 写回 stale=false + 落盘 + 返 dismissed/remainingStale', async () => {
    loadProject.mockReturnValue({ field_metadata: metaWithStale(['scene_graph', 'asset_cards', 'emotion_curve']) });
    saveProject.mockImplementation(() => undefined);

    const res = await dismissStaleFieldsHandler(ctx(['scene_graph', 'asset_cards']));

    expect(res.metadata?.ok).toBe(true);
    expect(res.metadata?.dismissed).toEqual(['asset_cards', 'scene_graph']); // 按 enum 序
    expect(res.metadata?.remainingStale).toEqual(['emotion_curve']);
    expect(saveProject).toHaveBeenCalledOnce();
    // 落盘的 doc 含 stale=false for dismissed 字段。
    const saved = saveProject.mock.calls[0][1];
    expect(saved.field_metadata.scene_graph.stale).toBe(false);
    expect(saved.field_metadata.asset_cards.stale).toBe(false);
    expect(saved.field_metadata.emotion_curve.stale).toBe(true); // 未 dismiss 保持
  });

  it('locked 字段不被 dismiss → skipped + 文案告知', async () => {
    loadProject.mockReturnValue({
      field_metadata: metaWithStale(['scene_graph', 'outline'], ['outline']), // outline locked
    });
    saveProject.mockImplementation(() => undefined);

    const res = await dismissStaleFieldsHandler(ctx(['scene_graph', 'outline']));

    expect(res.metadata?.ok).toBe(true);
    expect(res.metadata?.dismissed).toEqual(['scene_graph']);
    expect(res.metadata?.skipped).toEqual(['outline']);
    expect(saveProject).toHaveBeenCalledOnce();
    expect(res.output).toContain('锁定');
    expect(res.output).toContain('outline');
  });

  it('dismiss 非 stale 字段（幂等）→ dismissed 空 + 文案「均非 stale」+ 不落盘（BMad CR Fix 4）', async () => {
    // scene_graph 非 stale（stale=false），asset_cards stale=true。
    const meta = metaWithStale(['asset_cards']);
    (meta.scene_graph as Record<string, unknown>).stale = false;
    loadProject.mockReturnValue({ field_metadata: meta });
    saveProject.mockImplementation(() => undefined);

    const res = await dismissStaleFieldsHandler(ctx(['scene_graph']));

    expect(res.metadata?.ok).toBe(true);
    expect(res.metadata?.dismissed).toEqual([]);
    expect(res.metadata?.remainingStale).toEqual(['asset_cards']);
    expect(res.output).toContain('均非 stale');
    // BMad CR Fix 4（MINOR4）：dismissedActual 空 → doc 未变 → 不落盘（消伪造 metadata + 无意义 version bump）。
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('清完所有 stale → 「所有字段均为最新」文案', async () => {
    loadProject.mockReturnValue({ field_metadata: metaWithStale(['scene_graph']) });
    saveProject.mockImplementation(() => undefined);

    const res = await dismissStaleFieldsHandler(ctx(['scene_graph']));

    expect(res.metadata?.remainingStale).toEqual([]);
    expect(res.output).toContain('所有字段均为最新');
  });

  // BMad CR Fix 4（E2 自相矛盾文案）：dismissedActual 空 + lockedSkipped 非空 → 文案说「全被锁定」
  // 而非旧「均非 stale」（消两文案自相矛盾：既说均非 stale 又说被锁定）。
  it('入参字段全被锁定 → dismissed 空 + 文案「全被锁定」+ 不落盘', async () => {
    loadProject.mockReturnValue({
      // scene_graph + outline 均 stale + 均 locked → dismissible 空 → dismissedActual 空
      field_metadata: metaWithStale(['scene_graph', 'outline'], ['scene_graph', 'outline']),
    });
    saveProject.mockImplementation(() => undefined);

    const res = await dismissStaleFieldsHandler(ctx(['scene_graph', 'outline']));

    expect(res.metadata?.ok).toBe(true);
    expect(res.metadata?.dismissed).toEqual([]);
    expect(res.metadata?.skipped).toEqual(['scene_graph', 'outline']); // 输入序（lockedSkipped 按 parsedFields 输入序 push）
    // 文案说「全被作者锁定」，不说「均非 stale」（消自相矛盾）。
    expect(res.output).toContain('全被作者锁定');
    expect(res.output).not.toContain('均非 stale');
    // dismissedActual 空 → 不落盘。
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('入参 fields 空/非数组 → ok=false 不调 saveProject', async () => {
    const res1 = await dismissStaleFieldsHandler({
      params: { fields: [] },
      projectDir: '/p',
      sessionId: 's1',
      abort: new AbortController().signal,
    });
    expect(res1.metadata?.ok).toBe(false);
    expect(res1.metadata?.reason).toBe('invalid_fields_param');

    const res2 = await dismissStaleFieldsHandler({
      params: { fields: 'scene_graph' }, // 非数组
      projectDir: '/p',
      sessionId: 's1',
      abort: new AbortController().signal,
    });
    expect(res2.metadata?.ok).toBe(false);
    expect(res2.metadata?.reason).toBe('invalid_fields_param');

    expect(saveProject).not.toHaveBeenCalled();
  });

  it('入参 fields 全畸形（非 CreativeFieldKey）→ ok=false 不调 saveProject', async () => {
    const res = await dismissStaleFieldsHandler({
      params: { fields: ['nonexistent_field', '', 123] },
      projectDir: '/p',
      sessionId: 's1',
      abort: new AbortController().signal,
    });
    expect(res.metadata?.ok).toBe(false);
    expect(res.metadata?.reason).toBe('invalid_fields_param');
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('入参含部分畸形 → 仅合法部分 dismiss（畸形静默过滤）', async () => {
    loadProject.mockReturnValue({ field_metadata: metaWithStale(['scene_graph']) });
    saveProject.mockImplementation(() => undefined);

    // 'invalid_field' 畸形被过滤；'scene_graph' 合法 dismiss。
    const res = await dismissStaleFieldsHandler(ctx(['invalid_field', 'scene_graph'] as CreativeFieldKey[]));

    expect(res.metadata?.ok).toBe(true);
    expect(res.metadata?.dismissed).toEqual(['scene_graph']);
  });

  it('loadProject 返 null（project.yaml 缺/corrupt）→ ok=false friendly，非 throw', async () => {
    loadProject.mockReturnValue(null);

    const res = await dismissStaleFieldsHandler(ctx(['scene_graph']));

    expect(res.metadata?.ok).toBe(false);
    expect(res.metadata?.reason).toBe('project_missing');
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('loadProject 抛错 → ok=false friendly，非 throw（never-throws 契约）', async () => {
    loadProject.mockImplementation(() => {
      throw new Error('IO boom');
    });

    const res = await dismissStaleFieldsHandler(ctx(['scene_graph']));

    expect(res.metadata?.ok).toBe(false);
    expect(res.metadata?.reason).toBe('project_load_failed');
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('saveProject 抛错 → ok=false，dismiss 未生效（落盘失败）', async () => {
    loadProject.mockReturnValue({ field_metadata: metaWithStale(['scene_graph']) });
    saveProject.mockImplementation(() => {
      throw new Error('disk full');
    });

    const res = await dismissStaleFieldsHandler(ctx(['scene_graph']));

    expect(res.metadata?.ok).toBe(false);
    expect(res.metadata?.reason).toBe('save_failed');
    expect(res.metadata?.dismissed).toEqual([]);
    expect(res.output).toContain('落盘失败');
  });

  it('field_metadata 缺省（无 stale 字段）→ 视为「全最新」，dismiss 幂等无效果 + 不落盘（BMad CR Fix 4）', async () => {
    loadProject.mockReturnValue({}); // 无 field_metadata 键
    saveProject.mockImplementation(() => undefined);

    const res = await dismissStaleFieldsHandler(ctx(['scene_graph']));

    // BMad CR Fix 4：field_metadata 缺 → 无 stale → dismissedActual 空 → 不落盘（不建 field_metadata 默认条目）。
    expect(res.metadata?.ok).toBe(true);
    expect(res.metadata?.dismissed).toEqual([]);
    expect(res.metadata?.remainingStale).toEqual([]);
    expect(res.output).toContain('均非 stale');
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('dismiss 后 stale=true 字段数正确减少（剩余集反映落盘后状态）', async () => {
    // 初始 5 stale；dismiss 3 → 剩 2。
    loadProject.mockReturnValue({
      field_metadata: metaWithStale(['scene_graph', 'asset_cards', 'emotion_curve', 'outline', 'world_setting']),
    });
    saveProject.mockImplementation(() => undefined);

    const res = await dismissStaleFieldsHandler(
      ctx(['scene_graph', 'asset_cards', 'outline']),
    );

    // enum 序：outline(2) < asset_cards(7) < scene_graph(11)；world_setting(1) < emotion_curve(6)。
    expect(res.metadata?.dismissed).toEqual(['outline', 'asset_cards', 'scene_graph']);
    expect(res.metadata?.remainingStale).toEqual(['world_setting', 'emotion_curve']); // enum 序
  });
});
