import { describe, expect, it } from 'vitest';
import {
  assembleChapterChainArtifacts,
  buildCompileReport,
  buildStoryPlanSegment,
  COMPILE_IRON_BRIEF_SEGMENTS,
  COMPILE_L1_SNAPSHOT_SUBJECT_CAP,
  COMPILE_L2_MOVE_ORDER,
  DEFAULT_COMPILE_THRESHOLDS,
  estimateBriefSegments,
  estimateSettingsSegments,
  estimateTextTokens,
  judgeCompileTier,
  readSettingsCompileSegments,
  selectScenesForEpisode,
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  type ChapterBrief,
  type ChapterChainProjectInput,
  type CompileReportSegment,
} from '../src';
import { compileReportSchema } from '../src';

// ── Story 8.4 B1/B2（design §2.1/§2.2）：热层度量 + 三级降级梯（纯函数核心）──
//
// 铁律红线（用户两次拍板）：阈值 = 机械异常量级（bug 保险丝），正常写作永不触发；骨架段
// （goal/信息控制/禁写/情绪目标）+ 全书目录 + 可查指针永不裁——每档位断言钉死。

/** 小阈值（参数化验档——纯函数收 CompileThresholds，测试收窄免造 96K token 串）。 */
const SMALL_TH = { warn: 100, move: 200, hard: 300 } as const;

/** 构造带 N 个 subject 的 stateAtT snapshot（WorldStateSnapshot 形态）。 */
function snapshotWithSubjects(count: number): { at: number; subjects: unknown[] } {
  return {
    at: 1,
    subjects: Array.from({ length: count }, (_, i) => ({
      subjectId: `subj-${i}`,
      state: { status: '在场' },
      issueCount: 0,
    })),
  };
}

/** 段名 → token 估算的 Map（断言辅助）。 */
function estimateMap(segments: readonly CompileReportSegment[]): Map<string, number> {
  return new Map(segments.map((s) => [s.name, s.token_estimate]));
}

/** 铁律集断言：降级前后铁律段 token 估算逐一不变（永不裁，AC-8）。 */
function expectIronSegmentsUnchanged(before: readonly CompileReportSegment[], after: readonly CompileReportSegment[]): void {
  const beforeMap = estimateMap(before);
  const afterMap = estimateMap(after);
  for (const name of COMPILE_IRON_BRIEF_SEGMENTS) {
    if (!beforeMap.has(name)) continue; // 段缺（fixture 未填）无从谈裁
    expect(afterMap.get(name)).toBe(beforeMap.get(name));
  }
}

describe('estimateTextTokens（token 估算单源）', () => {
  it('字符启发式 ceil(len/3.5)；空串 → 0', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('abc')).toBe(1); // ceil(3/3.5)=1
    expect(estimateTextTokens('abcdefg')).toBe(2); // ceil(7/3.5)=2
    expect(estimateTextTokens('设定'.repeat(7))).toBe(4); // 14 字符 → ceil(14/3.5)=4
  });

  it('单源常量与既有导出一致（world-state-reduce CHAPTER_SUMMARY_CHARS_PER_TOKEN 同值）', async () => {
    const { CHAPTER_SUMMARY_CHARS_PER_TOKEN } = await import('../src/contracts/world-state-reduce');
    expect(TOKEN_ESTIMATE_CHARS_PER_TOKEN).toBe(3.5);
    expect(CHAPTER_SUMMARY_CHARS_PER_TOKEN).toBe(TOKEN_ESTIMATE_CHARS_PER_TOKEN);
  });
});

describe('阈值 + 判档（机械异常量级 = bug 保险丝）', () => {
  it('缺省阈值导出（宽松初值，校准点 dogfood）', () => {
    expect(DEFAULT_COMPILE_THRESHOLDS.warn).toBe(64_000);
    expect(DEFAULT_COMPILE_THRESHOLDS.move).toBe(96_000);
    expect(DEFAULT_COMPILE_THRESHOLDS.hard).toBe(128_000);
    expect(DEFAULT_COMPILE_THRESHOLDS.warn).toBeLessThan(DEFAULT_COMPILE_THRESHOLDS.move);
    expect(DEFAULT_COMPILE_THRESHOLDS.move).toBeLessThan(DEFAULT_COMPILE_THRESHOLDS.hard);
  });

  it('判档边界（参数化）：warn-1→L0 / warn→L1 / move-1→L1 / move→L2', () => {
    expect(judgeCompileTier(99, SMALL_TH)).toBe('L0');
    expect(judgeCompileTier(100, SMALL_TH)).toBe('L1');
    expect(judgeCompileTier(199, SMALL_TH)).toBe('L1');
    expect(judgeCompileTier(200, SMALL_TH)).toBe('L2');
    expect(judgeCompileTier(10_000, SMALL_TH)).toBe('L2');
  });

  it('降级梯与铁律集零交集（机械保证：LLM 意图段一件不进梯）', () => {
    for (const name of COMPILE_L2_MOVE_ORDER) {
      expect(COMPILE_IRON_BRIEF_SEGMENTS).not.toContain(name);
    }
  });
});

describe('estimateBriefSegments（brief 侧段估算）', () => {
  it('段分组正确：plotPoints 拆 plot_points / plot_points_state 两段，全 undefined 段不产条目', () => {
    const brief: ChapterBrief = {
      goal: '抵达B城', // 8 字符
      mustHide: '密道',
      plotPoints: [
        { sceneId: 's1', continuity: '本章内', stateAtT: snapshotWithSubjects(2) },
        { sceneId: 's2' },
      ],
      readiness: 'ready',
    };
    const segments = estimateBriefSegments(brief);
    const map = estimateMap(segments);
    // goal 段 = [goal] 序列化（无 ending）
    expect(map.get('goal')).toBe(estimateTextTokens(JSON.stringify([brief.goal])));
    expect(map.get('info_control')).toBe(estimateTextTokens(JSON.stringify([brief.mustHide])));
    // plot_points = stateAtT 剥除后的场列表
    expect(map.get('plot_points')).toBe(
      estimateTextTokens(JSON.stringify([{ sceneId: 's1', continuity: '本章内' }, { sceneId: 's2' }])),
    );
    // plot_points_state = 各场 stateAtT 序列化
    expect(map.get('plot_points_state')).toBe(
      estimateTextTokens(JSON.stringify([brief.plotPoints?.[0].stateAtT, undefined])),
    );
    // 未填段不产条目
    expect([...map.keys()]).not.toContain('promise_tasks');
    expect([...map.keys()]).not.toContain('params');
  });

  it('stateAtT 全缺 → 不产 plot_points_state 段', () => {
    const segments = estimateBriefSegments({ plotPoints: [{ sceneId: 's1' }] });
    expect(estimateMap(segments).has('plot_points_state')).toBe(false);
    expect(estimateMap(segments).has('plot_points')).toBe(true);
  });
});

describe('estimateSettingsSegments + assemble 携带（settings 侧编译点）', () => {
  it('逐 prefix item 一段，name = settings:<label>，估算基 = 渲染文本', () => {
    const items = [
      { label: '设定目录', content: '一行', priority: 100, type: 'custom' as const },
      { label: '世界设定', content: '两行', priority: 90, type: 'custom' as const },
    ];
    const segments = estimateSettingsSegments(items);
    expect(segments).toEqual([
      { name: 'settings:设定目录', token_estimate: estimateTextTokens('设定目录：\n一行') },
      { name: 'settings:世界设定', token_estimate: estimateTextTokens('世界设定：\n两行') },
    ]);
  });

  it('assembleChapterChainArtifacts 产 settings_context_report artifact（两编译点之一，不判总额）', () => {
    const artifacts = assembleChapterChainArtifacts(
      {
        creative_brief: { genre: '都市奇幻' } as ChapterChainProjectInput['creative_brief'],
        world_setting: { premise: '灵气复苏' } as ChapterChainProjectInput['world_setting'],
        asset_cards: [],
      },
      'ep1',
    );
    const report = artifacts['settings_context_report'] as CompileReportSegment[];
    expect(Array.isArray(report)).toBe(true);
    expect(report.some((s) => s.name === 'settings:世界设定')).toBe(true);
    expect(report.some((s) => s.name === 'settings:创作 Brief 核心设定')).toBe(true);
  });

  it('readSettingsCompileSegments：好条目保留 / 坏条目丢 / 非数组 → []（per-element 守卫）', () => {
    expect(readSettingsCompileSegments(undefined)).toEqual([]);
    expect(readSettingsCompileSegments('bad')).toEqual([]);
    expect(readSettingsCompileSegments(null)).toEqual([]);
    const good: CompileReportSegment[] = [
      { name: 'settings:设定目录', token_estimate: 42 },
      { name: 'bad', token_estimate: -1 },
      { name: '', token_estimate: 1 },
      { token_estimate: 1 } as unknown as CompileReportSegment,
    ];
    expect(readSettingsCompileSegments(good)).toEqual([{ name: 'settings:设定目录', token_estimate: 42 }]);
  });
});

describe('buildCompileReport — L0 正常（仅度量报告）', () => {
  it('total < warn → brief 同引用返回（产物逐字节相同）、无 degraded、overloaded=false、报告过 schema', () => {
    const brief: ChapterBrief = {
      goal: '主角进城',
      plotPoints: [{ sceneId: 's1', stateAtT: snapshotWithSubjects(3) }],
      readiness: 'ready',
    };
    const settings: CompileReportSegment[] = [{ name: 'settings:设定目录', token_estimate: 50 }];
    const out = buildCompileReport(brief, settings);
    expect(out.tier).toBe('L0');
    expect(out.brief).toBe(brief); // 同引用——零回归锚
    expect(out.report.degraded).toBeUndefined();
    expect(out.report.overloaded).toBe(false);
    expect(out.report.total).toBe(50 + sumOf(estimateBriefSegments(brief)));
    expect(compileReportSchema.safeParse(out.report).success).toBe(true);
  });

  it('两侧段全空 → 占位段（schema segments .min(1) 守恒）', () => {
    const out = buildCompileReport({}, []);
    expect(out.report.segments).toEqual([{ name: 'brief', token_estimate: 0 }]);
    expect(compileReportSchema.safeParse(out.report).success).toBe(true);
  });
});

describe('buildCompileReport — L1 压缩（stateAtT 主体收窄）', () => {
  it('参数收窄生效：subjects 12 → 6（first-seen 序 slice），降级记录，铁律段不动', () => {
    const brief: ChapterBrief = {
      goal: '主角进城',
      mustHide: '密道',
      plotPoints: [{ sceneId: 's1', stateAtT: snapshotWithSubjects(12) }],
      readiness: 'ready',
    };
    const before = estimateBriefSegments(brief);
    // 阈值区间卡在 fixture 总量（~几百 tokens）之上方：warn=50 < total < move=5000 → L1。
    const out = buildCompileReport(brief, [], { warn: 50, move: 5000, hard: 10_000 });
    expect(out.tier).toBe('L1');
    const state = (out.brief.plotPoints?.[0].stateAtT as { subjects: unknown[] }).subjects;
    expect(state).toHaveLength(COMPILE_L1_SNAPSHOT_SUBJECT_CAP);
    expect((state[0] as { subjectId: string }).subjectId).toBe('subj-0'); // first-seen 序保留
    expect(out.report.degraded).toBeDefined();
    expect(out.report.degraded!.some((d) => d.segment === 'plot_points_state' && d.action.includes('L1 压缩'))).toBe(true);
    expectIronSegmentsUnchanged(before, out.report.segments);
  });

  it('真实初值触发（构造超载 fixture，默认阈值）：stateAtT 膨胀 > 64K tokens → L1 熔断', () => {
    // 20 场 × 12 subject × 1200 字符 state ≈ 288K 字符 ≈ 82K tokens > TH_WARN(64K)，< TH_MOVE(96K)。
    const fatState = { at: 1, subjects: Array.from({ length: 12 }, (_, i) => ({
      subjectId: `subj-${i}`,
      state: { status: '设'.repeat(1200) },
      issueCount: 0,
    })) };
    const brief: ChapterBrief = {
      goal: '主角进城',
      plotPoints: Array.from({ length: 20 }, (_, i) => ({ sceneId: `s${i}`, stateAtT: fatState })),
      readiness: 'ready',
    };
    const out = buildCompileReport(brief, []);
    expect(out.tier).toBe('L1');
    expect(out.report.degraded).toBeDefined();
    for (const p of out.brief.plotPoints ?? []) {
      expect((p.stateAtT as { subjects: unknown[] }).subjects).toHaveLength(COMPILE_L1_SNAPSHOT_SUBJECT_CAP);
    }
  });

  it('非 snapshot 形态 stateAtT 不动（不猜结构）', () => {
    const brief: ChapterBrief = { plotPoints: [{ sceneId: 's1', stateAtT: '自由文本' as unknown }] };
    const out = buildCompileReport(brief, [], { warn: 1, move: 5000, hard: 10_000 });
    expect(out.brief.plotPoints?.[0].stateAtT).toBe('自由文本');
  });

  // ── R2-盲1（2026-08-19）：L1/L2 触发但零降级动作可做 → degraded 不落空 []（schema .min(1) 自违）──

  it('R2-盲1：L1 触发但无可裁（各场 subjects ≤ cap）→ 报告无 degraded 字段 + schema 过（设定侧撑起 L1 档）', () => {
    // brief 侧小（stateAtT subjects 2 < cap 6 无可收窄）+ settings 段撑进 L1 区间（100 ≤ total < 200）。
    const brief: ChapterBrief = {
      goal: '主角进城',
      plotPoints: [{ sceneId: 's1', stateAtT: snapshotWithSubjects(2) }], // ≤ cap → trimmed=false 零动作
      readiness: 'ready',
    };
    const settings: CompileReportSegment[] = [{ name: 'settings:设定目录', token_estimate: 100 }];
    const out = buildCompileReport(brief, settings, { ...SMALL_TH });
    expect(out.tier).toBe('L1');
    expect(out.brief).toBe(brief); // 零降级动作——brief 同引用
    // 核心断言：无降级动作不写字段（undefined 而非 []——空数组违 schema .min(1)，safeParse 会拒收整份报告）。
    expect(out.report.degraded).toBeUndefined();
    expect('degraded' in out.report).toBe(false);
    expect(compileReportSchema.safeParse(out.report).success).toBe(true);
  });
});

describe('buildCompileReport — L2 移出（低优段 → 可查指针）', () => {
  /** L2 fixture：goal 铁律 + plot_points_state 小 + promise_tasks 大 + open_decisions 中。 */
  function l2Brief(): ChapterBrief {
    return {
      goal: '主角进城',
      mustHide: '密道',
      plotPoints: [{ sceneId: 's1', stateAtT: snapshotWithSubjects(2) }],
      promiseTasks: [{
        promiseId: 'p1', title: '国王的佩剑', summary: '壁上佩剑将在终章出鞘。'.repeat(150), beatKind: 'plant', sceneRef: 's1',
      }],
      openDecisions: [{ id: 'd1', summary: '路线未定', risk: '剧情分叉' }],
      readiness: 'ready',
    };
  }

  it('梯序 sequential：plot_points_state 先移，promise_tasks 次移至 projected < move；后续段保留', () => {
    const brief = l2Brief();
    const before = estimateBriefSegments(brief);
    const out = buildCompileReport(brief, [], { ...SMALL_TH });
    expect(out.tier).toBe('L2');
    // 两段已移（内容裁剪，字段消失）
    expect(out.brief.plotPoints?.[0].stateAtT).toBeUndefined();
    expect(out.brief.promiseTasks).toBeUndefined();
    // 未越线的后续段保留
    expect(out.brief.openDecisions).toBeDefined();
    expect(out.brief.plotPoints).toBeDefined();
    // 降级记录携可查指针文案（design §2.2「想查用 query_story」）
    const actions = (out.report.degraded ?? []).map((d) => `${d.segment}:${d.action}`);
    expect(actions.some((a) => a.startsWith('plot_points_state:') && a.includes('query_story'))).toBe(true);
    expect(actions.some((a) => a.startsWith('promise_tasks:') && a.includes('query_story'))).toBe(true);
    // 铁律段估算不变（每档位断言）
    expectIronSegmentsUnchanged(before, out.report.segments);
    // overloaded：finalTotal（goal+plotPoints+openDecisions 小）< hard → false
    expect(out.report.overloaded).toBe(false);
  });

  it('真实初值触发（默认阈值）：stateAtT 膨胀 > 96K tokens → L2 移出 plot_points_state', () => {
    // 25 场 × 12 × 1200 字符 ≈ 360K 字符 ≈ 103K tokens > TH_MOVE(96K) → L2；plot_points_state 居梯首被移。
    const fatState = { at: 1, subjects: Array.from({ length: 12 }, (_, i) => ({
      subjectId: `subj-${i}`,
      state: { status: '设'.repeat(1200) },
      issueCount: 0,
    })) };
    const brief: ChapterBrief = {
      goal: '主角进城',
      plotPoints: Array.from({ length: 25 }, (_, i) => ({ sceneId: `s${i}`, stateAtT: fatState })),
      readiness: 'ready',
    };
    const out = buildCompileReport(brief, []);
    expect(out.tier).toBe('L2');
    expect(out.brief.plotPoints?.every((p) => p.stateAtT === undefined)).toBe(true);
    expect(out.report.overloaded).toBe(false); // 移出后残量远低于 TH_HARD
  });

  it('L2 移空梯后仍超 hard → overloaded=true（L3 复杂场景标记）；铁律段仍不动', () => {
    // settings 侧膨胀（设定侧无降级动作——铁律目录/指针 + 整体骨架）→ 移空梯残量仍 > hard。
    const brief = l2Brief();
    const settings: CompileReportSegment[] = [{ name: 'settings:设定目录', token_estimate: 500 }];
    const before = estimateBriefSegments(brief);
    const out = buildCompileReport(brief, settings, { ...SMALL_TH });
    expect(out.tier).toBe('L2');
    // 梯耗尽：settings 500 ≥ move 200，projected 永不 < move → 全梯移空
    expect(out.brief.plotPoints).toBeUndefined();
    expect(out.brief.openDecisions).toBeUndefined();
    expect(out.report.overloaded).toBe(true);
    expectIronSegmentsUnchanged(before, out.report.segments);
    expect(compileReportSchema.safeParse(out.report).success).toBe(true);
  });

  it('R2-盲1：L2 触发但梯段全 miss（无可移）→ 无 degraded 字段 + schema 过 + overloaded=true（L3 文案链前提）', () => {
    // brief 只剩铁律段（goal）——L2 移出梯六段全不在；settings 膨胀撑过 move + hard → 梯耗尽**零动作**仍超载。
    // 修复前 degraded=[] 违 .min(1) → safeParse 拒收整份报告 → summarize 丢 compileReport → L3 文案永不渲染。
    const brief: ChapterBrief = { goal: '主角进城', readiness: 'ready' };
    const settings: CompileReportSegment[] = [{ name: 'settings:设定目录', token_estimate: 500 }];
    const out = buildCompileReport(brief, settings, { ...SMALL_TH });
    expect(out.tier).toBe('L2');
    expect(out.brief).toBe(brief); // 梯全 miss——brief 同引用（零移出）
    expect(out.report.degraded).toBeUndefined();
    expect('degraded' in out.report).toBe(false);
    expect(out.report.overloaded).toBe(true);
    expect(compileReportSchema.safeParse(out.report).success).toBe(true);
  });

  it('真实初值 L3（构造超载 fixture）：goal 铁律串 > TH_HARD + stateAtT 膨胀 → 移空梯仍 overloaded', () => {
    // goal（铁律，永不裁）135K tokens + plot_points_state 103K tokens → L2 移空梯后残量 ~135K > 128K。
    const fatState = { at: 1, subjects: Array.from({ length: 12 }, (_, i) => ({
      subjectId: `subj-${i}`,
      state: { status: '设'.repeat(1200) },
      issueCount: 0,
    })) };
    const brief: ChapterBrief = {
      goal: '目'.repeat(473_000), // 473K 字符 ≈ 135K tokens（铁律——降级不许碰）
      plotPoints: Array.from({ length: 25 }, (_, i) => ({ sceneId: `s${i}`, stateAtT: fatState })),
      readiness: 'ready',
    };
    const out = buildCompileReport(brief, []);
    expect(out.tier).toBe('L2');
    expect(out.brief.goal).toBe(brief.goal); // 铁律段内容零变
    expect(out.report.overloaded).toBe(true);
    expect(out.report.degraded?.length).toBeGreaterThan(0);
  });
});

/** 段求和（断言辅助）。 */
function sumOf(segments: readonly CompileReportSegment[]): number {
  return segments.reduce((acc, s) => acc + s.token_estimate, 0);
}

// ── R2-盲5（2026-08-19）：story_plan 段（写手稳定前缀第三块 {{storyPlan}}）进计量 ──

describe('buildStoryPlanSegment — storyPlan 注入通道计量（R2-盲5）', () => {
  const sceneGraph = {
    nodes: [
      { id: 's1', lineTags: [], storyTime: 30, presentationOrder: { chapter: 2, pos: 0 }, episodeId: 'ep-12' },
      { id: 's2', lineTags: [], storyTime: 31, presentationOrder: { chapter: 2, pos: 1 }, episodeId: 'ep-12' },
      { id: 's3', lineTags: [], storyTime: 45, presentationOrder: { chapter: 3, pos: 0 }, episodeId: 'ep-13' },
    ],
    edges: [],
    lines: [],
  } as unknown as Parameters<typeof buildStoryPlanSegment>[0];

  it('与 buildDraftWriterVars 渲染同源：JSON.stringify(selectScenesForEpisode(...)) 的 token 估算', () => {
    const segment = buildStoryPlanSegment(sceneGraph, 'ep-12');
    expect(segment.name).toBe('story_plan');
    expect(segment.token_estimate).toBe(
      estimateTextTokens(JSON.stringify(selectScenesForEpisode(sceneGraph, 'ep-12'))),
    );
  });

  it('场元数据膨胀（storyTimeLabel 机械膨胀）→ token 估算随之增大（保险丝对该通道不再失明）', () => {
    const fatLabel = '夜'.repeat(3500); // 3500 字符 ≈ 1000 tokens
    const fat = {
      nodes: [{ id: 's1', lineTags: [], storyTime: 30, storyTimeLabel: fatLabel, presentationOrder: { chapter: 2, pos: 0 }, episodeId: 'ep-12' }],
      edges: [],
      lines: [],
    } as unknown as Parameters<typeof buildStoryPlanSegment>[0];
    const segment = buildStoryPlanSegment(fat, 'ep-12');
    expect(segment.token_estimate).toBeGreaterThanOrEqual(1000); // 膨胀进段估算（进 total 由 buildCompileReport 汇总）
    // total 含它：buildCompileReport 汇总侧（段并进 settings 槽位传入——brief-compiler 装配形态）。
    const out = buildCompileReport({ goal: '主角进城' }, [segment]);
    expect(out.report.total).toBeGreaterThanOrEqual(segment.token_estimate);
  });

  it('scene_graph 缺 / 本章无场 → "[]" 估算（空投影也占稳定前缀字节，如实计量非造假）', () => {
    expect(buildStoryPlanSegment(undefined, 'ep-12').token_estimate).toBe(estimateTextTokens('[]'));
    expect(buildStoryPlanSegment(sceneGraph, 'ep-none').token_estimate).toBe(estimateTextTokens('[]'));
  });
});
