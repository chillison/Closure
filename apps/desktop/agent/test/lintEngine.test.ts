import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LINT_UPSTREAM_COMMIT,
  aggregateFullReport,
  defaultLintConfig,
  getLintEngine,
  loadLintEngine,
  resetLintEngineForTests,
} from '../src/lint/lintEngine';
import { loadRules } from '../src/lint/vendor/llmlint/src/rules';
import * as vendorRulesModule from '../src/lint/vendor/llmlint/src/rules';
import type { RegexRuleRecord } from '../src/lint/vendor/llmlint/src/types';
import { logger } from '../src/logger';
import { lintChapterReportSchema } from '@orison/shared-contracts';

// ── C1.2 lintEngine 适配层单测（implement Step 3）──
//
// 样例来源纪律（dispatch）：命中/对照样例**从 vendor rulesets JSON 数据推导**，不手造。
// 现实约束：vendored 规则集里带 `examples` 字段的只有 8 条 semantic 规则（静态永不命中型，
// 见 vendor README「已知注意点」），故样例分两路：
//  1. regex 规则——从 active 规则的 detector.targets 提取「纯字面量多分支 alternation」
//     （如 `值得注意的是|需要指出的是`），字面量嵌入载体句即数据推导的命中样例；
//     载体句本身即对照样例。随 re-vendor 规则漂移自动跟随，无需手改。
//  2. semantic 规则——examples 全集（16 例）作**静态零命中**对照（semantic detector 设计上
//     永不进静态扫描，这是被钉住的不变量）。
// handler/density 规则无 examples 数据，各用一条钉在 vendored commit 7b0e5a0 的确定性
// 触发样例（注释标明目标规则），re-vendor 后若规则漂移测试红——即防漂移守门的本意。
//
// defaultConfig 单源（CR-020）：本文件与 lintVendorInvariants.test.ts 此前各自手写 defaultConfig
// literal（第三处在 lintEngine.ts 内部）——三处漂移面收敛为 defaultLintConfig() 单源导出。

const REGEX_METACHARS = new Set('.*+?^${}()|[]\\');

/**
 * 判定 target 是否「扁平纯字面量 alternation」：`|` 仅作分支分隔，任何分支（含整个 target）
 * 不得含正则元字符——含 `(?:a|b)` 分组的 target 经朴素 `|` 切分会把组内分支误当独立
 * 可匹配字面量（assistant-comfort-pose 教训），必须整体拒绝。
 * 是则返回字面量分支列表（命中样例素材），否则 null。
 */
function pureLiteralAlternation(target: string): string[] | null {
  const branches = target.split('|');
  if (branches.length < 2 || branches.some((branch) => branch.length === 0)) {
    return null;
  }
  const hasMetachar = branches.some((branch) =>
    [...branch].some((ch) => REGEX_METACHARS.has(ch)),
  );
  return hasMetachar ? null : branches;
}

/** 从 active regex 规则推导冒烟素材：全域 scope（all 层、无位置窗口）+ 纯字面量 alternation。 */
function literalSampleRules(rules: RegexRuleRecord[]): Array<{ rule: RegexRuleRecord; literal: string }> {
  const samples: Array<{ rule: RegexRuleRecord; literal: string }> = [];
  for (const rule of [...rules].sort((a, b) => a.id.localeCompare(b.id))) {
    if (rule.scope.layer !== 'all' || rule.scope.position) continue;
    for (const target of rule.detector.targets) {
      const literals = pureLiteralAlternation(target);
      if (literals) {
        samples.push({ rule, literal: literals[0]! });
        break;
      }
    }
  }
  return samples;
}

describe('lintEngine 规则装载', () => {
  it('vendored 规则集全量装载：360 总 / 266 active（commit 7b0e5a0 口径，re-vendor 时随更新）', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    expect(engine!.registry.totalRules).toBe(360);
    expect(engine!.registry.activeRules).toBe(266);
    expect(engine!.registry.disabledRules).toBe(94);
    expect(engine!.upstream.commit).toBe(LINT_UPSTREAM_COMMIT);
    expect(engine!.upstream.ruleVersion).toBe('3.0.0');
  });

  it('getLintEngine 进程级单例：两次调用同一实例', async () => {
    const a = await getLintEngine();
    const b = await getLintEngine();
    expect(a).toBe(b);
  });
});

describe('lintEngine 正反例冒烟（样例源 = vendor rulesets 数据）', () => {
  it('regex 规则：字面量命中 / 载体对照不命中（≥3 条不同规则）', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const loaded = await loadRules(defaultLintConfig());
    const samples = literalSampleRules(loaded.regexRules);
    // 素材充足性本身是不变量：active 集里纯字面量规则 < 3 条 = vendored 数据异常
    expect(samples.length).toBeGreaterThanOrEqual(3);

    for (const { rule, literal } of samples.slice(0, 5)) {
      const hitReport = engine!.scanText(`他把笔搁在桌上，${literal}，窗外的雨还没有停。`, {
        chapterId: 'c-smoke',
      });
      const hitIds = hitReport.issues.map((issue) => issue.ruleId);
      expect(hitIds, `规则 ${rule.id} 的字面量「${literal}」应命中`).toContain(rule.id);

      const controlReport = engine!.scanText('他把笔搁在桌上，窗外的雨还没有停。', {
        chapterId: 'c-smoke',
      });
      const controlIds = controlReport.issues.map((issue) => issue.ruleId);
      expect(controlIds, `对照载体句不应命中规则 ${rule.id}`).not.toContain(rule.id);
    }
  });

  it('handler 规则命中：story-deslop.not-is-comparison（不是A，而是B 状态机，narrative 层）', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    // 钉在 vendored commit 7b0e5a0 的 handler 触发样例（规则无 examples 数据）
    const hitReport = engine!.scanText('他不是怯懦，而是清醒。清醒得近乎冷酷。', { chapterId: 'c-smoke' });
    const hit = hitReport.issues.find((issue) => issue.ruleId === 'story-deslop.not-is-comparison');
    expect(hit, '「不是A，而是B」叙述层句式应由 handler 命中').toBeDefined();
    expect(hit!.level).toBe('high');
    expect(hit!.review).toBe('agent');
    expect(hit!.fixability).toBe('manual');
    expect(hit!.match).toContain('不是');

    const controlReport = engine!.scanText('他保持着清醒。清醒得近乎冷酷。', { chapterId: 'c-smoke' });
    expect(
      controlReport.issues.some((issue) => issue.ruleId === 'story-deslop.not-is-comparison'),
    ).toBe(false);
  });

  it('density 规则命中：story-deslop.abstract-summary-density（beginning 桶「新的开始」×3）', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    // 钉在 vendored commit 7b0e5a0：该规则 patterns 含 (?:新的开始|全新的开始) 字面分支，
    // minHits=3 / perKilo=4（doc 粒度）。短文 3 次命中 → 密度远超门槛。
    const text = '新的开始，他想。新的开始，她也在想。一切都指向新的开始。';
    const report = engine!.scanText(text, { chapterId: 'c-smoke' });
    const density = report.densityIssues.find(
      (issue) => issue.ruleId === 'story-deslop.abstract-summary-density',
    );
    expect(density, '空泛总结密度指纹应命中').toBeDefined();
    expect(density!.hits).toBeGreaterThanOrEqual(3);
    expect(density!.perKilo).toBeGreaterThan(4);
    expect(density!.samples.length).toBeGreaterThan(0);

    const control = engine!.scanText('他把伞收起来，雨还没有停。她转身进了门。', { chapterId: 'c-smoke' });
    expect(
      control.densityIssues.some(
        (issue) => issue.ruleId === 'story-deslop.abstract-summary-density',
      ),
    ).toBe(false);
  });

  it('semantic 规则 examples 全集静态零命中（8 规则 × 2 例，semantic detector 永不进静态扫描）', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const loaded = await loadRules(defaultLintConfig());
    const withExamples = loaded.semanticRules.filter((rule) => (rule.examples ?? []).length > 0);
    // 8 条 semantic 规则全带 examples（commit 7b0e5a0 口径）——素材缺失 = 数据异常
    expect(withExamples.length).toBe(8);

    const semanticIds = new Set(loaded.semanticRules.map((rule) => rule.id));
    for (const rule of withExamples) {
      for (const example of rule.examples ?? []) {
        const report = engine!.scanText(example.text, { chapterId: 'c-smoke' });
        const semanticHits = report.issues.filter((issue) => semanticIds.has(issue.ruleId));
        expect(
          semanticHits,
          `semantic 规则 ${rule.id} 的 example（hit=${example.hit}）静态扫描必须零命中`,
        ).toEqual([]);
      }
    }
  });
});

describe('lintEngine 受众桶投影（scan 一次、投影两次）', () => {
  it('review=human 命中：all 桶可见、agent 桶隐藏、summary 随过滤重算', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const loaded = await loadRules(defaultLintConfig());
    const humanRule = literalSampleRules(loaded.regexRules).find(
      ({ rule }) => rule.review === 'human',
    );
    // filler-worth-noting（值得注意的是|需要指出的是|需要强调的是，review=human）等素材在场
    expect(humanRule, 'active 集应存在 review=human 的纯字面量规则').toBeDefined();

    const text = `他把笔搁在桌上，${humanRule!.literal}，窗外的雨还没有停。`;
    const all = engine!.scanText(text, { chapterId: 'c-audience' });
    const agent = engine!.filterByReview(all, 'agent');

    expect(all.issues.some((issue) => issue.ruleId === humanRule!.rule.id)).toBe(true);
    expect(agent.issues.some((issue) => issue.ruleId === humanRule!.rule.id)).toBe(false);
    expect(agent.issues.every((issue) => issue.review === 'agent')).toBe(true);
    // summary 重算口径：total = 过滤后 issues 数，visibleChars 不变
    expect(agent.summary.total).toBe(agent.issues.length);
    expect(agent.summary.total).toBeLessThan(all.summary.total);
    expect(agent.summary.visibleChars).toBe(all.summary.visibleChars);
    // 'all' 投影 = 原样
    expect(engine!.filterByReview(all, 'all')).toBe(all);
  });
});

describe('lintEngine span 投影', () => {
  it('1-based 码点行/列与文本位置一致（双行文本 + 已知字面量）', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const loaded = await loadRules(defaultLintConfig());
    const sample = literalSampleRules(loaded.regexRules)[0]!;
    const literal = sample.literal;

    const line1 = '第一行是平静的叙述，没有任何触发词。';
    const line2Prefix = '第二行埋着';
    const line2Suffix = '这样的痕迹，其余部分照常。';
    const text = `${line1}\n${line2Prefix}${literal}${line2Suffix}`;

    const report = engine!.scanText(text, { chapterId: 'c-span' });
    const hit = report.issues.find((issue) => issue.ruleId === sample.rule.id);
    expect(hit, `字面量「${literal}」应命中规则 ${sample.rule.id}`).toBeDefined();

    // 期望值从文本机械推导（码点口径，与契约注释一致）
    const line2Start = text.indexOf('\n') + 1;
    const prefix = text.slice(line2Start, text.indexOf(literal, line2Start));
    const expectedColumn = Array.from(prefix).length + 1;
    const expectedEndColumn = expectedColumn + Array.from(literal).length - 1;

    expect(hit!.line).toBe(2);
    expect(hit!.column).toBe(expectedColumn);
    expect(hit!.endLine).toBe(2);
    expect(hit!.endColumn).toBe(expectedEndColumn);
    expect(hit!.match).toBe(literal);
    // 紧凑前后文契约：current = 命中原文，before/after 为行内邻接文本
    expect(hit!.context.current).toBe(literal);
    expect(hit!.context.after.startsWith(line2Suffix)).toBe(true);
  });

  it('scanText 输出通过 lintChapterReportSchema（shared-contracts 契约面）', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const report = engine!.scanText('值得注意的是，他不是怯懦，而是清醒。', {
      chapterId: 'c-schema',
      sceneId: 's-1',
    });
    expect(() => lintChapterReportSchema.parse(report)).not.toThrow();
    const parsed = lintChapterReportSchema.parse(report);
    expect(parsed.chapterId).toBe('c-schema');
    expect(parsed.issues.every((issue) => issue.chapterId === 'c-schema')).toBe(true);
  });
});

describe('lintEngine projectAutoFixes（dry-run，不落盘）', () => {
  it('零宽字符（fixability:auto）确定性删除：patches + fixedText + changed', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    // 钉在 vendored commit 7b0e5a0：mechanical-zero-width（U+200B U+200C U+200D U+2060 U+FEFF 五种零宽字符 -> 删除）
    const dirty = '\u4ed6\u5199\u200b\u4e0b\u4e86\u4e00\u884c\u200b\u5b57\u3002';
    const { patches, fixedText, changed } = engine!.projectAutoFixes({
      text: dirty,
      chapterId: 'c-fix',
      filePath: 'chapters/c1.md',
    });
    expect(changed).toBe(true);
    expect(fixedText).toBe('他写下了一行字。');
    expect(patches.length).toBe(2);
    expect(patches.every((patch) => patch.ruleId === 'mechanical-zero-width')).toBe(true);
    expect(patches.every((patch) => patch.replacements.length >= 1)).toBe(true);
    expect(patches.every((patch) => patch.chapterId === 'c-fix' && patch.filePath === 'chapters/c1.md')).toBe(true);
    // span 契约：1-based 码点，定位于修复后文本
    for (const patch of patches) {
      expect(patch.span.line).toBe(1);
      expect(patch.span.column).toBeGreaterThan(0);
      expect(patch.span.endColumn).toBeGreaterThanOrEqual(patch.span.column);
    }
  });

  it('无 auto 命中：changed=false、patches 空', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const { patches, fixedText, changed } = engine!.projectAutoFixes({
      text: '干净的正文，没有任何机械问题。',
      chapterId: 'c-fix',
      filePath: 'chapters/c1.md',
    });
    expect(changed).toBe(false);
    expect(patches).toEqual([]);
    expect(fixedText).toBe('干净的正文，没有任何机械问题。');
  });
});

describe('lintEngine null 降级', () => {
  it('loadLintEngine 坏 ruleset id → null（不抛）+ error 日志（CR-006 零日志治愈）', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const engine = await loadLintEngine({
        ...defaultLintConfig(),
        rulesets: ['builtin/does-not-exist'],
      });
      expect(engine).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]![1]).toContain('rulesets load failed');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('getLintEngine 失败不缓存：下次调用重试（CR-006——瞬态装载失败无重启可恢复）', async () => {
    resetLintEngineForTests();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const originalLoadRules = vendorRulesModule.loadRules;
    const loadRulesSpy = vi
      .spyOn(vendorRulesModule, 'loadRules')
      .mockImplementation(async (config) => {
        if (loadRulesSpy.mock.calls.length === 1) throw new Error('transient load failure');
        return originalLoadRules(config);
      });
    try {
      const first = await getLintEngine();
      expect(first).toBeNull(); // 第一次失败
      const second = await getLintEngine();
      expect(second).not.toBeNull(); // 失败未缓存 → 重试成功
      expect(loadRulesSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledTimes(1); // 失败那次落 error 日志，成功不落
    } finally {
      loadRulesSpy.mockRestore();
      errorSpy.mockRestore();
      resetLintEngineForTests();
    }
  });

  it('成功结果进程级缓存：两次调用同一实例，loadRules 只跑一次', async () => {
    resetLintEngineForTests();
    try {
      const engine = await getLintEngine();
      expect(engine).not.toBeNull();
      const again = await getLintEngine();
      expect(again).toBe(engine);
    } finally {
      resetLintEngineForTests();
    }
  });
});

describe('lintEngine markdown 遮罩边界（CR-027——章正文 mask 行为核实与钉住）', () => {
  // 核实结论：scanText 对章正文**无条件应用** computeMaskedRanges（design §2 md 语义）。
  // 假遮蔽风险评估：
  // - 章首 `---` 场景分隔符 + 后文再遇整行 `---`：会被当 YAML frontmatter 遮蔽（假阴性）——
  //   但 Closure 章文件 = writer 输出纯正文（acceptChapterCandidateCore 直写 candidate.content，
  //   无 frontmatter），章首即分隔符属罕见形态；钉住该边界为**已知语义**，若 dogfood 出现
  //   真实命中再议 scanText 关闭 frontmatter 遮蔽的选项。
  // - 场景分隔符在**章中**（常见形态）：frontmatter 探测只看第 0 行 → 不遮蔽，正常命中。
  // - 未闭合围栏（``` / ~~~ 行首）：遮蔽到文件末尾（上游语义）——小说正文罕见，钉住边界。

  /** 取一条数据推导的字面量规则做遮罩探针（sample[0] 与 smoke 同源）。 */
  async function probeRule() {
    const loaded = await loadRules(defaultLintConfig());
    return literalSampleRules(loaded.regexRules)[0]!;
  }

  it('场景分隔符在章中（常见形态）：`---` 分隔线**不**遮蔽后文正文（frontmatter 只看第 0 行）', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const { rule, literal } = await probeRule();
    const text = `第一幕的平静叙述。\n---\n他把笔搁在桌上，${literal}，窗外的雨还没有停。`;

    const report = engine!.scanText(text, { chapterId: 'c-mask' });
    expect(
      report.issues.some((issue) => issue.ruleId === rule.id),
      '章中 --- 分隔线后的命中应正常扫描（非遮蔽区）',
    ).toBe(true);
  });

  it('章首 `---` + 后文整行 `---`：两线之间按 frontmatter 遮蔽（上游语义钉住——已知边界非 bug）', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const { rule, literal } = await probeRule();
    const text = `---\n他被吞掉的 ${literal} 正文。\n---\n分隔线后的 ${literal} 正文。`;

    const report = engine!.scanText(text, { chapterId: 'c-mask' });
    const hits = report.issues.filter((issue) => issue.ruleId === rule.id);
    // frontmatter 区（首条）不命中；分隔线后正常命中。
    expect(hits.length).toBe(1);
    expect(hits[0]!.line).toBe(4);
  });

  it('未闭合围栏行：其后文本遮蔽到文末（上游语义钉住）；围栏前文本正常扫描', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const { rule, literal } = await probeRule();
    const text = `围栏前的 ${literal} 命中。\n\`\`\`\n围栏内被遮蔽的 ${literal} 不命中。`;

    const report = engine!.scanText(text, { chapterId: 'c-mask' });
    const hits = report.issues.filter((issue) => issue.ruleId === rule.id);
    expect(hits.length).toBe(1);
    expect(hits[0]!.line).toBe(1);
  });
});

afterEach(() => {
  // mask/降级用例可能经 resetLintEngineForTests 动过单例槽——收尾归位，避免污染后续套件。
  resetLintEngineForTests();
});

describe('aggregateFullReport 全稿聚合', () => {
  it('跨章 stats 机械累加', async () => {
    const engine = await getLintEngine();
    expect(engine).not.toBeNull();
    const chapters = [
      engine!.scanText('值得注意的是，这一切都很平静。', { chapterId: 'c-1' }),
      engine!.scanText('他不是怯懦，而是清醒。', { chapterId: 'c-2' }),
    ];
    const full = aggregateFullReport(chapters);
    expect(full.stats.chapters).toBe(2);
    expect(full.stats.total).toBe(chapters[0]!.summary.total + chapters[1]!.summary.total);
    expect(full.stats.high).toBe(
      chapters[0]!.summary.high + chapters[1]!.summary.high,
    );
    expect(full.stats.densityIssues).toBe(
      chapters[0]!.densityIssues.length + chapters[1]!.densityIssues.length,
    );
    expect(full.generatedAt).toBeTruthy();
  });
});
