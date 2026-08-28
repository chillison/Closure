import { describe, expect, it } from 'vitest';
import { parseDirectorStoryDecisions } from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.6：parseDirectorStoryDecisions（Director 决策登记段输出解析，mirror
// parseDirectorEmotion 三路径）。锁：robust 抽取（fence/brace-slice/bare）+ 坏条目单独丢
// （CR-4.1-07）+ source 强制 'director'（信任边界）+ 既有 id idempotent 过滤 + relatedEpisodeId 剥离。
// ─────────────────────────────────────────────────────────────────────────────

const D1 = { id: 'director-betrayal', summary: '女主真背叛', reason: '妹妹被挟持', risk: '铺垫不足弃书', status: 'decided', landingState: '第 5 章起态度转冷' };
const D2 = { id: 'director-power-cost', summary: '金手指有代价', reason: '无代价则无张力', risk: '读者嫌憋屈', status: 'open', alternatives: ['无代价'] };

describe('parseDirectorStoryDecisions（Story 2.6）', () => {
  it('fenced JSON 对象五段同对象：抽 storyDecisions 段', () => {
    const content = '```json\n{"entries":[],"emotionPoints":[],"storyDecisions":[' + JSON.stringify(D1) + ']}\n```';
    const r = parseDirectorStoryDecisions(content, new Set());
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('director-betrayal');
    expect(r[0].source).toBe('director'); // 强制（draft 未带也设）
  });

  it('source 强制 director：Director 自报 user 不采信（信任边界）', () => {
    const content = JSON.stringify({ storyDecisions: [{ ...D1, source: 'user' }] });
    const r = parseDirectorStoryDecisions(content, new Set());
    expect(r).toHaveLength(1);
    expect(r[0].source).toBe('director');
  });

  it('relatedEpisodeId 剥离：Director 决策是跨章方向', () => {
    const content = JSON.stringify({ storyDecisions: [{ ...D1, relatedEpisodeId: 'ep3' }] });
    const r = parseDirectorStoryDecisions(content, new Set());
    expect(r[0].relatedEpisodeId).toBeUndefined();
  });

  it('既有 id 过滤（idempotent）：existingIds 命中丢弃，未命中保留', () => {
    const content = JSON.stringify({ storyDecisions: [D1, D2] });
    const r = parseDirectorStoryDecisions(content, new Set(['director-betrayal']));
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('director-power-cost');
  });

  it('批内重复 id：保留首个', () => {
    const content = JSON.stringify({ storyDecisions: [D1, { ...D1, summary: '重复' }] });
    const r = parseDirectorStoryDecisions(content, new Set());
    expect(r).toHaveLength(1);
    expect(r[0].summary).toBe('女主真背叛');
  });

  it('坏条目单独丢（缺 risk 的条目丢弃，好条目保留）', () => {
    const bad = { id: 'bad', summary: 's', reason: 'r', status: 'open' }; // 缺 risk
    const content = JSON.stringify({ storyDecisions: [bad, D1] });
    const r = parseDirectorStoryDecisions(content, new Set());
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('director-betrayal');
  });

  it('bare 数组（无对象包裹）+ narration 前导：brace-slice 兜底', () => {
    const content = '好的，以下是本场的执导输出：\n{"storyDecisions":[' + JSON.stringify(D2) + ']}';
    const r = parseDirectorStoryDecisions(content, new Set());
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('director-power-cost');
  });

  it('无 storyDecisions 段 / 全失败 -> []（graceful 不抛）', () => {
    expect(parseDirectorStoryDecisions('', new Set())).toEqual([]);
    expect(parseDirectorStoryDecisions('{"entries":[]}', new Set())).toEqual([]);
    expect(parseDirectorStoryDecisions('not json at all', new Set())).toEqual([]);
  });
});
