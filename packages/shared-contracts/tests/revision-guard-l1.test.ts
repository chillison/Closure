import { describe, expect, it } from 'vitest';
import {
  computeRevisionGuardL1,
  emptyRevisionGuardL1Report,
  REVISION_GUARD_L1_THRESHOLDS,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 7.2（design §1.1）：revision-guard L1 纯函数（零数据依赖）。
// 纯 TS 集合运算 → plain vitest（无 fs/db/LLM/native）。覆盖：
// - lengthRatio：剧变（缩/胀超阈）flag + 正常不 flag
// - ngramJaccard：改动幅度大 flag + 微调不 flag
// - 空文本 graceful（before/after 任一空 → 不 flag）
// - 🔑 案例：漂移模式①「研究→拆」（纯语义）L1 不 flag → 证纯语义归 L2（范式判据）
// - emptyRevisionGuardL1Report：降级形态
// ─────────────────────────────────────────────────────────────────────────────

describe('computeRevisionGuardL1（Story 7.2 L1 幅度核对，零数据依赖）', () => {
  it('🔑 案例「研究→拆」（漂移模式①纯语义）：长度近似 + n-gram 高 → L1 不 flag（纯语义归 L2）', () => {
    // 用户案例：研究控制面板 → 拆控制面板（语义倒退，但长度/结构几乎不变）。
    const report = computeRevisionGuardL1({
      beforeText: '他研究控制面板，试图理解它的运作方式。',
      afterText: '他拆控制面板，试图理解它的运作方式。',
    });
    expect(report.rangeCheck.flagged).toBe(false);
    // 仅差一字，n-gram 相似度高（3-gram 对单字变化敏感但仍远高于阈值 0.3，不 flag）。
    expect(report.rangeCheck.ngramSimilarity).toBeGreaterThan(0.7);
    // 长度近乎不变（差一字，lengthRatio ≈ 0.95，远在 0.5..2.0 正常域）。
    expect(report.rangeCheck.lengthRatio).toBeGreaterThan(0.9);
    expect(report.rangeCheck.lengthRatio).toBeLessThan(1.1);
  });

  it('🔑 案例「坐车→开车」（漂移模式②纯语义）：L1 不 flag（一字之差，纯视角语义归 L2）', () => {
    const report = computeRevisionGuardL1({
      beforeText: '今天坐车出去玩，心情很好。',
      afterText: '今天开车出去玩，心情很好。',
    });
    expect(report.rangeCheck.flagged).toBe(false);
  });

  it('大改写（lengthRatio 剧变）：flag 聚焦 hint', () => {
    const before = '他走了。'; // 4 字
    const after = '他沿着那条蜿蜒曲折、布满落叶与碎石的小径，一步一步缓慢地向前走去，最终抵达了尽头。'; // 远长于 before
    const report = computeRevisionGuardL1({ beforeText: before, afterText: after });
    expect(report.rangeCheck.flagged).toBe(true);
    expect(report.rangeCheck.lengthRatio).toBeGreaterThan(REVISION_GUARD_L1_THRESHOLDS.LENGTH_RATIO_MAX);
    expect(report.rangeCheck.note).toContain('幅度 hint');
  });

  it('剧烈缩短：lengthRatio < MIN flag', () => {
    const before = '这是一段非常非常长的原文段落，包含了许多细节描写和丰富的修饰词语。';
    const after = '短。';
    const report = computeRevisionGuardL1({ beforeText: before, afterText: after });
    expect(report.rangeCheck.flagged).toBe(true);
    expect(report.rangeCheck.lengthRatio).toBeLessThan(REVISION_GUARD_L1_THRESHOLDS.LENGTH_RATIO_MIN);
  });

  it('clean 微调（同长度同结构）：不 flag', () => {
    const report = computeRevisionGuardL1({
      beforeText: '他把拳头握得更紧了，指节泛白。',
      afterText: '他把双拳握得更紧了，指节泛白。',
    });
    expect(report.rangeCheck.flagged).toBe(false);
    expect(report.rangeCheck.note).toContain('幅度正常');
  });

  it('大幅重写但长度比正常（ngram 低 → flag 改动幅度）', () => {
    // 长度相近但内容几乎全换 → ngram Jaccard 低 → flag。
    const before = '月光冷冷地洒在远方山脊之上';
    const after = '晨雾温吞吞漫过近处河面之下';
    const report = computeRevisionGuardL1({ beforeText: before, afterText: after });
    expect(report.rangeCheck.ngramSimilarity).toBeLessThan(REVISION_GUARD_L1_THRESHOLDS.NGRAM_SIMILARITY);
    expect(report.rangeCheck.flagged).toBe(true);
  });

  it('空文本 graceful：before 空 → 不 flag + note 标空', () => {
    const report = computeRevisionGuardL1({ beforeText: '', afterText: '改后段落' });
    expect(report.rangeCheck.flagged).toBe(false);
    expect(report.rangeCheck.lengthRatio).toBe(1);
    expect(report.rangeCheck.ngramSimilarity).toBe(1);
    expect(report.rangeCheck.note).toContain('空文本');
  });

  it('空文本 graceful：after 空 → 不 flag', () => {
    const report = computeRevisionGuardL1({ beforeText: '改前段落', afterText: '' });
    expect(report.rangeCheck.flagged).toBe(false);
  });

  it('null/undefined 输入 graceful（防御 in-process 构造）', () => {
    // @ts-expect-error —— 防御 null 输入（caller 可能传 null ?? ''）
    const report = computeRevisionGuardL1({ beforeText: null, afterText: undefined });
    expect(report.rangeCheck.flagged).toBe(false);
  });

  it('ngramJaccard 完全相同 = 1，完全不同 = 0（边界）', () => {
    const same = computeRevisionGuardL1({ beforeText: '完全相同的文本', afterText: '完全相同的文本' });
    expect(same.rangeCheck.ngramSimilarity).toBe(1);

    // 完全无共享 3-gram（长度 > 3）。
    const before = '啊啊啊啊啊';
    const after = '吧吧吧吧吧';
    const diff = computeRevisionGuardL1({ beforeText: before, afterText: after });
    expect(diff.rangeCheck.ngramSimilarity).toBe(0);
  });
});

describe('emptyRevisionGuardL1Report（降级形态）', () => {
  it('降级 report：不 flag + note 标降级', () => {
    const report = emptyRevisionGuardL1Report();
    expect(report.rangeCheck.flagged).toBe(false);
    expect(report.rangeCheck.lengthRatio).toBe(1);
    expect(report.rangeCheck.ngramSimilarity).toBe(1);
    expect(report.rangeCheck.note).toContain('降级');
  });
});
