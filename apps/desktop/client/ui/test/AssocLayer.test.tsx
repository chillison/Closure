/**
 * 08-26 结构页重构 批 4（implement 4.2 / design §6.1 §3.3 / prd R1）：AssocLayer
 * ——因果卡 ↔ 工作 chip 关联线的规则显隐 + DOM 实测端点。
 *
 * 08-27 结构页修复第三轮 追加：buildAssocPath 有界曲率性质矩阵（y 带内/单调段/
 * 垂直接入切线——#76 采样锁定）、resolveAssocPaint/assocGradientId 异色渐变解析
 * （#75）。
 * 08-27 深夜目检 T4 追加：指向待编排列的关联线**一律不渲染**（用户拍板，推翻
 * #68 折叠可见性）——组件面断言零渲染（anomaly/selected 成员同样无豁免）；
 * planPendingAggregation 折叠计划纯函数族按 dispatch 许可保留、矩阵照旧锁定。
 * 08-27 T17（用户拍板 re-baseline）：**默认零渲染**——渲染门槛 = 悬停场景任一端
 * （卡/chip）∨ 选中；classifyAssoc 只留 paint 语义。jsdom 悬停经 fireEvent.
 * mouseOver/mouseOut 驱动 canvas 级委托（与 lineHover 同事件名先例）。
 *
 * 覆盖：
 *  - classifyAssoc 规则矩阵（anomaly=倒叙∨跨章span∨跨卷跳跃 / selected / minor；
 *    anomaly 优先于 selected——异常态着色胜出）。
 *  - buildChapterVolumeKey / chaptersCrossVolume（episode.phase_ref→phases 链解析；
 *    dangling/未分卷 → null 不判跨卷——保守）。
 *  - buildAssocPath（垂直三次贝塞尔的有界曲率形态——采样性质测试锁定）。
 *  - 组件（经 StructurePage 集成）：默认零 path；hover 场景 A → 只 A 的弧（卡侧/
 *    chip 侧同 nodeId）；选中 → 该弧；hover 与选中两门独立并存；pending 恒零（含
 *    hover/选中豁免尝试）；kind 分类与倒叙钢蓝类照旧（paint 面）。
 *  - 端点坐标换算（mock getBoundingClientRect——dispatch 许可：jsdom 测不了真实
 *    rect）：屏坐标 ÷ zoom → canvas 自然坐标（zoom 天然兼容 design §3.4）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run AssocLayer`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { episodeOutlinesSchema, sceneGraphSchema, type SceneGraph } from '@orison/shared-contracts';
import {
  AssocLayer,
  buildAssocPath,
  buildChapterVolumeKey,
  chaptersCrossVolume,
  classifyAssoc,
  PENDING_ASSOC_FOLD_THRESHOLD,
  planPendingAggregation,
  resolveAssocPaint,
  assocGradientId,
} from '../src/features/structure/AssocLayer';
import {
  clearNodeHover,
  setNodeHover,
  __resetNodeSharedStateForTests,
} from '../src/features/structure/nodeSharedState';
import { lineHueIndex } from '../src/features/structure/linePalette';
import type { PixelPoint } from '../src/features/structure/timelineGeometry';
import { StructurePage } from '../src/features/structure/StructurePage';
import { useAppStore } from '../src/shared/store/appStore';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}
function parseEpisodes(raw: unknown) {
  return episodeOutlinesSchema.parse(raw);
}

const NO_FACTS = { reordered: false, spansChapters: false, crossVolume: false, isSelected: false };

// ── (1) classifyAssoc 规则矩阵 ──

describe('classifyAssoc (rule matrix)', () => {
  it('plain scene → minor (baseline paint)', () => {
    expect(classifyAssoc(NO_FACTS)).toBe('minor');
  });

  it('倒叙 (reordered) → anomaly', () => {
    expect(classifyAssoc({ ...NO_FACTS, reordered: true })).toBe('anomaly');
  });

  it('跨章 span → anomaly', () => {
    expect(classifyAssoc({ ...NO_FACTS, spansChapters: true })).toBe('anomaly');
  });

  it('跨卷跳跃 (crossVolume) → anomaly', () => {
    expect(classifyAssoc({ ...NO_FACTS, crossVolume: true })).toBe('anomaly');
  });

  it('selected alone → selected (selection paint)', () => {
    expect(classifyAssoc({ ...NO_FACTS, isSelected: true })).toBe('selected');
  });

  it('anomaly wins over selected (anomaly paint takes precedence)', () => {
    expect(classifyAssoc({ ...NO_FACTS, isSelected: true, reordered: true })).toBe('anomaly');
    expect(classifyAssoc({ ...NO_FACTS, isSelected: true, spansChapters: true })).toBe('anomaly');
    expect(classifyAssoc({ ...NO_FACTS, isSelected: true, crossVolume: true })).toBe('anomaly');
  });

  it('any two anomaly reasons still classify anomaly (OR semantics)', () => {
    expect(classifyAssoc({ reordered: true, spansChapters: true, crossVolume: true, isSelected: false })).toBe('anomaly');
  });
});

// ── (2) 跨卷判定链（episode.phase_ref → outline.phases）──

describe('buildChapterVolumeKey / chaptersCrossVolume', () => {
  const episodes = parseEpisodes([
    { id: 'e0', index: 0, title: 'A1', phase_ref: 'ph1' },
    { id: 'e1', index: 1, title: 'A2', phase_ref: 'ph1' },
    { id: 'e2', index: 2, title: 'B1', phase_ref: 'ph2' },
    { id: 'e3', index: 3, title: '未挂卷' }, // no phase_ref
    { id: 'e4', index: 4, title: '幽灵卷', phase_ref: 'ph-ghost' }, // dangling ref
  ]);
  const phaseIds = ['ph1', 'ph2'];
  const vol = buildChapterVolumeKey(episodes, phaseIds);

  it('resolves a chapter to its phase id through the phases chain', () => {
    expect(vol.get(0)).toBe('ph1');
    expect(vol.get(2)).toBe('ph2');
  });

  it('unassigned / dangling phase_ref → null (never a provable cross-volume)', () => {
    expect(vol.get(3)).toBeNull();
    expect(vol.get(4)).toBeNull();
  });

  it('two chapters in different volumes → cross-volume', () => {
    expect(chaptersCrossVolume(0, 2, vol)).toBe(true);
  });

  it('same volume / same chapter → not cross-volume', () => {
    expect(chaptersCrossVolume(0, 1, vol)).toBe(false);
    expect(chaptersCrossVolume(1, 1, vol)).toBe(false);
  });

  it('either side unassigned → NOT cross-volume (conservative)', () => {
    expect(chaptersCrossVolume(0, 3, vol)).toBe(false);
    expect(chaptersCrossVolume(3, 2, vol)).toBe(false);
    expect(chaptersCrossVolume(3, 4, vol)).toBe(false);
  });

  it('unknown chapter (not in the map) → not cross-volume', () => {
    expect(chaptersCrossVolume(0, 99, vol)).toBe(false);
  });
});

// ── (3) buildAssocPath（有界曲率——08-27 #76 改造后的性质锁定）──

/** 三次贝塞尔采样器：解析本实现产出的 M/C 路径串，按 Bernstein 基取 t 均匀样本。 */
function sampleBezier(from: PixelPoint, to: PixelPoint, steps = 64) {
  const d = buildAssocPath(from, to);
  const num = '-?\\d+(?:\\.\\d+)?';
  const re = new RegExp(
    `^M (${num}) (${num}) C (${num}) (${num}), (${num}) (${num}), (${num}) (${num})$`
  );
  const m = d.match(re);
  expect(m, `path form unexpected: ${d}`).not.toBeNull();
  const [x0, y0, cx1, cy1, cx2, cy2, x3, y3] = m!.slice(1).map(Number);
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push({
      x: u * u * u * x0 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x3,
      y: u * u * u * y0 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y3,
    });
  }
  return { pts, controls: { x0, y0, cx1, cy1, cx2, cy2, x3, y3 }, d };
}

describe('buildAssocPath (bounded-curvature properties)', () => {
  it('aligned vertical pair keeps the eased cubic (controls at the mid height)', () => {
    const d = buildAssocPath({ x: 100, y: 200 }, { x: 100, y: 300 });
    expect(d.startsWith('M 100 200')).toBe(true);
    expect(d.endsWith('100 300')).toBe(true);
    // 控制点沿 y（纵距 = 落差一半 = 50，双双落在带内中线上）。
    expect(d).toContain('C 100 250, 100 250');
  });

  it('near-drop pairs stay INSIDE the endpoint y-band (old 10px floor overshoot retired)', () => {
    // 旧实现 lift 下限 10px 曾把控制点推出 4px 落差的带外（110 > 104 / 94 < 100）
    // ——「深俯冲回环大弯」的最小复现参数。新实现控制点钳进带内。
    const { controls } = sampleBezier({ x: 50, y: 100 }, { x: 60, y: 104 });
    expect(controls.cy1).toBeLessThanOrEqual(104);
    expect(controls.cy2).toBeGreaterThanOrEqual(100);
  });

  it('drop ≈ 0 degenerates to a straight segment (any curve would exit the collapsed band)', () => {
    const d = buildAssocPath({ x: 50, y: 100 }, { x: 400, y: 100 });
    expect(d).toBe('M 50 100 L 400 100');
  });

  it('PROPERTY: sampled y stays within [min(y0,y3), max(y0,y3)] for every axis scenario', () => {
    const cases: Array<[PixelPoint, PixelPoint]> = [
      [{ x: 100, y: 200 }, { x: 100, y: 300 }],   // 正落差竖线
      [{ x: 50, y: 100 }, { x: 60, y: 104 }],     // 微落差近贴对
      [{ x: 0, y: 500 }, { x: 1800, y: 40 }],     // 长横距大斜升（工作台远端）
      [{ x: 900, y: 44 }, { x: 2100, y: 62 }],    // 浅落差超长横跑（#76 主诉形态）
      [{ x: 700, y: 88 }, { x: 240, y: 30 }],     // 向左上（dy<0 方向分支）
      [{ x: 30, y: 12 }, { x: 2100, y: 6 }],      // 极浅长距（旧代码在此出回环）
    ];
    for (const [from, to] of cases) {
      const { pts } = sampleBezier(from, to);
      const lo = Math.min(from.y, to.y);
      const hi = Math.max(from.y, to.y);
      for (const p of pts) {
        expect(p.y).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(p.y).toBeLessThanOrEqual(hi + 1e-6);
      }
    }
  });

  it('PROPERTY: at most ONE smooth direction change (monotone-ish y; no loop-back wiggle)', () => {
    const cases: Array<[PixelPoint, PixelPoint]> = [
      [{ x: 50, y: 100 }, { x: 60, y: 104 }],
      [{ x: 0, y: 500 }, { x: 1800, y: 40 }],
      [{ x: 900, y: 44 }, { x: 2100, y: 62 }],
      [{ x: 700, y: 88 }, { x: 240, y: 30 }],
      [{ x: 30, y: 12 }, { x: 2100, y: 6 }],
    ];
    for (const [from, to] of cases) {
      const { pts } = sampleBezier(from, to);
      let flips = 0;
      let prevDir = 0;
      for (let i = 1; i < pts.length; i++) {
        const dy = pts[i]!.y - pts[i - 1]!.y;
        if (Math.abs(dy) < 1e-9) continue;
        const dir = Math.sign(dy);
        if (prevDir !== 0 && dir !== prevDir) flips++;
        prevDir = dir;
      }
      expect(flips, `${JSON.stringify(from)}->${JSON.stringify(to)}`).toBeLessThanOrEqual(1);
    }
  });

  it('vertical-entry tangents preserved (first control shares from.x, last shares to.x)', () => {
    const { controls } = sampleBezier({ x: 120, y: 10 }, { x: 900, y: 70 });
    expect(controls.cx1).toBe(120);
    expect(controls.cx2).toBe(900);
  });

  it('long horizontal runs keep x monotone (no serpentine across columns)', () => {
    const { pts } = sampleBezier({ x: 900, y: 44 }, { x: 2100, y: 62 });
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.x).toBeGreaterThanOrEqual(pts[i - 1]!.x - 1e-6);
    }
  });
});

// ── (3b) planPendingAggregation（#68 折叠计划纯函数——T4 后零渲染消费，机制保留）──

/** 候选构造器（AssocCandidate 形状的结构等价物）。 */
function cand(
  nodeId: string,
  lineId: string,
  overrides: Partial<{ pending: boolean; reordered: boolean }> = {}
) {
  return { nodeId, lineId, reordered: false, spansChapters: false, crossVolume: false, pending: false, ...overrides };
}

describe('planPendingAggregation (#68 fold plan)', () => {
  it('bunch ≤ threshold stays unfolded (status quo density preserved)', () => {
    const cands = [
      cand('a', 'l1', { pending: true }),
      cand('b', 'l1', { pending: true }),
      cand('c', 'l1', { pending: true }),
    ];
    expect(planPendingAggregation(cands).size).toBe(0);
  });

  it('bunch > threshold folds: first candidate represents, the rest hide until line hover', () => {
    const cands = [
      cand('a', 'l1', { pending: true }),
      cand('b', 'l1', { pending: true }),
      cand('c', 'l1', { pending: true }),
      cand('d', 'l1', { pending: true }),
    ];
    const plan = planPendingAggregation(cands);
    expect(plan.size).toBe(4);
    expect(plan.get('a')).toEqual({ groupSize: 4, representative: true, folded: false });
    for (const id of ['b', 'c', 'd']) {
      expect(plan.get(id)).toEqual({ groupSize: 4, representative: false, folded: true });
    }
  });

  it('groups are per line: bundled pages fold independently, arranged scenes untouched', () => {
    const cands = [
      cand('w1', 'lA', { pending: true }),
      cand('w2', 'lA', { pending: true }),
      cand('arranged', 'lB'),                    // 非待编排永不入束
      cand('w3', 'lB', { pending: true }),
      cand('w4', 'lB', { pending: true }),
      cand('w5', 'lB', { pending: true }),
      cand('w6', 'lB', { pending: true }),
    ];
    const plan = planPendingAggregation(cands);
    // lA 束只有 2 条（≤ 阈值）→ 整束不入计划（维持现状）；lB 束 4 条才折。
    expect([...plan.keys()].sort()).toEqual(['w3', 'w4', 'w5', 'w6']);
    expect(plan.get('arranged')).toBeUndefined();
    expect(plan.get('w1')).toBeUndefined();
    expect(plan.get('w2')).toBeUndefined();
    expect(plan.get('w3')).toEqual({ groupSize: 4, representative: true, folded: false });
    expect(plan.get('w6')).toEqual({ groupSize: 4, representative: false, folded: true });
  });

  it('threshold honors explicit override and rejects absurd values defensively (edge V-8)', () => {
    const cands = [
      cand('a', 'l1', { pending: true }),
      cand('b', 'l1', { pending: true }),
    ];
    expect(planPendingAggregation(cands, 1).get('a')).toEqual({ groupSize: 2, representative: true, folded: false });
    expect(planPendingAggregation(cands, 0).size).toBe(2);
    // 负阈值防呆：max(0, threshold) 兜底不抛异常。
    expect(planPendingAggregation(cands, -5).size).toBe(2);
    // 非有限阈值（08-27 三轮 CR edge V-8）：NaN 曾穿透 Math.max(0,·) 使
    // `length <= NaN` 恒 false → 连 ≤ 阈值的束也全体折叠；±Infinity 同族。
    // 一律回落默认阈值（拍板值 3）。
    const bunch = Array.from({ length: 6 }, (_, i) => cand(`m${i}`, 'l1', { pending: true }));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const plan = planPendingAggregation(bunch, bad);
      expect(plan.size, `non-finite ${bad} falls back to the default threshold`).toBe(6);
      expect(plan.get('m0')).toEqual({ groupSize: 6, representative: true, folded: false });
      expect(plan.get('m5')).toEqual({ groupSize: 6, representative: false, folded: true });
    }
    // 对照：默认阈值下 2 条束不折（NaN 旧行为会把它们折成 1+1）。
    expect(planPendingAggregation(cands, Number.NaN).size).toBe(0);
  });
});

// ── (4) 组件集成（经 StructurePage——真实挂载面）──

/**
 * Fixture：两线四场景 + 两章两卷。
 * 位次数学（storyRank vs readIndex，workbenchLayout 派生单源）：
 *   storyRank（按 storyTime 稳定序）：s_plain 0 / s_re 1 / s_re2 2 / s_span 3。
 *   readIndex（按 chapter,pos 稳定序）：s_plain 0 / s_re2 1 / s_re 2 / s_span 3。
 *   → s_plain 位次一致（minor）；s_re/s_re2 互换（双倒叙——置换对称性，奇置换必
 *     ≥2 节点错位）；s_span 位次一致但 spans e0..e2 → 跨章 + 跨卷 anomaly。
 */
function assocGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
      { id: 'l_side', name: '副线', topology_role: 'side' },
    ],
    nodes: [
      {
        id: 's_plain', lineTags: ['l_main'], storyTime: 1, role: 'normal',
        presentationOrder: { chapter: 0, pos: 0 }, title: '顺叙',
      },
      {
        id: 's_re', lineTags: ['l_main'], storyTime: 2, role: 'normal',
        presentationOrder: { chapter: 0, pos: 2 }, title: '倒叙',
      },
      {
        id: 's_re2', lineTags: ['l_main'], storyTime: 3, role: 'normal',
        presentationOrder: { chapter: 0, pos: 1 }, title: '倒叙二',
      },
      {
        id: 's_span', lineTags: ['l_side'], storyTime: 4, role: 'normal',
        presentationOrder: { chapter: 0, pos: 3 },
        presentationSpans: [{ episodeId: 'e0', pos: 0 }, { episodeId: 'e2', pos: 0 }],
        title: '跨章跨卷',
      },
    ],
    edges: [],
  });
}

function assocEpisodes() {
  return parseEpisodes([
    { id: 'e0', index: 0, title: '卷一章', phase_ref: 'ph1' },
    { id: 'e1', index: 1, title: '卷一尾', phase_ref: 'ph1' },
    { id: 'e2', index: 2, title: '卷二章', phase_ref: 'ph2' },
  ]);
}

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    creativeFields: {
      scene_graph: assocGraph(),
      episode_outlines: assocEpisodes(),
      outline: { phases: [{ id: 'ph1', title: '卷一' }, { id: 'ph2', title: '卷二' }] },
    },
    overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
    resolvedLocale: 'en-US',
    selectedNodeId: null,
    canvasZoom: 1,
    ...overrides,
  } as any);
}

describe('AssocLayer (StructurePage integration)', () => {
  beforeEach(() => seedStore());
  afterEach(() => {
    cleanup();
    // T26：nodeSharedState 是模块级共享态——用例间整仓复位（悬停键泄漏防线；
    // 生产由组件卸载的条件清兜底，测试面双保险）。
    __resetNodeSharedStateForTests();
    vi.restoreAllMocks();
  });

  it('T17: renders ZERO arcs by default — hover-or-selection is the only visibility gate', () => {
    const { container } = render(<StructurePage />);
    // 层常驻（有候选即挂 svg），弧零——异常/选中缺席时无任何默认常显成员。
    expect(container.querySelector('[data-assoc-layer]')).not.toBeNull();
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
  });

  it('hovering the causal card reveals ONLY that scene\'s arc; leaving the carrier clears it', () => {
    const { container } = render(<StructurePage />);
    const card = container.querySelector(
      '[data-skeleton="causal"] .scene-card[data-node-id="s_plain"]'
    ) as HTMLElement;
    fireEvent.mouseOver(card);
    const links = container.querySelectorAll('.assoc-link');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('data-node-id')).toBe('s_plain');
    // 离开载体即清（T25 起悬停源 = 载体自身 enter/leave 发布到 nodeSharedState；
    // 旧 canvas 委托的「blank mouseover 清」随单一悬停源化退役——真实浏览器里
    // 指针移到空白必然途经卡面 mouseout，语义等价）。
    fireEvent.mouseOut(card);
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
  });

  it('hovering the WORKBENCH chip reveals the same arc (either end counts); mouseout clears', () => {
    const { container } = render(<StructurePage />);
    const chip = container.querySelector('.workbench-chip[data-node-id="s_span"]') as HTMLElement;
    fireEvent.mouseOver(chip);
    const links = container.querySelectorAll('.assoc-link');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('data-node-id')).toBe('s_span');
    // mouseout 且 relatedTarget 缺失（指针去向不明）→ 清；非同载体早退不触发。
    fireEvent.mouseOut(chip);
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
  });

  it('revealed arcs carry their classified kind — paint markers, display no longer rides them', () => {
    const { container } = render(<StructurePage />);
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_plain"]')!);
    const minor = container.querySelector('.assoc-link[data-node-id="s_plain"]') as SVGElement;
    expect(minor.getAttribute('data-assoc-kind')).toBe('minor');
    // anomaly 两径：倒叙 / 跨章+跨卷（hover 换目标 = 渲染滤集换成员，一次只一弧）。
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_re"]')!);
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
    const re = container.querySelector('.assoc-link[data-node-id="s_re"]') as SVGElement;
    expect(re.getAttribute('data-assoc-kind')).toBe('anomaly');
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_span"]')!);
    const span = container.querySelector('.assoc-link[data-node-id="s_span"]') as SVGElement;
    expect(span.getAttribute('data-assoc-kind')).toBe('anomaly');
  });

  it('倒叙 arc keeps the steel-blue reorder class + data-reordered tag', () => {
    const { container } = render(<StructurePage />);
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_re"]')!);
    const re = container.querySelector('.assoc-link[data-node-id="s_re"]') as SVGElement;
    expect(re.classList.contains('assoc-link--reorder')).toBe(true);
    expect(re.getAttribute('data-reordered')).toBe('true');
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_plain"]')!);
    const plain = container.querySelector('.assoc-link[data-node-id="s_plain"]') as SVGElement;
    expect(plain.classList.contains('assoc-link--reorder')).toBe(false);
    expect(plain.getAttribute('data-reordered')).toBe('false');
  });

  it('selected renders its arc without hover; anomaly wins the kind when both hold', () => {
    seedStore({ selectedNodeId: 's_plain' });
    const { container } = render(<StructurePage />);
    const plain = container.querySelector('.assoc-link[data-node-id="s_plain"]') as SVGElement;
    expect(plain.classList.contains('assoc-link--selected')).toBe(true);
    expect(plain.getAttribute('data-assoc-kind')).toBe('selected');
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1); // 只选中场景一条
    // 倒叙场景被选中 → anomaly 优先（paint 优先级：不取 selected 描边）。
    seedStore({ selectedNodeId: 's_re' });
    cleanup();
    const { container: c2 } = render(<StructurePage />);
    const re = c2.querySelector('.assoc-link[data-node-id="s_re"]') as SVGElement;
    expect(re.getAttribute('data-assoc-kind')).toBe('anomaly');
    expect(re.classList.contains('assoc-link--selected')).toBe(false);
  });

  it('hover and selection are independent gates — both arcs coexist', () => {
    seedStore({ selectedNodeId: 's_span' });
    const { container } = render(<StructurePage />);
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_plain"]')!);
    const ids = [...container.querySelectorAll('.assoc-link')]
      .map((l) => l.getAttribute('data-node-id'))
      .sort();
    expect(ids).toEqual(['s_plain', 's_span']);
  });

  it('each arc carries its line id + lane hue class', () => {
    const { container } = render(<StructurePage />);
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_span"]')!);
    const span = container.querySelector('.assoc-link[data-node-id="s_span"]') as SVGElement;
    expect(span.getAttribute('data-line-id')).toBe('l_side'); // primary line = 唯一 lineTag
    expect(span.classList.contains(`lane-hue--c${lineHueIndex('l_side')}`)).toBe(true);
  });

  it('a scene dangling on the causal side (all lineTags dead) gets no arc across all hovers', () => {
    const g = assocGraph();
    g.nodes = [
      ...g.nodes,
      { ...g.nodes[0]!, id: 's_ghost', lineTags: ['l_nope'] },
    ];
    seedStore({ creativeFields: { scene_graph: g, episode_outlines: assocEpisodes() } });
    const { container } = render(<StructurePage />);
    const cards = [...container.querySelectorAll('[data-skeleton="causal"] .scene-card')];
    // 四真实场景逐一悬停各出弧；ghost 无因果卡（悬停面不存在）也永不出弧。
    for (const id of ['s_plain', 's_re', 's_re2', 's_span']) {
      const card = cards.find((c) => c.getAttribute('data-node-id') === id)!;
      fireEvent.mouseOver(card);
      expect(container.querySelector(`.assoc-link[data-node-id="${id}"]`)).not.toBeNull();
      expect(container.querySelector('.assoc-link[data-node-id="s_ghost"]')).toBeNull();
    }
  });

  it('renders nothing when no scene pairs up (empty graph)', () => {
    seedStore({
      creativeFields: {
        scene_graph: parseGraph({ lines: [], nodes: [], edges: [] }),
        episode_outlines: assocEpisodes(),
      },
    });
    const { container } = render(<StructurePage />);
    // 空图 → TimelineEmptyState（无 canvas）；AssocLayer 零渲染。
    expect(container.querySelector('[data-assoc-layer]')).toBeNull();
  });

  it('endpoints convert screen rects ÷ zoom into canvas-natural coords (mock rects)', () => {
    seedStore({ canvasZoom: 0.5 });
    // jsdom 无真 rect——按元素身份 mock（dispatch 许可：jsdom 测不了真实 rect）。
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.classList.contains('structure-canvas')) {
        return rect(100, 200, 500, 800);
      }
      if (this.classList.contains('scene-card') && this.getAttribute('data-node-id') === 's_plain') {
        return rect(110, 260, 48, 50); // bottom = 310, centre x = 134
      }
      if (this.classList.contains('workbench-chip') && this.getAttribute('data-node-id') === 's_plain') {
        return rect(130, 600, 100, 26); // top = 600, centre x = 180
      }
      return rect(0, 0, 0, 0);
    });
    const { container } = render(<StructurePage />);
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_plain"]')!);
    const path = container.querySelector('.assoc-link[data-node-id="s_plain"]') as SVGElement;
    const d = path.getAttribute('d') ?? '';
    // from = 卡底中点（(134-100)/0.5, (310-200)/0.5 + 2）= (68, 222)。
    expect(d.startsWith('M 68 222')).toBe(true);
    // to = chip 顶中点（(180-100)/0.5, (600-200)/0.5 - 2）= (160, 798)。
    expect(d.endsWith('160 798')).toBe(true);
  });
});

/** rect helper（DOMRect 形状足够本消费面）。 */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

// ── (5) 独立挂载面（BMad CR 组2a/5 修补项的定向覆盖 + T17 hover 委托）──
//
// 绕开 StructurePage 整页渲染（两区树整棵挂载重），只喂 AssocLayer 必需的宿主结构
// （.structure-canvas + 卡/chip stub，data 属性与图内 id 一一对应）——端点实测 /
// 注入转义 / pending 透传 / 选择解耦 / hover 渲染门槛五件事在最小面上断言。

/** AssocLayer 的最小宿主：每场景一对卡/chip stub（data 属性同值注入）。
 * T25 起悬停源 = nodeSharedState 的 (nodeId, lineId) 键（真实面由 SceneCard/
 * WorkbenchChip 的 onMouseEnter 发布）——stub 以同款 enter/leave 发布模拟载体契约。 */
function StandaloneCanvas({ nodes }: { nodes: Array<{ nodeId: string; lineId: string }> }) {
  return (
    <div className="structure-page">
      <div className="structure-canvas">
        {nodes.map((p) => (
          <Fragment key={`${p.nodeId}|${p.lineId}`}>
            <div
              className="scene-card"
              data-node-id={p.nodeId}
              data-line-id={p.lineId}
              onMouseEnter={() => setNodeHover({ nodeId: p.nodeId, lineId: p.lineId })}
              onMouseLeave={() => clearNodeHover({ nodeId: p.nodeId, lineId: p.lineId })}
            />
            <div
              className="workbench-chip"
              data-node-id={p.nodeId}
              data-line-id={p.lineId}
              onMouseEnter={() => setNodeHover({ nodeId: p.nodeId, lineId: p.lineId })}
              onMouseLeave={() => clearNodeHover({ nodeId: p.nodeId, lineId: p.lineId })}
            />
          </Fragment>
        ))}
        <AssocLayer />
      </div>
    </div>
  );
}

describe('AssocLayer standalone（CR 组2a/5 定向覆盖）', () => {
  beforeEach(() => {
    useAppStore.setState({
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      canvasZoom: 1,
    } as any);
  });
  afterEach(() => {
    cleanup();
    // T26：nodeSharedState 是模块级共享态——用例间整仓复位（悬停键泄漏防线；
    // 生产由组件卸载的条件清兜底，测试面双保险）。
    __resetNodeSharedStateForTests();
    vi.restoreAllMocks();
  });

  it('querySelector 注入防御：引号/反斜杠 id 正常出线（CSS.escape），整层不炸', () => {
    const hostile = 's"q\\evil';
    useAppStore.setState({
      creativeFields: {
        scene_graph: parseGraph({
          lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }],
          nodes: [
            { id: 's_ok', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 }, title: '顺' },
            { id: hostile, lineTags: ['l_main'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 1 }, title: '脏id' },
          ],
          edges: [],
        }),
        episode_outlines: assocEpisodes(),
      },
    } as any);
    const { container } = render(
      <StandaloneCanvas nodes={[{ nodeId: 's_ok', lineId: 'l_main' }, { nodeId: hostile, lineId: 'l_main' }]} />
    );
    // 旧实现对脏 id 直拼 `[data-node-id="s"q\evil"]` → SyntaxError 使**全部**关联线
    // 消失；转义后逐场景悬停各自出线，脏 id 的 attr 值原样往返。stub 无子元素，
    // 取 DOM 序（querySelector 属性串拼脏 id 同样会炸——绕开）。
    const cards = [...container.querySelectorAll('.scene-card')];
    fireEvent.mouseOver(cards[0]!);
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
    expect(container.querySelector('.assoc-link[data-node-id="s_ok"]')).not.toBeNull();
    fireEvent.mouseOver(cards[1]!);
    const links = [...container.querySelectorAll('.assoc-link')];
    expect(links).toHaveLength(1);
    const hostileLink = links[0]!;
    expect(hostileLink.getAttribute('data-node-id')).toBe(hostile);
    expect(hostileLink.getAttribute('d')).toBeTruthy();
    expect(hostileLink.getAttribute('data-line-id')).toBe('l_main');
  });

  it('T4: 指向待编排列的关联线一律不渲染——T17 hover 门槛之下 pending 仍最外层', () => {
    // 位次数学（x_c/z_d 旧口径下双双「倒叙 dangling」——组5 曾为此透传 reordered
    // 保钢蓝 anomaly）：
    //   read : p_a=0 / q_b=1 / x_c=2(ch90,pos0) / z_d=3(ch91,pos1)
    //   story: p_a=0 / q_b=1 / z_d=2(st 8) / x_c=3(st 9)
    // → x_c 与 z_d 交错错位；T4 用户拍板「待编排方向连线一律不显示」后无论何种
    //   分类（anomaly/selected/minor）pending 目标零渲染。两端 stub 照挂——证明滤除
    //   发生在渲染面而非「测量 miss」的巧合；悬停（hover 门）也不能唤出。
    useAppStore.setState({
      creativeFields: {
        scene_graph: parseGraph({
          lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }],
          nodes: [
            { id: 'p_a', lineTags: ['l_main'], storyTime: 5, role: 'normal', presentationOrder: { chapter: 0, pos: 0 }, title: '顺叙' },
            { id: 'q_b', lineTags: ['l_main'], storyTime: 6, role: 'normal', presentationOrder: { chapter: 0, pos: 1 }, title: '顺叙二' },
            { id: 'z_d', lineTags: ['l_main'], storyTime: 8, role: 'normal', presentationOrder: { chapter: 91, pos: 1 }, title: '错位悬置' },
            { id: 'x_c', lineTags: ['l_main'], storyTime: 9, role: 'normal', presentationOrder: { chapter: 90, pos: 0 }, title: '倒叙悬置' },
          ],
          edges: [],
        }),
        episode_outlines: episodeOutlinesSchema.parse([
          { id: 'e0', index: 0, title: '第一章' },
          { id: 'e1', index: 1, title: '第二章' },
        ]),
      },
    } as any);
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 'p_a', lineId: 'l_main' },
          { nodeId: 'q_b', lineId: 'l_main' },
          { nodeId: 'z_d', lineId: 'l_main' },
          { nodeId: 'x_c', lineId: 'l_main' },
        ]}
      />
    );
    const cardOf = (id: string) =>
      [...container.querySelectorAll('.scene-card')].find((c) => c.getAttribute('data-node-id') === id)!;
    // hover 待编排场景（含旧钢蓝口径成员 x_c/z_d）→ 零渲染。
    for (const id of ['x_c', 'z_d']) {
      fireEvent.mouseOver(cardOf(id));
      expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
    }
    // 已编排两场景照常出弧（滤除不误伤正常链——hover 揭示只放行非 pending）。
    fireEvent.mouseOver(cardOf('p_a'));
    expect(container.querySelector('.assoc-link[data-node-id="p_a"]')).not.toBeNull();
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
    fireEvent.mouseOver(cardOf('q_b'));
    expect(container.querySelector('.assoc-link[data-node-id="q_b"]')).not.toBeNull();
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
  });

  it('选中态零重测（测量与 selectedNodeId 解耦）：点选只翻渲染滤集，不再读任何 DOM rect', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: assocGraph(),
        episode_outlines: assocEpisodes(),
        outline: { phases: [{ id: 'ph1', title: '卷一' }] },
      },
    } as any);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 's_plain', lineId: 'l_main' },
          { nodeId: 's_re', lineId: 'l_main' },
          { nodeId: 's_re2', lineId: 'l_main' },
          { nodeId: 's_span', lineId: 'l_side' },
        ]}
      />
    );
    // 挂载期首测已发生；此后清零计数，选中翻转到反测。
    spy.mockClear();
    act(() => {
      useAppStore.setState({ selectedNodeId: 's_plain' });
    });
    expect(spy.mock.calls.length).toBe(0); // 点选零重测（旧实现全量 getBoundingClientRect）
    // 选中门放行：弧在渲染面（paint 层 kind 即时翻转，持久化的坐标态未动）。
    const link = document.querySelector('.assoc-link[data-node-id="s_plain"]') as SVGElement;
    expect(link.getAttribute('data-assoc-kind')).toBe('selected');
    expect(link.classList.contains('assoc-link--selected')).toBe(true);
    // 再清空选择：同样零 rect 读，弧卸载（无 hover 无选中 → 默认零渲染）。
    act(() => {
      useAppStore.setState({ selectedNodeId: null });
    });
    expect(spy.mock.calls.length).toBe(0);
    expect(document.querySelector('.assoc-link[data-node-id="s_plain"]')).toBeNull();
  });

  it('T17 hover 态零重测（与选中同款解耦）：hover 只翻渲染滤集，不读任何 DOM rect', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: assocGraph(), episode_outlines: assocEpisodes() },
    } as any);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 's_plain', lineId: 'l_main' },
          { nodeId: 's_re', lineId: 'l_main' },
        ]}
      />
    );
    spy.mockClear();
    const card = [...container.querySelectorAll('.scene-card')]
      .find((c) => c.getAttribute('data-node-id') === 's_plain')!;
    fireEvent.mouseOver(card);
    expect(spy.mock.calls.length).toBe(0);
    expect(container.querySelector('.assoc-link[data-node-id="s_plain"]')).not.toBeNull();
    fireEvent.mouseOut(card); // relatedTarget 缺失 → 清
    expect(spy.mock.calls.length).toBe(0);
    expect(container.querySelector('.assoc-link[data-node-id="s_plain"]')).toBeNull();
  });

  it('缩放仍驱动全量重测（解耦只针对选中态——zoom 进 measure 依赖的行为保留）', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: assocGraph(), episode_outlines: assocEpisodes() },
      canvasZoom: 1,
    } as any);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.classList.contains('structure-canvas')) return rect(0, 0, 1000, 1000);
      return rect(10, 10, 40, 40);
    });
    render(<StandaloneCanvas nodes={[{ nodeId: 's_plain', lineId: 'l_main' }]} />);
    const before = vi.mocked(Element.prototype.getBoundingClientRect).mock.calls.length;
    act(() => {
      useAppStore.setState({ canvasZoom: 0.75 });
    });
    // zoom 变化重建 measure → 共享底座 effect 重挂 → 至少再测一轮。
    expect(vi.mocked(Element.prototype.getBoundingClientRect).mock.calls.length).toBeGreaterThan(before);
  });

  it('linkEquals 布局旗标入比（blind V-F6）：坐标静止但旗标翻转时 links 换新（kind 即时跟随）', () => {
    // 场景：仅改 presentationSpans 使静止配对跨章+跨卷成立（e0∈ph1 / e2∈ph2）
    // ——chip 章列不动、mock rect 恒定 ⇒ 两端坐标逐位相等。旧 linkEquals 漏比
    // spansChapters/crossVolume/pending → setLinks 保 prev → 陈旧 minor 卡死
    // （anomaly 信号丢失），直到任一坐标变化才自愈。
    useAppStore.setState({
      creativeFields: { scene_graph: assocGraph(), episode_outlines: assocEpisodes() },
    } as any);
    const { container } = render(
      <StandaloneCanvas nodes={[{ nodeId: 's_plain', lineId: 'l_main' }]} />
    );
    // hover 放行 s_plain 的弧（T17 渲染门槛；hover 态跨 store 更新存活）。
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_plain"]')!);
    const link = container.querySelector('.assoc-link[data-node-id="s_plain"]') as SVGElement;
    expect(link.getAttribute('data-assoc-kind')).toBe('minor');
    // 第二轮：s_plain 挂跨章 span（镜像 fixture 里 s_span 的形态——已证分类为
    // anomaly）。jsdom 全零 rect → 坐标与首轮逐位相同，只有旗标变了。
    const g = assocGraph();
    g.nodes = g.nodes.map((n) =>
      n.id === 's_plain'
        ? { ...n, presentationSpans: [{ episodeId: 'e0', pos: 0 }, { episodeId: 'e2', pos: 0 }] }
        : n
    );
    act(() => {
      useAppStore.setState({
        creativeFields: { scene_graph: g, episode_outlines: assocEpisodes() } as any,
      });
    });
    const link2 = container.querySelector('.assoc-link[data-node-id="s_plain"]') as SVGElement;
    expect(link2.getAttribute('data-assoc-kind')).toBe('anomaly');
  });
});

// ── (6) T4 待编排方向零渲染 + #75 渐变解析（08-27 第三轮追加 → 深夜目检重定基）──

/**
 * 折叠 fixture：单线 6 个全 dangling 场景（章号 90..95，全部越界 → 待编排列）。
 * n0–n3 storyRank 与 readIndex 同序（旧口径 minor）；r_a/s_b 的 storyTime 与章序
 * 对换（错位必成对——组5 置换语义）→ 旧口径双双 anomaly（钢蓝）。
 *   storyRank : n0 n1 n2 n3 s_b r_a
 *   readIndex : n0 n1 n2 n3 r_a s_b
 */
function danglingFoldGraph(): SceneGraph {
  return parseGraph({
    lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true }],
    nodes: [
      { id: 'n0', lineTags: ['l_main'], storyTime: 10, role: 'normal', presentationOrder: { chapter: 90, pos: 0 }, title: '悬置一' },
      { id: 'n1', lineTags: ['l_main'], storyTime: 11, role: 'normal', presentationOrder: { chapter: 91, pos: 0 }, title: '悬置二' },
      { id: 'n2', lineTags: ['l_main'], storyTime: 12, role: 'normal', presentationOrder: { chapter: 92, pos: 0 }, title: '悬置三' },
      { id: 'n3', lineTags: ['l_main'], storyTime: 13, role: 'normal', presentationOrder: { chapter: 93, pos: 0 }, title: '悬置四' },
      { id: 's_b', lineTags: ['l_main'], storyTime: 20, role: 'normal', presentationOrder: { chapter: 95, pos: 0 }, title: '倒序甲' },
      { id: 'r_a', lineTags: ['l_main'], storyTime: 21, role: 'normal', presentationOrder: { chapter: 94, pos: 0 }, title: '倒序乙' },
    ],
    edges: [],
  });
}

describe('AssocLayer pending links render ZERO (T4 用户拍板·#68 可见性推翻)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: danglingFoldGraph(),
        episode_outlines: episodeOutlinesSchema.parse([
          { id: 'e0', index: 0, title: '第一章' },
          { id: 'e1', index: 1, title: '第二章' },
        ]),
      },
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      canvasZoom: 1,
    } as any);
  });
  afterEach(() => {
    cleanup();
    // T26：nodeSharedState 是模块级共享态——用例间整仓复位（悬停键泄漏防线；
    // 生产由组件卸载的条件清兜底，测试面双保险）。
    __resetNodeSharedStateForTests();
    vi.restoreAllMocks();
  });

  it('指向待编排列的关联线一律不渲染——无代表线、无折叠束，悬停（T17 门）也不豁免', () => {
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 'n0', lineId: 'l_main' },
          { nodeId: 'n1', lineId: 'l_main' },
          { nodeId: 'n2', lineId: 'l_main' },
          { nodeId: 'n3', lineId: 'l_main' },
          { nodeId: 'r_a', lineId: 'l_main' },
          { nodeId: 's_b', lineId: 'l_main' },
        ]}
      />
    );
    // 六场景全 dangling（两端 stub 在场——滤除在渲染面，非测量 miss）→ 零线。
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
    // hover 逐场景悬停（渲染门槛的 hover 半边全开）仍零——T4 滤面在 T17 门槛之外层。
    for (const card of [...container.querySelectorAll('.scene-card')]) {
      fireEvent.mouseOver(card);
      expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
    }
    // fold 族 DOM 契约（data-assoc-folded/fold-size/representative）随机制退役，
    // 属性面零残留。
    expect(
      container.querySelectorAll('[data-assoc-folded], [data-assoc-fold-size], [data-assoc-representative]')
    ).toHaveLength(0);
  });

  it('anomaly 成员无豁免：旧钢蓝口径的倒叙 dangling（r_a/s_b）悬停也零渲染', () => {
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 'n0', lineId: 'l_main' },
          { nodeId: 'n1', lineId: 'l_main' },
          { nodeId: 'n2', lineId: 'l_main' },
          { nodeId: 'n3', lineId: 'l_main' },
          { nodeId: 'r_a', lineId: 'l_main' },
          { nodeId: 's_b', lineId: 'l_main' },
        ]}
      />
    );
    // 旧断言「reordered dangling stays visible (anomaly exemption)」随 T4 推翻——
    // 信号完整性豁免只保已编排链路，pending 方向无例外（hover 门同样唤不出）。
    const cardOf = (id: string) =>
      [...container.querySelectorAll('.scene-card')].find((c) => c.getAttribute('data-node-id') === id)!;
    for (const id of ['r_a', 's_b']) {
      fireEvent.mouseOver(cardOf(id));
      expect(container.querySelector(`.assoc-link[data-node-id="${id}"]`)).toBeNull();
      expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
    }
  });

  it('selected/hover 双门都唤不出 pending；已编排链 hover 照常揭示', () => {
    // 混合 fixture：已编排 2 场景（ch0/ch1）+ dangling n1（ch90）。旧断言
    // 「selecting lifts the fold suppression」随 T4 推翻——选中态不再能唤出
    // pending 线；T17 后 hover 门同理。已编排链 hover 照常渲染。
    const g = danglingFoldGraph();
    g.nodes = [
      { id: 'ok1', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 }, title: '已编排一' },
      { id: 'ok2', lineTags: ['l_main'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 1, pos: 0 }, title: '已编排二' },
      ...g.nodes.filter((n) => n.id === 'n1'),
    ];
    useAppStore.setState({
      creativeFields: { scene_graph: g, episode_outlines: episodeOutlinesSchema.parse([
        { id: 'e0', index: 0, title: '第一章' },
        { id: 'e1', index: 1, title: '第二章' },
      ]) },
      selectedNodeId: 'n1',
    } as any);
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 'ok1', lineId: 'l_main' },
          { nodeId: 'ok2', lineId: 'l_main' },
          { nodeId: 'n1', lineId: 'l_main' },
        ]}
      />
    );
    const cardOf = (id: string) =>
      [...container.querySelectorAll('.scene-card')].find((c) => c.getAttribute('data-node-id') === id)!;
    // hover 已编排场景照常出弧（滤面不误伤正常链）。
    fireEvent.mouseOver(cardOf('ok1'));
    expect(container.querySelector('.assoc-link[data-node-id="ok1"]')).not.toBeNull();
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
    // hover pending 场景（叠加 selected 门）→ 零渲染（hover 换目标 = 滤集换成员）。
    fireEvent.mouseOver(cardOf('n1'));
    expect(container.querySelector('.assoc-link[data-node-id="n1"]')).toBeNull();
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
  });

  it('#75 transitional semantics: same-hue pairing emits zero gradient defs (solid baseline untouched)', () => {
    // 已编排 fixture（T4 后 dangling fixture 零渲染——零 defs 断言会空转，换
    // assocGraph + hover 放行保断言力：有真线渲染、仍零 defs）。
    useAppStore.setState({
      creativeFields: { scene_graph: assocGraph(), episode_outlines: assocEpisodes() },
    } as any);
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 's_plain', lineId: 'l_main' },
          { nodeId: 's_re', lineId: 'l_main' },
        ]}
      />
    );
    fireEvent.mouseOver(
      [...container.querySelectorAll('.scene-card')]
        .find((c) => c.getAttribute('data-node-id') === 's_plain')!
    );
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1); // 前置：确有真线
    // 当前 primary 配对两端恒同线 → resolveAssocPaint 恒 solid 分支，无 def 开销；
    // 跨线接入后本断言随配色策略一并修订（EdgeLayer 移植时复核）。
    expect(container.querySelectorAll('linearGradient')).toHaveLength(0);
    expect(container.querySelectorAll('defs > *')).toHaveLength(0);
  });

  it('threshold constant pinned at 3 (dispatch 拍板值)', () => {
    expect(PENDING_ASSOC_FOLD_THRESHOLD).toBe(3);
  });
});

describe('resolveAssocPaint / assocGradientId (#75 渐变解析纯函数 + 08-27 三轮 CR 防撞)', () => {
  it('same hue → solid; different hues → gradient carrying both endpoint hues', () => {
    expect(resolveAssocPaint(3, 3, 'node', 'x', 0)).toEqual({ mode: 'solid' });
    expect(resolveAssocPaint(2, 7, 'node', 'n1', 0)).toEqual({
      mode: 'gradient',
      fromHue: 2,
      toHue: 7,
      gradientId: assocGradientId('node', 'n1', 0),
    });
  });

  it('gradient ids whitelist the charset so url(#…) stays valid for hostile node ids', () => {
    // `_` 自身入转义域（→_005f）——id 段内 `_` 恒起 4 位 hex 转义组（单射前提）。
    expect(assocGradientId('node', 'plain-id_1', 0)).toBe('assoc-grad-node-plain-id_005f1-0');
    const hostile = assocGradientId('node', 's"q\\evil', 3);
    expect(hostile).toMatch(/^assoc-grad-node-[A-Za-z0-9_-]+$/);
    expect(hostile).not.toContain('"');
    expect(hostile).not.toContain('\\');
    // 确定性：同输入同串（React key/url 引用两处自洽）。
    expect(assocGradientId('node', 's"q\\evil', 3)).toBe(hostile);
  });

  it('blind V-F5: escaping is INJECTIVE — "a.b" and the literal "a_2e_b" no longer collide', () => {
    // 旧 `_xxhex_` 编码里 `.`(0x2e) → "_2e_" 恰与字面下划线串同形——同一
    // flatMap 内重复 gradientId（React key 重复 + url(#…) 文档全局解析取首个
    // def，颜色错画）。`_` 入转义域后两串分道（可前缀解码 ⇒ 单射）。
    const dotted = assocGradientId('node', 'a.b', 0);
    const literal = assocGradientId('node', 'a_2e_b', 0);
    // 转义形态 = `_` + 恰 4 位 hex（无尾下划线）——固定宽度组是可前缀解码的
    // 前提：`_` 恒起组、组后字符只能是白名单或新 `_`。
    expect(dotted).toBe('assoc-grad-node-a_002eb-0');
    expect(literal).toBe('assoc-grad-node-a_005f2e_005fb-0');
    expect(dotted).not.toBe(literal);
  });

  it('edge V-7: owner domain + render seq keep layer-crossing and duplicate ids apart', () => {
    // 跨层撞名：nodeId="edge-e1" 与 EdgeLayer 的 edgeId="e1" 曾共用
    // assoc-grad-edge-e1（两张 svg 同页共存，url(#…) 全局解析取首个 def）。
    expect(assocGradientId('node', 'edge-e1', 0)).not.toBe(assocGradientId('edge', 'e1', 0));
    // 渲染序后缀兜底脏数据同 id 重复项（path/def 消费同一数组同一下标）。
    expect(assocGradientId('node', 'dup', 0)).not.toBe(assocGradientId('node', 'dup', 1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T19（发现批9·悬停归属可读）：对照弧两端锚点圆点——配对语义可读化。冻结契约：
//  - 每条**揭示**弧恰两枚圆点（r=3，from/to 各一），坐标与弧端逐值同源；零弧
//    （默认态/pending 滤除）零圆点——渲染随弧走，非独立显隐面。
//  - **刻意无箭头**：对照弧是配对不是因果，加箭头会误导方向（用户拍板裁决——
//    「谁导致谁」的箭头归 EdgeLayer 因果边，见 edgeLayerGradient.test T19 组）。
//  - 倒叙钢蓝弧的圆点随弧线换 accent（.assoc-endpoint--reorder 信号一致性）。
// ─────────────────────────────────────────────────────────────────────────────

describe('T19: assoc endpoint anchor dots (悬停归属可读)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: assocGraph(), episode_outlines: assocEpisodes() },
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      canvasZoom: 1,
    } as any);
  });
  afterEach(() => {
    cleanup();
    // T26：nodeSharedState 是模块级共享态——用例间整仓复位（悬停键泄漏防线；
    // 生产由组件卸载的条件清兜底，测试面双保险）。
    __resetNodeSharedStateForTests();
    vi.restoreAllMocks();
  });

  it('每条揭示弧恰两枚端点圆点（r=3，from/to 各一）随弧渲染；默认零弧零圆点', () => {
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 's_plain', lineId: 'l_main' },
          { nodeId: 's_span', lineId: 'l_side' },
        ]}
      />
    );
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(0); // T17 默认零渲染
    expect(container.querySelectorAll('.assoc-endpoint')).toHaveLength(0); // 圆点随弧走
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_plain"]')!);
    const dots = [...container.querySelectorAll('.assoc-endpoint')] as SVGCircleElement[];
    expect(dots).toHaveLength(2);
    expect(dots.map((d) => d.getAttribute('data-assoc-end')).sort()).toEqual(['from', 'to']);
    expect(dots.every((d) => d.getAttribute('r') === '3')).toBe(true);
    expect(dots.every((d) => d.getAttribute('data-node-id') === 's_plain')).toBe(true);
    // 圆点自带 lane-hue 类（fill 的 --structure-line-color 是自定义属性——兄弟
    // path 上的类不遗传，CSS 解析面在自身）。
    expect(dots.every((d) => d.classList.contains(`lane-hue--c${lineHueIndex('l_main')}`))).toBe(true);
    // 配对语义：刻意零箭头载体（marker/path 均无——方向箭头归因果边）。
    expect(container.querySelectorAll('marker')).toHaveLength(0);
  });

  it('倒叙钢蓝弧的圆点随弧线换 accent（.assoc-endpoint--reorder 信号一致性）', () => {
    const { container } = render(
      <StandaloneCanvas nodes={[{ nodeId: 's_re', lineId: 'l_main' }]} />
    );
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_re"]')!);
    const dots = [...container.querySelectorAll('.assoc-endpoint')] as SVGCircleElement[];
    expect(dots).toHaveLength(2);
    expect(dots.every((d) => d.classList.contains('assoc-endpoint--reorder'))).toBe(true);
  });

  it('端点圆点坐标 = 弧端坐标（mock rect 换算链对拍——from/to 逐值同源）', () => {
    seedStore({ canvasZoom: 0.5 });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.classList.contains('structure-canvas')) {
        return rect(100, 200, 500, 800);
      }
      if (this.classList.contains('scene-card') && this.getAttribute('data-node-id') === 's_plain') {
        return rect(110, 260, 48, 50); // from = (68, 222)（既有端点换算用例同款）
      }
      if (this.classList.contains('workbench-chip') && this.getAttribute('data-node-id') === 's_plain') {
        return rect(130, 600, 100, 26); // to = (160, 798)
      }
      return rect(0, 0, 0, 0);
    });
    const { container } = render(<StructurePage />);
    fireEvent.mouseOver(container.querySelector('.scene-card[data-node-id="s_plain"]')!);
    const from = container.querySelector('.assoc-endpoint[data-assoc-end="from"]') as SVGCircleElement;
    const to = container.querySelector('.assoc-endpoint[data-assoc-end="to"]') as SVGCircleElement;
    expect(from.getAttribute('cx')).toBe('68');
    expect(from.getAttribute('cy')).toBe('222');
    expect(to.getAttribute('cx')).toBe('160');
    expect(to.getAttribute('cy')).toBe('798');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T25（发现批10·用户自诊「多线拷贝悬停错锚」）：锚弧逐实例锚定。冻结契约：
//  - 候选 = (nodeId × lineId) 逐实例（旧 primaryCellByNode 单份退役）——多线场景
//    每线一枚候选，骨架卡侧 ↔ 工作台 chip 侧同线配对；
//  - 悬停键 (nodeId, lineId) 对（nodeSharedState，载体 enter/leave 发布）——悬停
//    哪份拷贝画哪份的弧；选中 = 该场景全部线的弧（「活在哪些线」）；
//  - pending 滤面保持最外层（T4 不变）。
// T26 ②连带：悬停任一实例 → 同 nodeId 全实例（两区卡+chip）柔光类。
// ─────────────────────────────────────────────────────────────────────────────

/** 多线 fixture：s_dual 同时挂主线+副线（每线各一枚卡/chip 拷贝）+ 单线对照 s_solo。 */
function multiLineGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
      { id: 'l_side', name: '副线', topology_role: 'side' },
    ],
    nodes: [
      { id: 's_solo', lineTags: ['l_main'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 }, title: '单线' },
      { id: 's_dual', lineTags: ['l_main', 'l_side'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 1 }, title: '多线场景' },
    ],
    edges: [],
  });
}

function multiLineEpisodes() {
  return episodeOutlinesSchema.parse([{ id: 'e0', index: 0, title: '第一章' }]);
}

describe('T25: per-instance arc anchoring（多线拷贝悬停锚定）', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: multiLineGraph(),
        episode_outlines: multiLineEpisodes(),
      },
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      canvasZoom: 1,
    } as any);
  });
  afterEach(() => {
    cleanup();
    __resetNodeSharedStateForTests();
    vi.restoreAllMocks();
  });

  it('悬停哪份拷贝画哪份：hover 副线卡 → 恰一弧且 data-line-id=l_side；换悬停主线卡 → 换 l_main 弧', () => {
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 's_solo', lineId: 'l_main' },
          { nodeId: 's_dual', lineId: 'l_main' },
          { nodeId: 's_dual', lineId: 'l_side' },
        ]}
      />
    );
    const cardOf = (lid: string) =>
      container.querySelector(`.scene-card[data-node-id="s_dual"][data-line-id="${lid}"]`)!;
    // 旧缺陷形态：悬停任意拷贝恒从 primary（l_main）份画——T25 后按悬停身份。
    fireEvent.mouseOver(cardOf('l_side'));
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
    expect(container.querySelector('.assoc-link')!.getAttribute('data-line-id')).toBe('l_side');
    fireEvent.mouseOut(cardOf('l_side'));
    fireEvent.mouseOver(cardOf('l_main'));
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
    expect(container.querySelector('.assoc-link')!.getAttribute('data-line-id')).toBe('l_main');
  });

  it('选中态亮该场景全部线的弧（顺带回答「这场景活在哪些线」）；单线场景选中仍恰一弧', () => {
    useAppStore.setState({ selectedNodeId: 's_dual' } as any);
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 's_solo', lineId: 'l_main' },
          { nodeId: 's_dual', lineId: 'l_main' },
          { nodeId: 's_dual', lineId: 'l_side' },
        ]}
      />
    );
    const lids = [...container.querySelectorAll('.assoc-link')]
      .map((l) => l.getAttribute('data-line-id'))
      .sort();
    expect(lids).toEqual(['l_main', 'l_side']); // 全部线各一弧
    act(() => {
      useAppStore.setState({ selectedNodeId: 's_solo' } as any);
    });
    const soloLids = [...container.querySelectorAll('.assoc-link')]
      .map((l) => l.getAttribute('data-line-id'))
      .sort();
    expect(soloLids).toEqual(['l_main']); // 单线场景无多弧
  });

  it('端点锚定悬停实例的同线配对（mock rect 对拍）——不再错锚主线份', () => {
    // 用户自诊形态：悬停副线拷贝，弧却从主线（primary）那份画。mock 两线两套
    // 错开的 rect——旧实现（primaryCellByNode 单份）恒画主线对，新实现锚悬停对。
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.classList.contains('structure-canvas')) return rect(0, 0, 1000, 1000);
      const nid = this.getAttribute('data-node-id');
      const lid = this.getAttribute('data-line-id');
      if (nid === 's_dual' && lid === 'l_side') {
        if (this.classList.contains('scene-card')) return rect(300, 100, 40, 40); // from=(320,142)
        if (this.classList.contains('workbench-chip')) return rect(320, 500, 80, 26); // to=(360,498)
      }
      if (nid === 's_dual' && lid === 'l_main') {
        if (this.classList.contains('scene-card')) return rect(10, 100, 40, 40); // 旧错锚 from=(30,142)
        if (this.classList.contains('workbench-chip')) return rect(20, 500, 80, 26); // 旧错锚 to=(60,498)
      }
      return rect(0, 0, 0, 0);
    });
    const { container } = render(
      <StandaloneCanvas
        nodes={[
          { nodeId: 's_dual', lineId: 'l_main' },
          { nodeId: 's_dual', lineId: 'l_side' },
        ]}
      />
    );
    // 悬停副线工作台 chip（用户场景：工作台侧触发）→ 两端锚 l_side 卡/chip。
    fireEvent.mouseOver(
      container.querySelector('.workbench-chip[data-node-id="s_dual"][data-line-id="l_side"]')!
    );
    const path = container.querySelector('.assoc-link[data-node-id="s_dual"]') as SVGElement;
    const d = path.getAttribute('d') ?? '';
    expect(d.startsWith('M 320 142')).toBe(true); // l_side 卡底中点（非主线 30,142）
    expect(d.endsWith('360 498')).toBe(true); // l_side chip 顶中点（非主线 60,498）
  });

  it('StructurePage 真组件面：悬停副线工作台 chip → 恰一弧锚 l_side；多线拷贝静态标记 + 兄弟柔光两区齐亮', () => {
    const { container } = render(<StructurePage />);
    const sideChip = container.querySelector(
      '.workbench-chip[data-node-id="s_dual"][data-line-id="l_side"]'
    ) as HTMLElement;
    const mainChip = container.querySelector(
      '.workbench-chip[data-node-id="s_dual"][data-line-id="l_main"]'
    ) as HTMLElement;
    const mainCard = container.querySelector(
      '[data-skeleton="causal"] .scene-card[data-node-id="s_dual"][data-line-id="l_main"]'
    ) as HTMLElement;
    const sideCard = container.querySelector(
      '[data-skeleton="causal"] .scene-card[data-node-id="s_dual"][data-line-id="l_side"]'
    ) as HTMLElement;
    expect(sideChip && mainChip && mainCard && sideCard).toBeTruthy();

    // T26 ② 静态标记：多线场景两区四枚实例全带（chip 圆号双环类 + data-multiline；
    // 卡侧回声条类）。单线对照不带。
    expect(sideChip.getAttribute('data-multiline')).toBe('true');
    expect(sideChip.querySelector('.workbench-chip-ord')!.classList.contains('workbench-chip-ord--multiline')).toBe(true);
    expect(mainCard.classList.contains('scene-card--multiline')).toBe(true);
    const soloChip = container.querySelector('.workbench-chip[data-node-id="s_solo"]') as HTMLElement;
    const soloCard = container.querySelector(
      '[data-skeleton="causal"] .scene-card[data-node-id="s_solo"]'
    ) as HTMLElement;
    expect(soloChip.getAttribute('data-multiline')).toBe('false');
    expect(soloChip.querySelector('.workbench-chip-ord')!.classList.contains('workbench-chip-ord--multiline')).toBe(false);
    expect(soloCard.classList.contains('scene-card--multiline')).toBe(false);

    // T26 ② 兄弟柔光：悬停副线 chip → 同 nodeId 全实例（两 chip + 两卡）齐亮。
    fireEvent.mouseOver(sideChip);
    expect(sideChip.classList.contains('workbench-chip--sibling-lit')).toBe(true);
    expect(mainChip.classList.contains('workbench-chip--sibling-lit')).toBe(true);
    expect(mainCard.classList.contains('scene-card--sibling-lit')).toBe(true);
    expect(sideCard.classList.contains('scene-card--sibling-lit')).toBe(true);
    expect(soloChip.classList.contains('workbench-chip--sibling-lit')).toBe(false);
    // T25：恰一弧且锚悬停的副线实例（真组件 enter/leave 发布——非 stub 契约）。
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(1);
    expect(container.querySelector('.assoc-link')!.getAttribute('data-line-id')).toBe('l_side');
    // 离开载体：柔光全清 + 弧卸载。
    fireEvent.mouseOut(sideChip);
    expect(mainChip.classList.contains('workbench-chip--sibling-lit')).toBe(false);
    expect(mainCard.classList.contains('scene-card--sibling-lit')).toBe(false);
    expect(container.querySelectorAll('.assoc-link')).toHaveLength(0);
  });
});
