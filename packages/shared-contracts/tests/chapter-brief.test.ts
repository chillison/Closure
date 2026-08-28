import { describe, expect, it } from 'vitest';
import {
  chapterBriefSchema,
  briefPlotPointSchema,
  briefEmotionTargetSchema,
  briefCharacterProgressionSchema,
  briefReadinessSchema,
  computeReadiness,
  assertBriefReady,
  BriefNotReadyError,
  BRIEF_READINESS_GAP,
  sceneNodeSchema,
  type ChapterBrief,
  type BriefReadiness,
  type SceneGraph,
  type SceneNode,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §3 / design §3：ChapterBrief 10 段 schema（全 optional）。
// 纯 Zod schema -> plain vitest（无 fs/db/LLM）。覆盖 design §3 决断：
// - 全 optional 容忍（空对象 pass）
// - 部分填 4.0 有源 7 段 pass（#1-5,10 LLM 段 + #6 纯代码段）
// - #7/#8 留空 optional（不造假数据源未建段）
// - parse round-trip 确定性
// ─────────────────────────────────────────────────────────────────────────────

describe('chapterBriefSchema（Story 4.0 10 段全 optional 容忍）', () => {
  it('空对象 pass（全 optional）', () => {
    const r = chapterBriefSchema.parse({});
    expect(r).toEqual({});
  });

  it('undefined 显式传入亦合法（每段 optional）', () => {
    const r = chapterBriefSchema.parse({
      goal: undefined,
      plotPoints: undefined,
      emotionTarget: undefined,
    });
    expect(r).toEqual({});
  });

  it('字段全 optional：单独填任一段合法（零 migration，不要求组合）', () => {
    expect(chapterBriefSchema.parse({ goal: 'g' }).goal).toBe('g');
    expect(chapterBriefSchema.parse({ doNotWrite: '禁杀人' }).doNotWrite).toBe('禁杀人');
    expect(chapterBriefSchema.parse({ tone: '冷峻' }).tone).toBe('冷峻');
    expect(chapterBriefSchema.parse({ nextHook: '一道剑光' }).nextHook).toBe('一道剑光');
  });
});

describe('chapterBriefSchema（4.0 有源 7 段部分填充——design §3 决断）', () => {
  it('填 #1-5,10 LLM 段 + #6 纯代码段：parse 后等价（round-trip）', () => {
    const brief: ChapterBrief = {
      // #1 目标/落点
      goal: '主角突破筑基',
      ending: '雷光中少年踏碎虚空',
      // #2 参数
      pov: '主角第三人称限知',
      tone: '热血冷峻',
      // #3 信息控制（charter #1）
      readerKnows: '读者知道反派出底牌',
      protagonistKnows: '主角不知反派埋伏',
      mustHide: '主角金手指来源',
      hintOnly: '祖符前任持有者身份',
      // #4 节奏/下章牵引
      pacing: '推进',
      opening: '雨夜山门',
      nextHook: '一道剑光破空',
      // #5 禁写
      doNotWrite: '主角直接秒杀反派',
      // #6 关键剧情点（M:N-aware，纯代码段 from scene_graph）
      plotPoints: [
        { sceneId: 'sc_1', continuity: '本章开始（从上章雨夜续）' },
        { sceneId: 'sc_2', continuity: '续到下章：剑光来客' },
      ],
      // #10 情绪目标（charter #2，Closure 独有）
      emotionTarget: {
        emotion: '振奋',
        emotionEnd: '爆发',
        vad: { v: 0.6, a: 0.7, d: 0.3 },
        steer: '用短句加速节奏，结尾留白',
      },
    };
    const parsed = chapterBriefSchema.parse(brief);
    expect(parsed).toEqual(brief);
  });

  it('parse round-trip 确定性：parse 输出再 parse 等价', () => {
    const brief = {
      goal: 'x',
      pov: 'y',
      plotPoints: [{ sceneId: 's', continuity: 'c' }],
      emotionTarget: { emotion: '低落', emotionEnd: '高昂' },
    };
    const once = chapterBriefSchema.parse(brief);
    const twice = chapterBriefSchema.parse(once);
    expect(twice).toEqual(once);
  });

  it('4.0 仅填 7 段（#7/#8 undefined）：parse 输出不含这两段（不造假）', () => {
    const brief = chapterBriefSchema.parse({
      goal: 'g',
      plotPoints: [{ sceneId: 's' }],
      emotionTarget: { emotion: '振奋' },
    });
    expect(brief.promiseTasks).toBeUndefined();
    expect(brief.openDecisions).toBeUndefined();
  });
});

describe('chapterBriefSchema（#7 typed 6.5 / #8 已收紧 4.1 Step 3）', () => {
  it('#7 promiseTasks typed shape（6.5 briefPromiseTaskSchema：promiseId/title/summary/beatKind/sceneRef 必填）', () => {
    const r = chapterBriefSchema.parse({
      promiseTasks: [{
        promiseId: 'p1',
        title: '剑挂墙上',
        summary: '契诃夫之枪：墙上古剑应在后续被取下使用',
        beatKind: 'plant',
        sceneRef: 'sc_1',
      }],
    });
    expect(r.promiseTasks).toEqual([{
      promiseId: 'p1',
      title: '剑挂墙上',
      summary: '契诃夫之枪：墙上古剑应在后续被取下使用',
      beatKind: 'plant',
      sceneRef: 'sc_1',
    }]);
  });

  it('#7 promiseTasks 缺必填（promiseId/beatKind/sceneRef）→ reject（typed 后不再接任意结构）', () => {
    expect(() =>
      chapterBriefSchema.parse({
        promiseTasks: [{ beat: 'plant', target: '剑挂墙上', sceneId: 'sc_1' }], // 旧 unknown 形态 → reject
      }),
    ).toThrow();
  });

  it('#8 openDecisions 收紧 shape（4.1 Step 3：storyDecisionSchema.pick {id,summary,risk}）', () => {
    const r = chapterBriefSchema.parse({
      openDecisions: [
        { id: 'd1', summary: '角色 A 此处偏离设定——OOC 还是目标转折？', risk: '若非目标转折则 OOC 出戏' },
      ],
    });
    expect(r.openDecisions).toEqual([
      { id: 'd1', summary: '角色 A 此处偏离设定——OOC 还是目标转折？', risk: '若非目标转折则 OOC 出戏' },
    ]);
  });

  it('#8 openDecisions 收紧后：缺 risk → reject（不再接任意 unknown）', () => {
    expect(() =>
      chapterBriefSchema.parse({
        openDecisions: [{ id: 'd1', summary: '问' }], // 缺 risk（pick 必填）
      }),
    ).toThrow();
  });

  it('#8 openDecisions 收紧后：旧 unknown-only 形态（无 summary/risk）→ reject', () => {
    expect(() =>
      chapterBriefSchema.parse({
        openDecisions: [{ id: 'd1', question: '主角是否杀反派', status: 'open' }],
      }),
    ).toThrow();
  });

  it('两段同时留空（undefined）合法——4.0 默认形态', () => {
    const r = chapterBriefSchema.parse({ promiseTasks: undefined, openDecisions: undefined });
    expect(r).toEqual({});
  });
});

describe('briefPlotPointSchema（#6 plotPoint 形态）', () => {
  it('sceneId 必填', () => {
    expect(() => briefPlotPointSchema.parse({ continuity: 'x' })).toThrow();
    expect(() => chapterBriefSchema.parse({ plotPoints: [{ continuity: 'x' }] })).toThrow();
  });

  it('continuity / stateAtT optional', () => {
    const ok = briefPlotPointSchema.parse({ sceneId: 'sc_1' });
    expect(ok.sceneId).toBe('sc_1');
    expect(ok.continuity).toBeUndefined();
    expect(ok.stateAtT).toBeUndefined();
  });

  it('stateAtT 接任意（状态引擎 6.6 未建——占位 shape 待 6.6）', () => {
    const ok = briefPlotPointSchema.parse({
      sceneId: 'sc_1',
      continuity: '本章结束',
      stateAtT: { hp: 50, location: '雷池' },
    });
    expect(ok.stateAtT).toEqual({ hp: 50, location: '雷池' });
  });
});

describe('briefEmotionTargetSchema（#10 情绪目标，charter #2，语义为主 + VAD 可选）', () => {
  it('语义情绪词为一等 + emotionEnd 转变 + vad 可选投影', () => {
    const r = briefEmotionTargetSchema.parse({
      emotion: '恐惧',
      emotionEnd: '忧虑',
      vad: { v: -0.7, a: 0.8, d: -0.3 },
      steer: '短句加速',
    });
    expect(r.emotion).toBe('恐惧');
    expect(r.emotionEnd).toBe('忧虑');
    expect(r.vad?.v).toBe(-0.7);
    expect(r.steer).toBe('短句加速');
  });

  it('chapterBriefSchema 注入 emotionTarget（语义为主形态）', () => {
    const r = chapterBriefSchema.parse({
      emotionTarget: { emotion: '愤怒', emotionEnd: '释然', vad: { v: -0.5, a: 0.6, d: 0.2 }, steer: '短句加速' },
    });
    expect(r.emotionTarget?.emotion).toBe('愤怒');
    expect(r.emotionTarget?.vad?.a).toBe(0.6);
  });

  it('空对象 pass（emotionTarget 全 optional，语义为主 VAD 可选）', () => {
    expect(briefEmotionTargetSchema.parse({})).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.2 §8：gap_whitelist 故意惊喜白名单（interface-contracts.md「optional 数组二态用 .min(1)」）。
// 作者标注的故意非线性叙事/信息延迟——Reader-Audit 一致性维命中降级 info 不误报。
// ─────────────────────────────────────────────────────────────────────────────

describe('chapterBriefSchema.gap_whitelist（4.2 §8 故意惊喜白名单）', () => {
  it('缺省合法（默认行为：无白名单）', () => {
    const r = chapterBriefSchema.parse({ goal: 'g' });
    expect(r.gap_whitelist).toBeUndefined();
  });

  it('≥1 条目合法：{location, reason}[]', () => {
    const r = chapterBriefSchema.parse({
      gap_whitelist: [
        { location: '句3', reason: '故意信息延迟（信息差操控）' },
        { location: '段2', reason: '非线性叙事（先果后因）' },
      ],
    });
    expect(r.gap_whitelist).toEqual([
      { location: '句3', reason: '故意信息延迟（信息差操控）' },
      { location: '段2', reason: '非线性叙事（先果后因）' },
    ]);
  });

  it('空数组 [] reject（.min(1) 拒空——二态契约：缺失=无白名单 / ≥1=白名单，[] 无意义第三态）', () => {
    expect(() => chapterBriefSchema.parse({ gap_whitelist: [] })).toThrow();
  });

  it('条目缺 location / reason → reject（both required）', () => {
    expect(() => chapterBriefSchema.parse({ gap_whitelist: [{ reason: 'r' }] })).toThrow();
    expect(() => chapterBriefSchema.parse({ gap_whitelist: [{ location: 'l' }] })).toThrow();
  });

  it('与其他段组合合法（gap_whitelist + 信息控制 + 禁写）', () => {
    const r = chapterBriefSchema.parse({
      goal: 'g',
      mustHide: '主角身份',
      hintOnly: '身世线索',
      doNotWrite: '过去回忆',
      gap_whitelist: [{ location: '句5', reason: '主角伪装被识破的伏笔延迟揭晓' }],
    });
    expect(r.gap_whitelist).toHaveLength(1);
    expect(r.mustHide).toBe('主角身份');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.3：manipulationDirectives（brief #3 structured 供 Reader-Audit L2 forbiddenMoves 裁判）。
// 二态 .min(1)（mirror gap_whitelist：缺失=无指令默认 / ≥1=有指令 / 空 [] 第三态拒收）。
// 与 #3 自然语言字段并行——#3 给 Writer 读，本字段给 L2 精确裁判（design §3 段② + §6）。
// ─────────────────────────────────────────────────────────────────────────────

describe('chapterBriefSchema.manipulationDirectives（6.3 #3 structured directives）', () => {
  it('缺省合法（默认行为：无指令）', () => {
    const r = chapterBriefSchema.parse({ goal: 'g' });
    expect(r.manipulationDirectives).toBeUndefined();
  });

  it('round-trip valid directive pass（mode + actions + forbiddenMoves + target）', () => {
    const directive = {
      mode: 'subjective_mislead',
      actions: ['withhold', 'dramatic_irony'],
      forbiddenMoves: ['主角真实身份', '凶器位置'],
      target: '主角动机',
    };
    const r = chapterBriefSchema.parse({ manipulationDirectives: [directive] });
    expect(r.manipulationDirectives).toEqual([directive]);
  });

  it('空数组 [] reject（.min(1) 拒空——二态契约：缺失=无指令 / ≥1=有指令，[] 无意义第三态）', () => {
    expect(() => chapterBriefSchema.parse({ manipulationDirectives: [] })).toThrow();
  });

  it('多条 directive 合法（≥1）', () => {
    const r = chapterBriefSchema.parse({
      manipulationDirectives: [
        { mode: 'reveal_first', actions: ['release'], target: 'A' },
        { mode: 'sustain_unknown', actions: ['withhold'], forbiddenMoves: ['B'], target: 'C' },
      ],
    });
    expect(r.manipulationDirectives).toHaveLength(2);
  });

  it('坏 directive（缺 mode）→ reject', () => {
    expect(() =>
      chapterBriefSchema.parse({ manipulationDirectives: [{ actions: ['plant'] }] }),
    ).toThrow();
  });

  it('坏 directive（空 actions）→ reject（actions .min(1)）', () => {
    expect(() =>
      chapterBriefSchema.parse({ manipulationDirectives: [{ mode: 'reveal_first', actions: [] }] }),
    ).toThrow();
  });

  it('与 #3 自然语言字段并行合法（readerKnows + manipulationDirectives）', () => {
    const r = chapterBriefSchema.parse({
      readerKnows: '读者知道反派出底牌',
      manipulationDirectives: [{ mode: 'reveal_first', actions: ['release'], target: '底牌' }],
    });
    expect(r.readerKnows).toBe('读者知道反派出底牌');
    expect(r.manipulationDirectives).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.1 §3.2：readiness 就绪阶梯 schema + computeReadiness + assertBriefReady。
// 纯代码（查段 populated + scene_graph 结构查询），非 LLM 语义。5 档：needs_plot → needs_world_anchor
// → needs_world_context → needs_chapter_brief → ready。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 valid SceneNode（schema.parse 填默认，避免漏 required 字段）。 */
function scene(partial: Record<string, unknown>): SceneNode {
  return sceneNodeSchema.parse({
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...partial,
  });
}

/** 构造 SceneGraph（仅 nodes 变化；edges/lines 等填默认空）。 */
function makeGraph(nodes: SceneNode[]): SceneGraph {
  return { nodes, edges: [], lines: [], art_overrides: [], version: 0, updatedBy: 'agent' };
}

describe('briefReadinessSchema（5 档 enum）', () => {
  it('5 档全合法', () => {
    const stages: BriefReadiness[] = ['needs_plot', 'needs_world_anchor', 'needs_world_context', 'needs_chapter_brief', 'ready'];
    for (const s of stages) {
      expect(briefReadinessSchema.parse(s)).toBe(s);
    }
  });

  it('非法档 reject', () => {
    expect(() => briefReadinessSchema.parse('needs_stuff')).toThrow();
    expect(() => briefReadinessSchema.parse('')).toThrow();
  });
});

describe('chapterBriefSchema.readiness（additive optional，零 migration）', () => {
  it('readiness optional：缺省仍合法（4.0 既有 brief 兼容）', () => {
    const r = chapterBriefSchema.parse({ goal: 'g' });
    expect(r.readiness).toBeUndefined();
  });

  it('readiness 字段 parse round-trip', () => {
    const r = chapterBriefSchema.parse({ goal: 'g', readiness: 'ready' });
    expect(r.readiness).toBe('ready');
  });
});

describe('computeReadiness（5 档判定序，纯代码）', () => {
  // 基线 fixture：有场（ep1）+ 有设定 + LLM 段（goal）→ ready
  const READY_GRAPH = makeGraph([scene({ id: 's1', episodeId: 'ep1' })]);
  const READY_BRIEF: ChapterBrief = { goal: '主角抵达 B 城' };

  it('needs_plot：scene_graph 全空（nodes=[]）', () => {
    expect(computeReadiness(READY_BRIEF, makeGraph([]), 'ep1', true)).toBe('needs_plot');
  });

  it('needs_plot：scene_graph undefined', () => {
    expect(computeReadiness(READY_BRIEF, undefined, 'ep1', true)).toBe('needs_plot');
  });

  it('needs_world_anchor：有场但 settingsPresent=false', () => {
    expect(computeReadiness(READY_BRIEF, READY_GRAPH, 'ep1', false)).toBe('needs_world_anchor');
  });

  it('needs_world_context：有场+设定但 brief #1 goal 空', () => {
    expect(computeReadiness({}, READY_GRAPH, 'ep1', true)).toBe('needs_world_context');
    expect(computeReadiness({ goal: '   ' }, READY_GRAPH, 'ep1', true)).toBe('needs_world_context');
  });

  it('needs_chapter_brief：有场+设定+LLM 意图但本章 episode 无匹配场', () => {
    // 场存在（ep1）但目标 ep2 无匹配 → needs_chapter_brief（本章未排出）
    expect(computeReadiness(READY_BRIEF, READY_GRAPH, 'ep2', true)).toBe('needs_chapter_brief');
  });

  it('needs_chapter_brief：presentationSpans M:N 也参与匹配（spans 含 ep2 → 命中）', () => {
    const graph = makeGraph([scene({ id: 's1', episodeId: 'ep1', presentationSpans: [{ episodeId: 'ep2', pos: 0 }] })]);
    expect(computeReadiness(READY_BRIEF, graph, 'ep2', true)).toBe('ready');
  });

  it('needs_chapter_brief：episodeId undefined 派不出匹配', () => {
    expect(computeReadiness(READY_BRIEF, READY_GRAPH, undefined, true)).toBe('needs_chapter_brief');
  });

  it('ready：全 populated（场+设定+LLM 意图+episode 匹配）', () => {
    expect(computeReadiness(READY_BRIEF, READY_GRAPH, 'ep1', true)).toBe('ready');
  });

  it('判定序正确：needs_plot 优先于 needs_world_anchor（空图 + 无设定 → needs_plot）', () => {
    expect(computeReadiness(READY_BRIEF, makeGraph([]), 'ep1', false)).toBe('needs_plot');
  });

  it('判定序正确：needs_world_anchor 优先于 needs_world_context（有场无设定无 goal → needs_world_anchor）', () => {
    expect(computeReadiness({}, READY_GRAPH, 'ep1', false)).toBe('needs_world_anchor');
  });
});

describe('assertBriefReady（gate 断言）', () => {
  it('readiness=ready 通过（不抛）', () => {
    expect(() => assertBriefReady({ readiness: 'ready' })).not.toThrow();
  });

  it('readiness=ready + 其它段 populated 亦通过', () => {
    expect(() => assertBriefReady({ goal: 'g', readiness: 'ready' })).not.toThrow();
  });

  it('readiness 缺省（undefined，4.0 既有 brief）→ 抛 BriefNotReadyError（视作 needs_plot）', () => {
    try {
      assertBriefReady({});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BriefNotReadyError);
      const err = e as BriefNotReadyError;
      expect(err.readiness).toBe('needs_plot');
      expect(err.missing).toBe(BRIEF_READINESS_GAP.needs_plot);
    }
  });

  it('各 non-ready 档抛 BriefNotReadyError + 带 {readiness, missing}', () => {
    const nonReady: Exclude<BriefReadiness, 'ready'>[] = [
      'needs_plot',
      'needs_world_anchor',
      'needs_world_context',
      'needs_chapter_brief',
    ];
    for (const stage of nonReady) {
      try {
        assertBriefReady({ readiness: stage });
        throw new Error(`should have thrown for ${stage}`);
      } catch (e) {
        expect(e).toBeInstanceOf(BriefNotReadyError);
        const err = e as BriefNotReadyError;
        expect(err.readiness).toBe(stage);
        expect(err.missing).toBe(BRIEF_READINESS_GAP[stage]);
        expect(err.message).toContain(stage);
      }
    }
  });

  it('BriefNotReadyError message 含 missing 文本（供入口返 leader/用户）', () => {
    try {
      assertBriefReady({ readiness: 'needs_world_context' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as BriefNotReadyError).message).toContain(BRIEF_READINESS_GAP.needs_world_context);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5 R3（design §4.1）：briefCharacterProgressionSchema +
// chapterBriefSchema.characterProgressions（非段·structured 字段，mirror
// manipulationDirectives 先例）。二态：缺失 = 无弧走向 / ≥1 = 有走向 /
// 空 `[]` 合法（过场章），不加 .min(1)。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 8.5 briefCharacterProgressionSchema（本章角色弧走向 shape）', () => {
  it('必填 characterId/from/to + optional characterName/turningPoint', () => {
    const p = briefCharacterProgressionSchema.parse({
      characterId: 'char-lin',
      characterName: '林昭',
      from: '封闭自守',
      to: '主动联结',
      turningPoint: '信任崩塌后的重建',
    });
    expect(p.characterId).toBe('char-lin');
    expect(p.characterName).toBe('林昭');
    expect(p.turningPoint).toBe('信任崩塌后的重建');

    const minimal = briefCharacterProgressionSchema.parse({ characterId: 'c1', from: 'A', to: 'B' });
    expect(minimal.characterName).toBeUndefined();
    expect(minimal.turningPoint).toBeUndefined();
  });

  it('缺 characterId / from / to / 空 characterId → 拒', () => {
    expect(() => briefCharacterProgressionSchema.parse({ from: 'A', to: 'B' })).toThrow(); // 缺 characterId
    expect(() => briefCharacterProgressionSchema.parse({ characterId: '', from: 'A', to: 'B' })).toThrow(); // 空 id
    expect(() => briefCharacterProgressionSchema.parse({ characterId: 'c1', to: 'B' })).toThrow(); // 缺 from
    expect(() => briefCharacterProgressionSchema.parse({ characterId: 'c1', from: 'A' })).toThrow(); // 缺 to
  });
});

describe('Story 8.5 chapterBriefSchema.characterProgressions（非段 structured 字段）', () => {
  it('brief 携 characterProgressions round-trip（chapterTask = brief JSON → 直达 draft-writer）', () => {
    const brief = chapterBriefSchema.parse({
      goal: '本章主角迈出联结第一步',
      characterProgressions: [
        { characterId: 'char-lin', characterName: '林昭', from: '封闭自守', to: '试探性信任', turningPoint: '初见同伴示弱' },
        { characterId: 'char-ye', from: '多疑', to: '多疑松动' },
      ],
    });
    expect(brief.characterProgressions).toHaveLength(2);
    expect(brief.characterProgressions![0].to).toBe('试探性信任');
    expect(brief.characterProgressions![1].characterName).toBeUndefined();
  });

  it('二态：缺失 = 无弧走向（默认，主笔照写）；空 [] 合法（过场章），不加 .min(1)', () => {
    expect(chapterBriefSchema.parse({}).characterProgressions).toBeUndefined();
    expect(chapterBriefSchema.parse({ characterProgressions: [] }).characterProgressions).toEqual([]);
  });

  it('与既有十段字段并存（additive，零 migration：既有 brief 不受影响）', () => {
    const brief = chapterBriefSchema.parse({
      goal: 'g',
      plotPoints: [{ sceneId: 's1' }],
      characterProgressions: [{ characterId: 'c1', from: 'A', to: 'B' }],
    });
    expect(brief.plotPoints).toHaveLength(1);
    expect(brief.characterProgressions).toHaveLength(1);
  });
});
