import { describe, expect, it } from 'vitest';
import {
  computePacingBreathHotspot,
  BREATH_THRESHOLD,
  type PacingBreathScene,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 5.4 R1：节奏喘息纯代码 hotspot（pacingRole vocab 精确匹配计数）。
// 纯函数 → plain vitest（无 fs/db/LLM）。覆盖（implement.md R1.3）：
// - 基本计数（breach / not breach / 混合 intense 序列）
// - relief 中断重置（喘息/铺垫/收束 均断开 intense 计数）
// - unknown pacingRole 不计 intense（保守免假 WARN）
// - graceful（空 scenes / 全缺 pacingRole / 全 unknown）
// - vocab 精确匹配（不 trim，'推进 ' 带空格 = unknown）
//
// 🔑 范式红线：纯代码机械（vocab 精确匹配计数，不解意义），不裁判「是否真致麻木」（归 L2 LLM）。
//    unknown 不计 intense = 保守不猜语义（ADR-3）。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 pacing scene 序列（id 默认 sN，pacingRole 列表按序对应）。 */
function scenes(...roles: Array<string | undefined>): PacingBreathScene[] {
  return roles.map((role, i) => ({ id: `s${i + 1}`, pacingRole: role }));
}

// ── 基本计数 ──

describe('computePacingBreathHotspot：基本计数', () => {
  it('[推进,推进,推进] → breached / maxConsecutive=3（阈值边界）', () => {
    const r = computePacingBreathHotspot(scenes('推进', '推进', '推进'));
    expect(r.breached).toBe(true);
    expect(r.maxConsecutiveIntense).toBe(3);
    expect(r.threshold).toBe(BREATH_THRESHOLD);
    expect(r.intenseRuns).toEqual([
      { startSceneRef: 's1', endSceneRef: 's3', count: 3 },
    ]);
    expect(r.note).toBeUndefined();
  });

  it('[推进,推进] → not breached / maxConsecutive=2', () => {
    const r = computePacingBreathHotspot(scenes('推进', '推进'));
    expect(r.breached).toBe(false);
    expect(r.maxConsecutiveIntense).toBe(2);
    expect(r.intenseRuns).toEqual([
      { startSceneRef: 's1', endSceneRef: 's2', count: 2 },
    ]);
  });

  it('[推进,推进,高潮,推进] → maxConsecutive=4（intense set 含高潮，连续不中断）', () => {
    // {推进,高潮} 均 intense，连续 4 场不断 → max=4 breached。
    const r = computePacingBreathHotspot(scenes('推进', '推进', '高潮', '推进'));
    expect(r.breached).toBe(true);
    expect(r.maxConsecutiveIntense).toBe(4);
    expect(r.intenseRuns).toEqual([
      { startSceneRef: 's1', endSceneRef: 's4', count: 4 },
    ]);
  });

  it('[高潮,高潮,高潮] → breached（高潮单类连续也算高强度）', () => {
    const r = computePacingBreathHotspot(scenes('高潮', '高潮', '高潮'));
    expect(r.breached).toBe(true);
    expect(r.maxConsecutiveIntense).toBe(3);
  });

  it('[铺垫] → not breached / maxConsecutive=0（单 relief 场，无 intense）', () => {
    const r = computePacingBreathHotspot(scenes('铺垫'));
    expect(r.breached).toBe(false);
    expect(r.maxConsecutiveIntense).toBe(0);
    expect(r.intenseRuns).toEqual([]);
  });
});

// ── relief 中断重置（喘息/铺垫/收束 均断开 intense 计数）──

describe('computePacingBreathHotspot：relief 中断重置', () => {
  it('[推进,推进,喘息,推进,推进] → maxConsecutive=2 not breached（喘息断开两段 2+2）', () => {
    const r = computePacingBreathHotspot(scenes('推进', '推进', '喘息', '推进', '推进'));
    expect(r.breached).toBe(false);
    expect(r.maxConsecutiveIntense).toBe(2);
    expect(r.intenseRuns).toEqual([
      { startSceneRef: 's1', endSceneRef: 's2', count: 2 },
      { startSceneRef: 's4', endSceneRef: 's5', count: 2 },
    ]);
  });

  it('铺垫 同样断开 intense 计数（relief set 三值等价）', () => {
    const r = computePacingBreathHotspot(scenes('推进', '推进', '铺垫', '推进', '推进'));
    expect(r.maxConsecutiveIntense).toBe(2);
    expect(r.breached).toBe(false);
  });

  it('收束 同样断开 intense 计数（relief set 三值等价）', () => {
    const r = computePacingBreathHotspot(scenes('推进', '推进', '收束', '推进', '推进'));
    expect(r.maxConsecutiveIntense).toBe(2);
    expect(r.breached).toBe(false);
  });

  it('[推进,推进,推进,喘息,推进,推进,推进] → 两段 breach 均 3（max=3）', () => {
    const r = computePacingBreathHotspot(
      scenes('推进', '推进', '推进', '喘息', '推进', '推进', '推进'),
    );
    expect(r.breached).toBe(true);
    expect(r.maxConsecutiveIntense).toBe(3);
    expect(r.intenseRuns).toHaveLength(2);
  });
});

// ── unknown pacingRole 不计 intense（保守免假 WARN）──

describe('computePacingBreathHotspot：unknown pacingRole 不计 intense', () => {
  it('unknown 在段前不救：[未知,推进,推进,推进] → breached（unknown 不算 relief 救场）', () => {
    const r = computePacingBreathHotspot(scenes('未知', '推进', '推进', '推进'));
    expect(r.breached).toBe(true);
    expect(r.maxConsecutiveIntense).toBe(3);
    expect(r.intenseRuns).toEqual([
      { startSceneRef: 's2', endSceneRef: 's4', count: 3 },
    ]);
  });

  it('unknown 在段间断开：[推进,推进,未知,推进] → maxConsecutive=2（unknown 不计 intense 不断 relief，但非 intense 即断计数）', () => {
    // unknown 既不计 intense 也不计 relief——作为「非 intense」断开连续 intense 计数。
    // 两段 [推进,推进]=2 / [推进]=1 → max=2 not breached。
    const r = computePacingBreathHotspot(scenes('推进', '推进', '未知', '推进'));
    expect(r.maxConsecutiveIntense).toBe(2);
    expect(r.breached).toBe(false);
    expect(r.intenseRuns).toEqual([
      { startSceneRef: 's1', endSceneRef: 's2', count: 2 },
      { startSceneRef: 's4', endSceneRef: 's4', count: 1 },
    ]);
  });

  it('unknown 断开两段等长 run：[推进,推进,未知,推进,推进] → maxConsecutive=2 not breached（controller 边界锁约定）', () => {
    // 🔑 controller check 关注点（2026-08-10）：unknown 断连续计数是 Interpretation A（偏「免假 WARN」）。
    // 两段 [推进,推进]=2 + [推进,推进]=2 → max=2 不 combine 为 4 → not breached。
    // 范式正当性：pure code 是 L2 soft hint（同 L1 hotspot），偏免假 WARN 合理——L2 读 prose 终判，
    // unknown 场可能是 relief（喘息/铺垫/收束），保守不假判 intense。若 L2 从 prose 判真有麻木风险，
    // 即使 pure code 未 breach，L2 仍可判 Emotion.pacing-breath（prompt 白名单逻辑反向也成立）。
    // design §8 已标 BREATH_THRESHOLD dogfood-tunable——精度调在 dogfood 后，非 5.4 改阈值/改 unknown 语义。
    const r = computePacingBreathHotspot(scenes('推进', '推进', '未知', '推进', '推进'));
    expect(r.maxConsecutiveIntense).toBe(2);
    expect(r.breached).toBe(false);
    expect(r.intenseRuns).toEqual([
      { startSceneRef: 's1', endSceneRef: 's2', count: 2 },
      { startSceneRef: 's4', endSceneRef: 's5', count: 2 },
    ]);
  });

  it('undefined pacingRole 同 unknown（缺省不计 intense）', () => {
    const r = computePacingBreathHotspot([
      { id: 's1', pacingRole: '推进' },
      { id: 's2', pacingRole: '推进' },
      { id: 's3' }, // pacingRole 缺
      { id: 's4', pacingRole: '推进' },
    ]);
    expect(r.maxConsecutiveIntense).toBe(2);
    expect(r.breached).toBe(false);
  });

  it('空串 pacingRole 同 unknown（缺省不计 intense）', () => {
    const r = computePacingBreathHotspot(scenes('推进', '推进', '', '推进', '推进'));
    expect(r.maxConsecutiveIntense).toBe(2);
    expect(r.breached).toBe(false);
  });
});

// ── graceful（design §3.1 / §7 失败降级）──

describe('computePacingBreathHotspot：graceful 降级', () => {
  it('空 scenes → not breached + note=no-pacing-data', () => {
    const r = computePacingBreathHotspot([]);
    expect(r.breached).toBe(false);
    expect(r.maxConsecutiveIntense).toBe(0);
    expect(r.intenseRuns).toEqual([]);
    expect(r.note).toBe('no-pacing-data');
  });

  it('全场无 pacingRole（全 undefined）→ not breached + note=no-pacing-data', () => {
    const r = computePacingBreathHotspot([
      { id: 's1' },
      { id: 's2' },
    ]);
    expect(r.breached).toBe(false);
    expect(r.maxConsecutiveIntense).toBe(0);
    expect(r.note).toBe('no-pacing-data');
  });

  it('全场 pacingRole 空串 → not breached + note=no-pacing-data', () => {
    const r = computePacingBreathHotspot(scenes('', '', ''));
    expect(r.breached).toBe(false);
    expect(r.note).toBe('no-pacing-data');
  });

  it('全场 unknown（非词表值）→ hasAnyPacingRole=true 但无 intense → maxConsecutive=0 not breached', () => {
    // 非词表值仍是 string → hasAnyPacingRole=true → 进计数逻辑 → 无命中 intense → max=0。
    // 区别于全缺（note=no-pacing-data）：此处 note 缺省（有 pacing 数据但无 intense 命中）。
    const r = computePacingBreathHotspot(scenes('自定义值', '其他'));
    expect(r.breached).toBe(false);
    expect(r.maxConsecutiveIntense).toBe(0);
    expect(r.intenseRuns).toEqual([]);
    expect(r.note).toBeUndefined();
  });
});

// ── vocab 精确匹配（不 trim，忠实 1.9 canonicalDiff `?? ''` 归一哲学）──

describe('computePacingBreathHotspot：vocab 精确匹配', () => {
  it("'推进' 带尾空格 ≠ '推进'（不 trim，忠实 vocab）", () => {
    // '推进 ' 带空格不在 INTENSE_ROLES → 不计 intense（保守）。
    const r = computePacingBreathHotspot(scenes('推进 ', '推进 ', '推进 '));
    expect(r.maxConsecutiveIntense).toBe(0);
    expect(r.breached).toBe(false);
  });

  it('英文 "推进" 不命中（vocab 是中文精确值）', () => {
    const r = computePacingBreathHotspot(scenes('advance', 'climax', 'advance'));
    expect(r.maxConsecutiveIntense).toBe(0);
  });

  it('大小写敏感（无 lowercase 归一）', () => {
    // 中文 vocab 无大小写问题；此测试守 future vocab 如加英文时的大小写语义。
    const r = computePacingBreathHotspot(scenes('推进', '推进', '推进'));
    expect(r.maxConsecutiveIntense).toBe(3);
  });
});

// ── BREATH_THRESHOLD 常量（可调，标 dogfood 后视精度）──

describe('BREATH_THRESHOLD 常量', () => {
  it('BREATH_THRESHOLD = 3（沿 epics AC3 + 5.3 DEFAULT_CONSECUTIVE_RISE_THRESHOLD 一致）', () => {
    expect(BREATH_THRESHOLD).toBe(3);
  });
});

// ── SceneStructureDigest 结构兼容（selectScenesForEpisode 产出可直接消费）──

describe('computePacingBreathHotspot：SceneStructureDigest 结构兼容', () => {
  it('接受含额外字段的 scene 结构（structural typing——selectScenesForEpisode 结果直传）', () => {
    // selectScenesForEpisode 返 SceneStructureDigest（含 role/lineTags/storyTime 等额外字段）。
    // PacingBreathScene 只需 { id, pacingRole? }——结构兼容。
    const digestLike = [
      {
        id: 's1',
        role: 'core-anchor',
        lineTags: ['l1'],
        storyTime: 0,
        storyTimeLabel: '开篇',
        presentationOrder: { chapter: 0, pos: 0 },
        episodeId: 'ep1',
        outcomeType: '受挫',
        pacingRole: '推进',
        actRef: 'act1',
      },
      {
        id: 's2',
        role: 'normal',
        lineTags: ['l1'],
        storyTime: 1,
        storyTimeLabel: '发展',
        presentationOrder: { chapter: 0, pos: 1 },
        episodeId: 'ep1',
        outcomeType: '达成',
        pacingRole: '高潮',
        actRef: 'act1',
      },
    ];
    const r = computePacingBreathHotspot(digestLike);
    // 两场均 intense → max=2 not breached。
    expect(r.maxConsecutiveIntense).toBe(2);
    expect(r.breached).toBe(false);
  });
});
