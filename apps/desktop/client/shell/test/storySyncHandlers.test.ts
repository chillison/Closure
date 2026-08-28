/**
 * storySyncApplyHandler shell tests (Story 2.2 WP-E, design §5.5.2).
 *
 * Mirror assetCardsHandlers.test.ts: mock local-bff (loadProject + onFieldEdited,
 * both imported dynamically inside the handler), drive the trust-boundary gates,
 * the projection matrix (asset_cards update/add translation, object-field merge
 * + per-field schema belt, array-target refusal, stale-version drop) and the
 * dual landing (suggest envelopes / autoApply onFieldEdited(source:'agent')).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(),
  onFieldEdited: vi.fn(),
}));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import {
  storySyncApplyHandler,
  STORY_SYNC_PATCH_CAP,
} from '../main/ipc/toolHandlers/storySyncHandlers';

const mockedLoadProject = vi.mocked(loadProject);
const mockedOnFieldEdited = vi.mocked(onFieldEdited);

const ctx = (params: Record<string, unknown>) => ({
  params,
  projectDir: '/proj',
  sessionId: 's1',
  abort: new AbortController().signal,
});

/** 底座 doc：world_setting 对象 + asset_cards 单卡 + emotion_curve + field_metadata 版本。 */
const BASE_DOC: Record<string, unknown> = {
  meta: { name: 'P' },
  storyboard: { shots: [] },
  world_setting: { premise: '灵气复苏' },
  asset_cards: [
    { id: 'char-1', type: 'character', name: '林动', summary: '主角' },
  ],
  emotion_curve: { unit: 'scene', points: [] },
  episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
  field_metadata: {
    world_setting: { version: 4, source: 'user', locked: false, dependsOn: [], stale: false },
    asset_cards: { version: 2, source: 'user', locked: false, dependsOn: [], stale: false },
  },
};

function patch(field: string, data: unknown, fieldVersion = 4) {
  return { field, action: 'merge' as const, data, fieldVersion, generatedBy: 'story-sync-agent' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadProject.mockReturnValue(structuredClone(BASE_DOC) as never);
  mockedOnFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] } as never);
});

describe('storySyncApplyHandler 机械门（gate）', () => {
  it('promise_registry patch 永拒（CR-E7 belt——读者债归 promise-emergence-node）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('promise_registry', { promises: [] }, 0)],
    }));
    const meta = res.metadata as { patches?: unknown[]; skipped?: Array<{ field: string }> };
    expect(meta.patches).toHaveLength(0);
    expect(meta.skipped?.[0].field).toBe('promise_registry');
  });

  it('overview / action 非 merge / data 数组 → gate 各自被拒（非 creative field 在 schema 面整体拒）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('overview', { name: 'x' }, 0), // schema 合法（patchFieldSchema 含 overview）→ gate 拒
        { ...patch('world_setting', { premise: 'y' }), action: 'set' },
        patch('world_setting', ['array data'], 4),
      ],
    }));
    const meta = res.metadata as { skipped?: Array<{ field: string; reason: string }> };
    expect(meta.skipped).toHaveLength(3);
  });

  it('未知 field 名（NOT_A_FIELD）→ 请求在 schema 面整体拒（trust-boundary 双层防御）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('NOT_A_FIELD', {}, 0)],
    }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('请求格式无效');
  });

  it(`suggest 档超 cap（>${STORY_SYNC_PATCH_CAP} 条）→ 全量 staging（CR-08-16-103：人审即 cap，不截断不丢弃）`, async () => {
    const patches = Array.from({ length: STORY_SYNC_PATCH_CAP + 3 }, () =>
      patch('world_setting', { premise: 'p' }, 4),
    );
    const res = await storySyncApplyHandler(ctx({ runId: 'run_1', patches }));
    const meta = res.metadata as { patches?: unknown[]; skipped?: unknown[] };
    // 同 field 聚合（CR-08-16-004）→ 11 条同 field 补丁 = 1 张全量 envelope，零丢弃。
    expect(meta.patches).toHaveLength(1);
    expect(meta.skipped).toHaveLength(0);
  });

  it(`autoApply 超 cap（>${STORY_SYNC_PATCH_CAP} 条）→ 直落截到 ${STORY_SYNC_PATCH_CAP} 条 + truthful 跳过（不谎称转人审）`, async () => {
    const patches = Array.from({ length: STORY_SYNC_PATCH_CAP + 3 }, (_, i) =>
      patch('world_setting', { [`key_${i}`]: 'v' }, 4),
    );
    const res = await storySyncApplyHandler(ctx({ runId: 'run_1', patches, autoApply: true }));
    expect(mockedOnFieldEdited).toHaveBeenCalledTimes(1); // 同 field 聚合 → 1 envelope 直落
    const meta = res.metadata as { applied?: boolean; skipped?: Array<{ field: string; reason: string }> };
    expect(meta.applied).toBe(true);
    const capSkips = meta.skipped!.filter((s) => s.reason.includes('未自动落盘'));
    expect(capSkips).toHaveLength(3);
    // CR-08-16-103：旧 reason「超限部分转人审」与事实相反（是 drop 非 review）——现为真话。
    expect(meta.skipped!.every((s) => !s.reason.includes('转人审'))).toBe(true);
  });
});

describe('storySyncApplyHandler 投影（suggest 档 envelope）', () => {
  it('world_setting merge → envelope 携 FULL 合并数据 + fieldVersion=当前+1', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('world_setting', { premise: '灵气复苏（修订）', newRule: '禁飞' })],
      chapterNote: '第 7 章 story-sync 提取',
    }));
    expect(res.metadata).toBeDefined();
    const envelopes = (res.metadata as { patches: Array<{ type: string; field: string; action: string; data: Record<string, unknown>; fieldVersion: number; note?: string }> }).patches;
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].type).toBe('field_patch');
    expect(envelopes[0].action).toBe('set'); // FULL replacement（accept 经 syncField REPLACE，fragment 会毁数据）
    expect(envelopes[0].data).toEqual({ premise: '灵气复苏（修订）', newRule: '禁飞' }); // merge 语义：既有 key 被覆写
    expect(envelopes[0].fieldVersion).toBe(5); // disk 4 + 1
    expect(envelopes[0].note).toBe('第 7 章 story-sync 提取');
  });

  it('同 field 多补丁 → 聚合为单张 envelope（CR-08-16-004：中间快照不重复出卡，末张携累积全量）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('world_setting', { premise: '新前提' }, 4),
        patch('world_setting', { theme: '新主题' }, 4),
        patch('asset_cards', { id: 'char-1', summary: '主角（觉醒）' }, 2),
      ],
    }));
    const envelopes = (res.metadata as { patches: Array<{ field: string; data: Record<string, unknown> }> }).patches;
    // 两 field 各一张（旧形态 world_setting 出两张中间快照卡）。
    expect(envelopes).toHaveLength(2);
    const ws = envelopes.find((e) => e.field === 'world_setting')!;
    expect(ws.data).toEqual({ premise: '新前提', theme: '新主题' }); // 累积合并
  });

  it('asset_cards 既有卡 → 转 update_card 浅合并（既有卡保留 + envelope 全量卡）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('asset_cards', { id: 'char-1', summary: '主角（觉醒）', details: { 阵营: '天机阁' } }, 2)],
    }));
    const envelopes = (res.metadata as { patches: Array<{ field: string; data: Array<Record<string, unknown>> }> }).patches;
    expect(envelopes).toHaveLength(1);
    const cards = envelopes[0].data;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 'char-1', type: 'character', name: '林动', summary: '主角（觉醒）', details: { 阵营: '天机阁' } });
  });

  it('asset_cards 未知 id → 转 add_card（新实体首次登记建卡，design §5.5.0）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('asset_cards', { id: 'org-9', type: 'organization', name: '天机阁' }, 2)],
    }));
    const envelopes = (res.metadata as { patches: Array<{ data: Array<Record<string, unknown>> }> }).patches;
    expect(envelopes[0].data).toHaveLength(2);
    expect(envelopes[0].data[1]).toMatchObject({ id: 'org-9', type: 'organization', name: '天机阁' });
  });

  it('asset_cards 新卡缺必填（schema 拒）→ 该条单独丢弃不影响其余补丁', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('asset_cards', { id: 'bad-1' }, 2), // add_card 缺 type/name → 投影后 schema 拒
        patch('world_setting', { premise: '灵气复苏' }, 4),
      ],
    }));
    const meta = res.metadata as { patches: Array<{ field: string }>; skipped: Array<{ field: string }> };
    expect(meta.patches.map((e) => e.field)).toEqual(['world_setting']); // 好条目保留
    expect(meta.skipped.some((s) => s.field === 'asset_cards')).toBe(true);
  });

  it('版本过期（提取时 v3，disk v4）→ 拒（mirror enforcePatchSafety 语义）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('world_setting', { premise: '旧稿补丁' }, 3)],
    }));
    const meta = res.metadata as { patches?: unknown[]; skipped: Array<{ reason: string }> };
    expect(meta.patches).toHaveLength(0);
    expect(meta.skipped[0].reason).toContain('版本过期');
  });

  it('数组目标字段（episode_outlines）+ 对象补丁 → 拒（doc merge 会 array→object 毁数据）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('episode_outlines', { id: 'ep2' }, 0)],
    }));
    const meta = res.metadata as { patches?: unknown[]; skipped: Array<{ reason: string }> };
    expect(meta.patches).toHaveLength(0);
    expect(meta.skipped[0].reason).toContain('per-entry');
  });

  it('merge 结果违反字段 schema（emotion_curve unit 非法）→ 拒', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('emotion_curve', { unit: 'bogus' }, 0)],
    }));
    const meta = res.metadata as { patches?: unknown[]; skipped: Array<{ reason: string }> };
    expect(meta.patches).toHaveLength(0);
    expect(meta.skipped[0].reason).toContain('schema');
  });

  it('loadProject 返 null（corrupt）→ 拒绝 staging 不产 envelope', async () => {
    mockedLoadProject.mockReturnValue(null as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('world_setting', { premise: 'x' }, 4)],
    }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('无法读取');
  });

  // ── CR-006（8.5 BMad CR）：outline 旧草稿键经 zod strip 静默蒸发 → 可见拒 + 指引新键名。──
  it('outline patch 携旧草稿键（growth_curve 草稿文本）→ 整条跳过 + reason 指引改名（非静默 strip）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('outline', { central_conflict: '合法字段照发', growth_curve: '林昭：从逃避到直面（旧草稿键）' }, 0),
      ],
    }));
    const meta = res.metadata as { patches?: unknown[]; skipped: Array<{ field: string; reason: string }> };
    // 整条跳过（不半应用——合法字段与坏键一起拒，LLM 改键名重发）。
    expect(meta.patches).toHaveLength(0);
    const skip = meta.skipped.find((s) => s.field === 'outline');
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain('growth_curve');
    expect(skip!.reason).toContain('arc_design_notes');
    expect(skip!.reason).toContain('整条跳过');
  });

  it('outline patch 全 schema 内字段 → 照常 merge（strip 检测不误伤合法补丁）', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('outline', { central_conflict: '旧秩序与新生代的对抗' }, 0)],
    }));
    const meta = res.metadata as { patches: Array<{ field: string }>; skipped: unknown[] };
    expect(meta.patches.map((e) => e.field)).toEqual(['outline']);
    expect(meta.skipped).toHaveLength(0);
  });
});

describe('storySyncApplyHandler growth_curve by-character_id upsert（Story 8.5 D2 array canonical）', () => {
  /** array canonical current：char-lin 完整弧（含 defaults 已填字段）。 */
  const CURVE_LIN = {
    character_id: 'char-lin',
    start_state: '山村少年，隐忍求存',
    wound_or_lack: '被灭门之痛',
    desire: '查清真相复仇',
    turning_points: [{ turning_point: '发现父亲遗信', linked_episode_ids: ['ep3'] }],
    regressions: [],
    linked_episode_ids: [],
  };
  const docWithCurves = (growthCurve: unknown): Record<string, unknown> => ({
    ...structuredClone(BASE_DOC),
    growth_curve: growthCurve,
  });

  it('完整曲线 patch + 已有角色 → partial merge（未提供字段保留 B1）+ envelope 全量 array', async () => {
    mockedLoadProject.mockReturnValue(docWithCurves([CURVE_LIN]) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      // 只提供 desire 变化（wound/start_state 未提供）——partial merge 不填 defaults 覆盖真实字段。
      patches: [patch('growth_curve', { character_id: 'char-lin', start_state: '山村少年，隐忍求存', desire: '复仇后放下（正文印证）' }, 0)],
    }));
    const envelopes = (res.metadata as { patches: Array<{ field: string; action: string; data: Array<Record<string, unknown>>; fieldVersion: number }> }).patches;
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].field).toBe('growth_curve');
    expect(envelopes[0].action).toBe('set');
    expect(envelopes[0].fieldVersion).toBe(1); // 无 field_metadata 记录 → 0+1
    const curves = envelopes[0].data;
    expect(curves).toHaveLength(1);
    // 已有字段保留（B1：partial merge 不覆盖）。
    expect(curves[0]).toMatchObject({
      character_id: 'char-lin',
      wound_or_lack: '被灭门之痛',
      desire: '复仇后放下（正文印证）',
    });
    expect(curves[0].turning_points).toEqual([{ turning_point: '发现父亲遗信', linked_episode_ids: ['ep3'] }]);
  });

  it('完整曲线 patch + 新角色 → 追加（parse 填 defaults），既有角色不动', async () => {
    mockedLoadProject.mockReturnValue(docWithCurves([CURVE_LIN]) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('growth_curve', { character_id: 'char-zhao', start_state: '庙祝之女，外冷内热', desire: '离家看世界' }, 0)],
    }));
    const envelopes = (res.metadata as { patches: Array<{ data: Array<Record<string, unknown>> }> }).patches;
    const curves = envelopes[0].data;
    expect(curves).toHaveLength(2);
    expect(curves.map((c) => c.character_id).sort()).toEqual(['char-lin', 'char-zhao']);
    // 新角色 defaults 填充。
    expect(curves.find((c) => c.character_id === 'char-zhao')).toMatchObject({
      start_state: '庙祝之女，外冷内热',
      desire: '离家看世界',
      turning_points: [],
    });
    // 既有角色原样保留。
    expect(curves.find((c) => c.character_id === 'char-lin')).toMatchObject({ desire: '查清真相复仇' });
  });

  it('旧形态 current（Record 持久化）+ patch → 归一不丢旧数据 + by-character_id upsert（新旧行混合）', async () => {
    // 8.5 前宽容容忍的 Record 形态 doc（手编 yaml / 旧版本持久化）——current 侧三形态归一。
    mockedLoadProject.mockReturnValue(docWithCurves({
      'char-lin': CURVE_LIN,
      'char-song': { start_state: '落魄书生' }, // 无 character_id → key 补
    }) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('growth_curve', { character_id: 'char-new', start_state: '新角色起点' }, 0)],
    }));
    const envelopes = (res.metadata as { patches: Array<{ data: Array<Record<string, unknown>> }> }).patches;
    const curves = envelopes[0].data;
    // 旧数据（Record 两形态）全保留 + 新角色 upsert。
    expect(curves.map((c) => c.character_id).sort()).toEqual(['char-lin', 'char-new', 'char-song']);
    expect(curves.find((c) => c.character_id === 'char-song')).toMatchObject({ start_state: '落魄书生' });
    expect(curves.find((c) => c.character_id === 'char-new')).toMatchObject({ start_state: '新角色起点' });
  });

  it('fragment patch（character_id 已有弧、缺 start_state）→ update 语义合并到既有弧', async () => {
    // 旧 doc-level merge 对 fragment 的容忍保留：只带 character_id + 变更字段的补丁可合并。
    mockedLoadProject.mockReturnValue(docWithCurves([CURVE_LIN]) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('growth_curve', { character_id: 'char-lin', desire: '正文印证后的新渴望' }, 0)],
    }));
    const envelopes = (res.metadata as { patches: Array<{ data: Array<Record<string, unknown>> }> }).patches;
    expect(envelopes).toHaveLength(1);
    const curve = envelopes[0].data[0];
    // fragment 字段覆盖 + 其余既有字段保留（start_state 来自既有弧）。
    expect(curve).toMatchObject({
      character_id: 'char-lin',
      start_state: '山村少年，隐忍求存',
      desire: '正文印证后的新渴望',
      wound_or_lack: '被灭门之痛',
    });
  });

  it('坏 patch（无 character_id 非法形态）→ 该条拒 + truthful reason，不影响其余补丁', async () => {
    mockedLoadProject.mockReturnValue(docWithCurves([CURVE_LIN]) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('growth_curve', { desire: '无身份键的孤儿 fragment' }, 0), // 无 character_id + 非 Record 可归一
        patch('world_setting', { premise: '灵气复苏' }, 4),
      ],
    }));
    const meta = res.metadata as { patches: Array<{ field: string }>; skipped: Array<{ field: string; reason: string }> };
    expect(meta.patches.map((e) => e.field)).toEqual(['world_setting']); // 好条目保留
    // CR-Edge-F8：非对象值逐条 reason + 末尾「可合并形态」总结 reason（多条 growth_curve skip 共存）。
    expect(meta.skipped.some((s) => s.field === 'growth_curve' && s.reason.includes('可合并形态'))).toBe(true);
    expect(meta.skipped.some((s) => s.field === 'growth_curve' && s.reason.includes('Record 键 desire'))).toBe(true);
  });

  // ── CR-Blind-F4（8.5 CR）：canonical array patch 形态放行（gate 对 growth_curve 开 array 口）+ 逐条 upsert。──
  it('canonical array patch → 逐条 by-character_id upsert（既有角色 partial merge + 新角色追加）', async () => {
    mockedLoadProject.mockReturnValue(docWithCurves([CURVE_LIN]) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        // canonical array（8.5 存储契约 canonical 写形态）：fragment（已有角色）+ 完整新角色混合。
        patch('growth_curve', [
          { character_id: 'char-lin', desire: '正文印证后的新渴望' },
          { character_id: 'char-zhao', start_state: '庙祝之女，外冷内热', desire: '离家看世界' },
        ], 0),
      ],
    }));
    const envelopes = (res.metadata as { patches: Array<{ field: string; data: Array<Record<string, unknown>> }> }).patches;
    expect(envelopes).toHaveLength(1);
    const curves = envelopes[0].data;
    expect(curves).toHaveLength(2);
    // 既有角色 partial merge（start_state/wound 保留，desire 覆盖）。
    expect(curves.find((c) => c.character_id === 'char-lin')).toMatchObject({
      start_state: '山村少年，隐忍求存',
      desire: '正文印证后的新渴望',
    });
    // 新角色完整条目追加。
    expect(curves.find((c) => c.character_id === 'char-zhao')).toMatchObject({
      start_state: '庙祝之女，外冷内热',
      desire: '离家看世界',
    });
  });

  it('array patch 混坏条目 → 好条目落 + 坏条目逐条 skip reason（drop-bad-keep-good）', async () => {
    mockedLoadProject.mockReturnValue(docWithCurves([CURVE_LIN]) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('growth_curve', [
          { character_id: 'char-zhao', start_state: '新角色起点' },
          'not-an-object',
          { desire: '缺身份键条目' },
        ], 0),
      ],
    }));
    const meta = res.metadata as { patches: Array<{ field: string; data: Array<Record<string, unknown>> }>; skipped: Array<{ field: string; reason: string }> };
    const curves = meta.patches[0].data;
    expect(curves.map((c) => c.character_id).sort()).toEqual(['char-lin', 'char-zhao']); // 好条目落
    expect(meta.skipped.some((s) => s.reason.includes('第 2 项非对象'))).toBe(true);
    expect(meta.skipped.some((s) => s.reason.includes('第 3 项缺 character_id'))).toBe(true);
  });

  // ── CR-Edge-F8（8.5 CR）：Record 提取非对象值逐条 skip reason（不再静默 continue）。──
  it('Record patch 混好坏值 → 好条目落 + 坏条目逐条 reason（键名可见）', async () => {
    mockedLoadProject.mockReturnValue(docWithCurves([CURVE_LIN]) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('growth_curve', {
          'char-song': { start_state: '落魄书生' }, // key 补缺 character_id（好条目）
          bad: 'not-an-object', // 坏值
        }, 0),
      ],
    }));
    const meta = res.metadata as { patches: Array<{ field: string; data: Array<Record<string, unknown>> }>; skipped: Array<{ field: string; reason: string }> };
    const curves = meta.patches[0].data;
    // 好条目（key 补缺）落 + 既有不动。
    expect(curves.map((c) => c.character_id).sort()).toEqual(['char-lin', 'char-song']);
    expect(curves.find((c) => c.character_id === 'char-song')).toMatchObject({ start_state: '落魄书生' });
    // 坏条目逐条 reason（非静默）。
    expect(meta.skipped.some((s) => s.field === 'growth_curve' && s.reason.includes('Record 键 bad') && s.reason.includes('非对象'))).toBe(true);
  });

  it('current 形态坏（标量）→ 拒合并防覆盖（truthful reason）', async () => {
    mockedLoadProject.mockReturnValue(docWithCurves('不是曲线数据') as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('growth_curve', { character_id: 'char-lin', start_state: 'x' }, 0)],
    }));
    const meta = res.metadata as { patches?: unknown[]; skipped: Array<{ field: string; reason: string }> };
    expect(meta.patches).toHaveLength(0);
    expect(meta.skipped[0].reason).toContain('拒绝');
  });

  // ── CR-003（8.5 BMad CR）：同批同角色双条目批内聚合——第二条不再回落磁盘旧值覆盖第一条显式字段。──
  it('同 character_id 双条目（[{A,desire:X},{A,need:Y}]）→ 批内聚合两字段都存活（与工具路径 add_curve partial-merge 一致）', async () => {
    mockedLoadProject.mockReturnValue(docWithCurves([CURVE_LIN]) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('growth_curve', [
          { character_id: 'char-lin', desire: '正文印证的第一条欲望' },
          { character_id: 'char-lin', need: '正文印证的第二条需要' },
        ], 0),
      ],
    }));
    const meta = res.metadata as { patches: Array<{ data: Array<Record<string, unknown>> }> };
    const curves = meta.patches[0].data;
    expect(curves).toHaveLength(1);
    // 聚合后单条 add_curve：两 entry 的显式字段都存活（旧行为=第二条以磁盘旧值为基重建，desire 丢）。
    expect(curves[0]).toMatchObject({
      character_id: 'char-lin',
      desire: '正文印证的第一条欲望',
      need: '正文印证的第二条需要',
      // 既有字段照常保留（聚合基底 = 磁盘完整弧 + 批内显式键）。
      wound_or_lack: '被灭门之痛',
      start_state: '山村少年，隐忍求存',
    });
  });

  it('同 character_id 双条目后条覆盖同键（显式键后者胜）——批内聚合语义锁定', async () => {
    mockedLoadProject.mockReturnValue(docWithCurves([CURVE_LIN]) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('growth_curve', [
          { character_id: 'char-lin', desire: '第一条（被覆盖）' },
          { character_id: 'char-lin', desire: '第二条（胜出）' },
        ], 0),
      ],
    }));
    const meta = res.metadata as { patches: Array<{ data: Array<Record<string, unknown>> }> };
    expect(meta.patches[0].data[0]).toMatchObject({ desire: '第二条（胜出）' });
  });
});

describe('storySyncApplyHandler autoApply 直落', () => {
  it('autoApply=true → onFieldEdited(source=agent, reason=章节出处) 逐 field 落盘', async () => {
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [patch('world_setting', { premise: '灵气复苏（修订）' })],
      autoApply: true,
      chapterNote: '第 7 章 story-sync 提取',
    }));
    const meta = res.metadata as { applied?: boolean; appliedFields?: string[] };
    expect(meta.applied).toBe(true);
    expect(meta.appliedFields).toEqual(['world_setting']);
    expect(mockedOnFieldEdited).toHaveBeenCalledTimes(1);
    const [projectDir, field, data, options] = mockedOnFieldEdited.mock.calls[0];
    expect(projectDir).toBe('/proj');
    expect(field).toBe('world_setting');
    expect((data as Record<string, unknown>).premise).toBe('灵气复苏（修订）');
    expect(options).toMatchObject({ source: 'agent', reason: '第 7 章 story-sync 提取' });
    expect(res.output).toContain('已写入项目设定');
  });

  it('locked field 抛（onFieldEdited 同步 throw）→ 该 field graceful 拒，其余照落', async () => {
    // onFieldEdited 是同步函数（locked → 同步 throw），mock 须同步抛非 Promise.reject。
    mockedOnFieldEdited.mockImplementation(((_p: string, field: string) => {
      if (field === 'world_setting') throw new Error('Field world_setting is locked and cannot be edited');
      return { syncEvent: {}, staleFields: [] };
    }) as never);
    const res = await storySyncApplyHandler(ctx({
      runId: 'run_1',
      patches: [
        patch('world_setting', { premise: 'x' }, 4),
        patch('asset_cards', { id: 'char-1', summary: '更新' }, 2),
      ],
      autoApply: true,
    }));
    const meta = res.metadata as { applied?: boolean; appliedFields?: string[]; skipped?: Array<{ field: string }> };
    expect(meta.appliedFields).toEqual(['asset_cards']); // 未被 locked 拒的照落
    expect(meta.skipped?.some((s) => s.field === 'world_setting')).toBe(true);
  });
});
