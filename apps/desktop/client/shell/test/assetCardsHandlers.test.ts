/**
 * asset_cards_update shell handler tests (Story 3.6 WP9 / R5 + Story 2.2 WP-D).
 *
 * Mirror sceneGraphHandlers.test.ts: per-action trust-boundary parse, corrupt
 * vs absent read-base refusal, projection semantics (add duplicate friendly
 * reject / update shallow-merge preserving customFields / remove idempotent),
 * and the field_patch envelope shape (field:'asset_cards', action:'set',
 * data = full projected cards).
 *
 * Story 2.2 WP-D: the autoApply dual landing (mirror emotionCurveHandlers
 * DW-4) — auto gear persists via onFieldEdited(source:'agent'), a locked
 * field degrades to the human-review envelope (proposals never lost), and the
 * default gear keeps the 3.6 envelope path verbatim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadProject / onFieldEdited are imported dynamically inside the handler; mock
// at top level and control per-test via vi.mocked. Default loadProject = a valid
// project doc with NO asset_cards field (absent -> fresh [] is the correct base);
// default onFieldEdited = a successful agent landing (Story 2.2 WP-D autoApply).
vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import { assetCardsUpdateHandler } from '../main/ipc/toolHandlers/assetCardsHandlers';

const ctx = (actions: unknown) => ({
  params: { actions },
  projectDir: '/proj',
  sessionId: 's1',
  abort: new AbortController().signal,
});

/** Full-params variant（Story 2.2 WP-D autoApply 档测试用）. */
const ctxParams = (params: Record<string, unknown>) => ({
  params,
  projectDir: '/proj',
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

const character = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'character', name, ...extra,
});

describe('assetCardsUpdateHandler 投影矩阵 (Story 3.6 WP9)', () => {
  it('params null / undefined → 友好 skip 不 throw（CR-008 never-throws 头部归一守卫）', async () => {
    for (const badParams of [null, undefined]) {
      const res = await assetCardsUpdateHandler({
        params: badParams as any,
        projectDir: '/proj',
        sessionId: 's1',
        abort: new AbortController().signal,
      });
      expect(res.output).toContain('已跳过');
      expect(res.output).not.toContain('Error');
      expect(res.metadata).toBeUndefined();
    }
  });

  it('absent asset_cards（新项目）-> add 从空 [] 投影，产 field_patch envelope', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'add_card', card: character('c1', '阿米娅', { summary: '罗德岛领袖' }) },
    ]));
    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('asset_cards');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as unknown[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 'c1', type: 'character', name: '阿米娅' });
  });

  it('既有卡保留 + add 追加（投影到现 asset_cards 非替换）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      asset_cards: [character('old-1', '旧卡')],
    } as any);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'add_card', card: character('new-1', '新卡') },
    ]));
    const data = res.metadata?.data as Array<{ id: string }>;
    expect(data.map((c) => c.id)).toEqual(['old-1', 'new-1']);
  });

  it('add_card 重复 id -> 友好报错不产 envelope（不静默覆盖）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      asset_cards: [character('c1', '既有卡')],
    } as any);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'add_card', card: character('c1', '撞 id 卡') },
    ]));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('已存在');
    expect(res.output).toContain('update_card');
  });

  it('update_card 浅合并——未提供字段 + customFields(details) 保留', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      asset_cards: [character('c1', '阿米娅', { summary: '旧', details: { 风格: '法术' } })],
    } as any);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'update_card', cardId: 'c1', patch: { summary: '新' } },
    ]));
    const card = (res.metadata?.data as Array<Record<string, unknown>>)[0];
    expect(card.summary).toBe('新');
    expect(card.name).toBe('阿米娅');
    expect(card.details).toEqual({ 风格: '法术' });
  });

  it('update_card patch 含 id/type 身份键 -> schema 仍收（record），投影剥除不改身份', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      asset_cards: [character('c1', '阿米娅')],
    } as any);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'update_card', cardId: 'c1', patch: { id: 'evil', type: 'location', summary: 's' } },
    ]));
    const card = (res.metadata?.data as Array<Record<string, unknown>>)[0];
    expect(card.id).toBe('c1');
    expect(card.type).toBe('character');
    expect(card.summary).toBe('s');
  });

  it('update_card 不存在 cardId -> 幂等跳过（envelope 仍产，cards 不变）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      asset_cards: [character('c1', '阿米娅')],
    } as any);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'update_card', cardId: 'ghost', patch: { summary: 'x' } },
    ]));
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.data).toHaveLength(1);
  });

  it('remove_card：存在删 / 不存在幂等跳过', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      asset_cards: [character('c1', 'A'), character('c2', 'B')],
    } as any);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'remove_card', cardId: 'c1' },
      { op: 'remove_card', cardId: 'ghost' },
    ]));
    expect(res.metadata?.type).toBe('field_patch');
    expect((res.metadata?.data as Array<{ id: string }>).map((c) => c.id)).toEqual(['c2']);
  });

  it('非法 action shape -> 拒绝不产 envelope（trust-boundary）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'add_card', card: { id: 'c1', type: 'character' } }, // 缺 name
    ]));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('操作格式无效');
  });

  it('投影出非法卡（patch 合并出空 name）-> 拒绝（belt-and-suspenders re-validate）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      asset_cards: [character('c1', '阿米娅')],
    } as any);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'update_card', cardId: 'c1', patch: { name: '' } }, // min(1) 违反
    ]));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('校验失败');
  });
});

describe('assetCardsUpdateHandler corrupt vs absent (mirror sceneGraphHandlers)', () => {
  it('corrupt asset_cards（字段存在但 schema-invalid）-> 拒绝 + 不产 envelope', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      asset_cards: [{ id: 'c1', type: 'bogus', name: 'X' }], // 非法 type
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'add_card', card: character('c2', 'B') },
    ]));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('校验失败');
    warn.mockRestore();
  });

  it('loadProject 返 null（整文档 corrupt/missing）-> 拒绝（跨字段污染防护）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await assetCardsUpdateHandler(ctx([
      { op: 'add_card', card: character('c1', 'A') },
    ]));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('无法读取');
  });
});

// ── Story 2.2 WP-D（design §5.1）：autoApply 双档落盘（第 4 例 mirror emotionCurveHandlers DW-4）──
// auto 档（leader 仅 permissionMode 'auto' 传 true，KD1）→ withProjectLock 内 fresh 投影 +
// onFieldEdited(source:'agent') 直接落盘；locked field 拒 → 整体降级 field_patch envelope（提议不丢）；
// 缺省/false → 3.6 envelope 路径逐字不变（backward compat，上方两 describe 既有测试为证）。
describe('assetCardsUpdateHandler autoApply 双档 (Story 2.2 WP-D)', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    // mockReset restores the vi.fn(impl) factory default (a successful agent
    // landing) — a previous test's throwing mockImplementation must not leak.
    vi.mocked(onFieldEdited).mockReset();
  });

  it('autoApply=true → onFieldEdited(source=agent, 设定深化提议) 落盘投影卡 → 返 applied metadata + 每卡一行摘要', async () => {
    const res = await assetCardsUpdateHandler(ctxParams({
      autoApply: true,
      actions: [
        { op: 'add_card', card: character('c1', '阿米娅', { summary: '罗德岛领袖' }) },
        { op: 'update_card', cardId: 'c1', patch: { summary: '更新' } },
      ],
    }));

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('asset_cards');
    expect(options).toEqual({ source: 'agent', reason: '设定深化提议（auto 档）' });
    // 落盘的是投影后 full cards（update 已浅合并进去）。
    expect(data).toHaveLength(1);
    expect((data as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'c1', summary: '更新' });

    // applied metadata（非 field_patch envelope）。
    expect(res.metadata?.type).toBeUndefined();
    expect(res.metadata).toMatchObject({ ok: true, applied: true, actionCount: 2, cardCount: 1 });
    // 每卡一行落盘摘要。
    expect(res.output).toContain('+ 新增 character「阿米娅」（c1）');
    expect(res.output).toContain('~ 更新 c1（summary）');
  });

  it('locked field 拒（onFieldEdited throw）→ 降级 field_patch envelope + 顶部说明（提议不丢，人审）', async () => {
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field asset_cards is locked and cannot be edited');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await assetCardsUpdateHandler(ctxParams({
      autoApply: true,
      actions: [{ op: 'add_card', card: character('c1', '阿米娅') }],
    }));
    warn.mockRestore();

    // 降级 envelope：field/action/data 与 3.6 缺省路径同构。
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('asset_cards');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as unknown[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 'c1', name: '阿米娅' });
    // 顶部说明：降级原因 + 不丢提议 + 人审去向（locked 语义）。
    expect(res.output).toContain('自动生效被拒');
    expect(res.output).toContain('locked');
    expect(res.output).toContain('已转为呈给作者审阅');
  });

  it('显式 autoApply=false → envelope 路径不变 + 不落盘（backward compat 显式档）', async () => {
    const res = await assetCardsUpdateHandler(ctxParams({
      autoApply: false,
      actions: [{ op: 'add_card', card: character('c1', '阿米娅') }],
    }));

    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('asset_cards');
    expect(res.output).toContain('请在补丁面板审阅');
  });

  it('autoApply=true + 空 actions → P16 guard 先拒（不落盘不产零变更 patch）', async () => {
    const res = await assetCardsUpdateHandler(ctxParams({ autoApply: true, actions: [] }));

    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('已跳过');
    expect(res.output).toContain('操作列表为空');
  });

  it('autoApply=true + 投影失败（add 重复 id）→ 拒绝消息原样返回，不落盘不降级 envelope', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      asset_cards: [character('c1', '既有卡')],
    } as any);
    const res = await assetCardsUpdateHandler(ctxParams({
      autoApply: true,
      actions: [{ op: 'add_card', card: character('c1', '撞 id 卡') }],
    }));

    expect(onFieldEdited).not.toHaveBeenCalled();
    // computeProjectedCards ok:false 是 return 非 throw → 不触发降级，原样友好拒绝。
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('已存在');
    expect(res.output).toContain('update_card');
  });
});
