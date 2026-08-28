/**
 * 08-26 结构页重构 批 2（implement 2.3 / prd R2 / design §5）：图例完备性验收。
 *
 * 「图例完备是验收线」：任何视觉记号（角标三族/情绪条/位移/阅读序/选中/线色/
 * 角色形状）不入图例不许上线（mockup 五轮教训）。本文件以 canonical key 清单
 * 断言每视觉记号 ≥1 图例项——新增视觉记号不同步补图例即在此爆红。
 *
 * 兼测线色示例块的数据驱动渲染（per-line swatch + 超 6 线折叠 +N）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run structureLegend`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sceneGraphSchema } from '@orison/shared-contracts';
import { StructureLegend } from '../src/features/structure/StructureLegend';
import { StructurePage } from '../src/features/structure/StructurePage';
import { lineHueIndex } from '../src/features/structure/linePalette';
import { useAppStore } from '../src/shared/store/appStore';

/** canonical 视觉记号 key 清单——与 StructureLegend 的 data-legend-key 一一对应。
 *  新增视觉记号 = 此处加 key + 组件补项，两处同步（本测试就是同步锁）。 */
const VISUAL_MARK_KEYS = [
  'line-hue',            // 线身份色相
  'role-glyph',          // 角色四形状
  'selected-ring',       // 选中外环
  'ai-new',              // AI 新增 ✦ 角标
  'validation',          // 校验角标（error/warning/info 三族）
  'emotion-bar',         // 情绪底条三档
  'displacement',        // 位移虚线边框
  'reorder-ordinal',     // 钢蓝阅读序（工作台 chip）
  'visibility-opacity',  // 批 B（CR 组 3b）：可见性 = 透明度（R2 六维矩阵补齐）
  'pacing-heat',         // 批 B：节奏热度 = 格顶细条（叠层默认关）
  'palette-note',        // 色板 12 循环说明
  'assoc-anchor',        // 批 8.5：竖弧＝同场景跨视图对照锚（错位三类+选中默认画）
  'causal-edge',         // 批 8.5：区内实/虚线＝因果边/悬念边
  'cross-line',          // 批 8.5：跨线连接＝跨线引用
  // ── 08-27 追加批3（R12 教育）：三种合法章格形态「何时发生」──
  'span-wide',           // 宽卡＝一场延续多章（边缘直拖调出）
  'stack-order',         // 堆叠＝一章多场按阅读序
  'empty-slot',          // 空章＝章已建待填（淡标注+顺手新建）
] as const;

const LINES = [
  { id: 'main', name: '主线' },
  { id: 'roman', name: '感情线' },
  { id: 'school', name: '校园线' },
  { id: 'family', name: '家庭线' },
];

describe('StructureLegend 完备性（08-26 批 2 验收线；批 5 #43 默认折叠）', () => {
  beforeEach(() => {
    useAppStore.setState({ resolvedLocale: 'zh-CN', legendExpanded: false } as any);
  });
  afterEach(() => cleanup());

  it('#43 default COLLAPSED: one toggle + one-line summary, zero legend items rendered', () => {
    const { container } = render(<StructureLegend lines={LINES} />);
    const legend = container.querySelector('[data-structure-legend]') as HTMLElement;
    expect(legend.getAttribute('data-legend-state')).toBe('collapsed');
    // 折叠态：记号项零渲染（用户「异常庞大」的减法）——完备性断言只对展开态。
    expect(container.querySelectorAll('[data-legend-key]')).toHaveLength(0);
    // toggle 钮 + 摘要行在场。
    expect(container.querySelector('[data-legend-toggle]')).not.toBeNull();
    const summary = container.querySelector('[data-legend-summary]') as HTMLElement;
    expect(summary?.textContent).toContain('线色');
  });

  it('#43 clicking the toggle expands → all canonical keys render; clicking again collapses', () => {
    const { container } = render(<StructureLegend lines={LINES} />);
    const toggle = container.querySelector('[data-legend-toggle]') as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(useAppStore.getState().legendExpanded).toBe(true);
    expect(container.querySelector('[data-structure-legend]')!.getAttribute('data-legend-state')).toBe('expanded');
    for (const key of VISUAL_MARK_KEYS) {
      const items = container.querySelectorAll(`[data-legend-key="${key}"]`);
      expect(items.length, `legend key "${key}" must have ≥1 item (expanded)`).toBeGreaterThanOrEqual(1);
    }
    // 再点回收（会话记忆态翻转）。
    fireEvent.click(container.querySelector('[data-legend-toggle]')!);
    expect(container.querySelectorAll('[data-legend-key]')).toHaveLength(0);
  });

  it('每个视觉记号 ≥1 图例项（canonical key 全presence 断言——展开态）', () => {
    useAppStore.setState({ legendExpanded: true } as any);
    const { container } = render(<StructureLegend lines={LINES} />);
    for (const key of VISUAL_MARK_KEYS) {
      const items = container.querySelectorAll(`[data-legend-key="${key}"]`);
      expect(items.length, `legend key "${key}" must have ≥1 item`).toBeGreaterThanOrEqual(1);
    }
  });

  it('线色示例块数据驱动：每线一枚 hue 色块（lane-hue 同款挂法）', () => {
    useAppStore.setState({ legendExpanded: true } as any);
    const { container } = render(<StructureLegend lines={LINES} />);
    const swatches = container.querySelectorAll('.structure-legend-hue');
    expect(swatches).toHaveLength(4);
    const first = swatches[0] as HTMLElement;
    expect(first.classList.contains(`lane-hue--c${lineHueIndex('main')}`)).toBe(true);
    expect(first.getAttribute('title')).toBe('主线');
  });

  it('超上限线数折叠为 +N（图例是记号说明不是线清单）', () => {
    useAppStore.setState({ legendExpanded: true } as any);
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, name: `线${i}` }));
    const { container } = render(<StructureLegend lines={many} />);
    expect(container.querySelectorAll('.structure-legend-hue')).toHaveLength(6);
    expect(container.querySelector('.structure-legend-note')?.textContent).toBe('+3');
  });

  it('批 8.5「两套线」连线说明段：三 key 落在 palette-note 之后（展开态末尾）+ 语义抽查', () => {
    useAppStore.setState({ legendExpanded: true } as any);
    const { container } = render(<StructureLegend lines={LINES} />);
    const keys = [...container.querySelectorAll('[data-legend-key]')]
      .map((el) => el.getAttribute('data-legend-key') ?? '');
    const paletteIdx = keys.indexOf('palette-note');
    expect(paletteIdx).toBeGreaterThan(-1);
    for (const k of ['assoc-anchor', 'causal-edge', 'cross-line']) {
      expect(keys.indexOf(k), `wizard key "${k}" present`).toBeGreaterThan(-1);
      expect(keys.indexOf(k), `wizard key "${k}" trails the palette note`).toBeGreaterThan(paletteIdx);
    }
    // zh fixture 语义抽查：竖弧条目提「对照锚 + T17 默认不显示/悬停选中显示」；
    // 区内边提因果/悬念；跨线条目提跨线引用。T7 移交补文：竖弧/区内边各带
    // 「待编排端点不画」后缀（pending 端零渲染已落 AssocLayer/NTP——图例不得说谎）。
    const anchor = container.querySelector('[data-legend-key="assoc-anchor"]') as HTMLElement;
    expect(anchor.textContent).toContain('竖弧线');
    expect(anchor.textContent).toContain('对照锚');
    expect(anchor.textContent).toContain('默认不显示'); // T17：零渲染基线
    expect(anchor.textContent).toContain('悬停');
    expect(anchor.textContent).toContain('选中');
    expect(anchor.textContent).toContain('倒叙');
    expect(anchor.textContent).toContain('待编排');
    const causal = container.querySelector('[data-legend-key="causal-edge"]') as HTMLElement;
    expect(causal.textContent).toContain('实线＝因果');
    expect(causal.textContent).toContain('虚线＝悬念');
    expect(causal.textContent).toContain('待编排');
    const cross = container.querySelector('[data-legend-key="cross-line"]') as HTMLElement;
    expect(cross.textContent).toContain('跨线引用');
  });

  it('08-27 追加批3：三种章格形态教育条目排在「两套线」段之后 + zh 文本抽查', () => {
    useAppStore.setState({ legendExpanded: true } as any);
    const { container } = render(<StructureLegend lines={LINES} />);
    const keys = [...container.querySelectorAll('[data-legend-key]')]
      .map((el) => el.getAttribute('data-legend-key') ?? '');
    const crossIdx = keys.indexOf('cross-line');
    expect(crossIdx).toBeGreaterThan(-1);
    for (const k of ['span-wide', 'stack-order', 'empty-slot']) {
      const idx = keys.indexOf(k);
      expect(idx, `education key "${k}" present`).toBeGreaterThan(-1);
      expect(idx, `education key "${k}" trails the link-legend block`).toBeGreaterThan(crossIdx);
    }
    // zh 文本抽查（blind V-F9 + auditor V-F6：六键双语早已在 81e3b8c/88c92f7
    // 合入、key 名严格一致，原 TODO 条件已满足——补齐抽查，key 改名或 t() 回退
    // 裸键名都无法再静默通过）。
    const wide = container.querySelector('[data-legend-key="span-wide"]') as HTMLElement;
    expect(wide.textContent).toContain('跨章');   // 宽卡＝一场延续多章
    expect(wide.textContent).toContain('边缘');   // 边缘直拖调出
    const stack = container.querySelector('[data-legend-key="stack-order"]') as HTMLElement;
    expect(stack.textContent).toContain('阅读序'); // 堆叠＝一章多场按阅读序
    const empty = container.querySelector('[data-legend-key="empty-slot"]') as HTMLElement;
    expect(empty.textContent).toContain('章已建立'); // 空章＝章已建待填
    expect(empty.textContent).toContain('新建');
  });

  it('08-27 追加批3：三条款 en-US 文本抽查（双语锚——防单语侧静默漂移）', () => {
    useAppStore.setState({ legendExpanded: true, resolvedLocale: 'en-US' } as any);
    const { container } = render(<StructureLegend lines={LINES} />);
    expect(container.querySelector('[data-legend-key="span-wide"]')?.textContent)
      .toContain('spans chapters');
    expect(container.querySelector('[data-legend-key="stack-order"]')?.textContent)
      .toContain('reading sequence');
    expect(container.querySelector('[data-legend-key="empty-slot"]')?.textContent)
      .toContain('no scenes yet');
    // T7 移交补文（en 侧同步锚）：竖弧/区内边的「unscheduled 端点不画」后缀 +
    // T17 双语锚（hover-or-selection 是唯一显示门——防单语侧静默漂移）。
    expect(container.querySelector('[data-legend-key="assoc-anchor"]')?.textContent)
      .toContain('unscheduled');
    expect(container.querySelector('[data-legend-key="assoc-anchor"]')?.textContent)
      .toContain('Hidden by default');
    expect(container.querySelector('[data-legend-key="causal-edge"]')?.textContent)
      .toContain('unscheduled');
  });

  it('校验三族/情绪三档/角色四形状的演示元素齐备（记号本体可辨认）', () => {
    useAppStore.setState({ legendExpanded: true } as any);
    const { container } = render(<StructureLegend lines={LINES} />);
    // 校验三族（error/warning/info）。
    expect(container.querySelectorAll('.structure-legend-demo-badge')).toHaveLength(3);
    expect(container.querySelector('.structure-legend-demo-badge--info')).not.toBeNull();
    // 情绪三档（pos/mid/neg）。
    expect(container.querySelectorAll('.structure-legend-demo-emo')).toHaveLength(3);
    // 角色四形状（★◆●◇——i18n role labels 自带 glyph）。
    const glyphs = container.querySelector('[data-legend-key="role-glyph"]');
    expect(glyphs?.textContent).toContain('★');
    expect(glyphs?.textContent).toContain('◆');
    expect(glyphs?.textContent).toContain('●');
    expect(glyphs?.textContent).toContain('◇');
    // ✦ AI 新增演示 + 位移虚线演示 + 钢蓝序号演示。
    expect(container.querySelector('.structure-legend-demo-new')?.textContent).toBe('✦');
    expect(container.querySelector('.structure-legend-demo-disp')).not.toBeNull();
    expect(container.querySelector('.structure-legend-demo-ord')).not.toBeNull();
    // 批 B 补齐两族：可见性（透明度）+ 节奏热度格顶细条的演示元素在场。
    expect(container.querySelector('[data-legend-key="visibility-opacity"] .structure-legend-demo-hidden')).not.toBeNull();
    expect(container.querySelector('[data-legend-key="pacing-heat"] .structure-legend-demo-pacing')).not.toBeNull();
  });

  it('挂在 StructurePage 工具栏（缩放组）之下、canvas 之外（chrome 不随缩放）', () => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: sceneGraphSchema.parse({
          lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
          nodes: [{ id: 's1', lineTags: ['l1'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } }],
          edges: [],
        }),
      },
      resolvedLocale: 'zh-CN',
      legendExpanded: false,
    } as any);
    const { container } = render(<StructurePage />);
    const legend = container.querySelector('[data-structure-legend]');
    const zoombar = container.querySelector('.structure-zoombar');
    const canvas = container.querySelector('[data-structure-canvas]');
    expect(legend).not.toBeNull();
    expect(zoombar).not.toBeNull();
    expect(canvas).not.toBeNull();
    // DOM 序：zoombar < legend < canvas（图例在工具栏下、画布外）。
    expect(zoombar!.compareDocumentPosition(legend!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(legend!.compareDocumentPosition(canvas!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // 图例不在 zoom 容器内。
    expect(legend!.closest('[data-structure-canvas]')).toBeNull();
  });
});
