import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  computeL1SignalReport,
  L1_THRESHOLDS,
  CLICHE_PHRASES_ZH,
  CRUTCH_WORDS_ZH,
  FILTER_WORDS_ZH,
  type L1SignalReport,
  type SceneGraph,
} from '@orison/shared-contracts';
import { isPosTaggerAvailable, tagChinese } from '../src/audit/pos-tagger';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.2 Step 2 — computeL1SignalReport（L1 纯代码 stylometry）单测。
//
// 验证 design §4 / implement Step 2：
//  - 9 anti-slop 信号各自可算（value + flagged + evidence），POS 依赖信号 tagger 缺时 skip。
//  - storyTime fold 诚实 scope：结构查询（expectedOrder 按 storyTime 排序）+ fullFoldDeferred。
//  - L1 永不 gate：所有 flagged 仅 bool hint；grounding（quote + location）随 flagged 给出。
//  - 两类样本（人类自然文字 vs 故意 AI 腔高频 cliché/crutch/filter + 长破折号）断言 flagged 合理。
//
// 范式判据（ADR-3 / creative-vs-mechanical）：computeL1SignalReport 是确定性统计/结构查/阈值命中，
// 零 LLM、零语义判断。本测只验机械产出形态 + 软信号 flag 是否「合理」（密度高→flag，密度低→不 flag），
// 不验任何「质量/好坏」语义——「这段是否真 slop」归 Step 5 L2 LLM。
//
// tagger + compress 经 DI 注入（ADR-2 seam）：tagChinese 从 pos-tagger.ts（@node-rs/jieba），
// compress 用 node:zlib gzipSync（agent 运行环境 node-only，shared-contracts 保持 native-free）。
// ─────────────────────────────────────────────────────────────────────────────

const NATURAL_PROSE = [
  '风灌进来。',
  '他推开门的时候，桌上的纸被穿堂风吹得哗啦啦响，她头也没抬，只是把茶杯往里挪了挪。',
  '雨还在下。',
  '灶上的水开了，咕嘟咕嘟冒着泡。',
  '他在门口站了一会儿，看檐边那块被敲得当当作响的铁皮，又看看她低着的后脑勺，最后把湿外套搭到椅背上。',
].join('');

// 故意 AI 腔：高频 cliché（嘴角微微上扬/璀璨/然而/不仅如此/眉头紧锁/深吸一口气/油然而生/熠熠生辉）
// + crutch（突然/非常/慢慢地/开始/似乎）+ filter（注意到/意识到/感觉）+ 长破折号 — + 重复 POS 骨架。
const AI_SLOP_PROSE = [
  '突然，他嘴角微微上扬，眼眸闪过一丝璀璨的光芒。',
  '然而，她不由得眉头紧锁，深吸一口气。',
  '不仅如此，他非常清楚地注意到，她慢慢地开始意识到事情似乎并非如此简单。',
  '与此同时，璀璨的光芒绽放，熠熠生辉，仿佛画卷缓缓展开。',
  '他不禁油然而生一种感觉——一切都变了——不可阻挡地——',
].join('');

/** 注入 deps：real tagger + real gzip compress（agent 运行环境）。 */
const deps = {
  tagChinese,
  compress: (s: string) => gzipSync(s, { level: 9 }).length,
};

describe('computeL1SignalReport — 9 信号产出形态 + 范式（纯代码，软信号）', () => {
  it('native tagger 可用（前置：@node-rs/jieba 装好，POS 信号可测）', () => {
    expect(isPosTaggerAvailable()).toBe(true);
  });

  it('产出 9 个信号，每个含 name/value/flagged/evidence 四基字段', () => {
    const report = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps });
    expect(report.signals).toHaveLength(9);
    const expectedNames = [
      'posgram_skeleton_repeat',
      'cr_pos',
      'sentence_length_variance',
      'lexical_diversity',
      'cliche_ratio',
      'crutch_word_density',
      'filter_word_density',
      'punctuation_rhythm',
      'cr_words',
    ];
    expect(report.signals.map((s) => s.name)).toEqual(expectedNames);
    for (const sig of report.signals) {
      expect(typeof sig.name).toBe('string');
      expect(typeof sig.value).toBe('number');
      expect(typeof sig.flagged).toBe('boolean');
      expect(Array.isArray(sig.evidence)).toBe(true);
      // flagged=true 时须有 evidence（grounding）；skipped/unflagged 可空
      if (sig.flagged) expect(sig.evidence.length).toBeGreaterThan(0);
    }
  });

  it('L1 永不 gate——report 不含 verdict/BLOCK，所有 flagged 仅 bool hint（R3 §6.4 软信号红线）', () => {
    const report = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps });
    // report shape 只有 signals + hotspots + storyTimeContext?，无 verdict/block 字段
    expect(report).not.toHaveProperty('verdict');
    expect(report).not.toHaveProperty('block');
    expect(report).not.toHaveProperty('decision');
    // flagged 是 bool，不是 verdict
    for (const sig of report.signals) {
      expect(typeof sig.flagged).toBe('boolean');
    }
  });

  it('POS 依赖信号 tagger 缺时 skip（flagged=false + note 明示）', () => {
    const report = computeL1SignalReport({ draftText: AI_SLOP_PROSE }); // 无 deps
    const posgram = report.signals.find((s) => s.name === 'posgram_skeleton_repeat')!;
    const crPos = report.signals.find((s) => s.name === 'cr_pos')!;
    expect(posgram.flagged).toBe(false);
    expect(posgram.note).toMatch(/skipped|过短/i);
    expect(crPos.flagged).toBe(false);
    expect(crPos.note).toMatch(/skipped/i);
    // 无 tagger 时余 7 非 POS 信号仍可算（lexical_diversity 降级 char-based）
    const lex = report.signals.find((s) => s.name === 'lexical_diversity')!;
    expect(lex.note).toMatch(/char-based 退化/);
  });

  it('compress 缺时 CR-words / CR:PoS skip，余信号仍上（design §10 rollback）', () => {
    const noCompress = { tagChinese };
    const report = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps: noCompress });
    const crWords = report.signals.find((s) => s.name === 'cr_words')!;
    const crPos = report.signals.find((s) => s.name === 'cr_pos')!;
    expect(crWords.flagged).toBe(false);
    expect(crWords.note).toMatch(/skipped/i);
    expect(crPos.flagged).toBe(false);
    // cliché/crutch/filter 不依赖 compress，仍可算
    const cliche = report.signals.find((s) => s.name === 'cliche_ratio')!;
    expect(typeof cliche.value).toBe('number');
  });
});

describe('computeL1SignalReport — 两类样本断言（软信号 flag 合理）', () => {
  it('人类自然文字：cliché/crutch/filter 密度低 → 不 flag', () => {
    const report = computeL1SignalReport({ draftText: NATURAL_PROSE, deps });
    const cliche = report.signals.find((s) => s.name === 'cliche_ratio')!;
    const crutch = report.signals.find((s) => s.name === 'crutch_word_density')!;
    const filter = report.signals.find((s) => s.name === 'filter_word_density')!;
    expect(cliche.flagged).toBe(false);
    expect(crutch.flagged).toBe(false);
    expect(filter.flagged).toBe(false);
    // 自然文字词汇多样、句长参差 → lexical_diversity / sentence_length 不 flag
    const lex = report.signals.find((s) => s.name === 'lexical_diversity')!;
    const lenCv = report.signals.find((s) => s.name === 'sentence_length_variance')!;
    expect(lex.flagged).toBe(false);
    expect(lenCv.flagged).toBe(false);
    // 无长破折号 → punctuation_rhythm 不因 em-dash flag（rhythm CV 视样本，不强断）
    const punct = report.signals.find((s) => s.name === 'punctuation_rhythm')!;
    expect(punct.note).not.toMatch(/ChatGPT hyphen/); // 无 em-dash 证据
  });

  it('故意 AI 腔：cliché/crutch/filter 密度高 + 长破折号 → flag', () => {
    const report = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps });
    const cliche = report.signals.find((s) => s.name === 'cliche_ratio')!;
    const crutch = report.signals.find((s) => s.name === 'crutch_word_density')!;
    const filter = report.signals.find((s) => s.name === 'filter_word_density')!;
    const punct = report.signals.find((s) => s.name === 'punctuation_rhythm')!;
    expect(cliche.flagged).toBe(true);
    expect(crutch.flagged).toBe(true);
    expect(filter.flagged).toBe(true);
    expect(punct.flagged).toBe(true); // em-dash 触发
    // AI 腔 flag 的信号须带 grounding 证据（quote + location）
    expect(cliche.evidence.length).toBeGreaterThan(0);
    expect(punct.evidence.some((e) => e.quote.includes('ChatGPT hyphen'))).toBe(true);
  });

  it('AI 腔 hotspots 聚合 per-location flagged 信号（喂 L2 聚焦）', () => {
    const report = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps });
    expect(report.hotspots.length).toBeGreaterThan(0);
    // 每个 hotspot 有 location（句索引）+ 至少一个信号名
    for (const h of report.hotspots) {
      expect(h.location).toMatch(/^句\d+$/);
      expect(h.signals.length).toBeGreaterThan(0);
    }
  });

  it('词库命中确定性——同输入同输出（纯代码无随机）', () => {
    const a = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps });
    const b = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps });
    expect(b.signals.map((s) => s.value)).toEqual(a.signals.map((s) => s.value));
    expect(b.signals.map((s) => s.flagged)).toEqual(a.signals.map((s) => s.flagged));
  });

  it('grounding 形态：flagged 信号 evidence 含 quote（正文原句）+ location（句索引）', () => {
    const report = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps });
    const cliche = report.signals.find((s) => s.name === 'cliche_ratio')!;
    // 前 5 条 evidence 是 per-sentence（location=句N），quote 含原句 + 命中短语
    const perSentenceEv = cliche.evidence.filter((e) => e.location.match(/^句\d+$/));
    expect(perSentenceEv.length).toBeGreaterThan(0);
    for (const ev of perSentenceEv) {
      expect(ev.quote.length).toBeGreaterThan(0);
      expect(ev.location).toMatch(/^句\d+$/);
    }
  });
});

describe('computeL1SignalReport — storyTime fold（一致性 L1，诚实 scope）', () => {
  /** 最小 SceneGraph fixture：3 场属 ep1，storyTime 故意打乱验证排序。 */
  const sceneGraph: SceneGraph = {
    nodes: [
      {
        id: 'scene-c', lineTags: ['main'], storyTime: 3,
        presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', episodeId: 'ep1',
      },
      {
        id: 'scene-a', lineTags: ['main'], storyTime: 1,
        presentationOrder: { chapter: 0, pos: 0 }, role: 'normal', episodeId: 'ep1',
      },
      {
        id: 'scene-b', lineTags: ['main'], storyTime: 2,
        presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', episodeId: 'ep1',
      },
      {
        id: 'scene-other', lineTags: ['main'], storyTime: 5,
        presentationOrder: { chapter: 0, pos: 5 }, role: 'normal', episodeId: 'ep2',
      },
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };

  it('scene_graph + episodeId 提供 → storyTimeContext 产出（结构查询）', () => {
    const report = computeL1SignalReport({
      draftText: AI_SLOP_PROSE, sceneGraph, episodeId: 'ep1', deps,
    });
    expect(report.storyTimeContext).toBeDefined();
    expect(report.storyTimeContext!.episodeId).toBe('ep1');
    // 仅取 ep1 的 3 场（排除 ep2）
    expect(report.storyTimeContext!.expectedOrder).toHaveLength(3);
  });

  it('expectedOrder 按 storyTime 升序排序（机械结构排序，非语义）', () => {
    const report = computeL1SignalReport({
      draftText: AI_SLOP_PROSE, sceneGraph, episodeId: 'ep1', deps,
    });
    const order = report.storyTimeContext!.expectedOrder.map((s) => s.id);
    // fixture 故意打乱（c/a/b），排序后应为 a(1) → b(2) → c(3)
    expect(order).toEqual(['scene-a', 'scene-b', 'scene-c']);
  });

  it('fullFoldDeferred=true + note 明示 defer（诚实公平——不造假机械检查）', () => {
    const report = computeL1SignalReport({
      draftText: AI_SLOP_PROSE, sceneGraph, episodeId: 'ep1', deps,
    });
    expect(report.storyTimeContext!.fullFoldDeferred).toBe(true);
    expect(report.storyTimeContext!.note).toMatch(/defer|场景切分|全 fold/i);
    expect(report.storyTimeContext!.note).toMatch(/L2/);
  });

  it('无 scene_graph / episodeId → storyTimeContext 缺省（graceful）', () => {
    const noGraph = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps });
    expect(noGraph.storyTimeContext).toBeUndefined();
    const noEp = computeL1SignalReport({ draftText: AI_SLOP_PROSE, sceneGraph, deps });
    expect(noEp.storyTimeContext).toBeUndefined();
  });

  it('storyTime fold 不造假 BLOCK——context 是 hint 非 verdict（范式判据）', () => {
    const report = computeL1SignalReport({
      draftText: AI_SLOP_PROSE, sceneGraph, episodeId: 'ep1', deps,
    });
    // storyTimeContext 无 flagged/severity 字段（纯 context hint，L2 判）
    expect(report.storyTimeContext).not.toHaveProperty('flagged');
    expect(report.storyTimeContext).not.toHaveProperty('severity');
    expect(report.storyTimeContext).not.toHaveProperty('verdict');
  });
});

describe('computeL1SignalReport — 边界 / 退化', () => {
  it('空正文 → 全信号 skip / 不 flag（不崩）', () => {
    const report = computeL1SignalReport({ draftText: '', deps });
    for (const sig of report.signals) {
      expect(sig.flagged).toBe(false);
    }
    expect(report.hotspots).toEqual([]);
  });

  it('极短正文（<4 token）→ POS 信号 skip（不可靠，note 明示）', () => {
    const report = computeL1SignalReport({ draftText: '他走了。', deps });
    const posgram = report.signals.find((s) => s.name === 'posgram_skeleton_repeat')!;
    expect(posgram.flagged).toBe(false);
    expect(posgram.note).toMatch(/过短|skip/i);
  });

  it('词库非空（Step 3 starter 集落地）', () => {
    expect(CLICHE_PHRASES_ZH.length).toBeGreaterThan(20);
    expect(CRUTCH_WORDS_ZH.all.length).toBeGreaterThan(20);
    expect(CRUTCH_WORDS_ZH.intensifier.length).toBeGreaterThan(5);
    expect(CRUTCH_WORDS_ZH.hedging.length).toBeGreaterThan(5);
    expect(CRUTCH_WORDS_ZH.filler.length).toBeGreaterThan(5);
    expect(CRUTCH_WORDS_ZH.narrative.length).toBeGreaterThan(5);
    expect(FILTER_WORDS_ZH.length).toBeGreaterThan(10);
  });

  it('L1_THRESHOLDS 导出（软阈值可调参 + 未来 baseline 替换）', () => {
    expect(L1_THRESHOLDS.POSGRAM_REPEAT_RATIO).toBeGreaterThan(0);
    expect(L1_THRESHOLDS.LEXICAL_DIVERSITY).toBeLessThan(0.5);
    expect(L1_THRESHOLDS.EM_DASH_PER_CHAR).toBeLessThan(0.01);
  });

  it('report 类型完整——signals + hotspots + storyTimeContext?（design §4 shape 落地）', () => {
    const report: L1SignalReport = computeL1SignalReport({ draftText: AI_SLOP_PROSE, deps });
    expect(report).toHaveProperty('signals');
    expect(report).toHaveProperty('hotspots');
    // storyTimeContext optional
    expect(report.storyTimeContext === undefined || typeof report.storyTimeContext === 'object').toBe(true);
  });

  // ── 回归：PUNCTUATION_CHARS_RE 不带 g flag（防 .test() stateful 致连续标点误计 prose）──
  // 旧 bug：regex 带 g flag + 逐字 .test(ch) → 连续标点的第 2 个起被误判为非标点（lastIndex 推进后到
  // 1-char 串尾 miss），countProseChars 膨胀 + char-fallback TTR 假阳。修：去 g flag（.split 不需 g）。
  // 此测锁修：纯连续标点输入 → 0 prose char → char-fallback TTR 返 null → lexical_diversity skip。
  // 旧版带 g flag 时此测会 FAIL（TTR 非空 → lexical_diversity 不 skip）。
  it('连续标点不计入 prose（PUNCTUATION_CHARS_RE 无 g flag 回归锁——修连续标点 stateful 误计 bug）', () => {
    // 无 tagger → computeTtr 走 char-fallback；纯标点 '。，；！' 应全滤除 → chars.length===0 → null
    const report = computeL1SignalReport({ draftText: '。，；！' }); // 无 deps → char-fallback
    const lex = report.signals.find((s) => s.name === 'lexical_diversity')!;
    expect(lex.flagged).toBe(false);
    expect(lex.note).toMatch(/空正文|skip|无可用 token/); // 0 prose char → null → skip
    expect(lex.value).toBe(0);
  });
});
