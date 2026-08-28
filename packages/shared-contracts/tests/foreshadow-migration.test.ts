import { describe, expect, it, vi } from 'vitest';
import {
  foreshadowRegistrySchema,
  transformForeshadowToPromise,
  type ForeshadowRegistry,
} from '../src';
import { promiseRegistrySchema } from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.5 Phase A：foreshadow_registry → promise_registry 迁移 transform 单测。
// 覆盖：foreshadow 全 status 组合（pending/planted/resolved/partially_resolved/abandoned）+
// 零删数据断言（title/content/relations/tags 保留）+ beat 生成（plant/payoff sceneRef）+
// Promise registry schema 合法性（输出可 parse 通过）。
//
// 范式判据：迁移 transform = 纯代码机械映射（design §6），无 LLM。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造单个 foreshadow entry（缺省字段用 schema defaults 补，经 parse 后完整）。 */
function makeEntry(overrides: Record<string, unknown> = {}): ForeshadowRegistry['items'][number] {
  return foreshadowRegistrySchema.parse({
    items: [{ id: 'f1', title: '神秘钥匙', content: '主角捡到古老钥匙', ...overrides }],
  }).items[0];
}

/** 构造 registry（多 entry）。 */
function makeRegistry(entries: Array<Record<string, unknown>>): ForeshadowRegistry {
  return foreshadowRegistrySchema.parse({
    items: entries.map((e, i) => ({ id: `f${i + 1}`, title: `T${i + 1}`, content: `C${i + 1}`, ...e })),
    version: 7,
    updatedBy: 'user',
  });
}

describe('transformForeshadowToPromise（Story 6.5 迁移 transform）', () => {
  // ════════════════════════════════════════════════════════════════════════════
  // 1. 全 status 组合映射（design §6）
  // ════════════════════════════════════════════════════════════════════════════

  it('status=pending → Promise status=open + plant beat', () => {
    const reg = makeRegistry([{ status: 'pending', plant_ref: 'scene_1' }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises).toHaveLength(1);
    expect(result.promises[0].status).toBe('open');
    expect(result.beats).toHaveLength(1);
    expect(result.beats[0].kind).toBe('plant');
    expect(result.beats[0].sceneRef).toBe('scene_1');
  });

  it('status=planted → Promise status=open + plant beat', () => {
    const reg = makeRegistry([{ status: 'planted', plant_ref: 'scene_1' }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].status).toBe('open');
    expect(result.beats).toHaveLength(1);
    expect(result.beats[0].kind).toBe('plant');
  });

  it('status=resolved → Promise status=fulfilled + plant beat + payoff beat', () => {
    const reg = makeRegistry([{
      status: 'resolved',
      plant_ref: 'scene_1',
      actual_resolve_ref: 'scene_20',
    }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].status).toBe('fulfilled');
    expect(result.beats).toHaveLength(2);
    const kinds = result.beats.map((b) => b.kind).sort();
    expect(kinds).toEqual(['payoff', 'plant']);
    const plantBeat = result.beats.find((b) => b.kind === 'plant')!;
    const payoffBeat = result.beats.find((b) => b.kind === 'payoff')!;
    expect(plantBeat.sceneRef).toBe('scene_1');
    expect(payoffBeat.sceneRef).toBe('scene_20');
  });

  it('status=resolved 无 actual_resolve_ref → payoff 用 target_resolve_ref fallback', () => {
    const reg = makeRegistry([{
      status: 'resolved',
      plant_ref: 'scene_1',
      target_resolve_ref: 'scene_target',
    }]);
    const result = transformForeshadowToPromise(reg);
    const payoffBeat = result.beats.find((b) => b.kind === 'payoff')!;
    expect(payoffBeat.sceneRef).toBe('scene_target');
  });

  it('status=partially_resolved → Promise status=fulfilled（同 resolved 映射）', () => {
    const reg = makeRegistry([{
      status: 'partially_resolved',
      plant_ref: 'scene_1',
      actual_resolve_ref: 'scene_15',
    }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].status).toBe('fulfilled');
    expect(result.beats).toHaveLength(2);
  });

  it('status=abandoned → Promise status=abandoned（plant beat 若 plant_ref 存在则保留）', () => {
    const reg = makeRegistry([{ status: 'abandoned', plant_ref: 'scene_1' }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].status).toBe('abandoned');
    expect(result.beats).toHaveLength(1);
    expect(result.beats[0].kind).toBe('plant');
  });

  it('status=abandoned 无 plant_ref → 无 beat', () => {
    const reg = makeRegistry([{ status: 'abandoned' }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].status).toBe('abandoned');
    expect(result.beats).toEqual([]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. 零删数据（title/content/relations/tags/category 迁移保留）
  // ════════════════════════════════════════════════════════════════════════════

  it('零删数据：id/title/content→summary/importance 保留', () => {
    const entry = makeEntry({
      id: 'f_red_key',
      title: 'red key',
      content: 'A red key appears before the locked tower.',
      importance: 0.8,
    });
    const reg = foreshadowRegistrySchema.parse({ items: [entry] });
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].id).toBe('f_red_key');
    expect(result.promises[0].title).toBe('red key');
    expect(result.promises[0].summary).toBe('A red key appears before the locked tower.');
    expect(result.promises[0].importance).toBe(0.8);
  });

  it('零删数据：related_foreshadow_ids → related_promise_ids（id 保持，字段改名）', () => {
    const reg = makeRegistry([{
      status: 'pending',
      related_foreshadow_ids: ['f2', 'f3'],
    }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].related_promise_ids).toEqual(['f2', 'f3']);
  });

  it('零删数据：related_asset_ids 保留', () => {
    const reg = makeRegistry([{
      status: 'pending',
      related_asset_ids: ['prop_red_key'],
    }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].related_asset_ids).toEqual(['prop_red_key']);
  });

  it('零删数据：tags 迁移 + 原 category 追加为 fs:<category> tag', () => {
    const reg = makeRegistry([{
      status: 'pending',
      tags: ['主线', '关键'],
      category: 'item',
    }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].tags).toContain('主线');
    expect(result.promises[0].tags).toContain('关键');
    expect(result.promises[0].tags).toContain('fs:item'); // 原 category 保留为 tag
  });

  it('零删数据：hint_text/resolution_text/resolution_notes 拼进 notes', () => {
    const reg = makeRegistry([{
      status: 'resolved',
      plant_ref: 's1',
      actual_resolve_ref: 's2',
      notes: '手动备注',
      hint_text: '钥匙发光暗示',
      resolution_text: '开塔场景',
      resolution_notes: '兑现顺利',
    }]);
    const result = transformForeshadowToPromise(reg);
    const notes = result.promises[0].notes!;
    expect(notes).toContain('手动备注');
    expect(notes).toContain('[暗示] 钥匙发光暗示');
    expect(notes).toContain('[兑现文本] 开塔场景');
    expect(notes).toContain('[兑现备注] 兑现顺利');
  });

  it('source_type 设为 migrated_foreshadow + category 设为 setup_payoff（foreshadow 子类）', () => {
    const reg = makeRegistry([{ status: 'pending' }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].source_type).toBe('migrated_foreshadow');
    expect(result.promises[0].category).toBe('setup_payoff');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. 版本/updatedBy 保留 + 输出合法性
  // ════════════════════════════════════════════════════════════════════════════

  it('version + updatedBy 保留', () => {
    const reg = makeRegistry([{ status: 'pending' }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.version).toBe(7);
    expect(result.updatedBy).toBe('user');
  });

  it('输出是合法 promise_registry（promiseRegistrySchema.parse 通过）', () => {
    const reg = makeRegistry([
      { status: 'planted', plant_ref: 's1' },
      { status: 'resolved', plant_ref: 's1', actual_resolve_ref: 's2' },
      { status: 'abandoned' },
    ]);
    const result = transformForeshadowToPromise(reg);
    // 再次 parse 验证输出合法性（transform 内部已 parse，外部 parse 应 idempotent 通过）
    expect(() => promiseRegistrySchema.parse(result)).not.toThrow();
    expect(result.promises).toHaveLength(3);
  });

  it('空 foreshadow_registry → 空 promise_registry（promises=[] beats=[]）', () => {
    const reg = foreshadowRegistrySchema.parse({ items: [] });
    const result = transformForeshadowToPromise(reg);
    expect(result.promises).toEqual([]);
    expect(result.beats).toEqual([]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. beat idempotency 边界（同 Scene plant+payoff 罕见情况）
  // ════════════════════════════════════════════════════════════════════════════

  it('边界：plant_ref==resolve_ref（同 Scene plant+payoff）→ 一 beat（payoff 覆盖 plant）', () => {
    // 罕见：foreshadow 在同场既 plant 又 resolve。system.md:199「同 Scene+Promise 一 beat」→ payoff 覆盖。
    const reg = makeRegistry([{
      status: 'resolved',
      plant_ref: 'same_scene',
      actual_resolve_ref: 'same_scene',
    }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.beats).toHaveLength(1);
    expect(result.beats[0].kind).toBe('payoff');
    expect(result.beats[0].sceneRef).toBe('same_scene');
  });

  it('边界：pending 无 plant_ref → open 无 beat（只迁 Promise 主体）', () => {
    const reg = makeRegistry([{ status: 'pending' }]); // 无 plant_ref
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].status).toBe('open');
    expect(result.beats).toEqual([]);
  });

  it('边界：resolved 无 plant_ref 无 resolve_ref → fulfilled 无 beat', () => {
    const reg = makeRegistry([{ status: 'resolved' }]); // 无 ref
    const result = transformForeshadowToPromise(reg);
    expect(result.promises[0].status).toBe('fulfilled');
    expect(result.beats).toEqual([]);
  });

  it('beat id 用自然键 ${promiseId}::${sceneRef}（与 projector 一致）', () => {
    const reg = makeRegistry([{
      id: 'custom_id',
      status: 'pending',
      plant_ref: 'scene_x',
    }]);
    const result = transformForeshadowToPromise(reg);
    expect(result.beats[0].id).toBe('custom_id::scene_x');
    expect(result.beats[0].promiseId).toBe('custom_id');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. BMad CR group 1 fixes（E5 per-element safeParse + B4 payoff beat created_at）
  // ════════════════════════════════════════════════════════════════════════════

  // ── E5：per-element safeParse 容错（1 坏条目不丢全 registry）──

  it('E5：1 坏条目（缺 content）+ 1 好条目 → 好条目迁移，坏条目跳过（不丢全 registry）', () => {
    // 注意：raw 对象不经 foreshadowRegistrySchema.parse（registry 层 parse 会因坏条目拒全 registry）。
    // transform 内 per-element safeParse 容错（E5，mirror CR-4.1-07 story_decisions 先例）。
    const raw = {
      items: [
        { id: 'bad', title: '坏条目' /* 缺 content——foreshadowEntrySchema required */ },
        { id: 'good', title: '好条目', content: '好内容', status: 'pending', plant_ref: 'scene_1' },
      ],
      version: 3,
      updatedBy: 'user',
    };
    const result = transformForeshadowToPromise(raw);
    expect(result.promises).toHaveLength(1);
    expect(result.promises[0].id).toBe('good'); // 好条目迁移
    expect(result.beats).toHaveLength(1);
    expect(result.beats[0].sceneRef).toBe('scene_1');
    expect(result.version).toBe(3); // version 保留
    expect(result.updatedBy).toBe('user');
  });

  it('E5：坏条目（status 越界）跳过', () => {
    const raw = {
      items: [
        { id: 'bad', title: 'X', content: 'Y', status: 'INVALID_STATUS' },
        { id: 'good', title: '好条目', content: '好内容', status: 'pending' },
      ],
    };
    const result = transformForeshadowToPromise(raw);
    expect(result.promises).toHaveLength(1);
    expect(result.promises[0].id).toBe('good');
  });

  it('E5：全坏条目 → 空 registry（不抛）', () => {
    const raw = {
      items: [
        { id: 'bad1', title: 'X' /* 缺 content */ },
        { id: 'bad2' /* 缺 title + content */ },
      ],
    };
    const result = transformForeshadowToPromise(raw);
    expect(result.promises).toEqual([]);
    expect(result.beats).toEqual([]);
  });

  it('E5：items 非数组 / 缺 items → 空 registry（容错 envelope，不 crash）', () => {
    expect(() => transformForeshadowToPromise({ items: 'not-an-array' })).not.toThrow();
    expect(() => transformForeshadowToPromise({})).not.toThrow();
    expect(() => transformForeshadowToPromise({ items: null })).not.toThrow();
    expect(transformForeshadowToPromise({ items: null }).promises).toEqual([]);
  });

  it('E5：version/updatedBy 越界值 → fallback default（输出恒为合法 registry）', () => {
    const raw = {
      items: [{ id: 'g', title: '好', content: 'C', status: 'pending' }],
      version: 'not-a-number',
      updatedBy: 'invalid',
    };
    const result = transformForeshadowToPromise(raw);
    expect(result.version).toBe(0); // fallback default
    expect(result.updatedBy).toBe('agent'); // fallback default
  });

  it('E5：1 坏 + 19 好 → 19 好条目迁移（不丢全 registry）', () => {
    const goodItems = Array.from({ length: 19 }, (_, i) => ({
      id: `g${i}`, title: `T${i}`, content: `C${i}`, status: 'pending',
    }));
    const raw = {
      items: [{ id: 'bad' /* 缺 title + content */ }, ...goodItems],
    };
    const result = transformForeshadowToPromise(raw);
    expect(result.promises).toHaveLength(19);
    expect(result.promises.map((p) => p.id).sort()).toEqual(
      Array.from({ length: 19 }, (_, i) => `g${i}`).sort(),
    );
  });

  it('E5：坏条目 console.warn（可观测性，每坏条目一 warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = {
      items: [
        { id: 'bad', title: 'X' /* 缺 content */ },
        { id: 'good', title: '好', content: 'C', status: 'pending' },
      ],
    };
    transformForeshadowToPromise(raw);
    expect(warnSpy).toHaveBeenCalledTimes(1); // 1 坏条目 → 1 warn
    warnSpy.mockRestore();
  });

  it('E5：已 parse 的 ForeshadowRegistry 仍兼容（向后兼容，envelope 接受）', () => {
    // 既有调用方（local-bff）传 fsResult.data（已 parse ForeshadowRegistry）——envelope 接受。
    const parsed = foreshadowRegistrySchema.parse({
      items: [{ id: 'f1', title: 'T', content: 'C', status: 'pending' }],
      version: 5,
    });
    const result = transformForeshadowToPromise(parsed);
    expect(result.promises).toHaveLength(1);
    expect(result.version).toBe(5);
  });

  // ── B4：payoff beat created_at 用 resolved_at（非 planted_at）──

  it('B4：payoff beat created_at 用 resolved_at（plant 用 planted_at）', () => {
    const reg = makeRegistry([{
      status: 'resolved',
      plant_ref: 'scene_1',
      actual_resolve_ref: 'scene_20',
      planted_at: '2026-01-01T00:00:00Z',
      resolved_at: '2026-06-01T00:00:00Z',
    }]);
    const result = transformForeshadowToPromise(reg);
    const plantBeat = result.beats.find((b) => b.kind === 'plant')!;
    const payoffBeat = result.beats.find((b) => b.kind === 'payoff')!;
    expect(plantBeat.created_at).toBe('2026-01-01T00:00:00Z');  // plant 用 planted_at
    expect(payoffBeat.created_at).toBe('2026-06-01T00:00:00Z'); // payoff 用 resolved_at
  });

  it('B4：payoff beat 无 resolved_at → fallback planted_at', () => {
    const reg = makeRegistry([{
      status: 'resolved',
      plant_ref: 'scene_1',
      actual_resolve_ref: 'scene_20',
      planted_at: '2026-01-01T00:00:00Z',
      // 无 resolved_at
    }]);
    const result = transformForeshadowToPromise(reg);
    const payoffBeat = result.beats.find((b) => b.kind === 'payoff')!;
    expect(payoffBeat.created_at).toBe('2026-01-01T00:00:00Z'); // fallback planted_at
  });
});
