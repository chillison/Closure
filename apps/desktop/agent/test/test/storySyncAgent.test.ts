import { describe, expect, it } from 'vitest';
import { parseStorySyncResponse } from '@orison/story-sync';
import { deriveStorySyncByRules } from '../src/nodes/story-sync-agent/rules';

describe('story-sync parser (re-exported from @orison/story-sync)', () => {
  it('parses a clean JSON response and keeps allowed patches', () => {
    // Story 6.5：foreshadow_registry → promise_registry 改名。parser 白名单走 creativeFieldKeys（含
    // promise_registry）。用 asset_cards 作通用合法 field 测 parser 保持逻辑（不耦合 6.5 改名）。
    const text = JSON.stringify({
      runId: 'IGNORED_BY_LLM',
      chapterId: 'IGNORED_BY_LLM',
      summary: 'extracted asset',
      patches: [
        {
          field: 'asset_cards',
          action: 'merge',
          data: { id: 'item_1', name: '钥匙', type: 'prop' },
          fieldVersion: 3,
          generatedBy: 'someone-else',
        },
      ],
    });
    const r = parseStorySyncResponse(text, {
      runId: 'run_1',
      chapterId: 'ch_1',
      fieldVersions: { asset_cards: 3 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.runId).toBe('run_1');
    expect(r.payload.chapterId).toBe('ch_1');
    expect(r.payload.patches).toHaveLength(1);
    expect(r.payload.patches[0].generatedBy).toBe('story-sync-agent');
  });

  it('rejects payload when any patch field is not in creativeFieldKeys whitelist', () => {
    const text = JSON.stringify({
      summary: 'mixed',
      patches: [
        {
          field: 'NOT_A_FIELD',
          action: 'merge',
          data: {},
          fieldVersion: 0,
          generatedBy: 'story-sync-agent',
        },
      ],
    });
    const r = parseStorySyncResponse(text, {
      runId: 'run_1',
      chapterId: 'ch_1',
      fieldVersions: {},
    });
    expect(r.ok).toBe(false);
  });

  it('rejects foreshadow_registry (post-6.5 不再 creative field，白名单拒)', () => {
    // Story 6.5 防线：foreshadow_registry 已改名 promise_registry，旧 field 名不在 creativeFieldKeys 白名单 →
    // parser 拒（防 LLM 误产旧 field 名 patch 落盘到不存在的 field）。
    const text = JSON.stringify({
      summary: 'stale field name',
      patches: [
        {
          field: 'foreshadow_registry',
          action: 'merge',
          data: { items: [] },
          fieldVersion: 0,
          generatedBy: 'story-sync-agent',
        },
      ],
    });
    const r = parseStorySyncResponse(text, {
      runId: 'run_1',
      chapterId: 'ch_1',
      fieldVersions: {},
    });
    expect(r.ok).toBe(false);
  });

  it('returns ok=false when no JSON can be extracted', () => {
    const r = parseStorySyncResponse('sorry I cannot help', {
      runId: 'run_1',
      chapterId: 'ch_1',
      fieldVersions: {},
    });
    expect(r.ok).toBe(false);
  });
});

describe('story-sync rules（Story 6.5 收缩：foreshadow 提取移除）', () => {
  // Story 6.5（design §10 D10 / AC7）：FORESHADOW_CUES 词命中 → foreshadow_registry merge patch 逻辑已移除。
  // promise_registry 不进 story-sync（CR-E7 track-conflation 防线——读者债走 promise-emergence-node LLM 涌现
  // 登记，非 prose 机械词提取）。rules 现返空 patches（无提取规则）。

  it('content 含旧 FORESHADOW_CUES 词（铜钥匙）→ 不再产 patch（提取已移除，返空）', () => {
    const out = deriveStorySyncByRules({
      chapterId: 'ch_1',
      content: '他从抽屉里取出一把铜钥匙。',
      chapterNumber: 3,
    });
    // 旧逻辑会产 foreshadow_registry merge patch（铜钥匙命中）；6.5 收缩后返空。
    expect(out.patches).toEqual([]);
  });

  it('content 无任何线索词 → 返空 patches（与旧行为一致）', () => {
    const out = deriveStorySyncByRules({
      chapterId: 'ch_1',
      content: '阳光洒在桌面上。',
      chapterNumber: 1,
    });
    expect(out.patches).toEqual([]);
  });

  it('不产 promise_registry patch（CR-E7 防线：读者债不走 story-sync rules）', () => {
    const out = deriveStorySyncByRules({
      chapterId: 'ch_1',
      content: '他许下一个承诺，读者期待兑现。',
      chapterNumber: 1,
    });
    // 即使 content 含「承诺」「兑现」等读者债相关词，rules 也不产 promise_registry patch——
    // Promise 涌现归 promise-emergence-node（LLM 语义判定 gap），非 prose 词命中。
    expect(out.patches).toEqual([]);
  });
});
