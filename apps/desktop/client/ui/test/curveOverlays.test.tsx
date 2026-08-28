/**
 * dogfood R2 批次 B（SP-4）：情绪/节奏叠层 + 工具栏重组 测试。
 *
 * 三层：
 *   1. deriveEmotionTint / pacingHeatOpacity 纯函数（色相三档边界 / 多角色均值 /
 *      语义词-only 档 / 热度不透明度区间）。
 *   2. NarrativeTimelinePanel 集成（store setState 驱动——同 NarrativeTimelinePanel
 *      .test 约定）：色条渲染、toggle 门控、像素定位（常量换算，jsdom 可精确断言）、
 *      hover title 原始情绪词、粒度降级（refId 非场景 id → 零渲染）。
 *   3. StructurePage（08-26 批 3 单列堆叠）：因果骨架挂情绪叠层（阅读骨架退役）。
 *
 * Run: `cd apps/desktop/client/ui && pnpm test curveOverlays`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sceneGraphSchema, episodeOutlinesSchema, type SceneGraph } from '@orison/shared-contracts';
import { NarrativeTimelinePanel } from '../src/features/structure/NarrativeTimelinePanel';
import { StructurePage } from '../src/features/structure/StructurePage';
import { deriveEmotionTint } from '../src/features/structure/EmotionOverlay';
import { pacingHeatOpacity } from '../src/features/structure/PacingOverlay';
import { WORKBENCH_GEOMETRY } from '../src/features/structure/workbenchLayout';
import { TIMELINE_GEOMETRY } from '../src/features/structure/timelineGeometry';
import { useAppStore } from '../src/shared/store/appStore';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

// 批 7 章轴：卡列位来自章归属——四章 pool 让 presentationOrder 解析命中真实轨道。
const EPISODES = () =>
  episodeOutlinesSchema.parse(
    Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, index: i, title: `第${i + 1}章` })),
  );

/**
 * Fixture：l1（主线）+ l2（副线）；s2 双线归属（情绪条应出 2 枚——每 cell 一枚）。
 * 批 7 章轴：全部场景 chapter=0 → 同（l1, 章0）格碰撞堆 4 张（storyTime 定纵向序）。
 *   s1@t1 pos（sceneVad v=0.8/a=1 → 满饱和绿条）
 *   s2@t2 neg（两角色 vad 均值 v=-0.3/a=0.25 → 红条）
 *   s3@t3 semantic-only（只有语义词，无 VAD → 中性 accent 条）
 *   s4@t4 无情绪点（无条）
 */
function graph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true },
      { id: 'l2', name: '副线', topology_role: 'side' },
    ],
    nodes: [
      { id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      { id: 's2', lineTags: ['l1', 'l2'], storyTime: 2, role: 'normal', presentationOrder: { chapter: 0, pos: 1 } },
      { id: 's3', lineTags: ['l1'], storyTime: 3, role: 'normal', presentationOrder: { chapter: 0, pos: 2 } },
      { id: 's4', lineTags: ['l1'], storyTime: 4, role: 'normal', presentationOrder: { chapter: 0, pos: 3 } },
    ],
    edges: [],
  });
}

function emotionCurve() {
  return {
    unit: 'scene' as const,
    points: [
      { refId: 's1', sceneMood: '昂扬', sceneVad: { v: 0.8, a: 1, d: 0 } },
      {
        refId: 's2',
        characters: [
          { characterId: 'c1', emotion: '平静', vad: { v: 0, a: 0, d: 0 } },
          { characterId: 'c2', emotion: '恐惧', vad: { v: -0.6, a: 0.5, d: 0 } },
        ],
      },
      { refId: 's3', characters: [{ characterId: 'c1', emotion: '期待', emotionEnd: '释然' }] },
      { refId: 'sX-unknown', sceneMood: '幽灵点（refId 不指向任何场景）' },
    ],
  };
}

function pacingCurve() {
  return {
    unit: 'scene' as const,
    points: [
      { refId: 's1', intensity: 0 },
      { refId: 's4', intensity: 10 },
      { refId: 'ch-1', intensity: 7 }, // 粒度污染守卫：非场景 refId 不应渲染
    ],
  };
}

const ALL_ON = { validation: true, displacement: true, visibility: true, emotion: true, pacing: true };

describe('deriveEmotionTint (pure)', () => {
  it('valence tiers: >+0.15 pos / <-0.15 neg / middle amber', () => {
    const mk = (v: number) => ({ refId: 'x', sceneVad: { v, a: 0, d: 0 } });
    expect(deriveEmotionTint(mk(0.16)).tier).toBe('pos');
    expect(deriveEmotionTint(mk(-0.16)).tier).toBe('neg');
    expect(deriveEmotionTint(mk(0.15)).tier).toBe('mid');
    expect(deriveEmotionTint(mk(-0.15)).tier).toBe('mid');
    expect(deriveEmotionTint(mk(0)).tier).toBe('mid');
  });

  it('arousal drives bar opacity: -1 → 0.4 floor, +1 → 1.0 ceiling', () => {
    const mk = (a: number) => ({ refId: 'x', sceneVad: { v: 0.5, a, d: 0 } });
    expect(deriveEmotionTint(mk(-1)).opacity).toBeCloseTo(0.4, 10);
    expect(deriveEmotionTint(mk(1)).opacity).toBeCloseTo(1.0, 10);
    expect(deriveEmotionTint(mk(0)).opacity).toBeCloseTo(0.7, 10);
  });

  it('out-of-range arousal clamps to [-1,1] before mapping (CR-13, mirror pacingHeatOpacity)', () => {
    const mk = (a: number) => ({ refId: 'x', sceneVad: { v: 0.5, a, d: 0 } });
    // 越界值（畸形 patch / 多角色均值溢出）不得破 0.4 底或超 1。
    expect(deriveEmotionTint(mk(5)).opacity).toBeCloseTo(1.0, 10);
    expect(deriveEmotionTint(mk(-7)).opacity).toBeCloseTo(0.4, 10);
    expect(deriveEmotionTint(mk(1.5)).opacity).toBeCloseTo(1.0, 10);
  });

  it('multi-character mean: opposing character VADs fold into the average (no first-line bias)', () => {
    const point = {
      refId: 'x',
      characters: [
        { characterId: 'c1', emotion: 'A', vad: { v: 0, a: 0, d: 0 } },
        { characterId: 'c2', emotion: 'B', vad: { v: -0.6, a: 0.5, d: 0 } },
      ],
    };
    const tint = deriveEmotionTint(point);
    expect(tint.tier).toBe('neg'); // mean v = -0.3
    expect(tint.opacity).toBeCloseTo(0.775, 10); // mean a = 0.25 → 0.4 + 0.3*1.25
  });

  it('semantic-only (no VAD anywhere) → neutral accent tier, fixed opacity, verbatim words in title', () => {
    const tint = deriveEmotionTint({
      refId: 'x',
      sceneMood: '忐忑',
      characters: [{ characterId: 'c1', emotion: '期待', emotionEnd: '释然' }],
    });
    expect(tint.tier).toBe('semantic');
    expect(tint.opacity).toBe(0.8);
    expect(tint.title).toBe('忐忑 · 期待→释然');
  });

  it('pacing strip opacity maps intensity 0..10 → 0.4..1.0 (clamped; batch 5 strip carrier)', () => {
    // 批 5（R5）：载体改格顶 3px 细条（面积缩 ~10×）→ 映射自 0.06..0.25 上调。
    expect(pacingHeatOpacity(0)).toBeCloseTo(0.4, 10);
    expect(pacingHeatOpacity(10)).toBeCloseTo(1, 10);
    expect(pacingHeatOpacity(5)).toBeCloseTo(0.7, 10);
    expect(pacingHeatOpacity(-3)).toBeCloseTo(0.4, 10); // 越界裁剪
    expect(pacingHeatOpacity(99)).toBeCloseTo(1, 10);
  });
});

describe('curve overlays via NarrativeTimelinePanel (integration)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: graph(), episode_outlines: EPISODES(), emotion_curve: emotionCurve(), pacing_curve: pacingCurve() },
      overlayToggles: { ...ALL_ON },
      resolvedLocale: 'en-US',
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders one emotion bar per card whose node has an emotion point (multi-line node → 2 bars)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const bars = container.querySelectorAll('.emotion-bar');
    // s1(1 卡) + s2(2 卡, 双线) + s3(1 卡) = 4；s4 无点；sX-unknown 不指向场景。
    expect(bars).toHaveLength(4);
    // 08-26 批 2：色条迁入卡内（原绝对定位叠层退役）——每枚都在 .scene-card 里。
    for (const bar of bars) {
      expect((bar as HTMLElement).closest('.scene-card')).not.toBeNull();
    }
  });

  it('tiers land as classes: pos green / neg red / semantic accent', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    expect(container.querySelectorAll('.emotion-bar--pos')).toHaveLength(1); // s1
    expect(container.querySelectorAll('.emotion-bar--neg')).toHaveLength(2); // s2 的两枚卡
    expect(container.querySelectorAll('.emotion-bar--semantic')).toHaveLength(1); // s3
  });

  it('bar is CSS-positioned inside the card (in-card since 08-26 批 2) with arousal opacity inline', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const bar = container.querySelector('[data-emo-node="s1"]') as HTMLElement;
    expect(bar).not.toBeNull();
    // 定位交 CSS（.scene-card .emotion-bar 卡底 3px）——inline 只剩不透明度（arousal
    // 代理，s1 a=1 → 1.0）。旧常量坐标断言随叠层退役删除。
    expect(bar.style.left).toBe('');
    expect(bar.style.top).toBe('');
    expect(bar.style.opacity).toBe('1');
  });

  it('hover title carries the verbatim emotion words', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const s1 = container.querySelector('[data-emo-node="s1"]') as HTMLElement;
    expect(s1.getAttribute('title')).toBe('昂扬');
    const s3 = container.querySelector('[data-emo-node="s3"]') as HTMLElement;
    expect(s3.getAttribute('title')).toBe('期待→释然');
  });

  it('toggle off → no bars render and the retired absolute layer stays absent', () => {
    useAppStore.setState({ overlayToggles: { ...ALL_ON, emotion: false } } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    expect(container.querySelectorAll('.emotion-bar')).toHaveLength(0);
    // 退役守卫：原 .emotion-overlay 绝对定位层不再挂载（批 2 迁入卡内）。
    expect(container.querySelector('.emotion-overlay')).toBeNull();
  });

  it('renders one pacing strip per matched card; intensity → strip opacity 0.4..1.0 (batch 5 strip carrier)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const heats = container.querySelectorAll('.pacing-heat');
    // s1 + s4 各 1 卡；'ch-1'（非场景 refId）零命中。
    expect(heats).toHaveLength(2);
    const s1 = container.querySelector('[data-heat-node="s1"]') as HTMLElement;
    const s4 = container.querySelector('[data-heat-node="s4"]') as HTMLElement;
    // 批 5（R5）：整格铺色 → 格顶 3px 细条；载体面积缩 ~10× → 强度映射上调 0.4..1.0。
    expect(s1.style.opacity).toBe('0.4');
    expect(s4.style.opacity).toBe('1');
    // 定位：overlayCardBox 双查表卡盒（行高/列宽 jsdom 名义回退——height 固定 3px）。
    // 批 7 章轴：四章全落（l1, 章0）格碰撞堆 4 张——s4 故事时序最大 → subIndex 3。
    // row 高回退 64 → 每卡 16；col 宽名义 = chapterMinWidth 108。
    const { laneLabelWidth, cellStackPadding, headerHeight, rowHeight } = TIMELINE_GEOMETRY;
    const cardH = rowHeight / 4;
    expect(s4.style.left).toBe(`${laneLabelWidth + cellStackPadding}px`);
    expect(s4.style.top).toBe(`${headerHeight + cardH * 3 + cellStackPadding}px`);
    expect(s4.style.width).toBe(`${WORKBENCH_GEOMETRY.chapterMinWidth - 2 * cellStackPadding}px`);
    expect(s4.style.height).toBe('3px');
  });

  it('pacing granularity degradation: chapter-unit refIds match no scene → pacing layer renders nothing (no hardcoded unit gate)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: graph(),
        emotion_curve: { unit: 'chapter', points: [{ refId: 'ch-1', sceneMood: 'x' }] },
        pacing_curve: { unit: 'chapter', points: [{ refId: 'ch-1', intensity: 8 }] },
      },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    expect(container.querySelector('.pacing-overlay')).toBeNull();
    // 情绪侧同源降级：refId 无命中 → 卡内无底条。
    expect(container.querySelectorAll('.emotion-bar')).toHaveLength(0);
  });

  it('malformed curve data degrades silently (no bars, no crash)', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: graph(), emotion_curve: { nonsense: true }, pacing_curve: null },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    expect(container.querySelectorAll('.scene-card')).toHaveLength(5);
    expect(container.querySelectorAll('.emotion-bar')).toHaveLength(0);
    expect(container.querySelector('.pacing-overlay')).toBeNull();
  });

  it('toolbar renders two groups + separator + disabled foreshadow placeholder', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const toolbar = container.querySelector('.narrative-timeline-toolbar') as HTMLElement;
    expect(toolbar).not.toBeNull();
    // 分组分隔线在第一组三开关与曲线组之间。
    expect(toolbar.querySelector('.narrative-timeline-toolbar-sep')).not.toBeNull();
    // 第二组：情绪/节奏可切换，伏笔禁用占位。
    const emotionToggle = toolbar.querySelector('[data-overlay-key="emotion"]') as HTMLInputElement;
    const pacingToggle = toolbar.querySelector('[data-overlay-key="pacing"]') as HTMLInputElement;
    const foreshadowToggle = toolbar.querySelector('[data-overlay-key="foreshadow"]') as HTMLInputElement;
    expect(emotionToggle.checked).toBe(true);
    expect(pacingToggle.checked).toBe(true);
    expect(foreshadowToggle.disabled).toBe(true);
    // 文案来自 i18n（en locale fixture）。
    expect(toolbar.textContent).toContain('Emotion');
    expect(toolbar.textContent).toContain('Pacing');
    expect(toolbar.textContent).toContain('Foreshadow (reserved)');
    // 预留位 tooltip 说明来源（title 在 label 上——禁用 input 的 hover 不稳）。
    const label = foreshadowToggle.closest('label') as HTMLElement;
    expect(label.getAttribute('title')).toContain('promise-panel');
  });

  it('toggling emotion via the toolbar checkbox clears the bars (wired to toggleOverlay)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    expect(container.querySelectorAll('.emotion-bar')).toHaveLength(4);
    const emotionToggle = container.querySelector('[data-overlay-key="emotion"]') as HTMLInputElement;
    emotionToggle.click();
    expect(useAppStore.getState().overlayToggles.emotion).toBe(false);
  });
});

describe('curve overlays on the structure page (08-26 批 3 single-column stacking)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: graph(), episode_outlines: EPISODES(), emotion_curve: emotionCurve(), pacing_curve: pacingCurve() },
      overlayToggles: { ...ALL_ON },
      resolvedLocale: 'en-US',
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('emotion bars render on the causal skeleton（阅读骨架退役——工作台 chip 无情绪条）', () => {
    const { container } = render(<StructurePage />);
    const causalBars = container.querySelectorAll('[data-skeleton="causal"] .emotion-bar');
    expect(causalBars.length).toBe(4);
    // 阅读骨架渲染分支已删（批 3）——不存在第二副骨架。
    expect(container.querySelector('[data-skeleton="reading"]')).toBeNull();
  });

  it('volume band strip + minimap mount once (causal side; workbench bands are in-grid)', () => {
    const { container } = render(<StructurePage />);
    expect(container.querySelectorAll('[data-volume-band-strip]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-minimap-track]')).toHaveLength(1);
    // 无 outline 数据 → 卷带空派生（strip 空行恒占高、无 band 格；工作台 in-grid
    // band 同数据源亦空）。
    expect(container.querySelectorAll('[data-band-phase]')).toHaveLength(0);
  });
});

// ── 批 8（implement 8.4）：曲线数据缺失 → 开关禁用 + title 提示 ──
// 诊断定谳：接线完好（toggle 即总闸）但草稿项目无曲线数据 → 勾选无视觉的「假坏
// 死」。修法 = 缺数据的开关渲染为 disabled + 结构性说明，诚实零反馈。

describe('curve overlay toggles go honestly DISABLED while their data is missing (batch 8.4)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: graph(), episode_outlines: EPISODES() },
      overlayToggles: { ...ALL_ON },
      resolvedLocale: 'en-US',
    } as any);
  });
  afterEach(() => cleanup());

  const toggleOf = (container: HTMLElement, key: string) =>
    container.querySelector(`[data-overlay-key="${key}"]`) as HTMLInputElement;

  it('data present → both curve toggles stay enabled (and carry no disabled chrome)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: graph(),
        episode_outlines: EPISODES(),
        emotion_curve: emotionCurve(),
        pacing_curve: pacingCurve(),
      },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    expect(toggleOf(container, 'emotion').disabled).toBe(false);
    expect(toggleOf(container, 'pacing').disabled).toBe(false);
    expect((toggleOf(container, 'emotion').closest('label') as HTMLElement).className)
      .not.toContain('--disabled');
  });

  it('curves absent → disabled checkboxes whose labels explain the missing data (per-kind i18n)', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    const expected = { emotion: 'No emotion annotation', pacing: 'No pacing annotation' };
    for (const key of ['emotion', 'pacing'] as const) {
      const input = toggleOf(container, key);
      expect(input.disabled).toBe(true);
      // slice 态保留（数据补上后以上次偏好直接生效）。
      expect(input.checked).toBe(true);
      const label = input.closest('label') as HTMLElement;
      expect(label.className).toContain('narrative-timeline-toolbar-toggle--disabled');
      expect(label.getAttribute('title')).toContain(expected[key]);
    }
  });

  it('malformed or empty-points curves count as MISSING (zero visuals ⇒ not a live switch)', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: graph(),
        episode_outlines: EPISODES(),
        emotion_curve: { nonsense: true },
        pacing_curve: { unit: 'scene', points: [] },
      },
    } as any);
    const { container } = render(<NarrativeTimelinePanel />);
    expect(toggleOf(container, 'emotion').disabled).toBe(true);
    expect(toggleOf(container, 'pacing').disabled).toBe(true);
  });

  it('first-group toggles (validation/displacement/visibility) are untouched by curve availability', () => {
    const { container } = render(<NarrativeTimelinePanel />);
    for (const key of ['validation', 'displacement', 'visibility']) {
      expect(toggleOf(container, key).disabled).toBe(false);
    }
  });
});
